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
compiled patterns in `_ALLOWED_PATHS` (`__init__.py`): versions.json, the
animation manifest, rzc measurement frames, and INCA rate frames. Any
other tail returns 404. The upstream base is the fixed `UPSTREAM_BASE`
constant; the tail is never used to construct a different host. Responses
that are not `Content-Type: json` are rejected with 502 (a site relaunch
serving HTML must not reach the card as valid data).

## Consequences

- New upstream endpoints (e.g. INCA snow/type variants) require adding an
  explicit pattern here, deliberately.
- `fullmatch` (not `search`) is load-bearing; a change to `search` or a
  loosened pattern widens the boundary and needs its own ADR.
- Hardening of the upstream read path (redirect handling, body-size cap,
  status mapping) builds on this boundary and is tracked separately.
