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
_MAX_BODY_BYTES = 2 * 1024 * 1024  # 2 MB hard ceiling per response


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
                f"{UPSTREAM_BASE}/{tail}",
                timeout=_UPSTREAM_TIMEOUT,
                allow_redirects=False,
            ) as resp:
                # 3xx: allowlisted product URLs never redirect; a redirect
                # means something unexpected upstream — block it.
                if 300 <= resp.status < 400:
                    _LOGGER.warning(
                        "Upstream %s redirected (%s)", tail, resp.status
                    )
                    return web.Response(status=502)
                # 404 passes through unchanged: the card's manifest-rollover
                # logic depends on detecting it via _is404().
                if resp.status == 404:
                    return web.Response(status=404)
                # Relay upstream 401/403/5xx as 502 so the HA frontend does
                # not mistake them for HA auth failures or trigger retries.
                if resp.status != 200:
                    _LOGGER.warning(
                        "Upstream %s returned HTTP %s", tail, resp.status
                    )
                    return web.Response(status=502)
                if "json" not in resp.headers.get("Content-Type", ""):
                    # A site relaunch serving HTML with 200 must not reach
                    # the card as a "valid" response.
                    _LOGGER.warning(
                        "Upstream %s returned non-JSON content type %s",
                        tail,
                        resp.headers.get("Content-Type"),
                    )
                    return web.Response(status=502)
                chunks: list[bytes] = []
                total = 0
                async for chunk in resp.content.iter_chunked(65536):
                    total += len(chunk)
                    if total > _MAX_BODY_BYTES:
                        _LOGGER.warning(
                            "Upstream %s body exceeds %d bytes", tail, _MAX_BODY_BYTES
                        )
                        return web.Response(status=502)
                    chunks.append(chunk)
                body = b"".join(chunks)
        except TimeoutError:
            _LOGGER.warning("Upstream request %s timed out", tail)
            return web.Response(status=504)
        except ClientError as err:
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


class MeteoSwissRadarCardView(HomeAssistantView):
    """Serve the card bundle with forced revalidation.

    'no-cache' (revalidate, 304 when unchanged) instead of a static path:
    an absent Cache-Control header would let browsers cache heuristically
    and run a stale card for minutes after a deploy.
    """

    url = f"{FRONTEND_URL_BASE}/{CARD_FILENAME}"
    name = "meteoswiss_radar:card"
    requires_auth = False

    async def get(self, request: web.Request) -> web.FileResponse:
        return web.FileResponse(
            Path(__file__).parent / "frontend" / CARD_FILENAME,
            headers={"Cache-Control": "no-cache"},
        )


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Register proxy view, static frontend path and the card resource once."""
    if hass.data.get(DOMAIN):
        return True
    hass.data[DOMAIN] = True

    hass.http.register_view(MeteoSwissRadarProxyView(hass))
    hass.http.register_view(MeteoSwissRadarCardView())

    frontend_dir = Path(__file__).parent / "frontend"
    await hass.http.async_register_static_paths(
        [
            # Vendored assets are immutable per release and stay cached.
            StaticPathConfig(
                f"{FRONTEND_URL_BASE}/vendor",
                str(frontend_dir / "vendor"),
                cache_headers=True,
            ),
        ]
    )
    add_extra_js_url(hass, f"{FRONTEND_URL_BASE}/{CARD_FILENAME}")
    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Routes cannot be unregistered from aiohttp; keep them until restart."""
    return True
