import type { machines } from "@life-os/schema";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { relyingParty } from "../auth.js";
import type { HubEnv } from "../context.js";
import { ServiceError } from "../errors.js";
import { background, deliverPush, waitUntilOf } from "../push.js";
import { announce } from "../realtime.js";
import { enrolMachine, machineForToken, machineName } from "../services/machines.js";
import { appendLogs, claimRun, completeRun, dispatch, heartbeat } from "./service.js";

type Machine = typeof machines.$inferSelect;
type RunnerEnv = HubEnv & { Variables: HubEnv["Variables"] & { machine: Machine } };

/**
 * The runner protocol: machines enrol, check in, claim runs, stream transcripts and report
 * results. Machines authenticate with their own secret (`lrn_…`), never a member's token.
 */
export const runnerRoutes = new Hono<RunnerEnv>();

const at = (c: { var: { deps: HubEnv["Variables"]["deps"] } }) => c.var.deps.now?.() ?? Date.now();

runnerRoutes.onError((error, c) => {
  if (error instanceof ServiceError) {
    const status = ({ BAD_REQUEST: 400, NOT_FOUND: 404, FORBIDDEN: 403, CONFLICT: 409 } as const)[
      error.code
    ];
    return c.json({ error: error.message, code: error.code }, status);
  }
  if (error instanceof HTTPException) return c.json({ error: error.message }, error.status);
  console.error(error);
  return c.json({ error: "Internal error" }, 500);
});

async function body<T>(c: { req: { json(): Promise<unknown> } }): Promise<T> {
  try {
    return (await c.req.json()) as T;
  } catch {
    throw new HTTPException(400, { message: "Send JSON" });
  }
}

runnerRoutes.post("/enrol", async (c) => {
  const input = await body<Parameters<typeof enrolMachine>[1]>(c);
  const now = at(c);
  const result = await enrolMachine(c.var.deps.db, input, now);
  // It waits on Machines for the owner's approval.
  await announce(c.var.deps.realtime, { type: "change", actorId: "", clientId: null, at: now });
  return c.json({ ...result, approveAt: `${relyingParty(c).origin}/machines` }, 201);
});

// Everything else needs the machine's secret.
runnerRoutes.use("*", async (c, next) => {
  const token = (c.req.header("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  const machine = await machineForToken(c.var.deps.db, token);
  if (!machine) throw new HTTPException(401, { message: "Unknown or revoked machine" });
  c.set("machine", machine);
  await next();
});

runnerRoutes.get("/me", (c) => {
  const m = c.var.machine;
  return c.json({
    id: m.id,
    name: machineName(m),
    status: m.status,
    tags: m.tags,
    capacity: m.capacity,
  });
});

function requireActive(machine: Machine) {
  if (machine.status !== "active")
    throw new HTTPException(403, { message: "This machine is waiting for the owner's approval" });
}

runnerRoutes.post("/heartbeat", async (c) => {
  const info = await body<Parameters<typeof heartbeat>[2]>(c);
  const now = at(c);
  const { notified, changed, ...result } = await heartbeat(c.var.deps.db, c.var.machine, info, now);
  if (changed) {
    await announce(c.var.deps.realtime, { type: "change", actorId: "", clientId: null, at: now });
  }
  // A server waiting for a sign-in tells the owner's phone.
  if (notified) background(waitUntilOf(c), deliverPush(c.var.deps, now, relyingParty(c).origin));
  return c.json({ status: c.var.machine.status, ...result });
});

runnerRoutes.post("/claim", async (c) => {
  requireActive(c.var.machine);
  const claimed = await claimRun(c.var.deps, c.var.machine, at(c));
  if (!claimed) return c.body(null, 204);
  return c.json({ ...claimed, mcpUrl: `${relyingParty(c).origin}/mcp` });
});

runnerRoutes.post("/runs/:id/logs", async (c) => {
  requireActive(c.var.machine);
  const upload = await body<Parameters<typeof appendLogs>[3]>(c);
  return c.json(await appendLogs(c.var.deps.db, c.var.machine, c.req.param("id"), upload, at(c)));
});

runnerRoutes.post("/runs/:id/complete", async (c) => {
  requireActive(c.var.machine);
  const { deps } = c.var;
  const now = at(c);
  const completion = await body<Parameters<typeof completeRun>[3]>(c);
  const result = await completeRun(deps, c.var.machine, c.req.param("id"), completion, now);
  if (result.notified) {
    // What the agent did may wake others, and the owner's phone.
    await dispatch(deps, now);
    background(waitUntilOf(c), deliverPush(deps, now, relyingParty(c).origin));
  }
  await announce(deps.realtime, { type: "change", actorId: "", clientId: null, at: now });
  return c.json({ status: result.status });
});
