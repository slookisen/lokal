// ─── How many days of raw analytics rows are kept ───────────────────────
// RFB_AUTO_PRUNE_DAYS (default 60, at least 7): the nightly prune deletes raw
// page views, searches and agent calls older than this. Every public figure
// over "the last N days" uses this window. Read at call time, so a running
// process always reflects its configuration. Its own module so the public
// stats worker (agent-stats-compute.ts) does not load the traffic report.

export function getRetentionWindowDays(): number {
  return Math.max(7, parseInt(process.env.RFB_AUTO_PRUNE_DAYS || "60", 10) || 60);
}
