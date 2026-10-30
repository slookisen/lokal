/**
 * same-origin-write.test.ts — slice T0a (owner-portal write guard): the ONE
 * same-origin check for owner/link writes.
 *
 *   AC2   predicate matrix with WRITE_GUARD_FETCH_METADATA on (default):
 *         Origin null + same-origin → allow; no Origin → allow; Sec-Fetch-Site
 *         cross-site / same-site → refuse; foreign Origin → refuse; own Origin
 *         → allow; garbage Origin → refuse.
 *   flag  WRITE_GUARD_FETCH_METADATA=0 → the same decisions as the old
 *         crossSiteRequest / crossSite copies (copied below as the oracle)
 *         for a table of inputs.
 *   AC3   the refusal page text + back link; exactly one
 *         `[write-guard] refused <route> <reason>` log line per refusal, with
 *         no token and no e-mail.
 *   scan  exactly one Origin-parsing check under src/ (outside the MCP CORS
 *         code in mcp.ts / experiences-mcp.ts and test files).
 *
 * Exported runSameOriginWriteTests({log}) -> TestSummary; wired into
 * tests/test.ts. Standalone: npx tsx src/middleware/same-origin-write.test.ts
 */

import * as fs from "fs";
import * as path from "path";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

/** The old check (owner-portal.ts crossSiteRequest, owner-orders.ts / buyer-order-card.ts crossSite) — the oracle. */
function oldCrossSiteOracle(req: any): boolean {
  const origin = req.headers.origin;
  if (!origin || typeof origin !== "string") return false;
  try { return new URL(origin).host !== String(req.headers.host || ""); } catch { return true; }
}

export async function runSameOriginWriteTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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

  const FLAG = "WRITE_GUARD_FETCH_METADATA";
  const prevFlag = process.env[FLAG];
  const prevLog = console.log;
  const logged: string[] = [];
  console.log = (...a: unknown[]) => { logged.push(a.map(String).join(" ")); };
  try {
    const m = require("./same-origin-write") as typeof import("./same-origin-write");
    const HOST = "rettfrabonden.com";
    const mk = (h: Record<string, string | undefined>, route?: string): any => {
      const headers: Record<string, string> = { host: HOST };
      for (const [k, v] of Object.entries(h)) if (v !== undefined) headers[k] = v;
      return { headers, route: route ? { path: route } : undefined };
    };
    const verdict = (h: Record<string, string | undefined>) => m.sameOriginWriteVerdict(mk(h));

    // ── AC2: default (flag unset) ─────────────────────────────────────────
    delete process.env[FLAG];
    assertTrue(m.writeGuardFetchMetadataEnabled(), "flag: unset → on");
    assertEq(verdict({ origin: "null", "sec-fetch-site": "same-origin" }), { refused: false }, "ac2-01: Origin null + same-origin → allow");
    assertEq(verdict({ origin: "null" }), { refused: false }, "ac2-02: Origin null, no Sec-Fetch-Site (older browser) → allow");
    assertEq(verdict({}), { refused: false }, "ac2-03: no Origin → allow");
    assertEq(verdict({ "sec-fetch-site": "none" }), { refused: false }, "ac2-04: Sec-Fetch-Site none (user-typed) → allow");
    assertEq(verdict({ "sec-fetch-site": "cross-site" }), { refused: true, reason: "sec_fetch_site_cross_site" }, "ac2-05: Sec-Fetch-Site cross-site → refuse");
    assertEq(verdict({ "sec-fetch-site": "same-site" }), { refused: true, reason: "sec_fetch_site_same_site" }, "ac2-06: Sec-Fetch-Site same-site → refuse");
    assertEq(verdict({ origin: "null", "sec-fetch-site": "cross-site" }), { refused: true, reason: "sec_fetch_site_cross_site" }, "ac2-07: Origin null + cross-site → refuse");
    assertEq(verdict({ origin: `https://${HOST}`, "sec-fetch-site": "Cross-Site" }), { refused: true, reason: "sec_fetch_site_cross_site" }, "ac2-08: Sec-Fetch-Site compared case-insensitively");
    assertEq(verdict({ origin: "https://evil.example" }), { refused: true, reason: "origin_foreign" }, "ac2-09: foreign Origin → refuse");
    assertEq(verdict({ origin: "https://evil.example", "sec-fetch-site": "same-origin" }), { refused: true, reason: "origin_foreign" }, "ac2-10: foreign Origin even with same-origin metadata → refuse");
    assertEq(verdict({ origin: `https://www.${HOST}` }), { refused: true, reason: "origin_foreign" }, "ac2-11: another host of ours is still not this Host (as before) → refuse");
    assertEq(verdict({ origin: `https://${HOST}`, "sec-fetch-site": "same-origin" }), { refused: false }, "ac2-12: own Origin → allow");
    assertEq(verdict({ origin: `https://${HOST}` }), { refused: false }, "ac2-13: own Origin without metadata → allow");
    assertEq(verdict({ origin: "not a url" }), { refused: true, reason: "origin_unparseable" }, "ac2-14: garbage Origin → refuse");
    assertEq(verdict({ origin: "Null" }), { refused: true, reason: "origin_unparseable" }, "ac2-15: only the literal «null» is the opaque origin");
    assertEq(m.sameOriginWriteVerdict({ headers: { host: HOST, origin: "http://127.0.0.1:4000" } } as any), { refused: true, reason: "origin_foreign" }, "ac2-16: port is part of the host comparison");
    assertEq(m.sameOriginWriteVerdict({ headers: { host: "127.0.0.1:4000", origin: "http://127.0.0.1:4000" } } as any), { refused: false }, "ac2-17: same host:port → allow");
    process.env[FLAG] = "1";
    assertEq(verdict({ origin: "null" }), { refused: false }, "ac2-18: flag «1» → on");
    assertEq(logged.length, 0, "ac2-19: the pure verdict never logs");

    // ── flag=0: identical to the old function ─────────────────────────────
    process.env[FLAG] = "0";
    assertTrue(!m.writeGuardFetchMetadataEnabled(), "flag: «0» → off");
    const TABLE: Array<Record<string, string | undefined>> = [
      {},
      { origin: "null" },
      { origin: "null", "sec-fetch-site": "same-origin" },
      { "sec-fetch-site": "cross-site" },
      { "sec-fetch-site": "same-site" },
      { origin: `https://${HOST}`, "sec-fetch-site": "cross-site" },
      { origin: `https://${HOST}` },
      { origin: `http://${HOST}` },
      { origin: `https://${HOST}:443` },
      { origin: `https://${HOST}:8443` },
      { origin: `https://www.${HOST}` },
      { origin: "https://evil.example" },
      { origin: "https://evil.example", "sec-fetch-site": "same-origin" },
      { origin: "not a url" },
      { origin: "" },
      { origin: "Null" },
      { origin: "file://" },
      { origin: `https://${HOST}`, host: undefined },
    ];
    for (const [i, row] of TABLE.entries()) {
      const req = mk(row);
      if ("host" in row && row.host === undefined) delete req.headers.host;
      assertEq(m.sameOriginWriteVerdict(req).refused, oldCrossSiteOracle(req), `flag0-${String(i + 1).padStart(2, "0")}: ${JSON.stringify(row)} → same decision as the old check`);
    }
    // ...and the same table with the flag on differs only where Origin is «null» / Sec-Fetch-Site refuses.
    delete process.env[FLAG];
    const diffs = TABLE.map((row, i) => {
      const req = mk(row);
      if ("host" in row && row.host === undefined) delete req.headers.host;
      return m.sameOriginWriteVerdict(req).refused !== oldCrossSiteOracle(req) ? i + 1 : null;
    }).filter((x) => x !== null);
    assertEq(diffs, [2, 3, 4, 5, 6], "flag-on vs old: only Origin null (allowed) and Sec-Fetch-Site cross/same-site (refused) differ");

    // ── AC3: one log line, route pattern, no token / e-mail ───────────────
    logged.length = 0;
    const tokenUrlReq = mk({ origin: "https://evil.example" }, "/produsent/ordre/:token/kompakt");
    tokenUrlReq.url = "/produsent/ordre/ctok_SECRET123/kompakt";
    tokenUrlReq.originalUrl = tokenUrlReq.url;
    tokenUrlReq.body = { email: "eier@example.no" };
    assertTrue(m.isCrossSiteWrite(tokenUrlReq), "ac3-01: refused");
    assertEq(logged, ["[write-guard] refused /produsent/ordre/:token/kompakt origin_foreign"], "ac3-02: exactly one log line with the route pattern and reason");
    assertTrue(!logged.join("\n").includes("SECRET123") && !logged.join("\n").includes("@") && !logged.join("\n").includes("evil.example"), "ac3-03: no token, no e-mail, no Origin value in the log");
    logged.length = 0;
    assertTrue(!m.isCrossSiteWrite(mk({ origin: "null", "sec-fetch-site": "same-origin" }, "/eier/:agentId/valg/niva")), "ac3-04: allowed request…");
    assertEq(logged.length, 0, "ac3-05: …logs nothing");
    logged.length = 0;
    m.checkSameOriginWrite(mk({ "sec-fetch-site": "cross-site" }, "/eier/:agentId/valg/niva"), "/explicit/:pattern");
    assertEq(logged, ["[write-guard] refused /explicit/:pattern sec_fetch_site_cross_site"], "ac3-06: an explicit route pattern wins");
    logged.length = 0;
    m.checkSameOriginWrite({ headers: { host: HOST, origin: "x" }, url: "/a/secret-token" } as any);
    assertEq(logged, ["[write-guard] refused unknown-route origin_unparseable"], "ac3-07: no route → «unknown-route», never the URL");

    const body = m.writeGuardRefusedBody({ contact: m.WRITE_GUARD_CONTACT_RFB, backHref: "/eier/a%22b/valg", backLabel: "Tilbake til Mine valg" });
    assertEq(m.WRITE_GUARD_REFUSED_TITLE, "Kunne ikke lagre", "ac3-08: title");
    assertTrue(body.includes("<h1>Endringen ble ikke lagret</h1>"), "ac3-09: heading");
    assertTrue(body.includes("Av sikkerhetshensyn lagrer vi bare endringer som gjøres på våre egne sider. Gå tilbake og prøv igjen. Skjer det igjen, skriv til <a href=\"mailto:kontakt@rettfrabonden.com\">kontakt@rettfrabonden.com</a>."), "ac3-10: the text, with the RFB contact");
    assertTrue(body.includes(`<a href="/eier/a%22b/valg">Tilbake til Mine valg</a>`), "ac3-11: back link");
    assertTrue(m.writeGuardRefusedBody({ contact: "x", backHref: `"><script>`, backLabel: "<b>" }).includes(`href="&quot;&gt;&lt;script&gt;">&lt;b&gt;</a>`), "ac3-12: back link escaped");
    const ga = m.writeGuardRefusedBody({ contact: m.WRITE_GUARD_CONTACT_OPPLEVAGENT, backHref: "/x", backLabel: "Tilbake til Mine valg" });
    assertTrue(ga.includes("kontakt@opplevagent.no") && !/rettfrabonden|Rett fra Bonden/i.test(ga), "ac3-13: gårdssalg body names kontakt@opplevagent.no only");

    // ── scan: exactly one Origin-parsing check in src/ ────────────────────
    const srcRoot = path.resolve(__dirname, "..");
    const EXCLUDED = new Set([path.join(srcRoot, "routes", "mcp.ts"), path.join(srcRoot, "routes", "experiences-mcp.ts")]);
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.(ts|js)$/.test(e.name) && !/\.test\.(ts|js)$/.test(e.name) && !EXCLUDED.has(p)) files.push(p);
      }
    };
    walk(srcRoot);
    // An Origin-parsing check: reads the Origin request header, or parses a value named origin with new URL().
    const ORIGIN_READ = /headers\s*(\.\s*origin\b|\[\s*["']origin["']\s*\])|\.(get|header)\(\s*["']origin["']\s*\)|new URL\(\s*origin\b/i;
    const hits = files.filter((f) => ORIGIN_READ.test(fs.readFileSync(f, "utf8"))).map((f) => path.relative(srcRoot, f));
    assertEq(hits, [path.join("middleware", "same-origin-write.ts")], "scan-01: exactly one Origin check implementation in src/ (outside mcp.ts / experiences-mcp.ts)");
    assertTrue(files.length > 100, "scan-02: the scan saw the source tree");
    const owners = ["routes/owner-portal.ts", "routes/owner-features.ts", "routes/gardssalg-owner-features.ts", "routes/owner-orders.ts", "routes/buyer-order-card.ts", "routes/stock-check.ts", "routes/owner-product-import.ts"];
    for (const f of owners) {
      const s = fs.readFileSync(path.join(srcRoot, f), "utf8");
      assertTrue(/\bisCrossSiteWrite\(/.test(s) && !/\bcrossSite(Request)?\(/.test(s), `scan-03: ${f} uses the shared guard (no local copy)`);
    }
  } finally {
    console.log = prevLog;
    if (prevFlag === undefined) delete process.env[FLAG]; else process.env[FLAG] = prevFlag;
  }
  return { passed, failed, failures };
}

if (require.main === module) {
  runSameOriginWriteTests({ log: true }).then((r) => {
    console.info(`same-origin-write: ${r.passed} passed, ${r.failed} failed`);
    for (const f of r.failures) console.info(f);
    process.exit(r.failed ? 1 : 0);
  });
}
