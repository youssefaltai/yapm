import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { createOpencodeClient, type Event, type PermissionRequest } from "@opencode-ai/sdk/v2";
import type { Engine, EngineResult, EngineRun } from "./engine.js";
import { HUB_MCP, type ToolDecision } from "./permissions.js";

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
 * Installs OpenCode into the runner's home unless that version is there, and returns its binary.
 * It's ~145 MB, so only machines that use it get it.
 */
export function installOpencode(home: string, log: (line: string) => void): string {
  const prefix = join(home, "opencode");
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

/** Signs in to a provider with OpenCode's own flow: ChatGPT, Copilot, an API key and more. */
export function opencodeLogin(home: string, log: (line: string) => void): boolean {
  const login = spawnSync(installOpencode(home, log), ["auth", "login"], {
    stdio: "inherit",
    env: opencodeEnv(home),
  });
  log(
    login.status === 0
      ? "OpenCode: signed in."
      : "OpenCode isn't signed in yet. Run: yapm-runner login --opencode",
  );
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
    OPENCODE_PURE: "1",
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
};

/** OpenCode's tool name and input as Claude Code's, which the runner's grants are written in. */
function claudeTool(tool: string, input: Record<string, unknown>, servers: string[]) {
  // MCP tools are `<server>_<tool>`, and either may hold `_`, so match the known servers.
  const server = servers.find((s) => tool.startsWith(`${s}_`));
  const name = TOOLS[tool] ?? (server ? `mcp__${server}__${tool.slice(server.length + 1)}` : tool);
  const { filePath, ...rest } = input;
  return { name, input: filePath === undefined ? input : { ...rest, file_path: filePath } };
}

/** Starts `opencode serve` for one run; resolves once it listens. */
function serve(bin: string, cwd: string, env: NodeJS.ProcessEnv) {
  const proc = spawn(bin, ["serve", "--hostname=127.0.0.1", "--port=0"], { cwd, env });
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
      ...(run.input.tools ? { mcp: mcpConfig(servers) } : {}),
    };
    const server = serve(options.bin, run.cwd, opencodeEnv(options.home, config));
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
          const { callID, messageID } = ask.tool;
          const message = (await client?.session.message({ sessionID, messageID }))?.data;
          const call = message?.parts.find((p) => p.type === "tool" && p.callID === callID);
          if (call?.type === "tool")
            ({ tool, input } = { tool: call.tool, input: call.state.input });
        }
        const claude = claudeTool(tool, input, names);
        return run.canUseTool(claude.name, claude.input);
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
      for await (const event of stream as AsyncIterable<Event>) {
        if (!("sessionID" in event.properties) || event.properties.sessionID !== sessionID)
          continue;
        if (event.type === "session.idle") break;
        if (event.type === "permission.asked") void answer(event.properties);
        else if (event.type === "message.updated") {
          if (
            event.properties.info.role === "assistant" &&
            event.properties.info.structured !== undefined
          )
            result.output = event.properties.info.structured;
        } else if (event.type === "session.error") {
          const error = event.properties.error;
          if (!run.signal.aborted && !result.error && error)
            result.error = "message" in error.data ? String(error.data.message) : error.name;
        } else if (event.type === "message.part.updated") {
          const part = event.properties.part;
          if (seen.has(part.id)) continue;
          if (part.type === "text" && part.time?.end) {
            seen.add(part.id);
            if (part.text.trim()) run.onEvent({ type: "text", text: clip(part.text) });
          } else if (
            part.type === "tool" &&
            (part.state.status === "completed" || part.state.status === "error")
          ) {
            seen.add(part.id);
            const { name } = claudeTool(part.tool, {}, names);
            run.onEvent({
              type: "tool",
              id: part.callID,
              name,
              input: clip(JSON.stringify(part.state.input), 2000),
            });
            run.onEvent({
              type: "tool_result",
              id: part.callID,
              error: part.state.status === "error",
              text: clip(
                part.state.status === "error" ? part.state.error : part.state.output,
                2000,
              ),
            });
          } else if (part.type === "step-finish") {
            seen.add(part.id);
            steps++;
          } else if (part.type === "step-start" && steps >= maxTurns && !result.error) {
            // OpenCode's own step limit is only a hint to the model; the last step may answer.
            result.error = "The session ended early (error max turns)";
            abort();
          }
        }
      }
      const session = (await client.session.get({ sessionID })).data;
      const tokens = session?.tokens;
      result.usage = {
        ...(tokens
          ? {
              inputTokens: tokens.input + tokens.cache.read + tokens.cache.write,
              outputTokens: tokens.output + tokens.reasoning,
            }
          : {}),
        numTurns: steps,
        costUsd: session?.cost ?? 0,
      };
      run.onEvent({
        type: "result",
        subtype: result.error ? "error" : "success",
        turns: steps,
        costUsd: result.usage.costUsd,
      });
    } catch (error) {
      if (!run.signal.aborted)
        result.error = error instanceof Error ? error.message : String(error);
    } finally {
      run.signal.removeEventListener("abort", abort);
      server.close();
    }
    return result;
  };
}
