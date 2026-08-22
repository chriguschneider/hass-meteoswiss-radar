# hass-meteoswiss-radar

MeteoSwiss precipitation radar for Home Assistant: a custom integration that
proxies the MeteoSwiss app API (their endpoints send no CORS headers) and
ships a Lovelace card rendering the radar on a swisstopo basemap with Leaflet.

**Status: work in progress.** The card plays the full radar animation —
~12 h of measurement into ~28 h of INCA forecast — with play/pause, a
scrubbing slider with hour/day axis and playhead bubble, a
measurement/forecast label and an intensity legend overlay, centered on
your home location. The frame list refreshes itself while the
card is open, and upstream breakage degrades to a clean banner instead of a
broken card. Remaining before v1: HACS packaging.

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

### Options

| Option | Default | Description |
| --- | --- | --- |
| `height` | `400` | Map height in px. |
| `zoom` | `8` | Initial map zoom. |
| `center` | home location | `[lat, lon]` map center; the house marker follows the home location regardless. |
| `frame_duration` | `300` | Milliseconds per animation frame. |
| `frame_stride` | `1` | Play every Nth frame — raise on slow devices. |
| `past_hours` | full range | Hours of measurement history to keep on the timeline. |
| `forecast_hours` | full range | Hours of forecast to keep; `0` gives a measurement-only card. |
| `autoplay` | `false` | Start playing as soon as the card loads. |
| `legend` | `true` | Show the intensity legend (mm/h) under the controls. |
| `time_axis` | `true` | Hour ticks, 6-h labels, day labels and a red "now" marker under the timeline. |
| `time_bubble` | `true` | Floating time chip that rides the playhead. |
| `large_label` | `true` | Big date/time label on the map with a Measurement/Forecast line. |
| `progress_bar` | `true` | Playhead dot and elapsed shading on the measurement/forecast bar. |

## Attribution

Radar data: [MeteoSwiss](https://www.meteoschweiz.admin.ch). Basemap:
[swisstopo](https://www.swisstopo.admin.ch). This project is not affiliated
with either. Map rendering: [Leaflet](https://leafletjs.com) (vendored).

## License

MIT
