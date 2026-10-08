import { MCP_SERVER_STATUSES, machines, type mcpServers } from "@life-os/schema";
import { eq } from "drizzle-orm";
import {
  createMcpServer,
  deleteMcpServer,
  listMcpServers,
  requireMcpServer,
  updateMcpServer,
} from "../services/mcpServers.js";
import { act, builder, db, requireViewer } from "./builder.js";
import { DeletePayload, payload } from "./mutations.js";
import { Machine } from "./runs.js";
import { User } from "./types.js";

type McpServerRow = typeof mcpServers.$inferSelect;

const McpServerStatus = builder.enumType("McpServerStatus", { values: MCP_SERVER_STATUSES });

export const McpServer = builder.objectRef<McpServerRow>("McpServer");

McpServer.implement({
  description:
    "An MCP server a machine runs for some agents. Sign-ins and tokens stay on the machine.",
  fields: (t) => ({
    id: t.exposeID("id"),
    name: t.exposeString("name", { description: "Its tools are mcp__<name>__<tool>." }),
    transport: t.exposeString("transport", { description: "http or stdio." }),
    url: t.exposeString("url", { nullable: true }),
    command: t.exposeString("command", { nullable: true }),
    args: t.stringList({ resolve: (s) => s.args ?? [] }),
    status: t.field({ type: McpServerStatus, resolve: (s) => s.status }),
    statusDetail: t.exposeString("statusDetail", { nullable: true }),
    authUrl: t.exposeString("authUrl", {
      nullable: true,
      description: "Where the owner signs in while it needs authorization.",
    }),
    allAgents: t.boolean({ resolve: (s) => s.agentIds === null }),
    agents: t.field({
      type: [User],
      description: "Agents that get it, unless allAgents.",
      resolve: async (s, _a, ctx) =>
        (await Promise.all((s.agentIds ?? []).map((id) => ctx.loaders.user.load(id)))).filter(
          (u) => u !== null,
        ),
    }),
    machine: t.field({
      type: Machine,
      nullable: true,
      resolve: async (s, _a, ctx) =>
        (await db(ctx).select().from(machines).where(eq(machines.id, s.machineId)).get()) ?? null,
    }),
    createdAt: t.field({ type: "DateTime", resolve: (s) => s.createdAt }),
  }),
});

builder.objectField(Machine, "mcpServers", (t) =>
  t.field({
    type: [McpServer],
    description: "Servers the hub asked this machine to run.",
    resolve: (m, _a, ctx) => listMcpServers(db(ctx), m.id),
  }),
);

builder.queryField("mcpServers", (t) =>
  t.field({
    type: [McpServer],
    args: { machineId: t.arg.string({ required: false }) },
    resolve: (_root, args, ctx) => {
      requireViewer(ctx);
      return listMcpServers(db(ctx), args.machineId);
    },
  }),
);

const McpServerPayload = payload("McpServerPayload", "mcpServer", McpServer);

const McpServerCreateInput = builder.inputType("McpServerCreateInput", {
  fields: (t) => ({
    machineId: t.string({ required: true }),
    name: t.string({ required: true }),
    url: t.string({ required: false, description: "A remote server (https)." }),
    command: t.string({ required: false, description: "Or a command the machine runs." }),
    args: t.stringList({ required: false }),
    agentIds: t.stringList({
      required: false,
      description: "Agents that get it; every agent when omitted by the owner.",
    }),
  }),
});

const McpServerUpdateInput = builder.inputType("McpServerUpdateInput", {
  fields: (t) => ({
    agentIds: t.stringList({ required: false, description: "Null gives it to every agent." }),
  }),
});

builder.mutationFields((t) => ({
  mcpServerCreate: t.field({
    type: McpServerPayload,
    description: "Asks a machine to run an MCP server. Agents need mcp.install on the machine.",
    args: { input: t.arg({ type: McpServerCreateInput, required: true }) },
    resolve: async (_root, args, ctx) => {
      const id = await act(ctx, (s) => createMcpServer(s, args.input));
      return { entity: await requireMcpServer(db(ctx), id) };
    },
  }),
  mcpServerUpdate: t.field({
    type: McpServerPayload,
    args: {
      id: t.arg.string({ required: true }),
      input: t.arg({ type: McpServerUpdateInput, required: true }),
    },
    resolve: async (_root, args, ctx) => {
      const id = await act(ctx, (s) => updateMcpServer(s, args.id, args.input));
      return { entity: await requireMcpServer(db(ctx), id) };
    },
  }),
  mcpServerDelete: t.field({
    type: DeletePayload,
    args: { id: t.arg.string({ required: true }) },
    resolve: async (_root, args, ctx) => {
      await act(ctx, (s) => deleteMcpServer(s, args.id));
      return { entityId: args.id };
    },
  }),
}));
