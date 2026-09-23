/* Team: who is on the org, who is online, and what each of them holds. */

import { el, frag, show, clear, initials } from "../dom.js";
import { fmtAgo, fmtDate, parseTs, plural } from "../format.js";
import * as store from "../store.js";

const MARKUP = `
<div>
  <div class="page-head">
    <div>
      <h1>Team</h1>
      <p data-sub></p>
    </div>
    <span class="spacer"></span>
    <a class="ghost" href="#/settings" style="padding:8px 14px">Invite a teammate</a>
  </div>

  <section class="card">
    <div class="card-head">
      <h2>Members</h2>
      <span class="spacer"></span>
      <span class="count" data-count></span>
    </div>
    <ul class="team" data-list></ul>
    <p class="empty" data-empty hidden>
      <span class="eico" aria-hidden="true">&#9679;</span>
      <span data-empty-text>No members yet.</span>
    </p>
  </section>
</div>`;

export function mount(host) {
  const node = frag(MARKUP).firstElementChild;
  const q = (sel) => node.querySelector(sel);
  host.append(node);

  function update() {
    const s = store.state;
    const members = s.members || [];
    const online = members.filter((m) => m.active_sessions > 0).length;

    q("[data-sub]").textContent = members.length
      ? `${plural(members.length, "member")} · ${online} online`
      : "";
    q("[data-count]").textContent = members.length ? `${online} of ${members.length} online` : "";

    show(q("[data-empty]"), members.length === 0);
    if (!members.length) {
      q("[data-empty-text]").textContent = s.lastError
        ? "Could not load the member list."
        : "No members yet.";
    }

    const list = q("[data-list]");
    clear(list);

    // Online first, then alphabetical - presence is what the page is for.
    const sorted = members.slice().sort((a, b) => {
      const oa = a.active_sessions > 0 ? 0 : 1, ob = b.active_sessions > 0 ? 0 : 1;
      if (oa !== ob) return oa - ob;
      return a.display_name.localeCompare(b.display_name);
    });

    for (const m of sorted) {
      const isOnline = m.active_sessions > 0;
      const isMe = s.memberId != null && m.member_id === s.memberId;
      const held = store.locksForMember(m.member_id);

      const files = el("div", { class: "team-files" });
      for (const lock of held) {
        files.append(el("span", {
          class: "filechip",
          text: lock.file_path,
          attrs: {
            "data-contested": lock.conflicts.length ? "yes" : "no",
            title: `${lock.intent}${lock.note ? " · " + lock.note : ""}`,
          },
        }));
      }

      list.append(el("li", {}, [
        el("span", {
          class: "avatar",
          text: initials(m.display_name),
          attrs: { "data-online": isOnline ? "yes" : "no", "aria-hidden": "true" },
        }),
        el("div", { class: "team-main" }, [
          el("div", { class: "row", attrs: { style: "gap:7px" } }, [
            el("span", { class: "team-name", text: m.display_name + (isMe ? " (you)" : "") }),
            el("span", { class: "dot", attrs: { "data-online": isOnline ? "yes" : "no", "aria-hidden": "true" } }),
          ]),
          el("div", {
            class: "team-sub",
            text: held.length
              ? `holding ${plural(held.length, "file")}`
              : (isOnline ? "online, no files claimed" : "no files claimed"),
          }),
          held.length ? files : null,
        ]),
        el("div", { class: "team-meta" }, [
          el("div", {
            text: isOnline ? plural(m.active_sessions, "session") : fmtAgo(parseTs(m.last_seen)),
          }),
          el("div", { class: "muted", text: `joined ${fmtDate(m.joined_at)}` }),
        ]),
      ]));
    }
  }

  // Poll-driven only: "last seen" has minute granularity, so the 1s tick would
  // rebuild this list ~20 times per visible change and clobber text selection.
  const unsub = store.subscribe(update);
  update();
  // This page is the one that actually depends on the member list, and the
  // poll loop only refreshes it periodically - so pull a fresh one now.
  store.refreshMembers();

  return () => { unsub(); };
}
