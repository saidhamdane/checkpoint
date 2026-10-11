// Checkpoint TypeScript SDK — zero dependencies, works in Node 18+, Bun, Deno and Workers.
//
//   const cp = new Checkpoint({ apiKey: process.env.CHECKPOINT_KEY!, baseUrl: "https://checkpoint.you.workers.dev" });
//   const pay = cp.guard("stripe.refund", refund);           // wraps any async function
//   await pay({ amount: 80, customer: "cus_123" });           // throws CheckpointBlocked if denied

export type Decision = "allow" | "block" | "ask";

export interface CheckResult {
  id: string;
  decision: Decision;
  risk: number | null;
  impact: number | null;
  reason: string;
  triggered: { rule: string; probability: number }[];
  degraded: boolean;
  latency_ms: number;
  approval_id?: string;
  approval_expires_at?: number;
}

export interface CheckInput {
  tool: string;
  input?: unknown;
  description?: string;
  context?: string;
}

export interface CheckpointOptions {
  apiKey: string;
  baseUrl: string;
  agentId?: string;
  policies?: string[];
  thresholds?: { block?: number; ask?: number };
  /** How long guard() waits for a human approval before giving up. Default 10 min. */
  approvalTimeoutMs?: number;
  /** Poll interval while waiting for approval. Default 3 s. */
  pollIntervalMs?: number;
  /** What to do if Checkpoint itself is unreachable. Default "closed" (throw). */
  onUnreachable?: "open" | "closed";
  fetch?: typeof fetch;
}

export class CheckpointBlocked extends Error {
  readonly result: CheckResult | null;
  constructor(result: CheckResult | null, reason: string) {
    super(`Checkpoint blocked action: ${reason}`);
    this.name = "CheckpointBlocked";
    this.result = result;
  }
}

export class Checkpoint {
  private readonly base: string;
  private readonly f: typeof fetch;
  private readonly opts: CheckpointOptions;

  constructor(opts: CheckpointOptions) {
    this.opts = opts;
    if (!opts.apiKey) throw new Error("Checkpoint: apiKey is required");
    if (!opts.baseUrl) throw new Error("Checkpoint: baseUrl is required");
    this.base = opts.baseUrl.replace(/\/+$/, "");
    this.f = opts.fetch ?? fetch.bind(globalThis);
  }

  /** Ask Checkpoint about one action. Does not wait for human approval. */
  async check(action: CheckInput): Promise<CheckResult> {
    const res = await this.f(`${this.base}/v1/check`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.opts.apiKey}` },
      body: JSON.stringify({
        action: { tool: action.tool, input: action.input, description: action.description },
        context: action.context,
        agent_id: this.opts.agentId,
        policies: this.opts.policies,
        thresholds: this.opts.thresholds,
      }),
    });
    if (!res.ok) throw new Error(`Checkpoint HTTP ${res.status}: ${await res.text()}`);
    return (await res.json()) as CheckResult;
  }

  /** Wait until a human approves or denies. Resolves true only on "approved". */
  async waitForApproval(approvalId: string): Promise<boolean> {
    const deadline = Date.now() + (this.opts.approvalTimeoutMs ?? 600_000);
    const every = this.opts.pollIntervalMs ?? 3_000;
    while (Date.now() < deadline) {
      const res = await this.f(`${this.base}/v1/approvals/${encodeURIComponent(approvalId)}`, {
        headers: { authorization: `Bearer ${this.opts.apiKey}` },
      });
      if (res.ok) {
        const { status } = (await res.json()) as { status: string };
        if (status === "approved") return true;
        if (status === "denied" || status === "expired") return false;
      }
      await new Promise((r) => setTimeout(r, every));
    }
    return false;
  }

  /** Check, wait for approval if needed, and throw CheckpointBlocked unless allowed. */
  async enforce(action: CheckInput): Promise<CheckResult | null> {
    let result: CheckResult;
    try {
      result = await this.check(action);
    } catch (err) {
      if (this.opts.onUnreachable === "open") return null;
      throw new CheckpointBlocked(null, `checkpoint unreachable (${(err as Error).message})`);
    }
    if (result.decision === "allow") return result;
    if (result.decision === "block") throw new CheckpointBlocked(result, result.reason);
    if (result.approval_id && (await this.waitForApproval(result.approval_id))) return result;
    throw new CheckpointBlocked(result, `not approved: ${result.reason}`);
  }

  /** Wrap any async function so every call goes through Checkpoint first. */
  guard<A extends unknown[], R>(
    tool: string,
    fn: (...args: A) => Promise<R>,
    describe?: (...args: A) => string,
  ): (...args: A) => Promise<R> {
    return async (...args: A) => {
      await this.enforce({
        tool,
        input: args.length === 1 ? args[0] : args,
        description: describe?.(...args),
      });
      return fn(...args);
    };
  }
}
