/**
 * organic-claim-gate-s3b.test.ts — A2A dev-request 2026-10-28-rfb-okologisk-
 * merking-debio-register-og-tekstrevisjon, slice S3b (S3 punkt 1, automatic
 * doors only), AC3.1: every automated / admin content write path refuses or
 * strips an organic claim for a producer WITHOUT a valid Debio status
 * (agents.debio_verified, the S0 rule), behind RFB_ORGANIC_CLAIM_GATE.
 *
 *   unit      hasUnverifiedOrganicClaim, the flag reader, the list / product /
 *             body helpers in description-quality.ts.
 *   doors     for each gated write path: flag off → written as before; flag on
 *             + unverified → list entries stripped / free text refused with
 *             refused_organic_claim_unverified (and the outcome code logged
 *             with agent id + field); flag on + verified → written as given;
 *             flag on + no organic words → written.
 *               PUT  /admin/knowledge                          (admin-knowledge.ts)
 *               refreshHomepageContent (homepage-content-refresh)
 *               POST /admin/agents/content-correction          (admin-agents-content-correction.ts)
 *               POST /admin/agents/register                    (admin-agents.ts)
 *               POST /admin/agents/brreg-description-fallback  (admin-agents.ts)
 *               POST /admin/agents/tynne-profiler-improve      (admin-agents.ts)
 *               PUT  /api/marketplace/agents/:id/knowledge     admin lane
 *               PUT  /api/marketplace/agents/:id/description   admin lane
 *               PATCH /api/marketplace/agents/:id              admin lane
 *               POST /api/marketplace/admin/bulk-enrich
 *               POST /api/marketplace/admin/register
 *   owner     the owner's own lanes (agent API key) are not gated (S3c).
 *
 * In-memory DB on the production schema, handlers pulled off the router
 * stacks, fetch stubbed (Brreg, homepage, Anthropic) — zero network. The flag,
 * ADMIN_KEY, ANTHROPIC_API_KEY, globalThis.fetch, console.log and the getDb()
 * singleton are restored in finally.
 *
 * Exported runOrganicClaimGateS3bTests({log}) -> TestSummary; wired into
 * tests/test.ts. Standalone: npx tsx src/routes/organic-claim-gate-s3b.test.ts
 */

import Database from "better-sqlite3";
import {
  hasUnverifiedOrganicClaim, organicClaimGateEnabled, organicClaimGateApplies,
  stripOrganicListForWrite, stripOrganicCategoriesForWrite, gateOrganicProductsForWrite,
  gateOrganicFieldsForWrite, REFUSED_ORGANIC_CLAIM_UNVERIFIED, ORGANIC_CLAIM_GATE_ENV,
} from "../services/description-quality";
// skive B (dev-request 2026-10-28-rfb-uttrekk-adresse-og-hjemmeside-forverring): the about
// LLM judges approve everything here — this suite tests other guards.
import { useApproveAllAboutJudges } from "../../tests/helpers/hcr-about-judges";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

const U = "s3b-uten-status";     // no valid Debio status
const V = "s3b-med-status";      // debio_verified = 1
const ORGANIC_ABOUT = "Vi er en liten familiegård i Valdres som driver økologisk og selger grønnsaker rett fra gården hele året.";
const CLEAN_ABOUT = "Vi er en liten familiegård i Valdres som dyrker gulrøtter og poteter og selger rett fra gården hele året.";
const ORGANIC_DESC = "Økologisk gård i Valdres med gårdsutsalg.";
const CLEAN_DESC = "Familiegård i Valdres med gårdsutsalg.";

interface HandlerResult { status: number; body: any }

export async function runOrganicClaimGateS3bTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];
  const restoreAboutJudges = useApproveAllAboutJudges();

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
  function assertTrue(cond: boolean, label: string, detail?: unknown): void {
    if (cond) {
      passed++;
      if (log) console.info(`  ok ${label}`);
    } else {
      failed++;
      failures.push(`✗ ${label}${detail === undefined ? "" : `\n    detail: ${JSON.stringify(detail)}`}`);
      if (log) console.info(`  ✗ ${label}`);
    }
  }

  // ── unit: the helpers (pure) ──────────────────────────────────────────────
  {
    const unverified = { debio_verified: 0 };
    const verified = { debio_verified: 1 };
    assertTrue(hasUnverifiedOrganicClaim(ORGANIC_ABOUT, unverified), "unit-1: organic text + no status → true");
    assertTrue(!hasUnverifiedOrganicClaim(ORGANIC_ABOUT, verified), "unit-2: organic text + debio_verified=1 → false");
    assertTrue(!hasUnverifiedOrganicClaim(ORGANIC_ABOUT, { debio_verified: "1" }), "unit-3: debio_verified '1' (lenient read) → false");
    assertTrue(hasUnverifiedOrganicClaim(ORGANIC_ABOUT, null), "unit-4: unknown agent = no status → true");
    assertTrue(!hasUnverifiedOrganicClaim(CLEAN_ABOUT, unverified), "unit-5: text without organic words → false");
    assertTrue(!hasUnverifiedOrganicClaim("Vi tar vare på økologisk mangfold i kulturlandskapet.", unverified), "unit-6: «økologisk mangfold» (other meaning) → false");
    assertTrue(!hasUnverifiedOrganicClaim("Samfunnsøkonomi og økosystem.", unverified), "unit-7: økonomi / økosystem → false");
    assertTrue(hasUnverifiedOrganicClaim("Debio-sertifisert honning", unverified), "unit-8: «Debio-sertifisert» → true");
    assertTrue(!hasUnverifiedOrganicClaim(undefined, unverified) && !hasUnverifiedOrganicClaim(42, unverified), "unit-9: non-string → false");

    assertTrue(!organicClaimGateEnabled({}), "flag-1: unset → off");
    assertTrue(organicClaimGateEnabled({ [ORGANIC_CLAIM_GATE_ENV]: "1" }), "flag-2: '1' → on");
    assertTrue(organicClaimGateEnabled({ [ORGANIC_CLAIM_GATE_ENV]: "true" }), "flag-3: 'true' → on");
    assertTrue(!organicClaimGateEnabled({ [ORGANIC_CLAIM_GATE_ENV]: "0" }), "flag-4: '0' → off");
    assertTrue(!organicClaimGateApplies(unverified, {}), "flag-5: applies() false with the flag off");
    assertTrue(organicClaimGateApplies(unverified, { [ORGANIC_CLAIM_GATE_ENV]: "1" }), "flag-6: applies() true on + unverified");
    assertTrue(!organicClaimGateApplies(verified, { [ORGANIC_CLAIM_GATE_ENV]: "1" }), "flag-7: applies() false on + verified");

    assertEq(stripOrganicListForWrite(["Økologisk", "Økologiske grønnsaker", "Gårdsost", "gårdsost"]),
      { list: ["Grønnsaker", "Gårdsost", "gårdsost"], changed: true }, "list-1: organic entry dropped, «Økologiske grønnsaker» → «Grønnsaker», no de-dup");
    assertEq(stripOrganicListForWrite(["Nyt Norge", "Kortreist"]), { list: ["Nyt Norge", "Kortreist"], changed: false }, "list-2: list without organic words unchanged");
    assertEq(stripOrganicListForWrite(["org_nr:912345678", "organic", 7 as unknown as string]),
      { list: ["org_nr:912345678", 7 as unknown as string], changed: true }, "list-3: non-organic tags and non-strings kept in place");
    assertEq(stripOrganicCategoriesForWrite(["vegetables", "organic"]), { list: ["vegetables"], changed: true }, "list-4: category key «organic» dropped");
    assertEq(stripOrganicCategoriesForWrite(["vegetables"]), { list: ["vegetables"], changed: false }, "list-5: categories unchanged");

    assertEq(
      gateOrganicProductsForWrite([
        { name: "Økologiske egg", category: "eggs", organic: true },
        { name: "Økologisk", category: "other" },
        { name: "Poteter", category: "vegetables" },
        "Øko-honning",
      ]),
      { ok: true, products: [{ name: "Egg", category: "eggs", organic: false }, { name: "Poteter", category: "vegetables" }, "Honning"], changed: true },
      "prod-1: names stripped, an organic-only product dropped, organic:true → false, plain string entry stripped",
    );
    assertEq(gateOrganicProductsForWrite([{ name: "Egg", note: "Fra økologisk drift" }]), { ok: false, field: "products[0].note" }, "prod-2: organic claim in a note → refused (prose not cut)");
    const cleanProducts = [{ name: "Poteter", category: "vegetables", organic: false }];
    assertEq(gateOrganicProductsForWrite(cleanProducts), { ok: true, products: cleanProducts, changed: false }, "prod-3: clean products unchanged");

    const body = { about: ORGANIC_ABOUT, specialties: ["Økologisk kjøtt", "Lam"], certifications: ["Debio"], tags: ["organic", "lokal"], skills: [{ id: "s", tags: ["økologisk", "kjøtt"] }] };
    const g = gateOrganicFieldsForWrite(body);
    assertEq(g.refused, [{ key: "about", field: "about" }], "body-1: about with organic claim listed as refused");
    assertEq([g.data.specialties, g.data.certifications, g.data.tags, (g.data.skills as any)[0].tags],
      [["Kjøtt", "Lam"], [], ["lokal"], ["kjøtt"]], "body-2: list fields + skill tags stripped");
    assertEq(g.stripped, ["specialties", "certifications", "tags", "skills"], "body-3: stripped keys reported");
    assertEq(body.specialties, ["Økologisk kjøtt", "Lam"], "body-4: input not mutated");
    assertEq(gateOrganicFieldsForWrite({ about: CLEAN_ABOUT, tags: ["lokal"] }), { data: { about: CLEAN_ABOUT, tags: ["lokal"] }, refused: [], stripped: [] }, "body-5: clean body passes unchanged");
  }

  // ── route harness ─────────────────────────────────────────────────────────
  const initMod = require("../database/init") as typeof import("../database/init");
  const prevDb = initMod.__peekDbForTesting();
  const prevFlag = process.env[ORGANIC_CLAIM_GATE_ENV];
  const prevAdminKey = process.env.ADMIN_KEY;
  const prevAnalyticsKey = process.env.ANALYTICS_ADMIN_KEY;
  const prevAnthropic = process.env.ANTHROPIC_API_KEY;
  const prevParking = process.env.HOMEPAGE_PARKING_DISABLED;
  const prevBrregVerify = process.env.BRREG_VERIFY_ON_REGISTER;
  const prevFetch = globalThis.fetch;
  const prevLog = console.log;
  const ADMIN_KEY = "organic-claim-gate-s3b-test-key";

  const gateLogs: string[] = [];
  console.log = (...args: unknown[]) => {
    const line = args.map((a) => String(a)).join(" ");
    if (line.startsWith("[organic-claim-gate]")) gateLogs.push(line);
    if (log) prevLog(...args);
  };
  const logged = (door: string, agentId: string, field: string, outcome = REFUSED_ORGANIC_CLAIM_UNVERIFIED) =>
    gateLogs.some((l) => l.includes(door) && l.includes(outcome) && l.includes(`agent=${agentId}`) && l.includes(`field=${field}`));
  const flag = (on: boolean) => { if (on) process.env[ORGANIC_CLAIM_GATE_ENV] = "1"; else delete process.env[ORGANIC_CLAIM_GATE_ENV]; };

  function findHandler(router: any, path: string, method: string): Function {
    const layer = (router.stack as any[]).find((l: any) => l.route && l.route.path === path && l.route.methods?.[method]);
    if (!layer) throw new Error(`route not found: ${method.toUpperCase()} ${path}`);
    return layer.route.stack[layer.route.stack.length - 1].handle;
  }
  function invoke(handler: Function, o: { body?: any; params?: Record<string, string>; headers?: Record<string, string>; query?: Record<string, string> }): Promise<HandlerResult> {
    return new Promise((resolve) => {
      let status = 200;
      let settled = false;
      const settle = (body: any) => { if (!settled) { settled = true; resolve({ status, body }); } };
      const headers = o.headers ?? { "x-admin-key": ADMIN_KEY };
      const req: any = {
        method: "POST", url: "/", path: "/", originalUrl: "/", params: o.params ?? {}, body: o.body, query: o.query ?? {},
        headers, cookies: {}, ip: "127.0.0.1", protocol: "https", hostname: "rettfrabonden.com",
        get(name: string) { return headers[name.toLowerCase()]; },
      };
      const res: any = {
        status(c: number) { status = c; return res; },
        json(p: any) { settle(p); return res; },
        send(p: any) { settle(p); return res; },
        end() { settle(undefined); return res; },
        set() { return res; }, setHeader() { return res; }, header() { return res; }, type() { return res; },
      };
      try {
        const p = handler(req, res, (err?: any) => settle({ __next: true, err: err ? String(err) : undefined }));
        if (p && typeof p.catch === "function") p.catch((err: any) => settle({ __error: String(err) }));
      } catch (err) {
        settle({ __error: String(err) });
      }
    });
  }

  // fetch stub: Brreg (by org.nr), Anthropic (tynne-profiler), homepages (fixtures by URL).
  const pages = new Map<string, string>();
  const brreg = new Map<string, string>();
  let genText = "";
  const htmlRes = (html: string) => new Response(html, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
  const stubFetch = (async (url: string | URL | Request, init?: any) => {
    const u = String(url);
    if (u.includes("api.anthropic.com")) {
      const body = init?.body ? JSON.parse(init.body) : {};
      const prompt: string = body?.messages?.[0]?.content ?? "";
      const text = prompt.includes("Du er en kvalitetsdommer") ? "GODKJENN\nKonkret, kildebasert prosa." : genText;
      return { ok: true, status: 200, json: async () => ({ content: [{ type: "text", text }] }) } as unknown as Response;
    }
    if (u.includes("brreg.no")) {
      const orgNr = u.split("/").pop() || "";
      const beskrivelse = brreg.get(orgNr);
      if (beskrivelse === undefined) return { status: 404, ok: false, json: async () => ({}) } as unknown as Response;
      return {
        status: 200, ok: true,
        json: async () => ({
          organisasjonsnummer: orgNr, navn: "x", konkurs: false, underAvvikling: false,
          underTvangsavviklingEllerTvangsopplosning: false, slettedato: null,
          naeringskode1: { kode: "01.130", beskrivelse },
        }),
      } as unknown as Response;
    }
    const html = pages.get(u) ?? pages.get(u.replace(/\/$/, ""));
    if (html !== undefined) return htmlRes(html);
    return { ok: false, status: 404, url: undefined, headers: { get: () => null }, arrayBuffer: async () => new ArrayBuffer(0) } as unknown as Response;
  }) as typeof fetch;

  const db = new Database(":memory:");
  db.pragma("journal_mode = DELETE");
  db.pragma("foreign_keys = OFF");

  function seed(id: string, o: { verified: boolean; about?: string | null; description?: string; products?: unknown[]; orgNr?: string | null; website?: string | null; prov?: Record<string, unknown>; categories?: unknown[] }): void {
    db.prepare("DELETE FROM agents WHERE id = ?").run(id);
    db.prepare("DELETE FROM agent_knowledge WHERE agent_id = ?").run(id);
    db.prepare(
      `INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, city, categories, tags, vertical_id, debio_verified, org_nr)
       VALUES (?, ?, ?, 'test', ?, ?, 'producer', ?, 'Valdres', ?, '[]', 'rfb', ?, ?)`,
    ).run(id, `Gard ${id}`, o.description ?? CLEAN_DESC, `post@${id}.example.no`, `https://${id}.example.no`, `key-${id}`,
      JSON.stringify(o.categories ?? ["vegetables"]), o.verified ? 1 : 0, o.orgNr ?? null);
    db.prepare(
      `INSERT INTO agent_knowledge (agent_id, about, products, specialties, certifications, website, field_provenance, curated_fields, updated_at)
       VALUES (?, ?, ?, '[]', '[]', ?, ?, '{}', '2020-01-01T00:00:00.000Z')`,
    ).run(id, o.about === undefined ? CLEAN_ABOUT : o.about, JSON.stringify(o.products ?? [{ name: "Poteter", category: "vegetables" }]),
      o.website ?? null, JSON.stringify(o.prov ?? {}));
  }
  const agentRow = (id: string): any => db.prepare("SELECT * FROM agents WHERE id = ?").get(id);
  const knowRow = (id: string): any => db.prepare("SELECT * FROM agent_knowledge WHERE agent_id = ?").get(id);
  const json = (s: string | null | undefined) => { try { return JSON.parse(s ?? "null"); } catch { return null; } };

  try {
    initMod.__setDbForTesting(db as any);
    initMod.__initSchemaForTesting(db as any);
    process.env.ADMIN_KEY = ADMIN_KEY;
    delete process.env.ANALYTICS_ADMIN_KEY;
    delete process.env.BRREG_VERIFY_ON_REGISTER;
    delete process.env.HOMEPAGE_PARKING_DISABLED;
    process.env.ANTHROPIC_API_KEY = "test-anthropic-key-s3b";
    globalThis.fetch = stubFetch;
    try {
      const { loadConfigsAtBoot } = require("../config/vertical-config") as typeof import("../config/vertical-config");
      loadConfigsAtBoot();
    } catch { /* already loaded by another suite */ }

    for (const m of ["./admin-knowledge", "./admin-agents", "./admin-agents-content-correction", "./marketplace"]) {
      try { delete require.cache[require.resolve(m)]; } catch { /* not loaded yet */ }
    }
    const knowledgeMod = require("./admin-knowledge") as typeof import("./admin-knowledge");
    const adminAgentsRouter = (require("./admin-agents") as typeof import("./admin-agents")).default as any;
    const ccMod = require("./admin-agents-content-correction") as typeof import("./admin-agents-content-correction");
    ccMod.__setContentCorrectionDbForTesting(db as any);
    const marketplaceRouter = require("./marketplace").default as any;
    const { marketplaceRegistry } = require("../services/marketplace-registry") as typeof import("../services/marketplace-registry");
    const clearRegistryCaches = () => {
      (marketplaceRegistry as any)._agentsCache = null;
      (marketplaceRegistry as any)._statsCache = null;
      (marketplaceRegistry as any)._agentsCacheTime = 0;
      (marketplaceRegistry as any)._statsCacheTime = 0;
    };

    // ═══ PUT /admin/knowledge ═══════════════════════════════════════════════
    {
      const put = findHandler(knowledgeMod.default, "/", "put");
      const call = (body: any) => invoke(put, { body });
      const organicProducts = [
        { name: "Økologiske egg", category: "eggs", organic: true },
        { name: "Økologisk", category: "other" },
        { name: "Poteter", category: "vegetables" },
      ];

      // flag off: byte-identical (organic text and lists written as given)
      flag(false);
      seed(U, { verified: false });
      let r = await call({ agent_id: U, about: ORGANIC_ABOUT, description: ORGANIC_DESC, products: organicProducts, categories: ["vegetables", "organic"] });
      assertEq(r.status, 200, "pak-off-1: flag off → 200");
      assertEq([knowRow(U).about, agentRow(U).description], [ORGANIC_ABOUT, ORGANIC_DESC], "pak-off-2: flag off → organic about/description written");
      assertEq(json(knowRow(U).products), organicProducts, "pak-off-3: flag off → products stored as given");
      assertEq(json(agentRow(U).categories), ["vegetables", "organic"], "pak-off-4: flag off → categories stored as given");
      assertTrue(r.body.organic_claim_gate === undefined, "pak-off-5: flag off → no organic_claim_gate key in the response");

      // flag on + unverified
      flag(true);
      seed(U, { verified: false });
      r = await call({ agent_id: U, about: ORGANIC_ABOUT });
      assertEq([r.status, r.body.outcome, r.body.field], [400, REFUSED_ORGANIC_CLAIM_UNVERIFIED, "about"], "pak-on-1: organic about → 400 refused_organic_claim_unverified");
      assertEq(knowRow(U).about, CLEAN_ABOUT, "pak-on-2: about not written");
      assertTrue(logged("PUT /admin/knowledge", U, "about"), "pak-on-3: outcome logged with agent id + field", gateLogs);
      r = await call({ agent_id: U, description: ORGANIC_DESC, address: "Gardsvegen 1" });
      assertEq([r.status, r.body.outcome, r.body.field], [400, REFUSED_ORGANIC_CLAIM_UNVERIFIED, "description"], "pak-on-4: organic description → 400 refused");
      assertEq([agentRow(U).description, knowRow(U).address], [CLEAN_DESC, null], "pak-on-5: nothing in the request written (refused before any write)");
      r = await call({ agent_id: U, products: organicProducts, categories: ["vegetables", "organic"] });
      assertEq(r.status, 200, "pak-on-6: list fields → 200 (stripped, not refused)");
      assertEq(json(knowRow(U).products), [{ name: "Egg", category: "eggs", organic: false }, { name: "Poteter", category: "vegetables" }], "pak-on-7: product names stripped, organic-only product dropped, organic:true → false");
      assertEq(json(agentRow(U).categories), ["vegetables"], "pak-on-8: «organic» category dropped");
      assertTrue(Array.isArray(r.body.organic_claim_gate) && r.body.organic_claim_gate.length === 2, "pak-on-9: response lists the stripped fields", r.body);
      assertTrue(logged("PUT /admin/knowledge", U, "products", "stripped_organic_claim_unverified"), "pak-on-10: stripping logged");
      r = await call({ agent_id: U, categories: "[\"organic\",\"meat\"]" });
      assertEq([r.status, json(agentRow(U).categories)], [200, ["meat"]], "pak-on-11: pre-serialized categories string also stripped");
      r = await call({ agent_id: U, products: [{ name: "Egg", category: "eggs", note: "Fra økologisk drift" }] });
      assertEq([r.status, r.body.outcome, r.body.field], [400, REFUSED_ORGANIC_CLAIM_UNVERIFIED, "products[0].note"], "pak-on-12: organic product note → refused");
      seed(U, { verified: false });
      r = await call({ agent_id: U, about: "Vi tar vare på økologisk mangfold og selger lam og ull fra gården gjennom hele året.", description: "Sauegård i Valdres.", products: [{ name: "Lam", category: "meat" }] });
      assertEq([r.status, knowRow(U).about, agentRow(U).description], [200, "Vi tar vare på økologisk mangfold og selger lam og ull fra gården gjennom hele året.", "Sauegård i Valdres."], "pak-on-13: text without organic claim (other meaning) written");
      assertTrue(r.body.organic_claim_gate === undefined, "pak-on-14: no gate key when nothing was stripped");

      // flag on + verified: written as given
      seed(V, { verified: true });
      r = await call({ agent_id: V, about: ORGANIC_ABOUT, description: ORGANIC_DESC, products: organicProducts, categories: ["vegetables", "organic"] });
      assertEq(r.status, 200, "pak-ver-1: verified → 200");
      assertEq([knowRow(V).about, agentRow(V).description, json(knowRow(V).products), json(agentRow(V).categories)],
        [ORGANIC_ABOUT, ORGANIC_DESC, organicProducts, ["vegetables", "organic"]], "pak-ver-2: verified → everything written as given");
    }

    // ═══ homepage-content-refresh (refreshHomepageContent) ═══════════════════
    {
      const OLD = "Gammel tekst fra Google om en gård som selger fisk og skalldyr langs kysten hele året.";
      const GP = (v: string) => ({ source_type: "google_places", value: v, fetched_at: "2026-01-01T00:00:00.000Z" });
      const HP = (v: string) => ({ source_type: "website_homepage", value: v, fetched_at: "2026-01-01T00:00:00.000Z" });
      const ORGANIC_PAGE_ABOUT = "Vi driver en liten økologisk gård i Valdres og selger honning, egg og lammekjøtt rett fra gården hele året.";
      const CLEAN_PAGE_ABOUT = "Vi driver en liten gård i Valdres og selger honning, egg og lammekjøtt rett fra gården hele året.";
      const page = (about: string, extra = "") =>
        `<html><head><title>Gard</title><meta property="og:description" content="${about}"></head>` +
        `<body><h1>Gard</h1><p>Vi selger honning, egg og lammekjøtt. ${extra}</p></body></html>`;
      const hcr = async (id: string, extra: Record<string, unknown> = {}) =>
        knowledgeMod.refreshHomepageContent(db as any, [{ agent_id: id, name: `Gard ${id}`, homepage_url: `https://${id}.example.no` }] as any, {
          dryRun: false, fetchImpl: stubFetch as any, ...extra,
        });
      const seedHcr = (id: string, verified: boolean, about: string) => {
        seed(id, { verified, about: OLD, prov: { about: [GP(OLD)] } });
        pages.set(`https://${id}.example.no`, page(about));
      };

      flag(false);
      seedHcr("hcr-off", false, ORGANIC_PAGE_ABOUT);
      let res = await hcr("hcr-off");
      assertEq(knowRow("hcr-off").about, ORGANIC_PAGE_ABOUT, "hcr-off-1: flag off → organic homepage summary written to about");
      flag(true);
      seedHcr("hcr-u", false, ORGANIC_PAGE_ABOUT);
      res = await hcr("hcr-u");
      assertEq([knowRow("hcr-u").about, agentRow("hcr-u").description], [OLD, CLEAN_DESC], "hcr-on-1: flag on + unverified → about/description not written");
      assertTrue(res.skipped_unsubstantiated.some((s: any) => s.agent_id === "hcr-u" && s.reason === REFUSED_ORGANIC_CLAIM_UNVERIFIED), "hcr-on-2: skipped with refused_organic_claim_unverified", res.skipped_unsubstantiated);
      assertTrue(logged("homepage-content-refresh", "hcr-u", "about/description"), "hcr-on-3: outcome logged");
      seedHcr("hcr-v", true, ORGANIC_PAGE_ABOUT);
      await hcr("hcr-v");
      assertEq(knowRow("hcr-v").about, ORGANIC_PAGE_ABOUT, "hcr-ver-1: flag on + verified → written");
      seedHcr("hcr-clean", false, CLEAN_PAGE_ABOUT);
      await hcr("hcr-clean");
      assertEq(knowRow("hcr-clean").about, CLEAN_PAGE_ABOUT, "hcr-clean-1: flag on + summary without organic words → written");

      // product names (R6 extractor): «Økologisk helmelk» → «Helmelk»
      const GENERIC = [{ name: "Meieri", category: "dairy", seasonal: false }];
      const gp = { about: [HP(CLEAN_PAGE_ABOUT)], description: [HP(CLEAN_PAGE_ABOUT)], categories: [HP("dairy")] };
      const extractor: any = async () => ({ outcome: "names", names: ["Økologisk helmelk", "Skummamelk"] });
      const seedPn = (id: string, verified: boolean) => {
        seed(id, { verified, about: CLEAN_PAGE_ABOUT, products: GENERIC, prov: gp, categories: ["dairy"] });
        pages.set(`https://${id}.example.no`, page(CLEAN_PAGE_ABOUT, "Fra fjøset: Økologisk helmelk og Skummamelk."));
      };
      const names = (id: string) => (json(knowRow(id).products) ?? []).map((p: any) => p.name);
      flag(false);
      seedPn("pn-off", false);
      await hcr("pn-off", { extractProductNames: extractor });
      assertEq(names("pn-off"), ["Økologisk helmelk", "Skummamelk"], "hcr-pn-off: flag off → names written as on the page");
      flag(true);
      seedPn("pn-u", false);
      await hcr("pn-u", { extractProductNames: extractor });
      assertEq(names("pn-u"), ["Helmelk", "Skummamelk"], "hcr-pn-on: flag on + unverified → organic word stripped from the name");
      assertTrue(logged("homepage-content-refresh", "pn-u", "products", "stripped_organic_claim_unverified"), "hcr-pn-log: stripping logged");
      seedPn("pn-v", true);
      await hcr("pn-v", { extractProductNames: extractor });
      assertEq(names("pn-v"), ["Økologisk helmelk", "Skummamelk"], "hcr-pn-ver: flag on + verified → names as on the page");
    }

    // ═══ POST /admin/agents/content-correction ═══════════════════════════════
    {
      const post = findHandler(ccMod.default, "/", "post");
      const call = (items: any[], apply = true) => invoke(post, { body: { apply, reason: "s3b test", items } });
      const products = [{ name: "Gulrøtter", category: "vegetables" }];

      flag(false);
      seed(U, { verified: false, products });
      let r = await call([{ agent_id: U, field: "description", text: ORGANIC_DESC }, { agent_id: U, field: "about", text: ORGANIC_ABOUT }, { agent_id: U, field: "product_name", old_name: "Gulrøtter", text: "Økologiske gulrøtter" }]);
      assertEq(r.body.results.map((x: any) => x.outcome), ["written", "written", "written"], "cc-off-1: flag off → organic text written");
      assertEq([agentRow(U).description, knowRow(U).about, json(knowRow(U).products)[0].name], [ORGANIC_DESC, ORGANIC_ABOUT, "Økologiske gulrøtter"], "cc-off-2: values stored");

      flag(true);
      seed(U, { verified: false, products });
      r = await call([{ agent_id: U, field: "description", text: ORGANIC_DESC }, { agent_id: U, field: "about", text: ORGANIC_ABOUT }, { agent_id: U, field: "product_name", old_name: "Gulrøtter", text: "Økologiske gulrøtter" }], false);
      assertEq(r.body.results.map((x: any) => x.outcome), [REFUSED_ORGANIC_CLAIM_UNVERIFIED, REFUSED_ORGANIC_CLAIM_UNVERIFIED, REFUSED_ORGANIC_CLAIM_UNVERIFIED], "cc-on-1: dry run reports refused_organic_claim_unverified");
      const auditCount = () => (db.prepare("SELECT COUNT(*) AS n FROM agent_knowledge_audit WHERE agent_id = ?").get(U) as any).n;
      const auditBefore = auditCount();
      r = await call([{ agent_id: U, field: "description", text: ORGANIC_DESC }, { agent_id: U, field: "about", text: ORGANIC_ABOUT }, { agent_id: U, field: "product_name", old_name: "Gulrøtter", text: "Økologiske gulrøtter" }]);
      assertEq(r.body.results.map((x: any) => x.outcome), [REFUSED_ORGANIC_CLAIM_UNVERIFIED, REFUSED_ORGANIC_CLAIM_UNVERIFIED, REFUSED_ORGANIC_CLAIM_UNVERIFIED], "cc-on-2: apply refuses all three");
      assertEq([agentRow(U).description, knowRow(U).about, json(knowRow(U).products)[0].name], [CLEAN_DESC, CLEAN_ABOUT, "Gulrøtter"], "cc-on-3: nothing written");
      assertEq(auditCount(), auditBefore, "cc-on-4: no audit row for a refused item");
      assertEq(r.body.counts[REFUSED_ORGANIC_CLAIM_UNVERIFIED], 3, "cc-on-5: counted under the outcome code");
      assertTrue(logged("content-correction", U, "description") && logged("content-correction", U, "about") && logged("content-correction", U, "product_name"), "cc-on-6: outcome logged per item");
      r = await call([{ agent_id: U, field: "description", text: "Ny tekst om gården i Valdres." }]);
      assertEq([r.body.results[0].outcome, agentRow(U).description], ["written", "Ny tekst om gården i Valdres."], "cc-clean-1: text without organic words written");
      db.prepare("UPDATE agent_knowledge SET specialties = ? WHERE agent_id = ?").run(JSON.stringify(["Økologisk kjøtt", "Lam"]), U);
      r = await call([{ agent_id: U, field: "specialties", remove: ["Økologisk kjøtt"] }, { agent_id: U, field: "products_organic_flag" }]);
      assertEq(r.body.results[0].outcome, "written", "cc-clean-2: list removals (which only take claims away) unaffected");

      seed(V, { verified: true, products });
      r = await call([{ agent_id: V, field: "description", text: ORGANIC_DESC }, { agent_id: V, field: "product_name", old_name: "Gulrøtter", text: "Økologiske gulrøtter" }]);
      assertEq(r.body.results.map((x: any) => x.outcome), ["written", "written"], "cc-ver-1: verified → written");
      assertEq([agentRow(V).description, json(knowRow(V).products)[0].name], [ORGANIC_DESC, "Økologiske gulrøtter"], "cc-ver-2: values stored");
    }

    // ═══ POST /admin/agents/register (admin-agents.ts, harvest) ══════════════
    {
      const post = findHandler(adminAgentsRouter, "/register", "post");
      let n = 0;
      const call = (o: Record<string, unknown>) => invoke(post, { body: { name: `Register Gard ${++n}`, url: `https://reg${n}.example.no`, city: "Valdres", vertical_id: "rfb", ...o } });
      flag(false);
      let r = await call({ description: ORGANIC_DESC, tags: ["organic", "gårdsutsalg"], categories: ["vegetables", "organic"] });
      assertEq(r.status, 201, "reg-off-1: flag off → registered");
      let row = agentRow(r.body?.id ?? r.body?.data?.id ?? r.body?.agent_id);
      assertEq([row?.description, json(row?.tags), json(row?.categories)], [ORGANIC_DESC, ["organic", "gårdsutsalg"], ["vegetables", "organic"]], "reg-off-2: stored as given");
      flag(true);
      r = await call({ description: ORGANIC_DESC });
      assertEq([r.status, r.body.outcome, r.body.field], [400, REFUSED_ORGANIC_CLAIM_UNVERIFIED, "description"], "reg-on-1: organic description → 400 refused");
      assertTrue(gateLogs.some((l) => l.includes("POST /admin/agents/register") && l.includes(REFUSED_ORGANIC_CLAIM_UNVERIFIED) && l.includes("field=description")), "reg-on-2: refusal logged");
      r = await call({ description: CLEAN_DESC, tags: ["organic", "gårdsutsalg"], categories: ["vegetables", "organic"], org_nr: "912345678" });
      assertEq(r.status, 201, "reg-on-3: clean description → registered");
      const regId = r.body?.id ?? r.body?.data?.id ?? r.body?.agent_id;
      row = agentRow(regId);
      assertEq([row?.description, json(row?.tags), json(row?.categories)], [CLEAN_DESC, ["org_nr:912345678", "gårdsutsalg"], ["vegetables"]], "reg-on-4: organic tag / category stripped, system tags kept");
      assertTrue(logged("POST /admin/agents/register", String(regId), "tags", "stripped_organic_claim_unverified"), "reg-on-5: stripping logged with the new id");
    }

    // ═══ POST /admin/agents/brreg-description-fallback ═══════════════════════
    {
      const post = findHandler(adminAgentsRouter, "/brreg-description-fallback", "post");
      const ORGANIC_BRREG = "Dyrking av økologiske grønnsaker";
      const CLEAN_BRREG = "Dyrking av grønnsaker";
      const run = async (apply: boolean) => (await invoke(post, { body: { apply, limit: 100 } })).body;
      db.exec("DELETE FROM agents");
      db.exec("DELETE FROM agent_knowledge");
      const seedB = (id: string, verified: boolean, orgNr: string, text: string) => { seed(id, { verified, description: "", orgNr }); brreg.set(orgNr, text); };
      flag(false);
      seedB("br-off", false, "911111111", ORGANIC_BRREG);
      await run(true);
      assertEq(agentRow("br-off").description, ORGANIC_BRREG, "brreg-off-1: flag off → Brreg text written");
      flag(true);
      seedB("br-u", false, "922222222", ORGANIC_BRREG);
      seedB("br-v", true, "933333333", ORGANIC_BRREG);
      seedB("br-clean", false, "944444444", CLEAN_BRREG);
      const dry = await run(false);
      assertTrue(dry.skipped.some((s: any) => s.agent_id === "br-u" && s.reason === REFUSED_ORGANIC_CLAIM_UNVERIFIED), "brreg-on-1: dry run reports the refusal", dry);
      const applied = await run(true);
      assertEq(agentRow("br-u").description, "", "brreg-on-2: unverified → not written");
      assertTrue(applied.skipped.some((s: any) => s.agent_id === "br-u" && s.reason === REFUSED_ORGANIC_CLAIM_UNVERIFIED), "brreg-on-3: skipped with refused_organic_claim_unverified", applied);
      assertTrue(logged("brreg-description-fallback", "br-u", "description"), "brreg-on-4: outcome logged");
      assertEq([agentRow("br-v").description, agentRow("br-clean").description], [ORGANIC_BRREG, CLEAN_BRREG], "brreg-on-5: verified and clean text written");
    }

    // ═══ POST /admin/agents/tynne-profiler-improve ═══════════════════════════
    {
      const post = findHandler(adminAgentsRouter, "/tynne-profiler-improve", "post");
      const SRC = (name: string) => `<html><body><p>${name} ligger i Valdres og lager geitost av melk fra egne geiter, med lang tradisjon i familien. Garden mottok Spesialitetsmerket fra Matmerk for brunosten sin.</p></body></html>`;
      const seedT = (id: string, verified: boolean) => {
        seed(id, { verified, description: "kort tekst", website: `https://${id}.example` });
        db.prepare("DELETE FROM agents_tynne_profiler_queue WHERE agent_id = ?").run(id);
        db.prepare(
          `INSERT INTO agents_tynne_profiler_queue (id, agent_id, agent_name, flagged_fields, priority_tier, cause, status, first_seen_at, last_seen_at)
           VALUES (?, ?, ?, '["description"]', 'description_only', 'no_source', 'pending', datetime('now'), datetime('now'))`,
        ).run(`q-${id}`, id, `Gard ${id}`);
        pages.set(`https://${id}.example`, SRC(`Gard ${id}`));
      };
      const outcomeOf = (r: HandlerResult, id: string) => r.body?.results?.find((x: any) => x.agent_id === id)?.fields?.description?.outcome;
      const ORGANIC_GEN = "Garden ligger i Valdres og lager økologisk geitost av melk fra egne geiter, og har mottatt Spesialitetsmerket fra Matmerk.";
      const CLEAN_GEN = "Garden ligger i Valdres og lager geitost av melk fra egne geiter, og har mottatt Spesialitetsmerket fra Matmerk.";
      genText = ORGANIC_GEN;
      flag(false);
      seedT("tp-off", false);
      let r = await invoke(post, { body: { agentIds: ["tp-off"] } });
      assertEq(outcomeOf(r, "tp-off"), "approved", "tynn-off-1: flag off → organic candidate approved (dry run)");
      flag(true);
      seedT("tp-u", false);
      r = await invoke(post, { body: { agentIds: ["tp-u"], apply: true } });
      assertEq(outcomeOf(r, "tp-u"), REFUSED_ORGANIC_CLAIM_UNVERIFIED, "tynn-on-1: flag on + unverified → refused_organic_claim_unverified");
      assertEq(agentRow("tp-u").description, "kort tekst", "tynn-on-2: description not written");
      assertTrue(logged("tynne-profiler-improve", "tp-u", "description"), "tynn-on-3: outcome logged");
      assertEq((db.prepare("SELECT cause FROM agents_tynne_profiler_queue WHERE agent_id = 'tp-u'").get() as any)?.cause, REFUSED_ORGANIC_CLAIM_UNVERIFIED, "tynn-on-4: queue cause records the refusal");
      seedT("tp-v", true);
      r = await invoke(post, { body: { agentIds: ["tp-v"], apply: true } });
      assertEq([outcomeOf(r, "tp-v"), agentRow("tp-v").description], ["written", ORGANIC_GEN], "tynn-ver-1: verified → written");
      genText = CLEAN_GEN;
      seedT("tp-clean", false);
      r = await invoke(post, { body: { agentIds: ["tp-clean"], apply: true } });
      assertEq([outcomeOf(r, "tp-clean"), agentRow("tp-clean").description], ["written", CLEAN_GEN], "tynn-clean-1: candidate without organic words → written");
    }

    // ═══ marketplace.ts admin lanes ══════════════════════════════════════════
    {
      const putKnowledge = findHandler(marketplaceRouter, "/agents/:id/knowledge", "put");
      const putDescription = findHandler(marketplaceRouter, "/agents/:id/description", "put");
      const patchAgent = findHandler(marketplaceRouter, "/agents/:id", "patch");
      const bulk = findHandler(marketplaceRouter, "/admin/bulk-enrich", "post");
      const adminRegister = findHandler(marketplaceRouter, "/admin/register", "post");
      const specs = (id: string) => json(knowRow(id).specialties);

      // PUT /agents/:id/knowledge
      flag(false);
      seed(U, { verified: false });
      let r = await invoke(putKnowledge, { params: { id: U }, body: { about: ORGANIC_ABOUT, specialties: ["Økologisk kjøtt", "Lam"] } });
      assertEq([r.status, knowRow(U).about, specs(U)], [200, ORGANIC_ABOUT, ["Økologisk kjøtt", "Lam"]], "mpk-off-1: flag off → written as given");
      flag(true);
      seed(U, { verified: false });
      r = await invoke(putKnowledge, { params: { id: U }, body: { about: ORGANIC_ABOUT } });
      assertEq([r.status, r.body.outcome, r.body.field, knowRow(U).about], [400, REFUSED_ORGANIC_CLAIM_UNVERIFIED, "about", CLEAN_ABOUT], "mpk-on-1: admin lane, organic about → 400 refused, not written");
      assertTrue(logged("PUT /agents/:id/knowledge", U, "about"), "mpk-on-2: outcome logged");
      r = await invoke(putKnowledge, { params: { id: U }, body: { specialties: ["Økologisk kjøtt", "Lam"], certifications: ["Debio-sertifisert", "Nyt Norge"], products: [{ name: "Økologisk lam", category: "meat", organic: true }] } });
      assertEq(r.status, 200, "mpk-on-3: admin lane, lists → 200");
      assertEq([specs(U), json(knowRow(U).certifications)], [["Kjøtt", "Lam"], ["Nyt Norge"]], "mpk-on-4: specialties / certifications stripped");
      const lam = (json(knowRow(U).products) ?? [])[0] ?? {};
      assertEq([lam.name, !!lam.organic], ["Lam", false], "mpk-on-5: product name stripped, organic flag cleared");
      r = await invoke(putKnowledge, { params: { id: U }, body: { about: CLEAN_ABOUT + " Nå også med ull." } });
      assertEq([r.status, knowRow(U).about], [200, CLEAN_ABOUT + " Nå også med ull."], "mpk-clean-1: clean about written");
      r = await invoke(putKnowledge, { params: { id: U }, headers: { "x-api-key": `key-${U}` }, body: { about: ORGANIC_ABOUT } });
      assertEq([r.status, knowRow(U).about], [200, ORGANIC_ABOUT], "mpk-owner-1: the agent's own key lane is not gated (S3c)");
      seed(V, { verified: true });
      r = await invoke(putKnowledge, { params: { id: V }, body: { about: ORGANIC_ABOUT, specialties: ["Økologisk kjøtt"] } });
      assertEq([r.status, knowRow(V).about, specs(V)], [200, ORGANIC_ABOUT, ["Økologisk kjøtt"]], "mpk-ver-1: verified → written as given");

      // PUT /agents/:id/description
      flag(false);
      seed(U, { verified: false });
      r = await invoke(putDescription, { params: { id: U }, body: { description: ORGANIC_DESC } });
      assertEq([r.status, agentRow(U).description], [200, ORGANIC_DESC], "mpd-off-1: flag off → written");
      flag(true);
      seed(U, { verified: false });
      r = await invoke(putDescription, { params: { id: U }, body: { description: ORGANIC_DESC } });
      assertEq([r.status, r.body.outcome, agentRow(U).description], [400, REFUSED_ORGANIC_CLAIM_UNVERIFIED, CLEAN_DESC], "mpd-on-1: admin lane → refused, not written");
      assertTrue(logged("PUT /agents/:id/description", U, "description"), "mpd-on-2: outcome logged");
      r = await invoke(putDescription, { params: { id: U }, body: { description: "Sauegård i Valdres." } });
      assertEq([r.status, agentRow(U).description], [200, "Sauegård i Valdres."], "mpd-clean-1: clean description written");
      r = await invoke(putDescription, { params: { id: U }, headers: { "x-api-key": `key-${U}` }, body: { description: ORGANIC_DESC } });
      assertEq([r.status, agentRow(U).description], [200, ORGANIC_DESC], "mpd-owner-1: the agent's own key lane is not gated (S3c)");
      seed(V, { verified: true });
      r = await invoke(putDescription, { params: { id: V }, body: { description: ORGANIC_DESC } });
      assertEq([r.status, agentRow(V).description], [200, ORGANIC_DESC], "mpd-ver-1: verified → written");

      // PATCH /agents/:id
      flag(false);
      seed(U, { verified: false });
      clearRegistryCaches();
      r = await invoke(patchAgent, { params: { id: U }, body: { tags: ["organic", "lokal"] } });
      assertEq([r.status, json(agentRow(U).tags)], [200, ["organic", "lokal"]], "mpp-off-1: flag off → tags written as given");
      flag(true);
      r = await invoke(patchAgent, { params: { id: U }, body: { description: ORGANIC_DESC } });
      assertEq([r.status, r.body.outcome, agentRow(U).description], [400, REFUSED_ORGANIC_CLAIM_UNVERIFIED, CLEAN_DESC], "mpp-on-1: admin lane, organic description → refused");
      assertTrue(logged("PATCH /agents/:id", U, "description"), "mpp-on-2: outcome logged");
      r = await invoke(patchAgent, { params: { id: U }, body: { tags: ["organic", "lokal"], categories: ["vegetables", "organic"] } });
      assertEq([r.status, json(agentRow(U).tags), json(agentRow(U).categories)], [200, ["lokal"], ["vegetables"]], "mpp-on-3: admin lane, tags / categories stripped");
      r = await invoke(patchAgent, { params: { id: U }, headers: { "x-api-key": `key-${U}` }, body: { tags: ["organic", "lokal"] } });
      assertEq([r.status, json(agentRow(U).tags)], [200, ["organic", "lokal"]], "mpp-owner-1: the agent's own key lane is not gated (S3c)");
      seed(V, { verified: true });
      r = await invoke(patchAgent, { params: { id: V }, body: { description: ORGANIC_DESC, tags: ["organic"] } });
      assertEq([r.status, agentRow(V).description, json(agentRow(V).tags)], [200, ORGANIC_DESC, ["organic"]], "mpp-ver-1: verified → written as given");

      // POST /admin/bulk-enrich
      flag(false);
      seed(U, { verified: false });
      r = await invoke(bulk, { body: { agents: [{ agentId: U, data: { about: ORGANIC_ABOUT, specialties: ["Økologisk kjøtt", "Lam"] } }] } });
      assertEq([r.status, knowRow(U).about, specs(U)], [200, ORGANIC_ABOUT, ["Økologisk kjøtt", "Lam"]], "mpb-off-1: flag off → written as given");
      assertTrue(r.body?.data?.organicClaimGate === undefined, "mpb-off-2: no gate key in the response");
      flag(true);
      seed(U, { verified: false });
      seed(V, { verified: true });
      r = await invoke(bulk, { body: { agents: [
        { agentId: U, data: { about: ORGANIC_ABOUT, specialties: ["Økologisk kjøtt", "Lam"] } },
        { agentId: V, data: { about: ORGANIC_ABOUT, specialties: ["Økologisk kjøtt"] } },
      ] } });
      assertEq(r.status, 200, "mpb-on-1: 200");
      assertEq([knowRow(U).about, specs(U)], [CLEAN_ABOUT, ["Kjøtt", "Lam"]], "mpb-on-2: unverified entry — about dropped (not written), specialties stripped");
      assertEq([knowRow(V).about, specs(V)], [ORGANIC_ABOUT, ["Økologisk kjøtt"]], "mpb-ver-1: verified entry written as given");
      assertTrue((r.body?.data?.organicClaimGate ?? []).some((x: any) => x.agentId === U && x.field === "about" && x.outcome === REFUSED_ORGANIC_CLAIM_UNVERIFIED), "mpb-on-3: refusal reported per entry", r.body?.data);
      assertTrue(logged("POST /admin/bulk-enrich", U, "about"), "mpb-on-4: outcome logged");

      // POST /admin/register (the enrichment routine's registration door)
      let n = 0;
      const reg = (o: Record<string, unknown>) => invoke(adminRegister, { body: { name: `Admin Register Gard ${++n}`, ...o } });
      flag(false);
      r = await reg({ description: ORGANIC_DESC, tags: ["organic", "lokal"] });
      assertEq(r.status, 201, "mpr-off-1: flag off → registered");
      let row = agentRow(r.body?.data?.id);
      assertEq([row?.description, json(row?.tags)], [ORGANIC_DESC, ["organic", "lokal"]], "mpr-off-2: stored as given");
      flag(true);
      r = await reg({ description: ORGANIC_DESC });
      assertEq([r.status, r.body.outcome, r.body.field], [400, REFUSED_ORGANIC_CLAIM_UNVERIFIED, "description"], "mpr-on-1: organic description → 400 refused");
      assertTrue(gateLogs.some((l) => l.includes("POST /admin/register") && l.includes(REFUSED_ORGANIC_CLAIM_UNVERIFIED) && l.includes("field=description")), "mpr-on-2: refusal logged");
      r = await reg({ description: CLEAN_DESC, tags: ["organic", "lokal"], categories: ["vegetables", "organic"] });
      assertEq(r.status, 201, "mpr-on-3: clean description → registered");
      row = agentRow(r.body?.data?.id);
      assertEq([row?.description, json(row?.tags), json(row?.categories)], [CLEAN_DESC, ["lokal"], ["vegetables"]], "mpr-on-4: organic tag / category stripped");
    }
  } catch (err: any) {
    failed++;
    failures.push(`✗ unexpected error: ${err?.stack || err?.message || String(err)}`);
  } finally {
    restoreAboutJudges();
    console.log = prevLog;
    globalThis.fetch = prevFetch;
    const restore = (k: string, v: string | undefined) => { if (v === undefined) delete process.env[k]; else process.env[k] = v; };
    restore(ORGANIC_CLAIM_GATE_ENV, prevFlag);
    restore("ADMIN_KEY", prevAdminKey);
    restore("ANALYTICS_ADMIN_KEY", prevAnalyticsKey);
    restore("ANTHROPIC_API_KEY", prevAnthropic);
    restore("HOMEPAGE_PARKING_DISABLED", prevParking);
    restore("BRREG_VERIFY_ON_REGISTER", prevBrregVerify);
    try { (require("./admin-agents-content-correction") as typeof import("./admin-agents-content-correction")).__setContentCorrectionDbForTesting(null); } catch { /* ignore */ }
    if (prevDb) initMod.__setDbForTesting(prevDb);
    try {
      const { marketplaceRegistry } = require("../services/marketplace-registry") as typeof import("../services/marketplace-registry");
      (marketplaceRegistry as any)._agentsCache = null;
      (marketplaceRegistry as any)._statsCache = null;
    } catch { /* ignore */ }
    try { db.close(); } catch { /* ignore */ }
  }

  return { passed, failed, failures };
}

if (require.main === module) {
  runOrganicClaimGateS3bTests({ log: true }).then((r) => {
    console.log(`\norganic-claim-gate-s3b: ${r.passed} passed, ${r.failed} failed`);
    for (const f of r.failures) console.log(f);
    process.exit(r.failed > 0 ? 1 : 0);
  });
}
