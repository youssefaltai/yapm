import { notifications, teams, templates, workflowStates } from "@yapm/schema";
import { and, eq, isNotNull, lte } from "drizzle-orm";
import { audit } from "../audit.js";
import type { HubDeps } from "../context.js";
import { newId } from "../crypto.js";
import { commit, type HubDb } from "../db.js";
import { badRequest, notFound } from "../errors.js";
import { localDate, nextOccurrence, normalizeSchedule, type ScheduleShape } from "../time.js";
import { type Ctx, changes, cleanText, event } from "./common.js";
import { companyTimeZone } from "./cycles.js";
import { createIssue } from "./issues.js";

export type TemplateRow = typeof templates.$inferSelect;

export function checkSchedule(value: unknown): ScheduleShape {
  try {
    return normalizeSchedule(value);
  } catch (error) {
    throw badRequest(error instanceof Error ? error.message : String(error));
  }
}

/** Recomputes recurring issues' next times after the company's time zone changes. */
export async function rescheduleAll(db: HubDb, timeZone: string, at: number) {
  const rows = await db.select().from(templates).where(isNotNull(templates.schedule)).all();
  await commit(
    db,
    rows.flatMap((t) =>
      t.schedule
        ? [
            db
              .update(templates)
              .set({ nextRunAt: nextOccurrence(t.schedule, timeZone, at) })
              .where(eq(templates.id, t.id)),
          ]
        : [],
    ),
  );
}

export interface TemplateInput {
  name?: string | null;
  description?: string | null;
  teamId?: string | null;
  templateData?: Record<string, unknown> | null;
  /** With a schedule, the template creates an issue each time it fires. Null stops it. */
  schedule?: unknown;
}

/** The issue fields a template may set. */
const FIELDS = [
  "title",
  "description",
  "priority",
  "estimate",
  "assigneeId",
  "labelIds",
  "projectId",
  "stateId",
] as const;

function cleanData(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw badRequest("templateData must be an object of issue fields");
  const v = value as Record<string, unknown>;
  const data: Record<string, unknown> = {};
  for (const key of FIELDS) if (v[key] !== undefined && v[key] !== null) data[key] = v[key];
  if (typeof data.title !== "string" || !data.title.trim())
    throw badRequest("A template needs an issue title");
  if (JSON.stringify(data).length > 20_000) throw badRequest("That template is too large");
  return data;
}

export async function requireTemplate(db: HubDb, id: string) {
  const row = await db.select().from(templates).where(eq(templates.id, id)).get();
  if (!row) throw notFound("Template");
  return row;
}

export async function createTemplate(ctx: Ctx, input: TemplateInput) {
  const { db, now } = ctx;
  if (!input.teamId) throw badRequest("Pick the team the template belongs to");
  const team = await db
    .select({ id: teams.id })
    .from(teams)
    .where(eq(teams.id, input.teamId))
    .get();
  if (!team) throw notFound("Team");
  const templateData = cleanData(input.templateData);
  const name = input.name?.trim()
    ? cleanText(input.name, "Name", 80)
    : String(templateData.title).slice(0, 80);
  const schedule = input.schedule ? checkSchedule(input.schedule) : null;
  const nextRunAt = schedule ? nextOccurrence(schedule, await companyTimeZone(db), now) : null;
  const id = newId();
  await commit(db, [
    db.insert(templates).values({
      id,
      name,
      description: input.description?.trim() || null,
      teamId: team.id,
      templateData,
      schedule,
      nextRunAt,
      creatorId: ctx.actorId,
      createdAt: now,
      updatedAt: now,
    }),
    ...audit(db, [event(ctx, "template.create", "template", id, { name, schedule })], now),
  ]);
  return id;
}

export async function updateTemplate(ctx: Ctx, id: string, input: TemplateInput) {
  const { db, now } = ctx;
  const template = await requireTemplate(db, id);
  const next: Partial<TemplateRow> = {};
  if (input.name != null) next.name = cleanText(input.name, "Name", 80);
  if (input.description !== undefined) next.description = input.description?.trim() || null;
  const diff = changes(template, next) ?? {};
  if (input.templateData) {
    const data = cleanData(input.templateData);
    if (JSON.stringify(data) !== JSON.stringify(template.templateData)) {
      next.templateData = data;
      diff.templateData = { from: template.templateData, to: data };
    }
  }
  if (input.schedule !== undefined) {
    const schedule = input.schedule ? checkSchedule(input.schedule) : null;
    if (JSON.stringify(schedule) !== JSON.stringify(template.schedule)) {
      next.schedule = schedule;
      next.nextRunAt = schedule ? nextOccurrence(schedule, await companyTimeZone(db), now) : null;
      diff.schedule = { from: template.schedule, to: schedule };
    }
  }
  if (!Object.keys(diff).length) return id;
  await commit(db, [
    db
      .update(templates)
      .set({ ...next, updatedAt: now })
      .where(eq(templates.id, id)),
    ...audit(db, [event(ctx, "template.update", "template", id, diff)], now),
  ]);
  return id;
}

export async function deleteTemplate(ctx: Ctx, id: string) {
  const { db, now } = ctx;
  const template = await requireTemplate(db, id);
  await commit(db, [
    db.delete(templates).where(eq(templates.id, id)),
    ...audit(db, [event(ctx, "template.delete", "template", id, { name: template.name })], now),
  ]);
}

/** `{date}` in a recurring issue's title becomes the day it was created. */
function fill(text: unknown, date: string) {
  return typeof text === "string" ? text.replaceAll("{date}", date) : text;
}

/** The template's status, or null for the team's default once that status is removed. */
async function stillThere(db: HubDb, teamId: string, stateId: unknown) {
  if (typeof stateId !== "string") return null;
  const state = await db
    .select({ id: workflowStates.id })
    .from(workflowStates)
    .where(and(eq(workflowStates.id, stateId), eq(workflowStates.teamId, teamId)))
    .get();
  return state?.id ?? null;
}

/** Creates the issue for each recurring template that is due. Returns whether any notified. */
export async function createRecurringIssues(deps: HubDeps, at: number) {
  const { db } = deps;
  const due = await db
    .select()
    .from(templates)
    .where(and(isNotNull(templates.schedule), lte(templates.nextRunAt, at)))
    .limit(20)
    .all();
  if (!due.length) return false;
  const timeZone = await companyTimeZone(db);
  const date = localDate(at, timeZone);
  let notified = false;
  for (const template of due) {
    const schedule = template.schedule;
    if (!schedule) continue;
    // Move the schedule on first, so a broken template can't create an issue every minute.
    await db
      .update(templates)
      .set({ nextRunAt: nextOccurrence(schedule, timeZone, at), lastRunAt: at })
      .where(eq(templates.id, template.id))
      .run();
    const data = template.templateData;
    const ctx: Ctx = {
      db,
      actorId: template.creatorId ?? "",
      now: at,
      reason: `Recurring issue from the template "${template.name}"`,
    };
    try {
      const issueId = await createIssue(ctx, {
        teamId: template.teamId,
        title: String(fill(data.title, date)),
        description: (fill(data.description, date) as string | undefined) ?? null,
        priority: typeof data.priority === "number" ? data.priority : null,
        estimate: typeof data.estimate === "number" ? data.estimate : null,
        assigneeId: typeof data.assigneeId === "string" ? data.assigneeId : null,
        labelIds: Array.isArray(data.labelIds) ? data.labelIds.map(String) : null,
        projectId: typeof data.projectId === "string" ? data.projectId : null,
        stateId: await stillThere(db, template.teamId, data.stateId),
      });
      // An agent's recurring issue for itself still has to wake it: the hub is the one asking.
      if (data.assigneeId && data.assigneeId === template.creatorId) {
        await db
          .insert(notifications)
          .values({
            id: newId(),
            userId: template.creatorId,
            type: "issueAssignedToYou",
            actorId: null,
            issueId,
            createdAt: at,
            updatedAt: at,
          })
          .run();
        ctx.notified = true;
      }
      if (ctx.notified) notified = true;
    } catch (error) {
      console.error(`Recurring issue from "${template.name}" failed`, error);
    }
  }
  return notified;
}
