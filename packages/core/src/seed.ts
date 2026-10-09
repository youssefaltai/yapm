import { users, type WorkflowStateType, workspaces } from "@life-os/schema";
import { type AuditInput, audit } from "./audit.js";
import { newId } from "./crypto.js";
import type { HubDb, WriteOp } from "./db.js";
import { insertRows } from "./write.js";

/** Linear's default workflow, plus Triage. New teams start with these states. */
export const DEFAULT_STATES: { name: string; type: WorkflowStateType; color: string }[] = [
  { name: "Triage", type: "triage", color: "#8b8b90" },
  { name: "Backlog", type: "backlog", color: "#6c6c71" },
  { name: "Todo", type: "unstarted", color: "#8b8b90" },
  { name: "In Progress", type: "started", color: "#aaaaae" },
  { name: "In Review", type: "started", color: "#aaaaae" },
  { name: "Done", type: "completed", color: "#d0d0d3" },
  { name: "Canceled", type: "canceled", color: "#5e5e63" },
  { name: "Duplicate", type: "canceled", color: "#5e5e63" },
];

const CEO_CHARTER = `You are the CEO of this company. The owner is the only human and your sole stakeholder.

The company starts empty: no teams, no other employees, no labels. Build the organization around the owner's actual life as work arrives. Create a team, hire an agent or add a label only when real work needs it, and restructure when the shape of the work changes.

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
  now: number;
}

/**
 * Statements that create a new, blank company: the workspace, the owner and the CEO agent.
 * Everything else (teams, employees, labels) is created by the CEO as the owner's life calls for it.
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

  return [
    ...insertRows(db, workspaces, workspaceRows),
    ...insertRows(db, users, userRows),
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
