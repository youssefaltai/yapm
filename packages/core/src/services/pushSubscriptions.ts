import { pushSubscriptions } from "@yapm/schema";
import { and, eq } from "drizzle-orm";
import { audit } from "../audit.js";
import { fromBase64Url, newId } from "../crypto.js";
import { commit } from "../db.js";
import { badRequest } from "../errors.js";
import { type Ctx, event } from "./common.js";

/** A browser's PushSubscription, as `JSON.stringify(subscription)` gives it. */
interface SubscriptionJson {
  endpoint?: unknown;
  keys?: { p256dh?: unknown; auth?: unknown };
}

/** The browsers' push services: Chrome's FCM, Firefox's autopush, Safari's and Edge's WNS. */
const pushServices =
  /^(fcm\.googleapis\.com|updates\.push\.services\.mozilla\.com|web\.push\.apple\.com|[a-z0-9-]+\.notify\.windows\.com)$/;

/** Saves a browser's push subscription for the viewer; subscribing again just refreshes it. */
export async function createPushSubscription(
  ctx: Ctx,
  data: string,
  userAgent: string | null,
): Promise<string> {
  const { db, now } = ctx;
  let parsed: SubscriptionJson;
  try {
    parsed = JSON.parse(data) as SubscriptionJson;
  } catch {
    throw badRequest("data must be the browser's PushSubscription as JSON");
  }
  const endpoint = typeof parsed.endpoint === "string" ? parsed.endpoint : "";
  const p256dh = typeof parsed.keys?.p256dh === "string" ? parsed.keys.p256dh : "";
  const auth = typeof parsed.keys?.auth === "string" ? parsed.keys.auth : "";
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw badRequest("The subscription has no valid endpoint");
  }
  if (url.protocol !== "https:" || !pushServices.test(url.hostname))
    throw badRequest("Push endpoints must be a browser's push service, over https");
  if (fromBase64Url(p256dh).length !== 65 || fromBase64Url(auth).length !== 16)
    throw badRequest("The subscription's keys are not a P-256 key and a 16-byte secret");
  const existing = await db
    .select()
    .from(pushSubscriptions)
    .where(eq(pushSubscriptions.endpoint, endpoint))
    .get();
  const id = existing?.id ?? newId();
  await commit(db, [
    existing
      ? db
          .update(pushSubscriptions)
          .set({ userId: ctx.actorId, p256dh, auth, userAgent })
          .where(eq(pushSubscriptions.id, id))
      : db.insert(pushSubscriptions).values({
          id,
          userId: ctx.actorId,
          endpoint,
          p256dh,
          auth,
          userAgent,
          createdAt: now,
        }),
    ...audit(
      db,
      [event(ctx, "pushSubscription.create", "pushSubscription", id, { userAgent })],
      now,
    ),
  ]);
  return id;
}

export async function deletePushSubscription(ctx: Ctx, id: string): Promise<void> {
  const { db, now } = ctx;
  const row = await db
    .select()
    .from(pushSubscriptions)
    .where(and(eq(pushSubscriptions.id, id), eq(pushSubscriptions.userId, ctx.actorId)))
    .get();
  if (!row) return;
  await commit(db, [
    db.delete(pushSubscriptions).where(eq(pushSubscriptions.id, id)),
    ...audit(db, [event(ctx, "pushSubscription.delete", "pushSubscription", id)], now),
  ]);
}
