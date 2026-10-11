import { execFileSync, spawnSync } from "node:child_process";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { apiKeyLooksRight, authChoice, claudeLogin, claudeReady } from "./claude.js";
import {
  configPath,
  engineNames,
  home,
  loadConfig,
  saveConfig,
  useApiKey,
  withOpencode,
} from "./config.js";
import { Runner } from "./daemon.js";
import { HubClient } from "./hub.js";
import { installOpencode, opencodeEngine, opencodeLogin, opencodeSignedIn } from "./opencode.js";
import { probePlan, sdkEngine } from "./sdk.js";
import { followLogs, installService, uninstallService } from "./service.js";

const VERSION = "0.6.4";

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

const CHOICE = `How should agents on this machine run?
  1) Sign in with your Claude account (opens Claude's own sign-in)
  2) Use an Anthropic API key (billed to your key)
  3) Add OpenCode, for agents you set to it: a ChatGPT or Copilot plan, or any provider's key
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
  login [--claude | --api-key <key> | --opencode]
        Sets up how agents run, if this machine isn't already: your own Claude account or
        API key. --opencode adds OpenCode with any provider, for agents set to it in the app.
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
      opencode: { type: "boolean" },
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
    let opencode = values.opencode;
    if (apiKey === undefined && !values.claude && !opencode) {
      if (claudeReady(saved?.apiKey))
        return say(saved?.apiKey ? "Claude: agents use your API key." : "Claude: signed in.");
      if (saved && engineNames(saved, () => false).includes("opencode"))
        return say("OpenCode: set up. Claude: yapm-runner login --claude");
      // Without a terminal to ask on, sign in as before.
      if (process.stdin.isTTY) {
        let choice = null;
        while (!choice) choice = authChoice(await ask(CHOICE));
        if (choice === "key") apiKey = await ask("Anthropic API key (hidden): ", true);
        if (choice === "opencode") opencode = true;
      }
    }
    if (opencode) {
      await saveConfig(withOpencode(await loadConfig()));
      if (!opencodeLogin(home, say)) process.exitCode = 1;
      return;
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
    let names = engineNames(config, () => claudeReady(config.apiKey));
    const claude = names.includes("claude");
    const opencodeBin = names.includes("opencode") ? installOpencode(home, say) : "";
    // OpenCode's agents only get runs here once it has a provider to run them on.
    if (opencodeBin && !opencodeSignedIn(opencodeBin, home)) {
      say(
        "OpenCode has no provider signed in, so its agents won't run here. Run: yapm-runner login --opencode",
      );
      names = names.filter((name) => name !== "opencode");
    }
    const runner = new Runner({
      hub,
      token: config.token,
      engines: {
        ...(claude ? { claude: sdkEngine } : {}),
        ...(names.includes("opencode")
          ? {
              opencode: opencodeEngine({
                bin: opencodeBin,
                home,
                models: config.opencode?.models,
              }),
            }
          : {}),
      },
      mcpServers: config.mcpServers,
      // Plan readings are Claude's.
      ...(claude ? { probe: probePlan } : {}),
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
    console.log(`${config.name} is connected to ${config.hub}, running ${names.join(" and ")}.`);
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
