// Checkpoint: a pre-action guard for AI agents, running on Cloudflare Workers.
//
//   GET  /                       landing page with self-serve signup
//   GET  /app                    dashboard (decisions, usage, policies, Telegram)
//   POST /v1/signup              { email } -> API key (shown once) + Telegram link
//   POST /v1/check               allow | block | ask (+ approval_id)
//   GET  /v1/approvals/:id       pending | approved | denied | expired
//   GET  /v1/me                  account, usage, Telegram status, effective policies
//   GET  /v1/decisions           recent decisions for this account
//   PUT  /v1/policies            save default policies (null resets to built-in defaults)
//   POST /v1/telegram/link       fresh t.me link to connect a chat
//   POST /v1/keys/rotate         revoke the calling key, return a new one
//   POST /telegram/webhook       Telegram updates (linking + Approve/Deny)
//   POST /telegram/setup         (re)register the webhook; called by CI after deploy
//   ALL  /mcp                    remote MCP server
//   GET  /health

import {
  CheckRequest,
  DEFAULT_POLICIES,
  DEFAULT_THRESHOLDS,
  FailMode,
  Policy,
  Thresholds,
  buildQuestions,
  buildState,
  decide,
  normalizePolicies,
} from "./decide";
import {
  FREE_MONTHLY_LIMIT,
  Principal,
  SIGNUPS_PER_IP_PER_DAY,
  accountKeyIds,
  authenticate,
  consumeQuota,
  monthlyUsage,
  newApiKey,
  sha256Hex,
} from "./auth";
import { handleTelegramWebhook, notifyApproval, setupWebhook, telegramLink } from "./telegram";
import { handleMcp } from "./mcp";
import { LANDING_HTML } from "./landing";
import { APP_HTML } from "./app";

export { authenticate };

export interface Env {
  AI: { run(model: string, input: unknown): Promise<unknown> };
  DB: D1Database;
  API_KEYS?: string; // secret: comma-separated owner keys
  DECISION_MODEL?: string; // default "@cf/cloudflare/clef"
  DECISION_URL?: string; // optional: any System One compatible endpoint (e.g. Celeris)
  DECISION_API_KEY?: string;
  FAIL_MODE?: string; // "closed" (default) | "open"
  APPROVAL_TTL_SECONDS?: string; // default 900
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string; // owner's chat
  TELEGRAM_WEBHOOK_SECRET?: string;
  TELEGRAM_API_BASE?: string;
}

const MAX_BODY_BYTES = 64_000;
const MAX_POLICIES = 20;
const MODEL_TIMEOUT_MS = 3_000;

const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "x-frame-options": "DENY",
};

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const p = url.pathname;
    const m = req.method;
    try {
      if (m === "GET" && p === "/health") return json({ ok: true });
      if (m === "GET" && p === "/") return html(LANDING_HTML);
      if (m === "GET" && p === "/app") return html(APP_HTML);
      if (m === "POST" && p === "/waitlist") return await handleWaitlist(req, env);
      if (m === "POST" && p === "/v1/signup") return await handleSignup(req, env, url.origin);
      if (m === "POST" && p === "/v1/check") return await handleCheck(req, env, ctx);
      const ap = p.match(/^\/v1\/approvals\/([A-Za-z0-9-]{8,64})$/);
      if (m === "GET" && ap) return await withAuth(req, env, (pr) => approvalResponse(env, pr, ap[1]));
      if (m === "GET" && p === "/v1/me") return await withAuth(req, env, (pr) => handleMe(env, pr));
      if (m === "GET" && p === "/v1/decisions") return await withAuth(req, env, (pr) => handleDecisions(env, pr, url));
      if (m === "PUT" && p === "/v1/policies") return await withAuth(req, env, (pr) => handlePolicies(req, env, pr));
      if (m === "POST" && p === "/v1/telegram/link") return await withAuth(req, env, (pr) => handleTelegramLink(env, pr));
      if (m === "POST" && p === "/v1/keys/rotate") return await withAuth(req, env, (pr) => handleRotate(env, pr));
      if (m === "POST" && p === "/telegram/webhook") return await handleTelegramWebhook(req, env);
      if (m === "POST" && p === "/telegram/setup") return json(await setupWebhook(env, url.origin));
      if (p === "/mcp") return await handleMcp(req, env, ctx);
      return json({ error: "not_found" }, 404);
    } catch (err) {
      console.error("unhandled", err);
      return json({ error: "internal_error" }, 500);
    }
  },
};

async function withAuth(req: Request, env: Env, fn: (p: Principal) => Promise<Response>): Promise<Response> {
  const pr = await authenticate(req, env);
  if (!pr) return json({ error: "unauthorized" }, 401);
  return fn(pr);
}

async function readJson(req: Request, max = MAX_BODY_BYTES): Promise<{ ok: true; body: any } | { ok: false; res: Response }> {
  const text = await req.text();
  if (text.length > max) return { ok: false, res: json({ error: "body_too_large" }, 413) };
  try {
    return { ok: true, body: JSON.parse(text) };
  } catch {
    return { ok: false, res: json({ error: "invalid_json" }, 400) };
  }
}

// ---------- signup ----------

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,63}$/;

async function handleSignup(req: Request, env: Env, origin: string): Promise<Response> {
  const r = await readJson(req, 2_000);
  if (!r.ok) return r.res;
  const b = r.body;
  if (typeof b?.website === "string" && b.website.trim()) return json({ error: "invalid_request" }, 400); // honeypot
  const email = typeof b?.email === "string" ? b.email.trim().toLowerCase() : "";
  if (email.length > 254 || !EMAIL_RE.test(email)) return json({ error: "invalid_email" }, 400);

  const ip = req.headers.get("cf-connecting-ip") ?? "";
  const ipHash = ip ? (await sha256Hex("ip:" + ip)).slice(0, 16) : null;
  if (ipHash) {
    const c = await env.DB.prepare(`SELECT COUNT(*) AS n FROM users WHERE ip_hash = ? AND created_at > ?`)
      .bind(ipHash, Date.now() - 86_400_000)
      .first<{ n: number }>();
    if ((c?.n ?? 0) >= SIGNUPS_PER_IP_PER_DAY) return json({ error: "too_many_signups", message: "Try again tomorrow." }, 429);
  }

  const exists = await env.DB.prepare(`SELECT id FROM users WHERE email = ?`).bind(email).first();
  if (exists)
    return json(
      { error: "email_taken", message: "This email already has an account. Use your existing key, or rotate it from the dashboard." },
      409,
    );

  const userId = crypto.randomUUID();
  const key = newApiKey();
  const hash = await sha256Hex(key);
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO users (id, email, monthly_limit, ip_hash, created_at) VALUES (?, ?, ?, ?, ?)`).bind(
      userId,
      email,
      FREE_MONTHLY_LIMIT,
      ipHash,
      now,
    ),
    env.DB.prepare(`INSERT INTO api_keys (hash, key_id, user_id, prefix, created_at) VALUES (?, ?, ?, ?, ?)`).bind(
      hash,
      hash.slice(0, 12),
      userId,
      key.slice(0, 12),
      now,
    ),
    env.DB.prepare(`INSERT INTO waitlist (email, ip_hash, created_at) VALUES (?, ?, ?) ON CONFLICT(email) DO NOTHING`).bind(
      email,
      ipHash,
      now,
    ),
  ]);
  const link = await telegramLink(env, userId);
  return json(
    {
      api_key: key,
      note: "This key is shown only once. Store it somewhere safe.",
      monthly_limit: FREE_MONTHLY_LIMIT,
      telegram_link: link,
      dashboard: `${origin}/app`,
      mcp_url: `${origin}/mcp`,
    },
    201,
  );
}

// Kept for older landing pages: records interest only.
async function handleWaitlist(req: Request, env: Env): Promise<Response> {
  const r = await readJson(req, 2_000);
  if (!r.ok) return r.res;
  const b = r.body;
  if (typeof b?.website === "string" && b.website.trim()) return json({ ok: true });
  const email = typeof b?.email === "string" ? b.email.trim().toLowerCase() : "";
  if (email.length > 254 || !EMAIL_RE.test(email)) return json({ error: "invalid_email" }, 400);
  const ip = req.headers.get("cf-connecting-ip") ?? "";
  const ipHash = ip ? (await sha256Hex("ip:" + ip)).slice(0, 16) : null;
  await env.DB.prepare(`INSERT INTO waitlist (email, ip_hash, created_at) VALUES (?, ?, ?) ON CONFLICT(email) DO NOTHING`)
    .bind(email, ipHash, Date.now())
    .run();
  return json({ ok: true });
}

// ---------- check ----------

async function handleCheck(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const pr = await authenticate(req, env);
  if (!pr) return json({ error: "unauthorized" }, 401);
  const r = await readJson(req);
  if (!r.ok) return r.res;
  const out = await runCheck(env, ctx, pr, r.body);
  return json(out.body, out.status);
}

export interface CheckOutcome {
  status: number;
  body: Record<string, unknown>;
}

// Shared by the REST API and the MCP endpoint.
export async function runCheck(env: Env, ctx: ExecutionContext, pr: Principal, body: CheckRequest): Promise<CheckOutcome> {
  const invalid = validate(body);
  if (invalid) return { status: 400, body: { error: invalid } };

  const quota = await consumeQuota(env, pr);
  if (!quota.ok)
    return {
      status: 429,
      body: {
        error: quota.error,
        message:
          quota.error === "rate_limited"
            ? "More than 60 checks in one minute. Slow down and retry."
            : `Monthly limit of ${quota.limit} checks reached.`,
      },
    };

  const rules = body.policies?.length ? body.policies : normalizePolicies(pr.policies ?? undefined);
  const t: Thresholds = { ...DEFAULT_THRESHOLDS, ...body.thresholds };
  if (!(t.ask <= t.block)) return { status: 400, body: { error: "thresholds.ask must be <= thresholds.block" } };
  const failMode: FailMode = env.FAIL_MODE === "open" ? "open" : "closed";
  const dryRun = body.dry_run === true;

  const started = Date.now();
  let raw: unknown = null;
  let modelError: string | null = null;
  try {
    raw = await callDecisionModel(env, buildState(body), buildQuestions(rules));
  } catch (err) {
    modelError = err instanceof Error ? err.message : String(err);
  }
  const result = decide(raw, rules, t, failMode, modelError);
  const latencyMs = Date.now() - started;

  const id = crypto.randomUUID();
  const needsApproval = result.decision === "ask" && !dryRun;
  const ttl = Number(env.APPROVAL_TTL_SECONDS) || 900;
  const approvalExpiresAt = needsApproval ? Date.now() + ttl * 1000 : undefined;

  // Persist before answering so a client can poll the approval immediately.
  await env.DB.prepare(
    `INSERT INTO decisions (id, key_id, agent_id, tool, action_json, decision, risk, reason, triggered_json,
       latency_ms, degraded, status, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      pr.keyId,
      body.agent_id ?? null,
      body.action.tool,
      JSON.stringify(body.action).slice(0, 20_000),
      result.decision,
      result.risk,
      result.reason,
      JSON.stringify(result.triggered),
      latencyMs,
      result.degraded ? 1 : 0,
      needsApproval ? "pending" : null,
      approvalExpiresAt ?? null,
      Date.now(),
    )
    .run();

  if (needsApproval) ctx.waitUntil(notifyApproval(env, pr.chatId, id, body, result));

  return {
    status: 200,
    body: {
      id,
      decision: result.decision,
      risk: result.risk,
      impact: result.impact,
      reason: result.reason,
      triggered: result.triggered,
      degraded: result.degraded ?? false,
      latency_ms: latencyMs,
      ...(dryRun ? { dry_run: true } : {}),
      ...(needsApproval
        ? { approval_id: id, approval_expires_at: approvalExpiresAt, approval_channel: pr.chatId ? "telegram" : "none" }
        : {}),
    },
  };
}

function validatePolicies(list: unknown): string | null {
  if (!Array.isArray(list)) return "policies must be an array";
  if (list.length > MAX_POLICIES) return `at most ${MAX_POLICIES} policies`;
  for (const p of list) {
    if (typeof p === "string") {
      if (!p.trim()) return "policies must not contain empty strings";
      if (p.length > 500) return "a policy must be at most 500 characters";
    } else if (p && typeof p === "object") {
      const o = p as Record<string, unknown>;
      if (typeof o.rule !== "string" || !o.rule.trim()) return "each policy object needs a non-empty 'rule'";
      if (o.action !== "block" && o.action !== "ask") return "policy 'action' must be 'block' or 'ask'";
      if (o.label !== undefined && (typeof o.label !== "string" || o.label.length > 80))
        return "policy 'label' must be a string of at most 80 characters";
      if (o.rule.length > 500) return "policy 'rule' must be at most 500 characters";
    } else {
      return "each policy must be a string or an object { rule, action, label? }";
    }
  }
  return null;
}

function validate(b: CheckRequest): string | null {
  if (!b || typeof b !== "object") return "body must be an object";
  if (!b.action || typeof b.action !== "object") return "action is required";
  if (typeof b.action.tool !== "string" || !b.action.tool.trim()) return "action.tool is required";
  if (b.policies !== undefined) {
    const e = validatePolicies(b.policies);
    if (e) return e;
  }
  if (b.thresholds !== undefined) {
    for (const k of ["block", "ask"] as const) {
      const v = b.thresholds[k];
      if (v !== undefined && (typeof v !== "number" || v < 0 || v > 1)) return `thresholds.${k} must be 0..1`;
    }
  }
  if (b.dry_run !== undefined && typeof b.dry_run !== "boolean") return "dry_run must be a boolean";
  return null;
}

async function callDecisionModel(env: Env, state: string, questions: Record<string, unknown>): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("decision_model_timeout")), MODEL_TIMEOUT_MS);
  });
  try {
    if (env.DECISION_URL) {
      const call = fetch(env.DECISION_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(env.DECISION_API_KEY ? { authorization: `Bearer ${env.DECISION_API_KEY}` } : {}),
        },
        body: JSON.stringify({ model: env.DECISION_MODEL, state, questions }),
      }).then(async (r) => {
        if (!r.ok) throw new Error(`decision_http_${r.status}`);
        return r.json();
      });
      return await Promise.race([call, timeout]);
    }
    const model = env.DECISION_MODEL || "@cf/cloudflare/clef";
    return await Promise.race([env.AI.run(model, { state, questions }), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ---------- approvals ----------

async function approvalResponse(env: Env, pr: Principal, id: string): Promise<Response> {
  const st = await getApprovalStatus(env, pr, id);
  return st ? json(st) : json({ error: "not_found" }, 404);
}

export async function getApprovalStatus(env: Env, pr: Principal, id: string): Promise<Record<string, unknown> | null> {
  const keyIds = await accountKeyIds(env, pr);
  if (!keyIds.length) return null;
  const row = await env.DB.prepare(
    `SELECT status, expires_at, resolved_by, resolved_at FROM decisions
      WHERE id = ? AND key_id IN (${keyIds.map(() => "?").join(",")})`,
  )
    .bind(id, ...keyIds)
    .first<{ status: string | null; expires_at: number | null; resolved_by: string | null; resolved_at: number | null }>();
  if (!row || row.status === null) return null;

  let status = row.status;
  if (status === "pending" && row.expires_at !== null && Date.now() > row.expires_at) {
    await env.DB.prepare(`UPDATE decisions SET status = 'expired' WHERE id = ? AND status = 'pending'`).bind(id).run();
    status = "expired";
  }
  return { id, status, resolved_by: row.resolved_by, resolved_at: row.resolved_at };
}

// ---------- account ----------

async function handleMe(env: Env, pr: Principal): Promise<Response> {
  const email = pr.owner
    ? null
    : (await env.DB.prepare(`SELECT email FROM users WHERE id = ?`).bind(pr.userId).first<{ email: string }>())?.email ?? null;
  return json({
    email,
    owner: pr.owner,
    telegram_linked: !!pr.chatId,
    used_this_month: await monthlyUsage(env, pr.userId),
    monthly_limit: pr.monthlyLimit,
    policies: pr.policies ?? DEFAULT_POLICIES,
    using_default_policies: !pr.policies,
  });
}

async function handleDecisions(env: Env, pr: Principal, url: URL): Promise<Response> {
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 50, 1), 200);
  const keyIds = await accountKeyIds(env, pr);
  if (!keyIds.length) return json({ decisions: [] });
  const r = await env.DB.prepare(
    `SELECT id, agent_id, tool, action_json, decision, risk, reason, latency_ms, degraded, status, resolved_by, created_at
       FROM decisions WHERE key_id IN (${keyIds.map(() => "?").join(",")})
      ORDER BY created_at DESC LIMIT ?`,
  )
    .bind(...keyIds, limit)
    .all<Record<string, unknown>>();
  const decisions = (r.results ?? []).map((d) => {
    let description: string | null = null;
    try {
      description = (JSON.parse(String(d.action_json)) as { description?: string }).description ?? null;
    } catch {
      /* ignore */
    }
    const { action_json, ...rest } = d;
    return { ...rest, description, degraded: !!d.degraded };
  });
  return json({ decisions });
}

async function handlePolicies(req: Request, env: Env, pr: Principal): Promise<Response> {
  const r = await readJson(req, 20_000);
  if (!r.ok) return r.res;
  const list = r.body?.policies;
  if (list !== null) {
    const e = validatePolicies(list);
    if (e) return json({ error: e }, 400);
    if (!(list as Policy[]).length) return json({ error: "policies must not be empty; send null to use defaults" }, 400);
  }
  await env.DB.prepare(
    `INSERT INTO settings (user_id, policies_json, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET policies_json = excluded.policies_json, updated_at = excluded.updated_at`,
  )
    .bind(pr.userId, list === null ? null : JSON.stringify(list), Date.now())
    .run();
  return json({ ok: true, using_default_policies: list === null });
}

async function handleTelegramLink(env: Env, pr: Principal): Promise<Response> {
  if (pr.owner) return json({ error: "owner_uses_configured_chat" }, 400);
  const link = await telegramLink(env, pr.userId);
  return link ? json({ telegram_link: link }) : json({ error: "telegram_not_configured" }, 503);
}

async function handleRotate(env: Env, pr: Principal): Promise<Response> {
  if (pr.owner) return json({ error: "owner_keys_are_managed_in_secrets" }, 400);
  const key = newApiKey();
  const hash = await sha256Hex(key);
  const now = Date.now();
  // Revoke the calling key (identified by its key_id) and add the new one atomically.
  await env.DB.batch([
    env.DB.prepare(`UPDATE api_keys SET revoked_at = ? WHERE user_id = ? AND key_id = ? AND revoked_at IS NULL`).bind(
      now,
      pr.userId,
      pr.keyId,
    ),
    env.DB.prepare(`INSERT INTO api_keys (hash, key_id, user_id, prefix, created_at) VALUES (?, ?, ?, ?, ?)`).bind(
      hash,
      hash.slice(0, 12),
      pr.userId,
      key.slice(0, 12),
      now,
    ),
  ]);
  return json({ api_key: key, note: "The old key no longer works. This key is shown only once." });
}

// ---------- helpers ----------

function html(body: string): Response {
  return new Response(body, {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache", ...SECURITY_HEADERS },
  });
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...SECURITY_HEADERS },
  });
}
