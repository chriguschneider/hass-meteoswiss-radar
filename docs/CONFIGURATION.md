# Configuration reference

Every option is optional. The card has a **visual editor** in the dashboard
card options UI, and everything here can be set there instead of in YAML.

The play button cycles three states: paused → play the configured window
(looping) → play the whole timeline.

## Map

| Option | Default | Description |
| --- | --- | --- |
| `height` | `400` | Map height in px. |
| `zoom` | `8` | Initial zoom, clamped to 6–15. Out-of-range values fall back to `8`. |
| `center` | home location | `[lat, lon]` map centre. The house marker always follows the Home Assistant home location regardless of this. |

## Timeline range

How much of the available data ends up on the timeline.

| Option | Default | Description |
| --- | --- | --- |
| `past_hours` | full range | Hours of measurement history to keep. |
| `forecast_hours` | full range | Hours of forecast to keep. `0` gives a measurement-only card. |

## Playback

| Option | Default | Description |
| --- | --- | --- |
| `frame_duration` | `300` | Milliseconds per animation frame. |
| `frame_stride` | `1` | Play every Nth frame — raise this on slow devices. |
| `autoplay_mode` | `off` | `off`, `window` (play the configured window on open, looping), or `full` (play the whole timeline). |
| `play_past_hours` | `1` | Play window: hours of history before now. |
| `play_forecast_hours` | `8` | Play window: hours of forecast after now. |
| `play_forecast_until` | – | Play window: clock time (`"20:00"`) to play at least until. The longer of this and `play_forecast_hours` wins. |

The legacy `autoplay: true` still works and maps to `autoplay_mode: full`.

## Overlays and chrome

| Option | Default | Description |
| --- | --- | --- |
| `legend` | `true` | Intensity legend (mm/h) on the map. |
| `attribution` | `true` | The "Source: MeteoSwiss · © swisstopo" chip at the bottom centre. **The swisstopo basemap licence requires attribution** — turning this off is for private use, at your own discretion. |
| `time_axis` | `true` | Hour and date label rows under the timeline track. |
| `large_label` | `true` | Big date/time label on the map with a Measurement/Forecast line. |

## Overlay layers

Enabling a layer makes it always visible and adds its own legend swatch. There
are no on-card toggle buttons — they collided with the zoom controls and lost
their state on every dashboard reload.

| Config key | Legend label | What it shows | Available on |
| --- | --- | --- | --- |
| `layer_lightning` | Lightning | Strike points from the MeteoSwiss lightning product | **Measurement frames only** |
| `layer_snow` | Snow | INCA snow-type contours | **Forecast frames only** |
| `layer_snowrain` | Sleet | INCA sleet-type contours | **Forecast frames only** |
| `layer_freezing_rain` | Freezing rain | INCA freezing-rain-type contours | **Forecast frames only** |

That asymmetry is upstream behaviour, not a bug here: MeteoSwiss predicts
precipitation *type* only for future frames, and only records lightning for the
past. Lightning is also empty during storm-free periods, which is most of the
time.

The `layer_<x>_on` keys from v0.10.0 are obsolete and silently ignored.

## Examples

A wall tablet that starts playing the next few hours on its own:

```yaml
type: custom:meteoswiss-radar-card
height: 500
autoplay_mode: window
play_past_hours: 1
play_forecast_hours: 6
large_label: true
```

A compact "what's happening right now" card, no forecast:

```yaml
type: custom:meteoswiss-radar-card
height: 300
forecast_hours: 0
past_hours: 3
legend: false
time_axis: false
```

Winter setup with the precipitation-type overlays:

```yaml
type: custom:meteoswiss-radar-card
layer_snow: true
layer_snowrain: true
layer_freezing_rain: true
```
