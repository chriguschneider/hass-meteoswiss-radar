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

**JS coverage limitation**: the card is loaded inside a `node:vm` context
by the test suite (ADR-0002 — no bundler; tests load the shipped file via vm
shim). V8 cannot attribute execution inside a vm context back to the source
file path, so `npm run coverage` reports 0 % for the card. Uploading a
synthetic 0 % would misrepresent coverage and trigger false quality-gate
failures. `sonar.javascript.lcov.reportPaths` is therefore omitted until a
vm-compatible coverage mechanism exists (issue #133 follow-up).

`pytest-cov` is added as a CI dependency. The coverage script
(`npm run coverage`) and `@vitest/coverage-v8` are added so the
infrastructure exists locally and in CI for when the vm limitation is
resolved.

## Consequences

- Every PR receives a SonarCloud quality-gate check; gate failures block
  merge instead of surfacing post-merge.
- Python line coverage is tracked over time; JS coverage is absent until
  a vm-compatible mechanism is found.
- The workflow file must be authored and merged by a human (agent
  automation cannot modify `.github/workflows/`, per AGENTS.md).
- Automatic Analysis must be disabled in the SonarCloud project settings
  (one-time, by repo owner) before the first CI scan, to avoid duplicate
  analysis conflicts.
- `pytest-cov` joins `ruff` and `pytest` as required CI test dependencies.
