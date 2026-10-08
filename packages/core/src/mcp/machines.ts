import { machines } from "@life-os/schema";
import { asc, eq, or, sql } from "drizzle-orm";
import { createMcpServer, listMcpServers } from "../services/mcpServers.js";
import { type Tool, ToolError } from "./protocol.js";
import { type McpContext, resolveUser, str } from "./tools.js";

// Machines and the MCP servers they run: how agents get new capabilities, with approval.

async function resolveMachine(c: McpContext, ref: string) {
  const row = await c.db
    .select()
    .from(machines)
    .where(or(eq(machines.id, ref), sql`lower(${machines.name}) = ${ref.toLowerCase()}`))
    .get();
  if (!row) throw new ToolError(`No machine matches "${ref}". Use list_machines to see them.`);
  return row;
}

export const machineTools: Tool<McpContext>[] = [
  {
    name: "list_machines",
    title: "List machines",
    description:
      "The computers agents run on, with their tags and MCP servers (hub-managed ones show who gets them and whether they're ready).",
    readOnly: true,
    inputSchema: { type: "object", properties: {} },
    async run(_args, c) {
      const rows = await c.db.select().from(machines).orderBy(asc(machines.name)).all();
      const servers = await listMcpServers(c.db);
      return Promise.all(
        rows
          .filter((m) => m.status !== "revoked")
          .map(async (m) => ({
            id: m.id,
            name: m.name,
            status: m.status,
            tags: m.tags,
            localMcpServers: m.mcps,
            mcpServers: await Promise.all(
              servers
                .filter((s) => s.machineId === m.id)
                .map(async (s) => ({
                  id: s.id,
                  name: s.name,
                  url: s.url,
                  command: s.command,
                  status: s.status,
                  agents:
                    s.agentIds === null
                      ? "all"
                      : await Promise.all(
                          s.agentIds.map(async (id) => (await c.loaders.user.load(id))?.name ?? id),
                        ),
                })),
            ),
          })),
      );
    },
  },
  {
    name: "add_mcp_server",
    title: "Add MCP server",
    description:
      "Ask a machine to run an MCP server, e.g. an employer's Slack on that employer's Mac. Give a remote https url, or a command and args. Needs mcp.install on the machine: if you lack it, ask with create_request (action mcp.install, resource the machine's id) and try again once approved. If the server needs a sign-in, the owner is asked to connect it; its tools appear in your next run as mcp__<name>__<tool>, and each still needs its tool grant.",
    inputSchema: {
      type: "object",
      properties: {
        machine: { type: "string", description: "Machine name or id" },
        name: { type: "string", description: "Short name, e.g. slack-acme" },
        url: { type: "string" },
        command: { type: "string" },
        args: { type: "array", items: { type: "string" } },
        agents: {
          type: "array",
          items: { type: "string" },
          description: "Who gets it; just you when omitted",
        },
      },
      required: ["machine", "name"],
    },
    async run(args, c) {
      const machine = await resolveMachine(c, String(args.machine));
      const agents = Array.isArray(args.agents)
        ? await Promise.all(args.agents.map((a) => resolveUser(c, String(a))))
        : undefined;
      const id = await c.act((s) =>
        createMcpServer(s, {
          machineId: machine.id,
          name: String(args.name),
          url: str(args.url) ?? null,
          command: str(args.command) ?? null,
          args: Array.isArray(args.args) ? args.args.map(String) : null,
          ...(agents ? { agentIds: agents.map((a) => a.id) } : {}),
        }),
      );
      return { id, status: "installing", machine: machine.name };
    },
  },
];
