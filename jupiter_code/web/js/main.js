/* Bootstrap: the route table, the app chrome, and start-up. */

import { $, show } from "./dom.js";
import { api } from "./api.js";
import { define, setGuard, start, go } from "./router.js";
import { toast, toggleTheme } from "./ui.js";
import * as store from "./store.js";
import * as setup from "./setup.js";

import * as overview from "./pages/overview.js";
import * as files from "./pages/files.js";
import * as team from "./pages/team.js";
import * as activity from "./pages/activity.js";
import * as settings from "./pages/settings.js";

/* ---- routes --------------------------------------------------------- */

function page(pattern, shell, mount, nav) {
  define(pattern, { shell, mount, nav, onEnter: afterNavigate });
}

page("/welcome", "setup", setup.welcome);
page("/setup/choose", "setup", setup.choose);
page("/setup/create", "setup", setup.create);
page("/setup/join", "setup", setup.join);
page("/setup/key", "setup", setup.keys);
page("/setup/connect", "setup", setup.connectClaude);
page("/setup/done", "setup", setup.done);
page("/setup/signin", "setup", setup.signin);

page("/overview", "app", overview.mount, "overview");
page("/files", "app", files.mount, "files");
page("/team", "app", team.mount, "team");
page("/activity", "app", activity.mount, "activity");
page("/settings", "app", settings.mount, "settings");

const isSetupPath = (p) => p === "/welcome" || p.startsWith("/setup/");

setGuard((p) => {
  if (p === "/") return store.state.connected ? "/overview" : "/welcome";
  // The app pages need a validated key; the wizard stays reachable either way
  // so a connected user can still walk a teammate through joining.
  if (!store.state.connected && !isSetupPath(p)) return "/welcome";
  return null;
});

function afterNavigate(route) {
  for (const link of document.querySelectorAll("[data-nav]")) {
    if (route.nav && link.dataset.nav === route.nav) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  }
  if (route.shell === "setup") setup.paintStepper();
  closeDrawer();
}

/* ---- chrome --------------------------------------------------------- */

function closeDrawer() {
  $("sidebar").dataset.open = "false";
  $("btn-nav").setAttribute("aria-expanded", "false");
}

function paintChrome() {
  const s = store.state;

  $("chip-org").textContent = s.slug ? `team ${s.slug}` : "";
  show($("chip-org"), Boolean(s.slug));

  const me = s.displayName || (s.kind === "admin" ? "org admin" : s.memberId != null ? `member #${s.memberId}` : "");
  $("chip-me").textContent = me;
  show($("chip-me"), Boolean(me));

  // live indicator
  const chip = $("chip-live");
  const text = $("live-text");
  if (s.paused) {
    chip.dataset.state = "paused";
    text.textContent = "paused";
    chip.title = "Polling is paused";
  } else if (s.lastError) {
    chip.dataset.state = "error";
    text.textContent = "disconnected";
    chip.title = s.lastError;
  } else {
    chip.dataset.state = "ok";
    text.textContent = `live · ${store.POLL_MS / 1000}s`;
    chip.title = `Refreshing every ${store.POLL_MS / 1000}s`;
  }

  // A failed refetch holds the last good render at reduced opacity rather
  // than blanking the page.
  $("app-view").classList.toggle("stale", Boolean(s.lastError));

  const conflicts = store.conflictPaths().length;
  const badge = $("nav-badge-files");
  badge.textContent = String(conflicts);
  show(badge, conflicts > 0);

  const online = (s.members || []).filter((m) => m.active_sessions > 0).length;
  $("nav-count-team").textContent = s.members && s.members.length ? `${online}/${s.members.length}` : "";
}

function wireChrome() {
  $("btn-pause").addEventListener("click", () => {
    const next = !store.state.paused;
    store.setPaused(next);
    const btn = $("btn-pause");
    btn.setAttribute("aria-pressed", String(next));
    btn.textContent = next ? "Resume" : "Pause";
  });

  for (const id of ["btn-theme", "setup-theme"]) {
    $(id).addEventListener("click", () => toggleTheme());
  }

  $("btn-nav").addEventListener("click", () => {
    const open = $("sidebar").dataset.open !== "true";
    $("sidebar").dataset.open = String(open);
    $("btn-nav").setAttribute("aria-expanded", String(open));
  });

  // Ending the session also releases whatever this browser was holding.
  window.addEventListener("pagehide", store.endSessionOnExit);

  // Refresh promptly when the tab comes back rather than showing stale rows.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") store.pollNow();
  });

  store.setUnauthorizedHandler((message) => {
    toast("critical", message);
    go("/setup/signin");
  });

  store.subscribe(paintChrome);
}

/* ---- boot ----------------------------------------------------------- */

async function boot() {
  wireChrome();
  store.loadPreferences();

  api("GET", "/healthz", undefined, null)
    .then((h) => {
      store.state.version = h.version;
      $("foot-version").textContent = `Jupiter ${h.version}`;
    })
    .catch(() => {});

  // Validate any saved key BEFORE the router runs, so the route guard sees a
  // settled connection state and we don't flash the wizard on every reload.
  const saved = store.savedKey();
  if (saved) {
    try {
      await store.connect(saved, null);
    } catch (err) {
      localStorage.removeItem("jupiter.key");
      if (err.status === 401) toast("warning", "The saved key was rejected. Connect again.");
    }
  }

  paintChrome();   // connect() already started polling if the key was good
  start();
}

boot();
