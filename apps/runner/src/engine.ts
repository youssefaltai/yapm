import type { Options } from "@anthropic-ai/claude-agent-sdk";
import type { RunInput, Usage } from "./hub.js";
import type { ToolDecision } from "./permissions.js";
import type { PlanUpdate } from "./plan.js";

/** One agent session, as the daemon asks for it. */
export interface EngineRun {
  input: RunInput;
  /** The model's provider, e.g. anthropic or openai; older hubs don't say. */
  provider?: string;
  /** A model id the hub chose, or an alias from an older hub. */
  model: string;
  /** How hard the model works, a level it supports; left out, the model's default applies. */
  effort?: string;
  /** The hub's MCP server, reached with the run's token. */
  hubMcp: { url: string; token: string };
  /** Outside MCP servers, the machine's own and the hub's, in Claude Code's `mcpServers` shape. */
  mcpServers?: Options["mcpServers"];
  /** Continue this session instead of starting fresh. */
  resume: string | null;
  cwd: string;
  signal: AbortSignal;
  /** `readOnly` when an MCP tool's annotations say it only reads. */
  canUseTool: (
    tool: string,
    input: Record<string, unknown>,
    readOnly?: boolean,
  ) => Promise<ToolDecision>;
  /** Transcript events, compact and JSON-safe, in order. */
  onEvent: (event: Record<string, unknown>) => void;
  onSession: (sessionId: string) => void;
  /** What the session learns about the plan: the login, rate-limit events, a /usage reading. */
  onPlan?: (update: PlanUpdate) => void;
  /** Take a full /usage reading when the session ends; the daemon spaces these out. */
  readUsage?: boolean;
}

export interface EngineResult {
  /** The structured output, when the session produced one. */
  output: unknown;
  sessionId: string | null;
  usage: Usage;
  error?: string;
  /** The model that ran, e.g. `claude-opus-5-5` or `openai/gpt-6-sol`; left out when unknown. */
  model?: string;
  /** The effort (an OpenCode variant) it ran with; null when none applied. */
  effort?: string | null;
  /** The plan's usage limit stopped it; resets then (epoch ms), when known. */
  limited?: { resetsAt: number | null };
}

export type Engine = (run: EngineRun) => Promise<EngineResult>;

/** Reads the plan without running a session, for machines that sit idle. */
export type PlanProbe = () => Promise<PlanUpdate[]>;

/** Aliases for hubs that don't choose a model yet. */
export const MODELS = { small: "haiku", standard: "sonnet", top: "opus" } as const;
