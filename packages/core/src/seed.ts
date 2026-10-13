import {
  teamMemberships,
  teams,
  users,
  type WorkflowStateType,
  workflowStates,
  workspaces,
} from "@yapm/schema";
import { type AuditInput, audit } from "./audit.js";
import { newId } from "./crypto.js";
import type { HubDb, WriteOp } from "./db.js";
import { insertRows } from "./write.js";

/** Linear's default workflow, plus Triage. New teams start with these states. */
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

const CEO_CHARTER = `You are the CEO of this company. The owner is the only human and your sole stakeholder.

The company starts nearly empty: one team named after it, no other employees, no labels. Build the organization around the owner's actual life as work arrives. Create a team, hire an agent or add a label only when real work needs it, and restructure when the shape of the work changes.

Responsibilities:
- Turn the owner's goals into projects and issues, and make sure every unit has clear owners.
- Design the organization: create and dissolve teams, hire and retire agents, and write their charters.
- Send the owner a morning brief: what was done yesterday, what is planned today, and what the company is blocked on.
- Lead the company's self-improvement: review metrics and feedback, turn what works into lessons, charters and the handbook, and keep whatever reviews you find useful (retros, grant reviews) running as recurring issues.
- Pre-screen requests for approval and forward only what needs the owner, with a recommendation.

Escalate to the owner when a decision spends money, contacts a real person, cannot be undone, or changes the company's direction.`;

export interface SeedInput {
  ownerId: string;
  ownerName: string;
  companyName: string;
  timezone?: string;
  now: number;
}

/** Suggests a key from a name the way Linear does: initials, or the first letters. */
export function suggestKey(name: string): string {
  const words = name
    .toUpperCase()
    .replace(/[^A-Z0-9 ]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  const initials = words.map((w) => w[0]).join("");
  const key = initials.length >= 2 ? initials : (words[0] ?? "TEAM").slice(0, 3);
  return /^[A-Z]/.test(key) ? key.slice(0, 7) : `T${key}`.slice(0, 7);
}

/**
 * Statements that create a new company: the workspace, the owner, the CEO agent and a first team
 * named after the company, as in Linear, since every issue needs a team. Everything else (more
 * teams, employees, labels) is created by the CEO as the owner's life calls for it.
 */
export function seedCompany(db: HubDb, input: SeedInput): WriteOp[] {
  const { ownerId, now } = input;
  const stamp = { createdAt: now, updatedAt: now };
  const workspaceId = newId();
  const ceoId = newId();
  const auditInputs: AuditInput[] = [];

  const workspaceRows = [
    {
      id: workspaceId,
      name: input.companyName,
      urlKey: slugify(input.companyName) || "company",
      timezone: input.timezone,
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
  ];
  for (const user of userRows) {
    auditInputs.push({
      actorId: ownerId,
      action: "user.create",
      entityType: "user",
      entityId: user.id,
      data: { kind: user.kind, title: user.title, managerId: user.managerId ?? null },
      ...(user.kind === "agent" ? { reason: "The CEO is created with the company" } : {}),
    });
  }

  const teamId = newId();
  const key = suggestKey(input.companyName);
  auditInputs.push({
    actorId: ownerId,
    action: "team.create",
    entityType: "team",
    entityId: teamId,
    data: { key, name: input.companyName, leadId: null },
  });

  return [
    ...insertRows(db, workspaces, workspaceRows),
    ...insertRows(db, users, userRows),
    db.insert(teams).values({ id: teamId, key, name: input.companyName, ...stamp }),
    ...insertRows(
      db,
      teamMemberships,
      [ownerId, ceoId].map((userId) => ({ teamId, userId, createdAt: now })),
    ),
    ...insertRows(
      db,
      workflowStates,
      DEFAULT_STATES.map((state, position) => ({
        id: newId(),
        teamId,
        ...state,
        position,
        ...stamp,
      })),
    ),
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
