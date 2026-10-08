# Life OS: a Linear clone run by AI employees

**Status:** v4: self-hostable on any platform, agents on the Claude Agent SDK with the owner's own subscription · 2026-10-08
**Repo:** github.com/youssefaltai/ai-life-os (empty today)

## 1. The idea in one paragraph

A near carbon copy of Linear with one workspace, one human (the owner) and many AI agents as employees, led by a CEO agent. Teams are units of the business, which agents can create, staff and dissolve themselves. Agents receive, triage, plan, do and report on work through issues, comments, projects and cycles, exactly as people do at a company that runs on Linear. The owner uses it from a desktop browser and from an iPhone, mostly by approving requests, reading briefs and steering through comments. The work itself runs on the owner's machines (one or more Macs) and the agents coordinate only through the shared issue tracker, so it doesn't matter which machine an agent runs on.

## 2. What the scenario changed (gap analysis)

Each row is a moment from the scenario, what v1 of the plan was missing, and how v2 handles it.

| # | Scenario moment | Gap in v1 | v2 design |
|---|---|---|---|
| 1 | Push notification on iPhone in the morning | Phone support was a phase 5 "PWA" item | Installable PWA with Web Push from day one of the agent phase; mobile layouts for Inbox, issue, approvals and runs |
| 2 | Phone and several Macs all reach the same system | v1 assumed self-hosting next to the agents | **Hub and runners**: one hub server reachable from anywhere (the self-hoster's VPS, Cloudflare account, or any Docker host), plus a runner daemon on each Mac that connects outbound to the hub. No inbound ports on any Mac (section 5) |
| 3 | Approve, always allow, reject with a reason | Only a "Needs approval" status | First-class **Requests** and **Grants**. Approve once, Always allow (creates a standing grant with a scope), Reject (reason required). Grants are listed, scoped, revocable and readable by agents (section 6) |
| 4 | "Runs" tab on an issue, watch live, read finished ones | Agent activity was a short summary stream | First-class **Runs**: every agent session is a run tied to an issue, agent and machine, with a full streamed transcript (thoughts, tool calls, outputs, cost) |
| 5 | Stop a misbehaving agent, add a reason note | Missing | **Stop** button sends a kill to the runner within seconds; a stop reason is required and becomes a feedback record that feeds self-improvement |
| 6 | Agents "running on my Mac", dispatched while I'm AFK | Built-in dispatcher lived in the server, phase 4 | Dispatcher on the hub decides who should wake; runners claim and execute runs locally with the Claude Agent SDK. Built in the agent phase, not last |
| 7 | Structured output, decide to reply, react, ignore or wait | Missing | **Decision step** before every run: a cheap model call with a strict JSON schema chooses `ignore`, `react`, `reply`, `wait_until`, `work`, `delegate` or `escalate`. Only `work` starts an expensive full session (section 7) |
| 8 | Agent asks to add a Slack MCP for one employer | Missing | **Capabilities**: MCP servers are installed per machine and granted per agent. Adding one is a Request; the runner installs it on that machine after approval |
| 9 | MCP login: link in a comment, paste back the localhost URL | Missing | Runs can pause in a **needs input** state and resume when the owner replies. The runner starts the MCP OAuth flow, posts the link, and accepts the pasted localhost callback URL from a comment. Tokens stay on the Mac. Later improvement: a hub-hosted callback so no pasting is needed |
| 10 | Company restructures: new teams, hiring, firing | Agents could only work issues | Org changes are API actions (`teamCreate`, `agentHire`, `agentRetire`, `charterUpdate`) governed by grants, so the CEO can restructure within what you've allowed |
| 11 | Events log of what happened | Only per-issue activity | Workspace-wide **audit log**: every mutation by anyone, with actor, run, reason. Queryable by agents |
| 12 | CEO explains how and why the business self-improved with metrics | Missing | **Metrics engine**: metrics are defined as data (a query over the event log), computed deterministically on a schedule, stored as snapshots per agent and team. Agents read them; they never invent numbers |
| 13 | Owner and CEO agree on a new metric | Missing | Metric definitions are versioned records; adding or changing one is a normal change the CEO can make (with your grant) and it's in the audit log |
| 14 | CEO suggests revoking an "always allow" grant | Missing | Grants are visible to the CEO; a weekly governance ritual reviews grant usage and proposes revocations as Requests to you |
| 15 | CEO decides no team fits a research task and builds one | Missing pieces covered by rows 10 and 7 | Covered by org actions plus delegation; the new team's lead breaks the issue into sub-issues |
| 16 | Another employer's corporate Mac joins | Missing | Machine enrolment: run the runner, get a pairing code, approve it as a Request. Each machine has **tags** (e.g. `employer-a`) and runs are routed only to machines whose tags and installed MCPs match the work |
| 17 | Agents on different machines coordinate | Covered by design | Hub is the only shared state; agents talk only through issues, comments, mentions and reactions |
| 18 | Agents mentioning each other all day | Risk not addressed | Loop and cost guards: per-agent wake budget, cooldowns, a "don't wake on your own events" rule, and the decision step's `ignore`/`react` options |

Two items need your attention beyond the design:
- **Employer data and devices.** Running agents on a corporate Mac and reading an employer's Slack is your call against your employers' policies. The system will keep each employer's machine, MCP connections and tagged issues separate, but it can't decide what's allowed.
- **iPhone notifications.** iOS supports Web Push for a PWA added to the home screen, but not action buttons on the notification. Tapping opens a one-screen approval view, so approving is two taps. A native app could add buttons later.

## 3. The key design bet: make it Linear-shaped for agents too

Models have already read Linear's docs, its GraphQL API and the official Linear MCP server's tools. If our API and MCP tools use the same names and semantics (`issueCreate`, `team.states`, `list_issues`, `create_comment`, identifiers like `FIN-42`), every agent already knows how to use the company's tools. New concepts that Linear doesn't have (runs, requests, grants, machines, metrics) follow the same naming style.

Surfaces over one core:

| Surface | User | Shape |
|---|---|---|
| Web app (desktop and installed PWA) | Owner | Linear's UI: keyboard-first, instant, list/board/timeline; mobile layouts for the daily loop |
| GraphQL API | Agents, runners, scripts | Mirrors Linear's public GraphQL schema, plus the new entities |
| MCP server | Agents in runs (and any outside MCP client) | Mirrors the official Linear MCP tools, plus tools for runs, requests, metrics and org actions |
| Runner protocol | Runner daemons on Macs | Outbound WebSocket: claim run, stream events, receive stop |
| Webhooks | Anything external | Linear's payload shape |

## 4. Feature set to replicate from Linear

"Skip" means it has no meaning for one owner plus agents.

**Core work tracking.** Workspace; teams with keys; members (human or agent); issues with identifier, Markdown description, status, priority, estimate, assignee, labels and label groups, due date, sub-issues, relations (blocks, blocked by, related, duplicate); per-team workflow states (Triage, Backlog, Unstarted, Started, Completed, Canceled) with auto-close and auto-archive; comments with threads, reactions, mentions; attachments; per-issue activity; list and board views with grouping, ordering, display options and AND/OR filters; saved views; favorites; My Issues; Inbox with notifications, subscriptions and snooze; Cmd+K; Linear's keyboard shortcuts; bulk edit; peek; search.

**Planning.** Cycles (cadence, cooldown, rollover, burn-up); projects (lead, status, health, target date, milestones, updates, documents); initiatives; roadmap and timeline; triage; issue templates; recurring issues; SLAs; documents with a rich editor; insights charts.

**Agents.** Linear's own "agents" model (delegate an issue to an agent, agent session activity on the issue) extended into the runs, requests and grants described below.

**Skip.** SSO, billing, multiple workspaces, guests, Linear's built-in Slack/GitHub integrations (agents use MCPs instead), customer requests.

## 5. Architecture: hub and runners

```
 iPhone (PWA, Web Push) ─┐
 Desktop browser ────────┼──►  HUB (CF/VPS) ◄─── outbound WebSocket ──── Runner on Mac #1 (personal)
                         │     SQLite (D1 or file)                          ├ Agent SDK (owner's Max login)
                         │     GraphQL + MCP + realtime                     ├ installed MCPs (Slack: employer A)
                         │     dispatcher, scheduler                        └ local tokens and files
                         │     metrics engine
                         └──                       ◄──── outbound WebSocket ──── Runner on Mac #2 (employer B)
```

- **Hub** holds all shared state: issues, comments, org, runs and their transcripts, requests, grants, audit log, metrics. It runs the dispatcher (who should wake for an event), the scheduler (rituals), the metrics engine and push notifications. **The hub never calls a model**: it's fully deterministic and needs no AI credentials, so it costs nothing beyond hosting.
- **Runner** is a small Node daemon on each machine. It enrols with a pairing code (approved by you), advertises its tags, installed MCPs and capacity, claims runs the hub assigns it, runs the agent locally with the **Claude Agent SDK** on the owner's subscription (section 5b), streams every event back, and obeys stop signals. Secrets (MCP tokens, employer credentials, files, the Claude login) never leave the machine.

## 5a. Self-hosting on any platform

The product is self-hosted: each owner brings their own hosting and their own Claude Code subscription. The hub is one codebase with thin platform adapters:

| Concern | Core interface | Cloudflare adapter | VPS / Docker adapter |
|---|---|---|---|
| HTTP, GraphQL, MCP | Hono app (runs on both) | Workers + Pages for the web app | Node server serving the web app |
| Database | SQLite dialect via Drizzle | D1 | SQLite file (libSQL), with Litestream backups |
| Realtime fan-out | `Realtime` interface | Durable Objects with WebSocket hibernation | In-process WebSocket hub |
| Blobs (transcripts, attachments) | S3-style interface | R2 | Local disk or any S3 bucket |
| Schedules and delayed jobs | `Scheduler` interface | Cron Triggers + Durable Object alarms | In-process scheduler backed by a SQLite jobs table |
| Full-text search | SQLite FTS5 | D1 FTS5 | SQLite FTS5 |

- One database dialect (SQLite) everywhere means one schema and one set of migrations. Postgres is dropped.
- Both targets are built and tested in CI. Deploy is one command: `wrangler deploy` or `docker compose up`.
- Cloudflare's free plan fits one owner and a team of agents if the hub stays lean (about 10ms CPU per request) and transcripts are batched into blob storage rather than written row by row into D1.

## 5b. Claude Agent SDK is the agent engine

Each self-hoster brings their own Claude Code subscription (e.g. Max). The runner uses the **Claude Agent SDK** (TypeScript) on that machine, authenticated with the owner's own subscription login. Every agent wake, decision or work, is an SDK `query()`.

What the SDK gives us, mapped to the scenario:

| Need | Agent SDK feature |
|---|---|
| Live transcript | Stream every SDK message (assistant text, thinking, tool use, tool results, usage) to the hub |
| Strict JSON decisions and run results | Structured output: `outputFormat: { type: "json_schema", schema }`, validated again on the hub |
| Cheap decisions | Decision step is a short `query()` on a small model with no tools and a decision schema; work runs use a larger model |
| Grants enforced on every tool call | `canUseTool` callback checks the agent's grants with the hub, or opens a Request and waits for your answer; `PreToolUse` hooks for audit logging |
| Per-agent MCPs on each machine | `mcpServers` passed per query from the agent's config on that machine, plus our hub MCP server |
| MCP OAuth login with localhost callback | Runner runs the OAuth flow for the MCP, posts the link, takes the pasted callback URL from your comment, stores tokens locally |
| Pause for input, then continue | Run ends in `needs_input`; later `resume: <session id>` when you reply |
| Stop immediately | `AbortController` on the query; stop reason recorded |
| Agent identity and context | `systemPrompt` built from charter, handbook and lessons; per-agent working directory via `cwd` |

Subscription limits replace dollar budgets. Max has usage windows rather than a bill, so budgets are counted in runs and model tier per agent, the runner reports when it hits a usage limit, and the dispatcher queues work until the window resets and tells you in the morning brief.
- **Routing.** A run is assigned to a machine that has the tags and MCPs the agent and issue need. If none is online, the run waits in a queue and the issue shows why.
- **Agents talk only through the hub**, so two agents on two Macs coordinate the same way two people in different offices do on Linear.

## 6. Requests, grants and approvals

- A **Request** is an agent asking for something it isn't allowed to do yet: a tool call class, adding an MCP to a machine, enrolling a machine, hiring or retiring an agent, spending money, contacting a real person, etc. It carries the asker, the run, the issue, the exact action and a reason.
- The CEO can pre-screen requests (approve within its own grants, or forward to you with a recommendation). Requests that reach you show in the Inbox and as a push notification.
- You answer **Approve once**, **Always allow** (choose the scope: this agent or team or everyone, this action, optionally this resource) or **Reject** with a required reason.
- An **always allow** creates a **Grant**. Grants have scope, creator, usage counts and last-used time. You can revoke any grant; the CEO reviews them weekly and proposes revocations.
- Every rejection reason and stop reason becomes a **feedback record** linked to the agent, run and issue.
- The runner enforces grants before executing a tool call, so permission isn't only a prompt instruction.

## 7. How agents think: event-driven, structured, cheap

1. **Events** (assignment, mention, comment on a subscribed issue, reaction, status change, schedule tick, request answered) reach the dispatcher.
2. The dispatcher applies **wake rules** (who cares about this event) and **guards** (budget left, cooldown, not your own event, no runaway mention loops).
3. For each candidate agent, the hub sends a **decision step** to a runner: a small-model Agent SDK call with structured output (strict JSON schema) with the agent's charter, the event and a compact context, returning strict JSON, for example:
   ```json
   { "action": "react", "emoji": "+1", "reason": "Acknowledged; nothing for me to do" }
   { "action": "wait_until", "until": "2026-10-09T09:00:00Z", "reason": "Blocked on FIN-12" }
   { "action": "work", "model_tier": "standard", "goal": "Draft the reply to the landlord", "reason": "Assigned and unblocked" }
   ```
   `ignore`, `react`, `reply` (short comment) and `wait_until` are applied by the hub without starting a work session. `work`, `delegate` and `escalate` create a run on a runner.
4. Inside a run, the agent uses MCP tools whose inputs are strict JSON schemas, and ends with a structured **run result** (outcome, status change, comments posted, follow-ups, needs-input). The hub validates it before applying anything.
5. Model tiers protect the subscription's usage limits: small model for decisions, standard for most work, top tier only when the decision step asks for it and the agent's run budget allows. Every run records tokens and duration.

## 8. Self-improvement loop

- **Inputs:** stop reasons, rejection reasons, owner comments tagged as feedback, run outcomes, and metric snapshots.
- **Metrics engine:** metric definitions are records (name, description, query over the event log, unit, target, owner). The hub computes them on a schedule per agent, team and company. Starting set: cycle time, throughput, first-pass acceptance (done without reopen), approval rejection rate, stop rate, usage per completed issue, SLA breach rate, blocked time.
- **Retrospectives:** on a schedule, each team lead runs a retro over its feedback and metrics and proposes changes: charter edits, handbook edits, new wake rules, hiring or retiring agents, team changes. Changes within grants are applied; others become Requests.
- **Memory:** charters, the handbook and a per-agent "lessons" document are versioned, so every change is traceable to the feedback that caused it.
- **Explainability:** the CEO answers "what changed and why" from the audit log, the versions and the metric snapshots, citing them, rather than from memory.

## 9. Tech stack

| Layer | Choice |
|---|---|
| Language | TypeScript everywhere |
| Repo | pnpm workspaces + Turborepo: `apps/web`, `apps/hub-cloudflare`, `apps/hub-node`, `apps/runner`, `packages/core`, `packages/schema`, `packages/mcp`, `packages/ui` |
| Database | SQLite via Drizzle: D1 on Cloudflare, libSQL file on a VPS; FTS5 search |
| API | Hono + GraphQL Yoga + Pothos (Linear-shaped schema), all runtime-agnostic |
| Realtime | WebSocket deltas to browsers; separate WebSocket channel for runners |
| Web client | React + Vite SPA, TanStack Router, MobX normalized store, IndexedDB cache, optimistic writes; installable PWA with service worker and Web Push (VAPID) |
| UI | Tailwind, Radix primitives, cmdk, Tiptap, dnd-kit |
| MCP | Official TypeScript MCP SDK, Streamable HTTP |
| Agents | Claude Agent SDK (TypeScript) in the runner, on the owner's subscription; structured output for decisions and run results |
| Jobs | `Scheduler` interface: Cron Triggers + DO alarms on Cloudflare, SQLite jobs table on Node |
| Auth | Owner: passkey; agents: scoped tokens issued per run; runners: machine credentials from enrolment |
| Tests | Vitest, Playwright |
| Deploy | Hub: `wrangler deploy` or `docker compose up`. Runner: `npx` installable daemon (launchd service on macOS, systemd on Linux) |

## 10. Build order

Each phase ends with something usable; one PR per feature-sized slice.

**Phase 0: Foundations.** Monorepo, SQLite schema and migrations, hub core with both Cloudflare and Node adapters, owner passkey login, CI that deploys and tests both targets, first-run setup that creates a blank company (just the owner and the CEO agent), audit log from the first mutation.

**Phase 1: Linear's core for the owner.** Teams, states, issues, labels, sub-issues, relations, comments, reactions, activity; app shell, list and board, issue page and peek, filters, Cmd+K, shortcuts, bulk edit, My Issues; realtime; GraphQL API. *Done when you can run a team by hand the way you use Linear at work.*

**Phase 2: The company and the owner's daily loop.** Agent members, charters, org chart, org actions; Inbox, notifications, subscriptions; PWA install and Web Push; Requests, Grants and approvals (with mobile approval view); MCP server. *Done when an outside Claude Code session with a token can pick up an issue, ask for approval, and you approve it from your phone.*

**Phase 3: Runners and runs.** Runner daemon, machine enrolment and tags, routing, Runs tab with live and finished transcripts, Stop with reason, needs-input pause and resume from a comment, grant enforcement in the runner, MCP install requests and the OAuth paste-back flow. Dispatcher, wake rules, guards and the structured decision step. *Done when you can go AFK and agents on your Mac wake on mentions, work, talk to each other in comments, and you can watch and stop them.*

**Phase 4: Rituals and planning.** Scheduler; CEO morning brief (push plus a brief document: done yesterday, planned today, blocked); standups and weekly updates; cycles, projects, milestones, project updates, initiatives, roadmap, triage, templates, recurring issues, SLAs, documents, saved views, search.

**Phase 5: Self-improvement.** Metrics engine and snapshots, feedback records, retros, versioned charters, handbook and lessons, grant review ritual, CEO "explain what changed" tools, insights views.

**Phase 6: Polish.** Hub-hosted OAuth callback (no pasting), native iOS app if notification buttons matter, themes, import from Linear, export.

## 11. Defaults I'm assuming

1. API and MCP mirror Linear's names and shapes; new concepts follow the same style.
2. Hub self-hosted on Cloudflare or any VPS/Docker host, both supported from day one; machines run the runner and never accept inbound connections.
6. Agents run on the owner's own Claude Code subscription; the hub needs no AI credentials.
3. The CEO agent sits at the top of the org and is the default assignee for anything unassigned.
4. Agents can change the org (teams, hiring, charters) only within grants; you start with nothing "always allowed" except commenting, reacting and editing issues.
5. Visual design copies Linear's layout, density and shortcuts closely, with our own name and logo (not Linear's branding or assets).
7. The company starts blank: only the owner and the CEO. No teams, other agents or labels are pre-made; the CEO creates them as the owner's life calls for it.
8. The hub ships primitives, not cadences. Rituals (morning brief, standups, weekly updates) are recurring issues assigned to an agent, which agents create and change themselves; none are seeded or hardcoded.
