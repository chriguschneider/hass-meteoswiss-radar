"""Config and options flow for the MeteoSwiss Radar integration."""

from __future__ import annotations

from typing import Any

import voluptuous as vol
from homeassistant.data_entry_flow import section
from homeassistant.helpers.selector import (
    EntitySelector,
    EntitySelectorConfig,
    NumberSelector,
    NumberSelectorConfig,
    NumberSelectorMode,
    SelectSelector,
    SelectSelectorConfig,
    SelectSelectorMode,
)
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
    OPT_RAIN_THRESHOLD,
    OPT_WEATHER_ENTITY,
)

# The dialog groups the nowcast refinements under headed sections so each
# reads as part of the feature it tunes. Sections only shape the form: the
# submitted values are flattened back so the stored options keep the flat keys
# every reader in __init__ expects.
SECTION_DETECTION = "rain_detection"
SECTION_PROTECTION = "rain_protection"
SECTION_FORECAST = "forecast"


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
            return self.async_create_entry(title="", data=_flatten(user_input))

        # Import here, not at module level: config_flow is imported by HA during
        # discovery, before __init__ has run, and __init__ imports this module's
        # sibling constants only.
        from . import (
            forecast_weather_entity,
            nowcast_entities_enabled,
            protection_min_hold_minutes,
            rain_threshold_mm_h,
        )

        # Resolve the entry from the flow handler rather than `self.config_entry`:
        # the plain `OptionsFlow.config_entry` property only exists from HA
        # 2024.12, but the manifest supports 2024.7.0, where reading it would
        # raise AttributeError and the options dialog would fail to open. The
        # handler is the entry id on every supported version, and looking it up
        # here also avoids the deprecated explicit `self.config_entry = ...`.
        entry = self.hass.config_entries.async_get_entry(self.handler)
        weather_entity = forecast_weather_entity(entry)

        return self.async_show_form(
            step_id="init",
            data_schema=vol.Schema(
                {
                    vol.Required(
                        OPT_NOWCAST_ENABLED,
                        default=nowcast_entities_enabled(self.hass, entry),
                    ): bool,
                    vol.Required(SECTION_DETECTION): section(
                        vol.Schema(
                            {
                                vol.Required(
                                    OPT_RAIN_THRESHOLD,
                                    default=str(int(rain_threshold_mm_h(entry))),
                                ): SelectSelector(
                                    SelectSelectorConfig(
                                        options=["1", "0"],
                                        translation_key=OPT_RAIN_THRESHOLD,
                                        mode=SelectSelectorMode.LIST,
                                        custom_value=False,
                                        multiple=False,
                                    )
                                ),
                            }
                        ),
                        {"collapsed": False},
                    ),
                    vol.Required(SECTION_PROTECTION): section(
                        vol.Schema(
                            {
                                vol.Required(
                                    OPT_PROTECTION_MIN_HOLD,
                                    default=protection_min_hold_minutes(entry),
                                ): NumberSelector(
                                    NumberSelectorConfig(
                                        min=0,
                                        max=180,
                                        step=1,
                                        unit_of_measurement="min",
                                        mode=NumberSelectorMode.BOX,
                                    )
                                ),
                            }
                        ),
                        {"collapsed": False},
                    ),
                    vol.Required(SECTION_FORECAST): section(
                        vol.Schema(
                            {
                                vol.Optional(
                                    OPT_WEATHER_ENTITY,
                                    description={"suggested_value": weather_entity},
                                ): EntitySelector(
                                    EntitySelectorConfig(domain="weather")
                                ),
                            }
                        ),
                        {"collapsed": False},
                    ),
                }
            ),
        )


def _flatten(user_input: dict[str, Any]) -> dict[str, Any]:
    """Lift the section values back to the flat option keys.

    The number selector submits a float; `protection_min_hold_minutes` rejects
    anything but an int and would silently fall back to the default, so the
    hold is stored as an int here. The threshold select submits a string;
    store its two choices numerically to preserve the existing option type.
    """
    options: dict[str, Any] = {}
    for key, value in user_input.items():
        if key in (
            SECTION_DETECTION, SECTION_PROTECTION, SECTION_FORECAST
        ) and isinstance(value, dict):
            options.update(value)
        else:
            options[key] = value
    hold = options.get(OPT_PROTECTION_MIN_HOLD)
    if isinstance(hold, float) and hold.is_integer():
        options[OPT_PROTECTION_MIN_HOLD] = int(hold)
    threshold = options.get(OPT_RAIN_THRESHOLD)
    if isinstance(threshold, str) and threshold in ("0", "1"):
        options[OPT_RAIN_THRESHOLD] = float(threshold)
    return options
