import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { relyingParty } from "../auth.js";
import type { HubEnv } from "../context.js";
import { createLoaders } from "../loaders.js";
import { background, deliverPush, waitUntilOf } from "../push.js";
import { announce, CLIENT_ID_HEADER } from "../realtime.js";
import { dispatch } from "../runs/service.js";
import type { Ctx } from "../services/common.js";
import { learningTools } from "./learning.js";
import { machineTools } from "./machines.js";
import { mcpServerTools } from "./mcpServers.js";
import { planningTools } from "./planning.js";
import { handleMessage } from "./protocol.js";
import { tools as coreTools, type McpContext } from "./tools.js";

const tools = [
  ...coreTools,
  ...planningTools,
  ...learningTools,
  ...machineTools,
  ...mcpServerTools,
];

const INSTRUCTIONS = `This is yapm, the company's own issue tracker. You are one of its members.
Work happens in issues: read them with get_issue and list_my_issues, report progress with create_comment,
and move issues through their team's statuses with update_issue. Address teammates by name.
Prefer a reaction over a comment when you only need to acknowledge something.`;

/** POST /mcp: one JSON-RPC message (or a batch) in, JSON out. Needs an API token. */
export async function mcpHandler(c: Context<HubEnv>) {
  const viewer = c.var.viewer;
  if (!viewer) {
    c.header("WWW-Authenticate", 'Bearer realm="yapm"');
    throw new HTTPException(401, { message: "Send an API token: Authorization: Bearer los_…" });
  }
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json(
      { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } },
      400,
    );
  }
  const { deps } = c.var;
  const loaders = createLoaders(deps.db);
  const clientId = c.req.header(CLIENT_ID_HEADER) ?? null;
  const appUrl = relyingParty(c).origin;
  const waitUntil = waitUntilOf(c);
  const ctx: McpContext = {
    db: deps.db,
    deps,
    viewer: viewer.user,
    loaders,
    appUrl,
    async act(fn) {
      const at = deps.now?.() ?? Date.now();
      const service: Ctx = {
        db: deps.db,
        actorId: viewer.user.id,
        now: at,
        ...(viewer.runId ? { runId: viewer.runId } : {}),
      };
      const result = await fn(service);
      if (service.notified) {
        await dispatch(deps, at);
        background(waitUntil, deliverPush(deps, at, appUrl));
      }
      // Later reads in the same call must see the change.
      for (const loader of Object.values(loaders)) loader.clearAll();
      await announce(deps.realtime, { type: "change", actorId: viewer.user.id, clientId, at });
      return result;
    },
  };
  const info = { name: "yapm", version: deps.config.version, instructions: INSTRUCTIONS };
  const messages = Array.isArray(body) ? body : [body];
  const responses = [];
  for (const message of messages) {
    try {
      const response = await handleMessage(message, tools, info, ctx);
      if (response) responses.push(response);
    } catch (error) {
      console.error(error);
      responses.push({
        jsonrpc: "2.0",
        id: message?.id ?? null,
        error: { code: -32603, message: "Internal error" },
      });
    }
  }
  if (!responses.length) return c.body(null, 202);
  return c.json(Array.isArray(body) ? responses : responses[0]);
}
