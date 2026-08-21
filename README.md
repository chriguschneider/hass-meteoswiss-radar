# hass-meteoswiss-radar

MeteoSwiss precipitation radar for Home Assistant: a custom integration that
proxies the MeteoSwiss app API (their endpoints send no CORS headers) and
ships a Lovelace card rendering the radar on a swisstopo basemap with Leaflet.

**Status: work in progress.** Current state: the card plays the full radar
animation — ~12 h of measurement into ~28 h of INCA forecast — with
play/pause, a scrubbing slider and a measurement/forecast label, centered on
your home location. The frame list refreshes itself while the card is open.
Legend and full configuration options are planned.

## How it works

- `custom_components/meteoswiss_radar/` registers an authenticated HTTP proxy
  (`/api/meteoswiss_radar/proxy/...`, allowlisted MeteoSwiss paths only) and
  serves the card bundle, auto-registered on every dashboard — no manual
  resource entry needed, YAML-mode dashboards included.
- The card fetches the radar frames through the proxy and decodes the
  chain-code polygon format documented in [FORMAT.md](FORMAT.md).

## Install (manual, for now)

1. Copy `custom_components/meteoswiss_radar/` into your HA `config/custom_components/`.
2. Restart Home Assistant.
3. Settings → Devices & Services → Add Integration → "MeteoSwiss Radar".
4. Add the card to a dashboard:

```yaml
type: custom:meteoswiss-radar-card
```

Optional: `height` (px, default 400), `zoom` (default 8),
`center` (`[lat, lon]`, default = home location), `frame_duration` (ms per
animation frame, default 300), `frame_stride` (play every Nth frame,
default 1 — raise on slow devices).

## Attribution

Radar data: [MeteoSwiss](https://www.meteoschweiz.admin.ch). Basemap:
[swisstopo](https://www.swisstopo.admin.ch). This project is not affiliated
with either. Map rendering: [Leaflet](https://leafletjs.com) (vendored).

## License

MIT
