import {
  issues,
  teams,
  WORKFLOW_STATE_TYPES,
  type WorkflowStateType,
  workflowStates,
} from "@life-os/schema";
import { asc, eq } from "drizzle-orm";
import { audit } from "../audit.js";
import { newId } from "../crypto.js";
import { commit, type HubDb, type WriteOp } from "../db.js";
import { badRequest, notFound, ServiceError } from "../errors.js";
import { DEFAULT_STATES } from "../seed.js";
import { type Ctx, changes, cleanText, event } from "./common.js";
import { checkColor } from "./labels.js";

export interface StateInput {
  name?: string | null;
  color?: string | null;
  description?: string | null;
  /** The status's place in the team's list, from 0. */
  position?: number | null;
}

type StateRow = typeof workflowStates.$inferSelect;

function teamStates(db: HubDb, teamId: string) {
  return db
    .select()
    .from(workflowStates)
    .where(eq(workflowStates.teamId, teamId))
    .orderBy(asc(workflowStates.position))
    .all();
}

function checkName(states: StateRow[], name: string, id?: string) {
  const lower = name.toLowerCase();
  if (states.some((s) => s.id !== id && s.name.toLowerCase() === lower))
    throw new ServiceError("CONFLICT", `A status named "${name}" already exists in this team`);
}

/** Writes the positions that changed when the team's statuses take this order, but `skip`'s. */
function renumber(db: HubDb, ordered: StateRow[], now: number, skip?: string): WriteOp[] {
  return ordered.flatMap((s, position) =>
    s.id === skip || s.position === position
      ? []
      : [
          db
            .update(workflowStates)
            .set({ position, updatedAt: now })
            .where(eq(workflowStates.id, s.id)),
        ],
  );
}

function place(ordered: StateRow[], state: StateRow, position: number) {
  const rest = ordered.filter((s) => s.id !== state.id);
  const at = Math.max(0, Math.min(Math.trunc(position), rest.length));
  return [...rest.slice(0, at), state, ...rest.slice(at)];
}

export async function createState(
  ctx: Ctx,
  input: StateInput & { teamId: string; name: string; type: WorkflowStateType },
): Promise<string> {
  const { db, now } = ctx;
  const team = await db
    .select({ id: teams.id })
    .from(teams)
    .where(eq(teams.id, input.teamId))
    .get();
  if (!team) throw notFound("Team");
  const name = cleanText(input.name, "Status name", 60);
  const states = await teamStates(db, team.id);
  checkName(states, name);
  const color =
    input.color ?? DEFAULT_STATES.find((s) => s.type === input.type)?.color ?? "#8b8b90";
  checkColor(color);
  const id = newId();
  const state: StateRow = {
    id,
    teamId: team.id,
    name,
    type: input.type,
    color,
    description: input.description?.trim() || null,
    position: states.length,
    createdAt: now,
    updatedAt: now,
  };
  // By default it goes after the team's other statuses of its type.
  const rank = WORKFLOW_STATE_TYPES.indexOf(input.type);
  const after = states.findLastIndex((s) => WORKFLOW_STATE_TYPES.indexOf(s.type) <= rank);
  const ordered = place([...states, state], state, input.position ?? after + 1);
  const position = ordered.indexOf(state);
  await commit(db, [
    ...renumber(db, ordered, now, id),
    db.insert(workflowStates).values({ ...state, position }),
    ...audit(
      db,
      [
        event(ctx, "workflowState.create", "workflowState", id, {
          teamId: team.id,
          name,
          type: input.type,
        }),
      ],
      now,
    ),
  ]);
  return id;
}

export async function updateState(ctx: Ctx, id: string, input: StateInput): Promise<string> {
  const { db, now } = ctx;
  const state = await db.select().from(workflowStates).where(eq(workflowStates.id, id)).get();
  if (!state) throw notFound("Status");
  const states = await teamStates(db, state.teamId);
  const next: Partial<StateRow> = {};
  if (input.name != null) {
    next.name = cleanText(input.name, "Status name", 60);
    checkName(states, next.name, id);
  }
  if (input.color != null) {
    checkColor(input.color);
    next.color = input.color;
  }
  if (input.description !== undefined) next.description = input.description?.trim() || null;
  const ordered = input.position != null ? place(states, state, input.position) : states;
  if (input.position != null) next.position = ordered.findIndex((s) => s.id === id);
  const diff = changes(state, next);
  if (!diff) return id;
  await commit(db, [
    ...renumber(db, ordered, now, id),
    db
      .update(workflowStates)
      .set({ ...next, updatedAt: now })
      .where(eq(workflowStates.id, id)),
    ...audit(db, [event(ctx, "workflowState.update", "workflowState", id, diff)], now),
  ]);
  return id;
}

/** Removes a status no issue uses; each team keeps at least one status of every type it has. */
export async function archiveState(ctx: Ctx, id: string): Promise<void> {
  const { db, now } = ctx;
  const state = await db.select().from(workflowStates).where(eq(workflowStates.id, id)).get();
  if (!state) throw notFound("Status");
  const states = await teamStates(db, state.teamId);
  const used = await db.select({ id: issues.id }).from(issues).where(eq(issues.stateId, id)).get();
  if (used) throw badRequest(`Move the issues in "${state.name}" to another status first`);
  if (!states.some((s) => s.id !== id && s.type === state.type))
    throw badRequest(`"${state.name}" is the team's last ${state.type} status`);
  await commit(db, [
    db.delete(workflowStates).where(eq(workflowStates.id, id)),
    ...renumber(
      db,
      states.filter((s) => s.id !== id),
      now,
    ),
    ...audit(
      db,
      [event(ctx, "workflowState.archive", "workflowState", id, { name: state.name })],
      now,
    ),
  ]);
}
