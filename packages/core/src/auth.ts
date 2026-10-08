import { apiTokens, authChallenges, passkeys, sessions, users } from "@life-os/schema";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import { and, eq, gt, isNull, lt } from "drizzle-orm";
import { type Context, Hono, type MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { HTTPException } from "hono/http-exception";
import { audit } from "./audit.js";
import type { HubEnv, User } from "./context.js";
import { fromBase64Url, newId, randomToken, sha256Hex, toBase64Url } from "./crypto.js";
import { commit, type HubDb } from "./db.js";
import { seedCompany } from "./seed.js";

export const SESSION_COOKIE = "life_os_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const CHALLENGE_TTL_MS = 5 * 60 * 1000;
export const API_TOKEN_PREFIX = "los_";

function now(c: Context<HubEnv>): number {
  return c.var.deps.now?.() ?? Date.now();
}

function relyingParty(c: Context<HubEnv>): { origin: string; rpID: string; rpName: string } {
  const { config } = c.var.deps;
  const origin = config.origin ?? new URL(c.req.url).origin;
  return { origin, rpID: new URL(origin).hostname, rpName: config.rpName ?? "Life OS" };
}

export async function ownerExists(db: HubDb): Promise<boolean> {
  const row = await db.select({ id: users.id }).from(users).where(eq(users.kind, "owner")).get();
  return row !== undefined;
}

/** Resolves the caller from a session cookie or an API token (`Authorization: Bearer los_…` or bare). */
export const resolveViewer: MiddlewareHandler<HubEnv> = async (c, next) => {
  c.set("viewer", null);
  const { db } = c.var.deps;
  const header = c.req.header("authorization");
  if (header) {
    const token = header.replace(/^Bearer\s+/i, "").trim();
    const user = await userForToken(db, token, now(c));
    if (!user) throw new HTTPException(401, { message: "Invalid API token" });
    c.set("viewer", { user, via: "token" });
    return next();
  }
  const cookie = getCookie(c, SESSION_COOKIE);
  if (cookie) {
    // Cookie-authenticated writes must come from the app's own origin (CSRF protection).
    const origin = c.req.header("origin");
    if (c.req.method !== "GET" && origin && origin !== relyingParty(c).origin) {
      throw new HTTPException(403, { message: "Cross-origin request refused" });
    }
    const id = await sha256Hex(cookie);
    const row = await db
      .select({ user: users })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .where(and(eq(sessions.id, id), gt(sessions.expiresAt, now(c))))
      .get();
    if (row?.user.active) c.set("viewer", { user: row.user, via: "session" });
  }
  return next();
};

async function userForToken(db: HubDb, token: string, at: number): Promise<User | null> {
  if (!token.startsWith(API_TOKEN_PREFIX)) return null;
  const tokenHash = await sha256Hex(token);
  const row = await db
    .select({ user: users, tokenId: apiTokens.id, lastUsedAt: apiTokens.lastUsedAt })
    .from(apiTokens)
    .innerJoin(users, eq(users.id, apiTokens.userId))
    .where(and(eq(apiTokens.tokenHash, tokenHash), isNull(apiTokens.revokedAt)))
    .get();
  if (!row?.user.active) return null;
  // Record usage at most hourly so busy agents don't spend a write per request.
  if (!row.lastUsedAt || at - row.lastUsedAt > 60 * 60 * 1000) {
    await db.update(apiTokens).set({ lastUsedAt: at }).where(eq(apiTokens.id, row.tokenId));
  }
  return row.user;
}

/** Issues a new API token for a member. The plain token is returned once and never stored. */
export async function createApiToken(
  db: HubDb,
  input: { userId: string; name: string; actorId: string },
  at: number,
): Promise<{ id: string; token: string }> {
  const token = randomToken(API_TOKEN_PREFIX);
  const id = newId();
  await commit(db, [
    db.insert(apiTokens).values({
      id,
      userId: input.userId,
      name: input.name,
      tokenHash: await sha256Hex(token),
      prefix: token.slice(0, API_TOKEN_PREFIX.length + 6),
      createdAt: at,
    }),
    ...audit(
      db,
      [
        {
          actorId: input.actorId,
          action: "apiToken.create",
          entityType: "apiToken",
          entityId: id,
          data: { userId: input.userId, name: input.name },
        },
      ],
      at,
    ),
  ]);
  return { id, token };
}

async function startSession(c: Context<HubEnv>, userId: string) {
  const token = randomToken("", 32);
  const at = now(c);
  const id = await sha256Hex(token);
  return {
    op: c.var.deps.db
      .insert(sessions)
      .values({ id, userId, createdAt: at, expiresAt: at + SESSION_TTL_MS }),
    setCookie: () =>
      setCookie(c, SESSION_COOKIE, token, {
        httpOnly: true,
        sameSite: "Lax",
        secure: relyingParty(c).origin.startsWith("https:"),
        path: "/",
        maxAge: SESSION_TTL_MS / 1000,
      }),
  };
}

async function takeChallenge(c: Context<HubEnv>, id: unknown, kind: "setup" | "login") {
  if (typeof id !== "string") throw new HTTPException(400, { message: "Missing challengeId" });
  const { db } = c.var.deps;
  const row = await db
    .delete(authChallenges)
    .where(and(eq(authChallenges.id, id), eq(authChallenges.kind, kind)))
    .returning()
    .get();
  if (!row || row.expiresAt < now(c)) {
    throw new HTTPException(400, { message: "Challenge expired, please try again" });
  }
  return row;
}

async function saveChallenge(
  c: Context<HubEnv>,
  kind: "setup" | "login",
  challenge: string,
  payload: Record<string, string> | null,
): Promise<string> {
  const { db } = c.var.deps;
  const id = newId();
  const at = now(c);
  await db.batch([
    db.delete(authChallenges).where(lt(authChallenges.expiresAt, at)),
    db
      .insert(authChallenges)
      .values({ id, kind, challenge, payload, expiresAt: at + CHALLENGE_TTL_MS }),
  ]);
  return id;
}

function viewerJson(user: User) {
  return { id: user.id, name: user.name, displayName: user.displayName, kind: user.kind };
}

export const authRoutes = new Hono<HubEnv>()
  /** Whether this deployment still needs its first-run setup. */
  .get("/setup", async (c) => c.json({ needsSetup: !(await ownerExists(c.var.deps.db)) }))

  /** First run: the owner names the company and creates their passkey. */
  .post("/setup/options", async (c) => {
    const { db } = c.var.deps;
    if (await ownerExists(db))
      throw new HTTPException(409, { message: "Setup is already complete" });
    const body = await c.req.json<{ companyName?: string; ownerName?: string }>();
    const companyName = body.companyName?.trim();
    const ownerName = body.ownerName?.trim();
    if (!companyName || !ownerName) {
      throw new HTTPException(400, { message: "Company name and your name are required" });
    }
    const ownerId = newId();
    const rp = relyingParty(c);
    const options = await generateRegistrationOptions({
      rpName: rp.rpName,
      rpID: rp.rpID,
      userName: ownerName,
      userDisplayName: ownerName,
      userID: new TextEncoder().encode(ownerId),
      attestationType: "none",
      authenticatorSelection: { residentKey: "required", userVerification: "preferred" },
    });
    const challengeId = await saveChallenge(c, "setup", options.challenge, {
      ownerId,
      ownerName,
      companyName,
    });
    return c.json({ challengeId, options });
  })

  .post("/setup/verify", async (c) => {
    const { db } = c.var.deps;
    const body = await c.req.json<{ challengeId?: string; response?: unknown }>();
    const challenge = await takeChallenge(c, body.challengeId, "setup");
    if (await ownerExists(db))
      throw new HTTPException(409, { message: "Setup is already complete" });
    const rp = relyingParty(c);
    const result = await verifyRegistrationResponse({
      // biome-ignore lint/suspicious/noExplicitAny: validated by the library
      response: body.response as any,
      expectedChallenge: challenge.challenge,
      expectedOrigin: rp.origin,
      expectedRPID: rp.rpID,
      requireUserVerification: false,
    }).catch((error: Error) => {
      throw new HTTPException(400, { message: error.message });
    });
    if (!result.verified)
      throw new HTTPException(400, { message: "Passkey could not be verified" });

    const { ownerId, ownerName, companyName } = challenge.payload as Record<string, string>;
    if (!ownerId || !ownerName || !companyName)
      throw new HTTPException(400, { message: "Bad challenge" });
    const at = now(c);
    const { credential } = result.registrationInfo;
    const session = await startSession(c, ownerId);
    await commit(db, [
      ...seedCompany(db, { ownerId, ownerName, companyName, now: at }),
      db.insert(passkeys).values({
        id: credential.id,
        userId: ownerId,
        publicKey: toBase64Url(credential.publicKey),
        counter: credential.counter,
        transports: credential.transports ?? null,
        name: "First passkey",
        createdAt: at,
      }),
      session.op,
    ]);
    session.setCookie();
    const owner = await db.select().from(users).where(eq(users.id, ownerId)).get();
    return c.json({ viewer: owner ? viewerJson(owner) : null });
  })

  .post("/auth/login/options", async (c) => {
    const rp = relyingParty(c);
    const options = await generateAuthenticationOptions({
      rpID: rp.rpID,
      userVerification: "preferred",
    });
    const challengeId = await saveChallenge(c, "login", options.challenge, null);
    return c.json({ challengeId, options });
  })

  .post("/auth/login/verify", async (c) => {
    const { db } = c.var.deps;
    const body = await c.req.json<{ challengeId?: string; response?: { id?: string } }>();
    const challenge = await takeChallenge(c, body.challengeId, "login");
    const credentialId = body.response?.id;
    if (typeof credentialId !== "string")
      throw new HTTPException(400, { message: "Missing credential" });
    const passkey = await db.select().from(passkeys).where(eq(passkeys.id, credentialId)).get();
    if (!passkey) throw new HTTPException(401, { message: "Unknown passkey" });
    const rp = relyingParty(c);
    const result = await verifyAuthenticationResponse({
      // biome-ignore lint/suspicious/noExplicitAny: validated by the library
      response: body.response as any,
      expectedChallenge: challenge.challenge,
      expectedOrigin: rp.origin,
      expectedRPID: rp.rpID,
      requireUserVerification: false,
      credential: {
        id: passkey.id,
        publicKey: fromBase64Url(passkey.publicKey),
        counter: passkey.counter,
        ...(passkey.transports ? { transports: passkey.transports } : {}),
      },
    }).catch((error: Error) => {
      throw new HTTPException(401, { message: error.message });
    });
    if (!result.verified)
      throw new HTTPException(401, { message: "Passkey could not be verified" });

    const user = await db.select().from(users).where(eq(users.id, passkey.userId)).get();
    if (!user?.active) throw new HTTPException(401, { message: "Account is not active" });
    const session = await startSession(c, user.id);
    await commit(db, [
      db
        .update(passkeys)
        .set({ counter: result.authenticationInfo.newCounter, lastUsedAt: now(c) })
        .where(eq(passkeys.id, passkey.id)),
      session.op,
    ]);
    session.setCookie();
    return c.json({ viewer: viewerJson(user) });
  })

  .post("/auth/logout", async (c) => {
    const cookie = getCookie(c, SESSION_COOKIE);
    if (cookie) {
      const { db } = c.var.deps;
      await db.delete(sessions).where(eq(sessions.id, await sha256Hex(cookie)));
    }
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    return c.json({ ok: true });
  })

  .get("/auth/me", (c) => {
    const viewer = c.var.viewer;
    if (!viewer) throw new HTTPException(401, { message: "Not signed in" });
    return c.json({ viewer: viewerJson(viewer.user) });
  });
