import { MCP_AUTHS, MCP_SERVER_STATUSES, mcpServers, requests } from "@life-os/schema";
import { eq } from "drizzle-orm";
import {
  clientMetadata,
  connectMcpServer,
  createMcpServer,
  needsClient,
  requireMcpServer,
} from "../services/mcpServers.js";
import { act, builder, db } from "./builder.js";
import { Request } from "./requests.js";

type McpServerRow = typeof mcpServers.$inferSelect;

const McpServerAuth = builder.enumType("McpServerAuth", { values: MCP_AUTHS });
const McpServerStatus = builder.enumType("McpServerStatus", { values: MCP_SERVER_STATUSES });

export const McpServer = builder.objectRef<McpServerRow>("McpServer").implement({
  description:
    "An outside MCP server agents asked for. Ready once connected; agents need `mcp.use` on its name.",
  fields: (t) => ({
    id: t.exposeID("id"),
    name: t.exposeString("name", { description: "Its tools are mcp__<name>__<tool>." }),
    url: t.exposeString("url", { nullable: true, description: "A remote server's address." }),
    command: t.exposeString("command", {
      nullable: true,
      description: "Or the command the runner starts it with.",
    }),
    args: t.stringList({ resolve: (s) => s.args ?? [] }),
    auth: t.field({ type: McpServerAuth, resolve: (s) => s.auth }),
    status: t.field({ type: McpServerStatus, resolve: (s) => s.status }),
    howToConnect: t.exposeString("howToConnect", {
      nullable: true,
      description: "The agent's instructions for getting the token.",
    }),
    secretEnv: t.exposeString("secretEnv", {
      nullable: true,
      description: "The env var a local server's token goes in.",
    }),
    needsClient: t.boolean({
      description:
        "Whether connecting needs the client ID (and secret) of the owner's own OAuth app at the provider.",
      resolve: (s) => needsClient(s),
    }),
    redirectUri: t.string({
      nullable: true,
      description: "The redirect URL an OAuth app for it must allow.",
      resolve: (s, _args, ctx) =>
        s.auth === "oauth" ? (clientMetadata(ctx.origin ?? "").redirect_uris[0] ?? null) : null,
    }),
  }),
});

builder.objectField(Request, "mcpServer", (t) =>
  t.field({
    type: McpServer,
    nullable: true,
    description: "The server an `mcp.use` request is for.",
    resolve: async (r, _args, ctx) =>
      r.action === "mcp.use" && r.resource
        ? ((await db(ctx).select().from(mcpServers).where(eq(mcpServers.name, r.resource)).get()) ??
          null)
        : null,
  }),
);

const McpServerCreateInput = builder.inputType("McpServerCreateInput", {
  fields: (t) => ({
    name: t.string({ required: true, description: "Short and plain, e.g. slack-acme." }),
    url: t.string({ required: false, description: "A remote server's MCP endpoint." }),
    command: t.string({ required: false, description: "Or the command that starts it locally." }),
    args: t.stringList({ required: false }),
    auth: t.field({
      type: McpServerAuth,
      required: false,
      description: "Worked out from the url when left out.",
    }),
    secretEnv: t.string({
      required: false,
      description: "The env var a local server's token goes in.",
    }),
    howToConnect: t.string({
      required: false,
      description: "Markdown for the owner: where to get the token, with which scopes.",
    }),
    scopes: t.stringList({
      required: false,
      description: "The OAuth scopes you need, as few as will do. Defaults to the server's.",
    }),
    reason: t.string({ required: true }),
    issueId: t.string({ required: false }),
  }),
});

const McpServerCreatePayload = builder
  .objectRef<{ serverId: string; requestId: string | null }>("McpServerCreatePayload")
  .implement({
    fields: (t) => ({
      success: t.boolean({ resolve: () => true }),
      mcpServer: t.field({
        type: McpServer,
        resolve: (p, _args, ctx) => requireMcpServer(db(ctx), p.serverId),
      }),
      request: t.field({
        type: Request,
        nullable: true,
        description: "The request to use it; null when you already may.",
        resolve: async (p, _args, ctx) =>
          p.requestId
            ? ((await db(ctx).select().from(requests).where(eq(requests.id, p.requestId)).get()) ??
              null)
            : null,
      }),
    }),
  });

const McpServerConnectPayload = builder
  .objectRef<{ serverId: string; authorizationUrl: string | null }>("McpServerConnectPayload")
  .implement({
    fields: (t) => ({
      success: t.boolean({ resolve: () => true }),
      mcpServer: t.field({
        type: McpServer,
        resolve: (p, _args, ctx) => requireMcpServer(db(ctx), p.serverId),
      }),
      authorizationUrl: t.exposeString("authorizationUrl", {
        nullable: true,
        description: "Where to sign in with the provider, when connecting with OAuth.",
      }),
    }),
  });

builder.mutationFields((t) => ({
  mcpServerCreate: t.field({
    type: McpServerCreatePayload,
    description:
      "Asks to connect an outside MCP server, filing an `mcp.use` request for it. A name already taken only files the request.",
    args: { input: t.arg({ type: McpServerCreateInput, required: true }) },
    resolve: (_root, args, ctx) =>
      act(ctx, (s) => createMcpServer(s, ctx.deps, args.input, ctx.origin ?? "")),
  }),
  mcpServerConnect: t.field({
    type: McpServerConnectPayload,
    description:
      "Owner only: stores a pasted token, or starts the OAuth sign-in and returns where to go. Servers that need it take the owner's own OAuth app's client ID and secret.",
    args: {
      id: t.arg.string({ required: true }),
      token: t.arg.string({ required: false }),
      clientId: t.arg.string({ required: false }),
      clientSecret: t.arg.string({ required: false }),
    },
    resolve: async (_root, args, ctx) => ({
      serverId: args.id,
      ...(await act(ctx, (s) =>
        connectMcpServer(s, ctx.deps, { ...args, origin: ctx.origin ?? "" }),
      )),
    }),
  }),
}));
