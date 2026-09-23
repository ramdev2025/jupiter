"""Tiny ``.env`` reader, shared by the database and LLM configuration.

Deliberately not a dependency: Jupiter needs a handful of variables, and a
forgiving 40-line parser beats adding python-dotenv for it.

Forgiving in two specific ways, both driven by real files seen in the wild:

* a name written with spaces (``API KEY = ...``) is normalised to ``API_KEY``
  rather than silently skipped;
* obvious placeholder values (``<your-key-here>``, ``sk-xxxx``) are ignored, so
  a half-filled template cannot shadow a real value set elsewhere.

Real environment variables always win over file contents.
"""

from __future__ import annotations

import os
import pathlib
import re

PLACEHOLDER = re.compile(r"<[^>]*>|your-key-here|replace-me|xxxx", re.I)
_NAME = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")

_loaded = False


def candidates() -> list[pathlib.Path]:
    """Where a ``.env`` may live, nearest-first."""
    here = pathlib.Path(__file__).resolve().parent
    return [
        here / ".env",            # jupiter_code/.env
        here.parent / ".env",     # repo root
        pathlib.Path.cwd() / ".env",
    ]


def load_dotenv(force: bool = False) -> list[str]:
    """Merge ``.env`` files into ``os.environ`` without overriding real vars.

    Idempotent: only the first call does the work unless ``force`` is set.
    Returns the paths that were read.
    """
    global _loaded
    if _loaded and not force:
        return []
    _loaded = True

    read: list[str] = []
    for path in candidates():
        if not path.is_file():
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except OSError:
            continue
        read.append(str(path))
        for line in text.splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            name, _, value = line.partition("=")
            name = name.strip().replace(" ", "_")
            if not _NAME.fullmatch(name):
                continue
            value = value.strip().strip('"').strip("'")
            if not value or PLACEHOLDER.search(value):
                continue
            os.environ.setdefault(name, value)
    return read


def first_env(names: tuple[str, ...]) -> str | None:
    """First of ``names`` set to a real (non-placeholder) value."""
    for name in names:
        value = (os.environ.get(name) or "").strip()
        if value and not PLACEHOLDER.search(value):
            return value
    return None
