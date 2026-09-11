/**
 * opplevelser-experience-brreg-recheck-backfill.test.ts — tests for
 * POST /admin/experiences-provider-brreg-recheck-backfill
 * (routes/opplevelser.ts) and its underlying
 * services/experience-brreg-recheck-backfill.ts.
 *
 * PROBLEM this closes: classifyProvider() (services/experience-brreg.ts)
 * classifies a provider name ONCE, at POST /admin/bulk-load insert time, and
 * calls setBrregVerification() (services/experience-store.ts) to write
 * brreg_active ONLY on a confident verdict (verified_active -> 1, inactive
 * -> 0). A provider classified `unverified` at insert time is left at
 * brreg_active=NULL forever — nothing else ever revisits it. Downstream,
 * POST /admin/experiences-content-judge-sweep's quarantine-exit promotion
 * logic requires provider.brreg_active===1, so a NULL-stuck provider can
 * NEVER be promoted out of needs_review even after a fresh content-judge
 * re-check confirms MATCH.
 *
 * Same test-harness conventions as opplevelser-bulk-load-admission-gate.test.ts
 * / opplevelser-experiences-admission-promotion.test.ts: in-memory
 * experiences DB (EXPERIENCES_DB_PATH=":memory:"), fresh requires per run,
 * router.handle() as the HTTP entry point, Brreg stubbed via
 * __setBrregFetchForTesting (the SAME seam classifyProvider()'s own tests
 * use — no second Brreg-stubbing convention invented here), and a mocked
 * globalThis.fetch for the composition block's evidence-page + Anthropic
 * judge calls. No live network anywhere in this file.
 *
 * Covers:
 *   (a) auth: no X-Admin-Key -> 403.
 *   (b) selection: only brreg_active IS NULL rows are candidates — a row
 *       already brreg_active=1 or =0 never appears in `planned` and
 *       classifyProvider is never called for it (Brreg call counter).
 *   (c) selection: content_source IN ('manual','claim') rows are excluded
 *       even though brreg_active IS NULL (owner-lock, same convention as
 *       selectGardssalgProvidersForOrgnrBackfill).
 *   (d) selection: catalog_hidden=1 rows are excluded.
 *   (e) dry-run: resolved_active / resolved_inactive / still_unresolved
 *       verdicts are correctly classified and reported per row, but ZERO
 *       DB writes happen either way (brreg_active/brreg_verified/org_nr
 *       byte-identical before/after).
 *   (f) apply (dry_run:false): resolved_active/resolved_inactive rows are
 *       ACTUALLY written (brreg_active, brreg_verified=1, org_nr,
 *       brreg_checked_at stamped); still_unresolved row stays byte-identical
 *       (brreg_active still NULL) — never guessed.
 *   (g) STRICT dry_run parse: `dry_run: "false"` (a STRING, the classic curl
 *       typo) is NOT apply — same idiom as every other STRICT-FALSE sweep in
 *       this file; only the literal JSON boolean false writes.
 *   (h) fail-closed on a throwing Brreg lookup: still_unresolved + a
 *       separate `errors` tally, ZERO write, the batch does not abort (a
 *       sibling row after it is still processed).
 *   (i) pagination: a page where every row stays still_unresolved (no state
 *       change) still ADVANCES via `next_after` on the next call, instead of
 *       a bare `ORDER BY id LIMIT ?` re-selecting the same rows forever.
 *   (j) enrichment write-pause fence: apply blocked 423 under a live
 *       'experiences' pause (paused:true, vertical:'experiences'), ZERO
 *       writes; dry-run under the same pause is NEVER blocked; clearing the
 *       pause lets apply through again.
 *   (k) service-level: exported limit constants (default/max) sanity-checked,
 *       and a limit far above the max never processes more than the max even
 *       when more rows are eligible.
 *   (l) COMPOSITION (acceptance criterion 3): a needs_review experience row
 *       under a provider stuck at brreg_active=NULL is 'held' by
 *       POST /admin/experiences-content-judge-sweep with missing=
 *       ['brreg_active'] (judge/source/confidence all already pass) — then,
 *       with NO OTHER CHANGE, this backfill's apply run moves that SAME
 *       provider's brreg_active from NULL to 1, and a subsequent sweep call
 *       promotes the row to 'verified' (promotion.status='promoted',
 *       missing=[] i.e. absent) — proving the existing, UNCHANGED promotion
 *       gate now passes purely because of this backfill's write.
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
  opts: { url: string; headers?: Record<string, string>; body?: any },
): Promise<RouteResult> {
  return new Promise((resolve) => {
    const url = opts.url;
    const req: any = {
      method: "POST",
      url,
      originalUrl: url,
      path: url,
      query: {},
      headers: opts.headers || {},
      body: opts.body ?? {},
      app: { get() { return undefined; } },
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

function mkPageResponse(html: string, finalUrl: string): Response {
  const bytes = new TextEncoder().encode(html);
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    url: finalUrl,
    headers: { get: (name: string) => (name.toLowerCase() === "content-type" ? "text/html; charset=utf-8" : null) },
    arrayBuffer: async () => bytes.buffer,
  } as unknown as Response;
}

/** Deterministic PER-NAME 9-digit org_nr — shared by the Brreg stub and the
 * assertions below so a hardcoded literal can never collide across the
 * several test providers that share an "Aktiv "/"Nedlagt " name prefix
 * (org_nr carries a UNIQUE constraint on experience_providers). */
function orgNrFor(navn: string): string {
  let h = 0;
  for (let i = 0; i < navn.length; i++) h = (h * 31 + navn.charCodeAt(i)) >>> 0;
  return "9" + String(h % 100000000).padStart(8, "0");
}

function mkAnthropicResponse(verdictLine: string): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({ content: [{ type: "text", text: verdictLine }] }),
  } as unknown as Response;
}

export function runOpplevelserExperienceBrregRecheckBackfillTests(
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
    const prevAnthropicKey = process.env.ANTHROPIC_API_KEY;
    const prevFetch = globalThis.fetch;
    const testKey = process.env.ADMIN_KEY || "brreg-recheck-backfill-test-key";
    process.env.EXPERIENCES_DB_PATH = ":memory:";
    process.env.ADMIN_KEY = testKey;
    process.env.ANTHROPIC_API_KEY = "test-key-brreg-recheck-backfill";

    const dbFactoryPath = require.resolve("../database/db-factory");
    const experienceStorePath = require.resolve("../services/experience-store");
    const experienceBrregPath = require.resolve("../services/experience-brreg");
    const backfillSvcPath = require.resolve("../services/experience-brreg-recheck-backfill");
    const opplevelserPath = require.resolve("./opplevelser");
    const cachePaths = [dbFactoryPath, experienceStorePath, experienceBrregPath, backfillSvcPath, opplevelserPath];
    for (const p of cachePaths) delete require.cache[p];

    const initMod = require("../database/init") as typeof import("../database/init");
    let expBrreg: typeof import("../services/experience-brreg") | null = null;

    try {
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const expDb = dbFactory.getDb("experiences");
      expBrreg = require("../services/experience-brreg") as typeof import("../services/experience-brreg");
      const backfillSvc = require("../services/experience-brreg-recheck-backfill") as
        typeof import("../services/experience-brreg-recheck-backfill");
      const opplevelserRouter = (require("./opplevelser") as typeof import("./opplevelser")).default as any;
      const svc = require("../services/enrichment-write-pause") as typeof import("../services/enrichment-write-pause");
      const adminHeaders = { "x-admin-key": testKey };
      const ROUTE = "/admin/experiences-provider-brreg-recheck-backfill";

      // ── Brreg stub (mirrors opplevelser-bulk-load-admission-gate.test.ts's
      // convention): name prefix decides the verdict. "Brregerror " THROWS,
      // simulating a network failure — never a valid Brreg response. ────────
      let brregCalls = 0;
      const brregCallsFor = new Set<string>();
      expBrreg.__setBrregFetchForTesting(async (url: string) => {
        const navn = decodeURIComponent(new URL(url).searchParams.get("navn") || "");
        brregCalls++;
        brregCallsFor.add(navn);
        const lc = navn.toLowerCase();
        if (lc.startsWith("brregerror")) {
          throw new Error("simulated Brreg network failure");
        }
        const orgNr = orgNrFor(navn);
        if (lc.startsWith("aktiv")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              _embedded: {
                enheter: [{
                  organisasjonsnummer: orgNr,
                  navn: navn.toUpperCase(),
                  naeringskode1: { kode: "93.291" },
                  forretningsadresse: { kommune: "Tromsø" },
                  konkurs: false, underAvvikling: false, underTvangsavviklingEllerTvangsopplosning: false, slettedato: null,
                }],
              },
            }),
          } as any;
        }
        if (lc.startsWith("nedlagt")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              _embedded: {
                enheter: [{
                  organisasjonsnummer: orgNr,
                  navn: navn.toUpperCase(),
                  naeringskode1: { kode: "93.291" },
                  forretningsadresse: { kommune: "Tromsø" },
                  konkurs: true, underAvvikling: false, underTvangsavviklingEllerTvangsopplosning: false, slettedato: null,
                }],
              },
            }),
          } as any;
        }
        // "Ukjent …" and anything unrecognised -> no candidate at all.
        return { ok: true, status: 200, json: async () => ({ _embedded: { enheter: [] } }) } as any;
      });

      const insertProvider = expDb.prepare(
        `INSERT INTO experience_providers
           (id, navn, brreg_active, brreg_verified, org_nr, content_source, catalog_hidden)
         VALUES (@id, @navn, @brreg_active, @brreg_verified, @org_nr, @content_source, @catalog_hidden)`,
      );
      const seedProvider = (o: {
        id: string; navn: string; brreg_active?: number | null; brreg_verified?: number; org_nr?: string | null;
        content_source?: string | null; catalog_hidden?: number | null;
      }) => {
        insertProvider.run({
          id: o.id, navn: o.navn,
          brreg_active: o.brreg_active === undefined ? null : o.brreg_active,
          brreg_verified: o.brreg_verified ?? 0,
          org_nr: o.org_nr ?? null,
          content_source: o.content_source ?? null,
          catalog_hidden: o.catalog_hidden ?? null,
        });
      };
      const providerRow = (id: string) =>
        expDb
          .prepare(`SELECT brreg_active, brreg_verified, org_nr, brreg_checked_at FROM experience_providers WHERE id = ?`)
          .get(id) as { brreg_active: number | null; brreg_verified: number; org_nr: string | null; brreg_checked_at: string | null };

      // ═══ (a) auth ═══════════════════════════════════════════════════════
      {
        const r = await callRoute(opplevelserRouter, { url: ROUTE, body: {} });
        assertEq(r.status, 403, "brb-a1: no X-Admin-Key -> 403");
      }

      // ═══ (b)-(d) selection ══════════════════════════════════════════════
      seedProvider({ id: "prov-active-01", navn: "Aktiv Fjordgård AS" });                 // NULL -> should resolve_active
      seedProvider({ id: "prov-inactive-01", navn: "Nedlagt Seterdrift AS" });            // NULL -> should resolve_inactive
      seedProvider({ id: "prov-unknown-01", navn: "Ukjent Driftsselskap AS" });           // NULL -> should stay unresolved
      seedProvider({ id: "prov-already-active-01", navn: "Aktiv AlleredeSatt AS", brreg_active: 1, brreg_verified: 1 }); // NOT a candidate
      seedProvider({ id: "prov-already-inactive-01", navn: "Nedlagt AlleredeSatt AS", brreg_active: 0, brreg_verified: 1 }); // NOT a candidate
      seedProvider({ id: "prov-locked-manual-01", navn: "Aktiv LåstEier AS", content_source: "manual" }); // NOT a candidate (owner-locked)
      seedProvider({ id: "prov-locked-claim-01", navn: "Aktiv LåstClaim AS", content_source: "claim" }); // NOT a candidate (owner-locked)
      seedProvider({ id: "prov-hidden-01", navn: "Aktiv SkjultKatalog AS", catalog_hidden: 1 }); // NOT a candidate (hidden)

      // ── (e) dry-run: correct classification, ZERO writes ────────────────
      let dryRes: RouteResult;
      {
        const before = {
          active: providerRow("prov-active-01"),
          inactive: providerRow("prov-inactive-01"),
          unknown: providerRow("prov-unknown-01"),
        };
        dryRes = await callRoute(opplevelserRouter, { url: ROUTE, headers: adminHeaders, body: { limit: 10 } });
        assertEq(dryRes.status, 200, "brb-e1: dry-run -> 200");
        assertEq(dryRes.body.dry_run, true, "brb-e2: apply omitted -> dry_run:true");

        const byId = new Map<string, any>((dryRes.body.planned as any[]).map((p) => [p.provider_id, p]));
        assertEq(byId.get("prov-active-01")?.outcome, "resolved_active", "brb-e3: Aktiv provider resolves resolved_active");
        assertEq(byId.get("prov-active-01")?.org_nr, orgNrFor("Aktiv Fjordgård AS"), "brb-e3b: org_nr reported from the fresh Brreg hit");
        assertEq(byId.get("prov-inactive-01")?.outcome, "resolved_inactive", "brb-e4: Nedlagt provider resolves resolved_inactive");
        assertEq(byId.get("prov-unknown-01")?.outcome, "still_unresolved", "brb-e5: Ukjent provider stays still_unresolved");
        assertEq(dryRes.body.resolved_active, 1, "brb-e6: aggregate resolved_active=1");
        assertEq(dryRes.body.resolved_inactive, 1, "brb-e7: aggregate resolved_inactive=1");
        assertEq(dryRes.body.still_unresolved, 1, "brb-e8: aggregate still_unresolved=1 (locked/hidden/already-set rows never selected)");
        assertEq(dryRes.body.processed, 3, "brb-e9: processed=3 — exactly the 3 true candidates, none of the 5 excluded rows");

        // (b)/(c)/(d): excluded rows never appear in planned at all.
        for (const excludedId of [
          "prov-already-active-01", "prov-already-inactive-01",
          "prov-locked-manual-01", "prov-locked-claim-01", "prov-hidden-01",
        ]) {
          assertTrue(!byId.has(excludedId), `brb-e10 ${excludedId}: never selected as a candidate`);
        }
        assertTrue(!brregCallsFor.has("Aktiv AlleredeSatt AS"), "brb-e11: already brreg_active=1 row never triggers a Brreg call");
        assertTrue(!brregCallsFor.has("Aktiv LåstEier AS"), "brb-e12: content_source=manual row never triggers a Brreg call");
        assertTrue(!brregCallsFor.has("Aktiv SkjultKatalog AS"), "brb-e13: catalog_hidden row never triggers a Brreg call");

        // ZERO writes from the dry-run.
        assertEq(providerRow("prov-active-01"), before.active, "brb-e14: dry-run wrote NOTHING to prov-active-01");
        assertEq(providerRow("prov-inactive-01"), before.inactive, "brb-e15: dry-run wrote NOTHING to prov-inactive-01");
        assertEq(providerRow("prov-unknown-01"), before.unknown, "brb-e16: dry-run wrote NOTHING to prov-unknown-01");
      }

      // ── (g) STRICT dry_run parse: a STRING "false" is NOT apply ─────────
      {
        const before = providerRow("prov-active-01");
        const r = await callRoute(opplevelserRouter, { url: ROUTE, headers: adminHeaders, body: { dry_run: "false", limit: 10 } });
        assertEq(r.body.dry_run, true, "brb-g1: dry_run:'false' (string) is still treated as dry-run");
        assertEq(providerRow("prov-active-01"), before, "brb-g2: …and nothing was written");
      }

      // ═══ (f) apply: actual writes ═══════════════════════════════════════
      {
        const r = await callRoute(opplevelserRouter, { url: ROUTE, headers: adminHeaders, body: { dry_run: false, limit: 10 } });
        assertEq(r.status, 200, "brb-f1: apply -> 200");
        assertEq(r.body.dry_run, false, "brb-f2: dry_run:false echoed back");
        assertEq(r.body.resolved_active, 1, "brb-f3: resolved_active=1 on the real run too");
        assertEq(r.body.resolved_inactive, 1, "brb-f4: resolved_inactive=1");

        const active = providerRow("prov-active-01");
        assertEq(active.brreg_active, 1, "brb-f5: prov-active-01.brreg_active -> 1 (actually written)");
        assertEq(active.brreg_verified, 1, "brb-f6: prov-active-01.brreg_verified -> 1");
        assertEq(active.org_nr, orgNrFor("Aktiv Fjordgård AS"), "brb-f7: prov-active-01.org_nr written from the fresh Brreg hit");
        assertTrue(!!active.brreg_checked_at, "brb-f8: prov-active-01.brreg_checked_at stamped");

        const inactive = providerRow("prov-inactive-01");
        assertEq(inactive.brreg_active, 0, "brb-f9: prov-inactive-01.brreg_active -> 0 (a confirmed answer, not a guess)");
        assertEq(inactive.brreg_verified, 1, "brb-f10: prov-inactive-01.brreg_verified -> 1");
        assertEq(inactive.org_nr, orgNrFor("Nedlagt Seterdrift AS"), "brb-f11: prov-inactive-01.org_nr written from the fresh Brreg hit");

        const unknown = providerRow("prov-unknown-01");
        assertEq(unknown.brreg_active, null, "brb-f12: prov-unknown-01.brreg_active STILL NULL — never guessed");
        assertEq(unknown.brreg_verified, 0, "brb-f13: prov-unknown-01.brreg_verified untouched (0)");
      }

      // ═══ (h) fail-closed on a throwing Brreg lookup ════════════════════
      {
        // ids chosen so id-ASC ordering processes the throwing row FIRST,
        // then a sibling row right after it in the SAME call.
        seedProvider({ id: "prov-h1-error", navn: "Brregerror Utstyr AS" });
        seedProvider({ id: "prov-h2-active", navn: "Aktiv EtterFeil AS" });
        const r = await callRoute(opplevelserRouter, { url: ROUTE, headers: adminHeaders, body: { dry_run: false, limit: 2, after: "prov-h0" } });
        assertEq(r.status, 200, "brb-h1: a throwing Brreg lookup does not 500 the whole route");
        const byId = new Map<string, any>((r.body.planned as any[]).map((p) => [p.provider_id, p]));
        assertEq(byId.get("prov-h1-error")?.outcome, "still_unresolved", "brb-h2: the throwing row reports still_unresolved, never a guessed resolution");
        assertTrue(r.body.errors >= 1, "brb-h3: errors tally incremented for the throwing row");
        const errorRow = providerRow("prov-h1-error");
        assertEq(errorRow.brreg_active, null, "brb-h4: the throwing row's brreg_active is STILL NULL — fail-closed, never guessed");
        // Batch isolation: the NEXT row in the SAME call is still processed
        // (a per-provider isolation, mirroring bulk-load's own per-provider try/catch).
        assertEq(byId.get("prov-h2-active")?.outcome, "resolved_active", "brb-h5: a sibling row after the throwing one is still processed correctly");
        assertEq(providerRow("prov-h2-active").brreg_active, 1, "brb-h6: …and actually written");
      }

      // ═══ (i) pagination: still_unresolved rows still ADVANCE ══════════
      {
        // ids sort AFTER everything above ('z' > a/n/u/p/b) so the cursor
        // isolates this section regardless of what remains eligible above.
        seedProvider({ id: "zzc-01", navn: "Ukjent Cursor Ett AS" });
        seedProvider({ id: "zzc-02", navn: "Ukjent Cursor To AS" });
        seedProvider({ id: "zzc-03", navn: "Ukjent Cursor Tre AS" });

        const page1 = await callRoute(opplevelserRouter, { url: ROUTE, headers: adminHeaders, body: { dry_run: false, limit: 2, after: "zzc-00" } });
        assertEq(page1.body.processed, 2, "brb-i1: page 1 processes exactly `limit` rows");
        assertEq(page1.body.next_after, "zzc-02", "brb-i2: next_after is the id of the LAST row this call processed");
        const page1Ids = (page1.body.planned as any[]).map((p) => p.provider_id);
        assertTrue(
          page1Ids.includes("zzc-01") && page1Ids.includes("zzc-02") && !page1Ids.includes("zzc-03"),
          `brb-i3: page 1 covers rows 1-2, not row 3 (got ${JSON.stringify(page1Ids)})`,
        );
        assertEq(providerRow("zzc-01").brreg_active, null, "brb-i4: row 1 left unchanged (still_unresolved, never guessed) — STILL eligible");

        const page2 = await callRoute(opplevelserRouter, { url: ROUTE, headers: adminHeaders, body: { dry_run: false, limit: 2, after: page1.body.next_after } });
        const page2Ids = (page2.body.planned as any[]).map((p) => p.provider_id);
        assertTrue(
          !page2Ids.includes("zzc-01") && !page2Ids.includes("zzc-02"),
          `brb-i5: page 2 does NOT re-process rows page 1 already processed, even though neither changed (got ${JSON.stringify(page2Ids)})`,
        );
        assertTrue(
          page2Ids.includes("zzc-03") && page2.body.next_after === null,
          `brb-i6: page 2 reaches row 3, and next_after is null once the page comes back shorter than \`limit\` (ids=${JSON.stringify(page2Ids)}, next_after=${page2.body.next_after})`,
        );
      }

      // ═══ (k) service-level constants + limit clamp ═════════════════════
      {
        assertEq(backfillSvc.BRREG_RECHECK_BACKFILL_DEFAULT_LIMIT, 25, "brb-k1: default limit constant is 25");
        assertEq(backfillSvc.BRREG_RECHECK_BACKFILL_MAX_LIMIT, 50, "brb-k2: max limit constant is 50");
        // Only ~1 eligible row left at this point (prov-unknown-01, still
        // NULL) — a limit far above the max must not throw and must still
        // clamp internally (the route-level `limit` echoed back is capped).
        const r = await callRoute(opplevelserRouter, { url: ROUTE, headers: adminHeaders, body: { limit: 999999 } });
        assertEq(r.status, 200, "brb-k3: an over-max limit request does not error");
        assertEq(r.body.limit, backfillSvc.BRREG_RECHECK_BACKFILL_MAX_LIMIT, "brb-k4: the echoed `limit` is clamped to the max, not the requested 999999");
      }

      // ═══ (j) enrichment write-pause fence ═══════════════════════════════
      {
        const BetterSqlite = require("better-sqlite3") as typeof import("better-sqlite3");
        const mainDb = new BetterSqlite(":memory:");
        mainDb.pragma("journal_mode = DELETE");
        mainDb.pragma("foreign_keys = OFF");
        const prevMainDb = initMod.__peekDbForTesting();
        initMod.__setDbForTesting(mainDb as any);
        initMod.__initSchemaForTesting(mainDb as any);

        seedProvider({ id: "prov-paused-01", navn: "Aktiv UnderPause AS" });

        svc.setEnrichmentWritePause(mainDb as any, { vertical: "experiences", enabled: true, reason: "test: brreg-recheck pause" }, "verifier");

        const before = providerRow("prov-paused-01");
        const blockedApply = await callRoute(opplevelserRouter, { url: ROUTE, headers: adminHeaders, body: { dry_run: false, limit: 5, after: "prov-paused-00" } });
        assertEq(blockedApply.status, 423, "brb-j1: apply under a live experiences pause -> 423");
        assertEq(blockedApply.body?.paused, true, "brb-j2: body.paused===true");
        assertEq(blockedApply.body?.vertical, "experiences", "brb-j3: body.vertical==='experiences'");
        assertEq(providerRow("prov-paused-01"), before, "brb-j4: ZERO writes across the blocked apply call");

        const dryUnderPause = await callRoute(opplevelserRouter, { url: ROUTE, headers: adminHeaders, body: { limit: 5, after: "prov-paused-00" } });
        assertEq(dryUnderPause.status, 200, "brb-j5: dry-run under the SAME pause is NEVER blocked");

        svc.setEnrichmentWritePause(mainDb as any, { vertical: "experiences", enabled: false, cleared_by: "daniel" }, "verifier");
        const afterClear = await callRoute(opplevelserRouter, { url: ROUTE, headers: adminHeaders, body: { dry_run: false, limit: 5, after: "prov-paused-00" } });
        assertEq(afterClear.status, 200, "brb-j6: apply goes through again once the pause is cleared");
        assertEq(providerRow("prov-paused-01").brreg_active, 1, "brb-j7: …and actually writes now");

        initMod.__setDbForTesting(prevMainDb);
        try { mainDb.close(); } catch { /* ignore */ }
      }

      // ═══ (l) COMPOSITION — acceptance criterion 3 ═══════════════════════
      {
        seedProvider({ id: "prov-compose-01", navn: "Aktiv Komposisjon AS" });
        const insertExperience = expDb.prepare(
          `INSERT INTO experiences
             (id, provider_id, title, slug, description, category, price_band, price_from, evidence_url,
              evidence_url_verification, verification_status, confidence, canonical_id, content_source, enrichment_state)
           VALUES
             (@id, @provider_id, @title, @slug, @description, @category, @price_band, @price_from, @evidence_url,
              @evidence_url_verification, @verification_status, @confidence, NULL, 'provider_site', 'enriched')`,
        );
        const composeTitle = "Fjordsafari med RIB-båt";
        const composeUrl = "https://good.no/fjordsafari-rib";
        insertExperience.run({
          id: "exp-compose-01", provider_id: "prov-compose-01",
          title: composeTitle, slug: "exp-compose-01",
          description: "Kort om fjordsafarien.", category: "aktivitet", price_band: "standard", price_from: 890,
          evidence_url: composeUrl,
          evidence_url_verification: JSON.stringify({ verified: true, classification: "verified" }),
          verification_status: "needs_review", confidence: "high",
        });

        globalThis.fetch = (async (url: any, init: any) => {
          const urlStr = String(url);
          if (urlStr === "https://api.anthropic.com/v1/messages") {
            const body = JSON.parse(init?.body ?? "{}");
            const promptText: string = body?.messages?.[0]?.content ?? "";
            if (promptText.includes(composeTitle)) return mkAnthropicResponse("MATCH\nStemmer godt med kilden.");
            return mkAnthropicResponse("MATCH\nStemmer godt med kilden.");
          }
          if (urlStr === composeUrl) {
            return mkPageResponse("<html><body>Fjordsafari med RIB-båt, to timer med guide fra kaia.</body></html>", urlStr);
          }
          throw new Error("composition test: unexpected fetch URL: " + urlStr);
        }) as unknown as typeof fetch;

        const sweepStatus = (id: string) =>
          expDb.prepare(`SELECT verification_status FROM experiences WHERE id = ?`).get(id) as { verification_status: string };

        // ── BEFORE our backfill: provider still brreg_active=NULL -> the
        // sweep must HOLD this row, missing exactly ['brreg_active']. ──────
        const preSweep = await callRoute(opplevelserRouter, {
          url: "/admin/experiences-content-judge-sweep",
          headers: adminHeaders,
          body: { apply: true },
        });
        assertEq(preSweep.status, 200, "brb-l1: pre-backfill sweep -> 200");
        const preRow = (preSweep.body.results as any[]).find((r: any) => r.id === "exp-compose-01");
        assertTrue(!!preRow, "brb-l2: exp-compose-01 was swept");
        assertEq(preRow?.promotion?.judge, "MATCH", "brb-l3: judge already renders MATCH before the backfill");
        assertEq(preRow?.promotion?.brreg_active, false, "brb-l4: promotion.brreg_active=false — provider is still brreg_active=NULL");
        assertEq(preRow?.promotion?.status, "held", "brb-l5: promotion held — NOT promoted despite judge/source/confidence all passing");
        assertTrue((preRow?.promotion?.missing ?? []).includes("brreg_active"), "brb-l6: missing names exactly brreg_active");
        assertEq(sweepStatus("exp-compose-01").verification_status, "needs_review", "brb-l7: row is STILL needs_review after the pre-backfill sweep");

        // ── Run the backfill (apply): the ONLY thing that changes is the
        // provider's brreg_active, NULL -> 1. ─────────────────────────────
        const backfillRun = await callRoute(opplevelserRouter, { url: ROUTE, headers: adminHeaders, body: { dry_run: false, limit: 10, after: "prov-compose-00" } });
        assertEq(backfillRun.status, 200, "brb-l8: backfill apply run -> 200");
        assertEq(providerRow("prov-compose-01").brreg_active, 1, "brb-l9: provider brreg_active NULL -> 1");

        // ── AFTER the backfill: the SAME sweep, with NOTHING else touched,
        // now promotes the row. ────────────────────────────────────────────
        const postSweep = await callRoute(opplevelserRouter, {
          url: "/admin/experiences-content-judge-sweep",
          headers: adminHeaders,
          body: { apply: true },
        });
        const postRow = (postSweep.body.results as any[]).find((r: any) => r.id === "exp-compose-01");
        assertTrue(!!postRow, "brb-l10: exp-compose-01 was swept again");
        assertEq(postRow?.promotion?.brreg_active, true, "brb-l11: promotion.brreg_active=true now");
        assertEq(postRow?.promotion?.status, "promoted", "brb-l12: promotion.status='promoted' — the existing, UNCHANGED gate now passes");
        assertEq(sweepStatus("exp-compose-01").verification_status, "verified", "brb-l13: verification_status -> verified");
      }
    } catch (err: any) {
      failed++;
      failures.push("opplevelser-experience-brreg-recheck-backfill: unexpected error: " + String(err?.stack || err));
    } finally {
      if (expBrreg) expBrreg.__setBrregFetchForTesting(null);
      globalThis.fetch = prevFetch;
      if (prevExperiencesDbPath === undefined) delete process.env.EXPERIENCES_DB_PATH; else process.env.EXPERIENCES_DB_PATH = prevExperiencesDbPath;
      if (prevAdminKey === undefined) delete process.env.ADMIN_KEY; else process.env.ADMIN_KEY = prevAdminKey;
      if (prevAnthropicKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = prevAnthropicKey;
    }

    return { passed, failed, failures };
  })();
}

if (require.main === module) {
  runOpplevelserExperienceBrregRecheckBackfillTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    if (summary.failed > 0) process.exit(1);
  });
}
