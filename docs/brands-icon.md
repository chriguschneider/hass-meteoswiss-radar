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
labelled a legacy path in that repo's own README, and **that route is now
closed** — see "The brands repository will not take us" below. The `brand/`
folder is not the preferred option; it is the only one.

It does not cover every surface. Home Assistant's own UI renders it; the
HACS store list does not — see "Where the icon does and does not appear".

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

## Where the icon does and does not appear

Two surfaces, two different sources. This was wrong in an earlier revision
of this document, which claimed the icon shows "on the integration page and
in HACS".

| Surface | Fetches from | Result |
| --- | --- | --- |
| Settings → Devices & Services | `/api/brands/integration/{domain}/icon.png` on the running instance | ✅ our icon |
| Add-integration dialog | same | ✅ our icon |
| **HACS store list** | `https://brands.home-assistant.io/_/{domain}/icon.png` — the **CDN**, not the instance | ❌ placeholder |

The HACS case is easy to misdiagnose, because the CDN does not 404 for an
unknown domain on that path. It answers **200 with a picture that reads
"icon not available"** — 3039 bytes, byte-identical to what any other
brands-less custom integration gets. So there is no failed request to find
in devtools; the placeholder *is* the successful response.

Measured on a live instance (2026-08-25, core-2026.8.3, HACS 2.0.5):

```
/api/brands/integration/meteoswiss_radar/icon.png?placeholder=no    → 200  20232 bytes
/api/brands/integration/meteoswiss_radar/icon@2x.png?placeholder=no → 200  61849 bytes
/api/brands/integration/no_such_domain_xyz/icon.png?placeholder=no  → 404   (control)

https://brands.home-assistant.io/_/meteoswiss_radar/icon.png        → 200  3039 bytes  (placeholder)
```

Byte counts match the committed files exactly, so a 200 here proves the real
file was served rather than a fallback.

This is a known HACS limitation, not a fault in our setup:
[`hacs/frontend#936`](https://github.com/hacs/frontend/issues/936) (closed,
diagnosed: `hacs-dashboard.ts` calls `brandsUrl({useFallback: true})`, which
always goes to the CDN), plus `hacs/integration` #5171, #5179, #5223 and
#5402, all open since March 2026. The fix in flight is
[`hacs/integration#5388`](https://github.com/hacs/integration/pull/5388) — a
`/api/hacs/repository/{id}/icon.png` endpoint that serves downloaded
integrations from the local brand folder. Still unmerged as of 2026-08-25,
and the newest HACS release is 2.0.5 from January 2025.

Nothing on our side changes this. Do not go looking for a bug here.

## Verifying

The icon is served by the running instance rather than by the CDN, so the
check is against your own install, not `brands.home-assistant.io`.

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
entry as a hard prerequisite. **Confirmed on 2026-08-25 that it is not**
— the in-repo `brand/` folder satisfies HACS too, so #84 does unblock
#85.

HACS runs its own brands validator, and it checks the repository tree
before it ever looks at the CDN
([`custom_components/hacs/validate/brands.py`](https://github.com/hacs/integration/blob/main/custom_components/hacs/validate/brands.py)):

```python
if self.repository.repository_manifest.content_in_root:
    asset_path = f"brand/{ASSET_FILENAME}"
else:
    asset_path = f"{self.repository.content.path.remote}/brand/{ASSET_FILENAME}"

if asset_path in treefiles:
    return  # local brand assets are enough
# ... otherwise fall back to home-assistant/brands domains.json
```

Our `hacs.json` sets `content_in_root: false`, so the path it looks for
is exactly `custom_components/meteoswiss_radar/brand/icon.png` — which
this repo ships. The [publisher
docs](https://www.hacs.xyz/docs/publish/include#check-brands) say the
same in prose.

One consequence for CI: the same page requires the HACS action to pass
*“without any errors or ignores”*. `ci.yml` therefore carries **no**
`ignore: brands` — it used to, back when the plan was a PR against the
brands repo, and leaving it in would have disqualified the submission
even though the check now passes on its own merits.

## The brands repository will not take us

Earlier revisions of this document described forking
`home-assistant/brands` and adding the icons under
`custom_integrations/meteoswiss_radar/`, and #163 turned those steps into a
runnable `gh` block. A later revision called that path "superseded" but said
it "still works". **It does not.** Verified 2026-08-25:

- The repository's own pull-request template opens with:
  *"Pull requests for adding new custom components will no longer be
  accepted."*
- Its "Type of change" checklist has no option that fits — every entry is
  about a **core** integration.
- Every recent submission of this shape was closed unmerged. In the five days
  to 2026-08-25 alone: #11016, #11017, #11018, #11019, #11020, #11021, #11023,
  #11024, #11025, #11026, #11027, #11028, #11029, #11030, #11031 — two of them
  closed the same day they were opened.
- The last merged *addition* under `custom_integrations/` was #10172 on
  2026-04-20. Everything merged there since has been a removal or a move.

So the `brand/` folder is not a shortcut we chose over a review round. It is
the only route that exists, and opening a brands PR would just join a queue
of same-day rejections.

The practical consequence is the HACS gap above: until
`hacs/integration#5388` lands, the HACS store list shows a placeholder and
there is no action available to us that changes it.
