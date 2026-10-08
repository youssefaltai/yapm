import { customViews, cycles, issues, workspaces } from "@life-os/schema";
import { and, asc, count, desc, eq, isNull, or } from "drizzle-orm";
import { createGraphQLError } from "graphql-yoga";
import { audit } from "../audit.js";
import { commit } from "../db.js";
import { badRequest, notFound } from "../errors.js";
import { changes, event } from "../services/common.js";
import { activeCycle, requireCycle, updateCycle } from "../services/cycles.js";
import { rescheduleAll } from "../services/templates.js";
import { canSeeView, createView, deleteView, requireView, updateView } from "../services/views.js";
import { isTimeZone } from "../time.js";
import {
  act,
  builder,
  connection,
  db,
  notFoundError,
  now,
  pageArgs,
  paginate,
  requireOwner,
  requireViewer,
} from "./builder.js";
import { type IssueFilterShape, issueArgs, issueWhere, queryIssues } from "./filters.js";
import { DeletePayload, payload } from "./mutations.js";
import { Issue, IssueConnection, Organization, Team, User } from "./types.js";

type CycleRow = typeof cycles.$inferSelect;
type ViewRow = typeof customViews.$inferSelect;

export const Cycle = builder.objectRef<CycleRow>("Cycle");
export const CustomView = builder.objectRef<ViewRow>("CustomView");
const CycleConnection = connection<CycleRow>("Cycle", Cycle);
const CustomViewConnection = connection<ViewRow>("CustomView", CustomView);

Cycle.implement({
  description: "A team's time-boxed sprint. The hub opens and closes cycles on schedule.",
  fields: (t) => ({
    id: t.exposeID("id"),
    number: t.exposeInt("number"),
    name: t.exposeString("name", { nullable: true }),
    startsAt: t.field({ type: "DateTime", resolve: (c) => c.startsAt }),
    endsAt: t.field({ type: "DateTime", resolve: (c) => c.endsAt }),
    completedAt: t.field({ type: "DateTime", nullable: true, resolve: (c) => c.completedAt }),
    createdAt: t.field({ type: "DateTime", resolve: (c) => c.createdAt }),
    updatedAt: t.field({ type: "DateTime", resolve: (c) => c.updatedAt }),
    isActive: t.boolean({
      resolve: (c, _args, ctx) => !c.completedAt && c.startsAt <= now(ctx) && c.endsAt > now(ctx),
    }),
    isFuture: t.boolean({ resolve: (c, _args, ctx) => c.startsAt > now(ctx) }),
    isPast: t.boolean({ resolve: (c, _args, ctx) => !!c.completedAt || c.endsAt <= now(ctx) }),
    scopeHistory: t.intList({
      description: "Issues in the cycle at the end of each day, for the burn-up chart.",
      resolve: (c) => c.history.scope,
    }),
    completedScopeHistory: t.intList({ resolve: (c) => c.history.completed }),
    uncompletedIssuesUponCloseCount: t.int({
      nullable: true,
      resolve: (c) => c.uncompletedCount,
    }),
    progress: t.float({
      description: "Completed share of the cycle's issues, from 0 to 1 (canceled ones excluded).",
      resolve: async (c, _args, ctx) => {
        const row = await db(ctx)
          .select({
            total: count(),
            completed: count(issues.completedAt),
            canceled: count(issues.canceledAt),
          })
          .from(issues)
          .where(and(eq(issues.cycleId, c.id), isNull(issues.archivedAt)))
          .get();
        const scope = (row?.total ?? 0) - (row?.canceled ?? 0);
        return scope > 0 ? (row?.completed ?? 0) / scope : 0;
      },
    }),
    team: t.field({
      type: Team,
      resolve: async (c, _args, ctx) => {
        const team = await ctx.loaders.team.load(c.teamId);
        if (!team) throw notFoundError("Team");
        return team;
      },
    }),
    issues: t.field({
      type: IssueConnection,
      args: issueArgs,
      resolve: (c, args, ctx) =>
        queryIssues(db(ctx), args, requireViewer(ctx).user.id, eq(issues.cycleId, c.id)),
    }),
  }),
});

CustomView.implement({
  description: "A saved issue filter, like Linear's custom views.",
  fields: (t) => ({
    id: t.exposeID("id"),
    name: t.exposeString("name"),
    description: t.exposeString("description", { nullable: true }),
    icon: t.exposeString("icon", { nullable: true }),
    color: t.exposeString("color", { nullable: true }),
    shared: t.exposeBoolean("shared"),
    filterData: t.field({ type: "JSONObject", resolve: (v) => v.filterData }),
    createdAt: t.field({ type: "DateTime", resolve: (v) => v.createdAt }),
    updatedAt: t.field({ type: "DateTime", resolve: (v) => v.updatedAt }),
    owner: t.field({
      type: User,
      nullable: true,
      resolve: (v, _args, ctx) => ctx.loaders.user.load(v.ownerId),
    }),
    team: t.field({
      type: Team,
      nullable: true,
      resolve: (v, _args, ctx) => (v.teamId ? ctx.loaders.team.load(v.teamId) : null),
    }),
    issues: t.field({
      type: IssueConnection,
      args: issueArgs,
      description: "Issues matching the view's filter (and any extra filter given here).",
      resolve: (v, args, ctx) => {
        const viewerId = requireViewer(ctx).user.id;
        const scope = and(
          v.teamId ? eq(issues.teamId, v.teamId) : undefined,
          issueWhere(db(ctx), v.filterData as IssueFilterShape, viewerId),
        );
        return queryIssues(db(ctx), args, viewerId, scope);
      },
    }),
  }),
});

builder.objectFields(Team, (t) => ({
  slaHours: t.field({
    type: "JSONObject",
    nullable: true,
    description: 'Hours to finish an issue by priority, e.g. { "1": 24 }; null when off.',
    resolve: (team) => team.slaHours,
  }),
  autoArchivePeriod: t.exposeInt("autoArchivePeriod", {
    description: "Months after which closed issues are archived; 0 never.",
  }),
  triageEnabled: t.exposeBoolean("triageEnabled"),
  cyclesEnabled: t.exposeBoolean("cyclesEnabled"),
  cycleDuration: t.exposeInt("cycleDuration", { description: "Weeks per cycle." }),
  cycleStartDay: t.exposeInt("cycleStartDay", { description: "0 Sunday … 6 Saturday." }),
  cycleCooldownTime: t.exposeInt("cycleCooldown", { description: "Weeks between cycles." }),
  upcomingCycleCount: t.exposeInt("upcomingCycleCount"),
  activeCycle: t.field({
    type: Cycle,
    nullable: true,
    resolve: (team, _args, ctx) => activeCycle(db(ctx), team.id, now(ctx)),
  }),
  cycles: t.field({
    type: CycleConnection,
    description: "Newest first.",
    args: pageArgs,
    resolve: async (team, args, ctx) =>
      paginate(
        await db(ctx)
          .select()
          .from(cycles)
          .where(eq(cycles.teamId, team.id))
          .orderBy(desc(cycles.number))
          .all(),
        args,
      ),
  }),
}));

builder.objectFields(Issue, (t) => ({
  slaStartedAt: t.field({ type: "DateTime", nullable: true, resolve: (i) => i.slaStartedAt }),
  slaBreachesAt: t.field({
    type: "DateTime",
    nullable: true,
    description: "When the issue misses its SLA, if its team has one for its priority.",
    resolve: (i) => i.slaBreachesAt,
  }),
}));

builder.objectField(Issue, "cycle", (t) =>
  t.field({
    type: Cycle,
    nullable: true,
    resolve: (issue, _args, ctx) => (issue.cycleId ? ctx.loaders.cycle.load(issue.cycleId) : null),
  }),
);

builder.objectField(Organization, "timezone", (t) =>
  t.exposeString("timezone", { description: "IANA time zone for cycles and recurring issues." }),
);

builder.queryFields((t) => ({
  cycle: t.field({
    type: Cycle,
    args: { id: t.arg.string({ required: true }) },
    resolve: async (_root, args, ctx) => {
      requireViewer(ctx);
      const row = await db(ctx).select().from(cycles).where(eq(cycles.id, args.id)).get();
      if (!row) throw notFoundError("Cycle");
      return row;
    },
  }),
  customViews: t.field({
    type: CustomViewConnection,
    description: "Shared views and the viewer's own.",
    args: pageArgs,
    resolve: async (_root, args, ctx) => {
      const viewer = requireViewer(ctx);
      return paginate(
        await db(ctx)
          .select()
          .from(customViews)
          .where(or(eq(customViews.shared, true), eq(customViews.ownerId, viewer.user.id)))
          .orderBy(asc(customViews.sortOrder))
          .all(),
        args,
      );
    },
  }),
  customView: t.field({
    type: CustomView,
    args: { id: t.arg.string({ required: true }) },
    resolve: async (_root, args, ctx) => {
      const viewer = requireViewer(ctx);
      const row = await db(ctx).select().from(customViews).where(eq(customViews.id, args.id)).get();
      if (!row || !canSeeView(row, viewer.user.id)) throw notFoundError("View");
      return row;
    },
  }),
}));

const CyclePayload = payload("CyclePayload", "cycle", Cycle);
const CustomViewPayload = payload("CustomViewPayload", "customView", CustomView);
const OrganizationPayload = payload("OrganizationPayload", "organization", Organization);

const CycleUpdateInput = builder.inputType("CycleUpdateInput", {
  fields: (t) => ({ name: t.string({ required: false }) }),
});

const CustomViewCreateInput = builder.inputType("CustomViewCreateInput", {
  fields: (t) => ({
    name: t.string({ required: true }),
    description: t.string({ required: false }),
    icon: t.string({ required: false }),
    color: t.string({ required: false }),
    teamId: t.string({ required: false }),
    shared: t.boolean({ required: false, description: "Defaults to true." }),
    filterData: t.field({ type: "JSONObject", required: true, description: "An IssueFilter." }),
  }),
});

const CustomViewUpdateInput = builder.inputType("CustomViewUpdateInput", {
  fields: (t) => ({
    name: t.string({ required: false }),
    description: t.string({ required: false }),
    icon: t.string({ required: false }),
    color: t.string({ required: false }),
    teamId: t.string({ required: false }),
    shared: t.boolean({ required: false }),
    filterData: t.field({ type: "JSONObject", required: false }),
  }),
});

const OrganizationUpdateInput = builder.inputType("OrganizationUpdateInput", {
  fields: (t) => ({
    name: t.string({ required: false }),
    timezone: t.string({ required: false, description: "IANA name, e.g. Europe/Berlin." }),
  }),
});

builder.mutationFields((t) => ({
  cycleUpdate: t.field({
    type: CyclePayload,
    args: {
      id: t.arg.string({ required: true }),
      input: t.arg({ type: CycleUpdateInput, required: true }),
    },
    resolve: async (_root, args, ctx) => {
      const id = await act(ctx, (s) => updateCycle(s, args.id, args.input));
      return { entity: await requireCycle(db(ctx), id) };
    },
  }),
  organizationUpdate: t.field({
    type: OrganizationPayload,
    description: "Renames the company or sets its time zone. Owner only.",
    args: { input: t.arg({ type: OrganizationUpdateInput, required: true }) },
    resolve: async (_root, args, ctx) => {
      requireOwner(ctx);
      await act(ctx, async (s) => {
        const company = await s.db.select().from(workspaces).get();
        if (!company) throw notFound("Company");
        const next: Partial<typeof company> = {};
        if (args.input.name != null) {
          const name = args.input.name.trim();
          if (!name || name.length > 80) throw badRequest("Company name must be 1–80 characters");
          next.name = name;
        }
        if (args.input.timezone != null) {
          if (!isTimeZone(args.input.timezone)) throw badRequest("Unknown time zone");
          next.timezone = args.input.timezone;
        }
        const diff = changes(company, next);
        if (!diff) return;
        await commit(s.db, [
          s.db
            .update(workspaces)
            .set({ ...next, updatedAt: s.now })
            .where(eq(workspaces.id, company.id)),
          ...audit(
            s.db,
            [event(s, "organization.update", "organization", company.id, diff)],
            s.now,
          ),
        ]);
        if (next.timezone) await rescheduleAll(s.db, next.timezone, s.now);
      });
      const row = await db(ctx).select().from(workspaces).get();
      if (!row) throw createGraphQLError("The company has not been set up yet");
      return { entity: row };
    },
  }),
  customViewCreate: t.field({
    type: CustomViewPayload,
    args: { input: t.arg({ type: CustomViewCreateInput, required: true }) },
    resolve: async (_root, args, ctx) => {
      const id = await act(ctx, (s) => createView(s, args.input));
      return { entity: await requireView(db(ctx), id) };
    },
  }),
  customViewUpdate: t.field({
    type: CustomViewPayload,
    args: {
      id: t.arg.string({ required: true }),
      input: t.arg({ type: CustomViewUpdateInput, required: true }),
    },
    resolve: async (_root, args, ctx) => {
      const id = await act(ctx, (s) => updateView(s, args.id, args.input));
      return { entity: await requireView(db(ctx), id) };
    },
  }),
  customViewDelete: t.field({
    type: DeletePayload,
    args: { id: t.arg.string({ required: true }) },
    resolve: async (_root, args, ctx) => {
      await act(ctx, (s) => deleteView(s, args.id));
      return { entityId: args.id };
    },
  }),
}));
