/**
 * client-ip.test.ts — dev-request 2026-10-16-klient-ip-fra-fly-client-ip,
 * trinn 1 (test plan T1–T16 in A2A research-feed/2026-10-16-klient-ip-fly-
 * research.md §4 §10).
 *
 * Proves middleware/client-ip.ts:
 *   T1   enforce: rotated X-Forwarded-For + constant Fly-Client-IP → req.ip
 *        is Fly-Client-IP and ONE limiter bucket (Remaining −1 per call).
 *   T2   enforce fallback (no / invalid / non-public Fly-Client-IP): req.ip
 *        as today and X-Forwarded-For byte-identical (never deleted).
 *   T3   invalid values → `invalid`; T4 every BlockList range → `non_public`
 *        (and their public neighbours stay usable); T5 ::ffff: normalization.
 *   T6   IPv6 Fly-Client-IP; two addresses in one /56 share a bucket.
 *   T7   shadow: headers byte-identical, req.ip legacy, stats counted.
 *   T8   legacy: pure no-op, no stats.
 *   T9   resolveClientIpConfig matrix (off Fly always legacy; typo → legacy).
 *   T10  no collapse: 100 distinct clients stay 100 distinct req.ip, with
 *        and without Fly-Client-IP.
 *   T11  collapse breaker (G4): trips only on the collapse shape, at the
 *        exact thresholds, re-closes after 15 min, never on floods/spoofing.
 *   T12  never throws, next() exactly once.
 *   T13  src/index.ts mounts installClientIp once, before everything that
 *        reads the IP; nothing else in src/ sets `trust proxy`.
 *   T14  nothing else in src/ reads X-Forwarded-For or Fly-Client-IP.
 *   T15  `trust proxy` === true after installClientIp, in every mode.
 *   T16  no raw IP in any logged line or snapshot.
 *   T4e  trinn 1e: every non_public reports its range code (T4/T5 pin one
 *        per subnet edge), and non_public_by counts them per range, route
 *        and UA class in the window, the log line and since_boot, each
 *        split summing to fallback.non_public, with codes only (no IP).
 * Plus the stats line itself (the AC2/AC4 instrument): its counters, the
 * 5-min cadence, the 15-min top list and fallback_hc; and the stats keys
 * (createStatsKey): fixed size whatever the input, one per limiter bucket,
 * so a client's padded X-Forwarded-For is never what the stats hold.
 * Trinn 1b (review of PR #1102, S1–S3): the B1 pin (only createStatsKey keys
 * outlive a request), DISTINCT_CAP / TOP_CAP and the 5-bucket breaker ring
 * at their exact bounds; and the AC2 read-out — getInstalledClientIpSnapshot,
 * served as `clientIp` by the existing GET /admin/analytics/ops/event-loop.
 *
 * Real Express apps + a fresh express-rate-limit instance per scenario, over
 * Node's own http module (not global fetch — see mcp-rate-limit.test.ts for
 * why), injected clock and log sinks (no console swapping, no timers). No
 * DB, no env mutation; the installed-instance slot that installClientIp
 * fills is reset at the end.
 *
 * Standalone: npx tsx src/middleware/client-ip.test.ts
 */

import express from "express";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import http from "http";
import fs from "fs";
import path from "path";
import { AddressInfo } from "net";
import {
  CLIENT_IP_MODE_DEFAULT,
  BREAKER_OPEN_MS,
  resolveClientIpConfig,
  deriveFlyClientIp,
  createStatsKey,
  createClientIpMiddleware,
  installClientIp,
  getInstalledClientIpSnapshot,
  __resetInstalledClientIpForTesting,
  type ClientIpConfig,
  type ClientIpMiddleware,
  type ClientIpMiddlewareOptions,
  type ClientIpOpsSnapshot,
  NON_PUBLIC_RANGE_CODES,
  type NonPublicRange,
} from "./client-ip";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

// lokal's shared anycast IPv4: the right-most entry Fly appends to X-Forwarded-For.
const APP_IP = "66.241.125.60";
/** X-Forwarded-For as Fly delivers it: <client's own entries…>, <client IP>, <app IP>. */
const flyXff = (client: string, ...clientSent: string[]): string => [...clientSent, client, APP_IP].join(", ");

const ENFORCE: ClientIpConfig = { mode: "enforce", onFly: true, reason: "env" };
const SHADOW: ClientIpConfig = { mode: "shadow", onFly: true, reason: "default" };
const LEGACY: ClientIpConfig = { mode: "legacy", onFly: false, reason: "not_on_fly" };

// 2026-10-16T12:00:00Z — on a minute and a 5-min boundary.
const T0 = Date.UTC(2026, 9, 16, 12, 0, 0);
const MIN = 60_000;

const CHATGPT_UA = "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot";

function get(
  port: number,
  urlPath: string,
  headers: Record<string, string>
): Promise<{ status: number; json: any; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: urlPath, method: "GET", headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        // A non-JSON body (e.g. the limiter's plain-text 429 when clients
        // collapse into one bucket) must fail assertions, not crash the run.
        let json: any = { nonJson: text };
        try { json = JSON.parse(text); } catch { /* non-JSON response */ }
        resolve({ status: res.statusCode ?? 0, json, headers: res.headers });
      });
    });
    req.on("error", reject);
    req.end();
  });
}

interface ProbeServer {
  port: number;
  mw: ClientIpMiddleware;
  lines: string[];
  errors: string[];
  close: () => Promise<void>;
}

/**
 * installClientIp + a fresh limiter (50/min, default key = ipKeyGenerator(req.ip)) + an echo route.
 * The middleware's clock is pinned (T0) so a run never straddles a 5-min stats window.
 */
async function startProbe(cfg: ClientIpConfig, opts: ClientIpMiddlewareOptions = {}): Promise<ProbeServer> {
  const lines: string[] = [];
  const errors: string[] = [];
  const app = express();
  const mw = installClientIp(app, cfg, { now: () => T0, log: (l) => lines.push(l), logError: (l) => errors.push(l), store: null, ...opts });
  const limiter = rateLimit({
    windowMs: 60_000,
    max: 50,
    standardHeaders: true,
    legacyHeaders: false,
    validate: { trustProxy: false },
  });
  app.get("/api/probe", limiter, (req, res) => {
    res.json({
      ip: req.ip ?? null,
      ips: req.ips,
      xff: req.headers["x-forwarded-for"] ?? null,
      fci: req.headers["fly-client-ip"] ?? null,
    });
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const port = (server.address() as AddressInfo).port;
  return { port, mw, lines, errors, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

const remaining = (r: { headers: http.IncomingHttpHeaders }): number => Number(r.headers["ratelimit-remaining"]);

/** A request object as the middleware sees it: lower-case headers; `ip` = what legacy Express would say. */
function fakeReq(o: { fci?: unknown; xff?: unknown; ip?: string; path?: string; ua?: string }): any {
  const headers: Record<string, unknown> = {};
  if (o.fci !== undefined) headers["fly-client-ip"] = o.fci;
  if (o.xff !== undefined) headers["x-forwarded-for"] = o.xff;
  if (o.ua !== undefined) headers["user-agent"] = o.ua;
  return { headers, path: o.path ?? "/api/x", ip: o.ip };
}

export async function runClientIpTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
      const msg = `✗ ${label}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`;
      failures.push(msg);
      if (log) console.log("  " + msg);
    }
  }
  function assertTrue(cond: boolean, label: string): void {
    if (cond) {
      passed++;
      if (log) console.log(`  ok ${label}`);
    } else {
      failed++;
      failures.push(`✗ ${label}`);
      if (log) console.log(`  ✗ ${label}`);
    }
  }

  // ── T1: enforce — rotated XFF, constant Fly-Client-IP → one client, one bucket ──
  {
    const s = await startProbe(ENFORCE);
    try {
      const fci = "198.51.100.7";
      const rem: number[] = [];
      const ips: string[] = [];
      let allRewritten = true;
      for (let i = 0; i < 5; i++) {
        const r = await get(s.port, "/api/probe", { "Fly-Client-IP": fci, "X-Forwarded-For": flyXff(fci, `203.0.113.${10 + i}`) });
        rem.push(remaining(r));
        ips.push(r.json.ip);
        if (r.json.xff !== fci || JSON.stringify(r.json.ips) !== JSON.stringify([fci])) allRewritten = false;
      }
      assertEq(ips, [fci, fci, fci, fci, fci], "T1: enforce — req.ip is Fly-Client-IP for 5 rotated spoofed X-Forwarded-For values");
      assertEq(rem, [49, 48, 47, 46, 45], "T1: enforce — the 5 calls count down ONE bucket (Remaining −1 per call), spoofing gives no fresh bucket");
      assertTrue(allRewritten, "T1: enforce — X-Forwarded-For is rewritten to exactly [Fly-Client-IP] (req.ips too)");
    } finally {
      await s.close();
    }
  }

  // ── T2: enforce fallbacks — today's req.ip, header byte-identical ──
  {
    const s = await startProbe(ENFORCE);
    try {
      const xff = "203.0.113.21, 198.51.100.22, 66.241.125.60";
      for (const [label, fciHeader] of [
        ["no Fly-Client-IP", undefined],
        ["invalid Fly-Client-IP", "garbage"],
        ["non-public Fly-Client-IP (Fly's 172.16/12 proxy range)", "172.16.5.4"],
        ["non-public Fly-Client-IP (6PN)", "fdaa:0:1::2"],
      ] as const) {
        const headers: Record<string, string> = { "X-Forwarded-For": xff };
        if (fciHeader !== undefined) headers["Fly-Client-IP"] = fciHeader;
        const r = await get(s.port, "/api/probe", headers);
        assertEq(r.json.ip, "203.0.113.21", `T2: enforce, ${label} → req.ip is the left-most XFF entry, exactly as today`);
        assertEq(r.json.xff, xff, `T2: enforce, ${label} → X-Forwarded-For byte-identical (not deleted, not set to a constant)`);
      }
      const bare = await get(s.port, "/api/probe", {});
      assertEq([bare.json.ip, bare.json.xff], ["127.0.0.1", null], "T2: enforce, no Fly-Client-IP and no XFF → socket address, header still absent (today's behaviour)");
    } finally {
      await s.close();
    }
  }

  // ── T3: invalid values ──
  {
    const invalid: Array<[string, unknown]> = [
      ["empty", ""],
      ["blank", " "],
      ["garbage", "garbage"],
      // Lists: net.isIP is what rejects these. The explicit "," check in
      // deriveFlyClientIp is a second guard, so mutant M10 (drop it) is
      // equivalent and survives by design.
      ["a list", "1.2.3.4, 5.6.7.8"],
      ["trailing comma", "203.0.113.5,"],
      ["bracketed IPv6", "[::1]"],
      ["with port", "1.2.3.4:80"],
      ["1000 chars", "1".repeat(1000)],
      ["IPv6 zone index (public)", "2001:db8::1%eth0"],
      ["IPv6 zone index (link-local)", "fe80::1%eth0"],
      ["octet > 255", "999.1.1.1"],
      ["mapped, octet > 255", "::ffff:999.1.1.1"],
      ["leading zero", "01.2.3.4"],
      ["three octets", "1.2.3"],
      ["array", ["1.2.3.4"]],
      ["number", 1234],
      ["object", { ip: "1.2.3.4" }],
      ["null", null],
    ];
    for (const [label, v] of invalid) {
      assertEq(deriveFlyClientIp({ "fly-client-ip": v }), { ok: false, fallback: "invalid" }, `T3: Fly-Client-IP ${label} → invalid`);
    }
    assertEq(deriveFlyClientIp({}), { ok: false, fallback: "missing" }, "T3: no Fly-Client-IP header → missing");
    assertEq(deriveFlyClientIp(undefined), { ok: false, fallback: "missing" }, "T3: no headers object → missing");
    assertEq(deriveFlyClientIp(null), { ok: false, fallback: "missing" }, "T3: null headers → missing");
    assertEq(deriveFlyClientIp({ "fly-client-ip": " 203.0.113.5 " }), { ok: true, ip: "203.0.113.5" }, "T3: surrounding whitespace is trimmed");
    assertEq(
      deriveFlyClientIp({ "fly-client-ip": "2001:0db8:1234:5678:9abc:def0:203.100.113.255" }),
      { ok: true, ip: "2001:0db8:1234:5678:9abc:def0:203.100.113.255" },
      "T3: a 45-char IPv6 address (the longest textual form) is accepted"
    );
  }

  // ── T4: non-public ranges (G2) and their public neighbours ──
  {
    // Trinn 1e: each with the range code it must report (both edges of every subnet).
    const nonPublic: Array<[string, NonPublicRange]> = [
      ["0.0.0.0", "v4_other"], ["0.255.255.255", "v4_other"], ["10.0.0.0", "v4_10"], ["10.255.255.255", "v4_10"],
      ["100.64.0.0", "v4_cgnat"], ["100.64.1.1", "v4_cgnat"], ["100.127.255.255", "v4_cgnat"],
      ["127.0.0.1", "v4_loopback"], ["127.255.255.255", "v4_loopback"], ["169.254.0.1", "v4_link_local"],
      ["169.254.255.255", "v4_link_local"], ["172.16.0.0", "v4_172_16"], ["172.16.5.4", "v4_172_16"],
      ["172.31.255.255", "v4_172_16"], ["192.168.0.1", "v4_192_168"], ["192.168.255.255", "v4_192_168"],
      ["224.0.0.1", "v4_other"], ["239.255.255.255", "v4_other"], ["240.0.0.1", "v4_other"], ["255.255.255.255", "v4_other"],
      ["::", "v6_reserved"], ["::1", "v6_reserved"], ["fc00::", "v6_ula"], ["fdaa::1", "v6_ula"], ["fdaa:0:1::2", "v6_ula"],
      ["fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff", "v6_ula"], ["fe80::1", "v6_link_local"], ["febf:ffff::1", "v6_link_local"],
      ["ff02::1", "v6_multicast"], ["ff00::", "v6_multicast"],
    ];
    for (const [ip, range] of nonPublic) {
      assertEq(deriveFlyClientIp({ "fly-client-ip": ip }), { ok: false, fallback: "non_public", range }, `T4: ${ip} → non_public (${range})`);
    }
    const publicNeighbours = [
      "1.0.0.0", "9.255.255.255", "11.0.0.0", "100.63.255.255", "100.128.0.0", "126.255.255.255", "128.0.0.0",
      "169.253.255.255", "169.255.0.0", "172.15.255.255", "172.32.0.0", "192.167.255.255", "192.169.0.0",
      "223.255.255.255", "203.0.113.9", "66.241.125.60",
      "100::1", "2001:db8::1", "2a09:8280:1::ee:4f57:0", "fbff:ffff::1", "fec0::1", "feff::1",
    ];
    for (const ip of publicNeighbours) {
      assertEq(deriveFlyClientIp({ "fly-client-ip": ip }), { ok: true, ip }, `T4: ${ip} (public, next to a blocked range) → usable`);
    }
  }

  // ── T5: ::ffff: normalization, and every other IPv4-embedding IPv6 form falls back ──
  {
    assertEq(deriveFlyClientIp({ "fly-client-ip": "::ffff:203.0.113.9" }), { ok: true, ip: "203.0.113.9" }, "T5: ::ffff:203.0.113.9 → 203.0.113.9");
    assertEq(deriveFlyClientIp({ "fly-client-ip": "::FFFF:203.0.113.9" }), { ok: true, ip: "203.0.113.9" }, "T5: ::FFFF: (upper case) normalized too");
    assertEq(deriveFlyClientIp({ "fly-client-ip": "::ffff:10.0.0.1" }), { ok: false, fallback: "non_public", range: "v4_10" }, "T5: a mapped private IPv4 is non_public after normalization");
    // Why the rest of ::/8 is non_public: ipKeyGenerator puts every IPv4
    // client written in hex in these forms into ONE /56 bucket.
    assertEq(
      [ipKeyGenerator("::ffff:7b7b:7b7b"), ipKeyGenerator("::ffff:c633:6409"), ipKeyGenerator("64:ff9b::cb00:7109"), ipKeyGenerator("64:ff9b::c633:6409")],
      ["::/56", "::/56", "64:ff9b::/56", "64:ff9b::/56"],
      "T5: (why) ipKeyGenerator collapses hex-mapped and hex NAT64 IPv4 forms to one bucket each"
    );
    for (const ip of ["::ffff:7b7b:7b7b", "0:0:0:0:0:ffff:cb00:7109", "::1.2.3.4", "64:ff9b::203.0.113.9", "64:ff9b::cb00:7109"]) {
      assertEq(deriveFlyClientIp({ "fly-client-ip": ip }), { ok: false, fallback: "non_public", range: "v6_reserved" }, `T5: IPv4-embedding ${ip} → non_public (never a shared /56 bucket)`);
    }
    const s = await startProbe(ENFORCE);
    try {
      const r = await get(s.port, "/api/probe", { "Fly-Client-IP": "::ffff:203.0.113.9", "X-Forwarded-For": flyXff("::ffff:203.0.113.9", "192.0.2.1") });
      assertEq([r.json.ip, r.json.xff], ["203.0.113.9", "203.0.113.9"], "T5: enforce — req.ip is the normalized IPv4 form");
    } finally {
      await s.close();
    }
  }

  // ── T6: IPv6 Fly-Client-IP; one /56 = one bucket (existing ipKeyGenerator behaviour) ──
  {
    const s = await startProbe(ENFORCE);
    try {
      const a = await get(s.port, "/api/probe", { "Fly-Client-IP": "2001:db8:abcd:1200::1", "X-Forwarded-For": flyXff("2001:db8:abcd:1200::1", "192.0.2.1") });
      const b = await get(s.port, "/api/probe", { "Fly-Client-IP": "2001:db8:abcd:12ff::2", "X-Forwarded-For": flyXff("2001:db8:abcd:12ff::2", "192.0.2.2") });
      const c = await get(s.port, "/api/probe", { "Fly-Client-IP": "2001:db8:abcd:1300::1", "X-Forwarded-For": flyXff("2001:db8:abcd:1300::1") });
      assertEq([a.json.ip, b.json.ip, c.json.ip], ["2001:db8:abcd:1200::1", "2001:db8:abcd:12ff::2", "2001:db8:abcd:1300::1"], "T6: enforce — req.ip is the IPv6 Fly-Client-IP");
      assertEq([remaining(a), remaining(b), remaining(c)], [49, 48, 49], "T6: two addresses in one /56 share a bucket; the next /56 gets its own");
    } finally {
      await s.close();
    }
  }

  // ── T7: shadow — no behaviour change, stats counted ──
  {
    const s = await startProbe(SHADOW);
    try {
      const fci = "198.51.100.7";
      const rem: number[] = [];
      let identical = true;
      let legacyIp = true;
      for (let i = 0; i < 5; i++) {
        const xff = flyXff(fci, `203.0.113.${10 + i}`);
        const r = await get(s.port, "/api/probe", { "Fly-Client-IP": fci, "X-Forwarded-For": xff });
        rem.push(remaining(r));
        if (r.json.xff !== xff || r.json.fci !== fci) identical = false;
        if (r.json.ip !== `203.0.113.${10 + i}`) legacyIp = false;
      }
      assertTrue(identical, "T7: shadow — X-Forwarded-For and Fly-Client-IP reach the route byte-identical");
      assertTrue(legacyIp, "T7: shadow — req.ip is the legacy value (left-most XFF entry)");
      assertEq(rem, [49, 49, 49, 49, 49], "T7: shadow — rotated XFF still gets a fresh bucket each time (trinn 1 changes no behaviour)");
      const snap = s.mw.snapshot();
      assertEq([snap.mode, snap.n, snap.fci_valid, snap.xff_client_supplied], ["shadow", 5, 5, 5], "T7: shadow — the 5 requests are counted in the stats");
      assertEq(snap.agree_fci_edge, { n: 5, agree: 5 }, "T7: shadow — Fly-Client-IP agrees with Fly's own XFF entry [len-2] on all 5");
      assertEq([snap.D_fci, snap.D_edge, snap.D_legacy], [1, 1, 5], "T7: shadow — 1 real client behind 5 spoofed legacy keys");
    } finally {
      await s.close();
    }
  }

  // ── T8: legacy — pure no-op ──
  {
    const s = await startProbe(LEGACY);
    try {
      const xff = flyXff("198.51.100.7", "203.0.113.10");
      const r = await get(s.port, "/api/probe", { "Fly-Client-IP": "198.51.100.7", "X-Forwarded-For": xff });
      assertEq([r.json.ip, r.json.xff, r.json.fci], ["203.0.113.10", xff, "198.51.100.7"], "T8: legacy — req.ip and headers exactly as today");
      assertEq(s.mw.snapshot().n, 0, "T8: legacy — no stats");
      assertEq(s.lines.length, 1, "T8: legacy — only the boot line is logged");
    } finally {
      await s.close();
    }
    // Never even touches req.headers: a getter that throws proves it.
    const mw = createClientIpMiddleware(LEGACY, { log: () => {}, logError: () => {} });
    const req: any = {};
    Object.defineProperty(req, "headers", { get() { throw new Error("legacy must not read headers"); } });
    let calls = 0;
    let threw = false;
    try { mw(req, {} as any, () => { calls++; }); } catch { threw = true; }
    assertEq([threw, calls], [false, 1], "T8: legacy — does not read the request at all, next() once");
  }

  // ── T9: resolveClientIpConfig ──
  {
    const errs: string[] = [];
    const r = (env: Record<string, string | undefined>) => resolveClientIpConfig(env, (l) => errs.push(l));
    assertEq(CLIENT_IP_MODE_DEFAULT, "shadow", "T9: trinn 1 default is shadow (trinn 2 flips exactly this)");
    assertEq(r({}), { mode: "legacy", onFly: false, reason: "not_on_fly" }, "T9: {} (local dev, CI, npm test) → legacy");
    assertEq(r({ FLY_APP_NAME: "" }), { mode: "legacy", onFly: false, reason: "not_on_fly" }, "T9: empty FLY_APP_NAME → legacy");
    assertEq(r({ FLY_APP_NAME: "   " }), { mode: "legacy", onFly: false, reason: "not_on_fly" }, "T9: blank FLY_APP_NAME → legacy");
    assertEq(r({ CLIENT_IP_MODE: "enforce" }), { mode: "legacy", onFly: false, reason: "not_on_fly" }, "T9: CLIENT_IP_MODE=enforce off Fly → still legacy");
    assertEq(r({ FLY_APP_NAME: "lokal" }), { mode: CLIENT_IP_MODE_DEFAULT, onFly: true, reason: "default" }, "T9: on Fly, no CLIENT_IP_MODE → CLIENT_IP_MODE_DEFAULT");
    assertEq(r({ FLY_APP_NAME: "lokal", CLIENT_IP_MODE: " " }), { mode: CLIENT_IP_MODE_DEFAULT, onFly: true, reason: "default" }, "T9: blank CLIENT_IP_MODE → default");
    for (const m of ["legacy", "shadow", "enforce"] as const) {
      assertEq(r({ FLY_APP_NAME: "lokal", CLIENT_IP_MODE: m }), { mode: m, onFly: true, reason: "env" }, `T9: CLIENT_IP_MODE=${m} → ${m}`);
    }
    assertEq(r({ FLY_APP_NAME: "lokal", CLIENT_IP_MODE: " ENFORCE " }), { mode: "enforce", onFly: true, reason: "env" }, "T9: case and whitespace ignored");
    assertEq(errs.length, 0, "T9: no error logged for valid configs");
    for (const bad of ["enforec", "on", "true", "1"]) {
      assertEq(r({ FLY_APP_NAME: "lokal", CLIENT_IP_MODE: bad }), { mode: "legacy", onFly: true, reason: "invalid_env" }, `T9: CLIENT_IP_MODE=${bad} → legacy (a typo never enforces)`);
    }
    assertTrue(errs.length === 4 && errs.every((l) => JSON.parse(l).evt === "client_ip_invalid_mode"), "T9: each invalid value logs one client_ip_invalid_mode error");
  }

  // ── T10: no collapse ──
  {
    const s = await startProbe(ENFORCE);
    try {
      const sameTail = flyXff("203.0.113.200");
      const withFci = new Set<string>();
      let limited = 0;
      for (let i = 1; i <= 100; i++) {
        const r = await get(s.port, "/api/probe", { "Fly-Client-IP": `198.51.100.${i}`, "X-Forwarded-For": sameTail });
        withFci.add(String(r.json.ip));
        if (r.status === 429) limited++;
      }
      assertEq(withFci.size, 100, "T10: 100 distinct Fly-Client-IP with one identical XFF tail → 100 distinct req.ip");
      const without = new Set<string>();
      let eachIsXff0 = true;
      for (let i = 1; i <= 100; i++) {
        const r = await get(s.port, "/api/probe", { "X-Forwarded-For": flyXff(`203.0.113.${i}`) });
        without.add(String(r.json.ip));
        if (r.json.ip !== `203.0.113.${i}`) eachIsXff0 = false;
        if (r.status === 429) limited++;
      }
      assertEq(without.size, 100, "T10: 100 requests without Fly-Client-IP, distinct XFF[0] → 100 distinct req.ip");
      assertTrue(eachIsXff0, "T10: … each one its own XFF[0], as today");
      assertEq(limited, 0, "T10: none of the 200 is rate-limited (no shared bucket; the limit is 50 per client)");
      assertEq(s.mw.snapshot().breaker_trips_total, 0, "T10: the breaker never tripped");
    } finally {
      await s.close();
    }
  }

  // ── T11: collapse breaker (G4) ──
  {
    function rig(cfg: ClientIpConfig = ENFORCE) {
      let clock = T0;
      const errors: string[] = [];
      const mw = createClientIpMiddleware(cfg, { now: () => clock, log: () => {}, logError: (l) => errors.push(l) });
      /** One request; true when the middleware applied Fly-Client-IP (enforce took effect). */
      const send = (fci: string, xff: string, at?: number): boolean => {
        if (at !== undefined) clock = at;
        const req = fakeReq({ fci, xff, ip: xff.split(",")[0].trim() });
        mw(req, {} as any, () => {});
        return req.headers["x-forwarded-for"] === fci && xff !== fci;
      };
      const collapse = (count: number, at: number, edges = 20, fcis = ["198.51.100.7"]): boolean[] => {
        const out: boolean[] = [];
        for (let i = 0; i < count; i++) out.push(send(fcis[i % fcis.length], flyXff(`203.0.113.${1 + (i % edges)}`), at));
        return out;
      };
      return { mw, errors, send, collapse };
    }

    // (a) 80 collapse-shaped requests (constant Fly-Client-IP, 20 distinct edge entries) → open.
    {
      const r = rig();
      const first80 = r.collapse(80, T0);
      assertTrue(first80.every((e) => e), "T11a: before the breaker evaluates, the 80 requests are enforced");
      const at10s = r.send("198.51.100.7", flyXff("203.0.113.1"), T0 + 10_000);
      const next = r.send("198.51.100.8", flyXff("198.51.100.8", "192.0.2.9"), T0 + 10_001);
      assertEq([at10s, next], [false, false], "T11a: the evaluating request and the next one go legacy (breaker open)");
      assertEq(r.errors.length, 1, "T11a: exactly one breaker event logged");
      assertEq(JSON.parse(r.errors[0] ?? "{}"), { evt: "client_ip_breaker_open", mode: "enforce", N: 81, D_fci: 1, D_edge: 20, open_s: 900 }, "T11a: event carries N/D_fci/D_edge");
      const snap = r.mw.snapshot();
      assertEq([snap.would_trip, snap.breaker_open, snap.breaker_trips_total], [1, true, 1], "T11a: stats show the trip and the open breaker");
    }
    // (b) 500 requests from one client (flood: constant everything) → stays closed.
    {
      const r = rig();
      let all = true;
      for (let i = 0; i < 500; i++) if (!r.send("198.51.100.7", flyXff("198.51.100.7"), T0 + i * 1000)) all = false;
      assertTrue(all, "T11b: 500 requests, all constant over 500 s → every one enforced");
      assertEq(r.errors.length, 0, "T11b: no breaker event");
    }
    // (c) 30 collapse-shaped → below N, closed.
    {
      const r = rig();
      r.collapse(30, T0);
      assertTrue(r.send("198.51.100.7", flyXff("203.0.113.1"), T0 + 10_000), "T11c: 30 (+1) collapse-shaped requests (N < 60) → still enforced");
      assertEq(r.errors.length, 0, "T11c: no breaker event");
    }
    // (d) open + 15 min → enforce again.
    {
      const r = rig();
      r.collapse(80, T0);
      const tTrip = T0 + 10_000;
      r.send("198.51.100.7", flyXff("203.0.113.1"), tTrip);
      assertEq(r.send("198.51.100.9", flyXff("198.51.100.9"), tTrip + BREAKER_OPEN_MS - 1), false, "T11d: still legacy 1 ms before 15 min");
      assertEq(r.send("198.51.100.9", flyXff("198.51.100.9"), tTrip + BREAKER_OPEN_MS), true, "T11d: enforced again at 15 min");
      assertEq(r.mw.snapshot().breaker_trips_total, 1, "T11d: no second trip without new collapse traffic");
    }
    // (d2) a collapse that persists through the open period re-trips at once.
    {
      const r = rig();
      r.collapse(80, T0);
      const tTrip = T0 + 10_000;
      r.send("198.51.100.7", flyXff("203.0.113.1"), tTrip);
      r.collapse(80, tTrip + 11 * MIN);
      assertEq(r.send("198.51.100.7", flyXff("203.0.113.2"), tTrip + BREAKER_OPEN_MS), false, "T11d2: collapse still present at 15 min → re-trips on the first evaluation");
      assertEq(r.mw.snapshot().breaker_trips_total, 2, "T11d2: second trip counted");
    }
    // (e) 200 requests rotating XFF[0] (spoofing), constant Fly-Client-IP and edge → closed.
    {
      const r = rig();
      let all = true;
      for (let i = 0; i < 200; i++) {
        if (!r.send("198.51.100.7", flyXff("198.51.100.7", `203.0.113.${i % 250}`, `192.0.2.${i % 250}`), T0 + i * 100)) all = false;
      }
      assertTrue(all, "T11e: 200 spoofed requests (rotating XFF[0], constant Fly-Client-IP + edge) → every one enforced (edge is XFF[len-2], not XFF[0])");
      assertEq(r.errors.length, 0, "T11e: no breaker event");
    }
    // Exact thresholds: N ≥ 60, D_fci ≤ 2, D_edge ≥ 10.
    {
      const r = rig();
      r.collapse(59, T0, 10, ["198.51.100.7", "198.51.100.8"]);
      assertEq(r.send("198.51.100.7", flyXff("203.0.113.1"), T0 + 10_000), false, "T11f: N=60, D_fci=2, D_edge=10 → trips (all three bounds inclusive)");
    }
    {
      const r = rig();
      r.collapse(58, T0, 10, ["198.51.100.7", "198.51.100.8"]);
      assertEq(r.send("198.51.100.7", flyXff("203.0.113.1"), T0 + 10_000), true, "T11g: N=59 → closed");
    }
    {
      const r = rig();
      r.collapse(59, T0, 10, ["198.51.100.7", "198.51.100.8", "198.51.100.9"]);
      assertEq(r.send("198.51.100.7", flyXff("203.0.113.1"), T0 + 10_000), true, "T11h: D_fci=3 → closed");
    }
    {
      const r = rig();
      r.collapse(59, T0, 9, ["198.51.100.7", "198.51.100.8"]);
      assertEq(r.send("198.51.100.7", flyXff("203.0.113.1"), T0 + 10_000), true, "T11i: D_edge=9 → closed");
    }
    // Ring: data older than 5 min is gone; evaluation at most every 10 s.
    {
      const r = rig();
      r.collapse(80, T0);
      assertEq(r.send("198.51.100.7", flyXff("203.0.113.1"), T0 + 6 * MIN), true, "T11j: collapse traffic older than the 5×60 s ring no longer counts");
    }
    {
      const r = rig();
      r.collapse(80, T0);
      assertEq(r.send("198.51.100.7", flyXff("203.0.113.1"), T0 + 9_999), true, "T11k: no re-evaluation within 10 s of the last one");
      assertEq(r.send("198.51.100.7", flyXff("203.0.113.1"), T0 + 10_000), false, "T11k: evaluated (and tripped) at 10 s");
    }
    // Ring size at its exact bound (review of PR #1102, S3): 5 one-minute
    // buckets, so a 4- or 6-bucket ring fails one of these two.
    {
      const r = rig();
      r.collapse(80, T0);
      assertEq(r.send("198.51.100.7", flyXff("203.0.113.1"), T0 + 5 * MIN - 1), false, "T11n: collapse traffic 4 min 59.999 s old is still in the ring → trips");
    }
    {
      const r = rig();
      r.collapse(80, T0);
      assertEq(r.send("198.51.100.7", flyXff("203.0.113.1"), T0 + 5 * MIN), true, "T11n: at exactly 5 min it has left the 5-bucket ring → closed");
    }
    // Only requests that went via Fly-Client-IP count: a collapse onto Fly's
    // own internal address is already a fallback (G2) and never enforced.
    {
      const r = rig();
      const out = r.collapse(80, T0, 20, ["172.16.0.9"]);
      out.push(r.send("172.16.0.9", flyXff("203.0.113.1"), T0 + 10_000));
      assertTrue(out.every((e) => !e), "T11l: non-public Fly-Client-IP is never applied");
      assertEq(r.errors.length, 0, "T11l: … and never counts towards the breaker");
    }
    // Shadow: the same state machine, counted and logged, no effect.
    {
      const r = rig(SHADOW);
      const out = r.collapse(80, T0);
      out.push(r.send("198.51.100.7", flyXff("203.0.113.1"), T0 + 10_000));
      assertTrue(out.every((e) => !e), "T11m: shadow never applies Fly-Client-IP");
      assertEq(r.errors.map((l) => JSON.parse(l).evt), ["client_ip_breaker_would_open"], "T11m: shadow logs a would-open event (not client_ip_breaker_open)");
      assertEq(r.mw.snapshot().would_trip, 1, "T11m: shadow counts would_trip");
    }
  }

  // ── T12: never throws, next() exactly once ──
  {
    for (const cfg of [SHADOW, ENFORCE]) {
      const mw = createClientIpMiddleware(cfg, { now: () => T0, log: () => {}, logError: () => {} });
      const throwingIp: any = { headers: { "fly-client-ip": "203.0.113.5", "x-forwarded-for": flyXff("203.0.113.5") }, path: "/" };
      Object.defineProperty(throwingIp, "ip", { get() { throw new Error("boom"); } });
      const throwingHeaders: any = {};
      Object.defineProperty(throwingHeaders, "headers", { get() { throw new Error("boom"); } });
      const cases: Array<[string, any]> = [
        ["no headers", {}],
        ["headers undefined", { headers: undefined }],
        ["headers null", { headers: null }],
        ["Fly-Client-IP a number", { headers: { "fly-client-ip": 123 } }],
        ["Fly-Client-IP an array", { headers: { "fly-client-ip": ["203.0.113.5"] } }],
        ["Fly-Client-IP an object", { headers: { "fly-client-ip": { a: 1 } } }],
        ["X-Forwarded-For a number", { headers: { "fly-client-ip": "203.0.113.5", "x-forwarded-for": 42 } }],
        ["X-Forwarded-For an array", { headers: { "fly-client-ip": "203.0.113.5", "x-forwarded-for": ["192.0.2.1", "203.0.113.5"] } }],
        ["User-Agent an object", { headers: { "fly-client-ip": "203.0.113.5", "user-agent": { a: 1 } } }],
        ["req.ip getter throws", throwingIp],
        ["req.headers getter throws", throwingHeaders],
      ];
      const bad: string[] = [];
      for (const [label, req] of cases) {
        let calls = 0;
        let threw = false;
        try { mw(req, {} as any, () => { calls++; }); } catch { threw = true; }
        if (threw || calls !== 1) bad.push(`${label}: threw=${threw} next=${calls}`);
      }
      assertTrue(
        bad.length === 0,
        `T12: ${cfg.mode} — ${cases.length} malformed requests: never throws, next() exactly once each${bad.length ? ` (${bad.join("; ")})` : ""}`
      );
      assertEq(throwingIp.headers["x-forwarded-for"], flyXff("203.0.113.5"), `T12: ${cfg.mode} — an internal error leaves the request as today (header untouched)`);
      assertTrue(mw.snapshot().errors >= 2, `T12: ${cfg.mode} — internal errors are counted`);

      const clockThrows = createClientIpMiddleware(cfg, { now: () => { throw new Error("clock"); }, log: () => {}, logError: () => {} });
      let calls = 0;
      let threw = false;
      try { clockThrows(fakeReq({ fci: "203.0.113.5", xff: flyXff("203.0.113.5") }), {} as any, () => { calls++; }); } catch { threw = true; }
      assertEq([threw, calls], [false, 1], `T12: ${cfg.mode} — a throwing clock is caught, next() once`);

      // A throwing downstream handler is not ours to swallow, and must not cause a second next().
      calls = 0;
      let propagated = "";
      try {
        mw(fakeReq({ fci: "203.0.113.5", xff: flyXff("203.0.113.5") }), {} as any, () => { calls++; throw new Error("downstream"); });
      } catch (e: any) { propagated = String(e?.message); }
      assertEq([calls, propagated], [1, "downstream"], `T12: ${cfg.mode} — downstream error propagates, next() still called exactly once`);
    }
  }

  // ── T13: src/index.ts wiring ──
  {
    const idxSrc: string = fs.readFileSync(path.join(__dirname, "..", "index.ts"), "utf8");
    const installs = idxSrc.match(/installClientIp\(app\b/g) ?? [];
    assertEq(installs.length, 1, "T13: index.ts calls installClientIp(app …) exactly once");
    assertTrue(/installClientIp\(app,\s*resolveClientIpConfig\(process\.env\)\)/.test(idxSrc), "T13: … with resolveClientIpConfig(process.env)");
    const at = idxSrc.indexOf("installClientIp(app");
    const firstAppCall = idxSrc.search(/\bapp\.(?:use|get|post|put|patch|delete|all|set|enable)\(/);
    assertTrue(at >= 0 && firstAppCall > at, "T13: installClientIp comes before every other app.use/get/post/…/set call in index.ts");
    for (const [label, needle] of [
      ["requestTrackerMiddleware", "app.use(requestTrackerMiddleware"],
      ["the www redirect", "www.rettfrabonden.com"],
      ["consumerIdentity", "app.use(consumerIdentity"],
      ["the agentplatform host gate", "app.use(createAgentplatformHostGate"],
      ["analytics (IP hashing)", "app.use(analyticsService.middleware"],
      ["the dental host gate", "DENTAL_HOSTS.has("],
      ["the opplevagent host gate", "EXPERIENCES_HOSTS.has("],
    ] as const) {
      const pos = idxSrc.indexOf(needle);
      assertTrue(pos > at, `T13: installClientIp is mounted before ${label}`);
    }
    // Every app.<method>(…) statement that names a *Limiter.
    const limiterMounts: number[] = [];
    for (const m of idxSrc.matchAll(/\bapp\.(?:use|get|post|put|patch|delete|all)\(/g)) {
      const end = idxSrc.indexOf(";", m.index!);
      if (/\b\w+Limiter\b/.test(idxSrc.slice(m.index!, end < 0 ? undefined : end))) limiterMounts.push(m.index!);
    }
    assertTrue(limiterMounts.length >= 15, `T13: found the limiter mounts in index.ts (${limiterMounts.length})`);
    assertTrue(limiterMounts.every((p) => p > at), "T13: installClientIp is mounted before every limiter mount");
    assertTrue(!/\.(?:set|enable|disable)\(\s*["']trust proxy/.test(idxSrc), "T13: index.ts no longer sets `trust proxy` itself");

    const offenders = srcFiles()
      .filter((f) => path.basename(f) !== "client-ip.ts")
      .filter((f) => /\.(?:set|enable|disable)\(\s*["']trust proxy/.test(fs.readFileSync(f, "utf8")))
      .map((f) => path.relative(path.join(__dirname, ".."), f));
    assertEq(offenders, [], "T13: no other non-test file in src/ sets `trust proxy`");
  }

  // ── T14: one reader of X-Forwarded-For / Fly-Client-IP ──
  {
    const src = srcFiles().filter((f) => path.basename(f) !== "client-ip.ts");
    const readers = (re: RegExp) =>
      src.filter((f) => re.test(fs.readFileSync(f, "utf8"))).map((f) => path.relative(path.join(__dirname, ".."), f));
    assertEq(readers(/["']x-forwarded-for["']/i), [], "T14: no non-test file in src/ outside client-ip.ts names the X-Forwarded-For header");
    assertEq(readers(/["']fly-client-ip["']/i), [], "T14: no non-test file in src/ outside client-ip.ts names the Fly-Client-IP header");
    const contactSrc = fs.readFileSync(path.join(__dirname, "..", "routes", "contact.ts"), "utf8");
    assertTrue(/function clientIp\(req: Request\): string \{\s*return req\.ip \|\| "unknown";\s*\}/.test(contactSrc), "T14: contact.ts clientIp() is req.ip || \"unknown\"");
  }

  // ── T15: trust proxy stays true ──
  for (const cfg of [LEGACY, SHADOW, ENFORCE]) {
    const app = express();
    installClientIp(app, cfg, { log: () => {}, logError: () => {}, store: null });
    assertTrue(app.get("trust proxy") === true, `T15: ${cfg.mode} — app.get("trust proxy") === true after installClientIp`);
  }

  // ── Stats line: counters, 5-min cadence, 15-min top list (AC2 instrument) ──
  {
    let clock = T0;
    const lines: string[] = [];
    const mw = createClientIpMiddleware(SHADOW, { now: () => clock, log: (l) => lines.push(l), logError: () => {} });
    const send = (o: Parameters<typeof fakeReq>[0]) => mw(fakeReq(o), {} as any, () => {});
    // Ordinary client: Fly appended client + app IP only.
    for (let i = 0; i < 3; i++) send({ fci: "198.51.100.1", xff: flyXff("198.51.100.1"), ip: "198.51.100.1", path: "/api/products", ua: CHATGPT_UA });
    // The same client spoofing two different values → fanIn 3 behind one key.
    send({ fci: "198.51.100.1", xff: flyXff("198.51.100.1", "203.0.113.9"), ip: "203.0.113.9", path: "/a2a", ua: CHATGPT_UA });
    send({ fci: "198.51.100.1", xff: flyXff("198.51.100.1", "203.0.113.10"), ip: "203.0.113.10", path: "/mcp", ua: CHATGPT_UA });
    // Disagreement: Fly-Client-IP ≠ Fly's own XFF entry.
    send({ fci: "198.51.100.2", xff: flyXff("198.51.100.99"), ip: "198.51.100.99", path: "/" });
    // Fallbacks.
    send({ xff: flyXff("198.51.100.3"), ip: "198.51.100.3" });
    send({ fci: "garbage", xff: flyXff("198.51.100.4"), ip: "198.51.100.4" });
    send({ fci: "10.1.2.3", xff: flyXff("198.51.100.5"), ip: "198.51.100.5" });
    assertEq(lines.length, 0, "stats: nothing logged inside the 5-min window");
    const s = mw.snapshot();
    assertEq(
      [s.n, s.fci_valid, s.fallback, s.xff_client_supplied, s.agree_fci_edge, s.agree_legacy_eq_fci, s.D_fci, s.D_edge, s.D_legacy],
      [9, 6, { missing: 1, invalid: 1, non_public: 1 }, 2, { n: 6, agree: 5 }, { n: 4, agree: 3 }, 2, 2, 4],
      "stats: n / fci_valid / fallback / xff_client_supplied / agreement / distinct counts"
    );
    assertEq(
      s.top15m.map((t) => [t.n, t.api, t.a2a, t.mcp, t.other, t.fanIn, t.ua]),
      [[5, 3, 1, 1, 0, 3, "ai_search:chatgpt"], [1, 0, 0, 0, 1, 1, "none"]],
      "stats: top list per Fly-Client-IP with path split, fanIn and UA family"
    );
    assertTrue(s.top15m.every((t) => /^[0-9a-f]{12}$/.test(t.key)), "stats: top keys are 12-hex hashes");

    clock = T0 + 5 * MIN; // first request of the next window flushes the previous one
    send({ fci: "198.51.100.1", xff: flyXff("198.51.100.1"), ip: "198.51.100.1" });
    assertEq(lines.length, 1, "stats: exactly one line when the 5-min window closes");
    const l0 = JSON.parse(lines[0] ?? "{}");
    assertEq([l0.evt, l0.mode, l0.window_start, l0.window_s, l0.n], ["client_ip_stats", "shadow", new Date(T0).toISOString(), 300, 9], "stats: the line describes the closed window");
    const keyA = l0.top15m?.[0]?.key;
    assertEq(mw.snapshot().n, 1, "stats: the new window starts from the flushing request");

    clock = T0 + 10 * MIN;
    send({ fci: "198.51.100.1", xff: flyXff("198.51.100.1"), ip: "198.51.100.1" });
    clock = T0 + 15 * MIN;
    send({ fci: "198.51.100.6", xff: flyXff("198.51.100.6"), ip: "198.51.100.6" });
    const l2 = JSON.parse(lines[2] ?? "{}");
    assertEq([lines.length, l2.top15m?.[0]?.key, l2.top15m?.[0]?.n], [3, keyA, 7], "stats: top15m sums the last three windows (5 + 1 + 1), same hashed key within the process");
    clock = T0 + 20 * MIN;
    send({ fci: "198.51.100.6", xff: flyXff("198.51.100.6"), ip: "198.51.100.6" });
    const l3 = JSON.parse(lines[3] ?? "{}");
    const a3 = (l3.top15m ?? []).find((t: any) => t.key === keyA);
    assertEq(a3?.n, 2, "stats: a window older than 15 min drops out of top15m");
    clock = T0 + 40 * MIN;
    send({ fci: "198.51.100.6", xff: flyXff("198.51.100.6"), ip: "198.51.100.6" });
    assertEq(lines.length, 5, "stats: windows without traffic produce no line");
  }

  // ── T4e (trinn 1e): non_public_by — which range, route and UA class the non_public fallbacks came from ──
  {
    assertEq(
      NON_PUBLIC_RANGE_CODES,
      ["v4_10", "v4_172_16", "v4_192_168", "v4_cgnat", "v4_loopback", "v4_link_local", "v4_other", "v6_ula", "v6_reserved", "v6_link_local", "v6_multicast"],
      "T4e: the eleven range codes, each once, in the dev-request's order"
    );
    // One address per code; 172.16 written ::ffff:-mapped (normalized first), 6PN as fdaa::.
    const onePerCode: Array<[string, NonPublicRange]> = [
      ["10.20.30.40", "v4_10"], ["::ffff:172.16.9.9", "v4_172_16"], ["192.168.1.1", "v4_192_168"], ["100.100.1.1", "v4_cgnat"],
      ["127.0.0.2", "v4_loopback"], ["169.254.169.254", "v4_link_local"], ["224.0.0.251", "v4_other"], ["fdaa::1", "v6_ula"],
      ["::1", "v6_reserved"], ["fe80::abcd", "v6_link_local"], ["ff02::fb", "v6_multicast"],
    ];
    assertEq(
      [...new Set(onePerCode.map(([, c]) => c))].sort(),
      [...NON_PUBLIC_RANGE_CODES].sort(),
      "T4e: (setup) the probe covers every code"
    );
    for (const [ip, range] of onePerCode) {
      assertEq(deriveFlyClientIp({ "fly-client-ip": ip }), { ok: false, fallback: "non_public", range }, `T4e: ${ip} → ${range}`);
    }

    let clock = T0;
    const lines: string[] = [];
    const mw = createClientIpMiddleware(SHADOW, { now: () => clock, log: (l) => lines.push(l), logError: () => {} });
    const send = (o: Parameters<typeof fakeReq>[0]) => mw(fakeReq(o), {} as any, () => {});
    const routes = [["/api/products", "api"], ["/a2a", "a2a"], ["/mcp", "mcp"], ["/kategori/x", "other"]] as const;
    const range: Record<string, number> = Object.fromEntries(NON_PUBLIC_RANGE_CODES.map((c) => [c, 0]));
    const route: Record<string, number> = { api: 0, a2a: 0, mcp: 0, other: 0 };
    const ua: Record<string, number> = {};
    const expectNp = (code: NonPublicRange, r: (typeof routes)[number], chatgpt: boolean) => {
      range[code]++;
      route[r[1]]++;
      const u = chatgpt ? "ai_search:chatgpt" : "none";
      ua[u] = (ua[u] ?? 0) + 1;
    };
    // Code i gets i + 1 requests (a swapped code or a dropped increment shows), spread over routes and UAs.
    let k = 0;
    onePerCode.forEach(([ip, code], i) => {
      for (let j = 0; j <= i; j++, k++) {
        const r = routes[k % 4];
        const chatgpt = k % 3 === 0;
        send({ fci: ip, xff: flyXff("198.51.100.5"), ip: "198.51.100.5", path: r[0], ua: chatgpt ? CHATGPT_UA : undefined });
        expectNp(code, r, chatgpt);
      }
    });
    // Not non_public: counted nowhere in non_public_by.
    send({ fci: "198.51.100.1", xff: flyXff("198.51.100.1"), ip: "198.51.100.1", path: "/a2a" });
    send({ xff: flyXff("198.51.100.3"), ip: "198.51.100.3", path: "/mcp" });
    send({ fci: "garbage", xff: flyXff("198.51.100.4"), ip: "198.51.100.4", path: "/api/x" });
    const total = (o: Record<string, number> | undefined) => Object.values(o ?? {}).reduce((a, b) => a + b, 0);
    const splits = (c: any) => [c?.fallback?.non_public, total(c?.non_public_by?.range), total(c?.non_public_by?.route), total(c?.non_public_by?.ua)];
    const w0 = mw.snapshot();
    assertEq(w0.non_public_by, { range: { ...range }, route: { ...route }, ua: { ...ua } }, "T4e: the open window counts each non_public by its range, route and UA class");
    assertEq(splits(w0), [66, 66, 66, 66], "T4e: window — range, route and ua each sum to fallback.non_public (66)");
    assertEq(Object.keys(w0.non_public_by.range), [...NON_PUBLIC_RANGE_CODES], "T4e: range carries every code, zero or not, in order");

    // The next window logs this one; one more non_public in the new window.
    clock = T0 + 5 * MIN;
    send({ fci: "fdaa:0:2::3", xff: flyXff("198.51.100.5"), ip: "198.51.100.5", path: "/mcp", ua: CHATGPT_UA });
    const line0 = JSON.parse(lines[0] ?? "{}");
    assertEq(line0.non_public_by, w0.non_public_by, "T4e: the client_ip_stats line carries the window's non_public_by");
    assertEq(splits(line0), [66, 66, 66, 66], "T4e: log line — each split sums to fallback.non_public");
    expectNp("v6_ula", routes[2], true);
    const snap = mw.opsSnapshot();
    assertEq(snap.since_boot.non_public_by, { range, route, ua }, "T4e: since_boot sums the logged window and the open one");
    assertEq(splits(snap.since_boot), [67, 67, 67, 67], "T4e: since_boot — each split sums to fallback.non_public (67)");
    assertEq(splits(snap.window), [1, 1, 1, 1], "T4e: the new open window — each split sums to its own fallback.non_public");
    assertEq([snap.window?.non_public_by.range.v6_ula, snap.window?.non_public_by.route.mcp, snap.window?.non_public_by.ua["ai_search:chatgpt"]], [1, 1, 1], "T4e: … and counts the new one where it belongs");

    // Codes and counts only: no address, hash or host name.
    const outs = [line0.non_public_by, snap.since_boot.non_public_by, snap.window?.non_public_by];
    const keysOk = outs.every(
      (o) =>
        Object.keys(o).join() === "range,route,ua" &&
        Object.keys(o.range).every((c) => (NON_PUBLIC_RANGE_CODES as readonly string[]).includes(c)) &&
        Object.keys(o.route).every((c) => ["api", "a2a", "mcp", "other"].includes(c)) &&
        Object.keys(o.ua).every((c) => /^[a-z_]+(:[a-z_]+)?$/.test(c)) &&
        [...Object.values(o.range), ...Object.values(o.route), ...Object.values(o.ua)].every((n) => Number.isInteger(n) && (n as number) >= 0)
    );
    assertTrue(keysOk, "T4e: non_public_by holds only range codes, path classes and UA classes, with whole counts");
    const json = JSON.stringify(outs);
    const ipLike = /\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}|::|[0-9a-f]{1,4}:[0-9a-f]{1,4}|[0-9a-f]{12}|fdaa|fe80|ff02|\.com|\.no\b/i;
    assertTrue(!ipLike.test(json), `T4e: no IP-like string, hash or host name in non_public_by (${json.length} B)`);
  }

  // ── fallback_hc: the health-check share of the fallbacks (AC2 allowance) ──
  {
    const mw = createClientIpMiddleware(SHADOW, { now: () => T0, log: () => {}, logError: () => {} });
    const send = (o: Parameters<typeof fakeReq>[0]) => mw(fakeReq(o), {} as any, () => {});
    send({ path: "/.well-known/agent-card.json" }); // Fly's http_service check
    send({ path: "/health", ip: "127.0.0.1" }); // Dockerfile HEALTHCHECK via localhost
    send({ path: "/api/products", xff: flyXff("198.51.100.3") }); // missing, not a health check
    send({ path: "/health/x" }); // missing, not exactly a health-check path
    send({ path: "/health", fci: "garbage" }); // invalid, not missing
    send({ path: "/health", fci: "10.0.0.1" }); // non_public, not missing
    send({ path: "/.well-known/agent-card.json", fci: "198.51.100.4", xff: flyXff("198.51.100.4") }); // valid
    const s = mw.snapshot();
    assertEq(
      [s.n, s.fallback, s.fallback_hc],
      [7, { missing: 4, invalid: 1, non_public: 1 }, 2],
      "stats: fallback_hc counts only `missing` on /.well-known/agent-card.json and /health"
    );
  }

  // ── Stats keys: fixed size whatever the input, one key per limiter bucket ──
  {
    const key = createStatsKey(Buffer.alloc(16, 7));
    const pad = "x".repeat(14 * 1024);
    const slicedV4 = `203.100.113.255, ${pad}`.split(",")[0]; // an IPv4 sliced out of a 14 KB header
    const big = [pad, `${pad}1`, `${pad}2`, `198.51.100.7, ${pad}`];
    assertTrue(
      big.every((v) => /^[A-Za-z0-9_-]{16}$/.test(key(v))) && key(slicedV4).length <= 22,
      "stats keys: a 14 KB input gives a 16-char base64url key (≤ 22 chars), never the input"
    );
    assertEq(key(pad), key("x".repeat(14 * 1024)), "stats keys: deterministic within a process (same salt)");
    const inputs = [
      ...big,
      ...Array.from({ length: 1000 }, (_, i) => `198.51.${i >> 8}.${i & 255}`),
      "2001:db8:abcd:1200::1",
      "2001:db8:abcd:1300::1",
      "garbage-not-an-ip",
      "",
    ];
    assertEq(new Set(inputs.map(key)).size, inputs.length, `stats keys: ${inputs.length} distinct buckets (1000 IPv4, 4 × 14 KB, two IPv6 /56, garbage, empty) → as many distinct keys`);
    assertEq(
      [key("2001:db8:abcd:12ff::2") === key("2001:db8:abcd:1200::1"), key("::ffff:203.0.113.9") === key("203.0.113.9"), key(slicedV4) === key("203.100.113.255")],
      [true, true, true],
      "stats keys: one key per limiter bucket (same /56; ::ffff:-mapped; an IPv4 sliced out of a padded header)"
    );
    assertTrue(key("203.0.113.9") !== createStatsKey(Buffer.alloc(16, 8))("203.0.113.9"), "stats keys: another salt (another process) gives another key");

    // Through the middleware: padded client values still count as distinct buckets.
    const mw = createClientIpMiddleware(SHADOW, { now: () => T0, log: () => {}, logError: () => {} });
    for (let i = 0; i < 50; i++) {
      const junk = `${pad}${i}`;
      mw(fakeReq({ fci: "198.51.100.7", xff: flyXff("198.51.100.7", junk), ip: junk }), {} as any, () => {});
    }
    const s = mw.snapshot();
    assertEq(
      [s.n, s.D_fci, s.D_edge, s.D_legacy, s.top15m[0]?.fanIn],
      [50, 1, 1, 50, 8],
      "stats keys: 50 distinct 14 KB X-Forwarded-For[0] values → 50 legacy buckets behind one client (fanIn capped at 8)"
    );
  }

  // ── B1 pin (review of PR #1102, S1): only createStatsKey keys outlive the request ──
  {
    const pad = "x".repeat(14 * 1024);
    for (const cfg of [SHADOW, ENFORCE]) {
      let clock = T0 + 4 * MIN;
      const mw = createClientIpMiddleware(cfg, { now: () => clock, log: () => {}, logError: () => {} });
      // Legacy (XFF[0]) and edge (XFF[len-2]) both differ from Fly-Client-IP, so neither reuses fciKey.
      const send = (fci: string, legacy: string, edge: string) =>
        mw(fakeReq({ fci, xff: [legacy, edge, APP_IP].join(", "), ip: legacy }), {} as any, () => {});
      for (let i = 1; i <= 10; i++) {
        send(`198.51.100.${i}`, `${pad}L${i}`, `${pad}E${i}`);
        send(`198.51.100.${i}`, `203.0.113.${i}`, `192.0.2.${i}`);
      }
      // Next stats window (the first one moves to history) and next breaker bucket (the first one stays in the ring).
      clock = T0 + 5 * MIN;
      for (let i = 1; i <= 10; i++) {
        send(`2001:db8:${i}::1`, `${pad}L2${i}`, `${pad}E2${i}`);
        send(`2001:db8:${i}::1`, `2001:db8:${100 + i}::9`, `192.0.2.${100 + i}`);
      }
      // 170 = open window (D_fci 10 + D_edge 20 + D_legacy 20 + 10 top keys × (1 + 2 legacy))
      //     + history (10 top keys × 3) + breaker ring (2 buckets × (10 fci + 20 edge)).
      const keys = mw.__retainedKeysForTesting();
      const raw = keys.filter((k) => !/^[A-Za-z0-9_-]{16}$/.test(k));
      assertTrue(
        keys.length === 170 && raw.length === 0,
        `B1 pin: ${cfg.mode} — all ${keys.length} keys held by the windows, top lists, history and breaker ring are 16-char stats keys${raw.length ? ` (raw: ${raw.length}, e.g. ${raw[0].slice(0, 40)}…)` : ""}`
      );
    }
    // ipKeyGenerator is called in exactly one place — inside createStatsKey —
    // so no new set or map can be keyed by its raw (client-controlled) output.
    const code = fs
      .readFileSync(path.join(__dirname, "client-ip.ts"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    assertEq(
      [(code.match(/\bipKeyGenerator\(/g) ?? []).length, /\.update\(ipKeyGenerator\(ip\), "utf8"\)/.test(code)],
      [1, true],
      "B1 pin: client-ip.ts calls ipKeyGenerator( once, in createStatsKey's salted hash"
    );
  }

  // ── Caps (review of PR #1102, S2): DISTINCT_CAP = 4096 per distinct set, TOP_CAP = 1024 top keys per window ──
  {
    const mw = createClientIpMiddleware(SHADOW, { now: () => T0, log: () => {}, logError: () => {} });
    const ipAt = (i: number) => `198.51.${i >> 8}.${i & 255}`; // public IPv4, one limiter bucket each
    const send = (i: number) => mw(fakeReq({ fci: ipAt(i), xff: flyXff(ipAt(i)), ip: ipAt(i) }), {} as any, () => {});
    for (let i = 0; i < 1024; i++) send(i);
    assertEq(mw.snapshot().top_overflow, 0, "caps: 1024 distinct clients all get a top-list entry");
    send(1024);
    send(0); // an entry made before the cap keeps counting
    let s = mw.snapshot();
    assertEq(
      [s.top_overflow, s.top15m[0]?.n, s.top15m.length],
      [1, 2, 5],
      "caps: the 1025th distinct client overflows TOP_CAP, an existing entry still counts, top15m stays 5 long"
    );
    for (let i = 1025; i < 4096; i++) send(i);
    s = mw.snapshot();
    assertEq([s.D_fci, s.D_edge, s.D_legacy, s.distinct_capped], [4096, 4096, 4096, false], "caps: exactly 4096 distinct clients are all counted, not capped");
    send(4096);
    s = mw.snapshot();
    assertEq(
      [s.n, s.D_fci, s.D_edge, s.D_legacy, s.distinct_capped, s.top_overflow],
      [4098, 4096, 4096, 4096, true, 4097 - 1024],
      "caps: the 4097th distinct client is not added (D_* stay 4096) and sets distinct_capped; top_overflow counts every request without an entry"
    );
  }

  // ── T16: no raw IP in any logged line or snapshot ──
  {
    const ips = ["198.51.100.77", "203.0.113.88", "192.0.2.99", "2001:db8:beef:4200::7", "2001:db8:beef:4200::/56"];
    let clock = T0;
    const out: string[] = [];
    for (const cfg of [SHADOW, ENFORCE]) {
      const mw = createClientIpMiddleware(cfg, { now: () => clock, log: (l) => out.push(l), logError: (l) => out.push(l) });
      const send = (fci: string, xff: string) => mw(fakeReq({ fci, xff, ip: xff.split(",")[0].trim(), ua: CHATGPT_UA }), {} as any, () => {});
      clock = T0;
      for (let i = 0; i < 70; i++) send("198.51.100.77", flyXff(`203.0.113.${i % 20}`, "192.0.2.99"));
      send("2001:db8:beef:4200::7", flyXff("2001:db8:beef:4200::7", "203.0.113.88"));
      clock = T0 + 10_000; // breaker evaluates → event line
      send("198.51.100.77", flyXff("203.0.113.88"));
      out.push(JSON.stringify(mw.snapshot()));
      clock = T0 + 5 * MIN; // flush → stats line
      send("198.51.100.77", flyXff("198.51.100.77"));
    }
    assertTrue(out.some((l) => l.includes("client_ip_breaker")) && out.some((l) => l.includes("client_ip_stats")), "T16: the probe produced breaker, stats and snapshot output");
    const leaks = ips.filter((ip) => out.some((l) => l.includes(ip)));
    assertEq(leaks, [], "T16: no test IP (or its ipKeyGenerator form) appears in any logged line or snapshot");
  }

  // ── AC2 read-out (trinn 1b): getInstalledClientIpSnapshot → `clientIp` in GET /admin/analytics/ops/event-loop ──
  {
    // The stats line's additive counters, under their logged names.
    const COUNTERS = ["n", "fci_valid", "fallback", "fallback_hc", "non_public_by", "errors", "xff_client_supplied", "agree_fci_edge", "agree_legacy_eq_fci", "would_trip", "top_overflow"];
    const pick = (o: any) => Object.fromEntries(COUNTERS.map((k) => [k, o?.[k]]));
    // Field by field over the union of keys (non_public_by.ua holds only the classes seen; absent = 0).
    const sum = (a: any, b: any): any =>
      typeof a === "number" || typeof b === "number"
        ? (a ?? 0) + (b ?? 0)
        : Object.fromEntries([...new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})])].map((k) => [k, sum(a?.[k], b?.[k])]));
    const leaves = (o: any): number[] => (typeof o === "number" ? [o] : Object.values(o ?? {}).flatMap(leaves));
    const iso = (t: number) => new Date(t).toISOString();
    // store: null — installClientIp's default store (on Fly) is the main DB; these tests run without one.
    const quiet = { log: () => {}, logError: () => {}, store: null };
    const snapshot = () => getInstalledClientIpSnapshot() as ClientIpOpsSnapshot;

    __resetInstalledClientIpForTesting();
    assertEq(getInstalledClientIpSnapshot(), null, "AC2 read-out: null while installClientIp has not run");

    // Legacy is installed too, so off Fly, a rollback and a typo show as mode/reason, with nothing counted.
    const legacies: Array<[string, ClientIpConfig]> = [
      ["off Fly", LEGACY],
      ["rollback CLIENT_IP_MODE=legacy", resolveClientIpConfig({ FLY_APP_NAME: "lokal", CLIENT_IP_MODE: "legacy" }, () => {})],
      ["typo in CLIENT_IP_MODE", resolveClientIpConfig({ FLY_APP_NAME: "lokal", CLIENT_IP_MODE: "enforec" }, () => {})],
    ];
    for (const [label, cfg] of legacies) {
      const mw = installClientIp(express(), cfg, { now: () => T0, ...quiet });
      mw(fakeReq({ fci: "198.51.100.1", xff: flyXff("198.51.100.1"), ip: "198.51.100.1" }), {} as any, () => {});
      const snap = snapshot();
      assertEq(
        [snap?.mode, snap?.on_fly, snap?.reason, snap?.since, snap?.breaker, snap?.window, Object.keys(snap?.since_boot ?? {}), leaves(snap?.since_boot).every((v) => v === 0)],
        ["legacy", cfg.onFly, cfg.reason, null, { open: false, open_until: null, trips_total: 0 }, null, COUNTERS, true],
        `AC2 read-out: legacy (${label}) → mode/reason shown, all counters 0, no window`
      );
    }

    // Shadow: since_boot sums every counter of every window since the first one.
    {
      let clock = T0;
      const lines: string[] = [];
      const mw = installClientIp(express(), SHADOW, { now: () => clock, log: (l) => lines.push(l), logError: () => {}, store: null });
      lines.length = 0; // the boot line
      const send = (o: Parameters<typeof fakeReq>[0]) => mw(fakeReq(o), {} as any, () => {});
      const sendXff = (fci: string, xff: string) => send({ fci, xff, ip: xff.split(",")[0].trim() });
      // Window A (T0): every counter gets a non-zero value.
      for (let i = 0; i < 80; i++) sendXff("198.51.100.7", flyXff(`203.0.113.${1 + (i % 20)}`)); // collapse shape
      clock = T0 + 10_000;
      sendXff("198.51.100.7", flyXff("203.0.113.1")); // the breaker evaluates → would_trip
      for (let i = 0; i < 3; i++) sendXff("198.51.100.1", flyXff("198.51.100.1"));
      sendXff("198.51.100.1", flyXff("198.51.100.1", "203.0.113.9")); // client-sent XFF
      sendXff("198.51.100.2", flyXff("198.51.100.99")); // Fly-Client-IP ≠ Fly's own XFF entry
      send({ path: "/health" }); // missing, health check
      send({ xff: flyXff("198.51.100.3"), ip: "198.51.100.3" }); // missing
      send({ fci: "garbage", xff: flyXff("198.51.100.4"), ip: "198.51.100.4" }); // invalid
      send({ fci: "10.1.2.3", xff: flyXff("198.51.100.5"), ip: "198.51.100.5" }); // non_public
      const throwingIp: any = fakeReq({ fci: "198.51.100.6", xff: flyXff("198.51.100.6") });
      Object.defineProperty(throwingIp, "ip", { get() { throw new Error("boom"); } });
      mw(throwingIp, {} as any, () => {}); // errors
      for (let i = 0; i < 1030; i++) sendXff(`198.51.${10 + (i >> 8)}.${i & 255}`, flyXff(`198.51.${10 + (i >> 8)}.${i & 255}`)); // past TOP_CAP
      // Window B (T0 + 5 min): its first request logs A.
      clock = T0 + 5 * MIN;
      sendXff("198.51.100.1", flyXff("198.51.100.1"));
      send({ path: "/.well-known/agent-card.json" });
      const lineA = JSON.parse(lines[0] ?? "{}");
      const b = snapshot();
      // non_public_by splits the one non_public over its keys: the others stay 0 (pinned in T4e).
      assertTrue(lines.length === 1 && leaves({ ...pick(lineA), non_public_by: undefined }).every((v) => v > 0), "AC2 read-out: (setup) window A is logged with every counter non-zero");
      assertEq(Object.keys(b?.since_boot ?? {}), COUNTERS, "AC2 read-out: since_boot holds exactly the stats line's additive counters, under the logged names");
      assertEq(b?.since_boot, sum(pick(lineA), pick(b?.window)), "AC2 read-out: since_boot = logged window A + open window B, field by field");
      assertEq(
        [b?.mode, b?.on_fly, b?.reason, b?.since, b?.window?.window_start, b?.window?.n],
        ["shadow", true, "default", iso(T0), iso(T0 + 5 * MIN), 2],
        "AC2 read-out: mode/reason, since = the first window's start, window = the open one"
      );
      assertEq(b?.window, mw.snapshot(), "AC2 read-out: window is the open window exactly as the next client_ip_stats line is built from it");
      assertEq(b?.breaker, { open: true, open_until: iso(T0 + 10_000 + BREAKER_OPEN_MS), trips_total: 1 }, "AC2 read-out: shadow — the simulated breaker, open until trip + 15 min");
      // Window C (T0 + 10 min): A and B both folded in.
      clock = T0 + 10 * MIN;
      sendXff("198.51.100.8", flyXff("198.51.100.8", "192.0.2.8"));
      const lineB = JSON.parse(lines[1] ?? "{}");
      const c = snapshot();
      assertEq(c?.since_boot, sum(sum(pick(lineA), pick(lineB)), pick(c?.window)), "AC2 read-out: since_boot keeps summing every closed window (A + B + open C)");
      assertEq([c?.since, c?.since_boot.would_trip, c?.breaker.trips_total], [iso(T0), 1, 1], "AC2 read-out: since stays at the first window; would_trip since boot = trips_total");
      const json = JSON.stringify(c);
      assertTrue(!/198\.51\.|203\.0\.113\.|192\.0\.2\.|10\.1\.2\.3/.test(json), "AC2 read-out: no raw IP anywhere in the snapshot");
      assertTrue(
        c?.window?.top15m.length === 5 && c.window.top15m.every((t) => /^[0-9a-f]{12}$/.test(t.key)) && c.since_boot.top_overflow > 0,
        "AC2 read-out: the top list is the bounded top-5 of 12-hex keys, with top_overflow"
      );
      assertTrue(json.length < 4096, `AC2 read-out: bounded size after 1100+ distinct clients (${json.length} B)`);
      // No request since: the breaker state is as of now, not as of the last request.
      clock = T0 + 10_000 + BREAKER_OPEN_MS;
      const d = snapshot();
      assertEq(
        [d?.breaker, d?.window?.breaker_open, d?.since_boot.n],
        [{ open: false, open_until: null, trips_total: 1 }, false, c?.since_boot.n],
        "AC2 read-out: 15 min after the trip the breaker reads closed again without a request; nothing recounted"
      );
    }

    // Enforce, over real HTTP: the accessor reads the instance installClientIp mounted (the last one).
    {
      const s = await startProbe(ENFORCE);
      try {
        for (let i = 0; i < 3; i++) {
          await get(s.port, "/api/probe", { "Fly-Client-IP": "198.51.100.7", "X-Forwarded-For": flyXff("198.51.100.7", `203.0.113.${i}`) });
        }
        const snap = snapshot();
        assertEq(
          [snap?.mode, snap?.reason, snap?.since_boot.n, snap?.since_boot.xff_client_supplied, snap?.window?.D_fci, snap?.window?.D_legacy],
          ["enforce", "env", 3, 3, 1, 3],
          "AC2 read-out: over real HTTP, counts what the installed middleware saw"
        );
        assertEq(snap, s.mw.opsSnapshot(), "AC2 read-out: … and is that instance's own opsSnapshot");
      } finally {
        await s.close();
      }
    }

    // The route: the existing handler gains exactly the clientIp field.
    {
      const analytics = require("../routes/analytics");
      const router: any = analytics.default || analytics;
      const stack: any[] = router.stack || [];
      const layer = stack.find((l) => l.route && l.route.path === "/ops/event-loop" && l.route.methods.get);
      assertTrue(!!layer, "AC2 route: GET /ops/event-loop is on the analytics router");
      const call = (): { code: number; body: any } => {
        let body: any = null;
        let code = 200;
        const res: any = { json(b: any) { body = b; return this; }, status(c: number) { code = c; return this; } };
        layer.route.stack[0].handle({ query: {} }, res, () => {});
        return { code, body };
      };
      if (layer) {
        installClientIp(express(), SHADOW, { now: () => T0, ...quiet })(
          fakeReq({ fci: "198.51.100.7", xff: flyXff("198.51.100.7", "203.0.113.5"), ip: "203.0.113.5" }), {} as any, () => {}
        );
        const ok = call();
        assertEq([ok.code, ok.body?.clientIp], [200, getInstalledClientIpSnapshot()], "AC2 route: the response carries the installed snapshot as clientIp");
        assertTrue(
          ["timestamp", "summary", "stalls", "offThreadStats"].every((k) => k in (ok.body ?? {})) && !("persisted" in (ok.body ?? {})),
          "AC2 route: the existing fields are all still there (no since_hours → no persisted)"
        );
        // A snapshot that fails (here: its clock throws) must not take the rest of the response down.
        installClientIp(express(), SHADOW, { now: () => { throw new Error("clock"); }, ...quiet });
        assertEq(getInstalledClientIpSnapshot(), { error: "snapshot_failed" }, "AC2 read-out: a failing snapshot gives { error }, never a throw");
        const failing = call();
        assertEq(
          [failing.code, failing.body?.clientIp, typeof failing.body?.summary],
          [200, { error: "snapshot_failed" }, "object"],
          "AC2 route: a failing snapshot still gives 200 with the event-loop report"
        );
        __resetInstalledClientIpForTesting();
        const none = call();
        assertTrue(none.code === 200 && "clientIp" in (none.body ?? {}) && none.body.clientIp === null, "AC2 route: clientIp is null when the middleware is not installed");
      }
      assertEq(
        stack.filter((l) => l.route && /client-?ip/i.test(String(l.route.path))).map((l) => l.route.path),
        [],
        "AC2 route: no client-ip route of its own (the read-out rides the existing handler, no new auth lines)"
      );
    }
    __resetInstalledClientIpForTesting();
  }

  return { passed, failed, failures };
}

/** Every non-test .ts file under src/. */
function srcFiles(): string[] {
  const root = path.join(__dirname, "..");
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name !== "node_modules") walk(p);
      } else if (e.name.endsWith(".ts") && !e.name.endsWith(".test.ts") && !e.name.endsWith(".d.ts")) {
        out.push(p);
      }
    }
  };
  walk(root);
  return out;
}

if (require.main === module) {
  runClientIpTests({ log: true }).then((r) => {
    console.log(`\nclient-ip: ${r.passed} passed, ${r.failed} failed`);
    process.exit(r.failed > 0 ? 1 : 0);
  });
}
