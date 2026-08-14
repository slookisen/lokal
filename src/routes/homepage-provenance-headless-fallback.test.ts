/**
 * homepage-provenance-headless-fallback.test.ts — tests the headless-render
 * fallback added to POST /admin/homepage-provenance-batch (src/routes/
 * marketplace.ts, processAgent()) by dev-request 2026-08-14-fetch-vegg-
 * headless-fallback (Slice 2, 2nd consumer of the shared services/
 * render-page.ts module — the 1st consumer is admin-rfb-website-discovery.ts's
 * tryRfbWebsiteCandidateHost, already shipped).
 *
 * Flag: HOMEPAGE_PROVENANCE_HEADLESS_FALLBACK_ENABLED === "true" (default
 * OFF). When ON, a plain-fetch page that (a) fails the website-ownership
 * name-match (Guard #1, pageMentionsProducer) AND (b) looks like a JS shell
 * (shouldEscalateToRender) is re-fetched through a headless browser
 * (services/render-page.ts's renderPage — injected in these tests via
 * marketplace.ts's __setRenderPageImplForTesting, mirroring RFB website
 * discovery's __setRfbWdRenderPageImplForTesting). If the RENDERED page now
 * verifies ownership, extraction (email/phone/address) and the eventual
 * `enriched` outcome all use the rendered html/finalUrl instead of the
 * original — never a mix of the two. A render failure (including
 * `renderer_unavailable`) or a render that still fails to verify falls
 * through to the exact same `ownership_unverified` outcome as if no fallback
 * had ever been attempted — never a throw, never an extra negative signal.
 *
 * Mirrors homepage-provenance-selector-parking.test.ts:
 *   - in-memory better-sqlite3 DB injected via __setDbForTesting +
 *     __initSchemaForTesting (full prod-like schema).
 *   - the previous global db handle is saved/restored.
 *   - the router is exercised directly (router.handle(req, res, next)),
 *     no HTTP server / supertest.
 *   - global.fetch is stubbed (the PLAIN fetch only — renderPage is a
 *     separate injected implementation, never touches global.fetch).
 *   - exported runHomepageProvenanceHeadlessFallbackTests({log}) -> TestSummary;
 *     wired into tests/test.ts.
 *     Standalone: npx tsx src/routes/homepage-provenance-headless-fallback.test.ts
 */

import Database from "better-sqlite3";
import * as initMod from "../database/init";
import type { RenderPageResult } from "../services/render-page";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

interface RouteResult {
  status: number;
  body: any;
  ended: boolean;
}

function callRoute(
  router: any,
  opts: {
    method?: string;
    url: string;
    headers?: Record<string, string>;
    body?: any;
  },
): Promise<RouteResult> {
  return new Promise((resolve) => {
    const headers = opts.headers || {};
    const req: any = {
      method: opts.method || "GET",
      url: opts.url,
      originalUrl: opts.url,
      query: {},
      headers,
      body: opts.body,
      ip: "127.0.0.1",
      get(name: string) {
        return headers[name.toLowerCase()];
      },
    };
    const res: any = {
      statusCode: 200,
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      json(payload: any) {
        resolve({ status: this.statusCode, body: payload, ended: true });
        return this;
      },
      end() {
        resolve({ status: this.statusCode, body: undefined, ended: true });
        return this;
      },
    };
    router.handle(req, res, (err?: any) => {
      if (err) {
        resolve({ status: 500, body: { error: String(err) }, ended: true });
      } else {
        resolve({ status: 0, body: undefined, ended: false });
      }
    });
  });
}

// A JS-shell page (dev-request's own 67northdistillery.no shape): big body
// (>= RENDER_ESCALATION_MIN_BYTES=2000B), a <script> tag, but under
// RENDER_ESCALATION_TEXT_FLOOR=200 visible chars — and (deliberately) no
// mention of the producer's name, so the plain-fetch ownership check fails
// FOR THE SAME REASON a real JS-built site would: there is no text to match
// against yet, only after a browser runs the scripts.
function jsShellHtml(): string {
  const padding = "x".repeat(3000); // keeps <script> body out of visible text
  return `<!DOCTYPE html><html><head><title>Laster inn...</title></head><body><div id="app"></div><script>${padding}</script></body></html>`;
}

// A substantial, static (non-JS-shell) page that also fails ownership — no
// <script> tag at all, so shouldEscalateToRender is false regardless of the
// (also-generous) visible text length. Used for the "does not look like a JS
// shell" case (4).
function staticNonMatchHtml(): string {
  const filler = "Velkommen til vår butikk. Vi selger varer av høy kvalitet. ".repeat(20);
  return `<!DOCTYPE html><html><head><title>Ukjent Butikk AS</title></head><body><p>${filler}</p></body></html>`;
}

// The rendered (post-script) DOM for the producer's real page — mentions the
// producer's name literally (so pageMentionsProducer verifies) and carries
// extractable contact fields, all DIFFERENT from anything in the plain html
// (which has none), so a passing extraction test proves it came from here.
function renderedProducerHtml(): string {
  return (
    `<!DOCTYPE html><html><head><title>Vestgaard Bær AS</title></head><body>` +
    `<h1>Vestgaard Bær AS</h1>` +
    `<p>Velkommen til Vestgaard Bær AS, din lokale gårdsbutikk.</p>` +
    `<p>Kontakt: 91234567</p>` +
    `<p>Adresse: Gårdsveien 12, 4620 Kristiansand</p>` +
    `<a href="mailto:post@example-farm-site.no">post@example-farm-site.no</a>` +
    `</body></html>`
  );
}

export function runHomepageProvenanceHeadlessFallbackTests(
  opts: { log?: boolean } = {},
): Promise<TestSummary> {
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

  return (async () => {
    const prevDb = initMod.getDb();
    const testKey = process.env.ADMIN_KEY || "homepage-provenance-headless-fallback-test-key";
    const prevAdminKey = process.env.ADMIN_KEY;
    process.env.ADMIN_KEY = testKey;
    const prevFetch = (globalThis as any).fetch;
    const prevFlag = process.env.HOMEPAGE_PROVENANCE_HEADLESS_FALLBACK_ENABLED;
    delete process.env.HOMEPAGE_PROVENANCE_HEADLESS_FALLBACK_ENABLED;

    const db = new Database(":memory:");
    try {
      initMod.__setDbForTesting(db as any);
      initMod.__initSchemaForTesting(db as any);

      const insertAgent = db.prepare(
        `INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key)
         VALUES (?, ?, 'test agent', 'test', 'x@example.com', ?, 'producer', ?)`,
      );
      insertAgent.run("agent-shell", "Vestgaard Bær AS", "https://example-farm-site.no", "key-shell");
      insertAgent.run("agent-shell-2", "Vestgaard Bær AS", "https://example-farm-site.no", "key-shell-2");
      insertAgent.run("agent-shell-3", "Vestgaard Bær AS", "https://example-farm-site.no", "key-shell-3");
      insertAgent.run("agent-static", "Vestgaard Bær AS", "https://example-farm-site.no", "key-static");

      const insertKnowledge = db.prepare(
        `INSERT INTO agent_knowledge (agent_id, website, email, about, field_provenance, verification_status)
         VALUES (?, ?, NULL, 'A test farm shop', '{}', 'pending_verify')`,
      );
      insertKnowledge.run("agent-shell", "https://example-farm-site.no");
      insertKnowledge.run("agent-shell-2", "https://example-farm-site.no");
      insertKnowledge.run("agent-shell-3", "https://example-farm-site.no");
      insertKnowledge.run("agent-static", "https://example-farm-site.no");

      // Fresh require so the router picks up the just-injected db AND a clean
      // renderPageImplForTesting slot for each require.
      delete require.cache[require.resolve("./marketplace")];
      const marketplaceMod = require("./marketplace");
      const router = marketplaceMod.default;
      const setRenderPageImplForTesting: (impl: any) => void = marketplaceMod.__setRenderPageImplForTesting;
      assertTrue(
        typeof setRenderPageImplForTesting === "function",
        "hf-00: marketplace.ts exports __setRenderPageImplForTesting",
      );

      // Plain fetch stub — always returns the SAME html regardless of agent
      // (each test phase sets `plainHtml` before posting).
      let plainHtml = jsShellHtml();
      (globalThis as any).fetch = async (_url: string) => {
        return {
          ok: true,
          status: 200,
          text: async () => plainHtml,
        } as any;
      };

      async function post(body: any): Promise<RouteResult> {
        return callRoute(router, {
          method: "POST",
          url: "/admin/homepage-provenance-batch",
          headers: { "x-admin-key": testKey, "content-type": "application/json" },
          body,
        });
      }

      function knowledgeRow(agentId: string): {
        email: string | null;
        phone: string | null;
        address: string | null;
        field_provenance: string | null;
        last_enrichment_outcome: string | null;
      } {
        return db
          .prepare(
            "SELECT email, phone, address, field_provenance, last_enrichment_outcome FROM agent_knowledge WHERE agent_id = ?",
          )
          .get(agentId) as any;
      }

      // ── (1) Flag OFF: renderPage never called, stays ownership_unverified ──
      {
        let renderCalls = 0;
        setRenderPageImplForTesting(async (): Promise<RenderPageResult> => {
          renderCalls++;
          return { ok: true, html: renderedProducerHtml(), text: "x", finalUrl: "https://example-farm-site.no", elapsedMs: 1 };
        });
        plainHtml = jsShellHtml();

        const result = await post({ agentIds: ["agent-shell"] });
        assertEq(result.status, 200, "hf-01: POST -> 200 (flag off)");
        assertEq(result.body?.data?.processed, 1, "hf-02: processed=1 (flag off)");
        assertEq(
          result.body?.data?.ownership_unverified,
          1,
          "hf-03: flag OFF -> ownership_unverified stays 1 (JS-shell HTML never escalated)",
        );
        assertEq(renderCalls, 0, "hf-04: flag OFF -> renderPage never called");
        assertEq(result.body?.data?.headless_fallback_attempted, 0, "hf-05: flag OFF -> headless_fallback_attempted=0");
        assertEq(result.body?.data?.headless_fallback_verified, 0, "hf-06: flag OFF -> headless_fallback_verified=0");
        assertEq(
          knowledgeRow("agent-shell").last_enrichment_outcome,
          "wrong_entity",
          "hf-07: flag OFF -> last_enrichment_outcome stays wrong_entity (unchanged path)",
        );
        setRenderPageImplForTesting(null);
      }

      // ── (2) Flag ON + JS shell + render succeeds + rendered page verifies ──
      // -> enriched, both counters +1, extracted fields come from RENDERED html.
      {
        process.env.HOMEPAGE_PROVENANCE_HEADLESS_FALLBACK_ENABLED = "true";
        let renderCalls = 0;
        let lastRenderUrl: string | null = null;
        setRenderPageImplForTesting(async (url: string): Promise<RenderPageResult> => {
          renderCalls++;
          lastRenderUrl = url;
          return {
            ok: true,
            html: renderedProducerHtml(),
            text: "Vestgaard Bær AS",
            finalUrl: "https://example-farm-site.no",
            elapsedMs: 42,
          };
        });
        plainHtml = jsShellHtml();

        const result = await post({ agentIds: ["agent-shell-2"] });
        assertEq(result.status, 200, "hf-08: POST -> 200 (flag on, render verifies)");
        assertEq(renderCalls, 1, "hf-09: flag ON + JS shell -> renderPage called exactly once");
        assertEq(lastRenderUrl, "https://example-farm-site.no", "hf-10: renderPage called with the plain-fetch URL");
        assertEq(result.body?.data?.enriched, 1, "hf-11: outcome becomes enriched after rendered ownership verifies");
        assertEq(result.body?.data?.ownership_unverified, 0, "hf-12: ownership_unverified=0 for this run");
        assertEq(result.body?.data?.headless_fallback_attempted, 1, "hf-13: headless_fallback_attempted=1");
        assertEq(result.body?.data?.headless_fallback_verified, 1, "hf-14: headless_fallback_verified=1");

        const row = knowledgeRow("agent-shell-2");
        assertEq(row.email, "post@example-farm-site.no", "hf-15: extracted email comes from the RENDERED html, not the original (which has none)");
        assertEq(row.phone, "91234567", "hf-16: extracted phone comes from the RENDERED html");
        assertTrue(!!row.address && row.address.includes("4620"), "hf-17: extracted address comes from the RENDERED html");
        assertEq(row.last_enrichment_outcome, "enriched", "hf-18: last_enrichment_outcome=enriched");

        let prov: any = {};
        try { prov = JSON.parse(row.field_provenance || "{}"); } catch { /* ignore */ }
        assertEq(
          prov?.email?.[0]?.source_url,
          "https://example-farm-site.no",
          "hf-19: written provenance source_url is the rendered page's final URL",
        );
        setRenderPageImplForTesting(null);
      }

      // ── (3) Flag ON + render fails (renderer_unavailable) -> falls through
      // to ownership_unverified exactly as before; attempted increments,
      // verified does not; never a throw.
      {
        process.env.HOMEPAGE_PROVENANCE_HEADLESS_FALLBACK_ENABLED = "true";
        let renderCalls = 0;
        setRenderPageImplForTesting(async (): Promise<RenderPageResult> => {
          renderCalls++;
          return { ok: false, reason: "renderer_unavailable", detail: "playwright-core not installed", elapsedMs: 3 };
        });
        plainHtml = jsShellHtml();

        const result = await post({ agentIds: ["agent-shell-3"] });
        assertEq(result.status, 200, "hf-20: POST -> 200 (flag on, render fails, no throw)");
        assertEq(renderCalls, 1, "hf-21: renderPage called exactly once");
        assertEq(result.body?.data?.ownership_unverified, 1, "hf-22: falls through to ownership_unverified");
        assertEq(result.body?.data?.enriched, 0, "hf-23: not enriched");
        assertEq(result.body?.data?.headless_fallback_attempted, 1, "hf-24: headless_fallback_attempted=1");
        assertEq(result.body?.data?.headless_fallback_verified, 0, "hf-25: headless_fallback_verified=0 (render never succeeded)");
        assertEq(
          knowledgeRow("agent-shell-3").last_enrichment_outcome,
          "wrong_entity",
          "hf-26: outcome recorded the same as an un-escalated ownership failure",
        );
        setRenderPageImplForTesting(null);
      }

      // ── (4) Flag ON + HTML does NOT look like a JS shell -> renderPage
      // never called, stays ownership_unverified, no fallback counters move.
      {
        process.env.HOMEPAGE_PROVENANCE_HEADLESS_FALLBACK_ENABLED = "true";
        let renderCalls = 0;
        setRenderPageImplForTesting(async (): Promise<RenderPageResult> => {
          renderCalls++;
          return { ok: true, html: renderedProducerHtml(), text: "x", finalUrl: "https://example-farm-site.no", elapsedMs: 1 };
        });
        plainHtml = staticNonMatchHtml();

        const result = await post({ agentIds: ["agent-static"] });
        assertEq(result.status, 200, "hf-27: POST -> 200 (flag on, not a JS shell)");
        assertEq(renderCalls, 0, "hf-28: shouldEscalateToRender=false -> renderPage never called");
        assertEq(result.body?.data?.ownership_unverified, 1, "hf-29: stays ownership_unverified");
        assertEq(result.body?.data?.headless_fallback_attempted, 0, "hf-30: headless_fallback_attempted=0");
        assertEq(result.body?.data?.headless_fallback_verified, 0, "hf-31: headless_fallback_verified=0");
        setRenderPageImplForTesting(null);
      }

      delete process.env.HOMEPAGE_PROVENANCE_HEADLESS_FALLBACK_ENABLED;
    } finally {
      (globalThis as any).fetch = prevFetch;
      initMod.__setDbForTesting(prevDb);
      if (prevAdminKey === undefined) delete process.env.ADMIN_KEY;
      else process.env.ADMIN_KEY = prevAdminKey;
      if (prevFlag === undefined) delete process.env.HOMEPAGE_PROVENANCE_HEADLESS_FALLBACK_ENABLED;
      else process.env.HOMEPAGE_PROVENANCE_HEADLESS_FALLBACK_ENABLED = prevFlag;
    }

    return { passed, failed, failures };
  })();
}

if (require.main === module) {
  runHomepageProvenanceHeadlessFallbackTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    if (summary.failed > 0) process.exit(1);
  });
}
