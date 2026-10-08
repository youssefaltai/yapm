import { execFileSync } from "node:child_process";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { claudeLogin } from "./claude.js";
import { Runner } from "./daemon.js";
import { HubClient } from "./hub.js";
import { McpManager } from "./mcp.js";
import { sdkEngine } from "./sdk.js";
import { followLogs, installService, uninstallService } from "./service.js";

const VERSION = "0.2.0";

interface Config {
  hub: string;
  token: string;
  machineId: string;
  name: string;
  capacity: number;
  /** The machine's own MCP servers, in Claude Code's `mcpServers` shape. */
  mcpServers: Record<string, unknown>;
}

const home = process.env.LIFE_OS_RUNNER_HOME ?? join(homedir(), ".life-os-runner");
const configPath = join(home, "config.json");

async function loadConfig(): Promise<Config> {
  try {
    return JSON.parse(await readFile(configPath, "utf8")) as Config;
  } catch {
    throw new Error(
      "This machine isn't connected yet. Copy the install command from Machines in Life OS.",
    );
  }
}

async function saveConfig(config: Config) {
  await mkdir(home, { recursive: true });
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
  // The file holds the machine's secret.
  await chmod(configPath, 0o600);
}

/** The name people know the machine by: "Youssef's MacBook Pro" rather than a host name. */
function machineName() {
  if (process.platform === "darwin") {
    try {
      return execFileSync("scutil", ["--get", "ComputerName"], { encoding: "utf8" }).trim();
    } catch {}
  }
  return hostname().replace(/\.local$/, "");
}

const logFile = join(home, "runner.log");
const say = (line: string) => console.log(line);

const USAGE = `life-os-runner: runs your company's agents on this machine.

  enrol --hub <url> [--token <setup token>] [--name <name>] [--tags a,b] [--capacity 2]
        Connects this machine to the hub. With a setup token from Machines it is approved
        at once; without one, approve the code it shows in the app.
  login Signs in to Claude, if this machine isn't already (agents use this subscription).
  start Runs agents until stopped (Ctrl-C finishes cleanly).
  service install | uninstall
        Runs agents in the background and at login (launchd on macOS, systemd on Linux).
  logs  Follows the background runner's output.
  status
        Shows this machine as the hub sees it.

The install command on the Machines page does enrol, login and service install for you.
Settings live in ${configPath}; add your own MCP servers under "mcpServers".
Servers the hub adds (approved in the app) sign in through your browser; their tokens stay
in ${join(home, "mcp-auth.json")}.`;

async function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      hub: { type: "string" },
      name: { type: "string" },
      tags: { type: "string" },
      token: { type: "string" },
      capacity: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  const command = positionals[0];
  if (values.help || !command) {
    console.log(USAGE);
    return;
  }

  if (command === "enrol" || command === "enroll") {
    if (!values.hub) throw new Error("Say which hub: --hub https://your-hub.example");
    const existing = await loadConfig().catch(() => null);
    const hub = new HubClient(values.hub);
    const name = values.name ?? machineName();
    const capacity = Number(values.capacity ?? 2) || 2;
    const mcpServers = existing?.mcpServers ?? {};
    const enrolment = await hub.enrol({
      name,
      tags: (values.tags ?? "")
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean),
      mcps: Object.keys(mcpServers),
      capacity,
      version: VERSION,
      ...(values.token ? { setupToken: values.token } : {}),
    });
    await saveConfig({
      hub: hub.url,
      token: enrolment.token,
      machineId: enrolment.id,
      name,
      capacity,
      mcpServers,
    });
    if (enrolment.status === "active") {
      say(`"${name}" is connected to ${hub.url}.`);
    } else {
      say(`Pairing code: ${enrolment.pairingCode}`);
      say(`Approve "${name}" at ${enrolment.approveAt}, then run: life-os-runner start`);
    }
    return;
  }

  if (command === "login") {
    if (!claudeLogin(say)) process.exitCode = 1;
    return;
  }

  if (command === "service") {
    const action = positionals[1];
    if (action === "install") {
      await loadConfig();
      await installService(
        {
          command: [process.execPath, fileURLToPath(import.meta.url), "start"],
          env: { LIFE_OS_RUNNER_HOME: home, PATH: process.env.PATH ?? "/usr/bin:/bin" },
          logFile,
        },
        say,
      );
      return;
    }
    if (action === "uninstall") {
      await uninstallService(say);
      return;
    }
    throw new Error("Say what to do: life-os-runner service install, or service uninstall");
  }

  if (command === "logs") {
    followLogs(logFile);
    return;
  }

  const config = await loadConfig();
  const hub = new HubClient(config.hub);

  if (command === "status") {
    console.log(JSON.stringify(await hub.me(config.token), null, 2));
    return;
  }

  if (command === "start") {
    const runner = new Runner({
      hub,
      token: config.token,
      engine: sdkEngine,
      capacity: config.capacity,
      version: VERSION,
      mcpServers: config.mcpServers ?? {},
      mcp: new McpManager({
        hubUrl: config.hub,
        machineName: config.name,
        file: join(home, "mcp-auth.json"),
        log: (line) => console.log(`${new Date().toISOString()} ${line}`),
      }),
      workDir: join(home, "work"),
      log: (line) => console.log(`${new Date().toISOString()} ${line}`),
    });
    let stopping = false;
    const shutdown = () => {
      if (stopping) process.exit(1);
      stopping = true;
      console.log("Finishing: stopping runs in progress and reporting them…");
      void runner.shutdown();
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    console.log(`${config.name} is connected to ${config.hub}.`);
    await runner.run();
    return;
  }

  throw new Error(`Unknown command "${command}".\n\n${USAGE}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
