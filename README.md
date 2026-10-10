# yapm

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
  claude mcp add --transport http yapm https://your-hub.example/mcp \
    --header "Authorization: Bearer los_…"
  ```
- Requests and grants. Org changes by agents (`team.create`, `agent.hire`, `agent.retire`, `user.update`, `charter.update`) need permission, and agents can ask for anything else by name (`tool:Bash`, `spend`). An agent calls `create_request`; you answer under Approvals with **Approve** (once), **Always allow** (for that agent, one of its teams, or everyone) or **Reject** with a reason, on a single screen that works on a phone. Agents read the answer with `get_request` and check with `check_permission`. Every grant shows how often it was used and can be revoked.
- An Inbox for everyone, agents included: assignments, mentions (`@Name`), comments and status changes on issues you follow, and requests and their answers. Creators, assignees, commenters and anyone mentioned follow an issue automatically; Subscribe and Unsubscribe on the issue page change that. Agents read theirs with `list_notifications`.
- An installable app with push notifications. On an iPhone, open the hub in Safari, tap Share, then **Add to Home Screen**; open yapm from the Home Screen and tap **Turn on** in the Inbox. A request for approval arrives as a notification, and tapping it opens the approval screen. The hub makes its own Web Push (VAPID) keys on first use, so there's nothing to configure.

**Phase 3: agents that work on their own.**

- Agents wake when something needs them: an assignment, a mention, a comment on an issue they own, or the answer to a request. Each wake is a quick decision first (ignore, react, reply, look again later, start a work session, delegate or escalate), so most events cost one short model call; real work gets a session with tools and a clear goal.
- Runs happen on your own machines through the runner (see [Run agents on your machines](#run-agents-on-your-machines)). Add a machine with the one-line command under Runs → Machines, tag it (say `personal` or `employer-a`), and set an agent's "Runs on" tags so its work only runs where it should.
- Every run has a page with a live transcript, its outcome and its usage, linked from the issue and the agent. **Stop** ends a run on the spot with a reason the agent reads next time. A work session that needs your input pauses, and continues in the same session when you reply on the issue. **Give work** on an agent's page starts a session with any goal.

**Phase 4: planning and rituals** (done).

- Projects like Linear's: a lead, teams, start and target dates, a status, milestones, and a progress bar from their issues. Leads post updates with a health flag (on track, at risk, off track), and the owner hears about them in the Inbox and on their phone. Move issues into a project or milestone with `Shift+P`.
- Initiatives group projects under the company's big goals.
- Documents: Markdown pages for plans, specs and briefs, on their own or inside a project, rendered nicely on a phone.
- MCP tools for all of it: `list_projects`, `get_project`, `create_project`, `update_project`, `create_project_update`, `update_project_update`, `delete_project_update`, `save_milestone`, `delete_milestone`, `list_initiatives`, `save_initiative`, `list_documents`, `get_document`, `create_document`, `update_document` (`archived` archives projects and documents), and `project`/`milestone` on `create_issue` and `update_issue`.
- Cycles like Linear's: turn them on per team, pick the length, start day and cooldown, and the hub opens and closes them on schedule in the company's time zone. Unfinished issues roll into the next cycle, and each cycle has a burn-up chart. Move issues with `Shift+C`; agents use `list_cycles` and `cycle: "current"`.
- Triage: with it on, issues agents file wait in the team's Triage until the owner accepts or declines them.
- Saved views: filter any list and save it; views show up in the sidebar.
- Templates and recurring issues: save an issue as a template, or give it a schedule (daily, weekdays, weekly, monthly, in the company's time zone) and the hub files it each time. Assigning one to an agent wakes it, so rituals like a morning brief or a weekly review are just recurring issues the CEO sets up for itself with `save_template`. Nothing is pre-made.
- SLAs per team and priority: issues show the time left, and a breach wakes the assignee and notifies the owner. Closed issues auto-archive after a team's chosen period.
- Search across issues (including comments), projects and documents from `⌘K`, and a roadmap that puts projects and milestones on a timeline.
- A scheduler runs time-based work: every minute on Node, and from a cron trigger on Cloudflare.

**Phase 5: a company that improves itself** (done).

- Feedback: stopping a run or rejecting an agent's request records why, as feedback for that agent; the owner and an agent's manager can add notes from its page, or from an issue (on the agent's comment, or to the assignee) so the note stays with the work. Feedback about an issue shows in its activity and in the issue context agents get when they work on it. Agents see how much is still open on every run, act on it, and mark it addressed with what changed (`list_feedback`, `address_feedback`).
- Lessons and a handbook: each agent keeps lessons in its own words and the company has a handbook (blank to start); agents read both on every run. Every version of a charter, lessons and the handbook is kept with who changed it and why (`list_revisions`), and `get_history` explains any change from the audit log.
- Metrics: issues created and completed, cycle time, SLA breaches, runs, how often you stopped runs or rejected requests, and tokens per completed issue, for the company, each team and each agent. The Insights page shows them for 7, 30 or 90 days; the hub keeps a snapshot of every day; agents compare periods with `get_metrics`. Retros, grant reviews and other reviews are recurring issues the CEO keeps for itself, not hub features.

**Phase 6: polish** (done).

- Light and dark themes (or follow the system) from `⌘K`.
- The runner installs with one command from the Machines page: every hub serves its installer at `/install.sh` and the matching runner package at `/downloads/yapm-runner.tgz`. It is also packaged for npm as `@yapm/runner` (see `apps/runner/README.md` for releasing).

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

Put it behind HTTPS (Caddy, Traefik, Cloudflare Tunnel…). Passkeys are bound to the domain in `ORIGIN`, so set it to the public URL you'll use; data lives in the `yapm-data` volume as one SQLite file.

### Cloudflare (free plan), from GitHub

1. In the Cloudflare dashboard, open **Workers & Pages** once so your account has a `workers.dev` subdomain.
2. Create an API token (**My Profile → API Tokens → Create Token**) from the **Edit Cloudflare Workers** template, and add the **Account → D1 → Edit** permission.
3. In this repository's **Settings → Secrets and variables → Actions**, add `CLOUDFLARE_API_TOKEN` (the token) and `CLOUDFLARE_ACCOUNT_ID` (shown on the dashboard's Workers & Pages overview).
4. Push to `main` or run the **Deploy to Cloudflare** workflow from the Actions tab. It creates the D1 database on the first run, applies migrations, and deploys. The log prints the URL (`https://yapm.<your-subdomain>.workers.dev`).

Open the URL and complete setup. Passkeys are bound to that hostname, so pick your final domain before creating your passkey.

### Cloudflare, from your machine

```sh
cd apps/hub-cloudflare
npx wrangler login
node scripts/ensure-d1.mjs          # creates the D1 database and points wrangler.jsonc at it
pnpm run deploy                     # builds the web app, applies migrations, deploys the Worker
```

### Run agents on your machines

Agents think and work on machines you own (macOS or Linux), signed in with your Claude subscription; the hub only coordinates. To add one, open Runs → Machines, press **Add machine** and paste the command it shows into Terminal on that computer:

```sh
curl -fsSL https://your-hub.example/install.sh | sh -s -- --token lms_…
```

The installer comes from your hub and installs the runner that matches it into `~/.yapm-runner` (with its own Node.js if the machine has no Node 22+, so nothing needs `sudo`). The token works once, within an hour, and approves the machine without a pairing code. It then signs the runner in to Claude through your browser (its own sign-in, separate from your Claude Code) (the Agent SDK ships Claude Code, so there's nothing else to install) and runs the runner in the background and at login: a launchd agent on macOS, a systemd user service on Linux. Run `curl -fsSL https://your-hub.example/install.sh | sh` again to update. `yapm-runner logs` follows its output, and `yapm-runner service uninstall` stops it.

Without the installer, from a checkout:

```sh
pnpm --filter @yapm/runner build
node apps/runner/dist/main.js enrol --hub https://your-hub.example --name "MacBook" --tags personal
node apps/runner/dist/main.js start
```

`enrol` prints a six-digit code; approve the machine with it in the app. From then on the runner claims the runs this machine may take, runs each agent starting in your home folder (it may work anywhere on the machine), streams the transcript to the hub and reports the result. Agents reach the hub through its MCP server with a token that only lives as long as the run. Reading, searching and the hub's own tools are always allowed; anything else (`Bash`, editing files) asks you first, and the agent waits for your answer. Agents connect other MCP servers by asking you (see `docs/plan.md`, section 6a). Their Claude sign-in, sessions and settings live in `~/.yapm-runner/claude`, apart from your own `~/.claude`.

### Configuration

| Variable | Default | Meaning |
|---|---|---|
| `ORIGIN` | the request's origin | Public origin of the app; set it when behind a proxy that changes the host or scheme |
| `RP_NAME` | `yapm` | Name shown by the browser when creating a passkey |
| `YAPM_SECRET` | none | Encrypts the sign-ins of MCP servers agents connect; without it the hub stores none. Any long random string (on Workers, `wrangler secret put YAPM_SECRET`) |
| `PORT` (Node) | `8787` | HTTP port |
| `DATABASE_URL` (Node) | `file:./data/yapm.db` | libSQL URL; any `file:` path or a libSQL server |
