import { machines } from "@life-os/schema";
import { asc, sql } from "drizzle-orm";
import { machineName } from "../services/machines.js";
import type { Tool } from "./protocol.js";
import type { McpContext } from "./tools.js";

// Machines: the computers agents run on.

export const machineTools: Tool<McpContext>[] = [
  {
    name: "list_machines",
    title: "List machines",
    description: "The computers agents run on, with their tags.",
    readOnly: true,
    inputSchema: { type: "object", properties: {} },
    async run(_args, c) {
      const rows = await c.db
        .select()
        .from(machines)
        .orderBy(asc(sql`coalesce(${machines.displayName}, ${machines.name})`))
        .all();
      return rows
        .filter((m) => m.status !== "revoked")
        .map((m) => ({
          id: m.id,
          name: machineName(m),
          ...(m.displayName ? { originalName: m.name } : {}),
          status: m.status,
          tags: m.tags,
        }));
    },
  },
];
