/**
 * debio-register-s1b.test.ts — A2A dev-request 2026-10-28-rfb-okologisk-
 * merking-debio-register-og-tekstrevisjon, slice S1b: the register fetch
 * reports WHY it failed, and an optional extra CA for portal.debio.no.
 *
 *   diag      undici-style TypeError('fetch failed', {cause}) → code + message
 *             in reject_reason; nested causes (bounded depth); no-cause error;
 *             our own 60 s abort → «timeout after N ms»; HTTP status + body
 *             snippet; length bounded.
 *   extra CA  DEBIO_REGISTER_EXTRA_CA_PEM: invalid → extra_ca_invalid (never
 *             ignored); valid (real or `\n`-escaped) → the node:https client
 *             is chosen; extra_ca boolean on the sync result, no PEM in it.
 *   https     local https.createServer with a throw-away self-signed cert on
 *             127.0.0.1 (generated with openssl at run time; skipped when
 *             openssl is missing): without the extra CA → cert error code,
 *             with it → 200 + body.
 *
 * In-memory DB (sync reject path only), fake fetch, no outside network.
 * Exported runDebioRegisterS1bTests({log}) -> TestSummary; wired into
 * tests/test.ts. Standalone: npx tsx src/services/debio-register-s1b.test.ts
 */

import Database from "better-sqlite3";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as https from "node:https";
import * as os from "node:os";
import * as path from "node:path";
import type { AddressInfo } from "node:net";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
  skipped: string[];
}

function certCause(): Error {
  return Object.assign(new Error("unable to verify the first certificate"), { code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE" });
}

function throwingFetch(err: unknown): typeof fetch {
  return (async () => { throw err; }) as unknown as typeof fetch;
}

/** Self-signed cert + key for 127.0.0.1 in a temp dir, or null without openssl. */
function makeSelfSigned(): { cert: string; key: string } | null {
  let dir: string | null = null;
  try {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "s1b-tls-"));
    const keyPath = path.join(dir, "k.pem");
    const certPath = path.join(dir, "c.pem");
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", keyPath, "-out", certPath,
      "-days", "2", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1"], { stdio: "ignore", timeout: 30_000 });
    return { cert: fs.readFileSync(certPath, "utf8"), key: fs.readFileSync(keyPath, "utf8") };
  } catch {
    return null;
  } finally {
    if (dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* temp */ } }
  }
}

export async function runDebioRegisterS1bTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];
  const skipped: string[] = [];
  const assertTrue = (cond: unknown, label: string, detail?: unknown) => {
    if (cond) { passed++; if (opts.log) console.info(`  ✓ ${label}`); }
    else { failed++; failures.push(`✗ ${label}${detail !== undefined ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`); }
  };

  const client = require("./debio-register-client") as typeof import("./debio-register-client");
  const sync = require("./debio-register-sync") as typeof import("./debio-register-sync");
  const prevWarn = console.warn;
  console.warn = () => { /* sync logs rejects */ };
  const db = new Database(":memory:");
  const NO_CA: NodeJS.ProcessEnv = {};
  let selfSigned: { cert: string; key: string } | null = null;

  try {
    // ── diag ────────────────────────────────────────────────────────────────
    const tlsErr = new TypeError("fetch failed", { cause: certCause() });
    const r1 = await sync.syncDebioRegister(db as any, { fetchImpl: throwingFetch(tlsErr), dryRun: true, env: NO_CA });
    const rr1 = r1.reject_reason ?? "";
    assertTrue(!r1.accepted && rr1.startsWith("fetch failed: TypeError fetch failed"), "diag-1: reject_reason starts with the error name + message", rr1);
    assertTrue(rr1.includes("code=UNABLE_TO_VERIFY_LEAF_SIGNATURE") && rr1.includes("unable to verify the first certificate"), "diag-2: cause code + message surface in reject_reason", rr1);
    assertTrue(r1.errors.includes(rr1), "diag-3: same text in errors[]", r1.errors);
    assertTrue(r1.extra_ca === false, "diag-4: extra_ca false without the env");

    const deep = new TypeError("fetch failed", {
      cause: Object.assign(new Error("connect ECONNREFUSED 10.0.0.1:443", {
        cause: Object.assign(new Error("level3", { cause: Object.assign(new Error("level4", { cause: Object.assign(new Error("level5", { cause: new Error("level6") })) })) }), { code: "L3" }),
      }), { code: "ECONNREFUSED", errno: -111, syscall: "connect", address: "10.0.0.1", port: 443 }),
    });
    const d = client.describeFetchError(deep);
    assertTrue(/code=ECONNREFUSED errno=-111 syscall=connect host=10\.0\.0\.1 port=443: connect ECONNREFUSED/.test(d), "diag-5: code/errno/syscall/host/port of a cause", d);
    assertTrue(d.includes("code=L3") && d.includes("level4") && d.includes("level5") && !d.includes("level6"), "diag-6: nested causes walked, max depth 4", d);

    const cyc: any = new Error("loop");
    cyc.cause = cyc;
    assertTrue(client.describeFetchError(cyc) === "Error loop", "diag-7: self-referencing cause does not loop", client.describeFetchError(cyc));

    const r2 = await sync.syncDebioRegister(db as any, { fetchImpl: throwingFetch(new Error("socket hang up")), dryRun: true, env: NO_CA });
    assertTrue(r2.reject_reason === "fetch failed: Error socket hang up", "diag-8: no-cause error → name + message", r2.reject_reason);

    const agg = Object.assign(new AggregateError([Object.assign(new Error("connect ECONNREFUSED ::1:443"), { code: "ECONNREFUSED" })], ""), { code: "ECONNREFUSED" });
    const dAgg = client.describeFetchError(new TypeError("fetch failed", { cause: agg }));
    assertTrue(dAgg.includes("AggregateError code=ECONNREFUSED") && dAgg.includes("connect ECONNREFUSED ::1:443"), "diag-9: AggregateError cause → its first error is walked", dAgg);

    const long = client.describeFetchError(new TypeError("fetch failed", { cause: new Error("x".repeat(2000)) }));
    assertTrue(long.length <= 500, "diag-10: description bounded to 500 chars", long.length);

    // Timeout: a fetch that only settles on abort; tiny timeout.
    const hanging = ((_u: any, init?: any) => new Promise((_res, rej) => {
      init?.signal?.addEventListener("abort", () => rej(Object.assign(new Error("This operation was aborted"), { name: "AbortError" })));
    })) as unknown as typeof fetch;
    let tmsg = "";
    try { await client.fetchDebioRegister({ fetchImpl: hanging, env: NO_CA, timeoutMs: 20 }); } catch (e: any) { tmsg = e.message; }
    assertTrue(tmsg === "timeout after 20 ms", "diag-11: our own abort → «timeout after N ms»", tmsg);
    assertTrue(client.DEBIO_REGISTER_TIMEOUT_MS === 60_000, "diag-12: default timeout 60 000 ms");

    const abortOther = Object.assign(new Error("This operation was aborted"), { name: "AbortError" });
    let amsg = "";
    try { await client.fetchDebioRegister({ fetchImpl: throwingFetch(abortOther), env: NO_CA }); } catch (e: any) { amsg = e.message; }
    assertTrue(amsg === "AbortError This operation was aborted", "diag-13: a foreign AbortError is described, not called our timeout", amsg);

    const http503 = (async () => new Response("Service   Unavailable\n" + "y".repeat(500), { status: 503 })) as unknown as typeof fetch;
    const r3 = await sync.syncDebioRegister(db as any, { fetchImpl: http503, dryRun: true, env: NO_CA });
    const rr3 = r3.reject_reason ?? "";
    assertTrue(rr3.startsWith("fetch failed: debio register HTTP 503: Service Unavailable"), "diag-14: HTTP status + body snippet", rr3);
    assertTrue(rr3.length < 260, "diag-15: HTTP body snippet bounded (~200 chars)", rr3.length);

    // ── extra CA ────────────────────────────────────────────────────────────
    const bad = await sync.syncDebioRegister(db as any, { fetchImpl: throwingFetch(tlsErr), dryRun: true, env: { DEBIO_REGISTER_EXTRA_CA_PEM: "not a pem" } });
    assertTrue((bad.reject_reason ?? "").includes("extra_ca_invalid"), "ca-1: unparsable PEM → extra_ca_invalid in reject_reason", bad.reject_reason);
    assertTrue(bad.extra_ca === false, "ca-2: invalid PEM → extra_ca false");
    const badBody = "-----BEGIN CERTIFICATE-----\nAAAAnotbase64cert\n-----END CERTIFICATE-----";
    const pBad = client.parseExtraCaPem(badBody);
    assertTrue(pBad.state === "invalid" && pBad.error.startsWith("extra_ca_invalid"), "ca-3: PEM block with a broken body → invalid", pBad);
    assertTrue(client.parseExtraCaPem("   ").state === "unset", "ca-4: whitespace-only env → unset");
    assertTrue(client.selectRegisterTransport({ env: NO_CA }).kind === "fetch", "ca-5: no env → global fetch");

    selfSigned = makeSelfSigned();
    if (!selfSigned) {
      skipped.push("ca-6…ca-12 + https-1…3: openssl not available to make a test certificate");
    } else {
      const pemOk = client.parseExtraCaPem(selfSigned.cert);
      assertTrue(pemOk.state === "ok" && pemOk.certs.length === 1, "ca-6: valid PEM parsed", pemOk.state);
      const escaped = selfSigned.cert.trim().replace(/\n/g, "\\n");
      const pemEsc = client.parseExtraCaPem(escaped + "\\n" + escaped);
      assertTrue(pemEsc.state === "ok" && pemEsc.certs.length === 2, "ca-7: `\\n`-escaped single-line form, two certs", pemEsc.state);
      const envCa = { DEBIO_REGISTER_EXTRA_CA_PEM: escaped };
      const tr = client.selectRegisterTransport({ env: envCa });
      assertTrue(tr.kind === "https_extra_ca", "ca-8: valid env → node:https extra-CA client chosen", tr.kind);
      const tls = require("node:tls") as typeof import("node:tls");
      assertTrue(tr.kind === "https_extra_ca" && tr.ca.length === tls.rootCertificates.length + 1, "ca-9: ca = root certificates + extra");
      assertTrue(client.selectRegisterTransport({ env: envCa, fetchImpl: throwingFetch(tlsErr) }).kind === "fetch", "ca-10: an injected fetchImpl still wins (tests)");
      assertTrue(client.registerExtraCaInUse({ env: envCa }) === true, "ca-11: registerExtraCaInUse true with a valid env");
      const rOk = await sync.syncDebioRegister(db as any, { fetchImpl: throwingFetch(tlsErr), dryRun: true, env: envCa });
      assertTrue(!JSON.stringify(rOk).includes("BEGIN CERTIFICATE") && !JSON.stringify(rOk).includes(escaped.slice(40, 80)), "ca-12: no PEM in the sync result");

      // ── https: local server, self-signed ─────────────────────────────────
      const server = https.createServer({ cert: selfSigned.cert, key: selfSigned.key }, (req, res) => {
        let b = "";
        req.on("data", (c) => { b += c; });
        req.on("end", () => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ echo: b, method: req.method })); });
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
      try {
        const url = `https://127.0.0.1:${(server.address() as AddressInfo).port}/ACM/api/certsearch/getcertificates`;
        const hdr = { "Content-Type": "application/json" };
        let noCaErr: unknown = null;
        try { await client.httpsPostText(url, "{}", hdr, [...tls.rootCertificates], 10_000); } catch (e) { noCaErr = e; }
        const noCaMsg = client.describeFetchError(noCaErr);
        assertTrue(noCaErr !== null && /code=(DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_VERIFY_LEAF_SIGNATURE)/.test(noCaMsg), "https-1: without the extra CA → certificate error code", noCaMsg);
        const ok = await client.httpsPostText(url, JSON.stringify({ searchText: "" }), hdr, [...tls.rootCertificates, selfSigned.cert], 10_000);
        assertTrue(ok.status === 200 && JSON.parse(ok.text).echo === JSON.stringify({ searchText: "" }) && JSON.parse(ok.text).method === "POST", "https-2: with the self-signed cert as extra CA → 200 + body", ok);
        let tErr = "";
        const silent = https.createServer({ cert: selfSigned.cert, key: selfSigned.key }, () => { /* never answers */ });
        await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", () => resolve()));
        try {
          const u2 = `https://127.0.0.1:${(silent.address() as AddressInfo).port}/`;
          try { await client.httpsPostText(u2, "{}", hdr, [selfSigned.cert], 150); } catch (e: any) { tErr = e.message; }
        } finally {
          silent.closeAllConnections();
          silent.close();
        }
        assertTrue(tErr === "timeout after 150 ms", "https-3: https client timeout covers a server that never answers", tErr);
      } finally {
        server.closeAllConnections();
        server.close();
      }
    }
  } catch (err: any) {
    failed++;
    failures.push(`✗ unexpected error: ${err?.stack || err}`);
  } finally {
    console.warn = prevWarn;
    try { db.close(); } catch { /* closed */ }
  }
  return { passed, failed, failures, skipped };
}

if (require.main === module) {
  runDebioRegisterS1bTests({ log: true }).then((r) => {
    console.info(`\n${r.passed} passed, ${r.failed} failed${r.skipped.length ? `, skipped: ${r.skipped.join("; ")}` : ""}`);
    for (const f of r.failures) console.info(f);
    process.exit(r.failed ? 1 : 0);
  });
}
