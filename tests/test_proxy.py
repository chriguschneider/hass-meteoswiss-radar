"""Unit tests for MeteoSwissRadarProxyView hardening (issue #10).

These tests run with stdlib + pytest only (no aiohttp, no HA installed):
sys.modules is patched before importing the component so all HA/aiohttp
imports resolve to lightweight stubs.
"""

from __future__ import annotations

import asyncio
import sys
from contextlib import asynccontextmanager
from types import ModuleType
from unittest.mock import MagicMock


# ---------------------------------------------------------------------------
# Minimal stubs — built once at collection time, registered into sys.modules.
# ---------------------------------------------------------------------------

class _ClientError(Exception):
    """Stand-in for aiohttp.ClientError."""


class _FakeResponse:
    """Stand-in for aiohttp.web.Response."""

    def __init__(
        self,
        *,
        body: bytes | None = None,
        content_type: str | None = None,
        charset: str | None = None,
        headers: dict | None = None,
        status: int = 200,
    ) -> None:
        self.status = status
        self.body = body
        self._explicit_headers = headers or {}

    def __repr__(self) -> str:
        return f"_FakeResponse(status={self.status})"


class _FakeWeb:
    Response = _FakeResponse


def _make_stubs() -> dict[str, ModuleType]:
    aiohttp = ModuleType("aiohttp")
    aiohttp.ClientError = _ClientError  # type: ignore[attr-defined]
    aiohttp.ClientTimeout = MagicMock(return_value=object())  # type: ignore[attr-defined]
    aiohttp.web = _FakeWeb  # type: ignore[attr-defined]

    ha = ModuleType("homeassistant")
    ha_comp = ModuleType("homeassistant.components")
    ha_frontend = ModuleType("homeassistant.components.frontend")
    ha_frontend.add_extra_js_url = lambda *a, **kw: None  # type: ignore[attr-defined]
    ha_http = ModuleType("homeassistant.components.http")

    class _HAView:
        pass

    ha_http.HomeAssistantView = _HAView  # type: ignore[attr-defined]
    ha_http.StaticPathConfig = MagicMock()  # type: ignore[attr-defined]
    ha_cfg = ModuleType("homeassistant.config_entries")
    ha_cfg.ConfigEntry = object  # type: ignore[attr-defined]
    ha_core = ModuleType("homeassistant.core")
    ha_core.HomeAssistant = object  # type: ignore[attr-defined]
    ha_helpers = ModuleType("homeassistant.helpers")
    ha_client = ModuleType("homeassistant.helpers.aiohttp_client")
    ha_client.async_get_clientsession = MagicMock()  # type: ignore[attr-defined]

    return {
        "aiohttp": aiohttp,
        "homeassistant": ha,
        "homeassistant.components": ha_comp,
        "homeassistant.components.frontend": ha_frontend,
        "homeassistant.components.http": ha_http,
        "homeassistant.config_entries": ha_cfg,
        "homeassistant.core": ha_core,
        "homeassistant.helpers": ha_helpers,
        "homeassistant.helpers.aiohttp_client": ha_client,
    }


_STUBS = _make_stubs()
for _name, _mod in _STUBS.items():
    sys.modules.setdefault(_name, _mod)

# Import after stubs are in place.
from custom_components.meteoswiss_radar import (  # noqa: E402
    MeteoSwissRadarProxyView,
    _MAX_BODY_BYTES,
)

# Shorthand used in every test.
_VERSIONS_TAIL = "product/output/versions.json"
_ANIMATION_TAIL = (
    "product/output/precipitation/animation"
    "/version__20240101_1200/en/animation.json"
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _view() -> MeteoSwissRadarProxyView:
    hass = MagicMock()
    return MeteoSwissRadarProxyView(hass)


def _fake_upstream(
    status: int = 200,
    content_type: str = "application/json",
    body: bytes = b"{}",
) -> object:
    """Return an upstream response context-manager mock."""

    class _FakeContent:
        async def iter_chunked(self, size: int):  # noqa: ANN001
            yield body

    resp = MagicMock()
    resp.status = status
    resp.headers = {"Content-Type": content_type}
    resp.content = _FakeContent()

    @asynccontextmanager
    async def _cm(*_a, **_kw):
        yield resp

    session = MagicMock()
    session.get = _cm
    return session


def _inject_session(view: MeteoSwissRadarProxyView, session: object) -> None:
    """Point async_get_clientsession at our fake session for this call."""
    ha_client = _STUBS["homeassistant.helpers.aiohttp_client"]
    ha_client.async_get_clientsession.return_value = session


def _run(coro):  # noqa: ANN001
    return asyncio.run(coro)


def _get(view: MeteoSwissRadarProxyView, tail: str) -> _FakeResponse:
    request = MagicMock()
    return _run(view.get(request, tail))


# ---------------------------------------------------------------------------
# Tests: allowlist gate (unchanged behaviour)
# ---------------------------------------------------------------------------

def test_disallowed_path_returns_404() -> None:
    v = _view()
    resp = _get(v, "product/output/unknown/file.json")
    assert resp.status == 404


# ---------------------------------------------------------------------------
# Tests: redirect hardening
# ---------------------------------------------------------------------------

def test_301_redirect_returns_502() -> None:
    v = _view()
    _inject_session(v, _fake_upstream(status=301))
    resp = _get(v, _VERSIONS_TAIL)
    assert resp.status == 502


def test_302_redirect_returns_502() -> None:
    v = _view()
    _inject_session(v, _fake_upstream(status=302))
    resp = _get(v, _VERSIONS_TAIL)
    assert resp.status == 502


def test_307_redirect_returns_502() -> None:
    v = _view()
    _inject_session(v, _fake_upstream(status=307))
    resp = _get(v, _VERSIONS_TAIL)
    assert resp.status == 502


# ---------------------------------------------------------------------------
# Tests: 404 pass-through (manifest-rollover signal for the card)
# ---------------------------------------------------------------------------

def test_404_passes_through() -> None:
    v = _view()
    _inject_session(v, _fake_upstream(status=404))
    resp = _get(v, _VERSIONS_TAIL)
    assert resp.status == 404


# ---------------------------------------------------------------------------
# Tests: upstream error status mapping → 502
# ---------------------------------------------------------------------------

def test_401_returns_502() -> None:
    v = _view()
    _inject_session(v, _fake_upstream(status=401))
    resp = _get(v, _VERSIONS_TAIL)
    assert resp.status == 502


def test_403_returns_502() -> None:
    v = _view()
    _inject_session(v, _fake_upstream(status=403))
    resp = _get(v, _VERSIONS_TAIL)
    assert resp.status == 502


def test_500_returns_502() -> None:
    v = _view()
    _inject_session(v, _fake_upstream(status=500))
    resp = _get(v, _VERSIONS_TAIL)
    assert resp.status == 502


# ---------------------------------------------------------------------------
# Tests: non-JSON content-type → 502 (unchanged behaviour, verify still works)
# ---------------------------------------------------------------------------

def test_html_content_type_returns_502() -> None:
    v = _view()
    _inject_session(v, _fake_upstream(status=200, content_type="text/html"))
    resp = _get(v, _VERSIONS_TAIL)
    assert resp.status == 502


# ---------------------------------------------------------------------------
# Tests: body size cap → 502
# ---------------------------------------------------------------------------

def test_oversized_body_returns_502() -> None:
    oversized = b"x" * (_MAX_BODY_BYTES + 1)
    v = _view()
    _inject_session(v, _fake_upstream(body=oversized))
    resp = _get(v, _VERSIONS_TAIL)
    assert resp.status == 502


def test_exactly_max_body_is_accepted() -> None:
    exactly = b"x" * _MAX_BODY_BYTES
    v = _view()
    _inject_session(v, _fake_upstream(body=exactly))
    resp = _get(v, _VERSIONS_TAIL)
    assert resp.status == 200


# ---------------------------------------------------------------------------
# Tests: network error mapping
# ---------------------------------------------------------------------------

def test_timeout_returns_504() -> None:
    @asynccontextmanager
    async def _raise(*_a, **_kw):
        raise TimeoutError("timed out")
        yield

    session = MagicMock()
    session.get = _raise
    v = _view()
    _inject_session(v, session)
    resp = _get(v, _VERSIONS_TAIL)
    assert resp.status == 504


def test_client_error_returns_502() -> None:
    @asynccontextmanager
    async def _raise(*_a, **_kw):
        raise _ClientError("connection refused")
        yield

    session = MagicMock()
    session.get = _raise
    v = _view()
    _inject_session(v, session)
    resp = _get(v, _VERSIONS_TAIL)
    assert resp.status == 502


# ---------------------------------------------------------------------------
# Tests: happy path — 200 JSON response
# ---------------------------------------------------------------------------

def test_200_json_returns_200_with_body() -> None:
    payload = b'{"foo": 1}'
    v = _view()
    _inject_session(v, _fake_upstream(body=payload))
    resp = _get(v, _VERSIONS_TAIL)
    assert resp.status == 200
    assert resp.body == payload


def test_200_json_animation_tail_returns_200() -> None:
    v = _view()
    _inject_session(v, _fake_upstream(body=b'{"frames": []}'))
    resp = _get(v, _ANIMATION_TAIL)
    assert resp.status == 200
