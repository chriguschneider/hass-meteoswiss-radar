"""Config and options flow for the MeteoSwiss Radar integration."""

from __future__ import annotations

from typing import Any

import voluptuous as vol
from homeassistant.config_entries import (
    ConfigEntry,
    ConfigFlow,
    ConfigFlowResult,
    OptionsFlow,
)
from homeassistant.core import callback

from .const import DOMAIN, OPT_NOWCAST_ENABLED


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
    """Toggle the local nowcast entities (#197)."""

    async def async_step_init(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        if user_input is not None:
            return self.async_create_entry(title="", data=user_input)

        # Import here, not at module level: config_flow is imported by HA during
        # discovery, before __init__ has run, and __init__ imports this module's
        # sibling constants only.
        from . import nowcast_entities_enabled

        return self.async_show_form(
            step_id="init",
            data_schema=vol.Schema(
                {
                    vol.Required(
                        OPT_NOWCAST_ENABLED,
                        default=nowcast_entities_enabled(self.hass, self.config_entry),
                    ): bool,
                }
            ),
        )
