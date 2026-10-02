# ADR-0009: Local rain nowcast entities

- **Status:** Accepted
- **Date:** 2026-09-05

## Context

The radar integration already downloads and decodes the MeteoSwiss RZC / INCA
animation for the Lovelace card. Home Assistant automations cannot consume that
frontend state directly, so a user who wants to protect an awning or react to
local rain would otherwise need to scrape the card or introduce a second
MeteoSwiss request path.

The existing proxy is the repository's security boundary: it authenticates
requests through Home Assistant, restricts upstream paths with `_ALLOWED_PATHS`,
and centralizes caching plus in-flight request deduplication.

The nowcast also needs a conservative event model. A single dry frame should
not clear protection during a short shower gap, and missing current data must
not create a false all-clear.

## Decision

Expose local rain-nowcast state as normal Home Assistant sensor and binary
sensor entities.

Keep the pure contour geometry decoder and rain-event state machine in
`custom_components/meteoswiss_radar/nowcast_core.py`, without Home Assistant
dependencies. Keep Home Assistant scheduling and frame retrieval in
`custom_components/meteoswiss_radar/nowcast.py`, using a
`DataUpdateCoordinator`.

Reuse `MeteoSwissRadarProxyView.async_get_json()` for backend frame retrieval so
the entities and card share the existing allowlist, cache, authentication, and
in-flight request deduplication. Do not introduce a separate MeteoSwiss client
or broaden `_ALLOWED_PATHS` for the nowcast.

Treat rain as approaching when a wet frame is forecast within 30 minutes. Once
an event is active, keep protection enabled until the current measurement is
dry and the forecast explicitly covers a continuous 30-minute dry window.
Missing or stale data must not turn protection off.

Classify frame areas against the precipitation bands in the animation
manifest's `legend[]`, using the nearest RGB colour with a maximum Euclidean
distance of 15. The fixture evidence sets that cap: the closest two legend
colours are 31.0 RGB units apart, so a cap below half that distance (15.5)
keeps accepted nearest-colour matches unambiguous. The threshold boundary
between the 0-1 and 1-5 mm/h bands is 32.8 units apart. The documented frame
colour `9e849a` is 8.8 units from its `#9A7E95` legend colour and therefore
still matches, while the additional fixture colour `52af2a` is 130.3 units
from its nearest legend colour and remains unknown.

Treat only bands starting at 1 mm/h or above as wet; the lowest 0-1 mm/h band
is deliberately excluded because weak echoes are most susceptible to virga,
ground clutter, and beam shielding. When overlapping areas produce different
certainty, a classified wet area wins over an unclassifiable area; an
unclassifiable area in turn prevents a dry all-clear. This gives the precedence
wet, unknown, dry independently of area order.

Fetch only the warning lead window while dry. Extend the forecast adaptively
while rain is approaching or active so the integration can estimate event end
without imposing the long-frame fetch cost on every update.

The chain-code contour decoder exists in two places by necessity: the Lovelace
card (`decodeContourInto` in `meteoswiss-radar-card.js`) requires lat/lng output
into a `Float32Array` for canvas rendering; the backend
(`_decode_contour_grid` in `nowcast_core.py`) requires grid-km output so
point-in-polygon checks run without coordinate conversion on every call.
`FORMAT.md` is the single source of truth for the frame format and the
swisstopo approximation constants. A change to `FORMAT.md` or to either
decoder implementation requires updating both implementations and the
cross-check test in `tests/test_nowcast_core_local.py`.

## Update 2026-09-30 (issue #197): the entities are opt-in

The decision above created the entities for every config entry. That made a
card-only install grow five entities, a device and a 5-minute coordinator
unasked, which contradicts the reasoning the sibling weather integration records
in its ADR-0003 for keeping the two apart: *"users who want only the map should
not get a weather entity, and vice versa."* Read symmetrically, the same applies
here.

An options toggle (`nowcast_enabled`, default off) now gates the platforms, with
an update listener reloading the entry so the entities appear or disappear
without a restart.

Entries created before the option keep their entities: instead of writing a
migrated value during setup — which would trip the update listener and reload
the entry mid-setup — the absence of an explicit choice is resolved from the
entity registry on each setup, and an entry that already owns nowcast entities
reads as enabled. The first visit to the options dialog persists a real boolean.

## Update 2026-10-02 (issue #212): minimum hold on the protection signal

The decision above clears protection as soon as a dry window is confirmed. On a
live instance that produced on 00:43, off 00:48, on 00:53, off 01:18 — a shower
clipping the location, and four motor runs in 35 minutes for whatever the binary
sensor drives.

Protection now stays up for a configurable minimum (`protection_min_hold_minutes`,
default 30, 0 disables) once raised. The hold applies to the protection flag only:
`status` keeps reporting what the radar sees, so a held signal reads as `dry` with
protection on, and `protection_hold_until` records the reason. A missing-data
cycle is held as well — no data is not a reason to release an actuator signal
that is already up, and releasing it is the flapping this prevents.

The state machine and the hold are separate functions on purpose: one answers
"what is the weather doing", the other "may the actuator move yet".

## Consequences

- Automations can consume the same radar data as the card through stable Home
  Assistant entities instead of frontend scraping.
- The proxy remains the single upstream security and caching boundary.
- The integration now has entity platforms in addition to the proxy and card,
  so config-entry setup and unload must forward and unload those platforms
  correctly.
- Local geometry and event logic stay testable without installing Home
  Assistant.
- The manifest legend, rather than a hardcoded exclusion list, defines which
  frame colours represent precipitation; unclassifiable colours surface as
  frame failures and therefore cannot create a false wet or dry result.
- Conservative unknown handling can keep rain protection active longer than a
  best-effort forecast would, which is intentional for safety-oriented uses.
- The decoder duplication is guarded by a cross-check test in
  `tests/test_nowcast_core_local.py`: it decodes the same `frame.json`
  fixture with the Python decoder, converts grid-km output to lat/lng using
  the same swisstopo formula (inline in the test, not in production code),
  rounds to float32, and compares exactly against `frame_decoded.json` (the
  JS decoder's committed golden). A one-constant drift in either decoder
  fails CI.
- Changes to warning lead time, dry-window semantics, proxy reuse, the
  nowcast module boundary, the colour-to-precipitation mapping, or either
  decoder implementation should update this ADR.
