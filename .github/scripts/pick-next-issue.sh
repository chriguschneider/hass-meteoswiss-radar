#!/usr/bin/env bash
# Emit the next open issue for the autopilot, in priority order (P1 > P2 > P3).
#
# Only issues carrying a P-label are eligible (so tests/CI/tracking issues
# without one are left for a human). Skips: the tracking issue, and issues
# already flagged `agent:go`, `agent:in-progress` or `needs-verification`.
# Lowest number first within a priority.
#
# Prints `number=<n>` (empty if nothing eligible) on stdout.
set -euo pipefail

issues="$(gh issue list --state open --limit 100 \
  --json number,title,labels,assignees)"

pick() {
  local prio="$1"
  printf '%s' "$issues" | jq -r --arg prio "$prio" '
    map(select(.assignees | length == 0))
    | map(select([.labels[].name] | any(. == "agent:in-progress" or . == "agent:go" or . == "needs-verification") | not))
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
