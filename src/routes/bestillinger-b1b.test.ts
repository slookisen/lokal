/**
 * bestillinger-b1b.test.ts — dev-request 2026-10-28-rfb-bestillinger-fra-start-
 * til-slutt-for-eier, slice B1b-1: stricter write access on the owner product
 * routes. The B1/B2 portal POSTs (they make products orderable → real orders)
 * also require what POST /eier/:id/selger requires: the session's magic-link
 * e-mail equals the claimant_email of a verified agent_claims row
 * (case/whitespace-insensitive), via the shared sessionClaimantOwnerEmail.
 *
 *   other-*  verified owner whose session e-mail is NOT the claimant's → 403
 *            «logg inn med eierens e-post» on every covered POST, nothing
 *            written; the card is still shown on GET (reads unchanged).
 *   match-*  session e-mail = claimant (also other case/whitespace) → the
 *            POSTs work as before.
 *   selger-* POST /eier/:id/selger behaviour unchanged (claimant → bridge,
 *            other e-mail → /selger?agent=…).
 *   helper-* sessionClaimantOwnerEmail edge cases.
 *
 * Fresh in-memory SQLite with the production schema.
 * Standalone: npx tsx src/routes/bestillinger-b1b.test.ts
 * Wired into `npm test` by tests/test.ts.
 */

import Database from "better-sqlite3";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

interface HandlerResult {
  status: number;
  body: any;
}

const DAY = 86_400_000;
const ENV_KEYS = [
  "ADMIN_KEY", "OWNER_ORDERABILITY_PORTAL_ENABLED", "SUPPLY_GRAPH_STALE_DAYS", "OWNER_FEATURES_ALLOWED_SUBJECTS",
  "OWNER_VERIFIED_OWNER_GATE_ENABLED", "OWNER_UNIFIED_SESSION_ENABLED", "OWNER_FEATURES_ENFORCE", "APP_URL",
  "STOCK_CHECK_EMAIL_ENABLED", "OWNER_PAUSE_ENABLED", "OWNER_ORDER_EMAIL_ENABLED",
];

const P = "b1b-test-producer";
const CLAIMANT = "eier@b1b-gard.example.no";
const LISTED = `post@${P}.example.no`; // agent_knowledge e-mail, not the claimant

function sqlTs(d: Date): string {
  return d.toISOString().slice(0, 19).replace("T", " ");
}

export async function runBestillingerB1bTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];
  function assertEq(actual: unknown, expected: unknown, label: string): void {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a === e) { passed++; if (log) console.info(`  ok ${label}`); }
    else {
      failed++;
      const msg = `✗ ${label}\n    expected: ${e}\n    actual:   ${a}`;
      failures.push(msg);
      if (log) console.info("  " + msg);
    }
  }
  function assertTrue(cond: boolean, label: string): void {
    if (cond) { passed++; if (log) console.info(`  ok ${label}`); }
    else { failed++; failures.push(`✗ ${label}`); if (log) console.info(`  ✗ ${label}`); }
  }

  function findRouteHandler(router: any, path: string, method: "get" | "post"): Function {
    const layer = (router.stack as any[]).find((l: any) => l.route && l.route.path === path && l.route.methods?.[method]);
    if (!layer) throw new Error(`route not found: ${method.toUpperCase()} ${path}`);
    return layer.route.stack[layer.route.stack.length - 1].handle;
  }
  function makeReq(o: { method?: string; params?: Record<string, string>; body?: any; query?: Record<string, string>; token?: string; headers?: Record<string, string> }): any {
    const headers: Record<string, string> = { host: "rettfrabonden.com", ...(o.headers || {}) };
    if (o.token) headers.authorization = `Bearer ${o.token}`;
    return {
      method: o.method ?? "POST", url: "/", path: "/", originalUrl: "/",
      params: o.params || {}, body: o.body, query: o.query || {}, headers, cookies: {},
      ip: "127.0.0.1", lang: "no", protocol: "https", hostname: "rettfrabonden.com",
      get(name: string) { return headers[name.toLowerCase()]; },
    };
  }
  function invoke(handler: Function, req: any): Promise<HandlerResult> {
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
        header() { return res; }, set() { return res; }, type() { return res; }, cookie() { return res; }, clearCookie() { return res; },
        setHeader() { return res; },
      };
      try {
        const p = handler(req, res, (err?: any) => settle({ __next: true, err: err ? String(err) : undefined }));
        if (p && typeof p.catch === "function") p.catch((err: any) => settle({ __error: String(err) }));
      } catch (err) {
        settle({ __error: String(err) });
      }
    });
  }

  const initMod = require("../database/init") as typeof import("../database/init");
  const prevDb = initMod.__peekDbForTesting();
  const prevEnv: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) prevEnv[k] = process.env[k];
  const db = new Database(":memory:");
  db.pragma("journal_mode = DELETE");
  const prevLog = console.log;
  const prevErr = console.error;
  if (!log) { console.log = () => { /* silence */ }; console.error = () => { /* silence */ }; }

  try {
    initMod.__setDbForTesting(db as any);
    initMod.__initSchemaForTesting(db as any);
    for (const k of ENV_KEYS) delete process.env[k];
    process.env.ADMIN_KEY = "b1b-test-admin-key";
    for (const m of ["./owner-portal", "../services/owner-orderability"]) {
      try { delete require.cache[require.resolve(m)]; } catch { /* not loaded yet */ }
    }
    const portalMod = require("./owner-portal") as typeof import("./owner-portal");

    // ── Fixture: one claimed, verified producer on the allowlist ──
    const T = new Date(`${new Date().toISOString().slice(0, 10)}T10:00:00Z`);
    const ago = (d: number) => sqlTs(new Date(T.getTime() - d * DAY));
    db.prepare(
      `INSERT INTO agents
         (id, name, description, provider, contact_email, url, role, api_key, lat, lng, city,
          categories, tags, trust_score, is_active, is_verified, origin, vertical_id, catalog_hidden, claimed_at,
          order_notifications_opt_in)
       VALUES (?, 'B1b Gard', 'Testprodusent B1b.', 'test', ?, ?, 'producer', 'key-b1b', 59.91, 10.75, 'Oslo', '["vegetables"]', '[]', 0.7, 1, 1, 'discovery', 'rfb', 0, '2026-10-01T00:00:00.000Z', 1)`,
    ).run(P, LISTED, `https://${P}.example.no`);
    db.prepare(
      `INSERT INTO agent_knowledge (agent_id, email, website, about, verification_status, verified_second_line)
       VALUES (?, ?, ?, 'Liten gård.', 'verified', 0)`,
    ).run(P, LISTED, `https://${P}.example.no`);
    // Verified claimant stored with odd case/whitespace: the match is case/whitespace-insensitive.
    db.prepare(
      `INSERT INTO agent_claims (id, agent_id, claimant_name, claimant_email, status, verified_at)
       VALUES ('claim-b1b', ?, 'Eier', ?, 'verified', '2026-10-01T00:00:00.000Z')`,
    ).run(P, "  Eier@B1B-Gard.example.no ");
    // A non-verified claim for the listed address must not count.
    db.prepare(
      `INSERT INTO agent_claims (id, agent_id, claimant_name, claimant_email, status)
       VALUES ('claim-b1b-pending', ?, 'Annen', ?, 'pending')`,
    ).run(P, LISTED);
    const session = (tok: string, email: string) =>
      db.prepare("INSERT INTO magic_links (id, email, token, agent_id, used, created_at, expires_at) VALUES (?, ?, ?, ?, 1, ?, ?)")
        .run(`mlsess_${tok}`, email, tok, P, new Date().toISOString(), new Date(Date.now() + DAY).toISOString());
    session("tok-other", LISTED);          // verified owner (claimed profile), but not the claimant's address
    session("tok-claimant", CLAIMANT);     // the claimant's own address
    session("tok-case", " EIER@b1b-gard.EXAMPLE.no  "); // the claimant's address, other case/whitespace
    for (const [suffix, name, avail, upd] of [["soon", "Gulrøtter", "in_stock", ago(12)], ["out", "Purre", "out_of_stock", ago(12)], ["out2", "Løk", "out_of_stock", ago(12)]] as const) {
      db.prepare(
        `INSERT INTO products (id, agent_id, name, name_norm, price_nok, unit, availability, category, availability_source, availability_updated_at)
         VALUES (?, ?, ?, ?, 30, 'kg', ?, 'vegetables', 'producer_dashboard', ?)`,
      ).run(`${P}-${suffix}`, P, name, name.toLowerCase(), avail, upd);
    }
    process.env.OWNER_ORDERABILITY_PORTAL_ENABLED = "1";
    process.env.OWNER_FEATURES_ALLOWED_SUBJECTS = `rfb:${P}`;
    process.env.OWNER_UNIFIED_SESSION_ENABLED = "1";

    const productsOf = () => JSON.stringify(db.prepare("SELECT * FROM products WHERE agent_id = ? ORDER BY id").all(P));
    const auditCount = () => (db.prepare("SELECT COUNT(*) AS n FROM agent_knowledge_audit").get() as any).n as number;
    const linkCount = () => (db.prepare("SELECT COUNT(*) AS n FROM magic_links").get() as any).n as number;
    const H = {
      portal: findRouteHandler(portalMod.default, "/eier/:agentId/portal", "get"),
      one: findRouteHandler(portalMod.default, "/eier/:agentId/varer/:productId/bekreft", "post"),
      all: findRouteHandler(portalMod.default, "/eier/:agentId/varer/bekreft-alle", "post"),
      ny: findRouteHandler(portalMod.default, "/eier/:agentId/varer/ny", "post"),
      banner: findRouteHandler(portalMod.default, "/eier/:agentId/varer/bekreft-lagerpaminnelse", "post"),
      selger: findRouteHandler(portalMod.default, "/eier/:agentId/selger", "post"),
    };
    const ORIGIN = { origin: "https://rettfrabonden.com" };
    const posts: Array<[string, Function, Record<string, string>, any]> = [
      ["bekreft", H.one, { agentId: P, productId: `${P}-out` }, {}],
      ["bekreft-alle", H.all, { agentId: P }, {}],
      ["ny", H.ny, { agentId: P }, { name: "Ny vare B1b", price: "10" }],
      ["bekreft-lagerpaminnelse", H.banner, { agentId: P }, { id: [`${P}-soon`] }],
    ];

    // ═══ helper ═══════════════════════════════════════════════════════════════
    {
      const h = portalMod.sessionClaimantOwnerEmail;
      assertEq([h(P, { token: "tok-claimant" }), h(P, { token: "tok-case" })], ["  Eier@B1B-Gard.example.no ", "  Eier@B1B-Gard.example.no "],
        "helper-1: claimant's address (any case/whitespace) → the stored claimant_email");
      assertEq([h(P, { token: "tok-other" }), h(P, { token: "nope" }), h(P, {}), h(P, null), h("", { token: "tok-claimant" }), h("other-agent", { token: "tok-claimant" })],
        [null, null, null, null, null, null], "helper-2: other address / unknown token / no token / other agent → null (a pending claim does not count)");
      assertTrue(portalMod.isVerifiedOwner(P, { valid: true, agentId: P, token: "tok-other" }), "helper-3: the other-address session IS a verified owner (isVerifiedOwner)");
    }

    // ═══ other address: 403 on every write, nothing written; GET still shows the card ══
    {
      const before = productsOf();
      const a0 = auditCount();
      for (const [name, h, params, body] of posts) {
        const r = await invoke(h, makeReq({ params, body, token: "tok-other", headers: ORIGIN }));
        const html = String(r.body ?? "");
        assertEq(r.status, 403, `other-1: verified owner, not the claimant's e-mail → POST ${name} → 403`);
        assertTrue(html.includes("Logg inn med eierens e-postadresse") && html.includes("e-postadressen til den som har bekreftet eierskapet")
          && html.includes(`href="/selger?agent=${P}"`) && html.includes("ep-card"), `other-2: POST ${name} → Norwegian page linking to /selger?agent=<id>`);
        const title = (html.match(/<title>([^<]*)<\/title>/) ?? [])[1] ?? "";
        assertTrue(title.includes("Logg inn med eierens e-post") && !title.includes("Ingen tilgang"),
          `other-2b: POST ${name} → page <title> says «Logg inn med eierens e-post», not «Ingen tilgang» (got ${JSON.stringify(title)})`);
      }
      assertEq([productsOf(), auditCount()], [before, a0], "other-3: nothing written, no audit row");
      const g = await invoke(H.portal, makeReq({ method: "GET", params: { agentId: P }, token: "tok-other" }));
      const html = String(g.body ?? "");
      assertEq(g.status, 200, "other-4: GET portal still 200 for the verified owner on another address");
      assertTrue(html.includes(`id="bestillbare-varer"`) && html.includes("Varer som kan bestilles") && html.includes("Purre"), "other-5: … and the card is shown");
      // Existing checks keep their order/answers: cross-site, no session.
      const xs = await invoke(H.all, makeReq({ params: { agentId: P }, token: "tok-other", headers: { origin: "https://evil.example" } }));
      assertTrue(xs.status === 403 && !String(xs.body).includes("eierens e-post"), "other-6: cross-site still answered by the Origin check first");
      const ns = await invoke(H.all, makeReq({ params: { agentId: P }, headers: ORIGIN }));
      assertEq([ns.status, ns.body?.__redirect], [303, `/eier/${P}`], "other-7: no session → login redirect (unchanged)");
      assertEq(productsOf(), before, "other-8: still nothing written");
    }

    // ═══ the claimant's address: works as before ═══════════════════════════════
    {
      const back = (s: string) => `/eier/${P}/portal?status=${s}#bestillbare-varer`;
      const r4 = await invoke(H.banner, makeReq({ params: { agentId: P }, body: { id: [`${P}-soon`] }, token: "tok-claimant", headers: ORIGIN }));
      assertEq([r4.status, r4.body?.__redirect], [303, back("lager_bekreftet")], "match-0: claimant → POST bekreft-lagerpaminnelse (before bekreft-alle refreshes the row) → 303 lager_bekreftet");
      const r1 = await invoke(H.one, makeReq({ params: { agentId: P, productId: `${P}-out` }, token: "tok-claimant", headers: ORIGIN }));
      assertEq([r1.status, r1.body?.__redirect], [303, back("vare_bekreftet")], "match-1: claimant → POST bekreft → 303 vare_bekreftet");
      assertEq((db.prepare("SELECT availability FROM products WHERE id = ?").get(`${P}-out`) as any).availability, "in_stock", "match-2: … and writes");
      const r2 = await invoke(H.all, makeReq({ params: { agentId: P }, token: "tok-case", headers: ORIGIN }));
      assertEq([r2.status, r2.body?.__redirect], [303, back("varer_bekreftet")], "match-3: claimant, other case/whitespace → POST bekreft-alle → 303 varer_bekreftet");
      assertEq((db.prepare("SELECT availability FROM products WHERE id = ?").get(`${P}-out2`) as any).availability, "in_stock", "match-4: … and writes");
      const r3 = await invoke(H.ny, makeReq({ params: { agentId: P }, body: { name: "Ny vare B1b", price: "10" }, token: "tok-case", headers: ORIGIN }));
      assertEq([r3.status, r3.body?.__redirect], [303, back("vare_lagt_til")], "match-5: POST ny → 303 vare_lagt_til");
      assertEq((db.prepare("SELECT COUNT(*) AS n FROM products WHERE agent_id = ? AND name = 'Ny vare B1b'").get(P) as any).n, 1, "match-6: … and the product exists");
      assertTrue(auditCount() > 0, "match-8: audit rows written");
    }

    // ═══ /selger: unchanged ═════════════════════════════════════════════════════
    {
      const l0 = linkCount();
      const o = await invoke(H.selger, makeReq({ params: { agentId: P }, token: "tok-other", headers: ORIGIN }));
      assertEq([o.status, o.body?.__redirect, linkCount()], [303, `/selger?agent=${P}`, l0], "selger-1: other address → 303 /selger?agent=<id>, no bridge link");
      const c = await invoke(H.selger, makeReq({ params: { agentId: P }, token: "tok-case", headers: ORIGIN }));
      assertTrue(c.status === 303 && String(c.body?.__redirect).startsWith("/selger?magic="), "selger-2: claimant (any case) → 303 /selger?magic=");
      const tok = decodeURIComponent(String(c.body?.__redirect).slice("/selger?magic=".length));
      const row = db.prepare("SELECT email, agent_id, used FROM magic_links WHERE token = ?").get(tok) as any;
      assertEq([row?.email, row?.agent_id, row?.used, linkCount()], ["  Eier@B1B-Gard.example.no ", P, 0, l0 + 1],
        "selger-3: one bridge link for the stored claimant_email, unused");
      const x = await invoke(H.selger, makeReq({ params: { agentId: P }, token: "tok-claimant", headers: { origin: "https://evil.example" } }));
      assertEq(x.status, 403, "selger-4: cross-site → 403 (unchanged)");
    }
  } catch (err: any) {
    failed++;
    failures.push("unexpected error: " + String(err?.stack || err));
  } finally {
    console.log = prevLog;
    console.error = prevErr;
    for (const k of ENV_KEYS) { if (prevEnv[k] === undefined) delete process.env[k]; else process.env[k] = prevEnv[k]; }
    if (prevDb) initMod.__setDbForTesting(prevDb);
    try { db.close(); } catch { /* ignore */ }
  }
  return { passed, failed, failures };
}

if (require.main === module) {
  runBestillingerB1bTests({ log: process.argv.includes("--log") }).then((r) => {
    console.info(`\nbestillinger-b1b: ${r.passed} passed, ${r.failed} failed`);
    for (const f of r.failures) console.info(f);
    process.exit(r.failed ? 1 : 0);
  });
}
