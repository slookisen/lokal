/**
 * admin-agents-register-sibling-dedup.test.ts — G7 discovery-dedup, SLICE D3:
 * POST /admin/agents/register refuses a new RFB profile that matches an
 * existing RFB profile on org.nr (column or tag), normalized phone, or street
 * address + postal code — the owner-claim sibling rule (knowledge-service.ts
 * claimSiblingsForRow) — behind REGISTER_SIBLING_DEDUP_ENABLED (default off).
 *
 *   D3.1  flag on: phone match, address+postal match, org.nr in the column
 *         only → duplicate:true, the right match kind and existing_id, no
 *         new agents/agent_knowledge row
 *   D3.2  flag off → all three register as before; flag on + experiences →
 *         no new dedup; no match → created; suffix-only phone and an
 *         address without a digit are not matches; deterministic existing_id
 *
 * Harness mirrors admin-agents-register-contact.test.ts: a fresh in-memory
 * SQLite with the real schema, the POST /register handler taken off the
 * router's stack and called with a fake req/res. Env restored in finally.
 *
 * Exported runAdminAgentsRegisterSiblingDedupTests({log}) -> TestSummary;
 * wired into tests/test.ts. Standalone:
 *   npx tsx src/routes/admin-agents-register-sibling-dedup.test.ts
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

export async function runAdminAgentsRegisterSiblingDedupTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];
  const eq = (actual: unknown, expected: unknown, label: string): void => {
    if (JSON.stringify(actual) === JSON.stringify(expected)) {
      passed++;
      if (log) console.log(`  ok ${label}`);
    } else {
      failed++;
      const msg = `✗ ${label}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`;
      failures.push(msg);
      if (log) console.log("  " + msg);
    }
  };

  const initMod = require("../database/init") as typeof import("../database/init");
  const prevDb = initMod.__peekDbForTesting();
  const db = new Database(":memory:");

  const ENV_KEYS = ["ADMIN_KEY", "ANALYTICS_ADMIN_KEY", "REGISTER_SIBLING_DEDUP_ENABLED",
    "BRREG_VERIFY_ON_REGISTER", "RFB_ORGANIC_CLAIM_GATE"] as const;
  const prevEnv: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) { prevEnv[k] = process.env[k]; delete process.env[k]; }
  const ADMIN_KEY = "d3-test-admin-key";

  try {
    initMod.__setDbForTesting(db as any);
    initMod.__initSchemaForTesting(db as any);
    process.env.ADMIN_KEY = ADMIN_KEY;

    delete require.cache[require.resolve("./admin-agents")];
    const router = require("./admin-agents").default;
    const layer = router.stack.find((l: any) => l.route && l.route.path === "/register" && l.route.methods?.post);
    eq(!!layer, true, "setup: POST /register handler found");
    const handler = layer.route.stack[0].handle;

    async function register(body: Record<string, unknown>): Promise<{ status: number; body: any }> {
      const res = fakeRes();
      await handler({ headers: { "x-admin-key": ADMIN_KEY }, body, query: {} } as any, res as any);
      return { status: res.statusCode, body: res.body };
    }

    function agent(id: string, o: {
      name?: string; city?: string; orgNr?: string | null; tags?: string; vertical?: string;
      knowledge?: Record<string, string | null>;
    } = {}): string {
      db.prepare(`INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, city, org_nr, tags, vertical_id)
                  VALUES (?, ?, 'En gård.', 'test', 'kontakt@rettfrabonden.com', ?, 'producer', ?, ?, ?, ?, ?)`)
        .run(id, o.name ?? `Gård ${id}`, `https://${id}.example.test`, `key-${id}`, o.city ?? "Bø",
          o.orgNr ?? null, o.tags ?? "[]", o.vertical ?? "rfb");
      if (o.knowledge) {
        const cols = Object.keys(o.knowledge);
        db.prepare(`INSERT INTO agent_knowledge (agent_id${cols.map((c) => `, ${c}`).join("")}) VALUES (?${cols.map(() => ", ?").join("")})`)
          .run(id, ...cols.map((c) => o.knowledge![c]));
      }
      return id;
    }
    const count = (t: string): number => (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
    const snapshot = () => JSON.stringify({
      agents: db.prepare("SELECT * FROM agents ORDER BY rowid").all(),
      agent_knowledge: db.prepare("SELECT * FROM agent_knowledge ORDER BY rowid").all(),
    });
    const removeAgent = (id: string): void => {
      db.prepare("DELETE FROM agent_knowledge WHERE agent_id = ?").run(id);
      db.prepare("DELETE FROM agents WHERE id = ?").run(id);
    };

    // Fixtures: one RFB profile with phone + street address, one with org.nr
    // in the column only (no `org_nr:` tag), one experiences profile with
    // the same phone (must never be a sibling: the rule is RFB-only).
    const phoneSib = agent("d3-phone", {
      name: "Storvegen Gard", city: "Bø",
      knowledge: { phone: "+47 900 11 222", address: "Storvegen 12", postal_code: "3570" },
    });
    const orgSib = agent("d3-org", { name: "Orgnr Gard", city: "Ål", orgNr: "988777666" });
    agent("d3-exp", { name: "Opplevelse", city: "Bø", vertical: "experiences", knowledge: { phone: "+47 455 66 777" } });

    const phoneBody = { name: "Ny Gard A", url: "https://a.example.test", city: "Seljord", vertical_id: "rfb", phone: "90011222" };
    const addrBody = { name: "Ny Gard B", url: "https://b.example.test", city: "Seljord", vertical_id: "rfb",
      phone: "41122334", address: "Storvegen 12", postal_code: "3570" };
    const orgBody = { name: "Ny Gard C", url: "https://c.example.test", city: "Seljord", vertical_id: "rfb", org_nr: "988777666" };

    // ══ D3.1 flag on ══════════════════════════════════════════════════════
    process.env.REGISTER_SIBLING_DEDUP_ENABLED = "true";
    {
      const before = snapshot();
      const p = await register(phoneBody);
      eq([p.status, p.body], [200, {
        success: false, duplicate: true, existing_id: phoneSib, match: "phone",
        message: "Agent matching an existing RFB profile on phone already exists",
      }], "D3.1: phone 90011222 vs +47 900 11 222 → duplicate, match phone, existing_id");
      eq(snapshot(), before, "D3.1: phone hit writes nothing");

      const a = await register(addrBody);
      eq([a.status, a.body?.success, a.body?.duplicate, a.body?.existing_id, a.body?.match],
        [200, false, true, phoneSib, "address"], "D3.1: address + postal match (other phone) → match address");
      const aCase = await register({ ...addrBody, address: "  storvegen   12 " });
      eq([aCase.body?.duplicate, aCase.body?.match], [true, "address"], "D3.1: address compared case/space-normalized");
      eq(snapshot(), before, "D3.1: address hit writes nothing");

      const o = await register(orgBody);
      eq([o.status, o.body?.success, o.body?.duplicate, o.body?.existing_id, o.body?.match],
        [200, false, true, orgSib, "org_nr"], "D3.1: org.nr only in agents.org_nr column → match org_nr");
      eq(snapshot(), before, "D3.1: org.nr hit writes nothing");

      // org_nr wins over phone/address when several kinds match different profiles.
      const all3 = await register({ ...addrBody, phone: "90011222", org_nr: "988777666" });
      eq([all3.body?.existing_id, all3.body?.match], [orgSib, "org_nr"], "D3.1: kind order org_nr → phone → address");
      eq(snapshot(), before, "D3.1: nothing written by any hit");
    }

    // ══ D3.2 flag on: non-matches + vertical scope ════════════════════════
    {
      const exp = await register({ ...phoneBody, name: "Ny Opplevelse", vertical_id: "experiences" });
      eq([exp.status, exp.body?.success, exp.body?.duplicate], [201, true, undefined],
        "D3.2: flag on, vertical experiences → no sibling dedup, created");
      removeAgent(exp.body.agent_id ?? exp.body.id);

      const rfbVsExp = await register({ ...phoneBody, name: "Ny Gard X", phone: "45566777" });
      eq([rfbVsExp.status, rfbVsExp.body?.success], [201, true], "D3.2: same phone as an experiences profile → not a sibling");
      removeAgent(rfbVsExp.body.agent_id ?? rfbVsExp.body.id);

      const n0 = count("agents");
      const none = await register({ name: "Helt Ny Gard", url: "https://n.example.test", city: "Seljord", vertical_id: "rfb",
        phone: "93344556", address: "Bakkevegen 3", postal_code: "3840", org_nr: "911222333" });
      eq([none.status, none.body?.success, count("agents")], [201, true, n0 + 1], "D3.2: no match → created as before");
      const noneRow = db.prepare("SELECT * FROM agents WHERE name = 'Helt Ny Gard'").get() as any;
      const noneK = db.prepare("SELECT address, postal_code FROM agent_knowledge WHERE agent_id = ?").get(noneRow?.id) as any;
      eq([noneK?.address ?? null, noneK?.postal_code ?? null], [null, null], "D3.2: address/postal_code are not persisted");
      removeAgent(noneRow.id);

      const n1 = count("agents");
      const suffix = await register({ ...phoneBody, name: "Suffix Gard", phone: "11222" });
      eq([suffix.status, suffix.body?.success], [201, true], "D3.2: phone that only shares a suffix (11222) → not a match");
      const suffix8 = await register({ ...phoneBody, name: "Suffix Gard 2", phone: "+47 400 11 222" });
      eq([suffix8.status, suffix8.body?.success], [201, true], "D3.2: different 8-digit number with the same tail → not a match");
      eq(count("agents"), n1 + 2, "D3.2: both created");

      agent("d3-nodigit", { name: "Ingen Siffer", knowledge: { address: "Storvegen", postal_code: "3570" } });
      const nd = await register({ name: "Nodigit Ny", url: "https://nd.example.test", city: "Seljord", vertical_id: "rfb",
        address: "Storvegen", postal_code: "3570" });
      eq([nd.status, nd.body?.success], [201, true], "D3.2: address without a digit → not a match");
      const otherPostal = await register({ ...addrBody, name: "Annen Post", postal_code: "3580" });
      eq([otherPostal.status, otherPostal.body?.success], [201, true], "D3.2: same street address, other postal code → not a match");

      // Deterministic existing_id: two phone siblings → the smaller id.
      agent("d3-z-dup", { name: "Z dup", knowledge: { phone: "97788990" } });
      agent("d3-a-dup", { name: "A dup", knowledge: { phone: "+4797788990" } });
      const det = await register({ ...phoneBody, name: "Det Gard", phone: "977 88 990" });
      eq([det.body?.existing_id, det.body?.match], ["d3-a-dup", "phone"], "D3.2: several siblings of one kind → smallest id");
    }

    // ══ D3.2 flag off: all three register as today ═══════════════════════
    for (const off of [undefined, "false", "1"]) {
      if (off === undefined) delete process.env.REGISTER_SIBLING_DEDUP_ENABLED;
      else process.env.REGISTER_SIBLING_DEDUP_ENABLED = off;
      for (const [label, body] of [["phone", phoneBody], ["address", addrBody], ["org_nr", orgBody]] as const) {
        const n = count("agents");
        const sqls: string[] = [];
        const origPrepare = db.prepare.bind(db);
        (db as any).prepare = (sql: string) => { sqls.push(sql); return origPrepare(sql); };
        let r: { status: number; body: any };
        try { r = await register(body); } finally { (db as any).prepare = origPrepare; }
        eq(sqls.some((q) => /a\.id <> \?|k\.agent_id <> \?/.test(q)), false,
          `D3.2: flag ${off ?? "unset"}, ${label} case → no sibling-rule query`);
        eq([r.status, r.body?.success, r.body?.duplicate, count("agents")], [201, true, undefined, n + 1],
          `D3.2: flag ${off ?? "unset"}, ${label} case → new profile as today`);
        const id = r.body?.agent_id ?? r.body?.id;
        if (id) removeAgent(id);
      }
    }

    // Existing dedup 1/2 responses unchanged with the flag on.
    process.env.REGISTER_SIBLING_DEDUP_ENABLED = "true";
    {
      agent("d3-tag", { name: "Tag Gard", tags: JSON.stringify(["org_nr:977666555"]) });
      const t = await register({ ...orgBody, org_nr: "977666555" });
      eq(t.body, { success: false, duplicate: true, existing_id: "d3-tag", message: "Agent with this org_nr already exists" },
        "D3: dedup 1 (org_nr tag) response unchanged with flag on");
      const nc = await register({ ...phoneBody, name: "Storvegen Gard", city: "Bø" });
      eq(nc.body, { success: false, duplicate: true, existing_id: phoneSib, message: "Agent with this name+city already exists" },
        "D3: dedup 2 (name+city) response unchanged with flag on");
    }
  } catch (err: any) {
    failed++;
    failures.push(`unexpected error: ${err?.stack || err}`);
  } finally {
    for (const k of ENV_KEYS) {
      if (prevEnv[k] === undefined) delete process.env[k];
      else process.env[k] = prevEnv[k];
    }
    if (prevDb) initMod.__setDbForTesting(prevDb);
    try { db.close(); } catch { /* ignore */ }
  }
  return { passed, failed, failures };
}

if (require.main === module) {
  runAdminAgentsRegisterSiblingDedupTests({ log: true }).then((s) => {
    console.log(`\nadmin-agents-register-sibling-dedup: ${s.passed} passed, ${s.failed} failed`);
    if (s.failed) for (const f of s.failures) console.log(f);
    process.exit(s.failed ? 1 : 0);
  });
}
