/**
 * admin-bm-producer-harvest-candidates-b2.test.ts — dev-request
 * 2026-11-15-rfb-nattjobb-hull-kontaktuttrekk-bm-og-koer, slice B2:
 * Bondens Marked pages without a profile are kept as candidates.
 *
 *   c1 bmCompactName / findKnownBmProducerVariant (pure + read-only)
 *   c2 apply: an unmatched page → candidate_stored, one row with name, city,
 *      BM page, website, first_seen = last_seen, seen_count 1; counts carry it
 *   c3 apply again: same row, seen_count 2, first_seen unchanged, last_seen moves
 *   c4 a known producer under another spelling (legal suffix, «Gård»/«Gard»,
 *      a different BM city, an inactive profile) → candidate_known_variant,
 *      kept stamped (matched_via name_variant), never on the default list;
 *      a candidate listed earlier is stamped once a variant profile exists
 *      (review B1 on lokal#1590); the first stamp is kept
 *   c5 a matched page is never stored; a listed slug that matches later is
 *      stamped and leaves the default list (include_matched=1 shows it)
 *   c6 the dry-run branch writes no candidate row
 *   c7 GET /unmatched-candidates: auth, limit, repeated params → 400
 *   c8 a throwing candidate write does not change the harvest result
 *
 * Fresh in-memory DB per scenario (pinned + restored), stubbed global fetch.
 * Standalone: npx tsx src/routes/admin-bm-producer-harvest-candidates-b2.test.ts
 */

import * as initMod from "../database/init";
import router from "./admin-bm-producer-harvest";
import {
  bmCompactName,
  findKnownBmProducerVariant,
  BM_CANDIDATES_MAX_LIMIT,
} from "../services/bm-unmatched-candidates";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

function callRoute(
  routerInstance: any,
  opts: { url?: string; headers: Record<string, string>; query: Record<string, unknown>; body?: unknown },
): Promise<{ status: number; body: any }> {
  return new Promise((resolve) => {
    const headers = opts.headers;
    const url = opts.url ?? "/";
    const req: any = {
      method: "GET",
      url,
      originalUrl: url,
      query: opts.query,
      headers,
      body: opts.body,
      ip: "127.0.0.1",
      get(name: string) {
        return headers[name.toLowerCase()];
      },
    };
    const res: any = {
      statusCode: 200,
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      json(payload: any) {
        resolve({ status: this.statusCode, body: payload });
        return this;
      },
    };
    routerInstance.handle(req, res, (err?: any) => resolve({ status: err ? 500 : 404, body: { error: String(err ?? "unmatched") } }));
  });
}

const page = (name: string, city: string, website: string | null) =>
  `<script type="application/ld+json">${JSON.stringify({
    "@context": "https://schema.org",
    "@type": "LocalBusiness",
    name,
    ...(website ? { url: website } : {}),
    address: { "@type": "PostalAddress", addressLocality: city, addressCountry: "NO" },
  })}</script>`;

// Profiles in the DB (see scenario): «Kjent Gård AS» (Bostad, active),
// «Sovende Bigård» (Lom, inactive), «Treff Gård» (Bostad, active).
const PAGES: Record<string, string> = {
  // no profile at all → candidate
  "nyhage-gard": page("Nyhage Gård", "Voss", "https://nyhage.example.no"),
  // «Kjent Gård AS» with another suffix/spelling and another BM city → strict matcher says unmatched
  "kjent-gard": page("Kjent Gard", "Oslo", null),
  // inactive profile, other city → known variant
  "sovende-bigard": page("Sovende Bigard", "Skjåk", null),
  // exact strict match (name + city) → matched, never a candidate
  "treff-gard": page("Treff Gård", "Bostad", null),
};
const SLUGS = Object.keys(PAGES);

export async function runAdminBmProducerHarvestCandidatesB2Tests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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

  // c1 — pure name folding
  assertEq(bmCompactName("Kjent Gård AS"), bmCompactName("Kjent Gard"), "c1: legal suffix and å/a fold to the same compact name");
  assertEq(bmCompactName("Kjent-Gård, A/S".replace("A/S", "AS")), bmCompactName("kjent gard"), "c1: punctuation and case are ignored");
  assertEq(bmCompactName("Nyhage Gård") === bmCompactName("Kjent Gård"), false, "c1: different names stay different");
  assertEq(bmCompactName("   "), "", "c1: blank name → empty");
  assertEq(bmCompactName("Ny hage Gård"), bmCompactName("Nyhage Gard"), "c1: spaces are ignored in the compact form");

  const key = process.env.ADMIN_KEY || "bm-candidates-b2-test-key";
  const prevAdminKey = process.env.ADMIN_KEY;
  process.env.ADMIN_KEY = key;
  const auth = { "x-admin-key": key };
  const prevFetch = globalThis.fetch;
  const sitemap = `<urlset>${SLUGS.map((s) => `<url><loc>https://bondensmarked.no/produsenter/${s}</loc></url>`).join("")}</urlset>`;
  const pages: Record<string, string> = { ...PAGES };
  (globalThis as any).fetch = async (url: any) => {
    const u = String(url);
    if (u === "https://bondensmarked.no/sitemap.xml") return new Response(sitemap, { status: 200 });
    const m = /\/produsenter\/([a-z0-9-]+)$/.exec(u);
    if (m && pages[m[1]]) return new Response(pages[m[1]], { status: 200, headers: { "content-type": "text/html" } });
    // website probes from the url step of matched rows
    return new Response("not found", { status: 404 });
  };

  let db: any = null;
  const scenario = async (label: string, fn: () => Promise<void>) => {
    const restore = initMod.__pinInMemoryDbForTesting();
    db = initMod.getDb();
    const insA = db.prepare(
      `INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, city, is_active) VALUES (?, ?, 'd', 'p', '', '', 'producer', ?, ?, ?)`,
    );
    insA.run("a-kjent", "Kjent Gård AS", "k-kjent", "Bostad", 1);
    insA.run("a-sov", "Sovende Bigård", "k-sov", "Lom", 0);
    insA.run("a-treff", "Treff Gård", "k-treff", "Bostad", 1);
    const insK = db.prepare(`INSERT INTO agent_knowledge (agent_id, website, curated_fields) VALUES (?, 'https://har.example.no', '{}')`);
    insK.run("a-kjent");
    insK.run("a-sov");
    insK.run("a-treff");
    try {
      await fn();
    } catch (err) {
      failed++;
      failures.push(`${label}: unexpected error: ${err instanceof Error ? err.stack || err.message : String(err)}`);
    } finally {
      restore();
      db = null;
    }
  };
  const harvest = (query: Record<string, string>) => callRoute(router, { headers: auth, query });
  const list = (query: Record<string, unknown> = {}, headers: Record<string, string> = auth) =>
    callRoute(router, { url: "/unmatched-candidates", headers, query });
  const rows = () => db.prepare(`SELECT * FROM bm_unmatched_candidates ORDER BY slug`).all() as any[];
  const result = (body: any, slug: string) => (body?.results ?? []).find((r: any) => r.slug === slug);

  try {
    await scenario("c1 db", async () => {
      assertEq(findKnownBmProducerVariant(db, "Kjent Gard")?.agentId, "a-kjent", "c1: «Kjent Gard» is the known profile «Kjent Gård AS»");
      assertEq(findKnownBmProducerVariant(db, "Sovende Bigard")?.agentId, "a-sov", "c1: an inactive profile still counts as known");
      assertEq(findKnownBmProducerVariant(db, "Nyhage Gård"), null, "c1: an unknown name has no variant");
      assertEq(findKnownBmProducerVariant(db, ""), null, "c1: an empty name has no variant");
      assertEq(findKnownBmProducerVariant(db, "  ,. "), null, "c1: a punctuation-only name has no variant");
      assertEq(findKnownBmProducerVariant(db, "Tre ff Gård")?.agentId, "a-treff", "c1: a split word is the same compact name");
    });

    await scenario("c2-c5 apply", async () => {
      const r1 = await harvest({ dry_run: "false", limit: "10", fill_only: "1" });
      assertEq(r1.status, 200, "c2: apply answers 200");
      const ny = result(r1.body, "nyhage-gard");
      assertEq([ny?.outcome, ny?.candidate_outcome], ["unmatched", "candidate_stored"], "c2: an unmatched page is stored as a candidate (outcome unchanged)");
      const all1 = rows();
      assertEq(
        all1.map((x) => [x.slug, x.matched_agent_id, x.matched_via]),
        [["kjent-gard", "a-kjent", "name_variant"], ["nyhage-gard", null, null], ["sovende-bigard", "a-sov", "name_variant"]],
        "c2/c4/c5: the page with no profile is listed, variants are kept stamped, the matched page is not stored",
      );
      const n1 = all1.find((x) => x.slug === "nyhage-gard") ?? {};
      assertEq(
        [n1.name, n1.city, n1.source_url, n1.website, n1.seen_count, n1.first_seen === n1.last_seen, n1.matched_agent_id],
        ["Nyhage Gård", "Voss", "https://bondensmarked.no/produsenter/nyhage-gard", "https://nyhage.example.no", 1, true, null],
        "c2: the row has name, city, BM page, website, first_seen = last_seen, seen_count 1",
      );
      assertEq(r1.body?.counts?.candidate_stored, 1, "c2: counts carry candidate_stored");
      assertEq(r1.body?.counts?.candidate_known_variant, 2, "c4: counts carry candidate_known_variant");

      const kj = result(r1.body, "kjent-gard");
      assertEq([kj?.outcome, kj?.candidate_outcome, kj?.candidate_known_agent_id], ["unmatched", "candidate_known_variant", "a-kjent"], "c4: «Kjent Gard» (other suffix, other BM city) is a known variant, not a candidate");
      const sv = result(r1.body, "sovende-bigard");
      assertEq([sv?.candidate_outcome, sv?.candidate_known_agent_id], ["candidate_known_variant", "a-sov"], "c4: an inactive profile under another spelling is a known variant");
      const tr = result(r1.body, "treff-gard");
      assertEq([tr?.agent_id, tr?.candidate_outcome], ["a-treff", undefined], "c5: a matched page carries no candidate outcome");

      // c3 — second night
      db.prepare(`UPDATE bm_unmatched_candidates SET first_seen = '2026-11-01T00:00:00.000Z', last_seen = '2026-11-01T00:00:00.000Z'`).run();
      await harvest({ dry_run: "false", limit: "10", fill_only: "1" });
      const n2 = rows().find((x) => x.slug === "nyhage-gard") ?? {};
      assertEq([rows().length - 2, n2.seen_count, n2.first_seen, n2.last_seen > "2026-11-01T00:00:00.000Z"], [1, 2, "2026-11-01T00:00:00.000Z", true], "c3: same row, seen_count 2, first_seen kept, last_seen moves");

      // c7 — list
      const l1 = await list();
      assertEq([l1.status, l1.body?.total, l1.body?.candidates?.map((c: any) => c.slug)], [200, 1, ["nyhage-gard"]], "c7: GET lists the candidate");
      assertEq(
        Object.keys(l1.body?.candidates?.[0] ?? {}).sort(),
        ["city", "first_seen", "last_seen", "matched_agent_id", "matched_at", "matched_via", "name", "seen_count", "slug", "source_url", "website"],
        "c7: each row has name, city, page, website, first_seen, last_seen, seen_count",
      );

      // c5 — the producer gets a profile; next night the slug matches
      db.prepare(
        `INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, city, is_active) VALUES ('a-ny', 'Nyhage Gård', 'd', 'p', '', '', 'producer', 'k-ny', 'Voss', 1)`,
      ).run();
      db.prepare(`INSERT INTO agent_knowledge (agent_id, website, curated_fields) VALUES ('a-ny', 'https://nyhage.example.no', '{}')`).run();
      const r3 = await harvest({ dry_run: "false", limit: "10", fill_only: "1" });
      assertEq(result(r3.body, "nyhage-gard")?.agent_id, "a-ny", "c5: the slug now matches the new profile");
      const n3 = rows().find((x) => x.slug === "nyhage-gard") ?? {};
      assertEq([n3.matched_agent_id, n3.matched_via, typeof n3.matched_at, n3.seen_count], ["a-ny", "profile", "string", 2], "c5: the candidate is stamped matched, not deleted");
      const l2 = await list();
      assertEq([l2.body?.total, l2.body?.candidates?.length], [0, 0], "c5: a matched candidate leaves the default list");
      const l3 = await list({ include_matched: "1" });
      assertEq(
        [l3.body?.total, l3.body?.include_matched, (l3.body?.candidates ?? []).find((c: any) => c.slug === "nyhage-gard")?.matched_agent_id],
        [3, true, "a-ny"],
        "c5: include_matched=1 shows it (and the stamped variants)",
      );
      const kj3 = rows().find((x) => x.slug === "kjent-gard") ?? {};
      assertEq([kj3.matched_agent_id, kj3.matched_via, kj3.seen_count], ["a-kjent", "name_variant", 3], "c4: a variant row keeps its first stamp over later nights");
    });

    await scenario("c4 B1 variant appears later", async () => {
      // night 1: no profile → listed
      await harvest({ dry_run: "false", limit: "10", fill_only: "1" });
      assertEq((await list()).body?.candidates?.map((c: any) => c.slug), ["nyhage-gard"], "c4/B1: listed on night 1");
      // discovery registers it under another spelling and its home city, not the BM city
      db.prepare(
        `INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, city, is_active) VALUES ('a-ny2', 'Nyhage Gard AS', 'd', 'p', '', '', 'producer', 'k-ny2', 'Bergen', 1)`,
      ).run();
      const r2 = await harvest({ dry_run: "false", limit: "10", fill_only: "1" });
      const ny = result(r2.body, "nyhage-gard");
      assertEq([ny?.outcome, ny?.candidate_outcome, ny?.candidate_known_agent_id], ["unmatched", "candidate_known_variant", "a-ny2"], "c4/B1: night 2 the page is a known variant");
      const row = rows().find((x) => x.slug === "nyhage-gard") ?? {};
      assertEq([row.matched_agent_id, row.matched_via, row.seen_count], ["a-ny2", "name_variant", 2], "c4/B1: the earlier candidate is stamped");
      assertEq((await list()).body?.total, 0, "c4/B1: a known name in another spelling is not on the list");
      // the variant profile disappears again (renamed) → the page is listed again, stamp cleared
      db.prepare(`UPDATE agents SET name = 'Helt Annet Navn' WHERE id = 'a-ny2'`).run();
      await harvest({ dry_run: "false", limit: "10", fill_only: "1" });
      const row3 = rows().find((x) => x.slug === "nyhage-gard") ?? {};
      assertEq([row3.matched_agent_id, row3.matched_via, row3.matched_at], [null, null, null], "c4: an unmatched page with no variant is listed again (stamp cleared)");
    });

    await scenario("c5 first profile stamp kept", async () => {
      db.prepare(
        `INSERT INTO bm_unmatched_candidates (slug, name, city, source_url, website, first_seen, last_seen, seen_count, matched_agent_id, matched_at, matched_via) VALUES ('treff-gard', 'Treff Gård', 'Bostad', 'x', NULL, 't', 't', 1, 'a-first', '2026-11-01T00:00:00.000Z', 'profile')`,
      ).run();
      await harvest({ dry_run: "false", limit: "10", fill_only: "1" });
      const row = rows().find((x) => x.slug === "treff-gard") ?? {};
      assertEq([row.matched_agent_id, row.matched_at], ["a-first", "2026-11-01T00:00:00.000Z"], "c5: a later match keeps the first stamp");
    });

    await scenario("c6 dry-run", async () => {
      const r = await harvest({ limit: "10" });
      assertEq(r.status, 200, "c6: dry-run answers 200");
      const exists = db.prepare(`SELECT COUNT(*) AS c FROM sqlite_master WHERE name = 'bm_unmatched_candidates'`).get().c;
      const n = exists ? (db.prepare(`SELECT COUNT(*) AS c FROM bm_unmatched_candidates`).get() as { c: number }).c : 0;
      assertEq(n, 0, "c6: the dry-run branch stores no candidate");
    });

    await scenario("c7 list params", async () => {
      const ins = db.prepare(
        `INSERT INTO bm_unmatched_candidates (slug, name, city, source_url, website, first_seen, last_seen, seen_count) VALUES (?, ?, NULL, ?, NULL, ?, ?, 1)`,
      );
      for (let i = 0; i < 5; i++) {
        const ts = `2026-11-1${i}T00:00:00.000Z`;
        ins.run(`s${i}`, `Navn ${i}`, `https://bondensmarked.no/produsenter/s${i}`, ts, ts);
      }
      const l = await list({ limit: "2" });
      assertEq([l.body?.total, l.body?.limit, l.body?.candidates?.map((c: any) => c.slug)], [5, 2, ["s4", "s3"]], "c7: limit applies, newest last_seen first, total is the full count");
      const big = await list({ limit: "99999" });
      assertEq(big.body?.limit, BM_CANDIDATES_MAX_LIMIT, "c7: limit is capped");
      const bad = await list({ limit: "abc" });
      assertEq(bad.body?.limit, 100, "c7: an unparseable limit is the default 100");
      const rep = await list({ limit: ["1", "2"] });
      assertEq(rep.status, 400, "c7: a repeated param → 400");
      const noKey = await list({}, {});
      assertEq(noKey.status, 403, "c7: no admin key → 403");
    });

    await scenario("c8 write error", async () => {
      db.exec(`DROP TABLE bm_unmatched_candidates; CREATE TABLE bm_unmatched_candidates (slug TEXT PRIMARY KEY)`);
      const r = await harvest({ dry_run: "false", limit: "10", fill_only: "1" });
      const ny = result(r.body, "nyhage-gard");
      assertEq([r.status, ny?.outcome, ny?.candidate_outcome, typeof ny?.candidate_detail], [200, "unmatched", "candidate_error", "string"], "c8: a failing candidate write is reported per row, the harvest still answers 200");
      assertEq(result(r.body, "treff-gard")?.agent_id, "a-treff", "c8: matched rows are unaffected (the stamp failure is swallowed)");
    });
  } finally {
    (globalThis as any).fetch = prevFetch;
    if (prevAdminKey === undefined) delete process.env.ADMIN_KEY;
    else process.env.ADMIN_KEY = prevAdminKey;
  }

  return { passed, failed, failures };
}

if (require.main === module) {
  runAdminBmProducerHarvestCandidatesB2Tests({ log: true }).then((s) => {
    console.log(`\n${s.passed} passed, ${s.failed} failed`);
    if (s.failed > 0) process.exit(1);
  });
}
