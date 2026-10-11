# Checkpoint

**A pre-action guard for AI agents.** Before your agent pays, deletes, emails or submits anything, Checkpoint answers in about half a second: **allow**, **block**, or **ask a human** (approve/deny from Telegram).

```ts
const refund = cp.guard("stripe.refund", stripeRefund);
await refund({ amount: 5000, customer: "cus_123" });
// → throws CheckpointBlocked: "Blocked: Moves money (97%)"
```

Works with any agent framework and any LLM provider. Policies are plain English. Every decision is logged.

On the bundled calibration set (`examples/calibrate.py`), 13 of 13 test actions got the expected decision on the live model: transfers, charges, refunds and destructive queries blocked; refund and discount promises sent for approval; routine reads and searches allowed.

## How it works

1. Your agent proposes an action (`tool`, `input`, optional `description`).
2. The Worker asks a **decision model** (default: Cloudflare `@cf/cloudflare/clef` on Workers AI) one yes/no question per policy, for example *"Executing this action sends or refunds money right now"*, plus *"is this irreversible / high impact?"*.
3. Each policy says what happens when it is true:
   - a **block** policy that is ≥ 50% likely → **block**; 30–50% → **ask**
   - an **ask** policy that is ≥ 50% likely → **ask** (Telegram message with Approve / Deny buttons)
   - nothing matched → **allow** (high-impact actions with a moderate signal are escalated to **ask**)
   
   The most severe outcome wins. End-to-end latency in our tests was 0.4–0.6 s, including the audit-log write.
4. If the model is down or returns something unparseable, Checkpoint **fails closed** (`ask`) by default. Set `FAIL_MODE=open` to allow instead.

## Repo layout

| Path | What |
|---|---|
| `worker/` | Cloudflare Worker (API, D1 audit log, Telegram approvals) |
| `sdk-ts/` | TypeScript SDK, zero dependencies |
| `sdk-python/` | Python SDK, standard library only |
| `examples/demo_agent.py` | Three-action demo: allowed, asks a human, blocked |

## Deploy (≈10 minutes)

```bash
cd worker
cp wrangler.example.toml wrangler.toml
npm install --legacy-peer-deps
npx wrangler login                            # or export CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID
npx wrangler d1 create checkpoint-db          # paste the database_id into wrangler.toml
npm run db:init
npx wrangler secret put API_KEYS              # e.g. ck_live_<random>, comma-separate several
npx wrangler deploy
```

Smoke test:

```bash
curl -s https://checkpoint.<you>.workers.dev/v1/check \
  -H "authorization: Bearer $KEY" -H "content-type: application/json" \
  -d '{"action":{"tool":"bank.transfer","description":"Send 5000 EUR to a new IBAN"}}'
```

### Telegram approvals (optional)

```bash
npx wrangler secret put TELEGRAM_BOT_TOKEN        # from @BotFather
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET   # any random string
# set TELEGRAM_CHAT_ID in wrangler.toml [vars], then redeploy
curl "https://api.telegram.org/bot$TOKEN/setWebhook?url=https://checkpoint.<you>.workers.dev/telegram/webhook&secret_token=$SECRET&allowed_updates=%5B%22callback_query%22%5D"
```

Only the configured chat can approve. Approvals expire after `APPROVAL_TTL_SECONDS` (default 900).

### Another decision provider

Any System One–compatible endpoint (e.g. Celeris, Jev) works: set `DECISION_URL`, `DECISION_API_KEY` and `DECISION_MODEL`.

## API

### `POST /v1/check`

```json
{
  "action": { "tool": "gmail.send", "input": { "to": "client@x.com" }, "description": "Reply to angry client" },
  "agent_id": "support-bot",
  "context": "optional extra context",
  "policies": [{ "label": "Big refunds", "rule": "This action promises a refund over 100 EUR.", "action": "ask" }],
  "thresholds": { "block": 0.85, "ask": 0.5 }
}
```

Response: `{ id, decision, risk, impact, reason, triggered[], degraded, latency_ms, approval_id?, approval_expires_at? }`

If `policies` is omitted, five defaults apply. Each is a **factual statement** about the action plus what to do when it is true. Decision models tend to classify facts more consistently than they judge "violations", so the answer depends less on how the agent phrases the action.

| Default | When true |
|---|---|
| Moves money (pays, transfers, charges, refunds now) | block |
| Deletes data permanently | block |
| Exposes secrets or other people's private data | block |
| Commits the business (promises a refund, discount, price, deadline) | ask |
| Sensitive message to outsiders (angry, misleading, legal/medical/financial claims) | ask |

A block policy that is only 30–50% likely asks a human instead of passing. Custom policies use the same shape:

```json
"policies": [
  { "label": "Payments", "rule": "Executing this action moves money.", "action": "ask" },
  { "label": "Weekend email", "rule": "This action emails a customer on a Saturday or Sunday.", "action": "block" }
]
```

Plain strings ("Never do X.") still work and are scored against `thresholds`.

Check how the defaults behave on your own phrasings with `python3 examples/calibrate.py`.

### `GET /v1/approvals/:id`

`{ id, status: "pending" | "approved" | "denied" | "expired", resolved_by, resolved_at }`

## MCP server

The Worker also serves a remote MCP endpoint at `/mcp` (Streamable HTTP, same Bearer key). Tools: `checkpoint_check` and `checkpoint_approval_status`.

```bash
# Claude Code
claude mcp add --transport http checkpoint https://checkpoint.<you>.workers.dev/mcp \
  --header "Authorization: Bearer $CHECKPOINT_KEY"
```

Any MCP client that supports HTTP transport with custom headers works the same way.

## SDKs

**TypeScript**

```ts
import { Checkpoint, CheckpointBlocked } from "@checkpoint-ai/sdk";
const cp = new Checkpoint({ apiKey: process.env.CHECKPOINT_KEY!, baseUrl: "https://checkpoint.<you>.workers.dev", agentId: "ops-bot" });
const deleteUser = cp.guard("db.deleteUser", realDeleteUser, (id) => `Delete user ${id}`);
```

**Python**

```python
from checkpoint_guard import Checkpoint, CheckpointBlocked
cp = Checkpoint(api_key=os.environ["CHECKPOINT_KEY"], base_url="https://checkpoint.<you>.workers.dev")

@cp.guard("stripe.refund")
def refund(amount, customer): ...
```

`guard()` waits for a human when the decision is `ask` (default up to 10 min) and raises `CheckpointBlocked` on block, deny or timeout.

## Landing page and waitlist

`GET /` serves a self-contained landing page with a live-results demo and an email form. Emails go to the `waitlist` table in D1 (a hidden honeypot field filters simple bots). Export them with:

```bash
npx wrangler d1 execute checkpoint-db --remote --command "SELECT email, datetime(created_at/1000,'unixepoch') FROM waitlist ORDER BY created_at DESC"
```

## Demo

```bash
export CHECKPOINT_KEY=ck_live_...  CHECKPOINT_URL=https://checkpoint.<you>.workers.dev
python3 examples/demo_agent.py
```

## Tests

```bash
cd worker && npm test        # decision logic
npx tsc --noEmit             # types
```

## Limits (v0.1)

- Thresholds are starting points; tune them on your own traffic.
- A decision model is a guardrail, not a guarantee. Keep hard limits (spending caps, permissions) in your own systems too.
- Not yet: dashboard, per-key policies stored server-side, rate limiting per key and on the waitlist form.

MIT License.
