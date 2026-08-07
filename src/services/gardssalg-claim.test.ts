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
        deriveOrgLinkedEmailCandidates,
        isHjemmesideOwnershipVerified,
        isClaimableDomain,
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

      // (a3) RETIRED 2026-08-06 (dev-request 2026-08-06-aldri-gjett-
      // epostadresse, AC1): a verified hjemmeside with NO stored epost used
      // to be eligible via post@<domain> (tier (b)). Tier (b) is deleted
      // outright, not gated — so this exact shape (content_source='manual',
      // a clean non-generic hjemmeside, brreg_verified=1, NO epost) is now
      // the canonical "nothing qualifies" case: no tier fires at all. THIS
      // is the dedicated regression assertion the dev-request calls for —
      // it fails immediately if tier (b) is ever reintroduced in any form.
      const r3 = deriveOrgLinkedEmail({
        org_nr: "912345678", brreg_verified: 1, hjemmeside: "https://www.klostergarden.no/om-oss",
        content_source: "manual", field_provenance: null,
      });
      assertEq(r3, { eligible: false, reason: "no_org_linked_email" }, "a3: AC1 REGRESSION GUARD — manual content_source + verified hjemmeside + NO stored epost -> no_org_linked_email; tier (b) post@<domain> is retired and must NEVER fire again, regardless of how 'verified' the domain is");
      // Same shape, through the candidates function (what a future
      // reintroduction of tier (b) would actually need to touch) — empty,
      // not a single 'verified_domain_address' entry.
      const r3Candidates = deriveOrgLinkedEmailCandidates({
        org_nr: "912345678", brreg_verified: 1, hjemmeside: "https://www.klostergarden.no/om-oss",
        content_source: "manual", field_provenance: null,
      });
      assertEq(r3Candidates, [], "a3-candidates: AC1 REGRESSION GUARD — same shape via deriveOrgLinkedEmailCandidates() -> zero candidates, never a synthesized post@<domain> entry");

      // (a3b) Same retirement, via the field_provenance.hjemmeside path
      // (the OTHER way hjemmeside used to count as "ownership-verified") —
      // still zero candidates. content_source can be 'provider_site' or
      // even null; only used to matter for isHjemmesideOwnershipVerified(),
      // which nothing in this function calls anymore.
      const r3b = deriveOrgLinkedEmail({
        org_nr: "912345678", brreg_verified: 1, hjemmeside: "https://bringebaerlandet.no",
        content_source: "provider_site",
        field_provenance: JSON.stringify({ hjemmeside: { source_url: "https://visitnorway.no/listing/123", fetched_at: "2026-07-01T00:00:00Z" } }),
      });
      assertEq(r3b, { eligible: false, reason: "no_org_linked_email" }, "a3b: AC1 REGRESSION GUARD — field_provenance.hjemmeside evidence marker + NO stored epost -> no_org_linked_email, tier (b) retired");

      // (a4) No org-linked email at all -> manual fallback, NEVER self-service.
      const r4 = deriveOrgLinkedEmail({
        org_nr: "912345678", brreg_verified: 1, hjemmeside: "https://raw-crawled-guess.no",
        content_source: "provider_site", field_provenance: null,
      });
      assertEq(r4, { eligible: false, reason: "no_org_linked_email" }, "a4: unvetted hjemmeside (no provenance, not manual) -> no_org_linked_email");

      // (a4c-a4i) STALE PURPOSE, STILL-VALID ASSERTIONS, post tier-(b)
      // retirement (2026-08-06): these were originally a generic-domain
      // regression suite for the post@<domain> MINT specifically — proving a
      // Facebook/gmail.com hjemmeside could never become post@facebook.com
      // even when "ownership-verified". Tier (b) no longer exists, so
      // hjemmeside no longer contributes a candidate AT ALL, generic or not
      // — every one of these rows is "no_org_linked_email" for the SAME
      // reason a3/a3b above are (no epost, no brreg contact). Left in place
      // rather than deleted: their expected VALUES are unchanged (still
      // no_org_linked_email, since generic-domain-blocked and tier-b-retired
      // both land on the same outcome for a hjemmeside-only row), and they
      // cost nothing to keep as an extra belt on top of a3/a3b/AC1's
      // dedicated regression test — EXCEPT a4i, which asserted a POSITIVE
      // (eligible) outcome and therefore genuinely breaks; see its own note.
      //
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

      // (a4i) RETIRED-TIER UPDATE: used to prove a genuinely DISTINCT domain
      // ("gmail.com.evil.example" is not a subdomain of gmail.com — it
      // doesn't END with ".gmail.com" — so isClaimableDomain() must not
      // false-positive-block it) was still eligible via post@<domain>. Tier
      // (b) is retired, so there is no mint left to prove isn't wrongly
      // blocked — this row is "no_org_linked_email" now for the same
      // tier-(b)-doesn't-exist reason as a3/a3b, regardless of domain
      // genericness. isClaimableDomain()'s own suffix-vs-prefix distinction
      // is covered DIRECTLY right below (a4j) — now that it's no longer
      // exercised end-to-end through a live claim-derivation path, testing
      // it as a pure function is the only coverage it has left, and it is
      // kept exported specifically for a future found-address tier to reuse
      // (see gardssalg-claim.ts's module doc), so it must not go untested.
      const r4i = deriveOrgLinkedEmail({
        org_nr: "912345678", brreg_verified: 1, hjemmeside: "https://gmail.com.evil.example",
        content_source: "manual", field_provenance: null,
      });
      assertEq(
        r4i,
        { eligible: false, reason: "no_org_linked_email" },
        "a4i: AC1 REGRESSION GUARD — a genuinely distinct, non-generic domain (gmail.com.evil.example) still gets no_org_linked_email; tier (b) is retired regardless of domain genericness",
      );

      // (a4j) isClaimableDomain() direct coverage — same cases a4c-a4i used
      // to exercise end-to-end, tested as a pure function now that this
      // module has no live call site left for it. Kept exported for a
      // plausible future found-address tier (see this file's module doc);
      // this is what keeps that documented behavior from silently rotting.
      assertTrue(isClaimableDomain("klostergarden.no"), "a4j-1: an ordinary, non-generic domain is claimable");
      assertTrue(!isClaimableDomain("facebook.com"), "a4j-2: an exact generic-list match is not claimable");
      assertTrue(!isClaimableDomain("mail.gmail.com"), "a4j-3: a subdomain of a generic host is not claimable");
      assertTrue(!isClaimableDomain("sub.facebook.com"), "a4j-4: ...same for a different generic host");
      assertTrue(!isClaimableDomain("gmail.com."), "a4j-5: a trailing-FQDN-dot generic domain is not claimable (dot must not defeat the Set match)");
      // isClaimableDomain() itself does NOT lowercase — every real call site
      // feeds it an ALREADY-normalized domain (normalizeDomain() upstream,
      // e.g. deriveOrgLinkedEmail's historical tier (b) call before it was
      // retired). A raw mixed-case string is the caller's bug, not this
      // function's — verified here so that contract stays explicit.
      assertTrue(isClaimableDomain("GMAIL.COM"), "a4j-6: isClaimableDomain() does its own matching case-SENSITIVELY — callers are responsible for normalizeDomain()'s lowercasing upstream, same as every real call site already does");
      assertTrue(isClaimableDomain("gmail.com.evil.example"), "a4j-7: a genuinely distinct domain that merely STARTS WITH a generic label is claimable — not a subdomain (doesn't END with '.gmail.com')");
      assertTrue(!isClaimableDomain(""), "a4j-8: an empty domain is not claimable");
      assertTrue(!isClaimableDomain("localhost"), "a4j-9: a bare host with no dot is not claimable");

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

      // (f6) RETIRED-TIER UPDATE: used to prove verified_domain_address won
      // tier priority over stored_epost_verified on a row qualifying for
      // both. Tier (b) is retired, so this exact row (manual + verified
      // hjemmeside + a qualifying stored epost) now qualifies on stored_
      // epost_verified ALONE — there's only one tier left to win.
      const rF6 = deriveOrgLinkedEmail({
        org_nr: "912345678", brreg_verified: 1, hjemmeside: "https://klostergarden.no",
        content_source: "manual", field_provenance: null, epost: "other@klostergarden.no",
      });
      assertEq(rF6, { eligible: true, email: "other@klostergarden.no", source: "stored_epost_verified" }, "f6: AC1 — hjemmeside no longer contributes a candidate; the row's ONLY eligibility is via stored_epost_verified (tier (b) retired)");

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
      const noneCandidates = deriveOrgLinkedEmailCandidates({ org_nr: null, brreg_verified: 0, hjemmeside: null, content_source: null, field_provenance: null });
      assertEq(noneCandidates, [], "i1: not Brreg-verified -> zero candidates (AC7 — never a non-qualifying tier)");

      // Same row as rF6 above — RETIRED-TIER UPDATE: used to prove BOTH
      // verified_domain_address AND stored_epost_verified came back (tier
      // (b) retired -> now only stored_epost_verified can). Kept as its own
      // assertion (rather than deleted as a duplicate of f6) because it
      // exercises the CANDIDATES function specifically — the thing AC1 is
      // actually about — not the single-result wrapper.
      const singleCandidateDespiteHjemmeside = deriveOrgLinkedEmailCandidates({
        org_nr: "912345678", brreg_verified: 1, hjemmeside: "https://klostergarden.no",
        content_source: "manual", field_provenance: null, epost: "other@klostergarden.no",
      });
      assertEq(
        singleCandidateDespiteHjemmeside,
        [{ email: "other@klostergarden.no", source: "stored_epost_verified" }],
        "i2: AC1 REGRESSION GUARD — a verified hjemmeside alongside a qualifying epost yields exactly ONE candidate (stored_epost_verified); hjemmeside never contributes a second, tier (b), entry",
      );

      // The genuine multi-candidate case left standing after tier (b)'s
      // retirement: (a) brreg_contact, supplied explicitly, alongside (c)
      // stored_epost_verified from the row itself. Two tiers, not three —
      // this test used to be "all three tiers qualify" (i3); with only two
      // live tiers left, it's now the top of the range.
      const twoCandidates = deriveOrgLinkedEmailCandidates(
        {
          org_nr: "912345678", brreg_verified: 1, hjemmeside: "https://klostergarden.no",
          content_source: "manual", field_provenance: null, epost: "other@klostergarden.no",
        },
        "post@brreg-kilde.no",
      );
      assertEq(
        twoCandidates,
        [
          { email: "post@brreg-kilde.no", source: "brreg_contact" },
          { email: "other@klostergarden.no", source: "stored_epost_verified" },
        ],
        "i3: a row qualifying on both surviving tiers -> both candidates, in tier order, and never a synthesized verified_domain_address third entry",
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

      // RETIRED-TIER NOTE: the "never post@facebook.com" half of this
      // guard is now trivially true for EVERY hjemmeside (see a3/a3b/a4i) —
      // domain-genericness stopped mattering the moment tier (b) was
      // deleted. Kept as-is (still a correct assertion: the row's epost
      // isn't manual/outreach-delivered either, so it stays at zero
      // candidates) as one more instance of the AC1 invariant.
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

    // ── Found-address harvest — dev-request 2026-08-06-aldri-gjett-
    // epostadresse SLICE 2 (2026-08-07). deriveOrgLinkedEmailCandidatesWithHarvest()
    // is async/fetch-mocked but otherwise pure (no DB) — a self-contained
    // block, same fetchImpl-injection convention as fetch-page.test.ts's own
    // mockResponse() (passed via opts.fetchImpl, never a global fetch swap —
    // see fetch-page.ts's own doc comment on FetchPageOptions.fetchImpl for
    // why a global swap would race this suite's interleaved async blocks). ──
    {
      const { deriveOrgLinkedEmailCandidatesWithHarvest } = require("./gardssalg-claim") as typeof import("./gardssalg-claim");

      /** Build a mock Response with a real byte body (mirrors fetch-page.test.ts's mockResponse). */
      function mockHarvestResponse(html: string, url: string, status = 200): Response {
        const bytes = new TextEncoder().encode(html);
        const headers = new Headers({ "content-type": "text/html; charset=utf-8" });
        return {
          ok: status >= 200 && status < 300,
          status,
          statusText: `S${status}`,
          url,
          headers,
          arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
        } as unknown as Response;
      }

      /** Map of URL -> HTML body. Missing key -> the fetch throws (never a silent 404), so a
       * test only ever "expects" the exact set of requests it declares. */
      function fetchImplFromMap(byUrl: Record<string, string>): typeof fetch {
        return (async (input: unknown) => {
          const url = String(input);
          if (!(url in byUrl)) throw new Error(`mock fetch: unexpected request to ${url}`);
          return mockHarvestResponse(byUrl[url]!, url);
        }) as unknown as typeof fetch;
      }

      /** Like fetchImplFromMap, but each entry can also carry a `finalUrl`
       * that differs from the requested URL (mirrors a real apex->www or
       * renamed-domain redirect, where resp.url != the requested URL) — see
       * fetch-page.ts's `finalUrl = resp.url || fetchUrl`. Missing key ->
       * throws, same convention as fetchImplFromMap. */
      function fetchImplFromMapWithRedirect(
        byUrl: Record<string, { html: string; finalUrl?: string }>,
      ): typeof fetch {
        return (async (input: unknown) => {
          const url = String(input);
          if (!(url in byUrl)) throw new Error(`mock fetch: unexpected request to ${url}`);
          const entry = byUrl[url]!;
          return mockHarvestResponse(entry.html, entry.finalUrl ?? url);
        }) as unknown as typeof fetch;
      }

      const BRREG_OK = { org_nr: "912345678", brreg_verified: 1 as const };

      // (h1) PRECONDITION: isHjemmesideOwnershipVerified() gates the harvest
      // entirely — an UNVERIFIED hjemmeside gets ZERO fetch attempts (not a
      // fetch-then-discard). Proven by a CALL-COUNTING SPY rather than a
      // throwing fetchImpl: fetchPage() (fetch-page.ts) internally wraps its
      // fetch call in try/catch and NEVER rethrows (a thrown error is always
      // converted into a classified `{ok:false, ...}` result), so a throwing
      // fetchImpl would make h1 pass identically whether the precondition is
      // present or removed entirely — it only proves "no throw", not "no
      // call". Counting actual invocations distinguishes the two.
      let noFetchAllowedCalls = 0;
      const noFetchAllowed: typeof fetch = (async () => {
        noFetchAllowedCalls++;
        return mockHarvestResponse("<html><body>should never be reached</body></html>", "https://uverifisert-gard.no");
      }) as unknown as typeof fetch;
      const h1 = await deriveOrgLinkedEmailCandidatesWithHarvest(
        {
          ...BRREG_OK,
          hjemmeside: "https://uverifisert-gard.no",
          content_source: "provider_site", // not 'manual', and no field_provenance.hjemmeside -> NOT verified
          field_provenance: null,
        },
        undefined,
        { fetchImpl: noFetchAllowed },
      );
      assertEq(h1, [], "h1: unverified hjemmeside -> zero harvest candidates");
      assertEq(noFetchAllowedCalls, 0, "h1: unverified hjemmeside -> zero fetch attempts (precondition reused from isHjemmesideOwnershipVerified; a call-counting spy, not a throwing fetchImpl, since fetchPage() never rethrows)");

      // (h2) AC2 priority ordering, all three tiers present simultaneously,
      // PLUS an embedded AC3 rejection (a genuine different-company, non-
      // free-mail domain found on a sub-page must be dropped, not offered).
      // Home page: discoverable links to /kontakt (score 3) and /om-oss
      // (score 2) [see fetch-page.ts's discoverContentLinks PATTERNS], plus
      // a bare freemail address of its own (found_site_other candidate,
      // since the home page itself is never contact/about-classified).
      const h2HomeHtml = `<html><body><h1>Prioritetsgården</h1>
        <p>Kontakt: other@gmail.com</p>
        <a href="/kontakt">Kontakt oss</a>
        <a href="/om-oss">Om oss</a>
        </body></html>`;
      const h2KontaktHtml = `<html><body><h1>Kontakt</h1>
        <p>Skriv til post@prioritetsgard.no eller kontakt@hotmail.com</p>
        </body></html>`;
      const h2OmOssHtml = `<html><body><h1>Om oss</h1>
        <p>Distributør: post@konkurrentbedrift.no</p>
        </body></html>`;
      const h2 = await deriveOrgLinkedEmailCandidatesWithHarvest(
        {
          ...BRREG_OK,
          hjemmeside: "https://prioritetsgard.no",
          content_source: "manual", // ownership-verified
          field_provenance: null,
        },
        undefined,
        {
          fetchImpl: fetchImplFromMap({
            "https://prioritetsgard.no": h2HomeHtml,
            "https://prioritetsgard.no/kontakt": h2KontaktHtml,
            "https://prioritetsgard.no/om-oss": h2OmOssHtml,
          }),
        },
      );
      assertEq(
        h2,
        [
          { email: "post@prioritetsgard.no", source: "found_same_domain" },
          { email: "kontakt@hotmail.com", source: "found_contact_page" },
          { email: "other@gmail.com", source: "found_site_other" },
        ],
        "h2: AC2 priority ordering — found_same_domain (post@prioritetsgard.no, from the /kontakt page but same-domain wins regardless of page) > found_contact_page (kontakt@hotmail.com, freemail found on /kontakt) > found_site_other (other@gmail.com, freemail found on the home page); post@konkurrentbedrift.no (a real different-company, non-free-mail domain found on /om-oss) is dropped outright — AC3, embedded in the same scenario",
      );

      // (h3) AC3, isolated: the ONLY email on the site belongs to a real
      // different company (non-free-mail, not the site's own domain) ->
      // zero candidates, never auto-used, never a fallback guess either.
      const h3 = await deriveOrgLinkedEmailCandidatesWithHarvest(
        {
          ...BRREG_OK,
          hjemmeside: "https://acme-gard.no",
          content_source: "manual",
          field_provenance: null,
        },
        undefined,
        { fetchImpl: fetchImplFromMap({ "https://acme-gard.no": `<html><body>Kontakt: post@totaltannenbedrift.no</body></html>` }) },
      );
      assertEq(h3, [], "h3: AC3 isolated — a different-company, non-free-mail address is never a candidate; the producer falls through to the existing zero-candidate/manual-fallback behavior unchanged");

      // (h4) AC8 direction 1: a found address on a GENERIC_DOMAINS-listed
      // free-mail host (gmail.com is in BOTH GENERIC_DOMAINS and
      // FREE_MAIL_DOMAINS) IS accepted when found — GENERIC_DOMAINS must
      // NOT block a found address.
      const h4 = await deriveOrgLinkedEmailCandidatesWithHarvest(
        {
          ...BRREG_OK,
          hjemmeside: "https://frittstaende-gard.no",
          content_source: "manual",
          field_provenance: null,
        },
        undefined,
        { fetchImpl: fetchImplFromMap({ "https://frittstaende-gard.no": `<html><body>E-post: eier@gmail.com</body></html>` }) },
      );
      assertEq(
        h4,
        [{ email: "eier@gmail.com", source: "found_site_other" }],
        "h4: AC8 direction 1 — a found @gmail.com address (GENERIC_DOMAINS-listed) IS accepted; GENERIC_DOMAINS/isClaimableDomain is never applied to a found address, only isAcceptableHomepageEmail's own-domain-or-freemail logic",
      );

      // (h5) AC8 direction 2: a domain that is NOT in GENERIC_DOMAINS at all
      // (proving GENERIC_DOMAINS and the found-address gate are doing
      // GENUINELY DIFFERENT jobs, not overlapping ones) is still rejected
      // when it's a real different-company domain — via isAcceptableHomepageEmail
      // alone, the SAME mechanism h3 already exercises.
      const enrichMod = require("./gardssalg-rfb-enrich") as typeof import("./gardssalg-rfb-enrich");
      assertTrue(
        !enrichMod.GENERIC_DOMAINS.has("totaltannenbedrift.no"),
        "h5-precondition: totaltannenbedrift.no (h3's rejected domain) is confirmed NOT a member of GENERIC_DOMAINS -- so h3's rejection could not possibly be coming from that list",
      );

      // (h6) Regression guard: if NO email appears anywhere in the fetched
      // HTML, the harvest returns zero candidates -- it NEVER synthesizes
      // post@<domain> from the (verified, known) hjemmeside domain alone,
      // even though nothing here would technically stop such a guess.
      const h6 = await deriveOrgLinkedEmailCandidatesWithHarvest(
        {
          ...BRREG_OK,
          hjemmeside: "https://stille-gard.no",
          content_source: "manual",
          field_provenance: null,
        },
        undefined,
        { fetchImpl: fetchImplFromMap({ "https://stille-gard.no": `<html><body><h1>Stille Gård</h1><p>Ingen kontaktinfo her.</p></body></html>` }) },
      );
      assertEq(h6, [], "h6: REGRESSION GUARD — zero emails found anywhere -> zero candidates, never a synthesized post@stille-gard.no");

      // (h7) Fetch failure (site unreachable) -> zero candidates, no throw.
      const h7 = await deriveOrgLinkedEmailCandidatesWithHarvest(
        {
          ...BRREG_OK,
          hjemmeside: "https://nede-gard.no",
          content_source: "manual",
          field_provenance: null,
        },
        undefined,
        { fetchImpl: (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch },
      );
      assertEq(h7, [], "h7: an unreachable hjemmeside -> zero harvest candidates, never throws");

      // (h8) Merge ordering + dedupe: brreg_contact first, found-tiers next,
      // stored_epost_verified LAST — and a harvested address identical to
      // the stored epost is offered only ONCE, under the higher-priority
      // found tier (never duplicated under two source tags).
      const h8 = await deriveOrgLinkedEmailCandidatesWithHarvest(
        {
          ...BRREG_OK,
          hjemmeside: "https://fullrekke-gard.no",
          content_source: "manual",
          field_provenance: null,
          epost: "post@fullrekke-gard.no", // manual -> qualifies as stored_epost_verified, AND happens to equal the harvested same-domain address
        },
        "post@brreg-kilde.no",
        {
          fetchImpl: fetchImplFromMap({
            "https://fullrekke-gard.no": `<html><body>Kontakt: post@fullrekke-gard.no</body></html>`,
          }),
        },
      );
      assertEq(
        h8,
        [
          { email: "post@brreg-kilde.no", source: "brreg_contact" },
          { email: "post@fullrekke-gard.no", source: "found_same_domain" },
        ],
        "h8: merge ordering -- brreg_contact, then found tiers, then stored_epost_verified (last, and here suppressed entirely by the dedupe since it's the SAME address the found_same_domain tier already offered under a higher-priority tag)",
      );

      // (h9) Post-redirect host is used for tier assignment, not the
      // originally-requested hjemmeside — harvestFoundOrgEmails uses
      // `primary.finalUrl || hjemmeside` as siteBase for the found_same_domain
      // comparison (an apex/renamed-domain redirect must not make the site's
      // own address look cross-domain). The requested URL is old-domain.no,
      // but the mocked response's `finalUrl` lands on new-domain.no, and the
      // page's own email is @new-domain.no -> must tag found_same_domain (if
      // the code compared against the requested hjemmeside instead, the
      // domains would mismatch and this would NOT come out found_same_domain).
      const h9 = await deriveOrgLinkedEmailCandidatesWithHarvest(
        {
          ...BRREG_OK,
          hjemmeside: "https://old-domain.no",
          content_source: "manual",
          field_provenance: null,
        },
        undefined,
        {
          fetchImpl: fetchImplFromMapWithRedirect({
            "https://old-domain.no": {
              html: `<html><body>Kontakt: kontakt@new-domain.no</body></html>`,
              finalUrl: "https://new-domain.no",
            },
          }),
        },
      );
      assertEq(
        h9,
        [{ email: "kontakt@new-domain.no", source: "found_same_domain" }],
        "h9: tier assignment uses the POST-REDIRECT host (finalUrl=new-domain.no) not the originally-requested hjemmeside (old-domain.no) -- kontakt@new-domain.no is correctly tagged found_same_domain",
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

      // ── NO REAL NETWORK, EVER (dev-request 2026-08-06-aldri-gjett-
      // epostadresse SLICE 5 / AC7) ────────────────────────────────────────
      // issueClaimMagicLink() is now harvest-backed, so several DB-backed
      // fixtures below (prov-claimable, prov-manual, prov-generic-domain —
      // all Brreg-verified WITH an ownership-verified hjemmeside) would
      // otherwise cause this suite to fetch klostergarden.no, danielsgard.no
      // and facebook.com for real. This module-level override is the seam
      // that stops that; it is installed on the SAME freshly-required module
      // instance __setRfbDbForTesting is installed on two lines up (this
      // suite deletes gardssalg-claim from require.cache above), so it cannot
      // leak into a concurrently-running unrelated suite — the same isolation
      // argument that override's own doc comment makes.
      //
      // Returns a real 200 page with NO email addresses on it, so every
      // harvest attempt legitimately yields zero found candidates and every
      // pre-existing assertion in this suite keeps its pre-SLICE-5 answer.
      // A COUNTER, not a throwing stub: fetchPage() never rethrows (see the
      // h1 test's own doc comment), so only counting can prove "this fixture
      // did / did not attempt a fetch".
      let suiteFetchCalls: string[] = [];
      const emptyPageFetchImpl = ((async (input: unknown) => {
        const url = String(input);
        suiteFetchCalls.push(url);
        const bytes = new TextEncoder().encode("<html><body><h1>Ingen kontaktinfo</h1></body></html>");
        return {
          ok: true,
          status: 200,
          statusText: "S200",
          url,
          headers: new Headers({ "content-type": "text/html; charset=utf-8" }),
          arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
        } as unknown as Response;
      }) as unknown) as typeof fetch;
      claimSvc.__setClaimHarvestFetchForTesting(emptyPageFetchImpl);
      claimSvc.__resetClaimHarvestCacheForTesting();

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

      // A claimable provider. RETIRED-TIER UPDATE: used to be eligible ONLY
      // via a field_provenance-verified hjemmeside (tier (b)), deliberately
      // WITHOUT content_source='manual' — the whole POINT of that shape was
      // to reach a claimable-but-still-EDITABLE row, since updateClaimed-
      // ProviderProfile() locks every field the instant content_source is
      // 'manual' (see e2-e27 further below, which edit THIS SAME provider
      // post-claim and require it to still be unlocked). Tier (b) is gone,
      // so hjemmeside/field_provenance no longer produce anything — but
      // content_source='manual' is NOT the right replacement here (that's
      // prov-manual's job, a few fixtures down, which deliberately IS
      // locked). Instead this fixture now qualifies via stored_epost_
      // verified's OTHER sub-case, (b-epost) delivered-outreach-no-bounce
      // (setEpost + the outreach_sent_log row seeded below, alongside the
      // other (b-epost) fixtures) — content_source stays 'provider_site',
      // so the row is claimable AND still editable, exactly like before.
      // hjemmeside + its field_provenance stamp are left in place (harmless,
      // unused by claim-eligibility now) since c6/c7's lock-invariant check
      // below still keys off this SAME domain via gardssalg-rfb-enrich's
      // indexRfbByDomain(), which is unrelated to claim tiers.
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
      // RETIRED-TIER UPDATE: used to qualify via tier (b) (manual + verified
      // hjemmeside, no epost needed) — now needs its OWN stored epost
      // (setEpost call below) to qualify via stored_epost_verified instead.
      insertProvider.run({
        id: "prov-manual", navn: "Daniels Gård", slug: "daniels-gard",
        org_nr: "911111111", brreg_verified: 1, hjemmeside: "https://danielsgard.no",
        content_source: "manual", field_provenance: null,
      });
      // Originally a SECURITY regression fixture: content_source='manual'
      // (so isHjemmesideOwnershipVerified is true) but hjemmeside is a
      // generic/shared domain (Facebook page entered as the producer's
      // "hjemmeside") — proved the tier (b) mint never fired for a generic
      // domain even when "verified". RETIRED-TIER UPDATE: tier (b) is gone,
      // so this row is ineligible for the SAME reason prov-noemail is (no
      // epost, no brreg contact) — domain-genericness no longer has any
      // effect on the outcome either way. Left as its own fixture (rather
      // than merged into prov-noemail) purely so the assertion below (b2b)
      // still names what it's guarding against.
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
      // RETIRED-TIER UPDATE (see prov-claimable/prov-manual's own comments
      // above): both now need a stored epost to remain claimable at all,
      // since tier (b) no longer exists to carry them — prov-claimable via
      // (b-epost) delivered-outreach (its own outreach_sent_log row is
      // seeded below, alongside the other (b-epost) fixtures), prov-manual
      // via (c-epost) since it's already content_source='manual'. Using the
      // SAME literal address deriveOrgLinkedEmail() used to derive from
      // their domain keeps every downstream assertion that checks the exact
      // email string (b4, c8, etc.) unchanged.
      setEpost.run("post@klostergarden.no", "prov-claimable");
      setEpost.run("post@danielsgard.no", "prov-manual");

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
      // prov-claimable's own (b-epost) row — see its fixture comment above
      // for why it goes through delivered-outreach rather than
      // content_source='manual' (the e2-e27 editable-portal tests below
      // need this row to stay UNLOCKED after claiming).
      rfbDb.prepare(`
        INSERT INTO outreach_sent_log (agent_id, recipient_email, sent_at, channel, vertical_id)
        VALUES ('agent-fixture-osl', 'post@klostergarden.no', datetime('now', '-2 days'), 'email', 'experiences')
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
      const notFound = await claimSvc.issueClaimMagicLink("prov-missing");
      assertEq(notFound, { ok: false, error: "provider_not_found" }, "b1: issueClaimMagicLink on a missing provider -> provider_not_found");

      const noEmail = await claimSvc.issueClaimMagicLink("prov-noemail");
      assertEq(noEmail, { ok: false, error: "no_org_linked_email" }, "b2: issueClaimMagicLink with no org-linked email -> no_org_linked_email (no self-service)");

      // SECURITY: a 'manual' provider whose hjemmeside is a generic/shared
      // domain (Facebook page, no real site) must never issue a claim link —
      // that would derive post@facebook.com as the "verified" target.
      const genericDomain = await claimSvc.issueClaimMagicLink("prov-generic-domain");
      assertEq(genericDomain, { ok: false, error: "no_org_linked_email" }, "b2b: issueClaimMagicLink on a manual provider with a generic-domain hjemmeside (facebook.com) -> no_org_linked_email, never a viable claim-email");

      const issued = await claimSvc.issueClaimMagicLink("prov-claimable");
      assertTrue(issued.ok === true, "b3: issueClaimMagicLink succeeds for the claimable provider");
      if (issued.ok) {
        assertEq(issued.claim.email, "post@klostergarden.no", "b4: issued claim targets the provider's stored epost (tier (c) — see prov-claimable's own fixture comment for the tier (b) retirement)");
        assertEq(issued.claim.maskedEmail, claimSvc.maskEmail("post@klostergarden.no"), "b5: issued claim carries the masked email");
        const row = expDb.prepare("SELECT provider_id, email, used FROM gardssalg_claims WHERE token = ?").get(issued.claim.token) as any;
        assertTrue(!!row, "b6: a gardssalg_claims row was inserted for the issued token");
        assertEq(row.provider_id, "prov-claimable", "b7: inserted row references the right provider");
        assertEq(row.used, 0, "b8: freshly-issued token is not yet used");
      }

      // ── stored_epost_verified — full issueClaimMagicLink integration ────

      // (c-epost) positive: content_source='manual', no verified hjemmeside —
      // only the stored epost tier can produce this claim.
      const issuedManualEpost = await claimSvc.issueClaimMagicLink("prov-epost-manual");
      assertTrue(issuedManualEpost.ok === true, "h1: issueClaimMagicLink succeeds for a manual provider via its stored epost");
      if (issuedManualEpost.ok) {
        assertEq(issuedManualEpost.claim.email, "post@epostmanual.no", "h2: issued claim targets the provider's OWN stored epost, unchanged");
        assertEq(issuedManualEpost.claim.source, "stored_epost_verified", "h3: claim.source is stored_epost_verified");
        const row = expDb.prepare("SELECT email_source FROM gardssalg_claims WHERE token = ?").get(issuedManualEpost.claim.token) as any;
        assertEq(row.email_source, "stored_epost_verified", "h4: the persisted gardssalg_claims row also carries email_source='stored_epost_verified'");
      }

      // (b-epost) positive: harvested content_source, but the address was
      // real, delivered, non-bounced Opplevagent outreach.
      const issuedOutreachEpost = await claimSvc.issueClaimMagicLink("prov-epost-outreach");
      assertTrue(issuedOutreachEpost.ok === true, "h5: issueClaimMagicLink succeeds for a harvested-content_source provider whose epost received delivered, non-bounced outreach");
      if (issuedOutreachEpost.ok) {
        assertEq(issuedOutreachEpost.claim.email, "utsendt@epostoutreach.no", "h6: issued claim targets the outreach-delivered address");
        assertEq(issuedOutreachEpost.claim.source, "stored_epost_verified", "h7: claim.source is stored_epost_verified");
      }

      // Negative: same shape, but the address bounced -> no self-service.
      const bouncedEpost = await claimSvc.issueClaimMagicLink("prov-epost-bounced");
      assertEq(bouncedEpost, { ok: false, error: "no_org_linked_email" }, "h8: a bounced outreach address never becomes a claim target, even though a send WAS logged");

      // Negative: outreach_sent_log row exists but is stamped vertical_id='rfb'.
      const wrongVerticalEpost = await claimSvc.issueClaimMagicLink("prov-epost-wrong-vertical");
      assertEq(wrongVerticalEpost, { ok: false, error: "no_org_linked_email" }, "h9: an RFB-vertical outreach_sent_log row does not qualify an Opplevagent claim");

      // ACCEPTANCE CRITERION 2, full call chain: purely scraped epost, no
      // provenance at all -> manual fallback, never self-service.
      const scrapedOnlyEpost = await claimSvc.issueClaimMagicLink("prov-epost-scraped-only");
      assertEq(scrapedOnlyEpost, { ok: false, error: "no_org_linked_email" }, "h10: Acceptance Criterion 2 — a purely scraped epost (no provenance) stays on the manual fallback end to end");

      // ── Producer address selection — dev-request 2026-08-06-claim-
      // produsent-velger-mottakeradresse. RETIRED-TIER UPDATE: this used to
      // be a realistic two-candidate row via a vetted own domain
      // (verified_domain_address) AND a manually-entered Gmail
      // (stored_epost_verified) — the exact "small producer with only a
      // Gmail" case the dev-request itself cites. Tier (b) is retired, so
      // that specific realistic pairing no longer exists; the only way left
      // to reach a genuine 2-candidate row is (a) brreg_contact — supplied
      // explicitly, as issueClaimMagicLink's own second argument, exactly
      // like the dormant-path pure tests (rF7 etc.) already do — alongside
      // (c) stored_epost_verified from the row. Less realistic as a
      // real-world scenario (brreg_contact has no live source yet — see
      // gardssalg-claim.ts's module doc), but the SELECTION MACHINERY this
      // block actually tests (multiple candidates -> selection_required;
      // an explicit choice re-validated against the provider's OWN current
      // candidates, never trusted as-is) doesn't care which two tiers
      // qualify, only that more than one does.
      const PROV_TWO_CANDIDATES_BRREG_CONTACT = "eier@toadresser.no";
      insertProvider.run({
        id: "prov-two-candidates", navn: "To Adresser Gård", slug: "to-adresser-gard",
        org_nr: "990000001", brreg_verified: 1, hjemmeside: null,
        content_source: "manual", field_provenance: null,
      });
      setEpost.run("eier@gmail.com", "prov-two-candidates");

      const needsSelection = await claimSvc.issueClaimMagicLink("prov-two-candidates", PROV_TWO_CANDIDATES_BRREG_CONTACT);
      assertEq(needsSelection, { ok: false, error: "selection_required" }, "j1: issueClaimMagicLink on a 2-candidate provider with no selection -> selection_required (AC2's server-side half)");

      // AC1 REGRESSION GUARD: explicitly asking for the RETIRED tier by
      // name is still just an invalid selection, never a silent guess and
      // never a crash — proves selectedSource validation doesn't special-
      // case the old tier tag, it simply isn't in this provider's (or any
      // provider's) candidate list anymore.
      const badSelection = await claimSvc.issueClaimMagicLink(
        "prov-two-candidates", PROV_TWO_CANDIDATES_BRREG_CONTACT, { selectedSource: "verified_domain_address" },
      );
      assertEq(badSelection, { ok: false, error: "invalid_selection" }, "j2: AC1/AC5 — selecting the RETIRED verified_domain_address tier by name -> invalid_selection, never a silent fallback guess");

      const chosenBrreg = await claimSvc.issueClaimMagicLink(
        "prov-two-candidates", PROV_TWO_CANDIDATES_BRREG_CONTACT, { selectedSource: "brreg_contact" },
      );
      assertTrue(chosenBrreg.ok === true, "j3: a selectedSource matching a real candidate -> succeeds");
      if (chosenBrreg.ok) {
        assertEq(chosenBrreg.claim.email, PROV_TWO_CANDIDATES_BRREG_CONTACT, "j4: issued claim targets the SELECTED candidate's address");
        assertEq(chosenBrreg.claim.source, "brreg_contact", "j5: claim.source matches the selection");
      }

      const chosenEpost = await claimSvc.issueClaimMagicLink(
        "prov-two-candidates", PROV_TWO_CANDIDATES_BRREG_CONTACT, { selectedSource: "stored_epost_verified" },
      );
      assertTrue(chosenEpost.ok === true, "j6: selecting the OTHER qualifying candidate for the same provider also succeeds");
      if (chosenEpost.ok) {
        assertEq(chosenEpost.claim.email, "eier@gmail.com", "j7: issued claim targets the second candidate's own address, not the first");
      }

      // AC6: rate limit is per-PROVIDER (isClaimRateLimited keys on
      // provider_id only), shared across different address selections. j3
      // and j6 already spent 2 of the 3-per-window budget on this provider.
      const chosenThird = await claimSvc.issueClaimMagicLink(
        "prov-two-candidates", PROV_TWO_CANDIDATES_BRREG_CONTACT, { selectedSource: "brreg_contact" },
      );
      assertTrue(chosenThird.ok === true, "j8: 3rd request on this provider (regardless of which candidate) still succeeds (limit is 3)");
      const chosenFourth = await claimSvc.issueClaimMagicLink(
        "prov-two-candidates", PROV_TWO_CANDIDATES_BRREG_CONTACT, { selectedSource: "stored_epost_verified" },
      );
      assertEq(chosenFourth, { ok: false, error: "rate_limited" }, "j9: AC6 — the 4th request is rate-limited even though it picks a DIFFERENT candidate than the 3 before it; the limit is shared, not per-address");

      // ── Rate limiting ──────────────────────────────────────────────────
      await claimSvc.issueClaimMagicLink("prov-claimable");
      const third = await claimSvc.issueClaimMagicLink("prov-claimable");
      assertTrue(third.ok === true, "b9: 3rd request within the window still succeeds (limit is 3)");
      const fourth = await claimSvc.issueClaimMagicLink("prov-claimable");
      assertEq(fourth, { ok: false, error: "rate_limited" }, "b10: 4th request within the window is rate-limited");

      // ── isClaimRateLimited: rolling-hour window, not UTC-calendar-day
      // (dev-request 2026-08-06-claim-rate-limit-datetime-bug) ─────────────
      // created_at is written as an ISO-8601 string with milliseconds/Z
      // (new Date().toISOString() — see issueClaimMagicLink above). The old
      // read query compared that raw TEXT directly against
      // datetime('now', '-1 hours') (SQLite's own space-separated, no-ms/Z
      // format) — a plain string comparison whose date PREFIX matched for
      // any same-UTC-day row, so every claim from today counted as "within
      // the last hour" regardless of actual time. Fixed by wrapping
      // created_at in datetime() too, so both sides go through SQLite's own
      // normalization. These tests use raw INSERTs with EXPLICIT created_at
      // offsets (independent of wall-clock timing) in the SAME ISO format
      // issueClaimMagicLink actually writes, so they also cover AC2 (old
      // ISO-format rows, no migration needed) — b11/b12 below FAIL against
      // the pre-fix code and PASS after the fix.
      insertProvider.run({
        id: "prov-ratelimit-window", navn: "Rate Limit Vindu Gård", slug: "rate-limit-vindu-gard",
        org_nr: "990000002", brreg_verified: 1, hjemmeside: "https://ratevindu.no",
        content_source: "manual", field_provenance: null,
      });
      const insertClaimAt = expDb.prepare(
        `INSERT INTO gardssalg_claims (id, provider_id, email, email_source, token, used, created_at, expires_at)
         VALUES (?, 'prov-ratelimit-window', 'post@ratevindu.no', 'verified_domain_address', ?, 0, ?, datetime('now','+7 days'))`,
      );

      // b11 (AC1 + AC2 regression): three claims from 2 hours ago, stored in
      // the legacy ISO-with-milliseconds-and-Z format — outside the 1-hour
      // window, so none of them should count. Pre-fix, the raw string
      // comparison counted all three as "within the last hour" (same UTC
      // calendar day) -> isClaimRateLimited() incorrectly returned true.
      for (let i = 0; i < 3; i++) {
        insertClaimAt.run(
          `gsc_rl_old_${i}`, `tok-rl-old-${i}`,
          new Date(Date.now() - 2 * 60 * 60 * 1000 - i * 1000).toISOString(),
        );
      }
      assertTrue(
        claimSvc.isClaimRateLimited("prov-ratelimit-window") === false,
        "b11: AC1/AC2 — three ISO-format claims from 2 hours ago do NOT count against the 1-hour window (fails pre-fix: same-UTC-day string compare counted them)",
      );

      // b12 (AC1 + AC3): add three MORE claims from inside the real rolling
      // window (10m/5m/1m ago) — now count-within-window is 3 (the b11
      // claims correctly still excluded) -> hits the unchanged 3-per-window
      // threshold. Confirms recent claims DO count and the limit itself
      // (still 3 per 1h) is unaffected by the comparison fix.
      insertClaimAt.run("gsc_rl_recent_1", "tok-rl-recent-1", new Date(Date.now() - 10 * 60 * 1000).toISOString());
      assertTrue(
        claimSvc.isClaimRateLimited("prov-ratelimit-window") === false,
        "b12a: one recent (10m-ago) claim alone is under the 3-per-window threshold",
      );
      insertClaimAt.run("gsc_rl_recent_2", "tok-rl-recent-2", new Date(Date.now() - 5 * 60 * 1000).toISOString());
      insertClaimAt.run("gsc_rl_recent_3", "tok-rl-recent-3", new Date(Date.now() - 1 * 60 * 1000).toISOString());
      assertTrue(
        claimSvc.isClaimRateLimited("prov-ratelimit-window") === true,
        "b12b: AC1/AC3 — three claims inside the rolling 1-hour window DO count and hit the 3-per-window limit, even though the three 2h-old same-day claims (b11) correctly do not",
      );

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

        // ── THE (NARROWED) LOCK INVARIANT — sub-slice 3k (dev-request
        // 2026-07-30-opplevagent-claim-epost-og-perfelt-laas): a
        // content_source='claim' row is NO LONGER a row-level bail in
        // gardssalg-rfb-enrich's pickEnrichmentFields. With NO
        // field_provenance.owner_locks entries, the owner-lock-eligible
        // fields it can write (about_text, products — hjemmeside is already
        // set on this fixture, so not fillable either way) get filled from a
        // real, non-junk RFB candidate. Fields outside
        // GARDSSALG_OWNER_LOCK_ELIGIBLE_FIELDS (adresse/telefon/epost/
        // lat/lon) still never fill for a claim row (isGardssalgFieldOwnerLocked
        // fails closed on them) — unchanged from before this sub-slice.
        const lockedRow = {
          id: "prov-claimable", navn: "Klostergården Håndbryggeri", hjemmeside: "https://klostergarden.no",
          adresse: null, telefon: null, epost: null, lat: null, lon: null,
          about_text: null, products: null, content_source: "claim", field_provenance: null,
        };
        const rfbSource = {
          agent_id: "agent-x", name: "Klostergården Håndbryggeri", url: "https://klostergarden.no",
          lat: 60.1, lng: 5.3, about: "Ekte beskrivelse fra RFB", address: "Gateveien 1", phone: "12345678",
          email: "post@klostergarden.no", products: JSON.stringify(["Sider"]), verification_review_reason: null,
        };
        const byDomain = enrich.indexRfbByDomain([rfbSource]);
        const enrichResult = enrich.pickEnrichmentFields(lockedRow as any, byDomain);
        assertEq(enrichResult.status, "would_enrich", "c6: gardssalg-rfb-enrich's pickEnrichmentFields no longer fully locks a content_source='claim' row (sub-slice 3k)");
        assertEq(enrichResult.copy, { about_text: "Ekte beskrivelse fra RFB", products: JSON.stringify(["Sider"]) },
          "c7: a claim row with no owner_locks fills its owner-lock-eligible fields (about_text/products); non-eligible fields (adresse/telefon/epost/lat/lon) still stay unfilled");
      }

      // content_source='manual' must NOT be downgraded by a claim.
      const manualClaim = await claimSvc.issueClaimMagicLink("prov-manual");
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

      // ── found_umbrella_member — dev-request 2026-08-06-aldri-gjett-
      // epostadresse SLICE 4, AC5 (2026-08-07). Needs BOTH the fetchImpl-
      // injection convention (same as the h1-h9 harvest block above) AND the
      // RFB-DB fixture (agents/agent_affiliations) already live in this
      // scope (rfbDb, wired in via claimSvc.__setRfbDbForTesting above) — so
      // this block lives down here rather than in the earlier DB-free
      // harvest block. ──
      {
        function mockUmbrellaResponse(html: string, url: string, status = 200): Response {
          const bytes = new TextEncoder().encode(html);
          const headers = new Headers({ "content-type": "text/html; charset=utf-8" });
          return {
            ok: status >= 200 && status < 300,
            status,
            statusText: `S${status}`,
            url,
            headers,
            arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
          } as unknown as Response;
        }
        /** Same "missing key -> throws" discipline as the h1-h9 block's own
         * fetchImplFromMap — a test only ever "expects" exactly the requests
         * it declares. */
        function umbrellaFetchImplFromMap(byUrl: Record<string, string>): typeof fetch {
          return (async (input: unknown) => {
            const url = String(input);
            if (!(url in byUrl)) throw new Error(`mock fetch: unexpected request to ${url}`);
            return mockUmbrellaResponse(byUrl[url]!, url);
          }) as unknown as typeof fetch;
        }
        /** Records every URL requested (never throws on an unexpected one) —
         * used where the point of the assertion IS "was this URL ever
         * requested at all", same call-counting-spy rationale h1's own
         * doc comment gives for why a throwing stub can't prove "zero
         * calls" (fetchPage() never rethrows). */
        function recordingFetchImpl(byUrl: Record<string, string>, calls: string[]): typeof fetch {
          return (async (input: unknown) => {
            const url = String(input);
            calls.push(url);
            if (!(url in byUrl)) return mockUmbrellaResponse("<html><body>unmapped</body></html>", url, 404);
            return mockUmbrellaResponse(byUrl[url]!, url);
          }) as unknown as typeof fetch;
        }

        const insertAgent = rfbDb.prepare(
          `INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, org_nr, umbrella_type)
           VALUES (?, ?, 'test agent', 'test', 'x@example.no', ?, 'producer', ?, ?, ?)`,
        );
        const insertAffiliation = rfbDb.prepare(
          `INSERT INTO agent_affiliations (producer_id, umbrella_id, status, source) VALUES (?, ?, ?, 'admin')`,
        );

        // (u1) THE AC5 ANTI-LEAK TEST NAMED IN THE SPEC ITSELF: the umbrella
        // page's ONLY email is the umbrella's OWN contact address — and, the
        // hardest version of this, it sits RIGHT NEXT TO the producer's own
        // name (so a name-proximity check ALONE, without the hard domain
        // exclusion, would wrongly accept it). Must still return null: the
        // umbrella's own address can never leak in as the producer's, no
        // matter how close the name match is.
        insertAgent.run("agent-u1-producer", "Solgården", "https://solgarden-ukjent.no", "key-u1-p", "912340001", null);
        insertAgent.run("agent-u1-umbrella", "Paraplyen U1", "https://paraplyen-u1.no", "key-u1-u", null, "cooperative");
        insertAffiliation.run("agent-u1-producer", "agent-u1-umbrella", "active");
        const u1Html = `<html><body><h1>Våre medlemmer</h1>
          <p>Solgården er medlem hos oss. Kontakt oss på post@paraplyen-u1.no for spørsmål.</p>
          </body></html>`;
        const u1 = await claimSvc.harvestUmbrellaMemberEmail(
          { navn: "Solgården", org_nr: "912340001" },
          { fetchImpl: umbrellaFetchImplFromMap({ "https://paraplyen-u1.no": u1Html }) },
        );
        assertEq(u1, null, "u1: AC5 ANTI-LEAK — the umbrella's own address (post@paraplyen-u1.no, same domain as the umbrella's own hjemmeside) is dropped by the hard exclusion even though it sits directly next to the producer's own name — never offered as the producer's address");

        // (u2) Positive case: two members, each with their own name + email,
        // separated by enough filler text that neither's card falls inside
        // the OTHER's name-proximity window. Target producer's own address
        // must be returned; the other member's address must never be.
        insertAgent.run("agent-u2-producer", "Bjørkelund Gård", "https://ukjent.no", "key-u2-p", "912340002", null);
        insertAgent.run("agent-u2-other-producer", "Fjellro Gård", "https://ukjent2.no", "key-u2-op", "912340012", null);
        insertAgent.run("agent-u2-umbrella", "Paraplyen U2", "https://paraplyen-u2.no", "key-u2-u", null, "cooperative");
        insertAffiliation.run("agent-u2-producer", "agent-u2-umbrella", "active");
        insertAffiliation.run("agent-u2-other-producer", "agent-u2-umbrella", "active");
        const u2Filler = "Fyll ".repeat(120); // ~600 chars — well over the 250-char proximity window
        const u2Html = `<html><body><h1>Våre medlemmer</h1>
          <div class="member"><h3>Bjørkelund Gård</h3><p>Kontakt: kari@gmail.com</p></div>
          <p>${u2Filler}</p>
          <div class="member"><h3>Fjellro Gård</h3><p>Kontakt: ola@hotmail.com</p></div>
          </body></html>`;
        const u2FetchImpl = umbrellaFetchImplFromMap({ "https://paraplyen-u2.no": u2Html });
        const u2Target = await claimSvc.harvestUmbrellaMemberEmail({ navn: "Bjørkelund Gård", org_nr: "912340002" }, { fetchImpl: u2FetchImpl });
        assertEq(u2Target, { email: "kari@gmail.com", source: "found_umbrella_member" }, "u2: positive case — Bjørkelund Gård is correctly attributed kari@gmail.com (its own nearby card), not ola@hotmail.com (the other member's, too far away to qualify)");
        const u2Other = await claimSvc.harvestUmbrellaMemberEmail({ navn: "Fjellro Gård", org_nr: "912340012" }, { fetchImpl: u2FetchImpl });
        assertEq(u2Other, { email: "ola@hotmail.com", source: "found_umbrella_member" }, "u2b: symmetric check — Fjellro Gård is correctly attributed ola@hotmail.com, not kari@gmail.com (the FIRST member's own scenario doesn't accidentally win by being scanned first)");

        // (u3) agent_affiliations.status != 'active' -> no candidate, AND
        // zero fetch attempts (findUmbrellaAffiliation must reject this
        // BEFORE any fetch, same "no attempt, not attempt-then-discard"
        // discipline this file uses everywhere else).
        insertAgent.run("agent-u3-producer", "Pending Gård", "https://ukjent3.no", "key-u3-p", "912340003", null);
        insertAgent.run("agent-u3-umbrella", "Paraplyen U3", "https://paraplyen-u3.no", "key-u3-u", null, "cooperative");
        insertAffiliation.run("agent-u3-producer", "agent-u3-umbrella", "pending_confirmation");
        const u3Calls: string[] = [];
        const u3 = await claimSvc.harvestUmbrellaMemberEmail(
          { navn: "Pending Gård", org_nr: "912340003" },
          { fetchImpl: recordingFetchImpl({}, u3Calls) },
        );
        assertEq(u3, null, "u3: a pending_confirmation (not active) affiliation -> no candidate, the tier is not triggered at all");
        assertEq(u3Calls, [], "u3b: ...and zero fetch attempts were made — the affiliation check itself rejects this case before any network call");

        // (u3c) Zero affiliations at all for an otherwise-real producer
        // agent -> same null / zero-fetch outcome.
        insertAgent.run("agent-u3c-producer", "Ingen Paraply Gård", "https://ukjent3c.no", "key-u3c-p", "912340013", null);
        const u3cCalls: string[] = [];
        const u3c = await claimSvc.harvestUmbrellaMemberEmail(
          { navn: "Ingen Paraply Gård", org_nr: "912340013" },
          { fetchImpl: recordingFetchImpl({}, u3cCalls) },
        );
        assertEq(u3c, null, "u3c: a producer agent with zero agent_affiliations rows at all -> no candidate");
        assertEq(u3cCalls, [], "u3c-2: ...and zero fetch attempts");

        // (u4) MORE THAN ONE active affiliation for the same producer -> an
        // ambiguous case in its own right (which umbrella's page would even
        // be authoritative?) -> no candidate, never an arbitrary pick of the
        // first one, and zero fetch attempts (same precondition discipline).
        insertAgent.run("agent-u4-producer", "Dobbel Gård", "https://ukjent4.no", "key-u4-p", "912340004", null);
        insertAgent.run("agent-u4-umbrella-a", "Paraplyen U4A", "https://paraplyen-u4a.no", "key-u4-ua", null, "cooperative");
        insertAgent.run("agent-u4-umbrella-b", "Paraplyen U4B", "https://paraplyen-u4b.no", "key-u4-ub", null, "cooperative");
        insertAffiliation.run("agent-u4-producer", "agent-u4-umbrella-a", "active");
        insertAffiliation.run("agent-u4-producer", "agent-u4-umbrella-b", "active");
        const u4Calls: string[] = [];
        const u4 = await claimSvc.harvestUmbrellaMemberEmail(
          { navn: "Dobbel Gård", org_nr: "912340004" },
          { fetchImpl: recordingFetchImpl({}, u4Calls) },
        );
        assertEq(u4, null, "u4: two ACTIVE affiliations for the same producer -> ambiguous, no candidate, never an arbitrary first-pick");
        assertEq(u4Calls, [], "u4b: ...and zero fetch attempts");

        // (u6) Producer's name DOES appear on the umbrella page, but no
        // email is within the proximity window of any occurrence -> no
        // candidate. Proves this never falls back to "well SOME email was
        // on the page" once a name-match exists.
        insertAgent.run("agent-u6-producer", "Fjordblikk Gård", "https://ukjent6.no", "key-u6-p", "912340006", null);
        insertAgent.run("agent-u6-umbrella", "Paraplyen U6", "https://paraplyen-u6.no", "key-u6-u", null, "cooperative");
        insertAffiliation.run("agent-u6-producer", "agent-u6-umbrella", "active");
        const u6Filler = "Fyll ".repeat(120); // ~600 chars, over the 250-char window
        const u6Html = `<html><body><h1>Våre medlemmer</h1>
          <p>Fjordblikk Gård er et av våre medlemmer.</p>
          <p>${u6Filler}</p>
          <p>Generell kontakt for spørsmål om nettsiden: webmaster@et-helt-annet-sted.no</p>
          </body></html>`;
        const u6 = await claimSvc.harvestUmbrellaMemberEmail(
          { navn: "Fjordblikk Gård", org_nr: "912340006" },
          { fetchImpl: umbrellaFetchImplFromMap({ "https://paraplyen-u6.no": u6Html }) },
        );
        assertEq(u6, null, "u6: producer's name appears on the page but no email is within the proximity window of that occurrence -> no candidate, never a guess at 'the only email found'");

        // (u7) Integration: deriveOrgLinkedEmailCandidatesWithHarvest() only
        // attempts this tier when the OWN-site harvest found ZERO candidates
        // — a provider whose own site already produced a found-tier address
        // must never even trigger a fetch to its umbrella's page.
        insertAgent.run("agent-u7-producer", "Eget Nettsted Gård", "https://eget-nettsted-u7.no", "key-u7-p", "912340007", null);
        insertAgent.run("agent-u7-umbrella", "Paraplyen U7", "https://paraplyen-u7.no", "key-u7-u", null, "cooperative");
        insertAffiliation.run("agent-u7-producer", "agent-u7-umbrella", "active");
        const u7Calls: string[] = [];
        const u7OwnSiteHtml = `<html><body>Kontakt: eier@eget-nettsted-u7.no</body></html>`;
        const u7 = await claimSvc.deriveOrgLinkedEmailCandidatesWithHarvest(
          {
            org_nr: "912340007",
            brreg_verified: 1,
            hjemmeside: "https://eget-nettsted-u7.no",
            content_source: "manual", // ownership-verified -> own-site harvest attempted
            field_provenance: null,
            navn: "Eget Nettsted Gård",
          },
          undefined,
          { fetchImpl: recordingFetchImpl({ "https://eget-nettsted-u7.no": u7OwnSiteHtml }, u7Calls) },
        );
        assertEq(u7, [{ email: "eier@eget-nettsted-u7.no", source: "found_same_domain" }], "u7: own-site harvest already found an address -> that's the only candidate");
        assertTrue(!u7Calls.includes("https://paraplyen-u7.no"), "u7b: ...and the umbrella's own page (https://paraplyen-u7.no) was NEVER fetched — the fallback tier is not attempted once the own-site harvest already succeeded");

        // (u8) Integration: deriveOrgLinkedEmailCandidatesWithHarvest() also
        // skips this tier when a stored_epost_verified candidate already
        // qualifies (independently-verified, stronger evidence than a
        // freshly-scraped umbrella-page guess) — even though the own-site
        // harvest itself finds nothing (no hjemmeside at all here).
        insertAgent.run("agent-u8-producer", "Manuell Epost Gård", "https://ukjent8.no", "key-u8-p", "912340008", null);
        insertAgent.run("agent-u8-umbrella", "Paraplyen U8", "https://paraplyen-u8.no", "key-u8-u", null, "cooperative");
        insertAffiliation.run("agent-u8-producer", "agent-u8-umbrella", "active");
        const u8Calls: string[] = [];
        const u8 = await claimSvc.deriveOrgLinkedEmailCandidatesWithHarvest(
          {
            org_nr: "912340008",
            brreg_verified: 1,
            hjemmeside: null,
            content_source: "manual",
            field_provenance: null,
            epost: "post@manuellepost.no", // (c-epost) manual -> qualifies as stored_epost_verified
            navn: "Manuell Epost Gård",
          },
          undefined,
          { fetchImpl: recordingFetchImpl({}, u8Calls) },
        );
        assertEq(u8, [{ email: "post@manuellepost.no", source: "stored_epost_verified" }], "u8: a qualifying stored_epost_verified candidate already exists -> that's the only candidate");
        assertEq(u8Calls, [], "u8b: ...and the umbrella tier made zero fetch attempts (an existing stored/verified address already makes it redundant)");

        // (u9) Full success path through deriveOrgLinkedEmailCandidatesWithHarvest:
        // no hjemmeside, no stored epost, but a valid umbrella affiliation
        // whose member page names this producer -> found_umbrella_member
        // shows up as the (only) candidate.
        insertAgent.run("agent-u9-producer", "Nyoppdaget Gård", "https://ukjent9.no", "key-u9-p", "912340009", null);
        insertAgent.run("agent-u9-umbrella", "Paraplyen U9", "https://paraplyen-u9.no", "key-u9-u", null, "cooperative");
        insertAffiliation.run("agent-u9-producer", "agent-u9-umbrella", "active");
        const u9Html = `<html><body><h1>Medlemmer</h1><p>Nyoppdaget Gård: post@nyoppdaget-gmail-erstatning.no er feil, riktig adresse er eier@gmail.com</p></body></html>`;
        const u9 = await claimSvc.deriveOrgLinkedEmailCandidatesWithHarvest(
          {
            org_nr: "912340009",
            brreg_verified: 1,
            hjemmeside: null,
            content_source: "provider_site",
            field_provenance: null,
            navn: "Nyoppdaget Gård",
          },
          undefined,
          { fetchImpl: umbrellaFetchImplFromMap({ "https://paraplyen-u9.no": u9Html }) },
        );
        assertEq(u9, [{ email: "eier@gmail.com", source: "found_umbrella_member" }], "u9: end-to-end success — no own site, no stored epost, but the umbrella's member page names this producer next to a qualifying (free-mail) address -> found_umbrella_member candidate; the non-free-mail, non-umbrella-domain address on the same line is correctly rejected by the AC3/AC8 accept gate");

        // (u10) REVIEW FIX — unanchored substring matching (2026-08-07
        // fix-up, finding 1): the reviewer's adversarial scenario, restated
        // exactly. Producer "Nordgård" never appears STANDALONE anywhere on
        // its umbrella's page — the only occurrence of the raw substring
        // "nordgård" is as the first part of a DIFFERENT, longer entity's
        // name, "Nordgårds Bakeri AS" (a sponsor, not this producer), which
        // sits right next to an otherwise-qualifying free-mail address. A
        // raw, unanchored substring search (the pre-fix behaviour) finds
        // "nordgård" at index 0 of "nordgårds bakeri as" and — since nothing
        // else disqualifies it — would confidently return the sponsor's
        // address as this producer's own found_umbrella_member candidate:
        // exactly the account-takeover-shaped misattribution the review
        // flagged. The fix anchors the match to real word boundaries: the
        // character immediately after the "nordgård" substring here is "s"
        // (part of "nordgårds"), a word character, so the match is rejected
        // as embedded in a longer word — never even reaching Step 4's
        // proximity check. Must return null, NOT the sponsor's address.
        insertAgent.run("agent-u10-producer", "Nordgård", "https://ukjent10.no", "key-u10-p", "912340010", null);
        insertAgent.run("agent-u10-umbrella", "Paraplyen U10", "https://paraplyen-u10.no", "key-u10-u", null, "cooperative");
        insertAffiliation.run("agent-u10-producer", "agent-u10-umbrella", "active");
        const u10Html = `<html><body><h1>Våre sponsorer</h1>
          <p>Nordgårds Bakeri AS er stolt sponsor av laget. Kontakt: sponsor@gmail.com</p>
          </body></html>`;
        const u10 = await claimSvc.harvestUmbrellaMemberEmail(
          { navn: "Nordgård", org_nr: "912340010" },
          { fetchImpl: umbrellaFetchImplFromMap({ "https://paraplyen-u10.no": u10Html }) },
        );
        assertEq(u10, null, "u10: REGRESSION (review finding 1) — producer 'Nordgård' is a strict prefix of the unrelated 'Nordgårds Bakeri AS' on the page; the substring match is correctly rejected by word-boundary anchoring (the char right after the match, 's', is a word char) so sponsor@gmail.com is NEVER attributed to this producer — must be null, not a wrong-entity guess");

        // (u10b) Sanity check on the SAME page/producer name: when the
        // producer's name genuinely DOES appear standalone (real word
        // boundaries on both sides), the anchored match still fires
        // normally and the tier still works — the fix must not be so
        // strict it breaks genuine matches. (u2/u9 above already cover this
        // for other names; this repeats it specifically for a name that
        // ALSO happens to be a prefix of a longer name elsewhere on a page,
        // to prove the anchoring is precise, not merely "always reject".)
        const u10bHtml = `<html><body><h1>Våre medlemmer</h1>
          <p>Nordgård er medlem hos oss. Kontakt: nordgard@gmail.com</p>
          </body></html>`;
        const u10b = await claimSvc.harvestUmbrellaMemberEmail(
          { navn: "Nordgård", org_nr: "912340010" },
          { fetchImpl: umbrellaFetchImplFromMap({ "https://paraplyen-u10.no": u10bHtml }) },
        );
        assertEq(u10b, { email: "nordgard@gmail.com", source: "found_umbrella_member" }, "u10b: anchoring is precise, not overbroad — 'Nordgård' occurring as a genuine standalone word (real boundaries both sides) still matches and still yields its own qualifying address");

        // (u11) REVIEW FIX — CSS/HTML-hidden content (2026-08-07 fix-up,
        // finding 2), case (a): a `hidden` boolean attribute. The producer's
        // name AND a qualifying email exist ONLY inside a `<div hidden>` —
        // nowhere else on the page. Before the fix, stripToPlainText left
        // this text intact and it would be scanned exactly like visible
        // text, yielding a candidate; after the fix, the whole hidden
        // element (name + email) is dropped before scanning, so the name
        // never even registers -> null.
        insertAgent.run("agent-u11-producer", "Skjult Gård", "https://ukjent11.no", "key-u11-p", "912340011", null);
        insertAgent.run("agent-u11-umbrella", "Paraplyen U11", "https://paraplyen-u11.no", "key-u11-u", null, "cooperative");
        insertAffiliation.run("agent-u11-producer", "agent-u11-umbrella", "active");
        const u11Html = `<html><body><h1>Medlemmer</h1>
          <div hidden><p>Skjult Gård kontakt: skjult@gmail.com</p></div>
          </body></html>`;
        const u11 = await claimSvc.harvestUmbrellaMemberEmail(
          { navn: "Skjult Gård", org_nr: "912340011" },
          { fetchImpl: umbrellaFetchImplFromMap({ "https://paraplyen-u11.no": u11Html }) },
        );
        assertEq(u11, null, "u11: REGRESSION (review finding 2a) — a `<div hidden>` containing the producer's name and a qualifying email is excluded entirely; the name never registers as occurring on the page at all -> null, not skjult@gmail.com");

        // (u12) same review finding, case (b): `style="display:none"`
        // (no whitespace around the colon).
        // (org_nr 912340112, not 912340012 — the latter is already used
        // above by u2's "Fjellro Gård")
        insertAgent.run("agent-u12-producer", "Usynlig Gård", "https://ukjent12.no", "key-u12-p", "912340112", null);
        insertAgent.run("agent-u12-umbrella", "Paraplyen U12", "https://paraplyen-u12.no", "key-u12-u", null, "cooperative");
        insertAffiliation.run("agent-u12-producer", "agent-u12-umbrella", "active");
        const u12Html = `<html><body><h1>Medlemmer</h1>
          <div style="display:none"><p>Usynlig Gård kontakt: usynlig@gmail.com</p></div>
          </body></html>`;
        const u12 = await claimSvc.harvestUmbrellaMemberEmail(
          { navn: "Usynlig Gård", org_nr: "912340112" },
          { fetchImpl: umbrellaFetchImplFromMap({ "https://paraplyen-u12.no": u12Html }) },
        );
        assertEq(u12, null, "u12: REGRESSION (review finding 2b) — `style=\"display:none\"` content is excluded entirely -> null, not usynlig@gmail.com");

        // (u13) same review finding, case (c): the whitespace variant
        // `style="display: none;"` (space after the colon, trailing
        // semicolon) — must be recognized the same as the no-whitespace
        // form in u12, not treated as a different/unmatched value.
        // (org_nr 912340113, not 912340013 — the latter is already used
        // above by u3c's "Ingen Paraply Gård")
        insertAgent.run("agent-u13-producer", "Bortgjemt Gård", "https://ukjent13.no", "key-u13-p", "912340113", null);
        insertAgent.run("agent-u13-umbrella", "Paraplyen U13", "https://paraplyen-u13.no", "key-u13-u", null, "cooperative");
        insertAffiliation.run("agent-u13-producer", "agent-u13-umbrella", "active");
        const u13Html = `<html><body><h1>Medlemmer</h1>
          <div style="display: none;"><p>Bortgjemt Gård kontakt: bortgjemt@gmail.com</p></div>
          </body></html>`;
        const u13 = await claimSvc.harvestUmbrellaMemberEmail(
          { navn: "Bortgjemt Gård", org_nr: "912340113" },
          { fetchImpl: umbrellaFetchImplFromMap({ "https://paraplyen-u13.no": u13Html }) },
        );
        assertEq(u13, null, "u13: REGRESSION (review finding 2c) — the whitespace variant `style=\"display: none;\"` is recognized identically to the tight `display:none` form -> null, not bortgjemt@gmail.com");

        // (u14) same review finding, case (d): genuinely VISIBLE content in
        // a SIBLING element must still be matched normally — proving the
        // hidden-content fix doesn't over-strip. Uses `visibility:hidden`
        // for the hidden sibling (the third form the fix recognizes,
        // alongside `hidden` and `display:none`), so this test also
        // incidentally covers that variant. Same producer name appears in
        // BOTH the hidden sibling (next to a DIFFERENT email that must
        // never be picked) and a visible sibling (next to its own
        // qualifying email, which must be picked) — proving both halves at
        // once: hidden text truly excluded, visible text truly unaffected.
        insertAgent.run("agent-u14-producer", "Synlig Gård", "https://ukjent14.no", "key-u14-p", "912340014", null);
        insertAgent.run("agent-u14-umbrella", "Paraplyen U14", "https://paraplyen-u14.no", "key-u14-u", null, "cooperative");
        insertAffiliation.run("agent-u14-producer", "agent-u14-umbrella", "active");
        const u14Html = `<html><body><h1>Medlemmer</h1>
          <div style="visibility:hidden"><p>Synlig Gård kontakt: skjult-variant@gmail.com</p></div>
          <p>Synlig Gård kontakt: synlig-variant@gmail.com</p>
          </body></html>`;
        const u14 = await claimSvc.harvestUmbrellaMemberEmail(
          { navn: "Synlig Gård", org_nr: "912340014" },
          { fetchImpl: umbrellaFetchImplFromMap({ "https://paraplyen-u14.no": u14Html }) },
        );
        assertEq(u14, { email: "synlig-variant@gmail.com", source: "found_umbrella_member" }, "u14: REGRESSION (review finding 2, `visibility:hidden` variant + no-over-stripping check) — the visibility:hidden sibling's name+email is excluded (skjult-variant@gmail.com never qualifies) while the genuinely visible sibling's own name+email is matched completely normally -> synlig-variant@gmail.com, proving the fix doesn't over-strip visible content");
      }

      // ── SLICE 5 / AC7 live-wiring — dev-request 2026-08-06-aldri-gjett-
      // epostadresse. The whole point of this slice: a producer whose ONLY
      // possible address is one found on their own verified website must now
      // actually be able to claim, end to end through issueClaimMagicLink().
      // Before this slice that producer got no_org_linked_email — which is
      // exactly the 10/87 -> 0/87 coverage collapse the dev-request's live
      // verification measured. ──
      {
        /** Serves one HTML body for every requested URL, and counts requests. */
        function countingPageFetchImpl(html: string, calls: string[]): typeof fetch {
          return ((async (input: unknown) => {
            const url = String(input);
            calls.push(url);
            const bytes = new TextEncoder().encode(html);
            return {
              ok: true, status: 200, statusText: "S200", url,
              headers: new Headers({ "content-type": "text/html; charset=utf-8" }),
              arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
            } as unknown as Response;
          }) as unknown) as typeof fetch;
        }

        // A provider with NO brreg contact, NO stored epost, and no 'manual'
        // content_source — its hjemmeside is ownership-verified purely by the
        // field_provenance.hjemmeside stamp, i.e. the admin-approved-website
        // shape the real cohort is full of. Under slice 1 alone this row is
        // claim-dead; under slice 5 it claims via found_same_domain.
        insertProvider.run({
          id: "prov-w1-found", navn: "Funnet Adresse Gård", slug: "funnet-adresse-gard",
          org_nr: "912350001", brreg_verified: 1, hjemmeside: "https://funnetadresse.no",
          content_source: "provider_site",
          field_provenance: JSON.stringify({ hjemmeside: { source_url: "https://visitnorway.no/listing/funnetadresse", fetched_at: "2026-07-01T00:00:00Z" } }),
        });

        const w1Calls: string[] = [];
        claimSvc.__setClaimHarvestFetchForTesting(
          countingPageFetchImpl(`<html><body><h1>Funnet Adresse Gård</h1><p>E-post: post@funnetadresse.no</p></body></html>`, w1Calls),
        );
        claimSvc.__resetClaimHarvestCacheForTesting();

        const w1 = await claimSvc.issueClaimMagicLink("prov-w1-found");
        assertTrue(w1.ok === true, "w1: SLICE 5 — issueClaimMagicLink now succeeds for a producer whose only address is one FOUND on their own ownership-verified website (before this slice: no_org_linked_email — the 0/87 coverage case)");
        if (w1.ok) {
          assertEq(w1.claim.email, "post@funnetadresse.no", "w2: the issued claim targets the address that was actually present in the fetched HTML");
          assertEq(w1.claim.source, "found_same_domain", "w3: ...tagged found_same_domain, the AC2 priority-1 tier");
          const w3row = expDb.prepare("SELECT email, email_source FROM gardssalg_claims WHERE token = ?").get(w1.claim.token) as any;
          assertEq(w3row?.email_source, "found_same_domain", "w4: ...and persisted on the gardssalg_claims row with that source tag");
        }
        assertTrue(w1Calls.length > 0, "w5: ...and the harvest really did fetch the producer's own site (not a coincidental DB-tier match)");

        // (w6-w7) The harvest cache: a SECOND issue for the same provider
        // inside the TTL must not re-fetch the producer's website, but must
        // still produce the same candidate. This is the unauthenticated-
        // reload protection described on CLAIM_HARVEST_CACHE_TTL_MS.
        const callsBeforeSecond = w1Calls.length;
        const w6 = await claimSvc.issueClaimMagicLink("prov-w1-found");
        assertTrue(w6.ok === true, "w6: a second issue for the same provider still resolves to a candidate");
        assertEq(w1Calls.length, callsBeforeSecond, "w7: ...with ZERO additional outbound fetches — the harvest result came from the in-process TTL cache (the unauthenticated-reload amplification guard)");

        // (w8) ...and the cache is genuinely keyed/clearable, not a
        // permanent memo: after __resetClaimHarvestCacheForTesting() the next
        // call fetches again (this is also what makes the reset in this
        // suite's finally block meaningful rather than decorative).
        claimSvc.__resetClaimHarvestCacheForTesting();
        await claimSvc.issueClaimMagicLink("prov-w1-found");
        assertTrue(w1Calls.length > callsBeforeSecond, "w8: after a cache reset the next issue fetches the site again — the cache is a TTL cache, not a permanent memo");

        // (w9) selectedSource re-validation reaches the found tiers too
        // (dev-request 2026-08-06-claim-produsent-velger-mottakeradresse's
        // machinery, now that a found-tier candidate can exist at all): a
        // producer with BOTH a brreg contact and a found address gets
        // selection_required with no choice, and honours an explicit
        // found-tier choice. Uses its OWN fixture so prov-w1-found's
        // rate-limit budget (3/window, already spent above) is untouched.
        insertProvider.run({
          id: "prov-w9-choice", navn: "Valg Gård", slug: "valg-gard",
          org_nr: "912350002", brreg_verified: 1, hjemmeside: "https://valggard.no",
          content_source: "manual", field_provenance: null,
        });
        const w9Calls: string[] = [];
        claimSvc.__setClaimHarvestFetchForTesting(
          countingPageFetchImpl(`<html><body><p>E-post: post@valggard.no</p></body></html>`, w9Calls),
        );
        claimSvc.__resetClaimHarvestCacheForTesting();

        const w9NoChoice = await claimSvc.issueClaimMagicLink("prov-w9-choice", "brreg@valggard-kilde.no");
        assertEq(w9NoChoice, { ok: false, error: "selection_required" }, "w9: brreg_contact + a found_same_domain address = two candidates -> selection_required, exactly as for any other two-tier pair");
        const w10 = await claimSvc.issueClaimMagicLink("prov-w9-choice", "brreg@valggard-kilde.no", { selectedSource: "found_same_domain" });
        assertTrue(w10.ok === true, "w10: an explicit found-tier selection is re-validated against the harvest-aware candidate list and accepted");
        if (w10.ok) {
          assertEq(w10.claim.email, "post@valggard.no", "w11: ...and steers the link to the FOUND address, not the brreg one");
          assertEq(w10.claim.source, "found_same_domain", "w12: ...with the selected source tag persisted");
        }
        const w13 = await claimSvc.issueClaimMagicLink("prov-w9-choice", "brreg@valggard-kilde.no", { selectedSource: "found_contact_page" });
        assertEq(w13, { ok: false, error: "invalid_selection" }, "w13: naming a found tier this provider does NOT have -> invalid_selection, never a fallback to some other found tier");

        // Restore the suite-wide empty-page override for anything after this
        // block, and leave no cache entries behind.
        claimSvc.__setClaimHarvestFetchForTesting(emptyPageFetchImpl);
        claimSvc.__resetClaimHarvestCacheForTesting();
      }
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
        // SLICE 5 / AC7: drop the fetch override and the harvest cache with
        // the same discipline the RFB-db override is dropped — a leftover
        // override would silently answer some LATER suite's harvest, and a
        // leftover cache entry would silently answer its first call.
        claimSvc.__setClaimHarvestFetchForTesting(undefined);
        claimSvc.__resetClaimHarvestCacheForTesting();
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
