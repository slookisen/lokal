/**
 * admin-agents-register-duplicate-fill.test.ts — G7 discovery-dedup, SLICE D3b
 * (dev-request 2026-10-30-rfb-eierkrav-automatisk-vurdering-og-ettklikk):
 * when POST /admin/agents/register hits a duplicate (org_nr tag, name+city or
 * the D3 sibling rule), REGISTER_DUPLICATE_FILL_ENABLED (rfb only) fills an
 * empty agent_knowledge.email / .website on the EXISTING profile, fill-only,
 * with provenance, and adds `filled: string[]` to the response.
 *
 *   D3b.1  flag on: fill email+website with source_url provenance; existing
 *          email kept; owner-claimed → nothing; curated field skipped;
 *          placeholder contact_email replaced, real one kept; org_nr-tag and
 *          sibling hits fill too
 *   D3b.2  flag off → body identical to today (no `filled`), no query, no
 *          change; experiences → no fill; bad/rettfrabonden.com url → no
 *          website; no valid source_url → nothing
 *   D3b.3  findRegisterSiblingMatch: numeric org_nr / postal_code / phone
 *          match like strings; kind order org_nr → phone → address across
 *          different profiles
 *
 * Harness mirrors admin-agents-register-sibling-dedup.test.ts. Env restored
 * in finally.
 *
 * Exported runAdminAgentsRegisterDuplicateFillTests({log}) -> TestSummary;
 * wired into tests/test.ts. Standalone:
 *   npx tsx src/routes/admin-agents-register-duplicate-fill.test.ts
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

export async function runAdminAgentsRegisterDuplicateFillTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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

  const ENV_KEYS = ["ADMIN_KEY", "ANALYTICS_ADMIN_KEY", "REGISTER_SIBLING_DEDUP_ENABLED", "REGISTER_DUPLICATE_FILL_ENABLED",
    "BRREG_VERIFY_ON_REGISTER", "RFB_ORGANIC_CLAIM_GATE"] as const;
  const prevEnv: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) { prevEnv[k] = process.env[k]; delete process.env[k]; }
  const ADMIN_KEY = "d3b-test-admin-key";
  const resetFlags = (): void => {
    delete process.env.REGISTER_SIBLING_DEDUP_ENABLED;
    delete process.env.REGISTER_DUPLICATE_FILL_ENABLED;
  };

  try {
    initMod.__setDbForTesting(db as any);
    initMod.__initSchemaForTesting(db as any);
    process.env.ADMIN_KEY = ADMIN_KEY;

    delete require.cache[require.resolve("./admin-agents")];
    const router = require("./admin-agents").default;
    const layer = router.stack.find((l: any) => l.route && l.route.path === "/register" && l.route.methods?.post);
    eq(!!layer, true, "setup: POST /register handler found");
    const handler = layer.route.stack[0].handle;
    const { findRegisterSiblingMatch } = require("../services/knowledge-service") as typeof import("../services/knowledge-service");

    async function register(body: Record<string, unknown>): Promise<{ status: number; body: any }> {
      const res = fakeRes();
      await handler({ headers: { "x-admin-key": ADMIN_KEY }, body, query: {} } as any, res as any);
      return { status: res.statusCode, body: res.body };
    }

    function agent(id: string, o: {
      name?: string; city?: string; orgNr?: string | null; tags?: string; vertical?: string; contactEmail?: string;
      claimedAt?: string | null; knowledge?: Record<string, string | null>;
    } = {}): string {
      db.prepare(`INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, city, org_nr, tags, vertical_id, claimed_at)
                  VALUES (?, ?, 'En gård.', 'test', ?, ?, 'producer', ?, ?, ?, ?, ?, ?)`)
        .run(id, o.name ?? `Gård ${id}`, o.contactEmail ?? "kontakt@rettfrabonden.com", `https://${id}.example.test`, `key-${id}`,
          o.city ?? "Bø", o.orgNr ?? null, o.tags ?? "[]", o.vertical ?? "rfb", o.claimedAt ?? null);
      if (o.knowledge) {
        const cols = Object.keys(o.knowledge);
        db.prepare(`INSERT INTO agent_knowledge (agent_id${cols.map((c) => `, ${c}`).join("")}) VALUES (?${cols.map(() => ", ?").join("")})`)
          .run(id, ...cols.map((c) => o.knowledge![c]));
      }
      return id;
    }
    const kRow = (id: string): any => db.prepare("SELECT email, website, field_provenance FROM agent_knowledge WHERE agent_id = ?").get(id);
    const contactEmail = (id: string): string => (db.prepare("SELECT contact_email FROM agents WHERE id = ?").get(id) as any)?.contact_email;
    const prov = (id: string): any => { const r = kRow(id); return r?.field_provenance ? JSON.parse(r.field_provenance) : {}; };
    const snapshot = () => JSON.stringify({
      agents: db.prepare("SELECT * FROM agents ORDER BY rowid").all(),
      agent_knowledge: db.prepare("SELECT * FROM agent_knowledge ORDER BY rowid").all(),
    });

    const SRC = "https://kilde.example.test/kontakt";
    const dupBody = (name: string, city: string, extra: Record<string, unknown> = {}) => ({
      name, city, vertical_id: "rfb", url: "https://gard.example.test", email: "post@gard.example.test",
      source_url: SRC, source: "lokal-agent-discovery", ...extra,
    });

    // ══ D3b.1 flag on ═════════════════════════════════════════════════════
    process.env.REGISTER_DUPLICATE_FILL_ENABLED = "true";
    try {
      // Empty profile without an agent_knowledge row → row created, both filled.
      const empty = agent("d3b-empty", { name: "Tom Gard", city: "Bø" });
      const r1 = await register(dupBody("Tom Gard", "Bø"));
      eq([r1.status, r1.body], [200, {
        success: false, duplicate: true, existing_id: empty, message: "Agent with this name+city already exists",
        filled: ["email", "website"],
      }], "D3b.1: name+city hit → duplicate:true, filled [email, website]");
      eq([kRow(empty)?.email, kRow(empty)?.website], ["post@gard.example.test", "https://gard.example.test"],
        "D3b.1: values written to agent_knowledge");
      const p1 = prov(empty);
      eq([p1.email?.[0]?.source_url, p1.email?.[0]?.source_type, p1.email?.[0]?.value],
        [SRC, "lokal-agent-discovery", "post@gard.example.test"], "D3b.1: field_provenance.email carries source_url");
      eq([p1.website?.[0]?.source_url, p1.website?.[0]?.value], [SRC, "https://gard.example.test"],
        "D3b.1: field_provenance.website carries source_url");
      eq(contactEmail(empty), "post@gard.example.test", "D3b.1: placeholder contact_email replaced by the filled email");

      // A second identical call fills nothing (fill-only).
      const before2 = snapshot();
      const r2 = await register(dupBody("Tom Gard", "Bø", { email: "annen@gard.example.test", url: "https://annen.example.test" }));
      eq(r2.body?.filled, [], "D3b.1: populated fields never overwritten → filled []");
      eq(snapshot(), before2, "D3b.1: second call writes nothing");

      // Existing email (whitespace-only website) → email untouched, website filled.
      const hasEmail = agent("d3b-has-email", { name: "Epost Gard", city: "Bø",
        knowledge: { email: "eier@epost.example.test", website: "   ", field_provenance: "{}" } });
      const r3 = await register(dupBody("Epost Gard", "Bø"));
      eq(r3.body?.filled, ["website"], "D3b.1: existing email → filled lacks email; whitespace-only website filled");
      eq([kRow(hasEmail)?.email, kRow(hasEmail)?.website], ["eier@epost.example.test", "https://gard.example.test"],
        "D3b.1: existing email unchanged");
      eq(contactEmail(hasEmail), "kontakt@rettfrabonden.com", "D3b.1: email not filled → placeholder contact_email kept");

      // Non-placeholder contact_email kept even though email is filled.
      const realContact = agent("d3b-real-contact", { name: "Ekte Gard", city: "Bø", contactEmail: "eier@ekte.example.test" });
      const r4 = await register(dupBody("Ekte Gard", "Bø"));
      eq(r4.body?.filled, ["email", "website"], "D3b.1: real contact_email profile still gets agent_knowledge fill");
      eq(contactEmail(realContact), "eier@ekte.example.test", "D3b.1: non-placeholder contact_email kept");

      // Owner-claimed via a verified agent_claims row → nothing.
      const claimed = agent("d3b-claimed", { name: "Eid Gard", city: "Bø" });
      db.prepare(`INSERT INTO agent_claims (id, agent_id, claimant_name, claimant_email, status) VALUES ('c1', ?, 'Eier', 'e@x.test', 'verified')`).run(claimed);
      let before = snapshot();
      const r5 = await register(dupBody("Eid Gard", "Bø"));
      eq([r5.body?.duplicate, r5.body?.filled], [true, []], "D3b.1: owner-claimed (verified claim) → filled []");
      eq(snapshot(), before, "D3b.1: owner-claimed → nothing written");

      // Owner-claimed via agents.claimed_at → nothing.
      agent("d3b-claimed-at", { name: "Krav Gard", city: "Bø", claimedAt: "2026-10-01T00:00:00Z" });
      before = snapshot();
      const r6 = await register(dupBody("Krav Gard", "Bø"));
      eq(r6.body?.filled, [], "D3b.1: claimed_at set → filled []");
      eq(snapshot(), before, "D3b.1: claimed_at → nothing written");

      // Curated (locked) email → only website filled; owner_updated_at → nothing.
      const curated = agent("d3b-curated", { name: "Laast Gard", city: "Bø",
        knowledge: { curated_fields: JSON.stringify({ email: { locked_at: "2026-09-01", by: "cs" } }) } });
      const r7 = await register(dupBody("Laast Gard", "Bø"));
      eq([r7.body?.filled, kRow(curated)?.email ?? null], [["website"], null], "D3b.1: curated email skipped, website filled");
      agent("d3b-owner-edit", { name: "Eierredigert Gard", city: "Bø", knowledge: { owner_updated_at: "2026-09-01T00:00:00Z" } });
      before = snapshot();
      const r8 = await register(dupBody("Eierredigert Gard", "Bø"));
      eq(r8.body?.filled, [], "D3b.1: owner_updated_at set → filled []");
      eq(snapshot(), before, "D3b.1: owner-edited → nothing written");

      // Dedup 1 (org_nr tag) and dedup 3 (sibling rule) fill too.
      const tagged = agent("d3b-tag", { name: "Tag Gard", city: "Ål", tags: JSON.stringify(["org_nr:955444333"]) });
      const r9 = await register(dupBody("Ny Navn", "Seljord", { org_nr: "955444333" }));
      eq([r9.body?.existing_id, r9.body?.message, r9.body?.filled], [tagged, "Agent with this org_nr already exists", ["email", "website"]],
        "D3b.1: org_nr tag hit → filled");
      process.env.REGISTER_SIBLING_DEDUP_ENABLED = "true";
      const sib = agent("d3b-sib", { name: "Sosken Gard", city: "Ål", knowledge: { phone: "+47 922 33 444" } });
      const r10 = await register(dupBody("Annen Gard", "Seljord", { phone: "92233444" }));
      eq([r10.body?.existing_id, r10.body?.match, r10.body?.filled], [sib, "phone", ["email", "website"]],
        "D3b.1: sibling (phone) hit → filled");
      eq(kRow(sib)?.email, "post@gard.example.test", "D3b.1: sibling hit wrote email to the existing profile");
    } finally {
      resetFlags();
    }

    // ══ D3b.2 flag off / scope / bad inputs ═══════════════════════════════
    try {
      const offA = agent("d3b-off", { name: "Av Gard", city: "Bø" });
      for (const off of [undefined, "false", "1"]) {
        if (off === undefined) delete process.env.REGISTER_DUPLICATE_FILL_ENABLED;
        else process.env.REGISTER_DUPLICATE_FILL_ENABLED = off;
        const before = snapshot();
        const sqls: string[] = [];
        const origPrepare = db.prepare.bind(db);
        (db as any).prepare = (sql: string) => { sqls.push(sql); return origPrepare(sql); };
        let r: { status: number; body: any };
        try { r = await register(dupBody("Av Gard", "Bø")); } finally { (db as any).prepare = origPrepare; }
        eq([r.status, r.body], [200, { success: false, duplicate: true, existing_id: offA, message: "Agent with this name+city already exists" }],
          `D3b.2: flag ${off ?? "unset"} → body identical to today (no filled key)`);
        eq(sqls.some((q) => /agent_knowledge|agent_claims/.test(q)), false, `D3b.2: flag ${off ?? "unset"} → no fill query`);
        eq(snapshot(), before, `D3b.2: flag ${off ?? "unset"} → no row changed`);
      }

      process.env.REGISTER_DUPLICATE_FILL_ENABLED = "true";
      // vertical experiences → no fill, no filled key.
      agent("d3b-exp", { name: "Opplevelse", city: "Bø", vertical: "experiences" });
      let before = snapshot();
      const exp = await register({ ...dupBody("Opplevelse", "Bø"), vertical_id: "experiences" });
      eq([exp.body?.duplicate, "filled" in (exp.body ?? {})], [true, false], "D3b.2: flag on + experiences → no filled key");
      eq(snapshot(), before, "D3b.2: flag on + experiences → nothing written");

      // rfb request hitting a non-rfb existing row (name+city) → no fill.
      agent("d3b-dental", { name: "Tann Gard", city: "Bø", vertical: "dental" });
      before = snapshot();
      const den = await register(dupBody("Tann Gard", "Bø"));
      eq(den.body?.filled, [], "D3b.2: existing row not rfb → filled []");
      eq(snapshot(), before, "D3b.2: existing row not rfb → nothing written");

      // url without http(s) → website not filled (email still, via source_url).
      const ftp = agent("d3b-ftp", { name: "Ftp Gard", city: "Bø" });
      const rf = await register(dupBody("Ftp Gard", "Bø", { url: "ftp://gard.example.test" }));
      eq([rf.body?.filled, kRow(ftp)?.website ?? null], [["email"], null], "D3b.2: ftp url → website not filled");
      const bare = agent("d3b-bare", { name: "Bare Gard", city: "Bø" });
      const rb = await register(dupBody("Bare Gard", "Bø", { url: "gard.example.test" }));
      eq([rb.body?.filled, kRow(bare)?.website ?? null], [["email"], null], "D3b.2: url without scheme → website not filled");

      // rettfrabonden.com url (and a subdomain) → website not filled.
      const rfbUrl = agent("d3b-rfburl", { name: "Plattform Gard", city: "Bø" });
      const rr = await register(dupBody("Plattform Gard", "Bø", { url: "https://rettfrabonden.com/produsent/plattform-gard" }));
      eq([rr.body?.filled, kRow(rfbUrl)?.website ?? null], [["email"], null], "D3b.2: rettfrabonden.com url → website not filled");
      const subUrl = agent("d3b-suburl", { name: "Sub Gard", city: "Bø" });
      const rs = await register(dupBody("Sub Gard", "Bø", { url: "https://www.rettfrabonden.com/x" }));
      eq([rs.body?.filled, kRow(subUrl)?.website ?? null], [["email"], null], "D3b.2: www.rettfrabonden.com url → website not filled");

      // No valid source_url (source_url invalid, url not http(s)) → nothing.
      agent("d3b-nosrc", { name: "Kildelos Gard", city: "Bø" });
      before = snapshot();
      const rn = await register(dupBody("Kildelos Gard", "Bø", { url: "gard.example.test", source_url: "javascript:alert(1)" }));
      eq(rn.body?.filled, [], "D3b.2: no valid source_url → filled []");
      eq(snapshot(), before, "D3b.2: no valid source_url → nothing written");

      // source_url absent but url valid → url is the provenance source_url.
      const urlSrc = agent("d3b-urlsrc", { name: "Urlkilde Gard", city: "Bø" });
      const ru = await register(dupBody("Urlkilde Gard", "Bø", { source_url: undefined, source: undefined }));
      eq([ru.body?.filled, prov(urlSrc).email?.[0]?.source_url, prov(urlSrc).email?.[0]?.source_type],
        [["email", "website"], "https://gard.example.test", "agent_registration"],
        "D3b.2: no source_url → body url used; source_type falls back to agent_registration");

      // Invalid email still 400 before dedup (unchanged).
      const bad = await register(dupBody("Urlkilde Gard", "Bø", { email: "ikke-epost" }));
      eq(bad.status, 400, "D3b.2: invalid email still 400 before dedup");
    } finally {
      resetFlags();
    }

    // ══ D3b.3 findRegisterSiblingMatch: numbers + kind order ══════════════
    {
      agent("d3b-n-org", { name: "Num Org", city: "Ål", orgNr: "123456789" });
      agent("d3b-n-addr", { name: "Num Addr", city: "Ål", knowledge: { address: "Tallvegen 7", postal_code: "3570" } });
      agent("d3b-n-phone", { name: "Num Phone", city: "Ål", knowledge: { phone: "93322110" } });

      const sOrg = findRegisterSiblingMatch(db as any, { org_nr: "123456789" });
      const nOrg = findRegisterSiblingMatch(db as any, { org_nr: 123456789 });
      eq([nOrg, sOrg], [{ existingId: "d3b-n-org", match: "org_nr" }, { existingId: "d3b-n-org", match: "org_nr" }],
        "D3b.3: numeric org_nr 123456789 matches like the string");
      const sAddr = findRegisterSiblingMatch(db as any, { address: "Tallvegen 7", postal_code: "3570" });
      const nAddr = findRegisterSiblingMatch(db as any, { address: "Tallvegen 7", postal_code: 3570 });
      eq([nAddr, sAddr], [{ existingId: "d3b-n-addr", match: "address" }, { existingId: "d3b-n-addr", match: "address" }],
        "D3b.3: numeric postal_code 3570 matches like the string");
      eq(findRegisterSiblingMatch(db as any, { phone: 93322110 }), { existingId: "d3b-n-phone", match: "phone" },
        "D3b.3: numeric phone matches like the string");
      eq(findRegisterSiblingMatch(db as any, { org_nr: Number.NaN, phone: Infinity, postal_code: { v: 1 } as unknown, address: "Tallvegen 7" }), null,
        "D3b.3: non-finite numbers / objects → treated as absent");

      // Kind order across DIFFERENT profiles: org_nr → phone → address.
      eq(findRegisterSiblingMatch(db as any, { org_nr: 123456789, phone: 93322110, address: "Tallvegen 7", postal_code: 3570 }),
        { existingId: "d3b-n-org", match: "org_nr" }, "D3b.3: org_nr wins over phone and address (different profiles)");
      eq(findRegisterSiblingMatch(db as any, { phone: 93322110, address: "Tallvegen 7", postal_code: "3570" }),
        { existingId: "d3b-n-phone", match: "phone" }, "D3b.3: phone wins over address (different profiles)");

      // Through the route (sibling flag on, fill off): numeric org_nr in the column only.
      process.env.REGISTER_SIBLING_DEDUP_ENABLED = "true";
      try {
        const viaRoute = await register({ name: "Rute Num", url: "https://rn.example.test", city: "Seljord", vertical_id: "rfb", org_nr: 123456789 });
        eq([viaRoute.status, viaRoute.body?.existing_id, viaRoute.body?.match, "filled" in (viaRoute.body ?? {})],
          [200, "d3b-n-org", "org_nr", false], "D3b.3: route with numeric org_nr → sibling org_nr match, no filled key (fill flag off)");
        const viaPhone = await register({ name: "Rute Tlf", url: "https://rt.example.test", city: "Seljord", vertical_id: "rfb", phone: 93322110 });
        eq([viaPhone.status, viaPhone.body?.existing_id, viaPhone.body?.match], [200, "d3b-n-phone", "phone"],
          "D3b.3: route with numeric phone → sibling phone match");
      } finally {
        resetFlags();
      }
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
  runAdminAgentsRegisterDuplicateFillTests({ log: true }).then((s) => {
    console.log(`\nadmin-agents-register-duplicate-fill: ${s.passed} passed, ${s.failed} failed`);
    if (s.failed) for (const f of s.failures) console.log(f);
    process.exit(s.failed ? 1 : 0);
  });
}
