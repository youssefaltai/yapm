import type { AuditInput } from "../audit.js";
import type { HubDb } from "../db.js";
import { badRequest } from "../errors.js";

/** Who is acting, when, and optionally why. Every service call records this in the audit log. */
export interface Ctx {
  db: HubDb;
  actorId: string;
  now: number;
  /** Why the change was made; agents should always say. */
  reason?: string;
  runId?: string;
  /** Set when the change created notifications, so the caller can send them as push. */
  notified?: boolean;
}

export function cleanText(value: string, label: string, max: number): string {
  const text = value.trim();
  if (!text) throw badRequest(`${label} can't be empty`);
  if (text.length > max) throw badRequest(`${label} must be at most ${max} characters`);
  return text;
}

/** `{ field: { from, to } }` for every field in `next` that differs from `current`, or null if none. */
export function changes<T extends object>(
  current: T,
  next: Partial<T>,
): Record<string, { from: unknown; to: unknown }> | null {
  const diff: Record<string, { from: unknown; to: unknown }> = {};
  for (const [key, to] of Object.entries(next)) {
    const from = (current as Record<string, unknown>)[key] ?? null;
    if ((to ?? null) !== from) diff[key] = { from, to: to ?? null };
  }
  return Object.keys(diff).length ? diff : null;
}

/** An audit entry for a change made in this context. */
export function event(
  ctx: Ctx,
  action: string,
  entityType: string,
  entityId: string,
  data?: Record<string, unknown>,
): AuditInput {
  return {
    actorId: ctx.actorId,
    action,
    entityType,
    entityId,
    ...(data ? { data } : {}),
    ...(ctx.reason ? { reason: ctx.reason } : {}),
    ...(ctx.runId ? { runId: ctx.runId } : {}),
  };
}
