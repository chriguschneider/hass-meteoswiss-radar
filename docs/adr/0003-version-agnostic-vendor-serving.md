# ADR-0003: Vendor assets served version-agnostically by an allowlist view

- **Status:** Accepted
- **Date:** 2026-08-24

## Context

The card loads Leaflet from
`/meteoswiss_radar/frontend/vendor/<CARD_VERSION>/leaflet.js` (and the CSS
and marker images). The version segment exists only to bust the browser
cache on upgrade; the vendored files live flat on disk under
`frontend/vendor/`.

They were served by two `StaticPathConfig` mounts: one at the current
Python `VERSION`, plus an unversioned fallback. Both resolve the URL's
version segment against the filesystem, so any tag other than the running
`VERSION` maps to a non-existent on-disk directory and 404s. Two real
cases hit that (issue #70):

- A card left open across an upgrade (0.8.0 → 0.9.0) still requests
  `/vendor/0.8.0/leaflet.js`; the mount is now `/vendor/0.9.0` and the
  fallback maps to the nonexistent `vendor/0.8.0/leaflet.js` — 404, card
  shows "Leaflet failed to load" until a manual reload.
- After HACS swaps files on disk, a browser reload runs the *new* card,
  which requests `/vendor/<newversion>/...` while the running process
  still has the old mount — the same 404. The version-keyed mount is
  exactly what forces a Home Assistant restart for JS-only updates
  (issue #91).

## Decision

Serve vendored assets from a `MeteoSwissRadarVendorView`
(`HomeAssistantView`) whose URL captures
`/vendor/{tag}/{filename:.+}`. The `{tag}` segment is an **opaque
cache-buster and is never used for filesystem resolution**. `{filename}`
must be one of the entries in the `_VENDOR_FILES` allowlist (which also
fixes the `Content-Type`); the resolved path is additionally checked for
containment within `frontend/vendor/` as defence in depth against
traversal. The view reads `frontend/vendor/<filename>` from disk at
request time and returns
`Cache-Control: private, max-age=86400, immutable` (private because,
though this asset is unauthenticated, we align with the proxy's
shared-cache policy and the tag already guarantees uniqueness).

The `StaticPathConfig` vendor mounts and their `VERSION` coupling are
removed. This mirrors the proxy's model (ADR-0001): an explicit allowlist,
not the disk layout, is the security boundary.

## Consequences

- Any tag — an old card after an upgrade, a new card on a not-yet-restarted
  process — resolves the same on-disk file, so vendor assets no longer 404
  across releases. This unblocks restart-free JS-only updates (issue #91):
  a JS-only release becomes "HACS update + browser reload".
- A new vendored file must be added to `_VENDOR_FILES` deliberately, the
  same way a new upstream endpoint is added to the proxy allowlist.
- Cross-version contract skew stays a release-notes concern: a release
  whose card needs a **new proxy allowlist entry** is not JS-only and still
  requires a restart. Adopt a frontend-only vs requires-restart convention
  in release notes.
- This does not touch ADR-0002 (the card still ships as raw JS, no build
  step); it only changes how the sibling vendored assets are served.
