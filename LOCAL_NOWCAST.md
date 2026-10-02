# Local rain nowcast

MeteoSwiss Radar can expose local rain-nowcast entities derived from the same
MeteoSwiss RZC / INCA animation data that powers the Lovelace card.

The integration evaluates radar contours at the Home Assistant home location
and reuses the existing authenticated, allowlisted, cache-aware proxy. It does
not add a second upstream API path.

## Enabling it

The entities are **off by default** — installing the integration for the card
alone should not add entities or a polling coordinator. Turn them on under
**Settings → Devices & services → MeteoSwiss Radar → Configure**, with
*Local rain-nowcast entities*.

Flipping the toggle reloads the config entry, so the entities appear or
disappear without restarting Home Assistant. While enabled the integration polls
MeteoSwiss every 5 minutes.

If you already had these entities before the toggle existed, they stay enabled
on upgrade — an existing rain-protection automation keeps working.

## Entities

- `sensor.meteoswiss_radar_rain_nowcast_status` reports `dry`,
  `approaching`, `active`, or `unknown`.
- `sensor.meteoswiss_radar_rain_in` reports the approximate lead time in
  minutes while rain is approaching.
- `sensor.meteoswiss_radar_rain_start` reports the predicted event start.
- `sensor.meteoswiss_radar_expected_dry_from` (displayed as "Expected dry again
  from" / "Voraussichtlich trocken ab" / "Sec à nouveau prévu à partir de" /
  "Di nuovo asciutto previsto da") estimates when conditions are expected to be
  dry again. It reports the start of the first 30-minute dry window found in the
  forecast. Because INCA advection-based nowcasting is only reliable within
  roughly 2 hours, the sensor is suppressed beyond that horizon: once no dry
  window is confirmed within 2 hours the sensor becomes `unknown` and
  `event_end_open` remains `True`. This is a display estimate, not the basis for
  the rain-protection automation signal.
- `binary_sensor.meteoswiss_radar_rain_protection` is intended for automations that
  need a conservative rain-protection signal.

The IDs above are the English defaults. Entity names are translated by Home
Assistant, so the actual IDs depend on the language active when the entities
were first created and on what the entity registry already held.

## A one-line summary on the dashboard

The entities deliberately hold data, not sentences: `Rain in` is a duration and
`Rain start` a timestamp, so neither can say "no rain" — Home Assistant has only
`unknown` for an empty value there. The status sensor is the one that carries the
meaning, and it is translated.

For a single readable line, a markdown card assembles one from the attributes
that are already there:

```yaml
type: markdown
content: >-
  {% set st = states('sensor.meteoswiss_radar_rain_nowcast_status') %}
  {% set mins = state_attr('binary_sensor.meteoswiss_radar_rain_protection',
                           'rain_in_minutes') %}
  {% set until = state_attr('sensor.meteoswiss_radar_rain_nowcast_status',
                            'event_end') %}
  {% if st == 'active' %}
    It is raining{% if until %} until about {{ until | as_timestamp
      | timestamp_custom('%H:%M') }}{% endif %}.
  {% elif st == 'approaching' %}
    Rain in about {{ mins }} minutes.
  {% elif st == 'dry' %}
    No rain in the next 30 minutes.
  {% else %}
    No radar data at the moment.
  {% endif %}
```

Adjust the entity IDs to yours — they follow the language that was active when
the entities were first created.

## Event behaviour

Rain protection starts when precipitation is measured at the Home Assistant
location or forecast within 30 minutes.

Once an event has started, short dry gaps remain part of the same event. The
event is only cleared when the current measurement is dry and the forecast
confirms a continuous 30-minute dry window from the current time.

On a dry day the coordinator only fetches the short lead window (~3 frames).
When rain is approaching or active, it extends the forecast fetch adaptively to
two hours plus the dry-window padding so it can estimate when conditions are
expected to be dry again.

## Minimum hold on the protection signal

Rain protection stays on for at least **30 minutes** once it switches on, even if
the radar clears earlier. Adjustable under *Configure*; 0 disables it.

This exists because a shower that clips the location otherwise cycles the signal
within minutes. From a live instance:

```
00:43  on
00:48  off      ← 5 minutes
00:53  on
01:18  off
```

Whatever the binary sensor drives — usually an awning motor — would have run four
times in 35 minutes. The hold only affects the protection signal: the status
sensor keeps reporting what the radar actually sees, so a held signal shows up as
`dry` with protection still on, and the `protection_hold_until` attribute says
until when.

## Missing data

Missing or stale current radar data never produces a false all-clear. If the
current state or the short forecast window cannot be established reliably, the
nowcast becomes `unknown`; an already active event remains protected until a
valid dry window is confirmed.

## Architecture

The pure geometry decoder and event state machine live in
`custom_components/meteoswiss_radar/nowcast_core.py` and have no Home Assistant
dependency. `nowcast.py` owns Home Assistant coordination and upstream frame
fetching. `sensor.py` and `binary_sensor.py` expose the coordinator state.

The architectural decision is recorded in
[`docs/adr/0009-local-rain-nowcast-entities.md`](docs/adr/0009-local-rain-nowcast-entities.md).
