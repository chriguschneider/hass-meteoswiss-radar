# ADR-0002: Card ships as raw JS, no build step

- **Status:** Accepted
- **Date:** 2026-08-22

## Context

The card is a single vanilla-JS classic script served via
`add_extra_js_url`. It is loaded early in HA app boot, before the
scoped-registry polyfill swap (see `defineWhenRegistryReady`). There is
currently no bundler, no TypeScript, and no minification.

## Decision

The card stays a single hand-authored classic script with **no build
step**. What is in `meteoswiss-radar-card.js` is what ships. Tests load
the pure decoder functions out of the shipped file via a vm shim
(`tests/decoder.test.mjs`) rather than importing a module, so there is no
build artifact to keep in sync and no `dist/` to commit.

## Consequences

- Zero build tooling to maintain; the file is directly reviewable and
  directly served.
- No ES-module `import` between card files: splitting the decoder into its
  own module would change how the card loads (classic vs module) and is
  therefore an ADR-worthy change, not a silent refactor.
- No minification; bundle-size work, if ever needed, is a deliberate
  future decision that would supersede this ADR.
