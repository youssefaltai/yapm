import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installScript } from "@yapm/core";
import { describe, expect, it } from "vitest";

const HUB = "https://hub.example";

/** Runs the installer with stub node, npm and curl; returns what the runner was asked to do. */
function install(connectedTo?: string, token = "lms_x", runnerHome?: string) {
  const home = mkdtempSync(join(tmpdir(), "install-"));
  const bin = join(home, "stubs");
  mkdirSync(bin);
  const stub = (name: string, body: string) => {
    writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  // Logs each runner command; `status` succeeds once the machine has a config.
  stub(
    "node",
    `[ "$1" = -p ] && { echo 22; exit 0; }
shift; echo "$*" >> "$HOME/runner.log"
[ "$1" != status ] || [ -f "$HOME/.yapm-runner/config.json" ]`,
  );
  stub("npm", "exit 0");
  stub("curl", `while [ $# -gt 0 ]; do [ "$1" = -o ] && touch "$2"; shift; done`);
  if (connectedTo) {
    mkdirSync(join(home, ".yapm-runner"));
    const config = { hub: connectedTo, token: "lmr_x", machineId: "m", name: "Mac" };
    writeFileSync(join(home, ".yapm-runner/config.json"), JSON.stringify(config, null, 2));
  }
  const said = execFileSync(
    "sh",
    ["-s", "--", ...(token ? ["--token", token] : []), "--no-service"],
    {
      input: installScript(HUB),
      env: {
        HOME: home,
        PATH: `${bin}:/usr/bin:/bin`,
        ...(runnerHome ? { YAPM_RUNNER_HOME: join(home, runnerHome) } : {}),
      },
      encoding: "utf8",
    },
  );
  return { ran: readFileSync(join(home, "runner.log"), "utf8"), said, home };
}

describe("install.sh", () => {
  it("connects a new machine to this hub", () => {
    expect(install().ran).toContain(`enrol --hub ${HUB} --token lms_x`);
  });

  it("only updates a machine already connected to this hub", () => {
    expect(install(HUB).ran).not.toContain("enrol");
  });

  it("moves a machine connected to another hub over to this one", () => {
    expect(install("https://other.example").ran).toContain(`enrol --hub ${HUB} --token lms_x`);
  });

  it("doesn't ask to start a runner it's updating, which restarts by itself", () => {
    expect(install(HUB, "").said).not.toContain("yapm-runner start");
  });

  it("links yapm-runner on PATH to the default home", () => {
    const { home } = install();
    expect(readlinkSync(join(home, ".local/bin/yapm-runner"))).toBe(
      join(home, ".yapm-runner/bin/yapm-runner"),
    );
  });

  it("leaves the link alone for another home", () => {
    const { home } = install(undefined, "lms_x", ".yapm-runner-opencode");
    expect(existsSync(join(home, ".yapm-runner-opencode/bin/yapm-runner"))).toBe(true);
    expect(existsSync(join(home, ".local/bin/yapm-runner"))).toBe(false);
  });
});
