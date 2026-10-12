/**
 * memory-thresholds.test.ts — the memory limit and the /health memory
 * thresholds scale with the machine (services/memory-thresholds.ts).
 *
 * Prod 2026-10-12: the Fly machine moved from 512 MB to 2048 MB, but /health
 * (> 420 MB critical, > 350 MB warning) and the RFB marketing job's G3b gate
 * (HEALTH_CRITICAL_RSS_MB = 420) stayed hardcoded for 512 MB, so the daily
 * RFB send skipped all three attempts on `memory critical: 455MB rss
 * (> 420MB)`. Pins: the thresholds at 512 (unchanged) and 2048, the limit
 * resolution order (env → cgroup → 512), the RFB gate at both limits, and
 * that /health, the RFB gate and ops/diagnostics all read the shared module.
 * Pure — no DB; the limit resolution gets an injected env + cgroup reader.
 *
 * Two ways to run:
 *   1. Standalone:  npx tsx src/services/memory-thresholds.test.ts
 *   2. Wired into the gate: tests/test.ts.
 */

import fs from "fs";
import path from "path";
import {
  DEFAULT_MEMORY_LIMIT_MB,
  MEMORY_LIMIT_MB,
  MEMORY_THRESHOLDS,
  memoryThresholdsFor,
  resolveMemoryLimitMb,
} from "./memory-thresholds";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

const GiB = 1024 * 1024 * 1024;

export function runMemoryThresholdsTests(opts: { log?: boolean } = {}): TestSummary {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];

  function assertEq(actual: unknown, expected: unknown, label: string): void {
    if (JSON.stringify(actual) === JSON.stringify(expected)) {
      passed++;
      if (log) console.log(`  ok ${label}`);
    } else {
      failed++;
      const msg = `✗ ${label}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`;
      failures.push(msg);
      if (log) console.log("  " + msg);
    }
  }
  function assertTrue(cond: boolean, label: string): void {
    assertEq(cond, true, label);
  }

  try {
    // ── m1: thresholds scale with the limit at the original ratios ─────────
    assertEq(memoryThresholdsFor(512), { limitMb: 512, criticalMb: 420, warningMb: 350 }, "m1: 512 MB → 420/350 (unchanged)");
    assertEq(memoryThresholdsFor(2048), { limitMb: 2048, criticalMb: 1680, warningMb: 1400 }, "m1: 2048 MB → 1680/1400");
    assertEq(memoryThresholdsFor(1024), { limitMb: 1024, criticalMb: 840, warningMb: 700 }, "m1: 1024 MB → 840/700");
    assertEq(memoryThresholdsFor(1000), { limitMb: 1000, criticalMb: 820, warningMb: 684 }, "m1: a non-power-of-two limit is rounded to whole MB");

    // ── m2: limit resolution — env, then cgroup, then 512 ──────────────────
    const cgroup = (raw: string) => () => raw;
    const noCgroup = () => { throw new Error("ENOENT: no such file or directory"); };
    assertEq(resolveMemoryLimitMb({ env: { MEMORY_LIMIT_MB: "2048" }, readCgroupMemoryMax: cgroup(String(1 * GiB)) }), 2048, "m2: env MEMORY_LIMIT_MB wins over cgroup");
    assertEq(resolveMemoryLimitMb({ env: { MEMORY_LIMIT_MB: "2048" }, readCgroupMemoryMax: noCgroup }), 2048, "m2: env alone");
    assertEq(resolveMemoryLimitMb({ env: {}, readCgroupMemoryMax: cgroup(`${2 * GiB}\n`) }), 2048, "m2: env unset → cgroup memory.max (bytes → MB, trimmed)");
    assertEq(resolveMemoryLimitMb({ env: { MEMORY_LIMIT_MB: "0" }, readCgroupMemoryMax: cgroup(String(GiB)) }), 1024, "m2: env 0 → cgroup");
    assertEq(resolveMemoryLimitMb({ env: { MEMORY_LIMIT_MB: "" }, readCgroupMemoryMax: cgroup(String(GiB)) }), 1024, "m2: env empty → cgroup");
    assertEq(resolveMemoryLimitMb({ env: { MEMORY_LIMIT_MB: "-5" }, readCgroupMemoryMax: cgroup(String(GiB)) }), 1024, "m2: env negative → cgroup");
    assertEq(resolveMemoryLimitMb({ env: { MEMORY_LIMIT_MB: "lots" }, readCgroupMemoryMax: cgroup(String(GiB)) }), 1024, "m2: env unparseable → cgroup");
    assertEq(resolveMemoryLimitMb({ env: {}, readCgroupMemoryMax: cgroup("max\n") }), DEFAULT_MEMORY_LIMIT_MB, "m2: cgroup 'max' (no limit) → 512");
    assertEq(resolveMemoryLimitMb({ env: {}, readCgroupMemoryMax: noCgroup }), DEFAULT_MEMORY_LIMIT_MB, "m2: no cgroup file → 512");
    assertEq(resolveMemoryLimitMb({ env: {}, readCgroupMemoryMax: cgroup("0") }), DEFAULT_MEMORY_LIMIT_MB, "m2: cgroup 0 → 512");
    assertEq(resolveMemoryLimitMb({ env: {}, readCgroupMemoryMax: cgroup("garbage") }), DEFAULT_MEMORY_LIMIT_MB, "m2: cgroup unparseable → 512");
    assertEq(DEFAULT_MEMORY_LIMIT_MB, 512, "m2: the fallback is 512 MB");

    // ── m3: the resolved default is the env/cgroup resolution, once ────────
    assertEq(MEMORY_LIMIT_MB, resolveMemoryLimitMb(), "m3: MEMORY_LIMIT_MB = resolveMemoryLimitMb() for this process");
    assertEq(MEMORY_THRESHOLDS, memoryThresholdsFor(MEMORY_LIMIT_MB), "m3: MEMORY_THRESHOLDS = memoryThresholdsFor(MEMORY_LIMIT_MB)");

    // ── m4: the RFB G3b gate at 2048 MB and at 512 MB ──────────────────────
    const daily = require("./rfb-marketing-daily") as typeof import("./rfb-marketing-daily");
    const c = daily.classifyRfbMarketingHealth;
    const crit2048 = memoryThresholdsFor(2048).criticalMb;
    const crit512 = memoryThresholdsFor(512).criticalMb;
    assertEq(c({ rssMb: 455, diskUsedPct: 10 }, crit2048), { red: false, reasons: [], rss_mb: 455, disk_used_pct: 10 }, "m4: 455 MB RSS at a 2048 MB limit is NOT red (the 2026-10-12 skip)");
    assertEq(c({ rssMb: 1680, diskUsedPct: 10 }, crit2048).red, false, "m4: 1680 MB at 2048 is not red (strictly greater, as /health)");
    assertEq(c({ rssMb: 1681, diskUsedPct: 10 }, crit2048).reasons, ["memory critical: 1681MB rss (> 1680MB)"], "m4: 1681 MB at 2048 is red, reason format unchanged");
    assertEq(c({ rssMb: 455, diskUsedPct: 10 }, crit512).reasons, ["memory critical: 455MB rss (> 420MB)"], "m4: 455 MB at a 512 MB limit is still red (512 behaviour unchanged)");
    assertEq([c({ rssMb: 421, diskUsedPct: 10 }, crit512).red, c({ rssMb: 420, diskUsedPct: 10 }, crit512).red], [true, false], "m4: 512 boundary unchanged (> 420MB)");
    assertEq(daily.HEALTH_CRITICAL_RSS_MB, MEMORY_THRESHOLDS.criticalMb, "m4: HEALTH_CRITICAL_RSS_MB is the shared resolved value");
    assertEq(c({ rssMb: MEMORY_THRESHOLDS.criticalMb + 1, diskUsedPct: null }).red, true, "m4: the default threshold is the resolved one (above → red)");
    assertEq(c({ rssMb: MEMORY_THRESHOLDS.criticalMb, diskUsedPct: null }).red, false, "m4: the default threshold is the resolved one (at → not red)");

    // ── m5: /health and ops/diagnostics read the shared module ────────────
    const srcDir = path.join(__dirname, "..");
    const indexSrc = fs.readFileSync(path.join(srcDir, "index.ts"), "utf8");
    assertTrue(
      indexSrc.includes('import { MEMORY_LIMIT_MB, MEMORY_THRESHOLDS } from "./services/memory-thresholds";'),
      "m5: /health imports the limit and thresholds from services/memory-thresholds",
    );
    assertTrue(
      indexSrc.includes('if (memUsedMb > MEMORY_THRESHOLDS.criticalMb) { status = "critical"; warnings.push(`Memory critical: ${memUsedMb}MB / ${MEMORY_LIMIT_MB}MB`); }'),
      "m5: /health critical uses the shared threshold, warning text unchanged",
    );
    assertTrue(
      indexSrc.includes('else if (memUsedMb > MEMORY_THRESHOLDS.warningMb) { status = "warning"; warnings.push(`Memory high: ${memUsedMb}MB / ${MEMORY_LIMIT_MB}MB`); }'),
      "m5: /health warning uses the shared threshold, warning text unchanged",
    );
    assertTrue(!/memUsedMb > \d/.test(indexSrc), "m5: no hardcoded memUsedMb threshold left in index.ts");
    assertTrue(!indexSrc.includes("const MEMORY_LIMIT_MB"), "m5: index.ts no longer resolves its own memory limit");
    const analyticsSrc = fs.readFileSync(path.join(srcDir, "routes", "analytics.ts"), "utf8");
    assertTrue(
      analyticsSrc.includes("pct: Math.round(mem.rss / 1024 / 1024 / MEMORY_LIMIT_MB * 100)") && !analyticsSrc.includes("/ 512 * 100"),
      "m5: ops/diagnostics memory.pct uses the shared limit, not a hardcoded 512",
    );
  } catch (err) {
    failed++;
    failures.push(`memory-thresholds: unexpected error: ${err instanceof Error ? err.stack || err.message : String(err)}`);
  }

  return { passed, failed, failures };
}

if (require.main === module) {
  process.env.NODE_ENV = "test";
  process.env.EMAIL_FORCE_DRY_RUN = "true";
  process.env.OFFTHREAD_STATS_DISABLED = "1";
  const r = runMemoryThresholdsTests({ log: true });
  console.log(`\nmemory-thresholds: ${r.passed} passed, ${r.failed} failed`);
  if (r.failed > 0) {
    for (const f of r.failures) console.log(f);
    process.exit(1);
  }
  // rfb-marketing-daily's module graph leaves handles open; exit explicitly.
  process.exit(0);
}
