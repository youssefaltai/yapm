import {
  MACHINE_STATUSES,
  machines,
  RUN_KINDS,
  RUN_STATUSES,
  requests,
  runLogs,
  runs,
  users,
} from "@life-os/schema";
import { and, asc, count, desc, eq, gt, inArray } from "drizzle-orm";
import { audit } from "../audit.js";
import { newId } from "../crypto.js";
import { commit } from "../db.js";
import { badRequest, forbidden, notFound } from "../errors.js";
import { announce } from "../realtime.js";
import { MODEL_TIERS, type ModelTier } from "../runs/prompts.js";
import { routeRun } from "../runs/routing.js";
import { ONLINE_WINDOW, stopRun } from "../runs/service.js";
import { event } from "../services/common.js";
import { findIssue } from "../services/issues.js";
import {
  approveMachine,
  createSetupToken,
  listMachines,
  machineName,
  revokeMachine,
  updateMachine,
} from "../services/machines.js";
import {
  act,
  builder,
  connection,
  db,
  notFoundError,
  now,
  pageArgs,
  paginate,
  requireViewer,
} from "./builder.js";
import { Request } from "./requests.js";
import { Issue, User } from "./types.js";

type RunRow = typeof runs.$inferSelect;
type MachineRow = typeof machines.$inferSelect;

const RunKind = builder.enumType("RunKind", { values: RUN_KINDS });
const RunStatus = builder.enumType("RunStatus", { values: RUN_STATUSES });
const MachineStatus = builder.enumType("MachineStatus", { values: MACHINE_STATUSES });

export const Run = builder.objectRef<RunRow>("Run");
export const Machine = builder.objectRef<MachineRow>("Machine");
const RunConnection = connection<RunRow>("Run", Run);

const RunLogBatch = builder.objectRef<typeof runLogs.$inferSelect>("RunLogBatch").implement({
  description: "Transcript events a runner uploaded together, in order.",
  fields: (t) => ({
    seq: t.exposeInt("seq"),
    events: t.field({
      type: ["JSONObject"],
      resolve: (b) => b.events as Record<string, unknown>[],
    }),
    createdAt: t.field({ type: "DateTime", resolve: (b) => b.createdAt }),
  }),
});

Run.implement({
  description:
    "One agent wake on a runner: a quick decision about an event, or a work session with tools.",
  fields: (t) => ({
    id: t.exposeID("id"),
    kind: t.field({ type: RunKind, resolve: (r) => r.kind }),
    status: t.field({ type: RunStatus, resolve: (r) => r.status }),
    goal: t.exposeString("goal", { nullable: true }),
    modelTier: t.exposeString("modelTier"),
    model: t.exposeString("model", {
      nullable: true,
      description: "The pinned model id the hub chose, e.g. claude-opus-5-5.",
    }),
    effort: t.exposeString("effort", { nullable: true, description: "low to max." }),
    routeRule: t.exposeString("routeRule", {
      nullable: true,
      description:
        "The routing rule that chose the model, e.g. `label:research` or `requested+budget`.",
    }),
    costUsd: t.exposeFloat("costUsd", {
      description: "What the session would cost at API prices, as the Agent SDK reports it.",
    }),
    trigger: t.field({ type: "JSONObject", nullable: true, resolve: (r) => r.trigger ?? null }),
    result: t.field({ type: "JSONObject", nullable: true, resolve: (r) => r.result ?? null }),
    error: t.exposeString("error", { nullable: true }),
    stopReason: t.exposeString("stopReason", { nullable: true }),
    inputTokens: t.exposeInt("inputTokens"),
    outputTokens: t.exposeInt("outputTokens"),
    numTurns: t.exposeInt("numTurns"),
    logCount: t.exposeInt("logCount"),
    notBefore: t.field({ type: "DateTime", nullable: true, resolve: (r) => r.notBefore }),
    createdAt: t.field({ type: "DateTime", resolve: (r) => r.createdAt }),
    startedAt: t.field({ type: "DateTime", nullable: true, resolve: (r) => r.startedAt }),
    endedAt: t.field({ type: "DateTime", nullable: true, resolve: (r) => r.endedAt }),
    agent: t.field({
      type: User,
      resolve: async (r, _args, ctx) => (await ctx.loaders.user.load(r.agentId)) as never,
    }),
    issue: t.field({
      type: Issue,
      nullable: true,
      resolve: (r, _args, ctx) => (r.issueId ? ctx.loaders.issue.load(r.issueId) : null),
    }),
    machine: t.field({
      type: Machine,
      nullable: true,
      resolve: async (r, _args, ctx) =>
        r.machineId
          ? ((await db(ctx).select().from(machines).where(eq(machines.id, r.machineId)).get()) ??
            null)
          : null,
    }),
    waitingOnRequest: t.field({
      type: Request,
      nullable: true,
      description: "A request for approval the run is waiting on.",
      resolve: async (r, _args, ctx) =>
        r.waitingOnRequestId
          ? ((await db(ctx)
              .select()
              .from(requests)
              .where(eq(requests.id, r.waitingOnRequestId))
              .get()) ?? null)
          : null,
    }),
    stoppedBy: t.field({
      type: User,
      nullable: true,
      resolve: (r, _args, ctx) => (r.stoppedById ? ctx.loaders.user.load(r.stoppedById) : null),
    }),
    logs: t.field({
      type: [RunLogBatch],
      description: "The transcript, oldest first. Pass `afterSeq` to fetch only what's new.",
      args: { afterSeq: t.arg.int({ required: false }) },
      resolve: (r, args, ctx) =>
        db(ctx)
          .select()
          .from(runLogs)
          .where(
            and(
              eq(runLogs.runId, r.id),
              args.afterSeq != null ? gt(runLogs.seq, args.afterSeq) : undefined,
            ),
          )
          .orderBy(asc(runLogs.seq))
          .limit(200)
          .all(),
    }),
  }),
});

Machine.implement({
  description: "A computer running the runner. Agents run there with its tags and MCP servers.",
  fields: (t) => ({
    id: t.exposeID("id"),
    name: t.string({
      description: "The owner's name for it, or else its originalName.",
      resolve: (m) => machineName(m),
    }),
    originalName: t.string({
      description: "What the machine called itself when it enrolled, e.g. its host name.",
      resolve: (m) => m.name,
    }),
    status: t.field({ type: MachineStatus, resolve: (m) => m.status }),
    tags: t.exposeStringList("tags"),
    mcps: t.exposeStringList("mcps"),
    capacity: t.exposeInt("capacity"),
    version: t.exposeString("version", { nullable: true }),
    online: t.boolean({
      resolve: (m, _args, ctx) => !!m.lastSeenAt && now(ctx) - m.lastSeenAt < ONLINE_WINDOW,
    }),
    lastSeenAt: t.field({ type: "DateTime", nullable: true, resolve: (m) => m.lastSeenAt }),
    approvedAt: t.field({ type: "DateTime", nullable: true, resolve: (m) => m.approvedAt }),
    createdAt: t.field({ type: "DateTime", resolve: (m) => m.createdAt }),
    runningCount: t.int({
      resolve: async (m, _args, ctx) =>
        (
          await db(ctx)
            .select({ n: count() })
            .from(runs)
            .where(and(eq(runs.machineId, m.id), eq(runs.status, "running")))
            .get()
        )?.n ?? 0,
    }),
  }),
});

const RunFilter = builder.inputType("RunFilter", {
  fields: (t) => ({
    agentId: t.string({ required: false }),
    issueId: t.string({ required: false, description: "An issue id or identifier." }),
    machineId: t.string({ required: false, description: "The machine that picked the run up." }),
    status: t.field({ type: [RunStatus], required: false }),
    kind: t.field({ type: RunKind, required: false }),
  }),
});

async function queryRuns(
  ctx: Parameters<typeof db>[0],
  args: {
    filter?: {
      agentId?: string | null;
      issueId?: string | null;
      machineId?: string | null;
      status?: RunRow["status"][] | null;
      kind?: RunRow["kind"] | null;
    } | null;
    first?: number | null;
    after?: string | null;
  },
  scope?: { agentId?: string; issueId?: string },
) {
  const f = args.filter;
  const issueId =
    scope?.issueId ?? (f?.issueId ? ((await findIssue(db(ctx), f.issueId))?.id ?? "-") : undefined);
  const rows = await db(ctx)
    .select()
    .from(runs)
    .where(
      and(
        (scope?.agentId ?? f?.agentId)
          ? eq(runs.agentId, (scope?.agentId ?? f?.agentId) as string)
          : undefined,
        issueId ? eq(runs.issueId, issueId) : undefined,
        f?.machineId ? eq(runs.machineId, f.machineId) : undefined,
        f?.status?.length ? inArray(runs.status, f.status) : undefined,
        f?.kind ? eq(runs.kind, f.kind) : undefined,
      ),
    )
    .orderBy(desc(runs.createdAt))
    .limit(250)
    .all();
  return paginate(rows, args);
}

builder.queryFields((t) => ({
  runs: t.field({
    type: RunConnection,
    description: "Agent runs, newest first.",
    args: { ...pageArgs, filter: t.arg({ type: RunFilter, required: false }) },
    resolve: (_root, args, ctx) => {
      requireViewer(ctx);
      return queryRuns(ctx, args);
    },
  }),
  run: t.field({
    type: Run,
    args: { id: t.arg.string({ required: true }) },
    resolve: async (_root, args, ctx) => {
      requireViewer(ctx);
      const row = await db(ctx).select().from(runs).where(eq(runs.id, args.id)).get();
      if (!row) throw notFoundError("Run");
      return row;
    },
  }),
  machines: t.field({
    type: [Machine],
    resolve: (_root, _args, ctx) => {
      requireViewer(ctx);
      return listMachines(db(ctx));
    },
  }),
}));

builder.objectField(Issue, "runs", (t) =>
  t.field({
    type: RunConnection,
    description: "Agent runs on this issue, newest first.",
    args: pageArgs,
    resolve: (issue, args, ctx) => queryRuns(ctx, args, { issueId: issue.id }),
  }),
);

builder.objectField(User, "runs", (t) =>
  t.field({
    type: RunConnection,
    description: "This agent's runs, newest first.",
    args: pageArgs,
    resolve: (user, args, ctx) => queryRuns(ctx, args, { agentId: user.id }),
  }),
);

builder.objectField(User, "runnerTags", (t) =>
  t.stringList({
    description: "Machines need all these tags to run this agent.",
    resolve: (u) => u.runnerTags ?? [],
  }),
);

builder.objectFields(User, (t) => ({
  modelFloor: t.exposeString("modelFloor", {
    description: "The cheapest tier this agent's work runs on.",
  }),
  modelCeiling: t.exposeString("modelCeiling", {
    description: "The dearest tier this agent's work may run on.",
  }),
  topRunsPerWeek: t.exposeInt("topRunsPerWeek", {
    description: "Top-tier work runs allowed in any 7 days; more drop to standard.",
  }),
}));

const RunPayload = builder.objectRef<{ id: string }>("RunPayload").implement({
  fields: (t) => ({
    success: t.boolean({ resolve: () => true }),
    run: t.field({
      type: Run,
      resolve: async (p, _args, ctx) => {
        const row = await db(ctx).select().from(runs).where(eq(runs.id, p.id)).get();
        if (!row) throw notFoundError("Run");
        return row;
      },
    }),
  }),
});

const MachinePayload = builder.objectRef<{ id: string }>("MachinePayload").implement({
  fields: (t) => ({
    success: t.boolean({ resolve: () => true }),
    machine: t.field({
      type: Machine,
      nullable: true,
      resolve: async (p, _args, ctx) =>
        (await db(ctx).select().from(machines).where(eq(machines.id, p.id)).get()) ?? null,
    }),
  }),
});

const MachineSetupTokenPayload = builder
  .objectRef<{ token: string; expiresAt: number }>("MachineSetupTokenPayload")
  .implement({
    fields: (t) => ({
      success: t.boolean({ resolve: () => true }),
      token: t.exposeString("token", {
        description: "Shown once. Pass it to the install command on the new machine.",
      }),
      expiresAt: t.field({ type: "DateTime", resolve: (p) => p.expiresAt }),
    }),
  });

const RunCreateInput = builder.inputType("RunCreateInput", {
  fields: (t) => ({
    agentId: t.string({ required: true }),
    issueId: t.string({ required: false, description: "An issue id or identifier." }),
    goal: t.string({ required: true }),
    modelTier: t.string({
      required: false,
      description: "small, standard or top. Leave it out to let the routing rules decide.",
    }),
  }),
});

const MachineUpdateInput = builder.inputType("MachineUpdateInput", {
  fields: (t) => ({
    name: t.string({
      required: false,
      description: "Renames it; an empty name goes back to its originalName.",
    }),
    tags: t.stringList({ required: false }),
  }),
});

builder.mutationFields((t) => ({
  runCreate: t.field({
    type: RunPayload,
    description: "Owner only: asks an agent to start working on something now.",
    args: { input: t.arg({ type: RunCreateInput, required: true }) },
    resolve: async (_root, args, ctx) => {
      const id = await act(ctx, async (s) => {
        const actor = await s.db.select().from(users).where(eq(users.id, s.actorId)).get();
        if (actor?.kind !== "owner") throw forbidden("Only the owner starts runs directly");
        const agent = await s.db.select().from(users).where(eq(users.id, args.input.agentId)).get();
        if (!agent?.active || agent.kind !== "agent") throw notFound("Agent");
        const issue = args.input.issueId ? await findIssue(s.db, args.input.issueId) : null;
        if (args.input.issueId && !issue) throw notFound("Issue");
        const goal = args.input.goal.trim();
        if (!goal) throw badRequest("Say what the agent should do");
        const tier = args.input.modelTier ?? null;
        if (tier !== null && !(MODEL_TIERS as readonly string[]).includes(tier))
          throw badRequest("modelTier is small, standard or top");
        const routed = await routeRun(
          s.db,
          {
            kind: "work",
            agentId: agent.id,
            issueId: issue?.id ?? null,
            ownerTier: tier as ModelTier | null,
          },
          s.now,
        );
        const runId = newId();
        await commit(s.db, [
          s.db.insert(runs).values({
            id: runId,
            agentId: agent.id,
            kind: "work",
            issueId: issue?.id ?? null,
            goal: goal.slice(0, 2000),
            ...routed,
            trigger: { notes: [], requestedBy: s.actorId },
            createdAt: s.now,
            updatedAt: s.now,
          }),
          ...audit(
            s.db,
            [
              event(s, "run.create", "run", runId, {
                agentId: agent.id,
                issueId: issue?.id ?? null,
                goal,
                route: routed,
              }),
            ],
            s.now,
          ),
        ]);
        return runId;
      });
      await announce(ctx.deps.realtime, { type: "runs", at: now(ctx) });
      return { id };
    },
  }),
  runStop: t.field({
    type: RunPayload,
    description: "Stops a run. The reason is required: it becomes feedback for the agent.",
    args: { id: t.arg.string({ required: true }), reason: t.arg.string({ required: true }) },
    resolve: async (_root, args, ctx) => {
      await act(ctx, (s) => stopRun(s, args.id, args.reason));
      await announce(ctx.deps.realtime, { type: "runs", at: now(ctx) });
      return { id: args.id };
    },
  }),
  machineSetupTokenCreate: t.field({
    type: MachineSetupTokenPayload,
    description:
      "Owner only: a one-time token for the install command. The machine that enrols with it within the hour is approved without a pairing code.",
    resolve: (_root, _args, ctx) => act(ctx, (s) => createSetupToken(s)),
  }),
  machineApprove: t.field({
    type: MachinePayload,
    description: "Lets a machine run agents, once its pairing code matches the one it shows.",
    args: { id: t.arg.string({ required: true }), pairingCode: t.arg.string({ required: true }) },
    resolve: async (_root, args, ctx) => ({
      id: await act(ctx, (s) => approveMachine(s, args.id, args.pairingCode)),
    }),
  }),
  machineUpdate: t.field({
    type: MachinePayload,
    args: {
      id: t.arg.string({ required: true }),
      input: t.arg({ type: MachineUpdateInput, required: true }),
    },
    resolve: async (_root, args, ctx) => ({
      id: await act(ctx, (s) => updateMachine(s, args.id, args.input)),
    }),
  }),
  machineRevoke: t.field({
    type: MachinePayload,
    args: { id: t.arg.string({ required: true }) },
    resolve: async (_root, args, ctx) => ({ id: await act(ctx, (s) => revokeMachine(s, args.id)) }),
  }),
}));
