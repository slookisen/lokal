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
    }

    // ── DB-backed tests ──────────────────────────────────────────────────
    const prevExperiencesDbPath = process.env.EXPERIENCES_DB_PATH;
    process.env.EXPERIENCES_DB_PATH = ":memory:";

    const dbFactoryPath = require.resolve("../database/db-factory");
    const claimSvcPath = require.resolve("./gardssalg-claim");
    const enrichPath = require.resolve("./gardssalg-rfb-enrich");
    for (const p of [dbFactoryPath, claimSvcPath, enrichPath]) delete require.cache[p];

    try {
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const expDb = dbFactory.getDb("experiences");

      const claimSvc = require("./gardssalg-claim") as typeof import("./gardssalg-claim");
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

      // ── issueClaimMagicLink ────────────────────────────────────────────
      const notFound = claimSvc.issueClaimMagicLink("prov-missing");
      assertEq(notFound, { ok: false, error: "provider_not_found" }, "b1: issueClaimMagicLink on a missing provider -> provider_not_found");

      const noEmail = claimSvc.issueClaimMagicLink("prov-noemail");
      assertEq(noEmail, { ok: false, error: "no_org_linked_email" }, "b2: issueClaimMagicLink with no org-linked email -> no_org_linked_email (no self-service)");

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
      const afterUpdate = expDb.prepare("SELECT about_text, products, hjemmeside, booking_live, opening_hours_text FROM experience_providers WHERE id = ?").get("prov-claimable") as any;
      assertEq(afterUpdate.about_text, "En fin gård med lang historie.", "e7: about_text trimmed and persisted");
      assertEq(JSON.parse(afterUpdate.products), ["Eplesider", "Eplemost"], "e8: products de-duped (case-insensitive) and blanks dropped");
      assertEq(afterUpdate.hjemmeside, "https://klostergarden.no/ny-side", "e9: hjemmeside persisted");
      assertEq(afterUpdate.booking_live, 1, "e10: booking_live coerced to 1");

      const auditRows = expDb.prepare("SELECT field_name, changed_by FROM gardssalg_content_audit WHERE provider_id = ? ORDER BY field_name").all("prov-claimable") as any[];
      assertTrue(auditRows.length >= 4, "e11: an audit row was inserted for each updated field");
      assertTrue(auditRows.every((r) => r.changed_by === "owner"), "e12: every audit row is attributed to changed_by='owner'");

      // Invalid values are skipped, not silently coerced.
      const update2 = claimSvc.updateClaimedProviderProfile("prov-claimable", { hjemmeside: "not-a-url" });
      assertTrue("ok" in update2 && update2.ok === true, "e13: updateClaimedProviderProfile still returns ok:true when a field is rejected");
      if ("ok" in update2 && update2.ok) {
        assertTrue(update2.skippedFields.some((s) => s.field === "hjemmeside" && s.reason === "invalid_value"), "e14: an invalid website value is skipped with reason invalid_value, not written");
      }

      // Manual-locked provider -> every field skipped, nothing written.
      const update3 = claimSvc.updateClaimedProviderProfile("prov-manual", { about_text: "Forsøk på overskriving" });
      assertTrue("ok" in update3 && update3.ok === true, "e15: updateClaimedProviderProfile on a manual-locked provider still returns ok:true");
      if ("ok" in update3 && update3.ok) {
        assertEq(update3.updatedFields, [], "e16: no fields updated on a manual-locked provider");
        assertTrue(update3.skippedFields.some((s) => s.field === "about_text" && s.reason === "locked_by_manual"), "e17: about_text skipped with reason locked_by_manual");
      }
      const manualRowAfter = expDb.prepare("SELECT about_text FROM experience_providers WHERE id = ?").get("prov-manual") as any;
      assertEq(manualRowAfter.about_text, null, "e18: manual-locked provider's about_text is untouched");
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
