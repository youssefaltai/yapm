import { labels, teams } from "@yapm/schema";
import { inArray, isNull, or } from "drizzle-orm";
import type { HubDb } from "../db.js";

/** Each team's parent, to walk the hierarchy in memory: a company has few teams. */
async function parents(db: HubDb) {
  const rows = await db.select({ id: teams.id, parentId: teams.parentId }).from(teams).all();
  return new Map(rows.map((r) => [r.id, r.parentId]));
}

/** A team's ancestors, from the root down to its parent. */
export async function ancestorIds(db: HubDb, teamId: string): Promise<string[]> {
  const parentOf = await parents(db);
  const out: string[] = [];
  for (let id = parentOf.get(teamId); id && !out.includes(id); id = parentOf.get(id)) out.unshift(id);
  return out;
}

/** A team's sub-teams, at every depth. */
export async function descendantIds(db: HubDb, teamId: string): Promise<string[]> {
  const parentOf = await parents(db);
  const out: string[] = [];
  for (let i = -1; i < out.length; i++) {
    const id = i < 0 ? teamId : out[i];
    for (const [child, parent] of parentOf) if (parent === id && !out.includes(child)) out.push(child);
  }
  return out;
}

/** Labels a team's issues may use: workspace-wide ones, its own and its ancestors'. */
export async function teamLabels(db: HubDb, teamId: string) {
  return or(isNull(labels.teamId), inArray(labels.teamId, [teamId, ...(await ancestorIds(db, teamId))]));
}
