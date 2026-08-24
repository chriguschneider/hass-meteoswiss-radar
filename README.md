# hass-meteoswiss-radar

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://github.com/chriguschneider/hass-meteoswiss-radar/blob/master/LICENSE)
[![GitHub Release](https://img.shields.io/github/release/chriguschneider/hass-meteoswiss-radar.svg)](https://github.com/chriguschneider/hass-meteoswiss-radar/releases)
[![CI Status](https://img.shields.io/github/actions/workflow/status/chriguschneider/hass-meteoswiss-radar/ci.yml?branch=master)](https://github.com/chriguschneider/hass-meteoswiss-radar/actions)
[![Quality Gate Status](https://sonarcloud.io/api/project_badges/measure?project=chriguschneider_hass-meteoswiss-radar&metric=alert_status)](https://sonarcloud.io/summary/overall?id=chriguschneider_hass-meteoswiss-radar&branch=master)
[![hacs](https://img.shields.io/badge/HACS-Custom-41BDF5.svg)](https://hacs.xyz/)

MeteoSwiss precipitation radar for Home Assistant: a custom integration that
proxies the MeteoSwiss app API (their endpoints send no CORS headers) and
ships a Lovelace card rendering the radar on a swisstopo basemap with Leaflet.

**Status: work in progress.** The card plays the full radar animation —
~12 h of measurement into ~28 h of INCA forecast — with play/pause, a
flat scrubbing timeline in the HA accent color with hour/date labels, a
measurement/forecast label and an intensity legend overlay, centered on
your home location. The frame list refreshes itself while the
card is open, and upstream breakage degrades to a clean banner instead of a
broken card.

## Screenshot

<!--
  TODO(#18): drop a real card capture at docs/images/card.png and uncomment
  the line below. Kept as a comment so the HACS store page never renders a
  broken image. A live Home Assistant render is required, which cannot be
  produced from CI.
-->
<!-- ![MeteoSwiss Radar card](docs/images/card.png) -->

## How it works

- `custom_components/meteoswiss_radar/` registers an authenticated HTTP proxy
  (`/api/meteoswiss_radar/proxy/...`, allowlisted MeteoSwiss paths only) and
  serves the card bundle, auto-registered on every dashboard — no manual
  resource entry needed, YAML-mode dashboards included.
- The card fetches the radar frames through the proxy and decodes the
  chain-code polygon format documented in [FORMAT.md](FORMAT.md).

## Requirements

- **Home Assistant 2024.7.0 or newer.** The integration uses
  `StaticPathConfig` / `async_register_static_paths` and
  `remove_extra_js_url` (all 2024.7) plus `ConfigFlowResult` (2024.4); older
  installs fail at import with a cryptic `ImportError`.

## Install (HACS)

Not in the default HACS store yet. Add it as a custom repository using the button below, or follow the manual steps:

[![Open your Home Assistant instance and open a repository inside the Home Assistant Community Store.](https://my.home-assistant.io/badges/hacs_repository.svg)](https://my.home-assistant.io/redirect/hacs_repository/?owner=chriguschneider&repository=hass-meteoswiss-radar&category=integration)

**Manual setup:**

1. HACS → three-dot menu → **Custom repositories**.
2. Repository: `https://github.com/chriguschneider/hass-meteoswiss-radar`,
   category: **Integration**. Add.
3. Open **MeteoSwiss Radar** in HACS and **Download** it.
4. **Restart Home Assistant.**
5. Settings → Devices & Services → **Add Integration** → "MeteoSwiss Radar".
6. Add the card to a dashboard:

```yaml
type: custom:meteoswiss-radar-card
```

The card JS is **auto-injected into every dashboard for every user** — the
integration registers it as a frontend resource on setup, so there is no
manual resource entry to add (YAML-mode dashboards included). By the same
token, **uninstalling requires a Home Assistant restart** to fully unload
the integration and stop serving the card.

### Install (manual)

1. Copy `custom_components/meteoswiss_radar/` into your HA `config/custom_components/`.
2. Restart Home Assistant.
3. Settings → Devices & Services → Add Integration → "MeteoSwiss Radar".
4. Add the card as shown above.

The card has a **visual editor** (dashboard card options UI); every option
below can also be set there. The play button cycles three modes: paused ->
play the configured window (looping) -> play the full timeline.

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
| `autoplay_mode` | `off` | `off`, `window` (play the configured window on open, looping) or `full` (play the whole timeline). |
| `play_past_hours` | `1` | Play window: hours of history before now. |
| `play_forecast_hours` | `8` | Play window: hours of forecast after now. |
| `play_forecast_until` | – | Play window: clock time ("20:00") to play at least until — the longer of this and `play_forecast_hours` wins. |
| `legend` | `true` | Show the intensity legend (mm/h) overlay on the map. |
| `attribution` | `true` | Show the "Source: MeteoSwiss · © swisstopo" chip at the bottom center of the map. The swisstopo basemap license requires attribution — disable only for private use at your own discretion. |
| `time_axis` | `true` | Hour and date label rows under the timeline track. |
| `large_label` | `true` | Big date/time label on the map with a Measurement/Forecast line. |

### Overlay layers

Four optional layers can be enabled per card. An enabled layer is always shown and adds a legend swatch; layers are switched in the card configuration (UI editor chips or YAML), not on the map.

| Config key | Legend label | What it shows |
| --- | --- | --- |
| `layer_snow: true` | Snow | INCA snow-type contours |
| `layer_snowrain: true` | Sleet | INCA sleet-type contours |
| `layer_freezing_rain: true` | Freezing rain | INCA freezing-rain-type contours |
| `layer_lightning: true` | Lightning | Strike points from the MeteoSwiss lightning product |

The `layer_<x>_on` keys from v0.10.0 are obsolete and ignored (enabled now means visible).

**Snow and Sleet note:** precipitation-type predictions exist only for future (forecast) frames. The overlays are empty on all measurement frames — the map shows nothing while viewing recorded data, matching the app's own behavior.

**Lightning note:** strike data exists only for past (measurement) frames. The lightning overlay is empty on all forecast frames and shows nothing during storm-free periods — this matches the app's own behavior.

## Attribution

Radar data: [MeteoSwiss](https://www.meteoschweiz.admin.ch). Basemap:
[swisstopo](https://www.swisstopo.admin.ch). This project is not affiliated
with either. Map rendering: [Leaflet](https://leafletjs.com) (vendored).

## AI-assisted development

This project leverages AI assistants (Claude, Codex, or other models) for
development, testing, and documentation. Commits made with AI assistance carry
a `Co-Authored-By:` trailer naming the tool and model used, ensuring
transparency in the contribution history.

## License

This project is licensed under the MIT License — see the [LICENSE](LICENSE)
file for details.
