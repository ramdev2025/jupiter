"""SQLAlchemy ORM models.

All timestamps are stored as naive datetimes in UTC - SQLite does not keep
timezone information, so normalising on the way in avoids mixed-awareness
comparisons later. Use :func:`utcnow` everywhere instead of ``datetime.now``.
"""

from __future__ import annotations

import datetime as dt

from sqlalchemy import DateTime, ForeignKey, Index, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


def utcnow() -> dt.datetime:
    """Current UTC time as a naive datetime."""
    return dt.datetime.now(dt.timezone.utc).replace(tzinfo=None)


def isoformat(value: dt.datetime | None) -> str | None:
    """Render a stored (naive, UTC) timestamp as an ISO-8601 instant."""
    if value is None:
        return None
    return value.replace(microsecond=0).isoformat() + "Z"


class Base(DeclarativeBase):
    pass


class Organization(Base):
    __tablename__ = "organizations"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    slug: Mapped[str] = mapped_column(String(120), nullable=False, unique=True, index=True)
    admin_key_hash: Mapped[str] = mapped_column(String(255), nullable=False)
    created_at: Mapped[dt.datetime] = mapped_column(DateTime, default=utcnow, nullable=False)

    members: Mapped[list["Member"]] = relationship(
        back_populates="organization", cascade="all, delete-orphan"
    )


class Member(Base):
    __tablename__ = "members"
    __table_args__ = (UniqueConstraint("org_id", "display_name", name="uq_member_name_per_org"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    org_id: Mapped[int] = mapped_column(
        ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True
    )
    display_name: Mapped[str] = mapped_column(String(120), nullable=False)
    api_key_hash: Mapped[str] = mapped_column(String(255), nullable=False)
    joined_at: Mapped[dt.datetime] = mapped_column(DateTime, default=utcnow, nullable=False)

    organization: Mapped[Organization] = relationship(back_populates="members")
    sessions: Mapped[list["ClientSession"]] = relationship(
        back_populates="member", cascade="all, delete-orphan"
    )


class ClientSession(Base):
    """One running Claude Code instance."""

    __tablename__ = "sessions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    member_id: Mapped[int] = mapped_column(
        ForeignKey("members.id", ondelete="CASCADE"), nullable=False, index=True
    )
    org_id: Mapped[int] = mapped_column(
        ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True
    )
    working_dir: Mapped[str | None] = mapped_column(Text, nullable=True)
    started_at: Mapped[dt.datetime] = mapped_column(DateTime, default=utcnow, nullable=False)
    last_seen: Mapped[dt.datetime] = mapped_column(DateTime, default=utcnow, nullable=False)
    ended_at: Mapped[dt.datetime | None] = mapped_column(DateTime, nullable=True)

    member: Mapped[Member] = relationship(back_populates="sessions")
    locks: Mapped[list["FileLock"]] = relationship(
        back_populates="session", cascade="all, delete-orphan"
    )


class FileLock(Base):
    """A declared intent to read or edit one file.

    Rows are kept after release (``released_at``) so recent activity stays
    inspectable; "active" always means ``released_at IS NULL`` *and* not yet
    past the TTL.
    """

    __tablename__ = "file_locks"
    __table_args__ = (Index("ix_file_locks_org_path", "org_id", "file_path"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    session_id: Mapped[int] = mapped_column(
        ForeignKey("sessions.id", ondelete="CASCADE"), nullable=False, index=True
    )
    org_id: Mapped[int] = mapped_column(
        ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True
    )
    file_path: Mapped[str] = mapped_column(Text, nullable=False)
    intent: Mapped[str] = mapped_column(String(16), nullable=False, default="editing")
    locked_at: Mapped[dt.datetime] = mapped_column(DateTime, default=utcnow, nullable=False)
    refreshed_at: Mapped[dt.datetime] = mapped_column(DateTime, default=utcnow, nullable=False)
    released_at: Mapped[dt.datetime | None] = mapped_column(DateTime, nullable=True)
    note: Mapped[str | None] = mapped_column(Text, nullable=True)

    session: Mapped[ClientSession] = relationship(back_populates="locks")


class Announcement(Base):
    """Short status message broadcast to the rest of the org."""

    __tablename__ = "announcements"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    org_id: Mapped[int] = mapped_column(
        ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True
    )
    member_id: Mapped[int] = mapped_column(
        ForeignKey("members.id", ondelete="CASCADE"), nullable=False
    )
    message: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[dt.datetime] = mapped_column(DateTime, default=utcnow, nullable=False)
