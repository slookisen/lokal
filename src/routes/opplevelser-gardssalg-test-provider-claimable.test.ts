/**
 * opplevelser-gardssalg-test-provider-claimable.test.ts — route-level tests
 * for the `claimable: true` opt-in on
 *
 *   POST /api/opplevelser/admin/gardssalg/test-provider
 *
 * added so dev-request 2026-07-21-opplevagent-claim-flyt-drikkeprodusenter's
 * acceptance criterion 6 (claim end-to-end) has a repeatable test subject.
 * Before it, no admin lever could write the fields deriveOrgLinkedEmail()
 * reads — brreg_verified has no write route for experience_providers at all.
 *
 * REWRITTEN 2026-08-06 (dev-request 2026-08-06-aldri-gjett-epostadresse):
 * the `claimable` flag used to make a row claimable via tier (b),
 * post@<verified-domain> — minting `post@${hjemmeside domain}` and stamping
 * a field_provenance.hjemmeside evidence marker. Daniel banned constructing
 * ANY email address from a domain (see gardssalg-claim.ts's module doc for
 * the full policy rationale); tier (b) is deleted outright, not gated, so
 * this flag now goes through the SURVIVING tier (c), stored_epost_verified:
 * it sets content_source='manual' and a stored `epost` — the ONLY two
 * fields tier (c)'s c-epost sub-case needs. hjemmeside/field_provenance are
 * no longer touched by this route AT ALL (there is nothing left for them to
 * prove for claim purposes) — every section below that used to validate the
 * old hjemmeside-derivation machinery (generic-domain 400s, URL-host-match
 * injection guard, field_provenance merge-not-clobber) is either removed
 * (nothing left to protect) or rewritten for the epost-based mechanism.
 *
 * Harness mirrors opplevelser-gardssalg-website-verification.test.ts
 * (EXPERIENCES_DB_PATH=":memory:", fresh require of db-factory +
 * experience-store + the router per run, callRoute() driving router.handle()
 * directly with X-Admin-Key). No fetch mocking is needed: this route performs
 * no network I/O and sends no email.
 *
 * Covers:
 *   (a) 403 without X-Admin-Key
 *   (b) WITHOUT the flag, behaviour is unchanged: none of the claim fields
 *       is written, and the row stays claim-INELIGIBLE. This is the
 *       backwards-compatibility proof for the existing booking E2E caller.
 *   (c) WITH the flag, deriveOrgLinkedEmail() flips to eligible via the
 *       stored_epost_verified path, targeting a safe `.invalid` default
 *       address unless the caller supplies `claimEmail` — checked against
 *       the real service function, not a re-implementation of its rule
 *   (d) content_source IS 'manual' (the opposite of the old tier-(b) design,
 *       which deliberately avoided 'manual' to keep the owner portal
 *       editable) — this is now a real, accepted, documented trade-off:
 *       claiming via this test row leaves the portal read-only, same as any
 *       other content_source='manual' row
 *   (e) idempotent/repeatable: content_source='manual' never flips away on
 *       a real claim (verifyClaimToken never downgrades an existing
 *       'manual' lock), and a stale/foreign content_source is forcibly
 *       reset to 'manual' on any claimable=true re-run
 *   (f) pointing the endpoint at a REAL provider's slug is refused with a
 *       409 and EVERY one of that row's fields is byte-identical afterwards
 *   (g) `claimEmail` validation: a malformed value is a 400, and supplying
 *       it without `claimable: true` is a 400 (not a silent no-op)
 *   (h) that (f)'s guard applies WITHOUT the claimable flag too — the guard
 *       is on the endpoint's "upsert THE ONE test row" contract, not the flag
 *   (i) slug collision while the test row ALSO exists resolves to the real
 *       row, not a UNIQUE-index 500
 *   (m) field_provenance is left COMPLETELY untouched by the claimable
 *       write now (nothing left to merge — a pre-existing arbitrary value
 *       survives byte-for-byte)
 *   (n) the claimable row must not enter the FETCH cohorts (independent of
 *       this route now, since it never writes hjemmeside — see that
 *       section's own comment for why a directly-seeded fixture is used)
 *
 * EXTENDED 2026-08-10 (dev-request 2026-08-10-gardssalg-eier-flyt-e2e-
 * repeterbar-revoke-og-editable-fixtur, item B) for the new
 * `claimableEditable: true` opt-in — sibling to `claimable`, but stamps
 * content_source='claim' instead of 'manual' so the owner portal
 * (updateClaimedProviderProfile / the portal GET route — both gate strictly
 * on content_source === 'manual', confirmed directly against that code)
 * stays EDITABLE once a real claim is verified against the row (unlike
 * `claimable`'s own row, which — per section (d)/(e) above — is
 * PERMANENTLY locked, since verifyClaimToken() never downgrades an existing
 * 'manual' content_source). Covers:
 *   (o) `claimableEditable: true` sets content_source='claim' (not
 *       'manual') and brreg_verified=1, reusing the SAME `claimEmail`/epost
 *       mechanism as `claimable` (default .invalid address unless supplied)
 *   (p) `claimable: true` and `claimableEditable: true` together -> a clean
 *       400, no write at all
 *   (q) the org_nr pin refuses a claimableEditable write against a real
 *       provider's slug, exactly like `claimable` does
 *   (r) the response reports both `claimable` and `claimableEditable`
 *       booleans plus the actual `content_source` value written
 *   (s) SPEC-DOCUMENTED LIMITATION, verified against the real code: a
 *       claimableEditable row (content_source='claim') is NOT self-serve
 *       claim-eligible via deriveOrgLinkedEmail() — tier (c)'s adminEntered
 *       sub-case requires content_source === 'manual' specifically, and
 *       'claim' does not satisfy it. This pins that as an accepted,
 *       documented fact (see the route's own "SPEC DISCREPANCY" comment in
 *       opplevelser.ts) rather than silently assuming the row behaves like
 *       `claimable`'s.
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
    const url = opts.url || "/admin/gardssalg/test-provider";
    const [pathOnly, queryString] = url.split("?");
    const query: Record<string, string> = {};
    if (queryString) {
      for (const [k, v] of new URLSearchParams(queryString)) query[k] = v;
    }
    const req: any = {
      method,
      url,
      originalUrl: url,
      path: pathOnly,
      query,
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

export function runOpplevelserGardssalgTestProviderClaimableTests(
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
    const testKey = "gardssalg-test-provider-claimable-test-key";
    process.env.EXPERIENCES_DB_PATH = ":memory:";
    process.env.ADMIN_KEY = testKey;

    const dbFactoryPath = require.resolve("../database/db-factory");
    const experienceStorePath = require.resolve("../services/experience-store");
    const claimServicePath = require.resolve("../services/gardssalg-claim");
    const opplevelserPath = require.resolve("./opplevelser");
    const cachePaths = [dbFactoryPath, experienceStorePath, claimServicePath, opplevelserPath];
    for (const p of cachePaths) delete require.cache[p];

    try {
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const expDb = dbFactory.getDb("experiences");
      const opplevelserRouter = (require("./opplevelser") as typeof import("./opplevelser")).default as any;
      // The REAL eligibility function, not a re-statement of its rule here —
      // a hand-rolled copy would keep passing if the service's rule changed.
      const claimService = require("../services/gardssalg-claim") as typeof import("../services/gardssalg-claim");

      const auth = { "x-admin-key": testKey };
      // SELECT * on purpose. The original version of this file listed 11
      // columns and asserted on a handful — which is how it passed while the
      // unconditional UPDATE was silently rewriting epost, rfb_seed_source and
      // commission_rate on a real provider's row. An explicit column list can
      // only ever pin the columns whoever wrote it thought to name; the whole
      // row is what the 409 actually promises is untouched.
      const readRow = (id: string) =>
        expDb.prepare(`SELECT * FROM experience_providers WHERE id = ?`).get(id) as any;
      const diffRows = (before: any, after: any): string[] => {
        const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
        const changed: string[] = [];
        for (const k of keys) {
          if (k === "updated_at") continue; // touched by any write, not a content change
          if (JSON.stringify(before?.[k]) !== JSON.stringify(after?.[k])) changed.push(k);
        }
        return changed.sort();
      };

      // ── (a) 403 without X-Admin-Key ─────────────────────────────────────
      const noKey = await callRoute(opplevelserRouter, { body: { email: "daniel@example.com", claimable: true } });
      assertEq(noKey.status, 403, "a1: POST .../test-provider without X-Admin-Key -> 403");

      // ── (b) WITHOUT the flag — unchanged behaviour ───────────────────────
      const plain = await callRoute(opplevelserRouter, {
        headers: auth,
        body: { email: "daniel@example.com" },
      });
      assertEq(plain.status, 200, "b1: plain upsert -> 200");
      assertEq(plain.body.claimable, false, "b2: response reports claimable:false when the flag is absent");
      const plainId = plain.body.provider_id as string;
      const plainRow = readRow(plainId);
      // 0, not null — the column carries a schema DEFAULT 0. Either way it is
      // not 1, which is what the eligibility gate reads (pinned by b9).
      assertEq(plainRow.brreg_verified, 0, "b3: brreg_verified NOT raised to 1 without the flag");
      assertEq(plainRow.content_source, null, "b4: content_source NOT set to 'manual' without the flag");
      assertEq(plainRow.epost, "daniel@example.com", "b5: epost is the general contact address (booking-notify target), NOT a claim-specific one — the claimable branch never ran");
      assertEq(plainRow.catalog_hidden, 1, "b6: the pre-existing test-row fields are still set (catalog_hidden)");
      assertEq(plainRow.booking_live, 1, "b7: ...and booking_live — the booking E2E caller is unaffected");
      assertEq(
        claimService.deriveOrgLinkedEmail(plainRow),
        { eligible: false, reason: "not_brreg_verified" },
        "b8: the row really is claim-INELIGIBLE without the flag — b3/b4 are load-bearing, not decorative",
      );

      // ── (c) WITH the flag — eligible via stored_epost_verified ──────────
      const claimable = await callRoute(opplevelserRouter, {
        headers: auth,
        body: { email: "daniel@example.com", claimable: true },
      });
      assertEq(claimable.status, 200, "c1: claimable upsert -> 200");
      assertEq(claimable.body.claimable, true, "c2: response reports claimable:true");
      assertEq(claimable.body.provider_id, plainId, "c3: idempotent — same row as the plain call, not a duplicate");
      const claimRow = readRow(plainId);
      assertEq(claimRow.brreg_verified, 1, "c4: brreg_verified = 1");
      assertEq(claimRow.content_source, "manual", "c5: content_source = 'manual' (tier (c)'s c-epost sub-case, adminEntered)");
      // Safe-by-default: RFC-6761-reserved `.invalid` — never resolves, so
      // even an unguarded/misrouted magic-link send can't reach a real
      // third party. Same security posture the old hjemmeside default used.
      assertEq(claimRow.epost, "claim-test@test-ikke-book.invalid", "c6: the claim epost defaults to a safe .invalid address, NOT the general `email` field");
      assertEq(
        claimService.deriveOrgLinkedEmail(claimRow),
        { eligible: true, email: "claim-test@test-ikke-book.invalid", source: "stored_epost_verified" },
        "c7: the REAL deriveOrgLinkedEmail() now returns eligible, via stored_epost_verified",
      );
      assertEq(
        claimable.body.claim_epost,
        "claim-test@test-ikke-book.invalid",
        "c8: the response's claim_epost matches what was actually stored (no 'derivation' anymore — it's literal)",
      );

      // A caller-supplied claimEmail is honoured, and independent of the
      // (still-required) general `email` field.
      const customClaimEmail = await callRoute(opplevelserRouter, {
        headers: auth,
        body: { email: "daniel@example.com", claimable: true, claimEmail: "eier@minetestgard.invalid" },
      });
      assertEq(customClaimEmail.status, 200, "c9: caller-supplied claimEmail -> 200");
      assertEq(
        claimService.deriveOrgLinkedEmail(readRow(plainId)),
        { eligible: true, email: "eier@minetestgard.invalid", source: "stored_epost_verified" },
        "c10: the stored/derived address follows the supplied claimEmail, not the default",
      );
      // Put the default back for the sections below.
      await callRoute(opplevelserRouter, { headers: auth, body: { email: "daniel@example.com", claimable: true } });

      // ── (d) content_source IS 'manual' — the accepted trade-off ─────────
      // See this file's own header comment + opplevelser.ts's route doc for
      // the full reasoning: tier (b) used to deliberately AVOID 'manual' to
      // keep the owner portal editable post-claim; tier (c) has no such
      // option (its only DB-lever sub-case, c-epost, IS content_source=
      // 'manual'). d1 below is the explicit, accepted consequence — a claim
      // E2E run via this route now exercises "does the magic link issue and
      // verify", not "is the portal post-claim editable".
      assertEq(readRow(plainId).content_source, "manual", "d1: content_source is 'manual' after a claimable upsert (opposite of the old tier-(b) design, and a real, accepted trade-off — see header comment)");

      // ── (e) idempotent / repeatable ──────────────────────────────────────
      // Unlike tier (b) (which needed an explicit content_source RESET so a
      // completed claim — content_source='claim' — didn't block re-running
      // the E2E), tier (c)'s 'manual' lock NEVER flips to 'claim'
      // (verifyClaimToken() never downgrades an existing 'manual' row — see
      // its own doc comment in gardssalg-claim.ts) — so there is nothing to
      // reset. e1 proves the trivial case (still 'manual' after a normal
      // re-run); e2 proves the claimable branch is UNCONDITIONAL about it —
      // even a stale/foreign content_source value (simulating some other
      // future write path landing on this row) is forcibly overwritten back
      // to 'manual' by any claimable=true call, not merely left alone.
      await callRoute(opplevelserRouter, { headers: auth, body: { email: "daniel@example.com", claimable: true } });
      assertEq(readRow(plainId).content_source, "manual", "e1: content_source is still 'manual' after a repeat claimable run (no drift)");

      expDb.prepare(`UPDATE experience_providers SET content_source = 'provider_site' WHERE id = ?`).run(plainId);
      const rerunAfterForeignState = await callRoute(opplevelserRouter, {
        headers: auth,
        body: { email: "daniel@example.com", claimable: true },
      });
      assertEq(rerunAfterForeignState.status, 200, "e2: re-run against a row with a stale/foreign content_source -> 200");
      assertEq(readRow(plainId).content_source, "manual", "e3: ...and content_source is forcibly reset to 'manual', not left at the foreign value");
      assertEq(
        claimService.deriveOrgLinkedEmail(readRow(plainId)).eligible,
        true,
        "e4: ...and the row is claim-eligible again",
      );

      // ── (f) the org_nr pin protects real providers ──────────────────────
      // The upsert matches `slug = ? OR org_nr = ?`, so a real provider's slug
      // resolves to that real row. Without the pin, this call would hand it a
      // forged 'manual'/brreg_verified stamp AND overwrite its real epost.
      //
      // content_source='manual' is prov-real's OWN legitimate state here
      // (a real Daniel-curated provider) — unlike tier (b)'s field_
      // provenance stamp, 'manual' isn't itself proof of a forged write, so
      // the meaningful non-forgery checks are epost (must stay the real
      // producer's own address, never the fake claim-test one) and
      // brreg_verified (must stay 0, not forced to 1).
      expDb
        .prepare(
          `INSERT INTO experience_providers
             (id, navn, slug, vertical, org_nr, brreg_verified, hjemmeside, epost, content_source, field_provenance,
              producer_type, enrichment_state, verification_status, source, confidence)
           VALUES
             ('prov-real', 'Ekte Bryggeri', 'ekte-bryggeri', 'experiences', '912345678', 0,
              'https://ektebryggeri.example.no', 'ekte@ektebryggeri.no', 'manual', NULL,
              'bryggeri', 'raw', 'verified', 'test-fixture', 'high')`,
        )
        .run();
      const realBefore = readRow("prov-real");
      const hijack = await callRoute(opplevelserRouter, {
        headers: auth,
        body: { email: "daniel@example.com", claimable: true, slug: "ekte-bryggeri" },
      });
      assertEq(hijack.status, 409, "f1: claimable write against a real provider's slug -> 409, refused");
      const realAfter = readRow("prov-real");
      assertEq(realAfter.brreg_verified, realBefore.brreg_verified, "f2: the real row's brreg_verified is untouched (not forced to 1)");
      assertEq(realAfter.epost, "ekte@ektebryggeri.no", "f3: the real row's own epost is untouched — never overwritten with the fake claim-test address");
      assertEq(realAfter.content_source, "manual", "f4: the real row's content_source lock survives (unchanged, not merely 'still happens to be manual')");
      // The 409 says "refused". It has to be true of the WHOLE row, not just the
      // claim fields — the pre-existing unconditional UPDATE runs before the
      // claimable branch and is not pinned to the test org_nr.
      // The whole row, not a column list — see readRow's comment. This is the
      // assertion that would have caught the original defect.
      assertEq(diffRows(realBefore, realAfter), [], "f5: NO column on the real row changed (whole-row diff)");

      // ── (g) claimEmail validation ────────────────────────────────────────
      const badShape = await callRoute(opplevelserRouter, {
        headers: auth,
        body: { email: "daniel@example.com", claimable: true, claimEmail: "not-an-email" },
      });
      assertEq(badShape.status, 400, "g1: a malformed claimEmail is a 400, not a silently non-claimable row");
      assertEq(readRow(plainId).epost, "claim-test@test-ikke-book.invalid", "g2: a rejected call wrote nothing — the row still carries the last good claim epost");

      // claimEmail without the flag is a silent no-op -> now an explicit 400,
      // same "refuse rather than silently discard" convention the old
      // hjemmeside-without-claimable check used.
      const claimEmailNoFlag = await callRoute(opplevelserRouter, {
        headers: auth,
        body: { email: "daniel@example.com", claimEmail: "eier@minetestgard.invalid" },
      });
      assertEq(claimEmailNoFlag.status, 400, "g3: claimEmail without claimable is refused, not silently discarded");
      // Restore the default for the sections below.
      await callRoute(opplevelserRouter, { headers: auth, body: { email: "daniel@example.com", claimable: true } });

      // ── (n) the claimable row must not enter the FETCH cohorts ──────────
      // Both fetch-cohort selectors (selectGardssalgProvidersForContentRefresh
      // / ...ForRetroScan) require hjemmeside IS NOT NULL — a precondition
      // this route's claimable row can NO LONGER EVER satisfy, since the
      // route dropped hjemmeside handling entirely along with tier (b). So
      // this route's own output can't meaningfully exercise the
      // test-gardssalg producer_type exclusion anymore (it's excluded for
      // an unrelated, structural reason — no hjemmeside at all — regardless
      // of whether the exclusion itself still works). To keep REAL coverage
      // of that exclusion, this section seeds its own dedicated fixture
      // directly (same technique opplevelser-gardssalg-website-
      // verification.test.ts's own "prov-test-gardssalg" fixture already
      // uses), independent of what this route produces.
      const store = require("../services/experience-store") as typeof import("../services/experience-store");
      expDb
        .prepare(
          `INSERT INTO experience_providers
             (id, navn, slug, vertical, hjemmeside, content_source,
              producer_type, enrichment_state, verification_status, source, confidence)
           VALUES ('prov-test-gardssalg-cohort', 'TEST — Ikke book', 'test-ikke-book-cohort', 'experiences',
              'https://test-ikke-book.invalid', NULL, 'test-gardssalg', 'raw', 'pending_verify', 'test-fixture', 'medium')`,
        )
        .run();
      const inRefresh = store.selectGardssalgProvidersForContentRefresh(48).some((r: any) => r.id === "prov-test-gardssalg-cohort");
      const inRetro = store.selectGardssalgProvidersForRetroScan(48).some((r: any) => r.id === "prov-test-gardssalg-cohort");
      assertEq(inRefresh, false, "n1: a producer_type='test-gardssalg' row is NOT selected for gardssalg content-refresh, even with a resolving-shaped hjemmeside");
      assertEq(inRetro, false, "n2: ...nor for the retro-scan");
      // Control: a REAL row in the same state IS selected — proves n1/n2 pin
      // the test-gardssalg exclusion, not some unrelated reason both are empty.
      expDb
        .prepare(
          `INSERT INTO experience_providers (id, navn, slug, vertical, hjemmeside, content_source,
              producer_type, enrichment_state, verification_status, source, confidence)
           VALUES ('prov-cohort-ctl', 'Kohortkontroll', 'kohortkontroll', 'experiences',
              'https://kohortkontroll.example.no', NULL, 'bryggeri', 'raw', 'pending_verify', 'test-fixture', 'medium')`,
        )
        .run();
      assertTrue(
        store.selectGardssalgProvidersForContentRefresh(48).some((r: any) => r.id === "prov-cohort-ctl"),
        "n3: control — an otherwise-identical NON-test row IS selected for content-refresh",
      );
      assertTrue(
        store.selectGardssalgProvidersForRetroScan(48).some((r: any) => r.id === "prov-cohort-ctl"),
        "n4: control — ...and for the retro-scan",
      );
      // The route's OWN claimable row also stays out, for the (now
      // structural, hjemmeside-less) reason described above — still worth
      // pinning so a future re-introduction of hjemmeside-writing to this
      // route doesn't silently reopen the cohort-leak this exclusion guards.
      assertEq(
        store.selectGardssalgProvidersForContentRefresh(48).some((r: any) => r.id === plainId),
        false,
        "n5: this route's own claimable test row is NOT selected for content-refresh either (no hjemmeside to fetch)",
      );

      // ── (i) slug collision while the test row ALSO exists ───────────────
      // Both legs of the resolving SELECT now match, but DIFFERENT rows. The
      // slug match must win so the guard can name the real row; picking the
      // test row instead would try to move its slug onto the real one and hit
      // the UNIQUE index as an opaque 500.
      const collide = await callRoute(opplevelserRouter, {
        headers: auth,
        body: { email: "daniel@example.com", claimable: true, slug: "ekte-bryggeri" },
      });
      assertEq(collide.status, 409, "i1: slug collision resolves to the real row -> 409, not a UNIQUE-index 500");
      assertEq(collide.body.provider_id, "prov-real", "i2: ...and the 409 names the real row, so the caller can see what it hit");
      assertEq(diffRows(realBefore, readRow("prov-real")), [], "i3: the real row is untouched (whole-row diff)");
      assertEq(readRow(plainId).slug, "test-ikke-book-slice0", "i4: the test row did not have the real slug moved onto it");

      // ── (m) field_provenance is left COMPLETELY untouched now ───────────
      // Tier (b)'s hjemmeside evidence stamp used to need a careful read-
      // merge-write to avoid clobbering the OTHER writers of this column
      // (applyGardssalgProviderWebsite, the verification sweep). That merge
      // dance is gone along with the stamp itself — the claimable branch no
      // longer touches field_provenance AT ALL, so a pre-existing arbitrary
      // value simply survives, byte-for-byte, with no write path to race
      // against and no malformed-JSON case to defend against either.
      expDb
        .prepare(`UPDATE experience_providers SET field_provenance = ? WHERE id = ?`)
        .run(JSON.stringify({ hjemmeside_verification: { verified: true, classification: "verified" } }), plainId);
      await callRoute(opplevelserRouter, { headers: auth, body: { email: "daniel@example.com", claimable: true } });
      assertEq(
        JSON.parse(readRow(plainId).field_provenance).hjemmeside_verification?.classification,
        "verified",
        "m1: a pre-existing field_provenance value survives the claimable write completely untouched",
      );

      // ── (h) the guard is not conditional on the flag ────────────────────
      const plainHijack = await callRoute(opplevelserRouter, {
        headers: auth,
        body: { email: "daniel@example.com", slug: "ekte-bryggeri" },
      });
      assertEq(plainHijack.status, 409, "h1: a real provider's slug is refused even without claimable");
      assertEq(diffRows(realBefore, readRow("prov-real")), [], "h2: ...and NO column on that row changed either");

      // ── (o) claimableEditable: true — content_source='claim', not
      //     'manual' ─────────────────────────────────────────────────────
      const editable = await callRoute(opplevelserRouter, {
        headers: auth,
        body: { email: "daniel@example.com", claimableEditable: true },
      });
      assertEq(editable.status, 200, "o1: claimableEditable upsert -> 200");
      assertEq(editable.body.provider_id, plainId, "o2: idempotent — same row, not a duplicate");
      const editableRow = readRow(plainId);
      assertEq(editableRow.brreg_verified, 1, "o3: brreg_verified = 1, same as claimable");
      assertEq(editableRow.content_source, "claim", "o4: content_source = 'claim' (NOT 'manual') — this is the whole point of the flag");
      assertEq(editableRow.epost, "claim-test@test-ikke-book.invalid", "o5: claim epost defaults to the same safe .invalid address as claimable");

      // A caller-supplied claimEmail is honoured here too — same mechanism,
      // same column, as claimable's own (c9)/(c10) coverage above.
      const editableCustomEmail = await callRoute(opplevelserRouter, {
        headers: auth,
        body: { email: "daniel@example.com", claimableEditable: true, claimEmail: "eier@editablefixtur.invalid" },
      });
      assertEq(editableCustomEmail.status, 200, "o6: caller-supplied claimEmail with claimableEditable -> 200");
      assertEq(readRow(plainId).epost, "eier@editablefixtur.invalid", "o7: ...and it's what got stored");

      // ── (p) claimable + claimableEditable together -> 400, no write ─────
      const beforeBoth = readRow(plainId);
      const both = await callRoute(opplevelserRouter, {
        headers: auth,
        body: { email: "daniel@example.com", claimable: true, claimableEditable: true },
      });
      assertEq(both.status, 400, "p1: both flags true at once -> 400");
      assertEq(diffRows(beforeBoth, readRow(plainId)), [], "p2: ...and the row is completely untouched (whole-row diff)");

      // ── (r) response reports both booleans + the actual content_source
      //     written ───────────────────────────────────────────────────────
      const editableAgain = await callRoute(opplevelserRouter, {
        headers: auth,
        body: { email: "daniel@example.com", claimableEditable: true },
      });
      assertEq(editableAgain.body.claimable, false, "r1: response reports claimable:false for a claimableEditable call");
      assertEq(editableAgain.body.claimableEditable, true, "r2: ...and claimableEditable:true");
      assertEq(editableAgain.body.content_source, "claim", "r3: ...and content_source:'claim' — the value actually written");

      const plainAgain = await callRoute(opplevelserRouter, { headers: auth, body: { email: "daniel@example.com" } });
      assertEq(plainAgain.body.claimable, false, "r4: a plain (no-flag) call reports claimable:false");
      assertEq(plainAgain.body.claimableEditable, false, "r5: ...and claimableEditable:false");
      assertTrue(!("content_source" in plainAgain.body), "r6: ...and no content_source key at all (claimReady is false)");

      // ── (s) documented limitation: content_source='claim' is NOT
      //     self-serve claim-eligible via the REAL deriveOrgLinkedEmail() ──
      // Re-set to the claimableEditable state (r4/r5 above left the row
      // claim-less) before checking eligibility.
      await callRoute(opplevelserRouter, { headers: auth, body: { email: "daniel@example.com", claimableEditable: true } });
      assertEq(
        claimService.deriveOrgLinkedEmail(readRow(plainId)),
        { eligible: false, reason: "no_org_linked_email" },
        "s1: a claimableEditable row is claim-INELIGIBLE via self-serve deriveOrgLinkedEmail() — tier (c)'s adminEntered requires content_source==='manual', not 'claim' (see this route's own 'SPEC DISCREPANCY' comment in opplevelser.ts). Claiming it repeatably goes through POST /admin/gardssalg-claim-grant instead.",
      );

      // ── (q) the org_nr pin refuses claimableEditable against a real
      //     provider's slug, exactly like claimable does (f1-f5 above) ────
      const realBeforeEditable = readRow("prov-real");
      const hijackEditable = await callRoute(opplevelserRouter, {
        headers: auth,
        body: { email: "daniel@example.com", claimableEditable: true, slug: "ekte-bryggeri" },
      });
      assertEq(hijackEditable.status, 409, "q1: claimableEditable write against a real provider's slug -> 409, refused");
      assertEq(diffRows(realBeforeEditable, readRow("prov-real")), [], "q2: NO column on the real row changed (whole-row diff)");
    } finally {
      if (prevExperiencesDbPath === undefined) delete process.env.EXPERIENCES_DB_PATH;
      else process.env.EXPERIENCES_DB_PATH = prevExperiencesDbPath;
      if (prevAdminKey === undefined) delete process.env.ADMIN_KEY;
      else process.env.ADMIN_KEY = prevAdminKey;
      for (const p of cachePaths) delete require.cache[p];
    }

    if (log) {
      console.log(`\n  ${passed} passed, ${failed} failed`);
      for (const f of failures) console.log("  " + f);
    }
    return { passed, failed, failures };
  })();
}
