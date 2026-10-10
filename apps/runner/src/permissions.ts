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

export const HUB_MCP = "yapm";

export type ToolDecision = { behavior: "allow" } | { behavior: "deny"; message: string };

/** What a permission applies to: the command for Bash, the file for edits, else nothing. */
export function resourceOf(tool: string, input: Record<string, unknown>): string | null {
  const pick = (key: string) => (typeof input[key] === "string" ? (input[key] as string) : null);
  if (tool === "Bash") return pick("command")?.slice(0, 500) ?? null;
  if (tool === "Write" || tool === "Edit" || tool === "MultiEdit" || tool === "NotebookEdit")
    return pick("file_path") ?? pick("notebook_path");
  return null;
}

/** The resource a read-only MCP tool asks with, so a grant can cover only a server's read-only tools. */
export const READ_ONLY = "readOnly";

/** `mcp__slack__slack_read_channel` reads as `Slack: read_channel`; other tools as themselves. */
function toolName(tool: string): string | null {
  const [, server = "", name = ""] = /^mcp__(.+?)__(.+)$/.exec(tool) ?? [];
  if (!server) return null;
  const short = name.startsWith(`${server}_`) ? name.slice(server.length + 1) : name;
  return `${server[0]?.toUpperCase()}${server.slice(1)}: ${short}`;
}

/** Commands this short read well as a title; longer ones wrap the heading and get cut. */
const TITLE_RESOURCE_MAX = 60;

/**
 * The request's title and reason. A short resource goes in the title as is. A long one, like a
 * piped one-liner, would fill the heading, so the agent's description of the call names it
 * instead (and so is not repeated as the reason), or the resource is clipped with an ellipsis.
 */
export function describeRequest(
  agent: string,
  tool: string,
  resource: string | null,
  description: string,
  issue: string | null,
): { title: string; reason: string } {
  const needed = `Needed for the work on ${issue ?? "the current task"}; the session is paused until you answer.`;
  const mcp = toolName(tool);
  if (mcp) return { title: `${agent} wants to use ${mcp}`, reason: description || needed };
  const short = resource && resource.length <= TITLE_RESOURCE_MAX && !resource.includes("\n");
  const subject = short
    ? resource
    : description ||
      (resource && `${resource.replace(/\s+/g, " ").slice(0, TITLE_RESOURCE_MAX - 1)}…`);
  return {
    title: `${agent} wants to use ${tool}${subject ? `: ${subject}` : ""}`,
    reason: subject === description || !description ? needed : description,
  };
}

/**
 * What the owner reads before answering. A Bash command shows as itself in a shell block: inside
 * JSON every quote is escaped, which makes a one-liner hard to check, and its description is
 * already in the request's title or reason. Other tools show their input as JSON.
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
  /** The tool says it only reads (its MCP `readOnlyHint`); it still needs a grant. */
  readOnly = false,
): Promise<ToolDecision> {
  if (SAFE_TOOLS.has(tool) || tool.startsWith(`mcp__${HUB_MCP}__`)) return { behavior: "allow" };
  const action = `tool:${tool.startsWith("mcp__") ? tool.slice(5) : tool}`;
  const resource = readOnly ? READ_ONLY : resourceOf(tool, input);
  const now = await use(ctx, action, resource);
  if (now.allowed) return { behavior: "allow" };

  let requestId = now.pendingRequestId;
  if (!requestId) {
    const description = typeof input.description === "string" ? input.description : "";
    const { title, reason } = describeRequest(
      ctx.agent,
      tool,
      resourceOf(tool, input),
      description,
      ctx.issue,
    );
    const created = await ctx.hub.graphql<{ requestCreate: { request: { id: string } } }>(
      ctx.token,
      "mutation($input: RequestCreateInput!) { requestCreate(input: $input) { request { id } } }",
      {
        input: {
          title,
          action,
          resource,
          reason,
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
