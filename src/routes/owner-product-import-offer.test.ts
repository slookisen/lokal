/**
 * owner-product-import-offer.test.ts — dev-request 2026-11-24-rfb-vareopphenting-til-alle-eiere, point 4
 * (the offer card at the top of the owner portal).
 *
 *   show      verified owner + stored website + product import access, no dismissal, no import yet → card.
 *   text      title / body / button / link verbatim (daniel-responses/2026-11-25-live-brief-svar-eiertekster-og-tre-saker.md,
 *             point 4); {domene} is the hostname, HTML-escaped.
 *   no fetch  rendering the portal creates no run and writes nothing (total_changes()).
 *   dismiss   «Ikke nå» (POST, session + same-origin guard) hides the card for the profile and redirects to the portal;
 *             no session → login redirect, cross-site → 403, foreign session → 403, nothing stored.
 *   gates     no website / unverified owner / flag off (no access) → no card.
 *   started   after an import was started the card is gone; the regular import card stays.
 *   bytes     a non-qualifying owner's portal contains no trace of the offer; a qualifying owner's portal after
 *             «Ikke nå» equals the page before with exactly the offer card removed.
 *
 * Real schema in an in-memory DB swapped in as the getDb() singleton; fake fetch (no network). Env restored in finally.
 * Exported runOwnerProductImportOfferTests({log}) -> TestSummary; wired into tests/test.ts.
 * Standalone: npx tsx src/routes/owner-product-import-offer.test.ts
 */

import Database from "better-sqlite3";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

const SAVED_ENV = [
  "PRODUCT_IMPORT_ENABLED", "OWNER_FEATURE_TIERS", "OWNER_LOCK_ENFORCE_WRITES", "OWNER_VERIFIED_OWNER_GATE_ENABLED", "OWNER_UNIFIED_SESSION_ENABLED",
  "OWNER_ORDERABILITY_PORTAL_ENABLED", "OWNER_FEATURES_ALLOWED_SUBJECTS", "OWNER_PAUSE_ENABLED", "OWNER_ORDER_EMAIL_ENABLED",
];
const DAY = 86_400_000;
const T0 = Date.UTC(2026, 10, 25, 10, 0, 0);

export async function runOwnerProductImportOfferTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];
  function assertTrue(cond: boolean, label: string): void {
    if (cond) { passed++; if (log) console.info(`  ok ${label}`); }
    else { failed++; failures.push(`✗ ${label}`); if (log) console.info(`  ✗ ${label}`); }
  }
  function assertEq(actual: unknown, expected: unknown, label: string): void {
    assertTrue(JSON.stringify(actual) === JSON.stringify(expected),
      `${label} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
  }

  const initMod = require("../database/init") as typeof import("../database/init");
  const prevDb = initMod.__peekDbForTesting();
  const prevEnv: Record<string, string | undefined> = {};
  for (const k of SAVED_ENV) prevEnv[k] = process.env[k];
  const db = new Database(":memory:");
  db.pragma("foreign_keys = OFF");
  const prevLog = console.log;
  const prevErr = console.error;
  if (!log) { console.log = () => undefined; console.error = () => undefined; }

  let oi: typeof import("../services/product-import/owner-import") | null = null;
  try {
    initMod.__setDbForTesting(db as any);
    initMod.__initSchemaForTesting(db as any);
    for (const k of SAVED_ENV) delete process.env[k];
    oi = require("../services/product-import/owner-import") as typeof import("../services/product-import/owner-import");
    const robots = require("../services/product-import/robots") as typeof import("../services/product-import/robots");
    const importRouter = (require("./owner-product-import") as any).default;
    const portalRouter = (require("./owner-portal") as any).default;
    robots.__clearRobotsCacheForTesting();
    oi.__forgetOwnerFetchJobsForTesting();

    // ─── Harness ───────────────────────────────────────────────────────────
    const handlerOf = (r: any, path: string, method: "get" | "post"): Function => {
      const layer = (r.stack as any[]).find((l: any) => l.route && l.route.path === path && l.route.methods?.[method]);
      if (!layer) throw new Error(`route not found: ${method} ${path}`);
      return layer.route.stack[layer.route.stack.length - 1].handle;
    };
    const H = {
      portal: handlerOf(portalRouter, "/eier/:agentId/portal", "get"),
      hent: handlerOf(importRouter, "/eier/:agentId/produktimport/hent", "post"),
      ikkeNa: (...a: any[]) => (handlerOf(importRouter, "/eier/:agentId/produktimport/ikke-na", "post") as any)(...a),
    };
    type Res = { status: number; body: any; location?: string };
    const invoke = (handler: Function, o: { params: Record<string, string>; token?: string; body?: any; headers?: Record<string, string>; query?: Record<string, string> }) =>
      new Promise<Res>((resolve) => {
        const headers: Record<string, string> = { host: "rettfrabonden.com", ...(o.headers || {}) };
        if (o.token) headers.authorization = `Bearer ${o.token}`;
        const req: any = {
          method: "GET", params: o.params, body: o.body, query: o.query || {}, headers, cookies: {}, ip: "127.0.0.1",
          get: (n: string) => headers[n.toLowerCase()],
        };
        let status = 200;
        let settled = false;
        const settle = (r: Res) => { if (!settled) { settled = true; resolve(r); } };
        const res: any = {
          status(c: number) { status = c; return res; },
          json(b: any) { settle({ status, body: b }); return res; },
          send(b: any) { settle({ status, body: b }); return res; },
          redirect(c: number, loc: string) { settle({ status: c, body: "", location: loc }); return res; },
          setHeader() { return res; }, set() { return res; }, header() { return res; }, type() { return res; },
          cookie() { return res; }, clearCookie() { return res; },
        };
        try {
          const p = handler(req, res, () => settle({ status: 0, body: "next" }));
          if (p && typeof p.catch === "function") p.catch((e: any) => settle({ status: -1, body: String(e) }));
        } catch (e) { settle({ status: -1, body: String(e) }); }
      });
    const totalChanges = () => (db.prepare("SELECT total_changes() AS n").get() as { n: number }).n;
    const html = (r: Res) => String(r.body ?? "");

    // ─── Fixture ───────────────────────────────────────────────────────────
    const addAgent = (id: string, o: { verified: number; claimed?: boolean; website?: string | null; products?: unknown[] }) => {
      db.prepare(
        `INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key,
          categories, tags, skills, capabilities, languages, city, lat, lng,
          trust_score, is_active, is_verified, discovery_count, interaction_count,
          total_interactions, created_at, last_seen_at, claimed_at, vertical_id)
         VALUES (?, ?, 'En liten gård.', 'p', ?, 'https://example.no', 'producer', ?,
          '["meat"]', '[]', '[]', '{}', '["no"]', 'Testby', 59.91, 10.75, 0.7, 1, ?, 0, 0, 0, datetime('now'), datetime('now'), ?, 'rfb')`,
      ).run(id, `Gard ${id}`, `post@${id}.example.no`, `key-${id}`, o.verified, o.claimed === false ? null : "2026-10-01T00:00:00.000Z");
      db.prepare(
        `INSERT INTO agent_knowledge (agent_id, email, website, products, data_source, verification_status, verified_second_line)
         VALUES (?, ?, ?, ?, 'hybrid', 'verified', 0)`,
      ).run(id, `post@${id}.example.no`, o.website === undefined ? `https://${id}.no` : o.website, JSON.stringify(o.products ?? []));
      if (o.claimed !== false) {
        db.prepare(
          `INSERT INTO agent_claims (id, agent_id, claimant_name, claimant_email, status, verified_at)
           VALUES (?, ?, 'Eier', ?, 'verified', '2026-10-01T00:00:00.000Z')`,
        ).run(`claim-${id}`, id, `post@${id}.example.no`);
      }
    };
    const tokens: Record<string, string> = {};
    const session = (id: string, email = `post@${id}.example.no`, name = id) => {
      tokens[name] = `tok-${name}`;
      db.prepare("INSERT INTO magic_links (id, email, token, agent_id, used, created_at, expires_at) VALUES (?, ?, ?, ?, 1, ?, ?)")
        .run(`mlsess_${name}`, email, tokens[name], id, new Date().toISOString(), new Date(Date.now() + DAY).toISOString());
    };

    const OFFER = "po-offer";
    addAgent(OFFER, { verified: 1, website: "https://www.gaarden-offer.no/butikk" });
    addAgent("po-evil", { verified: 1, website: "https://x<b>y&z.no" });
    addAgent("po-nosite", { verified: 1, website: "" });
    addAgent("po-unver", { verified: 0 });
    addAgent("po-noowner", { verified: 1, claimed: false });
    addAgent("po-other", { verified: 1 });
    addAgent("po-start", { verified: 1 });
    for (const id of [OFFER, "po-evil", "po-nosite", "po-unver", "po-noowner", "po-other", "po-start"]) session(id);

    const routes: Record<string, { body: string; contentType?: string }> = {
      "https://po-start.no/robots.txt": { body: "User-agent: *\nDisallow:\n", contentType: "text/plain" },
      "https://po-start.no/products.json?limit=250": { contentType: "application/json", body: JSON.stringify({ products: [{ title: "Honning", handle: "honning", variants: [{ title: "Default Title", price: "120.00" }] }] }) },
    };
    let fetchCalls = 0;
    const fetchImpl = (async (input: any) => {
      fetchCalls++;
      const url = String(typeof input === "string" ? input : input?.url ?? input);
      const r = routes[url] ?? { body: "<html></html>" };
      return new Response(r.body, { status: 200, headers: { "content-type": r.contentType ?? "text/html" } });
    }) as unknown as typeof fetch;
    oi.__setOwnerImportDepsForTesting({ fetchImpl, llm: async () => ({ text: "[]" }), now: () => T0, sleep: async () => undefined, hostIntervalMs: 0 });

    const portalFor = (id: string, token: string | undefined = tokens[id]) => invoke(H.portal, { params: { agentId: id }, token });
    const hentFor = (id: string, token = tokens[id]) => invoke(H.hent, { params: { agentId: id }, token, body: {} });
    const dismissFor = (id: string, token: string | undefined = tokens[id], headers?: Record<string, string>) =>
      invoke(H.ikkeNa, { params: { agentId: id }, token, body: {}, headers });
    const hasOffer = (r: Res) => html(r).includes('data-product-import-offer="1"');
    const hasCard = (r: Res) => html(r).includes('data-product-import-card="1"');
    const runs = () => (db.prepare("SELECT COUNT(*) AS n FROM product_import_runs").get() as { n: number }).n;
    const dismissals = () => (db.prepare("SELECT COUNT(*) AS n FROM product_import_offer_dismissed").get() as { n: number }).n;
    const offerBlock = (h: string): string => {
      const i = h.indexOf('<div class="ep-card" data-product-import-offer="1">');
      if (i < 0) return "";
      const j = h.indexOf("</form>\n        </div>\n      </div>", i);
      return j < 0 ? "" : h.slice(i, j + "</form>\n        </div>\n      </div>".length);
    };

    // ─── no access (flag off) → no card; routes answer 404 ──────────────────
    {
      const before = totalChanges();
      const p = await portalFor(OFFER);
      assertTrue(p.status === 200 && !hasOffer(p) && !hasCard(p), "flag off: no offer card, no import card");
      assertEq((await dismissFor(OFFER)).status, 404, "flag off: «Ikke nå» route answers 404");
      assertEq([totalChanges(), dismissals()], [before, 0], "flag off: nothing written");
    }
    process.env.PRODUCT_IMPORT_ENABLED = "1";

    // ─── shown for a qualifying owner; texts verbatim; no fetch on render ───
    const changesBeforeRender = totalChanges();
    const shown = await portalFor(OFFER);
    const sh = html(shown);
    {
      assertTrue(shown.status === 200 && hasOffer(shown), "show: qualifying owner sees the offer card");
      assertEq([runs(), fetchCalls, totalChanges()], [0, 0, changesBeforeRender], "no fetch: rendering the portal starts no import and writes nothing");
      assertTrue(sh.includes("<h2>Hent varene dine fra nettsiden din</h2>"), "text: title verbatim");
      assertTrue(sh.includes("<p>Vi kan lese varer og priser fra www.gaarden-offer.no og legge dem klare til deg. Du ser alt først og velger selv hva som publiseres. Ingenting hentes før du trykker.</p>"),
        "text: body verbatim with the hostname as {domene}");
      assertTrue(/<button type="submit" class="ep-btn ep-btn-primary">Hent produkter fra nettsiden min<\/button>/.test(offerBlock(sh)), "text: button verbatim");
      assertTrue(/<button type="submit" class="ep-btn ep-btn-secondary">Ikke nå<\/button>/.test(offerBlock(sh)), "text: «Ikke nå» verbatim");
      assertTrue(offerBlock(sh).includes(`action="/eier/${OFFER}/produktimport/hent"`) && offerBlock(sh).includes(`action="/eier/${OFFER}/produktimport/ikke-na"`),
        "button goes to the existing import flow; «Ikke nå» posts to the dismiss route");
      assertTrue(offerBlock(sh) !== "" && sh.indexOf('data-product-import-offer="1"') < sh.indexOf("Profilinformasjon"), "card sits above the profile card");
      assertTrue(hasCard(shown), "the regular import card is still there");
    }

    // ─── domain escaped ─────────────────────────────────────────────────────
    {
      const h = html(await portalFor("po-evil"));
      const b = offerBlock(h);
      assertTrue(b.includes("Vi kan lese varer og priser fra ") && !/<b>y/i.test(b) && !b.includes("&z"), "escape: no raw markup or bare ampersand from the stored website in the offer");
      assertTrue(b.includes("x&lt;b&gt;y&amp;z.no"), "escape: the domain is HTML-escaped in the offer");
    }

    // ─── gates ──────────────────────────────────────────────────────────────
    {
      assertTrue(!hasOffer(await portalFor("po-nosite")), "gate: no website → no offer card");
      assertTrue(!hasOffer(await portalFor("po-unver")), "gate: unverified owner (is_verified = 0) → no offer card");
      assertTrue(!hasOffer(await portalFor("po-noowner")), "gate: is_verified = 1 without a verified owner → no offer card");
    }

    // ─── «Ikke nå»: session + same-origin guard ─────────────────────────────
    {
      const before = totalChanges();
      const anon = await dismissFor(OFFER, "");
      assertEq([anon.status, anon.location], [303, `/eier/${OFFER}`], "dismiss: no session → login redirect");
      assertEq((await dismissFor(OFFER, tokens["po-other"])).status, 403, "dismiss: session for another profile → 403");
      assertEq((await dismissFor("po-unver")).status, 403, "dismiss: unverified owner → 403");
      assertEq((await dismissFor(OFFER, tokens[OFFER], { origin: "https://evil.example" })).status, 403, "dismiss: cross-site POST → 403");
      assertEq([dismissals(), totalChanges()], [0, before], "dismiss: refused calls store nothing");
      assertTrue(hasOffer(await portalFor(OFFER)), "dismiss: the card is still shown after refused calls");
    }
    {
      const r = await dismissFor(OFFER);
      assertEq([r.status, r.location], [303, `/eier/${OFFER}/portal`], "dismiss: «Ikke nå» → 303 back to the portal");
      assertEq([dismissals(), runs(), fetchCalls], [1, 0, 0], "dismiss: one row stored, no import started");
      const after = await portalFor(OFFER);
      assertTrue(!hasOffer(after) && hasCard(after), "dismiss: the offer is gone, the regular import card stays");
      assertEq(html(after), sh.replace(offerBlock(sh) + "\n\n      ", ""),
        "bytes: the page after «Ikke nå» equals the page before with exactly the offer card removed");
      await dismissFor(OFFER);
      assertEq(dismissals(), 1, "dismiss: pressing twice stays one row");
    }

    // ─── started import → card gone, regular card stays ─────────────────────
    {
      const id = "po-start";
      assertTrue(hasOffer(await portalFor(id)), "started: shown before any import");
      const f = await hentFor(id);
      const rid = /\/produktimport\/([A-Za-z0-9_-]+)$/.exec(f.location ?? "")?.[1] ?? "";
      assertTrue(f.status === 303 && rid.startsWith("pio-"), "started: the button's POST starts the import (existing flow)");
      await oi.__awaitOwnerFetchForTesting(rid);
      const p = await portalFor(id);
      assertTrue(!hasOffer(p) && hasCard(p), "started: offer gone after an import was started, regular card stays");
      assertEq(dismissals(), 1, "started: no dismissal row needed");
    }

    // ─── non-qualifying owner: no trace of the offer in the page ────────────
    {
      for (const id of ["po-nosite", "po-unver", "po-noowner"]) {
        const h = html(await portalFor(id));
        assertTrue(!h.includes("data-product-import-offer") && !h.includes("ikke-na") && !h.includes("Hent varene dine fra nettsiden din"), `bytes: ${id} portal has no trace of the offer`);
      }
    }
  } catch (err) {
    failed++;
    failures.push(`unexpected error: ${err instanceof Error ? (err.stack || err.message) : String(err)}`);
  } finally {
    console.log = prevLog;
    console.error = prevErr;
    try { oi?.__setOwnerImportDepsForTesting(null); oi?.__forgetOwnerFetchJobsForTesting(); } catch { /* ignore */ }
    for (const k of SAVED_ENV) { if (prevEnv[k] === undefined) delete process.env[k]; else process.env[k] = prevEnv[k]; }
    if (prevDb) initMod.__setDbForTesting(prevDb);
    db.close();
  }
  if (log) console.info(`\nowner-product-import-offer: ${passed} passed, ${failed} failed`);
  return { passed, failed, failures };
}

if (require.main === module) {
  runOwnerProductImportOfferTests({ log: true }).then((r) => {
    for (const f of r.failures) console.info(f);
    process.exit(r.failed > 0 ? 1 : 0);
  });
}
