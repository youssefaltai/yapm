import {
  type ClaudeAccount,
  type OpencodePlan,
  PLAN_PROVIDERS,
  type PlanLimit,
  type PlanUsage,
} from "@yapm/schema";
import {
  claudeSubscriptions,
  type Subscription,
  USAGE_GROUPS,
  type UsagePoint,
  usageHistory,
} from "../services/usage.js";
import { builder, db, now, requireViewer } from "./builder.js";
import { Machine } from "./runs.js";

const DAY = 86_400_000;

const ClaudeAccountRef = builder.objectRef<ClaudeAccount>("ClaudeAccount").implement({
  description: "The Claude login a machine's agents use, as Claude Code reports it.",
  fields: (t) => ({
    email: t.exposeString("email", { nullable: true }),
    organization: t.exposeString("organization", { nullable: true }),
    subscriptionType: t.exposeString("subscriptionType", {
      nullable: true,
      description: "pro, max, team or enterprise; null with an API key.",
    }),
    apiProvider: t.exposeString("apiProvider", {
      nullable: true,
      description: "firstParty for a Claude login; bedrock, vertex and others have no plan.",
    }),
  }),
});

const PlanLimitRef = builder.objectRef<PlanLimit>("PlanLimit").implement({
  description:
    "One of the plan's usage windows, such as the 5-hour session or the week. Plans publish how full a window is, not its size in tokens.",
  fields: (t) => ({
    kind: t.exposeString("kind", {
      description:
        "five_hour, seven_day, seven_day_opus, seven_day_sonnet, model:<name>, or monthly (Copilot).",
    }),
    label: t.exposeString("label"),
    utilization: t.exposeFloat("utilization", {
      nullable: true,
      description: "Percent of the window used, 0–100.",
    }),
    resetsAt: t.field({ type: "DateTime", nullable: true, resolve: (l) => l.resetsAt }),
    status: t.exposeString("status", {
      nullable: true,
      description: "allowed, allowed_warning or rejected, when Claude Code said.",
    }),
  }),
});

const ExtraUsageRef = builder
  .objectRef<NonNullable<PlanUsage["extraUsage"]>>("PlanExtraUsage")
  .implement({
    description: "Pay-as-you-go usage beyond the plan, for the billing month.",
    fields: (t) => ({
      enabled: t.exposeBoolean("enabled"),
      monthlyLimit: t.exposeFloat("monthlyLimit", {
        nullable: true,
        description: "In minor units of the currency (cents for USD).",
      }),
      usedCredits: t.exposeFloat("usedCredits", { nullable: true }),
      utilization: t.exposeFloat("utilization", { nullable: true }),
      currency: t.exposeString("currency", { nullable: true }),
    }),
  });

const PlanUsageRef = builder.objectRef<PlanUsage>("PlanUsage").implement({
  description: "The subscription's limits as a machine last read them.",
  fields: (t) => ({
    observedAt: t.field({ type: "DateTime", resolve: (p) => p.observedAt }),
    source: t.exposeString("source", {
      description:
        "usage: a full reading of Claude Code's /usage. rate_limit: only the windows a run's rate-limit events mentioned.",
    }),
    available: t.exposeBoolean("available", {
      description: "False when plan limits don't apply, such as with an API key.",
    }),
    limits: t.field({ type: [PlanLimitRef], resolve: (p) => p.limits }),
    extraUsage: t.field({ type: ExtraUsageRef, nullable: true, resolve: (p) => p.extraUsage }),
  }),
});

type MachinePlan = Omit<OpencodePlan, "provider" | "usage"> & {
  provider: (typeof PLAN_PROVIDERS)[number];
  usage: PlanUsage | null;
};

const MachinePlanRef = builder.objectRef<MachinePlan>("MachinePlan").implement({
  description:
    "A plan a machine's agents run on: its Claude login's, or OpenCode's ChatGPT or Copilot plan.",
  fields: (t) => ({
    provider: t.field({
      type: builder.enumType("PlanProvider", { values: PLAN_PROVIDERS }),
      resolve: (p) => p.provider,
    }),
    name: t.exposeString("name", {
      nullable: true,
      description: "max, plus…, when the provider says.",
    }),
    usage: t.field({
      type: PlanUsageRef,
      nullable: true,
      description: "Its limits as the machine last read them; OpenCode's after a run on the plan.",
      resolve: (p) => p.usage,
    }),
  }),
});

builder.objectFields(Machine, (t) => ({
  plans: t.field({
    type: [MachinePlanRef],
    description: "Every plan the machine reports, Claude's first.",
    resolve: (m) => [
      ...(m.claudeAccount || m.planUsage
        ? [
            {
              provider: "claude" as const,
              name: m.claudeAccount?.subscriptionType ?? null,
              usage: m.planUsage,
            },
          ]
        : []),
      ...(m.plans ?? []),
    ],
  }),
  claudeAccount: t.field({
    type: ClaudeAccountRef,
    nullable: true,
    resolve: (m) => m.claudeAccount,
  }),
  planUsage: t.field({
    type: PlanUsageRef,
    nullable: true,
    description: "The plan's limits as this machine last read them.",
    resolve: (m) => m.planUsage,
  }),
}));

const ClaudeSubscriptionRef = builder.objectRef<Subscription>("ClaudeSubscription").implement({
  description:
    "A Claude login and the machines that use it. They draw from one plan, so they share its limits.",
  fields: (t) => ({
    id: t.exposeID("id"),
    account: t.field({ type: ClaudeAccountRef, nullable: true, resolve: (s) => s.account }),
    machines: t.field({ type: [Machine], resolve: (s) => s.machines }),
    planUsage: t.field({
      type: PlanUsageRef,
      nullable: true,
      description: "The newest reading from any of its machines.",
      resolve: (s) => s.planUsage,
    }),
    reportedBy: t.field({ type: Machine, nullable: true, resolve: (s) => s.reportedBy }),
  }),
});

const UsageGroupBy = builder.enumType("UsageGroupBy", { values: USAGE_GROUPS });

const UsagePointRef = builder.objectRef<UsagePoint>("UsagePoint").implement({
  description: "What runs used on one day, for one agent, model or machine.",
  fields: (t) => ({
    date: t.exposeString("date", { description: "YYYY-MM-DD in the company's time zone." }),
    key: t.exposeString("key", {
      description: "The agent id, model id (OpenCode's start with `opencode:`) or machine id.",
    }),
    label: t.exposeString("label"),
    runs: t.exposeInt("runs"),
    inputTokens: t.exposeFloat("inputTokens"),
    outputTokens: t.exposeFloat("outputTokens"),
    costUsd: t.exposeFloat("costUsd", {
      description:
        "What the runs cost as their engines report it: at API prices from Claude, OpenCode's own figure (0 on a subscription) from OpenCode. Not what a plan charges.",
    }),
  }),
});

builder.queryFields((t) => ({
  claudeSubscriptions: t.field({
    type: [ClaudeSubscriptionRef],
    description: "The Claude logins the company's machines use, with each plan's limits.",
    resolve: (_root, _args, ctx) => {
      requireViewer(ctx);
      return claudeSubscriptions(db(ctx));
    },
  }),
  usageHistory: t.field({
    type: [UsagePointRef],
    description: "Run usage per day over the last `days` days (default 30), oldest first.",
    args: {
      groupBy: t.arg({ type: UsageGroupBy, required: true }),
      days: t.arg.int({ required: false }),
    },
    resolve: (_root, args, ctx) => {
      requireViewer(ctx);
      const to = now(ctx);
      const days = Math.min(Math.max(args.days ?? 30, 1), 365);
      return usageHistory(db(ctx), args.groupBy, to - days * DAY, to);
    },
  }),
}));
