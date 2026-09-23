/* The active-claims table.
 *
 * A refetch patches existing rows in place rather than rebuilding the body,
 * so polling never produces a skeleton flash or a layout jump, and the
 * countdown animation stays smooth between polls.
 *
 * It is a real <table> with header cells, which doubles as the accessible
 * table view for everything the badges and meters encode visually.
 */

import { el, frag, show } from "./dom.js";
import { fmtCountdown, parseTs, serverNow } from "./format.js";
import { paintMeter } from "./viz.js";
import { state, overlapsForPath } from "./store.js";

const MARKUP = `
<div class="table-wrap">
  <table class="claims">
    <thead>
      <tr>
        <th scope="col">File</th>
        <th scope="col">Held by</th>
        <th scope="col">State</th>
        <th scope="col" class="num">Expires in</th>
        <th scope="col"><span class="sr-only">Actions</span></th>
      </tr>
    </thead>
    <tbody></tbody>
  </table>
  <p class="empty" data-empty hidden>
    <span class="eico" aria-hidden="true">○</span>
    <span data-empty-text>Nobody is holding a file right now.</span>
  </p>
</div>`;

export function createClaimsTable({ showActions = true, onRelease, emptyText } = {}) {
  const node = frag(MARKUP).firstElementChild;
  const body = node.querySelector("tbody");
  const empty = node.querySelector("[data-empty]");
  const table = node.querySelector("table");
  if (emptyText) empty.querySelector("[data-empty-text]").textContent = emptyText;

  function update(rows) {
    show(empty, rows.length === 0);
    show(table, rows.length > 0);

    const existing = new Map();
    for (const tr of body.children) existing.set(tr.dataset.key, tr);

    const seen = new Set();
    let previous = null;
    for (const lock of rows) {
      const key = `${lock.session_id}|${lock.file_path}`;
      seen.add(key);
      const tr = existing.get(key) || buildRow(key, showActions);
      updateRow(tr, lock, showActions, onRelease);
      // Move only when actually out of position.
      const want = previous ? previous.nextSibling : body.firstChild;
      if (tr !== want) body.insertBefore(tr, want);
      previous = tr;
    }
    for (const [key, tr] of existing) if (!seen.has(key)) tr.remove();
  }

  function tick() { for (const tr of body.children) tickRow(tr); }

  return { node, update, tick };
}

function buildRow(key, showActions) {
  const tr = el("tr", { attrs: { "data-key": key } });

  const path = el("div", { class: "path" });
  const note = el("div", { class: "note" });
  const withWho = el("div", { class: "conflict-with" });
  const overlap = el("div", { class: "row-overlap" }, [
    el("span", { class: "ico", text: "≈", attrs: { "aria-hidden": "true" } }),
    el("span", {}),
  ]);

  const who = el("span", {});
  const youTag = el("span", { class: "tag-you", text: "you" });
  const dir = el("span", { class: "holder-dir" });

  const ico = el("span", { class: "ico", attrs: { "aria-hidden": "true" } });
  const label = el("span", {});
  const badge = el("span", { class: "badge" }, [ico, label]);

  const countdown = el("span", { class: "countdown" });
  const fill = el("i");
  const meter = el("div", { class: "meter" }, [fill]);

  const release = el("button", { class: "subtle", text: "Release", attrs: { type: "button" } });

  tr.append(
    el("td", {}, [path, note, withWho, overlap]),
    el("td", { class: "holder" }, [who, youTag, dir]),
    el("td", {}, [badge]),
    el("td", { class: "num meter-cell" }, [countdown, meter]),
    el("td", {}, showActions ? [release] : []),
  );
  tr.refs = {
    path, note, withWho, overlap, who, youTag, dir,
    badge, ico, label, countdown, meter, fill, release,
  };
  return tr;
}

function updateRow(tr, lock, showActions, onRelease) {
  const r = tr.refs;
  tr.lock = lock;

  const contested = lock.conflicts.length > 0;
  const isMine = state.memberId != null && lock.member_id === state.memberId;
  tr.classList.toggle("contested", contested);
  tr.classList.toggle("mine", isMine && !contested);

  r.path.textContent = lock.file_path;

  r.note.textContent = lock.note || "";
  show(r.note, Boolean(lock.note));

  if (contested) {
    const names = [...new Set(lock.conflicts.map((c) => `${c.member} (${c.intent})`))];
    r.withWho.textContent = `also held by ${names.join(", ")}`;
  }
  show(r.withWho, contested);

  // Advisory overlap with a *different* file, shown beside the path it affects.
  const overlaps = overlapsForPath(lock.file_path);
  const others = [...new Set(
    overlaps.flatMap((o) => o.paths.filter((p) => p !== lock.file_path)))];
  // Cleared rather than left stale, so a hidden row never holds old text.
  r.overlap.lastElementChild.textContent =
    others.length ? `related to ${others.join(", ")}` : "";
  r.overlap.title = overlaps.map((o) => o.reason).join(" / ");
  show(r.overlap, others.length > 0);

  r.who.textContent = lock.member || "unknown";
  show(r.youTag, isMine);
  r.dir.textContent = lock.working_dir || "";
  show(r.dir, Boolean(lock.working_dir));

  const st = contested ? "conflict" : lock.intent;
  r.badge.dataset.state = st;
  r.ico.textContent = st === "conflict" ? "⚠" : st === "editing" ? "✎" : "○";
  r.label.textContent = st === "conflict" ? `conflict · ${lock.intent}` : lock.intent;

  // Releasing only works for claims held by *this* session: the server scopes
  // a release to the caller's own session, so the same person's Claude Code
  // session is not ours to drop.
  if (showActions) {
    const releasable = state.sessionId != null && lock.session_id === state.sessionId;
    show(r.release, releasable);
    if (releasable && onRelease) r.release.onclick = () => onRelease(lock.file_path);
  }

  tickRow(tr);
}

function tickRow(tr) {
  const lock = tr.lock;
  if (!lock) return;
  const expires = parseTs(lock.expires_at);
  const left = expires == null ? null : expires - serverNow();
  tr.refs.countdown.textContent = fmtCountdown(left);
  paintMeter(tr.refs.meter, tr.refs.fill,
    left == null ? 0 : left / (state.ttl * 1000));
}
