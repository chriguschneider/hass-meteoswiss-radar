# AGENTS.md

Conventions for AI-assisted contributions to this repo (Claude Code,
Cursor, Codex, Aider, or any other assistant). Read this first if you are
an AI assistant working on a branch, or a human driving one.

---

## Shared Skeleton

These conventions apply across all of chriguschneider's repos and come from
[`repo-standard`](https://github.com/chriguschneider/repo-standard). Repo-specific sections follow below.

### Commit attribution

Commits made with AI assistance carry a `Co-Authored-By:` trailer that
names the tool and model honestly, e.g.:

```
Co-Authored-By: Claude <noreply@anthropic.com>
Co-Authored-By: Codex <noreply@openai.com>
```

The exact string is not load-bearing; what matters is that git history
reflects what did the typing.

### Language

English only in code, comments, commit messages, and these repo docs.
Non-English is fine in chat, but never gets persisted to a file or a
commit.

### Comment discipline

Inline comments earn their place by explaining the *why* (a hidden
constraint, a subtle invariant, a workaround), not by restating the
code. The PR description is the place for context that does not survive
the diff.

### Model selection

Route the model to the difficulty, not the other way round:

- **Haiku** — trivial mechanical: typos, docs, a config default, a bumped
  constant, value validation.
- **Sonnet** — the default: normal bug fixes, tests, CI, well-scoped
  features.
- **Opus** — architectural surface: lifecycle/teardown, concurrency,
  hardening, ambiguous root-cause hunting, anything ADR-worthy.

### Parallel work

- **Branch naming**: `<tool-or-initials>/<issue>-<slug>`, e.g.
  `claude/3-map-teardown`.
- **Issue claiming**: `gh issue edit <N> --add-assignee @me` before
  starting, so parallel contributors (and the autopilot) see it is taken.
- **Worktrees**: parallelize along module boundaries, one worktree each:
  `git worktree add ../msr-<issue> <branch>`. One file, one lane.

### Draft PRs

CI runs on every push. If you iterate with several pushes, open the PR as
a **draft** until you expect CI to pass, then mark ready. Direct push to
`master` is not the flow; open a PR.

### Changelog entries

Every PR that changes user-visible behavior adds an entry to
`CHANGELOG.md` under `## [Unreleased]` in the right subsection
(Added/Changed/Deprecated/Removed/Fixed/Security, per
[Keep a Changelog](https://keepachangelog.com/en/1.0.0/)).

**Exemption:** a fix for a feature that never appeared in a released
version needs no entry — it has no user-visible before-state.

Write entries for users: would they click *Update* because of this line?
HACS and release pages show the section as is. Internal work (refactors,
CI, tests) goes in a short *Under the hood* list at the end of the section,
or nowhere.

The release commit (`chore(release): vX.Y.Z`) renames `## [Unreleased]`
to `## [vX.Y.Z] — YYYY-MM-DD`; the release workflow extracts that section
verbatim as the GitHub release notes.

### Generated files and data

- A committed build output (bundle, generated table, PDF) has a CI check
  that it matches its sources, and is regenerated in the same commit as
  the source change. On a rebase conflict, regenerate; never hand-merge it.
- Test fixtures are trimmed real files (keep the real header, encoding and
  a handful of rows), never hand-written. `tests/README.md` says where each
  one was cut from.
- Domain data (lookup tables, codes, thresholds) cites its source:
  `docs/upstream.md`, a URL or a fixture. Nothing is invented.

### Architectural decisions

If a change adds an upstream endpoint or dependency, adds a platform or a
public option, adds a quality gate, or deviates from an existing ADR, it
needs an ADR. Triggers and the template are in
[`docs/adr/README.md`](docs/adr/README.md). Land the ADR with the code.
An accepted ADR is not rewritten: append a dated amendment, or supersede
it with a new one (`docs/adr/README.md`, *Changing an accepted ADR*).

Claude Code users get automatic prompts via the repo-local skills in
`.claude/skills/`:

- **`commit-guardian`** — before any `git commit`, checks the staged diff
  against accepted ADRs and these conventions. Non-blocking.
- **`documentation-guardian`** — proposes an ADR when an architectural
  change happens and flags changes that contradict an existing decision.

### Automation

Opt-in, draft-PR-only (see [`docs/agent-automation.md`](docs/agent-automation.md)):
add the **`agent:go`** label to hand an issue to Claude, or write
**@claude** in a comment (owner/collaborators only). The model comes from
the issue's labels via `.github/scripts/pick-model.sh`. Unattended runs
use a tool allowlist, cannot write to `.github/` or `.claude/` (path guard
hook), and only act on issue text from people with write access.

---

## Repo-Specific: MeteoSwiss Radar

### What this is

The MeteoSwiss app's precipitation radar loop on a Home Assistant
dashboard: an integration that proxies the (unauthenticated, CORS-less)
MeteoSwiss app API and ships its own Lovelace card, plus optional local
rain-nowcast entities derived from the same frames. It is deliberately
*not* a weather integration: forecasts, warnings and station data live in
the sibling repo
[`hass-meteoswiss-weather`](https://github.com/chriguschneider/hass-meteoswiss-weather),
and the two stay separate installs (ADR-0010).

### Repo structure

This repo is two pieces:

- `custom_components/meteoswiss_radar/` — a Python Home Assistant
  integration: an authenticated proxy to the MeteoSwiss app API, local
  rain-nowcast entities, and the card static resource.
- `custom_components/meteoswiss_radar/frontend/meteoswiss-radar-card.js`
  — the Lovelace card, a single **vanilla JS classic script**. No
  bundler, no TypeScript, no build step (see
  [ADR-0002](docs/adr/0002-no-build-step-raw-card.md)). What is in the
  file is what ships. `frontend/vendor/` holds the vendored Leaflet.

The reverse-engineered API + frame format lives in
[`FORMAT.md`](FORMAT.md) and is the source of truth for the decoder;
[`docs/upstream.md`](docs/upstream.md) indexes every upstream fact.

### Non-negotiables from the ADRs

Every change respects these. The agent workflows tell the agent to stop
and say so in the PR rather than break one.

- **Proxy allowlist is the security boundary** (ADR-0001). The proxy
  serves only tails that `fullmatch` a pattern in `_ALLOWED_PATHS`, always
  against the fixed `UPSTREAM_BASE`; the tail never builds a different
  host, and non-JSON responses are rejected with 502. A new upstream path
  is an ADR amendment, not a regex tweak.
- **No build step for the card** (ADR-0002). One hand-written classic
  script; no bundler config, no `dist/`, no ES-module imports between card
  files. Tests load the shipped file through a vm shim.
- **Vendor assets through the allowlist view** (ADR-0003). The `{tag}` in
  `/vendor/{tag}/...` is an opaque cache-buster, never used for a
  filesystem path; only `_VENDOR_FILES` entries are served.
- **Releases only through the tag gate** (ADR-0004, ADR-0008). An
  annotated `vX.Y.Z` tag on a commit with green CI, matching the manifest
  and a non-empty changelog section; the release ships
  `meteoswiss_radar.zip` with the integration's contents at its root.
- **Quality gates stay** (ADR-0005, ADR-0007). CodeQL and the SonarCloud
  gate are not loosened, skipped or excluded to get a PR green; the
  vendored Leaflet and `tests/fixtures/` are the only exclusions.
- **Smoke test is a tripwire, not a PR check** (ADR-0006). Empty frames
  are valid; geometry is checked only when areas are present.
- **One frame format, two decoders** (ADR-0009). A change to `FORMAT.md`
  or to either contour decoder (card `decodeContourInto`, backend
  `_decode_contour_grid`) updates both and the cross-check test in
  `tests/test_nowcast_core_local.py`. The nowcast reuses the proxy
  (`async_get_json`); no second MeteoSwiss client, no broader allowlist.
  Missing or stale data never turns rain protection off.
- **Rain protection is radar-only** (ADR-0010). The binary sensor is
  never layered with weather-model data; `next_rain` reads the weather
  entity through `weather.get_forecasts`, never by importing the sibling
  integration.
- **Attribution** (`FORMAT.md`): the card always shows "Source:
  MeteoSwiss" and © swisstopo for the basemap.

### Parallel work in this repo

The card is one file; card issues collide if edited in parallel. Split
lanes as card-JS / proxy-Python / nowcast-Python / tests, one worktree
each.

### Release procedure

Releases are automated via tag push and a CI workflow (`.github/workflows/release.yml`),
which implements ADR-0004. The process:

1. **Update version and changelog**: bump the version in
   `custom_components/meteoswiss_radar/manifest.json`, `VERSION` in
   `const.py`, `CARD_VERSION` in `frontend/meteoswiss-radar-card.js` and
   `version` in `package.json` (all four are checked by
   `tests/test_metadata.py`). Rename `## [Unreleased]` to
   `## [vX.Y.Z] — YYYY-MM-DD` in [Keep a Changelog](https://keepachangelog.com/)
   format and add a fresh empty `## [Unreleased]`. Both changes land in a
   commit (e.g., `chore(release): v0.12.0`).

2. **Verify**: Run `pytest -q tests/test_metadata.py tests/test_changelog.py`
   locally to ensure the version is in sync and the changelog section exists.

3. **Wait for CI**: merge the release commit and wait until CI on
   `master` is green for it. `release.yml` refuses a tag whose commit has
   no successful `ci.yml` run.

4. **Tag**: Create an **annotated** tag with the release title:
   ```bash
   git tag -a vX.Y.Z -m "Release title: what changed"
   ```
   Only annotated tags are recognized — lightweight tags are skipped. The tag
   message is parsed to build the GitHub release title as `vX.Y.Z — <message>`.

5. **Push and watch CI**: Push the tag to GitHub:
   ```bash
   git push origin vX.Y.Z
   ```
   The release workflow runs automatically, verifies the tag matches the version,
   extracts release notes from `CHANGELOG.md`, packages `meteoswiss_radar.zip`
   and creates the GitHub release. HACS reads the GitHub release to pull in
   new versions.

**From Claude Code:** The workflow uses `gh release create` at step 5, which was
historically blocked by permission checks on first attempts. This repo now has
`.claude/settings.json` with an explicit `gh` allowlist, so release commands run
without retry or friction. That allowlist is for local, human-driven
sessions; unattended CI runs deny `gh release`, `gh issue edit` and
`gh issue close` in `.claude/ci-settings.json`.

### Testing

Exactly what `.github/workflows/ci.yml` runs:

- **Card decoder**: `npm ci` once, then `npm test` (vitest). The pure
  decoder functions are loaded out of the shipped card via a vm shim, so
  tests hit the real code without a build step. Golden geometry is
  snapshotted; regenerate with `npm test -- -u` only after verifying
  against live data.
- **Card syntax**: `npm run check` (`node --check`).
- **Integration metadata and nowcast core**: `pip install ruff pytest`,
  then `pytest -q` (stdlib only, no HA; `tests/stubs_ha.py` stands in for
  the HA modules). Full proxy behavior tests against
  `pytest-homeassistant-custom-component` are tracked as a separate issue.
- **Lint**: `ruff check custom_components tests`.
- **Never hit the network in tests.** Upstream data comes from trimmed
  real files in `tests/fixtures/`; the live API is only for
  `tests/tools/smoke_test.py`. There is no `tests/README.md` inventory
  yet: a new fixture says in its test where and when it was cut. Files
  named `*_synthetic*` are synthetic on purpose and say so in their name.

### Home Assistant pitfalls

Lessons from real integrations; several shipped with every test green.

- **`vol.Required` with an empty-string default blocks the form.** The UI
  treats `""` as "not filled in" and refuses to submit, while a test that
  calls `async_configure` with a value passes. Use `vol.Optional` for
  fields that may stay empty, or a real default; give a required field no
  default at all.
- **Open cards only see what the coordinator announces.** A dashboard card
  re-renders when the entity it watches writes a new state, and coordinator
  entities only write state when the coordinator calls its listeners. Data
  that changes outside `_async_update_data` (a forecast, a service call, a
  push message) must go through `coordinator.async_set_updated_data(...)`
  or `coordinator.async_update_listeners()`; changing an attribute and
  waiting does nothing for an open card.
- **Availability follows the data, not the last poll.** An entity is
  available when the coordinator has data it can show
  (`coordinator.data is not None`), not only when the last update
  succeeded. One failed poll must not blank every card; data that is too
  old to trust is the entity's call, made explicitly.
- **Never block the event loop.** No synchronous I/O, and no parsing of big
  CSV/JSON payloads on the loop: `await hass.async_add_executor_job(parse,
  payload)`. HA logs "Detected blocking call" and the whole UI stalls.
- **No secrets or location in what users post.** This integration has no
  `diagnostics.py` yet; if one is added, everything in it goes through
  `async_redact_data` (coordinates, the home location, tokens), with a
  test that proves it. Debug logs must not print the home coordinates
  either.

### Upstream smoke test

`.github/workflows/smoke-test.yml` (ADR-0006) runs
`tests/tools/smoke_test.py` against the live MeteoSwiss API every Monday.
On failure it opens or comments on one issue titled "Upstream API format
drift detected" (labels `tracking` and `area-integration`, never a
P-label, so no agent works it); on recovery it comments and leaves the
issue open for a human to close.

- A PR that starts fetching a new upstream product adds a check for it to
  the smoke test in the same PR. Checks validate shape (fetch, decode,
  plausible geometry), not content; an empty frame is a pass.
- The script stays stdlib-only and secret-free.
- A failing smoke test is not a reason to change the decoder blindly:
  first compare what upstream returns now with `FORMAT.md`, then refresh
  the fixtures from the new real files.

### The bundled card

The card lives in `custom_components/meteoswiss_radar/frontend/meteoswiss-radar-card.js`
and ships in the release zip with the integration. It is a classic script
with **no build step**: the committed file is what browsers run. The root
`package.json` exists only for the card's tests (vitest); nothing from npm
is shipped.

- **Registration.** `__init__.py` serves the card through
  `MeteoSwissRadarCardView` (`Cache-Control: no-cache`, so browsers
  revalidate after an update) and the vendored Leaflet through the
  allowlist view; routes are registered once per HA run, since they
  cannot be unregistered. The extra-JS URL is added with
  `add_extra_js_url` on setup and removed on unload, so a reload must
  neither lose nor double the card (issue #67).
- **Versions.** `manifest.json`, `const.py` `VERSION`, the card's
  `CARD_VERSION` and `package.json` move together
  (`tests/test_metadata.py`). Vendor URLs carry `CARD_VERSION` as the
  cache-buster tag.
- **Untrusted text.** States, attributes and translated strings are
  written with `textContent`. `innerHTML` is only for the card's own
  static templates and SVG constants, never for data.
- **Changelog: say what the user must do.** Every changelog entry ends with
  *frontend only (browser reload)* when only the card changed, or *requires
  restart* when Python changed (the integration, or how the card is
  registered). An entry that touches both says *requires restart*.
