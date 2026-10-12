// ─── Memory limit + memory thresholds for GET /health ────────────────
//
// One source of truth for the machine's memory limit and the RSS levels at
// which GET /health (src/index.ts) reports "warning" / "critical". The RFB
// marketing daily job's G3b health gate (services/rfb-marketing-daily.ts)
// mirrors /health's "critical" and reads the same values from here.
//
// The thresholds used to be hardcoded for a 512 MB machine (> 420 MB RSS
// critical, > 350 MB warning). After the Fly machine moved to 2048 MB
// (fly.toml, performance-1x) normal RSS read as "critical", and the RFB job
// skipped every daily attempt on health_red (2026-10-12). They now scale with
// the memory limit at the original ratios, so 512 MB still gives 420/350.

import fs from "fs";

export const DEFAULT_MEMORY_LIMIT_MB = 512;
export const CGROUP_MEMORY_MAX_PATH = "/sys/fs/cgroup/memory.max";

/** The original 512 MB thresholds; only their ratios to 512 are used. */
const BASE_LIMIT_MB = 512;
const BASE_CRITICAL_RSS_MB = 420;
const BASE_WARNING_RSS_MB = 350;

export interface MemoryThresholds {
  limitMb: number;
  /** RSS above this (strictly greater) → "critical". */
  criticalMb: number;
  /** RSS above this (strictly greater) → "warning". */
  warningMb: number;
}

/**
 * Dynamic memory limit: MEMORY_LIMIT_MB env var first, then cgroup
 * memory.max (Fly.io/container; "max" means no limit), then 512 MB.
 * `env` and `readCgroupMemoryMax` are seams for tests.
 */
export function resolveMemoryLimitMb(opts: {
  env?: NodeJS.ProcessEnv;
  readCgroupMemoryMax?: () => string;
} = {}): number {
  const env = Number((opts.env ?? process.env).MEMORY_LIMIT_MB);
  if (env > 0) return env;
  try {
    const read = opts.readCgroupMemoryMax ?? (() => fs.readFileSync(CGROUP_MEMORY_MAX_PATH, "utf8"));
    const raw = read().trim();
    if (raw !== "max") { const mb = Math.round(Number(raw) / 1024 / 1024); if (mb > 0) return mb; }
  } catch {}
  return DEFAULT_MEMORY_LIMIT_MB;
}

/** Pure: the /health memory thresholds for a given limit (512 → 420/350, 2048 → 1680/1400). */
export function memoryThresholdsFor(limitMb: number): MemoryThresholds {
  return {
    limitMb,
    criticalMb: Math.round(limitMb * BASE_CRITICAL_RSS_MB / BASE_LIMIT_MB),
    warningMb: Math.round(limitMb * BASE_WARNING_RSS_MB / BASE_LIMIT_MB),
  };
}

/** Resolved once at module load (as /health's MEMORY_LIMIT_MB always was). */
export const MEMORY_LIMIT_MB = resolveMemoryLimitMb();
export const MEMORY_THRESHOLDS: MemoryThresholds = memoryThresholdsFor(MEMORY_LIMIT_MB);
