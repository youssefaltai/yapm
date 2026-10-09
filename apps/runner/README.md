# Life OS runner

Runs your company's AI agents on this machine, signed in with your own Claude subscription.
The hub decides who runs what; the runner claims runs, works through the Claude Agent SDK,
streams the transcript back, and obeys Stop. Secrets (your Claude sign-in, files) never
leave the machine.

On the Machines page in Life OS, press **Add machine** and paste the command into Terminal on
the computer you're adding:

```sh
curl -fsSL https://your-hub.example/install.sh | sh -s -- --token lms_…
```

It installs the runner into `~/.life-os-runner` (with a private Node.js when the machine has no
Node 22+), connects it with the one-time token, signs in to Claude if needed and keeps it running
in the background (launchd on macOS, systemd on Linux). Run it again without `--token` to update.

```sh
life-os-runner logs                # follow what it's doing
life-os-runner login               # sign in to Claude again
life-os-runner service uninstall   # stop running in the background
```

By hand, or with the npm package: `life-os-runner enrol --hub https://your-hub.example` prints a
six-digit code to approve in the app (or pass `--token`), then `life-os-runner start`.

Settings live in `~/.life-os-runner/config.json`.

The runner also tells the hub which Claude login it uses and how full your plan's usage windows
are (the same numbers as Claude Code's `/usage`), for the Usage page. It reads them when a run
ends and, while idle, every 10 minutes by opening Claude Code without a prompt, which calls no
model and uses none of your plan.

## Releasing

Push a tag `runner-v<version>` matching `version` in `package.json`; the release workflow
builds, tests and publishes the package with the repository's `NPM_TOKEN` secret.
