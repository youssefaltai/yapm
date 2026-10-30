import {
  apiTokens,
  auditEvents,
  type comments,
  ISSUE_RELATION_TYPES,
  type issueRelations,
  issues,
  labels,
  PRIORITY_LABELS,
  type reactions,
  teamMemberships,
  teams,
  USER_KINDS,
  users,
  WORKFLOW_STATE_TYPES,
  type workflowStates,
  type workspaces,
} from "@yapm/schema";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { createGraphQLError } from "graphql-yoga";
import { DEFAULT_ROUTING } from "../runs/routing.js";
import { ancestorIds, descendantIds, teamLabels } from "../services/teamTree.js";
import { builder, connection, db, type GraphQLContext, pageArgs, paginate } from "./builder.js";
import { issueArgs, queryIssues } from "./filters.js";

export type UserRow = typeof users.$inferSelect;
export type TeamRow = typeof teams.$inferSelect;
export type StateRow = typeof workflowStates.$inferSelect;
export type LabelRow = typeof labels.$inferSelect;
export type WorkspaceRow = typeof workspaces.$inferSelect;
export type AuditRow = typeof auditEvents.$inferSelect;
export type IssueRow = typeof issues.$inferSelect;
export type CommentRow = typeof comments.$inferSelect;
export type ReactionRow = typeof reactions.$inferSelect;
export type RelationRow = typeof issueRelations.$inferSelect;
export type ApiTokenRow = typeof apiTokens.$inferSelect;

export const UserKind = builder.enumType("UserKind", { values: USER_KINDS });
export const WorkflowStateType = builder.enumType("WorkflowStateType", {
  values: WORKFLOW_STATE_TYPES,
});
export const IssueRelationType = builder.enumType("IssueRelationType", {
  values: ISSUE_RELATION_TYPES,
});

export const Organization = builder.objectRef<WorkspaceRow>("Organization");
export const User = builder.objectRef<UserRow>("User");
export const Team = builder.objectRef<TeamRow>("Team");
export const WorkflowState = builder.objectRef<StateRow>("WorkflowState");
export const IssueLabel = builder.objectRef<LabelRow>("IssueLabel");
export const AuditEntry = builder.objectRef<AuditRow>("AuditEntry");
export const Issue = builder.objectRef<IssueRow>("Issue");
export const Comment = builder.objectRef<CommentRow>("Comment");
export const Reaction = builder.objectRef<ReactionRow>("Reaction");
export const IssueRelation = builder.objectRef<RelationRow>("IssueRelation");
export const ApiToken = builder.objectRef<ApiTokenRow>("ApiToken");

export const UserConnection = connection<UserRow>("User", User);
export const TeamConnection = connection<TeamRow>("Team", Team);
export const WorkflowStateConnection = connection<StateRow>("WorkflowState", WorkflowState);
export const IssueLabelConnection = connection<LabelRow>("IssueLabel", IssueLabel);
export const AuditEntryConnection = connection<AuditRow>("AuditEntry", AuditEntry);
export const IssueConnection = connection<IssueRow>("Issue", Issue);
export const CommentConnection = connection<CommentRow>("Comment", Comment);
export const IssueRelationConnection = connection<RelationRow>("IssueRelation", IssueRelation);

/** Loads a row that must exist (a foreign key), failing loudly if the data is inconsistent. */
async function must<T>(row: Promise<T | null>, what: string): Promise<T> {
  const value = await row;
  if (!value) throw createGraphQLError(`${what} not found`);
  return value;
}

function viewerId(ctx: GraphQLContext): string {
  return ctx.viewer?.user.id ?? "";
}

Organization.implement({
  description: "The company.",
  fields: (t) => ({
    id: t.exposeID("id"),
    name: t.exposeString("name"),
    urlKey: t.exposeString("urlKey"),
    handbook: t.exposeString("handbook", {
      nullable: true,
      description: "How the company works, in markdown. Every agent reads it.",
    }),
    modelRouting: t.field({
      type: "JSONObject",
      description:
        "How runs pick a model: each tier's pinned model and effort, and labels that route issues to a tier.",
      resolve: (o) => (o.modelRouting ?? DEFAULT_ROUTING) as unknown as Record<string, unknown>,
    }),
    createdAt: t.field({ type: "DateTime", resolve: (o) => o.createdAt }),
  }),
});

User.implement({
  description: "A member of the company: the owner or an AI agent employee.",
  fields: (t) => ({
    id: t.exposeID("id"),
    kind: t.field({ type: UserKind, resolve: (u) => u.kind }),
    name: t.exposeString("name"),
    displayName: t.exposeString("displayName"),
    email: t.exposeString("email", { nullable: true }),
    title: t.exposeString("title", { nullable: true }),
    avatarUrl: t.exposeString("avatarUrl", { nullable: true }),
    charter: t.exposeString("charter", { nullable: true }),
    lessons: t.exposeString("lessons", {
      nullable: true,
      description: "What an agent has learned, in its own words. It reads them on every run.",
    }),
    active: t.exposeBoolean("active"),
    isMe: t.boolean({ resolve: (u, _args, ctx) => ctx.viewer?.user.id === u.id }),
    createdAt: t.field({ type: "DateTime", resolve: (u) => u.createdAt }),
    updatedAt: t.field({ type: "DateTime", resolve: (u) => u.updatedAt }),
    manager: t.field({
      type: User,
      nullable: true,
      resolve: (u, _args, ctx) => (u.managerId ? ctx.loaders.user.load(u.managerId) : null),
    }),
    directReports: t.field({
      type: UserConnection,
      args: pageArgs,
      resolve: async (u, args, ctx) =>
        paginate(
          await db(ctx)
            .select()
            .from(users)
            .where(eq(users.managerId, u.id))
            .orderBy(asc(users.createdAt))
            .all(),
          args,
        ),
    }),
    teams: t.field({
      type: TeamConnection,
      args: pageArgs,
      resolve: async (u, args, ctx) => {
        const rows = await db(ctx)
          .select({ team: teams })
          .from(teamMemberships)
          .innerJoin(teams, eq(teams.id, teamMemberships.teamId))
          .where(eq(teamMemberships.userId, u.id))
          .orderBy(asc(teams.name))
          .all();
        return paginate(
          rows.map((r) => r.team),
          args,
        );
      },
    }),
    assignedIssues: t.field({
      type: IssueConnection,
      description: "Issues assigned to this member.",
      args: issueArgs,
      resolve: (u, args, ctx) =>
        queryIssues(db(ctx), args, viewerId(ctx), eq(issues.assigneeId, u.id)),
    }),
    apiTokens: t.field({
      type: [ApiToken],
      description:
        "This member's API tokens, newest first. Only the owner and the member can see them.",
      resolve: async (u, _args, ctx) => {
        const viewer = ctx.viewer?.user;
        if (!viewer || (viewer.kind !== "owner" && viewer.id !== u.id)) return [];
        return db(ctx)
          .select()
          .from(apiTokens)
          .where(eq(apiTokens.userId, u.id))
          .orderBy(desc(apiTokens.createdAt))
          .all();
      },
    }),
    createdIssues: t.field({
      type: IssueConnection,
      description: "Issues this member created.",
      args: issueArgs,
      resolve: (u, args, ctx) =>
        queryIssues(db(ctx), args, viewerId(ctx), eq(issues.creatorId, u.id)),
    }),
  }),
});

Team.implement({
  description: "A unit of the company.",
  fields: (t) => ({
    id: t.exposeID("id"),
    key: t.exposeString("key"),
    name: t.exposeString("name"),
    description: t.exposeString("description", { nullable: true }),
    icon: t.exposeString("icon", { nullable: true }),
    color: t.exposeString("color", { nullable: true }),
    issueCount: t.exposeInt("issueCount"),
    createdAt: t.field({ type: "DateTime", resolve: (team) => team.createdAt }),
    updatedAt: t.field({ type: "DateTime", resolve: (team) => team.updatedAt }),
    archivedAt: t.field({ type: "DateTime", nullable: true, resolve: (team) => team.archivedAt }),
    lead: t.field({
      type: User,
      nullable: true,
      resolve: (team, _args, ctx) => (team.leadId ? ctx.loaders.user.load(team.leadId) : null),
    }),
    parent: t.field({
      type: Team,
      nullable: true,
      description: "The team's parent team.",
      resolve: (team, _args, ctx) => (team.parentId ? ctx.loaders.team.load(team.parentId) : null),
    }),
    children: t.field({
      type: [Team],
      description: "The team's sub-teams.",
      resolve: (team, _args, ctx) =>
        db(ctx)
          .select()
          .from(teams)
          .where(eq(teams.parentId, team.id))
          .orderBy(asc(teams.name))
          .all(),
    }),
    ancestors: t.field({
      type: [Team],
      description: "The team's ancestor teams, ordered from the root to the immediate parent.",
      resolve: async (team, _args, ctx) => {
        const ids = await ancestorIds(db(ctx), team.id);
        return Promise.all(ids.map((id) => must(ctx.loaders.team.load(id), "Team")));
      },
    }),
    members: t.field({
      type: UserConnection,
      args: pageArgs,
      resolve: async (team, args, ctx) => {
        const rows = await db(ctx)
          .select({ user: users })
          .from(teamMemberships)
          .innerJoin(users, eq(users.id, teamMemberships.userId))
          .where(eq(teamMemberships.teamId, team.id))
          .orderBy(asc(users.createdAt))
          .all();
        return paginate(
          rows.map((r) => r.user),
          args,
        );
      },
    }),
    states: t.field({
      type: WorkflowStateConnection,
      args: pageArgs,
      resolve: async (team, args, ctx) =>
        paginate(await ctx.loaders.statesByTeam.load(team.id), args),
    }),
    labels: t.field({
      type: IssueLabelConnection,
      description: "Labels usable in this team: its own, its ancestors' and workspace-wide ones.",
      args: pageArgs,
      resolve: async (team, args, ctx) =>
        paginate(
          await db(ctx)
            .select()
            .from(labels)
            .where(await teamLabels(db(ctx), team.id))
            .orderBy(asc(labels.name))
            .all(),
          args,
        ),
    }),
    issues: t.field({
      type: IssueConnection,
      description: "Issues belonging to the team, and with includeSubTeams its sub-teams'.",
      args: {
        ...issueArgs,
        includeSubTeams: t.arg.boolean({ required: false, defaultValue: false }),
      },
      resolve: async (team, { includeSubTeams, ...args }, ctx) =>
        queryIssues(
          db(ctx),
          args,
          viewerId(ctx),
          includeSubTeams
            ? inArray(issues.teamId, [team.id, ...(await descendantIds(db(ctx), team.id))])
            : eq(issues.teamId, team.id),
        ),
    }),
  }),
});

WorkflowState.implement({
  fields: (t) => ({
    id: t.exposeID("id"),
    name: t.exposeString("name"),
    type: t.field({ type: WorkflowStateType, resolve: (s) => s.type }),
    color: t.exposeString("color"),
    description: t.exposeString("description", { nullable: true }),
    position: t.exposeInt("position"),
    team: t.field({
      type: Team,
      resolve: (s, _args, ctx) => must(ctx.loaders.team.load(s.teamId), "Team"),
    }),
  }),
});

IssueLabel.implement({
  fields: (t) => ({
    id: t.exposeID("id"),
    name: t.exposeString("name"),
    color: t.exposeString("color"),
    description: t.exposeString("description", { nullable: true }),
    createdAt: t.field({ type: "DateTime", resolve: (l) => l.createdAt }),
    team: t.field({
      type: Team,
      nullable: true,
      resolve: (l, _args, ctx) => (l.teamId ? ctx.loaders.team.load(l.teamId) : null),
    }),
  }),
});

AuditEntry.implement({
  description: "One change in the company's history, by the owner or an agent.",
  fields: (t) => ({
    id: t.exposeID("id"),
    action: t.exposeString("action"),
    entityType: t.exposeString("entityType"),
    entityId: t.exposeString("entityId"),
    reason: t.exposeString("reason", { nullable: true }),
    runId: t.exposeString("runId", { nullable: true }),
    data: t.field({ type: "JSONObject", nullable: true, resolve: (a) => a.data ?? null }),
    createdAt: t.field({ type: "DateTime", resolve: (a) => a.createdAt }),
    actor: t.field({
      type: User,
      nullable: true,
      resolve: (a, _args, ctx) => (a.actorId ? ctx.loaders.user.load(a.actorId) : null),
    }),
  }),
});

Issue.implement({
  description: "A unit of work.",
  fields: (t) => ({
    id: t.exposeID("id"),
    identifier: t.string({
      description: "The team key and number, e.g. FIN-42.",
      resolve: async (issue, _args, ctx) =>
        `${(await must(ctx.loaders.team.load(issue.teamId), "Team")).key}-${issue.number}`,
    }),
    number: t.exposeInt("number"),
    title: t.exposeString("title"),
    description: t.exposeString("description", { nullable: true }),
    priority: t.exposeInt("priority", {
      description: "0 = no priority, 1 = urgent, 2 = high, 3 = medium, 4 = low.",
    }),
    priorityLabel: t.string({
      resolve: (issue) => PRIORITY_LABELS[issue.priority] ?? "No priority",
    }),
    estimate: t.exposeInt("estimate", { nullable: true }),
    dueDate: t.field({ type: "TimelessDate", nullable: true, resolve: (issue) => issue.dueDate }),
    sortOrder: t.exposeFloat("sortOrder"),
    createdAt: t.field({ type: "DateTime", resolve: (issue) => issue.createdAt }),
    updatedAt: t.field({ type: "DateTime", resolve: (issue) => issue.updatedAt }),
    startedAt: t.field({ type: "DateTime", nullable: true, resolve: (issue) => issue.startedAt }),
    completedAt: t.field({
      type: "DateTime",
      nullable: true,
      resolve: (issue) => issue.completedAt,
    }),
    canceledAt: t.field({ type: "DateTime", nullable: true, resolve: (issue) => issue.canceledAt }),
    archivedAt: t.field({ type: "DateTime", nullable: true, resolve: (issue) => issue.archivedAt }),
    team: t.field({
      type: Team,
      resolve: (issue, _args, ctx) => must(ctx.loaders.team.load(issue.teamId), "Team"),
    }),
    state: t.field({
      type: WorkflowState,
      resolve: (issue, _args, ctx) => must(ctx.loaders.state.load(issue.stateId), "Workflow state"),
    }),
    assignee: t.field({
      type: User,
      nullable: true,
      resolve: (issue, _args, ctx) =>
        issue.assigneeId ? ctx.loaders.user.load(issue.assigneeId) : null,
    }),
    creator: t.field({
      type: User,
      nullable: true,
      resolve: (issue, _args, ctx) =>
        issue.creatorId ? ctx.loaders.user.load(issue.creatorId) : null,
    }),
    parent: t.field({
      type: Issue,
      nullable: true,
      resolve: (issue, _args, ctx) =>
        issue.parentId ? ctx.loaders.issue.load(issue.parentId) : null,
    }),
    children: t.field({
      type: IssueConnection,
      description: "Sub-issues.",
      args: pageArgs,
      resolve: async (issue, args, ctx) =>
        paginate(await ctx.loaders.childrenByIssue.load(issue.id), args),
    }),
    labels: t.field({
      type: IssueLabelConnection,
      args: pageArgs,
      resolve: async (issue, args, ctx) =>
        paginate(await ctx.loaders.labelsByIssue.load(issue.id), args),
    }),
    labelIds: t.stringList({
      resolve: async (issue, _args, ctx) =>
        (await ctx.loaders.labelsByIssue.load(issue.id)).map((l) => l.id),
    }),
    comments: t.field({
      type: CommentConnection,
      description: "All comments, oldest first, replies included.",
      args: pageArgs,
      resolve: async (issue, args, ctx) =>
        paginate(await ctx.loaders.commentsByIssue.load(issue.id), args),
    }),
    relations: t.field({
      type: IssueRelationConnection,
      description:
        "Relations where this issue is the subject (it blocks, duplicates or relates to another).",
      args: pageArgs,
      resolve: async (issue, args, ctx) =>
        paginate(await ctx.loaders.relationsByIssue.load(issue.id), args),
    }),
    inverseRelations: t.field({
      type: IssueRelationConnection,
      description: "Relations pointing at this issue (another issue blocks or duplicates it).",
      args: pageArgs,
      resolve: async (issue, args, ctx) =>
        paginate(await ctx.loaders.inverseRelationsByIssue.load(issue.id), args),
    }),
    reactions: t.field({
      type: [Reaction],
      resolve: (issue, _args, ctx) => ctx.loaders.reactionsByIssue.load(issue.id),
    }),
    history: t.field({
      type: AuditEntryConnection,
      description: "Every change to the issue, oldest first.",
      args: pageArgs,
      resolve: async (issue, args, ctx) =>
        paginate(
          await db(ctx)
            .select()
            .from(auditEvents)
            .where(and(eq(auditEvents.entityType, "issue"), eq(auditEvents.entityId, issue.id)))
            .orderBy(asc(auditEvents.createdAt), asc(auditEvents.id))
            .all(),
          args,
        ),
    }),
  }),
});

Comment.implement({
  fields: (t) => ({
    id: t.exposeID("id"),
    body: t.exposeString("body", { description: "Markdown." }),
    createdAt: t.field({ type: "DateTime", resolve: (c) => c.createdAt }),
    updatedAt: t.field({ type: "DateTime", resolve: (c) => c.updatedAt }),
    editedAt: t.field({ type: "DateTime", nullable: true, resolve: (c) => c.editedAt }),
    user: t.field({
      type: User,
      resolve: (c, _args, ctx) => must(ctx.loaders.user.load(c.userId), "User"),
    }),
    issue: t.field({
      type: Issue,
      resolve: (c, _args, ctx) => must(ctx.loaders.issue.load(c.issueId), "Issue"),
    }),
    parent: t.field({
      type: Comment,
      nullable: true,
      resolve: async (c, _args, ctx) =>
        c.parentId
          ? ((await ctx.loaders.commentsByIssue.load(c.issueId)).find((p) => p.id === c.parentId) ??
            null)
          : null,
    }),
    children: t.field({
      type: CommentConnection,
      description: "Replies, oldest first.",
      args: pageArgs,
      resolve: async (c, args, ctx) =>
        paginate(
          (await ctx.loaders.commentsByIssue.load(c.issueId)).filter((r) => r.parentId === c.id),
          args,
        ),
    }),
    reactions: t.field({
      type: [Reaction],
      resolve: (c, _args, ctx) => ctx.loaders.reactionsByComment.load(c.id),
    }),
  }),
});

Reaction.implement({
  fields: (t) => ({
    id: t.exposeID("id"),
    emoji: t.exposeString("emoji"),
    createdAt: t.field({ type: "DateTime", resolve: (r) => r.createdAt }),
    user: t.field({
      type: User,
      resolve: (r, _args, ctx) => must(ctx.loaders.user.load(r.userId), "User"),
    }),
    issue: t.field({
      type: Issue,
      nullable: true,
      resolve: (r, _args, ctx) => (r.issueId ? ctx.loaders.issue.load(r.issueId) : null),
    }),
  }),
});

IssueRelation.implement({
  description: "`issue` blocks, duplicates or relates to `relatedIssue`.",
  fields: (t) => ({
    id: t.exposeID("id"),
    type: t.field({ type: IssueRelationType, resolve: (r) => r.type }),
    createdAt: t.field({ type: "DateTime", resolve: (r) => r.createdAt }),
    issue: t.field({
      type: Issue,
      resolve: (r, _args, ctx) => must(ctx.loaders.issue.load(r.issueId), "Issue"),
    }),
    relatedIssue: t.field({
      type: Issue,
      resolve: (r, _args, ctx) => must(ctx.loaders.issue.load(r.relatedIssueId), "Issue"),
    }),
  }),
});

ApiToken.implement({
  description:
    "A credential an agent, runner or script uses to act as a member. The secret is shown once.",
  fields: (t) => ({
    id: t.exposeID("id"),
    name: t.exposeString("name"),
    prefix: t.exposeString("prefix", {
      description: "The token's first characters, to tell tokens apart.",
    }),
    createdAt: t.field({ type: "DateTime", resolve: (k) => k.createdAt }),
    lastUsedAt: t.field({ type: "DateTime", nullable: true, resolve: (k) => k.lastUsedAt }),
    revokedAt: t.field({ type: "DateTime", nullable: true, resolve: (k) => k.revokedAt }),
    user: t.field({
      type: User,
      resolve: (k, _args, ctx) => must(ctx.loaders.user.load(k.userId), "User"),
    }),
  }),
});
