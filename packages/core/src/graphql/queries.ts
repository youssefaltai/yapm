import {
  auditEvents,
  comments,
  issues,
  labels,
  teams,
  users,
  workflowStates,
  workspaces,
} from "@yapm/schema";
import { and, asc, desc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { createGraphQLError } from "graphql-yoga";
import { findIssue } from "../services/issues.js";
import {
  builder,
  db,
  notFoundError,
  olderThan,
  pageArgs,
  pageSize,
  paginate,
  requireViewer,
} from "./builder.js";
import { issueArgs, queryIssues, TeamFilter, teamCondition } from "./filters.js";
import {
  AuditEntryConnection,
  Comment,
  Issue,
  IssueConnection,
  IssueLabel,
  IssueLabelConnection,
  Organization,
  Team,
  TeamConnection,
  User,
  UserConnection,
  WorkflowState,
  WorkflowStateConnection,
} from "./types.js";

const IDENTIFIER = /^([A-Za-z][A-Za-z0-9]{0,6})-(\d+)$/;

builder.queryType({
  fields: (t) => ({
    viewer: t.field({
      type: User,
      description: "The member making the request.",
      resolve: (_root, _args, ctx) => requireViewer(ctx).user,
    }),
    organization: t.field({
      type: Organization,
      resolve: async (_root, _args, ctx) => {
        requireViewer(ctx);
        const row = await db(ctx).select().from(workspaces).get();
        if (!row) throw createGraphQLError("The company has not been set up yet");
        return row;
      },
    }),
    users: t.field({
      type: UserConnection,
      args: { ...pageArgs, includeDisabled: t.arg.boolean({ required: false }) },
      resolve: async (_root, args, ctx) => {
        requireViewer(ctx);
        const rows = await db(ctx)
          .select()
          .from(users)
          .where(args.includeDisabled ? undefined : eq(users.active, true))
          .orderBy(asc(users.createdAt))
          .all();
        return paginate(rows, args);
      },
    }),
    user: t.field({
      type: User,
      args: { id: t.arg.string({ required: true }) },
      resolve: async (_root, args, ctx) => {
        requireViewer(ctx);
        const row = await ctx.loaders.user.load(args.id);
        if (!row) throw notFoundError("User");
        return row;
      },
    }),
    teams: t.field({
      type: TeamConnection,
      args: {
        ...pageArgs,
        filter: t.arg({ type: TeamFilter, required: false }),
        includeArchived: t.arg.boolean({ required: false }),
      },
      resolve: async (_root, args, ctx) => {
        requireViewer(ctx);
        const rows = await db(ctx)
          .select()
          .from(teams)
          .where(
            and(
              args.includeArchived ? undefined : isNull(teams.archivedAt),
              args.filter ? teamCondition(db(ctx), args.filter) : undefined,
            ),
          )
          .orderBy(asc(teams.name))
          .all();
        return paginate(rows, args);
      },
    }),
    team: t.field({
      type: Team,
      description: "A team by id or by key (e.g. `FIN`).",
      args: { id: t.arg.string({ required: true }) },
      resolve: async (_root, args, ctx) => {
        requireViewer(ctx);
        const row = await db(ctx)
          .select()
          .from(teams)
          .where(or(eq(teams.id, args.id), eq(teams.key, args.id.toUpperCase())))
          .get();
        if (!row) throw notFoundError("Team");
        return row;
      },
    }),
    workflowStates: t.field({
      type: WorkflowStateConnection,
      args: { ...pageArgs, teamIds: t.arg.stringList({ required: false }) },
      resolve: async (_root, args, ctx) => {
        requireViewer(ctx);
        const rows = await db(ctx)
          .select()
          .from(workflowStates)
          .where(args.teamIds?.length ? inArray(workflowStates.teamId, args.teamIds) : undefined)
          .orderBy(asc(workflowStates.teamId), asc(workflowStates.position))
          .all();
        return paginate(rows, args);
      },
    }),
    workflowState: t.field({
      type: WorkflowState,
      args: { id: t.arg.string({ required: true }) },
      resolve: async (_root, args, ctx) => {
        requireViewer(ctx);
        const row = await ctx.loaders.state.load(args.id);
        if (!row) throw notFoundError("Workflow state");
        return row;
      },
    }),
    issueLabels: t.field({
      type: IssueLabelConnection,
      args: pageArgs,
      resolve: async (_root, args, ctx) => {
        requireViewer(ctx);
        return paginate(await db(ctx).select().from(labels).orderBy(asc(labels.name)).all(), args);
      },
    }),
    issueLabel: t.field({
      type: IssueLabel,
      args: { id: t.arg.string({ required: true }) },
      resolve: async (_root, args, ctx) => {
        requireViewer(ctx);
        const row = await ctx.loaders.label.load(args.id);
        if (!row) throw notFoundError("Label");
        return row;
      },
    }),
    issue: t.field({
      type: Issue,
      description: "An issue by id or identifier (e.g. `FIN-42`).",
      args: { id: t.arg.string({ required: true }) },
      resolve: async (_root, args, ctx) => {
        requireViewer(ctx);
        const row = await findIssue(db(ctx), args.id);
        if (!row) throw notFoundError("Issue");
        return row;
      },
    }),
    issues: t.field({
      type: IssueConnection,
      description:
        "Issues across all teams, newest first. Archived issues are left out unless asked for.",
      args: issueArgs,
      resolve: (_root, args, ctx) => queryIssues(db(ctx), args, requireViewer(ctx).user.id),
    }),
    searchIssues: t.field({
      type: IssueConnection,
      description: "Issues whose identifier, title, description or comments contain the term.",
      args: { ...issueArgs, term: t.arg.string({ required: true }) },
      resolve: async (_root, args, ctx) => {
        const viewer = requireViewer(ctx);
        const term = args.term.trim();
        if (!term) return { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } };
        const like = `%${term.toLowerCase().replace(/[%_\\]/g, "\\$&")}%`;
        const match = IDENTIFIER.exec(term);
        const byIdentifier = match
          ? and(
              eq(issues.number, Number(match[2])),
              inArray(
                issues.teamId,
                db(ctx)
                  .select({ id: teams.id })
                  .from(teams)
                  .where(eq(teams.key, (match[1] ?? "").toUpperCase())),
              ),
            )
          : undefined;
        return queryIssues(
          db(ctx),
          args,
          viewer.user.id,
          or(
            byIdentifier,
            sql`lower(${issues.title}) like ${like} escape '\\'`,
            sql`lower(coalesce(${issues.description}, '')) like ${like} escape '\\'`,
            inArray(
              issues.id,
              db(ctx)
                .select({ id: comments.issueId })
                .from(comments)
                .where(sql`lower(${comments.body}) like ${like} escape '\\'`),
            ),
          ),
        );
      },
    }),
    comment: t.field({
      type: Comment,
      args: { id: t.arg.string({ required: true }) },
      resolve: async (_root, args, ctx) => {
        requireViewer(ctx);
        const row = await db(ctx).select().from(comments).where(eq(comments.id, args.id)).get();
        if (!row) throw notFoundError("Comment");
        return row;
      },
    }),
    auditEntries: t.field({
      type: AuditEntryConnection,
      description: "The company's history, newest first.",
      args: {
        first: t.arg.int({ required: false }),
        after: t.arg.string({ required: false }),
        before: t.arg({
          type: "DateTime",
          required: false,
          description: "Only entries older than this.",
        }),
        entityType: t.arg.string({ required: false }),
        entityId: t.arg.string({ required: false }),
        actorId: t.arg.string({ required: false }),
      },
      resolve: async (_root, args, ctx) => {
        requireViewer(ctx);
        const rows = await db(ctx)
          .select()
          .from(auditEvents)
          .where(
            and(
              olderThan(auditEvents, args.after),
              args.before ? lt(auditEvents.createdAt, args.before.getTime()) : undefined,
              args.entityType ? eq(auditEvents.entityType, args.entityType) : undefined,
              args.entityId ? eq(auditEvents.entityId, args.entityId) : undefined,
              args.actorId ? eq(auditEvents.actorId, args.actorId) : undefined,
            ),
          )
          .orderBy(desc(auditEvents.createdAt), desc(auditEvents.id))
          .limit(pageSize(args.first) + 1)
          .all();
        return paginate(rows, { first: args.first });
      },
    }),
  }),
});
