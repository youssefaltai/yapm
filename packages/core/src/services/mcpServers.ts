import { type McpAuth, mcpServers } from "@yapm/schema";
import { and, asc, eq, sql } from "drizzle-orm";
import { audit } from "../audit.js";
import type { HubDeps } from "../context.js";
import { newId, open, randomToken, seal, toBase64Url } from "../crypto.js";
import { commit, type HubDb } from "../db.js";
import { badRequest, notFound } from "../errors.js";
import { type Ctx, event } from "./common.js";
import { ownerId } from "./notifications.js";
import { checkPermission, requestOps, requireOwner, usePermission } from "./requests.js";

type McpServerRow = typeof mcpServers.$inferSelect;
type Tokens = { accessToken: string; refreshToken?: string; expiresAt?: number };

/** Tokens that expire within this long are refreshed before a run gets them. */
const REFRESH_WINDOW = 5 * 60 * 1000;

export interface McpServerCreateInput {
  name: string;
  url?: string | null;
  command?: string | null;
  args?: string[] | null;
  auth?: McpAuth | null;
  secretEnv?: string | null;
  howToConnect?: string | null;
  /** The least the agent needs; else what the server asks for. */
  scopes?: string[] | null;
  /** A client the provider publishes for Claude Code, as in its `mcpServers` config. */
  oauth?: { clientId: string; callbackPort: number } | null;
  reason: string;
  issueId?: string | null;
}

/** Tool names become `mcp__<name>__<tool>`, so names stay short and plain. */
export function cleanServerName(value: string) {
  const name = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{0,39}$/.test(name))
    throw badRequest("Name it with 1–40 letters, digits, - or _, e.g. slack-acme");
  if (name === "yapm") throw badRequest("yapm is the company's own server");
  return name;
}

function cleanUrl(value: string) {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw badRequest("That isn't a URL");
  }
  if (url.protocol !== "https:") throw badRequest("Remote MCP servers need https");
  return url.toString();
}

/** Outgoing HTTP that says which URL failed, so the agent can fix it. Redirects aren't followed. */
async function reach(deps: HubDeps, url: string, init?: RequestInit) {
  try {
    return await (deps.fetch ?? fetch)(url, { ...init, redirect: "manual" });
  } catch (error) {
    throw badRequest(`Couldn't reach ${url}: ${error instanceof Error ? error.message : error}`);
  }
}

async function getJson(deps: HubDeps, url: string): Promise<Record<string, unknown> | null> {
  const response = await reach(deps, url, { headers: { accept: "application/json" } });
  if (!response.ok) return null;
  return (await response.json().catch(() => null)) as Record<string, unknown> | null;
}

/**
 * How a remote server signs in, worked out as the MCP authorization spec says: an
 * unauthenticated call, then the protected resource's metadata, then its authorization server's.
 * OAuth whenever there is an authorization server. Without registration, it takes the client
 * the provider publishes, whose redirect is a localhost page the owner pastes back.
 */
async function discoverAuth(
  deps: HubDeps,
  url: string,
  scopes: string[],
  client: McpServerCreateInput["oauth"],
) {
  const probe = await reach(deps, url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "yapm", version: "1" },
      },
    }),
  });
  if (probe.status !== 401) {
    if (!probe.ok)
      throw badRequest(`${url} answered ${probe.status}; check it is the server's MCP endpoint`);
    return { auth: "none" as const, oauth: null };
  }
  const challenge = probe.headers.get("www-authenticate") ?? "";
  const param = (key: string) => new RegExp(`${key}="([^"]*)"`).exec(challenge)?.[1];
  const resource = await getJson(
    deps,
    cleanUrl(
      param("resource_metadata") ?? new URL("/.well-known/oauth-protected-resource", url).href,
    ),
  );
  const servers = resource?.authorization_servers;
  const issuer = new URL(
    cleanUrl(Array.isArray(servers) ? String(servers[0]) : new URL(url).origin),
  );
  const path = issuer.pathname.replace(/\/$/, "");
  const meta =
    (await getJson(deps, `${issuer.origin}/.well-known/oauth-authorization-server${path}`)) ??
    (await getJson(deps, `${issuer.origin}${path}/.well-known/openid-configuration`));
  const cimd = meta?.client_id_metadata_document_supported === true;
  const registration = typeof meta?.registration_endpoint === "string";
  if (typeof meta?.authorization_endpoint !== "string" || typeof meta.token_endpoint !== "string")
    return { auth: "token" as const, oauth: null };
  const supported = resource?.scopes_supported;
  const scope =
    scopes.join(" ") || param("scope") || (Array.isArray(supported) ? supported.join(" ") : "");
  return {
    auth: "oauth" as const,
    oauth: {
      authorizationEndpoint: meta.authorization_endpoint,
      tokenEndpoint: meta.token_endpoint,
      ...(client
        ? {
            clientId: client.clientId,
            redirectUri: `http://localhost:${client.callbackPort}/callback`,
          }
        : cimd
          ? {}
          : registration
            ? { registrationEndpoint: String(meta.registration_endpoint) }
            : noClient(url)),
      ...(scope ? { scope } : {}),
    },
  };
}

function noClient(url: string): never {
  throw badRequest(
    `${url} registers no OAuth clients. Find the client ID and callback port the provider documents for Claude Code and pass them as oauth: { clientId, callbackPort }.`,
  );
}

/** Whether the sign-in ends on a localhost page whose address the owner pastes back. */
export const pastesCallback = (server: Pick<McpServerRow, "oauth">) =>
  server.oauth?.redirectUri?.startsWith("http://localhost:") ?? false;

/** What the owner approves, in markdown. */
function describe(server: Omit<McpServerRow, "requestId" | "secret">) {
  const command = [server.command ?? "", ...(server.args ?? [])]
    .map((part) => (/\s/.test(part) ? JSON.stringify(part) : part))
    .join(" ");
  const signIn = {
    none: "none.",
    oauth: "you sign in with the provider from this request; the hub keeps the tokens, encrypted.",
    token: `you paste a token here${server.secretEnv ? ` (it goes in ${server.secretEnv})` : ""}; the hub keeps it, encrypted.`,
  }[server.auth];
  return [
    server.url
      ? `Connect the remote MCP server **${server.name}** at ${server.url}.`
      : `Connect the local MCP server **${server.name}**, which the runner starts with:\n\n\`\`\`\n${command}\n\`\`\``,
    `Sign-in: ${signIn}`,
    server.howToConnect ? `How to connect:\n\n${server.howToConnect}` : "",
    `Its tools reach the agent as \`mcp__${server.name}__<tool>\`.`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

async function newServer(deps: HubDeps, input: McpServerCreateInput, name: string, now: number) {
  const url = input.url?.trim() ? cleanUrl(input.url) : null;
  const command = input.command?.trim() || null;
  if (!url && !command)
    throw badRequest(`There is no ${name} MCP server yet: give its url or command to connect it`);
  if (url && command) throw badRequest("Give either a url or a command");
  if (command && command.length > 200) throw badRequest("The command is too long");
  const secretEnv = input.secretEnv?.trim() || null;
  if (secretEnv && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(secretEnv))
    throw badRequest("secretEnv must be an env var name, e.g. GITHUB_TOKEN");
  let auth: McpAuth;
  let oauth: Record<string, string> | null = null;
  if (url && input.auth !== "none" && input.auth !== "token") {
    const scopes = (input.scopes ?? []).map((scope) => scope.trim()).filter(Boolean);
    ({ auth, oauth } = await discoverAuth(deps, url, scopes, input.oauth));
    if (input.auth === "oauth" && auth !== "oauth")
      throw badRequest(
        `${url} offers no OAuth sign-in the hub can use. Ask with auth token, and say in howToConnect where the owner gets one.`,
      );
  } else {
    auth = input.auth ?? (secretEnv ? "token" : "none");
  }
  if (command && auth === "oauth")
    throw badRequest("A local server gets its token through secretEnv, not OAuth");
  if (command && auth === "token" && !secretEnv)
    throw badRequest("Name the env var the token goes in with secretEnv");
  const howToConnect = input.howToConnect?.trim() || null;
  if (howToConnect && howToConnect.length > 4000) throw badRequest("howToConnect is too long");
  return {
    id: newId(),
    name,
    url,
    command,
    args: command ? (input.args ?? []).map(String).slice(0, 30) : null,
    auth,
    secretEnv: command ? secretEnv : null,
    howToConnect,
    status: "pending" as const,
    oauth,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * An agent asks to connect an outside MCP server. It is stored and, in the same batch, a
 * request for `mcp.use` on it is filed, even when a grant already covers the name: the owner
 * approves each new server. A name already taken only files the request. No request (null)
 * when the agent may already use it.
 */
export async function createMcpServer(
  ctx: Ctx,
  deps: HubDeps,
  input: McpServerCreateInput,
): Promise<{ serverId: string; requestId: string | null }> {
  const { db, now } = ctx;
  const name = cleanServerName(input.name);
  const permitted = (await checkPermission(db, ctx.actorId, "mcp.use", name)).allowed;
  const existing = await db.select().from(mcpServers).where(eq(mcpServers.name, name)).get();
  if (existing && permitted) return { serverId: existing.id, requestId: null };
  const server = existing ?? (await newServer(deps, input, name, now));
  const request = await requestOps(
    ctx,
    {
      title: `Use the ${name} MCP server`,
      action: "mcp.use",
      resource: name,
      reason: input.reason,
      details: describe(server),
      issueId: input.issueId ?? null,
    },
    true,
  );
  await commit(db, [
    ...(existing
      ? []
      : [
          db.insert(mcpServers).values({ ...server, requestId: request.id }),
          ...audit(
            db,
            [
              event(ctx, "mcpServer.create", "mcpServer", server.id, {
                name,
                url: server.url,
                command: server.command,
                auth: server.auth,
              }),
            ],
            now,
          ),
        ]),
    ...request.ops,
  ]);
  return { serverId: server.id, requestId: request.id };
}

export async function requireMcpServer(db: HubDb, id: string) {
  const row = await db.select().from(mcpServers).where(eq(mcpServers.id, id)).get();
  if (!row) throw notFound("MCP server");
  return row;
}

/**
 * The owner connects a server: a pasted token is stored and it's ready; otherwise an OAuth
 * sign-in starts, and the provider sends the owner back to the hub's callback, or to a localhost
 * page whose address the owner pastes here as `callbackUrl`.
 */
export async function connectMcpServer(
  ctx: Ctx,
  deps: HubDeps,
  input: {
    id: string;
    token?: string | null;
    callbackUrl?: string | null;
    /** A path on the hub to come back to after signing in. */
    returnTo?: string | null;
    origin: string;
  },
): Promise<{ authorizationUrl: string | null }> {
  const { db, now } = ctx;
  await requireOwner(ctx, "connect MCP servers");
  // Only a path on the hub, so a sign-in can't send the owner to another site.
  const returnTo = input.returnTo ?? "";
  if (returnTo && !(returnTo.startsWith("/") && new URL(returnTo, "http://hub").host === "hub"))
    throw badRequest("returnTo must be a path");
  const server = await requireMcpServer(db, input.id);
  const token = input.token?.trim();
  if (token) {
    const secret = await seal(deps.config.secret, JSON.stringify({ accessToken: token }));
    await commit(db, [
      db
        .update(mcpServers)
        .set({ secret, status: "ready", updatedAt: now })
        .where(eq(mcpServers.id, server.id)),
      ...audit(
        db,
        [event(ctx, "mcpServer.connect", "mcpServer", server.id, { name: server.name })],
        now,
      ),
    ]);
    return { authorizationUrl: null };
  }
  const callbackUrl = input.callbackUrl?.trim();
  if (callbackUrl) {
    const query = URL.canParse(callbackUrl)
      ? Object.fromEntries(new URL(callbackUrl).searchParams)
      : {};
    if (!query.state || query.state !== server.oauth?.state)
      throw badRequest(
        "That address is from another sign-in. Sign in again and paste the address you land on.",
      );
    const { error } = await finishOAuth(deps, query, now);
    if (error) throw badRequest(error);
    return { authorizationUrl: null };
  }
  if (server.auth !== "oauth" || !server.oauth)
    throw badRequest(
      server.auth === "none" ? `${server.name} needs no sign-in` : "Paste the token to connect it",
    );
  const oauth = server.oauth;
  const { client_id, ...client } = clientMetadata(input.origin);
  const redirectUri = pastesCallback(server) ? oauth.redirectUri : client.redirect_uris[0];
  const clientId =
    oauth.clientId ||
    (oauth.registrationEndpoint
      ? await register(deps, oauth.registrationEndpoint, client)
      : client_id);
  const verifier = randomToken("");
  const state = randomToken("", 16);
  const challenge = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  const url = new URL(oauth.authorizationEndpoint ?? "");
  const params = {
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri ?? "",
    code_challenge: toBase64Url(new Uint8Array(challenge)),
    code_challenge_method: "S256",
    state,
    resource: server.url ?? "",
    ...(oauth.scope ? { scope: oauth.scope } : {}),
  };
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  await db
    .update(mcpServers)
    .set({
      oauth: {
        ...oauth,
        clientId,
        redirectUri: redirectUri ?? "",
        state,
        verifier: await seal(deps.config.secret, verifier),
        returnTo,
      },
      updatedAt: now,
    })
    .where(eq(mcpServers.id, server.id))
    .run();
  return { authorizationUrl: url.href };
}

/** Dynamic client registration, for providers that don't read client metadata documents. */
async function register(deps: HubDeps, endpoint: string, client: object) {
  const response = await reach(deps, endpoint, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(client),
  });
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok || typeof body.client_id !== "string")
    throw badRequest(`The provider refused to register the hub: ${body.error ?? response.status}`);
  return body.client_id;
}

/** The hub as an OAuth client, served at `/api/mcp/oauth/client.json`. */
export function clientMetadata(origin: string) {
  return {
    client_id: `${origin}/api/mcp/oauth/client.json`,
    client_name: "yapm",
    redirect_uris: [`${origin}/api/mcp/oauth/callback`],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  };
}

async function tokenRequest(
  deps: HubDeps,
  endpoint: string,
  params: Record<string, string>,
  at: number,
): Promise<Tokens> {
  const response = await reach(deps, endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams(params),
  });
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  // Some providers (Slack) answer errors with HTTP 200 and `ok: false`.
  if (!response.ok || typeof body.access_token !== "string")
    throw new Error(String(body.error_description ?? body.error ?? `HTTP ${response.status}`));
  return {
    accessToken: body.access_token,
    refreshToken:
      typeof body.refresh_token === "string" ? body.refresh_token : params.refresh_token,
    ...(typeof body.expires_in === "number" ? { expiresAt: at + body.expires_in * 1000 } : {}),
  };
}

/**
 * The provider sent the owner back: exchange the code and store the tokens. Says which
 * request to return to, and what went wrong if anything did.
 */
export async function finishOAuth(
  deps: HubDeps,
  query: { state?: string; code?: string; error?: string; error_description?: string },
  at: number,
): Promise<{ requestId: string | null; returnTo: string | null; error: string | null }> {
  const { db } = deps;
  const server = query.state
    ? await db
        .select()
        .from(mcpServers)
        .where(sql`json_extract(${mcpServers.oauth}, '$.state') = ${query.state}`)
        .get()
    : undefined;
  const { state: _, verifier, returnTo, ...oauth } = server?.oauth ?? {};
  // Claim the flow before using its code, so a callback that arrives twice exchanges it once.
  const claimed =
    server && verifier
      ? await db
          .update(mcpServers)
          .set({ oauth, updatedAt: at })
          .where(
            and(
              eq(mcpServers.id, server.id),
              sql`json_extract(${mcpServers.oauth}, '$.state') = ${query.state}`,
            ),
          )
          .returning({ id: mcpServers.id })
          .all()
      : [];
  if (!server || !claimed.length)
    return {
      requestId: server?.requestId ?? null,
      returnTo: null,
      error: "This sign-in has expired or was already used. Connect again from the request.",
    };
  try {
    if (query.error) throw new Error(query.error_description ?? query.error);
    const tokens = await tokenRequest(
      deps,
      oauth.tokenEndpoint ?? "",
      {
        grant_type: "authorization_code",
        code: query.code ?? "",
        redirect_uri: oauth.redirectUri ?? "",
        client_id: oauth.clientId ?? "",
        code_verifier: await open(deps.config.secret, verifier ?? ""),
        resource: server.url ?? "",
      },
      at,
    );
    const owner = await ownerId(db);
    await commit(db, [
      db
        .update(mcpServers)
        .set({
          secret: await seal(deps.config.secret, JSON.stringify(tokens)),
          status: "ready",
          updatedAt: at,
        })
        .where(eq(mcpServers.id, server.id)),
      ...audit(
        db,
        [
          {
            actorId: owner ?? "",
            action: "mcpServer.connect",
            entityType: "mcpServer",
            entityId: server.id,
            data: { name: server.name },
          },
        ],
        at,
      ),
    ]);
    return { requestId: server.requestId, returnTo: returnTo || null, error: null };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      requestId: server.requestId,
      returnTo: returnTo || null,
      error: `The sign-in didn't go through: ${reason}`,
    };
  }
}

/**
 * The server's token for a run, refreshed when it expires soon. A sign-in that no longer
 * works sets the server back to pending for the owner to connect again, and gives null.
 */
async function accessToken(deps: HubDeps, server: McpServerRow, at: number) {
  const { db } = deps;
  try {
    let tokens = JSON.parse(await open(deps.config.secret, server.secret ?? "")) as Tokens;
    if (tokens.refreshToken && tokens.expiresAt && tokens.expiresAt < at + REFRESH_WINDOW) {
      tokens = await tokenRequest(
        deps,
        server.oauth?.tokenEndpoint ?? "",
        {
          grant_type: "refresh_token",
          refresh_token: tokens.refreshToken,
          client_id: server.oauth?.clientId ?? "",
          resource: server.url ?? "",
        },
        at,
      );
      const secret = await seal(deps.config.secret, JSON.stringify(tokens));
      await db
        .update(mcpServers)
        .set({ secret, updatedAt: at })
        .where(eq(mcpServers.id, server.id))
        .run();
    }
    return tokens.accessToken;
  } catch {
    await db
      .update(mcpServers)
      .set({ status: "pending", updatedAt: at })
      .where(eq(mcpServers.id, server.id))
      .run();
    return null;
  }
}

/** One server in Claude Code's `mcpServers` shape. */
function serverConfig(server: McpServerRow, token: string | null) {
  if (server.url)
    return {
      type: "http" as const,
      url: server.url,
      ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}),
    };
  return {
    type: "stdio" as const,
    command: server.command ?? "",
    args: server.args ?? [],
    ...(token && server.secretEnv ? { env: { [server.secretEnv]: token } } : {}),
  };
}
export type McpServerConfig = ReturnType<typeof serverConfig>;

/**
 * The connected servers an agent may use, with their secrets filled in. Handing one to a run
 * uses the permission, so a one-time approval is spent.
 */
export async function mcpServersFor(
  deps: HubDeps,
  agentId: string,
  runId: string,
  at: number,
): Promise<Record<string, McpServerConfig>> {
  const { db } = deps;
  const ready = await db
    .select()
    .from(mcpServers)
    .where(eq(mcpServers.status, "ready"))
    .orderBy(asc(mcpServers.name))
    .all();
  const configs: Record<string, McpServerConfig> = {};
  for (const server of ready) {
    if (!(await checkPermission(db, agentId, "mcp.use", server.name)).allowed) continue;
    const token = server.auth === "none" ? null : await accessToken(deps, server, at);
    if (server.auth !== "none" && !token) continue;
    await usePermission({ db, actorId: agentId, now: at, runId }, "mcp.use", server.name);
    configs[server.name] = serverConfig(server, token);
  }
  return configs;
}
