import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installScript } from "@yapm/core";
import { describe, expect, it } from "vitest";

const HUB = "https://hub.example";

/** Runs the installer with stub node, npm and curl; returns what the runner was asked to do. */
function install(connectedTo?: string, token = "lms_x") {
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
      env: { HOME: home, PATH: `${bin}:/usr/bin:/bin` },
      encoding: "utf8",
    },
  );
  return { ran: readFileSync(join(home, "runner.log"), "utf8"), said };
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
});
