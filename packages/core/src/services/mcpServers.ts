import { MCP_SERVER_STATUSES, machines, mcpServers, users } from "@life-os/schema";
import { and, asc, eq } from "drizzle-orm";
import { audit } from "../audit.js";
import { newId } from "../crypto.js";
import { commit, type HubDb, type WriteOp } from "../db.js";
import { badRequest, notFound, ServiceError } from "../errors.js";
import { type Ctx, event } from "./common.js";
import { notify, ownerId } from "./notifications.js";
import { authorize } from "./requests.js";

type McpServerRow = typeof mcpServers.$inferSelect;
type Machine = typeof machines.$inferSelect;

export interface McpServerInput {
  machineId: string;
  name: string;
  /** A remote server's address; sign-in happens on the machine if it asks for one. */
  url?: string | null;
  /** Or a local command the machine runs, e.g. `npx` with `args`. */
  command?: string | null;
  args?: string[] | null;
  /** Agents that get it; every agent on the machine when null. */
  agentIds?: string[] | null;
}

/** Tool names become `mcp__<name>__<tool>`, so names stay short and plain. */
export function cleanServerName(value: string) {
  const name = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{0,39}$/.test(name))
    throw badRequest("Name it with 1–40 letters, digits, - or _, e.g. slack-acme");
  if (name === "life-os") throw badRequest("life-os is the company's own server");
  return name;
}

function cleanUrl(value: string) {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw badRequest("That isn't a URL");
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(local && url.protocol === "http:"))
    throw badRequest("Remote MCP servers need https");
  return url.toString();
}

async function cleanAgents(db: HubDb, ids: string[] | null | undefined) {
  if (ids === undefined || ids === null) return ids;
  const unique = [...new Set(ids.map(String))].slice(0, 50);
  for (const id of unique) {
    const user = await db.select().from(users).where(eq(users.id, id)).get();
    if (user?.kind !== "agent") throw notFound("Agent");
  }
  return unique;
}

export async function requireMcpServer(db: HubDb, id: string) {
  const row = await db.select().from(mcpServers).where(eq(mcpServers.id, id)).get();
  if (!row) throw notFound("MCP server");
  return row;
}

/**
 * Asks a machine to run an MCP server. The owner may; agents need `mcp.install` on the
 * machine, and get the server for themselves unless they name other agents.
 */
export async function createMcpServer(ctx: Ctx, input: McpServerInput): Promise<string> {
  const { db, now } = ctx;
  const machine = await db.select().from(machines).where(eq(machines.id, input.machineId)).get();
  if (!machine) throw notFound("Machine");
  const name = cleanServerName(input.name);
  const url = input.url?.trim() ? cleanUrl(input.url) : null;
  const command = input.command?.trim() || null;
  if (!url === !command) throw badRequest("Give either a URL or a command");
  if (command && command.length > 200) throw badRequest("The command is too long");
  const args = command ? (input.args ?? []).map(String).slice(0, 30) : null;
  const clash = await db
    .select({ id: mcpServers.id })
    .from(mcpServers)
    .where(and(eq(mcpServers.machineId, machine.id), eq(mcpServers.name, name)))
    .get();
  if (clash)
    throw new ServiceError("CONFLICT", `${machine.name} already has a server called ${name}`);
  const actor = await db.select().from(users).where(eq(users.id, ctx.actorId)).get();
  const agentIds =
    input.agentIds === undefined && actor?.kind === "agent"
      ? [actor.id]
      : await cleanAgents(db, input.agentIds);
  const allowed = await authorize(ctx, "mcp.install", machine.id);
  const id = newId();
  await commit(db, [
    db.insert(mcpServers).values({
      id,
      machineId: machine.id,
      name,
      transport: url ? "http" : "stdio",
      url,
      command,
      args,
      agentIds: agentIds ?? null,
      createdById: ctx.actorId,
      createdAt: now,
      updatedAt: now,
    }),
    ...allowed,
    ...audit(
      db,
      [
        event(ctx, "mcpServer.create", "mcpServer", id, {
          name,
          machine: machine.name,
          url,
          command,
        }),
      ],
      now,
    ),
  ]);
  return id;
}

/** Changes which agents get a server. Needs `mcp.update` on its machine. */
export async function updateMcpServer(
  ctx: Ctx,
  id: string,
  input: { agentIds?: string[] | null },
): Promise<string> {
  const { db, now } = ctx;
  const server = await requireMcpServer(db, id);
  if (input.agentIds === undefined) return id;
  const agentIds = (await cleanAgents(db, input.agentIds)) ?? null;
  const allowed = await authorize(ctx, "mcp.update", server.machineId);
  await commit(db, [
    db.update(mcpServers).set({ agentIds, updatedAt: now }).where(eq(mcpServers.id, id)),
    ...allowed,
    ...audit(
      db,
      [
        event(ctx, "mcpServer.update", "mcpServer", id, {
          agentIds: { from: server.agentIds, to: agentIds },
        }),
      ],
      now,
    ),
  ]);
  return id;
}

/** The machine stops running it and forgets its sign-in. Needs `mcp.remove` on its machine. */
export async function deleteMcpServer(ctx: Ctx, id: string) {
  const { db, now } = ctx;
  const server = await requireMcpServer(db, id);
  const allowed = await authorize(ctx, "mcp.remove", server.machineId);
  await commit(db, [
    db.delete(mcpServers).where(eq(mcpServers.id, id)),
    ...allowed,
    ...audit(db, [event(ctx, "mcpServer.delete", "mcpServer", id, { name: server.name })], now),
  ]);
}

export function listMcpServers(db: HubDb, machineId?: string | null) {
  return db
    .select()
    .from(mcpServers)
    .where(machineId ? eq(mcpServers.machineId, machineId) : undefined)
    .orderBy(asc(mcpServers.name))
    .all();
}

/** What the runner needs to run a server; never more. */
export function serverSpec(row: McpServerRow) {
  return {
    id: row.id,
    name: row.name,
    transport: row.transport,
    url: row.url,
    command: row.command,
    args: row.args ?? [],
    agentIds: row.agentIds,
    status: row.status,
    // Handed over once the owner signed in, until the runner reports it ready.
    ...(row.authCode ? { authCode: row.authCode } : {}),
  };
}
export type McpServerSpec = ReturnType<typeof serverSpec>;

export function serversForAgent(rows: McpServerRow[], agentId: string) {
  return rows
    .filter((r) => r.status === "ready" && (!r.agentIds || r.agentIds.includes(agentId)))
    .map(serverSpec);
}

export interface McpServerReport {
  id: string;
  status: string;
  detail?: string | null;
  authUrl?: string | null;
  authState?: string | null;
}

/**
 * The runner says how each server is doing. When one needs a sign-in, the owner hears about
 * it with the link; the provider sends them back to the hub's callback.
 */
export async function reportMcpServers(
  db: HubDb,
  machine: Machine,
  reports: McpServerReport[],
  at: number,
): Promise<boolean> {
  if (!reports.length) return false;
  const rows = await listMcpServers(db, machine.id);
  const ops: WriteOp[] = [];
  let notified = false;
  for (const report of reports.slice(0, 50)) {
    const row = rows.find((r) => r.id === report.id);
    const status = MCP_SERVER_STATUSES.find((s) => s === report.status);
    if (!row || !status) continue;
    const detail = report.detail ? String(report.detail).slice(0, 500) : null;
    if (status === "needs_auth") {
      const authUrl = report.authUrl ? String(report.authUrl).slice(0, 4000) : null;
      const authState = report.authState ? String(report.authState).slice(0, 200) : null;
      if (row.status === "needs_auth" && row.authState === authState) continue;
      ops.push(
        db
          .update(mcpServers)
          .set({ status, statusDetail: detail, authUrl, authState, authCode: null, updatedAt: at })
          .where(eq(mcpServers.id, row.id)),
      );
      const owner = await ownerId(db);
      if (owner && authUrl) {
        ops.push(
          ...notify({ db, actorId: "", now: at }, [
            {
              userId: owner,
              type: "mcpServerNeedsAuth",
              data: { serverId: row.id, name: row.name, machine: machine.name, authUrl },
            },
          ]),
        );
        notified = true;
      }
      continue;
    }
    if (row.status === status && row.statusDetail === detail) continue;
    ops.push(
      db
        .update(mcpServers)
        .set({
          status,
          statusDetail: detail,
          ...(status === "ready" ? { authUrl: null, authState: null, authCode: null } : {}),
          updatedAt: at,
        })
        .where(eq(mcpServers.id, row.id)),
    );
  }
  if (ops.length) await commit(db, ops);
  return notified;
}

/** The provider sent the owner back with a code; the runner picks it up on its next check-in. */
export async function receiveOAuthCode(db: HubDb, state: string, code: string, at: number) {
  if (!state || !code) return null;
  const row = await db
    .select()
    .from(mcpServers)
    .where(and(eq(mcpServers.authState, state), eq(mcpServers.status, "needs_auth")))
    .get();
  if (!row) return null;
  await db
    .update(mcpServers)
    .set({ authCode: code.slice(0, 2000), updatedAt: at })
    .where(eq(mcpServers.id, row.id))
    .run();
  return row;
}
