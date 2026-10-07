/**
 * opplevelser-experience-description-write.test.ts — tests for dev-request
 * 2026-10-07-experiences-beskrivelser-via-claude-code-uten-api: descriptions
 * are written by a Claude Code client (Daniel's Max subscription) and this
 * server NEVER calls an LLM in the flow. Two routes:
 *
 *   GET  /api/opplevelser/admin/experiences-description-candidates
 *        — the 4c candidate queue (shared selectExperienceDescriptionQueue())
 *          plus facts block, fingerprint, tier bounds, prompts and `rules`.
 *   POST /api/opplevelser/admin/experiences-description-write
 *        — stores pre-written text through the same deterministic gates 4c
 *          applies to its own generator output, or records a client `skip`
 *          as an attempt row (cooldown).
 *
 * Sections:
 *   P — pure helpers (shape gate, number gate, skip-attempt mapping, the
 *       generated-provenance predicate, homepage-sourced parity of the new
 *       sentinel).
 *   R — the routes, on a FRESH in-memory experiences DB with fixed ids
 *       ("cw-…") so ORDER BY e.id is deterministic.
 *
 * NO LLM, EVER: globalThis.fetch AND the homepage-fetch seam are wrapped in
 * a guard that counts (and fails) any request to api.anthropic.com; the
 * suite asserts that count is 0 after exercising every path. An
 * ANTHROPIC_API_KEY is set throughout so a stray LLM call would not be
 * short-circuited by the missing-key branch and hide itself.
 *
 * Setup convention mirrors opplevelser-experience-description-enrichment.
 * test.ts section D/F: EXPERIENCES_DB_PATH=":memory:", a fresh require of
 * db-factory + experience-store + the opplevelser router, the main db pinned
 * in-memory (write-pause lookups), the router driven via router.handle().
 */

import {
  checkPrewrittenExperienceDescriptionShape,
  prewrittenDescriptionHasUngroundedNumbers,
  experienceDescriptionSkipAttempt,
  isExperienceDescriptionGeneratedProvenance,
  experienceDescriptionFactsFingerprint,
  experienceDescriptionAttemptCooldownDays,
  buildExperienceDescriptionFaktalinjePrompt,
  expDescWordCount,
  EXP_DESC_GENERATED_PROVENANCE_SENTINEL,
  EXP_DESC_CLAUDE_CODE_PROVENANCE_SENTINEL,
  EXP_DESC_WRITE_SKIP_REASONS,
} from "./opplevelser";
import { isContentFieldHomepageSourced } from "../services/experience-store";

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
  appSettings: Record<string, unknown>,
  opts: { method: "GET" | "POST"; url: string; headers?: Record<string, string>; body?: any; query?: Record<string, string> },
): Promise<RouteResult> {
  return new Promise((resolve) => {
    const req: any = {
      method: opts.method,
      url: opts.url,
      originalUrl: opts.url,
      path: opts.url,
      query: opts.query || {},
      headers: opts.headers || {},
      body: opts.body,
      app: { get: (k: string) => appSettings[k] },
      get() { return undefined; },
    };
    const res: any = {
      statusCode: 200,
      status(code: number) { this.statusCode = code; return this; },
      json(payload: any) { resolve({ status: this.statusCode, body: payload }); return this; },
    };
    router.handle(req, res, (err?: any) => {
      if (err) resolve({ status: 500, body: { error: String(err) } });
      else resolve({ status: 404, body: { error: "unhandled" } });
    });
  });
}

// ── Fixtures ──────────────────────────────────────────────────────────────
const FAKTALINJE_TEXT =
  "Denne opplevelsen byr på en aktiv dag ute i naturen sammen med en lokal tilbyder som legger vekt på trygghet og godt følge.";
const FAKTALINJE_TOO_LONG = `${FAKTALINJE_TEXT} ${FAKTALINJE_TEXT}`;
const KT_SENTENCE =
  "Vi tilbyr en kajakktur i rolig sjø for både nybegynnere og erfarne padlere, og turen starter ved brygga rett ved sjøen der guiden ønsker alle velkommen.";
function repeatTo(sentence: string, minWords: number): string {
  const parts: string[] = [];
  while (expDescWordCount(parts.join(" ")) < minWords) parts.push(sentence);
  return parts.join(" ");
}
const KILDETRO_TEXT = repeatTo(KT_SENTENCE, 70);
const KILDETRO_OFF_TOPIC = repeatTo(
  "Vi er en lokal bedrift som har drevet med opplevelser i mange år, og vi legger stor vekt på kvalitet, trygghet og godt vertskap for alle våre gjester.",
  70,
);
// "1500" appears on the homepage (below), never in the facts.
const KILDETRO_HOMEPAGE_NUMBER = `${KILDETRO_TEXT} Prisen er 1500 kroner ifølge nettsiden.`;
const KILDETRO_INVENTED_NUMBER = `${KILDETRO_TEXT} Turen tar 777 minutter.`;
const HOMEPAGE_HTML =
  "<html><body><p>Vi tilbyr kajakktur i fjorden for hele familien. Prisen er 1500 kroner. Kontakt oss for mer informasjon.</p></body></html>";
const GOOD_DESCRIPTION =
  "Bli med på en rolig padletur i skjermede farvann sammen med lokale guider. Turen passer for både nybegynnere og erfarne, og vi holder til rett ved sjøen.";
const JUNK_DESCRIPTION =
  "Skip to content Homme 8, 4715 Øvrebø 41360545 john@hommegaard.no Facebook-f Instagram Forside Gårdsutsalg Produksjon Meny";

function verifiedFieldProvenance(): string {
  return JSON.stringify({ hjemmeside_verification: { verified: true, classification: "verified" } });
}

export function runOpplevelserExperienceDescriptionWriteTests(
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
    const prevAnthropicKey = process.env.ANTHROPIC_API_KEY;
    const prevFetch = globalThis.fetch;
    const prevExperiencesDbPath = process.env.EXPERIENCES_DB_PATH;
    const prevAdminKey = process.env.ADMIN_KEY;

    // ═══════════════════════════════════════════════════════════════════
    // Section P — pure helpers
    // ═══════════════════════════════════════════════════════════════════
    try {
      const T = "Kajakktur i fjorden";
      assertEq(checkPrewrittenExperienceDescriptionShape(FAKTALINJE_TEXT, "faktalinje", T), null, "p1a: a good faktalinje passes the shape gate");
      assertEq(checkPrewrittenExperienceDescriptionShape("   ", "faktalinje", T), "empty_description", "p1b: blank -> empty_description");
      assertEq(checkPrewrittenExperienceDescriptionShape("UTILSTREKKELIG_GRUNNLAG", "faktalinje", T), "sentinel", "p1c: bare sentinel -> sentinel");
      assertEq(checkPrewrittenExperienceDescriptionShape(`${FAKTALINJE_TEXT} UTILSTREKKELIG_GRUNNLAG`, "faktalinje", T), "sentinel", "p1d: smuggled sentinel -> sentinel");
      assertEq(checkPrewrittenExperienceDescriptionShape(FAKTALINJE_TOO_LONG, "faktalinje", T), "above_word_ceiling", "p1e: >40 words faktalinje -> above_word_ceiling");
      assertEq(checkPrewrittenExperienceDescriptionShape(FAKTALINJE_TEXT, "kildetro", T), "below_word_floor", "p1f: <60 words kildetro -> below_word_floor");
      assertEq(checkPrewrittenExperienceDescriptionShape(repeatTo(KT_SENTENCE, 160), "kildetro", T), "above_word_ceiling", "p1g: >150 words kildetro -> above_word_ceiling");
      assertEq(checkPrewrittenExperienceDescriptionShape(KILDETRO_TEXT, "kildetro", T), null, "p1h: on-topic kildetro passes");
      assertEq(checkPrewrittenExperienceDescriptionShape(KILDETRO_OFF_TOPIC, "kildetro", T), "no_title_node", "p1i: off-topic kildetro -> no_title_node");
      assertEq(checkPrewrittenExperienceDescriptionShape(KILDETRO_OFF_TOPIC.slice(0, 200), "faktalinje", T), null, "p1j: faktalinje has no title-token rule");
      const longWords = Array.from({ length: 80 }, () => "kajakktur" + "x".repeat(150)).join(" ");
      assertEq(checkPrewrittenExperienceDescriptionShape(longWords, "kildetro", T), "char_cap_exceeded", "p1k: >12000 chars -> char_cap_exceeded");

      const facts = "Tittel: X\nPris: fra 890 kroner per person";
      assertEq(prewrittenDescriptionHasUngroundedNumbers("Fra 890 kroner.", "faktalinje", facts, null), false, "p2a: a facts number is grounded");
      assertEq(prewrittenDescriptionHasUngroundedNumbers("Fra 1500 kroner.", "faktalinje", facts, "1500"), true, "p2b: faktalinje ignores homepage text");
      assertEq(prewrittenDescriptionHasUngroundedNumbers("Fra 1500 kroner.", "kildetro", facts, "Prisen er 1 500 kroner"), false, "p2c: kildetro accepts a homepage number (separator-normalised)");
      assertEq(prewrittenDescriptionHasUngroundedNumbers("Fra 890 kroner.", "kildetro", facts, "ingen tall"), false, "p2d: kildetro accepts a facts number");
      assertEq(prewrittenDescriptionHasUngroundedNumbers("Tar 777 minutter.", "kildetro", facts, "ingen tall"), true, "p2e: kildetro rejects a number in neither");

      assertEq(experienceDescriptionSkipAttempt("faktalinje", "sentinel"), { outcome: "generation_failed", reason: "faktalinje:sentinel" }, "p3a: sentinel -> generation_failed, <level>:<reason>");
      assertEq(experienceDescriptionSkipAttempt("kildetro", "judge_rejected"), { outcome: "judge_rejected", reason: "kildetro:judge_rejected" }, "p3b: judge_rejected outcome");
      assertEq(experienceDescriptionSkipAttempt("faktalinje", "thin_data"), { outcome: "thin_data", reason: "faktalinje:thin_data" }, "p3c: thin_data outcome");
      {
        const a = experienceDescriptionSkipAttempt("kildetro", "fetch_failed");
        assertEq(experienceDescriptionAttemptCooldownDays(a.outcome, a.reason), 7, "p3d: client kildetro fetch_failed gets the 7-day window");
        const b = experienceDescriptionSkipAttempt("faktalinje", "sentinel");
        assertEq(experienceDescriptionAttemptCooldownDays(b.outcome, b.reason), 30, "p3e: client sentinel gets 30 days");
      }
      assertTrue(!(EXP_DESC_WRITE_SKIP_REASONS as readonly string[]).includes("http_error"), "p3f: infra reasons are not reportable skip reasons");

      assertEq(EXP_DESC_CLAUDE_CODE_PROVENANCE_SENTINEL, "generated:claude-code", "p4a: the new sentinel value");
      assertTrue(isExperienceDescriptionGeneratedProvenance(EXP_DESC_GENERATED_PROVENANCE_SENTINEL), "p4b: old sentinel is generated provenance");
      assertTrue(isExperienceDescriptionGeneratedProvenance(EXP_DESC_CLAUDE_CODE_PROVENANCE_SENTINEL), "p4c: new sentinel is generated provenance");
      assertTrue(!isExperienceDescriptionGeneratedProvenance("https://example.no"), "p4d: a URL is not");
      for (const sentinel of [EXP_DESC_GENERATED_PROVENANCE_SENTINEL, EXP_DESC_CLAUDE_CODE_PROVENANCE_SENTINEL]) {
        assertEq(isContentFieldHomepageSourced("tekst", "description", { description: sentinel }, "example.no"), false,
          `p4e: isContentFieldHomepageSourced treats ${sentinel} as NOT homepage-sourced`);
      }
    } catch (err: any) {
      failed++;
      failures.push("experience-description-write (section P): unexpected error: " + String(err?.stack || err?.message || err));
    }

    // ═══════════════════════════════════════════════════════════════════
    // Section R — the routes
    // ═══════════════════════════════════════════════════════════════════
    const ADMIN_KEY_CW = process.env.ADMIN_KEY || "experience-description-write-test-key";
    process.env.EXPERIENCES_DB_PATH = ":memory:";
    process.env.ADMIN_KEY = ADMIN_KEY_CW;
    process.env.ANTHROPIC_API_KEY = "test-anthropic-key-must-never-be-used";
    const dbFactoryPath = require.resolve("../database/db-factory");
    const experienceStorePath = require.resolve("../services/experience-store");
    const opplevelserPath = require.resolve("./opplevelser");
    for (const p of [dbFactoryPath, experienceStorePath, opplevelserPath]) delete require.cache[p];
    let restoreMainDb: (() => void) | null = null;

    // ── The no-LLM guard: any request to api.anthropic.com, through either
    //    global fetch or the homepage seam, is counted and fails. ─────────
    let llmCalls = 0;
    let homepageCalls = 0;
    const isLlmUrl = (url: unknown) => String(url).includes("api.anthropic.com");
    globalThis.fetch = (async (url: any) => {
      if (isLlmUrl(url)) llmCalls++;
      throw new Error(`global fetch must not be called (${String(url)})`);
    }) as typeof fetch;
    function homepageStub(mode: "ok" | "fail"): typeof fetch {
      return (async (url: any) => {
        if (isLlmUrl(url)) { llmCalls++; throw new Error("LLM call through the homepage seam"); }
        homepageCalls++;
        let u: URL;
        try { u = new URL(String(url)); } catch {
          return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0), headers: { get: () => null } } as unknown as Response;
        }
        if (mode === "ok" && (u.pathname === "/" || u.pathname === "")) {
          const bytes = new TextEncoder().encode(HOMEPAGE_HTML);
          return {
            ok: true, status: 200, arrayBuffer: async () => bytes.buffer,
            headers: { get: (h: string) => (h.toLowerCase() === "content-type" ? "text/html; charset=utf-8" : null) },
            url: String(url),
          } as unknown as Response;
        }
        return { ok: false, status: mode === "fail" ? 500 : 404, arrayBuffer: async () => new ArrayBuffer(0), headers: { get: () => null } } as unknown as Response;
      }) as unknown as typeof fetch;
    }

    try {
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const expDb = dbFactory.getDb("experiences");
      const expStore = require("../services/experience-store") as typeof import("../services/experience-store");
      const init = require("../database/init") as typeof import("../database/init");
      restoreMainDb = init.__pinInMemoryDbForTesting();
      const pauseSvc = require("../services/enrichment-write-pause") as typeof import("../services/enrichment-write-pause");
      const router = (require("./opplevelser") as typeof import("./opplevelser")).default as any;

      const appSettings: Record<string, unknown> = {};
      appSettings["experienceDescriptionHomepageFetchImpl"] = homepageStub("ok");
      // The 4c LLM seam is also guarded: the parity calls below use
      // preview_only (zero LLM by contract), so this must never fire.
      appSettings["experienceDescriptionFetchImpl"] = (async (url: any) => {
        if (isLlmUrl(url)) llmCalls++;
        throw new Error("4c LLM seam must not be called in this suite");
      }) as unknown as typeof fetch;
      const auth = { "x-admin-key": ADMIN_KEY_CW };
      const getCandidates = (query: Record<string, string> = {}) => {
        process.env.ADMIN_KEY = ADMIN_KEY_CW;
        return callRoute(router, appSettings, { method: "GET", url: "/admin/experiences-description-candidates", headers: auth, query });
      };
      const write = (body: any) => {
        process.env.ADMIN_KEY = ADMIN_KEY_CW;
        return callRoute(router, appSettings, { method: "POST", url: "/admin/experiences-description-write", headers: auth, body });
      };
      const enrichPreview = (body: any = {}) => {
        process.env.ADMIN_KEY = ADMIN_KEY_CW;
        return callRoute(router, appSettings, { method: "POST", url: "/admin/experiences-description-enrichment", headers: auth, body: { preview_only: true, ...body } });
      };
      const dumpAll = (): string =>
        JSON.stringify(expDb.prepare("SELECT id, description, content_field_evidence, content_source, updated_at FROM experiences ORDER BY id").all());
      const dumpAttempts = (): string =>
        JSON.stringify(expDb.prepare("SELECT * FROM experience_description_attempts ORDER BY experience_id").all());
      const rowOf = (id: string): any =>
        expDb.prepare("SELECT id, slug, description, content_field_evidence, content_source FROM experiences WHERE id = ?").get(id);
      const attemptOf = (id: string): any =>
        expDb.prepare("SELECT * FROM experience_description_attempts WHERE experience_id = ?").get(id);

      // ── Seed ────────────────────────────────────────────────────────
      const providerF = expStore.createProvider({
        navn: "Faktatur AS", kommune: "Bergen", fylke: "Vestland",
        brreg_verified: 1, brreg_active: 1, verification_status: "verified",
      });
      const providerK = expStore.createProvider({
        navn: "Kildetur AS", kommune: "Bergen", fylke: "Vestland",
        brreg_verified: 1, brreg_active: 1, verification_status: "verified",
      });
      expDb.prepare("UPDATE experience_providers SET hjemmeside = ?, field_provenance = ? WHERE id = ?")
        .run("kildetur.example", verifiedFieldProvenance(), providerK);
      const seed = (id: string, over: Record<string, unknown> = {}): string =>
        expStore.createExperience({
          id, title: "Kajakktur i fjorden", provider_id: providerF, kommune: "Bergen", fylke: "Vestland",
          category: "natur_friluft", subcategory: "kajakk", season: ["summer"],
          indoor_outdoor: "outdoor", duration_min: 120, duration_max: 180,
          group_min: 2, group_max: 8, price_band: "standard", price_from: 890,
          price_unit: "per_person", languages: ["norsk", "engelsk"],
          accessibility: ["rullestolvennlig"], meeting_point: "Bryggen",
          booking_url: "https://example.no/book",
          verification_status: "verified", confidence: "high",
          slug: `slug-${id}`,
          ...over,
        } as any);
      const fpOf = (id: string): string => {
        const r = expDb.prepare(
          `SELECT e.*, p.navn AS provider_navn, p.brreg_verified AS provider_brreg_verified,
                  p.field_provenance AS provider_field_provenance, p.hjemmeside AS provider_hjemmeside
             FROM experiences e LEFT JOIN experience_providers p ON p.id = e.provider_id WHERE e.id = ?`,
        ).get(id) as any;
        return experienceDescriptionFactsFingerprint(r);
      };

      const idF1 = seed("cw-f1");
      const idF2 = seed("cw-f2");
      const idF3 = seed("cw-f3");
      const idF4 = seed("cw-f4");
      const idJunk = seed("cw-f5-junk", { description: JUNK_DESCRIPTION });
      const idK1 = seed("cw-k1", { provider_id: providerK });
      const idK2 = seed("cw-k2", { provider_id: providerK });
      const idK3 = seed("cw-k3", { provider_id: providerK });
      const idGood = seed("cw-good", { description: GOOD_DESCRIPTION });
      const idManual = seed("cw-manual", { content_source: "manual" });
      const idUnpub = seed("cw-unpub");
      expDb.prepare("UPDATE experiences SET verification_status = 'needs_review' WHERE id = ?").run(idUnpub);
      const idThin = expStore.createExperience({
        id: "cw-thin", title: "Tynn", kommune: "Oslo", fylke: "Oslo", category: "kultur_historie",
        verification_status: "verified", confidence: "high", slug: "slug-cw-thin",
      } as any);
      // Upgrade candidate: an EXISTING Claude Code faktalinje whose provider
      // has a verified homepage -> auto-supersede must treat the NEW
      // sentinel exactly like the old one.
      const idUp = seed("cw-a-up", { provider_id: providerK, description: FAKTALINJE_TEXT });
      expDb.prepare("UPDATE experiences SET content_field_evidence = ? WHERE id = ?")
        .run(JSON.stringify({ description: EXP_DESC_CLAUDE_CODE_PROVENANCE_SENTINEL }), idUp);

      // ── cw-r1: GET shape. ────────────────────────────────────────────
      {
        const r = await getCandidates();
        assertEq(r.status, 200, "cw-r1a: 200");
        assertEq(r.body.limit, 20, "cw-r1b: default limit 20");
        for (const k of ["candidates", "candidates_before_cooldown", "skipped_recently_attempted", "skipped_thin_data_precheck"]) {
          assertTrue(typeof r.body[k] === "number", `cw-r1c: count ${k} present`);
        }
        assertEq(r.body.skipped_thin_data_precheck, 1, "cw-r1d: the thin row is dropped by the precheck");
        const ids = (r.body.items as any[]).map((i) => i.id);
        assertTrue(!ids.includes(idThin) && !ids.includes(idGood) && !ids.includes(idManual) && !ids.includes(idUnpub),
          "cw-r1e: thin/good/manual/unpublished rows are not candidates");
        assertEq(ids[ids.length - 1], idUp, "cw-r1f: worst-first — the upgrade row (lowest id) comes last");
        const f1 = (r.body.items as any[]).find((i) => i.id === idF1);
        assertEq(f1.level, "faktalinje", "cw-r1g: faktalinje level");
        assertEq(f1.homepage_url, null, "cw-r1h: no homepage_url for faktalinje");
        assertEq(f1.provider_navn, "Faktatur AS", "cw-r1i: provider_navn");
        assertEq([f1.word_min, f1.word_max, f1.char_max], [1, 40, 12000], "cw-r1j: faktalinje bounds");
        assertEq(f1.facts_fingerprint, fpOf(idF1), "cw-r1k: facts_fingerprint = experienceDescriptionFactsFingerprint(row)");
        assertEq(f1.generator_prompt, buildExperienceDescriptionFaktalinjePrompt(f1.facts_block),
          "cw-r1l: generator_prompt is exactly the in-server faktalinje prompt for this facts block");
        assertTrue(f1.facts_block.startsWith("Tittel: Kajakktur i fjorden\n") && f1.facts_block.includes("Pris: fra 890 kroner per person"),
          "cw-r1m: facts_block is the rendered facts text");
        const k1 = (r.body.items as any[]).find((i) => i.id === idK1);
        assertEq(k1.level, "kildetro", "cw-r1n: kildetro level");
        assertEq(k1.homepage_url, "https://kildetur.example", "cw-r1o: homepage_url is the URL the kildetro path fetches");
        assertEq([k1.word_min, k1.word_max, k1.char_max], [60, 150, 12000], "cw-r1p: kildetro bounds");
        assertTrue(k1.generator_prompt.includes(r.body.rules.placeholders.homepage_text), "cw-r1q: kildetro prompt carries the homepage placeholder");
        assertTrue(k1.judge_prompt.includes(r.body.rules.placeholders.judge_candidate), "cw-r1r: judge prompt carries the candidate placeholder");
        assertEq(r.body.rules.sentinel, "UTILSTREKKELIG_GRUNNLAG", "cw-r1s: rules.sentinel");
        assertEq(r.body.rules.judge_tokens, { approve: "GODKJENN", reject: "AVVIS" }, "cw-r1t: rules.judge_tokens");
        assertEq(r.body.rules.max_items_per_write, 25, "cw-r1u: rules.max_items_per_write");
        assertEq(r.body.rules.levels.kildetro.title_token_required, true, "cw-r1v: rules.levels.kildetro.title_token_required");
      }

      // ── cw-r2: limit clamp. ──────────────────────────────────────────
      assertEq((await getCandidates({ limit: "0" })).body.limit, 1, "cw-r2a: limit=0 -> 1");
      assertEq((await getCandidates({ limit: "-5" })).body.limit, 1, "cw-r2b: limit=-5 -> 1");
      assertEq((await getCandidates({ limit: "999" })).body.limit, 50, "cw-r2c: limit=999 -> 50");
      assertEq((await getCandidates({ limit: "abc" })).body.limit, 20, "cw-r2d: limit=abc -> default 20");
      {
        const r = await getCandidates({ limit: "2" });
        assertEq(r.body.returned, 2, "cw-r2e: limit=2 returns 2");
        assertEq(r.body.items.length, 2, "cw-r2f: items length 2");
      }

      // ── cw-r3: selection parity with the 4c route. ───────────────────
      async function assertParity(label: string): Promise<void> {
        const g = await getCandidates({ limit: "50" });
        const p = await enrichPreview();
        assertEq((g.body.items as any[]).map((i) => i.id).slice(0, 20), p.body.candidate_ids_preview, `${label}: same ids, same order`);
        for (const k of ["candidates", "candidates_before_cooldown", "skipped_recently_attempted", "skipped_thin_data_precheck"]) {
          assertEq(g.body[k], p.body[k], `${label}: ${k} equal`);
        }
      }
      await assertParity("cw-r3a");

      // ── cw-r4: structural 400s. ──────────────────────────────────────
      const skipItem = (id: string, reason = "sentinel") => ({ id, facts_fingerprint: fpOf(id), outcome: "skip", reason });
      for (const [label, body] of [
        ["cw-r4a: no items", { dry_run: true }],
        ["cw-r4b: empty items", { items: [] }],
        ["cw-r4c: items not an array", { items: "x" }],
        ["cw-r4d: >25 items", { items: Array.from({ length: 26 }, (_, i) => ({ id: `n-${i}`, facts_fingerprint: "x", outcome: "skip", reason: "sentinel" })) }],
        ["cw-r4e: duplicate ids", { items: [skipItem(idF1), skipItem(idF1)] }],
        ["cw-r4f: unknown outcome", { items: [{ id: idF1, facts_fingerprint: "x", outcome: "maybe" }] }],
        ["cw-r4g: skip reason outside the fixed set", { items: [{ id: idF1, facts_fingerprint: "x", outcome: "skip", reason: "http_error" }] }],
        ["cw-r4h: write without judge", { items: [{ id: idF1, facts_fingerprint: "x", outcome: "write", level: "faktalinje", description: "x" }] }],
        ["cw-r4i: write with bad level", { items: [{ id: idF1, facts_fingerprint: "x", outcome: "write", level: "skip", description: "x", judge: { approved: true } }] }],
        ["cw-r4j: missing id", { items: [{ facts_fingerprint: "x", outcome: "skip", reason: "sentinel" }] }],
      ] as Array<[string, any]>) {
        const before = dumpAll() + dumpAttempts();
        const r = await write({ ...body, dry_run: false });
        assertEq(r.status, 400, `${label} -> 400`);
        assertEq(dumpAll() + dumpAttempts(), before, `${label} -> nothing written`);
      }
      {
        const r = await write({ dry_run: false, items: Array.from({ length: 25 }, (_, i) => ({ id: `n-${i}`, facts_fingerprint: "x", outcome: "skip", reason: "sentinel" })) });
        assertEq(r.status, 200, "cw-r4k: exactly 25 items is accepted");
        assertEq(r.body.totals.rejected, 25, "cw-r4l: ...all rejected not_found");
      }

      const writeItem = (id: string, over: Record<string, unknown> = {}) => ({
        id, facts_fingerprint: fpOf(id), outcome: "write", level: "faktalinje", description: FAKTALINJE_TEXT,
        judge: { approved: true, model: "claude-opus-test", reasoning: "OK" }, ...over,
      });

      // ── cw-r5: every per-item reject reason; nothing written. ────────
      appSettings["experienceDescriptionHomepageFetchImpl"] = homepageStub("ok");
      const rejectCases: Array<[string, any, string]> = [
        ["cw-r5a", { ...writeItem(idF1), id: "cw-does-not-exist" }, "not_found"],
        ["cw-r5b", writeItem(idUnpub), "not_published"],
        ["cw-r5c", writeItem(idManual), "manual_or_claim"],
        ["cw-r5d", writeItem(idGood), "not_candidate"],
        ["cw-r5e", writeItem(idF1, { facts_fingerprint: "0".repeat(64) }), "stale_fingerprint"],
        ["cw-r5f", writeItem(idF1, { level: "kildetro", description: KILDETRO_TEXT }), "level_mismatch"],
        ["cw-r5g", writeItem(idK1), "level_mismatch"],
        ["cw-r5h", writeItem(idThin), "level_mismatch"],
        ["cw-r5i", writeItem(idF1, { judge: { approved: false, model: "m", reasoning: "AVVIS" } }), "judge_not_approved"],
        ["cw-r5j", writeItem(idF1, { judge: { approved: "true" } }), "judge_not_approved"],
        ["cw-r5k", writeItem(idF1, { description: "UTILSTREKKELIG_GRUNNLAG" }), "sentinel"],
        ["cw-r5l", writeItem(idF1, { description: `${FAKTALINJE_TEXT} UTILSTREKKELIG_GRUNNLAG` }), "sentinel"],
        ["cw-r5m", writeItem(idF1, { description: "   " }), "empty_description"],
        ["cw-r5n", writeItem(idF1, { description: FAKTALINJE_TOO_LONG }), "above_word_ceiling"],
        ["cw-r5o", writeItem(idF1, { description: "Turen koster 1500 kroner per person." }), "ungrounded_numbers"],
        ["cw-r5p", writeItem(idK1, { level: "kildetro", description: FAKTALINJE_TEXT }), "below_word_floor"],
        ["cw-r5q", writeItem(idK1, { level: "kildetro", description: repeatTo(KT_SENTENCE, 160) }), "above_word_ceiling"],
        ["cw-r5r", writeItem(idK1, { level: "kildetro", description: KILDETRO_OFF_TOPIC }), "no_title_node"],
        ["cw-r5s", writeItem(idK1, { level: "kildetro", description: KILDETRO_INVENTED_NUMBER }), "ungrounded_numbers"],
        ["cw-r5t", writeItem(idK1, { level: "kildetro", description: KILDETRO_TEXT, homepage_url: "https://annen-side.example" }), "homepage_mismatch"],
        ["cw-r5u", writeItem(idK1, { level: "kildetro", description: Array.from({ length: 80 }, () => "kajakktur" + "x".repeat(150)).join(" ") }), "char_cap_exceeded"],
      ];
      for (const [label, item, reason] of rejectCases) {
        const before = dumpAll() + dumpAttempts();
        const r = await write({ dry_run: false, items: [item] });
        assertEq(r.status, 200, `${label}: 200`);
        assertEq(r.body.results, [{ id: item.id, result: "rejected", reason }], `${label}: rejected ${reason}`);
        assertEq(r.body.totals.rejected, 1, `${label}: totals.rejected 1`);
        assertEq(dumpAll() + dumpAttempts(), before, `${label}: nothing written, no attempt recorded`);
      }
      // kildetro homepage fetch FAILS -> fetch_failed, nothing written.
      {
        appSettings["experienceDescriptionHomepageFetchImpl"] = homepageStub("fail");
        const before = dumpAll() + dumpAttempts();
        const r = await write({ dry_run: false, items: [writeItem(idK1, { level: "kildetro", description: KILDETRO_TEXT })] });
        assertEq(r.body.results, [{ id: idK1, result: "rejected", reason: "fetch_failed" }], "cw-r5v: homepage fetch failure -> fetch_failed");
        assertEq(dumpAll() + dumpAttempts(), before, "cw-r5w: nothing written on fetch_failed");
        appSettings["experienceDescriptionHomepageFetchImpl"] = homepageStub("ok");
      }

      // ── cw-r6: write-pause fence on apply only. ──────────────────────
      {
        const mainDb = init.getDb();
        pauseSvc.setEnrichmentWritePause(mainDb as any, { vertical: "experiences", enabled: true, reason: "cw test" }, "verifier");
        const before = dumpAll() + dumpAttempts();
        const apply = await write({ dry_run: false, items: [writeItem(idF1)] });
        assertEq(apply.status, 423, "cw-r6a: apply under an experiences pause -> 423");
        assertEq(dumpAll() + dumpAttempts(), before, "cw-r6b: nothing written while paused");
        const dry = await write({ items: [writeItem(idF1)] });
        assertEq(dry.status, 200, "cw-r6c: dry run is never blocked by the pause");
        assertEq(dry.body.results[0].result, "would_write", "cw-r6d: dry run still evaluates");
        pauseSvc.setEnrichmentWritePause(mainDb as any, { vertical: "experiences", enabled: false, cleared_by: "daniel" }, "verifier");
      }

      // ── cw-r7: dry run (default + non-literal-false) writes nothing and
      //    records no attempts — even for skip items and kildetro. ───────
      for (const [label, extra] of [
        ["cw-r7a: dry_run omitted", {}],
        ['cw-r7b: dry_run "false"', { dry_run: "false" }],
        ["cw-r7c: dry_run 0", { dry_run: 0 }],
      ] as Array<[string, any]>) {
        const before = dumpAll() + dumpAttempts();
        const calls0 = homepageCalls;
        const r = await write({
          ...extra,
          items: [writeItem(idF1), writeItem(idK1, { level: "kildetro", description: KILDETRO_HOMEPAGE_NUMBER }), skipItem(idF2)],
        });
        assertEq(r.body.dry_run, true, `${label}: dry_run true`);
        assertEq(r.body.results.map((x: any) => x.result), ["would_write", "would_write", "would_record_skip"], `${label}: would_write/would_record_skip`);
        assertTrue(homepageCalls > calls0, `${label}: the kildetro homepage fetch still ran in the dry run`);
        assertEq(dumpAll() + dumpAttempts(), before, `${label}: ZERO writes, ZERO attempts`);
      }

      // ── cw-r8: skip items record attempt rows; GET then excludes them. ─
      {
        const r = await write({ dry_run: false, items: [skipItem(idF2), skipItem(idK2, "fetch_failed")] });
        assertEq(r.body.results, [
          { id: idF2, result: "skipped_recorded", reason: "sentinel" },
          { id: idK2, result: "skipped_recorded", reason: "fetch_failed" },
        ], "cw-r8a: skipped_recorded");
        assertEq(r.body.totals.skipped_recorded, 2, "cw-r8b: totals.skipped_recorded");
        const a = attemptOf(idF2);
        assertEq([a?.outcome, a?.reason, a?.facts_fingerprint], ["generation_failed", "faktalinje:sentinel", fpOf(idF2)], "cw-r8c: attempt row in the 4c format");
        assertEq(attemptOf(idK2)?.reason, "kildetro:fetch_failed", "cw-r8d: kildetro skip reason");
        const g = await getCandidates({ limit: "50" });
        const ids = (g.body.items as any[]).map((i) => i.id);
        assertTrue(!ids.includes(idF2) && !ids.includes(idK2), "cw-r8e: GET excludes the recently attempted rows");
        assertEq(g.body.skipped_recently_attempted, 2, "cw-r8f: counted in skipped_recently_attempted");
        await assertParity("cw-r8g");
        // kildetro fetch_failed has the 7-day window: 8 days old -> back.
        expDb.prepare("UPDATE experience_description_attempts SET attempted_at = datetime('now', '-8 days') WHERE experience_id IN (?, ?)").run(idF2, idK2);
        const g2 = await getCandidates({ limit: "50" });
        const ids2 = (g2.body.items as any[]).map((i) => i.id);
        assertTrue(ids2.includes(idK2), "cw-r8h: kildetro fetch_failed skip is eligible again after 8 days (7-day window)");
        assertTrue(!ids2.includes(idF2), "cw-r8i: sentinel skip still rests after 8 days (30-day window)");
        // A stale skip is rejected, not recorded.
        const stale = await write({ dry_run: false, items: [{ ...skipItem(idF3), facts_fingerprint: "f".repeat(64) }] });
        assertEq(stale.body.results[0], { id: idF3, result: "rejected", reason: "stale_fingerprint" }, "cw-r8j: stale skip rejected");
        assertEq(attemptOf(idF3), undefined, "cw-r8k: no attempt row for a stale skip");
      }

      // ── cw-r9: accepted faktalinje write — new provenance, attempt row
      //    deleted, content_source untouched, description_kind faktalinje. ─
      {
        assertTrue(attemptOf(idF2) !== undefined, "cw-r9a: precondition — idF2 has an attempt row");
        const r = await write({ dry_run: false, items: [writeItem(idF2), writeItem(idJunk)] });
        assertEq(r.body.results, [{ id: idF2, result: "written" }, { id: idJunk, result: "written" }], "cw-r9b: written (blank + junk)");
        assertEq(r.body.totals.written, 2, "cw-r9c: totals.written");
        const row = rowOf(idF2);
        assertEq(row.description, FAKTALINJE_TEXT, "cw-r9d: description written (trimmed text)");
        assertEq(JSON.parse(row.content_field_evidence || "{}").description, EXP_DESC_CLAUDE_CODE_PROVENANCE_SENTINEL, "cw-r9e: provenance generated:claude-code");
        assertEq(row.content_source, null, "cw-r9f: content_source untouched for faktalinje");
        assertEq(attemptOf(idF2), undefined, "cw-r9g: attempt row deleted on the successful write");
        assertEq(rowOf(idJunk).description, FAKTALINJE_TEXT, "cw-r9h: junk description replaced");
        const hydrated = expStore.getPublishedExperienceBySlug(row.slug) as any;
        assertEq(hydrated?.description_kind, "faktalinje", "cw-r9i: description_kind = faktalinje for the new sentinel (same badge)");
        // Never overwritten again.
        const again = await write({ dry_run: false, items: [writeItem(idF2, { description: "Ny tekst om turen." })] });
        assertEq(again.body.results[0], { id: idF2, result: "rejected", reason: "not_candidate" }, "cw-r9j: a written row is never overwritten");
        assertEq(rowOf(idF2).description, FAKTALINJE_TEXT, "cw-r9k: description unchanged");
        assertEq(rowOf(idGood).description, GOOD_DESCRIPTION, "cw-r9l: the good description was never touched");
      }

      // ── cw-r10: accepted kildetro write — number grounded in the
      //    homepage only, real URL provenance, content_source stamped. ────
      {
        const r = await write({ dry_run: false, items: [writeItem(idK1, { level: "kildetro", description: KILDETRO_HOMEPAGE_NUMBER, homepage_url: "https://www.kildetur.example/" })] });
        assertEq(r.body.results, [{ id: idK1, result: "written" }], "cw-r10a: kildetro written");
        const row = rowOf(idK1);
        assertEq(row.description, KILDETRO_HOMEPAGE_NUMBER, "cw-r10b: description written");
        assertEq(JSON.parse(row.content_field_evidence || "{}").description, "https://kildetur.example", "cw-r10c: evidence = the homepage URL actually fetched");
        assertEq(row.content_source, "provider_site", "cw-r10d: content_source = provider_site");
      }

      // ── cw-r11: kildetro upgrade of a generated:claude-code faktalinje
      //    (auto-supersede treats the new sentinel like the old one). ─────
      {
        const g = await getCandidates({ limit: "50" });
        const up = (g.body.items as any[]).find((i) => i.id === idUp);
        assertEq(up?.level, "kildetro", "cw-r11a: the claude-code faktalinje row is an upgrade candidate");
        await assertParity("cw-r11b");
        const r = await write({ dry_run: false, items: [writeItem(idUp, { level: "kildetro", description: KILDETRO_TEXT })] });
        assertEq(r.body.results, [{ id: idUp, result: "written" }], "cw-r11c: upgrade written");
        assertEq(rowOf(idUp).content_source, "provider_site", "cw-r11d: upgraded to kildetro");
        const r2 = await write({ dry_run: false, items: [writeItem(idUp, { level: "kildetro", description: KILDETRO_TEXT })] });
        assertEq(r2.body.results[0].reason, "not_candidate", "cw-r11e: an already-kildetro row is never re-selected");
      }

      // ── cw-r12: mixed batch — one call, per-item outcomes. ───────────
      {
        const r = await write({ dry_run: false, items: [writeItem(idF3), writeItem(idF4, { judge: { approved: false } }), skipItem(idK3, "no_title_node")] });
        assertEq(r.body.results.map((x: any) => x.result), ["written", "rejected", "skipped_recorded"], "cw-r12a: per-item results");
        assertEq(r.body.totals, { written: 1, rejected: 1, skipped_recorded: 1, would_write: 0, would_record_skip: 0 }, "cw-r12b: totals");
        assertEq(rowOf(idF4).description, null, "cw-r12c: the rejected row is untouched");
      }

      // ── cw-r13: no LLM call anywhere in this suite. ─────────────────
      assertEq(llmCalls, 0, "cw-r13: ZERO requests to api.anthropic.com across every path above");

      dbFactory.__resetDbFactoryForTesting();
    } catch (err: any) {
      failed++;
      failures.push("experience-description-write (section R): unexpected error: " + String(err?.stack || err?.message || err));
    } finally {
      if (restoreMainDb) restoreMainDb();
      globalThis.fetch = prevFetch;
      if (prevExperiencesDbPath === undefined) delete process.env.EXPERIENCES_DB_PATH;
      else process.env.EXPERIENCES_DB_PATH = prevExperiencesDbPath;
      if (prevAdminKey === undefined) delete process.env.ADMIN_KEY;
      else process.env.ADMIN_KEY = prevAdminKey;
      if (prevAnthropicKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = prevAnthropicKey;
      for (const p of [dbFactoryPath, experienceStorePath, opplevelserPath]) delete require.cache[p];
    }

    return { passed, failed, failures };
  })();
}

