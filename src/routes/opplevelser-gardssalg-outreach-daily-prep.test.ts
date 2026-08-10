/**
 * opplevelser-gardssalg-outreach-daily-prep.test.ts — tests for
 * GET /admin/gardssalg-outreach-daily-prep (src/routes/opplevelser.ts), added
 * for dev-request 2026-08-09-daglig-outreach-klargjoering-og-stoerrelsesgate,
 * Skive 2: the read-only "daily prep" computation. Given the current
 * outreach_ready cohort, this route runs the SAME preflight/pilot-send
 * dry-run check POST /admin/gardssalg-outreach-pilot-send runs (via the
 * extracted computeGardssalgOutreachSendEligibility, shared by both routes),
 * keeps only candidates that would actually be sent, caps the result at 4
 * (no padding), and reports every outreach_ready row that did NOT make the
 * cut with its reason. Zero write/apply capability.
 *
 * Mirrors opplevelser-gardssalg-outreach-size-gate.test.ts's setup
 * (EXPERIENCES_DB_PATH=":memory:", fresh require of db-factory + opplevelser
 * router per run, callRoute() exercising router.handle() directly with
 * X-Admin-Key via headers, method/url configurable for a GET route).
 *
 * Fixture layout (ids sorted ascending, since the route selects/caps in id
 * order for determinism):
 *   prov-a-freemail       outreach_ready, would_send, address_basis
 *                         "freemail_pointing_to_producer" (gmail.com)
 *   prov-b-homepage       outreach_ready, would_send, address_basis
 *                         "published_on_producer_site" (homepage-evidenced
 *                         email on a different domain than the website)
 *   prov-c-samedomain     outreach_ready, would_send, address_basis
 *                         "same_domain_as_website"
 *   prov-d-unverified     outreach_ready, would_send, address_basis
 *                         "unverified" (neither website domain, nor
 *                         homepage-evidenced, nor free-mail — Skive 3 would
 *                         eventually gate this; Skive 2 only labels it)
 *   prov-e-overflow       outreach_ready, would_send, but bumped past the
 *                         4-candidate cap -> excluded/daily_cap_reached
 *   prov-macks-large      outreach_ready but size_flag "stor" -> excluded/
 *                         large_company_excluded (same Macks-style fixture
 *                         as the size-gate test)
 *   prov-quarantine       outreach_ready but own-table-cooldown-suppressed
 *                         (a prior real send within the cooldown window) ->
 *                         excluded/cooldown_suppressed + quarantine_until
 *   prov-needs-enrichment NOT outreach_ready at all (missing products) —
 *                         must appear in neither candidates nor excluded,
 *                         only folds into refill_hints.needs_enrichment_count
 *
 * Covers:
 *   (a) auth: missing/wrong X-Admin-Key -> 403
 *   (b) full batch: exactly 4 candidates (a,b,c,d — e bumped by the cap),
 *       each with all required fields (name/profile_url/recipient_email/
 *       address_basis/producer_type/antall_ansatte/kommune/checks), the
 *       three positive address_basis values plus "unverified" all present
 *       across the 4
 *   (c) excluded list: large_company_excluded (Macks) + cooldown_suppressed
 *       with last_sent_at + quarantine_until (quarantine) +
 *       daily_cap_reached (overflow) all present with reasons; a
 *       needs_enrichment-tier row never appears in excluded (it was never
 *       outreach_ready)
 *   (d) fewer-than-4 case: a narrower fixture set with only 2 eligible ids
 *       -> returns exactly 2, missing.count 2, reason "fewer_than_cap", note
 *       present, never padded
 *   (e) zero-eligible-but-nonzero-pool case: outreach_ready rows exist but
 *       all are excluded -> dry:true, missing.reason "all_excluded",
 *       refill_hints present
 *   (f) zero-outreach_ready-at-all case: pool_exhausted, no crash,
 *       refill_hints present with needs_enrichment_count only
 *   (g) no-apply-path: a testKey call never triggers a write —
 *       experience_outreach_sent_log row count is identical before/after,
 *       and the route's own source slice carries no `apply: true` literal
 */

import * as fs from "fs";
import * as path from "path";

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
  opts: { method?: string; url?: string; headers?: Record<string, string>; body?: any } = {},
): Promise<RouteResult> {
  return new Promise((resolve) => {
    const method = opts.method ?? "GET";
    const url = opts.url ?? "/admin/gardssalg-outreach-daily-prep";
    const headers = opts.headers || {};
    const req: any = {
      method,
      url,
      originalUrl: url,
      path: url,
      query: {},
      headers,
      body: opts.body,
      get(name: string) {
        return headers[name.toLowerCase()];
      },
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

const VERIFIED_PROVENANCE = JSON.stringify({
  hjemmeside_verification: { verified: true, classification: "verified", checked_at: "2026-08-09T00:00:00.000Z" },
});

// prov-b-homepage's field_provenance: the email was extracted from the
// producer's OWN homepage (source_url resolves to the website's own host),
// even though the mailbox domain itself differs from the website domain.
function homepageEmailProvenance(email: string, websiteUrl: string): string {
  return JSON.stringify({
    hjemmeside_verification: { verified: true, classification: "verified", checked_at: "2026-08-09T00:00:00.000Z" },
    email: [
      {
        source_type: "homepage",
        value: email,
        source_url: `${websiteUrl.replace(/\/$/, "")}/kontakt`,
      },
    ],
  });
}

export function runOpplevelserGardssalgOutreachDailyPrepTests(
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
    // ── (g, static half) source-level proof: this route's own code slice
    // carries no `apply: true` literal anywhere. Located by its own route
    // registration string, so an unrelated `apply: true` elsewhere in the
    // ~13k-line file (e.g. inside POST /admin/gardssalg-outreach-pilot-send)
    // can never hide a regression here, and a regression here can't hide
    // behind that route's legitimate apply:true usage either.
    try {
      const src = fs.readFileSync(path.join(__dirname, "opplevelser.ts"), "utf8");
      const startMarker = 'router.get("/admin/gardssalg-outreach-daily-prep"';
      const startIdx = src.indexOf(startMarker);
      assertTrue(startIdx !== -1, "g-static a: route registration found in source");
      if (startIdx !== -1) {
        // Slice to the next top-level route registration (the size-gate GET
        // right after it) so the scan is scoped to just this route's body.
        const afterStart = src.slice(startIdx + startMarker.length);
        const nextRouteIdx = afterStart.indexOf('router.get("/admin/gardssalg-outreach-size-gate"');
        assertTrue(nextRouteIdx !== -1, "g-static b: next sibling route found (slice boundary)");
        const routeSlice = afterStart.slice(0, nextRouteIdx === -1 ? undefined : nextRouteIdx);
        assertTrue(
          !/apply\s*:\s*true/.test(routeSlice),
          "g-static c: no `apply: true` / `apply:true` literal anywhere in the daily-prep route's own code slice",
        );
      }
    } catch (err: any) {
      failed++;
      failures.push("opplevelser-gardssalg-outreach-daily-prep (static apply-scan): " + String(err?.stack || err?.message || err));
    }

    const prevExperiencesDbPath = process.env.EXPERIENCES_DB_PATH;
    const prevAdminKey = process.env.ADMIN_KEY;
    const prevCooldownDays = process.env.OUTREACH_COOLDOWN_DAYS;
    const testKey = process.env.ADMIN_KEY || "gardssalg-outreach-daily-prep-test-key";
    process.env.EXPERIENCES_DB_PATH = ":memory:";
    process.env.ADMIN_KEY = testKey;
    process.env.OUTREACH_COOLDOWN_DAYS = "60";

    const dbFactoryPath = require.resolve("../database/db-factory");
    const opplevelserPath = require.resolve("./opplevelser");
    const cachePaths = [dbFactoryPath, opplevelserPath];
    for (const p of cachePaths) delete require.cache[p];

    let prevRfbDb: any = null;

    try {
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const expDb = dbFactory.getDb("experiences");

      // The route's cross-platform cooldown check (inside
      // computeGardssalgOutreachSendEligibility) reads the RFB `agents`/
      // `outreach_sent_log` tables via getRfbDb() — the SAME global RFB db
      // singleton opplevelser-gardssalg-outreach-pilot-send.test.ts already
      // overrides for exactly this reason (there is no per-module seam for
      // it). A fresh in-memory RFB db with the real schema, saved/restored
      // around this suite, same as that sibling suite.
      const initMod = require("../database/init") as typeof import("../database/init");
      const Database = require("better-sqlite3") as typeof import("better-sqlite3");
      prevRfbDb = initMod.__peekDbForTesting();
      const rfbDb = new Database(":memory:");
      initMod.__setDbForTesting(rfbDb as any);
      initMod.__initSchemaForTesting(rfbDb as any);

      const insertProvider = expDb.prepare(
        `INSERT INTO experience_providers
           (id, navn, vertical, org_nr, kommune, rfb_seed_source, producer_type,
            epost, telefon, hjemmeside, about_text, visit_text, opening_hours_text,
            products, content_source, booking_live, catalog_hidden, slug, field_provenance,
            brreg_verified, antall_ansatte,
            enrichment_state, verification_status, source, confidence)
         VALUES
           (@id, @navn, 'experiences', @org_nr, @kommune, @rfb_seed_source, @producer_type,
            @epost, @telefon, @hjemmeside, @about_text, @visit_text, @opening_hours_text,
            @products, @content_source, @booking_live, @catalog_hidden, @slug, @field_provenance,
            @brreg_verified, @antall_ansatte,
            'raw', 'pending_verify', 'test-fixture', 'medium')`,
      );

      // ── prov-a-freemail: would_send, address_basis freemail ────────────
      insertProvider.run({
        id: "prov-a-freemail", navn: "Alpha Freemail Gård", org_nr: "100000001", kommune: "Voss",
        rfb_seed_source: "rfb-seed", producer_type: "sideri",
        epost: "alpha.freemail@gmail.com", telefon: null, hjemmeside: "https://alpha-freemail.example.no",
        about_text: "Om gården.", visit_text: null, opening_hours_text: null,
        products: "Sider", content_source: "provider_site",
        booking_live: 0, catalog_hidden: 0, slug: "alpha-freemail-gard", field_provenance: VERIFIED_PROVENANCE,
        brreg_verified: 1, antall_ansatte: 4,
      });

      // ── prov-b-homepage: would_send, address_basis published_on_producer_site
      insertProvider.run({
        id: "prov-b-homepage", navn: "Beta Homepage Gård", org_nr: "100000002", kommune: "Ulvik",
        rfb_seed_source: "rfb-seed", producer_type: "bryggeri",
        epost: "kontakt@mailhost-beta.example.com", telefon: null, hjemmeside: "https://beta-homepage.example.no",
        about_text: "Om gården.", visit_text: null, opening_hours_text: null,
        products: "Øl", content_source: "provider_site",
        booking_live: 0, catalog_hidden: 0, slug: "beta-homepage-gard",
        field_provenance: homepageEmailProvenance("kontakt@mailhost-beta.example.com", "https://beta-homepage.example.no"),
        brreg_verified: 1, antall_ansatte: null,
      });

      // ── prov-c-samedomain: would_send, address_basis same_domain_as_website
      insertProvider.run({
        id: "prov-c-samedomain", navn: "Gamma Samedomain Gård", org_nr: "100000003", kommune: "Voss",
        rfb_seed_source: "rfb-seed", producer_type: "sideri",
        epost: "post@gamma-samedomain-fixture.no", telefon: null, hjemmeside: "https://gamma-samedomain-fixture.no",
        about_text: "Om gården.", visit_text: null, opening_hours_text: null,
        products: "Cider", content_source: "provider_site",
        booking_live: 0, catalog_hidden: 0, slug: "gamma-samedomain-gard", field_provenance: VERIFIED_PROVENANCE,
        brreg_verified: 1, antall_ansatte: 12,
      });

      // ── prov-d-unverified: would_send, address_basis unverified (address on
      // a THIRD domain — neither the website's own domain, nor homepage-
      // evidenced, nor free-mail; the Hardanger-Saft class the dev-request
      // itself measured — Skive 3 would eventually gate this, Skive 2 only
      // labels it, so it must still surface as a candidate).
      insertProvider.run({
        id: "prov-d-unverified", navn: "Delta Uverifisert Gård", org_nr: "100000004", kommune: "Aurland",
        rfb_seed_source: "rfb-seed", producer_type: "sideri",
        epost: "post@unrelated-third-domain.example.org", telefon: null, hjemmeside: "https://delta-unverified.example.no",
        about_text: "Om gården.", visit_text: null, opening_hours_text: null,
        products: "Most", content_source: "provider_site",
        booking_live: 0, catalog_hidden: 0, slug: "delta-unverified-gard", field_provenance: VERIFIED_PROVENANCE,
        brreg_verified: 1, antall_ansatte: 7,
      });

      // ── prov-e-overflow: would_send too, but the 5th in id order — must be
      // bumped past the 4-candidate cap into excluded/daily_cap_reached.
      insertProvider.run({
        id: "prov-e-overflow", navn: "Epsilon Overflow Gård", org_nr: "100000005", kommune: "Voss",
        rfb_seed_source: "rfb-seed", producer_type: "sideri",
        epost: "post@epsilon-overflow-fixture.no", telefon: null, hjemmeside: "https://epsilon-overflow-fixture.no",
        about_text: "Om gården.", visit_text: null, opening_hours_text: null,
        products: "Sider", content_source: "provider_site",
        booking_live: 0, catalog_hidden: 0, slug: "epsilon-overflow-gard", field_provenance: VERIFIED_PROVENANCE,
        brreg_verified: 1, antall_ansatte: 2,
      });

      // ── prov-macks-large: otherwise outreach_ready, antall_ansatte 119 —
      // excluded/large_company_excluded (same fixture shape as the size-gate
      // test's own Macks fixture).
      insertProvider.run({
        id: "prov-macks-large", navn: "Macks Ølbryggeri", org_nr: "975967093", kommune: "Tromsø",
        rfb_seed_source: "rfb-seed", producer_type: "bryggeri",
        epost: "post@macksdailyprepfixture.no", telefon: null, hjemmeside: "https://macksdailyprepfixture.no",
        about_text: "Om bryggeriet.", visit_text: null, opening_hours_text: null,
        products: "Øl", content_source: "provider_site",
        booking_live: 0, catalog_hidden: 0, slug: "macks-daily-prep", field_provenance: VERIFIED_PROVENANCE,
        brreg_verified: 1, antall_ansatte: 119,
      });

      // ── prov-quarantine: otherwise outreach_ready — a prior REAL send
      // within the cooldown window suppresses it (own-table cooldown).
      insertProvider.run({
        id: "prov-quarantine", navn: "Karantene Gård", org_nr: "100000006", kommune: "Voss",
        rfb_seed_source: "rfb-seed", producer_type: "sideri",
        epost: "post@karantenegard-fixture.no", telefon: null, hjemmeside: "https://karantenegard-fixture.no",
        about_text: "Om gården.", visit_text: null, opening_hours_text: null,
        products: "Sider", content_source: "provider_site",
        booking_live: 0, catalog_hidden: 0, slug: "karantene-gard", field_provenance: VERIFIED_PROVENANCE,
        brreg_verified: 1, antall_ansatte: 3,
      });
      const quarantineSentAt = "2026-08-08T09:00:00.000Z"; // recent -> inside the 60-day cooldown
      expDb
        .prepare(
          `INSERT INTO experience_outreach_sent_log (provider_id, recipient_email, sent_at, channel, is_test)
           VALUES ('prov-quarantine', 'post@karantenegard-fixture.no', ?, 'email', 0)`,
        )
        .run(quarantineSentAt);

      // ── prov-needs-enrichment: NOT outreach_ready at all (no products) —
      // must never appear in candidates or excluded.
      insertProvider.run({
        id: "prov-needs-enrichment", navn: "Under Arbeid Gård", org_nr: "100000007", kommune: "Voss",
        rfb_seed_source: "rfb-seed", producer_type: "sideri",
        epost: "post@underarbeid-dailyprep.example.no", telefon: null, hjemmeside: "https://underarbeid-dailyprep.example.no",
        about_text: null, visit_text: null, opening_hours_text: null,
        products: null, content_source: "provider_site",
        booking_live: 0, catalog_hidden: 0, slug: null, field_provenance: null,
        brreg_verified: 0, antall_ansatte: null,
      });

      const opplevelserRouter = (require("./opplevelser") as typeof import("./opplevelser")).default as any;
      const auth = { "x-admin-key": testKey };

      // ══ (a) auth ═══════════════════════════════════════════════════════
      const noKey = await callRoute(opplevelserRouter, {});
      assertEq(noKey.status, 403, "a1: no X-Admin-Key -> 403");
      const badKey = await callRoute(opplevelserRouter, { headers: { "x-admin-key": "wrong-key" } });
      assertEq(badKey.status, 403, "a2: wrong X-Admin-Key -> 403");

      // ══ (b)/(c) full batch ═════════════════════════════════════════════
      const beforeLogCount = (
        expDb.prepare(`SELECT COUNT(*) n FROM experience_outreach_sent_log`).get() as any
      ).n;

      const full = await callRoute(opplevelserRouter, { headers: auth });
      assertEq(full.status, 200, "b1: full batch -> 200");
      assertEq(full.body.candidates.length, 4, "b2: exactly 4 candidates (never more than DAILY_PREP_MAX_CANDIDATES)");
      assertEq(
        (full.body.candidates as any[]).map((c) => c.provider_id),
        ["prov-a-freemail", "prov-b-homepage", "prov-c-samedomain", "prov-d-unverified"],
        "b3: the first 4 eligible ids in ascending id order (e bumped by the cap)",
      );

      const REQUIRED_FIELDS = [
        "provider_id", "name", "profile_url", "recipient_email", "address_basis",
        "producer_type", "antall_ansatte", "kommune", "checks",
      ];
      for (const c of full.body.candidates as any[]) {
        for (const f of REQUIRED_FIELDS) {
          assertTrue(Object.prototype.hasOwnProperty.call(c, f), `b4: candidate ${c.provider_id} has field '${f}'`);
        }
        assertTrue(!!c.checks?.readiness_tier, `b5: candidate ${c.provider_id} checks.readiness_tier present`);
      }

      const byId = new Map((full.body.candidates as any[]).map((c) => [c.provider_id, c]));
      assertEq(byId.get("prov-a-freemail")?.address_basis, "freemail_pointing_to_producer", "b6: prov-a-freemail address_basis");
      assertEq(byId.get("prov-b-homepage")?.address_basis, "published_on_producer_site", "b7: prov-b-homepage address_basis");
      assertEq(byId.get("prov-c-samedomain")?.address_basis, "same_domain_as_website", "b8: prov-c-samedomain address_basis");
      assertEq(byId.get("prov-d-unverified")?.address_basis, "unverified", "b9: prov-d-unverified address_basis (Skive 3 not built -- surfaced, not gated)");
      assertEq(byId.get("prov-c-samedomain")?.producer_type, "sideri", "b10: producer_type passthrough");
      assertEq(byId.get("prov-c-samedomain")?.antall_ansatte, 12, "b11: antall_ansatte passthrough (Skive 1 field)");
      assertEq(byId.get("prov-c-samedomain")?.kommune, "Voss", "b12: kommune passthrough");
      assertEq(byId.get("prov-c-samedomain")?.recipient_email, "post@gamma-samedomain-fixture.no", "b13: recipient_email");
      assertTrue(String(byId.get("prov-c-samedomain")?.profile_url || "").includes("gamma-samedomain-gard"), "b14: profile_url carries the slug");
      assertEq(byId.get("prov-c-samedomain")?.checks?.readiness_tier, "outreach_ready", "b15: checks.readiness_tier");
      assertEq(byId.get("prov-c-samedomain")?.checks?.preflight, "go", "b16: checks.preflight");

      // ── (c) excluded reasons ────────────────────────────────────────────
      const excludedById = new Map((full.body.excluded as any[]).map((e) => [e.provider_id, e]));
      assertEq(excludedById.get("prov-macks-large")?.reason, "large_company_excluded", "c1: Macks excluded, reason large_company_excluded");
      assertEq(excludedById.get("prov-quarantine")?.reason, "cooldown_suppressed", "c2: quarantine excluded, reason cooldown_suppressed");
      assertEq(excludedById.get("prov-quarantine")?.last_sent_at, quarantineSentAt, "c3: quarantine row carries last_sent_at");
      assertTrue(!!excludedById.get("prov-quarantine")?.quarantine_until, "c4: quarantine row carries a computed quarantine_until");
      assertTrue(
        new Date(excludedById.get("prov-quarantine")?.quarantine_until).getTime() > new Date(quarantineSentAt).getTime(),
        "c5: quarantine_until is after last_sent_at (last_sent_at + cooldown window)",
      );
      assertEq(excludedById.get("prov-e-overflow")?.reason, "daily_cap_reached", "c6: 5th eligible id excluded, reason daily_cap_reached");
      assertTrue(!excludedById.has("prov-needs-enrichment"), "c7: a needs_enrichment-tier row (never outreach_ready) is absent from excluded");
      assertTrue(!byId.has("prov-needs-enrichment"), "c8: a needs_enrichment-tier row is absent from candidates too");
      assertEq(full.body.excluded.length, 3, "c9: excluded has exactly 3 rows (macks, quarantine, overflow)");
      assertEq(full.body.pool, { outreach_ready_total: 7, eligible_total: 5, selected: 4, excluded_total: 3 }, "c10: pool counters");
      assertEq(full.body.missing, { count: 0, reason: null }, "c11: full batch -> missing.count 0, reason null");
      assertEq(full.body.dry, false, "c12: dry:false (eligible_total > 0)");

      // ══ (g) no write occurred from any of the calls above ═══════════════
      const afterLogCount = (
        expDb.prepare(`SELECT COUNT(*) n FROM experience_outreach_sent_log`).get() as any
      ).n;
      assertEq(afterLogCount, beforeLogCount, "g1: experience_outreach_sent_log row count unchanged after calling the route");

      // ══ (d) fewer-than-4 case ════════════════════════════════════════════
      // Narrow via a second in-memory DB scenario is unnecessary — reuse the
      // SAME db, but call preflight/pilot-send style narrowing is not
      // available on this GET route (it always scans the whole cohort), so
      // instead assert the fewer-than-4 behavior by deleting three of the
      // four eligible candidates, leaving exactly 2 eligible (c, d) plus the
      // 3 already-excluded rows.
      expDb.prepare(`DELETE FROM experience_providers WHERE id IN ('prov-a-freemail', 'prov-b-homepage', 'prov-e-overflow')`).run();
      const fewer = await callRoute(opplevelserRouter, { headers: auth });
      assertEq(fewer.status, 200, "d1: fewer-than-4 batch -> 200");
      assertEq(fewer.body.candidates.length, 2, "d2: exactly 2 candidates (never padded to 4)");
      assertEq(fewer.body.missing, { count: 2, reason: "fewer_than_cap" }, "d3: missing.count 2, reason fewer_than_cap");
      assertTrue(typeof fewer.body.note === "string" && fewer.body.note.length > 0, "d4: an explicit note is present");
      assertTrue(fewer.body.note.includes("2"), "d5: the note names the missing count");
      assertEq(fewer.body.dry, false, "d6: dry:false (2 eligible > 0)");

      // ══ (e) zero-eligible-but-nonzero-pool case ══════════════════════════
      expDb.prepare(`DELETE FROM experience_providers WHERE id IN ('prov-c-samedomain', 'prov-d-unverified')`).run();
      const allExcluded = await callRoute(opplevelserRouter, { headers: auth });
      assertEq(allExcluded.status, 200, "e1: all-excluded batch -> 200 (no crash)");
      assertEq(allExcluded.body.candidates.length, 0, "e2: zero candidates");
      assertEq(allExcluded.body.dry, true, "e3: dry:true (eligible_total 0, pool nonzero)");
      assertEq(allExcluded.body.missing, { count: 4, reason: "all_excluded" }, "e4: missing.count 4, reason all_excluded");
      assertTrue(typeof allExcluded.body.note === "string" && allExcluded.body.note.length > 0, "e5: an explicit note is present");
      assertTrue(!!allExcluded.body.refill_hints, "e6: refill_hints present when the pool is effectively dry");
      assertTrue(
        typeof allExcluded.body.refill_hints.needs_enrichment_count === "number",
        "e7: refill_hints.needs_enrichment_count is a number",
      );
      assertEq(allExcluded.body.refill_hints.quarantined_count, 1, "e8: refill_hints.quarantined_count counts the one quarantined row");
      assertTrue(!!allExcluded.body.refill_hints.quarantine_earliest_release_at, "e9: refill_hints.quarantine_earliest_release_at present");

      // ══ (f) zero-outreach_ready-at-all case ══════════════════════════════
      expDb.prepare(`DELETE FROM experience_providers WHERE id IN ('prov-macks-large', 'prov-quarantine')`).run();
      const dry = await callRoute(opplevelserRouter, { headers: auth });
      assertEq(dry.status, 200, "f1: zero-outreach_ready batch -> 200 (no crash)");
      assertEq(dry.body.candidates.length, 0, "f2: zero candidates");
      assertEq(dry.body.excluded.length, 0, "f3: zero excluded (nothing was ever outreach_ready)");
      assertEq(dry.body.dry, true, "f4: dry:true");
      assertEq(dry.body.missing, { count: 4, reason: "pool_exhausted" }, "f5: missing.count 4, reason pool_exhausted");
      assertEq(dry.body.pool, { outreach_ready_total: 0, eligible_total: 0, selected: 0, excluded_total: 0 }, "f6: pool counters all zero");
      assertTrue(!!dry.body.refill_hints, "f7: refill_hints present");
      assertTrue(
        typeof dry.body.refill_hints.needs_enrichment_count === "number" && dry.body.refill_hints.needs_enrichment_count >= 1,
        "f8: refill_hints.needs_enrichment_count counts prov-needs-enrichment",
      );
      assertTrue(
        dry.body.refill_hints.quarantined_count === undefined,
        "f9: refill_hints in the pool_exhausted branch carries no quarantined_count key (never cheaply computable without at least one id to check)",
      );
    } catch (err: any) {
      failed++;
      failures.push("opplevelser-gardssalg-outreach-daily-prep: unexpected error: " + String(err?.stack || err?.message || err));
    } finally {
      const restore = (k: string, v: string | undefined) => {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      };
      restore("EXPERIENCES_DB_PATH", prevExperiencesDbPath);
      restore("ADMIN_KEY", prevAdminKey);
      restore("OUTREACH_COOLDOWN_DAYS", prevCooldownDays);
      try {
        const initMod = require("../database/init") as typeof import("../database/init");
        if (prevRfbDb) {
          initMod.__setDbForTesting(prevRfbDb);
        }
      } catch {
        // best-effort cleanup
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

// Standalone runner: npx tsx src/routes/opplevelser-gardssalg-outreach-daily-prep.test.ts
if (require.main === module) {
  runOpplevelserGardssalgOutreachDailyPrepTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    process.exit(summary.failed > 0 ? 1 : 0);
  });
}
