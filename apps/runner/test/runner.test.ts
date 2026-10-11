import { tmpdir } from "node:os";
import { SoftwareAuthenticator, TestClient } from "@yapm/core/testing";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { createNodeApp } from "../../hub-node/src/app.js";
import { openDatabase } from "../../hub-node/src/db.js";
import { Runner } from "../src/daemon.js";
import type { Engine, EngineRun } from "../src/engine.js";
import { HubClient } from "../src/hub.js";

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
      capacity: 2,
      version: "test",
    });
    expect(enrolment.pairingCode).toMatch(/^\d{6}$/);
    runner = new Runner({
      hub,
      token: enrolment.token,
      engines: { claude: engine },
      capacity: 2,
      version: "test",
      mcpServers: { notes: { type: "stdio", command: "notes-mcp" } },
      cwd: "/somewhere/anywhere",
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
    expect(decide?.model).toBe("claude-sonnet-5-5");
    expect(decide?.effort).toBe("medium");
    expect(decide?.modelTier).toBe("small");
    expect(decide?.input.tools).toBe(false);
    expect(decide?.input.prompt).toContain("Plan my training");

    // The decision queued a work session; it asks to run a command, and waits for the owner.
    script = async (run) => {
      run.onSession("session-work");
      run.onEvent({ type: "tool", name: "Bash", input: '{"command":"touch notes.md"}' });
      const hubTool = await run.canUseTool("mcp__yapm__create_comment", {});
      expect(hubTool.behavior).toBe("allow");
      const read = await run.canUseTool("Read", { file_path: "/etc/hosts" });
      expect(read.behavior).toBe("allow");
      const bash = await run.canUseTool("Bash", {
        command: "touch notes.md",
        description: "Start notes",
      });
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
    expect(work?.model).toBe("claude-sonnet-5-5");
    expect(work?.effort).toBe("medium");
    expect(work?.input.tools).toBe(true);
    expect(work?.hubMcp.url).toBe("http://localhost/mcp");
    expect(work?.hubMcp.token).toMatch(/^los_/);
    // Agents start where the machine says, not in a folder of their own.
    expect(work?.cwd).toBe("/somewhere/anywhere");
    expect(work?.mcpServers?.notes).toEqual({ type: "stdio", command: "notes-mcp" });

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
    expect(first?.title).toBe("Coach wants to use Bash: touch notes.md");
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

  it("tells the hub which model ran", async () => {
    const complete = vi.spyOn(hub, "complete");
    script = async () => ({
      output: { summary: "ok" },
      sessionId: "session-model",
      usage: {},
      model: "claude-opus-5-5",
      effort: "high",
    });
    await gql("mutation($input: RunCreateInput!) { runCreate(input: $input) { run { id } } }", {
      input: { agentId, goal: "Check the model" },
    });
    expect(await runner.claim()).toBe(1);
    await runner.idle();
    const sent = complete.mock.calls.at(-1)?.[2];
    complete.mockRestore();
    expect(sent).toMatchObject({ model: "claude-opus-5-5", effort: "high" });
  });

  it("reports the plan's limits from sessions, and reads them while idle", async () => {
    const enrolment = await hub.enrol({
      name: "Plan machine",
      tags: [],
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
      engines: { claude: engine },
      capacity: 1,
      version: "test",
      cwd: tmpdir(),
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

  it("runs each agent on its own engine, and tells the hub which engines it has", async () => {
    const enrolment = await hub.enrol({ name: "Both", tags: [], capacity: 1, version: "test" });
    await gql(
      "mutation($id: String!, $code: String!) { machineApprove(id: $id, pairingCode: $code) { success } }",
      { id: enrolment.id, code: enrolment.pairingCode },
    );
    const ran: string[] = [];
    const done =
      (name: string): Engine =>
      async () => {
        ran.push(name);
        return { output: { outcome: "done", summary: "Done." }, sessionId: null, usage: {} };
      };
    const both = new Runner({
      hub,
      token: enrolment.token,
      engines: { claude: done("claude"), opencode: done("opencode") },
      capacity: 1,
      version: "test",
      cwd: tmpdir(),
      pollMs: 10,
      log: (line) => lines.push(line),
    });
    const pick = (engine: string) =>
      gql(
        "mutation($id: String!, $e: String!) { userUpdate(id: $id, input: { engine: $e }) { success } }",
        {
          id: agentId,
          e: engine,
        },
      );
    const work = async () => {
      await gql("mutation($input: RunCreateInput!) { runCreate(input: $input) { success } }", {
        input: { agentId, goal: "Work on whichever engine" },
      });
      expect(await both.claim()).toBe(1);
      await both.idle();
    };
    // Until it says it has OpenCode, the hub gives it only Claude agents' runs.
    await both.heartbeat();
    await pick("opencode");
    await work();
    await pick("claude");
    await work();
    expect(ran).toEqual(["opencode", "claude"]);
  });

  it("upgrades when the owner asks, once its runs finish", async () => {
    const enrolment = await hub.enrol({
      name: "Old machine",
      tags: [],
      capacity: 1,
      version: "test",
    });
    await gql(
      "mutation($id: String!, $code: String!) { machineApprove(id: $id, pairingCode: $code) { success } }",
      { id: enrolment.id, code: enrolment.pairingCode },
    );
    const old = new Runner({
      hub,
      token: enrolment.token,
      engines: { claude: engine },
      capacity: 1,
      version: "test",
      cwd: tmpdir(),
      pollMs: 10,
      heartbeatMs: 0,
      log: (line) => lines.push(line),
    });
    let finish = () => {};
    script = () =>
      new Promise((resolve) => {
        finish = () =>
          resolve({ output: { outcome: "done", summary: "Done." }, sessionId: null, usage: {} });
      });
    const runCreate = async (goal: string) =>
      (
        await gql<{ runCreate: { run: { id: string } } }>(
          "mutation($input: RunCreateInput!) { runCreate(input: $input) { run { id } } }",
          { input: { agentId, goal } },
        )
      ).runCreate.run.id;
    const first = await runCreate("Finish this first");
    const ended = old.run();
    await until(() => old.running.includes(first), "the run to start");

    await gql("mutation($id: String!) { machineUpgrade(id: $id) { success } }", {
      id: enrolment.id,
    });
    const next = await runCreate("Wait for the new runner");
    await until(() => lines.includes("Upgrading once the runs in progress finish…"), "the ask");
    finish();
    expect(await ended).toBe("upgrade");
    const queued = await gql<{ run: { status: string } }>(
      "query($id: String!) { run(id: $id) { status } }",
      { id: next },
    );
    expect(queued.run.status).toBe("queued");
  });
});
