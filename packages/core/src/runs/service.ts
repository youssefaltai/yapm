import {
  apiTokens,
  auditEvents,
  comments,
  ENGINES,
  type Engine,
  type MachineProvider,
  machines,
  notifications,
  requests,
  runLogs,
  runs,
  users,
} from "@yapm/schema";
import { and, asc, count, desc, eq, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";
import { audit } from "../audit.js";
import { API_TOKEN_PREFIX } from "../auth.js";
import type { HubDeps } from "../context.js";
import { newId, randomToken, sha256Hex } from "../crypto.js";
import { commit, type HubDb, type WriteOp } from "../db.js";
import { badRequest, forbidden, notFound, ServiceError } from "../errors.js";
import { announce } from "../realtime.js";
import { createComment, createReaction } from "../services/comments.js";
import type { Ctx } from "../services/common.js";
import { event } from "../services/common.js";
import { feedbackOp } from "../services/feedback.js";
import { findIssue, updateIssue } from "../services/issues.js";
import { cleanTags, engineOf, waitingFor } from "../services/machines.js";
import { type McpServerConfig, mcpServersFor } from "../services/mcpServers.js";
import { cleanAccount, cleanPlanUsage, mergePlans, runUsageSet } from "../services/usage.js";
import { isAbove } from "../services/users.js";
import {
  type Decision,
  decisionInput,
  identifierOf,
  type ModelTier,
  parseDecision,
  parseWorkResult,
  type RunInput,
  workInput,
} from "./prompts.js";
import { loadRouting, loadTiers, routeRun } from "./routing.js";

type RunRow = typeof runs.$inferSelect;
type Machine = typeof machines.$inferSelect;
type TriggerNote = {
  notificationId?: string;
  type: string;
  actorId?: string | null;
  commentId?: string | null;
  requestId?: string | null;
};

/** Guards against runaway wakes, e.g. two agents mentioning each other in a loop. */
/** A machine is online if it checked in within this long. */
export const ONLINE_WINDOW = 2 * 60 * 1000;

export const LIMITS = {
  /** A running run that hasn't reported for this long is presumed lost with its machine. */
  heartbeatTimeout: 3 * 60 * 1000,
  /** How long a run's hub token lives at most. */
  tokenLifetime: 6 * 60 * 60 * 1000,
};

const ACTIVE: RunRow["status"][] = ["queued", "running", "needs_input"];

/** Who should wake for the notifications created at `at`. Runs after the change commits. */
export async function dispatch(deps: HubDeps, at: number): Promise<number> {
  const { db } = deps;
  const claimed = await db
    .update(notifications)
    .set({ dispatchedAt: at })
    .where(
      and(
        eq(notifications.createdAt, at),
        isNull(notifications.dispatchedAt),
        inArray(
          notifications.userId,
          db
            .select({ id: users.id })
            .from(users)
            .where(and(eq(users.kind, "agent"), eq(users.active, true))),
        ),
      ),
    )
    .returning()
    .all();
  let queued = 0;
  for (const note of claimed) {
    if (await wake(db, note, at)) queued++;
  }
  if (queued) await announceRuns(deps, at);
  return queued;
}

async function announceRuns(deps: HubDeps, at: number) {
  await announce(deps.realtime, { type: "runs", at });
}

/** Applies the wake rules and guards to one notification; true when it queued a run. */
async function wake(
  db: HubDb,
  note: typeof notifications.$inferSelect,
  at: number,
): Promise<boolean> {
  const agentId = note.userId;
  const trigger: TriggerNote = {
    notificationId: note.id,
    type: note.type,
    actorId: note.actorId,
    commentId: note.commentId,
    requestId: note.requestId,
  };
  const issueId = note.issueId;
  const onIssue = issueId
    ? await db
        .select()
        .from(runs)
        .where(
          and(eq(runs.agentId, agentId), eq(runs.issueId, issueId), inArray(runs.status, ACTIVE)),
        )
        .all()
    : [];

  // Status changes and project updates are news, not asks.
  if (
    note.type === "issueStatusChanged" ||
    note.type === "issueUnassignedFromYou" ||
    note.type === "projectUpdateCreated"
  )
    return false;
  let paused = onIssue.find((r) => r.status === "needs_input");
  if (note.type === "requestAnswered" && note.requestId) {
    // The session that asked picks up the answer, wherever the request was filed: directly
    // while it's still going, else by resuming its latest run.
    const request = await db.select().from(requests).where(eq(requests.id, note.requestId)).get();
    const asker = request?.runId
      ? await db.select().from(runs).where(eq(runs.id, request.runId)).get()
      : undefined;
    const latest = asker?.sessionId
      ? await db
          .select()
          .from(runs)
          .where(and(eq(runs.agentId, agentId), eq(runs.sessionId, asker.sessionId)))
          .orderBy(desc(runs.createdAt))
          .get()
      : asker;
    if (latest?.status === "running") return false;
    const resumable = latest?.status === "needs_input" || latest?.status === "completed";
    if (latest?.kind === "work" && latest.sessionId && resumable) paused = latest;
  }
  // Comments and answers to requests are what a paused session waits for.
  const answers =
    note.type === "issueNewComment" ||
    note.type === "issueCommentMention" ||
    note.type === "requestAnswered";
  if (note.type === "issueNewComment" && !paused) {
    // Followers hear about every comment; only the assignee wakes for them.
    const issue = issueId ? await findIssue(db, issueId) : null;
    if (issue?.assigneeId !== agentId) return false;
  }
  // A live work session on the issue will see it through list_notifications.
  if (onIssue.some((r) => r.kind === "work" && r.status === "running")) return false;

  if (paused && answers) {
    // A session only resumes on the engine that started it; if the agent's tier has moved to
    // another, the run starts afresh.
    const tiers = await loadTiers(db, agentId);
    const current = tiers[paused.modelTier as ModelTier] ?? tiers.standard;
    const same = engineOf(paused.provider ?? "anthropic") === engineOf(current.provider);
    const routed = await routeRun(
      db,
      { kind: "work", agentId, issueId: paused.issueId, resumes: same ? paused : null },
      at,
    );
    await commit(db, [
      db
        .update(runs)
        .set({ status: "completed", updatedAt: at })
        .where(and(eq(runs.id, paused.id), eq(runs.status, "needs_input"))),
      db.insert(runs).values({
        id: newId(),
        agentId,
        kind: "work",
        issueId: paused.issueId,
        goal: paused.goal,
        ...routed,
        trigger: { notes: [trigger] },
        resumeOfRunId: paused.id,
        // The session lives on the machine that ran it.
        ...(same ? { sessionId: paused.sessionId, machineId: paused.machineId } : {}),
        createdAt: at,
        updatedAt: at,
      }),
    ]);
    return true;
  }

  const pending = onIssue.find(
    (r) => r.kind === "decision" && r.status === "queued" && !r.notBefore,
  );
  if (pending) {
    // Several events before the agent gets to it make one decision.
    const notes = [...((pending.trigger?.notes as TriggerNote[] | undefined) ?? []), trigger];
    await db
      .update(runs)
      .set({ trigger: { notes }, updatedAt: at })
      .where(eq(runs.id, pending.id))
      .run();
    return false;
  }
  await db
    .insert(runs)
    .values({
      id: newId(),
      agentId,
      kind: "decision",
      issueId,
      ...(await routeRun(db, { kind: "decision", agentId, issueId }, at)),
      trigger: { notes: [trigger] },
      createdAt: at,
      updatedAt: at,
    })
    .run();
  return true;
}

/** Runs whose machine stopped reporting are failed, so their issues don't look busy forever. */
/** Fails runs whose machine stopped checking in; true when there were any. */
export async function failLostRuns(db: HubDb, at: number) {
  const lost = await db
    .update(runs)
    .set({ status: "failed", error: "Lost contact with the machine", endedAt: at, updatedAt: at })
    .where(and(eq(runs.status, "running"), lt(runs.heartbeatAt, at - LIMITS.heartbeatTimeout)))
    .returning({ id: runs.id })
    .all();
  return lost.length > 0;
}

export interface ClaimedRun {
  run: {
    id: string;
    kind: RunRow["kind"];
    modelTier: ModelTier;
    /** The provider, its model id and the effort to run with (null: the model has none). */
    provider: string;
    model: string;
    effort: string | null;
    /** What runs it: Claude for Anthropic, OpenCode for the rest; for runners before 0.7. */
    engine: Engine;
    /** Resume this Agent SDK session (needs-input runs continue where they paused). */
    sessionId: string | null;
    issue: string | null;
    issueId: string | null;
  };
  agent: { id: string; name: string };
  /** Acts as the agent on the hub, for this run only. */
  token: string;
  input: RunInput;
  /** Outside MCP servers the agent may use, in Claude Code's shape; work runs only. */
  mcpServers: Record<string, McpServerConfig>;
}

/** Gives a machine the oldest queued run it may take, or null. */
export async function claimRun(
  deps: HubDeps,
  machine: Machine,
  at: number,
): Promise<ClaimedRun | null> {
  const { db } = deps;
  const lost = await failLostRuns(db, at);
  const claimed = await claimNext(deps, machine, at);
  // A run starting (or a lost one failing) shows on its issue and in Runs.
  if (claimed || lost)
    await announce(deps.realtime, { type: "change", actorId: "", clientId: null, at });
  return claimed;
}

async function claimNext(deps: HubDeps, machine: Machine, at: number) {
  const { db } = deps;
  const busy = await db
    .select({ n: count() })
    .from(runs)
    .where(and(eq(runs.machineId, machine.id), eq(runs.status, "running")))
    .get();
  if ((busy?.n ?? 0) >= machine.capacity) return null;
  const candidates = await db
    .select({
      run: runs,
      agentTags: users.runnerTags,
      agentActive: users.active,
    })
    .from(runs)
    .innerJoin(users, eq(users.id, runs.agentId))
    .where(
      and(
        eq(runs.status, "queued"),
        or(isNull(runs.notBefore), lte(runs.notBefore, at)),
        or(isNull(runs.machineId), eq(runs.machineId, machine.id)),
      ),
    )
    .orderBy(asc(runs.createdAt))
    .limit(25)
    .all();
  for (const { run, agentTags, agentActive } of candidates) {
    if (!agentActive) continue;
    const provider = run.provider ?? "anthropic";
    if (waitingFor({ runnerTags: agentTags }, provider, [machine])) continue;
    const won = await db
      .update(runs)
      .set({
        status: "running",
        engine: engineOf(provider),
        machineId: machine.id,
        startedAt: at,
        heartbeatAt: at,
        updatedAt: at,
      })
      .where(and(eq(runs.id, run.id), eq(runs.status, "queued")))
      .returning()
      .all();
    const mine = won[0];
    if (!mine) continue; // another machine got it first
    return prepare(deps, mine, at);
  }
  return null;
}

async function prepare(deps: HubDeps, run: RunRow, at: number): Promise<ClaimedRun> {
  const { db } = deps;
  const agent = await db.select().from(users).where(eq(users.id, run.agentId)).get();
  if (!agent) throw notFound("Agent");
  const issue = run.issueId ? await findIssue(db, run.issueId) : null;
  const notes = (run.trigger?.notes as TriggerNote[] | undefined) ?? [];
  // A fresh session gets the whole issue, even when it answers a paused one.
  const sessionId = run.resumeOfRunId ? run.sessionId : null;
  const input =
    run.kind === "decision"
      ? await decisionInput(db, agent, issue, notes)
      : await workInput(db, agent, issue, run.goal ?? "", notes, !!sessionId);
  const token = randomToken(API_TOKEN_PREFIX);
  await db
    .insert(apiTokens)
    .values({
      id: newId(),
      userId: agent.id,
      name: `Run ${run.id.slice(0, 8)}`,
      tokenHash: await sha256Hex(token),
      prefix: token.slice(0, API_TOKEN_PREFIX.length + 6),
      createdAt: at,
      expiresAt: at + LIMITS.tokenLifetime,
      runId: run.id,
    })
    .run();
  return {
    run: {
      id: run.id,
      kind: run.kind,
      modelTier: run.modelTier as ModelTier,
      ...(await modelOf(db, run)),
      engine: engineOf(run.provider ?? "anthropic"),
      sessionId,
      issue: issue ? await identifierOf(db, issue) : null,
      issueId: issue?.id ?? null,
    },
    agent: { id: agent.id, name: agent.name },
    token,
    input,
    mcpServers: run.kind === "work" ? await mcpServersFor(deps, agent.id, run.id, at) : {},
  };
}

/** The run's model; runs queued before routing existed take their tier's setting. */
async function modelOf(db: HubDb, run: RunRow) {
  if (run.model)
    return { provider: run.provider ?? "anthropic", model: run.model, effort: run.effort };
  const { tiers } = await loadRouting(db);
  return tiers[run.modelTier as ModelTier] ?? tiers.standard;
}

async function machineRun(db: HubDb, machine: Machine, id: string) {
  const run = await db.select().from(runs).where(eq(runs.id, id)).get();
  if (!run || run.machineId !== machine.id) throw notFound("Run");
  return run;
}

export interface LogUpload {
  seq: number;
  events: unknown[];
  sessionId?: string | null;
  usage?: { inputTokens?: number; outputTokens?: number; numTurns?: number; costUsd?: number };
}

/** Stores a batch of transcript events; the answer says whether the run should stop. */
export async function appendLogs(
  db: HubDb,
  machine: Machine,
  runId: string,
  upload: LogUpload,
  at: number,
) {
  const run = await machineRun(db, machine, runId);
  if (!Array.isArray(upload.events)) throw badRequest("events must be an array");
  if (upload.events.length > 500) throw badRequest("Send at most 500 events at a time");
  if (JSON.stringify(upload.events).length > 512_000) throw badRequest("That batch is too large");
  const ops: WriteOp[] = [];
  if (upload.events.length) {
    ops.push(
      db
        .insert(runLogs)
        .values({
          id: newId(),
          runId,
          seq: Math.floor(upload.seq),
          events: upload.events,
          createdAt: at,
        })
        // A retried upload of the same batch is harmless.
        .onConflictDoNothing(),
    );
  }
  const usage = await runUsageSet(db, run, upload.usage, upload.sessionId);
  ops.push(
    db
      .update(runs)
      .set({
        heartbeatAt: at,
        updatedAt: at,
        logCount: sql`${runs.logCount} + ${upload.events.length}`,
        ...(upload.sessionId ? { sessionId: upload.sessionId } : {}),
        ...usage,
      })
      .where(eq(runs.id, runId)),
  );
  await commit(db, ops);
  return { stop: run.stopRequestedAt !== null, stopReason: run.stopReason };
}

export interface RunCompletion {
  status: "completed" | "failed" | "stopped" | "needs_input";
  /** The structured output: a decision, or a work result. */
  result?: unknown;
  error?: string;
  sessionId?: string | null;
  usage?: LogUpload["usage"];
  /** What actually ran; older runners send neither and the hub's choice stays. */
  model?: string;
  effort?: string | null;
}

/**
 * A run ended on the machine. The hub validates its structured output and applies it as the
 * agent: a decision's reaction, reply or next run, or a work session's summary or question.
 */
export async function completeRun(
  deps: HubDeps,
  machine: Machine,
  runId: string,
  body: RunCompletion,
  at: number,
): Promise<{ status: RunRow["status"]; notified: boolean }> {
  const { db } = deps;
  const run = await machineRun(db, machine, runId);
  if (run.status !== "running")
    throw new ServiceError("CONFLICT", `The run is already ${run.status}`);
  const ctx: Ctx = { db, actorId: run.agentId, now: at, runId: run.id };
  let status: RunRow["status"] = body.status === "needs_input" ? "needs_input" : body.status;
  let result: Record<string, unknown> | null = null;
  let error = body.error?.slice(0, 5000) ?? null;
  if (run.stopRequestedAt && status !== "completed") status = "stopped";

  if (body.status === "completed" || body.status === "needs_input") {
    try {
      if (run.kind === "decision") {
        const decision = parseDecision(body.result);
        result = { ...decision };
        await applyDecision(ctx, run, decision);
      } else {
        const work = parseWorkResult(body.result);
        result = { ...work };
        status =
          work.outcome === "needs_input"
            ? "needs_input"
            : work.outcome === "failed"
              ? "failed"
              : "completed";
        await applyWorkResult(ctx, run, work);
      }
    } catch (failure) {
      status = "failed";
      error = failure instanceof Error ? failure.message : String(failure);
    }
  }

  await commit(db, [
    db
      .update(runs)
      .set({
        status,
        result,
        error,
        endedAt: at,
        updatedAt: at,
        ...(body.sessionId ? { sessionId: body.sessionId } : {}),
        ...(typeof body.model === "string" && body.model
          ? {
              // Runners before 0.7 name OpenCode's models `provider/model`.
              model: body.model.replace(`${run.provider}/`, "").slice(0, 120),
              effort: typeof body.effort === "string" ? body.effort.slice(0, 40) : null,
            }
          : {}),
        ...(await runUsageSet(db, run, body.usage, body.sessionId)),
      })
      .where(eq(runs.id, runId)),
    // The run's hub token dies with it.
    db
      .update(apiTokens)
      .set({ revokedAt: at })
      .where(and(eq(apiTokens.runId, runId), isNull(apiTokens.revokedAt))),
    ...audit(
      db,
      [
        {
          actorId: run.agentId,
          runId,
          action: `run.${status}`,
          entityType: "run",
          entityId: runId,
          data: { kind: run.kind, ...(result ? { result } : {}), ...(error ? { error } : {}) },
        },
      ],
      at,
    ),
  ]);
  return { status, notified: !!ctx.notified };
}

async function applyDecision(ctx: Ctx, run: RunRow, decision: Decision) {
  const { db, now } = ctx;
  const notes = (run.trigger?.notes as TriggerNote[] | undefined) ?? [];
  const issue = run.issueId ? await findIssue(db, run.issueId) : null;
  const comment = [...notes].reverse().find((n) => n.commentId)?.commentId ?? null;
  switch (decision.action) {
    case "ignore":
      return;
    case "react":
      if (comment)
        await createReaction(ctx, {
          emoji: decision.emoji ?? "👍",
          commentId: comment,
          issueId: null,
        });
      else if (issue)
        await createReaction(ctx, {
          emoji: decision.emoji ?? "👍",
          commentId: null,
          issueId: issue.id,
        });
      return;
    case "reply":
      if (!issue) throw new Error("There is no issue to reply on");
      await createComment(ctx, {
        issueId: issue.id,
        body: decision.body ?? "",
        parentId: await threadOf(db, comment),
      });
      return;
    case "escalate": {
      if (!issue) throw new Error("There is no issue to escalate");
      const agent = await db.select().from(users).where(eq(users.id, run.agentId)).get();
      const manager = agent?.managerId
        ? await db.select().from(users).where(eq(users.id, agent.managerId)).get()
        : undefined;
      const body = decision.body || decision.reason;
      await createComment(ctx, {
        issueId: issue.id,
        body: manager ? `@${manager.name} ${body}` : body,
        parentId: null,
      });
      return;
    }
    case "delegate": {
      if (!issue) throw new Error("There is no issue to delegate");
      const to = await db
        .select()
        .from(users)
        .where(
          and(
            sql`lower(${users.name}) = ${decision.to?.toLowerCase() ?? ""}`,
            eq(users.active, true),
          ),
        )
        .get();
      if (!to) throw new Error(`Nobody is called ${decision.to}`);
      await updateIssue(ctx, issue.id, { assigneeId: to.id });
      await createComment(ctx, {
        issueId: issue.id,
        body: `@${to.name} over to you: ${decision.reason}`,
        parentId: null,
      });
      return;
    }
    case "wait_until":
    case "work": {
      const later = decision.action === "wait_until";
      if (!later) {
        const busy = await db
          .select({ id: runs.id })
          .from(runs)
          .where(
            and(
              eq(runs.agentId, run.agentId),
              eq(runs.kind, "work"),
              inArray(runs.status, ACTIVE),
              run.issueId ? eq(runs.issueId, run.issueId) : isNull(runs.issueId),
            ),
          )
          .get();
        if (busy) return;
      }
      const routed = await routeRun(
        db,
        {
          kind: later ? "decision" : "work",
          agentId: run.agentId,
          issueId: run.issueId,
          requestedTier: decision.modelTier ?? null,
        },
        now,
      );
      await commit(db, [
        // One plan to look again per agent and issue: the newest replaces any earlier one.
        ...(later
          ? [
              db
                .update(runs)
                .set({ status: "canceled", updatedAt: now })
                .where(
                  and(
                    eq(runs.agentId, run.agentId),
                    run.issueId ? eq(runs.issueId, run.issueId) : isNull(runs.issueId),
                    eq(runs.status, "queued"),
                    sql`${runs.notBefore} is not null`,
                  ),
                ),
            ]
          : []),
        db.insert(runs).values({
          id: newId(),
          agentId: run.agentId,
          kind: later ? "decision" : "work",
          issueId: run.issueId,
          goal: later ? null : (decision.goal ?? null),
          ...routed,
          notBefore: later ? Date.parse(decision.until ?? "") : null,
          trigger: later ? { notes: [{ type: "wake" }] } : { decisionRunId: run.id, notes },
          createdAt: now,
          updatedAt: now,
        }),
        ...audit(
          db,
          [
            event(ctx, later ? "run.schedule" : "run.queue", "run", run.id, {
              action: decision.action,
              ...(later ? {} : { route: routed }),
            }),
          ],
          now,
        ),
      ]);
      return;
    }
  }
}

/** Replies go in the thread of the comment that woke the agent, like Linear's threads. */
async function threadOf(db: HubDb, commentId: string | null) {
  if (!commentId) return null;
  const c = await db.select().from(comments).where(eq(comments.id, commentId)).get();
  return c ? (c.parentId ?? c.id) : null;
}

async function applyWorkResult(ctx: Ctx, run: RunRow, work: ReturnType<typeof parseWorkResult>) {
  const { db } = ctx;
  if (!run.issueId) return;
  // A question is the ask, so it's always posted.
  if (work.outcome === "needs_input" && work.question) {
    await createComment(ctx, { issueId: run.issueId, body: work.question, parentId: null });
    return;
  }
  // The agent usually reports as it goes; only post the summary if it said nothing.
  const said = await db
    .select({ n: count() })
    .from(auditEvents)
    .where(and(eq(auditEvents.runId, run.id), eq(auditEvents.action, "comment.create")))
    .get();
  if (!said?.n && work.summary) {
    await createComment(ctx, { issueId: run.issueId, body: work.summary, parentId: null });
  }
}

/** The owner or the agent's managers stop a run: a queued one is canceled, a running one is told to abort. */
export async function stopRun(ctx: Ctx, id: string, reason: string) {
  const { db, now } = ctx;
  const actor = await db.select().from(users).where(eq(users.id, ctx.actorId)).get();
  const run = await db.select().from(runs).where(eq(runs.id, id)).get();
  if (!run) throw notFound("Run");
  if (actor?.kind !== "owner" && !(await isAbove(db, ctx.actorId, run.agentId)))
    throw forbidden("Only the owner and the agent's managers stop its runs");
  const why = reason.trim();
  if (!why) throw badRequest("Say why you're stopping it; the agent learns from it");
  if (!ACTIVE.includes(run.status))
    throw new ServiceError("CONFLICT", `The run is already ${run.status}`);
  const running = run.status === "running";
  await commit(db, [
    db
      .update(runs)
      .set({
        stopRequestedAt: now,
        stopReason: why.slice(0, 2000),
        stoppedById: ctx.actorId,
        updatedAt: now,
        ...(running
          ? {}
          : { status: run.status === "queued" ? "canceled" : "stopped", endedAt: now }),
      })
      .where(eq(runs.id, id)),
    feedbackOp(ctx, {
      agentId: run.agentId,
      kind: "stop",
      body: why,
      runId: id,
      issueId: run.issueId,
    }),
    ...audit(
      db,
      [
        event(ctx, "run.stop", "run", id, {
          reason: why,
          agentId: run.agentId,
          issueId: run.issueId,
        }),
      ],
      now,
    ),
  ]);
}

const text = (value: unknown, max: number) =>
  typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null;

/** The providers a runner reports, trimmed to what the catalog needs and bounded in size. */
function cleanProviders(list: unknown[]): MachineProvider[] {
  return list.slice(0, 50).flatMap((p) => {
    const { id, name, models } = (p ?? {}) as Record<string, unknown>;
    const pid = text(id, 60);
    if (!pid || !Array.isArray(models)) return [];
    return [
      {
        id: pid,
        name: text(name, 60) ?? pid,
        models: models.slice(0, 300).flatMap((m) => {
          const { id: mid, name: label, efforts } = (m ?? {}) as Record<string, unknown>;
          const model = text(mid, 120);
          if (!model) return [];
          const levels = Array.isArray(efforts) ? efforts.slice(0, 10) : [];
          return [
            {
              id: model,
              name: text(label, 80) ?? model,
              efforts: levels.flatMap((e) => text(e, 20) ?? []),
            },
          ];
        }),
      },
    ];
  });
}

/** A machine checks in: it's alive, here's what it has, and which of its runs must stop. */
export async function heartbeat(
  db: HubDb,
  machine: Machine,
  info: {
    tags?: string[];
    /** The engines the runner has; older runners don't say. */
    engines?: unknown;
    /** The providers signed in there and their models; runners before 0.7 don't say. */
    providers?: unknown;
    capacity?: number;
    version?: string;
    runIds?: string[];
    /** The Claude login agents use there. */
    claudeAccount?: unknown;
    /** The plan's limits as the machine last read them. */
    planUsage?: unknown;
    /** OpenCode's ChatGPT or Copilot plans, as their responses last said. */
    plans?: unknown;
  },
  at: number,
) {
  const runIds = Array.isArray(info.runIds) ? info.runIds.slice(0, 50).map(String) : [];
  const ops: WriteOp[] = [];
  const account = cleanAccount(info.claudeAccount);
  const plan = cleanPlanUsage(info.planUsage, at);
  const plans = mergePlans(machine.plans, info.plans, at);
  // Owners set tags in the app once approved; until then the machine's own list counts.
  ops.push(
    db
      .update(machines)
      .set({
        lastSeenAt: at,
        ...(typeof info.capacity === "number"
          ? { capacity: Math.min(Math.max(Math.floor(info.capacity), 1), 16) }
          : {}),
        ...(info.version ? { version: String(info.version).slice(0, 40) } : {}),
        ...(machine.status === "pending" && info.tags ? { tags: cleanTags(info.tags) } : {}),
        ...(Array.isArray(info.engines)
          ? { engines: ENGINES.filter((e) => (info.engines as unknown[]).includes(e)) }
          : {}),
        ...(Array.isArray(info.providers) ? { providers: cleanProviders(info.providers) } : {}),
        ...(account ? { claudeAccount: account } : {}),
        // Said once: the runner remembers it until its runs finish.
        ...(machine.upgradeRequestedAt != null ? { upgradeRequestedAt: null } : {}),
        // Readings can arrive out of order; keep the newest.
        ...(plan && plan.observedAt >= (machine.planUsage?.observedAt ?? 0)
          ? { planUsage: plan }
          : {}),
        ...(plans ? { plans } : {}),
      })
      .where(eq(machines.id, machine.id)),
  );
  if (runIds.length) {
    ops.push(
      db
        .update(runs)
        .set({ heartbeatAt: at })
        .where(
          and(inArray(runs.id, runIds), eq(runs.machineId, machine.id), eq(runs.status, "running")),
        ),
    );
  }
  await commit(db, ops);
  const stopping = runIds.length
    ? await db
        .select({ id: runs.id, reason: runs.stopReason })
        .from(runs)
        .where(and(inArray(runs.id, runIds), sql`${runs.stopRequestedAt} is not null`))
        .all()
    : [];
  // Runs the hub no longer thinks are running on this machine (failed as lost, or canceled).
  const live = runIds.length
    ? await db
        .select({ id: runs.id })
        .from(runs)
        .where(
          and(inArray(runs.id, runIds), eq(runs.machineId, machine.id), eq(runs.status, "running")),
        )
        .all()
    : [];
  const gone = runIds.filter((id) => !live.some((r) => r.id === id));
  return {
    /** The app shows whether a machine is online, so coming back is a change. */
    changed: !machine.lastSeenAt || machine.lastSeenAt < at - ONLINE_WINDOW,
    upgrade: machine.upgradeRequestedAt != null,
    stop: [
      ...stopping.map((r) => ({ id: r.id, reason: r.reason })),
      ...gone.map((id) => ({ id, reason: "The hub ended this run" })),
    ],
  };
}
