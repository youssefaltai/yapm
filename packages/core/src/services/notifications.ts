import { issueSubscriptions, type NotificationType, notifications, users } from "@life-os/schema";
import { and, eq, inArray, isNull, lte, or } from "drizzle-orm";
import { audit } from "../audit.js";
import { newId } from "../crypto.js";
import { commit, type HubDb, type WriteOp } from "../db.js";
import { forbidden, notFound } from "../errors.js";
import { insertRows } from "../write.js";
import { type Ctx, event } from "./common.js";

export interface NotificationInput {
  userId: string;
  type: NotificationType;
  issueId?: string | null;
  commentId?: string | null;
  requestId?: string | null;
  projectId?: string | null;
  projectUpdateId?: string | null;
  data?: Record<string, unknown>;
}

/**
 * Members named with `@Name` in some markdown. Names can have spaces ("@Finance Lead"), so this
 * matches against the actual names, longest first, rather than guessing where a name ends.
 */
export async function mentionedUserIds(db: HubDb, text: string | null | undefined) {
  if (!text?.includes("@")) return [];
  const members = await db
    .select({ id: users.id, name: users.name })
    .from(users)
    .where(eq(users.active, true))
    .all();
  const lower = text.toLowerCase();
  const found = new Set<string>();
  for (const member of members.sort((a, b) => b.name.length - a.name.length)) {
    const name = `@${member.name.toLowerCase()}`;
    for (let at = lower.indexOf(name); at !== -1; at = lower.indexOf(name, at + 1)) {
      const before = at === 0 ? " " : (lower[at - 1] ?? " ");
      const after = lower[at + name.length] ?? " ";
      if (!/[\w@]/.test(before) && !/\w/.test(after)) {
        found.add(member.id);
        break;
      }
    }
  }
  return [...found];
}

/** Who follows each issue. */
export async function subscribersOf(db: HubDb, issueIds: string[]) {
  const map = new Map<string, Set<string>>(issueIds.map((id) => [id, new Set()]));
  if (!issueIds.length) return map;
  const rows = await db
    .select()
    .from(issueSubscriptions)
    .where(inArray(issueSubscriptions.issueId, issueIds))
    .all();
  for (const row of rows) map.get(row.issueId)?.add(row.userId);
  return map;
}

/** Makes members follow issues; following twice is fine. */
export function subscribe(
  db: HubDb,
  pairs: { issueId: string; userId: string | null | undefined }[],
  now: number,
): WriteOp[] {
  const rows = new Map<string, { issueId: string; userId: string; createdAt: number }>();
  for (const { issueId, userId } of pairs) {
    if (userId) rows.set(`${issueId}:${userId}`, { issueId, userId, createdAt: now });
  }
  const all = [...rows.values()];
  const ops: WriteOp[] = [];
  // Three columns a row keeps each statement well under D1's 100 bound parameters.
  for (let i = 0; i < all.length; i += 30) {
    ops.push(
      db
        .insert(issueSubscriptions)
        .values(all.slice(i, i + 30))
        .onConflictDoNothing(),
    );
  }
  return ops;
}

/**
 * Inbox entries for a change. Nobody is notified of their own actions, and each member gets
 * at most one notification per issue (or request) for one change: the first type listed wins,
 * so callers list the most specific (a mention) before the general (a new comment).
 */
export function notify(ctx: Ctx, inputs: NotificationInput[]): WriteOp[] {
  const seen = new Set<string>();
  const rows: (typeof notifications.$inferInsert)[] = [];
  for (const input of inputs) {
    if (input.userId === ctx.actorId) continue;
    const key = `${input.userId}:${input.requestId ?? input.projectUpdateId ?? input.issueId ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({
      id: newId(),
      userId: input.userId,
      type: input.type,
      actorId: ctx.actorId || null,
      issueId: input.issueId ?? null,
      commentId: input.commentId ?? null,
      requestId: input.requestId ?? null,
      projectId: input.projectId ?? null,
      projectUpdateId: input.projectUpdateId ?? null,
      data: input.data ?? null,
      createdAt: ctx.now,
      updatedAt: ctx.now,
    });
  }
  if (rows.length) ctx.notified = true;
  return insertRows(ctx.db, notifications, rows);
}

/** The owner's id: requests go to the owner's Inbox. */
export async function ownerId(db: HubDb): Promise<string | null> {
  const row = await db.select({ id: users.id }).from(users).where(eq(users.kind, "owner")).get();
  return row?.id ?? null;
}

async function ownNotification(ctx: Ctx, id: string) {
  const row = await ctx.db.select().from(notifications).where(eq(notifications.id, id)).get();
  if (!row) throw notFound("Notification");
  if (row.userId !== ctx.actorId) throw forbidden("That notification isn't yours");
  return row;
}

export interface NotificationUpdateInput {
  /** Mark read (a time) or unread (null). */
  readAt?: number | null;
  /** Hide it until then; null wakes it now. */
  snoozedUntilAt?: number | null;
}

export async function updateNotification(ctx: Ctx, id: string, input: NotificationUpdateInput) {
  const { db, now } = ctx;
  await ownNotification(ctx, id);
  const set: Partial<typeof notifications.$inferInsert> = { updatedAt: now };
  if (input.readAt !== undefined) set.readAt = input.readAt;
  if (input.snoozedUntilAt !== undefined) set.snoozedUntilAt = input.snoozedUntilAt;
  await commit(db, [
    db.update(notifications).set(set).where(eq(notifications.id, id)),
    ...audit(db, [event(ctx, "notification.update", "notification", id, { ...input })], now),
  ]);
  return id;
}

export async function archiveNotification(ctx: Ctx, id: string, archived = true) {
  const { db, now } = ctx;
  const row = await ownNotification(ctx, id);
  await commit(db, [
    db
      .update(notifications)
      .set({
        archivedAt: archived ? now : null,
        readAt: archived ? (row.readAt ?? now) : row.readAt,
        updatedAt: now,
      })
      .where(eq(notifications.id, id)),
    ...audit(
      db,
      [
        event(
          ctx,
          archived ? "notification.archive" : "notification.unarchive",
          "notification",
          id,
        ),
      ],
      now,
    ),
  ]);
  return id;
}

/** Marks everything in the viewer's Inbox read, optionally only one issue's notifications. */
export async function markAllRead(ctx: Ctx, issueId?: string | null) {
  const { db, now } = ctx;
  await commit(db, [
    db
      .update(notifications)
      .set({ readAt: now, updatedAt: now })
      .where(
        and(
          eq(notifications.userId, ctx.actorId),
          isNull(notifications.readAt),
          issueId ? eq(notifications.issueId, issueId) : undefined,
        ),
      ),
    ...audit(
      db,
      [event(ctx, "notification.markReadAll", "user", ctx.actorId, { issueId: issueId ?? null })],
      now,
    ),
  ]);
}

/** Visible in the Inbox now: not archived, and not snoozed into the future. */
export function inInbox(userId: string, now: number) {
  return and(
    eq(notifications.userId, userId),
    isNull(notifications.archivedAt),
    or(isNull(notifications.snoozedUntilAt), lte(notifications.snoozedUntilAt, now)),
  );
}

export async function setSubscribed(ctx: Ctx, issueId: string, userId: string, on: boolean) {
  const { db, now } = ctx;
  const target = await db.select().from(users).where(eq(users.id, userId)).get();
  if (!target?.active) throw notFound("Member");
  if (userId !== ctx.actorId) {
    const actor = await db.select().from(users).where(eq(users.id, ctx.actorId)).get();
    if (actor?.kind !== "owner") throw forbidden("You can only subscribe yourself");
  }
  await commit(db, [
    on
      ? db
          .insert(issueSubscriptions)
          .values({ issueId, userId, createdAt: now })
          .onConflictDoNothing()
      : db
          .delete(issueSubscriptions)
          .where(
            and(eq(issueSubscriptions.issueId, issueId), eq(issueSubscriptions.userId, userId)),
          ),
    ...audit(
      db,
      [event(ctx, on ? "issue.subscribe" : "issue.unsubscribe", "issue", issueId, { userId })],
      now,
    ),
  ]);
}
