# Jupiter server image, for Cloudflare Containers (or any Docker host).
#
# The dashboard is served by the app itself, so this single image is the whole
# deployment - no separate static host, and no CORS to configure.

FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app

# Dependency metadata first so this layer caches independently of source edits.
# README.md is required: pyproject declares it as the readme.
COPY pyproject.toml README.md ./
COPY jupiter_code ./jupiter_code

# `[postgres]` pulls psycopg v3. The container disk is ephemeral, so a SQLite
# file would not survive a restart - Jupiter is expected to run on Postgres here.
RUN pip install --no-cache-dir ".[postgres]"

# Run as a non-root user.
RUN useradd --create-home --uid 10001 jupiter
USER jupiter

EXPOSE 8080

# /healthz is what the Container class uses as its pingEndpoint.
CMD ["jupiter-server", "--host", "0.0.0.0", "--port", "8080", "--log-level", "info"]
