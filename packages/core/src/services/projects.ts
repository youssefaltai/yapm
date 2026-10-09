import {
  documents,
  INITIATIVE_STATUSES,
  type InitiativeStatus,
  initiatives,
  issues,
  PROJECT_HEALTHS,
  PROJECT_STATES,
  type ProjectHealth,
  type ProjectState,
  projectMilestones,
  projects,
  projectTeams,
  projectUpdates,
  teams,
  users,
} from "@life-os/schema";
import { eq, inArray } from "drizzle-orm";
import { audit } from "../audit.js";
import { newId } from "../crypto.js";
import { commit, type HubDb, type WriteOp } from "../db.js";
import { badRequest, forbidden, notFound } from "../errors.js";
import { insertRows } from "../write.js";
import { type Ctx, changes, cleanText, event } from "./common.js";
import { notify, ownerId } from "./notifications.js";

// Planning, like Linear: projects (with milestones and status updates), initiatives that
// group projects, and documents.

const COLOR = /^#[0-9a-fA-F]{6}$/;

function checkColor(color: string) {
  if (!COLOR.test(color)) throw badRequest("Color must be a hex color like #8b8b90");
}

function checkDate(date: string, label: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date)))
    throw badRequest(`${label} must be a date like 2026-10-31`);
}

function checkOneOf<T extends string>(value: string, values: readonly T[], label: string): T {
  if (!values.includes(value as T))
    throw badRequest(`${label} must be one of ${values.join(", ")}`);
  return value as T;
}

async function checkUser(db: HubDb, id: string, label: string) {
  const row = await db.select({ active: users.active }).from(users).where(eq(users.id, id)).get();
  if (!row?.active) throw notFound(label);
}

async function checkTeams(db: HubDb, ids: string[]) {
  if (!ids.length) return;
  const found = await db.select({ id: teams.id }).from(teams).where(inArray(teams.id, ids)).all();
  if (found.length !== ids.length) throw notFound("Team");
}

export async function requireProject(db: HubDb, id: string) {
  const row = await db.select().from(projects).where(eq(projects.id, id)).get();
  if (!row) throw notFound("Project");
  return row;
}

async function checkInitiative(db: HubDb, id: string) {
  const row = await db
    .select({ id: initiatives.id })
    .from(initiatives)
    .where(eq(initiatives.id, id))
    .get();
  if (!row) throw notFound("Initiative");
}

/** Linear keeps startedAt, completedAt and canceledAt in step with the project's state. */
function stateTimestamps(state: ProjectState, now: number, current?: { startedAt: number | null }) {
  return {
    startedAt:
      state === "started" || state === "paused" || state === "completed"
        ? (current?.startedAt ?? now)
        : null,
    completedAt: state === "completed" ? now : null,
    canceledAt: state === "canceled" ? now : null,
  };
}

export interface ProjectInput {
  name?: string | null;
  summary?: string | null;
  description?: string | null;
  icon?: string | null;
  color?: string | null;
  state?: string | null;
  leadId?: string | null;
  initiativeId?: string | null;
  teamIds?: string[] | null;
  startDate?: string | null;
  targetDate?: string | null;
  sortOrder?: number | null;
}

async function cleanProject(db: HubDb, input: ProjectInput) {
  const next: Partial<typeof projects.$inferInsert> = {};
  if (input.name != null) next.name = cleanText(input.name, "Project name", 120);
  if (input.summary !== undefined) next.summary = input.summary?.trim().slice(0, 255) || null;
  if (input.description !== undefined) next.description = input.description?.trim() || null;
  if (input.icon !== undefined) next.icon = input.icon?.trim().slice(0, 16) || null;
  if (input.color != null) {
    checkColor(input.color);
    next.color = input.color;
  }
  if (input.state != null) next.state = checkOneOf(input.state, PROJECT_STATES, "State");
  if (input.leadId !== undefined) {
    if (input.leadId) await checkUser(db, input.leadId, "Lead");
    next.leadId = input.leadId || null;
  }
  if (input.initiativeId !== undefined) {
    if (input.initiativeId) await checkInitiative(db, input.initiativeId);
    next.initiativeId = input.initiativeId || null;
  }
  for (const key of ["startDate", "targetDate"] as const) {
    const value = input[key];
    if (value !== undefined) {
      if (value) checkDate(value, key === "startDate" ? "Start date" : "Target date");
      next[key] = value || null;
    }
  }
  if (input.sortOrder != null) next.sortOrder = input.sortOrder;
  return next;
}

export async function createProject(ctx: Ctx, input: ProjectInput & { name: string }) {
  const { db, now } = ctx;
  const fields = await cleanProject(db, input);
  const teamIds = [...new Set(input.teamIds ?? [])];
  await checkTeams(db, teamIds);
  const count = (await db.select({ id: projects.id }).from(projects).all()).length;
  const state = fields.state ?? "planned";
  const id = newId();
  const row = {
    ...fields,
    id,
    name: fields.name ?? "",
    color: fields.color ?? "#8b8b90",
    state,
    creatorId: ctx.actorId,
    sortOrder: fields.sortOrder ?? count,
    ...stateTimestamps(state, now),
    createdAt: now,
    updatedAt: now,
  };
  await commit(db, [
    db.insert(projects).values(row),
    ...insertRows(
      db,
      projectTeams,
      teamIds.map((teamId) => ({ projectId: id, teamId })),
    ),
    ...audit(
      db,
      [
        event(ctx, "project.create", "project", id, {
          name: row.name,
          state,
          leadId: row.leadId ?? null,
          teamIds,
        }),
      ],
      now,
    ),
  ]);
  return id;
}

export async function updateProject(ctx: Ctx, id: string, input: ProjectInput) {
  const { db, now } = ctx;
  const project = await requireProject(db, id);
  const next = await cleanProject(db, input);
  const diff = changes(project, next) ?? {};
  const ops: WriteOp[] = [];
  if (input.teamIds) {
    const teamIds = [...new Set(input.teamIds)];
    await checkTeams(db, teamIds);
    const from = (
      await db
        .select({ teamId: projectTeams.teamId })
        .from(projectTeams)
        .where(eq(projectTeams.projectId, id))
        .all()
    ).map((r) => r.teamId);
    if (from.sort().join() !== [...teamIds].sort().join()) {
      diff.teamIds = { from, to: teamIds };
      ops.push(
        db.delete(projectTeams).where(eq(projectTeams.projectId, id)),
        ...insertRows(
          db,
          projectTeams,
          teamIds.map((teamId) => ({ projectId: id, teamId })),
        ),
      );
    }
  }
  if (!Object.keys(diff).length && next.sortOrder === undefined) return id;
  const timestamps = diff.state && next.state ? stateTimestamps(next.state, now, project) : {};
  ops.push(
    db
      .update(projects)
      .set({ ...next, ...timestamps, updatedAt: now })
      .where(eq(projects.id, id)),
  );
  if (Object.keys(diff).length)
    ops.push(...audit(db, [event(ctx, "project.update", "project", id, diff)], now));
  await commit(db, ops);
  return id;
}

export async function setProjectArchived(ctx: Ctx, id: string, archived: boolean) {
  const { db, now } = ctx;
  const project = await requireProject(db, id);
  if (!!project.archivedAt === archived) return id;
  await commit(db, [
    db
      .update(projects)
      .set({ archivedAt: archived ? now : null, updatedAt: now })
      .where(eq(projects.id, id)),
    ...audit(
      db,
      [event(ctx, archived ? "project.archive" : "project.unarchive", "project", id)],
      now,
    ),
  ]);
  return id;
}

export interface MilestoneInput {
  name?: string | null;
  description?: string | null;
  targetDate?: string | null;
  sortOrder?: number | null;
}

function cleanMilestone(input: MilestoneInput) {
  const next: Partial<typeof projectMilestones.$inferInsert> = {};
  if (input.name != null) next.name = cleanText(input.name, "Milestone name", 120);
  if (input.description !== undefined) next.description = input.description?.trim() || null;
  if (input.targetDate !== undefined) {
    if (input.targetDate) checkDate(input.targetDate, "Target date");
    next.targetDate = input.targetDate || null;
  }
  if (input.sortOrder != null) next.sortOrder = input.sortOrder;
  return next;
}

export async function createMilestone(
  ctx: Ctx,
  input: MilestoneInput & { projectId: string; name: string },
) {
  const { db, now } = ctx;
  await requireProject(db, input.projectId);
  const fields = cleanMilestone(input);
  const count = (
    await db
      .select({ id: projectMilestones.id })
      .from(projectMilestones)
      .where(eq(projectMilestones.projectId, input.projectId))
      .all()
  ).length;
  const id = newId();
  await commit(db, [
    db.insert(projectMilestones).values({
      ...fields,
      id,
      projectId: input.projectId,
      name: fields.name ?? "",
      sortOrder: fields.sortOrder ?? count,
      createdAt: now,
      updatedAt: now,
    }),
    ...audit(
      db,
      [
        event(ctx, "projectMilestone.create", "projectMilestone", id, {
          projectId: input.projectId,
          name: fields.name,
          targetDate: fields.targetDate ?? null,
        }),
      ],
      now,
    ),
  ]);
  return id;
}

async function requireMilestone(db: HubDb, id: string) {
  const row = await db.select().from(projectMilestones).where(eq(projectMilestones.id, id)).get();
  if (!row) throw notFound("Milestone");
  return row;
}

export async function updateMilestone(ctx: Ctx, id: string, input: MilestoneInput) {
  const { db, now } = ctx;
  const milestone = await requireMilestone(db, id);
  const next = cleanMilestone(input);
  const diff = changes(milestone, next);
  if (!diff) return id;
  await commit(db, [
    db
      .update(projectMilestones)
      .set({ ...next, updatedAt: now })
      .where(eq(projectMilestones.id, id)),
    ...audit(db, [event(ctx, "projectMilestone.update", "projectMilestone", id, diff)], now),
  ]);
  return id;
}

/** Deletes a milestone; its issues stay in the project. */
export async function deleteMilestone(ctx: Ctx, id: string) {
  const { db, now } = ctx;
  const milestone = await requireMilestone(db, id);
  await commit(db, [
    db
      .update(issues)
      .set({ projectMilestoneId: null, updatedAt: now })
      .where(eq(issues.projectMilestoneId, id)),
    db.delete(projectMilestones).where(eq(projectMilestones.id, id)),
    ...audit(
      db,
      [
        event(ctx, "projectMilestone.delete", "projectMilestone", id, {
          projectId: milestone.projectId,
          name: milestone.name,
        }),
      ],
      now,
    ),
  ]);
  return milestone.projectId;
}

/** Checks an issue's project and milestone together: a milestone implies its project. */
export async function issueProjectFields(
  db: HubDb,
  input: { projectId?: string | null; projectMilestoneId?: string | null },
  current?: { projectId: string | null; projectMilestoneId: string | null },
) {
  const next: { projectId?: string | null; projectMilestoneId?: string | null } = {};
  if (input.projectMilestoneId) {
    const milestone = await requireMilestone(db, input.projectMilestoneId);
    if (input.projectId && input.projectId !== milestone.projectId)
      throw badRequest("That milestone belongs to another project");
    next.projectId = milestone.projectId;
    next.projectMilestoneId = milestone.id;
    return next;
  }
  if (input.projectId !== undefined) {
    if (input.projectId) await requireProject(db, input.projectId);
    next.projectId = input.projectId || null;
    // Moving to another project (or none) leaves the old project's milestone behind.
    if (input.projectId !== current?.projectId || !input.projectId) next.projectMilestoneId = null;
  }
  if (input.projectMilestoneId === null) next.projectMilestoneId = null;
  return next;
}

export async function createProjectUpdate(
  ctx: Ctx,
  input: { projectId: string; body: string; health?: string | null },
) {
  const { db, now } = ctx;
  const project = await requireProject(db, input.projectId);
  const body = cleanText(input.body, "Update", 20_000);
  const health: ProjectHealth = input.health
    ? checkOneOf(input.health, PROJECT_HEALTHS, "Health")
    : "onTrack";
  const id = newId();
  const owner = await ownerId(db);
  await commit(db, [
    db.insert(projectUpdates).values({
      id,
      projectId: project.id,
      userId: ctx.actorId,
      body,
      health,
      createdAt: now,
      updatedAt: now,
    }),
    // The project's health follows its latest update.
    db.update(projects).set({ updatedAt: now }).where(eq(projects.id, project.id)),
    ...notify(
      ctx,
      [project.leadId, owner]
        .filter((userId): userId is string => !!userId)
        .map((userId) => ({
          userId,
          type: "projectUpdateCreated" as const,
          projectId: project.id,
          projectUpdateId: id,
          data: { health, project: project.name },
        })),
    ),
    ...audit(
      db,
      [event(ctx, "projectUpdate.create", "projectUpdate", id, { projectId: project.id, health })],
      now,
    ),
  ]);
  return id;
}

async function ownUpdate(ctx: Ctx, id: string) {
  const row = await ctx.db.select().from(projectUpdates).where(eq(projectUpdates.id, id)).get();
  if (!row) throw notFound("Project update");
  if (row.userId !== ctx.actorId) {
    const actor = await ctx.db
      .select({ kind: users.kind })
      .from(users)
      .where(eq(users.id, ctx.actorId))
      .get();
    if (actor?.kind !== "owner") throw forbidden("Only its author can change an update");
  }
  return row;
}

export async function updateProjectUpdate(
  ctx: Ctx,
  id: string,
  input: { body?: string | null; health?: string | null },
) {
  const { db, now } = ctx;
  const update = await ownUpdate(ctx, id);
  const next: Partial<typeof projectUpdates.$inferInsert> = {};
  if (input.body != null) next.body = cleanText(input.body, "Update", 20_000);
  if (input.health != null) next.health = checkOneOf(input.health, PROJECT_HEALTHS, "Health");
  const diff = changes(update, next);
  if (!diff) return id;
  await commit(db, [
    db
      .update(projectUpdates)
      .set({ ...next, editedAt: now, updatedAt: now })
      .where(eq(projectUpdates.id, id)),
    ...audit(db, [event(ctx, "projectUpdate.update", "projectUpdate", id, diff)], now),
  ]);
  return id;
}

export async function deleteProjectUpdate(ctx: Ctx, id: string) {
  const { db, now } = ctx;
  const update = await ownUpdate(ctx, id);
  await commit(db, [
    db.delete(projectUpdates).where(eq(projectUpdates.id, id)),
    ...audit(
      db,
      [
        event(ctx, "projectUpdate.delete", "projectUpdate", id, {
          projectId: update.projectId,
          body: update.body,
        }),
      ],
      now,
    ),
  ]);
  return update.projectId;
}

export interface InitiativeInput {
  name?: string | null;
  description?: string | null;
  status?: string | null;
  ownerId?: string | null;
  targetDate?: string | null;
  sortOrder?: number | null;
}

async function cleanInitiative(db: HubDb, input: InitiativeInput) {
  const next: Partial<typeof initiatives.$inferInsert> = {};
  if (input.name != null) next.name = cleanText(input.name, "Initiative name", 120);
  if (input.description !== undefined) next.description = input.description?.trim() || null;
  if (input.status != null)
    next.status = checkOneOf<InitiativeStatus>(input.status, INITIATIVE_STATUSES, "Status");
  if (input.ownerId !== undefined) {
    if (input.ownerId) await checkUser(db, input.ownerId, "Owner");
    next.ownerId = input.ownerId || null;
  }
  if (input.targetDate !== undefined) {
    if (input.targetDate) checkDate(input.targetDate, "Target date");
    next.targetDate = input.targetDate || null;
  }
  if (input.sortOrder != null) next.sortOrder = input.sortOrder;
  return next;
}

export async function createInitiative(ctx: Ctx, input: InitiativeInput & { name: string }) {
  const { db, now } = ctx;
  const fields = await cleanInitiative(db, input);
  const count = (await db.select({ id: initiatives.id }).from(initiatives).all()).length;
  const id = newId();
  await commit(db, [
    db.insert(initiatives).values({
      ...fields,
      id,
      name: fields.name ?? "",
      sortOrder: fields.sortOrder ?? count,
      createdAt: now,
      updatedAt: now,
    }),
    ...audit(db, [event(ctx, "initiative.create", "initiative", id, { name: fields.name })], now),
  ]);
  return id;
}

export async function updateInitiative(ctx: Ctx, id: string, input: InitiativeInput) {
  const { db, now } = ctx;
  const row = await db.select().from(initiatives).where(eq(initiatives.id, id)).get();
  if (!row) throw notFound("Initiative");
  const next = await cleanInitiative(db, input);
  const diff = changes(row, next);
  if (!diff) return id;
  await commit(db, [
    db
      .update(initiatives)
      .set({ ...next, updatedAt: now })
      .where(eq(initiatives.id, id)),
    ...audit(db, [event(ctx, "initiative.update", "initiative", id, diff)], now),
  ]);
  return id;
}

export async function setInitiativeArchived(ctx: Ctx, id: string, archived: boolean) {
  const { db, now } = ctx;
  const row = await db.select().from(initiatives).where(eq(initiatives.id, id)).get();
  if (!row) throw notFound("Initiative");
  if (!!row.archivedAt === archived) return id;
  await commit(db, [
    db
      .update(initiatives)
      .set({ archivedAt: archived ? now : null, updatedAt: now })
      .where(eq(initiatives.id, id)),
    ...audit(
      db,
      [event(ctx, archived ? "initiative.archive" : "initiative.unarchive", "initiative", id)],
      now,
    ),
  ]);
  return id;
}

export interface DocumentInput {
  title?: string | null;
  content?: string | null;
  icon?: string | null;
  projectId?: string | null;
  initiativeId?: string | null;
}

async function cleanDocument(db: HubDb, input: DocumentInput) {
  const next: Partial<typeof documents.$inferInsert> = {};
  if (input.title != null) next.title = cleanText(input.title, "Title", 255);
  if (input.content != null) {
    if (input.content.length > 200_000) throw badRequest("The document is too long");
    next.content = input.content;
  }
  if (input.icon !== undefined) next.icon = input.icon?.trim().slice(0, 16) || null;
  if (input.projectId !== undefined) {
    if (input.projectId) await requireProject(db, input.projectId);
    next.projectId = input.projectId || null;
  }
  if (input.initiativeId !== undefined) {
    if (input.initiativeId) await checkInitiative(db, input.initiativeId);
    next.initiativeId = input.initiativeId || null;
  }
  return next;
}

export async function createDocument(ctx: Ctx, input: DocumentInput & { title: string }) {
  const { db, now } = ctx;
  const fields = await cleanDocument(db, input);
  const id = newId();
  await commit(db, [
    db.insert(documents).values({
      ...fields,
      id,
      title: fields.title ?? "",
      content: fields.content ?? "",
      creatorId: ctx.actorId,
      updatedById: ctx.actorId,
      createdAt: now,
      updatedAt: now,
    }),
    ...audit(
      db,
      [
        event(ctx, "document.create", "document", id, {
          title: fields.title,
          projectId: fields.projectId ?? null,
        }),
      ],
      now,
    ),
  ]);
  return id;
}

export async function requireDocument(db: HubDb, id: string) {
  const row = await db.select().from(documents).where(eq(documents.id, id)).get();
  if (!row) throw notFound("Document");
  return row;
}

export async function updateDocument(ctx: Ctx, id: string, input: DocumentInput) {
  const { db, now } = ctx;
  const doc = await requireDocument(db, id);
  const next = await cleanDocument(db, input);
  const diff = changes(doc, next);
  if (!diff) return id;
  // The log keeps a document's edits without copying the whole text every time.
  const { content, ...rest } = diff;
  await commit(db, [
    db
      .update(documents)
      .set({ ...next, updatedById: ctx.actorId, updatedAt: now })
      .where(eq(documents.id, id)),
    ...audit(
      db,
      [
        event(ctx, "document.update", "document", id, {
          ...rest,
          ...(content
            ? { contentLength: { from: doc.content.length, to: next.content?.length } }
            : {}),
        }),
      ],
      now,
    ),
  ]);
  return id;
}

export async function setDocumentArchived(ctx: Ctx, id: string, archived: boolean) {
  const { db, now } = ctx;
  const doc = await requireDocument(db, id);
  if (!!doc.archivedAt === archived) return id;
  await commit(db, [
    db
      .update(documents)
      .set({ archivedAt: archived ? now : null, updatedAt: now })
      .where(eq(documents.id, id)),
    ...audit(
      db,
      [event(ctx, archived ? "document.delete" : "document.unarchive", "document", id)],
      now,
    ),
  ]);
  return id;
}
