// Telegram: approval messages, per-user chat linking, Approve/Deny callbacks.
//
// Linking: a user gets https://t.me/<bot>?start=<token>. Telegram then sends "/start <token>"
// to the webhook from that user's chat, and we store the chat id on their account.

import type { CheckRequest, DecideResult } from "./decide";
import { chatForKeyId, randomHex, safeEqual } from "./auth";

export interface TgEnv {
  DB: D1Database;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
  TELEGRAM_CHAT_ID?: string;
  TELEGRAM_API_BASE?: string; // default https://api.telegram.org (override for tests)
}

let cachedBotUsername: string | null = null;

async function tg(env: TgEnv, method: string, body: unknown): Promise<Response | null> {
  if (!env.TELEGRAM_BOT_TOKEN) return null;
  try {
    const base = env.TELEGRAM_API_BASE || "https://api.telegram.org";
    return await fetch(`${base}/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (err) {
    console.error(`telegram ${method} error`, err);
    return null;
  }
}

export async function botUsername(env: TgEnv): Promise<string | null> {
  if (cachedBotUsername) return cachedBotUsername;
  const r = await tg(env, "getMe", {});
  if (!r?.ok) return null;
  const j = (await r.json().catch(() => null)) as any;
  cachedBotUsername = j?.result?.username ?? null;
  return cachedBotUsername;
}

// Creates a fresh single-use link token for a user and returns the t.me link.
export async function telegramLink(env: TgEnv, userId: string): Promise<string | null> {
  const name = await botUsername(env);
  if (!name) return null;
  const token = randomHex(16);
  await env.DB.prepare(`UPDATE users SET telegram_link_token = ? WHERE id = ?`).bind(token, userId).run();
  return `https://t.me/${name}?start=${token}`;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export async function notifyApproval(
  env: TgEnv,
  chatId: string | null,
  approvalId: string,
  body: CheckRequest,
  r: DecideResult,
): Promise<void> {
  if (!chatId) return;
  const inp = body.action.input;
  const hasInput = inp !== undefined && inp !== null && !(typeof inp === "object" && Object.keys(inp as object).length === 0);
  const input = hasInput ? JSON.stringify(inp, null, 2).slice(0, 1500) : "";
  const text = [
    `🛑 <b>Checkpoint: approval needed</b>`,
    body.agent_id ? `Agent: <code>${esc(body.agent_id)}</code>` : null,
    `Tool: <code>${esc(body.action.tool)}</code>`,
    body.action.description ? `Action: ${esc(body.action.description)}` : null,
    `Reason: ${esc(r.reason)}`,
    input ? `<pre>${esc(input)}</pre>` : null,
  ]
    .filter(Boolean)
    .join("\n");
  const res = await tg(env, "sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [[
        { text: "✅ Approve", callback_data: `ap:${approvalId}` },
        { text: "❌ Deny", callback_data: `dn:${approvalId}` },
      ]],
    },
  });
  if (res && !res.ok) console.error("telegram sendMessage failed", res.status, await res.text());
}

// Registers this Worker as the bot's webhook. Idempotent; safe to call after every deploy.
export async function setupWebhook(env: TgEnv, origin: string): Promise<{ ok: boolean; description?: string }> {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_WEBHOOK_SECRET) return { ok: false, description: "not_configured" };
  const r = await tg(env, "setWebhook", {
    url: `${origin}/telegram/webhook`,
    secret_token: env.TELEGRAM_WEBHOOK_SECRET,
    allowed_updates: ["callback_query", "message"],
  });
  const j = (await r?.json().catch(() => null)) as any;
  return { ok: !!j?.ok, description: j?.description };
}

export async function handleTelegramWebhook(req: Request, env: TgEnv): Promise<Response> {
  const ok = () => new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } });
  if (!env.TELEGRAM_WEBHOOK_SECRET || !env.TELEGRAM_BOT_TOKEN) return new Response("not configured", { status: 404 });
  const secret = req.headers.get("x-telegram-bot-api-secret-token") ?? "";
  if (!(await safeEqual(secret, env.TELEGRAM_WEBHOOK_SECRET))) return new Response("unauthorized", { status: 401 });

  const update = (await req.json().catch(() => null)) as any;

  // /start <token>: link this chat to an account.
  const msg = update?.message;
  if (msg?.text && typeof msg.text === "string" && msg.chat?.id !== undefined) {
    const m = msg.text.trim().match(/^\/start(?:@\w+)?(?:\s+([a-f0-9]{32}))?$/);
    if (m) {
      const chatId = String(msg.chat.id);
      if (m[1]) {
        const res = await env.DB.prepare(
          `UPDATE users SET telegram_chat_id = ?, telegram_link_token = NULL WHERE telegram_link_token = ?`,
        )
          .bind(chatId, m[1])
          .run();
        const linked = (res.meta?.changes ?? 0) > 0;
        await tg(env, "sendMessage", {
          chat_id: chatId,
          text: linked
            ? "✅ Linked. Approval requests from your Checkpoint agents will arrive here."
            : "This link has expired or was already used. Create a new one from your Checkpoint dashboard.",
        });
      } else {
        await tg(env, "sendMessage", {
          chat_id: chatId,
          text: "Hi! To receive approval requests, open the Telegram link from your Checkpoint dashboard.",
        });
      }
    }
    return ok();
  }

  // Approve / Deny buttons.
  const cb = update?.callback_query;
  if (!cb?.data) return ok();
  const [verb, id] = String(cb.data).split(":");
  const status = verb === "ap" ? "approved" : verb === "dn" ? "denied" : null;
  if (!status || !id || !/^[A-Za-z0-9-]{8,64}$/.test(id)) return ok();

  const d = await env.DB.prepare(`SELECT key_id FROM decisions WHERE id = ?`).bind(id).first<{ key_id: string }>();
  const allowedChat = d ? await chatForKeyId(env, d.key_id) : null;
  if (!d || !allowedChat || String(cb.message?.chat?.id) !== String(allowedChat)) {
    await tg(env, "answerCallbackQuery", { callback_query_id: cb.id, text: "Not allowed" });
    return ok();
  }

  const who = cb.from?.username ? `@${cb.from.username}` : `tg:${cb.from?.id}`;
  const res = await env.DB.prepare(
    `UPDATE decisions SET status = ?, resolved_by = ?, resolved_at = ?
     WHERE id = ? AND status = 'pending' AND (expires_at IS NULL OR expires_at > ?)`,
  )
    .bind(status, who, Date.now(), id, Date.now())
    .run();
  const changed = (res.meta?.changes ?? 0) > 0;
  await tg(env, "answerCallbackQuery", {
    callback_query_id: cb.id,
    text: changed ? (status === "approved" ? "Approved ✅" : "Denied ❌") : "Already resolved or expired",
  });
  if (changed && cb.message) {
    await tg(env, "editMessageReplyMarkup", {
      chat_id: cb.message.chat.id,
      message_id: cb.message.message_id,
      reply_markup: {
        inline_keyboard: [[{ text: status === "approved" ? `✅ Approved by ${who}` : `❌ Denied by ${who}`, callback_data: "noop" }]],
      },
    });
  }
  return ok();
}
