"""Minimal OpenAI-compatible chat client, plus ``.env`` loading.

Jupiter talks to whatever OpenAI-shaped gateway it is pointed at - the default
is Accenture's Model IQ. ``httpx`` is already a dependency for the MCP client,
so this adds no new packages.

Configuration, first match wins:

===================  ================================================
API key              ``JUPITER_LLM_API_KEY``, ``OPENAI_API_KEY``,
                     ``MODELIQ_API_KEY``, ``API_KEY``
Model                ``JUPITER_LLM_MODEL``, ``MODELIQ_MODEL``,
                     ``MODEILIQ_MODEL``
Base URL             ``JUPITER_LLM_BASE_URL``, ``OPENAI_BASE_URL``
===================  ================================================

The feature switches itself on when a key resolves, and off otherwise, so a
deployment with no gateway behaves exactly as it did before.
"""

from __future__ import annotations

import json
import os
import re
from typing import Any

import httpx

from .dotenv import PLACEHOLDER as _PLACEHOLDER
from .dotenv import first_env as _first
from .dotenv import load_dotenv

DEFAULT_BASE_URL = "https://model-iq.aicore.accenture.com/v1"
DEFAULT_MODEL = "deepseek-v4-pro-0813"
DEFAULT_TIMEOUT = 45.0

KEY_VARS = ("JUPITER_LLM_API_KEY", "OPENAI_API_KEY", "MODELIQ_API_KEY", "API_KEY")
MODEL_VARS = ("JUPITER_LLM_MODEL", "MODELIQ_MODEL", "MODEILIQ_MODEL")
BASE_VARS = ("JUPITER_LLM_BASE_URL", "OPENAI_BASE_URL")

class LLMError(RuntimeError):
    """The gateway could not be reached, or answered with an error."""


# --------------------------------------------------------------------------- #
# configuration
# --------------------------------------------------------------------------- #


class LLMConfig:
    """Resolved gateway settings. ``enabled`` is False when there is no key."""

    def __init__(self) -> None:
        load_dotenv()
        self.api_key = _first(KEY_VARS)
        self.model = _first(MODEL_VARS) or DEFAULT_MODEL
        self.base_url = (_first(BASE_VARS) or DEFAULT_BASE_URL).rstrip("/")
        switch = (os.environ.get("JUPITER_LLM_ENABLED") or "").strip().lower()
        self.forced_off = switch in {"0", "false", "no", "off"}
        self.enabled = bool(self.api_key) and not self.forced_off

    def describe(self) -> dict:
        """Safe to expose over the API - never includes the key."""
        return {
            "enabled": self.enabled,
            "model": self.model if self.enabled else None,
            "base_url": self.base_url if self.enabled else None,
            "reason": (
                None if self.enabled
                else "disabled by JUPITER_LLM_ENABLED" if self.forced_off
                else "no API key configured (set JUPITER_LLM_API_KEY)"
            ),
        }


_config: LLMConfig | None = None


def config(refresh: bool = False) -> LLMConfig:
    global _config
    if _config is None or refresh:
        _config = LLMConfig()
    return _config


# --------------------------------------------------------------------------- #
# chat
# --------------------------------------------------------------------------- #

_FENCE = re.compile(r"```(?:json)?\s*(.*?)\s*```", re.S)

# Some gateways reject response_format; learned once, then remembered.
_supports_json_mode = True


def chat_json(
    system: str,
    user: str,
    *,
    max_tokens: int = 1200,
    temperature: float = 0.0,
    timeout: float = DEFAULT_TIMEOUT,
) -> dict[str, Any]:
    """Run one completion and return its parsed JSON object.

    Raises :class:`LLMError` for transport, HTTP or parse failures, so callers
    can treat the whole feature as best-effort.
    """
    global _supports_json_mode
    cfg = config()
    if not cfg.enabled:
        raise LLMError("no LLM configured")

    payload: dict[str, Any] = {
        "model": cfg.model,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        "max_tokens": max_tokens,
        "temperature": temperature,
    }
    if _supports_json_mode:
        payload["response_format"] = {"type": "json_object"}

    headers = {
        "Authorization": f"Bearer {cfg.api_key}",
        "Content-Type": "application/json",
    }

    try:
        with httpx.Client(timeout=timeout) as client:
            response = client.post(
                f"{cfg.base_url}/chat/completions", headers=headers, json=payload
            )
            if response.status_code == 400 and _supports_json_mode:
                # Gateway does not know response_format - drop it and retry once.
                _supports_json_mode = False
                payload.pop("response_format", None)
                response = client.post(
                    f"{cfg.base_url}/chat/completions", headers=headers, json=payload
                )
    except httpx.HTTPError as exc:
        raise LLMError(f"cannot reach the LLM gateway ({exc.__class__.__name__})") from exc

    if response.status_code >= 400:
        raise LLMError(f"LLM gateway returned {response.status_code}: {response.text[:200]}")

    try:
        content = response.json()["choices"][0]["message"]["content"] or ""
    except (ValueError, KeyError, IndexError) as exc:
        raise LLMError("unexpected response shape from the LLM gateway") from exc

    return _parse_json(content)


def _parse_json(content: str) -> dict[str, Any]:
    """Pull a JSON object out of a model reply, fenced or not."""
    text = content.strip()
    fence = _FENCE.search(text)
    if fence:
        text = fence.group(1).strip()
    if not text.startswith("{"):
        start, end = text.find("{"), text.rfind("}")
        if start == -1 or end <= start:
            raise LLMError("model reply contained no JSON object")
        text = text[start:end + 1]
    try:
        parsed = json.loads(text)
    except ValueError as exc:
        raise LLMError("model reply was not valid JSON") from exc
    if not isinstance(parsed, dict):
        raise LLMError("model reply was not a JSON object")
    return parsed
