/**
 * slik-fungerer-det.test.ts — route-level tests for GET /slik-fungerer-det,
 * the producer-facing "how this platform works" page added for dev-request
 * 2026-08-08-opplevagent-slik-fungerer-det.
 *
 * The page exists because the gårdssalg outreach email points at it (see
 * opplevelser-gardssalg-outreach-pilot-send.test.ts, block h2, which asserts
 * the email carries this exact URL). A cold recipient's first question —
 * "what is this, and how does an AI assistant end up recommending us?" —
 * has to be answerable without replying to ask.
 *
 * Covers:
 *   (a) 200 + every section a producer needs: the discovery flow, where the
 *       profile came from, what claiming gives, how booking works, the legal
 *       context, what's still ahead, the Q&A, and the contact line
 *   (b) SEO: canonical + index,follow + WebPage/BreadcrumbList JSON-LD +
 *       a static sitemap entry
 *   (c) cross-links both ways: /for-tilbydere points here, the NO footer
 *       carries the link, /proveniens and the agent surfaces are linked from
 *       here — and the EN footer does NOT link it (the page is Norwegian; an
 *       EN link would promise a translation that doesn't exist)
 *   (d) HONESTY GUARDS — the assertions most worth having, because they are
 *       what a future edit is most likely to quietly break:
 *         · booking is described as off-by-default and producer-controlled
 *         · the platform is described as handling no payment and taking no cut
 *         · the "profile answers the guest's assistant" capability stays
 *           inside the «På vei» section — it does not exist yet, and must
 *           never be described in the present tense elsewhere on the page
 *         · the legal paragraph stays a description of a PROPOSAL on høring,
 *           not a claim that the law has changed, and disclaims advice
 *   (e) no uninterpolated template placeholder leaks into the HTML
 *
 * Same synthetic invokeRoute harness + in-memory-DB pattern as
 * for-tilbydere.test.ts.
 *
 * Two ways to run:
 *   1. Standalone:  npx tsx src/routes/slik-fungerer-det.test.ts
 *   2. Wired into the gate via tests/test.ts.
 */

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

type InvokeResult = {
  found: boolean;
  handled: boolean;
  status: number;
  body: string;
  headers: Record<string, string>;
};

function invokeRoute(
  router: any,
  routePath: string,
  reqPath: string,
  lang: "no" | "en" = "no",
): InvokeResult {
  const layer = (router.stack as any[]).find(
    (l: any) => l.route && l.route.path === routePath && l.route.methods?.get,
  );
  if (!layer) return { found: false, handled: false, status: 0, body: "", headers: {} };
  let status = 200;
  let body = "";
  let handled = false;
  const headers: Record<string, string> = {};
  const res: any = {
    statusCode: 200,
    setHeader(k: string, v: string) { headers[k.toLowerCase()] = String(v); },
    status(code: number) { status = code; this.statusCode = code; return this; },
    send(b: unknown) { handled = true; body = typeof b === "string" ? b : String(b); return this; },
    redirect(code: number, loc: string) { handled = true; status = code; headers["location"] = loc; return this; },
  };
  const req: any = {
    method: "GET",
    path: reqPath,
    originalUrl: reqPath,
    url: reqPath,
    hostname: "opplevagent.no",
    params: {},
    query: {},
    headers: {},
    lang,
    get() { return undefined; },
  };
  const handler = layer.route.stack[layer.route.stack.length - 1].handle;
  handler(req, res, () => { /* next() */ });
  return { found: true, handled, status, body, headers };
}

function footerBlock(body: string): string {
  const m = body.match(/<footer class="site-footer"[^>]*>([\s\S]*?)<\/footer>/);
  return m ? m[1] : "";
}

/** The markup of one <section> identified by its aria-labelledby id. */
function sectionBlock(body: string, labelId: string): string {
  const re = new RegExp(`<section class="ft-section" aria-labelledby="${labelId}"[^>]*>([\\s\\S]*?)</section>`);
  const m = body.match(re);
  return m ? m[1] : "";
}

function insertProvider(
  db: any,
  p: { id: string; navn: string; producer_type: string | null; rfb_seed_source?: string | null },
): void {
  db.prepare(
    `INSERT INTO experience_providers
       (id, navn, vertical, fylke, kommune, poststed, producer_type, booking_live, catalog_hidden,
        rfb_seed_source, lat, lon, geocode_confidence, slug, enrichment_state, verification_status, source, confidence)
     VALUES
       (?, ?, 'experiences', 'Innlandet', 'Ringsaker', 'Brumunddal', ?, NULL, NULL,
        ?, 60.88, 10.94, 'high', ?, 'raw', 'pending_verify', 'test-fixture', 'medium')`,
  ).run(p.id, p.navn, p.producer_type, p.rfb_seed_source ?? null, p.id);
}

export function runSlikFungererDetTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];

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
    const prevExperiencesDbPath = process.env.EXPERIENCES_DB_PATH;
    process.env.EXPERIENCES_DB_PATH = ":memory:";

    const dbFactoryPath = require.resolve("../database/db-factory");
    const expStorePath = require.resolve("../services/experience-store");
    const seoPath = require.resolve("./experiences-seo");
    const cachePaths = [dbFactoryPath, expStorePath, seoPath];
    for (const p of cachePaths) delete require.cache[p];

    try {
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const db = dbFactory.getDb("experiences");
      require("../services/experience-store");

      // ≥5 visible providers so gardssalgVisible() is satisfied for the
      // landing/footer renders exercised below (same reason as
      // for-tilbydere.test.ts's fixture).
      insertProvider(db, { id: "sf-brygg-1", navn: "Liaberg Bryggeri", producer_type: "bryggeri" });
      insertProvider(db, { id: "sf-brygg-2", navn: "Haugtun Bryggeri", producer_type: "bryggeri" });
      insertProvider(db, { id: "sf-sideri-1", navn: "Eplelund Sideri", producer_type: "sideri" });
      insertProvider(db, { id: "sf-cideri-1", navn: "Hagen Cideri", producer_type: "cideri" });
      insertProvider(db, { id: "sf-mjod-1", navn: "Vollen Mjøderi", producer_type: "mjøderi" });
      insertProvider(db, { id: "sf-null-1", navn: "Seterhagen Gard", producer_type: null, rfb_seed_source: "rfb-seed" });

      const seo = require("./experiences-seo") as typeof import("./experiences-seo");
      const router = (seo as any).default;

      const page = invokeRoute(router, "/slik-fungerer-det", "/slik-fungerer-det");

      // ── (a) the page renders, with every producer-facing section ────────
      assertTrue(
        page.found && page.handled && page.status === 200,
        `a1: GET /slik-fungerer-det renders 200 (found=${page.found} handled=${page.handled} status=${page.status})`,
      );
      assertTrue(page.body.includes("<h1>Slik fungerer Opplevagent</h1>"), "a2: h1 renders");
      assertTrue(sectionBlock(page.body, "sf-flyt-h").length > 0, "a3: the discovery-flow section renders");
      assertTrue(sectionBlock(page.body, "sf-profil-h").length > 0, "a4: the «where the profile came from» section renders");
      assertTrue(sectionBlock(page.body, "sf-overta-h").length > 0, "a5: the «what claiming gives you» section renders");
      assertTrue(sectionBlock(page.body, "sf-booking-h").length > 0, "a6: the booking section renders");
      assertTrue(sectionBlock(page.body, "sf-lov-h").length > 0, "a7: the legal-context section renders");
      assertTrue(sectionBlock(page.body, "sf-paavei-h").length > 0, "a8: the «På vei» section renders");
      assertTrue(sectionBlock(page.body, "sf-sporsmal-h").length > 0, "a9: the Q&A section renders");
      assertTrue(page.body.includes("mailto:kontakt@opplevagent.no"), "a10: the contact address is reachable from the page");
      assertTrue(page.body.includes("Brønnøysundregistrene"), "a11: the profile-source paragraph names Brreg");
      assertTrue(
        sectionBlock(page.body, "sf-overta-h").includes("90 dagene"),
        "a12: the claim benefit describes the visitor stats the owner portal actually shows (90 days)",
      );

      // ── (b) SEO ────────────────────────────────────────────────────────
      assertTrue(
        page.body.includes('<link rel="canonical" href="https://opplevagent.no/slik-fungerer-det">'),
        "b1: self-canonical",
      );
      assertTrue(page.body.includes('<meta name="robots" content="index, follow">'), "b2: index,follow");
      assertTrue(page.body.includes('"@type":"WebPage"'), "b3: WebPage JSON-LD");
      assertTrue(page.body.includes('"@type":"BreadcrumbList"'), "b4: BreadcrumbList JSON-LD");
      assertTrue(
        page.headers["content-type"]?.includes("text/html") === true,
        "b5: text/html content-type",
      );

      const sitemap = invokeRoute(router, "/sitemap.xml", "/sitemap.xml");
      assertTrue(
        sitemap.handled && sitemap.body.includes("https://opplevagent.no/slik-fungerer-det"),
        "b6: the page has a static sitemap entry",
      );

      // ── (c) cross-links ────────────────────────────────────────────────
      const forTilbydere = invokeRoute(router, "/for-tilbydere", "/for-tilbydere");
      assertTrue(
        forTilbydere.handled && forTilbydere.body.includes('href="/slik-fungerer-det"'),
        "c1: /for-tilbydere links here (the producer door points at the explainer)",
      );
      assertTrue(
        footerBlock(page.body).includes('href="/slik-fungerer-det"'),
        "c2: the NO footer carries the link",
      );
      // EN render of the landing page — same mechanism the sibling suite uses
      // for its EN assertions (req.lang is what the /en rewrite stamps).
      const homeNo = invokeRoute(router, "/", "/", "no");
      const homeEn = invokeRoute(router, "/", "/", "en");
      assertTrue(
        homeNo.handled && footerBlock(homeNo.body).includes('href="/slik-fungerer-det"'),
        "c3: the NO landing footer carries the link",
      );
      assertTrue(
        homeEn.handled && !footerBlock(homeEn.body).includes('href="/slik-fungerer-det"'),
        "c3b: the EN landing footer does NOT link a Norwegian-only page",
      );
      assertTrue(page.body.includes('href="/proveniens"'), "c4: links to the provenance page rather than restating it");
      assertTrue(page.body.includes('href="/for-tilbydere"'), "c5: links back to the claim door");
      assertTrue(
        page.body.includes('href="/mcp"') && page.body.includes('href="/llms.txt"'),
        "c6: the agent surfaces are linked once, at the end",
      );

      // ── (d) honesty guards ─────────────────────────────────────────────
      const booking = sectionBlock(page.body, "sf-booking-h");
      assertTrue(
        booking.includes("avslått som standard"),
        "d1: booking is described as OFF by default (it is: booking_live defaults to not-1)",
      );
      assertTrue(
        booking.includes("bekrefter selv") || booking.includes("bekrefter hver"),
        "d2: booking is described as producer-confirmed, never auto-accepted",
      );
      assertTrue(
        booking.includes("håndterer ikke betaling"),
        "d3: the page states the platform handles no payment (it doesn't) — a claim a future edit must not quietly drop",
      );

      const paaVei = sectionBlock(page.body, "sf-paavei-h");
      assertTrue(
        paaVei.includes("svare på spørsmål fra gjestens assistent") || paaVei.includes("svare"),
        "d4: the not-yet-built «profile answers the guest's assistant» capability lives in the «På vei» section",
      );
      // The same capability must NOT be asserted as present-tense fact in the
      // flow section, which describes what happens TODAY.
      const flyt = sectionBlock(page.body, "sf-flyt-h");
      assertTrue(
        !/profilen (deres )?svarer/i.test(flyt),
        "d5: the discovery-flow section does not claim the profile already answers assistants",
      );

      const lov = sectionBlock(page.body, "sf-lov-h");
      assertTrue(lov.includes("på høring"), "d6: the legal paragraph says the change is a PROPOSAL on høring");
      assertTrue(lov.includes("5. september 2026"), "d7: the høringsfrist is stated precisely");
      assertTrue(
        lov.includes("ikke juridisk rådgivning"),
        "d8: the legal paragraph disclaims being legal advice",
      );
      assertTrue(
        !/loven er endret|nå lov å selge|er blitt lov/i.test(page.body),
        "d9: nowhere does the page claim the law has already changed",
      );
      assertTrue(
        !/vi selger alkohol|kjøp direkte her/i.test(page.body),
        "d10: the page never positions Opplevagent as an alcohol seller",
      );

      // ── (e) no template leakage ────────────────────────────────────────
      assertTrue(!page.body.includes("${"), "e1: no uninterpolated ${…} placeholder in the HTML");
      assertTrue(!page.body.includes("undefined"), "e2: no literal 'undefined' leaked into the HTML");
    } catch (err: any) {
      failed++;
      failures.push("slik-fungerer-det: unexpected error: " + String(err?.stack || err?.message || err));
    } finally {
      if (prevExperiencesDbPath === undefined) {
        delete process.env.EXPERIENCES_DB_PATH;
      } else {
        process.env.EXPERIENCES_DB_PATH = prevExperiencesDbPath;
      }
      try {
        const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
        dbFactory.__resetDbFactoryForTesting();
      } catch {
        // best-effort cleanup
      }
      for (const p of cachePaths) delete require.cache[p];
    }

    return { passed, failed, failures };
  })();
}

if (require.main === module) {
  runSlikFungererDetTests({ log: true }).then((result) => {
    console.log(`\n${result.passed} passed, ${result.failed} failed`);
    // Explicit exit: loading the seo module leaves live handles behind.
    process.exit(result.failed > 0 ? 1 : 0);
  });
}
