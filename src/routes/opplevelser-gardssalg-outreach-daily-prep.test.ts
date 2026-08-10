/**
 * opplevelser-gardssalg-outreach-daily-prep.test.ts — tests for
 * GET /admin/gardssalg-outreach-daily-prep (src/routes/opplevelser.ts), added
 * for dev-request 2026-08-09-daglig-outreach-klargjoering-og-stoerrelsesgate,
 * Skive 2 (the read-only "daily prep" computation) and Skive 3 (three further
 * automated checks folded into the SAME route, run over the full eligible
 * list before the daily cap — see the route's own module doc comment for the
 * full rationale of each). Given the current outreach_ready cohort, this
 * route runs the SAME preflight/pilot-send dry-run check POST /admin/
 * gardssalg-outreach-pilot-send runs (via the extracted
 * computeGardssalgOutreachSendEligibility, shared by both routes), then
 * Skive 3's address-domain / profile-text / correct-industry checks
 * (daily-prep-only, NOT shared with pilot-send), keeps only candidates that
 * survive all of it, caps the result at 4 (no padding, with genuine
 * backfill — an excluded candidate is replaced by the next eligible one in
 * order, never leaves a gap), and reports every outreach_ready row that did
 * NOT make the cut with its reason. Zero write/apply capability.
 *
 * Mirrors opplevelser-gardssalg-outreach-size-gate.test.ts's setup
 * (EXPERIENCES_DB_PATH=":memory:", fresh require of db-factory + opplevelser
 * router per run, callRoute() exercising router.handle() directly with
 * X-Admin-Key via headers, method/url configurable for a GET route).
 *
 * Fixture layout (ids sorted ascending, since the route selects/caps in id
 * order for determinism). about_text on every "would otherwise send" fixture
 * below is realistic Norwegian prose (>=80 chars, no boilerplate) so it
 * clears Skive 3's profile-text check — a dedicated separate fixture
 * (prov-f-thinabout, block (i) below) covers the check ITSELF failing:
 *   prov-a-freemail       outreach_ready, would_send, address_basis
 *                         "freemail_pointing_to_producer" (gmail.com)
 *   prov-b-homepage       outreach_ready, would_send, address_basis
 *                         "published_on_producer_site" (homepage-evidenced
 *                         email on a different domain than the website)
 *   prov-c-samedomain     outreach_ready, would_send, address_basis
 *                         "same_domain_as_website"
 *   prov-d-unverified     outreach_ready readiness-tier-wise, but address
 *                         "unverified" (neither website domain, nor
 *                         homepage-evidenced, nor free-mail — the Hardanger
 *                         Saft nils.j.lekve@ulvik.org shape) -> Skive 3
 *                         check 1 now excludes it, reason
 *                         address_domain_mismatch (Skive 2 only labelled
 *                         this; Skive 3 is where it gates)
 *   prov-e-overflow       outreach_ready, would_send, clears every Skive 3
 *                         check too -> backfills into the 4th slot vacated
 *                         by prov-d-unverified above (proves genuine
 *                         batch-assembly-time backfill, not just "the first
 *                         4 before any exclusion")
 *   prov-macks-large      outreach_ready but size_flag "stor" -> excluded/
 *                         large_company_excluded (same Macks-style fixture
 *                         as the size-gate test) — excluded upstream of
 *                         Skive 3, so its about_text is irrelevant here
 *   prov-quarantine       outreach_ready but own-table-cooldown-suppressed
 *                         (a prior real send within the cooldown window) ->
 *                         excluded/cooldown_suppressed + quarantine_until —
 *                         also excluded upstream of Skive 3
 *   prov-needs-enrichment NOT outreach_ready at all (missing products) —
 *                         must appear in neither candidates nor excluded,
 *                         only folds into refill_hints.needs_enrichment_count
 *
 * Skive-3-dedicated fixtures, each inserted/asserted/deleted in its own
 * isolated block (h)/(i)/(j) below, after the shared 8-fixture set above has
 * been fully exercised and cleared out:
 *   prov-g-salmon          rfb-seed, producer_type NULL, naeringskode
 *                          "03.211" (Fiskeoppdrett i sjøvann — salmon
 *                          farming, the dev-request's own named false-
 *                          positive) -> excluded/wrong_industry
 *   prov-f-thinabout       about_text "Om gården." (10 chars, present but
 *                          nowhere near meetsAboutCheapBar's 80-char floor)
 *                          -> excluded/profile_text_low_quality
 *   prov-j-dup-1/-2        two DIFFERENT providers, IDENTICAL recipient
 *                          email -> only -1 (first in ascending id order)
 *                          survives; -2 excluded/preflight_no_go with
 *                          preflight_reason duplikat_epost (Skive 2's own
 *                          Slice-2 outreach-guard, batch-scoped — proves
 *                          Skive 3 krav 4 needed NO new code)
 *
 * Covers:
 *   (a) auth: missing/wrong X-Admin-Key -> 403
 *   (b) full batch: exactly 4 candidates (a,b,c,e — d excluded by the new
 *       address-domain check, e backfills into its slot), each with all
 *       required fields (name/profile_url/recipient_email/address_basis/
 *       producer_type/antall_ansatte/kommune/checks), the three positive
 *       address_basis values all present across the 4
 *   (c) excluded list: large_company_excluded (Macks) + cooldown_suppressed
 *       with last_sent_at + quarantine_until (quarantine) +
 *       address_domain_mismatch (d) all present with reasons; a
 *       needs_enrichment-tier row never appears in excluded (it was never
 *       outreach_ready); pool counters unchanged in shape from Skive 2 (d
 *       and e simply swap which bucket they land in)
 *   (d) fewer-than-4 case: a narrower fixture set with only 1 surviving
 *       eligible id (c; d is excluded by the address check even here) ->
 *       returns exactly 1, missing.count 3, reason "fewer_than_cap", note
 *       present, never padded
 *   (e) zero-eligible-but-nonzero-pool case: outreach_ready rows exist but
 *       all are excluded -> dry:true, missing.reason "all_excluded",
 *       refill_hints present
 *   (f) zero-outreach_ready-at-all case: pool_exhausted, no crash,
 *       refill_hints present with needs_enrichment_count only
 *   (g) no-apply-path: a testKey call never triggers a write —
 *       experience_outreach_sent_log row count is identical before/after,
 *       and the route's own source slice carries no `apply: true` literal
 *   (h) Skive 3 check 3 (correct-industry): a salmon-farming NACE code with
 *       no producer_type set -> excluded/wrong_industry, never a candidate
 *   (i) Skive 3 check 2 (profile-text sanity): a too-short about_text ->
 *       excluded/profile_text_low_quality, never a candidate
 *   (j) Skive 3 check 4 (shared-recipient-across-batch): already fully
 *       implemented by Skive 2's own batch dedupe (no new production code) —
 *       two candidates sharing one recipient email collapse to exactly one
 *       kept (first in id order) + one excluded/preflight_no_go
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

// Skive 3 check 2 (profile-text sanity, meetsAboutCheapBar): realistic,
// >=80-char Norwegian prose with no boilerplate markers — used on every
// fixture below that must still clear the new profile-text gate. Plain
// "Om gården."-style placeholders (10 chars) now fail that gate on purpose;
// prov-f-thinabout (block (i)) keeps exactly that short placeholder to
// prove the gate actually fires.
const REALISTIC_ABOUT_TEXT =
  "Vi driver et lite gårdsbruk og lager drikke av råvarer fra vår egen gård. " +
  "Produktene selges direkte fra gårdsutsalget til besøkende gjennom hele sesongen.";

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
            brreg_verified, antall_ansatte, naeringskode,
            enrichment_state, verification_status, source, confidence)
         VALUES
           (@id, @navn, 'experiences', @org_nr, @kommune, @rfb_seed_source, @producer_type,
            @epost, @telefon, @hjemmeside, @about_text, @visit_text, @opening_hours_text,
            @products, @content_source, @booking_live, @catalog_hidden, @slug, @field_provenance,
            @brreg_verified, @antall_ansatte, @naeringskode,
            'raw', 'pending_verify', 'test-fixture', 'medium')`,
      );

      // ── prov-a-freemail: would_send, address_basis freemail ────────────
      insertProvider.run({
        id: "prov-a-freemail", navn: "Alpha Freemail Gård", org_nr: "100000001", kommune: "Voss",
        rfb_seed_source: "rfb-seed", producer_type: "sideri",
        epost: "alpha.freemail@gmail.com", telefon: null, hjemmeside: "https://alpha-freemail.example.no",
        about_text: REALISTIC_ABOUT_TEXT, visit_text: null, opening_hours_text: null,
        products: "Sider", content_source: "provider_site",
        booking_live: 0, catalog_hidden: 0, slug: "alpha-freemail-gard", field_provenance: VERIFIED_PROVENANCE,
        brreg_verified: 1, antall_ansatte: 4, naeringskode: null,
      });

      // ── prov-b-homepage: would_send, address_basis published_on_producer_site
      insertProvider.run({
        id: "prov-b-homepage", navn: "Beta Homepage Gård", org_nr: "100000002", kommune: "Ulvik",
        rfb_seed_source: "rfb-seed", producer_type: "bryggeri",
        epost: "kontakt@mailhost-beta.example.com", telefon: null, hjemmeside: "https://beta-homepage.example.no",
        about_text: REALISTIC_ABOUT_TEXT, visit_text: null, opening_hours_text: null,
        products: "Øl", content_source: "provider_site",
        booking_live: 0, catalog_hidden: 0, slug: "beta-homepage-gard",
        field_provenance: homepageEmailProvenance("kontakt@mailhost-beta.example.com", "https://beta-homepage.example.no"),
        brreg_verified: 1, antall_ansatte: null, naeringskode: null,
      });

      // ── prov-c-samedomain: would_send, address_basis same_domain_as_website
      insertProvider.run({
        id: "prov-c-samedomain", navn: "Gamma Samedomain Gård", org_nr: "100000003", kommune: "Voss",
        rfb_seed_source: "rfb-seed", producer_type: "sideri",
        epost: "post@gamma-samedomain-fixture.no", telefon: null, hjemmeside: "https://gamma-samedomain-fixture.no",
        about_text: REALISTIC_ABOUT_TEXT, visit_text: null, opening_hours_text: null,
        products: "Cider", content_source: "provider_site",
        booking_live: 0, catalog_hidden: 0, slug: "gamma-samedomain-gard", field_provenance: VERIFIED_PROVENANCE,
        brreg_verified: 1, antall_ansatte: 12, naeringskode: null,
      });

      // ── prov-d-unverified: readiness-tier outreach_ready, but address_basis
      // "unverified" (address on a THIRD domain — neither the website's own
      // domain, nor homepage-evidenced, nor free-mail; the Hardanger-Saft
      // nils.j.lekve@ulvik.org shape the dev-request itself measured). Skive
      // 2 only labelled this; Skive 3 check 1 now EXCLUDES it, reason
      // address_domain_mismatch (block (b)/(c) below) — about_text left as
      // the short placeholder deliberately: the address check fires first
      // regardless, so it never reaches the profile-text check either way.
      insertProvider.run({
        id: "prov-d-unverified", navn: "Delta Uverifisert Gård", org_nr: "100000004", kommune: "Aurland",
        rfb_seed_source: "rfb-seed", producer_type: "sideri",
        epost: "post@unrelated-third-domain.example.org", telefon: null, hjemmeside: "https://delta-unverified.example.no",
        about_text: "Om gården.", visit_text: null, opening_hours_text: null,
        products: "Most", content_source: "provider_site",
        booking_live: 0, catalog_hidden: 0, slug: "delta-unverified-gard", field_provenance: VERIFIED_PROVENANCE,
        brreg_verified: 1, antall_ansatte: 7, naeringskode: null,
      });

      // ── prov-e-overflow: clears every Skive 2 AND Skive 3 check, 5th in id
      // order — under Skive 2 alone this was bumped past the 4-candidate cap
      // (excluded/daily_cap_reached); now that prov-d-unverified above is
      // excluded by the new address check, this backfills into the 4th slot
      // instead — proving genuine batch-assembly-time backfill.
      insertProvider.run({
        id: "prov-e-overflow", navn: "Epsilon Overflow Gård", org_nr: "100000005", kommune: "Voss",
        rfb_seed_source: "rfb-seed", producer_type: "sideri",
        epost: "post@epsilon-overflow-fixture.no", telefon: null, hjemmeside: "https://epsilon-overflow-fixture.no",
        about_text: REALISTIC_ABOUT_TEXT, visit_text: null, opening_hours_text: null,
        products: "Sider", content_source: "provider_site",
        booking_live: 0, catalog_hidden: 0, slug: "epsilon-overflow-gard", field_provenance: VERIFIED_PROVENANCE,
        brreg_verified: 1, antall_ansatte: 2, naeringskode: null,
      });

      // ── prov-macks-large: otherwise outreach_ready, antall_ansatte 119 —
      // excluded/large_company_excluded (same fixture shape as the size-gate
      // test's own Macks fixture). Excluded upstream of Skive 3 (the size
      // gate runs inside computeGardssalgOutreachSendEligibility, before
      // Skive 3's checks even run), so its about_text is irrelevant here.
      insertProvider.run({
        id: "prov-macks-large", navn: "Macks Ølbryggeri", org_nr: "975967093", kommune: "Tromsø",
        rfb_seed_source: "rfb-seed", producer_type: "bryggeri",
        epost: "post@macksdailyprepfixture.no", telefon: null, hjemmeside: "https://macksdailyprepfixture.no",
        about_text: "Om bryggeriet.", visit_text: null, opening_hours_text: null,
        products: "Øl", content_source: "provider_site",
        booking_live: 0, catalog_hidden: 0, slug: "macks-daily-prep", field_provenance: VERIFIED_PROVENANCE,
        brreg_verified: 1, antall_ansatte: 119, naeringskode: null,
      });

      // ── prov-quarantine: otherwise outreach_ready — a prior REAL send
      // within the cooldown window suppresses it (own-table cooldown).
      // Excluded upstream of Skive 3 too — its about_text is irrelevant.
      insertProvider.run({
        id: "prov-quarantine", navn: "Karantene Gård", org_nr: "100000006", kommune: "Voss",
        rfb_seed_source: "rfb-seed", producer_type: "sideri",
        epost: "post@karantenegard-fixture.no", telefon: null, hjemmeside: "https://karantenegard-fixture.no",
        about_text: "Om gården.", visit_text: null, opening_hours_text: null,
        products: "Sider", content_source: "provider_site",
        booking_live: 0, catalog_hidden: 0, slug: "karantene-gard", field_provenance: VERIFIED_PROVENANCE,
        brreg_verified: 1, antall_ansatte: 3, naeringskode: null,
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
        brreg_verified: 0, antall_ansatte: null, naeringskode: null,
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
        ["prov-a-freemail", "prov-b-homepage", "prov-c-samedomain", "prov-e-overflow"],
        "b3: the 4 remaining eligible ids in ascending id order — prov-d-unverified excluded by the new " +
          "address-domain check, prov-e-overflow backfills into its slot (genuine batch-assembly-time backfill)",
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
      assertEq(byId.get("prov-e-overflow")?.address_basis, "same_domain_as_website", "b9: prov-e-overflow address_basis (the backfilled candidate)");
      assertTrue(!byId.has("prov-d-unverified"), "b9b: prov-d-unverified is NOT a candidate (Skive 3 check 1 now excludes it)");
      assertEq(byId.get("prov-c-samedomain")?.checks?.address_domain, "pass", "b9c: checks.address_domain surfaced as pass for a real candidate");
      assertEq(byId.get("prov-c-samedomain")?.checks?.profile_text, "pass", "b9d: checks.profile_text surfaced as pass for a real candidate");
      assertEq(byId.get("prov-c-samedomain")?.checks?.industry, "pass", "b9e: checks.industry surfaced as pass for a real candidate");
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
      assertEq(excludedById.get("prov-d-unverified")?.reason, "address_domain_mismatch", "c6: prov-d-unverified excluded, reason address_domain_mismatch (Skive 3 check 1)");
      assertTrue(!excludedById.has("prov-e-overflow"), "c6b: prov-e-overflow is NOT excluded anymore — it backfilled into a candidate slot instead");
      assertTrue(!excludedById.has("prov-needs-enrichment"), "c7: a needs_enrichment-tier row (never outreach_ready) is absent from excluded");
      assertTrue(!byId.has("prov-needs-enrichment"), "c8: a needs_enrichment-tier row is absent from candidates too");
      assertEq(full.body.excluded.length, 3, "c9: excluded has exactly 3 rows (macks, quarantine, prov-d-unverified)");
      assertEq(full.body.pool, { outreach_ready_total: 7, eligible_total: 5, selected: 4, excluded_total: 3 }, "c10: pool counters (unchanged in shape from Skive 2 — d and e simply swapped buckets)");
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
      // four eligible candidates, leaving eligible ids c and d — but d is
      // STILL excluded by the Skive 3 address check even in this narrower
      // batch (that check runs regardless of how many other candidates
      // exist), so exactly 1 candidate (c) survives.
      expDb.prepare(`DELETE FROM experience_providers WHERE id IN ('prov-a-freemail', 'prov-b-homepage', 'prov-e-overflow')`).run();
      const fewer = await callRoute(opplevelserRouter, { headers: auth });
      assertEq(fewer.status, 200, "d1: fewer-than-4 batch -> 200");
      assertEq(fewer.body.candidates.length, 1, "d2: exactly 1 candidate (c only — d still excluded by the address check; never padded)");
      assertEq(fewer.body.missing, { count: 3, reason: "fewer_than_cap" }, "d3: missing.count 3, reason fewer_than_cap");
      assertTrue(typeof fewer.body.note === "string" && fewer.body.note.length > 0, "d4: an explicit note is present");
      assertTrue(fewer.body.note.includes("3"), "d5: the note names the missing count");
      assertEq(fewer.body.dry, false, "d6: dry:false (1 eligible > 0)");
      const fewerExcludedById = new Map((fewer.body.excluded as any[]).map((e) => [e.provider_id, e]));
      assertEq(fewerExcludedById.get("prov-d-unverified")?.reason, "address_domain_mismatch", "d7: prov-d-unverified still excluded here too, reason address_domain_mismatch");

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

      // Clean slate for the three dedicated Skive 3 scenario blocks below —
      // only the never-outreach_ready prov-needs-enrichment row is left.
      expDb.prepare(`DELETE FROM experience_providers WHERE id = 'prov-needs-enrichment'`).run();

      // ══ (h) Skive 3 check 3: correct-industry (salmon-farming false positive) ══
      // rfb-seed, producer_type NULL (never classified as a drink producer —
      // exactly the shape the real Daniel-caught false positive had), but
      // naeringskode "03.211" (Fiskeoppdrett i sjøvann — salmon farming, NACE
      // division "03" = Fiske, fangst og akvakultur). Otherwise fully
      // outreach_ready/would_send-shaped (own-domain email so the address
      // check can't ALSO fire, realistic about_text so the profile-text
      // check can't ALSO fire) — isolates check 3 specifically.
      insertProvider.run({
        id: "prov-g-salmon", navn: "Salmon Farming AS", org_nr: "100000008", kommune: "Bodø",
        rfb_seed_source: "rfb-seed", producer_type: null,
        epost: "post@salmon-farming-fixture.no", telefon: null, hjemmeside: "https://salmon-farming-fixture.no",
        about_text: REALISTIC_ABOUT_TEXT, visit_text: null, opening_hours_text: null,
        products: "Laks", content_source: "provider_site",
        booking_live: 0, catalog_hidden: 0, slug: "salmon-farming-as", field_provenance: VERIFIED_PROVENANCE,
        brreg_verified: 1, antall_ansatte: 10, naeringskode: "03.211",
      });
      const salmon = await callRoute(opplevelserRouter, { headers: auth });
      assertEq(salmon.status, 200, "h1: salmon-farming batch -> 200");
      assertEq(salmon.body.candidates.length, 0, "h2: salmon-farming candidate never proposed");
      const salmonExcludedById = new Map((salmon.body.excluded as any[]).map((e) => [e.provider_id, e]));
      assertEq(salmonExcludedById.get("prov-g-salmon")?.reason, "wrong_industry", "h3: salmon-farming excluded, reason wrong_industry");
      expDb.prepare(`DELETE FROM experience_providers WHERE id = 'prov-g-salmon'`).run();

      // ══ (i) Skive 3 check 2: profile-text sanity (thin about_text) ══════════
      // Otherwise fully outreach_ready/would_send-shaped (own-domain email,
      // a recognized drink producer_type) — isolates check 2 specifically.
      // about_text "Om gården." (10 chars) is present (has_about_text=true,
      // so readiness_tier still reaches outreach_ready) but nowhere near
      // meetsAboutCheapBar's 80-char floor.
      insertProvider.run({
        id: "prov-f-thinabout", navn: "Tynn Beskrivelse Gård", org_nr: "100000009", kommune: "Voss",
        rfb_seed_source: "rfb-seed", producer_type: "sideri",
        epost: "post@thinabout-fixture.no", telefon: null, hjemmeside: "https://thinabout-fixture.no",
        about_text: "Om gården.", visit_text: null, opening_hours_text: null,
        products: "Sider", content_source: "provider_site",
        booking_live: 0, catalog_hidden: 0, slug: "thinabout-gard", field_provenance: VERIFIED_PROVENANCE,
        brreg_verified: 1, antall_ansatte: 5, naeringskode: null,
      });
      const thinAbout = await callRoute(opplevelserRouter, { headers: auth });
      assertEq(thinAbout.status, 200, "i1: thin-about-text batch -> 200");
      assertEq(thinAbout.body.candidates.length, 0, "i2: thin-about-text candidate never proposed");
      const thinAboutExcludedById = new Map((thinAbout.body.excluded as any[]).map((e) => [e.provider_id, e]));
      assertEq(thinAboutExcludedById.get("prov-f-thinabout")?.reason, "profile_text_low_quality", "i3: thin-about-text excluded, reason profile_text_low_quality");
      expDb.prepare(`DELETE FROM experience_providers WHERE id = 'prov-f-thinabout'`).run();

      // ══ (j) Skive 3 check 4: shared-recipient-across-batch (no new code) ════
      // Two DIFFERENT providers, the SAME recipient email — proves Skive 2's
      // own Slice-2 outreach-guard (dedupeGardssalgOutreachRecipients, folded
      // into computeGardssalgOutreachPreflight, reused by
      // computeGardssalgOutreachSendEligibility) already collapses this to
      // one kept + one excluded, batch-scoped, first-in-id-order wins —
      // krav 4 needed ZERO new production code.
      // The SAME email on a freemail domain deliberately (not each provider's
      // own distinct website domain): a non-freemail cross-domain shared
      // address would ALSO trip Skive 3 check 1 (address_domain_mismatch)
      // for both rows, which would confound this test's isolation of check 4
      // specifically — freemail cleanly clears check 1 (see its own doc
      // comment: "email pointing at the producer itself is fine even on
      // freemail" for the domain check; the shared-recipient batch dedupe
      // below is a SEPARATE, exact-email-match rule that doesn't care about
      // freemail status either way).
      insertProvider.run({
        id: "prov-j-dup-1", navn: "Dup En Gård", org_nr: "100000010", kommune: "Voss",
        rfb_seed_source: "rfb-seed", producer_type: "sideri",
        epost: "shared.recipient.dailyprep@gmail.com", telefon: null, hjemmeside: "https://dup-en-fixture.no",
        about_text: REALISTIC_ABOUT_TEXT, visit_text: null, opening_hours_text: null,
        products: "Sider", content_source: "provider_site",
        booking_live: 0, catalog_hidden: 0, slug: "dup-en-gard", field_provenance: VERIFIED_PROVENANCE,
        brreg_verified: 1, antall_ansatte: 5, naeringskode: null,
      });
      insertProvider.run({
        id: "prov-j-dup-2", navn: "Dup To Gård", org_nr: "100000011", kommune: "Voss",
        rfb_seed_source: "rfb-seed", producer_type: "sideri",
        epost: "shared.recipient.dailyprep@gmail.com", telefon: null, hjemmeside: "https://dup-to-fixture.no",
        about_text: REALISTIC_ABOUT_TEXT, visit_text: null, opening_hours_text: null,
        products: "Sider", content_source: "provider_site",
        booking_live: 0, catalog_hidden: 0, slug: "dup-to-gard", field_provenance: VERIFIED_PROVENANCE,
        brreg_verified: 1, antall_ansatte: 5, naeringskode: null,
      });
      const dup = await callRoute(opplevelserRouter, { headers: auth });
      assertEq(dup.status, 200, "j1: shared-recipient batch -> 200");
      assertEq(dup.body.candidates.length, 1, "j2: exactly 1 of the 2 same-recipient candidates kept");
      assertEq(
        (dup.body.candidates as any[])[0]?.provider_id,
        "prov-j-dup-1",
        "j3: the first-in-id-order candidate is the one kept",
      );
      const dupExcludedById = new Map((dup.body.excluded as any[]).map((e) => [e.provider_id, e]));
      assertEq(dupExcludedById.get("prov-j-dup-2")?.reason, "preflight_no_go", "j4: the second same-recipient candidate excluded, reason preflight_no_go");
      assertEq(dupExcludedById.get("prov-j-dup-2")?.preflight_reason, "duplikat_epost", "j5: preflight_reason names the exact-email batch dedupe");
      assertTrue(!dupExcludedById.has("prov-j-dup-1"), "j6: the kept candidate is not ALSO listed as excluded");
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
