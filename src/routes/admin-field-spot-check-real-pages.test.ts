/**
 * admin-field-spot-check-real-pages.test.ts — POST /admin/field-spot-check
 * against REAL producer pages (W40 false-positive fix).
 *
 * Background: the 2026-W40 RFB enrichment spot-check reported 14/26 field
 * mismatches (53.85%; > 10% auto-pauses all RFB enrichment writes). An
 * independent re-evaluation found only 2 real data errors — the other 12
 * were this route judging or fetching wrongly. This file drives the route
 * end-to-end over the real pages behind those cases:
 *   - about:   write-guard check first, fact-level check as an extra chance
 *              (Aukrust verbatim <br>-formatted paragraph; Oceanfood 88%
 *              overlap) — and the fact-level check alone now also accepts
 *              the Aukrust paragraph (its <br> lines are one block).
 *   - subpage: prefixed about/contact + terms/privacy subpages followed
 *              (Ødhumbla phone on /contact-1, Aalan address on
 *              /kontakt-oss-2/, Borgund address on /salsvilkar).
 *   - address: street + house number + postal code, structurally.
 * And the NEGATIVE controls that must stay mismatches: 4 fabricated about
 * texts built from real tokens of the same sites, Kvestad's stored road
 * designation "Fv109, 5776 Nå" vs the page's "Reisetevegen 83", Aalan's
 * invented phone number, a wrong house number.
 *
 * Fixtures (tests/fixtures/field-spot-check/*.html): the real pages fetched
 * 2026-10-04 (aukrust-nordgard.no, oceanfood.no, borgundchili.no,
 * oedhumbla.no, aalan.no, kvestadsideri.no, saltfjellrein.no), TRIMMED:
 * script/style/svg/noscript/iframe/form/img/link elements, comments, non-
 * description <meta> tags and all attributes except href/content/name/
 * property removed; the borgundchili.no terms page cut after section 6 of
 * its standard terms text; oceanfood.no's team bios and document list
 * removed. Personal data removed: named individuals and their own phone
 * numbers/e-mails (owner/staff names on aukrust, oedhumbla, aalan, kvestad,
 * saltfjellrein, oceanfood) — only business contact details already public
 * on the sites remain. Block-level structure, <br> line breaks, nav links
 * and all page text the assertions depend on are left exactly as served.
 *
 * Harness: same conventions as admin-field-spot-check.test.ts (in-memory DB
 * via __setDbForTesting/__initSchemaForTesting, router.handle, a
 * globalThis.fetch stub that serves the fixtures by URL and 404s anything
 * else, restored in `finally`).
 *
 * Exported runAdminFieldSpotCheckRealPagesTests({log}) -> Promise<TestSummary>;
 * wired into tests/test.ts.
 * Standalone: npx tsx src/routes/admin-field-spot-check-real-pages.test.ts
 */

import Database from "better-sqlite3";
import { readFileSync } from "fs";
import { join } from "path";
import * as initMod from "../database/init";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

interface RouteResult {
  status: number;
  body: any;
}

const FIXTURE_DIR = join(__dirname, "..", "..", "tests", "fixtures", "field-spot-check");

function fixture(name: string): string {
  return readFileSync(join(FIXTURE_DIR, name), "utf8");
}

function callRoute(router: any, headers: Record<string, string>, body: any): Promise<RouteResult> {
  return new Promise((resolve) => {
    const req: any = {
      method: "POST",
      url: "/",
      originalUrl: "/",
      query: {},
      headers,
      body,
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
        resolve({ status: this.statusCode, body: payload });
        return this;
      },
      end() {
        resolve({ status: this.statusCode, body: undefined });
        return this;
      },
    };
    router.handle(req, res, (err?: any) => {
      resolve({ status: err ? 500 : 0, body: err ? { error: String(err) } : undefined });
    });
  });
}

/** `finalUrl` simulates a redirect (fetchPage reads Response.url), e.g.
 *  oedhumbla.no -> www.oedhumbla.no, exactly as the live sites answer. */
function htmlResponse(status: number, body: string, finalUrl = ""): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Not Found",
    url: finalUrl,
    headers: { get: (h: string) => (h.toLowerCase() === "content-type" ? "text/html; charset=utf-8" : null) } as unknown as Headers,
    arrayBuffer: async () => new TextEncoder().encode(body).buffer,
    text: async () => body,
  } as unknown as Response;
}

// URL -> [fixture file, final URL after redirects]. Anything not listed is a
// 404 (e.g. borgundchili.no/personvern, aalan.no/personvernerklaering/,
// saltfjellrein.no/om-oss/ — not needed for any assertion).
const PAGES: Record<string, [string, string?]> = {
  "https://aukrust-nordgard.no/": ["aukrust-root.html"],
  "https://aukrust-nordgard.no/kontakt/": ["aukrust-kontakt.html"],
  "https://oceanfood.no": ["oceanfood-root.html", "https://www.oceanfood.no/"],
  "https://www.borgundchili.no": ["borgund-root.html", "https://www.borgundchili.no/"],
  "https://www.borgundchili.no/om-oss": ["borgund-om-oss.html"],
  "https://www.borgundchili.no/salsvilkar": ["borgund-salsvilkar.html"],
  "https://oedhumbla.no": ["odhumbla-root.html", "https://www.oedhumbla.no"],
  "https://www.oedhumbla.no/about-1": ["odhumbla-about-1.html"],
  "https://www.oedhumbla.no/contact-1": ["odhumbla-contact-1.html"],
  "https://www.aalan.no": ["aalan-root.html", "https://aalan.no/"],
  "https://aalan.no/kontakt-oss-2/": ["aalan-kontakt-oss-2.html"],
  "https://www.kvestadsideri.no": ["kvestad-root.html", "https://www.kvestadsideri.no/"],
  "https://saltfjellrein.no/": ["saltfjell-root.html"],
};

// Stored values as of 2026-10-04 (GET /admin agent info) unless noted.
const AUKRUST_ABOUT =
  "Aukrust Gard og Urteri ligg i Lom, ved foten av Lomseggen (2068 moh). Solrike dagar og tørt klima gjev plantene kraft og aroma. Vårt slagord: Å foreine det nyttige og det vakre!";
const OCEANFOOD_ABOUT =
  "Oceanfood AS dyrker og videreforedler sukkertare fra Arktis, i Tromsø. Produktene brukes til mat, industri, gjødsel, biostimuli og fôr til husdyr og akvakultur. Økologisk sertifisert (Debio).";

// Fabricated about texts: each borrows the site's real name and real place
// tokens from the same page, the shape a hallucinating extractor produces.
const NEG_ABOUT: Record<string, string> = {
  aukrust:
    "Aukrust Gard og Urteri i Lom vart grunnlagt i 1450 av Kari Nordmann, som dreiv reinsdyrslakteri ved Lomseggen fram til 1990.",
  borgund:
    "Borgund Chili vart starta i 1998 av Ola Hansen i Romania, og har sidan eksportert til Tyskland og Japan.",
  saltfjell:
    "Saltfjell Reinprodukter er eit økologisk Debio-sertifisert meieri i Bodø som lagar geitost frå Saltfjellet sidan 1952.",
  oceanfood:
    "Oceanfood AS driv lakseoppdrett i Lofoten og sel røykt laks til Japan; selskapet vart etablert i 1985 av Hans Olsen.",
};

export async function runAdminFieldSpotCheckRealPagesTests(
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

  function assertTrue(cond: boolean, label: string, detail = ""): void {
    if (cond) {
      passed++;
      if (log) console.log(`  ok ${label}`);
    } else {
      failed++;
      const msg = `✗ ${label}${detail ? `\n    ${detail}` : ""}`;
      failures.push(msg);
      if (log) console.log("  " + msg);
    }
  }

  const prevDb = initMod.getDb();
  const prevAdminKey = process.env.ADMIN_KEY;
  const testKey = "field-spot-check-real-pages-test-key";
  process.env.ADMIN_KEY = testKey;
  const prevFetch = (globalThis as any).fetch;
  const fetched: string[] = [];

  const db = new Database(":memory:");
  try {
    initMod.__setDbForTesting(db as any);
    initMod.__initSchemaForTesting(db as any);

    const insertAgent = db.prepare(
      `INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, claimed_at)
       VALUES (?, ?, 'test agent', 'test', 'x@example.com', ?, 'producer', ?, NULL)`,
    );
    const insertKnowledge = db.prepare(
      `INSERT INTO agent_knowledge (agent_id, website, about, phone, address, verification_status, curated_fields)
       VALUES (?, ?, ?, ?, ?, 'verified', '{}')`,
    );
    function seed(id: string, name: string, website: string, k: { about?: string; phone?: string; address?: string }): void {
      insertAgent.run(id, name, website, `key-${id}`);
      insertKnowledge.run(id, website, k.about ?? null, k.phone ?? null, k.address ?? null);
    }

    seed("rp-aukrust", "Aukrust Gard og Urteri", "https://aukrust-nordgard.no/", { about: AUKRUST_ABOUT });
    seed("rp-aukrust-neg", "Aukrust Gard og Urteri", "https://aukrust-nordgard.no/", { about: NEG_ABOUT.aukrust });
    seed("rp-oceanfood", "Oceanfood", "https://oceanfood.no", { about: OCEANFOOD_ABOUT });
    seed("rp-oceanfood-neg", "Oceanfood", "https://oceanfood.no", { about: NEG_ABOUT.oceanfood });
    seed("rp-borgund", "Borgund Chili", "https://www.borgundchili.no", {
      address: "Vindhella 717, 6888 Borgund",
      about: NEG_ABOUT.borgund,
    });
    seed("rp-borgund-wrongnr", "Borgund Chili", "https://www.borgundchili.no", { address: "Vindhella 771, 6888 Borgund" });
    seed("rp-odhumbla", "Ødhumbla Gardsmjølk", "https://oedhumbla.no", { phone: "+47 975 29 466" });
    seed("rp-aalan", "Aalan Gård", "https://www.aalan.no", {
      address: "Lauvdalen 186, 8360 Bøstad",
      phone: "+47 76 08 45 34", // stored value: on none of the site's pages (real data error)
    });
    seed("rp-aalan-w40", "Aalan Gård", "https://www.aalan.no", { address: "www.aalan.no - Lauvdalen 186, 8360 Bøstad" });
    seed("rp-kvestad", "Kvestad Sideri", "https://www.kvestadsideri.no", { address: "Fv109, 5776 Nå" });
    seed("rp-kvestad-real", "Kvestad Sideri", "https://www.kvestadsideri.no", { address: "Reisetevegen 83, 5776 Nå" });
    seed("rp-saltfjell-neg", "Saltfjell Reinprodukter", "https://saltfjellrein.no/", { about: NEG_ABOUT.saltfjell });

    (globalThis as any).fetch = (async (url: string | URL | Request) => {
      const u = String(url);
      fetched.push(u);
      const page = PAGES[u];
      if (!page) return htmlResponse(404, "<html><body>Not found</body></html>");
      return htmlResponse(200, fixture(page[0]), page[1] ?? "");
    }) as unknown as typeof fetch;

    delete require.cache[require.resolve("./admin-field-spot-check")];
    const routeMod = require("./admin-field-spot-check");
    const router = routeMod.default;
    const headers = { "x-admin-key": testKey, "content-type": "application/json" };
    const spotCheck = async (agent_id: string, field_name: string) => {
      fetched.length = 0;
      return callRoute(router, headers, { agent_id, field_name });
    };

    // ── about: write-guard first, fact-level as extra chance (b1) ─────────
    let r = await spotCheck("rp-aukrust", "about");
    assertEq(r.status, 200, "rp-about-01: Aukrust about -> 200");
    assertEq(r.body?.status, "match", "rp-about-02: Aukrust stored about (verbatim <br>-formatted paragraph on root) -> match");
    assertEq(r.body?.checked_url, "https://aukrust-nordgard.no/", "rp-about-03: Aukrust matched on the root page itself");
    assertTrue(/^write-guard check: candidate text found verbatim/.test(String(r.body?.reason)),
      "rp-about-04: Aukrust match comes from the write-guard's verbatim branch", String(r.body?.reason));

    r = await spotCheck("rp-oceanfood", "about");
    assertEq(r.body?.status, "match", "rp-about-05: Oceanfood stored about (88% significant-word overlap) -> match");
    assertTrue(/^write-guard check: close paraphrase: 14\/16 significant words \(88%\)/.test(String(r.body?.reason)),
      "rp-about-06: Oceanfood match is the write-guard's 14/16 (88%) close-paraphrase branch", String(r.body?.reason));
    assertEq(r.body?.checked_url, "https://www.oceanfood.no/", "rp-about-07: Oceanfood checked_url is the post-redirect root");

    // The <br> structural fix on its own: the fact-level check now accepts
    // the verbatim Aukrust paragraph (its one-sentence-per-line <br> lines
    // form ONE block), where it used to reject it.
    {
      const { checkAboutCandidateFactSubstantiated } =
        require("../services/about-fact-substantiation") as typeof import("../services/about-fact-substantiation");
      const { visibleTextOf } = require("../services/fetch-page") as typeof import("../services/fetch-page");
      const html = fixture("aukrust-root.html");
      const v = checkAboutCandidateFactSubstantiated(AUKRUST_ABOUT, `${html}\n${visibleTextOf(html)}`);
      assertEq(v.substantiated, true, "rp-about-08: fact-level check alone accepts the verbatim Aukrust paragraph (<br> lines = one block)");
      assertTrue(/4\/4 distinct facts/.test(v.reason), "rp-about-09: all 4 Aukrust facts (gard, urteri, lomseggen, 2068) locally corroborated", v.reason);
    }

    // NEGATIVE controls: fabricated about texts -> mismatch, with every
    // reachable page actually tried (not unverifiable, not a lucky match).
    r = await spotCheck("rp-aukrust-neg", "about");
    assertEq(r.body?.status, "mismatch", "rp-about-neg-01: fabricated Aukrust founding story -> mismatch");
    assertEq(r.body?.urls_tried, ["https://aukrust-nordgard.no/", "https://aukrust-nordgard.no/kontakt/"],
      "rp-about-neg-02: Aukrust root + /kontakt/ both tried (/omvisning-servering/ is not an about page)");
    r = await spotCheck("rp-borgund", "about");
    assertEq(r.body?.status, "mismatch", "rp-about-neg-03: fabricated Borgund Chili story (real 'Romania' token) -> mismatch");
    r = await spotCheck("rp-saltfjell-neg", "about");
    assertEq(r.body?.status, "mismatch", "rp-about-neg-04: fabricated Saltfjell 'Debio dairy' story -> mismatch");
    r = await spotCheck("rp-oceanfood-neg", "about");
    assertEq(r.body?.status, "mismatch", "rp-about-neg-05: fabricated Oceanfood salmon-farming story -> mismatch");
    assertTrue(/write-guard check: .*\| fact-level check: /.test(String(r.body?.reason)),
      "rp-about-neg-06: a mismatch reports BOTH checks' reasons", String(r.body?.reason));

    // ── subpages (b3) ──────────────────────────────────────────────────────
    r = await spotCheck("rp-odhumbla", "phone");
    assertEq(r.body?.status, "match", "rp-sub-01: Ødhumbla phone found on /contact-1 -> match");
    assertEq(r.body?.checked_url, "https://www.oedhumbla.no/contact-1", "rp-sub-02: checked_url stamped to /contact-1");
    assertEq(r.body?.urls_tried, ["https://oedhumbla.no", "https://www.oedhumbla.no/about-1", "https://www.oedhumbla.no/contact-1"],
      "rp-sub-03: root (redirected to www) then /about-1, /contact-1 (same host as the post-redirect root)");

    r = await spotCheck("rp-aalan", "address");
    assertEq(r.body?.status, "match", "rp-sub-04: Aalan address found on /kontakt-oss-2/ -> match");
    assertEq(r.body?.checked_url, "https://aalan.no/kontakt-oss-2/", "rp-sub-05: checked_url stamped to /kontakt-oss-2/");
    assertTrue(/postal code 8360/.test(String(r.body?.reason)), "rp-sub-06: matched on street + number + postal code", String(r.body?.reason));

    r = await spotCheck("rp-aalan-w40", "address");
    assertEq(r.body?.status, "match", "rp-sub-07: Aalan W40 stored form 'www.aalan.no - Lauvdalen 186, 8360 Bøstad' -> match (URL prefix ignored)");

    r = await spotCheck("rp-borgund", "address");
    assertEq(r.body?.status, "match", "rp-sub-08: Borgund address found on /salsvilkar -> match");
    assertEq(r.body?.checked_url, "https://www.borgundchili.no/salsvilkar", "rp-sub-09: checked_url stamped to /salsvilkar");
    assertEq(
      r.body?.urls_tried,
      [
        "https://www.borgundchili.no",
        "https://www.borgundchili.no/om-oss",
        "https://www.borgundchili.no/personvern",
        "https://www.borgundchili.no/salsvilkar",
      ],
      "rp-sub-10: about page first, then the terms/privacy pages in document order (dead /personvern does not stop the walk)",
    );
    assertTrue(/no postal code next to it/.test(String(r.body?.reason)),
      "rp-sub-11: terms page gives 'Vindhella 717' without a postal code -> street + number decide", String(r.body?.reason));

    // ── address NEGATIVE controls (b4) ─────────────────────────────────────
    r = await spotCheck("rp-kvestad", "address");
    assertEq(r.body?.status, "mismatch", "rp-addr-neg-01: Kvestad stored 'Fv109, 5776 Nå' vs page 'Reisetevegen 83, N-5776 NÅ' -> mismatch");
    assertTrue(/no street \+ house number/.test(String(r.body?.reason)),
      "rp-addr-neg-02: road designation has no house number -> not structurally comparable, text check rejects", String(r.body?.reason));
    r = await spotCheck("rp-kvestad-real", "address");
    assertEq(r.body?.status, "match", "rp-addr-03 (control): the page's own 'Reisetevegen 83' -> match");
    r = await spotCheck("rp-borgund-wrongnr", "address");
    assertEq(r.body?.status, "mismatch", "rp-addr-neg-04: right street, wrong house number (771 vs 717) -> mismatch");

    r = await spotCheck("rp-aalan", "phone");
    assertEq(r.body?.status, "mismatch", "rp-phone-neg-01: Aalan invented phone +47 76 08 45 34 -> mismatch");
    assertEq(r.body?.urls_tried, ["https://www.aalan.no", "https://aalan.no/kontakt-oss-2/", "https://aalan.no/personvernerklaering/"],
      "rp-phone-neg-02: root, contact page and privacy page all tried before concluding mismatch");

    // Every fetch stayed on the producer's own hosts (no other domain was
    // ever requested, whatever the pages link to).
    assertTrue(fetched.every((u) => /^https:\/\/(?:www\.)?aalan\.no\b/.test(u)),
      "rp-host-01: the last spot-check fetched only the producer's own host", fetched.join(", "));
  } catch (err: any) {
    failed++;
    failures.push("admin-field-spot-check-real-pages: unexpected error: " + String(err?.stack || err?.message || err));
  } finally {
    (globalThis as any).fetch = prevFetch;
    initMod.__setDbForTesting(prevDb as any);
    if (prevAdminKey === undefined) delete process.env.ADMIN_KEY;
    else process.env.ADMIN_KEY = prevAdminKey;
    delete require.cache[require.resolve("./admin-field-spot-check")];
  }

  return { passed, failed, failures };
}

if (require.main === module) {
  runAdminFieldSpotCheckRealPagesTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    if (summary.failed > 0) process.exit(1);
  });
}
