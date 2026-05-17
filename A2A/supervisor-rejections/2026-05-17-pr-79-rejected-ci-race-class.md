# Rejection — PR-79 mutex refactor — CI race-class regression

**PR:** orchestrator-pr-79 (mutex refactor for tests/test.ts)
**Branch:** feature/orch-pr-79-testdb-mutex (HEAD 920cb96)
**Merge commit:** 026a671 (pushed 21:50Z, reverted 21:52Z as 771cdac)
**CI run:** https://github.com/slookisen/lokal/actions/runs/26003713758

## Local validation (PASSED)
- `npx tsc --noEmit`: clean
- `npm test`: 1466 passed, 0 failed (1 local run after merge)

## CI result (FAILED)
- tsc: passed
- npm test: **1443 passed, 23 failed**
- Failure pattern: tests that mutex was supposed to serialize (phase5.11-a4.1, phase5.11-a4.4, pr67, pr72) failed in CI despite passing locally

## Failed test groups
1. **phase5.11-a4.1** (5 tests): umbrella exclusion — getActiveAgents/getStats/discover all returning wrong agent counts
2. **phase5.11-a4.4** (4 tests): getAgentBySlugIncludingUmbrellas returning undefined for known-good slugs
3. **pr67** (9 tests): re-classify scan returns 0 rows where 2 expected — re-classify pipeline sees empty DB
4. **pr72** (5 tests): discover relevance — fish+Bergen / honey+Oslo queries return empty

## Diagnosis

The mutex eliminated the `__setDbForTesting` race-class **between** sequential blocks but introduced (or did not solve) a **DB state leakage** between blocks that share the test runner process. The failing tests all expect specific DB rows from their own `setupDb` callback — but in CI they see either an empty DB or rows from a prior block's mutex slot.

Hypothesis: `withTestDb(label, setupDb, fn)` is releasing the mutex but the next block's `setupDb` doesn't fully rebind a fresh DB because the underlying `getDb()` singleton holds a stale reference to the previous test DB. Locally the in-memory DB tear-down is fast enough that this isn't observed; CI's slower process tickles the race.

This is **not the same** race-class as PR-71 iter-4 / PR-69 v3 / PR-70 v3 (which were pre-mutex). This is a **new race-class** introduced by the mutex itself.

## Action taken
- Reverted merge: `026a671` → `771cdac` (revert pushed; CI green; Fly deployed at 21:53:31Z)
- Verified prod health post-revert: status=healthy, warnings=[], A2A completed, marketplace search success, Oppsal still returns Oslo (59.886, 10.879) per PR-78.

## Dependent PRs (deferred, not attempted this cycle)
- **PR-71 iter-5** (`feature/orch-pr-71-bm-lokallag-iter5`): rebased onto PR-79; cannot land until PR-79 fixed or replaced
- **PR-69 v4** (`feature/orch-pr-69-hanen-yield-lift-v4`): same
- **PR-70 v4** (`feature/orch-pr-70-debio-finnoko-source-v4`): same
- **PR-77 v3** (`feature/orch-pr-77-bm-venue-affiliations-v3`): chained on PR-71 iter-5

## Required next step (escalated to orchestrator)

Orchestrator needs to file a PR-79 v2 that **also** resets the `getDb()` singleton inside `withTestDb` (or makes every test block call `__resetDbSingleton()` before its `setupDb`). The mutex must own BOTH the FIFO queue AND the DB-singleton lifecycle. Suggested skeleton:

```ts
async function withTestDb(label: string, setup: () => DB, fn: () => Promise<void>) {
  await _lastTestDbPromise;
  _lastTestDbPromise = (async () => {
    __resetDbSingleton();         // <- NEW: clear singleton before setup
    const db = setup();
    __setDbForTesting(db);
    try { await fn(); }
    finally {
      __setDbForTesting(undefined);
      __resetDbSingleton();       // <- NEW: clear singleton after teardown
    }
  })();
  await _lastTestDbPromise;
}
```

Run determinism check **in CI** (not locally) before re-filing — file 5 empty-commit re-runs on the PR-79 v2 SHA and confirm all 5 are green before declaring it ready.

## Cycle status
- **0 PRs deployed.** Run-10 cycle stopped after PR-79 rejection.
- 4 dependent PRs (71 iter-5, 69 v4, 70 v4, 77 v3) deferred without attempt.
- Per SKILL §"Hvis 3+ PR-er feiler på samme race-mønster" — cycle escalation continues. PR-79 is now the 5th race-class CI failure in Day 7.

**Filed:** 2026-05-17T21:55Z
