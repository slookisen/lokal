// Shared dental enrichment write-pause check. One place for the
// `enrichmentWritePauseBlock(() => getDb("rfb"), "dental")` call so every dental
// write surface (src/routes/dental.ts, the admin-dental-* apply sweeps, the
// geocode worker) asks the same question the same way. The pause row lives on
// the MAIN db; getDb("rfb") is that handle. The THUNK is passed (not the handle)
// so a getDb() that throws fails CLOSED as a 423 `fail_closed:true` body.
//
// `null` -> the write may proceed; otherwise the exact standard 423 body.

import { getDb } from "../database/db-factory";
import { enrichmentWritePauseBlock, type EnrichmentWritePausedBody } from "./enrichment-write-pause";

export function dentalEnrichmentWritePauseBlock(): EnrichmentWritePausedBody | null {
  return enrichmentWritePauseBlock(() => getDb("rfb"), "dental");
}
