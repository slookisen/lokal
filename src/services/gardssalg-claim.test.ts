/**
 * gardssalg-claim.test.ts — tests for the opplevagent gårdssalg producer
 * owner-claim service (dev-request 2026-07-21-opplevagent-claim-flyt-
 * drikkeprodusenter, src/services/gardssalg-claim.ts).
 *
 * Mirrors opplevelser-gardssalg-contact-coverage.test.ts's DB setup
 * (EXPERIENCES_DB_PATH=":memory:", fresh require of db-factory per run) for
 * the DB-backed tests; the org-linked-email derivation + masking tests are
 * pure (no DB needed at all).
 *
 * Covers the acceptance-criteria test list from the dev-request:
 *   (a) org-linked-email derivation — Brreg-contact case (dormant path,
 *       exercised via the explicit param), verified-domain case, and the
 *       no-match -> manual-fallback case.
 *   (b) the content_source='claim' lock invariant after a successful claim —
 *       verified against the REAL gardssalg-rfb-enrich.ts pickEnrichmentFields
 *       (the actual enrichment gate), not a re-implementation of its logic.
 *   (c) session gating primitives (verify/issue/revoke/rate-limit).
 *   (d) owner profile update (whitelist, manual-lock skip, sanitation).
 *
 * Exported runGardssalgClaimTests({log}) -> TestSummary; wired into
 * tests/test.ts. Standalone: npx tsx src/services/gardssalg-claim.test.ts
 */

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export function runGardssalgClaimTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
    // ── Pure tests: derivation + masking (no DB) ────────────────────────
    {
      const {
        deriveOrgLinkedEmail,
        isHjemmesideOwnershipVerified,
        maskEmail,
      } = require("./gardssalg-claim") as typeof import("./gardssalg-claim");

      // (a1) Not Brreg-verified -> ineligible, regardless of anything else.
      const r1 = deriveOrgLinkedEmail({
        org_nr: "912345678", brreg_verified: 0, hjemmeside: "https://gard.no",
        content_source: "manual", field_provenance: null,
      });
      assertEq(r1, { eligible: false, reason: "not_brreg_verified" }, "a1: brreg_verified=0 -> not_brreg_verified");

      const r1b = deriveOrgLinkedEmail({
        org_nr: null, brreg_verified: 1, hjemmeside: "https://gard.no",
        content_source: "manual", field_provenance: null,
      });
      assertEq(r1b, { eligible: false, reason: "not_brreg_verified" }, "a1b: no org_nr -> not_brreg_verified even if brreg_verified=1");

      // (a2) Brreg-contact-email path (dormant in prod, but the function must
      // honor it the moment a caller supplies one).
      const r2 = deriveOrgLinkedEmail(
        { org_nr: "912345678", brreg_verified: 1, hjemmeside: null, content_source: null, field_provenance: null },
        "post@brreg-kilde.no",
      );
      assertEq(r2, { eligible: true, email: "post@brreg-kilde.no", source: "brreg_contact" }, "a2: brreg-contact email present -> eligible via brreg_contact");

      // (a3) Verified-domain path — content_source='manual' counts as verified.
      const r3 = deriveOrgLinkedEmail({
        org_nr: "912345678", brreg_verified: 1, hjemmeside: "https://www.klostergarden.no/om-oss",
        content_source: "manual", field_provenance: null,
      });
      assertEq(r3, { eligible: true, email: "post@klostergarden.no", source: "verified_domain_address" }, "a3: manual content_source + hjemmeside -> eligible via post@<domain>, www/path stripped");

      // (a3b) Verified-domain path via field_provenance.hjemmeside (the
      // admin-approved discovery evidence marker) — content_source can be
      // 'provider_site' or even null, only the provenance marker matters.
      const r3b = deriveOrgLinkedEmail({
        org_nr: "912345678", brreg_verified: 1, hjemmeside: "https://bringebaerlandet.no",
        content_source: "provider_site",
        field_provenance: JSON.stringify({ hjemmeside: { source_url: "https://visitnorway.no/listing/123", fetched_at: "2026-07-01T00:00:00Z" } }),
      });
      assertEq(r3b, { eligible: true, email: "post@bringebaerlandet.no", source: "verified_domain_address" }, "a3b: field_provenance.hjemmeside evidence marker -> eligible via post@<domain>");

      // (a4) No org-linked email at all -> manual fallback, NEVER self-service.
      const r4 = deriveOrgLinkedEmail({
        org_nr: "912345678", brreg_verified: 1, hjemmeside: "https://raw-crawled-guess.no",
        content_source: "provider_site", field_provenance: null,
      });
      assertEq(r4, { eligible: false, reason: "no_org_linked_email" }, "a4: unvetted hjemmeside (no provenance, not manual) -> no_org_linked_email");

      // (a4c) SECURITY: a generic/shared domain must NEVER become a claim
      // target, even when "verified" via content_source='manual' — Daniel
      // entering a Facebook page as a producer's hjemmeside (no real site)
      // must not derive post@facebook.com. Falls through to manual fallback,
      // same as the no-provenance case above.
      const r4c = deriveOrgLinkedEmail({
        org_nr: "912345678", brreg_verified: 1, hjemmeside: "https://www.facebook.com/klostergarden",
        content_source: "manual", field_provenance: null,
      });
      assertEq(r4c, { eligible: false, reason: "no_org_linked_email" }, "a4c: manual content_source but generic domain (facebook.com) -> no_org_linked_email, no post@facebook.com");

      // (a4d) Same, via the admin-approved field_provenance path instead of
      // 'manual' — a bare gmail.com/wixsite.com value slipping through an
      // approval must not become a claim target either.
      const r4d = deriveOrgLinkedEmail({
        org_nr: "912345678", brreg_verified: 1, hjemmeside: "https://gmail.com",
        content_source: "provider_site",
        field_provenance: JSON.stringify({ hjemmeside: { source_url: "https://visitnorway.no/listing/456", fetched_at: "2026-07-01T00:00:00Z" } }),
      });
      assertEq(r4d, { eligible: false, reason: "no_org_linked_email" }, "a4d: field_provenance-verified but generic domain (gmail.com) -> no_org_linked_email");

      // (a4e-h) SECURITY REGRESSION (fix-up iteration 2): the generic-domain
      // check must be suffix-aware (catch SUBDOMAINS of a listed generic
      // host, not just an exact string match) and trailing-dot-safe (a
      // stray FQDN dot must not slip a generic domain past the check).
      // Independent review found exact-Set-membership alone let
      // "mail.gmail.com", "sub.facebook.com", and "gmail.com." (trailing
      // dot) all sail through as "eligible" -> post@<generic-host>, which
      // defeats the whole point of the a4c/a4d checks above.
      const r4e = deriveOrgLinkedEmail({
        org_nr: "912345678", brreg_verified: 1, hjemmeside: "https://mail.gmail.com",
        content_source: "manual", field_provenance: null,
      });
      assertEq(r4e, { eligible: false, reason: "no_org_linked_email" }, "a4e: subdomain of a generic host (mail.gmail.com) -> no_org_linked_email, not just exact-match gmail.com");

      const r4f = deriveOrgLinkedEmail({
        org_nr: "912345678", brreg_verified: 1, hjemmeside: "https://sub.facebook.com",
        content_source: "manual", field_provenance: null,
      });
      assertEq(r4f, { eligible: false, reason: "no_org_linked_email" }, "a4f: subdomain of a generic host (sub.facebook.com) -> no_org_linked_email");

      const r4g = deriveOrgLinkedEmail({
        org_nr: "912345678", brreg_verified: 1, hjemmeside: "https://gmail.com./",
        content_source: "manual", field_provenance: null,
      });
      assertEq(r4g, { eligible: false, reason: "no_org_linked_email" }, "a4g: trailing-FQDN-dot generic domain (gmail.com.) -> no_org_linked_email, dot must not defeat the Set match");

      // Regression guard: a PURE case difference (no subdomain, no trailing
      // dot) already worked before this fix-up via normalizeDomain's
      // lowercasing — must still work, don't let the new suffix logic
      // regress it.
      const r4h = deriveOrgLinkedEmail({
        org_nr: "912345678", brreg_verified: 1, hjemmeside: "https://GMAIL.COM",
        content_source: "manual", field_provenance: null,
      });
      assertEq(r4h, { eligible: false, reason: "no_org_linked_email" }, "a4h: pure-case generic domain (GMAIL.COM) -> no_org_linked_email (pre-existing behavior, regression guard only)");

      // (a4i) A genuinely DISTINCT domain must NOT be caught by the suffix
      // check merely because it happens to start with a generic name as a
      // label prefix — "gmail.com.evil.example" is not a subdomain of
      // gmail.com (it doesn't END with ".gmail.com"), it's an unrelated,
      // real domain and must still be eligible.
      const r4i = deriveOrgLinkedEmail({
        org_nr: "912345678", brreg_verified: 1, hjemmeside: "https://gmail.com.evil.example",
        content_source: "manual", field_provenance: null,
      });
      assertEq(
        r4i,
        { eligible: true, email: "post@gmail.com.evil.example", source: "verified_domain_address" },
        "a4i: genuinely distinct domain (gmail.com.evil.example) is NOT a subdomain bypass -> still eligible",
      );

      const r4b = deriveOrgLinkedEmail({
        org_nr: "912345678", brreg_verified: 1, hjemmeside: null,
        content_source: null, field_provenance: null,
      });
      assertEq(r4b, { eligible: false, reason: "no_org_linked_email" }, "a4b: no hjemmeside at all -> no_org_linked_email");

      // isHjemmesideOwnershipVerified direct coverage
      assertTrue(isHjemmesideOwnershipVerified({ content_source: "manual", field_provenance: null }), "a5: content_source=manual -> verified");
      assertTrue(
        isHjemmesideOwnershipVerified({ content_source: null, field_provenance: JSON.stringify({ hjemmeside: { source_url: "https://x.no/y" } }) }),
        "a6: field_provenance.hjemmeside.source_url present -> verified",
      );
      assertTrue(!isHjemmesideOwnershipVerified({ content_source: "provider_site", field_provenance: null }), "a7: no provenance, not manual -> not verified");
      assertTrue(!isHjemmesideOwnershipVerified({ content_source: "provider_site", field_provenance: "{not json" }), "a8: malformed field_provenance JSON -> not verified (never throws)");
      assertTrue(
        !isHjemmesideOwnershipVerified({ content_source: null, field_provenance: JSON.stringify({ adresse: { source_url: "https://x.no" } }) }),
        "a9: provenance present for a DIFFERENT field (adresse) -> hjemmeside still not verified",
      );

      // maskEmail
      assertEq(maskEmail("post@bringebaerlandet.no"), "p**t@b******.no", "a10: maskEmail masks local (keeps first+last) + domain (first char only), keeps TLD");
      assertTrue(!maskEmail("post@bringebaerlandet.no").includes("bringebaerlandet"), "a11: maskEmail never leaks the full domain name");
      assertEq(maskEmail("ab@x.no"), "a*@x*.no", "a12: maskEmail handles very short local/domain parts without throwing");

      // ── stored_epost_verified (dev-request 2026-07-30-opplevagent-claim-
      // epost-og-perfelt-laas, item 1) — pure deriveOrgLinkedEmail coverage.
      // (b-epost)'s DB lookup is exercised separately, below, via the
      // opts.epostOutreachDeliveredNoBounce parameter this pure function
      // takes as an input rather than computing itself.

      // (f1) (c-epost): content_source='manual' + a well-formed stored epost,
      // no hjemmeside at all -> eligible via stored_epost_verified. Also
      // covers normalization (trim + lowercase), same as the other tiers.
      const rF1 = deriveOrgLinkedEmail({
        org_nr: "912345678", brreg_verified: 1, hjemmeside: null,
        content_source: "manual", field_provenance: null, epost: "  Post@BryggeriX.no ",
      });
      assertEq(rF1, { eligible: true, email: "post@bryggerix.no", source: "stored_epost_verified" }, "f1: content_source=manual + stored epost (no hjemmeside) -> eligible via stored_epost_verified, normalized");

      // (f2) ACCEPTANCE CRITERION 2 (pure level): a scraped-only epost — no
      // admin-entered marker, no outreach-delivered signal — must stay
      // ineligible. This is the negative control the dev-request calls out
      // by name.
      const rF2 = deriveOrgLinkedEmail({
        org_nr: "912345678", brreg_verified: 1, hjemmeside: null,
        content_source: "provider_site", field_provenance: null, epost: "scraped@somewhere.no",
      });
      assertEq(rF2, { eligible: false, reason: "no_org_linked_email" }, "f2: scraped-only epost (not manual, no outreach-delivered signal) -> no_org_linked_email (Acceptance Criterion 2)");

      // (f3) (b-epost): opts.epostOutreachDeliveredNoBounce=true makes an
      // otherwise-harvested row's epost eligible.
      const rF3 = deriveOrgLinkedEmail(
        { org_nr: "912345678", brreg_verified: 1, hjemmeside: null, content_source: "provider_site", field_provenance: null, epost: "outreach@bryggeriy.no" },
        undefined,
        { epostOutreachDeliveredNoBounce: true },
      );
      assertEq(rF3, { eligible: true, email: "outreach@bryggeriy.no", source: "stored_epost_verified" }, "f3: opts.epostOutreachDeliveredNoBounce=true -> eligible via stored_epost_verified even though content_source is not manual");

      // (f4) The same row with the flag explicitly false -> still ineligible
      // (guards against the opts object merely being PRESENT being mistaken
      // for true).
      const rF4 = deriveOrgLinkedEmail(
        { org_nr: "912345678", brreg_verified: 1, hjemmeside: null, content_source: "provider_site", field_provenance: null, epost: "outreach@bryggeriy.no" },
        undefined,
        { epostOutreachDeliveredNoBounce: false },
      );
      assertEq(rF4, { eligible: false, reason: "no_org_linked_email" }, "f4: opts.epostOutreachDeliveredNoBounce=false -> no_org_linked_email, same as omitting opts entirely");

      // (f5) Malformed epost shape (no '@'/domain) must never be offered as
      // a claim target, even with content_source='manual'.
      const rF5 = deriveOrgLinkedEmail({
        org_nr: "912345678", brreg_verified: 1, hjemmeside: null,
        content_source: "manual", field_provenance: null, epost: "not-an-email",
      });
      assertEq(rF5, { eligible: false, reason: "no_org_linked_email" }, "f5: malformed epost value (no @/domain) -> no_org_linked_email");

      // (f5b) Blank/whitespace-only epost, same guard.
      const rF5b = deriveOrgLinkedEmail({
        org_nr: "912345678", brreg_verified: 1, hjemmeside: null,
        content_source: "manual", field_provenance: null, epost: "   ",
      });
      assertEq(rF5b, { eligible: false, reason: "no_org_linked_email" }, "f5b: blank/whitespace-only epost -> no_org_linked_email even when content_source=manual");

      // (f5c) `epost` omitted entirely — the exact shape every EXISTING
      // pure-test literal in this file uses (a1-a4i above never pass epost)
      // — must still compile and behave as "absent", never throw.
      const rF5c = deriveOrgLinkedEmail({
        org_nr: "912345678", brreg_verified: 1, hjemmeside: null,
        content_source: "manual", field_provenance: null,
      });
      assertEq(rF5c, { eligible: false, reason: "no_org_linked_email" }, "f5c: epost field omitted entirely -> treated as absent, no crash, no_org_linked_email");

      // (f6) TIER PRIORITY: a qualifying verified_domain_address must win
      // over stored_epost_verified even when content_source='manual' would
      // make BOTH tiers match on the very same row.
      const rF6 = deriveOrgLinkedEmail({
        org_nr: "912345678", brreg_verified: 1, hjemmeside: "https://klostergarden.no",
        content_source: "manual", field_provenance: null, epost: "other@klostergarden.no",
      });
      assertEq(rF6, { eligible: true, email: "post@klostergarden.no", source: "verified_domain_address" }, "f6: tier priority — verified_domain_address wins over stored_epost_verified when both would apply");

      // (f7) TIER PRIORITY: brreg_contact (the dormant-but-highest tier)
      // wins over stored_epost_verified too, when supplied.
      const rF7 = deriveOrgLinkedEmail(
        { org_nr: "912345678", brreg_verified: 1, hjemmeside: null, content_source: "manual", field_provenance: null, epost: "fallback@bryggeriz.no" },
        "post@brreg-kilde.no",
      );
      assertEq(rF7, { eligible: true, email: "post@brreg-kilde.no", source: "brreg_contact" }, "f7: tier priority — brreg_contact wins over stored_epost_verified when both would apply");

      // ── deriveOrgLinkedEmailCandidates — dev-request 2026-08-06-claim-
      // produsent-velger-mottakeradresse. AC1 (all qualifying candidates,
      // not just the first) + AC7 (never a non-qualifying one). ──────────
      const { deriveOrgLinkedEmailCandidates } = require("./gardssalg-claim") as typeof import("./gardssalg-claim");

      const noneCandidates = deriveOrgLinkedEmailCandidates({ org_nr: null, brreg_verified: 0, hjemmeside: null, content_source: null, field_provenance: null });
      assertEq(noneCandidates, [], "i1: not Brreg-verified -> zero candidates (AC7 — never a non-qualifying tier)");

      // Same row as rF6/rF7 above (both verified_domain_address AND
      // stored_epost_verified independently qualify) — the single-result
      // function picks the first (f6); the candidates function must return
      // BOTH, in stable tier order, and never a THIRD entry that wasn't one
      // of the two qualifying tiers.
      const twoCandidates = deriveOrgLinkedEmailCandidates({
        org_nr: "912345678", brreg_verified: 1, hjemmeside: "https://klostergarden.no",
        content_source: "manual", field_provenance: null, epost: "other@klostergarden.no",
      });
      assertEq(
        twoCandidates,
        [
          { email: "post@klostergarden.no", source: "verified_domain_address" },
          { email: "other@klostergarden.no", source: "stored_epost_verified" },
        ],
        "i2: a row qualifying on two tiers -> both candidates, in tier order (AC1)",
      );

      const threeCandidates = deriveOrgLinkedEmailCandidates(
        {
          org_nr: "912345678", brreg_verified: 1, hjemmeside: "https://klostergarden.no",
          content_source: "manual", field_provenance: null, epost: "other@klostergarden.no",
        },
        "post@brreg-kilde.no",
      );
      assertEq(
        threeCandidates,
        [
          { email: "post@brreg-kilde.no", source: "brreg_contact" },
          { email: "post@klostergarden.no", source: "verified_domain_address" },
          { email: "other@klostergarden.no", source: "stored_epost_verified" },
        ],
        "i3: a row qualifying on all three tiers -> all three, in tier order",
      );

      const oneCandidate = deriveOrgLinkedEmailCandidates({
        org_nr: "912345678", brreg_verified: 1, hjemmeside: null,
        content_source: "manual", field_provenance: null, epost: "post@bryggerix.no",
      });
      assertEq(
        oneCandidate,
        [{ email: "post@bryggerix.no", source: "stored_epost_verified" }],
        "i4: a row qualifying on exactly one tier -> a single-element list (AC3's underlying data shape)",
      );
      assertEq(
        deriveOrgLinkedEmail({
          org_nr: "912345678", brreg_verified: 1, hjemmeside: null,
          content_source: "manual", field_provenance: null, epost: "post@bryggerix.no",
        }),
        { eligible: true, email: oneCandidate[0].email, source: oneCandidate[0].source },
        "i5: deriveOrgLinkedEmail() and deriveOrgLinkedEmailCandidates()[0] agree for a single-candidate row (AC1 — existing callers unchanged)",
      );

      const genericDomainCandidates = deriveOrgLinkedEmailCandidates({
        org_nr: "922222222", brreg_verified: 1, hjemmeside: "https://www.facebook.com/x",
        content_source: "provider_site",
        field_provenance: JSON.stringify({ hjemmeside: { source_url: "https://example.no/listing", fetched_at: "2026-07-01T00:00:00Z" } }),
        epost: "scraped-only@x.no",
      });
      assertEq(
        genericDomainCandidates,
        [],
        "i6: generic-domain hjemmeside + a non-qualifying epost -> zero candidates, never post@facebook.com (AC7 security regression guard)",
      );
    }

    // ── DB-backed tests ──────────────────────────────────────────────────
    const prevExperiencesDbPath = process.env.EXPERIENCES_DB_PATH;
    process.env.EXPERIENCES_DB_PATH = ":memory:";

    const dbFactoryPath = require.resolve("../database/db-factory");
    const claimSvcPath = require.resolve("./gardssalg-claim");
    const enrichPath = require.resolve("./gardssalg-rfb-enrich");
    for (const p of [dbFactoryPath, claimSvcPath, enrichPath]) delete require.cache[p];

    // stored_epost_verified's (b-epost) sub-case reads outreach_sent_log /
    // email_bounces from the RFB MAIN db (lokal.db), not experiences.db —
    // see wasEpostDeliveredOutreachNoBounce()'s doc comment in
    // gardssalg-claim.ts for why. A standalone, fully-schema'd in-memory RFB
    // db is created and wired in via gardssalg-claim.ts's OWN
    // __setRfbDbForTesting() override — deliberately NOT
    // src/database/init.ts's __setDbForTesting (the shared, module-level
    // singleton every other suite in tests/test.ts also reads/swaps): doing
    // that here raced live against a concurrently-running, unrelated suite
    // in the full test.ts run (oa-home-counters intermittently saw "no such
    // table: outreach_sent_log") — the exact failure class this test file's
    // own postmortem comments describe elsewhere ("the exact failure mode
    // this file's own tasks-prune-async postmortem documents"). This db is
    // only ever handed directly to gardssalg-claim.ts's own override, never
    // installed as the global singleton, so it cannot race with anything.
    const initMod = require("../database/init") as typeof import("../database/init");
    const Database = require("better-sqlite3") as typeof import("better-sqlite3");
    const rfbDb = new Database(":memory:");
    initMod.__initSchemaForTesting(rfbDb as any);

    try {
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const expDb = dbFactory.getDb("experiences");

      const claimSvc = require("./gardssalg-claim") as typeof import("./gardssalg-claim");
      claimSvc.__setRfbDbForTesting(rfbDb as any);
      const enrich = require("./gardssalg-rfb-enrich") as typeof import("./gardssalg-rfb-enrich");

      const insertProvider = expDb.prepare(`
        INSERT INTO experience_providers
          (id, navn, slug, vertical, org_nr, brreg_verified, hjemmeside, content_source, field_provenance,
           about_text, visit_text, opening_hours_text, products, booking_live, epost,
           enrichment_state, verification_status, source, confidence)
        VALUES
          (@id, @navn, @slug, 'experiences', @org_nr, @brreg_verified, @hjemmeside, @content_source, @field_provenance,
           NULL, NULL, NULL, NULL, 0, NULL,
           'raw', 'pending_verify', 'test-fixture', 'medium')
      `);

      // A claimable provider: Brreg-verified, hjemmeside vetted via admin-
      // approved discovery evidence (field_provenance.hjemmeside).
      insertProvider.run({
        id: "prov-claimable", navn: "Klostergården Håndbryggeri", slug: "klostergarden-handbryggeri",
        org_nr: "912345678", brreg_verified: 1, hjemmeside: "https://klostergarden.no",
        content_source: "provider_site",
        field_provenance: JSON.stringify({ hjemmeside: { source_url: "https://visitnorway.no/listing/klostergarden", fetched_at: "2026-07-01T00:00:00Z" } }),
      });
      // A provider with no verifiable domain and no Brreg contact -> manual
      // fallback only.
      insertProvider.run({
        id: "prov-noemail", navn: "Ukjent Gård", slug: "ukjent-gard",
        org_nr: "999999999", brreg_verified: 1, hjemmeside: null,
        content_source: null, field_provenance: null,
      });
      // Already Daniel-curated (manual) — still claimable (session still
      // granted), but the content lock must NOT be downgraded to 'claim'.
      insertProvider.run({
        id: "prov-manual", navn: "Daniels Gård", slug: "daniels-gard",
        org_nr: "911111111", brreg_verified: 1, hjemmeside: "https://danielsgard.no",
        content_source: "manual", field_provenance: null,
      });
      // SECURITY regression fixture: content_source='manual' (so
      // isHjemmesideOwnershipVerified is true) but hjemmeside is a generic/
      // shared domain (Facebook page entered as the producer's "hjemmeside").
      // Must NOT produce a viable claim-email -> manual fallback only.
      insertProvider.run({
        id: "prov-generic-domain", navn: "Gård Uten Egen Nettside", slug: "gard-uten-egen-nettside",
        org_nr: "922222222", brreg_verified: 1, hjemmeside: "https://www.facebook.com/gardutenegennettside",
        content_source: "manual", field_provenance: null,
      });

      // ── stored_epost_verified DB-backed fixtures ─────────────────────────
      // `epost` is a hardcoded NULL literal in insertProvider's own SQL
      // above (not a bound parameter), so these are set via a follow-up
      // UPDATE rather than widening that shared statement for every caller.
      const setEpost = expDb.prepare("UPDATE experience_providers SET epost = ? WHERE id = ?");

      // (c-epost) content_source='manual', no hjemmeside at all -> only the
      // stored_epost_verified tier can fire here.
      insertProvider.run({
        id: "prov-epost-manual", navn: "Manuelt Registrert Gård", slug: "manuelt-registrert-gard",
        org_nr: "933333333", brreg_verified: 1, hjemmeside: null,
        content_source: "manual", field_provenance: null,
      });
      setEpost.run("post@epostmanual.no", "prov-epost-manual");

      // (b-epost) content_source='provider_site' (harvested, NOT manual) —
      // only eligible if the RFB outreach_sent_log/email_bounces lookup
      // says so. This row's epost WAS delivered outreach, no bounce.
      insertProvider.run({
        id: "prov-epost-outreach", navn: "Utsendt Gård", slug: "utsendt-gard",
        org_nr: "944444444", brreg_verified: 1, hjemmeside: null,
        content_source: "provider_site", field_provenance: null,
      });
      setEpost.run("utsendt@epostoutreach.no", "prov-epost-outreach");

      // Same shape, but the address subsequently bounced -> must NOT be
      // eligible (the whole point of the "no bounce" half of criterion b).
      insertProvider.run({
        id: "prov-epost-bounced", navn: "Sprettet Gård", slug: "sprettet-gard",
        org_nr: "955555555", brreg_verified: 1, hjemmeside: null,
        content_source: "provider_site", field_provenance: null,
      });
      setEpost.run("sprettet@epostoutreach.no", "prov-epost-bounced");

      // Same shape, but the ONLY outreach_sent_log row for this address is
      // stamped vertical_id='rfb' (an RFB send, not an Opplevagent one) —
      // must NOT count as "delivered Opplevagent outreach".
      insertProvider.run({
        id: "prov-epost-wrong-vertical", navn: "Feil Plattform Gård", slug: "feil-plattform-gard",
        org_nr: "966666666", brreg_verified: 1, hjemmeside: null,
        content_source: "provider_site", field_provenance: null,
      });
      setEpost.run("kunrfb@epostoutreach.no", "prov-epost-wrong-vertical");

      // ACCEPTANCE CRITERION 2, at the full issueClaimMagicLink level: a
      // purely scraped epost (harvested content_source, no outreach row at
      // all, not manual) must stay on the manual-fallback path end to end.
      insertProvider.run({
        id: "prov-epost-scraped-only", navn: "Skrapet Gård", slug: "skrapet-gard",
        org_nr: "977777777", brreg_verified: 1, hjemmeside: null,
        content_source: "provider_site", field_provenance: null,
      });
      setEpost.run("scraped@nowhere.no", "prov-epost-scraped-only");

      // Seed the RFB-side outreach_sent_log / email_bounces rows the
      // (b-epost) cases above depend on. agent_id is NOT NULL REFERENCES
      // agents(id) — a real agents row is inserted too so this fixture holds
      // even if a future change turns FK enforcement on for this DB.
      rfbDb.prepare(`
        INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, is_active)
        VALUES ('agent-fixture-osl', 'Fixture Agent', 'x', 'test', 'agent-fixture@example.no', 'https://example.no', 'producer', 'fixture-key-osl', 1)
      `).run();
      rfbDb.prepare(`
        INSERT INTO outreach_sent_log (agent_id, recipient_email, sent_at, channel, vertical_id)
        VALUES ('agent-fixture-osl', 'utsendt@epostoutreach.no', datetime('now', '-2 days'), 'email', 'experiences')
      `).run();
      rfbDb.prepare(`
        INSERT INTO outreach_sent_log (agent_id, recipient_email, sent_at, channel, vertical_id)
        VALUES ('agent-fixture-osl', 'sprettet@epostoutreach.no', datetime('now', '-2 days'), 'email', 'experiences')
      `).run();
      rfbDb.prepare(`
        INSERT INTO email_bounces (email, bounced_at, bounce_type)
        VALUES ('sprettet@epostoutreach.no', datetime('now', '-1 days'), 'hard')
      `).run();
      rfbDb.prepare(`
        INSERT INTO outreach_sent_log (agent_id, recipient_email, sent_at, channel, vertical_id)
        VALUES ('agent-fixture-osl', 'kunrfb@epostoutreach.no', datetime('now', '-2 days'), 'email', 'rfb')
      `).run();

      // ── wasEpostDeliveredOutreachNoBounce — direct coverage ─────────────
      assertTrue(claimSvc.wasEpostDeliveredOutreachNoBounce("utsendt@epostoutreach.no"), "g1: a delivered, non-bounced experiences-vertical send -> true");
      assertTrue(claimSvc.wasEpostDeliveredOutreachNoBounce("  UTSENDT@EpostOutreach.NO  "), "g1b: same, but case/whitespace-different input -> still true (normalized match)");
      assertTrue(!claimSvc.wasEpostDeliveredOutreachNoBounce("sprettet@epostoutreach.no"), "g2: a delivered send that later bounced -> false");
      assertTrue(!claimSvc.wasEpostDeliveredOutreachNoBounce("kunrfb@epostoutreach.no"), "g3: a send stamped vertical_id='rfb' (not 'experiences') -> false, does not count as Opplevagent outreach");
      assertTrue(!claimSvc.wasEpostDeliveredOutreachNoBounce("never-emailed@nowhere.no"), "g4: no matching outreach_sent_log row at all -> false");
      assertTrue(!claimSvc.wasEpostDeliveredOutreachNoBounce(null), "g5: null input -> false, never throws");
      assertTrue(!claimSvc.wasEpostDeliveredOutreachNoBounce(""), "g6: empty-string input -> false, never throws");

      // ── issueClaimMagicLink ────────────────────────────────────────────
      const notFound = claimSvc.issueClaimMagicLink("prov-missing");
      assertEq(notFound, { ok: false, error: "provider_not_found" }, "b1: issueClaimMagicLink on a missing provider -> provider_not_found");

      const noEmail = claimSvc.issueClaimMagicLink("prov-noemail");
      assertEq(noEmail, { ok: false, error: "no_org_linked_email" }, "b2: issueClaimMagicLink with no org-linked email -> no_org_linked_email (no self-service)");

      // SECURITY: a 'manual' provider whose hjemmeside is a generic/shared
      // domain (Facebook page, no real site) must never issue a claim link —
      // that would derive post@facebook.com as the "verified" target.
      const genericDomain = claimSvc.issueClaimMagicLink("prov-generic-domain");
      assertEq(genericDomain, { ok: false, error: "no_org_linked_email" }, "b2b: issueClaimMagicLink on a manual provider with a generic-domain hjemmeside (facebook.com) -> no_org_linked_email, never a viable claim-email");

      const issued = claimSvc.issueClaimMagicLink("prov-claimable");
      assertTrue(issued.ok === true, "b3: issueClaimMagicLink succeeds for the claimable provider");
      if (issued.ok) {
        assertEq(issued.claim.email, "post@klostergarden.no", "b4: issued claim targets post@<verified-domain>");
        assertEq(issued.claim.maskedEmail, claimSvc.maskEmail("post@klostergarden.no"), "b5: issued claim carries the masked email");
        const row = expDb.prepare("SELECT provider_id, email, used FROM gardssalg_claims WHERE token = ?").get(issued.claim.token) as any;
        assertTrue(!!row, "b6: a gardssalg_claims row was inserted for the issued token");
        assertEq(row.provider_id, "prov-claimable", "b7: inserted row references the right provider");
        assertEq(row.used, 0, "b8: freshly-issued token is not yet used");
      }

      // ── stored_epost_verified — full issueClaimMagicLink integration ────

      // (c-epost) positive: content_source='manual', no verified hjemmeside —
      // only the stored epost tier can produce this claim.
      const issuedManualEpost = claimSvc.issueClaimMagicLink("prov-epost-manual");
      assertTrue(issuedManualEpost.ok === true, "h1: issueClaimMagicLink succeeds for a manual provider via its stored epost");
      if (issuedManualEpost.ok) {
        assertEq(issuedManualEpost.claim.email, "post@epostmanual.no", "h2: issued claim targets the provider's OWN stored epost, unchanged");
        assertEq(issuedManualEpost.claim.source, "stored_epost_verified", "h3: claim.source is stored_epost_verified");
        const row = expDb.prepare("SELECT email_source FROM gardssalg_claims WHERE token = ?").get(issuedManualEpost.claim.token) as any;
        assertEq(row.email_source, "stored_epost_verified", "h4: the persisted gardssalg_claims row also carries email_source='stored_epost_verified'");
      }

      // (b-epost) positive: harvested content_source, but the address was
      // real, delivered, non-bounced Opplevagent outreach.
      const issuedOutreachEpost = claimSvc.issueClaimMagicLink("prov-epost-outreach");
      assertTrue(issuedOutreachEpost.ok === true, "h5: issueClaimMagicLink succeeds for a harvested-content_source provider whose epost received delivered, non-bounced outreach");
      if (issuedOutreachEpost.ok) {
        assertEq(issuedOutreachEpost.claim.email, "utsendt@epostoutreach.no", "h6: issued claim targets the outreach-delivered address");
        assertEq(issuedOutreachEpost.claim.source, "stored_epost_verified", "h7: claim.source is stored_epost_verified");
      }

      // Negative: same shape, but the address bounced -> no self-service.
      const bouncedEpost = claimSvc.issueClaimMagicLink("prov-epost-bounced");
      assertEq(bouncedEpost, { ok: false, error: "no_org_linked_email" }, "h8: a bounced outreach address never becomes a claim target, even though a send WAS logged");

      // Negative: outreach_sent_log row exists but is stamped vertical_id='rfb'.
      const wrongVerticalEpost = claimSvc.issueClaimMagicLink("prov-epost-wrong-vertical");
      assertEq(wrongVerticalEpost, { ok: false, error: "no_org_linked_email" }, "h9: an RFB-vertical outreach_sent_log row does not qualify an Opplevagent claim");

      // ACCEPTANCE CRITERION 2, full call chain: purely scraped epost, no
      // provenance at all -> manual fallback, never self-service.
      const scrapedOnlyEpost = claimSvc.issueClaimMagicLink("prov-epost-scraped-only");
      assertEq(scrapedOnlyEpost, { ok: false, error: "no_org_linked_email" }, "h10: Acceptance Criterion 2 — a purely scraped epost (no provenance) stays on the manual fallback end to end");

      // ── Producer address selection — dev-request 2026-08-06-claim-
      // produsent-velger-mottakeradresse. A realistic two-candidate row: a
      // vetted own domain (verified_domain_address) AND a manually-entered
      // Gmail (stored_epost_verified) — the exact "small producer with only
      // a Gmail" case the dev-request itself cites. ────────────────────────
      insertProvider.run({
        id: "prov-two-candidates", navn: "To Adresser Gård", slug: "to-adresser-gard",
        org_nr: "990000001", brreg_verified: 1, hjemmeside: "https://toadresser.no",
        content_source: "manual", field_provenance: null,
      });
      setEpost.run("eier@gmail.com", "prov-two-candidates");

      const needsSelection = claimSvc.issueClaimMagicLink("prov-two-candidates");
      assertEq(needsSelection, { ok: false, error: "selection_required" }, "j1: issueClaimMagicLink on a 2-candidate provider with no selection -> selection_required (AC2's server-side half)");

      const badSelection = claimSvc.issueClaimMagicLink("prov-two-candidates", undefined, { selectedSource: "brreg_contact" });
      assertEq(badSelection, { ok: false, error: "invalid_selection" }, "j2: a selectedSource that is not one of THIS provider's own re-derived candidates -> invalid_selection, never a silent fallback guess (AC5)");

      const chosenDomain = claimSvc.issueClaimMagicLink("prov-two-candidates", undefined, { selectedSource: "verified_domain_address" });
      assertTrue(chosenDomain.ok === true, "j3: a selectedSource matching a real candidate -> succeeds");
      if (chosenDomain.ok) {
        assertEq(chosenDomain.claim.email, "post@toadresser.no", "j4: issued claim targets the SELECTED candidate's address");
        assertEq(chosenDomain.claim.source, "verified_domain_address", "j5: claim.source matches the selection");
      }

      const chosenEpost = claimSvc.issueClaimMagicLink("prov-two-candidates", undefined, { selectedSource: "stored_epost_verified" });
      assertTrue(chosenEpost.ok === true, "j6: selecting the OTHER qualifying candidate for the same provider also succeeds");
      if (chosenEpost.ok) {
        assertEq(chosenEpost.claim.email, "eier@gmail.com", "j7: issued claim targets the second candidate's own address, not the first");
      }

      // AC6: rate limit is per-PROVIDER (isClaimRateLimited keys on
      // provider_id only), shared across different address selections. j3
      // and j6 already spent 2 of the 3-per-window budget on this provider.
      const chosenThird = claimSvc.issueClaimMagicLink("prov-two-candidates", undefined, { selectedSource: "verified_domain_address" });
      assertTrue(chosenThird.ok === true, "j8: 3rd request on this provider (regardless of which candidate) still succeeds (limit is 3)");
      const chosenFourth = claimSvc.issueClaimMagicLink("prov-two-candidates", undefined, { selectedSource: "stored_epost_verified" });
      assertEq(chosenFourth, { ok: false, error: "rate_limited" }, "j9: AC6 — the 4th request is rate-limited even though it picks a DIFFERENT candidate than the 3 before it; the limit is shared, not per-address");

      // ── Rate limiting ──────────────────────────────────────────────────
      claimSvc.issueClaimMagicLink("prov-claimable");
      const third = claimSvc.issueClaimMagicLink("prov-claimable");
      assertTrue(third.ok === true, "b9: 3rd request within the window still succeeds (limit is 3)");
      const fourth = claimSvc.issueClaimMagicLink("prov-claimable");
      assertEq(fourth, { ok: false, error: "rate_limited" }, "b10: 4th request within the window is rate-limited");

      // ── verifyClaimToken + the lock invariant ───────────────────────────
      const invalidVerify = claimSvc.verifyClaimToken("not-a-real-token");
      assertEq(invalidVerify, { valid: false }, "c1: verifyClaimToken with a bogus token -> invalid");

      const goodClaim = issued.ok ? issued.claim : null;
      if (goodClaim) {
        const verify1 = claimSvc.verifyClaimToken(goodClaim.token);
        assertTrue(verify1.valid === true, "c2: verifyClaimToken succeeds for a freshly-issued token");
        assertEq(verify1.providerId, "prov-claimable", "c3: verifyClaimToken resolves the right provider");

        const providerRowAfter = expDb.prepare("SELECT content_source FROM experience_providers WHERE id = ?").get("prov-claimable") as any;
        assertEq(providerRowAfter.content_source, "claim", "c4: content_source is 'claim' immediately after verify (the acceptance-critical write)");

        // Re-verify the SAME token a second time: mirrors RFB's magic_links
        // semantics — a used-but-unexpired token still authenticates
        // (that's what makes the session durable across requests without a
        // fresh link every time). Not a re-issue, just a session check.
        const verify2 = claimSvc.verifyClaimToken(goodClaim.token);
        assertTrue(verify2.valid === true, "c5: an already-used, unexpired token verifies again (session persists across requests)");

        // ── THE LOCK INVARIANT — the real enrichment gate skips this row ──
        const lockedRow = {
          id: "prov-claimable", navn: "Klostergården Håndbryggeri", hjemmeside: "https://klostergarden.no",
          adresse: null, telefon: null, epost: null, lat: null, lon: null,
          about_text: null, products: null, content_source: "claim",
        };
        const rfbSource = {
          agent_id: "agent-x", name: "Klostergården Håndbryggeri", url: "https://klostergarden.no",
          lat: 60.1, lng: 5.3, about: "Ekte beskrivelse fra RFB", address: "Gateveien 1", phone: "12345678",
          email: "post@klostergarden.no", products: JSON.stringify(["Sider"]), verification_review_reason: null,
        };
        const byDomain = enrich.indexRfbByDomain([rfbSource]);
        const enrichResult = enrich.pickEnrichmentFields(lockedRow as any, byDomain);
        assertEq(enrichResult.status, "locked", "c6: gardssalg-rfb-enrich's pickEnrichmentFields returns 'locked' for a content_source='claim' row");
        assertEq(enrichResult.copy, {}, "c7: a locked row's enrichment 'copy' is empty — nothing would be written");
      }

      // content_source='manual' must NOT be downgraded by a claim.
      const manualClaim = claimSvc.issueClaimMagicLink("prov-manual");
      if (manualClaim.ok) {
        claimSvc.verifyClaimToken(manualClaim.claim.token);
        const manualRow = expDb.prepare("SELECT content_source FROM experience_providers WHERE id = ?").get("prov-manual") as any;
        assertEq(manualRow.content_source, "manual", "c8: claiming an already-manual row leaves content_source='manual' (not downgraded to 'claim')");
      } else {
        failed++;
        failures.push("c8: expected prov-manual (Brreg-verified, manual domain) to be claimable — issueClaimMagicLink failed: " + JSON.stringify(manualClaim));
      }

      // Expired token -> invalid.
      const expiredToken = "expired-token-fixture";
      expDb.prepare(
        `INSERT INTO gardssalg_claims (id, provider_id, email, email_source, token, used, created_at, expires_at)
         VALUES ('gsc_expired', 'prov-claimable', 'post@klostergarden.no', 'verified_domain_address', ?, 0, datetime('now','-10 days'), datetime('now','-3 days'))`,
      ).run(expiredToken);
      assertEq(claimSvc.verifyClaimToken(expiredToken), { valid: false }, "c9: an expired token cannot be verified");

      // ── Session verification + revoke ───────────────────────────────────
      if (goodClaim) {
        const session1 = claimSvc.verifyGardssalgOwnerSessionToken(goodClaim.token);
        assertTrue(session1.valid === true, "d1: verifyGardssalgOwnerSessionToken accepts a verified (used=1) token");
        assertEq(session1.providerId, "prov-claimable", "d2: session resolves the right provider");

        const noSession = claimSvc.verifyGardssalgOwnerSessionToken(undefined);
        assertEq(noSession, { valid: false }, "d3: verifyGardssalgOwnerSessionToken(undefined) -> invalid, never throws");

        claimSvc.revokeClaimToken(goodClaim.token);
        const session2 = claimSvc.verifyGardssalgOwnerSessionToken(goodClaim.token);
        assertEq(session2, { valid: false }, "d4: a revoked token no longer authenticates a session (real revoke, not just cookie-clear)");
      }

      // ── updateClaimedProviderProfile ────────────────────────────────────
      const updateMissing = claimSvc.updateClaimedProviderProfile("prov-missing", {});
      assertEq(updateMissing, { ok: false, error: "provider_not_found" }, "e1: updateClaimedProviderProfile on a missing provider -> provider_not_found");

      const update1 = claimSvc.updateClaimedProviderProfile("prov-claimable", {
        about_text: "  En fin gård med lang historie.  ",
        products: ["Eplesider", "eplesider", "  Eplemost  ", ""],
        hjemmeside: "https://klostergarden.no/ny-side",
        booking_live: true,
        opening_hours_text: "Man-Fre 10-16",
      });
      assertTrue("ok" in update1 && update1.ok === true, "e2: updateClaimedProviderProfile succeeds for an unlocked (non-manual) provider");
      if ("ok" in update1 && update1.ok) {
        assertTrue(update1.updatedFields.includes("about_text"), "e3: about_text was updated");
        assertTrue(update1.updatedFields.includes("products"), "e4: products was updated");
        assertTrue(update1.updatedFields.includes("booking_live"), "e5: booking_live was updated");
        assertEq(update1.skippedFields, [], "e6: no fields skipped on a valid, unlocked update");
      }
      const afterUpdate = expDb.prepare("SELECT about_text, products, hjemmeside, booking_live, opening_hours_text, field_provenance FROM experience_providers WHERE id = ?").get("prov-claimable") as any;
      assertEq(afterUpdate.about_text, "En fin gård med lang historie.", "e7: about_text trimmed and persisted");
      assertEq(JSON.parse(afterUpdate.products), ["Eplesider", "Eplemost"], "e8: products de-duped (case-insensitive) and blanks dropped");
      assertEq(afterUpdate.hjemmeside, "https://klostergarden.no/ny-side", "e9: hjemmeside persisted");
      assertEq(afterUpdate.booking_live, 1, "e10: booking_live coerced to 1");

      const auditRows = expDb.prepare("SELECT field_name, changed_by FROM gardssalg_content_audit WHERE provider_id = ? ORDER BY field_name").all("prov-claimable") as any[];
      assertTrue(auditRows.length >= 4, "e11: an audit row was inserted for each updated field");
      assertTrue(auditRows.every((r) => r.changed_by === "owner"), "e12: every audit row is attributed to changed_by='owner'");

      // ── field_provenance.owner_locks stamp (dev-request 2026-07-30-
      // opplevagent-claim-epost-og-perfelt-laas, item 3) ────────────────────
      const provenanceAfterUpdate1 = JSON.parse(afterUpdate.field_provenance);
      const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
      for (const field of ["about_text", "products", "hjemmeside", "booking_live", "opening_hours_text"]) {
        assertTrue(
          !!provenanceAfterUpdate1.owner_locks?.[field]?.locked_at,
          `e19: owner_locks.${field} stamped for a field actually changed`,
        );
        assertTrue(
          ISO_RE.test(provenanceAfterUpdate1.owner_locks?.[field]?.locked_at ?? ""),
          `e20: owner_locks.${field}.locked_at is an ISO-ish timestamp`,
        );
      }
      // (b) a field never included in the update body gets no stamp.
      assertTrue(!("visit_text" in (provenanceAfterUpdate1.owner_locks ?? {})), "e21: a field NOT edited (visit_text) gets no owner_locks stamp");
      // (d) THE most important regression: the pre-seeded field_provenance.
      // hjemmeside key (a totally different shape, written by
      // applyGardssalgProviderWebsite in experience-store.ts) survives
      // completely untouched — merge, not overwrite. Nesting under
      // owner_locks (not a bare top-level `hjemmeside` key) is exactly what
      // avoids this collision.
      assertEq(
        provenanceAfterUpdate1.hjemmeside,
        { source_url: "https://visitnorway.no/listing/klostergarden", fetched_at: "2026-07-01T00:00:00Z" },
        "e22: pre-existing field_provenance.hjemmeside (unrelated shape) survives untouched after an owner edit",
      );

      // Invalid values are skipped, not silently coerced.
      const update2 = claimSvc.updateClaimedProviderProfile("prov-claimable", { hjemmeside: "not-a-url" });
      assertTrue("ok" in update2 && update2.ok === true, "e13: updateClaimedProviderProfile still returns ok:true when a field is rejected");
      if ("ok" in update2 && update2.ok) {
        assertTrue(update2.skippedFields.some((s) => s.field === "hjemmeside" && s.reason === "invalid_value"), "e14: an invalid website value is skipped with reason invalid_value, not written");
      }
      // (c) invalid_value skip -> no NEW stamp is added (owner_locks.hjemmeside
      // keeps its ORIGINAL locked_at from update1, not a fresh one).
      const afterInvalidUpdate = expDb.prepare("SELECT field_provenance FROM experience_providers WHERE id = ?").get("prov-claimable") as any;
      const provenanceAfterInvalid = JSON.parse(afterInvalidUpdate.field_provenance);
      assertEq(
        provenanceAfterInvalid.owner_locks.hjemmeside.locked_at,
        provenanceAfterUpdate1.owner_locks.hjemmeside.locked_at,
        "e23: a field skipped as invalid_value gets no new owner_locks stamp (timestamp unchanged from the earlier successful edit)",
      );

      // Manual-locked provider -> every field skipped, nothing written.
      const update3 = claimSvc.updateClaimedProviderProfile("prov-manual", { about_text: "Forsøk på overskriving" });
      assertTrue("ok" in update3 && update3.ok === true, "e15: updateClaimedProviderProfile on a manual-locked provider still returns ok:true");
      if ("ok" in update3 && update3.ok) {
        assertEq(update3.updatedFields, [], "e16: no fields updated on a manual-locked provider");
        assertTrue(update3.skippedFields.some((s) => s.field === "about_text" && s.reason === "locked_by_manual"), "e17: about_text skipped with reason locked_by_manual");
      }
      const manualRowAfter = expDb.prepare("SELECT about_text, field_provenance FROM experience_providers WHERE id = ?").get("prov-manual") as any;
      assertEq(manualRowAfter.about_text, null, "e18: manual-locked provider's about_text is untouched");
      // (c) locked_by_manual skip -> no field_provenance write at all (the
      // whole SET sets.length>0 gate, which also guards the owner_locks
      // stamp, never fires when every field was skipped).
      assertEq(manualRowAfter.field_provenance, null, "e24: manual-locked provider gets no field_provenance write at all (nothing was actually updated)");

      // (e) malformed pre-existing field_provenance JSON does not crash the
      // write and still results in a valid stamp (same defensive-parse
      // contract as applyGardssalgWebsiteVerification).
      insertProvider.run({
        id: "prov-malformed-provenance", navn: "Uryddig Gård", slug: "uryddig-gard",
        org_nr: "988888888", brreg_verified: 1, hjemmeside: "https://uryddig.no",
        content_source: "provider_site", field_provenance: "{not valid json[[",
      });
      const update4 = claimSvc.updateClaimedProviderProfile("prov-malformed-provenance", { about_text: "Ny tekst" });
      assertTrue("ok" in update4 && update4.ok === true, "e25: updateClaimedProviderProfile does not throw on malformed pre-existing field_provenance JSON");
      const malformedAfter = expDb.prepare("SELECT about_text, field_provenance FROM experience_providers WHERE id = ?").get("prov-malformed-provenance") as any;
      assertEq(malformedAfter.about_text, "Ny tekst", "e26: the actual field write still succeeds despite malformed pre-existing field_provenance");
      const malformedProvenance = JSON.parse(malformedAfter.field_provenance);
      assertTrue(!!malformedProvenance.owner_locks?.about_text?.locked_at, "e27: a valid owner_locks.about_text stamp is produced even though the prior JSON was malformed (treated as empty, not clobbered/thrown)");
    } catch (err: any) {
      failed++;
      failures.push("gardssalg-claim: unexpected error: " + String(err?.stack || err?.message || err));
    } finally {
      if (prevExperiencesDbPath === undefined) delete process.env.EXPERIENCES_DB_PATH;
      else process.env.EXPERIENCES_DB_PATH = prevExperiencesDbPath;
      try {
        const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
        dbFactory.__resetDbFactoryForTesting();
      } catch { /* ignore */ }
      try {
        const claimSvc = require("./gardssalg-claim") as typeof import("./gardssalg-claim");
        claimSvc.__setRfbDbForTesting(null);
      } catch { /* ignore */ }
      try { rfbDb.close(); } catch { /* already closed */ }
    }

    return { passed, failed, failures };
  })();
}

// Standalone runner: `npx tsx src/services/gardssalg-claim.test.ts`
if (require.main === module) {
  console.log("── gardssalg-claim unit tests ──");
  runGardssalgClaimTests({ log: true }).then((r) => {
    console.log(`\ngardssalg-claim: ${r.passed} passed, ${r.failed} failed`);
    if (r.failed > 0) {
      console.log(r.failures.join("\n"));
      process.exit(1);
    }
    process.exit(0);
  });
}
