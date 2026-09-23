/* REST client.
 *
 * Served same-origin by the Jupiter server, so every path below is relative
 * and no CORS configuration is involved.
 */

export class ApiError extends Error {
  constructor(status, detail) {
    super(detail || `request failed (${status})`);
    this.status = status;
  }
}

let authKey = null;

export function setKey(key) { authKey = key || null; }
export function getKey() { return authKey; }

/**
 * @param keyOverride pass a key explicitly, or `null` for an unauthenticated
 *   call (org creation and joining need no key).
 */
export async function api(method, path, body, keyOverride) {
  const key = keyOverride !== undefined ? keyOverride : authKey;
  const headers = {};
  if (key) headers["Authorization"] = `Bearer ${key}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";

  let res;
  try {
    res = await fetch(path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (_) {
    throw new ApiError(0, "cannot reach the Jupiter server");
  }

  if (!res.ok) {
    let detail = `${res.status} ${res.statusText}`;
    try {
      const data = await res.json();
      if (data && data.detail) {
        detail = typeof data.detail === "string" ? data.detail : JSON.stringify(data.detail);
      }
    } catch (_) { /* error body was not JSON */ }
    throw new ApiError(res.status, detail);
  }

  if (res.status === 204 || res.headers.get("content-length") === "0") return null;
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

/* Keys embed the id of the record they belong to:
 *   jpm_<member_id>_<secret>   member
 *   jpa_<org_id>_<secret>      org admin
 * Reading the prefix tells us who we are without opening a session first. */
export function parseKey(raw) {
  const parts = String(raw || "").trim().split("_");
  if (parts.length < 3) return null;
  const [prefix, id, ...rest] = parts;
  if (!/^\d+$/.test(id) || !rest.join("_")) return null;
  if (prefix === "jpm") return { kind: "member", id: Number(id) };
  if (prefix === "jpa") return { kind: "admin", id: Number(id) };
  return null;
}

/** The ready-to-paste Claude Code registration command for a member key. */
export function mcpCommand(key) {
  return "claude mcp add jupiter --scope user" +
    ` --env JUPITER_SERVER=${window.location.origin}` +
    ` --env JUPITER_API_KEY=${key || "<your-key>"}` +
    " -- python -m jupiter_code.mcp_server";
}
