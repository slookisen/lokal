/**
 * dental-helfo-claim.test.ts -- A2A dev-request
 * 2026-10-16-finn-tannlege-tillit-kilder-metode-ikon, F2-S6 (Daniel's answer
 * to question 24, 2026-10-19). The Helfo claim is shown only when
 * field_provenance.helfo_agreement holds a source that names where the value
 * was read (a non-blank source_type or source_url), the same rule as akutt.
 *   H   resolveHelfoClaim / shownHelfoAgreement: with and without a source,
 *       in the array, {sources} and legacy single-record form; records that
 *       name no source; malformed input throws nothing; the switch off.
 *   S   DENTAL_HELFO_CLAIM_SQL against resolveHelfoClaim on the same table
 *       of shapes, and the switch-off SQL is the SQL before F2-S6.
 *   R   the profile (badge, description, JSON-LD, the source line), the
 *       /sok card, /sok?helfo=1 and the front-page count;
 *   C   helfo_count, the area facts' helfo_true, the MCP search and detail
 *       cards, A2A, /api/tannlege/discover; GET /api/tannlege/agents and
 *       /agents/:id keep the stored value (F2-S7 is its own PR).
 *
 * Standalone: npx tsx src/routes/dental-helfo-claim.test.ts
 */

export interface TestSummary { passed: number; failed: number; failures: string[] }

function callRoute(router: any, path: string, query: Record<string, string> = {}): Promise<{ status: number; text: string; body: any }> {
  return new Promise((resolve) => {
    const req: any = { method: "GET", url: path, originalUrl: path, path, params: {}, query, headers: {}, get() { return undefined; } };
    const res: any = {
      statusCode: 200,
      status(c: number) { this.statusCode = c; return this; },
      setHeader() { return this; },
      set() { return this; },
      vary() { return this; },
      send(p: any) { resolve({ status: this.statusCode, text: String(p ?? ""), body: p }); return this; },
      json(p: any) { resolve({ status: this.statusCode, text: JSON.stringify(p), body: p }); return this; },
    };
    router.handle(req, res, (err?: any) => resolve({ status: err ? 500 : 404, text: String(err ?? "unhandled"), body: null }));
  });
}

export async function runDentalHelfoClaimTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0, failed = 0;
  const failures: string[] = [];
  const ok = (c: boolean, label: string) => {
    if (c) { passed++; if (log) console.log(`  ok ${label}`); }
    else { failed++; failures.push(`✗ ${label}`); if (log) console.log(`  ✗ ${label}`); }
  };
  const eq = (actual: unknown, expected: unknown, label: string) =>
    ok(JSON.stringify(actual) === JSON.stringify(expected), `${label} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
  const sorted = (xs: string[]) => [...xs].sort();

  const prev = process.env.DENTAL_DB_PATH;
  const prevDisabled = process.env.DENTAL_QUERY_PARSER_DISABLED;
  process.env.DENTAL_DB_PATH = ":memory:";
  delete process.env.DENTAL_QUERY_PARSER_DISABLED;
  const cachePaths = [
    require.resolve("../database/db-factory"),
    require.resolve("../services/dental-store"),
    require.resolve("../services/dental-area-facts"),
    require.resolve("../services/dental-search-gazetteer"),
    require.resolve("./dental-seo"),
    require.resolve("./dental-mcp"),
    require.resolve("./dental-a2a"),
    require.resolve("./dental"),
  ];
  const restoreModuleCache = (require("../../tests/module-cache") as typeof import("../../tests/module-cache")).swapOutModules(cachePaths);
  const { analyticsService } = require("../services/analytics-service") as typeof import("../services/analytics-service");
  const realLogWebSearch = analyticsService.logWebSearch;
  (analyticsService as any).logWebSearch = () => {};

  try {
    // ── H: the pure functions ──
    const claim = require("../services/dental-helfo-claim") as typeof import("../services/dental-helfo-claim");
    const src = { value: "true", source_type: "homepage", source_url: "https://example.no/helfo", fetched_at: "2026-09-15T10:00:00.000Z" };
    const has = (fp: unknown, helfo: string | null = "true") => claim.resolveHelfoClaim({ helfo_agreement: helfo, field_provenance: fp as any }) !== null;

    ok(claim.HELFO_CLAIM_REQUIRES_SOURCE === true, "H0: the switch is on by default");
    ok(has({ helfo_agreement: [src] }), "H1: 'true' with a source in the array form -> a claim");
    ok(has({ helfo_agreement: { sources: [{ ...src, source_type: "stage_v_correction", source_url: undefined }] } }), "H2: the {sources} form (stage_v_correction, no URL) -> a claim");
    ok(has({ helfo_agreement: src }), "H3: a legacy single record (coerceProvenanceToArrayShape) -> a claim");
    ok(has({ helfo_agreement: [{ value: "true", source_type: "homepage" }] }) && has({ helfo_agreement: [{ value: "true", source_url: "https://example.no" }] }),
      "H4: a source_type alone, or a source_url alone, names the source");
    ok(!has(null) && !has(undefined) && !has({}) && !has({ telefon: [src] }), "H5: no provenance, or provenance for another field only -> no claim");
    ok(!has({ helfo_agreement: [] }) && !has({ helfo_agreement: { sources: [] } }) && !has({ helfo_agreement: {} }) && !has({ helfo_agreement: [{}] }) && !has({ helfo_agreement: { sources: [{}] } }),
      "H6: empty lists and records -> no claim");
    ok(!has({ helfo_agreement: [{ value: "true", source_type: " \n\t ", source_url: "", fetched_at: "2026-09-15T10:00:00.000Z" }] }),
      "H7: a record with only blanks and a fetch date names no source -> no claim");
    ok(!has({ helfo_agreement: [{ value: "true", source_type: 1, source_url: ["https://example.no"] }] }) && !has({ helfo_agreement: ["homepage", ["homepage"], null, 1] }),
      "H8: a non-string source_type/source_url, or entries that are no records -> no claim");
    ok(!has({ helfo_agreement: { sources: "homepage", source_type: "homepage" } }) && !has({ helfo_agreement: { sources: null, source_type: "homepage" } }),
      "H9: an object with a `sources` key that is no array is no source, even beside a source_type");
    ok(has({ helfo_agreement: [{}, src] }) && has({ helfo_agreement: { sources: [{ source_type: " " }, src] } }), "H10: one source of several is enough");
    ok(!has({ helfo_agreement: [src] }, "false") && !has({ helfo_agreement: [src] }, "unknown") && !has({ helfo_agreement: [src] }, null),
      "H11: anything other than 'true' is no claim, with a source too");
    let threw = "";
    try {
      for (const fp of ["{bad", "[]", 7, [], [{ helfo_agreement: [src] }], { helfo_agreement: "homepage" }, { helfo_agreement: null }, { helfo_agreement: 1 }]) {
        if (has(fp)) threw += `claim for ${JSON.stringify(fp)}; `;
      }
    } catch (err: any) {
      threw = String(err?.message || err);
    }
    eq(threw, "", "H12: malformed provenance (a string, an array, scalar entries) throws nothing and is no claim");
    eq(claim.resolveHelfoClaim({ helfo_agreement: "true", field_provenance: { helfo_agreement: [{}, src] } })?.sources, [src], "H13: the claim carries the sources that name where it was read");
    eq([
      claim.shownHelfoAgreement({ helfo_agreement: "true", field_provenance: { helfo_agreement: [src] } }),
      claim.shownHelfoAgreement({ helfo_agreement: "true", field_provenance: null }),
      claim.shownHelfoAgreement({ helfo_agreement: "false", field_provenance: null }),
      claim.shownHelfoAgreement({ helfo_agreement: "unknown", field_provenance: null }),
      claim.shownHelfoAgreement({ helfo_agreement: undefined, field_provenance: null }),
    ], ["true", "unknown", "false", "unknown", undefined], "H14: shownHelfoAgreement: 'unknown' for a 'true' without a source, else the stored value");
    ok(claim.resolveHelfoClaim({ helfo_agreement: "true", field_provenance: null }, false) !== null &&
      claim.resolveHelfoClaim({ helfo_agreement: "false", field_provenance: { helfo_agreement: [src] } }, false) === null &&
      claim.shownHelfoAgreement({ helfo_agreement: "true", field_provenance: null }, false) === "true",
      "H15: with the switch off, 'true' alone is the claim, as before F2-S6");
    eq(claim.dentalHelfoClaimSql(false), "helfo_agreement = 'true'", "H16: with the switch off, the SQL is the clause before F2-S6");
    eq(claim.dentalHelfoClaimSql(), claim.DENTAL_HELFO_CLAIM_SQL, "H17: with the switch on, the SQL is DENTAL_HELFO_CLAIM_SQL");

    // ── S: the SQL twin against resolveHelfoClaim ──
    const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
    dbFactory.__resetDbFactoryForTesting();
    const db = dbFactory.getDb("dental");
    const store = require("../services/dental-store") as typeof import("../services/dental-store");
    (require("../services/dental-search-gazetteer") as typeof import("../services/dental-search-gazetteer")).__resetDentalSearchGazetteerForTesting();
    {
      const provenances: Array<string | null> = [
        null, "", "{bad", "[]", '"homepage"', "7", "{}", '{"telefon":[{"source_type":"brreg"}]}',
        '{"helfo_agreement":null}', '{"helfo_agreement":"homepage"}', '{"helfo_agreement":1}', '{"helfo_agreement":[]}', '{"helfo_agreement":[null]}',
        JSON.stringify({ helfo_agreement: [src] }), JSON.stringify({ helfo_agreement: src }), '{"helfo_agreement":{}}',
        '{"helfo_agreement":{"sources":[]}}', '{"helfo_agreement":{"sources":"x"}}', '{"helfo_agreement":{"sources":null,"source_type":"homepage"}}',
        '{"helfo_agreement":{"sources":{"a":{"source_type":"homepage"}}}}', '{"helfo_agreement":{"sources":[{"source_type":"stage_v_correction"}]}}',
        '{"helfo_agreement":{"sources":[{}]}}', '{"helfo_agreement":[{}]}', '{"helfo_agreement":[{"source_type":""}]}',
        '{"helfo_agreement":[{"source_type":"   "}]}', '{"helfo_agreement":[{"source_type":"\\n\\t\\u00a0\\u2003\\u3000\\ufeff"}]}',
        '{"helfo_agreement":[{"source_type":"\\u200b"}]}', '{"helfo_agreement":[{"source_url":" https://example.no "}]}',
        '{"helfo_agreement":[{"source_type":1}]}', '{"helfo_agreement":[{"source_type":true}]}', '{"helfo_agreement":[{"source_type":null}]}',
        '{"helfo_agreement":[{"source_type":["homepage"]}]}', '{"helfo_agreement":[{"source_url":{"href":"x"}}]}', '{"helfo_agreement":[{"Source_type":"homepage"}]}',
        '{"helfo_agreement":[{"fetched_at":"2026-09-15T10:00:00Z","value":"true"}]}', '{"helfo_agreement":["homepage"]}', '{"helfo_agreement":[["source_type","homepage"]]}',
        '{"helfo_agreement":[{"source_type":" "},{"source_type":"homepage"}]}', '{"helfo_agreement":{"source_type":"homepage","value":"true"}}',
        '{"helfo_agreement":{"source_url":"https://example.no"}}', '{"helfo_agreement":{"source_type":" "}}', '{"helfo_agreement":{"a":{"source_type":"homepage"}}}',
        '[{"helfo_agreement":[{"source_type":"homepage"}]}]', '{"helfo_agreement":[{"source_type":"homepage"}]', '{"helfo_agreement_note":[{"source_type":"homepage"}]}',
      ];
      const values: Array<string | null> = ["true", "false", "unknown", null, "TRUE"];
      const ins = db.prepare("INSERT INTO dental_agents (id, navn, helfo_agreement, field_provenance) VALUES (?,?,?,?)");
      let i = 0;
      db.transaction(() => {
        for (const fp of provenances) for (const v of values) ins.run(`hpar-${i}`, `Hpar ${i++}`, v, fp);
      })();
      const all = (db.prepare("SELECT id FROM dental_agents WHERE id LIKE 'hpar-%'").all() as Array<{ id: string }>).map((r) => r.id);
      const rowOf = new Map(all.map((id) => [id, store.getDentalAgentById(id)!]));
      let sqlIds: string[] = [];
      let sqlThrew = "";
      try {
        sqlIds = (db.prepare(`SELECT id FROM dental_agents WHERE id LIKE 'hpar-%' AND ${claim.DENTAL_HELFO_CLAIM_SQL}`).all() as Array<{ id: string }>).map((r) => r.id);
      } catch (err: any) {
        sqlThrew = String(err?.message || err);
      }
      eq(sqlThrew, "", "S1: malformed JSON raises no SQL error");
      const jsIds = all.filter((id) => claim.resolveHelfoClaim(rowOf.get(id)!) !== null);
      ok(all.length === provenances.length * values.length && jsIds.length > 0 && jsIds.length < all.length,
        `S0: (the shape table has ${all.length} rows, ${jsIds.length} with a claim)`);
      eq(sorted(sqlIds), sorted(jsIds), "S2: DENTAL_HELFO_CLAIM_SQL picks exactly the rows where resolveHelfoClaim is not null");
      const offSql = (db.prepare(`SELECT id FROM dental_agents WHERE id LIKE 'hpar-%' AND ${claim.dentalHelfoClaimSql(false)}`).all() as Array<{ id: string }>).map((r) => r.id);
      const offJs = all.filter((id) => claim.resolveHelfoClaim(rowOf.get(id)!, false) !== null);
      eq(sorted(offSql), sorted(offJs), "S3: with the switch off, SQL and JS pick the same rows ('true' alone)");
      ok(jsIds.every((id) => offJs.includes(id)) && offJs.length > jsIds.length, "S4: the source rule only hides claims, never adds one");
      db.prepare("DELETE FROM dental_agents WHERE id LIKE 'hpar-%'").run();
    }

    // ── R / C: the surfaces, one place with sourced and unsourced clinics ──
    const seo = require("./dental-seo") as typeof import("./dental-seo");
    const mcp = require("./dental-mcp") as typeof import("./dental-mcp");
    const a2a = require("./dental-a2a") as typeof import("./dental-a2a");
    const dentalRouter = (require("./dental") as typeof import("./dental")).default as any;
    const card = require("../services/dental-clinic-card") as typeof import("../services/dental-clinic-card");
    const areaFacts = require("../services/dental-area-facts") as typeof import("../services/dental-area-facts");
    const router = seo.default as any;

    const mk = (navn: string, org: string, helfo: string, fp: object | null): { id: string; slug: string; org: string; navn: string } => {
      const id = store.createDentalAgent({
        navn, org_nr: org, poststed: "HELFOBY", fylke: "Oslo", adresse: "Storgata 1",
        telefon: "22110099", hjemmeside: "https://example.no",
      } as any);
      db.prepare("UPDATE dental_agents SET catalog_class='klinikk', helfo_agreement=?, field_provenance=? WHERE id=?")
        .run(helfo, fp ? JSON.stringify(fp) : null, id);
      return { id, slug: seo.slugifyClinic(navn, org), org, navn };
    };
    const A = mk("Helfo Med Kilde Tannklinikk AS", "918870001", "true", { helfo_agreement: [src] });
    const B = mk("Helfo Objekt Kilde Tannklinikk AS", "918870002", "true", { helfo_agreement: { sources: [{ value: "true", source_type: "stage_v_correction", fetched_at: "2026-09-16T10:00:00.000Z" }] } });
    const U = mk("Helfo Uten Kilde Tannklinikk AS", "918870003", "true", null);
    const D = mk("Helfo Bare Dato Tannklinikk AS", "918870004", "true", { helfo_agreement: [{ value: "true", fetched_at: "2026-09-15T10:00:00.000Z" }] });
    const N = mk("Helfo Nei Tannklinikk AS", "918870005", "false", { helfo_agreement: [{ ...src, value: "false" }] });
    const sourced = [A, B], unsourced = [U, D];

    // Profile: badge, description (meta and JSON-LD), the source line.
    const page = async (c: { slug: string }) => (await callRoute(router, `/klinikk/${c.slug}`)).text;
    const jsonLd = (html: string) => [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => m[1]).join("\n");
    for (const c of sourced) {
      const html = await page(c);
      ok(html.includes(`<span class="badge badge-helfo">Helfo-direkteoppgjør</span>`), `R1: ${c.navn}: the profile shows the Helfo badge`);
      ok(jsonLd(html).includes("Klinikken har Helfo-direkteoppgjørsavtale.") && /<meta name="description" content="[^"]*Klinikken har Helfo-direkteoppgjørsavtale/.test(html),
        `R2: ${c.navn}: the description and JSON-LD say Helfo, as before`);
      ok(html.includes("<li>Helfo-direkteoppgjør: tolket automatisk fra klinikkens nettside"), `R3: ${c.navn}: the source line is there (F2-S3)`);
    }
    for (const c of [...unsourced, N]) {
      const html = await page(c);
      // The profile's own badge; the cards of nearby clinics on the page may carry theirs.
      ok(!html.includes(`badge-helfo">Helfo-direkteoppgjør<`), `R4: ${c.navn}: no Helfo badge on the profile`);
      ok(jsonLd(html).length > 0 && !jsonLd(html).includes("Klinikken har Helfo") && !html.includes("Klinikken har Helfo"),
        `R5: ${c.navn}: no Helfo sentence in the description or JSON-LD`);
      ok(!html.includes("<li>Helfo-direkteoppgjør:"), `R6: ${c.navn}: no Helfo source line`);
    }

    // /sok card and /sok?helfo=1.
    const list = (await callRoute(router, "/sok")).text;
    const cardOf = (html: string, name: string) => { const i = html.indexOf(name); return i < 0 ? "" : html.slice(i, i + 3000).split("</article>")[0]; };
    for (const c of sourced) ok(cardOf(list, c.navn).includes(`<span class="badge badge-helfo">Helfo-avtale</span>`), `R7: ${c.navn}: the /sok card shows «Helfo-avtale»`);
    for (const c of [...unsourced, N]) {
      const cc = cardOf(list, c.navn);
      ok(cc.length > 0 && !cc.includes("badge-helfo"), `R8: ${c.navn}: listed on /sok, with no Helfo badge`);
    }
    const helfoList = (await callRoute(router, "/sok", { helfo: "1" })).text;
    ok(sourced.every((c) => helfoList.includes(c.navn)) && [...unsourced, N].every((c) => !helfoList.includes(c.navn)),
      "R9: /sok?helfo=1 lists the sourced clinics and none without a source");

    // Counts: helfo_count, the front page, the area facts, the public count.
    const stats = store.getDentalStats();
    eq(stats.helfo_count, sourced.length, "C1: getDentalStats().helfo_count counts only the sourced clinics");
    eq(store.countPublicDentalAgents({ helfo_agreement: "true" } as any), sourced.length, "C2: countPublicDentalAgents({ helfo_agreement: 'true' }) is the same number");
    const front = (await callRoute(router, "/")).text;
    ok(front.includes(`<div class="stat-val">${stats.helfo_count.toLocaleString("nb")}</div><div class="stat-lbl">Med Helfo-avtale</div>`),
      "R10: the front page's «Med Helfo-avtale» is helfo_count");
    areaFacts.__resetDentalAreaFactsForTesting();
    const helfoby = areaFacts.getDentalAreaFacts().byPoststed.get("HELFOBY");
    eq(helfoby?.helfo_true, sourced.length, "C3: the area facts' helfo_true counts only the sourced clinics");
    const unknownIds = store.listPublicDentalAgents({ helfo_agreement: "unknown" } as any, 50).map((a) => a.id);
    ok(unsourced.every((c) => unknownIds.includes(c.id)) && !sourced.some((c) => unknownIds.includes(c.id)) && !unknownIds.includes(N.id),
      "C4: a public 'unknown' filter finds the unsourced 'true' clinics, which answer 'unknown'");

    // MCP cards.
    const results = mcp.buildSearchResults([A, B, U, D, N].map((x) => store.getDentalAgentById(x.id)!) as any);
    const byName = (n: string) => results.find((r: any) => r.navn === n)!;
    for (const c of sourced) {
      const r = byName(c.navn);
      ok(r.helfo_agreement === "true" && r.badges.includes("Helfo-avtale"), `C5: ${c.navn}: MCP search card helfo_agreement 'true' with the badge`);
    }
    for (const c of unsourced) {
      const r = byName(c.navn);
      ok(r.helfo_agreement === "unknown" && !r.badges.includes("Helfo-avtale"), `C6: ${c.navn}: MCP search card helfo_agreement 'unknown', no badge`);
    }
    ok(byName(N.navn).helfo_agreement === "false" && !byName(N.navn).badges.includes("Helfo-avtale"), "C7: a 'false' clinic keeps 'false', no badge");
    const detail = (c: { id: string }) => card.toDentalClinicCard(store.getDentalAgentById(c.id)! as any, "detail", { specialists: [] });
    ok(detail(A).helfo_agreement === "true" && detail(A).badges.includes("Helfo-avtale") && detail(U).helfo_agreement === "unknown" && !detail(U).badges.includes("Helfo-avtale"),
      "C8: tannlege_info's detail card: 'true' with a source, 'unknown' without");
    eq(Object.keys(detail(U)), Object.keys(detail(A)), "C9: the detail card has the same keys with and without a source");

    // MCP tannlege_search's `helfo` filter goes through the same store filter.
    const planned = store.listPublicDentalAgents({ helfo_agreement: "true", poststed: "HELFOBY" } as any, 50).map((a) => a.id);
    eq(sorted(planned), sorted(sourced.map((c) => c.id)), "C10: the public helfo filter (MCP `helfo`, A2A, /discover) lists only the sourced clinics");

    // A2A.
    const a2aClinic = (c: { id: string }) => card.toDentalA2aClinic(store.getDentalAgentById(c.id)! as any) as any;
    ok(a2aClinic(A).helfo_agreement === "true" && a2aClinic(U).helfo_agreement === "unknown" && !a2aClinic(U).badges.includes("Helfo-avtale"),
      "C11: toDentalA2aClinic: 'true' with a source, 'unknown' and no badge without");
    eq(Object.keys(a2aClinic(U)), Object.keys(a2aClinic(A)), "C12: the A2A clinic has the same keys, in the same order, with and without a source");
    const a2aSearch = a2a.handleDentalMessageSend({ message: { parts: [{ kind: "data", data: { helfo_agreement: "true" } }] } }, 1) as any;
    const a2aIds = (a2aSearch?.result?.artifacts ?? []).flatMap((art: any) => (art.parts ?? []).flatMap((p: any) => (p.data?.clinics ?? []).map((cl: any) => cl.id)));
    eq(sorted(a2aIds), sorted(sourced.map((c) => c.id)), "C13: A2A message/send with helfo_agreement 'true' lists only the sourced clinics");

    // /api/tannlege/discover.
    const discover = await callRoute(dentalRouter, "/discover", { helfo: "true" });
    const discoverIds = (discover.body?.results ?? []).map((r: any) => r.id);
    eq(sorted(discoverIds), sorted(sourced.map((c) => c.id)), "C14: /api/tannlege/discover?helfo=true lists only the sourced clinics");
    const discoverAll = await callRoute(dentalRouter, "/discover", { poststed: "HELFOBY" });
    const discoverOf = (id: string) => (discoverAll.body?.results ?? []).find((r: any) => r.id === id);
    ok(discoverOf(A.id)?.helfo_agreement === "true" && discoverOf(U.id)?.helfo_agreement === "unknown" && !discoverOf(U.id)?.badges.includes("Helfo-avtale"),
      "C15: /api/tannlege/discover gives 'unknown' and no badge without a source");

    // GET /api/tannlege/agents and /agents/:id keep the stored value (F2-S7).
    const rawList = await callRoute(dentalRouter, "/agents", { helfo_agreement: "true" });
    const rawAgents: any[] = rawList.body?.agents ?? rawList.body?.results ?? (Array.isArray(rawList.body) ? rawList.body : []);
    const rawIds = rawAgents.map((a: any) => a.id);
    ok(rawList.status === 200 && [...sourced, ...unsourced].every((c) => rawIds.includes(c.id)),
      `C16: GET /api/tannlege/agents?helfo_agreement=true still lists every stored 'true' (${rawList.status})`);
    ok(rawAgents.filter((a: any) => unsourced.some((c) => c.id === a.id)).every((a: any) => a.helfo_agreement === "true"),
      "C17: ... with the stored helfo_agreement");
    const rawOne = await new Promise<{ status: number; body: any }>((resolve) => {
      const req: any = { method: "GET", url: `/agents/${U.id}`, originalUrl: `/agents/${U.id}`, path: `/agents/${U.id}`, params: {}, query: {}, headers: {}, get() { return undefined; } };
      const res: any = {
        statusCode: 200,
        status(c: number) { this.statusCode = c; return this; },
        setHeader() { return this; }, set() { return this; }, vary() { return this; },
        send(p: any) { resolve({ status: this.statusCode, body: p }); return this; },
        json(p: any) { resolve({ status: this.statusCode, body: p }); return this; },
      };
      dentalRouter.handle(req, res, () => resolve({ status: 404, body: null }));
    });
    const rawOneAgent = rawOne.body?.agent ?? rawOne.body;
    ok(rawOne.status === 200 && rawOneAgent?.helfo_agreement === "true", `C18: GET /api/tannlege/agents/:id keeps the stored 'true' (${rawOne.status})`);
  } catch (err: any) {
    failed++;
    failures.push("dental helfo claim: unexpected error: " + String(err?.stack || err?.message || err));
  } finally {
    (analyticsService as any).logWebSearch = realLogWebSearch;
    if (prev === undefined) delete process.env.DENTAL_DB_PATH; else process.env.DENTAL_DB_PATH = prev;
    if (prevDisabled === undefined) delete process.env.DENTAL_QUERY_PARSER_DISABLED; else process.env.DENTAL_QUERY_PARSER_DISABLED = prevDisabled;
    try { (require("../database/db-factory") as typeof import("../database/db-factory")).__resetDbFactoryForTesting(); } catch { /* best-effort */ }
    restoreModuleCache();
  }
  return { passed, failed, failures };
}

if (require.main === module) {
  runDentalHelfoClaimTests({ log: true }).then((r) => {
    console.log(`\n${r.passed} passed, ${r.failed} failed`);
    process.exit(r.failed > 0 ? 1 : 0);
  });
}
