# Organizations, members and API keys

An **organization** ("org") is one team sharing an awareness feed. A **member** is one
person in that org. A **session** is one running Claude Code instance belonging to a
member - so a member with three windows open has three sessions, and all of them show
up under their name.

```
organization (my-team)
 ├── member Alice ── session 1 (~/work/api)   ── claims src/payments.py
 │                └─ session 2 (~/work/web)   ── claims web/app.tsx
 └── member Bob   ── session 3 (~/work/api)   ── claims tests/test_api.py
```

## Creating an org

Anyone who can reach the server can create one. The response contains an **admin key**
that is shown exactly once - store it in your password manager.

```bash
curl -X POST http://dev-box:7420/orgs \
  -H 'Content-Type: application/json' \
  -d '{"name": "My Team"}'
```

```json
{
  "org": "My Team",
  "slug": "my-team",
  "admin_api_key": "jpa_1_vt0D1Li2...",
  "lock_ttl_seconds": 300
}
```

The `slug` is derived from the name (lowercased, non-alphanumerics collapsed to `-`) and
is what every other URL uses. Pass `"slug": "..."` explicitly to choose your own. Slugs
are unique: a second `POST /orgs` with the same name returns `409`.

## Joining an org

Each developer joins once, with a display name their teammates will recognise. The
response contains **their** member key - also shown only once.

```bash
curl -X POST http://dev-box:7420/orgs/my-team/join \
  -H 'Content-Type: application/json' \
  -d '{"display_name": "Alice"}'
```

```json
{ "member_id": 1, "display_name": "Alice", "slug": "my-team", "api_key": "jpm_1_..." }
```

Put that key in `JUPITER_API_KEY` ([`mcp-config.md`](mcp-config.md)). Display names are
unique per org; joining twice with the same name returns `409` rather than minting a
second identity - if someone loses their key, see below.

> Joining is intentionally open: anyone who can reach the server and knows the slug can
> join. That is fine on a private network, which is the deployment Jupiter is designed
> for. If you need gated membership, put the server behind an authenticating proxy.

## Two kinds of key

| Key | Format | Can do |
|---|---|---|
| Member | `jpm_<member_id>_<secret>` | Everything a session needs: check in, claim/release files, announce, read activity |
| Org admin | `jpa_<org_id>_<secret>` | Read-only oversight: list members, read activity. Cannot hold claims. |

Both are random 256-bit tokens, stored bcrypt-hashed. The embedded id is what makes
verification a single row lookup. Send either as `Authorization: Bearer <key>` or
`X-API-Key: <key>`.

### Rotating or replacing a key

There is no rotation endpoint in 0.1.0. To replace a member's key, delete the row and
re-join:

```bash
sqlite3 ~/.jupiter/jupiter.db \
  "DELETE FROM members WHERE org_id = 1 AND display_name = 'Alice';"
curl -X POST http://dev-box:7420/orgs/my-team/join \
  -H 'Content-Type: application/json' -d '{"display_name": "Alice"}'
```

Deleting a member cascades to their sessions and claims. This is also how you remove
someone who has left the team.

## Seeing what the team is doing

Members and admins can both read the org's feed.

```bash
export K="jpm_1_..."
curl -H "Authorization: Bearer $K" http://dev-box:7420/orgs/my-team/activity
curl -H "Authorization: Bearer $K" http://dev-box:7420/orgs/my-team/members
```

`/activity` returns the claims held right now, who holds them, when each expires, the
list of members with a live session, and recent announcements (last hour, up to 20).
Expired claims and dead sessions are pruned on read, so it is always current.

## REST API reference

All request and response bodies are JSON. `/docs` on a running server gives you the
generated, clickable version.

### Public (no key)

| Endpoint | Purpose |
|---|---|
| `GET /healthz` | Liveness + configured lock TTL |
| `POST /orgs` | Create an org → `{slug, admin_api_key}` |
| `POST /orgs/{slug}/join` | Join an org → `{member_id, api_key}` |

### Member or admin key

| Endpoint | Purpose |
|---|---|
| `GET /orgs/{slug}/members` | Members, with live session counts and last-seen times |
| `GET /orgs/{slug}/activity` | Claims, active members, recent announcements |
| `GET /activity` | Same, for whichever org the presented key belongs to |
| `GET /announcements?limit=N` | Recent announcements only |

### Member key only

| Endpoint | Purpose |
|---|---|
| `POST /sessions` | Register a session → `{session_id, ...}` |
| `POST /sessions/{id}/heartbeat` | Keep a session (and its claims) alive |
| `DELETE /sessions/{id}` | End a session and release all its claims |
| `POST /locks` | Claim a file → `{status: "clear" \| "blocked", conflicts: [...]}` |
| `POST /locks/release` | Release one of your claims |
| `POST /announcements` | Broadcast a message (≤ 280 chars) |

A key only ever sees its own org, and a session can only be driven by the member who
owns it - someone else's `session_id` comes back as `404`.

### Claim semantics

`POST /locks` is **advisory**. It always records your intent and then tells you who else
is there:

- `status: "clear"` - nobody else holds the file.
- `status: "blocked"` - a *different member* holds it and at least one side is
  `editing`; `conflicts` names them. Your claim is still recorded, so the other person
  sees you too.
- Two `reading` claims never conflict.
- Re-claiming a file you already hold refreshes it rather than duplicating it.

Claims expire `JUPITER_LOCK_TTL` seconds (default 300) after their last refresh, and are
released outright when their session ends.

## Worked example: two developers

```bash
# once, by whoever sets things up
curl -X POST http://dev-box:7420/orgs -H 'Content-Type: application/json' \
  -d '{"name": "My Team"}'

# Alice
A=$(curl -sX POST http://dev-box:7420/orgs/my-team/join \
  -H 'Content-Type: application/json' -d '{"display_name":"Alice"}' \
  | python -c 'import json,sys; print(json.load(sys.stdin)["api_key"])')

# Bob
B=$(curl -sX POST http://dev-box:7420/orgs/my-team/join \
  -H 'Content-Type: application/json' -d '{"display_name":"Bob"}' \
  | python -c 'import json,sys; print(json.load(sys.stdin)["api_key"])')

# each registers a session
SA=$(curl -sX POST http://dev-box:7420/sessions -H "Authorization: Bearer $A" \
  -H 'Content-Type: application/json' -d '{"working_dir":"/work/api"}' \
  | python -c 'import json,sys; print(json.load(sys.stdin)["session_id"])')
SB=$(curl -sX POST http://dev-box:7420/sessions -H "Authorization: Bearer $B" \
  -H 'Content-Type: application/json' -d '{"working_dir":"/work/api"}' \
  | python -c 'import json,sys; print(json.load(sys.stdin)["session_id"])')

# Alice claims a file - clear
curl -sX POST http://dev-box:7420/locks -H "Authorization: Bearer $A" \
  -H 'Content-Type: application/json' \
  -d "{\"session_id\":$SA,\"file_path\":\"src/app.py\",\"intent\":\"editing\"}"

# Bob claims the same file - blocked, and told who has it
curl -sX POST http://dev-box:7420/locks -H "Authorization: Bearer $B" \
  -H 'Content-Type: application/json' \
  -d "{\"session_id\":$SB,\"file_path\":\"src/app.py\"}"
```

In day-to-day use nobody types any of this: Claude Code's `jupiter_*` tools do it.

## Multiple orgs on one server

A single server happily hosts several orgs - separate teams, or a `-staging` org for
trying things out. Keys are scoped to their org, so there is no cross-talk. Point
`JUPITER_API_KEY` at whichever org you want a given Claude Code session to report into.
