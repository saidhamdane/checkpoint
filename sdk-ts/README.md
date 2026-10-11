# checkpoint-guard

TypeScript client for [Checkpoint](https://github.com/saidhamdane/checkpoint), a safety gate for AI agents.
Before your agent pays, deletes or emails anyone, Checkpoint answers **allow**, **block** or **ask a human** (Telegram).

```bash
npm install checkpoint-guard
```

```ts
import { Checkpoint, CheckpointBlocked } from "checkpoint-guard";

const cp = new Checkpoint({
  apiKey: process.env.CHECKPOINT_KEY!,               // free key: https://checkpoint.saidmatorral.workers.dev
  baseUrl: "https://checkpoint.saidmatorral.workers.dev",
  agentId: "support-bot",
});

// Wrap any async function. Every call is checked first.
const refund = cp.guard("stripe.refund", stripeRefund, (a) => `Refund ${a.amount} EUR to ${a.customer}`);

try {
  await refund({ amount: 900, customer: "cus_123" });
} catch (e) {
  if (e instanceof CheckpointBlocked) console.log(e.message); // "Blocked: Moves money (97%)"
}
```

- `allow` runs the function.
- `block` throws `CheckpointBlocked`.
- `ask` waits for Approve/Deny on Telegram (up to 10 minutes by default), then runs or throws.

Use `cp.check({ tool, description, input, dryRun: true })` to see the decision without running anything or sending an approval request.

Zero dependencies. Node 18+, Bun, Deno and Cloudflare Workers. MIT license.
