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
    expect(decide?.model).toBe("haiku");
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
    expect(work?.model).toBe("haiku");
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
});
