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
  <a href="#ai-assisted-development"><img alt="AI Assisted" src="https://img.shields.io/badge/AI-assisted-2196F3.svg" /></a>
</p>

<p align="center">
  <a href="https://my.home-assistant.io/redirect/hacs_repository/?owner=chriguschneider&repository=hass-meteoswiss-radar&category=integration"><img src="https://my.home-assistant.io/badges/hacs_repository.svg" alt="Open in HACS" /></a>
  &nbsp;·&nbsp;
  <a href="docs/CONFIGURATION.md">Configuration</a>
  &nbsp;·&nbsp;
  <a href="https://github.com/chriguschneider/hass-meteoswiss-radar/issues">Issues</a>
  &nbsp;·&nbsp;
  <a href="CHANGELOG.md">Changelog</a>
</p>

<p align="center">
  <img
    src="https://raw.githubusercontent.com/chriguschneider/hass-meteoswiss-radar/master/docs/images/card.png"
    alt="The card showing a forecast frame over western Switzerland, with the intensity legend, the overlay layers, and the scrubbing timeline"
    width="440"
  />
</p>

If you live in Switzerland, the MeteoSwiss app's radar loop is probably what you
check before hanging the laundry outside. This puts that same loop on your Home
Assistant dashboard.

- **The whole animation.** About 12 h of measured radar running straight into
  ~28 h of forecast, as one timeline. Play it, or drag to any moment.
- **Lightning, snow, sleet and freezing rain** as optional overlays, same as the
  app's own toggles.
- **Centred on your home**, with the intensity legend in mm/h.
- **No YAML needed.** There's a visual editor, and the defaults just work.
- **When MeteoSwiss changes something upstream**, you get a small banner
  instead of a broken map.

## Install

Not in the default HACS store yet, so add it as a custom repository:

[![Open your Home Assistant instance and open a repository inside the Home Assistant Community Store.](https://my.home-assistant.io/badges/hacs_repository.svg)](https://my.home-assistant.io/redirect/hacs_repository/?owner=chriguschneider&repository=hass-meteoswiss-radar&category=integration)

Or by hand: HACS → ⋮ → **Custom repositories** →
`https://github.com/chriguschneider/hass-meteoswiss-radar`, category
**Integration**. Then **Download**, restart Home Assistant, and add the
integration under Settings → Devices & Services.

Finally, drop the card on a dashboard:

```yaml
type: custom:meteoswiss-radar-card
```

That's the whole config — it finds your home location by itself. Everything else
is optional and lives in [docs/CONFIGURATION.md](docs/CONFIGURATION.md).

Needs Home Assistant **2024.7.0 or newer**. Uninstalling needs a restart,
because the integration serves the card as a frontend resource.

## Overlay layers

Four optional layers, switched on per card in the editor or in YAML:

```yaml
type: custom:meteoswiss-radar-card
layer_lightning: true
layer_snow: true
```

One thing surprises people, so it's worth saying up front: **lightning only
exists on past frames, and snow, sleet and freezing rain only on forecast
frames.** That's how MeteoSwiss publishes it — they don't predict lightning, and
they don't record precipitation type. So a snow overlay shows nothing while you
scrub through recorded radar, and lightning vanishes the moment you cross into
the forecast. The app behaves the same way.

## How it works

The integration proxies the MeteoSwiss app API, because those endpoints send no
CORS headers and a browser simply can't call them. The proxy sits behind Home
Assistant's auth and only reaches an allowlist of MeteoSwiss paths, so it can't
be turned into an open relay.

The card then draws the radar contours onto a swisstopo basemap with Leaflet. If
you want the details — the reverse-engineered wire format, the architecture
decisions — see [FORMAT.md](FORMAT.md) and [docs/adr/](docs/adr/).

## Contributing

Issues and PRs welcome. [AGENTS.md](AGENTS.md) has the working agreement, and
`npm test` / `python -m pytest -q` run the two suites.

Corrections to [FORMAT.md](FORMAT.md) are especially welcome — the format is
reverse-engineered, so if something looks wrong there, it probably is.

## AI-assisted development

Built by Chrigu & Claude — a human and an LLM working together. The architecture
calls, the trade-offs and the reverse-engineering are mine; a good share of the
typing, refactors and test scaffolding was
[Claude Code](https://claude.com/claude-code).

AI-assisted commits carry a `Co-Authored-By:` trailer, so the history stays
honest. The badge is there because being upfront about how software gets made
beats pretending otherwise.

## Attribution & licence

Radar data from [MeteoSwiss](https://www.meteoschweiz.admin.ch), basemap from
[swisstopo](https://www.swisstopo.admin.ch), rendering by
[Leaflet](https://leafletjs.com). An independent community project — not
affiliated with or endorsed by either agency.

The swisstopo licence requires the attribution chip on the map. There's an
option to hide it, but think twice before doing that publicly.

MIT — see [LICENSE](LICENSE).
