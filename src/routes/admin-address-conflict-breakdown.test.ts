/**
 * admin-address-conflict-breakdown.test.ts — dev-request
 * 2026-11-15-rfb-adressekonflikt-smal-regel-torrkjoring, skive G1:
 * GET /admin/address-conflict-breakdown (src/routes/admin-address-conflict-
 * breakdown.ts), the READ-ONLY count of the address quarantine cohort.
 *
 * Covers:
 *   (a) 403 without X-Admin-Key.
 *   (b) AK1: 200, and the call writes nothing (total_changes unchanged,
 *       agents/agent_knowledge byte-identical).
 *   (c) AK2: sum_of_groups == total, and total == the hand-counted cohort.
 *   (d) grouping per fixture (same postnummer / same kommune / different
 *       kommune / postnummer missing or unknown / fewer than two sources).
 *   (e) cohort exclusions (inactive, other vertical, verified, no e-mail, no
 *       homepage, already sent, CRM-contacted, non-address quarantine).
 *   (f) brreg_vs_own_website dimension: count, by_group, examples.
 *   (g) examples capped at 10 per group, carry name + source + address.
 *   (h) pure classifyAddressValues / isBrregVsOwnWebsite.
 *
 * All names and addresses are fictitious. Postnumre are real Kartverket
 * numbers (0150/0151 Oslo, 5003 Bergen) so the bundled lookup resolves them;
 * 9999 is not in the register.
 *
 * Exported runAdminAddressConflictBreakdownTests({log}) -> TestSummary, wired
 * into tests/test.ts. Standalone:
 *   npx tsx src/routes/admin-address-conflict-breakdown.test.ts
 */

import Database from "better-sqlite3";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

function fakeRes() {
  const r: any = { statusCode: 200, body: undefined };
  r.status = (c: number) => { r.statusCode = c; return r; };
  r.json = (b: any) => { r.body = b; return r; };
  return r;
}

export async function runAdminAddressConflictBreakdownTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
      const msg = `✗ ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`;
      failures.push(msg);
      if (log) console.log("  " + msg);
    }
  }
  function assertTrue(cond: boolean, label: string): void {
    assertEq(cond, true, label);
  }

  const { __setDbForTesting, __initSchemaForTesting, getDb } = require("../database/init") as
    typeof import("../database/init");

  const prevDb = (() => {
    try { return getDb(); } catch { return undefined; }
  })();
  const prevAdminKey = process.env.ADMIN_KEY;
  const prevAnalyticsAdminKey = process.env.ANALYTICS_ADMIN_KEY;

  const testDb = new Database(":memory:");
  testDb.pragma("journal_mode = DELETE");
  testDb.pragma("foreign_keys = OFF");
  const ADMIN_KEY = "acb-test-key";

  try {
    __setDbForTesting(testDb as any);
    __initSchemaForTesting(testDb as any);
    process.env.ADMIN_KEY = ADMIN_KEY;
    delete process.env.ANALYTICS_ADMIN_KEY;

    const routePath = require.resolve("./admin-address-conflict-breakdown");
    delete require.cache[routePath];
    const mod = require("./admin-address-conflict-breakdown") as typeof import("./admin-address-conflict-breakdown");
    const layer = (mod.default as any).stack.find(
      (l: any) => l.route && l.route.path === "/" && l.route.methods && l.route.methods.get,
    );
    assertTrue(!!layer, "setup: GET / handler registered");
    const handler = layer.route.stack[0].handle;

    async function call(headers: Record<string, string> = { "x-admin-key": ADMIN_KEY }) {
      const res = fakeRes();
      await handler({ headers, query: {} } as any, res as any);
      return { status: res.statusCode as number, body: res.body as any };
    }

    function conflictVerdict(values: [string, string][]): string {
      return JSON.stringify({
        address: {
          agree: false,
          source_count: values.length,
          sources_used: values.map((v) => v[0]),
          verdict: "review_required",
          conflict: { values: values.map(([source, value]) => ({ source, value })), severity: "major" },
        },
      });
    }
    const UNCORROBORATED = JSON.stringify({
      address: { agree: false, source_count: 1, sources_used: ["homepage"], verdict: "review_required" },
    });

    function insert(o: {
      id: string;
      name: string;
      reviewReason: string;
      fieldProvenance?: string;
      status?: string;
      active?: number;
      vertical?: string;
      email?: string | null;
      website?: string | null;
      contactEmail?: string;
    }): void {
      testDb.prepare(
        `INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, vertical_id, created_at, is_active)
         VALUES (?, ?, 't', 't', ?, '', 'producer', ?, ?, '2026-01-01 00:00:00', ?)`,
      ).run(o.id, o.name, o.contactEmail ?? `${o.id}@eksempel.test`, `key-${o.id}`, o.vertical ?? "rfb", o.active ?? 1);
      testDb.prepare(
        `INSERT INTO agent_knowledge (agent_id, website, email, address, verification_status,
           verification_review_reason, field_provenance, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        o.id,
        o.website === undefined ? `https://${o.id}.eksempel.test` : o.website,
        o.email === undefined ? `post@${o.id}.eksempel.test` : o.email,
        "Profilveien 1",
        o.status ?? "review_required",
        o.reviewReason,
        o.fieldProvenance ?? "{}",
        "2026-11-01T00:00:00Z",
      );
    }

    // ── cohort fixtures ──
    // 12 x same_postcode (cap test)
    for (let i = 1; i <= 12; i++) {
      insert({
        id: `acb-same-${String(i).padStart(2, "0")}`,
        name: `Testgard Lik ${String(i).padStart(2, "0")}`,
        reviewReason: conflictVerdict([
          ["homepage", `Testveien ${i}, 0150 Oslo`],
          ["google_places", `Annenveien ${i}, 0150 Oslo`],
        ]),
      });
    }
    // same kommune, different postnummer; brreg vs own website
    insert({
      id: "acb-kom",
      name: "Testgard Kommune",
      reviewReason: conflictVerdict([
        ["brreg", "Kontorveien 2, 0150 Oslo"],
        ["homepage", "Gardsvegen 3, 0151 Oslo"],
      ]),
    });
    // different kommune; brreg vs own website (website_homepage form)
    insert({
      id: "acb-diff",
      name: "Testgard Ulik",
      reviewReason: conflictVerdict([
        ["brreg", "Kontorgata 4, 5003 Bergen"],
        ["website_homepage", "Gardsgata 4, 0150 Oslo"],
      ]),
    });
    // postnummer missing on one side
    insert({
      id: "acb-missing",
      name: "Testgard Mangler",
      reviewReason: conflictVerdict([
        ["homepage", "Testgata 5"],
        ["google_places", "Testgata 6, 0150 Oslo"],
      ]),
    });
    // postnummer not in the register
    insert({
      id: "acb-unknown",
      name: "Testgard Ukjent",
      reviewReason: conflictVerdict([
        ["brreg", "Testgata 7, 9999 Ingensted"],
        ["homepage", "Testgata 8, 0150 Oslo"],
      ]),
    });
    // address_uncorroborated: one source
    insert({
      id: "acb-one",
      name: "Testgard En Kilde",
      reviewReason: UNCORROBORATED,
      fieldProvenance: JSON.stringify({
        address: [{ value: "Enkildeveien 9, 0150 Oslo", source_type: "homepage", fetched_at: "2026-11-01T00:00:00Z" }],
      }),
    });

    // ── excluded fixtures (must not be counted) ──
    const conflict = conflictVerdict([["homepage", "X 1, 0150 Oslo"], ["google_places", "Y 2, 5003 Bergen"]]);
    insert({ id: "acb-x-inactive", name: "X Inaktiv", reviewReason: conflict, active: 0 });
    insert({ id: "acb-x-dental", name: "X Tannlege", reviewReason: conflict, vertical: "dental" });
    insert({ id: "acb-x-verified", name: "X Verifisert", reviewReason: conflict, status: "verified" });
    insert({ id: "acb-x-noemail", name: "X Uten epost", reviewReason: conflict, email: null });
    insert({ id: "acb-x-nosite", name: "X Uten side", reviewReason: conflict, website: null });
    insert({ id: "acb-x-sent", name: "X Sendt", reviewReason: conflict });
    testDb.prepare(
      `INSERT INTO outreach_sent_log (agent_id, recipient_email, sent_at, channel, vertical_id)
       VALUES (?, ?, ?, 'email', 'rfb')`,
    ).run("acb-x-sent", null, "2026-11-02T00:00:00Z");
    insert({ id: "acb-x-crm", name: "X Kontaktet", reviewReason: conflict, contactEmail: "kontaktet@eksempel.test" });
    testDb.prepare(`INSERT INTO crm_contacts (id, type, email) VALUES (?, 'producer', ?)`).run("acb-c1", "kontaktet@eksempel.test");
    testDb.prepare(`INSERT INTO crm_threads (id, contact_id) VALUES (?, ?)`).run("acb-t1", "acb-c1");
    testDb.prepare(
      `INSERT INTO crm_messages (id, thread_id, direction, from_email, sent_at) VALUES (?, ?, 'out', 'avsender@eksempel.test', ?)`,
    ).run("acb-m1", "acb-t1", "2026-11-03T00:00:00Z");
    insert({
      id: "acb-x-domain",
      name: "X Domene",
      reviewReason: JSON.stringify({
        address: { verdict: "pool_eligible", agree: true },
        domain_coherence: { coherent: false, reason: "mismatch" },
      }),
    });
    insert({
      id: "acb-x-insufficient",
      name: "X Ingen data",
      reviewReason: JSON.stringify({ address: { verdict: "data_insufficient", agree: false } }),
    });

    // ── (a) auth ──
    {
      const r = await call({});
      assertEq(r.status, 403, "a1: 403 without X-Admin-Key");
    }

    // ── (b) AK1: 200 and no writes ──
    const snapshot = () => JSON.stringify([
      testDb.prepare(`SELECT * FROM agents ORDER BY id`).all(),
      testDb.prepare(`SELECT * FROM agent_knowledge ORDER BY agent_id`).all(),
      testDb.prepare(`SELECT * FROM outreach_sent_log ORDER BY id`).all(),
    ]);
    const before = snapshot();
    const changesBefore = (testDb.prepare(`SELECT total_changes() AS c`).get() as any).c;
    const r = await call();
    const changesAfter = (testDb.prepare(`SELECT total_changes() AS c`).get() as any).c;
    assertEq(r.status, 200, "b1: AK1 200 with admin key");
    assertEq(changesAfter - changesBefore, 0, "b2: AK1 call adds 0 to total_changes");
    assertEq(snapshot(), before, "b3: AK1 agents/agent_knowledge/outreach_sent_log byte-identical");
    assertEq(r.body.read_only, true, "b4: read_only flag");

    // ── (c) AK2 ──
    const b = r.body;
    assertEq(b.total, 17, "c1: total = 12 same + kom + diff + missing + unknown + one");
    assertEq(b.sum_of_groups, b.total, "c2: AK2 sum_of_groups == total");
    const summed = b.groups.reduce((s: number, g: any) => s + g.count, 0);
    assertEq(summed, b.total, "c3: AK2 summing groups[].count gives total");
    assertEq(b.by_quarantine_reason, { address_conflict: 16, address_uncorroborated: 1 }, "c4: by_quarantine_reason");

    // ── (d) grouping ──
    const g = (name: string) => b.groups.find((x: any) => x.group === name);
    const ids = (name: string) => g(name).examples.map((e: any) => e.agent_id);
    assertEq(b.groups.map((x: any) => x.group), [
      "same_postcode",
      "same_kommune_different_postcode",
      "different_kommune",
      "postcode_missing_or_unknown",
      "fewer_than_two_sources",
    ], "d0: group order");
    assertEq(g("same_postcode").count, 12, "d1: same_postcode = 12");
    assertEq(g("same_kommune_different_postcode").count, 1, "d2: same kommune, different postnummer = 1");
    assertEq(ids("same_kommune_different_postcode"), ["acb-kom"], "d2b: it is acb-kom");
    assertEq(ids("different_kommune"), ["acb-diff"], "d3: different kommune = acb-diff");
    assertEq(ids("postcode_missing_or_unknown").sort(), ["acb-missing", "acb-unknown"], "d4: missing/unknown postnummer");
    assertEq(ids("fewer_than_two_sources"), ["acb-one"], "d5: one source = acb-one");

    // ── (e) exclusions ──
    const allIds = b.groups.flatMap((x: any) => x.examples.map((e: any) => e.agent_id));
    assertTrue(!allIds.some((id: string) => id.startsWith("acb-x-")), "e1: no excluded fixture appears");

    // ── (f) brreg vs own website ──
    const pair = b.source_pairs.brreg_vs_own_website;
    assertEq(pair.count, 3, "f1: brreg_vs_own_website = kom + diff + unknown");
    assertEq(pair.by_group, {
      same_postcode: 0,
      same_kommune_different_postcode: 1,
      different_kommune: 1,
      postcode_missing_or_unknown: 1,
      fewer_than_two_sources: 0,
    }, "f2: by_group split");
    assertEq(
      Object.values(pair.by_group).reduce((s: number, n: any) => s + n, 0),
      pair.count,
      "f3: by_group sums to count",
    );
    assertEq(pair.examples.map((e: any) => e.agent_id).sort(), ["acb-diff", "acb-kom", "acb-unknown"], "f4: pair examples");

    // ── (g) examples ──
    assertEq(g("same_postcode").examples.length, 10, "g1: examples capped at 10");
    assertEq(b.examples_per_group, 10, "g2: examples_per_group");
    const kom = g("same_kommune_different_postcode").examples[0];
    assertEq(kom.name, "Testgard Kommune", "g3: example carries the business name");
    assertEq(kom.addresses, [
      { source: "brreg", address: "Kontorveien 2, 0150 Oslo", postcode: "0150", kommune: "Oslo" },
      { source: "homepage", address: "Gardsvegen 3, 0151 Oslo", postcode: "0151", kommune: "Oslo" },
    ], "g4: example carries both addresses with source, postnummer, kommune");
    assertEq(kom.quarantine_reason, "quarantine:address_conflict(major)", "g5: quarantine reason");
    const one = g("fewer_than_two_sources").examples[0];
    assertEq(one.addresses, [
      { source: "homepage", address: "Enkildeveien 9, 0150 Oslo", postcode: "0150", kommune: "Oslo" },
    ], "g6: one-source example shows its stored provenance address");
    assertEq(one.quarantine_reason, "quarantine:address_uncorroborated", "g7: uncorroborated reason");

    // ── (h) pure helpers ──
    const v = (source: string, postcode: string | null, kommune: string | null) =>
      ({ source, address: "x", postcode, kommune });
    assertEq(mod.classifyAddressValues([]), "fewer_than_two_sources", "h1: empty");
    assertEq(mod.classifyAddressValues([v("homepage", "0150", "Oslo")]), "fewer_than_two_sources", "h2: one");
    assertEq(mod.classifyAddressValues([v("a", "0150", "Oslo"), v("b", "0150", "Oslo")]), "same_postcode", "h3");
    assertEq(mod.classifyAddressValues([v("a", "0150", "Oslo"), v("b", "0151", "Oslo")]), "same_kommune_different_postcode", "h4");
    assertEq(mod.classifyAddressValues([v("a", "0150", "Oslo"), v("b", "5003", "Bergen")]), "different_kommune", "h5");
    assertEq(mod.classifyAddressValues([v("a", null, null), v("b", "5003", "Bergen")]), "postcode_missing_or_unknown", "h6");
    assertEq(mod.classifyAddressValues([v("a", "9999", null), v("b", "5003", "Bergen")]), "postcode_missing_or_unknown", "h7");
    assertEq(
      mod.classifyAddressValues([v("a", "0150", "Oslo"), v("b", "0150", "Oslo"), v("c", "0151", "Oslo")]),
      "same_kommune_different_postcode",
      "h8: three values",
    );
    assertTrue(mod.isBrregVsOwnWebsite([v("brreg", null, null), v("homepage", null, null)]), "h9: brreg+homepage");
    assertTrue(mod.isBrregVsOwnWebsite([v("brreg", null, null), v("website_homepage:x.no", null, null)]), "h10: prefixed");
    assertTrue(!mod.isBrregVsOwnWebsite([v("brreg", null, null), v("google_places", null, null)]), "h11: brreg+places no");
    assertTrue(!mod.isBrregVsOwnWebsite([v("homepage", null, null)]), "h12: homepage alone no");
  } catch (err: any) {
    failed++;
    failures.push("admin-address-conflict-breakdown: unexpected error: " + String(err?.stack || err?.message || err));
  } finally {
    if (prevAdminKey === undefined) delete process.env.ADMIN_KEY;
    else process.env.ADMIN_KEY = prevAdminKey;
    if (prevAnalyticsAdminKey === undefined) delete process.env.ANALYTICS_ADMIN_KEY;
    else process.env.ANALYTICS_ADMIN_KEY = prevAnalyticsAdminKey;
    try {
      if (prevDb) __setDbForTesting(prevDb);
    } catch {
      /* best-effort restore */
    }
  }

  return { passed, failed, failures };
}

if (require.main === module) {
  runAdminAddressConflictBreakdownTests({ log: true }).then((s) => {
    console.log(`\n${s.passed} passed, ${s.failed} failed`);
    for (const f of s.failures) console.log(f);
    process.exit(s.failed === 0 ? 0 : 1);
  });
}
