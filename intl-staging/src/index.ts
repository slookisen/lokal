// rfb-intl-staging — standalone staging service for SE/DK producer candidates.
// Separate Fly app with its own volume; never part of the prod `lokal` app.
// Dev-request: A2A dev-requests/2026-10-13-se-batch-profiler-staging.md.
import fs from "node:fs";
import path from "node:path";
import { createApp } from "./app";
import { openDb } from "./db";
import { liveSources } from "./se-import";
import { purge } from "./store";

const dataDir = process.env.DATA_DIR || "/data";
fs.mkdirSync(dataDir, { recursive: true });
const dbFile = path.join(dataDir, "intl.db");
const db = openDb(dbFile);

const app = createApp({
  db,
  dataDir,
  dbFile,
  token: process.env.INTL_STAGING_TOKEN || undefined,
  hmacKey: process.env.INTL_STAGING_HMAC_KEY || undefined,
  limits: {
    diskMaxPct: Number(process.env.DISK_MAX_PCT) || 80,
    dbMaxBytes: (Number(process.env.DB_MAX_MB) || 2048) * 1048576,
  },
  now: () => new Date(),
  importSources: liveSources,
});

// Housekeeping: drop page excerpts older than 30 days and release stale leases.
const runPurge = () => {
  try {
    const r = purge(db, new Date());
    if (r.excerpts_deleted || r.leases_released || r.judge_leases_released) console.log("[intl-staging] purge", JSON.stringify(r));
  } catch (e) {
    console.error("[intl-staging] purge failed", e);
  }
};
runPurge();
setInterval(runPurge, 10 * 60 * 1000).unref();

const port = Number(process.env.PORT) || 8080;
app.listen(port, () => {
  console.log(`[intl-staging] listening on ${port}, data in ${dataDir}, token ${process.env.INTL_STAGING_TOKEN ? "set" : "MISSING"}`);
});
