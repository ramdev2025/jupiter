/* The "possible overlaps" card.
 *
 * These findings are advisory and model-generated, so the UI says so plainly:
 * they use the reserved `warning` status colour (never `critical`, which means
 * a real same-path conflict), always carry an icon *and* a text label, and
 * state the confidence in words rather than encoding it in colour.
 */

import { el, frag, show, clear } from "./dom.js";
import { fmtAgo, parseTs } from "./format.js";
import * as store from "./store.js";

const MARKUP = `
<section class="card overlaps" hidden>
  <div class="card-head">
    <h2>Possible overlaps</h2>
    <span class="spacer"></span>
    <span class="count" data-count></span>
  </div>

  <div class="card-body" data-pending hidden>
    <div class="waiting">
      <span class="spinner" aria-hidden="true"></span>
      <span>Looking for related work across different files…</span>
    </div>
  </div>

  <ul class="overlap-list" data-list></ul>

  <p class="empty" data-empty hidden>
    <span class="eico" aria-hidden="true">&#8776;</span>
    <span>No related work detected across different files.</span>
  </p>

  <div class="card-body overlap-foot" data-foot hidden></div>
</section>`;

export function createOverlapsCard() {
  const node = frag(MARKUP).firstElementChild;
  const q = (sel) => node.querySelector(sel);

  function update() {
    const s = store.state.semantic || {};
    const overlaps = s.overlaps || [];

    // With no gateway configured the whole feature stays invisible rather than
    // advertising a capability this deployment does not have.
    if (s.status === "disabled") { show(node, false); return; }
    show(node, true);

    show(q("[data-pending]"), s.status === "pending");
    show(q("[data-empty]"), s.status === "ready" && overlaps.length === 0);
    q("[data-count]").textContent = overlaps.length ? String(overlaps.length) : "";

    const list = q("[data-list]");
    clear(list);
    for (const item of overlaps) {
      const paths = el("div", { class: "overlap-paths" });
      item.paths.forEach((p, i) => {
        if (i) paths.append(el("span", { class: "plus", text: "+" }));
        paths.append(el("code", { class: "path", text: p }));
      });

      list.append(el("li", {}, [
        el("div", { class: "overlap-top" }, [
          el("span", { class: "badge", attrs: { "data-state": "overlap" } }, [
            el("span", { class: "ico", text: "≈", attrs: { "aria-hidden": "true" } }),
            el("span", { text: "possible overlap" }),
          ]),
          el("span", { class: "overlap-conf", text: `${item.confidence} confidence` }),
        ]),
        paths,
        el("div", { class: "overlap-reason", text: item.reason }),
        el("div", { class: "overlap-meta", text: (item.members || []).join(" · ") }),
      ]));
    }

    const foot = q("[data-foot]");
    if (s.status === "error") {
      foot.textContent = `Analysis unavailable: ${s.error || "unknown error"}`;
      show(foot, true);
    } else if (s.status === "ready" && s.model) {
      foot.textContent =
        `Suggested by ${s.model}` +
        (s.analyzed_at ? `, ${fmtAgo(parseTs(s.analyzed_at))}` : "") +
        ". Advisory only - same-file conflicts are detected without AI.";
      show(foot, true);
    } else {
      show(foot, false);
    }
  }

  return { node, update };
}
