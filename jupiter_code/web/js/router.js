/* A hash router.
 *
 * Hash routing keeps every page deep-linkable without needing a server-side
 * catch-all: StaticFiles only ever serves index.html, and the fragment never
 * reaches the server.
 *
 * Each route declares the shell it renders into and a mount() that returns an
 * optional teardown. Exactly one page is mounted at a time; its teardown runs
 * before the next one mounts, which is what lets pages subscribe to the store
 * on mount and unsubscribe cleanly on leave.
 */

import { $, clear } from "./dom.js";

const routes = [];
let current = null;      // { route, teardown }
let resolveGuard = () => null;

export function define(pattern, config) {
  routes.push({ pattern, ...config });
}

/** Return a path to redirect to, or null to allow. */
export function setGuard(fn) { resolveGuard = fn; }

export function path() {
  const raw = window.location.hash.replace(/^#/, "");
  return raw.startsWith("/") ? raw : "/";
}

export function query() {
  const [, qs = ""] = path().split("?");
  return new URLSearchParams(qs);
}

export function go(to, { replace = false } = {}) {
  const target = `#${to}`;
  if (window.location.hash === target) { handle(); return; }
  if (replace) window.location.replace(target);
  else window.location.hash = target;
}

function match(p) {
  const clean = p.split("?")[0];
  return routes.find((r) => r.pattern === clean);
}

async function handle() {
  const raw = path();
  const redirect = resolveGuard(raw.split("?")[0]);
  if (redirect) { go(redirect, { replace: true }); return; }

  const route = match(raw);
  if (!route) { go("/overview", { replace: true }); return; }

  if (current && current.teardown) {
    try { current.teardown(); } catch (e) { console.error(e); }
  }
  current = null;

  // Show the shell this route belongs to, hide the other.
  const isSetup = route.shell === "setup";
  $("shell-setup").hidden = !isSetup;
  $("shell-app").hidden = isSetup;

  const host = isSetup ? $("setup-view") : $("app-view");
  clear(host);

  const teardown = await route.mount(host, query());
  current = { route, teardown };

  if (route.onEnter) route.onEnter(route);

  // Reset scroll and move focus to the new view for keyboard/screen-reader users.
  window.scrollTo(0, 0);
  host.focus({ preventScroll: true });
}

export function start() {
  window.addEventListener("hashchange", handle);
  if (!window.location.hash) {
    // No explicit route: let the guard decide where to land.
    go(resolveGuard("/") || "/overview", { replace: true });
  } else {
    handle();
  }
}

export function currentRoute() { return current ? current.route : null; }
