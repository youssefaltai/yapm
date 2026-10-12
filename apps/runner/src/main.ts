import { execFileSync, spawnSync } from "node:child_process";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { apiKeyLooksRight, claudeLogin, claudeReady } from "./claude.js";
import {
  type Config,
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
import {
  installOpencode,
  opencodeEngine,
  opencodeLogin,
  opencodeProviders,
  withOpencodeServer,
} from "./opencode.js";
import {
  authChoice,
  CHOICE,
  type Choice,
  keySignIn,
  loginChoice,
  oauthSignIn,
  pickModels,
} from "./providers.js";
import { probePlan, sdkEngine } from "./sdk.js";
import { followLogs, installService, uninstallService } from "./service.js";

const VERSION = "0.6.5";

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
  login [--claude | --api-key <key> | --chatgpt | --copilot | --provider <id> --api-key <key>]
        Signs agents in to the AI they use, with your own plan or key: a Claude subscription,
        an Anthropic API key, a ChatGPT plan, GitHub Copilot, or another provider's API key.
        With no flags it shows what's signed in and lets you add more.
  start Runs agents until stopped (Ctrl-C finishes cleanly).
  service install | uninstall
        Runs agents in the background and at login (launchd on macOS, systemd on Linux).
  logs  Follows the background runner's output.
  status
        Shows this machine as the hub sees it.

The install command on the Machines page does enrol, login and service install for you.
Settings live in ${configPath}; give agents MCP servers under "mcpServers".`;

/** The AI agents here use, by provider: Claude, and whatever else is signed in. */
function aiNames(config: Config) {
  const opencode = engineNames(config, () => false).includes("opencode");
  return [
    ...(claudeReady(config.apiKey) ? ["Claude"] : []),
    ...(opencode ? opencodeProviders(installOpencode(home, say), home) : []),
  ];
}

/** Claude, with the owner's subscription or an Anthropic API key. */
async function claudeSignIn(choice: Choice, key?: string) {
  const saved = await loadConfig();
  if (choice === "key") {
    const apiKey = key ?? (await ask("Anthropic API key (hidden): ", true));
    if (!apiKeyLooksRight(apiKey)) throw new Error("That isn't an API key: they start sk-ant-.");
    await saveConfig({ ...saved, apiKey });
    return say("Claude: agents use your API key.");
  }
  if (saved.apiKey) {
    delete saved.apiKey;
    await saveConfig(saved);
  }
  if (!claudeLogin(say)) process.exitCode = 1;
}

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
      chatgpt: { type: "boolean" },
      copilot: { type: "boolean" },
      provider: { type: "string" },
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
    let choice = loginChoice(values);
    const interactive = !choice && process.stdin.isTTY;
    if (!choice) {
      const ai = saved ? aiNames(saved) : [];
      if (ai.length) say(`Agents here use ${ai.join(", ")}.`);
      // Without a terminal to ask on, sign in to Claude as before.
      if (!process.stdin.isTTY) choice = ai.length ? null : "account";
      while (interactive && !choice) {
        const answer = await ask(ai.length ? `Add another? Enter to skip.\n${CHOICE}` : CHOICE);
        if (ai.length && !answer) break;
        choice = authChoice(answer);
      }
      if (!choice) return;
    }
    if (choice === "account" || choice === "key") {
      await claudeSignIn(choice, values["api-key"]);
      return;
    }
    await saveConfig(withOpencode(await loadConfig()));
    if (choice === "opencode") {
      if (!opencodeLogin(home, say)) process.exitCode = 1;
      return;
    }
    const io = { say, ask };
    const ok = await withOpencodeServer(home, say, async (client) => {
      const id =
        choice === "provider"
          ? await keySignIn(client, io, values.provider, values["api-key"])
          : await oauthSignIn(client, choice, say);
      const config = await loadConfig();
      // Asked once, set up front; flags keep models already picked.
      if (!id || (!interactive && config.opencode?.models)) return Boolean(id);
      const models = await pickModels(client, id, interactive ? io : undefined);
      if (models) await saveConfig({ ...config, opencode: { ...config.opencode, models } });
      return true;
    });
    if (!ok) process.exitCode = 1;
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
    console.log(JSON.stringify({ ...(await hub.me(config.token)), ai: aiNames(config) }, null, 2));
    return;
  }

  if (command === "start") {
    useApiKey(config);
    const claudeSet = claudeReady(config.apiKey);
    let names = engineNames(config, () => claudeSet);
    const claude = names.includes("claude");
    const opencodeBin = names.includes("opencode") ? installOpencode(home, say) : "";
    const providers = opencodeBin ? opencodeProviders(opencodeBin, home) : [];
    // Agents set to "ChatGPT, Copilot & more" only get runs here once a provider is signed in.
    if (opencodeBin && !providers.length) {
      say(
        "No ChatGPT, Copilot or other provider is signed in, so agents set to them won't run here. Run: yapm-runner login",
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
    const ai = [...(claudeSet ? ["Claude"] : []), ...providers];
    console.log(
      `${config.name} is connected to ${config.hub}, running ${ai.join(", ") || "no AI yet"}.`,
    );
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
