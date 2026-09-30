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

Fetch only the warning lead window while dry. Extend the forecast adaptively
while rain is approaching or active so the integration can estimate event end
without imposing the long-frame fetch cost on every update.

## Consequences

- Automations can consume the same radar data as the card through stable Home
  Assistant entities instead of frontend scraping.
- The proxy remains the single upstream security and caching boundary.
- The integration now has entity platforms in addition to the proxy and card,
  so config-entry setup and unload must forward and unload those platforms
  correctly.
- Local geometry and event logic stay testable without installing Home
  Assistant.
- Conservative unknown handling can keep rain protection active longer than a
  best-effort forecast would, which is intentional for safety-oriented uses.
- Changes to warning lead time, dry-window semantics, proxy reuse, or the
  nowcast module boundary should update this ADR.
