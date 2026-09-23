/* Shared state, the polling loop, session lifecycle and write actions.
 *
 * Pages subscribe on mount and unsubscribe on unmount, so live data survives
 * navigation between pages instead of restarting on every route change.
 */

import { api, ApiError, parseKey, setKey } from "./api.js";
import { setSkew, parseTs } from "./format.js";
import { toast, notify } from "./ui.js";

export const POLL_MS = 3000;
const TICK_MS = 1000;
const SPARK_POINTS = 12;

/* Every authenticated request costs a bcrypt verification server-side (~0.5s
 * on a laptop), so the member list - which only changes when somebody joins
 * or their session count shifts - is refreshed every Nth poll rather than on
 * each one. Live presence still comes from /activity's active_members. */
const MEMBERS_EVERY = 4;

/* Semantic overlaps are model-backed, so the server caches them per claim-set
 * and only re-analyses when that set changes. Polling every 4th tick is plenty
 * - except while a fresh analysis is in flight, when we check each tick so the
 * result appears promptly. */
const SEMANTIC_EVERY = 4;

let pollCount = 0;

const LS = {
  key: "jupiter.key",
  dir: "jupiter.dir",
  autorenew: "jupiter.autorenew",
  notify: "jupiter.notify",
};

export const state = {
  key: null,
  kind: null,            // "member" | "admin"
  memberId: null,
  displayName: null,
  slug: null,
  workingDir: "",
  sessionId: null,       // created lazily, only when we act
  ttl: 300,
  version: null,

  locks: [],
  members: [],
  announcements: [],
  activeMembers: [],
  history: [],           // recent claim counts, for the trend line

  // Advisory, AI-suggested overlaps between *different* files. Never affects
  // the deterministic same-path conflict rule.
  semantic: {
    status: "disabled", overlaps: [], analyzed_at: null,
    model: null, error: null, llm: null,
  },

  connected: false,
  paused: false,
  lastError: null,
  primed: false,         // has the first poll set a conflict baseline?
  knownConflicts: new Set(),

  autoRenew: true,
  notifyConflicts: false,
};

/* ---- subscriptions -------------------------------------------------- */

const subs = new Set();
const ticks = new Set();

export function subscribe(fn) { subs.add(fn); return () => subs.delete(fn); }
export function onTick(fn) { ticks.add(fn); return () => ticks.delete(fn); }

function emit() { for (const fn of [...subs]) { try { fn(state); } catch (e) { console.error(e); } } }

let onUnauthorized = () => {};
export function setUnauthorizedHandler(fn) { onUnauthorized = fn; }

/* ---- derived -------------------------------------------------------- */

export function isReadOnly() { return state.kind !== "member"; }

/** Files where two different members overlap and at least one is editing. */
export function conflictPaths() {
  return [...new Set(state.locks.filter((l) => l.conflicts.length).map((l) => l.file_path))];
}

export function myLocks() {
  if (state.memberId == null) return [];
  return state.locks.filter((l) => l.member_id === state.memberId);
}

/** Claims this browser session holds - the only ones it can release. */
export function releasableLocks() {
  if (state.sessionId == null) return [];
  return state.locks.filter((l) => l.session_id === state.sessionId);
}

export function locksForMember(memberId) {
  return state.locks.filter((l) => l.member_id === memberId);
}

export function filterLocks(needle) {
  const q = (needle || "").trim().toLowerCase();
  const rows = q
    ? state.locks.filter((l) =>
        l.file_path.toLowerCase().includes(q) ||
        (l.member || "").toLowerCase().includes(q) ||
        (l.note || "").toLowerCase().includes(q))
    : state.locks.slice();

  // Conflicts first, then oldest claim first. Sorting on locked_at - which
  // never changes - keeps rows from reshuffling as the countdowns tick.
  rows.sort((a, b) => {
    const ca = a.conflicts.length ? 0 : 1, cb = b.conflicts.length ? 0 : 1;
    if (ca !== cb) return ca - cb;
    return (parseTs(a.locked_at) || 0) - (parseTs(b.locked_at) || 0);
  });
  return rows;
}

/* ---- conflict annotation (mirrors the server's rule) ---------------- */

export function annotate(locks) {
  const byPath = new Map();
  for (const lock of locks) {
    if (!byPath.has(lock.file_path)) byPath.set(lock.file_path, []);
    byPath.get(lock.file_path).push(lock);
  }
  for (const lock of locks) {
    // Two readers never collide; anything involving an editor does. A second
    // claim from the same person (their editor and their agent) is not one.
    lock.conflicts = byPath.get(lock.file_path).filter((other) =>
      other !== lock &&
      other.member_id !== lock.member_id &&
      (other.intent === "editing" || lock.intent === "editing"));
  }
  return locks;
}

function trackConflicts(locks) {
  const current = new Set();
  for (const lock of locks) {
    if (!lock.conflicts.length) continue;
    // Only shout about collisions that involve us.
    if (state.memberId != null && lock.member_id !== state.memberId) continue;
    current.add(lock.file_path);
  }

  if (!state.primed) {
    // First poll: adopt whatever is already happening as the baseline. A
    // notification should mean "this just started", not "here is the backlog".
    state.primed = true;
    state.knownConflicts = current;
    if (current.size) toast("warning", `Already in conflict on ${[...current].join(", ")}.`, 9000);
    return;
  }

  for (const path of current) {
    if (state.knownConflicts.has(path)) continue;
    const lock = locks.find((l) => l.file_path === path && l.conflicts.length);
    const who = [...new Set(lock.conflicts.map((c) => c.member))].join(", ");
    toast("critical", `${who} also has ${path} open.`, 10000);
    if (state.notifyConflicts) {
      notify("Jupiter: file conflict", `${who} also has ${path} open.`, `jupiter-${path}`);
    }
  }
  state.knownConflicts = current;
}

/* ---- polling -------------------------------------------------------- */

let pollTimer = null;
let tickTimer = null;

let polling = false;

export async function pollNow() {
  if (!state.key || state.paused) return;
  // Skip rather than queue. If a refresh takes longer than the interval - a
  // distant database, a slow link - piling requests up only makes it worse,
  // and every one of them costs a bcrypt verify server-side.
  if (polling) return;
  polling = true;
  try {
    const activity = await api("GET", "/activity");
    setSkew(activity.now);

    state.ttl = activity.lock_ttl_seconds || state.ttl;
    state.locks = annotate(activity.locks || []);
    state.announcements = activity.announcements || [];
    state.activeMembers = activity.active_members || [];
    state.slug = activity.slug || state.slug;
    state.lastError = null;

    state.history.push(state.locks.length);
    if (state.history.length > SPARK_POINTS) state.history.shift();

    trackConflicts(state.locks);
    // Paint as soon as the activity data lands. Waiting on the member list
    // would leave the dashboard empty for a second on first load.
    emit();

    // Deliberately not awaited: these emit again when they land, and the write
    // actions below await pollNow() before re-enabling their form - making
    // them wait on a secondary request would add ~0.5s of dead button.
    const tick = pollCount++;
    if (tick % MEMBERS_EVERY === 0) refreshMembers();
    if (tick % SEMANTIC_EVERY === 0 || state.semantic.status === "pending") {
      refreshSemantic();
    }
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      disconnect();
      onUnauthorized("Your API key was rejected. Connect again.");
      return;
    }
    state.lastError = err.message;
    emit();
  } finally {
    // finally, not a trailing assignment: the 401 branch above returns early,
    // and leaving this set would stop polling for the rest of the session.
    polling = false;
  }
}

/** Fetch the member list now. Pages that need it fresh call this on mount. */
export async function refreshMembers() {
  if (!state.key || !state.slug) return;
  try {
    state.members = await api("GET", `/orgs/${encodeURIComponent(state.slug)}/members`);
    if (state.memberId != null && !state.displayName) {
      const me = state.members.find((m) => m.member_id === state.memberId);
      if (me) state.displayName = me.display_name;
    }
    emit();
  } catch (_) { /* a key without org access still gets everything else */ }
}

/** Fetch model-suggested overlaps. Purely advisory, so failures are silent. */
export async function refreshSemantic() {
  if (!state.key) return;
  try {
    state.semantic = await api("GET", "/semantic");
    emit();
  } catch (_) { /* the dashboard is fully usable without this */ }
}

/** Overlaps touching one path - used to annotate its row in the table. */
export function overlapsForPath(filePath) {
  return (state.semantic.overlaps || []).filter((o) => o.paths.includes(filePath));
}

export function semanticEnabled() {
  return state.semantic.status !== "disabled";
}

export function startPolling() {
  stopPolling();
  pollCount = 0;
  pollTimer = setInterval(pollNow, POLL_MS);
  tickTimer = setInterval(() => {
    for (const fn of [...ticks]) { try { fn(); } catch (e) { console.error(e); } }
    const n = conflictPaths().length;
    document.title = n ? `(${n}) Jupiter` : "Jupiter";
  }, TICK_MS);
  pollNow();
}

export function stopPolling() {
  if (pollTimer) clearInterval(pollTimer);
  if (tickTimer) clearInterval(tickTimer);
  pollTimer = tickTimer = null;
}

export function setPaused(paused) {
  state.paused = paused;
  emit();
  if (!paused) pollNow();
}

/* ---- sessions ------------------------------------------------------- *
 * The dashboard stays an observer until you actually claim something, so it
 * does not register a session - and does not appear online - until then.    */

async function ensureSession() {
  if (state.sessionId != null) return state.sessionId;
  const s = await api("POST", "/sessions", { working_dir: state.workingDir || null });
  state.sessionId = s.session_id;
  state.displayName = s.display_name || state.displayName;
  state.slug = s.slug || state.slug;
  startKeepAlive();
  emit();
  return state.sessionId;
}

/** Retries once on a dead session, the way the MCP client does. */
async function withSession(method, path, body) {
  const sid = await ensureSession();
  try {
    return await api(method, path, { ...body, session_id: sid });
  } catch (err) {
    if (!(err instanceof ApiError) || (err.status !== 409 && err.status !== 404)) throw err;
    state.sessionId = null;
    return api(method, path, { ...body, session_id: await ensureSession() });
  }
}

/* A session heartbeat keeps us listed as online but does NOT extend a claim -
 * only re-locking the path refreshes its TTL. So auto-renew re-posts each file
 * this dashboard holds. */
let keepTimer = null;

async function keepAlive() {
  if (state.sessionId == null) return;
  try {
    await api("POST", `/sessions/${state.sessionId}/heartbeat`);
  } catch (err) {
    if (err instanceof ApiError && (err.status === 404 || err.status === 409)) {
      state.sessionId = null;
    }
    return;
  }
  if (!state.autoRenew) return;
  for (const lock of releasableLocks()) {
    try {
      await withSession("POST", "/locks", {
        file_path: lock.file_path, intent: lock.intent, note: lock.note,
      });
    } catch (_) { /* the next poll shows the truth */ }
  }
}

function startKeepAlive() {
  if (keepTimer) return;
  keepTimer = setInterval(keepAlive, Math.max(15, Math.floor(state.ttl / 3)) * 1000);
}

/** Ends the session (which also releases its claims) as the page goes away. */
export function endSessionOnExit() {
  if (state.sessionId == null || !state.key) return;
  fetch(`/sessions/${state.sessionId}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${state.key}` },
    keepalive: true,
  }).catch(() => {});
}

/* ---- actions -------------------------------------------------------- */

export async function claimFile(filePath, intent, note) {
  const result = await withSession("POST", "/locks", {
    file_path: filePath, intent, note: note || null,
  });
  if (result.status === "blocked") {
    const who = result.conflicts.map((c) => `${c.member} (${c.intent})`).join(", ");
    toast("critical", `Claim recorded, but ${who} already has ${result.file_path}.`, 10000);
  } else {
    toast("good", `You hold ${result.file_path} (${result.intent}).`);
  }
  await pollNow();
  return result;
}

export async function releaseFile(filePath) {
  const result = await withSession("POST", "/locks/release", { file_path: filePath });
  toast(result.released ? "good" : "info", result.message);
  await pollNow();
  return result;
}

export async function sendAnnouncement(message) {
  // session_id is optional on this endpoint, so announcing never forces a
  // session into existence; we pass ours only if we already have one.
  const body = { message };
  if (state.sessionId != null) body.session_id = state.sessionId;
  try {
    await api("POST", "/announcements", body);
  } catch (err) {
    if (!(err instanceof ApiError) || (err.status !== 409 && err.status !== 404)) throw err;
    state.sessionId = null;
    await api("POST", "/announcements", { message });
  }
  await pollNow();
}

/* ---- connection ----------------------------------------------------- */

/** Validates the key against /activity, then wires up state. Throws on failure. */
export async function connect(rawKey, workingDir) {
  const parsed = parseKey(rawKey);
  if (!parsed) throw new ApiError(400, "That does not look like a Jupiter key (expected jpm_… or jpa_…).");

  const key = String(rawKey).trim();
  const activity = await api("GET", "/activity", undefined, key);

  state.key = key;
  state.kind = parsed.kind;
  state.memberId = parsed.kind === "member" ? parsed.id : null;
  state.slug = activity.slug;
  state.ttl = activity.lock_ttl_seconds || 300;
  state.connected = true;
  state.primed = false;
  state.knownConflicts = new Set();
  state.history = [];
  if (workingDir != null) setWorkingDir(workingDir);
  setKey(key);
  localStorage.setItem(LS.key, key);
  // Connecting implies wanting live data, including straight out of the
  // wizard. startPolling() is idempotent, so a second call is harmless.
  startPolling();
  emit();
  return activity;
}

export function disconnect() {
  endSessionOnExit();
  stopPolling();
  if (keepTimer) clearInterval(keepTimer);
  keepTimer = null;
  localStorage.removeItem(LS.key);
  setKey(null);
  Object.assign(state, {
    key: null, kind: null, memberId: null, displayName: null, sessionId: null,
    locks: [], members: [], announcements: [], activeMembers: [], history: [],
    connected: false, primed: false, knownConflicts: new Set(), lastError: null,
    semantic: {
      status: "disabled", overlaps: [], analyzed_at: null,
      model: null, error: null, llm: null,
    },
  });
  document.title = "Jupiter";
  emit();
}

export function savedKey() { return localStorage.getItem(LS.key); }

/* ---- settings ------------------------------------------------------- */

export function setWorkingDir(dir) {
  state.workingDir = dir || "";
  if (state.workingDir) localStorage.setItem(LS.dir, state.workingDir);
  else localStorage.removeItem(LS.dir);
}

export function setAutoRenew(on) {
  state.autoRenew = Boolean(on);
  localStorage.setItem(LS.autorenew, String(state.autoRenew));
  emit();
}

export function setNotifyConflicts(on) {
  state.notifyConflicts = Boolean(on);
  localStorage.setItem(LS.notify, String(state.notifyConflicts));
  emit();
}

/** Restore persisted preferences. Called once at boot. */
export function loadPreferences() {
  state.autoRenew = localStorage.getItem(LS.autorenew) !== "false";
  state.workingDir = localStorage.getItem(LS.dir) || "";
  state.notifyConflicts = localStorage.getItem(LS.notify) === "true" &&
    typeof Notification !== "undefined" && Notification.permission === "granted";
}
