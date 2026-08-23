#!/usr/bin/env bash
# Pick the Claude model for an issue from its labels.
#
# Explicit override wins: agent:opus / agent:sonnet / agent:haiku force it.
# Otherwise P1 -> Opus, P3 / good first issue -> Haiku, else the default.
#
# Usage: pick-model.sh <issue-number>. Prints `model=<id>` on stdout.
set -euo pipefail

issue="${1:?usage: pick-model.sh <issue-number>}"
labels="$(gh issue view "$issue" --json labels --jq '[.labels[].name] | join(",")')"

model="claude-sonnet-4-6" # default workhorse
case ",$labels," in
  *,agent:opus,*)                  model="claude-opus-4-8" ;;
  *,agent:haiku,*)                 model="claude-haiku-4-5" ;;
  *,agent:sonnet,*)                model="claude-sonnet-4-6" ;;
  *,P1,*)                          model="claude-opus-4-8" ;;
  *,P3,* | *,"good first issue",*) model="claude-haiku-4-5" ;;
esac

echo "issue #$issue labels=[$labels] -> $model" >&2
echo "model=$model"
