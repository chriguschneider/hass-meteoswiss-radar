"""Sensor entities for MeteoSwiss Radar local nowcast."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime, tzinfo
from typing import Final
from zoneinfo import ZoneInfo

from homeassistant.components.sensor import (
    SensorDeviceClass,
    SensorEntity,
    SensorEntityDescription,
)
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import UnitOfTime
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.entity import DeviceInfo
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from .const import DATA_NOWCAST, DOMAIN
from .nowcast import MeteoSwissRadarNowcastCoordinator
from .nowcast_core import RainStatus, next_rain_text


@dataclass(frozen=True, kw_only=True)
class MeteoSwissRadarNowcastSensorDescription(SensorEntityDescription):
    """Describe a nowcast sensor."""

    value: str


SENSORS: Final = (
    MeteoSwissRadarNowcastSensorDescription(
        key="nowcast_status",
        translation_key="nowcast_status",
        icon="mdi:weather-rainy",
        # ENUM is what makes the frontend translate the value: without it the
        # sensor shows the raw `dry`/`approaching`/... slug in every language,
        # while the three sibling sensors can only ever say "unknown" when no
        # event exists. This is the one entity that carries the sentence.
        device_class=SensorDeviceClass.ENUM,
        options=[status.value for status in RainStatus],
        value="status",
    ),
    MeteoSwissRadarNowcastSensorDescription(
        key="rain_in",
        translation_key="rain_in",
        icon="mdi:timer-sand",
        device_class=SensorDeviceClass.DURATION,
        # No state_class on purpose: this is a countdown that is `unknown`
        # whenever rain is not approaching, so long-term statistics over it
        # record gaps rather than a trend.
        native_unit_of_measurement=UnitOfTime.MINUTES,
        # Off by default: "Next rain" already shows "12 min", and this countdown
        # is `unknown` whenever rain is not approaching. Kept for automations.
        entity_registry_enabled_default=False,
        value="lead_time_minutes",
    ),
    MeteoSwissRadarNowcastSensorDescription(
        key="next_rain",
        translation_key="next_rain",
        icon="mdi:weather-pouring",
        # A short text, not a timestamp: a timestamp sensor can only say
        # `unknown` when no rain is expected, which is most days. The text
        # says "No rain" instead, and the timestamp moves to the `at`
        # attribute for automations.
        value="next_rain",
    ),
    MeteoSwissRadarNowcastSensorDescription(
        key="expected_dry_from",
        translation_key="expected_dry_from",
        icon="mdi:weather-sunny-alert",
        device_class=SensorDeviceClass.TIMESTAMP,
        # Off by default: only meaningful while it rains, `unknown` otherwise.
        entity_registry_enabled_default=False,
        value="event_end",
    ),
)


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities,
) -> None:
    """Set up MeteoSwiss Radar nowcast sensors."""

    coordinator: MeteoSwissRadarNowcastCoordinator = hass.data[DATA_NOWCAST][
        entry.entry_id
    ]["nowcast_coordinator"]
    async_add_entities(
        MeteoSwissRadarNowcastSensor(coordinator, entry, description)
        for description in SENSORS
    )


class MeteoSwissRadarNowcastSensor(
    CoordinatorEntity[MeteoSwissRadarNowcastCoordinator], SensorEntity
):
    """Expose one field from the local rain nowcast."""

    entity_description: MeteoSwissRadarNowcastSensorDescription
    _attr_has_entity_name = True

    def __init__(
        self,
        coordinator: MeteoSwissRadarNowcastCoordinator,
        entry: ConfigEntry,
        description: MeteoSwissRadarNowcastSensorDescription,
    ) -> None:
        super().__init__(coordinator)
        self.entity_description = description
        self._attr_unique_id = f"{DOMAIN}_{entry.entry_id}_{description.key}"
        self._attr_device_info = DeviceInfo(
            identifiers={(DOMAIN, entry.entry_id)},
            name="MeteoSwiss Radar",
            manufacturer="MeteoSwiss",
            model="Radar / INCA nowcast",
        )
        self._update_value()

    @callback
    def _handle_coordinator_update(self) -> None:
        self._update_value()
        super()._handle_coordinator_update()

    def _update_value(self) -> None:
        data = self.coordinator.data
        if data is None:
            self._attr_native_value = None
            self._attr_extra_state_attributes = None
            return

        value = getattr(data, self.entity_description.value)
        if self.entity_description.value == "status":
            value = value.value
        self._attr_native_value = value

        if self.entity_description.key == "next_rain":
            hass = getattr(self.coordinator, "hass", None)
            config = getattr(hass, "config", None)
            language = getattr(config, "language", None)
            self._attr_native_value = next_rain_text(
                data,
                datetime.now(UTC),
                _time_zone(getattr(config, "time_zone", None)),
                language if isinstance(language, str) else None,
            )
            self._attr_extra_state_attributes = {
                "at": data.next_rain.isoformat() if data.next_rain else None,
                # Which horizon answered: "radar" is the location at kilometre
                # resolution, "forecast" the model's forecast point by the hour.
                "source": data.next_rain_source,
                # How far "No rain" reaches: the end of the forecast that was
                # searched, or None when only the radar's 30 minutes were.
                "checked_until": (
                    data.forecast_until.isoformat() if data.forecast_until else None
                ),
                "radar_event_start": (
                    data.event_start.isoformat() if data.event_start else None
                ),
            }
            return

        if self.entity_description.key == "nowcast_status":
            self._attr_extra_state_attributes = {
                "currently_wet": data.currently_wet,
                "protection_active": data.protection_active,
                "event_start": (
                    data.event_start.isoformat() if data.event_start else None
                ),
                "event_end": data.event_end.isoformat() if data.event_end else None,
                "event_end_open": data.event_end_open,
                "forecast_horizon_end": (
                    data.forecast_horizon_end.isoformat()
                    if data.forecast_horizon_end
                    else None
                ),
                "measurement_time": (
                    data.measurement_time.isoformat() if data.measurement_time else None
                ),
                "warning_lead_minutes": data.warning_lead_minutes,
                "dry_window_minutes": data.dry_window_minutes,
                "manifest_generated_at": (
                    self.coordinator.manifest_generated_at.isoformat()
                    if self.coordinator.manifest_generated_at
                    else None
                ),
                "frame_failures": self.coordinator.frame_failures,
            }


def _time_zone(name: object) -> tzinfo:
    """Return Home Assistant's configured zone, falling back to UTC."""
    if isinstance(name, str):
        try:
            return ZoneInfo(name)
        except (KeyError, ValueError):
            pass
    return UTC
