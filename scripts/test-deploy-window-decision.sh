#!/usr/bin/env bash
# Run: bash scripts/test-deploy-window-decision.sh   (exit 0 = all pass)
D="$(dirname "$0")/deploy-window-decision.sh"
fail=0
t() { # name expected-deploy  VAR=val...
  local name=$1 exp=$2; shift 2
  local got; got=$(env -i PATH="$PATH" "$@" bash "$D" 2>/dev/null | sed -E 's/^deploy=([a-z]+).*/\1/')
  if [ "$got" = "$exp" ]; then echo "ok   $name"; else echo "FAIL $name (want $exp got $got)"; fail=1; fi
}
P="EVENT=push PR_LOOKUP=ok PR_COUNT=1 SUBJECT=feat:x"
t "Daniel-merged PR"        true  $P PR_MERGED_BY=slookisen
t "deploy-nå label"         true  $P PR_MERGED_BY=github-actions[bot] "PR_LABELS=$(printf 'fleet\ndeploy-nå')"
t "revert subject"          true  EVENT=push PR_LOOKUP=ok PR_COUNT=1 'SUBJECT=Revert "feat: x" (#9)' PR_MERGED_BY=github-actions[bot]
t "fleet-merged PR waits"   false $P PR_MERGED_BY=github-actions[bot] PR_LABELS=fleet
t "label lookalike waits"   false $P PR_MERGED_BY=github-actions[bot] PR_LABELS=deploy-nåx
t "direct push Daniel noPR" true  EVENT=push PR_LOOKUP=ok PR_COUNT=0 ACTOR=slookisen SUBJECT=x
t "direct push other noPR"  false EVENT=push PR_LOOKUP=ok PR_COUNT=0 ACTOR=someone SUBJECT=x
t "Daniel pushes but PR by bot" false $P ACTOR=slookisen PR_MERGED_BY=github-actions[bot]
t "API failure fail-open"   true  EVENT=push PR_LOOKUP=failed SUBJECT=x
t "manual dispatch"         true  EVENT=workflow_dispatch
B="EVENT=workflow_dispatch ACTOR=github-actions[bot] PR_LOOKUP=ok PR_COUNT=1 SUBJECT=feat:x"
t "bot dispatch fleet waits"   false $B PR_MERGED_BY=github-actions[bot] PR_LABELS=fleet
t "bot dispatch revert"        true  EVENT=workflow_dispatch ACTOR=github-actions[bot] PR_LOOKUP=ok PR_COUNT=1 'SUBJECT=Revert "x"' PR_MERGED_BY=github-actions[bot]
t "bot dispatch Daniel-merged" true  $B PR_MERGED_BY=slookisen
t "bot dispatch deploy-nå"     true  $B PR_MERGED_BY=github-actions[bot] PR_LABELS=deploy-nå
t "bot dispatch lookup failed" true  EVENT=workflow_dispatch ACTOR=github-actions[bot] PR_LOOKUP=failed SUBJECT=x
t "bot dispatch no PR waits"   false EVENT=workflow_dispatch ACTOR=github-actions[bot] PR_LOOKUP=ok PR_COUNT=0 SUBJECT=x
t "human dispatch (Daniel)"    true  EVENT=workflow_dispatch ACTOR=slookisen
t "dispatch empty actor"       true  EVENT=workflow_dispatch ACTOR=
t "schedule equal SHA"      false EVENT=schedule NOW_HHMM=1400 LIVE_SHA=abc THIS_SHA=abc
t "schedule unequal SHA"    true  EVENT=schedule NOW_HHMM=1400 LIVE_SHA=abc THIS_SHA=def
t "schedule live unknown"   true  EVENT=schedule NOW_HHMM=1900 LIVE_SHA= THIS_SHA=def
t "schedule in send window" false EVENT=schedule NOW_HHMM=0800 LIVE_SHA=abc THIS_SHA=def
t "schedule 10:00 ok"       true  EVENT=schedule NOW_HHMM=1000 LIVE_SHA=abc THIS_SHA=def
t "schedule NOW_HHMM junk"  true  EVENT=schedule NOW_HHMM=xx LIVE_SHA=abc THIS_SHA=abc
t "schedule NOW_HHMM empty" true  EVENT=schedule LIVE_SHA=abc THIS_SHA=abc
exit $fail
