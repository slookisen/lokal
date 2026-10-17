#!/usr/bin/env bash
# Decides whether .github/workflows/fly-deploy.yml deploys NOW or waits for a deploy window.
# Pure function of env vars (no network), so it can be tested: scripts/test-deploy-window-decision.sh
#
# Inputs (env):
#   EVENT           push | workflow_dispatch | schedule
#   ACTOR           github.actor (the pusher)
#   SUBJECT         commit subject line
#   PR_LOOKUP       ok | failed          (result of the commits/{sha}/pulls API call)
#   PR_MERGED_BY    newline list of merged_by.login of PRs associated with the commit
#   PR_LABELS       newline list of label names on those PRs
#   PR_COUNT        number of associated PRs
#   NOW_HHMM        current UTC time as HHMM (e.g. 0645)
#   LIVE_SHA        prod /health.git_sha ("" if unknown)
#   THIS_SHA        commit being considered (schedule: main HEAD)
#
# Output: one line "deploy=true|false reason=<text>" on stdout. Always exit 0.
#
# Note: the fleet gate (fleet-auto-approve.yml) merges as github-actions[bot], so
# fleet merges never match the "merged by Daniel" rule and wait for the window.
set -u
DANIEL="slookisen"
out() { echo "deploy=$1 reason=$2"; exit 0; }

case "${EVENT:-}" in
  workflow_dispatch) out true "manual workflow_dispatch" ;;
  schedule)
    # Never inside the 06:30-09:30 UTC send window (cron times already avoid it).
    hhmm=$((10#${NOW_HHMM:-0}))
    if [ "$hhmm" -ge 630 ] && [ "$hhmm" -lt 930 ]; then
      out false "schedule inside 06:30-09:30 UTC send window"
    fi
    if [ -n "${LIVE_SHA:-}" ] && [ "$LIVE_SHA" = "${THIS_SHA:-}" ]; then
      out false "schedule: prod already runs main HEAD"
    fi
    out true "schedule window: main HEAD differs from prod (${LIVE_SHA:-unknown})" ;;
  push)
    case "${SUBJECT:-}" in
      'Revert "'*) out true "revert commit" ;;
    esac
    if [ "${PR_LOOKUP:-failed}" != "ok" ]; then
      echo "::warning::PR lookup failed; failing open and deploying" >&2
      out true "PR lookup failed (fail-open)"
    fi
    if printf '%s\n' "${PR_MERGED_BY:-}" | grep -qxF "$DANIEL"; then
      out true "PR merged by $DANIEL"
    fi
    if printf '%s\n' "${PR_LABELS:-}" | grep -qxF "deploy-nå"; then
      out true "PR has label deploy-nå"
    fi
    if [ "${PR_COUNT:-0}" = "0" ] && [ "${ACTOR:-}" = "$DANIEL" ]; then
      out true "direct push by $DANIEL, no PR"
    fi
    out false "waiting for deploy window" ;;
  *) out true "unknown event '${EVENT:-}' (fail-open)" ;;
esac
