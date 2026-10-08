import { customViews, teams } from "@life-os/schema";
import { eq } from "drizzle-orm";
import { audit } from "../audit.js";
import { newId } from "../crypto.js";
import { commit, type HubDb } from "../db.js";
import { badRequest, forbidden, notFound } from "../errors.js";
import { type Ctx, changes, cleanText, event } from "./common.js";

type ViewRow = typeof customViews.$inferSelect;

export interface CustomViewInput {
  name?: string | null;
  description?: string | null;
  icon?: string | null;
  color?: string | null;
  teamId?: string | null;
  shared?: boolean | null;
  /** An IssueFilter, as `issues(filter:)` takes it. */
  filterData?: Record<string, unknown> | null;
}

function checkFilter(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw badRequest("A view's filter must be an issue filter object");
  if (JSON.stringify(value).length > 10_000) throw badRequest("That filter is too large");
  return value as Record<string, unknown>;
}

export async function requireView(db: HubDb, id: string) {
  const view = await db.select().from(customViews).where(eq(customViews.id, id)).get();
  if (!view) throw notFound("View");
  return view;
}

/** Shared views are everyone's; private ones only their owner's. */
export function canSeeView(view: ViewRow, userId: string) {
  return view.shared || view.ownerId === userId;
}

async function checkTeam(db: HubDb, teamId: string) {
  const team = await db.select({ id: teams.id }).from(teams).where(eq(teams.id, teamId)).get();
  if (!team) throw notFound("Team");
}

export async function createView(ctx: Ctx, input: CustomViewInput) {
  const { db, now } = ctx;
  const name = cleanText(input.name ?? "", "View name", 80);
  const filterData = checkFilter(input.filterData ?? {});
  if (input.teamId) await checkTeam(db, input.teamId);
  const id = newId();
  await commit(db, [
    db.insert(customViews).values({
      id,
      name,
      description: input.description?.trim() || null,
      icon: input.icon ?? null,
      color: input.color ?? null,
      teamId: input.teamId ?? null,
      ownerId: ctx.actorId,
      shared: input.shared ?? true,
      filterData,
      sortOrder: now,
      createdAt: now,
      updatedAt: now,
    }),
    ...audit(db, [event(ctx, "customView.create", "customView", id, { name, filterData })], now),
  ]);
  return id;
}

export async function updateView(ctx: Ctx, id: string, input: CustomViewInput) {
  const { db, now } = ctx;
  const view = await requireView(db, id);
  if (!canSeeView(view, ctx.actorId)) throw notFound("View");
  const next: Partial<ViewRow> = {};
  if (input.name != null) next.name = cleanText(input.name, "View name", 80);
  if (input.description !== undefined) next.description = input.description?.trim() || null;
  if (input.icon !== undefined) next.icon = input.icon;
  if (input.color !== undefined) next.color = input.color;
  if (input.teamId !== undefined) {
    if (input.teamId) await checkTeam(db, input.teamId);
    next.teamId = input.teamId;
  }
  if (input.shared != null) {
    if (view.ownerId !== ctx.actorId)
      throw forbidden("Only the view's creator can change who sees it");
    next.shared = input.shared;
  }
  const diff = changes(view, next) ?? {};
  if (input.filterData) {
    const filter = checkFilter(input.filterData);
    if (JSON.stringify(filter) !== JSON.stringify(view.filterData)) {
      next.filterData = filter;
      diff.filterData = { from: view.filterData, to: filter };
    }
  }
  if (!Object.keys(diff).length) return id;
  await commit(db, [
    db
      .update(customViews)
      .set({ ...next, updatedAt: now })
      .where(eq(customViews.id, id)),
    ...audit(db, [event(ctx, "customView.update", "customView", id, diff)], now),
  ]);
  return id;
}

export async function deleteView(ctx: Ctx, id: string) {
  const { db, now } = ctx;
  const view = await requireView(db, id);
  if (!canSeeView(view, ctx.actorId)) throw notFound("View");
  await commit(db, [
    db.delete(customViews).where(eq(customViews.id, id)),
    ...audit(db, [event(ctx, "customView.delete", "customView", id, { name: view.name })], now),
  ]);
}
