import type { HubClient } from "./hub.js";

/** Tools an agent may use without asking: they only read, or only touch the hub (which checks). */
export const SAFE_TOOLS = new Set([
  "Read",
  "Glob",
  "Grep",
  "LS",
  "WebSearch",
  "WebFetch",
  "TodoWrite",
  "ToolSearch",
  "StructuredOutput",
]);

export const HUB_MCP = "life-os";

export type ToolDecision = { behavior: "allow" } | { behavior: "deny"; message: string };

/** What a permission applies to: the command for Bash, the file for edits, else nothing. */
export function resourceOf(tool: string, input: Record<string, unknown>): string | null {
  const pick = (key: string) => (typeof input[key] === "string" ? (input[key] as string) : null);
  if (tool === "Bash") return pick("command")?.slice(0, 500) ?? null;
  if (tool === "Write" || tool === "Edit" || tool === "MultiEdit" || tool === "NotebookEdit")
    return pick("file_path") ?? pick("notebook_path");
  return null;
}

/**
 * What the owner reads before answering. A Bash command shows as itself in a shell block: inside
 * JSON every quote is escaped, which makes a one-liner hard to check, and its description is
 * already the request's reason. Other tools show their input as JSON.
 */
export function requestDetails(tool: string, input: Record<string, unknown>): string {
  const command = typeof input.command === "string" ? input.command : null;
  const [lang, body] =
    tool === "Bash" && command ? ["sh", command] : ["json", JSON.stringify(input, null, 2)];
  // A fence longer than any run of backticks in the body, so the body can't close it.
  const ticks = Math.max(2, ...(body.match(/`+/g) ?? []).map((run) => run.length)) + 1;
  const fence = "`".repeat(ticks);
  return `${fence}${lang}\n${body.slice(0, 4000)}\n${fence}`;
}

export interface PermissionContext {
  hub: HubClient;
  token: string;
  agent: string;
  issueId: string | null;
  issue: string | null;
  /** How often to look for the owner's answer. */
  pollMs: number;
  signal: AbortSignal;
  onEvent: (event: Record<string, unknown>) => void;
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    });
  });

interface Permission {
  allowed: boolean;
  pendingRequestId: string | null;
}

async function use(ctx: PermissionContext, action: string, resource: string | null) {
  const data = await ctx.hub.graphql<{ permissionUse: Permission }>(
    ctx.token,
    "mutation($action: String!, $resource: String) { permissionUse(action: $action, resource: $resource) { allowed pendingRequestId } }",
    { action, resource },
  );
  return data.permissionUse;
}

/**
 * Decides one tool call. Anything outside the safe set needs the agent's permission on the hub;
 * without it the call waits while the owner is asked, and the answer decides it.
 */
export async function decideTool(
  ctx: PermissionContext,
  tool: string,
  input: Record<string, unknown>,
): Promise<ToolDecision> {
  if (SAFE_TOOLS.has(tool) || tool.startsWith(`mcp__${HUB_MCP}__`)) return { behavior: "allow" };
  const action = `tool:${tool.startsWith("mcp__") ? tool.slice(5) : tool}`;
  const resource = resourceOf(tool, input);
  const now = await use(ctx, action, resource);
  if (now.allowed) return { behavior: "allow" };

  let requestId = now.pendingRequestId;
  if (!requestId) {
    const description = typeof input.description === "string" ? input.description : "";
    const created = await ctx.hub.graphql<{ requestCreate: { request: { id: string } } }>(
      ctx.token,
      "mutation($input: RequestCreateInput!) { requestCreate(input: $input) { request { id } } }",
      {
        input: {
          title: `${ctx.agent} wants to use ${tool}${resource ? `: ${resource.slice(0, 80)}` : ""}`,
          action,
          resource,
          reason:
            description ||
            `Needed for the work on ${ctx.issue ?? "the current task"}; the session is paused until you answer.`,
          details: requestDetails(tool, input),
          issueId: ctx.issueId,
        },
      },
    );
    requestId = created.requestCreate.request.id;
  }
  ctx.onEvent({ type: "permission", tool, action, resource, requestId, state: "waiting" });

  while (!ctx.signal.aborted) {
    const data = await ctx.hub.graphql<{
      request: { status: string; answer: string | null } | null;
    }>(ctx.token, "query($id: String!) { request(id: $id) { status answer } }", {
      id: requestId,
    });
    const request = data.request;
    if (!request) return { behavior: "deny", message: "The request disappeared." };
    if (request.status === "approved") {
      const granted = await use(ctx, action, resource);
      ctx.onEvent({ type: "permission", tool, requestId, state: "approved" });
      if (granted.allowed) return { behavior: "allow" };
      return { behavior: "deny", message: "The approval was already used." };
    }
    if (request.status !== "pending") {
      ctx.onEvent({ type: "permission", tool, requestId, state: request.status });
      return {
        behavior: "deny",
        message: `The owner ${request.status === "rejected" ? "rejected" : "withdrew"} this${request.answer ? `: ${request.answer}` : "."} Respect that and find another way, or stop.`,
      };
    }
    await sleep(ctx.pollMs, ctx.signal);
  }
  return { behavior: "deny", message: "The run was stopped." };
}
