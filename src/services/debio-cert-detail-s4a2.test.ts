/**
 * debio-cert-detail-s4a2.test.ts — A2A dev-request 2026-10-28-rfb-okologisk-
 * merking-debio-register-og-tekstrevisjon, slice S4a-2: the cert-detail probe
 * (POST /admin/debio/cert-detail-probe) takes a register sid and probes with
 * the register row's `certificates[].enquiryOrigSid`.
 *
 *   normalizer  enquiryOrigSids: valid-now certificates first, then the rest,
 *               each latest `to` first; duplicates dropped; only positive
 *               integers (numbers + digit strings); `EnquiryOrigSid` key
 *               works; missing / non-array certificates → [].
 *   persistence a write sync over rows with and without enquiryOrigSid
 *               stores byte-identical data in every table, and no
 *               enquiryOrigSid value is stored anywhere.
 *   route       auth required; both / neither / invalid registerSid → 400
 *               without any fetch; register failure → ok:false with a
 *               body-free reason; not found; no id; success → the detail
 *               fetch got the right enquiryOrigSid, response has
 *               enquiry_orig_sid_used / _count (also on a detail failure);
 *               the enquiryOrigSid path is unchanged; no database access, no
 *               table change, no person name / street in any response.
 *
 * Injected fake fetch (no network). Exported runDebioCertDetailS4a2Tests({log})
 * -> TestSummary; wired into tests/test.ts. Standalone:
 *   npx tsx src/services/debio-cert-detail-s4a2.test.ts
 */

import Database from "better-sqlite3";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

const NOW = new Date("2026-11-05T12:00:00.000Z");
const T = NOW.getTime();
const DAY = 86_400_000;
// Synthetic Debio person name + street — must never be returned or stored.
const PERSON = "Qwzyrolf Personsen";
const STREET = "Hemmeligveien 93";

type Raw = Record<string, unknown>;

function regRow(sid: number, clientCode: string | null, certificates: unknown, extra: Raw = {}): Raw {
  return {
    sid, name: PERSON, street: STREET, houseNr: null, zipCode: "3101", city: "PROBEBY",
    dispCertificate: true, companyNumber: String(70000 + (sid % 1000)), producerCode: null, clientCode,
    certificates,
    mainProductGroups: [{ sid: 5015, name: "LBP – Landbruksproduksjon", caption: "Landbruksproduksjon", subProductGroups: null }],
    productGroupSids: [5260], regionSid: 11000, resultSids: [509], certificateAttachments: null,
    ...extra,
  };
}

/** Register rows for the route: 30531 has mixed certificates, 30532 has none with an id. */
function routeRegister(): Raw[] {
  return [
    regRow(30531, "934608526", [
      { sid: 1, from: T - 900 * DAY, to: T - 100 * DAY, enquiryOrigSid: 111 },      // expired
      { sid: 2, from: T - 100 * DAY, to: T + 400 * DAY, enquiryOrigSid: 222 },      // current, latest to
      { sid: 3, from: T - 50 * DAY, to: T + 100 * DAY, enquiryOrigSid: 333 },       // current
      { sid: 4, from: T - 10 * DAY, to: T + 300 * DAY, enquiryOrigSid: 222 },       // duplicate
    ]),
    regRow(30532, "934608527", [{ sid: 5, from: T - 10 * DAY, to: T + 300 * DAY }]),
    regRow(30533, "934608528", [{ sid: 6, from: T - 10 * DAY, to: T + 300 * DAY, enquiryOrigSid: 4242 }]),
  ];
}

function registerFetch(body: unknown, status = 200, count?: { n: number }): typeof fetch {
  return (async (url: any) => {
    if (count) count.n++;
    if (!String(url).includes("getcertificates")) return new Response("not found", { status: 404 });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

function detailFetch(body: unknown, status = 200, seen?: Array<{ url: string; init: any }>): typeof fetch {
  return (async (url: any, init: any) => {
    seen?.push({ url: String(url), init });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

function personDetail(): Raw {
  return {
    clientName: PERSON,
    street: STREET,
    tracesCertificateUrl: "https://webgate.ec.europa.eu/tracesnt/certificate/organic/NO-ØKO-01.123",
    productLines: [
      { productName: "Melk", statusSid: 509, statusName: "Økologisk" },
      { productName: "Korn", statusSid: "502" },
    ],
  };
}

export async function runDebioCertDetailS4a2Tests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];
  const assertEq = (actual: unknown, expected: unknown, label: string) => {
    if (JSON.stringify(actual) === JSON.stringify(expected)) { passed++; if (log) console.info(`  ok ${label}`); }
    else { failed++; const m = `✗ ${label}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`; failures.push(m); if (log) console.info("  " + m); }
  };
  const assertTrue = (cond: boolean, label: string, detail?: unknown) => {
    if (cond) { passed++; if (log) console.info(`  ok ${label}`); }
    else { failed++; failures.push(`✗ ${label}${detail === undefined ? "" : `\n    detail: ${JSON.stringify(detail)}`}`); if (log) console.info(`  ✗ ${label}`); }
  };

  const client = require("./debio-register-client") as typeof import("./debio-register-client");
  const sync = require("./debio-register-sync") as typeof import("./debio-register-sync");
  const initMod = require("../database/init") as typeof import("../database/init");
  const prevDb = initMod.__peekDbForTesting();
  const dbs: Database.Database[] = [];
  const ENV_KEYS = ["ADMIN_KEY", "DEBIO_REGISTER_EXTRA_CA_PEM", "RFB_DEBIO_REGISTER_SYNC"];
  const prevEnv: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) prevEnv[k] = process.env[k];
  const prevLog = console.log;
  const prevWarn = console.warn;
  if (!log) { console.log = () => { /* quiet */ }; console.warn = () => { /* quiet */ }; }
  let routeMod: any = null;

  try {
    // ── normalizer: enquiryOrigSids ───────────────────────────────────────
    const ids = (certificates: unknown) => client.normalizeRegisterRow(regRow(1, "934608526", certificates), NOW)?.enquiryOrigSids;
    assertEq(ids(routeRegister()[0].certificates), [222, 333, 111], "ids-1: current first (latest to first), then expired; duplicate dropped");
    assertEq(ids([
      { from: T - 900 * DAY, to: T - 300 * DAY, enquiryOrigSid: 1 },
      { from: T - 900 * DAY, to: T - 10 * DAY, enquiryOrigSid: 2 },
      { from: T + 10 * DAY, to: T + 900 * DAY, enquiryOrigSid: 3 },
      { from: T - 10 * DAY, to: T + 5 * DAY, enquiryOrigSid: 4 },
    ]), [4, 3, 2, 1], "ids-2: the rest (future + expired) after the current one, latest to first");
    assertEq(ids([
      { to: T + 10 * DAY, enquiryOrigSid: 5 },
      { from: T - 10 * DAY, to: T + 20 * DAY, enquiryOrigSid: 6 },
    ]), [6, 5], "ids-3: a missing from counts as started (as certificateValidity)");
    assertEq(ids([
      { from: T - 10 * DAY, to: T + 10 * DAY, enquiryOrigSid: 7 },
      { from: T - 10 * DAY, enquiryOrigSid: 8 },
      { from: T - 900 * DAY, to: T - 10 * DAY, enquiryOrigSid: 9 },
    ]), [7, 9, 8], "ids-4: no usable to → last");
    assertEq(ids([
      { to: T + 10 * DAY, enquiryOrigSid: "12" },
      { to: T + 9 * DAY, enquiryOrigSid: " 13 " },
      { to: T + 8 * DAY, enquiryOrigSid: -4 },
      { to: T + 7 * DAY, enquiryOrigSid: 0 },
      { to: T + 6 * DAY, enquiryOrigSid: 1.5 },
      { to: T + 5 * DAY, enquiryOrigSid: "1.5" },
      { to: T + 4 * DAY, enquiryOrigSid: "-3" },
      { to: T + 3 * DAY, enquiryOrigSid: "abc" },
      { to: T + 2 * DAY, enquiryOrigSid: null },
      { to: T + 1 * DAY, enquiryOrigSid: 2 ** 53 },
      { to: T + 1 * DAY, enquiryOrigSid: "99999999999999999999" },
      { to: T + 1 * DAY, enquiryOrigSid: true },
      { to: T + 1 * DAY, enquiryOrigSid: { sid: 5 } },
      { to: T + 1 * DAY, enquiryOrigSid: "12" },
      { to: T + 1 * DAY, enquiryOrigSid: 12 },
      null, "x", [14],
    ]), [12, 13], "ids-5: only positive safe integers (numbers + digit strings), duplicates across types dropped");
    assertEq(ids([{ To: T + 10 * DAY, EnquiryOrigSid: 15 }, { valid_to: T + 20 * DAY, enquiry_orig_sid: 16 }]), [16, 15], "ids-6: case-/separator-insensitive keys");
    assertEq(ids([{ to: "2027-01-31", enquiryOrigSid: 17 }, { to: "31.12.2027", enquiryOrigSid: 18 }]), [18, 17], "ids-7: ISO / dd.mm.yyyy to (same parsing as certificateValidity)");
    assertEq(client.normalizeRegisterRow({ name: "X", sid: 9 }, NOW)?.enquiryOrigSids, [], "ids-8: no certificates → []");
    assertEq(ids(null), [], "ids-9: certificates null → []");
    assertEq(ids({ enquiryOrigSid: 5 }), [], "ids-10: certificates not an array → []");
    assertEq(ids([]), [], "ids-11: empty certificates → []");
    assertEq(client.certificateEnquiryOrigSids("x", NOW), [], "ids-12: certificateEnquiryOrigSids on a string → []");
    const row = client.normalizeRegisterRow(routeRegister()[0], NOW)!;
    assertEq([row.sid, row.validTo], ["30531", new Date(T + 400 * DAY).toISOString().slice(0, 10)], "ids-13: sid / validity unchanged by the new field");

    // ── persistence: the new field changes nothing stored ─────────────────
    process.env.RFB_DEBIO_REGISTER_SYNC = "1";
    delete process.env.DEBIO_REGISTER_EXTRA_CA_PEM;
    const { marketplaceRegistry } = require("./marketplace-registry") as typeof import("./marketplace-registry");
    const clearRegistryCaches = () => {
      marketplaceRegistry._agentsCache = null; marketplaceRegistry._statsCache = null;
      marketplaceRegistry._agentsCacheTime = 0; marketplaceRegistry._statsCacheTime = 0;
    };
    const { loadConfigsAtBoot } = require("../config/vertical-config") as typeof import("../config/vertical-config");
    try { loadConfigsAtBoot(); } catch { /* already loaded */ }
    const ID_BASE = 987650000;
    const syncRows = (withIds: boolean): Raw[] => {
      const out: Raw[] = [];
      for (let i = 0; i < 2600; i++) {
        const certs: Raw[] = [
          { sid: 1, from: T - 100 * DAY, to: T + 400 * DAY, ...(withIds ? { enquiryOrigSid: ID_BASE + i } : {}) },
          { sid: 2, from: T - 900 * DAY, to: T - 100 * DAY, ...(withIds ? { enquiryOrigSid: ID_BASE + 5000 + i } : {}) },
        ];
        out.push(regRow(400000 + i, String(860000000 + i), i % 5 === 0 ? [certs[1]] : certs, {
          name: `Syntetisk Gard ${i} AS`, resultSids: i % 3 === 0 ? [502] : [509], city: "FYLLBY",
        }));
      }
      return out;
    };
    const syncOnce = async (withIds: boolean): Promise<string> => {
      const db = new Database(":memory:");
      dbs.push(db);
      db.pragma("foreign_keys = ON");
      initMod.__setDbForTesting(db as any);
      initMod.__initSchemaForTesting(db as any);
      clearRegistryCaches();
      for (let i = 0; i < 6; i++) {
        db.prepare(
          `INSERT INTO agents
             (id, name, description, provider, contact_email, url, role, api_key, lat, lng, city,
              categories, tags, skills, trust_score, is_active, is_verified, origin, vertical_id, catalog_hidden, debio_verified, org_nr)
           VALUES (?, ?, 'Familiegård.', 'test', ?, ?, 'producer', ?, 59.9, 10.7, 'Annenby', '["vegetables"]', '[]', '[]', 0.7, 1, 1, 'discovery', 'rfb', 0, 0, ?)`,
        ).run(`p-${i}`, `Testprodusent ${i}`, `post@p${i}.example.no`, `https://p${i}.example.no`, `key-p${i}`, String(860000000 + i));
      }
      const fetchImpl = (async (url: any, init?: any) => {
        const u = String(url);
        if (u.includes("getcertificates")) return registerFetch(syncRows(withIds))(url, init);
        if (u.includes("finnoko.debio.no/api/acm/companies")) return new Response("[]", { status: 200 });
        return new Response("not found", { status: 404 });
      }) as typeof fetch;
      const r = await sync.syncDebioRegister(db, { fetchImpl, dryRun: false, now: NOW, skipCache: true });
      if (!r.accepted) throw new Error(`sync not accepted: ${r.reject_reason}`);
      const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>).map((t) => t.name);
      const dump: Record<string, unknown[]> = {};
      for (const t of tables) {
        const rows = db.prepare(`SELECT * FROM "${t}"`).all();
        if (rows.length) dump[t] = rows;
      }
      // Wall-clock defaults (not the sync's injected NOW) are masked.
      return JSON.stringify(dump).replace(/"(?!2026-11-05)\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}[^"]*"/g, '"<ts>"');
    };
    const withIds = await syncOnce(true);
    const withoutIds = await syncOnce(false);
    assertTrue(withIds.includes("agent_debio_status") && withIds.includes("okologisk"), "persist-1: the write sync stored statuses", withIds.length);
    assertTrue(withIds === withoutIds, "persist-2: every table byte-identical with and without enquiryOrigSid in the register");
    const leaked = [ID_BASE, ID_BASE + 1, ID_BASE + 5000].filter((n) => withIds.includes(String(n)));
    assertEq(leaked, [], "persist-3: no enquiryOrigSid value stored in any table");
    assertTrue(!withIds.includes(PERSON) && !withIds.includes(STREET), "persist-4: no person name / street stored");

    // ── route ────────────────────────────────────────────────────────────
    const db = new Database(":memory:");
    dbs.push(db);
    initMod.__initSchemaForTesting(db as any);
    const schemaOf = () => JSON.stringify(db.prepare("SELECT type, name, sql FROM sqlite_master ORDER BY type, name").all());
    const schemaBefore = schemaOf();
    let dbCalls = 0;
    const origPrepare = db.prepare.bind(db);
    const origExec = db.exec.bind(db);
    (db as any).prepare = (sql: string) => { dbCalls++; return origPrepare(sql); };
    (db as any).exec = (sql: string) => { dbCalls++; return origExec(sql); };
    initMod.__setDbForTesting(db as any);
    process.env.ADMIN_KEY = "s4a2-admin-key";
    const ADMIN = process.env.ADMIN_KEY;

    try { delete require.cache[require.resolve("../routes/admin-debio-cross-check")]; } catch { /* not loaded */ }
    routeMod = require("../routes/admin-debio-cross-check");
    const adminRouter = routeMod.default as any;
    const layer = (adminRouter.stack as any[]).find((x: any) => x.route && x.route.path === "/cert-detail-probe" && x.route.methods?.post);
    assertTrue(!!layer, "route-1: POST /cert-detail-probe registered");
    const handler = layer.route.stack[layer.route.stack.length - 1].handle as Function;
    const call = (body: any, headers: any = { "x-admin-key": ADMIN }) => new Promise<{ status: number; body: any }>((resolve) => {
      let status = 200;
      const res: any = { status(c: number) { status = c; return res; }, json(b: any) { resolve({ status, body: b }); return res; } };
      Promise.resolve(handler({ headers, query: {}, params: {}, body }, res)).catch((e: any) => resolve({ status: 599, body: String(e) }));
    });
    const responses: string[] = [];

    const regCount = { n: 0 };
    let seen: Array<{ url: string; init: any }> = [];
    routeMod.__setCertProbeRegisterFetchForTesting(registerFetch(routeRegister(), 200, regCount));
    routeMod.__setCertDetailFetchForTesting(detailFetch(personDetail(), 200, seen));

    const noKey = await call({ registerSid: "30531" }, {});
    assertEq(noKey.status, 403, "route-2: no X-Admin-Key → 403");
    const wrongKey = await call({ registerSid: "30531" }, { "x-admin-key": "nope" });
    assertEq(wrongKey.status, 403, "route-3: wrong X-Admin-Key → 403");

    const bad: Array<[string, any]> = [
      ["both", { enquiryOrigSid: 4242, registerSid: "30531" }],
      ["both (null registerSid)", { enquiryOrigSid: 4242, registerSid: null }],
      ["neither", {}],
      ["no body", undefined],
      ["registerSid non-digits", { registerSid: "30a31" }],
      ["registerSid empty", { registerSid: "" }],
      ["registerSid too long", { registerSid: "1234567890123" }],
      ["registerSid number", { registerSid: 30531 }],
      ["registerSid negative", { registerSid: "-30531" }],
      ["registerSid with space", { registerSid: " 30531" }],
      ["registerSid null", { registerSid: null }],
      ["registerSid array", { registerSid: ["30531"] }],
    ];
    for (const [label, b] of bad) {
      const r = await call(b);
      responses.push(JSON.stringify(r.body));
      assertEq([r.status, r.body?.success, typeof r.body?.error], [400, false, "string"], `route-4: ${label} → 400 {success:false,error}`);
    }
    assertEq([regCount.n, seen.length], [0, 0], "route-5: no register / detail fetch on auth or validation failure");
    assertEq((await call({ registerSid: "123456789012" })).body.reason, "register_sid_not_found", "route-5b: 12 digits accepted");

    regCount.n = 0;
    seen = [];
    routeMod.__setCertDetailFetchForTesting(detailFetch(personDetail(), 200, seen));
    const ok = await call({ registerSid: "30531" });
    responses.push(JSON.stringify(ok.body));
    assertEq(ok.status, 200, "route-6: happy path 200");
    assertEq(regCount.n, 1, "route-7: register fetched exactly once");
    assertEq(seen.length, 1, "route-8: detail fetched exactly once");
    assertEq(seen[0]?.init?.body, JSON.stringify({ enquiryOrigSid: 222 }), "route-9: the detail fetch got the register's current enquiryOrigSid");
    assertEq([ok.body.ok, ok.body.recognized, ok.body.line_count, ok.body.enquiry_orig_sid_used, ok.body.enquiry_orig_sid_count], [true, true, 2, 222, 3], "route-10: probe result + enquiry_orig_sid_used / _count");
    assertEq(Object.keys(ok.body), ["ok", "shape", "recognized", "line_count", "lines", "status_counts", "certificate_url", "enquiry_orig_sid_used", "enquiry_orig_sid_count"], "route-11: S4a fields then the two new ones");
    assertEq(ok.body.status_counts, { "502": 1, "509": 1 }, "route-12: status_counts");

    seen = [];
    routeMod.__setCertDetailFetchForTesting(detailFetch(`boom ${PERSON}`, 500, seen));
    const detailFail = await call({ registerSid: "30533" });
    responses.push(JSON.stringify(detailFail.body));
    assertEq(detailFail.body, { ok: false, reason: "http_500", shape: [], recognized: false, line_count: 0, lines: [], status_counts: {}, certificate_url: null, enquiry_orig_sid_used: 4242, enquiry_orig_sid_count: 1 },
      "route-13: detail failure → ok:false with enquiry_orig_sid_used / _count");
    assertEq(seen[0]?.init?.body, JSON.stringify({ enquiryOrigSid: 4242 }), "route-14: detail fetch body for a single-certificate row");

    seen = [];
    routeMod.__setCertDetailFetchForTesting(detailFetch(personDetail(), 200, seen));
    const notFound = await call({ registerSid: "99999" });
    responses.push(JSON.stringify(notFound.body));
    assertEq(notFound.body, { ok: false, reason: "register_sid_not_found", shape: [], recognized: false, line_count: 0, lines: [], status_counts: {}, certificate_url: null }, "route-15: unknown register sid → register_sid_not_found");
    const noId = await call({ registerSid: "30532" });
    responses.push(JSON.stringify(noId.body));
    assertEq(noId.body, { ok: false, reason: "no_enquiry_orig_sid", shape: [], recognized: false, line_count: 0, lines: [], status_counts: {}, certificate_url: null }, "route-16: row without enquiryOrigSid → no_enquiry_orig_sid");
    assertEq(seen.length, 0, "route-17: no detail fetch when the register gives no id");

    const failCases: Array<[string, typeof fetch, string | RegExp]> = [
      ["HTTP 503", registerFetch(`down ${PERSON} ${STREET}`, 503), "register_http_503"],
      ["invalid JSON", registerFetch(`{"name":"${PERSON}"`, 200), "register_invalid_json"],
      ["throwing fetch", (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch, /^register_fetch_failed: TypeError fetch failed/],
    ];
    for (const [label, f, want] of failCases) {
      routeMod.__setCertProbeRegisterFetchForTesting(f);
      const r = await call({ registerSid: "30531" });
      responses.push(JSON.stringify(r.body));
      const { reason, ...rest } = r.body ?? {};
      assertTrue(r.status === 200 && r.body?.ok === false && (typeof want === "string" ? reason === want : want.test(String(reason))), `route-18: register ${label} → ok:false, reason ${String(want)}`, r.body);
      assertEq(rest, { ok: false, shape: [], recognized: false, line_count: 0, lines: [], status_counts: {}, certificate_url: null }, `route-19: register ${label} → the empty failure fields`);
    }
    assertEq(seen.length, 0, "route-20: no detail fetch when the register fetch fails");

    // The enquiryOrigSid path is unchanged (and never touches the register).
    regCount.n = 0;
    routeMod.__setCertProbeRegisterFetchForTesting(registerFetch(routeRegister(), 200, regCount));
    seen = [];
    routeMod.__setCertDetailFetchForTesting(detailFetch(personDetail(), 200, seen));
    const direct = await call({ enquiryOrigSid: 4242 });
    responses.push(JSON.stringify(direct.body));
    assertEq(Object.keys(direct.body), ["ok", "shape", "recognized", "line_count", "lines", "status_counts", "certificate_url"], "route-21: enquiryOrigSid path → S4a fields only, same order");
    assertEq([seen[0]?.init?.body, regCount.n], [JSON.stringify({ enquiryOrigSid: 4242 }), 0], "route-22: enquiryOrigSid passed through, no register fetch");
    routeMod.__setCertDetailFetchForTesting(detailFetch("x", 500));
    const directFail = await call({ enquiryOrigSid: 7 });
    assertEq(directFail.body, { ok: false, reason: "http_500", shape: [], recognized: false, line_count: 0, lines: [], status_counts: {}, certificate_url: null }, "route-23: enquiryOrigSid failure response unchanged");
    const directBad = await call({ enquiryOrigSid: "4242" });
    assertEq([directBad.status, directBad.body], [400, { success: false, error: "enquiryOrigSid must be a positive integer" }], "route-24: enquiryOrigSid validation message unchanged");

    assertEq(dbCalls, 0, "route-25: probe never touches the database");
    assertEq(origPrepare("SELECT 1").get() !== undefined && schemaOf() === schemaBefore, true, "route-26: no table / column change");
    const all = responses.join("\n");
    assertTrue(!all.includes(PERSON) && !all.includes(STREET) && !all.includes("Hemmelig"), "route-27: no person name / street in any response");
  } catch (err: any) {
    failed++;
    failures.push(`✗ unexpected error: ${err?.stack || err}`);
  } finally {
    console.log = prevLog;
    console.warn = prevWarn;
    try { routeMod?.__setCertDetailFetchForTesting(undefined); } catch { /* not loaded */ }
    try { routeMod?.__setCertProbeRegisterFetchForTesting(undefined); } catch { /* not loaded */ }
    for (const k of ENV_KEYS) { if (prevEnv[k] === undefined) delete process.env[k]; else process.env[k] = prevEnv[k]; }
    if (prevDb) initMod.__setDbForTesting(prevDb as any);
    for (const d of dbs) { try { d.close(); } catch { /* closed */ } }
  }
  return { passed, failed, failures };
}

if (require.main === module) {
  runDebioCertDetailS4a2Tests({ log: true }).then((r) => {
    console.info(`\n${r.passed} passed, ${r.failed} failed`);
    for (const f of r.failures) console.info(f);
    process.exit(r.failed ? 1 : 0);
  });
}
