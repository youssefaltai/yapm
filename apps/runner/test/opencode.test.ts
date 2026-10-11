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
let authList = "";

vi.mock("node:child_process", () => ({
  spawnSync: (command: string, args: string[]) => {
    installs.push([command, ...args]);
    return { status: 0, stdout: authList };
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
        promptAsync: log("prompt", ({ sessionID }: { sessionID: string }) => {
          if (sessionID === "ses_gone") throw new Error("Session not found");
          setTimeout(() => script(push));
        }),
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

const { installOpencode, opencodeEngine, opencodeSignedIn } = await import("../src/opencode.js");

const idle = { type: "session.idle", properties: { sessionID: "ses_1" } };
const part = (p: Record<string, unknown>, sessionID = "ses_1") => ({
  type: "message.part.updated",
  properties: { sessionID, part: { sessionID, ...p } },
});
const ask = (id: string, permission: string, callID: string, sessionID = "ses_1") => ({
  type: "permission.asked",
  properties: { id, sessionID, permission, tool: { messageID: "msg_1", callID } },
});
const created = (id: string, parentID?: string) => ({
  type: "session.created",
  properties: { sessionID: id, info: { id, parentID } },
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

  it("reports the model and variant the session ran with", async () => {
    const assistant = (variant?: string) => ({
      type: "message.updated",
      properties: {
        sessionID: "ses_1",
        info: { role: "assistant", providerID: "openai", modelID: "gpt-6-sol", variant },
      },
    });
    start((push) => {
      push(assistant("high"));
      push(idle);
    });
    expect(await engine()(run())).toMatchObject({ model: "openai/gpt-6-sol", effort: "high" });
    start((push) => {
      push(assistant());
      push(idle);
    });
    expect(await engine()(run())).toMatchObject({ model: "openai/gpt-6-sol", effort: null });
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

  it("shows each call in the transcript with Claude's input names, as soon as it runs", async () => {
    const events: Record<string, unknown>[] = [];
    const tool = (callID: string, name: string, state: Record<string, unknown>) =>
      part({ id: callID, type: "tool", callID, tool: name, state });
    start((push) => {
      const edit = { filePath: "/tmp/a", oldString: "a", newString: "b", replaceAll: true };
      push(tool("c1", "edit", { status: "pending", input: {} }));
      push(tool("c1", "edit", { status: "running", input: edit }));
      push(tool("c1", "edit", { status: "running", input: edit, title: "a" }));
      push(tool("c1", "edit", { status: "completed", input: edit, output: "Edited" }));
      push(
        tool("c2", "grep", {
          status: "error",
          input: { pattern: "x", include: "*.ts" },
          error: "No",
        }),
      );
      push(idle);
    });
    await engine()(run({ onEvent: (event) => events.push(event) }));
    expect(events.slice(0, 4)).toEqual([
      {
        type: "tool",
        id: "c1",
        name: "Edit",
        input: '{"file_path":"/tmp/a","old_string":"a","new_string":"b","replace_all":true}',
      },
      { type: "tool_result", id: "c1", error: false, text: "Edited" },
      { type: "tool", id: "c2", name: "Grep", input: '{"pattern":"x","glob":"*.ts"}' },
      { type: "tool_result", id: "c2", error: true, text: "No" },
    ]);
  });

  it("asks about and shows a patch as Claude's edits, one per file", async () => {
    const seen: [string, Record<string, unknown>][] = [];
    const events: Record<string, unknown>[] = [];
    const patchText = [
      "*** Begin Patch",
      "*** Update File: a.txt",
      "@@",
      " keep",
      "-hello",
      "+bye",
      "*** Add File: /tmp/b.txt",
      "+new",
      "*** End Patch",
    ].join("\n");
    start((push) => {
      parts = [
        { type: "tool", callID: "c1", tool: "apply_patch", state: { input: { patchText } } },
      ];
      push(ask("p1", "edit", "c1"));
      push(
        part({
          id: "c1",
          type: "tool",
          callID: "c1",
          tool: "apply_patch",
          state: { status: "running", input: { patchText } },
        }),
      );
      setTimeout(() => push(idle), 20);
    });
    await engine()(
      run({
        cwd: "/w",
        onEvent: (event) => events.push(event),
        canUseTool: async (tool, input) => {
          seen.push([tool, input]);
          return { behavior: "allow" };
        },
      }),
    );
    expect(seen).toEqual([
      ["Edit", { file_path: "/w/a.txt", old_string: "keep\nhello", new_string: "keep\nbye" }],
      ["Write", { file_path: "/tmp/b.txt", content: "new" }],
    ]);
    expect(events[0]).toEqual({
      type: "tool",
      id: "c1",
      name: "Edit",
      input: JSON.stringify({
        file_path: "/w/a.txt",
        old_string: "keep\nhello",
        new_string: "keep\nbye",
        files: ["/w/a.txt", "/tmp/b.txt"],
      }),
    });
  });

  it("answers, shows and counts its subagents' sessions, and no one else's", async () => {
    const seen: string[] = [];
    const events: Record<string, unknown>[] = [];
    start((push) => {
      parts = [
        { type: "tool", callID: "c1", tool: "bash", state: { input: { command: "touch x" } } },
      ];
      push(created("ses_2", "ses_1"));
      push(created("ses_3", "ses_2"));
      push(created("ses_9", "ses_8"));
      push(ask("p1", "bash", "c1", "ses_3"));
      push(ask("p9", "bash", "c1", "ses_9"));
      push(part({ id: "x", type: "text", text: "Sub done.", time: { start: 1, end: 2 } }, "ses_3"));
      push(part({ id: "s", type: "step-finish" }, "ses_3"));
      push(part({ id: "y", type: "text", text: "Not mine.", time: { start: 1, end: 2 } }, "ses_9"));
      setTimeout(() => push(idle), 20);
    });
    const result = await engine()(
      run({
        onEvent: (event) => events.push(event),
        canUseTool: async (tool) => {
          seen.push(tool);
          return { behavior: "allow" };
        },
      }),
    );
    expect(seen).toEqual(["Bash"]);
    expect(calls.message).toEqual([{ sessionID: "ses_3", messageID: "msg_1" }]);
    expect(calls.reply).toEqual([{ requestID: "p1", reply: "once" }]);
    expect(events.filter((e) => e.type === "text")).toEqual([{ type: "text", text: "Sub done." }]);
    expect(calls.get).toHaveLength(3);
    expect(result.usage).toEqual({
      inputTokens: 450,
      outputTokens: 45,
      numTurns: 0,
      costUsd: 0.06,
    });
  });

  it("ends the transcript with a result when the run fails", async () => {
    const events: Record<string, unknown>[] = [];
    start(() => {});
    const result = await engine()(
      run({ resume: "ses_gone", onEvent: (event) => events.push(event) }),
    );
    expect(result.error).toBe("Session not found");
    expect(events).toEqual([{ type: "result", subtype: "error", turns: 0, costUsd: 0 }]);
  });

  it("tells the owner to sign in again when the provider refuses the sign-in", async () => {
    start((push) => {
      const data = { providerID: "openai", message: "Token expired." };
      const error = { name: "ProviderAuthError", data };
      push({ type: "session.error", properties: { sessionID: "ses_1", error } });
      push(idle);
    });
    const result = await engine()(run());
    expect(result.error).toBe("Token expired. Run: yapm-runner login --opencode");
  });

  it("knows whether OpenCode has a provider to run on", () => {
    authList = "┌  Credentials ~/.local/share/opencode/auth.json\n│\n└  0 credentials\n";
    expect(opencodeSignedIn("/opt/opencode", "/h")).toBe(false);
    expect(installs.at(-1)).toEqual(["/opt/opencode", "auth", "list"]);
    authList += "┌  Environment\n│\n●  OpenAI OPENAI_API_KEY\n│\n└  1 environment variable\n";
    expect(opencodeSignedIn("/opt/opencode", "/h")).toBe(true);
    authList = "●  OpenAI oauth\n│\n└  2 credentials\n";
    expect(opencodeSignedIn("/opt/opencode", "/h")).toBe(true);
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
