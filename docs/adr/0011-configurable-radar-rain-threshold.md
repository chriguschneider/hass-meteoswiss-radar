# ADR-0011: Configurable radar rain threshold

- **Status:** Accepted
- **Date:** 2026-10-22
- **Updated:** 2026-10-26, following review on #244

## Context

ADR-0009 uses a fixed 1 mm/h threshold to exclude unreliable weak echoes.
Sensitive awnings may need the lowest precipitation band too. Issue #195
explicitly left a public option for later. The pure classifier already
accepts a threshold, but the coordinator always uses its default.

## Decision

Add the flat config-entry option `rain_threshold_mm_h`, shown in a dedicated
*Radar rain detection* section. Default to 1.0 on new and existing entries.
Offer a fixed choice of 1 mm/h (standard) or 0 mm/h (include the weakest
band), with translated selector labels. Keep the stored option numeric:
convert the selector's string to a float when flattening the form. Accept
only numeric 0 or 1 when reading it, excluding booleans; every other value
falls back to 1.0. Existing numeric 0 and 1 values need no migration.

Pass the resolved value into every `frame_is_wet_at_grid_point` call through
the coordinator's existing executor path. Compare the band's lower bound
against it; 0 includes the weakest recognised precipitation band. Keep the
positional legend mapping, colour validation and unknown-data behaviour.

The option tunes all radar-derived samples. Weather-entity forecasts retain
their separate thresholds (ADR-0010), and never feed the protection signal.
Reuse the existing options-update reload; expose the effective value in
diagnostics. No new upstream request or dependency is introduced.

## Consequences

An installation can opt into weak echoes without a locally patched constant.
This increases false alarms from virga and clutter, so the UI and guide say
so. Sub-band precision is unavailable, and higher thresholds could silently
exclude meaningful rain from protection; neither is offered. Saving reloads
the entry and applies the choice without restarting Home Assistant. Entity
identities stay unchanged.
