#!/usr/bin/env bash
# Emit the next open issue to work on, in priority order (P1 > P2 > P3).
#
# Skips: issues already assigned to someone, issues carrying the
# `agent:in-progress` label (claimed by a previous run), and the tracking
# issue (title starting "Tracking:"). Within a priority, lowest number first.
#
# Prints `number=<n>` (empty if nothing eligible) on stdout; append to
# $GITHUB_OUTPUT. Diagnostics on stderr.
set -euo pipefail

issues="$(gh issue list --state open --limit 100 \
  --json number,title,labels,assignees)"

pick() {
  local prio="$1"
  printf '%s' "$issues" | jq -r --arg prio "$prio" '
    map(select(.assignees | length == 0))
    | map(select([.labels[].name] | index("agent:in-progress") | not))
    | map(select(.title | test("^Tracking:") | not))
    | map(select([.labels[].name] | index($prio)))
    | sort_by(.number)
    | (.[0].number // empty)'
}

number=""
for prio in P1 P2 P3; do
  number="$(pick "$prio")"
  if [ -n "$number" ]; then
    echo "next eligible issue: #$number ($prio)" >&2
    break
  fi
done

[ -z "$number" ] && echo "no eligible issue found" >&2
echo "number=$number"
