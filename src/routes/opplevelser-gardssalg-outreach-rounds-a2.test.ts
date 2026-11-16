/**
 * opplevelser-gardssalg-outreach-rounds-a2.test.ts — dev-request
 * 2026-11-15-opplevagent-fem-henvendelser, slice A2 (cap 5, texts for rounds 2 and 3):
 *   AK1 — the round-2 and round-3 texts are byte-identical with «Runde 2 (godkjent)»
 *         and «Runde 3 (godkjent)» in marketing-drafts/2026-11-15-utsendingstekster-
 *         opplevagent-runde-2-5.md (fenced text embedded below, placeholders filled).
 *   AK4 — cap 5; round 3 -> round-3 text; rounds 4 and 5 -> no_template_for_touch with
 *         nothing reserved; 5 sends -> max_touch_reached.
 *   Stop rule — from round 3: >=20 sends older than 7 days with MORE than 5 % «fjern» or
 *         unsubscribe -> round_stopped_optout_rate; exactly 5 % or <20 sends -> still sent.
 *   N2 — promise_given reads the LATEST send (by time, either insertion order).
 *   N3 — candidates?mode=first counts round rules in suppressed_counts.round_rule.
 *
 * Exported runOpplevelserGardssalgOutreachRoundsA2Tests({log}) -> TestSummary;
 * wired into tests/test.ts. Standalone:
 * npx tsx src/routes/opplevelser-gardssalg-outreach-rounds-a2.test.ts
 */

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

// Verbatim fenced text (code fence content, byte for byte) of «Runde 2 (godkjent)».
const APPROVED_ROUND2 = `Hei igjen,

Jeg skrev til dere {måned} om {navn} på Opplevagent. Det holder med ett ord: tar dere imot besøk, ja eller nei?

{profileUrl}

Det er gratis å stå der. Vil dere ikke være med, svarer dere «fjern».

Vennlig hilsen
Daniel Fredriksen

Slik behandler jeg opplysningene: https://opplevagent.no/personvern`;
// Verbatim fenced text (code fence content, byte for byte) of «Runde 3 (godkjent)».
const APPROVED_ROUND3 = `Hei,

{navn} står på Opplevagent med det jeg har funnet i Brønnøysundregistrene og på nettsiden deres. Jeg har ikke hørt fra dere, så jeg vet ikke om det stemmer.

Kan dere se over siden? Det tar to minutter: {profileUrl}

Er noe feil, svarer dere på denne e-posten, så retter jeg det. Dere kan også rette alt selv, uten passord: {eier_url}

Vil dere ikke stå der, svarer dere «fjern».

Vennlig hilsen
Daniel Fredriksen

Slik behandler jeg opplysningene: https://opplevagent.no/personvern`;

const VERIFIED_PROVENANCE = {
  hjemmeside_verification: { verified: true, classification: "verified", checked_at: "2026-09-01T00:00:00.000Z" },
};
const REALISTIC_ABOUT_TEXT =
  "Vi driver et lite gårdsbruk og lager drikke av råvarer fra vår egen gård. " +
  "Produktene selges direkte fra gårdsutsalget til besøkende gjennom hele sesongen.";

function fill(text: string, fields: Record<string, string>): string {
  let out = text;
  for (const [k, v] of Object.entries(fields)) out = out.split(`{${k}}`).join(v);
  return out;
}

export function runOpplevelserGardssalgOutreachRoundsA2Tests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
      ADMIN_KEY: process.env.ADMIN_KEY,
    };
    const adminKey = process.env.ADMIN_KEY || "gardssalg-outreach-rounds-a2-test-key";
    process.env.ADMIN_KEY = adminKey;
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
      const freshRfb = (): any => {
        const db = new Database(":memory:");
        initMod.__initSchemaForTesting(db as any);
        return db;
      };

      const m = require("./opplevelser") as typeof import("./opplevelser");
      const email = require("../services/email-service") as typeof import("../services/email-service");

      // ── AK1: golden texts ──
      const profileUrl = "https://opplevagent.no/kategori/gardssalg/produsent/testgard";
      const eierUrl = "https://opplevagent.no/kategori/gardssalg/eier/testgard";
      const r2 = email.renderGardssalgOutreachVariant("personal-v5-round2", "Testgård AS", profileUrl, { monthPhrase: "i oktober" });
      assertEq(r2.text, fill(APPROVED_ROUND2, { "måned": "i oktober", navn: "Testgård", profileUrl }), "AK1a: round-2 body byte-identical with «Runde 2 (godkjent)»");
      assertEq(r2.html, undefined, "AK1b: round 2 is plain text only");
      assertEq(r2.text.includes("Jeg skriver ikke igjen"), false, "AK1c: round 2 drops the promise sentence");
      const r3 = email.renderGardssalgOutreachVariant("personal-v5-round3", "Testgård AS", profileUrl, { eierUrl });
      assertEq(r3.text, fill(APPROVED_ROUND3, { navn: "Testgård", profileUrl, eier_url: eierUrl }), "AK1d: round-3 body byte-identical with «Runde 3 (godkjent)»");
      assertEq(r3.html, undefined, "AK1e: round 3 is plain text only");
      const r3Derived = email.renderGardssalgOutreachVariant("personal-v5-round3", "Testgård AS", profileUrl, {});
      assertEq(r3Derived.text, r3.text, "AK1f: round 3 derives {eier_url} from the profile URL's slug");
      assertEq(
        [
          email.renderGardssalgOutreachVariant("personal-v5-round2", "Testgård AS", profileUrl, { monthPhrase: "i mai", firstSubject: "Har vi riktig info om Testgård?" }).subject,
          email.renderGardssalgOutreachVariant("personal-v5-round3", "Testgård AS", profileUrl, { firstSubject: "Re: Spørsmål om besøk hos Testgård" }).subject,
          email.renderGardssalgOutreachVariant("personal-v5-round3", "Testgård AS", profileUrl, { firstSubject: null }).subject,
        ],
        ["Re: Har vi riktig info om Testgård?", "Re: Spørsmål om besøk hos Testgård", "Har vi riktig info om Testgård?"],
        "AK1g: subject `Re: <first subject>` when the first mail exists, else subject A",
      );
      let threw = false;
      try {
        email.renderGardssalgOutreachVariant("personal-v5-round2", "X", profileUrl, {});
      } catch {
        threw = true;
      }
      assertEq(threw, true, "AK1h: round 2 without {måned} throws (never sent with a hole)");

      // ── Constants ──
      assertEq(m.GARDSSALG_OUTREACH_MAX_TOUCHES, 5, "c1: cap is 5");
      assertEq(
        [1, 2, 3, 4, 5].map((r) => m.GARDSSALG_OUTREACH_TEMPLATE_BY_ROUND[r] ?? null),
        ["personal-v4", "personal-v5-round2", "personal-v5-round3", null, null],
        "c2: round -> template (4 and 5 have none)",
      );
      assertEq(
        ["personal-v4-followup", "personal-v5-round2", "personal-v5-round3"].map((t) => m.GARDSSALG_OUTREACH_PROMISE_TEMPLATES.has(t)),
        [true, false, false],
        "c3: only F carries the promise",
      );

      // ── Fixture helpers ──
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
          id, navn: id, org_nr: String(500000000 + seq), epost: `post@${domain}`,
          hjemmeside: `https://${domain}`, about_text: REALISTIC_ABOUT_TEXT, slug: id,
          field_provenance: JSON.stringify({
            ...VERIFIED_PROVENANCE,
            epost: [{ source_type: "registry", value: `post@${domain}`, source_url: `https://data.brreg.no/enhetsregisteret/api/enheter/${500000000 + seq}` }],
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
      const addCrm = (
        db: any,
        threadId: string,
        direction: "in" | "out",
        from: string,
        to: string,
        sentAt: string,
        body: string,
        meta: Record<string, unknown>,
        opts2: { id?: string; subject?: string } = {},
      ): void => {
        crmSeq++;
        db.prepare(
          `INSERT OR IGNORE INTO crm_contacts (id, type, agent_id, provider_id, email, name, status, vertical_id)
           VALUES (?, 'producer', NULL, NULL, ?, 'Kontakt', 'active', 'experiences')`,
        ).run(`a2-c-${crmSeq}`, `kontakt-${crmSeq}@example.invalid`);
        db.prepare(
          `INSERT OR IGNORE INTO crm_threads (id, contact_id, subject, status, category, vertical_id)
           VALUES (?, ?, 'Henvendelse', 'new', 'marketing', 'experiences')`,
        ).run(threadId, `a2-c-${crmSeq}`);
        db.prepare(
          `INSERT INTO crm_messages
             (id, thread_id, direction, from_email, to_emails, subject, body_text, sent_at, raw_metadata, delivery_status, vertical_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'sent', 'experiences')`,
        ).run(opts2.id ?? `a2-m-${crmSeq}`, threadId, direction, from, JSON.stringify([to]), opts2.subject ?? "Henvendelse", body, sentAt, JSON.stringify(meta));
      };
      const daysAgoIso = (d: number) => new Date(Date.now() - d * 86400_000).toISOString();
      const reasonOf = (e: any) => (e.eligible ? "eligible" : e.reason);

      // ── AK4: rounds 3, 4, 5 and the cap ──
      const eR3 = mk("a2-r3");
      addLog("a2-r3", eR3, 100, "personal-v4");
      addLog("a2-r3", eR3, 60, "personal-v5-round2");
      // The first mail is in the CRM with a real Message-ID: round 3 threads on it.
      addCrm(rfbDb, "opplevagent-outreach-a2-r3", "out", "kontakt@opplevagent.no", eR3, daysAgoIso(100), "E",
        { template: "personal-v4", provider_id: "a2-r3" }, { id: "<first-a2-r3@resend.dev>", subject: "Har vi riktig info om a2-r3?" });
      const eR4 = mk("a2-r4");
      addLog("a2-r4", eR4, 150, "personal-v4");
      addLog("a2-r4", eR4, 100, "personal-v5-round2");
      addLog("a2-r4", eR4, 60, "personal-v5-round3");
      const eR5 = mk("a2-r5");
      addLog("a2-r5", eR5, 200, "personal-v4");
      addLog("a2-r5", eR5, 150, "personal-v5-round2");
      addLog("a2-r5", eR5, 100, "personal-v5-round3");
      addLog("a2-r5", eR5, 60, null);
      const eMax = mk("a2-max");
      for (const d of [250, 200, 150, 100, 60]) addLog("a2-max", eMax, d, null);

      const ids = ["a2-r3", "a2-r4", "a2-r5", "a2-max"];
      const beforeElig = sentLogCount();
      const elig = m.computeGardssalgOutreachSendEligibility(expDb, ids, { skipRecipientDedupe: true });
      assertEq(elig.map(reasonOf), ["eligible", "no_template_for_touch", "no_template_for_touch", "max_touch_reached"], "AK4a: round 3 eligible; rounds 4 and 5 no_template_for_touch; 5 sends max_touch_reached");
      const r3Elig: any = elig[0];
      assertEq([r3Elig.touch_round, r3Elig.template], [3, "personal-v5-round3"], "AK4b: round 3 uses the round-3 template");
      assertEq(sentLogCount(), beforeElig, "AK4c: eligibility writes nothing");

      const prep = m.computeGardssalgOutreachDailyPrep(expDb);
      const exReason = new Map(prep.response.excluded.map((x: any) => [x.provider_id, x.reason]));
      assertEq(
        [exReason.get("a2-r4"), exReason.get("a2-r5"), exReason.get("a2-max")],
        ["no_template_for_touch", "no_template_for_touch", "max_touch_reached"],
        "AK4d: daily-prep shows rounds 4/5 as no_template_for_touch",
      );
      const candR3: any = prep.response.candidates.find((c: any) => c.provider_id === "a2-r3");
      assertEq(candR3?.touch_round, 3, "AK4e: daily-prep candidate at round 3");
      assertEq(prep.selected.some((s) => s.provider_id === "a2-r4" || s.provider_id === "a2-r5"), false, "AK4f: rounds 4/5 never selected (nothing reserved)");
      assertEq(sentLogCount(), beforeElig, "AK4g: daily-prep reserves nothing");

      // Round-3 send (dry-run transport): reserves with the round-3 name, files the exact text, threads on the first mail.
      const sent = await m.sendGardssalgOutreachToEligibleProvider(expDb, r3Elig, { template: r3Elig.template, isTest: false, source: "rounds-a2-test" });
      assertEq([sent.status, sent.template, sent.threaded], ["sent", "personal-v5-round3", true], "AK4h: round-3 send is sent and threaded");
      const logRow = expDb
        .prepare(`SELECT template FROM experience_outreach_sent_log WHERE provider_id = ? AND is_test = 0 ORDER BY id DESC LIMIT 1`)
        .get("a2-r3") as { template: string };
      assertEq(logRow.template, "personal-v5-round3", "AK4i: sent log carries personal-v5-round3");
      const filed = rfbDb
        .prepare(`SELECT subject, body_text, raw_metadata FROM crm_messages WHERE thread_id = ? AND direction = 'out' AND raw_metadata LIKE '%personal-v5-round3%'`)
        .get("opplevagent-outreach-a2-r3") as { subject: string; body_text: string; raw_metadata: string };
      assertEq(
        filed?.body_text,
        fill(APPROVED_ROUND3, {
          navn: "a2-r3",
          profileUrl: "https://opplevagent.no/kategori/gardssalg/produsent/a2-r3",
          eier_url: "https://opplevagent.no/kategori/gardssalg/eier/a2-r3",
        }),
        "AK4j: the filed round-3 body is the approved text, fields filled",
      );
      const filedMeta = JSON.parse(filed?.raw_metadata ?? "{}");
      assertEq([filed?.subject, filedMeta.touch_round, filedMeta.in_reply_to], ["Re: Har vi riktig info om a2-r3?", 3, "<first-a2-r3@resend.dev>"], "AK4k: Re: <first subject>, touch_round 3, In-Reply-To the first mail");

      // The dry-run transport answers messageId 'DRY_RUN' for every send; rename the filed
      // row so the next dry-run send is not dropped as a duplicate message id.
      rfbDb.prepare(`UPDATE crm_messages SET id = 'dry-run-a2-r3' WHERE id = 'DRY_RUN'`).run();

      // Round-2 send: new template, not a promise -> the producer reaches round 3 afterwards.
      const eR2 = mk("a2-r2");
      addLog("a2-r2", eR2, 60, "personal-v4");
      const r2Elig: any = m.computeGardssalgOutreachSendEligibility(expDb, ["a2-r2"], { skipRecipientDedupe: true })[0];
      assertEq([r2Elig.eligible, r2Elig.touch_round, r2Elig.template], [true, 2, "personal-v5-round2"], "AK4l: round 2 maps to personal-v5-round2");
      const sent2 = await m.sendGardssalgOutreachToEligibleProvider(expDb, r2Elig, { template: r2Elig.template, isTest: false, source: "rounds-a2-test" });
      assertEq([sent2.status, sent2.threaded], ["sent", false], "AK4m: round 2 without a usable first mail goes out as a new mail");
      const filed2 = rfbDb
        .prepare(`SELECT subject, body_text FROM crm_messages WHERE thread_id = ? AND direction = 'out'`)
        .get("opplevagent-outreach-a2-r2") as { subject: string; body_text: string };
      assertEq(filed2?.subject, "Har vi riktig info om a2-r2?", "AK4n: no first mail -> subject A");
      assertEq(filed2?.body_text.includes("Jeg skriver ikke igjen"), false, "AK4o: round-2 body without the promise");
      expDb.prepare(`UPDATE experience_outreach_sent_log SET sent_at = ? WHERE provider_id = ?`).run(daysAgoIso(50), "a2-r2");
      const after2: any = m.computeGardssalgOutreachSendEligibility(expDb, ["a2-r2"], { skipRecipientDedupe: true })[0];
      assertEq([reasonOf(after2), after2.touch_round], ["eligible", 3], "AK4p: after round 2 the producer is not promise_given; next is round 3");

      // ── N2: promise_given reads the latest send ──
      const eP1 = mk("a2-p-last-f");
      addLog("a2-p-last-f", eP1, 100, "personal-v4");
      addLog("a2-p-last-f", eP1, 60, "personal-v4-followup");
      const eP2 = mk("a2-p-first-f");
      addLog("a2-p-first-f", eP2, 100, "personal-v4-followup");
      addLog("a2-p-first-f", eP2, 60, "personal-v4");
      const eP3 = mk("a2-p-last-f-inserted-first");
      addLog("a2-p-last-f-inserted-first", eP3, 60, "personal-v4-followup"); // newest send, lower id
      addLog("a2-p-last-f-inserted-first", eP3, 100, "personal-v4");
      const pr = m.computeGardssalgOutreachSendEligibility(expDb, ["a2-p-last-f", "a2-p-first-f", "a2-p-last-f-inserted-first"], { skipRecipientDedupe: true });
      assertEq(pr.map(reasonOf), ["promise_given", "eligible", "promise_given"], "N2: promise_given follows the latest send by time, not the insertion order");

      // ── Stop rule ──
      // Stats on separate databases (boundaries).
      const seedRound = (db: any, round: number, n: number, optouts: number, daysOld: number, prefix: string, viaUnsub = false): void => {
        for (let i = 0; i < n; i++) {
          const pid = `${prefix}-${i}`;
          const to = `post@${pid}.no`;
          addCrm(db, `opplevagent-outreach-${pid}`, "out", "kontakt@opplevagent.no", to, daysAgoIso(daysOld), "R",
            { template: `personal-v5-round${round}`, provider_id: pid, touch_round: round });
          if (i < optouts) {
            if (viaUnsub) {
              db.prepare(`INSERT INTO email_bounces (email, bounced_at, bounce_type) VALUES (?, ?, 'unsubscribe')`).run(to, daysAgoIso(daysOld - 1));
            } else {
              addCrm(db, `opplevagent-outreach-${pid}`, "in", to, "kontakt@opplevagent.no", daysAgoIso(daysOld - 1), "Fjern oss, takk", {});
            }
          }
        }
      };
      const statsOf = (seed: (db: any) => void) => {
        const db = freshRfb();
        seed(db);
        return m.computeGardssalgOutreachRoundOptoutStats(db);
      };
      assertEq(statsOf((db) => seedRound(db, 3, 20, 2, 10, "s1"))["3"], { sends: 20, optouts: 2, stopped: true }, "S1: 20 sends >7d, 10 % «fjern» -> stopped");
      assertEq(statsOf((db) => seedRound(db, 3, 20, 2, 10, "s1u", true))["3"], { sends: 20, optouts: 2, stopped: true }, "S2: unsubscribes count as opt-outs");
      assertEq(statsOf((db) => seedRound(db, 3, 20, 1, 10, "s3"))["3"], { sends: 20, optouts: 1, stopped: false }, "S3: exactly 5 % -> still sent");
      assertEq(statsOf((db) => seedRound(db, 3, 19, 5, 10, "s4"))["3"], { sends: 19, optouts: 5, stopped: false }, "S4: fewer than 20 eligible sends -> still sent");
      assertEq(
        statsOf((db) => { seedRound(db, 3, 19, 5, 10, "s5a"); seedRound(db, 3, 5, 0, 3, "s5b"); })["3"],
        { sends: 19, optouts: 5, stopped: false },
        "S5: sends younger than 7 days do not count",
      );
      assertEq(Object.keys(statsOf((db) => seedRound(db, 2, 20, 10, 10, "s6"))), [], "S6: rounds before 3 are not covered by the rule");
      assertEq(statsOf((db) => seedRound(db, 4, 40, 3, 10, "s7"))["4"], { sends: 40, optouts: 3, stopped: true }, "S7: the rule is per round (round 4)");

      // End to end on the lane's own CRM: round 3 stopped -> round_stopped_optout_rate in eligibility and daily-prep.
      const eStop = mk("a2-stop");
      addLog("a2-stop", eStop, 150, "personal-v4");
      addLog("a2-stop", eStop, 100, "personal-v5-round2");
      const pre = m.computeGardssalgOutreachSendEligibility(expDb, ["a2-stop"], { skipRecipientDedupe: true })[0];
      assertEq(reasonOf(pre), "eligible", "S8a: round 3 is sent while the rule has too few sends");
      seedRound(rfbDb, 3, 20, 2, 10, "e2e");
      const stopped = m.computeGardssalgOutreachSendEligibility(expDb, ["a2-stop", "a2-r2"], { skipRecipientDedupe: true });
      assertEq(stopped.map(reasonOf), ["round_stopped_optout_rate", "round_stopped_optout_rate"], "S8b: >5 % opt-out in round 3 -> round_stopped_optout_rate");
      const prepStop = m.computeGardssalgOutreachDailyPrep(expDb);
      const stopRow: any = prepStop.response.excluded.find((x: any) => x.provider_id === "a2-stop");
      assertEq(stopRow?.reason, "round_stopped_optout_rate", "S8c: daily-prep shows round_stopped_optout_rate");
      const fresh: any = m.computeGardssalgOutreachSendEligibility(expDb, [(() => { mk("a2-fresh-after-stop"); return "a2-fresh-after-stop"; })()], { skipRecipientDedupe: true })[0];
      assertEq([reasonOf(fresh), fresh.touch_round], ["eligible", 1], "S8d: a stopped round 3 does not stop round 1");

      // ── N3: candidates?mode=first counts the round rules in their own bucket ──
      const allIds = (expDb.prepare(`SELECT id FROM experience_providers WHERE id LIKE 'a2-%'`).all() as Array<{ id: string }>).map((r) => r.id);
      const roundRuleReasons = new Set(["promise_given", "no_template_for_touch", "round_stopped_optout_rate"]);
      const expectedRoundRule = m
        .computeGardssalgOutreachSendEligibility(expDb, allIds, { skipRecipientDedupe: true })
        .filter((e: any) => !e.eligible && roundRuleReasons.has(e.reason)).length;
      const routeBody: any = await new Promise((resolve) => {
        const url = "/admin/gardssalg-outreach-candidates?mode=first";
        const req: any = {
          method: "GET", url, originalUrl: url, path: "/admin/gardssalg-outreach-candidates",
          query: { mode: "first" }, headers: { "x-admin-key": adminKey }, body: {}, get: () => undefined,
        };
        const res: any = {
          statusCode: 200,
          status(code: number) { this.statusCode = code; return this; },
          json(payload: any) { resolve(payload); return this; },
        };
        m.default.handle(req, res, (err?: any) => resolve({ error: String(err) }));
      });
      assertEq(expectedRoundRule > 0, true, "N3a: fixture has round-rule rows");
      assertEq(routeBody?.suppressed_counts?.round_rule, expectedRoundRule, "N3b: suppressed_counts.round_rule counts promise_given / no_template_for_touch / round_stopped_optout_rate");
    } catch (err) {
      failed++;
      failures.push(`✗ rounds-a2 suite threw: ${(err as Error)?.stack ?? err}`);
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
  runOpplevelserGardssalgOutreachRoundsA2Tests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    for (const f of summary.failures) console.log(f);
    process.exit(summary.failed > 0 ? 1 : 0);
  });
}
