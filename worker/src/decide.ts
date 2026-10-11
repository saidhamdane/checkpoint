// Pure decision logic: builds the question set for the decision model and
// turns its probabilities into allow / block / ask. No I/O here, easy to test.
//
// Two kinds of policy:
//  - Typed (recommended): a factual statement about the action plus what to do when it is true.
//      { label: "Moves money", rule: "Executing this action sends ... money right now.", action: "block" }
//    Decision models are much more stable at classifying facts than at judging "violations",
//    so the same action gets the same answer however it is phrased.
//  - Legacy string: "Never do X." Scored as "would violate this rule", using thresholds.block / ask.

export type Decision = "allow" | "block" | "ask";
export type FailMode = "open" | "closed";
export type PolicyAction = "block" | "ask";

export interface TypedPolicy {
  rule: string;
  action: PolicyAction;
  label?: string;
}
export type Policy = string | TypedPolicy;

export interface Action {
  tool: string;
  input?: unknown;
  description?: string;
}

export interface CheckRequest {
  action: Action;
  agent_id?: string;
  context?: string;
  policies?: Policy[];
  thresholds?: { block?: number; ask?: number };
}

export interface Thresholds {
  block: number;
  ask: number;
}

export interface Triggered {
  rule: string;
  probability: number;
  action?: PolicyAction;
}

export interface DecideResult {
  decision: Decision;
  risk: number | null;
  impact: number | null;
  reason: string;
  triggered: Triggered[];
  degraded?: boolean;
}

export const DEFAULT_POLICIES: TypedPolicy[] = [
  {
    label: "Moves money",
    rule: "Executing this action itself sends, transfers, pays, charges or refunds money right now (not just writing or talking about money).",
    action: "block",
  },
  {
    label: "Deletes data",
    rule: "Executing this action permanently deletes, overwrites or wipes data, files, records, repositories or accounts.",
    action: "block",
  },
  {
    label: "Exposes secrets or private data",
    rule: "This action exposes passwords, API keys, access tokens, or other people's private data to someone who should not have them, or makes them public.",
    action: "block",
  },
  {
    label: "Commits the business",
    rule: "This action promises, offers or commits to a payment, refund, discount, deadline, price or contract on behalf of the business.",
    action: "ask",
  },
  {
    label: "Sensitive message to outsiders",
    rule: "This action sends a message to people outside the organization that is angry, rude, misleading, or makes legal, medical or financial claims.",
    action: "ask",
  },
];

export const DEFAULT_THRESHOLDS: Thresholds = { block: 0.85, ask: 0.5 };

const TRIGGER = 0.5; // a typed policy is "true" at or above this probability
const UNSURE = 0.3; // a block policy in [UNSURE, TRIGGER) asks a human instead of passing
const MAX_STATE_CHARS = 40_000;
const MIN_REPORTED_PROBABILITY = 0.2;
const HIGH_IMPACT = 0.9;

export function normalizePolicies(p: Policy[] | undefined): Policy[] {
  return p && p.length ? p : DEFAULT_POLICIES;
}

function isTyped(p: Policy): p is TypedPolicy {
  return typeof p === "object" && p !== null;
}

function policyName(p: Policy): string {
  return isTyped(p) ? p.label ?? p.rule : p;
}

export function buildState(req: CheckRequest): string {
  const payload = {
    agent_id: req.agent_id ?? null,
    tool: req.action.tool,
    description: req.action.description ?? null,
    input: req.action.input ?? null,
    context: req.context ?? null,
  };
  let s = JSON.stringify(payload);
  if (s.length > MAX_STATE_CHARS) s = s.slice(0, MAX_STATE_CHARS) + "...[truncated]";
  return `An AI agent proposes the following action and is waiting for approval:\n${s}`;
}

export function buildQuestions(policies: Policy[]): Record<string, unknown> {
  const questions: Record<string, unknown> = {};
  policies.forEach((p, i) => {
    questions[`p${i}`] = {
      type: "noul",
      instructions: isTyped(p)
        ? `About the proposed action: ${p.rule}`
        : `Executing the proposed action would violate this rule: "${p}"`,
    };
  });
  questions.impact = {
    type: "noul",
    instructions:
      "The proposed action is irreversible or has significant real-world impact (money, deleting data, contacting external people).",
  };
  return questions;
}

function getAnswers(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, any>;
  return r.answers ?? r.result?.answers ?? null;
}

// Decision APIs following the System One convention return { type: "noul", noul: p }.
// A few fallbacks keep us robust to small format differences between providers.
export function extractProbability(answer: unknown): number | null {
  if (typeof answer === "number") return clamp01(answer);
  if (!answer || typeof answer !== "object") return null;
  const a = answer as Record<string, any>;
  for (const v of [a.noul, a.probability, a.yes, a.probabilities?.yes, a.probabilities?.true]) {
    if (typeof v === "number" && Number.isFinite(v)) return clamp01(v);
  }
  return null;
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

export function failResult(mode: FailMode, reason: string): DecideResult {
  return {
    decision: mode === "open" ? "allow" : "ask",
    risk: null,
    impact: null,
    reason,
    triggered: [],
    degraded: true,
  };
}

const RANK: Record<Decision, number> = { allow: 0, ask: 1, block: 2 };

export function decide(
  raw: unknown,
  policies: Policy[],
  t: Thresholds,
  failMode: FailMode,
  modelError: string | null = null,
): DecideResult {
  if (modelError) return failResult(failMode, `model_error: ${modelError}`);

  const answers = getAnswers(raw);
  if (!answers) return failResult(failMode, "unparseable_model_output");

  let decision: Decision = "allow";
  let cause: { name: string; p: number; how: string } | null = null;
  const scored: Triggered[] = [];

  for (let i = 0; i < policies.length; i++) {
    const p = extractProbability(answers[`p${i}`]);
    if (p === null) return failResult(failMode, "unparseable_model_output");
    const pol = policies[i];
    const prob = round(p);
    scored.push({ rule: policyName(pol), probability: prob, ...(isTyped(pol) ? { action: pol.action } : {}) });

    let d: Decision = "allow";
    let how = "";
    if (isTyped(pol)) {
      if (prob >= TRIGGER) {
        d = pol.action;
        how = pol.action === "block" ? "Blocked" : "Needs approval";
      } else if (pol.action === "block" && prob >= UNSURE) {
        d = "ask";
        how = "Unsure, needs approval";
      }
    } else if (prob >= t.block) {
      d = "block";
      how = "Blocked";
    } else if (prob >= t.ask) {
      d = "ask";
      how = "Needs approval";
    }

    // Keep the most severe decision; among equals, the most confident cause.
    if (RANK[d] > RANK[decision] || (d !== "allow" && RANK[d] === RANK[decision] && cause && prob > cause.p)) {
      decision = d;
      cause = { name: policyName(pol), p: prob, how };
    }
  }

  scored.sort((a, b) => b.probability - a.probability);
  const impactRaw = extractProbability(answers.impact);
  const impact = impactRaw === null ? null : round(impactRaw);
  const risk = scored[0]?.probability ?? 0;

  let reason = cause ? `${cause.how}: ${cause.name} (${pct(cause.p)})` : "No policy matched.";

  // High-impact actions with a non-trivial signal go to a human instead of passing silently.
  if (decision === "allow" && impact !== null && impact >= HIGH_IMPACT && risk >= 0.25) {
    decision = "ask";
    reason = `Needs approval: high-impact action, closest policy "${scored[0].rule}" (${pct(risk)})`;
  }

  return {
    decision,
    risk,
    impact,
    reason,
    triggered: scored.filter((s) => s.probability >= MIN_REPORTED_PROBABILITY),
  };
}
