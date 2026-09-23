# Adding Jupiter to Claude Code

Each developer runs their own Jupiter MCP server locally over **stdio**. Claude Code
launches it; it talks to the team's shared REST server using your member API key.

Before you start you need two things (see [`organizations.md`](organizations.md)):

- `JUPITER_SERVER` - the URL of the team's Jupiter server, e.g. `http://dev-box:7420`
- `JUPITER_API_KEY` - your member key, e.g. `jpm_3_9tK...`

## Option A: the `claude mcp add` CLI (recommended)

```bash
claude mcp add jupiter --scope user \
  --env JUPITER_SERVER=http://dev-box:7420 \
  --env JUPITER_API_KEY=jpm_3_9tK... \
  -- python -m jupiter_code.mcp_server
```

- `--scope user` makes it available in every project on your machine.
- `--scope project` writes a shared `.mcp.json` into the repo instead - convenient, but
  **do not** commit your API key that way (see "Keeping your key out of git" below).

Verify:

```bash
claude mcp list
claude mcp get jupiter
```

## Option B: edit the config file directly

For a single repo, create `.mcp.json` at the project root:

```json
{
  "mcpServers": {
    "jupiter": {
      "command": "python",
      "args": ["-m", "jupiter_code.mcp_server"],
      "env": {
        "JUPITER_SERVER": "http://dev-box:7420",
        "JUPITER_API_KEY": "jpm_3_9tK..."
      }
    }
  }
}
```

User-scope servers live in `~/.claude.json`, which the `claude mcp` commands manage for
you - prefer Option A for that scope rather than hand-editing.

On Windows, use the full interpreter path if `python` is not on `PATH`:

```json
"command": "C:\\Users\\you\\AppData\\Local\\Programs\\Python\\Python312\\python.exe"
```

If you installed into a virtualenv, point `command` at that venv's `python` (or at the
installed `jupiter-mcp` executable, which takes no arguments).

Restart Claude Code after changing the config. Run `/mcp` inside Claude Code to confirm
`jupiter` is connected and to see its five tools.

## Environment variables

| Variable | Required | Default | Meaning |
|---|---|---|---|
| `JUPITER_API_KEY` | yes | - | Your member key (`jpm_<id>_<secret>`) |
| `JUPITER_SERVER` | no | `http://127.0.0.1:7420` | Base URL of the team's Jupiter server |
| `JUPITER_WORKING_DIR` | no | the process CWD | What to report as this session's working directory |

If `JUPITER_API_KEY` is missing the server exits immediately with instructions - Claude
Code will show `jupiter` as failed in `/mcp`.

## Keeping your key out of git

A project-scoped `.mcp.json` is meant to be committed, and your member key is personal.
Two safe patterns:

1. **User scope** (Option A with `--scope user`) - the key stays in `~/.claude.json`,
   which is never committed. Recommended.
2. **Expansion from your environment** - Claude Code expands `${VAR}` in `.mcp.json`, so
   commit this and let each teammate export their own key:

   ```json
   {
     "mcpServers": {
       "jupiter": {
         "command": "python",
         "args": ["-m", "jupiter_code.mcp_server"],
         "env": {
           "JUPITER_SERVER": "${JUPITER_SERVER:-http://dev-box:7420}",
           "JUPITER_API_KEY": "${JUPITER_API_KEY}"
         }
       }
     }
   }
   ```

Add `.mcp.json` to `.gitignore` if you would rather keep it entirely local.

## Teaching Claude to actually use it

The MCP server ships `instructions` that Claude sees on connect, but the habit sticks
much better if you also put it in your project's `CLAUDE.md`:

```markdown
## Team coordination (jupiter)

- At the start of a session, call `jupiter_checkin`.
- Before editing any file, call `jupiter_lock_file` with the repo-relative path.
  If the result says `⚠ blocked by <teammate>`, do not edit it - tell me and
  suggest something else to work on.
- After finishing a file, call `jupiter_unlock_file`.
- Before starting a new area of work, call `jupiter_who_is_working`.
```

Use repo-relative paths (`src/payments.py`), not absolute ones - that is what makes two
teammates' claims line up on the same file.

## Verifying it end to end

1. `curl $JUPITER_SERVER/healthz` → `{"status":"ok",...}`
2. In Claude Code: `/mcp` → `jupiter` connected.
3. Ask: *"check in with Jupiter and tell me who's working on what"*.
4. Ask a teammate to lock a file, then ask Claude to lock the same one - you should see
   `⚠ blocked by <their name>`.

To debug outside Claude Code, run the MCP server by hand; it will wait on stdin for
JSON-RPC and log HTTP errors to stderr:

```bash
JUPITER_SERVER=http://dev-box:7420 JUPITER_API_KEY=jpm_3_... python -m jupiter_code.mcp_server
```

## Lifecycle notes

- The MCP server registers a session lazily: `jupiter_checkin` creates it, and any other
  tool creates one on demand if you skipped check-in.
- When Claude Code shuts the server down, it deregisters the session and releases every
  claim it held.
- If a session goes stale (server restarted, laptop slept), the next tool call
  transparently checks in again instead of failing.
