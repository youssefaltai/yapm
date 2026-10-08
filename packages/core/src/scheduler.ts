import type { HubDeps } from "./context.js";
import { deliverPush } from "./push.js";
import { dispatch } from "./runs/service.js";
import { syncCycles } from "./services/cycles.js";
import { createRecurringIssues } from "./services/templates.js";

/**
 * Time-based work, run every minute on Node and by a cron trigger on Workers.
 * Every step is idempotent, so a missed or doubled tick does no harm.
 */
export async function tick(deps: HubDeps, at = deps.now?.() ?? Date.now()) {
  try {
    await syncCycles(deps.db, at);
  } catch (error) {
    console.error("Cycle sync failed", error);
  }
  try {
    // New recurring issues wake their assignees and reach the owner's phone like any other change.
    if (await createRecurringIssues(deps, at)) {
      await dispatch(deps, at);
      await deliverPush(deps, at, deps.config.origin ?? "");
    }
  } catch (error) {
    console.error("Recurring issues failed", error);
  }
}
