# ADR-0008: Ship a zip release asset so installs are countable

- **Status:** Accepted
- **Date:** 2026-08-25

## Context

HACS reported **0 downloads** for this repository across every release from
`0.7.6` to `v0.13.0`, including installs we know happened. The number is not
wrong; it is measuring something we never produce.

HACS' "downloads" is GitHub's **release-asset** download counter. It only moves
when HACS fetches a release asset, and `should_try_releases` in HACS'
`repositories/base.py` decides that:

```python
if self.repository_manifest.zip_release:
    if self.repository_manifest.filename.endswith(".zip"):
        if self.ref != self.data.default_branch:
            return True
if self.ref == self.data.default_branch:
    return False
if self.data.category not in ["plugin", "theme"]:
    return False
```

An `integration` without `zip_release` never reaches a release asset — HACS
installs it by walking the repository tree. So the counter is pinned at zero
however many people install, permanently.

Two comparisons confirmed the mechanism rather than inferring it:

| Repository | hacs.json | Assets | HACS shows |
| --- | --- | --- | --- |
| `chriguschneider/weather-station-card` (plugin) | `filename: weather-station-card.js` | 25, each ~177 downloads | three digits |
| `yandex/pogoda-home-assistant` (integration) | **`zip_release: true`** | `yandex_pogoda.zip` = 5026 | 4765 |
| this repo | neither | **0 on every release** | 0 |

This has a second cost. The README carries a
`img.shields.io/github/downloads/.../total` badge reading the same counter, and
`hacs.json` sets `render_readme: true`. So the HACS store page — the discovery
surface once the default-store entry lands — displays "0 downloads" beside the
integration. A visitor reads that as "nobody uses this".

## Decision

Set `zip_release: true` and `filename: meteoswiss_radar.zip` in `hacs.json`,
and have `release.yml` build and attach that asset.

The archive holds the **contents** of `custom_components/meteoswiss_radar/` at
its root, not the directory itself. HACS extracts it straight into
`custom_components/<domain>/`; a wrapper folder would produce
`custom_components/meteoswiss_radar/meteoswiss_radar/` and no install would
work. Verified against a working example (`yandex_pogoda.zip`) before adopting.

`release.yml` asserts the layout — `manifest.json` at the root, no
`__pycache__` — and fails the release rather than publishing a broken asset.

`content_in_root: false` stays: the tree-walk remains the path for
default-branch installs, which HACS never serves from a release.

## Consequences

- Installs become countable, and the README badge starts telling the truth.
  This matters beyond vanity: whether anyone uses the integration is the
  evidence a 1.0 depends on, and it was unobservable before.
- HACS downloads one artifact instead of walking the tree — faster, and less
  GitHub API pressure per install.
- **This supersedes point 4 of ADR-0004's Decision**, which reads *"No release
  assets are needed: HACS downloads the repo zip for integrations."* That was
  true of what HACS does by default; it was not true of what makes installs
  visible. ADR-0004 otherwise stands unchanged.
- A malformed asset breaks installation for everyone, which the repo tree never
  could. Hence the layout assertion in CI. Adopting this before the default
  store entry lands is deliberate: the blast radius is smallest now.
- The release path gains a build step. This does **not** touch ADR-0002 — the
  card is still hand-authored and shipped as-is; the zip only packages files
  that already exist.
