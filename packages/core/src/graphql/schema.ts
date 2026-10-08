import {
  auditEvents,
  labels,
  teamMemberships,
  teams,
  USER_KINDS,
  users,
  WORKFLOW_STATE_TYPES,
  workflowStates,
  workspaces,
} from "@life-os/schema";
import SchemaBuilder, { type ObjectRef } from "@pothos/core";
import { and, asc, desc, eq, inArray, isNull, lt, or } from "drizzle-orm";
import { createGraphQLError } from "graphql-yoga";
import { createApiToken } from "../auth.js";
import type { HubDeps, Viewer } from "../context.js";

export interface GraphQLContext {
  deps: HubDeps;
  viewer: Viewer | null;
}

type UserRow = typeof users.$inferSelect;
type TeamRow = typeof teams.$inferSelect;
type StateRow = typeof workflowStates.$inferSelect;
type LabelRow = typeof labels.$inferSelect;
type WorkspaceRow = typeof workspaces.$inferSelect;
type AuditRow = typeof auditEvents.$inferSelect;

interface GraphQLTypes {
  Context: GraphQLContext;
  Scalars: {
    DateTime: { Input: Date; Output: Date | number };
    JSONObject: { Input: Record<string, unknown>; Output: Record<string, unknown> };
  };
}

const builder = new SchemaBuilder<GraphQLTypes>({});

type Types = PothosSchemaTypes.ExtendDefaultTypes<GraphQLTypes>;

builder.scalarType("DateTime", {
  description: "ISO-8601 timestamp.",
  serialize: (value) => new Date(value).toISOString(),
  parseValue: (value) => new Date(String(value)),
});

builder.scalarType("JSONObject", {
  serialize: (value) => value,
  parseValue: (value) => value as Record<string, unknown>,
});

function requireViewer(ctx: GraphQLContext): Viewer {
  if (!ctx.viewer) {
    throw createGraphQLError("Authentication required", {
      extensions: { code: "UNAUTHENTICATED" },
    });
  }
  return ctx.viewer;
}

function db(ctx: GraphQLContext) {
  return ctx.deps.db;
}

// Linear-style connections: `{ nodes, pageInfo }` with `first`/`after` arguments.
const PageInfo = builder
  .objectRef<{ hasNextPage: boolean; endCursor: string | null }>("PageInfo")
  .implement({
    fields: (t) => ({
      hasNextPage: t.exposeBoolean("hasNextPage"),
      endCursor: t.exposeString("endCursor", { nullable: true }),
    }),
  });

type Page<T> = { nodes: T[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } };

function connection<T>(name: string, node: ObjectRef<Types, T>) {
  return builder.objectRef<Page<T>>(`${name}Connection`).implement({
    fields: (t) => ({
      nodes: t.field({ type: [node], resolve: (page) => page.nodes }),
      pageInfo: t.field({ type: PageInfo, resolve: (page) => page.pageInfo }),
    }),
  });
}

/** Slices an ordered list into a page. Lists are small for now; SQL-level cursors come with issues. */
function paginate<T extends { id: string }>(
  rows: T[],
  args: { first?: number | null; after?: string | null },
) {
  const start = args.after ? rows.findIndex((row) => row.id === args.after) + 1 : 0;
  const first = Math.min(Math.max(args.first ?? 50, 1), 250);
  const nodes = rows.slice(start, start + first);
  return {
    nodes,
    pageInfo: { hasNextPage: start + first < rows.length, endCursor: nodes.at(-1)?.id ?? null },
  };
}

const pageArgs = builder.args((t) => ({
  first: t.int({ required: false }),
  after: t.string({ required: false }),
}));

const UserKind = builder.enumType("UserKind", { values: USER_KINDS });
const WorkflowStateType = builder.enumType("WorkflowStateType", { values: WORKFLOW_STATE_TYPES });

const Organization = builder.objectRef<WorkspaceRow>("Organization");
const User = builder.objectRef<UserRow>("User");
const Team = builder.objectRef<TeamRow>("Team");
const WorkflowState = builder.objectRef<StateRow>("WorkflowState");
const IssueLabel = builder.objectRef<LabelRow>("IssueLabel");
const AuditEntry = builder.objectRef<AuditRow>("AuditEntry");

const UserConnection = connection<UserRow>("User", User);
const TeamConnection = connection<TeamRow>("Team", Team);
const WorkflowStateConnection = connection<StateRow>("WorkflowState", WorkflowState);
const IssueLabelConnection = connection<LabelRow>("IssueLabel", IssueLabel);
const AuditEntryConnection = connection<AuditRow>("AuditEntry", AuditEntry);

Organization.implement({
  description: "The company. Named after Linear's organization.",
  fields: (t) => ({
    id: t.exposeID("id"),
    name: t.exposeString("name"),
    urlKey: t.exposeString("urlKey"),
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
    active: t.exposeBoolean("active"),
    isMe: t.boolean({ resolve: (u, _args, ctx) => ctx.viewer?.user.id === u.id }),
    createdAt: t.field({ type: "DateTime", resolve: (u) => u.createdAt }),
    updatedAt: t.field({ type: "DateTime", resolve: (u) => u.updatedAt }),
    manager: t.field({
      type: User,
      nullable: true,
      resolve: async (u, _args, ctx) =>
        u.managerId
          ? ((await db(ctx).select().from(users).where(eq(users.id, u.managerId)).get()) ?? null)
          : null,
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
  }),
});

Team.implement({
  description: "A unit of the company, like a team in Linear.",
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
      resolve: async (team, _args, ctx) =>
        team.leadId
          ? ((await db(ctx).select().from(users).where(eq(users.id, team.leadId)).get()) ?? null)
          : null,
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
        paginate(
          await db(ctx)
            .select()
            .from(workflowStates)
            .where(eq(workflowStates.teamId, team.id))
            .orderBy(asc(workflowStates.position))
            .all(),
          args,
        ),
    }),
    labels: t.field({
      type: IssueLabelConnection,
      description: "Labels usable in this team: its own plus workspace-wide ones.",
      args: pageArgs,
      resolve: async (team, args, ctx) =>
        paginate(
          await db(ctx)
            .select()
            .from(labels)
            .where(or(eq(labels.teamId, team.id), isNull(labels.teamId)))
            .orderBy(asc(labels.name))
            .all(),
          args,
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
      resolve: async (s, _args, ctx) => {
        const team = await db(ctx).select().from(teams).where(eq(teams.id, s.teamId)).get();
        if (!team) throw createGraphQLError("Team not found");
        return team;
      },
    }),
  }),
});

IssueLabel.implement({
  fields: (t) => ({
    id: t.exposeID("id"),
    name: t.exposeString("name"),
    color: t.exposeString("color"),
    description: t.exposeString("description", { nullable: true }),
    team: t.field({
      type: Team,
      nullable: true,
      resolve: async (l, _args, ctx) =>
        l.teamId
          ? ((await db(ctx).select().from(teams).where(eq(teams.id, l.teamId)).get()) ?? null)
          : null,
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
      resolve: async (a, _args, ctx) =>
        a.actorId
          ? ((await db(ctx).select().from(users).where(eq(users.id, a.actorId)).get()) ?? null)
          : null,
    }),
  }),
});

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
        const row = await db(ctx).select().from(users).where(eq(users.id, args.id)).get();
        if (!row) throw createGraphQLError("User not found", { extensions: { code: "NOT_FOUND" } });
        return row;
      },
    }),
    teams: t.field({
      type: TeamConnection,
      args: { ...pageArgs, includeArchived: t.arg.boolean({ required: false }) },
      resolve: async (_root, args, ctx) => {
        requireViewer(ctx);
        const rows = await db(ctx)
          .select()
          .from(teams)
          .where(args.includeArchived ? undefined : isNull(teams.archivedAt))
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
        if (!row) throw createGraphQLError("Team not found", { extensions: { code: "NOT_FOUND" } });
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
    issueLabels: t.field({
      type: IssueLabelConnection,
      args: pageArgs,
      resolve: async (_root, args, ctx) => {
        requireViewer(ctx);
        return paginate(await db(ctx).select().from(labels).orderBy(asc(labels.name)).all(), args);
      },
    }),
    auditEntries: t.field({
      type: AuditEntryConnection,
      description: "The company's history, newest first.",
      args: {
        first: t.arg.int({ required: false }),
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
        const first = Math.min(Math.max(args.first ?? 50, 1), 250);
        const rows = await db(ctx)
          .select()
          .from(auditEvents)
          .where(
            and(
              args.before ? lt(auditEvents.createdAt, args.before.getTime()) : undefined,
              args.entityType ? eq(auditEvents.entityType, args.entityType) : undefined,
              args.entityId ? eq(auditEvents.entityId, args.entityId) : undefined,
              args.actorId ? eq(auditEvents.actorId, args.actorId) : undefined,
            ),
          )
          .orderBy(desc(auditEvents.createdAt), desc(auditEvents.id))
          .limit(first + 1)
          .all();
        const nodes = rows.slice(0, first);
        return {
          nodes,
          pageInfo: { hasNextPage: rows.length > first, endCursor: nodes.at(-1)?.id ?? null },
        };
      },
    }),
  }),
});

const ApiTokenPayload = builder
  .objectRef<{ id: string; token: string; user: UserRow }>("ApiTokenPayload")
  .implement({
    fields: (t) => ({
      success: t.boolean({ resolve: () => true }),
      id: t.exposeID("id"),
      token: t.exposeString("token", { description: "Shown once. Store it securely." }),
      user: t.field({ type: User, resolve: (p) => p.user }),
    }),
  });

builder.mutationType({
  fields: (t) => ({
    apiTokenCreate: t.field({
      type: ApiTokenPayload,
      description: "Owner only: issues an API token for yourself or an agent.",
      args: {
        name: t.arg.string({ required: true }),
        userId: t.arg.string({ required: false, description: "Defaults to you." }),
      },
      resolve: async (_root, args, ctx) => {
        const viewer = requireViewer(ctx);
        if (viewer.user.kind !== "owner") {
          throw createGraphQLError("Only the owner can issue API tokens", {
            extensions: { code: "FORBIDDEN" },
          });
        }
        const userId = args.userId ?? viewer.user.id;
        const user = await db(ctx).select().from(users).where(eq(users.id, userId)).get();
        if (!user)
          throw createGraphQLError("User not found", { extensions: { code: "NOT_FOUND" } });
        const at = ctx.deps.now?.() ?? Date.now();
        const created = await createApiToken(
          db(ctx),
          { userId, name: args.name, actorId: viewer.user.id },
          at,
        );
        return { ...created, user };
      },
    }),
  }),
});

export const schema = builder.toSchema();
