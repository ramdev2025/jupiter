/* The onboarding wizard: welcome -> create/join -> your key -> Claude Code.
 *
 * Minted keys are persisted the moment they exist (the server only keeps a
 * hash, so a lost key is unrecoverable). That means a mid-wizard reload never
 * loses one, and Settings can show it again later.
 */

import { $, el, clear, frag, show, wireCopyButtons } from "./dom.js";
import { api, mcpCommand } from "./api.js";
import { go, path } from "./router.js";
import { toast } from "./ui.js";
import * as store from "./store.js";

const ADMIN_LS = "jupiter.adminkey";

/* Ephemeral wizard context, plus the bits worth surviving a reload. */
const wiz = { flow: null, slug: null, memberKey: null, adminKey: null, displayName: null };

const FLOWS = {
  create: [
    { route: "/setup/create", label: "Team" },
    { route: "/setup/join", label: "You" },
    { route: "/setup/key", label: "Your key" },
    { route: "/setup/connect", label: "Claude Code" },
  ],
  join: [
    { route: "/setup/join", label: "Team" },
    { route: "/setup/key", label: "Your key" },
    { route: "/setup/connect", label: "Claude Code" },
  ],
};

/** Draw the progress rail for the current step, or hide it. */
export function paintStepper() {
  const rail = $("stepper");
  const here = path().split("?")[0];
  const steps = FLOWS[wiz.flow];
  if (!steps || (!steps.some((s) => s.route === here) && here !== "/setup/done")) {
    show(rail, false);
    return;
  }
  show(rail, true);
  clear(rail);
  const at = here === "/setup/done" ? steps.length : steps.findIndex((s) => s.route === here);
  steps.forEach((step, i) => {
    const done = i < at, cur = i === at;
    rail.append(el("li", { attrs: { "data-state": done ? "done" : cur ? "current" : "todo" } }, [
      el("span", { class: "num", html: done ? '<svg class="ico" aria-hidden="true"><use href="#ico-check"/></svg>' : String(i + 1) }),
      el("span", { class: "step-label", text: step.label }),
    ]));
  });
}

function panel(markup) {
  return frag(markup).firstElementChild;
}

function setError(node, message) {
  const box = node.querySelector("[data-err]");
  if (!box) return;
  box.textContent = message || "";
  show(box, Boolean(message));
}

const ERR_BOX = `<p class="callout" data-err hidden style="border-left-color: var(--critical)"></p>`;

/* ===================================================================== */
/* /welcome                                                              */
/* ===================================================================== */

export function welcome(host) {
  wiz.flow = null;
  const node = panel(`
    <div class="panel">
      <div class="hero">
        <h1>See what your team is<br>touching, right now</h1>
        <p class="tagline">Jupiter lets each developer's Claude Code instance see which
          files their teammates' instances are editing - so two agents don't quietly
          rewrite the same file at the same time.</p>
      </div>
      <ul class="feature-list">
        <li>
          <span class="fico" aria-hidden="true"><svg class="ico" aria-hidden="true"><use href="#ico-file-text"/></svg></span>
          <span><strong>Advisory file claims</strong>
          <span class="fdesc">Claude declares intent before editing and is told who else is
            there. Nothing is ever blocked - claims expire on their own.</span></span>
        </li>
        <li>
          <span class="fico" aria-hidden="true"><svg class="ico" aria-hidden="true"><use href="#ico-team"/></svg></span>
          <span><strong>Live team presence</strong>
          <span class="fdesc">Who is online, which files they hold, and how long the claim
            has left before it lapses.</span></span>
        </li>
        <li>
          <span class="fico" aria-hidden="true"><svg class="ico" aria-hidden="true"><use href="#ico-alert-triangle"/></svg></span>
          <span><strong>Conflict warnings</strong>
          <span class="fdesc">Two readers never collide. The moment someone starts editing a
            file you hold, you hear about it.</span></span>
        </li>
      </ul>
      <div class="panel-foot">
        <button class="primary big" data-act="start">Get started</button>
        <button class="ghost big" data-act="signin">I already have a key</button>
      </div>
    </div>`);

  node.querySelector("[data-act=start]").onclick = () => go("/setup/choose");
  node.querySelector("[data-act=signin]").onclick = () => go("/setup/signin");
  host.append(node);
}

/* ===================================================================== */
/* /setup/choose                                                         */
/* ===================================================================== */

export function choose(host) {
  wiz.flow = null;
  const node = panel(`
    <div class="panel">
      <div class="panel-head">
        <h2>Are you starting or joining?</h2>
        <p>One person hosts the server and creates the team. Everyone else joins it.</p>
      </div>
      <div class="choice-grid">
        <button class="choice" data-act="create">
          <span class="cico" aria-hidden="true"><svg class="ico" aria-hidden="true"><use href="#ico-plus-circle"/></svg></span>
          <strong>Create a new team</strong>
          <span class="cdesc">You are setting Jupiter up for the first time. You will get
            an org admin key, then add yourself as the first member.</span>
        </button>
        <button class="choice" data-act="join">
          <span class="cico" aria-hidden="true"><svg class="ico" aria-hidden="true"><use href="#ico-arrow-right"/></svg></span>
          <strong>Join an existing team</strong>
          <span class="cdesc">A teammate already runs this server and gave you the team
            slug. You will get your own member key.</span>
        </button>
      </div>
      <div class="panel-foot">
        <button class="ghost" data-act="back">Back</button>
        <span class="spacer"></span>
        <button class="subtle" data-act="signin">I already have a key</button>
      </div>
    </div>`);

  node.querySelector("[data-act=create]").onclick = () => { wiz.flow = "create"; go("/setup/create"); };
  node.querySelector("[data-act=join]").onclick = () => { wiz.flow = "join"; go("/setup/join"); };
  node.querySelector("[data-act=back]").onclick = () => go("/welcome");
  node.querySelector("[data-act=signin]").onclick = () => go("/setup/signin");
  host.append(node);
}

/* ===================================================================== */
/* /setup/create - mint the org                                          */
/* ===================================================================== */

export function create(host) {
  wiz.flow = "create";
  const node = panel(`
    <div class="panel">
      <div class="panel-head">
        <h2>Name your team</h2>
        <p>This creates the organisation on this server and returns an admin key.</p>
      </div>
      <form class="form-grid">
        <div class="field">
          <label for="w-name">Team name</label>
          <input id="w-name" type="text" placeholder="My Team" required autocomplete="off">
        </div>
        <div class="field">
          <label for="w-slug">Slug <span class="muted">(optional)</span></label>
          <input id="w-slug" type="text" placeholder="derived from the name"
                 autocomplete="off" spellcheck="false">
          <p class="hint">Teammates use this to join. Lower-case letters, numbers and dashes.</p>
        </div>
        ${ERR_BOX}
        <div class="panel-foot">
          <button class="ghost" type="button" data-act="back">Back</button>
          <span class="spacer"></span>
          <button class="primary" type="submit">Create team</button>
        </div>
      </form>
    </div>`);

  node.querySelector("[data-act=back]").onclick = () => go("/setup/choose");
  node.querySelector("form").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    setError(node, "");
    const btn = node.querySelector("button[type=submit]");
    btn.disabled = true;
    try {
      const created = await api("POST", "/orgs", {
        name: node.querySelector("#w-name").value.trim(),
        slug: node.querySelector("#w-slug").value.trim() || null,
      }, null);
      wiz.slug = created.slug;
      wiz.adminKey = created.admin_api_key;
      localStorage.setItem(ADMIN_LS, created.admin_api_key);
      go("/setup/join");
    } catch (err) {
      setError(node, err.message);
    } finally {
      btn.disabled = false;
    }
  });
  host.append(node);
}

/* ===================================================================== */
/* /setup/join - mint the member                                         */
/* ===================================================================== */

export function join(host) {
  if (!wiz.flow) wiz.flow = "join";
  const creating = wiz.flow === "create";
  const node = panel(`
    <div class="panel">
      <div class="panel-head">
        <h2>${creating ? "Add yourself as the first member" : "Join the team"}</h2>
        <p>Your display name is what teammates see beside every file you claim.</p>
      </div>
      <form class="form-grid">
        <div class="field">
          <label for="w-jslug">Team slug</label>
          <input id="w-jslug" type="text" placeholder="my-team" required
                 autocomplete="off" spellcheck="false">
        </div>
        <div class="field">
          <label for="w-jname">Your display name</label>
          <input id="w-jname" type="text" placeholder="Alice" required autocomplete="off">
        </div>
        <div class="field">
          <label for="w-jdir">Working directory <span class="muted">(optional)</span></label>
          <input id="w-jdir" type="text" placeholder="C:\\path\\to\\your\\repo"
                 autocomplete="off" spellcheck="false">
          <p class="hint">Shown to teammates beside files you claim from this dashboard.</p>
        </div>
        ${ERR_BOX}
        <div class="panel-foot">
          <button class="ghost" type="button" data-act="back">Back</button>
          <span class="spacer"></span>
          <button class="primary" type="submit">Join team</button>
        </div>
      </form>
    </div>`);

  const slugInput = node.querySelector("#w-jslug");
  if (wiz.slug) { slugInput.value = wiz.slug; slugInput.readOnly = creating; }
  node.querySelector("#w-jdir").value = store.state.workingDir || "";

  node.querySelector("[data-act=back]").onclick = () =>
    go(creating ? "/setup/create" : "/setup/choose");

  node.querySelector("form").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    setError(node, "");
    const btn = node.querySelector("button[type=submit]");
    btn.disabled = true;
    const slug = slugInput.value.trim();
    try {
      const created = await api("POST", `/orgs/${encodeURIComponent(slug)}/join`, {
        display_name: node.querySelector("#w-jname").value.trim(),
      }, null);
      wiz.slug = created.slug;
      wiz.memberKey = created.api_key;
      wiz.displayName = created.display_name;
      // Connect straight away: this persists the key, so a reload can't lose it.
      await store.connect(created.api_key, node.querySelector("#w-jdir").value.trim());
      go("/setup/key");
    } catch (err) {
      setError(node, err.message);
      btn.disabled = false;
    }
  });
  host.append(node);
}

/* ===================================================================== */
/* /setup/key - show what was minted                                     */
/* ===================================================================== */

export function keys(host) {
  const memberKey = wiz.memberKey || store.state.key || "";
  const adminKey = wiz.adminKey || localStorage.getItem(ADMIN_LS);
  const node = panel(`
    <div class="panel">
      <div class="panel-head">
        <h2>Your keys</h2>
        <p>Saved in this browser already. Copy them somewhere safe - the server stores
          only a hash, so they cannot be shown again from scratch.</p>
      </div>
      <div class="form-grid">
        <div>
          <h3>Your member key</h3>
          <p class="hint" data-who></p>
          <div class="copyrow" style="margin-top:8px">
            <code class="keyblob" id="k-member"></code>
            <button class="ghost" type="button" data-copy="k-member">Copy</button>
          </div>
        </div>
        <div data-admin-wrap hidden>
          <h3>Org admin key</h3>
          <p class="hint">Lists members and reads activity, but cannot claim files.
            Keep it with whoever administers the team.</p>
          <div class="copyrow" style="margin-top:8px">
            <code class="keyblob" id="k-admin"></code>
            <button class="ghost" type="button" data-copy="k-admin">Copy</button>
          </div>
        </div>
        <p class="callout"><strong>Treat a member key like a password.</strong>
          It lets its holder read the team's activity and post claims on your name.</p>
        <div class="panel-foot">
          <span class="spacer"></span>
          <button class="primary" type="button" data-act="next">Next: connect Claude Code</button>
        </div>
      </div>
    </div>`);

  node.querySelector("#k-member").textContent = memberKey;
  node.querySelector("[data-who]").textContent = wiz.displayName
    ? `${wiz.displayName} in ${wiz.slug || store.state.slug}`
    : `in ${store.state.slug || "this team"}`;

  if (adminKey) {
    show(node.querySelector("[data-admin-wrap]"), true);
    node.querySelector("#k-admin").textContent = adminKey;
  }

  wireCopyButtons(node, () => toast("warning", "Could not reach the clipboard - select the text and copy it."));
  node.querySelector("[data-act=next]").onclick = () => go("/setup/connect");
  host.append(node);
}

/* ===================================================================== */
/* /setup/connect - the MCP command, and wait for the first check-in     */
/* ===================================================================== */

export function connectClaude(host) {
  const node = panel(`
    <div class="panel">
      <div class="panel-head">
        <h2>Connect Claude Code</h2>
        <p>Run this once in a terminal. It registers the Jupiter MCP server for your
          user, pointed at this server with your key.</p>
      </div>
      <div class="form-grid">
        <div class="copyrow">
          <code class="keyblob cmd" id="k-mcp"></code>
          <button class="ghost" type="button" data-copy="k-mcp">Copy</button>
        </div>
        <p class="hint">Then restart Claude Code and ask it to <em>"check in with
          Jupiter"</em>. Claude gets five tools: check in, claim a file, release it,
          see who is working, and announce.</p>

        <div class="card" style="margin:0">
          <div class="card-body">
            <div class="waiting" data-waiting>
              <span class="spinner" aria-hidden="true"></span>
              <span>Waiting for your first check-in…</span>
            </div>
            <div class="waiting" data-found hidden>
              <svg class="ico" aria-hidden="true" style="width:1.5em;height:1.5em;color:var(--good)"><use href="#ico-check-circle"/></svg>
              <span><strong>Claude Code checked in.</strong> You are all set.</span>
            </div>
          </div>
        </div>

        <div class="panel-foot">
          <button class="ghost" type="button" data-act="back">Back</button>
          <span class="spacer"></span>
          <button class="primary" type="button" data-act="next">Open dashboard</button>
        </div>
      </div>
    </div>`);

  node.querySelector("#k-mcp").textContent = mcpCommand(store.state.key);
  wireCopyButtons(node, () => toast("warning", "Could not reach the clipboard - select the text and copy it."));
  node.querySelector("[data-act=back]").onclick = () => go("/setup/key");
  node.querySelector("[data-act=next]").onclick = () => go("/setup/done");

  // The dashboard has not opened a session of its own yet, so any live session
  // on our member record must be Claude Code reporting in.
  let timer = null;
  const probe = async () => {
    if (store.state.memberId == null || !store.state.slug) return;
    try {
      const members = await api("GET", `/orgs/${encodeURIComponent(store.state.slug)}/members`);
      const me = members.find((m) => m.member_id === store.state.memberId);
      if (me && me.active_sessions > 0) {
        show(node.querySelector("[data-waiting]"), false);
        show(node.querySelector("[data-found]"), true);
        clearInterval(timer);
        timer = null;
      }
    } catch (_) { /* keep waiting */ }
  };
  timer = setInterval(probe, 3000);
  probe();

  host.append(node);
  return () => { if (timer) clearInterval(timer); };
}

/* ===================================================================== */
/* /setup/done                                                           */
/* ===================================================================== */

export function done(host) {
  const node = panel(`
    <div class="panel">
      <div class="hero">
        <div style="font-size:34px;color:var(--good);line-height:1" aria-hidden="true"><svg class="ico" aria-hidden="true"><use href="#ico-check-circle"/></svg></div>
        <h1 style="margin-top:12px">You're set up</h1>
        <p class="tagline" data-sub></p>
      </div>
      <div class="panel-foot">
        <span class="spacer"></span>
        <button class="primary big" data-act="go">Open the dashboard</button>
        <span class="spacer"></span>
      </div>
      <p class="hint" style="text-align:center">
        Share the team slug <code data-slug></code> with your teammates so they can join.
      </p>
    </div>`);

  node.querySelector("[data-sub]").textContent =
    `You are a member of ${store.state.slug}. Claims your teammates make will show up ` +
    `on the dashboard within a few seconds.`;
  node.querySelector("[data-slug]").textContent = store.state.slug || "";
  node.querySelector("[data-act=go]").onclick = () => go("/overview");
  host.append(node);
}

/* ===================================================================== */
/* /setup/signin - connect with an existing key                          */
/* ===================================================================== */

export function signin(host) {
  wiz.flow = null;
  const node = panel(`
    <div class="panel">
      <div class="panel-head">
        <h2>Connect with your key</h2>
        <p>Paste the member key you were given, or an org admin key for a read-only view.</p>
      </div>
      <form class="form-grid">
        <div class="field">
          <label for="w-key">API key</label>
          <input id="w-key" type="password" required autocomplete="off" spellcheck="false"
                 placeholder="jpm_1_xxxxxxxxxxxxxxxx">
          <p class="hint">A member key (<code>jpm_…</code>) unlocks the full dashboard.
            An org admin key (<code>jpa_…</code>) is read-only.</p>
        </div>
        <div class="field">
          <label for="w-dir">Working directory <span class="muted">(optional)</span></label>
          <input id="w-dir" type="text" placeholder="C:\\path\\to\\your\\repo"
                 autocomplete="off" spellcheck="false">
        </div>
        ${ERR_BOX}
        <div class="panel-foot">
          <button class="ghost" type="button" data-act="back">Back</button>
          <span class="spacer"></span>
          <button class="primary" type="submit">Connect</button>
        </div>
      </form>
    </div>`);

  node.querySelector("#w-dir").value = store.state.workingDir || "";
  node.querySelector("[data-act=back]").onclick = () => go("/welcome");
  node.querySelector("form").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    setError(node, "");
    const btn = node.querySelector("button[type=submit]");
    btn.disabled = true;
    try {
      await store.connect(node.querySelector("#w-key").value,
                          node.querySelector("#w-dir").value.trim());
      go("/overview");
    } catch (err) {
      setError(node, err.status === 401 ? "That key was rejected by the server." : err.message);
      btn.disabled = false;
    }
  });
  host.append(node);
}

/** Used by Settings to offer "invite a teammate". */
export function beginJoinFlow(slug) {
  wiz.flow = "join";
  wiz.slug = slug || null;
  wiz.memberKey = null;
  wiz.displayName = null;
}
