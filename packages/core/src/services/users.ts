import { apiTokens, teamMemberships, users } from "@life-os/schema";
import { and, eq, isNull, ne, sql } from "drizzle-orm";
import { audit } from "../audit.js";
import { newId } from "../crypto.js";
import { commit, type HubDb, type WriteOp } from "../db.js";
import { forbidden, notFound, ServiceError } from "../errors.js";
import { type Ctx, changes, cleanText, event } from "./common.js";

export interface AgentHireInput {
  name: string;
  title?: string | null;
  charter?: string | null;
  /** Who the agent reports to; defaults to the owner. */
  managerId?: string | null;
}

export interface UserUpdateInput {
  name?: string | null;
  title?: string | null;
  charter?: string | null;
  managerId?: string | null;
}

async function actor(ctx: Ctx) {
  const row = await ctx.db.select().from(users).where(eq(users.id, ctx.actorId)).get();
  if (!row) throw notFound("Actor");
  return row;
}

/** Org changes are the owner's for now; agents get them through grants. */
async function requireOwnerActor(ctx: Ctx, what: string) {
  if ((await actor(ctx)).kind !== "owner") throw forbidden(`Only the owner can ${what} for now`);
}

/** Names are how agents address each other ("assign to Finance Lead"), so active ones are unique. */
async function assertNameFree(db: HubDb, name: string, exceptId?: string) {
  const clash = await db
    .select({ id: users.id })
    .from(users)
    .where(
      and(
        sql`lower(${users.name}) = ${name.toLowerCase()}`,
        eq(users.active, true),
        exceptId ? ne(users.id, exceptId) : undefined,
      ),
    )
    .get();
  if (clash) throw new ServiceError("CONFLICT", `Someone is already called ${name}`);
}

/** Rejects a manager that would make someone report to themselves, directly or not. */
async function checkManager(db: HubDb, userId: string | null, managerId: string) {
  let current: string | null = managerId;
  for (let depth = 0; current; depth++) {
    if (current === userId)
      throw new ServiceError("BAD_REQUEST", "Nobody can report to themselves");
    if (depth > 50) throw new ServiceError("BAD_REQUEST", "The reporting line is too deep");
    const row: { managerId: string | null; active: boolean } | undefined = await db
      .select({ managerId: users.managerId, active: users.active })
      .from(users)
      .where(eq(users.id, current))
      .get();
    if (!row?.active) throw notFound("Manager");
    current = row.managerId;
  }
}

export async function hireAgent(ctx: Ctx, input: AgentHireInput): Promise<string> {
  const { db, now } = ctx;
  await requireOwnerActor(ctx, "hire agents");
  const name = cleanText(input.name, "Name", 60);
  await assertNameFree(db, name);
  const owner = await db.select({ id: users.id }).from(users).where(eq(users.kind, "owner")).get();
  const managerId = input.managerId ?? owner?.id ?? null;
  if (managerId) await checkManager(db, null, managerId);
  const id = newId();
  const title = input.title?.trim() || null;
  await commit(db, [
    db.insert(users).values({
      id,
      kind: "agent",
      name,
      displayName: name,
      title,
      charter: input.charter?.trim() || null,
      managerId,
      createdAt: now,
      updatedAt: now,
    }),
    ...audit(db, [event(ctx, "agent.hire", "user", id, { name, title, managerId })], now),
  ]);
  return id;
}

export async function updateUser(ctx: Ctx, id: string, input: UserUpdateInput): Promise<string> {
  const { db, now } = ctx;
  const user = await db.select().from(users).where(eq(users.id, id)).get();
  if (!user) throw notFound("User");
  if (id !== ctx.actorId) await requireOwnerActor(ctx, "change other members");
  const next: Partial<typeof user> = {};
  if (input.name != null) {
    next.name = cleanText(input.name, "Name", 60);
    next.displayName = next.name;
    await assertNameFree(db, next.name, id);
  }
  if (input.title !== undefined) next.title = input.title?.trim() || null;
  if (input.managerId !== undefined) {
    if (user.kind === "owner" && input.managerId)
      throw new ServiceError("BAD_REQUEST", "The owner reports to no one");
    if (input.managerId) await checkManager(db, id, input.managerId);
    next.managerId = input.managerId;
  }
  const { charter } = input;
  const diff = changes(user, next);
  const charterChanged = charter !== undefined && (charter?.trim() || null) !== user.charter;
  if (!diff && !charterChanged) return id;
  if (charterChanged) {
    if (user.kind !== "agent") throw new ServiceError("BAD_REQUEST", "Only agents have charters");
    next.charter = charter?.trim() || null;
  }
  const events = [];
  if (diff) events.push(event(ctx, "user.update", "user", id, diff));
  // Charters are long; the history keeps both versions so changes can be explained later.
  if (charterChanged)
    events.push(event(ctx, "charter.update", "user", id, { from: user.charter, to: next.charter }));
  await commit(db, [
    db
      .update(users)
      .set({ ...next, updatedAt: now })
      .where(eq(users.id, id)),
    ...audit(db, events, now),
  ]);
  return id;
}

/** Retires an agent: it can no longer sign in or act, and its tokens stop working. Its history stays. */
export async function retireAgent(ctx: Ctx, id: string): Promise<string> {
  const { db, now } = ctx;
  await requireOwnerActor(ctx, "retire agents");
  const user = await db.select().from(users).where(eq(users.id, id)).get();
  if (!user) throw notFound("User");
  if (user.kind !== "agent") throw new ServiceError("BAD_REQUEST", "Only agents can be retired");
  if (!user.active) return id;
  const ops: WriteOp[] = [
    db.update(users).set({ active: false, updatedAt: now }).where(eq(users.id, id)),
    db
      .update(apiTokens)
      .set({ revokedAt: now })
      .where(and(eq(apiTokens.userId, id), isNull(apiTokens.revokedAt))),
    db.delete(teamMemberships).where(eq(teamMemberships.userId, id)),
    // Their reports move up to their manager.
    db
      .update(users)
      .set({ managerId: user.managerId, updatedAt: now })
      .where(eq(users.managerId, id)),
    ...audit(db, [event(ctx, "agent.retire", "user", id, { name: user.name })], now),
  ];
  await commit(db, ops);
  return id;
}

export async function revokeApiToken(ctx: Ctx, id: string): Promise<void> {
  const { db, now } = ctx;
  await requireOwnerActor(ctx, "revoke API tokens");
  const token = await db.select().from(apiTokens).where(eq(apiTokens.id, id)).get();
  if (!token) throw notFound("API token");
  if (token.revokedAt) return;
  await commit(db, [
    db.update(apiTokens).set({ revokedAt: now }).where(eq(apiTokens.id, id)),
    ...audit(
      db,
      [event(ctx, "apiToken.revoke", "apiToken", id, { userId: token.userId, name: token.name })],
      now,
    ),
  ]);
}
