import { comments, reactions, users } from "@yapm/schema";
import { and, eq, isNull } from "drizzle-orm";
import { audit } from "../audit.js";
import { newId } from "../crypto.js";
import { commit } from "../db.js";
import { normalizeEmoji } from "../emoji.js";
import { badRequest, forbidden, notFound } from "../errors.js";
import { type Ctx, cleanText, event } from "./common.js";
import { requireIssue } from "./issues.js";
import { mentionedUserIds, notify, subscribe, subscribersOf } from "./notifications.js";

export async function createComment(
  ctx: Ctx,
  input: { issueId: string; body: string; parentId?: string | null },
): Promise<string> {
  const { db, actorId, now } = ctx;
  const issue = await requireIssue(db, input.issueId);
  const body = cleanText(input.body, "Comment", 50_000);
  if (input.parentId) {
    const parent = await db.select().from(comments).where(eq(comments.id, input.parentId)).get();
    if (!parent || parent.issueId !== issue.id) throw notFound("Parent comment");
    if (parent.parentId)
      throw badRequest("Replies can't have replies; reply to the thread's first comment");
  }
  const id = newId();
  const mentioned = await mentionedUserIds(db, body);
  const followers = (await subscribersOf(db, [issue.id])).get(issue.id) ?? new Set<string>();
  await commit(db, [
    ...subscribe(
      db,
      [actorId, ...mentioned].map((userId) => ({ issueId: issue.id, userId })),
      now,
    ),
    ...notify(ctx, [
      ...mentioned.map((userId) => ({
        userId,
        type: "issueCommentMention" as const,
        issueId: issue.id,
        commentId: id,
      })),
      ...[...followers].map((userId) => ({
        userId,
        type: "issueNewComment" as const,
        issueId: issue.id,
        commentId: id,
      })),
    ]),
    db.insert(comments).values({
      id,
      issueId: issue.id,
      userId: actorId,
      parentId: input.parentId ?? null,
      body,
      createdAt: now,
      updatedAt: now,
    }),
    ...audit(
      db,
      [
        event(ctx, "comment.create", "issue", issue.id, {
          commentId: id,
          parentId: input.parentId ?? null,
        }),
      ],
      now,
    ),
  ]);
  return id;
}

async function ownComment(ctx: Ctx, id: string, allowOwner: boolean) {
  const comment = await ctx.db.select().from(comments).where(eq(comments.id, id)).get();
  if (!comment) throw notFound("Comment");
  if (comment.userId !== ctx.actorId) {
    const actor = await ctx.db
      .select({ kind: users.kind })
      .from(users)
      .where(eq(users.id, ctx.actorId))
      .get();
    if (!(allowOwner && actor?.kind === "owner"))
      throw forbidden("You can only change your own comments");
  }
  return comment;
}

export async function updateComment(
  ctx: Ctx,
  id: string,
  input: { body: string },
): Promise<string> {
  const { db, now } = ctx;
  const comment = await ownComment(ctx, id, false);
  const body = cleanText(input.body, "Comment", 50_000);
  if (body === comment.body) return id;
  await commit(db, [
    db.update(comments).set({ body, editedAt: now, updatedAt: now }).where(eq(comments.id, id)),
    ...audit(db, [event(ctx, "comment.update", "issue", comment.issueId, { commentId: id })], now),
  ]);
  return id;
}

/** Deletes a comment and its replies. Authors can delete their own; the owner can delete any. */
export async function deleteComment(ctx: Ctx, id: string): Promise<void> {
  const { db, now } = ctx;
  const comment = await ownComment(ctx, id, true);
  await commit(db, [
    db.delete(reactions).where(eq(reactions.commentId, id)),
    db.delete(comments).where(eq(comments.parentId, id)),
    db.delete(comments).where(eq(comments.id, id)),
    ...audit(db, [event(ctx, "comment.delete", "issue", comment.issueId, { commentId: id })], now),
  ]);
}

/** Adds an emoji reaction to a comment or an issue. Reacting twice with the same emoji is a no-op. */
export async function createReaction(
  ctx: Ctx,
  input: { emoji: string; commentId?: string | null; issueId?: string | null },
): Promise<string> {
  const { db, actorId, now } = ctx;
  const emoji = normalizeEmoji(cleanText(input.emoji, "Emoji", 32));
  if (!!input.commentId === !!input.issueId)
    throw badRequest("React to exactly one comment or issue");
  let commentId: string | null = null;
  let issueId: string | null = null;
  if (input.commentId) {
    const comment = await db
      .select({ id: comments.id })
      .from(comments)
      .where(eq(comments.id, input.commentId))
      .get();
    if (!comment) throw notFound("Comment");
    commentId = comment.id;
  } else if (input.issueId) {
    issueId = (await requireIssue(db, input.issueId)).id;
  }
  const existing = await db
    .select({ id: reactions.id })
    .from(reactions)
    .where(
      and(
        eq(reactions.userId, actorId),
        eq(reactions.emoji, emoji),
        commentId ? eq(reactions.commentId, commentId) : isNull(reactions.commentId),
        issueId ? eq(reactions.issueId, issueId) : isNull(reactions.issueId),
      ),
    )
    .get();
  if (existing) return existing.id;
  const id = newId();
  await commit(db, [
    db.insert(reactions).values({ id, userId: actorId, emoji, commentId, issueId, createdAt: now }),
    ...audit(
      db,
      [event(ctx, "reaction.create", "reaction", id, { emoji, commentId, issueId })],
      now,
    ),
  ]);
  return id;
}

export async function deleteReaction(ctx: Ctx, id: string): Promise<void> {
  const reaction = await ctx.db.select().from(reactions).where(eq(reactions.id, id)).get();
  if (!reaction) throw notFound("Reaction");
  if (reaction.userId !== ctx.actorId) throw forbidden("You can only remove your own reactions");
  await commit(ctx.db, [
    ctx.db.delete(reactions).where(eq(reactions.id, id)),
    ...audit(
      ctx.db,
      [event(ctx, "reaction.delete", "reaction", id, { emoji: reaction.emoji })],
      ctx.now,
    ),
  ]);
}
