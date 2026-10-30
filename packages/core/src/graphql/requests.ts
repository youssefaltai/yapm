import { GRANT_SCOPES, grants, REQUEST_STATUSES, requests } from "@yapm/schema";
import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import {
  approveRequest,
  cancelRequest,
  checkPermission,
  createGrant,
  createRequest,
  grantsFor,
  rejectRequest,
  revokeGrant,
  updateGrant,
  usePermission,
} from "../services/requests.js";
import {
  act,
  builder,
  connection,
  db,
  notFoundError,
  pageArgs,
  paginate,
  requireViewer,
} from "./builder.js";
import { Issue, Team, User } from "./types.js";

type RequestRow = typeof requests.$inferSelect;
type GrantRow = typeof grants.$inferSelect;

const RequestStatus = builder.enumType("RequestStatus", { values: REQUEST_STATUSES });
const GrantScope = builder.enumType("GrantScope", { values: GRANT_SCOPES });

export const Request = builder.objectRef<RequestRow>("Request");
export const Grant = builder.objectRef<GrantRow>("Grant");
const RequestConnection = connection<RequestRow>("Request", Request);
export const GrantConnection = connection<GrantRow>("Grant", Grant);

Request.implement({
  description:
    "An agent asking for something it isn't allowed to do yet. Approved once, it may do it one time; always allowing it also creates a grant.",
  fields: (t) => ({
    id: t.exposeID("id"),
    title: t.exposeString("title"),
    action: t.exposeString("action", {
      description: "The permission, e.g. `agent.hire` or `tool:Bash`.",
    }),
    resource: t.exposeString("resource", { nullable: true }),
    reason: t.exposeString("reason"),
    details: t.exposeString("details", { nullable: true }),
    status: t.field({ type: RequestStatus, resolve: (r) => r.status }),
    answer: t.exposeString("answer", {
      nullable: true,
      description: "The rejection reason, or the owner's note with an approval.",
    }),
    used: t.boolean({
      description: "Whether a one-time approval has been used up.",
      resolve: (r) => r.consumedAt !== null,
    }),
    runId: t.exposeString("runId", { nullable: true }),
    createdAt: t.field({ type: "DateTime", resolve: (r) => r.createdAt }),
    updatedAt: t.field({ type: "DateTime", resolve: (r) => r.updatedAt }),
    answeredAt: t.field({ type: "DateTime", nullable: true, resolve: (r) => r.answeredAt }),
    requester: t.field({
      type: User,
      resolve: async (r, _args, ctx) => (await ctx.loaders.user.load(r.requesterId)) as never,
    }),
    answeredBy: t.field({
      type: User,
      nullable: true,
      resolve: (r, _args, ctx) => (r.answeredById ? ctx.loaders.user.load(r.answeredById) : null),
    }),
    issue: t.field({
      type: Issue,
      nullable: true,
      resolve: (r, _args, ctx) => (r.issueId ? ctx.loaders.issue.load(r.issueId) : null),
    }),
    grant: t.field({
      type: Grant,
      nullable: true,
      resolve: (r, _args, ctx) =>
        r.grantId
          ? (db(ctx).select().from(grants).where(eq(grants.id, r.grantId)).get() ?? null)
          : null,
    }),
  }),
});

Grant.implement({
  description: "A standing permission for one agent, a team, or everyone.",
  fields: (t) => ({
    id: t.exposeID("id"),
    action: t.exposeString("action"),
    resource: t.exposeString("resource", {
      nullable: true,
      description: "Null allows it on anything.",
    }),
    scope: t.field({ type: GrantScope, resolve: (g) => g.scope }),
    note: t.exposeString("note", { nullable: true }),
    useCount: t.exposeInt("useCount"),
    lastUsedAt: t.field({ type: "DateTime", nullable: true, resolve: (g) => g.lastUsedAt }),
    revokedAt: t.field({ type: "DateTime", nullable: true, resolve: (g) => g.revokedAt }),
    createdAt: t.field({ type: "DateTime", resolve: (g) => g.createdAt }),
    user: t.field({
      type: User,
      nullable: true,
      description: "The agent, when the scope is one agent.",
      resolve: (g, _args, ctx) =>
        g.scope === "user" && g.subjectId ? ctx.loaders.user.load(g.subjectId) : null,
    }),
    team: t.field({
      type: Team,
      nullable: true,
      description: "The team, when the scope is a team.",
      resolve: (g, _args, ctx) =>
        g.scope === "team" && g.subjectId ? ctx.loaders.team.load(g.subjectId) : null,
    }),
    creator: t.field({
      type: User,
      resolve: async (g, _args, ctx) => (await ctx.loaders.user.load(g.createdById)) as never,
    }),
    request: t.field({
      type: Request,
      nullable: true,
      resolve: (g, _args, ctx) =>
        g.requestId
          ? (db(ctx).select().from(requests).where(eq(requests.id, g.requestId)).get() ?? null)
          : null,
    }),
  }),
});

const Permission = builder
  .objectRef<{ allowed: boolean; via: string | null; pendingRequestId: string | null }>(
    "Permission",
  )
  .implement({
    description: "Whether the viewer may do something now.",
    fields: (t) => ({
      allowed: t.exposeBoolean("allowed"),
      via: t.exposeString("via", {
        nullable: true,
        description: "`owner`, `grant` or `approval` (a one-time approval, used up when acted on).",
      }),
      pendingRequestId: t.exposeString("pendingRequestId", {
        nullable: true,
        description: "Your request for this that is still waiting for an answer.",
      }),
    }),
  });

const RequestFilter = builder.inputType("RequestFilter", {
  fields: (t) => ({
    status: t.field({ type: [RequestStatus], required: false }),
    requesterId: t.string({ required: false }),
    issueId: t.string({ required: false }),
  }),
});

const GrantFilter = builder.inputType("GrantFilter", {
  fields: (t) => ({
    userId: t.string({
      required: false,
      description: "Grants that apply to this member: its own, its teams' and everyone's.",
    }),
    teamId: t.string({ required: false, description: "Grants for this team." }),
  }),
});

builder.queryFields((t) => ({
  requests: t.field({
    type: RequestConnection,
    description:
      "Requests, pending ones oldest first (the order to answer them), others newest first.",
    args: { ...pageArgs, filter: t.arg({ type: RequestFilter, required: false }) },
    resolve: async (_root, args, ctx) => {
      requireViewer(ctx);
      const f = args.filter;
      const onlyPending = f?.status?.length === 1 && f.status[0] === "pending";
      const rows = await db(ctx)
        .select()
        .from(requests)
        .where(
          and(
            f?.status?.length ? inArray(requests.status, f.status) : undefined,
            f?.requesterId ? eq(requests.requesterId, f.requesterId) : undefined,
            f?.issueId ? eq(requests.issueId, f.issueId) : undefined,
          ),
        )
        .orderBy(onlyPending ? asc(requests.createdAt) : desc(requests.createdAt))
        .limit(500)
        .all();
      return paginate(rows, args);
    },
  }),
  request: t.field({
    type: Request,
    args: { id: t.arg.string({ required: true }) },
    resolve: async (_root, args, ctx) => {
      requireViewer(ctx);
      const row = await db(ctx).select().from(requests).where(eq(requests.id, args.id)).get();
      if (!row) throw notFoundError("Request");
      return row;
    },
  }),
  grants: t.field({
    type: GrantConnection,
    description: "Standing permissions, newest first. Every member can read them.",
    args: {
      ...pageArgs,
      includeRevoked: t.arg.boolean({ required: false }),
      filter: t.arg({ type: GrantFilter, required: false }),
    },
    resolve: async (_root, args, ctx) => {
      requireViewer(ctx);
      const f = args.filter;
      const rows = await db(ctx)
        .select()
        .from(grants)
        .where(
          and(
            args.includeRevoked ? undefined : isNull(grants.revokedAt),
            f?.userId ? grantsFor(db(ctx), f.userId) : undefined,
            f?.teamId ? and(eq(grants.scope, "team"), eq(grants.subjectId, f.teamId)) : undefined,
          ),
        )
        .orderBy(desc(grants.createdAt))
        .all();
      return paginate(rows, args);
    },
  }),
  permission: t.field({
    type: Permission,
    description:
      "Checks whether the viewer may do `action` (on `resource`) without using anything up.",
    args: { action: t.arg.string({ required: true }), resource: t.arg.string({ required: false }) },
    resolve: async (_root, args, ctx) => {
      const viewer = requireViewer(ctx);
      const p = await checkPermission(db(ctx), viewer.user.id, args.action, args.resource ?? null);
      return p.allowed
        ? { allowed: true, via: p.via, pendingRequestId: null }
        : { allowed: false, via: null, pendingRequestId: p.pendingRequestId };
    },
  }),
}));

builder.objectField(Issue, "requests", (t) =>
  t.field({
    type: [Request],
    description: "Requests made while working on this issue, newest first.",
    resolve: (issue, _args, ctx) =>
      db(ctx)
        .select()
        .from(requests)
        .where(eq(requests.issueId, issue.id))
        .orderBy(desc(requests.createdAt))
        .all(),
  }),
);

const RequestPayload = builder.objectRef<{ id: string }>("RequestPayload").implement({
  fields: (t) => ({
    success: t.boolean({ resolve: () => true }),
    request: t.field({
      type: Request,
      resolve: async (p, _args, ctx) => {
        const row = await db(ctx).select().from(requests).where(eq(requests.id, p.id)).get();
        if (!row) throw notFoundError("Request");
        return row;
      },
    }),
  }),
});

const GrantPayload = builder.objectRef<{ id: string }>("GrantPayload").implement({
  fields: (t) => ({
    success: t.boolean({ resolve: () => true }),
    grant: t.field({
      type: Grant,
      resolve: async (p, _args, ctx) => {
        const row = await db(ctx).select().from(grants).where(eq(grants.id, p.id)).get();
        if (!row) throw notFoundError("Grant");
        return row;
      },
    }),
  }),
});

const RequestCreateInput = builder.inputType("RequestCreateInput", {
  fields: (t) => ({
    title: t.string({
      required: true,
      description: 'What you ask for, in a few words: "Hire a Head of Fitness".',
    }),
    action: t.string({
      required: true,
      description: "The permission it needs, e.g. `agent.hire` or `tool:Bash`.",
    }),
    resource: t.string({
      required: false,
      description: "What it applies to, e.g. a team id or a command.",
    }),
    reason: t.string({ required: true, description: "Why you need it." }),
    details: t.string({ required: false, description: "Markdown: exactly what you will do." }),
    issueId: t.string({ required: false }),
  }),
});

const AlwaysAllowInput = builder.inputType("AlwaysAllowInput", {
  fields: (t) => ({
    scope: t.field({ type: GrantScope, required: true }),
    teamId: t.string({ required: false, description: "Required when the scope is team." }),
    anyResource: t.boolean({
      required: false,
      description: "Allow it on anything, not only this resource.",
    }),
    action: t.string({
      required: false,
      description:
        "A wider action that covers this one, e.g. `tool:slack__*` for every Slack tool.",
    }),
  }),
});

const GrantCreateInput = builder.inputType("GrantCreateInput", {
  fields: (t) => ({
    action: t.string({ required: true }),
    resource: t.string({ required: false }),
    scope: t.field({ type: GrantScope, required: true }),
    subjectId: t.string({
      required: false,
      description: "The agent or team id; omit for everyone.",
    }),
    note: t.string({ required: false }),
  }),
});

const GrantUpdateInput = builder.inputType("GrantUpdateInput", {
  fields: (t) => ({
    action: t.string({ required: false }),
    resource: t.string({ required: false }),
    note: t.string({ required: false }),
  }),
});

builder.mutationFields((t) => ({
  permissionUse: t.field({
    type: Permission,
    description:
      "Uses a permission now if you have it: counts a grant's use or uses up a one-time approval. Doesn't throw when you lack it.",
    args: { action: t.arg.string({ required: true }), resource: t.arg.string({ required: false }) },
    resolve: async (_root, args, ctx) => {
      const p = await act(ctx, (s) => usePermission(s, args.action, args.resource ?? null));
      return p.allowed
        ? { allowed: true, via: p.via, pendingRequestId: null }
        : { allowed: false, via: null, pendingRequestId: p.pendingRequestId };
    },
  }),
  requestCreate: t.field({
    type: RequestPayload,
    description: "Asks the owner for permission. Asking again while one is pending returns it.",
    args: { input: t.arg({ type: RequestCreateInput, required: true }) },
    resolve: async (_root, args, ctx) => ({
      id: await act(ctx, (s) => createRequest(s, args.input)),
    }),
  }),
  requestApprove: t.field({
    type: RequestPayload,
    description:
      "Approves a request once, or with `alwaysAllow` (owner only) also grants it from now on. An agent answers only requests from below it in the reporting line, and approves only what its grants allow.",
    args: {
      id: t.arg.string({ required: true }),
      note: t.arg.string({ required: false }),
      alwaysAllow: t.arg({ type: AlwaysAllowInput, required: false }),
    },
    resolve: async (_root, args, ctx) => ({
      id: await act(ctx, (s) =>
        approveRequest(s, args.id, { note: args.note, always: args.alwaysAllow }),
      ),
    }),
  }),
  requestReject: t.field({
    type: RequestPayload,
    description:
      "Rejects a request. The reason is required: it tells the agent what to do instead.",
    args: { id: t.arg.string({ required: true }), reason: t.arg.string({ required: true }) },
    resolve: async (_root, args, ctx) => ({
      id: await act(ctx, (s) => rejectRequest(s, args.id, args.reason)),
    }),
  }),
  requestCancel: t.field({
    type: RequestPayload,
    args: { id: t.arg.string({ required: true }) },
    resolve: async (_root, args, ctx) => ({ id: await act(ctx, (s) => cancelRequest(s, args.id)) }),
  }),
  grantCreate: t.field({
    type: GrantPayload,
    args: { input: t.arg({ type: GrantCreateInput, required: true }) },
    resolve: async (_root, args, ctx) => ({
      id: await act(ctx, (s) => createGrant(s, args.input)),
    }),
  }),
  grantUpdate: t.field({
    type: GrantPayload,
    args: {
      id: t.arg.string({ required: true }),
      input: t.arg({ type: GrantUpdateInput, required: true }),
    },
    resolve: async (_root, args, ctx) => ({
      id: await act(ctx, (s) => updateGrant(s, args.id, args.input)),
    }),
  }),
  grantRevoke: t.field({
    type: GrantPayload,
    args: { id: t.arg.string({ required: true }) },
    resolve: async (_root, args, ctx) => ({ id: await act(ctx, (s) => revokeGrant(s, args.id)) }),
  }),
}));
