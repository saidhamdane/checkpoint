// Checkpoint: a pre-action guard for AI agents, running on Cloudflare Workers.
//
//   POST /v1/check            -> allow | block | ask (+ approval_id)
//   GET  /v1/approvals/:id    -> pending | approved | denied | expired
//   POST /telegram/webhook    -> Approve / Deny buttons from Telegram
//   GET  /health

import {
  CheckRequest,
  normalizePolicies,
  DEFAULT_THRESHOLDS,
  DecideResult,
  FailMode,
  Thresholds,
  buildQuestions,
  buildState,
  decide,
} from "./decide";
import { handleMcp } from "./mcp";
import { LANDING_HTML } from "./landing";

export interface Env {
  AI: { run(model: string, input: unknown): Promise<unknown> };
  DB: D1Database;
  API_KEYS: string; // secret: comma-separated keys
  DECISION_MODEL?: string; // default "@cf/cloudflare/clef"
  DECISION_URL?: string; // optional: any System One compatible endpoint (e.g. Celeris)
  DECISION_API_KEY?: string;
  FAIL_MODE?: string; // "closed" (default) | "open"
  APPROVAL_TTL_SECONDS?: string; // default 900
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
}

const MAX_BODY_BYTES = 64_000;
const MAX_POLICIES = 20;
const MODEL_TIMEOUT_MS = 3_000;

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    try {
      if (req.method === "GET" && url.pathname === "/health") return json({ ok: true });
      if (req.method === "GET" && url.pathname === "/")
        return new Response(LANDING_HTML, {
          headers: {
            "content-type": "text/html; charset=utf-8",
            "cache-control": "public, max-age=300",
            "x-content-type-options": "nosniff",
            "referrer-policy": "strict-origin-when-cross-origin",
          },
        });
      if (req.method === "POST" && url.pathname === "/waitlist") return await handleWaitlist(req, env);
      if (req.method === "POST" && url.pathname === "/v1/check") return await handleCheck(req, env, ctx);
      const m = url.pathname.match(/^\/v1\/approvals\/([A-Za-z0-9-]{8,64})$/);
      if (req.method === "GET" && m) return await handleApproval(req, env, m[1]);
      if (req.method === "POST" && url.pathname === "/telegram/webhook") return await handleTelegram(req, env);
      if (url.pathname === "/mcp") return await handleMcp(req, env, ctx);
      return json({ error: "not_found" }, 404);
    } catch (err) {
      console.error("unhandled", err);
      return json({ error: "internal_error" }, 500);
    }
  },
};

// ---------- /v1/check ----------

async function handleCheck(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const keyId = await authenticate(req, env);
  if (!keyId) return json({ error: "unauthorized" }, 401);

  const text = await req.text();
  if (text.length > MAX_BODY_BYTES) return json({ error: "body_too_large" }, 413);

  let body: CheckRequest;
  try {
    body = JSON.parse(text);
  } catch {
    return json({ error: "invalid_json" }, 400);
  }
  const out = await runCheck(env, ctx, keyId, body);
  return json(out.body, out.status);
}

export interface CheckOutcome {
  status: number;
  body: Record<string, unknown>;
}

// Shared by the REST API and the MCP endpoint.
export async function runCheck(env: Env, ctx: ExecutionContext, keyId: string, body: CheckRequest): Promise<CheckOutcome> {
  const invalid = validate(body);
  if (invalid) return { status: 400, body: { error: invalid } };

  const rules = normalizePolicies(body.policies);
  const t: Thresholds = { ...DEFAULT_THRESHOLDS, ...body.thresholds };
  if (!(t.ask <= t.block)) return { status: 400, body: { error: "thresholds.ask must be <= thresholds.block" } };
  const failMode: FailMode = env.FAIL_MODE === "open" ? "open" : "closed";

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
  let approvalId: string | undefined;
  let approvalExpiresAt: number | undefined;

  if (result.decision === "ask") {
    const ttl = Number(env.APPROVAL_TTL_SECONDS) || 900;
    approvalId = id;
    approvalExpiresAt = Date.now() + ttl * 1000;
  }

  // Persist before answering so a client can poll the approval immediately.
  await env.DB.prepare(
    `INSERT INTO decisions (id, key_id, agent_id, tool, action_json, decision, risk, reason, triggered_json,
       latency_ms, degraded, status, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      keyId,
      body.agent_id ?? null,
      body.action.tool,
      JSON.stringify(body.action).slice(0, 20_000),
      result.decision,
      result.risk,
      result.reason,
      JSON.stringify(result.triggered),
      latencyMs,
      result.degraded ? 1 : 0,
      result.decision === "ask" ? "pending" : null,
      approvalExpiresAt ?? null,
      Date.now(),
    )
    .run();

  if (approvalId) ctx.waitUntil(notifyTelegram(env, approvalId, body, result));

  return { status: 200, body: {
    id,
    decision: result.decision,
    risk: result.risk,
    impact: result.impact,
    reason: result.reason,
    triggered: result.triggered,
    degraded: result.degraded ?? false,
    latency_ms: latencyMs,
    ...(approvalId ? { approval_id: approvalId, approval_expires_at: approvalExpiresAt } : {}),
  } };
}

function validate(b: CheckRequest): string | null {
  if (!b || typeof b !== "object") return "body must be an object";
  if (!b.action || typeof b.action !== "object") return "action is required";
  if (typeof b.action.tool !== "string" || !b.action.tool.trim()) return "action.tool is required";
  if (b.policies !== undefined) {
    if (!Array.isArray(b.policies)) return "policies must be an array";
    for (const p of b.policies) {
      if (typeof p === "string") {
        if (!p.trim()) return "policies must not contain empty strings";
      } else if (p && typeof p === "object") {
        if (typeof p.rule !== "string" || !p.rule.trim()) return "each policy object needs a non-empty 'rule'";
        if (p.action !== "block" && p.action !== "ask") return "policy 'action' must be 'block' or 'ask'";
        if (p.label !== undefined && (typeof p.label !== "string" || p.label.length > 80))
          return "policy 'label' must be a string of at most 80 characters";
        if (p.rule.length > 500) return "policy 'rule' must be at most 500 characters";
      } else {
        return "each policy must be a string or an object { rule, action, label? }";
      }
    }
    if (b.policies.length > MAX_POLICIES) return `at most ${MAX_POLICIES} policies`;
  }
  if (b.thresholds !== undefined) {
    for (const k of ["block", "ask"] as const) {
      const v = b.thresholds[k];
      if (v !== undefined && (typeof v !== "number" || v < 0 || v > 1)) return `thresholds.${k} must be 0..1`;
    }
  }
  return null;
}

async function callDecisionModel(env: Env, state: string, questions: Record<string, unknown>): Promise<unknown> {
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error("decision_model_timeout")), MODEL_TIMEOUT_MS),
  );

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
    return Promise.race([call, timeout]);
  }

  const model = env.DECISION_MODEL || "@cf/cloudflare/clef";
  return Promise.race([env.AI.run(model, { state, questions }), timeout]);
}

// ---------- /waitlist ----------

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,63}$/;

async function handleWaitlist(req: Request, env: Env): Promise<Response> {
  const text = await req.text();
  if (text.length > 2_000) return json({ error: "body_too_large" }, 413);
  let b: any;
  try {
    b = JSON.parse(text);
  } catch {
    return json({ error: "invalid_json" }, 400);
  }
  // Honeypot: real visitors never fill the hidden "website" field. Pretend success for bots.
  if (typeof b?.website === "string" && b.website.trim()) return json({ ok: true });
  const email = typeof b?.email === "string" ? b.email.trim().toLowerCase() : "";
  if (email.length > 254 || !EMAIL_RE.test(email)) return json({ error: "invalid_email" }, 400);

  const ip = req.headers.get("cf-connecting-ip") ?? "";
  const ipHash = ip ? (await sha256Hex(ip)).slice(0, 16) : null;
  await env.DB.prepare(
    `INSERT INTO waitlist (email, ip_hash, created_at) VALUES (?, ?, ?) ON CONFLICT(email) DO NOTHING`,
  )
    .bind(email, ipHash, Date.now())
    .run();
  return json({ ok: true });
}

// ---------- /v1/approvals/:id ----------

async function handleApproval(req: Request, env: Env, id: string): Promise<Response> {
  const keyId = await authenticate(req, env);
  if (!keyId) return json({ error: "unauthorized" }, 401);
  const st = await getApprovalStatus(env, keyId, id);
  return st ? json(st) : json({ error: "not_found" }, 404);
}

export async function getApprovalStatus(env: Env, keyId: string, id: string): Promise<Record<string, unknown> | null> {
  const row = await env.DB.prepare(
    `SELECT status, expires_at, resolved_by, resolved_at FROM decisions WHERE id = ? AND key_id = ?`,
  )
    .bind(id, keyId)
    .first<{ status: string | null; expires_at: number | null; resolved_by: string | null; resolved_at: number | null }>();

  if (!row || row.status === null) return null;

  let status = row.status;
  if (status === "pending" && row.expires_at !== null && Date.now() > row.expires_at) {
    await env.DB.prepare(`UPDATE decisions SET status = 'expired' WHERE id = ? AND status = 'pending'`).bind(id).run();
    status = "expired";
  }
  return { id, status, resolved_by: row.resolved_by, resolved_at: row.resolved_at };
}

// ---------- Telegram ----------

async function notifyTelegram(env: Env, approvalId: string, body: CheckRequest, r: DecideResult): Promise<void> {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return;
  const hasInput =
    body.action.input !== undefined &&
    body.action.input !== null &&
    !(typeof body.action.input === "object" && Object.keys(body.action.input as object).length === 0);
  const input = hasInput ? JSON.stringify(body.action.input, null, 2).slice(0, 1500) : "";
  const text = [
    `🛑 <b>Checkpoint: approval needed</b>`,
    body.agent_id ? `Agent: <code>${esc(body.agent_id)}</code>` : null,
    `Tool: <code>${esc(body.action.tool)}</code>`,
    body.action.description ? `Action: ${esc(body.action.description)}` : null,
    `Risk: ${r.risk === null ? "unknown" : Math.round(r.risk * 100) + "%"}`,
    `Reason: ${esc(r.reason)}`,
    input ? `<pre>${esc(input)}</pre>` : null,
  ]
    .filter(Boolean)
    .join("\n");

  try {
    const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: env.TELEGRAM_CHAT_ID,
        text,
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [
              { text: "✅ Approve", callback_data: `ap:${approvalId}` },
              { text: "❌ Deny", callback_data: `dn:${approvalId}` },
            ],
          ],
        },
      }),
    });
    if (!res.ok) console.error("telegram sendMessage failed", res.status, await res.text());
  } catch (err) {
    console.error("telegram sendMessage error", err);
  }
}

async function handleTelegram(req: Request, env: Env): Promise<Response> {
  if (!env.TELEGRAM_WEBHOOK_SECRET || !env.TELEGRAM_BOT_TOKEN) return json({ error: "not_configured" }, 404);
  const secret = req.headers.get("x-telegram-bot-api-secret-token") ?? "";
  if (!(await safeEqual(secret, env.TELEGRAM_WEBHOOK_SECRET))) return json({ error: "unauthorized" }, 401);

  const update = (await req.json().catch(() => null)) as any;
  const cb = update?.callback_query;
  if (!cb?.data) return json({ ok: true });

  // Only the configured chat can approve or deny.
  if (String(cb.message?.chat?.id) !== String(env.TELEGRAM_CHAT_ID)) {
    await answerCallback(env, cb.id, "Not allowed");
    return json({ ok: true });
  }

  const [verb, id] = String(cb.data).split(":");
  const status = verb === "ap" ? "approved" : verb === "dn" ? "denied" : null;
  if (!status || !id) return json({ ok: true });

  const who = cb.from?.username ? `@${cb.from.username}` : `tg:${cb.from?.id}`;
  const res = await env.DB.prepare(
    `UPDATE decisions SET status = ?, resolved_by = ?, resolved_at = ?
     WHERE id = ? AND status = 'pending' AND (expires_at IS NULL OR expires_at > ?)`,
  )
    .bind(status, who, Date.now(), id, Date.now())
    .run();

  const changed = (res.meta?.changes ?? 0) > 0;
  await answerCallback(env, cb.id, changed ? (status === "approved" ? "Approved ✅" : "Denied ❌") : "Already resolved or expired");

  if (changed && cb.message) {
    await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/editMessageReplyMarkup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: cb.message.chat.id, message_id: cb.message.message_id, reply_markup: { inline_keyboard: [[{ text: status === "approved" ? `✅ Approved by ${who}` : `❌ Denied by ${who}`, callback_data: "noop" }]] } }),
    }).catch(() => {});
  }
  return json({ ok: true });
}

async function answerCallback(env: Env, callbackId: string, text: string): Promise<void> {
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ callback_query_id: callbackId, text }),
  }).catch(() => {});
}

// ---------- helpers ----------

// Returns a short, non-secret identifier of the key (first 12 hex chars of its SHA-256).
export async function authenticate(req: Request, env: Env): Promise<string | null> {
  const header = req.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token || !env.API_KEYS) return null;
  const keys = env.API_KEYS.split(",").map((k) => k.trim()).filter(Boolean);
  let ok = false;
  for (const k of keys) if (await safeEqual(token, k)) ok = true;
  if (!ok) return null;
  return (await sha256Hex(token)).slice(0, 12);
}

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Constant-time comparison via hashing both sides first.
async function safeEqual(a: string, b: string): Promise<boolean> {
  const [ha, hb] = await Promise.all([sha256Hex(a), sha256Hex(b)]);
  let diff = 0;
  for (let i = 0; i < ha.length; i++) diff |= ha.charCodeAt(i) ^ hb.charCodeAt(i);
  return diff === 0;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}
