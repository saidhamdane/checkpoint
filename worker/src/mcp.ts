// Remote MCP server (Streamable HTTP, stateless JSON responses) at /mcp.
// Lets Claude, Claude Code or any MCP client call Checkpoint before acting.
// Auth: the same Bearer API key as the REST API.

import type { CheckRequest } from "./decide";
import { Env, authenticate, getApprovalStatus, runCheck } from "./index";

const SUPPORTED_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"];
const SERVER_INFO = { name: "checkpoint", version: "0.2.0" };
const MAX_BODY_BYTES = 64_000;

const INSTRUCTIONS =
  "Checkpoint is a safety gate. Before any action that spends money, deletes data, sends external " +
  "messages, changes permissions or is otherwise hard to undo, call checkpoint_check with a clear " +
  "description of the exact action. Obey the decision: 'allow' -> proceed; 'block' -> do not perform " +
  "the action and tell the user why; 'ask' -> do not perform it yet, tell the user approval is pending, " +
  "and only proceed after checkpoint_approval_status returns 'approved'.";

const TOOLS = [
  {
    name: "checkpoint_check",
    title: "Check an action before doing it",
    description:
      "Call BEFORE performing any consequential action (payments, refunds, deleting data, sending emails or " +
      "messages to external people, changing permissions, submitting forms). Returns decision 'allow', " +
      "'block' or 'ask' with a risk score and reason. Never perform a blocked action. For 'ask', wait for " +
      "human approval via checkpoint_approval_status.",
    inputSchema: {
      type: "object",
      properties: {
        tool: { type: "string", description: "Name of the tool/action about to run, e.g. 'stripe.refund' or 'gmail.send'." },
        description: { type: "string", description: "One sentence describing exactly what will happen, with amounts and recipients." },
        input: { description: "The exact arguments that will be passed to the tool." },
        context: { type: "string", description: "Optional: why the agent wants to do this." },
        agent_id: { type: "string", description: "Optional: identifier of the agent." },
        policies: {
          type: "array",
          items: {
            anyOf: [
              { type: "string", description: "Legacy rule, e.g. 'Never email customers on weekends.'" },
              {
                type: "object",
                properties: {
                  rule: { type: "string", description: "A factual statement about the action, e.g. 'This action sends an email to a customer.'" },
                  action: { type: "string", enum: ["block", "ask"] },
                  label: { type: "string" },
                },
                required: ["rule", "action"],
              },
            ],
          },
          description: "Optional policies that replace the defaults for this check. Prefer objects with a factual 'rule' and an 'action'.",
        },
      },
      required: ["tool", "description"],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: "checkpoint_approval_status",
    title: "Get approval status",
    description:
      "Returns 'pending', 'approved', 'denied' or 'expired' for an approval_id returned by checkpoint_check. " +
      "Only proceed with the action when the status is 'approved'.",
    inputSchema: {
      type: "object",
      properties: { approval_id: { type: "string" } },
      required: ["approval_id"],
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
];

type Rpc = { jsonrpc?: string; id?: string | number | null; method?: string; params?: any };

export async function handleMcp(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (req.method !== "POST") {
    return new Response(null, { status: 405, headers: { allow: "POST" } });
  }

  const keyId = await authenticate(req, env);
  if (!keyId) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { "content-type": "application/json", "www-authenticate": 'Bearer realm="checkpoint"' },
    });
  }

  const text = await req.text();
  if (text.length > MAX_BODY_BYTES) return rpcJson(errorObj(null, -32600, "Request too large"), 413);

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return rpcJson(errorObj(null, -32700, "Parse error"));
  }

  const batch = Array.isArray(parsed);
  const messages = (batch ? parsed : [parsed]) as Rpc[];
  if (messages.length === 0) return rpcJson(errorObj(null, -32600, "Empty batch"));

  const replies: unknown[] = [];
  for (const m of messages) {
    const r = await dispatch(m, env, ctx, keyId);
    if (r !== null) replies.push(r);
  }

  // Only notifications / responses were sent: acknowledge without a body.
  if (replies.length === 0) return new Response(null, { status: 202 });
  return rpcJson(batch ? replies : replies[0]);
}

async function dispatch(m: Rpc, env: Env, ctx: ExecutionContext, keyId: string): Promise<unknown | null> {
  if (!m || typeof m !== "object" || m.jsonrpc !== "2.0") return errorObj(m?.id ?? null, -32600, "Invalid Request");
  const isNotification = m.id === undefined;
  if (!m.method) return null; // a response from the client; nothing to do
  if (isNotification) return null;

  switch (m.method) {
    case "initialize": {
      const requested = m.params?.protocolVersion;
      const protocolVersion = SUPPORTED_VERSIONS.includes(requested) ? requested : SUPPORTED_VERSIONS[0];
      return result(m.id, {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: INSTRUCTIONS,
      });
    }
    case "ping":
      return result(m.id, {});
    case "tools/list":
      return result(m.id, { tools: TOOLS });
    case "tools/call":
      return result(m.id, await callTool(m.params, env, ctx, keyId));
    default:
      return errorObj(m.id, -32601, `Method not found: ${m.method}`);
  }
}

async function callTool(params: any, env: Env, ctx: ExecutionContext, keyId: string) {
  const name = params?.name;
  const args = params?.arguments ?? {};

  if (name === "checkpoint_check") {
    if (typeof args.tool !== "string" || !args.tool.trim()) return toolError("'tool' is required");
    if (typeof args.description !== "string" || !args.description.trim()) return toolError("'description' is required");
    const body: CheckRequest = {
      action: { tool: args.tool, description: args.description, input: args.input },
      context: typeof args.context === "string" ? args.context : undefined,
      agent_id: typeof args.agent_id === "string" ? args.agent_id : "mcp",
      policies: Array.isArray(args.policies) ? args.policies : undefined,
    };
    const out = await runCheck(env, ctx, keyId, body);
    if (out.status !== 200) return toolError(String(out.body.error ?? "check failed"));
    const r = out.body as Record<string, any>;
    const instruction =
      r.decision === "allow"
        ? "ALLOWED. You may proceed with this action."
        : r.decision === "block"
          ? "BLOCKED. Do NOT perform this action. Tell the user it was blocked and why."
          : `APPROVAL REQUIRED. Do NOT perform this action yet. Tell the user it is waiting for human approval, ` +
            `then call checkpoint_approval_status with approval_id "${r.approval_id}". Proceed only if it returns "approved".`;
    return {
      content: [{ type: "text", text: `${instruction}\nReason: ${r.reason}\nRisk: ${r.risk ?? "unknown"}` }],
      structuredContent: r,
      isError: false,
    };
  }

  if (name === "checkpoint_approval_status") {
    if (typeof args.approval_id !== "string" || !/^[A-Za-z0-9-]{8,64}$/.test(args.approval_id))
      return toolError("valid 'approval_id' is required");
    const st = await getApprovalStatus(env, keyId, args.approval_id);
    if (!st) return toolError("approval not found");
    const s = st.status;
    const instruction =
      s === "approved"
        ? "APPROVED. You may now perform the action exactly as it was checked."
        : s === "pending"
          ? "Still pending. Do not perform the action yet."
          : `Not approved (${s}). Do NOT perform the action.`;
    return { content: [{ type: "text", text: instruction }], structuredContent: st, isError: false };
  }

  return toolError(`Unknown tool: ${name}`);
}

function toolError(message: string) {
  return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
}

function result(id: Rpc["id"], res: unknown) {
  return { jsonrpc: "2.0", id, result: res };
}

function errorObj(id: Rpc["id"] | null, code: number, message: string) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function rpcJson(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}
