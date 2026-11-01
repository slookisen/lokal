/**
 * rfb-owner-refresh.test.ts — dev-request 2026-11-01-rfb-hold-profilen-oppdatert
 * («Hold profilen oppdatert»): H1 the owner refresh, H2 the owner-portal card,
 * H3 the catalog entry.
 *
 * Every block runs on a FRESH in-memory main DB with the production schema
 * (__pinInMemoryDbForTesting, restored in finally); env flags are saved and
 * restored. No real network and no real model: the homepage fetch and the
 * about judges are stubs (deps.ownerRefresh / applyOwnerRefreshWrites).
 *
 * Covers:
 *   (r) H3 catalog: auto.updates live behind OWNER_AUTO_UPDATES_ENABLED
 *       (liveFlag: off = coming_soon at run time), owner default fill_empty,
 *       «Foreslå til meg» hidden and refused, options in Daniel's order
 *   (f) the field planner: fill_empty only empty fields; automatic also filled
 *       enrichment fields; never owner-saved (curated by owner / owner
 *       provenance / a /selger owner write) or CS-locked fields; about and
 *       description together; categories only when empty; unreadable locks →
 *       nothing
 *   (w) AC1/AC2/AC5 the write path: fill_empty fills only empty allowed fields
 *       and leaves owner-saved fields, products, prices, stock, organic claims
 *       and e-mail untouched; never → nothing; automatic overwrites filled
 *       enrichment fields but not CS-locked ones; organic prose / categories
 *       refused; the owner's save between plan and write wins; flag off →
 *       nothing; one change-log row per written field with the source, shown
 *       by the owner's GET /api/agents/:id/my-audit; provenance merged;
 *       upsertKnowledge's forced owner lock (enforceOwnerLock) with
 *       OWNER_LOCK_ENFORCE_WRITES off
 *   (n) AC3 + the nightly run end to end: flag off vs on on identical seeds —
 *       the unowned cohort, every step's selection and outcomes and the
 *       unowned rows' writes are identical; flag off has no owner step, no
 *       report key, no envelope claim and writes nothing for owners; flag on
 *       refreshes owners (fill_empty / automatic / never / owner-saved /
 *       social host) through the real extractor (stub fetch + judges), counts
 *       the judge calls on the night's LLM meter, stamps the rotation memory,
 *       records its own envelope claim; automatic is due the next night,
 *       fill_empty is not
 *   (g) guards: the LLM cap (a profile that needs the judges waits unstamped,
 *       a categories-only one runs), the run deadline (time_budget → skipped),
 *       the enrichment write-pause
 *   (p) dry run / preview: the owner rows with their choice and fields
 *       (flag on only), a hidden owned fixture included as fill_empty
 *   (c) AC4 the portal card: shown to a verified owner NOT on the «Mine valg»
 *       allowlist, catalog texts only, save → owner_feature_settings + change
 *       log, «Mine valg» shows the same value (both ways), hidden / cross-site
 *       / no session / not owner refused; flag off → no card, POST 404,
 *       nothing written, «Mine valg» keeps it in «Planlagt»
 *   (s) the switch probe's choice evaluation and its auto.updates reader
 *   Fix-up round 1 (review of 99d63d6): automatic never overwrites text the
 *       owner wrote by a path without a per-field trace (P1 /selger + a later
 *       CS write, P2 PUT /agents/:id/description) — only text provably ours;
 *       a failed write / non-fetch failure is stamped (no nightly retry loop,
 *       M19), an unavailable about judge is transient; prose claims (organic
 *       variants, certification marks, e-mail, prices) refused; the probe
 *       reads 100 % with the flag off; the card follows the vertical rule;
 *       planOnlyFields without dryRun throws; the per-row deadline / 08Z stop
 *       and a timed-out row's reservation inside step 6 (M24, M25, M33)
 *   Follow-up (round 2): the auto.guarantee text follows the flag (Daniel
 *       2026-11-01) in «Mine valg», the portal card, the owner API and
 *       /for-produsenter; the owner API's flag-off shape (route level); the
 *       reviewer's prose probe (false positives fixed: «nok», «nyt Norge»,
 *       «Spesialitet:», «3 kr og 5 kyr», «bio-gjødsel»; new: KRAV, «biologisk
 *       dyrket», «kroner 120», «€», «[at]»); provably-ours text + hybrid /
 *       owner_updated_at through the cohort SQL; non-fetch failures and the
 *       extractor throw stamped; the judge-unavailable streak
 *
 * Two ways to run:
 *   1. Standalone:  npx tsx src/services/rfb-owner-refresh.test.ts
 *   2. Wired into the gate: tests/test.ts (runSerial — pins the DB singleton).
 */

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

const ENV_KEYS = [
  "OWNER_AUTO_UPDATES_ENABLED",
  "OWNER_LOCK_ENFORCE_WRITES",
  "OWNER_FEATURES_ALLOWED_SUBJECTS",
  "OWNER_VERIFIED_OWNER_GATE_ENABLED",
  "ENRICHMENT_ABOUT_PAGE_ENABLED",
  "RFB_ENRICHMENT_NIGHTLY_ENABLED",
  "RFB_ENRICHMENT_CAP_URL_CHECK",
  "RFB_ENRICHMENT_CAP_EMAIL_DOMAIN_WEBSITE",
  "RFB_ENRICHMENT_CAP_BRREG",
  "RFB_ENRICHMENT_CAP_BM_SLUGS",
  "RFB_ENRICHMENT_CAP_CONTACT_EXTRACTION",
  "RFB_ENRICHMENT_CAP_CONTENT",
  "RFB_ENRICHMENT_CAP_REVERIFY",
  "RFB_ENRICHMENT_CAP_OWNER_REFRESH",
  "RFB_ENRICHMENT_LLM_CAP",
  "RFB_ENRICHMENT_MAX_RUNTIME_MINUTES",
  "RFB_ENRICHMENT_RETRY_DAYS",
  "RFB_ENRICHMENT_NIGHTLY_HOURS_UTC",
  "RFB_SECOND_LINE_VERIFICATION_ENABLED",
  // Cleared for every block: no block may reach a real model.
  "ANTHROPIC_API_KEY",
] as const;
type EnvKey = (typeof ENV_KEYS)[number];

/** A homepage the real extractor turns into an about candidate and categories. */
const ABOUT_TEXT =
  "Vi driver en liten gård i Valdres med sau og bier, og selger lammekjøtt, honning og ull direkte fra gården hele året.";
const PAGE =
  `<html><head><title>Eier Gård</title><meta name="description" content="${ABOUT_TEXT}"></head>` +
  `<body><h1>Eier Gård</h1><p>${ABOUT_TEXT}</p><p>Vi selger grønnsaker, honning og lammekjøtt rett fra gården.</p></body></html>`;

export async function runRfbOwnerRefreshTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
    assertEq(cond, true, label);
  }

  try {
    (require("../config/vertical-config") as typeof import("../config/vertical-config")).loadConfigsAtBoot();
  } catch {
    // already loaded by an earlier suite in this process
  }
  const initMod = require("../database/init") as typeof import("../database/init");
  const job = require("./rfb-enrichment-nightly") as typeof import("./rfb-enrichment-nightly");
  const orf = require("./rfb-owner-refresh") as typeof import("./rfb-owner-refresh");
  const reg = require("../owner-features/registry") as typeof import("../owner-features/registry");
  const rs = require("../owner-features/resolve") as typeof import("../owner-features/resolve");
  const ks = require("./knowledge-service") as typeof import("./knowledge-service");
  const pause = require("./enrichment-write-pause") as typeof import("./enrichment-write-pause");
  const probe = require("../owner-features/switch-probe") as typeof import("../owner-features/switch-probe");

  const prevEnv: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) prevEnv[k] = process.env[k];
  const prevFetch = globalThis.fetch;
  const prevLog = console.log;
  if (!log) console.log = () => { /* silence job / route chatter */ };

  function setEnv(values: Partial<Record<EnvKey, string>>): void {
    for (const k of ENV_KEYS) delete process.env[k];
    for (const [k, v] of Object.entries(values)) if (v !== undefined) process.env[k] = v;
  }
  const ON = { OWNER_AUTO_UPDATES_ENABLED: "1" } as const;

  let db: any = null;
  async function withDb(label: string, fn: () => Promise<void>): Promise<void> {
    const restore = initMod.__pinInMemoryDbForTesting();
    db = initMod.getDb();
    try {
      await fn();
    } catch (err) {
      failed++;
      failures.push(`${label}: unexpected error: ${err instanceof Error ? err.stack || err.message : String(err)}`);
    } finally {
      (globalThis as any).fetch = prevFetch;
      restore();
      db = null;
    }
  }

  let seq = 0;
  type Knowledge = {
    website?: string | null; email?: string | null; about?: string | null; products?: string | null;
    curated_fields?: string | null; field_provenance?: string | null; data_source?: string | null;
    certifications?: string | null; url_last_status?: number | null; phone?: string | null;
  };
  /** One RFB producer; owned = claimed_at set (the customer rule). */
  function seed(
    id: string,
    o: { owned?: boolean; description?: string | null; categories?: string | null; url?: string; catalog_hidden?: number; k?: false | Knowledge } = {},
  ): void {
    seq += 1;
    db.prepare(
      `INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, created_at, claimed_at,
                           categories, is_active, is_verified, catalog_hidden)
       VALUES (?, ?, ?, 'test', ?, ?, 'producer', ?, ?, ?, ?, 1, ?, ?)`,
    ).run(
      id, `Gård ${id}`, o.description === undefined ? "" : o.description, `post@${id}.example.no`, o.url ?? "",
      `key-${id}`, `2026-01-01 00:00:${String(seq % 60).padStart(2, "0")}`, o.owned ? "2026-10-01T00:00:00.000Z" : null,
      o.categories === undefined ? "[]" : o.categories, o.owned ? 1 : 0, o.catalog_hidden ?? 0,
    );
    if (o.k === false) return;
    const k = o.k ?? {};
    const cols: Record<string, unknown> = { agent_id: id, verification_status: "pending_verify" };
    for (const key of ["website", "email", "about", "products", "curated_fields", "field_provenance", "data_source", "certifications", "url_last_status", "phone"] as const) {
      if (k[key] !== undefined) cols[key] = k[key];
    }
    const names = Object.keys(cols);
    db.prepare(`INSERT INTO agent_knowledge (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")})`).run(...names.map((n) => cols[n]));
  }
  /** Store an owner choice the way the portal does (flag on while writing). */
  function choose(id: string, value: string): void {
    const prev = process.env.OWNER_AUTO_UPDATES_ENABLED;
    process.env.OWNER_AUTO_UPDATES_ENABLED = "1";
    try {
      const r = rs.setOwnerFeatureValue("rfb", id, "auto.updates", value, { actor: "owner", detail: "test" }, { db });
      if (r.kind !== "ok") throw new Error(`setup: could not store auto.updates=${value} for ${id}: ${JSON.stringify(r)}`);
    } finally {
      if (prev === undefined) delete process.env.OWNER_AUTO_UPDATES_ENABLED; else process.env.OWNER_AUTO_UPDATES_ENABLED = prev;
    }
  }
  const kn = (id: string) => db.prepare(`SELECT about, products, email, certifications, curated_fields, field_provenance FROM agent_knowledge WHERE agent_id = ?`).get(id) as any;
  const ag = (id: string) => db.prepare(`SELECT description, categories, contact_email FROM agents WHERE id = ?`).get(id) as any;
  const audits = (id: string) => db.prepare(`SELECT field_name, old_value, new_value, changed_by, notes FROM agent_knowledge_audit WHERE agent_id = ? ORDER BY changed_at, rowid`).all(id) as any[];
  const homepageWrite = (id: string, field: string, table: "agent_knowledge" | "agents", value: unknown, prov = String(value)) => ({
    agent_id: id, field, table, column_value: value,
    provenance: { source_type: "website_homepage", value: prov, fetched_at: "2026-11-01T00:00:00.000Z", source_url: `https://${id}.example.no` },
  });
  const snap = (o: Partial<import("./rfb-owner-refresh").OwnerRefreshSnapshot>): import("./rfb-owner-refresh").OwnerRefreshSnapshot => ({
    id: "x", name: "x", a_url: null, description: "", categories: "[]", has_knowledge: true, k_website: "https://x.no",
    about: "", curated_fields: null, field_provenance: null, data_source: "auto", homepage_unreachable_since: null, ...o,
  });

  // Stub about judges (approve everything), counting calls.
  let judgeCalls = 0;
  const approveJudges: import("../routes/admin-knowledge").HcrAboutJudges = {
    quality: async () => { judgeCalls++; return { approved: true, reasoning: "stub" }; },
    facts: async () => { judgeCalls++; return { ok: true, supported: true, unsupportedClaims: [], bestPage: 0, reason: "stub" }; },
    comparison: async () => { judgeCalls++; return { ok: true, better: true, verdict: "BEDRE", reasoning: "stub" }; },
    timeoutMs: 1,
  };
  const fetched: string[] = [];
  const pageFetch = (async (url: any) => {
    fetched.push(String(url));
    return new Response(PAGE, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
  }) as typeof fetch;
  // A real network call would be a test bug: fail loudly.
  (globalThis as any).fetch = async (url: any) => { throw new Error(`unexpected real fetch: ${String(url)}`); };

  try {
    // ── (r) H3: the catalog entry ─────────────────────────────────────────
    await withDb("r", async () => {
      setEnv({});
      const e = reg.getOwnerFeature("auto.updates");
      assertEq([e.status, e.liveFlag, e.default.owner, e.default.unclaimed, e.surfaces], ["live", "OWNER_AUTO_UPDATES_ENABLED", "fill_empty", "automatic", ["job:rfb_enrichment_nightly"]],
        "r1: auto.updates is live behind OWNER_AUTO_UPDATES_ENABLED, owner default fill_empty, surface job:rfb_enrichment_nightly");
      assertEq(reg.visibleOwnerFeatureOptions(e).map((o) => o.label.no), ["Fyll tomme felt selv", "Oppdateres automatisk hver natt", "Aldri"],
        "r1: the offered options, in Daniel's order — «Foreslå til meg» hidden");
      assertEq((e.options || []).find((o) => o.value === "suggest")?.hidden, true, "r1: «Foreslå til meg» stays in the catalog, hidden");
      assertEq([reg.ownerFeatureStatus(e), reg.ownerFeatureStatus(e, { OWNER_AUTO_UPDATES_ENABLED: "1" }), reg.ownerFeatureStatus(e, { OWNER_AUTO_UPDATES_ENABLED: "true" }), reg.ownerFeatureStatus(e, { OWNER_AUTO_UPDATES_ENABLED: "yes" })],
        ["coming_soon", "live", "live", "coming_soon"], "r2: run-time status: flag off (or junk) = coming_soon, \"1\"/\"true\" = live");
      assertEq(reg.ownerFeatureStatus(reg.getOwnerFeature("orders.enabled")), "live", "r2: an entry without liveFlag keeps its status");
      seed("r-owned", { owned: true, k: {} });
      seed("r-free", { owned: false, k: {} });
      const off = rs.resolveOwnerFeature("rfb", "r-owned", "auto.updates", { db });
      assertEq([off.value, off.block, off.changeable], ["suggest", "coming_soon", false], "r3: flag off — the pre-live answer: «Foreslå til meg», coming_soon (today's behaviour)");
      const pre = reg.ownerFeatureEntryForEnv(e, {});
      assertEq([pre.default.owner, reg.visibleOwnerFeatureOptions(pre).map((o) => o.value), pre.since], ["suggest", ["suggest", "fill_empty", "never", "automatic"], "2026-10-27"],
        "r3: flag off — the owner API's entry is the pre-live one (default, all four options in their old order, since)");
      assertEq(reg.ownerFeatureEntryForEnv(e, { OWNER_AUTO_UPDATES_ENABLED: "1" }), e, "r3: flag on — the entry itself");
      assertEq(rs.setOwnerFeatureValue("rfb", "r-owned", "auto.updates", "automatic", { actor: "owner" }, { db }).kind, "blocked", "r3: flag off — an owner write is refused (coming_soon)");
      assertEq((db.prepare(`SELECT COUNT(*) AS n FROM owner_feature_settings`).get() as any).n, 0, "r3: flag off — nothing stored");
      setEnv(ON);
      const on = rs.resolveOwnerFeature("rfb", "r-owned", "auto.updates", { db });
      assertEq([on.value, on.source, on.changeable], ["fill_empty", "default", true], "r4: flag on — an owner without a stored choice gets fill_empty (the ~45 existing owners)");
      assertEq(rs.resolveOwnerFeature("rfb", "r-free", "auto.updates", { db }).value, "automatic", "r4: an unclaimed profile keeps the unclaimed default");
      const hid = rs.setOwnerFeatureValue("rfb", "r-owned", "auto.updates", "suggest", { actor: "owner" }, { db });
      assertEq(hid.kind, "invalid_value", "r5: the hidden «Foreslå til meg» cannot be stored");
      assertEq(rs.setOwnerFeatureValue("rfb", "r-owned", "auto.updates", "never", { actor: "owner" }, { db }).kind, "ok", "r5: a visible option is stored");
      assertEq(rs.resolveOwnerFeature("rfb", "r-owned", "auto.updates", { db }).value, "never", "r5: … and resolves");
    });

    // ── (f) the field planner ─────────────────────────────────────────────
    {
      const p = orf.plannedOwnerRefreshFields;
      const own = (f: string) => JSON.stringify({ [f]: { by: "owner", locked_at: "2026-10-30T00:00:00.000Z" } });
      const cs = (f: string) => JSON.stringify({ [f]: { by: "rfb-customer-service", locked_at: "2026-10-30T00:00:00.000Z" } });
      assertEq(p(snap({}), "fill_empty"), ["about", "description", "categories"], "f1: fill_empty, everything empty → about, description, categories");
      assertEq(p(snap({ about: "Tekst", description: "" }), "fill_empty"), ["categories"], "f2: fill_empty, about filled → no about, and no description without it");
      assertEq(p(snap({ description: "Beskrivelse" }), "fill_empty"), ["about", "categories"], "f3: fill_empty, description filled → about only");
      assertEq(p(snap({ categories: '["fruit"]' }), "fill_empty"), ["about", "description"], "f4: fill_empty, categories filled → not categories");
      const ours = (about: string, description: string, st = "google_places") => JSON.stringify({
        about: [{ source_type: st, value: about }], description: { sources: [{ source_type: "website_homepage", value: description }] } });
      assertEq(p(snap({ about: "A", description: "B", categories: '["fruit"]', field_provenance: ours("A", "B") }), "automatic"), ["about", "description"],
        "f5: automatic, filled about/description whose text a non-owner source recorded (provably ours) → about + description (categories only when empty)");
      assertEq(p(snap({ about: "A  text", description: "B", field_provenance: ours("A text", "B") }), "automatic"), ["about", "description", "categories"], "f5: … whitespace differences do not matter");
      assertEq(p(snap({ about: "A", description: "B", categories: '["fruit"]' }), "automatic"), [], "f5b: automatic, filled fields without a provenance record → nothing (exactly fill_empty)");
      assertEq(p(snap({ about: "A", description: "B", categories: '["fruit"]', field_provenance: ours("A gammel", "B gammel") }), "automatic"), [], "f5c: a record whose value is not the current text → not ours, nothing");
      assertEq(p(snap({ about: "A", description: "B", categories: '["fruit"]', field_provenance: ours("A", "B", "owner_relay") }), "automatic"), ["description"].filter(() => false),
        "f5d: an owner-ish record (owner_relay) never proves the text ours → about stays (and description with it)");
      assertEq(p(snap({ about: "", description: "B", field_provenance: JSON.stringify({}) }), "automatic"), ["about", "categories"], "f5e: an empty about is filled; a filled description without proof is not");
      assertEq(p(snap({ about: "A", description: "B", owner_updated_at: "2026-10-30T10:00:00.000Z", field_provenance: ours("A", "B") }), "automatic"), ["categories"],
        "f6b: owner_updated_at set (the owner wrote through /selger, data_source later reset) → only empty fields, even with proof");
      assertEq(p(snap({ about: "A", description: "B", data_source: "hybrid" }), "automatic"), ["categories"], "f6: automatic on a profile the owner wrote through /selger (hybrid) → only empty fields");
      assertEq(p(snap({ about: "A", data_source: "owner" }), "automatic"), ["categories"], "f6: … same for data_source owner");
      assertEq(p(snap({ curated_fields: own("about") }), "fill_empty"), ["categories"], "f7: about saved by the owner → neither about nor description");
      assertEq(p(snap({ about: "Eier", curated_fields: own("about") }), "automatic"), ["categories"], "f7: … also with automatic");
      assertEq(p(snap({ curated_fields: cs("description") }), "automatic"), ["categories"], "f8: description locked by customer service → neither about nor description");
      assertEq(p(snap({ curated_fields: cs("categories") }), "fill_empty"), ["about", "description"], "f8: categories locked → not categories");
      assertEq(p(snap({ field_provenance: JSON.stringify({ about: [{ source_type: "owner", value: "x" }] }) }), "automatic"), ["categories"], "f9: an owner provenance record on about → not about/description");
      assertEq(p(snap({ curated_fields: "{not json" }), "fill_empty"), [], "f10: unreadable curated_fields → nothing (fail closed)");
      assertEq(p(snap({ field_provenance: "[1,2" }), "automatic"), [], "f10: unreadable field_provenance → nothing (fail closed)");
      assertEq(p(snap({ categories: "{bad" }), "fill_empty"), ["about", "description"], "f11: an unreadable category list is not «empty» (never overwritten)");
      assertEq(orf.ownerRefreshRowLlmCallsMax({ fields: ["categories"] }), 0, "f12: a categories-only profile reserves no model call");
      assertEq(orf.ownerRefreshRowLlmCallsMax({ fields: ["about", "description", "categories"] }), 3, "f12: with about: the three about judges");
      assertEq([...orf.OWNER_REFRESH_FIELDS], ["about", "description", "categories"], "f13: the allow list");
      for (const f of ["products", "price_nok", "availability", "certifications", "specialties", "email", "contact_email", "order_notification_email", "order_notifications_opt_in"]) {
        assertTrue(orf.OWNER_REFRESH_NEVER_FIELDS.includes(f), `f13: ${f} is on the never list`);
      }
    }

    // ── (w) AC1/AC2/AC5: the write path ───────────────────────────────────
    await withDb("w", async () => {
      setEnv(ON);
      const RUN = "run-test-owner-refresh";
      const PRODUCTS = JSON.stringify([{ name: "Poteter", price: "30 kr/kg", category: "vegetables" }]);
      // w1 — fill_empty (no stored choice): only empty, allowed fields.
      seed("w-fill", { owned: true, url: "https://w-fill.example.no", description: "", categories: "[]",
        k: { website: "https://w-fill.example.no", about: "", products: PRODUCTS, email: "post@w-fill.example.no", certifications: '["Debio"]' } });
      db.prepare(`INSERT INTO products (id, agent_id, name, name_norm, price_nok, unit, availability, category, availability_source) VALUES ('p-w-fill', 'w-fill', 'Poteter', 'poteter', 30, 'kg', 'in_stock', 'vegetables', 'admin_producer_confirmed')`).run();
      const prodRow = () => db.prepare(`SELECT * FROM products WHERE id = 'p-w-fill'`).get();
      const prod0 = prodRow();
      const r1 = orf.applyOwnerRefreshWrites(db, "w-fill", [
        homepageWrite("w-fill", "about", "agent_knowledge", ABOUT_TEXT),
        homepageWrite("w-fill", "description", "agents", ABOUT_TEXT),
        homepageWrite("w-fill", "categories", "agents", JSON.stringify(["vegetables", "organic", "honey"])),
        homepageWrite("w-fill", "products", "agent_knowledge", JSON.stringify([{ name: "Lam" }])),
        homepageWrite("w-fill", "email", "agent_knowledge", "ny@w-fill.example.no"),
        homepageWrite("w-fill", "certifications", "agent_knowledge", '["Økologisk"]'),
        homepageWrite("w-fill", "price_nok", "agents", "99"),
      ] as any, { runId: RUN });
      assertEq(r1.written.map((w) => w.field), ["about", "description", "categories"], "w1 (AC1): fill_empty writes the empty allowed fields");
      assertEq(r1.refused, [
        { field: "products", reason: "never_field" }, { field: "email", reason: "never_field" },
        { field: "certifications", reason: "never_field" }, { field: "price_nok", reason: "never_field" },
      ], "w1 (AC1): products, e-mail, certification claims and prices are refused (never list)");
      assertEq([kn("w-fill").about, ag("w-fill").description, JSON.parse(ag("w-fill").categories)], [ABOUT_TEXT, ABOUT_TEXT, ["vegetables", "honey"]],
        "w1: about + description filled, categories filled without the organic one");
      assertEq([kn("w-fill").products, kn("w-fill").email, kn("w-fill").certifications, ag("w-fill").contact_email], [PRODUCTS, "post@w-fill.example.no", '["Debio"]', "post@w-fill.example.no"],
        "w1 (AC1): products/prices, e-mail and certifications unchanged");
      assertEq(prodRow(), prod0, "w1 (AC1): the products row (price, stock) unchanged");
      const a1 = audits("w-fill");
      assertEq(a1.map((a) => [a.field_name, a.changed_by]), [["about", "system"], ["description", "system"], ["categories", "system"]], "w1 (AC5): one change-log row per written field (changed_by system)");
      assertTrue(a1.every((a) => a.notes.includes("auto.updates=fill_empty") && a.notes.includes("kilde=website_homepage https://w-fill.example.no") && a.notes.includes(RUN)),
        "w1 (AC5): every row carries the choice, the source and its URL, and the run id");
      assertEq([a1[0].old_value, a1[0].new_value], ["", ABOUT_TEXT], "w1 (AC5): old and new value");
      const prov = JSON.parse(kn("w-fill").field_provenance);
      assertEq(["about", "description", "categories"].map((f) => (prov[f] as any[]).map((x) => x.source_type)), [["website_homepage"], ["website_homepage"], ["website_homepage"]],
        "w1: the website_homepage provenance record merged for each field");
      // The owner sees the rows in the portal's «Endringslogg» feed.
      for (const m of ["../routes/owner-portal"]) { try { delete require.cache[require.resolve(m)]; } catch { /* not loaded */ } }
      const portalMod = require("../routes/owner-portal") as typeof import("../routes/owner-portal");
      db.prepare("INSERT INTO magic_links (id, email, token, agent_id, used, created_at, expires_at) VALUES ('ml-w', 'post@w-fill.example.no', 'tok-w-fill', 'w-fill', 1, ?, ?)")
        .run(new Date().toISOString(), new Date(Date.now() + 86_400_000).toISOString());
      const feed = await invoke(findRouteHandler(portalMod.default, "/api/agents/:agentId/my-audit", "get"), makeReq({ params: { agentId: "w-fill" }, token: "tok-w-fill", query: { limit: "20" } }));
      assertEq([feed.status, (feed.body?.audits ?? []).filter((a: any) => a.changed_by === "system").map((a: any) => a.field_name).sort()], [200, ["about", "categories", "description"]],
        "w1 (AC5): GET /api/agents/:id/my-audit shows the owner the three rows");

      // w2 — owner-saved about: not touched, not even the empty description beside it.
      seed("w-own", { owned: true, description: "", categories: "[]", k: { about: "Dette skrev eieren selv.", curated_fields: JSON.stringify({ about: { by: "owner", locked_at: "2026-10-30T00:00:00.000Z" } }) } });
      const r2 = orf.applyOwnerRefreshWrites(db, "w-own", [
        homepageWrite("w-own", "about", "agent_knowledge", ABOUT_TEXT),
        homepageWrite("w-own", "description", "agents", ABOUT_TEXT),
        homepageWrite("w-own", "categories", "agents", JSON.stringify(["meat"])),
      ] as any, { runId: RUN });
      assertEq([r2.written.map((w) => w.field), r2.refused], [["categories"], [{ field: "about", reason: "not_wanted" }, { field: "description", reason: "not_wanted" }]],
        "w2 (AC1): an owner-saved field (and its pair) is never written; the empty categories are");
      assertEq([kn("w-own").about, ag("w-own").description], ["Dette skrev eieren selv.", ""], "w2 (AC1): the owner's text is unchanged");

      // w3 — never: nothing.
      seed("w-never", { owned: true, k: { about: "" } });
      choose("w-never", "never");
      const r3 = orf.applyOwnerRefreshWrites(db, "w-never", [homepageWrite("w-never", "about", "agent_knowledge", ABOUT_TEXT)] as any, { runId: RUN });
      assertEq([r3.written.length, r3.refused, kn("w-never").about, audits("w-never").length], [0, [{ field: "about", reason: "choice_never" }], "", 0],
        "w3 (AC2): never → nothing written, no change-log row");

      // w4 — automatic: filled enrichment fields are updated.
      seed("w-auto", { owned: true, description: "Gammel beskrivelse fra en katalog.", categories: '["fruit"]',
        k: { about: "Gammel tekst fra en katalog.", field_provenance: JSON.stringify({
          about: [{ source_type: "google_places", value: "Gammel tekst fra en katalog." }],
          description: [{ source_type: "google_places", value: "Gammel beskrivelse fra en katalog." }] }) } });
      choose("w-auto", "automatic");
      const r4 = orf.applyOwnerRefreshWrites(db, "w-auto", [
        homepageWrite("w-auto", "about", "agent_knowledge", ABOUT_TEXT),
        homepageWrite("w-auto", "description", "agents", ABOUT_TEXT),
        homepageWrite("w-auto", "categories", "agents", JSON.stringify(["meat"])),
      ] as any, { runId: RUN });
      assertEq([r4.written.map((w) => w.field), r4.refused], [["about", "description"], [{ field: "categories", reason: "not_wanted" }]],
        "w4 (AC2): automatic overwrites the filled enrichment about + description; a filled category list stays");
      assertEq([kn("w-auto").about, ag("w-auto").description, ag("w-auto").categories], [ABOUT_TEXT, ABOUT_TEXT, '["fruit"]'], "w4 (AC2): values");
      assertTrue(audits("w-auto").every((a) => a.notes.includes("auto.updates=automatic")), "w4 (AC5): the change-log rows name the choice automatic");

      // w5 — automatic, but customer service locked the description: about + description untouched.
      seed("w-cs", { owned: true, description: "Rettet av kundeservice.", categories: "[]", k: { about: "Gammel tekst.", curated_fields: JSON.stringify({ description: { by: "rfb-customer-service", locked_at: "2026-10-29T00:00:00.000Z" } }) } });
      choose("w-cs", "automatic");
      const r5 = orf.applyOwnerRefreshWrites(db, "w-cs", [
        homepageWrite("w-cs", "about", "agent_knowledge", ABOUT_TEXT),
        homepageWrite("w-cs", "description", "agents", ABOUT_TEXT),
      ] as any, { runId: RUN });
      assertEq([r5.written.length, kn("w-cs").about, ag("w-cs").description], [0, "Gammel tekst.", "Rettet av kundeservice."], "w5 (AC2): CS-locked fields untouched");
      seed("w-cs-cat", { owned: true, categories: "[]", k: { about: "", curated_fields: JSON.stringify({ categories: { by: "admin", locked_at: "2026-10-29T00:00:00.000Z" } }) } });
      const r5b = orf.applyOwnerRefreshWrites(db, "w-cs-cat", [homepageWrite("w-cs-cat", "categories", "agents", '["meat"]')] as any, { runId: RUN });
      assertEq([r5b.written.length, ag("w-cs-cat").categories], [0, "[]"], "w5 (AC2): a locked (empty) category list is not filled");

      // w6 — a profile the owner wrote through /selger (hybrid), automatic: only empty fields.
      seed("w-hybrid", { owned: true, description: "", categories: "[]", k: { about: "Skrevet i /selger.", data_source: "hybrid" } });
      choose("w-hybrid", "automatic");
      const r6 = orf.applyOwnerRefreshWrites(db, "w-hybrid", [
        homepageWrite("w-hybrid", "about", "agent_knowledge", ABOUT_TEXT),
        homepageWrite("w-hybrid", "categories", "agents", '["meat"]'),
      ] as any, { runId: RUN });
      assertEq([r6.written.map((w) => w.field), kn("w-hybrid").about], [["categories"], "Skrevet i /selger."], "w6: automatic never overwrites what the owner wrote through /selger");

      // w7 — organic claims: prose refused whole, organic category dropped (all organic → refused).
      seed("w-eco", { owned: true, description: "", categories: "[]", k: { about: "" } });
      const r7 = orf.applyOwnerRefreshWrites(db, "w-eco", [
        homepageWrite("w-eco", "about", "agent_knowledge", "Vi driver økologisk landbruk med sau og bier i Valdres, og selger kjøtt og honning."),
        homepageWrite("w-eco", "description", "agents", "Vi driver økologisk landbruk med sau og bier i Valdres, og selger kjøtt og honning."),
        homepageWrite("w-eco", "categories", "agents", '["organic"]'),
      ] as any, { runId: RUN });
      assertEq(r7.refused, [{ field: "about", reason: "organic_claim" }, { field: "description", reason: "description_without_about" }, { field: "categories", reason: "organic_claim" }],
        "w7: an organic claim is never written (prose refused, an organic-only category list refused)");
      assertEq([kn("w-eco").about, ag("w-eco").description, ag("w-eco").categories, audits("w-eco").length], ["", "", "[]", 0], "w7: nothing written");

      // w8 — the owner saves while the page is fetched: the re-read wins.
      seed("w-race", { owned: true, k: { about: "" } });
      const planned = orf.plannedOwnerRefreshFields(snap({ about: "" }), "fill_empty");
      assertTrue(planned.includes("about"), "w8: planned with about empty");
      db.prepare(`UPDATE agent_knowledge SET about = 'Eieren rakk å skrive.', curated_fields = ? WHERE agent_id = 'w-race'`).run(JSON.stringify({ about: { by: "owner", locked_at: "2026-11-01T00:00:00.000Z" } }));
      const r8 = orf.applyOwnerRefreshWrites(db, "w-race", [homepageWrite("w-race", "about", "agent_knowledge", ABOUT_TEXT)] as any, { runId: RUN });
      assertEq([r8.written.length, kn("w-race").about], [0, "Eieren rakk å skrive."], "w8: an owner save between plan and write is never overwritten");

      // w9 — not owned any more / flag off → nothing.
      seed("w-free", { owned: false, k: { about: "" } });
      assertEq(orf.applyOwnerRefreshWrites(db, "w-free", [homepageWrite("w-free", "about", "agent_knowledge", ABOUT_TEXT)] as any, { runId: RUN }).refused,
        [{ field: "about", reason: "not_owned" }], "w9: a profile without a verified owner is never written by the owner refresh");
      seed("w-off", { owned: true, k: { about: "" } });
      setEnv({});
      const r9 = orf.applyOwnerRefreshWrites(db, "w-off", [homepageWrite("w-off", "about", "agent_knowledge", ABOUT_TEXT)] as any, { runId: RUN });
      assertEq([r9.written.length, kn("w-off").about], [0, ""], "w9: flag off → nothing written");
      setEnv(ON);

      // w11 (review P1) — the owner writes about in /selger, then a CS / admin
      // knowledge write resets data_source to auto: automatic must still keep it.
      seed("w-p1", { owned: true, url: "https://w-p1.example.no", description: "Kort katalogtekst.", categories: '["meat"]',
        k: { website: "https://w-p1.example.no", about: "Gammel tekst.", data_source: "auto",
             field_provenance: JSON.stringify({ about: [{ source_type: "google_places", value: "Gammel tekst." }], description: [{ source_type: "google_places", value: "Kort katalogtekst." }] }) } });
      ks.knowledgeService.ownerUpdate("w-p1", { about: "Dette har eieren selv skrevet i /selger om gården sin." });
      ks.knowledgeService.upsertKnowledge("w-p1", { address: "Gardsvegen 1", dataSource: "auto" } as any);
      const p1state = db.prepare(`SELECT data_source, owner_updated_at FROM agent_knowledge WHERE agent_id = 'w-p1'`).get() as any;
      assertEq([p1state.data_source, !!p1state.owner_updated_at], ["auto", true], "w11 (P1): setup — the CS write reset data_source to auto; owner_updated_at is still set");
      choose("w-p1", "automatic");
      const p1row = (await orf.loadOwnerRefreshCohort(db, { nowMs: Date.now() })).eligible.find((r) => r.id === "w-p1");
      assertEq(p1row ? p1row.fields : null, null, "w11 (P1): automatic does not plan the owner's about (owner_updated_at) — nothing to do");
      const r11 = orf.applyOwnerRefreshWrites(db, "w-p1", [homepageWrite("w-p1", "about", "agent_knowledge", ABOUT_TEXT), homepageWrite("w-p1", "description", "agents", ABOUT_TEXT)] as any, { runId: RUN });
      assertEq([r11.written.length, kn("w-p1").about, ag("w-p1").description], [0, "Dette har eieren selv skrevet i /selger om gården sin.", "Kort katalogtekst."],
        "w11 (P1): even a planned write is refused — the owner's text and the description stay");

      // w12 (review P2) — the owner wrote agents.description through PUT /agents/:id/description (no trace).
      seed("w-p2", { owned: true, url: "https://w-p2.example.no", description: "Eierens egen beskrivelse.", categories: '["meat"]', k: { website: "https://w-p2.example.no", about: null as any } });
      const mreg = require("./marketplace-registry") as typeof import("./marketplace-registry");
      mreg.marketplaceRegistry.updateAgent("w-p2", { description: "Eierens egen beskrivelse skrevet via PUT /agents/:id/description." } as any);
      choose("w-p2", "automatic");
      const p2row = (await orf.loadOwnerRefreshCohort(db, { nowMs: Date.now() })).eligible.find((r) => r.id === "w-p2");
      assertEq(p2row?.fields, ["about"], "w12 (P2): automatic plans only the empty about, not the owner's description");
      judgeCalls = 0;
      const p2 = await orf.refreshOwnedProfile(db, p2row!, { deadlineAt: Date.now() + 30_000, runId: RUN, deps: { aboutJudges: approveJudges, fetchImpl: pageFetch } });
      assertEq([p2.outcome, p2.written, ag("w-p2").description], ["written", ["about"], "Eierens egen beskrivelse skrevet via PUT /agents/:id/description."],
        "w12 (P2): the empty about is filled, the owner's description is kept");

      // w12b (review N30 / N6) — text provably ours, but the owner wrote the profile:
      // automatic must not overwrite it, read through the cohort SQL itself.
      const proofProv = (id: string) => JSON.stringify({ about: [{ source_type: "google_places", value: `Katalogtekst ${id}.` }], description: [{ source_type: "google_places", value: `Katalogbeskrivelse ${id}.` }] });
      for (const [id, k] of [["w-n30", { data_source: "hybrid" }], ["w-n6", { data_source: "auto" }], ["w-proof", { data_source: "auto" }]] as const) {
        seed(id, { owned: true, url: `https://${id}.example.no`, description: `Katalogbeskrivelse ${id}.`, categories: '["meat"]',
          k: { website: `https://${id}.example.no`, about: `Katalogtekst ${id}.`, field_provenance: proofProv(id), ...k } });
        choose(id, "automatic");
      }
      db.prepare(`UPDATE agent_knowledge SET owner_updated_at = '2026-10-30T10:00:00.000Z' WHERE agent_id = 'w-n6'`).run();
      const n30 = (await orf.loadOwnerRefreshCohort(db, { nowMs: Date.now() })).eligible;
      const fieldsOf = (id: string) => n30.find((r) => r.id === id)?.fields ?? null;
      assertEq(fieldsOf("w-proof"), ["about", "description"], "w12b: control — provably ours, no owner write → automatic plans about + description");
      assertEq(fieldsOf("w-n30"), null, "w12b (N30): provably ours but data_source hybrid (the owner wrote in /selger) → not taken");
      assertEq(fieldsOf("w-n6"), null, "w12b (N6): provably ours but owner_updated_at set (read by the cohort SQL) → not taken");

      // w13 — prose claims: organic variants, certification marks, e-mail, prices.
      // The reviewer's prose probe (round 2) and the earlier cases: every sentence, refused or not.
      // A phone number is no claim (phone is a descriptive field the refresh may fill).
      const pr = orf.ownerRefreshProseRefusal;
      const PROSE_CASES: Array<[string, string | null]> = [
        ["Vi har nok 200 høner og selger egg fra gården.", null],
        ["Det er nok 3 generasjoner som har drevet gården.", null],
        ["Kom og nyt Norge fra sin beste side på gården vår.", null],
        ["Nyt Norge fra sin beste side.", null],
        ["Spesialiteten vår er spekemat.", null],
        ["Spesialitet: røkt laks fra egen røykeri.", null],
        ["Biogass fra gjødsla driver gården.", null],
        ["Vi bruker bio-gjødsel fra egne dyr.", null],
        ["Bioteknologi og biologisk mangfold er viktig for oss.", null],
        ["Ecuador-kaffe brennes her.", null],
        ["Gården ligger 12 km fra Lillehammer.", null],
        ["Følg oss på Instagram @gardsbutikken for nyheter.", null],
        ["Åpent lørdag 10-14, ellers etter avtale.", null],
        ["Vi har 3 kr og 5 kyr.", null],
        ["Kr. Sand er nærmeste by.", null],
        ["Ring 99 99 99 99 for bestilling.", null],
        ["Vi har 120 sauer, 3 krukker og studerte biologi og biografi.", null],
        ["Vår spesialitet er spekemat fra egen gård siden 1952.", null],
        ["Vi selger beint fra gården hver lørdag.", null],
        ["Spekepølsa har fått Spesialitet.", "certification_claim"],
        ["Vi er KRAV-godkjent.", "certification_claim"],
        ["Biologisk dyrket grønnsaker.", "organic_claim"],
        ["Økologiske grønnsaker uten sprøytemidler.", "organic_claim"],
        ["Demeter-sertifisert biodynamisk gård.", "organic_claim"],
        ["Lammekjøtt 150,- pr kg.", "price"],
        ["Pris 120 NOK.", "price"],
        ["Kjøttdeig kroner 120 per kilo.", "price"],
        ["Egg 5 € stykket.", "price"],
        ["Kontakt: post [at] gard.no", "email_address"],
        ["Skriv til post(at)gard.no.", "email_address"],
        ["Merket med Spesialitet-merket fra Matmerk.", "certification_claim"],
        ["Inn på tunet-godkjent gård.", "certification_claim"],
        ["Vi har Beint fra gården-merket.", "certification_claim"],
        ["Ost med Nyt Norge merke.", "certification_claim"],
        ["Ost med Nyt Norge-merket.", "certification_claim"],
        ["Spekepølsa er godkjent som Spesialitet.", "certification_claim"],
        ["Fenalår merket Spesialitet.", "certification_claim"],
        ["Fenalår med beskyttet geografisk betegnelse.", "certification_claim"],
        ["Beskyttet opprinnelsesbetegnelse for osten.", "certification_claim"],
        ["Vi selger bio-honning og lammekjøtt.", "organic_claim"],
        ["Eco-friendly gård i Valdres.", "organic_claim"],
        ["We practise ecological farming.", "organic_claim"],
        ["Ecologically grown vegetables.", "organic_claim"],
        ["Skriv til post@gard.example.no for bestilling.", "email_address"],
        ["Lammekjøtt kr 120 per kilo.", "price"],
        ["Honning 120,- per glass.", "price"],
        ["Egg NOK 60 per brett.", "price"],
        ["Poteter 25 kr kiloen.", "price"],
        ["Ull Kr. 89 per nøste.", "price"],
        ["Egg koster 40 kr.", "price"],
        ["Egg koster 40 kroner brettet.", "price"],
        ["Honning € 12 per glass.", "price"],
        ["Kortreist og Debio-godkjent.", "organic_claim"],
        ["Økonomien på gården og økosystemet rundt.", null],
        [ABOUT_TEXT, null],
      ];
      for (const [text, want] of PROSE_CASES) {
        assertEq(pr(text), want, `w13: «${text}» → ${want ?? "no claim"}`);
      }
      seed("w-claim", { owned: true, description: "", categories: "[]", k: { about: "" } });
      const r13 = orf.applyOwnerRefreshWrites(db, "w-claim", [
        homepageWrite("w-claim", "about", "agent_knowledge", "Bestill på post@w-claim.example.no, lammekjøtt kr 120 per kilo."),
      ] as any, { runId: RUN });
      assertEq([r13.refused, kn("w-claim").about], [[{ field: "about", reason: "email_address" }], ""], "w13: a text with an e-mail address is never written");
      const r13b = orf.applyOwnerRefreshWrites(db, "w-claim", [homepageWrite("w-claim", "about", "agent_knowledge", "Vi selger Nyt Norge-merket ost fra gården vår.")] as any, { runId: RUN });
      assertEq(r13b.refused, [{ field: "about", reason: "certification_claim" }], "w13: a certification mark is never written");
      const r13c = orf.applyOwnerRefreshWrites(db, "w-claim", [homepageWrite("w-claim", "about", "agent_knowledge", "   ")] as any, { runId: RUN });
      assertEq(r13c.refused, [{ field: "about", reason: "empty_value" }], "w13: an empty value is never written");

      // w10 — the owner lock in upsertKnowledge, forced on for this job.
      seed("w-lock", { owned: true, k: { about: "Eierens tekst.", curated_fields: JSON.stringify({ about: { by: "owner", locked_at: "2026-10-30T00:00:00.000Z" } }) } });
      assertEq(process.env.OWNER_LOCK_ENFORCE_WRITES, undefined, "w10: OWNER_LOCK_ENFORCE_WRITES is off");
      const forced = ks.knowledgeService.upsertKnowledge("w-lock", { about: "Overskriving." }, { enforceOwnerLock: true });
      assertEq([forced.skipped, kn("w-lock").about], [[{ field: "about", reason: "owner_locked" }], "Eierens tekst."], "w10: enforceOwnerLock → owner_locked, kept (flag off)");
      const plain = ks.knowledgeService.upsertKnowledge("w-lock", { about: "Overskriving." });
      assertEq([plain.skipped, kn("w-lock").about], [[], "Overskriving."], "w10: without it, the write is byte-identical to before (flag off = no lock)");
      assertEq([...ks.ownerLockedFieldKeys(JSON.stringify({ about: { by: "owner" }, phone: { by: "rfb-customer-service" } }))], ["about"], "w10: ownerLockedFieldKeys = the by:owner keys");
      assertEq([...ks.ownerLockedFieldKeys("{bad")], [], "w10: unreadable → no keys (as upsertKnowledge)");
    });

    // ── (n) AC3 + the nightly run end to end ──────────────────────────────
    const NIGHT = new Date("2026-10-12T00:10:00Z");
    type Call = { step: string; id: string };
    /** Recording stub executors that also WRITE (so the unowned rows' writes can be compared). */
    const stubExecutors = (calls: Call[]): Partial<import("./rfb-enrichment-nightly").RfbEnrichmentExecutors> => {
      const rec = (step: string) => async (row: { id: string }) => {
        calls.push({ step, id: row.id });
        db.prepare(`UPDATE agent_knowledge SET url_last_status = 200 WHERE agent_id = ?`).run(row.id);
        return { outcome: "stub_written", written: true, changed: false };
      };
      return {
        urlCheck: rec("url_check"),
        emailDomainWebsite: rec("email_domain_website"),
        brregContact: rec("brreg_contact"),
        contactExtraction: rec("contact_extraction"),
        contentRefresh: async (row: { id: string }) => {
          calls.push({ step: "content_refresh", id: row.id });
          db.prepare(`UPDATE agent_knowledge SET about = 'Berikelse skrev dette.' WHERE agent_id = ?`).run(row.id);
          return { outcome: "refreshed", written: true, changed: true };
        },
        bmHarvest: async ({ offset, limit }: { offset: number; limit: number }) => {
          calls.push({ step: "bm_harvest", id: `${offset}+${limit}` });
          return { status: 200, total_slugs: 0, offset, scanned: 0, time_budget_exceeded: false, counts: {}, changed_agent_ids: [], written: 0 };
        },
        reverify: async (agentId: string) => {
          calls.push({ step: "reverify", id: agentId });
          return { outcome: "pending_verify", prior: "pending_verify", next: "pending_verify" };
        },
      };
    };
    const OWNED = ["n-fill", "n-auto", "n-never", "n-own", "n-fb"];
    const UNOWNED = ["n-u1", "n-u2", "n-u3"];
    function seedNight(): void {
      for (const id of UNOWNED) {
        seed(id, { url: `https://${id}.no`, k: { website: `https://${id}.no`, email: "", about: "", products: "[]", url_last_status: 200 } });
      }
      seed("n-fill", { owned: true, url: "https://n-fill.example.no", description: "", categories: "[]",
        k: { website: "https://n-fill.example.no", about: "", products: "[]", email: "post@n-fill.example.no" } });
      seed("n-auto", { owned: true, url: "https://n-auto.example.no", description: "Kort gammel tekst fra en katalog.", categories: '["vegetables"]',
        k: { website: "https://n-auto.example.no", about: "Kort gammel tekst fra en katalog.", products: "[]",
             field_provenance: JSON.stringify({ about: [{ source_type: "google_places", value: "Kort gammel tekst fra en katalog." }], description: [{ source_type: "google_places", value: "Kort gammel tekst fra en katalog." }] }) } });
      seed("n-never", { owned: true, url: "https://n-never.example.no", description: "", categories: "[]", k: { website: "https://n-never.example.no", about: "" } });
      seed("n-own", { owned: true, url: "https://n-own.example.no", description: "", categories: "[]",
        k: { website: "https://n-own.example.no", about: "Eierens egen tekst om gården.", curated_fields: JSON.stringify({ about: { by: "owner", locked_at: "2026-10-30T00:00:00.000Z" } }) } });
      seed("n-fb", { owned: true, url: "https://www.facebook.com/n-fb", description: "", categories: "[]", k: { website: "https://www.facebook.com/n-fb", about: "" } });
      choose("n-auto", "automatic");
      choose("n-never", "never");
    }
    const dumpUnowned = () => db.prepare(
      `SELECT a.id, a.description, a.categories, k.about, k.products, k.email, k.url_last_status, k.field_provenance
         FROM agents a LEFT JOIN agent_knowledge k ON k.agent_id = a.id WHERE a.id IN (${UNOWNED.map(() => "?").join(",")}) ORDER BY a.id`,
    ).all(...UNOWNED);
    const dumpOwned = () => db.prepare(
      `SELECT a.id, a.description, a.categories, k.about, k.products, k.email FROM agents a LEFT JOIN agent_knowledge k ON k.agent_id = a.id
        WHERE a.id IN (${OWNED.map(() => "?").join(",")}) ORDER BY a.id`,
    ).all(...OWNED);
    const stepView = (r: import("./rfb-enrichment-nightly").RfbEnrichmentNightlyReport) =>
      r.steps.map((s) => ({ step: s.step, eligible: s.eligible, selected: s.selected, attempted: s.attempted, written: s.written, outcomes: s.outcomes, changed: s.changed_agent_ids, skipped: s.skipped_reason, stopped: s.stopped_reason, re_verified: s.re_verified }));
    const deps = (calls: Call[]) => ({ executors: stubExecutors(calls), ownerRefresh: { aboutJudges: approveJudges, fetchImpl: pageFetch } });

    let offView: any = null;
    await withDb("n-off", async () => {
      setEnv({ RFB_ENRICHMENT_NIGHTLY_ENABLED: "1" });
      fetched.length = 0;
      seedNight();
      const owned0 = dumpOwned();
      const calls: Call[] = [];
      const r = await job.runRfbEnrichmentNightly({ apply: true, trigger: "manual", now: NIGHT, deps: deps(calls) });
      const env = db.prepare(`SELECT claims FROM runs WHERE run_id = ?`).get(r.run_id) as { claims: string };
      offView = { cohort: r.cohort, steps: stepView(r), calls, unowned: dumpUnowned(), totals: r.totals, kinds: JSON.parse(env.claims).map((c: any) => c.meta?.kind) };
      assertEq([r.skipped_reason, "owner_refresh" in r], [null, false], "n1: flag off — the run ran, and it has no owner_refresh key");
      assertTrue(!offView.kinds.includes("rfb_enrichment_owner_refresh"), "n1: flag off — no owner-refresh envelope claim");
      assertEq(dumpOwned(), owned0, "n1: flag off — no owned profile is written");
      assertEq((db.prepare(`SELECT COUNT(*) AS n FROM agent_knowledge_audit WHERE changed_by = 'system'`).get() as any).n, 0, "n1: flag off — no change-log row");
      assertEq(fetched.length, 0, "n1: flag off — no owner homepage fetched");
      assertEq(r.cohort?.excluded.customer, OWNED.length, "n1: the nightly cohort leaves every owned profile out (customer), as before");
    });
    await withDb("n-on", async () => {
      setEnv({ RFB_ENRICHMENT_NIGHTLY_ENABLED: "1", ...ON });
      seedNight();
      const calls: Call[] = [];
      judgeCalls = 0;
      fetched.length = 0;
      const r = await job.runRfbEnrichmentNightly({ apply: true, trigger: "manual", now: NIGHT, deps: deps(calls) });
      const env = db.prepare(`SELECT claims FROM runs WHERE run_id = ?`).get(r.run_id) as { claims: string };
      const claims = JSON.parse(env.claims);
      // AC3: the unowned part is identical to the flag-off run.
      assertEq(r.cohort, offView.cohort, "n2 (AC3): the nightly cohort is identical with the flag on");
      assertEq(stepView(r), offView.steps, "n2 (AC3): every step selects, attempts and reports exactly as with the flag off");
      assertEq(calls, offView.calls, "n2 (AC3): the step executors got exactly the same rows in the same order");
      assertEq(dumpUnowned(), offView.unowned, "n2 (AC3): the unowned rows end up byte-identical");
      assertEq(r.totals, offView.totals, "n2 (AC3): totals unchanged (the owner step stays out of them)");
      assertEq(claims.map((c: any) => c.meta?.kind).filter((k: string) => k !== "rfb_enrichment_owner_refresh"), offView.kinds, "n2 (AC3): the envelope's other claims are the same");
      // The owner step.
      const o = r.owner_refresh!;
      assertTrue(!!o, "n3: flag on — the owner step ran");
      assertEq([o.considered, o.eligible, o.selected, o.skipped_reason, o.stopped_reason], [OWNED.length, 3, 3, null, null], "n3: 5 owned profiles looked at, 3 due (fill_empty, automatic, owner-saved about)");
      assertEq(o.skipped_before_selection, { never: 1, directory_or_social_host: 1 }, "n3: never skipped, a facebook homepage skipped (never fetched)");
      assertEq(o.rows.map((x) => [x.agent_id, x.mode, x.outcome, x.written ?? []]), [
        ["n-fill", "fill_empty", "written", ["about", "description", "categories"]],
        ["n-auto", "automatic", "written", ["about", "description"]],
        ["n-own", "fill_empty", "written", ["categories"]],
      ], "n3 (AC1/AC2): fill_empty fills the empty fields, automatic updates the enrichment about/description, the owner's about stays");
      const vals = Object.fromEntries((dumpOwned() as any[]).map((x) => [x.id, x]));
      assertEq([vals["n-fill"].about, vals["n-fill"].description, JSON.parse(vals["n-fill"].categories).length > 0, vals["n-fill"].email, vals["n-fill"].products],
        [ABOUT_TEXT, ABOUT_TEXT, true, "post@n-fill.example.no", "[]"], "n3 (AC1): n-fill — about/description/categories from the owner's homepage; e-mail and products untouched");
      assertEq([vals["n-auto"].about, vals["n-auto"].categories], [ABOUT_TEXT, '["vegetables"]'], "n3 (AC2): n-auto — about replaced, the filled category list kept");
      assertEq([vals["n-own"].about, vals["n-own"].description, JSON.parse(vals["n-own"].categories).length > 0], ["Eierens egen tekst om gården.", "", true], "n3 (AC1): n-own — the owner's text kept (and the description beside it), empty categories filled");
      assertEq([vals["n-never"].about, vals["n-never"].categories, vals["n-fb"].about], ["", "[]", ""], "n3 (AC2): never and the social-host owner untouched");
      assertEq([...new Set(fetched.map((u) => new URL(u).host))].sort(), ["n-auto.example.no", "n-fill.example.no", "n-own.example.no"], "n3: only the due owners' own sites were fetched (no facebook)");
      assertEq([judgeCalls, r.llm.by_source["owner-refresh-about-judge"], o.llm_calls], [5, 5, 5], "n4: the about judges ran (2 for an empty about, 3 with a comparison) and every call is on the night's LLM meter");
      assertEq(audits("n-fill").map((a) => a.field_name), ["about", "description", "categories"], "n4 (AC5): change-log rows for every written field");
      assertTrue(audits("n-fill").every((a) => a.notes.includes(r.run_id)), "n4 (AC5): … with this run's id");
      const stamps = db.prepare(`SELECT agent_id, last_outcome FROM rfb_enrichment_nightly_attempts WHERE step = 'owner_refresh' ORDER BY agent_id`).all();
      assertEq(stamps, [{ agent_id: "n-auto", last_outcome: "written" }, { agent_id: "n-fill", last_outcome: "written" }, { agent_id: "n-own", last_outcome: "written" }], "n4: the rotation memory is stamped as step owner_refresh");
      const oc = claims.find((c: any) => c.meta?.kind === "rfb_enrichment_owner_refresh");
      assertEq([oc?.value, oc?.meta?.fields_written, oc?.meta?.agent_ids], [3, { about: 2, description: 2, categories: 2 }, ["n-fill", "n-auto", "n-own"]], "n4: its own envelope claim");
      // The next night: automatic is due again, fill_empty has nothing left to fill.
      const r2 = await job.runRfbEnrichmentNightly({ apply: true, trigger: "manual", now: new Date("2026-10-13T00:10:00Z"), deps: deps([]) });
      const o2 = r2.owner_refresh!;
      assertEq(o2.rows.map((x) => [x.agent_id, x.mode, x.outcome]), [["n-auto", "automatic", "unchanged"]], "n5: next night — automatic is refreshed again («hver natt»), nothing written when the page says the same");
      assertEq(o2.skipped_before_selection.nothing_to_fill, 2, "n5: … the filled fill_empty profiles have nothing left to fill");
    });

    // ── (e) the extractor, limited and planned ─────────────────────────────
    await withDb("e", async () => {
      setEnv(ON);
      const row = (id: string, fields: Array<"about" | "description" | "categories">) => ({ id, name: id, homepage: `https://${id}.example.no`, mode: "fill_empty" as const, fields });
      const opts = (fetchImpl: typeof fetch) => ({ deadlineAt: Date.now() + 30_000, runId: "run-e", deps: { aboutJudges: approveJudges, fetchImpl } });
      // Limited to categories: no about judge call, only categories written.
      seed("e-cat", { owned: true, url: "https://e-cat.example.no", description: "", categories: "[]", k: { website: "https://e-cat.example.no", about: "Eierens tekst.", curated_fields: JSON.stringify({ about: { by: "owner", locked_at: "2026-10-30T00:00:00.000Z" } }) } });
      judgeCalls = 0;
      const c1 = await orf.refreshOwnedProfile(db, row("e-cat", ["categories"]), opts(pageFetch));
      assertEq([c1.outcome, c1.written, judgeCalls], ["written", ["categories"], 0], "e1: planOnlyFields — limited to categories: no about judge is called, only categories are written");
      assertEq([kn("e-cat").about, ag("e-cat").description], ["Eierens tekst.", ""], "e1: about/description untouched");
      // The route without the option is unchanged: a dry run returns no planned_writes.
      const ak = require("../routes/admin-knowledge") as typeof import("../routes/admin-knowledge");
      const plain = await ak.refreshHomepageContent(db, ak.selectHomepageContentRefreshTargetsByIds(db, ["e-cat"], 1), { dryRun: true, fetchImpl: pageFetch, aboutJudges: approveJudges });
      assertTrue(!("planned_writes" in plain), "e2: without planOnlyFields the result has no planned_writes (every caller today unchanged)");
      const fetchedBefore = fetched.length;
      let thrown: unknown = null;
      try {
        await ak.refreshHomepageContent(db, ak.selectHomepageContentRefreshTargetsByIds(db, ["e-cat"], 1), { dryRun: false, planOnlyFields: ["categories"], fetchImpl: pageFetch, aboutJudges: approveJudges } as any);
      } catch (err) {
        thrown = err;
      }
      assertTrue(thrown instanceof Error && /only allowed in a dry run/.test((thrown as Error).message), "e2: planOnlyFields without dryRun throws (never a silent apply run)");
      assertEq(fetched.length, fetchedBefore, "e2: … before anything is fetched");
      // A dead site: fetch_failed, stamped by the caller, no parking bookkeeping.
      seed("e-dead", { owned: true, url: "https://e-dead.example.no", categories: "[]", k: { website: "https://e-dead.example.no", about: "" } });
      const dead = (async () => new Response("gone", { status: 404 })) as unknown as typeof fetch;
      const d = await orf.refreshOwnedProfile(db, row("e-dead", ["about", "description", "categories"]), opts(dead));
      const book = db.prepare(`SELECT homepage_fetch_attempts, homepage_unreachable_since, homepage_content_checked_at FROM agent_knowledge WHERE agent_id = 'e-dead'`).get() as any;
      assertEq([d.outcome, d.written, d.transient ?? false], ["fetch_failed", [], false], "e3: a dead homepage → fetch_failed (a real outcome), nothing written");
      assertEq([book.homepage_fetch_attempts ?? 0, book.homepage_unreachable_since, book.homepage_content_checked_at], [0, null, null], "e3: no fetch / parking / rotation bookkeeping on an owned profile");
      const flaky = (async () => new Response("busy", { status: 503 })) as unknown as typeof fetch;
      const fl = await orf.refreshOwnedProfile(db, row("e-dead", ["about", "description", "categories"]), opts(flaky));
      assertEq([fl.outcome, fl.transient], ["fetch_failed", true], "e3: a transient failure (503) is not a real outcome — not stamped, tried again next night");
      // A hijacked domain: nothing at all.
      seed("e-spam", { owned: true, url: "https://e-spam.example.no", categories: "[]", k: { website: "https://e-spam.example.no", about: "" } });
      const SPAM = `<html><head><title>Casino bonus</title><meta name="description" content="Beste online casino bonus, gratis spinn og spilleautomater med jackpot hver dag."></head><body><p>Online casino bonus, gratis spinn, spilleautomater, poker og betting med de beste oddsene. Registrer deg for casino bonus.</p><p>Vi selger grønnsaker.</p></body></html>`;
      const spam = (async () => new Response(SPAM, { status: 200, headers: { "content-type": "text/html" } })) as unknown as typeof fetch;
      const sp = await orf.refreshOwnedProfile(db, row("e-spam", ["about", "description", "categories"]), opts(spam));
      assertEq([sp.outcome, sp.written, kn("e-spam").about, ag("e-spam").categories], ["hijacked", [], "", "[]"], "e4: a gambling / theme-spam page → hijacked, nothing written (not even categories)");
      // A write that fails (an unreadable JSON column makes upsertKnowledge's strict read throw): rolled back, a real outcome.
      seed("e-bad", { owned: true, url: "https://e-bad.example.no", categories: "[]", k: { website: "https://e-bad.example.no", about: "", products: "{not json" } });
      const bad = await orf.refreshOwnedProfile(db, row("e-bad", ["about", "description", "categories"]), opts(pageFetch));
      assertEq([bad.outcome, bad.transient ?? false, bad.written, ag("e-bad").categories, ag("e-bad").description], ["write_failed", false, [], "[]", ""],
        "e5: a failed write → write_failed (a real outcome, not transient), the transaction rolled back (categories untouched too)");
      // An about judge that cannot answer (API outage): undecided → transient; the categories are still written.
      seed("e-outage", { owned: true, url: "https://e-outage.example.no", categories: "[]", k: { website: "https://e-outage.example.no", about: "" } });
      const outageJudges = { ...approveJudges, facts: async () => ({ ok: false, failure: "error", reason: "stub outage" }) } as any;
      const ou = await orf.refreshOwnedProfile(db, row("e-outage", ["about", "description", "categories"]), { ...opts(pageFetch), deps: { aboutJudges: outageJudges, fetchImpl: pageFetch } });
      assertEq([ou.outcome, ou.transient, ou.written, kn("e-outage").about], ["written", true, ["categories"], ""], "e6: judge unavailable → about undecided (transient: tried again next night), categories written");
      seed("e-outage2", { owned: true, url: "https://e-outage2.example.no", categories: '["meat"]', k: { website: "https://e-outage2.example.no", about: "" } });
      const ou2 = await orf.refreshOwnedProfile(db, row("e-outage2", ["about", "description"]), { ...opts(pageFetch), deps: { aboutJudges: outageJudges, fetchImpl: pageFetch } });
      assertEq([ou2.outcome, ou2.transient], ["judge_unavailable", true], "e6: … with nothing else to write: judge_unavailable, transient (not «unchanged»)");
      // Review N10 / N11: a non-fetch failure and an extractor throw are real outcomes (not transient).
      const result = (errors: Array<{ agent_id: string; error: string }>) => ({
        scanned: 1, by_field: {}, changed: [], skipped_curated: [], skipped_unsubstantiated: [], errors, parked_now: [],
        about_reviews: [], about_judge_rejected: 0, about_not_supported: 0, about_not_better: 0, about_judge_unavailable: 0, planned_writes: [],
      });
      const viaRefresh = (refresh: any) => orf.refreshOwnedProfile(db, row("e-cat", ["categories"]), { deadlineAt: Date.now() + 30_000, runId: "run-e", deps: { aboutJudges: approveJudges, refresh } });
      const nf = await viaRefresh(async () => result([{ agent_id: "e-cat", error: "unexpected: provenance column unreadable" }]));
      assertEq([nf.outcome, nf.transient ?? false], ["failed", false], "e7 (N10): a non-fetch error → failed, a real outcome (stamped)");
      const tf = await viaRefresh(async () => result([{ agent_id: "e-cat", error: "fetch_failed:timeout (transient) for https://e-cat.example.no" }]));
      assertEq([tf.outcome, tf.transient], ["fetch_failed", true], "e7: a transient fetch failure stays transient");
      const pf = await viaRefresh(async () => result([{ agent_id: "e-cat", error: "fetch_failed:http_404 (permanent) for https://e-cat.example.no" }]));
      assertEq([pf.outcome, pf.transient ?? false], ["fetch_failed", false], "e7: a permanent fetch failure is a real outcome");
      const th = await viaRefresh(async () => { throw new Error("extractor blew up"); });
      assertEq([th.outcome, th.transient ?? false, /extractor blew up/.test(th.detail ?? "")], ["failed", false, true], "e7 (N11): an extractor throw → failed, a real outcome (stamped)");
    });

    // ── (x) failures are stamped, transient outcomes are not (review M19, probe 2) ──
    await withDb("x", async () => {
      setEnv({ RFB_ENRICHMENT_NIGHTLY_ENABLED: "1", ...ON });
      // A fill_empty and an automatic owner whose writes always fail (unreadable JSON column).
      for (const id of ["x-bad", "x-bad-auto"]) {
        seed(id, { owned: true, url: `https://${id}.example.no`, description: "", categories: "[]", k: { website: `https://${id}.example.no`, about: "", products: "{not json" } });
      }
      choose("x-bad-auto", "automatic");
      // A transiently failing homepage (503).
      seed("x-flaky", { owned: true, url: "https://x-flaky.example.no", description: "", categories: "[]", k: { website: "https://x-flaky.example.no", about: "" } });
      const fetchX = (async (url: any) => (String(url).includes("x-flaky") ? new Response("busy", { status: 503 }) : pageFetch(url))) as typeof fetch;
      const nights = ["2026-10-12", "2026-10-13", "2026-10-14"];
      const seen: Array<{ rows: string[]; judges: number; stamped: Record<string, string> }> = [];
      for (const day of nights) {
        judgeCalls = 0;
        const r = await job.runRfbEnrichmentNightly({ apply: true, trigger: "manual", now: new Date(`${day}T00:10:00Z`), deps: { ...deps([]), ownerRefresh: { aboutJudges: approveJudges, fetchImpl: fetchX } } });
        const stamped = Object.fromEntries((db.prepare(`SELECT agent_id, last_outcome FROM rfb_enrichment_nightly_attempts WHERE step = 'owner_refresh'`).all() as any[]).map((x) => [x.agent_id, x.last_outcome]));
        seen.push({ rows: r.owner_refresh!.rows.map((x) => `${x.agent_id}:${x.outcome}`), judges: judgeCalls, stamped });
      }
      assertEq(seen[0].rows, ["x-bad:write_failed", "x-bad-auto:write_failed", "x-flaky:fetch_failed"], "x1: night 1 — two failed writes, one transient fetch failure");
      assertEq(seen[0].stamped, { "x-bad": "write_failed", "x-bad-auto": "write_failed" }, "x1 (M19): the failed writes are stamped; the transient fetch failure is not");
      assertEq([seen[1].rows, seen[2].rows], [["x-flaky:fetch_failed"], ["x-flaky:fetch_failed"]], "x2: nights 2–3 — the failed writes wait (fill_empty window, also for automatic); only the transient one is tried again");
      assertEq([seen[1].judges, seen[2].judges], [0, 0], "x2: no judge call is spent on them again");
    });

    // ── (z) the step loop's catch-all is stamped (review N12); the judge-unavailable streak ──
    await withDb("z", async () => {
      setEnv({ RFB_ENRICHMENT_NIGHTLY_ENABLED: "1", ...ON });
      seed("z-throw", { owned: true, url: "https://z-throw.example.no", description: "", categories: "[]", k: { website: "https://z-throw.example.no", about: "" } });
      // A malformed extractor answer makes refreshOwnedProfile itself throw: the nightly's catch-all.
      const r = await job.runRfbEnrichmentNightly({ apply: true, trigger: "manual", now: NIGHT, deps: { executors: stubExecutors([]), ownerRefresh: { aboutJudges: approveJudges, refresh: (async () => ({})) as any } } });
      assertEq(r.owner_refresh!.rows.map((x) => x.outcome), ["error"], "z1: an unexpected throw in the owner step → outcome error");
      assertEq((db.prepare(`SELECT last_outcome FROM rfb_enrichment_nightly_attempts WHERE step = 'owner_refresh' AND agent_id = 'z-throw'`).get() as any)?.last_outcome, "error",
        "z1 (N12): … stamped (a real outcome, not retried every night)");
    });
    await withDb("z-streak", async () => {
      setEnv({ RFB_ENRICHMENT_NIGHTLY_ENABLED: "1", ...ON });
      // fill_empty, only the about is due; the about judges are down every night.
      seed("z-outage", { owned: true, url: "https://z-outage.example.no", description: "Beskrivelse.", categories: '["meat"]', k: { website: "https://z-outage.example.no", about: "" } });
      const outageJudges = { ...approveJudges, facts: async () => ({ ok: false, failure: "error", reason: "stub outage" }) } as any;
      const nightsOut: string[] = [];
      for (const day of ["2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15"]) {
        const r = await job.runRfbEnrichmentNightly({ apply: true, trigger: "manual", now: new Date(`${day}T00:10:00Z`), deps: { executors: stubExecutors([]), ownerRefresh: { aboutJudges: outageJudges, fetchImpl: pageFetch } } });
        const st = db.prepare(`SELECT last_outcome FROM rfb_enrichment_nightly_attempts WHERE step = 'owner_refresh' AND agent_id = 'z-outage'`).get() as any;
        nightsOut.push(`${r.owner_refresh!.rows.map((x) => x.outcome).join(",") || "-"}|${st?.last_outcome ?? "-"}|${r.owner_refresh!.skipped_before_selection.retry_window ?? 0}`);
      }
      assertEq(nightsOut, [
        "judge_unavailable|judge_unavailable_1|0", "judge_unavailable|judge_unavailable_2|0", "judge_unavailable|judge_unavailable_3|0", "-|judge_unavailable_3|1",
      ], "z2 (item 4): an unavailable judge is retried the next night, and after three nights in a row it waits the fill_empty window");
      assertEq(orf.judgeUnavailableStamp("written"), "judge_unavailable_1", "z2: a success breaks the streak");
    });

    // ── (y) step 6's own per-row stops and reservation (review M24, M25, M33) ──
    const stepSixStops = async (label: string, jumpTo: Date, want: string) => {
      await withDb(label, async () => {
        setEnv({ RFB_ENRICHMENT_NIGHTLY_ENABLED: "1", ...ON });
        seedNight();
        let clockNow = new Date(NIGHT.getTime());
        const jumping = (async (url: any) => { clockNow = jumpTo; return pageFetch(url); }) as typeof fetch;
        const r = await job.runRfbEnrichmentNightly({
          apply: true, trigger: "manual", now: NIGHT,
          deps: { executors: stubExecutors([]), clock: () => clockNow, ownerRefresh: { aboutJudges: approveJudges, fetchImpl: jumping } },
        });
        const o = r.owner_refresh!;
        assertEq([o.selected, o.attempted, o.stopped_reason], [3, 1, want], `${label}: the clock passes ${want === "forbidden_hour" ? "08:00Z" : "the run deadline"} during the first owner row → step 6 stops before the next (${want})`);
      });
    };
    await stepSixStops("y1 (M24)", new Date("2026-10-12T00:45:00Z"), "time_budget");
    await stepSixStops("y2 (M25)", new Date("2026-10-12T08:01:00Z"), "forbidden_hour");
    await withDb("y3 (M33)", async () => {
      setEnv({ RFB_ENRICHMENT_NIGHTLY_ENABLED: "1", ...ON, RFB_ENRICHMENT_CAP_OWNER_REFRESH: "1" });
      seedNight();
      // 2.5 s left of the run: the owner row's refresh is cut off by its deadline while the page hangs.
      const nearEnd = new Date(NIGHT.getTime() + 20 * 60_000 - 2_500);
      const hanging = (async () => new Promise<Response>((res) => setTimeout(() => res(new Response(PAGE, { status: 200, headers: { "content-type": "text/html" } })), 4_000))) as unknown as typeof fetch;
      const r = await job.runRfbEnrichmentNightly({
        apply: true, trigger: "manual", now: NIGHT,
        deps: { executors: stubExecutors([]), clock: () => nearEnd, ownerRefresh: { aboutJudges: approveJudges, fetchImpl: hanging } },
      });
      const o = r.owner_refresh!;
      assertEq([o.rows.map((x) => [x.agent_id, x.outcome])], [[["n-fill", "timeout"]]], "y3: the owner row times out");
      assertEq(job.readRfbEnrichmentNightLlmCounter(db, NIGHT), 3, "y3 (M33): the timed-out row keeps its reservation (3 judge calls) on the night's counter — they may still land");
      assertEq((db.prepare(`SELECT COUNT(*) AS n FROM rfb_enrichment_nightly_attempts WHERE step = 'owner_refresh'`).get() as any).n, 0, "y3: a timeout is not stamped");
    });

    // ── (g) guards ─────────────────────────────────────────────────────────
    await withDb("g-llm", async () => {
      // A cap of 2: a profile that needs the three judges waits; categories-only runs.
      setEnv({ RFB_ENRICHMENT_NIGHTLY_ENABLED: "1", ...ON, RFB_ENRICHMENT_LLM_CAP: "2" });
      seedNight();
      judgeCalls = 0;
      const r = await job.runRfbEnrichmentNightly({ apply: true, trigger: "manual", now: NIGHT, deps: deps([]) });
      const o = r.owner_refresh!;
      assertEq([o.outcomes.skipped_llm_cap, o.rows.map((x) => x.agent_id), judgeCalls], [2, ["n-own"], 0], "g1: over the LLM cap, the two profiles that need the judges wait; the categories-only one runs; no judge call");
      const stamped = db.prepare(`SELECT agent_id FROM rfb_enrichment_nightly_attempts WHERE step = 'owner_refresh' ORDER BY agent_id`).all().map((x: any) => x.agent_id);
      assertEq(stamped, ["n-own"], "g1: the waiting profiles are not stamped (tried again another night)");
      assertTrue(r.llm.cap_reached, "g1: the run reports the cap as reached");
    });
    await withDb("g-time", async () => {
      setEnv({ RFB_ENRICHMENT_NIGHTLY_ENABLED: "1", ...ON, RFB_ENRICHMENT_MAX_RUNTIME_MINUTES: "1" });
      seedNight();
      const late = new Date(NIGHT.getTime() + 5 * 60_000);
      const r = await job.runRfbEnrichmentNightly({ apply: true, trigger: "manual", now: NIGHT, deps: { ...deps([]), clock: () => late } });
      assertEq([r.owner_refresh?.skipped_reason, r.owner_refresh?.attempted], ["time_budget", 0], "g2: past the run deadline the owner step does not start");
      assertEq(audits("n-fill").length, 0, "g2: nothing written");
    });
    await withDb("g-pause", async () => {
      setEnv({ RFB_ENRICHMENT_NIGHTLY_ENABLED: "1", ...ON });
      seedNight();
      pause.setEnrichmentWritePause(db, { vertical: "rfb", enabled: true, reason: "test" }, "test");
      fetched.length = 0;
      const r = await job.runRfbEnrichmentNightly({ apply: true, trigger: "manual", now: NIGHT, deps: deps([]) });
      assertEq([r.owner_refresh?.skipped_reason ?? r.owner_refresh?.stopped_reason, r.owner_refresh?.attempted, fetched.length], ["enrichment_write_paused", 0, 0], "g3: the enrichment write-pause stops the owner step before any fetch");
    });

    // ── (p) dry run / preview ──────────────────────────────────────────────
    await withDb("p", async () => {
      setEnv({ RFB_ENRICHMENT_NIGHTLY_ENABLED: "1" });
      seedNight();
      // A hidden owned fixture (like the claim-test fixture): about set, categories empty.
      seed("p-hidden", { owned: true, url: "https://p-hidden.invalid", catalog_hidden: 1, description: "Testprofil.", categories: "[]", k: { about: "Testprofil, ikke en ekte gård." } });
      const off = await job.buildRfbEnrichmentPreview(db, NIGHT);
      assertTrue(!("owner_refresh" in off), "p1: flag off — the preview is unchanged (no owner_refresh)");
      setEnv({ RFB_ENRICHMENT_NIGHTLY_ENABLED: "1", ...ON });
      const pv = await job.buildRfbEnrichmentPreview(db, NIGHT);
      const rows = Object.fromEntries((pv.owner_refresh?.rows ?? []).map((x) => [x.agent_id, [x.mode, x.fields, x.selected]]));
      assertEq(rows["n-fill"], ["fill_empty", ["about", "description", "categories"], true], "p2: the preview shows an owner without a stored choice as fill_empty with its fields");
      assertEq(rows["n-auto"], ["automatic", ["about", "description"], true], "p2: … and an automatic owner");
      assertEq(rows["p-hidden"], ["fill_empty", ["categories"], true], "p2: a hidden owned fixture is included as fill_empty (AC6's dry run)");
      assertEq([rows["n-never"], rows["n-fb"]], [undefined, undefined], "p2: never / social host are not in it");
      const dry = await job.runRfbEnrichmentNightly({ apply: false, trigger: "manual", now: NIGHT });
      assertEq(dry.preview?.owner_refresh?.selected_ids.includes("p-hidden"), true, "p3: the dry run (POST …/run without apply) carries the same owner preview");
      assertEq([audits("n-fill").length, (db.prepare(`SELECT COUNT(*) AS n FROM rfb_enrichment_nightly_attempts`).get() as any).n], [0, 0], "p3: the dry run writes nothing");
    });

    // ── (c) AC4: the owner-portal card ─────────────────────────────────────
    await withDb("c", async () => {
      setEnv({});
      for (const m of ["../routes/owner-portal", "../routes/owner-features"]) { try { delete require.cache[require.resolve(m)]; } catch { /* not loaded */ } }
      const portalMod = require("../routes/owner-portal") as typeof import("../routes/owner-portal");
      const featuresMod = require("../routes/owner-features") as typeof import("../routes/owner-features");
      seed("c-owner", { owned: true, k: { website: "https://c-owner.example.no", about: "Liten gård.", email: "post@c-owner.example.no" } });
      seed("c-pilot", { owned: true, k: { website: "https://c-pilot.example.no", about: "Liten gård.", email: "post@c-pilot.example.no" } });
      seed("c-free", { owned: false, k: { website: "https://c-free.example.no", about: "Liten gård.", email: "post@c-free.example.no" } });
      const tokens: Record<string, string> = {};
      for (const id of ["c-owner", "c-pilot", "c-free"]) {
        tokens[id] = `tok-${id}`;
        db.prepare("INSERT INTO magic_links (id, email, token, agent_id, used, created_at, expires_at) VALUES (?, ?, ?, ?, 1, ?, ?)")
          .run(`ml-${id}`, `post@${id}.example.no`, tokens[id], id, new Date().toISOString(), new Date(Date.now() + 86_400_000).toISOString());
      }
      const H = {
        portal: findRouteHandler(portalMod.default, "/eier/:agentId/portal", "get"),
        save: findRouteHandler(portalMod.default, "/eier/:agentId/hold-oppdatert", "post"),
        page: findRouteHandler(featuresMod.default, "/eier/:agentId/valg", "get"),
        sett: findRouteHandler(featuresMod.default, "/eier/:agentId/valg/sett", "post"),
      };
      const portal = async (id: string) => String((await invoke(H.portal, makeReq({ params: { agentId: id }, token: tokens[id] }))).body ?? "");
      const save = (id: string, value: string, o: { token?: string | null; headers?: Record<string, string> } = {}) =>
        invoke(H.save, makeReq({ params: { agentId: id }, body: { value }, token: o.token === null ? undefined : o.token ?? tokens[id], headers: o.headers }));
      const settings = () => (db.prepare(`SELECT subject_id, key, value_json, set_by FROM owner_feature_settings ORDER BY subject_id`).all() as any[]);
      const featureAudits = () => (db.prepare(`SELECT subject_id, key, new_json, actor FROM owner_feature_audit ORDER BY id`).all() as any[]);
      const checked = (html: string) => (html.match(/<input type="radio" name="value" value="([a-z_]+)" checked>/) || [])[1] ?? null;
      process.env.OWNER_FEATURES_ALLOWED_SUBJECTS = "rfb:c-pilot";

      // Flag off: no card, POST 404, nothing written; «Mine valg» keeps it in «Planlagt».
      const offHtml = await portal("c-owner");
      assertTrue(offHtml.includes("Profilinformasjon") && !offHtml.includes('id="hold-oppdatert"'), "c1 (AC4): flag off — the portal has no card");
      const offPost = await save("c-owner", "automatic");
      assertEq([offPost.status, settings().length, featureAudits().length], [404, 0, 0], "c1 (AC4): flag off — the POST answers 404 and nothing is written");
      const offPage = String((await invoke(H.page, makeReq({ params: { agentId: "c-pilot" }, token: tokens["c-pilot"] }))).body ?? "");
      assertTrue(offPage.includes('data-planned-key="auto.updates"') && !offPage.includes('id="mv-f-auto-updates"'), "c1: flag off — «Mine valg» shows it in «Planlagt», with no control (as today)");
      const OLD_G = "Plattformen skriver aldri over det du har skrevet. Ny informasjon blir forslag.";
      const NEW_G = "Plattformen skriver aldri over det du har skrevet.";
      assertTrue(offPage.includes(`<p class="mv-desc">${OLD_G}</p>`), "c1 (guarantee): flag off — «Mine valg» shows the guarantee text as before");
      const apiGet = findRouteHandler(featuresMod.default, "/api/owner/:id/features", "get");
      const api = async () => {
        const r = await invoke(apiGet, makeReq({ params: { id: "c-pilot" }, token: tokens["c-pilot"] }));
        const byKey = Object.fromEntries((r.body?.features ?? []).map((f: any) => [f.key, f]));
        return { status: r.status, au: byKey["auto.updates"], g: byKey["auto.guarantee"] };
      };
      const apiOff = await api();
      assertEq([apiOff.status, apiOff.au?.status, apiOff.au?.value, apiOff.au?.default, (apiOff.au?.options ?? []).map((o: any) => o.value), apiOff.au?.since, apiOff.au?.source],
        [200, "coming_soon", "suggest", "suggest", ["suggest", "fill_empty", "never", "automatic"], "2026-10-27", "default"],
        "c1 (N23): flag off — GET /api/owner/:id/features answers auto.updates exactly as before the PR (status, value, default, four options, since)");
      assertEq(apiOff.g?.description?.no, OLD_G, "c1 (guarantee): flag off — the owner API's guarantee text as before");

      // Flag on: the card for a verified owner NOT on the allowlist.
      process.env.OWNER_AUTO_UPDATES_ENABLED = "1";
      const html = await portal("c-owner");
      const card = (html.match(/<div class="ep-card" id="hold-oppdatert">([\s\S]*?)<\/form>/) || ["", ""])[1];
      assertTrue(card.length > 0, "c2 (AC4): flag on — the card is shown to a verified owner who is not on the «Mine valg» allowlist");
      for (const text of ["Hjelp med å holde profilen oppdatert", "Oppdatering fra nettsiden din og offentlige kilder", "Hva som skjer når vi finner ny informasjon om deg.", "Fyll tomme felt selv", "Oppdateres automatisk hver natt", "Aldri", "Det du skriver selv, overskrives aldri"]) {
        assertTrue(card.includes(text), `c2: the card carries the catalog text «${text}»`);
      }
      assertTrue(!card.includes("Foreslå til meg"), "c2: «Foreslå til meg» is not offered");
      assertTrue(card.includes(`Det du skriver selv, overskrives aldri<br>${NEW_G}</p>`) && !card.includes("Ny informasjon blir forslag"), "c2 (guarantee): the card shows the guarantee with the flag-on text");
      const apiOn = await api();
      assertEq([apiOn.au?.status, apiOn.au?.value, apiOn.au?.default, (apiOn.au?.options ?? []).map((o: any) => o.value), apiOn.au?.since],
        ["live", "fill_empty", "fill_empty", ["fill_empty", "automatic", "never"], "2026-11-01"], "c2 (N23): flag on — the owner API answers the live entry");
      assertEq(apiOn.g?.description, { no: NEW_G, en: "The platform never overwrites what you have written." }, "c2 (guarantee): flag on — the owner API's guarantee text (NO + EN)");
      const onPage = String((await invoke(H.page, makeReq({ params: { agentId: "c-pilot" }, token: tokens["c-pilot"] }))).body ?? "");
      assertTrue(onPage.includes(`<p class="mv-desc">${NEW_G}</p>`) && !onPage.includes(OLD_G), "c2 (guarantee): flag on — «Mine valg» shows the new guarantee text");
      assertEq([...card.matchAll(/name="value" value="([a-z_]+)"/g)].map((m) => m[1]), ["fill_empty", "automatic", "never"], "c2: three options, in order");
      assertEq(checked(card), "fill_empty", "c2: the default (fill_empty) is selected");
      assertTrue(!(await portal("c-free")).includes('id="hold-oppdatert"'), "c2: no card for a session on a profile without a verified owner");

      // Save.
      const ok = await save("c-owner", "automatic");
      assertEq([ok.status, ok.body?.__redirect], [303, "/eier/c-owner/portal?status=saved#hold-oppdatert"], "c3 (AC4): save → 303 back to the card with the existing «lagret» notice");
      assertEq(settings().map((x) => [x.subject_id, x.key, x.value_json, x.set_by]), [["c-owner", "auto.updates", '"automatic"', "owner"]], "c3 (AC4): stored in owner_feature_settings (the «Mine valg» storage), set_by owner");
      assertEq(featureAudits().map((x) => [x.subject_id, x.key, x.new_json, x.actor]), [["c-owner", "auto.updates", '"automatic"', "owner"]], "c3: one row in the «Mine valg» change log");
      assertEq(checked(await portal("c-owner")), "automatic", "c3: the card shows the saved choice");
      assertEq(rs.resolveOwnerFeature("rfb", "c-owner", "auto.updates", { db }).value, "automatic", "c3 (AC4): the «Mine valg» lookup has the same value");
      const ownerMode = orf.ownerRefreshModes(db, ["c-owner"]).get("c-owner");
      assertEq(ownerMode, "automatic", "c3: … and the owner refresh reads it");

      // «Mine valg» shows the same value — both ways (allowlisted owner).
      assertEq((await save("c-pilot", "never")).status, 303, "c4: the pilot owner saves «Aldri» in the portal card");
      const page = String((await invoke(H.page, makeReq({ params: { agentId: "c-pilot" }, token: tokens["c-pilot"] }))).body ?? "");
      const sel = (page.match(/<select id="mv-f-auto-updates" name="value">([\s\S]*?)<\/select>/) || ["", ""])[1];
      assertTrue(/<option value="never" selected>Aldri<\/option>/.test(sel), "c4 (AC4): «Mine valg» shows the value saved in the portal card");
      assertTrue(!sel.includes("suggest"), "c4: «Mine valg» does not offer the hidden option either");
      featuresMod.__resetOwnerFeaturesRateLimitForTesting();
      const viaPage = await invoke(H.sett, makeReq({ params: { agentId: "c-pilot" }, body: { key: "auto.updates", value: "fill_empty" }, token: tokens["c-pilot"] }));
      assertEq(viaPage.status, 303, "c4: saving «Fyll tomme felt selv» in «Mine valg»");
      assertEq(checked(await portal("c-pilot")), "fill_empty", "c4 (AC4): … the portal card shows it");

      // Refusals: nothing written.
      const before = JSON.stringify([settings(), featureAudits()]);
      const hidden = await save("c-owner", "suggest");
      assertEq(hidden.body?.__redirect, "/eier/c-owner/portal?status=error#hold-oppdatert", "c5: the hidden option → the existing error notice");
      const junk = await save("c-owner", "alltid");
      assertEq(junk.body?.__redirect, "/eier/c-owner/portal?status=error#hold-oppdatert", "c5: an unknown value → error");
      const xs = await save("c-owner", "never", { headers: { origin: "https://evil.example" } });
      assertEq(xs.status, 403, "c5: a cross-site POST → 403 (the portal's write guard)");
      const anon = await save("c-owner", "never", { token: null });
      assertEq([anon.status, anon.body?.__redirect], [303, "/eier/c-owner"], "c5: no session → back to the login");
      const notOwner = await save("c-free", "never");
      assertEq(notOwner.status, 403, "c5: a session on a profile without a verified owner → 403");
      const other = await save("c-owner", "never", { token: tokens["c-pilot"] });
      assertEq(other.status, 403, "c5: another profile's session → 403");
      assertEq(JSON.stringify([settings(), featureAudits()]), before, "c5: none of them wrote anything");

      // c6 — the card and the POST follow the refresh's vertical rule (COALESCE(vertical_id, 'rfb') = 'rfb').
      seed("c-other-vertical", { owned: true, k: { website: "https://c-other-vertical.example.no", about: "Liten gård.", email: "post@c-other-vertical.example.no" } });
      db.prepare(`UPDATE agents SET vertical_id = 'opplevagent' WHERE id = 'c-other-vertical'`).run();
      tokens["c-other-vertical"] = "tok-c-other-vertical";
      db.prepare("INSERT INTO magic_links (id, email, token, agent_id, used, created_at, expires_at) VALUES ('ml-c-ov', 'post@c-other-vertical.example.no', 'tok-c-other-vertical', 'c-other-vertical', 1, ?, ?)")
        .run(new Date().toISOString(), new Date(Date.now() + 86_400_000).toISOString());
      const ovHtml = await portal("c-other-vertical");
      assertTrue(ovHtml.includes("Profilinformasjon") && !ovHtml.includes('id="hold-oppdatert"'), "c6: no card for a verified owner of a profile outside the RFB vertical");
      const ovPost = await save("c-other-vertical", "automatic");
      assertEq([ovPost.status, settings().some((x) => x.subject_id === "c-other-vertical")], [404, false], "c6: … and the POST answers 404 and writes nothing");
      db.prepare(`UPDATE agents SET vertical_id = 'rfb' WHERE id = 'c-other-vertical'`).run();
      assertTrue((await portal("c-other-vertical")).includes('id="hold-oppdatert"'), "c6: the same profile in the rfb vertical gets the card (the gate discriminates)");
    });

    // ── (t) /for-produsenter follows the flag (sentences left out, no new text) ──
    {
      const fp = require("../routes/rfb-for-produsenter") as typeof import("../routes/rfb-for-produsenter");
      const text = (lang: "no" | "en", on: boolean) => {
        setEnv(on ? ON : {});
        const facts = fp.currentForProdusenterFacts();
        return { faq: JSON.stringify(fp.buildForProdusenterFaqLd(lang, "https://rettfrabonden.com/for-produsenter", facts)), live: fp.liveRfbOwnerChoices(facts).map((e) => e.key) };
      };
      const offNo = text("no", false);
      const onNo = text("no", true);
      const onEn = text("en", true);
      const offEn = text("en", false);
      assertTrue(offNo.faq.includes("Et valg for hvordan oppdateringene skal skje, er planlagt.") && offNo.faq.includes("blir den et forslag"), "t1: flag off — the page is unchanged");
      assertTrue(offEn.faq.includes("A choice of how updates should happen is planned.") && offEn.faq.includes("it becomes a suggestion"), "t1: flag off — EN unchanged");
      assertTrue(!offNo.live.includes("auto.updates"), "t1: flag off — auto.updates is not listed as available");
      assertTrue(!onNo.faq.includes("Et valg for hvordan oppdateringene skal skje") && !onNo.faq.includes("blir den et forslag"), "t2: flag on — the «planlagt» / «forslag» sentences are left out");
      assertTrue(onNo.faq.includes("Det du skriver selv, overskrives aldri.") && onNo.faq.includes("Det du har skrevet selv, overskrives aldri."), "t2: … the guarantee sentences stay");
      assertTrue(!onEn.faq.includes("A choice of how updates should happen") && !onEn.faq.includes("becomes a suggestion"), "t2: EN too");
      assertTrue(onNo.live.includes("auto.updates"), "t2: flag on — auto.updates is listed among today's choices (catalog text)");
      const guaranteeText = (on: boolean) => {
        setEnv(on ? ON : {});
        return fp.liveRfbOwnerChoices(fp.currentForProdusenterFacts()).find((e) => e.key === "auto.guarantee")?.description.no;
      };
      assertEq([guaranteeText(false), guaranteeText(true)], ["Plattformen skriver aldri over det du har skrevet. Ny informasjon blir forslag.", "Plattformen skriver aldri over det du har skrevet."],
        "t3 (guarantee): /for-produsenter lists the guarantee with the text for the flag's state");
      setEnv({});
    }

    // ── (s) the switch probe's choice evaluation + reader ──────────────────
    await withDb("s", async () => {
      const ev = probe.evaluateChoiceObservation;
      assertEq(ev({ endpoints: { fill_empty: true, automatic: false, never: false } }, "fill_empty").pass, true, "s1: exactly the written option's endpoint on → PASS");
      assertEq(ev({ endpoints: { fill_empty: true, automatic: true, never: false } }, "fill_empty").pass, false, "s1: another option's endpoint on too → FAIL");
      assertEq(ev({ endpoints: { fill_empty: false, automatic: false, never: true } }, "automatic").pass, false, "s1: the wrong option → FAIL");
      setEnv(ON);
      seed("s-fx", { owned: true, k: { about: "" } });
      const reader = probe.defaultSwitchProbeReaders()["auto.updates × job:rfb_enrichment_nightly"];
      assertTrue(!!reader?.sync, "s2: the probe has a (sync) reader for auto.updates × job:rfb_enrichment_nightly");
      const rc: any = { db, env: process.env, fixture: { id: "s-fx" }, adminKey: "", created: new Map() };
      assertEq(reader!.sync!(rc).endpoints, { fill_empty: true, automatic: false, never: false }, "s2: default → fill_empty");
      choose("s-fx", "never");
      assertEq(reader!.sync!(rc).endpoints, { fill_empty: false, automatic: false, never: true }, "s2: never → skipped");
      setEnv({});
      choose("s-fx", "automatic");
      assertEq(reader!.sync!({ ...rc, env: {} }).endpoints, { fill_empty: false, automatic: false, never: true }, "s2: flag off → the owner refresh does not run (never)");
      assertEq(probe.SWITCH_PROBE_FLAG_DEPENDENCIES["auto.updates × job:rfb_enrichment_nightly"], undefined,
        "s3: no flag dependency — with the flag off the probe checks auto.updates as a planned entry (admin-owner-features-switch-probe flags-10/11)");
    });
  } finally {
    console.log = prevLog;
    (globalThis as any).fetch = prevFetch;
    for (const k of ENV_KEYS) {
      if (prevEnv[k] === undefined) delete process.env[k];
      else process.env[k] = prevEnv[k];
    }
  }

  return { passed, failed, failures };

  // ── route harness (handlers pulled off the router stack) ──────────────────
  function findRouteHandler(router: any, path: string, method: "get" | "post" | "put"): Function {
    const layer = (router.stack as any[]).find((l: any) => l.route && l.route.path === path && l.route.methods?.[method]);
    if (!layer) throw new Error(`route not found: ${method.toUpperCase()} ${path}`);
    return layer.route.stack[layer.route.stack.length - 1].handle;
  }
  function makeReq(o: { params?: Record<string, string>; body?: any; query?: Record<string, string>; token?: string; headers?: Record<string, string> }): any {
    const headers: Record<string, string> = { host: "rettfrabonden.com", ...(o.headers || {}) };
    if (o.token) headers.authorization = `Bearer ${o.token}`;
    return {
      method: "GET", url: "/", path: "/", originalUrl: "/",
      params: o.params || {}, body: o.body, query: o.query || {}, headers, cookies: {},
      ip: "127.0.0.1", lang: "no", protocol: "https", hostname: "rettfrabonden.com",
      get(name: string) { return headers[name.toLowerCase()]; },
    };
  }
  function invoke(handler: Function, req: any): Promise<{ status: number; body: any }> {
    return new Promise((resolve) => {
      let status = 200;
      let settled = false;
      const settle = (body: any) => { if (!settled) { settled = true; resolve({ status, body }); } };
      const res: any = {
        status(c: number) { status = c; return res; },
        json(p: any) { settle(p); return res; },
        send(p: any) { settle(p); return res; },
        redirect(c: number, loc: string) { status = c; settle({ __redirect: loc }); return res; },
        end() { settle(undefined); return res; },
        header() { return res; }, set() { return res; }, type() { return res; }, cookie() { return res; }, clearCookie() { return res; },
        setHeader() { return res; },
      };
      try {
        const p = handler(req, res, (err?: any) => settle({ __next: true, err: err ? String(err) : undefined }));
        if (p && typeof p.catch === "function") p.catch((err: any) => settle({ __error: String(err) }));
      } catch (err) {
        settle({ __error: String(err) });
      }
    });
  }
}

if (require.main === module) {
  runRfbOwnerRefreshTests({ log: process.argv.includes("--log") }).then((r) => {
    console.info(`\nrfb-owner-refresh: ${r.passed} passed, ${r.failed} failed`);
    for (const f of r.failures) console.info(f);
    process.exit(r.failed ? 1 : 0);
  });
}
