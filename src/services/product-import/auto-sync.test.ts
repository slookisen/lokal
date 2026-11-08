/**
 * auto-sync.test.ts — dev-request 2026-10-21-rfb-produktimport-fra-egen-
 * nettside, Skive 4-1 (weekly product auto-sync from the owner's website,
 * backend only, flag PRODUCT_AUTO_SYNC_ENABLED).
 *
 *   apply   a confirmed product whose price / unit changed → applied,
 *           source 'owner_auto_sync' + new fetchedAt, stock status kept;
 *           unchanged and enrichment products untouched; owner lock set.
 *   new     a new product → staged as a pending candidate of an 'auto_sync'
 *           run only (not on the profile, not in products).
 *   gone    a confirmed product not on the site → catalog row out of stock,
 *           still on the profile and in products.
 *   locks   fetch/extraction failure, > 50 % of confirmed missing, a price
 *           change beyond ±50 % → zero product changes, reason stored.
 *   off     the 3rd consecutive lock sets product_sync_mode 'off'.
 *   reset   a successful run resets the counter, stores success + summary.
 *   skip    is_verified = 0 or mode off → skipped, nothing written.
 *   job     flag off → the tick does nothing and writes nothing; flag on →
 *           one sweep a day in the window (persisted stamp), due profiles
 *           only (≥ 7 days since their last run).
 *
 * Real schema in an in-memory DB swapped in as the getDb() singleton; fake
 * fetch and LLM injected (no network); fixed clock. Env restored in finally.
 * Exported runAutoSyncTests({log}) -> TestSummary; wired into tests/test.ts.
 * Standalone: npx tsx src/services/product-import/auto-sync.test.ts
 */

import Database from "better-sqlite3";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

const SAVED_ENV = ["PRODUCT_AUTO_SYNC_ENABLED", "PRODUCT_IMPORT_ENABLED", "OWNER_LOCK_ENFORCE_WRITES"];
const DAY = 86_400_000;
const T0 = Date.UTC(2026, 10, 2, 3, 15, 0); // a Monday, 03:15 UTC (inside the sweep window)

type FakeRoute = { status?: number; body: string; contentType?: string };
const ROBOTS_OPEN: FakeRoute = { body: "User-agent: *\nDisallow:\n", contentType: "text/plain" };
const ROBOTS_CLOSED: FakeRoute = { body: "User-agent: *\nDisallow: /\n", contentType: "text/plain" };

function shopifySite(host: string, products: Array<{ title: string; handle: string; price?: string; variant?: string }>): Record<string, FakeRoute> {
  return {
    [`https://${host}/robots.txt`]: ROBOTS_OPEN,
    [`https://${host}/products.json?limit=250`]: {
      contentType: "application/json",
      body: JSON.stringify({
        products: products.map((p) => ({
          title: p.title,
          handle: p.handle,
          variants: p.price === undefined ? [] : [{ title: p.variant ?? "Default Title", price: p.price }],
        })),
      }),
    },
  };
}

export async function runAutoSyncTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];
  function assertTrue(cond: boolean, label: string): void {
    if (cond) { passed++; if (log) console.info(`  ok ${label}`); }
    else { failed++; failures.push(`✗ ${label}`); if (log) console.info(`  ✗ ${label}`); }
  }
  function assertEq(actual: unknown, expected: unknown, label: string): void {
    assertTrue(JSON.stringify(actual) === JSON.stringify(expected),
      `${label} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
  }

  const initMod = require("../../database/init") as typeof import("../../database/init");
  const prevDb = initMod.__peekDbForTesting();
  const prevEnv: Record<string, string | undefined> = {};
  for (const k of SAVED_ENV) prevEnv[k] = process.env[k];
  const db = new Database(":memory:");
  db.pragma("foreign_keys = OFF");
  const prevLog = console.log;
  const prevErr = console.error;
  if (!log) { console.log = () => undefined; console.error = () => undefined; }

  try {
    initMod.__setDbForTesting(db as any);
    initMod.__initSchemaForTesting(db as any);
    for (const k of SAVED_ENV) delete process.env[k];
    const as = require("./auto-sync") as typeof import("./auto-sync");
    const robots = require("./robots") as typeof import("./robots");
    const { runProductCatalogSync } = require("../product-catalog-sync") as typeof import("../product-catalog-sync");
    robots.__clearRobotsCacheForTesting();

    const totalChanges = () => (db.prepare("SELECT total_changes() AS n").get() as { n: number }).n;

    // ─── Fixture ───────────────────────────────────────────────────────────
    const addAgent = (id: string, o: { verified: number; products: unknown[]; mode?: "off" | "weekly" | null; blocks?: number }) => {
      db.prepare(
        `INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key,
          categories, tags, skills, capabilities, languages, city, lat, lng,
          trust_score, is_active, is_verified, discovery_count, interaction_count,
          total_interactions, created_at, last_seen_at, claimed_at, vertical_id)
         VALUES (?, ?, 'En liten gård.', 'p', ?, 'https://example.no', 'producer', ?,
          '["meat"]', '[]', '[]', '{}', '["no"]', 'Testby', 59.91, 10.75, 0.7, 1, ?, 0, 0, 0, datetime('now'), datetime('now'),
          '2026-10-01T00:00:00.000Z', 'rfb')`,
      ).run(id, `Gard ${id}`, `post@${id}.example.no`, `key-${id}`, o.verified);
      db.prepare(
        `INSERT INTO agent_knowledge (agent_id, email, website, products, data_source, verification_status, verified_second_line)
         VALUES (?, ?, ?, ?, 'hybrid', 'verified', 0)`,
      ).run(id, `post@${id}.example.no`, `https://${id}.no`, JSON.stringify(o.products));
      if (o.mode !== null) {
        db.prepare(`INSERT INTO product_auto_sync_state (agent_id, product_sync_mode, consecutive_blocks) VALUES (?, ?, ?)`)
          .run(id, o.mode ?? "weekly", o.blocks ?? 0);
      }
    };
    const owner = (name: string, price: string, source = "owner_manual") =>
      ({ name, category: "other", seasonal: false, price, priceUnit: "kr", source, confirmedAt: "2026-10-01T10:00:00.000Z" });

    addAgent("as-ok", {
      verified: 1,
      blocks: 2,
      products: [
        owner("Lammelår", "kr 250/kg"),
        owner("Egg", "kr 55", "owner_import"),
        owner("Honning", "kr 120/stk"),
        owner("Gammel ost", "kr 90"),
        { name: "Pølse", category: "meat", seasonal: false, price: "kr 89" }, // enrichment, not on the site
      ],
    });
    addAgent("as-robots", { verified: 1, products: [owner("Lammelår", "kr 250/kg"), owner("Egg", "kr 55")] });
    addAgent("as-down", { verified: 1, products: [owner("Lammelår", "kr 250/kg")] });
    addAgent("as-missing", { verified: 1, products: [owner("Lammelår", "kr 250/kg"), owner("Egg", "kr 55"), owner("Honning", "kr 120")] });
    addAgent("as-dev", { verified: 1, products: [owner("Lammelår", "kr 250/kg"), owner("Egg", "kr 55")] });
    addAgent("as-unver", { verified: 0, products: [owner("Lammelår", "kr 250/kg")] });
    addAgent("as-off", { verified: 1, mode: "off", products: [owner("Lammelår", "kr 250/kg")] });
    addAgent("as-norow", { verified: 1, mode: null, products: [owner("Lammelår", "kr 250/kg")] });
    runProductCatalogSync(db, {});
    // The owner confirmed stock on Lammelår in the portal (B1): orderable.
    db.prepare(`UPDATE products SET availability = 'in_stock', availability_source = 'producer_dashboard' WHERE agent_id = 'as-ok' AND name_norm = ?`)
      .run((require("../product-catalog-sync") as typeof import("../product-catalog-sync")).normalizeName("Lammelår"));

    const routes: Record<string, FakeRoute> = {
      ...shopifySite("as-ok.no", [
        { title: "Lammelår", handle: "lammelar", price: "289.00", variant: "1 kg" },
        { title: "Egg", handle: "egg", price: "55.00" },
        { title: "Honning", handle: "honning", price: "120.00", variant: "1 kg" },
        { title: "Rabarbrasaft", handle: "rabarbrasaft", price: "59.00" },
      ]),
      "https://as-robots.no/robots.txt": ROBOTS_CLOSED,
      ...shopifySite("as-missing.no", [
        { title: "Lammelår", handle: "lammelar", price: "250.00", variant: "1 kg" },
        { title: "Eplecider", handle: "eplecider", price: "149.00" },
      ]),
      ...shopifySite("as-dev.no", [
        { title: "Lammelår", handle: "lammelar", price: "400.00", variant: "1 kg" },
        { title: "Egg", handle: "egg", price: "60.00" },
      ]),
      ...shopifySite("as-unver.no", [{ title: "Lammelår", handle: "lammelar", price: "260.00", variant: "1 kg" }]),
      ...shopifySite("as-off.no", [{ title: "Lammelår", handle: "lammelar", price: "260.00", variant: "1 kg" }]),
      ...shopifySite("as-norow.no", [{ title: "Lammelår", handle: "lammelar", price: "260.00", variant: "1 kg" }]),
    };
    const fetchCalls: string[] = [];
    const fetchImpl = (async (input: any) => {
      const url = String(typeof input === "string" ? input : input?.url ?? input);
      fetchCalls.push(url);
      if (new URL(url).hostname === "as-down.no") throw new Error("ECONNREFUSED");
      const r = routes[url] ?? { status: 404, body: "<html><body>404</body></html>" };
      return new Response(r.body, { status: r.status ?? 200, headers: { "content-type": r.contentType ?? "text/html; charset=utf-8" } });
    }) as unknown as typeof fetch;
    let llmCalls = 0;
    const llm = async () => { llmCalls++; return { text: "[]" }; };
    let clock = T0;
    const deps = { fetchImpl, llm, now: () => clock, sleep: async () => undefined, hostIntervalMs: 0, profileDelayMs: 0 };

    const productsOf = (id: string) =>
      JSON.parse((db.prepare(`SELECT products FROM agent_knowledge WHERE agent_id = ?`).get(id) as { products: string }).products) as any[];
    const catalogOf = (id: string) =>
      db.prepare(`SELECT name, name_norm, price_nok, unit, availability, availability_source, source FROM products WHERE agent_id = ? ORDER BY name_norm`).all(id) as any[];
    const snapshot = (id: string) => JSON.stringify({
      k: db.prepare(`SELECT products, curated_fields FROM agent_knowledge WHERE agent_id = ?`).get(id),
      p: catalogOf(id),
      c: db.prepare(`SELECT COUNT(*) AS n FROM product_import_candidates WHERE agent_id = ?`).get(id),
    });
    const state = (id: string) => as.readAutoSyncState(id)!;

    // ─── flag off → the job does nothing, writes nothing ───────────────────
    {
      assertEq(as.productAutoSyncEnabled({}), false, "flag: unset = off");
      assertEq(as.productAutoSyncEnabled({ PRODUCT_AUTO_SYNC_ENABLED: "yes" }), false, "flag: junk = off");
      assertEq(as.productAutoSyncEnabled({ PRODUCT_AUTO_SYNC_ENABLED: "1" }), true, "flag: 1 = on");
      const before = totalChanges();
      const t = await as.tickProductAutoSync({ now: new Date(T0), lastRunAt: null }, { ...deps, env: {} });
      assertEq(t.report, null, "flag off: no sweep");
      assertEq(totalChanges(), before, "flag off: nothing written");
      assertEq(fetchCalls.length, 0, "flag off: nothing fetched");
      assertEq(db.prepare(`SELECT COUNT(*) AS n FROM boot_job_state WHERE job = ?`).get(as.AUTO_SYNC_JOB_STATE_KEY), { n: 0 },
        "flag off: no stamp");
    }

    // ─── skipped: is_verified = 0, mode off, no state row ──────────────────
    {
      const before = totalChanges();
      for (const [id, reason] of [["as-unver", "not_verified"], ["as-off", "mode_off"], ["as-norow", "mode_off"]] as const) {
        const r = await as.runAutoSyncForProfile(id, deps);
        assertEq({ status: r.status, reason: (r as any).reason }, { status: "skipped", reason }, `skip: ${id} → ${reason}`);
      }
      assertEq(totalChanges(), before, "skip: nothing written");
      assertEq(fetchCalls.length, 0, "skip: nothing fetched");
      const due = as.dueAutoSyncProfiles(T0);
      assertTrue(!due.includes("as-unver") && !due.includes("as-off") && !due.includes("as-norow"), "skip: not in the due list");
      assertTrue(due.includes("as-ok") && due.includes("as-dev"), "due: verified weekly profiles never run are due");
    }

    // ─── success: price / unit applied, new staged, not found out of stock ─
    {
      const before = productsOf("as-ok");
      const r = await as.runAutoSyncForProfile("as-ok", deps);
      assertEq(r.status, "applied", "apply: run applied");
      const after = productsOf("as-ok");
      const by = (n: string) => after.find((p) => p.name === n);
      assertEq(after.length, before.length, "apply: no product added or removed on the profile");
      assertEq(by("Lammelår")?.price, "kr 289/kg", "apply: changed price applied");
      assertEq(by("Lammelår")?.source, "owner_auto_sync", "apply: changed price → source owner_auto_sync");
      assertEq(by("Lammelår")?.fetchedAt, new Date(T0).toISOString(), "apply: new fetchedAt");
      assertEq(by("Lammelår")?.confirmedAt, "2026-10-01T10:00:00.000Z", "apply: owner's confirmedAt kept");
      assertTrue(typeof by("Lammelår")?.sourceUrl === "string" && by("Lammelår").sourceUrl.startsWith("https://as-ok.no/"), "apply: sourceUrl set");
      assertEq(by("Honning")?.price, "kr 120/kg", "apply: changed unit applied");
      assertEq(by("Honning")?.source, "owner_auto_sync", "apply: changed unit → source owner_auto_sync");
      assertEq(by("Egg"), before.find((p) => p.name === "Egg"), "apply: unchanged product byte-identical");
      assertEq(by("Pølse"), before.find((p) => p.name === "Pølse"), "apply: enrichment product untouched");
      assertEq(by("Gammel ost"), before.find((p) => p.name === "Gammel ost"), "gone: not-found product still on the profile, unchanged");
      assertEq(after.some((p) => p.name === "Rabarbrasaft"), false, "new: not on the profile");

      const cat = catalogOf("as-ok");
      const cby = (n: string) => cat.find((p) => p.name === n);
      assertEq(cby("Lammelår")?.price_nok, 289, "apply: catalog price synced");
      assertEq([cby("Lammelår")?.availability, cby("Lammelår")?.availability_source], ["in_stock", "producer_dashboard"],
        "apply: stock status of a changed product kept (still orderable)");
      assertEq(cby("Lammelår")?.source, "owner_auto_sync", "apply: catalog provenance owner_auto_sync");
      assertEq(cby("Honning")?.unit, "kg", "apply: catalog unit updated");
      assertTrue(!!cby("Gammel ost") && cby("Gammel ost").availability !== "in_stock", "gone: catalog row kept and not in_stock");
      assertEq(cby("Pølse")?.availability, "in_stock", "gone: enrichment product's stock untouched");
      assertEq(cby("Rabarbrasaft"), undefined, "new: not in products");

      const run = db.prepare(`SELECT mode, status, count_new, count_changed, count_not_found FROM product_import_runs WHERE id = ?`).get((r as any).run_id);
      assertEq(run, { mode: "auto_sync", status: "completed", count_new: 1, count_changed: 2, count_not_found: 1 }, "apply: run row logged");
      const cands = db.prepare(`SELECT name, status, diff_kind FROM product_import_candidates WHERE run_id = ?`).all((r as any).run_id);
      assertEq(cands, [{ name: "Rabarbrasaft", status: "pending", diff_kind: "new" }], "new: staged as pending candidate only");

      const lock = JSON.parse((db.prepare(`SELECT curated_fields FROM agent_knowledge WHERE agent_id = 'as-ok'`).get() as any).curated_fields || "{}");
      assertEq(lock?.products?.by, "owner", "apply: owner lock on products");

      const s = state("as-ok");
      assertEq(s.consecutive_blocks, 0, "reset: success resets the counter (was 2)");
      assertEq(s.product_sync_mode, "weekly", "reset: mode stays weekly");
      assertEq(s.last_success_at, new Date(T0).toISOString(), "reset: last success stored");
      const sum = JSON.parse(s.last_change_summary || "{}");
      assertEq([sum.changed?.length, sum.not_found, sum.new_pending, sum.out_of_stock], [2, ["Gammel ost"], 1, 1], "reset: change summary stored");
      assertEq(as.dueAutoSyncProfiles(T0 + DAY).includes("as-ok"), false, "due: not due again within 7 days");
      assertEq(as.dueAutoSyncProfiles(T0 + 7 * DAY).includes("as-ok"), true, "due: due again after 7 days");
    }

    // ─── lock: fetch / extraction fails (robots.txt, network) ──────────────
    {
      const snap = snapshot("as-robots");
      const r1 = await as.runAutoSyncForProfile("as-robots", deps);
      assertEq([r1.status, (r1 as any).reason], ["blocked", "fetch_failed: robots_blocked"], "lock fetch: robots.txt closed → locked");
      assertEq(fetchCalls.filter((u) => u.startsWith("https://as-robots.no/") && !u.endsWith("/robots.txt")).length, 0,
        "lock fetch: robots.txt respected (no page fetched)");
      assertEq(snapshot("as-robots"), snap, "lock fetch: zero product changes");
      assertEq([state("as-robots").consecutive_blocks, state("as-robots").last_block_reason, state("as-robots").product_sync_mode],
        [1, "fetch_failed: robots_blocked", "weekly"], "lock fetch: reason stored, count 1");
      clock += 7 * DAY;
      await as.runAutoSyncForProfile("as-robots", deps);
      assertEq([state("as-robots").consecutive_blocks, state("as-robots").product_sync_mode], [2, "weekly"], "lock fetch: 2nd lock, still weekly");
      clock += 7 * DAY;
      const r3 = await as.runAutoSyncForProfile("as-robots", deps);
      const s3 = state("as-robots");
      assertEq([s3.consecutive_blocks, s3.product_sync_mode, (r3 as any).mode_turned_off], [3, "off", true], "3rd consecutive lock → mode off");
      assertTrue(typeof s3.disabled_reason === "string" && s3.disabled_reason.includes("robots_blocked"), "3rd lock: reason stored");
      assertEq(snapshot("as-robots"), snap, "3 locks: still zero product changes");
      const r4 = await as.runAutoSyncForProfile("as-robots", deps);
      assertEq([r4.status, (r4 as any).reason], ["skipped", "mode_off"], "after turn-off: skipped");
      clock = T0;

      const snapDown = snapshot("as-down");
      const rd = await as.runAutoSyncForProfile("as-down", deps);
      assertTrue(rd.status === "blocked" && (rd as any).reason.startsWith("fetch_failed"), `lock fetch: network error → locked (${(rd as any).reason})`);
      assertEq(snapshot("as-down"), snapDown, "lock fetch (network): zero product changes");
      const runRow = db.prepare(`SELECT status, outcome FROM product_import_runs WHERE id = ?`).get((rd as any).run_id) as any;
      assertEq([runRow.status, runRow.outcome], ["blocked", "fetch_failed"], "lock fetch: run row marked blocked");
    }

    // ─── lock: > 50 % of the confirmed products would disappear ────────────
    {
      const snap = snapshot("as-missing");
      const r = await as.runAutoSyncForProfile("as-missing", deps);
      assertEq(r.status, "blocked", "lock missing: 2 of 3 gone → locked");
      assertTrue((r as any).reason.startsWith("too_many_missing"), "lock missing: reason too_many_missing");
      assertEq(snapshot("as-missing"), snap, "lock missing: zero product changes, nothing staged");
      assertTrue((state("as-missing").last_block_reason ?? "").startsWith("too_many_missing"), "lock missing: reason stored");
    }

    // ─── lock: a price change beyond ±50 % ─────────────────────────────────
    {
      const snap = snapshot("as-dev");
      const r = await as.runAutoSyncForProfile("as-dev", deps);
      assertEq(r.status, "blocked", "lock price: 250 → 400 (+60 %) → locked");
      assertTrue((r as any).reason.startsWith("price_deviation") && (r as any).reason.includes("Lammelår"), "lock price: reason names the product");
      assertEq(snapshot("as-dev"), snap, "lock price: zero product changes (the in-range Egg change is not applied either)");
      assertEq(state("as-dev").consecutive_blocks, 1, "lock price: count 1");
    }

    // ─── pure plan: boundaries ─────────────────────────────────────────────
    {
      const cur = (name: string, price: number, source: string | null = "owner_manual") =>
        ({ index: 0, name, key: name.toLowerCase(), price_nok: price, unit: null, price: `kr ${price}`, source });
      const cand = (name: string, price: number | null) =>
        ({ name, price_nok: price, price_text: "", unit: null, price_is_from: false, source_url: "https://x.no/", tier: "shopify", raw_price_text: null, pack_size: null, rules: [] }) as any;
      assertEq(as.planAutoSync([cand("A", 150)], [cur("A", 100)]).ok, true, "plan: exactly +50 % is allowed");
      assertEq(as.planAutoSync([cand("A", 50)], [cur("A", 100)]).ok, true, "plan: exactly −50 % is allowed");
      assertEq(as.planAutoSync([cand("A", 49)], [cur("A", 100)]).ok, false, "plan: −51 % is locked");
      assertEq(as.planAutoSync([cand("A", 100)], [cur("A", 100), cur("B", 10)]).ok, true, "plan: exactly 50 % missing is allowed");
      assertEq(as.planAutoSync([cand("A", 100)], [cur("A", 100), cur("B", 10, null), cur("C", 10, null)]).ok, true,
        "plan: missing enrichment products do not count");
    }

    // ─── weekly job: flag on, window, persisted stamp, due profiles only ───
    {
      db.prepare(`UPDATE product_auto_sync_state SET product_sync_mode = 'weekly', consecutive_blocks = 0 WHERE agent_id IN ('as-robots')`).run();
      const env = { PRODUCT_AUTO_SYNC_ENABLED: "true" };
      const outside = await as.tickProductAutoSync({ now: new Date(T0 + 3 * 3600_000), lastRunAt: null }, { ...deps, env });
      assertEq(outside.report, null, "job: outside the window → no sweep");
      clock = T0 + 7 * DAY;
      const t1 = await as.tickProductAutoSync({ now: new Date(clock), lastRunAt: null }, { ...deps, env });
      const ids = (t1.report?.results ?? []).map((x) => x.agent_id).sort();
      assertTrue(ids.includes("as-ok") && ids.includes("as-dev"), `job: due profiles swept (${ids.join(",")})`);
      assertTrue(!ids.includes("as-unver") && !ids.includes("as-off") && !ids.includes("as-norow"), "job: unverified / mode off not swept");
      assertTrue((t1.report?.results ?? []).every((x) => x.status !== "skipped"), "job: no skipped profile in the sweep");
      assertTrue(!!as.lastAutoSyncSweepAt(), "job: stamp persisted in boot_job_state");
      const fetchesBefore = fetchCalls.length;
      const t2 = await as.tickProductAutoSync({ now: new Date(clock + 10 * 60_000), lastRunAt: null }, { ...deps, env });
      assertEq(t2.report, null, "job: a restart in the same window (no in-memory stamp) does not sweep again");
      assertEq(fetchCalls.length, fetchesBefore, "job: nothing fetched on the repeated tick");
      const t3 = await as.tickProductAutoSync({ now: new Date(clock + DAY), lastRunAt: t1.lastRunAt }, { ...deps, env });
      assertEq(t3.report?.profiles, 0, "job: next day's sweep finds no profile due (< 7 days)");
    }
  } catch (err) {
    failed++;
    failures.push(`unexpected error: ${err instanceof Error ? (err.stack || err.message) : String(err)}`);
  } finally {
    console.log = prevLog;
    console.error = prevErr;
    for (const k of SAVED_ENV) { if (prevEnv[k] === undefined) delete process.env[k]; else process.env[k] = prevEnv[k]; }
    if (prevDb) initMod.__setDbForTesting(prevDb);
    db.close();
  }
  if (log) console.info(`\nauto-sync: ${passed} passed, ${failed} failed`);
  return { passed, failed, failures };
}

if (require.main === module) {
  runAutoSyncTests({ log: true }).then((r) => {
    for (const f of r.failures) console.info(f);
    process.exit(r.failed > 0 ? 1 : 0);
  });
}
