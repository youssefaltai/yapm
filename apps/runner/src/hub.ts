import type { McpServerReport, McpServerSpec } from "./mcp.js";

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
    sessionId: string | null;
    issue: string | null;
    issueId: string | null;
  };
  agent: { id: string; name: string };
  token: string;
  mcpUrl: string;
  input: RunInput;
  /** Hub-managed MCP servers this agent gets on this machine. */
  mcpServers?: McpServerSpec[];
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
  inputTokens?: number;
  outputTokens?: number;
  numTurns?: number;
}

export interface Completion {
  status: "completed" | "failed" | "stopped" | "needs_input";
  result?: unknown;
  error?: string;
  sessionId?: string | null;
  usage?: Usage;
}

export class HubClient {
  readonly url: string;

  constructor(
    url: string,
    private readonly send: typeof fetch = fetch,
  ) {
    this.url = url.replace(/\/+$/, "");
  }

  private async call<T>(path: string, token: string, json?: unknown): Promise<T | null> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (token) headers.authorization = `Bearer ${token}`;
    const response = await this.send(`${this.url}${path}`, {
      method: json === undefined ? "GET" : "POST",
      headers,
      ...(json !== undefined ? { body: JSON.stringify(json) } : {}),
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
    mcps: string[];
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
      mcps: string[];
      capacity: number;
      version: string;
      runIds: string[];
      tags?: string[];
      mcpServers?: McpServerReport[];
    },
  ) {
    return this.call<{
      status: string;
      stop: { id: string; reason: string | null }[];
      mcpServers?: McpServerSpec[];
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

  complete(token: string, runId: string, completion: Completion) {
    return this.call<{ status: string }>(`/api/runner/runs/${runId}/complete`, token, completion);
  }

  /** GraphQL as the run's agent. Errors come back as a thrown HubError. */
  async graphql<T>(token: string, query: string, variables?: Record<string, unknown>) {
    const body = await this.call<{ data?: T; errors?: { message: string }[] }>("/graphql", token, {
      query,
      variables,
    });
    if (body?.errors?.length) throw new HubError(body.errors[0]?.message ?? "GraphQL error", 200);
    return body?.data as T;
  }
}
