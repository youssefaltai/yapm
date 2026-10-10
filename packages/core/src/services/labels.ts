import { issueLabels, labels, teams } from "@yapm/schema";
import { and, eq, isNull } from "drizzle-orm";
import { audit } from "../audit.js";
import { newId } from "../crypto.js";
import { commit } from "../db.js";
import { badRequest, notFound, ServiceError } from "../errors.js";
import { type Ctx, changes, cleanText, event } from "./common.js";

export interface LabelInput {
  name?: string | null;
  color?: string | null;
  description?: string | null;
  /** Null or absent for a workspace-wide label. */
  teamId?: string | null;
}

const COLOR = /^#[0-9a-fA-F]{6}$/;

/** Linear's colours, for labels and projects made without one. */
export const COLORS = ["#5e6ad2", "#26b5ce", "#4cb782", "#f2c94c", "#f2994a", "#eb5757", "#bb87fc"];

/** The same name always gets the same colour. */
export const colorFor = (name: string) =>
  COLORS[[...name].reduce((sum, c) => sum + (c.codePointAt(0) ?? 0), 0) % COLORS.length] ??
  "#5e6ad2";

export function checkColor(color: string) {
  if (!COLOR.test(color)) throw badRequest("Color must be a hex color like #5e6ad2");
}

export async function createLabel(ctx: Ctx, input: LabelInput & { name: string }): Promise<string> {
  const { db, now } = ctx;
  const name = cleanText(input.name, "Label name", 60);
  const color = input.color ?? colorFor(name);
  checkColor(color);
  const teamId = input.teamId ?? null;
  if (
    teamId &&
    !(await db.select({ id: teams.id }).from(teams).where(eq(teams.id, teamId)).get())
  ) {
    throw notFound("Team");
  }
  const clash = await db
    .select({ id: labels.id })
    .from(labels)
    .where(and(eq(labels.name, name), teamId ? eq(labels.teamId, teamId) : isNull(labels.teamId)))
    .get();
  if (clash) throw new ServiceError("CONFLICT", `A label named "${name}" already exists`);
  const id = newId();
  await commit(db, [
    db.insert(labels).values({
      id,
      name,
      color,
      teamId,
      description: input.description?.trim() || null,
      createdAt: now,
      updatedAt: now,
    }),
    ...audit(db, [event(ctx, "label.create", "label", id, { name, color, teamId })], now),
  ]);
  return id;
}

export async function updateLabel(ctx: Ctx, id: string, input: LabelInput): Promise<string> {
  const { db, now } = ctx;
  const label = await db.select().from(labels).where(eq(labels.id, id)).get();
  if (!label) throw notFound("Label");
  const next: Partial<typeof label> = {};
  if (input.name != null) next.name = cleanText(input.name, "Label name", 60);
  if (input.color != null) {
    checkColor(input.color);
    next.color = input.color;
  }
  if (input.description !== undefined) next.description = input.description?.trim() || null;
  const diff = changes(label, next);
  if (!diff) return id;
  await commit(db, [
    db
      .update(labels)
      .set({ ...next, updatedAt: now })
      .where(eq(labels.id, id)),
    ...audit(db, [event(ctx, "label.update", "label", id, diff)], now),
  ]);
  return id;
}

/** Deletes a label and removes it from every issue. */
export async function deleteLabel(ctx: Ctx, id: string): Promise<void> {
  const { db, now } = ctx;
  const label = await db.select().from(labels).where(eq(labels.id, id)).get();
  if (!label) throw notFound("Label");
  await commit(db, [
    db.delete(issueLabels).where(eq(issueLabels.labelId, id)),
    db.delete(labels).where(eq(labels.id, id)),
    ...audit(db, [event(ctx, "label.delete", "label", id, { name: label.name })], now),
  ]);
}
