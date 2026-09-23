/* Files: the working page - filter, the full claims table, and the claim form. */

import { frag, show } from "../dom.js";
import { toast } from "../ui.js";
import { createClaimsTable } from "../claims-table.js";
import { createOverlapsCard } from "../overlaps.js";
import * as store from "../store.js";

const MARKUP = `
<div>
  <div class="page-head">
    <div>
      <h1>Files</h1>
      <p>Every claim across the team. Conflicts sort to the top.</p>
    </div>
  </div>

  <section class="card" data-claim-card>
    <div class="card-head"><h2>Claim a file</h2></div>
    <form class="card-body" data-form>
      <div class="btn-row" style="align-items:flex-end">
        <div class="field grow">
          <label for="c-path">Path <span class="muted">(repo-relative)</span></label>
          <input id="c-path" type="text" placeholder="src/payments.py" required
                 autocomplete="off" spellcheck="false">
        </div>
        <div class="field">
          <label for="c-intent">Intent</label>
          <select id="c-intent">
            <option value="editing">editing</option>
            <option value="reading">reading</option>
          </select>
        </div>
        <div class="field grow">
          <label for="c-note">Note <span class="muted">(optional)</span></label>
          <input id="c-note" type="text" maxlength="280" placeholder="adding refunds"
                 autocomplete="off">
        </div>
        <button class="primary" type="submit">Claim</button>
      </div>
      <p class="hint" style="margin-top:10px">Claims are advisory - they never block an
        edit, they just tell everyone else you are there. Use the same repo-relative
        paths your teammates use; comparison is case-sensitive.</p>
    </form>
  </section>

  <div class="banner" data-ro hidden data-kind="info">
    <span class="bico" aria-hidden="true">&#9432;</span>
    <div>
      <strong>Read-only view</strong>
      <div class="btext">You are connected with an org admin key. Claiming and releasing
        need a member key.</div>
    </div>
  </div>

  <div class="toolbar" style="margin-top:14px">
    <label class="sr-only" for="c-filter">Filter by path, teammate or note</label>
    <input id="c-filter" type="search" placeholder="Filter by path, teammate or note…"
           autocomplete="off" spellcheck="false">
    <label class="switch">
      <input type="checkbox" data-autorenew>
      <span class="sw-text"><strong>Auto-renew my claims</strong></span>
    </label>
  </div>

  <section class="card">
    <div class="card-head">
      <h2>Active claims</h2>
      <span class="spacer"></span>
      <span class="count" data-count></span>
    </div>
    <div data-host></div>
  </section>

  <div data-overlaps-host style="margin-top:14px"></div>
</div>`;

export function mount(host) {
  const node = frag(MARKUP).firstElementChild;
  const q = (sel) => node.querySelector(sel);
  let filter = "";

  const table = createClaimsTable({
    showActions: true,
    onRelease: async (path) => {
      try { await store.releaseFile(path); }
      catch (err) { toast("critical", err.message); }
    },
  });
  q("[data-host]").append(table.node);

  const overlaps = createOverlapsCard();
  q("[data-overlaps-host]").append(overlaps.node);

  const readOnly = store.isReadOnly();
  show(q("[data-ro]"), readOnly);
  show(q("[data-claim-card]"), !readOnly);

  const autoRenew = q("[data-autorenew]");
  autoRenew.checked = store.state.autoRenew;
  autoRenew.disabled = readOnly;
  autoRenew.addEventListener("change", (ev) => store.setAutoRenew(ev.target.checked));

  q("#c-filter").addEventListener("input", (ev) => { filter = ev.target.value; update(); });

  q("[data-form]").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const path = q("#c-path").value.trim();
    if (!path) return;
    const btn = q("[data-form] button[type=submit]");
    btn.disabled = true;
    try {
      await store.claimFile(path, q("#c-intent").value, q("#c-note").value.trim());
      q("#c-path").value = "";
      q("#c-note").value = "";
    } catch (err) {
      toast("critical", err.message);
    } finally {
      btn.disabled = false;
    }
  });

  host.append(node);

  function update() {
    const rows = store.filterLocks(filter);
    q("[data-count]").textContent = filter.trim()
      ? `${rows.length} of ${store.state.locks.length}`
      : String(rows.length);
    table.update(rows);
    overlaps.update();
  }

  const unsub = store.subscribe(update);
  const unsubTick = store.onTick(table.tick);
  update();

  return () => { unsub(); unsubTick(); };
}
