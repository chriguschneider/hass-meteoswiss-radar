"""Diagnostics download for the MeteoSwiss Radar integration."""

from __future__ import annotations

import dataclasses
from datetime import datetime
from enum import Enum
from typing import Any

from homeassistant.components.diagnostics import async_redact_data
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant

from . import nowcast_entities_enabled
from .const import DATA_NOWCAST, VERSION

# Keys that can carry the home location or an address. The nowcast data holds
# no location, so this guards options (and future fields) against leaking it.
TO_REDACT = {
    "latitude",
    "longitude",
    "lat",
    "lon",
    "lng",
    "coordinates",
    "coordinate",
    "location",
    "zone",
    "zone_id",
    "url",
    "base_url",
    "internal_url",
    "external_url",
}

REDACTED = "**REDACTED**"


def _json_safe(value: Any) -> Any:
    """Convert dataclasses, enums and datetimes to plain JSON values."""
    if dataclasses.is_dataclass(value) and not isinstance(value, type):
        return {k: _json_safe(v) for k, v in dataclasses.asdict(value).items()}
    if isinstance(value, Enum):
        return value.value
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, dict):
        return {str(k): _json_safe(v) for k, v in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [_json_safe(v) for v in value]
    return value


def _redact_urls(value: Any) -> Any:
    """Redact any string value that is a URL, whatever its key."""
    if isinstance(value, dict):
        return {k: _redact_urls(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_redact_urls(v) for v in value]
    if isinstance(value, str) and value.lower().startswith(("http://", "https://")):
        return REDACTED
    return value


def _nowcast_diagnostics(hass: HomeAssistant, entry: ConfigEntry) -> dict | None:
    entry_data = (hass.data.get(DATA_NOWCAST) or {}).get(entry.entry_id) or {}
    coordinator = entry_data.get("nowcast_coordinator")
    if coordinator is None:
        return None
    last_update = getattr(coordinator, "last_update_success_time", None)
    data = _json_safe(coordinator.data) if coordinator.data is not None else None
    return {
        "last_update_success": getattr(coordinator, "last_update_success", None),
        "last_update_time": _json_safe(last_update),
        "manifest_generated_at": _json_safe(
            getattr(coordinator, "manifest_generated_at", None)
        ),
        "frame_failures": getattr(coordinator, "frame_failures", None),
        "rain_threshold_mm_h": getattr(coordinator, "rain_threshold_mm_h", None),
        "location_in_radar_coverage": getattr(
            coordinator, "location_in_radar_coverage", None
        ),
        "data": async_redact_data(_redact_urls(data), TO_REDACT)
        if data is not None
        else None,
    }


async def async_get_config_entry_diagnostics(
    hass: HomeAssistant, entry: ConfigEntry
) -> dict[str, Any]:
    """Return redacted diagnostics; never the Home Assistant location."""
    options = _redact_urls(_json_safe(dict(entry.options)))
    return {
        "version": VERSION,
        "entry": {
            "title": entry.title,
            "version": entry.version,
            "options": async_redact_data(options, TO_REDACT),
        },
        "nowcast_enabled": nowcast_entities_enabled(hass, entry),
        "nowcast": _nowcast_diagnostics(hass, entry),
    }
