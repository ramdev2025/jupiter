# The web dashboard

The server ships a browser dashboard for the same data the MCP tools return. It is the
human-readable half of Jupiter: a guided setup flow, then a live view of who is
holding which file, plus the controls to claim a file, release it, and announce
something - useful when you are editing outside Claude Code and still want teammates
to see you.

Start the server and open it:

```bash
jupiter-server --port 7420
```

```
http://127.0.0.1:7420/          # redirects to /ui/
```

There is no build step and no second process: plain HTML, CSS and ES modules served by
the same FastAPI app as the REST API. Because it is **same-origin**, no CORS allowance
is added and the server's exposure is unchanged.

## Setup flow

On first visit the dashboard walks you through getting connected, rather than asking
for a key you do not have yet.

| Step | |
|---|---|
| **Welcome** | What Jupiter does |
| **Create or join** | One person creates the team; everyone else joins it |
| **Create a team** | Names the org and mints the admin key *(create path only)* |
| **Join** | Your display name; mints **your** member key |
| **Your keys** | Shown with copy buttons, and already saved in this browser |
| **Connect Claude Code** | A ready-to-paste `claude mcp add …` with the server URL and key filled in - and it waits for Claude's first check-in, confirming the wiring end to end |

Already have a key? **I already have a key** on the welcome screen skips straight to it.

Minted keys are saved the moment they exist, because the server only keeps a bcrypt
hash - a lost key is unrecoverable. That means a mid-wizard reload cannot lose one, and
**Settings** can show it again later.

## Pages

Each page has its own URL, so they can be bookmarked and shared.

| Route | |
|---|---|
| `#/overview` | Summary tiles, a conflict callout, your claims, and previews of the claims table and announcements |
| `#/files` | The full claims table with filtering, plus the claim form - the working page |
| `#/team` | Every member, who is online, and the files each one holds |
| `#/activity` | The announcement feed and its composer |
| `#/settings` | Your key, preferences, the MCP command, and disconnect |

Routing is hash-based, so deep links work without the server needing a catch-all route -
the fragment never reaches it.

## Connecting

The dashboard needs an API key, the same one the MCP server uses.

| Key | What the dashboard can do |
|---|---|
| member (`jpm_…`) | Everything: view activity, claim and release files, announce |
| org admin (`jpa_…`) | Read-only: activity and the member list; write controls are disabled |

Keys are kept in that browser's `localStorage` and sent only to the server that served
the page. **Settings → Disconnect** forgets them. Treat the browser profile as you would
a shell with `JUPITER_API_KEY` exported - see
[Security scope](../README.md#security-scope).

## What it shows

- **Files claimed now** - the headline count, with a short trend of recent refreshes.
- **Conflicts** - files where two different members overlap and at least one is editing.
  Same rule the server applies: two readers of one file never conflict, and your own
  editor plus your own agent do not conflict with each other.
- **Active claims** - path, holder, intent, note, and a countdown to expiry. Contested
  rows sort to the top with a `⚠ conflict` badge; your own rows are marked `you`.
- **Team** - members, presence, and the files each holds as chips.
- **Announcements** - the last hour of team broadcasts.
- **Possible overlaps** - *different* files whose work probably collides anyway, when
  semantic detection is configured. Advisory, visually distinct from real conflicts, and
  absent entirely when no gateway is set up. See
  [`semantic-conflicts.md`](semantic-conflicts.md).

It polls `/activity` every 3 seconds. A refresh patches table rows in place rather than
redrawing, so nothing flickers or jumps; if the server becomes unreachable the last
good view is held at reduced opacity and the status chip reads `disconnected` instead
of blanking. **Pause** stops polling. The tab title carries a `(n)` conflict count so
it is legible from another window.

The member list is refreshed every fourth poll rather than every one, because each
authenticated request costs a bcrypt verification server-side (~0.5s); live presence
comes from `/activity` in the meantime. Opening **Team** always pulls a fresh list.

## Claiming a file from the browser

`Claim a file` on the **Files** page posts the same advisory claim `jupiter_lock_file`
does, so your teammates' agents see it. Use repo-relative paths (`src/app.py`) matching
what everyone else uses - comparison is case-sensitive after separators are normalised
to `/`.

Two details worth knowing:

- **The dashboard does not register a session until you use it.** Opening the page makes
  you an observer; you appear online only once you claim a file. That keeps a dashboard
  left open on a second monitor from showing you as present indefinitely.
- **Auto-renew** (on by default) re-posts your claims before the TTL runs out. A session
  heartbeat alone does *not* extend a claim - only re-claiming the path refreshes it - so
  without this your browser claims would lapse after one TTL. Turn it off and they expire
  naturally. Closing the tab ends the session and releases them.

`Release` appears only on claims held by **this browser session**. A claim made by your
Claude Code session is not the dashboard's to drop - the server scopes a release to the
caller's own session - so use `jupiter_unlock_file` there, or let it expire.

**Notify on conflict** (Settings) asks for browser notification permission and raises a
desktop notification when someone newly collides with a file you hold. Conflicts already
present when you open the page are adopted as a baseline instead of firing a burst of
notifications.

## Appearance

Dark by default; **Theme** toggles light and the choice is remembered. Both modes are
separately chosen rather than one inverted, and the colours are validated for
colour-vision deficiency: every state carries an icon **and** a text label, and the
claims view is a real table, so no status is conveyed by colour alone. Countdown meters
encode time remaining only - conflict lives in the badge - so the two channels never
confuse each other. Motion respects `prefers-reduced-motion`, and the sidebar collapses
to a drawer on narrow screens.

## Source layout

```
jupiter_code/web/
  index.html            both shells (wizard, app) and their mount points
  css/tokens.css        the validated palette; light and dark
  css/base.css          reset, typography, form controls
  css/shell.css         topbar, sidebar, wizard frame, stepper
  css/components.css    cards, tiles, table, badges, meters, toasts
  js/main.js            route table, chrome, bootstrap
  js/router.js          hash router with per-route shell and teardown
  js/store.js           shared state, polling, sessions, write actions
  js/api.js             REST client, key parsing, the MCP command
  js/overlaps.js        the "possible overlaps" card
  js/setup.js           the wizard steps
  js/claims-table.js    the claims table, with keyed row reconciliation
  js/viz.js             sparkline and expiry meter
  js/dom.js  js/format.js  js/ui.js      helpers, time formatting, toasts
  js/pages/*.js         one module per dashboard page
```

Teammate-supplied strings (paths, notes, names, messages) only ever reach the DOM
through `textContent`; the `frag()` helper is for static markup written in this
codebase and never receives interpolated data.
