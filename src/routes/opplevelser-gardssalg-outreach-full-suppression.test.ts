/**
 * opplevelser-gardssalg-outreach-full-suppression.test.ts — dev-request
 * 2026-11-20-opplevagent-utsending-hele-sperrelista-og-rfb-svar.
 *
 * Opplevagent cold outreach must (1) use the whole blocklist (website, org.nr.,
 * name — not only e-mail) and (2) hold back an address that has an inbound CRM
 * message on any vertical, also on a contact not linked to the provider. Both
 * sit behind GARDSSALG_OUTREACH_FULL_SUPPRESSION_ENABLED (default OFF); a
 * read-only shadow report counts what would fall out regardless of the flag.
 *
 *   AK1: blocked on website_domain / org_nr / name (not e-mail): flag ON not
 *        eligible, reason `blocklisted` + `blocklist_matched_on`; flag OFF
 *        eligible but counted in the shadow (name-only hits marked `name`).
 *   AK2: recipient address has an inbound message in an `rfb` thread on an
 *        UNLINKED contact (case/whitespace differ): flag ON
 *        `replied_cross_platform`; flag OFF shadow-counted.
 *   AK3: no block, no reply: eligible either way, never in the shadow.
 * Covered on computeGardssalgOutreachSendEligibility, daily-prep and
 * GET /admin/gardssalg-outreach-candidates (mode=first and mode=second).
 *
 * Exported runOpplevelserGardssalgOutreachFullSuppressionTests({log}) ->
 * TestSummary; wired into tests/test.ts. Standalone:
 * npx tsx src/routes/opplevelser-gardssalg-outreach-full-suppression.test.ts
 */

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

const REALISTIC_ABOUT_TEXT =
  "Vi driver et lite gårdsbruk og lager drikke av råvarer fra vår egen gård. " +
  "Produktene selges direkte fra gårdsutsalget til besøkende gjennom hele sesongen.";

function callCandidates(router: any, query: Record<string, string>, headers: Record<string, string>): Promise<{ status: number; body: any }> {
  return new Promise((resolve) => {
    const qs = Object.entries(query)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join("&");
    const url = "/admin/gardssalg-outreach-candidates" + (qs ? `?${qs}` : "");
    const req: any = {
      method: "GET",
      url,
      originalUrl: url,
      path: "/admin/gardssalg-outreach-candidates",
      query,
      headers,
      body: {},
      get() {
        return undefined;
      },
    };
    const res: any = {
      statusCode: 200,
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      json(payload: any) {
        resolve({ status: this.statusCode, body: payload });
        return this;
      },
    };
    router.handle(req, res, (err?: any) => {
      if (err) resolve({ status: 500, body: { error: String(err) } });
    });
  });
}

export function runOpplevelserGardssalgOutreachFullSuppressionTests(
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
    const envKeys = [
      "EXPERIENCES_DB_PATH",
      "OUTREACH_COOLDOWN_DAYS",
      "DAILY_PREP_MAX_CANDIDATES",
      "ADMIN_KEY",
      "GARDSSALG_SECOND_TOUCH_COOLDOWN_DAYS",
      "GARDSSALG_OUTREACH_FULL_SUPPRESSION_ENABLED",
    ];
    const prevEnv = new Map(envKeys.map((k) => [k, process.env[k]]));
    const testKey = process.env.ADMIN_KEY || "gardssalg-full-suppression-test-key";
    process.env.EXPERIENCES_DB_PATH = ":memory:";
    process.env.OUTREACH_COOLDOWN_DAYS = "40";
    process.env.DAILY_PREP_MAX_CANDIDATES = "50";
    process.env.ADMIN_KEY = testKey;
    process.env.GARDSSALG_SECOND_TOUCH_COOLDOWN_DAYS = "30";
    delete process.env.GARDSSALG_OUTREACH_FULL_SUPPRESSION_ENABLED;

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

      const blocklistSvc = require("../services/blocklist-service") as typeof import("../services/blocklist-service");
      const opplevelserMod = require("./opplevelser") as typeof import("./opplevelser");
      const { computeGardssalgOutreachSendEligibility, computeGardssalgOutreachDailyPrep, createGardssalgFullSuppressionShadow } =
        opplevelserMod;
      const router = opplevelserMod.default as any;
      const auth = { "x-admin-key": testKey };

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
      const mk = (id: string, navn: string): { email: string; orgNr: string; domain: string } => {
        seq++;
        const domain = `${id}.no`;
        const orgNr = String(310000000 + seq);
        insertProvider.run({
          id, navn, org_nr: orgNr, epost: `post@${domain}`,
          hjemmeside: `https://www.${domain}/`, about_text: REALISTIC_ABOUT_TEXT, slug: id,
          field_provenance: JSON.stringify({
            hjemmeside_verification: { verified: true, classification: "verified", checked_at: "2026-09-01T00:00:00.000Z" },
            epost: [{ source_type: "registry", value: `post@${domain}`, source_url: `https://data.brreg.no/enhetsregisteret/api/enheter/${orgNr}` }],
          }),
        });
        return { email: `post@${domain}`, orgNr, domain };
      };
      const addSend = (providerId: string, email: string, daysAgo: number): void => {
        expDb
          .prepare(
            `INSERT INTO experience_outreach_sent_log (provider_id, recipient_email, sent_at, channel, message_id, is_test)
             VALUES (?, ?, datetime('now', '-${daysAgo} days'), 'email', ?, 0)`,
          )
          .run(providerId, email, "msg-" + providerId);
      };
      let crmSeq = 0;
      // An inbound reply on a contact NOT linked to any provider/agent, in the given vertical.
      const addUnlinkedInbound = (contactEmail: string, vertical: string): void => {
        crmSeq++;
        rfbDb
          .prepare(
            `INSERT INTO crm_contacts (id, type, agent_id, provider_id, email, name, status, vertical_id)
             VALUES (?, 'producer', NULL, NULL, ?, 'Kontakt', 'active', ?)`,
          )
          .run(`fs-c-${crmSeq}`, contactEmail, vertical);
        rfbDb
          .prepare(
            `INSERT INTO crm_threads (id, contact_id, subject, status, category, vertical_id)
             VALUES (?, ?, 'Re: Rett fra Bonden', 'new', 'innkommende', ?)`,
          )
          .run(`fs-t-${crmSeq}`, `fs-c-${crmSeq}`, vertical);
        rfbDb
          .prepare(
            `INSERT INTO crm_messages
               (id, thread_id, direction, from_email, to_emails, subject, body_text, sent_at, delivery_status)
             VALUES (?, ?, 'in', ?, '["kontakt@rettfrabonden.com"]', 'Re: Rett fra Bonden', 'fjern', ?, 'sent')`,
          )
          .run(`fs-m-${crmSeq}`, `fs-t-${crmSeq}`, contactEmail, new Date().toISOString());
      };

      // ── Fixtures ──────────────────────────────────────────────────────
      // AK1: blocked on website only / org.nr only / name only.
      const web = mk("fs-web", "Nettsted Gård");
      blocklistSvc.addManualEntry({ identifierType: "website_domain", identifierValue: web.domain });
      const org = mk("fs-org", "Orgnummer Gård");
      blocklistSvc.addManualEntry({ identifierType: "org_nr", identifierValue: org.orgNr });
      mk("fs-name", "Hebnes Testvingård");
      blocklistSvc.addManualEntry({ identifierType: "name_normalized", identifierValue: "Hebnes Testvingård" });
      // Old rule (e-mail key) — unchanged, reason blocklisted, not a NEW hit for the shadow.
      const mail = mk("fs-mail", "Epost Gård");
      blocklistSvc.addManualEntry({ identifierType: "email", identifierValue: mail.email });
      // AK2: reply in an rfb thread on an unlinked contact; case + whitespace differ.
      const rfb = mk("fs-rfb", "Bryggeri Svar");
      addUnlinkedInbound(`  ${rfb.email.toUpperCase()} `, "rfb");
      // AK3: clean producer.
      mk("fs-clean", "Ren Gård");
      // mode=second fixtures (one real send 45 days ago, outside both cooldowns).
      const web2 = mk("fs-web2", "Andre Nettsted Gård");
      addSend("fs-web2", web2.email, 45);
      blocklistSvc.addManualEntry({ identifierType: "website_domain", identifierValue: web2.domain });
      const rfb2 = mk("fs-rfb2", "Andre Bryggeri Svar");
      addSend("fs-rfb2", rfb2.email, 45);
      addUnlinkedInbound(rfb2.email, "dental");
      const clean2 = mk("fs-clean2", "Andre Ren Gård");
      addSend("fs-clean2", clean2.email, 45);

      const firstIds = ["fs-web", "fs-org", "fs-name", "fs-mail", "fs-rfb", "fs-clean"];
      const view = (elig: any[], id: string) => {
        const e = elig.find((x) => x.provider_id === id);
        return e?.eligible ? ["eligible"] : [e?.reason, e?.blocklist_matched_on ?? e?.reply_verticals ?? null];
      };

      // ── Flag OFF (default): eligibility unchanged, shadow counts ──────
      const shadowOff = createGardssalgFullSuppressionShadow();
      const off = computeGardssalgOutreachSendEligibility(expDb, firstIds, { skipRecipientDedupe: true, fullSuppressionShadow: shadowOff });
      assertEq(view(off, "fs-web"), ["eligible"], "AK1 off: website-blocked stays eligible with flag off");
      assertEq(view(off, "fs-org"), ["eligible"], "AK1 off: org.nr-blocked stays eligible with flag off");
      assertEq(view(off, "fs-name"), ["eligible"], "AK1 off: name-blocked stays eligible with flag off");
      assertEq(view(off, "fs-mail"), ["blocklisted", "email"], "old rule: e-mail block still applies with flag off, with matched key");
      assertEq(view(off, "fs-rfb"), ["eligible"], "AK2 off: cross-platform replier stays eligible with flag off");
      assertEq(view(off, "fs-clean"), ["eligible"], "AK3 off: clean producer eligible");
      assertEq(shadowOff.flag_enabled, false, "shadow off: flag_enabled false");
      assertEq(
        shadowOff.counts,
        { blocklist_extended: 3, blocklist_extended_name_only: 1, replied_cross_platform: 1, providers_total: 4 },
        "AK1/AK2 off: shadow counts the would-fall-out producers by reason",
      );
      assertEq(
        shadowOff.examples.blocklist_extended.map((x) => [x.provider_id, x.provider_name, x.matched_on]),
        [
          ["fs-web", "Nettsted Gård", "website_domain"],
          ["fs-org", "Orgnummer Gård", "org_nr"],
          ["fs-name", "Hebnes Testvingård", "name"],
        ],
        "AK1 off + spec 4: examples carry the matched key, name-only hits marked matched_on=name",
      );
      assertEq(
        shadowOff.examples.replied_cross_platform,
        [{ provider_id: "fs-rfb", provider_name: "Bryggeri Svar", reply_verticals: ["rfb"] }],
        "AK2 off + AK3: unlinked rfb reply matched despite case/whitespace, with the vertical",
      );
      assertEq(JSON.stringify(shadowOff).includes("@"), false, "shadow carries no e-mail addresses");

      const prepOff = computeGardssalgOutreachDailyPrep(expDb).response as any;
      const offCandIds = prepOff.candidates.map((c: any) => c.provider_id).sort();
      assertEq(
        ["fs-web", "fs-org", "fs-name", "fs-rfb", "fs-clean"].every((id) => offCandIds.includes(id)),
        true,
        "daily-prep off: new suppression does not remove anyone yet",
      );
      assertEq(prepOff.full_suppression_shadow.flag_enabled, false, "daily-prep off: shadow present, flag_enabled false");
      assertEq(prepOff.full_suppression_shadow.counts.blocklist_extended, 4, "daily-prep off: shadow counts both website hits + org + name");
      assertEq(prepOff.full_suppression_shadow.counts.replied_cross_platform, 2, "daily-prep off: shadow counts rfb + dental repliers");
      assertEq(
        prepOff.full_suppression_shadow.examples.replied_cross_platform.find((x: any) => x.provider_id === "fs-rfb2")?.reply_verticals,
        ["dental"],
        "daily-prep off: reply vertical reported (dental)",
      );

      const candFirstOff = await callCandidates(router, { mode: "first", limit: "100" }, auth);
      assertEq(candFirstOff.status, 200, "candidates first off: 200");
      assertEq(
        ["fs-web", "fs-rfb", "fs-clean"].every((id) => candFirstOff.body.candidates.some((c: any) => c.provider_id === id)),
        true,
        "candidates first off: website-blocked and replier still listed",
      );
      assertEq(candFirstOff.body.full_suppression_shadow.counts.providers_total >= 4, true, "candidates first off: shadow in response");
      const candSecondOff = await callCandidates(router, { mode: "second", limit: "100" }, auth);
      assertEq(
        candSecondOff.body.candidates.map((c: any) => c.provider_id).sort(),
        ["fs-clean2", "fs-rfb2", "fs-web2"],
        "candidates second off: all three follow-ups listed",
      );
      assertEq(
        [candSecondOff.body.full_suppression_shadow.counts.blocklist_extended, candSecondOff.body.full_suppression_shadow.counts.replied_cross_platform],
        [1, 1],
        "candidates second off: shadow counts website + dental replier",
      );

      // ── Flag ON: held back, with reason ───────────────────────────────
      process.env.GARDSSALG_OUTREACH_FULL_SUPPRESSION_ENABLED = "true";
      const shadowOn = createGardssalgFullSuppressionShadow();
      const on = computeGardssalgOutreachSendEligibility(expDb, firstIds, { skipRecipientDedupe: true, fullSuppressionShadow: shadowOn });
      assertEq(view(on, "fs-web"), ["blocklisted", "website_domain"], "AK1 on: website-blocked held back with matched key");
      assertEq(view(on, "fs-org"), ["blocklisted", "org_nr"], "AK1 on: org.nr-blocked held back with matched key");
      assertEq(view(on, "fs-name"), ["blocklisted", "name"], "AK1 on: name-blocked held back, matched_on name");
      assertEq(view(on, "fs-mail"), ["blocklisted", "email"], "on: e-mail block unchanged");
      assertEq(view(on, "fs-rfb"), ["replied_cross_platform", ["rfb"]], "AK2 on: unlinked rfb reply held back");
      assertEq(view(on, "fs-clean"), ["eligible"], "AK3 on: clean producer still eligible (no false suppression)");
      assertEq(
        [shadowOn.flag_enabled, shadowOn.counts.blocklist_extended, shadowOn.counts.replied_cross_platform],
        [true, 3, 1],
        "shadow on: reports what was held back",
      );

      const prepOn = computeGardssalgOutreachDailyPrep(expDb).response as any;
      const exById = new Map(prepOn.excluded.map((x: any) => [x.provider_id, x]));
      const ex = (id: string) => {
        const r: any = exById.get(id);
        return [r?.reason, r?.blocklist_matched_on ?? r?.reply_verticals ?? null];
      };
      assertEq(ex("fs-web"), ["blocklisted", "website_domain"], "daily-prep on: website block shown with key");
      assertEq(ex("fs-org"), ["blocklisted", "org_nr"], "daily-prep on: org.nr block shown with key");
      assertEq(ex("fs-name"), ["blocklisted", "name"], "daily-prep on: name block shown with key");
      assertEq(ex("fs-rfb"), ["replied_cross_platform", ["rfb"]], "daily-prep on: cross-platform reply shown with vertical");
      assertEq(ex("fs-rfb2"), ["replied_cross_platform", ["dental"]], "daily-prep on: dental reply shown with vertical");
      assertEq(
        prepOn.candidates.map((c: any) => c.provider_id).sort(),
        ["fs-clean", "fs-clean2"],
        "daily-prep on: only the clean producers remain",
      );
      assertEq(prepOn.full_suppression_shadow.flag_enabled, true, "daily-prep on: shadow flag_enabled true");

      const candFirstOn = await callCandidates(router, { mode: "first", limit: "100" }, auth);
      assertEq(
        candFirstOn.body.candidates.map((c: any) => c.provider_id).sort(),
        ["fs-clean"],
        "candidates first on: only the clean producer remains",
      );
      // mode=first runs the eligibility pass over the whole outreach_ready pool, so the
      // mode=second fixtures (fs-web2, fs-rfb2) are counted here too.
      assertEq(candFirstOn.body.suppressed_counts.replied_cross_platform, 2, "candidates first on: replied_cross_platform counted (rfb + dental)");
      assertEq(candFirstOn.body.suppressed_counts.blocklisted, 5, "candidates first on: blocklisted counts e-mail + 4 extended");
      const candSecondOn = await callCandidates(router, { mode: "second", limit: "100" }, auth);
      assertEq(
        candSecondOn.body.candidates.map((c: any) => c.provider_id),
        ["fs-clean2"],
        "candidates second on: follow-ups held back too",
      );
      assertEq(
        [candSecondOn.body.suppressed_counts.blocklisted, candSecondOn.body.suppressed_counts.replied_cross_platform],
        [1, 1],
        "candidates second on: counted under blocklisted / replied_cross_platform",
      );
    } catch (err) {
      failed++;
      failures.push(`✗ full-suppression suite threw: ${(err as Error)?.stack ?? err}`);
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
      for (const [k, v] of prevEnv) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      restoreModuleCache();
    }
    return { passed, failed, failures };
  })();
}

if (require.main === module) {
  runOpplevelserGardssalgOutreachFullSuppressionTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    for (const f of summary.failures) console.log(f);
    process.exit(summary.failed > 0 ? 1 : 0);
  });
}
