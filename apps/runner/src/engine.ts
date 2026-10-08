import type { RunInput, Usage } from "./hub.js";
import type { ToolDecision } from "./permissions.js";
import type { PlanUpdate } from "./plan.js";

/** One agent session, as the daemon asks for it. */
export interface EngineRun {
  input: RunInput;
  /** A model id the hub chose, or an alias from an older hub. */
  model: string;
  /** How hard the model works; left out, the model's default applies. */
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  /** The hub's MCP server, reached with the run's token. */
  hubMcp: { url: string; token: string };
  /** The machine's own MCP servers, passed through as configured. */
  mcpServers: Record<string, unknown>;
  /** Continue this session instead of starting fresh. */
  resume: string | null;
  cwd: string;
  signal: AbortSignal;
  canUseTool: (tool: string, input: Record<string, unknown>) => Promise<ToolDecision>;
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
}

export type Engine = (run: EngineRun) => Promise<EngineResult>;

/** Reads the plan without running a session, for machines that sit idle. */
export type PlanProbe = () => Promise<PlanUpdate[]>;

/** Aliases for hubs that don't choose a model yet. */
export const MODELS = { small: "haiku", standard: "sonnet", top: "opus" } as const;
