import { sql } from "drizzle-orm";
import {
  index,
  integer,
  primaryKey,
  real,
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

/** Linear's priorities: 0 none, 1 urgent, 2 high, 3 medium, 4 low. */
export const PRIORITY_LABELS = ["No priority", "Urgent", "High", "Medium", "Low"] as const;

/** The unit of work. Identifiers like `FIN-42` are the team key plus `number`. */
export const issues = sqliteTable(
  "issues",
  {
    id: text("id").primaryKey(),
    teamId: text("team_id").notNull(),
    number: integer("number").notNull(),
    title: text("title").notNull(),
    /** Markdown. */
    description: text("description"),
    stateId: text("state_id").notNull(),
    priority: integer("priority").notNull().default(0),
    estimate: integer("estimate"),
    assigneeId: text("assignee_id"),
    creatorId: text("creator_id"),
    parentId: text("parent_id"),
    /** ISO date, e.g. `2026-10-31`. */
    dueDate: text("due_date"),
    /** Manual order within a list or board column; lower comes first. */
    sortOrder: real("sort_order").notNull(),
    startedAt: integer("started_at", { mode: "number" }),
    completedAt: integer("completed_at", { mode: "number" }),
    canceledAt: integer("canceled_at", { mode: "number" }),
    archivedAt: integer("archived_at", { mode: "number" }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("issues_team_number_idx").on(t.teamId, t.number),
    index("issues_state_idx").on(t.stateId),
    index("issues_assignee_idx").on(t.assigneeId),
    index("issues_parent_idx").on(t.parentId),
    index("issues_updated_idx").on(t.updatedAt),
  ],
);

export const issueLabels = sqliteTable(
  "issue_labels",
  {
    issueId: text("issue_id").notNull(),
    labelId: text("label_id").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.issueId, t.labelId] }),
    index("issue_labels_label_idx").on(t.labelId),
  ],
);

export const ISSUE_RELATION_TYPES = ["blocks", "duplicate", "related"] as const;
export type IssueRelationType = (typeof ISSUE_RELATION_TYPES)[number];

/** `issueId` blocks / duplicates / relates to `relatedIssueId`. */
export const issueRelations = sqliteTable(
  "issue_relations",
  {
    id: text("id").primaryKey(),
    type: text("type", { enum: ISSUE_RELATION_TYPES }).notNull(),
    issueId: text("issue_id").notNull(),
    relatedIssueId: text("related_issue_id").notNull(),
    createdAt: integer("created_at", { mode: "number" }).notNull(),
  },
  (t) => [
    uniqueIndex("issue_relations_pair_idx").on(t.issueId, t.relatedIssueId, t.type),
    index("issue_relations_related_idx").on(t.relatedIssueId),
  ],
);

/** Comments on issues, threaded one level deep like Linear. */
export const comments = sqliteTable(
  "comments",
  {
    id: text("id").primaryKey(),
    issueId: text("issue_id").notNull(),
    userId: text("user_id").notNull(),
    parentId: text("parent_id"),
    /** Markdown. */
    body: text("body").notNull(),
    editedAt: integer("edited_at", { mode: "number" }),
    ...timestamps,
  },
  (t) => [index("comments_issue_idx").on(t.issueId, t.createdAt)],
);

/** Emoji reactions on comments or issues. */
export const reactions = sqliteTable(
  "reactions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    emoji: text("emoji").notNull(),
    commentId: text("comment_id"),
    issueId: text("issue_id"),
    createdAt: integer("created_at", { mode: "number" }).notNull(),
  },
  (t) => [
    index("reactions_comment_idx").on(t.commentId),
    index("reactions_issue_idx").on(t.issueId),
    index("reactions_user_idx").on(t.userId),
  ],
);

export const REQUEST_STATUSES = ["pending", "approved", "rejected", "canceled"] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];

/**
 * An agent asking for something it isn't allowed to do yet. Approving it once lets the
 * requester do it one time; "always allow" also creates a grant.
 */
export const requests = sqliteTable(
  "requests",
  {
    id: text("id").primaryKey(),
    requesterId: text("requester_id").notNull(),
    /** What is asked, in a few words, e.g. "Hire a Head of Fitness". Shown in notifications. */
    title: text("title").notNull(),
    /** The permission it needs, e.g. `agent.hire` or `tool:Bash`. */
    action: text("action").notNull(),
    /** What the action applies to, e.g. a team id or a command; null means unspecific. */
    resource: text("resource"),
    reason: text("reason").notNull(),
    /** Markdown: the exact action, so the owner sees what they approve. */
    details: text("details"),
    issueId: text("issue_id"),
    runId: text("run_id"),
    status: text("status", { enum: REQUEST_STATUSES }).notNull().default("pending"),
    answeredById: text("answered_by_id"),
    answeredAt: integer("answered_at", { mode: "number" }),
    /** The rejection reason, or a note with the approval. */
    answer: text("answer"),
    /** The standing grant an "always allow" created. */
    grantId: text("grant_id"),
    /** When a one-time approval was used up. */
    consumedAt: integer("consumed_at", { mode: "number" }),
    ...timestamps,
  },
  (t) => [
    index("requests_status_idx").on(t.status, t.createdAt),
    index("requests_requester_idx").on(t.requesterId, t.action),
    index("requests_issue_idx").on(t.issueId),
  ],
);

export const GRANT_SCOPES = ["user", "team", "everyone"] as const;
export type GrantScope = (typeof GRANT_SCOPES)[number];

/** A standing permission: who (one agent, a team, everyone) may do which action, on what. */
export const grants = sqliteTable(
  "grants",
  {
    id: text("id").primaryKey(),
    action: text("action").notNull(),
    /** Null allows the action on anything. */
    resource: text("resource"),
    scope: text("scope", { enum: GRANT_SCOPES }).notNull(),
    /** The user or team id the grant is for; null when the scope is everyone. */
    subjectId: text("subject_id"),
    note: text("note"),
    createdById: text("created_by_id").notNull(),
    requestId: text("request_id"),
    useCount: integer("use_count").notNull().default(0),
    lastUsedAt: integer("last_used_at", { mode: "number" }),
    revokedAt: integer("revoked_at", { mode: "number" }),
    ...timestamps,
  },
  (t) => [index("grants_action_idx").on(t.action)],
);

export const NOTIFICATION_TYPES = [
  "issueAssignedToYou",
  "issueUnassignedFromYou",
  "issueMention",
  "issueCommentMention",
  "issueNewComment",
  "issueStatusChanged",
  "requestCreated",
  "requestAnswered",
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

/** A member's Inbox, like Linear's notifications. Agents get them too; they're how agents wake up. */
export const notifications = sqliteTable(
  "notifications",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    type: text("type", { enum: NOTIFICATION_TYPES }).notNull(),
    actorId: text("actor_id"),
    issueId: text("issue_id"),
    commentId: text("comment_id"),
    requestId: text("request_id"),
    /** Details for the line in the Inbox, e.g. `{ from, to }` for a status change. */
    data: text("data", { mode: "json" }).$type<Record<string, unknown>>(),
    readAt: integer("read_at", { mode: "number" }),
    snoozedUntilAt: integer("snoozed_until_at", { mode: "number" }),
    archivedAt: integer("archived_at", { mode: "number" }),
    ...timestamps,
  },
  (t) => [index("notifications_user_idx").on(t.userId, t.createdAt)],
);

/** Who follows an issue: they're notified of its comments and status changes. */
export const issueSubscriptions = sqliteTable(
  "issue_subscriptions",
  {
    issueId: text("issue_id").notNull(),
    userId: text("user_id").notNull(),
    createdAt: integer("created_at", { mode: "number" }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.issueId, t.userId] }),
    index("issue_subscriptions_user_idx").on(t.userId),
  ],
);
