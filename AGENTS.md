# AGENTS.md

Conventions for AI-assisted contributions to this repo (Claude Code,
Cursor, Codex, Aider, or any other assistant). Read this first if you are
an AI assistant working on a branch, or a human driving one.

This repo is two pieces:

- `custom_components/meteoswiss_radar/` — a Python Home Assistant
  integration: an authenticated proxy to the MeteoSwiss app API plus the
  card static resource. No entities.
- `custom_components/meteoswiss_radar/frontend/meteoswiss-radar-card.js`
  — the Lovelace card, a single **vanilla JS classic script**. No
  bundler, no TypeScript, no build step (see
  [ADR-0002](docs/adr/0002-no-build-step-raw-card.md)). What is in the
  file is what ships.

The reverse-engineered API + frame format lives in
[`FORMAT.md`](FORMAT.md) and is the source of truth for the decoder.

## Commit attribution

Commits made with AI assistance carry a `Co-Authored-By:` trailer that
names the tool and model honestly, e.g.:

```
Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
Co-Authored-By: Codex <noreply@openai.com>
```

The exact string is not load-bearing; what matters is that git history
reflects what did the typing.

## Language

English only in code, comments, commit messages, and these repo docs.
German is fine in the chat, but it never gets persisted to a file or a
commit.

## Comment discipline

Inline comments earn their place by explaining the *why* (a hidden
constraint, a subtle invariant, a workaround), not by restating the
code. The `defineWhenRegistryReady` and proxy cache-control comments are
the model: each encodes a non-obvious reason. The PR description is the
place for context that does not survive the diff.

## Model selection

Route the model to the difficulty, not the other way round:

- **Haiku** — trivial mechanical: typos, docs, a config default, a bumped
  constant, value validation.
- **Sonnet** — the default: normal bug fixes, tests, CI, well-scoped card
  or proxy features.
- **Opus** — architectural surface: card lifecycle/teardown, playback
  concurrency, proxy hardening, ambiguous root-cause hunting, anything
  ADR-worthy.

## Architectural decisions

If a change introduces a new pattern, breaks a module boundary, changes
the proxy allowlist or a quality gate, or deviates from an existing ADR,
it needs an ADR. Triggers and the template are in
[`docs/adr/README.md`](docs/adr/README.md). Land the ADR with the code.

Claude Code users in this clone get automatic prompts via the repo-local
skills below. Other tools should read `docs/adr/README.md` directly.

## Repo-local skills

Two Claude Code skills are checked into `.claude/skills/`:

- **`commit-guardian`** — before any `git commit`, checks the staged diff
  against accepted ADRs and the conventions here. Reports a numbered
  list; the user decides. Non-blocking.
- **`documentation-guardian`** — proposes an ADR when an architectural
  change happens and flags changes that contradict an existing decision.

They auto-load for Claude Code in this clone. Other AI tools should read
the `SKILL.md` files directly to pick up the conventions.

## Parallel work

- **Branch naming**: `<tool-or-initials>/<issue>-<slug>`, e.g.
  `claude/3-map-teardown`. Makes authorship visible without a team
  agreement.
- **Issue claiming**: `gh issue edit <N> --add-assignee @me` before
  starting, so parallel contributors see it is taken.
- **Worktrees**: parallelize along file boundaries, not per issue. The
  card is one file; card issues collide if edited in parallel. Split
  lanes as card-JS / proxy-Python / tests, one worktree each:
  `git worktree add ../msr-<issue> <branch>`.

## Draft PRs

CI (hassfest + HACS + Python lint/tests + card syntax/tests) runs on
every push. If you iterate with several pushes, open the PR as a
**draft** until you expect CI to pass, then mark ready. Direct push to
`master` is not the flow; open a PR.

## Testing

- **Card decoder**: `npm test` (vitest). The pure decoder functions are
  loaded out of the shipped card via a vm shim, so tests hit the real
  code without a build step. Golden geometry is snapshotted; regenerate
  with `npm test -- -u` only after verifying against live data.
- **Card syntax**: `npm run check` (`node --check`).
- **Integration metadata**: `pytest` (stdlib only, no HA). Full proxy
  behavior tests against `pytest-homeassistant-custom-component` are
  tracked as a separate issue.
- **Lint**: `ruff check custom_components tests`.
