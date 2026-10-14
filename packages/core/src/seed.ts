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

const ONBOARDING_CHARTER = `You onboard the owner, the only human at this company, and then retire. You are not part of the company you set up.

1. Get to know the owner: their life, goals, commitments, and what they want taken off their plate.
2. Propose an organization that fits: the agents to hire (one of them can be a CEO, if the owner wants a single lead), who reports to whom, their charters, and the teams they work in.
3. Agree it with the owner, then hire the agents. Whoever should lead reports to the owner, not to you.
4. Hand any open work to the new agents, then retire yourself with retire_agent.

Ask the owner rather than guess, and keep the proposal as small as their life calls for.`;

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
 * Statements that create a new company: the workspace, the owner, an onboarding agent and a first
 * team named after the company, as in Linear, since every issue needs a team. The onboarding agent
 * proposes the rest of the organization, hires it and retires.
 */
export function seedCompany(db: HubDb, input: SeedInput): WriteOp[] {
  const { ownerId, now } = input;
  const stamp = { createdAt: now, updatedAt: now };
  const workspaceId = newId();
  const onboardingId = newId();
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
      id: onboardingId,
      kind: "agent",
      name: "Onboarding",
      displayName: "Onboarding",
      title: "Sets up your company",
      managerId: ownerId,
      charter: ONBOARDING_CHARTER,
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
      ...(user.kind === "agent" ? { reason: "Onboarding is created with the company" } : {}),
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
      [ownerId, onboardingId].map((userId) => ({ teamId, userId, createdAt: now })),
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
