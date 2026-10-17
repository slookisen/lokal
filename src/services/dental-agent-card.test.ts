/**
 * dental-agent-card.test.ts — A2A dev-request 2026-10-17-dental-d3-rettelser,
 * D3d point 4 (FUNN a2a-agentkort-skilltekster).
 *
 * The A2A agent card's skill texts (services/dental-agent-card.ts) say what
 * message/send in routes/dental-a2a.ts does, checked against that handler on
 * an in-memory fixture DB. Groups, by prefix:
 *   U   unchanged: skill ids, names, input/output modes and keys, the search
 *       examples, the number of examples, and x-mcp-tools (the registered
 *       MCP tools);
 *   R   every example, and every request a description quotes «like this»,
 *       is answered by that skill when sent as text; each search finds
 *       clinics, each lookup finds its clinic;
 *   F   each message.data key the search text names is read (echoed in
 *       metadata.filter), also fylke + specialty + helfo_agreement together;
 *       the keys the old text named (spesialitet, helfo, akutt) give filter {}
 *       and are not named; a data part in `parts` is not read, as the text
 *       says;
 *   P   the page size the search text gives is the answer's count, total
 *       counts every match, and the statistics are for all of Norway;
 *   T   the text rules: a search word in the first sentence, violations()
 *       from the MCP descriptions without the figure rule, no number of
 *       three or more digits, the words the dev-request asks for and none it
 *       rules out, no { "org_nr" } example, «det norske tannlegemarkedet»;
 *   N   the checks are not vacuous: the skill texts before D3d fail them;
 *   W   GET /.well-known/agent-card.json and GET /a2a serve the same skills.
 *
 * Standalone: npx tsx src/services/dental-agent-card.test.ts
 * Wired into tests/test.ts via runDentalAgentCardTests().
 */

import express from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { SEARCH_WORDS, violations } from "../routes/dental-mcp-instructions.test";

export interface TestSummary { passed: number; failed: number; failures: string[] }

interface Skill { id: string; name: string; description: string; inputModes: string[]; outputModes: string[]; examples: string[] }

/** What D3d leaves as it was: per skill, its id, name and modes. */
const UNCHANGED_SKILLS = [
  { id: "tannlege_search", name: "Søk tannlegeklinikker / Search dental clinics", inputModes: ["text/plain", "application/json"], outputModes: ["application/json"] },
  { id: "tannlege_info", name: "Hent klinikkdetaljer / Get clinic details", inputModes: ["application/json"], outputModes: ["application/json"] },
  { id: "tannlege_stats", name: "Aggregert statistikk / Aggregated statistics", inputModes: ["text/plain", "application/json"], outputModes: ["application/json"] },
];
const SKILL_KEYS = ["id", "name", "description", "inputModes", "outputModes", "examples"];
/** The search examples, which dental-natural-search A1/A14 and dental-query-parser K read too. */
const SEARCH_EXAMPLES = ["finn tannlege med helfo-avtale i Oslo", "akuttvakt tannlege Stavanger", "find orthodontist in Bergen", "kjeveortoped Trondheim"];

/** The message.data keys handleDentalMessageSend reads, with a value each that the fixture has clinics for. */
const DATA_KEY_VALUES: Record<string, unknown> = { fylke: "Trøndelag", specialty: "kjeveortopedi", helfo_agreement: "true", acute_vakt: 1, q: "Trondheim" };
/** The org.nr in the tannlege_info examples. */
const EXAMPLE_ORG_NR = "912345678";

/** Phrases the search text must not have (the old parameter list) and an { "org_nr" } JSON example. */
const RULED_OUT = ["matches name/city", "spesialitet (", "akutt (1"];
const ORG_NR_JSON = /\{\s*"org_nr"/;
/** The old parameter names, as a key (`helfo`) or followed by their explanation («helfo (»). */
const OLD_KEY_NAMES = /`(spesialitet|helfo|akutt)`|\b(spesialitet|helfo|akutt) \(/i;

/** The skill texts before D3d, for N (the checks catch what the FUNN describes). */
const SKILLS_BEFORE_D3D: Array<Pick<Skill, "id" | "description" | "examples">> = [
  {
    id: "tannlege_search",
    description:
      "Søk blant norske tannlegeklinikker med fritekst og/eller strukturerte filtre. " +
      "Search Norwegian dental clinics using free text and/or structured filters. " +
      "Parameters: q (free text, matches name/city), fylke (county name, e.g. «Oslo», «Vestland»), " +
      "spesialitet (specialty, e.g. «kjeveortopedi», «endodonti»), " +
      "helfo («true» = Helfo direct-billing agreement only), " +
      "akutt (1 = emergency duty clinics only). " +
      "Eksempel / Example: «finn tannlege med Helfo-avtale i Bergen», " +
      "\"find orthodontist in Trondheim\".",
    examples: SEARCH_EXAMPLES,
  },
  {
    id: "tannlege_info",
    description:
      "Hent fullstendig profil for én tannlegeklinikk via organisasjonsnummer. " +
      "Fetch full profile for a single dental clinic by organisation number (org_nr). " +
      "Returns: name, address, county, phone, website, Helfo status, emergency duty, " +
      "specialities, chain affiliation, and enrichment metadata. " +
      "Parameter: org_nr (9-digit Norwegian organisation number). " +
      "Eksempel / Example: org_nr «912345678».",
    examples: ["{ \"org_nr\": \"912345678\" }", "hent klinikk med orgnr 912345678"],
  },
  {
    id: "tannlege_stats",
    description:
      "Hent aggregerte nøkkeltall for den norske tannlegemarkedet. " +
      "Fetch aggregated key figures for the Norwegian dental market. " +
      "Returns: total clinic count, per-county breakdown, Helfo count, chain count, " +
      "emergency-duty count, and specialist-clinic count. " +
      "Eksempel / Example: «hvor mange tannleger finnes det i Norge?», " +
      "\"how many dental clinics have Helfo agreement?\".",
    examples: ["hvor mange tannleger er det i Norge totalt?", "statistikk per fylke", "how many clinics have Helfo agreement?"],
  },
];

/** The requests a description quotes «like this». */
function quotedRequests(description: string): string[] {
  return [...description.matchAll(/«([^»]+)»/g)].map((m) => m[1]!);
}

/** The keys the description names for `message.data`: from that name to the end of its list (the next «;»). */
function dataKeysNamed(description: string): string[] {
  const at = description.indexOf("`message.data`");
  if (at < 0) return [];
  const end = description.indexOf(";", at);
  return [...description.slice(at, end < 0 ? undefined : end).matchAll(/`([a-z_]+)`/g)].map((m) => m[1]!);
}

function getJson(base: string, path: string): Promise<{ status: number; body: any }> {
  return fetch(`${base}${path}`).then(async (r) => ({ status: r.status, body: await r.json() }));
}

export async function runDentalAgentCardTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];
  const ok = (cond: boolean, label: string) => {
    if (cond) { passed++; if (log) console.log(`  ok ${label}`); }
    else { failed++; failures.push(`✗ ${label}`); if (log) console.log(`  ✗ ${label}`); }
  };
  const eq = (actual: unknown, expected: unknown, label: string) =>
    ok(JSON.stringify(actual) === JSON.stringify(expected), `${label} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);

  const prevDentalPath = process.env.DENTAL_DB_PATH;
  const prevDbPath = process.env.DB_PATH;
  process.env.DENTAL_DB_PATH = ":memory:";
  process.env.DB_PATH = ":memory:";
  const cachePaths = [
    require.resolve("../database/db-factory"),
    require.resolve("./dental-store"),
    require.resolve("./dental-catalog-class"),
    require.resolve("./dental-search-gazetteer"),
    require.resolve("../routes/dental-seo"),
    require.resolve("../routes/dental-a2a"),
  ];
  const restoreModuleCache = (require("../../tests/module-cache") as typeof import("../../tests/module-cache")).swapOutModules(cachePaths);
  let server: http.Server | undefined;

  try {
    const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
    dbFactory.__resetDbFactoryForTesting();
    const db = dbFactory.getDb("dental");
    const store = require("./dental-store") as typeof import("./dental-store");
    (require("./dental-search-gazetteer") as typeof import("./dental-search-gazetteer")).__resetDentalSearchGazetteerForTesting();
    const a2a = require("../routes/dental-a2a") as typeof import("../routes/dental-a2a");
    const { getDentalAgentCard } = require("./dental-agent-card") as typeof import("./dental-agent-card");
    const { shortToolDescription, registeredMcpToolNames } = require("./mcp-tool-manifest") as typeof import("./mcp-tool-manifest");

    // ── Fixture ───────────────────────────────────────────────────────────
    // A clinic for each search example and for every message.data key, the
    // tannlege_info example's org.nr, and more clinics than one answer lists.
    const add = (row: Record<string, unknown>, extra: Record<string, unknown> = {}): string => {
      const id = store.createDentalAgent({ telefon: "22000000", ...row } as any);
      const cols = Object.keys(extra);
      if (cols.length) db.prepare(`UPDATE dental_agents SET ${cols.map((c) => `${c} = @${c}`).join(", ")} WHERE id = @id`).run({ ...extra, id });
      return id;
    };
    add({ navn: "Oslo Helfo Tann", poststed: "OSLO", fylke: "Oslo", postnummer: "0150", helfo_agreement: "true" });
    add({ navn: "Stavanger Akuttvakt", poststed: "STAVANGER", fylke: "Rogaland", postnummer: "4006" },
      { acute_vakt: 1, field_provenance: JSON.stringify({ acute_vakt: [{ source_type: "homepage", value: 1 }] }) });
    add({ navn: "Bergen Regulering", poststed: "BERGEN", fylke: "Vestland", postnummer: "5003", available_specialties: ["kjeveortopedi"] });
    add({ navn: "Trondheim Regulering", poststed: "TRONDHEIM", fylke: "Trøndelag", postnummer: "7010", helfo_agreement: "true", available_specialties: ["kjeveortopedi"] });
    add({ navn: "Eksempelklinikken", org_nr: EXAMPLE_ORG_NR, poststed: "HAMAR", fylke: "Innlandet", postnummer: "2317" });
    for (let i = 0; i < 20; i++) add({ navn: `Fyll Tann ${i}`, poststed: "HAMAR", fylke: "Innlandet", postnummer: "2317" });
    const publicCount = store.countPublicDentalAgents({});

    const card = getDentalAgentCard() as { skills: Skill[]; "x-mcp-tools": string[] };
    const skills = card.skills;
    const skill = (id: string) => skills.find((s) => s.id === id)!;
    const send = (message: unknown) => a2a.handleDentalMessageSend({ message }, "agent-card-test") as any;
    const searchData = (resp: any) => resp.result?.artifacts?.find((a: any) => a.name === "dental-search-results")?.parts?.[0]?.data;
    const dentalTools = registeredMcpToolNames("dental");

    // ── U: what D3d leaves as it was ──────────────────────────────────────
    eq(skills.map(({ id, name, inputModes, outputModes }) => ({ id, name, inputModes, outputModes })), UNCHANGED_SKILLS, "U1: skill ids, names and input/output modes are unchanged");
    ok(skills.every((s) => JSON.stringify(Object.keys(s)) === JSON.stringify(SKILL_KEYS)), "U2: every skill keeps its keys, in order");
    eq(skill("tannlege_search").examples, SEARCH_EXAMPLES, "U3: the four search examples are unchanged");
    eq(skills.map((s) => s.examples.length), [4, 2, 3], "U4: the number of examples per skill is unchanged");
    eq(card["x-mcp-tools"], dentalTools, "U5: x-mcp-tools is the registered MCP tools");

    // ── R: each example and quoted request is answered by its skill ───────
    for (const s of skills) {
      const quoted = quotedRequests(s.description);
      for (const text of [...s.examples, ...quoted]) {
        const resp = send({ text });
        const source = s.examples.includes(text) ? "example" : "quoted request";
        eq(resp.result?.metadata?.skill, s.id, `R1 ${s.id}: the ${source} «${text}» sent as text is answered by ${s.id}`);
        if (s.id === "tannlege_search") ok((searchData(resp)?.count ?? 0) > 0, `R2: the ${source} «${text}» finds clinics (${searchData(resp)?.count})`);
        if (s.id === "tannlege_info") {
          const part = resp.result?.artifacts?.[0]?.parts?.[0];
          eq([part?.kind, part?.data?.org_nr], ["data", EXAMPLE_ORG_NR], `R3: the example «${text}» gets the clinic with that org.nr`);
        }
      }
      if (s.id !== "tannlege_info") ok(quoted.length > 0, `R4 ${s.id}: the description quotes at least one request (R1 is not vacuous)`);
    }
    eq(quotedRequests(skill("tannlege_info").description), [], "R5: tannlege_info quotes no request (it would need the org.nr's digits)");

    // ── F: message.data, as the search text names it ─────────────────────
    {
      const search = skill("tannlege_search").description;
      const named = dataKeysNamed(search);
      eq([...named].sort(), Object.keys(DATA_KEY_VALUES).sort(), "F1: the search text names exactly the message.data keys the handler reads");
      for (const key of named) {
        const value = DATA_KEY_VALUES[key];
        const resp = send({ data: { [key]: value } });
        eq(resp.result?.metadata?.filter, { [key]: value }, `F2 ${key}: message.data {${key}} is echoed in metadata.filter`);
        ok((searchData(resp)?.count ?? 0) > 0, `F3 ${key}: ... and finds clinics`);
      }
      const three = { fylke: "Trøndelag", specialty: "kjeveortopedi", helfo_agreement: "true" };
      const resp = send({ data: three });
      eq(resp.result?.metadata?.filter, three, "F4: message.data {fylke, specialty, helfo_agreement} echoes all three keys in metadata.filter");
      eq(searchData(resp)?.clinics?.map((c: any) => c.navn), ["Trondheim Regulering"], "F5: ... and finds the clinic that has all three");
      for (const [key, value] of [["spesialitet", "kjeveortopedi"], ["helfo", "true"], ["akutt", 1]] as const) {
        eq(send({ data: { [key]: value } }).result?.metadata?.filter, {}, `F6 ${key}: the old parameter name in message.data is not read (filter {})`);
      }
      eq(search.match(OLD_KEY_NAMES)?.[0] ?? null, null, "F7: the search text does not name spesialitet, helfo or akutt as a key");
      ok(search.includes("a data part in `parts` is not read"), "F8: the search text says that a data part is not read ...");
      eq(send({ parts: [{ kind: "data", data: { fylke: "Trøndelag" } }] }).result?.metadata?.filter, {}, "F9: ... and a data part in parts gives filter {}");
    }

    // ── P: page size, total, and statistics for all of Norway ─────────────
    {
      const pageSize = Number(skill("tannlege_search").description.match(/\(at most (\d+)\)/)?.[1]);
      const all = searchData(send({ data: {} }));
      ok(Number.isInteger(pageSize) && publicCount > pageSize, `P1: the search text gives a page size the fixture exceeds (${pageSize} < ${publicCount})`);
      eq([all?.count, all?.clinics?.length, all?.total], [pageSize, pageSize, publicCount], "P2: count is the clinics in the answer (the page size), total every match");
      const stats = (text: string) => send({ text }).result?.artifacts?.[0]?.parts?.[0]?.data;
      ok(JSON.stringify(stats("statistikk for Oslo")) === JSON.stringify(stats("statistikk")) && stats("statistikk")?.per_fylke?.length > 1,
        "P3: a place in a statistics text is not applied (all of Norway, every county)");
      eq(stats("statistikk")?.total, publicCount, "P4: ... the total is every listed clinic");
    }

    // ── T: the text rules ─────────────────────────────────────────────────
    for (const s of skills) {
      const first = shortToolDescription(s.description);
      ok(Object.values(SEARCH_WORDS).some((re) => re.test(first)), `T1 ${s.id}: the first sentence has a search word («${first}»)`);
      eq(violations(s.description, dentalTools.filter((t) => t !== s.id), { figures: false }), [],
        `T2 ${s.id}: no other tool or service, no directive or promotional words`);
      eq(s.description.match(/\d{3,}/)?.[0] ?? null, null, `T3 ${s.id}: no number of three or more digits in the description`);
      eq([s.description, ...s.examples].filter((t) => ORG_NR_JSON.test(t)), [], `T4 ${s.id}: no { "org_nr" } example`);
    }
    {
      const search = skill("tannlege_search").description;
      const required = ["`specialty`", "`helfo_agreement`", "`acute_vakt`", "`metadata.tolkning`", "`metadata.filter`", "`count`", "`total`", "`clinics`"];
      eq(required.filter((w) => !search.includes(w)), [], "T5: the search text names specialty, helfo_agreement, acute_vakt, metadata.tolkning, metadata.filter, count, total and clinics");
      eq(RULED_OUT.filter((w) => search.includes(w)), [], "T6: the search text has none of «matches name/city», «spesialitet (», «akutt (1»");
      const info = skill("tannlege_info").description;
      ok(/nine-digit org\.nr in a text part/.test(info), "T7: tannlege_info takes a nine-digit org.nr in the text");
      const stats = skill("tannlege_stats").description;
      eq(["statistikk", "totalt", "oversikt", "how many"].filter((w) => !quotedRequests(stats).includes(w)), [],
        "T8: tannlege_stats quotes the words that reach it («statistikk», «totalt», «oversikt», «how many»)");
      ok(/akuttpåstand \(akuttvakt med kilde, eller at klinikken tar imot akuttpasienter\)/.test(stats) &&
        /emergency claim \(a sourced akuttvakt, or that the clinic takes emergency patients\)/.test(stats),
      "T9: tannlege_stats counts the akutt claim in the D3a wording (sourced akuttvakt, or takes emergency patients)");
      ok(stats.includes("det norske tannlegemarkedet") && !JSON.stringify(card).includes("den norske tannlegemarkedet"), "T10: «det norske tannlegemarkedet», not «den»");
    }

    // ── N: the skill texts before D3d fail the checks ─────────────────────
    {
      const before = (id: string) => SKILLS_BEFORE_D3D.find((s) => s.id === id)!;
      ok(SKILLS_BEFORE_D3D.every((s) => !Object.values(SEARCH_WORDS).some((re) => re.test(shortToolDescription(s.description)))),
        "N1: no first sentence before D3d has a search word (T1 catches it)");
      eq(RULED_OUT.filter((w) => before("tannlege_search").description.includes(w)), RULED_OUT, "N2: the old search text has all three ruled-out phrases (T6)");
      ok(OLD_KEY_NAMES.test(before("tannlege_search").description) && dataKeysNamed(before("tannlege_search").description).length === 0,
        "N3: the old search text names spesialitet, helfo and akutt, and no message.data key (F1, F7)");
      ok(before("tannlege_info").examples.some((t) => ORG_NR_JSON.test(t)), "N4: the old info examples have the { \"org_nr\" } example (T4)");
      ok(/\d{3,}/.test(before("tannlege_info").description), "N5: the old info description has the org.nr's digits (T3)");
      const misrouted = quotedRequests(before("tannlege_stats").description).filter((t) => send({ text: t }).result?.metadata?.skill !== "tannlege_stats");
      eq(misrouted, ["hvor mange tannleger finnes det i Norge?"], "N6: the old stats text quotes a request that is not answered by tannlege_stats (R1)");
      ok(before("tannlege_stats").description.includes("den norske tannlegemarkedet"), "N7: the old stats text says «den norske tannlegemarkedet» (T10)");
    }

    // ── W: both GET routes serve the same skills ──────────────────────────
    {
      // /a2a goes to the A2A router before anything reaches dental-seo, as in src/index.ts.
      const app = express();
      app.use(a2a.default);
      app.use((require("../routes/dental-seo") as typeof import("../routes/dental-seo")).default);
      server = http.createServer(app);
      await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const wellKnown = await getJson(base, "/.well-known/agent-card.json");
      const a2aCard = await getJson(base, "/a2a");
      eq([wellKnown.status, a2aCard.status], [200, 200], "W1: GET /.well-known/agent-card.json and GET /a2a answer 200");
      ok(JSON.stringify(wellKnown.body?.skills) === JSON.stringify(skills), "W2: /.well-known/agent-card.json serves these skills");
      ok(JSON.stringify(a2aCard.body?.skills) === JSON.stringify(wellKnown.body?.skills), "W3: GET /a2a serves the same skills");
    }
  } catch (err: any) {
    failed++;
    failures.push("dental agent card: unexpected error: " + String(err?.stack || err?.message || err));
  } finally {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    if (prevDentalPath === undefined) delete process.env.DENTAL_DB_PATH;
    else process.env.DENTAL_DB_PATH = prevDentalPath;
    if (prevDbPath === undefined) delete process.env.DB_PATH;
    else process.env.DB_PATH = prevDbPath;
    try {
      (require("../database/db-factory") as typeof import("../database/db-factory")).__resetDbFactoryForTesting();
    } catch {
      // best-effort cleanup
    }
    restoreModuleCache();
  }
  return { passed, failed, failures };
}

if (require.main === module) {
  runDentalAgentCardTests({ log: true }).then((r) => {
    console.log(`\ndental agent card: ${r.passed} passed, ${r.failed} failed`);
    if (r.failures.length) console.log(r.failures.join("\n"));
    process.exit(r.failed > 0 ? 1 : 0);
  });
}
