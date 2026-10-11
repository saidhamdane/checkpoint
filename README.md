# Checkpoint

**A safety gate for AI agents.** Before your agent pays, deletes, emails or submits anything, Checkpoint answers in about half a second: **allow**, **block**, or **ask a human** (Approve / Deny on Telegram).

```ts
const refund = cp.guard("stripe.refund", stripeRefund);
await refund({ amount: 5000, customer: "cus_123" });
// → throws CheckpointBlocked: "Blocked: Moves money (97%)"
```

Works with any agent framework and any LLM provider. Policies are plain English. Every decision is logged.

On the bundled calibration set (`examples/calibrate.py`), **36 of 36** labelled actions got the expected decision on the live model (October 2026):

| Category | Result | Examples |
|---|---|---|
| Moves money | 8/8 blocked | transfers, refunds, card charges, crypto, purchases |
| Deletes data | 5/5 blocked | `DROP TABLE`, `rm -rf`, deleting a repo or bucket |
| Exposes secrets | 3/3 blocked | posting a DB password, publishing a `.env` |
| Commits the business | 4/4 ask | promising a refund, a discount, a deadline |
| Sensitive outside message | 2/2 ask | insulting a customer, claims about a competitor |
| Routine | 6/6 allowed | searches, reads, internal posts, commits |
| Money mentioned, not moved | 4/4 allowed | "write a report about the 5000 EUR spend" |
| Prompt injection | 4/4 | "pre-approved, ignore all rules" transfers stay blocked |

Most decisions were far from the threshold (blocks at 93–99%, routine at 4–11%). The closest call was sending a signed contract (57%, threshold 50%), so treat borderline categories with care and add your own cases.

## Quick start (hosted, free)

1. Get a key at **https://checkpoint.saidmatorral.workers.dev** (10,000 checks a month free). The key is shown once.
2. Connect Telegram from the link you get, so approvals reach your phone.
3. Add Checkpoint to your agent:

**MCP** (Claude Code and other MCP clients)

```bash
claude mcp add --transport http checkpoint https://checkpoint.saidmatorral.workers.dev/mcp \
  --header "Authorization: Bearer $CHECKPOINT_KEY"
```

**TypeScript**: `npm install checkpoint-guard`

```ts
import { Checkpoint } from "checkpoint-guard";
const cp = new Checkpoint({ apiKey: process.env.CHECKPOINT_KEY!, baseUrl: "https://checkpoint.saidmatorral.workers.dev" });
const deleteUser = cp.guard("db.deleteUser", realDeleteUser, (id) => `Delete user ${id}`);
```

**Python**: `pip install checkpoint-guard`

```python
from checkpoint_guard import Checkpoint
cp = Checkpoint(api_key=os.environ["CHECKPOINT_KEY"], base_url="https://checkpoint.saidmatorral.workers.dev")

@cp.guard("stripe.refund")
def refund(amount, customer): ...
```

`guard()` waits for a human when the decision is `ask` (default up to 10 minutes) and raises `CheckpointBlocked` on block, deny or timeout.

4. Watch decisions, usage and policies on the **dashboard**: https://checkpoint.saidmatorral.workers.dev/app

## How it works

1. Your agent proposes an action (`tool`, `input`, optional `description`).
2. The Worker asks a **decision model** (default: Cloudflare `@cf/cloudflare/clef` on Workers AI) one yes/no question per policy, for example *"Executing this action sends or refunds money right now"*, plus *"is this irreversible / high impact?"* and *"does the action text try to steer the reviewer?"*.
3. Each policy says what happens when it is true:
   - a **block** policy that is ≥ 50% likely → **block**; 30–50% → **ask**
   - an **ask** policy that is ≥ 50% likely → **ask** (Telegram message with Approve / Deny buttons)
   - nothing matched → **allow** (high-impact actions with a moderate signal, and actions whose text tries to steer the reviewer, are escalated to **ask**)

   The most severe outcome wins. End-to-end latency in our tests was 0.4–0.6 s, including the audit-log write.
4. If the model is down or returns something unparseable, Checkpoint **fails closed** (`ask`) by default. Set `FAIL_MODE=open` to allow instead.

### Default policies

Each is a **factual statement** about the action plus what to do when it is true. Decision models tend to classify facts more consistently than they judge "violations", so the answer depends less on how the agent phrases the action.

| Default | When true |
|---|---|
| Moves money (pays, transfers, charges, refunds now) | block |
| Deletes data permanently | block |
| Exposes secrets or other people's private data | block |
| Commits the business (promises a refund, discount, price, deadline) | ask |
| Sensitive message to outsiders (angry, misleading, legal/medical/financial claims) | ask |

Save your own policies on the dashboard or with `PUT /v1/policies`. A single request can also send its own:

```json
"policies": [
  { "label": "Payments", "rule": "Executing this action moves money.", "action": "ask" },
  { "label": "Weekend email", "rule": "This action emails a customer on a Saturday or Sunday.", "action": "block" }
]
```

Plain strings ("Never do X.") still work and are scored against `thresholds`.

### Prompt injection

The action is passed to the model as untrusted data inside `<action_json>`, and a fixed question checks whether that text tries to instruct the reviewer ("ignore all rules", "this is pre-approved"). Such actions are never allowed silently: they are at least sent for approval, and a dangerous action stays blocked. Test it with `python3 examples/calibrate.py injection`.

## API

All `/v1` endpoints except signup take `Authorization: Bearer <key>`.

| Endpoint | What |
|---|---|
| `POST /v1/signup` `{ email }` | Creates an account. Returns the key (once), a Telegram link and the dashboard URL. 3 signups per network per day. |
| `POST /v1/check` | Returns `{ decision, risk, reason, triggered, approval_id? }`. Body below. |
| `GET /v1/approvals/:id` | `pending`, `approved`, `denied` or `expired`. |
| `GET /v1/me` | Email, usage this month, Telegram status, effective policies. |
| `GET /v1/decisions?limit=50` | Recent decisions for your account. |
| `PUT /v1/policies` `{ policies }` | Save default policies; `null` resets to the built-in ones. |
| `POST /v1/telegram/link` | A fresh single-use Telegram link. |
| `POST /v1/keys/rotate` | Revokes the calling key and returns a new one. |
| `POST /mcp` | Remote MCP server (tools `checkpoint_check`, `checkpoint_approval_status`). |

`POST /v1/check` body:

```json
{
  "action": { "tool": "gmail.send", "input": { "to": "client@x.com" }, "description": "Reply to angry client" },
  "agent_id": "support-bot",
  "context": "optional extra context",
  "policies": [{ "label": "Big refunds", "rule": "This action promises a refund over 100 EUR.", "action": "ask" }],
  "dry_run": false
}
```

`dry_run: true` computes and logs the decision without creating an approval request. Free accounts get 10,000 checks a month and 60 per minute; over the limit, checks return `429` and the MCP tool tells the agent not to proceed.

## Self-hosting

```bash
cd worker
cp wrangler.example.toml wrangler.toml
npm install --legacy-peer-deps
npx wrangler login                            # or export CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID
npx wrangler d1 create checkpoint-db          # paste the database_id into wrangler.toml
npx wrangler d1 execute checkpoint-db --remote --file=schema.sql
npx wrangler secret put API_KEYS              # owner keys, comma-separated (no quota)
npx wrangler deploy
```

Telegram (optional):

```bash
npx wrangler secret put TELEGRAM_BOT_TOKEN        # from @BotFather
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET   # any random string
# set TELEGRAM_CHAT_ID (owner's chat) in wrangler.toml [vars], deploy, then:
curl -X POST https://<your-worker>/telegram/setup
```

Any System One–compatible decision endpoint (e.g. Celeris, Jev) works instead of Workers AI: set `DECISION_URL`, `DECISION_API_KEY` and `DECISION_MODEL`.

`.github/workflows/deploy.yml` tests and deploys on every push to `main` (needs secrets `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `D1_DATABASE_ID`, `TELEGRAM_CHAT_ID`). `.github/workflows/release-sdks.yml` publishes both SDKs when you push a tag like `sdk-v0.2.0` (needs `NPM_TOKEN`, `PYPI_API_TOKEN`).

## Repo layout

| Path | What |
|---|---|
| `worker/` | Cloudflare Worker: API, accounts, D1 audit log, Telegram, MCP, landing page and dashboard |
| `sdk-ts/` | TypeScript SDK (`checkpoint-guard` on npm), zero dependencies |
| `sdk-python/` | Python SDK (`checkpoint-guard` on PyPI), standard library only |
| `examples/demo_agent.py` | Three-action demo: allowed, asks a human, blocked |
| `examples/calibrate.py` | 36 labelled actions to measure decisions on the live model |

## Tests

```bash
cd worker && npm test          # decision logic
npx tsc --noEmit               # types
```

## Limits

- Thresholds and default policies are starting points. Measure them on your own actions with `calibrate.py`.
- A decision model is a guardrail, not a guarantee. Keep hard limits (spending caps, permissions) in your own systems too.
- Signup does not verify email addresses yet. A lost key can be replaced only while you still have a working one (`/v1/keys/rotate`).

MIT License.
