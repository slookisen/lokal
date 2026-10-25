/**
 * dental-landing.test.ts -- A2A dev-request 2026-10-16-finn-tannlege-fasettsider,
 * skive F1-S4a: the facet config (DENTAL_LANDING_FACETS and
 * DENTAL_LANDING_CONFIG.facets).
 *
 *   a  slugs: unique, URL-safe, one path segment; findDentalLandingFacet
 *      finds each and nothing else (no prototype key).
 *   b  the specialty facets are SPECIALTY_PAGES (routes/dental-seo.ts): the
 *      same slugs in the same order, each filtering on its stored name, with
 *      the specialist's title as H1 label («Kjeveortoped»).
 *   c  the other facets: tannlegevakt filters on vakt only (acute_claim
 *      "vakt") and is off since F1-S4c (vakt needs a stored quote, which no
 *      row has yet); helfo is off until F2-S6 (Daniel, question 24: Helfo
 *      only with a source).
 *   d  every filter sets exactly one facet field, never a place field, and
 *      the store keeps it (a field the schema strips would list every clinic
 *      of the place).
 *   e  H1 labels and title templates: {sted} once, no FINN or «Finn» alone
 *      (decision 4=A).
 *   f  the gate: facets.minListings 3 (Daniel, question 7, 2026-10-18),
 *      facets.minFacts 2; faq.* unchanged.
 *   g  DENTAL_EMERGENCY_NOTICE: the reviewed text word for word (113,
 *      legevakten 116 117, else the local tannlegevakt, then the caveat of
 *      /vilkar pkt. 3: call the clinic before you go); each phone number
 *      occurs once in it and dials its own digits; no FINN.
 *
 * The routes, the gate on real counts and the sitemap are tested in
 * src/routes/dental-landing.test.ts.
 *
 * Standalone: npx tsx src/config/dental-landing.test.ts
 * Wired into tests/test.ts via runDentalLandingConfigTests().
 */

import { DENTAL_EMERGENCY_NOTICE, DENTAL_LANDING_CONFIG, DENTAL_LANDING_FACETS, findDentalLandingFacet } from "./dental-landing";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export function runDentalLandingConfigTests(opts: { log?: boolean } = {}): TestSummary {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];
  function assertTrue(cond: boolean, label: string): void {
    if (cond) { passed++; if (log) console.log(`  ok ${label}`); }
    else { failed++; failures.push(`✗ ${label}`); if (log) console.log(`  ✗ ${label}`); }
  }
  function assertEq(actual: unknown, expected: unknown, label: string): void {
    assertTrue(JSON.stringify(actual) === JSON.stringify(expected), `${label} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
  }

  const { SPECIALTY_PAGES } = require("../routes/dental-seo") as typeof import("../routes/dental-seo");
  const { ListFilterSchema } = require("../services/dental-store") as typeof import("../services/dental-store");
  const F = DENTAL_LANDING_FACETS;
  const slugs = F.map((f) => f.slug);

  // ── a. slugs ─────────────────────────────────────────────────────────────
  assertEq(new Set(slugs).size, slugs.length, "a1: every facet slug is unique");
  assertTrue(slugs.every((s) => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(s)), `a2: every slug is one URL-safe path segment (a-z, 0-9, inner hyphens) (${slugs.join(", ")})`);
  assertTrue(F.every((f) => findDentalLandingFacet(f.slug) === f), "a3: findDentalLandingFacet finds each facet by its slug");
  assertEq(["", "ukjent", "Kjeveortopedi", "constructor", "__proto__", "toString"].map((s) => findDentalLandingFacet(s)), [undefined, undefined, undefined, undefined, undefined, undefined], "a4: an unknown slug, another case or a prototype key finds nothing");

  // ── b. specialty facets = SPECIALTY_PAGES ────────────────────────────────
  const specialty = F.filter((f) => f.kind === "specialty");
  assertEq(specialty.map((f) => f.slug), SPECIALTY_PAGES.map((p) => p.slug), "b1: the specialty facets are SPECIALTY_PAGES, same slugs, same order");
  assertEq(specialty.map((f) => f.filter), SPECIALTY_PAGES.map((p) => ({ specialty: p.navn })), "b2: each filters on the specialty's stored name, as /spesialitet/<slug> does");
  assertEq(
    specialty.map((f) => f.h1Label),
    ["Kjeveortoped", "Oralkirurg", "Periodontist", "Endodontist", "Pedodontist", "Protetiker", "Kjeve- og ansiktsradiolog"],
    "b3: the H1 label is the specialist's title («Kjeveortoped i Bergen»), not the specialty's name"
  );
  assertEq(specialty.map((f) => f.enabled), SPECIALTY_PAGES.map(() => true), "b4: every specialty facet is on");

  // ── c. tannlegevakt and helfo ────────────────────────────────────────────
  assertEq(F.filter((f) => f.kind !== "specialty").map((f) => [f.slug, f.kind]), [["helfo", "helfo"], ["tannlegevakt", "tannlegevakt"]], "c1: besides the specialties exactly two facets: helfo and tannlegevakt");
  const vakt = findDentalLandingFacet("tannlegevakt")!;
  assertEq(vakt.filter, { acute_claim: "vakt" }, "c2: tannlegevakt lists «Akuttvakt» only (acute_claim vakt), not the akutt claim that also takes «Tar imot akuttpasienter»");
  assertEq(vakt.enabled, false, "c2b: tannlegevakt is off (F1-S4c) until vakt is defined and its quote stored; it is turned on in its own PR");
  const helfo = findDentalLandingFacet("helfo")!;
  assertEq(helfo.filter, { helfo_agreement: "true" }, "c3: helfo filters on the public Helfo field, which F2-S6 makes the sourced claim (DENTAL_HELFO_CLAIM_SQL)");
  assertEq(helfo.enabled, false, "c4: helfo is off until F2-S6 is merged (Helfo only with a source, question 24); it is turned on in its own PR");
  assertEq(F.filter((f) => !f.enabled).map((f) => f.slug), ["helfo", "tannlegevakt"], "c5: helfo and tannlegevakt are the only facets that are off");

  // ── d. filters ───────────────────────────────────────────────────────────
  const FACET_FIELDS = new Set(["helfo_agreement", "acute_claim", "specialty"]);
  assertTrue(F.every((f) => Object.keys(f.filter).length === 1 && Object.keys(f.filter).every((k) => FACET_FIELDS.has(k))), "d1: every filter sets exactly one facet field and no place field (poststed, poststed_in, fylke, q …), so place and facet filters never overwrite each other");
  const kept = F.filter((f) => JSON.stringify(ListFilterSchema.parse(f.filter)) !== JSON.stringify(f.filter)).map((f) => f.slug);
  assertEq(kept, [], "d2: the store's ListFilterSchema keeps every facet filter as it is (none is stripped to «all clinics»)");

  // ── e. texts ─────────────────────────────────────────────────────────────
  assertTrue(F.every((f) => f.titleTemplate.split("{sted}").length === 2), "e1: every title template has {sted} exactly once");
  assertTrue(F.every((f) => f.h1Label.trim() !== "" && !/[{}]/.test(f.h1Label)), "e2: every H1 label is set and has no placeholder");
  const brand = (text: string): boolean => /\bFINN\b/.test(text) || /finn\.no/i.test(text) || /\bFinn\b(?!-tannlege)/.test(text);
  assertTrue(F.every((f) => !brand(f.h1Label) && !brand(f.titleTemplate)), "e3: no H1 label or title says FINN, finn.no or «Finn» alone (decision 4=A)");
  assertTrue(brand("FINN") && brand("finn.no") && brand("Finn tannlege") && !brand("Finn-tannlege.com") && !brand("finn en tannlege"), "e4: (the check itself catches FINN, finn.no and «Finn» alone, and lets «Finn-tannlege» and the verb «finn» pass)");

  // ── f. the gate ──────────────────────────────────────────────────────────
  assertEq(DENTAL_LANDING_CONFIG.facets, { minListings: 3, minFacts: 2 }, "f1: facets.minListings 3 (Daniel, question 7, 2026-10-18) and facets.minFacts 2");
  assertEq(DENTAL_LANDING_CONFIG.faq, { minListings: 3, minFacts: 2, minQas: 2 }, "f2: the /sted and /fylke FAQ gate is unchanged");

  // ── g. the emergency notice ──────────────────────────────────────────────
  const notice = DENTAL_EMERGENCY_NOTICE;
  assertEq(
    notice.text,
    "Ved akutt fare for liv eller helse: ring 113. Trenger du rask hjelp utenom åpningstid, ring legevakten på 116 117. Ellers kan du kontakte tannlegevakten der du bor. At en klinikk er merket med akuttilbud her, betyr ikke at den kan ta imot deg nå. Ring klinikken før du drar dit.",
    "g1: the notice text, word for word as reviewed (YMYL), ending with the caveat of /vilkar pkt. 3"
  );
  assertTrue(
    notice.text.endsWith(" At en klinikk er merket med akuttilbud her, betyr ikke at den kan ta imot deg nå. Ring klinikken før du drar dit."),
    "g6: it ends with the caveat Daniel approved in /vilkar pkt. 3 (2026-10-19): a clinic marked with akuttilbud may not be able to see you now; call it before you go"
  );
  assertEq(notice.phones.map((p) => [p.number, p.tel]), [["113", "113"], ["116 117", "116117"]], "g2: its phone numbers: 113 and 116 117, dialled as tel:113 and tel:116117");
  assertTrue(notice.phones.every((p) => notice.text.split(p.number).length === 2), "g3: each number occurs exactly once in the text, so each gets one link");
  assertTrue(notice.phones.every((p) => /^\d+$/.test(p.tel) && p.tel === p.number.replace(/\s/g, "")), "g4: each tel: is the number's own digits, without spaces");
  assertTrue(!brand(notice.text), "g5: no FINN, finn.no or «Finn» alone in it");

  return { passed, failed, failures };
}

if (require.main === module) {
  const r = runDentalLandingConfigTests({ log: true });
  console.log(`\ndental landing config (F1-S4a): ${r.passed} passed, ${r.failed} failed`);
  if (r.failures.length) console.log(r.failures.join("\n"));
  process.exit(r.failed > 0 ? 1 : 0);
}
