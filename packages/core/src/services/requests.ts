import {
  type GrantScope,
  grants,
  issues,
  mcpServers,
  requests,
  runs,
  teamMemberships,
  teams,
  users,
} from "@life-os/schema";
import { and, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { audit } from "../audit.js";
import { newId } from "../crypto.js";
import { commit, type HubDb, type WriteOp } from "../db.js";
import { badRequest, forbidden, notFound, ServiceError } from "../errors.js";
import { type Ctx, cleanText, event } from "./common.js";
import { feedbackOp } from "./feedback.js";
import { notify, ownerId } from "./notifications.js";

/**
 * Permissions are plain strings. Org changes use their audit action names (`team.create`,
 * `agent.hire`, `agent.retire`, `charter.update`, `user.update`); runners use `tool:<Name>`.
 * A grant for `*` allows everything.
 */
const ACTION = /^[A-Za-z][\w.:*-]{0,79}$/;

export type Permission =
  | { allowed: true; via: "owner" }
  | { allowed: true; via: "grant"; grantId: string }
  | { allowed: true; via: "approval"; requestId: string }
  | { allowed: false; pendingRequestId: string | null };

async function loadActor(db: HubDb, id: string) {
  const user = await db.select().from(users).where(eq(users.id, id)).get();
  if (!user?.active) throw notFound("Member");
  return user;
}

/** The first standing grant that lets `userId` do `action` on `resource`. */
async function findGrant(db: HubDb, userId: string, action: string, resource: string | null) {
  const teamIds = db
    .select({ id: teamMemberships.teamId })
    .from(teamMemberships)
    .where(eq(teamMemberships.userId, userId));
  return db
    .select({ id: grants.id })
    .from(grants)
    .where(
      and(
        isNull(grants.revokedAt),
        inArray(grants.action, [action, "*"]),
        resource
          ? or(isNull(grants.resource), eq(grants.resource, resource))
          : isNull(grants.resource),
        or(
          eq(grants.scope, "everyone"),
          and(eq(grants.scope, "user"), eq(grants.subjectId, userId)),
          and(eq(grants.scope, "team"), inArray(grants.subjectId, teamIds)),
        ),
      ),
    )
    .get();
}

/** Requests by `userId` for exactly this action and resource, newest first. */
function ownRequests(db: HubDb, userId: string, action: string, resource: string | null) {
  return db
    .select()
    .from(requests)
    .where(
      and(
        eq(requests.requesterId, userId),
        eq(requests.action, action),
        resource ? eq(requests.resource, resource) : isNull(requests.resource),
      ),
    )
    .orderBy(desc(requests.createdAt))
    .all();
}

/** Whether a member may do something now, and why. Reads only. */
export async function checkPermission(
  db: HubDb,
  userId: string,
  action: string,
  resource: string | null = null,
): Promise<Permission> {
  const user = await loadActor(db, userId);
  if (user.kind === "owner") return { allowed: true, via: "owner" };
  const grant = await findGrant(db, userId, action, resource);
  if (grant) return { allowed: true, via: "grant", grantId: grant.id };
  const own = await ownRequests(db, userId, action, resource);
  // An "always allow" answer is a grant, not a one-time pass; revoking the grant ends it.
  const approved = own.find((r) => r.status === "approved" && !r.grantId && !r.consumedAt);
  if (approved) return { allowed: true, via: "approval", requestId: approved.id };
  return { allowed: false, pendingRequestId: own.find((r) => r.status === "pending")?.id ?? null };
}

/**
 * Lets the actor do `action`, or refuses with a hint on how to ask. Returns the writes that
 * record the use (a grant's counter, or using up a one-time approval); callers commit them
 * in the same batch as the action itself.
 */
export async function authorize(
  ctx: Ctx,
  action: string,
  resource: string | null = null,
): Promise<WriteOp[]> {
  const { db, now } = ctx;
  const permission = await checkPermission(db, ctx.actorId, action, resource);
  if (!permission.allowed) {
    const ask = permission.pendingRequestId
      ? "Your request for it is waiting for an answer."
      : "Ask for it with requestCreate (MCP: create_request).";
    throw forbidden(`This needs approval: ${action}${resource ? ` on ${resource}` : ""}. ${ask}`);
  }
  if (permission.via === "grant") {
    return [
      db
        .update(grants)
        .set({ useCount: sql`${grants.useCount} + 1`, lastUsedAt: now })
        .where(eq(grants.id, permission.grantId)),
    ];
  }
  if (permission.via === "approval") {
    return [
      db
        .update(requests)
        .set({ consumedAt: now, updatedAt: now })
        .where(eq(requests.id, permission.requestId)),
    ];
  }
  return [];
}

export interface RequestCreateInput {
  title: string;
  action: string;
  resource?: string | null;
  reason: string;
  details?: string | null;
  issueId?: string | null;
}

/** An agent asks for something. Asking again while a request is pending returns that request. */
export async function createRequest(ctx: Ctx, input: RequestCreateInput): Promise<string> {
  const { id, ops } = await requestOps(ctx, input);
  await commit(ctx.db, ops);
  return id;
}

/** The writes that file a request, for callers that commit them with their own; none when one is pending. */
export async function requestOps(
  ctx: Ctx,
  input: RequestCreateInput,
  /** Ask even though it's allowed, e.g. for the owner to sign in to a server again. */
  again = false,
): Promise<{ id: string; ops: WriteOp[] }> {
  const { db, now } = ctx;
  const actor = await loadActor(db, ctx.actorId);
  if (actor.kind === "owner") throw badRequest("The owner doesn't need to ask");
  const action = input.action.trim();
  if (!ACTION.test(action)) throw badRequest("Action must look like team.create or tool:Bash");
  const resource = input.resource?.trim() || null;
  if (resource && resource.length > 500)
    throw badRequest("Resource must be at most 500 characters");
  const title = cleanText(input.title, "Title", 120);
  const reason = cleanText(input.reason, "Reason", 2000);
  const details = input.details?.trim() || null;
  if (details && details.length > 20000)
    throw badRequest("Details must be at most 20000 characters");

  const permission = await checkPermission(db, actor.id, action, resource);
  if (permission.allowed && !again)
    throw new ServiceError("CONFLICT", "You can already do this; no need to ask");
  const pending = permission.allowed
    ? (await ownRequests(db, actor.id, action, resource)).find((r) => r.status === "pending")?.id
    : permission.pendingRequestId;
  if (pending) return { id: pending, ops: [] };

  let issueId: string | null = null;
  if (input.issueId) {
    const issue = await db
      .select({ id: issues.id })
      .from(issues)
      .where(eq(issues.id, input.issueId))
      .get();
    if (!issue) throw notFound("Issue");
    issueId = issue.id;
  }
  const id = newId();
  const owner = await ownerId(db);
  const ops = [
    // A run that asks shows as waiting on the answer.
    ...(ctx.runId
      ? [
          db
            .update(runs)
            .set({ waitingOnRequestId: id, updatedAt: now })
            .where(eq(runs.id, ctx.runId)),
        ]
      : []),
    db.insert(requests).values({
      id,
      requesterId: actor.id,
      title,
      action,
      resource,
      reason,
      details,
      issueId,
      runId: ctx.runId ?? null,
      createdAt: now,
      updatedAt: now,
    }),
    ...notify(ctx, [
      { userId: owner ?? "", type: "requestCreated", requestId: id, issueId, data: { title } },
    ]),
    ...audit(
      db,
      [event(ctx, "request.create", "request", id, { title, action, resource, issueId })],
      now,
    ),
  ];
  return { id, ops };
}

/** The run that asked stops waiting once the request is answered. */
function stopWaiting(db: HubDb, requestId: string, now: number): WriteOp {
  return db
    .update(runs)
    .set({ waitingOnRequestId: null, updatedAt: now })
    .where(eq(runs.waitingOnRequestId, requestId));
}

async function pendingRequest(ctx: Ctx, id: string) {
  const actor = await loadActor(ctx.db, ctx.actorId);
  if (actor.kind !== "owner") throw forbidden("Only the owner answers requests for now");
  const request = await ctx.db.select().from(requests).where(eq(requests.id, id)).get();
  if (!request) throw notFound("Request");
  if (request.status !== "pending")
    throw new ServiceError("CONFLICT", `This request was already ${request.status}`);
  return request;
}

export interface AlwaysAllowInput {
  /** Who the grant covers: the requester, one of the requester's teams, or everyone. */
  scope: GrantScope;
  teamId?: string | null;
  /** Allow the action on anything, not only this request's resource. */
  anyResource?: boolean | null;
}

export interface GrantCreateInput {
  action: string;
  resource?: string | null;
  scope: GrantScope;
  subjectId?: string | null;
  note?: string | null;
}

/** Validates a grant's subject and returns the insert for it. */
async function grantRow(ctx: Ctx, input: GrantCreateInput, requestId: string | null) {
  const { db, now } = ctx;
  const action = input.action.trim();
  if (!ACTION.test(action)) throw badRequest("Action must look like team.create or tool:Bash");
  let subjectId: string | null = null;
  if (input.scope === "user") {
    const user = input.subjectId
      ? await db.select().from(users).where(eq(users.id, input.subjectId)).get()
      : null;
    if (!user?.active || user.kind !== "agent") throw notFound("Agent");
    subjectId = user.id;
  } else if (input.scope === "team") {
    const team = input.subjectId
      ? await db.select().from(teams).where(eq(teams.id, input.subjectId)).get()
      : null;
    if (!team || team.archivedAt) throw notFound("Team");
    subjectId = team.id;
  }
  const row = {
    id: newId(),
    action,
    resource: input.resource?.trim() || null,
    scope: input.scope,
    subjectId,
    note: input.note?.trim() || null,
    createdById: ctx.actorId,
    requestId,
    createdAt: now,
    updatedAt: now,
  };
  return row;
}

/** Approves once, or with `always` also creates a standing grant. */
export async function approveRequest(
  ctx: Ctx,
  id: string,
  input: { note?: string | null; always?: AlwaysAllowInput | null } = {},
): Promise<string> {
  const { db, now } = ctx;
  const request = await pendingRequest(ctx, id);
  if (request.action === "mcp.use") {
    const server = await db
      .select({ status: mcpServers.status })
      .from(mcpServers)
      .where(eq(mcpServers.name, request.resource ?? ""))
      .get();
    if (server && server.status !== "ready")
      throw new ServiceError("CONFLICT", `Connect ${request.resource} first`);
  }
  const ops: WriteOp[] = [];
  const events = [];
  let grantId: string | null = null;
  if (input.always) {
    const { scope } = input.always;
    const subjectId =
      scope === "user"
        ? request.requesterId
        : scope === "team"
          ? (input.always.teamId ?? null)
          : null;
    const row = await grantRow(
      ctx,
      {
        action: request.action,
        resource: input.always.anyResource ? null : request.resource,
        scope,
        subjectId,
        note: input.note ?? null,
      },
      request.id,
    );
    grantId = row.id;
    ops.push(db.insert(grants).values(row));
    events.push(
      event(ctx, "grant.create", "grant", row.id, {
        action: row.action,
        resource: row.resource,
        scope,
        subjectId: row.subjectId,
        requestId: request.id,
      }),
    );
  }
  ops.unshift(
    db
      .update(requests)
      .set({
        status: "approved",
        answeredById: ctx.actorId,
        answeredAt: now,
        answer: input.note?.trim() || null,
        grantId,
        updatedAt: now,
      })
      .where(eq(requests.id, id)),
  );
  events.unshift(
    event(ctx, "request.approve", "request", id, {
      title: request.title,
      requesterId: request.requesterId,
      always: !!grantId,
    }),
  );
  ops.push(
    ...notify(ctx, [
      {
        userId: request.requesterId,
        type: "requestAnswered",
        requestId: id,
        issueId: request.issueId,
        data: { title: request.title, status: "approved", always: !!grantId },
      },
    ]),
  );
  await commit(db, [...ops, stopWaiting(db, id, now), ...audit(db, events, now)]);
  return id;
}

/** Rejects with a reason, which goes back to the agent and into its feedback. */
export async function rejectRequest(ctx: Ctx, id: string, reason: string): Promise<string> {
  const { db, now } = ctx;
  const request = await pendingRequest(ctx, id);
  const answer = cleanText(reason, "A reason", 2000);
  await commit(db, [
    db
      .update(requests)
      .set({
        status: "rejected",
        answeredById: ctx.actorId,
        answeredAt: now,
        answer,
        updatedAt: now,
      })
      .where(eq(requests.id, id)),
    ...notify(ctx, [
      {
        userId: request.requesterId,
        type: "requestAnswered",
        requestId: id,
        issueId: request.issueId,
        data: { title: request.title, status: "rejected", reason: answer },
      },
    ]),
    ...((await loadActor(db, request.requesterId)).kind === "agent"
      ? [
          feedbackOp(ctx, {
            agentId: request.requesterId,
            kind: "rejection",
            body: `Rejected "${request.title}": ${answer}`,
            runId: request.runId,
            issueId: request.issueId,
            requestId: id,
          }),
        ]
      : []),
    stopWaiting(db, id, now),
    ...audit(
      db,
      [
        event(ctx, "request.reject", "request", id, {
          title: request.title,
          requesterId: request.requesterId,
          reason: answer,
        }),
      ],
      now,
    ),
  ]);
  return id;
}

/** The requester (or the owner) withdraws a pending request. */
export async function cancelRequest(ctx: Ctx, id: string): Promise<string> {
  const { db, now } = ctx;
  const actor = await loadActor(db, ctx.actorId);
  const request = await db.select().from(requests).where(eq(requests.id, id)).get();
  if (!request) throw notFound("Request");
  if (request.requesterId !== actor.id && actor.kind !== "owner")
    throw forbidden("You can only cancel your own requests");
  if (request.status !== "pending")
    throw new ServiceError("CONFLICT", `This request was already ${request.status}`);
  await commit(db, [
    db.update(requests).set({ status: "canceled", updatedAt: now }).where(eq(requests.id, id)),
    stopWaiting(db, id, now),
    ...audit(db, [event(ctx, "request.cancel", "request", id, { title: request.title })], now),
  ]);
  return id;
}

export async function requireOwner(ctx: Ctx, what: string) {
  if ((await loadActor(ctx.db, ctx.actorId)).kind !== "owner")
    throw forbidden(`Only the owner can ${what}`);
}

/** The owner allows something up front, without waiting to be asked. */
export async function createGrant(ctx: Ctx, input: GrantCreateInput): Promise<string> {
  const { db, now } = ctx;
  await requireOwner(ctx, "grant permissions");
  const row = await grantRow(ctx, input, null);
  await commit(db, [
    db.insert(grants).values(row),
    ...audit(
      db,
      [
        event(ctx, "grant.create", "grant", row.id, {
          action: row.action,
          resource: row.resource,
          scope: row.scope,
          subjectId: row.subjectId,
        }),
      ],
      now,
    ),
  ]);
  return row.id;
}

export async function revokeGrant(ctx: Ctx, id: string): Promise<string> {
  const { db, now } = ctx;
  await requireOwner(ctx, "revoke grants");
  const grant = await db.select().from(grants).where(eq(grants.id, id)).get();
  if (!grant) throw notFound("Grant");
  if (grant.revokedAt) return id;
  await commit(db, [
    db.update(grants).set({ revokedAt: now, updatedAt: now }).where(eq(grants.id, id)),
    ...audit(
      db,
      [event(ctx, "grant.revoke", "grant", id, { action: grant.action, resource: grant.resource })],
      now,
    ),
  ]);
  return id;
}

/**
 * Uses a permission now if the member has it (recording the use, or using up a one-time
 * approval) and says so; never throws for a missing permission. Runners call this before
 * each tool call that needs one.
 */
export async function usePermission(
  ctx: Ctx,
  action: string,
  resource: string | null,
): Promise<Permission> {
  const { db, now } = ctx;
  const permission = await checkPermission(db, ctx.actorId, action, resource);
  if (!permission.allowed || permission.via === "owner") return permission;
  const ops = await authorize(ctx, action, resource);
  await commit(db, [
    ...ops,
    ...audit(
      db,
      [
        event(ctx, "permission.use", "user", ctx.actorId, {
          action,
          resource,
          via: permission.via,
        }),
      ],
      now,
    ),
  ]);
  return permission;
}
