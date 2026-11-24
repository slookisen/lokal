/**
 * admin-agents-register-domain-dedup.test.ts — dev-request 2026-11-22-rfb-
 * dubletter-samme-nettsted-sammenslaaing-og-utsending, point 5
 * ("Oppdagelsen", AK5): POST /admin/agents/register refuses a new RFB
 * profile that shares the website domain, the org.nr (agents.org_nr column)
 * or the e-mail address with an ACTIVE RFB profile. Always on (no flag).
 *
 *   DD.1  Geiranger case: "Geiranger Sjokolade AS" on geirangersjokolade.no/om-oss
 *         vs the active "Geiranger Sjokolade Fjordnær" on www.geirangersjokolade.no
 *         → duplicate, match website_domain, nothing written
 *   DD.2  org.nr column (string with spaces, JSON number), agent_knowledge.website,
 *         e-mail (contact_email and agent_knowledge.email, case-insensitive)
 *   DD.3  non-matches: placeholder e-mail, hosted platform (facebook.com),
 *         inactive / merged profile, other vertical; a new candidate → 201
 *   DD.4  deterministic order (org_nr → website_domain → email; lowest id)
 *   DD.5  the helper (findRegisterDomainEmailMatch / findRfbDomainEmailSiblings)
 *
 * Harness mirrors admin-agents-register-sibling-dedup.test.ts.
 *
 * Exported runAdminAgentsRegisterDomainDedupTests({log}) -> TestSummary;
 * wired into tests/test.ts. Standalone:
 *   npx tsx src/routes/admin-agents-register-domain-dedup.test.ts
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

export async function runAdminAgentsRegisterDomainDedupTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
  const ADMIN_KEY = "dd-test-admin-key";

  try {
    initMod.__setDbForTesting(db as any);
    initMod.__initSchemaForTesting(db as any);
    process.env.ADMIN_KEY = ADMIN_KEY;

    delete require.cache[require.resolve("./admin-agents")];
    const router = require("./admin-agents").default;
    const layer = router.stack.find((l: any) => l.route && l.route.path === "/register" && l.route.methods?.post);
    eq(!!layer, true, "setup: POST /register handler found");
    const handler = layer.route.stack[0].handle;
    const svc = require("../services/rfb-domain-siblings") as typeof import("../services/rfb-domain-siblings");

    async function register(body: Record<string, unknown>): Promise<{ status: number; body: any }> {
      const res = fakeRes();
      await handler({ headers: { "x-admin-key": ADMIN_KEY }, body, query: {} } as any, res as any);
      return { status: res.statusCode, body: res.body };
    }

    function agent(id: string, o: {
      name?: string; city?: string; url?: string; orgNr?: string | null; vertical?: string; contactEmail?: string;
      isActive?: number; mergedInto?: string | null; knowledge?: Record<string, string | null>;
    } = {}): string {
      db.prepare(`INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, city, org_nr, tags,
                                      vertical_id, is_active, merged_into)
                  VALUES (?, ?, 'En gård.', 'test', ?, ?, 'producer', ?, ?, ?, '[]', ?, ?, ?)`)
        .run(id, o.name ?? `Gård ${id}`, o.contactEmail ?? "kontakt@rettfrabonden.com", o.url ?? `https://${id}.no`,
          `key-${id}`, o.city ?? "Bø", o.orgNr ?? null, o.vertical ?? "rfb", o.isActive ?? 1, o.mergedInto ?? null);
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
    const created = async (body: Record<string, unknown>, label: string): Promise<void> => {
      const n = count("agents");
      const r = await register(body);
      eq([r.status, r.body?.success, r.body?.duplicate, count("agents")], [201, true, undefined, n + 1], label);
      const id = r.body?.agent_id ?? r.body?.id;
      if (id) removeAgent(id);
    };

    // ── fixtures ──
    const geiranger = agent("dd-geiranger", {
      name: "Geiranger Sjokolade Fjordnær", city: "Geiranger", url: "https://www.geirangersjokolade.no",
    });
    const orgSib = agent("dd-org", { name: "Orgnr Gard", city: "Ål", orgNr: "988 777 666" });
    const kSite = agent("dd-ksite", { name: "Knowledge Site Gard", url: "https://www.facebook.com/ksitegard",
      knowledge: { website: "https://ksitegard.no/" } });
    const mailSib = agent("dd-mail", { name: "Epost Gard", contactEmail: "Post@EpostGard.no" });
    const kMailSib = agent("dd-kmail", { name: "Kepost Gard", knowledge: { email: "Hei@KepostGard.no" } });
    agent("dd-fb", { name: "Facebook Gard", url: "https://www.facebook.com/fbgard" });
    agent("dd-inactive", { name: "Nedlagt Gard", url: "https://nedlagtgard.no", orgNr: "911000111",
      contactEmail: "post@nedlagtgard.no", isActive: 0 });
    agent("dd-merged", { name: "Slått Sammen Gard", url: "https://sammengard.no", orgNr: "911000222",
      contactEmail: "post@sammengard.no", mergedInto: "dd-geiranger" });
    agent("dd-exp", { name: "Opplevelse Geiranger", vertical: "experiences", url: "https://opplevgeiranger.no",
      orgNr: "911000333", contactEmail: "post@opplevgeiranger.no" });

    // ══ DD.1 the Geiranger case (AK5) ═════════════════════════════════════
    {
      const before = snapshot();
      const r = await register({ name: "Geiranger Sjokolade AS", url: "https://geirangersjokolade.no/om-oss",
        city: "Stranda", vertical_id: "rfb", source: "brreg" });
      eq([r.status, r.body], [200, {
        success: false, duplicate: true, existing_id: geiranger, match: "website_domain",
        message: "Agent matching an existing RFB profile on website_domain already exists",
      }], "DD.1: same website domain (www. vs bare, deep path) → duplicate, match website_domain");
      eq(snapshot(), before, "DD.1: nothing inserted or changed");
      const upper = await register({ name: "Geiranger Sjokolade AS", url: "HTTP://GeirangerSjokolade.NO", city: "Stranda", vertical_id: "rfb" });
      eq([upper.body?.duplicate, upper.body?.existing_id, upper.body?.match], [true, geiranger, "website_domain"],
        "DD.1: host case / scheme does not matter");
      const sub = await register({ name: "Geiranger Butikk", url: "butikk.geirangersjokolade.no", city: "Stranda", vertical_id: "rfb" });
      eq([sub.body?.duplicate, sub.body?.match], [true, "website_domain"], "DD.1: a subdomain of the same registrable domain");
      eq(snapshot(), before, "DD.1: still nothing written");
    }

    // ══ DD.2 org.nr column / knowledge website / e-mail ═══════════════════
    {
      const before = snapshot();
      const o = await register({ name: "Ny Gard C", url: "https://nygardc.no", city: "Seljord", vertical_id: "rfb", org_nr: "988777666" });
      eq([o.status, o.body?.success, o.body?.duplicate, o.body?.existing_id, o.body?.match],
        [200, false, true, orgSib, "org_nr"], "DD.2: org.nr in the agents.org_nr column (stored with spaces) → match org_nr");
      const oNum = await register({ name: "Ny Gard C2", url: "https://nygardc2.no", city: "Seljord", vertical_id: "rfb", org_nr: 988777666 });
      eq([oNum.body?.existing_id, oNum.body?.match], [orgSib, "org_nr"], "DD.2: org_nr as a JSON number");
      const oBad = await register({ name: "Ny Gard C3", url: "https://nygardc3.no", city: "Seljord", vertical_id: "rfb", org_nr: "98877766" });
      eq(oBad.status, 201, "DD.2: an 8-digit org_nr is no key → created");
      removeAgent(oBad.body.agent_id ?? oBad.body.id);

      const k = await register({ name: "Annen Gard K", url: "http://www.ksitegard.no/kontakt", city: "Seljord", vertical_id: "rfb" });
      eq([k.body?.existing_id, k.body?.match], [kSite, "website_domain"], "DD.2: agent_knowledge.website domain matches");

      const m = await register({ name: "Ny Gard M", url: "https://nygardm.no", city: "Seljord", vertical_id: "rfb", email: "  post@epostgard.NO " });
      eq([m.status, m.body?.existing_id, m.body?.match], [200, mailSib, "email"], "DD.2: e-mail vs contact_email, case/space-insensitive");
      const km = await register({ name: "Ny Gard KM", url: "https://nygardkm.no", city: "Seljord", vertical_id: "rfb", email: "hei@kepostgard.no" });
      eq([km.body?.existing_id, km.body?.match], [kMailSib, "email"], "DD.2: e-mail vs agent_knowledge.email");
      eq(snapshot(), before, "DD.2: hits write nothing");
    }

    // ══ DD.3 non-matches ══════════════════════════════════════════════════
    {
      await created({ name: "Plass Gard", url: "https://plassgard.no", city: "Seljord", vertical_id: "rfb", email: "kontakt@rettfrabonden.com" },
        "DD.3: placeholder e-mail (shared by every placeholder profile) → no match, created");
      await created({ name: "Plass Gard 2", url: "https://plassgard2.no", city: "Seljord", vertical_id: "rfb", email: "KONTAKT@rettfrabonden.com" },
        "DD.3: placeholder e-mail in upper case → no match, created");
      await created({ name: "Annen Facebook Gard", url: "https://www.facebook.com/annengard", city: "Seljord", vertical_id: "rfb" },
        "DD.3: hosted platform (facebook.com) → no website_domain match, created");
      await created({ name: "Gmail Gard", url: "https://gmail.com", city: "Seljord", vertical_id: "rfb" },
        "DD.3: free-mail domain as url → no match, created");
      await created({ name: "Ny på Nedlagt", url: "https://nedlagtgard.no", city: "Seljord", vertical_id: "rfb",
        org_nr: "911000111", email: "post@nedlagtgard.no" }, "DD.3: inactive profile (domain, org.nr, e-mail) → no match, created");
      await created({ name: "Ny på Sammen", url: "https://sammengard.no", city: "Seljord", vertical_id: "rfb",
        org_nr: "911000222", email: "post@sammengard.no" }, "DD.3: merged profile (domain, org.nr, e-mail) → no match, created");
      await created({ name: "Rfb mot Opplevelse", url: "https://opplevgeiranger.no", city: "Seljord", vertical_id: "rfb",
        org_nr: "911000333", email: "post@opplevgeiranger.no" }, "DD.3: experiences profile is never an RFB sibling → created");
      await created({ name: "Geiranger Opplevelse AS", url: "https://www.geirangersjokolade.no", city: "Geiranger",
        vertical_id: "experiences", email: "post@epostgard.no" }, "DD.3: vertical experiences → no domain/e-mail dedup, created");
      await created({ name: "Helt Ny Gard", url: "https://heltnygard.no", city: "Seljord", vertical_id: "rfb",
        org_nr: "922333444", email: "post@heltnygard.no", phone: "93344556" }, "DD.3: genuinely new candidate → 201");
      await created({ name: "Geiranger Sjokolade Kopi", url: "https://geirangersjokolade.com", city: "Stranda", vertical_id: "rfb" },
        "DD.3: same label, other TLD → not the same domain, created");
    }

    // ══ DD.4 order + determinism ══════════════════════════════════════════
    {
      // Several kinds match different profiles: org_nr wins, then website_domain.
      const all3 = await register({ name: "Alle Tre", url: "https://geirangersjokolade.no", city: "Seljord", vertical_id: "rfb",
        org_nr: "988777666", email: "post@epostgard.no" });
      eq([all3.body?.existing_id, all3.body?.match], [orgSib, "org_nr"], "DD.4: org_nr → website_domain → email (org_nr first)");
      const two = await register({ name: "To", url: "https://geirangersjokolade.no", city: "Seljord", vertical_id: "rfb", email: "post@epostgard.no" });
      eq([two.body?.existing_id, two.body?.match], [geiranger, "website_domain"], "DD.4: website_domain before email");
      agent("dd-z-shop", { name: "Z Shop", url: "https://shop.delt-domene.no" });
      agent("dd-a-shop", { name: "A Shop", url: "https://delt-domene.no" });
      const det = await register({ name: "Delt", url: "https://www.delt-domene.no", city: "Seljord", vertical_id: "rfb" });
      eq([det.body?.existing_id, det.body?.match], ["dd-a-shop", "website_domain"], "DD.4: several profiles on the domain → lowest id");
    }

    // ══ DD.4b D3b fill rides on the new hit (flag on) ═════════════════════
    {
      process.env.REGISTER_DUPLICATE_FILL_ENABLED = "true";
      const r = await register({ name: "Geiranger Sjokolade AS", url: "https://geirangersjokolade.no", city: "Stranda",
        vertical_id: "rfb", email: "post@geirangersjokolade.no", source: "brreg" });
      eq([r.body?.duplicate, r.body?.match, r.body?.filled], [true, "website_domain", ["email", "website"]],
        "DD.4b: REGISTER_DUPLICATE_FILL_ENABLED → the duplicate answer carries filled like the other checks");
      delete process.env.REGISTER_DUPLICATE_FILL_ENABLED;
    }

    // ══ DD.5 helper ═══════════════════════════════════════════════════════
    {
      eq(svc.findRegisterDomainEmailMatch(db as any, { url: "https://geirangersjokolade.no" }),
        { existingId: geiranger, match: "website_domain" }, "DD.5: helper website_domain");
      eq(svc.findRegisterDomainEmailMatch(db as any, { url: "https://www.facebook.com/fbgard" }), null,
        "DD.5: helper ignores a hosted-platform url (even the same page)");
      eq(svc.findRegisterDomainEmailMatch(db as any, { email: "kontakt@rettfrabonden.com" }), null, "DD.5: helper ignores the placeholder");
      eq(svc.findRegisterDomainEmailMatch(db as any, {}), null, "DD.5: empty candidate → null");
      eq(svc.findRfbDomainEmailSiblings(db as any, { url: "https://geirangersjokolade.no" }, geiranger).website_domain, [],
        "DD.5: excludeId removes the profile itself");
      eq(svc.orgNrDigits(" 988 777 666 "), "988777666", "DD.5: orgNrDigits strips spaces");
      eq(svc.orgNrDigits(988777666), "988777666", "DD.5: orgNrDigits accepts a number");
      eq(svc.orgNrDigits("12345"), null, "DD.5: orgNrDigits needs 9 digits");
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
  runAdminAgentsRegisterDomainDedupTests({ log: true }).then((s) => {
    console.log(`\nadmin-agents-register-domain-dedup: ${s.passed} passed, ${s.failed} failed`);
    if (s.failed) for (const f of s.failures) console.log(f);
    process.exit(s.failed ? 1 : 0);
  });
}
