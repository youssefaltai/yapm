import type { HubDeps } from "./context.js";
import { syncCycles } from "./services/cycles.js";

/**
 * Time-based work, run every minute on Node and by a cron trigger on Workers.
 * Every step is idempotent, so a missed or doubled tick does no harm.
 */
export async function tick(deps: HubDeps, at = deps.now?.() ?? Date.now()) {
  await syncCycles(deps.db, at);
}
