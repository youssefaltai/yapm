import type * as schema from "@yapm/schema";
import type { BatchItem } from "drizzle-orm/batch";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";

export type Schema = typeof schema;

/**
 * The database every platform adapter hands to the hub: Cloudflare D1 or a
 * libSQL/SQLite file, both through Drizzle's async SQLite dialect. Writes that
 * must land together go through `batch`, which is atomic on both drivers.
 */
export type HubDb = BaseSQLiteDatabase<"async", unknown, Schema> & {
  batch<U extends BatchItem<"sqlite">, T extends Readonly<[U, ...U[]]>>(batch: T): Promise<unknown>;
};

export type WriteOp = BatchItem<"sqlite">;

/** Runs the given statements atomically. */
export async function commit(db: HubDb, ops: WriteOp[]): Promise<void> {
  const [first, ...rest] = ops;
  if (!first) return;
  await db.batch([first, ...rest]);
}
