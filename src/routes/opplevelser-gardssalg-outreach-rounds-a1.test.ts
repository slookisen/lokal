/**
 * opplevelser-gardssalg-outreach-rounds-a1.test.ts — dev-request
 * 2026-11-15-opplevagent-fem-henvendelser, slice A1 (cap stays at 2):
 *   AK1 — daily-prep candidates are the same set as before; only the order
 *         changes (first touches before follow-ups, then lowest round).
 *   AK2 — no template for the producer's round -> `no_template_for_touch`,
 *         and nothing is written to experience_outreach_sent_log.
 *   AK3 — latest real send used `personal-v4-followup` -> `promise_given`
 *         (sent-log template column, and the CRM fallback for older rows).
 *   AK4 — an unknown template name never renders the `standard` text.
 * Plus: the reservation stores the template name, sends per round in the run
 * report, and the per-round section of the v4 measurement.
 *
 * Exported runOpplevelserGardssalgOutreachRoundsA1Tests({log}) -> TestSummary;
 * wired into tests/test.ts. Standalone:
 * npx tsx src/routes/opplevelser-gardssalg-outreach-rounds-a1.test.ts
 */

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

const VERIFIED_PROVENANCE = {
  hjemmeside_verification: { verified: true, classification: "verified", checked_at: "2026-09-01T00:00:00.000Z" },
};
const REALISTIC_ABOUT_TEXT =
  "Vi driver et lite gårdsbruk og lager drikke av råvarer fra vår egen gård. " +
  "Produktene selges direkte fra gårdsutsalget til besøkende gjennom hele sesongen.";

export function runOpplevelserGardssalgOutreachRoundsA1Tests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
    const prevEnv = {
      EXPERIENCES_DB_PATH: process.env.EXPERIENCES_DB_PATH,
      OUTREACH_COOLDOWN_DAYS: process.env.OUTREACH_COOLDOWN_DAYS,
      DAILY_PREP_MAX_CANDIDATES: process.env.DAILY_PREP_MAX_CANDIDATES,
      EMAIL_FORCE_DRY_RUN: process.env.EMAIL_FORCE_DRY_RUN,
    };
    process.env.EXPERIENCES_DB_PATH = ":memory:";
    process.env.OUTREACH_COOLDOWN_DAYS = "40";
    process.env.EMAIL_FORCE_DRY_RUN = "true";
    delete process.env.DAILY_PREP_MAX_CANDIDATES;

    const dbFactoryPath = require.resolve("../database/db-factory");
    const emailPath = require.resolve("../services/email-service");
    const blocklistPath = require.resolve("../services/blocklist-service");
    const experienceStorePath = require.resolve("../services/experience-store");
    const opplevelserPath = require.resolve("./opplevelser");
    const cachePaths = [dbFactoryPath, emailPath, blocklistPath, experienceStorePath, opplevelserPath];
    const restoreModuleCache = (require("../../tests/module-cache") as typeof import("../../tests/module-cache")).swapOutModules(cachePaths);

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

      const m = require("./opplevelser") as typeof import("./opplevelser");
      const email = require("../services/email-service") as typeof import("../services/email-service");

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
          id, navn: id, org_nr: String(400000000 + seq), epost: `post@${domain}`,
          hjemmeside: `https://${domain}`, about_text: REALISTIC_ABOUT_TEXT, slug: id,
          field_provenance: JSON.stringify({
            ...VERIFIED_PROVENANCE,
            epost: [{ source_type: "registry", value: `post@${domain}`, source_url: `https://data.brreg.no/enhetsregisteret/api/enheter/${400000000 + seq}` }],
          }),
        });
        return `post@${domain}`;
      };
      const addLog = (providerId: string, to: string, daysAgo: number, template: string | null): void => {
        const at = new Date(Date.now() - daysAgo * 86400_000).toISOString();
        expDb
          .prepare(
            `INSERT INTO experience_outreach_sent_log (provider_id, recipient_email, sent_at, message_id, notes, is_test, template)
             VALUES (?, ?, ?, ?, NULL, 0, ?)`,
          )
          .run(providerId, to, at, `msg-${providerId}-${daysAgo}`, template);
      };
      const sentLogCount = (): number =>
        (expDb.prepare(`SELECT COUNT(*) AS n FROM experience_outreach_sent_log`).get() as { n: number }).n;
      let crmSeq = 0;
      const ensureThread = (threadId: string): void => {
        crmSeq++;
        rfbDb
          .prepare(
            `INSERT OR IGNORE INTO crm_contacts (id, type, agent_id, provider_id, email, name, status, vertical_id)
             VALUES (?, 'producer', NULL, NULL, ?, 'Kontakt', 'active', 'experiences')`,
          )
          .run(`a1-c-${crmSeq}`, `kontakt-${crmSeq}@example.invalid`);
        rfbDb
          .prepare(
            `INSERT OR IGNORE INTO crm_threads (id, contact_id, subject, status, category, vertical_id)
             VALUES (?, ?, 'Henvendelse', 'new', 'marketing', 'experiences')`,
          )
          .run(threadId, `a1-c-${crmSeq}`);
      };
      const addCrm = (
        threadId: string,
        direction: "in" | "out",
        from: string,
        to: string,
        sentAt: string,
        body: string,
        meta: Record<string, unknown>,
      ): void => {
        ensureThread(threadId);
        crmSeq++;
        rfbDb
          .prepare(
            `INSERT INTO crm_messages
               (id, thread_id, direction, from_email, to_emails, subject, body_text, sent_at, raw_metadata, delivery_status, vertical_id)
             VALUES (?, ?, ?, ?, ?, 'Henvendelse', ?, ?, ?, 'sent', 'experiences')`,
          )
          .run(`a1-m-${crmSeq}`, threadId, direction, from, JSON.stringify([to]), body, sentAt, JSON.stringify(meta));
      };

      // ── AK1: fixture (ids chosen so follow-ups sort BEFORE fresh by id) ──
      const e1 = mk("a1-p1-follow");
      addLog("a1-p1-follow", e1, 50, null); // legacy row (no template), no CRM
      mk("a1-p2-fresh");
      const e3 = mk("a1-p3-follow");
      addLog("a1-p3-follow", e3, 60, "personal-v4");
      mk("a1-p4-fresh");
      const e5 = mk("a1-p5-max");
      addLog("a1-p5-max", e5, 90, "personal-v4");
      addLog("a1-p5-max", e5, 50, "personal-v4-followup");
      const e6 = mk("a1-p6-cooldown");
      addLog("a1-p6-cooldown", e6, 5, "personal-v4");

      // Fasit: the candidate SET today's (pre-A1) rules give for this fixture.
      const fasitSet = ["a1-p1-follow", "a1-p2-fresh", "a1-p3-follow", "a1-p4-fresh"];
      const prep = m.computeGardssalgOutreachDailyPrep(expDb);
      const candIds = prep.response.candidates.map((c: any) => c.provider_id);
      assertEq([...candIds].sort(), fasitSet, "AK1a: daily-prep candidate set equals the pre-A1 fasit");
      assertEq(candIds, ["a1-p2-fresh", "a1-p4-fresh", "a1-p1-follow", "a1-p3-follow"], "AK1b: first touches before follow-ups, id order within a round");
      assertEq(prep.response.candidates.map((c: any) => c.touch_round), [1, 1, 2, 2], "AK1c: daily-prep shows touch_round per candidate");
      assertEq(prep.selected.map((s) => s.template), ["personal-v4", "personal-v4", "personal-v4-followup", "personal-v4-followup"], "AK1d: template from the round table (today's E/F)");
      const reasons = new Map(prep.response.excluded.map((x: any) => [x.provider_id, x.reason]));
      assertEq([reasons.get("a1-p5-max"), reasons.get("a1-p6-cooldown")], ["max_touch_reached", "cooldown_suppressed"], "AK1e: cap 2 and cooldown unchanged");

      process.env.DAILY_PREP_MAX_CANDIDATES = "2";
      const capped = m.computeGardssalgOutreachDailyPrep(expDb);
      assertEq(capped.response.candidates.map((c: any) => c.provider_id), ["a1-p2-fresh", "a1-p4-fresh"], "AK1f: inside the daily cap, first touches win over follow-ups");
      const overflow = capped.response.excluded.filter((x: any) => x.reason === "daily_cap_reached").map((x: any) => x.provider_id);
      assertEq(overflow, ["a1-p1-follow", "a1-p3-follow"], "AK1g: follow-ups overflow to daily_cap_reached");
      delete process.env.DAILY_PREP_MAX_CANDIDATES;

      // ── AK2: no template for the round ──
      const noTpl = m.computeGardssalgOutreachSendEligibility(expDb, ["a1-p1-follow", "a1-p2-fresh"], {
        skipRecipientDedupe: true,
        templateByRound: { 1: "personal-v4" },
      });
      assertEq(noTpl.map((e) => (e.eligible ? "eligible" : e.reason)), ["no_template_for_touch", "eligible"], "AK2a: round 2 without a template -> no_template_for_touch");
      const unknownTpl = m.computeGardssalgOutreachSendEligibility(expDb, ["a1-p1-follow"], {
        skipRecipientDedupe: true,
        templateByRound: { 1: "personal-v4", 2: "personal-v9-ukjent" },
      });
      assertEq(unknownTpl[0].eligible ? "eligible" : unknownTpl[0].reason, "no_template_for_touch", "AK2b: a round mapped to an unknown name -> no_template_for_touch (no fallback)");
      const before = sentLogCount();
      const eligFresh = prep.selected.find((s) => s.provider_id === "a1-p2-fresh")!;
      const skipRow = await m.sendGardssalgOutreachToEligibleProvider(expDb, eligFresh, {
        template: "personal-v9-ukjent" as any,
        isTest: false,
        source: "rounds-a1-test",
      });
      assertEq([skipRow.status, skipRow.reason], ["skipped", "no_template_for_touch"], "AK2c: send helper skips an unknown template");
      assertEq(sentLogCount(), before, "AK2d: no sent-log row (no reservation) for a round without a template");

      // Reservation stores the template name (dry-run e-mail).
      const sentRow = await m.sendGardssalgOutreachToEligibleProvider(expDb, eligFresh, {
        template: eligFresh.template,
        isTest: false,
        source: "rounds-a1-test",
      });
      const stored = expDb
        .prepare(`SELECT template FROM experience_outreach_sent_log WHERE provider_id = ? AND is_test = 0`)
        .get("a1-p2-fresh") as { template: string | null } | undefined;
      assertEq([sentRow.status, stored?.template], ["sent", "personal-v4"], "t1: the sent-log row carries the template name");
      const crmMeta = rfbDb
        .prepare(`SELECT raw_metadata FROM crm_messages WHERE thread_id = ? AND direction = 'out'`)
        .get("opplevagent-outreach-a1-p2-fresh") as { raw_metadata: string } | undefined;
      assertEq(JSON.parse(crmMeta?.raw_metadata ?? "{}").touch_round, 1, "t2: the CRM filing carries touch_round");

      // ── AK3: promise_given ──
      const e7 = mk("a1-p7-promise");
      addLog("a1-p7-promise", e7, 50, "personal-v4-followup");
      const e8 = mk("a1-p8-promise-legacy");
      addLog("a1-p8-promise-legacy", e8, 50, null);
      addCrm("opplevagent-outreach-a1-p8-promise-legacy", "out", "kontakt@opplevagent.no", e8,
        new Date(Date.now() - 50 * 86400_000).toISOString(), "F", { template: "personal-v4-followup", provider_id: "a1-p8-promise-legacy" });
      const promise = m.computeGardssalgOutreachSendEligibility(expDb, ["a1-p7-promise", "a1-p8-promise-legacy", "a1-p3-follow"], {
        skipRecipientDedupe: true,
      });
      assertEq(promise.map((e) => (e.eligible ? "eligible" : e.reason)), ["promise_given", "promise_given", "eligible"], "AK3a: latest send personal-v4-followup -> promise_given (sent log, then CRM fallback); personal-v4 stays eligible");
      const prep3 = m.computeGardssalgOutreachDailyPrep(expDb);
      const row7: any = prep3.response.excluded.find((x: any) => x.provider_id === "a1-p7-promise");
      assertEq([row7?.reason, row7?.recipient_email], ["promise_given", e7], "AK3b: daily-prep shows promise_given with the latest recipient");

      // ── AK4: unknown name never yields `standard` ──
      const standardText = email.renderGardssalgOutreachVariant("standard", "Testgard", "https://opplevagent.no/x").text;
      let thrown: unknown = null;
      let got: string | null = null;
      try {
        got = email.renderGardssalgOutreachVariant("personal-v9-ukjent" as any, "Testgard", "https://opplevagent.no/x").text;
      } catch (err) {
        thrown = err;
      }
      assertEq(thrown instanceof email.UnknownGardssalgOutreachTemplateError, true, "AK4a: unknown template name throws");
      assertEq(got === standardText, false, "AK4b: unknown template name never returns the standard text");
      assertEq([email.isGardssalgOutreachTemplate("personal-v4"), email.isGardssalgOutreachTemplate("constructor")], [true, false], "AK4c: template-name guard");

      // ── Sends per round in the run report ──
      assertEq(
        m.countGardssalgOutreachSentByRound(
          [{ provider_id: "x", touch_round: 1 }, { provider_id: "y", touch_round: 2 }, { provider_id: "z", touch_round: 1 }],
          [{ provider_id: "x", status: "sent" }, { provider_id: "y", status: "sent" }, { provider_id: "z", status: "error" }] as any,
        ),
        { "1": 1, "2": 1 },
        "r1: sent_by_round counts sent rows per round only",
      );

      // ── Measurement per round (any template name) ──
      const ago = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();
      addCrm("opplevagent-outreach-mA", "out", "kontakt@opplevagent.no", "a@m.no", ago(100), "E", { template: "personal-v4", provider_id: "mA" });
      addCrm("opplevagent-outreach-mB", "out", "kontakt@opplevagent.no", "b@m.no", ago(100), "F", { template: "personal-v4-followup", provider_id: "mB" });
      addCrm("opplevagent-outreach-mB", "in", "b@m.no", "kontakt@opplevagent.no", ago(90), "fjern", {});
      addCrm("opplevagent-outreach-mC", "out", "kontakt@opplevagent.no", "c@m.no", ago(100), "R3", { template: "personal-v5-runde3", provider_id: "mC", touch_round: 3 });
      addCrm("opplevagent-outreach-mC", "in", "c@m.no", "kontakt@opplevagent.no", ago(90), "Ja, vi tar imot besøk", {});
      const meas = m.computeGardssalgV4Measurement(expDb, rfbDb as any, { days: 28 });
      // The t1 dry-run send above was filed in the CRM too (personal-v4, touch_round 1).
      assertEq([meas.summary.first.sends, meas.summary.followup.sends, meas.summary.total_sends], [2, 1, 3], "m1: existing v4 summary unchanged (new template names stay out of it)");
      assertEq(meas.sends.map((s) => s.template).sort(), ["personal-v4", "personal-v4", "personal-v4-followup"], "m2: existing sends list unchanged");
      assertEq([meas.by_round["1"].sends, meas.by_round["1"].templates], [2, ["personal-v4"]], "m2b: round 1 = the t1 send (touch_round in CRM metadata) + a legacy E send");
      assertEq(Object.keys(meas.by_round), ["1", "2", "3"], "m3: by_round has one entry per round");
      assertEq([meas.by_round["2"].sends, meas.by_round["2"].replied, meas.by_round["2"].fjern, meas.by_round["2"].unsubscribed], [1, 1, 1, 1], "m4: round 2 counts reply and «fjern»");
      assertEq([meas.by_round["3"].sends, meas.by_round["3"].replied, meas.by_round["3"].fjern, meas.by_round["3"].templates], [1, 1, 0, ["personal-v5-runde3"]], "m5: a new template name is counted in its round");
    } catch (err) {
      failed++;
      failures.push(`✗ rounds-a1 suite threw: ${(err as Error)?.stack ?? err}`);
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
      for (const [k, v] of Object.entries(prevEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      restoreModuleCache();
    }
    return { passed, failed, failures };
  })();
}

if (require.main === module) {
  runOpplevelserGardssalgOutreachRoundsA1Tests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    for (const f of summary.failures) console.log(f);
    process.exit(summary.failed > 0 ? 1 : 0);
  });
}
