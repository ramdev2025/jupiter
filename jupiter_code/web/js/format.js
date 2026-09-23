/* Time and value formatting.
 *
 * The server sends naive-UTC instants suffixed with Z. The browser clock can
 * disagree with the server's, so every "how long is left" calculation goes
 * through serverNow(), which applies the measured skew.
 */

let skewMs = 0;

/** Record the offset between the server's clock and ours. */
export function setSkew(serverIso) {
  const ms = parseTs(serverIso);
  if (ms != null) skewMs = ms - Date.now();
}

export function serverNow() { return Date.now() + skewMs; }

export function parseTs(iso) {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

/** "2:41", "1:02:30", "expired". */
export function fmtCountdown(ms) {
  if (ms == null) return "–";
  if (ms <= 0) return "expired";
  const total = Math.round(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** "just now", "5m ago", "2h ago", "3d ago". */
export function fmtAgo(ms) {
  if (ms == null) return "never";
  const secs = Math.max(0, Math.round((serverNow() - ms) / 1000));
  if (secs < 45) return "just now";
  if (secs < 3600) return `${Math.round(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.round(secs / 3600)}h ago`;
  return `${Math.round(secs / 86400)}d ago`;
}

/** Local wall-clock time, e.g. "14:33". */
export function fmtClock(iso) {
  const ms = parseTs(iso);
  if (ms == null) return "";
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function fmtDate(iso) {
  const ms = parseTs(iso);
  if (ms == null) return "unknown";
  return new Date(ms).toLocaleDateString([], { year: "numeric", month: "short", day: "numeric" });
}

/** A lock TTL in words: "5m", "90s". */
export function fmtTtl(secs) {
  if (!secs) return "–";
  return secs % 60 === 0 ? `${secs / 60}m` : `${secs}s`;
}

export function plural(n, one, many) {
  return `${n} ${n === 1 ? one : (many || one + "s")}`;
}
