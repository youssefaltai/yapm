import { workspaces } from "@yapm/schema";
import { eq } from "drizzle-orm";
import { audit } from "../audit.js";
import { commit } from "../db.js";
import { badRequest, notFound } from "../errors.js";
import { cleanRouting, loadRouting } from "../runs/routing.js";
import { isTimeZone } from "../time.js";
import { type Ctx, changes, event } from "./common.js";
import { updateHandbook } from "./feedback.js";
import { loadCatalog } from "./machines.js";
import { authorize, requireOwner } from "./requests.js";
import { rescheduleAll } from "./templates.js";

export interface OrganizationUpdateInput {
  name?: string | null;
  timezone?: string | null;
  handbook?: string | null;
  modelRouting?: unknown;
}

/** Name and time zone need `organization.update`, the handbook `handbook.update`; model routing is the owner's. */
export async function updateOrganization(ctx: Ctx, input: OrganizationUpdateInput) {
  const { db, now } = ctx;
  const company = await db.select().from(workspaces).get();
  if (!company) throw notFound("Company");
  const next: Partial<typeof company> = {};
  if (input.name != null) {
    const name = input.name.trim();
    if (!name || name.length > 80) throw badRequest("Company name must be 1–80 characters");
    next.name = name;
  }
  if (input.timezone != null) {
    if (!isTimeZone(input.timezone)) throw badRequest("Unknown time zone");
    next.timezone = input.timezone;
  }
  if (input.modelRouting != null) {
    await requireOwner(ctx, "change how runs pick a model");
    const routing = cleanRouting(input.modelRouting, await loadCatalog(db));
    if (JSON.stringify(routing) !== JSON.stringify(await loadRouting(db)))
      next.modelRouting = routing;
  }
  const diff = changes(company, next);
  const allowed = diff ? await authorize(ctx, "organization.update") : [];
  if (input.handbook != null) await updateHandbook(ctx, input.handbook);
  if (!diff) return;
  await commit(db, [
    db
      .update(workspaces)
      .set({ ...next, updatedAt: now })
      .where(eq(workspaces.id, company.id)),
    ...allowed,
    ...audit(db, [event(ctx, "organization.update", "organization", company.id, diff)], now),
  ]);
  if (next.timezone) await rescheduleAll(db, next.timezone, now);
}
