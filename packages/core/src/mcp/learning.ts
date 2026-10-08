import { auditEvents, REVISION_SUBJECTS, type RevisionSubject, workspaces } from "@life-os/schema";
import { and, desc, eq, lt } from "drizzle-orm";
import {
  addressFeedback,
  createFeedback,
  listFeedback,
  listRevisions,
  updateHandbook,
} from "../services/feedback.js";
import { type Tool, ToolError } from "./protocol.js";
import { type McpContext, requireIssue, resolveUser, str } from "./tools.js";

// How the company learns: feedback to act on, the handbook, versions and the history of changes.

const iso = (ms: number | null) => (ms ? new Date(ms).toISOString() : null);
const limit = (v: unknown, max: number) => Math.min(Math.max(Number(v) || 20, 1), max);

async function nameOf(c: McpContext, id: string | null) {
  if (!id) return "the hub";
  return (await c.loaders.user.load(id))?.name ?? "someone";
}

export const learningTools: Tool<McpContext>[] = [
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
        open: { type: "boolean", description: "Only feedback not yet addressed" },
        limit: { type: "number" },
      },
    },
    async run(args, c) {
      const agent = str(args.agent) ? await resolveUser(c, String(args.agent)) : null;
      const rows = await listFeedback(
        c.db,
        { agentId: agent?.id ?? null, open: args.open === true },
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
