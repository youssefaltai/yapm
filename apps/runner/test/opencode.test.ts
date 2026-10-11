import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { EngineRun } from "../src/engine.js";

// One fake `opencode serve` and its client; each test scripts what the model does.
type Event = { type: string; properties: Record<string, unknown> };
let spawned: { args: string[]; env: Record<string, string>; killed: boolean }[] = [];
let calls: Record<string, unknown[]> = {};
let parts: Record<string, unknown>[] = [];
let script: (push: (event: Event) => void) => void = () => {};
let push: (event: Event) => void = () => {};
const installs: string[][] = [];

vi.mock("node:child_process", () => ({
  spawnSync: (command: string, args: string[]) => {
    installs.push([command, ...args]);
    return { status: 0 };
  },
  spawn: (_bin: string, args: string[], options: { env: Record<string, string> }) => {
    const proc = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      kill: () => {
        record.killed = true;
      },
    });
    const record = { args, env: options.env, killed: false };
    spawned.push(record);
    setTimeout(() =>
      proc.stdout.emit("data", "opencode server listening on http://127.0.0.1:4096\n"),
    );
    return proc;
  },
}));

vi.mock("@opencode-ai/sdk/v2", () => ({
  createOpencodeClient: () => {
    const queue: Event[] = [];
    let wake = () => {};
    push = (event) => {
      queue.push(event);
      wake();
    };
    const log =
      (name: string, answer: (args: never) => unknown = () => ({})) =>
      async (args: never) => {
        calls[name] = [...(calls[name] ?? []), args];
        return { data: answer(args) };
      };
    return {
      event: {
        subscribe: async () => ({
          stream: (async function* () {
            for (;;) {
              while (queue.length) yield queue.shift() as Event;
              await new Promise<void>((resolve) => {
                wake = resolve;
              });
            }
          })(),
        }),
      },
      session: {
        create: log("create", () => ({ id: "ses_1" })),
        promptAsync: log("prompt", () => setTimeout(() => script(push))),
        message: log("message", () => ({ parts })),
        abort: log("abort", () => push(idle)),
        get: log("get", () => ({
          cost: 0.02,
          tokens: { input: 100, output: 10, reasoning: 5, cache: { read: 50, write: 0 } },
        })),
      },
      permission: { reply: log("reply") },
      provider: {
        list: log("providers", () => ({
          all: [{ id: "openai", models: { "gpt-5": { variants: { low: {}, high: {} } } } }],
        })),
      },
    };
  },
}));

const { installOpencode, opencodeEngine } = await import("../src/opencode.js");

const idle = { type: "session.idle", properties: { sessionID: "ses_1" } };
const part = (p: Record<string, unknown>) => ({
  type: "message.part.updated",
  properties: { sessionID: "ses_1", part: { sessionID: "ses_1", ...p } },
});
const ask = (id: string, permission: string, callID: string) => ({
  type: "permission.asked",
  properties: { id, sessionID: "ses_1", permission, tool: { messageID: "msg_1", callID } },
});
const structured = (output: unknown) => ({
  type: "message.updated",
  properties: { sessionID: "ses_1", info: { role: "assistant", structured: output } },
});

const run = (extra: Partial<EngineRun> = {}) =>
  ({
    input: {
      systemPrompt: "Be brief.",
      prompt: "Plan my week",
      outputSchema: {},
      tools: true,
      maxTurns: 5,
    },
    model: "claude-sonnet-5-5",
    modelTier: "standard",
    hubMcp: { url: "http://localhost/mcp", token: "los_test" },
    resume: null,
    cwd: "/tmp",
    signal: new AbortController().signal,
    canUseTool: async () => ({ behavior: "allow" }),
    onEvent: () => {},
    onSession: () => {},
    ...extra,
  }) as EngineRun;

const engine = (models = {}) => opencodeEngine({ bin: "/opt/opencode", home: "/h", models });

const start = (scripted: typeof script) => {
  spawned = [];
  calls = {};
  parts = [];
  script = scripted;
};
const config = () => JSON.parse(spawned[0]?.env.OPENCODE_CONFIG_CONTENT ?? "{}");

describe("opencode engine", () => {
  it("gives agents the hub's MCP server and the machine's, in OpenCode's shape", async () => {
    start((push) => push(idle));
    await engine()(
      run({
        mcpServers: {
          github: { type: "http", url: "https://gh.example/mcp", headers: { a: "b" } },
          files: { command: "npx", args: ["files-mcp"], env: { ROOT: "/" } },
        },
      }),
    );
    expect(config().mcp).toEqual({
      github: { type: "remote", url: "https://gh.example/mcp", headers: { a: "b" }, oauth: false },
      files: { type: "local", command: ["npx", "files-mcp"], environment: { ROOT: "/" } },
      yapm: {
        type: "remote",
        url: "http://localhost/mcp",
        headers: { authorization: "Bearer los_test" },
        oauth: false,
      },
    });
    expect(config().permission).toEqual({ "*": "ask", question: "deny" });
  });

  it("keeps the owner's OpenCode settings, project config and database out", async () => {
    start((push) => push(idle));
    await engine()(run());
    const env = spawned[0]?.env ?? {};
    expect(spawned[0]?.args).toEqual(["serve", "--hostname=127.0.0.1", "--port=0"]);
    expect(env.OPENCODE_DB).toBe("/h/opencode/opencode.db");
    expect(env.XDG_CONFIG_HOME).toBe("/h/opencode/config");
    expect(env.OPENCODE_DISABLE_PROJECT_CONFIG).toBe("1");
    expect(env.OPENCODE_DISABLE_CLAUDE_CODE).toBe("1");
    expect(env.OPENCODE_PURE).toBe("1");
    expect(env.PATH).toBe(process.env.PATH);
  });

  it("asks the runner about each call under Claude's tool names, once per call", async () => {
    const seen: [string, Record<string, unknown>][] = [];
    start((push) => {
      parts = [
        {
          type: "tool",
          callID: "c1",
          tool: "yapm_create_comment",
          state: { input: { body: "hi" } },
        },
        {
          type: "tool",
          callID: "c2",
          tool: "write",
          state: { input: { filePath: "/etc/x", content: "" } },
        },
        { type: "tool", callID: "c3", tool: "bash", state: { input: { command: "rm -rf /" } } },
      ];
      push(ask("p1", "yapm_create_comment", "c1"));
      push(ask("p2", "external_directory", "c2"));
      push(ask("p3", "edit", "c2"));
      push(ask("p4", "bash", "c3"));
      setTimeout(() => push(idle), 20);
    });
    await engine()(
      run({
        canUseTool: async (tool, input) => {
          seen.push([tool, input]);
          return tool === "Bash"
            ? { behavior: "deny", message: "Not that" }
            : { behavior: "allow" };
        },
      }),
    );
    expect(seen).toEqual([
      ["mcp__yapm__create_comment", { body: "hi" }],
      ["Write", { file_path: "/etc/x", content: "" }],
      ["Bash", { command: "rm -rf /" }],
    ]);
    expect(calls.reply).toEqual([
      { requestID: "p1", reply: "once" },
      { requestID: "p2", reply: "once" },
      { requestID: "p3", reply: "once" },
      { requestID: "p4", reply: "reject", message: "Not that" },
    ]);
  });

  it("gives a decision no tools but its structured answer, and returns that answer", async () => {
    start((push) => {
      push(structured({ act: true }));
      push(idle);
    });
    const result = await engine({ standard: "openai/gpt-5" })(
      run({ input: { ...run().input, tools: false }, effort: "high" }),
    );
    expect(result).toMatchObject({ output: { act: true }, sessionId: "ses_1" });
    expect(config().mcp).toBeUndefined();
    expect(calls.create?.[0]).toEqual({
      title: "Plan my week",
      permission: [
        { permission: "*", pattern: "*", action: "deny" },
        { permission: "StructuredOutput", pattern: "*", action: "allow" },
      ],
    });
    expect(calls.prompt?.[0]).toEqual({
      sessionID: "ses_1",
      model: { providerID: "openai", modelID: "gpt-5" },
      variant: "high",
      system: "Be brief.",
      format: { type: "json_schema", schema: {} },
      parts: [{ type: "text", text: "Plan my week" }],
    });
  });

  it("leaves the model and effort to OpenCode when the machine names none or the model lacks it", async () => {
    start((push) => push(idle));
    await engine()(run({ effort: "high" }));
    expect(calls.prompt?.[0]).not.toHaveProperty("model");
    expect(calls.prompt?.[0]).not.toHaveProperty("variant");
    start((push) => push(idle));
    await engine({ standard: "openai/gpt-5" })(run({ effort: "max" }));
    expect(calls.prompt?.[0]).not.toHaveProperty("variant");
  });

  it("streams the transcript and reports the session's usage", async () => {
    const events: Record<string, unknown>[] = [];
    start((push) => {
      push(part({ id: "t1", type: "text", text: "Thinking it over", time: { start: 1 } }));
      push(part({ id: "t1", type: "text", text: "Done.", time: { start: 1, end: 2 } }));
      push(
        part({
          id: "u1",
          type: "tool",
          callID: "c1",
          tool: "bash",
          state: { status: "completed", input: { command: "ls" }, output: "a\nb" },
        }),
      );
      push(part({ id: "s1", type: "step-finish" }));
      push(structured({ outcome: "done" }));
      push(idle);
    });
    const result = await engine()(run({ onEvent: (event) => events.push(event) }));
    expect(events).toEqual([
      { type: "text", text: "Done." },
      { type: "tool", id: "c1", name: "Bash", input: '{"command":"ls"}' },
      { type: "tool_result", id: "c1", error: false, text: "a\nb" },
      { type: "result", subtype: "success", turns: 1, costUsd: 0.02 },
    ]);
    expect(result.usage).toEqual({
      inputTokens: 150,
      outputTokens: 15,
      numTurns: 1,
      costUsd: 0.02,
    });
    expect(result.output).toEqual({ outcome: "done" });
  });

  it("stops the session when the run is stopped", async () => {
    const stop = new AbortController();
    start(() => stop.abort());
    const result = await engine()(run({ signal: stop.signal }));
    expect(calls.abort).toEqual([{ sessionID: "ses_1" }]);
    expect(result.error).toBeUndefined();
    expect(spawned[0]?.killed).toBe(true);
  });

  it("stops a session that runs past its turns", async () => {
    start((push) => {
      for (const id of ["s1", "s2"]) push(part({ id, type: "step-finish" }));
      push(part({ id: "s3", type: "step-start" }));
    });
    const result = await engine()(run({ input: { ...run().input, maxTurns: 2 } }));
    expect(calls.abort).toEqual([{ sessionID: "ses_1" }]);
    expect(result.error).toBe("The session ended early (error max turns)");
  });

  it("lets a session answer on its last turn", async () => {
    start((push) => {
      for (const id of ["s1", "s2"]) push(part({ id, type: "step-finish" }));
      push(structured({ outcome: "done" }));
      push(idle);
    });
    const result = await engine()(run({ input: { ...run().input, maxTurns: 2 } }));
    expect(calls.abort).toBeUndefined();
    expect(result).toMatchObject({ output: { outcome: "done" }, usage: { numTurns: 2 } });
    expect(result.error).toBeUndefined();
  });

  it("continues a session it is asked to resume", async () => {
    const sessions: string[] = [];
    start((push) => push(idle));
    const result = await engine()(run({ resume: "ses_1", onSession: (id) => sessions.push(id) }));
    expect(calls.create).toBeUndefined();
    expect(calls.prompt?.[0]).toMatchObject({ sessionID: "ses_1" });
    expect(result.sessionId).toBe("ses_1");
    expect(sessions).toEqual([]);
  });

  it("reports the session's error and closes the server", async () => {
    start((push) => {
      push({
        type: "session.error",
        properties: {
          sessionID: "ses_1",
          error: { name: "APIError", data: { message: "No credit" } },
        },
      });
      push(idle);
    });
    const result = await engine()(run());
    expect(result.error).toBe("No credit");
    expect(spawned[0]?.killed).toBe(true);
  });

  it("installs its own OpenCode only when it's missing or another version", () => {
    const home = mkdtempSync(join(tmpdir(), "runner-"));
    const bin = join(home, "opencode", "node_modules", ".bin", "opencode");
    expect(installOpencode(home, () => {})).toBe(bin);
    expect(installs.at(-1)).toEqual([
      "npm",
      "install",
      "--prefix",
      join(home, "opencode"),
      "--no-audit",
      "--no-fund",
      "--loglevel=error",
      "opencode-ai@1.19.0",
    ]);
    const pkg = join(home, "opencode", "node_modules", "opencode-ai");
    mkdirSync(pkg, { recursive: true });
    writeFileSync(join(pkg, "package.json"), '{"version":"1.19.0"}');
    installs.length = 0;
    expect(installOpencode(home, () => {})).toBe(bin);
    expect(installs).toEqual([]);
  });
});
