import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  auth,
  extractWWWAuthenticateParams,
  type OAuthClientProvider,
} from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";

/** An MCP server the hub asked this machine to run (see the hub's `serverSpec`). */
export interface McpServerSpec {
  id: string;
  name: string;
  transport: "http" | "stdio";
  url: string | null;
  command: string | null;
  args: string[];
  agentIds: string[] | null;
  status: string;
  /** The owner signed in; exchange this with the verifier we kept. */
  authCode?: string;
}

export interface McpServerReport {
  id: string;
  status: "installing" | "needs_auth" | "ready" | "failed";
  detail?: string | null;
  authUrl?: string | null;
  authState?: string | null;
}

/** What this machine remembers about signing in to one server. Never leaves the machine. */
interface AuthEntry {
  url: string;
  client?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  tokensAt?: number;
  verifier?: string;
  state?: string;
  authUrl?: string;
  /** It answered without asking for a sign-in. */
  open?: boolean;
}

export interface McpManagerOptions {
  /** The hub's address; providers send the owner back to its callback. */
  hubUrl: string;
  machineName: string;
  /** Where sign-ins are kept (mode 0600). In memory when omitted. */
  file?: string;
  fetch?: typeof fetch;
  log?: (line: string) => void;
}

const INITIALIZE = {
  jsonrpc: "2.0",
  id: 0,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "life-os-runner", version: "1" },
  },
};

/**
 * Runs the hub-managed MCP servers on this machine: checks each one, signs in with OAuth
 * (the owner approves in their browser; the provider returns them to the hub, which hands
 * the code back here), keeps tokens fresh, and builds the servers' config for each run.
 */
export class McpManager {
  private entries: Record<string, AuthEntry> = {};
  private loaded = false;
  private readonly current = new Map<string, McpServerReport>();
  private readonly send: typeof fetch;

  constructor(private readonly options: McpManagerOptions) {
    this.send = options.fetch ?? fetch;
  }

  /** The latest state of every server, for the next check-in. */
  reports(): McpServerReport[] {
    return [...this.current.values()];
  }

  /** Brings the machine in line with the hub's list. Returns whether any state changed. */
  async sync(specs: McpServerSpec[]): Promise<boolean> {
    await this.load();
    let changed = false;
    const set = (report: McpServerReport) => {
      const before = this.current.get(report.id);
      if (JSON.stringify(before) !== JSON.stringify(report)) changed = true;
      this.current.set(report.id, report);
    };
    for (const id of [...this.current.keys()])
      if (!specs.some((s) => s.id === id)) this.current.delete(id);
    let dirty = false;
    for (const id of Object.keys(this.entries)) {
      if (!specs.some((s) => s.id === id)) {
        delete this.entries[id];
        dirty = true;
      }
    }
    if (dirty) await this.save();
    for (const spec of specs) {
      if (spec.transport === "stdio") {
        set({ id: spec.id, status: spec.command ? "ready" : "failed" });
        continue;
      }
      try {
        set(await this.check(spec));
      } catch (error) {
        set({
          id: spec.id,
          status: "failed",
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return changed;
  }

  private async check(spec: McpServerSpec): Promise<McpServerReport> {
    const url = spec.url ?? "";
    let entry = this.entries[spec.id];
    if (!entry || entry.url !== url) {
      entry = { url };
      this.entries[spec.id] = entry;
    }
    const provider = this.provider(spec, entry);
    if (spec.authCode && entry.verifier) {
      let result: Awaited<ReturnType<typeof auth>>;
      try {
        result = await auth(provider, {
          serverUrl: url,
          authorizationCode: spec.authCode,
          fetchFn: this.send,
        });
      } finally {
        // A code works once; whatever happened, the next attempt starts a fresh sign-in.
        entry.verifier = undefined;
        entry.state = undefined;
        entry.authUrl = undefined;
        await this.save();
      }
      if (result === "AUTHORIZED") {
        this.log(`Signed in to ${spec.name}.`);
        return { id: spec.id, status: "ready" };
      }
    }
    if (entry.tokens || entry.open) return { id: spec.id, status: "ready" };
    // Still waiting for the owner to sign in with the link we already sent.
    if (entry.state && entry.authUrl)
      return { id: spec.id, status: "needs_auth", authUrl: entry.authUrl, authState: entry.state };

    const probe = await this.send(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify(INITIALIZE),
    });
    await probe.body?.cancel().catch(() => undefined);
    if (probe.status === 401 || probe.status === 403) {
      const { resourceMetadataUrl, scope } = extractWWWAuthenticateParams(probe);
      const result = await auth(provider, {
        serverUrl: url,
        ...(resourceMetadataUrl ? { resourceMetadataUrl } : {}),
        ...(scope ? { scope } : {}),
        fetchFn: this.send,
      });
      await this.save();
      if (result === "AUTHORIZED") return { id: spec.id, status: "ready" };
      if (!entry.authUrl || !entry.state) throw new Error("The server didn't offer a sign-in");
      this.log(`${spec.name} needs the owner to sign in.`);
      return { id: spec.id, status: "needs_auth", authUrl: entry.authUrl, authState: entry.state };
    }
    if (!probe.ok) throw new Error(`The server answered ${probe.status}`);
    entry.open = true;
    await this.save();
    return { id: spec.id, status: "ready" };
  }

  /** The `mcpServers` config for a run: the agent's ready servers, with fresh tokens. */
  async configFor(specs: McpServerSpec[]): Promise<Record<string, unknown>> {
    await this.load();
    const config: Record<string, unknown> = {};
    for (const spec of specs) {
      if (spec.transport === "stdio" && spec.command) {
        config[spec.name] = { type: "stdio", command: spec.command, args: spec.args };
        continue;
      }
      const entry = this.entries[spec.id];
      if (!spec.url || !entry || entry.url !== spec.url) continue;
      if (entry.open) {
        config[spec.name] = { type: "http", url: spec.url };
        continue;
      }
      if (!entry.tokens) continue;
      const expiresAt = entry.tokens.expires_in
        ? (entry.tokensAt ?? 0) + entry.tokens.expires_in * 1000
        : Number.POSITIVE_INFINITY;
      if (expiresAt - Date.now() < 120_000 && entry.tokens.refresh_token) {
        try {
          await auth(this.provider(spec, entry), { serverUrl: spec.url, fetchFn: this.send });
          await this.save();
        } catch (error) {
          this.log(`Couldn't refresh ${spec.name}'s sign-in: ${String(error)}`);
        }
      }
      if (!entry.tokens) continue;
      config[spec.name] = {
        type: "http",
        url: spec.url,
        headers: { authorization: `Bearer ${entry.tokens.access_token}` },
      };
    }
    return config;
  }

  private provider(spec: McpServerSpec, entry: AuthEntry): OAuthClientProvider {
    const redirectUrl = `${this.options.hubUrl.replace(/\/+$/, "")}/api/mcp/oauth/callback`;
    return {
      redirectUrl,
      clientMetadata: {
        client_name: `Life OS on ${this.options.machineName}`,
        redirect_uris: [redirectUrl],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      },
      state: () => {
        entry.state = `${spec.id}.${randomUUID()}`;
        return entry.state;
      },
      clientInformation: () => entry.client,
      saveClientInformation: (client) => {
        entry.client = client;
      },
      tokens: () => entry.tokens,
      saveTokens: (tokens) => {
        entry.tokens = tokens;
        entry.tokensAt = Date.now();
      },
      redirectToAuthorization: (authorizationUrl) => {
        entry.authUrl = authorizationUrl.toString();
      },
      saveCodeVerifier: (verifier) => {
        entry.verifier = verifier;
      },
      codeVerifier: () => {
        if (!entry.verifier) throw new Error("No sign-in in progress");
        return entry.verifier;
      },
      invalidateCredentials: (scope) => {
        if (scope === "all" || scope === "client") entry.client = undefined;
        if (scope === "all" || scope === "tokens") entry.tokens = undefined;
        if (scope === "all" || scope === "verifier") entry.verifier = undefined;
      },
    };
  }

  private log(line: string) {
    this.options.log?.(line);
  }

  private async load() {
    if (this.loaded) return;
    this.loaded = true;
    if (!this.options.file) return;
    try {
      this.entries = JSON.parse(await readFile(this.options.file, "utf8"));
    } catch {
      this.entries = {};
    }
  }

  private async save() {
    if (!this.options.file) return;
    await mkdir(dirname(this.options.file), { recursive: true });
    await writeFile(this.options.file, `${JSON.stringify(this.entries, null, 2)}\n`, {
      mode: 0o600,
    });
    await chmod(this.options.file, 0o600);
  }
}
