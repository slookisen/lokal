/**
 * security-csp-turnstile.test.ts — slice CSP of dev-request
 * 2026-06-25-platform-contact-surface.
 *
 * The /kontakt form on rettfrabonden.com, opplevagent.no and
 * finn-tannlege.com loads Cloudflare Turnstile
 * (https://challenges.cloudflare.com/turnstile/v0/api.js) and the widget
 * runs in an iframe from that origin. The one CSP (securityHeaders in
 * security.ts, mounted for every host) had script-src 'self' 'unsafe-inline'
 * and frame-src 'none', so the browser blocked both, no token was produced
 * and /api/contact (fail-closed) answered 403 captcha_failed to everyone.
 *
 *   a  middleware: the header is the same for every host; script-src and
 *      frame-src now carry https://challenges.cloudflare.com, and so does
 *      connect-src (the Turnstile script's error report when a challenge
 *      fails — prod's console showed connect-src blocking
 *      …/cdn-cgi/challenge-platform/h/g/fr); every other directive is
 *      byte-identical to the pre-fix header (BEFORE_CSP, as served by prod
 *      on 2026-10-31); no wildcard, no new 'unsafe-*', no
 *      nonce / hash / 'strict-dynamic' (either would disable the
 *      'unsafe-inline' the pages' inline scripts rely on, and
 *      'strict-dynamic' would also void the host allowlist).
 *   b  end to end, per host: GET /kontakt and /en/kontakt through the real
 *      routers behind securityHeaders (same order as index.ts) — the header
 *      is the one from (a), the page's Turnstile <script src> is allowed by
 *      the new script-src and was blocked by the old one, every external
 *      script on the page is allowed, the widget iframe origin is allowed by
 *      frame-src (and was not), the widget's error report is allowed by
 *      connect-src (and was not), and the submit fetch('/api/contact') is
 *      same-origin, covered by connect-src 'self'.
 *   c  scan: security.ts is the only non-test file under src/ that sets a
 *      CSP, so no route overrides it for one host.
 *
 * Exported runSecurityCspTurnstileTests({log}) -> TestSummary; wired into
 * tests/test.ts. Standalone:
 *   npx tsx src/middleware/security-csp-turnstile.test.ts
 */

import Database from "better-sqlite3";
import express from "express";
import * as fs from "fs";
import * as http from "http";
import * as path from "path";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

const RFB = "rettfrabonden.com";
const OA = "opplevagent.no";
const FT = "finn-tannlege.com";
const TURNSTILE = "https://challenges.cloudflare.com";
const TURNSTILE_SCRIPT = `${TURNSTILE}/turnstile/v0/api.js`;
// The widget iframe's path is Cloudflare's to change; frame-src allows the
// origin, so any path on it must pass.
const TURNSTILE_FRAME = `${TURNSTILE}/cdn-cgi/challenge-platform/h/g/turnstile/if/ov2/av0/rcv0/0/x/0x4AAAAAADr56qDaUM0XWoTF/light/normal`;
// The error report the Turnstile script fetches when a challenge fails — the
// URL prod's console showed connect-src blocking. The path is Cloudflare's to
// change too; connect-src allows the origin.
const TURNSTILE_REPORT = `${TURNSTILE}/cdn-cgi/challenge-platform/h/g/fr`;
const TURNSTILE_REPORT_DEEP = `${TURNSTILE_REPORT}/8c1a2b3c4d5e6f70/1762070400000/AbCdEf0123`;

/** The header prod served on all three /kontakt pages on 2026-10-31, before this slice. */
const BEFORE_CSP =
  "default-src 'self';script-src 'self' 'unsafe-inline';style-src 'self' 'unsafe-inline' https://fonts.googleapis.com;" +
  "font-src 'self' https://fonts.gstatic.com;img-src 'self' data: https:;connect-src 'self' https://rettfrabonden.com;" +
  "frame-src 'none';object-src 'none';base-uri 'self';form-action 'self';frame-ancestors 'self';script-src-attr 'none';" +
  "upgrade-insecure-requests";

/** BEFORE_CSP with exactly the three directives that carry Turnstile replaced. */
const AFTER_CSP = BEFORE_CSP
  .replace("script-src 'self' 'unsafe-inline';", `script-src 'self' 'unsafe-inline' ${TURNSTILE};`)
  .replace("connect-src 'self' https://rettfrabonden.com;", `connect-src 'self' https://rettfrabonden.com ${TURNSTILE};`)
  .replace("frame-src 'none';", `frame-src ${TURNSTILE};`);

/** "a b;c d" -> [["a", "a b"], ["c", "c d"]] — directive name and its raw text, in order. */
function directives(csp: string): Array<[string, string]> {
  return csp.split(";").map((d) => d.trim()).filter(Boolean).map((d) => [d.split(/\s+/)[0], d] as [string, string]);
}

function sourcesOf(csp: string, name: string): string[] {
  const hit = directives(csp).find(([n]) => n === name);
  return hit ? hit[1].split(/\s+/).slice(1) : [];
}

/**
 * Does a source list allow fetching `url` from a page on `pageOrigin`? The
 * subset of CSP3 source matching this policy uses: 'self', scheme-sources
 * ("https:") and host-sources (scheme://host[:port][/path], "*." prefix).
 * Keywords ('none', 'unsafe-inline', nonces, hashes) never match a URL.
 */
function allows(sources: string[], url: string, pageOrigin: string): boolean {
  const u = new URL(url);
  for (const s of sources) {
    if (s === "'self'") { if (u.origin === pageOrigin) return true; continue; }
    if (s.startsWith("'")) continue;
    if (/^[a-z][a-z0-9+.-]*:$/i.test(s)) { if (u.protocol === s.toLowerCase()) return true; continue; }
    const m = /^([a-z][a-z0-9+.-]*):\/\/([^/:]+)(?::(\d+))?(\/.*)?$/i.exec(s);
    if (!m) continue;
    if (u.protocol !== m[1].toLowerCase() + ":") continue;
    const host = m[2].toLowerCase();
    const hostOk = host.startsWith("*.") ? u.hostname.endsWith(host.slice(1)) : u.hostname === host;
    if (!hostOk) continue;
    if ((m[3] || "") !== u.port) continue;
    if (m[4] && !(m[4].endsWith("/") ? u.pathname.startsWith(m[4]) : u.pathname === m[4])) continue;
    return true;
  }
  return false;
}

/** The CSP securityHeaders sets for a GET on `host` (helmet driven with a bare req/res, as in outbound-utm.test.ts). */
function middlewareCsp(host: string): string | undefined {
  const { securityHeaders } = require("./security") as typeof import("./security");
  const headers: Record<string, string> = {};
  const res: any = {
    setHeader(name: string, value: string) { headers[name.toLowerCase()] = String(value); return this; },
    removeHeader(name: string) { delete headers[name.toLowerCase()]; },
    getHeader(name: string) { return headers[name.toLowerCase()]; },
  };
  let nextCalled = false;
  securityHeaders({ method: "GET", url: "/kontakt", headers: { host } } as any, res, () => { nextCalled = true; });
  return nextCalled ? headers["content-security-policy"] : undefined;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith(".ts") && !e.name.endsWith(".test.ts")) out.push(p);
  }
  return out;
}

export async function runSecurityCspTurnstileTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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

  // ══════════════════════════════════════════════════════════════
  // (a) the middleware's header
  // ══════════════════════════════════════════════════════════════
  const csp = middlewareCsp(RFB) || "";
  for (const host of [RFB, OA, FT, "www.rettfrabonden.com", "lokal.fly.dev"]) {
    assertEq(middlewareCsp(host), csp, `a1: ${host} gets the same CSP (one policy for every host)`);
  }
  assertEq(sourcesOf(csp, "script-src"), ["'self'", "'unsafe-inline'", TURNSTILE], "a2: script-src = 'self' 'unsafe-inline' + the Turnstile origin");
  assertEq(sourcesOf(csp, "frame-src"), [TURNSTILE], "a3: frame-src = the Turnstile origin only ('none' replaced, nothing else)");
  assertEq(directives(csp).map(([n]) => n), directives(BEFORE_CSP).map(([n]) => n), "a4: same directives in the same order — none added, none removed");
  for (const [name, raw] of directives(BEFORE_CSP)) {
    if (name === "script-src" || name === "frame-src" || name === "connect-src") continue;
    assertEq(directives(csp).find(([n]) => n === name)?.[1], raw, `a5: ${name} byte-identical to before`);
  }
  assertEq(csp, AFTER_CSP, "a6: whole header = the old one with only script-src, connect-src and frame-src changed");
  {
    const added: string[] = [];
    for (const [name] of directives(csp)) {
      const before = new Set(sourcesOf(BEFORE_CSP, name));
      for (const s of sourcesOf(csp, name)) if (!before.has(s)) added.push(`${name} ${s}`);
    }
    assertEq(added, [`script-src ${TURNSTILE}`, `connect-src ${TURNSTILE}`, `frame-src ${TURNSTILE}`], "a7: the Turnstile origin is the only source added anywhere");
  }
  assertTrue(!csp.split(/[\s;]+/).some((t) => t.includes("*")), "a8: no wildcard source");
  assertEq((csp.match(/'unsafe-/g) || []).length, (BEFORE_CSP.match(/'unsafe-/g) || []).length, "a9: no new 'unsafe-*' keyword");
  assertTrue(!sourcesOf(csp, "script-src").some((s) => /^'(strict-dynamic|nonce-|sha(256|384|512)-)/.test(s)),
    "a10: script-src has no nonce / hash / 'strict-dynamic' (they would void 'unsafe-inline' for the inline submit script)");
  assertEq(sourcesOf(csp, "connect-src"), ["'self'", "https://rettfrabonden.com", TURNSTILE],
    "a11: connect-src = the old 'self' https://rettfrabonden.com + the Turnstile origin, nothing else");
  // The matcher itself: exact origin only.
  assertTrue(allows(sourcesOf(csp, "script-src"), TURNSTILE_SCRIPT, `https://${RFB}`), "a12: the Turnstile script URL is allowed by script-src");
  assertTrue(!allows(sourcesOf(BEFORE_CSP, "script-src"), TURNSTILE_SCRIPT, `https://${RFB}`), "a13: … and was blocked by the old script-src");
  assertTrue(!allows(sourcesOf(csp, "script-src"), "https://challenges.cloudflare.com.evil.example/turnstile/v0/api.js", `https://${RFB}`), "a14: a look-alike host is not allowed");
  assertTrue(!allows(sourcesOf(csp, "script-src"), "https://cdn.cloudflare.com/x.js", `https://${RFB}`), "a15: another cloudflare.com host is not allowed");
  assertTrue(allows(sourcesOf(csp, "frame-src"), TURNSTILE_FRAME, `https://${RFB}`), "a16: the widget iframe (any path on the origin) is allowed by frame-src");
  assertTrue(!allows(sourcesOf(BEFORE_CSP, "frame-src"), TURNSTILE_FRAME, `https://${RFB}`), "a17: … and was blocked by frame-src 'none'");
  assertTrue(!allows(sourcesOf(csp, "frame-src"), `https://${RFB}/kontakt`, `https://${RFB}`), "a18: frame-src still allows no other frame (not even same-origin)");
  for (const url of [TURNSTILE_REPORT, TURNSTILE_REPORT_DEEP]) {
    assertTrue(allows(sourcesOf(csp, "connect-src"), url, `https://${RFB}`), `a19: the Turnstile error report is allowed by connect-src (${url.slice(TURNSTILE.length)})`);
    assertTrue(!allows(sourcesOf(BEFORE_CSP, "connect-src"), url, `https://${RFB}`), `a20: … and was blocked by the old connect-src (${url.slice(TURNSTILE.length)})`);
  }
  assertTrue(!allows(sourcesOf(csp, "connect-src"), "https://challenges.cloudflare.com.evil.example/cdn-cgi/challenge-platform/h/g/fr", `https://${RFB}`),
    "a21: connect-src allows no look-alike host");
  assertTrue(!allows(sourcesOf(csp, "connect-src"), "https://cdn.cloudflare.com/cdn-cgi/challenge-platform/h/g/fr", `https://${RFB}`),
    "a22: … nor another cloudflare.com host");
  assertTrue(!allows(sourcesOf(csp, "connect-src"), "http://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/g/fr", `https://${RFB}`),
    "a23: … nor the origin over plain http");
  for (const host of [RFB, OA, FT]) {
    assertTrue(allows(sourcesOf(csp, "connect-src"), `https://${host}/api/contact`, `https://${host}`), `a24: same-origin fetches on ${host} are still allowed ('self')`);
  }
  assertTrue(allows(sourcesOf(csp, "connect-src"), "https://rettfrabonden.com/api/marketplace/search", `https://${OA}`),
    "a25: https://rettfrabonden.com is still allowed from the other hosts");

  // ══════════════════════════════════════════════════════════════
  // (b) end to end: /kontakt on each host behind securityHeaders
  // ══════════════════════════════════════════════════════════════
  // Hermetic DBs + fresh routers (same isolation as company-legal-sites.test.ts).
  const { __setDbForTesting, __initSchemaForTesting, __peekDbForTesting } = require("../database/init") as
    typeof import("../database/init");
  const prevRfbDb = __peekDbForTesting();
  const prevDentalDbPath = process.env.DENTAL_DB_PATH;
  const prevExperiencesDbPath = process.env.EXPERIENCES_DB_PATH;
  const rfbTestDb = new Database(":memory:");
  rfbTestDb.pragma("journal_mode = DELETE");
  rfbTestDb.pragma("foreign_keys = OFF");
  process.env.DENTAL_DB_PATH = ":memory:";
  process.env.EXPERIENCES_DB_PATH = ":memory:";

  const cachePaths = [
    "../database/db-factory",
    "../services/dental-store",
    "../services/experience-store",
    "../routes/seo",
    "../routes/dental-seo",
    "../routes/experiences-seo",
  ].map((rel) => require.resolve(rel));
  const restoreModuleCache = (require("../../tests/module-cache") as typeof import("../../tests/module-cache")).swapOutModules(cachePaths);

  let server: http.Server | undefined;
  try {
    const cfgMod = require("../config/vertical-config") as typeof import("../config/vertical-config");
    cfgMod._resetConfigCacheForTests();
    cfgMod.loadConfigsAtBoot({ dir: "./verticals" });

    __setDbForTesting(rfbTestDb as any);
    __initSchemaForTesting(rfbTestDb as any);
    const regMod = require("../services/marketplace-registry") as typeof import("../services/marketplace-registry");
    (regMod.marketplaceRegistry as any)._statsCache = null;
    (regMod.marketplaceRegistry as any)._agentsCache = null;
    const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
    dbFactory.__resetDbFactoryForTesting();
    dbFactory.getDb("dental");
    dbFactory.getDb("experiences");

    const { securityHeaders } = require("./security") as typeof import("./security");
    const { langMiddleware } = require("../i18n/middleware") as typeof import("../i18n/middleware");
    const seoRouter = require("../routes/seo").default;
    const expRouter = require("../routes/experiences-seo").default;
    const dentalRouter = require("../routes/dental-seo").default;

    // index.ts order: securityHeaders, langMiddleware, the finn-tannlege.com /
    // opplevagent.no host gates, then the rfb routers at root.
    const app = express();
    app.use(securityHeaders);
    app.use(langMiddleware);
    app.use((req: any, res: any, next: any) => {
      if (req.hostname === FT) return dentalRouter(req, res, next);
      if (req.hostname === OA) return expRouter(req, res, next);
      return next();
    });
    app.use("/", seoRouter);
    app.use((_req, res) => res.status(418).send("fell-through"));

    server = http.createServer(app);
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as any).port;
    const get = (p: string, host: string): Promise<{ status: number; csp: string; body: string }> =>
      new Promise((resolve, reject) => {
        http
          .get({ host: "127.0.0.1", port, path: p, headers: { host, accept: "text/html" } }, (resp) => {
            const chunks: Buffer[] = [];
            resp.on("data", (c) => chunks.push(c as Buffer));
            resp.on("end", () => resolve({
              status: resp.statusCode || 0,
              csp: String(resp.headers["content-security-policy"] || ""),
              body: Buffer.concat(chunks).toString("utf8"),
            }));
          })
          .on("error", reject);
      });

    for (const host of [RFB, OA, FT]) {
      for (const p of ["/kontakt", "/en/kontakt"]) {
        const tag = `b ${host}${p}`;
        const origin = `https://${host}`;
        const r = await get(p, host);
        assertEq(r.status, 200, `${tag}: renders 200`);
        assertEq(r.csp, AFTER_CSP, `${tag}: served with the fixed CSP`);
        assertTrue(r.body.includes('class="cf-turnstile"'), `${tag}: the page has the Turnstile widget`);

        const turnstileTags = r.body.match(/<script\b[^>]*\bsrc="[^"]*challenges\.cloudflare\.com[^"]*"[^>]*>/g) || [];
        assertEq(turnstileTags.length, 1, `${tag}: exactly one Turnstile <script> tag`);
        const src = /\bsrc="([^"]*)"/.exec(turnstileTags[0] || "")?.[1] || "";
        assertEq(src, TURNSTILE_SCRIPT, `${tag}: the script src is the documented api.js URL`);
        assertTrue(!/\b(nonce|integrity)=/.test(turnstileTags[0] || ""), `${tag}: the tag carries no nonce/integrity the policy would have to match`);
        assertTrue(allows(sourcesOf(r.csp, "script-src"), src, origin), `${tag}: the served script-src allows that src`);
        assertTrue(!allows(sourcesOf(BEFORE_CSP, "script-src"), src, origin), `${tag}: … which the old script-src blocked`);

        const external = Array.from(r.body.matchAll(/<script\b[^>]*\bsrc="([^"]*)"/g)).map((m) => new URL(m[1], origin + p).href);
        const blocked = external.filter((u) => !allows(sourcesOf(r.csp, "script-src"), u, origin));
        assertEq(blocked, [], `${tag}: every external script on the page is allowed`);

        assertTrue(allows(sourcesOf(r.csp, "frame-src"), TURNSTILE_FRAME, origin), `${tag}: the widget iframe origin is allowed by frame-src`);
        assertTrue(allows(sourcesOf(r.csp, "connect-src"), TURNSTILE_REPORT, origin), `${tag}: the widget's error report is allowed by connect-src`);
        assertTrue(!allows(sourcesOf(BEFORE_CSP, "connect-src"), TURNSTILE_REPORT, origin), `${tag}: … which the old connect-src blocked`);
        assertTrue(r.body.includes("fetch('/api/contact'") && allows(sourcesOf(r.csp, "connect-src"), `${origin}/api/contact`, origin),
          `${tag}: the submit fetch('/api/contact') is same-origin, allowed by connect-src`);
      }
    }
  } catch (err: any) {
    failed++;
    failures.push(`b: unexpected error: ${err?.stack || err?.message || String(err)}`);
  } finally {
    if (server) await new Promise<void>((r) => server!.close(() => r()));
    if (prevRfbDb) __setDbForTesting(prevRfbDb);
    if (prevDentalDbPath === undefined) delete process.env.DENTAL_DB_PATH; else process.env.DENTAL_DB_PATH = prevDentalDbPath;
    if (prevExperiencesDbPath === undefined) delete process.env.EXPERIENCES_DB_PATH; else process.env.EXPERIENCES_DB_PATH = prevExperiencesDbPath;
    try { (require("../database/db-factory") as typeof import("../database/db-factory")).__resetDbFactoryForTesting(); } catch { /* best-effort */ }
    try {
      const regMod = require("../services/marketplace-registry") as typeof import("../services/marketplace-registry");
      (regMod.marketplaceRegistry as any)._statsCache = null;
      (regMod.marketplaceRegistry as any)._agentsCache = null;
    } catch { /* best-effort */ }
    restoreModuleCache();
    try { rfbTestDb.close(); } catch { /* best-effort */ }
  }

  // ══════════════════════════════════════════════════════════════
  // (c) no per-route CSP override
  // ══════════════════════════════════════════════════════════════
  {
    const srcDir = path.join(__dirname, "..");
    const setters = walk(srcDir)
      .filter((f) => /content-security-policy|contentSecurityPolicy/i.test(fs.readFileSync(f, "utf8")))
      .map((f) => path.relative(srcDir, f).replace(/\\/g, "/"));
    assertEq(setters, ["middleware/security.ts"], "c1: security.ts is the only non-test file under src/ that sets a CSP");
  }

  return { passed, failed, failures };
}

// Standalone runner: `npx tsx src/middleware/security-csp-turnstile.test.ts`
if (require.main === module) {
  console.log("── CSP allows Cloudflare Turnstile on /kontakt (dev-request 2026-06-25-platform-contact-surface, slice CSP) ──");
  runSecurityCspTurnstileTests({ log: true }).then((r) => {
    console.log(`\nsecurity-csp-turnstile: ${r.passed} passed, ${r.failed} failed`);
    if (r.failed > 0) {
      console.log(r.failures.join("\n"));
      process.exit(1);
    }
    process.exit(0);
  });
}
