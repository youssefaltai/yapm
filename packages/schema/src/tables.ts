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
  /** IANA time zone for cycles, recurring issues and "today", e.g. `Europe/Berlin`. */
  timezone: text("timezone").notNull().default("UTC"),
  /** How the company works, in markdown: every agent reads it. Starts empty. */
  handbook: text("handbook"),
  /**
   * How runs pick a model and effort: each tier's pinned model and effort, and labels that
   * route an issue to a tier. Null means the hub's defaults (`DEFAULT_ROUTING` in core).
   */
  modelRouting: text("model_routing", { mode: "json" }).$type<ModelRouting>(),
  ...timestamps,
});

export const MODEL_TIERS = ["small", "standard", "top"] as const;
export type ModelTier = (typeof MODEL_TIERS)[number];
export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORTS)[number];

export interface ModelRouting {
  tiers: Record<ModelTier, { model: string; effort: Effort }>;
  /** Issue label name (lowercase) to the tier its work runs on. */
  labels: Record<string, ModelTier>;
}

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
    /** What the agent has learned, in its own words: it reads them on every run. */
    lessons: text("lessons"),
    /** Machines must have all of these tags to run this agent, e.g. `["employer-a"]`. */
    runnerTags: text("runner_tags", { mode: "json" }).$type<string[]>(),
    /** The cheapest and dearest tiers this agent's work runs may use. */
    modelFloor: text("model_floor", { enum: MODEL_TIERS }).notNull().default("small"),
    modelCeiling: text("model_ceiling", { enum: MODEL_TIERS }).notNull().default("top"),
    /** Top-tier work runs allowed in any 7 days; more drop to standard. */
    topRunsPerWeek: integer("top_runs_per_week").notNull().default(3),
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
  /** New issues from agents wait in Triage for the owner to accept or decline. */
  triageEnabled: integer("triage_enabled", { mode: "boolean" }).notNull().default(false),
  cyclesEnabled: integer("cycles_enabled", { mode: "boolean" }).notNull().default(false),
  /** Weeks per cycle. */
  cycleDuration: integer("cycle_duration").notNull().default(1),
  /** Day cycles start on: 0 Sunday … 6 Saturday. */
  cycleStartDay: integer("cycle_start_day").notNull().default(1),
  /** Weeks of rest between cycles. */
  cycleCooldown: integer("cycle_cooldown").notNull().default(0),
  /** How many future cycles to keep ready. */
  upcomingCycleCount: integer("upcoming_cycle_count").notNull().default(2),
  /** Last cycle number handed out. */
  cycleCount: integer("cycle_count").notNull().default(0),
  /** Hours to finish an issue, by priority (`"1"` urgent … `"4"` low); none means no SLA. */
  slaHours: text("sla_hours", { mode: "json" }).$type<Record<string, number>>(),
  /** Months after which done and canceled issues are archived; 0 never. */
  autoArchivePeriod: integer("auto_archive_period").notNull().default(6),
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
    /** Tokens minted for one run stop working when it ends, or at this time at the latest. */
    expiresAt: integer("expires_at", { mode: "number" }),
    runId: text("run_id"),
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
    projectId: text("project_id"),
    projectMilestoneId: text("project_milestone_id"),
    cycleId: text("cycle_id"),
    slaStartedAt: integer("sla_started_at", { mode: "number" }),
    slaBreachesAt: integer("sla_breaches_at", { mode: "number" }),
    /** When the breach was announced, so it's announced once. */
    slaBreachedAt: integer("sla_breached_at", { mode: "number" }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("issues_team_number_idx").on(t.teamId, t.number),
    index("issues_cycle_idx").on(t.cycleId),
    index("issues_sla_idx").on(t.slaBreachesAt),
    index("issues_project_idx").on(t.projectId),
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
  "projectUpdateCreated",
  "issueSlaBreached",
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
    projectId: text("project_id"),
    projectUpdateId: text("project_update_id"),
    /** Details for the line in the Inbox, e.g. `{ from, to }` for a status change. */
    data: text("data", { mode: "json" }).$type<Record<string, unknown>>(),
    readAt: integer("read_at", { mode: "number" }),
    snoozedUntilAt: integer("snoozed_until_at", { mode: "number" }),
    archivedAt: integer("archived_at", { mode: "number" }),
    /** When it was sent as a push notification, if the member has push turned on. */
    pushedAt: integer("pushed_at", { mode: "number" }),
    /** When the dispatcher considered waking the (agent) recipient for it. */
    dispatchedAt: integer("dispatched_at", { mode: "number" }),
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

/** Browsers and phones that receive a member's notifications as Web Push. */
export const pushSubscriptions = sqliteTable(
  "push_subscriptions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    endpoint: text("endpoint").notNull(),
    /** The browser's P-256 public key and auth secret, base64url, for encrypting payloads. */
    p256dh: text("p256dh").notNull(),
    auth: text("auth").notNull(),
    userAgent: text("user_agent"),
    createdAt: integer("created_at", { mode: "number" }).notNull(),
    lastUsedAt: integer("last_used_at", { mode: "number" }),
  },
  (t) => [
    uniqueIndex("push_subscriptions_endpoint_idx").on(t.endpoint),
    index("push_subscriptions_user_idx").on(t.userId),
  ],
);

/** Values the hub generates for itself once, like its Web Push (VAPID) key pair. */
export const hubSettings = sqliteTable("hub_settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  createdAt: integer("created_at", { mode: "number" }).notNull(),
});

export const MACHINE_STATUSES = ["pending", "active", "revoked"] as const;
export type MachineStatus = (typeof MACHINE_STATUSES)[number];

/** A computer running the runner daemon. Enrolled with a pairing code the owner confirms. */
export interface ClaudeAccount {
  email: string | null;
  organization: string | null;
  /** pro, max, team or enterprise; null when the machine signs in with an API key. */
  subscriptionType: string | null;
  /** firstParty for a Claude login; bedrock, vertex and others have no plan limits. */
  apiProvider: string | null;
}

/** One of the plan's usage windows, such as the 5-hour session or the week. */
export interface PlanLimit {
  /** five_hour, seven_day, seven_day_opus, seven_day_sonnet, or `model:<name>`. */
  kind: string;
  label: string;
  /** Percent of the window used, 0–100; null when Claude Code didn't say. */
  utilization: number | null;
  resetsAt: number | null;
  /** allowed, allowed_warning or rejected, when a rate-limit event said so. */
  status: string | null;
}

export interface PlanUsage {
  /** When the machine read these numbers. */
  observedAt: number;
  /** usage: a full reading of /usage; rate_limit: what a run's rate-limit events said. */
  source: "usage" | "rate_limit";
  /** False when plan limits don't apply (an API key, Bedrock or Vertex). */
  available: boolean;
  limits: PlanLimit[];
  extraUsage: {
    enabled: boolean;
    /** Minor units of `currency` (cents for USD). */
    monthlyLimit: number | null;
    usedCredits: number | null;
    utilization: number | null;
    currency: string | null;
  } | null;
}

export interface ReportedUsage {
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
}

export const machines = sqliteTable(
  "machines",
  {
    id: text("id").primaryKey(),
    /** What the machine calls itself when it enrols, e.g. its host name. */
    name: text("name").notNull(),
    /** The owner's name for it, shown instead of `name` when set. */
    displayName: text("display_name"),
    status: text("status", { enum: MACHINE_STATUSES }).notNull().default("pending"),
    /** Shown on the machine and in the app; the owner approves when they match. */
    pairingCode: text("pairing_code").notNull(),
    /** SHA-256 of the machine's secret (`lrn_…`), which only the runner knows. */
    tokenHash: text("token_hash").notNull(),
    tags: text("tags", { mode: "json" }).$type<string[]>().notNull(),
    /** How many runs it takes at once. */
    capacity: integer("capacity").notNull().default(2),
    version: text("version"),
    lastSeenAt: integer("last_seen_at", { mode: "number" }),
    approvedAt: integer("approved_at", { mode: "number" }),
    /** The Claude login agents use on this machine, as Claude Code reports it. */
    claudeAccount: text("claude_account", { mode: "json" }).$type<ClaudeAccount>(),
    /** The subscription's limits as this machine last saw them; see `PlanUsage`. */
    planUsage: text("plan_usage", { mode: "json" }).$type<PlanUsage>(),
    ...timestamps,
  },
  (t) => [uniqueIndex("machines_token_idx").on(t.tokenHash)],
);

/**
 * A one-time setup token the owner creates on the Machines page and pastes into the install
 * command; a runner that enrols with it is approved straight away, without a pairing code.
 */
export const machineSetupTokens = sqliteTable(
  "machine_setup_tokens",
  {
    id: text("id").primaryKey(),
    /** SHA-256 of the token (`lms_…`); the token itself is shown once. */
    tokenHash: text("token_hash").notNull(),
    createdById: text("created_by_id").notNull(),
    expiresAt: integer("expires_at", { mode: "number" }).notNull(),
    /** Set when a machine enrols with it; a token works once. */
    usedAt: integer("used_at", { mode: "number" }),
    machineId: text("machine_id"),
    createdAt: integer("created_at", { mode: "number" }).notNull(),
  },
  (t) => [uniqueIndex("machine_setup_tokens_hash_idx").on(t.tokenHash)],
);

export const RUN_KINDS = ["decision", "work"] as const;
export type RunKind = (typeof RUN_KINDS)[number];
export const RUN_STATUSES = [
  "queued",
  "running",
  "needs_input",
  "completed",
  "failed",
  "stopped",
  "canceled",
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

/**
 * One agent wake on a runner: a short decision ("what, if anything, do I do about this?")
 * or a work session. The hub queues it, a machine claims it and streams its transcript back.
 */
export const runs = sqliteTable(
  "runs",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id").notNull(),
    kind: text("kind", { enum: RUN_KINDS }).notNull(),
    status: text("status", { enum: RUN_STATUSES }).notNull().default("queued"),
    issueId: text("issue_id"),
    /** What woke the agent: notification ids and types, or the decision that started the work. */
    trigger: text("trigger", { mode: "json" }).$type<Record<string, unknown>>(),
    goal: text("goal"),
    /** small, standard or top. */
    modelTier: text("model_tier").notNull().default("standard"),
    /** The pinned model id and effort the hub chose, and the routing rule that chose them. */
    model: text("model"),
    effort: text("effort"),
    routeRule: text("route_rule"),
    /** What the session would cost at API prices, as the Agent SDK reports it. */
    costUsd: real("cost_usd").notNull().default(0),
    /**
     * The usage totals exactly as the SDK reported them. A resumed session reports totals that
     * carry on from the run it resumed, so this run's own usage is the difference.
     */
    reportedUsage: text("reported_usage", { mode: "json" }).$type<ReportedUsage>(),
    /** Not before this time (a `wait_until` decision). */
    notBefore: integer("not_before", { mode: "number" }),
    machineId: text("machine_id"),
    /** The Agent SDK session, to resume on the same machine after needs-input. */
    sessionId: text("session_id"),
    resumeOfRunId: text("resume_of_run_id"),
    result: text("result", { mode: "json" }).$type<Record<string, unknown>>(),
    error: text("error"),
    stopRequestedAt: integer("stop_requested_at", { mode: "number" }),
    stopReason: text("stop_reason"),
    stoppedById: text("stopped_by_id"),
    /** A request for approval the run is waiting on. */
    waitingOnRequestId: text("waiting_on_request_id"),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    numTurns: integer("num_turns").notNull().default(0),
    logCount: integer("log_count").notNull().default(0),
    startedAt: integer("started_at", { mode: "number" }),
    heartbeatAt: integer("heartbeat_at", { mode: "number" }),
    endedAt: integer("ended_at", { mode: "number" }),
    ...timestamps,
  },
  (t) => [
    index("runs_status_idx").on(t.status, t.createdAt),
    index("runs_agent_idx").on(t.agentId, t.createdAt),
    index("runs_issue_idx").on(t.issueId, t.createdAt),
  ],
);

/**
 * A run's transcript, in batches: each row holds the events one upload carried, so a busy
 * run costs a write per batch rather than per message.
 */
export const runLogs = sqliteTable(
  "run_logs",
  {
    id: text("id").primaryKey(),
    runId: text("run_id").notNull(),
    seq: integer("seq").notNull(),
    events: text("events", { mode: "json" }).$type<unknown[]>().notNull(),
    createdAt: integer("created_at", { mode: "number" }).notNull(),
  },
  (t) => [uniqueIndex("run_logs_run_seq_idx").on(t.runId, t.seq)],
);

export const PROJECT_STATES = [
  "backlog",
  "planned",
  "started",
  "paused",
  "completed",
  "canceled",
] as const;
export type ProjectState = (typeof PROJECT_STATES)[number];

/** A body of work with a goal and a date, across teams, like Linear's projects. */
export const projects = sqliteTable(
  "projects",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    /** One line: what the project achieves. */
    summary: text("summary"),
    /** Markdown. */
    description: text("description"),
    icon: text("icon"),
    color: text("color").notNull(),
    state: text("state", { enum: PROJECT_STATES }).notNull().default("planned"),
    leadId: text("lead_id"),
    initiativeId: text("initiative_id"),
    creatorId: text("creator_id"),
    /** ISO dates. */
    startDate: text("start_date"),
    targetDate: text("target_date"),
    sortOrder: real("sort_order").notNull(),
    startedAt: integer("started_at", { mode: "number" }),
    completedAt: integer("completed_at", { mode: "number" }),
    canceledAt: integer("canceled_at", { mode: "number" }),
    archivedAt: integer("archived_at", { mode: "number" }),
    ...timestamps,
  },
  (t) => [index("projects_initiative_idx").on(t.initiativeId)],
);

export const projectTeams = sqliteTable(
  "project_teams",
  {
    projectId: text("project_id").notNull(),
    teamId: text("team_id").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.projectId, t.teamId] }),
    index("project_teams_team_idx").on(t.teamId),
  ],
);

/** Checkpoints inside a project, each with its own target date. */
export const projectMilestones = sqliteTable(
  "project_milestones",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    targetDate: text("target_date"),
    sortOrder: real("sort_order").notNull(),
    ...timestamps,
  },
  (t) => [index("project_milestones_project_idx").on(t.projectId)],
);

export const PROJECT_HEALTHS = ["onTrack", "atRisk", "offTrack"] as const;
export type ProjectHealth = (typeof PROJECT_HEALTHS)[number];

/** A status post on a project: how it's going, in words and a health flag. */
export const projectUpdates = sqliteTable(
  "project_updates",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull(),
    userId: text("user_id").notNull(),
    /** Markdown. */
    body: text("body").notNull(),
    health: text("health", { enum: PROJECT_HEALTHS }).notNull(),
    editedAt: integer("edited_at", { mode: "number" }),
    ...timestamps,
  },
  (t) => [index("project_updates_project_idx").on(t.projectId, t.createdAt)],
);

export const INITIATIVE_STATUSES = ["planned", "active", "completed"] as const;
export type InitiativeStatus = (typeof INITIATIVE_STATUSES)[number];

/** A company-level goal that groups projects, like Linear's initiatives. */
export const initiatives = sqliteTable("initiatives", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  status: text("status", { enum: INITIATIVE_STATUSES }).notNull().default("planned"),
  ownerId: text("owner_id"),
  targetDate: text("target_date"),
  sortOrder: real("sort_order").notNull(),
  archivedAt: integer("archived_at", { mode: "number" }),
  ...timestamps,
});

/** Long-form Markdown pages: specs, plans, briefs. Optionally part of a project. */
export const documents = sqliteTable(
  "documents",
  {
    id: text("id").primaryKey(),
    title: text("title").notNull(),
    /** Markdown. */
    content: text("content").notNull().default(""),
    icon: text("icon"),
    projectId: text("project_id"),
    initiativeId: text("initiative_id"),
    creatorId: text("creator_id"),
    updatedById: text("updated_by_id"),
    archivedAt: integer("archived_at", { mode: "number" }),
    ...timestamps,
  },
  (t) => [
    index("documents_project_idx").on(t.projectId),
    index("documents_updated_idx").on(t.updatedAt),
  ],
);

/** A team's time-boxed sprint, like Linear's cycles. Created and closed by the scheduler. */
export const cycles = sqliteTable(
  "cycles",
  {
    id: text("id").primaryKey(),
    teamId: text("team_id").notNull(),
    number: integer("number").notNull(),
    name: text("name"),
    startsAt: integer("starts_at", { mode: "number" }).notNull(),
    endsAt: integer("ends_at", { mode: "number" }).notNull(),
    completedAt: integer("completed_at", { mode: "number" }),
    /** Daily issue counts since the start, for the burn-up chart. */
    history: text("history", { mode: "json" })
      .$type<{ scope: number[]; completed: number[] }>()
      .notNull(),
    /** Issues still open when it closed (they move to the next cycle). */
    uncompletedCount: integer("uncompleted_count"),
    ...timestamps,
  },
  (t) => [uniqueIndex("cycles_team_number_idx").on(t.teamId, t.number)],
);

/** A saved filter over issues, like Linear's custom views. */
export const customViews = sqliteTable("custom_views", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  icon: text("icon"),
  color: text("color"),
  /** An IssueFilter, as the API takes it. */
  filterData: text("filter_data", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
  teamId: text("team_id"),
  ownerId: text("owner_id").notNull(),
  /** Visible to every member, not only its owner. */
  shared: integer("shared", { mode: "boolean" }).notNull().default(true),
  sortOrder: real("sort_order").notNull(),
  ...timestamps,
});

/** When something repeats, in the company's time zone. */
export interface Schedule {
  frequency: "daily" | "weekdays" | "weekly" | "monthly";
  /** Local time, `HH:MM`. */
  time: string;
  /** For weekly: 0 Sunday … 6 Saturday. */
  weekday?: number;
  /** For monthly: 1–31 (short months use their last day). */
  monthDay?: number;
}

/** Issue templates, like Linear's; with a schedule they create recurring issues. */
export const templates = sqliteTable(
  "templates",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    description: text("description"),
    type: text("type", { enum: ["issue"] })
      .notNull()
      .default("issue"),
    teamId: text("team_id").notNull(),
    /** Issue fields: title, description, priority, estimate, assigneeId, labelIds, projectId, stateId. */
    templateData: text("template_data", { mode: "json" })
      .$type<Record<string, unknown>>()
      .notNull(),
    schedule: text("schedule", { mode: "json" }).$type<Schedule>(),
    nextRunAt: integer("next_run_at", { mode: "number" }),
    lastRunAt: integer("last_run_at", { mode: "number" }),
    creatorId: text("creator_id"),
    ...timestamps,
  },
  (t) => [index("templates_team_idx").on(t.teamId), index("templates_next_idx").on(t.nextRunAt)],
);

export const FEEDBACK_KINDS = ["stop", "rejection", "note"] as const;
export type FeedbackKind = (typeof FEEDBACK_KINDS)[number];

/**
 * What an agent should learn from: why the owner stopped a run, why a request was rejected,
 * or a note. Retros read the open ones and mark them addressed with what changed.
 */
export const feedback = sqliteTable(
  "feedback",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id").notNull(),
    kind: text("kind", { enum: FEEDBACK_KINDS }).notNull(),
    body: text("body").notNull(),
    authorId: text("author_id"),
    runId: text("run_id"),
    issueId: text("issue_id"),
    requestId: text("request_id"),
    addressedAt: integer("addressed_at", { mode: "number" }),
    addressedById: text("addressed_by_id"),
    /** What changed because of it, e.g. "Added a lesson about receipts". */
    addressedNote: text("addressed_note"),
    createdAt: integer("created_at", { mode: "number" }).notNull(),
  },
  (t) => [index("feedback_agent_idx").on(t.agentId, t.createdAt)],
);

export const REVISION_SUBJECTS = ["charter", "lessons", "handbook"] as const;
export type RevisionSubject = (typeof REVISION_SUBJECTS)[number];

/** Every version of a charter, an agent's lessons and the handbook, with who changed it and why. */
export const revisions = sqliteTable(
  "revisions",
  {
    id: text("id").primaryKey(),
    subject: text("subject", { enum: REVISION_SUBJECTS }).notNull(),
    /** The agent for charters and lessons; the workspace for the handbook. */
    entityId: text("entity_id").notNull(),
    content: text("content").notNull(),
    authorId: text("author_id"),
    runId: text("run_id"),
    reason: text("reason"),
    createdAt: integer("created_at", { mode: "number" }).notNull(),
  },
  (t) => [index("revisions_entity_idx").on(t.subject, t.entityId, t.createdAt)],
);

export const METRIC_SCOPES = ["company", "team", "user"] as const;
export type MetricScope = (typeof METRIC_SCOPES)[number];

/**
 * One local day's raw counts for the company, a team or a member, taken by the scheduler
 * after the day ends. Raw counts add up over any range, so trends and rates come from sums.
 */
export const metricSnapshots = sqliteTable(
  "metric_snapshots",
  {
    id: text("id").primaryKey(),
    /** The company's local date, YYYY-MM-DD. */
    date: text("date").notNull(),
    scope: text("scope", { enum: METRIC_SCOPES }).notNull(),
    /** The team or member; empty for the company. */
    scopeId: text("scope_id").notNull().default(""),
    counts: text("counts", { mode: "json" }).$type<Record<string, number>>().notNull(),
    createdAt: integer("created_at", { mode: "number" }).notNull(),
  },
  (t) => [uniqueIndex("metric_snapshots_day_idx").on(t.scope, t.scopeId, t.date)],
);
