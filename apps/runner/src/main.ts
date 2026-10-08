import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { Runner } from "./daemon.js";
import { HubClient } from "./hub.js";
import { sdkEngine } from "./sdk.js";

const VERSION = "0.1.0";

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
      `No runner set up here yet. Run: life-os-runner enrol --hub https://your-hub.example`,
    );
  }
}

async function saveConfig(config: Config) {
  await mkdir(home, { recursive: true });
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
  // The file holds the machine's secret.
  await chmod(configPath, 0o600);
}

const USAGE = `life-os-runner: runs your company's agents on this machine.

  enrol --hub <url> [--name <name>] [--tags a,b] [--capacity 2]
        Asks the hub to add this machine; approve the code it shows in the app.
  start Runs agents until stopped (Ctrl-C finishes cleanly).
  status
        Shows this machine as the hub sees it.

Agents use this machine's Claude sign-in (run \`claude\` once and log in with your Max plan).
Settings live in ${configPath}; add your own MCP servers under "mcpServers".`;

async function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      hub: { type: "string" },
      name: { type: "string" },
      tags: { type: "string" },
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
    const name = values.name ?? hostname();
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
    });
    await saveConfig({
      hub: hub.url,
      token: enrolment.token,
      machineId: enrolment.id,
      name,
      capacity,
      mcpServers,
    });
    console.log(`Pairing code: ${enrolment.pairingCode}`);
    console.log(`Approve "${name}" at ${enrolment.approveAt}, then run: life-os-runner start`);
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
