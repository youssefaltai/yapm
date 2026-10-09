import type { AuditFilter, MetricScope, metricSnapshots } from "@life-os/schema";
import { createGraphQLError } from "graphql-yoga";
import {
  addCounts,
  archiveMetric,
  countAll,
  createMetric,
  deriveMetrics,
  emptyCounts,
  listMetrics,
  type MetricRow,
  type Metrics,
  type MetricValue,
  metricHistory,
  metricValues,
  type RouteStats,
  requireMetric,
  routeStats,
  scopeKey,
  updateMetric,
} from "../services/metrics.js";
import { act, builder, db, now, requireViewer } from "./builder.js";
import { payload } from "./mutations.js";
import { Team, User } from "./types.js";

const DAY = 86_400_000;

const MetricsRef = builder.objectRef<Metrics>("Metrics").implement({
  description:
    "How work went over a period. Rates are 0–1; null when there was nothing to measure.",
  fields: (t) => ({
    created: t.exposeInt("created", { description: "Issues created." }),
    completed: t.exposeInt("completed", { description: "Issues completed." }),
    cycleTimeHours: t.exposeFloat("cycleTimeHours", {
      nullable: true,
      description: "Average hours from start (or creation) to completion.",
    }),
    slaBreaches: t.exposeInt("slaBreaches"),
    runs: t.exposeInt("runs", { description: "Agent runs that ended." }),
    runSuccessRate: t.exposeFloat("runSuccessRate", { nullable: true }),
    stopRate: t.exposeFloat("stopRate", {
      nullable: true,
      description: "Share of runs the owner stopped.",
    }),
    requestsAnswered: t.exposeInt("requestsAnswered"),
    rejectionRate: t.exposeFloat("rejectionRate", {
      nullable: true,
      description: "Share of answered approval requests that were rejected.",
    }),
    tokens: t.exposeFloat("tokens", { description: "Model tokens used by runs." }),
    tokensPerCompletedIssue: t.exposeFloat("tokensPerCompletedIssue", { nullable: true }),
    costUsd: t.exposeFloat("costUsd", {
      description: "What runs would cost at API prices, as the Agent SDK reports it.",
    }),
    costPerCompletedIssue: t.exposeFloat("costPerCompletedIssue", { nullable: true }),
  }),
});

const RouteMetrics = builder.objectRef<RouteStats>("RouteMetrics").implement({
  description:
    "How runs on one model route did: one kind, tier, model, effort and routing rule. Compare routes by success rate and cost per completed run before changing the routing.",
  fields: (t) => ({
    kind: t.exposeString("kind"),
    modelTier: t.exposeString("modelTier"),
    model: t.exposeString("model", { nullable: true }),
    effort: t.exposeString("effort", { nullable: true }),
    routeRule: t.exposeString("routeRule", { nullable: true }),
    runs: t.exposeInt("runs"),
    completed: t.exposeInt("completed"),
    failed: t.exposeInt("failed"),
    stopped: t.exposeInt("stopped"),
    tokens: t.exposeFloat("tokens"),
    costUsd: t.exposeFloat("costUsd"),
    successRate: t.exposeFloat("successRate", { nullable: true }),
    costPerCompletedRun: t.exposeFloat("costPerCompletedRun", { nullable: true }),
  }),
});

const TeamMetrics = builder
  .objectRef<{ teamId: string; metrics: Metrics }>("TeamMetrics")
  .implement({
    fields: (t) => ({
      team: t.field({
        type: Team,
        nullable: true,
        resolve: (r, _a, ctx) => ctx.loaders.team.load(r.teamId),
      }),
      metrics: t.field({ type: MetricsRef, resolve: (r) => r.metrics }),
    }),
  });

const UserMetrics = builder
  .objectRef<{ userId: string; metrics: Metrics }>("UserMetrics")
  .implement({
    fields: (t) => ({
      user: t.field({
        type: User,
        nullable: true,
        resolve: (r, _a, ctx) => ctx.loaders.user.load(r.userId),
      }),
      metrics: t.field({ type: MetricsRef, resolve: (r) => r.metrics }),
    }),
  });

const MetricFilter = builder.objectRef<AuditFilter>("MetricFilter").implement({
  description: "Audit log entries with this action, and of this entity type when given.",
  fields: (t) => ({
    action: t.exposeString("action"),
    entityType: t.string({ nullable: true, resolve: (f) => f.entityType ?? null }),
  }),
});

const Metric = builder.objectRef<MetricRow>("Metric").implement({
  description:
    "A measure the company agreed on, counted from the audit log: the numerator, or the numerator divided by the denominator.",
  fields: (t) => ({
    id: t.exposeID("id"),
    name: t.exposeString("name"),
    description: t.exposeString("description", { nullable: true }),
    numerator: t.field({ type: MetricFilter, resolve: (m) => m.numerator }),
    denominator: t.field({ type: MetricFilter, nullable: true, resolve: (m) => m.denominator }),
    unit: t.exposeString("unit", { nullable: true }),
    target: t.exposeFloat("target", { nullable: true }),
    direction: t.exposeString("direction", {
      nullable: true,
      description: "Which way is better: up or down.",
    }),
    creator: t.field({
      type: User,
      nullable: true,
      resolve: (m, _a, ctx) => (m.creatorId ? ctx.loaders.user.load(m.creatorId) : null),
    }),
    createdAt: t.field({ type: "DateTime", resolve: (m) => m.createdAt }),
    updatedAt: t.field({ type: "DateTime", resolve: (m) => m.updatedAt }),
    archivedAt: t.field({ type: "DateTime", nullable: true, resolve: (m) => m.archivedAt }),
  }),
});

const MetricValueRef = builder.objectRef<MetricValue>("MetricValue").implement({
  description:
    "A metric's value over a period and the period before; null with nothing to divide by.",
  fields: (t) => ({
    metric: t.field({ type: Metric, resolve: (v) => v.metric }),
    value: t.exposeFloat("value", { nullable: true }),
    previousValue: t.exposeFloat("previousValue", { nullable: true }),
  }),
});

const Insights = builder
  .objectRef<{
    from: number;
    to: number;
    company: Metrics;
    teams: { teamId: string; metrics: Metrics }[];
    users: { userId: string; metrics: Metrics }[];
    routes: RouteStats[];
  }>("Insights")
  .implement({
    description: "The company's metrics over a period, overall and per team and member.",
    fields: (t) => ({
      from: t.field({ type: "DateTime", resolve: (i) => i.from }),
      to: t.field({ type: "DateTime", resolve: (i) => i.to }),
      company: t.field({ type: MetricsRef, resolve: (i) => i.company }),
      teams: t.field({ type: [TeamMetrics], resolve: (i) => i.teams }),
      users: t.field({ type: [UserMetrics], resolve: (i) => i.users }),
      routes: t.field({
        type: [RouteMetrics],
        description: "Runs grouped by model route, most expensive first.",
        resolve: (i) => i.routes,
      }),
      metrics: t.field({
        type: [MetricValueRef],
        description: "The company's own metrics, for everyone or for one member.",
        args: { userId: t.arg.string({ required: false }) },
        resolve: (i, args, ctx) => metricValues(db(ctx), i.from, i.to, args.userId ?? null),
      }),
    }),
  });

type SnapshotRow = typeof metricSnapshots.$inferSelect;

const MetricSnapshot = builder.objectRef<SnapshotRow>("MetricSnapshot").implement({
  description: "One local day's metrics, kept by the hub after the day ends.",
  fields: (t) => ({
    date: t.exposeString("date", { description: "YYYY-MM-DD in the company's time zone." }),
    metrics: t.field({
      type: MetricsRef,
      resolve: (s) => deriveMetrics(addCounts(emptyCounts(), s.counts)),
    }),
  }),
});

function scopeOf(args: { teamId?: string | null; userId?: string | null }): [MetricScope, string] {
  if (args.teamId && args.userId)
    throw createGraphQLError("Pass a team or a member, not both", {
      extensions: { code: "BAD_REQUEST" },
    });
  if (args.teamId) return ["team", args.teamId];
  if (args.userId) return ["user", args.userId];
  return ["company", ""];
}

builder.queryFields((t) => ({
  insights: t.field({
    type: Insights,
    description: "Metrics for the last `days` days (default 7), overall and per team and member.",
    args: { days: t.arg.int({ required: false }) },
    resolve: async (_root, args, ctx) => {
      requireViewer(ctx);
      const to = now(ctx);
      const days = Math.min(Math.max(args.days ?? 7, 1), 365);
      const from = to - days * DAY;
      const [all, routes] = await Promise.all([
        countAll(db(ctx), from, to),
        routeStats(db(ctx), from, to),
      ]);
      const teams: { teamId: string; metrics: Metrics }[] = [];
      const users: { userId: string; metrics: Metrics }[] = [];
      for (const [key, counts] of all) {
        const [scope, id = ""] = key.split(":");
        if (scope === "team") teams.push({ teamId: id, metrics: deriveMetrics(counts) });
        if (scope === "user") users.push({ userId: id, metrics: deriveMetrics(counts) });
      }
      return {
        from,
        to,
        company: deriveMetrics(all.get(scopeKey("company")) ?? emptyCounts()),
        teams,
        users,
        routes,
      };
    },
  }),
  metricHistory: t.field({
    type: [MetricSnapshot],
    description: "Daily metrics, oldest first, for the company or one team or member.",
    args: {
      teamId: t.arg.string({ required: false }),
      userId: t.arg.string({ required: false }),
      days: t.arg.int({ required: false, description: "Default 30." }),
    },
    resolve: (_root, args, ctx) => {
      requireViewer(ctx);
      const [scope, id] = scopeOf(args);
      return metricHistory(db(ctx), scope, id, args.days ?? 30, now(ctx));
    },
  }),
}));

const MetricFilterInput = builder.inputType("MetricFilterInput", {
  fields: (t) => ({
    action: t.string({ required: true, description: "An audit action, e.g. issue.create." }),
    entityType: t.string({ required: false, description: "e.g. issue" }),
  }),
});

const metricFields = (required: boolean) =>
  builder.inputType(required ? "MetricCreateInput" : "MetricUpdateInput", {
    fields: (t) => ({
      name: t.string({ required }),
      description: t.string({ required: false }),
      numerator: t.field({ type: MetricFilterInput, required }),
      denominator: t.field({
        type: MetricFilterInput,
        required: false,
        description: "Makes it a ratio; null makes it a count.",
      }),
      unit: t.string({ required: false }),
      target: t.float({ required: false }),
      direction: t.string({ required: false, description: "Which way is better: up or down." }),
    }),
  });
const MetricCreateInput = metricFields(true);
const MetricUpdateInput = metricFields(false);
const MetricPayload = payload("MetricPayload", "metric", Metric);

builder.queryFields((t) => ({
  metrics: t.field({
    type: [Metric],
    description: "The metrics the company defined, by name. Values are on insights.",
    resolve: (_root, _args, ctx) => {
      requireViewer(ctx);
      return listMetrics(db(ctx));
    },
  }),
}));

builder.mutationFields((t) => ({
  metricCreate: t.field({
    type: MetricPayload,
    description: "Defines a metric. Agents need metric.update.",
    args: { input: t.arg({ type: MetricCreateInput, required: true }) },
    resolve: async (_root, args, ctx) => {
      const id = await act(ctx, (s) => createMetric(s, args.input));
      return { entity: await requireMetric(db(ctx), id) };
    },
  }),
  metricUpdate: t.field({
    type: MetricPayload,
    description: "Changes a metric. Agents need metric.update.",
    args: {
      id: t.arg.string({ required: true }),
      input: t.arg({ type: MetricUpdateInput, required: true }),
    },
    resolve: async (_root, args, ctx) => {
      const id = await act(ctx, (s) => updateMetric(s, args.id, args.input));
      return { entity: await requireMetric(db(ctx), id) };
    },
  }),
  metricArchive: t.field({
    type: MetricPayload,
    description: "Stops measuring a metric. Agents need metric.update.",
    args: { id: t.arg.string({ required: true }) },
    resolve: async (_root, args, ctx) => {
      const id = await act(ctx, (s) => archiveMetric(s, args.id));
      return { entity: await requireMetric(db(ctx), id) };
    },
  }),
}));
