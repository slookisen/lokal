/**
 * registration-precheck.test.ts — dev-request
 * 2026-11-10-rfb-registreringer-og-eierkrav-folges-opp, slice S2 (record-only
 * pre-check recommendation for self-registered profiles).
 *
 *   unit   assessRegistration rule R1: godkjenn (org.nr / name search, own
 *          domain with MX / website shows name), spor_forst (free mail, name
 *          mismatch, ambiguous name search, under avvikling, name+place or
 *          unvetted exact duplicate), avvis (disposable, konkurs, slettet,
 *          410, exact vetted duplicate); any unavailable source (Brreg down /
 *          hang, MX down, website 5xx / throw) never yields godkjenn; a
 *          realistic Enhetsregisteret fixture; privacy (no Brreg name, no
 *          page text stored); name matcher; env flag.
 *   db     gatherRegistrationPrecheckInput duplicates + owner claim.
 *   routes GET self-registered-review-queue returns precheck/precheck_at/
 *          age_days (+ org_nr/city) with the old fields first and the same
 *          order; POST self-registered-precheck: 403/400/404/409, one agent,
 *          { all: true }; POST /register: same 201 response whether the
 *          precheck deps work or throw, kill switch, rejected registration
 *          stores nothing; the precheck never changes is_vetted.
 *
 * All network (fetchApi, fetchSite, resolveMx) and the clock are stubs — no
 * request leaves the process.
 *
 * Exported runRegistrationPrecheckTests({log}) -> TestSummary; wired into
 * tests/test.ts. Standalone: npx tsx src/services/registration-precheck.test.ts
 */

import Database from "better-sqlite3";
import {
  type RegistrationPrecheckDeps, type RegistrationPrecheckInput, BRREG_ENHET_URL, assessRegistration,
  domainTiesToName, precheckNameMatches, readBrregEnhet, registrationPrecheckEnabled,
} from "./registration-precheck";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

const NOW = new Date("2026-11-10T12:00:00.000Z");
const ORG = "912345678";

/** Shape of a real GET /enhetsregisteret/api/enheter/<orgnr> answer (ENK: the name holds a person's name). */
function brregEnhet(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    organisasjonsnummer: ORG,
    navn: "Solbakken Gård Kari Nordmann",
    organisasjonsform: { kode: "ENK", beskrivelse: "Enkeltpersonforetak", _links: { self: { href: "https://data.brreg.no/enhetsregisteret/api/organisasjonsformer/ENK" } } },
    registreringsdatoEnhetsregisteret: "2015-03-02",
    registrertIMvaregisteret: true,
    naeringskode1: { kode: "01.410", beskrivelse: "Melkeproduksjon på storfe" },
    antallAnsatte: 0,
    harRegistrertAntallAnsatte: false,
    forretningsadresse: {
      land: "Norge", landkode: "NO", postnummer: "2610", poststed: "MESNALI", adresse: ["Solbakkevegen 12"],
      kommune: "RINGSAKER", kommunenummer: "3411",
    },
    institusjonellSektorkode: { kode: "8200", beskrivelse: "Personlig næringsdrivende" },
    registrertIForetaksregisteret: false,
    registrertIStiftelsesregisteret: false,
    registrertIFrivillighetsregisteret: false,
    konkurs: false,
    underAvvikling: false,
    underTvangsavviklingEllerTvangsopplosning: false,
    maalform: "Bokmål",
    _links: { self: { href: `https://data.brreg.no/enhetsregisteret/api/enheter/${ORG}` } },
    ...over,
  };
}
const searchAnswer = (enheter: unknown[]) => ({
  _embedded: { enheter },
  _links: { self: { href: "https://data.brreg.no/enhetsregisteret/api/enheter?navn=x" } },
  page: { size: 20, totalElements: enheter.length, totalPages: 1, number: 0 },
});

interface StubOpts {
  brreg?: "ok" | "404" | "410" | "500" | "down" | "hang" | "badjson" | Record<string, unknown>;
  search?: unknown[] | "down";
  mx?: "ok" | "none" | "nxdomain" | "down";
  site?: "name" | "noname" | "404" | "500" | "down" | "redirect";
}

function stubDeps(o: StubOpts = {}, calls: string[] = []): RegistrationPrecheckDeps {
  return {
    now: () => NOW,
    timeoutMs: 40,
    fetchApi: async (url: string) => {
      calls.push(url);
      if (url.includes("?navn=")) {
        if (o.search === "down") throw new Error("ECONNREFUSED");
        return { status: 200, body: JSON.stringify(searchAnswer(o.search ?? [])) };
      }
      const b = o.brreg ?? "ok";
      if (b === "down") throw new Error("ECONNREFUSED");
      if (b === "hang") return new Promise(() => { /* never */ });
      if (b === "404") return { status: 404, body: "" };
      if (b === "410") return { status: 410, body: "" };
      if (b === "500") return { status: 500, body: "" };
      if (b === "badjson") return { status: 200, body: "<html>" };
      return { status: 200, body: JSON.stringify(b === "ok" ? brregEnhet() : brregEnhet(b)) };
    },
    fetchSite: async (host: string) => {
      calls.push(`site:${host}`);
      const s = o.site ?? "name";
      if (s === "down") throw new Error("ECONNRESET");
      if (s === "500") return { status: 503, body: "" };
      if (s === "404") return { status: 404, body: "" };
      if (s === "redirect" && !host.startsWith("www.")) return { status: 301, body: "" };
      const body = s === "noname"
        ? "<html><body><h1>Velkommen</h1><p>Hemmelig sidetekst om noe annet</p></body></html>"
        : "<html><head><script>var x='<b>'</script></head><body><h1>Solbakken G&aring;rd</h1><h2>SOLBAKKEN GÅRD</h2><p>Hemmelig sidetekst</p></body></html>";
      return { status: 200, body };
    },
    resolveMx: async (d: string) => {
      calls.push(`mx:${d}`);
      const m = o.mx ?? "ok";
      if (m === "down") throw Object.assign(new Error("ESERVFAIL"), { code: "ESERVFAIL" });
      if (m === "nxdomain") throw Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" });
      if (m === "none") return [];
      return [{ exchange: `mx.${d}`, priority: 10 }];
    },
  };
}

function baseInput(over: Partial<RegistrationPrecheckInput> = {}): RegistrationPrecheckInput {
  return {
    name: "Solbakken Gård",
    contactEmail: "post@solbakkengard.no",
    url: "https://solbakkengard.no",
    city: "Mesnali",
    orgNr: ORG,
    orgNrSelfReported: true,
    duplicates: { exact_ids: [], exact_vetted_ids: [], name_place_ids: [] },
    ownerClaimConfirmed: false,
    ...over,
  };
}

export async function runRegistrationPrecheckTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];
  const eq = (actual: unknown, expected: unknown, label: string): void => {
    if (JSON.stringify(actual) === JSON.stringify(expected)) {
      passed++;
      if (log) console.log(`  ok ${label}`);
    } else {
      failed++;
      const msg = `✗ ${label}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`;
      failures.push(msg);
      if (log) console.log("  " + msg);
    }
  };
  const ok = (cond: boolean, label: string): void => eq(!!cond, true, label);
  const run = (o: StubOpts = {}, inp: Partial<RegistrationPrecheckInput> = {}, calls: string[] = []) =>
    assessRegistration(baseInput(inp), stubDeps(o, calls));

  // ── unit: env flag + helpers ────────────────────────────────────────────
  eq(registrationPrecheckEnabled({} as any), true, "flag: unset → on");
  eq(registrationPrecheckEnabled({ REGISTRATION_PRECHECK_ENABLED: "false" } as any), false, "flag: \"false\" → off");
  eq(registrationPrecheckEnabled({ REGISTRATION_PRECHECK_ENABLED: "0" } as any), true, "flag: \"0\" → still on (only exact \"false\")");
  eq(registrationPrecheckEnabled({ REGISTRATION_PRECHECK_ENABLED: "FALSE" } as any), true, "flag: \"FALSE\" → still on");
  ok(precheckNameMatches("Solbakken Gård", "SOLBAKKEN GÅRD AS"), "name: suffix + diacritics");
  ok(precheckNameMatches("Solbakken Gård", "Solbakken Gård Kari Nordmann"), "name: ENK with owner name");
  ok(!precheckNameMatches("Gård", "Solbakken Gård"), "name: generic word alone never matches");
  ok(!precheckNameMatches("Solbakken Gård", "Nordbakken Gård AS"), "name: different farm");
  ok(!precheckNameMatches("Gård", "GÅRD AS"), "name R2: equal after normalisation but only generic → no match");
  ok(!precheckNameMatches("Nordre Hansen Gård", "HANSEN"), "name R2: lone Brreg token inside a longer profile name → no match");
  ok(!precheckNameMatches("Bø Gård", "BØ GÅRD AS"), "name R2: no non-generic token of ≥4 letters → no match");
  ok(precheckNameMatches("Hansen Bakeri", "HANSEN BAKERI AS"), "name R2: legit exact company name still matches");
  ok(precheckNameMatches("Nordre Hansen Gård", "Nordre Hansen Gård DA"), "name R2: near-exact name with company form matches");
  ok(precheckNameMatches("Lille Hansen Bakeri Hamar", "HANSEN BAKERI AS"), "name R2: ≥2 Brreg tokens inside a longer profile name match");
  ok(domainTiesToName("www.solbakken-gard.no", ["Solbakken Gård"]), "tie: hyphenated domain label carries the name token");
  ok(domainTiesToName("mail.bjorkely.no", ["Bjørkely Gård AS"]), "tie: Norwegian letters folded (ø → o)");
  ok(!domainTiesToName("gardsmat.no", ["Solbakken Gård"]), "tie: generic-only label does not tie");
  const e = readBrregEnhet(brregEnhet());
  eq([e.orgNr, e.nace, e.kommune, e.kommunenummer, e.deleted, e.konkurs, e.underAvvikling],
    [ORG, "01.410", "RINGSAKER", "3411", false, false, false], "readBrregEnhet: real fixture fields");
  eq(readBrregEnhet(brregEnhet({ slettedato: "2024-01-01" })).deleted, true, "readBrregEnhet: slettedato → deleted");

  // ── godkjenn ────────────────────────────────────────────────────────────
  {
    const calls: string[] = [];
    const r = await run({}, {}, calls);
    eq(r.recommendation, "godkjenn", "G1: org.nr found + name + own domain MX → godkjenn");
    eq(r.rule_version, "R2", "G1: rule version (R2 after the self-reported org.nr hardening)");
    eq([r.signals.brreg.org_nr_self_reported, r.signals.domain_tie.required, r.signals.domain_tie.tied], [true, true, true],
      "G1: tag org.nr is self-reported; domain tied to the name");
    ok(r.reasons.includes("Brreg: org.nr er selvoppgitt"), "G1: self-reported reason");
    ok(r.reasons.includes("Domene: knyttet til enheten"), "G1: domain-tie reason");
    eq(r.signals.brreg.source_url, BRREG_ENHET_URL(ORG), "G1: org_nr mode keeps source_url (holds only the org.nr)");
    eq(r.assessed_at, NOW.toISOString(), "G1: assessed_at from the clock");
    eq(r.unavailable_sources, [], "G1: no unavailable source");
    eq([r.signals.brreg.nace, r.signals.brreg.kommune, r.signals.brreg.kommunenummer, r.signals.brreg.found, r.signals.brreg.name_match],
      ["01.410", "RINGSAKER", "3411", true, true], "G1: Brreg NACE / kommune / match recorded");
    ok(r.reasons.includes(`Brreg: org.nr ${ORG} funnet, navnet stemmer`), "G1: Norwegian Brreg reason");
    ok(r.reasons.includes("E-post: eget domene med MX"), "G1: e-mail reason");
    ok(calls.includes(BRREG_ENHET_URL(ORG)), "G1: Brreg enhet URL asked");
    const json = JSON.stringify(r);
    ok(!/nordmann/i.test(json), "G1 privacy: the Brreg (ENK person) name is never stored");
    ok(!/hemmelig/i.test(json), "G1 privacy: page text is never stored");
  }
  eq((await run({ site: "name" }, { contactEmail: "solbakken@gmail.com" })).recommendation, "godkjenn",
    "G2: free mail but website answers and shows the name → godkjenn");
  {
    const r = await run({ search: [brregEnhet({ navn: "SOLBAKKEN GÅRD AS" }), brregEnhet({ organisasjonsnummer: "998877665", navn: "Helt Annen Bedrift AS" })] },
      { orgNr: null });
    eq(r.recommendation, "godkjenn", "G3: no org.nr, single plausible name-search match → godkjenn");
    eq([r.signals.brreg.mode, r.signals.brreg.org_nr, r.signals.brreg.name_hits], ["name_search", ORG, 1], "G3: only org.nr + match flag");
    eq(r.signals.brreg.source_url, undefined, "G3 privacy: name_search stores no source_url");
    const json = JSON.stringify(r);
    ok(!/solbakken(%20|\+| )g/i.test(json) && !json.includes("navn="), "G3 privacy: the profile name / search query is nowhere in the stored JSON");
  }
  {
    const r = await run({ search: [] }, { orgNr: null, name: "Kari Nordmann" });
    const json = JSON.stringify(r);
    ok(!/kari/i.test(json) && !/nordmann/i.test(json) && r.signals.brreg.source_url === undefined,
      "N3 privacy: a person-name name search stores no name and no source_url");
  }

  // ── R2: self-reported org.nr needs a domain tie ─────────────────────────
  {
    const r = await run({ site: "noname" }, { contactEmail: "post@tilfeldigdomene.no", url: "https://tilfeldigdomene.no" });
    eq(r.recommendation, "spor_forst", "N1: tag org.nr + matching name + unrelated own domain with MX → spor_forst");
    ok(r.reasons.includes("Domene: domenet er ikke knyttet til enheten"), "N1: reason «domenet er ikke knyttet til enheten»");
    ok(r.reasons.includes("Brreg: org.nr er selvoppgitt"), "N1: reason «org.nr er selvoppgitt»");
    eq([r.signals.domain_tie.email_domain, r.signals.domain_tie.website_domain, r.signals.domain_tie.tied], [false, false, false], "N1: tie booleans");
  }
  eq((await run({ site: "noname" }, { contactEmail: "post@solbakken-gard.no", url: null })).recommendation, "godkjenn",
    "N1: tag org.nr + name + own e-mail domain tied to the name → godkjenn");
  eq((await run({ brreg: brregEnhet({ navn: "SOLBAKKEN GÅRD AS" }) }, { contactEmail: "post@tilfeldigdomene.no", url: "https://tilfeldigdomene.no" })).recommendation,
    "godkjenn", "N1: unrelated domain but the website shows the Brreg name → godkjenn");
  eq((await run({}, { contactEmail: "post@tilfeldigdomene.no", url: "https://tilfeldigdomene.no" })).recommendation, "spor_forst",
    "N1: unrelated domain; page shows the profile name but not the full Brreg (ENK) name → spor_forst");
  {
    const r = await run({ site: "noname" }, { contactEmail: "post@tilfeldigdomene.no", url: "https://tilfeldigdomene.no", orgNrSelfReported: false });
    eq([r.recommendation, r.signals.brreg.org_nr_self_reported, r.signals.domain_tie.required], ["godkjenn", false, false],
      "N1: audited (not self-reported) org.nr does not need the tie");
    ok(!r.reasons.includes("Brreg: org.nr er selvoppgitt"), "N1: no self-reported reason for an audited org.nr");
  }
  eq((await run({ brreg: brregEnhet({ navn: "HANSEN" }) }, { name: "Nordre Hansen Gård", contactEmail: "post@nordrehansen.no", url: null })).recommendation,
    "spor_forst", "N1: «Nordre Hansen Gård» vs Brreg «HANSEN» → no name match → spor_forst");
  eq((await run({ search: [brregEnhet({ navn: "SOLBAKKEN GÅRD AS" })] }, { orgNr: null, contactEmail: "post@tilfeldigdomene.no", url: "https://tilfeldigdomene.no" }, [])).recommendation,
    "godkjenn", "N1: name search + website shows the name → godkjenn (tie via the page)");
  eq((await run({ search: [brregEnhet({ navn: "SOLBAKKEN GÅRD AS" })], site: "noname" }, { orgNr: null, contactEmail: "post@tilfeldigdomene.no", url: "https://tilfeldigdomene.no" })).recommendation,
    "spor_forst", "N1: name search + unrelated domain, page without the name → spor_forst");
  eq((await run({ site: "redirect" }, { contactEmail: "solbakken@gmail.com" })).recommendation, "godkjenn",
    "G4: bare host redirects, www.<host> answers with the name → godkjenn");

  // ── spor_forst ──────────────────────────────────────────────────────────
  {
    const r = await run({ site: "noname" }, { contactEmail: "solbakken@gmail.com" });
    eq(r.recommendation, "spor_forst", "S1: free mail, website without the name → spor_forst");
    ok(r.reasons.includes("E-post: gratis e-posttjeneste"), "S1: free-mail reason");
  }
  eq((await run({ site: "404" }, { contactEmail: "solbakken@gmail.com" })).recommendation, "spor_forst", "S2: free mail, website 404 → spor_forst");
  eq((await run({ mx: "none", site: "noname" })).recommendation, "spor_forst", "S3: own domain without MX, no name on site → spor_forst");
  eq((await run({ mx: "nxdomain", site: "noname" })).signals.email.mx, false, "S3b: NXDOMAIN = no MX (not unavailable)");
  eq((await run({ brreg: brregEnhet({ navn: "Nordbakken Gård AS" }) })).recommendation, "spor_forst", "S4: org.nr found, name mismatch → spor_forst");
  eq((await run({ brreg: "404" })).recommendation, "spor_forst", "S5: org.nr not found → spor_forst");
  eq((await run({ search: [brregEnhet({ navn: "Solbakken Gård AS" }), brregEnhet({ organisasjonsnummer: "998877665", navn: "Solbakken Gård Ola Hansen" })] }, { orgNr: null })).recommendation,
    "spor_forst", "S6: two plausible name-search hits → spor_forst");
  eq((await run({ search: [] }, { orgNr: null })).recommendation, "spor_forst", "S7: no name-search hit → spor_forst");
  {
    const r = await run({ brreg: brregEnhet({ underAvvikling: true }) });
    eq(r.recommendation, "spor_forst", "S8: under avvikling → spor_forst (not avvis)");
    ok(r.reasons.includes("Brreg: enheten er under avvikling"), "S8: reason");
  }
  eq((await run({}, { duplicates: { exact_ids: [], exact_vetted_ids: [], name_place_ids: ["dup-1"] } })).recommendation,
    "spor_forst", "S9: name+place duplicate → spor_forst");
  eq((await run({}, { duplicates: { exact_ids: ["dup-2"], exact_vetted_ids: [], name_place_ids: [] } })).recommendation,
    "spor_forst", "S10: exact duplicate of an UNVETTED profile → spor_forst");
  eq((await run({ search: [brregEnhet({ navn: "Solbakken Gård AS", konkurs: true })] }, { orgNr: null })).recommendation,
    "spor_forst", "S11: the only name-search hit is konkurs → spor_forst (not avvis)");

  // ── avvis ───────────────────────────────────────────────────────────────
  {
    const r = await run({}, { contactEmail: "x@mailinator.com" });
    eq(r.recommendation, "avvis", "A1: disposable e-mail → avvis");
    ok(r.reasons.includes("E-post: engangsadresse"), "A1: reason");
  }
  eq((await run({ brreg: brregEnhet({ konkurs: true }) })).recommendation, "avvis", "A2: konkurs → avvis");
  eq((await run({ brreg: brregEnhet({ slettedato: "2025-06-01" }) })).recommendation, "avvis", "A3: slettedato → avvis");
  eq((await run({ brreg: "410" })).recommendation, "avvis", "A4: HTTP 410 (removed unit) → avvis");
  eq((await run({}, { duplicates: { exact_ids: ["v-1"], exact_vetted_ids: ["v-1"], name_place_ids: [] } })).recommendation,
    "avvis", "A5: same org.nr / e-mail as a vetted profile → avvis");
  eq((await run({ brreg: "down" }, { contactEmail: "x@yopmail.com" })).recommendation, "avvis", "A6: disposable wins even with a source down");

  // ── unavailable sources never godkjenn ──────────────────────────────────
  for (const [label, o, inp, src] of [
    ["Brreg down", { brreg: "down" }, {}, "brreg"],
    ["Brreg hangs (timeout)", { brreg: "hang" }, {}, "brreg"],
    ["Brreg 500", { brreg: "500" }, {}, "brreg"],
    ["Brreg bad JSON", { brreg: "badjson" }, {}, "brreg"],
    ["Brreg name search down", { search: "down" }, { orgNr: null }, "brreg"],
    ["MX down", { mx: "down" }, {}, "dns_mx"],
    ["website 5xx", { site: "500" }, {}, "website"],
    ["website throws", { site: "down" }, {}, "website"],
  ] as Array<[string, StubOpts, Partial<RegistrationPrecheckInput>, string]>) {
    const r = await run(o, inp);
    eq([r.recommendation, r.unavailable_sources.includes(src as any)], ["spor_forst", true], `U: ${label} → spor_forst, listed unavailable`);
  }

  // ── DB + routes ─────────────────────────────────────────────────────────
  const initMod = require("../database/init") as typeof import("../database/init");
  const prevDb = initMod.__peekDbForTesting();
  const db = new Database(":memory:");
  const prevEnv = { ADMIN_KEY: process.env.ADMIN_KEY, FLAG: process.env.REGISTRATION_PRECHECK_ENABLED };
  const ADMIN = "regprecheck-admin-key";
  const rp = require("./registration-precheck") as typeof import("./registration-precheck");

  const indexNowPath = require.resolve("./indexnow-service");
  const originalIndexNow = require.cache[indexNowPath];
  require.cache[indexNowPath] = { id: indexNowPath, filename: indexNowPath, loaded: true, exports: { pingIndexNow: () => { /* stub */ } } } as any;

  const origWarn = console.warn;
  const warned: string[] = [];

  const handlerOf = (router: any, path: string, method: "get" | "post"): Function => {
    const layer = (router.stack as any[]).find((l: any) => l.route && l.route.path === path && l.route.methods?.[method]);
    if (!layer) throw new Error(`route not found: ${method.toUpperCase()} ${path}`);
    return layer.route.stack[layer.route.stack.length - 1].handle;
  };
  const makeReq = (o: { body?: any; admin?: boolean }): any => {
    const headers: Record<string, string> = o.admin === false ? {} : { "x-admin-key": ADMIN };
    return {
      params: {}, body: o.body, query: {}, headers, ip: "127.0.0.1", lang: "no", protocol: "https",
      get(name: string) { return name.toLowerCase() === "host" ? "rettfrabonden.com" : headers[name.toLowerCase()]; },
    };
  };
  const invoke = (handler: Function, req: any): Promise<{ status: number; body: any }> => new Promise((resolve) => {
    let status = 200;
    let settled = false;
    const settle = (body: any) => { if (!settled) { settled = true; resolve({ status, body }); } };
    const res: any = {
      status(c: number) { status = c; return res; }, json(p: any) { settle(p); return res; }, send(p: any) { settle(p); return res; },
      end() { settle(undefined); return res; }, header() { return res; }, set() { return res; }, type() { return res; }, setHeader() { return res; },
    };
    try {
      const p = handler(req, res, () => settle({ __next: true }));
      if (p && typeof p.catch === "function") p.catch((err: any) => settle({ __error: String(err) }));
    } catch (err) {
      settle({ __error: String(err) });
    }
  });

  try {
    initMod.__setDbForTesting(db as any);
    initMod.__initSchemaForTesting(db as any);
    process.env.ADMIN_KEY = ADMIN;
    delete process.env.REGISTRATION_PRECHECK_ENABLED;
    console.warn = (...a: any[]) => { warned.push(a.map(String).join(" ")); if (log) origWarn(...a); };

    const cols = (db.prepare("PRAGMA table_info(agent_registration_precheck)").all() as Array<{ name: string }>).map((c) => c.name);
    eq(cols, ["agent_id", "registration_precheck", "registration_precheck_at"], "schema: agent_registration_precheck side table");
    ok(!(db.prepare("PRAGMA table_info(agents)").all() as Array<{ name: string }>).some((c) => c.name.startsWith("registration_precheck")),
      "schema: agents is not widened (planner order of public scans unchanged)");

    const insert = (id: string, o: { name?: string; email?: string; city?: string | null; origin?: string; vetted?: number; created?: string; orgNr?: string | null; url?: string }) => {
      db.prepare(`INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, city, origin, is_vetted, created_at, org_nr)
                  VALUES (?, ?, 'En gård med egne produkter.', 'test', ?, ?, 'producer', ?, ?, ?, ?, ?, ?)`)
        .run(id, o.name ?? `Gård ${id}`, o.email ?? `post@${id}.example.test`, o.url ?? `https://${id}.example.test`, `key-${id}`,
          o.city === undefined ? "Mesnali" : o.city, o.origin ?? "self_registered", o.vetted ?? 0,
          o.created ?? "2026-11-01 08:00:00", o.orgNr ?? null);
    };

    // ── gather: duplicates + owner claim ──
    insert("self-a", { name: "Solbakken Gård", email: "post@solbakkengard.no", city: "Mesnali", orgNr: ORG, created: "2026-11-03 10:00:00" });
    insert("vetted-org", { name: "Noe Annet", origin: "discovery", vetted: 1, orgNr: ORG, city: "Oslo" });
    insert("np-dup", { name: "SOLBAKKEN GÅRD AS", origin: "discovery", vetted: 1, city: "mesnali" });
    insert("other-place", { name: "Solbakken Gård", origin: "discovery", vetted: 1, city: "Bergen" });
    insert("unvetted-mail", { name: "Tredje", email: "POST@solbakkengard.no ", city: "Hamar" });
    const g = rp.gatherRegistrationPrecheckInput(db as any, "self-a")!;
    eq(g.orgNr, ORG, "gather: org.nr from the column");
    eq([...g.duplicates.exact_ids].sort(), ["unvetted-mail", "vetted-org"], "gather: exact duplicates (org.nr + e-mail, case/space-insensitive)");
    eq(g.duplicates.exact_vetted_ids, ["vetted-org"], "gather: only the vetted exact duplicate counts for avvis");
    eq(g.duplicates.name_place_ids, ["np-dup"], "gather: name+place duplicate (normalised), not the same name elsewhere");
    eq(g.ownerClaimConfirmed, false, "gather: no owner claim");
    db.prepare(`INSERT INTO agent_claims (id, agent_id, claimant_name, claimant_email, status) VALUES ('c1', 'self-a', 'K', 'k@x.no', 'verified')`).run();
    eq(rp.gatherRegistrationPrecheckInput(db as any, "self-a")!.ownerClaimConfirmed, true, "gather: verified owner claim recorded");
    db.prepare(`UPDATE agent_claims SET status = 'revoked', revoked_at = datetime('now') WHERE id = 'c1'`).run();
    eq(rp.gatherRegistrationPrecheckInput(db as any, "self-a")!.ownerClaimConfirmed, false, "gather: revoked claim (status 'revoked') not confirmed");
    db.prepare(`UPDATE agents SET claimed_at = '2026-11-05 10:00:00' WHERE id = 'self-a'`).run();
    eq(rp.gatherRegistrationPrecheckInput(db as any, "self-a")!.ownerClaimConfirmed, true, "gather: claimed_at only → confirmed owner (shared customer rule)");
    db.prepare(`UPDATE agents SET claimed_at = NULL WHERE id = 'self-a'`).run();
    db.prepare(`UPDATE agent_claims SET status = 'verified', revoked_at = NULL WHERE id = 'c1'`).run();
    eq(rp.gatherRegistrationPrecheckInput(db as any, "self-a")!.orgNrSelfReported, false, "gather: column org.nr without a tag → not self-reported");
    eq(rp.gatherRegistrationPrecheckInput(db as any, "missing"), null, "gather: unknown id → null");
    db.prepare(`UPDATE agents SET tags = '["org_nr:987654321"]', org_nr = NULL WHERE id = 'self-a'`).run();
    eq([rp.gatherRegistrationPrecheckInput(db as any, "self-a")!.orgNr, rp.gatherRegistrationPrecheckInput(db as any, "self-a")!.orgNrSelfReported],
      ["987654321", true], "gather: org.nr from an org_nr: tag, self-reported");
    db.prepare(`UPDATE agents SET org_nr = '987654321' WHERE id = 'self-a'`).run();
    eq(rp.gatherRegistrationPrecheckInput(db as any, "self-a")!.orgNrSelfReported, true, "gather: column mirroring the tag without an audit row → still self-reported");
    db.prepare(`INSERT INTO agents_org_nr_audit (id, agent_id, field_name, old_value, new_value) VALUES ('au1', 'self-a', 'org_nr', NULL, '987654321')`).run();
    eq(rp.gatherRegistrationPrecheckInput(db as any, "self-a")!.orgNrSelfReported, false, "gather: audited org.nr write → not self-reported");
    db.prepare(`DELETE FROM agents_org_nr_audit WHERE id = 'au1'`).run();
    db.prepare(`UPDATE agents SET tags = '[]', org_nr = ? WHERE id = 'self-a'`).run(ORG);

    // ── routes ──
    for (const p of ["../routes/marketplace", "../routes/admin-agents"]) delete require.cache[require.resolve(p)];
    const marketplaceRouter = require("../routes/marketplace").default as any;
    const adminRouter = require("../routes/admin-agents").default as any;
    const { marketplaceRegistry } = require("./marketplace-registry") as typeof import("./marketplace-registry");
    (marketplaceRegistry as any)._agentsCache = null;
    const queueH = handlerOf(adminRouter, "/self-registered-review-queue", "get");
    const precheckH = handlerOf(adminRouter, "/self-registered-precheck", "post");
    const registerH = handlerOf(marketplaceRouter, "/register", "post");

    rp.__setRegistrationPrecheckDepsForTesting(stubDeps({}));

    eq((await invoke(precheckH, makeReq({ body: { agentId: "self-a" }, admin: false }))).status, 403, "route: precheck without admin key → 403");
    eq((await invoke(precheckH, makeReq({ body: {} }))).status, 400, "route: precheck without agentId/all → 400");
    eq((await invoke(precheckH, makeReq({ body: { agentId: "nope" } }))).status, 404, "route: precheck unknown agent → 404");
    eq((await invoke(precheckH, makeReq({ body: { agentId: "vetted-org" } }))).status, 409, "route: precheck discovery row → 409");
    insert("self-vetted", { name: "Godkjent Selv", vetted: 1 });
    eq((await invoke(precheckH, makeReq({ body: { agentId: "self-vetted" } }))).status, 409, "route: precheck vetted self_registered row → 409");
    eq((db.prepare("SELECT agent_id FROM agent_registration_precheck WHERE agent_id IN ('vetted-org','self-vetted')").all()).length,
      0, "route: 409 rows got nothing stored");

    const one = await invoke(precheckH, makeReq({ body: { agentId: "self-a" } }));
    eq([one.status, one.body?.precheck?.recommendation], [200, "avvis"], "route: precheck self-a → avvis (exact vetted duplicate on org.nr)");
    const stored = db.prepare("SELECT p.registration_precheck, p.registration_precheck_at, a.is_vetted, a.origin FROM agents a LEFT JOIN agent_registration_precheck p ON p.agent_id = a.id WHERE a.id = 'self-a'").get() as any;
    eq([JSON.parse(stored.registration_precheck).recommendation, stored.registration_precheck_at, stored.is_vetted, stored.origin],
      ["avvis", NOW.toISOString(), 0, "self_registered"], "route: stored JSON + time; is_vetted stays 0");

    // Queue: precheck + age_days, old fields first, order unchanged.
    insert("self-b", { name: "Bekkely", city: null, created: "2026-10-20T09:00:00.000Z" });
    const q = await invoke(queueH, makeReq({}));
    const ids = (q.body.entries as any[]).map((x) => x.id);
    eq(ids, ["self-b", "unvetted-mail", "self-a"], "queue: oldest first, only unvetted self_registered rows");
    const a = (q.body.entries as any[]).find((x) => x.id === "self-a");
    eq(Object.keys(a).slice(0, 5), ["id", "name", "contact_email", "url", "created_at"], "queue: original fields first, same order");
    eq([a.precheck?.recommendation, a.precheck_at, a.org_nr, a.city], ["avvis", NOW.toISOString(), ORG, "Mesnali"], "queue: precheck parsed + org_nr/city");
    ok(typeof a.age_days === "number" && a.age_days === Math.floor((Date.now() - Date.parse("2026-11-03T10:00:00Z")) / 86_400_000), "queue: age_days from SQLite timestamp");
    const b = (q.body.entries as any[]).find((x) => x.id === "self-b");
    eq([b.precheck, b.precheck_at], [null, null], "queue: not assessed → null");
    ok(b.age_days === Math.floor((Date.now() - Date.parse("2026-10-20T09:00:00.000Z")) / 86_400_000), "queue: age_days from ISO timestamp");
    db.prepare("INSERT INTO agent_registration_precheck (agent_id, registration_precheck, registration_precheck_at) VALUES ('self-b', '{oops', 'x')").run();
    eq(((await invoke(queueH, makeReq({}))).body.entries as any[]).find((x) => x.id === "self-b").precheck, null, "queue: unparseable JSON → null");

    // { all: true }
    const all = await invoke(precheckH, makeReq({ body: { all: true } }));
    eq([all.status, all.body.assessed, all.body.more_remaining], [200, 3, false], "route: all → every queued row assessed");
    eq(all.body.results.map((r: any) => r.agentId), ["self-b", "unvetted-mail", "self-a"], "route: all → oldest first, sequential");
    eq((db.prepare("SELECT COUNT(*) AS n FROM agents WHERE origin = 'self_registered' AND is_vetted = 0").get() as any).n, 3,
      "route: all → nothing vetted");
    eq((db.prepare("SELECT is_vetted FROM agents WHERE id = 'self-vetted'").get() as any).is_vetted, 1, "route: all → vetted row untouched");

    // ── /register ──
    const regBody = (n: string, email = `post@${n}.no`) => ({
      name: `Gård ${n}`, description: "Vi selger egg og grønnsaker.", provider: "Gård", contactEmail: email,
      url: `https://${n}.no`, role: "producer",
      skills: [{ id: "sell", name: "Selg", description: "Selger mat", tags: ["egg"] }],
      location: { lat: 60.8, lng: 10.7, city: "Hamar" },
    });
    const shape = (r: { status: number; body: any }) => [r.status, r.body?.success, r.body?.message, Object.keys(r.body?.data ?? {})];

    // Flag on, deps working.
    const r1 = await invoke(registerH, makeReq({ body: regBody("reg-one"), admin: false }));
    await rp.__waitForRegistrationPrechecksForTesting();
    const row1 = db.prepare("SELECT p.registration_precheck, a.is_vetted, a.origin FROM agents a LEFT JOIN agent_registration_precheck p ON p.agent_id = a.id WHERE a.id = ?").get(r1.body.data.id) as any;
    ok(!!row1.registration_precheck, "register: precheck stored after the response (flag on)");
    eq([row1.is_vetted, row1.origin], [0, "self_registered"], "register: is_vetted stays 0 after the precheck");

    // Deps throw everywhere → same response, stored with unavailable sources, still not vetted.
    rp.__setRegistrationPrecheckDepsForTesting({
      now: () => NOW, timeoutMs: 20,
      fetchApi: async () => { throw new Error("boom"); },
      fetchSite: async () => { throw new Error("boom"); },
      resolveMx: async () => { throw Object.assign(new Error("x"), { code: "ESERVFAIL" }); },
    });
    const r2 = await invoke(registerH, makeReq({ body: regBody("reg-two"), admin: false }));
    eq(shape(r2), shape(r1), "register: same response when the precheck deps throw");
    await rp.__waitForRegistrationPrechecksForTesting();
    const row2 = db.prepare("SELECT p.registration_precheck, a.is_vetted FROM agents a LEFT JOIN agent_registration_precheck p ON p.agent_id = a.id WHERE a.id = ?").get(r2.body.data.id) as any;
    const p2 = JSON.parse(row2.registration_precheck);
    eq([p2.recommendation, p2.unavailable_sources, row2.is_vetted], ["spor_forst", ["brreg", "dns_mx", "website"], 0],
      "register: throwing deps → spor_forst with every source unavailable, not vetted");

    // The run itself fails (clock throws) → nothing stored, a warning, the response unchanged.
    rp.__setRegistrationPrecheckDepsForTesting({ ...stubDeps({}), now: () => { throw new Error("clock broke"); } });
    const r3 = await invoke(registerH, makeReq({ body: regBody("reg-three"), admin: false }));
    eq(shape(r3), shape(r1), "register: same response when the precheck run fails");
    await rp.__waitForRegistrationPrechecksForTesting();
    eq((db.prepare("SELECT p.registration_precheck FROM agents a LEFT JOIN agent_registration_precheck p ON p.agent_id = a.id WHERE a.id = ?").get(r3.body.data.id) as any).registration_precheck, null,
      "register: failed run stores nothing");
    ok(warned.some((w) => w.includes("[registration-precheck]") && w.includes(r3.body.data.id)), "register: failed run warns (id only)");

    // Kill switch.
    rp.__setRegistrationPrecheckDepsForTesting(stubDeps({}));
    process.env.REGISTRATION_PRECHECK_ENABLED = "false";
    const r4 = await invoke(registerH, makeReq({ body: regBody("reg-four"), admin: false }));
    await rp.__waitForRegistrationPrechecksForTesting();
    eq(shape(r4), shape(r1), "register: same response with the kill switch");
    eq((db.prepare("SELECT p.registration_precheck FROM agents a LEFT JOIN agent_registration_precheck p ON p.agent_id = a.id WHERE a.id = ?").get(r4.body.data.id) as any).registration_precheck, null,
      "register: REGISTRATION_PRECHECK_ENABLED=false → no precheck");
    delete process.env.REGISTRATION_PRECHECK_ENABLED;

    // A rejected registration (validation error) creates nothing and schedules nothing.
    const before = (db.prepare("SELECT COUNT(*) AS n FROM agents").get() as any).n;
    const calls: string[] = [];
    rp.__setRegistrationPrecheckDepsForTesting(stubDeps({}, calls));
    const r5 = await invoke(registerH, makeReq({ body: { name: "x" }, admin: false }));
    await rp.__waitForRegistrationPrechecksForTesting();
    eq([r5.status, (db.prepare("SELECT COUNT(*) AS n FROM agents").get() as any).n, calls.length], [400, before, 0],
      "register: rejected request → no row, no precheck");

    // The admin precheck works with the kill switch on.
    process.env.REGISTRATION_PRECHECK_ENABLED = "false";
    eq((await invoke(precheckH, makeReq({ body: { agentId: r4.body.data.id } }))).status, 200, "route: precheck works regardless of the flag");
    delete process.env.REGISTRATION_PRECHECK_ENABLED;
    eq((db.prepare("SELECT COUNT(*) AS n FROM agents WHERE origin = 'self_registered' AND is_vetted = 1 AND id <> 'self-vetted'").get() as any).n, 0,
      "never: no self_registered row was vetted by any precheck");
  } catch (err) {
    failed++;
    failures.push(`unexpected error: ${err instanceof Error ? (err.stack || err.message) : String(err)}`);
  } finally {
    console.warn = origWarn;
    rp.__setRegistrationPrecheckDepsForTesting(null);
    if (originalIndexNow) require.cache[indexNowPath] = originalIndexNow; else delete require.cache[indexNowPath];
    for (const p of ["../routes/marketplace", "../routes/admin-agents"]) {
      try { delete require.cache[require.resolve(p)]; } catch { /* ignore */ }
    }
    if (prevEnv.ADMIN_KEY === undefined) delete process.env.ADMIN_KEY; else process.env.ADMIN_KEY = prevEnv.ADMIN_KEY;
    if (prevEnv.FLAG === undefined) delete process.env.REGISTRATION_PRECHECK_ENABLED; else process.env.REGISTRATION_PRECHECK_ENABLED = prevEnv.FLAG;
    initMod.__setDbForTesting(prevDb as any);
    db.close();
  }

  return { passed, failed, failures };
}

if (require.main === module) {
  runRegistrationPrecheckTests({ log: true }).then((r) => {
    console.log(`\nregistration-precheck: ${r.passed} passed, ${r.failed} failed`);
    for (const f of r.failures) console.log(f);
    process.exit(r.failed ? 1 : 0);
  });
}
