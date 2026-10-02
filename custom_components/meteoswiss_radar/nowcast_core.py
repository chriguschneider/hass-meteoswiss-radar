"""Pure MeteoSwiss radar nowcast helpers.

This module intentionally has no Home Assistant dependency.  It contains the
geometry decoder needed to evaluate a MeteoSwiss RZC/INCA contour frame at one
location and the small rain-event state machine used by the HA entities.
"""

from __future__ import annotations

from collections.abc import Iterable, Sequence
from dataclasses import dataclass, replace
from datetime import datetime, timedelta
from enum import StrEnum
from math import ceil
from typing import Any


DEFAULT_WARNING_LEAD_MINUTES = 30
DEFAULT_DRY_WINDOW_MINUTES = 30
DEFAULT_FORECAST_STEP_MINUTES = 10
MAX_FORECAST_GAP_MINUTES = 15
# The lowest 0-1 mm/h band is deliberately ignored because weak radar echoes
# are the regime most affected by virga, ground clutter, and beam shielding.
DEFAULT_RAIN_THRESHOLD_MM_H = 1.0
# A band is identified by its position in `areas[]`, so the colour is only a
# sanity check on one candidate rather than a search key. Measured over six live
# frames (45 areas, both products): real bands sit at most 83.8 units from their
# positional legend colour, and at the positions the background colours actually
# occupy they miss by at least 203.5.
#
# The cap is nonetheless set just above the worst real drift rather than in the
# middle of that gap: `333e48` happens to sit 94.5 units from the 2-4 mm/h
# colour, so a looser cap would accept it if it ever appeared at that position.
# Ordering alone already rules that out -- it trails the precipitation run -- but
# the two guards are cheap to keep independent.
MAX_LEGEND_COLOR_DISTANCE = 90.0
# Advection-based nowcasting is only reliable inside this window; beyond it the
# predicted-dry sensor is suppressed rather than extrapolated.
PREDICTED_DRY_HORIZON = timedelta(hours=2)
# Minimum time the protection signal stays on once raised. Without it a shower
# that clips the location cycles the signal within minutes -- observed live:
# on 00:43, off 00:48, on 00:53, off 01:18 -- and whatever the signal drives,
# typically an awning motor, cycles with it. Configurable, 0 disables the hold.
DEFAULT_PROTECTION_MIN_HOLD_MINUTES = 30


class RainStatus(StrEnum):
    """User-facing phase of the local rain event."""

    DRY = "dry"
    APPROACHING = "approaching"
    ACTIVE = "active"
    UNKNOWN = "unknown"


@dataclass(frozen=True, slots=True)
class RainSample:
    """One local precipitation sample extracted from a radar/INCA frame."""

    timestamp: datetime
    wet: bool | None
    source: str


@dataclass(frozen=True, slots=True)
class RainNowcast:
    """Computed local rain-event state."""

    status: RainStatus
    protection_active: bool | None
    currently_wet: bool | None
    event_start: datetime | None
    event_end: datetime | None
    event_end_open: bool
    lead_time_minutes: int | None
    forecast_horizon_end: datetime | None
    measurement_time: datetime | None
    dry_window_minutes: int
    warning_lead_minutes: int
    # When protection was last raised, and the earliest it may drop again. Both
    # are None while protection is off. `protection_hold_until` is only set when
    # the hold is actually keeping the signal up against the state machine.
    protection_since: datetime | None = None
    protection_hold_until: datetime | None = None


def wgs84_to_grid_km(latitude: float, longitude: float) -> tuple[float, float]:
    """Convert WGS84 degrees to the CH1903/LV03-like km used by radar frames.

    MeteoSwiss radar frames label their grid as LV95 but publish the x/y values
    in the historic CH1903-style kilometre convention (FORMAT.md in the radar
    project).  The standard swisstopo approximation below returns east/north in
    LV03 metres; divide by 1000 to match frame coordinates.
    """

    lat_seconds = latitude * 3600.0
    lon_seconds = longitude * 3600.0
    lat_aux = (lat_seconds - 169028.66) / 10000.0
    lon_aux = (lon_seconds - 26782.5) / 10000.0

    east = (
        600072.37
        + 211455.93 * lon_aux
        - 10938.51 * lon_aux * lat_aux
        - 0.36 * lon_aux * lat_aux**2
        - 44.54 * lon_aux**3
    )
    north = (
        200147.07
        + 308807.95 * lat_aux
        + 3745.25 * lon_aux**2
        + 76.63 * lat_aux**2
        - 194.56 * lon_aux**2 * lat_aux
        + 119.79 * lat_aux**3
    )
    return east / 1000.0, north / 1000.0


def _decode_contour_grid(
    contour: dict[str, Any], coords: dict[str, Any]
) -> list[tuple[float, float]]:
    """Decode one MeteoSwiss chain-code contour directly into grid km."""

    x_min = float(coords["x_min"])
    x_span = float(coords["x_max"]) - x_min
    x_count = float(coords["x_count"])
    y_min = float(coords["y_min"])
    y_span = float(coords["y_max"]) - y_min
    y_count = float(coords["y_count"])

    ci = int(contour["i"])
    cj = int(contour["j"])
    offsets = str(contour["o"])
    deltas = str(contour["d"])
    points: list[tuple[float, float]] = []

    for index, offset_char in enumerate(offsets):
        offset = (ord(offset_char) - 48) / 10.0 + 0.05
        if ci % 2 == 0:
            x = x_min + x_span * (ci / 2.0) / x_count
            y = y_min + y_span * ((cj - 1) / 2.0 + offset) / y_count
        else:
            x = x_min + x_span * ((ci - 1) / 2.0 + offset) / x_count
            y = y_min + y_span * (cj / 2.0) / y_count
        points.append((x, y))

        if index < len(offsets) - 1:
            delta_index = 2 * index
            if delta_index + 1 >= len(deltas):
                raise ValueError("Malformed MeteoSwiss contour delta string")
            ci += ord(deltas[delta_index]) - 77
            cj += ord(deltas[delta_index + 1]) - 77

    return points


def _point_on_segment(
    px: float,
    py: float,
    ax: float,
    ay: float,
    bx: float,
    by: float,
    tolerance: float = 1e-9,
) -> bool:
    """Return True if p lies on segment a-b within a small numerical tolerance."""

    cross = (px - ax) * (by - ay) - (py - ay) * (bx - ax)
    if abs(cross) > tolerance:
        return False
    dot = (px - ax) * (px - bx) + (py - ay) * (py - by)
    return dot <= tolerance


def _point_in_ring(px: float, py: float, ring: Sequence[tuple[float, float]]) -> bool:
    """Ray-casting point-in-polygon test; polygon boundary counts as inside."""

    if len(ring) < 3:
        return False

    min_x = min(point[0] for point in ring)
    max_x = max(point[0] for point in ring)
    min_y = min(point[1] for point in ring)
    max_y = max(point[1] for point in ring)
    if not (min_x <= px <= max_x and min_y <= py <= max_y):
        return False

    inside = False
    previous = ring[-1]
    for current in ring:
        ax, ay = previous
        bx, by = current
        if _point_on_segment(px, py, ax, ay, bx, by):
            return True
        crosses = (ay > py) != (by > py)
        if crosses:
            x_at_y = ax + (py - ay) * (bx - ax) / (by - ay)
            if px < x_at_y:
                inside = not inside
        previous = current
    return inside


def frame_covers_grid_point(
    frame: dict[str, Any], x_km: float, y_km: float
) -> bool:
    """Return whether a grid point is covered by a MeteoSwiss frame."""
    coords = frame.get("coords") or {}
    try:
        return (
            float(coords["x_min"]) <= x_km <= float(coords["x_max"])
            and float(coords["y_min"]) <= y_km <= float(coords["y_max"])
        )
    except (KeyError, TypeError, ValueError) as err:
        raise ValueError("Malformed MeteoSwiss frame coordinates") from err


def _parse_rgb(value: object) -> tuple[int, int, int] | None:
    """Parse one six-digit RGB colour, with or without a leading hash."""
    normalized = str(value or "").removeprefix("#")
    if len(normalized) != 6:
        return None
    try:
        return (
            int(normalized[0:2], 16),
            int(normalized[2:4], 16),
            int(normalized[4:6], 16),
        )
    except ValueError:
        return None


def _sorted_legend(legend: Sequence[dict[str, Any]]) -> list[tuple[float, str]]:
    """Return usable legend bands as (min, colour), ascending by intensity.

    The manifest publishes the legend **descending** (60+ first), while
    ``areas[]`` runs ascending, so the two only line up after sorting.
    """

    bands: list[tuple[float, str]] = []
    for band in legend:
        if not isinstance(band, dict):
            continue
        colour = band.get("color")
        try:
            minimum = float(band["min"])
        except (KeyError, TypeError, ValueError):
            continue
        if _parse_rgb(colour) is None:
            continue
        bands.append((minimum, str(colour)))
    return sorted(bands)


def _legend_band_min_for_area(
    color: object,
    index: int,
    bands: Sequence[tuple[float, str]],
) -> float | None:
    """Return the band minimum for the area at ``index``, or None if unknown.

    `FORMAT.md` documents that ``areas[]`` is ordered lowest intensity first, so
    an area's position *is* its band — the colour then only has to confirm it.
    Searching for the nearest colour instead looks more robust and is not: RZC
    measurement frames and INCA forecast frames use different palettes for the
    same bands, measured at up to 83.8 units apart, while the closest two legend
    colours can be as little as 31 apart. Any cap tight enough to make a search
    unambiguous throws away most real measurement bands; any cap loose enough to
    keep them cannot separate them from the background by distance alone.

    Validating one positional candidate has neither problem: there is nothing to
    confuse it with, and the background colours miss their positional band by
    more than twice the worst real drift.
    """

    area_rgb = _parse_rgb(color)
    if area_rgb is None or index >= len(bands):
        return None

    minimum, band_colour = bands[index]
    band_rgb = _parse_rgb(band_colour)
    if band_rgb is None:
        return None

    distance_squared = sum(
        (area_channel - band_channel) ** 2
        for area_channel, band_channel in zip(area_rgb, band_rgb, strict=True)
    )
    if distance_squared > MAX_LEGEND_COLOR_DISTANCE**2:
        return None
    return minimum


def frame_is_wet_at_grid_point(
    frame: dict[str, Any],
    x_km: float,
    y_km: float,
    legend: Sequence[dict[str, Any]],
    rain_threshold_mm_h: float = DEFAULT_RAIN_THRESHOLD_MM_H,
) -> bool | None:
    """Return rain at a point, or None outside coverage or for unknown colour."""

    if not frame_covers_grid_point(frame, x_km, y_km):
        return None

    coords = frame["coords"]
    bands = _sorted_legend(legend)
    classification: bool | None = False
    for index, area in enumerate(frame.get("areas") or []):
        for shape in area.get("shapes") or []:
            if not shape:
                continue
            outer = _decode_contour_grid(shape[0], coords)
            if not _point_in_ring(x_km, y_km, outer):
                continue
            in_hole = any(
                _point_in_ring(x_km, y_km, _decode_contour_grid(hole, coords))
                for hole in shape[1:]
            )
            if not in_hole:
                minimum = _legend_band_min_for_area(area.get("color"), index, bands)
                if minimum is not None and minimum >= rain_threshold_mm_h:
                    # A confidently wet band wins over overlapping unknown
                    # areas; never let uncertainty create a false all-clear.
                    return True
                if minimum is None:
                    classification = None
                break
    return classification


def _round_lead_minutes(delta: timedelta) -> int:
    """Round a lead time to the nearest 5 minutes for an intentionally fuzzy UI."""

    minutes = max(0.0, delta.total_seconds() / 60.0)
    return int((minutes + 2.5) // 5.0) * 5


def _sorted_forecast(samples: Iterable[RainSample], now: datetime) -> list[RainSample]:
    return sorted(
        (sample for sample in samples if sample.timestamp >= now),
        key=lambda sample: sample.timestamp,
    )


def _has_complete_dry_window(
    samples: Sequence[RainSample],
    start_index: int,
    dry_window_minutes: int,
    forecast_step_minutes: int,
) -> bool:
    """Return True if explicit dry samples cover a full window from start_index."""

    if start_index >= len(samples) or samples[start_index].wet is not False:
        return False

    start_time = samples[start_index].timestamp
    target_time = start_time + timedelta(minutes=dry_window_minutes)
    window: list[RainSample] = []

    for sample in samples[start_index:]:
        window.append(sample)
        if sample.timestamp >= target_time:
            break

    if not window or window[-1].timestamp < target_time:
        return False
    if any(sample.wet is not False for sample in window):
        return False

    max_gap = timedelta(minutes=MAX_FORECAST_GAP_MINUTES)
    for previous, current in zip(window, window[1:], strict=False):
        if current.timestamp - previous.timestamp > max_gap:
            return False

    return True


def _first_confirmed_dry_window(
    samples: Sequence[RainSample],
    not_before: datetime,
    dry_window_minutes: int,
    forecast_step_minutes: int,
) -> datetime | None:
    """Return the first time a fully explicit dry window starts."""

    for index, sample in enumerate(samples):
        if sample.timestamp < not_before or sample.wet is not False:
            continue
        if _has_complete_dry_window(
            samples,
            index,
            dry_window_minutes,
            forecast_step_minutes,
        ):
            return sample.timestamp
    return None


def _unknown_in_lead_window(
    samples: Sequence[RainSample],
    now: datetime,
    warning_lead_minutes: int,
    forecast_step_minutes: int,
) -> bool:
    """Detect whether the short warning window lacks enough explicit data."""

    end = now + timedelta(minutes=warning_lead_minutes)
    window = [sample for sample in samples if now <= sample.timestamp <= end]
    required = max(1, ceil(warning_lead_minutes / forecast_step_minutes))
    if len(window) < required:
        return True
    if any(sample.wet is None for sample in window[:required]):
        return True
    max_gap = timedelta(minutes=MAX_FORECAST_GAP_MINUTES)
    return any(
        current.timestamp - previous.timestamp > max_gap
        for previous, current in zip(
            window[:required], window[1:required], strict=False
        )
    )


def _cap_event_end(
    event_end: datetime | None,
    now: datetime,
    horizon: timedelta = PREDICTED_DRY_HORIZON,
) -> datetime | None:
    """Return None if event_end lies beyond the reliable nowcast horizon."""
    if event_end is None or event_end > now + horizon:
        return None
    return event_end


def _apply_protection_hold(
    result: RainNowcast,
    previous: RainNowcast | None,
    now: datetime,
    min_hold_minutes: int,
) -> RainNowcast:
    """Keep the protection signal up for at least ``min_hold_minutes``.

    Only the protection flag is held. ``status`` keeps telling the truth, so a
    held signal is visible as "dry" with protection still on rather than as a
    phantom rain event -- and ``protection_hold_until`` says until when.

    An UNKNOWN result is held too: no data is not a reason to drop an actuator
    signal that is already up, and dropping it would be the flapping this
    prevents.
    """

    was_protecting = previous is not None and previous.protection_active is True

    if result.protection_active is True:
        since = previous.protection_since if was_protecting else None
        return replace(result, protection_since=since or now)

    if min_hold_minutes <= 0 or not was_protecting:
        return result

    since = previous.protection_since if previous is not None else None
    if since is None:
        return result

    hold_until = since + timedelta(minutes=min_hold_minutes)
    if now >= hold_until:
        return result

    return replace(
        result,
        protection_active=True,
        protection_since=since,
        protection_hold_until=hold_until,
    )


def _evaluate_rain_state(
    *,
    now: datetime,
    measurement: RainSample | None,
    forecast_samples: Iterable[RainSample],
    previous: RainNowcast | None = None,
    warning_lead_minutes: int = DEFAULT_WARNING_LEAD_MINUTES,
    dry_window_minutes: int = DEFAULT_DRY_WINDOW_MINUTES,
    forecast_step_minutes: int = DEFAULT_FORECAST_STEP_MINUTES,
) -> RainNowcast:
    """Build the local rain-event state used by UI and awning protection.

    A started event remains ACTIVE through dry pauses until the forecast contains
    a fully explicit dry window of ``dry_window_minutes``.  A forecast event is
    APPROACHING once its first wet frame lies within ``warning_lead_minutes``.
    """

    forecast = _sorted_forecast(forecast_samples, now)
    horizon_end = forecast[-1].timestamp if forecast else None
    current_wet = measurement.wet if measurement is not None else None
    measurement_time = measurement.timestamp if measurement is not None else None

    previous_started = previous is not None and previous.status is RainStatus.ACTIVE

    # To end an already-started event we require a dry window beginning *now*,
    # not merely some dry window later in the forecast.  Treat the current
    # measured state as the first 10-minute interval for this purpose.
    dry_now_confirmed = False
    if current_wet is False:
        current_sample = RainSample(timestamp=now, wet=False, source="measurement")
        dry_samples = [
            current_sample,
            *(sample for sample in forecast if sample.timestamp > now),
        ]
        dry_now_confirmed = _has_complete_dry_window(
            dry_samples,
            0,
            dry_window_minutes,
            forecast_step_minutes,
        )

    # A real measured wet frame starts an event immediately.  Once started, the
    # event survives a short measured dry pause unless a full dry window from
    # the current moment is confirmed.  Missing current measurement cannot end
    # an active event.
    active = current_wet is True or (previous_started and not dry_now_confirmed)

    if active:
        if (
            previous_started
            and previous is not None
            and previous.event_start is not None
        ):
            event_start = previous.event_start
        elif measurement is not None:
            event_start = measurement.timestamp
        else:
            event_start = now

        raw_end = _first_confirmed_dry_window(
            forecast,
            now,
            dry_window_minutes,
            forecast_step_minutes,
        )
        event_end = _cap_event_end(raw_end, now)
        return RainNowcast(
            status=RainStatus.ACTIVE,
            protection_active=True,
            currently_wet=current_wet,
            event_start=event_start,
            event_end=event_end,
            event_end_open=event_end is None,
            lead_time_minutes=None,
            forecast_horizon_end=horizon_end,
            measurement_time=measurement_time,
            dry_window_minutes=dry_window_minutes,
            warning_lead_minutes=warning_lead_minutes,
        )

    first_wet = next((sample for sample in forecast if sample.wet is True), None)
    lead_limit = now + timedelta(minutes=warning_lead_minutes)
    if first_wet is not None and first_wet.timestamp <= lead_limit:
        raw_end = _first_confirmed_dry_window(
            forecast,
            first_wet.timestamp,
            dry_window_minutes,
            forecast_step_minutes,
        )
        event_end = _cap_event_end(raw_end, now)
        return RainNowcast(
            status=RainStatus.APPROACHING,
            protection_active=True,
            currently_wet=current_wet,
            event_start=first_wet.timestamp,
            event_end=event_end,
            event_end_open=event_end is None,
            lead_time_minutes=_round_lead_minutes(first_wet.timestamp - now),
            forecast_horizon_end=horizon_end,
            measurement_time=measurement_time,
            dry_window_minutes=dry_window_minutes,
            warning_lead_minutes=warning_lead_minutes,
        )

    unknown = current_wet is None or _unknown_in_lead_window(
        forecast,
        now,
        warning_lead_minutes,
        forecast_step_minutes,
    )
    if unknown:
        return RainNowcast(
            status=RainStatus.UNKNOWN,
            protection_active=None,
            currently_wet=current_wet,
            event_start=None,
            event_end=None,
            event_end_open=False,
            lead_time_minutes=None,
            forecast_horizon_end=horizon_end,
            measurement_time=measurement_time,
            dry_window_minutes=dry_window_minutes,
            warning_lead_minutes=warning_lead_minutes,
        )

    return RainNowcast(
        status=RainStatus.DRY,
        protection_active=False,
        currently_wet=False,
        event_start=None,
        event_end=None,
        event_end_open=False,
        lead_time_minutes=None,
        forecast_horizon_end=horizon_end,
        measurement_time=measurement_time,
        dry_window_minutes=dry_window_minutes,
        warning_lead_minutes=warning_lead_minutes,
    )


def evaluate_nowcast(
    *,
    now: datetime,
    measurement: RainSample | None,
    forecast_samples: Iterable[RainSample],
    previous: RainNowcast | None = None,
    warning_lead_minutes: int = DEFAULT_WARNING_LEAD_MINUTES,
    dry_window_minutes: int = DEFAULT_DRY_WINDOW_MINUTES,
    forecast_step_minutes: int = DEFAULT_FORECAST_STEP_MINUTES,
    protection_min_hold_minutes: int = DEFAULT_PROTECTION_MIN_HOLD_MINUTES,
) -> RainNowcast:
    """Evaluate the rain state, then hold the protection signal against flapping.

    The state machine and the hold are deliberately separate: the first answers
    "what is the weather doing", the second answers "may the actuator move yet".
    """

    result = _evaluate_rain_state(
        now=now,
        measurement=measurement,
        forecast_samples=forecast_samples,
        previous=previous,
        warning_lead_minutes=warning_lead_minutes,
        dry_window_minutes=dry_window_minutes,
        forecast_step_minutes=forecast_step_minutes,
    )
    return _apply_protection_hold(result, previous, now, protection_min_hold_minutes)
