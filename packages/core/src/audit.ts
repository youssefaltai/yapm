import { auditEvents } from "@yapm/schema";
import { newId } from "./crypto.js";
import type { HubDb, WriteOp } from "./db.js";
import { insertRows } from "./write.js";

export interface AuditInput {
  actorId: string | null;
  action: string;
  entityType: string;
  entityId: string;
  data?: Record<string, unknown>;
  reason?: string;
  runId?: string;
}

export type AuditRow = typeof auditEvents.$inferInsert;

export function auditRow(input: AuditInput, now: number): AuditRow {
  return {
    id: newId(),
    actorId: input.actorId,
    runId: input.runId ?? null,
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId,
    data: input.data ?? null,
    reason: input.reason ?? null,
    createdAt: now,
  };
}

/**
 * Builds the audit-log inserts for a set of changes. Callers put them in the same
 * batch as the changes, so nothing is ever written without its audit record.
 */
export function audit(db: HubDb, inputs: AuditInput[], now: number): WriteOp[] {
  return insertRows(
    db,
    auditEvents,
    inputs.map((input) => auditRow(input, now)),
  );
}
