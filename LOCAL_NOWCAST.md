# Local rain-nowcast test branch

Base: chriguschneider/hass-meteoswiss-radar @ 3efc5513ce95db00b6cf7b68078958457a31d1b1

Adds Home Assistant entities derived from the same MeteoSwiss RZC / INCA
animation data and the same authenticated/cache-aware proxy used by the card.

Behaviour:
- protection starts when rain is forecast within 30 minutes;
- a started event remains active through dry gaps shorter than 30 minutes;
- an event ends only when an explicit 30-minute dry forecast window starts;
- dry state fetches only the 30-minute lead window; active/approaching rain
  extends adaptively to 6 hours (+30 min padding) to estimate the event end;
- predicted event ends that move earlier need two consecutive refreshes;
  extensions are accepted immediately;
- missing/stale nowcast data does not declare a false all-clear.

This is a local test branch. Do not update MeteoSwiss Radar through HACS while
this patched copy is being evaluated, because HACS would replace the files.
