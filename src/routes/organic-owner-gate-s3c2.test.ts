/**
 * organic-owner-gate-s3c2.test.ts — A2A dev-request 2026-10-28-rfb-okologisk-
 * merking-debio-register-og-tekstrevisjon, slice S3c-2 (the owner's own text
 * on every public read, not only the profile page): RFB_ORGANIC_CLAIM_GATE +
 * RFB_ORGANIC_OWNER_GATE (both default off).
 *
 *   AC1   knowledgeService.getAgentInfo(id).knowledge.about for an unverified
 *         producer with an owner-written «Vi selger økologisk lammekjøtt.
 *         Gården ligger i Hurdal.», both flags on → «Gården ligger i Hurdal.»;
 *         ownerView → unchanged; either flag off → unchanged; verified (Debio)
 *         → unchanged; non-owner about → unchanged; every sentence organic → "".
 *   AC2   GET /api/marketplace/agents/:id/info (marketplace router) and MCP
 *         lokal_info: filtered with flags on, unchanged with flags off.
 *   more  the public surfaces that do not read getAgentInfo: A2A
 *         /agents/:id/agent.json x-knowledge.about, /llms-full.txt, the SEO
 *         helpers applyPublishedTranslations (featured cards' translated about)
 *         and renderRelatedSection (about preview); the shared ownerWroteAbout
 *         helper; the stored text is never changed.
 *
 * In-memory DB on the production schema, handlers pulled off the router
 * stacks — zero network. Env vars, console.log and the getDb() singleton are
 * restored in finally.
 *
 * Exported runOrganicOwnerGateS3c2Tests({log}) -> TestSummary; wired into
 * tests/test.ts. Standalone: npx tsx src/routes/organic-owner-gate-s3c2.test.ts
 */

import Database from "better-sqlite3";
import { ORGANIC_OWNER_GATE_ENV, ORGANIC_CLAIM_GATE_ENV } from "../services/description-quality";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

interface HandlerResult { status: number; body: any }

const U = "s3c2-uten-status";     // no valid Debio status, owner-written about
const V = "s3c2-med-status";      // debio_verified = 1, owner-written about
const N = "s3c2-ikke-eier";       // no valid status, about not written by the owner
const NAMES: Record<string, string> = {
  [U]: "Hurdalbakken Testgard",
  [V]: "Godkjentbakken Testgard",
  [N]: "Rutinebakken Testgard",
};
const OWNER_TEXT = "Vi selger økologisk lammekjøtt. Gården ligger i Hurdal.";
const KEPT = "Gården ligger i Hurdal.";
const EN_TEXT = "We sell organic lamb. The farm is in Hurdal.";
const EN_KEPT = "The farm is in Hurdal.";
const ALL_ORGANIC = "Alt vi selger er økologisk. Vi er Debio-sertifisert.";

export async function runOrganicOwnerGateS3c2Tests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];

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

  const initMod = require("../database/init") as typeof import("../database/init");
  const prevDb = initMod.__peekDbForTesting();
  const ENV_KEYS = [ORGANIC_CLAIM_GATE_ENV, ORGANIC_OWNER_GATE_ENV, "PROFILE_TRANSLATIONS_SERVE_ENABLED", "RFB_DEBIO_REGISTER_SYNC",
    "OWNER_FEATURES_ENFORCE", "OWNER_FEATURES_ALLOWED_SUBJECTS", "OWNER_PAUSE_ENABLED", "OWNER_VISIBILITY_ENFORCED"];
  const prevEnv: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) prevEnv[k] = process.env[k];
  const setEnv = (k: string, v: string | null) => { if (v === null) delete process.env[k]; else process.env[k] = v; };
  const flags = (claim: boolean, owner: boolean) => { setEnv(ORGANIC_CLAIM_GATE_ENV, claim ? "1" : null); setEnv(ORGANIC_OWNER_GATE_ENV, owner ? "1" : null); };
  const prevLog = console.log;
  const prevWarn = console.warn;
  if (!log) { console.log = () => { /* quiet */ }; console.warn = () => { /* quiet */ }; }

  function findHandler(router: any, path: string, method: string): Function {
    const layer = (router.stack as any[]).find((l: any) => l.route && l.route.path === path && l.route.methods?.[method]);
    if (!layer) throw new Error(`route not found: ${method.toUpperCase()} ${path}`);
    return layer.route.stack[layer.route.stack.length - 1].handle;
  }
  function makeReq(o: { params?: Record<string, string>; headers?: Record<string, string> }): any {
    const headers: Record<string, string> = { host: "rettfrabonden.com", ...(o.headers || {}) };
    return {
      method: "GET", url: "/", path: "/", originalUrl: "/",
      params: o.params || {}, body: {}, query: {}, headers, cookies: {},
      ip: "127.0.0.1", lang: "no", protocol: "https", hostname: "rettfrabonden.com",
      get(name: string) { return headers[name.toLowerCase()]; },
    };
  }
  function invoke(handler: Function, req: any): Promise<HandlerResult> {
    return new Promise((resolve) => {
      let status = 200;
      let settled = false;
      const settle = (body: any) => { if (!settled) { settled = true; resolve({ status, body }); } };
      const res: any = {
        status(c: number) { status = c; return res; },
        json(p: any) { settle(p); return res; },
        send(p: any) { settle(p); return res; },
        redirect(c: number, loc?: string) { if (typeof c === "number") status = c; settle({ __redirect: loc ?? c }); return res; },
        end() { settle(undefined); return res; },
        header() { return res; }, set() { return res; }, type() { return res; }, cookie() { return res; },
        setHeader() { return res; }, clearCookie() { return res; }, vary() { return res; },
      };
      try {
        const p = handler(req, res, (err?: any) => settle({ __next: true, err: err ? String(err) : undefined }));
        if (p && typeof p.catch === "function") p.catch((err: any) => settle({ __error: String(err) }));
      } catch (err) {
        settle({ __error: String(err) });
      }
    });
  }

  const { store } = require("../services/store") as typeof import("../services/store");
  const db = new Database(":memory:");
  db.pragma("journal_mode = DELETE");
  db.pragma("foreign_keys = OFF");

  function seed(id: string, o: { verified: boolean; about: string; ownerAbout: boolean }): void {
    db.prepare("DELETE FROM agents WHERE id = ?").run(id);
    db.prepare("DELETE FROM agent_knowledge WHERE agent_id = ?").run(id);
    db.prepare(
      `INSERT INTO agents
         (id, name, description, provider, contact_email, url, role, api_key, lat, lng, city,
          categories, tags, trust_score, is_active, is_verified, origin, vertical_id, catalog_hidden, claimed_at, debio_verified)
       VALUES (?, ?, '', 'test', ?, ?, 'producer', ?, 60.43, 11.06, 'Hurdal', '["meat"]', '[]', 0.7, 1, 1, 'discovery', 'rfb', 0, '2026-10-01T00:00:00.000Z', ?)`,
    ).run(id, NAMES[id], `post@${id}.example.no`, `https://${id}.example.no`, `key-${id}`, o.verified ? 1 : 0);
    db.prepare(
      `INSERT INTO agent_knowledge
         (agent_id, email, website, phone, address, postal_code, about, products, curated_fields, verification_status, verified_second_line,
          enrichment_status, url_last_status, url_last_probed, last_verified_at, updated_at)
       VALUES (?, ?, ?, '+47 912 34 567', 'Gardsvegen 12', '2090', ?, ?, ?, 'verified', 0, 'rich', 200, datetime('now'), '2026-01-01T00:00:00.000Z', '2026-09-01T10:00:00.000Z')`,
    ).run(id, `post@${id}.example.no`, `https://${id}.example.no`, o.about,
      JSON.stringify([{ name: "Lammekjøtt", price: "200 kr/kg", category: "meat" }]),
      JSON.stringify(o.ownerAbout ? { about: { locked_at: "2026-09-01T10:00:00.000Z", by: "owner" } } : {}));
  }
  const aboutOf = (id: string) => (db.prepare("SELECT about FROM agent_knowledge WHERE agent_id = ?").get(id) as any)?.about;

  try {
    initMod.__setDbForTesting(db as any);
    initMod.__initSchemaForTesting(db as any);
    for (const k of ENV_KEYS) setEnv(k, null);
    const { loadConfigsAtBoot } = require("../config/vertical-config") as typeof import("../config/vertical-config");
    try { loadConfigsAtBoot(); } catch { /* already loaded by another suite */ }
    for (const m of ["./marketplace", "./mcp", "./a2a", "./discovery", "./seo"]) {
      try { delete require.cache[require.resolve(m)]; } catch { /* not loaded yet */ }
    }
    const { marketplaceRegistry } = require("../services/marketplace-registry") as typeof import("../services/marketplace-registry");
    const clearRegistryCaches = () => {
      (marketplaceRegistry as any)._agentsCache = null; (marketplaceRegistry as any)._statsCache = null;
      (marketplaceRegistry as any)._agentsCacheTime = 0; (marketplaceRegistry as any)._statsCacheTime = 0;
    };
    const ks = require("../services/knowledge-service") as typeof import("../services/knowledge-service");
    const { knowledgeService } = ks;

    seed(U, { verified: false, about: OWNER_TEXT, ownerAbout: true });
    seed(V, { verified: true, about: OWNER_TEXT, ownerAbout: true });
    seed(N, { verified: false, about: OWNER_TEXT, ownerAbout: false });

    // ═══ shared helpers ════════════════════════════════════════════════════
    assertEq([ks.ownerWroteAbout(U), ks.ownerWroteAbout(V), ks.ownerWroteAbout(N), ks.ownerWroteAbout("finnes-ikke")], [true, true, false, false],
      "helper-1: ownerWroteAbout reads curated_fields.about.by (no row → false)");
    db.prepare("UPDATE agent_knowledge SET curated_fields = 'ikke json' WHERE agent_id = ?").run(N);
    assertEq(ks.ownerWroteAbout(N), false, "helper-2: unreadable curated_fields → false");
    seed(N, { verified: false, about: OWNER_TEXT, ownerAbout: false });
    assertEq([ks.aboutIsOwnerWritten(null), ks.aboutIsOwnerWritten([]), ks.aboutIsOwnerWritten({ about: null }), ks.aboutIsOwnerWritten({ about: { by: "admin" } }), ks.aboutIsOwnerWritten({ about: { by: "owner" } })],
      [false, false, false, false, true], "helper-3: aboutIsOwnerWritten");
    flags(false, false);
    assertTrue(ks.publicOwnerAboutText(U, OWNER_TEXT) === OWNER_TEXT, "helper-4: flags off → publicOwnerAboutText unchanged");
    assertEq([ks.publicOwnerAboutText(U, null), ks.publicOwnerAboutText(U, undefined), ks.publicOwnerAboutText(U, "")], [null, undefined, ""], "helper-5: empty values pass through");
    flags(true, true);
    assertEq([ks.publicOwnerAboutText(U, OWNER_TEXT), ks.publicOwnerAboutText(V, OWNER_TEXT), ks.publicOwnerAboutText(N, OWNER_TEXT)], [KEPT, OWNER_TEXT, OWNER_TEXT],
      "helper-6: flags on → only the unverified owner text is filtered");
    assertEq(ks.publicOwnerAboutText("finnes-ikke", OWNER_TEXT), OWNER_TEXT, "helper-7: no knowledge row → not owner-written → unchanged");

    // ═══ AC1: getAgentInfo ═════════════════════════════════════════════════
    const infoAbout = (id: string, o: { ownerView?: boolean } = {}) => knowledgeService.getAgentInfo(id, o)?.knowledge.about;
    flags(true, true);
    assertEq(infoAbout(U), KEPT, "ac1-1: both flags on, unverified owner text → «Gården ligger i Hurdal.»");
    assertEq(infoAbout(U, { ownerView: true }), OWNER_TEXT, "ac1-2: ownerView → unchanged");
    assertEq(infoAbout(V), OWNER_TEXT, "ac1-3: verified (Debio) → unchanged");
    assertEq(infoAbout(N), OWNER_TEXT, "ac1-4: non-owner about → unchanged");
    assertEq(knowledgeService.getAgentInfo(V, { debioSwitchOff: true })?.knowledge.about, KEPT, "ac1-5: debioSwitchOff (no valid status shown) → filtered as unverified");
    for (const [c, o] of [[false, false], [true, false], [false, true]] as const) {
      flags(c, o);
      assertEq(infoAbout(U), OWNER_TEXT, `ac1-off: claim=${c} owner=${o} → unchanged`);
    }
    flags(false, false);
    const offInfo = JSON.stringify(knowledgeService.getAgentInfo(U));
    flags(true, true);
    const onInfo = knowledgeService.getAgentInfo(U)!;
    assertEq(JSON.stringify({ ...onInfo, knowledge: { ...onInfo.knowledge, about: OWNER_TEXT } }), offInfo, "ac1-6: only knowledge.about differs between flags on and off");
    assertEq(aboutOf(U), OWNER_TEXT, "ac1-7: stored text unchanged");
    seed(U, { verified: false, about: ALL_ORGANIC, ownerAbout: true });
    assertEq(infoAbout(U), "", "ac1-8: every sentence organic → \"\"");
    seed(U, { verified: false, about: OWNER_TEXT, ownerAbout: true });

    // ═══ AC2: REST GET /agents/:id/info + MCP lokal_info ═══════════════════
    const marketplaceRouter = (require("./marketplace") as any).default;
    const infoRoute = findHandler(marketplaceRouter, "/agents/:id/info", "get");
    const restAbout = async (id: string) => {
      clearRegistryCaches();
      const r = await invoke(infoRoute, makeReq({ params: { id } }));
      return { status: r.status, about: r.body?.data?.knowledge?.about };
    };
    const tools = new Map<string, (args: any, extra?: any) => Promise<any>>();
    const { registerTools } = require("./mcp") as typeof import("./mcp");
    registerTools({
      registerTool(name: string, _config: any, handler: any) { tools.set(name, handler); },
      resource() { /* no-op */ },
      prompt() { /* no-op */ },
      registerResource() { /* no-op */ },
      registerPrompt() { /* no-op */ },
    } as any, () => "test-client", () => undefined);
    const lokalInfo = async (id: string) => {
      clearRegistryCaches();
      return String((await tools.get("lokal_info")!({ agentId: id }, {}))?.content?.[0]?.text ?? "");
    };

    flags(false, false);
    assertEq(await restAbout(U), { status: 200, about: OWNER_TEXT }, "ac2-rest-off: flags off → GET /agents/:id/info about unchanged");
    let mcpText = await lokalInfo(U);
    assertTrue(mcpText.includes(OWNER_TEXT), "ac2-mcp-off: flags off → lokal_info shows the full owner text", mcpText.slice(0, 300));
    flags(true, true);
    assertEq(await restAbout(U), { status: 200, about: KEPT }, "ac2-rest-on: flags on → GET /agents/:id/info about filtered");
    mcpText = await lokalInfo(U);
    assertTrue(mcpText.includes(KEPT) && !mcpText.includes("økologisk lammekjøtt"), "ac2-mcp-on: flags on → lokal_info without the organic sentence", mcpText.slice(0, 300));
    assertEq(await restAbout(V), { status: 200, about: OWNER_TEXT }, "ac2-rest-ver: verified → unchanged");
    assertTrue((await lokalInfo(V)).includes(OWNER_TEXT), "ac2-mcp-ver: verified → lokal_info unchanged");
    assertEq(await restAbout(N), { status: 200, about: OWNER_TEXT }, "ac2-rest-non: non-owner about → unchanged");
    assertTrue((await lokalInfo(N)).includes(OWNER_TEXT), "ac2-mcp-non: non-owner about → lokal_info unchanged");

    // ═══ A2A /agents/:id/agent.json (x-knowledge.about, reads getKnowledge) ═
    // The route reads the legacy seed store (services/store.ts) for the card
    // itself; the fixtures are added there and removed in finally.
    const now = new Date().toISOString();
    for (const id of [U, V, N]) {
      store.addProducer({
        id, name: NAMES[id], description: "", type: "farm",
        location: { lat: 60.43, lng: 11.06, city: "Hurdal" },
        openingHours: [], tags: [], certifications: [], deliveryOptions: ["pickup"],
        trustScore: 0.5, totalTransactions: 0, availabilityAccuracy: 0.5,
        registeredAt: now, lastActiveAt: now, isActive: true,
      } as any);
    }
    const a2aRouter = (require("./a2a") as any).default;
    const agentJson = findHandler(a2aRouter, "/agents/:id/agent.json", "get");
    const xAbout = async (id: string) => {
      clearRegistryCaches();
      const r = await invoke(agentJson, makeReq({ params: { id } }));
      return { status: r.status, about: r.body?.["x-knowledge"]?.about };
    };
    flags(false, false);
    assertEq(await xAbout(U), { status: 200, about: OWNER_TEXT }, "a2a-off: flags off → x-knowledge.about unchanged");
    flags(true, true);
    assertEq(await xAbout(U), { status: 200, about: KEPT }, "a2a-on: flags on → x-knowledge.about filtered");
    assertEq(await xAbout(V), { status: 200, about: OWNER_TEXT }, "a2a-ver: verified → unchanged");
    assertEq(await xAbout(N), { status: 200, about: OWNER_TEXT }, "a2a-non: non-owner → unchanged");

    // ═══ /llms-full.txt (reads getKnowledge) ═══════════════════════════════
    const discoveryRouter = (require("./discovery") as any).default;
    const llmsFull = findHandler(discoveryRouter, "/llms-full.txt", "get");
    const llmsLine = async (id: string) => {
      clearRegistryCaches();
      const r = await invoke(llmsFull, makeReq({}));
      return String(r.body ?? "").split("\n").find((l) => l.includes(`**${NAMES[id]}**`)) ?? "";
    };
    flags(false, false);
    const offLine = await llmsLine(U);
    assertTrue(offLine.endsWith(` | ${OWNER_TEXT}`), "llms-off: flags off → full owner text", offLine);
    flags(true, true);
    const onLine = await llmsLine(U);
    assertEq(onLine, offLine.replace(OWNER_TEXT, KEPT), "llms-on: flags on → only the organic sentence gone");
    assertTrue((await llmsLine(V)).endsWith(` | ${OWNER_TEXT}`) && (await llmsLine(N)).endsWith(` | ${OWNER_TEXT}`), "llms-ver-non: verified / non-owner → unchanged");
    seed(U, { verified: false, about: ALL_ORGANIC, ownerAbout: true });
    const emptyLine = await llmsLine(U);
    assertTrue(!emptyLine.endsWith(" | ") && !emptyLine.includes("økologisk") && emptyLine.startsWith(`- **${NAMES[U]}**`), "llms-empty: every sentence dropped → no about part, no trailing separator", emptyLine);
    seed(U, { verified: false, about: OWNER_TEXT, ownerAbout: true });

    // ═══ SEO helpers: published translations + related-producer preview ════
    const seo = require("./seo") as typeof import("./seo");
    const { ensureProfileTranslationsSchema } = require("../services/profile-translations") as typeof import("../services/profile-translations");
    ensureProfileTranslationsSchema(db);
    const addTranslation = (id: string, text: string) => {
      db.prepare(
        `INSERT OR REPLACE INTO profile_translations (platform, entity_type, entity_id, entity_name, field, lang, source_text, source_hash, translated_text, status, published_at)
         VALUES ('rfb', 'agent', ?, ?, 'about', 'en', ?, 'h', ?, 'published', datetime('now'))`,
      ).run(id, NAMES[id], OWNER_TEXT, text);
    };
    setEnv("PROFILE_TRANSLATIONS_SERVE_ENABLED", "true");
    for (const id of [U, V, N]) addTranslation(id, EN_TEXT);
    const translated = (id: string, nbAbout: string) => {
      const k = new Map<string, { about?: string | null }>([[id, { about: nbAbout }]]);
      const rows = [{ id, description: "", about: nbAbout }];
      seo.applyPublishedTranslations(rows, "en", k);
      return [rows[0].about, k.get(id)!.about];
    };
    flags(false, false);
    assertEq(translated(U, OWNER_TEXT), [EN_TEXT, EN_TEXT], "seo-tr-off: flags off → translation applied unchanged");
    flags(true, true);
    assertEq(translated(U, KEPT), [EN_KEPT, EN_KEPT], "seo-tr-on: flags on → translated owner about filtered (featured cards)");
    assertEq(translated(V, OWNER_TEXT), [EN_TEXT, EN_TEXT], "seo-tr-ver: verified → unchanged");
    assertEq(translated(N, OWNER_TEXT), [EN_TEXT, EN_TEXT], "seo-tr-non: non-owner → unchanged");
    addTranslation(U, "We sell organic lamb only.");
    assertEq(translated(U, KEPT), [KEPT, KEPT], "seo-tr-empty: translation fully dropped → the (filtered) Norwegian text stays");

    const relatedRow = (id: string, about: string) => ({ id, name: NAMES[id], city: "Hurdal", description: "", about } as any);
    flags(false, false);
    const relOff = seo.renderRelatedSection([relatedRow(U, OWNER_TEXT)], "Andre i Hurdal");
    assertTrue(relOff.includes("økologisk lammekjøtt"), "seo-rel-off: flags off → preview unchanged", relOff);
    flags(true, true);
    const relOn = seo.renderRelatedSection([relatedRow(U, OWNER_TEXT)], "Andre i Hurdal");
    assertTrue(!relOn.includes("økologisk") && relOn.includes("Gården ligger i Hurdal"), "seo-rel-on: flags on → preview without the organic sentence", relOn);
    assertEq(relOn.replace("Gården ligger i Hurdal.", "X"), relOff.replace("Vi selger økologisk lammekjøtt. Gården ligger i Hurdal.", "X"), "seo-rel-on-2: only the preview text differs");
    assertTrue(seo.renderRelatedSection([relatedRow(V, OWNER_TEXT)], "Andre").includes("økologisk lammekjøtt"), "seo-rel-ver: verified → unchanged");

    assertEq([aboutOf(U), aboutOf(V), aboutOf(N)], [OWNER_TEXT, OWNER_TEXT, OWNER_TEXT], "stored-1: no read wrote anything");
  } catch (err: any) {
    failed++;
    failures.push(`✗ unexpected error: ${err?.stack || err?.message || String(err)}`);
  } finally {
    console.log = prevLog;
    console.warn = prevWarn;
    for (const k of ENV_KEYS) setEnv(k, prevEnv[k] ?? null);
    if (prevDb) initMod.__setDbForTesting(prevDb);
    try {
      const { marketplaceRegistry } = require("../services/marketplace-registry") as typeof import("../services/marketplace-registry");
      (marketplaceRegistry as any)._agentsCache = null;
      (marketplaceRegistry as any)._statsCache = null;
    } catch { /* ignore */ }
    for (const id of [U, V, N]) (store as any).producers.delete(id);
    try { db.close(); } catch { /* ignore */ }
  }

  return { passed, failed, failures };
}

if (require.main === module) {
  runOrganicOwnerGateS3c2Tests({ log: true }).then((r) => {
    console.log(`\norganic-owner-gate-s3c2: ${r.passed} passed, ${r.failed} failed`);
    for (const f of r.failures) console.log(f);
    process.exit(r.failed > 0 ? 1 : 0);
  });
}
