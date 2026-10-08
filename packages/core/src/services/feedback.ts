import {
  type FeedbackKind,
  feedback,
  type RevisionSubject,
  revisions,
  users,
  workspaces,
} from "@life-os/schema";
import { and, desc, eq, isNull } from "drizzle-orm";
import { audit } from "../audit.js";
import { newId } from "../crypto.js";
import { commit, type HubDb, type WriteOp } from "../db.js";
import { forbidden, notFound, ServiceError } from "../errors.js";
import { type Ctx, cleanText, event } from "./common.js";
import { requireIssue } from "./issues.js";
import { authorize } from "./requests.js";

export const LESSONS_MAX = 20_000;
export const HANDBOOK_MAX = 50_000;

export interface FeedbackInput {
  agentId: string;
  kind: FeedbackKind;
  body: string;
  runId?: string | null;
  issueId?: string | null;
  requestId?: string | null;
}

/** The write that records feedback; stopping a run and rejecting a request add it to their batch. */
export function feedbackOp(ctx: Ctx, input: FeedbackInput, id = newId()): WriteOp {
  return ctx.db.insert(feedback).values({
    id,
    agentId: input.agentId,
    kind: input.kind,
    body: input.body.slice(0, 4000),
    authorId: ctx.actorId || null,
    runId: input.runId ?? null,
    issueId: input.issueId ?? null,
    requestId: input.requestId ?? null,
    createdAt: ctx.now,
  });
}

/** The write that keeps a version of a charter, an agent's lessons or the handbook. */
export function revisionOp(
  ctx: Ctx,
  subject: RevisionSubject,
  entityId: string,
  content: string | null,
): WriteOp {
  return ctx.db.insert(revisions).values({
    id: newId(),
    subject,
    entityId,
    content: content ?? "",
    authorId: ctx.actorId || null,
    runId: ctx.runId ?? null,
    reason: ctx.reason ?? null,
    createdAt: ctx.now,
  });
}

async function loadUser(db: HubDb, id: string) {
  const row = await db.select().from(users).where(eq(users.id, id)).get();
  if (!row) throw notFound("User");
  return row;
}

/** The owner and an agent's manager may give it feedback and mark it addressed. */
async function canCoach(db: HubDb, actorId: string, agentId: string) {
  const actor = await loadUser(db, actorId);
  if (actor.kind === "owner") return true;
  const agent = await loadUser(db, agentId);
  return agent.managerId === actorId;
}

/** A note for an agent to learn from, from the owner or its manager, optionally about an issue. */
export async function createFeedback(
  ctx: Ctx,
  input: { agentId: string; body: string; issueId?: string | null },
): Promise<string> {
  const { db, now } = ctx;
  const agent = await loadUser(db, input.agentId);
  if (agent.kind !== "agent") throw new ServiceError("BAD_REQUEST", "Only agents get feedback");
  if (!(await canCoach(db, ctx.actorId, agent.id)))
    throw forbidden("Only the owner and an agent's manager give it feedback");
  const body = cleanText(input.body, "Feedback", 4000);
  const issue = input.issueId ? await requireIssue(db, input.issueId) : null;
  const id = newId();
  await commit(db, [
    feedbackOp(ctx, { agentId: agent.id, kind: "note", body, issueId: issue?.id ?? null }, id),
    ...audit(
      db,
      [
        event(ctx, "feedback.create", "feedback", id, {
          agentId: agent.id,
          issueId: issue?.id ?? null,
          body,
        }),
      ],
      now,
    ),
  ]);
  return id;
}

/** Marks feedback as acted on, saying what changed. The agent itself, its manager or the owner. */
export async function addressFeedback(ctx: Ctx, id: string, note: string): Promise<string> {
  const { db, now } = ctx;
  const row = await db.select().from(feedback).where(eq(feedback.id, id)).get();
  if (!row) throw notFound("Feedback");
  if (row.agentId !== ctx.actorId && !(await canCoach(db, ctx.actorId, row.agentId)))
    throw forbidden("Only the agent, its manager or the owner can address its feedback");
  if (row.addressedAt) throw new ServiceError("CONFLICT", "This feedback was already addressed");
  const addressedNote = cleanText(note, "What changed", 2000);
  await commit(db, [
    db
      .update(feedback)
      .set({ addressedAt: now, addressedById: ctx.actorId, addressedNote })
      .where(eq(feedback.id, id)),
    ...audit(db, [event(ctx, "feedback.address", "feedback", id, { note: addressedNote })], now),
  ]);
  return id;
}

export async function listFeedback(
  db: HubDb,
  filter: { agentId?: string | null; issueId?: string | null; open?: boolean | null },
  limit = 50,
) {
  return db
    .select()
    .from(feedback)
    .where(
      and(
        filter.agentId ? eq(feedback.agentId, filter.agentId) : undefined,
        filter.issueId ? eq(feedback.issueId, filter.issueId) : undefined,
        filter.open ? isNull(feedback.addressedAt) : undefined,
      ),
    )
    .orderBy(desc(feedback.createdAt), desc(feedback.id))
    .limit(Math.min(Math.max(limit, 1), 200))
    .all();
}

export async function listRevisions(
  db: HubDb,
  subject: RevisionSubject,
  entityId: string,
  limit = 20,
) {
  return db
    .select()
    .from(revisions)
    .where(and(eq(revisions.subject, subject), eq(revisions.entityId, entityId)))
    .orderBy(desc(revisions.createdAt), desc(revisions.id))
    .limit(Math.min(Math.max(limit, 1), 100))
    .all();
}

/** An agent rewrites what it has learned freely; anyone else needs `lessons.update` on it. */
export async function updateLessons(ctx: Ctx, agentId: string, lessons: string | null) {
  const { db, now } = ctx;
  const agent = await loadUser(db, agentId);
  if (agent.kind !== "agent") throw new ServiceError("BAD_REQUEST", "Only agents keep lessons");
  const text = lessons?.trim() || null;
  if (text && text.length > LESSONS_MAX)
    throw new ServiceError("BAD_REQUEST", `Lessons must be at most ${LESSONS_MAX} characters`);
  if (text === agent.lessons) return agentId;
  const allowed = agentId === ctx.actorId ? [] : await authorize(ctx, "lessons.update", agentId);
  await commit(db, [
    db.update(users).set({ lessons: text, updatedAt: now }).where(eq(users.id, agentId)),
    revisionOp(ctx, "lessons", agentId, text),
    ...allowed,
    ...audit(
      db,
      [event(ctx, "lessons.update", "user", agentId, { length: text?.length ?? 0 })],
      now,
    ),
  ]);
  return agentId;
}

/** The handbook says how the company works. The owner edits it; agents need `handbook.update`. */
export async function updateHandbook(ctx: Ctx, handbook: string | null) {
  const { db, now } = ctx;
  const company = await db.select().from(workspaces).get();
  if (!company) throw notFound("Company");
  const text = handbook?.trim() || null;
  if (text && text.length > HANDBOOK_MAX)
    throw new ServiceError(
      "BAD_REQUEST",
      `The handbook must be at most ${HANDBOOK_MAX} characters`,
    );
  if (text === company.handbook) return company.id;
  const allowed = await authorize(ctx, "handbook.update");
  await commit(db, [
    db
      .update(workspaces)
      .set({ handbook: text, updatedAt: now })
      .where(eq(workspaces.id, company.id)),
    revisionOp(ctx, "handbook", company.id, text),
    ...allowed,
    ...audit(
      db,
      [event(ctx, "handbook.update", "organization", company.id, { length: text?.length ?? 0 })],
      now,
    ),
  ]);
  return company.id;
}
