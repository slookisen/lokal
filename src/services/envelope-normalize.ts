// ─── Envelope timestamp normalization (pure) ────────────────────
// The run-ledger is read by the loop-dispatcher (freshness + cooldown windows)
// and the platform-verifier (temporal-drift checks), so a bad started_at /
// finished_at poisons loop logic. Agents occasionally emit malformed timestamps:
//   - a literal "$(date -u +%Y-%m-%dT%H:%M:%SZ)" — heredoc that froze the
//     command substitution (rfb-customer-service);
//   - "...+00:00Z" — Python datetime.isoformat() (yields "+00:00") with a "Z"
//     wrongly appended → double timezone marker (loop-dispatcher);
//   - a finished_at in the FUTURE — clock skew / a derived (not clock-read) time
//     (experiences-enrichment).
// This normalizes both timestamps to a canonical "...Z" at INGEST, clamping the
// unparseable and the implausibly-future to the ingest clock — so a drifting
// agent can never corrupt the ledger's time data. Pure (caller passes nowMs),
// no DB/Date.now() inside, so it is deterministic + unit-testable. The
// POST /admin/runs handler calls it just before recordRun().

export interface TsRepair {
  field: "started_at" | "finished_at";
  from: string;
  reason: string;
}

/** Tolerate small clock skew between an agent and the server before clamping. */
export const FUTURE_SKEW_MS = 5 * 60_000;

/**
 * Coerce one timestamp to a canonical "...Z" string.
 * Returns the value + a repair reason (null when the input was already canonical).
 * Unparseable or implausibly-future values clamp to `nowMs` (the run just finished
 * when it POSTs, so ingest-time is a safe stand-in).
 */
export function normalizeTimestamp(
  raw: unknown,
  nowMs: number,
): { value: string; reason: string | null } {
  if (typeof raw === "string") {
    const s = raw.trim().replace(/\+00:00Z$/i, "Z"); // isoformat()+"Z" double-marker → Z
    const ms = Date.parse(s);
    if (!Number.isNaN(ms)) {
      if (ms > nowMs + FUTURE_SKEW_MS) {
        return { value: new Date(nowMs).toISOString(), reason: `future(${raw})->now` };
      }
      const canon = new Date(ms).toISOString();
      return { value: canon, reason: canon === raw ? null : `canonicalized(${raw})` };
    }
  }
  return {
    value: new Date(nowMs).toISOString(),
    reason: `unparseable(${String(raw).slice(0, 40)})->now`,
  };
}

/**
 * Normalize an envelope's started_at + finished_at. Guarantees both are canonical
 * "...Z", not in the future, and that finished_at >= started_at (monotonic).
 * Returns the clean pair + the list of repairs made (for logging).
 */
export function normalizeEnvelopeTimes(
  env: { started_at: unknown; finished_at: unknown },
  nowMs: number,
): { started_at: string; finished_at: string; repairs: TsRepair[] } {
  const repairs: TsRepair[] = [];
  const sa = normalizeTimestamp(env.started_at, nowMs);
  const fa = normalizeTimestamp(env.finished_at, nowMs);
  if (sa.reason) repairs.push({ field: "started_at", from: String(env.started_at).slice(0, 40), reason: sa.reason });
  if (fa.reason) repairs.push({ field: "finished_at", from: String(env.finished_at).slice(0, 40), reason: fa.reason });
  let started_at = sa.value;
  const finished_at = fa.value;
  if (Date.parse(started_at) > Date.parse(finished_at)) {
    started_at = finished_at; // never start after finish
    repairs.push({ field: "started_at", from: sa.value, reason: "started_at>finished_at->clamped" });
  }
  return { started_at, finished_at, repairs };
}
