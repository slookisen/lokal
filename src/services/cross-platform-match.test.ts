/**
 * cross-platform-match.test.ts — dev-request
 * 2026-10-08-kryssplattform-karantene-produsent-og-domene.
 *
 * The RFB <-> Opplevagent cold-outreach cooldown must recognise the same
 * PRODUCER, not only the same address: e-mail domain (never free-mail),
 * website host, org number. AC1 (Druehagen, both directions, match: domain),
 * AC2 (two gmail addresses do not block each other), AC3 (same org.nr with
 * unrelated addresses, match: org_nr), AC4 (the candidates dry run reports
 * `match` per suppressed row).
 *
 * Standalone: npx tsx src/services/cross-platform-match.test.ts
 */
import Database from "better-sqlite3";
import {
  CrossPlatformIndex,
  buildCrossPlatformIdentity,
  emailDomainForMatch,
  matchCrossPlatformIdentity,
  normalizeOrgNrForMatch,
  websiteDomainForMatch,
} from "./cross-platform-match";
import { getCrossPlatformSuppressors, getRfbSendIndexForOpplevagent } from "./outreach-suppression-signals";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export function runCrossPlatformMatchTests(): TestSummary {
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];
  const eq = (actual: unknown, expected: unknown, label: string): void => {
    if (JSON.stringify(actual) === JSON.stringify(expected)) passed++;
    else {
      failed++;
      failures.push(`✗ ${label}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`);
    }
  };

  const nowIso = new Date().toISOString();
  const daysAgoIso = (d: number) => new Date(Date.now() - d * 86400_000).toISOString();

  // ── normalisers ──────────────────────────────────────────────────────
  eq(emailDomainForMatch("Eventer@Druehagen.NO"), "druehagen.no", "n1: email domain lowercased");
  eq(emailDomainForMatch("kari@gmail.com"), null, "n2: free-mail domain is never used for domain matching");
  eq(emailDomainForMatch("kari@online.no"), null, "n3: consumer-ISP domain in FREE_MAIL_DOMAINS is excluded");
  eq(emailDomainForMatch("not-an-address"), null, "n4: malformed address has no domain");
  eq(websiteDomainForMatch("https://www.Druehagen.no/kontakt?x=1"), "druehagen.no", "n5: website host without www/path");
  eq(websiteDomainForMatch("druehagen.no"), "druehagen.no", "n6: bare host accepted");
  eq(websiteDomainForMatch("https://www.facebook.com/druehagen"), null, "n7: shared platform host is not a producer identity");
  eq(websiteDomainForMatch(""), null, "n8: empty website");
  // B1: catalogue / tourism hosts are never a producer's own website
  eq(websiteDomainForMatch("https://www.visitnorway.com/listings/gard-a/123"), null, "n11: visitnorway.com listing is not a producer identity");
  eq(websiteDomainForMatch("https://www.visitnorway.com/listings/gard-b/456"), null, "n12: a second visitnorway.com listing does not match the first");
  eq(websiteDomainForMatch("https://siderruta.no/gard-c"), null, "n13: siderruta.no is a catalogue host");
  eq(websiteDomainForMatch("https://lokalmat.no/produsent/x"), null, "n14: lokalmat.no is a catalogue host");
  eq(websiteDomainForMatch("https://rekonorge.no/x"), null, "n15: rekonorge.no is a catalogue host");
  eq(websiteDomainForMatch("https://visitnorwayfarm.no/"), "visitnorwayfarm.no", "n16: a producer domain merely containing a catalogue name still matches");
  // B2: regional ISP mail domains are never a producer identity
  eq(emailDomainForMatch("gard-a@enivest.net"), null, "n17: enivest.net mailbox has no matchable domain");
  eq(emailDomainForMatch("gard-b@enivest.net"), null, "n18: a second enivest.net mailbox has none either");
  eq(emailDomainForMatch("x@hesbynett.no"), null, "n19: hesbynett.no excluded");
  eq(emailDomainForMatch("x@post.telia.no"), null, "n20: subdomain of an ISP domain excluded");
  eq(emailDomainForMatch("post@enivestgard.no"), "enivestgard.no", "n21: a producer domain merely containing an ISP name still matches");
  {
    const a = buildCrossPlatformIdentity({ email: "gard-a@enivest.net", website: "https://www.visitnorway.com/listings/a" });
    const b = buildCrossPlatformIdentity({ email: "gard-b@enivest.net", website: "https://www.visitnorway.com/listings/b" });
    eq(matchCrossPlatformIdentity(a, b), null, "n22: two unrelated producers on shared ISP and catalogue host do not match");
  }
  eq(normalizeOrgNrForMatch("123 456 789"), "123456789", "n9: org.nr spaces stripped");
  eq(normalizeOrgNrForMatch("12345"), null, "n10: short org.nr rejected");

  // ── AC1: Druehagen pattern, both directions (match: domain) ─────────
  {
    // Direction 1: Opplevagent sent to eventer@, RFB candidate is post@.
    const idx = new CrossPlatformIndex<{ vertical: string; last_sent_at: string }>();
    idx.add(buildCrossPlatformIdentity({ email: "eventer@druehagen.no" }), {
      vertical: "experiences",
      last_sent_at: nowIso,
    });
    const hit = idx.find(buildCrossPlatformIdentity({ email: "post@druehagen.no" }));
    eq(hit?.match, "domain", "ac1a: opplevagent send to eventer@ blocks RFB post@ (domain)");
    eq(hit?.hit.vertical, "experiences", "ac1b: suppressing vertical is reported");
    eq(
      idx.find(buildCrossPlatformIdentity({ email: "eventer@druehagen.no" }))?.match,
      "email",
      "ac1c: identical address still reports match=email",
    );
    eq(idx.find(buildCrossPlatformIdentity({ email: "post@annengard.no" })), undefined, "ac1d: unrelated domain not blocked");
  }
  {
    // Direction 2: RFB sent to post@, Opplevagent provider is eventer@.
    const rfbDb = new Database(":memory:");
    rfbDb.exec(`
      CREATE TABLE agents (id TEXT PRIMARY KEY, org_nr TEXT, url TEXT);
      CREATE TABLE agent_knowledge (agent_id TEXT PRIMARY KEY, website TEXT);
      CREATE TABLE outreach_sent_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT NOT NULL, recipient_email TEXT,
        sent_at TEXT NOT NULL, vertical_id TEXT NOT NULL DEFAULT 'rfb');
    `);
    rfbDb.prepare(`INSERT INTO agents VALUES ('a-drue', '912345678', 'https://www.druehagen.no/')`).run();
    rfbDb.prepare(`INSERT INTO agent_knowledge VALUES ('a-drue', NULL)`).run();
    rfbDb
      .prepare(`INSERT INTO outreach_sent_log (agent_id, recipient_email, sent_at, vertical_id) VALUES ('a-drue', 'post@druehagen.no', ?, 'rfb')`)
      .run(nowIso);
    const cutoff = daysAgoIso(60);
    const idx = getRfbSendIndexForOpplevagent(rfbDb, cutoff);

    eq(
      idx.find(buildCrossPlatformIdentity({ email: "eventer@druehagen.no" }))?.match,
      "domain",
      "ac1e: RFB send to post@ blocks opplevagent eventer@ (domain)",
    );
    eq(
      idx.find(buildCrossPlatformIdentity({ email: "post@druehagen.no" }))?.match,
      "email",
      "ac1f: same address reports match=email",
    );
    // website / org.nr of an RFB send reach the Opplevagent side
    eq(
      idx.find(buildCrossPlatformIdentity({ email: "x@gmail.com", website: "http://druehagen.no" }))?.match,
      "website",
      "ac1g: same website host (www stripped) blocks (match: website)",
    );
    eq(
      idx.find(buildCrossPlatformIdentity({ email: "x@gmail.com", orgNr: "912 345 678" }))?.match,
      "org_nr",
      "ac3a: same org.nr with unrelated address blocks (match: org_nr), Opplevagent side",
    );
    // Outside the window -> not in the index at all.
    eq(
      getRfbSendIndexForOpplevagent(rfbDb, new Date(Date.now() + 86400_000).toISOString()).find(
        buildCrossPlatformIdentity({ email: "post@druehagen.no" }),
      ),
      undefined,
      "ac1h: sends outside the cooldown window do not block",
    );
    // An Opplevagent-vertical row in the RFB log keeps exact-address behaviour only.
    rfbDb
      .prepare(`INSERT INTO outreach_sent_log (agent_id, recipient_email, sent_at, vertical_id) VALUES ('a-drue', 'kontakt@egen-lane.no', ?, 'experiences')`)
      .run(nowIso);
    const idx2 = getRfbSendIndexForOpplevagent(rfbDb, cutoff);
    eq(idx2.find(buildCrossPlatformIdentity({ email: "kontakt@egen-lane.no" }))?.match, "email", "ac1i: own-lane row still matches by address");
    eq(idx2.find(buildCrossPlatformIdentity({ email: "annen@egen-lane.no" })), undefined, "ac1j: own-lane row never widens to domain");
    // Druehagen shadow case: own-lane row on eventer@ must not hide the RFB row on post@.
    rfbDb
      .prepare(`INSERT INTO outreach_sent_log (agent_id, recipient_email, sent_at, vertical_id) VALUES ('a-drue', 'eventer@druehagen.no', ?, 'experiences')`)
      .run(nowIso);
    const idx3 = getRfbSendIndexForOpplevagent(rfbDb, cutoff);
    const druId = buildCrossPlatformIdentity({ email: "eventer@druehagen.no" });
    eq(idx3.find(druId)?.match, "email", "ac1k: exact-address lookup still sees the own-lane row");
    eq(idx3.findProducerMatch(druId)?.match, "domain", "ac1l: producer lookup skips the address key and finds the RFB domain hit");
    eq(idx3.findProducerMatch(druId)?.hit.vertical_id, "rfb", "ac1m: the producer hit is the RFB row");
    rfbDb.close();
  }

  // ── AC2: two different gmail addresses never block each other ────────
  {
    const idx = new CrossPlatformIndex<{ last_sent_at: string }>();
    idx.add(buildCrossPlatformIdentity({ email: "kari.nordmann@gmail.com" }), { last_sent_at: nowIso });
    eq(idx.find(buildCrossPlatformIdentity({ email: "ola.bonde@gmail.com" })), undefined, "ac2a: other gmail address not blocked");
    eq(idx.find(buildCrossPlatformIdentity({ email: "kari.nordmann@gmail.com" }))?.match, "email", "ac2b: same gmail address is blocked");

    const rfbDb = new Database(":memory:");
    rfbDb.exec(`
      CREATE TABLE agents (id TEXT PRIMARY KEY, org_nr TEXT, url TEXT);
      CREATE TABLE agent_knowledge (agent_id TEXT PRIMARY KEY, website TEXT);
      CREATE TABLE outreach_sent_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT NOT NULL, recipient_email TEXT,
        sent_at TEXT NOT NULL, vertical_id TEXT NOT NULL DEFAULT 'rfb');
    `);
    rfbDb.prepare(`INSERT INTO agents VALUES ('a-g1', NULL, NULL)`).run();
    rfbDb
      .prepare(`INSERT INTO outreach_sent_log (agent_id, recipient_email, sent_at, vertical_id) VALUES ('a-g1', 'kari@gmail.com', ?, 'rfb')`)
      .run(nowIso);
    const gm = getRfbSendIndexForOpplevagent(rfbDb, daysAgoIso(60));
    eq(gm.find(buildCrossPlatformIdentity({ email: "ola@gmail.com" })), undefined, "ac2c: RFB gmail send does not block another gmail provider");
    rfbDb.close();
  }

  // ── AC3: RFB side — same org.nr / website, unrelated addresses ───────
  {
    const rfbDb = new Database(":memory:");
    rfbDb.exec(`
      CREATE TABLE outreach_sent_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT NOT NULL, recipient_email TEXT,
        sent_at TEXT NOT NULL, vertical_id TEXT NOT NULL DEFAULT 'rfb');
    `);
    const expDb = new Database(":memory:");
    expDb.exec(`
      CREATE TABLE experience_providers (id TEXT PRIMARY KEY, org_nr TEXT, epost TEXT, hjemmeside TEXT);
      CREATE TABLE experience_outreach_sent_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT, provider_id TEXT NOT NULL, recipient_email TEXT NOT NULL,
        sent_at TEXT NOT NULL, is_test INTEGER NOT NULL DEFAULT 0);
    `);
    expDb.prepare(`INSERT INTO experience_providers VALUES ('p1', '987654321', 'kari@gmail.com', 'https://www.fjellgard.no')`).run();
    expDb.prepare(`INSERT INTO experience_outreach_sent_log (provider_id, recipient_email, sent_at) VALUES ('p1', 'kari@gmail.com', ?)`).run(nowIso);
    rfbDb
      .prepare(`INSERT INTO outreach_sent_log (agent_id, recipient_email, sent_at, vertical_id) VALUES ('p1', 'kari@gmail.com', ?, 'experiences')`)
      .run(nowIso);

    const withExp = getCrossPlatformSuppressors(rfbDb, 60, { expDb });
    eq(
      withExp.find(buildCrossPlatformIdentity({ email: "helt@annen.no", orgNr: "987654321" }))?.match,
      "org_nr",
      "ac3b: RFB candidate with same org.nr but unrelated address is blocked (match: org_nr)",
    );
    eq(
      withExp.find(buildCrossPlatformIdentity({ email: "helt@annen.no", website: "fjellgard.no" }))?.match,
      "website",
      "ac3c: RFB candidate with same website host is blocked (match: website)",
    );
    eq(
      withExp.find(buildCrossPlatformIdentity({ email: "helt@annen.no", orgNr: "111111111", website: "annet.no" })),
      undefined,
      "ac3d: different org.nr / website / address -> not blocked",
    );
    const withoutExp = getCrossPlatformSuppressors(rfbDb, 60);
    eq(
      withoutExp.find(buildCrossPlatformIdentity({ email: "helt@annen.no", orgNr: "987654321" })),
      undefined,
      "ac3e: without Opplevagent provider data only address + domain can match",
    );
    eq(
      withoutExp.find(buildCrossPlatformIdentity({ email: "kari@gmail.com" }))?.match,
      "email",
      "ac3f: exact address still blocks without provider data",
    );
    rfbDb.close();
    expDb.close();
  }

  // ── AC4: RFB candidates dry run reports `match` per suppressed row ───
  try {
    const { __setDbForTesting, __initSchemaForTesting, getDb } = require("../database/init") as
      typeof import("../database/init");
    const prevDb = (() => {
      try { return getDb(); } catch { return undefined; }
    })();
    const prevAdminKey = process.env.ADMIN_KEY;
    const testDb = new Database(":memory:");
    testDb.pragma("journal_mode = DELETE");
    testDb.pragma("foreign_keys = OFF");
    try {
      __setDbForTesting(testDb as any);
      __initSchemaForTesting(testDb as any);
      process.env.ADMIN_KEY = process.env.ADMIN_KEY || "cpm-test-key";

      const modPath = require.resolve("../routes/admin-outreach-candidates");
      delete require.cache[modPath];
      const router = (require("../routes/admin-outreach-candidates") as
        typeof import("../routes/admin-outreach-candidates")).default;

      const insertPoolAgent = (id: string, name: string, email: string) => {
        testDb.prepare(`
          INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key)
          VALUES (?, ?, 'test producer', 'test', ?, ?, 'producer', ?)
        `).run(id, name, email, `https://${id}.example.net`, `key-${id}`);
        testDb.prepare(`
          INSERT INTO agent_knowledge
            (agent_id, email, about, field_provenance, verification_status, enrichment_status,
             url_last_status, url_last_probed)
          VALUES (?, ?, ?, '{}', 'verified', 'rich', 200, datetime('now'))
        `).run(id, email, "x".repeat(200));
      };
      const insertOtherLaneSend = (agentId: string, email: string, vertical: string) => {
        testDb.prepare(`
          INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, vertical_id)
          VALUES (?, ?, 't', 't', 'x@example.com', 'https://other.example.org', 'producer', ?, ?)
        `).run(agentId, `${agentId} AS`, `key-${agentId}`, vertical);
        testDb.prepare(`
          INSERT INTO outreach_sent_log (agent_id, recipient_email, sent_at, channel, vertical_id)
          VALUES (?, LOWER(?), ?, 'email', ?)
        `).run(agentId, email, nowIso, vertical);
      };

      insertPoolAgent("cpm-drue", "Druehagen Gard", "post@druehagen.no");
      insertPoolAgent("cpm-gmail", "Gmail Gard", "ola.bonde@gmail.com");
      insertPoolAgent("cpm-fri", "Fri Gard", "post@frigard.no");
      insertOtherLaneSend("cpm-other-1", "eventer@druehagen.no", "experiences");
      insertOtherLaneSend("cpm-other-2", "kari.nordmann@gmail.com", "experiences");

      let result: { status: number; body: any } = { status: 200, body: undefined };
      const req: any = { method: "GET", url: "/", query: { mode: "first" }, headers: { "x-admin-key": process.env.ADMIN_KEY } };
      const res: any = {
        statusCode: 200,
        status(c: number) { this.statusCode = c; return this; },
        json(p: any) { result = { status: this.statusCode, body: p }; return this; },
      };
      router.handle(req, res, (err?: any) => {
        if (err) result = { status: 500, body: { error: String(err) } };
      });

      const emails = (result.body?.candidates || []).map((c: any) => c.email);
      const producers = (result.body?.cross_platform_cooldown?.producers || []) as Array<{ agent_id: string; match: string }>;
      const druehagen = producers.find((p) => p.agent_id === "cpm-drue");
      eq(druehagen?.match, "domain", "ac4a: dry run reports match=domain for the Druehagen row");
      eq(emails.includes("post@druehagen.no"), false, "ac1k: RFB candidate post@druehagen.no is excluded after an opplevagent send to eventer@");
      eq(producers.some((p) => p.agent_id === "cpm-gmail"), false, "ac2d: a different gmail address is not cross-platform suppressed");
      eq(emails.includes("ola.bonde@gmail.com"), true, "ac2e: the gmail candidate stays a candidate");
      eq(emails.includes("post@frigard.no"), true, "ac4b: unrelated candidate unaffected");
      eq(result.body?.cross_platform_cooldown?.by_match, { domain: 1 }, "ac4c: by_match counts per rule");
    } finally {
      if (prevAdminKey === undefined) delete process.env.ADMIN_KEY;
      else process.env.ADMIN_KEY = prevAdminKey;
      try { if (prevDb) __setDbForTesting(prevDb); } catch { /* best effort */ }
    }
  } catch (err: any) {
    failed++;
    failures.push("cross-platform-match: route test unexpected error: " + String(err?.stack || err?.message || err));
  }

  return { passed, failed, failures };
}

if (require.main === module) {
  const r = runCrossPlatformMatchTests();
  console.log(`cross-platform-match: ${r.passed} passed, ${r.failed} failed`);
  for (const f of r.failures) console.log(f);
  process.exit(r.failed > 0 ? 1 : 0);
}
