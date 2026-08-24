# Architecture Decision Records

Short, dated records of decisions that shape this repo: why the proxy has
an allowlist, why the card ships without a bundler, and so on. They exist
so a later change (human or AI) does not silently undo a deliberate call.

## When to write one

Write an ADR when a change:

- alters the **proxy allowlist** or the security boundary of the proxy,
- changes **how the card is built or shipped** (a bundler, a module
  split, a new asset pipeline),
- adds or moves a **quality gate** (a CI job, a lint rule, a coverage
  floor),
- introduces a **new architectural pattern** or breaks a module boundary,
- **deviates from an existing accepted ADR**.

Skip it for bug fixes that keep the contract, refactors inside a module,
added test coverage, and prose/style tweaks.

## How

1. Copy [`template.md`](template.md) to `NNNN-short-slug.md` (next free
   number).
2. Fill in Context, Decision, Consequences. Keep it to a screen.
3. Land it in the same PR as the code it describes.

## Index

- [0001 — Proxy path allowlist as the security boundary](0001-proxy-path-allowlist.md)
- [0002 — Card ships as raw JS, no build step](0002-no-build-step-raw-card.md)
- [0003 — Vendor assets served version-agnostically by an allowlist view](0003-version-agnostic-vendor-serving.md)
- [0004 — Tag-triggered release gate and Keep-a-Changelog](0004-tag-triggered-release-gate.md)
- [0005 — CodeQL static analysis as a quality gate](0005-codeql-static-analysis.md)
- [0006 — Scheduled live smoke test against MeteoSwiss API](0006-scheduled-live-smoke-test.md)
