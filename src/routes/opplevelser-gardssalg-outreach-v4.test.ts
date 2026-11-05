/**
 * opplevelser-gardssalg-outreach-v4.test.ts — dev-request
 * 2026-10-22-opplevagent-utsending-v4, slice 1 (acceptance criteria AC1-AC5, AC7).
 *
 *   AC1  rendered texts E (both subject arms) and F equal the approved text byte
 *        for byte for two examples; no \n inside a paragraph; {eier_url}, the
 *        privacy link and «fjern» present; no «katalog»; phone line in E.
 *   AC2  shared name wash.
 *   AC3  From `"Daniel Fredriksen" <kontakt@rettfrabonden.com>`, Reply-To
 *        kontakt@opplevagent.no; other Opplevagent mail keeps its From.
 *   AC4  follow-up threads (In-Reply-To/References, `Re: <first subject>`) when the
 *        first message exists in the CRM, otherwise a new mail with subject A.
 *   AC5  send days: Tuesday and Thursday in Europe/Oslo only (incl. 25.10.2026).
 *   AC7  CRM message and result row carry template + subject arm.
 *
 * The expected texts below are the fenced blocks E and F of
 * marketing-drafts/2026-10-22-utsendingstekster-v4-opplevagent.md (A2A repo),
 * with the table's fields as {placeholders}; the test substitutes them itself,
 * independent of the renderer under test.
 *
 * Standalone: npx tsx src/routes/opplevelser-gardssalg-outreach-v4.test.ts
 */

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

const TEXT_E = `Hei,

Jeg har ett spørsmål om {navn}: tar dere imot besøk? Jeg heter Daniel Fredriksen og driver Opplevagent, en gratis oversikt over bryggerier, siderier og brennerier i Norge som man kan besøke. Dere står der allerede:

{url}

Besøk er det vi oftest tar feil av, så et kort svar hjelper mye. Er noe annet feil, kan dere bare svare på denne e-posten, så retter jeg det.

Grunnen til at jeg gjør dette, er at mange nå spør ChatGPT og lignende tjenester om hvor de kan dra på smaking. Små produsenter kommer ofte ikke med i svarene, fordi informasjonen om dem er spredt eller gammel. Opplevagent samler den og setter den opp slik at disse tjenestene kan lese den. Det erstatter ikke nettsiden deres, men gjør at dere blir funnet der folk nå spør.

Det koster ingenting å stå der, og dere binder dere ikke til noe. Vil dere styre siden selv, kan dere ta den over her, uten passord: {eier_url}

Vil dere ikke være med, svarer dere bare «fjern», så tar jeg siden ned innen et døgn.

Vennlig hilsen
Daniel Fredriksen
Opplevagent
{mobil}

Slik behandler jeg opplysningene: https://opplevagent.no/personvern`;
const TEXT_F = `Hei igjen,

Jeg skrev til dere {måned} om {navn} på Opplevagent. Det holder med ett ord: tar dere imot besøk, ja eller nei?

{url}

Det er gratis å stå der. Vil dere ikke være med, svarer dere «fjern». Jeg skriver ikke igjen om dette.

Vennlig hilsen
Daniel Fredriksen

Slik behandler jeg opplysningene: https://opplevagent.no/personvern`;
const SUBJECT_A = `Har vi riktig info om {navn}?`;
const SUBJECT_B = `Spørsmål om besøk hos {navn}`;

function fill(tpl: string, fields: Record<string, string>): string {
  let out = tpl;
  for (const [k, v] of Object.entries(fields)) out = out.split(`{${k}}`).join(v);
  return out;
}

export function runOpplevelserGardssalgOutreachV4Tests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
  function assertTrue(cond: boolean, label: string): void {
    assertEq(cond, true, label);
  }

  return (async () => {
    const prevExperiencesDbPath = process.env.EXPERIENCES_DB_PATH;
    const prevAdminKey = process.env.ADMIN_KEY;
    const prevCooldownDays = process.env.OUTREACH_COOLDOWN_DAYS;
    process.env.EXPERIENCES_DB_PATH = ":memory:";
    process.env.ADMIN_KEY = process.env.ADMIN_KEY || "gardssalg-outreach-v4-test-key";
    process.env.OUTREACH_COOLDOWN_DAYS = "60";

    const dbFactoryPath = require.resolve("../database/db-factory");
    const emailPath = require.resolve("../services/email-service");
    const blocklistPath = require.resolve("../services/blocklist-service");
    const experienceStorePath = require.resolve("../services/experience-store");
    const opplevelserPath = require.resolve("./opplevelser");
    const cachePaths = [dbFactoryPath, emailPath, blocklistPath, experienceStorePath, opplevelserPath];
    const restoreModuleCache = (require("../../tests/module-cache") as typeof import("../../tests/module-cache")).swapOutModules(cachePaths);

    let emailSvc: any = null;
    let origConfigured: unknown;
    let origTransporter: unknown;
    let prevRfbDb: any = null;

    try {
      try {
        (require("../config/vertical-config") as typeof import("../config/vertical-config")).loadConfigsAtBoot();
      } catch {
        // already loaded
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

      const emailMod = require("../services/email-service") as typeof import("../services/email-service");
      const opplevelserMod = require("./opplevelser") as typeof import("./opplevelser");
      const {
        renderGardssalgOutreachVariant,
        cleanOutreachProviderName,
        gardssalgOutreachMonthPhrase,
        gardssalgOutreachFromHeader,
        GARDSSALG_OUTREACH_SIGNATURE_PHONE,
        GARDSSALG_OUTREACH_REPLY_TO,
      } = emailMod;
      const { shouldRunGardssalgOutreachDaily, sendGardssalgOutreachToEligibleProvider } = opplevelserMod;

      // ── AC2: name wash ───────────────────────────────────────────────
      const washCases: Array<[string, string]> = [
        ["Amble Gård, Mette Marie Strand Heiberg", "Amble Gård"],
        ["Senja Handbryggeri — Vangsvik", "Senja Handbryggeri"],
        ["Alde Sider / Ulvik Frukt & Cideri — Ulvik, Hardanger", "Alde Sider / Ulvik Frukt & Cideri"],
        ["Larkollen Gin Compagnie AS", "Larkollen Gin Compagnie"],
        ["Hevd Håndverksbakeri", "Hevd Håndverksbakeri"],
        ["Nordre Bryggeri ANS", "Nordre Bryggeri"],
        ["Sørgård DA — Hemsedal", "Sørgård"],
        ["Fjell ENK", "Fjell"],
        ["Vass AS Sider", "Vass AS Sider"],
      ];
      for (const [raw, want] of washCases) assertEq(cleanOutreachProviderName(raw), want, `AC2: «${raw}» -> «${want}»`);

      // ── AC1: rendered text byte for byte ─────────────────────────────
      const examples = [
        { navn: "Senja Handbryggeri — Vangsvik", rent: "Senja Handbryggeri", slug: "senja-handbryggeri--a1b2c3" },
        { navn: "Larkollen Gin Compagnie AS", rent: "Larkollen Gin Compagnie", slug: "larkollen-gin-compagnie-as--d4e5f6" },
      ];
      for (const ex of examples) {
        const url = `https://opplevagent.no/kategori/gardssalg/produsent/${ex.slug}`;
        const eierUrl = `https://opplevagent.no/kategori/gardssalg/eier/${ex.slug}`;
        const wantE = fill(TEXT_E, { navn: ex.rent, url, eier_url: eierUrl, mobil: "905 737 34" });
        const eA = renderGardssalgOutreachVariant("personal-v4", ex.navn, url, { arm: "A", eierUrl });
        const eB = renderGardssalgOutreachVariant("personal-v4", ex.navn, url, { arm: "B", eierUrl });
        assertEq(eA.text, wantE, `AC1: E arm A byte for byte (${ex.rent})`);
        assertEq(eB.text, wantE, `AC1: E arm B byte for byte (${ex.rent})`);
        assertEq(eA.subject, fill(SUBJECT_A, { navn: ex.rent }), `AC1: subject A (${ex.rent})`);
        assertEq(eB.subject, fill(SUBJECT_B, { navn: ex.rent }), `AC1: subject B (${ex.rent})`);
        assertEq(eA.html, undefined, "AC1: E is text-only");
        // eier_url defaults to the profile slug when the caller gives none
        assertEq(renderGardssalgOutreachVariant("personal-v4", ex.navn, url).text, wantE, `AC1: default {eier_url} derived from the same slug (${ex.rent})`);

        const wantF = fill(TEXT_F, { navn: ex.rent, url, "måned": "i september" });
        const f = renderGardssalgOutreachVariant("personal-v4-followup", ex.navn, url, { monthPhrase: "i september", firstSubject: eA.subject });
        assertEq(f.text, wantF, `AC1: F byte for byte (${ex.rent})`);
        assertEq(f.subject, `Re: ${eA.subject}`, `AC1/AC4: F subject is Re: <first subject> (${ex.rent})`);

        // Structure
        for (const [label, text] of [["E", eA.text], ["F", f.text]] as const) {
          const paragraphs = text.split("\n\n");
          const sigIdx = paragraphs.findIndex((p) => p.startsWith("Vennlig hilsen"));
          assertTrue(sigIdx > 0, `AC1: ${label} has a signature block (${ex.rent})`);
          assertTrue(paragraphs.every((p, i) => i === sigIdx || !p.includes("\n")), `AC1: ${label} has no \\n inside a paragraph (${ex.rent})`);
          assertTrue(!/katalog/i.test(text) && !/registrert/i.test(text) && !/oppføring/i.test(text), `AC1: ${label} avoids katalog/registrert/oppføring (${ex.rent})`);
          assertTrue(text.includes("https://opplevagent.no/personvern") && text.includes("«fjern»"), `AC1: ${label} has the privacy link and «fjern» (${ex.rent})`);
          assertTrue(!/\{[a-zæøå_]+\}/i.test(text), `AC1: ${label} has no unreplaced field (${ex.rent})`);
        }
        assertTrue(eA.text.includes(eierUrl), `AC1: E carries {eier_url} with the right slug (${ex.rent})`);
        assertTrue(eA.text.split("\n").includes("905 737 34"), `AC1: E signature has the line 905 737 34 (${ex.rent})`);
        assertTrue(!eA.text.includes(ex.navn) || ex.navn === ex.rent, `AC2: the internal name tail never reaches the text (${ex.rent})`);
        assertTrue(!eA.text.includes("Vangsvik"), `AC2: the place-name tail never reaches the text (${ex.rent})`);
      }
      assertEq(GARDSSALG_OUTREACH_SIGNATURE_PHONE, "905 737 34", "AC1: signature phone constant");
      assertTrue(
        renderGardssalgOutreachVariant("personal-v4", "X", "https://opplevagent.no/kategori/gardssalg/produsent/s--1").text.includes("/produsent/s--1"),
        "AC2: the slug in URLs is untouched",
      );
      // F without a first subject: new mail, subject A
      assertEq(
        renderGardssalgOutreachVariant("personal-v4-followup", "Amble Gård, Mette", "https://x/y", { monthPhrase: "i mai", firstSubject: null }).subject,
        "Har vi riktig info om Amble Gård?",
        "AC4: F without a first message uses subject A",
      );
      let threw = false;
      try {
        renderGardssalgOutreachVariant("personal-v4-followup", "X", "https://x/y");
      } catch {
        threw = true;
      }
      assertTrue(threw, "AC1: F without {måned} refuses to render (fail closed)");

      // {måned}
      const now = new Date("2026-10-27T08:00:00Z");
      assertEq(gardssalgOutreachMonthPhrase(new Date("2026-09-15T10:00:00Z"), now), "i september", "måned: earlier this year");
      assertEq(gardssalgOutreachMonthPhrase(new Date("2026-10-02T10:00:00Z"), now), "tidligere denne måneden", "måned: same month");
      assertEq(gardssalgOutreachMonthPhrase(new Date("2025-12-03T10:00:00Z"), now), "i desember i fjor", "måned: last year");
      assertEq(gardssalgOutreachMonthPhrase(new Date("2024-03-03T10:00:00Z"), now), "i mars 2024", "måned: older than last year");

      // ── AC5: send days ───────────────────────────────────────────────
      const run = (iso: string, extra: Record<string, unknown> = {}) => shouldRunGardssalgOutreachDaily({ now: new Date(iso), lastRunAt: null, ...extra });
      assertEq(run("2026-10-26T08:00:00Z"), false, "AC5: Monday -> false");
      assertEq(run("2026-10-27T08:00:00Z"), true, "AC5: Tuesday (winter time) -> true");
      assertEq(run("2026-10-28T08:00:00Z"), false, "AC5: Wednesday -> false");
      assertEq(run("2026-10-29T08:00:00Z"), true, "AC5: Thursday -> true");
      assertEq(run("2026-10-30T08:00:00Z"), false, "AC5: Friday -> false");
      assertEq(run("2026-10-31T08:00:00Z"), false, "AC5: Saturday -> false");
      assertEq(run("2026-11-01T08:00:00Z"), false, "AC5: Sunday -> false");
      assertEq(run("2026-10-22T08:00:00Z"), true, "AC5: Thursday before the switch (summer time) -> true");
      assertEq(run("2026-10-20T08:00:00Z"), true, "AC5: Tuesday before the switch (summer time) -> true");
      assertEq(run("2026-10-21T08:00:00Z"), false, "AC5: Wednesday before the switch -> false");
      assertEq(run("2026-10-25T08:00:00Z"), false, "AC5: the switch day itself (Sunday) -> false");
      assertEq(run("2026-10-27T07:59:00Z"), false, "AC5: send day outside the 08Z window -> false");
      // The weekday is the Oslo one, not the UTC one: Monday 23:00Z is Tuesday 00:00 in Oslo (UTC+1)
      assertEq(run("2026-10-26T23:00:00Z", { windowHourUtc: 23 }), true, "AC5: Oslo weekday, not UTC (Mon 23Z = Tue in Oslo)");
      assertEq(run("2026-10-27T23:00:00Z", { windowHourUtc: 23 }), false, "AC5: Oslo weekday, not UTC (Tue 23Z = Wed in Oslo)");
      assertEq(run("2026-03-30T22:00:00Z", { windowHourUtc: 22 }), true, "AC5: Oslo weekday in summer time (Mon 22Z = Tue 00:00 in Oslo, UTC+2)");

      // ── Send path with a fake transport (AC3, AC4, AC7) ──────────────
      emailSvc = emailMod.emailService as any;
      origConfigured = emailSvc.isConfigured;
      origTransporter = emailSvc.transporter;
      const sent: Array<Record<string, any>> = [];
      let seq = 0;
      emailSvc.isConfigured = true;
      emailSvc.transporter = {
        sendMail: async (m: Record<string, any>) => {
          sent.push(m);
          seq += 1;
          return { messageId: `<v4-msg-${seq}@rettfrabonden.com>` };
        },
      };

      const elig = (id: string, navn: string, slug: string, epost: string) =>
        ({ provider_id: id, eligible: true as const, status: "would_send" as const, navn, slug, epost });
      const sendFirst = (e: ReturnType<typeof elig>) =>
        sendGardssalgOutreachToEligibleProvider(expDb, e as any, { template: "personal-v4", isTest: false, source: "v4-test" });
      const sendFollowup = (e: ReturnType<typeof elig>) =>
        sendGardssalgOutreachToEligibleProvider(expDb, e as any, { template: "personal-v4-followup", isTest: false, source: "v4-test" });
      const crmRows = (providerId: string) =>
        rfbDb
          .prepare(`SELECT id, subject, body_text, sent_at, raw_metadata FROM crm_messages WHERE thread_id = ? ORDER BY sent_at, rowid`)
          .all(`opplevagent-outreach-${providerId}`) as Array<{ id: string; subject: string; body_text: string; sent_at: string; raw_metadata: string }>;
      // make a producer's first send old enough that the follow-up is not in cooldown
      const ageFirstSend = (providerId: string, whenIso: string) => {
        expDb.prepare(`UPDATE experience_outreach_sent_log SET sent_at = ? WHERE provider_id = ?`).run(whenIso.replace("T", " ").slice(0, 19), providerId);
        rfbDb.prepare(`UPDATE crm_messages SET sent_at = ? WHERE thread_id = ?`).run(whenIso, `opplevagent-outreach-${providerId}`);
      };

      const P1 = elig("prov-v4-1", "Senja Handbryggeri — Vangsvik", "senja-handbryggeri--a1", "post@v4-senja.no");
      const P2 = elig("prov-v4-2", "Larkollen Gin Compagnie AS", "larkollen-gin--b2", "post@v4-larkollen.no");
      const P3 = elig("prov-v4-3", "Amble Gård, Mette Marie Strand Heiberg", "amble-gard--c3", "post@v4-amble.no");

      const r1 = await sendFirst(P1);
      const r2 = await sendFirst(P2);
      const r3 = await sendFirst(P3);
      assertEq([r1.status, r2.status, r3.status], ["sent", "sent", "sent"], "v4: three first mails sent");
      assertEq([r1.subject_arm, r2.subject_arm, r3.subject_arm], ["A", "B", "A"], "AC7: subject arm alternates A, B, A on the result rows");
      assertEq([r1.template, r2.template], ["personal-v4", "personal-v4"], "AC7: result rows carry template personal-v4");
      assertEq(
        sent.map((m) => m.subject),
        ["Har vi riktig info om Senja Handbryggeri?", "Spørsmål om besøk hos Larkollen Gin Compagnie", "Har vi riktig info om Amble Gård?"],
        "AC1/AC7: subjects on the wire follow the arm, with washed names",
      );
      assertEq(sent[0].text, fill(TEXT_E, {
        navn: "Senja Handbryggeri",
        url: "https://opplevagent.no/kategori/gardssalg/produsent/senja-handbryggeri--a1",
        eier_url: "https://opplevagent.no/kategori/gardssalg/eier/senja-handbryggeri--a1",
        mobil: "905 737 34",
      }), "AC1: the text on the wire is the approved E, byte for byte");
      for (const m of sent) {
        assertEq(m.from, '"Daniel Fredriksen" <kontakt@rettfrabonden.com>', "AC3: From on the outreach");
        assertEq(m.replyTo, GARDSSALG_OUTREACH_REPLY_TO, "AC3: Reply-To unchanged");
        assertEq(GARDSSALG_OUTREACH_REPLY_TO, "kontakt@opplevagent.no", "AC3: Reply-To is kontakt@opplevagent.no");
        assertTrue(m.headers["In-Reply-To"] === undefined && m.headers["References"] === undefined, "AC4: a first mail carries no threading headers");
      }
      assertEq(gardssalgOutreachFromHeader(), '"Daniel Fredriksen" <kontakt@rettfrabonden.com>', "AC3: from-header helper");
      assertEq(
        (require("../services/crm-platform-identity") as typeof import("../services/crm-platform-identity")).crmFromHeader("experiences"),
        '"Opplevagent" <kontakt@rettfrabonden.com>',
        "AC3: other Opplevagent mail keeps «Opplevagent» as display name",
      );

      // AC7: CRM carries template + arm
      const c1 = crmRows("prov-v4-1");
      const c2 = crmRows("prov-v4-2");
      assertEq(c1.length, 1, "AC7: first mail filed in the CRM");
      assertEq(JSON.parse(c1[0].raw_metadata).template, "personal-v4", "AC7: CRM template personal-v4");
      assertEq(JSON.parse(c1[0].raw_metadata).subject_arm, "A", "AC7: CRM subject arm A");
      assertEq(JSON.parse(c2[0].raw_metadata).subject_arm, "B", "AC7: CRM subject arm B");
      assertEq(c1[0].body_text, sent[0].text, "AC9-ish: CRM body_text equals what was sent");
      assertEq(c1[0].id, "<v4-msg-1@rettfrabonden.com>", "CRM keeps the transport Message-ID");

      // AC4: follow-ups
      ageFirstSend("prov-v4-1", "2026-05-15T09:00:00.000Z");
      ageFirstSend("prov-v4-2", "2026-05-15T09:00:00.000Z");
      const before = sent.length;
      const f1 = await sendFollowup(P1);
      const f2 = await sendFollowup(P2);
      assertEq([f1.status, f2.status], ["sent", "sent"], "AC4: follow-ups sent");
      assertEq([f1.template, f1.threaded, f1.subject_arm], ["personal-v4-followup", true, undefined], "AC7: follow-up row carries its template");
      const fm1 = sent[before];
      const fm2 = sent[before + 1];
      assertEq(fm1.headers["In-Reply-To"], "<v4-msg-1@rettfrabonden.com>", "AC4: In-Reply-To is the first message's Message-ID");
      assertEq(fm1.headers["References"], "<v4-msg-1@rettfrabonden.com>", "AC4: References is the first message's Message-ID");
      assertEq(fm1.subject, "Re: Har vi riktig info om Senja Handbryggeri?", "AC4: Re: <first subject> (arm A)");
      assertEq(fm2.subject, "Re: Spørsmål om besøk hos Larkollen Gin Compagnie", "AC4: Re: <first subject> (arm B)");
      assertEq(fm2.headers["In-Reply-To"], "<v4-msg-2@rettfrabonden.com>", "AC4: second producer threads to its own first mail");
      assertEq(fm1.from, '"Daniel Fredriksen" <kontakt@rettfrabonden.com>', "AC3: From on the follow-up");
      assertEq(fm1.text, fill(TEXT_F, {
        navn: "Senja Handbryggeri",
        url: "https://opplevagent.no/kategori/gardssalg/produsent/senja-handbryggeri--a1",
        "måned": gardssalgOutreachMonthPhrase(new Date("2026-05-15T09:00:00.000Z"), new Date()),
      }), "AC1/AC4: the follow-up on the wire is the approved F, with {måned} from the FIRST send");
      const c1b = crmRows("prov-v4-1");
      assertEq(c1b.length, 2, "AC7: follow-up filed in the same CRM thread");
      assertEq(JSON.parse(c1b[1].raw_metadata).template, "personal-v4-followup", "AC7: CRM template personal-v4-followup");
      assertEq(JSON.parse(c1b[1].raw_metadata).in_reply_to, "<v4-msg-1@rettfrabonden.com>", "AC7: CRM remembers what it answered");
      assertEq(c1b[1].subject, "Re: Har vi riktig info om Senja Handbryggeri?", "AC4: CRM subject of the follow-up");
      assertEq(nextArm(), "B", "arm: three first mails filed (follow-ups not counted) -> the next first mail is arm B");

      // No first message in the CRM (old send filed nowhere): new mail, subject A
      const P4 = elig("prov-v4-4", "Hevd Håndverksbakeri", "hevd--d4", "post@v4-hevd.no");
      expDb
        .prepare(`INSERT INTO experience_outreach_sent_log (provider_id, recipient_email, channel, message_id, notes, is_test, sent_at) VALUES (?, ?, 'email', 'old-1', NULL, 0, '2026-05-20 09:00:00')`)
        .run("prov-v4-4", P4.epost);
      const b4 = sent.length;
      const f4 = await sendFollowup(P4);
      assertEq([f4.status, f4.threaded], ["sent", false], "AC4: no first message -> sent, not threaded");
      assertEq(sent[b4].subject, "Har vi riktig info om Hevd Håndverksbakeri?", "AC4: no first message -> subject A");
      assertTrue(sent[b4].headers["In-Reply-To"] === undefined && sent[b4].headers["References"] === undefined, "AC4: no first message -> no threading headers");
      assertTrue(sent[b4].text.startsWith("Hei igjen,"), "AC4: no first message -> still text F");
      assertTrue(sent[b4].text.includes(`Jeg skrev til dere ${gardssalgOutreachMonthPhrase(new Date("2026-05-20T09:00:00Z"), new Date())} om Hevd Håndverksbakeri på Opplevagent.`), "AC4: {måned} comes from the sent log when the CRM has nothing");

      // First message exists but its id is not a real Message-ID (DRY_RUN / synthetic): same fallback
      const P5 = elig("prov-v4-5", "Nordre Bryggeri ANS", "nordre--e5", "post@v4-nordre.no");
      expDb
        .prepare(`INSERT INTO experience_outreach_sent_log (provider_id, recipient_email, channel, message_id, notes, is_test, sent_at) VALUES (?, ?, 'email', 'DRY_RUN', NULL, 0, '2026-05-21 09:00:00')`)
        .run("prov-v4-5", P5.epost);
      const b5 = sent.length;
      (require("../services/crm-service") as typeof import("../services/crm-service")).crmService.ingestThread(
        {
          threadId: "opplevagent-outreach-prov-v4-5",
          subject: "Har vi riktig info om Nordre Bryggeri?",
          category: "marketing",
          messages: [{ messageId: "DRY_RUN", direction: "out", fromEmail: "kontakt@rettfrabonden.com", toEmails: [P5.epost], subject: "Har vi riktig info om Nordre Bryggeri?", bodyText: "x", sentAt: "2026-05-21T09:00:00.000Z" }],
        },
        P5.epost,
        "experiences",
      );
      const f5 = await sendFollowup(P5);
      assertEq([f5.status, f5.threaded], ["sent", false], "AC4: unusable first Message-ID -> not threaded");
      assertEq(sent[b5].subject, "Har vi riktig info om Nordre Bryggeri?", "AC4: unusable first Message-ID -> subject A");

      // A follow-up with no first send at all is refused, nothing written
      const P6 = elig("prov-v4-6", "Ukjent Gård", "ukjent--f6", "post@v4-ukjent.no");
      const b6 = sent.length;
      const f6 = await sendFollowup(P6);
      assertEq([f6.status, f6.reason, sent.length], ["skipped", "followup_without_prior_send", b6], "follow-up without a first send is skipped, not mailed");

      // Legacy templates still go out from Daniel too (sender is a property of sendGardssalgOutreach)
      const b7 = sent.length;
      await emailSvc.sendGardssalgOutreach("post@v4-legacy.no", "Legacy Gård", "https://opplevagent.no/kategori/gardssalg/produsent/legacy", { template: "personal" });
      assertEq(sent[b7].from, '"Daniel Fredriksen" <kontakt@rettfrabonden.com>', "AC3: legacy personal template also from Daniel (same send method)");
      assertTrue(sent[b7].subject.startsWith("Har vi riktig info om Legacy Gård"), "legacy personal template unchanged");

      function nextArm(): string {
        return opplevelserMod.nextGardssalgOutreachSubjectArm(rfbDb as any);
      }
    } catch (err) {
      failed++;
      failures.push(`✗ harness error: ${err instanceof Error ? err.stack || err.message : String(err)}`);
      if (log) console.log(`  ✗ harness error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      if (emailSvc) {
        emailSvc.isConfigured = origConfigured;
        emailSvc.transporter = origTransporter;
      }
      try {
        const initMod = require("../database/init") as typeof import("../database/init");
        initMod.__setDbForTesting(prevRfbDb);
      } catch {
        // ignore
      }
      try {
        const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
        dbFactory.__resetDbFactoryForTesting();
      } catch {
        // best-effort
      }
      const restore = (k: string, v: string | undefined) => {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      };
      restore("EXPERIENCES_DB_PATH", prevExperiencesDbPath);
      restore("ADMIN_KEY", prevAdminKey);
      restore("OUTREACH_COOLDOWN_DAYS", prevCooldownDays);
      restoreModuleCache();
    }
    return { passed, failed, failures };
  })();
}

if (require.main === module) {
  runOpplevelserGardssalgOutreachV4Tests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    for (const f of summary.failures) console.log(f);
    process.exit(summary.failed > 0 ? 1 : 0);
  });
}
