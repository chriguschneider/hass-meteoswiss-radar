#!/usr/bin/env bash
# Pick the Claude model for an issue from its labels.
#
# Matrix (see AGENTS.md → Model selection):
#   P1                       -> Opus   (critical; often lifecycle / concurrency / architecture)
#   P3 or "good first issue" -> Haiku  (trivial / mechanical)
#   everything else          -> Sonnet (the default workhorse)
#
# Usage: pick-model.sh <issue-number>
# Prints `model=<id>` on stdout (append to $GITHUB_OUTPUT); diagnostics on stderr.
set -euo pipefail

issue="${1:?usage: pick-model.sh <issue-number>}"

labels="$(gh issue view "$issue" --json labels --jq '[.labels[].name] | join(",")')"

model="claude-sonnet-4-6" # default
case ",$labels," in
  *,P1,*)                         model="claude-opus-4-8" ;;
  *,P3,* | *,"good first issue",*) model="claude-haiku-4-5" ;;
esac

echo "issue #$issue labels=[$labels] -> $model" >&2
echo "model=$model"
