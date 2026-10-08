import type { HubDeps } from "./context.js";
import { deliverPush } from "./push.js";
import { dispatch } from "./runs/service.js";
import { syncCycles } from "./services/cycles.js";
import { autoArchive, checkSlas } from "./services/maintenance.js";
import { snapshotMetrics } from "./services/metrics.js";
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
    await autoArchive(deps.db, at);
  } catch (error) {
    console.error("Auto-archive failed", error);
  }
  try {
    await snapshotMetrics(deps.db, at);
  } catch (error) {
    console.error("Metric snapshot failed", error);
  }
  let notified = false;
  for (const [name, step] of [
    ["Recurring issues", () => createRecurringIssues(deps, at)],
    ["SLA check", () => checkSlas(deps.db, at)],
  ] as const) {
    try {
      if (await step()) notified = true;
    } catch (error) {
      console.error(`${name} failed`, error);
    }
  }
  // New issues and breaches wake their assignees and reach the owner's phone like any change.
  if (notified) {
    await dispatch(deps, at);
    await deliverPush(deps, at, deps.config.origin ?? "").catch((error) =>
      console.error("Push failed", error),
    );
  }
}
