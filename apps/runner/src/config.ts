import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import type { EngineName } from "./hub.js";

export interface Config {
  hub: string;
  token: string;
  machineId: string;
  name: string;
  capacity: number;
  /** The machine's own MCP servers for agents, in Claude Code's `mcpServers` shape. */
  mcpServers?: Options["mcpServers"];
  /** An Anthropic API key agents use instead of a Claude sign-in. */
  apiKey?: string;
  /** Older runners ran every agent on one engine; `"opencode"` counts as OpenCode set up. */
  engine?: string;
  /** Set when OpenCode is; its `provider/model` per tier, left out OpenCode's default model. */
  opencode?: { models?: { small?: string; standard?: string; top?: string } };
}

export const home = process.env.YAPM_RUNNER_HOME ?? join(homedir(), ".yapm-runner");
export const configPath = join(home, "config.json");

export async function loadConfig(): Promise<Config> {
  try {
    return JSON.parse(await readFile(configPath, "utf8")) as Config;
  } catch {
    throw new Error(
      "This machine isn't connected yet. Copy the install command from Machines in yapm.",
    );
  }
}

export async function saveConfig(config: Config) {
  await mkdir(home, { recursive: true });
  // The file holds the machine's secrets.
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await chmod(configPath, 0o600);
}

/** Agent sessions and plan readings pick a saved API key up from the environment. */
export function useApiKey(config: Pick<Config, "apiKey">, env = process.env) {
  if (config.apiKey) env.ANTHROPIC_API_KEY = config.apiKey;
}

/** The engines this machine runs: Claude unless only OpenCode is set up, and OpenCode once it is. */
export function engineNames(
  config: Pick<Config, "opencode" | "engine">,
  claudeReady: () => boolean,
): EngineName[] {
  const opencode = Boolean(config.opencode) || config.engine === "opencode";
  return [
    ...(!opencode || claudeReady() ? ["claude" as const] : []),
    ...(opencode ? ["opencode" as const] : []),
  ];
}

/** Sets OpenCode up alongside whatever Claude has. */
export function withOpencode<T extends Partial<Config>>({ engine: _, ...config }: T) {
  return { ...config, opencode: config.opencode ?? {} };
}
