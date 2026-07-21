// ─── Dental test-fingerprint contamination — shared single-source-of-truth ──
//
// Incident (2026-07-21, dev-requests/2026-07-21-dental-schema-probe-writepath-fix.md):
// two real production dental_agents rows were contaminated by two different
// actors writing test/probe payloads via PUT /api/tannlege/agents/:id — the
// hourly enrichment worker's own schema probe (already correctly isolated to
// a reserved id, no code change needed there) and the platform-orchestrator's
// ad-hoc post-deploy smoke tests, which had no code-level guard stopping a
// test payload from landing on a real clinic row.
//
// PR #323 added isTestFingerprintPayload() as a write-path guard directly in
// src/routes/dental.ts (rejects future writes matching the fingerprint on
// non-synthetic ids). This module is the follow-up: it lifts that check out
// into a shared, single-source-of-truth place so the SAME per-field literal
// matches can also drive a read-side sweep (findContaminatedFields) that
// finds rows ALREADY contaminated before the write-path guard existed —
// see src/routes/admin-dental-schema-probe-sweep.ts.
//
// Both isTestFingerprintPayload (whole-payload, PUT-body shape — values are
// already-parsed JS objects/arrays/strings, express.json() does that) and
// findContaminatedFields (whole-row, RAW DB shape — dental_agents stores its
// JSON-typed columns as SQLite TEXT, so specialists/social_media/
// field_provenance may arrive as JSON strings that need parsing first) are
// built on the same per-field checkers below, so they can never drift out of
// agreement about what counts as contaminated.

// Ids reserved for schema/write-path probes — real clinic rows must never be
// a target for test-fingerprint payloads, and conversely these ids are
// EXPECTED to legitimately carry the fingerprint (the hourly enrichment
// worker's own schema probe writes it here on purpose, every cycle, to
// exercise the write path) — a sweep/repair pass must exclude them, not
// flag or "fix" a deliberately-fake row. Single source of truth: dental.ts's
// PUT /agents/:id guard and the schema-probe-sweep route both import this.
export const DENTAL_SYNTHETIC_PROBE_IDS = new Set(["persistence-probe-pr100b"]);

// Parses `value` if it's a string (the RAW DB TEXT-column shape); returns it
// unchanged otherwise (the already-parsed PUT-body shape). A malformed JSON
// string parses to `undefined`, which every per-field checker below treats
// as "not contaminated" for that field, so a corrupted existing blob can
// never block a sweep or false-flag a row.
function parseIfString(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

// ─── Per-field literal-match checkers ───────────────────────────────
// Deliberately narrow — match on the literal known-bad values/shapes from
// the incident, not a generic heuristic — to avoid false positives on
// legitimate data that happens to share one field name.

function specialistsContaminated(value: unknown): boolean {
  const v = parseIfString(value);
  return (
    Array.isArray(v) &&
    v.some((s) => s && typeof s === "object" && (s as Record<string, unknown>).name === "Test")
  );
}

function onlineBookingUrlContaminated(value: unknown): boolean {
  return value === "https://example.com/booking";
}

function socialMediaContaminated(value: unknown): boolean {
  const v = parseIfString(value);
  return !!(
    v &&
    typeof v === "object" &&
    !Array.isArray(v) &&
    (v as Record<string, unknown>).facebook === "https://facebook.com/x"
  );
}

function omOssContaminated(value: unknown): boolean {
  return value === "test probe";
}

function fieldProvenanceContaminated(value: unknown): boolean {
  const v = parseIfString(value);
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  for (const key of Object.keys(v as Record<string, unknown>)) {
    if (key === "_smoke_test_provenance_probe" || key.startsWith("_smoke_test")) return true;
  }
  return false;
}

// Returns true if `body` matches the KNOWN contamination fingerprint from
// the incident above. ANY ONE of the per-field checks above being true is
// enough to flag the payload: each incident write landed via a single-field
// PUT, so the check must not require multiple fields at once. Moved verbatim
// (same logic) from src/routes/dental.ts (PR #323) — dental.ts now imports
// this instead of defining its own copy.
export function isTestFingerprintPayload(body: Record<string, unknown>): boolean {
  if (!body || typeof body !== "object") return false;

  if (specialistsContaminated(body.specialists)) return true;
  if (onlineBookingUrlContaminated(body.online_booking_url)) return true;
  if (socialMediaContaminated(body.social_media)) return true;
  if (omOssContaminated(body.om_oss)) return true;
  if (fieldProvenanceContaminated(body.field_provenance)) return true;

  return false;
}

// Returns which of the five fingerprint-bearing columns are individually
// contaminated on a raw dental_agents row, so a row can be PARTIALLY
// repaired (e.g. only field_provenance carries the `_smoke_test` key while
// every other column is clean). Reuses the exact same per-field checkers as
// isTestFingerprintPayload above, so the two functions can never disagree
// about what counts as contaminated. `row` is the RAW DB shape — SQLite
// TEXT columns come back as JSON strings (or null), never pre-parsed.
export function findContaminatedFields(row: {
  specialists?: unknown;
  online_booking_url?: unknown;
  social_media?: unknown;
  om_oss?: unknown;
  field_provenance?: unknown;
}): string[] {
  const fields: string[] = [];
  if (specialistsContaminated(row.specialists)) fields.push("specialists");
  if (onlineBookingUrlContaminated(row.online_booking_url)) fields.push("online_booking_url");
  if (socialMediaContaminated(row.social_media)) fields.push("social_media");
  if (omOssContaminated(row.om_oss)) fields.push("om_oss");
  if (fieldProvenanceContaminated(row.field_provenance)) fields.push("field_provenance");
  return fields;
}
