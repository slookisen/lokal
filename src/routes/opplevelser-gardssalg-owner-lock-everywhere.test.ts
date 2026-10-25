/**
 * opplevelser-gardssalg-owner-lock-everywhere.test.ts — dev-request
 * 2026-10-22-opplevagent-mine-valg-gardssalg, G1 skive 5 (punkt 1): the owner
 * lock is respected by every automated writer. One section per path; each runs
 * on an OWNED row (content_source='claim') and asserts content_source is
 * unchanged and no locked field is written:
 *   (a) POST /admin/rfb-knowledge-enrich
 *   (b) website verification  (applyGardssalgProviderWebsite)
 *   (c) provider merge, the KEPT row  (applyGardssalgProviderMergePair)
 *   (d) homepage sweep: content refresh  (applyGardssalgProviderContent)
 *   (e) homepage sweep: retro scan  (applyGardssalgRetroScanNull)
 *   (f) autosvar  (POST /admin/gardssalg-autosvar-apply)
 * Standalone: npx tsx src/routes/opplevelser-gardssalg-owner-lock-everywhere.test.ts
 */

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

function callRoute(router: any, opts: { url: string; query?: Record<string, string>; headers?: Record<string, string> }): Promise<{ status: number; body: any }> {
  return new Promise((resolve) => {
    const query = opts.query || {};
    const qs = Object.entries(query).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");
    const url = opts.url + (qs ? `?${qs}` : "");
    const req: any = { method: "POST", url, originalUrl: url, path: opts.url, query, headers: opts.headers || {}, body: {}, get() { return undefined; } };
    const res: any = {
      statusCode: 200,
      status(code: number) { this.statusCode = code; return this; },
      json(payload: any) { resolve({ status: this.statusCode, body: payload }); return this; },
    };
    router.handle(req, res, (err?: any) => { if (err) resolve({ status: 500, body: { error: String(err) } }); });
  });
}

export function runOpplevelserGardssalgOwnerLockEverywhereTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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

  return (async () => {
    const prevExperiencesDbPath = process.env.EXPERIENCES_DB_PATH;
    const prevAdminKey = process.env.ADMIN_KEY;
    const prevAnthropicKey = process.env.ANTHROPIC_API_KEY;
    const prevFetch = globalThis.fetch;
    process.env.ANTHROPIC_API_KEY = "owner-lock-everywhere-test-key";
    globalThis.fetch = (async (input: any) => {
      const url = String(input);
      if (url.includes("api.anthropic.com")) {
        return { ok: true, status: 200, json: async () => ({ content: [{ type: "text", text: "GODKJENN\nEkte kontaktinfo." }] }) } as any;
      }
      throw new Error(`owner-lock-everywhere.test: unexpected fetch to ${url}`);
    }) as any;
    const testKey = process.env.ADMIN_KEY || "owner-lock-everywhere-test-admin-key";
    process.env.EXPERIENCES_DB_PATH = ":memory:";
    process.env.ADMIN_KEY = testKey;

    const cachePaths = [
      require.resolve("../database/db-factory"),
      require.resolve("../services/experience-store"),
      require.resolve("../services/gardssalg-provider-merge"),
      require.resolve("./opplevelser"),
    ];
    const restoreModuleCache = (require("../../tests/module-cache") as typeof import("../../tests/module-cache")).swapOutModules(cachePaths);
    let prevRfbDb: any = null;

    try {
      try {
        (require("../config/vertical-config") as typeof import("../config/vertical-config")).loadConfigsAtBoot();
      } catch { /* already loaded */ }
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const expDb = dbFactory.getDb("experiences");
      const initMod = require("../database/init") as typeof import("../database/init");
      const Database = require("better-sqlite3") as typeof import("better-sqlite3");
      prevRfbDb = initMod.__peekDbForTesting();
      const rfbDb = new Database(":memory:");
      initMod.__setDbForTesting(rfbDb as any);
      initMod.__initSchemaForTesting(rfbDb as any);
      const router = (require("./opplevelser") as typeof import("./opplevelser")).default as any;
      const store = require("../services/experience-store") as typeof import("../services/experience-store");
      const merge = require("../services/gardssalg-provider-merge") as typeof import("../services/gardssalg-provider-merge");

      const auth = { "x-admin-key": testKey };
      const lock = (...fields: string[]) =>
        JSON.stringify({ owner_locks: Object.fromEntries(fields.map((f) => [f, { locked_at: "2026-10-01T00:00:00Z" }])) });
      function mk(p: Record<string, unknown>): void {
        const row = { vertical: "experiences", created_at: "2026-01-01 00:00:00", ...p } as Record<string, unknown>;
        const cols = Object.keys(row);
        expDb.prepare(`INSERT INTO experience_providers (${cols.join(",")}) VALUES (${cols.map((c) => "@" + c).join(",")})`).run(row);
      }
      const get = (id: string): any => expDb.prepare(`SELECT * FROM experience_providers WHERE id = ?`).get(id);

      // ── (a) rfb-knowledge-enrich ───────────────────────────────────────
      const LONG_ABOUT = "Gården drives av familien og produserer eple og sider på tradisjonelt vis, med egne frukthager og eget pressehus ved fjorden.";
      rfbDb.prepare(
        `INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, is_active)
         VALUES ('rfb-1', 'Eid Gård', 'x', 'x', 'x@eidgard.no', 'https://eidgard.no', 'producer', 'k1', 1)`,
      ).run();
      rfbDb.prepare(`INSERT INTO agent_knowledge (agent_id, website, about, products) VALUES ('rfb-1', 'https://eidgard.no', ?, ?)`)
        .run(LONG_ABOUT, JSON.stringify(["Eplesider", "Eplemost"]));
      // owned row: about_text locked by the owner, products unlocked and empty
      mk({ id: "own-enrich", navn: "Eid Gård", hjemmeside: "https://eidgard.no", rfb_seed_source: "rfb-seed", content_source: "claim", field_provenance: lock("about_text") });
      const enrichRes = await callRoute(router, { url: "/admin/rfb-knowledge-enrich", query: { apply: "true" }, headers: auth });
      assertEq(enrichRes.status, 200, "a0: enrich apply -> 200");
      const enriched = get("own-enrich");
      assertEq(enriched.content_source, "claim", "a1: enrich keeps content_source='claim' on an owned row");
      assertEq(enriched.about_text, null, "a2: enrich does not write the owner-locked about_text");
      assertEq(enriched.products, JSON.stringify(["Eplesider", "Eplemost"]), "a3: enrich still fills the unlocked, empty products on the owned row");
      // admin/owner lock on a row that is NOT content_source='claim' is respected too
      rfbDb.prepare(
        `INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, is_active)
         VALUES ('rfb-2', 'Lås Gård', 'x', 'x', 'x@lasgard.no', 'https://lasgard.no', 'producer', 'k2', 1)`,
      ).run();
      rfbDb.prepare(`INSERT INTO agent_knowledge (agent_id, website, about) VALUES ('rfb-2', 'https://lasgard.no', ?)`).run(LONG_ABOUT);
      mk({ id: "locked-nonclaim", navn: "Lås Gård", hjemmeside: "https://lasgard.no", rfb_seed_source: "rfb-seed", content_source: null, field_provenance: lock("about_text") });
      await callRoute(router, { url: "/admin/rfb-knowledge-enrich", query: { apply: "true" }, headers: auth });
      assertEq(get("locked-nonclaim").about_text, null, "a4: enrich honours an owner_locks entry on a non-claim row");

      // ── (b) website verification ───────────────────────────────────────
      mk({ id: "own-web-locked", navn: "Eid Web Låst", content_source: "claim", field_provenance: lock("hjemmeside") });
      const wl = store.applyGardssalgProviderWebsite("own-web-locked", "https://eidweblast.no", "https://evidence.example/a");
      assertEq(wl, [], "b1: website verification writes nothing to a locked hjemmeside");
      assertEq(get("own-web-locked").hjemmeside, null, "b2: locked hjemmeside stays empty");
      assertEq(get("own-web-locked").content_source, "claim", "b3: content_source stays 'claim' (locked)");
      mk({ id: "own-web-open", navn: "Eid Web Åpen", content_source: "claim", field_provenance: "{}" });
      store.applyGardssalgProviderWebsite("own-web-open", "https://eidwebapen.no", "https://evidence.example/b");
      assertEq(get("own-web-open").content_source, "claim", "b4: content_source stays 'claim' when an unlocked hjemmeside is filled");

      // ── (c) merge — the kept row ───────────────────────────────────────
      mk({ id: "own-keep", navn: "Eid Keep", content_source: "claim", field_provenance: lock("about_text") });
      mk({ id: "dup-remove", navn: "Eid Keep Dup", org_nr: "912345678", about_text: "Tekst fra dubletten som ikke skal inn.", visit_text: "Besøk fra dubletten.", content_source: null });
      const mr = merge.applyGardssalgProviderMergePair(expDb as any, "dup-remove", "own-keep", null, "batch-lock-1");
      assertEq(mr.outcome, "merged", "c0: merge applies");
      assertEq(get("own-keep").about_text, null, "c1: merge does not fill the kept row's locked about_text");
      assertEq(get("own-keep").org_nr, null, "c2: merge does not move org_nr onto an owned kept row");
      assertEq(get("own-keep").content_source, "claim", "c3: kept row keeps content_source='claim'");
      assertEq(mr.fields_filled.includes("about_text" as any), false, "c4: about_text not in fields_filled");

      // ── (d) homepage sweep: content refresh ────────────────────────────
      const NEW_TEXT = "Her lager vi sider av egne epler, og du kan besøke gården, se pressehuset og smake på årets sesong i hagen vår hele sommeren.";
      mk({ id: "own-content", navn: "Eid Innhold", content_source: "claim", about_text: "Kort.", field_provenance: lock("about_text") });
      store.applyGardssalgProviderContent("own-content", { about_text: NEW_TEXT, visit_text: NEW_TEXT }, "https://eidinnhold.no");
      assertEq(get("own-content").about_text, "Kort.", "d1: content refresh does not overwrite the locked about_text");
      assertEq(get("own-content").content_source, "claim", "d2: content refresh keeps content_source='claim'");

      // ── (e) homepage sweep: retro scan ─────────────────────────────────
      mk({ id: "own-retro", navn: "Eid Retro", content_source: "claim", about_text: "Eid tekst om gården.", visit_text: "Eid besøkstekst.", field_provenance: lock("about_text") });
      store.applyGardssalgRetroScanNull("own-retro", ["about_text", "visit_text"], "https://eidretro.no");
      assertEq(get("own-retro").about_text, "Eid tekst om gården.", "e1: retro scan does not null the locked about_text");
      assertEq(get("own-retro").content_source, "claim", "e2: retro scan keeps content_source='claim'");

      // ── (f) autosvar ───────────────────────────────────────────────────
      mk({ id: "own-autosvar", navn: "Eid Autosvar", hjemmeside: "https://eidautosvar.no", epost: "gammel@eidautosvar.no", content_source: "claim", field_provenance: "{}" });
      rfbDb.prepare(`INSERT INTO crm_contacts (id, type, agent_id, provider_id, email, name, status, vertical_id) VALUES ('c-os', 'producer', NULL, 'own-autosvar', 'gammel@eidautosvar.no', 'T', 'active', 'experiences')`).run();
      rfbDb.prepare(`INSERT INTO crm_threads (id, contact_id, subject, status, category, vertical_id) VALUES ('t-os', 'c-os', 'Re: outreach', 'new', 'innkommende', 'experiences')`).run();
      rfbDb.prepare(
        `INSERT INTO crm_messages (id, thread_id, direction, from_email, to_emails, subject, body_text, body_html, sent_at, delivery_status, vertical_id)
         VALUES ('m-os', 't-os', 'in', 'gammel@eidautosvar.no', '["outreach@opplevagent.no"]', 'Re: outreach', 'Vennligst ta kontakt med ny@eidautosvar.no fremover, takk.', NULL, '2026-10-01 09:00:00', 'sent', 'experiences')`,
      ).run();
      const asRes = await callRoute(router, { url: "/admin/gardssalg-autosvar-apply", query: { apply: "true" }, headers: auth });
      const asItem = (asRes.body.results as any[] | undefined)?.find((r) => r.provider_id === "own-autosvar");
      assertEq(asItem?.outcome, "owner_locked", "f1: autosvar reports owner_locked on an owned row");
      assertEq(get("own-autosvar").epost, "gammel@eidautosvar.no", "f2: autosvar does not rewrite the locked epost");
      assertEq(get("own-autosvar").content_source, "claim", "f3: autosvar keeps content_source='claim'");
    } catch (err: any) {
      failed++;
      failures.push("opplevelser-gardssalg-owner-lock-everywhere: unexpected error: " + String(err?.stack || err?.message || err));
    } finally {
      globalThis.fetch = prevFetch;
      const restore = (k: string, v: string | undefined) => { if (v === undefined) delete process.env[k]; else process.env[k] = v; };
      restore("EXPERIENCES_DB_PATH", prevExperiencesDbPath);
      restore("ADMIN_KEY", prevAdminKey);
      restore("ANTHROPIC_API_KEY", prevAnthropicKey);
      try {
        const initMod = require("../database/init") as typeof import("../database/init");
        if (prevRfbDb) initMod.__setDbForTesting(prevRfbDb);
      } catch { /* best-effort */ }
      try {
        (require("../database/db-factory") as typeof import("../database/db-factory")).__resetDbFactoryForTesting();
      } catch { /* best-effort */ }
      restoreModuleCache();
    }

    return { passed, failed, failures };
  })();
}

if (require.main === module) {
  runOpplevelserGardssalgOwnerLockEverywhereTests({ log: true }).then((s) => {
    console.log(`\n${s.passed} passed, ${s.failed} failed`);
    process.exit(s.failed > 0 ? 1 : 0);
  });
}
