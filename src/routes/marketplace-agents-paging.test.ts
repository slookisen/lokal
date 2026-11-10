/**
 * marketplace-agents-paging.test.ts — A2A dev-request
 * 2026-10-26-marketplace-agents-endepunkt-ignorerer-limit (re-specified
 * 2026-10-28, Daniel 3.9): GET /api/marketplace/agents keeps its 50-row cap
 * and clients page with `limit=50&offset=n`.
 *
 *   AC1  limit=2000 still returns at most 50 rows (limit echoed as 50).
 *   AC2  every row carries `umbrella_type` (null — the list excludes umbrella
 *        agents, and an umbrella agent is on no page).
 *   AC3  consecutive pages neither overlap nor skip a row: pages at offset
 *        0, 50, 100 cover every listed agent exactly once, the last page is
 *        short, and tied rows (same trust_score + created_at) keep one fixed
 *        order (insertion order) across calls.
 *   safe a negative / non-numeric offset reads as 0 (a negative offset used to
 *        return the LAST rows via Array.slice); limit ≤ 0 / non-numeric reads
 *        as the cap; limit < 50 is honoured.
 *
 * Real router + registry on the production schema in an in-memory DB (same
 * harness as organic-claims-s0.test.ts). Exported
 * runMarketplaceAgentsPagingTests({log}) -> TestSummary; wired into
 * tests/test.ts. Standalone: npx tsx src/routes/marketplace-agents-paging.test.ts
 */

import Database from "better-sqlite3";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

const N_PRODUCERS = 123;
const UMBRELLA_ID = "paging-paraply";
const CREATED = "2026-01-01 00:00:00";

export async function runMarketplaceAgentsPagingTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
  const { marketplaceRegistry } = require("../services/marketplace-registry") as typeof import("../services/marketplace-registry");
  const clearRegistryCaches = () => {
    marketplaceRegistry._agentsCache = null;
    marketplaceRegistry._statsCache = null;
    marketplaceRegistry._agentsCacheTime = 0;
    marketplaceRegistry._statsCacheTime = 0;
  };

  const db = new Database(":memory:");
  db.pragma("journal_mode = DELETE");
  db.pragma("foreign_keys = ON");
  const prevLog = console.log;
  if (!log) console.log = () => { /* silence registry chatter */ };

  try {
    initMod.__setDbForTesting(db as any);
    initMod.__initSchemaForTesting(db as any);
    const { loadConfigsAtBoot } = require("../config/vertical-config") as typeof import("../config/vertical-config");
    try { loadConfigsAtBoot(); } catch { /* already loaded by another suite */ }
    clearRegistryCaches();
    try { delete require.cache[require.resolve("./marketplace")]; } catch { /* not loaded yet */ }
    const router = require("./marketplace").default as any;
    const layer = (router.stack as any[]).find((l: any) => l.route && l.route.path === "/agents" && l.route.methods?.get);
    if (!layer) throw new Error("route not found: GET /agents");
    const handler = layer.route.stack[layer.route.stack.length - 1].handle as Function;

    const call = (query: Record<string, string>): Promise<any> => new Promise((resolve) => {
      const res: any = {
        status() { return res; },
        json(p: any) { resolve(p); return res; },
        set() { return res; }, setHeader() { return res; }, header() { return res; },
      };
      const req: any = {
        method: "GET", url: "/", path: "/", originalUrl: "/", params: {}, query, headers: {}, cookies: {},
        ip: "127.0.0.1", lang: "no", protocol: "https", hostname: "rettfrabonden.com", get() { return undefined; },
      };
      try { handler(req, res, (err?: any) => resolve({ __next: true, err: String(err) })); } catch (err) { resolve({ __error: String(err) }); }
    });

    const insert = db.prepare(
      `INSERT INTO agents
         (id, name, description, provider, contact_email, url, role, api_key, lat, lng, city,
          categories, tags, skills, trust_score, is_active, is_verified, origin, vertical_id, catalog_hidden, created_at, umbrella_type)
       VALUES (?, ?, 'Gård med gårdsutsalg av grønnsaker hele året.', 'test', ?, ?, ?, ?, 59.91, 10.75, 'Oslo',
               '["vegetables"]', '["gårdsutsalg"]', '[]', ?, 1, 1, 'discovery', 'rfb', 0, ?, ?)`,
    );
    // Ids are inserted in DESCENDING lexical order, so a tie-break by id would
    // reverse them — the expected order below is insertion (rowid) order.
    const tiedIds: string[] = [];
    for (let i = N_PRODUCERS; i >= 1; i--) {
      const id = `paging-${String(i).padStart(3, "0")}`;
      // Three trust levels, many rows per level, every row the same created_at → ties.
      const trust = i % 3 === 0 ? 0.9 : i % 3 === 1 ? 0.7 : 0.5;
      insert.run(id, `Paging Gard ${i}`, `post@${id}.example.no`, `https://${id}.example.no`, "producer", `key-${id}`, trust, CREATED, null);
      if (trust === 0.7) tiedIds.push(id);
    }
    insert.run(UMBRELLA_ID, "Paging Bondens marked", `post@${UMBRELLA_ID}.example.no`, `https://${UMBRELLA_ID}.example.no`, "producer", `key-${UMBRELLA_ID}`, 0.99, CREATED, "market_network");
    clearRegistryCaches();

    // ── AC1: the cap holds ────────────────────────────────────────────────
    const big = await call({ limit: "2000" });
    assertEq(big.count, 50, "ac1-1: limit=2000 → 50 rows");
    assertEq(big.agents?.length, 50, "ac1-2: limit=2000 → agents array of 50");
    assertEq(big.limit, 50, "ac1-3: limit echoed as the cap (50)");
    assertEq(big.total, N_PRODUCERS, "ac1-4: total counts every listed (non-umbrella) agent");

    // ── AC2: umbrella_type on every row ───────────────────────────────────
    assertTrue((big.agents ?? []).every((a: any) => Object.prototype.hasOwnProperty.call(a, "umbrella_type") && a.umbrella_type === null),
      "ac2-1: every row has umbrella_type: null");

    // ── AC3: pages cover every row exactly once, in a fixed order ─────────
    const pageIds: string[][] = [];
    for (let off = 0; off < 400; off += 50) {
      const p = await call({ limit: "50", offset: String(off) });
      const ids = (p.agents ?? []).map((a: any) => a.id);
      pageIds.push(ids);
      assertTrue((p.agents ?? []).every((a: any) => a.umbrella_type === null), `ac2-2: page offset=${off} rows all carry umbrella_type: null`);
      if (ids.length < 50) break;
    }
    assertEq(pageIds.map((ids) => ids.length), [50, 50, N_PRODUCERS - 100], "ac3-1: pages 50/50/23, the last page is short");
    const flat = pageIds.flat();
    assertEq(new Set(flat).size, flat.length, "ac3-2: no row appears on two pages");
    assertEq(flat.length, N_PRODUCERS, "ac3-3: every listed agent is on some page (no gaps)");
    assertTrue(!flat.includes(UMBRELLA_ID), "ac2-3: the umbrella agent is on no page");
    const tiedInPages = flat.filter((id) => tiedIds.includes(id));
    assertEq(tiedInPages, tiedIds, "ac3-4: tied rows (same trust + created_at) come in insertion order");
    // A fresh read (cache cleared) gives the same order.
    clearRegistryCaches();
    const again: string[] = [];
    for (const off of [0, 50, 100]) again.push(...((await call({ limit: "50", offset: String(off) })).agents ?? []).map((a: any) => a.id));
    assertEq(again, flat, "ac3-5: a second paging after a cache reset gives the identical order");
    // Pages of 20 line up with pages of 50.
    const by20: string[] = [];
    for (let off = 0; off < N_PRODUCERS; off += 20) by20.push(...((await call({ limit: "20", offset: String(off) })).agents ?? []).map((a: any) => a.id));
    assertEq(by20, flat, "ac3-6: limit=20 pages give the same sequence as limit=50 pages");

    // ── safe parameters ───────────────────────────────────────────────────
    const first = pageIds[0];
    const ids = async (q: Record<string, string>) => ((await call(q)).agents ?? []).map((a: any) => a.id);
    assertEq(await ids({ offset: "-5" }), first, "safe-1: offset=-5 reads as 0 (not the last rows)");
    assertEq((await call({ offset: "-5" })).offset, 0, "safe-2: offset=-5 echoed as 0");
    assertEq(await ids({ offset: "abc" }), first, "safe-3: offset=abc reads as 0");
    assertEq((await call({ limit: "-3" })).count, 50, "safe-4: limit=-3 reads as the cap");
    assertEq((await call({ limit: "0" })).count, 50, "safe-5: limit=0 reads as the cap");
    assertEq((await call({ limit: "abc" })).count, 50, "safe-6: limit=abc reads as the cap");
    assertEq((await call({})).count, 50, "safe-7: no limit → the cap");
    const ten = await call({ limit: "10", offset: "5" });
    assertEq(ten.agents.map((a: any) => a.id), first.slice(5, 15), "safe-8: limit=10&offset=5 → rows 5..14");
    assertEq((await call({ offset: "5000" })).count, 0, "safe-9: offset past the end → empty page");
  } catch (err: any) {
    failed++;
    failures.push("unexpected error: " + String(err?.stack || err?.message || err));
  } finally {
    console.log = prevLog;
    if (prevDb) initMod.__setDbForTesting(prevDb as any);
    clearRegistryCaches();
    try { db.close(); } catch { /* already closed */ }
  }
  return { passed, failed, failures };
}

if (require.main === module) {
  runMarketplaceAgentsPagingTests({ log: true }).then((r) => {
    console.info(`\n${r.passed} passed, ${r.failed} failed`);
    for (const f of r.failures) console.info(f);
    process.exit(r.failed ? 1 : 0);
  });
}
