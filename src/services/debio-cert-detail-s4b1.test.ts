/**
 * debio-cert-detail-s4b1.test.ts — A2A dev-request 2026-10-28-rfb-okologisk-
 * merking-debio-register-og-tekstrevisjon, slice S4b-1: normalizeCertDetail()
 * reads Debio's real getcertificatedetail format (top-level
 * certificateDetailPos[], captured from prod via the probe).
 *
 *   normalizer  509 → organic; 501/502 → not organic; result.sid outside
 *               500–5099 → statusCode null; no in-range code → recognized
 *               false; empty certificateDetailPos → recognized false; label
 *               «name (category)» with and without category; statusText from
 *               result.name, fallback result.caption; key casing ignored;
 *               partnerFullName never in the output.
 *   route       POST /admin/debio/cert-detail-probe over the new format:
 *               recognized, line_count, status_counts; partnerFullName never
 *               in the response; no database access.
 *
 * Injected fake fetch (no network). Exported runDebioCertDetailS4b1Tests({log})
 * -> TestSummary; wired into tests/test.ts. Standalone:
 *   npx tsx src/services/debio-cert-detail-s4b1.test.ts
 */

import Database from "better-sqlite3";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

// Synthetic Debio partner (person) name — must never be returned.
const PARTNER = "Qwzyrolf Partnersen";

function jsonFetch(body: unknown, status = 200): typeof fetch {
  return (async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
}

function pos(name: string | null, category: string | null, sid: unknown, resultName: string | null = null, caption: string | null = null): Record<string, unknown> {
  return {
    amount: null,
    category,
    name,
    partnerFullName: PARTNER,
    result: { caption, name: resultName, sid, subResult: null },
    unit: "stk",
  };
}

function realDetail(): Record<string, unknown> {
  return {
    additionalDWReports: [],
    certificateDetailPos: [
      pos("Melk", "Husdyr", 509, "Økologisk"),
      pos("Korn", null, 501, "Ikke økologisk"),
      pos("Poteter", "Planter", 502, null, "Karens år 1"),
      pos("Egg", "Husdyr", 12345, "Ukjent"),
      pos("Honning", null, 7, null),
    ],
    enquiryOrigSid: 4242,
    from: 1735689600000,
    sid: 99,
    to: 1767225600000,
  };
}

export async function runDebioCertDetailS4b1Tests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
    const n = client.normalizeCertDetail(realDetail());
    assertEq(n.recognized, true, "s4b1-norm-1: real format recognized");
    assertEq(n.lines.length, 5, "s4b1-norm-2: one line per certificateDetailPos entry");
    assertEq(n.lines[0], { label: "Melk (Husdyr)", statusCode: 509, statusText: "Økologisk", organic: true }, "s4b1-norm-3: 509 → organic, label «name (category)»");
    assertEq(n.lines[1], { label: "Korn", statusCode: 501, statusText: "Ikke økologisk", organic: false }, "s4b1-norm-4: 501 → not organic, label without category");
    assertEq(n.lines[2], { label: "Poteter (Planter)", statusCode: 502, statusText: "Karens år 1", organic: false }, "s4b1-norm-5: 502 → not organic, statusText falls back to result.caption");
    assertEq([n.lines[3].statusCode, n.lines[3].organic, n.lines[3].label], [null, false, "Egg (Husdyr)"], "s4b1-norm-6: result.sid 12345 (above 5099) → statusCode null");
    assertEq([n.lines[4].statusCode, n.lines[4].statusText], [null, null], "s4b1-norm-7: result.sid 7 (below 500) → statusCode null");
    assertEq(n.lines.filter((l) => l.organic).length, 1, "s4b1-norm-8: organic only for 509");
    assertEq(n.certificateUrl, null, "s4b1-norm-9: no certificate url in the real format");
    const nJson = JSON.stringify(n);
    assertTrue(!nJson.includes(PARTNER) && !nJson.includes("Partnersen"), "s4b1-norm-10: partnerFullName never in the normalized output", nJson);

    const outOfRange = client.normalizeCertDetail({
      certificateDetailPos: [pos("Melk", "Husdyr", 12345, "Ukjent"), pos("Korn", null, 7), pos("Egg", null, "509"), pos("Ost", null, 509.5)],
    });
    assertEq([outOfRange.recognized, outOfRange.lines.length], [false, 0], "s4b1-norm-11: no in-range integer code (12345, 7, \"509\", 509.5) → recognized false");

    const empty = client.normalizeCertDetail({ additionalDWReports: [], certificateDetailPos: [], enquiryOrigSid: 1, from: 0, sid: 1, to: 0 });
    assertEq(empty, { lines: [], recognized: false, certificateUrl: null }, "s4b1-norm-12: empty certificateDetailPos → recognized false");

    assertEq(client.normalizeCertDetail({ certificateDetailPos: [pos("Melk", null, 5099), pos("Korn", null, 500)] }).lines.map((l) => l.statusCode), [5099, 500], "s4b1-norm-13: range bounds 500 and 5099 inclusive");
    assertEq(client.normalizeCertDetail({ certificateDetailPos: [pos(null, "Husdyr", 509)] }).lines[0]?.label, "Husdyr", "s4b1-norm-14: category alone is the label");
    assertEq(client.normalizeCertDetail({ certificateDetailPos: [pos("  ", "", 509)] }).lines.map((l) => [l.label, l.statusCode]), [[null, 509]], "s4b1-norm-15: blank name/category → label null");
    assertEq(client.normalizeCertDetail({ CertificateDetailPOS: [{ Name: "Melk", Category: "Husdyr", Result: { SID: 509, Name: "Økologisk" } }] }).lines,
      [{ label: "Melk (Husdyr)", statusCode: 509, statusText: "Økologisk", organic: true }], "s4b1-norm-16: key casing ignored");
    const noResult = client.normalizeCertDetail({ certificateDetailPos: [{ name: "Melk", partnerFullName: PARTNER }, pos("Korn", null, 509)] });
    assertEq(noResult.lines.map((l) => [l.label, l.statusCode]), [["Melk", null], ["Korn", 509]], "s4b1-norm-17: line without result → statusCode null");
    const onlyPartner = client.normalizeCertDetail({ certificateDetailPos: [{ partnerFullName: PARTNER, result: { sid: 509 } }] });
    assertEq(onlyPartner.lines, [{ label: null, statusCode: 509, statusText: null, organic: true }], "s4b1-norm-18: partnerFullName is never a label");
    const nested = client.normalizeCertDetail({ wrapper: { certificateDetailPos: [pos("Melk", null, 509)] } });
    assertEq(nested.recognized, false, "s4b1-norm-19: certificateDetailPos is read at top level only");
    // Guessed S4a shapes are untouched.
    assertEq(client.normalizeCertDetail([{ name: "Ola Hansen", status: 509 }]).lines[0]?.label ?? null, null, "s4b1-norm-20: generic name is still not a label outside certificateDetailPos");
    assertEq(client.normalizeCertDetail({ lines: [{ product: "Egg", status: 12345 }] }).lines[0]?.statusCode, 12345, "s4b1-norm-21: S4a shapes keep their code handling");

    // ── route ────────────────────────────────────────────────────────────
    initMod.__initSchemaForTesting(db as any);
    let dbCalls = 0;
    const origPrepare = db.prepare.bind(db);
    const origExec = db.exec.bind(db);
    (db as any).prepare = (sql: string) => { dbCalls++; return origPrepare(sql); };
    (db as any).exec = (sql: string) => { dbCalls++; return origExec(sql); };
    initMod.__setDbForTesting(db as any);
    delete process.env.DEBIO_REGISTER_EXTRA_CA_PEM;
    process.env.ADMIN_KEY = "s4b1-admin-key";
    const ADMIN = process.env.ADMIN_KEY;

    try { delete require.cache[require.resolve("../routes/admin-debio-cross-check")]; } catch { /* not loaded */ }
    routeMod = require("../routes/admin-debio-cross-check");
    const adminRouter = routeMod.default as any;
    const layer = (adminRouter.stack as any[]).find((x: any) => x.route && x.route.path === "/cert-detail-probe" && x.route.methods?.post);
    assertTrue(!!layer, "s4b1-route-1: POST /cert-detail-probe registered");
    const handler = layer.route.stack[layer.route.stack.length - 1].handle as Function;
    const call = (body: any, headers: any = { "x-admin-key": ADMIN }) => new Promise<{ status: number; body: any }>((resolve) => {
      let status = 200;
      const res: any = { status(c: number) { status = c; return res; }, json(b: any) { resolve({ status, body: b }); return res; } };
      Promise.resolve(handler({ headers, query: {}, params: {}, body }, res)).catch((e: any) => resolve({ status: 599, body: String(e) }));
    });

    routeMod.__setCertDetailFetchForTesting(jsonFetch(realDetail()));
    const ok = await call({ enquiryOrigSid: 4242 });
    assertEq([ok.status, ok.body.ok, ok.body.recognized, ok.body.line_count], [200, true, true, 5], "s4b1-route-2: real format → ok, recognized, line_count 5");
    assertEq(ok.body.status_counts, { "501": 1, "502": 1, "509": 1, "none": 2 }, "s4b1-route-3: status_counts over the real format");
    assertEq(ok.body.lines[0], { statusCode: 509, organic: true, label_present: true, label_length: "Melk (Husdyr)".length, status_text_present: true }, "s4b1-route-4: line flags (contract unchanged)");
    assertTrue(Array.isArray(ok.body.shape) && ok.body.shape.includes("certificateDetailPos[].result.sid: number"), "s4b1-route-5: shape still returned", ok.body.shape);
    const okJson = JSON.stringify(ok.body);
    assertTrue(!okJson.includes(PARTNER) && !okJson.includes("Partnersen"), "s4b1-route-6: partnerFullName value never in the probe response", okJson);

    routeMod.__setCertDetailFetchForTesting(jsonFetch({ additionalDWReports: [], certificateDetailPos: [], enquiryOrigSid: 1, from: 0, sid: 1, to: 0 }));
    const emptyRes = await call({ enquiryOrigSid: 1 });
    assertEq([emptyRes.body.ok, emptyRes.body.recognized, emptyRes.body.line_count, emptyRes.body.status_counts], [true, false, 0, {}], "s4b1-route-7: empty certificateDetailPos → recognized false");

    assertEq(dbCalls, 0, "s4b1-route-8: probe never touches the database");
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
  runDebioCertDetailS4b1Tests({ log: true }).then((r) => {
    console.info(`\n${r.passed} passed, ${r.failed} failed`);
    for (const f of r.failures) console.info(f);
    process.exit(r.failed ? 1 : 0);
  });
}
