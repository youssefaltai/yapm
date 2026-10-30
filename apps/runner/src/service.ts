import { spawnSync } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { dirname, join } from "node:path";

/**
 * Keeps the runner going in the background and starts it at login, the way the platform
 * expects: a launchd agent on macOS, a systemd user service on Linux.
 */
export const LAUNCHD_LABEL = "com.yapm.runner";
export const SYSTEMD_UNIT = "yapm-runner.service";

export interface ServiceSpec {
  /** The program and its arguments, e.g. node, main.js, start. */
  command: string[];
  env: Record<string, string>;
  /** Where macOS writes the output; Linux uses the journal. */
  logFile: string;
}

const xml = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function launchdPlist(spec: ServiceSpec): string {
  const strings = (values: string[]) =>
    values.map((v) => `    <string>${xml(v)}</string>`).join("\n");
  const env = Object.entries(spec.env)
    .map(([k, v]) => `    <key>${xml(k)}</key>\n    <string>${xml(v)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${strings(spec.command)}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${env}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>${xml(spec.logFile)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(spec.logFile)}</string>
</dict>
</plist>
`;
}

/** systemd quotes arguments with double quotes and expands % specifiers. */
const unitQuote = (value: string) =>
  `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%")}"`;

export function systemdUnit(spec: ServiceSpec): string {
  const env = Object.entries(spec.env)
    .map(([k, v]) => `Environment=${unitQuote(`${k}=${v}`)}`)
    .join("\n");
  return `[Unit]
Description=yapm runner: runs your company's agents on this machine

[Service]
ExecStart=${spec.command.map(unitQuote).join(" ")}
${env}
Restart=on-failure
RestartSec=10
# On stop, runs in progress are stopped and reported before it exits.
TimeoutStopSec=60

[Install]
WantedBy=default.target
`;
}

const run = (command: string, args: string[]) =>
  spawnSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

const launchdPath = () => join(homedir(), "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
const systemdPath = () => join(homedir(), ".config", "systemd", "user", SYSTEMD_UNIT);
const hasUserSystemd = () =>
  process.platform === "linux" && run("systemctl", ["--user", "show-environment"]).status === 0;

/** Installs (or refreshes) the service and starts it. False when this system has neither. */
export async function installService(
  spec: ServiceSpec,
  log: (line: string) => void,
): Promise<boolean> {
  if (process.platform === "darwin") {
    const path = launchdPath();
    const domain = `gui/${userInfo().uid}`;
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, launchdPlist(spec));
    run("launchctl", ["bootout", `${domain}/${LAUNCHD_LABEL}`]);
    // Right after a bootout, launchd can still be tearing the old one down (error 5); retry.
    let loaded = run("launchctl", ["bootstrap", domain, path]);
    for (let tries = 0; loaded.status !== 0 && tries < 5; tries++) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      loaded = run("launchctl", ["bootstrap", domain, path]);
    }
    if (loaded.status !== 0)
      throw new Error(`launchctl couldn't start the runner: ${loaded.stderr}`);
    log(`Running in the background and at login. Logs: ${spec.logFile}`);
    return true;
  }
  if (hasUserSystemd()) {
    const path = systemdPath();
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, systemdUnit(spec));
    run("systemctl", ["--user", "daemon-reload"]);
    run("systemctl", ["--user", "enable", SYSTEMD_UNIT]);
    const started = run("systemctl", ["--user", "restart", SYSTEMD_UNIT]);
    if (started.status !== 0)
      throw new Error(`systemd couldn't start the runner: ${started.stderr}`);
    // Without lingering, user services stop at logout; most systems let users turn it on.
    const linger = run("loginctl", ["enable-linger", userInfo().username]);
    log(
      linger.status === 0
        ? "Running in the background, also when you're logged out. Logs: yapm-runner logs"
        : "Running in the background while you're logged in. To keep it running after you log out: sudo loginctl enable-linger $USER",
    );
    return true;
  }
  log("This system has no launchd or systemd user services. Run: yapm-runner start");
  return false;
}

export async function uninstallService(log: (line: string) => void) {
  if (process.platform === "darwin") {
    run("launchctl", ["bootout", `gui/${userInfo().uid}/${LAUNCHD_LABEL}`]);
    await rm(launchdPath(), { force: true });
  } else if (hasUserSystemd()) {
    run("systemctl", ["--user", "disable", "--now", SYSTEMD_UNIT]);
    await rm(systemdPath(), { force: true });
    run("systemctl", ["--user", "daemon-reload"]);
  }
  log("The runner no longer runs in the background.");
}

/** Follows the runner's output. */
export function followLogs(logFile: string) {
  const [command, args] =
    process.platform === "darwin" || !hasUserSystemd()
      ? ["tail", ["-n", "100", "-F", logFile]]
      : ["journalctl", ["--user", "-u", SYSTEMD_UNIT, "-n", "100", "-f"]];
  spawnSync(command as string, args as string[], { stdio: "inherit" });
}
