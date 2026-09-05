"""Home Assistant coordinator for local MeteoSwiss radar / INCA nowcast."""

from __future__ import annotations

import asyncio
import logging
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from typing import TYPE_CHECKING, Any

from homeassistant.core import HomeAssistant
from homeassistant.helpers.update_coordinator import DataUpdateCoordinator, UpdateFailed

from .const import DOMAIN
from .nowcast_core import (
    DEFAULT_DRY_WINDOW_MINUTES,
    DEFAULT_WARNING_LEAD_MINUTES,
    RainNowcast,
    RainSample,
    RainStatus,
    evaluate_nowcast,
    frame_is_wet_at_grid_point,
    wgs84_to_grid_km,
)

if TYPE_CHECKING:
    from . import MeteoSwissRadarProxyView

_LOGGER = logging.getLogger(__name__)

UPDATE_INTERVAL = timedelta(minutes=5)
FORECAST_HORIZON = timedelta(hours=6)
FORECAST_PADDING = timedelta(minutes=DEFAULT_DRY_WINDOW_MINUTES)
MEASUREMENT_MAX_AGE = timedelta(minutes=15)
MAX_CONCURRENT_FRAME_FETCHES = 6


class MeteoSwissRadarNowcastCoordinator(DataUpdateCoordinator[RainNowcast]):
    """Evaluate RZC/INCA frames at the Home Assistant location."""

    def __init__(
        self,
        hass: HomeAssistant,
        proxy: MeteoSwissRadarProxyView,
        latitude: float,
        longitude: float,
    ) -> None:
        super().__init__(
            hass,
            _LOGGER,
            name=f"{DOMAIN}_nowcast",
            update_interval=UPDATE_INTERVAL,
        )
        self._proxy = proxy
        self._x_km, self._y_km = wgs84_to_grid_km(latitude, longitude)
        self._earlier_end_candidate: datetime | None = None
        self._earlier_end_confirmations = 0
        self.manifest_generated_at: datetime | None = None
        self.frame_failures = 0

    async def _async_update_data(self) -> RainNowcast:
        now = datetime.now(UTC)
        try:
            versions = await self._proxy.async_get_json(
                "product/output/versions.json"
            )
            animation_version = versions.get("precipitation/animation")
            if not animation_version:
                raise UpdateFailed("MeteoSwiss animation version is missing")

            manifest_tail = (
                "product/output/precipitation/animation/"
                f"version__{animation_version}/de/animation.json"
            )
            manifest = await self._proxy.async_get_json(manifest_tail)
        except UpdateFailed:
            raise
        except Exception as err:
            raise UpdateFailed(
                f"Unable to fetch MeteoSwiss nowcast manifest: {err}"
            ) from err

        self.manifest_generated_at = _manifest_generated_at(manifest)
        pictures = _flatten_pictures(manifest)
        if not pictures:
            raise UpdateFailed("MeteoSwiss animation manifest contains no frames")

        measurement_meta = _latest_measurement(pictures, now)
        all_forecast_meta = _forecast_frames(
            pictures,
            now,
            now + FORECAST_HORIZON + FORECAST_PADDING,
        )
        lead_end = now + timedelta(minutes=DEFAULT_WARNING_LEAD_MINUTES)
        lead_meta = [
            meta
            for meta in all_forecast_meta
            if float(meta["timestamp"]) <= lead_end.timestamp()
        ]
        later_meta = [
            meta
            for meta in all_forecast_meta
            if float(meta["timestamp"]) > lead_end.timestamp()
        ]

        measurement, forecast_samples, failures = await self._fetch_local_samples(
            measurement_meta,
            lead_meta,
        )

        if (
            measurement is not None
            and now - measurement.timestamp > MEASUREMENT_MAX_AGE
        ):
            measurement = RainSample(
                timestamp=measurement.timestamp,
                wet=None,
                source=measurement.source,
            )

        raw = evaluate_nowcast(
            now=now,
            measurement=measurement,
            forecast_samples=forecast_samples,
            previous=self.data,
        )

        # On a dry day only the short lead window is needed.  Once rain is
        # approaching/active, extend the fetch so the UI can also estimate the
        # event end and bridge short dry interruptions correctly.
        if raw.status in (RainStatus.APPROACHING, RainStatus.ACTIVE) and later_meta:
            _, later_samples, later_failures = await self._fetch_local_samples(
                None,
                later_meta,
            )
            failures += later_failures
            forecast_samples.extend(later_samples)
            raw = evaluate_nowcast(
                now=now,
                measurement=measurement,
                forecast_samples=forecast_samples,
                previous=self.data,
            )

        self.frame_failures = failures
        return self._stabilize_earlier_end(raw)

    async def _fetch_local_samples(
        self,
        measurement_meta: dict[str, Any] | None,
        forecast_meta: list[dict[str, Any]],
    ) -> tuple[RainSample | None, list[RainSample], int]:
        semaphore = asyncio.Semaphore(MAX_CONCURRENT_FRAME_FETCHES)

        async def fetch_one(meta: dict[str, Any]) -> RainSample:
            timestamp = datetime.fromtimestamp(float(meta["timestamp"]), tz=UTC)
            source = str(meta.get("data_type") or "forecast")
            radar_url = str(meta.get("radar_url") or "").lstrip("/")
            if not radar_url:
                return RainSample(timestamp=timestamp, wet=None, source=source)
            try:
                async with semaphore:
                    frame = await self._proxy.async_get_json(radar_url)
                wet = await self.hass.async_add_executor_job(
                    frame_is_wet_at_grid_point,
                    frame,
                    self._x_km,
                    self._y_km,
                )
                return RainSample(timestamp=timestamp, wet=wet, source=source)
            except Exception as err:
                _LOGGER.debug("Nowcast frame %s unavailable: %s", radar_url, err)
                return RainSample(timestamp=timestamp, wet=None, source=source)

        tasks: list[asyncio.Task[RainSample]] = []
        all_meta: list[dict[str, Any]] = []
        if measurement_meta is not None:
            all_meta.append(measurement_meta)
        all_meta.extend(forecast_meta)

        async with asyncio.TaskGroup() as group:
            for meta in all_meta:
                tasks.append(group.create_task(fetch_one(meta)))

        samples = [task.result() for task in tasks]
        failures = sum(sample.wet is None for sample in samples)

        measurement: RainSample | None = None
        offset = 0
        if measurement_meta is not None:
            measurement = samples[0]
            offset = 1
        return measurement, samples[offset:], failures

    def _stabilize_earlier_end(self, data: RainNowcast) -> RainNowcast:
        """Require two updates before moving an active event's end earlier.

        Extensions are accepted immediately.  The rule only smooths the displayed
        predicted end while an event is active/approaching; it never delays the
        actual end once a 30-minute dry window from *now* has been confirmed.
        """

        previous = self.data
        if (
            previous is None
            or data.status not in (RainStatus.ACTIVE, RainStatus.APPROACHING)
            or previous.status not in (RainStatus.ACTIVE, RainStatus.APPROACHING)
            or data.event_end is None
            or previous.event_end is None
            or data.event_end >= previous.event_end
        ):
            self._earlier_end_candidate = None
            self._earlier_end_confirmations = 0
            return data

        if self._earlier_end_candidate == data.event_end:
            self._earlier_end_confirmations += 1
        else:
            self._earlier_end_candidate = data.event_end
            self._earlier_end_confirmations = 1

        if self._earlier_end_confirmations >= 2:
            self._earlier_end_candidate = None
            self._earlier_end_confirmations = 0
            return data

        return replace(
            data,
            event_end=previous.event_end,
            event_end_open=previous.event_end_open,
        )


def _flatten_pictures(manifest: dict[str, Any]) -> list[dict[str, Any]]:
    pictures: list[dict[str, Any]] = []
    for day_group in manifest.get("map_images") or []:
        pictures.extend(day_group.get("pictures") or [])
    return sorted(
        (picture for picture in pictures if picture.get("timestamp")),
        key=lambda picture: float(picture["timestamp"]),
    )


def _latest_measurement(
    pictures: list[dict[str, Any]], now: datetime
) -> dict[str, Any] | None:
    now_ts = now.timestamp() + 60.0
    candidates = [
        picture
        for picture in pictures
        if picture.get("data_type") == "measurement"
        and float(picture["timestamp"]) <= now_ts
        and picture.get("radar_url")
    ]
    return candidates[-1] if candidates else None


def _forecast_frames(
    pictures: list[dict[str, Any]],
    start: datetime,
    end: datetime,
) -> list[dict[str, Any]]:
    start_ts = start.timestamp() - 60.0
    end_ts = end.timestamp()
    return [
        picture
        for picture in pictures
        if picture.get("data_type") == "forecast"
        and start_ts <= float(picture["timestamp"]) <= end_ts
        and picture.get("radar_url")
    ]


def _manifest_generated_at(manifest: dict[str, Any]) -> datetime | None:
    raw = (manifest.get("config") or {}).get("timestamp")
    try:
        return datetime.fromtimestamp(float(raw), tz=UTC)
    except (TypeError, ValueError, OSError):
        return None
