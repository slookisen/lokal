/**
 * debio-cert-detail-s4a.test.ts — A2A dev-request 2026-10-28-rfb-okologisk-
 * merking-debio-register-og-tekstrevisjon, slice S4a: Debio certificate-detail
 * client + defensive normalizer + read-only admin probe
 * (POST /admin/debio/cert-detail-probe).
 *
 *   normalizer  bare array; envelope object; one nested envelope level;
 *               status as number, "509", {sid:509}; status text; TRACES link;
 *               unknown shape → recognized false, no lines.
 *   shape       describeShape() lists key paths + types, never values (a
 *               person-like name + street never appear).
 *   client      HTTP 500, invalid JSON, a throwing fetch and a timeout →
 *               ok:false, never throws; the POST body is {enquiryOrigSid}.
 *   route       auth required (403 without key); 400 on a bad body; happy
 *               path through an injected fetch; failure → ok:false; no
 *               database access; no person data in the response.
 *
 * Injected fake fetch (no network). Exported runDebioCertDetailS4aTests({log})
 * -> TestSummary; wired into tests/test.ts. Standalone:
 *   npx tsx src/services/debio-cert-detail-s4a.test.ts
 */

import Database from "better-sqlite3";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

// Synthetic Debio person name + street — must never be returned.
const PERSON = "Qwzyrolf Personsen";
const STREET = "Hemmeligveien 93";

function jsonFetch(body: unknown, status = 200, seen?: Array<{ url: string; init: any }>): typeof fetch {
  return (async (url: any, init: any) => {
    seen?.push({ url: String(url), init });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

function personDetail(): Record<string, unknown> {
  return {
    clientName: PERSON,
    street: STREET,
    zipCode: "3101",
    tracesCertificateUrl: "https://webgate.ec.europa.eu/tracesnt/certificate/organic/NO-ØKO-01.123",
    productLines: [
      { productName: "Melk", statusSid: 509, statusName: "Økologisk" },
      { productName: "Storfekjøtt", statusSid: 510 },
      { productName: "Korn", statusSid: "502" },
      { productName: "Poteter", statusSid: { sid: 501, caption: "Ikke økologisk" } },
      { productName: "X".repeat(300), statusSid: 509 },
    ],
  };
}

export async function runDebioCertDetailS4aTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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

  const client = require("./debio-cert-detail-client") as typeof import("./debio-cert-detail-client");
  const initMod = require("../database/init") as typeof import("../database/init");
  const prevDb = initMod.__peekDbForTesting();
  const db = new Database(":memory:");
  const ENV_KEYS = ["ADMIN_KEY", "DEBIO_REGISTER_EXTRA_CA_PEM"];
  const prevEnv: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) prevEnv[k] = process.env[k];
  const prevLog = console.log;
  const prevWarn = console.warn;
  if (!log) { console.log = () => { /* quiet */ }; console.warn = () => { /* quiet */ }; }
  let routeMod: any = null;

  try {
    // ── normalizer ───────────────────────────────────────────────────────
    const bare = client.normalizeCertDetail([
      { product: "Egg", status: 509 },
      { product: "Honning", status: "501" },
    ]);
    assertEq(bare.recognized, true, "norm-1: bare array recognized");
    assertEq(bare.lines.map((l) => [l.label, l.statusCode, l.organic]), [["Egg", 509, true], ["Honning", 501, false]], "norm-2: bare array lines (number + numeric string)");

    const env = client.normalizeCertDetail(personDetail());
    assertEq(env.recognized, true, "norm-3: envelope object recognized");
    assertEq(env.lines.map((l) => l.statusCode), [509, 510, 502, 501, 509], "norm-4: status as number, \"502\" and {sid:501}");
    assertEq(env.lines[0].statusText, "Økologisk", "norm-5: statusText from statusName");
    assertEq(env.lines[3].statusText, "Ikke økologisk", "norm-6: statusText from status object caption");
    assertEq(env.lines.filter((l) => l.organic).length, 2, "norm-7: organic only for 509");
    assertTrue(!!env.certificateUrl && env.certificateUrl.includes("tracesnt"), "norm-8: TRACES certificate url found", env.certificateUrl);
    const envJson = JSON.stringify(env);
    assertTrue(!envJson.includes(PERSON) && !envJson.includes(STREET), "norm-9: normalized output has no person name / street");

    const nested = client.normalizeCertDetail({ Certificate: { Lines: [{ Caption: "Grønnsaker", Status_Code: { code: "509" } }] } });
    assertEq(nested.lines, [{ label: "Grønnsaker", statusCode: 509, statusText: null, organic: true }], "norm-10: one nested level, case/separator-insensitive, {code:\"509\"}");

    const resultSid = client.normalizeCertDetail({ data: [{ description: "Sau", resultSid: 503 }] });
    assertEq(resultSid.lines[0]?.statusCode, 503, "norm-11: resultSid under data");

    const unknown1 = client.normalizeCertDetail({ foo: 1, bar: { baz: "x" } });
    assertEq([unknown1.recognized, unknown1.lines.length], [false, 0], "norm-12: unknown object → recognized false");
    const unknown2 = client.normalizeCertDetail([{ name: "Uten status" }]);
    assertEq([unknown2.recognized, unknown2.lines.length], [false, 0], "norm-13: lines without any status → recognized false");
    assertEq(client.normalizeCertDetail(null), { lines: [], recognized: false, certificateUrl: null }, "norm-14: null → recognized false");
    assertEq(client.normalizeCertDetail("tekst").recognized, false, "norm-15: string → recognized false");
    const generic = client.normalizeCertDetail([{ name: "Ola Hansen", title: "Ola Hansen", text: "Ola Hansen", status: 509 }]);
    assertEq(generic.lines, [{ label: null, statusCode: 509, statusText: null, organic: true }], "norm-16: generic name/title/text are never a label");

    // certificate url: only a hinted key or a traces value
    assertEq(client.normalizeCertDetail({ homepage: "https://ola-hansen.no", lines: [{ product: "Egg", status: 509 }] }).certificateUrl, null, "url-1: unhinted link (homepage) → null");
    assertEq(client.normalizeCertDetail({ homepage: "https://ola-hansen.no", certificateLink: "https://portal.debio.no/c/1" }).certificateUrl, "https://portal.debio.no/c/1", "url-2: hinted key accepted, unhinted ignored");
    assertEq(client.normalizeCertDetail({ website: "https://webgate.ec.europa.eu/tracesnt/x" }).certificateUrl, "https://webgate.ec.europa.eu/tracesnt/x", "url-3: traces value accepted under any key");

    // status object depth limit
    let deepSid: any = 509;
    for (let i = 0; i < 20000; i++) deepSid = { sid: deepSid };
    let deepOut: any = null;
    let deepThrew = false;
    try { deepOut = client.normalizeCertDetail([{ product: "Egg", status: deepSid }]); } catch { deepThrew = true; }
    assertTrue(!deepThrew && deepOut?.recognized === false, "depth-1: 20000-level {sid:{sid:…}} → no throw, no status", deepOut);
    assertEq(client.normalizeCertDetail([{ product: "Egg", status: { sid: { sid: { sid: 509 } } } }]).lines[0]?.statusCode, 509, "depth-2: 3 object levels still read");
    assertEq(client.normalizeCertDetail([{ product: "Egg", status: { sid: { sid: { sid: { sid: 509 } } } } }]).lines[0]?.statusCode ?? null, null, "depth-3: 4 object levels → null");

    // ── shape ────────────────────────────────────────────────────────────
    const shape = client.describeShape(personDetail());
    const shapeJson = JSON.stringify(shape);
    assertTrue(!shapeJson.includes(PERSON) && !shapeJson.includes(STREET) && !shapeJson.includes("3101") && !shapeJson.includes("Melk") && !shapeJson.includes("tracesnt"), "shape-1: no values in shape", shape);
    assertTrue(shape.includes("productLines[].statusSid: number|object|string"), "shape-2: array collapsed, element types merged", shape);
    assertTrue(shape.includes("clientName: string") && shape.includes("productLines: array"), "shape-3: top-level keys with types", shape);
    assertTrue(shape.includes("productLines[].statusSid.sid: number"), "shape-4: nested object path", shape);
    const bareShape = client.describeShape([{ statusSid: 509 }]);
    assertTrue(bareShape.includes("[].statusSid: number") && bareShape.includes("(root): array"), "shape-5: bare array root", bareShape);
    const keyed = client.describeShape({ byOwner: { [PERSON]: { x: 1 } } });
    assertTrue(!JSON.stringify(keyed).includes(PERSON) && keyed.includes("byOwner.<key>.x: number"), "shape-6: data-like keys masked", keyed);
    const wide = client.describeShape(Array.from({ length: 30 }, (_, i) => ({ [`k${i}`]: 1 })));
    assertTrue(wide.includes("[].k24: number") && !wide.some((p) => p.startsWith("[].k25")), "shape-8: only the first 25 array items are sampled", wide.length);
    const manyKeys: Record<string, number> = {};
    for (let i = 0; i < 500; i++) manyKeys[`key${i}`] = i;
    assertEq(client.describeShape(manyKeys).length, 400, "shape-9: at most 400 paths");
    const deep = client.describeShape({ a: { b: { c: { d: { e: { f: 1 } } } } } }, 2);
    assertTrue(deep.includes("a.b: object") && !deep.some((p) => p.startsWith("a.b.c")), "shape-7: maxDepth respected", deep);

    // ── client ───────────────────────────────────────────────────────────
    const noEnv = {} as NodeJS.ProcessEnv;
    const seen: Array<{ url: string; init: any }> = [];
    const okRes = await client.fetchDebioCertificateDetail(4242, { fetchImpl: jsonFetch(personDetail(), 200, seen), env: noEnv });
    assertEq(okRes.ok, true, "client-1: 200 JSON → ok");
    assertEq(seen[0]?.url, client.DEBIO_CERT_DETAIL_URL, "client-2: POSTs to getcertificatedetail");
    assertEq([seen[0]?.init?.method, seen[0]?.init?.body], ["POST", JSON.stringify({ enquiryOrigSid: 4242 })], "client-3: POST body {enquiryOrigSid}");
    assertTrue(typeof seen[0]?.init?.headers?.["User-Agent"] === "string" && seen[0].init.headers["User-Agent"].length > 0, "client-4: User-Agent set");

    const http500 = await client.fetchDebioCertificateDetail(1, { fetchImpl: jsonFetch(`fail ${PERSON}`, 500), env: noEnv });
    assertEq(http500, { ok: false, reason: "http_500" }, "client-5: HTTP 500 → ok:false, no body in reason");
    const badJson = await client.fetchDebioCertificateDetail(1, { fetchImpl: jsonFetch("{not json", 200), env: noEnv });
    assertEq(badJson, { ok: false, reason: "invalid_json" }, "client-6: invalid JSON → ok:false");
    const thrower = (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch;
    const thrown = await client.fetchDebioCertificateDetail(1, { fetchImpl: thrower, env: noEnv });
    assertTrue(!thrown.ok && /fetch failed/.test((thrown as any).reason), "client-7: throwing fetch → ok:false", thrown);
    const hang = ((_u: any, init: any) => new Promise((_res, rej) => {
      init?.signal?.addEventListener("abort", () => rej(new Error("aborted")));
    })) as unknown as typeof fetch;
    const timedOut = await client.fetchDebioCertificateDetail(1, { fetchImpl: hang, env: noEnv, timeoutMs: 30 });
    assertEq(timedOut, { ok: false, reason: "timeout after 30 ms" }, "client-8: timeout → ok:false");
    const badSid = await client.fetchDebioCertificateDetail(-3, { fetchImpl: jsonFetch({}), env: noEnv });
    assertEq(badSid.ok, false, "client-9: invalid sid → ok:false without a request");
    const badCa = await client.fetchDebioCertificateDetail(1, { env: { DEBIO_REGISTER_EXTRA_CA_PEM: "garbage" } as NodeJS.ProcessEnv });
    assertTrue(!badCa.ok && /extra_ca_invalid/.test((badCa as any).reason), "client-10: invalid extra CA → ok:false", badCa);
    assertEq(client.DEBIO_CERT_DETAIL_TIMEOUT_MS, 30_000, "client-11: default timeout 30 s");

    // ── route ────────────────────────────────────────────────────────────
    // A db whose every prepare/exec is counted — the probe must not touch it.
    initMod.__initSchemaForTesting(db as any);
    let dbCalls = 0;
    const origPrepare = db.prepare.bind(db);
    const origExec = db.exec.bind(db);
    (db as any).prepare = (sql: string) => { dbCalls++; return origPrepare(sql); };
    (db as any).exec = (sql: string) => { dbCalls++; return origExec(sql); };
    initMod.__setDbForTesting(db as any);
    delete process.env.DEBIO_REGISTER_EXTRA_CA_PEM;
    process.env.ADMIN_KEY = "s4a-admin-key";
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

    let fetchCount = 0;
    const counting = (inner: typeof fetch): typeof fetch => (async (u: any, i: any) => { fetchCount++; return inner(u, i); }) as typeof fetch;
    routeMod.__setCertDetailFetchForTesting(counting(jsonFetch(personDetail())));

    const noKey = await call({ enquiryOrigSid: 4242 }, {});
    assertEq(noKey.status, 403, "route-2: no X-Admin-Key → 403");
    const wrongKey = await call({ enquiryOrigSid: 4242 }, { "x-admin-key": "nope" });
    assertEq(wrongKey.status, 403, "route-3: wrong X-Admin-Key → 403");
    routeMod.__setCertDetailFetchForTesting(jsonFetch({ homepage: "https://ola-hansen.no", lines: [{ name: "Ola Hansen", status: 509 }, { clientName: "Ola Hansen", product: "Egg", status: 501, statusText: "Ola Hansen" }] }));
    const person = await call({ enquiryOrigSid: 9 });
    assertEq([person.body.ok, person.body.line_count, person.body.certificate_url], [true, 2, null], "route-19: person-data lines counted, homepage not a certificate url");
    assertTrue(!JSON.stringify(person.body).includes("Ola Hansen") && !JSON.stringify(person.body).includes("ola-hansen"), "route-20: person string never in the response", person.body);
    routeMod.__setCertDetailFetchForTesting(counting(jsonFetch(personDetail())));
    fetchCount = 0;
    for (const [i, b] of ([undefined, {}, { enquiryOrigSid: "4242" }, { enquiryOrigSid: 0 }, { enquiryOrigSid: -1 }, { enquiryOrigSid: 1.5 }, { enquiryOrigSid: null }] as any[]).entries()) {
      const r = await call(b);
      assertEq(r.status, 400, `route-4.${i}: bad body ${JSON.stringify(b)} → 400`);
    }
    assertEq(fetchCount, 0, "route-5: no fetch on auth/validation failure");

    const ok = await call({ enquiryOrigSid: 4242 });
    assertEq(ok.status, 200, "route-6: happy path 200");
    assertEq([ok.body.ok, ok.body.recognized, ok.body.line_count], [true, true, 5], "route-7: ok, recognized, line_count");
    assertEq(ok.body.status_counts, { "501": 1, "502": 1, "509": 2, "510": 1 }, "route-8: status_counts");
    assertTrue(Array.isArray(ok.body.shape) && ok.body.shape.length > 0, "route-9: shape returned");
    assertTrue(typeof ok.body.certificate_url === "string" && ok.body.certificate_url.includes("tracesnt"), "route-10: certificate_url");
    assertEq(ok.body.lines[0], { statusCode: 509, organic: true, label_present: true, label_length: 4, status_text_present: true }, "route-11: line has presence/length flags only");
    assertTrue((ok.body.lines as any[]).every((l) => !("label" in l) && !("statusText" in l)), "route-11b: no label / statusText values in the response");
    assertEq(ok.body.lines[4].label_length, 300, "route-11c: label_length is the full length");
    assertEq(fetchCount, 1, "route-12: exactly one fetch");
    const okJson = JSON.stringify(ok.body);
    assertTrue(!okJson.includes(PERSON) && !okJson.includes(STREET), "route-13: no person name / street in the response");

    const many = Array.from({ length: 80 }, (_, i) => ({ product: `P${i}`, status: i % 2 ? 509 : 501 }));
    routeMod.__setCertDetailFetchForTesting(jsonFetch({ items: many }));
    const big = await call({ enquiryOrigSid: 7 });
    assertEq([big.body.line_count, big.body.lines.length], [80, 50], "route-14: lines capped at 50, line_count total");
    assertEq(big.body.status_counts, { "501": 40, "509": 40 }, "route-15: status_counts over all lines");

    routeMod.__setCertDetailFetchForTesting(jsonFetch("boom", 500));
    const failRes = await call({ enquiryOrigSid: 7 });
    assertEq([failRes.status, failRes.body.ok, failRes.body.reason, failRes.body.recognized, failRes.body.line_count], [200, false, "http_500", false, 0], "route-16: upstream failure → ok:false with reason");

    routeMod.__setCertDetailFetchForTesting(jsonFetch({ weird: true }));
    const unk = await call({ enquiryOrigSid: 7 });
    assertEq([unk.body.ok, unk.body.recognized, unk.body.shape], [true, false, ["weird: boolean"]], "route-17: unknown shape → recognized false, shape only");

    assertEq(dbCalls, 0, "route-18: probe never touches the database");
  } catch (err: any) {
    failed++;
    failures.push(`✗ unexpected error: ${err?.stack || err}`);
  } finally {
    console.log = prevLog;
    console.warn = prevWarn;
    try { routeMod?.__setCertDetailFetchForTesting(undefined); } catch { /* not loaded */ }
    for (const k of ENV_KEYS) { if (prevEnv[k] === undefined) delete process.env[k]; else process.env[k] = prevEnv[k]; }
    if (prevDb) initMod.__setDbForTesting(prevDb as any);
    try { db.close(); } catch { /* closed */ }
  }
  return { passed, failed, failures };
}

if (require.main === module) {
  runDebioCertDetailS4aTests({ log: true }).then((r) => {
    console.info(`\n${r.passed} passed, ${r.failed} failed`);
    for (const f of r.failures) console.info(f);
    process.exit(r.failed ? 1 : 0);
  });
}
