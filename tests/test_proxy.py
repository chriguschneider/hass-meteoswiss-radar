"""Unit tests for MeteoSwissRadarProxyView hardening and caching (issues #10, #11, #17).

These tests run with stdlib + pytest only (no aiohttp, no HA installed):
sys.modules is patched before importing the component so all HA/aiohttp
imports resolve to lightweight stubs.
"""

from __future__ import annotations

import asyncio
import pathlib
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
        return (
            f"_FakeResponse(status={self.status}, "
            f"Content-Encoding={self._explicit_headers.get('Content-Encoding')!r})"
        )


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
    MeteoSwissRadarCardView,
    MeteoSwissRadarProxyView,
    MeteoSwissRadarVendorView,
    _LRU_MAX_BYTES,
    _MAX_BODY_BYTES,
    _UPSTREAM_TIMEOUT,
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
# Overlay tails (issue #92)
_SNOW_TAIL = (
    "product/output/inca/precipitation/type/snow"
    "/version__20240101_1200/snow_20240101_1200.json"
)
_SNOWRAIN_TAIL = (
    "product/output/inca/precipitation/type/snowrain"
    "/version__20240101_1200/snowrain_20240101_1200.json"
)
_FREEZINGRAIN_TAIL = (
    "product/output/inca/precipitation/type/freezing-rain"
    "/version__20240101_1200/freezingrain_20240101_1200.json"
)
_LIGHTNING_TAIL = (
    "product/output/lightning"
    "/version__20240101_1200/lightning.json"
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _view() -> MeteoSwissRadarProxyView:
    hass = MagicMock()
    # Simulate executor job: run the callable synchronously in tests so that
    # async_add_executor_job remains awaitable without a real thread pool.
    async def _executor(fn, *args):  # noqa: ANN001
        return fn(*args)
    hass.async_add_executor_job = _executor
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
    """Upstream mock that records each call as (args, kwargs).

    len(calls) gives the call count; calls[i] gives the positional and keyword
    arguments passed to session.get for the i-th call, enabling assertions on
    the upstream URL, allow_redirects, and timeout (issue #77).
    """
    calls: list = []

    class _FakeContent:
        async def iter_chunked(self, size: int):  # noqa: ANN001
            yield body

    @asynccontextmanager
    async def _cm(*_a, **_kw):
        calls.append((_a, _kw))
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


def _get(
    view: MeteoSwissRadarProxyView, tail: str, accept_encoding: str = "gzip"
) -> _FakeResponse:
    request = MagicMock()
    request.headers = {"Accept-Encoding": accept_encoding}
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


def test_cache_hit_with_gzip_serves_precompressed_body() -> None:
    """Cache hit with gzip accept-encoding serves pre-compressed body directly.

    Regression test for issue #74: every response (including cache hits) must
    not recompress the body. Compress once at cache-put, serve gzipped if
    Accept-Encoding allows.
    """
    session, calls = _counting_upstream(body=b'{"frames": []}')
    v = _view()
    _inject_session(v, session)

    # First request (cache miss) hits upstream.
    resp1 = _get(v, _ANIMATION_TAIL, accept_encoding="gzip")
    assert resp1.status == 200
    assert len(calls) == 1

    # Second request (cache hit) must not recompress.
    resp2 = _get(v, _ANIMATION_TAIL, accept_encoding="gzip")
    assert resp2.status == 200
    assert len(calls) == 1, "cache hit must not hit upstream"
    # With gzip accept-encoding, the response must have Content-Encoding: gzip
    # and must NOT call enable_compression (to avoid double-compression).
    assert resp2._explicit_headers.get("Content-Encoding") == "gzip"
    assert not resp2.compression_enabled, (
        "pre-compressed cache hits must not call enable_compression"
    )


def test_cache_hit_without_gzip_serves_decompressed_body() -> None:
    """Cache hit without gzip accept-encoding gets decompressed body.

    LRU stores only gzipped bytes; gzip.decompress() recovers the raw body for
    the rare client that does not accept gzip (issue #136).
    """
    payload = b'{"frames": []}'
    session, calls = _counting_upstream(body=payload)
    v = _view()
    _inject_session(v, session)

    # First request (populates the LRU with gzipped bytes).
    _get(v, _ANIMATION_TAIL, accept_encoding="gzip")
    assert len(calls) == 1

    # Second request without gzip accept-encoding.
    resp2 = _get(v, _ANIMATION_TAIL, accept_encoding="deflate")
    assert resp2.status == 200
    assert len(calls) == 1, "cache hit must not hit upstream"
    # Without gzip in Accept-Encoding, no Content-Encoding: gzip header.
    assert resp2._explicit_headers.get("Content-Encoding") != "gzip"
    # Decompressed body must match original payload.
    assert resp2.body == payload
    # enable_compression() called so aiohttp can negotiate other encodings.
    assert resp2.compression_enabled


def test_cache_miss_with_gzip_serves_precompressed_body() -> None:
    """Cache miss (first request) with gzip accept-encoding serves pre-compressed body.

    Regression test for issue #135: the miss/joiner path must serve the pre-compressed
    tuple instead of calling enable_compression() on the raw body (double-compress).
    """
    session, calls = _counting_upstream(body=b'{"frames": []}')
    v = _view()
    _inject_session(v, session)

    resp = _get(v, _ANIMATION_TAIL, accept_encoding="gzip")
    assert resp.status == 200
    assert len(calls) == 1
    # On the miss path the response must already carry Content-Encoding: gzip
    # and must NOT call enable_compression (that would double-compress).
    assert resp._explicit_headers.get("Content-Encoding") == "gzip"
    assert not resp.compression_enabled, (
        "miss path must not call enable_compression when gzip is pre-applied"
    )


def test_cache_miss_without_gzip_serves_decompressed_body() -> None:
    """Cache miss without gzip: decompressed body returned with enable_compression.

    LRU stores only gzipped bytes; on a miss the body is gzipped before caching
    and returned as gzip. _build_response decompresses for non-gzip clients (#136).
    """
    payload = b'{"frames": []}'
    session, calls = _counting_upstream(body=payload)
    v = _view()
    _inject_session(v, session)

    resp = _get(v, _ANIMATION_TAIL, accept_encoding="deflate")
    assert resp.status == 200
    assert resp._explicit_headers.get("Content-Encoding") != "gzip"
    assert resp.body == payload
    assert resp.compression_enabled


def test_inflight_joiner_with_gzip_gets_precompressed_body() -> None:
    """Joiners on the in-flight path receive the pre-compressed tuple (issue #135).

    Before the fix, joiners got raw bytes and called enable_compression(), causing
    a second gzip pass.  After the fix they get the (raw, gzipped) tuple and serve
    the pre-compressed body without re-compressing.
    """

    async def _run() -> None:
        session, calls = _counting_upstream(body=b'{"frames": []}', delay=True)
        v = _view()
        _inject_session(v, session)
        request = MagicMock()
        request.headers = {"Accept-Encoding": "gzip"}

        results = await asyncio.gather(
            v.get(request, _ANIMATION_TAIL),
            v.get(request, _ANIMATION_TAIL),
        )
        assert all(r.status == 200 for r in results)
        for resp in results:
            assert resp._explicit_headers.get("Content-Encoding") == "gzip", (
                "both leader and joiner must serve pre-compressed body"
            )
            assert not resp.compression_enabled, (
                "neither leader nor joiner may call enable_compression"
                " on a pre-compressed body"
            )

    asyncio.run(_run())


def test_compression_uses_executor_job() -> None:
    """gzip.compress must be dispatched via async_add_executor_job, not inline.

    Regression test for issue #135: inline gzip.compress at compresslevel 9 on
    bodies up to 2 MB blocks the HA event loop.
    """
    executor_calls: list = []

    async def _run() -> None:
        hass = MagicMock()

        async def _executor(fn, *args):  # noqa: ANN001
            executor_calls.append((fn, args))
            return fn(*args)

        hass.async_add_executor_job = _executor

        v = MeteoSwissRadarProxyView(hass)
        session, _ = _counting_upstream(body=b'{"frames": []}')
        _inject_session(v, session)
        request = MagicMock()
        request.headers = {"Accept-Encoding": "gzip"}
        await v.get(request, _ANIMATION_TAIL)

    asyncio.run(_run())
    assert len(executor_calls) == 1, (
        "gzip.compress must be called exactly once via async_add_executor_job"
    )
    fn, args = executor_calls[0]
    import gzip as _gzip
    assert fn is _gzip.compress, "the executor job must be gzip.compress"
    assert args[1] == 6, "must use compresslevel 6, not the default 9"


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


def test_leader_cancelled_waiter_still_receives_200() -> None:
    """Leader is cancelled mid-fetch; the joined waiter still receives 200.

    Regression test for issue #69: the old implementation explicitly cancelled
    the in-flight Future when the leader got CancelledError, which killed every
    joiner even though their clients were still connected.  The fix runs the
    fetch as a detached Task that survives leader cancellation.
    """

    async def _run() -> None:
        # An event that the test releases once both tasks are suspended so the
        # upstream response can be delivered in a controlled order.
        ready = asyncio.Event()
        release = asyncio.Event()

        class _BlockingContent:
            async def iter_chunked(self, _size: int):  # noqa: ANN001
                ready.set()
                await release.wait()
                yield b'{"frames": []}'

        @asynccontextmanager
        async def _blocking_get(*_a, **_kw):
            resp = MagicMock()
            resp.status = 200
            resp.headers = {"Content-Type": "application/json"}
            resp.content = _BlockingContent()
            yield resp

        session = MagicMock()
        session.get = _blocking_get

        v = _view()
        _inject_session(v, session)
        request = MagicMock()

        leader = asyncio.create_task(v.get(request, _ANIMATION_TAIL))
        joiner = asyncio.create_task(v.get(request, _ANIMATION_TAIL))

        # Wait until the fetch has started (blocked inside _BlockingContent).
        await ready.wait()
        # Give the joiner a chance to register on the shield.
        await asyncio.sleep(0)
        await asyncio.sleep(0)

        # Cancel the leader; the detached fetch task must survive.
        leader.cancel()
        try:
            await leader
        except asyncio.CancelledError:
            pass

        # Release the upstream response — the fetch task completes and the
        # joiner should receive the 200.
        release.set()
        resp = await asyncio.wait_for(joiner, timeout=5.0)
        assert resp.status == 200

    asyncio.run(_run())


def test_concurrent_502_both_receive_502_one_upstream_call() -> None:
    """Two concurrent GETs, upstream 502: both callers get 502; one fetch."""

    async def _run() -> None:
        calls: list = []
        release = asyncio.Event()

        class _SlowContent:
            async def iter_chunked(self, _size: int):  # noqa: ANN001
                yield b""

        @asynccontextmanager
        async def _get(*_a, **_kw):
            calls.append(1)
            await release.wait()
            resp = MagicMock()
            resp.status = 502
            resp.headers = {"Content-Type": "application/json"}
            resp.content = _SlowContent()
            yield resp

        session = MagicMock()
        session.get = _get

        v = _view()
        _inject_session(v, session)
        request = MagicMock()

        t1 = asyncio.create_task(v.get(request, _ANIMATION_TAIL))
        t2 = asyncio.create_task(v.get(request, _ANIMATION_TAIL))
        await asyncio.sleep(0)
        await asyncio.sleep(0)

        release.set()
        results = await asyncio.gather(t1, t2)

        assert all(r.status == 502 for r in results)
        assert len(calls) == 1, f"expected 1 upstream call, got {len(calls)}"

    asyncio.run(_run())


def test_fetch_task_exception_seen_by_waiter_and_inflight_cleared() -> None:
    """Unexpected exception in the fetch task: joiner sees it; _inflight is empty."""

    async def _run() -> None:
        release = asyncio.Event()

        class _BrokenContent:
            async def iter_chunked(self, _size: int):  # noqa: ANN001
                await release.wait()
                raise RuntimeError("boom")
                yield  # make it an async generator

        @asynccontextmanager
        async def _get(*_a, **_kw):
            resp = MagicMock()
            resp.status = 200
            resp.headers = {"Content-Type": "application/json"}
            resp.content = _BrokenContent()
            yield resp

        session = MagicMock()
        session.get = _get

        v = _view()
        _inject_session(v, session)
        request = MagicMock()

        leader = asyncio.create_task(v.get(request, _ANIMATION_TAIL))
        joiner = asyncio.create_task(v.get(request, _ANIMATION_TAIL))
        await asyncio.sleep(0)
        await asyncio.sleep(0)

        release.set()
        with pytest.raises(RuntimeError, match="boom"):
            await leader
        with pytest.raises(RuntimeError, match="boom"):
            await joiner

        # No stuck entry — done_callback must have removed it.
        assert _ANIMATION_TAIL not in v._inflight

    asyncio.run(_run())


def test_error_response_not_cached_second_request_refetches() -> None:
    """A 502 response is not cached; the next sequential request goes upstream."""
    calls: list = []

    @asynccontextmanager
    async def _get(*_a, **_kw):
        calls.append(1)
        resp = MagicMock()
        resp.status = 502
        resp.headers = {"Content-Type": "application/json"}
        resp.content = MagicMock()
        yield resp

    session = MagicMock()
    session.get = _get

    v = _view()
    _inject_session(v, session)

    _get_coro = v.get(MagicMock(), _ANIMATION_TAIL)
    asyncio.run(_get_coro)
    _get_coro2 = v.get(MagicMock(), _ANIMATION_TAIL)
    asyncio.run(_get_coro2)

    assert len(calls) == 2, (
        "error responses must not be cached; upstream must be called twice"
    )


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
    """Byte-bounded LRU (gz-only) evicts oldest entry when budget exceeded.

    Uses near-incompressible data so gz_size ≈ raw_size, making it easy to
    reason about how many entries fit before eviction fires (issue #136).
    """
    import gzip as _gzip
    import os

    v = _view()
    # ~512 KB of random (incompressible) data per entry — gz ≈ raw size.
    raw = os.urandom(512 * 1024)
    gz = _gzip.compress(raw, 6)
    gz_size = len(gz)

    # How many entries fit within the budget?
    entries_that_fit = _LRU_MAX_BYTES // gz_size
    # Add enough to guarantee eviction.
    entry_count = entries_that_fit + 3

    tails = []
    for i in range(entry_count):
        tail = f"product/output/radar/rzc/radar_rzc.20240101_{i:04d}.json"
        v._cache_put(tail, gz)
        tails.append(tail)

    # Budget respected.
    assert v._lru_bytes <= _LRU_MAX_BYTES, (
        f"LRU byte budget violated: {v._lru_bytes} > {_LRU_MAX_BYTES}"
    )
    # Newest entry present.
    assert tails[-1] in v._lru, "newest entry missing from LRU"
    # Some entries evicted.
    assert len(v._lru) <= entries_that_fit + 1, (
        f"too many entries in LRU: {len(v._lru)}"
    )


def test_lru_byte_bounded_full_manifest_sweep() -> None:
    """Full-manifest sweep (~291 frames) fits in budget with gz-only accounting.

    With the old raw+gz double-counting, a 100 KB frame cost ~100 KB + ~gz_size,
    limiting the cache to ~180 frames before thrash. With gz-only accounting, the
    same 20 MB budget holds ~7× more entries, so all 291 frames stay resident.
    """
    import gzip as _gzip
    import os

    v = _view()
    frame_count = 291
    # Use ~30 KB of random data per frame (incompressible → gz ≈ raw), so the
    # budget maths is straightforward: 291 × 30 KB ≈ 8.7 MB < 20 MB.
    raw_frame = os.urandom(30 * 1024)
    gz_frame = _gzip.compress(raw_frame, 6)
    gz_size = len(gz_frame)

    for i in range(frame_count):
        tail = (
            f"product/output/precipitation/animation"
            f"/version__2024010{i // 100:01d}_{i % 100:04d}/en/animation.json"
        )
        v._cache_put(tail, gz_frame)

    # Budget respected (allow one frame overage tolerance).
    assert v._lru_bytes <= _LRU_MAX_BYTES + gz_size, (
        f"byte budget violated after {frame_count} frames: "
        f"{v._lru_bytes} > {_LRU_MAX_BYTES + gz_size}"
    )
    # With 20 MB budget and ~30 KB gz frames, all 291 frames should fit.
    assert len(v._lru) == frame_count, (
        f"expected all {frame_count} frames cached, got {len(v._lru)}"
    )


def test_lru_does_not_cache_versions_json() -> None:
    """versions.json must not enter the LRU; it has its own TTL cache."""
    v = _view()
    v._cache_put(_VERSIONS_TAIL, b'{"version": 1}')
    assert _VERSIONS_TAIL not in v._lru
    assert v._versions_cache is not None


def test_lru_byte_accounting_counts_gzipped_bytes_only() -> None:
    """_lru_bytes must track gzipped size only, not raw+gzipped (issue #136)."""
    import gzip as _gzip

    v = _view()
    raw = b'{"t":1,"lat":47.4,"lon":8.5}' * 100  # ~2.8 KB — compresses well
    gz = _gzip.compress(raw, 6)

    v._cache_put(_ANIMATION_TAIL, gz)

    assert v._lru_bytes == len(gz), (
        f"_lru_bytes should equal gzipped size {len(gz)}, got {v._lru_bytes}"
    )
    assert v._lru_bytes < len(raw), "gzipped JSON must be smaller than raw"


def test_lru_sizes_attribute_absent() -> None:
    """_lru_sizes must not exist — it was the redundant parallel structure (#136)."""
    v = _view()
    assert not hasattr(v, "_lru_sizes"), (
        "_lru_sizes was dropped in #136; reintroducing it re-introduces the drift risk"
    )


def test_lru_overwrite_updates_byte_accounting() -> None:
    """Overwriting an existing LRU entry must subtract old gz size, add new gz size."""
    import gzip as _gzip

    v = _view()
    small_gz = _gzip.compress(b'{"v":1}', 6)
    large_gz = _gzip.compress(b'{"v":2}' * 1000, 6)

    v._cache_put(_ANIMATION_TAIL, small_gz)
    assert v._lru_bytes == len(small_gz)

    v._cache_put(_ANIMATION_TAIL, large_gz)
    assert v._lru_bytes == len(large_gz), (
        "overwrite must replace old accounting, not accumulate"
    )


# ---------------------------------------------------------------------------
# Tests: allowlist — all four legal path forms reach upstream (positive)
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("tail", [
    _VERSIONS_TAIL,
    _ANIMATION_TAIL,
    _RADAR_TAIL,
    _INCA_TAIL,
    _SNOW_TAIL,
    _SNOWRAIN_TAIL,
    _FREEZINGRAIN_TAIL,
    _LIGHTNING_TAIL,
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
    # Near-miss rejects for overlay type paths (issue #92)
    # Unknown precipitation type
    "product/output/inca/precipitation/type/hail/version__20240101_1200/hail_20240101_1200.json",
    # Cross-mismatched directory vs. filename (freezing-rain dir with snowrain file)
    "product/output/inca/precipitation/type/freezing-rain/version__20240101_1200/snowrain_20240101_1200.json",
    # Cross-mismatched: snowrain dir with snow file
    "product/output/inca/precipitation/type/snowrain/version__20240101_1200/snow_20240101_1200.json",
    # Cross-mismatched: snow dir with freezingrain file
    "product/output/inca/precipitation/type/snow/version__20240101_1200/freezingrain_20240101_1200.json",
    # Lightning with extra sub-path (e.g. language segment not in the pattern)
    "product/output/lightning/version__20240101_1200/de/lightning.json",
    # Lightning with wrong filename
    "product/output/lightning/version__20240101_1200/lightning_20240101_1200.json",
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


@pytest.mark.parametrize("tail", [
    _ANIMATION_TAIL,
    _RADAR_TAIL,
    _INCA_TAIL,
    _SNOW_TAIL,
    _SNOWRAIN_TAIL,
    _FREEZINGRAIN_TAIL,
    _LIGHTNING_TAIL,
])
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


# ---------------------------------------------------------------------------
# Tests: upstream request arguments (issue #77)
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("tail", [
    _VERSIONS_TAIL,
    _ANIMATION_TAIL,
    _RADAR_TAIL,
    _INCA_TAIL,
    _SNOW_TAIL,
    _SNOWRAIN_TAIL,
    _FREEZINGRAIN_TAIL,
    _LIGHTNING_TAIL,
])
def test_upstream_request_uses_correct_url_redirects_and_timeout(tail: str) -> None:
    """session.get must be called with the full upstream URL, allow_redirects=False,
    and the module-level timeout object — so removing any of those three args would
    be caught by the test suite (issue #77).
    """
    session, calls = _counting_upstream()
    v = _view()
    _inject_session(v, session)
    resp = _get(v, tail)
    assert resp.status == 200
    assert len(calls) == 1

    args, kwargs = calls[0]
    expected_url = f"https://www.meteoschweiz.admin.ch/{tail}"
    assert args == (expected_url,), f"wrong positional args to session.get: {args!r}"
    assert kwargs.get("allow_redirects") is False, (
        "allow_redirects=False must be passed; 3xx hardening depends on it"
    )
    assert kwargs.get("timeout") is _UPSTREAM_TIMEOUT, (
        "module-level _UPSTREAM_TIMEOUT must be passed to session.get"
    )


# ---------------------------------------------------------------------------
# Tests: MeteoSwissRadarCardView (issue #77)
# ---------------------------------------------------------------------------

def _card_view() -> MeteoSwissRadarCardView:
    return MeteoSwissRadarCardView()


def _get_card(view: MeteoSwissRadarCardView) -> _FakeResponse | _FakeFileResponse:
    request = MagicMock()
    return _run(view.get(request))


def test_card_view_no_cache_header() -> None:
    """Successful card response must carry Cache-Control: no-cache."""
    resp = _get_card(_card_view())
    assert resp.status == 200
    assert isinstance(resp, _FakeFileResponse)
    assert resp._explicit_headers.get("Cache-Control") == "no-cache"


def test_card_view_missing_file_returns_404(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """When the card file is absent on disk, the view must return 404."""
    monkeypatch.setattr(pathlib.Path, "is_file", lambda self: False)
    resp = _get_card(_card_view())
    assert resp.status == 404
    assert not isinstance(resp, _FakeFileResponse)


# ---------------------------------------------------------------------------
# Tests: async_unload_entry (issue #77)
# ---------------------------------------------------------------------------

def test_async_unload_entry_returns_true() -> None:
    """async_unload_entry must return True."""
    hass = MagicMock()
    hass.data = {}
    entry = MagicMock()
    result = _run(async_unload_entry(hass, entry))
    assert result is True


def test_async_unload_entry_removes_card_resource(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """async_unload_entry must remove the card's extra-JS URL exactly once."""
    removed: list[str] = []
    monkeypatch.setattr(
        _integration, "remove_extra_js_url", lambda hass, url: removed.append(url)
    )
    hass = MagicMock()
    hass.data = {_integration.DOMAIN: True}
    entry = MagicMock()

    _run(async_unload_entry(hass, entry))

    assert removed == ["/meteoswiss_radar/frontend/meteoswiss-radar-card.js"]
    assert _integration.DOMAIN not in hass.data
