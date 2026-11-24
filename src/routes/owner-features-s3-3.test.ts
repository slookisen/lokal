/**
 * owner-features-s3-3.test.ts — dev-request 2026-10-22-rfb-mine-valg-eierbrytere,
 * slice S3-3: the owner's `auto.categories` switch («Plasser meg i
 * salgskanaler automatisk») enforced in the salgskanal sweep
 * (job:salgskanal_matcher) and on the producer page (profile_html: the
 * channel signal behind the answer-first opening's «selger»).
 *
 *   AK1 off     enforce on + producer allowlisted + key live (registry
 *               override) + stored false → the sweep inserts/refreshes no
 *               auto row and deletes the producer's auto rows
 *               (removed_switch_off); the manual row stays; a neighbour
 *               outside the allowlist is swept as before.
 *   AK2 gate    enforce off, or the producer not allowlisted → sweep result
 *               and rows identical to the baseline, same query count.
 *   AK3 fail    the switch lookup throws → the producer's rows are untouched
 *               by the sweep (no insert/refresh/delete), logged and in
 *               errors; the page hides the auto rows (fail closed).
 *   AK4 real    the real registry (auto.categories coming_soon) + stored
 *               false → sweep and page unchanged.
 *   AK5 on      off → on again → the next sweep restores the auto rows.
 *   page        with the switch off the page counts only manual rows, before
 *               any sweep runs.
 *
 * Real sweep and seo router on the production schema in an in-memory DB.
 * Exported runOwnerFeaturesS33Tests({log}) -> TestSummary; wired into
 * tests/test.ts. Standalone: npx tsx src/routes/owner-features-s3-3.test.ts
 */

import Database from "better-sqlite3";
import { slugify } from "../utils/slug";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

const ALLOW_ENV = "OWNER_FEATURES_ALLOWED_SUBJECTS";
const ENFORCE_ENV = "OWNER_FEATURES_ENFORCE";
const ENF_ID = "s33-owned";
const TWIN_ID = "s33-twin";
const NAMES: Record<string, string> = {
  [ENF_ID]: "Salgskanalprove Gard Eier",
  [TWIN_ID]: "Salgskanalprove Gard Tvilling",
};
const KEY = "auto.categories";
const NOW = "2026-11-24T05:00:00.000Z";

function seedAgent(db: Database.Database, id: string): void {
  db.prepare(
    `INSERT INTO agents
       (id, name, description, provider, contact_email, url, role, api_key, lat, lng, city,
        categories, tags, trust_score, is_active, is_verified, origin, vertical_id, catalog_hidden, claimed_at, umbrella_type, is_vetted)
     VALUES (?, ?, ?, 'test', ?, ?, 'producer', ?, 59.9139, 10.7522, 'Oslo', '["vegetables"]', '[]', 0.7, 1, 1, 'discovery', 'rfb', 0, '2026-10-01T00:00:00.000Z', NULL, 1)`,
  ).run(
    id, NAMES[id],
    "Lokal produsent av poteter og grønnsaker i Oslo-området, med gårdsutsalg hver lørdag og selvplukk av jordbær om sommeren.",
    `post@${id}.example.no`, `https://${id}.example.no`, `key-${id}`,
  );
  db.prepare(
    `INSERT INTO agent_knowledge
       (agent_id, email, website, about, products, field_provenance, verification_status, enrichment_status, last_verified_at)
     VALUES (?, ?, ?, ?, ?, ?, 'verified', 'rich', '2026-01-01T00:00:00.000Z')`,
  ).run(id, `post@${id}.example.no`, `https://${id}.example.no`,
    "Vi er en liten familiegård som dyrker poteter, gulrøtter og kål, og selger direkte fra gården hele året.",
    JSON.stringify([{ name: "Poteter" }, { name: "Gulrøtter" }]),
    JSON.stringify({ products: [{ value: "Poteter, Gulrøtter", source_type: "website" }] }));
}

export async function runOwnerFeaturesS33Tests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];

  function assertEq(actual: unknown, expected: unknown, label: string): void {
    if (JSON.stringify(actual) === JSON.stringify(expected)) {
      passed++;
      if (log) console.info(`  ok ${label}`);
    } else {
      failed++;
      const msg = `✗ ${label}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`;
      failures.push(msg);
      if (log) console.info("  " + msg);
    }
  }
  function assertTrue(cond: boolean, label: string): void {
    if (cond) {
      passed++;
      if (log) console.info(`  ok ${label}`);
    } else {
      failed++;
      failures.push(`✗ ${label}`);
      if (log) console.info(`  ✗ ${label}`);
    }
  }

  const initMod = require("../database/init") as typeof import("../database/init");
  const prevDb = initMod.__peekDbForTesting();
  const prevAllow = process.env[ALLOW_ENV];
  const prevEnforce = process.env[ENFORCE_ENV];
  const setEnv = (name: string, v: string | null) => { if (v === null) delete process.env[name]; else process.env[name] = v; };

  function findRouteHandler(router: any, path: string, method: "get"): Function {
    const layer = (router.stack as any[]).find(
      (l: any) => l.route && l.route.path === path && l.route.methods?.[method],
    );
    if (!layer) throw new Error(`route not found: ${method.toUpperCase()} ${path}`);
    return layer.route.stack[layer.route.stack.length - 1].handle;
  }
  function makeReq(o: { params?: Record<string, string> }): any {
    const headers: Record<string, string> = {};
    return {
      method: "GET", url: "/", path: "/", originalUrl: "/",
      params: o.params || {}, query: {}, headers, cookies: {},
      ip: "127.0.0.1", lang: "no", protocol: "https", hostname: "rettfrabonden.com",
      get(name: string) { return name.toLowerCase() === "host" ? "rettfrabonden.com" : headers[name.toLowerCase()]; },
    };
  }
  function invoke(handler: Function, req: any): Promise<{ status: number; body: any }> {
    return new Promise((resolve) => {
      let status = 200;
      let settled = false;
      const settle = (body: any) => { if (!settled) { settled = true; resolve({ status, body }); } };
      const res: any = {
        status(c: number) { status = c; return res; },
        json(p: any) { settle(p); return res; },
        send(p: any) { settle(p); return res; },
        redirect(c: number, loc: string) { status = c; settle({ __redirect: loc }); return res; },
        end() { settle(undefined); return res; },
        header() { return res; }, set() { return res; }, type() { return res; }, setHeader() { return res; },
      };
      try {
        const p = handler(req, res, (err?: any) => settle({ __next: true, err: err ? String(err) : undefined }));
        if (p && typeof p.catch === "function") p.catch((err: any) => settle({ __error: String(err) }));
      } catch (err) {
        settle({ __error: String(err) });
      }
    });
  }

  const { marketplaceRegistry } = require("../services/marketplace-registry") as typeof import("../services/marketplace-registry");
  const clearRegistryCaches = () => {
    marketplaceRegistry._agentsCache = null;
    marketplaceRegistry._statsCache = null;
    marketplaceRegistry._agentsCacheTime = 0;
    marketplaceRegistry._statsCacheTime = 0;
  };

  const db = new Database(":memory:");
  db.pragma("journal_mode = DELETE");
  db.pragma("foreign_keys = ON");

  const prevLog = console.log;
  if (!log) console.log = () => { /* silence registry/seo chatter */ };

  const enforce = require("../owner-features/enforce") as typeof import("../owner-features/enforce");
  const { runSalgskanalSweep } = require("../services/salgskanal-matcher") as typeof import("../services/salgskanal-matcher");

  try {
    initMod.__setDbForTesting(db as any);
    initMod.__initSchemaForTesting(db as any);
    const { loadConfigsAtBoot } = require("../config/vertical-config") as typeof import("../config/vertical-config");
    try { loadConfigsAtBoot(); } catch { /* already loaded by another suite */ }
    clearRegistryCaches();
    setEnv(ALLOW_ENV, null);
    setEnv(ENFORCE_ENV, null);

    try { delete require.cache[require.resolve("./seo")]; } catch { /* not loaded yet */ }
    const seoRouter = (require("./seo") as typeof import("./seo")).default as any;
    const reg = require("../owner-features/registry") as typeof import("../owner-features/registry");
    const produsent = findRouteHandler(seoRouter, "/produsent/:slug", "get");

    seedAgent(db, ENF_ID);
    seedAgent(db, TWIN_ID);
    const insertManual = () => db.prepare(
      `INSERT INTO agent_salgskanal (agent_id, category_slug, source, created_at, updated_at)
       VALUES (?, 'hjemlevering', 'manual', ?, ?)`,
    ).run(ENF_ID, NOW, NOW);
    insertManual();

    type Row = { agent_id: string; category_slug: string; source: string; matched_keywords: string | null; updated_at: string };
    const rows = (id?: string): Row[] => (db.prepare(
      `SELECT agent_id, category_slug, source, matched_keywords, updated_at FROM agent_salgskanal
       ${id ? "WHERE agent_id = ?" : ""} ORDER BY agent_id, category_slug`,
    ).all(...(id ? [id] : [])) as Row[]);
    const slugs = (id: string, source?: string) => rows(id).filter((r) => !source || r.source === source).map((r) => r.category_slug);

    /** Run the sweep, counting the statements it prepares. */
    const sweep = (nowIso = NOW) => {
      let queries = 0;
      const realPrepare = db.prepare.bind(db);
      (db as any).prepare = (sql: string) => { queries++; return realPrepare(sql); };
      try {
        const result = runSalgskanalSweep({ db: db as any, nowIso });
        return { result, queries };
      } finally {
        (db as any).prepare = realPrepare;
      }
    };

    const opening = async (id: string) => {
      clearRegistryCaches();
      const html = String((await invoke(produsent, makeReq({ params: { slug: slugify(NAMES[id]) } }))).body ?? "");
      const m = html.match(/<p class="pf-answer">([\s\S]*?)<\/p>/);
      return m ? m[1] : "";
    };
    const sells = async (id: string) => (await opening(id)).includes(" selger ");

    const LIVE = reg.OWNER_FEATURE_REGISTRY.map((e) => (e.key === KEY ? { ...e, status: "live" as const } : e));
    const storeOff = () => db.prepare(
      `INSERT INTO owner_feature_settings (vertical, subject_id, key, value_json, set_by, admin_locked, set_at)
       VALUES ('rfb', ?, ?, 'false', 'owner', 0, ?)`,
    ).run(ENF_ID, KEY, new Date().toISOString());
    const clearChoices = () => db.prepare("DELETE FROM owner_feature_settings WHERE subject_id = ?").run(ENF_ID);

    // ── Baseline: gate off, sweep places both producers ───────────────────
    const first = sweep();
    assertEq(first.result.upserted, 4, "base-1: first sweep inserts 2 auto rows per producer");
    assertEq(first.result.removed_switch_off, 0, "base-2: removed_switch_off is 0");
    assertEq(slugs(ENF_ID, "auto"), ["gardsbutikk", "selvplukk"], "base-3: owned producer has its auto rows");
    assertEq(slugs(ENF_ID, "manual"), ["hjemlevering"], "base-4: manual row present");
    const baseline = sweep();
    const baselineRows = rows();
    assertEq([baseline.result.upserted, baseline.result.refreshed], [0, 4], "base-5: re-run refreshes, no insert");
    assertTrue((await opening(ENF_ID)).length > 0, "base-6: the answer-first opening renders");
    assertTrue(await sells(ENF_ID), "base-7: channel rows → the opening says «selger»");

    storeOff();
    enforce.__setEnforceRegistryForTesting(LIVE);

    // ── AK2 gate: unchanged, no extra lookup ──────────────────────────────
    {
      const cases: Array<[string, string | null, string | null]> = [
        ["enforce flag unset", null, `rfb:${ENF_ID}`],
        ["enforce flag \"0\"", "0", `rfb:${ENF_ID}`],
        ["allowlist empty", "1", null],
        ["another subject allowlisted", "1", "rfb:s33-someone-else"],
      ];
      cases.forEach(([label, enf, allow], i) => {
        setEnv(ENFORCE_ENV, enf);
        setEnv(ALLOW_ENV, allow);
        const r = sweep();
        assertEq(r.result, baseline.result, `ak2-${i + 1}a: ${label} → sweep result as before`);
        assertEq(rows(), baselineRows, `ak2-${i + 1}b: ${label} → rows as before`);
        assertEq(r.queries, baseline.queries, `ak2-${i + 1}c: ${label} → no extra query`);
      });
      for (const [label, enf, allow] of cases) {
        setEnv(ENFORCE_ENV, enf);
        setEnv(ALLOW_ENV, allow);
        assertTrue(await sells(ENF_ID), `ak2-page: ${label} → page as before («selger»)`);
      }

      let queries = 0;
      const realPrepare = db.prepare.bind(db);
      (db as any).prepare = (sql: string) => { queries++; return realPrepare(sql); };
      try {
        setEnv(ENFORCE_ENV, null);
        setEnv(ALLOW_ENV, `rfb:${ENF_ID}`);
        assertEq(enforce.categoriesSwitchOffAgentIds([ENF_ID]).size, 0, "ak2-5: enforce off → nobody off");
        const s1 = enforce.categoriesSweepSwitchState([ENF_ID, TWIN_ID]);
        assertEq([s1.off.size, s1.failed.size, s1.error], [0, 0, null], "ak2-6: enforce off → sweep state empty");
        setEnv(ENFORCE_ENV, "1");
        setEnv(ALLOW_ENV, `rfb:${TWIN_ID}`);
        assertEq(enforce.categoriesSwitchOffAgentIds([ENF_ID]).size, 0, "ak2-7: not allowlisted → nobody off");
        const s2 = enforce.categoriesSweepSwitchState([ENF_ID]);
        assertEq([s2.off.size, s2.failed.size, s2.error], [0, 0, null], "ak2-8: not allowlisted → sweep state empty");
        assertEq(queries, 0, "ak2-9: outside the gate → no query");
      } finally {
        (db as any).prepare = realPrepare;
      }
    }

    // ── Page: off counts only manual rows, before any sweep ───────────────
    setEnv(ENFORCE_ENV, "1");
    setEnv(ALLOW_ENV, `rfb:${ENF_ID}`);
    {
      assertEq([...enforce.categoriesSwitchOffAgentIds([ENF_ID, TWIN_ID])], [ENF_ID], "page-1: only the allowlisted subject with the switch off");
      assertEq(slugs(ENF_ID, "auto"), ["gardsbutikk", "selvplukk"], "page-2: auto rows still stored (no sweep yet)");
      assertTrue(await sells(ENF_ID), "page-3: off + a manual row → still «selger» (manual counts)");
      db.prepare("DELETE FROM agent_salgskanal WHERE agent_id = ? AND source = 'manual'").run(ENF_ID);
      const o = await opening(ENF_ID);
      assertTrue(o.length > 0 && !o.includes(" selger ") && o.includes(" produserer "), "page-4: off, only auto rows → auto rows not counted («produserer»)");
      assertTrue(await sells(TWIN_ID), "page-5: neighbour outside the allowlist unchanged");
      insertManual();
    }

    // ── AK1 off: no auto placement, auto rows deleted, manual kept ────────
    {
      const twinBefore = rows(TWIN_ID);
      const r = sweep();
      assertEq(r.result.removed_switch_off, 2, "ak1-1: the producer's 2 auto rows are counted as removed_switch_off");
      assertEq(slugs(ENF_ID, "auto"), [], "ak1-2: no auto rows left for the producer");
      assertEq(slugs(ENF_ID, "manual"), ["hjemlevering"], "ak1-3: manual row untouched");
      assertEq([r.result.upserted, r.result.refreshed, r.result.removed_stale], [0, 2, 0], "ak1-4: only the neighbour is refreshed");
      assertEq(rows(TWIN_ID), twinBefore, "ak1-5: neighbour's rows as before");
      assertEq(r.result.errors, [], "ak1-6: no errors");
      const again = sweep("2026-11-25T05:00:00.000Z");
      assertEq([again.result.upserted, again.result.removed_switch_off], [0, 0], "ak1-7: next sweep inserts nothing for the producer");
      assertEq(slugs(ENF_ID, "auto"), [], "ak1-8: still no auto rows");
      assertEq(rows(ENF_ID).map((r) => r.updated_at), [NOW], "ak1-9: manual row not refreshed");
    }

    // ── AK4 real registry: coming_soon → unchanged ────────────────────────
    enforce.__setEnforceRegistryForTesting(null);
    {
      assertEq(enforce.categoriesSwitchOffAgentIds([ENF_ID]).size, 0, "ak4-1: coming_soon key → nobody off");
      const r = sweep();
      assertEq([r.result.upserted, r.result.removed_switch_off], [2, 0], "ak4-2: coming_soon + stored false → sweep places the producer as before");
      assertEq(slugs(ENF_ID, "auto"), ["gardsbutikk", "selvplukk"], "ak4-3: auto rows back");
      db.prepare("DELETE FROM agent_salgskanal WHERE agent_id = ? AND source = 'manual'").run(ENF_ID);
      assertTrue(await sells(ENF_ID), "ak4-4: coming_soon + stored false → page counts auto rows");
      insertManual();
    }
    enforce.__setEnforceRegistryForTesting(LIVE);

    // ── AK5: off → on again restores on the next sweep ────────────────────
    {
      const off = sweep();
      assertEq(off.result.removed_switch_off, 2, "ak5-1: off again → auto rows removed");
      clearChoices();
      const on = sweep();
      assertEq([on.result.upserted, on.result.removed_switch_off], [2, 0], "ak5-2: switch back on → next sweep re-inserts the auto rows");
      assertEq(slugs(ENF_ID, "auto"), ["gardsbutikk", "selvplukk"], "ak5-3: auto rows restored");
      assertEq(slugs(ENF_ID, "manual"), ["hjemlevering"], "ak5-4: manual row kept throughout");
    }

    // ── AK3 fail: rows untouched by the sweep, page fails closed ──────────
    {
      storeOff();
      // A stale auto row and an edited auto row: a normal sweep would delete
      // / refresh them; a failed lookup must leave both as they are.
      db.prepare(
        `INSERT INTO agent_salgskanal (agent_id, category_slug, source, matched_keywords, created_at, updated_at)
         VALUES (?, 'reko-ring', 'auto', '["stale"]', ?, ?)`,
      ).run(ENF_ID, NOW, NOW);
      db.prepare(`UPDATE agent_salgskanal SET matched_keywords = '["edited"]' WHERE agent_id = ? AND category_slug = 'selvplukk'`).run(ENF_ID);
      db.prepare(
        `INSERT INTO agent_salgskanal (agent_id, category_slug, source, matched_keywords, created_at, updated_at)
         VALUES (?, 'reko-ring', 'auto', '["stale"]', ?, ?)`,
      ).run(TWIN_ID, NOW, NOW);
      const enfBefore = rows(ENF_ID);

      const errs: string[] = [];
      const prevErr = console.error;
      console.error = (...a: any[]) => { errs.push(a.map(String).join(" ")); };
      db.exec("ALTER TABLE owner_feature_settings RENAME TO owner_feature_settings_s33");
      try {
        const r = sweep("2026-11-26T05:00:00.000Z");
        assertEq(rows(ENF_ID), enfBefore, "ak3-1: lookup throws → the producer's rows untouched (no insert, refresh or delete)");
        assertEq(r.result.removed_switch_off, 0, "ak3-2: nothing deleted on a failed lookup");
        assertTrue(r.result.errors.some((e) => e.includes("auto.categories lookup failed")), "ak3-3: the failure is recorded in errors");
        assertEq(slugs(TWIN_ID, "auto"), ["gardsbutikk", "selvplukk"], "ak3-4: neighbour outside the gate still swept (stale row removed)");
        assertEq(r.result.removed_stale, 1, "ak3-5: only the neighbour's stale row removed");
        assertTrue(errs.some((e) => e.includes("auto.categories lookup failed")), "ak3-6: the failure is logged");

        const s = enforce.categoriesSweepSwitchState([ENF_ID, TWIN_ID]);
        assertEq([[...s.failed], s.off.size, typeof s.error], [[ENF_ID], 0, "string"], "ak3-7: sweep state marks only the gated id as failed");
      } finally {
        db.exec("ALTER TABLE owner_feature_settings_s33 RENAME TO owner_feature_settings");
        console.error = prevErr;
      }

      // Page: only the auto.categories resolution throws (a registry without
      // the key → UnknownOwnerFeatureError), the rest of the page resolves.
      db.prepare("DELETE FROM agent_salgskanal WHERE agent_id = ? AND source = 'manual'").run(ENF_ID);
      clearChoices(); // stored default: only the failure can hide the auto rows now
      enforce.__setEnforceRegistryForTesting(LIVE.filter((e) => e.key !== KEY));
      const pageErrs: string[] = [];
      console.error = (...a: any[]) => { pageErrs.push(a.map(String).join(" ")); };
      try {
        assertEq(slugs(ENF_ID, "auto").length > 0, true, "ak3-8: auto rows stored");
        const o = await opening(ENF_ID);
        assertTrue(o.length > 0 && !o.includes(" selger ") && o.includes(" produserer "), "ak3-9: lookup throws on the page → auto rows hidden («produserer»)");
        assertTrue(pageErrs.some((e) => e.includes("auto.categories lookup failed")), "ak3-10: the page failure is logged");
      } finally {
        console.error = prevErr;
        enforce.__setEnforceRegistryForTesting(LIVE);
      }
      assertTrue(await sells(ENF_ID), "ak3-11: lookup working again, switch on → auto rows counted");
    }
  } catch (err: any) {
    failed++;
    failures.push(`✗ unexpected error: ${String(err?.stack || err)}`);
  } finally {
    console.log = prevLog;
    enforce.__setEnforceRegistryForTesting(null);
    setEnv(ALLOW_ENV, prevAllow ?? null);
    setEnv(ENFORCE_ENV, prevEnforce ?? null);
    if (prevDb) initMod.__setDbForTesting(prevDb as any);
    clearRegistryCaches();
    try { db.close(); } catch { /* ignore */ }
  }

  return { passed, failed, failures };
}

if (require.main === module) {
  runOwnerFeaturesS33Tests({ log: true }).then((r) => {
    console.info(`\nowner-features-s3-3: ${r.passed} passed, ${r.failed} failed`);
    if (r.failed) {
      for (const f of r.failures) console.info(f);
      process.exit(1);
    }
    process.exit(0);
  });
}
