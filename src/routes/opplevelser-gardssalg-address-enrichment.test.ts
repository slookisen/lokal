/**
 * opplevelser-gardssalg-address-enrichment.test.ts — tests for the gårdssalg
 * Brreg street-address backfill (dev-request 2026-07-18-gardssalg-
 * profilkvalitet-foer-outreach, slice 3):
 *
 *   - selectGardssalgProvidersForAddressEnrichment() / getGardssalgProviderAddressTarget()
 *     (src/services/experience-store.ts)
 *   - applyGardssalgProviderAddress() (src/services/experience-store.ts)
 *   - POST /admin/gardssalg-address-enrichment (src/routes/opplevelser.ts)
 *
 * Of the 74 gårdssalg producer profiles, only 42 have a street `adresse`
 * filled in. This slice backfills ONLY the missing address TEXT from Brreg —
 * it does not geocode anything (out of scope, experiences-geocode-worker.ts
 * already does that once adresse+postnummer are non-blank).
 *
 * Mirrors opplevelser-gardssalg-content-audit.test.ts's setup
 * (EXPERIENCES_DB_PATH=":memory:", fresh require of db-factory +
 * experience-store + opplevelser router per run, callRoute() exercised
 * directly against router.handle() with X-Admin-Key via headers). Route-
 * level Brreg calls are stubbed via globalThis.fetch (the route calls
 * fetchBrregBusinessAddress(org_nr) with no injected fetchImpl, so it always
 * uses the global fetch — same mocking convention as
 * admin-agents-brreg-description-fallback.test.ts).
 *
 * Covers:
 *   (a) selectGardssalgProvidersForAddressEnrichment: locked row excluded
 *   (b) catalog_hidden row excluded from selection
 *   (c) already-has-adresse row excluded from selection (nothing to backfill)
 *   (d) no org_nr row excluded from selection
 *   (e) applyGardssalgProviderAddress: fill-only — existing adresse never
 *       replaced even though postnummer/poststed are blank
 *   (f) partial-fill: postnummer already set -> only adresse+poststed written,
 *       postnummer untouched, audit row only for the fields actually written
 *   (g) audit row + field_provenance written correctly per field
 *   (h) idempotent second call on a now-fully-filled row is a no-op
 *   (i) locked provider (manual/claim) -> nothing written, no audit rows
 *   (j) route: unauthenticated -> 403
 *   (k) route: dry-run does not write to DB
 *   (l) route: apply writes
 *   (m) route: skipped_locked populated correctly (no Brreg call for locked)
 *   (n) route: unresolved populated when Brreg returns null / no street
 *   (o) route: errors populated on a thrown fetch exception
 *   (q) route: providerIds override on an already-fully-filled, non-locked
 *       provider where Brreg returns a redundant (already-covered) address
 *       -> lands in unresolved with reason "already_filled" (not silently
 *       dropped from every bucket), changed[] stays empty, DB row/audit
 *       trail untouched
 *   (p) rollback: an address field written by applyGardssalgProviderAddress
 *       IS rollback-eligible via planGardssalgContentRollback/
 *       applyGardssalgContentRollback — the same functions backing POST
 *       /admin/gardssalg-content-rollback (src/services/experience-store.ts's
 *       GARDSSALG_ROLLBACKABLE_FIELDS must include adresse/postnummer/
 *       poststed, not just the original about_text/visit_text/
 *       opening_hours_text three) — single-field rollback, batch_id rollback
 *       across the remaining fields, and the rollback itself being audited
 *
 * Round-2 regressions (a second scanned-but-dropped-from-every-bucket gap,
 * one level deeper than (q)'s pre-write check — this time in the POST-write
 * check, where applyGardssalgProviderAddress's own fresh DB read at write
 * time can find every target field already filled even though the loop's
 * earlier wouldWrite snapshot said otherwise):
 *   (r) providerIds with a duplicate id, apply:true -> the duplicate is
 *       de-duplicated up front (first occurrence wins), so it is scanned
 *       and written exactly once: scanned reflects the DEDUPED count, the
 *       id appears in exactly one bucket (changed), and only one set of
 *       audit rows is written (no double-write from the duplicate)
 *   (s) the same dead end reached WITHOUT a duplicate id — via ordinary
 *       concurrency (a "concurrent" write lands in the gap between the
 *       route's pre-loop snapshot and its own write call, simulated inside
 *       the mocked Brreg fetch): applyGardssalgProviderAddress's fresh
 *       write-time read finds the row already filled, written:[] comes
 *       back, and the route now routes this to `unresolved` (reason
 *       "already_filled_at_write_time") instead of silently dropping it —
 *       the general fix, independent of the (r) de-dup, since (s) uses a
 *       single non-duplicate id
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
    const url = opts.url || "/admin/gardssalg-address-enrichment";
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

export function runOpplevelserGardssalgAddressEnrichmentTests(
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
    const prevFetch = globalThis.fetch;
    const testKey = "gardssalg-address-enrichment-test-key";
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

      const brregClient = require("../services/brreg-client") as typeof import("../services/brreg-client");
      brregClient.__clearBrregAddressCacheForTesting();

      const insertProvider = expDb.prepare(
        `INSERT INTO experience_providers
           (id, navn, vertical, org_nr, content_source, adresse, postnummer, poststed,
            producer_type, enrichment_state, verification_status, source, confidence,
            catalog_hidden, created_at)
         VALUES
           (@id, @navn, 'experiences', @org_nr, @content_source, @adresse, @postnummer, @poststed,
            'cideri', 'raw', 'pending_verify', 'test-fixture', 'medium',
            @catalog_hidden, @created_at)`,
      );

      function getProviderRow(id: string): any {
        return expDb.prepare(
          `SELECT id, adresse, postnummer, poststed, content_source, field_provenance
             FROM experience_providers WHERE id = ?`
        ).get(id);
      }
      function getAuditRows(providerId: string): any[] {
        return expDb.prepare(
          `SELECT * FROM gardssalg_content_audit WHERE provider_id = ? ORDER BY rowid ASC`
        ).all(providerId);
      }

      // ── Fixture rows for selection tests (a)-(d) ─────────────────────────
      insertProvider.run({
        id: "sel-eligible", navn: "Sel Eligible Gard", org_nr: "910000001",
        content_source: null, adresse: null, postnummer: null, poststed: null,
        catalog_hidden: null, created_at: "2026-01-01 00:00:00",
      });
      insertProvider.run({
        id: "sel-locked", navn: "Sel Locked Gard", org_nr: "910000002",
        content_source: "manual", adresse: null, postnummer: null, poststed: null,
        catalog_hidden: null, created_at: "2026-01-02 00:00:00",
      });
      insertProvider.run({
        id: "sel-hidden", navn: "Sel Hidden Gard", org_nr: "910000003",
        content_source: null, adresse: null, postnummer: null, poststed: null,
        catalog_hidden: 1, created_at: "2026-01-03 00:00:00",
      });
      insertProvider.run({
        id: "sel-has-adresse", navn: "Sel Has Adresse Gard", org_nr: "910000004",
        content_source: null, adresse: "Alt Utfylt 1", postnummer: "1000", poststed: "Oslo",
        catalog_hidden: null, created_at: "2026-01-04 00:00:00",
      });
      insertProvider.run({
        id: "sel-no-orgnr", navn: "Sel No Orgnr Gard", org_nr: null,
        content_source: null, adresse: null, postnummer: null, poststed: null,
        catalog_hidden: null, created_at: "2026-01-05 00:00:00",
      });

      const selected = store.selectGardssalgProvidersForAddressEnrichment(48);
      const selectedIds = selected.map((s) => s.id);

      assertTrue(selectedIds.includes("sel-eligible"), "sel1: eligible blank-adresse row is selected");
      assertTrue(!selectedIds.includes("sel-locked"), "a: locked (manual) row is excluded from selection");
      assertTrue(!selectedIds.includes("sel-hidden"), "b: catalog_hidden row is excluded from selection");
      assertTrue(!selectedIds.includes("sel-has-adresse"), "c: already-has-adresse row is excluded from selection");
      assertTrue(!selectedIds.includes("sel-no-orgnr"), "d: no-org_nr row is excluded from selection");

      // getGardssalgProviderAddressTarget: explicit override lookups.
      assertTrue(store.getGardssalgProviderAddressTarget("sel-eligible") !== null, "override1: eligible row resolves via explicit lookup");
      assertTrue(store.getGardssalgProviderAddressTarget("sel-no-orgnr") === null, "override2: no-org_nr row -> null (required field missing)");
      assertTrue(store.getGardssalgProviderAddressTarget("does-not-exist") === null, "override3: nonexistent id -> null");
      // Explicit override bypasses the blank-adresse/lock filters (mirrors
      // getGardssalgProviderContentTarget's override semantics) — a locked
      // or already-filled row still resolves via direct id lookup.
      assertTrue(store.getGardssalgProviderAddressTarget("sel-locked") !== null, "override4: locked row still resolves via explicit override (lock is enforced at write time, not lookup time)");
      assertTrue(store.getGardssalgProviderAddressTarget("sel-has-adresse") !== null, "override5: already-filled row still resolves via explicit override");

      // ── applyGardssalgProviderAddress fixtures (e)-(i) ───────────────────
      insertProvider.run({
        id: "apply-fill-only", navn: "Apply Fill Only Gard", org_nr: "910000010",
        content_source: null, adresse: "Eksisterende Vei 5", postnummer: null, poststed: null,
        catalog_hidden: null, created_at: "2026-01-01 00:00:00",
      });
      insertProvider.run({
        id: "apply-partial", navn: "Apply Partial Gard", org_nr: "910000011",
        content_source: null, adresse: null, postnummer: "2850", poststed: null,
        catalog_hidden: null, created_at: "2026-01-01 00:00:00",
      });
      insertProvider.run({
        id: "apply-locked", navn: "Apply Locked Gard", org_nr: "910000012",
        content_source: "claim", adresse: null, postnummer: null, poststed: null,
        catalog_hidden: null, created_at: "2026-01-01 00:00:00",
      });

      // (e) fill-only: adresse already set -> never replaced, even though
      //     postnummer/poststed are blank and the candidate has all three.
      const writtenE = store.applyGardssalgProviderAddress(
        "apply-fill-only",
        { adresse: "Ny Kandidat Vei 9", postnummer: "1234", poststed: "Nystad" },
        "https://data.brreg.no/enhetsregisteret/api/enheter/910000010",
      );
      assertEq(writtenE.sort(), ["poststed", "postnummer"].sort(), "e1: fill-only writes the blank fields, never the already-set adresse");
      const rowE = getProviderRow("apply-fill-only");
      assertEq(rowE.adresse, "Eksisterende Vei 5", "e2: existing adresse is left completely untouched");
      assertEq(rowE.postnummer, "1234", "e3: blank postnummer is filled from the candidate");
      assertEq(rowE.poststed, "Nystad", "e4: blank poststed is filled from the candidate");
      const auditE = getAuditRows("apply-fill-only");
      assertEq(auditE.length, 2, "e5: exactly 2 audit rows (postnummer + poststed only, not adresse)");
      assertTrue(!auditE.some((r: any) => r.field_name === "adresse"), "e6: no audit row for the untouched adresse field");

      // (f) partial-fill: postnummer already set -> only adresse+poststed
      //     written, postnummer untouched, audit row only for written fields.
      const writtenF = store.applyGardssalgProviderAddress(
        "apply-partial",
        { adresse: "Partiell Vei 3", postnummer: "9999", poststed: "Bygda" },
        "https://data.brreg.no/enhetsregisteret/api/enheter/910000011",
        "batch-ae-1",
      );
      assertEq(writtenF.sort(), ["adresse", "poststed"].sort(), "f1: partial-fill writes only the blank fields");
      const rowF = getProviderRow("apply-partial");
      assertEq(rowF.adresse, "Partiell Vei 3", "f2: blank adresse written from candidate");
      assertEq(rowF.postnummer, "2850", "f3: already-set postnummer is untouched (candidate's 9999 ignored)");
      assertEq(rowF.poststed, "Bygda", "f4: blank poststed written from candidate");
      const auditF = getAuditRows("apply-partial");
      assertEq(auditF.length, 2, "f5: exactly 2 audit rows (adresse + poststed), none for postnummer");
      assertTrue(!auditF.some((r: any) => r.field_name === "postnummer"), "f6: no audit row for the untouched postnummer field");

      // (g) audit row + field_provenance correctness.
      const adresseAuditF = auditF.find((r: any) => r.field_name === "adresse");
      assertTrue(!!adresseAuditF, "g1: an adresse audit row exists");
      assertEq(adresseAuditF.old_value, null, "g2: audit old_value is null (was blank before this write)");
      assertEq(adresseAuditF.new_value, "Partiell Vei 3", "g3: audit new_value matches the written value");
      assertEq(adresseAuditF.source_url, "https://data.brreg.no/enhetsregisteret/api/enheter/910000011", "g4: audit source_url matches evidenceUrl");
      assertEq(adresseAuditF.batch_id, "batch-ae-1", "g5: audit batch_id matches the batchId param");
      assertEq(adresseAuditF.changed_by, "system", "g6: audit changed_by defaults to 'system'");
      const provenanceF = JSON.parse(rowF.field_provenance);
      assertTrue(!!provenanceF.adresse, "g7: field_provenance has an adresse entry");
      assertEq(provenanceF.adresse.source_url, "https://data.brreg.no/enhetsregisteret/api/enheter/910000011", "g8: field_provenance.adresse.source_url matches evidenceUrl");
      assertTrue(typeof provenanceF.adresse.fetched_at === "string" && provenanceF.adresse.fetched_at.length > 0, "g9: field_provenance.adresse.fetched_at is a non-empty timestamp");
      assertTrue(!!provenanceF.poststed, "g10: field_provenance also has a poststed entry");
      assertTrue(!("postnummer" in provenanceF), "g11: field_provenance has NO postnummer entry (it was never written)");
      assertEq(rowF.content_source, null, "g12: content_source is deliberately NOT stamped by address enrichment");

      // (h) idempotent second call on a now-fully-filled row is a no-op.
      const writtenH = store.applyGardssalgProviderAddress(
        "apply-partial",
        { adresse: "Enda En Vei 7", postnummer: "0000", poststed: "Annenby" },
        "https://data.brreg.no/enhetsregisteret/api/enheter/910000011",
      );
      assertEq(writtenH, [], "h1: second call on a fully-filled row writes nothing");
      const rowH = getProviderRow("apply-partial");
      assertEq(rowH.adresse, "Partiell Vei 3", "h2: adresse unchanged by the idempotent second call");
      assertEq(getAuditRows("apply-partial").length, 2, "h3: no new audit rows from the idempotent second call");

      // (i) locked provider -> nothing written, no audit rows.
      const writtenI = store.applyGardssalgProviderAddress(
        "apply-locked",
        { adresse: "Forsøk Vei 1", postnummer: "1111", poststed: "Forsøksby" },
        "https://data.brreg.no/enhetsregisteret/api/enheter/910000012",
      );
      assertEq(writtenI, [], "i1: locked (claim) provider -> nothing written");
      const rowI = getProviderRow("apply-locked");
      assertEq(rowI.adresse, null, "i2: locked provider's adresse remains blank");
      assertEq(getAuditRows("apply-locked").length, 0, "i3: locked provider produces zero audit rows");

      // ── Route tests (j)-(o) ──────────────────────────────────────────────

      // (j) unauthenticated -> 403.
      const noKeyRes = await callRoute(opplevelserRouter, { body: {} });
      assertEq(noKeyRes.status, 403, "j1: missing X-Admin-Key -> 403");

      // Fixtures for the route-level tests.
      insertProvider.run({
        id: "route-fillable", navn: "Route Fillable Gard", org_nr: "920000001",
        content_source: null, adresse: null, postnummer: null, poststed: null,
        catalog_hidden: null, created_at: "2026-02-01 00:00:00",
      });
      insertProvider.run({
        id: "route-locked", navn: "Route Locked Gard", org_nr: "920000002",
        content_source: "manual", adresse: null, postnummer: null, poststed: null,
        catalog_hidden: null, created_at: "2026-02-01 00:00:00",
      });
      insertProvider.run({
        id: "route-unresolved", navn: "Route Unresolved Gard", org_nr: "920000003",
        content_source: null, adresse: null, postnummer: null, poststed: null,
        catalog_hidden: null, created_at: "2026-02-01 00:00:00",
      });
      // NOTE: fetchBrregBusinessAddress never throws (same never-throws
      // contract as verifyOrgNumber/fetchBrregActivityDescription — a
      // network/fetch failure resolves to null internally). So a Brreg-side
      // network failure surfaces at the route as "unresolved" (see
      // route-net-fail below, folded into the (n) unresolved checks), NOT
      // "errors" — the route's try/catch around the fetchBrregBusinessAddress
      // call is defense-in-depth for a genuinely unexpected throw, not a
      // reachable normal-path branch. The realistic "errors" path is a write
      // failure during apply (write_failed:, exercised separately below by
      // dropping gardssalg_content_audit to force applyGardssalgProviderAddress
      // to throw — mirrors the sibling content-refresh route's write_failed
      // error shape).
      insertProvider.run({
        id: "route-net-fail", navn: "Route Net Fail Gard", org_nr: "920000004",
        content_source: null, adresse: null, postnummer: null, poststed: null,
        catalog_hidden: null, created_at: "2026-02-01 00:00:00",
      });

      globalThis.fetch = (async (url: string | URL | Request) => {
        const u = String(url);
        if (u.includes("/enheter/920000001")) {
          return {
            ok: true, status: 200,
            json: async () => ({
              organisasjonsnummer: "920000001",
              navn: "Route Fillable Gard",
              forretningsadresse: { adresse: ["Fillbar Vei 4"], postnummer: "3000", poststed: "Fillby" },
            }),
          } as unknown as Response;
        }
        if (u.includes("/enheter/920000003")) {
          // No usable street address anywhere -> unresolved.
          return {
            ok: true, status: 200,
            json: async () => ({
              organisasjonsnummer: "920000003",
              navn: "Route Unresolved Gard",
              forretningsadresse: { adresse: [], postnummer: "3000", poststed: "Fillby" },
            }),
          } as unknown as Response;
        }
        if (u.includes("/enheter/920000004")) {
          // Simulates a Brreg-side network failure. fetchBrregBusinessAddress
          // catches this internally and resolves to null (never throws) —
          // so from the route's perspective this is indistinguishable from
          // "no usable address" and correctly lands in `unresolved`, not
          // `errors`. See the comment above route-net-fail's insertProvider
          // call.
          throw new Error("simulated network failure");
        }
        return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
      }) as typeof fetch;

      // (k) dry-run: no DB writes.
      const dryRes = await callRoute(opplevelserRouter, {
        headers: { "x-admin-key": testKey },
        body: {
          providerIds: ["route-fillable", "route-locked", "route-unresolved", "route-net-fail"],
          apply: false,
        },
      });
      assertEq(dryRes.status, 200, "k1: dry-run -> 200");
      assertEq(dryRes.body.dry_run, true, "k2: dry_run:true");
      const dryFillable = dryRes.body.changed.find((c: any) => c.provider_id === "route-fillable");
      assertTrue(!!dryFillable, "k3: route-fillable appears in dry-run changed[]");
      assertTrue(
        dryFillable.fields.includes("adresse") && dryFillable.fields.includes("postnummer") && dryFillable.fields.includes("poststed"),
        "k4: dry-run projects all three blank fields as fillable",
      );
      assertTrue(!!dryFillable.provenance.adresse?.source_url, "k5: dry-run provenance carries a source_url per field");
      const rowBeforeApply = getProviderRow("route-fillable");
      assertEq(rowBeforeApply.adresse, null, "k6: dry-run performed ZERO writes — route-fillable adresse still blank");

      // skipped_locked / unresolved populated even in dry-run. A Brreg-side
      // network failure (route-net-fail) also lands in unresolved — see the
      // never-throws note above.
      assertTrue(dryRes.body.skipped_locked.includes("route-locked"), "m1: route-locked -> skipped_locked (dry-run)");
      assertTrue(
        dryRes.body.unresolved.some((u: any) => u.provider_id === "route-unresolved" && u.reason === "no_brreg_street_address"),
        "n1: route-unresolved -> unresolved with reason no_brreg_street_address (dry-run)",
      );
      assertTrue(
        dryRes.body.unresolved.some((u: any) => u.provider_id === "route-net-fail" && u.reason === "no_brreg_street_address"),
        "n1b: route-net-fail (Brreg network failure) also lands in unresolved, since fetchBrregBusinessAddress never throws",
      );
      assertEq(dryRes.body.errors, [], "o0: errors[] is empty in dry-run — no exception ever escapes fetchBrregBusinessAddress");
      // scanned excludes the locked skip (never reaches Brreg) but includes
      // the other three (all of which DO reach fetchBrregBusinessAddress).
      assertEq(dryRes.body.scanned, 3, "scanned1: scanned excludes locked, includes fillable+unresolved+net-fail");

      // (l) apply: true -> actually writes.
      const applyRes = await callRoute(opplevelserRouter, {
        headers: { "x-admin-key": testKey },
        body: {
          providerIds: ["route-fillable", "route-locked", "route-unresolved", "route-net-fail"],
          apply: true,
        },
      });
      assertEq(applyRes.status, 200, "l1: apply -> 200");
      assertEq(applyRes.body.dry_run, false, "l2: dry_run:false");
      const applyFillable = applyRes.body.changed.find((c: any) => c.provider_id === "route-fillable");
      assertTrue(!!applyFillable, "l3: route-fillable appears in apply changed[]");
      const rowAfterApply = getProviderRow("route-fillable");
      assertEq(rowAfterApply.adresse, "Fillbar Vei 4", "l4: route-fillable adresse actually written");
      assertEq(rowAfterApply.postnummer, "3000", "l5: route-fillable postnummer actually written");
      assertEq(rowAfterApply.poststed, "Fillby", "l6: route-fillable poststed actually written");
      assertEq(applyRes.body.agents_enriched, applyRes.body.changed.length, "l7: agents_enriched === changed.length");

      const rowLockedAfterApply = getProviderRow("route-locked");
      assertEq(rowLockedAfterApply.adresse, null, "m2: route-locked still untouched after apply");
      assertTrue(applyRes.body.skipped_locked.includes("route-locked"), "m3: route-locked -> skipped_locked (apply)");

      const rowUnresolvedAfterApply = getProviderRow("route-unresolved");
      assertEq(rowUnresolvedAfterApply.adresse, null, "n2: route-unresolved still untouched after apply");
      assertTrue(
        applyRes.body.unresolved.some((u: any) => u.provider_id === "route-unresolved" && u.reason === "no_brreg_street_address"),
        "n3: route-unresolved -> unresolved with reason no_brreg_street_address (apply)",
      );

      assertTrue(
        applyRes.body.unresolved.some((u: any) => u.provider_id === "route-net-fail" && u.reason === "no_brreg_street_address"),
        "n3b: route-net-fail also lands in unresolved on apply (never throws)",
      );
      assertEq(applyRes.body.errors, [], "o1: errors[] is empty on apply too — no Brreg exception ever escapes fetchBrregBusinessAddress");

      // ── Regression: providerIds override on an already-fully-filled,
      //    non-locked provider (sel-has-adresse, the exact fixture "override5"
      //    above proved still resolves via getGardssalgProviderAddressTarget)
      //    — Brreg returns a usable but now-redundant address (all three
      //    target fields are already non-blank, so there's nothing to fill).
      //    Must land in `unresolved` with reason "already_filled", NOT be
      //    silently dropped via a bare `continue` that leaves it out of
      //    changed/skipped_locked/unresolved/errors despite scanned:1 —
      //    the exact bug this test guards against. ─────────────────────────
      globalThis.fetch = (async (url: string | URL | Request) => {
        const u = String(url);
        if (u.includes("/enheter/910000004")) {
          return {
            ok: true, status: 200,
            json: async () => ({
              organisasjonsnummer: "910000004",
              navn: "Sel Has Adresse Gard",
              forretningsadresse: { adresse: ["Redundant Vei 2"], postnummer: "9000", poststed: "Redundantby" },
            }),
          } as unknown as Response;
        }
        return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
      }) as typeof fetch;

      const alreadyFilledRes = await callRoute(opplevelserRouter, {
        headers: { "x-admin-key": testKey },
        body: { providerIds: ["sel-has-adresse"], apply: true },
      });
      assertEq(alreadyFilledRes.status, 200, "q1: already-filled override route call -> 200");
      assertEq(alreadyFilledRes.body.scanned, 1, "q2: scanned:1 (Brreg WAS called — providerIds bypasses the blank-adresse selection filter)");
      assertTrue(
        alreadyFilledRes.body.unresolved.some((u: any) => u.provider_id === "sel-has-adresse" && u.reason === "already_filled"),
        "q3: sel-has-adresse lands in unresolved with reason already_filled, not silently dropped from every bucket",
      );
      assertTrue(
        !alreadyFilledRes.body.changed.some((c: any) => c.provider_id === "sel-has-adresse"),
        "q4: sel-has-adresse does NOT appear in changed[]",
      );
      assertTrue(
        !alreadyFilledRes.body.skipped_locked.includes("sel-has-adresse"),
        "q5: sel-has-adresse does NOT appear in skipped_locked[] (it isn't locked)",
      );
      assertEq(
        alreadyFilledRes.body.errors.filter((e: any) => e.provider_id === "sel-has-adresse"),
        [],
        "q6: sel-has-adresse does NOT appear in errors[]",
      );
      const rowSelHasAdresseAfter = getProviderRow("sel-has-adresse");
      assertEq(rowSelHasAdresseAfter.adresse, "Alt Utfylt 1", "q7: DB row adresse untouched — still the original value, not the redundant Brreg one");
      assertEq(rowSelHasAdresseAfter.postnummer, "1000", "q8: DB row postnummer untouched");
      assertEq(rowSelHasAdresseAfter.poststed, "Oslo", "q9: DB row poststed untouched");
      assertEq(getAuditRows("sel-has-adresse").length, 0, "q10: zero audit rows inserted for sel-has-adresse");

      // ── (r) Round-2 regression: duplicate id in providerIds, apply:true.
      //     Round 1 fixed the PRE-write wouldWrite.length===0 dead end (block
      //     q above). This is the reviewer's second, deeper repro: a
      //     duplicate id in providerIds meant the SAME row was processed
      //     twice against one stale pre-loop snapshot — the first pass wrote
      //     it and landed in changed[], the second pass's snapshot still
      //     thought fields were blank, called applyGardssalgProviderAddress
      //     again, got written:[] back (the row was already filled by pass
      //     one), and vanished from every bucket while `scanned` still
      //     counted it (scanned:2, only 1 total bucket entry). Fixed by
      //     de-duplicating providerIds up front (first occurrence wins) —
      //     so the duplicate is only ever processed once. ─────────────────
      insertProvider.run({
        id: "dup-p1", navn: "Dup P1 Gard", org_nr: "950000001",
        content_source: null, adresse: null, postnummer: null, poststed: null,
        catalog_hidden: null, created_at: "2026-02-01 00:00:00",
      });
      globalThis.fetch = (async (url: string | URL | Request) => {
        const u = String(url);
        if (u.includes("/enheter/950000001")) {
          return {
            ok: true, status: 200,
            json: async () => ({
              organisasjonsnummer: "950000001",
              navn: "Dup P1 Gard",
              forretningsadresse: { adresse: ["Duplikat Vei 1"], postnummer: "5000", poststed: "Dupby" },
            }),
          } as unknown as Response;
        }
        return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
      }) as typeof fetch;

      const dupRes = await callRoute(opplevelserRouter, {
        headers: { "x-admin-key": testKey },
        body: { providerIds: ["dup-p1", "dup-p1"], apply: true },
      });
      assertEq(dupRes.status, 200, "r1: duplicate-providerIds apply route call -> 200");
      assertEq(dupRes.body.scanned, 1, "r2: scanned reflects the DEDUPED count (1), not the raw array length (2)");
      const dupBucketHits =
        dupRes.body.changed.filter((c: any) => c.provider_id === "dup-p1").length +
        dupRes.body.skipped_locked.filter((id: string) => id === "dup-p1").length +
        dupRes.body.unresolved.filter((u: any) => u.provider_id === "dup-p1").length +
        dupRes.body.errors.filter((e: any) => e.provider_id === "dup-p1").length;
      assertEq(dupBucketHits, 1, "r3: dup-p1 appears in exactly ONE bucket total across all four, not zero and not two");
      assertTrue(
        dupRes.body.changed.some((c: any) => c.provider_id === "dup-p1"),
        "r4: dup-p1 lands in changed[] (the single deduped pass actually writes it)",
      );
      const rowDupAfter = getProviderRow("dup-p1");
      assertEq(rowDupAfter.adresse, "Duplikat Vei 1", "r5: dup-p1's row was written exactly once, from the single deduped pass");
      assertEq(getAuditRows("dup-p1").length, 3, "r6: exactly 3 audit rows (adresse+postnummer+poststed), not 6 — no double-write from the duplicate id");

      // ── (s) Round-2 regression, deeper root cause: the SAME dead end is
      //     reachable WITHOUT any duplicate id — via ordinary concurrency.
      //     No row lock is held across this loop, so a second request (or
      //     any other writer) can fill a row's fields in the window between
      //     this loop capturing `t` (the pre-loop snapshot wouldWrite is
      //     computed from) and this loop's own call to
      //     applyGardssalgProviderAddress. That call does a FRESH DB read at
      //     write time, so it correctly writes nothing (written:[]) — but
      //     pre-fix, the route silently dropped the result on the floor
      //     instead of routing it to `unresolved`. Simulated here by having
      //     the mocked Brreg fetch itself perform a "concurrent" write to
      //     the row (filling all three target fields) before resolving —
      //     the awaited fetch is exactly the gap between the pre-loop
      //     snapshot and the write call. This is the general fix (the
      //     written.length === 0 -> unresolved fallback), independent of
      //     the providerIds de-dup above (a single, non-duplicate id is used
      //     here). ─────────────────────────────────────────────────────────
      insertProvider.run({
        id: "race-fill", navn: "Race Fill Gard", org_nr: "950000002",
        content_source: null, adresse: null, postnummer: null, poststed: null,
        catalog_hidden: null, created_at: "2026-02-01 00:00:00",
      });
      const updateRaceFillRow = expDb.prepare(
        `UPDATE experience_providers SET adresse = ?, postnummer = ?, poststed = ? WHERE id = 'race-fill'`
      );
      globalThis.fetch = (async (url: string | URL | Request) => {
        const u = String(url);
        if (u.includes("/enheter/950000002")) {
          // Simulate a concurrent writer landing in the gap between this
          // route's pre-loop target snapshot and its own write.
          updateRaceFillRow.run("Konkurrent Vei 1", "6000", "Konkby");
          return {
            ok: true, status: 200,
            json: async () => ({
              organisasjonsnummer: "950000002",
              navn: "Race Fill Gard",
              forretningsadresse: { adresse: ["Race Kandidat Vei 2"], postnummer: "6100", poststed: "Racestad" },
            }),
          } as unknown as Response;
        }
        return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
      }) as typeof fetch;

      const raceRes = await callRoute(opplevelserRouter, {
        headers: { "x-admin-key": testKey },
        body: { providerIds: ["race-fill"], apply: true },
      });
      assertEq(raceRes.status, 200, "s1: race-fill apply route call -> 200");
      assertEq(raceRes.body.scanned, 1, "s2: scanned:1 (Brreg WAS called, once, for the single id)");
      const raceBucketHits =
        raceRes.body.changed.filter((c: any) => c.provider_id === "race-fill").length +
        raceRes.body.skipped_locked.filter((id: string) => id === "race-fill").length +
        raceRes.body.unresolved.filter((u: any) => u.provider_id === "race-fill").length +
        raceRes.body.errors.filter((e: any) => e.provider_id === "race-fill").length;
      assertEq(raceBucketHits, 1, "s3: race-fill appears in exactly ONE bucket total — not silently dropped from all four");
      assertTrue(
        raceRes.body.unresolved.some((u: any) => u.provider_id === "race-fill" && u.reason === "already_filled_at_write_time"),
        "s4: race-fill lands in unresolved with reason already_filled_at_write_time (the fresh write-time read found it already filled)",
      );
      assertTrue(
        !raceRes.body.changed.some((c: any) => c.provider_id === "race-fill"),
        "s5: race-fill does NOT appear in changed[] (applyGardssalgProviderAddress correctly wrote nothing)",
      );
      const rowRaceAfter = getProviderRow("race-fill");
      assertEq(rowRaceAfter.adresse, "Konkurrent Vei 1", "s6: the row still holds the concurrent writer's value, not the route's redundant candidate");
      assertEq(getAuditRows("race-fill").length, 0, "s7: zero audit rows from this route call (it wrote nothing — the concurrent writer isn't audited by this path)");

      // ── (p) rollback: an address field written by applyGardssalgProviderAddress
      //       IS rollback-eligible through planGardssalgContentRollback/
      //       applyGardssalgContentRollback — the exact functions backing POST
      //       /admin/gardssalg-content-rollback. Regression for the gap where
      //       GARDSSALG_ROLLBACKABLE_FIELDS only listed the original three
      //       content fields and silently skipped adresse/postnummer/poststed
      //       audit rows as "unknown_field". Runs BEFORE block (o) below,
      //       which DROPs gardssalg_content_audit to force a write failure —
      //       this block needs that table intact. ─────────────────────────────
      insertProvider.run({
        id: "rollback-address", navn: "Rollback Address Gard", org_nr: "930000001",
        content_source: null, adresse: null, postnummer: null, poststed: null,
        catalog_hidden: null, created_at: "2026-02-01 00:00:00",
      });

      const writtenRB = store.applyGardssalgProviderAddress(
        "rollback-address",
        { adresse: "Rollback Vei 1", postnummer: "1450", poststed: "Rollbyen" },
        "https://data.brreg.no/enhetsregisteret/api/enheter/930000001",
        "batch-rb-1",
      );
      assertEq(writtenRB.sort(), ["adresse", "poststed", "postnummer"].sort(), "p1: applyGardssalgProviderAddress writes all three blank address fields");
      const rowRBBefore = getProviderRow("rollback-address");
      assertEq(rowRBBefore.adresse, "Rollback Vei 1", "p2: adresse written before rollback");
      assertEq(getAuditRows("rollback-address").length, 3, "p3: 3 audit rows exist (adresse + postnummer + poststed)");

      // Single-field rollback (adresse) via the SAME plan()/apply() functions
      // the route calls — first prove it's no longer skipped as
      // "unknown_field" (the exact bug this regression test guards against),
      // then that applying it restores the exact prior (blank) value.
      const rbPlan = store.planGardssalgContentRollback({ provider_id: "rollback-address", field_name: "adresse" });
      assertEq(rbPlan.skipped, [], "p4: adresse is NOT skipped as unknown_field — it is now in GARDSSALG_ROLLBACKABLE_FIELDS");
      assertEq(rbPlan.restorable.length, 1, "p5: adresse is restorable");
      assertEq(rbPlan.restorable[0].current_value, "Rollback Vei 1", "p6: plan reports the current (written) value");
      assertEq(rbPlan.restorable[0].restore_to, null, "p7: plan reports it would restore to null (the original blank value)");

      const rbApplied = store.applyGardssalgContentRollback(rbPlan.restorable);
      assertEq(rbApplied, [{ provider_id: "rollback-address", field_name: "adresse", restored_to: null }], "p8: applyGardssalgContentRollback restores adresse to null");

      const rowRBAfterSingle = getProviderRow("rollback-address");
      assertEq(rowRBAfterSingle.adresse, null, "p9: adresse is restored to its exact original blank value");
      assertEq(rowRBAfterSingle.postnummer, "1450", "p10: rolling back ONE field (adresse) leaves the others (postnummer) untouched");
      assertEq(rowRBAfterSingle.poststed, "Rollbyen", "p11: rolling back ONE field (adresse) leaves the others (poststed) untouched");

      // The rollback itself is audited (old_value = pre-rollback value,
      // new_value = restored value, source_url carries the rollback marker) —
      // same guarantee already proven for about_text in
      // opplevelser-gardssalg-content-audit.test.ts's (f) block.
      const auditRBAfterSingle = getAuditRows("rollback-address");
      assertEq(auditRBAfterSingle.length, 4, "p12: a NEW audit row exists after the rollback (3 -> 4)");
      const rollbackAuditRowRB = auditRBAfterSingle[auditRBAfterSingle.length - 1];
      assertEq(rollbackAuditRowRB.field_name, "adresse", "p13: the new audit row is for adresse");
      assertEq(rollbackAuditRowRB.old_value, "Rollback Vei 1", "p14: rollback audit old_value = the value immediately before the rollback");
      assertEq(rollbackAuditRowRB.new_value, null, "p15: rollback audit new_value = the restored (blank) value");
      assertEq(rollbackAuditRowRB.changed_by, "system", "p16: rollback audit changed_by = 'system'");
      assertTrue(
        typeof rollbackAuditRowRB.source_url === "string" && rollbackAuditRowRB.source_url.includes("rollback"),
        "p17: rollback audit row is marked as a rollback (source_url carries a rollback marker)",
      );

      // Batch-id rollback restores the remaining two address fields
      // (postnummer, poststed — both written under batch-rb-1) end-to-end
      // through the actual HTTP route, exercising the same
      // POST /admin/gardssalg-content-rollback path a real admin would use.
      const rbBatchApply = await callRoute(opplevelserRouter, {
        url: "/admin/gardssalg-content-rollback",
        headers: { "x-admin-key": testKey },
        body: { batch_id: "batch-rb-1", apply: true },
      });
      assertEq(rbBatchApply.status, 200, "p18: batch rollback route call -> 200");
      assertTrue(
        rbBatchApply.body.restored.some((r: any) => r.provider_id === "rollback-address" && r.field_name === "postnummer") &&
        rbBatchApply.body.restored.some((r: any) => r.provider_id === "rollback-address" && r.field_name === "poststed"),
        "p19: batch rollback restores both remaining address fields (postnummer, poststed)",
      );

      const rowRBAfterBatch = getProviderRow("rollback-address");
      assertEq(rowRBAfterBatch.adresse, null, "p20: adresse still blank after the batch rollback");
      assertEq(rowRBAfterBatch.postnummer, null, "p21: postnummer restored to blank by the batch rollback");
      assertEq(rowRBAfterBatch.poststed, null, "p22: poststed restored to blank by the batch rollback");
      assertEq(getAuditRows("rollback-address").length, 6, "p23: audit trail now has 6 rows total (3 writes + 3 rollbacks)");

      // (o) errors[]: the realistic error path is a WRITE failure during
      // apply (write_failed:), mirroring the sibling content-refresh route's
      // errors shape — forced here by dropping gardssalg_content_audit so
      // applyGardssalgProviderAddress's own transaction throws.
      insertProvider.run({
        id: "route-write-fail", navn: "Route Write Fail Gard", org_nr: "920000005",
        content_source: null, adresse: null, postnummer: null, poststed: null,
        catalog_hidden: null, created_at: "2026-02-01 00:00:00",
      });
      globalThis.fetch = (async (url: string | URL | Request) => {
        const u = String(url);
        if (u.includes("/enheter/920000005")) {
          return {
            ok: true, status: 200,
            json: async () => ({
              organisasjonsnummer: "920000005",
              navn: "Route Write Fail Gard",
              forretningsadresse: { adresse: ["Skriveveien 1"], postnummer: "4000", poststed: "Skrivby" },
            }),
          } as unknown as Response;
        }
        return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
      }) as typeof fetch;
      expDb.exec("DROP TABLE gardssalg_content_audit");
      const writeFailRes = await callRoute(opplevelserRouter, {
        headers: { "x-admin-key": testKey },
        body: { providerIds: ["route-write-fail"], apply: true },
      });
      assertEq(writeFailRes.status, 200, "o2: a write failure is a 200 with the failure reported in errors[], not a 500");
      assertTrue(
        writeFailRes.body.errors.some((e: any) => e.provider_id === "route-write-fail" && typeof e.error === "string" && e.error.startsWith("write_failed:")),
        "o3: route-write-fail -> errors[] with a write_failed: prefix (mirrors the sibling content-refresh route's error shape)",
      );
    } catch (err: any) {
      failed++;
      failures.push("opplevelser-gardssalg-address-enrichment: unexpected error: " + String(err?.stack || err?.message || err));
    } finally {
      globalThis.fetch = prevFetch;
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

// Standalone runner: `npx tsx src/routes/opplevelser-gardssalg-address-enrichment.test.ts`
if (require.main === module) {
  runOpplevelserGardssalgAddressEnrichmentTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    process.exit(summary.failed > 0 ? 1 : 0);
  });
}
