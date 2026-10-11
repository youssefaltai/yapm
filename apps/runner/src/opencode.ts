import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  createOpencodeClient,
  type Event,
  type PermissionRequest,
  type Session,
} from "@opencode-ai/sdk/v2";
import type { Engine, EngineResult, EngineRun } from "./engine.js";
import { HUB_MCP, type ToolDecision } from "./permissions.js";
import { planFromHeaders } from "./plan.js";

type Tier = NonNullable<EngineRun["modelTier"]>;

export interface OpencodeOptions {
  /** The pinned `opencode` binary; never the one on PATH, which may be an incompatible 2.x. */
  bin: string;
  /** The runner's home; OpenCode's settings and sessions live in its `opencode` folder. */
  home: string;
  /** `provider/model` per tier; left out, OpenCode's own default model runs. */
  models?: Partial<Record<Tier, string>>;
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
  log(`Installing OpenCode ${VERSION}…`);
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

const LOGIN_HINT = "Run: yapm-runner login --opencode";

/** Whether OpenCode has a provider to run on: a saved sign-in or a provider's key in the env. */
export function opencodeSignedIn(bin: string, home: string): boolean {
  const list = spawnSync(bin, ["auth", "list"], { env: opencodeEnv(home), encoding: "utf8" });
  return /\b[1-9]\d* (credential|environment variable)/.test(list.stdout ?? "");
}

/** Signs in to a provider with OpenCode's own flow: ChatGPT, Copilot, an API key and more. */
export function opencodeLogin(home: string, log: (line: string) => void): boolean {
  const login = spawnSync(installOpencode(home, log), ["auth", "login"], {
    stdio: "inherit",
    env: opencodeEnv(home),
  });
  log(login.status === 0 ? "OpenCode: signed in." : `OpenCode isn't signed in yet. ${LOGIN_HINT}`);
  return login.status === 0;
}

const clip = (text: string, max = 4000) => (text.length > max ? `${text.slice(0, max)}…` : text);

/** Keeps agents off the owner's own OpenCode settings, project files and database. */
export function opencodeEnv(home: string, config: Record<string, unknown> = {}) {
  return {
    ...process.env,
    OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
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
      if (listening?.[1]) resolve(listening[1]);
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

/** Runs a session on OpenCode, with whatever provider the owner signed in to. */
export function opencodeEngine(options: OpencodeOptions): Engine {
  return async (run) => {
    const servers = run.input.tools
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
      plugin: [pathToFileURL(planPlugin(options.home)).href],
      ...(run.input.tools ? { mcp: mcpConfig(servers) } : {}),
    };
    const server = serve(options.bin, run.cwd, opencodeEnv(options.home, config), (line) => {
      try {
        const plan = planFromHeaders(JSON.parse(line), Date.now());
        if (plan) run.onPlan?.({ plan });
      } catch {}
    });
    const result: EngineResult = { output: null, sessionId: run.resume, usage: {} };
    let sessionID = "";
    let steps = 0;
    const abort = () => void client?.session.abort({ sessionID });
    let client: ReturnType<typeof createOpencodeClient> | undefined;
    try {
      client = createOpencodeClient({ baseUrl: await server.url, directory: run.cwd });
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
          const decision = await run.canUseTool(call.name, call.input);
          if (decision.behavior !== "allow") return decision;
        }
        return { behavior: "allow" };
      };
      const answer = async (ask: PermissionRequest) => {
        const key = ask.tool?.callID ?? ask.id;
        if (!decisions.has(key)) decisions.set(key, decide(ask));
        const decision = await decisions
          .get(key)
          ?.catch((error): ToolDecision => ({ behavior: "deny", message: String(error) }));
        await client?.permission.reply(
          decision?.behavior === "allow"
            ? { requestID: ask.id, reply: "once" }
            : { requestID: ask.id, reply: "reject", message: decision?.message ?? "" },
        );
      };

      const model = options.models?.[run.modelTier ?? "standard"];
      const [providerID, ...rest] = model?.split("/") ?? [];
      const modelID = rest.join("/");
      // Variant names differ per model, and OpenCode drops unknown ones silently.
      const variants =
        providerID && run.effort
          ? (await client.provider.list()).data?.all.find((p) => p.id === providerID)?.models[
              modelID
            ]?.variants
          : undefined;
      run.signal.addEventListener("abort", abort);
      if (run.signal.aborted) throw new Error("Stopped");
      await client.session.promptAsync({
        sessionID,
        ...(providerID && modelID ? { model: { providerID, modelID } } : {}),
        ...(run.effort && variants?.[run.effort] ? { variant: run.effort } : {}),
        // OpenCode doesn't keep it, so every prompt carries it.
        system: run.input.systemPrompt,
        format: { type: "json_schema", schema: run.input.outputSchema },
        parts: [{ type: "text", text: run.input.prompt }],
      });

      const maxTurns = run.input.tools ? run.input.maxTurns : 3;
      const seen = new Set<string>();
      const started = new Set<string>();
      for await (const event of stream as AsyncIterable<Event>) {
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
      run.signal.removeEventListener("abort", abort);
      server.close();
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
