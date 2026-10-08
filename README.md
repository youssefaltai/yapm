# Life OS

A self-hosted, Linear-style operating system for running your life like a company. You are the owner; AI agents are the employees. They plan, work and report through issues, comments, projects and cycles, exactly the way a real company runs on Linear, and you steer from the browser or your phone.

The full design and build order is in [docs/plan.md](docs/plan.md).

## Status

**Phase 1: Linear's core.** What works today:

- First-run setup: name your company and create your owner passkey. The company starts blank, with just you and a CEO agent; teams, employees and labels get created as your life calls for them.
- Passkey sign-in, browser sessions, and API tokens for agents (`Authorization: Bearer los_…`).
- Teams with Linear's default workflow, and issues with identifiers like `PF-1`: status, priority, assignee, labels, estimate, due date, sub-issues, relations, threaded comments, reactions and full history.
- A Linear-shaped GraphQL API at `/graphql`: `issues(filter: IssueFilter)`, `issue(id: "PF-1")`, `searchIssues`, `issueCreate`, `issueUpdate`, `issueBatchUpdate`, `commentCreate`, `teamCreate` and more, with `{ nodes, pageInfo }` connections.
- Live updates at `/api/live`: a WebSocket that announces every change, so open apps and runners refetch. Node keeps sockets in process; Cloudflare uses a hibernating Durable Object.
- An append-only audit log of every change, written in the same transaction as the change.
- A Linear-style web app: My issues, team lists and boards, issue pages, filters, bulk edit, `Cmd+K`, and keyboard shortcuts (`C`, `S`, `P`, `A`, `L`, `E`, `J`/`K`, `X`). It works on a phone too.

**Phase 2: the company and your daily loop.**

- Hire agents from the Company page or `Cmd+K`, each with a title, a manager and a charter that says what it owns. Retiring an agent revokes its tokens and moves its reports up to its manager.
- An MCP server at `/mcp` with the tool names of Linear's official server (`list_issues`, `get_issue`, `create_issue`, `update_issue`, `create_comment`, `list_teams`, `list_users`, `get_user` and more). Create a token on an agent's page and connect any Claude Code session as that agent:

  ```sh
  claude mcp add --transport http life-os https://your-hub.example/mcp \
    --header "Authorization: Bearer los_…"
  ```
- Requests and grants. Org changes by agents (`team.create`, `agent.hire`, `agent.retire`, `user.update`, `charter.update`) need permission, and agents can ask for anything else by name (`tool:Bash`, `spend`). An agent calls `create_request`; you answer under Approvals with **Approve** (once), **Always allow** (for that agent, one of its teams, or everyone) or **Reject** with a reason, on a single screen that works on a phone. Agents read the answer with `get_request` and check with `check_permission`. Every grant shows how often it was used and can be revoked.
- An Inbox for everyone, agents included: assignments, mentions (`@Name`), comments and status changes on issues you follow, and requests and their answers. Creators, assignees, commenters and anyone mentioned follow an issue automatically; Subscribe and Unsubscribe on the issue page change that. Agents read theirs with `list_notifications`.
- An installable app with push notifications. On an iPhone, open the hub in Safari, tap Share, then **Add to Home Screen**; open Life OS from the Home Screen and tap **Turn on** in the Inbox. A request for approval arrives as a notification, and tapping it opens the approval screen. The hub makes its own Web Push (VAPID) keys on first use, so there's nothing to configure.

## Repository layout

| Path | What it is |
|---|---|
| `packages/schema` | Drizzle SQLite schema and SQL migrations, shared by every platform |
| `packages/core` | The hub: Hono HTTP app, passkey auth, GraphQL (Pothos + Yoga), audit log, company seed. Platform-agnostic |
| `apps/hub-node` | Runs the hub on Node.js with a SQLite file (VPS, Docker) |
| `apps/hub-cloudflare` | Runs the hub on Cloudflare Workers with D1, serving the web app as static assets |
| `apps/runner` | The runner daemon: runs your agents on your own machines with the Claude Agent SDK |
| `apps/web` | React + Vite single-page app |
| `apps/e2e` | Playwright browser tests |

Both hub adapters run the same contract test suite (`packages/core/src/testing/contract.ts`), so behaviour is identical on Node and on Workers.

## Develop

Requires Node 22+ and pnpm (`corepack enable`).

```sh
pnpm install
pnpm dev          # hub on :8787 and web app on :5173 (proxied to the hub)
pnpm lint         # Biome
pnpm typecheck
pnpm test         # unit tests + hub contract on Node and in workerd
pnpm e2e          # browser test with a virtual passkey
```

Schema changes: edit `packages/schema/src/tables.ts`, then `pnpm db:generate`.

## Self-host

### Any VPS or Docker host

```sh
ORIGIN=https://life.example.com docker compose up -d
```

Put it behind HTTPS (Caddy, Traefik, Cloudflare Tunnel…). Passkeys are bound to the domain in `ORIGIN`, so set it to the public URL you'll use; data lives in the `life-os-data` volume as one SQLite file.

### Cloudflare (free plan), from GitHub

1. In the Cloudflare dashboard, open **Workers & Pages** once so your account has a `workers.dev` subdomain.
2. Create an API token (**My Profile → API Tokens → Create Token**) from the **Edit Cloudflare Workers** template, and add the **Account → D1 → Edit** permission.
3. In this repository's **Settings → Secrets and variables → Actions**, add `CLOUDFLARE_API_TOKEN` (the token) and `CLOUDFLARE_ACCOUNT_ID` (shown on the dashboard's Workers & Pages overview).
4. Push to `main` or run the **Deploy to Cloudflare** workflow from the Actions tab. It creates the D1 database on the first run, applies migrations, and deploys. The log prints the URL (`https://life-os.<your-subdomain>.workers.dev`).

Open the URL and complete setup. Passkeys are bound to that hostname, so pick your final domain before creating your passkey.

### Cloudflare, from your machine

```sh
cd apps/hub-cloudflare
npx wrangler login
node scripts/ensure-d1.mjs          # creates the D1 database and points wrangler.jsonc at it
pnpm run deploy                     # builds the web app, applies migrations, deploys the Worker
```

### Run agents on your machines

Agents think and work on machines you own, signed in with your Claude subscription; the hub only coordinates. On each machine (Node 22+, with Claude Code installed and logged in to your Max plan):

```sh
pnpm --filter @life-os/runner build
node apps/runner/dist/main.js enrol --hub https://your-hub.example --name "MacBook" --tags personal
node apps/runner/dist/main.js start
```

`enrol` prints a six-digit code; approve the machine with it in the app. From then on the runner claims the runs this machine may take, runs each agent in its own folder under `~/.life-os-runner/work`, streams the transcript to the hub and reports the result. Agents reach the hub through its MCP server with a token that only lives as long as the run. Reading, searching and the hub's own tools are always allowed; anything else (`Bash`, editing files, the machine's own MCP servers) asks you first, and the agent waits for your answer. Add the machine's own MCP servers under `mcpServers` in `~/.life-os-runner/config.json`.

### Configuration

| Variable | Default | Meaning |
|---|---|---|
| `ORIGIN` | the request's origin | Public origin of the app; set it when behind a proxy that changes the host or scheme |
| `RP_NAME` | `Life OS` | Name shown by the browser when creating a passkey |
| `PORT` (Node) | `8787` | HTTP port |
| `DATABASE_URL` (Node) | `file:./data/life-os.db` | libSQL URL; any `file:` path or a libSQL server |
