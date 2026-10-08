import {
  hubSettings,
  notifications,
  pushSubscriptions,
  requests,
  teams,
  users,
} from "@life-os/schema";
import { and, eq, inArray, isNull } from "drizzle-orm";
import type { HubDeps } from "./context.js";
import { fromBase64Url, toBase64Url } from "./crypto.js";
import type { HubDb } from "./db.js";
import { findIssue } from "./services/issues.js";

// Web Push with only Web Crypto, so it runs the same on Node and Workers:
// VAPID (RFC 8292) to identify the hub, and aes128gcm (RFC 8291) to encrypt payloads.

const VAPID_KEY = "vapid";
const encoder = new TextEncoder();

interface VapidKeys {
  publicKey: string;
  privateJwk: JsonWebKey;
}

/** The hub's VAPID key pair, made the first time anyone asks for it. */
export async function vapidKeys(db: HubDb, now = Date.now()): Promise<VapidKeys> {
  const stored = await db.select().from(hubSettings).where(eq(hubSettings.key, VAPID_KEY)).get();
  if (stored) return JSON.parse(stored.value) as VapidKeys;
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const keys: VapidKeys = {
    publicKey: toBase64Url(
      new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer),
    ),
    privateJwk: (await crypto.subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey,
  };
  // Two first requests at once: whichever insert lands first wins, and both read it back.
  await db
    .insert(hubSettings)
    .values({ key: VAPID_KEY, value: JSON.stringify(keys), createdAt: now })
    .onConflictDoNothing()
    .run();
  const winner = await db.select().from(hubSettings).where(eq(hubSettings.key, VAPID_KEY)).get();
  return winner ? (JSON.parse(winner.value) as VapidKeys) : keys;
}

async function vapidAuthorization(keys: VapidKeys, endpoint: string, subject: string) {
  const header = toBase64Url(encoder.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = toBase64Url(
    encoder.encode(
      JSON.stringify({
        aud: new URL(endpoint).origin,
        exp: Math.floor(Date.now() / 1000) + 12 * 3600,
        sub: subject,
      }),
    ),
  );
  const key = await crypto.subtle.importKey(
    "jwk",
    keys.privateJwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    encoder.encode(`${header}.${claims}`),
  );
  return `vapid t=${header}.${claims}.${toBase64Url(new Uint8Array(signature))}, k=${keys.publicKey}`;
}

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

async function hkdf(
  salt: Uint8Array<ArrayBuffer>,
  ikm: Uint8Array<ArrayBuffer>,
  info: Uint8Array<ArrayBuffer>,
  bytes: number,
) {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(
    await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, bytes * 8),
  );
}

/** The input to HKDF for the content key and nonce, shared with whoever decrypts. */
export async function pushKeys(
  authSecret: Uint8Array<ArrayBuffer>,
  ecdhSecret: Uint8Array<ArrayBuffer>,
  receiverKey: Uint8Array,
  senderKey: Uint8Array,
  salt: Uint8Array<ArrayBuffer>,
) {
  const ikm = await hkdf(
    authSecret,
    ecdhSecret,
    concat(encoder.encode("WebPush: info\0"), receiverKey, senderKey),
    32,
  );
  return {
    contentKey: await hkdf(salt, ikm, encoder.encode("Content-Encoding: aes128gcm\0"), 16),
    nonce: await hkdf(salt, ikm, encoder.encode("Content-Encoding: nonce\0"), 12),
  };
}

/** Encrypts a payload for one browser (RFC 8291), as a single aes128gcm record. */
export async function encryptPayload(p256dh: string, auth: string, payload: Uint8Array) {
  const receiverKey = fromBase64Url(p256dh);
  const receiver = await crypto.subtle.importKey(
    "raw",
    receiverKey,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const sender = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
    "deriveBits",
  ])) as CryptoKeyPair;
  const senderKey = new Uint8Array(
    (await crypto.subtle.exportKey("raw", sender.publicKey)) as ArrayBuffer,
  );
  const ecdhSecret = new Uint8Array(
    await crypto.subtle.deriveBits({ name: "ECDH", public: receiver }, sender.privateKey, 256),
  );
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const { contentKey, nonce } = await pushKeys(
    fromBase64Url(auth),
    ecdhSecret,
    receiverKey,
    senderKey,
    salt,
  );
  const key = await crypto.subtle.importKey("raw", contentKey, "AES-GCM", false, ["encrypt"]);
  // 0x02 marks the last (and only) record; no padding.
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: nonce },
      key,
      concat(payload, new Uint8Array([2])),
    ),
  );
  const recordSize = new Uint8Array(4);
  new DataView(recordSize.buffer).setUint32(0, 4096);
  return concat(salt, recordSize, new Uint8Array([senderKey.length]), senderKey, ciphertext);
}

export interface PushMessage {
  title: string;
  body: string;
  /** Where tapping the notification opens. */
  url: string;
  /** Replaces an earlier notification with the same tag instead of stacking. */
  tag: string;
}

type NotificationRow = typeof notifications.$inferSelect;

async function message(db: HubDb, n: NotificationRow): Promise<PushMessage> {
  const actor = n.actorId
    ? await db.select({ name: users.name }).from(users).where(eq(users.id, n.actorId)).get()
    : undefined;
  const who = actor?.name ?? "Someone";
  if (n.requestId) {
    const request = await db.select().from(requests).where(eq(requests.id, n.requestId)).get();
    const title = request?.title ?? "A request";
    return n.type === "requestCreated"
      ? {
          title: `${who} asks for approval`,
          body: title,
          url: `/request/${n.requestId}`,
          tag: n.requestId,
        }
      : {
          title: `Request ${String(n.data?.status ?? "answered")}`,
          body: title,
          url: `/request/${n.requestId}`,
          tag: n.requestId,
        };
  }
  if (n.type === "projectUpdateCreated" && n.projectId) {
    const health = { onTrack: "on track", atRisk: "at risk", offTrack: "off track" }[
      String(n.data?.health)
    ];
    return {
      title: String(n.data?.project ?? "Project update"),
      body: `${who} posted an update${health ? `: ${health}` : ""}`,
      url: `/project/${n.projectId}`,
      tag: n.projectUpdateId ?? n.id,
    };
  }
  const issue = n.issueId ? await findIssue(db, n.issueId) : null;
  const identifier = issue ? await identifierOf(db, issue.teamId, issue.number) : "";
  const title = issue ? `${identifier} ${issue.title}` : "Life OS";
  const url = identifier ? `/issue/${identifier}` : "/inbox";
  const body: Record<NotificationRow["type"], string> = {
    issueAssignedToYou: `${who} assigned it to you`,
    issueUnassignedFromYou: `${who} unassigned you`,
    issueMention: `${who} mentioned you`,
    issueCommentMention: `${who} mentioned you in a comment`,
    issueNewComment: `${who} commented`,
    issueStatusChanged: `${who} moved it to ${String(n.data?.to ?? "a new status")}`,
    requestCreated: `${who} asks for approval`,
    requestAnswered: `${who} answered your request`,
    projectUpdateCreated: `${who} posted a project update`,
  };
  return { title, body: body[n.type], url, tag: n.issueId ?? n.id };
}

async function identifierOf(db: HubDb, teamId: string, number: number) {
  const team = await db.select({ key: teams.key }).from(teams).where(eq(teams.id, teamId)).get();
  return team ? `${team.key}-${number}` : "";
}

type Device = typeof pushSubscriptions.$inferSelect;

/** Sends one message to a set of devices; returns how many push services accepted it. */
async function sendToDevices(
  deps: HubDeps,
  devices: Device[],
  origin: string,
  msg: PushMessage,
  urgency: "high" | "normal",
): Promise<number> {
  if (!devices.length) return 0;
  const { db } = deps;
  const send = deps.fetch ?? fetch;
  const at = deps.now?.() ?? Date.now();
  const keys = await vapidKeys(db, at);
  const subject = origin.startsWith("https://") ? origin : "mailto:life-os@localhost";
  const payload = encoder.encode(JSON.stringify({ ...msg, url: new URL(msg.url, origin).href }));
  const results = await Promise.all(
    devices.map(async (device) => {
      try {
        const response = await send(device.endpoint, {
          method: "POST",
          headers: {
            authorization: await vapidAuthorization(keys, device.endpoint, subject),
            "content-encoding": "aes128gcm",
            "content-type": "application/octet-stream",
            ttl: String(24 * 3600),
            urgency,
            topic: msg.tag.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32),
          },
          body: await encryptPayload(device.p256dh, device.auth, payload),
        });
        if (response.status === 404 || response.status === 410) {
          // The browser unsubscribed or the subscription expired.
          await db.delete(pushSubscriptions).where(eq(pushSubscriptions.id, device.id)).run();
          return false;
        }
        if (!response.ok) {
          console.error(`Push to ${new URL(device.endpoint).host} failed: ${response.status}`);
          return false;
        }
        await db
          .update(pushSubscriptions)
          .set({ lastUsedAt: at })
          .where(eq(pushSubscriptions.id, device.id))
          .run();
        return true;
      } catch (error) {
        console.error("Push failed", error);
        return false;
      }
    }),
  );
  return results.filter(Boolean).length;
}

/** Sends a message straight to a member's devices, e.g. a test. */
export async function sendPush(deps: HubDeps, userId: string, origin: string, msg: PushMessage) {
  const devices = await deps.db
    .select()
    .from(pushSubscriptions)
    .where(eq(pushSubscriptions.userId, userId))
    .all();
  return sendToDevices(deps, devices, origin, msg, "normal");
}

/**
 * Sends the notifications created at `at` as Web Push to members who turned it on. Each
 * notification is claimed (pushedAt) before sending, so two deliveries never double up.
 */
export async function deliverPush(deps: HubDeps, at: number, origin: string): Promise<void> {
  const { db } = deps;
  const claimed = await db
    .update(notifications)
    .set({ pushedAt: at })
    .where(
      and(
        eq(notifications.createdAt, at),
        isNull(notifications.pushedAt),
        inArray(
          notifications.userId,
          db.select({ id: pushSubscriptions.userId }).from(pushSubscriptions),
        ),
      ),
    )
    .returning()
    .all();
  if (!claimed.length) return;
  const devices = await db
    .select()
    .from(pushSubscriptions)
    .where(inArray(pushSubscriptions.userId, [...new Set(claimed.map((n) => n.userId))]))
    .all();
  for (const n of claimed) {
    await sendToDevices(
      deps,
      devices.filter((d) => d.userId === n.userId),
      origin,
      await message(db, n),
      n.type === "requestCreated" ? "high" : "normal",
    );
  }
}

/** Runs work after the response where the platform allows (Workers' waitUntil), logging failures. */
export function background(
  waitUntil: ((p: Promise<unknown>) => void) | undefined,
  work: Promise<void>,
) {
  const guarded = work.catch((error) => console.error("Background work failed", error));
  if (waitUntil) waitUntil(guarded);
}

/** Hono's waitUntil when the platform has one (Workers), else nothing: Node keeps running anyway. */
export function waitUntilOf(c: { executionCtx: { waitUntil(p: Promise<unknown>): void } }) {
  try {
    const ctx = c.executionCtx;
    return (p: Promise<unknown>) => ctx.waitUntil(p);
  } catch {
    return undefined;
  }
}
