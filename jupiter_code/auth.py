"""API-key minting, hashing and verification.

Keys are high-entropy random tokens, prefixed with the id of the record they
belong to::

    jpm_<member_id>_<secret>     member key
    jpa_<org_id>_<secret>        org admin key

Embedding the id means verification is a single row lookup plus one bcrypt
compare, instead of a bcrypt compare against every member in the database.
"""

from __future__ import annotations

import secrets

from passlib.context import CryptContext

MEMBER_PREFIX = "jpm"
ADMIN_PREFIX = "jpa"

_SECRET_BYTES = 32

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")


class InvalidKey(ValueError):
    """Raised when a presented key is not parseable."""


def hash_key(key: str) -> str:
    return pwd_context.hash(key)


def verify_key(key: str, key_hash: str) -> bool:
    try:
        return pwd_context.verify(key, key_hash)
    except ValueError:
        return False


def mint_member_key(member_id: int) -> str:
    return f"{MEMBER_PREFIX}_{member_id}_{secrets.token_urlsafe(_SECRET_BYTES)}"


def mint_admin_key(org_id: int) -> str:
    return f"{ADMIN_PREFIX}_{org_id}_{secrets.token_urlsafe(_SECRET_BYTES)}"


def parse_key(key: str) -> tuple[str, int]:
    """Split a key into ``(kind, record_id)``.

    ``kind`` is ``"member"`` or ``"admin"``. Raises :class:`InvalidKey` for
    anything that does not look like a Jupiter key.
    """
    parts = (key or "").strip().split("_", 2)
    if len(parts) != 3:
        raise InvalidKey("malformed key")
    prefix, raw_id, secret = parts
    if not secret:
        raise InvalidKey("malformed key")
    if prefix == MEMBER_PREFIX:
        kind = "member"
    elif prefix == ADMIN_PREFIX:
        kind = "admin"
    else:
        raise InvalidKey("unknown key prefix")
    if not raw_id.isdigit():
        raise InvalidKey("malformed key id")
    return kind, int(raw_id)
