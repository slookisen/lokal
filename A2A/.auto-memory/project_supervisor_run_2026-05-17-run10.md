# Supervisor Run-10 — 2026-05-17 (21:45-21:55Z)

## State at finish
- **Prod git_sha:** `771cdacabd02d10bd60ebb66afb0c4e036b7aa68` (= revert of PR-79 merge; functionally identical to `fe13c9f` = `ccac896` = PR-78 content)
- **Fly release:** v401 (deployed 21:53:31Z)
- **Health:** healthy, warnings=[], 1447 agents, mem 33%

## What happened
- Picked up new orchestrator runbook (`pr-79-mutex-batch-runbook.md`) — 5-PR batch starting with PR-79 mutex refactor
- Deployed PR-79 (test-only, tests/test.ts +167/-113); local 1466/0 pass; CI 1443/23 fail
- NEW race-class: mutex serializes the queue but doesn't reset getDb() singleton between slots. Tests in mutex blocks see stale/empty DB.
- Reverted, prod restored on 771cdac, all probes green
- 4 dependent PRs (71-iter5, 69-v4, 70-v4, 77-v3) deferred

## Key learning
Mutex pattern fixes simultaneity of __setDbForTesting calls but NOT lifecycle of getDb() singleton across blocks. v2 must own both.
Validation: run determinism IN CI (not just locally) before declaring v2 ready.

## Day 7 cumulative (through Run 10)
- 21 PRs processed
- 9 deployed (unchanged from Run 9)
- 10 CI rejections (was 9)
- 8 deferred (was 4)
- 5 race-class CI failures across Runs 6/8/9/10

## Disk
/ at 99% (181M free). /sessions healthy at 47% (5G free). Suggest Cowork restart.
