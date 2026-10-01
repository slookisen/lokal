/**
 * opplevelser-gardssalg-outreach-reply-guard-touch-cap.test.ts — dev-request
 * 2026-09-30-opplevagent-svarvakt-og-tak-2: computeGardssalgOutreachSendEligibility
 * (src/routes/opplevelser.ts) must refuse
 *   - reason "replied": the producer has >=1 inbound CRM message on a thread
 *     with its contact (same has_replied logic as the candidates route), and
 *   - reason "max_touch_reached": >=2 real rows in experience_outreach_sent_log
 *     (status sent AND reserved both count),
 * and computeGardssalgOutreachDailyPrep must show the same reasons in its
 * `excluded` list. A producer with exactly 1 send (outside cooldown) and no
 * reply stays a follow-up candidate.
 *
 * Exported runOpplevelserGardssalgOutreachReplyGuardTouchCapTests({log}) ->
 * TestSummary; wired into tests/test.ts. Standalone:
 * npx tsx src/routes/opplevelser-gardssalg-outreach-reply-guard-touch-cap.test.ts
 */

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

const VERIFIED_PROVENANCE = JSON.stringify({
  hjemmeside_verification: { verified: true, classification: "verified", checked_at: "2026-09-01T00:00:00.000Z" },
});
const REALISTIC_ABOUT_TEXT =
  "Vi driver et lite gårdsbruk og lager drikke av råvarer fra vår egen gård. " +
  "Produktene selges direkte fra gårdsutsalget til besøkende gjennom hele sesongen.";

export function runOpplevelserGardssalgOutreachReplyGuardTouchCapTests(
  opts: { log?: boolean } = {},
): Promise<TestSummary> {
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

  return (async () => {
    const prevExperiencesDbPath = process.env.EXPERIENCES_DB_PATH;
    const prevCooldownDays = process.env.OUTREACH_COOLDOWN_DAYS;
    const prevMaxCandidates = process.env.DAILY_PREP_MAX_CANDIDATES;
    process.env.EXPERIENCES_DB_PATH = ":memory:";
    process.env.OUTREACH_COOLDOWN_DAYS = "40";
    delete process.env.DAILY_PREP_MAX_CANDIDATES;

    const dbFactoryPath = require.resolve("../database/db-factory");
    const emailPath = require.resolve("../services/email-service");
    const blocklistPath = require.resolve("../services/blocklist-service");
    const experienceStorePath = require.resolve("../services/experience-store");
    const opplevelserPath = require.resolve("./opplevelser");
    const cachePaths = [dbFactoryPath, emailPath, blocklistPath, experienceStorePath, opplevelserPath];
    for (const p of cachePaths) delete require.cache[p];

    let prevRfbDb: any = null;
    try {
      try {
        (require("../config/vertical-config") as typeof import("../config/vertical-config")).loadConfigsAtBoot();
      } catch {
        // already loaded / not needed
      }
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const expDb = dbFactory.getDb("experiences");

      const initMod = require("../database/init") as typeof import("../database/init");
      const Database = require("better-sqlite3") as typeof import("better-sqlite3");
      prevRfbDb = initMod.__peekDbForTesting();
      const rfbDb = new Database(":memory:");
      initMod.__setDbForTesting(rfbDb as any);
      initMod.__initSchemaForTesting(rfbDb as any);

      const opplevelserMod = require("./opplevelser") as typeof import("./opplevelser");
      const { computeGardssalgOutreachSendEligibility, computeGardssalgOutreachDailyPrep } = opplevelserMod;

      const insertProvider = expDb.prepare(
        `INSERT INTO experience_providers
           (id, navn, vertical, org_nr, kommune, rfb_seed_source, producer_type,
            epost, telefon, hjemmeside, about_text, visit_text, opening_hours_text,
            products, content_source, booking_live, catalog_hidden, slug, field_provenance,
            brreg_verified, antall_ansatte, naeringskode,
            enrichment_state, verification_status, source, confidence)
         VALUES
           (@id, @navn, 'experiences', @org_nr, 'Voss', 'rfb-seed', 'bryggeri',
            @epost, NULL, @hjemmeside, @about_text, NULL, NULL,
            'Øl, juleøl', 'provider_site', 0, 0, @slug, @field_provenance,
            1, 4, NULL,
            'raw', 'pending_verify', 'test-fixture', 'medium')`,
      );
      let seq = 0;
      const mk = (id: string): string => {
        seq++;
        const domain = `${id}.no`;
        insertProvider.run({
          id, navn: id, org_nr: String(300000000 + seq), epost: `post@${domain}`,
          hjemmeside: `https://${domain}`, about_text: REALISTIC_ABOUT_TEXT, slug: id,
          field_provenance: VERIFIED_PROVENANCE,
        });
        return `post@${domain}`;
      };
      const addLog = (providerId: string, email: string, daysAgo: number, notes: string | null): void => {
        const at = new Date(Date.now() - daysAgo * 86400_000).toISOString();
        expDb
          .prepare(
            `INSERT INTO experience_outreach_sent_log (provider_id, recipient_email, sent_at, message_id, notes, is_test)
             VALUES (?, ?, ?, ?, ?, 0)`,
          )
          .run(providerId, email, at, notes ? null : "msg-" + providerId, notes);
      };
      let crmSeq = 0;
      const addInbound = (providerId: string, email: string): void => {
        crmSeq++;
        rfbDb
          .prepare(
            `INSERT INTO crm_contacts (id, type, agent_id, provider_id, email, name, status, vertical_id)
             VALUES (?, 'producer', NULL, ?, ?, 'Kontakt', 'active', 'experiences')`,
          )
          .run(`rg-c-${crmSeq}`, providerId, email);
        rfbDb
          .prepare(
            `INSERT INTO crm_threads (id, contact_id, subject, status, category, vertical_id)
             VALUES (?, ?, 'Re: henvendelse', 'new', 'innkommende', 'experiences')`,
          )
          .run(`rg-t-${crmSeq}`, `rg-c-${crmSeq}`);
        rfbDb
          .prepare(
            `INSERT INTO crm_messages
               (id, thread_id, direction, from_email, to_emails, subject, body_text, sent_at, delivery_status, vertical_id)
             VALUES (?, ?, 'in', ?, '["outreach@opplevagent.no"]', 'Re: henvendelse', 'Ja takk!', ?, 'sent', 'experiences')`,
          )
          .run(`rg-m-${crmSeq}`, `rg-t-${crmSeq}`, email, new Date().toISOString());
      };

      // prov-a-fresh: no history -> eligible (first touch).
      mk("prov-a-fresh");
      // prov-b-replied: 1 send 50d ago (outside 40d cooldown) + inbound reply -> replied.
      const emailB = mk("prov-b-replied");
      addLog("prov-b-replied", emailB, 50, null);
      addInbound("prov-b-replied", emailB);
      // prov-c-max: 2 sends (one sent, one reserved), both outside cooldown, no reply -> max_touch_reached.
      const emailC = mk("prov-c-max");
      addLog("prov-c-max", emailC, 90, null);
      addLog("prov-c-max", emailC, 50, "reserved");
      // prov-d-followup: exactly 1 send 50d ago, no reply -> still eligible follow-up.
      const emailD = mk("prov-d-followup");
      addLog("prov-d-followup", emailD, 50, null);
      // prov-e-replied-first: reply and no sends at all -> replied wins (never cold-mail a replier).
      const emailE = mk("prov-e-replied-first");
      addInbound("prov-e-replied-first", emailE);
      // prov-f-reserved2: two RESERVED rows only -> max_touch_reached (reserved counts).
      const emailF = mk("prov-f-reserved2");
      addLog("prov-f-reserved2", emailF, 90, "reserved");
      addLog("prov-f-reserved2", emailF, 50, "reserved");

      const ids = ["prov-a-fresh", "prov-b-replied", "prov-c-max", "prov-d-followup", "prov-e-replied-first", "prov-f-reserved2"];
      const elig = computeGardssalgOutreachSendEligibility(expDb, ids, { skipRecipientDedupe: true });
      const byId = new Map(elig.map((e) => [e.provider_id, e]));
      const view = (id: string) => {
        const e = byId.get(id);
        return [e?.eligible, e && !e.eligible ? e.reason : null];
      };

      assertEq(view("prov-a-fresh"), [true, null], "a1: no history -> eligible");
      assertEq(view("prov-b-replied"), [false, "replied"], "b1: inbound CRM reply -> replied (even though outside cooldown)");
      assertEq(view("prov-c-max"), [false, "max_touch_reached"], "c1: 1 sent + 1 reserved row -> max_touch_reached");
      assertEq(view("prov-d-followup"), [true, null], "d1: 1 send, no reply -> still an eligible follow-up candidate");
      assertEq(view("prov-e-replied-first"), [false, "replied"], "e1: reply without any prior send -> replied");
      assertEq(view("prov-f-reserved2"), [false, "max_touch_reached"], "f1: two reserved rows count -> max_touch_reached");

      // A test send (is_test=1) never counts toward the cap.
      expDb
        .prepare(
          `INSERT INTO experience_outreach_sent_log (provider_id, recipient_email, sent_at, is_test) VALUES (?, ?, ?, 1)`,
        )
        .run("prov-d-followup", emailD, new Date(Date.now() - 60 * 86400_000).toISOString());
      const again = computeGardssalgOutreachSendEligibility(expDb, ["prov-d-followup"], { skipRecipientDedupe: true });
      assertEq(again[0].eligible, true, "g1: an is_test send does not count toward the cap");

      // Daily prep shows the same two reasons in `excluded`, and keeps the
      // follow-up candidate in `candidates`.
      const prep = computeGardssalgOutreachDailyPrep(expDb);
      const excludedById = new Map(prep.response.excluded.map((x: any) => [x.provider_id, x.reason]));
      assertEq(excludedById.get("prov-b-replied"), "replied", "h1: daily-prep excluded shows replied");
      assertEq(excludedById.get("prov-e-replied-first"), "replied", "h2: daily-prep excluded shows replied (no prior send)");
      assertEq(excludedById.get("prov-c-max"), "max_touch_reached", "h3: daily-prep excluded shows max_touch_reached");
      assertEq(excludedById.get("prov-f-reserved2"), "max_touch_reached", "h4: daily-prep excluded shows max_touch_reached (reserved)");
      const candIds = prep.response.candidates.map((c: any) => c.provider_id).sort();
      assertEq(candIds, ["prov-a-fresh", "prov-d-followup"], "h5: daily-prep candidates = fresh + 1-send follow-up only");
      assertEq(prep.selected.map((s) => s.provider_id).sort(), ["prov-a-fresh", "prov-d-followup"], "h6: selected agrees with preview");
    } catch (err) {
      failed++;
      failures.push(`✗ reply-guard/touch-cap suite threw: ${(err as Error)?.stack ?? err}`);
    } finally {
      try {
        if (prevRfbDb) (require("../database/init") as typeof import("../database/init")).__setDbForTesting(prevRfbDb);
      } catch {
        // best-effort
      }
      try {
        (require("../database/db-factory") as typeof import("../database/db-factory")).__resetDbFactoryForTesting();
      } catch {
        // best-effort
      }
      const restore = (k: string, v: string | undefined) => {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      };
      restore("EXPERIENCES_DB_PATH", prevExperiencesDbPath);
      restore("OUTREACH_COOLDOWN_DAYS", prevCooldownDays);
      restore("DAILY_PREP_MAX_CANDIDATES", prevMaxCandidates);
      for (const p of cachePaths) delete require.cache[p];
    }
    return { passed, failed, failures };
  })();
}

if (require.main === module) {
  runOpplevelserGardssalgOutreachReplyGuardTouchCapTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    for (const f of summary.failures) console.log(f);
    process.exit(summary.failed > 0 ? 1 : 0);
  });
}
