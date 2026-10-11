# yapm runner

Runs your company's AI agents on this machine, with your own Claude account or API key.
The hub decides who runs what; the runner claims runs, works through the Claude Agent SDK,
streams the transcript back, and obeys Stop. Your Claude sign-in or key and your files never
leave the machine.

On the Machines page in yapm, press **Add machine** and paste the command into Terminal on
the computer you're adding:

```sh
curl -fsSL https://your-hub.example/install.sh | sh -s -- --token lms_…
```

It installs the runner into `~/.yapm-runner` (with a private Node.js when the machine has no
Node 22+), connects it with the one-time token, asks how agents should use Claude (your Claude account or
an Anthropic API key) if it isn't set up yet and keeps it running
in the background (launchd on macOS, systemd on Linux). Run it again without `--token` to update.

```sh
yapm-runner logs                # follow what it's doing
yapm-runner login --claude      # switch agents to your Claude account
yapm-runner login --api-key sk-ant-…   # or to an Anthropic API key
yapm-runner service uninstall   # stop running in the background
```

By hand, or with the npm package: `yapm-runner enrol --hub https://your-hub.example` prints a
six-digit code to approve in the app (or pass `--token`), then `yapm-runner start`.

Settings live in `~/.yapm-runner/config.json`. Agents start in your home folder and may work
anywhere on the machine; their Claude sign-in, sessions and settings live in
`~/.yapm-runner/claude`.

Agents connect the MCP servers they need themselves: you approve each one, and sign in to it, from
its request in the app. The hub hands a run the servers its agent may use. Your own Claude Code
setup is never read or changed. To give every agent on this machine a server by hand, add it under
`"mcpServers"` in Claude Code's format. Agents still ask you before using a server's tools.

```json
"mcpServers": {
  "github": {
    "type": "http",
    "url": "https://api.githubcopilot.com/mcp/",
    "headers": { "Authorization": "Bearer github_pat_…" }
  }
}
```

## OpenCode instead of Claude

To run a machine's agents on a ChatGPT or Copilot plan, or any provider's API key, pick
**OpenCode** when the installer asks, or run `yapm-runner login --opencode`. The runner installs
its own OpenCode 1.19 into `~/.yapm-runner/opencode` (any other `opencode` on the machine is left
alone), opens OpenCode's sign-in, then `yapm-runner service install` to restart. Choose models per
tier in `config.json` (left out, OpenCode's default):

```json
"opencode": { "models": { "small": "openai/gpt-5-mini", "standard": "openai/gpt-5", "top": "openai/gpt-5" } }
```

`yapm-runner login --claude` switches back. Usage windows on the Usage page are Claude's only.

The runner also tells the hub which Claude login it uses and how full your plan's usage windows
are (the same numbers as Claude Code's `/usage`), for the Usage page. It reads them when a run
ends and, while idle, every 10 minutes by opening Claude Code without a prompt, which calls no
model and uses none of your plan.

## Releasing

Push a tag `runner-v<version>` matching `version` in `package.json`; the release workflow
builds, tests and publishes the package with the repository's `NPM_TOKEN` secret.
