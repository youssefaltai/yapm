import { describe, expect, it } from "vitest";
import { launchdPlist, serviceNames, systemdUnit } from "../src/service.js";

const spec = {
  command: ["/Users/ada/.yapm-runner/node/bin/node", "/Users/ada/My Apps/main.js", "start"],
  env: { YAPM_RUNNER_HOME: "/Users/ada/.yapm-runner", PATH: "/opt/homebrew/bin:/usr/bin" },
  logFile: "/Users/ada/.yapm-runner/runner.log",
};

describe("background service", () => {
  it("writes a launchd agent that starts at login and restarts after a crash", () => {
    const plist = launchdPlist(
      { ...spec, env: { ...spec.env, NOTE: "a<b & c" } },
      "com.yapm.runner",
    );
    expect(plist).toContain("<string>com.yapm.runner</string>");
    expect(plist).toContain("<string>/Users/ada/My Apps/main.js</string>");
    expect(plist).toContain("<key>RunAtLoad</key>\n  <true/>");
    expect(plist).toContain("<key>SuccessfulExit</key>\n    <false/>");
    expect(plist).toContain("<string>a&lt;b &amp; c</string>");
    expect(plist.match(/<string>\/Users\/ada\/.yapm-runner\/runner.log<\/string>/g)).toHaveLength(
      2,
    );
  });

  it("writes a systemd user unit with quoted paths", () => {
    const unit = systemdUnit({ ...spec, env: { ...spec.env, NOTE: '50% "off"' } });
    expect(unit).toContain(
      'ExecStart="/Users/ada/.yapm-runner/node/bin/node" "/Users/ada/My Apps/main.js" "start"',
    );
    expect(unit).toContain('Environment="YAPM_RUNNER_HOME=/Users/ada/.yapm-runner"');
    expect(unit).toContain('Environment="NOTE=50%% \\"off\\""');
    expect(unit).toContain("Restart=on-failure");
    expect(unit).toContain("WantedBy=default.target");
  });

  it("keeps the plain names for the default home", () => {
    expect(serviceNames("/Users/ada/.yapm-runner", "/Users/ada")).toEqual({
      label: "com.yapm.runner",
      unit: "yapm-runner.service",
    });
  });

  it("gives another home its own names, so it doesn't replace the default one", () => {
    expect(serviceNames("/Users/ada/.yapm-runner-opencode/", "/Users/ada")).toEqual({
      label: "com.yapm.runner.yapm-runner-opencode",
      unit: "yapm-runner-yapm-runner-opencode.service",
    });
  });
});
