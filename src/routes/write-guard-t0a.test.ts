/**
 * write-guard-t0a.test.ts — slice T0a of the owner-portal write-guard fix:
 * the real route handlers behind the shared same-origin guard
 * (src/middleware/same-origin-write.ts).
 *
 *   AC1  POST /eier/:id/valg/niva (the «Bekreft «Bare synlig»» plain form
 *        button) with Origin: null + Sec-Fetch-Site: same-origin and a valid
 *        owner session → 303, orders.enabled ends off, one owner audit row.
 *        With WRITE_GUARD_FETCH_METADATA=0 the same request → 403 (old check).
 *   AC3  the refused HTML request → «Kunne ikke lagre» page with «Tilbake til
 *        Mine valg» and exactly one `[write-guard] refused` log line (route
 *        pattern, no token, no e-mail).
 *   new  the JSON profile save (POST /api/agents/:id/update-profile) and the
 *        form fallback (POST /eier/:id/save) are guarded now: cross-site →
 *        403 with nothing written; Origin: null / own Origin → saved.
 *
 * Real routers + services on the production schema in an in-memory DB;
 * handlers pulled off the router stack (same harness as owner-features-s2b).
 * Exported runWriteGuardT0aTests({log}) -> TestSummary; wired into
 * tests/test.ts. Standalone: npx tsx src/routes/write-guard-t0a.test.ts
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

const ALLOW_ENV = "OWNER_FEATURES_ALLOWED_SUBJECTS";
const GATE_ENV = "OWNER_VERIFIED_OWNER_GATE_ENABLED";
const FLAG_ENV = "WRITE_GUARD_FETCH_METADATA";
const OWNED_ID = "t0a-owned";
const SAVE_ID = "t0a-save";

function seedProducer(db: Database.Database, id: string): void {
  db.prepare(
    `INSERT INTO agents
       (id, name, description, provider, contact_email, url, role, api_key, lat, lng, city,
        categories, tags, trust_score, is_active, is_verified, origin, vertical_id, catalog_hidden, claimed_at,
        order_notifications_opt_in)
     VALUES (?, ?, 'Testprodusent for skrivevakten.', 'test', ?, ?, 'producer', ?, 59.9139, 10.7522, 'Oslo', '["vegetables"]', '[]', 0.7, 1, 1, 'discovery', 'rfb', 0, '2026-10-01T00:00:00.000Z', 1)`,
  ).run(id, `Skrivevakt Gard ${id}`, `post@${id}.example.no`, `https://${id}.example.no`, `key-${id}`);
  db.prepare(
    `INSERT INTO agent_knowledge (agent_id, email, website, about, phone, verification_status, verified_second_line)
     VALUES (?, ?, ?, 'Liten familiegård.', '+47 400 00 000', 'verified', 0)`,
  ).run(id, `post@${id}.example.no`, `https://${id}.example.no`);
}

export async function runWriteGuardT0aTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
  function assertTrue(cond: boolean, label: string): void { assertEq(!!cond, true, label); }

  const initMod = require("../database/init") as typeof import("../database/init");
  const prevDb = initMod.__peekDbForTesting();
  const prevEnv: Record<string, string | undefined> = {};
  for (const k of [ALLOW_ENV, GATE_ENV, FLAG_ENV]) prevEnv[k] = process.env[k];

  function findRouteHandler(router: any, path: string, method: "get" | "post"): Function {
    const layer = (router.stack as any[]).find((l: any) => l.route && l.route.path === path && l.route.methods?.[method]);
    if (!layer) throw new Error(`route not found: ${method.toUpperCase()} ${path}`);
    return layer.route.stack[layer.route.stack.length - 1].handle;
  }
  function makeReq(o: { route: string; params: Record<string, string>; body?: any; token?: string; headers?: Record<string, string> }): any {
    const headers: Record<string, string> = { host: "rettfrabonden.com", ...(o.headers || {}) };
    if (o.token) headers.authorization = `Bearer ${o.token}`;
    return {
      method: "POST", url: "/", path: "/", originalUrl: "/", route: { path: o.route },
      params: o.params, body: o.body ?? {}, query: {}, headers, cookies: {},
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
        header() { return res; }, set() { return res; }, type() { return res; }, cookie() { return res; },
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

  const db = new Database(":memory:");
  db.pragma("journal_mode = DELETE");
  db.pragma("foreign_keys = ON");

  const prevLog = console.log;
  const logged: string[] = [];
  console.log = (...a: unknown[]) => { logged.push(a.map(String).join(" ")); };
  const guardLines = () => logged.filter((l) => l.startsWith("[write-guard]"));

  try {
    initMod.__setDbForTesting(db as any);
    initMod.__initSchemaForTesting(db as any);
    delete process.env[GATE_ENV];
    delete process.env[FLAG_ENV];
    for (const m of ["./owner-portal", "./owner-features"]) {
      try { delete require.cache[require.resolve(m)]; } catch { /* not loaded yet */ }
    }
    const portalMod = require("./owner-portal") as typeof import("./owner-portal");
    const featuresMod = require("./owner-features") as typeof import("./owner-features");

    const tokens: Record<string, string> = {};
    for (const id of [OWNED_ID, SAVE_ID]) {
      seedProducer(db, id);
      tokens[id] = `tok-secret-${id}`;
      db.prepare("INSERT INTO magic_links (id, email, token, agent_id, used, created_at, expires_at) VALUES (?, ?, ?, ?, 1, ?, ?)")
        .run(`mlsess_${id}`, `post@${id}.example.no`, tokens[id], id, new Date().toISOString(), new Date(Date.now() + 86_400_000).toISOString());
    }
    process.env[ALLOW_ENV] = `rfb:${OWNED_ID},rfb:${SAVE_ID}`;

    const NIVA = "/eier/:agentId/valg/niva";
    const niva = findRouteHandler(featuresMod.default, NIVA, "post");
    const updateProfile = findRouteHandler(portalMod.default, "/api/agents/:id/update-profile", "post");
    const save = findRouteHandler(portalMod.default, "/eier/:agentId/save", "post");
    const optIn = (id: string) => (db.prepare("SELECT order_notifications_opt_in AS v FROM agents WHERE id = ?").get(id) as any).v;
    const audits = (id: string) => db.prepare("SELECT key, new_json, actor FROM owner_feature_audit WHERE subject_id = ? ORDER BY id").all(id) as any[];
    const phone = (id: string) => (db.prepare("SELECT phone FROM agent_knowledge WHERE agent_id = ?").get(id) as any).phone;
    const NULL_ORIGIN_FORM = { origin: "null", "sec-fetch-site": "same-origin", "content-type": "application/x-www-form-urlencoded" };
    const nivaReq = () => makeReq({ route: NIVA, params: { agentId: OWNED_ID }, body: { level: "bare_synlig", confirmed: "1" }, token: tokens[OWNED_ID], headers: NULL_ORIGIN_FORM });

    // ── AC1 with WRITE_GUARD_FETCH_METADATA=0: the old check refuses Origin: null ──
    process.env[FLAG_ENV] = "0";
    logged.length = 0;
    const old = await invoke(niva, nivaReq());
    assertEq(old.status, 403, "ac1-01: flag=0 → «Bekreft «Bare synlig»» with Origin: null → 403 (the old behaviour)");
    assertEq([optIn(OWNED_ID), audits(OWNED_ID).length], [1, 0], "ac1-02: flag=0 → nothing written");
    // AC3 on this refusal.
    const html = String(old.body);
    assertTrue(html.includes("<title>Kunne ikke lagre") && html.includes("<h1>Endringen ble ikke lagret</h1>"), "ac3-01: refused page: title «Kunne ikke lagre», heading «Endringen ble ikke lagret»");
    assertTrue(html.includes("Av sikkerhetshensyn lagrer vi bare endringer som gjøres på våre egne sider.") && html.includes("kontakt@rettfrabonden.com"), "ac3-02: the explanation and the RFB contact");
    assertTrue(html.includes(`href="/eier/${OWNED_ID}/valg">Tilbake til Mine valg</a>`), "ac3-03: back link «Tilbake til Mine valg»");
    assertTrue(!html.includes("Forespørselen kom fra en annen side"), "ac3-04: the old «Ingen tilgang» text is gone");
    assertEq(guardLines(), [`[write-guard] refused ${NIVA} origin_unparseable`], "ac3-05: exactly one [write-guard] log line, route pattern + reason");
    assertTrue(!guardLines().join("\n").includes(tokens[OWNED_ID]) && !guardLines().join("\n").includes("@"), "ac3-06: no token, no e-mail in the log line");

    // ── AC1 default: accepted ─────────────────────────────────────────────
    delete process.env[FLAG_ENV];
    logged.length = 0;
    const ok = await invoke(niva, nivaReq());
    assertEq(ok.status, 303, "ac1-03: default → Origin: null + Sec-Fetch-Site: same-origin → 303");
    assertTrue(String(ok.body?.__redirect || "").startsWith(`/eier/${OWNED_ID}/valg?endret=`), "ac1-04: PRG back to «Mine valg» with the change");
    assertEq(optIn(OWNED_ID), 0, "ac1-05: orders.enabled ends off");
    const a = audits(OWNED_ID);
    assertEq(a.map((r) => [r.key, r.new_json, r.actor]), [["orders.enabled", "false", "owner"]], "ac1-06: one audit row, actor owner");
    assertEq(guardLines().length, 0, "ac1-07: an accepted write logs no [write-guard] line");

    // Sec-Fetch-Site: cross-site is refused even with no Origin (default on).
    logged.length = 0;
    const xs = await invoke(niva, makeReq({ route: NIVA, params: { agentId: OWNED_ID }, body: { level: "ta_imot_bestillinger", confirmed: "1" }, token: tokens[OWNED_ID], headers: { "sec-fetch-site": "cross-site" } }));
    assertEq([xs.status, optIn(OWNED_ID), audits(OWNED_ID).length], [403, 0, 1], "ac1-08: Sec-Fetch-Site: cross-site → 403, nothing written");
    assertEq(guardLines(), [`[write-guard] refused ${NIVA} sec_fetch_site_cross_site`], "ac1-09: one log line for that refusal");

    // ── The JSON profile save is guarded now ──────────────────────────────
    const UP = "/api/agents/:id/update-profile";
    const up = (headers: Record<string, string>, value: string) =>
      invoke(updateProfile, makeReq({ route: UP, params: { id: SAVE_ID }, body: { phone: value }, token: tokens[SAVE_ID], headers }));
    const before = phone(SAVE_ID);
    logged.length = 0;
    const upX = await up({ origin: "https://evil.example" }, "+47 900 00 001");
    assertEq([upX.status, upX.body, phone(SAVE_ID)], [403, { success: false, error: "cross_site" }, before], "new-01: update-profile cross-site → 403 cross_site, nothing written");
    assertEq(guardLines(), [`[write-guard] refused ${UP} origin_foreign`], "new-02: one log line");
    const upMeta = await up({ "sec-fetch-site": "same-site" }, "+47 900 00 002");
    assertEq([upMeta.status, phone(SAVE_ID)], [403, before], "new-03: update-profile Sec-Fetch-Site: same-site → 403");
    const upOwn = await up({ origin: "https://rettfrabonden.com", "sec-fetch-site": "same-origin" }, "+47 900 00 003");
    assertEq([upOwn.status, upOwn.body?.success], [200, true], "new-04: the portal's fetch() save (own Origin) still works");
    const upNone = await up({}, "+47 900 00 004");
    assertEq([upNone.status, upNone.body?.success], [200, true], "new-05: no Origin (the /save fallback's server-side fetch) still works");

    // ── POST /eier/:id/save (the no-JS form) is guarded now ───────────────
    const SV = "/eier/:agentId/save";
    const phoneBefore = phone(SAVE_ID);
    logged.length = 0;
    const svX = await invoke(save, makeReq({ route: SV, params: { agentId: SAVE_ID }, body: { field_phone: "+47 911 11 111" }, token: tokens[SAVE_ID], headers: { origin: "https://evil.example" } }));
    assertEq([svX.status, phone(SAVE_ID)], [403, phoneBefore], "new-06: /eier/:id/save cross-site → 403, nothing written");
    assertTrue(String(svX.body).includes("Kunne ikke lagre") && String(svX.body).includes(`href="/eier/${SAVE_ID}/portal">Tilbake til eierportalen</a>`), "new-07: refused page with «Tilbake til eierportalen»");
    assertEq(guardLines(), [`[write-guard] refused ${SV} origin_foreign`], "new-08: one log line");
    process.env[FLAG_ENV] = "0";
    const svOld = await invoke(save, makeReq({ route: SV, params: { agentId: SAVE_ID }, body: { field_phone: "+47 911 11 112" }, token: tokens[SAVE_ID], headers: { origin: "null" } }));
    assertEq([svOld.status, phone(SAVE_ID)], [403, phoneBefore], "new-09: flag=0 → /eier/:id/save refuses Origin: null like the old check");
    delete process.env[FLAG_ENV];
  } catch (err: any) {
    failed++;
    failures.push(`✗ unexpected error: ${String(err?.stack || err)}`);
  } finally {
    console.log = prevLog;
    for (const [k, v] of Object.entries(prevEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    if (prevDb) initMod.__setDbForTesting(prevDb);
    try { db.close(); } catch { /* ignore */ }
  }
  return { passed, failed, failures };
}

if (require.main === module) {
  runWriteGuardT0aTests({ log: true }).then((r) => {
    console.info(`write-guard-t0a: ${r.passed} passed, ${r.failed} failed`);
    for (const f of r.failures) console.info(f);
    process.exit(r.failed ? 1 : 0);
  });
}
