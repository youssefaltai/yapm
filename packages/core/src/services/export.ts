import * as schema from "@life-os/schema";
import { eq } from "drizzle-orm";
import type { SQLiteTable } from "drizzle-orm/sqlite-core";
import type { HubDb } from "../db.js";
import { forbidden } from "../errors.js";

// Everything the company knows, as JSON the owner can keep or move. Secrets stay out:
// sign-in credentials, sessions, API tokens, push keys and machine secrets.

const TABLES: Record<string, SQLiteTable> = {
  organization: schema.workspaces,
  users: schema.users,
  teams: schema.teams,
  teamMemberships: schema.teamMemberships,
  workflowStates: schema.workflowStates,
  labels: schema.labels,
  issues: schema.issues,
  issueLabels: schema.issueLabels,
  issueRelations: schema.issueRelations,
  comments: schema.comments,
  reactions: schema.reactions,
  issueSubscriptions: schema.issueSubscriptions,
  projects: schema.projects,
  projectTeams: schema.projectTeams,
  projectMilestones: schema.projectMilestones,
  projectUpdates: schema.projectUpdates,
  initiatives: schema.initiatives,
  documents: schema.documents,
  cycles: schema.cycles,
  customViews: schema.customViews,
  templates: schema.templates,
  requests: schema.requests,
  grants: schema.grants,
  notifications: schema.notifications,
  machines: schema.machines,
  mcpServers: schema.mcpServers,
  runs: schema.runs,
  feedback: schema.feedback,
  revisions: schema.revisions,
  metricSnapshots: schema.metricSnapshots,
  auditEvents: schema.auditEvents,
};

/** Columns that would let someone act as the company. */
const SECRET_COLUMNS: Record<string, string[]> = {
  machines: ["tokenHash", "pairingCode"],
  mcpServers: ["authState", "authCode"],
};

export async function exportCompany(db: HubDb, actorId: string, at: number) {
  const actor = await db.select().from(schema.users).where(eq(schema.users.id, actorId)).get();
  if (actor?.kind !== "owner") throw forbidden("Only the owner can export the company");
  const entries = await Promise.all(
    Object.entries(TABLES).map(async ([name, table]) => {
      const rows = (await db.select().from(table).all()) as Record<string, unknown>[];
      const hidden = SECRET_COLUMNS[name] ?? [];
      return [
        name,
        hidden.length
          ? rows.map((row) =>
              Object.fromEntries(Object.entries(row).filter(([k]) => !hidden.includes(k))),
            )
          : rows,
      ] as const;
    }),
  );
  return {
    format: "life-os-export",
    version: 1,
    exportedAt: new Date(at).toISOString(),
    ...Object.fromEntries(entries),
  };
}

const csvCell = (value: unknown) => {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

/** Issues as CSV with Linear's export columns, for spreadsheets and other trackers. */
export async function exportIssuesCsv(db: HubDb, actorId: string) {
  const actor = await db.select().from(schema.users).where(eq(schema.users.id, actorId)).get();
  if (actor?.kind !== "owner") throw forbidden("Only the owner can export the company");
  const [issueRows, teamRows, stateRows, userRows, projectRows, labelRows, links] =
    await Promise.all([
      db.select().from(schema.issues).all(),
      db.select().from(schema.teams).all(),
      db.select().from(schema.workflowStates).all(),
      db.select().from(schema.users).all(),
      db.select().from(schema.projects).all(),
      db.select().from(schema.labels).all(),
      db.select().from(schema.issueLabels).all(),
    ]);
  const by = <T extends { id: string }>(rows: T[]) => new Map(rows.map((r) => [r.id, r]));
  const teamsById = by(teamRows);
  const statesById = by(stateRows);
  const usersById = by(userRows);
  const projectsById = by(projectRows);
  const labelsById = by(labelRows);
  const iso = (ms: number | null) => (ms ? new Date(ms).toISOString() : "");
  const header = [
    "ID",
    "Team",
    "Title",
    "Description",
    "Status",
    "Estimate",
    "Priority",
    "Project",
    "Labels",
    "Assignee",
    "Creator",
    "Due Date",
    "Created",
    "Updated",
    "Started",
    "Completed",
    "Canceled",
    "Archived",
    "Parent issue",
  ];
  const identifier = new Map(
    issueRows.map((i) => [i.id, `${teamsById.get(i.teamId)?.key ?? "?"}-${i.number}`]),
  );
  const lines = issueRows
    .sort((a, b) => a.createdAt - b.createdAt)
    .map((i) =>
      [
        identifier.get(i.id),
        teamsById.get(i.teamId)?.name,
        i.title,
        i.description,
        statesById.get(i.stateId)?.name,
        i.estimate,
        ["No priority", "Urgent", "High", "Medium", "Low"][i.priority],
        i.projectId ? projectsById.get(i.projectId)?.name : "",
        links
          .filter((l) => l.issueId === i.id)
          .map((l) => labelsById.get(l.labelId)?.name)
          .filter(Boolean)
          .join(", "),
        i.assigneeId ? usersById.get(i.assigneeId)?.name : "",
        i.creatorId ? usersById.get(i.creatorId)?.name : "",
        i.dueDate,
        iso(i.createdAt),
        iso(i.updatedAt),
        iso(i.startedAt),
        iso(i.completedAt),
        iso(i.canceledAt),
        iso(i.archivedAt),
        i.parentId ? identifier.get(i.parentId) : "",
      ]
        .map(csvCell)
        .join(","),
    );
  return `${[header.join(","), ...lines].join("\r\n")}\r\n`;
}
