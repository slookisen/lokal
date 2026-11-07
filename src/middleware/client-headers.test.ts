/**
 * client-headers.test.ts — dev-request 2026-10-16-klient-ip-fra-fly-client-ip, trinn 3.
 *
 * Proves middleware/client-headers.ts: config matrix (default, env on/off,
 * invalid value fails safe + logs, off Fly always off), X-Forwarded-Host
 * stripped, X-Forwarded-Proto from fly-forwarded-proto only for http/https,
 * an integration scenario (client-sent X-Forwarded-Host: finn-tannlege.com to
 * the rettfrabonden host must not reach the dental host gate), and the
 * src/index.ts wiring order. Real Express apps over Node's http module.
 *
 * Standalone: npx tsx src/middleware/client-headers.test.ts
 */

import express from "express";
import http from "http";
import fs from "fs";
import path from "path";
import { AddressInfo } from "net";
import {
  CLIENT_HEADERS_NORMALIZE_DEFAULT,
  resolveClientHeadersConfig,
  createClientHeadersMiddleware,
  installClientHeaders,
  type ClientHeadersConfig,
} from "./client-headers";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

const ON: ClientHeadersConfig = { enabled: true, onFly: true, reason: "default" };
const OFF: ClientHeadersConfig = { enabled: false, onFly: false, reason: "not_on_fly" };

interface Seen { hostname: string; protocol: string; secure: boolean; xfh: unknown; xfp: unknown }

function request(port: number, urlPath: string, headers: Record<string, string>): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: "127.0.0.1", port, path: urlPath, headers, agent: false }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode || 0, body }));
    });
    r.on("error", reject);
    r.end();
  });
}

async function withApp<T>(cfg: ClientHeadersConfig, fn: (port: number) => Promise<T>): Promise<T> {
  const app = express();
  app.set("trust proxy", true); // as installClientIp does
  installClientHeaders(app, cfg, () => {});
  // Stand-in for index.ts's host gates: dental vs rettfrabonden by req.hostname.
  app.get("/robots.txt", (req, res) => {
    res.type("text/plain").send(req.hostname === "finn-tannlege.com" ? "DENTAL-ROBOTS" : "RFB-ROBOTS");
  });
  app.get("/seen", (req, res) => {
    const seen: Seen = {
      hostname: req.hostname, protocol: req.protocol, secure: req.secure,
      xfh: req.headers["x-forwarded-host"], xfp: req.headers["x-forwarded-proto"],
    };
    res.json(seen);
  });
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    return await fn((server.address() as AddressInfo).port);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

export async function runClientHeadersTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];
  function assertEq(actual: unknown, expected: unknown, label: string): void {
    if (JSON.stringify(actual) === JSON.stringify(expected)) {
      passed++;
      if (log) console.log(`  ok ${label}`);
    } else {
      failed++;
      failures.push(`✗ ${label}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`);
      if (log) console.log("  " + failures[failures.length - 1]);
    }
  }

  // ── H1: config matrix
  assertEq(CLIENT_HEADERS_NORMALIZE_DEFAULT, true, "H1: default is on");
  const errs: string[] = [];
  const le = (m: string) => errs.push(m);
  assertEq(resolveClientHeadersConfig({}, le).enabled, false, "H1: no FLY_APP_NAME → off");
  assertEq(resolveClientHeadersConfig({ CLIENT_HEADERS_NORMALIZE: "on" }, le).enabled, false, "H1: off Fly, env on → still off");
  assertEq(resolveClientHeadersConfig({ FLY_APP_NAME: "  " }, le).onFly, false, "H1: blank FLY_APP_NAME → off Fly");
  assertEq(resolveClientHeadersConfig({ FLY_APP_NAME: "lokal" }, le), { enabled: true, onFly: true, reason: "default" }, "H1: on Fly, no env → default on");
  assertEq(resolveClientHeadersConfig({ FLY_APP_NAME: "lokal", CLIENT_HEADERS_NORMALIZE: " OFF " }, le).enabled, false, "H1: env OFF (case/space) → off (rollback)");
  assertEq(resolveClientHeadersConfig({ FLY_APP_NAME: "lokal", CLIENT_HEADERS_NORMALIZE: "On" }, le), { enabled: true, onFly: true, reason: "env" }, "H1: env On → on");
  assertEq(errs.length, 0, "H1: valid values log nothing");
  const bad = resolveClientHeadersConfig({ FLY_APP_NAME: "lokal", CLIENT_HEADERS_NORMALIZE: "enforce" }, le);
  assertEq([bad.enabled, bad.reason], [false, "invalid_env"], "H1: invalid value → off (today's behaviour), reason invalid_env");
  assertEq(errs.length, 1, "H1: invalid value logs exactly one error");

  // ── H2: unit — headers on a bare request object, next() once, never throws
  function unit(cfg: ClientHeadersConfig, headers: Record<string, string>) {
    let calls = 0;
    const req: any = { headers: { ...headers } };
    createClientHeadersMiddleware(cfg)(req, {} as any, () => { calls++; });
    return { headers: req.headers as Record<string, string>, calls };
  }
  let u = unit(ON, { "x-forwarded-host": "finn-tannlege.com", host: "rettfrabonden.com" });
  assertEq([u.headers["x-forwarded-host"], u.headers.host, u.calls], [undefined, "rettfrabonden.com", 1], "H2: XFH stripped, Host kept, next once");
  u = unit(ON, { "fly-forwarded-proto": "https", "x-forwarded-proto": "http" });
  assertEq(u.headers["x-forwarded-proto"], "https", "H2: https from fly-forwarded-proto overrides client XFP");
  u = unit(ON, { "fly-forwarded-proto": "http", "x-forwarded-proto": "https" });
  assertEq(u.headers["x-forwarded-proto"], "http", "H2: http from fly-forwarded-proto overrides client XFP");
  for (const g of ["HTTPS", "ftp", "https, http", "https ", "javascript:alert(1)", ""]) {
    u = unit(ON, { "fly-forwarded-proto": g, "x-forwarded-proto": "https" });
    assertEq(u.headers["x-forwarded-proto"], undefined, `H2: garbage fly-forwarded-proto ${JSON.stringify(g)} → XFP deleted`);
  }
  u = unit(ON, { "x-forwarded-proto": "https" });
  assertEq(u.headers["x-forwarded-proto"], undefined, "H2: missing fly-forwarded-proto → client XFP deleted");
  u = unit(OFF, { "x-forwarded-host": "finn-tannlege.com", "x-forwarded-proto": "https", "fly-forwarded-proto": "http" });
  assertEq(u.headers, { "x-forwarded-host": "finn-tannlege.com", "x-forwarded-proto": "https", "fly-forwarded-proto": "http" }, "H2: disabled → headers byte-identical");
  assertEq(u.calls, 1, "H2: disabled → next once");
  let threw = false;
  let nextCalls = 0;
  try { createClientHeadersMiddleware(ON)({ headers: null } as any, {} as any, () => { nextCalls++; }); } catch { threw = true; }
  assertEq([threw, nextCalls], [false, 1], "H2: malformed request → no throw, next once");

  // ── H3: integration — real Express req.hostname / req.protocol
  const spoof = { host: "rettfrabonden.com", "x-forwarded-host": "finn-tannlege.com" };
  await withApp(ON, async (port) => {
    const robots = await request(port, "/robots.txt", spoof);
    assertEq(robots.body, "RFB-ROBOTS", "H3: spoofed X-Forwarded-Host: finn-tannlege.com does NOT select dental robots.txt");
    const seen: Seen = JSON.parse((await request(port, "/seen", { ...spoof, "fly-forwarded-proto": "https", "x-forwarded-proto": "http" })).body);
    assertEq([seen.hostname, seen.protocol, seen.secure], ["rettfrabonden.com", "https", true], "H3: hostname from Host, protocol from fly-forwarded-proto");
    const plain: Seen = JSON.parse((await request(port, "/seen", { host: "rettfrabonden.com", "x-forwarded-proto": "https" })).body);
    assertEq([plain.protocol, plain.secure], ["http", false], "H3: client-sent XFP without fly-forwarded-proto is ignored");
    const legit = await request(port, "/robots.txt", { host: "finn-tannlege.com" });
    assertEq(legit.body, "DENTAL-ROBOTS", "H3: a real Host: finn-tannlege.com still gets dental");
  });
  await withApp(OFF, async (port) => {
    const robots = await request(port, "/robots.txt", spoof);
    assertEq(robots.body, "DENTAL-ROBOTS", "H3: disabled → spoof works (today's behaviour, the repro)");
  });

  // ── H4: wiring in src/index.ts
  const index = fs.readFileSync(path.join(__dirname, "..", "index.ts"), "utf8");
  const ipAt = index.indexOf("installClientIp(app,");
  const chAt = index.indexOf("installClientHeaders(app,");
  assertEq(index.split("installClientHeaders(app,").length - 1, 1, "H4: index.ts installs client-headers exactly once");
  assertTrue(ipAt >= 0 && chAt > ipAt, "H4: installed after installClientIp");
  const code = index.split("\n").map((l) => (l.trim().startsWith("//") ? "" : l)).join("\n");
  const firstCodeRead = code.search(/req\.hostname|req\.protocol|req\.secure/);
  assertTrue(firstCodeRead > code.indexOf("installClientHeaders(app,"), "H4: first req.hostname/protocol read in index.ts comes after the install");
  assertTrue(index.indexOf("app.use(requestTrackerMiddleware)") > chAt, "H4: before requestTrackerMiddleware");
  const wwwAt = index.indexOf('req.hostname === "www.rettfrabonden.com"');
  assertTrue(wwwAt > chAt, "H4: before the early www 301");
  const slashAt = index.indexOf('req.path.replace(/\\/+$/, "")');
  assertTrue(slashAt > chAt, "H4: before the trailing-slash 301");
  assertTrue(index.indexOf("app.use(helmet") === -1 || index.indexOf("app.use(helmet") > chAt, "H4: before helmet");

  function assertTrue(c: boolean, label: string) { assertEq(c, true, label); }
  return { passed, failed, failures };
}

if (require.main === module) {
  runClientHeadersTests({ log: true }).then((r) => {
    console.log(`\nclient-headers: ${r.passed} passed, ${r.failed} failed`);
    process.exit(r.failed > 0 ? 1 : 0);
  });
}
