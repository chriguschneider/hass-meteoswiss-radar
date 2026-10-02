"""Config and options flow for the MeteoSwiss Radar integration."""

from __future__ import annotations

from typing import Any

import voluptuous as vol
from homeassistant.helpers.selector import EntitySelector, EntitySelectorConfig
from homeassistant.config_entries import (
    ConfigEntry,
    ConfigFlow,
    ConfigFlowResult,
    OptionsFlow,
)
from homeassistant.core import callback

from .const import (
    DOMAIN,
    OPT_NOWCAST_ENABLED,
    OPT_PROTECTION_MIN_HOLD,
    OPT_WEATHER_ENTITY,
)


class MeteoSwissRadarConfigFlow(ConfigFlow, domain=DOMAIN):
    """Single-instance flow: nothing to configure, just confirm."""

    VERSION = 1

    async def async_step_user(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        if self._async_current_entries():
            return self.async_abort(reason="single_instance_allowed")
        if user_input is None:
            return self.async_show_form(step_id="user")
        return self.async_create_entry(title="MeteoSwiss Radar", data={})

    @staticmethod
    @callback
    def async_get_options_flow(entry: ConfigEntry) -> OptionsFlow:
        return MeteoSwissRadarOptionsFlow()


class MeteoSwissRadarOptionsFlow(OptionsFlow):
    """Toggle the local nowcast entities (#197).

    Plain `OptionsFlow` plus a config-entry update listener, not
    `OptionsFlowWithReload`: that base class only exists from HA 2025.8 and the
    manifest still supports 2024.7.0. It is the better fit once the floor rises
    -- it reloads only when the options actually changed, where our listener
    fires on any entry update (a title rename reloads too) -- but it forbids
    update listeners, so the swap has to happen in one move together with
    dropping `_async_options_updated`.
    """

    async def async_step_init(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        if user_input is not None:
            return self.async_create_entry(title="", data=user_input)

        # Import here, not at module level: config_flow is imported by HA during
        # discovery, before __init__ has run, and __init__ imports this module's
        # sibling constants only.
        from . import (
            forecast_weather_entity,
            nowcast_entities_enabled,
            protection_min_hold_minutes,
        )

        # Resolve the entry from the flow handler rather than `self.config_entry`:
        # the plain `OptionsFlow.config_entry` property only exists from HA
        # 2024.12, but the manifest supports 2024.7.0, where reading it would
        # raise AttributeError and the options dialog would fail to open. The
        # handler is the entry id on every supported version, and looking it up
        # here also avoids the deprecated explicit `self.config_entry = ...`.
        entry = self.hass.config_entries.async_get_entry(self.handler)

        return self.async_show_form(
            step_id="init",
            data_schema=vol.Schema(
                {
                    vol.Required(
                        OPT_NOWCAST_ENABLED,
                        default=nowcast_entities_enabled(self.hass, entry),
                    ): bool,
                    vol.Required(
                        OPT_PROTECTION_MIN_HOLD,
                        default=protection_min_hold_minutes(entry),
                    ): vol.All(vol.Coerce(int), vol.Range(min=0, max=180)),
                    vol.Optional(
                        OPT_WEATHER_ENTITY,
                        description={"suggested_value": forecast_weather_entity(entry)},
                    ): EntitySelector(EntitySelectorConfig(domain="weather")),
                }
            ),
        )
