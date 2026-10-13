import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { stripVTControlCharacters } from "node:util";
import {
  createOpencodeClient,
  type Event,
  type PermissionRequest,
  type Session,
} from "@opencode-ai/sdk/v2";
import type { Engine, EngineResult, EngineRun } from "./engine.js";
import type { ProviderModels } from "./hub.js";
import { HUB_MCP, type ToolDecision } from "./permissions.js";
import { planFromHeaders } from "./plan.js";

export interface OpencodeOptions {
  /** The pinned `opencode` binary; never the one on PATH, which may be an incompatible 2.x. */
  bin: string;
  /** The runner's home; OpenCode's settings and sessions live in its `opencode` folder. */
  home: string;
}

/** The OpenCode line the SDK speaks; 2.x has another API. */
const VERSION = "1.19.0";

/**
 * An OpenCode plugin that prints a provider response's plan headers (ChatGPT's `x-codex-*`,
 * Copilot's `x-quota-snapshot-*`) for the runner. OpenCode surfaces neither, and has no hook
 * for response headers, so it wraps `fetch`; it reads no sign-in and makes no calls of its own.
 */
const PLAN_PLUGIN = `const PLAN = /^x-(codex-(primary|secondary)-|codex-plan-type$|quota-snapshot-)/;
export const YapmPlan = async () => {
  const fetch = globalThis.fetch;
  if (!fetch.yapmPlan) {
    globalThis.fetch = Object.assign(async (...args) => {
      const response = await fetch(...args);
      try {
        const plan = {};
        response.headers.forEach((value, name) => {
          if (PLAN.test(name)) plan[name] = value;
        });
        if (Object.keys(plan).length) process.stderr.write("yapm-plan " + JSON.stringify(plan) + "\\n");
      } catch {}
      return response;
    }, { yapmPlan: true });
  }
  return {};
};
`;
const planPlugin = (home: string) => join(home, "opencode", "plan.js");

/**
 * Installs OpenCode into the runner's home unless that version is there, and returns its binary.
 * It's ~145 MB, so only machines that use it get it.
 */
export function installOpencode(home: string, log: (line: string) => void): string {
  const prefix = join(home, "opencode");
  mkdirSync(prefix, { recursive: true });
  writeFileSync(planPlugin(home), PLAN_PLUGIN);
  const bin = join(prefix, "node_modules", ".bin", "opencode");
  try {
    const pkg = join(prefix, "node_modules", "opencode-ai", "package.json");
    if (JSON.parse(readFileSync(pkg, "utf8")).version === VERSION) return bin;
  } catch {}
  log("Getting ready for ChatGPT, Copilot and other providers (once, about 150 MB)…");
  const args = ["install", "--prefix", prefix, "--no-audit", "--no-fund", "--loglevel=error"];
  // The npm next to the runner's Node, which its postinstall needs on PATH too.
  const PATH = `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ""}`;
  const install = spawnSync("npm", [...args, `opencode-ai@${VERSION}`], {
    stdio: "inherit",
    env: { ...process.env, PATH },
  });
  if (install.status !== 0) throw new Error("Couldn't install OpenCode.");
  return bin;
}

const LOGIN_HINT = "Run: yapm-runner login";

/** The providers OpenCode is signed in to or has a key for, by the names owners know. */
export function opencodeProviders(bin: string, home: string): string[] {
  const list = spawnSync(bin, ["auth", "list"], { env: opencodeEnv(home), encoding: "utf8" });
  // `●  OpenAI oauth`, greyed: a provider, then how it signs in (or its variable).
  const lines = stripVTControlCharacters(list.stdout ?? "").split("\n");
  const names = lines.flatMap((line) => {
    const [, name, how] = /^●\s+(.+?)\s+(\S+)$/.exec(line.trim()) ?? [];
    if (!name) return [];
    if (how === "oauth") return [{ OpenAI: "ChatGPT", "GitHub Copilot": "Copilot" }[name] ?? name];
    return [name];
  });
  return [...new Set(names)];
}

/** Signs in to a provider with OpenCode's own flow: ChatGPT, Copilot, an API key and more. */
export function opencodeLogin(home: string, log: (line: string) => void): boolean {
  const login = spawnSync(installOpencode(home, log), ["auth", "login"], {
    stdio: "inherit",
    env: opencodeEnv(home),
  });
  log(login.status === 0 ? "Signed in." : `Not signed in yet. ${LOGIN_HINT}`);
  return login.status === 0;
}

/**
 * The providers signed in here and their models that can run agents (they need tools), with
 * each model's variants as its efforts.
 */
export async function opencodeModels(
  client: Pick<ReturnType<typeof createOpencodeClient>, "provider">,
): Promise<ProviderModels[]> {
  const { all = [], connected = [] } = (await client.provider.list()).data ?? {};
  return all
    .filter((p) => connected.includes(p.id))
    .map((p) => ({
      id: p.id,
      name: p.name,
      models: Object.values(p.models)
        .filter((m) => m.status !== "deprecated" && m.capabilities?.toolcall !== false)
        .map((m) => ({ id: m.id, name: m.name, efforts: Object.keys(m.variants ?? {}) })),
    }));
}

/**
 * A short-lived OpenCode server for setting providers up; it keeps sign-ins in its own store.
 * Closed when `use` is done, or the runner exits.
 */
export async function withOpencodeServer<T>(
  home: string,
  log: (line: string) => void,
  use: (client: ReturnType<typeof createOpencodeClient>) => Promise<T>,
): Promise<T> {
  const server = serve(installOpencode(home, log), home, opencodeEnv(home), () => {});
  process.on("exit", server.close);
  try {
    return await use(createOpencodeClient({ baseUrl: await server.url, directory: home }));
  } finally {
    server.close();
    process.off("exit", server.close);
  }
}

const clip = (text: string, max = 4000) => (text.length > max ? `${text.slice(0, max)}…` : text);

/**
 * Keeps agents off the owner's own OpenCode settings, project files and database, and off the
 * runner's Claude API key, which OpenCode would count as an Anthropic sign-in.
 */
export function opencodeEnv(home: string, config: Record<string, unknown> = {}) {
  const { ANTHROPIC_API_KEY: _, ...env } = process.env;
  return {
    ...env,
    // OpenCode fills `{env:…}` and `{file:…}` in config text; escaped, ours stays text.
    OPENCODE_CONFIG_CONTENT: JSON.stringify(config).replace(/\{(env|file):/g, "\\u007b$1:"),
    XDG_CONFIG_HOME: join(home, "opencode", "config"),
    OPENCODE_DB: join(home, "opencode", "opencode.db"),
    // Flags take 1 or 0: an empty value crashes the server.
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    OPENCODE_DISABLE_CLAUDE_CODE: "1",
    OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    // Not OPENCODE_PURE: it skips the runner's plan plugin, and the owner's plugins stay out
    // anyway with their config folder.
  };
}

/** Claude Code's `mcpServers` shape as OpenCode's `mcp` config. */
function mcpConfig(servers: NonNullable<EngineRun["mcpServers"]>) {
  const mcp: Record<string, unknown> = {};
  for (const [name, s] of Object.entries(servers)) {
    if (s.type === "sdk") continue;
    mcp[name] =
      "url" in s
        ? { type: "remote", url: s.url, headers: s.headers ?? {}, oauth: false }
        : { type: "local", command: [s.command, ...(s.args ?? [])], environment: s.env ?? {} };
  }
  return mcp;
}

type McpServer = Exclude<NonNullable<EngineRun["mcpServers"]>[string], { type: "sdk" }>;
type Rpc = (message: { id?: number; method: string; params?: unknown }) => Promise<unknown>;

const LIST_TIMEOUT = 10_000;

/** JSON-RPC over MCP's Streamable HTTP: a JSON answer, or an event stream that carries it. */
function httpRpc(server: Extract<McpServer, { url: string }>): Rpc {
  let session: string | null = null;
  return async (message) => {
    const response = await fetch(server.url, {
      method: "POST",
      headers: {
        ...server.headers,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(session ? { "mcp-session-id": session } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", ...message }),
      signal: AbortSignal.timeout(LIST_TIMEOUT),
    });
    session = response.headers.get("mcp-session-id") ?? session;
    const text = await response.text();
    const lines = text.trimStart().startsWith("{")
      ? [text]
      : text.split("\n").flatMap((line) => (line.startsWith("data:") ? [line.slice(5)] : []));
    return lines.map((line) => JSON.parse(line)).find((m) => m.id === message.id);
  };
}

/** JSON-RPC over a stdio server's lines. */
function stdioRpc(
  server: Exclude<McpServer, { url: string }>,
  cwd: string,
  close: AbortSignal,
): Rpc {
  const proc = spawn(server.command, server.args ?? [], {
    cwd,
    env: { ...process.env, ...server.env },
    stdio: ["pipe", "pipe", "ignore"],
  });
  close.addEventListener("abort", () => proc.kill());
  const waiting = new Map<unknown, (message: unknown) => void>();
  let rest = "";
  proc.stdout?.on("data", (chunk: unknown) => {
    const lines = (rest + String(chunk)).split("\n");
    rest = lines.pop() ?? "";
    for (const line of lines)
      try {
        const message = JSON.parse(line);
        waiting.get(message.id)?.(message);
      } catch {}
  });
  const ended = new Promise<never>((_, reject) => {
    proc.on("error", reject);
    proc.stdin?.on("error", reject);
    proc.on("exit", () => reject(new Error("The MCP server exited")));
    AbortSignal.timeout(LIST_TIMEOUT).addEventListener("abort", () =>
      reject(new Error("Timed out")),
    );
  });
  ended.catch(() => {});
  return (message) => {
    proc.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
    if (message.id === undefined) return Promise.resolve();
    return Promise.race([new Promise((resolve) => waiting.set(message.id, resolve)), ended]);
  };
}

/**
 * The names of an MCP server's tools that say they only read (`readOnlyHint`). OpenCode drops
 * MCP annotations, so the runner asks the server itself; a local server is a copy, then closed.
 */
async function readOnlyTools(server: McpServer, cwd: string): Promise<Set<string>> {
  const close = new AbortController();
  const rpc = "url" in server ? httpRpc(server) : stdioRpc(server, cwd, close.signal);
  let id = 0;
  const call = async (method: string, params: unknown) => {
    const answer = (await rpc({ id: ++id, method, params })) as { result?: unknown } | undefined;
    if (!answer?.result) throw new Error(`MCP ${method} failed`);
    return answer.result as {
      tools?: { name: string; annotations?: { readOnlyHint?: boolean } }[];
      nextCursor?: string;
    };
  };
  try {
    await call("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "yapm-runner", version: "1" },
    });
    await rpc({ method: "notifications/initialized" });
    const names = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = await call("tools/list", cursor ? { cursor } : {});
      for (const tool of page.tools ?? [])
        if (tool.annotations?.readOnlyHint === true) names.add(tool.name);
      cursor = page.nextCursor;
    } while (cursor);
    return names;
  } finally {
    close.abort();
  }
}

const TOOLS: Record<string, string> = {
  bash: "Bash",
  read: "Read",
  write: "Write",
  edit: "Edit",
  apply_patch: "Edit",
  glob: "Glob",
  grep: "Grep",
  webfetch: "WebFetch",
  websearch: "WebSearch",
  todowrite: "TodoWrite",
  task: "Task",
  skill: "Skill",
};

type Call = { name: string; input: Record<string, unknown> };

/** A patch's files as Claude's calls: a new file is a Write, any other change an Edit. */
function patchCalls(patch: string, cwd: string): Call[] {
  const files: { path: string; add: boolean; old: string[]; new: string[] }[] = [];
  for (const line of patch.split("\n")) {
    const header = /^\*\*\* (?:(Add)|Update|Delete) File: (.+)$|^\*\*\* Move to: (.+)$/.exec(line);
    const file = files.at(-1);
    if (header) {
      const path = resolve(cwd, (header[2] ?? header[3] ?? "").trim());
      files.push({ path, add: Boolean(header[1]), old: [], new: [] });
    } else if (file && /^[-+ ]/.test(line)) {
      if (line[0] !== "+") file.old.push(line.slice(1));
      if (line[0] !== "-") file.new.push(line.slice(1));
    }
  }
  return files.map((f) =>
    f.add
      ? { name: "Write", input: { file_path: f.path, content: f.new.join("\n") } }
      : {
          name: "Edit",
          input: { file_path: f.path, old_string: f.old.join("\n"), new_string: f.new.join("\n") },
        },
  );
}

/**
 * OpenCode's tool call as Claude Code's, which the runner's grants and the app's transcript are
 * written in: `filePath` becomes `file_path`. A patch is one call per file it changes.
 */
function claudeCalls(tool: string, input: Record<string, unknown>, servers: string[], cwd: string) {
  if (tool === "apply_patch") {
    const calls = patchCalls(String(input.patchText ?? ""), cwd);
    return calls.length ? calls : [{ name: "Edit", input }];
  }
  const name = TOOLS[tool];
  if (name) {
    const key = (k: string) =>
      k === "include" ? "glob" : k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
    return [
      { name, input: Object.fromEntries(Object.entries(input).map(([k, v]) => [key(k), v])) },
    ];
  }
  // MCP tools are `<server>_<tool>`, and either may hold `_`, so match the known servers.
  const server = servers.find((s) => tool.startsWith(`${s}_`));
  return [{ name: server ? `mcp__${server}__${tool.slice(server.length + 1)}` : tool, input }];
}

/** One call for the transcript; a patch shows its first file and lists them all. */
function transcriptCall(calls: Call[]): Call {
  const [first = { name: "", input: {} }] = calls;
  if (calls.length < 2) return first;
  return { ...first, input: { ...first.input, files: calls.map((c) => c.input.file_path) } };
}

/**
 * Starts `opencode serve` for one run; resolves once it listens. Hands on each line the plan
 * plugin prints.
 */
function serve(bin: string, cwd: string, env: NodeJS.ProcessEnv, onPlan: (line: string) => void) {
  const proc = spawn(bin, ["serve", "--hostname=127.0.0.1", "--port=0"], { cwd, env });
  let errors = "";
  proc.stderr?.on("data", (chunk: unknown) => {
    const lines = (errors + String(chunk)).split("\n");
    errors = lines.pop() ?? "";
    for (const line of lines) if (line.startsWith("yapm-plan ")) onPlan(line.slice(10));
  });
  const url = new Promise<string>((resolve, reject) => {
    let out = "";
    const read = (chunk: unknown) => {
      out += String(chunk);
      const listening = /listening on (https?:\/\/\S+)/.exec(out);
      if (!listening?.[1]) return;
      resolve(listening[1]);
      proc.stdout?.off("data", read);
      proc.stderr?.off("data", read);
    };
    proc.stdout?.on("data", read);
    proc.stderr?.on("data", read);
    proc.on("error", reject);
    proc.on("exit", (code) =>
      reject(new Error(`OpenCode didn't start (${code}): ${clip(out, 500)}`)),
    );
  });
  return { url, close: () => proc.kill() };
}

/** How long `opencode serve` may take to listen. */
const STARTUP_TIMEOUT = 60_000;

/** Resolves once `signal` aborts, at once if it has. */
const aborted = (signal: AbortSignal) =>
  new Promise<void>((resolve) =>
    signal.aborted ? resolve() : signal.addEventListener("abort", () => resolve(), { once: true }),
  );

/** A stream's events until `signal` aborts. */
async function* until<T>(stream: AsyncIterable<T>, signal: AbortSignal) {
  const events = stream[Symbol.asyncIterator]();
  const end = aborted(signal).then(() => ({ done: true as const, value: undefined }));
  for (;;) {
    const next = await Promise.race([events.next(), end]);
    if (next.done) return;
    yield next.value;
  }
}

/** What OpenCode's `{ error }` answer says. */
const errorText = (error: unknown) =>
  String((error as { data?: { message?: unknown } }).data?.message ?? JSON.stringify(error));

/** Runs a session on OpenCode, with whatever provider the owner signed in to. */
export function opencodeEngine(options: OpencodeOptions): Engine {
  return async (run) => {
    const servers: NonNullable<EngineRun["mcpServers"]> = run.input.tools
      ? {
          ...run.mcpServers,
          [HUB_MCP]: {
            type: "http" as const,
            url: run.hubMcp.url,
            headers: { authorization: `Bearer ${run.hubMcp.token}` },
          },
        }
      : {};
    // Longest first, so `git_hub_x` finds `git_hub` before `git`.
    const names = Object.keys(servers).sort((a, b) => b.length - a.length);
    const config = {
      permission: { "*": "ask", question: "deny" },
      // An agent's prompt replaces OpenCode's own coding prompt, as Claude's `systemPrompt` does.
      agent: { build: { prompt: run.input.systemPrompt } },
      plugin: [pathToFileURL(planPlugin(options.home)).href],
      ...(run.input.tools ? { mcp: mcpConfig(servers) } : {}),
    };
    const server = serve(options.bin, run.cwd, opencodeEnv(options.home, config), (line) => {
      try {
        const plan = planFromHeaders(JSON.parse(line), Date.now());
        if (plan) run.onPlan?.({ plan });
      } catch {}
    });
    process.on("exit", server.close);
    const result: EngineResult = { output: null, sessionId: run.resume, usage: {} };
    let sessionID = "";
    let steps = 0;
    // Ends the event loop: the run stopped, or OpenCode can't go on.
    const end = new AbortController();
    const fail = (error: string) => {
      result.error ??= error;
      end.abort();
    };
    const abort = () => void client?.session.abort({ sessionID });
    const stop = () => {
      abort();
      end.abort();
    };
    run.signal.addEventListener("abort", stop);
    let client: ReturnType<typeof createOpencodeClient> | undefined;
    try {
      const startup = AbortSignal.any([run.signal, AbortSignal.timeout(STARTUP_TIMEOUT)]);
      const baseUrl = await Promise.race([
        server.url,
        aborted(startup).then(() => {
          throw new Error("OpenCode didn't start in time");
        }),
      ]);
      client = createOpencodeClient({ baseUrl, directory: run.cwd });
      const { stream } = await client.event.subscribe();
      sessionID =
        run.resume ??
        (
          await client.session.create({
            title: clip(run.input.prompt.split("\n")[0] ?? "", 80),
            // A decision gets no tools, only its structured answer.
            ...(run.input.tools
              ? {}
              : {
                  permission: [
                    { permission: "*", pattern: "*", action: "deny" as const },
                    { permission: "StructuredOutput", pattern: "*", action: "allow" as const },
                  ],
                }),
          })
        ).data?.id ??
        "";
      if (!sessionID) throw new Error("OpenCode didn't start a session");
      const sessions = new Set([sessionID]);
      if (sessionID !== result.sessionId) {
        result.sessionId = sessionID;
        run.onSession(sessionID);
      }

      // Each server's read-only tools, listed on its first ask; unlisted, a tool may write.
      const lists = new Map<string, Promise<Set<string>>>();
      const readOnly = async (tool: string) => {
        const name = names.find((s) => tool.startsWith(`mcp__${s}__`));
        const server = name ? servers[name] : undefined;
        if (!name || !server || server.type === "sdk") return false;
        if (!lists.has(name))
          lists.set(
            name,
            readOnlyTools(server, run.cwd).catch(() => new Set<string>()),
          );
        return (await lists.get(name))?.has(tool.slice(`mcp__${name}__`.length)) ?? false;
      };

      // One decision per call: a path outside the folder asks twice for the same call.
      const decisions = new Map<string, Promise<ToolDecision>>();
      const decide = async (ask: PermissionRequest): Promise<ToolDecision> => {
        let tool = ask.permission;
        let input = ask.metadata;
        if (ask.tool) {
          // A subagent's ask is about a call in its own session.
          const { callID, messageID } = ask.tool;
          const message = (await client?.session.message({ sessionID: ask.sessionID, messageID }))
            ?.data;
          const call = message?.parts.find((p) => p.type === "tool" && p.callID === callID);
          if (call?.type === "tool")
            ({ tool, input } = { tool: call.tool, input: call.state.input });
        }
        // Every file a patch changes needs its own yes.
        for (const call of claudeCalls(tool, input, names, run.cwd)) {
          const decision = await run.canUseTool(call.name, call.input, await readOnly(call.name));
          if (decision.behavior !== "allow") return decision;
        }
        return { behavior: "allow" };
      };
      const answer = async (ask: PermissionRequest) => {
        // Call ids are only unique within a message.
        const key = ask.tool ? `${ask.tool.messageID}/${ask.tool.callID}` : ask.id;
        if (!decisions.has(key)) decisions.set(key, decide(ask));
        const decision = await decisions
          .get(key)
          ?.catch((error): ToolDecision => ({ behavior: "deny", message: String(error) }));
        const replied = await client?.permission.reply(
          decision?.behavior === "allow"
            ? { requestID: ask.id, reply: "once" }
            : { requestID: ask.id, reply: "reject", message: decision?.message ?? "" },
        );
        // Unanswered, the call would wait forever.
        if (replied?.error) fail(errorText(replied.error));
      };

      // Older hubs name no provider: OpenCode's own default model runs.
      const providerID = run.provider;
      const modelID = run.model;
      // Variant names differ per model, and OpenCode drops unknown ones silently.
      const variants =
        providerID && run.effort
          ? (await client.provider.list()).data?.all.find((p) => p.id === providerID)?.models[
              modelID
            ]?.variants
          : undefined;
      if (run.signal.aborted) throw new Error("Stopped");
      const prompted = await client.session.promptAsync({
        sessionID,
        ...(providerID ? { model: { providerID, modelID } } : {}),
        ...(run.effort && variants?.[run.effort] ? { variant: run.effort } : {}),
        format: { type: "json_schema", schema: run.input.outputSchema },
        parts: [{ type: "text", text: run.input.prompt }],
      });
      if (prompted.error) throw new Error(errorText(prompted.error));

      const maxTurns = run.input.tools ? run.input.maxTurns : 3;
      const seen = new Set<string>();
      const started = new Set<string>();
      for await (const event of until(stream as AsyncIterable<Event>, end.signal)) {
        // Subagents run in sessions of their own, under ours.
        if (event.type === "session.created" || event.type === "session.updated") {
          const { id, parentID } = event.properties.info;
          if (parentID && sessions.has(parentID)) sessions.add(id);
        }
        if (!("sessionID" in event.properties) || !sessions.has(String(event.properties.sessionID)))
          continue;
        // A subagent's asks and parts count; its turns, end and errors are its own.
        const own = event.properties.sessionID === sessionID;
        if (event.type === "permission.asked") void answer(event.properties);
        else if (event.type === "message.part.updated") {
          const part = event.properties.part;
          if (seen.has(part.id)) continue;
          if (part.type === "text" && part.time?.end) {
            seen.add(part.id);
            if (part.text.trim()) run.onEvent({ type: "text", text: clip(part.text) });
          } else if (part.type === "tool" && part.state.status !== "pending") {
            // The call shows once it runs, so a long command or its permission isn't hidden.
            if (!started.has(part.id)) {
              started.add(part.id);
              const call = transcriptCall(claudeCalls(part.tool, part.state.input, names, run.cwd));
              run.onEvent({
                type: "tool",
                id: part.callID,
                name: call.name,
                input: clip(JSON.stringify(call.input), 2000),
              });
            }
            if (part.state.status === "completed" || part.state.status === "error") {
              seen.add(part.id);
              run.onEvent({
                type: "tool_result",
                id: part.callID,
                error: part.state.status === "error",
                text: clip(
                  part.state.status === "error" ? part.state.error : part.state.output,
                  2000,
                ),
              });
            }
          } else if (part.type === "step-finish" && own) {
            seen.add(part.id);
            steps++;
          } else if (part.type === "step-start" && own && steps >= maxTurns && !result.error) {
            // OpenCode's own step limit is only a hint to the model; the last step may answer.
            result.error = "The session ended early (error max turns)";
            abort();
          }
        } else if (!own) continue;
        else if (event.type === "session.idle") break;
        else if (event.type === "message.updated") {
          const info = event.properties.info;
          if (info.role === "assistant") {
            // What actually ran, which may be OpenCode's default model.
            result.model = `${info.providerID}/${info.modelID}`;
            result.effort = info.variant ?? null;
            if (info.structured !== undefined) result.output = info.structured;
          }
        } else if (event.type === "session.error") {
          const error = event.properties.error;
          if (!run.signal.aborted && !result.error && error) {
            result.error = "message" in error.data ? String(error.data.message) : error.name;
            const signedOut =
              error.name === "ProviderAuthError" ||
              ("statusCode" in error.data && error.data.statusCode === 401);
            if (signedOut) result.error += ` ${LOGIN_HINT}`;
          }
          break;
        }
      }
      // Claude's totals include its subagents', so these do too.
      const all = await Promise.all(
        [...sessions].map(async (id) => (await client?.session.get({ sessionID: id }))?.data),
      );
      const sum = (of: (session: Session) => number) =>
        all.reduce((total, session) => total + (session ? of(session) : 0), 0);
      result.usage = {
        inputTokens: sum((s) =>
          s.tokens ? s.tokens.input + s.tokens.cache.read + s.tokens.cache.write : 0,
        ),
        outputTokens: sum((s) => (s.tokens ? s.tokens.output + s.tokens.reasoning : 0)),
        numTurns: steps,
        costUsd: sum((s) => s.cost ?? 0),
      };
    } catch (error) {
      if (!run.signal.aborted)
        result.error = error instanceof Error ? error.message : String(error);
    } finally {
      run.signal.removeEventListener("abort", stop);
      server.close();
      process.off("exit", server.close);
    }
    // As the Claude SDK does, a run ends with its result, failed or not, unless it was stopped.
    if (!run.signal.aborted)
      run.onEvent({
        type: "result",
        subtype: result.error ? "error" : "success",
        turns: steps,
        costUsd: result.usage.costUsd ?? 0,
      });
    return result;
  };
}
