#!/usr/bin/env bash
# Decides whether .github/workflows/fly-deploy.yml deploys NOW or waits for a deploy window.
# Pure function of env vars (no network), so it can be tested: scripts/test-deploy-window-decision.sh
#
# Inputs (env):
#   EVENT           push | workflow_dispatch | schedule
#   ACTOR           github.actor (the pusher / dispatcher)
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
# Note on the fleet gate (fleet-auto-approve.yml): it merges under GITHUB_TOKEN,
# which fires no push event, so it then calls createWorkflowDispatch on
# fly-deploy.yml. That run arrives as EVENT=workflow_dispatch with
# ACTOR=github-actions[bot]. Such a dispatch is NOT a manual deploy: it is
# evaluated with the same rules as a push of THIS_SHA (revert / merged by
# Daniel / label deploy-nå / PR lookup fail-open), so a fleet merge waits for
# the window unless one of those rules matches. A dispatch by anyone else
# (including an empty/unknown actor) counts as manual and deploys now.
set -u
DANIEL="slookisen"
BOT="github-actions[bot]"
out() { echo "deploy=$1 reason=$2"; exit 0; }

# Rules for a merged commit (push, or the gate's post-merge dispatch).
# $1: label prefix for the reason text ("" for push).
merged_commit_rules() {
  local p=$1
  case "${SUBJECT:-}" in
    'Revert "'*) out true "${p}revert commit" ;;
  esac
  if [ "${PR_LOOKUP:-failed}" != "ok" ]; then
    echo "::warning::PR lookup failed; failing open and deploying" >&2
    out true "${p}PR lookup failed (fail-open)"
  fi
  if printf '%s\n' "${PR_MERGED_BY:-}" | grep -qxF "$DANIEL"; then
    out true "${p}PR merged by $DANIEL"
  fi
  if printf '%s\n' "${PR_LABELS:-}" | grep -qxF "deploy-nå"; then
    out true "${p}PR has label deploy-nå"
  fi
  if [ "${PR_COUNT:-0}" = "0" ] && [ "${ACTOR:-}" = "$DANIEL" ]; then
    out true "${p}direct push by $DANIEL, no PR"
  fi
  out false "${p}waiting for deploy window"
}

case "${EVENT:-}" in
  workflow_dispatch)
    if [ "${ACTOR:-}" = "$BOT" ]; then
      merged_commit_rules "gate dispatch: "
    fi
    out true "manual workflow_dispatch" ;;
  schedule)
    # Never inside the 06:30-09:30 UTC send window (cron times already avoid it).
    case "${NOW_HHMM:-}" in
      [0-9][0-9][0-9][0-9]) ;;
      *) out true "NOW_HHMM unparseable ('${NOW_HHMM:-}') (fail-open)" ;;
    esac
    hhmm=$((10#$NOW_HHMM))
    if [ "$hhmm" -ge 630 ] && [ "$hhmm" -lt 930 ]; then
      out false "schedule inside 06:30-09:30 UTC send window"
    fi
    if [ -n "${LIVE_SHA:-}" ] && [ "$LIVE_SHA" = "${THIS_SHA:-}" ]; then
      out false "schedule: prod already runs main HEAD"
    fi
    out true "schedule window: main HEAD differs from prod (${LIVE_SHA:-unknown})" ;;
  push) merged_commit_rules "" ;;
  *) out true "unknown event '${EVENT:-}' (fail-open)" ;;
esac
