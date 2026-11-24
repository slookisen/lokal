/**
 * owner-features-s3-1.test.ts — dev-request 2026-10-22-rfb-mine-valg-eierbrytere,
 * slice S3-1: the owner's `auto.affiliations` switch («Vis tilknytninger»)
 * enforced on the producer page (profile_html: the affiliations card) and its
 * JSON-LD (json_ld: memberOf).
 *
 *   off       enforce on + producer allowlisted + key live (registry
 *             override) + stored false → no affiliations card, no memberOf;
 *             a neighbour outside the allowlist keeps both; the umbrella
 *             page (reverse direction) still lists the producer.
 *   gate      enforce off, or the producer not allowlisted → card markup
 *             and memberOf identical to the baseline; no resolve query.
 *   real      the real registry (auto.affiliations coming_soon) + stored
 *             false → unchanged (shown).
 *   fail      a lookup that throws → treated as off (hidden) and logged.
 *
 * Real seo router on the production schema in an in-memory DB; the handler is
 * pulled off the router stack (same harness as owner-features-s2c.test.ts).
 * Exported runOwnerFeaturesS31Tests({log}) -> TestSummary; wired into
 * tests/test.ts. Standalone: npx tsx src/routes/owner-features-s3-1.test.ts
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
const ENF_ID = "s31-owned";
const TWIN_ID = "s31-twin";
const UMB_ID = "s31-umbrella";
const NAMES: Record<string, string> = {
  [ENF_ID]: "Tilknytningsprove Gard Eier",
  [TWIN_ID]: "Tilknytningsprove Gard Tvilling",
  [UMB_ID]: "Bondens marked Prøveby",
};
const KEY = "auto.affiliations";

function seedAgent(db: Database.Database, id: string, umbrellaType: string | null): void {
  db.prepare(
    `INSERT INTO agents
       (id, name, description, provider, contact_email, url, role, api_key, lat, lng, city,
        categories, tags, trust_score, is_active, is_verified, origin, vertical_id, catalog_hidden, claimed_at, umbrella_type, is_vetted)
     VALUES (?, ?, ?, 'test', ?, ?, 'producer', ?, 59.9139, 10.7522, 'Oslo', '["vegetables"]', '[]', 0.7, 1, 1, 'discovery', 'rfb', 0, '2026-10-01T00:00:00.000Z', ?, 1)`,
  ).run(
    id, NAMES[id],
    "Lokal produsent av poteter og grønnsaker i Oslo-området, med gårdsutsalg hver lørdag.",
    `post@${id}.example.no`, `https://${id}.example.no`, `key-${id}`, umbrellaType,
  );
  db.prepare(
    `INSERT INTO agent_knowledge
       (agent_id, email, website, about, products, verification_status, enrichment_status, last_verified_at)
     VALUES (?, ?, ?, ?, '[]', 'verified', 'rich', '2026-01-01T00:00:00.000Z')`,
  ).run(id, `post@${id}.example.no`, `https://${id}.example.no`,
    "Vi er en liten familiegård som dyrker poteter, gulrøtter og kål, og selger direkte fra gården hele året.");
}

export async function runOwnerFeaturesS31Tests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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

    seedAgent(db, ENF_ID, null);
    seedAgent(db, TWIN_ID, null);
    seedAgent(db, UMB_ID, "market_network");
    const aff = db.prepare("INSERT INTO agent_affiliations (producer_id, umbrella_id, status, source) VALUES (?, ?, 'active', 'admin')");
    aff.run(ENF_ID, UMB_ID);
    aff.run(TWIN_ID, UMB_ID);

    const LD_RE = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g;
    const page = async (id: string) => {
      clearRegistryCaches();
      return String((await invoke(produsent, makeReq({ params: { slug: slugify(NAMES[id]) } }))).body ?? "");
    };
    const visibleHtml = async (id: string) => (await page(id)).replace(LD_RE, "");
    const jsonLd = async (id: string) => [...(await page(id)).matchAll(LD_RE)].map((m) => m[1]).join("\n");
    /** [affiliations card in the visible page, memberOf in the JSON-LD]. */
    const state = async (id: string): Promise<[boolean, boolean]> => [
      (await visibleHtml(id)).includes('class="aff-grid"'),
      (await jsonLd(id)).includes('"memberOf"'),
    ];

    /**
     * The affiliations card's markup and the memberOf JSON. The rest of the
     * page is not compared: its «related producers» block is not stable
     * between renders.
     */
    const fingerprint = async (id: string) => {
      const html = await page(id);
      const visible = html.replace(LD_RE, "");
      const at = visible.indexOf('class="aff-grid"');
      const card = at < 0 ? "" : visible.slice(at, visible.indexOf("</div></div>", at));
      const memberOf: string[] = [];
      for (const m of html.matchAll(LD_RE)) {
        try {
          const walk = (x: any) => {
            if (Array.isArray(x)) x.forEach(walk);
            else if (x && typeof x === "object") { if (x.memberOf) memberOf.push(JSON.stringify(x.memberOf)); Object.values(x).forEach(walk); }
          };
          walk(JSON.parse(m[1]));
        } catch { /* not JSON */ }
      }
      return { card, memberOf: memberOf.join("\n") };
    };

    const LIVE = reg.OWNER_FEATURE_REGISTRY.map((e) => (e.key === KEY ? { ...e, status: "live" as const } : e));
    const storeOff = () => db.prepare(
      `INSERT INTO owner_feature_settings (vertical, subject_id, key, value_json, set_by, admin_locked, set_at)
       VALUES ('rfb', ?, ?, 'false', 'owner', 0, ?)`,
    ).run(ENF_ID, KEY, new Date().toISOString());
    const clearChoices = () => db.prepare("DELETE FROM owner_feature_settings WHERE subject_id = ?").run(ENF_ID);

    // ── Baseline: both shown ──────────────────────────────────────────────
    const baseline = await fingerprint(ENF_ID);
    assertTrue(baseline.card.includes(NAMES[UMB_ID]) && baseline.memberOf.includes(NAMES[UMB_ID]), "base-0: card and memberOf name the umbrella");
    assertEq(await state(ENF_ID), [true, true], "base-1: card and memberOf shown by default");
    assertEq(await state(TWIN_ID), [true, true], "base-2: neighbour shows card and memberOf");
    const umbBaseline = await visibleHtml(UMB_ID);
    assertTrue(umbBaseline.includes(NAMES[ENF_ID]), "base-3: umbrella page lists the producer");

    storeOff();

    // ── Gate: unchanged, no lookup ────────────────────────────────────────
    enforce.__setEnforceRegistryForTesting(LIVE);
    {
      setEnv(ENFORCE_ENV, null);
      setEnv(ALLOW_ENV, `rfb:${ENF_ID}`);
      assertEq(await fingerprint(ENF_ID), baseline, "gate-1: enforce flag unset → card and memberOf as before");
      setEnv(ENFORCE_ENV, "0");
      assertEq(await fingerprint(ENF_ID), baseline, "gate-2: enforce flag \"0\" → card and memberOf as before");
      setEnv(ENFORCE_ENV, "1");
      setEnv(ALLOW_ENV, null);
      assertEq(await fingerprint(ENF_ID), baseline, "gate-3: allowlist empty → card and memberOf as before");
      setEnv(ALLOW_ENV, `rfb:${TWIN_ID}`);
      assertEq(await fingerprint(ENF_ID), baseline, "gate-4: another subject allowlisted → card and memberOf as before");

      let queries = 0;
      const realPrepare = db.prepare.bind(db);
      (db as any).prepare = (sql: string) => { queries++; return realPrepare(sql); };
      try {
        setEnv(ENFORCE_ENV, null);
        setEnv(ALLOW_ENV, `rfb:${ENF_ID}`);
        assertEq(enforce.affiliationsSwitchOffAgentIds([ENF_ID]).size, 0, "gate-5: enforce off → nobody off");
        assertEq(queries, 0, "gate-6: enforce off → no query");
        setEnv(ENFORCE_ENV, "1");
        setEnv(ALLOW_ENV, `rfb:${TWIN_ID}`);
        assertEq(enforce.affiliationsSwitchOffAgentIds([ENF_ID]).size, 0, "gate-7: not allowlisted → nobody off");
        assertEq(queries, 0, "gate-8: not allowlisted → no query");
      } finally {
        (db as any).prepare = realPrepare;
      }
    }

    // ── Off: hidden on both surfaces ──────────────────────────────────────
    setEnv(ENFORCE_ENV, "1");
    setEnv(ALLOW_ENV, `rfb:${ENF_ID}`);
    {
      assertEq([...enforce.affiliationsSwitchOffAgentIds([ENF_ID, TWIN_ID])], [ENF_ID], "off-1: only the allowlisted subject with the switch off");
      assertEq(await state(ENF_ID), [false, false], "off-2: no affiliations card, no memberOf");
      assertEq(await state(TWIN_ID), [true, true], "off-3: neighbour outside the allowlist unchanged");
      assertTrue((await visibleHtml(UMB_ID)).includes(NAMES[ENF_ID]), "off-4: umbrella page (reverse direction) still lists the producer");
      clearChoices();
      assertEq(await state(ENF_ID), [true, true], "off-5: switch back to default → shown again");
      storeOff();
    }

    // ── Real registry: coming_soon → no effect ────────────────────────────
    enforce.__setEnforceRegistryForTesting(null);
    {
      assertEq(enforce.affiliationsSwitchOffAgentIds([ENF_ID]).size, 0, "real-1: coming_soon key → nobody off");
      assertEq(await state(ENF_ID), [true, true], "real-2: coming_soon + stored false → card and memberOf shown");
    }
    enforce.__setEnforceRegistryForTesting(LIVE);

    // ── Fail closed ───────────────────────────────────────────────────────
    {
      const errs: string[] = [];
      const prevErr = console.error;
      console.error = (...a: any[]) => { errs.push(a.map(String).join(" ")); };
      try {
        const throwingDb = { prepare() { throw new Error("boom"); } };
        const env = { [ENFORCE_ENV]: "1", [ALLOW_ENV]: `rfb:${ENF_ID}` } as NodeJS.ProcessEnv;
        assertEq([...enforce.affiliationsSwitchOffAgentIds([ENF_ID, TWIN_ID], { db: throwingDb, env })], [ENF_ID],
          "fail-1: a failed lookup counts the allowlisted subject as off");
        clearChoices(); // stored default: only the failure can hide it now
        db.exec("ALTER TABLE owner_feature_settings RENAME TO owner_feature_settings_s31");
        try {
          assertEq(await state(ENF_ID), [false, false], "fail-2: lookup throws on the page → card and memberOf hidden");
        } finally {
          db.exec("ALTER TABLE owner_feature_settings_s31 RENAME TO owner_feature_settings");
        }
        assertTrue(errs.some((e) => e.includes("auto.affiliations lookup failed")), "fail-3: the failure is logged");
      } finally {
        console.error = prevErr;
      }
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
  runOwnerFeaturesS31Tests({ log: true }).then((r) => {
    console.info(`\nowner-features-s3-1: ${r.passed} passed, ${r.failed} failed`);
    if (r.failed) {
      for (const f of r.failures) console.info(f);
      process.exit(1);
    }
    process.exit(0);
  });
}
