# The integration brand icon

Home Assistant shows the default puzzle-piece icon for an integration
until brand images exist for its domain. This integration ships its own,
so no action is needed for them to appear (tracking: issue #84).

**Since HA 2026.3 a custom integration can carry its brand images
itself.** The brands proxy API serves a `brand/` folder from inside the
integration and prefers it over the
[`home-assistant/brands`](https://github.com/home-assistant/brands) CDN —
see the [Brands Proxy API announcement](https://developers.home-assistant.io/blog/2026/02/24/brands-proxy-api).
The `custom_integrations/` folder in the brands repository is explicitly
labelled a legacy path in that repo's own README, so **we do not submit a
PR there.**

No `manifest.json` change is involved. The files are the whole mechanism:

```
custom_components/meteoswiss_radar/brand/
├── icon.png      # 256×256
└── icon@2x.png   # 512×512
```

## Decision

Use the **official MeteoSwiss logo / app icon** (maintainer decision,
2026-08-24, reaffirmed 2026-08-25), not a neutral radar-motif substitute.

The icon contains the Swiss cross, protected under the Coat of Arms
Protection Act (SR 232.21). The maintainer has weighed this for a
non-commercial community integration and decided to ship it. There is
precedent for national weather services in Home Assistant's own brand
set — `meteo_france` (Météo-France) is a core integration.

Because the images now live in this repository rather than in a PR
against a foreign one, that judgement is ours alone; there is no external
reviewer who will independently raise it.

## Source

The App Store artwork for the official MeteoSwiss app:

- Bundle id: `ch.admin.meteoswiss`
- Publisher: *Federal Office of Meteorology and Climatology MeteoSwiss*
- Looked up via the public iTunes Search API (see the script below).

The artwork is fully square and opaque with no rounded-corner alpha baked
in — exactly what is wanted, since the HA frontend applies its own
masking. (The web favicon set at
`https://www.meteoschweiz.admin.ch/static/favicons/` tops out at 192×192
and must not be upscaled to the 256 needed here.)

## Regenerating

Only necessary when MeteoSwiss changes the app icon. Nothing calls this
automatically — it is not a build step.

```sh
pip install Pillow
python scripts/generate_brands_icon.py
```

It writes straight into `custom_components/meteoswiss_radar/brand/`;
review the result visually and commit it. Pass `--out <dir>` to render
somewhere else for inspection first.

Verified end-to-end on 2026-08-25: the iTunes lookup resolves
`ch.admin.meteoswiss`, and the script writes two valid square, opaque RGB
PNGs at exactly 256×256 and 512×512.

`tests/test_brands_icon.py` asserts both files exist with the expected
dimensions, so a missing or malformed icon fails CI rather than silently
degrading every user to the puzzle piece.

## Verifying

After a Home Assistant restart the icon appears on the integration page
and in HACS. It is served by the running instance rather than by the CDN,
so the check is against your own install, not `brands.home-assistant.io`.

The endpoint is `/api/brands/integration/{domain}/{image}`. It requires
auth: either a Bearer token, or a short-lived token from the
`brands/access_token` websocket command as `?token=`. Two query details
matter when checking by hand:

- `placeholder=no` disables the fallback image, so a 200 proves the real
  file was found rather than a generic placeholder.
- Requesting a domain that has no `brand/` folder returns 404 with that
  flag — useful as a control.

```sh
curl -s -o served.png -w '%{http_code} %{size_download}\n' \
  "http://homeassistant.local:8123/api/brands/integration/meteoswiss_radar/icon.png?token=$TOKEN&placeholder=no"
# then compare: git hash-object served.png
#                 vs custom_components/meteoswiss_radar/brand/icon.png
```

Verified this way on 2026-08-25 against a Pi running core-2026.8.3: both
`icon.png` and `icon@2x.png` returned 200 byte-identical to the committed
files, and an unknown domain returned 404.

Home Assistant decides an integration has branding purely by the folder's
presence — `has_branding` is `"brand" in _top_level_files` in
`homeassistant/loader.py`. Renaming the folder silently disables it.

Users on Home Assistant older than 2026.3 do not get the brands proxy API
and will still see the puzzle piece. The integration itself supports
2024.7.0+, so this is a graceful degradation, not a hard requirement.

## Relationship to the HACS default store

Issue #85 (default-store submission) previously listed a brands-repo
entry as a hard prerequisite. Whether HACS still requires one now that
integrations can self-host brand images is **unconfirmed** — the proxy
API announcement does not address HACS publishing. Verify against the
HACS publisher docs before assuming #84 unblocks #85.

## Superseded approach

Earlier revisions of this document described forking
`home-assistant/brands` and adding the icons under
`custom_integrations/meteoswiss_radar/`, and #163 turned those steps into
a runnable `gh` block. That path still works, but it is no longer the one
we take: it needs a PR against a foreign repository and a review round to
reach the same result the `brand/` folder delivers on the next restart,
and the brands repo's own README now labels that folder legacy.
