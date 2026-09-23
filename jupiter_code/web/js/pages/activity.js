/* Activity: the announcement feed and its composer. */

import { el, frag, show, clear, initials } from "../dom.js";
import { fmtClock, fmtAgo, parseTs } from "../format.js";
import { toast } from "../ui.js";
import * as store from "../store.js";

const MARKUP = `
<div>
  <div class="page-head">
    <div>
      <h1>Activity</h1>
      <p>Team broadcasts from the last hour.</p>
    </div>
  </div>

  <div class="split">
    <div class="col">
      <section class="card">
        <div class="card-head">
          <h2>Announcements</h2>
          <span class="spacer"></span>
          <span class="count" data-count></span>
        </div>
        <form class="composer" data-form>
          <label class="sr-only" for="a-msg">Message</label>
          <textarea id="a-msg" rows="2" maxlength="280"
                    placeholder="Refactoring the auth module for the next hour…"></textarea>
          <div class="composer-foot">
            <span class="muted" data-len>0/280</span>
            <span class="spacer"></span>
            <button class="primary" type="submit">Announce</button>
          </div>
        </form>
        <ul class="feed" data-feed></ul>
        <p class="empty" data-empty hidden>
          <span class="eico" aria-hidden="true">&#9650;</span>
          Nothing announced in the last hour.
        </p>
      </section>
    </div>

    <div class="col">
      <section class="card">
        <div class="card-head"><h2>About announcements</h2></div>
        <div class="card-body stack" style="gap:12px">
          <p class="hint">Announcements are short status notes broadcast to the whole team -
            the human counterpart to a file claim. Claude posts them too, via
            <code>jupiter_announce</code>.</p>
          <p class="hint">The server keeps the last hour, up to 20 messages. They are not
            stored beyond that, so treat them as ambient context rather than a log.</p>
        </div>
      </section>

      <section class="card">
        <div class="card-head"><h2>Who is online</h2></div>
        <!-- data-online-list, not data-online: the feed's avatars carry a
             data-online attribute and would win the querySelector race. -->
        <ul class="team" data-online-list></ul>
        <p class="empty" data-online-empty hidden>
          <span class="eico" aria-hidden="true">&#9679;</span>
          Nobody has checked in.
        </p>
      </section>
    </div>
  </div>
</div>`;

export function mount(host) {
  const node = frag(MARKUP).firstElementChild;
  const q = (sel) => node.querySelector(sel);

  const box = q("#a-msg");
  const form = q("[data-form]");
  const readOnly = store.isReadOnly();
  if (readOnly) {
    box.disabled = true;
    box.placeholder = "An org admin key cannot announce - a member key is needed.";
    form.querySelector("button").disabled = true;
  }

  box.addEventListener("input", () => {
    q("[data-len]").textContent = `${box.value.length}/280`;
  });

  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const message = box.value.trim();
    if (!message) return;
    const btn = form.querySelector("button");
    btn.disabled = true;
    try {
      await store.sendAnnouncement(message);
      box.value = "";
      q("[data-len]").textContent = "0/280";
      toast("good", "Announced to the team.");
    } catch (err) {
      toast("critical", err.message);
    } finally {
      btn.disabled = readOnly;
    }
  });

  host.append(node);

  function update() {
    const s = store.state;

    const items = s.announcements.slice().reverse();
    q("[data-count]").textContent = items.length ? String(items.length) : "";
    show(q("[data-empty]"), items.length === 0);

    const feed = q("[data-feed]");
    clear(feed);
    for (const a of items) {
      feed.append(el("li", {}, [
        el("span", {
          class: "avatar", text: initials(a.member),
          attrs: { "data-online": "yes", "aria-hidden": "true" },
        }),
        el("div", { class: "feed-main" }, [
          el("div", { class: "feed-head" }, [
            el("span", { class: "feed-who", text: a.member }),
            el("span", { class: "feed-when", text: `${fmtClock(a.at)} · ${fmtAgo(parseTs(a.at))}` }),
          ]),
          el("div", { class: "feed-msg", text: a.message }),
        ]),
      ]));
    }

    const list = q("[data-online-list]");
    clear(list);
    show(q("[data-online-empty]"), s.activeMembers.length === 0);
    for (const name of s.activeMembers) {
      const held = s.locks.filter((l) => l.member === name).length;
      list.append(el("li", {}, [
        el("span", { class: "dot", attrs: { "data-online": "yes", "aria-hidden": "true" } }),
        el("div", { class: "team-main" }, [
          el("div", { class: "team-name", text: name }),
        ]),
        el("span", { class: "team-meta", text: held ? `${held} file${held === 1 ? "" : "s"}` : "idle" }),
      ]));
    }
  }

  const unsub = store.subscribe(update);
  update();

  return () => { unsub(); };
}
