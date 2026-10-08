import {
  comments,
  issueLabels,
  issues,
  labels,
  PROJECT_STATES,
  type ProjectState,
  projects,
  projectTeams,
  teamMemberships,
  teams,
  users,
  WORKFLOW_STATE_TYPES,
  type WorkflowStateType,
  workflowStates,
} from "@life-os/schema";
import { eq } from "drizzle-orm";
import { audit } from "../audit.js";
import { newId } from "../crypto.js";
import { commit, type WriteOp } from "../db.js";
import { badRequest, forbidden, ServiceError } from "../errors.js";
import { insertRows } from "../write.js";
import { type Ctx, event } from "./common.js";

// Moving in from Linear: the hub reads a workspace with the owner's API key and recreates
// its teams, workflows, labels, projects, issues (keeping their identifiers) and comments.

export interface LinearData {
  viewerId: string;
  teams: {
    id: string;
    key: string;
    name: string;
    description: string | null;
    color: string | null;
    states: { id: string; name: string; type: string; color: string; position: number }[];
  }[];
  labels: {
    id: string;
    name: string;
    color: string;
    description: string | null;
    teamId: string | null;
  }[];
  projects: {
    id: string;
    name: string;
    description: string | null;
    color: string | null;
    state: string;
    startDate: string | null;
    targetDate: string | null;
    teamIds: string[];
  }[];
  issues: {
    id: string;
    number: number;
    title: string;
    description: string | null;
    priority: number;
    estimate: number | null;
    dueDate: string | null;
    createdAt: string;
    updatedAt: string;
    startedAt: string | null;
    completedAt: string | null;
    canceledAt: string | null;
    teamId: string;
    stateId: string;
    assigneeId: string | null;
    projectId: string | null;
    parentId: string | null;
    labelIds: string[];
    comments: {
      id: string;
      body: string;
      createdAt: string;
      userId: string | null;
      userName: string | null;
      parentId: string | null;
    }[];
  }[];
}

const API = "https://api.linear.app/graphql";
const MAX_ISSUES = 5000;

type Nodes<T> = { nodes: T[]; pageInfo?: { hasNextPage: boolean; endCursor: string | null } };

/** Reads a Linear workspace page by page with a personal API key. */
export async function fetchLinear(apiKey: string, send: typeof fetch): Promise<LinearData> {
  const key = apiKey.trim();
  if (!key) throw badRequest("Paste a Linear API key (Settings › Security & access)");
  const query = async <T>(text: string, variables?: Record<string, unknown>): Promise<T> => {
    const response = await send(API, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: key },
      body: JSON.stringify({ query: text, variables }),
    });
    const body = (await response.json().catch(() => null)) as {
      data?: T;
      errors?: { message: string }[];
    } | null;
    if (response.status === 401 || response.status === 403)
      throw new ServiceError("FORBIDDEN", "Linear didn't accept that API key");
    if (!response.ok || !body?.data)
      throw new ServiceError(
        "BAD_REQUEST",
        `Linear answered: ${body?.errors?.[0]?.message ?? response.status}`,
      );
    return body.data;
  };
  const pages = async <T>(
    text: string,
    pick: (data: Record<string, Nodes<T>>) => Nodes<T>,
    max: number,
  ) => {
    const all: T[] = [];
    let after: string | null = null;
    do {
      const page: Nodes<T> = pick(await query(text, { after }));
      all.push(...page.nodes);
      after = page.pageInfo?.hasNextPage ? (page.pageInfo.endCursor ?? null) : null;
    } while (after && all.length < max);
    return all;
  };

  const base = await query<{
    viewer: { id: string };
    teams: Nodes<{
      id: string;
      key: string;
      name: string;
      description: string | null;
      color: string | null;
      states: Nodes<{ id: string; name: string; type: string; color: string; position: number }>;
    }>;
  }>(`{
    viewer { id }
    teams(first: 50) { nodes { id key name description color
      states(first: 50) { nodes { id name type color position } } } }
  }`);
  const labelRows = await pages<{
    id: string;
    name: string;
    color: string;
    description: string | null;
    team: { id: string } | null;
  }>(
    `query($after: String) { issueLabels(first: 250, after: $after) {
      nodes { id name color description team { id } } pageInfo { hasNextPage endCursor } } }`,
    (d) => d.issueLabels as Nodes<never>,
    2000,
  );
  const projectRows = await pages<{
    id: string;
    name: string;
    description: string | null;
    color: string | null;
    state: string;
    startDate: string | null;
    targetDate: string | null;
    teams: Nodes<{ id: string }>;
  }>(
    `query($after: String) { projects(first: 50, after: $after) {
      nodes { id name description color state startDate targetDate teams { nodes { id } } }
      pageInfo { hasNextPage endCursor } } }`,
    (d) => d.projects as Nodes<never>,
    1000,
  );
  const issueRows = await pages<{
    id: string;
    number: number;
    title: string;
    description: string | null;
    priority: number;
    estimate: number | null;
    dueDate: string | null;
    createdAt: string;
    updatedAt: string;
    startedAt: string | null;
    completedAt: string | null;
    canceledAt: string | null;
    team: { id: string };
    state: { id: string };
    assignee: { id: string } | null;
    project: { id: string } | null;
    parent: { id: string } | null;
    labels: Nodes<{ id: string }>;
    comments: Nodes<{
      id: string;
      body: string;
      createdAt: string;
      user: { id: string; name: string } | null;
      parent: { id: string } | null;
    }>;
  }>(
    `query($after: String) { issues(first: 25, after: $after) {
      nodes { id number title description priority estimate dueDate createdAt updatedAt
        startedAt completedAt canceledAt team { id } state { id } assignee { id }
        project { id } parent { id } labels { nodes { id } }
        comments(first: 50) { nodes { id body createdAt user { id name } parent { id } } } }
      pageInfo { hasNextPage endCursor } } }`,
    (d) => d.issues as Nodes<never>,
    MAX_ISSUES,
  );
  return {
    viewerId: base.viewer.id,
    teams: base.teams.nodes.map((t) => ({ ...t, states: t.states.nodes })),
    labels: labelRows.map(({ team, ...l }) => ({ ...l, teamId: team?.id ?? null })),
    projects: projectRows.map(({ teams: list, ...p }) => ({
      ...p,
      teamIds: list.nodes.map((t) => t.id),
    })),
    issues: issueRows.map((i) => ({
      id: i.id,
      number: i.number,
      title: i.title,
      description: i.description,
      priority: i.priority,
      estimate: i.estimate,
      dueDate: i.dueDate,
      createdAt: i.createdAt,
      updatedAt: i.updatedAt,
      startedAt: i.startedAt,
      completedAt: i.completedAt,
      canceledAt: i.canceledAt,
      teamId: i.team.id,
      stateId: i.state.id,
      assigneeId: i.assignee?.id ?? null,
      projectId: i.project?.id ?? null,
      parentId: i.parent?.id ?? null,
      labelIds: i.labels.nodes.map((l) => l.id),
      comments: i.comments.nodes.map((c) => ({
        id: c.id,
        body: c.body,
        createdAt: c.createdAt,
        userId: c.user?.id ?? null,
        userName: c.user?.name ?? null,
        parentId: c.parent?.id ?? null,
      })),
    })),
  };
}

const ms = (iso: string | null | undefined, fallback: number | null = null) => {
  const value = iso ? Date.parse(iso) : Number.NaN;
  return Number.isNaN(value) ? fallback : value;
};

/**
 * Recreates a Linear workspace in this company, owned by the owner. Teams keep their keys and
 * issues their numbers, so FIN-42 is still FIN-42. Teams whose key is taken here are refused.
 */
export async function importLinear(ctx: Ctx, data: LinearData) {
  const { db, now } = ctx;
  const actor = await db.select().from(users).where(eq(users.id, ctx.actorId)).get();
  if (actor?.kind !== "owner") throw forbidden("Only the owner can import from Linear");
  if (!data.teams.length) throw badRequest("That Linear workspace has no teams to import");
  const existing = await db.select({ key: teams.key }).from(teams).all();
  const taken = data.teams.filter((t) => existing.some((e) => e.key === t.key.toUpperCase()));
  if (taken.length)
    throw new ServiceError(
      "CONFLICT",
      `Teams already use ${taken.map((t) => t.key).join(", ")} here; rename them first`,
    );

  const ids = new Map<string, string>();
  const idFor = (linearId: string) => {
    let id = ids.get(linearId);
    if (!id) {
      id = newId();
      ids.set(linearId, id);
    }
    return id;
  };
  const stamp = { createdAt: now, updatedAt: now };
  const ops: WriteOp[] = [];

  const teamRows = data.teams.map((t) => ({
    id: idFor(t.id),
    key: t.key.toUpperCase(),
    name: t.name.slice(0, 80),
    description: t.description,
    color: t.color,
    issueCount: Math.max(0, ...data.issues.filter((i) => i.teamId === t.id).map((i) => i.number)),
    ...stamp,
  }));
  ops.push(...insertRows(db, teams, teamRows));
  ops.push(
    ...insertRows(
      db,
      teamMemberships,
      teamRows.map((t) => ({ teamId: t.id, userId: actor.id, createdAt: now })),
    ),
  );
  const stateType = new Map<string, WorkflowStateType>();
  ops.push(
    ...insertRows(
      db,
      workflowStates,
      data.teams.flatMap((t) =>
        [...t.states]
          .sort((a, b) => a.position - b.position)
          .map((s, position) => {
            const type = WORKFLOW_STATE_TYPES.find((k) => k === s.type) ?? "unstarted";
            stateType.set(s.id, type);
            return {
              id: idFor(s.id),
              teamId: idFor(t.id),
              name: s.name,
              type,
              color: s.color,
              position,
              ...stamp,
            };
          }),
      ),
    ),
  );

  // Labels reuse ones with the same name and scope; the rest are created.
  const known = await db.select().from(labels).all();
  const newLabels: (typeof labels.$inferInsert)[] = [];
  for (const l of data.labels) {
    const teamId = l.teamId ? (ids.get(l.teamId) ?? null) : null;
    if (l.teamId && !teamId) continue;
    const same = known.find(
      (k) => k.name.toLowerCase() === l.name.toLowerCase() && k.teamId === teamId,
    );
    if (same) {
      ids.set(l.id, same.id);
      continue;
    }
    newLabels.push({
      id: idFor(l.id),
      teamId,
      name: l.name,
      color: l.color,
      description: l.description,
      ...stamp,
    });
  }
  ops.push(...insertRows(db, labels, newLabels));

  ops.push(
    ...insertRows(
      db,
      projects,
      data.projects.map((p, index) => {
        const state: ProjectState = PROJECT_STATES.find((s) => s === p.state) ?? "planned";
        return {
          id: idFor(p.id),
          name: p.name,
          description: p.description,
          color: p.color ?? "#6b7280",
          state,
          creatorId: actor.id,
          startDate: p.startDate,
          targetDate: p.targetDate,
          sortOrder: index,
          ...stamp,
        };
      }),
    ),
    ...insertRows(
      db,
      projectTeams,
      data.projects.flatMap((p) =>
        p.teamIds
          .filter((t) => ids.has(t))
          .map((t) => ({ projectId: idFor(p.id), teamId: idFor(t) })),
      ),
    ),
  );

  const imported = data.issues.filter((i) => ids.has(i.teamId) && ids.has(i.stateId));
  for (const issue of imported) idFor(issue.id);
  ops.push(
    ...insertRows(
      db,
      issues,
      imported.map((i, index) => {
        const created = ms(i.createdAt, now) ?? now;
        return {
          id: idFor(i.id),
          teamId: idFor(i.teamId),
          number: i.number,
          title: i.title.slice(0, 500),
          description: i.description,
          stateId: idFor(i.stateId),
          priority: Math.min(Math.max(i.priority ?? 0, 0), 4),
          estimate: i.estimate === null ? null : Math.round(i.estimate),
          assigneeId: i.assigneeId === data.viewerId ? actor.id : null,
          creatorId: actor.id,
          parentId: i.parentId ? (ids.get(i.parentId) ?? null) : null,
          dueDate: i.dueDate,
          sortOrder: index,
          startedAt: ms(i.startedAt),
          completedAt: stateType.get(i.stateId) === "completed" ? ms(i.completedAt, created) : null,
          canceledAt: stateType.get(i.stateId) === "canceled" ? ms(i.canceledAt, created) : null,
          projectId: i.projectId ? (ids.get(i.projectId) ?? null) : null,
          createdAt: created,
          updatedAt: ms(i.updatedAt, created) ?? created,
        };
      }),
    ),
    ...insertRows(
      db,
      issueLabels,
      imported.flatMap((i) =>
        [...new Set(i.labelIds.filter((l) => ids.has(l)).map((l) => idFor(l)))].map((labelId) => ({
          issueId: idFor(i.id),
          labelId,
        })),
      ),
    ),
  );

  // Linear's other people aren't members here; their words are kept, credited in the text.
  const commentRows = imported.flatMap((i) =>
    i.comments.map((c) => ({
      id: idFor(c.id),
      issueId: idFor(i.id),
      userId: actor.id,
      parentId: null as string | null,
      linearParent: c.parentId,
      body:
        c.userId && c.userId !== data.viewerId
          ? `**${c.userName ?? "Someone"}** wrote in Linear:\n\n${c.body}`
          : c.body,
      createdAt: ms(c.createdAt, now) ?? now,
      updatedAt: ms(c.createdAt, now) ?? now,
    })),
  );
  ops.push(
    ...insertRows(
      db,
      comments,
      commentRows.map(({ linearParent, ...c }) => ({
        ...c,
        parentId: linearParent ? (ids.get(linearParent) ?? null) : null,
      })),
    ),
  );

  const counts = {
    teams: teamRows.length,
    labels: newLabels.length,
    projects: data.projects.length,
    issues: imported.length,
    comments: commentRows.length,
  };
  ops.push(...audit(db, [event(ctx, "linear.import", "organization", actor.id, counts)], now));
  await commit(db, ops);
  return counts;
}
