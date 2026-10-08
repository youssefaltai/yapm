import {
  comments,
  cycles,
  grants,
  ISSUE_RELATION_TYPES,
  issues,
  labels,
  notifications,
  PRIORITY_LABELS,
  projectMilestones,
  projects,
  requests,
  teams,
  users,
  workflowStates,
} from "@life-os/schema";
import { and, asc, desc, eq, isNull, or, type SQL, sql } from "drizzle-orm";
import type { User } from "../context.js";
import type { HubDb } from "../db.js";
import { type IssueFilterShape, queryIssues } from "../graphql/filters.js";
import type { Loaders } from "../loaders.js";
import { createComment, createReaction } from "../services/comments.js";
import type { Ctx } from "../services/common.js";
import {
  createIssue,
  createRelation,
  findIssue,
  type IssueRow,
  updateIssue,
} from "../services/issues.js";
import { createLabel } from "../services/labels.js";
import { archiveNotification, inInbox, updateNotification } from "../services/notifications.js";
import { cancelRequest, checkPermission, createRequest } from "../services/requests.js";
import { createTeam } from "../services/teams.js";
import { hireAgent, retireAgent, updateUser } from "../services/users.js";
import { type Tool, ToolError } from "./protocol.js";

export interface McpContext {
  db: HubDb;
  viewer: User;
  loaders: Loaders;
  /** The web app's origin, for issue links. */
  appUrl: string;
  /** Runs a change as the viewer: audit entry, live update and error mapping included. */
  act<T>(fn: (service: Ctx) => Promise<T>): Promise<T>;
}

export type Args = Record<string, unknown>;
export const str = (v: unknown) => (typeof v === "string" ? v : undefined);
export const num = (v: unknown) => (typeof v === "number" ? v : undefined);

// Name resolution: agents say "Finance", "me", "In Progress" or "Bills", like they would in Linear's MCP.

export async function resolveTeam(c: McpContext, ref: string) {
  const row = await c.db
    .select()
    .from(teams)
    .where(
      or(
        eq(teams.id, ref),
        eq(teams.key, ref.toUpperCase()),
        sql`lower(${teams.name}) = ${ref.toLowerCase()}`,
      ),
    )
    .get();
  if (!row) throw new ToolError(`No team matches "${ref}". Use list_teams to see them.`);
  return row;
}

export async function resolveUser(c: McpContext, ref: string) {
  if (ref.toLowerCase() === "me") return c.viewer;
  const row = await c.db
    .select()
    .from(users)
    .where(
      and(
        eq(users.active, true),
        or(
          eq(users.id, ref),
          sql`lower(${users.name}) = ${ref.toLowerCase()}`,
          sql`lower(${users.email}) = ${ref.toLowerCase()}`,
        ),
      ),
    )
    .get();
  if (!row) throw new ToolError(`No member matches "${ref}". Use list_users to see them.`);
  return row;
}

async function resolveState(c: McpContext, teamId: string, ref: string) {
  const states = await c.db
    .select()
    .from(workflowStates)
    .where(eq(workflowStates.teamId, teamId))
    .orderBy(asc(workflowStates.position))
    .all();
  const lower = ref.toLowerCase();
  const state =
    states.find((s) => s.id === ref) ??
    states.find((s) => s.name.toLowerCase() === lower) ??
    states.find((s) => s.type === lower);
  if (!state)
    throw new ToolError(
      `No status "${ref}" in this team. Options: ${states.map((s) => s.name).join(", ")}`,
    );
  return state;
}

async function resolveLabels(c: McpContext, teamId: string, refs: string[]) {
  const available = await c.db
    .select()
    .from(labels)
    .where(or(eq(labels.teamId, teamId), isNull(labels.teamId)))
    .all();
  return refs.map((ref) => {
    const label = available.find((l) => l.id === ref || l.name.toLowerCase() === ref.toLowerCase());
    if (!label)
      throw new ToolError(
        `No label "${ref}" for this team. Create it with create_issue_label first.`,
      );
    return label.id;
  });
}

export async function resolveProject(c: McpContext, ref: string) {
  const row = await c.db
    .select()
    .from(projects)
    .where(or(eq(projects.id, ref), sql`lower(${projects.name}) = ${ref.toLowerCase()}`))
    .get();
  if (!row) throw new ToolError(`No project matches "${ref}". Use list_projects to see them.`);
  return row;
}

export async function resolveMilestone(c: McpContext, ref: string, projectId: string | null) {
  const rows = await c.db
    .select()
    .from(projectMilestones)
    .where(
      or(
        eq(projectMilestones.id, ref),
        sql`lower(${projectMilestones.name}) = ${ref.toLowerCase()}`,
      ),
    )
    .all();
  const row = rows.find((m) => m.id === ref) ?? rows.find((m) => m.projectId === projectId);
  if (!row)
    throw new ToolError(
      `No milestone "${ref}"${projectId ? " in that project" : ""}. Use get_project to see them.`,
    );
  return row;
}

/** A team's cycle by "current", "next", number or id. */
export async function resolveCycle(c: McpContext, teamId: string, ref: string) {
  const rows = await c.db
    .select()
    .from(cycles)
    .where(eq(cycles.teamId, teamId))
    .orderBy(asc(cycles.number))
    .all();
  const at = Date.now();
  const key = ref.trim().toLowerCase();
  const open = rows.filter((r) => !r.completedAt && r.endsAt > at);
  const row =
    key === "current" || key === "active"
      ? open.find((r) => r.startsAt <= at)
      : key === "next" || key === "upcoming"
        ? open.find((r) => r.startsAt > at)
        : rows.find((r) => r.id === ref || String(r.number) === key.replace(/^cycle\s*/, ""));
  if (!row)
    throw new ToolError(
      rows.length
        ? `No cycle "${ref}" in that team. Use list_cycles to see them.`
        : "That team doesn't use cycles. The owner can turn them on in the team's settings.",
    );
  return row;
}

export async function requireIssue(c: McpContext, ref: string) {
  const issue = await findIssue(c.db, ref);
  if (!issue) throw new ToolError(`No issue matches "${ref}".`);
  return issue;
}

function priority(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  const n =
    typeof value === "string"
      ? PRIORITY_LABELS.findIndex((p) => p.toLowerCase() === value.toLowerCase())
      : Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 4) {
    throw new ToolError("Priority is 0 (none), 1 (urgent), 2 (high), 3 (medium) or 4 (low)");
  }
  return n;
}

// Compact shapes for the model: names over ids where it helps, ids where it needs them.

export async function issueSummary(c: McpContext, issue: IssueRow) {
  const [team, state, assignee, issueLabels, project, milestone, cycle] = await Promise.all([
    c.loaders.team.load(issue.teamId),
    c.loaders.state.load(issue.stateId),
    issue.assigneeId ? c.loaders.user.load(issue.assigneeId) : null,
    c.loaders.labelsByIssue.load(issue.id),
    issue.projectId ? c.loaders.project.load(issue.projectId) : null,
    issue.projectMilestoneId ? c.loaders.projectMilestone.load(issue.projectMilestoneId) : null,
    issue.cycleId ? c.loaders.cycle.load(issue.cycleId) : null,
  ]);
  const identifier = `${team?.key}-${issue.number}`;
  return {
    id: issue.id,
    identifier,
    title: issue.title,
    url: `${c.appUrl}/issue/${identifier}`,
    team: team?.name,
    status: state?.name,
    statusType: state?.type,
    priority: PRIORITY_LABELS[issue.priority],
    assignee: assignee?.name ?? null,
    labels: issueLabels.map((l) => l.name),
    estimate: issue.estimate,
    dueDate: issue.dueDate,
    project: project?.name ?? null,
    milestone: milestone?.name ?? null,
    cycle: cycle?.number ?? null,
    parentId: issue.parentId,
    createdAt: new Date(issue.createdAt).toISOString(),
    updatedAt: new Date(issue.updatedAt).toISOString(),
    archivedAt: issue.archivedAt ? new Date(issue.archivedAt).toISOString() : null,
  };
}

async function issueDetail(c: McpContext, issue: IssueRow) {
  const [summary, creator, parent, children, relations, inverse, commentCount] = await Promise.all([
    issueSummary(c, issue),
    issue.creatorId ? c.loaders.user.load(issue.creatorId) : null,
    issue.parentId ? c.loaders.issue.load(issue.parentId) : null,
    c.loaders.childrenByIssue.load(issue.id),
    c.loaders.relationsByIssue.load(issue.id),
    c.loaders.inverseRelationsByIssue.load(issue.id),
    c.loaders.commentsByIssue.load(issue.id),
  ]);
  const ref = async (id: string) => {
    const other = await c.loaders.issue.load(id);
    const team = other ? await c.loaders.team.load(other.teamId) : null;
    return other ? `${team?.key}-${other.number} ${other.title}` : id;
  };
  return {
    ...summary,
    description: issue.description,
    creator: creator?.name ?? null,
    parent: parent ? await ref(parent.id) : null,
    subIssues: await Promise.all(
      children.map(async (child) => `${(await issueSummary(c, child)).identifier} ${child.title}`),
    ),
    relations: [
      ...(await Promise.all(
        relations.map(async (r) => ({
          id: r.id,
          type: r.type,
          issue: await ref(r.relatedIssueId),
        })),
      )),
      ...(await Promise.all(
        inverse.map(async (r) => ({
          id: r.id,
          type:
            r.type === "blocks" ? "blocked_by" : r.type === "duplicate" ? "duplicated_by" : r.type,
          issue: await ref(r.issueId),
        })),
      )),
    ],
    commentCount: commentCount.length,
  };
}

const issueFields = {
  title: { type: "string", description: "Issue title" },
  description: { type: "string", description: "Markdown description" },
  assignee: { type: ["string", "null"], description: 'Member name, id, or "me"; null to unassign' },
  state: {
    type: "string",
    description: 'Status name (e.g. "In Progress"), id, or type (e.g. "started")',
  },
  priority: {
    type: ["integer", "string"],
    description: "0 none, 1 urgent, 2 high, 3 medium, 4 low (or the name)",
  },
  estimate: { type: ["integer", "null"], description: "Points" },
  labels: {
    type: "array",
    items: { type: "string" },
    description: "Label names or ids; replaces all labels",
  },
  parentId: {
    type: ["string", "null"],
    description: "Parent issue id or identifier, for sub-issues",
  },
  dueDate: { type: ["string", "null"], description: "YYYY-MM-DD" },
  project: { type: ["string", "null"], description: "Project name or id; null to remove" },
  milestone: {
    type: ["string", "null"],
    description: "Milestone name (in the issue's project) or id; null to remove",
  },
  cycle: {
    type: ["string", "integer", "null"],
    description: 'Cycle: "current", "next", its number, or id; null to remove',
  },
} as const;

async function issueInput(c: McpContext, args: Args, teamId: string) {
  const input: Record<string, unknown> = {};
  if (args.title !== undefined) input.title = str(args.title);
  if (args.description !== undefined) input.description = str(args.description) ?? null;
  if (args.assignee !== undefined)
    input.assigneeId = args.assignee ? (await resolveUser(c, String(args.assignee))).id : null;
  if (args.state !== undefined)
    input.stateId = (await resolveState(c, teamId, String(args.state))).id;
  if (args.priority !== undefined) input.priority = priority(args.priority);
  if (args.estimate !== undefined) input.estimate = num(args.estimate) ?? null;
  if (args.labels !== undefined)
    input.labelIds = await resolveLabels(c, teamId, (args.labels as unknown[]).map(String));
  if (args.parentId !== undefined)
    input.parentId = args.parentId ? (await requireIssue(c, String(args.parentId))).id : null;
  if (args.dueDate !== undefined) input.dueDate = str(args.dueDate) ?? null;
  if (args.project !== undefined)
    input.projectId = args.project ? (await resolveProject(c, String(args.project))).id : null;
  if (args.milestone !== undefined) {
    const projectId =
      (input.projectId as string | null | undefined) ??
      (args.issueId ? (await requireIssue(c, String(args.issueId))).projectId : null);
    input.projectMilestoneId = args.milestone
      ? (await resolveMilestone(c, String(args.milestone), projectId ?? null)).id
      : null;
  }
  if (args.cycle !== undefined)
    input.cycleId =
      args.cycle === null ? null : (await resolveCycle(c, teamId, String(args.cycle))).id;
  return input;
}

export const limitArg = { type: "integer", description: "Maximum results (default 50, max 250)" };

/**
 * Tools named and shaped after Linear's official MCP server, so agents already know them,
 * plus a few extensions for things Linear's server lacks (relations, reactions, teams).
 */
export const tools: Tool<McpContext>[] = [
  {
    name: "list_teams",
    title: "List teams",
    description: "List the company's teams.",
    readOnly: true,
    inputSchema: {
      type: "object",
      properties: { query: { type: "string", description: "Filter by name or key" } },
    },
    async run(args, c) {
      const q = str(args.query)?.toLowerCase();
      const rows = await c.db
        .select()
        .from(teams)
        .where(isNull(teams.archivedAt))
        .orderBy(asc(teams.name))
        .all();
      return rows
        .filter((t) => !q || t.name.toLowerCase().includes(q) || t.key.toLowerCase().includes(q))
        .map((t) => ({ id: t.id, key: t.key, name: t.name, description: t.description }));
    },
  },
  {
    name: "get_team",
    title: "Get team",
    description: "Get a team by id, key or name, with its statuses and members.",
    readOnly: true,
    inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    async run(args, c) {
      const team = await resolveTeam(c, String(args.query));
      const [states, lead] = await Promise.all([
        c.loaders.statesByTeam.load(team.id),
        team.leadId ? c.loaders.user.load(team.leadId) : null,
      ]);
      return {
        id: team.id,
        key: team.key,
        name: team.name,
        description: team.description,
        lead: lead?.name ?? null,
        statuses: states.map((s) => ({ id: s.id, name: s.name, type: s.type })),
      };
    },
  },
  {
    name: "create_team",
    title: "Create team",
    description:
      "Create a team (a unit of the company) with the default workflow. Only when real work needs one.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        key: {
          type: "string",
          description: "Identifier prefix, e.g. FIN; defaults to the initials",
        },
        description: { type: "string" },
        lead: { type: "string", description: "Member name or id" },
      },
      required: ["name"],
    },
    async run(args, c) {
      const leadId = args.lead ? (await resolveUser(c, String(args.lead))).id : null;
      const id = await c.act((s) =>
        createTeam(s, {
          name: String(args.name),
          key: str(args.key) ?? null,
          description: str(args.description) ?? null,
          leadId,
        }),
      );
      const team = await c.db.select().from(teams).where(eq(teams.id, id)).get();
      return { id, key: team?.key, name: team?.name };
    },
  },
  {
    name: "list_users",
    title: "List users",
    description:
      "List the company's members: the owner and the AI agents, with titles and managers.",
    readOnly: true,
    inputSchema: {
      type: "object",
      properties: { query: { type: "string", description: "Filter by name or title" } },
    },
    async run(args, c) {
      const q = str(args.query)?.toLowerCase();
      const rows = await c.db
        .select()
        .from(users)
        .where(eq(users.active, true))
        .orderBy(asc(users.createdAt))
        .all();
      const names = new Map(rows.map((u) => [u.id, u.name]));
      return rows
        .filter(
          (u) =>
            !q || u.name.toLowerCase().includes(q) || (u.title ?? "").toLowerCase().includes(q),
        )
        .map((u) => ({
          id: u.id,
          name: u.name,
          kind: u.kind,
          title: u.title,
          manager: u.managerId ? (names.get(u.managerId) ?? null) : null,
          isMe: u.id === c.viewer.id,
        }));
    },
  },
  {
    name: "get_user",
    title: "Get user",
    description: 'Get a member by id or name, or "me". Agents include their charter and lessons.',
    readOnly: true,
    inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    async run(args, c) {
      const u = await resolveUser(c, String(args.query));
      const manager = u.managerId ? await c.loaders.user.load(u.managerId) : null;
      return {
        id: u.id,
        name: u.name,
        kind: u.kind,
        title: u.title,
        manager: manager?.name ?? null,
        charter: u.charter,
        lessons: u.lessons,
      };
    },
  },
  {
    name: "list_issue_statuses",
    title: "List issue statuses",
    description: "List a team's workflow statuses, in order.",
    readOnly: true,
    inputSchema: {
      type: "object",
      properties: { team: { type: "string", description: "Team name, key or id" } },
      required: ["team"],
    },
    async run(args, c) {
      const team = await resolveTeam(c, String(args.team));
      return (await c.loaders.statesByTeam.load(team.id)).map((s) => ({
        id: s.id,
        name: s.name,
        type: s.type,
      }));
    },
  },
  {
    name: "list_issue_labels",
    title: "List issue labels",
    description:
      "List labels: a team's own plus workspace-wide ones, or all labels without a team.",
    readOnly: true,
    inputSchema: { type: "object", properties: { team: { type: "string" } } },
    async run(args, c) {
      const team = args.team ? await resolveTeam(c, String(args.team)) : null;
      const rows = await c.db
        .select()
        .from(labels)
        .where(team ? or(eq(labels.teamId, team.id), isNull(labels.teamId)) : undefined)
        .orderBy(asc(labels.name))
        .all();
      return rows.map((l) => ({
        id: l.id,
        name: l.name,
        color: l.color,
        description: l.description,
        teamId: l.teamId,
      }));
    },
  },
  {
    name: "create_issue_label",
    title: "Create issue label",
    description: "Create a label, for a team or the whole workspace.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        color: { type: "string", description: "Hex color, e.g. #5e6ad2" },
        description: { type: "string" },
        team: { type: "string", description: "Team name, key or id; leave out for workspace-wide" },
      },
      required: ["name"],
    },
    async run(args, c) {
      const teamId = args.team ? (await resolveTeam(c, String(args.team))).id : null;
      const id = await c.act((s) =>
        createLabel(s, {
          name: String(args.name),
          color: str(args.color) ?? null,
          description: str(args.description) ?? null,
          teamId,
        }),
      );
      return { id, name: args.name };
    },
  },
  {
    name: "list_issues",
    title: "List issues",
    description:
      "List issues, newest first, filtered by team, assignee, status, label, priority or text.",
    readOnly: true,
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Text in the title or description" },
        team: { type: "string", description: "Team name, key or id" },
        assignee: { type: "string", description: 'Member name or id, "me", or "none"' },
        state: { type: "string", description: "Status name, or a type like started or completed" },
        label: { type: "string", description: "Label name" },
        priority: { type: ["integer", "string"] },
        parentId: { type: "string", description: "Only sub-issues of this issue" },
        includeArchived: { type: "boolean" },
        orderBy: { type: "string", enum: ["createdAt", "updatedAt"] },
        limit: limitArg,
        cursor: { type: "string", description: "nextCursor from a previous page" },
      },
    },
    async run(args, c) {
      const and_: IssueFilterShape[] = [];
      let scope: SQL | undefined;
      if (args.team)
        and_.push({ team: { id: { eq: (await resolveTeam(c, String(args.team))).id } } });
      if (args.assignee) {
        const ref = String(args.assignee);
        and_.push(
          ref.toLowerCase() === "none"
            ? { assignee: { null: true } }
            : { assignee: { id: { eq: (await resolveUser(c, ref)).id } } },
        );
      }
      if (args.state) {
        const s = String(args.state);
        and_.push({
          or: [{ state: { name: { eq: s } } }, { state: { type: { eq: s.toLowerCase() } } }],
        });
      }
      if (args.label) and_.push({ labels: { some: { name: { eq: String(args.label) } } } });
      if (args.priority !== undefined)
        and_.push({ priority: { eq: priority(args.priority) ?? 0 } });
      if (args.parentId)
        and_.push({ parent: { id: { eq: (await requireIssue(c, String(args.parentId))).id } } });
      if (args.query) {
        const like = `%${String(args.query)
          .toLowerCase()
          .replace(/[%_\\]/g, "\\$&")}%`;
        scope = sql`(lower(${issues.title}) like ${like} escape '\\' or lower(coalesce(${issues.description}, '')) like ${like} escape '\\')`;
      }
      const page = await queryIssues(
        c.db,
        {
          filter: and_.length ? { and: and_ } : null,
          first: num(args.limit) ?? 50,
          after: str(args.cursor) ?? null,
          orderBy: args.orderBy === "createdAt" ? "createdAt" : "updatedAt",
          includeArchived: args.includeArchived === true,
        },
        c.viewer.id,
        scope,
      );
      return {
        issues: await Promise.all(page.nodes.map((issue) => issueSummary(c, issue))),
        nextCursor: page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null,
      };
    },
  },
  {
    name: "list_my_issues",
    title: "List my issues",
    description:
      "List issues assigned to you, most recently updated first. Done and canceled ones are left out unless asked.",
    readOnly: true,
    inputSchema: {
      type: "object",
      properties: { includeCompleted: { type: "boolean" }, limit: limitArg },
    },
    async run(args, c) {
      const page = await queryIssues(
        c.db,
        {
          filter: args.includeCompleted
            ? null
            : { state: { type: { nin: ["completed", "canceled"] } } },
          first: num(args.limit) ?? 50,
          orderBy: "updatedAt",
        },
        c.viewer.id,
        eq(issues.assigneeId, c.viewer.id),
      );
      return Promise.all(page.nodes.map((issue) => issueSummary(c, issue)));
    },
  },
  {
    name: "get_issue",
    title: "Get issue",
    description:
      "Get an issue by id or identifier (e.g. FIN-42): description, sub-issues, relations and more.",
    readOnly: true,
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    async run(args, c) {
      return issueDetail(c, await requireIssue(c, String(args.id)));
    },
  },
  {
    name: "create_issue",
    title: "Create issue",
    description: "Create an issue in a team. It starts in Backlog unless a status is given.",
    inputSchema: {
      type: "object",
      properties: { ...issueFields, team: { type: "string", description: "Team name, key or id" } },
      required: ["title", "team"],
    },
    async run(args, c) {
      const team = await resolveTeam(c, String(args.team));
      const input = await issueInput(c, args, team.id);
      const id = await c.act((s) =>
        createIssue(s, {
          ...(input as object),
          teamId: team.id,
          title: String(args.title),
        } as Parameters<typeof createIssue>[1]),
      );
      return issueSummary(c, await requireIssue(c, id));
    },
  },
  {
    name: "update_issue",
    title: "Update issue",
    description:
      "Update an issue's title, description, status, assignee, priority, estimate, labels, parent, due date, project or milestone.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "Issue id or identifier" }, ...issueFields },
      required: ["id"],
    },
    async run(args, c) {
      const issue = await requireIssue(c, String(args.id));
      const { id: _id, ...rest } = args;
      const input = await issueInput(c, { ...rest, issueId: issue.id }, issue.teamId);
      await c.act((s) => updateIssue(s, issue.id, input));
      c.loaders.issue.clear(issue.id);
      c.loaders.labelsByIssue.clear(issue.id);
      return issueSummary(c, await requireIssue(c, issue.id));
    },
  },
  {
    name: "list_comments",
    title: "List comments",
    description: "List an issue's comments, oldest first. Replies carry their parentId.",
    readOnly: true,
    inputSchema: {
      type: "object",
      properties: { issueId: { type: "string" } },
      required: ["issueId"],
    },
    async run(args, c) {
      const issue = await requireIssue(c, String(args.issueId));
      const rows = await c.db
        .select()
        .from(comments)
        .where(eq(comments.issueId, issue.id))
        .orderBy(asc(comments.createdAt))
        .all();
      const authors = await c.loaders.user.loadMany([...new Set(rows.map((r) => r.userId))]);
      const names = new Map(
        authors.flatMap((a) => (a && !(a instanceof Error) ? [[a.id, a.name] as const] : [])),
      );
      return rows.map((r) => ({
        id: r.id,
        author: names.get(r.userId) ?? null,
        body: r.body,
        parentId: r.parentId,
        createdAt: new Date(r.createdAt).toISOString(),
      }));
    },
  },
  {
    name: "create_comment",
    title: "Create comment",
    description: "Comment on an issue, or reply to a comment thread with parentId.",
    inputSchema: {
      type: "object",
      properties: {
        issueId: { type: "string", description: "Issue id or identifier" },
        body: { type: "string", description: "Markdown" },
        parentId: { type: "string", description: "The top comment of the thread to reply in" },
      },
      required: ["issueId", "body"],
    },
    async run(args, c) {
      const issue = await requireIssue(c, String(args.issueId));
      const id = await c.act((s) =>
        createComment(s, {
          issueId: issue.id,
          body: String(args.body),
          parentId: str(args.parentId) ?? null,
        }),
      );
      return { id };
    },
  },
  {
    name: "create_reaction",
    title: "React",
    description:
      "React to a comment or an issue with an emoji: a cheap way to acknowledge without a reply.",
    inputSchema: {
      type: "object",
      properties: {
        emoji: { type: "string" },
        commentId: { type: "string" },
        issueId: { type: "string" },
      },
      required: ["emoji"],
    },
    async run(args, c) {
      const issueId = args.issueId ? (await requireIssue(c, String(args.issueId))).id : null;
      const id = await c.act((s) =>
        createReaction(s, {
          emoji: String(args.emoji),
          commentId: str(args.commentId) ?? null,
          issueId,
        }),
      );
      return { id };
    },
  },
  {
    name: "create_issue_relation",
    title: "Relate issues",
    description: "Mark that one issue blocks, duplicates or relates to another.",
    inputSchema: {
      type: "object",
      properties: {
        issueId: { type: "string", description: "The issue that blocks / duplicates / relates" },
        relatedIssueId: { type: "string" },
        type: { type: "string", enum: [...ISSUE_RELATION_TYPES] },
      },
      required: ["issueId", "relatedIssueId", "type"],
    },
    async run(args, c) {
      const type = String(args.type);
      if (!(ISSUE_RELATION_TYPES as readonly string[]).includes(type))
        throw new ToolError("type is blocks, duplicate or related");
      const issue = await requireIssue(c, String(args.issueId));
      const related = await requireIssue(c, String(args.relatedIssueId));
      const id = await c.act((s) =>
        createRelation(s, {
          issueId: issue.id,
          relatedIssueId: related.id,
          type: type as (typeof ISSUE_RELATION_TYPES)[number],
        }),
      );
      return { id };
    },
  },
  {
    name: "hire_agent",
    title: "Hire agent",
    description:
      "Hire an AI agent employee with a title, a manager and a charter (its job: what it owns, how it works, when it escalates). Needs the agent.hire permission; ask with create_request if you don't have it.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        title: { type: "string" },
        charter: { type: "string", description: "Markdown" },
        manager: { type: "string", description: 'Who it reports to: a name, id or "me"' },
      },
      required: ["name", "charter"],
    },
    async run(args, c) {
      const manager = str(args.manager) ? await resolveUser(c, String(args.manager)) : null;
      const id = await c.act((s) =>
        hireAgent(s, {
          name: String(args.name),
          title: str(args.title) ?? null,
          charter: str(args.charter) ?? null,
          managerId: manager?.id ?? null,
        }),
      );
      return { id, name: String(args.name) };
    },
  },
  {
    name: "update_user",
    title: "Update member",
    description:
      "Change a member's name, title, manager, charter or lessons. You may rename yourself and rewrite your own lessons freely; changing others needs user.update, charters need charter.update and someone else's lessons need lessons.update. Lessons replace the old text, so keep what still holds.",
    inputSchema: {
      type: "object",
      properties: {
        user: { type: "string", description: 'Name, id or "me"' },
        name: { type: "string" },
        title: { type: "string" },
        charter: { type: "string" },
        lessons: {
          type: "string",
          description: "What the agent has learned, in markdown. Read on every run.",
        },
        manager: { type: "string" },
      },
      required: ["user"],
    },
    async run(args, c) {
      const user = await resolveUser(c, String(args.user));
      const manager = str(args.manager) ? await resolveUser(c, String(args.manager)) : undefined;
      await c.act((s) =>
        updateUser(s, user.id, {
          ...(str(args.name) !== undefined ? { name: str(args.name) } : {}),
          ...(str(args.title) !== undefined ? { title: str(args.title) } : {}),
          ...(str(args.charter) !== undefined ? { charter: str(args.charter) } : {}),
          ...(str(args.lessons) !== undefined ? { lessons: str(args.lessons) } : {}),
          ...(manager ? { managerId: manager.id } : {}),
        }),
      );
      return { id: user.id };
    },
  },
  {
    name: "retire_agent",
    title: "Retire agent",
    description:
      "Retire an agent: its tokens stop working and its reports move to its manager. Needs agent.retire.",
    inputSchema: {
      type: "object",
      properties: { user: { type: "string", description: "Name or id" } },
      required: ["user"],
    },
    async run(args, c) {
      const user = await resolveUser(c, String(args.user));
      await c.act((s) => retireAgent(s, user.id));
      return { id: user.id, retired: true };
    },
  },
  {
    name: "check_permission",
    title: "Check permission",
    description:
      "Check whether you may do something now, without using anything up. Org changes use their names (team.create, agent.hire, agent.retire, user.update, charter.update); other actions use your own names, e.g. tool:Bash or spend.",
    readOnly: true,
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string" },
        resource: { type: "string", description: "What it applies to, if specific" },
      },
      required: ["action"],
    },
    async run(args, c) {
      return checkPermission(c.db, c.viewer.id, String(args.action), str(args.resource) ?? null);
    },
  },
  {
    name: "create_request",
    title: "Ask for approval",
    description:
      "Ask the owner for permission to do something you aren't allowed to do yet. The owner approves once, always allows it, or rejects it with a reason. Then poll get_request (or wait for its answer) before acting. Asking again while one is pending returns the pending one.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: 'In a few words, e.g. "Hire a Head of Fitness"' },
        action: { type: "string", description: "The permission, e.g. agent.hire or tool:Bash" },
        resource: { type: "string", description: "What it applies to, if specific" },
        reason: { type: "string", description: "Why you need it" },
        details: { type: "string", description: "Markdown: exactly what you will do" },
        issue: { type: "string", description: "The issue you are working on, e.g. PF-3" },
      },
      required: ["title", "action", "reason"],
    },
    async run(args, c) {
      const issue = str(args.issue) ? await requireIssue(c, String(args.issue)) : null;
      const id = await c.act((s) =>
        createRequest(s, {
          title: String(args.title),
          action: String(args.action),
          resource: str(args.resource) ?? null,
          reason: String(args.reason),
          details: str(args.details) ?? null,
          issueId: issue?.id ?? null,
        }),
      );
      return requestSummary(c, id);
    },
  },
  {
    name: "get_request",
    title: "Get request",
    description:
      "A request's status (pending, approved, rejected, canceled) and the owner's answer. A one-time approval is used up by the action it allows.",
    readOnly: true,
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    async run(args, c) {
      return requestSummary(c, String(args.id));
    },
  },
  {
    name: "list_requests",
    title: "List requests",
    description: "Requests, newest first. Defaults to your own.",
    readOnly: true,
    inputSchema: {
      type: "object",
      properties: {
        requester: { type: "string", description: 'Name, id, "me" (default) or "anyone"' },
        status: { type: "string", enum: ["pending", "approved", "rejected", "canceled"] },
        limit: { type: "number" },
      },
    },
    async run(args, c) {
      const who = str(args.requester) ?? "me";
      const requester = who.toLowerCase() === "anyone" ? null : await resolveUser(c, who);
      const status = str(args.status) as (typeof requests.$inferSelect)["status"] | undefined;
      const rows = await c.db
        .select({ id: requests.id })
        .from(requests)
        .where(
          and(
            requester ? eq(requests.requesterId, requester.id) : undefined,
            status ? eq(requests.status, status) : undefined,
          ),
        )
        .orderBy(desc(requests.createdAt))
        .limit(Math.min(Math.max(num(args.limit) ?? 25, 1), 100))
        .all();
      return { requests: await Promise.all(rows.map((r) => requestSummary(c, r.id))) };
    },
  },
  {
    name: "cancel_request",
    title: "Cancel request",
    description: "Withdraw your pending request, e.g. when you no longer need it.",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    async run(args, c) {
      await c.act((s) => cancelRequest(s, String(args.id)));
      return requestSummary(c, String(args.id));
    },
  },
  {
    name: "list_grants",
    title: "List grants",
    description: "Standing permissions: who may do what without asking.",
    readOnly: true,
    inputSchema: { type: "object", properties: {} },
    async run(_args, c) {
      const rows = await c.db
        .select()
        .from(grants)
        .where(isNull(grants.revokedAt))
        .orderBy(desc(grants.createdAt))
        .all();
      return {
        grants: await Promise.all(
          rows.map(async (g) => ({
            id: g.id,
            action: g.action,
            resource: g.resource,
            scope: g.scope,
            for:
              g.scope === "user" && g.subjectId
                ? ((await c.loaders.user.load(g.subjectId))?.name ?? null)
                : g.scope === "team" && g.subjectId
                  ? ((await c.loaders.team.load(g.subjectId))?.name ?? null)
                  : "everyone",
            useCount: g.useCount,
          })),
        ),
      };
    },
  },
  {
    name: "list_notifications",
    title: "List notifications",
    description:
      "Your Inbox, newest first: assignments, mentions, comments and status changes on issues you follow, and answers to your requests.",
    readOnly: true,
    inputSchema: {
      type: "object",
      properties: {
        unreadOnly: { type: "boolean", description: "Default true" },
        limit: { type: "number" },
      },
    },
    async run(args, c) {
      const rows = await c.db
        .select()
        .from(notifications)
        .where(
          and(
            inInbox(c.viewer.id, Date.now()),
            args.unreadOnly === false ? undefined : isNull(notifications.readAt),
          ),
        )
        .orderBy(desc(notifications.createdAt))
        .limit(Math.min(Math.max(num(args.limit) ?? 25, 1), 100))
        .all();
      return {
        notifications: await Promise.all(
          rows.map(async (n) => {
            const issue = n.issueId ? await c.loaders.issue.load(n.issueId) : null;
            return {
              id: n.id,
              type: n.type,
              actor: n.actorId ? ((await c.loaders.user.load(n.actorId))?.name ?? null) : null,
              issue: issue ? (await issueSummary(c, issue)).identifier : null,
              commentId: n.commentId,
              requestId: n.requestId,
              data: n.data,
              read: n.readAt !== null,
              createdAt: new Date(n.createdAt).toISOString(),
            };
          }),
        ),
      };
    },
  },
  {
    name: "update_notification",
    title: "Update notification",
    description: "Mark a notification read or unread, or archive it once handled.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        read: { type: "boolean" },
        archived: { type: "boolean" },
      },
      required: ["id"],
    },
    async run(args, c) {
      const id = String(args.id);
      if (typeof args.read === "boolean") {
        const read = args.read;
        await c.act((s) => updateNotification(s, id, { readAt: read ? s.now : null }));
      }
      if (typeof args.archived === "boolean") {
        const archived = args.archived;
        await c.act((s) => archiveNotification(s, id, archived));
      }
      return { id };
    },
  },
];

async function requestSummary(c: McpContext, id: string) {
  const r = await c.db.select().from(requests).where(eq(requests.id, id)).get();
  if (!r) throw new ToolError(`No request ${id}`);
  const requester = await c.loaders.user.load(r.requesterId);
  const issue = r.issueId ? await c.loaders.issue.load(r.issueId) : null;
  return {
    id: r.id,
    title: r.title,
    action: r.action,
    resource: r.resource,
    status: r.status,
    answer: r.answer,
    used: r.consumedAt !== null,
    alwaysAllowed: r.grantId !== null,
    requester: requester?.name ?? null,
    issue: issue ? (await issueSummary(c, issue)).identifier : null,
    url: `${c.appUrl}/request/${r.id}`,
    createdAt: new Date(r.createdAt).toISOString(),
  };
}
