# Agent automation

Two ways Claude works on this repo's issues automatically. Both open **draft
PRs only** and never push to `master` (branch protection enforces this). The
model is chosen per issue from its labels.

## Model selection (both flows)

`.github/scripts/pick-model.sh <issue>` maps labels to a model:

| Label on the issue | Model |
|---|---|
| `P1` | `claude-opus-4-8` (critical; lifecycle / concurrency / architecture) |
| `P3` or `good first issue` | `claude-haiku-4-5` (trivial / mechanical) |
| anything else (`P2`, `tests`, `release`, unlabelled) | `claude-sonnet-4-6` (default) |

## 1. Scheduled backlog (`claude-scheduled.yml`)

Cron every 6 hours (plus a manual "Run workflow" button). Each run:

1. picks the next open issue in priority order (`pick-next-issue.sh`: P1 > P2 >
   P3, skips assigned issues, issues labelled `agent:in-progress`, and the
   tracking issue),
2. claims it with the `agent:in-progress` label so the next run skips it,
3. implements it on a `claude/<n>-<slug>` branch and opens a **draft** PR.

The clock only says "go" — the workflow itself figures out *which* issue via the
labels and the tracking issue. Change the cadence by editing the `cron` line.

## 2. On @claude mention (`claude-mention.yml`)

Event-driven. Write `@claude ...` in an issue or PR comment (or assign an issue)
and Claude picks up *that* issue, using the model its labels imply.

## Required one-time setup (maintainer)

These automations need Anthropic credentials the repo doesn't have yet:

1. **Install the Claude GitHub App** on this repo (grants the action its
   permissions): <https://github.com/apps/claude>.
2. **Add a repository secret** `ANTHROPIC_API_KEY` (Settings → Secrets and
   variables → Actions), or swap the workflows to
   `claude_code_oauth_token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}`.

Until the secret exists, the workflows run but the Claude step fails — no
changes are made. Everything else (issue picking, labelling) is harmless.

## Guardrails

- Draft PRs only; **merge stays manual** (you).
- One issue per scheduled run; priority + tracking-issue order.
- Ambiguous issue → the agent opens a draft with a "Blocked / needs decision"
  note instead of guessing.
