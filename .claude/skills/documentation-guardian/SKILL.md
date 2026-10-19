---
name: documentation-guardian
description: Proactively suggests an ADR when an architectural change happens in the MeteoSwiss Radar repo, and checks planned changes against existing decisions in docs/adr/. Activate on a proxy allowlist change, a card build/module change, a new quality gate or CI job, a new upstream endpoint or dependency, a changed budget, a new platform or public option, the same logic in a second place, or a deviation from an accepted ADR.
---

# Documentation Guardian

Keeps `docs/adr/` in sync with the code. Two jobs: detect ADR-worthy
changes as they happen and propose drafting one, and check in-progress
changes against existing decisions before they land.

ADR conventions live in [`docs/adr/README.md`](../../../docs/adr/README.md).
When the two disagree, that file wins.

## Activation triggers

- A change to `_ALLOWED_PATHS` or the proxy security boundary
  (`__init__.py`) — governed by ADR-0001.
- A change to how the card is built or shipped: a bundler, a
  minification step, splitting the card into ES modules, a `dist/` —
  governed by ADR-0002.
- A **new upstream endpoint** proxied (e.g. INCA snow/type variants):
  adds an allowlist pattern, worth a note against ADR-0001.
- A **new quality gate**: a CI job under `.github/workflows/`, a ruff rule
  promoted, a coverage floor, a new required check.
- A **new top-level card config option** or a **new options-flow key**
  (public API, hard to remove).
- A **new platform** or a new runtime dependency (`requirements` in
  `manifest.json`, a vendored library).
- A change to a **budget**: request cadence, the nowcast fetch window, the
  proxy cache size (see `FORMAT.md` for the measured frame sizes).
- The **same logic in a second language or place** (a parser in Python and
  in JS, a table in code and in docs): propose one written spec plus a
  shared golden-fixture test both sides run. The contour decoder already
  is such a pair (ADR-0009).
- A **pattern deviation** from an accepted ADR.

## Skip

- Bug fixes that keep the contract (no new option, boundary, or gate).
- Refactors inside a module with an identical public surface.
- Added test coverage, lint-warning cleanup, prose/style tweaks.
- User-facing YAML/dashboard examples in docs (usage, not architecture).

## Workflow

1. When a trigger fires, name the decision and which existing ADR it
   touches (or that it is new).
2. If it deviates from an accepted ADR, say so and stop for the user.
3. If it is a genuinely new decision, offer to draft an ADR from
   `docs/adr/template.md` with the next free number, and land it in the
   same PR as the code. If it changes an accepted ADR, propose a dated
   `## Amendment YYYY-MM-DD (#issue)` section instead of editing the
   decision text (`docs/adr/README.md`, *Changing an accepted ADR*).
4. Keep proposals rare and load-bearing: an ADR per bug fix is noise.
