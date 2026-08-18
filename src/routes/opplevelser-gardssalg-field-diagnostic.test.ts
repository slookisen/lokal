/**
 * opplevelser-gardssalg-field-diagnostic.test.ts — tests for dev-request
 * 2026-08-17-berikelse-uttrekk-evidence-url-og-render, Skive 3, AC4:
 * POST /admin/gardssalg-content-refresh's new `field_diagnostic` array — a
 * per-row, per-field WHY for about_text/visit_text/opening_hours_text/
 * products, mirroring what `products_diagnostic` already did for `products`
 * alone. Purely additive/reporting — asserts NOTHING about what gets
 * written (see opplevelser-gardssalg-fillblank.test.ts /
 * opplevelser-gardssalg-products.test.ts for the write-path coverage).
 *
 * Mirrors those files' setup convention exactly (EXPERIENCES_DB_PATH=
 * ":memory:", fresh require of db-factory + experience-store + opplevelser
 * router per run, callRoute() exercised directly against router.handle())
 * and mocks globalThis.fetch for BOTH the page-content crawl
 * (crFetchGardssalgContent, keyed by hostname/pathname) AND the Anthropic
 * API call (keyed by a marker string in the prompt — "kvalitetsdommer" for
 * the quality judge, "Lag en liste over produkter" for the products
 * generator, anything else for the about-text fill-from-source path).
 */

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

interface RouteResult {
  status: number;
  body: any;
}

function callRoute(
  router: any,
  opts: {
    method?: "GET" | "POST";
    url?: string;
    headers?: Record<string, string>;
    body?: any;
  } = {},
): Promise<RouteResult> {
  return new Promise((resolve) => {
    const method = opts.method || "POST";
    const url = opts.url || "/admin/gardssalg-content-refresh";
    const req: any = {
      method,
      url,
      originalUrl: url,
      path: url,
      query: {},
      headers: opts.headers || {},
      body: opts.body ?? {},
      get() { return undefined; },
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
    };
    router.handle(req, res, (err?: any) => {
      if (err) resolve({ status: 500, body: { error: String(err) } });
    });
  });
}

export function runOpplevelserGardssalgFieldDiagnosticTests(
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
    const prevExperiencesDbPath = process.env.EXPERIENCES_DB_PATH;
    const prevAdminKey = process.env.ADMIN_KEY;
    const prevAnthropicKey = process.env.ANTHROPIC_API_KEY;
    const prevFetch = globalThis.fetch;
    const testKey = process.env.ADMIN_KEY || "gardssalg-field-diag-test-key";
    process.env.EXPERIENCES_DB_PATH = ":memory:";
    process.env.ADMIN_KEY = testKey;
    process.env.ANTHROPIC_API_KEY = "test-anthropic-key-field-diag";

    const dbFactoryPath = require.resolve("../database/db-factory");
    const experienceStorePath = require.resolve("../services/experience-store");
    const opplevelserPath = require.resolve("./opplevelser");
    const cachePaths = [dbFactoryPath, experienceStorePath, opplevelserPath];
    for (const p of cachePaths) delete require.cache[p];

    try {
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const expDb = dbFactory.getDb("experiences");
      const opplevelserRouter = (require("./opplevelser") as typeof import("./opplevelser")).default as any;

      const insertProviderStmt = expDb.prepare(
        `INSERT INTO experience_providers
           (id, navn, vertical, hjemmeside, content_source, about_text, visit_text, opening_hours_text, products, field_provenance,
            producer_type, enrichment_state, verification_status, source, confidence)
         VALUES
           (@id, @navn, 'experiences', @hjemmeside, @content_source, @about_text, @visit_text, @opening_hours_text, @products, @field_provenance,
            'cideri', 'raw', 'pending_verify', 'test-fixture', 'medium')`,
      );
      const VERIFIED_PROVENANCE = JSON.stringify({
        hjemmeside_verification: { verified: true, classification: "verified", checked_at: "2026-01-01T00:00:00.000Z" },
      });
      const insertProvider = {
        run(params: Record<string, unknown>): void {
          insertProviderStmt.run({ field_provenance: VERIFIED_PROVENANCE, ...params });
        },
      };

      function getFieldDiag(body: any, providerId: string): any {
        return body.field_diagnostic.find((d: any) => d.provider_id === providerId);
      }
      function getProductsDiag(body: any, providerId: string): any {
        return body.products_diagnostic.find((d: any) => d.provider_id === providerId);
      }

      // A long, real-Norwegian, cheap-bar-passing paragraph — never eligible
      // for fill/replace/rewrite, used wherever a row needs a current field
      // value that is already "good" (>=200 chars, real prose).
      // Deliberately free of every VISIT_KEYWORDS substring (search-enrich.ts)
      // — used verbatim as row A's homepage prose, and summarizeVisit()
      // scans the WHOLE combined page text for the first keyword-bearing
      // sentence regardless of which paragraph it lives in, so a stray
      // "gårdsbutikk"/"besøk" here would have summarizeVisit() pick THIS
      // sentence instead of the actual visit-copy paragraph below it.
      const GOOD_ABOUT =
        "Familiedrevet gård på Toten som i fire generasjoner har dyrket poteter, gulrøtter og bær, og som selger alt direkte fra egen gård hver lørdag om sommeren. Gården ligger vakkert til med utsikt over Mjøsa, og tar imot gjester gjennom hele sesongen.";
      const GOOD_VISIT =
        "Besøkende er velkomne til omvisning og smaking i låven hver lørdag klokken elleve til fire, med egen guiding av gårdens eierfamilie og mulighet for å kjøpe med seg varer hjem fra gårdsbutikken etterpå.";
      assertTrue(GOOD_ABOUT.length >= 200, "sanity: GOOD_ABOUT is >=200 chars");
      assertTrue(GOOD_VISIT.length >= 200, "sanity: GOOD_VISIT is >=200 chars");

      // Unique marker embedded ONLY in the row-C candidate og:description —
      // the shared judge mock rejects any candidate carrying it, approves
      // everything else. Keeps judge behavior deterministic without needing
      // per-row fetch-mock branching for the Anthropic endpoint.
      const REJECT_MARKER = "ZZZ_FIELDDIAG_REJECT_ZZZ";
      // Unique marker embedded ONLY in row A's homepage text — the shared
      // products mock returns a real product list when the kildetekst
      // contains it, and the sentinel ("no products") otherwise.
      const PRODUCTS_FOUND_MARKER = "Vi selger Eplesider og Eplemost rett fra gården.";

      // ── Page fixtures ──────────────────────────────────────────────────
      // Row A ("prov-fd-filled"): opening-hours snippet present (weekday +
      // time), homepage otherwise minimal. about_text/visit_text current
      // values are already GOOD, so those two fields resolve to
      // "already_present" as a side effect (not this row's assertion focus).
      const pageFilled =
        `<html><body><p>${GOOD_ABOUT}</p><p>${GOOD_VISIT}</p>` +
        `<p>Åpningstider: mandag-fredag 10-18, lørdag 10-15.</p>` +
        `<p>${PRODUCTS_FOUND_MARKER}</p></body></html>`;

      // Row B ("prov-fd-nocandidate"): nav-only chrome, no prose paragraph
      // anywhere and no weekday/time pattern — extractProseText strips the
      // nav entirely (blank about/visit summaries), and there is no
      // opening-hours signal either. The nav itself carries enough VISIBLE
      // text (unfiltered by extractVisibleText) to keep contentText well
      // above the near-empty floor, so this exercises no_candidate_section,
      // not fetch_empty.
      const pageNoCandidate =
        `<html><body><nav>` +
        `<a href="/">Hjem</a> <a href="/om">Om oss</a> <a href="/kontakt">Kontakt</a> ` +
        `<a href="/produkter">Produkter</a> <a href="/apningstider">Åpningstider</a> ` +
        `<a href="/nyheter">Nyheter</a> <a href="/personvern">Personvern</a>` +
        `</nav></body></html>`;

      // Row C ("prov-fd-belowbar"): a rich og:description (>=80 chars, clears
      // the cheap bar so the judge is actually invoked) carrying REJECT_
      // MARKER, so the extractive about_text candidate is judge-rejected.
      const belowBarAboutDesc =
        `En lang og fyldig tekst om gården som beskriver produksjonen i detalj, men som dessverre inneholder ${REJECT_MARKER} og derfor skal avvises av dommeren.`;
      const pageBelowBar =
        `<html><head><meta property="og:description" content="${belowBarAboutDesc}"></head>` +
        `<body><p>Ingenting mer å se her.</p></body></html>`;

      // Row D ("prov-fd-present"): a DIFFERENT good og:description (about)
      // and a visit-keyword paragraph (visit) + an hours snippet — all three
      // extract to real, judge-approved candidates, but every current DB
      // value is already good/non-blank, so nothing gets written and every
      // field resolves to already_present.
      const presentAboutDesc =
        "En annen fyldig og informativ tekst om gårdens historie og produksjon, skrevet spesifikt om denne produsenten og ingen andre, uten noen navigasjonsmeny eller reklame.";
      const pagePresent =
        `<html><head><meta property="og:description" content="${presentAboutDesc}"></head>` +
        `<body><p>Kom innom for omvisning og smaking i gårdsbutikken hver helg gjennom hele sommeren og høsten, med egen guiding fra familien selv.</p>` +
        `<p>Åpningstider: lørdag 10-16, søndag 11-15.</p></body></html>`;

      // Row E ("prov-fd-fetchempty"): a genuinely empty document — no text
      // at all once tags are stripped.
      const pageFetchEmpty = `<html><head></head><body></body></html>`;

      // Row G ("prov-fd-alreadygood-navonly"): fix-up regression case
      // (independent review of 97596a7) — reproduces the reviewer's exact
      // repro shape. Current DB values for about_text/visit_text/
      // opening_hours_text are ALL already good/non-blank (same GOOD_ABOUT/
      // GOOD_VISIT/hours string as rows A/D), but THIS crawl's homepage is
      // nav-only chrome (byte-identical fixture to row B's pageNoCandidate)
      // — no prose paragraph, no weekday/time pattern, so raw extraction
      // (aboutSummary/visitSummary/hoursSnippet) comes back blank for all
      // three fields. Before the fix, that blank-raw-extraction check ran
      // BEFORE the current-value check, so all three wrongly resolved to
      // no_candidate_section (reading as "no such section exists for this
      // provider at all") even though the fields are fine and there was
      // nothing to improve on. The fix checks the current DB value first —
      // all three must resolve to already_present, and nothing should be
      // written (changed[] must stay empty for this row), confirming the
      // write path itself was never the bug.
      insertProvider.run({
        id: "prov-fd-alreadygood-navonly", navn: "Prov Fd Alreadygood Navonly Gard",
        hjemmeside: "https://prov-fd-alreadygood-navonly.example.no",
        content_source: null, about_text: GOOD_ABOUT, visit_text: GOOD_VISIT, opening_hours_text: "Man-fre 10-17",
        products: JSON.stringify(["Eksisterende produkt"]),
      });

      insertProvider.run({
        id: "prov-fd-filled", navn: "Prov Fd Filled Gard", hjemmeside: "https://prov-fd-filled.example.no",
        content_source: null, about_text: GOOD_ABOUT, visit_text: GOOD_VISIT, opening_hours_text: null,
        products: JSON.stringify(["Eksisterende produkt"]),
      });
      insertProvider.run({
        // about_text was "x" (a non-blank, single-char placeholder) before
        // the fix-up (independent review of 97596a7): the pre-fix diagnostic
        // never looked at the current DB value at all, so it made no
        // difference whether about_text was "x" or null here — only the raw
        // extraction mattered. Post-fix, the current value IS checked first,
        // and "x" is technically non-blank, so it would now wrongly resolve
        // to already_present instead of exercising the no_candidate_section
        // branch this row exists to test. null restores this row's actual
        // intent: a genuinely blank current field with a blank raw
        // extraction. Doesn't change wouldWriteActions either way (no
        // candidate -> gardssalgReplaceableFieldAction returns null
        // regardless of currentValue), so fd-B8 (changed[] empty) is
        // unaffected.
        id: "prov-fd-nocandidate", navn: "Prov Fd Nocandidate Gard", hjemmeside: "https://prov-fd-nocandidate.example.no",
        content_source: null, about_text: null, visit_text: null, opening_hours_text: null, products: null,
      });
      insertProvider.run({
        // Same fix-up as prov-fd-nocandidate above: about_text/visit_text
        // were "x" before the fix, which now (correctly, per the current-
        // value check) resolves to already_present rather than exercising
        // the below_quality_bar branch this row exists to test. null
        // restores the original intent (blank current, non-blank raw
        // extraction that fails the judge). No effect on the write path
        // (fd-C3) — the judge-rejected candidate still writes nothing
        // regardless of currentValue.
        id: "prov-fd-belowbar", navn: "Prov Fd Belowbar Gard", hjemmeside: "https://prov-fd-belowbar.example.no",
        content_source: null, about_text: null, visit_text: null, opening_hours_text: null,
        products: JSON.stringify(["Eksisterende produkt"]),
      });
      insertProvider.run({
        id: "prov-fd-present", navn: "Prov Fd Present Gard", hjemmeside: "https://prov-fd-present.example.no",
        content_source: null, about_text: GOOD_ABOUT, visit_text: GOOD_VISIT, opening_hours_text: "Man-fre 10-17",
        products: JSON.stringify(["Eksisterende produkt"]),
      });
      insertProvider.run({
        id: "prov-fd-fetchempty", navn: "Prov Fd Fetchempty Gard", hjemmeside: "https://prov-fd-fetchempty.example.no",
        content_source: null, about_text: "x", visit_text: null, opening_hours_text: null,
        products: JSON.stringify(["Eksisterende produkt"]),
      });

      globalThis.fetch = (async (url: string | URL | Request, init?: any) => {
        const urlStr = String(url);
        if (urlStr.includes("api.anthropic.com")) {
          const body = init?.body ? JSON.parse(init.body) : {};
          const prompt: string = body?.messages?.[0]?.content ?? "";
          if (prompt.includes("kvalitetsdommer")) {
            // Quality-judge call: reject only the row-C candidate, approve
            // everything else — see REJECT_MARKER's comment above.
            if (prompt.includes(REJECT_MARKER)) {
              return {
                ok: true, status: 200,
                json: async () => ({ content: [{ type: "text", text: "AVVIS\nInneholder avvist markør." }] }),
              } as unknown as Response;
            }
            return {
              ok: true, status: 200,
              json: async () => ({ content: [{ type: "text", text: "GODKJENN\nRen, konkret prosa om produsenten." }] }),
            } as unknown as Response;
          }
          if (prompt.includes("Lag en liste over produkter")) {
            // Products generator call: return a real list only for the
            // fixture carrying PRODUCTS_FOUND_MARKER; sentinel otherwise.
            if (prompt.includes(PRODUCTS_FOUND_MARKER)) {
              return {
                ok: true, status: 200,
                json: async () => ({ content: [{ type: "text", text: JSON.stringify(["Eplesider", "Eplemost"]) }] }),
              } as unknown as Response;
            }
            return {
              ok: true, status: 200,
              json: async () => ({ content: [{ type: "text", text: "INGEN_PRODUKTER_FUNNET" }] }),
            } as unknown as Response;
          }
          if (prompt.includes("Finn åpningstidene")) {
            // dev-request 2026-08-18-apningstider-llm-dommer: opening_hours_text
            // candidates now come from generateGardssalgOpeningHoursFromSource,
            // not the raw extractOpeningHours() snippet — return a clean,
            // classifyGardssalgFieldDefect-passing candidate whenever the
            // source text actually names hours; sentinel otherwise (row D's
            // pagePresent also has an hours section, but that row's current
            // value is already non-blank so the candidate is never written —
            // see fd-D4's already_present assertion, unaffected by what this
            // returns).
            if (prompt.includes("Åpningstider")) {
              return {
                ok: true, status: 200,
                json: async () => ({ content: [{ type: "text", text: "Mandag – fredag: 10–18, lørdag 10–15" }] }),
              } as unknown as Response;
            }
            return {
              ok: true, status: 200,
              json: async () => ({ content: [{ type: "text", text: "INGEN_UTVIDELSE_MULIG" }] }),
            } as unknown as Response;
          }
          // Fill-from-source / rewrite prompt — not exercised by any fixture
          // below (every row's about_text current value is either non-blank
          // or already good), but answered harmlessly rather than throwing,
          // in case a future edit changes that.
          return {
            ok: true, status: 200,
            json: async () => ({ content: [{ type: "text", text: "INGEN_UTVIDELSE_MULIG" }] }),
          } as unknown as Response;
        }
        const host = new URL(urlStr).hostname;
        const path = new URL(urlStr).pathname;
        const isRoot = path === "/" || path === "";
        const pageFor = (root: string, sub: string): string => (isRoot ? root : sub);
        if (host === "prov-fd-filled.example.no") {
          // No sub-pages needed — everything lives on the homepage; serve
          // 404 for any other path to keep the crawl to one page.
          if (!isRoot) return { ok: false, status: 404, text: async () => "" } as unknown as Response;
          return {
            ok: true, status: 200, text: async () => pageFilled,
            arrayBuffer: async () => new TextEncoder().encode(pageFilled).buffer,
            headers: { get: () => null },
          } as unknown as Response;
        }
        if (host === "prov-fd-nocandidate.example.no") {
          if (!isRoot) return { ok: false, status: 404, text: async () => "" } as unknown as Response;
          return {
            ok: true, status: 200, text: async () => pageNoCandidate,
            arrayBuffer: async () => new TextEncoder().encode(pageNoCandidate).buffer,
            headers: { get: () => null },
          } as unknown as Response;
        }
        if (host === "prov-fd-belowbar.example.no") {
          if (!isRoot) return { ok: false, status: 404, text: async () => "" } as unknown as Response;
          return {
            ok: true, status: 200, text: async () => pageBelowBar,
            arrayBuffer: async () => new TextEncoder().encode(pageBelowBar).buffer,
            headers: { get: () => null },
          } as unknown as Response;
        }
        if (host === "prov-fd-present.example.no") {
          if (!isRoot) return { ok: false, status: 404, text: async () => "" } as unknown as Response;
          return {
            ok: true, status: 200, text: async () => pagePresent,
            arrayBuffer: async () => new TextEncoder().encode(pagePresent).buffer,
            headers: { get: () => null },
          } as unknown as Response;
        }
        if (host === "prov-fd-fetchempty.example.no") {
          if (!isRoot) return { ok: false, status: 404, text: async () => "" } as unknown as Response;
          return {
            ok: true, status: 200, text: async () => pageFetchEmpty,
            arrayBuffer: async () => new TextEncoder().encode(pageFetchEmpty).buffer,
            headers: { get: () => null },
          } as unknown as Response;
        }
        if (host === "prov-fd-alreadygood-navonly.example.no") {
          if (!isRoot) return { ok: false, status: 404, text: async () => "" } as unknown as Response;
          return {
            ok: true, status: 200, text: async () => pageNoCandidate,
            arrayBuffer: async () => new TextEncoder().encode(pageNoCandidate).buffer,
            headers: { get: () => null },
          } as unknown as Response;
        }
        return { ok: false, status: 404, text: async () => "" } as unknown as Response;
      }) as typeof fetch;

      // ── Row A: opening_hours_text -> "filled"; about_text/visit_text ->
      //    "already_present" (current already good); products ->
      //    "already_present" (current already non-blank), matching
      //    products_diagnostic's "generator_not_invoked:products_already_
      //    present" via the mapping. ─────────────────────────────────────
      const resA = await callRoute(opplevelserRouter, {
        url: "/admin/gardssalg-content-refresh",
        headers: { "x-admin-key": testKey },
        body: { providerIds: ["prov-fd-filled"], apply: false },
      });
      assertEq(resA.status, 200, "fd-A0: row A call -> 200");
      const diagA = getFieldDiag(resA.body, "prov-fd-filled");
      assertTrue(!!diagA, "fd-A1: prov-fd-filled appears in field_diagnostic");
      assertEq(diagA.opening_hours_text, "filled", "fd-A2: opening_hours_text -> filled");
      assertEq(diagA.about_text, "already_present", "fd-A3: about_text -> already_present (current already good)");
      assertEq(diagA.visit_text, "already_present", "fd-A4: visit_text -> already_present (current already good)");
      assertEq(diagA.products, "already_present", "fd-A5: products -> already_present");
      const prodDiagA = getProductsDiag(resA.body, "prov-fd-filled");
      assertTrue(!!prodDiagA, "fd-A6: prov-fd-filled appears in products_diagnostic");
      assertEq(prodDiagA.outcome, "generator_not_invoked:products_already_present", "fd-A7: products_diagnostic outcome is generator_not_invoked:products_already_present");
      assertEq(diagA.products, "already_present", "fd-A8: field_diagnostic.products matches the mapping of products_diagnostic's outcome for the SAME row");
      // Confirm the changed[] entry agrees: opening_hours_text is the only
      // field this dry-run projects a write for.
      const changedA = resA.body.changed.find((c: any) => c.provider_id === "prov-fd-filled");
      assertTrue(!!changedA, "fd-A9: prov-fd-filled appears in changed[] (opening_hours_text write)");
      assertEq(changedA.fields, ["opening_hours_text"], "fd-A10: changed[].fields is exactly [opening_hours_text]");

      // ── Row B: about_text/visit_text/opening_hours_text -> "no_candidate_
      //    section" (blank raw extraction on every field); products ->
      //    "no_candidate_section" too, via the sentinel_no_products mapping
      //    (kildetekst carries no PRODUCTS_FOUND_MARKER). ─────────────────
      const resB = await callRoute(opplevelserRouter, {
        url: "/admin/gardssalg-content-refresh",
        headers: { "x-admin-key": testKey },
        body: { providerIds: ["prov-fd-nocandidate"], apply: false },
      });
      assertEq(resB.status, 200, "fd-B0: row B call -> 200");
      const diagB = getFieldDiag(resB.body, "prov-fd-nocandidate");
      assertTrue(!!diagB, "fd-B1: prov-fd-nocandidate appears in field_diagnostic");
      assertEq(diagB.about_text, "no_candidate_section", "fd-B2: about_text -> no_candidate_section (blank aboutSummary, nav-only page)");
      assertEq(diagB.visit_text, "no_candidate_section", "fd-B3: visit_text -> no_candidate_section (blank visitSummary)");
      assertEq(diagB.opening_hours_text, "no_candidate_section", "fd-B4: opening_hours_text -> no_candidate_section (no weekday/time pattern)");
      const prodDiagB = getProductsDiag(resB.body, "prov-fd-nocandidate");
      assertTrue(!!prodDiagB, "fd-B5: prov-fd-nocandidate appears in products_diagnostic");
      assertEq(prodDiagB.outcome, "sentinel_no_products", "fd-B6: products_diagnostic outcome is sentinel_no_products");
      assertEq(diagB.products, "no_candidate_section", "fd-B7: field_diagnostic.products matches the mapping of sentinel_no_products -> no_candidate_section for the SAME row");
      // Nothing was written for this row at all.
      assertTrue(!resB.body.changed.find((c: any) => c.provider_id === "prov-fd-nocandidate"), "fd-B8: prov-fd-nocandidate does NOT appear in changed[] — nothing written");

      // ── Row C: about_text -> "below_quality_bar" (non-blank aboutSummary,
      //    judge rejects the candidate because of REJECT_MARKER). ─────────
      const resC = await callRoute(opplevelserRouter, {
        url: "/admin/gardssalg-content-refresh",
        headers: { "x-admin-key": testKey },
        body: { providerIds: ["prov-fd-belowbar"], apply: false },
      });
      assertEq(resC.status, 200, "fd-C0: row C call -> 200");
      const diagC = getFieldDiag(resC.body, "prov-fd-belowbar");
      assertTrue(!!diagC, "fd-C1: prov-fd-belowbar appears in field_diagnostic");
      assertEq(diagC.about_text, "below_quality_bar", "fd-C2: about_text -> below_quality_bar (non-blank summary, judge rejected)");
      assertTrue(!resC.body.changed.find((c: any) => c.provider_id === "prov-fd-belowbar"), "fd-C3: prov-fd-belowbar does NOT appear in changed[] — the rejected candidate wrote nothing");

      // ── Row D: about_text/visit_text/opening_hours_text/products all ->
      //    "already_present" — every field extracts a real, judge-approved
      //    candidate, but every current DB value was already adequate, so
      //    nothing gets written. Distinguishes this outcome from
      //    no_candidate_section (row B) and below_quality_bar (row C):
      //    something WAS found here, it just wasn't needed. ──────────────
      const resD = await callRoute(opplevelserRouter, {
        url: "/admin/gardssalg-content-refresh",
        headers: { "x-admin-key": testKey },
        body: { providerIds: ["prov-fd-present"], apply: false },
      });
      assertEq(resD.status, 200, "fd-D0: row D call -> 200");
      const diagD = getFieldDiag(resD.body, "prov-fd-present");
      assertTrue(!!diagD, "fd-D1: prov-fd-present appears in field_diagnostic");
      assertEq(diagD.about_text, "already_present", "fd-D2: about_text -> already_present");
      assertEq(diagD.visit_text, "already_present", "fd-D3: visit_text -> already_present");
      assertEq(diagD.opening_hours_text, "already_present", "fd-D4: opening_hours_text -> already_present (candidateHours found, but current already non-blank)");
      assertEq(diagD.products, "already_present", "fd-D5: products -> already_present");
      assertTrue(!resD.body.changed.find((c: any) => c.provider_id === "prov-fd-present"), "fd-D6: prov-fd-present does NOT appear in changed[] — nothing written");

      // ── Row E: about_text/visit_text/opening_hours_text -> "fetch_empty"
      //    (the whole page yielded ~nothing — one row-level reason, not
      //    three per-section ones). ───────────────────────────────────────
      const resE = await callRoute(opplevelserRouter, {
        url: "/admin/gardssalg-content-refresh",
        headers: { "x-admin-key": testKey },
        body: { providerIds: ["prov-fd-fetchempty"], apply: false },
      });
      assertEq(resE.status, 200, "fd-E0: row E call -> 200");
      const diagE = getFieldDiag(resE.body, "prov-fd-fetchempty");
      assertTrue(!!diagE, "fd-E1: prov-fd-fetchempty appears in field_diagnostic");
      assertEq(diagE.about_text, "fetch_empty", "fd-E2: about_text -> fetch_empty (empty page)");
      assertEq(diagE.visit_text, "fetch_empty", "fd-E3: visit_text -> fetch_empty");
      assertEq(diagE.opening_hours_text, "fetch_empty", "fd-E4: opening_hours_text -> fetch_empty");

      // ── Row G: fix-up regression test (independent review of 97596a7) —
      //    current DB values for about_text/visit_text/opening_hours_text
      //    are ALL already good/non-blank, but this crawl's homepage is
      //    nav-only (blank raw extraction for all three fields). Must
      //    resolve to "already_present" for all three, NOT
      //    "no_candidate_section" — and nothing gets written, confirming the
      //    write path was untouched by this fix. ─────────────────────────
      const resG = await callRoute(opplevelserRouter, {
        url: "/admin/gardssalg-content-refresh",
        headers: { "x-admin-key": testKey },
        body: { providerIds: ["prov-fd-alreadygood-navonly"], apply: false },
      });
      assertEq(resG.status, 200, "fd-G0: row G call -> 200");
      const diagG = getFieldDiag(resG.body, "prov-fd-alreadygood-navonly");
      assertTrue(!!diagG, "fd-G1: prov-fd-alreadygood-navonly appears in field_diagnostic");
      assertEq(diagG.about_text, "already_present", "fd-G2: about_text -> already_present (current already good, blank raw extraction this crawl — NOT no_candidate_section)");
      assertEq(diagG.visit_text, "already_present", "fd-G3: visit_text -> already_present (current already good, blank raw extraction this crawl — NOT no_candidate_section)");
      assertEq(diagG.opening_hours_text, "already_present", "fd-G4: opening_hours_text -> already_present (current already good, no hours snippet this crawl — NOT no_candidate_section)");
      assertTrue(!resG.body.changed.find((c: any) => c.provider_id === "prov-fd-alreadygood-navonly"), "fd-G5: prov-fd-alreadygood-navonly does NOT appear in changed[] — write path untouched, nothing written");

      // ── fd-F: rows that never reach `scanned++` (row-locked, in this
      //    case) must NOT appear in field_diagnostic at all — same scope
      //    contract as products_diagnostic pre-AC3-widen. ─────────────────
      insertProvider.run({
        id: "prov-fd-locked", navn: "Prov Fd Locked Gard", hjemmeside: "https://prov-fd-locked.example.no",
        content_source: "manual", about_text: "x", visit_text: null, opening_hours_text: null, products: null,
      });
      const resF = await callRoute(opplevelserRouter, {
        url: "/admin/gardssalg-content-refresh",
        headers: { "x-admin-key": testKey },
        body: { providerIds: ["prov-fd-locked"], apply: false },
      });
      assertEq(resF.status, 200, "fd-F0: locked-row call -> 200");
      assertTrue(resF.body.skipped_locked.includes("prov-fd-locked"), "fd-F1: locked provider reported in skipped_locked");
      assertTrue(!getFieldDiag(resF.body, "prov-fd-locked"), "fd-F2: locked provider (never reached scanned++) does NOT appear in field_diagnostic");
    } catch (err: any) {
      failed++;
      failures.push("opplevelser-gardssalg-field-diagnostic: unexpected error: " + String(err?.stack || err?.message || err));
    } finally {
      globalThis.fetch = prevFetch;
      if (prevAnthropicKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = prevAnthropicKey;
      if (prevAdminKey === undefined) delete process.env.ADMIN_KEY;
      else process.env.ADMIN_KEY = prevAdminKey;
      if (prevExperiencesDbPath === undefined) delete process.env.EXPERIENCES_DB_PATH;
      else process.env.EXPERIENCES_DB_PATH = prevExperiencesDbPath;
      for (const p of cachePaths) delete require.cache[p];
    }

    return { passed, failed, failures };
  })();
}
