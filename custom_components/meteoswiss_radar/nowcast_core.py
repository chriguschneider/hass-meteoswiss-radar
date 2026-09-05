"""Pure MeteoSwiss radar nowcast helpers.

This module intentionally has no Home Assistant dependency.  It contains the
geometry decoder needed to evaluate a MeteoSwiss RZC/INCA contour frame at one
location and the small rain-event state machine used by the HA entities.
"""

from __future__ import annotations

from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from datetime import datetime, timedelta
from enum import StrEnum
from math import ceil
from typing import Any


DEFAULT_WARNING_LEAD_MINUTES = 30
DEFAULT_DRY_WINDOW_MINUTES = 30
DEFAULT_FORECAST_STEP_MINUTES = 10
MAX_FORECAST_GAP_MINUTES = 15
NON_PRECIPITATION_COLORS = {"333e48", "ffffff"}


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


def frame_is_wet_at_grid_point(
    frame: dict[str, Any], x_km: float, y_km: float
) -> bool:
    """Return whether a MeteoSwiss radar/INCA rate frame contains rain at point."""

    coords = frame.get("coords") or {}
    try:
        if not (
            float(coords["x_min"]) <= x_km <= float(coords["x_max"])
            and float(coords["y_min"]) <= y_km <= float(coords["y_max"])
        ):
            return False
    except (KeyError, TypeError, ValueError) as err:
        raise ValueError("Malformed MeteoSwiss frame coordinates") from err

    for area in frame.get("areas") or []:
        color = str(area.get("color") or "").lstrip("#").lower()
        if color in NON_PRECIPITATION_COLORS:
            continue
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
                return True
    return False


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


def evaluate_nowcast(
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

        event_end = _first_confirmed_dry_window(
            forecast,
            now,
            dry_window_minutes,
            forecast_step_minutes,
        )
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
        event_end = _first_confirmed_dry_window(
            forecast,
            first_wet.timestamp,
            dry_window_minutes,
            forecast_step_minutes,
        )
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
