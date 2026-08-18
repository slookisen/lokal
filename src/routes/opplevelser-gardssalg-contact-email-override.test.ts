/**
 * opplevelser-gardssalg-contact-email-override.test.ts — tests for Skive A
 * of dev-request 2026-08-17-kontaktadresse-feilkilde-og-override (slookisen/
 * A2A): persisting a force-approved contact-email domain-mismatch override
 * so it survives daily-prep's address_domain_mismatch re-check, scoped to
 * the exact approved address.
 *
 *   - applyGardssalgSetContactEmail() persisting a
 *     field_provenance.contact_email_domain_override stamp on a genuine
 *     force-bypassed mismatch — covered in
 *     opplevelser-gardssalg-set-contact-email.test.ts (blocks d-override /
 *     d-override-2), NOT re-tested here.
 *   - isGardssalgContactEmailOverrideActive() (src/routes/opplevelser.ts) —
 *     the pure read-side check.
 *   - countActiveGardssalgContactEmailOverrides() (src/routes/opplevelser.ts)
 *     — the catalog-wide count Skive A adds to the daily-prep response.
 *   - GET /admin/gardssalg-outreach-daily-prep respecting an active override
 *     (row becomes a candidate instead of address_domain_mismatch-excluded)
 *     and NOT respecting a lapsed one (epost changed since the stamp was
 *     written -> excluded as usual), plus the new
 *     `active_contact_email_overrides` response field on every branch.
 *
 * Harness copied verbatim from opplevelser-gardssalg-outreach-daily-prep.test.ts
 * (EXPERIENCES_DB_PATH=":memory:", fresh require of db-factory + opplevelser
 * router per run, callRoute() exercising router.handle() directly, RFB db
 * override for the cross-platform cooldown check inside
 * computeGardssalgOutreachSendEligibility).
 *
 * Covers:
 *   (a) isGardssalgContactEmailOverrideActive: active match, mismatched
 *       approved_email (lapsed), no stamp, missing field_provenance,
 *       malformed JSON, malformed stamp shape — all fail closed except the
 *       one genuine match
 *   (b) daily-prep: a row that would otherwise be excluded/
 *       address_domain_mismatch becomes a real candidate once its
 *       field_provenance carries a matching, active override stamp — every
 *       OTHER unverified row (no override) is still excluded (gate not
 *       weakened for anyone else)
 *   (c) daily-prep: a row whose override stamp's approved_email no longer
 *       matches its CURRENT epost (address changed since approval) is
 *       excluded/address_domain_mismatch exactly like an unoverridden row
 *       (AC2 — the override lapses, it does not silently cover the new
 *       address)
 *   (e) isGardssalgContactEmailFlaggedForReview (Skive C, same dev-request):
 *       the sibling review-flag stamp's reader — active match, lapsed after
 *       an epost change, missing/malformed stamp, malformed JSON, blank
 *       epost, and mutual non-confusion with the override stamp
 *   (d) daily-prep response carries `active_contact_email_overrides` — a
 *       catalog-wide count, present and correct on the full-batch response,
 *       and independently correct (counts a provider that isn't even
 *       outreach_ready) on the pool_exhausted early-return branch too
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

const REALISTIC_ABOUT_TEXT =
  "Vi driver et lite gårdsbruk og lager drikke av råvarer fra vår egen gård. " +
  "Produktene selges direkte fra gårdsutsalget til besøkende gjennom hele sesongen.";

function overrideStamp(approvedEmail: string, websiteDomain: string, emailDomain: string): Record<string, unknown> {
  return {
    approved_email: approvedEmail,
    approved_by: "admin",
    approved_at: "2026-08-17T09:00:00.000Z",
    source: "Daniel-godkjent 2026-08-17",
    website_domain: websiteDomain,
    email_domain: emailDomain,
  };
}

function withVerifiedWebsite(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    hjemmeside_verification: { verified: true, classification: "verified", checked_at: "2026-08-01T00:00:00.000Z" },
    ...extra,
  });
}

export function runOpplevelserGardssalgContactEmailOverrideTests(
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
    const prevCooldownDays = process.env.OUTREACH_COOLDOWN_DAYS;
    const testKey = process.env.ADMIN_KEY || "gardssalg-contact-email-override-test-key";
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

      const initMod = require("../database/init") as typeof import("../database/init");
      const Database = require("better-sqlite3") as typeof import("better-sqlite3");
      prevRfbDb = initMod.__peekDbForTesting();
      const rfbDb = new Database(":memory:");
      initMod.__setDbForTesting(rfbDb as any);
      initMod.__initSchemaForTesting(rfbDb as any);

      const opplevelserMod = require("./opplevelser") as typeof import("./opplevelser") & {
        isGardssalgContactEmailOverrideActive: (fieldProvenanceRaw: string | null, currentEmail: string | null) => boolean;
        countActiveGardssalgContactEmailOverrides: (expDb: any) => number;
      };
      const opplevelserRouter = opplevelserMod.default as any;
      const isActive = opplevelserMod.isGardssalgContactEmailOverrideActive;
      const countActive = opplevelserMod.countActiveGardssalgContactEmailOverrides;

      // ══ (a) isGardssalgContactEmailOverrideActive: pure-function coverage ══
      assertTrue(
        isActive(
          JSON.stringify({ contact_email_domain_override: overrideStamp("post@approved.example.org", "site.no", "approved.example.org") }),
          "post@approved.example.org",
        ),
        "a1: matching approved_email -> active",
      );
      assertTrue(
        !isActive(
          JSON.stringify({ contact_email_domain_override: overrideStamp("old@approved.example.org", "site.no", "approved.example.org") }),
          "new@approved.example.org",
        ),
        "a2: approved_email no longer matches current epost -> lapsed, NOT active",
      );
      assertTrue(!isActive(JSON.stringify({}), "post@approved.example.org"), "a3: no stamp at all -> not active");
      assertTrue(!isActive(null, "post@approved.example.org"), "a4: null field_provenance -> not active");
      assertTrue(!isActive(JSON.stringify({ contact_email_domain_override: overrideStamp("post@x.no", "a", "b") }), null), "a5: null currentEmail -> not active");
      assertTrue(!isActive("{not valid json", "post@approved.example.org"), "a6: malformed JSON -> fail closed, not active");
      assertTrue(!isActive(JSON.stringify({ contact_email_domain_override: "not-an-object" }), "post@approved.example.org"), "a7: malformed stamp shape (string, not object) -> not active");
      assertTrue(!isActive(JSON.stringify([1, 2, 3]), "post@approved.example.org"), "a8: top-level array -> not active");
      assertTrue(!isActive(JSON.stringify({ contact_email_domain_override: { approved_by: "admin" } }), "post@approved.example.org"), "a9: stamp present but missing approved_email -> not active");

      // ══ (e) isGardssalgContactEmailFlaggedForReview (Skive C): the SIBLING
      // stamp's reader — same fail-closed / lapse-on-change discipline as
      // (a) above, on field_provenance.contact_email_flagged_review. True
      // means "under review, do not publish": routes/experiences-seo.ts drops
      // both the visible E-post fact row and the JSON-LD `email` for it
      // (AC4). ═══════════════════════════════════════════════════════════════
      const isFlagged = opplevelserMod.isGardssalgContactEmailFlaggedForReview;
      const flagStamp = (flaggedEmail: string) => ({
        flagged_email: flaggedEmail,
        website_domain: "site.no",
        email_domain: "annenbedrift.no",
        reason: "domain_mismatch",
        source: "catalog_audit",
        flagged_at: "2026-08-18T09:00:00.000Z",
      });
      assertTrue(
        isFlagged(JSON.stringify({ contact_email_flagged_review: flagStamp("post@annenbedrift.no") }), "post@annenbedrift.no"),
        "e1: flag matching the row's current epost -> flagged",
      );
      assertTrue(
        !isFlagged(JSON.stringify({ contact_email_flagged_review: flagStamp("gammel@annenbedrift.no") }), "ny@annenbedrift.no"),
        "e2: epost changed since the flag was raised -> lapsed, NOT flagged",
      );
      assertTrue(!isFlagged(JSON.stringify({}), "post@annenbedrift.no"), "e3: no stamp at all -> not flagged");
      assertTrue(!isFlagged(null, "post@annenbedrift.no"), "e4: null field_provenance -> not flagged");
      assertTrue(
        !isFlagged(JSON.stringify({ contact_email_flagged_review: flagStamp("post@annenbedrift.no") }), null),
        "e5: blank epost (write-time-blocked candidate, nothing published) -> not flagged",
      );
      assertTrue(!isFlagged("{not valid json", "post@annenbedrift.no"), "e6: malformed JSON -> fail closed, not flagged");
      assertTrue(
        !isFlagged(JSON.stringify({ contact_email_flagged_review: "not-an-object" }), "post@annenbedrift.no"),
        "e7: malformed stamp shape -> not flagged",
      );
      assertTrue(!isFlagged(JSON.stringify([1, 2, 3]), "post@annenbedrift.no"), "e8: top-level array -> not flagged");
      assertTrue(
        !isFlagged(JSON.stringify({ contact_email_flagged_review: { reason: "domain_mismatch" } }), "post@annenbedrift.no"),
        "e9: stamp present but missing flagged_email -> not flagged",
      );
      // The two stamps are independent: an ACTIVE override must never be read
      // as a review flag, and a review flag must never be read as an override.
      assertTrue(
        !isFlagged(
          JSON.stringify({ contact_email_domain_override: overrideStamp("post@annenbedrift.no", "site.no", "annenbedrift.no") }),
          "post@annenbedrift.no",
        ),
        "e10: an override stamp is never mistaken for a review flag",
      );
      assertTrue(
        !isActive(JSON.stringify({ contact_email_flagged_review: flagStamp("post@annenbedrift.no") }), "post@annenbedrift.no"),
        "e11: a review flag is never mistaken for an active override",
      );

      // ── DB fixtures for (b)/(c)/(d) ──────────────────────────────────────
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

      // prov-override-active: address on a THIRD, unrelated domain (would be
      // "unverified"/address_domain_mismatch on its own — same shape as the
      // sibling suite's prov-d-unverified), but its field_provenance carries
      // an active override stamp for THIS EXACT current epost.
      insertProvider.run({
        id: "prov-override-active", navn: "7 Fjell-liknende Bryggeri", org_nr: "200000001", kommune: "Bergen",
        rfb_seed_source: "rfb-seed", producer_type: "bryggeri",
        epost: "post@override-active-thirdparty.example.org", telefon: null,
        hjemmeside: "https://override-active.example.no",
        about_text: REALISTIC_ABOUT_TEXT, visit_text: null, opening_hours_text: null,
        products: "Øl", content_source: "provider_site",
        booking_live: 0, catalog_hidden: 0, slug: "override-active-gard",
        field_provenance: withVerifiedWebsite({
          contact_email_domain_override: overrideStamp(
            "post@override-active-thirdparty.example.org",
            "override-active.example.no",
            "override-active-thirdparty.example.org",
          ),
        }),
        brreg_verified: 1, antall_ansatte: 8, naeringskode: null,
      });

      // prov-override-lapsed: field_provenance stamp approves an OLD address
      // that is NOT the row's current epost (the address changed after the
      // force-approval, e.g. a later ordinary correction) — the override
      // must NOT cover the new value.
      insertProvider.run({
        id: "prov-override-lapsed", navn: "Svalbard-liknende Bryggeri", org_nr: "200000002", kommune: "Longyearbyen",
        rfb_seed_source: "rfb-seed", producer_type: "bryggeri",
        epost: "post@override-lapsed-newaddress.example.org", telefon: null,
        hjemmeside: "https://override-lapsed.example.no",
        about_text: REALISTIC_ABOUT_TEXT, visit_text: null, opening_hours_text: null,
        products: "Øl", content_source: "provider_site",
        booking_live: 0, catalog_hidden: 0, slug: "override-lapsed-gard",
        field_provenance: withVerifiedWebsite({
          contact_email_domain_override: overrideStamp(
            "post@override-lapsed-OLD-address.example.org",
            "override-lapsed.example.no",
            "override-lapsed-OLD-address.example.org",
          ),
        }),
        brreg_verified: 1, antall_ansatte: 6, naeringskode: null,
      });

      // prov-plain-unverified: no override stamp at all — the ordinary
      // control row proving the gate is unchanged for everyone else.
      insertProvider.run({
        id: "prov-plain-unverified", navn: "Kontroll Uverifisert Gård", org_nr: "200000003", kommune: "Aurland",
        rfb_seed_source: "rfb-seed", producer_type: "sideri",
        epost: "post@plain-unverified-thirdparty.example.org", telefon: null,
        hjemmeside: "https://plain-unverified.example.no",
        about_text: REALISTIC_ABOUT_TEXT, visit_text: null, opening_hours_text: null,
        products: "Most", content_source: "provider_site",
        booking_live: 0, catalog_hidden: 0, slug: "plain-unverified-gard",
        field_provenance: withVerifiedWebsite(),
        brreg_verified: 1, antall_ansatte: 4, naeringskode: null,
      });

      const opRouter = opplevelserRouter;
      const auth = { "x-admin-key": testKey };

      // ══ (b)/(c) daily-prep respects an active override, not a lapsed one ══
      const full = await callRoute(opRouter, { headers: auth });
      assertEq(full.status, 200, "b1: daily-prep -> 200");
      const candByIdFull = new Map((full.body.candidates as any[]).map((c) => [c.provider_id, c]));
      const exclByIdFull = new Map((full.body.excluded as any[]).map((e) => [e.provider_id, e]));

      assertTrue(candByIdFull.has("prov-override-active"), "b2: prov-override-active IS a candidate — the active override let it through");
      assertTrue(!exclByIdFull.has("prov-override-active"), "b3: prov-override-active is NOT excluded");
      assertEq(candByIdFull.get("prov-override-active")?.recipient_email, "post@override-active-thirdparty.example.org", "b4: candidate carries the approved address as recipient_email");

      assertTrue(exclByIdFull.has("prov-override-lapsed"), "c1: prov-override-lapsed IS excluded — its stamp no longer matches the current epost");
      assertEq(exclByIdFull.get("prov-override-lapsed")?.reason, "address_domain_mismatch", "c2: prov-override-lapsed excluded reason is address_domain_mismatch, same as an unoverridden row");
      assertTrue(!candByIdFull.has("prov-override-lapsed"), "c3: prov-override-lapsed is NOT a candidate");

      assertTrue(exclByIdFull.has("prov-plain-unverified"), "b5: the control row (no override at all) is still excluded — gate not weakened for anyone else");
      assertEq(exclByIdFull.get("prov-plain-unverified")?.reason, "address_domain_mismatch", "b6: control row excluded reason is address_domain_mismatch");

      // ══ (d) active_contact_email_overrides — catalog-wide additive count ══
      // Exactly one of the three fixtures (prov-override-active) has a
      // currently-active stamp; prov-override-lapsed's stamp no longer
      // matches its epost, prov-plain-unverified has no stamp at all.
      assertEq(full.body.active_contact_email_overrides, 1, "d1: full-batch response reports exactly 1 active override");
      assertTrue(typeof full.body.pool === "object" && full.body.pool !== null, "d2: existing `pool` field is still present (additive, not replacing anything)");

      // Direct function-level cross-check against the same DB state.
      assertEq(countActive(expDb), 1, "d3: countActiveGardssalgContactEmailOverrides(expDb) independently agrees: 1");

      // ── pool_exhausted branch: the count must still be catalog-wide, i.e.
      // correct even for a provider that ISN'T outreach_ready at all. Clear
      // the three outreach_ready fixtures and add one non-outreach_ready row
      // (no products) that nonetheless carries an active override stamp.
      expDb.prepare(`DELETE FROM experience_providers WHERE id IN ('prov-override-active', 'prov-override-lapsed', 'prov-plain-unverified')`).run();
      insertProvider.run({
        id: "prov-override-not-ready", navn: "Ikke Klar Men Overstyrt Gård", org_nr: "200000004", kommune: "Voss",
        rfb_seed_source: "rfb-seed", producer_type: "sideri",
        epost: "post@not-ready-override.example.org", telefon: null,
        hjemmeside: "https://not-ready-override.example.no",
        about_text: null, visit_text: null, opening_hours_text: null,
        products: null, content_source: "provider_site",
        booking_live: 0, catalog_hidden: 0, slug: null,
        field_provenance: withVerifiedWebsite({
          contact_email_domain_override: overrideStamp(
            "post@not-ready-override.example.org",
            "not-ready-override.example.no",
            "not-ready-override.example.org",
          ),
        }),
        brreg_verified: 0, antall_ansatte: null, naeringskode: null,
      });
      const dry = await callRoute(opRouter, { headers: auth });
      assertEq(dry.status, 200, "d4: pool_exhausted daily-prep -> 200");
      assertEq(dry.body.missing?.reason, "pool_exhausted", "d5: confirms this is the pool_exhausted early-return branch");
      assertEq(dry.body.active_contact_email_overrides, 1, "d6: even on the pool_exhausted branch, the count is catalog-wide — it counts the never-outreach_ready row too");
    } catch (err: any) {
      failed++;
      failures.push("opplevelser-gardssalg-contact-email-override: unexpected error: " + String(err?.stack || err?.message || err));
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

// Standalone runner: npx tsx src/routes/opplevelser-gardssalg-contact-email-override.test.ts
if (require.main === module) {
  runOpplevelserGardssalgContactEmailOverrideTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    process.exit(summary.failed > 0 ? 1 : 0);
  });
}
