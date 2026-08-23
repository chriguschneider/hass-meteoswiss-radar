"""MeteoSwiss Radar: authenticated proxy for the MeteoSwiss app API + Lovelace card.

The integration has no entities. It provides:
- an authenticated HTTP proxy (the MeteoSwiss endpoints send no CORS headers,
  so the card cannot fetch them directly from the browser),
- the card bundle as a static frontend resource, auto-registered on every
  dashboard via add_extra_js_url (works for storage and YAML mode alike).
"""

from __future__ import annotations

import asyncio
import collections
import logging
import re
import time
from pathlib import Path

from aiohttp import ClientError, ClientTimeout, web

from homeassistant.components.frontend import add_extra_js_url, remove_extra_js_url
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
_MAX_BODY_BYTES = 2 * 1024 * 1024  # 2 MB hard ceiling per response
_VERSIONS_TTL = 60.0  # seconds between re-fetches of versions.json
_LRU_MAX = 50  # max immutable-frame entries (~5 MB at typical frame size)


class MeteoSwissRadarProxyView(HomeAssistantView):
    """Authenticated pass-through to the MeteoSwiss app API."""

    url = PROXY_URL
    name = "api:meteoswiss_radar:proxy"
    requires_auth = True

    def __init__(self, hass: HomeAssistant) -> None:
        self._hass = hass
        # TTL cache for versions.json: (monotonic_time, body) or None.
        self._versions_cache: tuple[float, bytes] | None = None
        # LRU for immutable frames (animation manifest + radar/inca frames).
        self._lru: collections.OrderedDict[str, bytes] = collections.OrderedDict()
        # In-flight futures: tail → Future[(int, bytes|None)] deduplicates
        # concurrent requests for the same URL into one upstream fetch.
        self._inflight: dict[str, asyncio.Future] = {}

    async def get(self, request: web.Request, tail: str) -> web.Response:
        if not any(rx.fullmatch(tail) for rx in _ALLOWED_PATHS):
            return web.Response(status=404)

        # Join an existing in-flight fetch rather than opening a second upstream.
        if tail in self._inflight:
            status, body = await asyncio.shield(self._inflight[tail])
            return self._build_response(tail, status, body)

        # Cache hit: no upstream request needed.
        cached = self._cache_get(tail)
        if cached is not None:
            return self._build_response(tail, 200, cached)

        # Cache miss: fetch from upstream, protected by an in-flight Future so
        # any concurrent arrivals for the same tail join this fetch.
        loop = asyncio.get_running_loop()
        fut: asyncio.Future = loop.create_future()
        self._inflight[tail] = fut
        result: tuple[int, bytes | None]
        try:
            result = await self._fetch(tail)
            if not fut.done():
                fut.set_result(result)
        except asyncio.CancelledError:
            if not fut.done():
                fut.cancel()
            raise
        except Exception as exc:
            if not fut.done():
                fut.set_exception(exc)
            raise
        finally:
            self._inflight.pop(tail, None)

        status, body = result
        if status == 200 and body is not None:
            self._cache_put(tail, body)
        return self._build_response(tail, status, body)

    # ------------------------------------------------------------------
    # Cache
    # ------------------------------------------------------------------

    def _cache_get(self, tail: str) -> bytes | None:
        if tail.endswith("versions.json"):
            if self._versions_cache is not None:
                ts, body = self._versions_cache
                if time.monotonic() - ts < _VERSIONS_TTL:
                    return body
            return None
        if tail in self._lru:
            self._lru.move_to_end(tail)
            return self._lru[tail]
        return None

    def _cache_put(self, tail: str, body: bytes) -> None:
        if tail.endswith("versions.json"):
            self._versions_cache = (time.monotonic(), body)
        else:
            self._lru[tail] = body
            self._lru.move_to_end(tail)
            while len(self._lru) > _LRU_MAX:
                self._lru.popitem(last=False)

    # ------------------------------------------------------------------
    # Upstream fetch
    # ------------------------------------------------------------------

    async def _fetch(self, tail: str) -> tuple[int, bytes | None]:
        """Fetch *tail* from upstream. Always returns (status, body_or_None)."""
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
                    return (502, None)
                # 404 passes through unchanged: the card's manifest-rollover
                # logic depends on detecting it via _is404().
                if resp.status == 404:
                    return (404, None)
                # Relay upstream 401/403/5xx as 502 so the HA frontend does
                # not mistake them for HA auth failures or trigger retries.
                if resp.status != 200:
                    _LOGGER.warning(
                        "Upstream %s returned HTTP %s", tail, resp.status
                    )
                    return (502, None)
                if "json" not in resp.headers.get("Content-Type", ""):
                    # A site relaunch serving HTML with 200 must not reach
                    # the card as a "valid" response.
                    _LOGGER.warning(
                        "Upstream %s returned non-JSON content type %s",
                        tail,
                        resp.headers.get("Content-Type"),
                    )
                    return (502, None)
                chunks: list[bytes] = []
                total = 0
                async for chunk in resp.content.iter_chunked(65536):
                    total += len(chunk)
                    if total > _MAX_BODY_BYTES:
                        _LOGGER.warning(
                            "Upstream %s body exceeds %d bytes", tail, _MAX_BODY_BYTES
                        )
                        return (502, None)
                    chunks.append(chunk)
                return (200, b"".join(chunks))
        except TimeoutError:
            _LOGGER.warning("Upstream request %s timed out", tail)
            return (504, None)
        except ClientError as err:
            _LOGGER.warning("Upstream request %s failed: %s", tail, err)
            return (502, None)

    # ------------------------------------------------------------------
    # Response builder
    # ------------------------------------------------------------------

    def _build_response(
        self, tail: str, status: int, body: bytes | None
    ) -> web.Response:
        if status != 200 or body is None:
            return web.Response(status=status)
        # versions.json must stay fresh; everything else is version- or
        # timestamp-pinned and therefore immutable. authenticated endpoint
        # requires Cache-Control: private to prevent shared-cache exposure.
        cache = (
            "no-store"
            if tail.endswith("versions.json")
            else "private, max-age=86400, immutable"
        )
        resp = web.Response(
            body=body,
            content_type="application/json",
            charset="utf-8",
            headers={"Cache-Control": cache},
        )
        resp.enable_compression()
        return resp


class MeteoSwissRadarCardView(HomeAssistantView):
    """Serve the card bundle with forced revalidation.

    'no-cache' (revalidate, 304 when unchanged) instead of a static path:
    an absent Cache-Control header would let browsers cache heuristically
    and run a stale card for minutes after a deploy.
    """

    url = f"{FRONTEND_URL_BASE}/{CARD_FILENAME}"
    name = "meteoswiss_radar:card"
    requires_auth = False

    async def get(self, request: web.Request) -> web.FileResponse | web.Response:
        card_path = Path(__file__).parent / "frontend" / CARD_FILENAME
        if not card_path.is_file():
            _LOGGER.warning(
                "Card file not found at %s; ensure frontend/ directory exists",
                card_path,
            )
            return web.Response(status=404)
        return web.FileResponse(
            card_path,
            headers={"Cache-Control": "no-cache"},
        )


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Register proxy view, static frontend path and the card resource once."""
    if hass.data.get(DOMAIN):
        return True

    hass.http.register_view(MeteoSwissRadarProxyView(hass))
    hass.http.register_view(MeteoSwissRadarCardView())

    frontend_dir = Path(__file__).parent / "frontend"
    vendor_dir = str(frontend_dir / "vendor")
    await hass.http.async_register_static_paths(
        [
            # Vendored assets are immutable per release and stay cached; the
            # VERSION segment is what busts that cache on upgrade.
            StaticPathConfig(
                f"{FRONTEND_URL_BASE}/vendor/{VERSION}",
                vendor_dir,
                cache_headers=True,
            ),
            # Unversioned fallback for cards from before the versioned path: a
            # dashboard tab left open across an upgrade keeps running the old
            # card, which asks for this URL the first time it needs Leaflet, and
            # would otherwise show "Leaflet failed to load" until a page reload.
            # It cannot shadow the versioned mount above -- aiohttp resolves the
            # most explicit URL prefix first, not in registration order.
            StaticPathConfig(
                f"{FRONTEND_URL_BASE}/vendor",
                vendor_dir,
                cache_headers=True,
            ),
        ]
    )
    add_extra_js_url(hass, f"{FRONTEND_URL_BASE}/{CARD_FILENAME}")
    hass.data[DOMAIN] = True
    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Remove card from dashboards; routes remain until restart."""
    remove_extra_js_url(hass, f"{FRONTEND_URL_BASE}/{CARD_FILENAME}")
    return True
