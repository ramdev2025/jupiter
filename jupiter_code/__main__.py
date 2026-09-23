"""``python -m jupiter_code`` / ``jupiter-server`` - start the coordination server."""

from __future__ import annotations

import os

import click
import uvicorn

from . import DEFAULT_PORT, __version__


@click.command(context_settings={"help_option_names": ["-h", "--help"]})
@click.option("--host", default="0.0.0.0", show_default=True, help="Interface to bind.")
@click.option("--port", default=DEFAULT_PORT, show_default=True, type=int, help="Port to bind.")
@click.option(
    "--db",
    default=None,
    help="SQLite file path (default: ~/.jupiter/jupiter.db, or $JUPITER_DB).",
)
@click.option(
    "--lock-ttl",
    default=None,
    type=int,
    help="Seconds a file lock survives without a refresh (default 300, or $JUPITER_LOCK_TTL).",
)
@click.option("--reload", is_flag=True, help="Auto-reload on code changes (development).")
@click.option("--log-level", default="info", show_default=True)
@click.version_option(__version__, prog_name="jupiter")
def main(
    host: str, port: int, db: str | None, lock_ttl: int | None, reload: bool, log_level: str
) -> None:
    """Run the Jupiter REST server that the team's MCP clients talk to."""
    # These must land in the environment before jupiter.server is imported:
    # the SQLite engine is built at import time.
    if db:
        os.environ["JUPITER_DB"] = db
    if lock_ttl is not None:
        os.environ["JUPITER_LOCK_TTL"] = str(lock_ttl)

    from .database import database_url
    from .llm import config as llm_config

    llm = llm_config()

    click.echo(f"Jupiter {__version__}")
    click.echo(f"  database : {database_url()}")
    click.echo(f"  lock TTL : {os.environ.get('JUPITER_LOCK_TTL', '300')}s")
    click.echo(
        "  semantic : "
        + (f"{llm.model} via {llm.base_url}" if llm.enabled
           else f"off ({llm.describe()['reason']})")
    )
    click.echo(f"  listening: http://{host}:{port}  (docs at /docs)")

    uvicorn.run(
        "jupiter_code.server:app",
        host=host,
        port=port,
        reload=reload,
        log_level=log_level,
    )


if __name__ == "__main__":
    main()
