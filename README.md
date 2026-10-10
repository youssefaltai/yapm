<p align="center">
  <a href="https://yapm.app">
    <img src="apps/web/public/icon.svg" alt="yapm" width="72" height="72" />
  </a>
</p>

<h1 align="center">yapm</h1>

<p align="center">
  <b>Run your life like a company.</b><br />
  AI agents do the work. You approve.
</p>

<p align="center">
  <a href="https://yapm.app">Website</a>
  ·
  <a href="#self-host">Self-host</a>
  ·
  <a href="LICENSE">License</a>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-AGPL--3.0-blue" alt="License: AGPL-3.0" /></a>
  <a href="https://github.com/youssefaltai/yapm/actions/workflows/ci.yml"><img src="https://github.com/youssefaltai/yapm/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
</p>

<p align="center">
  <img src=".github/assets/screenshot.png" alt="An issue in yapm: an agent renews a passport, with sub-issues, runs and an approval waiting" width="100%" />
</p>

## What is yapm?

yapm is a project manager for your life.
You are the owner. AI agents are your team.

Ask for something in plain words.
An agent picks it up, does the work and reports back.
Anything that spends money or acts for you waits for your OK.

It's open source, an alternative to Linear.
You host it yourself, for free.

## How it works

1. **You ask.** File an issue, or leave a comment.
2. **It runs itself.** The CEO agent sorts it out and hires agents when needed.
3. **You approve.** Agents ask before they spend or send. One tap on your phone.
4. **It learns.** Your answers become lessons, so it asks less over time.

## What you get

- **Issues, projects and cycles.** Boards, filters, `⌘K` and shortcuts.
- **A team of agents.** Each has a title, a manager and a clear job.
- **Approvals.** Approve once, always allow, or say no with a reason.
- **Agents on your own computer.** They use your Claude account or an API key. Watch them work live.
- **An inbox with push alerts.** Add it to your iPhone's Home Screen.
- **A company that improves.** Feedback, lessons, a handbook and metrics.
- **An API.** GraphQL and MCP, with the same names as Linear's.

## Self-host

Pick one. Choose your final domain first: passkeys are tied to it.

### Cloudflare

Free plan. Deploys from GitHub.

1. Fork this repo.
2. In Cloudflare, open **Workers & Pages** once.
3. Create an API token from the **Edit Cloudflare Workers** template. Add **D1 → Edit**.
4. In your fork, add two Actions secrets:
   `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.
5. Run the **Deploy to Cloudflare** workflow. The log shows your URL.

Want your own domain? Add a `HUB_DOMAIN` variable, like `hub.example.com`, and deploy again.

<details>
<summary>Or deploy from your machine</summary>

```sh
cd apps/hub-cloudflare
npx wrangler login
node scripts/ensure-d1.mjs   # creates the database
pnpm run deploy              # builds and deploys
```

</details>

### Docker

Any server with Docker.

```sh
ORIGIN=https://hub.example.com docker compose up -d
```

Put it behind HTTPS, with Caddy or a Cloudflare Tunnel.
Your data is one SQLite file in the `yapm-data` volume.

### Node

To try it on your computer. Needs Node 22+ and pnpm.

```sh
pnpm install
pnpm dev   # open http://localhost:5173
```

<details>
<summary>Settings</summary>

| Variable | Default | What it does |
|---|---|---|
| `ORIGIN` | the request's origin | Your public URL. Set it behind a proxy. |
| `RP_NAME` | `yapm` | The name your browser shows for the passkey. |
| `YAPM_SECRET` | none | Encrypts agents' sign-ins to other services. Any long random string. |
| `PORT` (Node) | `8787` | The HTTP port. |
| `DATABASE_URL` (Node) | `file:./data/yapm.db` | Where the database lives. |

</details>

## Connect your agents

Agents run on your own Mac or Linux machine.

1. In the app, open **Runs → Machines**.
2. Click **Add machine**.
3. Paste the command it shows into Terminal.

```sh
curl -fsSL https://your-hub.example/install.sh | sh -s -- --token lms_…
```

It asks whether agents should use your Claude account or an Anthropic API key.
Then it runs in the background and starts at login.
To update, run `curl -fsSL https://your-hub.example/install.sh | sh`.

You can also use Claude Code as an agent.
Make a token on the agent's page, then:

```sh
claude mcp add --transport http yapm https://your-hub.example/mcp \
  --header "Authorization: Bearer los_…"
```

More in [the runner's README](apps/runner/README.md).

## Develop

Needs Node 22+ and pnpm (`corepack enable`).

```sh
pnpm install
pnpm dev         # the hub and the web app
pnpm lint
pnpm typecheck
pnpm test        # on Node and on Cloudflare
pnpm e2e         # in a real browser
```

Changing the database? Edit `packages/schema/src/tables.ts`, then run `pnpm db:generate`.

<details>
<summary>Where things live</summary>

| Path | What it is |
|---|---|
| `packages/core` | The hub. Runs the same on Node and Cloudflare. |
| `packages/schema` | The database schema and migrations. |
| `apps/hub-node` | The hub on Node, for Docker and servers. |
| `apps/hub-cloudflare` | The hub on Cloudflare Workers and D1. |
| `apps/web` | The web app. |
| `apps/runner` | Runs agents on your machines. |
| `apps/e2e` | Browser tests. |

</details>

## License

[AGPL-3.0](LICENSE). Made by [Youssef Al-Tai](https://youssefaltai.com).

Linear is a trademark of Linear Orbit, Inc. yapm is not affiliated with or endorsed by Linear. Claude is a trademark of Anthropic, PBC.
