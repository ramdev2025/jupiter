"""FastAPI application: the shared coordination server.

One instance of this runs somewhere the whole team can reach (or on localhost
for single-machine testing). Each developer's MCP server talks to it over
HTTP using a member API key.
"""

from __future__ import annotations

import datetime as dt
import os
import pathlib
import re
from contextlib import asynccontextmanager
from typing import Literal

from fastapi import Depends, FastAPI, Header, HTTPException, Path, Query, status
from fastapi.responses import RedirectResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session as OrmSession
from sqlalchemy.orm import selectinload

from . import __version__, llm, semantic
from .auth import (
    InvalidKey,
    hash_key,
    mint_admin_key,
    mint_member_key,
    parse_key,
    verify_key,
)
from .database import get_session, init_db
from .models import (
    Announcement,
    ClientSession,
    FileLock,
    Member,
    Organization,
    isoformat,
    utcnow,
)

# --------------------------------------------------------------------------- #
# configuration
# --------------------------------------------------------------------------- #

DEFAULT_LOCK_TTL = 300


def lock_ttl() -> int:
    """Seconds an unrefreshed lock stays active (``JUPITER_LOCK_TTL``)."""
    try:
        value = int(os.environ.get("JUPITER_LOCK_TTL", DEFAULT_LOCK_TTL))
    except ValueError:
        return DEFAULT_LOCK_TTL
    return max(value, 5)


def session_ttl() -> int:
    """Seconds without a heartbeat before a session counts as gone."""
    return max(2 * lock_ttl(), 600)


ANNOUNCEMENT_WINDOW = 3600
ANNOUNCEMENT_LIMIT = 20

# --------------------------------------------------------------------------- #
# request / response schemas
# --------------------------------------------------------------------------- #

Intent = Literal["editing", "reading"]

_SLUG_RE = re.compile(r"[^a-z0-9]+")


def slugify(value: str) -> str:
    slug = _SLUG_RE.sub("-", value.strip().lower()).strip("-")
    return slug


def normalize_path(file_path: str) -> str:
    """Canonicalise a path for comparison across platforms.

    Separators are unified to ``/`` and redundant slashes dropped. Comparison
    stays case-sensitive: on Linux ``src/App.py`` and ``src/app.py`` really are
    two different files.
    """
    cleaned = (file_path or "").strip().replace("\\", "/")
    while "//" in cleaned:
        cleaned = cleaned.replace("//", "/")
    cleaned = cleaned.rstrip("/")
    if not cleaned:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "file_path must not be empty")
    return cleaned


class OrgCreate(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    slug: str | None = Field(default=None, max_length=120)


class OrgCreated(BaseModel):
    org: str
    slug: str
    admin_api_key: str
    lock_ttl_seconds: int


class JoinRequest(BaseModel):
    display_name: str = Field(min_length=1, max_length=120)


class MemberCreated(BaseModel):
    member_id: int
    display_name: str
    slug: str
    api_key: str


class MemberOut(BaseModel):
    member_id: int
    display_name: str
    joined_at: str | None
    active_sessions: int
    last_seen: str | None


class SessionCreate(BaseModel):
    working_dir: str | None = None


class SessionOut(BaseModel):
    session_id: int
    member_id: int
    display_name: str
    slug: str
    working_dir: str | None
    started_at: str | None
    last_seen: str | None


class LockRequest(BaseModel):
    session_id: int
    file_path: str = Field(min_length=1)
    intent: Intent = "editing"
    note: str | None = Field(default=None, max_length=280)


class LockOut(BaseModel):
    file_path: str
    intent: str
    member: str
    member_id: int
    session_id: int
    working_dir: str | None
    locked_at: str | None
    expires_at: str | None
    note: str | None


class RelatedOut(BaseModel):
    """An advisory, model-suggested overlap with a *different* file."""

    paths: list[str]
    members: list[str]
    reason: str
    confidence: Literal["high", "medium", "low"]


class LockResponse(BaseModel):
    status: Literal["clear", "blocked"]
    file_path: str
    intent: str
    expires_at: str | None
    conflicts: list[LockOut]
    message: str
    # Never affects `status`: a hard conflict is the only thing that blocks.
    related: list[RelatedOut] = []


class UnlockRequest(BaseModel):
    session_id: int
    file_path: str = Field(min_length=1)


class UnlockResponse(BaseModel):
    file_path: str
    released: int
    message: str


class AnnounceRequest(BaseModel):
    session_id: int | None = None
    message: str = Field(min_length=1, max_length=280)


class AnnouncementOut(BaseModel):
    member: str
    message: str
    at: str | None


class ActivityOut(BaseModel):
    slug: str
    now: str | None
    lock_ttl_seconds: int
    locks: list[LockOut]
    active_members: list[str]
    announcements: list[AnnouncementOut]


class LLMStatus(BaseModel):
    enabled: bool
    model: str | None
    base_url: str | None
    reason: str | None


class SemanticOut(BaseModel):
    status: Literal["ready", "pending", "disabled", "error"]
    overlaps: list[RelatedOut]
    analyzed_at: str | None
    model: str | None
    error: str | None
    llm: LLMStatus


# --------------------------------------------------------------------------- #
# auth
# --------------------------------------------------------------------------- #


class Principal(BaseModel):
    kind: Literal["member", "admin"]
    org_id: int
    slug: str
    member_id: int | None = None
    display_name: str | None = None


def _bearer(authorization: str | None, x_api_key: str | None) -> str:
    if x_api_key:
        return x_api_key.strip()
    if authorization:
        scheme, _, token = authorization.partition(" ")
        if scheme.lower() == "bearer" and token.strip():
            return token.strip()
        if not token:
            return authorization.strip()
    raise HTTPException(
        status.HTTP_401_UNAUTHORIZED,
        "missing API key (send 'Authorization: Bearer <key>' or 'X-API-Key: <key>')",
    )


def current_principal(
    authorization: str | None = Header(default=None),
    x_api_key: str | None = Header(default=None, alias="X-API-Key"),
    db: OrmSession = Depends(get_session),
) -> Principal:
    key = _bearer(authorization, x_api_key)
    try:
        kind, record_id = parse_key(key)
    except InvalidKey as exc:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, f"invalid API key: {exc}") from exc

    if kind == "member":
        member = db.get(Member, record_id)
        if member is None or not verify_key(key, member.api_key_hash):
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, "invalid API key")
        org = db.get(Organization, member.org_id)
        return Principal(
            kind="member",
            org_id=member.org_id,
            slug=org.slug if org else "",
            member_id=member.id,
            display_name=member.display_name,
        )

    org = db.get(Organization, record_id)
    if org is None or not verify_key(key, org.admin_key_hash):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "invalid API key")
    return Principal(kind="admin", org_id=org.id, slug=org.slug)


def require_member(principal: Principal = Depends(current_principal)) -> Principal:
    if principal.kind != "member" or principal.member_id is None:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "this endpoint requires a member API key")
    return principal


# --------------------------------------------------------------------------- #
# helpers
# --------------------------------------------------------------------------- #


def _get_org(db: OrmSession, slug: str) -> Organization:
    org = db.scalar(select(Organization).where(Organization.slug == slug))
    if org is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"no such org: {slug}")
    return org


def _require_org_access(principal: Principal, org: Organization) -> None:
    if principal.org_id != org.id:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "key does not belong to this org")


def _expire_stale(db: OrmSession, org_id: int) -> None:
    """Release locks past their TTL and close sessions that stopped reporting."""
    now = utcnow()
    lock_cutoff = now - dt.timedelta(seconds=lock_ttl())
    session_cutoff = now - dt.timedelta(seconds=session_ttl())

    stale_sessions = db.scalars(
        select(ClientSession).where(
            ClientSession.org_id == org_id,
            ClientSession.ended_at.is_(None),
            ClientSession.last_seen < session_cutoff,
        )
    ).all()
    for client_session in stale_sessions:
        client_session.ended_at = now

    # The loop below reads lock.session on every row. Without eager loading
    # that is one query per lock, which costs nothing against a local SQLite
    # file and several seconds against a network database.
    open_locks = db.scalars(
        select(FileLock)
        .where(FileLock.org_id == org_id, FileLock.released_at.is_(None))
        .options(selectinload(FileLock.session))
    ).all()
    for lock in open_locks:
        if lock.refreshed_at < lock_cutoff or lock.session.ended_at is not None:
            lock.released_at = now

    if stale_sessions or open_locks:
        db.commit()


def _active_locks(db: OrmSession, org_id: int) -> list[FileLock]:
    """Active claims, with holder identity already loaded.

    Every caller renders ``lock.session.member.display_name``; eager-loading
    that chain turns 2 queries per lock into 2 queries total.
    """
    return list(
        db.scalars(
            select(FileLock)
            .where(FileLock.org_id == org_id, FileLock.released_at.is_(None))
            .order_by(FileLock.locked_at)
            .options(selectinload(FileLock.session).selectinload(ClientSession.member))
        ).all()
    )


def _lock_out(lock: FileLock) -> LockOut:
    expires_at = lock.refreshed_at + dt.timedelta(seconds=lock_ttl())
    return LockOut(
        file_path=lock.file_path,
        intent=lock.intent,
        member=lock.session.member.display_name,
        member_id=lock.session.member_id,
        session_id=lock.session_id,
        working_dir=lock.session.working_dir,
        locked_at=isoformat(lock.locked_at),
        expires_at=isoformat(expires_at),
        note=lock.note,
    )


def _claims_for_analysis(locks: list[FileLock]) -> list[dict]:
    """The only shape sent to the LLM: paths, intents, holders, notes.

    No file contents, and nothing the team cannot already see on the dashboard.
    """
    return [
        {
            "file_path": lock.file_path,
            "intent": lock.intent,
            "member": lock.session.member.display_name,
            "member_id": lock.session.member_id,
            "note": lock.note,
        }
        for lock in locks
    ]


def _recent_announcements(db: OrmSession, org_id: int) -> list[AnnouncementOut]:
    cutoff = utcnow() - dt.timedelta(seconds=ANNOUNCEMENT_WINDOW)
    rows = db.scalars(
        select(Announcement)
        .where(Announcement.org_id == org_id, Announcement.created_at >= cutoff)
        .order_by(Announcement.created_at.desc())
        .limit(ANNOUNCEMENT_LIMIT)
    ).all()
    if not rows:
        return []

    # One lookup for every author, rather than one per announcement.
    names = {
        member.id: member.display_name
        for member in db.scalars(
            select(Member).where(Member.id.in_({row.member_id for row in rows}))
        ).all()
    }
    return [
        AnnouncementOut(
            member=names.get(row.member_id, "unknown"),
            message=row.message,
            at=isoformat(row.created_at),
        )
        for row in reversed(rows)
    ]


def _activity(db: OrmSession, org: Organization) -> ActivityOut:
    _expire_stale(db, org.id)
    locks = _active_locks(db, org.id)
    active_members = sorted(
        {
            client_session.member.display_name
            for client_session in db.scalars(
                select(ClientSession)
                .where(ClientSession.org_id == org.id, ClientSession.ended_at.is_(None))
                .options(selectinload(ClientSession.member))
            ).all()
        }
    )
    return ActivityOut(
        slug=org.slug,
        now=isoformat(utcnow()),
        lock_ttl_seconds=lock_ttl(),
        locks=[_lock_out(lock) for lock in locks],
        active_members=active_members,
        announcements=_recent_announcements(db, org.id),
    )


def _owned_session(db: OrmSession, principal: Principal, session_id: int) -> ClientSession:
    client_session = db.get(ClientSession, session_id)
    if client_session is None or client_session.member_id != principal.member_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"no such session: {session_id}")
    if client_session.ended_at is not None:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            f"session {session_id} has ended; check in again to get a new one",
        )
    return client_session


# --------------------------------------------------------------------------- #
# app
# --------------------------------------------------------------------------- #

@asynccontextmanager
async def lifespan(_app: FastAPI):
    init_db()
    yield


app = FastAPI(
    title="Jupiter",
    version=__version__,
    summary="Team coding awareness: who on the team is touching which files right now.",
    lifespan=lifespan,
)


@app.get("/healthz")
def healthz() -> dict:
    return {"status": "ok", "version": __version__, "lock_ttl_seconds": lock_ttl()}


@app.post("/orgs", response_model=OrgCreated, status_code=status.HTTP_201_CREATED)
def create_org(payload: OrgCreate, db: OrmSession = Depends(get_session)) -> OrgCreated:
    slug = slugify(payload.slug or payload.name)
    if not slug:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "could not derive a slug; pass an explicit 'slug'",
        )
    if db.scalar(select(Organization).where(Organization.slug == slug)):
        raise HTTPException(status.HTTP_409_CONFLICT, f"org '{slug}' already exists")

    org = Organization(name=payload.name.strip(), slug=slug, admin_key_hash="")
    db.add(org)
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(status.HTTP_409_CONFLICT, f"org '{slug}' already exists") from exc

    admin_key = mint_admin_key(org.id)
    org.admin_key_hash = hash_key(admin_key)
    db.commit()

    return OrgCreated(
        org=org.name, slug=org.slug, admin_api_key=admin_key, lock_ttl_seconds=lock_ttl()
    )


@app.post(
    "/orgs/{slug}/join", response_model=MemberCreated, status_code=status.HTTP_201_CREATED
)
def join_org(
    payload: JoinRequest,
    slug: str = Path(...),
    db: OrmSession = Depends(get_session),
) -> MemberCreated:
    org = _get_org(db, slug)
    display_name = payload.display_name.strip()
    if db.scalar(
        select(Member).where(Member.org_id == org.id, Member.display_name == display_name)
    ):
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            f"'{display_name}' is already a member of {slug}; reuse that member's API key",
        )

    member = Member(org_id=org.id, display_name=display_name, api_key_hash="")
    db.add(member)
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(
            status.HTTP_409_CONFLICT, f"'{display_name}' is already a member of {slug}"
        ) from exc

    api_key = mint_member_key(member.id)
    member.api_key_hash = hash_key(api_key)
    db.commit()

    return MemberCreated(
        member_id=member.id, display_name=member.display_name, slug=org.slug, api_key=api_key
    )


@app.get("/orgs/{slug}/members", response_model=list[MemberOut])
def list_members(
    slug: str = Path(...),
    principal: Principal = Depends(current_principal),
    db: OrmSession = Depends(get_session),
) -> list[MemberOut]:
    org = _get_org(db, slug)
    _require_org_access(principal, org)
    _expire_stale(db, org.id)

    # Each row below reads member.sessions twice; load them in one extra query.
    members = db.scalars(
        select(Member)
        .where(Member.org_id == org.id)
        .order_by(Member.display_name)
        .options(selectinload(Member.sessions))
    ).all()
    out: list[MemberOut] = []
    for member in members:
        live = [s for s in member.sessions if s.ended_at is None]
        out.append(
            MemberOut(
                member_id=member.id,
                display_name=member.display_name,
                joined_at=isoformat(member.joined_at),
                active_sessions=len(live),
                last_seen=isoformat(max((s.last_seen for s in member.sessions), default=None)),
            )
        )
    return out


@app.get("/orgs/{slug}/activity", response_model=ActivityOut)
def org_activity(
    slug: str = Path(...),
    principal: Principal = Depends(current_principal),
    db: OrmSession = Depends(get_session),
) -> ActivityOut:
    org = _get_org(db, slug)
    _require_org_access(principal, org)
    return _activity(db, org)


@app.post("/sessions", response_model=SessionOut, status_code=status.HTTP_201_CREATED)
def create_client_session(
    payload: SessionCreate,
    principal: Principal = Depends(require_member),
    db: OrmSession = Depends(get_session),
) -> SessionOut:
    client_session = ClientSession(
        member_id=principal.member_id,
        org_id=principal.org_id,
        working_dir=(payload.working_dir or "").strip() or None,
    )
    db.add(client_session)
    db.commit()
    return SessionOut(
        session_id=client_session.id,
        member_id=client_session.member_id,
        display_name=principal.display_name or "",
        slug=principal.slug,
        working_dir=client_session.working_dir,
        started_at=isoformat(client_session.started_at),
        last_seen=isoformat(client_session.last_seen),
    )


@app.post("/sessions/{session_id}/heartbeat", response_model=SessionOut)
def heartbeat(
    session_id: int = Path(...),
    principal: Principal = Depends(require_member),
    db: OrmSession = Depends(get_session),
) -> SessionOut:
    client_session = _owned_session(db, principal, session_id)
    client_session.last_seen = utcnow()
    db.commit()
    return SessionOut(
        session_id=client_session.id,
        member_id=client_session.member_id,
        display_name=principal.display_name or "",
        slug=principal.slug,
        working_dir=client_session.working_dir,
        started_at=isoformat(client_session.started_at),
        last_seen=isoformat(client_session.last_seen),
    )


@app.delete("/sessions/{session_id}")
def end_client_session(
    session_id: int = Path(...),
    principal: Principal = Depends(require_member),
    db: OrmSession = Depends(get_session),
) -> dict:
    client_session = db.get(ClientSession, session_id)
    if client_session is None or client_session.member_id != principal.member_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"no such session: {session_id}")

    now = utcnow()
    released = 0
    if client_session.ended_at is None:
        client_session.ended_at = now
    for lock in client_session.locks:
        if lock.released_at is None:
            lock.released_at = now
            released += 1
    db.commit()
    return {"session_id": session_id, "ended": True, "locks_released": released}


@app.post("/locks", response_model=LockResponse)
def acquire_lock(
    payload: LockRequest,
    principal: Principal = Depends(require_member),
    db: OrmSession = Depends(get_session),
) -> LockResponse:
    client_session = _owned_session(db, principal, payload.session_id)
    file_path = normalize_path(payload.file_path)
    now = utcnow()
    client_session.last_seen = now

    _expire_stale(db, principal.org_id)

    # Locks are advisory: we always record the intent, then report who else is
    # already there so Claude can decide whether to hold off.
    existing = [
        lock
        for lock in _active_locks(db, principal.org_id)
        if lock.file_path == file_path
    ]
    mine = next((lock for lock in existing if lock.session_id == client_session.id), None)
    conflicts = [
        lock
        for lock in existing
        if lock.session.member_id != principal.member_id
        and "editing" in (lock.intent, payload.intent)
    ]

    if mine is not None:
        mine.intent = payload.intent
        mine.refreshed_at = now
        mine.note = payload.note or mine.note
        lock = mine
    else:
        lock = FileLock(
            session_id=client_session.id,
            org_id=principal.org_id,
            file_path=file_path,
            intent=payload.intent,
            locked_at=now,
            refreshed_at=now,
            note=payload.note,
        )
        db.add(lock)
    db.commit()

    expires_at = isoformat(lock.refreshed_at + dt.timedelta(seconds=lock_ttl()))
    related = _related_for(db, principal, file_path)

    if conflicts:
        holders = ", ".join(
            f"{c.session.member.display_name} ({c.intent})" for c in conflicts
        )
        message = (
            f"⚠ blocked by {holders} on {file_path} - coordinate before editing, "
            f"or pick another file"
        )
        return LockResponse(
            status="blocked",
            file_path=file_path,
            intent=payload.intent,
            expires_at=expires_at,
            conflicts=[_lock_out(c) for c in conflicts],
            message=message,
            related=related,
        )

    return LockResponse(
        status="clear",
        file_path=file_path,
        intent=payload.intent,
        expires_at=expires_at,
        conflicts=[],
        message=f"clear - you hold {file_path} ({payload.intent}) until {expires_at}",
        related=related,
    )


def _related_for(
    db: OrmSession, principal: Principal, file_path: str
) -> list[RelatedOut]:
    """Cached overlaps touching ``file_path``, held by someone other than us.

    Reads the cache only - claiming a file must never wait on the gateway, so a
    cold cache simply yields nothing and the dashboard picks it up a moment
    later via ``/semantic``.
    """
    cached = semantic.peek(_claims_for_analysis(_active_locks(db, principal.org_id)))
    if not cached:
        return []

    out: list[RelatedOut] = []
    for overlap in cached.get("overlaps", []):
        if file_path not in overlap["paths"]:
            continue
        others = [p for p in overlap["paths"] if p != file_path]
        holders = [m for m in overlap["members"] if m != principal.display_name]
        if others and holders:
            out.append(RelatedOut(
                paths=others,
                members=holders,
                reason=overlap["reason"],
                confidence=overlap["confidence"],
            ))
    return out


@app.post("/locks/release", response_model=UnlockResponse)
def release_lock(
    payload: UnlockRequest,
    principal: Principal = Depends(require_member),
    db: OrmSession = Depends(get_session),
) -> UnlockResponse:
    client_session = _owned_session(db, principal, payload.session_id)
    file_path = normalize_path(payload.file_path)
    now = utcnow()
    client_session.last_seen = now

    locks = db.scalars(
        select(FileLock).where(
            FileLock.session_id == client_session.id,
            FileLock.file_path == file_path,
            FileLock.released_at.is_(None),
        )
    ).all()
    for lock in locks:
        lock.released_at = now
    db.commit()

    if not locks:
        return UnlockResponse(
            file_path=file_path,
            released=0,
            message=f"no active lock held on {file_path} (already released or expired)",
        )
    return UnlockResponse(
        file_path=file_path, released=len(locks), message=f"released {file_path}"
    )


@app.post("/announcements", status_code=status.HTTP_201_CREATED)
def announce(
    payload: AnnounceRequest,
    principal: Principal = Depends(require_member),
    db: OrmSession = Depends(get_session),
) -> dict:
    if payload.session_id is not None:
        client_session = _owned_session(db, principal, payload.session_id)
        client_session.last_seen = utcnow()

    row = Announcement(
        org_id=principal.org_id,
        member_id=principal.member_id,
        message=payload.message.strip(),
    )
    db.add(row)
    db.commit()
    return {
        "announced": True,
        "member": principal.display_name,
        "message": row.message,
        "at": isoformat(row.created_at),
    }


@app.get("/announcements", response_model=list[AnnouncementOut])
def list_announcements(
    limit: int = Query(default=ANNOUNCEMENT_LIMIT, ge=1, le=100),
    principal: Principal = Depends(current_principal),
    db: OrmSession = Depends(get_session),
) -> list[AnnouncementOut]:
    return _recent_announcements(db, principal.org_id)[-limit:]


@app.get("/activity", response_model=ActivityOut)
def my_activity(
    principal: Principal = Depends(current_principal),
    db: OrmSession = Depends(get_session),
) -> ActivityOut:
    """Activity for the org the presented key belongs to."""
    org = db.get(Organization, principal.org_id)
    if org is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "org no longer exists")
    return _activity(db, org)


@app.get("/semantic", response_model=SemanticOut)
def semantic_overlaps(
    principal: Principal = Depends(current_principal),
    db: OrmSession = Depends(get_session),
) -> SemanticOut:
    """Model-suggested overlaps between *different* claimed files.

    Kept off ``/activity`` deliberately: that endpoint is polled every few
    seconds by every client and must stay fast. This one answers from cache and
    only re-analyses when the set of active claims actually changes, so it is
    safe to poll too.
    """
    org = db.get(Organization, principal.org_id)
    if org is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "org no longer exists")
    _expire_stale(db, org.id)
    result = semantic.get(_claims_for_analysis(_active_locks(db, org.id)))
    return SemanticOut(**result, llm=LLMStatus(**llm.config().describe()))


# --------------------------------------------------------------------------- #
# dashboard
#
# The browser UI is served from this same app on purpose: being same-origin,
# it needs no CORS allowance, which keeps the server's exposure unchanged.
# Mounted last so every API route above still matches first and a mistyped
# API path keeps returning a JSON 404 rather than the HTML page.
# --------------------------------------------------------------------------- #

WEB_DIR = pathlib.Path(__file__).parent / "web"


@app.get("/", include_in_schema=False)
def dashboard_root() -> RedirectResponse:
    """Send the bare server URL to the dashboard."""
    return RedirectResponse(url="/ui/", status_code=status.HTTP_307_TEMPORARY_REDIRECT)


if WEB_DIR.is_dir():  # pragma: no cover - static asset wiring
    app.mount("/ui", StaticFiles(directory=WEB_DIR, html=True), name="ui")
