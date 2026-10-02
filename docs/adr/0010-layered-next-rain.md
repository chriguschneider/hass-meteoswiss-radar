# ADR-0010: "Next rain" is layered, and reads the weather entity through HA

- **Status:** Accepted
- **Date:** 2026-10-02

## Context

The nowcast answers "is it raining here, and will it in the next 30 minutes".
That is radar's genuine edge: the frames are 1 km cells at 5-minute cadence, and
they are evaluated at the Home Assistant location rather than at a forecast
point.

It is also its whole range. A sensor named "Rain start" could therefore only ever
be empty on a quiet day, which is how it read on a live instance: three
timestamp and duration sensors showing `unknown` with no explanation. On one
measured afternoon the radar reported `dry` with a 30-minute horizon while the
hourly model forecast already carried 0.3 mm at 59 % four hours out — the
information existed, just not in this integration.

**Scanning further ahead was considered and rejected.** The manifest offers
~28 h of INCA frames, and a full sweep was measured at **~6 MB gzipped** against
the 20 MB LRU the card shares, re-fetched every 5 minutes. A coarse stride with
early termination would cost less but miss short showers. Both are also the wrong
tool: INCA is advection-based and blends into a numerical model past roughly two
hours, so a far-horizon frame scan pays megabytes to re-derive, at hour-scale
quality, what a model already states as a number.

The sibling `hass-meteoswiss-weather` integration already fetches exactly that
number — `rre150h0` hourly precipitation and `rp0003i0` probability — and its
ADR-0003 anticipated this coupling in writing: *"a forecast strip on the radar
card reads a `weather` entity from this integration through the normal HA state
machine, never through a private API between the two."*

## Decision

The `rain_start` sensor becomes **`next_rain`**, answering the same question from
whichever source can reach that far:

- **inside the radar horizon** — `ACTIVE` reports now, `APPROACHING` reports the
  event start. Radar always wins where it can answer: kilometre resolution at the
  actual location beats an hourly value at a forecast point.
- **beyond it** — the first hour of a configured weather entity's hourly forecast
  that meets **both** thresholds: ≥ 0.1 mm **and** ≥ 50 % probability.

A `source` attribute records which answered, so "today 17:00" is never mistaken
for a radar observation.

Both thresholds are required on purpose. Millimetres without confidence is a
possibility rather than an announcement; confidence without millimetres is cloud
the model is sure about. Hours already under way are skipped rather than clipped
to now — naming 14:00 at 14:30 reads worse than naming the next hour.

The forecast is read with a `weather.get_forecasts` service call through the
state machine. No import of the sibling integration, no shared module, no
`after_dependencies`: the two remain separate installs with separate upstreams
(ADR-0003, and ADR-0001 over there).

The weather entity is an **option, empty by default**. Empty means radar only,
and `next_rain` is then simply empty beyond the horizon rather than implying "no
rain for days". A failing or missing entity is logged at debug and leaves the
radar answer untouched — a weather integration that is slow to start must not
fail a radar update.

**The rain-protection binary sensor is not layered and must not become so.** It
drives an actuator, and hour-resolution model data would make that decision worse,
not better. The layering is for the display value only.

## Consequences

- The radar integration now reads another integration's entity. That is a new
  boundary for this repo, allowed by the sibling's ADR-0003 and deliberately
  limited to one service call with a documented failure mode.
- `next_rain` can be useful on a day the radar has nothing to say, which is most
  days — the gap that made the device page read as three empty fields.
- Thresholds are constants, not options. If they prove wrong in practice, change
  them here with the evidence rather than pushing the judgement onto users.
- Anyone running the radar integration alone keeps exactly the previous
  behaviour.
- `rain_start` is gone as an entity key. The feature has not shipped in a
  release, so no published install is affected; a dev install picks up a new
  entity and keeps the old one as an orphan until removed.
- Changes to the thresholds, to the layering order, or to how the forecast is
  obtained should update this ADR.
