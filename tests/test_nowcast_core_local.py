"""Focused regression tests for local rain-event logic (stdlib only)."""

from __future__ import annotations

import importlib.util
import json
import sys
from datetime import UTC, datetime, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MODULE_PATH = ROOT / "custom_components" / "meteoswiss_radar" / "nowcast_core.py"
spec = importlib.util.spec_from_file_location("meteoswiss_radar_nowcast_core", MODULE_PATH)
assert spec and spec.loader
core = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = core
spec.loader.exec_module(core)

NOW = datetime(2026, 9, 4, 18, 0, tzinfo=UTC)


def forecast(values, start=10):
    return [
        core.RainSample(NOW + timedelta(minutes=start + index * 10), value, "forecast")
        for index, value in enumerate(values)
    ]


def measurement(wet):
    return core.RainSample(NOW, wet, "measurement")


def main() -> None:
    result = core.evaluate_nowcast(
        now=NOW,
        measurement=measurement(False),
        forecast_samples=forecast([False] * 6),
    )
    assert result.status == core.RainStatus.DRY
    assert result.protection_active is False

    result = core.evaluate_nowcast(
        now=NOW,
        measurement=measurement(False),
        forecast_samples=forecast([False, True, True, False, False, False, False]),
    )
    assert result.status == core.RainStatus.APPROACHING
    assert result.lead_time_minutes == 20
    assert result.event_end == NOW + timedelta(minutes=40)

    previous = core.RainNowcast(
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
    # A 20-minute dry interruption (50/60/70 followed by rain at 80) is NOT
    # enough to end the rain event.
    result = core.evaluate_nowcast(
        now=NOW,
        measurement=measurement(False),
        forecast_samples=forecast([False, True, True, True, False, False, False, True]),
        previous=previous,
    )
    assert result.status == core.RainStatus.ACTIVE
    assert result.event_end is None

    # Four explicit dry frames from 50 through 80 span a full 30 minutes and
    # therefore establish an event end at 50.
    result = core.evaluate_nowcast(
        now=NOW,
        measurement=measurement(False),
        forecast_samples=forecast([False, True, True, True, False, False, False, False]),
        previous=previous,
    )
    assert result.status == core.RainStatus.ACTIVE
    assert result.event_end == NOW + timedelta(minutes=50)

    # If it is dry now and the forecast remains dry through +30 min, the active
    # event is cleared immediately; we do not wait 30 real-time minutes.
    result = core.evaluate_nowcast(
        now=NOW,
        measurement=measurement(False),
        forecast_samples=forecast([False, False, False]),
        previous=previous,
    )
    assert result.status == core.RainStatus.DRY
    assert result.protection_active is False

    # Missing current measurement must never create a false all-clear.
    result = core.evaluate_nowcast(
        now=NOW,
        measurement=None,
        forecast_samples=forecast([False, False, False, False]),
        previous=previous,
    )
    assert result.status == core.RainStatus.ACTIVE

    x_km, y_km = core.wgs84_to_grid_km(47.4515, 8.584)
    assert 680 < x_km < 690
    assert 250 < y_km < 260

    # Use the upstream project's real committed frame fixture so the test also
    # locks the exact nesting of areas -> shapes -> contours.  This specifically
    # prevents the extra-list regression that the first installer exposed.
    fixture = json.loads(
        (ROOT / "tests" / "fixtures" / "frame.json").read_text(encoding="utf-8")
    )
    assert core.frame_is_wet_at_grid_point(fixture, 610.3328, 160.6157)
    assert not core.frame_is_wet_at_grid_point(fixture, 800.0, 400.0)

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

    print("Nowcast core tests: OK")


if __name__ == "__main__":
    main()
