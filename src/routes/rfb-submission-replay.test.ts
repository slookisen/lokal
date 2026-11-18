/**
 * rfb-submission-replay.test.ts — dev-request
 * 2026-09-09-epost-eksponering-skjerming-mot-masseinnhosting (S-A5, the
 * RFB-MCP part): the prerequisite replay test. RFB had no replay test of its
 * ChatGPT app submission; this is the baseline, built like
 * opplevagent-submission-replay.test.ts.
 *
 * The five test_cases of chatgpt-app-submission.json all trigger
 * lokal_search. Each is replayed offline through the real lokal_search
 * handler (mcp.ts registerTools, through the duck-typed server of
 * rfb-sok-ukjente-ord-bakeri-sted.test.ts) against a fixed in-memory fixture
 * (enterFixtures: production schema, BASE_URL unset, geocoding offline — the
 * region words resolve through geocoding-service's own region table). The
 * submission carries only the user's prompt and the expected prose, not tool
 * arguments, so each case lists the argument shapes a model plausibly sends:
 * the prompt word for word, a short English keyword query, and the same in
 * Norwegian (ARG_SHAPES below).
 * Every shape must keep what the case promises: who is returned (the named
 * example producers, only the asked-for region, only producers of the
 * product), explicit product matches before category-only matches, and a
 * phone and ✉️ e-mail line for every listed producer that has one. No
 * full-text snapshots.
 *
 * E-mail switches: the e-mail reveal guard (EMAIL_REVEAL_GUARD_RFB) and the
 * contact-form switch (CONTACT_FORM_RFB) do not reach the RFB MCP answers
 * today (contact-form-only.ts: «Not yet … the RFB MCP answers»). This test
 * runs with both unset — their default, production's state — and the ✉️
 * line must be there. When S-A5 RFB-MCP lands (per-IP e-mail limit with its
 * switch), its assertions go next to «r3-*» below: under the limit every case
 * holds as here; over the limit only the ✉️ line is missing; switch off the
 * answer is byte-identical to main. Not asserted here: that code does not
 * exist yet.
 *
 * Guards: the submission still has exactly five test_cases, all
 * tools_triggered "lokal_search", whose prompts are the ones replayed here,
 * and its negative_test_cases trigger no tool — a change to the submission
 * file makes this test fail, so it is revisited.
 *
 * Fixture producers: the business names the submission itself names, plus
 * "… Fixture" producers as decoys (other regions, other products, a region
 * word in a producer name). Phones and addresses are fixture values; every
 * e-mail is @example.test.
 *
 * Standalone: npx tsx src/routes/rfb-submission-replay.test.ts
 * Wired into the gate via tests/test.ts.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { Seed, CatalogRow } from "./rfb-kategorietiketter-ikke-tilbud.test";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

const id = (n: number) => `5a000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

// Case 0: reindeer meat, Finnmark
const FINNMARK_KJOTT = id(1), SKODI = id(2), ALTA_STORFE = id(3), ROROS_REIN = id(4), FINNMARK_NO_CONTACT = id(5);
// Case 1: honey, Vestfold
const TONSBERGBIER = id(11), BIGARD = id(12), VESTFOLD_NAVN = id(13), TRD_HONNING = id(14);
// Case 2: lamb, Innlandet
const SYGARD = id(21), STENBERGS = id(22), VOSS_LAM = id(23);
// Case 3: Ostegården, Bergen
const OSTEGARDEN = id(31), BERGEN_OST = id(32);
// Case 4: stockfish, Lofoten
const SVERDRUP = id(41), LOFOTPRODUKT = id(42), STAMSUND_FISK = id(43), ALESUND_TORRFISK = id(44);

/** A producer whose knowledge products and catalog rows are the same names (and prices). */
function seed(n: string, name: string, lat: number, lng: number, city: string, categories: string[], catalog: CatalogRow[]): Seed {
  return {
    id: n, name, lat, lng, city, categories,
    products: catalog.map((c) => ({ name: c.name, category: c.category ?? categories[0], ...(c.priceNok ? { price: `${c.priceNok} kr` } : {}) })),
    catalog,
  };
}

export const RFB_SUBMISSION_SEEDS: Seed[] = [
  // Finnmark (geocoding-service region 70.0, 25.0, 120 km)
  seed(FINNMARK_KJOTT, "Finnmark Kjøtt AS", 70.663, 23.682, "Hammerfest", ["meat"], [{ name: "Reinsdyrkjøtt", priceNok: 450 }, { name: "Reinskav", priceNok: 380 }]),
  seed(SKODI, "Skodi Rein AS", 69.472, 25.511, "Karasjok", ["meat"], [{ name: "Reinsdyrkjøtt", priceNok: 420 }]),
  seed(ALTA_STORFE, "Alta Storfe Fixture", 69.968, 23.272, "Alta", ["meat"], [{ name: "Storfekjøtt", priceNok: 300 }]),
  seed(FINNMARK_NO_CONTACT, "Porsanger Reinslakt Fixture", 70.053, 24.97, "Lakselv", ["meat"], [{ name: "Reinsdyrkjøtt", priceNok: 410 }]),
  seed(ROROS_REIN, "Røros Rein Fixture", 62.574, 11.384, "Røros", ["meat"], [{ name: "Reinsdyrkjøtt", priceNok: 430 }]),
  // Vestfold (59.3, 10.2, 80 km)
  seed(TONSBERGBIER, "TønsbergBier", 59.267, 10.408, "Tønsberg", ["honey"], [{ name: "Honning", priceNok: 150 }, { name: "Lynghonning", priceNok: 170 }]),
  seed(BIGARD, "Wenche og Arnes Bigård", 59.125, 10.4, "Tjøme", ["honey"], [{ name: "Sommerhonning", priceNok: 140 }]),
  seed(VESTFOLD_NAVN, "Vestfold Gårdsegg Fixture", 59.28, 10.25, "Horten", ["eggs"], [{ name: "Egg", priceNok: 55 }]),
  seed(TRD_HONNING, "Tirslaug Honning Fixture", 63.46, 10.46, "Trondheim", ["honey"], [{ name: "Lynghonning", priceNok: 150 }]),
  // Innlandet (61.5, 11.0, 120 km)
  seed(SYGARD, "Sygard Grytting", 61.58, 9.93, "Sør-Fron", ["meat"], [{ name: "Lammekjøtt", priceNok: 300 }]),
  seed(STENBERGS, "Stenbergs Gårdsverden", 60.67, 10.81, "Lena", ["meat"], [{ name: "Lammestek", priceNok: 320 }, { name: "Lammepølse", priceNok: 120 }]),
  seed(VOSS_LAM, "Voss Lam Fixture", 60.63, 6.42, "Voss", ["meat"], [{ name: "Lammekjøtt", priceNok: 290 }]),
  // Bergen
  seed(OSTEGARDEN, "Ostegården — Krokeide", 60.29, 5.27, "Bergen", ["dairy"], [
    { name: "Lagret Fanaost", priceNok: 190 }, { name: "Jørns Brie", priceNok: 120 }, { name: "Jørns Camembert", priceNok: 120 }, { name: "Yoghurt", priceNok: 45 },
  ]),
  seed(BERGEN_OST, "Bergen Meieri Fixture", 60.39, 5.32, "Bergen", ["dairy"], [{ name: "Gulost", priceNok: 90 }]),
  // Lofoten (68.0453, 13.3824, 50 km)
  seed(SVERDRUP, "H. Sverdrup AS", 67.93, 13.09, "Reine", ["fish"], [{ name: "Tørrfisk loins", priceNok: 450 }, { name: "Lofotskiver", priceNok: 120 }]),
  seed(LOFOTPRODUKT, "Lofotprodukt AS", 68.147, 13.611, "Leknes", ["fish"], [{ name: "Tørrfisk", priceNok: 300 }]),
  seed(STAMSUND_FISK, "Stamsund Sjømat Fixture", 68.123, 13.84, "Stamsund", ["fish"], [{ name: "Fersk torsk", priceNok: 150 }]),
  seed(ALESUND_TORRFISK, "Ålesund Tørrfisk Fixture", 62.47, 6.15, "Ålesund", ["fish"], [{ name: "Tørrfisk", priceNok: 280 }]),
];

/** The e-mail address the fixture gives a producer (@example.test, never a real one). */
const emailOf = (agentId: string) => (agentId === OSTEGARDEN ? "post@example.test" : `post-${agentId.slice(-2)}@example.test`);
const PHONE = "91234567";
/** A Finnmark reindeer producer with neither phone nor e-mail: listed, with no contact line. */
const NO_CONTACT = new Set([FINNMARK_NO_CONTACT]);

/**
 * The argument shapes replayed per case. The submission has only
 * user_prompt + expected_output; a model sends lokal_search either the
 * prompt as it stands (the server instructions ask for the request in
 * `query`) or the product and place as keywords.
 */
export const ARG_SHAPES: ReadonlyArray<readonly Record<string, unknown>[]> = [
  [{ query: "Where can I buy reindeer meat in Finnmark?" }, { query: "reindeer meat Finnmark" }, { query: "reinsdyrkjøtt Finnmark" }],
  [{ query: "Find a farm in Vestfold with raw honey" }, { query: "raw honey Vestfold" }, { query: "honning Vestfold" }],
  [{ query: "Which farms in Innlandet sell lamb?" }, { query: "lamb Innlandet" }, { query: "lam i Innlandet" }],
  [{ query: "Tell me about Ostegården in Bergen — what do they make and how can I contact them?" }, { query: "Ostegården Bergen" }, { query: "Ostegården" }],
  [{ query: "Where can I buy stockfish in Lofoten?" }, { query: "stockfish Lofoten" }, { query: "tørrfisk Lofoten" }],
];

/** The submission's own prompts, in its order (r0 checks the file still says so). */
const SUBMISSION_PROMPTS = ARG_SHAPES.map((shapes) => String(shapes[0].query));

const ENV_SWITCHES = ["EMAIL_REVEAL_GUARD_RFB", "CONTACT_FORM_RFB"] as const;

interface Listed {
  name: string;
  categoryOnly: boolean;
  block: string;
}

/** The producers of a lokal_search text, in the order shown, with their block of lines. */
function listedIn(text: string): Listed[] {
  const parts = text.split(/^(?=\*\*\d+\. )/m).slice(1);
  return parts.map((block) => {
    const m = /^\*\*\d+\. (.+?)(?: — Kategoritreff[^*]*)?\*\*/.exec(block);
    return { name: m ? m[1] : "", categoryOnly: /^\*\*\d+\. .+? — Kategoritreff/.test(block), block };
  });
}

export function runRfbSubmissionReplayTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];
  const out = console.log;

  function assertEq(actual: unknown, expected: unknown, label: string): void {
    if (JSON.stringify(actual) === JSON.stringify(expected)) {
      passed++;
      if (log) out(`  ok ${label}`);
    } else {
      failed++;
      const msg = `✗ ${label}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`;
      failures.push(msg);
      if (log) out("  " + msg);
    }
  }

  const nameOf = new Map(RFB_SUBMISSION_SEEDS.map((s) => [s.id, s.name]));
  const names = (...ids: string[]) => ids.map((i) => nameOf.get(i)!);

  /** Per case: must be listed (explicit matches), may be listed, and the products every listed producer sells. */
  const expectations: Array<{ must: string[]; allowed: string[]; categoryOnlyAllowed: string[] }> = [
    { must: names(FINNMARK_KJOTT, SKODI, FINNMARK_NO_CONTACT), allowed: names(FINNMARK_KJOTT, SKODI, FINNMARK_NO_CONTACT, ALTA_STORFE), categoryOnlyAllowed: names(ALTA_STORFE) },
    { must: names(TONSBERGBIER, BIGARD), allowed: names(TONSBERGBIER, BIGARD), categoryOnlyAllowed: [] },
    { must: names(SYGARD, STENBERGS), allowed: names(SYGARD, STENBERGS), categoryOnlyAllowed: [] },
    { must: names(OSTEGARDEN), allowed: names(OSTEGARDEN, BERGEN_OST), categoryOnlyAllowed: [] },
    { must: names(SVERDRUP, LOFOTPRODUKT), allowed: names(SVERDRUP, LOFOTPRODUKT, STAMSUND_FISK), categoryOnlyAllowed: names(STAMSUND_FISK) },
  ];

  return (async () => {
    const prevSwitches = ENV_SWITCHES.map((k) => process.env[k]);
    for (const k of ENV_SWITCHES) delete process.env[k];
    const prevLog = console.log;
    let fixtures: { restore: () => void } | undefined;

    try {
      // r0: the submission file is what this test replays.
      const submission = JSON.parse(fs.readFileSync(path.join(__dirname, "../../chatgpt-app-submission.json"), "utf8"));
      const testCases: any[] = submission.test_cases ?? [];
      assertEq(testCases.length, 5, "r0a: the submission has exactly 5 test_cases");
      assertEq(testCases.map((c) => c.tools_triggered), Array(5).fill("lokal_search"), "r0b: every test_case triggers lokal_search");
      assertEq(testCases.map((c) => c.user_prompt), SUBMISSION_PROMPTS, "r0c: the replayed prompts are the submission's test_cases, in order");
      const negatives: any[] = submission.negative_test_cases ?? [];
      assertEq([negatives.length > 0, negatives.every((c) => c.tools_triggered === null)], [true, true], "r0d: negative_test_cases trigger no tool");

      const { enterFixtures, captureTools, textOf } =
        require("./rfb-sok-ukjente-ord-bakeri-sted.test") as typeof import("./rfb-sok-ukjente-ord-bakeri-sted.test");
      const entered = enterFixtures(RFB_SUBMISSION_SEEDS);
      fixtures = entered;
      const setContact = entered.db.prepare("UPDATE agent_knowledge SET phone = ?, email = ? WHERE agent_id = ?");
      const setAgentEmail = entered.db.prepare("UPDATE agents SET contact_email = ? WHERE id = ?");
      for (const s of RFB_SUBMISSION_SEEDS) {
        const none = NO_CONTACT.has(s.id);
        setContact.run(none ? null : PHONE, none ? null : emailOf(s.id), s.id);
        setAgentEmail.run(emailOf(s.id), s.id);
      }
      entered.db.prepare("UPDATE agent_knowledge SET website = ? WHERE agent_id = ?").run("https://ostegarden.example.test", OSTEGARDEN);

      console.log = () => { /* silence module chatter */ };
      const tools = captureTools();
      const search = async (args: Record<string, unknown>) => textOf(await tools.get("lokal_search")!({ limit: 10, ...args }));

      const seedByName = new Map(RFB_SUBMISSION_SEEDS.map((s) => [s.name, s]));
      for (let c = 0; c < ARG_SHAPES.length; c++) {
        const exp = expectations[c];
        for (const args of ARG_SHAPES[c]) {
          const label = `case ${c} ${JSON.stringify(args)}`;
          const text = await search(args);
          const listed = listedIn(text);
          const shown = listed.map((l) => l.name);
          if (log) out(`--- ${label}\n${text}\n`);

          // r1: who is returned.
          assertEq(exp.must.filter((n) => !shown.includes(n)), [], `r1a-${label}: the promised producers are listed`);
          assertEq(shown.filter((n) => !exp.allowed.includes(n)), [], `r1b-${label}: only producers of the product in the asked-for place`);

          // r2: explicit product matches before category-only matches; only the expected ones are category-only.
          const firstCategory = listed.findIndex((l) => l.categoryOnly);
          assertEq(firstCategory === -1 || listed.slice(firstCategory).every((l) => l.categoryOnly), true,
            `r2a-${label}: explicit product matches come before category-only matches`);
          assertEq(listed.filter((l) => l.categoryOnly).map((l) => l.name), shown.filter((n) => exp.categoryOnlyAllowed.includes(n)),
            `r2b-${label}: exactly the producers without the product are marked category-only`);
          assertEq(listed.filter((l) => l.categoryOnly && !l.block.includes("ask the producer")).map((l) => l.name), [],
            `r2c-${label}: a category-only match carries the note to check with the producer`);

          // r3: contact lines — phone and ✉️ e-mail for every listed producer that has them.
          // (S-A5 RFB-MCP: the over-limit / switch-on assertions go here.)
          const contactProblems = listed.flatMap((l) => {
            const s = seedByName.get(l.name);
            if (!s) return [`${l.name}: not a fixture producer`];
            if (NO_CONTACT.has(s.id)) return /📞|✉️/.test(l.block) ? [`${l.name}: a contact line it does not have`] : [];
            return [
              ...(l.block.includes(`📞 ${PHONE}`) ? [] : [`${l.name}: 📞 line`]),
              ...(l.block.includes(`✉️ ${emailOf(s.id)}`) ? [] : [`${l.name}: ✉️ line`]),
            ];
          });
          assertEq(contactProblems, [], `r3-${label}: every listed producer with phone/e-mail shows 📞 and ✉️`);

          if (c === 3) {
            // Case 3: the named lookup returns the product list and contact details in one call.
            const oste = listed.find((l) => l.name === nameOf.get(OSTEGARDEN));
            assertEq(shown[0], nameOf.get(OSTEGARDEN), `r4a-${label}: Ostegården is the first hit`);
            const block = oste?.block ?? "";
            assertEq(["Lagret Fanaost", "Jørns Brie", "Jørns Camembert", "Yoghurt"].filter((p) => !block.includes(p)), [],
              `r4b-${label}: the product list is in the answer`);
            assertEq(["📞 91234567", "✉️ post@example.test", "🌐 https://ostegarden.example.test"].filter((line) => !block.includes(line)), [],
              `r4c-${label}: phone, e-mail and website are in the answer`);
            assertEq(/\/produsent\/[^)\s]+/.test(block), true, `r4d-${label}: a link to the Rett fra Bonden profile`);
          }
        }
      }
    } catch (err: any) {
      failed++;
      failures.push("rfb-submission-replay: unexpected error: " + String(err?.stack || err?.message || err));
    } finally {
      console.log = prevLog;
      if (fixtures) fixtures.restore();
      ENV_SWITCHES.forEach((k, i) => {
        if (prevSwitches[i] === undefined) delete process.env[k];
        else process.env[k] = prevSwitches[i];
      });
    }

    return { passed, failed, failures };
  })();
}

// Standalone runner: `npx tsx src/routes/rfb-submission-replay.test.ts`
if (require.main === module) {
  runRfbSubmissionReplayTests({ log: process.argv.includes("--verbose") }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    for (const f of summary.failures) console.log(f);
    process.exit(summary.failed > 0 ? 1 : 0);
  });
}
