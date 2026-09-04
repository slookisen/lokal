/**
 * opplevelser-gardssalg-owner-lock-content-refresh.test.ts — unit tests for
 * sub-slice 3i of dev-request 2026-07-30-opplevagent-claim-epost-og-perfelt-
 * laas (`platform-orchestrator/run-2026-08-06T1508-platform-orchestrator-rfb`).
 *
 * Wires the already-shipped, already-reviewed per-field owner-lock helper
 * (`isGardssalgFieldOwnerLocked`, PR #472/#478) through the THREE row-level
 * bail points `applyGardssalgProviderContent()` / `POST /admin/gardssalg-
 * content-refresh` used to have for `content_source='claim'` rows:
 *
 *   1. `selectGardssalgProvidersForContentRefresh`'s SQL WHERE clause — now
 *      only excludes 'manual', not 'claim'.
 *   2. The route's early LOCK check (`processOne`) — now only short-circuits
 *      for 'manual'; a 'claim' row proceeds to fetch/candidate-generation.
 *   3. `applyGardssalgProviderContent` itself — 'manual' still bails the
 *      whole row (unchanged); 'claim' now gates EACH of the 4 candidate
 *      fields (about_text/visit_text/opening_hours_text/products)
 *      individually via `isGardssalgFieldOwnerLocked(row, fieldName)`.
 *
 * Also covers the additive `owner_field_locked` response bucket (distinct
 * from `skipped_locked`, which keeps its pre-existing "manual row, full
 * skip, never fetched" meaning).
 *
 * Same conventions as opplevelser-gardssalg-content-audit.test.ts's (k)/(l)
 * blocks: EXPERIENCES_DB_PATH=":memory:", fresh require of db-factory +
 * experience-store + opplevelser router, router.handle() exercised directly
 * (no real HTTP server — this repo's convention), globalThis.fetch mocked
 * (homepage + judge) since the sandbox has no network access.
 *
 * Covers (mirroring the sub-slice's own 4 acceptance criteria):
 *   1. claim row, owner_locks.about_text set but NOT visit_text, a candidate
 *      exists for BOTH -> about_text skipped (locked), visit_text written —
 *      per-field split proven both directions in one case.
 *   2. manual row, unchanged — route never fetches, skipped_locked still
 *      fires, zero fields ever considered (negative control).
 *   3. claim row with NO owner_locks at all -> behaves exactly like an
 *      enrichment-eligible row today, all candidate fields written
 *      (critical regression/negative-control test).
 *   4. claim row where every candidate field is owner-locked -> written:[],
 *      owner_field_locked names the row + its locked fields, NOT in
 *      skipped_locked. Proven in BOTH dry-run and apply, since dry-run
 *      never calls applyGardssalgProviderContent and must predict the same
 *      outcome independently.
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
    const url = opts.url || "/admin/gardssalg-content-refresh";
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

export function runOpplevelserGardssalgOwnerLockContentRefreshTests(
  opts: { log?: boolean } = {},
): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];
  // Main-db pin: the apply route under test reads enrichment_write_pause off
  // the MAIN db singleton (fail-closed) — see __pinInMemoryDbForTesting.
  let restoreMainDb: (() => void) | null = null;

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
    const testKey = process.env.ADMIN_KEY || "gardssalg-owner-lock-cr-test-key";
    process.env.EXPERIENCES_DB_PATH = ":memory:";
    process.env.ADMIN_KEY = testKey;
    process.env.ANTHROPIC_API_KEY = "test-anthropic-key-owner-lock-cr";

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
      restoreMainDb = (require("../database/init") as typeof import("../database/init")).__pinInMemoryDbForTesting();
      const opplevelserRouter = (require("./opplevelser") as typeof import("./opplevelser")).default as any;

      const insertProviderStmt = expDb.prepare(
        `INSERT INTO experience_providers
           (id, navn, vertical, hjemmeside, content_source, about_text, visit_text, opening_hours_text, field_provenance,
            producer_type, enrichment_state, verification_status, source, confidence)
         VALUES
           (@id, @navn, 'experiences', @hjemmeside, @content_source, @about_text, @visit_text, @opening_hours_text, @field_provenance,
            'cideri', 'raw', 'pending_verify', 'test-fixture', 'medium')`,
      );

      // Every fixture must clear the (unrelated, pre-existing) website-
      // verification gate to reach the fetch stage at all — same convention
      // as opplevelser-gardssalg-content-audit.test.ts's (k) block. Callers
      // merge additional field_provenance keys (owner_locks) on top.
      function verifiedProvenance(extra?: Record<string, unknown>): string {
        return JSON.stringify({
          hjemmeside_verification: { verified: true, classification: "verified", checked_at: "2026-01-01T00:00:00.000Z" },
          ...extra,
        });
      }

      function getProviderRow(id: string): any {
        return expDb.prepare(
          `SELECT id, about_text, visit_text, content_source, field_provenance
             FROM experience_providers WHERE id = ?`
        ).get(id);
      }

      // ── Fixtures ──────────────────────────────────────────────────────
      // ol-1: claim row, owner_locks.about_text present, owner_locks.
      // visit_text ABSENT. Both fields blank -> both get "filled" candidates.
      insertProviderStmt.run({
        id: "ol-1", navn: "Ol1 Sideri", hjemmeside: "https://ol1.example.no",
        content_source: "claim", about_text: null, visit_text: null, opening_hours_text: null,
        field_provenance: verifiedProvenance({ owner_locks: { about_text: { locked_at: "2026-08-01T00:00:00.000Z" } } }),
      });

      // ol-2: manual row — negative control, must never reach the fetch stage.
      insertProviderStmt.run({
        id: "ol-2", navn: "Ol2 Manuell Gard", hjemmeside: "https://ol2.example.no",
        content_source: "manual", about_text: "Håndskrevet om-tekst", visit_text: null, opening_hours_text: null,
        field_provenance: verifiedProvenance(),
      });

      // ol-3: claim row, NO owner_locks at all — critical negative control:
      // must behave exactly like an unlocked/enrichment-eligible row.
      insertProviderStmt.run({
        id: "ol-3", navn: "Ol3 Bryggeri", hjemmeside: "https://ol3.example.no",
        content_source: "claim", about_text: null, visit_text: null, opening_hours_text: null,
        field_provenance: verifiedProvenance(),
      });

      // ol-4: claim row, EVERY candidate field (about_text + visit_text)
      // owner-locked -> written:[], owner_field_locked names both fields.
      insertProviderStmt.run({
        id: "ol-4", navn: "Ol4 Gardsbutikk", hjemmeside: "https://ol4.example.no",
        content_source: "claim", about_text: null, visit_text: null, opening_hours_text: null,
        field_provenance: verifiedProvenance({
          owner_locks: {
            about_text: { locked_at: "2026-08-01T00:00:00.000Z" },
            visit_text: { locked_at: "2026-08-01T00:00:00.000Z" },
          },
        }),
      });

      // ── Fetch + judge mock ───────────────────────────────────────────
      // Distinct about/visit prose per host, both clearing meetsGardssalg
      // AboutQualityBar's cheap-bar prefilter; the judge mock below always
      // approves (this file's concern is the owner-lock gating, not judge
      // calibration — see opplevelser-gardssalg-quality-judge.test.ts for
      // that). Sub-page candidates (om-oss, besok, ...) 404, same as block
      // (k)/(l) in opplevelser-gardssalg-content-audit.test.ts.
      function htmlFor(host: string): string {
        const about = `${host} gård ligger idyllisk til på bygda og driver med økologisk dyrking av grønnsaker og bær hele sesongen.`;
        const visit = `Besøkende er velkomne til gårdsbutikken hos ${host} for å handle ferske varer rett fra jordet, åpent i helgene.`;
        return `<html><head><meta property="og:description" content="${about}"></head><body><p>${visit}</p></body></html>`;
      }
      const fetchedHosts: string[] = [];
      globalThis.fetch = (async (url: string | URL | Request) => {
        const urlStr = String(url);
        if (urlStr.includes("api.anthropic.com")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ content: [{ type: "text", text: "GODKJENN\nRen, konkret prosa om produsenten." }] }),
          } as unknown as Response;
        }
        const host = new URL(urlStr).hostname;
        fetchedHosts.push(host);
        if (["ol1.example.no", "ol2.example.no", "ol3.example.no", "ol4.example.no", "ol5.example.no"].includes(host)) {
          const html = htmlFor(host);
          return {
            ok: true, status: 200, text: async () => html,
            arrayBuffer: async () => new TextEncoder().encode(html).buffer,
            headers: { get: () => null },
          } as unknown as Response;
        }
        return { ok: false, status: 404, text: async () => "" } as unknown as Response;
      }) as typeof fetch;

      // ═══════════════════════════════════════════════════════════════════
      // (1) claim row, about_text locked / visit_text unlocked, candidates
      //     for BOTH -> about_text skipped, visit_text written.
      // ═══════════════════════════════════════════════════════════════════
      {
        const r = await callRoute(opplevelserRouter, {
          headers: { "x-admin-key": testKey },
          body: { providerIds: ["ol-1"], apply: true },
        });
        assertEq(r.status, 200, "ol1-1: apply call -> 200");
        assertTrue(!r.body.skipped_locked.includes("ol-1"), "ol1-2: NOT in skipped_locked — a claim row with a candidate proceeds past the row-level check");
        const entry = r.body.changed.find((c: any) => c.provider_id === "ol-1");
        assertTrue(!!entry, "ol1-3: ol-1 appears in changed[]");
        assertEq(entry.fields, ["visit_text"], "ol1-4: only visit_text is reported written — about_text (locked) is excluded");
        assertTrue(!("about_text" in entry.actions), "ol1-5: about_text is not in actions either");
        const rowAfter = getProviderRow("ol-1");
        assertEq(rowAfter.about_text, null, "ol1-6: about_text stays null — the owner-locked field was never written");
        assertTrue(!!rowAfter.visit_text && rowAfter.visit_text.length > 0, "ol1-7: visit_text WAS written (unlocked sibling field proceeds normally)");
        assertTrue(!r.body.owner_field_locked.some((e: any) => e.provider_id === "ol-1"), "ol1-8: NOT in owner_field_locked — only a FULLY-locked candidate set is reported there, not a partial lock");
      }

      // ═══════════════════════════════════════════════════════════════════
      // (2) manual row — completely unchanged: route never fetches,
      //     skipped_locked still fires, zero fields ever considered.
      // ═══════════════════════════════════════════════════════════════════
      {
        const fetchedBefore = fetchedHosts.length;
        const r = await callRoute(opplevelserRouter, {
          headers: { "x-admin-key": testKey },
          body: { providerIds: ["ol-2"], apply: true },
        });
        assertEq(r.status, 200, "ol2-1: apply call -> 200");
        assertTrue(r.body.skipped_locked.includes("ol-2"), "ol2-2: manual row still reported in skipped_locked");
        assertEq(fetchedHosts.length, fetchedBefore, "ol2-3: no fetch happened for the manual row — the lock check short-circuits BEFORE any network call");
        assertTrue(!r.body.changed.some((c: any) => c.provider_id === "ol-2"), "ol2-4: manual row never appears in changed[]");
        assertTrue(!r.body.owner_field_locked.some((e: any) => e.provider_id === "ol-2"), "ol2-5: manual row never appears in owner_field_locked (that bucket is claim-only)");
        const rowAfter = getProviderRow("ol-2");
        assertEq(rowAfter.about_text, "Håndskrevet om-tekst", "ol2-6: manual row's about_text is completely untouched");
      }

      // ═══════════════════════════════════════════════════════════════════
      // (3) claim row, NO owner_locks at all -> behaves exactly like today:
      //     ALL candidate fields written. Critical regression/negative
      //     control — proves the per-field change doesn't silently loosen
      //     OR silently tighten the "owner never touched anything" case.
      // ═══════════════════════════════════════════════════════════════════
      {
        const r = await callRoute(opplevelserRouter, {
          headers: { "x-admin-key": testKey },
          body: { providerIds: ["ol-3"], apply: true },
        });
        assertEq(r.status, 200, "ol3-1: apply call -> 200");
        assertTrue(!r.body.skipped_locked.includes("ol-3"), "ol3-2: NOT in skipped_locked");
        const entry = r.body.changed.find((c: any) => c.provider_id === "ol-3");
        assertTrue(!!entry, "ol3-3: ol-3 appears in changed[]");
        assertEq(entry.fields.slice().sort(), ["about_text", "visit_text"], "ol3-4: BOTH candidate fields written — no owner_locks means nothing is locked");
        assertTrue(!r.body.owner_field_locked.some((e: any) => e.provider_id === "ol-3"), "ol3-5: NOT in owner_field_locked");
        const rowAfter = getProviderRow("ol-3");
        assertTrue(!!rowAfter.about_text && !!rowAfter.visit_text, "ol3-6: both fields actually written to the DB row");
      }

      // ═══════════════════════════════════════════════════════════════════
      // (4) claim row, EVERY candidate field owner-locked -> written:[],
      //     owner_field_locked names the row + its locked fields, NOT in
      //     skipped_locked. Proven in BOTH dry-run and apply — dry-run
      //     never calls applyGardssalgProviderContent, so the route must
      //     predict the same per-field outcome independently for the
      //     preview to stay honest.
      // ═══════════════════════════════════════════════════════════════════
      {
        const dry = await callRoute(opplevelserRouter, {
          headers: { "x-admin-key": testKey },
          body: { providerIds: ["ol-4"], apply: false },
        });
        assertEq(dry.status, 200, "ol4-1: dry-run call -> 200");
        assertEq(dry.body.dry_run, true, "ol4-2: dry_run:true");
        assertTrue(!dry.body.changed.some((c: any) => c.provider_id === "ol-4"), "ol4-3: dry-run — ol-4 does NOT appear in changed[] (nothing would actually be written)");
        const dryLockedEntry = dry.body.owner_field_locked.find((e: any) => e.provider_id === "ol-4");
        assertTrue(!!dryLockedEntry, "ol4-4: dry-run — ol-4 appears in owner_field_locked");
        assertEq(dryLockedEntry.fields.slice().sort(), ["about_text", "visit_text"], "ol4-5: dry-run — owner_field_locked names both locked candidate fields");
        assertTrue(!dry.body.skipped_locked.includes("ol-4"), "ol4-6: dry-run — NOT in skipped_locked (reserved for manual rows)");
        const rowAfterDry = getProviderRow("ol-4");
        assertEq(rowAfterDry.about_text, null, "ol4-7: dry-run performed ZERO writes");

        const apply = await callRoute(opplevelserRouter, {
          headers: { "x-admin-key": testKey },
          body: { providerIds: ["ol-4"], apply: true },
        });
        assertEq(apply.status, 200, "ol4-8: apply call -> 200");
        assertTrue(!apply.body.changed.some((c: any) => c.provider_id === "ol-4"), "ol4-9: apply — ol-4 does NOT appear in changed[] (nothing was written)");
        const applyLockedEntry = apply.body.owner_field_locked.find((e: any) => e.provider_id === "ol-4");
        assertTrue(!!applyLockedEntry, "ol4-10: apply — ol-4 appears in owner_field_locked");
        assertEq(applyLockedEntry.fields.slice().sort(), ["about_text", "visit_text"], "ol4-11: apply — owner_field_locked names both locked candidate fields");
        assertTrue(!apply.body.skipped_locked.includes("ol-4"), "ol4-12: apply — NOT in skipped_locked");
        const rowAfterApply = getProviderRow("ol-4");
        assertEq(rowAfterApply.about_text, null, "ol4-13: apply — about_text still null, nothing written");
        assertEq(rowAfterApply.visit_text, null, "ol4-14: apply — visit_text still null, nothing written");
      }

      // ═══════════════════════════════════════════════════════════════════
      // (5) dev-request 2026-08-29-gardssalg-products-write-and-field-lock,
      //     Part B: an ADMIN-set lock (via the new gardssalg-set-field-lock
      //     endpoint) on an ORDINARY row — content_source=null, NOT 'claim'
      //     — must ALSO be honored here, in both dry-run and apply. Before
      //     that dev-request, this was the exact gap: owner_locks was only
      //     ever consulted for content_source='claim' rows (both inside
      //     isGardssalgFieldOwnerLocked itself and via the extra
      //     `t.content_source === "claim" &&`/`row.content_source ===
      //     "claim" &&` guards this route and applyGardssalgProviderContent
      //     used to carry at their own call sites), so an admin lock written
      //     on a typical (non-claim) production row — like the Anikonic
      //     Cider case this dev-request's Post-deploy verification section
      //     names — would have been silently ignored by content-refresh.
      // ═══════════════════════════════════════════════════════════════════
      {
        expDb.prepare(
          `INSERT INTO experience_providers
             (id, navn, vertical, hjemmeside, content_source, about_text, visit_text, opening_hours_text, field_provenance,
              producer_type, enrichment_state, verification_status, source, confidence)
           VALUES
             ('ol-5', 'Ol5 Adminlaast Gard', 'experiences', 'https://ol5.example.no', NULL, NULL, NULL, NULL, @field_provenance,
              'cideri', 'raw', 'pending_verify', 'test-fixture', 'medium')`,
        ).run({
          field_provenance: verifiedProvenance({
            owner_locks: { about_text: { locked_at: "2026-08-29T00:00:00.000Z", locked_by: "admin", source_url: "CS verifisert manuelt" } },
          }),
        });

        const dry5 = await callRoute(opplevelserRouter, {
          headers: { "x-admin-key": testKey },
          body: { providerIds: ["ol-5"], apply: false },
        });
        assertEq(dry5.status, 200, "ol5-1: dry-run call -> 200");
        assertTrue(!dry5.body.changed.some((c: any) => c.provider_id === "ol-5" && c.fields.includes("about_text")), "ol5-2: dry-run — about_text is NOT proposed as a change for the admin-locked field (the acceptance criterion this dev-request exists to satisfy)");
        const dry5Entry = dry5.body.changed.find((c: any) => c.provider_id === "ol-5");
        if (dry5Entry) {
          assertEq(dry5Entry.fields, ["visit_text"], "ol5-3: dry-run — only the UNLOCKED sibling field (visit_text) is proposed, about_text is excluded");
        }
        const dry5LockedEntry = dry5.body.owner_field_locked.find((e: any) => e.provider_id === "ol-5");
        if (dry5LockedEntry) {
          assertTrue(dry5LockedEntry.fields.includes("about_text"), "ol5-4: if ol-5 appears in owner_field_locked, about_text is named");
        }

        const apply5 = await callRoute(opplevelserRouter, {
          headers: { "x-admin-key": testKey },
          body: { providerIds: ["ol-5"], apply: true },
        });
        assertEq(apply5.status, 200, "ol5-5: apply call -> 200");
        const rowAfterApply5 = getProviderRow("ol-5");
        assertEq(rowAfterApply5.about_text, null, "ol5-6: apply — about_text is STILL null, the admin lock actually prevented the write (not just the dry-run preview)");
        assertTrue(!!rowAfterApply5.visit_text, "ol5-7: apply — the unlocked sibling field (visit_text) WAS written, proving this is a per-field skip, not a full-row one");
      }

      // ── Direct applyGardssalgProviderContent call — pure per-field-gate
      //    proof, independent of the route's own candidate-generation/
      //    judge pipeline (belt-and-suspenders alongside the route-level
      //    tests above, same spirit as experience-store.test.ts's own
      //    mojibake-backfill block). ────────────────────────────────────
      {
        expDb.prepare(
          `INSERT INTO experience_providers
             (id, navn, vertical, hjemmeside, content_source, about_text, visit_text, field_provenance,
              producer_type, enrichment_state, verification_status, source, confidence)
           VALUES
             ('ol-direct', 'Ol Direct Gard', 'experiences', 'https://ol-direct.example.no', 'claim', NULL, NULL, ?,
              'cideri', 'raw', 'pending_verify', 'test-fixture', 'medium')`,
        ).run(verifiedProvenance({ owner_locks: { about_text: { locked_at: "2026-08-01T00:00:00.000Z" } } }));

        const written = store.applyGardssalgProviderContent(
          "ol-direct",
          { about_text: "Om Ol Direct gård og produktene våre.", visit_text: "Besøk oss i helgene på gårdsbutikken." },
          "https://ol-direct.example.no/om-oss",
        );
        assertEq(written, ["visit_text"], "direct-1: applyGardssalgProviderContent — only visit_text written, about_text skipped (owner-locked)");
        const rowDirect = expDb.prepare("SELECT about_text, visit_text FROM experience_providers WHERE id = ?").get("ol-direct") as any;
        assertEq(rowDirect.about_text, null, "direct-2: about_text untouched at the DB level too");
        assertEq(rowDirect.visit_text, "Besøk oss i helgene på gårdsbutikken.", "direct-3: visit_text written at the DB level");
      }

      // ── Fix under review: a partial-field write to a claim row must NOT
      //    re-stamp content_source='provider_site' — that would silently
      //    unlock the row's remaining locked fields on the NEXT run, since
      //    isFieldOwnerLocked/isGardssalgFieldOwnerLocked only gate when
      //    content_source === 'claim'. Two-pass, same row, reproducing
      //    exactly the sequence the fresh-context review flagged. ─────────
      {
        expDb.prepare(
          `INSERT INTO experience_providers
             (id, navn, vertical, hjemmeside, content_source, about_text, visit_text, field_provenance,
              producer_type, enrichment_state, verification_status, source, confidence)
           VALUES
             ('ol-stamp', 'Ol Stamp Gard', 'experiences', 'https://ol-stamp.example.no', 'claim', NULL, NULL, ?,
              'cideri', 'raw', 'pending_verify', 'test-fixture', 'medium')`,
        ).run(verifiedProvenance({ owner_locks: { about_text: { locked_at: "2026-08-01T00:00:00.000Z" } } }));

        // Pass 1: about_text is locked, visit_text is not -> only visit_text
        // is written.
        const writtenPass1 = store.applyGardssalgProviderContent(
          "ol-stamp",
          { about_text: "Om Ol Stamp gård og produktene våre.", visit_text: "Besøk oss i helgene på gårdsbutikken." },
          "https://ol-stamp.example.no/om-oss",
        );
        assertEq(writtenPass1, ["visit_text"], "stamp-1: pass 1 — only visit_text written, about_text skipped (owner-locked)");
        const rowAfterPass1 = expDb.prepare(
          "SELECT about_text, visit_text, content_source FROM experience_providers WHERE id = ?"
        ).get("ol-stamp") as any;
        assertEq(rowAfterPass1.about_text, null, "stamp-2: about_text still null after pass 1");
        assertEq(rowAfterPass1.visit_text, "Besøk oss i helgene på gårdsbutikken.", "stamp-3: visit_text written after pass 1");
        assertEq(rowAfterPass1.content_source, "claim", "stamp-4: content_source is STILL 'claim' after a successful partial-field write — the bug this fix closes (was silently flipping to 'provider_site')");

        // Pass 2 (simulating the next scheduled content-refresh run on the
        // SAME row): a fresh candidate for about_text must STILL be skipped,
        // proving the row's per-field lock is still enforced — not silently
        // lifted because content_source flipped away from 'claim'.
        const writtenPass2 = store.applyGardssalgProviderContent(
          "ol-stamp",
          { about_text: "En helt annen, fersk om-tekst for Ol Stamp gård." },
          "https://ol-stamp.example.no/om-oss-2",
        );
        assertEq(writtenPass2, [], "stamp-5: pass 2 — about_text is STILL skipped (still owner-locked), proving the lock survives across runs");
        const rowAfterPass2 = expDb.prepare(
          "SELECT about_text, content_source FROM experience_providers WHERE id = ?"
        ).get("ol-stamp") as any;
        assertEq(rowAfterPass2.about_text, null, "stamp-6: about_text is STILL null after pass 2 — the fresh candidate was correctly rejected");
        assertEq(rowAfterPass2.content_source, "claim", "stamp-7: content_source remains 'claim' after pass 2 too");
      }

      // ── selectGardssalgProvidersForContentRefresh: gate 1 — a claim row
      //    with a thin/blank field is now selectable (only 'manual' is
      //    excluded by the SQL WHERE clause). ─────────────────────────────
      {
        const selected = store.selectGardssalgProvidersForContentRefresh(48);
        const ids = selected.map((r: any) => r.id);
        assertTrue(ids.includes("ol-3"), "gate1-1: a claim row with a blank field IS selected by the auto-select SQL");
        assertTrue(!ids.includes("ol-2"), "gate1-2: the manual row is still excluded by the auto-select SQL");
      }
    } catch (err: any) {
      failed++;
      failures.push("opplevelser-gardssalg-owner-lock-content-refresh: unexpected error: " + String(err?.stack || err?.message || err));
    } finally {
      if (restoreMainDb) restoreMainDb();
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
  runOpplevelserGardssalgOwnerLockContentRefreshTests({ log: true }).then((result) => {
    console.log(`\n${result.passed} passed, ${result.failed} failed`);
    if (result.failed > 0) process.exit(1);
  });
}
