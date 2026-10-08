import {
  type IssueRelationType,
  issueLabels,
  issueRelations,
  issues,
  labels,
  teams,
  users,
  type WorkflowStateType,
  workflowStates,
} from "@life-os/schema";
import { and, asc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { audit } from "../audit.js";
import { newId } from "../crypto.js";
import { commit, type HubDb, type WriteOp } from "../db.js";
import { badRequest, notFound } from "../errors.js";
import { insertRows } from "../write.js";
import { type Ctx, changes, cleanText, event } from "./common.js";

export type IssueRow = typeof issues.$inferSelect;

export interface IssueCreateInput {
  teamId: string;
  title: string;
  description?: string | null;
  stateId?: string | null;
  priority?: number | null;
  estimate?: number | null;
  assigneeId?: string | null;
  parentId?: string | null;
  dueDate?: string | null;
  labelIds?: string[] | null;
  sortOrder?: number | null;
}

export interface IssueUpdateInput {
  title?: string | null;
  description?: string | null;
  stateId?: string | null;
  priority?: number | null;
  estimate?: number | null;
  assigneeId?: string | null;
  parentId?: string | null;
  dueDate?: string | null;
  sortOrder?: number | null;
  /** Replaces all labels. */
  labelIds?: string[] | null;
  addedLabelIds?: string[] | null;
  removedLabelIds?: string[] | null;
}

const IDENTIFIER = /^([A-Za-z][A-Za-z0-9]{0,6})-(\d+)$/;

/** Finds an issue by id or by identifier (`FIN-42`). */
export async function findIssue(db: HubDb, idOrIdentifier: string): Promise<IssueRow | null> {
  const match = IDENTIFIER.exec(idOrIdentifier);
  if (match) {
    const [, key = "", number = "0"] = match;
    const row = await db
      .select({ issue: issues })
      .from(issues)
      .innerJoin(teams, eq(teams.id, issues.teamId))
      .where(and(eq(teams.key, key.toUpperCase()), eq(issues.number, Number(number))))
      .get();
    return row?.issue ?? null;
  }
  return (await db.select().from(issues).where(eq(issues.id, idOrIdentifier)).get()) ?? null;
}

export async function requireIssue(db: HubDb, idOrIdentifier: string): Promise<IssueRow> {
  const issue = await findIssue(db, idOrIdentifier);
  if (!issue) throw notFound("Issue");
  return issue;
}

function checkPriority(priority: number) {
  if (!Number.isInteger(priority) || priority < 0 || priority > 4) {
    throw badRequest("Priority must be 0 (none), 1 (urgent), 2 (high), 3 (medium) or 4 (low)");
  }
}

function checkEstimate(estimate: number) {
  if (!Number.isInteger(estimate) || estimate < 0 || estimate > 1000) {
    throw badRequest("Estimate must be a whole number of points");
  }
}

function checkDueDate(date: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date))) {
    throw badRequest("Due date must be a date like 2026-10-31");
  }
}

async function stateFor(db: HubDb, teamId: string, stateId: string) {
  const state = await db
    .select()
    .from(workflowStates)
    .where(and(eq(workflowStates.id, stateId), eq(workflowStates.teamId, teamId)))
    .get();
  if (!state) throw badRequest("That status doesn't belong to the issue's team");
  return state;
}

/** New issues land in Backlog, or the team's first unstarted state. */
async function defaultState(db: HubDb, teamId: string) {
  const states = await db
    .select()
    .from(workflowStates)
    .where(eq(workflowStates.teamId, teamId))
    .orderBy(asc(workflowStates.position))
    .all();
  const state =
    states.find((s) => s.type === "backlog") ??
    states.find((s) => s.type === "unstarted") ??
    states[0];
  if (!state) throw badRequest("The team has no workflow states");
  return state;
}

async function checkAssignee(db: HubDb, assigneeId: string) {
  const user = await db
    .select({ active: users.active })
    .from(users)
    .where(eq(users.id, assigneeId))
    .get();
  if (!user?.active) throw notFound("Assignee");
}

async function checkLabels(db: HubDb, teamId: string, labelIds: string[]) {
  if (!labelIds.length) return;
  const found = await db
    .select({ id: labels.id })
    .from(labels)
    .where(and(inArray(labels.id, labelIds), or(isNull(labels.teamId), eq(labels.teamId, teamId))))
    .all();
  if (found.length !== new Set(labelIds).size)
    throw badRequest("Some labels don't exist or belong to another team");
}

/** Rejects a parent that would put the issue inside its own sub-issue tree. */
async function checkParent(db: HubDb, issueId: string | null, parentId: string) {
  let current: string | null = parentId;
  for (let depth = 0; current; depth++) {
    if (current === issueId)
      throw badRequest("An issue can't be a sub-issue of itself or its sub-issues");
    if (depth > 50) throw badRequest("Sub-issues are nested too deeply");
    const row: { parentId: string | null } | undefined = await db
      .select({ parentId: issues.parentId })
      .from(issues)
      .where(eq(issues.id, current))
      .get();
    if (!row) throw notFound("Parent issue");
    current = row.parentId;
  }
}

/** Timestamps for a new issue created directly in a state. */
function stateTimestamps(type: WorkflowStateType, now: number) {
  return {
    startedAt: type === "started" || type === "completed" ? now : null,
    completedAt: type === "completed" ? now : null,
    canceledAt: type === "canceled" ? now : null,
  };
}

export async function createIssue(ctx: Ctx, input: IssueCreateInput): Promise<string> {
  const { db, actorId, now } = ctx;
  const team = await db.select().from(teams).where(eq(teams.id, input.teamId)).get();
  if (!team || team.archivedAt) throw notFound("Team");
  const title = cleanText(input.title, "Title", 500);
  const state = input.stateId
    ? await stateFor(db, team.id, input.stateId)
    : await defaultState(db, team.id);
  const priority = input.priority ?? 0;
  checkPriority(priority);
  if (input.estimate != null) checkEstimate(input.estimate);
  if (input.dueDate) checkDueDate(input.dueDate);
  if (input.assigneeId) await checkAssignee(db, input.assigneeId);
  if (input.parentId) await checkParent(db, null, input.parentId);
  const labelIds = [...new Set(input.labelIds ?? [])];
  await checkLabels(db, team.id, labelIds);

  const id = newId();
  const ops: WriteOp[] = [
    // Allocate the next number for the team's identifiers (FIN-1, FIN-2, …) inside the same batch.
    db
      .update(teams)
      .set({ issueCount: sql`${teams.issueCount} + 1` })
      .where(eq(teams.id, team.id)),
    db.insert(issues).values({
      id,
      teamId: team.id,
      number: sql`(select ${teams.issueCount} from ${teams} where ${teams.id} = ${team.id})`,
      title,
      description: input.description?.trim() || null,
      stateId: state.id,
      priority,
      estimate: input.estimate ?? null,
      assigneeId: input.assigneeId ?? null,
      creatorId: actorId,
      parentId: input.parentId ?? null,
      dueDate: input.dueDate ?? null,
      sortOrder: input.sortOrder ?? -now,
      ...stateTimestamps(state.type, now),
      createdAt: now,
      updatedAt: now,
    }),
    ...insertRows(
      db,
      issueLabels,
      labelIds.map((labelId) => ({ issueId: id, labelId })),
    ),
    ...audit(
      db,
      [
        event(ctx, "issue.create", "issue", id, {
          teamId: team.id,
          title,
          stateId: state.id,
          priority,
          assigneeId: input.assigneeId ?? null,
          parentId: input.parentId ?? null,
          labelIds,
        }),
      ],
      now,
    ),
  ];
  await commit(db, ops);
  return id;
}

export async function updateIssue(
  ctx: Ctx,
  idOrIdentifier: string,
  input: IssueUpdateInput,
): Promise<string> {
  const issue = await requireIssue(ctx.db, idOrIdentifier);
  await updateIssues(ctx, [issue.id], input);
  return issue.id;
}

/** Most issues one batch update may change, to keep a request within D1's query limits. */
export const MAX_BATCH = 50;

/**
 * Applies the same update to several issues in a fixed number of statements
 * (Linear's issueBatchUpdate), writing a history entry for each issue that changed.
 */
export async function updateIssues(
  ctx: Ctx,
  ids: string[],
  input: IssueUpdateInput,
): Promise<string[]> {
  const { db, now } = ctx;
  const uniqueIds = [...new Set(ids)];
  if (!uniqueIds.length) return [];
  if (uniqueIds.length > MAX_BATCH)
    throw badRequest(`Update at most ${MAX_BATCH} issues at a time`);
  const rows = await db.select().from(issues).where(inArray(issues.id, uniqueIds)).all();
  if (rows.length !== uniqueIds.length) throw notFound("Issue");
  const teamIds = new Set(rows.map((r) => r.teamId));

  const next: Partial<IssueRow> = {};
  if (input.title != null) next.title = cleanText(input.title, "Title", 500);
  if (input.description !== undefined) next.description = input.description?.trim() || null;
  if (input.priority != null) {
    checkPriority(input.priority);
    next.priority = input.priority;
  }
  if (input.estimate !== undefined) {
    if (input.estimate !== null) checkEstimate(input.estimate);
    next.estimate = input.estimate;
  }
  if (input.dueDate !== undefined) {
    if (input.dueDate) checkDueDate(input.dueDate);
    next.dueDate = input.dueDate || null;
  }
  if (input.assigneeId !== undefined) {
    if (input.assigneeId) await checkAssignee(db, input.assigneeId);
    next.assigneeId = input.assigneeId;
  }
  if (input.parentId !== undefined) {
    if (input.parentId) for (const row of rows) await checkParent(db, row.id, input.parentId);
    next.parentId = input.parentId;
  }
  if (input.sortOrder != null) next.sortOrder = input.sortOrder;
  let state: typeof workflowStates.$inferSelect | undefined;
  if (input.stateId != null) {
    const [teamId] = teamIds;
    if (teamIds.size > 1 || !teamId)
      throw badRequest("Pick issues from one team to change their status");
    state = await stateFor(db, teamId, input.stateId);
    next.stateId = state.id;
  }

  // Labels: a full replacement, or additions and removals, checked against every issue's team.
  const labelChange =
    input.labelIds || input.addedLabelIds?.length || input.removedLabelIds?.length;
  const currentLabels = new Map<string, string[]>(rows.map((r) => [r.id, []]));
  if (labelChange) {
    for (const link of await db
      .select()
      .from(issueLabels)
      .where(inArray(issueLabels.issueId, uniqueIds))
      .all()) {
      currentLabels.get(link.issueId)?.push(link.labelId);
    }
    const incoming = [...(input.labelIds ?? []), ...(input.addedLabelIds ?? [])];
    for (const teamId of teamIds) await checkLabels(db, teamId, [...new Set(incoming)]);
  }

  const ops: WriteOp[] = [];
  const events = [];
  const changedIds: string[] = [];
  const stateChangedIds: string[] = [];
  const labelRemovals: { issueId: string; labelIds: string[] }[] = [];
  const labelAdds: { issueId: string; labelId: string }[] = [];
  for (const row of rows) {
    const { sortOrder, ...tracked } = next;
    const diff = changes(row, tracked) ?? {};
    if (labelChange) {
      const from = currentLabels.get(row.id) ?? [];
      let to = input.labelIds ? [...new Set(input.labelIds)] : from;
      if (input.addedLabelIds) to = [...new Set([...to, ...input.addedLabelIds])];
      if (input.removedLabelIds) to = to.filter((id) => !input.removedLabelIds?.includes(id));
      const added = to.filter((id) => !from.includes(id));
      const removed = from.filter((id) => !to.includes(id));
      if (added.length || removed.length) diff.labelIds = { from, to };
      if (removed.length) labelRemovals.push({ issueId: row.id, labelIds: removed });
      for (const labelId of added) labelAdds.push({ issueId: row.id, labelId });
    }
    if (diff.stateId) stateChangedIds.push(row.id);
    if (Object.keys(diff).length || (sortOrder !== undefined && sortOrder !== row.sortOrder))
      changedIds.push(row.id);
    if (Object.keys(diff).length) events.push(event(ctx, "issue.update", "issue", row.id, diff));
  }
  if (!changedIds.length) return uniqueIds;

  const { stateId: _stateId, ...fields } = next;
  ops.push(
    db
      .update(issues)
      .set({ ...fields, updatedAt: now })
      .where(inArray(issues.id, changedIds)),
  );
  if (state && stateChangedIds.length) {
    // Linear keeps startedAt/completedAt/canceledAt in step with the state category.
    ops.push(
      db
        .update(issues)
        .set({
          stateId: state.id,
          startedAt:
            state.type === "started"
              ? sql`coalesce(${issues.startedAt}, ${now})`
              : state.type === "completed"
                ? sql`${issues.startedAt}`
                : null,
          completedAt: state.type === "completed" ? now : null,
          canceledAt: state.type === "canceled" ? now : null,
        })
        .where(inArray(issues.id, stateChangedIds)),
    );
  }
  for (const removal of labelRemovals) {
    ops.push(
      db
        .delete(issueLabels)
        .where(
          and(
            eq(issueLabels.issueId, removal.issueId),
            inArray(issueLabels.labelId, removal.labelIds),
          ),
        ),
    );
  }
  ops.push(...insertRows(db, issueLabels, labelAdds));
  ops.push(...audit(db, events, now));
  await commit(db, ops);
  return uniqueIds;
}

export async function setIssueArchived(
  ctx: Ctx,
  idOrIdentifier: string,
  archived: boolean,
): Promise<string> {
  const { db, now } = ctx;
  const issue = await requireIssue(db, idOrIdentifier);
  if (!!issue.archivedAt === archived) return issue.id;
  await commit(db, [
    db
      .update(issues)
      .set({ archivedAt: archived ? now : null, updatedAt: now })
      .where(eq(issues.id, issue.id)),
    ...audit(
      db,
      [event(ctx, archived ? "issue.archive" : "issue.unarchive", "issue", issue.id)],
      now,
    ),
  ]);
  return issue.id;
}

export async function createRelation(
  ctx: Ctx,
  input: { issueId: string; relatedIssueId: string; type: IssueRelationType },
): Promise<string> {
  const { db, now } = ctx;
  const issue = await requireIssue(db, input.issueId);
  const related = await requireIssue(db, input.relatedIssueId);
  if (issue.id === related.id) throw badRequest("An issue can't be related to itself");
  const existing = await db
    .select({ id: issueRelations.id })
    .from(issueRelations)
    .where(
      and(
        eq(issueRelations.type, input.type),
        or(
          and(eq(issueRelations.issueId, issue.id), eq(issueRelations.relatedIssueId, related.id)),
          // "related" is symmetric, so either direction counts.
          input.type === "related"
            ? and(
                eq(issueRelations.issueId, related.id),
                eq(issueRelations.relatedIssueId, issue.id),
              )
            : undefined,
        ),
      ),
    )
    .get();
  if (existing) return existing.id;
  const id = newId();
  await commit(db, [
    db.insert(issueRelations).values({
      id,
      type: input.type,
      issueId: issue.id,
      relatedIssueId: related.id,
      createdAt: now,
    }),
    ...audit(
      db,
      [
        event(ctx, "issueRelation.create", "issue", issue.id, {
          type: input.type,
          relatedIssueId: related.id,
        }),
      ],
      now,
    ),
  ]);
  return id;
}

export async function deleteRelation(ctx: Ctx, id: string): Promise<void> {
  const { db, now } = ctx;
  const relation = await db.select().from(issueRelations).where(eq(issueRelations.id, id)).get();
  if (!relation) throw notFound("Relation");
  await commit(db, [
    db.delete(issueRelations).where(eq(issueRelations.id, id)),
    ...audit(
      db,
      [
        event(ctx, "issueRelation.delete", "issue", relation.issueId, {
          type: relation.type,
          relatedIssueId: relation.relatedIssueId,
        }),
      ],
      now,
    ),
  ]);
}
