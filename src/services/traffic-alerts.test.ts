/**
 * traffic-alerts.test.ts — G2-S3 of dev-request
 * 2026-10-16-ai-trafikk-klassifisering-og-alarm: the deterministic alert for
 * sudden traffic falls and jumps. Pure module, synthetic series.
 * Exported runTrafficAlertsTests({log}) -> TestSummary; wired into tests/test.ts.
 * Standalone: npx tsx src/services/traffic-alerts.test.ts
 */

import { computeTrafficAlerts, type DailyTrafficPoint } from "./traffic-alerts";
import { addDays } from "./traffic-history-compute";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

/** 8 consecutive days ending 2026-10-15: seven of `base` human views, then `last`. */
function series(base: number, last: number, opts: { version?: (i: number) => number; aiSearch?: number } = {}): DailyTrafficPoint[] {
  const out: DailyTrafficPoint[] = [];
  for (let i = 0; i < 8; i++) {
    out.push({
      day: addDays("2026-10-08", i),
      version: opts.version ? opts.version(i) : 1,
      views: { human: i === 7 ? last : base, ai_search: opts.aiSearch ?? 0, ai_crawler: 0 },
    });
  }
  return out;
}

export function runTrafficAlertsTests(opts: { log?: boolean } = {}): TestSummary {
  const failures: string[] = [];
  let passed = 0;
  const check = (name: string, ok: boolean) => {
    if (ok) passed++; else failures.push(name);
    if (opts.log) console.log(`${ok ? "ok  " : "FAIL"} ${name}`);
  };

  const fall = computeTrafficAlerts("dental", series(1000, 500));
  check("fall of -50% gives one medium fall alert", fall.length === 1 && fall[0].direction === "fall" && fall[0].severity === "medium" && fall[0].delta === -0.5);
  check("fall alert carries day, value, base and group", fall[0]?.day === "2026-10-15" && fall[0].value === 500 && fall[0].base === 1000 && fall[0].group === "human");

  const jump = computeTrafficAlerts("rfb", series(400, 1100));
  check("jump of +175% gives a jump alert", jump.length === 1 && jump[0].direction === "jump" && jump[0].severity === "high");

  check("flat traffic gives no alert", computeTrafficAlerts("rfb", series(1000, 900)).length === 0);
  check("-39% is under the fall threshold", computeTrafficAlerts("rfb", series(1000, 610)).length === 0);
  check("low base gives no alert even on -90%", computeTrafficAlerts("rfb", series(150, 15)).length === 0);
  check("too short a series gives no alert", computeTrafficAlerts("rfb", series(1000, 100).slice(3)).length === 0);

  const gap = series(1000, 100);
  gap[3].day = "2026-10-20";
  check("a gap in the baseline gives no alert", computeTrafficAlerts("rfb", gap).length === 0);

  const median = series(1000, 100);
  median[2].views.human = 100000; // one outlier day must not move the median baseline
  check("median ignores a single outlier day", computeTrafficAlerts("rfb", median)[0]?.base === 1000);

  const shifted = computeTrafficAlerts("rfb", series(1000, 100, { version: (i) => (i === 7 ? 2 : 1) }));
  check("version shift flags classifierChange", shifted.length === 1 && shifted[0].classifierChange === true);
  check("no version shift leaves classifierChange false", fall[0].classifierChange === false);

  const groups = computeTrafficAlerts("dental", series(1000, 1000, { aiSearch: 300 }).map((p, i) => (i === 7 ? { ...p, views: { ...p.views, ai_search: 30 } } : p)));
  check("each group is evaluated separately (ai_search fall only)", groups.length === 1 && groups[0].group === "ai_search");

  // Replay of the dental page-view drop 2026-10-16 report: 8,637 -> 2,102 (-75.7%).
  const replay = computeTrafficAlerts("dental", series(8637, 2102));
  check("dental replay 8637 -> 2102 is a high-severity fall", replay.length === 1 && replay[0].severity === "high" && replay[0].direction === "fall" && replay[0].delta === -0.757);

  return { passed, failed: failures.length, failures };
}

if (require.main === module) {
  const r = runTrafficAlertsTests({ log: true });
  console.log(`\n${r.passed} passed, ${r.failed} failed`);
  process.exit(r.failed ? 1 : 0);
}
