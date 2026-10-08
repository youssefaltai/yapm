import { describe, expect, it } from "vitest";
import { launchdPlist, systemdUnit } from "../src/service.js";

const spec = {
  command: ["/Users/ada/.life-os-runner/node/bin/node", "/Users/ada/My Apps/main.js", "start"],
  env: { LIFE_OS_RUNNER_HOME: "/Users/ada/.life-os-runner", PATH: "/opt/homebrew/bin:/usr/bin" },
  logFile: "/Users/ada/.life-os-runner/runner.log",
};

describe("background service", () => {
  it("writes a launchd agent that starts at login and restarts after a crash", () => {
    const plist = launchdPlist({ ...spec, env: { ...spec.env, NOTE: "a<b & c" } });
    expect(plist).toContain("<string>com.life-os.runner</string>");
    expect(plist).toContain("<string>/Users/ada/My Apps/main.js</string>");
    expect(plist).toContain("<key>RunAtLoad</key>\n  <true/>");
    expect(plist).toContain("<key>SuccessfulExit</key>\n    <false/>");
    expect(plist).toContain("<string>a&lt;b &amp; c</string>");
    expect(
      plist.match(/<string>\/Users\/ada\/.life-os-runner\/runner.log<\/string>/g),
    ).toHaveLength(2);
  });

  it("writes a systemd user unit with quoted paths", () => {
    const unit = systemdUnit({ ...spec, env: { ...spec.env, NOTE: '50% "off"' } });
    expect(unit).toContain(
      'ExecStart="/Users/ada/.life-os-runner/node/bin/node" "/Users/ada/My Apps/main.js" "start"',
    );
    expect(unit).toContain('Environment="LIFE_OS_RUNNER_HOME=/Users/ada/.life-os-runner"');
    expect(unit).toContain('Environment="NOTE=50%% \\"off\\""');
    expect(unit).toContain("Restart=on-failure");
    expect(unit).toContain("WantedBy=default.target");
  });
});
