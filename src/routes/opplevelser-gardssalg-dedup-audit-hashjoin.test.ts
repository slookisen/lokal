/**
 * Golden + perf tests for the hash-join rewrite of the out_of_scope_twins
 * computation behind GET /admin/gardssalg-provider-dedup-audit
 * (dev-request 2026-10-01-opplevagent-dedup-audit-hash-join).
 *
 * Golden: gsDedupComputeOutOfScopeTwins (linear) must equal
 * gsDedupComputeOutOfScopeTwinsLegacy (the verbatim old O(n*m) loop) on a
 * synthetic fixture of >= 2000 rows; groups are computed by the shared
 * gsDedupComputeGroups (logic unchanged, only extracted) and checked for
 * determinism/sanity. Also proves the name_exact key is equivalent to the
 * old scoreNameMatch>=1.0 test, and a 5000 x 5000 perf bound (< 1 s).
 */
import {
  gsDedupComputeGroups,
  gsDedupComputeOutOfScopeTwins,
  gsDedupComputeOutOfScopeTwinsLegacy,
  gsDedupNameExactKeys,
  gsDedupBestNameTier,
  type GsDedupRow,
} from "./opplevelser";

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FIRST = ["Himkok", "Kinn", "Ægir", "Wilsgård", "Fjording", "Søndre", "Ås", "Nordic", "Solbær", "Haugen", "Berg", "Lia"];
const SECOND = ["Bryggeri", "Gård", "Ysteri", "Gardsmat", "Holding", "Gruppen", "Norge", "Supply Company", "Sider"];
const LEGAL = ["", "", " AS", " as", " ASA", " DA", " ANS", " ENK", " Stiftelse"];
const SUFFIX = ["", "", "", " — Flåm", " - Torsken", " – Kinn"];
const POST = ["5700", "6900", "0155", "5003", null, "", " 5700 "];
const DOMAINS = ["himkok.no", "kinn.no", "aegir.no", "wilsgard.no", "fjording.no", "hanen.no", "x.co.uk", "solbaer.no"];

const blank = (id: string, navn: string, extra: Partial<GsDedupRow> = {}): GsDedupRow => ({
  id, navn, org_nr: null, hjemmeside: null, epost: null, telefon: null, postnummer: null,
  rfb_seed_source: null, producer_type: null, content_source: null, homepage_unreachable_since: null, ...extra,
});

export function buildDedupFixture(nIn: number, nOut: number, seed = 42, sparse = false): { rows: GsDedupRow[]; out: GsDedupRow[] } {
  const r = rng(seed);
  const pick = <T>(a: readonly T[]): T => a[Math.floor(r() * a.length)];
  let seq = 0;
  const mk = (prefix: string, unique: boolean): GsDedupRow => {
    const n = seq++;
    // unique names (numeric token) make most rows non-matching; collisions
    // come from the small-vocabulary branch.
    const base = unique || (sparse && r() > 0.05) ?`${pick(FIRST)} ${n}` : `${pick(FIRST)} ${pick(SECOND)}`;
    const navn = base + pick(LEGAL) + pick(SUFFIX);
    const useOrg = r() < 0.15;
    const useDom = r() < 0.3;
    const dom = sparse ? `d${Math.floor(r() * 3000)}.no` : pick(DOMAINS);
    const hj = !useDom
      ? r() < 0.1 ? "" : null
      : pick([`https://www.${dom}/om-oss`, `http://${dom}`, `${dom}/x?y=1`, `HTTPS://${dom.toUpperCase()}/`]);
    return blank(`${prefix}${n}`, navn, {
      org_nr: useOrg ? pick(["", " ", "912345678", " 912345678 ", "923456789", "934567890", `9${100000000 + Math.floor(r() * (sparse ? 20000 : 400))}`]) : null,
      hjemmeside: hj,
      epost: r() < 0.5 ? "a@b.no" : null,
      telefon: r() < 0.5 ? "12345678" : null,
      postnummer: pick(POST),
      rfb_seed_source: r() < 0.5 ? "rfb-seed" : null,
      producer_type: r() < 0.5 ? "gardssalg" : null,
      homepage_unreachable_since: r() < 0.1 ? "2026-09-01" : null,
    });
  };
  const rows: GsDedupRow[] = [];
  for (let i = 0; i < nIn; i++) rows.push(mk("in-", r() < 0.5));
  const out: GsDedupRow[] = [];
  for (let i = 0; i < nOut; i++) out.push(mk("out-", r() < 0.5));
  // deterministic hand-placed cases
  rows.push(blank("g-in-org", "Totally Different A", { org_nr: "999000111" }));
  out.push(blank("g-out-org", "Totally Different B", { org_nr: " 999000111 " }));
  rows.push(blank("g-in-dom", "Domain One", { hjemmeside: "https://www.uniq-dom.no/a" }));
  out.push(blank("g-out-dom", "Domain Two", { hjemmeside: "http://uniq-dom.no" }));
  rows.push(blank("g-in-name", "Ægir Bryggeri — Flåm", { postnummer: "5700" }));
  out.push(blank("g-out-name", "Ægir Bryggeri AS", { postnummer: "9999" })); // postcode differs: still exact
  rows.push(blank("g-in-post", "Postal Only Gård", { postnummer: "1111" }));
  out.push(blank("g-out-post", "Postal Only Sider", { postnummer: "1111" })); // 0.95 tier: NOT a twin
  rows.push(blank("g-in-multi", "Multi Signal Farm", { org_nr: "888", hjemmeside: "multi.no" }));
  out.push(blank("g-out-multi", "multi signal farm as", { org_nr: "888", hjemmeside: "www.multi.no" }));
  return { rows, out };
}

export function runOpplevelserGardssalgDedupAuditHashJoinTests(opts: { log?: boolean } = {}): {
  passed: number; failed: number; failures: string[];
} {
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];
  const check = (cond: boolean, msg: string) => {
    if (cond) passed++;
    else { failed++; failures.push(msg); if (opts.log) console.error("FAIL:", msg); }
  };

  // ── Golden ──
  for (const [seed, nIn, nOut] of [[42, 1500, 800], [7, 600, 400], [12345, 600, 400]]) {
    const { rows, out } = buildDedupFixture(nIn, nOut, seed);
    if (seed === 42) check(rows.length + out.length >= 2000, "fixture size >= 2000");
    const legacy = gsDedupComputeOutOfScopeTwinsLegacy(rows, out);
    const fast = gsDedupComputeOutOfScopeTwins(rows, out);
    check(legacy.length > 50, `fixture produces many twins (seed ${seed}, got ${legacy.length})`);
    check(JSON.stringify(legacy) === JSON.stringify(fast), `golden: out_of_scope_twins identical incl. order (seed ${seed})`);
    const sigs = new Set(legacy.map((t) => t.signals.join("+")));
    for (const s of ["org_nr", "domain", "name_exact", "org_nr+domain+name_exact"]) {
      check(sigs.has(s), `fixture covers signal combo ${s} (seed ${seed})`);
    }
    const nonMatching = out.filter((o) => !legacy.some((t) => t.out_of_scope.id === o.id));
    check(nonMatching.length > 0, `fixture contains non-matching out-of-scope rows (seed ${seed})`);
    const hand = (id: string) => fast.filter((t) => t.out_of_scope.id === id && t.in_scope.id.startsWith("g-in"));
    check(hand("g-out-org").some((t) => t.signals.join() === "org_nr"), "hand case: org_nr");
    check(hand("g-out-dom").some((t) => t.signals.join() === "domain"), "hand case: domain");
    check(hand("g-out-name").some((t) => t.signals.join() === "name_exact"), "hand case: name_exact despite postcode mismatch");
    check(hand("g-out-post").length === 0, "hand case: postal-only 0.95 tier is not a twin");
    check(hand("g-out-multi").some((t) => t.signals.join() === "org_nr,domain,name_exact"), "hand case: all three signals in order");

    const g1 = gsDedupComputeGroups(rows.slice(0, 300));
    const g2 = gsDedupComputeGroups(rows.slice(0, 300));
    check(g1.length > 0 && JSON.stringify(g1) === JSON.stringify(g2), `groups deterministic and non-empty (seed ${seed})`);
    check(g1.every((g) => g.rows.length >= 2), `every group has >= 2 rows (seed ${seed})`);
  }

  // ── name_exact key == old pairwise test, over a name x name x postcode grid ──
  {
    const names: string[] = [];
    for (const f of ["Ægir", "Kinn"]) for (const s of SECOND.concat([""])) for (const l of LEGAL) for (const x of SUFFIX) names.push(f + (s ? " " + s : "") + l + x);
    names.push("", "   ", "AS", "— Flåm", "A — AS", "Æ", "ae");
    const keys = names.map((n) => new Set(gsDedupNameExactKeys(n)));
    let mismatches = 0;
    const pcs: Array<[string | null, string | null]> = [[null, null], ["5700", "5700"], ["5700", "1"]];
    for (let i = 0; i < names.length; i += 10) {
      for (let j = 0; j < names.length; j++) {
        let keyHit = false;
        for (const k of keys[i]) if (keys[j].has(k)) { keyHit = true; break; }
        for (const [pa, pb] of pcs) {
          const old = gsDedupBestNameTier(blank("a", names[i], { postnummer: pa }), blank("b", names[j], { postnummer: pb })) === "name_exact";
          if (old !== keyHit) mismatches++;
        }
      }
    }
    check(mismatches === 0, `name_exact key == scoreNameMatch>=1.0 over name x name x postcode grid (mismatches: ${mismatches})`);
  }

  // ── Perf: 5000 x 5000 < 1 s ──
  {
    const { rows, out } = buildDedupFixture(5000, 5000, 99, true);
    const t0 = process.hrtime.bigint();
    const res = gsDedupComputeOutOfScopeTwins(rows, out);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    if (opts.log) console.log(`perf: 5000x5000 -> ${res.length} twins in ${ms.toFixed(0)} ms`);
    check(ms < 1000, `perf: 5000x5000 hash-join < 1000 ms (took ${ms.toFixed(0)} ms)`);
  }

  return { passed, failed, failures };
}

if (require.main === module) {
  const s = runOpplevelserGardssalgDedupAuditHashJoinTests({ log: true });
  console.log(`\n${s.passed} passed, ${s.failed} failed`);
  process.exit(s.failed > 0 ? 1 : 0);
}
