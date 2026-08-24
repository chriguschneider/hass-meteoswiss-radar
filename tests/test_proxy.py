"""Unit tests for MeteoSwissRadarProxyView hardening and caching (issues #10, #11, #17).

These tests run with stdlib + pytest only (no aiohttp, no HA installed):
sys.modules is patched before importing the component so all HA/aiohttp
imports resolve to lightweight stubs.
"""

from __future__ import annotations

import asyncio
import sys
from contextlib import asynccontextmanager
from types import ModuleType
from unittest.mock import AsyncMock, MagicMock

import pytest


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


class _FakeFileResponse:
    """Stand-in for aiohttp.web.FileResponse."""

    def __init__(self, path, *, headers: dict | None = None, **_kw) -> None:  # noqa: ANN001
        self.path = path
        self.status = 200
        self._explicit_headers = headers or {}
        self.compression_enabled = False

    def enable_compression(self) -> None:
        self.compression_enabled = True

    def __repr__(self) -> str:
        return f"_FakeFileResponse(path={self.path!r})"


class _FakeWeb:
    Response = _FakeResponse
    FileResponse = _FakeFileResponse


def _make_stubs() -> dict[str, ModuleType]:
    aiohttp = ModuleType("aiohttp")
    aiohttp.ClientError = _ClientError  # type: ignore[attr-defined]
    aiohttp.ClientTimeout = MagicMock(return_value=object())  # type: ignore[attr-defined]
    aiohttp.web = _FakeWeb  # type: ignore[attr-defined]

    ha = ModuleType("homeassistant")
    ha_comp = ModuleType("homeassistant.components")
    ha_frontend = ModuleType("homeassistant.components.frontend")
    ha_frontend.add_extra_js_url = lambda *a, **kw: None  # type: ignore[attr-defined]
    ha_frontend.remove_extra_js_url = lambda *a, **kw: None  # type: ignore[attr-defined]
    ha_http = ModuleType("homeassistant.components.http")

    class _HAView:
        pass

    ha_http.HomeAssistantView = _HAView  # type: ignore[attr-defined]
    ha_http.StaticPathConfig = MagicMock()  # type: ignore[attr-defined]
    ha_cfg = ModuleType("homeassistant.config_entries")
    ha_cfg.ConfigEntry = object  # type: ignore[attr-defined]

    class _ConfigFlow:
        def __init_subclass__(cls, domain: str | None = None, **kwargs: object) -> None:
            super().__init_subclass__(**kwargs)

    ha_cfg.ConfigFlow = _ConfigFlow  # type: ignore[attr-defined]
    ha_cfg.ConfigFlowResult = dict  # type: ignore[attr-defined]
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
    MeteoSwissRadarVendorView,
    _LRU_MAX,
    _MAX_BODY_BYTES,
    _VERSIONS_TTL,
    async_setup_entry,
    async_unload_entry,
)
import custom_components.meteoswiss_radar as _integration  # noqa: E402

# Shorthand used in every test.
_VERSIONS_TAIL = "product/output/versions.json"
_ANIMATION_TAIL = (
    "product/output/precipitation/animation"
    "/version__20240101_1200/en/animation.json"
)
_RADAR_TAIL = "product/output/radar/rzc/radar_rzc.20240101_1200.json"
_INCA_TAIL = (
    "product/output/inca/precipitation/rate"
    "/version__20240101_1200/rate_20240101_1200.json"
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


# ---------------------------------------------------------------------------
# Tests: allowlist — all four legal path forms reach upstream (positive)
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("tail", [
    _VERSIONS_TAIL,
    _ANIMATION_TAIL,
    _RADAR_TAIL,
    _INCA_TAIL,
])
def test_allowed_path_reaches_upstream(tail: str) -> None:
    """Every allowed path form must contact upstream and return 200."""
    session, calls = _counting_upstream()
    v = _view()
    _inject_session(v, session)
    resp = _get(v, tail)
    assert resp.status == 200
    assert len(calls) == 1, f"upstream must be called once for {tail!r}"


# ---------------------------------------------------------------------------
# Tests: allowlist — disallowed paths blocked before upstream (negative)
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("tail", [
    # Traversal as prefix
    "../product/output/versions.json",
    "%2e%2e%2fproduct/output/versions.json",
    "..%2fproduct/output/versions.json",
    # Embedded traversal
    "product/output/../output/versions.json",
    # Prefix junk
    "xproduct/output/versions.json",
    # Suffix junk
    "product/output/versions.json.bak",
    # Query smuggling via literal ?/#
    "product/output/versions.json?foo=bar",
    "product/output/versions.json#anchor",
    # Query smuggling via percent-encoded ?
    "product/output/versions.json%3ffoo=bar",
    # Wrong digit count in timestamp (radar)
    "product/output/radar/rzc/radar_rzc.2024010_1200.json",   # 7-digit date
    "product/output/radar/rzc/radar_rzc.20240101_120.json",   # 3-digit time
    # Language code wrong length (animation): must be exactly [a-z]{2}
    "product/output/precipitation/animation/version__20240101_1200/eng/animation.json",
    "product/output/precipitation/animation/version__20240101_1200/12/animation.json",
    # INCA path outside precipitation/rate
    "product/output/inca/wind/rate/version__20240101_1200/rate_20240101_1200.json",
    "product/output/inca/precipitation/other/version__20240101_1200/other_20240101_1200.json",
])
def test_disallowed_path_returns_404_without_upstream(tail: str) -> None:
    """Blocked paths must return 404; upstream must never be contacted."""
    session, calls = _counting_upstream()
    v = _view()
    _inject_session(v, session)
    resp = _get(v, tail)
    assert resp.status == 404
    assert len(calls) == 0, f"upstream must not be contacted for {tail!r}"


# ---------------------------------------------------------------------------
# Tests: Cache-Control headers
# ---------------------------------------------------------------------------

def test_versions_json_cache_control_is_no_store() -> None:
    v = _view()
    _inject_session(v, _fake_upstream(body=b'{"version": 1}'))
    resp = _get(v, _VERSIONS_TAIL)
    assert resp.status == 200
    assert resp._explicit_headers.get("Cache-Control") == "no-store"


@pytest.mark.parametrize("tail", [_ANIMATION_TAIL, _RADAR_TAIL, _INCA_TAIL])
def test_immutable_path_cache_control_is_private(tail: str) -> None:
    """Immutable frames must use private (not public) max-age caching.

    private instead of public: the proxy endpoint requires HA auth, so
    responses must never be stored in a shared cache (see issue #57).
    """
    v = _view()
    _inject_session(v, _fake_upstream(body=b'{"frames": []}'))
    resp = _get(v, tail)
    assert resp.status == 200
    cc = resp._explicit_headers.get("Cache-Control", "")
    assert "private" in cc
    assert "max-age=86400" in cc
    assert "immutable" in cc
    assert "public" not in cc


# ---------------------------------------------------------------------------
# Tests: lifecycle
# ---------------------------------------------------------------------------

def test_async_setup_entry_is_idempotent() -> None:
    """Second async_setup_entry must return True without registering views again."""
    hass = MagicMock()
    hass.data = {}
    hass.http.async_register_static_paths = AsyncMock()
    entry = MagicMock()

    _run(async_setup_entry(hass, entry))
    first_count = hass.http.register_view.call_count

    _run(async_setup_entry(hass, entry))
    second_count = hass.http.register_view.call_count

    assert first_count == 3, "expected three view registrations on first setup"
    assert second_count == 3, "second setup must not register views again"


def test_reload_reregisters_card_resource(monkeypatch: pytest.MonkeyPatch) -> None:
    """A reload (unload then setup) must re-add the card's extra-JS URL.

    Regression test for issue #67: async_unload_entry removes the extra-JS URL,
    so async_setup_entry must add it again -- otherwise every dashboard loses
    the card until a full HA restart.
    """
    added: list[str] = []
    removed: list[str] = []
    monkeypatch.setattr(
        _integration, "add_extra_js_url", lambda hass, url: added.append(url)
    )
    monkeypatch.setattr(
        _integration, "remove_extra_js_url", lambda hass, url: removed.append(url)
    )

    hass = MagicMock()
    hass.data = {}
    hass.http.async_register_static_paths = AsyncMock()
    entry = MagicMock()

    _run(async_setup_entry(hass, entry))
    assert added == ["/meteoswiss_radar/frontend/meteoswiss-radar-card.js"]

    _run(async_unload_entry(hass, entry))
    assert removed == ["/meteoswiss_radar/frontend/meteoswiss-radar-card.js"]

    # The reload: setup again after unload must restore the card resource...
    _run(async_setup_entry(hass, entry))
    assert added == [
        "/meteoswiss_radar/frontend/meteoswiss-radar-card.js",
        "/meteoswiss_radar/frontend/meteoswiss-radar-card.js",
    ], "reload must re-register the card resource"

    # ...but must not re-register the (non-unregisterable) HTTP views.
    assert hass.http.register_view.call_count == 3, (
        "views must be registered only once across a reload"
    )


def test_setup_does_not_duplicate_card_resource_without_unload() -> None:
    """Two setups without an intervening unload must add the URL only once."""
    added: list[str] = []
    with pytest.MonkeyPatch.context() as mp:
        mp.setattr(
            _integration, "add_extra_js_url", lambda hass, url: added.append(url)
        )
        hass = MagicMock()
        hass.data = {}
        hass.http.async_register_static_paths = AsyncMock()
        entry = MagicMock()

        _run(async_setup_entry(hass, entry))
        _run(async_setup_entry(hass, entry))

    assert added == ["/meteoswiss_radar/frontend/meteoswiss-radar-card.js"]


# ---------------------------------------------------------------------------
# Tests: vendor view — version-agnostic serving (issue #70)
# ---------------------------------------------------------------------------

def _get_vendor(tag: str, filename: str) -> _FakeResponse:
    view = MeteoSwissRadarVendorView()
    request = MagicMock()
    return _run(view.get(request, tag, filename))


@pytest.mark.parametrize("tag", ["0.7.0", "0.8.0", "0.9.0", "99.99.99", "anything"])
def test_vendor_any_tag_resolves(tag: str) -> None:
    """Every tag -- old, current, or future -- resolves the same on-disk file.

    This is the fix for issue #70: a card left open across an upgrade (old tag)
    and a new card on a not-yet-restarted process (new tag) both resolve.
    """
    resp = _get_vendor(tag, "leaflet.js")
    assert resp.status == 200
    assert str(resp.path).endswith("frontend/vendor/leaflet.js")


@pytest.mark.parametrize(
    "filename,expected_type",
    [
        ("leaflet.js", "text/javascript"),
        ("leaflet.css", "text/css"),
        ("images/marker-icon.png", "image/png"),
        ("images/marker-shadow.png", "image/png"),
    ],
)
def test_vendor_allowed_files_resolve_with_content_type(
    filename: str, expected_type: str
) -> None:
    resp = _get_vendor("0.8.0", filename)
    assert resp.status == 200
    assert resp._explicit_headers.get("Content-Type") == expected_type


def test_vendor_cache_control_is_private_immutable() -> None:
    resp = _get_vendor("0.8.0", "leaflet.js")
    assert resp.status == 200
    assert (
        resp._explicit_headers.get("Cache-Control")
        == "private, max-age=86400, immutable"
    )


@pytest.mark.parametrize(
    "filename",
    [
        # Not on the allowlist.
        "leaflet.js.bak",
        "evil.js",
        "leaflet.min.js",
        "index.html",
        "images/",
        "images/logo.svg",
        # Traversal attempts.
        "../__init__.py",
        "../../const.py",
        "..%2f__init__.py",
        "images/../../__init__.py",
    ],
)
def test_vendor_disallowed_or_traversal_returns_404(filename: str) -> None:
    """Anything off the allowlist -- including traversal -- must 404."""
    resp = _get_vendor("0.8.0", filename)
    assert resp.status == 404
    assert not isinstance(resp, _FakeFileResponse)


def test_config_flow_aborts_on_second_instance() -> None:
    """async_step_user must abort with single_instance_allowed when an entry exists."""
    from custom_components.meteoswiss_radar.config_flow import (
        MeteoSwissRadarConfigFlow,
    )

    flow = object.__new__(MeteoSwissRadarConfigFlow)
    flow._async_current_entries = lambda: [object()]
    flow.async_abort = lambda reason: {"type": "abort", "reason": reason}

    result = _run(flow.async_step_user())
    assert result == {"type": "abort", "reason": "single_instance_allowed"}
