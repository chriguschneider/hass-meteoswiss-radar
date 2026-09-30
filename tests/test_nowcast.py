"""Unit tests for MeteoSwiss nowcast coordinator manifest parsing and data update.

These tests run with stdlib + pytest only (no aiohttp, no HA installed):
sys.modules is patched before importing the component so all HA/aiohttp
imports resolve to lightweight stubs.
"""

from __future__ import annotations

import asyncio
import json
import pathlib
import sys
from contextlib import asynccontextmanager
from datetime import UTC, datetime, timedelta
from types import ModuleType
from unittest.mock import MagicMock

import pytest


# ---------------------------------------------------------------------------
# Minimal stubs — built once at collection time, registered into sys.modules.
# ---------------------------------------------------------------------------

class _ClientError(Exception):
    """Stand-in for aiohttp.ClientError."""


class _FakeWeb:
    class Response:
        def __init__(self, **kwargs):  # noqa: ANN003
            self.status = kwargs.get("status", 200)
            self.body = kwargs.get("body", b"")


def _make_stubs() -> dict[str, ModuleType]:
    aiohttp = ModuleType("aiohttp")
    aiohttp.ClientError = _ClientError  # type: ignore[attr-defined]
    aiohttp.ClientTimeout = MagicMock(return_value=object())  # type: ignore[attr-defined]
    aiohttp.web = _FakeWeb  # type: ignore[attr-defined]

    ha = ModuleType("homeassistant")
    ha_core = ModuleType("homeassistant.core")
    ha_core.HomeAssistant = object  # type: ignore[attr-defined]
    ha_comp = ModuleType("homeassistant.components")
    ha_http = ModuleType("homeassistant.components.http")

    class _HAView:
        pass

    ha_http.HomeAssistantView = _HAView  # type: ignore[attr-defined]

    ha_frontend = ModuleType("homeassistant.components.frontend")
    ha_frontend.add_extra_js_url = lambda *a, **kw: None  # type: ignore[attr-defined]
    ha_frontend.remove_extra_js_url = lambda *a, **kw: None  # type: ignore[attr-defined]

    ha_cfg = ModuleType("homeassistant.config_entries")
    ha_cfg.ConfigEntry = object  # type: ignore[attr-defined]

    ha_update = ModuleType("homeassistant.helpers.update_coordinator")

    class _UpdateFailed(Exception):
        pass

    class _DataUpdateCoordinator:
        def __init__(self, hass, logger, name, update_interval):
            self.hass = hass
            self.data = None

        def __class_getitem__(cls, item):  # noqa: ANN003
            return cls

    ha_update.UpdateFailed = _UpdateFailed  # type: ignore[attr-defined]
    ha_update.DataUpdateCoordinator = _DataUpdateCoordinator  # type: ignore[attr-defined]

    ha_helpers = ModuleType("homeassistant.helpers")
    ha_client = ModuleType("homeassistant.helpers.aiohttp_client")
    ha_client.async_get_clientsession = MagicMock()  # type: ignore[attr-defined]

    return {
        "aiohttp": aiohttp,
        "homeassistant": ha,
        "homeassistant.components": ha_comp,
        "homeassistant.components.http": ha_http,
        "homeassistant.components.frontend": ha_frontend,
        "homeassistant.config_entries": ha_cfg,
        "homeassistant.core": ha_core,
        "homeassistant.helpers": ha_helpers,
        "homeassistant.helpers.update_coordinator": ha_update,
        "homeassistant.helpers.aiohttp_client": ha_client,
    }


_STUBS = _make_stubs()
for _name, _mod in _STUBS.items():
    sys.modules.setdefault(_name, _mod)

# Import after stubs are in place.
from custom_components.meteoswiss_radar import MeteoSwissRadarProxyView  # noqa: E402
from custom_components.meteoswiss_radar.nowcast import (  # noqa: E402
    MEASUREMENT_MAX_AGE,
    _flatten_pictures,
    _forecast_frames,
    _latest_measurement,
    _manifest_generated_at,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _fixture_animation() -> dict:
    """Load the animation.json fixture."""
    fixture_path = (
        pathlib.Path(__file__).parent / "fixtures" / "animation.json"
    )
    with open(fixture_path) as f:
        return json.load(f)


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


def _inject_session(view: MeteoSwissRadarProxyView, session: object) -> None:
    """Point async_get_clientsession at our fake session for this call."""
    ha_client = _STUBS["homeassistant.helpers.aiohttp_client"]
    ha_client.async_get_clientsession.return_value = session


def _run(coro):  # noqa: ANN001
    return asyncio.run(coro)


# ---------------------------------------------------------------------------
# Tests: Manifest helpers
# ---------------------------------------------------------------------------

def test_flatten_pictures_extracts_all_pictures() -> None:
    manifest = _fixture_animation()
    pictures = _flatten_pictures(manifest)
    assert len(pictures) == 5
    assert all("timestamp" in pic for pic in pictures)


def test_flatten_pictures_sorts_by_timestamp() -> None:
    manifest = _fixture_animation()
    pictures = _flatten_pictures(manifest)
    timestamps = [float(pic["timestamp"]) for pic in pictures]
    assert timestamps == sorted(timestamps)


def test_flatten_pictures_filters_missing_timestamp() -> None:
    manifest = {
        "map_images": [
            {
                "pictures": [
                    {"data_type": "measurement", "timestamp": 1704114000},
                    {"data_type": "measurement"},  # missing timestamp
                    {"data_type": "forecast", "timestamp": 1704114600},
                ]
            }
        ]
    }
    pictures = _flatten_pictures(manifest)
    assert len(pictures) == 2


def test_flatten_pictures_handles_empty_manifest() -> None:
    manifest = {"map_images": []}
    pictures = _flatten_pictures(manifest)
    assert len(pictures) == 0


def test_flatten_pictures_handles_missing_map_images() -> None:
    manifest = {}
    pictures = _flatten_pictures(manifest)
    assert len(pictures) == 0


def test_latest_measurement_returns_most_recent_measurement() -> None:
    manifest = _fixture_animation()
    pictures = _flatten_pictures(manifest)
    # Use now such that now_ts (which adds 60s) still includes the latest measurement
    now = datetime(2024, 1, 1, 12, 4, 0, tzinfo=UTC)
    measurement = _latest_measurement(pictures, now)
    assert measurement is not None
    assert measurement.get("data_type") == "measurement"
    assert measurement.get("timestamp") == 1704110700


def test_latest_measurement_returns_none_if_no_measurement() -> None:
    manifest = {
        "map_images": [
            {
                "pictures": [
                    {"data_type": "forecast", "timestamp": 1704111000},
                ]
            }
        ]
    }
    pictures = _flatten_pictures(manifest)
    now = datetime(2024, 1, 1, 12, 5, 0, tzinfo=UTC)
    measurement = _latest_measurement(pictures, now)
    assert measurement is None


def test_latest_measurement_ignores_future_measurements() -> None:
    # now_ts = now.timestamp() + 60.0, so use a time early enough that
    # both measurements are in future
    now = datetime(2024, 1, 1, 11, 58, 0, tzinfo=UTC)
    pictures = [
        {"data_type": "measurement", "timestamp": 1704110400, "radar_url": "/path/1"},
        {"data_type": "measurement", "timestamp": 1704110700, "radar_url": "/path/2"},
    ]
    measurement = _latest_measurement(pictures, now)
    assert measurement is None


def test_latest_measurement_ignores_missing_radar_url() -> None:
    pictures = [
        {"data_type": "measurement", "timestamp": 1704110400},
        {"data_type": "measurement", "timestamp": 1704110700, "radar_url": "/path/2"},
    ]
    now = datetime(2024, 1, 1, 12, 4, 0, tzinfo=UTC)
    measurement = _latest_measurement(pictures, now)
    assert measurement is not None
    assert measurement.get("timestamp") == 1704110700  # Only this one has radar_url


def test_forecast_frames_returns_frames_in_range() -> None:
    manifest = _fixture_animation()
    pictures = _flatten_pictures(manifest)
    # start_ts = start.timestamp() - 60.0, so use start that includes the
    # first forecast frame
    start = datetime(2024, 1, 1, 12, 10, 0, tzinfo=UTC)
    end = datetime(2024, 1, 1, 12, 25, 0, tzinfo=UTC)
    frames = _forecast_frames(pictures, start, end)
    assert len(frames) == 2
    assert all(f.get("data_type") == "forecast" for f in frames)


def test_forecast_frames_excludes_measurements() -> None:
    manifest = _fixture_animation()
    pictures = _flatten_pictures(manifest)
    start = datetime(2024, 1, 1, 12, 0, 0, tzinfo=UTC)
    end = datetime(2024, 1, 1, 13, 0, 0, tzinfo=UTC)
    frames = _forecast_frames(pictures, start, end)
    assert all(f.get("data_type") == "forecast" for f in frames)


def test_forecast_frames_ignores_missing_radar_url() -> None:
    pictures = [
        {"data_type": "forecast", "timestamp": 1704111000},
        {"data_type": "forecast", "timestamp": 1704111600, "radar_url": "/path/2"},
    ]
    start = datetime(2024, 1, 1, 12, 8, 0, tzinfo=UTC)
    end = datetime(2024, 1, 1, 13, 0, 0, tzinfo=UTC)
    frames = _forecast_frames(pictures, start, end)
    assert len(frames) == 1


def test_forecast_frames_empty_outside_range() -> None:
    manifest = _fixture_animation()
    pictures = _flatten_pictures(manifest)
    start = datetime(2024, 1, 2, 0, 0, 0, tzinfo=UTC)
    end = datetime(2024, 1, 2, 1, 0, 0, tzinfo=UTC)
    frames = _forecast_frames(pictures, start, end)
    assert len(frames) == 0


def test_manifest_generated_at_returns_datetime() -> None:
    manifest = _fixture_animation()
    ts = _manifest_generated_at(manifest)
    assert isinstance(ts, datetime)
    assert ts.tzinfo == UTC
    assert ts.timestamp() == 1704110400


def test_manifest_generated_at_returns_none_if_missing() -> None:
    manifest = {}
    ts = _manifest_generated_at(manifest)
    assert ts is None


def test_manifest_generated_at_returns_none_if_invalid() -> None:
    manifest = {"config": {"timestamp": "invalid"}}
    ts = _manifest_generated_at(manifest)
    assert ts is None


def test_manifest_generated_at_handles_invalid_timestamp() -> None:
    manifest = {"config": {"timestamp": None}}
    ts = _manifest_generated_at(manifest)
    assert ts is None


# ---------------------------------------------------------------------------
# Tests: async_get_json
# ---------------------------------------------------------------------------

def test_async_get_json_parses_json() -> None:
    v = _view()
    payload = json.dumps({"version": "20240101_1200"}).encode()
    _inject_session(v, _fake_upstream(body=payload))

    result = _run(v.async_get_json("product/output/versions.json"))
    assert result == {"version": "20240101_1200"}


def test_async_get_json_gunzips_non_versions_json() -> None:
    v = _view()
    payload = json.dumps({"frames": []}).encode()
    # Upstream returns raw data; _fetch_and_cache compresses it before caching
    _inject_session(v, _fake_upstream(body=payload))

    result = _run(v.async_get_json(
        "product/output/precipitation/animation/version__20240101_1200/de/animation.json"
    ))
    assert result == {"frames": []}


def test_async_get_json_disallowed_path_raises() -> None:
    v = _view()
    with pytest.raises(ValueError, match="not allowlisted"):
        _run(v.async_get_json("product/output/unknown/file.json"))


def test_async_get_json_non_200_status_raises() -> None:
    v = _view()
    _inject_session(v, _fake_upstream(status=502))

    with pytest.raises(RuntimeError, match="HTTP 502"):
        _run(v.async_get_json("product/output/versions.json"))


def test_async_get_json_invalid_json_raises() -> None:
    v = _view()
    _inject_session(v, _fake_upstream(body=b"invalid json"))

    with pytest.raises(RuntimeError, match="Invalid.*JSON"):
        _run(v.async_get_json("product/output/versions.json"))


def test_async_get_json_non_dict_json_raises() -> None:
    v = _view()
    _inject_session(v, _fake_upstream(body=b'["array", "not", "dict"]'))

    with pytest.raises(RuntimeError, match="Unexpected.*JSON type"):
        _run(v.async_get_json("product/output/versions.json"))


def test_async_get_json_concurrent_requests_deduplicate() -> None:
    """Two concurrent calls for the same tail produce one upstream fetch."""
    v = _view()
    calls: list = []

    class _CountingContent:
        async def iter_chunked(self, size: int):  # noqa: ANN001
            yield json.dumps({"version": "1"}).encode()

    @asynccontextmanager
    async def _counting_get(*_a, **_kw):
        calls.append(1)
        await asyncio.sleep(0)  # yield so both tasks can start
        resp = MagicMock()
        resp.status = 200
        resp.headers = {"Content-Type": "application/json"}
        resp.content = _CountingContent()
        yield resp

    session = MagicMock()
    session.get = _counting_get
    _inject_session(v, session)

    async def _run_concurrent() -> None:
        results = await asyncio.gather(
            v.async_get_json("product/output/versions.json"),
            v.async_get_json("product/output/versions.json"),
        )
        assert all(r == {"version": "1"} for r in results)

    _run(_run_concurrent())
    assert len(calls) == 1, "expected exactly one upstream fetch"


# ---------------------------------------------------------------------------
# Tests: Staleness conversion
# ---------------------------------------------------------------------------

def test_measurement_staleness_sets_wet_to_none() -> None:
    """Measurement older than MEASUREMENT_MAX_AGE becomes wet=None."""
    from custom_components.meteoswiss_radar.nowcast_core import RainSample

    # A measurement from 20 minutes ago
    old_timestamp = datetime.now(UTC) - timedelta(minutes=20)
    measurement = RainSample(timestamp=old_timestamp, wet=True, source="measurement")

    # Simulate the staleness check from _async_update_data
    now = datetime.now(UTC)
    if measurement is not None and now - measurement.timestamp > MEASUREMENT_MAX_AGE:
        stale_measurement = RainSample(
            timestamp=measurement.timestamp,
            wet=None,
            source=measurement.source,
        )
    else:
        stale_measurement = measurement

    assert stale_measurement.wet is None
    assert stale_measurement.timestamp == measurement.timestamp
    assert stale_measurement.source == measurement.source


def test_measurement_freshness_keeps_wet_status() -> None:
    """Measurement within MEASUREMENT_MAX_AGE keeps its wet status."""
    from custom_components.meteoswiss_radar.nowcast_core import RainSample

    # A measurement from 10 minutes ago
    recent_timestamp = datetime.now(UTC) - timedelta(minutes=10)
    measurement = RainSample(timestamp=recent_timestamp, wet=True, source="measurement")

    # Simulate the staleness check from _async_update_data
    now = datetime.now(UTC)
    if measurement is not None and now - measurement.timestamp > MEASUREMENT_MAX_AGE:
        processed = RainSample(
            timestamp=measurement.timestamp,
            wet=None,
            source=measurement.source,
        )
    else:
        processed = measurement

    assert processed.wet is True


def test_measurement_max_age_constant() -> None:
    """MEASUREMENT_MAX_AGE must be 15 minutes."""
    assert MEASUREMENT_MAX_AGE == timedelta(minutes=15)
