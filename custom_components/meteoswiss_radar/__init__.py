"""MeteoSwiss Radar: authenticated proxy for the MeteoSwiss app API + Lovelace card.

The integration has no entities. It provides:
- an authenticated HTTP proxy (the MeteoSwiss endpoints send no CORS headers,
  so the card cannot fetch them directly from the browser),
- the card bundle as a static frontend resource, auto-registered on every
  dashboard via add_extra_js_url (works for storage and YAML mode alike).
"""

from __future__ import annotations

import logging
import re
from pathlib import Path

from aiohttp import ClientError, ClientTimeout, web

from homeassistant.components.frontend import add_extra_js_url
from homeassistant.components.http import HomeAssistantView, StaticPathConfig
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.aiohttp_client import async_get_clientsession

from .const import (
    CARD_FILENAME,
    DOMAIN,
    FRONTEND_URL_BASE,
    PROXY_URL,
    UPSTREAM_BASE,
    VERSION,
)

_LOGGER = logging.getLogger(__name__)

# Only these upstream paths may be proxied.
_ALLOWED_PATHS = (
    re.compile(r"product/output/versions\.json"),
    re.compile(
        r"product/output/precipitation/animation/version__\d{8}_\d{4}/[a-z]{2}/animation\.json"
    ),
    re.compile(r"product/output/radar/rzc/radar_rzc\.\d{8}_\d{4}\.json"),
    re.compile(
        r"product/output/inca/precipitation/rate/version__\d{8}_\d{4}/rate_\d{8}_\d{4}\.json"
    ),
)

_UPSTREAM_TIMEOUT = ClientTimeout(total=20)


class MeteoSwissRadarProxyView(HomeAssistantView):
    """Authenticated pass-through to the MeteoSwiss app API."""

    url = PROXY_URL
    name = "api:meteoswiss_radar:proxy"
    requires_auth = True

    def __init__(self, hass: HomeAssistant) -> None:
        self._hass = hass

    async def get(self, request: web.Request, tail: str) -> web.Response:
        if not any(rx.fullmatch(tail) for rx in _ALLOWED_PATHS):
            return web.Response(status=404)

        session = async_get_clientsession(self._hass)
        try:
            async with session.get(
                f"{UPSTREAM_BASE}/{tail}", timeout=_UPSTREAM_TIMEOUT
            ) as resp:
                if resp.status != 200:
                    _LOGGER.warning(
                        "Upstream %s returned HTTP %s", tail, resp.status
                    )
                    return web.Response(status=resp.status)
                body = await resp.read()
        except (TimeoutError, ClientError) as err:
            _LOGGER.warning("Upstream request %s failed: %s", tail, err)
            return web.Response(status=502)

        # versions.json must stay fresh; everything else is version- or
        # timestamp-pinned and therefore immutable.
        cache = (
            "no-store"
            if tail.endswith("versions.json")
            else "public, max-age=86400, immutable"
        )
        return web.Response(
            body=body,
            content_type="application/json",
            charset="utf-8",
            headers={"Cache-Control": cache},
        )


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Register proxy view, static frontend path and the card resource once."""
    if hass.data.get(DOMAIN):
        return True
    hass.data[DOMAIN] = True

    hass.http.register_view(MeteoSwissRadarProxyView(hass))

    frontend_dir = Path(__file__).parent / "frontend"
    await hass.http.async_register_static_paths(
        [StaticPathConfig(FRONTEND_URL_BASE, str(frontend_dir), cache_headers=True)]
    )
    # Version query defeats browser caching across integration updates.
    add_extra_js_url(hass, f"{FRONTEND_URL_BASE}/{CARD_FILENAME}?v={VERSION}")
    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Routes cannot be unregistered from aiohttp; keep them until restart."""
    return True
