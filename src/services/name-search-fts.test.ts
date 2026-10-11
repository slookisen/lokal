/**
 * name-search-fts.test.ts — slice S3 of 2026-10-09-rfb-grunnmur-wal-backup-fts-spillbok.
 *
 * The FTS5 trigram prefilter for discover()'s name search must give the SAME
 * results (ids, order, scores) as the full scan (RFB_NAME_FTS=0), keep the
 * public predicate, stay in sync through the triggers, and fall back to the
 * full scan whenever the index is missing or broken.
 *
 * Real init.ts schema in an in-memory DB injected via __setDbForTesting; the
 * previous singleton and RFB_NAME_FTS are restored at the end.
 * Standalone: npx tsx src/services/name-search-fts.test.ts
 */
import Database from "better-sqlite3";
import { __setDbForTesting, __initSchemaForTesting, __peekDbForTesting } from "../database/init";
import { publicListableSql } from "./agent-visibility";

export interface TestSummary { passed: number; failed: number; failures: string[]; }

interface Fixture {
  id: string; name: string; lat?: number | null; lng?: number | null; trust?: number;
  active?: number; vetted?: number; umbrella?: string | null; hidden?: number; vertical?: string | null;
}

const FIXTURES: Fixture[] = [
  { id: "bjorndal", name: "Bjørndal Gård", lat: 62.59, lng: 9.69, trust: 0.7 },
  { id: "bjorndal-utsalg", name: "Bjørndal Gårdsutsalg", lat: null, lng: null },
  { id: "ostre-asen", name: "Østre Åsen Gård", lat: 59.9, lng: 10.7 },
  { id: "ostre-toten", name: "ØSTRE TOTEN MAT", lat: 60.7, lng: 10.8 },
  { id: "dyroymat", name: "Dyrøymat", lat: 69.0, lng: 17.5 },
  { id: "sjomat-dyroy", name: "SJØMAT Dyrøy AS", lat: null, lng: null },
  { id: "dyroy-honning", name: "Dyrøy Honning", lat: 69.1, lng: 17.6 },
  { id: "as-kjott", name: "ÅS Kjøtt", lat: 59.66, lng: 10.79 },
  { id: "as-butikk", name: "Ås Gårdsbutikk", lat: 59.67, lng: 10.78 },
  { id: "gardsbutikken", name: "Gardsbutikken på Ås", lat: null, lng: null },
  { id: "gard-gront", name: "Gård og Grønt", lat: 61.0, lng: 10.0 },
  { id: "alvdalen", name: "Älvdalens Höns", lat: 61.2, lng: 14.0 },
  { id: "oland", name: "Ölands Gårdsmejeri", lat: 56.7, lng: 16.6 },
  { id: "muller", name: "Müller Käse", lat: 59.1, lng: 11.4 },
  { id: "cafe-elan", name: "Café Élan", lat: 59.9, lng: 10.75 },
  { id: "cafe-osterlen", name: "CAFÉ ÖSTERLEN", lat: 55.5, lng: 14.1 },
  { id: "aero", name: "Ærø Æblemost", lat: 54.9, lng: 10.4 },
  { id: "aeblegarden", name: "ÆBLEGÅRDEN Søby", lat: null, lng: null },
  { id: "li-gard", name: "Li Gård", lat: 60.1, lng: 9.9 },
  { id: "ny-lia", name: "Ny Lia Gård", lat: null, lng: null },
  { id: "lia-bakeri", name: "Lia Bakeri", lat: 63.4, lng: 10.4 },
  { id: "bakeri-i", name: "BAKERİ Istanbul", lat: null, lng: null },
  { id: "konditori-i", name: "KONDİTORİ Østre", lat: 59.9, lng: 10.7 },
  { id: "kare", name: "Kåre's Bær & Brød", lat: 60.4, lng: 5.3 },
  { id: "ost-sant", name: "OST & SÅNT", lat: 60.39, lng: 5.32 },
  { id: "sondre", name: "Søndre Øyen Bryggeri", lat: null, lng: null },
  { id: "strasse", name: "Straße Hof", lat: 47.0, lng: 11.0 },
  { id: "cherokee", name: "Ꭰbc Farm", lat: null, lng: null },
  { id: "nfd", name: "Gård NFD", lat: 60.0, lng: 10.0 },
  // non-public twins: must never surface, whatever the index holds
  { id: "np-vetted", name: "Bjørndal Gård Kopi", lat: 62.6, lng: 9.7, vetted: 0 },
  { id: "np-inactive", name: "Bjørndal Gård Gammel", lat: 62.6, lng: 9.7, active: 0 },
  { id: "np-umbrella", name: "Bjørndal Paraply", lat: 62.6, lng: 9.7, umbrella: "cooperative" },
  { id: "np-hidden", name: "Bjørndal Testprodusent", lat: 62.6, lng: 9.7, hidden: 1 },
  { id: "np-dental", name: "Bjørndal Tannlege", lat: 62.6, lng: 9.7, vertical: "dental" },
];
// 30 "Nordre Gård n" rows with equal trust and mixed/NULL coordinates: more
// matches than the page size, so the top-20 cut depends on row order.
for (let i = 0; i < 30; i++) {
  FIXTURES.push({ id: `nordre-${i}`, name: `Nordre Gård ${i}`, lat: i % 4 === 0 ? null : 58 + ((i * 37) % 13) / 2, lng: i % 4 === 0 ? null : 6 + ((i * 11) % 7) });
}

const QUERIES = [
  "bjørndal gård", "BJØRNDAL", "Bjørndal", "østre åsen", "ØSTRE", "Østre", "ÅS Kjøtt", "ås gård", "Ås Gårdsbutikk",
  "dyrøy", "DYRØY", "Dyrøy Sjømat", "Dyrøy Fiskemat", "gård", "GÅRD", "gard", "älvdalens", "ÄLVDALENS HÖNS", "ölands",
  "ÖLANDS", "müller", "MÜLLER KÄSE", "café", "CAFÉ ÉLAN", "élan", "ÉLAN", "ærø", "ÆRØ ÆBLEMOST", "æblegården",
  "li gård", "ny lia", "li ny", "lia", "bakeri", "BAKERİ", "bakeri istanbul", "konditori", "tori", "kåre's",
  "ost & sånt", "søndre øyen", "straße", "ꭰbc", "Ꭰbc Farm", "gård", "nordre gård", "Nordre", "nordre 1",
  "xyzzy finnes ikke", "Ås Fiskemat Honning", "Testprodusent", "Tannlege", "Paraply",
];

function seed(db: Database.Database, rows: Fixture[]): void {
  const ins = db.prepare(`
    INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, lat, lng,
                        trust_score, is_active, is_vetted, umbrella_type, catalog_hidden, vertical_id)
    VALUES (?, ?, 'Lokal produsent', 'test', ?, ?, 'producer', ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const r of rows) {
    ins.run(r.id, r.name, `${r.id}@example.no`, `https://${r.id}.example.no`, `key-${r.id}`, r.lat ?? null, r.lng ?? null,
      r.trust ?? 0.5, r.active ?? 1, r.vetted ?? 1, r.umbrella ?? null, r.hidden ?? 0, r.vertical ?? "rfb");
  }
}

export function runNameSearchFtsTests(opts: { log?: boolean } = {}): TestSummary {
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];
  function ok(cond: boolean, label: string): void {
    if (cond) { passed++; if (opts.log) console.log(`  ✓ ${label}`); }
    else { failed++; failures.push(`✗ ${label}`); if (opts.log) console.log(`  ✗ ${label}`); }
  }

  const fts = require("./name-search-fts") as typeof import("./name-search-fts");
  const { marketplaceRegistry } = require("./marketplace-registry") as typeof import("./marketplace-registry");
  const prevDb = __peekDbForTesting();
  const prevEnv = process.env.RFB_NAME_FTS;
  const realLog = console.log;
  const realErr = console.error;
  let captured: string[] = [];
  const quiet = () => { captured = []; console.log = (...a: unknown[]) => { captured.push(a.join(" ")); }; console.error = console.log; };
  const loud = () => { console.log = realLog; console.error = realErr; };
  const setFts = (on: boolean) => { if (on) delete process.env.RFB_NAME_FTS; else process.env.RFB_NAME_FTS = "0"; };

  const db = new Database(":memory:");
  db.pragma("foreign_keys = OFF");
  /** discover() as the routes call it for a name; returns results + whether the FTS path ran. */
  const search = (q: string, extra: Record<string, unknown> = {}) => {
    quiet();
    try {
      const results = marketplaceRegistry.discover({ _nameQuery: q, limit: 20, ...extra } as any, undefined, { trackDiscovery: false });
      return { results, viaFts: captured.some((l) => l.includes("ftsCandidates=")), lines: captured };
    } finally { loud(); }
  };
  const ids = (r: { results: Array<{ agent: { id: string } }> }) => r.results.map((x) => x.agent.id);
  const ftsCount = () => (db.prepare(`SELECT COUNT(*) AS c FROM ${fts.NAME_FTS_TABLE}`).get() as { c: number }).c;
  const agentCount = () => (db.prepare("SELECT COUNT(*) AS c FROM agents").get() as { c: number }).c;

  try {
    quiet();
    try {
      __setDbForTesting(db);
      __initSchemaForTesting(db);
    } finally { loud(); }
    seed(db, FIXTURES);

    // ── (1) migration: table + triggers created, rows indexed by the insert trigger ──
    const objs = db.prepare("SELECT type, name FROM sqlite_master WHERE name LIKE 'agents_name_fts%'").all() as Array<{ type: string; name: string }>;
    ok(objs.some((o) => o.type === "table" && o.name === "agents_name_fts"), "migration created agents_name_fts");
    ok(["agents_name_fts_ai", "agents_name_fts_ad", "agents_name_fts_au"].every((n) => objs.some((o) => o.type === "trigger" && o.name === n)), "migration created the three sync triggers");
    ok(ftsCount() === agentCount() && agentCount() === FIXTURES.length, `insert trigger indexed every agent (${ftsCount()}/${agentCount()})`);

    // ── (2) SQLite trigram folding vs JS toLowerCase() ──
    const probe = new Database(":memory:");
    probe.exec("CREATE VIRTUAL TABLE p USING fts5(id UNINDEXED, name, tokenize = 'trigram')");
    const pIns = probe.prepare("INSERT INTO p(id, name) VALUES (?, ?)");
    const pHit = (id: string, q: string) => (probe.prepare("SELECT id FROM p WHERE p MATCH ?").all(`"${q}"`) as Array<{ id: string }>).some((r) => r.id === id);
    const pairs: Array<[string, string]> = [["ØSTRE", "østre"], ["ÅS GÅRD", "ås gård"], ["ÆRØ", "ærø"], ["ÄLG", "älg"], ["ÖLAND", "öland"], ["MÜLLER", "müller"], ["ÉLAN", "élan"], ["Østre", "ØSTRE"]];
    pairs.forEach(([name, q], i) => pIns.run(`f${i}`, `x ${name} y`));
    ok(pairs.every(([, q], i) => pHit(`f${i}`, q)), "trigram folds Æ Ø Å Ä Ö Ü É both ways like toLowerCase()");
    pIns.run("gaard", "Gård"); pIns.run("gard", "Gard");
    ok(!pHit("gaard", "gar") && pHit("gard", "gar") && !pHit("gard", "går"), "diacritics are kept: 'gar' ≠ 'går'");
    // Exhaustive: every code point whose JS lowercase lies in the FTS-eligible
    // range (U+0021–U+007E, U+00A1–U+017F) folds the same in SQLite — except
    // "İ" (→ "i̇" in JS, unfolded in SQLite), which the query handles explicitly.
    const inRange = (s: string) => [...s].every((ch) => { const c = ch.codePointAt(0)!; return (c >= 0x21 && c <= 0x7e) || (c >= 0xa1 && c <= 0x17f); });
    const toCheck: Array<[number, string]> = [];
    for (let cp = 0; cp <= 0x10ffff; cp++) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue;
      const c = String.fromCodePoint(cp);
      const l = c.toLowerCase();
      if (l !== c && [...l].some((ch) => inRange(ch))) toCheck.push([cp, l]);
    }
    probe.transaction(() => { for (const [cp] of toCheck) pIns.run(`cp${cp}`, `qq${String.fromCodePoint(cp)}zz`); })();
    const bad = toCheck.filter(([cp, l]) => !pHit(`cp${cp}`, `q${l}z`)).map(([cp]) => cp.toString(16));
    ok(toCheck.length > 100 && bad.length === 1 && bad[0] === "130", `only U+0130 folds differently among ${toCheck.length} code points lowercasing into the eligible range (got ${JSON.stringify(bad)})`);
    pIns.run("dot-i", "BAKERİ");
    ok(pHit("dot-i", "bakerİ") && !pHit("dot-i", "bakeri"), "SQLite leaves 'İ' unfolded: only the 'İ' spelling finds it");
    probe.close();

    // ── (3) MATCH builders ──
    ok(fts.nameFtsAllWordsMatch(["bjørndal", "gård"]) === '"bjørndal" AND "gård"', "strict: AND of quoted words");
    ok(fts.nameFtsAllWordsMatch(["li", "gård"]) === '"gård"', "strict: 2-char words left to the JS filter");
    ok(fts.nameFtsAllWordsMatch(["li", "ny"]) === null, "strict: no word >= 3 chars → null (full scan)");
    ok(fts.nameFtsAllWordsMatch(['o"neil']) === '"o""neil"', "strict: double quotes escaped");
    ok(fts.nameFtsAllWordsMatch(["bakeri"]) === '("bakeri" OR "bakerİ")', "word ending in 'i' also searches the 'İ' spelling");
    ok(fts.nameFtsAllWordsMatch(["ꭰbc", "farm"]) === '"farm"' && fts.nameFtsAllWordsMatch(["ꭰbc"]) === null, "strict: word outside the eligible range left to JS");
    ok(fts.nameFtsAllWordsMatch(["😀ab"]) === null, "strict: astral word (UTF-16 length 4) not sent to FTS");
    ok(fts.nameFtsAnyWordMatch(["dyrøy", "fiskemat"]) === '"dyrøy" OR "fiskemat"', "any-word: OR of quoted words");
    ok(fts.nameFtsAnyWordMatch(["dyrøy", "ꭰbc"]) === null && fts.nameFtsAnyWordMatch([]) === null, "any-word: one ineligible word → null (full scan)");

    // ── (4) the full scan's explicit ORDER BY is the order its plan already gave ──
    const pub = `is_active = 1 AND umbrella_type IS NULL AND is_vetted = 1 AND ${publicListableSql()}`;
    const plan = (sql: string) => (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{ detail: string }>).map((r) => r.detail).join(" | ");
    const planOrdered = plan(`SELECT * FROM agents WHERE ${pub} ORDER BY lat, lng, rowid`);
    ok(planOrdered === plan(`SELECT * FROM agents WHERE ${pub}`) && !/TEMP B-TREE/.test(planOrdered), `ORDER BY lat, lng, rowid is free: same plan as before, no sort (${planOrdered})`);

    // ── (5) parity: FTS on vs RFB_NAME_FTS=0 — ids, order, scores, reasons ──
    const variants: Array<[string, Record<string, unknown>]> = [
      ["plain", {}],
      ["oslo-50km", { location: { lat: 59.91, lng: 10.75 }, maxDistanceKm: 50 }],
      ["tromsø-5km", { location: { lat: 69.65, lng: 18.96 }, maxDistanceKm: 5 }],
      ["limit-3", { limit: 3 }],
      ["role", { role: "producer" }],
    ];
    let compared = 0, viaFts = 0;
    const mismatches: string[] = [];
    for (const q of QUERIES) {
      for (const [label, extra] of variants) {
        setFts(true); const on = search(q, extra);
        setFts(false); const off = search(q, extra);
        compared++;
        if (on.viaFts) viaFts++;
        if (off.viaFts) mismatches.push(`${q}/${label}: RFB_NAME_FTS=0 still used FTS`);
        if (JSON.stringify(on.results) !== JSON.stringify(off.results)) mismatches.push(`${q}/${label}: ${JSON.stringify(ids(on))} vs ${JSON.stringify(ids(off))}`);
      }
    }
    setFts(true);
    ok(mismatches.length === 0, `parity on ${compared} query/variant pairs${mismatches.length ? ": " + mismatches.slice(0, 5).join("; ") : ""}`);
    ok(viaFts >= compared * 0.75, `FTS path used for most of them (${viaFts}/${compared})`);

    // spot checks (FTS on)
    const nonPublic = ["np-vetted", "np-inactive", "np-umbrella", "np-hidden", "np-dental"];
    const r1 = search("ØSTRE");
    ok(r1.viaFts && ["ostre-asen", "ostre-toten", "konditori-i"].every((id) => ids(r1).includes(id)), "'ØSTRE' finds Østre…, ØSTRE…, …Østre via FTS");
    const r2 = search("bjørndal");
    ok(r2.viaFts && ids(r2).includes("bjorndal") && ids(r2).includes("bjorndal-utsalg") && !ids(r2).some((id) => nonPublic.includes(id)), "'bjørndal' finds the public rows only (predicate still applied)");
    const r3 = search("dyrøy");
    ok(r3.viaFts && ids(r3).includes("dyroymat"), "'dyrøy' finds 'Dyrøymat' (mid-word substring)");
    const r4 = search("Dyrøy Fiskemat");
    ok(r4.results.length > 0 && r4.results[0].matchReasons[0].startsWith("Mulig navnematch") && ids(r4).includes("dyroymat") && r4.lines.some((l) => l.includes("[name-search-fuzzy]")), "strict miss → any-word path finds Dyrøymat");
    const r5 = search("gard");
    ok(ids(r5).includes("gardsbutikken") && !ids(r5).some((id) => id === "gard-gront" || id === "bjorndal"), "'gard' does not match 'gård'");
    const r6 = search("tori");
    ok(r6.viaFts && ids(r6).includes("konditori-i"), "'tori' finds 'KONDİTORİ' through the 'İ' spelling (JS: 'i̇' contains 'i')");
    const r7 = search("bakeri");
    ok(r7.viaFts && ids(r7).includes("bakeri-i") && ids(r7).includes("lia-bakeri"), "'bakeri' finds 'Lia Bakeri' and 'BAKERİ Istanbul'");
    const r8 = search("li ny");
    ok(!r8.viaFts && ids(r8).includes("ny-lia"), "only 2-char words → full scan, still finds 'Ny Lia Gård'");
    const r9 = search("Ꭰbc Farm");
    ok(r9.viaFts && ids(r9).includes("cherokee"), "word FTS can't fold is left to JS, the other word still prefilters");
    const r10 = search("nordre gård");
    ok(r10.results.length === 20, "broad match is cut at the page size (order-sensitive case covered by parity)");
    for (const np of ["Testprodusent", "Tannlege", "Paraply"]) {
      ok(search(np).results.every((x) => !nonPublic.includes(x.agent.id)), `non-public '${np}' never surfaces`);
    }

    // ── (6) the FTS path really narrows: remove one index row → FTS misses it, the scan does not ──
    db.prepare(`DELETE FROM ${fts.NAME_FTS_TABLE} WHERE agent_id = ?`).run("dyroymat");
    const miss = search("dyrøy");
    setFts(false); const scan = search("dyrøy"); setFts(true);
    ok(miss.viaFts && ids(miss).includes("dyroy-honning") && !ids(miss).includes("dyroymat") && ids(scan).includes("dyroymat"), "search reads the FTS index (a missing index row is missed); kill switch bypasses it");
    // nightly consistency check repairs the drift
    const fix = fts.syncAgentsNameFts(db);
    ok(fix.rebuilt && !fix.error && ftsCount() === agentCount(), "syncAgentsNameFts rebuilds on count mismatch");
    ok(ids(search("dyrøymat")).includes("dyroymat"), "after the rebuild the agent is found again");
    const noop = fts.syncAgentsNameFts(db);
    ok(!noop.rebuilt && noop.agents === noop.indexed, "syncAgentsNameFts is a no-op when counts match");

    // ── (7) triggers ──
    seed(db, [{ id: "fjellheim", name: "Fjellheim Ysteri", lat: 61.5, lng: 8.5 }]);
    ok(ids(search("fjellheim")).includes("fjellheim") && ftsCount() === agentCount(), "insert → indexed and found");
    const ftsRowid = () => (db.prepare(`SELECT rowid AS r FROM ${fts.NAME_FTS_TABLE} WHERE agent_id = 'fjellheim'`).get() as { r: number } | undefined)?.r;
    const before = ftsRowid();
    db.prepare("UPDATE agents SET trust_score = 0.9, name = name WHERE id = 'fjellheim'").run();
    ok(ftsRowid() === before, "update without a name change leaves the index row alone");
    const indexed = (id: string) => (db.prepare(`SELECT name FROM ${fts.NAME_FTS_TABLE} WHERE agent_id = ?`).all(id) as Array<{ name: string }>).map((x) => x.name);
    db.prepare("UPDATE agents SET name = 'Fjellheim Meieri' WHERE id = 'fjellheim'").run();
    ok(JSON.stringify(indexed("fjellheim")) === '["Fjellheim Meieri"]' && ids(search("meieri")).includes("fjellheim") && ftsCount() === agentCount(), "rename → old name gone from the index, new name found");
    db.prepare("UPDATE agents SET id = 'fjellheim-2' WHERE id = 'fjellheim'").run();
    ok(indexed("fjellheim").length === 0 && ids(search("fjellheim")).includes("fjellheim-2") && ftsCount() === agentCount(), "id change → index follows");
    db.prepare("UPDATE agents SET is_vetted = 0 WHERE id = 'fjellheim-2'").run();
    ok(!ids(search("fjellheim")).includes("fjellheim-2"), "is_vetted = 0 → not returned although still indexed");
    db.prepare("UPDATE agents SET is_vetted = 1, is_active = 0 WHERE id = 'fjellheim-2'").run();
    ok(!ids(search("fjellheim")).includes("fjellheim-2"), "is_active = 0 → not returned");
    db.prepare("DELETE FROM agents WHERE id = 'fjellheim-2'").run();
    ok(ftsCount() === agentCount() && (db.prepare(`SELECT COUNT(*) AS c FROM ${fts.NAME_FTS_TABLE} WHERE agent_id = 'fjellheim-2'`).get() as { c: number }).c === 0, "delete → index row removed");
    // REPLACE fires no DELETE trigger: a stale extra row, harmless and repaired by the sync
    db.prepare("INSERT OR REPLACE INTO agents (id, name, description, provider, contact_email, url, role, api_key) VALUES ('dyroymat', 'Dyrøymat Nord', 'x', 'p', 'e', 'u', 'producer', 'key-dyroymat')").run();
    ok(ids(search("dyrøymat nord")).includes("dyroymat") && ftsCount() === agentCount() + 1, "INSERT OR REPLACE: new name found, stale extra index row");
    ok(fts.syncAgentsNameFts(db).rebuilt && ftsCount() === agentCount(), "sync removes the stale row");

    // ── (8) migration idempotent, populates an empty index ──
    quiet();
    let m1: ReturnType<typeof fts.ensureAgentsNameFts> = null, m2: typeof m1 = null, m3: typeof m1 = null;
    try {
      m1 = fts.ensureAgentsNameFts(db);
      m2 = fts.ensureAgentsNameFts(db);
      db.exec(`DELETE FROM ${fts.NAME_FTS_TABLE}`);
      m3 = fts.ensureAgentsNameFts(db);
    } finally { loud(); }
    ok(!!m1 && !m1.rebuilt && !!m2 && !m2.rebuilt, "ensure twice on a synced DB: no-op");
    ok(!!m3 && m3.rebuilt && m3.indexed === 0 && ftsCount() === agentCount(), "ensure populates an empty index");
    // a DB that predates S3 (no table, no triggers) gets both and a full index
    db.exec("DROP TRIGGER agents_name_fts_ai; DROP TRIGGER agents_name_fts_ad; DROP TRIGGER agents_name_fts_au; DROP TABLE agents_name_fts;");
    quiet();
    try { m1 = fts.ensureAgentsNameFts(db); } finally { loud(); }
    ok(!!m1 && m1.rebuilt && ftsCount() === agentCount() && ids(search("bjørndal")).includes("bjorndal"), "ensure on a pre-S3 DB creates and fills the index");
    // creation is atomic: if a trigger cannot be created, no table is left behind
    const bare = new Database(":memory:");
    quiet();
    try { m1 = fts.ensureAgentsNameFts(bare); } finally { loud(); }
    ok(m1 === null && !bare.prepare("SELECT 1 FROM sqlite_master WHERE name = 'agents_name_fts'").get(), "failed migration leaves no table without triggers");
    bare.close();
    let threw = false;
    quiet();
    try { m1 = fts.ensureAgentsNameFts({ transaction() { throw new Error("no such module: fts5"); } } as any); } catch { threw = true; } finally { loud(); }
    ok(!threw && m1 === null, "FTS5 unavailable → ensure returns null, no throw");
    const s = fts.syncAgentsNameFts({ prepare() { throw new Error("no such table: agents_name_fts"); } } as any);
    ok(!!s.error && !s.rebuilt, "syncAgentsNameFts reports errors instead of throwing");

    // ── (9) fallback: broken or dropped index → full scan, same results ──
    setFts(false); const ref = search("bjørndal gård"); setFts(true);
    db.exec("DROP TRIGGER agents_name_fts_ai; DROP TRIGGER agents_name_fts_ad; DROP TRIGGER agents_name_fts_au; DROP TABLE agents_name_fts;");
    let r: ReturnType<typeof search> | null = null;
    threw = false;
    try { r = search("bjørndal gård"); } catch { threw = true; }
    ok(!threw && !!r && !r.viaFts && JSON.stringify(r.results) === JSON.stringify(ref.results), "index dropped (rollback recipe) → full scan, same results");
    threw = false;
    try { seed(db, [{ id: "after-rollback", name: "Etter Rollback Gård" }]); db.prepare("UPDATE agents SET name = 'Etter Rollback' WHERE id = 'after-rollback'").run(); db.prepare("DELETE FROM agents WHERE id = 'after-rollback'").run(); } catch { threw = true; }
    ok(!threw, "agents writes work after the rollback recipe");
    db.exec("CREATE TABLE agents_name_fts (agent_id TEXT, name TEXT)"); // not FTS: MATCH fails
    threw = false;
    try { r = search("bjørndal gård"); } catch { threw = true; }
    ok(!threw && !!r && !r.viaFts && JSON.stringify(r.results) === JSON.stringify(ref.results), "broken index (MATCH throws) → full scan, same results");
  } catch (err) {
    loud();
    failed++;
    failures.push(`✗ unexpected error: ${(err as Error)?.stack ?? err}`);
  } finally {
    loud();
    if (prevEnv === undefined) delete process.env.RFB_NAME_FTS; else process.env.RFB_NAME_FTS = prevEnv;
    __setDbForTesting(prevDb as Database.Database);
    try { db.close(); } catch { /* ignore */ }
  }
  return { passed, failed, failures };
}

if (require.main === module) {
  const r = runNameSearchFtsTests({ log: true });
  console.log(`\nname-search-fts: ${r.passed} passed, ${r.failed} failed`);
  for (const f of r.failures) console.log(f);
  process.exit(r.failed > 0 ? 1 : 0);
}
