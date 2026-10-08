import { sql } from "drizzle-orm";
import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

// Timestamps are Unix epoch milliseconds stored as integers.
const timestamps = {
  createdAt: integer("created_at", { mode: "number" }).notNull(),
  updatedAt: integer("updated_at", { mode: "number" }).notNull(),
};

/** The single company this deployment runs. */
export const workspaces = sqliteTable("workspaces", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  urlKey: text("url_key").notNull().unique(),
  ...timestamps,
});

export const USER_KINDS = ["owner", "agent"] as const;
export type UserKind = (typeof USER_KINDS)[number];

/** Members of the company: the one human owner and every AI agent employee. */
export const users = sqliteTable(
  "users",
  {
    id: text("id").primaryKey(),
    kind: text("kind", { enum: USER_KINDS }).notNull(),
    name: text("name").notNull(),
    displayName: text("display_name").notNull(),
    email: text("email"),
    title: text("title"),
    avatarUrl: text("avatar_url"),
    managerId: text("manager_id"),
    /** An agent's job description: responsibilities, ownership, when to escalate. */
    charter: text("charter"),
    active: integer("active", { mode: "boolean" }).notNull().default(true),
    ...timestamps,
  },
  (t) => [
    index("users_manager_idx").on(t.managerId),
    // A company has exactly one owner.
    uniqueIndex("users_single_owner_idx").on(t.kind).where(sql`kind = 'owner'`),
  ],
);

/** A unit of the business, like Linear's teams. */
export const teams = sqliteTable("teams", {
  id: text("id").primaryKey(),
  key: text("key").notNull().unique(),
  name: text("name").notNull(),
  description: text("description"),
  icon: text("icon"),
  color: text("color"),
  leadId: text("lead_id"),
  /** Last issue number handed out in this team, for identifiers like FIN-42. */
  issueCount: integer("issue_count").notNull().default(0),
  archivedAt: integer("archived_at", { mode: "number" }),
  ...timestamps,
});

export const teamMemberships = sqliteTable(
  "team_memberships",
  {
    teamId: text("team_id").notNull(),
    userId: text("user_id").notNull(),
    createdAt: integer("created_at", { mode: "number" }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.teamId, t.userId] }),
    index("team_memberships_user_idx").on(t.userId),
  ],
);

export const WORKFLOW_STATE_TYPES = [
  "triage",
  "backlog",
  "unstarted",
  "started",
  "completed",
  "canceled",
] as const;
export type WorkflowStateType = (typeof WORKFLOW_STATE_TYPES)[number];

/** Per-team issue statuses, grouped into Linear's state categories. */
export const workflowStates = sqliteTable(
  "workflow_states",
  {
    id: text("id").primaryKey(),
    teamId: text("team_id").notNull(),
    name: text("name").notNull(),
    type: text("type", { enum: WORKFLOW_STATE_TYPES }).notNull(),
    color: text("color").notNull(),
    description: text("description"),
    position: integer("position").notNull(),
    ...timestamps,
  },
  (t) => [index("workflow_states_team_idx").on(t.teamId)],
);

/** Issue labels; a null team means a workspace-wide label. */
export const labels = sqliteTable(
  "labels",
  {
    id: text("id").primaryKey(),
    teamId: text("team_id"),
    name: text("name").notNull(),
    color: text("color").notNull(),
    description: text("description"),
    ...timestamps,
  },
  (t) => [index("labels_team_idx").on(t.teamId)],
);

/**
 * Append-only record of every change anyone makes, human or agent.
 * Agents read it to explain what happened and why; the metrics engine computes from it.
 */
export const auditEvents = sqliteTable(
  "audit_events",
  {
    id: text("id").primaryKey(),
    actorId: text("actor_id"),
    /** Agent run that made the change, once runs exist. */
    runId: text("run_id"),
    action: text("action").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    /** JSON object describing the change. */
    data: text("data", { mode: "json" }).$type<Record<string, unknown>>(),
    reason: text("reason"),
    createdAt: integer("created_at", { mode: "number" }).notNull(),
  },
  (t) => [
    index("audit_events_entity_idx").on(t.entityType, t.entityId),
    index("audit_events_actor_idx").on(t.actorId),
    index("audit_events_created_idx").on(t.createdAt),
  ],
);

/** WebAuthn credentials for the owner. */
export const passkeys = sqliteTable(
  "passkeys",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    publicKey: text("public_key").notNull(),
    counter: integer("counter").notNull(),
    transports: text("transports", { mode: "json" }).$type<string[]>(),
    name: text("name"),
    createdAt: integer("created_at", { mode: "number" }).notNull(),
    lastUsedAt: integer("last_used_at", { mode: "number" }),
  },
  (t) => [index("passkeys_user_idx").on(t.userId)],
);

/** Single-use WebAuthn challenges, kept server-side so any instance can verify them. */
export const authChallenges = sqliteTable("auth_challenges", {
  id: text("id").primaryKey(),
  challenge: text("challenge").notNull(),
  kind: text("kind", { enum: ["setup", "login"] }).notNull(),
  /** For setup: the pending owner id and the company details to create. */
  payload: text("payload", { mode: "json" }).$type<Record<string, string>>(),
  expiresAt: integer("expires_at", { mode: "number" }).notNull(),
});

/** Browser sessions. The id is the SHA-256 of the cookie token, never the token itself. */
export const sessions = sqliteTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    createdAt: integer("created_at", { mode: "number" }).notNull(),
    expiresAt: integer("expires_at", { mode: "number" }).notNull(),
  },
  (t) => [index("sessions_user_idx").on(t.userId)],
);

/** Bearer tokens for agents, runners and scripts. Only the SHA-256 hash is stored. */
export const apiTokens = sqliteTable(
  "api_tokens",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    name: text("name").notNull(),
    tokenHash: text("token_hash").notNull(),
    /** First characters of the token, shown in the UI to tell tokens apart. */
    prefix: text("prefix").notNull(),
    createdAt: integer("created_at", { mode: "number" }).notNull(),
    lastUsedAt: integer("last_used_at", { mode: "number" }),
    revokedAt: integer("revoked_at", { mode: "number" }),
  },
  (t) => [
    uniqueIndex("api_tokens_hash_idx").on(t.tokenHash),
    index("api_tokens_user_idx").on(t.userId),
  ],
);
