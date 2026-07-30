/**
 * crm-contact-provider-link.test.ts — dev-request
 * 2026-07-27-crm-plattformadskillelse-opplevagent, steg 6 / funn 6.
 *
 *   «crm_contacts.agent_id er REFERENCES agents(id) — RFB-agenter, i
 *    RFB-databasen. Opplevagent-produsenter ligger i experience_providers i en
 *    ANNEN database. … Krav uansett: en kontakt kan aldri peke på en entitet i
 *    feil vertical.»
 *
 * The pre-steg-6 behaviour was worse than "no way to link": classifyEmail()
 * matched EVERY vertical's contacts against the RFB agents table, so an
 * experiences contact whose email matched an RFB producer silently got
 * agent_id pointing at the wrong platform's entity. That cross-link is the
 * exact merge-of-platforms this whole dev-request forbids, and cl2 below is
 * the regression test for it.
 *
 * Organisation:
 *   cl1-cl2    The live bug and the rfb regression. An rfb contact still links
 *              exactly as before; an experiences contact matching an RFB agent
 *              links to NOTHING.
 *   cl3-cl9    Provider matching (the experiences twin): exact epost, epost
 *              domain, hjemmeside domain (JS-verified, not LIKE-decided),
 *              freemail refusal, brreg_active=0 refusal.
 *   cl10-cl12  The schema triggers: a direct SQL write that points across
 *              verticals aborts, in both directions — the invariant holds even
 *              for code that never goes through crm-service.
 *   cl13-cl14  The healing sweep: a pre-existing cross-link is cleared on
 *              initSchema and the clearing is logged, visible, not silent.
 *   cl15-cl17  setContactType validation: wrong-vertical pointer throws,
 *              nonexistent provider throws, the valid case writes.
 *   cl18-cl20  Read-side: provider_name on detail + list, dangling pointer
 *              marked provider_missing, self-heal re-links on next touch.
 *   cl21-cl22  «Adskilte kontakter» end-to-end: the same email on both
 *              platforms yields two rows, each linked to its OWN vertical's
 *              entity, neither to the other's.
 *
 * Standalone:
 *   node node_modules/tsx/dist/cli.mjs src/services/crm-contact-provider-link.test.ts
 */

import Database from "better-sqlite3";
import * as initMod from "../database/init";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export function runCrmContactProviderLinkTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];

  function assertTrue(cond: boolean, label: string): void {
    if (cond) { passed++; if (log) console.log(`  ok ${label}`); }
    else { failed++; failures.push(`✗ ${label}`); if (log) console.log(`  ✗ ${label}`); }
  }
  function assertEq(actual: unknown, expected: unknown, label: string): void {
    assertTrue(actual === expected, `${label} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
  }
  function assertThrows(fn: () => void, needle: string, label: string): void {
    try {
      fn();
      assertTrue(false, `${label} (expected a throw containing ${JSON.stringify(needle)}, got none)`);
    } catch (e) {
      assertTrue(String((e as Error).message).includes(needle),
        `${label} (thrown message ${JSON.stringify((e as Error).message)} should contain ${JSON.stringify(needle)})`);
    }
  }

  return (async () => {
    const prevDb = initMod.__peekDbForTesting();
    const prevExpPath = process.env.EXPERIENCES_DB_PATH;

    // The experiences DB MUST be redirected before anything touches
    // db-factory: its default path is /app/data/experiences.db — the
    // PRODUCTION volume. This is the same defect class the #401 reviewer
    // found in an earlier test (writing to /app/data/dental.db while green),
    // so cl0 asserts the redirect actually took, not just that we set an env.
    process.env.EXPERIENCES_DB_PATH = ":memory:";

    // Fresh-require db-factory AND crm-service TOGETHER (the repo's
    // gardssalg-claim.test pattern, and the hard-won reason for it): earlier
    // suites delete db-factory from require.cache, so a later bare require()
    // creates a NEW module instance — while a crm-service loaded 100 suites
    // ago keeps its closure over the OLD instance and its stale 'experiences'
    // handle. Seeds then land in a database crm-service never reads, and
    // every assertion tests nothing. Deleting both and re-requiring both
    // makes them share one fresh db-factory. cl0c below verifies this took.
    const dbFactoryPath = require.resolve("../database/db-factory");
    const crmServicePath = require.resolve("./crm-service");
    for (const pth of [dbFactoryPath, crmServicePath]) delete require.cache[pth];

    const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
    dbFactory.__resetDbFactoryForTesting();

    const db = new Database(":memory:");
    const crm = require("./crm-service") as typeof import("./crm-service");

    try {
      initMod.__setDbForTesting(db as any);
      initMod.__initSchemaForTesting(db as any);

      const xdb = dbFactory.getDb("experiences");
      {
        const list = xdb.pragma("database_list") as Array<{ file: string }>;
        assertEq(list[0]?.file ?? "", "",
          "cl0: the experiences handle is genuinely in-memory — this suite must never be able to touch /app/data/experiences.db");
        // In a long multi-suite run, a second db-factory module instance (tsx
        // CJS/ESM dual registry) would give crm-service a DIFFERENT handles
        // cache than this test — the seeds would land in a DB crm-service
        // never reads and every assertion below would be testing nothing.
        const factoryInstances = Object.keys(require.cache ?? {}).filter((k) =>
          /database[\/\\]db-factory/.test(k));
        assertTrue(factoryInstances.length <= 1,
          `cl0b: exactly one db-factory module instance is loaded (found ${factoryInstances.length}: ${factoryInstances.join(", ")})`);
      }

      // ── Fixtures ─────────────────────────────────────────────────
      // One RFB producer and three experience providers, arranged so the
      // interesting collisions exist: bryggeri-post is BOTH an RFB agent
      // email and a provider email (cl21/cl22), and dodgaard is brreg-dead.
      db.prepare(`INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, is_active)
                  VALUES ('cl-agent-1','Fjellgard Ysteri','x','test','post@fjellgard.no','https://fjellgard.no','producer','cl-key-1',1)`).run();
      db.prepare(`INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, is_active)
                  VALUES ('cl-agent-2','Bryggeri og Gard','x','test','post@bryggerigard.no','https://bryggerigard.no','producer','cl-key-2',1)`).run();

      const seedProvider = xdb.prepare(
        `INSERT INTO experience_providers (id, navn, epost, hjemmeside, brreg_active) VALUES (?, ?, ?, ?, ?)`,
      );
      seedProvider.run("cl-prov-1", "Bryggeri og Gard AS", "post@bryggerigard.no", "https://bryggerigard.no", 1);
      seedProvider.run("cl-prov-2", "Sider fra Fjorden", null, "https://www.fjordsider.no/besok", null);
      seedProvider.run("cl-prov-3", "Dødgard Destilleri", "post@dodgaard.no", "https://dodgaard.no", 0);
      // For cl6: a provider whose hjemmeside CONTAINS someone else's domain as
      // a substring — the exact false-positive the LIKE prefilter produces.
      seedProvider.run("cl-prov-5", "Ikke Gardsbryg AS", null, "https://www.ikkegardsbryg.no", 1);

      // Sanity THROUGH crm-service's own db-factory path: if crm-service
      // resolves a different experiences handle than xdb (stale cache from an
      // earlier suite, dual module instance), this fails HERE with a clear
      // label instead of as a cascade of mysterious misses further down.
      {
        const probe = crm.crmService.resolveContact("cl0-probe@ukjent.no", null, "experiences");
        let seen = true;
        let seenErr = "";
        try {
          crm.crmService.setContactType(probe.id, "producer", null, "cl-prov-1");
        } catch (e) {
          seen = false;
          seenErr = (e as Error).message;
        }
        const sameHandle = dbFactory.getDb("experiences") === xdb;
        assertTrue(seen,
          `cl0c: crm-service sees the SAME experiences DB as this suite's seeds ` +
          `(sameHandle=${sameHandle}, open=${(xdb as any).open}, err=${JSON.stringify(seenErr)})`);
        // Reset the probe so it doesn't shadow later fixtures.
        crm.crmService.setContactType(probe.id, "unknown", null, null);
      }

      // ═══════════════════════════════════════════════════════════════
      // cl1-cl2 — the live bug and the rfb regression
      // ═══════════════════════════════════════════════════════════════
      {
        const r = crm.crmService.resolveContact("post@fjellgard.no", null, "rfb");
        const c = db.prepare("SELECT type, agent_id, provider_id FROM crm_contacts WHERE id = ?").get(r.id) as any;
        assertEq(c?.agent_id, "cl-agent-1", "cl1: an rfb contact matching an RFB agent links exactly as before steg 6");
        assertEq(c?.provider_id, null, "cl1b: …and its provider_id is null — the pointer belongs to the other vertical");
        assertEq(c?.type, "producer", "cl1c: …classified producer");
      }
      {
        // THE pre-steg-6 defect: fjellgard.no matches an RFB agent, and this
        // contact is on the experiences platform. Before this change the row
        // came back type='producer', agent_id='cl-agent-1' — a pointer at the
        // wrong vertical's entity, exactly what funn 6 forbids.
        const r = crm.crmService.resolveContact("noen@fjellgard.no", null, "experiences");
        const c = db.prepare("SELECT type, agent_id, provider_id FROM crm_contacts WHERE id = ?").get(r.id) as any;
        assertEq(c?.agent_id, null, "cl2: an experiences contact matching an RFB AGENT links to NO agent — the cross-vertical link was the bug");
        assertEq(c?.provider_id, null, "cl2b: …and to no provider either (fjellgard.no is not a provider)");
        assertEq(c?.type, "unknown", "cl2c: …so it is honestly 'unknown', for Daniel, not confidently wrong");
      }

      // ═══════════════════════════════════════════════════════════════
      // cl3-cl9 — provider matching tiers
      // ═══════════════════════════════════════════════════════════════
      {
        const r = crm.crmService.resolveContact("post@bryggerigard.no", null, "experiences");
        const c = db.prepare("SELECT type, agent_id, provider_id FROM crm_contacts WHERE id = ?").get(r.id) as any;
        assertEq(c?.provider_id, "cl-prov-1", "cl3: exact epost match links the experiences contact to the provider");
        assertEq(c?.agent_id, null, "cl3b: …with agent_id null even though the SAME email is an RFB agent's contact_email");
        assertEq(c?.type, "producer", "cl3c: …classified producer");
      }
      {
        const r = crm.crmService.resolveContact("booking@bryggerigard.no", null, "experiences");
        const c = db.prepare("SELECT provider_id FROM crm_contacts WHERE id = ?").get(r.id) as any;
        assertEq(c?.provider_id, "cl-prov-1", "cl4: a different mailbox on the provider's epost domain still links (tier 2)");
      }
      {
        const r = crm.crmService.resolveContact("kontakt@fjordsider.no", null, "experiences");
        const c = db.prepare("SELECT provider_id, type FROM crm_contacts WHERE id = ?").get(r.id) as any;
        assertEq(c?.provider_id, "cl-prov-2", "cl5: hjemmeside-domain match links a provider with NO epost at all (tier 3, www./path-safe)");
        assertEq(c?.type, "producer", "cl5b: …and classifies producer");
      }
      {
        // LIKE-prefilter honesty, in the direction the prefilter actually
        // runs (hjemmeside LIKE %domain%): the email domain 'gardsbryg.no' IS
        // a substring of cl-prov-5's hjemmeside 'www.ikkegardsbryg.no', so
        // the SQL prefilter genuinely returns cl-prov-5 as a candidate — and
        // the JS registrable-domain check must reject it
        // (ikkegardsbryg.no != gardsbryg.no). The first version of this test
        // had the substring direction BACKWARDS, produced zero prefilter
        // candidates, and a decide-by-LIKE mutant sailed through 45/0.
        const r = crm.crmService.resolveContact("post@gardsbryg.no", null, "experiences");
        const c = db.prepare("SELECT provider_id, type FROM crm_contacts WHERE id = ?").get(r.id) as any;
        assertEq(c?.provider_id, null, "cl6: a provider whose hjemmeside merely CONTAINS the email domain as a substring does not match — LIKE is a prefilter, not the decision");
      }
      {
        const r = crm.crmService.resolveContact("bryggerigard@gmail.com", null, "experiences");
        const c = db.prepare("SELECT provider_id, type FROM crm_contacts WHERE id = ?").get(r.id) as any;
        assertEq(c?.provider_id, null, "cl7: freemail never domain-matches — a gmail address identifies a person, not an org");
        assertEq(c?.type, "unknown", "cl7b: …unknown, for Daniel");
      }
      {
        const r = crm.crmService.resolveContact("post@dodgaard.no", null, "experiences");
        const c = db.prepare("SELECT provider_id FROM crm_contacts WHERE id = ?").get(r.id) as any;
        assertEq(c?.provider_id, null, "cl8: a brreg_active=0 (konkurs) provider is never auto-linked — the rfb path's is_active=1 analog");
      }
      {
        // Vendor allowlist still applies on the experiences platform.
        const r = crm.crmService.resolveContact("noreply@github.com", null, "experiences");
        const c = db.prepare("SELECT type, agent_id, provider_id FROM crm_contacts WHERE id = ?").get(r.id) as any;
        assertEq(c?.type, "vendor", "cl9: the vendor allowlist is platform-independent — github is a vendor on every vertical");
        assertTrue(c?.agent_id === null && c?.provider_id === null, "cl9b: …and vendors link to no entity");
      }

      // ═══════════════════════════════════════════════════════════════
      // cl10-cl12 — the schema triggers hold for RAW SQL
      // ═══════════════════════════════════════════════════════════════
      assertThrows(
        () => db.prepare(`INSERT INTO crm_contacts (id, type, agent_id, email, vertical_id)
                          VALUES ('cl-bad-1','producer','cl-agent-1','sneak@x.no','experiences')`).run(),
        "crm_contact_agent_id_wrong_vertical",
        "cl10: INSERTing an experiences contact with an agent_id aborts at the schema — the invariant does not depend on going through crm-service",
      );
      assertThrows(
        () => db.prepare(`INSERT INTO crm_contacts (id, type, provider_id, email, vertical_id)
                          VALUES ('cl-bad-2','producer','cl-prov-1','sneak2@x.no','rfb')`).run(),
        "crm_contact_provider_id_wrong_vertical",
        "cl11: …and the mirror direction: an rfb contact with a provider_id aborts too",
      );
      {
        const victim = crm.crmService.resolveContact("post@bryggerigard.no", null, "experiences");
        assertThrows(
          () => db.prepare(`UPDATE crm_contacts SET agent_id = 'cl-agent-2' WHERE id = ?`).run(victim.id),
          "crm_contact_agent_id_wrong_vertical",
          "cl12: UPDATE is guarded like INSERT — a later mutation can't sneak the cross-link back in",
        );
      }

      // ═══════════════════════════════════════════════════════════════
      // cl13-cl14 — the healing sweep clears pre-existing cross-links
      // ═══════════════════════════════════════════════════════════════
      {
        // Simulate the prod state this migration will actually meet: a row
        // linked across verticals BEFORE the triggers existed. Drop the
        // triggers (as pre-deploy prod has none), plant the bad row, then
        // re-run initSchema the way a deploy boot does.
        db.exec(`DROP TRIGGER IF EXISTS trg_crm_contacts_agent_vertical_ins;
                 DROP TRIGGER IF EXISTS trg_crm_contacts_agent_vertical_upd;`);
        db.prepare(`INSERT INTO crm_contacts (id, type, agent_id, email, vertical_id)
                    VALUES ('cl-legacy-x','producer','cl-agent-1','legacy@fjellgard.no','experiences')`).run();
        initMod.__initSchemaForTesting(db as any);

        const healed = db.prepare("SELECT agent_id FROM crm_contacts WHERE id = 'cl-legacy-x'").get() as any;
        assertEq(healed?.agent_id, null, "cl13: a pre-existing cross-vertical link is CLEARED by the boot-time sweep");
        const action = db.prepare(
          `SELECT payload FROM crm_actions WHERE contact_id = 'cl-legacy-x' AND type = 'crm_cross_vertical_agent_link_cleared'`,
        ).get() as any;
        assertTrue(!!action, "cl14: …and the clearing is LOGGED on the contact — visible in its history, not silent");
        assertTrue(String(action?.payload ?? "").includes("cl-agent-1"),
          "cl14b: …naming the agent_id that was removed, so the un-link is reconstructable");
      }

      // ═══════════════════════════════════════════════════════════════
      // cl15-cl17 — setContactType validation
      // ═══════════════════════════════════════════════════════════════
      {
        const expC = crm.crmService.resolveContact("manuell@fjordsider.info", null, "experiences");
        const rfbC = crm.crmService.resolveContact("manuell@fjordsider.info", null, "rfb");

        assertThrows(
          () => crm.crmService.setContactType(expC.id, "producer", "cl-agent-1", null),
          "feil vertical",
          "cl15: setContactType refuses an agentId on an experiences contact with a message a human can act on",
        );
        assertThrows(
          () => crm.crmService.setContactType(rfbC.id, "producer", null, "cl-prov-1"),
          "feil vertical",
          "cl15b: …and refuses a providerId on an rfb contact",
        );
        assertThrows(
          () => crm.crmService.setContactType(expC.id, "producer", null, "finnes-ikke"),
          "does not exist",
          "cl16: a providerId that isn't a real experience_providers row throws — the code-level half of the cross-DB FK",
        );
        try {
          crm.crmService.setContactType(expC.id, "producer", null, "cl-prov-2");
        } catch (e) {
          assertTrue(false, `cl17-pre: the valid manual link did not throw (got: ${(e as Error).message})`);
        }
        const c = db.prepare("SELECT type, provider_id FROM crm_contacts WHERE id = ?").get(expC.id) as any;
        assertEq(c?.provider_id, "cl-prov-2", "cl17: the valid manual link writes");
        assertEq(c?.type, "producer", "cl17b: …with the type");
      }

      // ═══════════════════════════════════════════════════════════════
      // cl18-cl20 — read-side + self-heal
      // ═══════════════════════════════════════════════════════════════
      {
        const linked = crm.crmService.resolveContact("post@bryggerigard.no", null, "experiences");
        const detail = crm.crmService.getContactDetail(linked.id);
        assertEq(detail?.contact?.provider_name, "Bryggeri og Gard AS",
          "cl18: getContactDetail resolves the provider's NAME across the database boundary — a bare uuid is useless to a human");

        const list = crm.crmService.listContacts("producer", { vertical: "experiences" }) as any[];
        const row = list.find((r) => r.id === linked.id);
        assertEq(row?.provider_name, "Bryggeri og Gard AS", "cl18b: …and listContacts does the same, batched");
      }
      {
        // Dangling pointer: provider deleted after linking. No FK can stop it
        // (different database file) — so the READ must say so instead.
        const linked = crm.crmService.resolveContact("kontakt@fjordsider.no", null, "experiences");
        xdb.prepare("DELETE FROM experience_providers WHERE id = 'cl-prov-2'").run();
        const detail = crm.crmService.getContactDetail(linked.id);
        assertEq(detail?.contact?.provider_missing, true,
          "cl19: a dangling provider_id is flagged provider_missing — identical-to-unlinked is the silence this dev-request exists to stop");
        assertEq(detail?.contact?.provider_name, null, "cl19b: …with provider_name null, not a stale value");
        // Restore for later assertions.
        seedProvider.run("cl-prov-2", "Sider fra Fjorden", null, "https://www.fjordsider.no/besok", null);
      }
      {
        // Self-heal: contact created before its provider existed re-links on
        // the very next touch — the exact mechanism that fixed the 2026-07-11
        // outreach P0 on the rfb side, now proven for the provider pointer.
        const early = crm.crmService.resolveContact("post@nyttbryggeri.no", null, "experiences");
        let c = db.prepare("SELECT provider_id FROM crm_contacts WHERE id = ?").get(early.id) as any;
        assertEq(c?.provider_id, null, "cl20: before the provider exists, the contact is honestly unlinked");
        seedProvider.run("cl-prov-4", "Nytt Bryggeri", "post@nyttbryggeri.no", null, 1);
        const again = crm.crmService.resolveContact("post@nyttbryggeri.no", null, "experiences");
        assertEq(again.id, early.id, "cl20b: same contact row on re-touch (no duplicate)");
        c = db.prepare("SELECT provider_id, type FROM crm_contacts WHERE id = ?").get(early.id) as any;
        assertEq(c?.provider_id, "cl-prov-4", "cl20c: …and the next touch self-heals the link");
        assertEq(c?.type, "producer", "cl20d: …upgrading unknown → producer");
      }

      // ═══════════════════════════════════════════════════════════════
      // cl21-cl22 — «adskilte kontakter», end to end
      // ═══════════════════════════════════════════════════════════════
      {
        // post@bryggerigard.no exists as BOTH an RFB agent email and a
        // provider epost. The same human writing to both platforms must end
        // up as two rows, each pointing at its OWN vertical's entity.
        const rfbSide = crm.crmService.resolveContact("post@bryggerigard.no", null, "rfb");
        const expSide = crm.crmService.resolveContact("post@bryggerigard.no", null, "experiences");
        assertTrue(rfbSide.id !== expSide.id, "cl21: the same email on two platforms is two contacts (steg 2), still true through steg 6");
        const a = db.prepare("SELECT agent_id, provider_id FROM crm_contacts WHERE id = ?").get(rfbSide.id) as any;
        const b = db.prepare("SELECT agent_id, provider_id FROM crm_contacts WHERE id = ?").get(expSide.id) as any;
        assertEq(a?.agent_id, "cl-agent-2", "cl21b: the rfb row points at the RFB agent…");
        assertEq(a?.provider_id, null, "cl21c: …and at no provider");
        assertEq(b?.provider_id, "cl-prov-1", "cl22: the experiences row points at the provider…");
        assertEq(b?.agent_id, null, "cl22b: …and at no agent. Neither row can see the other vertical's entity");
      }
    } finally {
      // Restore the previous rfb handle and evict the in-memory experiences
      // handle so later suites open their own (or the env-default) DB.
      if (prevExpPath === undefined) delete process.env.EXPERIENCES_DB_PATH;
      else process.env.EXPERIENCES_DB_PATH = prevExpPath;
      dbFactory.__resetDbFactoryForTesting();
      // Evict our fresh copies too, so the NEXT suite that requires either
      // module rebinds both from scratch instead of inheriting our pairing —
      // leaving them cached is exactly how an earlier suite set this trap.
      for (const pth of [dbFactoryPath, crmServicePath]) delete require.cache[pth];
      if (prevDb) initMod.__setDbForTesting(prevDb as any);
      try { db.close(); } catch { /* already closed */ }
    }

    return { passed, failed, failures };
  })();
}

// Standalone runner
if (require.main === module) {
  runCrmContactProviderLinkTests({ log: true }).then((s) => {
    console.log(`\ncrm-contact-provider-link: ${s.passed} passed, ${s.failed} failed`);
    if (s.failed > 0) {
      for (const f of s.failures) console.log(f);
      process.exit(1);
    }
  });
}
