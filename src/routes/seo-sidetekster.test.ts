/**
 * seo-sidetekster.test.ts — dev-request 2026-10-17-integrasjonstest-oppfolging,
 * slice I-P: page copy about the MCP tools, the legal pages and the titles
 * (round-2 findings MCP2-01, MCP2-05, IDX2-05, MCP2-02 in A2A
 * reports/2026-10-17-integrasjonstest-synlighet-runde2.md).
 *
 * Covers:
 *   (a) MCP2-01, OA /guide-opplevelser-mcp: the tool list and the tools FAQ
 *       are generated from registeredMcpTools("experiences"), so they name
 *       all five registered tools in registration order, discover_gardssalg
 *       and book_gardssalg included; every tool has curated copy in both
 *       languages, and every parameter the copy names is in the tool's
 *       inputSchema from a real tools/list; `query` is documented; the
 *       book_gardssalg card and the booking FAQ say it is a pending visit
 *       request, no confirmed booking, no payment; the visible FAQ equals the
 *       FAQPage JSON-LD; a tool list without book_gardssalg drops the
 *       gårdssalg sentence; a registered tool with no copy is still listed,
 *       with its registered description escaped.
 *   (b) MCP2-05, OA /personvern and /vilkar with their aliases: one canonical
 *       each (/personvern, /vilkar) and a meta description; /proveniens keeps
 *       its own.
 *   (c) IDX2-05, seoPageTitle(): the repro titles are cut at the subtitle
 *       separator, never after a preposition; titles without a separator drop
 *       trailing closed-class words and an unclosed «(»; a short head falls
 *       through to the word cut; a title that fits is unchanged; the result
 *       is never empty; a live-title corpus never ends on a function word.
 *   (d) IDX2-05, titlePlace(): «Oslo, Oslo» becomes «Oslo»; distinct names
 *       are unchanged; on a rendered /opplevelse page the <title> says the
 *       place once and og:title keeps the full title.
 *   (e) MCP2-02, RFB /guide-mat-ai: no «full prisliste» / "full price list"
 *       in the page or its FAQPage JSON-LD (NO and EN, payments on and off);
 *       lokal_search and lokal_info say «med pris der produsenten har oppgitt
 *       den» / "with a price where the producer has stated one", as the
 *       tools' own descriptions do.
 *
 * MCP tool metadata is not touched (contract freeze); the freeze tests for
 * OA and RFB guard that separately.
 *
 * Run standalone: npx tsx src/routes/seo-sidetekster.test.ts
 * Wired into `npm test` via tests/test.ts.
 */

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

type RouteResult = { handled: boolean; status: number; body: string; headers: Record<string, string> };

// Same synthetic router.handle() shortcut as experiences-seo-indeks-tekst.test.ts.
function callHtmlRoute(router: any, url: string, lang: "no" | "en" = "no"): Promise<RouteResult> {
  return new Promise((resolve) => {
    let statusCode = 200;
    const headers: Record<string, string> = {};
    const req: any = {
      method: "GET",
      url,
      originalUrl: url,
      path: url.split("?")[0],
      query: Object.fromEntries(new URLSearchParams(url.split("?")[1] || "")),
      headers: {},
      lang,
      get() { return undefined; },
    };
    const res: any = {
      statusCode: 200,
      status(code: number) { statusCode = code; this.statusCode = code; return this; },
      setHeader(k: string, v: unknown) { headers[k.toLowerCase()] = String(v); },
      redirect(code: number) { resolve({ handled: true, status: code, body: "", headers }); },
      send(body: unknown) { resolve({ handled: true, status: statusCode, body: String(body), headers }); },
    };
    router.handle(req, res, (err?: any) => resolve({ handled: false, status: statusCode, body: err ? String(err) : "", headers }));
  });
}

function unescapeHtml(s: string): string {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&#39;/g, "'").replace(/&amp;/g, "&");
}

function ldBlocks(html: string): any[] {
  const out: any[] = [];
  const re = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    try { out.push(JSON.parse(m[1])); } catch { /* counted as missing */ }
  }
  return out;
}

function metaContent(html: string, attr: "name" | "property", key: string): string | null {
  const m = html.match(new RegExp(`<meta ${attr}="${key}" content="([^"]*)">`));
  return m ? unescapeHtml(m[1]) : null;
}

function canonicals(html: string): string[] {
  return [...html.matchAll(/<link rel="canonical" href="([^"]*)">/g)].map((m) => m[1]);
}

function titleTag(html: string): string {
  return unescapeHtml((html.match(/<title>([^<]*)<\/title>/) || [])[1] || "");
}

/** The tool cards of /guide-opplevelser-mcp as [name, inner HTML of the <p>]. */
function guideCards(html: string): Array<[string, string]> {
  return [...html.matchAll(/<div class="gom-tool"><code>([^<]*)<\/code><p>([\s\S]*?)<\/p><\/div>/g)].map((m) => [m[1], m[2]] as [string, string]);
}

/** The visible FAQ of a guide page as [question, answer] pairs, unescaped. */
function visibleFaq(html: string, cls: "gom-faq-item" | "gma-faq-item"): Array<[string, string]> {
  const re = new RegExp(`<div class="${cls}"><h3>([^<]*)</h3><p>([^<]*)</p></div>`, "g");
  return [...html.matchAll(re)].map((m) => [unescapeHtml(m[1]), unescapeHtml(m[2])] as [string, string]);
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

// The five tools experiences-mcp.ts registers today (2026-10-17). The page had
// the first three only (MCP2-01).
const OA_TOOLS = ["discover_experiences", "list_experience_categories", "get_experience", "discover_gardssalg", "book_gardssalg"];

// Independent of the implementation's list: the words a cut title read as
// broken on in the round-2 sample and the live corpus.
const DANGLING_WORDS = new Set(["i", "på", "til", "fra", "av", "med", "ved", "for", "om", "nær", "og", "eller", "som", "the", "and", "of", "in", "on", "at", "to", "from", "with", "near"]);

// Live /opplevelse display titles from 2026-10-17 that took the truncation path.
const LIVE_LONG_TITLES = [
  "Arctic Circle Raceway — motorsport like sør for Polarsirkelen",
  "Norsk Tindemuseum — klatringshistorie i hjertet av Romsdalen",
  "Gaustatoppen – sommervandring til Norges mest panoramiske topp",
  "Telemarkskanalen — Historisk båttur gjennom Norges kanalsystem",
  "Rauland Skisenter – Telemarks største alpin- og langrennsdestinasjon",
  "Romsdalsgondolen til Nesaksla med besøk på Eggen Restaurant",
  "Guidet kajakktur på Hjørundfjorden med overnatting fra Urke",
  "RIB Guided Fjord Tour in Alesund Outer Island Archipelago",
  "Guided Fjord Cruise to Nærøyfjord and Flåm (inkl. Stegastein)",
  "Hvalsafari, nordlys og arktisk naturlodge på Uløya i Skjervøy",
  "The Bucketlist Cruise: 24h Northern Lights and Whale Watching",
  "Svartisen: Båttur og isvandring på Norges nest største isbre",
  "Rorbuer i Å – autentisk fiskeropplevelse ytterst i Lofoten",
  "Fotografihistorie og bildekunst fra Innherred på Levanger Fotomuseum",
  "Farm stay with outdoor activities and sea fishing at Setran Gård",
  "Nettbutikk med økologisk reinrotpulver fra Bosheimsmarken",
  "På garden er det to Bygdesuiter som du kan leige for overnatting, og Pål serverer gjerne middag for to, enten om det er i Eldshuset eller om det er i Blomstugu.",
  "Lofoten Explorer — Trollfjord RIB Cruise & Sea Eagle Safari from Svolvær",
  "Røros Church (Bergstadens Ziir) — UNESCO Baroque Landmark & Guided Tour",
  "Museum Stavanger (MUST) — Eight Museums on One Ticket in Rogaland",
  "Mine tours and guided city walks at Rørosmuseet UNESCO site",
  "Dog Sledding & Husky Farm Adventures in the Sirdal Mountains, Agder",
  "Kystcruise og fjordopplevelse i Nord-Norge med Arctic Cruise In Norway",
  "Namsen Salmon & Train Experience — Sleep in a Train on a Bridge Over One of Norway's Best Salmon Rivers",
];

export function runSeoSideteksterTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];
  function assertTrue(cond: boolean, label: string): void {
    if (cond) { passed++; if (log) console.log(`  ok ${label}`); }
    else { failed++; failures.push(`✗ ${label}`); if (log) console.log(`  ✗ ${label}`); }
  }
  function assertEq(actual: unknown, expected: unknown, label: string): void {
    if (same(actual, expected)) { passed++; if (log) console.log(`  ok ${label}`); }
    else {
      failed++;
      const msg = `✗ ${label}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`;
      failures.push(msg);
      if (log) console.log("  " + msg);
    }
  }
  const setEnv = (key: string, value: string | undefined): void => {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  };

  return (async () => {
    const prev = { db: process.env.EXPERIENCES_DB_PATH, payments: process.env.PAYMENTS_ENABLED };
    process.env.EXPERIENCES_DB_PATH = ":memory:";
    setEnv("PAYMENTS_ENABLED", undefined);

    const paths = [
      require.resolve("../database/db-factory"),
      require.resolve("../services/experience-store"),
      require.resolve("./experiences-seo"),
    ];
    const restoreModuleCache = (require("../../tests/module-cache") as typeof import("../../tests/module-cache")).swapOutModules(paths);

    try {
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const seo = require("./experiences-seo") as typeof import("./experiences-seo");
      const router = seo.default as any;
      const manifest = require("../services/mcp-tool-manifest") as typeof import("../services/mcp-tool-manifest");
      const BRAND = " | Opplevagent";

      // ── (a) MCP2-01: /guide-opplevelser-mcp ────────────────────────────────
      {
        // A real tools/list, as a client gets it: names and input schemas.
        const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js") as typeof import("@modelcontextprotocol/sdk/server/mcp.js");
        const { Client } = require("@modelcontextprotocol/sdk/client/index.js") as typeof import("@modelcontextprotocol/sdk/client/index.js");
        const { InMemoryTransport } = require("@modelcontextprotocol/sdk/inMemory.js") as typeof import("@modelcontextprotocol/sdk/inMemory.js");
        const server = new McpServer({ name: "sidetekster-test", version: "0.0.0" });
        (require("./experiences-mcp") as typeof import("./experiences-mcp")).registerExperienceTools(server);
        const [ct, st] = InMemoryTransport.createLinkedPair();
        const client = new Client({ name: "sidetekster-test", version: "0.0.0" });
        await Promise.all([server.connect(st), client.connect(ct)]);
        const listed = (await client.listTools()).tools;
        await client.close();
        await server.close();
        const params = new Map(listed.map((t) => [t.name, Object.keys((t.inputSchema as any)?.properties || {})]));
        const registered = manifest.registeredMcpToolNames("experiences");

        assertEq(registered, OA_TOOLS, "ip-a1 (MCP2-01): the registered OA tools are the five the page must list");
        assertEq(listed.map((t) => t.name), registered, "ip-a2: registeredMcpTools() is the live tools/list, in order");

        for (const lang of ["no", "en"] as const) {
          const tools = seo.opplevagentMcpGuideTools(lang);
          assertEq(tools.map((t) => t.name), registered, `ip-a3 (${lang}): opplevagentMcpGuideTools() lists every registered tool, in registration order`);
          assertTrue(tools.every((t) => t.curated),
            `ip-a4 (${lang}): every registered tool has curated copy (missing: ${tools.filter((t) => !t.curated).map((t) => t.name).join(", ") || "none"})`);
          const unknownParams = tools.flatMap((t) =>
            [...t.cardHtml.matchAll(/<code>([^<]*)<\/code>/g)].map((m) => m[1]).filter((p) => !(params.get(t.name) || []).includes(p)).map((p) => `${t.name}.${p}`));
          assertEq(unknownParams, [], `ip-a5 (${lang}): every parameter a card names is in that tool's inputSchema (no invented names)`);
          const byName = new Map(tools.map((t) => [t.name, t]));
          assertTrue(["discover_experiences", "discover_gardssalg"].every((n) => byName.get(n)!.cardHtml.includes("<code>query</code>") && (params.get(n) || []).includes("query")),
            `ip-a6 (${lang}): \`query\` is documented for discover_experiences and discover_gardssalg, and both take it`);
        }
        assertEq(seo.opplevagentMcpGuideTools("sv").map((t) => t.faq), seo.opplevagentMcpGuideTools("no").map((t) => t.faq),
          "ip-a7: any other language gets the Norwegian copy");

        const no = await callHtmlRoute(router, "/guide-opplevelser-mcp", "no");
        const en = await callHtmlRoute(router, "/guide-opplevelser-mcp", "en");
        for (const [lang, r] of [["no", no], ["en", en]] as const) {
          const cards = guideCards(r.body);
          assertTrue(r.status === 200 && same(cards.map((c) => c[0]), OA_TOOLS),
            `ip-a8 (${lang}): the page has one card per registered tool, in order (got ${JSON.stringify(cards.map((c) => c[0]))})`);
          const faqLd = ldBlocks(r.body).find((b) => b["@type"] === "FAQPage");
          const pairs = faqLd ? faqLd.mainEntity.map((q: any) => [q.name, q.acceptedAnswer.text]) : [];
          assertTrue(!!faqLd && same(visibleFaq(r.body, "gom-faq-item"), pairs) && pairs.length === 5,
            `ip-a9 (${lang}): the visible FAQ equals the FAQPage JSON-LD (5 questions)`);
          const toolsAnswer: string = pairs[1]?.[1] || "";
          assertTrue(OA_TOOLS.every((n) => toolsAnswer.includes(n)),
            `ip-a10 (${lang}): the tools FAQ answer names all five tools (got ${JSON.stringify(toolsAnswer)})`);
        }
        const bookNo = guideCards(no.body).find((c) => c[0] === "book_gardssalg")?.[1] || "";
        const bookEn = guideCards(en.body).find((c) => c[0] === "book_gardssalg")?.[1] || "";
        assertTrue(["besøksforespørsel", "står ventende til produsenten svarer", "aldri en bekreftet booking", "tar ikke imot betaling"].every((s) => bookNo.includes(s)),
          `ip-a11: the NO book_gardssalg card says visit request, pending until the producer replies, never confirmed, no payment (got ${JSON.stringify(bookNo)})`);
        assertTrue(["visit request", "stays pending until the producer replies", "never creates a confirmed booking", "takes no payment"].every((s) => bookEn.includes(s)),
          `ip-a12: the EN book_gardssalg card says the same (got ${JSON.stringify(bookEn)})`);
        const bookingNo = seo.buildOpplevagentMcpGuideFaqJsonLd("no", "u").mainEntity[3].acceptedAnswer.text as string;
        const bookingEn = seo.buildOpplevagentMcpGuideFaqJsonLd("en", "u").mainEntity[3].acceptedAnswer.text as string;
        assertTrue(bookingNo.startsWith("Assistenten viser en booking_url") && ["book_gardssalg", "besøksforespørsel", "står ventende", "ingen bekreftet booking", "tar ikke imot betaling"].every((s) => bookingNo.includes(s)),
          `ip-a13: the NO booking answer keeps the experiences part and adds the gårdssalg request (got ${JSON.stringify(bookingNo)})`);
        assertTrue(bookingEn.startsWith("The assistant surfaces a booking_url") && ["book_gardssalg", "visit request", "stays pending", "not a confirmed booking", "takes no payment"].every((s) => bookingEn.includes(s)),
          `ip-a14: the EN booking answer does the same (got ${JSON.stringify(bookingEn)})`);
        assertTrue(!/\b(bekreftet booking hos|booking er bekreftet|confirmed booking with|instant booking)\b/i.test(no.body + en.body),
          "ip-a15: neither page promises a confirmed booking");

        // Negative: the FAQ follows the registered list, so a list without
        // book_gardssalg says nothing about gårdssalg requests.
        const withoutBooking = manifest.registeredMcpTools("experiences").filter((t) => t.name !== "book_gardssalg");
        const faqWithout = seo.buildOpplevagentMcpGuideFaqJsonLd("no", "u", withoutBooking);
        const textWithout = JSON.stringify(faqWithout);
        assertTrue(faqWithout.mainEntity.length === 5 && !textWithout.includes("book_gardssalg") && !textWithout.includes("besøksforespørsel"),
          "ip-a16 (negative): without book_gardssalg registered, the FAQ neither names it nor mentions visit requests");
        assertEq(faqWithout.mainEntity[3].acceptedAnswer.text,
          "Assistenten viser en booking_url (og booking_type) per opplevelse fra discover_experiences/get_experience; selve bookingen skjer hos tilbyderens egen side eller via den lenken, ikke inne i MCP-samtalen.",
          "ip-a17: … and its booking answer is exactly the experiences answer from before");

        // A registered tool without copy is still listed, escaped.
        const future = seo.opplevagentMcpGuideTools("no", [{ name: "future_tool", description: "Does a <b>thing</b>." }]);
        assertEq(future, [{ name: "future_tool", cardHtml: "Does a &lt;b&gt;thing&lt;/b&gt;.", faq: "future_tool: Does a <b>thing</b>", bookingFaq: null, curated: false }],
          "ip-a18: a tool with no curated copy is listed with its registered description, HTML-escaped on the card");
        const futureFaq = seo.buildOpplevagentMcpGuideFaqJsonLd("en", "u", [{ name: "future_tool", description: "Does a thing." }]);
        assertEq(futureFaq.mainEntity[1].acceptedAnswer.text, "future_tool: Does a thing.", "ip-a19: … and named in the tools FAQ answer");
        assertTrue(!["opplev_discover", "opplev_info", "opplev_categories"].some((n) => no.body.includes(n) || en.body.includes(n)),
          "ip-a20 (regression): the never-registered opplev_* names stay off the page");
      }

      // ── (b) MCP2-05: /personvern, /vilkar and their aliases ────────────────
      {
        const groups: Array<[string, string[]]> = [
          ["https://opplevagent.no/personvern", ["/personvern", "/privacy", "/privacy-policy"]],
          ["https://opplevagent.no/vilkar", ["/vilkar", "/terms", "/terms-of-service", "/tos"]],
        ];
        for (const [canonical, aliases] of groups) {
          const bodies: string[] = [];
          for (const p of aliases) {
            const r = await callHtmlRoute(router, p);
            bodies.push(r.body);
            const desc = metaContent(r.body, "name", "description");
            assertTrue(r.status === 200 && same(canonicals(r.body), [canonical]),
              `ip-b1 (MCP2-05): ${p} has exactly one canonical, ${canonical} (got ${JSON.stringify(canonicals(r.body))})`);
            assertTrue(!!desc && desc.length >= 80 && desc.length <= 160,
              `ip-b2: ${p} has a meta description of 80–160 characters (got ${desc ? desc.length : "none"})`);
            assertTrue(r.body.includes('<meta name="robots" content="index, follow">'), `ip-b3: ${p} is still index, follow`);
          }
          assertTrue(bodies.every((b) => b === bodies[0]), `ip-b4: the aliases of ${canonical} serve the same page`);
        }
        const pv = await callHtmlRoute(router, "/personvern");
        const vk = await callHtmlRoute(router, "/vilkar");
        assertTrue(metaContent(pv.body, "name", "description")!.startsWith("Personvernerklæring for Opplevagent")
          && metaContent(vk.body, "name", "description")!.startsWith("Vilkår for bruk av Opplevagent"),
          "ip-b5: each page has its own description");
        assertTrue(titleTag(pv.body) === "Personvern / Privacy — Opplevagent" && titleTag(vk.body) === "Vilkår / Terms of Service — Opplevagent",
          "ip-b6: the titles are unchanged");
        const prov = await callHtmlRoute(router, "/proveniens");
        assertTrue(same(canonicals(prov.body), ["https://opplevagent.no/proveniens"]), "ip-b7 (regression): /proveniens keeps its own canonical");
      }

      // ── (c) IDX2-05: seoPageTitle() ────────────────────────────────────────
      {
        const t = seo.seoPageTitle;
        assertEq(t("Arctic Circle Raceway — motorsport like sør for Polarsirkelen"), "Arctic Circle Raceway" + BRAND,
          "ip-c1 (IDX2-05 repro): «… motorsport like sør for» is cut at the em dash, not after «for»");
        assertEq(t("Norsk Tindemuseum — klatringshistorie i hjertet av Romsdalen"), "Norsk Tindemuseum" + BRAND,
          "ip-c2 (repro): «… i hjertet av» is cut at the em dash");
        assertEq(t("Gaustatoppen – sommervandring til Norges mest panoramiske topp"), "Gaustatoppen" + BRAND,
          "ip-c3: an en-dash subtitle is cut at the separator too (no «… Norges mest»)");
        assertEq(t("Svartisen: Båttur og isvandring på Norges nest største isbre"), "Svartisen" + BRAND,
          "ip-c4: a colon subtitle is cut at the colon");
        assertEq(t("Stavanger - Preikestolen guidet fottur med transport og lunsj inkludert"), "Stavanger" + BRAND,
          "ip-c5: a spaced hyphen counts as a separator");
        assertEq(t("Norsk Folkemuseum – friluftsmuseum – stavkirke og historiske bygninger på Bygdøy"), "Norsk Folkemuseum – friluftsmuseum" + BRAND,
          "ip-c6: the last separator whose head fits is used");
        assertEq(t("Rorbuer i Å – autentisk fiskeropplevelse ytterst i Lofoten"), "Rorbuer i Å" + BRAND,
          "ip-c7: the place «Å» is not taken for the infinitive marker");
        assertEq(t("Guidet kajakktur på Hjørundfjorden med overnatting fra Urke"), "Guidet kajakktur på Hjørundfjorden med overnatting" + BRAND,
          "ip-c8: without a separator, a trailing preposition is dropped (nb)");
        assertEq(t("Farm stay with outdoor activities and sea fishing at Setran Gård"), "Farm stay with outdoor activities and sea fishing" + BRAND,
          "ip-c9: … and in English");
        assertEq(t("Padling og bading mellom holmene i skjærgården og på de ytre øyene"), "Padling og bading mellom holmene i skjærgården" + BRAND,
          "ip-c10: several trailing function words in a row are all dropped («og på de»)");
        assertEq(t("Kayak rental and paddling between the islets out on the Oslofjord at Son"), "Kayak rental and paddling between the islets out" + BRAND,
          "ip-c11: … in English too («on the»)");
        assertEq(t("Guided Fjord Cruise to Nærøyfjord and Flåm (inkl. Stegastein)"), "Guided Fjord Cruise to Nærøyfjord and Flåm" + BRAND,
          "ip-c12: an unclosed «(inkl» is dropped");
        assertEq(t("Telemarks største alpin- og langrennsdestinasjon med mange flotte løyper"), "Telemarks største alpin- og langrennsdestinasjon" + BRAND,
          "ip-c13: «alpin- og» is not a separator; the trailing «med» is dropped");
        assertEq(t("Ski — familievennlig alpinsenter med heis og løyper for alle aldre"), "Ski — familievennlig alpinsenter med heis og løyper" + BRAND,
          "ip-c14: a head shorter than 8 characters («Ski») falls through to the word cut");
        const longHead = "Et svært langt navn på en attraksjon ved fjorden som alene er lengre enn budsjettet — med undertittel";
        const longHeadTitle = t(longHead);
        assertTrue(longHead.startsWith(longHeadTitle.slice(0, -BRAND.length)) && !longHeadTitle.includes("—") && longHeadTitle.length <= 70
          && !DANGLING_WORDS.has(longHeadTitle.slice(0, -BRAND.length).split(" ").pop()!.toLowerCase()),
          `ip-c15: a head longer than the budget falls through to the word cut (got ${JSON.stringify(longHeadTitle)})`);
        assertEq(t("og i på til fra av med ved for om hos mot etter før under over mellom gjennom langs"), "og" + BRAND,
          "ip-c16: never cut down to nothing — one word is always kept");
        assertEq(t("Tur til"), "Tur til" + BRAND, "ip-c17: a title that fits is returned unchanged, even ending on «til»");
        const exact = "Kajakk — " + "x".repeat(70 - BRAND.length - "Kajakk — ".length);
        assertEq(t(exact), exact + BRAND, "ip-c18: a title exactly at the budget is unchanged, separator or not");
        const bad: string[] = [];
        for (const title of LIVE_LONG_TITLES) {
          const out = t(title);
          const main = out.slice(0, -BRAND.length);
          const last = main.split(" ").pop()!.toLowerCase();
          const open = main.lastIndexOf("(");
          if (!out.endsWith(BRAND) || out.length > 70 || !title.startsWith(main) || !main
            || DANGLING_WORDS.has(last) || /[\s\-–—,.&/:;]$/.test(main) || (open >= 0 && open > main.lastIndexOf(")"))) bad.push(`${title} -> ${out}`);
        }
        assertEq(bad, [], `ip-c19: ${LIVE_LONG_TITLES.length} live titles: ≤70, a clean prefix, no trailing function word, punctuation or open «(»`);
      }

      // ── (d) IDX2-05: titlePlace() and the rendered /opplevelse title ───────
      {
        assertEq(seo.titlePlace("Oslo", "Oslo"), "Oslo", "ip-d1: kommune = fylke gives the name once");
        assertEq(seo.titlePlace("oslo ", "Oslo"), "oslo ", "ip-d2: matched trimmed and ignoring case; the kommune is kept as stored");
        assertEq(seo.titlePlace("Bergen", "Vestland"), "Bergen, Vestland", "ip-d3: distinct names stay «kommune, fylke»");
        assertEq([seo.titlePlace(null, "Vestland"), seo.titlePlace("Bergen", null), seo.titlePlace(null, null), seo.titlePlace("", "Oslo")],
          ["Vestland", "Bergen", "", "Oslo"], "ip-d4: one or no name, as before");

        const expStore = require("../services/experience-store") as typeof import("../services/experience-store");
        const db = dbFactory.getDb("experiences") as any;
        const provider = expStore.createProvider({ navn: "Tittel Test AS", fylke: "Oslo", kommune: "Oslo", brreg_verified: 1, brreg_active: 1, verification_status: "verified" });
        const mk = (title: string, fylke: string, kommune: string, titleNo?: string): string => {
          const id = expStore.createExperience({
            title, provider_id: provider, provider_match_status: "matched", category: "adrenalin_action", fylke, kommune,
            description: `${title} — guidet opplevelse med lokal tilbyder, utstyr og instruksjon inkludert.`,
            confidence: "high", verification_status: "verified",
          });
          if (titleNo) db.prepare("UPDATE experiences SET title_no = ? WHERE id = ?").run(titleNo, id);
          return (expStore.getExperienceById(id) as any).slug as string;
        };
        const oslo = await callHtmlRoute(router, `/opplevelse/${mk("Klatring i Oslo Klatrepark", "Oslo", "Oslo")}`);
        assertTrue(oslo.status === 200 && titleTag(oslo.body) === "Klatring i Oslo Klatrepark – Oslo" + BRAND,
          `ip-d5 (IDX2-05 repro): Oslo/Oslo renders «… – Oslo», not «Oslo, Oslo» (got ${JSON.stringify(titleTag(oslo.body))})`);
        const bergen = await callHtmlRoute(router, `/opplevelse/${mk("Fjordsafari", "Vestland", "Bergen")}`);
        assertEq(titleTag(bergen.body), "Fjordsafari – Bergen, Vestland" + BRAND, "ip-d6: distinct kommune and fylke render as before");
        const arctic = await callHtmlRoute(router, `/opplevelse/${mk("Arctic Circle Raceway", "Nordland", "Rana", "Arctic Circle Raceway — motorsport like sør for Polarsirkelen")}`);
        assertTrue(titleTag(arctic.body) === "Arctic Circle Raceway" + BRAND
          && metaContent(arctic.body, "property", "og:title") === "Arctic Circle Raceway — motorsport like sør for Polarsirkelen",
          `ip-d7: a long title_no is cut at the separator in <title>, og:title keeps the full title (got ${JSON.stringify(titleTag(arctic.body))})`);
      }

      // ── (e) MCP2-02: RFB /guide-mat-ai ─────────────────────────────────────
      {
        // The RFB page shell reads the vertical config; idempotent when
        // another suite in the process already loaded it.
        try { (require("../config/vertical-config") as typeof import("../config/vertical-config")).loadConfigsAtBoot(); } catch { /* already loaded */ }
        const rfbSeo = require("./seo") as typeof import("./seo");
        const layer = ((rfbSeo.default as any).stack as any[]).find((l: any) => l.route && l.route.path === "/guide-mat-ai" && l.route.methods?.get);
        const handler = layer.route.stack[layer.route.stack.length - 1].handle;
        const render = (lang: "no" | "en"): string => {
          let body = "";
          const res: any = { setHeader() {}, status() { return res; }, send(b: unknown) { body = String(b); return res; } };
          handler({ lang, query: {}, path: "/guide-mat-ai", headers: {} }, res);
          return body;
        };
        const OVERCLAIM = /full prisliste|full priset|komplett(e)? produktkatalog|prisede produkter|full price list|full(y)? priced|complete product catalog|from priced products/i;
        for (const payments of [undefined, "1"]) {
          setEnv("PAYMENTS_ENABLED", payments);
          for (const lang of ["no", "en"] as const) {
            const body = render(lang);
            const faq = ldBlocks(body).find((b) => b["@type"] === "FAQPage");
            assertTrue(body.includes("<h1>") && !OVERCLAIM.test(body) && !!faq && !OVERCLAIM.test(JSON.stringify(faq)),
              `ip-e1 (MCP2-02, ${lang}, payments ${payments ?? "off"}): no «full prisliste» / "full price list" in the page or its JSON-LD`);
          }
        }
        setEnv("PAYMENTS_ENABLED", undefined);
        const card = (body: string, tool: string): string =>
          unescapeHtml((body.match(new RegExp(`<div class="gma-tool"><code>${tool}</code><p>([^<]*)</p></div>`)) || [])[1] || "");
        const no = render("no");
        const en = render("en");
        const NO_PRICE = "med pris der produsenten har oppgitt den";
        const EN_PRICE = "with a price where the producer has stated one";
        assertTrue(card(no, "lokal_search").includes(NO_PRICE) && card(no, "lokal_info").includes(NO_PRICE),
          "ip-e2: the NO lokal_search and lokal_info cards say «med pris der produsenten har oppgitt den»");
        assertTrue(card(en, "lokal_search").includes(EN_PRICE) && card(en, "lokal_info").includes(EN_PRICE),
          "ip-e3: the EN cards say \"with a price where the producer has stated one\"");
        const faqNo = rfbSeo.buildMcpGuideFaqJsonLd("no", "u").mainEntity[1].acceptedAnswer.text as string;
        const faqEn = rfbSeo.buildMcpGuideFaqJsonLd("en", "u").mainEntity[1].acceptedAnswer.text as string;
        assertTrue(faqNo.includes(`lokal_info returnerer produktene og kontaktinfo for én produsent, ${NO_PRICE}`)
          && faqEn.includes(`lokal_info returns a producer's listed products, ${EN_PRICE}, and contact details`),
          "ip-e4: the tools FAQ answer (and so the JSON-LD) words lokal_info's prices the same way in NO and EN");
        const faqLd = ldBlocks(no).find((b) => b["@type"] === "FAQPage");
        assertTrue(!!faqLd && same(visibleFaq(no, "gma-faq-item"), faqLd.mainEntity.map((q: any) => [q.name, q.acceptedAnswer.text])),
          "ip-e5: the visible FAQ still equals the FAQPage JSON-LD");
        const defs = new Map(manifest.registeredMcpToolDefinitions("rfb").map((d) => [d.name, d.description]));
        assertTrue(["lokal_search", "lokal_info"].every((n) => /price included when the producer has written one/.test(defs.get(n) || "")),
          "ip-e6: the page matches the tools: lokal_search and lokal_info say a price is included only when the producer wrote one");
      }

      return { passed, failed, failures };
    } finally {
      setEnv("EXPERIENCES_DB_PATH", prev.db);
      setEnv("PAYMENTS_ENABLED", prev.payments);
      try {
        (require("../database/db-factory") as typeof import("../database/db-factory")).__resetDbFactoryForTesting();
      } catch { /* best-effort */ }
      restoreModuleCache();
    }
  })();
}

if (require.main === module) {
  runSeoSideteksterTests({ log: true }).then((result) => {
    console.log(`\n${result.passed} passed, ${result.failed} failed`);
    for (const f of result.failures) console.log(f);
    process.exit(result.failed > 0 ? 1 : 0);
  });
}
