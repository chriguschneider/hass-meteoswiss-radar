"""Unit tests for MeteoSwissRadarProxyView hardening and caching (issues #10, #11).

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
        self.compression_enabled = False

    def enable_compression(self) -> None:
        self.compression_enabled = True

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
    _LRU_MAX,
    _MAX_BODY_BYTES,
    _VERSIONS_TTL,
)

# Shorthand used in every test.
_VERSIONS_TAIL = "product/output/versions.json"
_ANIMATION_TAIL = (
    "product/output/precipitation/animation"
    "/version__20240101_1200/en/animation.json"
)
_RADAR_TAIL = "product/output/radar/rzc/radar_rzc.20240101_1200.json"


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


def _counting_upstream(
    body: bytes = b"{}",
    delay: bool = False,
) -> tuple[object, list]:
    """Upstream mock that records the number of times it was called."""
    calls: list = []

    class _FakeContent:
        async def iter_chunked(self, size: int):  # noqa: ANN001
            yield body

    @asynccontextmanager
    async def _cm(*_a, **_kw):
        calls.append(1)
        if delay:
            await asyncio.sleep(0)  # yield so a second coroutine can start
        resp = MagicMock()
        resp.status = 200
        resp.headers = {"Content-Type": "application/json"}
        resp.content = _FakeContent()
        yield resp

    session = MagicMock()
    session.get = _cm
    return session, calls


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


# ---------------------------------------------------------------------------
# Tests: compression
# ---------------------------------------------------------------------------

def test_200_response_has_compression_enabled() -> None:
    v = _view()
    _inject_session(v, _fake_upstream(body=b'{"foo": 1}'))
    resp = _get(v, _VERSIONS_TAIL)
    assert resp.status == 200
    assert resp.compression_enabled


def test_error_response_does_not_call_enable_compression() -> None:
    v = _view()
    _inject_session(v, _fake_upstream(status=502))
    resp = _get(v, _VERSIONS_TAIL)
    assert resp.status == 502
    assert not resp.compression_enabled


# ---------------------------------------------------------------------------
# Tests: in-flight deduplication
# ---------------------------------------------------------------------------

def test_concurrent_requests_for_same_frame_produce_one_upstream_fetch() -> None:
    """Two concurrent GETs for the same immutable frame → exactly one upstream fetch."""
    session, calls = _counting_upstream(body=b'{"frames": []}', delay=True)

    async def _run() -> None:
        v = _view()
        _inject_session(v, session)
        request = MagicMock()
        results = await asyncio.gather(
            v.get(request, _ANIMATION_TAIL),
            v.get(request, _ANIMATION_TAIL),
        )
        assert all(r.status == 200 for r in results)

    asyncio.run(_run())
    assert len(calls) == 1, f"expected 1 upstream fetch, got {len(calls)}"


def test_concurrent_requests_for_versions_json_produce_one_upstream_fetch() -> None:
    """Two concurrent GETs for versions.json → exactly one upstream fetch."""
    session, calls = _counting_upstream(body=b'{"version": 1}', delay=True)

    async def _run() -> None:
        v = _view()
        _inject_session(v, session)
        request = MagicMock()
        results = await asyncio.gather(
            v.get(request, _VERSIONS_TAIL),
            v.get(request, _VERSIONS_TAIL),
        )
        assert all(r.status == 200 for r in results)

    asyncio.run(_run())
    assert len(calls) == 1, f"expected 1 upstream fetch, got {len(calls)}"


# ---------------------------------------------------------------------------
# Tests: versions.json TTL cache
# ---------------------------------------------------------------------------

def test_versions_json_cache_hit_within_ttl() -> None:
    """Second request within TTL window does not hit upstream."""
    session, calls = _counting_upstream(body=b'{"version": 1}')
    v = _view()
    _inject_session(v, session)

    _get(v, _VERSIONS_TAIL)
    _get(v, _VERSIONS_TAIL)

    assert len(calls) == 1, "expected cache hit on second request"


def test_versions_json_cache_miss_after_ttl() -> None:
    """Second request after TTL expiry re-fetches from upstream."""
    session, calls = _counting_upstream(body=b'{"version": 1}')
    v = _view()
    _inject_session(v, session)

    _get(v, _VERSIONS_TAIL)

    # Expire the cache by back-dating its timestamp.
    ts, body = v._versions_cache
    v._versions_cache = (ts - _VERSIONS_TTL - 1.0, body)

    _get(v, _VERSIONS_TAIL)

    assert len(calls) == 2, "expected upstream re-fetch after TTL expiry"


# ---------------------------------------------------------------------------
# Tests: LRU cache for immutable frames
# ---------------------------------------------------------------------------

def test_immutable_frame_cache_hit() -> None:
    """Second request for the same frame uses the LRU cache."""
    session, calls = _counting_upstream(body=b'{"frames": []}')
    v = _view()
    _inject_session(v, session)

    _get(v, _ANIMATION_TAIL)
    _get(v, _ANIMATION_TAIL)

    assert len(calls) == 1, "expected LRU cache hit on second request"


def test_lru_evicts_oldest_entry_when_full() -> None:
    """Inserting beyond _LRU_MAX entries evicts the least-recently-used entry."""
    v = _view()
    # Fill the LRU with synthetic entries directly.
    for i in range(_LRU_MAX):
        tail = f"product/output/radar/rzc/radar_rzc.2024010{i // 10}_{i:04d}.json"
        v._lru[tail] = b"{}"

    assert len(v._lru) == _LRU_MAX
    first_tail = next(iter(v._lru))

    # Add one more via cache_put using a valid immutable tail.
    new_tail = "product/output/radar/rzc/radar_rzc.20241231_2359.json"
    v._cache_put(new_tail, b'{"new": true}')

    assert len(v._lru) <= _LRU_MAX, "LRU exceeded max size"
    assert first_tail not in v._lru, "oldest entry was not evicted"
    assert new_tail in v._lru, "new entry missing from LRU"


def test_lru_does_not_cache_versions_json() -> None:
    """versions.json must not enter the LRU; it has its own TTL cache."""
    v = _view()
    v._cache_put(_VERSIONS_TAIL, b'{"version": 1}')
    assert _VERSIONS_TAIL not in v._lru
    assert v._versions_cache is not None
