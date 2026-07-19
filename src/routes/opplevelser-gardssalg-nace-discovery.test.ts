/**
 * opplevelser-gardssalg-nace-discovery.test.ts — tests for dev-request
 * 2026-07-19-brreg-nace-drikkeprodusenter (the 67 North Distillery gap):
 * POST /admin/gardssalg-nace-discovery sweeps Brreg by the fixed drink NACE
 * family (11.010/11.030/11.040/11.050 → destilleri/sideri/mjøderi/bryggeri),
 * dedups against ALL existing org_nrs + exact pruned-name matches against
 * existing gårdssalg rows (incl. catalog_hidden), skips dead orgs, and — in
 * apply mode — creates providers org_nr-KEYED with Brreg address/hjemmeside
 * from birth, batch-tagged via rfb_seed_source for one-operation rollback
 * through the same endpoint's rollbackBatch mode.
 *
 * Same conventions as the other gårdssalg route test files: :memory: DB,
 * fresh requires, router.handle(), mocked globalThis.fetch for Brreg pages.
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
  opts: { url?: string; headers?: Record<string, string>; body?: any } = {},
): Promise<RouteResult> {
  return new Promise((resolve) => {
    const url = opts.url || "/admin/gardssalg-nace-discovery";
    const req: any = {
      method: "POST",
      url,
      originalUrl: url,
      path: url,
      query: {},
      headers: opts.headers || {},
      body: opts.body ?? {},
      get() { return undefined; },
    };
    const res: any = {
      statusCode: 200,
      status(code: number) { this.statusCode = code; return this; },
      json(payload: any) { resolve({ status: this.statusCode, body: payload }); return this; },
    };
    router.handle(req, res, (err?: any) => {
      if (err) resolve({ status: 500, body: { error: String(err) } });
    });
  });
}

export function runOpplevelserGardssalgNaceDiscoveryTests(
  log = false,
): Promise<TestSummary> {
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];

  function assertEq(actual: unknown, expected: unknown, label: string): void {
    if (actual === expected) { passed++; if (log) console.log(`  ✓ ${label}`); }
    else {
      failed++;
      failures.push(`✗ ${label} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
      if (log) console.log(`  ✗ ${label}`);
    }
  }
  function assertTrue(cond: boolean, label: string): void {
    if (cond) { passed++; if (log) console.log(`  ✓ ${label}`); }
    else { failed++; failures.push(`✗ ${label}`); if (log) console.log(`  ✗ ${label}`); }
  }

  return (async () => {
    const prevFetch = globalThis.fetch;
    const prevExperiencesDbPath = process.env.EXPERIENCES_DB_PATH;
    const prevAdminKey = process.env.ADMIN_KEY;
    const testKey = "gardssalg-nace-test-key";
    process.env.EXPERIENCES_DB_PATH = ":memory:";
    process.env.ADMIN_KEY = testKey;

    const dbFactoryPath = require.resolve("../database/db-factory");
    const experienceStorePath = require.resolve("../services/experience-store");
    const brregClientPath = require.resolve("../services/brreg-client");
    const opplevelserPath = require.resolve("./opplevelser");
    const cachePaths = [dbFactoryPath, experienceStorePath, brregClientPath, opplevelserPath];
    for (const p of cachePaths) delete require.cache[p];

    try {
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const expDb = dbFactory.getDb("experiences");
      const expStore = require("../services/experience-store") as typeof import("../services/experience-store");
      const opplevelserRouter = (require("./opplevelser") as typeof import("./opplevelser")).default as any;
      const adminHeaders = { "x-admin-key": testKey };

      // ═══ Section A — brregDisplayName ═══════════════════════════════════
      assertEq(expStore.brregDisplayName("67 NORTH DISTILLERY AS"), "67 North Distillery",
        "nd-a1: org-suffix stripped, digits kept, title case");
      assertEq(expStore.brregDisplayName("ÆGIR BRYGGERI AS"), "Ægir Bryggeri",
        "nd-a2: æøå title-cased correctly");
      assertEq(expStore.brregDisplayName("GARDEN FOR SAFT OG SIDER ANS"), "Garden for Saft og Sider",
        "nd-a3: Norwegian small words lowercased mid-name");
      assertEq(expStore.brregDisplayName("AS"), "As",
        "nd-a4: a name that IS only a suffix token is never emptied (title-cased, not stripped to nothing)");

      // ═══ Fixtures ═══════════════════════════════════════════════════════
      const insertProvider = expDb.prepare(
        `INSERT INTO experience_providers
           (id, navn, vertical, org_nr, catalog_hidden, products,
            producer_type, enrichment_state, verification_status, source, confidence)
         VALUES
           (@id, @navn, 'experiences', @org_nr, @catalog_hidden, '["x"]',
            @producer_type, 'raw', 'pending_verify', 'test-fixture', 'medium')`,
      );
      // Existing row WITH org_nr (any provider class) → orgnr-dup basis.
      insertProvider.run({ id: "prov-nd-orgnr", navn: "Har Orgnr Bryggeri", org_nr: "955555555", catalog_hidden: null, producer_type: "bryggeri" });
      // Existing HIDDEN gårdssalg row without org_nr → name-dup basis.
      insertProvider.run({ id: "prov-nd-hidden", navn: "Skjult Testsideri", org_nr: null, catalog_hidden: 1, producer_type: "sideri" });

      const brregPages: Record<string, any> = {
        "11.010|0": {
          page: { totalPages: 2 },
          _embedded: { enheter: [
            { organisasjonsnummer: "925174971", navn: "67 NORTH DISTILLERY AS",
              organisasjonsform: { kode: "AS" }, hjemmeside: "https://67north.example.no",
              forretningsadresse: { adresse: ["Industriveien 4"], postnummer: "8250", poststed: "ROGNAN", kommune: "SALTDAL", kommunenummer: "1840" } },
            { organisasjonsnummer: "966666666", navn: "KONKURS BRENNERI AS", konkurs: true,
              forretningsadresse: { kommune: "OSLO" } },
          ] },
        },
        "11.010|1": {
          page: { totalPages: 2 },
          _embedded: { enheter: [
            { organisasjonsnummer: "955555555", navn: "HAR ORGNR BRYGGERI AS",
              forretningsadresse: { kommune: "BERGEN" } },
            { organisasjonsnummer: "977777777", navn: "SKJULT TESTSIDERI AS",
              forretningsadresse: { kommune: "VOSS" } },
          ] },
        },
      };
      let brregCalls = 0;
      globalThis.fetch = (async (url: string | URL | Request) => {
        const urlStr = String(url);
        if (!urlStr.includes("data.brreg.no")) throw new Error(`unexpected fetch: ${urlStr}`);
        brregCalls++;
        const code = decodeURIComponent((urlStr.match(/naeringskode=([^&]*)/) || [])[1] || "");
        const page = (urlStr.match(/[?&]page=(\d+)/) || [])[1] || "0";
        const body = brregPages[`${code}|${page}`] ?? { page: { totalPages: 1 }, _embedded: { enheter: [] } };
        return { ok: true, status: 200, json: async () => body } as unknown as Response;
      }) as unknown as typeof fetch;

      // ── nd-1: auth + code validation. ───────────────────────────────────
      {
        const r = await callRoute(opplevelserRouter, { body: {} });
        assertEq(r.status, 403, "nd-1a: no admin key → 403");
      }
      {
        const r = await callRoute(opplevelserRouter, { headers: adminHeaders, body: { codes: ["11.010", "62.010"] } });
        assertEq(r.status, 400, "nd-1b: non-drink NACE code rejected (400)");
        assertEq(brregCalls, 0, "nd-1c: rejected request never reaches Brreg");
      }

      // ── nd-2: DRY-RUN — paging, buckets, nothing written. ───────────────
      {
        const r = await callRoute(opplevelserRouter, { headers: adminHeaders, body: { codes: ["11.010"] } });
        assertEq(r.status, 200, "nd-2a: dry-run 200");
        assertEq(r.body.dry_run, true, "nd-2b: dry-run default");
        assertEq(brregCalls, 2, "nd-2c: both Brreg pages fetched (totalPages honored)");
        assertEq(r.body.per_code["11.010"].total, 4, "nd-2d: all four enheter counted");
        assertEq(r.body.per_code["11.010"].dead, 1, "nd-2e: konkurs row → dead");
        assertEq(r.body.per_code["11.010"].duplicates, 2, "nd-2f: orgnr-dup + name-dup both counted");
        assertEq(r.body.created_count, 1, "nd-2g: exactly one creatable candidate");
        assertEq(r.body.created[0]?.org_nr, "925174971", "nd-2h: it is 67 North");
        assertEq(r.body.created[0]?.navn, "67 North Distillery", "nd-2i: display name transformed");
        assertEq(r.body.created[0]?.producer_type, "destilleri", "nd-2j: NACE→producer_type mapping");
        const nameDup = (r.body.duplicates as any[]).find((d) => d.reason === "exact_name_matches_existing_gardssalg");
        assertEq(nameDup?.existing_provider_id, "prov-nd-hidden",
          "nd-2k: hidden gårdssalg row matched by pruned name (never re-created)");
        assertEq(nameDup?.suggested_orgnr_for_existing, "977777777",
          "nd-2l: name-dup carries the suggested org_nr for the 5b review flow");
        const cnt = (expDb.prepare(`SELECT COUNT(*) c FROM experience_providers`).get() as any).c;
        assertEq(cnt, 2, "nd-2m: dry-run created NOTHING");
      }

      // ── nd-3: APPLY — row born org_nr-keyed with address + tag. ─────────
      let batchTag = "";
      {
        const r = await callRoute(opplevelserRouter, { headers: adminHeaders, body: { codes: ["11.010"], apply: true } });
        assertEq(r.body.dry_run, false, "nd-3a: apply mode");
        assertEq(r.body.created_count, 1, "nd-3b: one row created");
        batchTag = r.body.batch_tag;
        assertTrue(/^brreg-nace-\d{4}-\d{2}-\d{2}$/.test(batchTag), "nd-3c: batch tag is date-stamped");
        const row = expDb.prepare(`SELECT * FROM experience_providers WHERE org_nr='925174971'`).get() as any;
        assertTrue(!!row, "nd-3d: 67 North exists in the catalog table");
        assertEq(row.navn, "67 North Distillery", "nd-3e: display name persisted");
        assertEq(row.producer_type, "destilleri", "nd-3f: producer_type set (destilleri badge exists in UI map)");
        assertEq(row.adresse, "Industriveien 4", "nd-3g: Brreg forretningsadresse landed at birth");
        assertEq(row.postnummer, "8250", "nd-3h: postnummer landed");
        assertEq(row.kommune, "Saltdal", "nd-3i: kommune title-cased");
        assertEq(row.hjemmeside, "https://67north.example.no", "nd-3j: hjemmeside landed");
        assertEq(row.naeringskode, "11.010", "nd-3k: naeringskode recorded");
        assertEq(row.rfb_seed_source, batchTag, "nd-3l: batch tag on the row");
        assertEq(row.source, "brreg-nace-discovery", "nd-3m: source marker");
        assertTrue(row.booking_live !== 1, "nd-3n: booking_live NEVER set by discovery");
        const visible = expStore.listGardssalgProviders(100, 0).some((p: any) => p.navn === "67 North Distillery");
        assertTrue(visible, "nd-3o: new provider visible in the gårdssalg catalog listing");
      }

      // ── nd-4: idempotent re-apply → duplicate, no second row. ───────────
      {
        const r = await callRoute(opplevelserRouter, { headers: adminHeaders, body: { codes: ["11.010"], apply: true } });
        assertEq(r.body.created_count, 0, "nd-4a: second apply creates nothing");
        const cnt = (expDb.prepare(`SELECT COUNT(*) c FROM experience_providers WHERE org_nr='925174971'`).get() as any).c;
        assertEq(cnt, 1, "nd-4b: still exactly one 67 North row");
      }

      // ── nd-6: review-queue approve lever (slice 5b follow-through) —
      //    strict confirmation surface, never arbitrary writes. ─────────────
      {
        expDb.prepare(
          `INSERT INTO experience_providers (id, navn, vertical, products, producer_type, enrichment_state, verification_status, source, confidence)
           VALUES ('prov-appr-1','Godkjenn Gard','experiences','["x"]','bryggeri','raw','pending_verify','test-fixture','medium')`
        ).run();
        expDb.prepare(
          `INSERT INTO gardssalg_orgnr_review_queue (id, provider_id, provider_name, candidate_orgnr, candidate_name, candidate_confidence, reason, created_at, updated_at)
           VALUES ('rq-1','prov-appr-1','Godkjenn Gard','988111222','GODKJENN GARD AS',0.95,'needs_human_review',datetime('now'),datetime('now'))`
        ).run();
        const dry = await callRoute(opplevelserRouter, {
          headers: adminHeaders, url: "/admin/gardssalg-orgnr-review-approve",
          body: { approvals: [{ provider_id: "prov-appr-1", org_nr: "988111222" }, { provider_id: "prov-appr-1", org_nr: "988111222" }, { provider_id: "ukjent", org_nr: "911111111" }, { provider_id: "prov-appr-1x", org_nr: "999999999" }] },
        });
        assertEq(dry.body.dry_run, true, "nd-6a: approve dry-run default");
        assertEq(dry.body.approved_count, 1, "nd-6b: only the queued exact pair approves");
        const reasons = Object.fromEntries((dry.body.rejected as any[]).map((r) => [r.provider_id, r.reason]));
        assertEq(reasons["prov-appr-1"], "duplicate_in_request", "nd-6c: duplicate item rejected");
        assertEq(reasons["ukjent"], "not_in_review_queue", "nd-6d: non-queued provider rejected");
        const rowDry = expDb.prepare(`SELECT org_nr FROM experience_providers WHERE id='prov-appr-1'`).get() as any;
        assertEq(rowDry.org_nr, null, "nd-6e: dry-run wrote nothing");
        const bad = await callRoute(opplevelserRouter, {
          headers: adminHeaders, url: "/admin/gardssalg-orgnr-review-approve",
          body: { approvals: [{ provider_id: "prov-appr-1", org_nr: "911111111" }], apply: true },
        });
        assertEq((bad.body.rejected as any[])[0]?.reason, "mismatch_with_queued_candidate",
          "nd-6f: a DIFFERENT org_nr than the queued candidate is rejected (no arbitrary-write surface)");
        const ok = await callRoute(opplevelserRouter, {
          headers: adminHeaders, url: "/admin/gardssalg-orgnr-review-approve",
          body: { approvals: [{ provider_id: "prov-appr-1", org_nr: "988111222" }], apply: true },
        });
        assertEq(ok.body.approved_count, 1, "nd-6g: queued pair applies");
        const rowAppr = expDb.prepare(`SELECT org_nr FROM experience_providers WHERE id='prov-appr-1'`).get() as any;
        assertEq(rowAppr.org_nr, "988111222", "nd-6h: org_nr persisted via the guarded applier");
        const qLeft = (expDb.prepare(`SELECT COUNT(*) c FROM gardssalg_orgnr_review_queue WHERE provider_id='prov-appr-1'`).get() as any).c;
        assertEq(qLeft, 0, "nd-6i: queue entry cleared on confirmed write");
        const audit = (expDb.prepare(`SELECT COUNT(*) c FROM gardssalg_content_audit WHERE provider_id='prov-appr-1' AND field_name='org_nr'`).get() as any).c;
        assertEq(audit, 1, "nd-6j: approve write carries the same audit trail");
      }

      // ── nd-5: batch rollback — only tagged rows, refuses 'rfb-seed'. ────
      {
        const r0 = await callRoute(opplevelserRouter, { headers: adminHeaders, body: { rollbackBatch: "rfb-seed", apply: true } });
        assertEq(r0.status, 400, "nd-5a: legacy 'rfb-seed' tag refused");
        const r1 = await callRoute(opplevelserRouter, { headers: adminHeaders, body: { rollbackBatch: batchTag } });
        assertEq(r1.body.dry_run, true, "nd-5b: rollback dry-run default");
        assertEq(r1.body.would_delete, 1, "nd-5c: exactly the one tagged row targeted");
        const r2 = await callRoute(opplevelserRouter, { headers: adminHeaders, body: { rollbackBatch: batchTag, apply: true } });
        assertEq(r2.body.deleted, 1, "nd-5d: tagged row deleted");
        const cnt = (expDb.prepare(`SELECT COUNT(*) c FROM experience_providers`).get() as any).c;
        assertEq(cnt, 3, "nd-5e: pre-existing rows (incl. nd-6's approve fixture) untouched by batch rollback");
      }
    } catch (err: any) {
      failed++;
      failures.push("opplevelser-gardssalg-nace-discovery: unexpected error: " + String(err?.stack || err?.message || err));
    } finally {
      globalThis.fetch = prevFetch;
      if (prevExperiencesDbPath === undefined) delete process.env.EXPERIENCES_DB_PATH;
      else process.env.EXPERIENCES_DB_PATH = prevExperiencesDbPath;
      if (prevAdminKey === undefined) delete process.env.ADMIN_KEY;
      else process.env.ADMIN_KEY = prevAdminKey;
      try {
        const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
        dbFactory.__resetDbFactoryForTesting();
      } catch { /* best-effort */ }
      for (const p of cachePaths) delete require.cache[p];
    }

    return { passed, failed, failures };
  })();
}
