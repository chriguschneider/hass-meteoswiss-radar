<h1 align="center">MeteoSwiss Radar</h1>

<p align="center"><em>The app's radar, on your dashboard.</em></p>

<p align="center">
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/License-MIT-yellow.svg" /></a>
  <a href="https://hacs.xyz/"><img alt="HACS Custom" src="https://img.shields.io/badge/HACS-Custom-41BDF5.svg" /></a>
  <a href="https://github.com/chriguschneider/hass-meteoswiss-radar/releases/latest"><img alt="Latest release" src="https://img.shields.io/github/v/release/chriguschneider/hass-meteoswiss-radar" /></a>
  <a href="https://github.com/chriguschneider/hass-meteoswiss-radar/actions/workflows/ci.yml"><img alt="CI status" src="https://img.shields.io/github/actions/workflow/status/chriguschneider/hass-meteoswiss-radar/ci.yml?branch=master&label=CI" /></a>
  <a href="https://sonarcloud.io/summary/overall?id=chriguschneider_hass-meteoswiss-radar&branch=master"><img alt="Quality Gate Status" src="https://sonarcloud.io/api/project_badges/measure?project=chriguschneider_hass-meteoswiss-radar&metric=alert_status" /></a>
  <a href="https://github.com/chriguschneider/hass-meteoswiss-radar/releases"><img alt="Downloads" src="https://img.shields.io/github/downloads/chriguschneider/hass-meteoswiss-radar/total" /></a>
  <a href="https://github.com/chriguschneider/hass-meteoswiss-radar/stargazers"><img alt="Stars" src="https://img.shields.io/github/stars/chriguschneider/hass-meteoswiss-radar" /></a>
  <a href="https://github.com/chriguschneider/hass-meteoswiss-radar/commits/master"><img alt="Last commit" src="https://img.shields.io/github/last-commit/chriguschneider/hass-meteoswiss-radar" /></a>
  <a href="#ai-assisted-development"><img alt="AI Assisted" src="https://img.shields.io/badge/AI-assisted-2196F3.svg" /></a>
</p>

<p align="center">
  <a href="https://my.home-assistant.io/redirect/hacs_repository/?owner=chriguschneider&repository=hass-meteoswiss-radar&category=integration"><img src="https://my.home-assistant.io/badges/hacs_repository.svg" alt="Open in HACS" /></a>
  &nbsp;·&nbsp;
  <a href="https://github.com/chriguschneider/hass-meteoswiss-radar/issues">Issues</a>
  &nbsp;·&nbsp;
  <a href="docs/adr/">Architecture</a>
  &nbsp;·&nbsp;
  <a href="FORMAT.md">Wire format</a>
  &nbsp;·&nbsp;
  <a href="AGENTS.md">Contributing</a>
  &nbsp;·&nbsp;
  <a href="CHANGELOG.md">Changelog</a>
</p>

Swiss precipitation radar for Home Assistant — an animated Lovelace card on a
swisstopo basemap, fed by an authenticated proxy integration that speaks to
the MeteoSwiss app API.

<details>
<summary><b>Table of contents</b></summary>

- [What this does](#what-this-does)
- [How it works](#how-it-works)
- [Requirements](#requirements)
- [Installation](#installation)
- [Configuration](#configuration)
- [Overlay layers](#overlay-layers)
- [Contributing & architecture](#contributing--architecture)
- [AI-assisted development](#ai-assisted-development)
- [Community](#community)
- [Attribution & licence](#attribution--licence)

</details>

<!--
  TODO(#18): drop a real card capture at docs/images/card.png and uncomment
  the line below. Kept as a comment so the HACS store page never renders a
  broken image. A live Home Assistant render is required, which cannot be
  produced from CI. Tracked for the forum/HACS push in #160.
-->
<!-- ![MeteoSwiss Radar card](docs/images/card.png) -->

## What this does

If you live in Switzerland, the MeteoSwiss app's radar loop is probably what
you check before hanging the laundry outside. This project puts that same loop
on your Home Assistant dashboard.

- **The full animation.** Roughly 12 h of measured radar flowing straight into
  ~28 h of [INCA](https://www.meteoswiss.admin.ch/weather/warning-and-forecasting-systems/inca.html)
  forecast, as one continuous timeline — play, pause, or scrub to any frame.
- **A timeline you can actually read.** A flat track in your theme's accent
  colour, with hour and date rows, a measurement/forecast marker, and a
  prominent "now" indicator at the boundary between the two.
- **Four optional overlay layers**, matching the app's own toggles: lightning
  strikes, snow, sleet, and freezing rain. See
  [Overlay layers](#overlay-layers) — the forecast/measurement asymmetry there
  is worth reading before you enable them.
- **Centred on your home**, with a house marker and an intensity legend in
  mm/h.
- **A visual editor.** Every option below is configurable from the dashboard
  UI; the YAML is there if you prefer it.
- **Graceful degradation.** When MeteoSwiss changes something upstream, the
  card shows a clean banner rather than a broken map, and keeps retrying with
  backoff.

The card refreshes its own frame list while open, so a dashboard left running
on a wall tablet stays current without a reload.

## How it works

Two pieces ship together, and both are needed:

**The integration** (`custom_components/meteoswiss_radar/`) registers an
authenticated HTTP proxy at `/api/meteoswiss_radar/proxy/...` and serves the
card bundle. It auto-registers the card as a frontend resource on every
dashboard — including YAML-mode ones — so there is no manual resource entry to
add.

**The card** fetches radar frames through that proxy and decodes the
chain-code polygon format documented in [FORMAT.md](FORMAT.md), rendering the
contours onto a [Leaflet](https://leafletjs.com) map (vendored, no CDN).

### Why a proxy is necessary

The MeteoSwiss app endpoints send no CORS headers, so a browser cannot call
them directly. The proxy is not an optimisation — it is the only way this
works from a dashboard at all.

That makes the proxy the security boundary of this project, and it is built
accordingly:

- **Authenticated.** It sits behind Home Assistant's own auth; there is no
  unauthenticated surface.
- **Strictly allowlisted.** Only known MeteoSwiss upstream paths are
  reachable, so the proxy can never be used as an open relay
  ([ADR-0001](docs/adr/0001-proxy-path-allowlist.md)).
- **Redirect-refusing, timeout-bounded**, with a byte-bounded LRU cache and
  request coalescing so a wall of dashboards produces one upstream fetch.

Design decisions are recorded as ADRs in [docs/adr/](docs/adr/) — including
[why there is no build step](docs/adr/0002-no-build-step-raw-card.md) and
[how vendor assets survive an upgrade](docs/adr/0003-version-agnostic-vendor-serving.md).

## Requirements

**Home Assistant 2024.7.0 or newer.** The integration uses `StaticPathConfig` /
`async_register_static_paths` and `remove_extra_js_url` (all 2024.7) plus
`ConfigFlowResult` (2024.4). Older installs fail at import with a cryptic
`ImportError` rather than a friendly message.

No other dependencies — no API key, no account, no `requirements` to install.

## Installation

### HACS

Not in the default HACS store yet ([#85](https://github.com/chriguschneider/hass-meteoswiss-radar/issues/85)),
so it needs to be added as a custom repository.

**One-click:** [![Open your Home Assistant instance and open a repository inside the Home Assistant Community Store.](https://my.home-assistant.io/badges/hacs_repository.svg)](https://my.home-assistant.io/redirect/hacs_repository/?owner=chriguschneider&repository=hass-meteoswiss-radar&category=integration)

Or manually:

1. HACS → three-dot menu → **Custom repositories**.
2. Repository `https://github.com/chriguschneider/hass-meteoswiss-radar`,
   category **Integration**. Add.
3. Open **MeteoSwiss Radar** in HACS and **Download**.
4. **Restart Home Assistant.**
5. Settings → Devices & Services → **Add Integration** → "MeteoSwiss Radar".
6. Add the card to a dashboard:

```yaml
type: custom:meteoswiss-radar-card
```

That is genuinely the whole configuration — the card picks up your home
location on its own.

> **Uninstalling requires a restart.** Because the integration injects the card
> as a frontend resource, removing it only fully unloads after a Home Assistant
> restart.

### Manual

1. Copy `custom_components/meteoswiss_radar/` into your HA
   `config/custom_components/`.
2. Restart Home Assistant.
3. Settings → Devices & Services → **Add Integration** → "MeteoSwiss Radar".
4. Add the card as shown above.

## Configuration

Everything is optional. The card has a **visual editor** in the dashboard card
options UI, and every key below can be set there.

The play button cycles three states: paused → play the configured window
(looping) → play the full timeline.

### Map

| Option | Default | Description |
| --- | --- | --- |
| `height` | `400` | Map height in px. |
| `zoom` | `8` | Initial zoom, clamped to 6–15; out-of-range values fall back to `8`. |
| `center` | home location | `[lat, lon]` map centre. The house marker always follows the HA home location regardless of this. |

### Timeline range

| Option | Default | Description |
| --- | --- | --- |
| `past_hours` | full range | Hours of measurement history to keep on the timeline. |
| `forecast_hours` | full range | Hours of forecast to keep. `0` gives a measurement-only card. |

### Playback

| Option | Default | Description |
| --- | --- | --- |
| `frame_duration` | `300` | Milliseconds per animation frame. |
| `frame_stride` | `1` | Play every Nth frame — raise this on slow devices. |
| `autoplay_mode` | `off` | `off`, `window` (play the configured window on open, looping), or `full` (play the whole timeline). |
| `play_past_hours` | `1` | Play window: hours of history before now. |
| `play_forecast_hours` | `8` | Play window: hours of forecast after now. |
| `play_forecast_until` | – | Play window: clock time (`"20:00"`) to play at least until. The longer of this and `play_forecast_hours` wins. |

### Overlays and chrome

| Option | Default | Description |
| --- | --- | --- |
| `legend` | `true` | Intensity legend (mm/h) on the map. |
| `attribution` | `true` | "Source: MeteoSwiss · © swisstopo" chip at the bottom centre. **The swisstopo basemap licence requires attribution** — disable only for private use, at your own discretion. |
| `time_axis` | `true` | Hour and date label rows under the timeline track. |
| `large_label` | `true` | Big date/time label on the map with a Measurement/Forecast line. |

## Overlay layers

Four optional layers mirror the toggles in the MeteoSwiss app. Enable them per
card, in the editor's Layers section or in YAML. **An enabled layer is always
visible** — there are no on-card toggle buttons, and each active layer adds its
own legend swatch.

| Config key | Legend label | What it shows | Available on |
| --- | --- | --- | --- |
| `layer_lightning: true` | Lightning | Strike points from the MeteoSwiss lightning product | **Measurement frames only** |
| `layer_snow: true` | Snow | INCA snow-type contours | **Forecast frames only** |
| `layer_snowrain: true` | Sleet | INCA sleet-type contours | **Forecast frames only** |
| `layer_freezing_rain: true` | Freezing rain | INCA freezing-rain-type contours | **Forecast frames only** |

That asymmetry is upstream behaviour, not a bug in this card: MeteoSwiss
predicts precipitation *type* only for future frames, and only records
lightning for the past. So a snow overlay shows nothing while you scrub through
recorded data, and lightning disappears the moment you cross into forecast —
exactly as the app behaves.

Lightning is also empty during storm-free periods, which is most of the time.

> The `layer_<x>_on` keys from v0.10.0 are obsolete and silently ignored.
> Enabled now means visible.

## Contributing & architecture

Issues and PRs are welcome. [AGENTS.md](AGENTS.md) is the working agreement for
this repo — repo structure, commit attribution, comment discipline, testing,
and how the automation pipeline picks up labelled issues.

Architectural decisions live as ADRs in [docs/adr/](docs/adr/); read those
before proposing a change to the proxy allowlist, the no-build-step stance, or
the release gate. The upstream wire format is reverse-engineered and documented
in [FORMAT.md](FORMAT.md) — corrections there are especially valuable.

```sh
npm ci && npm test          # card tests (vitest)
python -m pytest -q         # integration + proxy tests, no HA install needed
python -m ruff check custom_components tests
```

## AI-assisted development

This project is built by Chrigu & Claude — a human and an LLM working together.
The architecture calls, the trade-offs, the reverse-engineering of the MeteoSwiss
wire format, and every "what should this actually do?" decision are mine. A large
share of the typing, the refactors, the test scaffolding, and the tedious
contour-decoding plumbing was done by [Claude Code](https://claude.com/claude-code).

Commits made with AI assistance carry a `Co-Authored-By:` trailer naming the
tool and model, so the contribution history stays honest. Everything is
reviewed, tested, and shipped consciously — the badge is there because being
straightforward about how software gets made beats pretending otherwise.

## Community

- 🐛 **Found a bug or want a feature?** [Open an issue](https://github.com/chriguschneider/hass-meteoswiss-radar/issues/new).
- 🇨🇭 **Radar looks wrong?** Include the frame timestamp and your zoom level —
  upstream data changes are the most common cause and the easiest to confirm.
- 🔧 **Want to contribute?** Start with [AGENTS.md](AGENTS.md). Corrections to
  [FORMAT.md](FORMAT.md) and additional decoder fixtures are well-bounded first
  contributions.

## Attribution & licence

Radar data: [MeteoSwiss](https://www.meteoschweiz.admin.ch). Basemap:
[swisstopo](https://www.swisstopo.admin.ch). Map rendering:
[Leaflet](https://leafletjs.com), vendored into the integration.

This is an independent community project and is **not affiliated with, endorsed
by, or supported by** MeteoSwiss or swisstopo. The swisstopo basemap licence
requires attribution — see the `attribution` option before turning that chip
off.

Released under the MIT licence — see [LICENSE](LICENSE).
