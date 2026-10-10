import { machines, RUN_STATUSES, type RunStatus, runs } from "@yapm/schema";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { announce } from "../realtime.js";
import { stopRun } from "../runs/service.js";
import { machineName } from "../services/machines.js";
import type { Tool } from "./protocol.js";
import { issueSummary, type McpContext, num, requireIssue, resolveUser, str } from "./tools.js";

// Machines: the computers agents run on, and the runs on them.

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
  {
    name: "list_runs",
    title: "List runs",
    description: "Agent runs, newest first.",
    readOnly: true,
    inputSchema: {
      type: "object",
      properties: {
        agent: { type: "string", description: 'Name, id or "me"' },
        issue: { type: "string", description: "e.g. FIN-12" },
        status: { type: "string", enum: [...RUN_STATUSES] },
        limit: { type: "number" },
      },
    },
    async run(args, c) {
      const agent = str(args.agent) ? await resolveUser(c, String(args.agent)) : null;
      const issue = str(args.issue) ? await requireIssue(c, String(args.issue)) : null;
      const rows = await c.db
        .select()
        .from(runs)
        .where(
          and(
            agent ? eq(runs.agentId, agent.id) : undefined,
            issue ? eq(runs.issueId, issue.id) : undefined,
            str(args.status) ? eq(runs.status, args.status as RunStatus) : undefined,
          ),
        )
        .orderBy(desc(runs.createdAt))
        .limit(Math.min(Math.max(num(args.limit) ?? 25, 1), 100))
        .all();
      return {
        runs: await Promise.all(
          rows.map(async (r) => {
            const issue = r.issueId ? await c.loaders.issue.load(r.issueId) : null;
            return {
              id: r.id,
              agent: (await c.loaders.user.load(r.agentId))?.name ?? null,
              issue: issue ? (await issueSummary(c, issue)).identifier : null,
              kind: r.kind,
              status: r.status,
              goal: r.goal,
              createdAt: new Date(r.createdAt).toISOString(),
            };
          }),
        ),
      };
    },
  },
  {
    name: "stop_run",
    title: "Stop run",
    description:
      "Stop a run by an agent below you in the reporting line. The reason is required: it becomes feedback for the agent.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" }, reason: { type: "string" } },
      required: ["id", "reason"],
    },
    async run(args, c) {
      const id = String(args.id);
      await c.act((s) => stopRun(s, id, String(args.reason)));
      await announce(c.deps.realtime, { type: "runs", at: Date.now() });
      const run = await c.db
        .select({ status: runs.status })
        .from(runs)
        .where(eq(runs.id, id))
        .get();
      return { id, status: run?.status };
    },
  },
];
