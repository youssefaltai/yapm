# Life OS runner

Runs your company's AI agents on this machine, signed in with your own Claude subscription.
The hub decides who runs what; the runner claims runs, works through the Claude Agent SDK,
streams the transcript back, and obeys Stop. Secrets (your Claude sign-in, MCP tokens,
files) never leave the machine.

```sh
# Once: sign in to Claude Code with your plan
claude

# Ask your hub to add this machine, then type the code it shows on the Machines page
npx @life-os/runner enrol --hub https://your-hub.example --name "My laptop" --tags personal

# Take work until stopped (Ctrl-C finishes cleanly)
npx @life-os/runner start
```

Settings live in `~/.life-os-runner/config.json`. Add MCP servers only this machine should
offer under `"mcpServers"`, in Claude Code's shape. Servers added from the hub (Machines page,
or an agent's approved request) are set up automatically; when one needs a sign-in, the hub
sends you a Connect link and the tokens are kept in `~/.life-os-runner/mcp-auth.json`.

## Releasing

Push a tag `runner-v<version>` matching `version` in `package.json`; the release workflow
builds, tests and publishes the package with the repository's `NPM_TOKEN` secret.
