import { getTableColumns } from "drizzle-orm";
import type { SQLiteTable } from "drizzle-orm/sqlite-core";
import type { HubDb, WriteOp } from "./db.js";

/** D1 allows at most 100 bound parameters per statement. */
const MAX_PARAMS = 100;

/** Multi-row inserts, split so every statement stays under the D1 parameter limit. */
export function insertRows<T extends SQLiteTable>(
  db: HubDb,
  table: T,
  rows: T["$inferInsert"][],
): WriteOp[] {
  const columns = Object.keys(getTableColumns(table)).length;
  const perStatement = Math.max(1, Math.floor(MAX_PARAMS / columns));
  const ops: WriteOp[] = [];
  for (let i = 0; i < rows.length; i += perStatement) {
    ops.push(db.insert(table).values(rows.slice(i, i + perStatement)));
  }
  return ops;
}
