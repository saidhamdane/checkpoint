// Accounts, API keys and quotas.
//
// Two kinds of caller:
//  - Owner keys from the API_KEYS secret (the original single-tenant setup). No quota,
//    approvals go to TELEGRAM_CHAT_ID.
//  - Self-serve users created with POST /v1/signup. Each key is stored only as a SHA-256 hash,
//    approvals go to the Telegram chat the user linked, usage is limited per minute and per month.

import type { Policy } from "./decide";

export interface AuthEnv {
  DB: D1Database;
  API_KEYS?: string;
  TELEGRAM_CHAT_ID?: string;
}

export interface Principal {
  keyId: string; // first 12 hex chars of sha256(key); stored on every decision
  userId: string;
  owner: boolean;
  chatId: string | null;
  policies: Policy[] | null; // saved policies, null = defaults
  monthlyLimit: number | null; // null = unlimited
}

export const FREE_MONTHLY_LIMIT = 10_000;
export const PER_MINUTE_LIMIT = 60;
export const SIGNUPS_PER_IP_PER_DAY = 3;

export async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Constant-time comparison via hashing both sides first.
export async function safeEqual(a: string, b: string): Promise<boolean> {
  const [ha, hb] = await Promise.all([sha256Hex(a), sha256Hex(b)]);
  let diff = 0;
  for (let i = 0; i < ha.length; i++) diff |= ha.charCodeAt(i) ^ hb.charCodeAt(i);
  return diff === 0;
}

export function randomHex(bytes: number): string {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return [...a].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function newApiKey(): string {
  return `ck_live_${randomHex(20)}`;
}

function bearer(req: Request): string {
  const header = req.headers.get("authorization") ?? "";
  return header.startsWith("Bearer ") ? header.slice(7).trim() : "";
}

function parsePolicies(json: string | null | undefined): Policy[] | null {
  if (!json) return null;
  try {
    const p = JSON.parse(json);
    return Array.isArray(p) && p.length ? p : null;
  } catch {
    return null;
  }
}

export async function authenticate(req: Request, env: AuthEnv): Promise<Principal | null> {
  const token = bearer(req);
  if (!token || token.length > 200) return null;
  const hash = await sha256Hex(token);
  const keyId = hash.slice(0, 12);

  // 1) Owner keys from the secret.
  if (env.API_KEYS) {
    const keys = env.API_KEYS.split(",").map((k) => k.trim()).filter(Boolean);
    let ok = false;
    for (const k of keys) if (await safeEqual(token, k)) ok = true;
    if (ok) {
      const userId = `owner:${keyId}`;
      const s = await env.DB.prepare(`SELECT policies_json FROM settings WHERE user_id = ?`)
        .bind(userId)
        .first<{ policies_json: string | null }>();
      return {
        keyId,
        userId,
        owner: true,
        chatId: env.TELEGRAM_CHAT_ID || null,
        policies: parsePolicies(s?.policies_json),
        monthlyLimit: null,
      };
    }
  }

  // 2) Self-serve keys (looked up by full hash, never stored in clear).
  const row = await env.DB.prepare(
    `SELECT u.id AS user_id, u.telegram_chat_id, u.monthly_limit, s.policies_json
       FROM api_keys k JOIN users u ON u.id = k.user_id
       LEFT JOIN settings s ON s.user_id = u.id
      WHERE k.hash = ? AND k.revoked_at IS NULL`,
  )
    .bind(hash)
    .first<{ user_id: string; telegram_chat_id: string | null; monthly_limit: number | null; policies_json: string | null }>();
  if (!row) return null;
  return {
    keyId,
    userId: row.user_id,
    owner: false,
    chatId: row.telegram_chat_id,
    policies: parsePolicies(row.policies_json),
    monthlyLimit: row.monthly_limit ?? FREE_MONTHLY_LIMIT,
  };
}

function monthPeriod(now = new Date()): string {
  return now.toISOString().slice(0, 7); // YYYY-MM
}

function minutePeriod(now = new Date()): string {
  return "m:" + now.toISOString().slice(0, 16); // m:YYYY-MM-DDTHH:MM
}

export interface QuotaResult {
  ok: boolean;
  error?: "rate_limited" | "monthly_quota_exceeded";
  used_this_month?: number;
  limit?: number | null;
}

// Counts one decision. Owners are counted but never limited.
export async function consumeQuota(env: AuthEnv, p: Principal): Promise<QuotaResult> {
  const now = new Date();
  const upsert = `INSERT INTO usage (user_id, period, count) VALUES (?, ?, 1)
                  ON CONFLICT(user_id, period) DO UPDATE SET count = count + 1
                  RETURNING count`;
  const [minute, month] = await env.DB.batch<{ count: number }>([
    env.DB.prepare(upsert).bind(p.userId, minutePeriod(now)),
    env.DB.prepare(upsert).bind(p.userId, monthPeriod(now)),
  ]);
  const perMinute = minute.results?.[0]?.count ?? 0;
  const used = month.results?.[0]?.count ?? 0;

  // Occasionally drop old per-minute rows.
  if (Math.random() < 0.01) {
    const cutoff = "m:" + new Date(now.getTime() - 3600_000).toISOString().slice(0, 16);
    await env.DB.prepare(`DELETE FROM usage WHERE period LIKE 'm:%' AND period < ?`).bind(cutoff).run();
  }

  if (p.owner) return { ok: true, used_this_month: used, limit: null };
  if (perMinute > PER_MINUTE_LIMIT) return { ok: false, error: "rate_limited", used_this_month: used, limit: p.monthlyLimit };
  if (p.monthlyLimit !== null && used > p.monthlyLimit)
    return { ok: false, error: "monthly_quota_exceeded", used_this_month: used, limit: p.monthlyLimit };
  return { ok: true, used_this_month: used, limit: p.monthlyLimit };
}

export async function monthlyUsage(env: AuthEnv, userId: string): Promise<number> {
  const r = await env.DB.prepare(`SELECT count FROM usage WHERE user_id = ? AND period = ?`)
    .bind(userId, monthPeriod())
    .first<{ count: number }>();
  return r?.count ?? 0;
}

// All key ids that belong to a principal's account (for listing decisions).
export async function accountKeyIds(env: AuthEnv, p: Principal): Promise<string[]> {
  if (p.owner) return [p.keyId];
  const r = await env.DB.prepare(`SELECT key_id FROM api_keys WHERE user_id = ?`).bind(p.userId).all<{ key_id: string }>();
  return (r.results ?? []).map((x) => x.key_id);
}

// The Telegram chat that may approve decisions made with this key id.
export async function chatForKeyId(env: AuthEnv, keyId: string): Promise<string | null> {
  const r = await env.DB.prepare(
    `SELECT u.telegram_chat_id FROM api_keys k JOIN users u ON u.id = k.user_id WHERE k.key_id = ?`,
  )
    .bind(keyId)
    .first<{ telegram_chat_id: string | null }>();
  if (r) return r.telegram_chat_id;
  return env.TELEGRAM_CHAT_ID || null; // owner keys are not in api_keys
}
