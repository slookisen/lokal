/**
 * owner-pending-profile-view-s4a.test.ts — dev-request
 * 2026-11-10-rfb-registreringer-og-eierkrav-folges-opp, slice S4a
 * (flag OWNER_PENDING_PROFILE_VIEW_ENABLED, default OFF).
 *
 *   off     flag off → the verified owner of an unvetted self-registered
 *           profile gets the same 404 as everyone else (body + headers).
 *   owner   flag on + a verified owner session for exactly that agent → 200
 *           «Under godkjenning», noindex + private/no-store, only the name,
 *           no JSON-LD, no contact card; is_vetted unchanged (no write).
 *   others  flag on + no session / another agent's session / owner not
 *           verified / row not listable (catalog_hidden) / role-gate fail →
 *           the unchanged 404.
 *   vetted  flag on + a vetted profile → the normal page, identical to flag off.
 *
 * Real seo + owner-portal routers on the production schema in an in-memory
 * DB; the handler is pulled off the router stack (same harness as
 * owner-pause-s1b6.test.ts). Exported runOwnerPendingProfileViewS4aTests({log})
 * -> TestSummary; wired into tests/test.ts.
 * Standalone: npx tsx src/routes/owner-pending-profile-view-s4a.test.ts
 */

import Database from "better-sqlite3";
import { slugify } from "../utils/slug";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

interface HandlerResult {
  status: number;
  body: any;
  headers: Record<string, string>;
}

const FLAG = "OWNER_PENDING_PROFILE_VIEW_ENABLED";
const PENDING_ID = "s4a-pending";           // self-registered, not vetted, verified claim
const UNVERIFIED_ID = "s4a-unverified";     // self-registered, not vetted, no verified owner
const HIDDEN_ID = "s4a-hidden";             // self-registered, not vetted, verified claim, catalog_hidden
const ROLE_ID = "s4a-role";                 // self-registered, not vetted, verified claim, role=logistics
const OTHER_VERTICAL_ID = "s4a-dental";     // self-registered, not vetted, verified claim, vertical_id=dental
const VETTED_ID = "s4a-vetted";             // self-registered, vetted, verified claim
const NAMES: Record<string, string> = {
  [PENDING_ID]: "Godkjenningsprove Gard Venter",
  [UNVERIFIED_ID]: "Godkjenningsprove Gard Ubekreftet",
  [HIDDEN_ID]: "Godkjenningsprove Gard Skjult",
  [ROLE_ID]: "Godkjenningsprove Gard Logistikk",
  [OTHER_VERTICAL_ID]: "Godkjenningsprove Gard Tannlege",
  [VETTED_ID]: "Godkjenningsprove Gard Godkjent",
};

const NO_TEXT = "Vi ser over profilen innen to virkedager. Til den er godkjent, er det bare du som ser denne siden. Har du spørsmål, svar på e-posten fra oss eller skriv til kundeservice.";
const EN_TEXT = "We review the profile within two working days. Until it is approved, only you can see this page. Questions? Reply to our e-mail or contact customer service.";

function seed(
  db: Database.Database,
  id: string,
  o: { vetted: number; claimed: boolean; role?: string; catalogHidden?: number; vertical?: string },
): void {
  db.prepare(
    `INSERT INTO agents
       (id, name, description, provider, contact_email, url, role, api_key, lat, lng, city,
        categories, tags, trust_score, is_active, is_verified, is_vetted, origin, vertical_id, catalog_hidden)
     VALUES (?, ?, ?, 'self', ?, ?, ?, ?, 59.9139, 10.7522, 'Oslo', '["vegetables"]', '[]', 0.5, 1, 0, ?, 'self_registered', ?, ?)`,
  ).run(
    id, NAMES[id],
    "Lokal produsent av poteter og grønnsaker i Oslo-området, med gårdsutsalg hver lørdag.",
    `post@${id}.example.no`, `https://${id}.example.no`, o.role ?? "producer", `key-${id}`,
    o.vetted, o.vertical ?? "rfb", o.catalogHidden ?? 0,
  );
  db.prepare(
    `INSERT INTO agent_knowledge (agent_id, email, phone, website, about, verification_status)
     VALUES (?, ?, '+47 400 00 000', ?, ?, 'verified')`,
  ).run(id, `post@${id}.example.no`, `https://${id}.example.no`, "Vi er en liten familiegård som dyrker poteter og selger direkte fra gården.");
  if (o.claimed) {
    db.prepare(
      "INSERT INTO agent_claims (id, agent_id, claimant_email, claimant_name, status, claim_token, claim_token_expires_at, verified_at) VALUES (?, ?, ?, 'Eier', 'verified', ?, ?, datetime('now'))",
    ).run(`claim-${id}`, id, `post@${id}.example.no`, `claimtok-${id}`, new Date(Date.now() + 86_400_000).toISOString());
  }
  db.prepare("INSERT INTO magic_links (id, email, token, agent_id, used, created_at, expires_at) VALUES (?, ?, ?, ?, 1, ?, ?)")
    .run(`mlsess_${id}`, `post@${id}.example.no`, `tok-${id}`, id, new Date().toISOString(), new Date(Date.now() + 86_400_000).toISOString());
}

export async function runOwnerPendingProfileViewS4aTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
  const prevFlag = process.env[FLAG];
  const setFlag = (on: boolean) => { if (on) process.env[FLAG] = "1"; else delete process.env[FLAG]; };

  function findRouteHandler(router: any, path: string, method: "get" | "post"): Function {
    const layer = (router.stack as any[]).find(
      (l: any) => l.route && l.route.path === path && l.route.methods?.[method],
    );
    if (!layer) throw new Error(`route not found: ${method.toUpperCase()} ${path}`);
    return layer.route.stack[layer.route.stack.length - 1].handle;
  }
  function makeReq(o: { slug: string; cookieToken?: string; bearer?: string; lang?: "no" | "en" }): any {
    const headers: Record<string, string> = {};
    if (o.cookieToken) headers.cookie = `rfb_owner_session=${o.cookieToken}`;
    if (o.bearer) headers.authorization = `Bearer ${o.bearer}`;
    const p = `/produsent/${o.slug}`;
    return {
      method: "GET", url: p, path: p, originalUrl: p,
      params: { slug: o.slug }, body: undefined, query: {}, headers, cookies: {},
      ip: "127.0.0.1", lang: o.lang ?? "no", protocol: "https", hostname: "rettfrabonden.com",
      get(name: string) { return name.toLowerCase() === "host" ? "rettfrabonden.com" : headers[name.toLowerCase()]; },
    };
  }
  function invoke(handler: Function, req: any): Promise<HandlerResult> {
    return new Promise((resolve) => {
      let status = 200;
      let settled = false;
      const headers: Record<string, string> = {};
      const settle = (body: any) => { if (!settled) { settled = true; resolve({ status, body, headers }); } };
      const res: any = {
        status(c: number) { status = c; return res; },
        json(p: any) { settle(p); return res; },
        send(p: any) { settle(p); return res; },
        redirect(c: number, loc: string) { status = c; settle({ __redirect: loc }); return res; },
        end() { settle(undefined); return res; },
        header(k: any, v?: any) { return res.set(k, v); },
        set(k: any, v?: any) {
          if (typeof k === "string") headers[k.toLowerCase()] = String(v);
          else if (k && typeof k === "object") for (const [kk, vv] of Object.entries(k)) headers[kk.toLowerCase()] = String(vv);
          return res;
        },
        type() { return res; },
        setHeader(k: string, v: string) { headers[k.toLowerCase()] = String(v); return res; },
        getHeader(k: string) { return headers[k.toLowerCase()]; },
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
  const routeModules = ["./seo", "./owner-portal"];

  const db = new Database(":memory:");
  db.pragma("journal_mode = DELETE");
  db.pragma("foreign_keys = ON");

  const prevLog = console.log;
  const logLines: string[] = [];
  console.log = (...args: any[]) => { logLines.push(args.map(String).join(" ")); if (log) prevLog(...args); };

  try {
    initMod.__setDbForTesting(db as any);
    initMod.__initSchemaForTesting(db as any);
    const { loadConfigsAtBoot } = require("../config/vertical-config") as typeof import("../config/vertical-config");
    try { loadConfigsAtBoot(); } catch { /* already loaded by another suite */ }
    clearRegistryCaches();
    for (const m of routeModules) {
      try { delete require.cache[require.resolve(m)]; } catch { /* not loaded yet */ }
    }
    const seoMod = require("./seo") as typeof import("./seo");
    const produsent = findRouteHandler(seoMod.default as any, "/produsent/:slug", "get");

    seed(db, PENDING_ID, { vetted: 0, claimed: true });
    seed(db, UNVERIFIED_ID, { vetted: 0, claimed: false });
    seed(db, HIDDEN_ID, { vetted: 0, claimed: true, catalogHidden: 1 });
    seed(db, ROLE_ID, { vetted: 0, claimed: true, role: "logistics" });
    seed(db, OTHER_VERTICAL_ID, { vetted: 0, claimed: true, vertical: "dental" });
    seed(db, VETTED_ID, { vetted: 1, claimed: true });
    clearRegistryCaches();

    const page = (id: string, o: { cookieToken?: string; bearer?: string; lang?: "no" | "en" } = {}) =>
      invoke(produsent, makeReq({ slug: slugify(NAMES[id]), ...o }));
    const tok = (id: string) => `tok-${id}`;
    const isVetted = (id: string) => (db.prepare("SELECT is_vetted FROM agents WHERE id = ?").get(id) as { is_vetted: number }).is_vetted;

    // ═══ Flag off: byte-identical 404 ═══════════════════════════════════════
    setFlag(false);
    const offNoSession = await page(PENDING_ID);
    const offOwner = await page(PENDING_ID, { cookieToken: tok(PENDING_ID) });
    assertEq(offOwner.status, 404, "off-1: flag off → verified owner with a valid session still gets 404");
    assertEq(offNoSession.status, 404, "off-2: flag off → no session gets 404");
    assertEq(String(offOwner.body), String(offNoSession.body), "off-3: flag off → owner's 404 body identical to the anonymous 404");
    assertEq(offOwner.headers, offNoSession.headers, "off-4: flag off → owner's 404 headers identical to the anonymous 404");
    assertTrue(!String(offOwner.body).includes("Under godkjenning"), "off-5: flag off → no «Under godkjenning» text");
    assertTrue(!logLines.some((l) => l.includes("owner pending view")), "off-6: flag off → no owner-pending log line");
    const offVetted = await page(VETTED_ID, { cookieToken: tok(VETTED_ID) });

    // ═══ Flag on ═══════════════════════════════════════════════════════════
    setFlag(true);
    {
      const r = await page(PENDING_ID, { cookieToken: tok(PENDING_ID) });
      const html = String(r.body ?? "");
      assertEq(r.status, 200, "on-1: verified owner (cookie) of own pending profile → 200");
      assertTrue(html.includes(`Under godkjenning — ${NAMES[PENDING_ID]}`), "on-2: title «Under godkjenning — {navn}»");
      assertTrue(html.includes(`<strong>Profilen din er under godkjenning</strong>`), "on-3: bold line «Profilen din er under godkjenning»");
      assertTrue(html.includes(NO_TEXT), "on-4: the Norwegian paragraph, exact");
      assertTrue(html.includes(`>${NAMES[PENDING_ID]}</h1>`), "on-5: heading = the name");
      assertEq(r.headers["x-robots-tag"], "noindex", "on-6: X-Robots-Tag: noindex");
      assertEq(r.headers["cache-control"], "private, no-store", "on-7: Cache-Control: private, no-store");
      assertTrue(/<meta name="robots" content="noindex/.test(html), "on-8: robots meta noindex");
      assertTrue(!html.includes("application/ld+json"), "on-9: no JSON-LD");
      assertTrue(!html.includes(`post@${PENDING_ID}.example.no`) && !html.includes("400 00 000") && !html.includes("ct-item"), "on-10: no contact card / e-mail / phone");
      assertTrue(!html.includes("familiegård"), "on-11: no producer description");
      assertTrue(html.includes(`href="/eier/${PENDING_ID}/portal"`), "on-12: link to the owner portal");
      assertTrue(logLines.some((l) => l === `[seo:quarantine-gate] owner pending view for agent ${PENDING_ID}`), "on-13: log line with the agent id");
      assertTrue(!logLines.some((l) => l.includes("owner pending view") && (l.includes("@") || l.includes(tok(PENDING_ID)))), "on-14: log line has no e-mail or token");
      assertEq(isVetted(PENDING_ID), 0, "on-15: is_vetted unchanged after the request (no write)");

      const b = await page(PENDING_ID, { bearer: tok(PENDING_ID) });
      assertEq(b.status, 200, "on-16: Bearer session works the same way");

      const en = await page(PENDING_ID, { cookieToken: tok(PENDING_ID), lang: "en" });
      const enHtml = String(en.body ?? "");
      assertEq(en.status, 200, "on-17: English → 200");
      assertTrue(enHtml.includes(`Under review — ${NAMES[PENDING_ID]}`) && enHtml.includes("Your profile is under review") && enHtml.includes(EN_TEXT), "on-18: English texts");
    }

    // ═══ Flag on: everyone else keeps the 404 ══════════════════════════════
    {
      const anon = await page(PENDING_ID);
      assertEq(anon.status, 404, "others-1: flag on + no session → 404");
      assertEq(String(anon.body), String(offNoSession.body), "others-2: …byte-identical to the flag-off 404");
      assertEq(anon.headers, offNoSession.headers, "others-3: …with the same headers");
      const cross = await page(PENDING_ID, { cookieToken: tok(VETTED_ID) });
      assertEq(cross.status, 404, "others-4: flag on + session for another agent → 404");
      assertTrue(!String(cross.body).includes("Under godkjenning"), "others-5: …without «Under godkjenning»");
      const unv = await page(UNVERIFIED_ID, { cookieToken: tok(UNVERIFIED_ID) });
      assertEq(unv.status, 404, "others-6: flag on + own session but no verified owner → 404");
      const hidden = await page(HIDDEN_ID, { cookieToken: tok(HIDDEN_ID) });
      assertEq(hidden.status, 404, "others-7: flag on + verified owner but catalog_hidden → 404");
      const role = await page(ROLE_ID, { cookieToken: tok(ROLE_ID) });
      assertEq(role.status, 404, "others-8: flag on + verified owner but role-gate fail → 404");
      const vert = await page(OTHER_VERTICAL_ID, { cookieToken: tok(OTHER_VERTICAL_ID) });
      assertEq(vert.status, 404, "others-9: flag on + verified owner but another vertical → 404");
      const garbage = await page(PENDING_ID, { cookieToken: "not-a-token" });
      assertEq(garbage.status, 404, "others-10: flag on + invalid session token → 404");
      for (const id of [PENDING_ID, UNVERIFIED_ID, HIDDEN_ID, ROLE_ID, OTHER_VERTICAL_ID]) {
        assertEq(isVetted(id), 0, `others-11: ${id} is_vetted still 0`);
      }
      setFlag(false);
      process.env[FLAG] = "true";
      assertEq((await page(PENDING_ID, { cookieToken: tok(PENDING_ID) })).status, 200, "others-12: flag value \"true\" also turns it on");
      process.env[FLAG] = "yes";
      assertEq((await page(PENDING_ID, { cookieToken: tok(PENDING_ID) })).status, 404, "others-13: other flag values = off");
      setFlag(true);
    }

    // ═══ Vetted profile: normal page, unchanged ════════════════════════════
    {
      const onVetted = await page(VETTED_ID, { cookieToken: tok(VETTED_ID) });
      assertEq(onVetted.status, 200, "vetted-1: vetted profile → 200");
      assertTrue(!String(onVetted.body).includes("Under godkjenning"), "vetted-2: …the normal page, not «Under godkjenning»");
      assertEq(String(onVetted.body), String(offVetted.body), "vetted-3: vetted page body identical flag on vs off");
      assertEq(onVetted.headers, offVetted.headers, "vetted-4: vetted page headers identical flag on vs off");
    }
  } catch (err: any) {
    failed++;
    failures.push(`✗ unexpected error: ${String(err?.stack || err)}`);
  } finally {
    console.log = prevLog;
    if (prevFlag === undefined) delete process.env[FLAG]; else process.env[FLAG] = prevFlag;
    if (prevDb) initMod.__setDbForTesting(prevDb as any);
    clearRegistryCaches();
    try { (require("./seo") as typeof import("./seo")).__resetSitemapCacheForTesting(); } catch { /* ignore */ }
    try { db.close(); } catch { /* ignore */ }
  }

  return { passed, failed, failures };
}

if (require.main === module) {
  runOwnerPendingProfileViewS4aTests({ log: true }).then((r) => {
    console.info(`\nowner-pending-profile-view-s4a: ${r.passed} passed, ${r.failed} failed`);
    if (r.failed) {
      for (const f of r.failures) console.info(f);
      process.exit(1);
    }
    process.exit(0);
  });
}
