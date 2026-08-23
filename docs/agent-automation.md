# Agent automation (opt-in)

Claude works an issue **only when you hand it over** — this repo is not
ground through automatically. Both flows open **draft PRs only** and never
push to the default branch.

## Opt-in by label (`claude-labeled.yml`)

Add the **`agent:go`** label to an issue → Claude implements it on a
`claude/<n>-<slug>` branch and opens a draft PR. Issues without the label
are never touched.

- `gh issue edit <n> --add-label agent:go` (or add it in the UI).
- Manually: Actions → "Claude (opt-in via label)" → Run workflow → issue number.
- On failure the `agent:go` label is removed so it isn't left looking claimed.

## On @claude mention (`claude-mention.yml`)

Write `@claude ...` in an issue or PR comment. Gated to the owner /
collaborators (comment events carry secrets, so strangers can't trigger it).

## Model per issue

`.github/scripts/pick-model.sh` chooses the model from labels:

| Label | Model |
|---|---|
| `agent:opus` | `claude-opus-4-8` |
| `agent:haiku` | `claude-haiku-4-5` |
| `agent:sonnet` / (none) | `claude-sonnet-4-6` |
| `P1` | `claude-opus-4-8` |
| `P3` / `good first issue` | `claude-haiku-4-5` |

## Guardrails

- Draft PRs only; **merge stays manual**.
- The agent **cannot change `.github/workflows/`** (token lacks `workflows`
  permission) — a deliberate safety boundary; it documents such changes for
  a human instead.
- Ambiguous issue → draft with a "Blocked / needs decision" note, no guessing.

## Setup (one-time)

Install the Claude GitHub App and add the repo secret
`CLAUDE_CODE_OAUTH_TOKEN` (`claude setup-token`).
