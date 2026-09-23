"""MCP server (stdio) exposing Jupiter to a local Claude Code instance.

Run one of these per developer machine; it forwards to the team's shared
Jupiter REST server.

    JUPITER_SERVER=http://host:7420 JUPITER_API_KEY=jpm_... python -m jupiter_code.mcp_server
"""

from __future__ import annotations

import asyncio
import os
from contextlib import asynccontextmanager
from typing import Any, Literal

import httpx
from mcp.server import MCPServer

from . import DEFAULT_PORT, __version__

DEFAULT_SERVER = f"http://127.0.0.1:{DEFAULT_PORT}"

INSTRUCTIONS = """\
Jupiter shows what other developers on this team have their Claude Code
instances working on right now, so two people don't edit the same file at once.

Suggested habits:
  - call jupiter_checkin once at the start of a coding session;
  - call jupiter_lock_file before editing a file, and heed a 'blocked' result;
  - call jupiter_unlock_file when done with that file;
  - call jupiter_who_is_working before picking up a new area of the codebase.
Claims are advisory and expire on their own, so they never wedge the team.\
"""


class JupiterError(RuntimeError):
    """A problem talking to the Jupiter server, phrased for Claude."""


class JupiterClient:
    """Thin REST client that keeps track of this process's session id."""

    def __init__(self, base_url: str, api_key: str, working_dir: str) -> None:
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.working_dir = working_dir
        self.session_id: int | None = None
        self.display_name: str | None = None
        self.slug: str | None = None
        self._http = httpx.AsyncClient(
            base_url=self.base_url,
            headers={"Authorization": f"Bearer {api_key}"},
            timeout=10.0,
        )

    async def aclose(self) -> None:
        await self._http.aclose()

    async def _request(self, method: str, path: str, **kwargs: Any) -> Any:
        try:
            response = await self._http.request(method, path, **kwargs)
        except httpx.HTTPError as exc:
            raise JupiterError(
                f"cannot reach the Jupiter server at {self.base_url} "
                f"({exc.__class__.__name__}). Is it running, and is JUPITER_SERVER correct?"
            ) from exc

        if response.status_code >= 400:
            detail: Any
            try:
                detail = response.json().get("detail", response.text)
            except ValueError:
                detail = response.text
            raise JupiterError(f"Jupiter server returned {response.status_code}: {detail}")
        if not response.content:
            return None
        return response.json()

    # -- sessions ---------------------------------------------------------- #

    async def check_in(self, working_dir: str | None = None) -> dict:
        data = await self._request(
            "POST", "/sessions", json={"working_dir": working_dir or self.working_dir}
        )
        self.session_id = data["session_id"]
        self.display_name = data["display_name"]
        self.slug = data["slug"]
        if working_dir:
            self.working_dir = working_dir
        return data

    async def ensure_session(self) -> int:
        if self.session_id is None:
            await self.check_in()
        assert self.session_id is not None
        return self.session_id

    async def end_session(self) -> None:
        if self.session_id is None:
            return
        try:
            await self._request("DELETE", f"/sessions/{self.session_id}")
        except JupiterError:
            pass  # shutting down anyway; the server expires the session on its own
        self.session_id = None

    async def _with_session(self, method: str, path: str, payload: dict) -> Any:
        """Call an endpoint that needs a session, re-checking in if ours expired."""
        payload = dict(payload, session_id=await self.ensure_session())
        try:
            return await self._request(method, path, json=payload)
        except JupiterError as exc:
            recoverable = "409" in str(exc) or "no such session" in str(exc)
            if not recoverable:
                raise
            self.session_id = None
            payload["session_id"] = await self.ensure_session()
            return await self._request(method, path, json=payload)

    # -- operations -------------------------------------------------------- #

    async def activity(self) -> dict:
        return await self._request("GET", "/activity")

    async def lock(self, file_path: str, intent: str, note: str | None) -> dict:
        return await self._with_session(
            "POST", "/locks", {"file_path": file_path, "intent": intent, "note": note}
        )

    async def unlock(self, file_path: str) -> dict:
        return await self._with_session("POST", "/locks/release", {"file_path": file_path})

    async def announce(self, message: str) -> dict:
        return await self._with_session("POST", "/announcements", {"message": message})

    async def semantic(self) -> dict:
        """Model-suggested overlaps. Best-effort: never fail a tool over it."""
        try:
            return await self._request("GET", "/semantic")
        except JupiterError:
            return {"status": "error", "overlaps": []}


# --------------------------------------------------------------------------- #
# rendering
# --------------------------------------------------------------------------- #


def render_overlaps(semantic: dict) -> list[str]:
    """Render advisory overlaps, clearly marked as suggestions not conflicts."""
    overlaps = semantic.get("overlaps") or []
    if not overlaps:
        return []
    lines = ["Possibly-related work on *different* files (advisory, AI-suggested):"]
    for item in overlaps:
        who = ", ".join(item.get("members") or []) or "someone"
        paths = " + ".join(item.get("paths") or [])
        lines.append(
            f"  - {paths} ({who}, {item.get('confidence', 'medium')} confidence)"
            f" - {item.get('reason', '')}"
        )
    return lines


def render_activity(activity: dict, client: JupiterClient) -> str:
    lines: list[str] = []
    members = activity.get("active_members") or []
    lines.append(
        f"Team: {activity.get('slug', '?')} - active teammates: "
        + (", ".join(members) or "none")
    )

    locks = activity.get("locks") or []
    if not locks:
        lines.append("No files are currently claimed by anyone.")
    else:
        lines.append("Files claimed right now:")
        for lock in locks:
            mine = " (you)" if lock.get("session_id") == client.session_id else ""
            note = f" - {lock['note']}" if lock.get("note") else ""
            lines.append(
                f"  - {lock['file_path']} | {lock['intent']} | {lock['member']}{mine}"
                f" | expires {lock['expires_at']}{note}"
            )

    announcements = activity.get("announcements") or []
    if announcements:
        lines.append("Recent announcements:")
        for item in announcements[-5:]:
            lines.append(f"  - {item['member']}: {item['message']} ({item['at']})")

    ttl = activity.get("lock_ttl_seconds")
    if ttl:
        lines.append(f"Claims auto-expire {ttl}s after they were last refreshed.")
    return "\n".join(lines)


# --------------------------------------------------------------------------- #
# tool bodies
# --------------------------------------------------------------------------- #


async def do_checkin(client: JupiterClient, working_dir: str | None) -> str:
    info = await client.check_in(working_dir)
    snapshot = await client.activity()
    header = (
        f"Checked in as '{info['display_name']}' in org '{info['slug']}' "
        f"(session {info['session_id']}, dir {info['working_dir'] or 'unset'})."
    )
    return header + "\n" + render_activity(snapshot, client)


async def do_lock(
    client: JupiterClient, file_path: str, intent: str, note: str | None
) -> str:
    file_path = (file_path or "").strip()
    if not file_path:
        return "Jupiter error: file_path is required"
    if intent not in ("editing", "reading"):
        return "Jupiter error: intent must be 'editing' or 'reading'"

    result = await client.lock(file_path, intent, note)

    # Advisory overlaps ride along on the same call - no extra round trip, and
    # they never change whether the claim is clear or blocked.
    related = result.get("related") or []
    hint = ""
    if related:
        rows = "\n".join(
            f"  - {', '.join(r['members'])} holds {' + '.join(r['paths'])}"
            f" ({r['confidence']} confidence) - {r['reason']}"
            for r in related
        )
        hint = (
            "\nHeads-up, related work on other files (AI-suggested, advisory):\n"
            f"{rows}"
        )

    if result["status"] == "blocked":
        holders = "\n".join(
            f"  - {c['member']} is {c['intent']} it"
            f" (since {c['locked_at']}, expires {c['expires_at']})"
            + (f" - {c['note']}" if c.get("note") else "")
            for c in result["conflicts"]
        )
        return (
            f"{result['message']}\n{holders}\n"
            "Your claim was still recorded. Prefer another file, or check with the user "
            f"before editing this one.{hint}"
        )
    return result["message"] + hint


async def do_unlock(client: JupiterClient, file_path: str) -> str:
    file_path = (file_path or "").strip()
    if not file_path:
        return "Jupiter error: file_path is required"
    result = await client.unlock(file_path)
    return result["message"]


async def do_who(client: JupiterClient) -> str:
    rendered = render_activity(await client.activity(), client)
    extra = render_overlaps(await client.semantic())
    return rendered + ("\n" + "\n".join(extra) if extra else "")


async def do_announce(client: JupiterClient, message: str) -> str:
    message = (message or "").strip()
    if not message:
        return "Jupiter error: message is required"
    result = await client.announce(message[:280])
    return f"Announced to the team: {result['message']}"


# --------------------------------------------------------------------------- #
# server wiring
# --------------------------------------------------------------------------- #


def build_server(client: JupiterClient) -> MCPServer:
    @asynccontextmanager
    async def lifespan(_server: MCPServer):
        try:
            yield {}
        finally:
            await client.end_session()
            await client.aclose()

    server = MCPServer(
        name="jupiter",
        version=__version__,
        instructions=INSTRUCTIONS,
        lifespan=lifespan,
    )

    @server.tool()
    async def jupiter_checkin(working_dir: str | None = None) -> str:
        """Register this Claude Code session with the team's Jupiter server and
        return a snapshot of what teammates are working on. Call once at the start
        of a coding session, before touching files.

        Args:
            working_dir: Absolute path of the repo/working directory for this session.
        """
        return await _guard(do_checkin(client, working_dir))

    @server.tool()
    async def jupiter_lock_file(
        file_path: str,
        intent: Literal["editing", "reading"] = "editing",
        note: str | None = None,
    ) -> str:
        """Declare an intent to edit (or read) a file so teammates' Claude Code
        instances can see it. Returns "clear" if nobody else holds the file, or a
        blocked warning naming the teammate who does. Call before editing a file.

        Args:
            file_path: Path to the file, ideally relative to the repo root.
            intent: "editing" conflicts with any other claim; "reading" only conflicts with editors.
            note: Optional one-line note about what you are changing.
        """
        return await _guard(do_lock(client, file_path, intent, note))

    @server.tool()
    async def jupiter_unlock_file(file_path: str) -> str:
        """Release your claim on a file once you are done editing it.

        Args:
            file_path: The same path you passed to jupiter_lock_file.
        """
        return await _guard(do_unlock(client, file_path))

    @server.tool()
    async def jupiter_who_is_working() -> str:
        """List every file currently claimed across the team, who holds it, and when
        the claim expires. Use before starting work in a new area of the codebase.
        """
        return await _guard(do_who(client))

    @server.tool()
    async def jupiter_announce(message: str) -> str:
        """Broadcast a short status message to teammates, e.g. "refactoring the auth
        module for the next hour".

        Args:
            message: The status message (truncated to 280 characters).
        """
        return await _guard(do_announce(client, message))

    return server


async def _guard(coro) -> str:
    """Turn transport/HTTP failures into a readable tool result."""
    try:
        return await coro
    except JupiterError as exc:
        return f"Jupiter error: {exc}"


def make_client() -> JupiterClient:
    api_key = os.environ.get("JUPITER_API_KEY", "").strip()
    if not api_key:
        raise SystemExit(
            "JUPITER_API_KEY is not set. Join an org to get a member key:\n"
            "  curl -X POST <server>/orgs/<slug>/join -H 'Content-Type: application/json' "
            '-d \'{"display_name": "Your Name"}\'\n'
            "then set JUPITER_API_KEY in your MCP server config."
        )
    base_url = os.environ.get("JUPITER_SERVER", DEFAULT_SERVER).strip() or DEFAULT_SERVER
    working_dir = os.environ.get("JUPITER_WORKING_DIR", "").strip() or os.getcwd()
    return JupiterClient(base_url, api_key, working_dir)


async def amain() -> None:
    await build_server(make_client()).run_stdio_async()


def main() -> None:
    try:
        asyncio.run(amain())
    except KeyboardInterrupt:  # pragma: no cover - normal shutdown path
        pass


if __name__ == "__main__":
    main()
