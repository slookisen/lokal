/**
 * admin-agents-duplicate-slugs.test.ts — tests for the READ-ONLY
 * GET /admin/agents/duplicate-slugs slug-collision detector.
 *
 * The route detects (never fixes) /produsent/<slug> collisions among ACTIVE
 * `agents` rows so a survivor/duplicate decision can be fed to the already
 * deployed POST /admin/agents/duplicate-merge, which by design never detects
 * anything itself.
 *
 * Setup: better-sqlite3 ":memory:" + __initSchemaForTesting, route pointed at
 * that DB through its own seam (__setDuplicateSlugsDbForTesting) — same
 * discipline as admin-agents-duplicate-merge.test.ts /
 * admin-agents-deactivate.test.ts: never pins the shared getDb() singleton.
 * Handler driven directly through router.handle() with a fake req/res — no
 * HTTP server.
 *
 * Covers:
 *   (a) two active rows whose names slugify identically -> one group, 2 rows
 *   (b) rows that slugify differently -> no group (no false positives)
 *   (c) is_active = 0 rows (already-merged duplicates) are excluded
 *   (d) sitemap_affected: umbrella / unvetted rows are reported but do NOT
 *       count toward the sitemap cohort; two vetted producers do
 *   (e) filled_fields / enrichment_depth counting, '' and NULL both blank
 *   (f) suggested_survivor_id ranking + tie -> null, tie: true
 *   (g) auth gate (missing key -> 403, wrong key -> 403, no ADMIN_KEY -> 503)
 *   (h) dupslug-write-freedom: agents + agent_knowledge + agent_knowledge_audit
 *       byte-identical before and after the call
 *   (i) slugify parity against the IMPORTED src/utils/slug slugify (the same
 *       function the sitemap generator uses) — never a local copy
 */

import Database from "better-sqlite3";
import * as initMod from "../database/init";
import { slugify } from "../utils/slug";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

interface RouteResult {
  status: number;
  body: any;
  ended: boolean;
}

function callRoute(
  router: any,
  opts: {
    method?: string;
    url: string;
    headers?: Record<string, string>;
    body?: any;
    query?: Record<string, string>;
  },
): Promise<RouteResult> {
  return new Promise((resolve) => {
    const headers = opts.headers || {};
    const req: any = {
      method: opts.method || "GET",
      url: opts.url,
      originalUrl: opts.url,
      query: opts.query || {},
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
        resolve({ status: this.statusCode, body: payload, ended: true });
        return this;
      },
      end() {
        resolve({ status: this.statusCode, body: undefined, ended: true });
        return this;
      },
    };
    router.handle(req, res, (err?: any) => {
      if (err) {
        resolve({ status: 500, body: { error: String(err) }, ended: true });
      } else {
        resolve({ status: 0, body: undefined, ended: false });
      }
    });
  });
}

export function runAdminAgentsDuplicateSlugsTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
    // SHARED-GLOBAL DISCIPLINE (tests/test.ts, "SHARED GLOBAL STATE"): never
    // reassign process.env.ADMIN_KEY for the normal path — read whatever key
    // is already in effect and send that. Only set one ourselves (and
    // restore in finally) when none exists at all (this file run standalone).
    const ambientKey = process.env.ADMIN_KEY || process.env.ANALYTICS_ADMIN_KEY || "";
    const setKeyOurselves = ambientKey === "";
    if (setKeyOurselves) process.env.ADMIN_KEY = "admin-agents-duplicate-slugs-standalone-key";
    const testKey = (process.env.ADMIN_KEY || process.env.ANALYTICS_ADMIN_KEY) as string;

    const db = new Database(":memory:");
    try {
      initMod.__initSchemaForTesting(db as any);

      const insertAgent = db.prepare(
        `INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key,
                             vertical_id, claimed_at, is_active, is_vetted, umbrella_type, created_at)
         VALUES (?, ?, 'test agent', 'test', ?, 'https://example.no', 'producer', ?, 'rfb', ?, ?, ?, ?, ?)`,
      );
      const insertKnowledge = db.prepare(
        `INSERT INTO agent_knowledge (agent_id, address, postal_code, website, phone, email, about,
                                      enrichment_status, curated_fields)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );

      type AgentFixture = {
        id: string;
        name: string;
        contactEmail?: string;
        claimedAt?: string | null;
        isActive?: number;
        isVetted?: number;
        umbrellaType?: string | null;
        createdAt?: string;
      };
      function agent(f: AgentFixture): void {
        insertAgent.run(
          f.id,
          f.name,
          f.contactEmail ?? "",
          `key-${f.id}`,
          f.claimedAt ?? null,
          f.isActive ?? 1,
          f.isVetted ?? 1,
          f.umbrellaType ?? null,
          f.createdAt ?? "2024-01-01T00:00:00.000Z",
        );
      }
      type KnowledgeFixture = {
        id: string;
        address?: string | null;
        postalCode?: string | null;
        website?: string | null;
        phone?: string | null;
        email?: string | null;
        about?: string | null;
        status?: string | null;
        curated?: string | null;
      };
      function knowledge(f: KnowledgeFixture): void {
        insertKnowledge.run(
          f.id,
          f.address ?? null,
          f.postalCode ?? null,
          f.website ?? null,
          f.phone ?? null,
          f.email ?? null,
          f.about ?? null,
          f.status ?? "thin",
          // agent_knowledge.curated_fields is NOT NULL DEFAULT '{}' — an
          // explicit NULL violates the constraint, so "no locks" is '{}'.
          f.curated ?? "{}",
        );
      }

      // ── (a) collision family: two names that really do slugify alike ────
      // NB: the spec's illustrative pair «Apal Sideri» / «Ápal  sideri!» does
      // NOT actually collide under the shipped slugify — "Á" is not in the
      // transliteration table, so it becomes a separator ("pal-sideri" vs
      // "apal-sideri"). That pair is therefore used as the NEGATIVE fixture
      // in (b) below, and the positive fixture uses a Norwegian pair that
      // genuinely collides (ø→o, å→a).
      agent({ id: "ds-a1", name: "Bøen Gård AS", createdAt: "2024-01-01T00:00:00.000Z" });
      knowledge({ id: "ds-a1", phone: "+4741000000", status: "enriched", curated: '{"phone":{"by":"owner"},"about":false}' });
      agent({ id: "ds-a2", name: "Bøen  gård as!", createdAt: "2025-06-01T00:00:00.000Z" });
      // ds-a2 deliberately has NO agent_knowledge row (skeleton import).

      // ── (b) rows that slugify differently -> no false positives ─────────
      agent({ id: "ds-b1", name: "Apal Sideri" });
      agent({ id: "ds-b2", name: "Ápal  sideri!" });

      // ── (c) is_active = 0 duplicate (already merged) must be excluded ───
      agent({ id: "ds-c1", name: "Fjell Meieri" });
      agent({ id: "ds-c2", name: "fjell  meieri", isActive: 0 });
      db.prepare(`UPDATE agents SET merged_into = 'ds-c1' WHERE id = 'ds-c2'`).run();

      // ── (d) umbrella + vetted producer -> group, but not sitemap-affected
      agent({ id: "ds-d1", name: "Dalen Lokallag", umbrellaType: "lokallag" });
      agent({ id: "ds-d2", name: "dalen  lokallag" });
      //     two vetted producers -> sitemap-affected
      agent({ id: "ds-e1", name: "Sogn Frukt" });
      agent({ id: "ds-e2", name: "sogn  frukt" });
      //     unvetted + vetted -> group, but not sitemap-affected
      agent({ id: "ds-f1", name: "Nord Bakeri", isVetted: 0 });
      agent({ id: "ds-f2", name: "nord  bakeri" });

      // ── (e) enrichment depth: all 7 fields vs 0 ('' and NULL both blank) ─
      agent({ id: "ds-g1", name: "Djup Gard", contactEmail: "post@djup.no" });
      knowledge({
        id: "ds-g1",
        address: "Djupvegen 1",
        postalCode: "1234",
        website: "https://djup.no",
        phone: "+4740000000",
        email: "hei@djup.no",
        about: "Gard med mykje innhald",
        status: "rich",
      });
      agent({ id: "ds-g2", name: "djup  gard", contactEmail: "" });
      // '' for three of them, NULL for the other three -> filled_fields must
      // be 0, not 3.
      knowledge({
        id: "ds-g2",
        address: "",
        postalCode: null,
        website: "",
        phone: null,
        email: "",
        about: null,
        status: "thin",
        curated: "not json at all",
      });

      // ── (f1) claimed row wins over a deeper unclaimed row ───────────────
      agent({ id: "ds-h1", name: "Krav Gard", claimedAt: "2025-02-02T00:00:00.000Z", createdAt: "2025-01-01T00:00:00.000Z" });
      // ds-h1: claimed, no knowledge row, blank contact_email -> depth 0
      agent({ id: "ds-h2", name: "krav  gard", contactEmail: "post@krav.no", createdAt: "2024-01-01T00:00:00.000Z" });
      knowledge({
        id: "ds-h2",
        address: "Kravvegen 2",
        postalCode: "4321",
        website: "https://krav.no",
        phone: "+4741111111",
        email: "hei@krav.no",
        about: "Djup profil",
        status: "rich",
      });

      // ── (f2) perfect tie on all four criteria -> no coin flip ────────────
      agent({ id: "ds-i1", name: "Lik Gard", contactEmail: "same@lik.no", createdAt: "2024-03-03T00:00:00.000Z" });
      knowledge({ id: "ds-i1", address: "Likvegen 3", status: "thin" });
      agent({ id: "ds-i2", name: "lik  gard", contactEmail: "same@lik.no", createdAt: "2024-03-03T00:00:00.000Z" });
      knowledge({ id: "ds-i2", address: "Likvegen 3", status: "thin" });

      delete require.cache[require.resolve("./admin-agents-duplicate-slugs")];
      const routeMod = require("./admin-agents-duplicate-slugs");
      const router = routeMod.default;
      routeMod.__setDuplicateSlugsDbForTesting(db as any);

      function get(key: string | false = testKey): Promise<RouteResult> {
        const headers: Record<string, string> = {};
        if (key !== false) headers["x-admin-key"] = key;
        return callRoute(router, { method: "GET", url: "/", headers });
      }

      // ── (g) auth gate ───────────────────────────────────────────────────
      let r = await get(false);
      assertEq(r.status, 403, "dupslug-01: missing X-Admin-Key -> 403");
      r = await get("wrong-key");
      assertEq(r.status, 403, "dupslug-02: wrong X-Admin-Key -> 403");

      // 503 when no admin key is configured at all. The env vars are global
      // to the whole suite, so they are cleared and restored inside ONE
      // synchronous span with no `await` between: router.handle() runs the
      // handler (and therefore reads process.env) synchronously before
      // get() returns, so no concurrently-scheduled block can observe the
      // cleared values.
      const savedAdminKey = process.env.ADMIN_KEY;
      const savedAnalyticsKey = process.env.ANALYTICS_ADMIN_KEY;
      delete process.env.ADMIN_KEY;
      delete process.env.ANALYTICS_ADMIN_KEY;
      const pending503 = get(testKey);
      if (savedAdminKey === undefined) delete process.env.ADMIN_KEY;
      else process.env.ADMIN_KEY = savedAdminKey;
      if (savedAnalyticsKey === undefined) delete process.env.ANALYTICS_ADMIN_KEY;
      else process.env.ANALYTICS_ADMIN_KEY = savedAnalyticsKey;
      r = await pending503;
      assertEq(r.status, 503, "dupslug-03: no ADMIN_KEY configured -> 503");
      assertEq(process.env.ADMIN_KEY, savedAdminKey, "dupslug-04: ADMIN_KEY restored after the 503 probe");

      // ── (h) dupslug-write-freedom: snapshot before ──────────────────────
      function snapshot(): string {
        return JSON.stringify({
          agents: db.prepare(`SELECT * FROM agents ORDER BY id`).all(),
          agent_knowledge: db.prepare(`SELECT * FROM agent_knowledge ORDER BY agent_id`).all(),
          agent_knowledge_audit: db.prepare(`SELECT * FROM agent_knowledge_audit ORDER BY id`).all(),
        });
      }
      const before = snapshot();

      // ── the real call ───────────────────────────────────────────────────
      r = await get();
      assertEq(r.status, 200, "dupslug-05: authorized GET -> 200");
      assertEq(r.body?.success, true, "dupslug-06: success: true");

      const after = snapshot();
      assertTrue(before === after, "dupslug-write-freedom: agents + agent_knowledge + agent_knowledge_audit byte-identical after the call");

      const groups: any[] = r.body?.groups ?? [];
      const bySlug = (s: string) => groups.find((g) => g.slug === s);

      assertEq(typeof r.body?.generated_at, "string", "dupslug-07: generated_at present");
      // 18 agent fixtures, of which ds-c2 is is_active = 0 -> 17 active rows.
      assertEq(db.prepare(`SELECT COUNT(*) AS c FROM agents`).get(), { c: 18 }, "dupslug-08a: 18 agent fixtures inserted");
      assertEq(r.body?.total_active_rows, 17, "dupslug-08: total_active_rows counts only is_active = 1");
      assertEq(r.body?.collision_groups, groups.length, "dupslug-09: collision_groups matches groups.length");
      assertTrue(
        groups.every((g, i) => i === 0 || groups[i - 1].slug <= g.slug),
        "dupslug-10: groups sorted by slug",
      );

      // ── (i) slugify parity: assert against the IMPORTED slugify ──────────
      const expectedSlugA = slugify("Bøen Gård AS");
      assertEq(slugify("Bøen  gård as!"), expectedSlugA, "dupslug-11: the two fixture names slugify identically (imported slugify)");
      assertTrue(!!bySlug(expectedSlugA), `dupslug-12: group keyed by imported slugify('Bøen Gård AS') = '${expectedSlugA}'`);
      // The imported slugify is the same function seo.ts's sitemap generator
      // uses; a local copy that kept æ/ø/å verbatim would fail here.
      assertEq(slugify("Bøen Gård AS"), "boen-gard-as", "dupslug-13: imported slugify transliterates ø/å (sitemap parity)");

      // ── (a) one group, 2 rows ───────────────────────────────────────────
      const gA = bySlug(expectedSlugA);
      assertEq(gA?.row_count, 2, "dupslug-14: collision group has row_count 2");
      assertEq((gA?.rows ?? []).map((x: any) => x.id).sort(), ["ds-a1", "ds-a2"], "dupslug-15: group carries both colliding rows");
      assertEq(gA?.served_selection, "scan_order_dependent", "dupslug-16: served_selection flags the scan-order dependency");
      assertEq(gA?.currently_served_id, "ds-a1", "dupslug-17: currently_served_id = first scan-order match (same find() as getAgentBySlugIncludingUmbrellas)");
      assertEq(gA?.sitemap_affected, true, "dupslug-18: two vetted non-umbrella rows -> sitemap_affected");
      const a1 = (gA?.rows ?? []).find((x: any) => x.id === "ds-a1");
      const a2 = (gA?.rows ?? []).find((x: any) => x.id === "ds-a2");
      assertEq(a1?.has_knowledge_row, true, "dupslug-19: ds-a1 has_knowledge_row true");
      assertEq(a2?.has_knowledge_row, false, "dupslug-20: ds-a2 (no knowledge row) -> has_knowledge_row false");
      assertEq(a1?.curated_locked_fields, ["about", "phone"], "dupslug-21: curated_locked_fields lists curated_fields keys, sorted");
      assertEq(a2?.curated_locked_fields, [], "dupslug-22: missing knowledge row -> curated_locked_fields []");
      assertEq(a1?.enrichment_status, "enriched", "dupslug-23: enrichment_status carried through");
      assertEq(a1?.claimed, false, "dupslug-24: unclaimed row -> claimed false");
      assertEq(a1?.created_at, "2024-01-01T00:00:00.000Z", "dupslug-25: created_at carried through");
      assertEq(gA?.suggested_survivor_id, "ds-a1", "dupslug-26: has_knowledge_row outranks the skeleton row");
      assertEq(gA?.tie, false, "dupslug-27: no tie when the rows differ");

      // ── (b) no false positives ──────────────────────────────────────────
      assertEq(slugify("Apal Sideri"), "apal-sideri", "dupslug-28: 'Apal Sideri' -> apal-sideri");
      assertEq(slugify("Ápal  sideri!"), "pal-sideri", "dupslug-29: 'Ápal  sideri!' -> pal-sideri (Á is a separator, not a transliteration)");
      assertEq(bySlug("apal-sideri"), undefined, "dupslug-30: differing slugs produce no group (apal-sideri)");
      assertEq(bySlug("pal-sideri"), undefined, "dupslug-31: differing slugs produce no group (pal-sideri)");

      // ── (c) inactive row excluded ───────────────────────────────────────
      assertEq(bySlug("fjell-meieri"), undefined, "dupslug-32: is_active = 0 duplicate excluded -> no collision group");

      // ── (d) sitemap cohort ──────────────────────────────────────────────
      const gD = bySlug("dalen-lokallag");
      assertEq(gD?.row_count, 2, "dupslug-33: umbrella + producer still reported as a collision group");
      assertEq(gD?.sitemap_affected, false, "dupslug-34: umbrella row does not count toward the sitemap cohort");
      const gE = bySlug("sogn-frukt");
      assertEq(gE?.sitemap_affected, true, "dupslug-35: two vetted producers -> sitemap_affected true");
      const gF = bySlug("nord-bakeri");
      assertEq(gF?.row_count, 2, "dupslug-36: unvetted + vetted still reported as a collision group");
      assertEq(gF?.sitemap_affected, false, "dupslug-37: is_vetted = 0 row does not count toward the sitemap cohort");
      assertEq(
        r.body?.sitemap_affected_groups,
        groups.filter((g) => g.sitemap_affected).length,
        "dupslug-38: sitemap_affected_groups matches the per-group flags",
      );

      // ── (e) enrichment depth ────────────────────────────────────────────
      const gG = bySlug("djup-gard");
      const g1 = (gG?.rows ?? []).find((x: any) => x.id === "ds-g1");
      const g2 = (gG?.rows ?? []).find((x: any) => x.id === "ds-g2");
      assertEq(g1?.filled_fields, 7, "dupslug-39: all 7 fields set -> filled_fields 7");
      assertEq(g1?.enrichment_depth, 8, "dupslug-40: enrichment_depth = filled_fields + 1 for the knowledge row");
      assertEq(g2?.filled_fields, 0, "dupslug-41: '' and NULL both count as blank -> filled_fields 0");
      assertEq(g2?.enrichment_depth, 1, "dupslug-42: blank row with a knowledge row -> depth 1");
      assertTrue((g1?.enrichment_depth ?? 0) > (g2?.enrichment_depth ?? 0), "dupslug-43: full row is deeper than the blank row");
      assertEq(g2?.curated_locked_fields, [], "dupslug-44: malformed curated_fields JSON -> [] (no throw)");
      assertEq(gG?.suggested_survivor_id, "ds-g1", "dupslug-45: deeper row wins when claimed/knowledge-row are equal");

      // ── (f) survivor ranking ────────────────────────────────────────────
      const gH = bySlug("krav-gard");
      const h1 = (gH?.rows ?? []).find((x: any) => x.id === "ds-h1");
      const h2 = (gH?.rows ?? []).find((x: any) => x.id === "ds-h2");
      assertEq(h1?.claimed, true, "dupslug-46: claimed_at set -> claimed true");
      assertEq(h1?.enrichment_depth, 0, "dupslug-47: claimed row has depth 0");
      assertEq(h2?.enrichment_depth, 8, "dupslug-48: unclaimed rival has depth 8");
      assertEq(gH?.suggested_survivor_id, "ds-h1", "dupslug-49: claimed outranks deeper enrichment");
      assertEq(gH?.tie, false, "dupslug-50: claimed-vs-unclaimed is not a tie");

      const gI = bySlug("lik-gard");
      assertEq(gI?.row_count, 2, "dupslug-51: identical rows still form a group");
      assertEq(gI?.tie, true, "dupslug-52: rows equal on all four criteria -> tie true");
      assertEq(gI?.suggested_survivor_id, null, "dupslug-53: tie -> suggested_survivor_id null (no coin flip)");

      // ── pure helpers ────────────────────────────────────────────────────
      assertEq(routeMod.curatedLockedFields(null), [], "dupslug-54: curatedLockedFields(null) -> []");
      assertEq(routeMod.curatedLockedFields("{}"), [], "dupslug-55: curatedLockedFields('{}') -> []");
      assertEq(routeMod.curatedLockedFields("["), [], "dupslug-56: curatedLockedFields on malformed JSON -> []");
      assertEq(routeMod.curatedLockedFields("[1,2]"), [], "dupslug-57: curatedLockedFields on a JSON array -> []");
      assertEq(
        routeMod.curatedLockedFields(JSON.stringify({ phone: true, address: false })),
        ["address", "phone"],
        "dupslug-58: curatedLockedFields returns all keys, sorted (advisory superset)",
      );
      assertEq(routeMod.DEPTH_FIELDS.length, 7, "dupslug-59: DEPTH_FIELDS covers exactly the 7 scalar fields");

      // ── re-read: still read-only after a second call ─────────────────────
      const r2 = await get();
      assertEq(r2.status, 200, "dupslug-60: second call also 200");
      assertEq(snapshot(), before, "dupslug-write-freedom-2: still byte-identical after a second call");
      assertEq(r2.body?.collision_groups, r.body?.collision_groups, "dupslug-61: repeated call is stable");
    } finally {
      if (setKeyOurselves) delete process.env.ADMIN_KEY;
      try {
        const routeMod = require("./admin-agents-duplicate-slugs");
        routeMod.__setDuplicateSlugsDbForTesting(null);
      } catch {
        /* ignore */
      }
      try {
        db.close();
      } catch {
        /* ignore */
      }
    }

    return { passed, failed, failures };
  })();
}
