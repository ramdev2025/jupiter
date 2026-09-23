"""Semantic overlap detection.

The deterministic rule in :mod:`jupiter_code.server` catches two people on the
*same* path. This module catches the other half: two people on *different*
files whose work probably collides anyway - a schema and its migration, an
implementation and its test, a caller and its callee.

Three properties matter more than cleverness here:

* **Additive.** Hard conflicts stay authoritative and are never suppressed or
  re-ranked by the model. These findings are advisory only.
* **Cheap.** The dashboard polls every 3 seconds; the model is called only when
  the *set* of active claims actually changes, and the answer is cached.
* **Distrustful.** The model may only point at paths that really are claimed.
  Anything else in its reply - invented paths, wrong holders, extra fields -
  is discarded rather than rendered.

Only file paths, intents, holder names and the short notes people wrote are
sent to the gateway. No file contents ever leave the network.
"""

from __future__ import annotations

import datetime as dt
import hashlib
import json
import threading
from collections import OrderedDict
from typing import Any, Iterable

from .llm import LLMError, chat_json, config

CACHE_SIZE = 8
MAX_OVERLAPS = 8
MAX_CLAIMS = 60
REASON_LIMIT = 240
CONFIDENCES = ("high", "medium", "low")

SYSTEM_PROMPT = """\
You review a software team's in-progress file claims and spot pairs or small \
groups of DIFFERENT files, held by DIFFERENT people, whose work is likely to \
collide even though the paths differ.

Report a group only when there is a concrete, nameable reason, such as:
- an implementation and its test file
- a data model and a migration, schema, or fixture for it
- a caller and the function it calls
- two files that clearly implement two halves of one feature
- a config/route definition and the handler it wires up

Do NOT report:
- two claims on the same path (handled elsewhere, and reporting it is an error)
- files that merely sit in the same directory with no real relationship
- groups where every claim belongs to the same person
- speculation you cannot justify in one short sentence

Precision matters far more than recall. An empty list is the correct and \
expected answer when nothing clearly overlaps - do not invent findings.

Reply with strict JSON only, in exactly this shape:
{"overlaps": [{"paths": ["a", "b"], "reason": "one short sentence", \
"confidence": "high"}]}

"confidence" must be one of "high", "medium", "low". Every string in "paths" \
must be copied character-for-character from the input."""


def _now_iso() -> str:
    return dt.datetime.now(dt.timezone.utc).replace(microsecond=0, tzinfo=None).isoformat() + "Z"


# --------------------------------------------------------------------------- #
# fingerprinting
# --------------------------------------------------------------------------- #


def fingerprint(claims: Iterable[dict]) -> str:
    """Stable id for a set of claims - the cache key.

    Built from the fields the model actually sees, so a pure TTL refresh (which
    changes only timestamps) does not invalidate a perfectly good answer.
    """
    rows = sorted(
        (c["file_path"], c.get("intent") or "", str(c.get("member_id") or ""), c.get("note") or "")
        for c in claims
    )
    digest = hashlib.sha256(json.dumps(rows, sort_keys=True).encode("utf-8"))
    return digest.hexdigest()[:16]


# --------------------------------------------------------------------------- #
# validation
# --------------------------------------------------------------------------- #


def _validate(reply: dict[str, Any], claims: list[dict]) -> list[dict]:
    """Keep only findings that check out against the real claim set."""
    raw = reply.get("overlaps")
    if not isinstance(raw, list):
        return []

    by_path: dict[str, list[dict]] = {}
    for claim in claims:
        by_path.setdefault(claim["file_path"], []).append(claim)

    out: list[dict] = []
    seen: set[tuple[str, ...]] = set()

    for item in raw:
        if not isinstance(item, dict):
            continue
        paths = item.get("paths")
        if not isinstance(paths, list):
            continue

        # Every path must genuinely be claimed right now.
        clean = [p for p in dict.fromkeys(paths) if isinstance(p, str) and p in by_path]
        if len(clean) < 2:
            continue

        # Must span at least two people, judged from our data and not the model's.
        holders = {
            c["member"]
            for path in clean
            for c in by_path[path]
        }
        holder_ids = {
            c.get("member_id")
            for path in clean
            for c in by_path[path]
        }
        if len(holder_ids) < 2:
            continue

        reason = item.get("reason")
        reason = reason.strip()[:REASON_LIMIT] if isinstance(reason, str) else ""
        if not reason:
            continue

        confidence = item.get("confidence")
        confidence = confidence.strip().lower() if isinstance(confidence, str) else ""
        if confidence not in CONFIDENCES:
            confidence = "medium"

        # Deduplicate only on entries that fully passed: registering the key
        # earlier would let a malformed duplicate suppress a valid finding for
        # the same pair of files.
        key = tuple(sorted(clean))
        if key in seen:
            continue
        seen.add(key)

        out.append({
            "paths": clean,
            "members": sorted(holders),
            "reason": reason,
            "confidence": confidence,
        })
        if len(out) >= MAX_OVERLAPS:
            break

    return out


# --------------------------------------------------------------------------- #
# analysis
# --------------------------------------------------------------------------- #


def _prompt(claims: list[dict]) -> str:
    lines = ["Active file claims:"]
    for claim in claims[:MAX_CLAIMS]:
        note = f" - note: {claim['note']}" if claim.get("note") else ""
        lines.append(
            f"- {claim['file_path']} | {claim.get('intent') or 'editing'} "
            f"| held by {claim['member']}{note}"
        )
    lines.append("")
    lines.append("Which of these different files are likely to collide? JSON only.")
    return "\n".join(lines)


def analyze(claims: list[dict]) -> dict:
    """Call the gateway once and return a validated result dict."""
    reply = chat_json(SYSTEM_PROMPT, _prompt(claims))
    return {
        "status": "ready",
        "overlaps": _validate(reply, claims),
        "analyzed_at": _now_iso(),
        "model": config().model,
        "error": None,
    }


# --------------------------------------------------------------------------- #
# cache + single-flight refresh
# --------------------------------------------------------------------------- #

_lock = threading.Lock()
_cache: "OrderedDict[str, dict]" = OrderedDict()
_inflight: set[str] = set()


def _store(key: str, result: dict) -> None:
    with _lock:
        _cache[key] = result
        _cache.move_to_end(key)
        while len(_cache) > CACHE_SIZE:
            _cache.popitem(last=False)
        _inflight.discard(key)


def _worker(key: str, claims: list[dict]) -> None:
    try:
        _store(key, analyze(claims))
    except LLMError as exc:
        _store(key, {
            "status": "error",
            "overlaps": [],
            "analyzed_at": _now_iso(),
            "model": config().model,
            "error": str(exc),
        })
    except Exception as exc:  # pragma: no cover - never kill the thread silently
        _store(key, {
            "status": "error",
            "overlaps": [],
            "analyzed_at": _now_iso(),
            "model": config().model,
            "error": f"{exc.__class__.__name__}: {exc}",
        })


def get(claims: list[dict], *, refresh: bool = True) -> dict:
    """Return the analysis for ``claims``, kicking off a refresh if needed.

    Never blocks: an uncached claim set comes back as ``pending`` while a
    daemon thread fetches it, and the next poll picks up the result.
    """
    cfg = config()
    if not cfg.enabled:
        return {
            "status": "disabled", "overlaps": [], "analyzed_at": None,
            "model": None, "error": cfg.describe()["reason"],
        }

    # Nothing to compare - answer without spending a request.
    distinct_paths = {c["file_path"] for c in claims}
    distinct_members = {c.get("member_id") for c in claims}
    if len(distinct_paths) < 2 or len(distinct_members) < 2:
        return {
            "status": "ready", "overlaps": [], "analyzed_at": _now_iso(),
            "model": cfg.model, "error": None,
        }

    key = fingerprint(claims)
    with _lock:
        cached = _cache.get(key)
        if cached is not None:
            _cache.move_to_end(key)
            return cached
        already = key in _inflight
        if refresh and not already:
            _inflight.add(key)
            start = True
        else:
            start = False

    if start:
        threading.Thread(
            target=_worker, args=(key, list(claims)), daemon=True,
            name=f"jupiter-semantic-{key}",
        ).start()

    return {
        "status": "pending", "overlaps": [], "analyzed_at": None,
        "model": cfg.model, "error": None,
    }


def peek(claims: list[dict]) -> dict | None:
    """Cached analysis for these claims, or None. Never triggers a call."""
    if not config().enabled:
        return None
    with _lock:
        return _cache.get(fingerprint(claims))


def reset() -> None:
    """Drop the cache (tests, and after a config change)."""
    with _lock:
        _cache.clear()
        _inflight.clear()
