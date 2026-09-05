"""Focused regression tests for local rain-event logic (stdlib only)."""

from __future__ import annotations

import importlib.util
import json
import sys
from datetime import UTC, datetime, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MODULE_PATH = ROOT / "custom_components" / "meteoswiss_radar" / "nowcast_core.py"
spec = importlib.util.spec_from_file_location(
    "meteoswiss_radar_nowcast_core",
    MODULE_PATH,
)
assert spec and spec.loader
core = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = core
spec.loader.exec_module(core)

NOW = datetime(2026, 9, 4, 18, 0, tzinfo=UTC)


def forecast(values, start=10):
    """Build 10-minute forecast samples from boolean/unknown values."""
    return [
        core.RainSample(
            NOW + timedelta(minutes=start + index * 10),
            value,
            "forecast",
        )
        for index, value in enumerate(values)
    ]


def measurement(wet):
    """Build one current measurement sample."""
    return core.RainSample(NOW, wet, "measurement")


def previous_active():
    """Return a representative previously active rain event."""
    return core.RainNowcast(
        core.RainStatus.ACTIVE,
        True,
        True,
        NOW - timedelta(minutes=20),
        None,
        True,
        None,
        NOW + timedelta(hours=1),
        NOW - timedelta(minutes=5),
        30,
        30,
    )


def test_dry_forecast_is_dry() -> None:
    result = core.evaluate_nowcast(
        now=NOW,
        measurement=measurement(False),
        forecast_samples=forecast([False] * 6),
    )

    assert result.status == core.RainStatus.DRY
    assert result.protection_active is False


def test_rain_within_warning_window_is_approaching() -> None:
    result = core.evaluate_nowcast(
        now=NOW,
        measurement=measurement(False),
        forecast_samples=forecast(
            [False, True, True, False, False, False, False]
        ),
    )

    assert result.status == core.RainStatus.APPROACHING
    assert result.lead_time_minutes == 20
    assert result.event_end == NOW + timedelta(minutes=40)


def test_short_dry_gap_does_not_end_active_event() -> None:
    result = core.evaluate_nowcast(
        now=NOW,
        measurement=measurement(False),
        forecast_samples=forecast(
            [False, True, True, True, False, False, False, True]
        ),
        previous=previous_active(),
    )

    assert result.status == core.RainStatus.ACTIVE
    assert result.event_end is None


def test_confirmed_dry_window_sets_event_end() -> None:
    result = core.evaluate_nowcast(
        now=NOW,
        measurement=measurement(False),
        forecast_samples=forecast(
            [False, True, True, True, False, False, False, False]
        ),
        previous=previous_active(),
    )

    assert result.status == core.RainStatus.ACTIVE
    assert result.event_end == NOW + timedelta(minutes=50)


def test_dry_window_from_now_clears_active_event() -> None:
    result = core.evaluate_nowcast(
        now=NOW,
        measurement=measurement(False),
        forecast_samples=forecast([False, False, False]),
        previous=previous_active(),
    )

    assert result.status == core.RainStatus.DRY
    assert result.protection_active is False


def test_missing_measurement_does_not_clear_active_event() -> None:
    result = core.evaluate_nowcast(
        now=NOW,
        measurement=None,
        forecast_samples=forecast([False, False, False, False]),
        previous=previous_active(),
    )

    assert result.status == core.RainStatus.ACTIVE
    assert result.protection_active is True


def test_wgs84_conversion_matches_swiss_radar_grid() -> None:
    x_km, y_km = core.wgs84_to_grid_km(47.4515, 8.584)

    assert 680 < x_km < 690
    assert 250 < y_km < 260


def test_real_fixture_geometry_contains_known_point() -> None:
    fixture = json.loads(
        (ROOT / "tests" / "fixtures" / "frame.json").read_text(encoding="utf-8")
    )

    assert core.frame_is_wet_at_grid_point(fixture, 610.3328, 160.6157)
    assert not core.frame_is_wet_at_grid_point(fixture, 800.0, 400.0)


def test_non_precipitation_color_does_not_count_as_rain() -> None:
    fixture = json.loads(
        (ROOT / "tests" / "fixtures" / "frame.json").read_text(encoding="utf-8")
    )
    neutral = {
        "coords": fixture["coords"],
        "areas": [
            {
                "color": "ffffff",
                "shapes": fixture["areas"][0]["shapes"],
            }
        ],
    }

    assert not core.frame_is_wet_at_grid_point(neutral, 610.3328, 160.6157)
