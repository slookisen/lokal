/**
 * opplevelser-gardssalg-test-provider-claimable.test.ts — route-level tests
 * for the `claimable: true` opt-in on
 *
 *   POST /api/opplevelser/admin/gardssalg/test-provider
 *
 * added so dev-request 2026-07-21-opplevagent-claim-flyt-drikkeprodusenter's
 * acceptance criterion 6 (claim end-to-end) has a repeatable test subject.
 * Before it, no admin lever could write the fields deriveOrgLinkedEmail()
 * reads — brreg_verified has no write route for experience_providers at all,
 * and PATCH /admin/providers/:id/hjemmeside sets hjemmeside WITHOUT the
 * field_provenance stamp that makes a domain ownership-verified — so a
 * claim E2E could only ever be run by hand-editing production data.
 *
 * Harness mirrors opplevelser-gardssalg-website-verification.test.ts
 * (EXPERIENCES_DB_PATH=":memory:", fresh require of db-factory +
 * experience-store + the router per run, callRoute() driving router.handle()
 * directly with X-Admin-Key). No fetch mocking is needed: this route performs
 * no network I/O and sends no email.
 *
 * Covers:
 *   (a) 403 without X-Admin-Key
 *   (b) WITHOUT the flag, behaviour is unchanged: none of the three claim
 *       fields is written, and the row stays claim-INELIGIBLE. This is the
 *       backwards-compatibility proof for the existing booking E2E caller.
 *   (c) WITH the flag, deriveOrgLinkedEmail() flips to eligible via the
 *       verified_domain_address path, and the derived address is
 *       post@<the domain we set> — checked against the real service function,
 *       not a re-implementation of its rule
 *   (d) content_source is left NULL, NOT 'manual': 'manual' would also
 *       satisfy the ownership check but disables the owner portal's entire
 *       edit form, so a 'manual' test row would verify the magic link and
 *       then present a read-only portal — testing the wrong thing
 *   (e) repeatability: after a completed claim stamps content_source='claim',
 *       re-running the endpoint resets the row to claimable again
 *   (f) pointing the endpoint at a REAL provider's slug is refused with a 409
 *       and EVERY one of that row's fields is byte-identical afterwards. The
 *       whole-row check matters: the refusal has to happen before the first
 *       write, since the pre-existing unconditional UPDATE rewrites navn/
 *       producer_type/catalog_hidden/booking_live on whatever row the
 *       `slug OR org_nr` match resolved. Checking only the claim fields would
 *       pass while the row had in fact been overwritten.
 *   (g) a generic/shared domain (and a bare host) is a 400, never a silently
 *       non-claimable row
 *   (h) that same refusal applies WITHOUT the claimable flag — the guard is on
 *       the endpoint's "upsert THE ONE test row" contract, not on the flag
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
      // not 1, which is what the eligibility gate reads (pinned by b8).
      assertEq(plainRow.brreg_verified, 0, "b3: brreg_verified NOT raised to 1 without the flag");
      assertEq(plainRow.hjemmeside, null, "b4: hjemmeside NOT written without the flag");
      assertEq(plainRow.field_provenance, null, "b5: field_provenance NOT stamped without the flag");
      assertEq(plainRow.catalog_hidden, 1, "b6: the pre-existing test-row fields are still set (catalog_hidden)");
      assertEq(plainRow.booking_live, 1, "b7: ...and booking_live — the booking E2E caller is unaffected");
      assertEq(
        claimService.deriveOrgLinkedEmail(plainRow),
        { eligible: false, reason: "not_brreg_verified" },
        "b8: the row really is claim-INELIGIBLE without the flag — b3-b5 are load-bearing, not decorative",
      );

      // ── (c) WITH the flag — eligible via the verified-domain path ────────
      const claimable = await callRoute(opplevelserRouter, {
        headers: auth,
        body: { email: "daniel@example.com", claimable: true },
      });
      assertEq(claimable.status, 200, "c1: claimable upsert -> 200");
      assertEq(claimable.body.claimable, true, "c2: response reports claimable:true");
      assertEq(claimable.body.provider_id, plainId, "c3: idempotent — same row as the plain call, not a duplicate");
      const claimRow = readRow(plainId);
      assertEq(claimRow.brreg_verified, 1, "c4: brreg_verified = 1");
      assertEq(claimRow.hjemmeside, "https://test-ikke-book.invalid", "c5: default hjemmeside is the RFC-6761 .invalid domain");
      const prov = JSON.parse(claimRow.field_provenance);
      assertEq(
        prov.hjemmeside?.source_url,
        "https://test-ikke-book.invalid",
        "c6: field_provenance.hjemmeside.source_url is stamped — the marker isHjemmesideOwnershipVerified() reads",
      );
      assertEq(
        claimService.deriveOrgLinkedEmail(claimRow),
        { eligible: true, email: "post@test-ikke-book.invalid", source: "verified_domain_address" },
        "c7: the REAL deriveOrgLinkedEmail() now returns eligible, via verified_domain_address",
      );
      assertEq(
        claimable.body.derived_claim_email,
        "post@test-ikke-book.invalid",
        "c8: the response's derived_claim_email matches what the service actually derives",
      );

      // A caller-supplied domain is honoured, and drives the derivation.
      const customDomain = await callRoute(opplevelserRouter, {
        headers: auth,
        body: { email: "daniel@example.com", claimable: true, hjemmeside: "https://minetestgard.invalid" },
      });
      assertEq(customDomain.status, 200, "c9: caller-supplied hjemmeside -> 200");
      assertEq(
        claimService.deriveOrgLinkedEmail(readRow(plainId)),
        { eligible: true, email: "post@minetestgard.invalid", source: "verified_domain_address" },
        "c10: the derived address follows the supplied domain, not the default",
      );
      // Put the default back for the sections below.
      await callRoute(opplevelserRouter, { headers: auth, body: { email: "daniel@example.com", claimable: true } });

      // ── (d) content_source is NULL, not 'manual' ────────────────────────
      // Seed a NON-null value first. Asserting `content_source === null` on a
      // freshly created row is nearly vacuous — createProvider() leaves the
      // column NULL anyway, so the assertion passed even with the reset
      // deleted from the UPDATE. Starting from 'provider_site' makes it pin
      // the RESET, which is the behaviour the comment claims.
      expDb.prepare(`UPDATE experience_providers SET content_source = 'provider_site' WHERE id = ?`).run(plainId);
      await callRoute(opplevelserRouter, { headers: auth, body: { email: "daniel@example.com", claimable: true } });
      assertEq(
        readRow(plainId).content_source,
        null,
        "d1: a pre-existing content_source is RESET to NULL — not left as-is, and not set to 'manual' (which would satisfy ownership but disable the owner portal's edit form)",
      );

      // ── (e) repeatable after a completed claim ──────────────────────────
      // verifyClaimToken() stamps content_source='claim' on a successful
      // claim; simulate that end state and re-run.
      expDb.prepare(`UPDATE experience_providers SET content_source = 'claim' WHERE id = ?`).run(plainId);
      const rerun = await callRoute(opplevelserRouter, {
        headers: auth,
        body: { email: "daniel@example.com", claimable: true },
      });
      assertEq(rerun.status, 200, "e1: re-run against an already-claimed test row -> 200");
      assertEq(readRow(plainId).content_source, null, "e2: content_source reset to NULL — the E2E can be run again");
      assertEq(
        claimService.deriveOrgLinkedEmail(readRow(plainId)).eligible,
        true,
        "e3: ...and the row is claim-eligible again",
      );
      // e3 alone is weak: eligibility comes from the field_provenance path, which
      // holds regardless of content_source, so it stays green even if the reset
      // were dropped. What the reset actually buys is an EDITABLE portal on the
      // second run — a row still stamped 'claim' is not what a fresh E2E starts
      // from. e4 is the assertion that fails if the reset goes away.
      assertEq(readRow(plainId).content_source, null, "e4: ...specifically because content_source is no longer 'claim'");

      // ── (f) the org_nr pin protects real providers ──────────────────────
      // The upsert matches `slug = ? OR org_nr = ?`, so a real provider's slug
      // resolves to that real row. Without the pin, this call would hand it a
      // forged ownership stamp AND clear a genuine content_source lock.
      expDb
        .prepare(
          `INSERT INTO experience_providers
             (id, navn, slug, vertical, org_nr, brreg_verified, hjemmeside, content_source, field_provenance,
              producer_type, enrichment_state, verification_status, source, confidence)
           VALUES
             ('prov-real', 'Ekte Bryggeri', 'ekte-bryggeri', 'experiences', '912345678', 0,
              'https://ektebryggeri.example.no', 'manual', NULL,
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
      assertEq(realAfter.brreg_verified, realBefore.brreg_verified, "f2: the real row's brreg_verified is untouched");
      assertEq(realAfter.field_provenance, null, "f3: no forged ownership stamp on the real row");
      assertEq(realAfter.content_source, "manual", "f4: the real row's content_source lock survives");
      assertEq(realAfter.hjemmeside, realBefore.hjemmeside, "f5: the real row's hjemmeside is untouched");
      // The 409 says "refused". It has to be true of the WHOLE row, not just the
      // claim fields — the pre-existing unconditional UPDATE runs before the
      // claimable branch and is not pinned to the test org_nr.
      // The whole row, not a column list — see readRow's comment. This is the
      // assertion that would have caught the original defect.
      assertEq(diffRows(realBefore, realAfter), [], "f6: NO column on the real row changed (whole-row diff)");

      // ── (g) generic / unusable domains are a 400 ────────────────────────
      const generic = await callRoute(opplevelserRouter, {
        headers: auth,
        body: { email: "daniel@example.com", claimable: true, hjemmeside: "https://facebook.com/mintestgard" },
      });
      assertEq(generic.status, 400, "g1: a generic/shared domain is a 400, not a silently non-claimable row");
      const genericSub = await callRoute(opplevelserRouter, {
        headers: auth,
        body: { email: "daniel@example.com", claimable: true, hjemmeside: "https://sub.facebook.com/x" },
      });
      assertEq(genericSub.status, 400, "g2: ...and so is a subdomain of one — same rule the mint applies");
      const bareHost = await callRoute(opplevelserRouter, {
        headers: auth,
        body: { email: "daniel@example.com", claimable: true, hjemmeside: "http://localhost" },
      });
      assertEq(bareHost.status, 400, "g3: a bare host with no dot is a 400");
      assertEq(
        readRow(plainId).hjemmeside,
        "https://test-ikke-book.invalid",
        "g4: a rejected call wrote nothing — the row still carries the last good domain",
      );

      // ── (k) hjemmeside must be a real URL whose host IS the claim domain ──
      // normalizeDomain() treats any string containing "@" as an email and
      // keeps only what follows it, so without a URL-shape + host-match check
      // the stored website and the minted post@ address can name DIFFERENT
      // domains — and the public claim route sends to the minted one without
      // the test redirect. These are the concrete inputs that exploited it.
      const injection = await callRoute(opplevelserRouter, {
        headers: auth,
        body: { email: "daniel@example.com", claimable: true, hjemmeside: "https://x.no\nBcc: victim@evil.example" },
      });
      assertEq(injection.status, 400, "k1: an '@'-bearing value whose derived domain is an unrelated host -> 400");
      const notAUrl = await callRoute(opplevelserRouter, {
        headers: auth,
        body: { email: "daniel@example.com", claimable: true, hjemmeside: "not a url but has.dot" },
      });
      assertEq(notAUrl.status, 400, "k2: a non-URL with spaces -> 400 (would have minted an address containing spaces)");
      const noScheme = await callRoute(opplevelserRouter, {
        headers: auth,
        body: { email: "daniel@example.com", claimable: true, hjemmeside: "mintestgard.invalid" },
      });
      assertEq(noScheme.status, 400, "k3: a bare domain with no http(s) scheme -> 400");
      const ftp = await callRoute(opplevelserRouter, {
        headers: auth,
        body: { email: "daniel@example.com", claimable: true, hjemmeside: "ftp://mintestgard.invalid" },
      });
      assertEq(ftp.status, 400, "k4: a non-http(s) scheme -> 400");
      assertEq(
        readRow(plainId).hjemmeside,
        "https://test-ikke-book.invalid",
        "k5: none of those wrote anything",
      );
      // www. is stripped by BOTH normalizeDomain and the host check, so it agrees.
      const wwwOk = await callRoute(opplevelserRouter, {
        headers: auth,
        body: { email: "daniel@example.com", claimable: true, hjemmeside: "https://www.mintestgard.invalid/side" },
      });
      assertEq(wwwOk.status, 200, "k6: a www. URL with a path is accepted — host and derived domain agree after stripping");
      assertEq(
        wwwOk.body.derived_claim_email,
        "post@mintestgard.invalid",
        "k7: ...and mints the address from that same host",
      );
      // hjemmeside without the flag is a silent no-op -> now an explicit 400.
      const hjemmesideNoFlag = await callRoute(opplevelserRouter, {
        headers: auth,
        body: { email: "daniel@example.com", hjemmeside: "https://mintestgard.invalid" },
      });
      assertEq(hjemmesideNoFlag.status, 400, "k8: hjemmeside without claimable is refused, not silently discarded");
      // Restore the default for the sections below.
      await callRoute(opplevelserRouter, { headers: auth, body: { email: "daniel@example.com", claimable: true } });

      // ── (n) the claimable row must not enter the FETCH cohorts ──────────
      // Giving the test row a hjemmeside and a NULL content_source is exactly
      // what selectGardssalgProvidersForContentRefresh and
      // ...ForRetroScan select on. Both drive a homepage fetch, and the test
      // row's homepage is deliberately non-resolving — so without the
      // test-gardssalg exclusion the enrichment sweeps would fetch `.invalid`
      // on every run and eventually park the row. Same argument as the
      // website-verification cohort, two more selectors.
      const store = require("../services/experience-store") as typeof import("../services/experience-store");
      const inRefresh = store.selectGardssalgProvidersForContentRefresh(48).some((r: any) => r.id === plainId);
      const inRetro = store.selectGardssalgProvidersForRetroScan(48).some((r: any) => r.id === plainId);
      assertEq(inRefresh, false, "n1: the claimable test row is NOT selected for gardssalg content-refresh");
      assertEq(inRetro, false, "n2: ...nor for the retro-scan");
      // Control: a REAL row in the same state IS selected — proves n1/n2 pin the
      // test-gardssalg exclusion, not some unrelated reason both are empty.
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

      // ── (h2) provenance is MERGED, not clobbered ────────────────────────
      // Both other writers of field_provenance set only their own key. Seed a
      // foreign key on the test row, re-run, and confirm it survives.
      expDb
        .prepare(`UPDATE experience_providers SET field_provenance = ? WHERE id = ?`)
        .run(JSON.stringify({ hjemmeside_verification: { verified: true, classification: "verified" } }), plainId);
      await callRoute(opplevelserRouter, { headers: auth, body: { email: "daniel@example.com", claimable: true } });
      const mergedProv = JSON.parse(readRow(plainId).field_provenance);
      assertEq(
        mergedProv.hjemmeside_verification?.classification,
        "verified",
        "m1: a pre-existing hjemmeside_verification key survives the claimable write",
      );
      assertEq(
        mergedProv.hjemmeside?.source_url,
        "https://test-ikke-book.invalid",
        "m2: ...and the claimable stamp is still written alongside it",
      );
      // Malformed existing JSON must not fail the write (same convention as
      // the two other writers) — it is treated as empty.
      expDb.prepare(`UPDATE experience_providers SET field_provenance = ? WHERE id = ?`).run("{not json", plainId);
      const afterJunk = await callRoute(opplevelserRouter, {
        headers: auth, body: { email: "daniel@example.com", claimable: true },
      });
      assertEq(afterJunk.status, 200, "m3: malformed existing provenance JSON does not fail the write");
      assertEq(
        JSON.parse(readRow(plainId).field_provenance).hjemmeside?.source_url,
        "https://test-ikke-book.invalid",
        "m4: ...it is treated as empty and the stamp lands",
      );

      // ── (h) the guard is not conditional on the flag ────────────────────
      const plainHijack = await callRoute(opplevelserRouter, {
        headers: auth,
        body: { email: "daniel@example.com", slug: "ekte-bryggeri" },
      });
      assertEq(plainHijack.status, 409, "h1: a real provider's slug is refused even without claimable");
      assertEq(diffRows(realBefore, readRow("prov-real")), [], "h2: ...and NO column on that row changed either");
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
