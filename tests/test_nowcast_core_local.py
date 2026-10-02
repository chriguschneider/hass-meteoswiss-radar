"""Focused regression tests for local rain-event logic (stdlib only)."""

from __future__ import annotations

import importlib.util
import json
import struct
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
LEGEND = json.loads(
    (ROOT / "tests" / "fixtures" / "animation.json").read_text(encoding="utf-8")
)["legend"]


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


def test_event_end_beyond_2h_cap_is_suppressed_while_active() -> None:
    # Wet frames fill the 2-hour window; dry window starts at +130 min (>2 h).
    samples = forecast([True] * 12 + [False] * 4, start=10)
    result = core.evaluate_nowcast(
        now=NOW,
        measurement=measurement(True),
        forecast_samples=samples,
        previous=previous_active(),
    )

    assert result.status == core.RainStatus.ACTIVE
    assert result.event_end is None
    assert result.event_end_open is True


def test_event_end_within_2h_cap_is_reported_while_active() -> None:
    # Dry window starts at +50 min, well within the 2-hour cap.
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
    assert result.event_end_open is False


def test_event_end_beyond_2h_cap_is_suppressed_while_approaching() -> None:
    # Rain at +20 min; dry window starts at +130 min (>2 h from NOW).
    samples = [
        core.RainSample(NOW + timedelta(minutes=10), False, "forecast"),
        *[
            core.RainSample(NOW + timedelta(minutes=10 + i * 10), True, "forecast")
            for i in range(1, 13)
        ],
        *[
            core.RainSample(NOW + timedelta(minutes=130 + i * 10), False, "forecast")
            for i in range(4)
        ],
    ]
    result = core.evaluate_nowcast(
        now=NOW,
        measurement=measurement(False),
        forecast_samples=samples,
    )

    assert result.status == core.RainStatus.APPROACHING
    assert result.event_end is None
    assert result.event_end_open is True


def _grid_km_to_latlng(x_km: float, y_km: float) -> tuple[float, float]:
    """CH1903 grid km -> WGS84 (swisstopo approximation, FORMAT.md §Basemap).

    Mirror of gridKmToLatLng in meteoswiss-radar-card.js and grid_km_to_latlng
    in tests/tools/reference_decode.py. Kept here (not in production code) so
    the cross-check and round-trip tests share the inverse formula without
    adding a HA-unrelated export to nowcast_core.
    """
    yp = (x_km * 1000 - 600000) / 1_000_000
    xp = (y_km * 1000 - 200000) / 1_000_000
    lam = (
        2.6779094
        + 4.728982 * yp
        + 0.791484 * yp * xp
        + 0.1306 * yp * xp**2
        - 0.0436 * yp**3
    )
    phi = (
        16.9023892
        + 3.238272 * xp
        - 0.270978 * yp**2
        - 0.002528 * xp**2
        - 0.0447 * yp**2 * xp
        - 0.014 * xp**3
    )
    return (phi * 100) / 36, (lam * 100) / 36


def test_wgs84_round_trip_within_tolerance() -> None:
    """wgs84_to_grid_km composed with the inverse swisstopo formula is self-consistent.

    The swisstopo TN_0164 approximation is accurate to better than 1 m (< 1e-5°).
    A round-trip through wgs84_to_grid_km (WGS84→CH1903) and _grid_km_to_latlng
    (CH1903→WGS84) must stay within 1e-4° (~11 m). Any wrong constant in either
    formula produces km-scale errors, so this tolerance catches real bugs while
    allowing for the finite precision of the two complementary approximations.
    """
    # Zürich main station: a well-known Swiss reference point.
    lat_in, lng_in = 47.3779, 8.5400
    x_km, y_km = core.wgs84_to_grid_km(lat_in, lng_in)
    lat_out, lng_out = _grid_km_to_latlng(x_km, y_km)

    lat_err = abs(lat_out - lat_in)
    lng_err = abs(lng_out - lng_in)
    assert lat_err < 1e-4, f"lat round-trip error: {lat_err:.2e}"
    assert lng_err < 1e-4, f"lng round-trip error: {lng_err:.2e}"


def test_real_fixture_uses_legend_threshold_and_unknown_fallback() -> None:
    fixture = json.loads(
        (ROOT / "tests" / "fixtures" / "frame.json").read_text(encoding="utf-8")
    )

    # The fixture's observed 9e849a maps to the lowest 0-1 mm/h legend band.
    assert (
        core.frame_is_wet_at_grid_point(fixture, 610.3328, 160.6157, LEGEND)
        is False
    )
    assert core.frame_is_wet_at_grid_point(
        fixture,
        610.3328,
        160.6157,
        LEGEND,
        rain_threshold_mm_h=0.0,
    )

    # Reuse the real geometry with the animation fixture's first wet band.
    fixture["areas"][0]["color"] = next(
        band["color"] for band in LEGEND if band["min"] == 1
    )
    assert core.frame_is_wet_at_grid_point(
        fixture,
        610.3328,
        160.6157,
        LEGEND,
    )

    # A valid RGB colour beyond the matching cap is neither wet nor dry.
    fixture["areas"][0]["color"] = "010101"
    assert (
        core.frame_is_wet_at_grid_point(fixture, 610.3328, 160.6157, LEGEND)
        is None
    )

    assert core.frame_is_wet_at_grid_point(fixture, 800.0, 400.0, LEGEND) is False
    assert core.frame_is_wet_at_grid_point(fixture, 1000.0, 500.0, LEGEND) is None


def test_documented_frame_colour_drift_stays_within_matching_cap() -> None:
    fixture = json.loads(
        (ROOT / "tests" / "fixtures" / "frame.json").read_text(encoding="utf-8")
    )

    assert core._legend_band_min_for_color(fixture["areas"][0]["color"], LEGEND) == 0
    assert core._legend_band_min_for_color(fixture["areas"][1]["color"], LEGEND) is None


def test_confident_rain_wins_over_overlapping_unclassifiable_area() -> None:
    fixture = json.loads(
        (ROOT / "tests" / "fixtures" / "frame.json").read_text(encoding="utf-8")
    )
    containing_area = fixture["areas"][0]
    wet_color = next(band["color"] for band in LEGEND if band["min"] == 1)
    fixture["areas"] = [
        {**containing_area, "color": wet_color},
        {**containing_area, "color": "52af2a"},
    ]

    assert core.frame_is_wet_at_grid_point(
        fixture,
        610.3328,
        160.6157,
        LEGEND,
    )


def test_overlapping_unknown_prevents_false_all_clear() -> None:
    fixture = json.loads(
        (ROOT / "tests" / "fixtures" / "frame.json").read_text(encoding="utf-8")
    )
    containing_area = fixture["areas"][0]
    fixture["areas"] = [
        {**containing_area, "color": "9e849a"},
        {**containing_area, "color": "52af2a"},
    ]

    assert (
        core.frame_is_wet_at_grid_point(fixture, 610.3328, 160.6157, LEGEND)
        is None
    )


def test_out_of_grid_propagates_to_unknown_status() -> None:
    fixture = json.loads(
        (ROOT / "tests" / "fixtures" / "frame.json").read_text(encoding="utf-8")
    )
    wet = core.frame_is_wet_at_grid_point(fixture, 1000.0, 500.0, LEGEND)

    result = core.evaluate_nowcast(
        now=NOW,
        measurement=measurement(wet),
        forecast_samples=forecast([wet] * 4),
    )

    assert result.status == core.RainStatus.UNKNOWN
    assert result.protection_active is None


def test_unrecognized_color_propagates_to_unknown_status() -> None:
    fixture = json.loads(
        (ROOT / "tests" / "fixtures" / "frame.json").read_text(encoding="utf-8")
    )
    fixture["areas"][0]["color"] = "010101"
    wet = core.frame_is_wet_at_grid_point(fixture, 610.3328, 160.6157, LEGEND)

    result = core.evaluate_nowcast(
        now=NOW,
        measurement=measurement(wet),
        forecast_samples=forecast([wet] * 4),
    )

    assert result.status == core.RainStatus.UNKNOWN
    assert result.protection_active is None


def test_malformed_grid_coordinates_raise_value_error() -> None:
    malformed = {"coords": {"x_min": 0}, "areas": []}

    try:
        core.frame_is_wet_at_grid_point(malformed, 1.0, 1.0, LEGEND)
    except ValueError as err:
        assert str(err) == "Malformed MeteoSwiss frame coordinates"
    else:
        raise AssertionError("Malformed coordinates should raise ValueError")


def test_python_decoder_matches_js_golden() -> None:
    """Python _decode_contour_grid must produce the same vertices as the JS golden.

    frame_decoded.json was generated by reference_decode.py (a port of the JS
    chain-code decoder that outputs float32-rounded lat/lng). This test decodes
    the same frame.json with the Python decoder, converts grid-km output to
    lat/lng using the same swisstopo formula (via _grid_km_to_latlng, defined in
    this test module), rounds to float32, and compares exactly against the golden.

    If you change a constant in _decode_contour_grid, decodeContourInto, or the
    swisstopo conversion, this test will fail — update both decoders, then
    regenerate frame_decoded.json with tests/tools/reference_decode.py.
    """

    def _f32(v: float) -> float:
        return struct.unpack("f", struct.pack("f", v))[0]

    frame = json.loads(
        (ROOT / "tests" / "fixtures" / "frame.json").read_text(encoding="utf-8")
    )
    golden = json.loads(
        (ROOT / "tests" / "fixtures" / "frame_decoded.json").read_text(encoding="utf-8")
    )

    assert len(frame["areas"]) == len(golden), "area count mismatch"

    areas = zip(frame["areas"], golden, strict=True)
    for area_idx, (area, golden_area) in enumerate(areas):
        assert len(area["shapes"]) == len(golden_area["shapes"]), (
            f"shape count mismatch in area {area_idx}"
        )
        for shape_idx, (shape, golden_shape) in enumerate(
            zip(area["shapes"], golden_area["shapes"], strict=True)
        ):
            assert len(shape) == len(golden_shape), (
                f"ring count mismatch in area {area_idx} shape {shape_idx}"
            )
            for ring_idx, (contour, golden_ring) in enumerate(
                zip(shape, golden_shape, strict=True)
            ):
                points = core._decode_contour_grid(contour, frame["coords"])
                assert len(points) * 2 == len(golden_ring), (
                    f"vertex count mismatch: area={area_idx} shape={shape_idx} "
                    f"ring={ring_idx} got={len(points)} "
                    f"expected={len(golden_ring) // 2}"
                )
                indices = range(0, len(golden_ring), 2)
                for pt_idx, (pt, gi) in enumerate(
                    zip(points, indices, strict=True)
                ):
                    x_km, y_km = pt
                    lat, lng = _grid_km_to_latlng(x_km, y_km)
                    got_lat, got_lng = _f32(lat), _f32(lng)
                    exp_lat, exp_lng = golden_ring[gi], golden_ring[gi + 1]
                    assert got_lat == exp_lat, (
                        f"lat mismatch area={area_idx} shape={shape_idx} "
                        f"ring={ring_idx} pt={pt_idx}: "
                        f"got={got_lat} expected={exp_lat}"
                    )
                    assert got_lng == exp_lng, (
                        f"lng mismatch area={area_idx} shape={shape_idx} "
                        f"ring={ring_idx} pt={pt_idx}: "
                        f"got={got_lng} expected={exp_lng}"
                    )


# ---------------------------------------------------------------------------
# Tests: minimum hold on the protection signal (#212)
# ---------------------------------------------------------------------------

def _protecting(since: datetime, status: core.RainStatus) -> core.RainNowcast:
    """A previous cycle in which protection was already up."""
    return core.RainNowcast(
        status=status,
        protection_active=True,
        currently_wet=status is core.RainStatus.ACTIVE,
        event_start=since,
        event_end=None,
        event_end_open=True,
        lead_time_minutes=None,
        forecast_horizon_end=NOW + timedelta(hours=1),
        measurement_time=NOW,
        dry_window_minutes=30,
        warning_lead_minutes=30,
        protection_since=since,
    )


def test_protection_holds_through_a_short_dry_spell() -> None:
    """The live failure: a shower clips the location and the signal cycles.

    Recorded on one instance: on 00:43, off 00:48, on 00:53, off 01:18 -- an
    awning motor would have run four times in 35 minutes.  Five minutes after
    the signal went up, a dry forecast must not drop it.
    """
    result = core.evaluate_nowcast(
        now=NOW,
        measurement=measurement(False),
        forecast_samples=forecast([False] * 6),
        previous=_protecting(NOW - timedelta(minutes=5), core.RainStatus.APPROACHING),
        protection_min_hold_minutes=30,
    )

    assert result.protection_active is True
    assert result.protection_hold_until == NOW + timedelta(minutes=25)
    # The status still tells the truth -- only the actuator signal is held.
    assert result.status == core.RainStatus.DRY


def test_protection_drops_once_the_hold_has_passed() -> None:
    result = core.evaluate_nowcast(
        now=NOW,
        measurement=measurement(False),
        forecast_samples=forecast([False] * 6),
        previous=_protecting(NOW - timedelta(minutes=31), core.RainStatus.APPROACHING),
        protection_min_hold_minutes=30,
    )

    assert result.protection_active is False
    assert result.protection_hold_until is None
    assert result.protection_since is None


def test_protection_hold_can_be_switched_off() -> None:
    """Zero restores the old behaviour for anyone who wants the raw signal."""
    result = core.evaluate_nowcast(
        now=NOW,
        measurement=measurement(False),
        forecast_samples=forecast([False] * 6),
        previous=_protecting(NOW - timedelta(minutes=1), core.RainStatus.APPROACHING),
        protection_min_hold_minutes=0,
    )

    assert result.protection_active is False


def test_protection_since_is_stamped_when_the_signal_goes_up() -> None:
    """Without a stamp the hold has no anchor to measure from."""
    result = core.evaluate_nowcast(
        now=NOW,
        measurement=measurement(False),
        forecast_samples=forecast([False, True, True, False, False, False, False]),
    )

    assert result.status == core.RainStatus.APPROACHING
    assert result.protection_since == NOW
    assert result.protection_hold_until is None


def test_protection_since_survives_consecutive_protected_cycles() -> None:
    """The hold measures from when protection first rose, not from each update."""
    first_up = NOW - timedelta(minutes=20)
    result = core.evaluate_nowcast(
        now=NOW,
        measurement=measurement(True),
        forecast_samples=forecast([True, True, False, False]),
        previous=_protecting(first_up, core.RainStatus.ACTIVE),
        protection_min_hold_minutes=30,
    )

    assert result.protection_active is True
    assert result.protection_since == first_up


def test_missing_data_does_not_drop_a_held_signal() -> None:
    """No data is not a reason to let an actuator move."""
    result = core.evaluate_nowcast(
        now=NOW,
        measurement=None,
        forecast_samples=[],
        previous=_protecting(NOW - timedelta(minutes=2), core.RainStatus.APPROACHING),
        protection_min_hold_minutes=30,
    )

    assert result.status == core.RainStatus.UNKNOWN
    assert result.protection_active is True
