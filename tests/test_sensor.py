"""Tests for the MeteoSwiss Radar nowcast sensor entities (sensor.py).

These tests run with stdlib + pytest only (no aiohttp, no HA installed):
sys.modules is patched by importing stubs_ha before importing the component.
"""

from __future__ import annotations

import json
import pathlib
from datetime import UTC, datetime
from unittest.mock import MagicMock

import tests.stubs_ha  # noqa: F401  (side-effect: registers sys.modules stubs)

from custom_components.meteoswiss_radar.nowcast_core import (
    RainNowcast,
    RainStatus,
)
from custom_components.meteoswiss_radar.sensor import (
    SENSORS,
    MeteoSwissRadarNowcastSensor,
    MeteoSwissRadarNowcastSensorDescription,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_coordinator(data: RainNowcast | None = None) -> MagicMock:
    coordinator = MagicMock()
    coordinator.data = data
    coordinator.manifest_generated_at = None
    coordinator.frame_failures = 0
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
    description: MeteoSwissRadarNowcastSensorDescription,
    coordinator: MagicMock | None = None,
    entry: MagicMock | None = None,
) -> MeteoSwissRadarNowcastSensor:
    if coordinator is None:
        coordinator = _make_coordinator()
    if entry is None:
        entry = _make_entry()
    return MeteoSwissRadarNowcastSensor(coordinator, entry, description)


def _desc(key: str) -> MeteoSwissRadarNowcastSensorDescription:
    return next(d for d in SENSORS if d.key == key)


# ---------------------------------------------------------------------------
# Tests: SENSORS tuple
# ---------------------------------------------------------------------------


def test_four_sensor_descriptions_defined() -> None:
    assert len(SENSORS) == 4


def test_sensor_description_keys() -> None:
    assert {d.key for d in SENSORS} == {
        "nowcast_status",
        "rain_in",
        "rain_start",
        "expected_dry_from",
    }


def test_sensor_descriptions_are_correct_type() -> None:
    for desc in SENSORS:
        assert isinstance(desc, MeteoSwissRadarNowcastSensorDescription)
        assert desc.value  # each description has a non-empty value field


# ---------------------------------------------------------------------------
# Tests: _update_value with None data
# ---------------------------------------------------------------------------


def test_update_value_none_data_sets_native_value_to_none() -> None:
    sensor = _make_sensor(_desc("nowcast_status"), _make_coordinator(data=None))
    assert sensor._attr_native_value is None


def test_update_value_none_data_sets_extra_state_attributes_to_none() -> None:
    sensor = _make_sensor(_desc("nowcast_status"), _make_coordinator(data=None))
    assert sensor._attr_extra_state_attributes is None


# ---------------------------------------------------------------------------
# Tests: _update_value for each sensor field
# ---------------------------------------------------------------------------


def test_update_value_status_converts_enum_to_string() -> None:
    data = _make_nowcast(status=RainStatus.DRY)
    sensor = _make_sensor(_desc("nowcast_status"), _make_coordinator(data=data))
    assert sensor._attr_native_value == "dry"


def test_update_value_status_approaching() -> None:
    data = _make_nowcast(status=RainStatus.APPROACHING)
    sensor = _make_sensor(_desc("nowcast_status"), _make_coordinator(data=data))
    assert sensor._attr_native_value == "approaching"


def test_update_value_status_active() -> None:
    data = _make_nowcast(status=RainStatus.ACTIVE)
    sensor = _make_sensor(_desc("nowcast_status"), _make_coordinator(data=data))
    assert sensor._attr_native_value == "active"


def test_update_value_status_unknown() -> None:
    data = _make_nowcast(status=RainStatus.UNKNOWN)
    sensor = _make_sensor(_desc("nowcast_status"), _make_coordinator(data=data))
    assert sensor._attr_native_value == "unknown"


def test_update_value_lead_time_minutes() -> None:
    data = _make_nowcast(lead_time_minutes=15)
    sensor = _make_sensor(_desc("rain_in"), _make_coordinator(data=data))
    assert sensor._attr_native_value == 15


def test_update_value_lead_time_minutes_none() -> None:
    data = _make_nowcast(lead_time_minutes=None)
    sensor = _make_sensor(_desc("rain_in"), _make_coordinator(data=data))
    assert sensor._attr_native_value is None


def test_update_value_event_start() -> None:
    ts = datetime(2024, 6, 1, 10, 0, tzinfo=UTC)
    data = _make_nowcast(event_start=ts)
    sensor = _make_sensor(_desc("rain_start"), _make_coordinator(data=data))
    assert sensor._attr_native_value == ts


def test_update_value_event_end() -> None:
    ts = datetime(2024, 6, 1, 11, 0, tzinfo=UTC)
    data = _make_nowcast(event_end=ts)
    sensor = _make_sensor(_desc("expected_dry_from"), _make_coordinator(data=data))
    assert sensor._attr_native_value == ts


# ---------------------------------------------------------------------------
# Tests: nowcast_status extra_state_attributes
# ---------------------------------------------------------------------------


def test_nowcast_status_attrs_with_full_data() -> None:
    ts_start = datetime(2024, 6, 1, 10, 0, tzinfo=UTC)
    ts_end = datetime(2024, 6, 1, 11, 0, tzinfo=UTC)
    ts_horizon = datetime(2024, 6, 1, 12, 0, tzinfo=UTC)
    ts_meas = datetime(2024, 6, 1, 9, 55, tzinfo=UTC)
    ts_manifest = datetime(2024, 6, 1, 9, 50, tzinfo=UTC)

    data = _make_nowcast(
        currently_wet=True,
        protection_active=True,
        event_start=ts_start,
        event_end=ts_end,
        event_end_open=False,
        forecast_horizon_end=ts_horizon,
        measurement_time=ts_meas,
        dry_window_minutes=30,
        warning_lead_minutes=30,
    )
    coordinator = _make_coordinator(data=data)
    coordinator.manifest_generated_at = ts_manifest
    coordinator.frame_failures = 2

    sensor = _make_sensor(_desc("nowcast_status"), coordinator)
    attrs = sensor._attr_extra_state_attributes
    assert attrs is not None
    assert attrs["currently_wet"] is True
    assert attrs["protection_active"] is True
    assert attrs["event_start"] == ts_start.isoformat()
    assert attrs["event_end"] == ts_end.isoformat()
    assert attrs["event_end_open"] is False
    assert attrs["forecast_horizon_end"] == ts_horizon.isoformat()
    assert attrs["measurement_time"] == ts_meas.isoformat()
    assert attrs["manifest_generated_at"] == ts_manifest.isoformat()
    assert attrs["frame_failures"] == 2
    assert attrs["warning_lead_minutes"] == 30
    assert attrs["dry_window_minutes"] == 30


def test_nowcast_status_attrs_null_timestamps_become_none() -> None:
    coordinator = _make_coordinator(data=_make_nowcast())
    coordinator.manifest_generated_at = None

    sensor = _make_sensor(_desc("nowcast_status"), coordinator)
    attrs = sensor._attr_extra_state_attributes
    assert attrs is not None
    assert attrs["event_start"] is None
    assert attrs["event_end"] is None
    assert attrs["forecast_horizon_end"] is None
    assert attrs["measurement_time"] is None
    assert attrs["manifest_generated_at"] is None


def test_non_status_sensor_does_not_set_extra_state_attributes() -> None:
    data = _make_nowcast(lead_time_minutes=10)
    sensor = _make_sensor(_desc("rain_in"), _make_coordinator(data=data))
    assert not hasattr(sensor, "_attr_extra_state_attributes")


# ---------------------------------------------------------------------------
# Tests: unique_id, _handle_coordinator_update
# ---------------------------------------------------------------------------


def test_unique_id_format() -> None:
    entry = _make_entry("entry-123")
    sensor = _make_sensor(_desc("nowcast_status"), entry=entry)
    assert sensor._attr_unique_id == "meteoswiss_radar_entry-123_nowcast_status"


def test_all_sensor_unique_ids_are_distinct() -> None:
    entry = _make_entry("e1")
    ids = [_make_sensor(d, entry=entry)._attr_unique_id for d in SENSORS]
    assert len(ids) == len(set(ids))


def test_handle_coordinator_update_refreshes_value() -> None:
    coordinator = _make_coordinator(data=_make_nowcast(status=RainStatus.DRY))
    sensor = _make_sensor(_desc("nowcast_status"), coordinator)
    assert sensor._attr_native_value == "dry"

    coordinator.data = _make_nowcast(status=RainStatus.ACTIVE)
    sensor._handle_coordinator_update()
    assert sensor._attr_native_value == "active"


# ---------------------------------------------------------------------------
# Tests: the status sensor is a translatable enum
# ---------------------------------------------------------------------------

def test_status_sensor_options_cover_every_rain_status() -> None:
    """A state missing from `options` is rejected by HA as an invalid enum value.

    The options list is derived from RainStatus, so this guards the pairing: a
    new status that is not also a translated state would ship as a raw slug.
    """
    description = next(d for d in SENSORS if d.key == "nowcast_status")

    assert str(description.device_class) == "enum"
    assert set(description.options) == {s.value for s in RainStatus}


def test_status_sensor_states_are_translated_in_every_language() -> None:
    """Every status needs a `state` entry in strings.json and all translations.

    Without it the frontend falls back to the raw slug, which is what this repo
    shipped before: `dry` in German, French and Italian alike.
    """
    root = pathlib.Path(__file__).resolve().parents[1]
    base = root / "custom_components" / "meteoswiss_radar"
    expected = {s.value for s in RainStatus}

    for name in ("strings.json", *(f"translations/{lang}.json"
                                   for lang in ("de", "en", "fr", "it"))):
        payload = json.loads((base / name).read_text(encoding="utf-8"))
        states = payload["entity"]["sensor"]["nowcast_status"].get("state", {})
        assert set(states) == expected, f"{name} is missing status translations"
        assert all(
            text.strip() for text in states.values()
        ), f"{name} has an empty state"


def test_rain_in_has_no_state_class() -> None:
    """Long-term statistics over a countdown that is mostly unknown is noise."""
    description = next(d for d in SENSORS if d.key == "rain_in")

    assert description.state_class is None
