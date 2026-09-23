# Local rain nowcast

MeteoSwiss Radar exposes local rain-nowcast entities derived from the same
MeteoSwiss RZC / INCA animation data that powers the Lovelace card.

The integration evaluates radar contours at the Home Assistant home location
and reuses the existing authenticated, allowlisted, cache-aware proxy. It does
not add a second upstream API path.

## Entities

- `sensor.meteoswiss_radar_regen_nowcast_status` reports `dry`,
  `approaching`, `active`, or `unknown`.
- `sensor.meteoswiss_radar_regen_in` reports the approximate lead time in
  minutes while rain is approaching.
- `sensor.meteoswiss_radar_regenbeginn` reports the predicted event start.
- `sensor.meteoswiss_radar_regenende` reports the predicted event end when a
  sufficiently long dry window is visible in the forecast.
- `binary_sensor.meteoswiss_radar_regenschutz` is intended for automations that
  need a conservative rain-protection signal.

Entity names are translated by Home Assistant; exact entity IDs can therefore
depend on the selected language and existing entity registry entries.

## Event behaviour

Rain protection starts when precipitation is measured at the Home Assistant
location or forecast within 30 minutes.

Once an event has started, short dry gaps remain part of the same event. The
event is only cleared when the current measurement is dry and the forecast
confirms a continuous 30-minute dry window from the current time.

On a dry day the coordinator only fetches the short lead window. When rain is
approaching or active, it extends the forecast fetch adaptively to six hours
plus the dry-window padding so it can estimate an event end.

Predicted event ends that move later are accepted immediately. An earlier
predicted end must be observed on two consecutive coordinator updates before
the displayed end moves earlier.

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
