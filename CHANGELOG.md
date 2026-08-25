# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).
This project uses a `v` prefix on release tags from v0.9.0 onward (e.g. `v0.9.0`);
the two existing tags (`0.7.6`, `0.8.0`) keep their original form.

## [Unreleased]

### Fixed

- CI: `release.yml` now reads the annotated tag's message through the GitHub
  API instead of `git tag -l`. `actions/checkout` fetches the real tags and
  then force-overwrites the triggering one with the resolved commit
  (`+<sha>:refs/tags/<tag>`), so locally the tag reports as a `commit` and its
  message is unreachable — v0.13.0 shipped titled bare `v0.13.0` instead of
  carrying its subject. The lightweight-tag guard is preserved, so a bare tag
  still cannot title a release with a commit subject (#183)

## [v0.13.0] — 2026-08-25

### Added

- CI: `.github/workflows/codeql.yml` — the static analysis ADR-0005 decided
  and #134 never wrote. `security-extended` over `javascript-typescript` and
  `python`, on PRs, on `master`, and weekly (Saturday 02:15 UTC). Vendored
  Leaflet and the binary test fixtures are excluded, mirroring
  `sonar.exclusions` (#180)
- CI: `.github/workflows/smoke-test.yml` — the weekly upstream tripwire
  ADR-0006 decided and that was likewise never written. Monday 02:00 UTC, it
  decodes live measurement and forecast frames and, on failure, opens or
  updates an "Upstream API format drift detected" issue rather than failing
  PRs. Deliberately labelled `bug`/`area-integration` and **not** with a
  P-label, so the autopilot does not try to fix MeteoSwiss changing their API
  (#180)
- CI: `.github/workflows/release.yml`, the tag-triggered release gate ADR-0004
  specified but that was never written. On a `v*` tag it asserts the tag
  against `manifest.json`, refuses to overwrite an existing release, extracts
  the matching `CHANGELOG.md` section as release notes, and publishes. v0.12.0
  was the last release cut by hand (#170)

### Fixed

- `tests/tools/smoke_test.py` reported upstream drift that had not happened
  when stdout was not UTF-8: the U+2713 status marks fail to encode, the print
  raises, and the broad `except` records it as a failed check. The workflow
  pins `PYTHONIOENCODING=utf-8` and the docstring warns anyone running it by
  hand (#180)
- CI: the SonarCloud job now runs `npm run coverage` before the scan. #175
  taught vitest to attribute the vm-loaded card (0 % → 81 %) and pointed
  `sonar.javascript.lcov.reportPaths` at `coverage/lcov.info`, but nothing in
  the workflow ever wrote that file, so the scanner kept seeing the card's
  ~2200 lines as uncovered and the quality gate stayed red. A guard step now
  fails loudly if the report is missing, since Sonar only warns (#171)

### Documentation

- `docs/brands-icon.md`: correct two claims that were wrong. The icon does
  **not** appear in HACS — only Home Assistant's own UI reads the in-repo
  `brand/` folder, while the HACS store list fetches
  `brands.home-assistant.io/_/{domain}/icon.png` and gets a 200 response
  carrying an "icon not available" picture. And the `home-assistant/brands`
  route is not merely superseded, it is closed: that repo's PR template
  refuses new custom components and 15 such PRs were rejected in the five days
  to 2026-08-25. Records the live measurements and the HACS-side fix in
  flight (`hacs/integration#5388`) (#84)

## [v0.12.0] — 2026-08-25

### Added

- Integration: ship the official MeteoSwiss brand icon in
  `custom_components/meteoswiss_radar/brand/`, replacing the default
  puzzle-piece in the integrations page and in HACS. Uses the brands proxy
  API (HA 2026.3+), which prefers an integration's own `brand/` folder over
  the `home-assistant/brands` CDN, so no PR against that repository is
  needed. Installs on HA older than 2026.3 keep the puzzle piece (#84)

### Changed

- CI: drop `ignore: brands` from the HACS validation job. HACS default-store
  inclusion requires the action to pass without any ignores, and the check now
  passes on its own — its validator looks for
  `custom_components/meteoswiss_radar/brand/icon.png` in the repository tree
  and only falls back to the `home-assistant/brands` CDN when that is absent
  (#85)
- CI: add the SonarCloud quality gate workflow that ADR-0007 decided but
  #134 never wrote (#165)

### Documentation

- README: restructured to the `weather-station-card` layout, with the card
  screenshot (`docs/images/card.png`) no longer a commented-out placeholder,
  and the option reference split out into `docs/CONFIGURATION.md` (#161)
- `docs/brands-icon.md`: the open question of whether HACS still demands a
  `home-assistant/brands` entry is answered — it does not, the in-repo `brand/`
  folder satisfies it, so #84 unblocks #85. Records the validator source and
  the no-ignores rule behind the CI change (#85)
- `docs/brands-icon.md`: verified icon generator and a runnable `gh` block for
  the brands submission (#84)

## [v0.11.0] — 2026-08-24

### Changed

- Card: layers are now switched only in the card configuration and an enabled
  layer is always shown — the on-card toggle buttons (which collided with the
  +/- zoom controls and lost their state on every dashboard reload) are gone;
  the legacy `layer_<x>_on` keys are ignored (#131)
- Card: editor chip changes for `layer_*` now apply to a live card without a
  full re-init (#131)

### Fixed

- Card: refresh `lightning.json` on its own version, independent of the
  animation product — a stalled animation version no longer pins stale strike
  data on the newest frames (live-verified during the 2026-08-24 thunderstorm;
  #131)

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

[Unreleased]: https://github.com/chriguschneider/hass-meteoswiss-radar/compare/v0.13.0...HEAD
[v0.13.0]: https://github.com/chriguschneider/hass-meteoswiss-radar/compare/v0.12.0...v0.13.0
[v0.12.0]: https://github.com/chriguschneider/hass-meteoswiss-radar/compare/v0.11.0...v0.12.0
[v0.11.0]: https://github.com/chriguschneider/hass-meteoswiss-radar/compare/v0.10.0...v0.11.0
[v0.10.0]: https://github.com/chriguschneider/hass-meteoswiss-radar/compare/v0.9.0...v0.10.0
[v0.9.0]: https://github.com/chriguschneider/hass-meteoswiss-radar/compare/0.8.0...v0.9.0
[0.8.0]: https://github.com/chriguschneider/hass-meteoswiss-radar/compare/0.7.6...0.8.0
[0.7.6]: https://github.com/chriguschneider/hass-meteoswiss-radar/releases/tag/0.7.6
