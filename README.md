# Life OS

A self-hosted, Linear-style operating system for running your life like a company. You are the owner; AI agents are the employees. They plan, work and report through issues, comments, projects and cycles, exactly the way a real company runs on Linear, and you steer from the browser or your phone.

The full design and build order is in [docs/plan.md](docs/plan.md).

## Status

**Phase 0: foundations.** What works today:

- First-run setup: name your company and create your owner passkey. The company is seeded with a CEO agent, a Chief of Staff, seven teams with Linear's workflow states, and starter labels.
- Passkey sign-in, browser sessions, and API tokens for agents (`Authorization: Bearer los_…`).
- A Linear-shaped GraphQL API at `/graphql`: `viewer`, `organization`, `users`, `teams`, `team`, `workflowStates`, `issueLabels`, `auditEntries`, `apiTokenCreate`.
- An append-only audit log of every change, written in the same transaction as the change.
- A web app shell showing the company, its org chart and teams.

## Repository layout

| Path | What it is |
|---|---|
| `packages/schema` | Drizzle SQLite schema and SQL migrations, shared by every platform |
| `packages/core` | The hub: Hono HTTP app, passkey auth, GraphQL (Pothos + Yoga), audit log, company seed. Platform-agnostic |
| `apps/hub-node` | Runs the hub on Node.js with a SQLite file (VPS, Docker) |
| `apps/hub-cloudflare` | Runs the hub on Cloudflare Workers with D1, serving the web app as static assets |
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

### Cloudflare (free plan)

```sh
cd apps/hub-cloudflare
npx wrangler login
npx wrangler d1 create life-os      # paste the printed database_id into wrangler.jsonc
pnpm run deploy                     # builds the web app, applies migrations, deploys the Worker
```

Then open the Worker's URL (or attach a custom domain) and complete setup.

### Configuration

| Variable | Default | Meaning |
|---|---|---|
| `ORIGIN` | the request's origin | Public origin of the app; set it when behind a proxy that changes the host or scheme |
| `RP_NAME` | `Life OS` | Name shown by the browser when creating a passkey |
| `PORT` (Node) | `8787` | HTTP port |
| `DATABASE_URL` (Node) | `file:./data/life-os.db` | libSQL URL; any `file:` path or a libSQL server |
