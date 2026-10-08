import {
  labels,
  teamMemberships,
  teams,
  users,
  type WorkflowStateType,
  workflowStates,
  workspaces,
} from "@life-os/schema";
import { type AuditInput, audit } from "./audit.js";
import { newId } from "./crypto.js";
import type { HubDb, WriteOp } from "./db.js";
import { insertRows } from "./write.js";

/** Linear's default workflow, plus Triage. */
export const DEFAULT_STATES: { name: string; type: WorkflowStateType; color: string }[] = [
  { name: "Triage", type: "triage", color: "#fc7840" },
  { name: "Backlog", type: "backlog", color: "#bec2c8" },
  { name: "Todo", type: "unstarted", color: "#e2e2e2" },
  { name: "In Progress", type: "started", color: "#f2c94c" },
  { name: "In Review", type: "started", color: "#0f973d" },
  { name: "Done", type: "completed", color: "#5e6ad2" },
  { name: "Canceled", type: "canceled", color: "#95a2b3" },
  { name: "Duplicate", type: "canceled", color: "#95a2b3" },
];

export const DEFAULT_TEAMS = [
  {
    key: "OPS",
    name: "Operations",
    description: "Runs the company: triage, routing, rituals and anything without a home yet.",
  },
  {
    key: "HLT",
    name: "Health",
    description: "Physical and mental health, fitness, sleep, appointments.",
  },
  {
    key: "FIN",
    name: "Finance",
    description: "Money in and out, budgets, taxes, savings and investments.",
  },
  {
    key: "CAR",
    name: "Career",
    description: "Jobs, employers, professional growth and side projects.",
  },
  { key: "HOM", name: "Home", description: "Housing, maintenance, errands, logistics and admin." },
  {
    key: "REL",
    name: "Relationships",
    description: "Family, friends, partner, and keeping in touch.",
  },
  { key: "LRN", name: "Learning", description: "Courses, books, research and new skills." },
] as const;

export const DEFAULT_LABELS = [
  { name: "Research", color: "#4ea7fc" },
  { name: "Errand", color: "#26b5ce" },
  { name: "Decision", color: "#f2994a" },
  { name: "Admin", color: "#bec2c8" },
  { name: "Follow-up", color: "#bb87fc" },
];

const CEO_CHARTER = `You are the CEO of this company. The owner is the only human and your sole stakeholder.

Responsibilities:
- Turn the owner's goals into projects and issues, and make sure every unit has clear owners.
- Design the organization: create and dissolve teams, hire and retire agents, and write their charters.
- Send the owner a morning brief: what was done yesterday, what is planned today, and what the company is blocked on.
- Review metrics and feedback, and lead the company's self-improvement.
- Pre-screen requests for approval and forward only what needs the owner, with a recommendation.

Escalate to the owner when a decision spends money, contacts a real person, cannot be undone, or changes the company's direction.`;

const CHIEF_OF_STAFF_CHARTER = `You are the Chief of Staff and lead the Operations team.

Responsibilities:
- Triage everything that lands in Operations and route it to the right team and assignee.
- Keep issues tidy: correct status, priority, labels, estimates and relations.
- Run the company's rituals on schedule and chase anything stale or blocked.

Escalate to the CEO when no team fits the work or when priorities conflict.`;

export interface SeedInput {
  ownerId: string;
  ownerName: string;
  companyName: string;
  now: number;
}

/** Statements that create a new company: workspace, owner, leadership agents, teams, states, labels. */
export function seedCompany(db: HubDb, input: SeedInput): WriteOp[] {
  const { ownerId, now } = input;
  const stamp = { createdAt: now, updatedAt: now };
  const workspaceId = newId();
  const ceoId = newId();
  const chiefOfStaffId = newId();
  const auditInputs: AuditInput[] = [];

  const workspaceRows = [
    {
      id: workspaceId,
      name: input.companyName,
      urlKey: slugify(input.companyName) || "company",
      ...stamp,
    },
  ];
  auditInputs.push({
    actorId: ownerId,
    action: "workspace.create",
    entityType: "workspace",
    entityId: workspaceId,
    data: { name: input.companyName },
  });

  const userRows: (typeof users.$inferInsert)[] = [
    {
      id: ownerId,
      kind: "owner",
      name: input.ownerName,
      displayName: input.ownerName,
      title: "Owner",
      ...stamp,
    },
    {
      id: ceoId,
      kind: "agent",
      name: "CEO",
      displayName: "CEO",
      title: "Chief Executive Officer",
      managerId: ownerId,
      charter: CEO_CHARTER,
      ...stamp,
    },
    {
      id: chiefOfStaffId,
      kind: "agent",
      name: "Chief of Staff",
      displayName: "Chief of Staff",
      title: "Chief of Staff",
      managerId: ceoId,
      charter: CHIEF_OF_STAFF_CHARTER,
      ...stamp,
    },
  ];
  for (const user of userRows) {
    auditInputs.push({
      actorId: ownerId,
      action: "user.create",
      entityType: "user",
      entityId: user.id,
      data: { kind: user.kind, title: user.title, managerId: user.managerId ?? null },
      ...(user.kind === "agent" ? { reason: "Founding leadership created with the company" } : {}),
    });
  }

  const teamRows: (typeof teams.$inferInsert)[] = [];
  const membershipRows: (typeof teamMemberships.$inferInsert)[] = [];
  const stateRows: (typeof workflowStates.$inferInsert)[] = [];
  for (const team of DEFAULT_TEAMS) {
    const teamId = newId();
    const leadId = team.key === "OPS" ? chiefOfStaffId : ceoId;
    teamRows.push({ id: teamId, ...team, leadId, ...stamp });
    auditInputs.push({
      actorId: ownerId,
      action: "team.create",
      entityType: "team",
      entityId: teamId,
      data: { key: team.key, name: team.name, leadId },
    });
    for (const userId of new Set([ownerId, ceoId, leadId])) {
      membershipRows.push({ teamId, userId, createdAt: now });
    }
    DEFAULT_STATES.forEach((state, position) => {
      stateRows.push({ id: newId(), teamId, ...state, position, ...stamp });
    });
  }

  const labelRows = DEFAULT_LABELS.map((label) => ({
    id: newId(),
    teamId: null,
    ...label,
    ...stamp,
  }));

  return [
    ...insertRows(db, workspaces, workspaceRows),
    ...insertRows(db, users, userRows),
    ...insertRows(db, teams, teamRows),
    ...insertRows(db, teamMemberships, membershipRows),
    ...insertRows(db, workflowStates, stateRows),
    ...insertRows(db, labels, labelRows),
    ...audit(db, auditInputs, now),
  ];
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
}
