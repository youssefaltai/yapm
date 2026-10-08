import {
  comments,
  type issues,
  PRIORITY_LABELS,
  requests,
  teams,
  users,
  workflowStates,
  workspaces,
} from "@life-os/schema";
import { desc, eq, inArray } from "drizzle-orm";
import type { HubDb } from "../db.js";

// Everything an agent reads when it wakes is built here, by the hub, from current data.
// The runner only executes it, so prompts and schemas change in one place.

export const DECISION_ACTIONS = [
  "ignore",
  "react",
  "reply",
  "wait_until",
  "work",
  "delegate",
  "escalate",
] as const;
export type DecisionAction = (typeof DECISION_ACTIONS)[number];
export const MODEL_TIERS = ["small", "standard", "top"] as const;
export type ModelTier = (typeof MODEL_TIERS)[number];

/** Structured output for a decision step: strict JSON the hub validates before applying. */
export const DECISION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    action: { type: "string", enum: [...DECISION_ACTIONS] },
    reason: { type: "string", description: "One sentence: why this is the right response." },
    emoji: { type: "string", description: "For react: one emoji, e.g. 👍" },
    body: { type: "string", description: "For reply or escalate: the comment, in markdown." },
    until: {
      type: "string",
      description: "For wait_until: ISO-8601 time to look again, e.g. 2026-10-09T09:00:00Z",
    },
    goal: { type: "string", description: "For work: what the work session must achieve." },
    modelTier: { type: "string", enum: [...MODEL_TIERS] },
    to: { type: "string", description: "For delegate: the teammate's name." },
  },
  required: ["action", "reason"],
} as const;

export const WORK_OUTCOMES = ["done", "needs_input", "blocked", "failed"] as const;
export type WorkOutcome = (typeof WORK_OUTCOMES)[number];

/** Structured output that ends every work session. */
export const WORK_RESULT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    outcome: { type: "string", enum: [...WORK_OUTCOMES] },
    summary: {
      type: "string",
      description: "What you did and what's left, for the issue's history. Markdown.",
    },
    question: {
      type: "string",
      description: "For needs_input: the one question you need answered to continue.",
    },
  },
  required: ["outcome", "summary"],
} as const;

export interface Decision {
  action: DecisionAction;
  reason: string;
  emoji?: string;
  body?: string;
  until?: string;
  goal?: string;
  modelTier?: ModelTier;
  to?: string;
}

export interface WorkResult {
  outcome: WorkOutcome;
  summary: string;
  question?: string;
}

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

/** Checks a decision from the model; anything off becomes an error, never a guess. */
export function parseDecision(value: unknown): Decision {
  const v = (value ?? {}) as Record<string, unknown>;
  const action = str(v.action) as DecisionAction;
  if (!DECISION_ACTIONS.includes(action)) throw new Error(`Unknown decision action "${v.action}"`);
  const decision: Decision = { action, reason: str(v.reason).slice(0, 1000) };
  if (action === "react") {
    decision.emoji = str(v.emoji).slice(0, 16);
    if (!decision.emoji) throw new Error("A react decision needs an emoji");
  }
  if (action === "reply" || action === "escalate") {
    decision.body = str(v.body).slice(0, 10_000);
    if (!decision.body && action === "reply") throw new Error("A reply decision needs a body");
  }
  if (action === "wait_until") {
    const until = Date.parse(str(v.until));
    if (Number.isNaN(until)) throw new Error("A wait_until decision needs an ISO time");
    decision.until = new Date(until).toISOString();
  }
  if (action === "work") {
    decision.goal = str(v.goal).slice(0, 2000);
    if (!decision.goal) throw new Error("A work decision needs a goal");
    const tier = str(v.modelTier) as ModelTier;
    decision.modelTier = MODEL_TIERS.includes(tier) ? tier : "standard";
  }
  if (action === "delegate") {
    decision.to = str(v.to);
    if (!decision.to) throw new Error("A delegate decision needs a teammate's name");
  }
  return decision;
}

export function parseWorkResult(value: unknown): WorkResult {
  const v = (value ?? {}) as Record<string, unknown>;
  const outcome = str(v.outcome) as WorkOutcome;
  if (!WORK_OUTCOMES.includes(outcome)) throw new Error(`Unknown work outcome "${v.outcome}"`);
  const result: WorkResult = { outcome, summary: str(v.summary).slice(0, 20_000) };
  if (outcome === "needs_input") {
    result.question = str(v.question).slice(0, 5000) || result.summary;
  }
  return result;
}

type IssueRow = typeof issues.$inferSelect;

export async function identifierOf(db: HubDb, issue: Pick<IssueRow, "teamId" | "number">) {
  const team = await db
    .select({ key: teams.key })
    .from(teams)
    .where(eq(teams.id, issue.teamId))
    .get();
  return `${team?.key ?? "?"}-${issue.number}`;
}

const clip = (text: string | null | undefined, max: number) => {
  const t = (text ?? "").trim();
  return t.length > max ? `${t.slice(0, max)}… (truncated)` : t;
};

/** The issue as an agent needs to see it: fields, description and the latest comments. */
async function issueContext(db: HubDb, issue: IssueRow, commentLimit: number) {
  const [identifier, state, assignee, recent] = await Promise.all([
    identifierOf(db, issue),
    db.select().from(workflowStates).where(eq(workflowStates.id, issue.stateId)).get(),
    issue.assigneeId
      ? db.select().from(users).where(eq(users.id, issue.assigneeId)).get()
      : undefined,
    db
      .select()
      .from(comments)
      .where(eq(comments.issueId, issue.id))
      .orderBy(desc(comments.createdAt))
      .limit(commentLimit)
      .all(),
  ]);
  const authorIds = [...new Set(recent.map((c) => c.userId))];
  const authors = authorIds.length
    ? await db
        .select({ id: users.id, name: users.name })
        .from(users)
        .where(inArray(users.id, authorIds))
        .all()
    : [];
  const nameOf = (id: string) => authors.find((a) => a.id === id)?.name ?? "someone";
  const lines = [
    `${identifier}: ${issue.title}`,
    `Status: ${state?.name ?? "?"} · Priority: ${PRIORITY_LABELS[issue.priority]} · Assignee: ${assignee?.name ?? "nobody"}${issue.dueDate ? ` · Due ${issue.dueDate}` : ""}`,
  ];
  if (issue.description) lines.push("", "Description:", clip(issue.description, 4000));
  if (recent.length) {
    lines.push("", `Latest comments (oldest first, ${recent.length} shown):`);
    for (const c of recent.reverse()) {
      lines.push(
        `- ${nameOf(c.userId)} (${new Date(c.createdAt).toISOString()}): ${clip(c.body, 1500)}`,
      );
    }
  }
  return { identifier, text: lines.join("\n") };
}

interface TriggerNote {
  type: string;
  actorId?: string | null;
  commentId?: string | null;
  requestId?: string | null;
}

/** "Youssef mentioned you in a comment: …" for each event that woke the agent. */
async function describeTriggers(db: HubDb, notes: TriggerNote[]) {
  const lines: string[] = [];
  for (const note of notes) {
    const actor = note.actorId
      ? await db.select({ name: users.name }).from(users).where(eq(users.id, note.actorId)).get()
      : undefined;
    const who = actor?.name ?? "Someone";
    const comment = note.commentId
      ? await db.select().from(comments).where(eq(comments.id, note.commentId)).get()
      : undefined;
    const quoted = comment ? `\n  > ${clip(comment.body, 2000).replace(/\n/g, "\n  > ")}` : "";
    switch (note.type) {
      case "issueAssignedToYou":
        lines.push(`- ${who} assigned the issue to you.`);
        break;
      case "issueMention":
        lines.push(`- ${who} mentioned you in the issue's description.`);
        break;
      case "issueCommentMention":
        lines.push(`- ${who} mentioned you in a comment:${quoted}`);
        break;
      case "issueNewComment":
        lines.push(`- ${who} commented:${quoted}`);
        break;
      case "requestAnswered": {
        const request = note.requestId
          ? await db.select().from(requests).where(eq(requests.id, note.requestId)).get()
          : undefined;
        lines.push(
          `- ${who} ${request?.status ?? "answered"} your request "${request?.title ?? ""}"${request?.answer ? `: ${request.answer}` : ""}.`,
        );
        break;
      }
      case "issueSlaBreached":
        lines.push(
          "- The issue missed its SLA: it's overdue for its priority. Finish it or say why.",
        );
        break;
      case "wake":
        lines.push("- You asked to look at this again now.");
        break;
      default:
        lines.push(`- ${who}: ${note.type}`);
    }
  }
  return lines.join("\n");
}

type Agent = typeof users.$inferSelect;

async function agentIntro(db: HubDb, agent: Agent) {
  const [company, manager] = await Promise.all([
    db.select().from(workspaces).get(),
    agent.managerId
      ? db.select().from(users).where(eq(users.id, agent.managerId)).get()
      : undefined,
  ]);
  return [
    `You are ${agent.name}${agent.title ? `, ${agent.title}` : ""}, an AI employee at ${company?.name ?? "the company"}.`,
    `The company runs on an issue tracker shaped like Linear; you and your teammates work through its issues and comments. You report to ${manager?.name ?? "the owner"}.`,
    "",
    "Your charter:",
    agent.charter?.trim() || "(No charter yet. Ask your manager what you own.)",
  ].join("\n");
}

export interface RunInput {
  systemPrompt: string;
  prompt: string;
  outputSchema: Record<string, unknown>;
  /** Whether the run may use tools (the hub's MCP server and the machine's). */
  tools: boolean;
  maxTurns: number;
}

export async function decisionInput(
  db: HubDb,
  agent: Agent,
  issue: IssueRow | null,
  notes: TriggerNote[],
): Promise<RunInput> {
  const context = issue ? await issueContext(db, issue, 8) : null;
  const system = [
    await agentIntro(db, agent),
    "",
    "Something happened that may need you. Decide the single best response, and be economical:",
    "- ignore: nothing for you to do.",
    "- react: acknowledge with an emoji when words add nothing.",
    "- reply: a short comment that fully answers (no tools needed).",
    "- wait_until: look again later, e.g. when something you depend on should be done.",
    "- work: start a work session with tools when it needs real effort; give a clear goal.",
    "- delegate: hand the issue to a teammate whose charter fits better.",
    "- escalate: bring in your manager when you can't or shouldn't decide.",
    "Pick modelTier small or standard for work unless it is genuinely hard; top is costly.",
  ].join("\n");
  const prompt = [
    "What happened:",
    await describeTriggers(db, notes),
    "",
    context ? `The issue:\n${context.text}` : "There is no issue attached.",
    "",
    `Now: ${new Date().toISOString()}. Answer with the decision JSON only.`,
  ].join("\n");
  return { systemPrompt: system, prompt, outputSchema: DECISION_SCHEMA, tools: false, maxTurns: 1 };
}

export async function workInput(
  db: HubDb,
  agent: Agent,
  issue: IssueRow | null,
  goal: string,
  notes: TriggerNote[],
  resuming: boolean,
): Promise<RunInput> {
  const context = issue ? await issueContext(db, issue, 20) : null;
  const system = [
    await agentIntro(db, agent),
    "",
    "How you work:",
    "- The company's tracker is your `life-os` MCP server. Read issues with get_issue, report progress with create_comment, and move issues through statuses with update_issue.",
    "- Comment as you go so the owner can follow along; keep comments short and concrete.",
    "- When something needs permission you don't have, the tool call is held until the owner answers. If they reject it, respect the reason and find another way or stop.",
    "- Before you finish, check list_notifications for anything new on this issue.",
    "- Finish with the result JSON: done, needs_input (ask one clear question), blocked or failed.",
  ].join("\n");
  const prompt = resuming
    ? ["New since you paused:", await describeTriggers(db, notes), "", "Continue the work."].join(
        "\n",
      )
    : [
        `Your goal: ${goal}`,
        "",
        context ? `The issue:\n${context.text}` : "There is no issue attached.",
        "",
        notes.length ? `Why you're working on it:\n${await describeTriggers(db, notes)}` : "",
      ].join("\n");
  return {
    systemPrompt: system,
    prompt,
    outputSchema: WORK_RESULT_SCHEMA,
    tools: true,
    maxTurns: 60,
  };
}
