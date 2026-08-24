# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).
This project uses a `v` prefix on release tags from v0.9.0 onward (e.g. `v0.9.0`);
the two existing tags (`0.7.6`, `0.8.0`) keep their original form.

## [Unreleased]

## [v0.10.0] — 2026-08-24

### Added

- Card: lightning strike overlay (`layer_lightning: true`) — point data from
  the MeteoSwiss lightning product, fetched once per version and filtered
  per measurement frame client-side; empty on forecast frames by design (#93)

### Fixed

- Proxy: detach in-flight fetch task so leader cancellation cannot kill
  coalesced joiners (#69)
- Card: guard async-init continuations against mid-await teardown so a
  disconnected card cannot leak a map, interval, or RAF loop (#68)
- Integration: re-register the card JS resource on config-entry reload so
  it is not permanently de-registered until HA restart (#67)
- Card: stop the timeline day-label loop from hanging the browser on the
  DST fall-back day (#66)
- Integration: serve vendor assets version-agnostically so old cards do
  not 404 after an upgrade and so JS-only updates no longer require a
  Home Assistant restart (#70)

### Added

- Card: Leaflet load and the three-request data chain now run in parallel,
  cutting cold-start time on slow connections (#72)

## [v0.9.0] — 2026-08-24

### Added

- Proxy: allowlist four new upstream paths for INCA precipitation-type
  overlays (snow, sleet, freezing rain) and the lightning product (#92)
- Card: infrastructure for precipitation-type overlay layers — manifest
  parsing stores overlay URLs on forecast frames, `_ensureOverlayFrame`
  fetches them best-effort (no fail-streak impact), `_showFrame` renders
  active overlays, and `_prefetch` warms upcoming overlay frames (#92)
- Card: vertical layer-toggle stack on the map (app parity); per-layer
  `layer_snow`/`layer_snowrain`/`layer_freezing_rain`/`layer_lightning`
  config keys (default `false` = button hidden) with optional
  `layer_<x>_on: true` for wall tablets (#92)
- Card: overlay legend swatches shown per active layer (#92)
- Editor: new "Layers" section with chips for each overlay layer (#92)

## [0.8.0] — 2026-08-24

### Fixed

- `package.json` version had silently drifted behind `manifest.json`; it
  is now covered by the version-sync test and brought to 0.8.0 (#64)

## [0.7.6] — 2026-08-24

First HACS release. Contains the full batch of stability, performance,
and test improvements from the 2026-08-22 architecture review.

### Fixed

- Card: paused card was not redrawn on manifest rollover, showing stale
  radar until manual reload (#1)
- Card: playback froze permanently after transient network failures; now
  retries automatically (#2)
- Card: Leaflet map, interval, and RAF loop leaked on card disconnect;
  config edits now apply in place without a full teardown and recreate (#3)
- Card: editor wrote every config key — including defaults — into the card
  config on every save; now only changed values are emitted (#4)
- Card: a first-frame fetch failure at init left the timeline and controls
  absent until reload; the card now retries (#5)
- Card: a single failed Leaflet load bricked the card until browser
  reload; the card now retries the script tag (#6)
- Card: missing `pointercancel` / `lostpointercapture` handling could kill
  autoplay on touch devices (#7)
- Card: zoom and center config values are now validated on set (#8)
- Card: time-axis day separators rendered at inconsistent fractional
  thickness; they now snap to the device pixel grid (#48)
- Integration: proxy did not guard against upstream redirects, oversized
  responses, or unexpected HTTP status codes; all three are now handled (#10)
- Integration: four setup/unload lifecycle gaps fixed (setup flag,
  teardown order, file-existence check, cache-control header) (#13)
- Integration: `hacs.json` declared HA 2024.6.0 as the minimum but the
  code requires 2024.7.0 (#62)

### Added

- Card: autoplay resumes automatically when a cached card element
  reconnects to the DOM (#9)
- Card: typed-array geometry storage; Path2D cache capped at a fixed
  constant; decoded-frame cache bounded by bytes (not frame count);
  one `Float32Array` per area with an `Int32Array` ring-offset index
  (#14, #51, #52, #53)
- Card: label DOM reuse, cached `Intl.DateTimeFormat`, and
  window-aware frame prefetch (#15)
- Integration: proxy gains server-side caching, in-flight request
  deduplication, and response compression (#11)
- Integration: vendor asset URLs embed the card version as a cache-buster
  tag (#12)
- Tests: independent Python reference decoder and window/time-logic tests
  for the card decoder (#16); full proxy allowlist, cache-header, and
  lifecycle coverage (#17)

[Unreleased]: https://github.com/chriguschneider/hass-meteoswiss-radar/compare/v0.10.0...HEAD
[v0.10.0]: https://github.com/chriguschneider/hass-meteoswiss-radar/compare/v0.9.0...v0.10.0
[v0.9.0]: https://github.com/chriguschneider/hass-meteoswiss-radar/compare/0.8.0...v0.9.0
[0.8.0]: https://github.com/chriguschneider/hass-meteoswiss-radar/compare/0.7.6...0.8.0
[0.7.6]: https://github.com/chriguschneider/hass-meteoswiss-radar/releases/tag/0.7.6
