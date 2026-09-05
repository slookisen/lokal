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

// Grep 6 slice 1 (DAILY_PREP_MAX_CANDIDATES env knob): saves/restores
// process.env.DAILY_PREP_MAX_CANDIDATES around a single case via try/finally
// so a failing assertion inside `fn` can never leak the value into a later
// case in this shared-suite file.
async function withDailyCapEnv(value: string | undefined, fn: () => Promise<void>): Promise<void> {
  const prev = process.env.DAILY_PREP_MAX_CANDIDATES;
  try {
    if (value === undefined) delete process.env.DAILY_PREP_MAX_CANDIDATES;
    else process.env.DAILY_PREP_MAX_CANDIDATES = value;
    await fn();
  } finally {
    if (prev === undefined) delete process.env.DAILY_PREP_MAX_CANDIDATES;
    else process.env.DAILY_PREP_MAX_CANDIDATES = prev;
  }
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
        epost: "post@unrelated-third-domain-mismatch.no", telefon: null, hjemmeside: "https://delta-unverified.example.no",
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

      const opplevelserModule = require("./opplevelser") as typeof import("./opplevelser");
      const opplevelserRouter = opplevelserModule.default as any;
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
      assertEq(full.body.pool, { outreach_ready_total: 7, eligible_total: 5, selected: 4, excluded_total: 3, daily_cap: 4 }, "c10: pool counters (unchanged in shape from Skive 2 — d and e simply swapped buckets) + daily_cap (env unset -> default 4)");
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
      assertEq(dry.body.pool, { outreach_ready_total: 0, eligible_total: 0, selected: 0, excluded_total: 0, daily_cap: 4 }, "f6: pool counters all zero + daily_cap (env unset -> default 4, pool-exhausted branch)");
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
      expDb.prepare(`DELETE FROM experience_providers WHERE id IN ('prov-j-dup-1', 'prov-j-dup-2')`).run();

      // ══ (k) PR review regression — dedup-winner-fails-Skive-3 ordering bug ══
      // Independent reviewer's confirmed repro (CHANGES-REQUESTED, MEDIUM):
      // two providers share a recipient email (like block (j) above), but
      // this time the LOWER-id one ("winner" of an id-ordered dedup) has thin
      // about_text that fails Skive 3 check 2 on its own, while the
      // HIGHER-id one is otherwise fully valid. Before the fix, dedup ran
      // BEFORE Skive 3: the lower-id row won the dedup slot and suppressed
      // the higher-id row as "duplikat_epost"/preflight_no_go, then Skive 3
      // excluded the lower-id row anyway for profile_text_low_quality —
      // BOTH ended up excluded (candidates: []) even though the higher-id
      // row alone should have been proposed. After the fix, dedup only runs
      // among candidates that already survived Skive 1 + Skive 3, so the
      // higher-id row is not penalized for a "winner" that was never
      // actually going to be proposed.
      //
      // Both share a freemail recipient (gmail.com) so the SAME-email dedup
      // rule applies (not the cross-domain rule) and neither trips Skive 3
      // check 1 (address_domain_mismatch) on its own — isolates the
      // interaction to check 2 (profile-text) exactly like the reviewer's
      // repro.
      insertProvider.run({
        id: "prov-k-dup-1-thinabout", navn: "Kappa Dup Tynn Gård", org_nr: "100000012", kommune: "Voss",
        rfb_seed_source: "rfb-seed", producer_type: "sideri",
        epost: "shared.recipient.orderingbug@gmail.com", telefon: null, hjemmeside: "https://kappa-dup-thin-fixture.no",
        about_text: "Om gården.", visit_text: null, opening_hours_text: null,
        products: "Sider", content_source: "provider_site",
        booking_live: 0, catalog_hidden: 0, slug: "kappa-dup-thin-gard", field_provenance: VERIFIED_PROVENANCE,
        brreg_verified: 1, antall_ansatte: 5, naeringskode: null,
      });
      insertProvider.run({
        id: "prov-k-dup-2-valid", navn: "Kappa Dup Gyldig Gård", org_nr: "100000013", kommune: "Voss",
        rfb_seed_source: "rfb-seed", producer_type: "sideri",
        epost: "shared.recipient.orderingbug@gmail.com", telefon: null, hjemmeside: "https://kappa-dup-valid-fixture.no",
        about_text: REALISTIC_ABOUT_TEXT, visit_text: null, opening_hours_text: null,
        products: "Sider", content_source: "provider_site",
        booking_live: 0, catalog_hidden: 0, slug: "kappa-dup-valid-gard", field_provenance: VERIFIED_PROVENANCE,
        brreg_verified: 1, antall_ansatte: 5, naeringskode: null,
      });
      const orderingBug = await callRoute(opplevelserRouter, { headers: auth });
      assertEq(orderingBug.status, 200, "k1: dedup-vs-skive3-ordering batch -> 200");
      assertEq(
        orderingBug.body.candidates.length,
        1,
        "k2: exactly 1 candidate proposed (not both wrongly excluded — the historic bug produced 0)",
      );
      assertEq(
        (orderingBug.body.candidates as any[])[0]?.provider_id,
        "prov-k-dup-2-valid",
        "k3: the higher-id, actually-valid candidate is the one proposed, NOT the lower-id dedup 'winner'",
      );
      const orderingBugExcludedById = new Map((orderingBug.body.excluded as any[]).map((e) => [e.provider_id, e]));
      assertEq(
        orderingBugExcludedById.get("prov-k-dup-1-thinabout")?.reason,
        "profile_text_low_quality",
        "k4: the lower-id candidate is excluded for its OWN disqualifying reason (profile_text_low_quality), not lumped in as a duplicate",
      );
      assertTrue(
        !("preflight_reason" in (orderingBugExcludedById.get("prov-k-dup-1-thinabout") ?? {})),
        "k5: the lower-id candidate's exclusion carries no preflight_reason — it was never a genuine dedup victim",
      );
      assertTrue(
        !orderingBugExcludedById.has("prov-k-dup-2-valid"),
        "k6: the proposed candidate is not ALSO listed as excluded",
      );
      expDb.prepare(`DELETE FROM experience_providers WHERE id IN ('prov-k-dup-1-thinabout', 'prov-k-dup-2-valid')`).run();

      // ══ (l) configurable daily cap (Grep 6 slice 1: DAILY_PREP_MAX_CANDIDATES) ══
      // Case (a) — env unset -> cap 4 — is already covered by the untouched
      // b2/c10 assertions above (the regression guard proving the default is
      // unchanged); no new fixtures needed for it here.
      //
      // 10 fixtures (cap-b01..cap-b10), each own-domain email + realistic
      // about_text + a recognized producer_type ("sideri") — clears every
      // Skive 3 check on its own merits, so exactly the daily cap (not Skive
      // 3) governs how many of them get selected. IDs zero-padded/ascending
      // so selection order stays deterministic like every other block above.
      for (let i = 1; i <= 10; i++) {
        const n = String(i).padStart(2, "0");
        insertProvider.run({
          id: `cap-b${n}`, navn: `Cap Batch ${n} Gård`, org_nr: String(300000000 + i), kommune: "Voss",
          rfb_seed_source: "rfb-seed", producer_type: "sideri",
          epost: `post@cap-batch-${n}-fixture.no`, telefon: null, hjemmeside: `https://cap-batch-${n}-fixture.no`,
          about_text: REALISTIC_ABOUT_TEXT, visit_text: null, opening_hours_text: null,
          products: "Sider", content_source: "provider_site",
          booking_live: 0, catalog_hidden: 0, slug: `cap-batch-${n}-gard`, field_provenance: VERIFIED_PROVENANCE,
          brreg_verified: 1, antall_ansatte: 5, naeringskode: null,
        });
      }

      // ── (l-b) env "10" with exactly 10 eligible -> exactly 10 selected,
      // no daily_cap_reached in excluded (nothing overflows the cap), and
      // pool.daily_cap reflects the effective cap (normal-branch half of l-f).
      await withDailyCapEnv("10", async () => {
        const capTen = await callRoute(opplevelserRouter, { headers: auth });
        assertEq(capTen.status, 200, "l-b1: env=10, 10 eligible -> 200");
        assertEq(capTen.body.candidates.length, 10, "l-b2: exactly 10 selected");
        assertTrue(
          !(capTen.body.excluded as any[]).some((e) => e.reason === "daily_cap_reached"),
          "l-b3: no daily_cap_reached entry in excluded (10 eligible == cap 10, nothing overflows)",
        );
        assertEq(capTen.body.pool.daily_cap, 10, "l-b4: pool.daily_cap is 10 (normal branch)");
      });

      // ── (l-e) env "100" -> clamps to the named ceiling (10), not 100 — a
      // typo like "100" must not propose the whole pool as one day's batch.
      // Still 10 eligible here, so this also proves the clamp actually caps
      // selection at 10, not 100.
      await withDailyCapEnv("100", async () => {
        const capHundred = await callRoute(opplevelserRouter, { headers: auth });
        assertEq(capHundred.status, 200, "l-e1: env=100, 10 eligible -> 200");
        assertEq(capHundred.body.pool.daily_cap, 10, "l-e2: pool.daily_cap clamped to the ceiling (10), not 100");
        assertEq(capHundred.body.candidates.length, 10, "l-e3: selection also clamped to 10, not the raw env value");
      });

      // Narrow the pool to 3 eligible (cap-b01..cap-b03) for the
      // fewer-than-cap and lower-clamp cases below.
      expDb.prepare(`DELETE FROM experience_providers WHERE id IN (${Array.from({ length: 7 }, (_, i) => `'cap-b${String(i + 4).padStart(2, "0")}'`).join(", ")})`).run();

      // ── (l-c) env "10" with only 3 eligible -> 3 selected, NO padding,
      // missing.count 7, missing.reason "fewer_than_cap".
      await withDailyCapEnv("10", async () => {
        const capFewer = await callRoute(opplevelserRouter, { headers: auth });
        assertEq(capFewer.status, 200, "l-c1: env=10, 3 eligible -> 200");
        assertEq(capFewer.body.candidates.length, 3, "l-c2: exactly 3 selected (never padded to 10)");
        assertEq(capFewer.body.missing, { count: 7, reason: "fewer_than_cap" }, "l-c3: missing.count 7, reason fewer_than_cap");
        assertEq(capFewer.body.pool.daily_cap, 10, "l-c4: pool.daily_cap still 10 (the effective cap, independent of how many are eligible)");
      });

      // ── (l-d) env "0", "-5", "", "abc" -> each clamps to the lower bound
      // (1), never 0 — a 0/empty/garbage value must never resolve to 0 (that
      // would silently propose nothing every day, reading like an empty pool
      // rather than a misconfiguration). 3 eligible remain, so a selected
      // count of 1 (not 3) proves the clamp actually took effect.
      for (const garbageValue of ["0", "-5", "", "abc"]) {
        await withDailyCapEnv(garbageValue, async () => {
          const capGarbage = await callRoute(opplevelserRouter, { headers: auth });
          assertEq(capGarbage.status, 200, `l-d1(${JSON.stringify(garbageValue)}): 200`);
          assertEq(capGarbage.body.candidates.length, 1, `l-d2(${JSON.stringify(garbageValue)}): exactly 1 selected (clamped to 1, never 0)`);
          assertEq(capGarbage.body.pool.daily_cap, 1, `l-d3(${JSON.stringify(garbageValue)}): pool.daily_cap is 1`);
        });
      }

      expDb.prepare(`DELETE FROM experience_providers WHERE id IN ('cap-b01', 'cap-b02', 'cap-b03')`).run();

      // ── (l-f, pool-exhausted-branch half) pool.daily_cap is also reported
      // in the pool-exhausted early-return branch, and reflects whatever the
      // effective cap resolved to for THIS request.
      await withDailyCapEnv("7", async () => {
        const capExhausted = await callRoute(opplevelserRouter, { headers: auth });
        assertEq(capExhausted.status, 200, "l-f1: env=7, 0 outreach_ready -> 200");
        assertEq(capExhausted.body.dry, true, "l-f2: dry:true (pool exhausted)");
        assertEq(capExhausted.body.missing, { count: 7, reason: "pool_exhausted" }, "l-f3: missing.count 7, reason pool_exhausted");
        assertEq(capExhausted.body.pool.daily_cap, 7, "l-f4: pool.daily_cap is 7 (pool-exhausted branch)");
      });

      // ══ (m) unit tests: computeGardssalgAddressBasis — dev-request
      // 2026-09-02-gardssalg-adressegrunnlag-2linje-uten-hjemmeside ══════════
      // Pure-function tests, no DB/route involved — exercises the exported
      // function directly with the exact same field_provenance shape
      // isGardssalgSecondLineVerified reads (second_line_verification.verified
      // === true).
      const SECOND_LINE_VERIFIED_PROVENANCE = JSON.stringify({
        second_line_verification: {
          verified: true,
          at: "2026-09-01T00:00:00.000Z",
          sources: ["brreg", "1881"],
          judge_reason: "identity match — org number + registered address align",
        },
      });
      const computeAddrBasis = opplevelserModule.computeGardssalgAddressBasis;

      // (m-a) AC4a: no website + second-line-verified -> new accepting basis.
      assertEq(
        computeAddrBasis("post@unrelated-third-domain-mismatch.no", null, SECOND_LINE_VERIFIED_PROVENANCE),
        "second_line_verified",
        "m-a1: no website (null) + second-line-verified -> address_basis 'second_line_verified'",
      );
      assertEq(
        computeAddrBasis("post@unrelated-third-domain-mismatch.no", "", SECOND_LINE_VERIFIED_PROVENANCE),
        "second_line_verified",
        "m-a2: no website (empty string) + second-line-verified -> 'second_line_verified'",
      );

      // (m-b) AC4b: no website + NOT second-line-verified -> still "unverified"
      // exactly as today (byte-identical regression guard).
      assertEq(
        computeAddrBasis("post@unrelated-third-domain-mismatch.no", null, VERIFIED_PROVENANCE),
        "unverified",
        "m-b1: no website + NOT second-line-verified (unrelated provenance key) -> still 'unverified'",
      );
      assertEq(
        computeAddrBasis("post@unrelated-third-domain-mismatch.no", null, null),
        "unverified",
        "m-b2: no website + null field_provenance -> still 'unverified'",
      );
      assertEq(
        computeAddrBasis(
          "post@unrelated-third-domain-mismatch.no",
          null,
          JSON.stringify({ second_line_verification: { verified: false } }),
        ),
        "unverified",
        "m-b3: no website + second_line_verification.verified===false -> still 'unverified'",
      );

      // (m-c) second-line-verified applies regardless of freemail (Daniel's
      // answer "A" — it trumps the domain check entirely with no website,
      // not gated on non-freemail only).
      assertEq(
        computeAddrBasis("gaardsbutikk@gmail.com", null, SECOND_LINE_VERIFIED_PROVENANCE),
        "second_line_verified",
        "m-c1: freemail + no website + second-line-verified -> 'second_line_verified' (wins over the freemail branch)",
      );
      assertEq(
        computeAddrBasis("gaardsbutikk@gmail.com", null, VERIFIED_PROVENANCE),
        "freemail_pointing_to_producer",
        "m-c2: freemail + no website + NOT second-line-verified -> unaffected, still 'freemail_pointing_to_producer'",
      );

      // (m-d) second-line-verified only rescues NO-WEBSITE rows — a genuine
      // domain mismatch WITH a website is still 'unverified' even when the
      // row is second-line-verified (purely additive: existing branches for
      // websited rows are untouched by this new case).
      assertEq(
        computeAddrBasis(
          "post@unrelated-third-domain-mismatch.no",
          "https://some-producer.example.no",
          SECOND_LINE_VERIFIED_PROVENANCE,
        ),
        "unverified",
        "m-d: a genuine domain mismatch WITH a website is still 'unverified' even if second-line-verified",
      );

      // (m-e) AC2 (unit level): a website + email domain pair domainsEquivalent
      // recognizes as the same brand across TLDs -> 'domain_equivalent_to_website',
      // not 'unverified'. Exact fixture pair the sibling contact-audit route's
      // own Skive D regression test already uses (nogne-o.no / nogne-o.com).
      assertEq(
        computeAddrBasis("post@nogne-o.com", "https://nogne-o.no", null),
        "domain_equivalent_to_website",
        "m-e: nogne-o.no website / nogne-o.com email (brand-alias, cross-TLD) -> 'domain_equivalent_to_website'",
      );

      // (m-f) AC3 (unit level, negative/no-regression): a genuinely different,
      // non-equivalent company domain pair is STILL 'unverified' — same
      // fixture pair the contact-audit route's own regression test uses
      // (lofotpils.no website / dng-norge.no email).
      assertEq(
        computeAddrBasis("kontakt@dng-norge.no", "https://lofotpils.no", null),
        "unverified",
        "m-f: a genuine unrelated-company domain pair (lofotpils.no / dng-norge.no) is still 'unverified' — no regression",
      );

      // (m-g) unrelated early-return edge cases, unchanged.
      assertEq(computeAddrBasis(null, null, null), "unverified", "m-g1: null epost -> 'unverified' (unchanged)");
      assertEq(computeAddrBasis("not-an-email", null, null), "unverified", "m-g2: no '@' in epost -> 'unverified' (unchanged)");

      // ══ (n) route-level: AC1 — no website + verified_second_line=true is no
      // longer excluded as address_domain_mismatch ════════════════════════════
      insertProvider.run({
        id: "prov-secondline-nowebsite", navn: "Sigma Andrelinje Gård", org_nr: "100000014", kommune: "Voss",
        rfb_seed_source: "rfb-seed", producer_type: "sideri",
        epost: "kontakt@nowebsite-secondline.example.org", telefon: null, hjemmeside: null,
        about_text: REALISTIC_ABOUT_TEXT, visit_text: null, opening_hours_text: null,
        products: "Sider", content_source: "provider_site",
        booking_live: 0, catalog_hidden: 0, slug: "sigma-andrelinje-gard", field_provenance: SECOND_LINE_VERIFIED_PROVENANCE,
        brreg_verified: 1, antall_ansatte: 5, naeringskode: null,
      });
      const secondLine = await callRoute(opplevelserRouter, { headers: auth });
      assertEq(secondLine.status, 200, "n1: second-line-verified-no-website batch -> 200");
      const secondLineById = new Map((secondLine.body.candidates as any[]).map((c) => [c.provider_id, c]));
      const secondLineExcludedById = new Map((secondLine.body.excluded as any[]).map((e) => [e.provider_id, e]));
      assertTrue(
        secondLineById.has("prov-secondline-nowebsite"),
        "n2: AC1 — no-website + verified_second_line=true is now a candidate, not excluded",
      );
      assertTrue(
        !secondLineExcludedById.has("prov-secondline-nowebsite"),
        "n3: AC1 — never appears in excluded (specifically not address_domain_mismatch)",
      );
      assertEq(
        secondLineById.get("prov-secondline-nowebsite")?.address_basis,
        "second_line_verified",
        "n4: candidate's own address_basis is 'second_line_verified'",
      );
      assertEq(
        secondLine.body.second_line_verified_count,
        1,
        "n5: response reports second_line_verified_count 1 (krav 4 — how many went through on 2nd-line)",
      );
      expDb.prepare(`DELETE FROM experience_providers WHERE id = 'prov-secondline-nowebsite'`).run();

      // ══ (o) route-level: AC2 — a brand-alias/cross-TLD website+email pair
      // (nogne-o.no / nogne-o.com) is no longer excluded in daily-prep, same
      // as the sibling contact-audit route ════════════════════════════════════
      insertProvider.run({
        id: "prov-nogneo-brandalias", navn: "Nogne-O Brandalias Gård", org_nr: "100000015", kommune: "Voss",
        rfb_seed_source: "rfb-seed", producer_type: "sideri",
        epost: "post@nogne-o.com", telefon: null, hjemmeside: "https://nogne-o.no",
        about_text: REALISTIC_ABOUT_TEXT, visit_text: null, opening_hours_text: null,
        products: "Sider", content_source: "provider_site",
        booking_live: 0, catalog_hidden: 0, slug: "nogne-o-brandalias-gard", field_provenance: VERIFIED_PROVENANCE,
        brreg_verified: 1, antall_ansatte: 5, naeringskode: null,
      });
      const brandAlias = await callRoute(opplevelserRouter, { headers: auth });
      assertEq(brandAlias.status, 200, "o1: brand-alias batch -> 200");
      const brandAliasById = new Map((brandAlias.body.candidates as any[]).map((c) => [c.provider_id, c]));
      const brandAliasExcludedById = new Map((brandAlias.body.excluded as any[]).map((e) => [e.provider_id, e]));
      assertTrue(
        brandAliasById.has("prov-nogneo-brandalias"),
        "o2: AC2 — nogne-o.no/.com brand-alias pair is now a candidate, not excluded",
      );
      assertTrue(
        !brandAliasExcludedById.has("prov-nogneo-brandalias"),
        "o3: AC2 — never appears in excluded",
      );
      assertEq(
        brandAliasById.get("prov-nogneo-brandalias")?.address_basis,
        "domain_equivalent_to_website",
        "o4: candidate's own address_basis is 'domain_equivalent_to_website'",
      );
      expDb.prepare(`DELETE FROM experience_providers WHERE id = 'prov-nogneo-brandalias'`).run();

      // ══ (p) route-level: AC3 negative/no-regression — a genuinely foreign,
      // non-equivalent email domain WITH a website is still excluded exactly
      // as before, and the excluded entry now also carries address_basis
      // (AC5) ═══════════════════════════════════════════════════════════════
      insertProvider.run({
        id: "prov-mismatch-real-dailyprep", navn: "Reell Mismatch Gård", org_nr: "100000016", kommune: "Voss",
        rfb_seed_source: "rfb-seed", producer_type: "sideri",
        epost: "kontakt@dng-norge.no", telefon: null, hjemmeside: "https://lofotpils.no",
        about_text: REALISTIC_ABOUT_TEXT, visit_text: null, opening_hours_text: null,
        products: "Sider", content_source: "provider_site",
        booking_live: 0, catalog_hidden: 0, slug: "reell-mismatch-gard", field_provenance: VERIFIED_PROVENANCE,
        brreg_verified: 1, antall_ansatte: 5, naeringskode: null,
      });
      const realMismatch = await callRoute(opplevelserRouter, { headers: auth });
      assertEq(realMismatch.status, 200, "p1: genuine-mismatch batch -> 200");
      const realMismatchById = new Map((realMismatch.body.candidates as any[]).map((c) => [c.provider_id, c]));
      const realMismatchExcludedById = new Map((realMismatch.body.excluded as any[]).map((e) => [e.provider_id, e]));
      assertTrue(
        !realMismatchById.has("prov-mismatch-real-dailyprep"),
        "p2: AC3 — a genuine unrelated-company domain pair (lofotpils.no / dng-norge.no) is NOT a candidate (no regression)",
      );
      assertEq(
        realMismatchExcludedById.get("prov-mismatch-real-dailyprep")?.reason,
        "address_domain_mismatch",
        "p3: AC3 — still excluded, reason address_domain_mismatch (unchanged)",
      );
      assertEq(
        realMismatchExcludedById.get("prov-mismatch-real-dailyprep")?.address_basis,
        "unverified",
        "p4: AC5 — the excluded entry now also carries address_basis ('unverified')",
      );
      assertEq(
        realMismatch.body.second_line_verified_count,
        0,
        "p5: second_line_verified_count is 0 when no candidate went through on that basis",
      );
      expDb.prepare(`DELETE FROM experience_providers WHERE id = 'prov-mismatch-real-dailyprep'`).run();
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
