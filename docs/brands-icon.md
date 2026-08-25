# Submitting the integration icon to home-assistant/brands

Home Assistant and HACS show the default puzzle-piece icon for this
integration because there is no entry in
[`home-assistant/brands`](https://github.com/home-assistant/brands). Once
an entry exists, the icon is served from
`https://brands.home-assistant.io/meteoswiss_radar/icon.png` and appears
in the HA integrations UI and in HACS automatically — **no change to this
repository is required** (tracking: issue #84).

The brands submission itself is a PR to *another* repository and involves
a trademark judgement, so it cannot be automated from here. This document
records the decision, the exact source, and the steps, so the maintainer
can complete it in a few minutes.

## Decision

Use the **official MeteoSwiss logo / app icon** (maintainer decision,
2026-08-24), not a neutral radar-motif substitute. If the brands PR is
rejected over the logo (the icon contains the Swiss cross, protected under
the Coat of Arms Protection Act, SR 232.21), fall back to a neutral
radar-motif icon.

## Source

The App Store artwork for the official MeteoSwiss app:

- Bundle id: `ch.admin.meteoswiss`
- Publisher: *Federal Office of Meteorology and Climatology MeteoSwiss*
- Looked up via the public iTunes Search API (see the script below).

The artwork is a fully square, opaque icon with no rounded-corner alpha
baked in — exactly what brands wants; the HA frontend applies its own
masking. (The web favicon set at
`https://www.meteoschweiz.admin.ch/static/favicons/` tops out at 192×192
and must not be upscaled to the 256 brands needs.)

## Generate the icons

```sh
pip install Pillow
python scripts/generate_brands_icon.py --out build/brands
```

This produces, from the app artwork:

- `build/brands/icon.png`    — 256×256 PNG
- `build/brands/icon@2x.png` — 512×512 PNG

The output lands in `build/`, which is git-ignored on purpose: the
trademarked logo's home is the brands PR, not this repo's history.

Verified end-to-end on 2026-08-25: the iTunes lookup resolves
`ch.admin.meteoswiss`, and the script writes two valid square, opaque
RGB PNGs at exactly 256×256 and 512×512. The generator is ready; only
the manual brands PR below remains.

## Open the brands PR

1. Fork [`home-assistant/brands`](https://github.com/home-assistant/brands).
2. Add the two files under
   `custom_integrations/meteoswiss_radar/` — the folder name **must** equal
   the `domain` in `custom_components/meteoswiss_radar/manifest.json`
   (`meteoswiss_radar`, which it does):

   ```
   custom_integrations/meteoswiss_radar/icon.png
   custom_integrations/meteoswiss_radar/icon@2x.png
   ```
3. Follow the brands repo's own checks (`script/lint`, image size/trim
   rules) and open the PR. Be ready for reviewers to ask about logo
   rights.

   Steps 1–3 as a runnable block, once you have decided to proceed with
   the official logo (run from this repo's checkout, after generating the
   icons above; requires the `gh` CLI, authenticated):

   ```sh
   gh repo fork home-assistant/brands --clone --remote --default-branch-only
   dir=brands/custom_integrations/meteoswiss_radar
   mkdir -p "$dir"
   cp build/brands/icon.png build/brands/icon@2x.png "$dir"/
   git -C brands checkout -b meteoswiss_radar-icon
   git -C brands add custom_integrations/meteoswiss_radar
   git -C brands commit -m "Add meteoswiss_radar icon"
   git -C brands push -u origin meteoswiss_radar-icon
   # gh pr create infers the head branch from the current directory's
   # git repo, so it must run inside the fork checkout, not this repo.
   (cd brands && gh pr create --repo home-assistant/brands \
     --title "Add meteoswiss_radar icon" \
     --body "Icon for the MeteoSwiss Radar custom integration \
(https://github.com/chriguschneider/hass-meteoswiss-radar). Official \
MeteoSwiss app icon; used with the maintainer's consent for this \
non-commercial community integration.")
   ```
4. After merge, verify:
   - `https://brands.home-assistant.io/meteoswiss_radar/icon.png` returns
     the icon (was 404 as of 2026-08-24),
   - the icon shows on the HA integration page and in HACS.

No follow-up change is needed in this repository once brands merges.
This unblocks the HACS default-store submission (issue #85).
