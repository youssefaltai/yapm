import { execFileSync, spawnSync } from "node:child_process";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { apiKeyLooksRight, authChoice, claudeLogin, claudeReady } from "./claude.js";
import { configPath, home, loadConfig, saveConfig, useApiKey } from "./config.js";
import { Runner } from "./daemon.js";
import { HubClient } from "./hub.js";
import { probePlan, sdkEngine } from "./sdk.js";
import { followLogs, installService, uninstallService } from "./service.js";

const VERSION = "0.4.0";

// Agents' Claude sign-in, sessions and settings live here, apart from the owner's own ~/.claude.
process.env.CLAUDE_CONFIG_DIR = join(home, "claude");

/** Asks on the terminal; a hidden answer isn't echoed. */
async function ask(question: string, hidden = false) {
  const muted = new Writable({ write: (_chunk, _encoding, done) => done() });
  const rl = createInterface({
    input: process.stdin,
    output: hidden ? muted : process.stdout,
    terminal: true,
  });
  rl.on("SIGINT", () => process.exit(130));
  if (hidden) process.stdout.write(question);
  const answer = await rl.question(hidden ? "" : question);
  rl.close();
  if (hidden) process.stdout.write("\n");
  return answer.trim();
}

const CHOICE = `How should agents on this machine use Claude?
  1) Sign in with your Claude account (opens Claude's own sign-in)
  2) Use an Anthropic API key (billed to your key)
> `;

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

const USAGE = `yapm-runner: runs your company's agents on this machine.

  enrol --hub <url> [--token <setup token>] [--name <name>] [--tags a,b] [--capacity 2]
        Connects this machine to the hub. With a setup token from Machines it is approved
        at once; without one, approve the code it shows in the app.
  login [--claude | --api-key <key>]
        Sets up how agents use Claude, if this machine isn't already: your own Claude
        account or API key. The flags skip the question.
  start Runs agents until stopped (Ctrl-C finishes cleanly).
  service install | uninstall
        Runs agents in the background and at login (launchd on macOS, systemd on Linux).
  logs  Follows the background runner's output.
  status
        Shows this machine as the hub sees it.

The install command on the Machines page does enrol, login and service install for you.
Settings live in ${configPath}; give agents MCP servers under "mcpServers".`;

async function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      hub: { type: "string" },
      name: { type: "string" },
      tags: { type: "string" },
      token: { type: "string" },
      capacity: { type: "string" },
      "api-key": { type: "string" },
      claude: { type: "boolean" },
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
    const hub = new HubClient(values.hub);
    const name = values.name ?? machineName();
    const capacity = Number(values.capacity ?? 2) || 2;
    const enrolment = await hub.enrol({
      name,
      tags: (values.tags ?? "")
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean),
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
    });
    if (enrolment.status === "active") {
      say(`"${name}" is connected to ${hub.url}.`);
    } else {
      say(`Pairing code: ${enrolment.pairingCode}`);
      say(`Approve "${name}" at ${enrolment.approveAt}, then run: yapm-runner start`);
    }
    return;
  }

  if (command === "login") {
    const saved = await loadConfig().catch(() => undefined);
    let apiKey = values["api-key"];
    if (apiKey === undefined && !values.claude) {
      if (claudeReady(saved?.apiKey))
        return say(saved?.apiKey ? "Claude: agents use your API key." : "Claude: signed in.");
      // Without a terminal to ask on, sign in as before.
      if (process.stdin.isTTY) {
        let choice = null;
        while (!choice) choice = authChoice(await ask(CHOICE));
        if (choice === "key") apiKey = await ask("Anthropic API key (hidden): ", true);
      }
    }
    if (apiKey !== undefined) {
      if (!apiKeyLooksRight(apiKey)) throw new Error("That isn't an API key: they start sk-ant-.");
      await saveConfig({ ...(await loadConfig()), apiKey });
      return say("Claude: agents use your API key.");
    }
    if (saved?.apiKey) {
      delete saved.apiKey;
      await saveConfig(saved);
    }
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
          env: { YAPM_RUNNER_HOME: home, PATH: process.env.PATH ?? "/usr/bin:/bin" },
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
    throw new Error("Say what to do: yapm-runner service install, or service uninstall");
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
    useApiKey(config);
    const runner = new Runner({
      hub,
      token: config.token,
      engine: sdkEngine,
      mcpServers: config.mcpServers,
      probe: probePlan,
      capacity: config.capacity,
      version: VERSION,
      cwd: homedir(),
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
    if ((await runner.run()) === "upgrade") {
      // The hub's installer replaces the runner in place; it keeps this machine's settings.
      const install = spawnSync(
        "sh",
        ["-c", 'curl -fsSL "$0/install.sh" | sh -s -- --no-service', config.hub],
        { stdio: ["ignore", "inherit", "inherit"] },
      );
      console.log(install.status === 0 ? "Upgraded; restarting." : "The upgrade failed.");
      // Not a clean exit, so launchd or systemd starts the new runner.
      process.exit(75);
    }
    return;
  }

  throw new Error(`Unknown command "${command}".\n\n${USAGE}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
