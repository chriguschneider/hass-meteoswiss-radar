"""Tests for diagnostics.py (stdlib + pytest only; HA is stubbed)."""

from __future__ import annotations

import asyncio
import json
from datetime import UTC, datetime
from types import SimpleNamespace
from unittest.mock import patch

import tests.stubs_ha  # noqa: F401  (side-effect: registers sys.modules stubs)

from custom_components.meteoswiss_radar import diagnostics
from custom_components.meteoswiss_radar.const import DATA_NOWCAST, VERSION
from custom_components.meteoswiss_radar.nowcast_core import RainNowcast, RainStatus

# Synthetic on purpose: a recognisable home location that must never appear.
LAT, LON = 46.94812, 7.44741


def _nowcast() -> RainNowcast:
    return RainNowcast(
        status=RainStatus.APPROACHING,
        protection_active=True,
        currently_wet=False,
        event_start=datetime(2026, 9, 1, 12, 0, tzinfo=UTC),
        event_end=None,
        event_end_open=True,
        lead_time_minutes=10,
        forecast_horizon_end=datetime(2026, 9, 1, 14, 0, tzinfo=UTC),
        measurement_time=datetime(2026, 9, 1, 11, 50, tzinfo=UTC),
        dry_window_minutes=30,
        warning_lead_minutes=30,
    )


def _hass(coordinator=None, *, with_location: bool = True):
    data = {}
    if coordinator is not None:
        data[DATA_NOWCAST] = {"eid": {"nowcast_coordinator": coordinator}}
    config = SimpleNamespace(
        latitude=LAT if with_location else None,
        longitude=LON if with_location else None,
    )
    return SimpleNamespace(data=data, config=config)


def _entry(options):
    return SimpleNamespace(
        entry_id="eid", title="MeteoSwiss Radar", version=1, options=options
    )


def _run(hass, entry, enabled):
    with patch.object(diagnostics, "nowcast_entities_enabled", return_value=enabled):
        return asyncio.run(diagnostics.async_get_config_entry_diagnostics(hass, entry))


def test_nowcast_disabled_and_no_home_location():
    result = _run(_hass(with_location=False), _entry({}), False)
    assert result["nowcast_enabled"] is False
    assert result["nowcast"] is None
    assert result["version"] == VERSION
    json.dumps(result)


def test_nowcast_state_is_plain_json():
    coordinator = SimpleNamespace(
        data=_nowcast(),
        last_update_success=True,
        last_update_success_time=datetime(2026, 9, 1, 11, 55, tzinfo=UTC),
        manifest_generated_at=None,
        frame_failures=2,
        location_in_radar_coverage=True,
    )
    result = _run(_hass(coordinator), _entry({"protection_min_hold_minutes": 15}), True)
    dump = json.loads(json.dumps(result))
    assert dump["nowcast_enabled"] is True
    assert dump["entry"]["options"] == {"protection_min_hold_minutes": 15}
    assert dump["nowcast"]["last_update_success"] is True
    assert dump["nowcast"]["last_update_time"] == "2026-09-01T11:55:00+00:00"
    assert dump["nowcast"]["data"]["status"] == RainStatus.APPROACHING.value
    assert dump["nowcast"]["data"]["event_start"] == "2026-09-01T12:00:00+00:00"


def test_location_never_leaks():
    options = {
        "latitude": LAT,
        "longitude": LON,
        "zone": "zone.home",
        "home": {"coordinates": [LAT, LON]},
        "link": "https://example.invalid/?lat=46.94812",
        "weather_entity_id": "weather.home",
    }
    coordinator = SimpleNamespace(
        data=_nowcast(), last_update_success=True, frame_failures=0
    )
    result = _run(_hass(coordinator), _entry(options), True)
    dump = json.dumps(result)
    assert str(LAT) not in dump
    assert str(LON) not in dump
    assert "zone.home" not in dump
    assert "example.invalid" not in dump
    assert result["entry"]["options"]["weather_entity_id"] == "weather.home"
