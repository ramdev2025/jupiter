/* Overview: the at-a-glance page. Summary tiles, a conflict callout, and
 * previews that link through to the pages that can act on them. */

import { el, frag, show, clear } from "../dom.js";
import { fmtTtl, fmtClock, plural } from "../format.js";
import { createClaimsTable } from "../claims-table.js";
import { createOverlapsCard } from "../overlaps.js";
import { drawSpark } from "../viz.js";
import { onThemeChange } from "../ui.js";
import * as store from "../store.js";

const PREVIEW_ROWS = 6;
const PREVIEW_FEED = 5;

const MARKUP = `
<div>
  <div class="page-head">
    <div>
      <h1>Overview</h1>
      <p data-sub></p>
    </div>
    <span class="spacer"></span>
    <a class="ghost" href="#/files" style="padding:8px 14px">Manage files</a>
  </div>

  <div class="banner" data-banner hidden>
    <span class="bico" aria-hidden="true">&#9888;</span>
    <div>
      <strong data-banner-title></strong>
      <div class="btext" data-banner-text></div>
    </div>
    <span class="spacer"></span>
    <a class="subtle" href="#/files" style="align-self:center">Review</a>
  </div>

  <section class="tiles">
    <div class="tile hero">
      <span class="tile-label">Files claimed now</span>
      <span class="tile-value" data-kpi-claims>–</span>
      <svg class="spark" data-spark viewBox="0 0 160 40" preserveAspectRatio="xMinYMid meet"
           role="img" aria-label="Recent trend in claimed files" hidden></svg>
    </div>
    <div class="tile">
      <span class="tile-label">Conflicts</span>
      <span class="tile-value" data-kpi-conflicts>–</span>
      <span class="tile-foot" data-kpi-conflicts-foot></span>
    </div>
    <div class="tile">
      <span class="tile-label">Members online</span>
      <span class="tile-value" data-kpi-online>–</span>
      <span class="tile-foot" data-kpi-online-foot></span>
    </div>
    <div class="tile">
      <span class="tile-label">Claim lifetime</span>
      <span class="tile-value" data-kpi-ttl>–</span>
      <span class="tile-foot">without a refresh</span>
    </div>
  </section>

  <div class="split">
    <div class="col">
      <section class="card">
        <div class="card-head">
          <h2>Active claims</h2>
          <span class="spacer"></span>
          <span class="count" data-claims-count></span>
          <a class="subtle" href="#/files">All files</a>
        </div>
        <div data-claims-host></div>
      </section>

      <div data-overlaps-host></div>
    </div>

    <div class="col">
      <section class="card">
        <div class="card-head">
          <h2>Your claims</h2>
          <span class="spacer"></span>
          <span class="count" data-mine-count></span>
        </div>
        <ul class="team" data-mine></ul>
        <p class="empty" data-mine-empty hidden>
          <span class="eico" aria-hidden="true">&#9633;</span>
          You are not holding any file.
        </p>
      </section>

      <section class="card">
        <div class="card-head">
          <h2>Recent announcements</h2>
          <span class="spacer"></span>
          <a class="subtle" href="#/activity">All activity</a>
        </div>
        <ul class="feed" data-feed></ul>
        <p class="empty" data-feed-empty hidden>
          <span class="eico" aria-hidden="true">&#9650;</span>
          Nothing announced in the last hour.
        </p>
      </section>
    </div>
  </div>
</div>`;

export function mount(host) {
  const node = frag(MARKUP).firstElementChild;
  const q = (sel) => node.querySelector(sel);

  const table = createClaimsTable({ showActions: false });
  q("[data-claims-host]").append(table.node);

  const overlaps = createOverlapsCard();
  q("[data-overlaps-host]").append(overlaps.node);

  host.append(node);

  function update() {
    const s = store.state;
    const conflicts = store.conflictPaths();

    q("[data-sub]").textContent = s.slug
      ? `Team ${s.slug} · refreshing every ${store.POLL_MS / 1000}s`
      : "";

    // conflict banner
    const banner = q("[data-banner]");
    show(banner, conflicts.length > 0);
    if (conflicts.length) {
      q("[data-banner-title]").textContent =
        `${plural(conflicts.length, "file")} claimed by more than one person`;
      q("[data-banner-text]").textContent = conflicts.join(", ");
    }

    // tiles
    q("[data-kpi-claims]").textContent = String(s.locks.length);

    const cEl = q("[data-kpi-conflicts]");
    cEl.textContent = String(conflicts.length);
    cEl.dataset.state = conflicts.length ? "critical" : "good";
    q("[data-kpi-conflicts-foot]").textContent = conflicts.length
      ? conflicts.slice(0, 2).join(", ") + (conflicts.length > 2 ? ` +${conflicts.length - 2}` : "")
      : "all clear";

    q("[data-kpi-online]").textContent = String(s.activeMembers.length);
    const iAmOn = s.displayName && s.activeMembers.includes(s.displayName);
    q("[data-kpi-online-foot]").textContent = s.activeMembers.length
      ? (iAmOn ? "including you" : s.activeMembers.slice(0, 2).join(", "))
      : "nobody checked in";

    q("[data-kpi-ttl]").textContent = fmtTtl(s.ttl);
    drawSpark(q("[data-spark]"), s.history);

    overlaps.update();

    // claims preview
    const rows = store.filterLocks("");
    q("[data-claims-count]").textContent = rows.length > PREVIEW_ROWS
      ? `showing ${PREVIEW_ROWS} of ${rows.length}` : String(rows.length);
    table.update(rows.slice(0, PREVIEW_ROWS));

    // my claims
    const mine = store.myLocks();
    const mineList = q("[data-mine]");
    clear(mineList);
    show(q("[data-mine-empty]"), mine.length === 0);
    q("[data-mine-count]").textContent = mine.length ? String(mine.length) : "";
    for (const lock of mine) {
      const contested = lock.conflicts.length > 0;
      mineList.append(el("li", {}, [
        el("span", { class: "dot", attrs: { "data-online": contested ? "no" : "yes", "aria-hidden": "true" } }),
        el("div", { class: "team-main" }, [
          el("div", { class: "path", text: lock.file_path }),
          el("div", { class: "team-sub", text: contested
            ? `${lock.intent} · also held by ${[...new Set(lock.conflicts.map((c) => c.member))].join(", ")}`
            : lock.intent }),
        ]),
      ]));
    }

    // announcements preview
    const feed = q("[data-feed]");
    clear(feed);
    const items = s.announcements.slice().reverse().slice(0, PREVIEW_FEED);
    show(q("[data-feed-empty]"), items.length === 0);
    for (const a of items) {
      feed.append(el("li", {}, [
        el("div", { class: "feed-main" }, [
          el("div", { class: "feed-head" }, [
            el("span", { class: "feed-who", text: a.member }),
            el("span", { class: "feed-when", text: fmtClock(a.at) }),
          ]),
          el("div", { class: "feed-msg", text: a.message }),
        ]),
      ]));
    }
  }

  const unsub = store.subscribe(update);
  const unsubTick = store.onTick(table.tick);
  const unsubTheme = onThemeChange(() => drawSpark(q("[data-spark]"), store.state.history));
  update();

  return () => { unsub(); unsubTick(); unsubTheme(); };
}
