/**
 * opplevelser-gardssalg-field-concordance-remediation.test.ts — route-level
 * tests for orchestrator dev-request 2026-08-03-gardssalg-field-concordance
 * (write-side slice):
 *
 *   POST /admin/gardssalg-field-concordance-remediation
 *
 * The write side of the read-only GET /admin/gardssalg-field-concordance-
 * audit route (see opplevelser-gardssalg-field-concordance-audit.test.ts).
 * Dry-run (default) makes zero writes and previews `would_queue`; apply
 * stamps field_provenance.field_concordance on every scanned provider and
 * upserts a gardssalg_field_concordance_review_queue row for every genuine
 * avvik. Same in-memory-DB + mocked-fetch harness as the GET route's own
 * test file.
 *
 * Covers:
 *   (a) 403 without X-Admin-Key, 403 with wrong X-Admin-Key
 *   (b) dry-run (apply omitted): zero DB writes (byte-identical
 *       experience_providers dump + zero queue rows before/after), reports
 *       would_queue with the correct current_value/found_value for every
 *       avvik field, summary present
 *   (c) apply=true: writes the expected queue rows + provenance stamp,
 *       returns provenance_written/queued counts
 *   (d) apply accepts the same truthy-string/number forms as the sibling
 *       website-verification-remediation route (true/1/"1"/"true")
 *   (e) providerIds filter narrows the cohort exactly like the GET route's
 *       own filter (including malformed/blank -> 400, over-cap -> 400)
 *   (f) batch_id is recorded on queue rows and in the provenance stamp when
 *       apply=true
 *   (g) a re-run with apply=true reaching the same avvik conclusion does not
 *       duplicate/pointlessly bump the existing queue row
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
    method?: string;
    url?: string;
    headers?: Record<string, string>;
    body?: unknown;
  } = {},
): Promise<RouteResult> {
  return new Promise((resolve) => {
    const url = opts.url || "/admin/gardssalg-field-concordance-remediation";
    const method = opts.method || "POST";
    const req: any = {
      method,
      url,
      originalUrl: url,
      path: url,
      query: {},
      headers: opts.headers || {},
      body: opts.body ?? {},
      get() {
        return undefined;
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

export function runOpplevelserGardssalgFieldConcordanceRemediationTests(
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
    const prevFetch = globalThis.fetch;
    const testKey = process.env.ADMIN_KEY || "gardssalg-field-concordance-remediation-test-key";
    process.env.EXPERIENCES_DB_PATH = ":memory:";
    process.env.ADMIN_KEY = testKey;

    const dbFactoryPath = require.resolve("../database/db-factory");
    const experienceStorePath = require.resolve("../services/experience-store");
    const concordanceServicePath = require.resolve("../services/gardssalg-field-concordance");
    const opplevelserPath = require.resolve("./opplevelser");
    const cachePaths = [dbFactoryPath, experienceStorePath, concordanceServicePath, opplevelserPath];
    for (const p of cachePaths) delete require.cache[p];

    try {
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const expDb = dbFactory.getDb("experiences");
      const opplevelserRouter = (require("./opplevelser") as typeof import("./opplevelser")).default as any;

      const insertProvider = expDb.prepare(
        `INSERT INTO experience_providers
           (id, navn, vertical, hjemmeside, epost, telefon, mobil, adresse, postnummer, poststed,
            opening_hours_text, producer_type, rfb_seed_source, catalog_hidden, field_provenance,
            enrichment_state, verification_status, source, confidence)
         VALUES
           (@id, @navn, 'experiences', @hjemmeside, @epost, @telefon, @mobil, @adresse, @postnummer, @poststed,
            @opening_hours_text, @producer_type, @rfb_seed_source, @catalog_hidden, @field_provenance,
            'raw', 'pending_verify', 'test-fixture', 'medium')`,
      );

      const VERIFIED_STAMP = JSON.stringify({
        hjemmeside_verification: { verified: true, classification: "verified" },
      });

      // ── avvik fixture — epost/telefon differ from the page (mobil is left
      //     blank so it never itself contributes a THIRD avvik here — the
      //     page's only phone run is already claimed by telefon's own avvik;
      //     a non-blank mobil would ALSO avvik against that same run, which
      //     is correct per spec but not what this fixture is isolating) ────
      insertProvider.run({
        id: "prov-avvik",
        navn: "Bryggeriet Avvik",
        hjemmeside: "https://bryggeriet-avvik.example.no",
        epost: "gammel@avvikgard.no",
        telefon: "90000001",
        mobil: null,
        adresse: "Fjellveien 3",
        postnummer: "6100",
        poststed: "Volda",
        opening_hours_text: "Man-Fre 09-15",
        producer_type: "bryggeri",
        rfb_seed_source: null,
        catalog_hidden: 0,
        field_provenance: VERIFIED_STAMP,
      });

      // ── full-match fixture — everything bekreftet, never queued ─────────
      insertProvider.run({
        id: "prov-full-match",
        navn: "Sidergarden Fullmatch",
        hjemmeside: "https://sidergarden-fullmatch.example.no",
        epost: "post@sidergarden.no",
        telefon: "91234567",
        mobil: "99887766",
        adresse: "Gardsveien 12",
        postnummer: "5750",
        poststed: "Odda",
        opening_hours_text: "Ma-Fr 10-16",
        producer_type: "sideri",
        rfb_seed_source: null,
        catalog_hidden: 0,
        field_provenance: VERIFIED_STAMP,
      });

      const dumpProviders = () =>
        (expDb.prepare(`SELECT * FROM experience_providers ORDER BY id`).all() as unknown[]).map((r) => JSON.stringify(r));
      const dumpQueue = () =>
        (expDb.prepare(`SELECT * FROM gardssalg_field_concordance_review_queue ORDER BY provider_id, field_name`).all() as unknown[]).map(
          (r) => JSON.stringify(r),
        );

      globalThis.fetch = (async (url: string | URL | Request) => {
        const urlStr = String(url);
        const host = new URL(urlStr).hostname;
        if (host === "bryggeriet-avvik.example.no") {
          const html = `<html><body><p>Bryggeriet — kontakt: ny@avvikgard.no</p>
            <p>Ring 900 00 009 (dagtid).</p></body></html>`;
          return {
            ok: true, status: 200, text: async () => html,
            arrayBuffer: async () => new TextEncoder().encode(html).buffer,
            headers: { get: () => null }, url: urlStr,
          } as unknown as Response;
        }
        if (host === "sidergarden-fullmatch.example.no") {
          const html = `<html><body><p>Sidergarden — velkommen til smaking.</p>
            <p>Kontakt oss: post@sidergarden.no eller ring 912 34 567 / 998 87 766.</p>
            <p>Adresse: Gardsveien 12, 5750 Odda.</p>
            <p>Åpningstider: Ma-Fr 10-16.</p></body></html>`;
          return {
            ok: true, status: 200, text: async () => html,
            arrayBuffer: async () => new TextEncoder().encode(html).buffer,
            headers: { get: () => null }, url: urlStr,
          } as unknown as Response;
        }
        return {
          ok: false, status: 404, statusText: "Not Found", text: async () => "",
          arrayBuffer: async () => new ArrayBuffer(0),
          headers: { get: () => null }, url: urlStr,
        } as unknown as Response;
      }) as typeof fetch;

      // ── (a) auth gate ─────────────────────────────────────────────────────
      const noKey = await callRoute(opplevelserRouter);
      assertEq(noKey.status, 403, "a1: POST without X-Admin-Key -> 403");
      const badKey = await callRoute(opplevelserRouter, { headers: { "x-admin-key": "wrong-key" } });
      assertEq(badKey.status, 403, "a2: POST with wrong X-Admin-Key -> 403");
      const authHeaders = { "x-admin-key": testKey };

      // ── (b) dry-run — zero writes, would_queue preview ───────────────────
      const beforeDryRunProviders = dumpProviders();
      const beforeDryRunQueue = dumpQueue();
      const dryRun = await callRoute(opplevelserRouter, { headers: authHeaders, body: {} });
      assertEq(dryRun.status, 200, "b1: dry-run (apply omitted) -> 200");
      assertEq(dryRun.body.success, true, "b2: success:true");
      assertEq(dryRun.body.dry_run, true, "b3: dry_run:true when apply is omitted");
      assertTrue(Array.isArray(dryRun.body.would_queue), "b4: would_queue is an array");
      assertEq(
        dryRun.body.would_queue.filter((w: any) => w.provider_id === "prov-avvik").sort((x: any, y: any) => x.field_name.localeCompare(y.field_name)),
        [
          { provider_id: "prov-avvik", field_name: "epost", current_value: "gammel@avvikgard.no", found_value: "ny@avvikgard.no" },
          { provider_id: "prov-avvik", field_name: "telefon", current_value: "90000001", found_value: "90000009" },
        ],
        "b5: would_queue lists both avvik fields for prov-avvik with correct current/found values",
      );
      assertTrue(
        !dryRun.body.would_queue.some((w: any) => w.provider_id === "prov-full-match"),
        "b6: prov-full-match (all bekreftet) contributes nothing to would_queue",
      );
      assertTrue(!!dryRun.body.summary?.epost, "b7: summary present on dry-run response too");

      const afterDryRunProviders = dumpProviders();
      const afterDryRunQueue = dumpQueue();
      assertEq(afterDryRunProviders, beforeDryRunProviders, "b8: experience_providers byte-identical before/after dry-run");
      assertEq(afterDryRunQueue, beforeDryRunQueue, "b9: queue table byte-identical before/after dry-run (still empty)");
      assertEq(afterDryRunQueue.length, 0, "b9b: queue table is empty before any apply");

      // ── (e) providerIds validation (mirrors GET route's own) ─────────────
      const blankFilter = await callRoute(opplevelserRouter, { headers: authHeaders, body: { providerIds: [] } });
      // An empty array is `!== undefined`, so it goes through
      // parseGfcProviderIdsFilter and correctly 400s (same as GET's blank
      // query-string case) rather than silently meaning "no filter".
      assertEq(blankFilter.status, 400, "e1: empty providerIds array -> 400 (same discipline as GET's blank filter)");

      const tooMany = Array.from({ length: 201 }, (_, i) => `prov-bulk-${i}`);
      const overCap = await callRoute(opplevelserRouter, { headers: authHeaders, body: { providerIds: tooMany } });
      assertEq(overCap.status, 400, "e2: 201 providerIds -> 400 (exceeds cap of 200)");

      const filtered = await callRoute(opplevelserRouter, {
        headers: authHeaders,
        body: { providerIds: ["prov-avvik"] },
      });
      assertEq(filtered.status, 200, "e3: providerIds filter -> 200");
      assertTrue(
        filtered.body.would_queue.every((w: any) => w.provider_id === "prov-avvik"),
        "e4: providerIds filter narrows would_queue to only the requested provider",
      );

      // ── (c)/(d)/(f) apply=true — writes queue rows + provenance stamp ────
      const apply1 = await callRoute(opplevelserRouter, {
        headers: authHeaders,
        body: { apply: true, batch_id: "batch-remediation-1" },
      });
      assertEq(apply1.status, 200, "c1: apply=true -> 200");
      assertEq(apply1.body.success, true, "c2: success:true");
      assertEq(apply1.body.dry_run, false, "c3: dry_run:false when applying");
      assertEq(apply1.body.provenance_written, 2, "c4: provenance_written counts both cohort members (prov-avvik + prov-full-match)");
      assertEq(apply1.body.queued, 2, "c5: queued counts exactly the two avvik fields (epost+telefon on prov-avvik)");

      const queueAfterApply = expDb
        .prepare(`SELECT * FROM gardssalg_field_concordance_review_queue WHERE provider_id = 'prov-avvik' ORDER BY field_name`)
        .all() as any[];
      assertEq(queueAfterApply.length, 2, "c6: exactly two queue rows written for prov-avvik");
      assertEq(queueAfterApply[0].field_name, "epost", "c7: first queue row is epost");
      assertEq(queueAfterApply[0].found_value, "ny@avvikgard.no", "c8: epost found_value correct");
      assertEq(queueAfterApply[0].batch_id, "batch-remediation-1", "f1: batch_id recorded on the queue row");
      assertEq(queueAfterApply[1].field_name, "telefon", "c9: second queue row is telefon");
      assertEq(queueAfterApply[1].found_value, "90000009", "c10: telefon found_value correct");

      const fullMatchQueue = expDb
        .prepare(`SELECT * FROM gardssalg_field_concordance_review_queue WHERE provider_id = 'prov-full-match'`)
        .all() as any[];
      assertEq(fullMatchQueue.length, 0, "c11: prov-full-match (all bekreftet) never gets a queue row");

      const avvikProviderRow = expDb.prepare(`SELECT field_provenance FROM experience_providers WHERE id = 'prov-avvik'`).get() as any;
      const provenance = JSON.parse(avvikProviderRow.field_provenance);
      assertTrue(!!provenance.field_concordance, "c12: field_concordance stamp written on prov-avvik");
      assertEq(provenance.field_concordance.batch_id, "batch-remediation-1", "f2: batch_id recorded in the provenance stamp");
      assertEq(provenance.hjemmeside_verification, { verified: true, classification: "verified" }, "c13: hjemmeside_verification key preserved untouched by remediation apply");
      // Never auto-corrected — the actual column stays the OLD stored value.
      const avvikColumns = expDb.prepare(`SELECT epost, telefon FROM experience_providers WHERE id = 'prov-avvik'`).get() as any;
      assertEq(avvikColumns.epost, "gammel@avvikgard.no", "c14: experience_providers.epost is NEVER auto-corrected by apply");
      assertEq(avvikColumns.telefon, "90000001", "c15: experience_providers.telefon is NEVER auto-corrected by apply");

      // ── (d) apply accepts truthy string/number forms ─────────────────────
      const apply1Str = await callRoute(opplevelserRouter, { headers: authHeaders, body: { apply: "1", providerIds: ["prov-avvik"] } });
      assertEq(apply1Str.body.dry_run, false, "d1: apply:\"1\" is treated as true");
      const applyTrueStr = await callRoute(opplevelserRouter, { headers: authHeaders, body: { apply: "true", providerIds: ["prov-avvik"] } });
      assertEq(applyTrueStr.body.dry_run, false, "d2: apply:\"true\" is treated as true");
      const applyFalseish = await callRoute(opplevelserRouter, { headers: authHeaders, body: { apply: "0", providerIds: ["prov-avvik"] } });
      assertEq(applyFalseish.body.dry_run, true, "d3: apply:\"0\" is NOT treated as true -> stays dry-run");

      // ── (g) re-run with apply=true reaching the SAME avvik -> no
      //     duplicate/pointless-churn queue row ─────────────────────────────
      const rowsBeforeRerun = expDb
        .prepare(`SELECT * FROM gardssalg_field_concordance_review_queue WHERE provider_id = 'prov-avvik' AND field_name = 'epost'`)
        .get() as any;
      const apply2 = await callRoute(opplevelserRouter, {
        headers: authHeaders,
        body: { apply: true, providerIds: ["prov-avvik"], batch_id: "batch-remediation-2" },
      });
      assertEq(apply2.status, 200, "g1: second apply run -> 200");
      const rowsAfterRerun = expDb
        .prepare(`SELECT * FROM gardssalg_field_concordance_review_queue WHERE provider_id = 'prov-avvik' AND field_name = 'epost'`)
        .get() as any;
      const countAfterRerun = expDb
        .prepare(`SELECT COUNT(*) AS n FROM gardssalg_field_concordance_review_queue WHERE provider_id = 'prov-avvik' AND field_name = 'epost'`)
        .get() as any;
      assertEq(countAfterRerun.n, 1, "g2: still exactly one epost queue row for prov-avvik after multiple re-runs reaching the same avvik");
      assertEq(rowsAfterRerun.updated_at, rowsBeforeRerun.updated_at, "g3: updated_at is not bumped by a re-run reaching the identical conclusion");
    } catch (err: any) {
      failed++;
      failures.push(
        "opplevelser-gardssalg-field-concordance-remediation: unexpected error: " + String(err?.stack || err?.message || err),
      );
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
      globalThis.fetch = prevFetch;
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

// Standalone runner: `npx tsx src/routes/opplevelser-gardssalg-field-concordance-remediation.test.ts`
if (require.main === module) {
  runOpplevelserGardssalgFieldConcordanceRemediationTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    process.exit(summary.failed > 0 ? 1 : 0);
  });
}
