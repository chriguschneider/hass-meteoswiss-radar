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
from homeassistant.components.http import HomeAssistantView
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
        # In-flight tasks: tail → Task[(int, bytes|None)] deduplicates
        # concurrent requests for the same URL into one upstream fetch.
        # A Task (not a raw Future) lets the fetch survive leader cancellation
        # so joiners still receive the result when the leader client disconnects
        # (issue #69).
        self._inflight: dict[str, asyncio.Task] = {}

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

        # Cache miss: run the fetch as a detached task so it survives leader
        # cancellation (issue #69). The leader and any joiners all shield the
        # same task; when the leader client disconnects, the task finishes and
        # caches the result, and the joiners still receive it.
        loop = asyncio.get_running_loop()
        task: asyncio.Task = loop.create_task(self._fetch_and_cache(tail))
        self._inflight[tail] = task
        task.add_done_callback(lambda _t: self._inflight.pop(tail, None))

        status, body = await asyncio.shield(task)
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

    async def _fetch_and_cache(self, tail: str) -> tuple[int, bytes | None]:
        """Fetch *tail*, cache on 200, and return the result.

        Runs as a detached task so the result is available to joiners even
        when the leader's request handler is cancelled (issue #69).
        """
        result = await self._fetch(tail)
        status, body = result
        if status == 200 and body is not None:
            self._cache_put(tail, body)
        return result

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


# Vendored assets live flat on disk (frontend/vendor/leaflet.js, .../images/*);
# the {tag} URL segment is purely an opaque cache-buster and is NEVER used to
# resolve a filesystem path. Only these relative paths may be served -- an
# allowlist, not the disk layout, is the security boundary (mirrors the proxy
# allowlist in ADR-0001). The extension also fixes the Content-Type.
_VENDOR_FILES = {
    "leaflet.js": "text/javascript",
    "leaflet.css": "text/css",
    "images/layers.png": "image/png",
    "images/layers-2x.png": "image/png",
    "images/marker-icon.png": "image/png",
    "images/marker-icon-2x.png": "image/png",
    "images/marker-shadow.png": "image/png",
}


class MeteoSwissRadarVendorView(HomeAssistantView):
    """Serve vendored assets version-agnostically (issue #70).

    The card requests /vendor/<tag>/<file>, where <tag> is the card version
    used only as an opaque cache-buster. A static mount keyed on the current
    Python VERSION broke two cases: a card left open across an upgrade asks
    for the *old* tag (404 -> "Leaflet failed to load" until reload), and a
    new card running against a not-yet-restarted process (after a HACS file
    swap) asks for a tag the running mount does not know -- the same 404, and
    the exact wall that forces a restart for JS-only updates (issue #91).

    This view ignores <tag> for resolution and reads frontend/vendor/<file>
    from disk at request time, so every tag resolves as long as the file
    exists. <file> must be one of _VENDOR_FILES, and the resolved path is
    re-checked for containment so a traversal attempt in <file> cannot escape
    the vendor directory.
    """

    url = f"{FRONTEND_URL_BASE}/vendor/{{tag}}/{{filename:.+}}"
    name = "meteoswiss_radar:vendor"
    requires_auth = False

    async def get(
        self, request: web.Request, tag: str, filename: str
    ) -> web.FileResponse | web.Response:
        content_type = _VENDOR_FILES.get(filename)
        if content_type is None:
            return web.Response(status=404)
        vendor_dir = (Path(__file__).parent / "frontend" / "vendor").resolve()
        asset_path = (vendor_dir / filename).resolve()
        # Defence in depth: the allowlist already excludes traversal, but never
        # serve a path that resolves outside the vendor directory.
        if (
            not asset_path.is_relative_to(vendor_dir)
            or not asset_path.is_file()
        ):
            return web.Response(status=404)
        return web.FileResponse(
            asset_path,
            headers={
                "Content-Type": content_type,
                "Cache-Control": "private, max-age=86400, immutable",
            },
        )


# Routes (the two HTTP views and the static vendor mounts) can only be
# registered once per HA run: HA has no API to unregister a view or a static
# path, so a config-entry reload must not re-register them. This flag is
# deliberately NOT cleared on unload -- unlike the card resource below, the
# routes genuinely survive an unload (verified against HA 2024.7 core).
_ROUTES_KEY = f"{DOMAIN}_routes_registered"


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Register proxy view and static paths once; (re-)register the card resource.

    The card's extra-JS URL is removed on unload, so it must be re-added on
    every setup -- otherwise a reload (UI "Reload", disable/enable, or
    homeassistant.reload_config_entry) leaves every dashboard without the card
    until a full HA restart (issue #67).
    """
    if hass.data.get(_ROUTES_KEY):
        _register_card_resource(hass)
        return True

    hass.http.register_view(MeteoSwissRadarProxyView(hass))
    hass.http.register_view(MeteoSwissRadarCardView())
    # A view (not a static mount): the {tag} in the vendor URL must map to the
    # same on-disk files regardless of which version stamped it, so old and new
    # cards both resolve across an upgrade or a restart-free JS update (#70).
    hass.http.register_view(MeteoSwissRadarVendorView())
    hass.data[_ROUTES_KEY] = True
    _register_card_resource(hass)
    return True


def _register_card_resource(hass: HomeAssistant) -> None:
    """Add the card's extra-JS URL to every dashboard, once per active entry.

    Guarded by DOMAIN (popped on unload) so a second setup without an
    intervening unload does not register a duplicate URL.
    """
    if hass.data.get(DOMAIN):
        return
    add_extra_js_url(hass, f"{FRONTEND_URL_BASE}/{CARD_FILENAME}")
    hass.data[DOMAIN] = True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Remove the card resource so a later setup re-adds it; routes stay put.

    The routes (views + static paths) cannot be unregistered in HA and remain
    until restart, so _ROUTES_KEY is intentionally left set. Popping DOMAIN
    lets the next async_setup_entry re-register the card resource (issue #67).
    """
    remove_extra_js_url(hass, f"{FRONTEND_URL_BASE}/{CARD_FILENAME}")
    hass.data.pop(DOMAIN, None)
    return True
