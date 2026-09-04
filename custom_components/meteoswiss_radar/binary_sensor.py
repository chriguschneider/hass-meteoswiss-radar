"""Binary sensor for MeteoSwiss Radar awning/rain protection."""

from __future__ import annotations

from homeassistant.components.binary_sensor import BinarySensorEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.entity import DeviceInfo
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from .const import DOMAIN
from .nowcast import MeteoSwissRadarNowcastCoordinator


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities,
) -> None:
    """Set up the local rain protection entity."""

    coordinator: MeteoSwissRadarNowcastCoordinator = hass.data[DOMAIN][
        entry.entry_id
    ]["nowcast_coordinator"]
    async_add_entities([MeteoSwissRadarRainProtectionBinarySensor(coordinator, entry)])


class MeteoSwissRadarRainProtectionBinarySensor(
    CoordinatorEntity[MeteoSwissRadarNowcastCoordinator], BinarySensorEntity
):
    """True from 30 minutes before rain until a 30-minute dry window is known."""

    _attr_has_entity_name = True
    _attr_translation_key = "rain_protection"
    _attr_icon = "mdi:weather-rainy"

    def __init__(
        self,
        coordinator: MeteoSwissRadarNowcastCoordinator,
        entry: ConfigEntry,
    ) -> None:
        super().__init__(coordinator)
        self._attr_unique_id = f"{DOMAIN}_{entry.entry_id}_rain_protection"
        self._attr_device_info = DeviceInfo(
            identifiers={(DOMAIN, entry.entry_id)},
            name="MeteoSwiss Radar",
            manufacturer="MeteoSwiss",
            model="Radar / INCA nowcast",
        )

    @property
    def is_on(self) -> bool | None:
        data = self.coordinator.data
        return None if data is None else data.protection_active

    @property
    def extra_state_attributes(self) -> dict[str, object]:
        data = self.coordinator.data
        if data is None:
            return {}
        return {
            "status": data.status.value,
            "currently_wet": data.currently_wet,
            "rain_in_minutes": data.lead_time_minutes,
            "event_start": data.event_start.isoformat() if data.event_start else None,
            "event_end": data.event_end.isoformat() if data.event_end else None,
            "event_end_open": data.event_end_open,
            "warning_lead_minutes": data.warning_lead_minutes,
            "dry_window_minutes": data.dry_window_minutes,
        }

    @callback
    def _handle_coordinator_update(self) -> None:
        self.async_write_ha_state()
