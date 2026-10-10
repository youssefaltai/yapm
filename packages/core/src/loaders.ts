import {
  comments,
  cycles,
  issueLabels,
  issueRelations,
  issues,
  labels,
  projectMilestones,
  projects,
  projectUpdates,
  reactions,
  requests,
  teams,
  users,
  workflowStates,
} from "@life-os/schema";
import DataLoader from "dataloader";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import type { HubDb } from "./db.js";

/** D1 allows 100 bound parameters per statement; keep `IN (...)` lists below that. */
const CHUNK = 90;

async function chunked<T>(
  ids: readonly string[],
  load: (ids: string[]) => Promise<T[]>,
): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += CHUNK) out.push(...(await load(ids.slice(i, i + CHUNK))));
  return out;
}

function byId<T extends { id: string }>(load: (ids: string[]) => Promise<T[]>) {
  return new DataLoader<string, T | null>(async (ids) => {
    const rows = new Map((await chunked(ids, load)).map((row) => [row.id, row]));
    return ids.map((id) => rows.get(id) ?? null);
  });
}

function groupBy<T>(load: (ids: string[]) => Promise<T[]>, key: keyof T) {
  return new DataLoader<string, T[]>(async (ids) => {
    const groups = new Map<string, T[]>();
    for (const row of await chunked(ids, load)) {
      const k = row[key] as unknown as string;
      const list = groups.get(k);
      if (list) list.push(row);
      else groups.set(k, [row]);
    }
    return ids.map((id) => groups.get(id) ?? []);
  });
}

/**
 * Per-request batch loaders, so a list of issues costs a handful of queries
 * instead of several per issue (D1's free plan caps queries per request).
 */
export function createLoaders(db: HubDb) {
  return {
    user: byId((ids) => db.select().from(users).where(inArray(users.id, ids)).all()),
    team: byId((ids) => db.select().from(teams).where(inArray(teams.id, ids)).all()),
    state: byId((ids) =>
      db.select().from(workflowStates).where(inArray(workflowStates.id, ids)).all(),
    ),
    issue: byId((ids) => db.select().from(issues).where(inArray(issues.id, ids)).all()),
    label: byId((ids) => db.select().from(labels).where(inArray(labels.id, ids)).all()),
    project: byId((ids) => db.select().from(projects).where(inArray(projects.id, ids)).all()),
    cycle: byId((ids) => db.select().from(cycles).where(inArray(cycles.id, ids)).all()),
    projectMilestone: byId((ids) =>
      db.select().from(projectMilestones).where(inArray(projectMilestones.id, ids)).all(),
    ),
    comment: byId((ids) => db.select().from(comments).where(inArray(comments.id, ids)).all()),
    request: byId((ids) => db.select().from(requests).where(inArray(requests.id, ids)).all()),
    projectUpdate: byId((ids) =>
      db.select().from(projectUpdates).where(inArray(projectUpdates.id, ids)).all(),
    ),
    statesByTeam: groupBy(
      (ids) =>
        db
          .select()
          .from(workflowStates)
          .where(inArray(workflowStates.teamId, ids))
          .orderBy(asc(workflowStates.position))
          .all(),
      "teamId",
    ),
    labelsByIssue: groupBy(
      async (ids) =>
        (
          await db
            .select({ issueId: issueLabels.issueId, label: labels })
            .from(issueLabels)
            .innerJoin(labels, eq(labels.id, issueLabels.labelId))
            .where(inArray(issueLabels.issueId, ids))
            .orderBy(asc(labels.name))
            .all()
        ).map((row) => ({ issueId: row.issueId, ...row.label })),
      "issueId",
    ),
    childrenByIssue: groupBy(
      (ids) =>
        db
          .select()
          .from(issues)
          .where(and(inArray(issues.parentId, ids), isNull(issues.archivedAt)))
          .orderBy(asc(issues.sortOrder))
          .all(),
      "parentId",
    ),
    commentsByIssue: groupBy(
      (ids) =>
        db
          .select()
          .from(comments)
          .where(inArray(comments.issueId, ids))
          .orderBy(asc(comments.createdAt))
          .all(),
      "issueId",
    ),
    relationsByIssue: groupBy(
      (ids) =>
        db
          .select()
          .from(issueRelations)
          .where(inArray(issueRelations.issueId, ids))
          .orderBy(asc(issueRelations.createdAt))
          .all(),
      "issueId",
    ),
    inverseRelationsByIssue: groupBy(
      (ids) =>
        db
          .select()
          .from(issueRelations)
          .where(inArray(issueRelations.relatedIssueId, ids))
          .orderBy(asc(issueRelations.createdAt))
          .all(),
      "relatedIssueId",
    ),
    reactionsByComment: groupBy(
      (ids) =>
        db
          .select()
          .from(reactions)
          .where(inArray(reactions.commentId, ids))
          .orderBy(asc(reactions.createdAt))
          .all(),
      "commentId",
    ),
    reactionsByIssue: groupBy(
      (ids) =>
        db
          .select()
          .from(reactions)
          .where(inArray(reactions.issueId, ids))
          .orderBy(asc(reactions.createdAt))
          .all(),
      "issueId",
    ),
  };
}

export type Loaders = ReturnType<typeof createLoaders>;
