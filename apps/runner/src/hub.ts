import type { Options } from "@anthropic-ai/claude-agent-sdk";
import type { ClaudeAccount, PlanUsage } from "./plan.js";

export type EngineName = "claude" | "opencode";

/** A provider this machine is signed in to, and its models with the efforts each supports. */
export interface ProviderModels {
  id: string;
  name: string;
  models: { id: string; name: string; efforts: string[] }[];
}

/** Talks to the hub: the runner protocol with the machine's secret, GraphQL with a run's token. */
export class HubError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export interface RunInput {
  systemPrompt: string;
  prompt: string;
  outputSchema: Record<string, unknown>;
  tools: boolean;
  maxTurns: number;
}

export interface Claim {
  run: {
    id: string;
    kind: "decision" | "work";
    modelTier: "small" | "standard" | "top";
    /** The provider, model and effort the hub chose (null: the model has none); older hubs send
     * no provider, and neither model nor effort before that. */
    provider?: string;
    model?: string;
    effort?: string | null;
    /** What runs the model: Claude for Anthropic's, OpenCode for the rest; older hubs send nothing, meaning Claude. */
    engine?: EngineName;
    sessionId: string | null;
    issue: string | null;
    issueId: string | null;
  };
  agent: { id: string; name: string };
  token: string;
  mcpUrl: string;
  /** Outside MCP servers this agent may use, in Claude Code's shape with their secrets. */
  mcpServers?: Options["mcpServers"];
  input: RunInput;
}

export interface Enrolment {
  id: string;
  token: string;
  pairingCode: string;
  /** "active" when a setup token approved the machine straight away. */
  status: "pending" | "active";
  approveAt: string;
}

export interface Usage {
  /** Totals for the whole session, subagents included; a resumed session carries on counting. */
  inputTokens?: number;
  outputTokens?: number;
  numTurns?: number;
  /** What the session would cost at API prices. */
  costUsd?: number;
}

export interface Completion {
  status: "completed" | "failed" | "stopped" | "needs_input";
  result?: unknown;
  error?: string;
  sessionId?: string | null;
  usage?: Usage;
  /** What actually ran; older runners send neither and the hub keeps its choice. */
  model?: string;
  effort?: string | null;
}

/** A blip worth trying again: no answer, the hub or its proxy failing, or too many calls. */
export const transient = (error: unknown) =>
  !(error instanceof HubError) || error.status >= 500 || error.status === 429;

export class HubClient {
  readonly url: string;
  private readonly timeoutMs: number;
  private readonly retryMs: number;

  constructor(
    url: string,
    private readonly send: typeof fetch = fetch,
    { timeoutMs = 30_000, retryMs = 1000 } = {},
  ) {
    this.url = url.replace(/\/+$/, "");
    this.timeoutMs = timeoutMs;
    this.retryMs = retryMs;
  }

  /** A call, tried again with backoff after a blip, `retries` times at most. */
  private async call<T>(
    path: string,
    token: string,
    json?: unknown,
    retries = 3,
  ): Promise<T | null> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.once<T>(path, token, json);
      } catch (error) {
        if (attempt >= retries || !transient(error)) throw error;
        const wait = Math.min(this.retryMs * 2 ** attempt, this.timeoutMs);
        await new Promise((resolve) => setTimeout(resolve, wait));
      }
    }
  }

  private async once<T>(path: string, token: string, json?: unknown): Promise<T | null> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (token) headers.authorization = `Bearer ${token}`;
    const response = await this.send(`${this.url}${path}`, {
      method: json === undefined ? "GET" : "POST",
      headers,
      ...(json !== undefined ? { body: JSON.stringify(json) } : {}),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (response.status === 204) return null;
    const text = await response.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      // Not JSON: a proxy's error page, say.
    }
    if (!response.ok) {
      const message = (body as { error?: string } | null)?.error ?? text.slice(0, 200);
      throw new HubError(message || `The hub answered ${response.status}`, response.status);
    }
    return body as T;
  }

  enrol(input: {
    name: string;
    tags: string[];
    capacity: number;
    version: string;
    setupToken?: string;
  }) {
    return this.call<Enrolment>("/api/runner/enrol", "", input) as Promise<Enrolment>;
  }

  me(token: string) {
    return this.call<{ id: string; name: string; status: string; tags: string[] }>(
      "/api/runner/me",
      token,
    );
  }

  heartbeat(
    token: string,
    info: {
      capacity: number;
      version: string;
      runIds: string[];
      tags?: string[];
      engines?: EngineName[];
      providers?: ProviderModels[];
      claudeAccount?: ClaudeAccount | null;
      planUsage?: PlanUsage;
    },
  ) {
    return this.call<{
      status: string;
      stop: { id: string; reason: string | null }[];
      upgrade?: boolean;
    }>("/api/runner/heartbeat", token, info);
  }

  claim(token: string) {
    return this.call<Claim>("/api/runner/claim", token, {});
  }

  logs(
    token: string,
    runId: string,
    upload: { seq: number; events: unknown[]; sessionId?: string | null; usage?: Usage },
  ) {
    return this.call<{ stop: boolean; stopReason: string | null }>(
      `/api/runner/runs/${runId}/logs`,
      token,
      upload,
    );
  }

  /** Tried until the hub takes it: a run's result is lost otherwise. */
  complete(token: string, runId: string, completion: Completion) {
    return this.call<{ status: string }>(
      `/api/runner/runs/${runId}/complete`,
      token,
      completion,
      Number.POSITIVE_INFINITY,
    );
  }

  /**
   * GraphQL as the run's agent. Errors come back as a thrown HubError. Not tried again: a
   * mutation whose answer was lost may have happened.
   */
  async graphql<T>(token: string, query: string, variables?: Record<string, unknown>) {
    const body = await this.call<{ data?: T; errors?: { message: string }[] }>(
      "/graphql",
      token,
      { query, variables },
      0,
    );
    if (body?.errors?.length) throw new HubError(body.errors[0]?.message ?? "GraphQL error", 200);
    return body?.data as T;
  }
}
