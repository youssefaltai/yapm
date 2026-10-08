import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SoftwareAuthenticator, TestClient } from "@life-os/core/testing";
import { beforeAll, describe, expect, it } from "vitest";
import { createNodeApp } from "../../hub-node/src/app.js";
import { openDatabase } from "../../hub-node/src/db.js";
import { Runner } from "../src/daemon.js";
import type { Engine, EngineRun } from "../src/engine.js";
import { HubClient } from "../src/hub.js";
import { McpManager } from "../src/mcp.js";

/** A remote MCP server behind OAuth, with its authorization server, as one fake host. */
const tokenRequests: Record<string, string>[] = [];
async function provider(input: RequestInfo | URL, init?: RequestInit) {
  const request = new Request(input, init);
  const url = new URL(request.url);
  const json = (body: unknown, status = 200) => Response.json(body, { status });
  if (url.host !== "mcp.test") return new Response("Not found", { status: 404 });
  if (url.pathname.startsWith("/.well-known/oauth-protected-resource"))
    return json({ resource: "https://mcp.test/mcp", authorization_servers: ["https://mcp.test"] });
  if (url.pathname.startsWith("/.well-known/oauth-authorization-server"))
    return json({
      issuer: "https://mcp.test",
      authorization_endpoint: "https://mcp.test/authorize",
      token_endpoint: "https://mcp.test/token",
      registration_endpoint: "https://mcp.test/register",
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
    });
  if (url.pathname === "/register")
    return json({ client_id: "client-1", ...((await request.json()) as object) }, 201);
  if (url.pathname === "/token") {
    const form = Object.fromEntries(new URLSearchParams(await request.text()));
    tokenRequests.push(form);
    if (form.code === "good-code" && form.code_verifier)
      return json({
        access_token: "tok-1",
        token_type: "Bearer",
        expires_in: 3600,
        refresh_token: "ref-1",
      });
    return json({ error: "invalid_grant" }, 400);
  }
  if (url.pathname === "/mcp") {
    if (request.headers.get("authorization") === "Bearer tok-1")
      return json({ jsonrpc: "2.0", id: 0, result: {} });
    return new Response(null, {
      status: 401,
      headers: {
        "www-authenticate":
          'Bearer resource_metadata="https://mcp.test/.well-known/oauth-protected-resource/mcp"',
      },
    });
  }
  return new Response("Not found", { status: 404 });
}

// The daemon against a real hub in memory; only the model is a script.
describe("runner daemon", () => {
  let owner: TestClient;
  let hub: HubClient;
  let teamId = "";
  let agentId = "";
  const sessions: EngineRun[] = [];
  let script: (run: EngineRun) => ReturnType<Engine>;
  const engine: Engine = (run) => {
    sessions.push(run);
    return script(run);
  };
  let runner: Runner;
  const lines: string[] = [];

  const gql = async <T>(query: string, variables?: Record<string, unknown>) => {
    const result = await owner.graphql<T>(query, variables);
    if (result.errors) throw new Error(result.errors[0]?.message);
    return result.data as T;
  };
  const until = async (check: () => Promise<boolean> | boolean, what: string) => {
    for (let i = 0; i < 200; i++) {
      if (await check()) return;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`Timed out waiting for ${what}\n${lines.join("\n")}`);
  };

  beforeAll(async () => {
    const { db } = await openDatabase(":memory:");
    const app = createNodeApp({ db, config: { platform: "node", version: "test" } });
    const send = async (request: Request) => app.fetch(request);
    owner = new TestClient(send);
    hub = new HubClient("http://localhost", (input, init) =>
      Promise.resolve(app.fetch(new Request(input, init))),
    );
    const options = await owner.json<{ challengeId: string; options: never }>(
      "/api/setup/options",
      { method: "POST", json: { companyName: "Youssef Inc", ownerName: "Youssef" } },
    );
    const credential = await new SoftwareAuthenticator().register(
      options.body.options,
      owner.origin,
    );
    await owner.json("/api/setup/verify", {
      method: "POST",
      json: { challengeId: options.body.challengeId, response: credential },
    });
    const team = await gql<{ teamCreate: { team: { id: string } } }>(
      'mutation { teamCreate(input: { name: "Fitness" }) { team { id } } }',
    );
    teamId = team.teamCreate.team.id;
    const hired = await gql<{ agentHire: { user: { id: string } } }>(
      'mutation { agentHire(input: { name: "Coach", title: "Head of Fitness", charter: "Coach things." }) { user { id } } }',
    );
    agentId = hired.agentHire.user.id;
  });

  it("waits for approval, then takes work", async () => {
    const enrolment = await hub.enrol({
      name: "Test machine",
      tags: [],
      mcps: [],
      capacity: 2,
      version: "test",
    });
    expect(enrolment.pairingCode).toMatch(/^\d{6}$/);
    runner = new Runner({
      hub,
      token: enrolment.token,
      engine,
      capacity: 2,
      version: "test",
      mcpServers: {},
      mcp: new McpManager({
        hubUrl: "http://localhost",
        machineName: "Test machine",
        file: join(await mkdtemp(join(tmpdir(), "runner-mcp-")), "mcp-auth.json"),
        fetch: provider,
      }),
      workDir: await mkdtemp(join(tmpdir(), "runner-test-")),
      pollMs: 10,
      logFlushMs: 10,
      log: (line) => lines.push(line),
    });
    expect(await runner.heartbeat()).toBe("pending");
    expect(await runner.claim()).toBe(0);
    expect(lines).toContain("Waiting for the owner to approve this machine…");
    await gql(
      "mutation($id: String!, $code: String!) { machineApprove(id: $id, pairingCode: $code) { success } }",
      {
        id: enrolment.id,
        code: enrolment.pairingCode,
      },
    );
    expect(await runner.heartbeat()).toBe("active");
    expect(await runner.claim()).toBe(0);
  });

  it("decides, works with a permission the owner grants, and reports back", async () => {
    script = async (run) => {
      run.onSession("session-decide");
      run.onEvent({ type: "text", text: "This needs a real plan." });
      return {
        output: {
          action: "work",
          reason: "It needs effort",
          goal: "Write the plan",
          modelTier: "small",
        },
        sessionId: "session-decide",
        usage: { inputTokens: 500, outputTokens: 30, numTurns: 1 },
      };
    };
    const created = await gql<{ issueCreate: { issue: { id: string } } }>(
      "mutation($input: IssueCreateInput!) { issueCreate(input: $input) { issue { id } } }",
      { input: { teamId, title: "Plan my training", assigneeId: agentId } },
    );
    const issueId = created.issueCreate.issue.id;
    expect(await runner.claim()).toBe(1);
    await runner.idle();
    const decide = sessions[0];
    expect(decide?.model).toBe("claude-haiku-5-5");
    expect(decide?.effort).toBe("low");
    expect(decide?.input.tools).toBe(false);
    expect(decide?.input.prompt).toContain("Plan my training");

    // The decision queued a work session; it asks to run a command, and waits for the owner.
    script = async (run) => {
      run.onSession("session-work");
      run.onEvent({ type: "tool", name: "Bash", input: '{"command":"ls"}' });
      const hubTool = await run.canUseTool("mcp__life-os__create_comment", {});
      expect(hubTool.behavior).toBe("allow");
      const read = await run.canUseTool("Read", { file_path: "/etc/hosts" });
      expect(read.behavior).toBe("allow");
      const bash = await run.canUseTool("Bash", { command: "ls", description: "See my files" });
      expect(bash.behavior).toBe("allow");
      const again = await run.canUseTool("Bash", { command: "rm -rf /", description: "Tidy up" });
      return {
        output: {
          outcome: again.behavior === "deny" ? "done" : "failed",
          summary: `Plan written. ${again.behavior === "deny" ? again.message : ""}`,
        },
        sessionId: "session-work",
        usage: { inputTokens: 4000, outputTokens: 900, numTurns: 7 },
      };
    };
    expect(await runner.claim()).toBe(1);
    await until(() => sessions.length === 2, "the work session");
    const work = sessions[1];
    // The decision asked for small; the hub's rules grant it, with small's pinned model.
    expect(work?.model).toBe("claude-haiku-5-5");
    expect(work?.effort).toBe("low");
    expect(work?.input.tools).toBe(true);
    expect(work?.hubMcp.url).toBe("http://localhost/mcp");
    expect(work?.hubMcp.token).toMatch(/^los_/);

    type Pending = {
      requests: { nodes: { id: string; title: string; issue: { id: string } | null }[] };
    };
    const pending = async () =>
      (
        await gql<Pending>(
          "{ requests(filter: { status: [pending] }) { nodes { id title issue { id } } } }",
        )
      ).requests.nodes;
    await until(async () => (await pending()).length === 1, "the first request");
    const [first] = await pending();
    expect(first?.title).toBe("Coach wants to use Bash: ls");
    expect(first?.issue?.id).toBe(issueId);
    await gql("mutation($id: String!) { requestApprove(id: $id) { success } }", { id: first?.id });
    await until(
      async () => (await pending()).length === 1 && (await pending())[0]?.id !== first?.id,
      "the second request",
    );
    const [second] = await pending();
    await gql(
      'mutation($id: String!) { requestReject(id: $id, reason: "Never delete everything") { success } }',
      {
        id: second?.id,
      },
    );
    await runner.idle();

    const runs = await gql<{
      issue: {
        runs: {
          nodes: {
            kind: string;
            status: string;
            result: Record<string, string>;
            inputTokens: number;
            logs: { events: { type: string }[] }[];
          }[];
        };
        comments: { nodes: { body: string; user: { name: string } }[] };
      };
    }>(
      "query($id: String!) { issue(id: $id) { runs { nodes { kind status result inputTokens logs { events } } } comments { nodes { body user { name } } } } }",
      { id: issueId },
    );
    const byKind = Object.fromEntries(runs.issue.runs.nodes.map((r) => [r.kind, r]));
    expect(byKind.decision?.status).toBe("completed");
    expect(byKind.work).toMatchObject({ status: "completed", inputTokens: 4000 });
    expect(byKind.work?.result.summary).toContain("Never delete everything");
    const events = byKind.work?.logs.flatMap((l) => l.events.map((e) => e.type)) ?? [];
    expect(events).toEqual(expect.arrayContaining(["tool", "permission"]));
    expect(
      runs.issue.comments.nodes.some(
        (c) => c.user.name === "Coach" && c.body.includes("Plan written"),
      ),
    ).toBe(true);
  });

  it("stops a run when the owner says so", async () => {
    script = (run) =>
      new Promise((resolve) => {
        run.onEvent({ type: "text", text: "Working…" });
        run.signal.addEventListener("abort", () =>
          resolve({ output: null, sessionId: "session-stop", usage: {} }),
        );
      });
    const created = await gql<{ runCreate: { run: { id: string } } }>(
      "mutation($input: RunCreateInput!) { runCreate(input: $input) { run { id } } }",
      { input: { agentId, goal: "Keep going" } },
    );
    const id = created.runCreate.run.id;
    expect(await runner.claim()).toBe(1);
    await until(() => runner.running.includes(id), "the run to start");
    await gql('mutation($id: String!) { runStop(id: $id, reason: "Not now") { success } }', { id });
    await runner.heartbeat();
    await runner.idle();
    const run = await gql<{ run: { status: string; stopReason: string } }>(
      "query($id: String!) { run(id: $id) { status stopReason } }",
      { id },
    );
    expect(run.run).toEqual({ status: "stopped", stopReason: "Not now" });
    expect(lines.some((l) => l.includes("Not now"))).toBe(true);
  });

  it("reports the plan's limits from sessions, and reads them while idle", async () => {
    const enrolment = await hub.enrol({
      name: "Plan machine",
      tags: [],
      mcps: [],
      capacity: 1,
      version: "test",
    });
    await gql(
      "mutation($id: String!, $code: String!) { machineApprove(id: $id, pairingCode: $code) { success } }",
      { id: enrolment.id, code: enrolment.pairingCode },
    );
    let probes = 0;
    const resetsAt = Date.now() + 3_600_000;
    const planRunner = new Runner({
      hub,
      token: enrolment.token,
      engine,
      capacity: 1,
      version: "test",
      mcpServers: {},
      mcp: new McpManager({ hubUrl: "http://localhost", machineName: "Plan machine" }),
      workDir: await mkdtemp(join(tmpdir(), "runner-test-")),
      pollMs: 10,
      logFlushMs: 10,
      log: (line) => lines.push(line),
      probe: async () => {
        probes++;
        return [
          {
            account: {
              email: "owner@example.com",
              organization: null,
              subscriptionType: "max",
              apiProvider: "firstParty",
            },
          },
          {
            usage: {
              observedAt: Date.now(),
              source: "usage",
              available: true,
              limits: [
                { kind: "five_hour", label: "Session", utilization: 40, resetsAt, status: null },
                { kind: "seven_day", label: "Week", utilization: 10, resetsAt, status: null },
              ],
              extraUsage: null,
            },
          },
        ];
      },
    });
    planRunner.readPlan();
    await until(() => planRunner.plan.usage !== null, "the idle reading");
    // Readings are spaced out.
    planRunner.readPlan();
    expect(probes).toBe(1);

    // A session's rate-limit event moves one window; it doesn't take a reading of its own.
    script = async (run) => {
      expect(run.readUsage).toBe(false);
      run.onPlan?.({
        rateLimit: {
          status: "allowed_warning",
          rateLimitType: "five_hour",
          utilization: 0.82,
          resetsAt: Math.floor(resetsAt / 1000),
        },
      });
      return {
        output: { outcome: "done", summary: "Done." },
        sessionId: "session-plan",
        usage: {},
      };
    };
    await gql("mutation($input: RunCreateInput!) { runCreate(input: $input) { success } }", {
      input: { agentId, goal: "Check the plan" },
    });
    expect(await planRunner.claim()).toBe(1);
    await planRunner.idle();
    await planRunner.heartbeat();

    const plan = await gql<{
      claudeSubscriptions: {
        id: string;
        account: { subscriptionType: string };
        planUsage: { limits: { kind: string; utilization: number; status: string | null }[] };
      }[];
    }>(
      "{ claudeSubscriptions { id account { subscriptionType } planUsage { limits { kind utilization status } } } }",
    );
    expect(plan.claudeSubscriptions.find((s) => s.id === "owner@example.com")).toEqual({
      id: "owner@example.com",
      account: { subscriptionType: "max" },
      planUsage: {
        limits: [
          { kind: "five_hour", utilization: 82, status: "allowed_warning" },
          { kind: "seven_day", utilization: 10, status: null },
        ],
      },
    });
    // Nothing new: the next check-in doesn't send the reading again.
    expect(planRunner.plan.pending()).toEqual({});
  });

  it("runs hub-managed MCP servers, signing in through the hub", async () => {
    const { machines } = await gql<{ machines: { id: string }[] }>("{ machines { id } }");
    const machineId = machines[0]?.id;
    const add = (input: Record<string, unknown>) =>
      gql(
        "mutation($input: McpServerCreateInput!) { mcpServerCreate(input: $input) { success } }",
        {
          input: { machineId, ...input },
        },
      );
    await add({ name: "slack-acme", url: "https://mcp.test/mcp", agentIds: [agentId] });
    await add({ name: "notes", command: "npx", args: ["notes-mcp"] });
    type Servers = { mcpServers: { name: string; status: string; authUrl: string | null }[] };
    const servers = async () =>
      Object.fromEntries(
        (await gql<Servers>("{ mcpServers { name status authUrl } }")).mcpServers.map((s) => [
          s.name,
          s,
        ]),
      );

    await runner.heartbeat();
    const waiting = await servers();
    expect(waiting.notes?.status).toBe("ready");
    expect(waiting["slack-acme"]?.status).toBe("needs_auth");
    const authUrl = new URL(waiting["slack-acme"]?.authUrl ?? "");
    expect(authUrl.origin + authUrl.pathname).toBe("https://mcp.test/authorize");
    expect(authUrl.searchParams.get("redirect_uri")).toBe(
      "http://localhost/api/mcp/oauth/callback",
    );
    expect(authUrl.searchParams.get("code_challenge_method")).toBe("S256");
    const inbox = await gql<{ notifications: { nodes: { type: string }[] } }>(
      "{ notifications { nodes { type } } }",
    );
    expect(inbox.notifications.nodes.map((n) => n.type)).toContain("mcpServerNeedsAuth");

    // The owner signs in; the provider sends the browser back to the hub with a code.
    const state = authUrl.searchParams.get("state") ?? "";
    const stale = await owner.request("/api/mcp/oauth/callback?state=nope&code=good-code");
    expect(stale.status).toBe(400);
    const back = await owner.request(
      `/api/mcp/oauth/callback?state=${encodeURIComponent(state)}&code=good-code`,
    );
    expect(back.status).toBe(200);
    expect(await back.text()).toContain("Connected slack-acme");
    await runner.heartbeat();
    expect((await servers())["slack-acme"]?.status).toBe("ready");
    expect(tokenRequests.at(-1)).toMatchObject({
      grant_type: "authorization_code",
      code: "good-code",
    });

    script = async () => ({
      output: { outcome: "done", summary: "Read the channel." },
      sessionId: "session-mcp",
      usage: {},
    });
    await gql("mutation($input: RunCreateInput!) { runCreate(input: $input) { success } }", {
      input: { agentId, goal: "Read the team channel" },
    });
    expect(await runner.claim()).toBe(1);
    await runner.idle();
    expect(sessions.at(-1)?.mcpServers).toEqual({
      "slack-acme": {
        type: "http",
        url: "https://mcp.test/mcp",
        headers: { authorization: "Bearer tok-1" },
      },
      notes: { type: "stdio", command: "npx", args: ["notes-mcp"] },
    });
  });
});
