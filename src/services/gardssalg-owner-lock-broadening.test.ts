/**
 * gardssalg-owner-lock-broadening.test.ts — direct unit tests for the
 * dev-request 2026-08-29-gardssalg-products-write-and-field-lock, Part B
 * restructure of isGardssalgFieldOwnerLocked (src/services/experience-
 * store.ts).
 *
 * Before this restructure, an owner_locks.<field> entry in
 * field_provenance was only ever CONSULTED for content_source='claim' rows
 * — for any other content_source (null, enrichment-derived, 'provider_site',
 * etc — most gårdssalg rows, including live production ones) the function
 * returned false unconditionally, never even looking at owner_locks. That
 * made the new admin gardssalg-set-field-lock endpoint (Part B) a no-op on
 * a typical row: the lock would be written, but every write-path gate and
 * the content-refresh/retro-scan/hjemmeside-refresh skip checks would keep
 * ignoring it.
 *
 * The fix adds a field-level, content_source-INDEPENDENT layer (checked
 * FIRST) on top of the pre-existing content_source-based row-level rules
 * (checked unchanged, as a fallback) — see isGardssalgFieldOwnerLocked's own
 * doc comment for the full two-layer contract.
 *
 * isGardssalgFieldOwnerLocked is a PURE function — no DB, no network — so
 * this file calls it directly with hand-built row objects, no in-memory-DB
 * harness needed.
 *
 * Covers:
 *   (a) NEW: content_source=null + an owner_locks.<field> entry, for a
 *       field in GARDSSALG_OWNER_LOCK_ELIGIBLE_FIELDS -> now true (was
 *       false pre-restructure) — the case this whole change exists for
 *   (b) content_source=null, NO owner_locks entry -> still false (unchanged)
 *   (c) content_source=null + an owner_locks entry for a field NOT in the
 *       eligible set -> still false (layer A only ever checks eligible
 *       fields)
 *   (d) content_source='manual' -> always true, with OR without an
 *       owner_locks entry, for eligible AND non-eligible fields (unchanged)
 *   (e) content_source='claim', eligible field, WITH an owner_locks entry
 *       -> true (unchanged — same lookup, just performed once now)
 *   (f) content_source='claim', eligible field, WITHOUT an owner_locks
 *       entry -> false (unchanged)
 *   (g) content_source='claim', a NON-eligible field (e.g. 'adresse',
 *       'epost') -> always true regardless of owner_locks (unchanged —
 *       these fields can never appear in owner_locks at all)
 *   (h) content_source='provider_site' (an ordinary enrichment-derived
 *       value, not null) behaves identically to null for this function —
 *       only the two named content_source values ('manual'/'claim') are
 *       ever special-cased
 *   (i) malformed field_provenance JSON is treated as "no lock", never
 *       throws — for BOTH layers
 *   (j) field_provenance omitted entirely (undefined, not just null) is
 *       treated as "no lock", never throws
 *   (k) producer_type specifically (added to
 *       GARDSSALG_OWNER_LOCK_ELIGIBLE_FIELDS by this same dev-request):
 *       content_source=null + owner_locks.producer_type -> locked (new);
 *       content_source='claim' WITHOUT an owner_locks.producer_type entry
 *       -> now false — a REAL, deliberate behavior change from the old
 *       always-true-for-claim-rows default (see
 *       GARDSSALG_OWNER_LOCK_ELIGIBLE_FIELDS's own doc comment for why this
 *       is safe: no existing test pinned the old behavior for this specific
 *       field/content_source combination)
 *   (l) the `locked_by` attribute (admin vs. owner-claim provenance
 *       distinction) has NO effect on isGardssalgFieldOwnerLocked's boolean
 *       decision either way — presence of the key alone is what matters,
 *       matching the pre-existing owner-claim-lock contract exactly
 */

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export async function runGardssalgOwnerLockBroadeningTests(
  opts: { log?: boolean } = {},
): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];

  function assertEq(actual: unknown, expected: unknown, label: string): void {
    if (actual === expected) {
      passed++;
      if (log) console.log(`  ok ${label}`);
    } else {
      failed++;
      const msg = `✗ ${label}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`;
      failures.push(msg);
      if (log) console.log("  " + msg);
    }
  }

  const store = require("./experience-store") as typeof import("./experience-store");
  const isLocked = store.isGardssalgFieldOwnerLocked;

  function row(contentSource: string | null, ownerLocks?: Record<string, unknown> | null): {
    content_source: string | null;
    field_provenance?: string | null;
  } {
    if (ownerLocks === undefined) return { content_source: contentSource, field_provenance: null };
    return {
      content_source: contentSource,
      field_provenance: ownerLocks === null ? null : JSON.stringify({ owner_locks: ownerLocks }),
    };
  }

  // ── (a) NEW: content_source=null + owner_locks entry, eligible field ──
  assertEq(
    isLocked(row(null, { about_text: { locked_at: "2026-08-29T00:00:00Z", locked_by: "admin" } }), "about_text"),
    true,
    "a1: content_source=null + owner_locks.about_text (admin-set) -> locked (NEW)",
  );
  assertEq(
    isLocked(row(null, { products: { locked_at: "2026-08-29T00:00:00Z", locked_by: "admin" } }), "products"),
    true,
    "a2: content_source=null + owner_locks.products (admin-set) -> locked (NEW)",
  );

  // ── (b) content_source=null, no owner_locks entry -> false ────────────
  assertEq(isLocked(row(null, {}), "about_text"), false, "b1: content_source=null, empty owner_locks -> not locked");
  assertEq(isLocked(row(null, undefined), "about_text"), false, "b2: content_source=null, no field_provenance at all -> not locked");

  // ── (c) content_source=null + owner_locks for a NON-eligible field ────
  assertEq(
    isLocked(row(null, { adresse: { locked_at: "2026-08-29T00:00:00Z" } }), "adresse"),
    false,
    "c1: content_source=null + owner_locks.adresse (adresse is NOT eligible) -> not locked, layer A never checks it",
  );

  // ── (d) content_source='manual' -> always true ─────────────────────────
  assertEq(isLocked(row("manual", undefined), "about_text"), true, "d1: content_source='manual', no owner_locks -> locked");
  assertEq(isLocked(row("manual", {}), "about_text"), true, "d2: content_source='manual', empty owner_locks -> locked");
  assertEq(isLocked(row("manual", { about_text: { locked_at: "x" } }), "about_text"), true, "d3: content_source='manual' WITH an owner_locks entry -> still locked (same outcome either way)");
  assertEq(isLocked(row("manual", undefined), "adresse"), true, "d4: content_source='manual' -> locked even for a non-eligible field");

  // ── (e)/(f) content_source='claim', eligible field ─────────────────────
  assertEq(
    isLocked(row("claim", { about_text: { locked_at: "2026-08-01T00:00:00Z" } }), "about_text"),
    true,
    "e1: content_source='claim', eligible field, WITH owner_locks entry -> locked (unchanged)",
  );
  assertEq(
    isLocked(row("claim", { visit_text: { locked_at: "2026-08-01T00:00:00Z" } }), "about_text"),
    false,
    "f1: content_source='claim', eligible field, WITHOUT its own owner_locks entry -> not locked (unchanged)",
  );
  assertEq(isLocked(row("claim", {}), "about_text"), false, "f2: content_source='claim', empty owner_locks -> not locked (unchanged)");

  // ── (g) content_source='claim', non-eligible field -> always true ─────
  assertEq(isLocked(row("claim", {}), "adresse"), true, "g1: content_source='claim', non-eligible field ('adresse') -> always locked (unchanged)");
  assertEq(isLocked(row("claim", {}), "epost"), true, "g2: content_source='claim', non-eligible field ('epost') -> always locked (unchanged)");
  assertEq(isLocked(row("claim", {}), "telefon"), true, "g3: content_source='claim', non-eligible field ('telefon') -> always locked (unchanged)");
  assertEq(isLocked(row("claim", {}), "org_nr"), true, "g4: content_source='claim', non-eligible field ('org_nr') -> always locked (unchanged)");

  // ── (h) content_source='provider_site' behaves like null ──────────────
  assertEq(isLocked(row("provider_site", {}), "about_text"), false, "h1: content_source='provider_site', no owner_locks -> not locked");
  assertEq(
    isLocked(row("provider_site", { about_text: { locked_at: "x", locked_by: "admin" } }), "about_text"),
    true,
    "h2: content_source='provider_site' + admin owner_locks entry -> locked (same as null — only 'manual'/'claim' are special-cased)",
  );

  // ── (i) malformed field_provenance JSON never throws ───────────────────
  let threwOnMalformed = false;
  let malformedResult = false;
  try {
    malformedResult = isLocked({ content_source: null, field_provenance: "{not valid json[[" }, "about_text");
  } catch {
    threwOnMalformed = true;
  }
  assertEq(threwOnMalformed, false, "i1: malformed field_provenance JSON does not throw");
  assertEq(malformedResult, false, "i2: malformed field_provenance JSON is treated as 'no lock'");

  let threwOnMalformedClaim = false;
  let malformedClaimResult = false;
  try {
    malformedClaimResult = isLocked({ content_source: "claim", field_provenance: "{{{" }, "about_text");
  } catch {
    threwOnMalformedClaim = true;
  }
  assertEq(threwOnMalformedClaim, false, "i3: malformed field_provenance JSON does not throw for a claim row either");
  assertEq(malformedClaimResult, false, "i4: malformed field_provenance JSON on a claim row -> not locked (same as no owner_locks)");

  // ── (j) field_provenance omitted entirely (not just null) ─────────────
  assertEq(isLocked({ content_source: null }, "about_text"), false, "j1: field_provenance key entirely absent -> not locked, no throw");

  // ── (k) producer_type specifically ─────────────────────────────────────
  assertEq(
    isLocked(row(null, { producer_type: { locked_at: "2026-08-29T00:00:00Z", locked_by: "admin" } }), "producer_type"),
    true,
    "k1: content_source=null + owner_locks.producer_type (admin-set) -> locked (NEW — the case Part B's producer_type gate depends on)",
  );
  assertEq(
    isLocked(row("claim", {}), "producer_type"),
    false,
    "k2: content_source='claim' WITHOUT an owner_locks.producer_type entry -> now NOT locked (real, deliberate behavior change — producer_type used to fall through to the always-locked 'any other fieldName' branch)",
  );
  assertEq(
    isLocked(row("claim", { producer_type: { locked_at: "2026-08-01T00:00:00Z" } }), "producer_type"),
    true,
    "k3: content_source='claim' WITH an owner_locks.producer_type entry -> locked (per-field, same as the other five eligible fields)",
  );

  // ── (l) locked_by has no effect on the boolean decision ────────────────
  assertEq(
    isLocked(row(null, { about_text: { locked_at: "x" } }), "about_text"),
    isLocked(row(null, { about_text: { locked_at: "x", locked_by: "admin" } }), "about_text"),
    "l1: presence of owner_locks.<field> alone decides the outcome — locked_by does not change it",
  );

  return { passed, failed, failures };
}

// Standalone runner: `npx tsx src/services/gardssalg-owner-lock-broadening.test.ts`
if (require.main === module) {
  runGardssalgOwnerLockBroadeningTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    process.exit(summary.failed > 0 ? 1 : 0);
  });
}
