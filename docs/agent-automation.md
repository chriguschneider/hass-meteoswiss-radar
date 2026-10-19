# Agent automation (opt-in)

Claude works an issue **only when you hand it over** (or, in autopilot
mode, when it takes the next P-labelled issue). All flows open **draft PRs
only** and never push to the default branch. Every workflow skips itself
with a notice while the `CLAUDE_CODE_OAUTH_TOKEN` secret is missing, so a
fresh setup is never red.

This repo runs in mode **`autopilot`**:

| Mode | Label + mention | Reviewer + auto-merge | Autopilot |
|---|:-:|:-:|:-:|
| `minimal` | ✓ | – | – |
| `opt-in` | ✓ | ✓ | – |
| `autopilot` | ✓ | ✓ | ✓ |

## Opt-in by label (`claude-labeled.yml`)

Add the **`agent:go`** label to an issue → Claude implements it on a
`claude/<n>-<slug>` branch and opens a draft PR. Issues without the label
are never touched by this flow.

- `gh issue edit <n> --add-label agent:go` (or add it in the UI).
- Manually: Actions → "Claude (opt-in via label)" → Run workflow → issue number.
- On failure the `agent:go` label is removed so it isn't left looking claimed.
- **Only trusted issue text is worked.** The issue becomes the agent's
  instructions, so an issue written by someone without write access is
  refused with a comment (and the label removed). Restate the task in your
  own issue, or add `agent:untrusted-ok` after reading the text yourself.

## On @claude mention (`claude-mention.yml`)

Write `@claude ...` in an issue or PR comment. Gated to the owner /
collaborators: comment events carry secrets even from strangers. Only the
owner's and the agent's own comments reach the prompt
(`include_comments_by_actor`).

## Model per issue

`.github/scripts/pick-model.sh` chooses the model from labels. It passes
aliases, so the latest model of each family is used without edits here.

| Label | Model |
|---|---|
| `agent:opus` | `opus` |
| `agent:haiku` | `haiku` |
| `agent:sonnet` / (none) | `sonnet` |
| `P1` | `opus` |
| `P3` / `good first issue` | `haiku` |

## Guardrails

The agent reads text written by others (issues, comments, PR titles, code)
and runs with write access. Every public attack on agent workflows in
2025/26 combined exactly that with an unrestricted shell. So the shell is
restricted, and several layers hold even if the model is talked into
something:

| Layer | What it does | Where |
|---|---|---|
| Tool allowlist | `--permission-mode dontAsk` plus `--allowedTools`: git, a few `gh` subcommands and the repo's own check commands (`pip install ruff pytest`, `ruff check`, `pytest`, `npm ci`, `npm run check`, `npm test`, `npx vitest`). Anything else is refused without a prompt. No `--dangerously-skip-permissions`. | `claude_args` in each workflow |
| Deny rules | `gh api`, `gh secret`, `gh workflow`, `gh repo`, `curl`, `wget`, force pushes, and here also `gh release`, `gh issue edit` and `gh issue close`: the committed `.claude/settings.json` allows those for local release work, and project settings load in CI too. Deny always wins. | `.claude/ci-settings.json` |
| Path guard hook | Blocks every write to `.github/` and `.claude/`, through file tools or the shell. Runs only on GitHub Actions; local sessions are unaffected. | `.claude/hooks/protect-paths.py` |
| Trusted text only | Untrusted issues are refused, foreign comments are filtered out, the autopilot only takes issues written by the owner. | job `if:`, `include_comments_by_actor`, `pick-next-issue.sh` |
| Egress | harden-runner logs (mode `audit`) or blocks (mode `block`) outbound connections. | first step of each agent job |
| Pinned actions | Every `uses:` is a full commit SHA; Dependabot bumps it after a 7-day cooldown (not for claude-code-action, whose updates are security fixes). | all workflows, `dependabot.yml` |
| Reviewer reads CI | The reviewer never runs the PR's tests or scripts (the PR could change them, and the job holds secrets); CI runs them without secrets. | `claude-review.yml` |
| Sensitive paths | A PR touching `.github/`, `.claude/`, `scripts/`, `docs/adr/`, `AGENTS.md`, dependency files, `manifest.json`, `hacs.json`, the vendored Leaflet (`frontend/vendor/`) or `sonar-project.properties` is never auto-merged, whatever the model decided. | last steps of `claude-review.yml` |

The action restores `.claude/` from the base branch on pull requests, so a
PR cannot switch off the settings or the hook.

**About the `workflows` permission:** the official Claude GitHub App is
installed with Workflows read/write, and a token obtained in a January 2026
attack (CVE-2025-66032) carried that permission. In earlier runs of this
setup a push to `.github/workflows/` was rejected with 403, but that is not
a guarantee. The hook above is the boundary that does not depend on how
the token is scoped.

**Switching egress to `block`:** after a few agent runs, open a run's
harden-runner insights (link in the job summary), compare the endpoints
with `allowed-endpoints`, add what is missing, then set
`egress-policy: block` in the agent workflows (or render with
`--set EGRESS_POLICY=block`).

Other rules:

- The prompts tell the agent to follow `AGENTS.md` (above all its
  *Non-negotiables from the ADRs*), `docs/adr/`, `docs/upstream.md` and
  `FORMAT.md`, to treat issue text as a description of a change
  rather than instructions, to stop if the issue is closed or already has
  an open PR, and never to invent domain data (every lookup table or
  constant cites a source).
- **Changes only a human may make** (`.github/`, `.claude/`): the agent
  writes `Refs #N` instead of `Closes #N` and a `## Human-only change`
  section with the exact diff. The reviewer then holds the PR and opens a
  follow-up issue, so that half does not get lost when the rest merges.
- **The agent reports how it ended.** The last line of the PR description
  is `Agent status: done` or `Agent status: blocked`. The action's exit
  status is not used for this: a finished run can still fail for going a
  few turns over the limit.
- **Runs are capped** at 100 turns (mention: 60) and 60 minutes. The agent
  pushes early and opens the draft PR after its first commit. After every
  run, `after-agent-run.sh` commits and pushes what is left and reads the
  status line:

  | Ends with | Then |
  |---|---|
  | `Agent status: done` | the reviewer is started (`gh workflow run claude-review.yml`) |
  | `Agent status: blocked` | the PR gets `needs-verification`, a human decides |
  | no status line | the PR gets **`agent:needs-continuation`**; continue with `@claude continue` or by hand |
  | nothing committed, run failed | the *issue* gets `needs-verification` and a comment to split it, so the autopilot does not retry it forever |

  Its pushes use the workflow token, so they trigger neither CI nor the
  reviewer: unfinished work is never auto-merged.

## Sizing an issue

Most failed runs in the repos this standard comes from were issues that
were too big, not too hard. A run that hits the limit before its first
commit leaves nothing; the same issue then fails again. Use the *Agent
task* issue template and keep to:

- **One layer per issue** (client, entities, config flow, card editor ...),
  at most about four modules.
- **Measuring and deciding happen first, by hand.** Upstream measurements
  (`docs/upstream.md`), the ADR and real fixtures land in a maintainer PR;
  the agent issues only implement.
- **Name the files and the exact tests** that prove it, and what is out of
  scope (no network in tests, no new ADR, no new dependency).
- **Slices of one feature** are titled "Feature (N/M)" and given P-labels
  in order, only when the previous slice is merged.
- **A repo needs a test suite before `agent:go` makes sense.** Without
  tests the agent cannot verify anything, and the reviewer cannot either.
- Research logs and wish lists get the label **`tracking`**: no agent and
  no autopilot ever works them.

## Automated review + auto-merge (`claude-review.yml`)

An **independent Opus reviewer** runs on agent PRs (`claude/*` branches of
this repository; a contributor's fork PR with the same prefix is ignored).
It starts when the author agent reports `Agent status: done`, or when a
human marks an agent PR ready. Not when the draft opens: the agent opens
it early and keeps working. Its own `gh pr ready` does not start a second
review. It first waits for the required checks, then reviews the diff adversarially
against `AGENTS.md` and the ADRs, reads the CI result (it does not run the
checks itself), fixes substantive problems on the branch (**at most 3
rounds**; CI re-runs on its pushes), then either:

- **auto-merges** (`gh pr merge --auto --squash`) when green and solid, or
- **holds for you** when the change needs a human decision or a live
  check, when the PR or its issue carries **`needs-verification`**, or when
  it could not make the change solid — it labels the PR
  `needs-verification` and comments exactly what to check.

In this repo card, rendering and UI changes are auto-merged on green CI
like any other change; the reviewer holds only what tests cannot judge
(touch/pointer gestures, real device input, exact pixel output without
test coverage, card config keys and entity names users depend on).
Reviewer = Opus, author = whatever the labels pick, so nothing grades its
own work.

Whatever the model decided, a PR that touches sensitive paths or carries a
`## Human-only change` is then held with `needs-verification`. A review run
that dies (turn limit, error) labels the PR too, instead of leaving it
open without a label. After that the job waits for the required checks; if
one fails after auto-merge was armed, the PR gets `needs-verification` and
a comment naming the check, instead of sitting silently.

## A red default branch (`ci-watch.yml`)

CI also runs weekly, so tool or upstream drift shows up without commits.
When CI fails on `master`, `ci-watch.yml` opens one issue "CI is red on
master" (no P-label, so no agent picks it up) and closes it when CI is
green again. In types with tag releases, `release.yml` refuses a tag whose
commit has no green CI run.

Auto-merge needs branch protection with required checks on
`master`. Without it (private repo on a free plan) use mode `minimal`.

## Autopilot (`claude-autopilot.yml`, mode `autopilot` only)

After every closed PR, completed CI/review run, issue label change and on
a cron at :13/:43 — **if no agent PR is open** — it takes the next open
P-issue written by the repo owner (P1 before P2 before P3, lowest number
first). Skips issues whose title starts with `Tracking:`, anything
assigned, and anything labelled `agent:go`, `agent:in-progress`,
`needs-verification` or `tracking`. An open agent PR from this repository
blocks it; the job summary names which one. Pause it by
disabling the workflow; kick it with `gh workflow run claude-autopilot.yml`.

Give an issue a P-label only when its prerequisites are merged, or the
agent will hit a missing dependency and open a "Blocked" draft.

## Setup (one-time, by the owner)

1. Install the Claude GitHub App on this repository
   (https://github.com/apps/claude), or extend the existing installation
   under https://github.com/settings/installations.
2. `gh secret set CLAUDE_CODE_OAUTH_TOKEN -R chriguschneider/hass-meteoswiss-radar`
   (token from `claude setup-token`; never paste it into a chat).
3. SonarCloud: the project exists and `SONAR_TOKEN` is set (ADR-0007);
   fork PRs skip the scan and are analysed on `master` after merge.
4. Labels from repo-standard's `labels.json` (`agent:needs-continuation`,
   `agent:untrusted-ok` and `tracking` are the ones this repo was missing):
   `python3 github-setup.py --repo chriguschneider/hass-meteoswiss-radar --type ha-integration --only labels`.
