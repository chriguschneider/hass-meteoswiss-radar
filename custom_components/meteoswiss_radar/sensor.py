"""Sensor entities for MeteoSwiss Radar local nowcast."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Final

from homeassistant.components.sensor import (
    SensorDeviceClass,
    SensorEntity,
    SensorEntityDescription,
    SensorStateClass,
)
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import UnitOfTime
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.entity import DeviceInfo
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from .const import DOMAIN
from .nowcast import MeteoSwissRadarNowcastCoordinator


@dataclass(frozen=True, kw_only=True)
class MeteoSwissRadarNowcastSensorDescription(SensorEntityDescription):
    """Describe a nowcast sensor."""

    value: str


SENSORS: Final = (
    MeteoSwissRadarNowcastSensorDescription(
        key="nowcast_status",
        translation_key="nowcast_status",
        icon="mdi:weather-rainy",
        value="status",
    ),
    MeteoSwissRadarNowcastSensorDescription(
        key="rain_in",
        translation_key="rain_in",
        icon="mdi:timer-sand",
        device_class=SensorDeviceClass.DURATION,
        state_class=SensorStateClass.MEASUREMENT,
        native_unit_of_measurement=UnitOfTime.MINUTES,
        value="lead_time_minutes",
    ),
    MeteoSwissRadarNowcastSensorDescription(
        key="rain_start",
        translation_key="rain_start",
        icon="mdi:weather-pouring",
        device_class=SensorDeviceClass.TIMESTAMP,
        value="event_start",
    ),
    MeteoSwissRadarNowcastSensorDescription(
        key="rain_end",
        translation_key="rain_end",
        icon="mdi:weather-sunny-alert",
        device_class=SensorDeviceClass.TIMESTAMP,
        value="event_end",
    ),
)


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities,
) -> None:
    """Set up MeteoSwiss Radar nowcast sensors."""

    coordinator: MeteoSwissRadarNowcastCoordinator = hass.data[DOMAIN][
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

        if self.entity_description.key == "nowcast_status":
            self._attr_extra_state_attributes = {
                "currently_wet": data.currently_wet,
                "protection_active": data.protection_active,
                "event_start": data.event_start.isoformat() if data.event_start else None,
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
