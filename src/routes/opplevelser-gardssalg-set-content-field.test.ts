/**
 * opplevelser-gardssalg-set-content-field.test.ts — tests for the missing
 * "apply a caller-supplied CONTENT value" path (dev-request
 * 2026-08-19-kursjustering-drikkefunnel-llm-og-supply, Grep 2b):
 *
 *   - applyGardssalgSetContentField() (src/services/experience-store.ts)
 *   - POST /admin/gardssalg-set-content-field (src/routes/opplevelser.ts)
 *
 * Content-field counterpart to opplevelser-gardssalg-set-contact-phone.test.ts.
 * The gap is the same shape ("a correct value exists, but no write path can
 * apply it"), one level harder: the fill-only route
 * (POST /admin/gardssalg-content-refresh) generates its OWN candidate from a
 * homepage fetch and so cannot carry LLM-authored or human-corrected text at
 * all — measured 0/12 rows enriched on the drinks cohort.
 *
 * Harness copied from opplevelser-gardssalg-set-contact-phone.test.ts
 * (EXPERIENCES_DB_PATH=":memory:", fresh require of db-factory +
 * experience-store + opplevelser router per run, callRoute() exercised
 * directly against router.handle()) and adapted for this endpoint. Where the
 * phone endpoint's only gate is a phone-shape guard, this one has TWO — a
 * per-field owner lock and the shared objective-defect classifier
 * (classifyGardssalgFieldDefect, gardssalg-quality-update.ts) — so this suite
 * covers both, and covers them FAIL-CLOSED (no column change, no audit row),
 * not merely by status code.
 *
 * Covers:
 *   (a) missing/wrong X-Admin-Key -> 403
 *   (b) happy path: blank about_text -> 200, column written, exactly ONE
 *       audit row (old_value null), field_provenance.about_text.source_url set
 *   (c) OVERWRITE of an already-filled about_text -> 200 with the old value
 *       on the audit row (the entire point of this slice — fill-only refused
 *       exactly this)
 *   (d) unknown provider_id -> 404 provider_not_found
 *   (e) field "products" and field "epost" -> 400 invalid_field (products is
 *       deliberately out of scope: no defect vocabulary exists for it)
 *   (f) missing value -> 400 value_required; missing source -> 400
 *       source_required
 *   (g) defective value rejected -> 400 defective_value + defect_type, with
 *       the column UNCHANGED and NO audit row (too_short + ui_chrome_leakage
 *       + placeholder)
 *   (h) owner lock: content_source='manual' -> 409; content_source='claim'
 *       WITH field_provenance.owner_locks.about_text -> 409; 'claim' WITHOUT
 *       a lock on that field -> 200 (the lock is per field, not per row)
 *   (i) opening_hours_text accepted at its lower 8-char floor ("Man-fre
 *       10-18") — proves the defect floor is per field, not global
 *   (j) rollback round-trip: planGardssalgContentRollback proposes restoring
 *       (c)'s old value, with no rollback-side changes needed
 */

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

interface RouteResult {
  status: number;
  body: any;
}

function callRoute(
  router: any,
  opts: {
    method?: "GET" | "POST";
    url?: string;
    headers?: Record<string, string>;
    body?: any;
  } = {},
): Promise<RouteResult> {
  return new Promise((resolve) => {
    const method = opts.method || "POST";
    const url = opts.url || "/admin/gardssalg-set-content-field";
    const req: any = {
      method,
      url,
      originalUrl: url,
      path: url,
      query: {},
      headers: opts.headers || {},
      body: opts.body ?? {},
      get() { return undefined; },
    };
    const res: any = {
      statusCode: 200,
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      json(payload: any) {
        resolve({ status: this.statusCode, body: payload });
        return this;
      },
    };
    router.handle(req, res, (err?: any) => {
      if (err) resolve({ status: 500, body: { error: String(err) } });
    });
  });
}

// A clean, Norwegian, punctuation-terminated about_text well over the 40-char
// about floor — passes every layer of classifyGardssalgFieldDefect including
// the search-enrich cheap-bar backstop (needs an æ/ø/å or a Norwegian
// function word).
const GOOD_ABOUT =
  "Gårdsbryggeri i Ås som brygger øl på egen bygg og selger direkte fra gårdsbutikken.";
const GOOD_ABOUT_2 =
  "Familiedrevet cideri på Vestlandet med egne epletrær, smaking og salg i helgene.";

export function runOpplevelserGardssalgSetContentFieldTests(
  opts: { log?: boolean } = {},
): Promise<TestSummary> {
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
    if (cond) {
      passed++;
      if (log) console.log(`  ok ${label}`);
    } else {
      failed++;
      failures.push(`✗ ${label}`);
      if (log) console.log(`  ✗ ${label}`);
    }
  }

  return (async () => {
    const prevExperiencesDbPath = process.env.EXPERIENCES_DB_PATH;
    const prevAdminKey = process.env.ADMIN_KEY;
    const testKey = process.env.ADMIN_KEY || "gardssalg-set-content-field-test-key";
    process.env.EXPERIENCES_DB_PATH = ":memory:";
    process.env.ADMIN_KEY = testKey;

    const dbFactoryPath = require.resolve("../database/db-factory");
    const experienceStorePath = require.resolve("../services/experience-store");
    const opplevelserPath = require.resolve("./opplevelser");
    const cachePaths = [dbFactoryPath, experienceStorePath, opplevelserPath];
    for (const p of cachePaths) delete require.cache[p];

    try {
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const expDb = dbFactory.getDb("experiences");

      const store = require("../services/experience-store") as typeof import("../services/experience-store");
      const opplevelserRouter = (require("./opplevelser") as typeof import("./opplevelser")).default as any;

      // ── Fixtures ─────────────────────────────────────────────────────────
      const insertProvider = expDb.prepare(
        `INSERT INTO experience_providers
           (id, navn, vertical, org_nr, content_source, about_text, visit_text,
            opening_hours_text, field_provenance, hjemmeside,
            producer_type, enrichment_state, verification_status, source, confidence,
            catalog_hidden, created_at)
         VALUES
           (@id, @navn, 'experiences', @org_nr, @content_source, @about_text, @visit_text,
            @opening_hours_text, @field_provenance, @hjemmeside,
            'cideri', 'raw', 'pending_verify', 'test-fixture', 'medium',
            @catalog_hidden, @created_at)`,
      );
      function mkProvider(p: Partial<Record<string, any>> & { id: string; navn: string }): void {
        insertProvider.run({
          org_nr: null, content_source: null, about_text: null, visit_text: null,
          opening_hours_text: null, field_provenance: null, hjemmeside: null,
          catalog_hidden: null, created_at: "2026-01-01 00:00:00", ...p,
        });
      }
      function getProviderRow(id: string): any {
        return expDb.prepare(
          `SELECT id, about_text, visit_text, opening_hours_text, content_source,
                  content_evidence_url, content_updated_at, field_provenance
             FROM experience_providers WHERE id = ?`
        ).get(id);
      }
      function getAuditRows(providerId: string): any[] {
        return expDb.prepare(
          `SELECT * FROM gardssalg_content_audit WHERE provider_id = ? ORDER BY rowid ASC`
        ).all(providerId);
      }

      const auth = { "x-admin-key": testKey };

      // ── (a) auth ─────────────────────────────────────────────────────────
      const unauth = await callRoute(opplevelserRouter, { body: {} });
      assertEq(unauth.status, 403, "a1: unauthenticated request -> 403");
      const wrongKey = await callRoute(opplevelserRouter, {
        headers: { "x-admin-key": "not-the-key" },
        body: { provider_id: "x", field: "about_text", value: GOOD_ABOUT, source: "s" },
      });
      assertEq(wrongKey.status, 403, "a2: wrong X-Admin-Key -> 403");

      // ── (b) happy path: blank about_text ─────────────────────────────────
      mkProvider({ id: "scf-happy", navn: "Happy Content Gard" });
      const happyRes = await callRoute(opplevelserRouter, {
        headers: auth,
        body: {
          provider_id: "scf-happy",
          field: "about_text",
          value: GOOD_ABOUT,
          source: "LLM-omskriving kjøring 2026-08-20, godkjent manuelt",
        },
      });
      assertEq(happyRes.status, 200, "b1: happy path returns 200");
      assertEq(happyRes.body, {
        success: true,
        provider_id: "scf-happy",
        field: "about_text",
        old_value: null,
        new_value: GOOD_ABOUT,
      }, "b2: response shape matches spec exactly");
      const happyRow = getProviderRow("scf-happy");
      assertEq(happyRow.about_text, GOOD_ABOUT, "b3: DB column about_text actually written");
      const happyProv = JSON.parse(happyRow.field_provenance || "{}");
      assertEq(
        happyProv.about_text?.source_url,
        "LLM-omskriving kjøring 2026-08-20, godkjent manuelt",
        "b4: field_provenance.about_text.source_url is the request's source verbatim",
      );
      assertTrue(!!happyProv.about_text?.fetched_at, "b5: field_provenance.about_text has a fresh fetched_at");
      const happyAudit = getAuditRows("scf-happy");
      assertEq(happyAudit.length, 1, "b6: exactly ONE audit row inserted");
      assertEq(happyAudit[0].field_name, "about_text", "b7: audit field_name is about_text");
      assertEq(happyAudit[0].old_value, null, "b8: audit old_value is the true pre-write null");
      assertEq(happyAudit[0].new_value, GOOD_ABOUT, "b9: audit new_value is the written value");
      assertEq(happyAudit[0].changed_by, "admin", "b10: audit changed_by is 'admin'");
      assertEq(happyAudit[0].batch_id, null, "b11: audit batch_id is NULL (single-row admin write)");
      // Deliberate non-writes — re-stamping these would misreport an
      // admin-supplied string as pipeline-derived content (see the store
      // function's doc comment).
      assertEq(happyRow.content_source, null, "b12: content_source deliberately NOT stamped");
      assertEq(happyRow.content_evidence_url, null, "b13: content_evidence_url deliberately NOT stamped");
      assertEq(happyRow.content_updated_at, null, "b14: content_updated_at deliberately NOT stamped");

      // ── (c) OVERWRITE an already-filled value — the point of the slice ────
      mkProvider({
        id: "scf-overwrite",
        navn: "Overwrite Content Gard",
        about_text: GOOD_ABOUT,
        created_at: "2026-01-02 00:00:00",
      });
      const overwriteRes = await callRoute(opplevelserRouter, {
        headers: auth,
        body: {
          provider_id: "scf-overwrite",
          field: "about_text",
          value: GOOD_ABOUT_2,
          source: "produsentsvar 2026-08-19: teksten var feil",
        },
      });
      assertEq(overwriteRes.status, 200, "c1: overwrite of an ALREADY-FILLED about_text -> 200 (fill-only refused exactly this)");
      assertEq(overwriteRes.body.old_value, GOOD_ABOUT, "c2: old_value is the prior stored text");
      assertEq(overwriteRes.body.new_value, GOOD_ABOUT_2, "c3: new_value is the corrected text");
      assertEq(getProviderRow("scf-overwrite").about_text, GOOD_ABOUT_2, "c4: DB column overwritten");
      const overwriteAudit = getAuditRows("scf-overwrite");
      assertEq(overwriteAudit.length, 1, "c5: exactly one audit row for the overwrite");
      assertEq(overwriteAudit[0].old_value, GOOD_ABOUT, "c6: audit row carries the OLD value (rollback depends on this)");
      assertEq(overwriteAudit[0].new_value, GOOD_ABOUT_2, "c7: audit row carries the new value");

      // ── (d) unknown provider -> 404 ──────────────────────────────────────
      const notFoundRes = await callRoute(opplevelserRouter, {
        headers: auth,
        body: { provider_id: "does-not-exist", field: "about_text", value: GOOD_ABOUT, source: "s" },
      });
      assertEq(notFoundRes.status, 404, "d1: unknown provider_id -> 404");
      assertEq(notFoundRes.body.error, "provider_not_found", "d2: error code is provider_not_found");

      // ── (e) field vocabulary is exactly three names ───────────────────────
      const productsRes = await callRoute(opplevelserRouter, {
        headers: auth,
        body: { provider_id: "scf-happy", field: "products", value: "Eplemost", source: "s" },
      });
      assertEq(productsRes.status, 400, "e1: field 'products' -> 400 (deliberately out of scope: no defect vocabulary)");
      assertEq(productsRes.body.error, "invalid_field", "e2: error code is invalid_field for products");
      const epostFieldRes = await callRoute(opplevelserRouter, {
        headers: auth,
        body: { provider_id: "scf-happy", field: "epost", value: "post@example.no", source: "s" },
      });
      assertEq(epostFieldRes.status, 400, "e3: field 'epost' -> 400 (contact fields have their own endpoints)");
      assertEq(epostFieldRes.body.error, "invalid_field", "e4: error code is invalid_field for epost");
      const missingFieldRes = await callRoute(opplevelserRouter, {
        headers: auth,
        body: { provider_id: "scf-happy", value: GOOD_ABOUT, source: "s" },
      });
      assertEq(missingFieldRes.status, 400, "e5: missing field -> 400");
      assertEq(missingFieldRes.body.error, "field_required", "e6: error code is field_required (distinct from invalid_field)");
      const missingProviderIdRes = await callRoute(opplevelserRouter, {
        headers: auth,
        body: { field: "about_text", value: GOOD_ABOUT, source: "s" },
      });
      assertEq(missingProviderIdRes.status, 400, "e7: missing provider_id -> 400");
      assertEq(missingProviderIdRes.body.error, "provider_id_required", "e8: error code is provider_id_required");

      // ── (f) value/source required ────────────────────────────────────────
      const missingValueRes = await callRoute(opplevelserRouter, {
        headers: auth,
        body: { provider_id: "scf-happy", field: "about_text", source: "s" },
      });
      assertEq(missingValueRes.status, 400, "f1: missing value -> 400");
      assertEq(missingValueRes.body.error, "value_required", "f2: error code is value_required");
      const blankValueRes = await callRoute(opplevelserRouter, {
        headers: auth,
        body: { provider_id: "scf-happy", field: "about_text", value: "   ", source: "s" },
      });
      assertEq(blankValueRes.status, 400, "f3: whitespace-only value -> 400 value_required (trim-then-check)");
      assertEq(blankValueRes.body.error, "value_required", "f4: error code is value_required for blank value");
      const missingSourceRes = await callRoute(opplevelserRouter, {
        headers: auth,
        body: { provider_id: "scf-happy", field: "about_text", value: GOOD_ABOUT_2 },
      });
      assertEq(missingSourceRes.status, 400, "f5: missing source -> 400");
      assertEq(missingSourceRes.body.error, "source_required", "f6: error code is source_required");

      // ── (g) defective values rejected FAIL-CLOSED ────────────────────────
      // Each case asserts the column is untouched AND no audit row exists —
      // a 400 alone would not prove the write was actually skipped.
      mkProvider({
        id: "scf-tooshort",
        navn: "Too Short Gard",
        about_text: GOOD_ABOUT,
        created_at: "2026-01-03 00:00:00",
      });
      const tooShortRes = await callRoute(opplevelserRouter, {
        headers: auth,
        body: { provider_id: "scf-tooshort", field: "about_text", value: "Kort tekst.", source: "s" },
      });
      assertEq(tooShortRes.status, 400, "g1: under the 40-char about floor -> 400");
      assertEq(tooShortRes.body.error, "defective_value", "g2: error code is defective_value");
      assertEq(tooShortRes.body.defect_type, "too_short", "g3: defect_type is too_short");
      assertEq(getProviderRow("scf-tooshort").about_text, GOOD_ABOUT, "g4: column UNCHANGED on a rejected write");
      assertEq(getAuditRows("scf-tooshort").length, 0, "g5: NO audit row on a rejected write");

      mkProvider({
        id: "scf-uichrome",
        navn: "UI Chrome Gard",
        about_text: GOOD_ABOUT,
        created_at: "2026-01-04 00:00:00",
      });
      const uiChromeRes = await callRoute(opplevelserRouter, {
        headers: auth,
        body: {
          provider_id: "scf-uichrome",
          field: "about_text",
          value: "Vi selger saft og syltetøy på gården. Previous Next Kom innom oss i sommer.",
          source: "s",
        },
      });
      assertEq(uiChromeRes.status, 400, "g6: slider-navigation text mid-string -> 400");
      assertEq(uiChromeRes.body.defect_type, "ui_chrome_leakage", "g7: defect_type is ui_chrome_leakage");
      assertEq(getProviderRow("scf-uichrome").about_text, GOOD_ABOUT, "g8: column UNCHANGED (ui_chrome)");
      assertEq(getAuditRows("scf-uichrome").length, 0, "g9: NO audit row (ui_chrome)");

      mkProvider({
        id: "scf-placeholder",
        navn: "Placeholder Gard",
        about_text: GOOD_ABOUT,
        created_at: "2026-01-05 00:00:00",
      });
      const placeholderRes = await callRoute(opplevelserRouter, {
        headers: auth,
        body: {
          provider_id: "scf-placeholder",
          field: "about_text",
          value: "Siden er under oppbygging, mer informasjon om gården kommer her etter hvert.",
          source: "s",
        },
      });
      assertEq(placeholderRes.status, 400, "g10: placeholder text -> 400");
      assertEq(placeholderRes.body.defect_type, "placeholder", "g11: defect_type is placeholder");
      assertEq(getProviderRow("scf-placeholder").about_text, GOOD_ABOUT, "g12: column UNCHANGED (placeholder)");
      assertEq(getAuditRows("scf-placeholder").length, 0, "g13: NO audit row (placeholder)");

      // ── (h) owner lock is per FIELD, not per row ─────────────────────────
      mkProvider({
        id: "scf-manual",
        navn: "Manual Gard",
        content_source: "manual",
        about_text: GOOD_ABOUT,
        created_at: "2026-01-06 00:00:00",
      });
      const manualRes = await callRoute(opplevelserRouter, {
        headers: auth,
        body: { provider_id: "scf-manual", field: "about_text", value: GOOD_ABOUT_2, source: "s" },
      });
      assertEq(manualRes.status, 409, "h1: content_source='manual' -> 409");
      assertEq(manualRes.body.error, "owner_locked", "h2: error code is owner_locked");
      assertEq(getProviderRow("scf-manual").about_text, GOOD_ABOUT, "h3: manual row UNCHANGED");
      assertEq(getAuditRows("scf-manual").length, 0, "h4: NO audit row on an owner-locked refusal");

      mkProvider({
        id: "scf-claim-locked",
        navn: "Claim Locked Gard",
        content_source: "claim",
        about_text: GOOD_ABOUT,
        field_provenance: JSON.stringify({ owner_locks: { about_text: { locked_at: "2026-08-01T00:00:00Z" } } }),
        created_at: "2026-01-07 00:00:00",
      });
      const claimLockedRes = await callRoute(opplevelserRouter, {
        headers: auth,
        body: { provider_id: "scf-claim-locked", field: "about_text", value: GOOD_ABOUT_2, source: "s" },
      });
      assertEq(claimLockedRes.status, 409, "h5: content_source='claim' WITH owner_locks.about_text -> 409");
      assertEq(claimLockedRes.body.error, "owner_locked", "h6: error code is owner_locked");
      assertEq(getProviderRow("scf-claim-locked").about_text, GOOD_ABOUT, "h7: claim-locked field UNCHANGED");

      mkProvider({
        id: "scf-claim-unlocked",
        navn: "Claim Unlocked Gard",
        content_source: "claim",
        about_text: GOOD_ABOUT,
        // The owner edited visit_text only — about_text is NOT theirs, so the
        // lock must not reach it.
        field_provenance: JSON.stringify({ owner_locks: { visit_text: { locked_at: "2026-08-01T00:00:00Z" } } }),
        created_at: "2026-01-08 00:00:00",
      });
      const claimUnlockedRes = await callRoute(opplevelserRouter, {
        headers: auth,
        body: { provider_id: "scf-claim-unlocked", field: "about_text", value: GOOD_ABOUT_2, source: "s" },
      });
      assertEq(claimUnlockedRes.status, 200, "h8: content_source='claim' WITHOUT a lock on that field -> 200 (per-field, not per-row)");
      assertEq(getProviderRow("scf-claim-unlocked").about_text, GOOD_ABOUT_2, "h9: unlocked field written");
      const claimUnlockedProv = JSON.parse(getProviderRow("scf-claim-unlocked").field_provenance || "{}");
      assertEq(
        (claimUnlockedProv.owner_locks || {}).visit_text?.locked_at,
        "2026-08-01T00:00:00Z",
        "h10: the OTHER field's owner_lock survives the provenance merge",
      );
      const claimUnlockedLockedRes = await callRoute(opplevelserRouter, {
        headers: auth,
        body: {
          provider_id: "scf-claim-unlocked",
          field: "visit_text",
          value: "Kom innom gårdsbutikken vår i helgene for smaking og salg.",
          source: "s",
        },
      });
      assertEq(claimUnlockedLockedRes.status, 409, "h11: the SAME row's owner-locked visit_text is still refused -> 409");

      // ── (i) per-field floor: opening_hours_text at its 8-char floor ──────
      mkProvider({ id: "scf-hours", navn: "Hours Gard", created_at: "2026-01-09 00:00:00" });
      const hoursRes = await callRoute(opplevelserRouter, {
        headers: auth,
        body: {
          provider_id: "scf-hours",
          field: "opening_hours_text",
          value: "Man-fre 10-18",
          source: "produsentsvar",
        },
      });
      assertEq(hoursRes.status, 200, "i1: 13-char opening_hours_text accepted (floor is 8, not the 40 about_text uses)");
      assertEq(getProviderRow("scf-hours").opening_hours_text, "Man-fre 10-18", "i2: opening_hours_text column written");
      const hoursAudit = getAuditRows("scf-hours");
      assertEq(hoursAudit.length, 1, "i3: exactly one audit row for the hours write");
      assertEq(hoursAudit[0].field_name, "opening_hours_text", "i4: audit field_name is opening_hours_text");
      // Same string would be far too short for about_text — proves the floor
      // is per field rather than global.
      mkProvider({ id: "scf-hours-vs-about", navn: "Hours Vs About Gard", created_at: "2026-01-10 00:00:00" });
      const shortAboutRes = await callRoute(opplevelserRouter, {
        headers: auth,
        body: { provider_id: "scf-hours-vs-about", field: "about_text", value: "Man-fre 10-18", source: "s" },
      });
      assertEq(shortAboutRes.body.defect_type, "too_short", "i5: the SAME 13-char string is too_short for about_text");

      // ── (j) rollback round-trip on (c)'s overwrite ───────────────────────
      const rollbackPlan = store.planGardssalgContentRollback({
        provider_id: "scf-overwrite",
        field_name: "about_text",
      });
      assertEq(rollbackPlan.restorable.length, 1, "j1: rollback planner finds exactly one restorable field");
      assertEq(rollbackPlan.restorable[0]?.field_name, "about_text", "j2: restorable field is about_text");
      assertEq(rollbackPlan.restorable[0]?.current_value, GOOD_ABOUT_2, "j3: planner sees the new value as current");
      assertEq(rollbackPlan.restorable[0]?.restore_to, GOOD_ABOUT, "j4: planner proposes restoring the OLD value (no rollback-side change needed)");
      assertEq(rollbackPlan.skipped.length, 0, "j5: nothing skipped");

      // ── direct service-function coverage (mirrors route-level assertions) ─
      mkProvider({
        id: "scf-service-direct",
        navn: "Service Direct Gard",
        visit_text: "Gammel besøkstekst som skal byttes ut med en bedre en.",
        created_at: "2026-01-11 00:00:00",
      });
      const directResult = store.applyGardssalgSetContentField(
        "scf-service-direct",
        "visit_text",
        "Kom innom gårdsbutikken i helgene for smaking, omvisning og salg av egne produkter.",
        "manuell verifisering",
      );
      assertTrue(directResult.ok === true, "k1: direct service call succeeds on a clean visit_text");
      if (directResult.ok) {
        assertEq(directResult.old_value, "Gammel besøkstekst som skal byttes ut med en bedre en.", "k2: direct call returns the correct old_value");
      }
      const directReject = store.applyGardssalgSetContentField(
        "scf-service-direct", "visit_text", "For kort.", "manuell verifisering"
      );
      assertTrue(directReject.ok === false, "k3: direct service call blocked on a defective value");
      if (!directReject.ok) {
        assertEq(directReject.reason, "defective_value", "k4: direct rejection reports defective_value");
        assertEq(
          directReject.reason === "defective_value" ? directReject.defect_type : null,
          "too_short",
          "k5: direct rejection carries defect_type",
        );
      }
      const directNotFound = store.applyGardssalgSetContentField(
        "no-such-provider", "about_text", GOOD_ABOUT, "s"
      );
      assertTrue(!directNotFound.ok && directNotFound.reason === "provider_not_found", "k6: direct call reports provider_not_found");
    } finally {
      if (prevExperiencesDbPath === undefined) {
        delete process.env.EXPERIENCES_DB_PATH;
      } else {
        process.env.EXPERIENCES_DB_PATH = prevExperiencesDbPath;
      }
      if (prevAdminKey === undefined) {
        delete process.env.ADMIN_KEY;
      } else {
        process.env.ADMIN_KEY = prevAdminKey;
      }
      try {
        const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
        dbFactory.__resetDbFactoryForTesting();
      } catch {
        // best-effort cleanup
      }
      for (const p of cachePaths) delete require.cache[p];
    }

    return { passed, failed, failures };
  })();
}

// Standalone runner: `npx tsx src/routes/opplevelser-gardssalg-set-content-field.test.ts`
if (require.main === module) {
  runOpplevelserGardssalgSetContentFieldTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    process.exit(summary.failed > 0 ? 1 : 0);
  });
}
