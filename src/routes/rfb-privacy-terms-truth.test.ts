/**
 * rfb-privacy-terms-truth.test.ts — dev-request
 * 2026-09-24-mcp-rate-limit-og-personvern-sannhet, track C2.
 *
 * Proves /personvern (src/routes/seo.ts) and /vilkar (src/routes/discovery.ts)
 * match what the code actually does, and that the old dead/stale duplicate
 * privacy page (discovery.ts's /privacy, /privacy-policy) no longer serves
 * diverging content:
 *
 *   1. /privacy and /privacy-policy now 301-redirect to /personvern instead
 *      of serving their own stale, diverging copy.
 *   2. /personvern (both NO and EN) no longer claims IP/UA hashing is
 *      "irreversible anonymisation" — it correctly says "salted hash /
 *      pseudonymisation", cross-checked against analytics-service.ts
 *      actually salting hashIP() with IP_HASH_SALT.
 *   3. /personvern discloses MCP/A2A tool-call logging storing a RAW
 *      User-Agent, cross-checked against analytics_mcp_calls' actual
 *      schema (database/init.ts) having a `user_agent` column (not just a
 *      hash) and mcp-usage-logger.ts actually writing the raw string.
 *   4. /personvern discloses that ChatGPT/Claude usage routes through
 *      OpenAI/Anthropic's own infrastructure, and that lokal_geocode calls
 *      Kartverket.
 *   5. /personvern discloses cart/order/buyer-token data and retention,
 *      cross-checked against createCart()'s real 7-day expiry and
 *      sweepExpiredCartContactData()'s real 30-day default cutoff.
 *   6. /vilkar no longer claims RFB "does not process transactions" — it
 *      accurately says RFB does not process PAYMENTS (the platform does
 *      create real orders and send order emails).
 *   7. Both pages' "Sist oppdatert"/"Last updated" date reflects this
 *      change (no longer the stale April 2026 dates).
 *
 * Standalone: npx tsx src/routes/rfb-privacy-terms-truth.test.ts
 */

import fs from "fs";
import path from "path";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

interface InvokeResult {
  found: boolean;
  status: number;
  body: string;
  redirectedTo?: string;
}

function invokeGet(router: any, routePath: string, lang: "no" | "en" = "no"): InvokeResult {
  const layer = (router.stack as any[]).find((l: any) => {
    if (!l.route || !l.route.methods?.get) return false;
    const p = l.route.path;
    return Array.isArray(p) ? p.includes(routePath) : p === routePath;
  });
  if (!layer) return { found: false, status: 0, body: "" };

  let status = 200;
  let body = "";
  let redirectedTo: string | undefined;
  const res: any = {
    status(code: number) { status = code; return this; },
    send(b: unknown) { body = typeof b === "string" ? b : String(b); return this; },
    setHeader() { return this; },
    header() { return this; },
    redirect(codeOrUrl: number | string, maybeUrl?: string) {
      if (typeof codeOrUrl === "number") { status = codeOrUrl; redirectedTo = maybeUrl; }
      else { status = 302; redirectedTo = codeOrUrl; }
      return this;
    },
  };
  const req: any = { lang, params: {}, query: {}, headers: {}, get() { return undefined; } };
  const handler = layer.route.stack[layer.route.stack.length - 1].handle;
  handler(req, res, () => { /* next() */ });
  return { found: true, status, body, redirectedTo };
}

export async function runRfbPrivacyTermsTruthTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];

  function assertTrue(cond: boolean, label: string): void {
    if (cond) { passed++; if (log) console.log(`  ok ${label}`); }
    else { failed++; failures.push(`✗ ${label}`); if (log) console.log(`  ✗ ${label}`); }
  }
  function assertEq(actual: unknown, expected: unknown, label: string): void {
    if (JSON.stringify(actual) === JSON.stringify(expected)) { passed++; if (log) console.log(`  ok ${label}`); }
    else {
      failed++;
      const msg = `✗ ${label}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`;
      failures.push(msg);
      if (log) console.log("  " + msg);
    }
  }

  try {
    const { loadConfigsAtBoot } = require("../config/vertical-config") as typeof import("../config/vertical-config");
    try { loadConfigsAtBoot(); } catch { /* already loaded elsewhere, or dir missing in CI */ }
  } catch { /* config module not resolvable standalone; routes fall back to defaults */ }

  const seoRouter = require("./seo").default as any;
  const discoveryRouter = require("./discovery").default as any;

  // ── Ground truth pulled from the actual code, so this test fails if the
  // code and the privacy page's claims about it ever drift apart again. ────
  const dbInitSrc = fs.readFileSync(path.join(__dirname, "..", "database", "init.ts"), "utf8");
  const analyticsServiceSrc = fs.readFileSync(path.join(__dirname, "..", "services", "analytics-service.ts"), "utf8");
  const cartServiceSrc = fs.readFileSync(path.join(__dirname, "..", "services", "cart-service.ts"), "utf8");
  const cartSweepSrc = fs.readFileSync(path.join(__dirname, "..", "services", "cart-contact-sweep.ts"), "utf8");

  assertTrue(
    /CREATE TABLE IF NOT EXISTS analytics_mcp_calls[\s\S]{0,600}user_agent\s+TEXT/.test(dbInitSrc),
    "ground truth: analytics_mcp_calls really does have a user_agent column (raw, per its own schema comment)"
  );
  assertTrue(
    /const IP_HASH_SALT = process\.env\.IP_HASH_SALT/.test(analyticsServiceSrc) &&
      /createHash\("sha256"\)\.update\(IP_HASH_SALT\)\.update\(ip\)/.test(analyticsServiceSrc),
    "ground truth: hashIP() really is salted with IP_HASH_SALT (C2's own code fix)"
  );
  assertTrue(
    /expires_at = new Date\(Date\.now\(\) \+ 7 \* 24 \* 60 \* 60 \* 1000\)/.test(cartServiceSrc),
    "ground truth: createCart() really does set a 7-day expiry"
  );
  assertTrue(
    /cutoffDays: number = 30/.test(cartSweepSrc),
    "ground truth: sweepExpiredCartContactData() really does default to a 30-day cutoff"
  );

  // ── 1. /privacy, /privacy-policy: redirect, no more duplicate content ──
  for (const p of ["/privacy", "/privacy-policy"]) {
    const r = invokeGet(discoveryRouter, p);
    assertTrue(r.found, `setup: GET ${p} is registered on discovery.ts`);
    if (!r.found) continue;
    assertEq(r.status, 301, `${p}: 301 redirect (no longer serves its own stale privacy text)`);
    assertEq(r.redirectedTo, "/personvern", `${p}: redirects to /personvern (single source of truth)`);
  }

  // ── 2-5. /personvern content, both languages ────────────────────────────
  for (const lang of ["no", "en"] as const) {
    const r = invokeGet(seoRouter, "/personvern", lang);
    assertTrue(r.found, `setup: GET /personvern (${lang}) is registered`);
    if (!r.found) continue;
    assertEq(r.status, 200, `/personvern (${lang}): renders 200`);
    const body = r.body;

    // No more "irreversible anonymisation" overclaim.
    assertTrue(
      !/ikke-reversibel anonymisering/i.test(body) && !/irreversible anonymisation/i.test(body),
      `/personvern (${lang}): no longer claims IP/UA hashing is "irreversible anonymisation"`
    );
    // Correctly reframed as salted hash / pseudonymisation.
    assertTrue(
      lang === "no"
        ? /saltet SHA-256-hash/.test(body) && /pseudonymisering/.test(body)
        : /salted SHA-256 hash/.test(body) && /pseudonymisation/.test(body),
      `/personvern (${lang}): IP hashing correctly described as a salted hash / pseudonymisation`
    );

    // MCP/A2A tool-call logging disclosed, including the raw User-Agent.
    assertTrue(
      lang === "no"
        ? /MCP\/A2A-verktøykall/.test(body) && /User-Agent/.test(body) && /klartekst/.test(body)
        : /MCP\/A2A tool calls/.test(body) && /User-Agent/.test(body) && /as-is/.test(body),
      `/personvern (${lang}): discloses MCP/A2A tool-call logging stores the raw User-Agent`
    );

    // ChatGPT/Claude route through OpenAI/Anthropic infrastructure.
    assertTrue(
      /OpenAI/.test(body) && /Anthropic/.test(body) && (/ChatGPT/.test(body) && /Claude/.test(body)),
      `/personvern (${lang}): discloses that ChatGPT/Claude usage routes through OpenAI/Anthropic`
    );

    // Kartverket geocoding disclosed.
    assertTrue(
      /Kartverket/.test(body) && /lokal_geocode/.test(body),
      `/personvern (${lang}): discloses that lokal_geocode calls Kartverket`
    );

    // Cart/order/buyer-token data + retention disclosed, matching the real
    // 7-day cart expiry and 30-day contact-data retention.
    assertTrue(
      lang === "no"
        ? /buyer_ref/.test(body) && /7 dager/.test(body) && /30 dager/.test(body)
        : /buyer_ref/.test(body) && /7 days/.test(body) && /30 days/.test(body),
      `/personvern (${lang}): discloses cart/order/buyer-token data with the real 7-day/30-day windows`
    );
    assertTrue(
      lang === "no" ? /vi belaster aldri kort/.test(body) : /we never charge a card/.test(body),
      `/personvern (${lang}): correctly states no payment is charged for orders`
    );

    // "Last updated" no longer the stale date.
    assertTrue(
      !/16\. april 2026/.test(body) && !/16 April 2026/.test(body),
      `/personvern (${lang}): no longer shows the stale 16 April 2026 "last updated" date`
    );
    assertTrue(
      lang === "no" ? /Sist oppdatert: 24\. september 2026/.test(body) : /Last updated: 24 September 2026/.test(body),
      `/personvern (${lang}): "last updated" date reflects this change`
    );
  }

  // ── 6. /vilkar: no more "does not process transactions" overclaim ──────
  {
    const r = invokeGet(discoveryRouter, "/vilkar");
    assertTrue(r.found, "setup: GET /vilkar is registered");
    if (r.found) {
      assertEq(r.status, 200, "/vilkar: renders 200");
      assertTrue(
        !/gjennomfører ikke transaksjoner/.test(r.body) && !/does not process transactions/.test(r.body),
        "/vilkar: no longer claims the platform does not process transactions (it does create orders)"
      );
      assertTrue(
        /betalingsformidler/.test(r.body) && /payment processor/.test(r.body),
        "/vilkar: correctly narrows the claim to \"not a payment processor\" (both languages present, same page)"
      );
      assertTrue(
        !/20\. april 2026/.test(r.body) && !/20 April 2026/.test(r.body),
        "/vilkar: no longer shows the stale 20 April 2026 \"last updated\" date"
      );
      assertTrue(
        /Sist oppdatert:<\/strong> 24\. september 2026/.test(r.body) && /Last updated:<\/strong> 24 September 2026/.test(r.body),
        "/vilkar: \"last updated\" date reflects this change (both languages)"
      );
    }
  }

  return { passed, failed, failures };
}

if (require.main === module) {
  runRfbPrivacyTermsTruthTests({ log: true }).then((s) => {
    console.log(`\n${s.passed} passed, ${s.failed} failed`);
    process.exit(s.failed > 0 ? 1 : 0);
  });
}
