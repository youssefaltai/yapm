import { machines, users } from "@life-os/schema";
import { and, asc, eq, lt } from "drizzle-orm";
import { audit } from "../audit.js";
import { newId, randomToken, sha256Hex } from "../crypto.js";
import { commit, type HubDb } from "../db.js";
import { badRequest, forbidden, notFound, ServiceError } from "../errors.js";
import { type Ctx, cleanText, event } from "./common.js";

export const MACHINE_TOKEN_PREFIX = "lrn_";

/** Pending enrolments expire, and only a few may wait at once: enrolling needs no account. */
const PENDING_TTL = 60 * 60 * 1000;
const MAX_PENDING = 5;

const TAG = /^[a-z0-9][a-z0-9_.-]{0,39}$/;

export function cleanTags(tags: unknown, label = "Tags"): string[] {
  if (!Array.isArray(tags)) return [];
  const out = new Set<string>();
  for (const tag of tags) {
    const value = String(tag).trim().toLowerCase();
    if (!TAG.test(value))
      throw badRequest(`${label} must be short lowercase words like employer-a`);
    out.add(value);
  }
  if (out.size > 20) throw badRequest(`At most 20 ${label.toLowerCase()}`);
  return [...out];
}

function cleanNames(names: unknown): string[] {
  if (!Array.isArray(names)) return [];
  return [...new Set(names.map((n) => String(n).trim()).filter(Boolean))].slice(0, 50);
}

export interface MachineEnrolInput {
  name: string;
  tags?: unknown;
  mcps?: unknown;
  capacity?: number;
  version?: string;
}

/**
 * A runner asks to join. It gets a secret it keeps and a pairing code it shows; the machine
 * can't do anything until the owner approves a matching code in the app.
 */
export async function enrolMachine(db: HubDb, input: MachineEnrolInput, now: number) {
  const name = cleanText(String(input.name ?? ""), "Machine name", 60);
  const tags = cleanTags(input.tags);
  const mcps = cleanNames(input.mcps);
  const capacity = Math.min(Math.max(Math.floor(input.capacity ?? 2), 1), 16);
  await db
    .delete(machines)
    .where(and(eq(machines.status, "pending"), lt(machines.createdAt, now - PENDING_TTL)))
    .run();
  const pending = await db
    .select({ id: machines.id })
    .from(machines)
    .where(eq(machines.status, "pending"))
    .all();
  if (pending.length >= MAX_PENDING)
    throw new ServiceError(
      "CONFLICT",
      "Too many machines are waiting for approval; approve or remove some first",
    );
  const id = newId();
  const token = randomToken(MACHINE_TOKEN_PREFIX);
  const digits = crypto.getRandomValues(new Uint32Array(1))[0] ?? 0;
  const pairingCode = String(digits % 1_000_000).padStart(6, "0");
  await commit(db, [
    db.insert(machines).values({
      id,
      name,
      status: "pending",
      pairingCode,
      tokenHash: await sha256Hex(token),
      tags,
      mcps,
      capacity,
      version: input.version?.slice(0, 40) ?? null,
      lastSeenAt: now,
      createdAt: now,
      updatedAt: now,
    }),
    ...audit(
      db,
      [
        {
          actorId: null,
          action: "machine.enrol",
          entityType: "machine",
          entityId: id,
          data: { name, tags },
        },
      ],
      now,
    ),
  ]);
  return { id, token, pairingCode };
}

/** The machine a runner secret belongs to, unless it was revoked. */
export async function machineForToken(db: HubDb, token: string) {
  if (!token.startsWith(MACHINE_TOKEN_PREFIX)) return null;
  const row = await db
    .select()
    .from(machines)
    .where(eq(machines.tokenHash, await sha256Hex(token)))
    .get();
  return row && row.status !== "revoked" ? row : null;
}

async function requireOwner(ctx: Ctx) {
  const actor = await ctx.db.select().from(users).where(eq(users.id, ctx.actorId)).get();
  if (actor?.kind !== "owner") throw forbidden("Only the owner manages machines");
}

async function loadMachine(ctx: Ctx, id: string) {
  const row = await ctx.db.select().from(machines).where(eq(machines.id, id)).get();
  if (!row) throw notFound("Machine");
  return row;
}

/** The owner confirms the code shown on the machine. */
export async function approveMachine(ctx: Ctx, id: string, pairingCode: string) {
  const { db, now } = ctx;
  await requireOwner(ctx);
  const machine = await loadMachine(ctx, id);
  if (machine.status !== "pending")
    throw new ServiceError("CONFLICT", `This machine is already ${machine.status}`);
  if (machine.pairingCode !== pairingCode.trim())
    throw badRequest("That code doesn't match the one on the machine");
  await commit(db, [
    db
      .update(machines)
      .set({ status: "active", approvedAt: now, updatedAt: now })
      .where(eq(machines.id, id)),
    ...audit(db, [event(ctx, "machine.approve", "machine", id, { name: machine.name })], now),
  ]);
  return id;
}

export async function updateMachine(
  ctx: Ctx,
  id: string,
  input: { name?: string | null; tags?: string[] | null },
) {
  const { db, now } = ctx;
  await requireOwner(ctx);
  const machine = await loadMachine(ctx, id);
  const set: Partial<typeof machines.$inferInsert> = { updatedAt: now };
  if (input.name != null) set.name = cleanText(input.name, "Machine name", 60);
  if (input.tags != null) set.tags = cleanTags(input.tags);
  await commit(db, [
    db.update(machines).set(set).where(eq(machines.id, id)),
    ...audit(
      db,
      [
        event(ctx, "machine.update", "machine", id, {
          from: { name: machine.name, tags: machine.tags },
          to: { name: set.name, tags: set.tags },
        }),
      ],
      now,
    ),
  ]);
  return id;
}

/** Removes a machine: its secret stops working. A pending one is simply forgotten. */
export async function revokeMachine(ctx: Ctx, id: string) {
  const { db, now } = ctx;
  await requireOwner(ctx);
  const machine = await loadMachine(ctx, id);
  await commit(db, [
    machine.status === "pending"
      ? db.delete(machines).where(eq(machines.id, id))
      : db.update(machines).set({ status: "revoked", updatedAt: now }).where(eq(machines.id, id)),
    ...audit(db, [event(ctx, "machine.revoke", "machine", id, { name: machine.name })], now),
  ]);
  return id;
}

export function listMachines(db: HubDb) {
  return db.select().from(machines).orderBy(asc(machines.createdAt)).all();
}
