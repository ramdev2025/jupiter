# Deploying to Cloudflare

Jupiter deploys to **Cloudflare Workers + Containers**: a small Worker takes the
request and hands it to a container running the ordinary FastAPI app. Because the
container serves the dashboard too, the dashboard stays same-origin with the API and
there is no CORS to configure.

```
browser / Claude Code
        │
        ▼
Worker  (worker/index.ts)        starts the container, proxies the request
        │
        ▼
Container (Dockerfile)           uvicorn + FastAPI + the dashboard, port 8080
        │
        ▼
PostgreSQL (Neon)                the only persistent state
```

A Worker isolate cannot run this app - `uvicorn`, SQLAlchemy's sync engine and
`bcrypt` (a compiled C extension) all need a real Python process - which is why the
compute is a container rather than the Worker itself.

## Prerequisites

| | Why |
|---|---|
| **Docker** installed and running | `wrangler` builds the image locally. Required **even for `--dry-run`** |
| **Workers paid plan** | Containers is not on the free tier, and is still beta (no SLA) |
| `wrangler login` (or `CLOUDFLARE_API_TOKEN`) | to deploy to your account |
| A PostgreSQL URL | the container disk is ephemeral, so SQLite would be wiped on every restart |

## Database

Use the **pooled** Neon endpoint - the host contains `-pooler`:

```
postgresql://USER:PASSWORD@ep-xxx-pooler.REGION.aws.neon.tech/neondb?sslmode=require
```

Jupiter normalises `postgresql://` to psycopg v3 and disables prepared statements,
which is what Neon's transaction-mode pooler requires. Install the driver with
`pip install '.[postgres]'`; the Dockerfile already does.

> **Put the database in the same region as the container.** This is the single
> biggest performance factor. Measured from a laptop in APAC against Neon
> **us-east-2**, one round trip costs **585 ms**, and `/activity` - which issues
> about ten queries - took **5-9 seconds**. The same code against a local database
> answers in milliseconds. Cloudflare places containers near the user, so either
> pick a Neon region near your team, or enable
> [Smart Placement](https://developers.cloudflare.com/workers/configuration/smart-placement/)
> so the Worker runs near the database instead of near the user.

## Deploy

```bash
npm install                       # wrangler + @cloudflare/containers
npx wrangler login

# Secrets - never put these in wrangler.jsonc
npx wrangler secret put DATABASE_URL
npx wrangler secret put JUPITER_LLM_API_KEY     # optional; enables semantic detection

npx wrangler deploy
```

`wrangler deploy` builds the image, pushes it, and rolls it out. Container deploys are
rolling rather than instant, so the old version serves during rollout.

Then open the `workers.dev` URL (or your custom domain) and the setup wizard will
create the team and mint your key. The schema is created automatically on first
start - there is no migration step.

## Configuration

Non-secret values live in `wrangler.jsonc` under `vars`; secrets are set with
`wrangler secret put`. The Worker forwards both into the container at start.

| Name | Kind | Default | Meaning |
|---|---|---|---|
| `DATABASE_URL` | secret | - | Postgres URL. Required |
| `JUPITER_LLM_API_KEY` | secret | - | Absent ⇒ semantic detection is simply off |
| `JUPITER_LLM_MODEL` | var | `deepseek-v4-pro-0813` | |
| `JUPITER_LLM_BASE_URL` | var | Model IQ | Any OpenAI-compatible gateway |
| `JUPITER_LOCK_TTL` | var | `300` | Seconds a claim survives without a refresh |

`.env` is **not** used in the deployed container - it is excluded by
`.dockerignore`, so a local `.env` can never leak into an image layer.

## Wiring Claude Code to the deployed server

Exactly as for a local server, but pointing at the Worker URL. The Settings page
shows a ready-to-paste command with the right host and key filled in:

```bash
claude mcp add jupiter --scope user \
  --env JUPITER_SERVER=https://jupiter.<your-subdomain>.workers.dev \
  --env JUPITER_API_KEY=jpm_... \
  -- python -m jupiter_code.mcp_server
```

## Things worth knowing

**One container, deliberately.** The Worker routes to `getByName("singleton")`.
Jupiter is one team's shared source of truth; all state that matters is in Postgres,
and spreading requests across instances would only fragment the in-process semantic
cache. `max_instances: 2` exists to give rolling deploys headroom.

**Cold starts.** After `sleepAfter` (1h idle) the next request pays 2-3 s to start the
container. An open dashboard polls every 3 s, so it stays warm while anyone is
watching.

**bcrypt is the per-request floor.** Every authenticated request verifies an API key
with bcrypt: ~226 ms measured on a laptop core, and the container is allotted half a
vCPU (`standard-1`), so expect more. With the dashboard polling every 3 s this is the
dominant CPU cost. If it matters, the fix is an in-process cache of verified keys with
a short TTL - the stored hash stays bcrypt, so nothing is weakened.

**Ephemeral disk.** Nothing in the container filesystem survives a restart. That is
fine because Postgres holds all state, but it does mean `JUPITER_DB` must never point
at a file in production.

**Beta.** Containers has no SLA and its API may change. Pin your `compatibility_date`
and re-test after wrangler upgrades.

## If your network blocks `*.workers.dev`

Corporate web filters commonly classify `workers.dev` as *Web Hosting* and block it.
Forcepoint, for instance, answers with its own `200` page rather than a network error,
so the deployment looks healthy from Cloudflare's side while being unreachable from
inside the office:

```
Access Blocked - The Web site you requested is blocked by your organization.
URL      https://jupiter.<subdomain>.workers.dev:443
Reason   Matched categories: Web Hosting
```

This matters more than it first appears: it is not only the dashboard. Every
teammate's MCP server sets `JUPITER_SERVER` to that URL, so a blocked host means
Claude Code cannot check in either.

Options, best first:

1. **Attach a custom domain.** Put a hostname you own (on a zone already in this
   Cloudflare account) in front of the Worker. A normal company domain is usually
   categorised sensibly, unlike `workers.dev`:

   ```jsonc
   "routes": [
     { "pattern": "jupiter.example.com", "custom_domain": true }
   ]
   ```

2. **Ask IT to allowlist the single host.** Narrower than unblocking the category.

3. **Confirm the deployment works from off-network first** - a phone on mobile data
   is enough to tell a blocked host apart from a broken container.

## If you cannot install Docker

`wrangler deploy --containers-rollout=none` deploys the Worker without building or
updating the container - useful for iterating on the Worker, useless for shipping the
app, since the container *is* the app. The practical alternatives are to build the
image in CI (GitHub Actions has Docker) or to host the Python app on a platform that
builds from a Dockerfile server-side, keeping only the dashboard on Cloudflare.
