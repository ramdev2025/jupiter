/* Settings: identity, keys, preferences, the MCP command, and disconnect. */

import { frag, show, wireCopyButtons } from "../dom.js";
import { fmtTtl, fmtAgo, parseTs } from "../format.js";
import { mcpCommand } from "../api.js";
import { toast, requestNotifyPermission, currentTheme, toggleTheme } from "../ui.js";
import { go } from "../router.js";
import { beginJoinFlow } from "../setup.js";
import * as store from "../store.js";

const MARKUP = `
<div>
  <div class="page-head">
    <div>
      <h1>Settings</h1>
      <p>This browser's connection, and how the dashboard behaves.</p>
    </div>
  </div>

  <div class="split">
    <div class="col">
      <section class="card">
        <div class="card-head"><h2>Connection</h2></div>
        <div class="card-body">
          <dl class="kv">
            <dt>Team</dt><dd data-slug></dd>
            <dt>Signed in as</dt><dd data-me></dd>
            <dt>Key type</dt><dd data-kind></dd>
            <dt>Server</dt><dd data-origin class="mono"></dd>
            <dt>Claim lifetime</dt><dd data-ttl></dd>
            <dt>Dashboard session</dt><dd data-session></dd>
          </dl>
        </div>
      </section>

      <section class="card">
        <div class="card-head"><h2>Your API key</h2></div>
        <div class="card-body stack" style="gap:12px">
          <div class="copyrow">
            <code class="keyblob" data-key></code>
            <button class="ghost" type="button" data-act="reveal">Reveal</button>
          </div>
          <p class="hint">Stored in this browser's local storage and sent only to this
            server. Anyone holding it can read team activity and post claims as you.</p>
        </div>
      </section>

      <section class="card">
        <div class="card-head"><h2>Semantic conflict detection</h2></div>
        <div class="card-body stack" style="gap:12px">
          <dl class="kv">
            <dt>Status</dt><dd data-ai-status></dd>
            <dt>Model</dt><dd data-ai-model class="mono"></dd>
            <dt>Gateway</dt><dd data-ai-base class="mono"></dd>
            <dt>Last analysis</dt><dd data-ai-when></dd>
          </dl>
          <p class="hint">Flags <em>different</em> files whose work likely collides -
            an implementation and its test, a model and its migration. Same-file
            conflicts are detected without AI and are unaffected by this.</p>
          <p class="hint">Only file paths, intents, holder names and notes are sent to
            the gateway. File contents never leave your network.</p>
          <p class="callout" data-ai-error hidden></p>
        </div>
      </section>

      <section class="card">
        <div class="card-head"><h2>Claude Code</h2></div>
        <div class="card-body stack" style="gap:12px">
          <p class="hint">Register the MCP server for your user, pointed at this server
            with your key:</p>
          <div class="copyrow">
            <code class="keyblob cmd" id="s-mcp"></code>
            <button class="ghost" type="button" data-copy="s-mcp">Copy</button>
          </div>
        </div>
      </section>
    </div>

    <div class="col">
      <section class="card">
        <div class="card-head"><h2>Preferences</h2></div>
        <div class="card-body settings-group">
          <label class="switch">
            <input type="checkbox" data-autorenew>
            <span class="sw-text">
              <strong>Auto-renew my claims</strong>
              <span class="hint">Re-post claims made here before they expire. A session
                heartbeat alone does not extend a claim.</span>
            </span>
          </label>

          <label class="switch">
            <input type="checkbox" data-notify>
            <span class="sw-text">
              <strong>Desktop notification on conflict</strong>
              <span class="hint">Raise a system notification when someone newly collides
                with a file you hold.</span>
            </span>
          </label>

          <div class="field">
            <label for="s-dir">Working directory</label>
            <input id="s-dir" type="text" placeholder="C:\\path\\to\\your\\repo"
                   autocomplete="off" spellcheck="false">
            <p class="hint">Shown to teammates beside files you claim from this dashboard.</p>
          </div>

          <div class="btn-row">
            <button class="subtle" type="button" data-act="savedir">Save directory</button>
          </div>

          <div class="btn-row" style="border-top:1px solid var(--grid); padding-top:16px">
            <span class="hint" style="flex:1 1 auto">Appearance is currently
              <strong data-theme></strong>.</span>
            <button class="subtle" type="button" data-act="theme">Switch</button>
          </div>
        </div>
      </section>

      <section class="card">
        <div class="card-head"><h2>Team</h2></div>
        <div class="card-body stack" style="gap:12px">
          <p class="hint">Adding a teammate mints them their own member key. Share the
            team slug and let them run through setup themselves, or do it for them here.</p>
          <div class="btn-row">
            <button class="subtle" type="button" data-act="invite">Add a teammate</button>
          </div>
        </div>
      </section>

      <section class="card">
        <div class="card-head"><h2>Danger zone</h2></div>
        <div class="card-body stack" style="gap:12px">
          <p class="hint">Disconnecting forgets the stored key in this browser, ends this
            dashboard session and releases any claims it holds. It does not remove you
            from the team.</p>
          <div class="btn-row">
            <button class="danger" type="button" data-act="disconnect">Disconnect</button>
          </div>
        </div>
      </section>
    </div>
  </div>
</div>`;

export function mount(host) {
  const node = frag(MARKUP).firstElementChild;
  const q = (sel) => node.querySelector(sel);

  const readOnly = store.isReadOnly();
  let revealed = false;

  q("[data-origin]").textContent = window.location.origin;
  q("#s-mcp").textContent = mcpCommand(store.state.key);
  q("#s-dir").value = store.state.workingDir || "";
  wireCopyButtons(node, () => toast("warning", "Could not reach the clipboard - select the text and copy it."));

  q("[data-act=reveal]").onclick = () => {
    revealed = !revealed;
    q("[data-act=reveal]").textContent = revealed ? "Hide" : "Reveal";
    paintKey();
  };

  function paintKey() {
    const key = store.state.key || "";
    q("[data-key]").textContent = revealed
      ? key
      : key.slice(0, 8) + "\u2026".repeat(3) + key.slice(-4);
  }

  const autoRenew = q("[data-autorenew]");
  autoRenew.checked = store.state.autoRenew;
  autoRenew.disabled = readOnly;
  autoRenew.addEventListener("change", (ev) => {
    store.setAutoRenew(ev.target.checked);
    toast("info", ev.target.checked ? "Auto-renew on." : "Auto-renew off - claims will lapse.");
  });

  const notifyBox = q("[data-notify]");
  notifyBox.checked = store.state.notifyConflicts;
  notifyBox.addEventListener("change", async (ev) => {
    if (!ev.target.checked) { store.setNotifyConflicts(false); return; }
    if (typeof Notification === "undefined") {
      ev.target.checked = false;
      toast("warning", "This browser does not support desktop notifications.");
      return;
    }
    const granted = await requestNotifyPermission();
    ev.target.checked = granted;
    store.setNotifyConflicts(granted);
    if (!granted) toast("warning", "Notification permission was declined.");
  });

  q("[data-act=savedir]").onclick = () => {
    store.setWorkingDir(q("#s-dir").value.trim());
    toast("good", "Working directory saved.");
  };

  q("[data-act=theme]").onclick = () => {
    toggleTheme();
    q("[data-theme]").textContent = currentTheme();
  };

  q("[data-act=invite]").onclick = () => {
    beginJoinFlow(store.state.slug);
    go("/setup/join");
  };

  q("[data-act=disconnect]").onclick = () => {
    store.disconnect();
    go("/welcome");
  };

  host.append(node);

  function update() {
    const s = store.state;
    q("[data-slug]").textContent = s.slug || "–";
    q("[data-me]").textContent = s.displayName || (readOnly ? "org admin" : `member #${s.memberId}`);
    q("[data-kind]").textContent = readOnly
      ? "org admin key (read-only)"
      : "member key (full access)";
    q("[data-ttl]").textContent = fmtTtl(s.ttl);
    q("[data-session]").textContent = s.sessionId == null
      ? "none - the dashboard registers one only when you claim a file"
      : `#${s.sessionId} \u00b7 ${store.releasableLocks().length} claim(s) held here`;
    q("[data-theme]").textContent = currentTheme();
    paintKey();

    const sem = s.semantic || {};
    const llm = sem.llm || {};
    const LABEL = {
      ready: "on", pending: "analysing…", error: "error",
      disabled: "off",
    };
    q("[data-ai-status]").textContent =
      `${LABEL[sem.status] || sem.status || "unknown"}` +
      (sem.status === "ready" ? ` · ${(sem.overlaps || []).length} overlap(s)` : "");
    q("[data-ai-model]").textContent = llm.model || sem.model || "–";
    q("[data-ai-base]").textContent = llm.base_url || "–";
    q("[data-ai-when]").textContent = sem.analyzed_at
      ? fmtAgo(parseTs(sem.analyzed_at))
      : "–";

    const err = sem.error || llm.reason;
    q("[data-ai-error]").textContent = err || "";
    show(q("[data-ai-error]"), Boolean(err));
  }

  const unsub = store.subscribe(update);
  update();

  return () => { unsub(); };
}
