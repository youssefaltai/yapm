import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EngineRun } from "../src/engine.js";

// One fake `opencode serve` and its client; each test scripts what the model does.
type Event = { type: string; properties: Record<string, unknown> };
let spawned: {
  args: string[];
  env: Record<string, string>;
  killed: boolean;
  stderr: EventEmitter;
}[] = [];
let calls: Record<string, unknown[]> = {};
let parts: Record<string, unknown>[] = [];
let script: (push: (event: Event) => void) => void = () => {};
let push: (event: Event) => void = () => {};
const installs: string[][] = [];
// A stdio MCP server: answers JSON-RPC lines with the tools in `mcpTools`.
let mcpTools: Record<string, unknown>[] = [];
let mcpSpawns: { command: string[]; env: Record<string, string>; killed: boolean }[] = [];
const stdioMcp = (bin: string, args: string[], env: Record<string, string>) => {
  const record = { command: [bin, ...args], env, killed: false };
  mcpSpawns.push(record);
  const stdout = new EventEmitter();
  const answer = (id: unknown, result: unknown) =>
    setTimeout(() => stdout.emit("data", `${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`));
  return Object.assign(new EventEmitter(), {
    stdout,
    stdin: Object.assign(new EventEmitter(), {
      write: (line: string) => {
        const { id, method } = JSON.parse(line);
        if (method === "initialize") answer(id, { capabilities: {} });
        if (method === "tools/list") answer(id, { tools: mcpTools });
      },
    }),
    kill: () => {
      record.killed = true;
    },
  });
};
let authList = "";

vi.mock("node:child_process", () => ({
  spawnSync: (command: string, args: string[]) => {
    installs.push([command, ...args]);
    return { status: 0, stdout: authList };
  },
  spawn: (bin: string, args: string[], options: { env: Record<string, string> }) => {
    if (bin !== "/opt/opencode") return stdioMcp(bin, args, options.env);
    const proc = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      kill: () => {
        record.killed = true;
      },
    });
    const record = { args, env: options.env, killed: false, stderr: proc.stderr };
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
          all: [
            {
              id: "openai",
              name: "OpenAI",
              models: {
                "gpt-5": { id: "gpt-5", name: "GPT-5", variants: { low: {}, high: {} } },
                "gpt-4": { id: "gpt-4", name: "GPT-4", status: "deprecated" },
                "gpt-5-mini": { id: "gpt-5-mini", name: "GPT-5 Mini" },
                "dall-e": { id: "dall-e", name: "DALL·E", capabilities: { toolcall: false } },
              },
            },
            { id: "deepseek", name: "DeepSeek", models: { "deepseek-v4": { id: "deepseek-v4" } } },
          ],
          connected: ["openai"],
        })),
      },
    };
  },
}));

const { installOpencode, opencodeEngine, opencodeModels, opencodeProviders } = await import(
  "../src/opencode.js"
);

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
    provider: "openai",
    model: "gpt-5",
    hubMcp: { url: "http://localhost/mcp", token: "los_test" },
    resume: null,
    cwd: "/tmp",
    signal: new AbortController().signal,
    canUseTool: async () => ({ behavior: "allow" }),
    onEvent: () => {},
    onSession: () => {},
    ...extra,
  }) as EngineRun;

const engine = () => opencodeEngine({ bin: "/opt/opencode", home: "/h" });

const start = (scripted: typeof script) => {
  spawned = [];
  calls = {};
  parts = [];
  script = scripted;
};
const config = () => JSON.parse(spawned[0]?.env.OPENCODE_CONFIG_CONTENT ?? "{}");

describe("opencode engine", () => {
  // No MCP server answers unless a test says so.
  beforeEach(() =>
    vi.stubGlobal("fetch", async () => {
      throw new Error("offline");
    }),
  );
  afterEach(() => vi.unstubAllGlobals());

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
    // Pure mode would skip the runner's own plugin, the only one there is.
    expect(env.OPENCODE_PURE).toBeUndefined();
    expect(config().plugin).toEqual(["file:///h/opencode/plan.js"]);
    expect(env.PATH).toBe(process.env.PATH);
  });

  it("passes on the plan readings its plugin prints", async () => {
    const onPlan = vi.fn();
    start((push) => {
      spawned[0]?.stderr.emit(
        "data",
        'INFO noise\nyapm-plan {"x-codex-plan-type":"plus","x-codex-primary-used-percent":"40"}\n',
      );
      push(idle);
    });
    await engine()(run({ onPlan }));
    expect(onPlan).toHaveBeenCalledTimes(1);
    expect(onPlan.mock.calls[0]?.[0]).toMatchObject({
      plan: { provider: "chatgpt", name: "plus", usage: { limits: [{ utilization: 40 }] } },
    });
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
    // An MCP call first lists its server's tools, so it may be answered later.
    expect(seen).toHaveLength(3);
    expect(seen).toEqual(
      expect.arrayContaining([
        ["mcp__yapm__create_comment", { body: "hi" }],
        ["Write", { file_path: "/etc/x", content: "" }],
        ["Bash", { command: "rm -rf /" }],
      ]),
    );
    expect(calls.reply).toHaveLength(4);
    expect(calls.reply).toEqual(
      expect.arrayContaining([
        { requestID: "p1", reply: "once" },
        { requestID: "p2", reply: "once" },
        { requestID: "p3", reply: "once" },
        { requestID: "p4", reply: "reject", message: "Not that" },
      ]),
    );
  });

  it("gives a decision no tools but its structured answer, and returns that answer", async () => {
    start((push) => {
      push(structured({ act: true }));
      push(idle);
    });
    const result = await engine()(run({ input: { ...run().input, tools: false }, effort: "high" }));
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
      format: { type: "json_schema", schema: {} },
      parts: [{ type: "text", text: "Plan my week" }],
    });
  });

  it("leaves the model to OpenCode when an older hub names no provider, and drops an effort the model lacks", async () => {
    start((push) => push(idle));
    await engine()(run({ provider: undefined, model: "claude-sonnet-5-5", effort: "high" }));
    expect(calls.prompt?.[0]).not.toHaveProperty("model");
    expect(calls.prompt?.[0]).not.toHaveProperty("variant");
    start((push) => push(idle));
    await engine()(run({ effort: "max" }));
    expect(calls.prompt?.[0]).toMatchObject({ model: { providerID: "openai", modelID: "gpt-5" } });
    expect(calls.prompt?.[0]).not.toHaveProperty("variant");
  });

  it("lists the signed-in providers' models that can run agents, with their efforts", async () => {
    const { createOpencodeClient } = await import("@opencode-ai/sdk/v2");
    const client = createOpencodeClient({ baseUrl: "http://127.0.0.1:4096" });
    expect(await opencodeModels(client)).toEqual([
      {
        id: "openai",
        name: "OpenAI",
        models: [
          { id: "gpt-5", name: "GPT-5", efforts: ["low", "high"] },
          { id: "gpt-5-mini", name: "GPT-5 Mini", efforts: [] },
        ],
      },
    ]);
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

  it("makes the system prompt the whole of the agent's, not added to OpenCode's own", async () => {
    start((push) => push(idle));
    await engine()(
      run({ input: { ...run().input, systemPrompt: "Be brief. {env:HOME} {file:~/.ssh/id}" } }),
    );
    expect(config().agent).toEqual({
      build: { prompt: "Be brief. {env:HOME} {file:~/.ssh/id}" },
    });
    expect(calls.prompt?.[0]).not.toHaveProperty("system");
    // OpenCode fills `{env:…}` and `{file:…}` in its config text; ours is only ever text.
    expect(spawned[0]?.env.OPENCODE_CONFIG_CONTENT).not.toMatch(/\{(env|file):/);
  });

  it("tells the runner which MCP tools only read, listing each server once", async () => {
    const posts: { headers: Record<string, string>; body: { id?: number; method: string } }[] = [];
    vi.stubGlobal(
      "fetch",
      async (url: string, init: { headers: Record<string, string>; body: string }) => {
        expect(url).toBe("https://gh.example/mcp");
        const body = JSON.parse(init.body);
        posts.push({ headers: init.headers, body });
        const reply = (result: unknown) => JSON.stringify({ jsonrpc: "2.0", id: body.id, result });
        if (body.method === "initialize")
          return new Response(reply({ capabilities: {} }), { headers: { "mcp-session-id": "s1" } });
        if (body.method === "tools/list")
          // Streamable HTTP may answer with an event stream.
          return new Response(
            `event: message\ndata: ${reply({
              tools: [
                { name: "search", annotations: { readOnlyHint: true } },
                { name: "create_issue" },
              ],
            })}\n\n`,
            { headers: { "content-type": "text/event-stream" } },
          );
        return new Response(null, { status: 202 });
      },
    );
    const seen: [string, boolean | undefined][] = [];
    start((push) => {
      parts = [
        { type: "tool", callID: "c1", tool: "github_search", state: { input: { q: "a" } } },
        { type: "tool", callID: "c2", tool: "github_search", state: { input: { q: "b" } } },
        { type: "tool", callID: "c3", tool: "github_create_issue", state: { input: {} } },
        { type: "tool", callID: "c4", tool: "bash", state: { input: { command: "ls -la" } } },
      ];
      push(ask("p1", "github_search", "c1"));
      setTimeout(() => push(ask("p2", "github_search", "c2")), 10);
      setTimeout(() => push(ask("p3", "github_create_issue", "c3")), 20);
      setTimeout(() => push(ask("p4", "bash", "c4")), 30);
      setTimeout(() => push(idle), 50);
    });
    await engine()(
      run({
        mcpServers: {
          github: { type: "http", url: "https://gh.example/mcp", headers: { a: "b" } },
        },
        canUseTool: async (tool, _input, readOnly) => {
          seen.push([tool, readOnly]);
          return { behavior: "allow" };
        },
      }),
    );
    expect(seen).toEqual([
      ["mcp__github__search", true],
      ["mcp__github__search", true],
      ["mcp__github__create_issue", false],
      ["Bash", false],
    ]);
    expect(posts.map((p) => p.body.method)).toEqual([
      "initialize",
      "notifications/initialized",
      "tools/list",
    ]);
    expect(posts[2]?.headers).toMatchObject({ a: "b", "mcp-session-id": "s1" });
  });

  it("lists a local MCP server's tools from a copy of it, and closes that copy", async () => {
    mcpSpawns = [];
    mcpTools = [{ name: "read_file", annotations: { readOnlyHint: true } }];
    const seen: [string, boolean | undefined][] = [];
    start((push) => {
      parts = [{ type: "tool", callID: "c1", tool: "files_read_file", state: { input: {} } }];
      push(ask("p1", "files_read_file", "c1"));
      setTimeout(() => push(idle), 20);
    });
    await engine()(
      run({
        mcpServers: { files: { command: "npx", args: ["files-mcp"], env: { ROOT: "/" } } },
        canUseTool: async (tool, _input, readOnly) => {
          seen.push([tool, readOnly]);
          return { behavior: "allow" };
        },
      }),
    );
    expect(seen).toEqual([["mcp__files__read_file", true]]);
    expect(mcpSpawns).toMatchObject([{ command: ["npx", "files-mcp"], killed: true }]);
    expect(mcpSpawns[0]?.env.ROOT).toBe("/");
  });

  it("treats an MCP tool as one that writes when its server can't be listed", async () => {
    const seen: (boolean | undefined)[] = [];
    start((push) => {
      parts = [{ type: "tool", callID: "c1", tool: "yapm_list_issues", state: { input: {} } }];
      push(ask("p1", "yapm_list_issues", "c1"));
      setTimeout(() => push(idle), 20);
    });
    await engine()(
      run({
        canUseTool: async (_tool, _input, readOnly) => {
          seen.push(readOnly);
          return { behavior: "allow" };
        },
      }),
    );
    expect(seen).toEqual([false]);
    expect(calls.reply).toEqual([{ requestID: "p1", reply: "once" }]);
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
    expect(result.error).toBe("Token expired. Run: yapm-runner login");
  });

  it("names the providers OpenCode is signed in to, as owners know them", () => {
    authList = "┌  Credentials ~/.local/share/opencode/auth.json\n│\n└  0 credentials\n";
    expect(opencodeProviders("/opt/opencode", "/h")).toEqual([]);
    expect(installs.at(-1)).toEqual(["/opt/opencode", "auth", "list"]);
    authList += "┌  Environment\n│\n●  DeepSeek DEEPSEEK_API_KEY\n│\n└  1 environment variable\n";
    expect(opencodeProviders("/opt/opencode", "/h")).toEqual(["DeepSeek"]);
    // As printed, colours and all.
    authList =
      "\u001b[0m\n┌  Credentials \u001b[90m~/.local/share/opencode/auth.json\n│\n●  OpenAI \u001b[90moauth\n│\n" +
      "●  GitHub Copilot \u001b[90moauth\n│\n●  OpenAI \u001b[90mapi\n│\n└  3 credentials\n";
    expect(opencodeProviders("/opt/opencode", "/h")).toEqual(["ChatGPT", "Copilot", "OpenAI"]);
  });

  it("installs its own OpenCode only when it's missing or another version", () => {
    const home = mkdtempSync(join(tmpdir(), "runner-"));
    const bin = join(home, "opencode", "node_modules", ".bin", "opencode");
    const said: string[] = [];
    expect(installOpencode(home, (line) => said.push(line))).toBe(bin);
    expect(said.join("\n")).not.toMatch(/OpenCode/);
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

  it("installs a plugin that prints only the plan's headers, once per response", async () => {
    const home = mkdtempSync(join(tmpdir(), "runner-"));
    installOpencode(home, () => {});
    const { YapmPlan } = await import(join(home, "opencode", "plan.js"));
    const real = globalThis.fetch;
    const lines: string[] = [];
    const write = vi.spyOn(process.stderr, "write").mockImplementation((line) => {
      lines.push(String(line));
      return true;
    });
    globalThis.fetch = async () =>
      new Response("{}", {
        headers: {
          "x-codex-primary-used-percent": "40",
          "x-codex-turn-state": "secret-ish",
          "set-cookie": "a=b",
        },
      });
    try {
      // Loaded twice, it still wraps fetch once.
      await YapmPlan();
      await YapmPlan();
      const response = await fetch("https://chatgpt.com/backend-api/codex/responses");
      expect(await response.text()).toBe("{}");
    } finally {
      globalThis.fetch = real;
      write.mockRestore();
    }
    expect(lines).toEqual(['yapm-plan {"x-codex-primary-used-percent":"40"}\n']);
  });
});
