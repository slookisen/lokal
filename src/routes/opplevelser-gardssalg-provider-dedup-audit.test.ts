/**
 * opplevelser-gardssalg-provider-dedup-audit.test.ts — tests for
 * GET /admin/gardssalg-provider-dedup-audit (src/routes/opplevelser.ts).
 *
 * dev-request 2026-07-31-gardssalg-provider-dubletter-på-tvers-av-seeds,
 * slice 1 of 3 (read-only audit only — no merge lever, no outreach-guard).
 *
 * Coverage measurement on 2026-07-31 found near-duplicate experience_providers
 * rows across seed batches (same real-world producer, two ids), e.g. a sparse
 * homepage_unreachable_since-flagged row vs a richer contact-complete row
 * discovered later. This endpoint groups candidate duplicates by org_nr /
 * website registrable-domain / name (scoreNameMatch, brreg-client.ts) — never
 * writes, never merges.
 *
 * Mirrors opplevelser-gardssalg-outreach-readiness.test.ts's setup
 * (EXPERIENCES_DB_PATH=":memory:", fresh require of db-factory + opplevelser
 * router per run, callRoute() exercising router.handle() directly with
 * X-Admin-Key via headers, raw SQL INSERT fixtures).
 *
 * Covers (acceptance criteria from the dev-request):
 *   (a) 403 without X-Admin-Key
 *   (b) name-signal group at the "first token + same postal" tier (0.95) —
 *       the Wilsgård Bryggeri — Torsken / Wilsgård shape — grouped, HIGH
 *       confidence, signal "name_first_token_postal"
 *   (c) name-signal group at the "first token only" tier (0.80) — the
 *       Himkok / Himkok Rtd shape — grouped, but flagged LOW confidence,
 *       signal "name_first_token" only (never silently dropped, never
 *       silently treated as equally certain as an exact match)
 *   (d) exact-name-signal group — the Kinn Bryggeri / Kinn Bryggeri shape —
 *       grouped, HIGH confidence, signal "name_exact"
 *   (e) org_nr-only signal group (distinct names/domains, same org_nr)
 *   (f) domain-only signal group (distinct names/org_nr, same registrable
 *       domain reached via a www./path variant)
 *   (g) negative control — two genuinely different rows never appear
 *       together in any group, nor as a singleton "group"
 *   (h) non-gårdssalg row (no producer_type, not rfb-seed) and the synthetic
 *       test-gardssalg row are both excluded from the scan entirely
 *   (i) per-row response shape: only id/navn/org_nr/rfb_seed_source/
 *       producer_type/content_source/has_email/has_phone/unreachable/
 *       homepage_unreachable_since — never a raw epost/telefon/hjemmeside
 *       value anywhere in the response
 *   (j) has_email/has_phone/unreachable booleans computed correctly
 *   (k) zero net DB writes: row count and every fixture row's raw column
 *       values are byte-identical before vs after calling the endpoint
 *       TWICE, and no merge/delete-marker column exists on the table at all
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
      url: "/admin/gardssalg-provider-dedup-audit",
      originalUrl: "/admin/gardssalg-provider-dedup-audit",
      path: "/admin/gardssalg-provider-dedup-audit",
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

export function runOpplevelserGardssalgProviderDedupAuditTests(
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
    const testKey = "gardssalg-provider-dedup-audit-test-key";
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
           (id, navn, vertical, org_nr, postnummer, rfb_seed_source, producer_type,
            epost, telefon, hjemmeside, content_source, homepage_unreachable_since,
            enrichment_state, verification_status, source, confidence)
         VALUES
           (@id, @navn, 'experiences', @org_nr, @postnummer, @rfb_seed_source, @producer_type,
            @epost, @telefon, @hjemmeside, @content_source, @homepage_unreachable_since,
            'raw', 'pending_verify', 'test-fixture', 'medium')`,
      );

      // ── (b) name_first_token_postal — Wilsgård Bryggeri — Torsken / Wilsgård ──
      // Sparse, seeded-early row: no contact info at all, flagged unreachable.
      insertProvider.run({
        id: "prov-wilsgard-a", navn: "Wilsgård Bryggeri — Torsken", org_nr: null, postnummer: "9391",
        rfb_seed_source: "rfb-seed", producer_type: null,
        epost: null, telefon: null, hjemmeside: null,
        content_source: null, homepage_unreachable_since: "2026-06-01T00:00:00.000Z",
      });
      // Richer, later-discovered row for the same postal area, full contact info.
      insertProvider.run({
        id: "prov-wilsgard-b", navn: "Wilsgård", org_nr: null, postnummer: "9391",
        rfb_seed_source: null, producer_type: "bryggeri",
        epost: "post@wilsgaard.no", telefon: "99999999", hjemmeside: "https://www.wilsgaard.no",
        content_source: "provider_site", homepage_unreachable_since: null,
      });

      // ── (c) name_first_token (LOW confidence) — Himkok / Himkok Rtd ─────────
      // Different postal codes -> no postal corroboration -> stays at the
      // first-token-only (0.80) tier, a genuine judgment call.
      insertProvider.run({
        id: "prov-himkok-a", navn: "Himkok", org_nr: null, postnummer: "0150",
        rfb_seed_source: "rfb-seed", producer_type: null,
        epost: null, telefon: null, hjemmeside: null,
        content_source: null, homepage_unreachable_since: null,
      });
      insertProvider.run({
        id: "prov-himkok-b", navn: "Himkok Rtd", org_nr: null, postnummer: "0250",
        rfb_seed_source: null, producer_type: "bryggeri",
        epost: "post@himkokrtd.no", telefon: "88888888", hjemmeside: "https://himkokrtd.no",
        content_source: "provider_site", homepage_unreachable_since: null,
      });

      // ── (d) name_exact — Kinn Bryggeri / Kinn Bryggeri ──────────────────────
      insertProvider.run({
        id: "prov-kinn-a", navn: "Kinn Bryggeri", org_nr: null, postnummer: "6900",
        rfb_seed_source: "rfb-seed", producer_type: null,
        epost: null, telefon: null, hjemmeside: null,
        content_source: null, homepage_unreachable_since: null,
      });
      insertProvider.run({
        id: "prov-kinn-b", navn: "Kinn Bryggeri", org_nr: null, postnummer: "6900",
        rfb_seed_source: null, producer_type: "bryggeri",
        epost: "post@kinnbryggeri.no", telefon: "77777777", hjemmeside: null,
        content_source: null, homepage_unreachable_since: null,
      });

      // ── (e) org_nr-only — distinct names/domains, same org_nr ──────────────
      // NB: experience_providers.org_nr has a UNIQUE constraint (init-
      // experiences.ts), so two rows can never carry the LITERAL same org_nr
      // string — that's precisely why real cross-seed-source duplicates
      // (e.g. the Wilsgård pair) end up with only ONE side org_nr-populated
      // in practice. The one way two rows legitimately end up with the same
      // org_nr AFTER normalization while still satisfying the DB's raw
      // UNIQUE constraint is whitespace padding drift between seed sources
      // (" 900111222 " vs "900111222" — different raw strings, same number)
      // — used here to exercise the org_nr signal's own .trim() end-to-end
      // rather than only unit-testing the comparison in isolation.
      insertProvider.run({
        id: "prov-orgnr-a", navn: "Nordlys Utsalg AS", org_nr: "900111222", postnummer: null,
        rfb_seed_source: "rfb-seed", producer_type: null,
        epost: null, telefon: null, hjemmeside: "https://nordlys-utsalg.no",
        content_source: null, homepage_unreachable_since: null,
      });
      insertProvider.run({
        id: "prov-orgnr-b", navn: "Object Produksjon AS", org_nr: " 900111222 ", postnummer: null,
        rfb_seed_source: null, producer_type: "destilleri",
        epost: "post@objectprod.no", telefon: null, hjemmeside: "https://annet-domene.no",
        content_source: "provider_site", homepage_unreachable_since: null,
      });

      // ── (f) domain-only — distinct names/org_nr, same registrable domain ───
      // (one reached via www. + a path, the other bare — must still collapse
      // to the same registrable domain via homepageRegistrableDomain).
      insertProvider.run({
        id: "prov-domain-a", navn: "Sjømat Nord AS", org_nr: "111000111", postnummer: null,
        rfb_seed_source: "rfb-seed", producer_type: null,
        epost: null, telefon: null, hjemmeside: "https://www.sjomatprodukt.no/om-oss",
        content_source: null, homepage_unreachable_since: null,
      });
      insertProvider.run({
        id: "prov-domain-b", navn: "Kystfisk Handel", org_nr: "222000222", postnummer: null,
        rfb_seed_source: null, producer_type: "fiskeri",
        epost: "post@sjomatprodukt.no", telefon: null, hjemmeside: "http://sjomatprodukt.no",
        content_source: "provider_site", homepage_unreachable_since: null,
      });

      // ── (g) negative control — genuinely different rows, must never group ──
      insertProvider.run({
        id: "prov-negctrl-a", navn: "Østbø Gård", org_nr: "111222333", postnummer: "5700",
        rfb_seed_source: "rfb-seed", producer_type: null,
        epost: "post@ostbogard.no", telefon: "11111111", hjemmeside: "https://ostbogard.no",
        content_source: "provider_site", homepage_unreachable_since: null,
      });
      insertProvider.run({
        id: "prov-negctrl-b", navn: "Ramsøy Sjømat", org_nr: "444555666", postnummer: "6000",
        rfb_seed_source: "rfb-seed", producer_type: null,
        epost: "post@ramsoysjomat.no", telefon: "22222222", hjemmeside: "https://ramsoy-sjomat.no",
        content_source: "provider_site", homepage_unreachable_since: null,
      });

      // ── (h) excluded rows: never scoped in at all ───────────────────────────
      // Non-gårdssalg row: no producer_type, not rfb-seed.
      insertProvider.run({
        id: "prov-not-gardssalg", navn: "Wilsgård", org_nr: null, postnummer: "9391",
        rfb_seed_source: null, producer_type: null,
        epost: null, telefon: null, hjemmeside: null,
        content_source: null, homepage_unreachable_since: null,
      });
      // Synthetic booking-flyt test provider — same guard other gårdssalg
      // read routes already apply (gardssalgSharedHostCounts etc.).
      insertProvider.run({
        id: "prov-test-gardssalg", navn: "Kinn Bryggeri", org_nr: null, postnummer: "6900",
        rfb_seed_source: null, producer_type: "test-gardssalg",
        epost: "test@test.no", telefon: "00000000", hjemmeside: null,
        content_source: null, homepage_unreachable_since: null,
      });

      const opplevelserRouter = (require("./opplevelser") as typeof import("./opplevelser")).default as any;

      // Snapshot every fixture row's raw columns before any request, for the
      // zero-writes check below.
      const snapshotBefore = expDb
        .prepare(
          `SELECT id, navn, org_nr, postnummer, rfb_seed_source, producer_type,
                  epost, telefon, hjemmeside, content_source, homepage_unreachable_since
             FROM experience_providers ORDER BY id`,
        )
        .all();
      const countBefore = (expDb.prepare(`SELECT COUNT(*) AS n FROM experience_providers`).get() as { n: number }).n;

      // ── (a) 403 without X-Admin-Key ─────────────────────────────────────
      const noKey = await callRoute(opplevelserRouter, {});
      assertEq(noKey.status, 403, "a1: GET /admin/gardssalg-provider-dedup-audit without X-Admin-Key -> 403");
      assertTrue(!noKey.body?.groups, "a2: no-key response carries no groups payload");

      // ── Happy-path call (used by b–j below) ─────────────────────────────
      const first = await callRoute(opplevelserRouter, { headers: { "x-admin-key": testKey } });
      assertEq(first.status, 200, "0: happy-path call -> 200");

      const groups: any[] = first.body.groups;
      assertTrue(Array.isArray(groups), "0b: response carries a groups array");

      function groupContaining(id: string): any | undefined {
        return groups.find((g) => g.rows.some((r: any) => r.id === id));
      }

      // ── (b) name_first_token_postal — Wilsgård pair ─────────────────────
      const wilsgard = groupContaining("prov-wilsgard-a");
      assertTrue(!!wilsgard, "b1: Wilsgård Bryggeri — Torsken lands in a group");
      assertTrue(
        !!wilsgard && wilsgard.rows.some((r: any) => r.id === "prov-wilsgard-b"),
        "b2: Wilsgård Bryggeri — Torsken groups WITH Wilsgård (same group)",
      );
      assertEq(wilsgard?.rows.length, 2, "b3: Wilsgård group has exactly 2 rows (the non-gårdssalg homonym is excluded)");
      assertTrue(
        !!wilsgard && wilsgard.signals.includes("name_first_token_postal"),
        "b4: Wilsgård group's signals include name_first_token_postal",
      );
      assertEq(wilsgard?.confidence, "high", "b5: Wilsgård group is HIGH confidence (first-token + same postal)");

      // ── (c) name_first_token (LOW confidence) — Himkok pair ─────────────
      const himkok = groupContaining("prov-himkok-a");
      assertTrue(!!himkok, "c1: Himkok lands in a group");
      assertTrue(
        !!himkok && himkok.rows.some((r: any) => r.id === "prov-himkok-b"),
        "c2: Himkok groups WITH Himkok Rtd (same group)",
      );
      assertEq(himkok?.signals, ["name_first_token"], "c3: Himkok group's ONLY signal is name_first_token (first-token only, no postal corroboration)");
      assertEq(himkok?.confidence, "low", "c4: Himkok group is LOW confidence — a judgment call, surfaced not silently merged or silently dropped");

      // ── (d) name_exact — Kinn Bryggeri pair ─────────────────────────────
      const kinn = groupContaining("prov-kinn-a");
      assertTrue(!!kinn, "d1: Kinn Bryggeri lands in a group");
      assertTrue(
        !!kinn && kinn.rows.some((r: any) => r.id === "prov-kinn-b"),
        "d2: Kinn Bryggeri groups WITH the second Kinn Bryggeri row",
      );
      assertEq(kinn?.rows.length, 2, "d3: Kinn Bryggeri group has exactly 2 rows (the test-gardssalg homonym is excluded)");
      assertTrue(!!kinn && kinn.signals.includes("name_exact"), "d4: Kinn Bryggeri group's signals include name_exact");
      assertEq(kinn?.confidence, "high", "d5: Kinn Bryggeri group is HIGH confidence (exact name match)");

      // ── (e) org_nr-only signal ───────────────────────────────────────────
      const orgnrGroup = groupContaining("prov-orgnr-a");
      assertTrue(!!orgnrGroup, "e1: org_nr-sharing row lands in a group");
      assertTrue(
        !!orgnrGroup && orgnrGroup.rows.some((r: any) => r.id === "prov-orgnr-b"),
        "e2: org_nr-sharing rows land in the SAME group",
      );
      assertEq(orgnrGroup?.signals, ["org_nr"], "e3: org_nr-only group's ONLY signal is org_nr (names/domains genuinely differ)");
      assertEq(orgnrGroup?.confidence, "high", "e4: org_nr-only group is HIGH confidence");

      // ── (f) domain-only signal ───────────────────────────────────────────
      const domainGroup = groupContaining("prov-domain-a");
      assertTrue(!!domainGroup, "f1: domain-sharing row lands in a group");
      assertTrue(
        !!domainGroup && domainGroup.rows.some((r: any) => r.id === "prov-domain-b"),
        "f2: domain-sharing rows (www.+path vs bare) land in the SAME group",
      );
      assertEq(domainGroup?.signals, ["domain"], "f3: domain-only group's ONLY signal is domain (names/org_nr genuinely differ)");
      assertEq(domainGroup?.confidence, "high", "f4: domain-only group is HIGH confidence");

      // ── (g) negative control ─────────────────────────────────────────────
      assertTrue(!groupContaining("prov-negctrl-a"), "g1: Østbø Gård (negative control) appears in NO group");
      assertTrue(!groupContaining("prov-negctrl-b"), "g2: Ramsøy Sjømat (negative control) appears in NO group");

      // ── (h) excluded rows ─────────────────────────────────────────────────
      const allReturnedIds = new Set(groups.flatMap((g) => g.rows.map((r: any) => r.id)));
      assertTrue(!allReturnedIds.has("prov-not-gardssalg"), "h1: non-gårdssalg row never appears in any group");
      assertTrue(!allReturnedIds.has("prov-test-gardssalg"), "h2: synthetic test-gardssalg row never appears in any group");
      assertEq(first.body.total_providers_scanned, 12, "h3: total_providers_scanned excludes the 2 out-of-scope rows (14 inserted - 2 excluded)");

      // ── (i) per-row response shape / no raw PII ──────────────────────────
      const sampleRow = wilsgard.rows.find((r: any) => r.id === "prov-wilsgard-b");
      assertEq(
        Object.keys(sampleRow).sort(),
        ["content_source", "has_email", "has_phone", "homepage_unreachable_since", "id", "navn", "org_nr", "producer_type", "rfb_seed_source", "unreachable"].sort(),
        "i1: row object carries only the documented fields",
      );
      const serialized = JSON.stringify(first.body);
      for (const pii of [
        "post@wilsgaard.no", "99999999", "www.wilsgaard.no",
        "post@himkokrtd.no", "88888888", "himkokrtd.no",
        "post@kinnbryggeri.no", "77777777",
        "post@objectprod.no",
        "post@sjomatprodukt.no", "sjomatprodukt.no",
      ]) {
        assertTrue(!serialized.includes(pii), `i2: response never includes raw contact value "${pii}"`);
      }

      // ── (j) has_email / has_phone / unreachable booleans ─────────────────
      const wilsgardA = wilsgard.rows.find((r: any) => r.id === "prov-wilsgard-a");
      const wilsgardB = wilsgard.rows.find((r: any) => r.id === "prov-wilsgard-b");
      assertEq(wilsgardA.has_email, false, "j1: sparse Wilsgård row has_email=false");
      assertEq(wilsgardA.has_phone, false, "j2: sparse Wilsgård row has_phone=false");
      assertEq(wilsgardA.unreachable, true, "j3: sparse Wilsgård row unreachable=true (homepage_unreachable_since set)");
      assertEq(wilsgardA.homepage_unreachable_since, "2026-06-01T00:00:00.000Z", "j4: sparse Wilsgård row carries the raw homepage_unreachable_since timestamp");
      assertEq(wilsgardB.has_email, true, "j5: rich Wilsgård row has_email=true");
      assertEq(wilsgardB.has_phone, true, "j6: rich Wilsgård row has_phone=true");
      assertEq(wilsgardB.unreachable, false, "j7: rich Wilsgård row unreachable=false");

      // ── (k) zero net DB writes ─────────────────────────────────────────────
      // Call the endpoint a SECOND time and confirm nothing changed.
      const second = await callRoute(opplevelserRouter, { headers: { "x-admin-key": testKey } });
      assertEq(second.status, 200, "k1: second call -> 200");
      assertEq(second.body, first.body, "k2: second call returns byte-identical output to the first (deterministic, no side effect from the first call)");

      const countAfter = (expDb.prepare(`SELECT COUNT(*) AS n FROM experience_providers`).get() as { n: number }).n;
      assertEq(countAfter, countBefore, "k3: row count unchanged after two calls");

      const snapshotAfter = expDb
        .prepare(
          `SELECT id, navn, org_nr, postnummer, rfb_seed_source, producer_type,
                  epost, telefon, hjemmeside, content_source, homepage_unreachable_since
             FROM experience_providers ORDER BY id`,
        )
        .all();
      assertEq(snapshotAfter, snapshotBefore, "k4: every fixture row's raw columns are byte-identical before vs after two calls");

      // No merge/deletion-marker column exists on the table at all (this
      // endpoint's slice never adds one) — a PRAGMA table_info sanity check.
      const columns = (expDb.prepare(`PRAGMA table_info(experience_providers)`).all() as Array<{ name: string }>).map((c) => c.name);
      assertTrue(!columns.includes("merged_into"), "k5: no merged_into column exists on experience_providers");
      assertTrue(!columns.includes("deleted_at"), "k6: no deleted_at column exists on experience_providers");
    } catch (err: any) {
      failed++;
      failures.push("opplevelser-gardssalg-provider-dedup-audit: unexpected error: " + String(err?.stack || err?.message || err));
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

// Standalone runner: `npx tsx src/routes/opplevelser-gardssalg-provider-dedup-audit.test.ts`
if (require.main === module) {
  runOpplevelserGardssalgProviderDedupAuditTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    process.exit(summary.failed > 0 ? 1 : 0);
  });
}
