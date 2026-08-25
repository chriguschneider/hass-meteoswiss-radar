# ADR-0007: SonarCloud quality gate via CI-based analysis

- **Status:** Accepted
- **Date:** 2026-08-24

## Context

The repo ships an authenticated HTTP proxy and a Lovelace card. Static
quality analysis (duplication, complexity, security hotspots, coverage
trends) has been absent since the repo was created. The sibling repo
`weather-station-card` already uses SonarCloud with CI-based scanning;
this repo follows the same pattern.

The SonarCloud project (`chriguschneider_hass-meteoswiss-radar`,
org `chriguschneider`) was created via Automatic Analysis on 2026-08-24.
CI-based analysis replaces Automatic Analysis because it is the only
way to upload coverage data and to enforce the quality gate on PRs
(Automatic Analysis cannot upload external results and its gate result
is not surfaced to GitHub checks).

## Decision

Add a `.github/workflows/sonarcloud.yml` workflow that:

- triggers on push to `master`, pull requests, and `workflow_dispatch`,
- uses `fetch-depth: 0` (SonarCloud needs full history for new-code detection),
- runs the Python test suite with `pytest-cov` and uploads `coverage.xml`,
- skips JS coverage upload (see below), and
- runs `SonarSource/sonarqube-scan-action@v8` with
  `-Dsonar.qualitygate.wait=true` so quality-gate failures block the PR job.

`sonar-project.properties` at the repo root carries the project key,
source/test paths, exclusions, and coverage paths.

**Vendor and fixture exclusions** (`sonar.exclusions`):

- `custom_components/meteoswiss_radar/frontend/vendor/**` — third-party
  libraries (Leaflet, etc.); not authored here.
- `tests/fixtures/**` — binary frame payloads; no logic to analyse.

**Coverage-exclusion policy** (`sonar.coverage.exclusions`):

- `tests/tools/**` — smoke-test and reference-decode helpers run outside
  the pytest suite and would appear as 0 % uncovered.
- `custom_components/meteoswiss_radar/config_flow.py` — boilerplate HA
  config flow not exercised by the stdlib-only test suite.

**JS coverage limitation** _(superseded — see Update 2026-08-25 below)_:
the card is loaded inside a `node:vm` context by the test suite (ADR-0002 —
no bundler; tests load the shipped file via vm shim). This originally claimed
V8 cannot attribute execution inside a vm context back to the source file
path, so `npm run coverage` reports 0 % for the card, and therefore omitted
`sonar.javascript.lcov.reportPaths` until a vm-compatible mechanism existed
(issue #133 follow-up). That premise was wrong; issue #171 fixed it.

`pytest-cov` is added as a CI dependency. The coverage script
(`npm run coverage`) and `@vitest/coverage-v8` are added so the
infrastructure exists locally and in CI for when the vm limitation is
resolved.

## Update 2026-08-25 (issue #171): JS coverage is now uploaded

The "V8 cannot attribute vm coverage" premise above was too strong. V8 keys
coverage for a vm script by the `filename` passed to `vm.runInContext`; the
loader passed a bare `"meteoswiss-radar-card.js"`, which does not resolve to a
file, so v8-to-istanbul discarded it. Passing the absolute `cardPath` instead
makes the 211 decoder tests attribute to the card. The appended `__decoder`
epilogue lands on a line past the file's end, so it maps out of range and is
clipped — real-code byte offsets are unshifted and map cleanly.

Changes:

- `tests/decoder.test.mjs` — all three `vm.runInContext` sites pass
  `{ filename: cardPath }` (the resolved absolute path).
- `vitest.config.js` — `coverage.include` targets the card so `lcov.info`
  carries it (was `include: []`).
- `sonar-project.properties` — `sonar.javascript.lcov.reportPaths=coverage/lcov.info`
  is now set.
- `.github/workflows/sonarcloud.yml` — must add a Node setup + `npm ci` +
  `npm run coverage` step before the scan so `coverage/lcov.info` exists in CI
  (agent automation cannot edit workflows; landed by a human — see the PR).

Local `npm run coverage` reports the card at ~81 % line coverage, enough to
clear the gate's 80 % `new_coverage` threshold.

## Consequences

- Every PR receives a SonarCloud quality-gate check; gate failures block
  merge instead of surfacing post-merge.
- Python and JS line coverage are both tracked over time (JS coverage was
  absent before issue #171; see the Update above).
- The workflow file must be authored and merged by a human (agent
  automation cannot modify `.github/workflows/`, per AGENTS.md).
- Automatic Analysis must be disabled in the SonarCloud project settings
  (one-time, by repo owner) before the first CI scan, to avoid duplicate
  analysis conflicts.
- `pytest-cov` joins `ruff` and `pytest` as required CI test dependencies.
