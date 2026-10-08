import {
  apiTokens,
  auditEvents,
  comments,
  machines,
  notifications,
  requests,
  runLogs,
  runs,
  users,
} from "@life-os/schema";
import { and, asc, count, eq, gte, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";
import { audit } from "../audit.js";
import { API_TOKEN_PREFIX } from "../auth.js";
import type { HubDeps } from "../context.js";
import { newId, randomToken, sha256Hex } from "../crypto.js";
import { commit, type HubDb, type WriteOp } from "../db.js";
import { badRequest, forbidden, notFound, ServiceError } from "../errors.js";
import { createComment, createReaction } from "../services/comments.js";
import type { Ctx } from "../services/common.js";
import { event } from "../services/common.js";
import { findIssue, updateIssue } from "../services/issues.js";
import { cleanTags } from "../services/machines.js";
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
export const LIMITS = {
  /** Wakes per agent per issue in an hour. */
  perIssuePerHour: 6,
  /** Wakes per agent per day: the subscription's usage is shared by everyone. */
  perAgentPerDay: 100,
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
  try {
    await deps.realtime?.publish({ type: "runs", at });
  } catch (error) {
    console.error("Live update failed", error);
  }
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
  if (note.type === "requestAnswered" && note.requestId) {
    // A run waiting on its own request hears the answer directly.
    const request = await db.select().from(requests).where(eq(requests.id, note.requestId)).get();
    if (request?.runId) return false;
  }
  const paused = onIssue.find((r) => r.status === "needs_input");
  const isComment = note.type === "issueNewComment" || note.type === "issueCommentMention";
  if (note.type === "issueNewComment" && !paused) {
    // Followers hear about every comment; only the assignee wakes for them.
    const issue = issueId ? await findIssue(db, issueId) : null;
    if (issue?.assigneeId !== agentId) return false;
  }
  // A live work session on the issue will see it through list_notifications.
  if (onIssue.some((r) => r.kind === "work" && r.status === "running")) return false;
  if (!(await withinLimits(db, agentId, issueId, at))) return false;

  if (paused && isComment) {
    await commit(db, [
      db.update(runs).set({ status: "completed", updatedAt: at }).where(eq(runs.id, paused.id)),
      db.insert(runs).values({
        id: newId(),
        agentId,
        kind: "work",
        issueId,
        goal: paused.goal,
        modelTier: paused.modelTier,
        trigger: { notes: [trigger] },
        resumeOfRunId: paused.id,
        sessionId: paused.sessionId,
        // The session lives on the machine that ran it.
        machineId: paused.machineId,
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
      modelTier: "small",
      trigger: { notes: [trigger] },
      createdAt: at,
      updatedAt: at,
    })
    .run();
  return true;
}

async function withinLimits(db: HubDb, agentId: string, issueId: string | null, at: number) {
  const [perIssue, perDay] = await Promise.all([
    issueId
      ? db
          .select({ n: count() })
          .from(runs)
          .where(
            and(
              eq(runs.agentId, agentId),
              eq(runs.issueId, issueId),
              gte(runs.createdAt, at - 3_600_000),
            ),
          )
          .get()
      : undefined,
    db
      .select({ n: count() })
      .from(runs)
      .where(and(eq(runs.agentId, agentId), gte(runs.createdAt, at - 86_400_000)))
      .get(),
  ]);
  if ((perIssue?.n ?? 0) >= LIMITS.perIssuePerHour) {
    console.warn(`Not waking ${agentId}: too many runs on one issue this hour`);
    return false;
  }
  if ((perDay?.n ?? 0) >= LIMITS.perAgentPerDay) {
    console.warn(`Not waking ${agentId}: daily run limit reached`);
    return false;
  }
  return true;
}

/** Runs whose machine stopped reporting are failed, so their issues don't look busy forever. */
async function failLostRuns(db: HubDb, at: number) {
  await db
    .update(runs)
    .set({ status: "failed", error: "Lost contact with the machine", endedAt: at, updatedAt: at })
    .where(and(eq(runs.status, "running"), lt(runs.heartbeatAt, at - LIMITS.heartbeatTimeout)))
    .run();
}

export interface ClaimedRun {
  run: {
    id: string;
    kind: RunRow["kind"];
    modelTier: ModelTier;
    /** Resume this Agent SDK session (needs-input runs continue where they paused). */
    sessionId: string | null;
    issue: string | null;
    issueId: string | null;
  };
  agent: { id: string; name: string };
  /** Acts as the agent on the hub, for this run only. */
  token: string;
  input: RunInput;
}

/** Gives a machine the oldest queued run it may take, or null. */
export async function claimRun(
  deps: HubDeps,
  machine: Machine,
  at: number,
): Promise<ClaimedRun | null> {
  const { db } = deps;
  await failLostRuns(db, at);
  const busy = await db
    .select({ n: count() })
    .from(runs)
    .where(and(eq(runs.machineId, machine.id), eq(runs.status, "running")))
    .get();
  if ((busy?.n ?? 0) >= machine.capacity) return null;
  const candidates = await db
    .select({ run: runs, agentTags: users.runnerTags, agentActive: users.active })
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
    if (!(agentTags ?? []).every((tag) => machine.tags.includes(tag))) continue;
    const won = await db
      .update(runs)
      .set({
        status: "running",
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
    return prepare(db, mine, at);
  }
  return null;
}

async function prepare(db: HubDb, run: RunRow, at: number): Promise<ClaimedRun> {
  const agent = await db.select().from(users).where(eq(users.id, run.agentId)).get();
  if (!agent) throw notFound("Agent");
  const issue = run.issueId ? await findIssue(db, run.issueId) : null;
  const notes = (run.trigger?.notes as TriggerNote[] | undefined) ?? [];
  const input =
    run.kind === "decision"
      ? await decisionInput(db, agent, issue, notes)
      : await workInput(db, agent, issue, run.goal ?? "", notes, !!run.resumeOfRunId);
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
      sessionId: run.resumeOfRunId ? run.sessionId : null,
      issue: issue ? await identifierOf(db, issue) : null,
      issueId: issue?.id ?? null,
    },
    agent: { id: agent.id, name: agent.name },
    token,
    input,
  };
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
  usage?: { inputTokens?: number; outputTokens?: number; numTurns?: number };
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
  ops.push(
    db
      .update(runs)
      .set({
        heartbeatAt: at,
        updatedAt: at,
        logCount: sql`${runs.logCount} + ${upload.events.length}`,
        ...(upload.sessionId ? { sessionId: upload.sessionId } : {}),
        ...usageSet(upload.usage),
      })
      .where(eq(runs.id, runId)),
  );
  await commit(db, ops);
  return { stop: run.stopRequestedAt !== null, stopReason: run.stopReason };
}

function usageSet(usage: LogUpload["usage"]) {
  if (!usage) return {};
  const n = (v: unknown) => (typeof v === "number" && v >= 0 ? Math.floor(v) : undefined);
  return {
    ...(n(usage.inputTokens) !== undefined ? { inputTokens: n(usage.inputTokens) } : {}),
    ...(n(usage.outputTokens) !== undefined ? { outputTokens: n(usage.outputTokens) } : {}),
    ...(n(usage.numTurns) !== undefined ? { numTurns: n(usage.numTurns) } : {}),
  };
}

export interface RunCompletion {
  status: "completed" | "failed" | "stopped" | "needs_input";
  /** The structured output: a decision, or a work result. */
  result?: unknown;
  error?: string;
  sessionId?: string | null;
  usage?: LogUpload["usage"];
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
        ...usageSet(body.usage),
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
      await commit(db, [
        db.insert(runs).values({
          id: newId(),
          agentId: run.agentId,
          kind: later ? "decision" : "work",
          issueId: run.issueId,
          goal: later ? null : (decision.goal ?? null),
          modelTier: later ? "small" : (decision.modelTier ?? "standard"),
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
  if (work.outcome === "needs_input") {
    await createComment(ctx, {
      issueId: run.issueId,
      body: work.question ?? work.summary,
      parentId: null,
    });
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

/** The owner stops a run: a queued one is canceled, a running one is told to abort. */
export async function stopRun(ctx: Ctx, id: string, reason: string) {
  const { db, now } = ctx;
  const actor = await db.select().from(users).where(eq(users.id, ctx.actorId)).get();
  if (actor?.kind !== "owner") throw forbidden("Only the owner can stop runs for now");
  const run = await db.select().from(runs).where(eq(runs.id, id)).get();
  if (!run) throw notFound("Run");
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

/** A machine checks in: it's alive, here's what it has, and which of its runs must stop. */
export async function heartbeat(
  db: HubDb,
  machine: Machine,
  info: {
    tags?: string[];
    mcps?: string[];
    capacity?: number;
    version?: string;
    runIds?: string[];
  },
  at: number,
) {
  const runIds = Array.isArray(info.runIds) ? info.runIds.slice(0, 50).map(String) : [];
  const ops: WriteOp[] = [];
  // Owners set tags in the app once approved; until then the machine's own list counts.
  ops.push(
    db
      .update(machines)
      .set({
        lastSeenAt: at,
        ...(Array.isArray(info.mcps) ? { mcps: info.mcps.map(String).slice(0, 50) } : {}),
        ...(typeof info.capacity === "number"
          ? { capacity: Math.min(Math.max(Math.floor(info.capacity), 1), 16) }
          : {}),
        ...(info.version ? { version: String(info.version).slice(0, 40) } : {}),
        ...(machine.status === "pending" && info.tags ? { tags: cleanTags(info.tags) } : {}),
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
    stop: [
      ...stopping.map((r) => ({ id: r.id, reason: r.reason })),
      ...gone.map((id) => ({ id, reason: "The hub ended this run" })),
    ],
  };
}
