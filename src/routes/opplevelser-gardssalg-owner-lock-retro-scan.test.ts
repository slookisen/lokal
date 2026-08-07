/**
 * opplevelser-gardssalg-owner-lock-retro-scan.test.ts — unit tests for
 * sub-slice 3j of dev-request 2026-07-30-opplevagent-claim-epost-og-perfelt-
 * laas.
 *
 * Sub-slice 3i wired the already-shipped, already-reviewed per-field
 * owner-lock helper (`isGardssalgFieldOwnerLocked`, PR #472/#478) through the
 * THREE row-level bail points `applyGardssalgProviderContent()` / `POST
 * /admin/gardssalg-content-refresh` used to have for `content_source='claim'`
 * rows. This sub-slice reproduces the SAME shape of change for the
 * structurally similar retroactive-null site: `applyGardssalgRetroScanNull`
 * / `POST /admin/gardssalg-retro-scan`:
 *
 *   1. `selectGardssalgProvidersForRetroScan`'s SQL WHERE clause — now only
 *      excludes 'manual', not 'claim' (and selects `field_provenance`, same
 *      for `getGardssalgProviderRetroScanTarget`).
 *   2. The route's early LOCK check (`processOne`) — now only short-circuits
 *      for 'manual'; a 'claim' row proceeds to fetch/judge as normal.
 *   3. `applyGardssalgRetroScanNull` itself — 'manual' still bails the whole
 *      row (unchanged); 'claim' now gates each requested field individually
 *      via `isGardssalgFieldOwnerLocked(row, fieldName)` inside its null
 *      loop.
 *
 * Also covers the additive `owner_field_locked` response bucket (distinct
 * from `skipped_locked`, which keeps its pre-existing "manual row, full
 * skip, never fetched" meaning).
 *
 * Same conventions as opplevelser-gardssalg-owner-lock-content-refresh.test.ts
 * and opplevelser-gardssalg-retro-scan.test.ts: EXPERIENCES_DB_PATH=":memory:",
 * fresh require of db-factory + experience-store + opplevelser router,
 * router.handle() exercised directly (no real HTTP server), globalThis.fetch
 * mocked (homepage fetch + judge) since the sandbox has no network access.
 * Fixtures use deliberately SHORT (<80 char) about_text/visit_text values so
 * meetsAboutCheapBar fails them deterministically — no LLM judge call is
 * needed to flag them for nulling, keeping the fixtures independent of judge
 * calibration (that's opplevelser-gardssalg-quality-judge.test.ts's concern).
 *
 * Covers (mirroring 3i's own AC list, adapted to nulling instead of writing):
 *   1. claim row, owner_locks.about_text set but NOT visit_text, BOTH fields
 *      flagged for nulling -> about_text stays unchanged (locked, skipped),
 *      visit_text gets nulled. Proven in BOTH dry-run (preview shows only
 *      visit_text) and apply (DB read-back) modes.
 *   2. manual row flagged for both fields -> never fetched at all, still
 *      lands in skipped_locked, not owner_field_locked (negative control).
 *   3. claim row with NO owner_locks at all, flagged for nulling -> both
 *      fields null exactly as an unclaimed row would (negative control).
 *   4. claim row where EVERY flagged field is owner-locked -> nothing
 *      nulled, appears in owner_field_locked naming the row + its locked
 *      fields, NOT in skipped_locked. Proven in BOTH dry-run and apply.
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
    const url = opts.url || "/admin/gardssalg-retro-scan";
    const req: any = {
      method,
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

export function runOpplevelserGardssalgOwnerLockRetroScanTests(
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
    const testKey = process.env.ADMIN_KEY || "gardssalg-owner-lock-rs-test-key";
    process.env.EXPERIENCES_DB_PATH = ":memory:";
    process.env.ADMIN_KEY = testKey;
    process.env.ANTHROPIC_API_KEY = "test-anthropic-key-owner-lock-rs";

    const dbFactoryPath = require.resolve("../database/db-factory");
    const experienceStorePath = require.resolve("../services/experience-store");
    const opplevelserPath = require.resolve("./opplevelser");
    const cachePaths = [dbFactoryPath, experienceStorePath, opplevelserPath];
    for (const p of cachePaths) delete require.cache[p];

    try {
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const expDb = dbFactory.getDb("experiences");

      const store = require("../services/experience-store") as typeof import("../services/experience-store");
      const opplevelserRouter = (require("./opplevelser") as typeof import("./opplevelser")).default as any;

      // opening_hours_text/products are pre-filled (non-blank) on every
      // fixture — the retro-scan route itself doesn't consult them, but
      // keeping them non-blank avoids any accidental interference with other
      // gårdssalg auto-select queries sharing this same in-memory DB.
      const insertProviderStmt = expDb.prepare(
        `INSERT INTO experience_providers
           (id, navn, vertical, hjemmeside, content_source, about_text, visit_text, opening_hours_text, products, field_provenance,
            producer_type, enrichment_state, verification_status, source, confidence, catalog_hidden)
         VALUES
           (@id, @navn, 'experiences', @hjemmeside, @content_source, @about_text, @visit_text, 'Man-fre 10-16', '["Placeholder"]', @field_provenance,
            'bryggeri', 'raw', 'pending_verify', 'test-fixture', 'medium', 0)`,
      );

      function provenance(extra?: Record<string, unknown>): string {
        return JSON.stringify({ ...extra });
      }

      function getProviderRow(id: string): any {
        return expDb.prepare(
          `SELECT id, about_text, visit_text, content_source, field_provenance
             FROM experience_providers WHERE id = ?`
        ).get(id);
      }
      function getAuditRows(providerId: string): any[] {
        return expDb.prepare(
          `SELECT * FROM gardssalg_content_audit WHERE provider_id = ? ORDER BY rowid ASC`
        ).all(providerId);
      }

      // Deliberately SHORT (<80 chars) — meetsAboutCheapBar fails these
      // deterministically, no LLM judge call needed to flag them for
      // nulling. Distinct strings per fixture so a DB read-back can tell
      // them apart.
      const OL_RS_ABOUT = "Kort om-tekst.";
      const OL_RS_VISIT = "Kort besok-tekst.";
      assertTrue(OL_RS_ABOUT.length < 80, "sanity: OL_RS_ABOUT is under the 80-char cheap-bar floor");
      assertTrue(OL_RS_VISIT.length < 80, "sanity: OL_RS_VISIT is under the 80-char cheap-bar floor");

      // ── Fixtures ──────────────────────────────────────────────────────
      // olrs-1: claim row, owner_locks.about_text present, owner_locks.
      // visit_text ABSENT. Both fields short (flagged for nulling by the
      // cheap bar) -> about_text should stay locked, visit_text nulled.
      insertProviderStmt.run({
        id: "olrs-1", navn: "Olrs1 Sideri", hjemmeside: "https://olrs1.example.no",
        content_source: "claim", about_text: OL_RS_ABOUT, visit_text: OL_RS_VISIT,
        field_provenance: provenance({ owner_locks: { about_text: { locked_at: "2026-08-01T00:00:00.000Z" } } }),
      });

      // olrs-2: manual row — negative control, must never reach the fetch
      // stage at all.
      insertProviderStmt.run({
        id: "olrs-2", navn: "Olrs2 Manuell Gard", hjemmeside: "https://olrs2.example.no",
        content_source: "manual", about_text: OL_RS_ABOUT, visit_text: OL_RS_VISIT,
        field_provenance: provenance(),
      });

      // olrs-3: claim row, NO owner_locks at all — critical negative
      // control: must behave exactly like an unlocked/enrichment-derived
      // row (both flagged fields nulled).
      insertProviderStmt.run({
        id: "olrs-3", navn: "Olrs3 Bryggeri", hjemmeside: "https://olrs3.example.no",
        content_source: "claim", about_text: OL_RS_ABOUT, visit_text: OL_RS_VISIT,
        field_provenance: provenance(),
      });

      // olrs-4: claim row, EVERY flagged field (about_text + visit_text)
      // owner-locked -> nothing nulled, owner_field_locked names both
      // fields.
      insertProviderStmt.run({
        id: "olrs-4", navn: "Olrs4 Gardsbutikk", hjemmeside: "https://olrs4.example.no",
        content_source: "claim", about_text: OL_RS_ABOUT, visit_text: OL_RS_VISIT,
        field_provenance: provenance({
          owner_locks: {
            about_text: { locked_at: "2026-08-01T00:00:00.000Z" },
            visit_text: { locked_at: "2026-08-01T00:00:00.000Z" },
          },
        }),
      });

      // ── Fetch mock ────────────────────────────────────────────────────
      // The judge is never expected to be called in this file (every
      // fixture's about_text/visit_text fails the deterministic cheap bar),
      // but the Anthropic branch is still wired defensively in case a
      // future edit changes that.
      const fetchedHosts: string[] = [];
      let anthropicCallCount = 0;
      globalThis.fetch = (async (url: string | URL | Request) => {
        const urlStr = String(url);
        if (urlStr.includes("api.anthropic.com")) {
          anthropicCallCount++;
          return {
            ok: true,
            status: 200,
            json: async () => ({ content: [{ type: "text", text: "AVVIS\nFor kort til a vaere ekte prosa." }] }),
          } as unknown as Response;
        }
        const host = new URL(urlStr).hostname;
        fetchedHosts.push(host);
        const placeholderHtml = "<html><body><p>Placeholder homepage content.</p></body></html>";
        return {
          ok: true, status: 200, text: async () => placeholderHtml,
          arrayBuffer: async () => new TextEncoder().encode(placeholderHtml).buffer,
          headers: { get: () => null },
        } as unknown as Response;
      }) as typeof fetch;

      // ═══════════════════════════════════════════════════════════════════
      // (1) claim row, about_text locked / visit_text unlocked, BOTH flagged
      //     for nulling -> about_text stays untouched, visit_text nulled.
      //     Proven in BOTH dry-run and apply.
      // ═══════════════════════════════════════════════════════════════════
      {
        const dry = await callRoute(opplevelserRouter, {
          headers: { "x-admin-key": testKey },
          body: { providerIds: ["olrs-1"], apply: false },
        });
        assertEq(dry.status, 200, "olrs1-1: dry-run call -> 200");
        assertTrue(!dry.body.skipped_locked.includes("olrs-1"), "olrs1-2: NOT in skipped_locked — a claim row with a flagged field proceeds past the row-level check");
        const dryEntry = dry.body.changed.find((c: any) => c.provider_id === "olrs-1");
        assertTrue(!!dryEntry, "olrs1-3: dry-run — olrs-1 appears in changed[]");
        assertEq(dryEntry.fields, ["visit_text"], "olrs1-4: dry-run — only visit_text is previewed, about_text (locked) is excluded");
        assertTrue(!("about_text" in dryEntry.reasons), "olrs1-5: dry-run — about_text is not in the reasons map either");
        assertTrue(!dry.body.owner_field_locked.some((e: any) => e.provider_id === "olrs-1"), "olrs1-6: dry-run — NOT in owner_field_locked (only a partial lock, not a full one)");
        const rowAfterDry = getProviderRow("olrs-1");
        assertEq(rowAfterDry.about_text, OL_RS_ABOUT, "olrs1-7: dry-run performed ZERO writes — about_text unchanged");
        assertEq(rowAfterDry.visit_text, OL_RS_VISIT, "olrs1-8: dry-run performed ZERO writes — visit_text unchanged");

        const apply = await callRoute(opplevelserRouter, {
          headers: { "x-admin-key": testKey },
          body: { providerIds: ["olrs-1"], apply: true },
        });
        assertEq(apply.status, 200, "olrs1-9: apply call -> 200");
        const applyEntry = apply.body.changed.find((c: any) => c.provider_id === "olrs-1");
        assertTrue(!!applyEntry, "olrs1-10: apply — olrs-1 appears in changed[]");
        assertEq(applyEntry.fields, ["visit_text"], "olrs1-11: apply — only visit_text is reported nulled");
        assertTrue(!apply.body.owner_field_locked.some((e: any) => e.provider_id === "olrs-1"), "olrs1-12: apply — NOT in owner_field_locked (partial lock)");
        const rowAfterApply = getProviderRow("olrs-1");
        assertEq(rowAfterApply.about_text, OL_RS_ABOUT, "olrs1-13: apply — about_text stays UNCHANGED (owner-locked field was never nulled)");
        assertEq(rowAfterApply.visit_text, null, "olrs1-14: apply — visit_text WAS nulled (unlocked sibling field proceeds normally)");
        const auditRows = getAuditRows("olrs-1");
        assertTrue(auditRows.some((r: any) => r.field_name === "visit_text"), "olrs1-15: apply — an audit row exists for the nulled visit_text");
        assertTrue(!auditRows.some((r: any) => r.field_name === "about_text"), "olrs1-16: apply — NO audit row for the locked about_text (never touched)");
      }

      // ═══════════════════════════════════════════════════════════════════
      // (2) manual row — completely unchanged: route never fetches,
      //     skipped_locked still fires, zero fields ever considered.
      // ═══════════════════════════════════════════════════════════════════
      {
        const fetchedBefore = fetchedHosts.length;
        const r = await callRoute(opplevelserRouter, {
          headers: { "x-admin-key": testKey },
          body: { providerIds: ["olrs-2"], apply: true },
        });
        assertEq(r.status, 200, "olrs2-1: apply call -> 200");
        assertTrue(r.body.skipped_locked.includes("olrs-2"), "olrs2-2: manual row still reported in skipped_locked");
        assertEq(fetchedHosts.length, fetchedBefore, "olrs2-3: no fetch happened for the manual row — the lock check short-circuits BEFORE any network call");
        assertTrue(!r.body.changed.some((c: any) => c.provider_id === "olrs-2"), "olrs2-4: manual row never appears in changed[]");
        assertTrue(!r.body.owner_field_locked.some((e: any) => e.provider_id === "olrs-2"), "olrs2-5: manual row never appears in owner_field_locked (that bucket is claim-only)");
        const rowAfter = getProviderRow("olrs-2");
        assertEq(rowAfter.about_text, OL_RS_ABOUT, "olrs2-6: manual row's about_text is completely untouched");
        assertEq(rowAfter.visit_text, OL_RS_VISIT, "olrs2-7: manual row's visit_text is completely untouched");
        assertEq(getAuditRows("olrs-2").length, 0, "olrs2-8: no audit rows for the manual row");
      }

      // ═══════════════════════════════════════════════════════════════════
      // (3) claim row, NO owner_locks at all -> behaves exactly like an
      //     unclaimed/enrichment-derived row: BOTH flagged fields nulled.
      //     Critical regression/negative control.
      // ═══════════════════════════════════════════════════════════════════
      {
        const r = await callRoute(opplevelserRouter, {
          headers: { "x-admin-key": testKey },
          body: { providerIds: ["olrs-3"], apply: true },
        });
        assertEq(r.status, 200, "olrs3-1: apply call -> 200");
        assertTrue(!r.body.skipped_locked.includes("olrs-3"), "olrs3-2: NOT in skipped_locked");
        const entry = r.body.changed.find((c: any) => c.provider_id === "olrs-3");
        assertTrue(!!entry, "olrs3-3: olrs-3 appears in changed[]");
        assertEq(entry.fields.slice().sort(), ["about_text", "visit_text"], "olrs3-4: BOTH flagged fields nulled — no owner_locks means nothing is locked");
        assertTrue(!r.body.owner_field_locked.some((e: any) => e.provider_id === "olrs-3"), "olrs3-5: NOT in owner_field_locked");
        const rowAfter = getProviderRow("olrs-3");
        assertEq(rowAfter.about_text, null, "olrs3-6: about_text actually nulled in the DB");
        assertEq(rowAfter.visit_text, null, "olrs3-7: visit_text actually nulled in the DB");
      }

      // ═══════════════════════════════════════════════════════════════════
      // (4) claim row, EVERY flagged field owner-locked -> nothing nulled,
      //     owner_field_locked names the row + its locked fields, NOT in
      //     skipped_locked. Proven in BOTH dry-run and apply — dry-run
      //     never calls applyGardssalgRetroScanNull, so the route must
      //     predict the same per-field outcome independently.
      // ═══════════════════════════════════════════════════════════════════
      {
        const dry = await callRoute(opplevelserRouter, {
          headers: { "x-admin-key": testKey },
          body: { providerIds: ["olrs-4"], apply: false },
        });
        assertEq(dry.status, 200, "olrs4-1: dry-run call -> 200");
        assertEq(dry.body.dry_run, true, "olrs4-2: dry_run:true");
        assertTrue(!dry.body.changed.some((c: any) => c.provider_id === "olrs-4"), "olrs4-3: dry-run — olrs-4 does NOT appear in changed[] (nothing would actually be nulled)");
        const dryLockedEntry = dry.body.owner_field_locked.find((e: any) => e.provider_id === "olrs-4");
        assertTrue(!!dryLockedEntry, "olrs4-4: dry-run — olrs-4 appears in owner_field_locked");
        assertEq(dryLockedEntry.fields.slice().sort(), ["about_text", "visit_text"], "olrs4-5: dry-run — owner_field_locked names both locked candidate fields");
        assertTrue(!dry.body.skipped_locked.includes("olrs-4"), "olrs4-6: dry-run — NOT in skipped_locked (reserved for manual rows)");
        const rowAfterDry = getProviderRow("olrs-4");
        assertEq(rowAfterDry.about_text, OL_RS_ABOUT, "olrs4-7: dry-run performed ZERO writes");
        assertEq(rowAfterDry.visit_text, OL_RS_VISIT, "olrs4-8: dry-run performed ZERO writes (visit_text too)");

        const apply = await callRoute(opplevelserRouter, {
          headers: { "x-admin-key": testKey },
          body: { providerIds: ["olrs-4"], apply: true },
        });
        assertEq(apply.status, 200, "olrs4-9: apply call -> 200");
        assertTrue(!apply.body.changed.some((c: any) => c.provider_id === "olrs-4"), "olrs4-10: apply — olrs-4 does NOT appear in changed[] (nothing was nulled)");
        const applyLockedEntry = apply.body.owner_field_locked.find((e: any) => e.provider_id === "olrs-4");
        assertTrue(!!applyLockedEntry, "olrs4-11: apply — olrs-4 appears in owner_field_locked");
        assertEq(applyLockedEntry.fields.slice().sort(), ["about_text", "visit_text"], "olrs4-12: apply — owner_field_locked names both locked candidate fields");
        assertTrue(!apply.body.skipped_locked.includes("olrs-4"), "olrs4-13: apply — NOT in skipped_locked");
        const rowAfterApply = getProviderRow("olrs-4");
        assertEq(rowAfterApply.about_text, OL_RS_ABOUT, "olrs4-14: apply — about_text still unchanged, nothing nulled");
        assertEq(rowAfterApply.visit_text, OL_RS_VISIT, "olrs4-15: apply — visit_text still unchanged, nothing nulled");
        assertEq(getAuditRows("olrs-4").length, 0, "olrs4-16: apply — no audit rows written (nothing was actually nulled)");
      }

      // ── Direct applyGardssalgRetroScanNull call — pure per-field-gate
      //    proof, independent of the route's own fetch/judge pipeline
      //    (belt-and-suspenders alongside the route-level tests above, same
      //    spirit as opplevelser-gardssalg-owner-lock-content-refresh.test.ts's
      //    own direct-call block). ─────────────────────────────────────────
      {
        expDb.prepare(
          `INSERT INTO experience_providers
             (id, navn, vertical, hjemmeside, content_source, about_text, visit_text, field_provenance,
              producer_type, enrichment_state, verification_status, source, confidence)
           VALUES
             ('olrs-direct', 'Olrs Direct Gard', 'experiences', 'https://olrs-direct.example.no', 'claim', ?, ?, ?,
              'cideri', 'raw', 'pending_verify', 'test-fixture', 'medium')`,
        ).run(
          OL_RS_ABOUT,
          OL_RS_VISIT,
          provenance({ owner_locks: { about_text: { locked_at: "2026-08-01T00:00:00.000Z" } } }),
        );

        const written = store.applyGardssalgRetroScanNull(
          "olrs-direct",
          ["about_text", "visit_text"],
          "https://olrs-direct.example.no/scan",
        );
        assertEq(written, ["visit_text"], "direct-1: applyGardssalgRetroScanNull — only visit_text nulled, about_text skipped (owner-locked)");
        const rowDirect = expDb.prepare("SELECT about_text, visit_text FROM experience_providers WHERE id = ?").get("olrs-direct") as any;
        assertEq(rowDirect.about_text, OL_RS_ABOUT, "direct-2: about_text untouched at the DB level too");
        assertEq(rowDirect.visit_text, null, "direct-3: visit_text nulled at the DB level");
      }

      // ── selectGardssalgProvidersForRetroScan: gate 1 — a claim row with a
      //    non-blank field is now selectable (only 'manual' is excluded by
      //    the SQL WHERE clause). ────────────────────────────────────────
      {
        const selected = store.selectGardssalgProvidersForRetroScan(48);
        const ids = selected.map((r: any) => r.id);
        assertTrue(ids.includes("olrs-3"), "gate1-1: a claim row IS selected by the auto-select SQL");
        assertTrue(!ids.includes("olrs-2"), "gate1-2: the manual row is still excluded by the auto-select SQL");
        const selectedClaim = selected.find((r: any) => r.id === "olrs-3");
        assertTrue(!!selectedClaim && typeof selectedClaim.field_provenance !== "undefined", "gate1-3: the selected row carries field_provenance (needed downstream for the per-field lock check)");
      }
    } catch (err: any) {
      failed++;
      failures.push("opplevelser-gardssalg-owner-lock-retro-scan: unexpected error: " + String(err?.stack || err?.message || err));
    } finally {
      globalThis.fetch = prevFetch;
      if (prevAnthropicKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = prevAnthropicKey;
      if (prevAdminKey === undefined) delete process.env.ADMIN_KEY;
      else process.env.ADMIN_KEY = prevAdminKey;
      if (prevExperiencesDbPath === undefined) delete process.env.EXPERIENCES_DB_PATH;
      else process.env.EXPERIENCES_DB_PATH = prevExperiencesDbPath;
      try {
        const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
        dbFactory.__resetDbFactoryForTesting();
      } catch { /* best-effort */ }
      for (const p of cachePaths) delete require.cache[p];
    }

    return { passed, failed, failures };
  })();
}

if (require.main === module) {
  runOpplevelserGardssalgOwnerLockRetroScanTests({ log: true }).then((result) => {
    console.log(`\n${result.passed} passed, ${result.failed} failed`);
    if (result.failed > 0) process.exit(1);
  });
}
