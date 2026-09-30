"""Tests for the MeteoSwiss Radar rain-protection binary sensor (binary_sensor.py).

These tests run with stdlib + pytest only (no aiohttp, no HA installed):
sys.modules is patched by importing stubs_ha before importing the component.
"""

from __future__ import annotations

from datetime import UTC, datetime
from unittest.mock import MagicMock

import tests.stubs_ha  # noqa: F401  (side-effect: registers sys.modules stubs)

from custom_components.meteoswiss_radar.binary_sensor import (
    MeteoSwissRadarRainProtectionBinarySensor,
)
from custom_components.meteoswiss_radar.nowcast_core import (
    RainNowcast,
    RainStatus,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_coordinator(data: RainNowcast | None = None) -> MagicMock:
    coordinator = MagicMock()
    coordinator.data = data
    return coordinator


def _make_entry(entry_id: str = "test-entry") -> MagicMock:
    entry = MagicMock()
    entry.entry_id = entry_id
    return entry


def _make_nowcast(**overrides: object) -> RainNowcast:
    defaults: dict = dict(
        status=RainStatus.DRY,
        protection_active=False,
        currently_wet=False,
        event_start=None,
        event_end=None,
        event_end_open=False,
        lead_time_minutes=None,
        forecast_horizon_end=None,
        measurement_time=None,
        dry_window_minutes=30,
        warning_lead_minutes=30,
    )
    defaults.update(overrides)
    return RainNowcast(**defaults)


def _make_sensor(
    coordinator: MagicMock | None = None,
    entry: MagicMock | None = None,
) -> MeteoSwissRadarRainProtectionBinarySensor:
    if coordinator is None:
        coordinator = _make_coordinator()
    if entry is None:
        entry = _make_entry()
    return MeteoSwissRadarRainProtectionBinarySensor(coordinator, entry)


# ---------------------------------------------------------------------------
# Tests: is_on
# ---------------------------------------------------------------------------


def test_is_on_returns_none_when_data_is_none() -> None:
    sensor = _make_sensor(_make_coordinator(data=None))
    assert sensor.is_on is None


def test_is_on_false_when_protection_not_active() -> None:
    data = _make_nowcast(status=RainStatus.DRY, protection_active=False)
    sensor = _make_sensor(_make_coordinator(data=data))
    assert sensor.is_on is False


def test_is_on_true_when_protection_active() -> None:
    data = _make_nowcast(status=RainStatus.ACTIVE, protection_active=True)
    sensor = _make_sensor(_make_coordinator(data=data))
    assert sensor.is_on is True


def test_is_on_true_for_approaching_status() -> None:
    data = _make_nowcast(status=RainStatus.APPROACHING, protection_active=True)
    sensor = _make_sensor(_make_coordinator(data=data))
    assert sensor.is_on is True


def test_is_on_none_for_unknown_protection() -> None:
    data = _make_nowcast(status=RainStatus.UNKNOWN, protection_active=None)
    sensor = _make_sensor(_make_coordinator(data=data))
    assert sensor.is_on is None


# ---------------------------------------------------------------------------
# Tests: extra_state_attributes
# ---------------------------------------------------------------------------


def test_extra_state_attributes_empty_dict_when_data_is_none() -> None:
    sensor = _make_sensor(_make_coordinator(data=None))
    assert sensor.extra_state_attributes == {}


def test_extra_state_attributes_status_value() -> None:
    data = _make_nowcast(status=RainStatus.ACTIVE)
    sensor = _make_sensor(_make_coordinator(data=data))
    assert sensor.extra_state_attributes["status"] == "active"


def test_extra_state_attributes_full_payload() -> None:
    ts_start = datetime(2024, 6, 1, 10, 0, tzinfo=UTC)
    ts_end = datetime(2024, 6, 1, 11, 0, tzinfo=UTC)
    data = _make_nowcast(
        status=RainStatus.ACTIVE,
        protection_active=True,
        currently_wet=True,
        lead_time_minutes=0,
        event_start=ts_start,
        event_end=ts_end,
        event_end_open=False,
        warning_lead_minutes=30,
        dry_window_minutes=30,
    )
    attrs = _make_sensor(_make_coordinator(data=data)).extra_state_attributes

    assert attrs["status"] == "active"
    assert attrs["currently_wet"] is True
    assert attrs["rain_in_minutes"] == 0
    assert attrs["event_start"] == ts_start.isoformat()
    assert attrs["event_end"] == ts_end.isoformat()
    assert attrs["event_end_open"] is False
    assert attrs["warning_lead_minutes"] == 30
    assert attrs["dry_window_minutes"] == 30


def test_extra_state_attributes_null_timestamps() -> None:
    data = _make_nowcast()
    attrs = _make_sensor(_make_coordinator(data=data)).extra_state_attributes
    assert attrs["event_start"] is None
    assert attrs["event_end"] is None


# ---------------------------------------------------------------------------
# Tests: unique_id and coordinator wiring
# ---------------------------------------------------------------------------


def test_unique_id_format() -> None:
    entry = _make_entry("entry-456")
    sensor = _make_sensor(entry=entry)
    assert sensor._attr_unique_id == "meteoswiss_radar_entry-456_rain_protection"


def test_handle_coordinator_update_writes_ha_state() -> None:
    sensor = _make_sensor()
    writes: list = []
    sensor.async_write_ha_state = lambda: writes.append(1)
    sensor._handle_coordinator_update()
    assert writes == [1]
