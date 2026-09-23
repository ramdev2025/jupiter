# Self-hosting the Jupiter server

The Jupiter server is the shared source of truth: every developer's MCP server reports
into it. One person on the team runs it somewhere everyone can reach (a small VM, a
container, an always-on dev box, or a tailnet host).

## Install

```bash
pip install jupiter          # once published
# or, from a checkout:
pip install -e .
```

Python 3.10 or newer.

## Run

```bash
jupiter-server               # equivalent: python -m jupiter_code
```

```
jupiter 0.1.0
  database : sqlite:////home/you/.jupiter/jupiter.db
  lock TTL : 300s
  listening: http://0.0.0.0:7420  (docs at /docs)
```

The web dashboard is served at `/` (see [`dashboard.md`](dashboard.md)), interactive API
docs at `/docs`, and a liveness probe at `/healthz`:

```bash
curl http://127.0.0.1:7420/healthz
# {"status":"ok","version":"0.1.0","lock_ttl_seconds":300}
```

The dashboard is static files served by the same app, so it is same-origin and the
server adds no CORS allowance. `/healthz` and the API keep working even if the
dashboard assets are missing from the install.

### Options

| Flag | Env var | Default | Meaning |
|---|---|---|---|
| `--host` | - | `0.0.0.0` | Interface to bind |
| `--port` | - | `7420` | Port to bind |
| `--db` | `JUPITER_DB` | `~/.jupiter/jupiter.db` | SQLite file, or a full database URL |
| `--lock-ttl` | `JUPITER_LOCK_TTL` | `300` | Seconds a file claim survives without a refresh |
| `--reload` | - | off | Auto-reload on code changes (development only) |
| `--log-level` | - | `info` | uvicorn log level |

Semantic conflict detection is configured by environment (or `.env`) only, and is off
unless a key is present - see [`semantic-conflicts.md`](semantic-conflicts.md):

| Env var | Default | Meaning |
|---|---|---|
| `JUPITER_LLM_API_KEY` | - | Key for an OpenAI-compatible gateway. Absent = feature off |
| `JUPITER_LLM_MODEL` | `deepseek-v4-pro-0813` | Model id |
| `JUPITER_LLM_BASE_URL` | Model IQ | Gateway base URL, ending in `/v1` |
| `JUPITER_LLM_ENABLED` | on | Set `0` to disable while keeping the key configured |

The database file and its parent directory are created on first start. Tables are
created automatically at startup - there is no migration step.

### Choosing a lock TTL

The TTL is how long a claim stays visible after the holder's last interaction. Every
`jupiter_lock_file`, `jupiter_unlock_file` and `jupiter_announce` call refreshes the holder's
session, and re-locking the same file refreshes that claim.

- **Too short** (< 60s) and claims vanish while someone is still mid-edit.
- **Too long** (> 30m) and stale claims from a closed laptop linger.
- 5-15 minutes suits most teams.

Sessions themselves expire after `2 × TTL` (minimum 10 minutes) without a heartbeat;
when a session expires, all of its claims are released.

## Running it as a service

### systemd

```ini
# /etc/systemd/system/jupiter.service
[Unit]
Description=jupiter coordination server
After=network.target

[Service]
User=jupiter
Environment=JUPITER_DB=/var/lib/jupiter/jupiter.db
Environment=JUPITER_LOCK_TTL=600
ExecStart=/usr/local/bin/jupiter-server --host 0.0.0.0 --port 7420
Restart=always

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now jupiter
```

### Docker

```dockerfile
FROM python:3.12-slim
WORKDIR /app
COPY . .
RUN pip install --no-cache-dir .
ENV JUPITER_DB=/data/jupiter.db
VOLUME /data
EXPOSE 7420
CMD ["jupiter-server", "--host", "0.0.0.0", "--port", "7420"]
```

```bash
docker build -t jupiter .
docker run -d -p 7420:7420 -v jupiter-data:/data --name jupiter jupiter
```

## Exposing it safely

Jupiter assumes a trusted network. A member API key lets its holder read the org's
activity and post claims and announcements; the org admin key additionally lists
members. The server does **not** provide TLS, rate limiting, or key rotation.

Recommended deployments, in order of preference:

1. **A private network only** - a tailnet, VPN, or office LAN. Simplest and sufficient
   for most teams.
2. **Behind a reverse proxy with TLS** (Caddy, nginx, Traefik). Point `JUPITER_SERVER` at
   the `https://` URL; the MCP client sends the key as `Authorization: Bearer`, so TLS
   is what keeps it private in transit.
3. **Localhost only** (`--host 127.0.0.1`) for single-machine testing.

Do not put it on the public internet without a proxy and an allowlist.

## Backups

Everything lives in one SQLite file. Because WAL mode is on, copy it with the SQLite
backup API rather than `cp`:

```bash
sqlite3 /var/lib/jupiter/jupiter.db ".backup '/backups/jupiter-$(date +%F).db'"
```

The data is operational, not precious: worst case, the team recreates the org and
rejoins. Losing it does not lose any code.

## Upgrading

```bash
pip install -U jupiter && sudo systemctl restart jupiter
```

New tables are created on start. Existing API keys keep working across upgrades.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `cannot reach the jupiter server at ...` in a tool result | Server down, wrong `JUPITER_SERVER`, or a firewall. Check `curl <server>/healthz`. |
| `jupiter server returned 401: invalid API key` | `JUPITER_API_KEY` is wrong or the member was removed. Re-join to mint a new key. |
| `JUPITER_API_KEY is not set` | The MCP server started without its env block - see [`mcp-config.md`](mcp-config.md). |
| Claims disappear mid-edit | TTL too short; raise `--lock-ttl`. |
| Teammates' claims never appear | Everyone must point at the *same* server and org. Compare `jupiter_checkin` output. |
| Two people see different paths for one file | Use repo-relative paths (`src/app.py`), not absolute ones. |
