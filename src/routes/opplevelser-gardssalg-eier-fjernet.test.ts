/**
 * opplevelser-gardssalg-eier-fjernet.test.ts — dev-request
 * 2026-10-01-opplevagent-eier-fjernet-som-terminal: a producer that asked to
 * be removed gets terminal tier `eier_fjernet` and cannot be unhidden by
 * accident.
 *
 *   (a) terminal_status='eier_fjernet' via POST /admin/gardssalg-set-terminal-status
 *   (b) org.nr / domain / e-post on the blocklist with a "fjern oss" reason
 *       (a blocklist row with another reason does NOT count)
 *   (c) POST /admin/gardssalg-provider-visibility hidden:false without
 *       override_owner_removed -> skipped_owner_removed; with override -> shown
 *   (d) a quality-hidden row (no removal evidence) stays `skjult` and is
 *       unhidden normally
 *   (e) summary carries eier_fjernet as its own bucket
 *
 * Same harness as the other gårdssalg route tests (:memory: DBs, fresh
 * requires, router.handle()).
 */

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

function callRoute(
  router: any,
  opts: { method?: "GET" | "POST"; url: string; headers?: Record<string, string>; body?: any },
): Promise<{ status: number; body: any }> {
  return new Promise((resolve) => {
    const req: any = {
      method: opts.method || "POST",
      url: opts.url,
      originalUrl: opts.url,
      path: opts.url,
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

export function runOpplevelserGardssalgEierFjernetTests(log = false): Promise<TestSummary> {
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];

  function assertEq(actual: unknown, expected: unknown, label: string): void {
    if (actual === expected) { passed++; if (log) console.log(`  ok ${label}`); }
    else {
      failed++;
      failures.push(`✗ ${label} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
      if (log) console.log(`  ✗ ${label}`);
    }
  }
  function assertTrue(cond: boolean, label: string): void {
    if (cond) { passed++; if (log) console.log(`  ok ${label}`); }
    else { failed++; failures.push(`✗ ${label}`); if (log) console.log(`  ✗ ${label}`); }
  }

  return (async () => {
    const prevExperiencesDbPath = process.env.EXPERIENCES_DB_PATH;
    const prevAdminKey = process.env.ADMIN_KEY;
    const testKey = process.env.ADMIN_KEY || "gardssalg-eier-fjernet-test-key";
    process.env.EXPERIENCES_DB_PATH = ":memory:";
    process.env.ADMIN_KEY = testKey;

    const cachePaths = [
      require.resolve("../database/db-factory"),
      require.resolve("../services/experience-store"),
      require.resolve("../services/blocklist-service"),
      require.resolve("./opplevelser"),
    ];
    const restoreModuleCache = (require("../../tests/module-cache") as typeof import("../../tests/module-cache")).swapOutModules(cachePaths);
    let prevRfbDb: any = null;

    try {
      const initMod = require("../database/init") as typeof import("../database/init");
      const Database = require("better-sqlite3") as typeof import("better-sqlite3");
      prevRfbDb = initMod.__peekDbForTesting();
      const rfbDb = new Database(":memory:");
      initMod.__setDbForTesting(rfbDb as any);
      initMod.__initSchemaForTesting(rfbDb as any);
      const blocklistSvc = require("../services/blocklist-service") as typeof import("../services/blocklist-service");

      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const expDb = dbFactory.getDb("experiences");
      const router = (require("./opplevelser") as typeof import("./opplevelser")).default as any;
      const auth = { "x-admin-key": testKey };

      // Content-complete rows: would be outreach_ready (or skjult when hidden)
      // absent any removal evidence.
      const insert = expDb.prepare(
        `INSERT INTO experience_providers
           (id, navn, vertical, org_nr, content_source, epost, telefon, hjemmeside,
            about_text, products, brreg_verified, catalog_hidden, slug, field_provenance,
            producer_type, enrichment_state, verification_status, source, confidence, created_at)
         VALUES
           (@id, @navn, 'experiences', @org_nr, NULL, @epost, '90000001', @hjemmeside,
            'Om oss', 'Sider', 1, @catalog_hidden, @slug, @fp,
            'cideri', 'raw', 'pending_verify', 'test-fixture', 'medium', '2026-01-01 00:00:00')`,
      );
      const fp = JSON.stringify({
        hjemmeside_verification: { verified: true, classification: "verified", checked_at: "2026-01-02T00:00:00.000Z" },
      });
      function mk(id: string, over: Partial<Record<string, any>> = {}): void {
        insert.run({
          id, navn: `Gard ${id}`, org_nr: null, epost: `${id}@ukjent-${id}.test`,
          hjemmeside: `https://${id}-gard.test`, catalog_hidden: null, slug: `slug-${id}`, fp, ...over,
        });
      }
      async function readiness(): Promise<any> {
        const r = await callRoute(router, { method: "GET", url: "/admin/gardssalg-outreach-readiness", headers: auth });
        return r.body;
      }
      async function tierOf(id: string): Promise<string | undefined> {
        return ((await readiness()).providers as any[]).find((p) => p.id === id)?.readiness_tier;
      }
      const hiddenFlag = (id: string): number | null =>
        (expDb.prepare(`SELECT catalog_hidden FROM experience_providers WHERE id = ?`).get(id) as any).catalog_hidden;
      const visibility = (body: any) =>
        callRoute(router, { url: "/admin/gardssalg-provider-visibility", headers: auth, body });

      // ── sanity: fixture is outreach_ready without removal evidence ───────
      mk("ef-base", { org_nr: "977000001" });
      assertEq(await tierOf("ef-base"), "outreach_ready", "ef-0: fixture is outreach_ready before any evidence");

      // ── (a) explicit terminal_status ─────────────────────────────────────
      {
        const r = await callRoute(router, {
          url: "/admin/gardssalg-set-terminal-status",
          headers: auth,
          body: { provider_id: "ef-base", terminal_status: "eier_fjernet", reason: "eier ba om fjerning" },
        });
        assertEq(r.status, 200, "ef-a1: eier_fjernet accepted by set-terminal-status");
        assertEq(r.body.new_value, "eier_fjernet", "ef-a2: new_value echoed");
        assertEq(await tierOf("ef-base"), "eier_fjernet", "ef-a3: explicit terminal_status -> tier eier_fjernet");
        const bad = await callRoute(router, {
          url: "/admin/gardssalg-set-terminal-status",
          headers: auth,
          body: { provider_id: "ef-base", terminal_status: "foo", reason: "x" },
        });
        assertEq(bad.status, 400, "ef-a4: unknown value still rejected");
        // rollback
        await callRoute(router, {
          url: "/admin/gardssalg-set-terminal-status",
          headers: auth,
          body: { provider_id: "ef-base", terminal_status: null, reason: "angre" },
        });
        assertEq(await tierOf("ef-base"), "outreach_ready", "ef-a5: null clears back to ordinary tier");
      }

      // ── (b) blocklist with a "fjern oss" reason: org_nr / domain / e-post ─
      {
        mk("ef-org", { org_nr: "977000002" });
        mk("ef-dom", { hjemmeside: "https://www.fjernet-domene.test/" });
        mk("ef-mail", { epost: "post@fjernet-epost.test" });
        mk("ef-other", { org_nr: "977000009", hjemmeside: "https://annen-grunn.test", epost: "a@annen-grunn.test" });
        blocklistSvc.add({ orgNr: "977000002", reason: "manuell (fjern oss)" });
        blocklistSvc.add({ website: "fjernet-domene.test", reason: "Fjern oss - epost fra eier" });
        blocklistSvc.add({ email: "post@fjernet-epost.test", reason: "gardssalg-provider-visibility hide (fjern oss)" });
        // Blocklisted for another reason -> must NOT count as owner-removed.
        blocklistSvc.add({ orgNr: "977000009", website: "annen-grunn.test", email: "a@annen-grunn.test", reason: "konkurs" });
        assertEq(await tierOf("ef-org"), "eier_fjernet", "ef-b1: org.nr on blocklist (fjern oss) -> eier_fjernet");
        assertEq(await tierOf("ef-dom"), "eier_fjernet", "ef-b2: domain on blocklist (fjern oss) -> eier_fjernet");
        assertEq(await tierOf("ef-mail"), "eier_fjernet", "ef-b3: e-post on blocklist (fjern oss) -> eier_fjernet");
        assertEq(await tierOf("ef-other"), "outreach_ready", "ef-b4: blocklist row with other reason is not eier_fjernet");
        assertEq(await tierOf("ef-base"), "outreach_ready", "ef-b5: unrelated row unaffected");
      }

      // ── (e) summary bucket ───────────────────────────────────────────────
      {
        const body = await readiness();
        assertEq(body.summary.eier_fjernet, 3, "ef-e1: summary.eier_fjernet counts the three removed rows");
        assertEq(body.summary.outreach_ready, 2, "ef-e2: others stay outreach_ready");
      }

      // ── (c) unhide guard ─────────────────────────────────────────────────
      {
        // Hide the org-blocklisted row (as the CS flow does), then try to unhide.
        expDb.prepare(`UPDATE experience_providers SET catalog_hidden = 1 WHERE id = 'ef-org'`).run();
        const r1 = await visibility({ hidden: false, providerIds: ["ef-org"], apply: true });
        assertEq(r1.status, 200, "ef-c1: 200");
        assertEq(r1.body.changed_count, 0, "ef-c2: nothing changed without override");
        assertEq(r1.body.skipped_owner_removed?.[0]?.outcome, "skipped_owner_removed", "ef-c3: outcome skipped_owner_removed");
        assertEq(r1.body.skipped_owner_removed?.[0]?.id, "ef-org", "ef-c4: the removed row is the one skipped");
        assertEq(hiddenFlag("ef-org"), 1, "ef-c5: row stays hidden");

        const dry = await visibility({ hidden: false, providerIds: ["ef-org"], override_owner_removed: true });
        assertEq(hiddenFlag("ef-org"), 1, "ef-c6: dry-run with override writes nothing");
        assertEq(dry.body.changed_count, 1, "ef-c6b: dry-run reports would-change");

        const r2 = await visibility({ hidden: false, providerIds: ["ef-org"], override_owner_removed: true, apply: true });
        assertEq(r2.body.changed_count, 1, "ef-c7: override unhides");
        assertEq(r2.body.override_owner_removed, true, "ef-c8: override logged in response");
        assertEq(r2.body.overridden_owner_removed?.[0]?.id, "ef-org", "ef-c9: overridden row listed");
        assertEq(hiddenFlag("ef-org"), null, "ef-c10: row visible again");
        assertEq(r2.body.skipped_owner_removed?.length, 0, "ef-c11: nothing skipped with override");

        // explicit terminal_status row is guarded too
        mk("ef-term");
        expDb.prepare(`UPDATE experience_providers SET catalog_hidden = 1, terminal_status = 'eier_fjernet' WHERE id = 'ef-term'`).run();
        const r3 = await visibility({ hidden: false, providerIds: ["ef-term"], apply: true });
        assertEq(r3.body.skipped_owner_removed?.[0]?.id, "ef-term", "ef-c12: explicit terminal_status row guarded");
        assertEq(hiddenFlag("ef-term"), 1, "ef-c13: stays hidden");

        // hiding is never blocked by the guard
        const r4 = await visibility({ hidden: true, providerIds: ["ef-base"], apply: true });
        assertEq(r4.body.changed_count, 1, "ef-c14: hidden:true unaffected");
      }

      // ── (d) quality-hidden row (no removal evidence) stays skjult ────────
      {
        mk("ef-quality", { catalog_hidden: 1 });
        assertEq(await tierOf("ef-quality"), "skjult", "ef-d1: quality-hidden row is still skjult");
        const r = await visibility({ hidden: false, providerIds: ["ef-quality"], apply: true });
        assertEq(r.body.changed_count, 1, "ef-d2: unhide works without override");
        assertEq(r.body.skipped_owner_removed?.length, 0, "ef-d3: not flagged owner-removed");
        assertEq(r.body.overridden_owner_removed, undefined, "ef-d4: no override block when flag absent");
      }
    } catch (err: any) {
      failed++;
      failures.push("opplevelser-gardssalg-eier-fjernet: unexpected error: " + String(err?.stack || err?.message || err));
    } finally {
      if (prevExperiencesDbPath === undefined) delete process.env.EXPERIENCES_DB_PATH;
      else process.env.EXPERIENCES_DB_PATH = prevExperiencesDbPath;
      if (prevAdminKey === undefined) delete process.env.ADMIN_KEY;
      else process.env.ADMIN_KEY = prevAdminKey;
      try {
        const initMod = require("../database/init") as typeof import("../database/init");
        if (prevRfbDb) initMod.__setDbForTesting(prevRfbDb);
      } catch { /* best-effort */ }
      try {
        const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
        dbFactory.__resetDbFactoryForTesting();
      } catch { /* best-effort */ }
      restoreModuleCache();
    }

    return { passed, failed, failures };
  })();
}
