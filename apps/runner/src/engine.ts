import type { RunInput, Usage } from "./hub.js";
import type { ToolDecision } from "./permissions.js";

/** One agent session, as the daemon asks for it. */
export interface EngineRun {
  input: RunInput;
  /** A model alias: haiku, sonnet or opus. */
  model: string;
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
}

export interface EngineResult {
  /** The structured output, when the session produced one. */
  output: unknown;
  sessionId: string | null;
  usage: Usage;
  error?: string;
}

export type Engine = (run: EngineRun) => Promise<EngineResult>;

export const MODELS = { small: "haiku", standard: "sonnet", top: "opus" } as const;
