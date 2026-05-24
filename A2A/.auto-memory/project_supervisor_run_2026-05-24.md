# Project Supervisor Run — 2026-05-24

**Cycle:** scheduled 12:05 CEST (~30 min late dispatch — actual start 10:35:26Z / 12:35 CEST)
**Type:** DEPLOY (PR-87)

## Deployed

- **Commit:** `42b647a31dfe46b3e26c22b71198a1e949e018c7` (merge of PR-87 `feature/orch-pr-87-systematic-sweep` into main)
- **Fly release:** **v423** (`registry.fly.io/lokal:deployment-…`)
- **Boot:** 2026-05-24T10:40:46.074Z (Probe 1 confirmed git_sha match)
- **Strategy:** rolling, `--build-arg BUILD_REV=42b647a…` for cache-bust
- **Pre-deploy:** prod was at `9690fc2` / Fly v422 (marketing-comms autonomous SEO commit, CI-deployed at 07:25Z)

## What shipped (PR-87)

1. `pickBatchBiased` — 70/30 split favouring growth-reservoir (pending_verify + review_required + data_insufficient)
2. `agent_knowledge.sweep_round` + `sweep_processed_at` columns (additive, idempotent ALTERs)
3. `GET /admin/verifier/sweep-status` (admin-key gated, same pattern as `admin-run-verifier.ts`)
4. `bias_growth` flag on `/admin/run-verifier` (default 1; `bias_growth=0` opt-out preserves legacy `pickBatch`)

## Validation evidence

- tsc clean on PR branch + on merge commit
- npm test 1544/1544 passed (was 1521 baseline)
- code-reviewer APPROVED iter 2 (forced fix to iter 1's dead-code bug — real prod-bug not just a test gap)
- Daniel pre-approved in-chat 2026-05-23

## Probe-3 (per-commit assertions) results

- `GET /admin/verifier/sweep-status` → 200, `{ success:true, agents_total:1417, current_round:0, … }` (matches deploy-plan expectations)
- `POST /admin/run-verifier` without key → 403 (auth gate intact)
- agent-card + MCP server-card unchanged

## Items learned this cycle

- The 4.15-style `/tmp/repo-work` directory from a prior cycle had stale-ownership/permission issues (Permission denied on rm). Workaround: clone into a fresh `/tmp/sup-$(date +%s)/repo` dir instead of reusing /tmp/repo-work. Daniel cleanup item: `rm -rf /tmp/sup-* /tmp/repo-work` (or just ignore — they get GC'd between sandbox boots).
- Confirmed that PAT-authenticated direct push (`git push https://${PAT}@github.com/slookisen/lokal.git main`) bypasses the still-red Fly Deploy CI; supervisor can deploy regardless of CI health via flyctl directly. This is the established pattern since 2026-05-12.
- Marketing-comms-agent has standing SKILL authority to auto-deploy static-content commits (today's 9690fc2 SEO commit was deployed by CI from main without supervisor intervention). Worth double-checking with Daniel on return that this is intended.

## No memory hygiene actions taken (skill-cleanup deferred to next Mon Guidebook cycle)
