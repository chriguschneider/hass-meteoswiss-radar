# ADR-0006: Scheduled live smoke test against MeteoSwiss API

- **Status:** Accepted
- **Date:** 2026-08-24

## Context

The frame format in FORMAT.md is entirely reverse-engineered from the MeteoSwiss
app API. If MeteoSwiss changes the API response structure or format, the decoder
silently breaks and users discover the regression only when their card stops
rendering data. This creates a poor user experience and makes debugging difficult.

A scheduled (not per-PR) live smoke test running the reference decoder against
current frames from the real API would catch upstream drift early, when it can
be investigated and fixed before users encounter it.

## Decision

Add a weekly GitHub Actions cron job (`smoke-test.yml`) that:

1. Fetches `versions.json`, the animation manifest, one measurement frame
   (latest radar rzc), and one forecast frame (latest INCA rate) from the
   unauthenticated MeteoSwiss API (~4 requests per run, no secrets needed).
2. Runs `tests/tools/smoke_test.py` which:
   - Decodes both frames using the reference decoder from `reference_decode.py`.
   - Validates plausible geometry: non-empty areas, coordinate bounds within
     the LV03 grid (x ∈ [255.5, 964.5] km, y ∈ [-159.5, 479.5] km).
3. On failure, **opens or updates a GitHub issue** (not fail PRs). Upstream
   drift is not a repo regression; it is an external contract change that
   deserves its own tracking.

The cron job runs weekly (suggested: Monday 02:00 UTC) to detect drift early
without excessive API load.

## Consequences

- The repo now has a CI job that depends on external network (the MeteoSwiss
  API). The job is isolated to a scheduled workflow, not part of PR checks, so
  upstream outages or format changes do not block development.
- The reference decoder is now trusted by the smoke test. Any future changes
  to it (including format corrections) need careful review to ensure the decoder
  still reflects the current upstream API.
- Failures in this job should open an issue like "Upstream API format drift
  detected; frame decoding failed on [date]". The issue becomes the tracking
  item for investigation and fixes.

