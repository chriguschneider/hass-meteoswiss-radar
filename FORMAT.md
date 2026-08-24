# MeteoSwiss app API + radar frame format

Reverse-engineered 2026-08-21 from the MeteoSwiss web app; verified against
live data (Python and JS decoders produce identical, plausible geometry).
This file is the source of truth for the decoder in
`custom_components/meteoswiss_radar/frontend/meteoswiss-radar-card.js`.

## Endpoints

Base `https://www.meteoschweiz.admin.ch`, no auth, **no CORS headers** (hence
the integration's proxy). All paths below are mirrored 1:1 behind
`/api/meteoswiss_radar/proxy/<path>` (allowlisted, HA-authenticated).

- `product/output/versions.json` — flat JSON dict `product -> version`
  (~200 keys). The animation manifest version is the value of
  `"precipitation/animation"` (format `YYYYMMDD_HHMM`). Never hardcode a
  version; this file must always be fetched fresh (proxy sends `no-store`).
- `product/output/precipitation/animation/version__<v>/de/animation.json` —
  animation manifest (~130 KB). Version-pinned URL, therefore immutable.
- Measurement frames:
  `product/output/radar/rzc/radar_rzc.<YYYYMMDD_HHMM>.json`
  (5-min steps, ~12 h back, ~100 KB each).
- Forecast frames (INCA rate):
  `product/output/inca/precipitation/rate/version__<v>/rate_<YYYYMMDD_HHMM>.json`
  (10-min steps, ~28 h ahead, ~24 KB each).
- Forecast frames (INCA precipitation-type overlays, issue #92):
  - Snow: `product/output/inca/precipitation/type/snow/version__<v_snow>/snow_<YYYYMMDD_HHMM>.json`
  - Sleet: `product/output/inca/precipitation/type/snowrain/version__<v_snowrain>/snowrain_<YYYYMMDD_HHMM>.json`
  - Freezing rain: `product/output/inca/precipitation/type/freezing-rain/version__<v_fr>/freezingrain_<YYYYMMDD_HHMM>.json`

  All 216 forecast frames carry `snow_url`, `snowrain_url`, and `freezingrain_url`
  in `animation.json`; measurement frames do not.

  **Per-product version pinning**: each product's URL carries its own version
  string, and within one manifest different products can reference different
  versions (observed: snow/snowrain at `version__20260824_0603`, freezing-rain at
  `0605`). The card must use the manifest URLs verbatim; never construct overlay
  URLs from a single version string.

  All type-overlay frames share the chain-code decoder and frame format described
  below.

- Lightning: `product/output/lightning/version__<v>/lightning.json`
  (see [Lightning](#lightning) section below).

## animation.json

- `map_images[0].pictures[]`: ~295 frames, each
  `{ data_type: "measurement"|"forecast", data_type_string, radar_url, day
  ("DD.MM.YYYY"), timepoint ("HH:MM"), timestamp (unix s) }`; forecast frames
  additionally carry `snow_url`, `snowrain_url`, `freezingrain_url` (absolute
  paths, e.g. `/product/output/inca/precipitation/type/snow/…`). Each overlay
  URL may reference a different version than the other overlays in the same frame
  — use the manifest URLs verbatim.
- `legend[]`: 9 bands `{ min, max?, color }` in mm/h, e.g.
  `{min:0, max:1, color:"#9A7E95"}` … `{min:60, color:"#AF00DD"}`.
  Display only — frames carry their own colors (see below).
- `cities[]`: `{ city_name, min_zoom, coord_x, coord_y (LV95 m), location_id }`
  (unused).
- `config.timestamp`: generation time (unix s).

## Frame JSON (rzc and INCA rate share the format)

```json
{
  "coords": { "system": "LV95", "x_min": 255.5, "x_max": 964.5, "x_count": 710,
               "y_min": -159.5, "y_max": 479.5, "y_count": 640 },
  "areas": [ { "color": "9e849a", "shapes": [ [ {contour}, ... ], ... ] }, ... ]
}
```

- The grid is the Swiss radar composite: 710 x 640 **km**, 1 km cells.
  Despite `system: "LV95"` the values are CH1903(LV03)-style km; convert with
  `E = x*1000 + 2000000`, `N = y*1000 + 1000000` to LV95 meters, then the
  standard swisstopo approximation formulas to WGS84.
- `areas[]` is ordered lowest intensity first — draw in array order.
  A frame may contain **more areas (observed: 11) than the 9 legend bands**,
  and the area colors differ slightly from the legend colors (e.g. `9e849a`
  vs. legend `#9A7E95`). Always fill with the area's own `color`.

### Chain-code contours

Each contour object is `{ i, j, d, o, l }`:

- `i`, `j`: start position in **half-cell units**. Exactly one of the two is
  even (verified over a full frame): `i` even means the vertex sits on a
  vertical gridline and the fractional offset applies to y; `i` odd means it
  sits on a horizontal gridline and the offset applies to x.
- `o`: string of digits, **one per vertex** — the vertex count is `o.length`.
  Per vertex: `off = digit/10 + 0.05` (sub-cell position along the gridline).
- `d`: string of char pairs, **one pair between consecutive vertices**, so
  `d.length == 2 * (o.length - 1)`. After emitting vertex `s`:
  `i += d.charCodeAt(2s) - 77; j += d.charCodeAt(2s+1) - 77` (77 = "M").
- Vertex to grid km:
  - `i` even: `x = x_min + (x_max-x_min) * (i/2) / x_count`,
    `y = y_min + (y_max-y_min) * ((j-1)/2 + off) / y_count`
  - `i` odd: `x = x_min + (x_max-x_min) * ((i-1)/2 + off) / x_count`,
    `y = y_min + (y_max-y_min) * (j/2) / y_count`
- Contours are **implicitly closed** (last vertex != first; close the ring
  when rendering — Leaflet polygons do this automatically).
- `l`: layer/z-order. Within one shape (an array of contours), index 0 is the
  filled outer ring and later contours are holes — render with `evenodd`
  fill rule so underlying bands/basemap show through.

### Original decoder

The app's own decoder lives in a webpack chunk, e.g.
`https://www.meteoschweiz.admin.ch/static/5364.8a528267.js` (function `p` for
vertices, `f` for GeoJSON assembly). The chunk hash changes with releases —
re-find it by grepping the page's chunks for `charCodeAt`.

## Lightning

```json
{
  "1787544300": [["46.9892", "5.9804"], ["47.0047", "6.0043"]],
  "1787543400": [["46.9728", "5.8963"]],
  "1787541900": [["46.9563", "5.8083"], ["46.9266", "5.8317"]]
}
```

- **Flat dict format**: keys are unix-second timestamps (numbers stored as strings in JSON),
  values are arrays of `["lat", "lng"]` string pairs representing individual lightning strikes.
- **5-minute bucket keys**: timestamps are aligned to 5-minute intervals. Only buckets with
  strikes are present in the response.
- **Multi-frame persistence**: a bucket remains in responses for several minutes after its first
  publication, allowing the card to match strikes to their corresponding radar frames using
  `strikesForFrame()`: filter strikes where `ts` falls in the half-open window
  `[frameTs, frameTs + duration)`, where `duration = nextFrameTs - frameTs` (or 300 s for the
  last frame).
- **Coordinate coercion**: string coordinates are coerced to numbers (`Number(lat)`, `Number(lng)`).

## Basemap

swisstopo WMTS raster, free, no key:
`https://wmts.geo.admin.ch/1.0.0/ch.swisstopo.pixelkarte-grau/default/current/3857/{z}/{x}/{y}.jpeg`
The app's MapTiler key is theirs — never reuse it.

## Attribution

The card must show "Source: MeteoSwiss" (plus © swisstopo for the basemap).
