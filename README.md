# Jupiter

**Team coding awareness for Claude Code.** Jupiter lets each developer's Claude Code
instance see which files their teammates' instances are touching *right now*, so two
people (and two agents) don't quietly rewrite the same file at the same time.

It is two pieces:

- a small **REST server** (FastAPI + SQLite) that one person on the team self-hosts;
- an **MCP server** (stdio) that each developer adds to Claude Code, which reports in
  to the shared server.

The server also serves a **web dashboard** at its root URL: a guided setup flow that
mints your key and hands you the `claude mcp add` command, then a live view of who
holds which file, with controls to claim, release and announce by hand. No build step;
see [`docs/dashboard.md`](docs/dashboard.md).

Once configured, Claude gets five tools:

| Tool | What it does |
|---|---|
| `jupiter_checkin` | Registers this session; returns a snapshot of team activity |
| `jupiter_lock_file` | Declares intent to edit a file; returns `clear` or `⚠ blocked by <member>` |
| `jupiter_unlock_file` | Releases the claim when done |
| `jupiter_who_is_working` | Lists every claimed file and who holds it |
| `jupiter_announce` | Broadcasts a short status message to teammates |

Claims are **advisory** and **auto-expire** (default 5 minutes without a refresh), so a
crashed editor or a forgotten unlock never wedges the team.

Optionally, Jupiter also flags **semantic** overlaps - *different* files whose work
probably collides anyway, like an implementation and its test, or a schema and the model
that maps it. That part uses a language model, is advisory only, and switches itself off
when no gateway is configured. See
[`docs/semantic-conflicts.md`](docs/semantic-conflicts.md).

## Quickstart (single machine, 2 minutes)

```bash
pip install -e .
jupiter-server --port 7420          # or: python -m jupiter_code
```

Open <http://127.0.0.1:7420/> and the dashboard will walk you through creating a team
and joining it. To do the same from a shell instead:

```bash
# 1. create an org (returns a slug + an admin key)
curl -X POST http://127.0.0.1:7420/orgs \
  -H 'Content-Type: application/json' -d '{"name": "My Team"}'

# 2. join it (returns YOUR member API key - keep it)
curl -X POST http://127.0.0.1:7420/orgs/my-team/join \
  -H 'Content-Type: application/json' -d '{"display_name": "Alice"}'
```

Then register the MCP server with Claude Code:

```bash
claude mcp add jupiter --scope user \
  --env JUPITER_SERVER=http://127.0.0.1:7420 \
  --env JUPITER_API_KEY=jpm_1_xxxxxxxx \
  -- python -m jupiter_code.mcp_server
```

Restart Claude Code and ask it to "check in with Jupiter". Full details in
[`docs/mcp-config.md`](docs/mcp-config.md).

## How a session looks

```
> jupiter_lock_file(file_path="src/payments.py", intent="editing", note="adding refunds")
clear - you hold src/payments.py (editing) until 2026-09-21T14:33:28Z

# meanwhile, on Dave's machine:
> jupiter_lock_file(file_path="src/payments.py")
⚠ blocked by Carol (editing) on src/payments.py - coordinate before editing, or pick another file
  - Carol is editing it (since 14:33:18Z, expires 14:33:28Z) - adding refunds
```

## Docs

- [`docs/setup.md`](docs/setup.md) - self-hosting the server, configuration, backups
- [`docs/mcp-config.md`](docs/mcp-config.md) - wiring Jupiter into Claude Code
- [`docs/dashboard.md`](docs/dashboard.md) - the web dashboard
- [`docs/deploy-cloudflare.md`](docs/deploy-cloudflare.md) - deploying to Cloudflare
  Workers + Containers, with PostgreSQL
- [`docs/semantic-conflicts.md`](docs/semantic-conflicts.md) - AI-suggested overlaps
  between different files
- [`docs/organizations.md`](docs/organizations.md) - orgs, members, API keys, the REST API

## Design notes

- **SQLite** is the only datastore (WAL mode). No broker, no Redis, no migrations.
- **Advisory locks, not mutexes.** `jupiter_lock_file` always records your intent and then
  tells you who else is there. It never blocks an edit - the agent (and the human)
  decides what to do with the warning.
- **`reading` vs `editing`.** Two readers of the same file never conflict; anything
  involving an editor does.
- **Path comparison is case-sensitive** after normalising separators to `/`, because on
  Linux `src/App.py` and `src/app.py` really are different files. Use repo-relative
  paths so teammates on different machines agree.
- **Keys are prefixed with their record id** (`jpm_<member_id>_<secret>`) and stored
  bcrypt-hashed, so verifying a key is one row lookup instead of a hash comparison
  against every member.

## Security scope

Jupiter is built for a trusted team network: a member key grants read access to the
org's activity and the ability to post claims and announcements. There is no TLS
termination, rate limiting, or key rotation built in - put it behind a reverse proxy or
a VPN/tailnet if it is reachable from anywhere untrusted. See
[`docs/setup.md`](docs/setup.md#exposing-it-safely).

## License

MIT - see [LICENSE](LICENSE).
