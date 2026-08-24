# ADR-0001: Proxy path allowlist as the security boundary

- **Status:** Accepted
- **Date:** 2026-08-22

## Context

The MeteoSwiss app API sends no CORS headers, so the browser card cannot
fetch it directly. The integration therefore runs an authenticated
server-side proxy (`MeteoSwissRadarProxyView`). An unrestricted proxy
would turn Home Assistant into an open forward proxy for any upstream
path, an SSRF and abuse vector.

## Decision

The proxy serves **only** paths whose tail fully matches one of the
compiled patterns in `_ALLOWED_PATHS` (`__init__.py`):

1. `product/output/versions.json`
2. `product/output/precipitation/animation/version__YYYYMMDD_HHMM/[a-z]{2}/animation.json`
3. `product/output/radar/rzc/radar_rzc.YYYYMMDD_HHMM.json`
4. `product/output/inca/precipitation/rate/version__YYYYMMDD_HHMM/rate_YYYYMMDD_HHMM.json`
5. `product/output/inca/precipitation/type/snow/version__YYYYMMDD_HHMM/snow_YYYYMMDD_HHMM.json`
6. `product/output/inca/precipitation/type/snowrain/version__YYYYMMDD_HHMM/snowrain_YYYYMMDD_HHMM.json`
7. `product/output/inca/precipitation/type/freezing-rain/version__YYYYMMDD_HHMM/freezingrain_YYYYMMDD_HHMM.json`
8. `product/output/lightning/version__YYYYMMDD_HHMM/lightning.json`

Patterns 5–8 are the INCA precipitation-type overlay variants and the
lightning product added in issue #92. Patterns 5–7 use three separate
patterns rather than an alternation so the directory name and filename
stay coupled: the upstream inconsistency (`freezing-rain` in the dir,
`freezingrain` in the filename) makes an alternation ambiguous.

Any other tail returns 404. The upstream base is the fixed `UPSTREAM_BASE`
constant; the tail is never used to construct a different host. Responses
that are not `Content-Type: json` are rejected with 502 (a site relaunch
serving HTML must not reach the card as valid data).

## Consequences

- Further new upstream endpoints require adding an explicit pattern here,
  deliberately.
- `fullmatch` (not `search`) is load-bearing; a change to `search` or a
  loosened pattern widens the boundary and needs its own ADR.
- Hardening of the upstream read path (redirect handling, body-size cap,
  status mapping) builds on this boundary and is tracked separately.
