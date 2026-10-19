# Upstream facts

Measured facts about every external system this repo talks to: endpoints,
file formats, units, update cadence, limits, quirks. Agents read this file
before they touch anything that depends on an upstream, and every lookup
table or constant in the code cites a line in the files below, a URL or a
fixture cut from a real file.

This repo kept its facts where they already were; this page is the index.

## MeteoSwiss app API (`www.meteoschweiz.admin.ch`)

- **[`FORMAT.md`](../FORMAT.md)** — the source of truth for the wire
  format: endpoints, the versions file, the animation manifest, frame
  layout, chain-code contours, the swisstopo approximation constants,
  measured frame sizes, lightning, the basemap and the required
  attribution. Reverse-engineered 2026-08-21; later measurements carry
  their date. Both decoders (the card and `nowcast_core.py`) follow it
  (ADR-0009).
- **[ADR-0001](adr/0001-proxy-path-allowlist.md)** — the exact upstream
  paths the proxy may fetch (`_ALLOWED_PATHS`). A path not listed there is
  not used.
- **[ADR-0009](adr/0009-local-rain-nowcast-entities.md)** — measured
  legend/palette facts behind the rain classification (RZC vs INCA palette
  drift, distance caps, live legend bands, 2026-10-02).
- **[`LOCAL_NOWCAST.md`](../LOCAL_NOWCAST.md)** — what the nowcast entities
  derive from those frames, for users.
- **`tests/fixtures/`** — trimmed real frames and manifests; the decoder
  snapshots are generated from them.

The weekly smoke test (`tests/tools/smoke_test.py`, ADR-0006) checks the
live API against this. When it fails, compare what upstream returns now
with `FORMAT.md` before touching a decoder, and add a dated entry there
instead of rewriting history.

## swisstopo WMTS basemap

The card loads the grey pixel map tiles straight from `wmts.geo.admin.ch`
in the browser (no proxy, no key). URL and attribution: `FORMAT.md`,
*Basemap* and *Attribution*.

## Home Assistant weather entity (ADR-0010)

`next_rain` beyond the radar horizon reads a user-chosen weather entity
through `weather.get_forecasts`; no other upstream is contacted.
