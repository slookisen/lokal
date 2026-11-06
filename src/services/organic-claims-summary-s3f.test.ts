/**
 * organic-claims-summary-s3f.test.ts — A2A dev-request 2026-10-28-rfb-
 * okologisk-merking-debio-register-og-tekstrevisjon, slice S3f: read-only
 * GET /admin/debio/organic-claims-summary (daily organic-word counts).
 *
 *   auth      no / wrong X-Admin-Key → 403.
 *   counts    profiles per status okologisk|karens|annet|ingen|ukjent (no
 *             status row → ukjent); hits = field entries with a hit;
 *             products[].organic true counts; an inactive profile, a
 *             non-rfb profile and an umbrella are excluded; «økonomi» /
 *             «økosystem» are not hits.
 *   verified  a debio_verified=1 profile with hits is counted under
 *             okologisk but not in unverified_profiles_with_hits / sample.
 *   alert     true with unverified hits; false when there are none.
 *   sample    capped at 50.
 *   read only agents / agent_knowledge / agent_debio_status unchanged.
 *
 * In-memory DB on the production schema. Exported
 * runOrganicClaimsSummaryS3fTests({log}) -> TestSummary; wired into
 * tests/test.ts. Standalone: npx tsx src/services/organic-claims-summary-s3f.test.ts
 */

import Database from "better-sqlite3";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

const NOW = new Date("2026-11-05T12:00:00.000Z");

interface Seed {
  id: string;
  name?: string;
  description?: string;
  tags?: unknown[];
  categories?: unknown[];
  about?: string | null;
  products?: unknown[];
  specialties?: unknown[];
  certifications?: unknown[];
  active?: number;
  verified?: number;
  status?: "okologisk" | "karens" | "annet" | "ingen";
  vertical?: string;
  umbrella?: string | null;
  knowledge?: boolean;
}

function seed(db: Database.Database, a: Seed): void {
  db.prepare(
    `INSERT INTO agents
       (id, name, description, provider, contact_email, url, role, api_key, lat, lng, city,
        categories, tags, skills, trust_score, is_active, is_verified, origin, vertical_id, catalog_hidden, debio_verified, umbrella_type)
     VALUES (?, ?, ?, 'test', ?, ?, 'producer', ?, 59.9, 10.7, 'Testby', ?, ?, '[]', 0.7, ?, 1, 'discovery', ?, 0, ?, ?)`,
  ).run(a.id, a.name ?? `Gård ${a.id}`, a.description ?? "Familiegård.", `post@${a.id}.example.no`, `https://${a.id}.example.no`, `key-${a.id}`,
    JSON.stringify(a.categories ?? ["vegetables"]), JSON.stringify(a.tags ?? ["gårdsutsalg"]), a.active ?? 1, a.vertical ?? "rfb", a.verified ?? 0, a.umbrella ?? null);
  if (a.knowledge !== false) {
    db.prepare(
      `INSERT INTO agent_knowledge (agent_id, about, products, specialties, certifications) VALUES (?, ?, ?, ?, ?)`,
    ).run(a.id, a.about ?? "Vi selger grønnsaker.", JSON.stringify(a.products ?? []), JSON.stringify(a.specialties ?? []), JSON.stringify(a.certifications ?? []));
  }
  if (a.status) {
    db.prepare(`INSERT INTO agent_debio_status (agent_id, debio_status, debio_checked_at) VALUES (?, ?, ?)`).run(a.id, a.status, NOW.toISOString());
  }
}

export async function runOrganicClaimsSummaryS3fTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];
  const assertEq = (actual: unknown, expected: unknown, label: string) => {
    if (JSON.stringify(actual) === JSON.stringify(expected)) { passed++; if (log) console.info(`  ok ${label}`); }
    else { failed++; const m = `✗ ${label}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`; failures.push(m); if (log) console.info("  " + m); }
  };
  const assertTrue = (cond: boolean, label: string, detail?: unknown) => {
    if (cond) { passed++; if (log) console.info(`  ok ${label}`); }
    else { failed++; failures.push(`✗ ${label}${detail === undefined ? "" : `\n    detail: ${JSON.stringify(detail)}`}`); if (log) console.info(`  ✗ ${label}`); }
  };

  const svc = require("./organic-claims-summary") as typeof import("./organic-claims-summary");
  const initMod = require("../database/init") as typeof import("../database/init");
  const prevDb = initMod.__peekDbForTesting();
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  const prevLog = console.log;
  const prevWarn = console.warn;
  const prevAdmin = process.env.ADMIN_KEY;
  if (!log) { console.log = () => { /* quiet */ }; console.warn = () => { /* quiet */ }; }

  try {
    initMod.__setDbForTesting(db as any);
    initMod.__initSchemaForTesting(db as any);
    process.env.ADMIN_KEY = "s3f-admin-key";
    const ADMIN = process.env.ADMIN_KEY;

    // ── pure: per-profile hits ──────────────────────────────────────────────
    assertEq(svc.organicHitsForProfile({ about: "Vi driver med økonomi og et rikt økosystem.", tags: '["samfunnsøkonomi"]' }), {}, "pure-1: økonomi / økosystem are not hits");
    assertEq(svc.organicHitsForProfile({ products: '[{"name":"Gulrot","organic":true},{"name":"Økologisk løk"},{"name":"Potet","note":"Debio-godkjent"},"øko-egg",{"name":"Kål"}]' }),
      { products: 4 }, "pure-2: organic:true, name, note and plain-string products each count once");
    assertEq(svc.organicHitsForProfile({ products: "not json", tags: null }), {}, "pure-3: bad JSON / null → no hits");

    // ── fixture ───────────────────────────────────────────────────────────
    const seeds: Seed[] = [
      // okologisk + verified: hits in about + 2 specialties → counted under okologisk, not unverified
      { id: "s-oko-ver", status: "okologisk", verified: 1, about: "Økologisk drift siden 1990.", specialties: ["Økologiske grønnsaker", "Debio-sertifisert"] },
      // okologisk, not verified (e.g. expired) with a product flag
      { id: "s-oko-unver", status: "okologisk", verified: 0, products: [{ name: "Gulrot", organic: true }, { name: "Kål" }] },
      // karens with tags + certifications
      { id: "s-karens", status: "karens", tags: ["økologisk", "gårdsutsalg"], certifications: ["Debio"] },
      // annet with a description hit
      { id: "s-annet", status: "annet", description: "Vi dyrker biodynamisk." },
      // ingen with category + about
      { id: "s-ingen", status: "ingen", categories: ["organic", "vegetables"], about: "Organic farm." },
      // no status row → ukjent
      { id: "s-ukjent", description: "Øko-egg fra frittgående høner." },
      // no status row, no knowledge row, no hits
      { id: "s-clean", knowledge: false },
      // only «økonomi»/«økosystem» → not counted
      { id: "s-okonomi", status: "ingen", about: "God økonomi og et sunt økosystem.", specialties: ["Lokal økonomi"] },
      // excluded: inactive, other vertical, umbrella
      { id: "s-inactive", active: 0, status: "ingen", about: "Økologisk!", tags: ["økologisk"] },
      { id: "s-dental", vertical: "dental", about: "Økologisk tannkrem." },
      { id: "s-umbrella", umbrella: "reko_ring", about: "Økologisk REKO." },
    ];
    for (const s of seeds) seed(db, s);

    const snapshot = () => JSON.stringify([
      db.prepare("SELECT * FROM agents ORDER BY id").all(),
      db.prepare("SELECT * FROM agent_knowledge ORDER BY agent_id").all(),
      db.prepare("SELECT * FROM agent_debio_status ORDER BY agent_id").all(),
    ]);
    const counts = () => [
      (db.prepare("SELECT COUNT(*) AS n FROM agents").get() as any).n,
      (db.prepare("SELECT COUNT(*) AS n FROM agent_knowledge").get() as any).n,
    ];
    const before = snapshot();
    const beforeCounts = counts();

    const sum = svc.buildOrganicClaimsSummary(db, NOW);
    assertEq(sum.generated_at, NOW.toISOString(), "sum-1: generated_at");
    assertEq(sum.active_profiles, 8, "sum-2: active rfb producers only (inactive, dental, umbrella excluded)");
    assertEq(sum.by_status, {
      okologisk: { profiles_with_hits: 2, hits: 4 },
      karens: { profiles_with_hits: 1, hits: 2 },
      annet: { profiles_with_hits: 1, hits: 1 },
      ingen: { profiles_with_hits: 1, hits: 2 },
      ukjent: { profiles_with_hits: 1, hits: 1 },
    }, "sum-3: per-status profiles_with_hits / hits (økonomi profile not counted)");
    assertEq(sum.unverified_profiles_with_hits, 5, "sum-4: unverified profiles with hits (verified excluded)");
    assertEq(sum.alert, true, "sum-5: alert when unverified hits > 0");
    const sampleIds = sum.unverified_sample.map((x) => x.agent_id);
    assertEq(sampleIds, ["s-annet", "s-ingen", "s-karens", "s-oko-unver", "s-ukjent"], "sum-6: sample lists the unverified profiles with hits");
    assertTrue(!sampleIds.includes("s-oko-ver") && !sampleIds.includes("s-okonomi") && !sampleIds.includes("s-inactive"), "sum-7: verified / økonomi / inactive not in sample");
    assertEq(sum.unverified_sample.find((x) => x.agent_id === "s-karens"), { agent_id: "s-karens", name: "Gård s-karens", fields: ["certifications", "tags"] }, "sum-8: sample entry carries name + fields with hits");
    assertEq(sum.unverified_sample.find((x) => x.agent_id === "s-ingen")?.fields, ["about", "categories"], "sum-9: fields for ingen profile");

    // ── route ─────────────────────────────────────────────────────────────
    try { delete require.cache[require.resolve("../routes/admin-debio-cross-check")]; } catch { /* not loaded */ }
    const adminRouter = require("../routes/admin-debio-cross-check").default as any;
    const layer = (adminRouter.stack as any[]).find((x: any) => x.route && x.route.path === "/organic-claims-summary" && x.route.methods?.get);
    assertTrue(!!layer, "route-1: GET /organic-claims-summary registered");
    const handler = layer.route.stack[layer.route.stack.length - 1].handle as Function;
    const call = (headers: any = { "x-admin-key": ADMIN }) => new Promise<{ status: number; body: any }>((resolve) => {
      let status = 200;
      const res: any = { status(c: number) { status = c; return res; }, json(b: any) { resolve({ status, body: b }); return res; } };
      Promise.resolve(handler({ headers, query: {}, params: {}, body: {} }, res)).catch((e: any) => resolve({ status: 599, body: String(e) }));
    });
    assertEq((await call({})).status, 403, "auth-1: no X-Admin-Key → 403");
    assertEq((await call({ "x-admin-key": "nope" })).status, 403, "auth-2: wrong X-Admin-Key → 403");
    const ok = await call();
    assertEq(ok.status, 200, "route-2: 200");
    assertEq([ok.body.success, ok.body.active_profiles, ok.body.unverified_profiles_with_hits, ok.body.alert], [true, 8, 5, true], "route-3: body shape");
    assertEq(ok.body.by_status, sum.by_status, "route-4: route returns the service counts");

    // ── read only ─────────────────────────────────────────────────────────
    assertEq(counts(), beforeCounts, "ro-1: agents / agent_knowledge row counts unchanged");
    assertEq(snapshot(), before, "ro-2: agents / agent_knowledge / agent_debio_status content unchanged");

    // ── alert false ───────────────────────────────────────────────────────
    const db2 = new Database(":memory:");
    try {
      initMod.__initSchemaForTesting(db2 as any);
      seed(db2, { id: "v-only", status: "okologisk", verified: 1, about: "Økologisk." });
      seed(db2, { id: "v-clean", status: "ingen", about: "Økonomi og økosystem." });
      const s2 = svc.buildOrganicClaimsSummary(db2, NOW);
      assertEq([s2.active_profiles, s2.unverified_profiles_with_hits, s2.alert, s2.unverified_sample.length, s2.by_status.okologisk],
        [2, 0, false, 0, { profiles_with_hits: 1, hits: 1 }], "alert-1: only a verified profile has hits → alert false");
    } finally { db2.close(); }

    // ── sample cap ────────────────────────────────────────────────────────
    const db3 = new Database(":memory:");
    try {
      initMod.__initSchemaForTesting(db3 as any);
      for (let i = 0; i < 60; i++) seed(db3, { id: `c-${String(i).padStart(2, "0")}`, status: "ingen", tags: ["økologisk"] });
      const s3 = svc.buildOrganicClaimsSummary(db3, NOW);
      assertEq([s3.unverified_profiles_with_hits, s3.unverified_sample.length, s3.by_status.ingen], [60, 50, { profiles_with_hits: 60, hits: 60 }], "cap-1: sample capped at 50, count is the full 60");
    } finally { db3.close(); }
  } catch (err: any) {
    failed++;
    failures.push(`✗ unexpected error: ${err?.stack || err}`);
  } finally {
    console.log = prevLog;
    console.warn = prevWarn;
    if (prevAdmin === undefined) delete process.env.ADMIN_KEY; else process.env.ADMIN_KEY = prevAdmin;
    if (prevDb) initMod.__setDbForTesting(prevDb as any);
    try { db.close(); } catch { /* closed */ }
  }
  return { passed, failed, failures };
}

if (require.main === module) {
  runOrganicClaimsSummaryS3fTests({ log: true }).then((r) => {
    console.info(`\n${r.passed} passed, ${r.failed} failed`);
    for (const f of r.failures) console.info(f);
    process.exit(r.failed ? 1 : 0);
  });
}
