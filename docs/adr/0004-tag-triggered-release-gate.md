# ADR-0004: Tag-triggered release gate and Keep-a-Changelog

- **Status:** Accepted
- **Date:** 2026-08-24

## Context

Releases have been published manually and have produced drift: `0.7.6` and
`0.8.0` were tagged 19 minutes apart with identical titles; #62 and #64
were version/metadata drift caught after the fact rather than by CI. The
existing `test_versions_are_in_sync` test guards file-to-file consistency
but nothing checks the **git tag** against `manifest.json`, and nothing
requires release notes to exist before a tag is pushed.

The sibling repo `weather-station-card` already runs the target pattern:
Keep-a-Changelog `CHANGELOG.md`; on tag push, CI asserts tag == version,
extracts the matching `## [x.y.z]` section as release notes, and fails if
the section is missing.

## Decision

1. **CHANGELOG.md**: Add `CHANGELOG.md` in Keep a Changelog format
   (`https://keepachangelog.com/en/1.0.0/`), backfilling `0.7.6` and
   `0.8.0`. All future releases add a section before tagging.

2. **v-prefix tags**: Adopt the `v` prefix from `v0.9.0` onward (e.g.
   `v0.9.0`). The two existing tags (`0.7.6`, `0.8.0`) keep their original
   form. CI release logic strips the prefix with `${GITHUB_REF_NAME#v}` to
   obtain the bare version for comparison against `manifest.json`.

3. **Release workflow** (`.github/workflows/release.yml`): On
   `push: tags: ['v*']`, the workflow:
   - Asserts the bare tag version equals `manifest.json["version"]` (and
     the other version-synced files).
   - Extracts the `## [x.y.z]` section from `CHANGELOG.md`; fails if the
     section is absent or empty.
   - Creates the GitHub release with those notes via `gh release create`.
   - No release assets are needed: HACS downloads the repo zip for
     integrations.

4. **CHANGELOG test**: `tests/test_changelog.py` verifies that
   `CHANGELOG.md` exists and contains a section for the version currently
   declared in `manifest.json`, so the guard runs on every push — not just
   on tag push.

## Consequences

- A tag pushed without a matching CHANGELOG section or with a mismatched
  version string fails the release job before a GitHub release is created.
- The CHANGELOG section for the current version must be written before
  bumping version files and pushing the tag; the test on regular pushes
  enforces this after the bump but before the tag.
- Old tags (`0.7.6`, `0.8.0`) match no `v*` pattern and are not
  reprocessed; their GitHub releases remain as manually created.
- A new CI job is a quality-gate addition per `docs/adr/README.md` — hence
  this ADR.
- The release workflow itself lives in `.github/workflows/release.yml`,
  which is outside the scope of agent automation (agents may not modify
  `.github/workflows/`). It must be authored and merged by a human.
