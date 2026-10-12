# yapm runner

Runs your company's AI agents on this machine, on Claude or OpenCode, with your own plan or API key.
The hub decides who runs what; the runner claims runs, works through the Claude Agent SDK or
OpenCode (per agent), streams the transcript back, and obeys Stop. Your sign-ins, keys and files
never leave the machine.

On the Machines page in yapm, press **Add machine** and paste the command into Terminal on
the computer you're adding:

```sh
curl -fsSL https://your-hub.example/install.sh | sh -s -- --token lms_…
```

It installs the runner into `~/.yapm-runner` (with a private Node.js when the machine has no
Node 22+), connects it with the one-time token, asks which AI agents should use (a Claude
subscription, an Anthropic API key, a ChatGPT plan, GitHub Copilot, or another provider's API key)
if it isn't set up yet and keeps it running in the background (launchd on macOS, systemd on Linux). Run it again without `--token` to update.

```sh
yapm-runner logs                # follow what it's doing
yapm-runner login               # see which AI agents use here, and add another
yapm-runner login --claude      # your Claude subscription
yapm-runner login --api-key sk-ant-…   # or an Anthropic API key
yapm-runner login --chatgpt     # a ChatGPT plan
yapm-runner login --copilot     # GitHub Copilot
yapm-runner login --provider openrouter --api-key sk-or-…   # another provider's key
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

## ChatGPT, Copilot and other providers

Sign in to a ChatGPT or GitHub Copilot plan, or any provider's API key (not a Claude
subscription), in `yapm-runner login`: the runner installs its own OpenCode 1.19 into
`~/.yapm-runner/opencode` (any other `opencode` on the machine is left alone), signs in through it,
and keeps the sign-in in OpenCode's own store; Claude stays set up. Then
`yapm-runner service install` to restart.

Which model each tier of work runs on is picked in yapm (Settings, or an agent's page), not here.
The runner tells the hub which providers it's signed in to and their models (Claude's from Claude
Code, the rest from OpenCode, listed again every 10 minutes), and the hub gives a run only to a
machine signed in to its model's provider. Claude's models run on the Claude Agent SDK, the rest on
OpenCode.

On a ChatGPT or Copilot plan, the Usage page shows its windows too, after the first run on it.
A small OpenCode plugin the runner installs reads the rate-limit headers on the provider's own
responses (ChatGPT's 5-hour and weekly windows, Copilot's monthly premium requests); it reads no
sign-in and makes no calls of its own.

OpenCode doesn't pass on MCP tools' read-only hints, so on a run's first ask about a server's
tool the runner lists that server's tools itself (briefly starting a copy of a local one), so
"read-only tools" grants work as on Claude. OpenCode agents get yapm's system prompt in place of
OpenCode's own coding prompt.

The runner also tells the hub which Claude login it uses and how full your plan's usage windows
are (the same numbers as Claude Code's `/usage`), for the Usage page. It reads them when a run
ends and, while idle, every 10 minutes by opening Claude Code without a prompt, which calls no
model and uses none of your plan.

## Releasing

Push a tag `runner-v<version>` matching `version` in `package.json`; the release workflow
builds, tests and publishes the package with the repository's `NPM_TOKEN` secret.
