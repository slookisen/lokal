// Resource guards. The staging app runs on its own small volume, so a full disk
// here cannot hurt prod — but Daniel asked that nothing reach a critical level
// "uten noen fiks", so writes stop (and the app pauses itself) well before.
import fs from "node:fs";

export interface Limits {
  diskMaxPct: number;
  dbMaxBytes: number;
}

export function diskUsedPct(dir: string): number | null {
  try {
    const s = fs.statfsSync(dir);
    const total = s.blocks * s.bsize;
    const free = s.bavail * s.bsize;
    return total > 0 ? Math.round(((total - free) / total) * 1000) / 10 : null;
  } catch {
    return null;
  }
}

export function dbBytes(file: string): number {
  let total = 0;
  for (const f of [file, `${file}-wal`]) {
    try {
      total += fs.statSync(f).size;
    } catch {
      // missing file counts as zero
    }
  }
  return total;
}

export function resourceProblem(dataDir: string, dbFile: string, limits: Limits): string | null {
  const pct = diskUsedPct(dataDir);
  if (pct !== null && pct >= limits.diskMaxPct) return `resource: disk ${pct} % ≥ ${limits.diskMaxPct} %`;
  const bytes = dbBytes(dbFile);
  if (bytes >= limits.dbMaxBytes) return `resource: database ${Math.round(bytes / 1048576)} MB ≥ ${Math.round(limits.dbMaxBytes / 1048576)} MB`;
  return null;
}
