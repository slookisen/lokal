/**
 * admin-bm-producer-harvest-fill-only.test.ts — GET /admin/bm-producer-harvest
 * `fill_only` query param and `scope_agent_ids` body (dev-request
 * 2026-10-10-rfb-berikelse-nattjobb; prod incident 2026-10-11: a manual
 * apply run replaced 7 stored contact_email values and 2 phones).
 *
 *   f1 parseBmHarvestFillOnly / parseBmHarvestScope
 *   f2 (a) fill_only=1 + a different stored e-mail → skipped_not_empty, value
 *      untouched, no audit row; same for phone → phone_skipped_not_empty
 *   f3 (b) fill_only=1 + blank e-mail / phone → written exactly as before
 *      (audit row); an equal value is still skipped_unchanged
 *   f4 (c) the DEFAULT (no param) is unchanged and still REPLACES a different
 *      stored e-mail and phone — pinned here on purpose: changing the default
 *      is Daniel's decision, and this test must change with it
 *   f5 the dry-run branch reports the same fill-only decisions; without the
 *      param its counts are today's
 *   f6 scope_agent_ids: a matched agent outside the scope → skipped_out_of_
 *      scope, nothing written or queued; dry-run counts it
 *   f7 a repeated (array-valued) or nested dry_run / limit / offset /
 *      fill_only → 400 before any fetch or write (it used to fall back to
 *      the overwriting default silently)
 *
 * Fresh in-memory DB per scenario (pinned + restored), stubbed global fetch.
 * Standalone: npx tsx src/routes/admin-bm-producer-harvest-fill-only.test.ts
 */

import * as initMod from "../database/init";
import router, { parseBmHarvestFillOnly, parseBmHarvestScope } from "./admin-bm-producer-harvest";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

function callRoute(
  routerInstance: any,
  opts: { headers: Record<string, string>; query: Record<string, string>; body?: unknown },
): Promise<{ status: number; body: any }> {
  return new Promise((resolve) => {
    const headers = opts.headers;
    const req: any = {
      method: "GET",
      url: "/",
      originalUrl: "/",
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

const ld = (name: string, city: string) =>
  JSON.stringify({
    "@context": "https://schema.org",
    "@type": "LocalBusiness",
    name,
    address: { "@type": "PostalAddress", addressLocality: city, addressCountry: "NO" },
  });
const page = (name: string, email: string | null, phone: string | null) =>
  `<script type="application/ld+json">${ld(name, "Bostad")}</script>` +
  (email ? `<a href="mailto:${email}">${email}</a>` : "") +
  (phone ? `<a href="tel:${phone}">${phone}</a>` : "");

const PAGES: Record<string, string> = {
  "fodiff-gard": page("Fodiff Gård", "new@fodiff.no", "+4792222222"),
  "foblank-gard": page("Foblank Gård", "post@foblank.no", "+4793333333"),
  "fosame-gard": page("Fosame Gård", "same@fosame.no", null),
  "foout-gard": page("Foout Gård", "post@foout.no", "+4794444444"),
};
const SLUGS = Object.keys(PAGES);

export async function runAdminBmProducerHarvestFillOnlyTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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

  // f1 — pure parsers
  assertEq(
    ["1", "true", "TRUE", " 1 ", "0", "yes", "", undefined, ["1"], 1].map((v) => parseBmHarvestFillOnly(v as unknown)),
    [true, true, true, true, false, false, false, false, false, false],
    "f1: fill_only is on only for \"1\"/\"true\"",
  );
  assertEq(
    [parseBmHarvestScope(undefined), parseBmHarvestScope({}), parseBmHarvestScope({ scope_agent_ids: "a" })],
    [null, null, null],
    "f1: no / non-array scope = no restriction",
  );
  assertEq(Array.from(parseBmHarvestScope({ scope_agent_ids: ["a", " b ", "", 3] }) ?? []), ["a", "b"], "f1: scope = the non-empty string ids");
  assertEq(parseBmHarvestScope({ scope_agent_ids: [] })?.size, 0, "f1: an empty array is an empty scope (nothing may be written)");

  const key = process.env.ADMIN_KEY || "bm-fill-only-test-key";
  const prevAdminKey = process.env.ADMIN_KEY;
  process.env.ADMIN_KEY = key;
  const auth = { "x-admin-key": key };
  const prevFetch = globalThis.fetch;
  const sitemap = `<urlset>${SLUGS.map((s) => `<url><loc>https://bondensmarked.no/produsenter/${s}</loc></url>`).join("")}</urlset>`;
  let fetchCount = 0;
  (globalThis as any).fetch = async (url: any) => {
    fetchCount++;
    const u = String(url);
    if (u === "https://bondensmarked.no/sitemap.xml") return new Response(sitemap, { status: 200 });
    const m = /\/produsenter\/([a-z0-9-]+)$/.exec(u);
    if (m && PAGES[m[1]]) return new Response(PAGES[m[1]], { status: 200, headers: { "content-type": "text/html" } });
    return new Response("not found", { status: 404 });
  };

  let db: any = null;
  const scenario = async (label: string, fn: () => Promise<void>) => {
    const restore = initMod.__pinInMemoryDbForTesting();
    db = initMod.getDb();
    const insA = db.prepare(
      `INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, city) VALUES (?, ?, 'd', 'p', ?, '', 'producer', ?, 'Bostad')`,
    );
    insA.run("a-diff", "Fodiff Gård", "old@fodiff.no", "k-diff");
    insA.run("a-blank", "Foblank Gård", "", "k-blank");
    insA.run("a-same", "Fosame Gård", "SAME@fosame.no", "k-same");
    insA.run("a-out", "Foout Gård", "", "k-out");
    const insK = db.prepare(`INSERT INTO agent_knowledge (agent_id, phone, curated_fields) VALUES (?, ?, '{}')`);
    insK.run("a-diff", "+4791111111");
    insK.run("a-blank", null);
    insK.run("a-same", null);
    insK.run("a-out", null);
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
  const get = (query: Record<string, string>, body?: unknown) => callRoute(router, { headers: auth, query, body });
  const email = (id: string) => (db.prepare(`SELECT contact_email AS e FROM agents WHERE id = ?`).get(id) as { e: string }).e;
  const phone = (id: string) => (db.prepare(`SELECT phone AS p FROM agent_knowledge WHERE agent_id = ?`).get(id) as { p: string | null }).p;
  const audits = (id: string, field: string) =>
    (db.prepare(`SELECT COUNT(*) AS c FROM agent_knowledge_audit WHERE agent_id = ? AND field_name = ?`).get(id, field) as { c: number }).c;
  const result = (body: any, slug: string) => (body?.results ?? []).find((r: any) => r.slug === slug);

  try {
    // (a) + (b): fill_only=1
    await scenario("fill_only apply", async () => {
      const r = await get({ dry_run: "false", limit: "10", fill_only: "1" });
      assertEq([r.status, r.body?.fill_only], [200, true], "f2: fill_only is echoed");
      const d = result(r.body, "fodiff-gard");
      assertEq([d?.outcome, d?.old_value, d?.new_value], ["skipped_not_empty", "old@fodiff.no", "new@fodiff.no"], "f2 (a): a different stored e-mail → skipped_not_empty");
      assertEq([email("a-diff"), audits("a-diff", "contact_email")], ["old@fodiff.no", 0], "f2 (a): the stored e-mail is untouched and no audit row is written");
      assertEq([d?.phone_outcome, phone("a-diff"), audits("a-diff", "phone")], ["phone_skipped_not_empty", "+4791111111", 0], "f2 (a): a different stored phone → phone_skipped_not_empty, untouched, no audit row");
      const b = result(r.body, "foblank-gard");
      assertEq([b?.outcome, email("a-blank"), audits("a-blank", "contact_email")], ["written", "post@foblank.no", 1], "f3 (b): a blank e-mail is written as before (+ audit row)");
      assertEq([b?.phone_outcome, phone("a-blank"), audits("a-blank", "phone")], ["phone_written", "+4793333333", 1], "f3 (b): a blank phone is written as before (+ audit row)");
      assertEq(result(r.body, "fosame-gard")?.outcome, "skipped_unchanged", "f3: an equal stored value is still skipped_unchanged, not skipped_not_empty");
      assertEq([r.body?.counts?.skipped_not_empty, r.body?.counts?.phone_skipped_not_empty, r.body?.counts?.written], [1, 1, 2], "f3: counts carry the new outcomes");
    });

    // (c): default — pinned, still overwrites
    await scenario("default apply", async () => {
      const r = await get({ dry_run: "false", limit: "10" });
      assertEq(r.body?.fill_only, false, "f4: fill_only absent → false");
      const d = result(r.body, "fodiff-gard");
      assertEq([d?.outcome, d?.old_value, email("a-diff"), audits("a-diff", "contact_email")], ["written", "old@fodiff.no", "new@fodiff.no", 1], "f4 (c): the DEFAULT still replaces a different stored e-mail (unchanged behaviour)");
      assertEq([d?.phone_outcome, phone("a-diff")], ["phone_written", "+4792222222"], "f4 (c): the DEFAULT still replaces a different stored phone");
      assertEq(r.body?.counts?.skipped_not_empty, undefined, "f4 (c): no fill-only outcome appears without the param");
    });

    // dry-run mirrors the decisions
    await scenario("dry-run", async () => {
      const plain = await get({ limit: "10" });
      assertEq(
        [plain.body?.fill_only, plain.body?.would_write_estimate?.email, plain.body?.would_write_estimate?.phone, "would_skip_not_empty" in (plain.body ?? {})],
        [false, 3, 3, false],
        "f5: dry-run without fill_only: today's counts (e-mail: diff+blank+out; every BM phone), no new key",
      );
      const fo = await get({ limit: "10", fill_only: "true" });
      assertEq(
        [fo.body?.fill_only, fo.body?.would_write_estimate?.email, fo.body?.would_skip_not_empty?.email, fo.body?.would_write_estimate?.phone, fo.body?.would_skip_not_empty?.phone],
        [true, 2, 1, 2, 1],
        "f5: dry-run with fill_only reports the apply branch's decisions (blank → write, different → skipped_not_empty)",
      );
      assertEq([email("a-diff"), email("a-blank"), phone("a-diff"), phone("a-blank")], ["old@fodiff.no", "", "+4791111111", null], "f5: the dry run wrote nothing");
    });

    // scope_agent_ids
    await scenario("scope", async () => {
      const dry = await get({ limit: "10" }, { scope_agent_ids: ["a-blank"] });
      assertEq([dry.body?.scope_size, dry.body?.out_of_scope, dry.body?.would_write_estimate?.email], [1, 3, 1], "f6: the dry run counts out-of-scope matches and leaves them out of the estimate");
      const r = await get({ dry_run: "false", limit: "10", fill_only: "1" }, { scope_agent_ids: ["a-diff", "a-blank", "a-same"] });
      const o = result(r.body, "foout-gard");
      assertEq([o?.outcome, o?.agent_id, o?.phone_outcome, o?.url_outcome], ["skipped_out_of_scope", "a-out", undefined, undefined], "f6: a matched agent outside the scope → skipped_out_of_scope, no other attempt");
      assertEq([email("a-out"), phone("a-out"), audits("a-out", "contact_email")], ["", null, 0], "f6: nothing written for it");
      assertEq([r.body?.scope_size, result(r.body, "foblank-gard")?.outcome], [3, "written"], "f6: in-scope rows are processed as usual");
    });

    // f7: repeated / nested params are refused, never silently defaulted
    await scenario("repeated params", async () => {
      const before = fetchCount;
      const cases: Array<[string, Record<string, any>]> = [
        ["fill_only", { dry_run: "false", fill_only: ["1", "1"] }],
        ["offset", { dry_run: "false", fill_only: "1", offset: ["0", "60"] }],
        ["limit", { dry_run: "false", fill_only: "1", limit: ["5", "6"] }],
        ["dry_run", { dry_run: ["false", "false"], fill_only: "1" }],
        ["fill_only", { dry_run: "false", fill_only: { a: "1" } }],
      ];
      const got: Array<[number, string | undefined]> = [];
      for (const [, q] of cases) {
        const r = await get(q as Record<string, string>);
        got.push([r.status, r.body?.param]);
      }
      assertEq(got, cases.map(([name]) => [400, name]), "f7: an array-valued / nested dry_run, limit, offset or fill_only → 400 naming the param");
      assertEq([fetchCount - before, email("a-diff"), phone("a-diff")], [0, "old@fodiff.no", "+4791111111"], "f7: refused before any fetch or write");
      const ok = await get({ dry_run: "false", fill_only: "1", limit: "1", offset: "0" });
      assertEq(ok.status, 200, "f7: single values still work");
    });
  } finally {
    (globalThis as any).fetch = prevFetch;
    if (prevAdminKey === undefined) delete process.env.ADMIN_KEY;
    else process.env.ADMIN_KEY = prevAdminKey;
  }
  return { passed, failed, failures };
}

if (require.main === module) {
  runAdminBmProducerHarvestFillOnlyTests({ log: true }).then((r) => {
    console.log(`\nadmin-bm-producer-harvest-fill-only: ${r.passed} passed, ${r.failed} failed`);
    if (r.failed > 0) {
      for (const f of r.failures) console.log(f);
      process.exit(1);
    }
    process.exit(0);
  });
}
