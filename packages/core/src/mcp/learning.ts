import {
  type AuditFilter,
  auditEvents,
  REVISION_SUBJECTS,
  type RevisionSubject,
  workspaces,
} from "@life-os/schema";
import { and, desc, eq, lt } from "drizzle-orm";
import {
  addressFeedback,
  createFeedback,
  listFeedback,
  listRevisions,
  updateHandbook,
} from "../services/feedback.js";
import {
  addCounts,
  archiveMetric,
  countAll,
  createMetric,
  deriveMetrics,
  emptyCounts,
  type MetricInput,
  type Metrics,
  metricHistory,
  metricValues,
  requireMetric,
  scopeKey,
  updateMetric,
} from "../services/metrics.js";
import { updateOrganization } from "../services/organization.js";
import { type Tool, ToolError } from "./protocol.js";
import { type McpContext, requireIssue, resolveTeam, resolveUser, str } from "./tools.js";

// How the company learns: feedback to act on, the handbook, versions and the history of changes.

const iso = (ms: number | null) => (ms ? new Date(ms).toISOString() : null);
const limit = (v: unknown, max: number) => Math.min(Math.max(Number(v) || 20, 1), max);

async function nameOf(c: McpContext, id: string | null) {
  if (!id) return "the hub";
  return (await c.loaders.user.load(id))?.name ?? "someone";
}

const DAY = 86_400_000;

/** Rates as percentages and averages to one decimal, so they read well in a retro. */
function readable(m: Metrics) {
  const pct = (v: number | null) => (v === null ? null : Math.round(v * 1000) / 10);
  const one = (v: number | null) => (v === null ? null : Math.round(v * 10) / 10);
  return {
    created: m.created,
    completed: m.completed,
    cycleTimeHours: one(m.cycleTimeHours),
    slaBreaches: m.slaBreaches,
    runs: m.runs,
    runSuccessPercent: pct(m.runSuccessRate),
    stopPercent: pct(m.stopRate),
    requestsAnswered: m.requestsAnswered,
    rejectionPercent: pct(m.rejectionRate),
    tokens: m.tokens,
    tokensPerCompletedIssue:
      m.tokensPerCompletedIssue === null ? null : Math.round(m.tokensPerCompletedIssue),
  };
}

export const learningTools: Tool<McpContext>[] = [
  {
    name: "get_metrics",
    title: "Get metrics",
    description:
      "How work went: issues created and completed, cycle time, SLA breaches, runs, how often the owner stopped runs or rejected requests, and tokens used. For the company, a team or a member, over the last N days compared with the N days before. `custom` has the company's own metrics (save_metric), for the company or a member. Use it in retros to see whether a change helped.",
    readOnly: true,
    inputSchema: {
      type: "object",
      properties: {
        team: { type: "string" },
        member: { type: "string", description: 'Name, id or "me"' },
        days: { type: "number", description: "Default 7" },
        daily: { type: "boolean", description: "Also return one row per day from snapshots" },
      },
    },
    async run(args, c) {
      const team = str(args.team) ? await resolveTeam(c, String(args.team)) : null;
      const member = str(args.member) ? await resolveUser(c, String(args.member)) : null;
      if (team && member) throw new ToolError("Pass a team or a member, not both");
      const days = Math.min(Math.max(Number(args.days) || 7, 1), 180);
      const at = Date.now();
      const key = team
        ? scopeKey("team", team.id)
        : member
          ? scopeKey("user", member.id)
          : scopeKey("company");
      const [current, previous, custom] = await Promise.all([
        countAll(c.db, at - days * DAY, at),
        countAll(c.db, at - 2 * days * DAY, at - days * DAY),
        team ? [] : metricValues(c.db, at - days * DAY, at, member?.id ?? null),
      ]);
      const result: Record<string, unknown> = {
        scope: team ? `team ${team.name}` : member ? member.name : "company",
        days,
        current: readable(deriveMetrics(current.get(key) ?? emptyCounts())),
        previous: readable(deriveMetrics(previous.get(key) ?? emptyCounts())),
      };
      if (custom.length)
        result.custom = custom.map(({ metric: m, value, previousValue }) => ({
          id: m.id,
          name: m.name,
          unit: m.unit,
          target: m.target,
          direction: m.direction,
          current: value,
          previous: previousValue,
        }));
      if (args.daily === true) {
        const rows = await metricHistory(
          c.db,
          team ? "team" : member ? "user" : "company",
          team?.id ?? member?.id ?? "",
          days,
          at,
        );
        result.daily = rows.map((r) => ({
          date: r.date,
          ...readable(deriveMetrics(addCounts(emptyCounts(), r.counts))),
        }));
      }
      return result;
    },
  },
  {
    name: "save_metric",
    title: "Create or update metric",
    description:
      "Define a metric the company agreed on, or change or archive one by id. Needs metric.update. A metric counts audit log entries matching the numerator over a period, or divides that by the entries matching the denominator. Useful actions: issue.create, issue.update, issue.archive, issue.slaBreached, comment.create, run.completed, run.failed, run.stop, request.create, request.approve, request.reject, feedback.create, project.create, document.create, cycle.complete. Use get_history to see the actions that really happen.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Metric id, to update one" },
        name: { type: "string" },
        description: { type: ["string", "null"] },
        numerator: {
          type: "object",
          description: "What to count",
          properties: {
            action: { type: "string", description: "e.g. issue.create" },
            entityType: { type: "string", description: "Only entries about this, e.g. issue" },
          },
          required: ["action"],
        },
        denominator: {
          type: ["object", "null"],
          description: "What to divide by, making it a ratio; null makes it a count",
          properties: { action: { type: "string" }, entityType: { type: "string" } },
          required: ["action"],
        },
        unit: { type: ["string", "null"] },
        target: { type: ["number", "null"] },
        direction: {
          type: ["string", "null"],
          enum: ["up", "down", null],
          description: "Which way is better",
        },
        archived: { type: "boolean", description: "true stops measuring it" },
      },
    },
    async run(args, c) {
      const input: MetricInput = {
        name: str(args.name) ?? null,
        numerator: (args.numerator as AuditFilter | undefined) ?? null,
      };
      for (const key of ["description", "denominator", "unit", "target", "direction"] as const)
        if (args[key] !== undefined) Object.assign(input, { [key]: args[key] });
      let id = str(args.id);
      if (id) await c.act((s) => updateMetric(s, String(id), input));
      else id = await c.act((s) => createMetric(s, input));
      if (args.archived === true) await c.act((s) => archiveMetric(s, String(id)));
      const m = await requireMetric(c.db, id);
      return {
        id: m.id,
        name: m.name,
        numerator: m.numerator,
        denominator: m.denominator,
        unit: m.unit,
        target: m.target,
        direction: m.direction,
        archivedAt: iso(m.archivedAt),
      };
    },
  },
  {
    name: "list_feedback",
    title: "List feedback",
    description:
      "Feedback for an agent: why the owner stopped its runs, why its requests were rejected, and notes. Open ones are not yet addressed. Retros start here.",
    readOnly: true,
    inputSchema: {
      type: "object",
      properties: {
        agent: { type: "string", description: 'Name, id or "me"; all agents when omitted' },
        issue: { type: "string", description: "Only feedback about this issue, e.g. FIN-12" },
        open: { type: "boolean", description: "Only feedback not yet addressed" },
        limit: { type: "number" },
      },
    },
    async run(args, c) {
      const agent = str(args.agent) ? await resolveUser(c, String(args.agent)) : null;
      const issue = str(args.issue) ? await requireIssue(c, String(args.issue)) : null;
      const rows = await listFeedback(
        c.db,
        { agentId: agent?.id ?? null, issueId: issue?.id ?? null, open: args.open === true },
        limit(args.limit, 200),
      );
      return Promise.all(
        rows.map(async (f) => ({
          id: f.id,
          agent: await nameOf(c, f.agentId),
          kind: f.kind,
          body: f.body,
          from: await nameOf(c, f.authorId),
          runId: f.runId,
          issueId: f.issueId,
          requestId: f.requestId,
          createdAt: iso(f.createdAt),
          addressedAt: iso(f.addressedAt),
          addressedNote: f.addressedNote,
        })),
      );
    },
  },
  {
    name: "give_feedback",
    title: "Give feedback",
    description: "Leave an agent a note to learn from. The owner and the agent's manager can.",
    inputSchema: {
      type: "object",
      properties: {
        agent: { type: "string", description: "Name or id" },
        body: { type: "string" },
        issue: { type: "string", description: "Issue it is about, e.g. FIN-12" },
      },
      required: ["agent", "body"],
    },
    async run(args, c) {
      const agent = await resolveUser(c, String(args.agent));
      const issue = str(args.issue) ? await requireIssue(c, String(args.issue)) : null;
      const id = await c.act((s) =>
        createFeedback(s, { agentId: agent.id, body: String(args.body), issueId: issue?.id }),
      );
      return { id };
    },
  },
  {
    name: "address_feedback",
    title: "Address feedback",
    description:
      "Mark feedback as acted on and say what changed, e.g. 'Added a lesson: check receipts before paying'. Change the lesson, charter or handbook first.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" }, note: { type: "string" } },
      required: ["id", "note"],
    },
    async run(args, c) {
      const id = await c.act((s) => addressFeedback(s, String(args.id), String(args.note)));
      return { id, addressed: true };
    },
  },
  {
    name: "get_handbook",
    title: "Get handbook",
    description: "The company handbook: how the company works. Every agent reads it on each run.",
    readOnly: true,
    inputSchema: { type: "object", properties: {} },
    async run(_args, c) {
      const company = await c.db.select().from(workspaces).get();
      return { handbook: company?.handbook ?? "" };
    },
  },
  {
    name: "update_handbook",
    title: "Update handbook",
    description:
      "Replace the company handbook (markdown). Needs handbook.update. Keep what still holds, and say why in the reason.",
    inputSchema: {
      type: "object",
      properties: { handbook: { type: "string" } },
      required: ["handbook"],
    },
    async run(args, c) {
      await c.act((s) => updateHandbook(s, String(args.handbook)));
      return { updated: true };
    },
  },
  {
    name: "update_organization",
    title: "Update company",
    description:
      "Rename the company or set its time zone (IANA, e.g. Europe/Berlin). Needs organization.update.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string" }, timezone: { type: "string" } },
    },
    async run(args, c) {
      await c.act((s) =>
        updateOrganization(s, {
          name: str(args.name) ?? null,
          timezone: str(args.timezone) ?? null,
        }),
      );
      const company = await c.db.select().from(workspaces).get();
      return { name: company?.name, timezone: company?.timezone };
    },
  },
  {
    name: "list_revisions",
    title: "List revisions",
    description:
      "Past versions of a charter, an agent's lessons or the handbook, newest first, with who changed it and why.",
    readOnly: true,
    inputSchema: {
      type: "object",
      properties: {
        subject: { type: "string", enum: [...REVISION_SUBJECTS] },
        agent: { type: "string", description: "Whose charter or lessons; not for the handbook" },
        limit: { type: "number" },
      },
      required: ["subject"],
    },
    async run(args, c) {
      const subject = String(args.subject) as RevisionSubject;
      if (!REVISION_SUBJECTS.includes(subject))
        throw new ToolError(`Subject is one of ${REVISION_SUBJECTS.join(", ")}`);
      let entityId: string;
      if (subject === "handbook") {
        const company = await c.db.select().from(workspaces).get();
        entityId = company?.id ?? "";
      } else {
        if (!str(args.agent)) throw new ToolError("Say whose charter or lessons");
        entityId = (await resolveUser(c, String(args.agent))).id;
      }
      const rows = await listRevisions(c.db, subject, entityId, limit(args.limit, 100));
      return Promise.all(
        rows.map(async (r) => ({
          id: r.id,
          content: r.content,
          by: await nameOf(c, r.authorId),
          reason: r.reason,
          runId: r.runId,
          createdAt: iso(r.createdAt),
        })),
      );
    },
  },
  {
    name: "get_history",
    title: "Get history",
    description:
      "What changed, newest first: every change in the company is recorded with who made it and why. Filter by issue, by member (what they changed), or by entity type and id.",
    readOnly: true,
    inputSchema: {
      type: "object",
      properties: {
        issue: { type: "string", description: "e.g. FIN-12" },
        actor: { type: "string", description: "Who made the changes" },
        entityType: { type: "string", description: "e.g. issue, project, user, template" },
        entityId: { type: "string" },
        before: { type: "string", description: "ISO time; only older changes" },
        limit: { type: "number" },
      },
    },
    async run(args, c) {
      const issue = str(args.issue) ? await requireIssue(c, String(args.issue)) : null;
      const actor = str(args.actor) ? await resolveUser(c, String(args.actor)) : null;
      const before = str(args.before) ? Date.parse(String(args.before)) : Number.NaN;
      const entityType = issue ? "issue" : str(args.entityType);
      const entityId = issue?.id ?? str(args.entityId);
      const rows = await c.db
        .select()
        .from(auditEvents)
        .where(
          and(
            entityType ? eq(auditEvents.entityType, entityType) : undefined,
            entityId ? eq(auditEvents.entityId, entityId) : undefined,
            actor ? eq(auditEvents.actorId, actor.id) : undefined,
            Number.isNaN(before) ? undefined : lt(auditEvents.createdAt, before),
          ),
        )
        .orderBy(desc(auditEvents.createdAt), desc(auditEvents.id))
        .limit(limit(args.limit, 100))
        .all();
      return Promise.all(
        rows.map(async (e) => ({
          at: iso(e.createdAt),
          by: await nameOf(c, e.actorId),
          action: e.action,
          entityType: e.entityType,
          entityId: e.entityId,
          data: e.data,
          reason: e.reason,
          runId: e.runId,
        })),
      );
    },
  },
];
