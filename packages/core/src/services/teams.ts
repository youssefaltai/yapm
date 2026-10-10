import { teamMemberships, teams, users, workflowStates } from "@yapm/schema";
import { and, eq, ne } from "drizzle-orm";
import { audit } from "../audit.js";
import { newId } from "../crypto.js";
import { commit, type HubDb, type WriteOp } from "../db.js";
import { badRequest, notFound, ServiceError } from "../errors.js";
import { DEFAULT_STATES } from "../seed.js";
import { insertRows } from "../write.js";
import { type Ctx, changes, cleanText, event } from "./common.js";
import { companyTimeZone, syncTeamCycles } from "./cycles.js";
import { authorize, requireOwner } from "./requests.js";

export interface TeamCreateInput {
  name: string;
  key?: string | null;
  description?: string | null;
  icon?: string | null;
  color?: string | null;
  leadId?: string | null;
}

export type TeamUpdateInput = { [K in keyof TeamCreateInput]?: TeamCreateInput[K] | null } & {
  triageEnabled?: boolean | null;
  cyclesEnabled?: boolean | null;
  cycleDuration?: number | null;
  cycleStartDay?: number | null;
  cycleCooldown?: number | null;
  upcomingCycleCount?: number | null;
  /** Hours by priority, e.g. `{ "1": 24, "2": 72 }`; empty turns SLAs off. */
  slaHours?: Record<string, unknown> | null;
  autoArchivePeriod?: number | null;
};

function checkSla(value: Record<string, unknown> | null): Record<string, number> | null {
  if (!value) return null;
  const out: Record<string, number> = {};
  for (const [priority, hours] of Object.entries(value)) {
    if (!["1", "2", "3", "4"].includes(priority))
      throw badRequest("SLA priorities are 1 (urgent) to 4 (low)");
    if (hours === null || hours === 0) continue;
    if (typeof hours !== "number" || !Number.isFinite(hours) || hours < 1 || hours > 24 * 365)
      throw badRequest("SLA hours must be between 1 and 8760");
    out[priority] = Math.round(hours);
  }
  return Object.keys(out).length ? out : null;
}

function whole(value: number, label: string, min: number, max: number) {
  if (!Number.isInteger(value) || value < min || value > max)
    throw badRequest(`${label} must be a whole number from ${min} to ${max}`);
  return value;
}

const KEY_PATTERN = /^[A-Z][A-Z0-9]{0,6}$/;

function normalizeKey(key: string): string {
  const normalized = key.trim().toUpperCase();
  if (!KEY_PATTERN.test(normalized)) {
    throw badRequest("Team key must be 1–7 letters or digits, starting with a letter (e.g. FIN)");
  }
  return normalized;
}

/** Suggests a key from a name the way Linear does: initials, or the first letters. */
export function suggestKey(name: string): string {
  const words = name
    .toUpperCase()
    .replace(/[^A-Z0-9 ]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  const initials = words.map((w) => w[0]).join("");
  const key = initials.length >= 2 ? initials : (words[0] ?? "TEAM").slice(0, 3);
  return /^[A-Z]/.test(key) ? key.slice(0, 7) : `T${key}`.slice(0, 7);
}

async function assertKeyFree(db: HubDb, key: string, exceptId?: string) {
  const clash = await db
    .select({ id: teams.id })
    .from(teams)
    .where(exceptId ? and(eq(teams.key, key), ne(teams.id, exceptId)) : eq(teams.key, key))
    .get();
  if (clash) throw new ServiceError("CONFLICT", `A team with key ${key} already exists`);
}

async function assertActiveUser(db: HubDb, id: string, what: string) {
  const user = await db.select({ active: users.active }).from(users).where(eq(users.id, id)).get();
  if (!user?.active) throw notFound(what);
}

/** Creates a team with Linear's default workflow states. The creator and the owner become members. */
export async function createTeam(ctx: Ctx, input: TeamCreateInput) {
  const { db, actorId, now } = ctx;
  const name = cleanText(input.name, "Team name", 80);
  const key = normalizeKey(input.key ?? suggestKey(name));
  await assertKeyFree(db, key);
  if (input.leadId) await assertActiveUser(db, input.leadId, "Team lead");
  const allowed = await authorize(ctx, "team.create");

  const id = newId();
  const stamp = { createdAt: now, updatedAt: now };
  const owner = await db.select({ id: users.id }).from(users).where(eq(users.kind, "owner")).get();
  const memberIds = new Set([actorId, owner?.id, input.leadId].filter((v): v is string => !!v));

  const ops: WriteOp[] = [
    ...allowed,
    db.insert(teams).values({
      id,
      key,
      name,
      description: input.description?.trim() || null,
      icon: input.icon ?? null,
      color: input.color ?? null,
      leadId: input.leadId ?? null,
      ...stamp,
    }),
    ...insertRows(
      db,
      teamMemberships,
      [...memberIds].map((userId) => ({ teamId: id, userId, createdAt: now })),
    ),
    ...insertRows(
      db,
      workflowStates,
      DEFAULT_STATES.map((state, position) => ({
        id: newId(),
        teamId: id,
        ...state,
        position,
        ...stamp,
      })),
    ),
    ...audit(
      db,
      [event(ctx, "team.create", "team", id, { key, name, leadId: input.leadId ?? null })],
      now,
    ),
  ];
  await commit(db, ops);
  return id;
}

/** The owner adds a member to a team, or with `remove` takes them off it. */
export async function setTeamMembership(
  ctx: Ctx,
  teamId: string,
  userId: string,
  remove = false,
): Promise<string> {
  const { db, now } = ctx;
  await requireOwner(ctx, "change team members");
  const team = await db.select({ id: teams.id }).from(teams).where(eq(teams.id, teamId)).get();
  if (!team) throw notFound("Team");
  await assertActiveUser(db, userId, "Member");
  const where = and(eq(teamMemberships.teamId, teamId), eq(teamMemberships.userId, userId));
  const member = await db.select().from(teamMemberships).where(where).get();
  if (!!member !== remove) return teamId;
  await commit(db, [
    remove
      ? db.delete(teamMemberships).where(where)
      : db.insert(teamMemberships).values({ teamId, userId, createdAt: now }),
    ...audit(
      db,
      [
        event(ctx, `teamMembership.${remove ? "delete" : "create"}`, "team", teamId, {
          userId,
        }),
      ],
      now,
    ),
  ]);
  return teamId;
}

export async function updateTeam(ctx: Ctx, id: string, input: TeamUpdateInput) {
  const { db, now } = ctx;
  const team = await db.select().from(teams).where(eq(teams.id, id)).get();
  if (!team) throw notFound("Team");

  const next: Partial<typeof teams.$inferInsert> = {};
  if (input.name !== undefined && input.name !== null)
    next.name = cleanText(input.name, "Team name", 80);
  if (input.key !== undefined && input.key !== null) {
    next.key = normalizeKey(input.key);
    await assertKeyFree(db, next.key, id);
  }
  if (input.description !== undefined) next.description = input.description?.trim() || null;
  if (input.icon !== undefined) next.icon = input.icon;
  if (input.color !== undefined) next.color = input.color;
  if (input.leadId !== undefined) {
    if (input.leadId) await assertActiveUser(db, input.leadId, "Team lead");
    next.leadId = input.leadId;
  }

  if (input.triageEnabled != null) next.triageEnabled = input.triageEnabled;
  if (input.cyclesEnabled != null) next.cyclesEnabled = input.cyclesEnabled;
  if (input.cycleDuration != null)
    next.cycleDuration = whole(input.cycleDuration, "Cycle length in weeks", 1, 8);
  if (input.cycleStartDay != null)
    next.cycleStartDay = whole(input.cycleStartDay, "Cycle start day", 0, 6);
  if (input.cycleCooldown != null)
    next.cycleCooldown = whole(input.cycleCooldown, "Cooldown in weeks", 0, 4);
  if (input.upcomingCycleCount != null)
    next.upcomingCycleCount = whole(input.upcomingCycleCount, "Upcoming cycles", 1, 10);

  if (input.slaHours !== undefined) next.slaHours = checkSla(input.slaHours);
  if (input.autoArchivePeriod != null)
    next.autoArchivePeriod = whole(input.autoArchivePeriod, "Auto-archive after months", 0, 24);

  const { slaHours, ...plain } = next;
  const diff = changes(team, plain) ?? {};
  if (slaHours !== undefined && JSON.stringify(slaHours) !== JSON.stringify(team.slaHours))
    diff.slaHours = { from: team.slaHours, to: slaHours };
  else delete next.slaHours;
  if (!Object.keys(diff).length) return id;
  const ops: WriteOp[] = [
    db
      .update(teams)
      .set({ ...next, updatedAt: now })
      .where(eq(teams.id, id)),
  ];
  if (next.leadId) {
    ops.push(
      db
        .insert(teamMemberships)
        .values({ teamId: id, userId: next.leadId, createdAt: now })
        .onConflictDoNothing(),
    );
  }
  ops.push(...audit(db, [event(ctx, "team.update", "team", id, diff)], now));
  await commit(db, ops);
  // Turning cycles on (or changing their shape) creates the cycles straight away.
  const updated = { ...team, ...next };
  if (updated.cyclesEnabled) await syncTeamCycles(db, updated, await companyTimeZone(db), now);
  return id;
}
