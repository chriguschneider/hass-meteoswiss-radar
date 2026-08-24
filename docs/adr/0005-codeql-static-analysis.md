# ADR-0005: CodeQL static analysis as a quality gate

- **Status:** Accepted
- **Date:** 2026-08-24

## Context

This repo ships an **authenticated HTTP proxy** whose allowlist is the
declared security boundary (ADR-0001), plus browser-executed JavaScript.
Static security analysis has been on the backlog since the sibling repo
`weather-station-card` adopted CodeQL (`security-extended`) covering both
`javascript-typescript` and `python`.

CodeQL is free for public repos and covers the two relevant languages. The
proxy's URL-handling surface (allowlist enforcement, upstream fetch,
redirect blocking, body-size cap, Content-Type guard) is the primary
area of interest; the card's DOM-manipulation surface is secondary.

## Decision

Add a `.github/workflows/codeql.yml` workflow that runs CodeQL with
`security-extended` on:

- every pull-request push (both languages),
- every push to `master` (both languages),
- a weekly cron schedule (Saturday 02:15 UTC, matching the sibling repo).

Languages: `javascript-typescript` and `python`.

Initial findings must be triaged before the workflow is merged:

- **Confirmed findings** are fixed in the same PR.
- **False positives** are dismissed inline via a `# nosec` comment
  (Python) or a `// lgtm` / CodeQL suppression comment (JS), with a
  one-line reason.

The workflow file itself lives in `.github/workflows/` and must be
authored and merged by a human; agent automation may not modify that
directory (per AGENTS.md).

## Consequences

- New PRs automatically receive a CodeQL pass/fail check, making
  security regressions visible before merge.
- A new CI job is a quality-gate addition per `docs/adr/README.md`;
  hence this ADR.
- The initial triage (findings → fixes or suppressions) must accompany
  the workflow file in the same PR.
- False-positive suppressions accumulate over time; the weekly cron
  ensures new CodeQL rules surface against the current codebase.
- Agent automation cannot land the workflow file itself (see AGENTS.md);
  the PR that adds it requires a human push.
