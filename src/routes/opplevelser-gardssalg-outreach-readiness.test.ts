/**
 * opplevelser-gardssalg-outreach-readiness.test.ts — tests for
 * GET /admin/gardssalg-outreach-readiness (src/routes/opplevelser.ts), added
 * for dev-request 2026-07-21-gardssalg-outreach-beredskapsrapport: a
 * read-only outreach-readiness report over EVERY gårdssalg provider
 * (visible + hidden/catalog_hidden, auto-enriched + manually-claimed —
 * nothing silently excluded), with a per-row deterministic readiness_tier
 * and a top-level per-tier summary.
 *
 * Extended for dev-request
 * 2026-08-01-gardssalg-profilkomplett-og-soekbar-foer-outreach, Steg 4:
 * "outreach_ready" now also requires the row to be searchable (/sok),
 * website-verified (field_provenance.hjemmeside_verification), not hidden
 * (catalog_hidden), and free of an unresolved producer<->experience identity
 * conflict — four new tiers (skjult, ikke_soekbar, nettsted_uverifisert,
 * dublettkonflikt) sit ahead of outreach_ready in precedence.
 *
 * Redefined for dev-request 2026-08-07-outreach-pool-krav123-og-pilot (AC1):
 * the content-completeness gate (previously "needs_enrichment" unless
 * about_text AND opening_hours_text were both present) is now krav 2 —
 * about_text AND products AND brreg_verified. Opening hours / visit text
 * (krav 3) are explicitly NOT required anymore — many gårdssalg producers
 * (breweries, distilleries) run "open by arrangement" with no fixed hours,
 * and the claim flow is how a producer fills that field in themselves, not
 * a precondition for outreach. See the new/adjusted fixtures below: prov-
 * ready now deliberately carries NO opening_hours_text/visit_text (the core
 * regression case — would have tiered needs_enrichment under the OLD
 * cascade), and two new fixtures (prov-no-brreg, prov-no-products) prove the
 * new krav-2 fields DO still gate, independently of opening hours.
 *
 * Extended for dev-request
 * 2026-08-07-dublett-evidensbasis-og-pool-avblokkering, slice 1:
 * has_duplicate_conflict (and with it the dublettkonflikt tier) is now set
 * ONLY by conflict/ambiguous pairs whose match_basis is "provider_link" —
 * an explicit FK, real evidence. name_token/host_name pairs (proven >=13/14
 * false by the 2026-08-01 semantic spot-check) no longer block the pool;
 * they surface per-row as the informational flag
 * `name_token_conflict_candidate` plus the summary count
 * `name_token_conflict_candidates`. The new prov-nametoken fixture is the
 * regression case: an otherwise-outreach_ready producer whose name shares a
 * distinctive token with an unlinked experience row on a different domain
 * (a status="conflict", basis="name_token" pair) MUST tier outreach_ready —
 * on the pre-slice-1 code it tiered dublettkonflikt, so these assertions
 * fail if a name-token pair ever reaches the gate again.
 *
 * Mirrors opplevelser-gardssalg-contact-coverage.test.ts's setup
 * (EXPERIENCES_DB_PATH=":memory:", fresh require of db-factory + opplevelser
 * router per run, callRoute() exercising router.handle() directly with
 * X-Admin-Key via headers — this repo's convention, no HTTP server /
 * supertest needed) and fixture style (raw SQL INSERT against the in-memory
 * experiences DB).
 *
 * Covers:
 *   (a) 403 without X-Admin-Key, 403 with wrong X-Admin-Key
 *   (b) happy path — one fixture per readiness_tier (outreach_ready,
 *       needs_enrichment, no_website, unreachable, skjult, ikke_soekbar,
 *       nettsted_uverifisert, dublettkonflikt) — all present in the response
 *       (never silently dropped), correctly tiered, and correctly marked
 *       (visible/claim_status/booking_status/is_searchable/website_verified/
 *       has_duplicate_conflict)
 *   (c) summary counts match the per-row tiers exactly, total == row count
 *   (d) a non-gårdssalg provider (no producer_type, not rfb-seed) is
 *       excluded, same scoping as the sibling contact-coverage report
 *   (e) zero-provider edge case
 *
 * Extended for dev-request 2026-08-09-daglig-outreach-klargjoering-og-
 * stoerrelsesgate, Skive 1:
 *   (g) AK1: a row's antall_ansatte and derived size_flag are exposed;
 *       Macks Ølbryggeri (org 975967093, antall_ansatte 119) tiers
 *       size_flag "stor"
 *   (h) AK2: a row with antall_ansatte NULL gets size_flag "ukjent" — never
 *       "liten"
 *   (i) AK4: changing GARDSSALG_SIZE_THRESHOLD moves a row's size_flag
 *       between "stor"/"liten" on the NEXT call, no caching across calls
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
  opts: { headers?: Record<string, string> } = {},
): Promise<RouteResult> {
  return new Promise((resolve) => {
    const req: any = {
      method: "GET",
      url: "/admin/gardssalg-outreach-readiness",
      originalUrl: "/admin/gardssalg-outreach-readiness",
      path: "/admin/gardssalg-outreach-readiness",
      query: {},
      headers: opts.headers || {},
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

export function runOpplevelserGardssalgOutreachReadinessTests(
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
    const testKey = process.env.ADMIN_KEY || "gardssalg-outreach-readiness-test-key";
    process.env.EXPERIENCES_DB_PATH = ":memory:";
    process.env.ADMIN_KEY = testKey;

    const dbFactoryPath = require.resolve("../database/db-factory");
    const opplevelserPath = require.resolve("./opplevelser");
    const cachePaths = [dbFactoryPath, opplevelserPath];
    for (const p of cachePaths) delete require.cache[p];

    try {
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const expDb = dbFactory.getDb("experiences");

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
      // For the dublettkonflikt fixture below — a minimal `experiences` row
      // linked via provider_id (the "provider_link" match basis, which skips
      // all name/host-token genericity gating — see
      // findGardssalgProducerExperienceMatches(), gardssalg-experience-
      // conflict.ts) whose booking_url registrable domain does NOT match the
      // producer's hjemmeside domain, the simplest reliable way to trigger
      // status "conflict".
      const insertExperience = expDb.prepare(
        `INSERT INTO experiences (id, provider_id, title, booking_url, verification_status)
         VALUES (@id, @provider_id, @title, @booking_url, 'pending_verify')`,
      );
      // A verified field_provenance blob, reused by every fixture that should
      // pass isHjemmesideVerified() (src/routes/opplevelser.ts).
      const VERIFIED_PROVENANCE = JSON.stringify({
        hjemmeside_verification: { verified: true, classification: "verified", checked_at: "2026-08-01T00:00:00.000Z" },
      });

      // ── (b) one fixture per readiness_tier ──────────────────────────────
      // outreach_ready: website + about_text + products + brreg_verified +
      // email, has a slug (searchable), a verified field_provenance, not
      // hidden, and no conflicting experience row -- the ONE fixture proving
      // a row can still reach outreach_ready under the Steg-4 rules.
      // Deliberately carries NO opening_hours_text/visit_text (dev-request
      // 2026-08-07-outreach-pool-krav123-og-pilot, krav 3: opening
      // hours/visit text must NOT block outreach_ready anymore) -- this is
      // the core regression case: it would have tiered needs_enrichment
      // under the OLD (pre-krav-123) cascade.
      // also booking_live=1 with dispatch enabled -> booking_status "live".
      process.env.BOOKING_DISPATCH_ENABLED = "true";
      insertProvider.run({
        id: "prov-ready", navn: "Klar Gård AS", org_nr: "111111111", kommune: "Voss",
        rfb_seed_source: "rfb-seed", producer_type: null,
        epost: "post@klargard.no", telefon: null, hjemmeside: "https://klargard.no",
        about_text: "Om gården.", visit_text: null, opening_hours_text: null,
        products: "Sider, cider", content_source: "provider_site",
        booking_live: 1, catalog_hidden: 0, slug: "klar-gard-as", field_provenance: VERIFIED_PROVENANCE,
        brreg_verified: 1,
        antall_ansatte: null,
      });
      // needs_enrichment: has website + email but no about_text/products/
      // brreg_verified at all. Fails before the Steg-4 checks are even
      // reached -- no slug/provenance.
      insertProvider.run({
        id: "prov-enrich", navn: "Under Arbeid Gård", org_nr: "222222222", kommune: "Ulvik",
        rfb_seed_source: "rfb-seed", producer_type: null,
        epost: "post@underarbeid.no", telefon: null, hjemmeside: "https://underarbeid.no",
        about_text: null, visit_text: null, opening_hours_text: null,
        products: null, content_source: "provider_site",
        booking_live: 0, catalog_hidden: 0, slug: null, field_provenance: null,
        brreg_verified: 0,
        antall_ansatte: null,
      });
      // needs_enrichment (negative case for krav 2's brreg_verified leg):
      // about_text, products, AND opening_hours_text/visit_text are ALL
      // present -- proving opening hours being present does NOT compensate
      // for a missing brreg_verified -- but brreg_verified is 0 (never
      // matched), so it still falls to needs_enrichment.
      insertProvider.run({
        id: "prov-no-brreg", navn: "Ubekreftet Brreg Gård", org_nr: "121212121", kommune: "Voss",
        rfb_seed_source: "rfb-seed", producer_type: null,
        epost: "post@ubekreftetbrreg.no", telefon: null, hjemmeside: "https://ubekreftetbrreg.no",
        about_text: "Om gården.", visit_text: "Besøksinfo.", opening_hours_text: "Ma-Fr 10-16",
        products: "Sider", content_source: "provider_site",
        booking_live: 0, catalog_hidden: 0, slug: null, field_provenance: null,
        brreg_verified: 0,
        antall_ansatte: null,
      });
      // needs_enrichment (negative case for krav 2's products leg):
      // about_text, brreg_verified, AND opening_hours_text are ALL present --
      // proving opening hours being present does NOT compensate for missing
      // products -- but products is null, so it still falls to
      // needs_enrichment.
      insertProvider.run({
        id: "prov-no-products", navn: "Uten Produkter Gård", org_nr: "131313131", kommune: "Voss",
        rfb_seed_source: "rfb-seed", producer_type: null,
        epost: "post@utenprodukter.no", telefon: null, hjemmeside: "https://utenprodukter.no",
        about_text: "Om gården.", visit_text: "Besøksinfo.", opening_hours_text: "Ti-Lø 09-15",
        products: null, content_source: "provider_site",
        booking_live: 0, catalog_hidden: 0, slug: null, field_provenance: null,
        brreg_verified: 1,
        antall_ansatte: null,
      });
      // no_website: has a phone (reachable) but no hjemmeside at all.
      // Fails before the Steg-4 checks are even reached -- no slug/provenance.
      insertProvider.run({
        id: "prov-noweb", navn: "Ingen Nettside Gård", org_nr: "333333333", kommune: "Aurland",
        rfb_seed_source: "rfb-seed", producer_type: null,
        epost: null, telefon: "98765432", hjemmeside: null,
        about_text: null, visit_text: null, opening_hours_text: null,
        products: null, content_source: null,
        booking_live: null, catalog_hidden: null, slug: null, field_provenance: null,
        brreg_verified: 0,
        antall_ansatte: null,
      });
      // unreachable: no email AND no phone at all, even though it otherwise
      // looks fully content-complete -- unreachable must win regardless.
      // Fails before the Steg-4 checks are even reached -- no slug/provenance.
      insertProvider.run({
        id: "prov-unreach", navn: "Utilgjengelig Gård", org_nr: "444444444", kommune: "Lærdal",
        rfb_seed_source: "rfb-seed", producer_type: null,
        epost: null, telefon: null, hjemmeside: "https://utilgjengelig.no",
        about_text: "Om gården.", visit_text: "Besøksinfo.", opening_hours_text: "Lø 10-14",
        products: "Eplemost", content_source: "provider_site",
        booking_live: 0, catalog_hidden: 0, slug: null, field_provenance: null,
        brreg_verified: 1,
        antall_ansatte: null,
      });
      // hidden (catalog_hidden=1) row -- must still appear, marked visible:false.
      // Fully content-complete under krav 2 (about_text + products +
      // brreg_verified), AND a slug + verified field_provenance -- still
      // must tier "skjult", not "outreach_ready" (catalog_hidden is checked
      // first among the Steg-4 checks -- see computeGardssalgReadinessTier's
      // doc comment) -- and must be reported is_searchable:false regardless
      // of having a slug, since a hidden row is unsearchable by construction.
      // booking_live unset -> booking_status "none".
      insertProvider.run({
        id: "prov-hidden", navn: "Skjult Test Gård", org_nr: "555555555", kommune: "Voss",
        rfb_seed_source: null, producer_type: "test-gardssalg",
        epost: "post@skjult.no", telefon: "12312312", hjemmeside: "https://skjult.no",
        about_text: "Om gården.", visit_text: "Besøksinfo.", opening_hours_text: "Alle dager",
        products: "Sider", content_source: "provider_site",
        booking_live: 1, catalog_hidden: 1, slug: "skjult-test-gard", field_provenance: VERIFIED_PROVENANCE,
        brreg_verified: 1,
        antall_ansatte: null,
      });
      // manually-claimed row -- must still appear, claim_status carries the
      // raw content_source value ('manual'), never excluded. No slug and no
      // field_provenance (a manually-claimed row that hasn't been through the
      // search-slug-backfill or website-verification sweep yet) -> fails on
      // slug before verification is even checked -> "ikke_soekbar".
      insertProvider.run({
        id: "prov-claimed", navn: "Krevd Gård AS", org_nr: "666666666", kommune: "Voss",
        rfb_seed_source: "rfb-seed", producer_type: null,
        epost: "eier@krevdgard.no", telefon: "45454545", hjemmeside: "https://krevdgard.no",
        about_text: "Skrevet av eier selv.", visit_text: "Kom innom!", opening_hours_text: "Lø-Sø 11-15",
        products: "Eplevin", content_source: "manual",
        booking_live: 0, catalog_hidden: 0, slug: null, field_provenance: null,
        brreg_verified: 1,
        antall_ansatte: null,
      });
      // nettsted_uverifisert: content-complete under krav 2, has a slug
      // (searchable), not hidden -- but field_provenance carries no verified
      // hjemmeside_verification entry.
      insertProvider.run({
        id: "prov-unverified", navn: "Uverifisert Gård AS", org_nr: "888888888", kommune: "Voss",
        rfb_seed_source: "rfb-seed", producer_type: null,
        epost: "post@uverifisertgard.no", telefon: null, hjemmeside: "https://uverifisertgard.no",
        about_text: "Om gården.", visit_text: "Besøksinfo.", opening_hours_text: "Ti-Lø 10-17",
        products: "Most", content_source: "provider_site",
        booking_live: 0, catalog_hidden: 0, slug: "uverifisert-gard", field_provenance: null,
        brreg_verified: 1,
        antall_ansatte: null,
      });
      // dublettkonflikt: content-complete under krav 2, searchable,
      // website-verified, not hidden -- but a matching `experiences` row
      // (linked directly via provider_id, see insertExperience below) has a
      // booking_url whose registrable domain does NOT match this producer's
      // hjemmeside domain.
      insertProvider.run({
        id: "prov-conflict", navn: "Konflikt Gård AS", org_nr: "999999999", kommune: "Voss",
        rfb_seed_source: "rfb-seed", producer_type: null,
        epost: "post@konfliktgard.no", telefon: null, hjemmeside: "https://konfliktgard.no",
        about_text: "Om gården.", visit_text: "Besøksinfo.", opening_hours_text: "Ma-Fr 09-16",
        products: "Sider", content_source: "provider_site",
        booking_live: 0, catalog_hidden: 0, slug: "konflikt-gard", field_provenance: VERIFIED_PROVENANCE,
        brreg_verified: 1,
        antall_ansatte: null,
      });
      insertExperience.run({
        id: "exp-konflikt-gard", provider_id: "prov-conflict",
        title: "Konflikt Gård — gårdsbesøk og smaking",
        booking_url: "https://uenighetsbutikk.no/produkt",
      });
      // name_token-basis candidate (dev-request
      // 2026-08-07-dublett-evidensbasis-og-pool-avblokkering, slice 1's core
      // regression fixture): fully outreach_ready on its own merits (krav 1
      // + krav 2 + searchable + verified + not hidden), AND an UNLINKED
      // experiences row (provider_id NULL) shares the distinctive >=5-char
      // name token "fjellbekken" while its booking_url sits on a different
      // registrable domain -- a status="conflict", match_basis="name_token"
      // pair (exactly the >=13/14-false pattern: a kayak tour sharing a
      // place-name token with a brewery). Slice 1's whole point: this row
      // must tier outreach_ready and carry name_token_conflict_candidate
      // instead of being dublettkonflikt-blocked. On pre-slice-1 code it
      // tiered dublettkonflikt -- the f-assertions below fail there.
      insertProvider.run({
        id: "prov-nametoken", navn: "Fjellbekken Håndbryggeri AS", org_nr: "141414141", kommune: "Voss",
        rfb_seed_source: "rfb-seed", producer_type: null,
        epost: "post@fjellbekkenbrygg.no", telefon: null, hjemmeside: "https://fjellbekkenbrygg.no",
        about_text: "Om bryggeriet.", visit_text: null, opening_hours_text: null,
        products: "Håndverksøl", content_source: "provider_site",
        booking_live: 0, catalog_hidden: 0, slug: "fjellbekken-handbryggeri", field_provenance: VERIFIED_PROVENANCE,
        brreg_verified: 1,
        antall_ansatte: null,
      });
      insertExperience.run({
        id: "exp-fjellbekken-kajakk", provider_id: null,
        title: "Fjellbekken kajakktur med fjordsafari",
        booking_url: "https://kajakkeventyr.no/turer",
      });
      // non-gårdssalg provider (no producer_type, not rfb-seed) -> excluded
      // entirely, same scoping as the sibling contact-coverage report.
      insertProvider.run({
        id: "prov-not-gardssalg", navn: "Ikke Gårdssalg AS", org_nr: "777777777", kommune: "Voss",
        rfb_seed_source: null, producer_type: null,
        epost: "post@ikke.no", telefon: "11223344", hjemmeside: "https://ikke.no",
        about_text: "Tekst.", visit_text: "Tekst.", opening_hours_text: "Tekst.",
        products: "Noe", content_source: "provider_site",
        booking_live: 0, catalog_hidden: 0, slug: null, field_provenance: null,
        brreg_verified: 1,
        antall_ansatte: null,
      });

      // ── (g)/(h)/(i) size-signal fixtures (dev-request 2026-08-09-daglig-
      // outreach-klargjoering-og-stoerrelsesgate, Skive 1) — otherwise
      // outreach_ready-shaped so size_flag can be observed independently of
      // readiness_tier (proving the two fields never bleed into each other).
      // AK1's own fixture: Macks Ølbryggeri, org 975967093, antall_ansatte
      // 119 -> size_flag "stor" under the default threshold (25).
      insertProvider.run({
        id: "prov-large", navn: "Macks Ølbryggeri", org_nr: "975967093", kommune: "Stavanger",
        rfb_seed_source: "rfb-seed", producer_type: null,
        epost: "post@macks.no", telefon: null, hjemmeside: "https://macks.no",
        about_text: "Om bryggeriet.", visit_text: null, opening_hours_text: null,
        products: "Øl", content_source: "provider_site",
        booking_live: 0, catalog_hidden: 0, slug: "macks-olbryggeri", field_provenance: VERIFIED_PROVENANCE,
        brreg_verified: 1,
        antall_ansatte: 119,
      });
      // AK2's own fixture: antall_ansatte NULL (Brreg has no registered
      // figure) -> size_flag "ukjent", never "liten".
      insertProvider.run({
        id: "prov-unknown-size", navn: "Ukjent Størrelse Gård AS", org_nr: "191919191", kommune: "Voss",
        rfb_seed_source: "rfb-seed", producer_type: null,
        epost: "post@ukjentstorrelse.no", telefon: null, hjemmeside: "https://ukjentstorrelse.no",
        about_text: "Om gården.", visit_text: null, opening_hours_text: null,
        products: "Sider", content_source: "provider_site",
        booking_live: 0, catalog_hidden: 0, slug: "ukjent-storrelse-gard", field_provenance: VERIFIED_PROVENANCE,
        brreg_verified: 1,
        antall_ansatte: null,
      });
      // AK4's own fixture: a plain small figure well under the default
      // threshold (25) but comfortably ABOVE a lowered one (e.g. 5), so the
      // (i) block can move it stor<->liten by changing the env knob alone.
      insertProvider.run({
        id: "prov-mid-size", navn: "Middels Gård AS", org_nr: "292929292", kommune: "Voss",
        rfb_seed_source: "rfb-seed", producer_type: null,
        epost: "post@middelsgard.no", telefon: null, hjemmeside: "https://middelsgard.no",
        about_text: "Om gården.", visit_text: null, opening_hours_text: null,
        products: "Cider", content_source: "provider_site",
        booking_live: 0, catalog_hidden: 0, slug: "middels-gard", field_provenance: VERIFIED_PROVENANCE,
        brreg_verified: 1,
        antall_ansatte: 10,
      });

      const opplevelserRouter = (require("./opplevelser") as typeof import("./opplevelser")).default as any;

      // ── (a) auth gate ────────────────────────────────────────────────────
      const noKey = await callRoute(opplevelserRouter, {});
      assertEq(noKey.status, 403, "a1: GET /admin/gardssalg-outreach-readiness without X-Admin-Key -> 403");
      assertTrue(!noKey.body?.providers, "a2: no-key response carries no report payload");

      const badKey = await callRoute(opplevelserRouter, { headers: { "x-admin-key": "wrong-key" } });
      assertEq(badKey.status, 403, "a3: GET /admin/gardssalg-outreach-readiness with wrong X-Admin-Key -> 403");

      // ── (b)/(c)/(d) happy path ──────────────────────────────────────────
      const ok = await callRoute(opplevelserRouter, { headers: { "x-admin-key": testKey } });
      assertEq(ok.status, 200, "b1: GET /admin/gardssalg-outreach-readiness (valid key) -> 200");
      assertTrue(Array.isArray(ok.body.providers), "b2: providers is an array");

      // The response carries `name`, not the internal fixture id, so look
      // rows up by the (unique) navn each fixture was inserted with.
      const NAME_BY_FIXTURE_ID: Record<string, string> = {
        "prov-ready": "Klar Gård AS",
        "prov-enrich": "Under Arbeid Gård",
        "prov-no-brreg": "Ubekreftet Brreg Gård",
        "prov-no-products": "Uten Produkter Gård",
        "prov-noweb": "Ingen Nettside Gård",
        "prov-unreach": "Utilgjengelig Gård",
        "prov-hidden": "Skjult Test Gård",
        "prov-claimed": "Krevd Gård AS",
        "prov-unverified": "Uverifisert Gård AS",
        "prov-conflict": "Konflikt Gård AS",
        "prov-nametoken": "Fjellbekken Håndbryggeri AS",
        "prov-large": "Macks Ølbryggeri",
        "prov-unknown-size": "Ukjent Størrelse Gård AS",
        "prov-mid-size": "Middels Gård AS",
      };
      const byId = (id: string) =>
        (ok.body.providers as any[]).find((r) => r.name === NAME_BY_FIXTURE_ID[id]);

      assertEq(ok.body.providers.length, 14, "d1: total providers is 14 (non-gårdssalg row excluded)");

      const ready = byId("prov-ready");
      assertTrue(!!ready, "b3: outreach_ready fixture present");
      assertEq(ready?.readiness_tier, "outreach_ready", "b4: prov-ready tiered outreach_ready");
      assertEq(ready?.has_website, true, "b5: prov-ready has_website true");
      assertEq(ready?.has_about_text, true, "b6: prov-ready has_about_text true");
      assertEq(ready?.has_visit_text, false, "b7: prov-ready has_visit_text false (krav 3 -- no longer required for outreach_ready)");
      assertEq(ready?.has_opening_hours, false, "b8: prov-ready has_opening_hours false (krav 3 -- no longer required for outreach_ready)");
      assertEq(ready?.has_products, true, "b9: prov-ready has_products true");
      assertEq(ready?.has_email, true, "b10: prov-ready has_email true");
      assertEq(ready?.has_phone, false, "b11: prov-ready has_phone false");
      assertEq(ready?.booking_status, "live", "b12: prov-ready booking_status live (booking_live=1, dispatch on)");
      assertEq(ready?.visible, true, "b13: prov-ready visible true");
      assertEq(ready?.claim_status, "provider_site", "b14: prov-ready claim_status carries raw content_source");
      assertEq(ready?.org_nr, "111111111", "b15: prov-ready org_nr passthrough");
      assertEq(ready?.kommune, "Voss", "b16: prov-ready kommune passthrough");
      assertEq(ready?.is_searchable, true, "b16a: prov-ready is_searchable true (slug + not hidden)");
      assertEq(ready?.website_verified, true, "b16b: prov-ready website_verified true (verified field_provenance)");
      assertEq(ready?.has_duplicate_conflict, false, "b16c: prov-ready has_duplicate_conflict false (no matching experience)");

      const enrich = byId("prov-enrich");
      assertEq(enrich?.readiness_tier, "needs_enrichment", "b17: prov-enrich tiered needs_enrichment");
      assertEq(enrich?.has_website, true, "b18: prov-enrich has_website true");
      assertEq(enrich?.has_about_text, false, "b19: prov-enrich has_about_text false");
      assertEq(enrich?.has_products, false, "b20: prov-enrich has_products false");
      assertEq(enrich?.booking_status, "none", "b21: prov-enrich booking_status none (booking_live=0)");

      // ── krav-2 negative cases: opening hours present does NOT compensate
      // for a missing brreg_verified or a missing products field.
      const noBrreg = byId("prov-no-brreg");
      assertTrue(!!noBrreg, "b21a: prov-no-brreg fixture present");
      assertEq(noBrreg?.readiness_tier, "needs_enrichment", "b21b: prov-no-brreg tiered needs_enrichment despite about_text+products+opening_hours all present (brreg_verified missing)");
      assertEq(noBrreg?.has_about_text, true, "b21c: prov-no-brreg has_about_text true");
      assertEq(noBrreg?.has_products, true, "b21d: prov-no-brreg has_products true");
      assertEq(noBrreg?.has_opening_hours, true, "b21e: prov-no-brreg has_opening_hours true (present, but no longer sufficient/relevant on its own)");

      const noProducts = byId("prov-no-products");
      assertTrue(!!noProducts, "b21f: prov-no-products fixture present");
      assertEq(noProducts?.readiness_tier, "needs_enrichment", "b21g: prov-no-products tiered needs_enrichment despite about_text+opening_hours present (products missing)");
      assertEq(noProducts?.has_about_text, true, "b21h: prov-no-products has_about_text true");
      assertEq(noProducts?.has_products, false, "b21i: prov-no-products has_products false");
      assertEq(noProducts?.has_opening_hours, true, "b21j: prov-no-products has_opening_hours true (present, but no longer sufficient/relevant on its own)");

      const noweb = byId("prov-noweb");
      assertEq(noweb?.readiness_tier, "no_website", "b22: prov-noweb tiered no_website");
      assertEq(noweb?.has_website, false, "b23: prov-noweb has_website false");
      assertEq(noweb?.has_phone, true, "b24: prov-noweb has_phone true (reachable, still no_website)");
      assertEq(noweb?.booking_status, "none", "b25: prov-noweb booking_status none (booking_live NULL)");

      const unreach = byId("prov-unreach");
      assertEq(unreach?.readiness_tier, "unreachable", "b26: prov-unreach tiered unreachable despite full content");
      assertEq(unreach?.has_website, true, "b27: prov-unreach has_website true");
      assertEq(unreach?.has_about_text, true, "b28: prov-unreach has_about_text true");
      assertEq(unreach?.has_email, false, "b29: prov-unreach has_email false");
      assertEq(unreach?.has_phone, false, "b30: prov-unreach has_phone false");

      const hidden = byId("prov-hidden");
      assertTrue(!!hidden, "b31: hidden (catalog_hidden=1) fixture is present, never dropped");
      assertEq(hidden?.visible, false, "b32: prov-hidden visible false");
      assertEq(hidden?.readiness_tier, "skjult", "b33: prov-hidden tiered skjult despite a slug + verified field_provenance (catalog_hidden checked first)");
      assertEq(hidden?.is_searchable, false, "b33a: prov-hidden is_searchable false (hidden rows are never searchable, even with a slug)");
      assertEq(hidden?.booking_status, "live", "b34: prov-hidden booking_status live (catalog_hidden test provider dispatches regardless of global switch)");

      const claimed = byId("prov-claimed");
      assertTrue(!!claimed, "b35: manually-claimed fixture is present, never dropped");
      assertEq(claimed?.claim_status, "manual", "b36: prov-claimed claim_status is 'manual'");
      assertEq(claimed?.readiness_tier, "ikke_soekbar", "b37: prov-claimed tiered ikke_soekbar (no slug -> fails on searchability before verification is even checked)");
      assertEq(claimed?.is_searchable, false, "b37a: prov-claimed is_searchable false (no slug)");

      const unverified = byId("prov-unverified");
      assertTrue(!!unverified, "b38: prov-unverified fixture is present");
      assertEq(unverified?.readiness_tier, "nettsted_uverifisert", "b39: prov-unverified tiered nettsted_uverifisert (slug present, but no verified field_provenance)");
      assertEq(unverified?.is_searchable, true, "b40: prov-unverified is_searchable true (has a slug, not hidden)");
      assertEq(unverified?.website_verified, false, "b41: prov-unverified website_verified false (field_provenance null)");

      const conflict = byId("prov-conflict");
      assertTrue(!!conflict, "b42: prov-conflict fixture is present");
      assertEq(conflict?.readiness_tier, "dublettkonflikt", "b43: prov-conflict tiered dublettkonflikt (matching experience row with mismatched booking_url domain)");
      assertEq(conflict?.is_searchable, true, "b44: prov-conflict is_searchable true (has a slug, not hidden)");
      assertEq(conflict?.website_verified, true, "b45: prov-conflict website_verified true (verified field_provenance)");
      assertEq(conflict?.has_duplicate_conflict, true, "b46: prov-conflict has_duplicate_conflict true");

      // ── (f) slice 1 (2026-08-07-dublett-evidensbasis-og-pool-avblokkering):
      // evidence basis only — a name_token pair must never block the pool
      // again. These assertions FAIL on the pre-slice-1 code (prov-nametoken
      // tiered dublettkonflikt there).
      const nameToken = byId("prov-nametoken");
      assertTrue(!!nameToken, "f1: prov-nametoken fixture is present");
      assertEq(nameToken?.readiness_tier, "outreach_ready", "f2: prov-nametoken tiered outreach_ready — a name_token-basis conflict pair must NOT block the pool");
      assertEq(nameToken?.has_duplicate_conflict, false, "f3: prov-nametoken has_duplicate_conflict false (name_token basis is candidate-only, never evidence)");
      assertEq(nameToken?.name_token_conflict_candidate, true, "f4: prov-nametoken carries the informational name_token_conflict_candidate flag");
      assertEq(conflict?.name_token_conflict_candidate, false, "f5: prov-conflict (provider_link basis) does NOT carry the candidate flag — the two fields never bleed into each other");
      assertEq(ready?.name_token_conflict_candidate, false, "f6: prov-ready (no matching experience at all) carries no candidate flag");

      // ── (g) AK1: antall_ansatte + derived size_flag exposed per row ─────
      assertEq(ready?.antall_ansatte, null, "g0: prov-ready antall_ansatte null (not set)");
      assertEq(ready?.size_flag, "ukjent", "g0a: prov-ready size_flag ukjent (antall_ansatte null, default-threshold branch)");

      const large = byId("prov-large");
      assertTrue(!!large, "g1: prov-large (Macks Ølbryggeri) fixture present");
      assertEq(large?.org_nr, "975967093", "g2: prov-large org_nr is Macks Ølbryggeri's real org number");
      assertEq(large?.antall_ansatte, 119, "g3: prov-large antall_ansatte 119 passthrough");
      assertEq(large?.size_flag, "stor", "g4: prov-large size_flag stor (119 >= default threshold 25) — AK1");
      assertEq(large?.readiness_tier, "outreach_ready", "g5: prov-large readiness_tier is unaffected by size_flag — the two fields never fold into each other");

      // ── (h) AK2: antall_ansatte NULL -> size_flag ukjent, never liten ───
      const unknownSize = byId("prov-unknown-size");
      assertTrue(!!unknownSize, "h1: prov-unknown-size fixture present");
      assertEq(unknownSize?.antall_ansatte, null, "h2: prov-unknown-size antall_ansatte null");
      assertEq(unknownSize?.size_flag, "ukjent", "h3: prov-unknown-size size_flag ukjent, NEVER liten — AK2");

      // No non-gårdssalg row leaked in.
      assertTrue(
        !(ok.body.providers as any[]).some((r) => r.name === "Ikke Gårdssalg AS"),
        "d2: non-gårdssalg provider excluded from providers list",
      );

      // ── (c) summary ──────────────────────────────────────────────────────
      // 14 fixtures: prov-ready + prov-nametoken + prov-large +
      // prov-unknown-size + prov-mid-size (outreach_ready, 5 — the three
      // size-signal fixtures are deliberately shaped outreach_ready so
      // size_flag can be observed independently of readiness_tier),
      // prov-enrich + prov-no-brreg + prov-no-products (needs_enrichment, 3),
      // prov-noweb (no_website), prov-unreach (unreachable), prov-hidden
      // (skjult), prov-claimed (ikke_soekbar), prov-unverified
      // (nettsted_uverifisert), prov-conflict (dublettkonflikt).
      assertEq(ok.body.summary.total, 14, "c1: summary.total is 14");
      assertEq(ok.body.summary.outreach_ready, 5, "c2: summary.outreach_ready counts prov-ready + prov-nametoken + prov-large + prov-unknown-size + prov-mid-size");
      assertEq(ok.body.summary.needs_enrichment, 3, "c3: summary.needs_enrichment counts prov-enrich + prov-no-brreg + prov-no-products");
      assertEq(ok.body.summary.no_website, 1, "c4: summary.no_website counts prov-noweb");
      assertEq(ok.body.summary.unreachable, 1, "c5: summary.unreachable counts prov-unreach");
      assertEq(ok.body.summary.skjult, 1, "c5a: summary.skjult counts prov-hidden");
      assertEq(ok.body.summary.ikke_soekbar, 1, "c5b: summary.ikke_soekbar counts prov-claimed");
      assertEq(ok.body.summary.nettsted_uverifisert, 1, "c5c: summary.nettsted_uverifisert counts prov-unverified");
      assertEq(ok.body.summary.dublettkonflikt, 1, "c5d: summary.dublettkonflikt counts prov-conflict");
      const summarySum =
        ok.body.summary.outreach_ready + ok.body.summary.needs_enrichment +
        ok.body.summary.no_website + ok.body.summary.unreachable +
        ok.body.summary.skjult + ok.body.summary.ikke_soekbar +
        ok.body.summary.nettsted_uverifisert + ok.body.summary.dublettkonflikt;
      assertEq(summarySum, ok.body.summary.total, "c6: per-tier summary counts (all 8 tiers) sum to total (every row tiered exactly once)");
      assertEq(ok.body.summary.name_token_conflict_candidates, 1, "c7: summary.name_token_conflict_candidates counts prov-nametoken only (informational, NOT a tier — excluded from the c6 sum)");

      // ── (i) AK4: threshold is read fresh on every call, no caching ──────
      // prov-mid-size has antall_ansatte 10 — "liten" under the default
      // threshold (25), "stor" once the threshold is lowered to 5, and back
      // to "liten" again once restored — proving the read happens at CALL
      // time, not once at module load.
      const midSize = byId("prov-mid-size");
      assertTrue(!!midSize, "i0: prov-mid-size fixture present");
      assertEq(midSize?.antall_ansatte, 10, "i0a: prov-mid-size antall_ansatte 10");
      assertEq(midSize?.size_flag, "liten", "i1: prov-mid-size size_flag liten under the default threshold (25)");

      const prevSizeThreshold = process.env.GARDSSALG_SIZE_THRESHOLD;
      try {
        process.env.GARDSSALG_SIZE_THRESHOLD = "5";
        const lowered = await callRoute(opplevelserRouter, { headers: { "x-admin-key": testKey } });
        const midSizeLowered = (lowered.body.providers as any[]).find((r) => r.name === "Middels Gård AS");
        assertEq(midSizeLowered?.size_flag, "stor", "i2: prov-mid-size size_flag flips to stor once GARDSSALG_SIZE_THRESHOLD=5 (10 >= 5) — AK4");

        process.env.GARDSSALG_SIZE_THRESHOLD = "25";
        const restored = await callRoute(opplevelserRouter, { headers: { "x-admin-key": testKey } });
        const midSizeRestored = (restored.body.providers as any[]).find((r) => r.name === "Middels Gård AS");
        assertEq(midSizeRestored?.size_flag, "liten", "i3: prov-mid-size size_flag flips back to liten once the threshold is restored to 25 — no caching across calls");
      } finally {
        if (prevSizeThreshold === undefined) delete process.env.GARDSSALG_SIZE_THRESHOLD;
        else process.env.GARDSSALG_SIZE_THRESHOLD = prevSizeThreshold;
      }

      // ── (e) zero-provider edge case ─────────────────────────────────────
      expDb.prepare("DELETE FROM experiences").run();
      expDb.prepare("DELETE FROM experience_providers").run();
      const empty = await callRoute(opplevelserRouter, { headers: { "x-admin-key": testKey } });
      assertEq(empty.status, 200, "e1: zero-provider case still returns 200");
      assertEq(empty.body.providers, [], "e2: providers is an empty array");
      assertEq(empty.body.summary.total, 0, "e3: summary.total is 0");
      assertEq(empty.body.summary.outreach_ready, 0, "e4: summary.outreach_ready is 0");
      assertEq(empty.body.summary.needs_enrichment, 0, "e5: summary.needs_enrichment is 0");
      assertEq(empty.body.summary.no_website, 0, "e6: summary.no_website is 0");
      assertEq(empty.body.summary.unreachable, 0, "e7: summary.unreachable is 0");
      assertEq(empty.body.summary.skjult, 0, "e8: summary.skjult is 0");
      assertEq(empty.body.summary.ikke_soekbar, 0, "e9: summary.ikke_soekbar is 0");
      assertEq(empty.body.summary.nettsted_uverifisert, 0, "e10: summary.nettsted_uverifisert is 0");
      assertEq(empty.body.summary.dublettkonflikt, 0, "e11: summary.dublettkonflikt is 0");
      assertEq(empty.body.summary.name_token_conflict_candidates, 0, "e12: summary.name_token_conflict_candidates is 0");
    } catch (err: any) {
      failed++;
      failures.push("opplevelser-gardssalg-outreach-readiness: unexpected error: " + String(err?.stack || err?.message || err));
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
      delete process.env.BOOKING_DISPATCH_ENABLED;
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

// Standalone runner: `npx tsx src/routes/opplevelser-gardssalg-outreach-readiness.test.ts`
if (require.main === module) {
  runOpplevelserGardssalgOutreachReadinessTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    process.exit(summary.failed > 0 ? 1 : 0);
  });
}
