# ADR-0012: Editor place search via Open-Meteo geocoding

- **Status:** Accepted
- **Date:** 2026-11-18
- **Issue:** #261 (request #259)

## Context

The card has always taken `center: [lat, lon]`, but only in YAML. Editor-only
users could not centre the map anywhere but home. The maintainer decided to
take over the Location panel from weather-station-card (#372, traps fixed in
#413) so both cards set a place the same way. HA's `location` selector gives
a map with a draggable marker but has no place search, so finding a town
means a geocoder.

## Decision

The card editor gets a **Location** panel: the HA home line, a switch "Use
another location" (off removes `center`, on presets it to the HA home; with
no home coordinates nothing is written), a place search, HA's `location`
selector, and a small-print source line. The option shape stays
`center: [lat, lon]`; no new key, no migration.

The place search calls **Open-Meteo geocoding**
(`https://geocoding-api.open-meteo.com/v1/search`, documented at
<https://open-meteo.com/en/docs/geocoding-api>) straight from the browser
with plain `fetch`:

- only when the user clicks **Search**: never on render, on typing or on a
  marker drag;
- only in the editor; the card at runtime never calls it;
- not through the integration's proxy: the allowlist and `UPSTREAM_BASE`
  stay untouched (ADR-0001), and Home Assistant itself makes no request.

The editor shows "Place search: Open-Meteo (GeoNames data, CC BY 4.0)."
No place name is stored; only the picked coordinates are written.

## Consequences

- A second external host appears, in the editor only. The query text (a
  place name the user typed) goes to Open-Meteo; the home coordinates do not.
- If Open-Meteo is down or blocked, the search shows an error; the map and
  the latitude/longitude fields still work, so the option stays settable.
- The smoke test (ADR-0006) does not cover Open-Meteo: it is not a data
  source of the card, and a failure is visible to the user in the editor.
- No new dependency and no build step (ADR-0002): HA's own selector, plain
  `fetch`.
