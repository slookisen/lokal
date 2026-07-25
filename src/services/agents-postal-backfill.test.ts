/**
 * agents-postal-backfill.test.ts — dev-request
 * 2026-07-25-reisesok-korridor-discovery-og-naerhetssok, Fase 1a follow-up.
 *
 * Daniel: «Kan du lage en fiks for å finne postnummer på de som mangler kun
 * dette?» — 13.2 % of active RFB producers (measured, n=250 uniform random)
 * have a real street address but no postnummer, which is the ONLY thing
 * keeping them off the Fase-1a geocode worker's Tier A ('address' precision,
 * the one tier the honesty rule lets state a km figure).
 *
 * The thing under test is a REFUSAL machine as much as a resolver. A wrong
 * postnummer does not degrade gracefully — it becomes a precise-but-wrong
 * coordinate tagged geo_precision='address', which then licenses a km figure.
 * So most of what follows asserts that we DECLINE to write.
 *
 * Asserted here:
 *   p1-p15   parseAddressParts / placeCandidates / samePlace / samePoststed —
 *            the pure layer, including the documented `city` pollution classes
 *            and (p13) NEGATIVE assertions over the measured poststed-collision
 *            list from the official postnummerregister
 *   g1-g16   the guards against a live-shaped Kartverket fixture:
 *            single hit → resolved · several DISTINCT postnummer → refused ·
 *            zero hits → refused · truncated page → refused ·
 *            hit that does not corroborate the place → refused ·
 *            inline number contradicted by Kartverket → refused ·
 *            inline number "confirmed" in a place the record never names →
 *            refused (g12, review B2) · two place candidates disagreeing →
 *            refused · the corroborating hit is the one reported (g15) ·
 *            a G3 refusal reports itself, not `no_match` (g16)
 *   u1-u4    the globally-unique last-resort tier, and the fact that it does
 *            NOT run after a refusal
 *   m1-m4    the additive agent_knowledge migration
 *   w1-w9    the worker: writes, provenance, prev-value latch, geocode requeue
 *   n1-n3d   never overwrite an existing postnummer — exercised through the
 *            WORKER via a concurrent owner edit landing mid-tick, because the
 *            previous version of n3 was a tautology (review B3)
 *   s1-s5    ALWAYS STAMP — refusals, a THROWN error, and a write blocked by
 *            the never-overwrite guard all still rotate the row
 *   r1-r3    rotation: successive batches pick DISJOINT rows
 *   d1-d5    dry run: reports everything, writes NOTHING (DB byte-identical)
 *   b1-b6    strict dry_run boolean + the limit clamp (shared with Fase 1a)
 *   f1-f3    single-flight guard
 *
 * Every guarantee below has been mutation-verified: deleting the guard from the
 * source makes at least one assertion here fail. Two of the original tests did
 * NOT survive that check (n3 and d4b) and were rewritten.
 *
 * Setup mirrors agents-geocode-worker.test.ts: an in-memory DB running the REAL
 * production schema via __setDbForTesting/__initSchemaForTesting (so the
 * migration under test is the one that ships), the singleton restored with
 * __peekDbForTesting() in `finally`. The ONLY network seam is
 * PostalBackfillDeps.fetchImpl and it is always injected — nothing here touches
 * the network.
 *
 * Exported runAgentsPostalBackfillTests({log}) -> TestSummary; wired into
 * tests/test.ts. Standalone: npx tsx src/services/agents-postal-backfill.test.ts
 */

import Database from "better-sqlite3";
import * as initMod from "../database/init";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

// ── Fixtures shaped exactly like live adresser/v1/sok ─────────────────
// Captured from the real API while building this (2026-07-25):
//   GET /adresser/v1/sok?sok=Storgata%205%20Lillehammer&treffPerSide=100
//   → {"metadata":{"totaltAntallTreff":1,…},"adresser":[{…,"kommunenummer":"3405",
//      "kommunenavn":"LILLEHAMMER","poststed":"LILLEHAMMER","postnummer":"2609",…}]}
function addr(postnummer: string, poststed: string, kommunenavn: string, kommunenummer = "9999", tekst = "Storgata 5") {
  return {
    adressetekst: tekst,
    adressenavn: tekst.replace(/\s+\d+\w*$/, ""),
    postnummer,
    poststed,
    kommunenummer,
    kommunenavn,
    objtype: "Vegadresse",
    representasjonspunkt: { epsg: "EPSG:4258", lat: 61.1, lon: 10.47 },
  };
}
function body(hits: any[], total?: number) {
  return {
    metadata: { totaltAntallTreff: total ?? hits.length, treffPerSide: 100, side: 0 },
    adresser: hits,
  };
}
const EMPTY = body([]);

export function runAgentsPostalBackfillTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];

  function assertTrue(cond: boolean, label: string): void {
    if (cond) { passed++; if (log) console.log(`  ok ${label}`); }
    else { failed++; failures.push(`✗ ${label}`); if (log) console.log(`  ✗ ${label}`); }
  }
  function assertEq(actual: unknown, expected: unknown, label: string): void {
    assertTrue(
      actual === expected,
      `${label} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`
    );
  }

  return (async () => {
    const prevDb = initMod.__peekDbForTesting();
    const db = new Database(":memory:");

    // ── The single injected network seam ────────────────────────────
    // A routing table keyed on the decoded `sok=` value, so each test declares
    // exactly what Kartverket would answer for the query it expects the
    // resolver to issue. An unregistered query answers EMPTY — which is the
    // safe direction: an unexpected query can only ever cause a REFUSAL, never
    // an accidental pass.
    const routes = new Map<string, any>();
    const seen: string[] = [];
    let failNextFetch = false;
    const fetchImpl = (async (input: any) => {
      const url = decodeURIComponent(String(input));
      const m = url.match(/[?&]sok=([^&]*)/);
      const q = (m ? m[1] : "").trim();
      seen.push(q);
      if (failNextFetch) throw new Error("simulated transport failure");
      return { ok: true, status: 200, json: async () => routes.get(q) ?? EMPTY } as unknown as Response;
    }) as unknown as typeof fetch;
    const deps = { fetchImpl, sleep: async () => {} };

    try {
      initMod.__setDbForTesting(db as any);
      initMod.__initSchemaForTesting(db as any);

      const pb = require("./agents-postal-backfill") as typeof import("./agents-postal-backfill");
      const geocodeWorker = require("./agents-geocode-worker") as typeof import("./agents-geocode-worker");

      // ── p1-p12: the pure layer ───────────────────────────────────
      {
        const a = pb.parseAddressParts("Garderveien 20, 1455 Nordre Frogn");
        assertEq(a.street, "Garderveien 20", "p1: the street part is everything before the first comma");
        assertEq(a.inlinePostal, "1455", "p2: a 4-digit number in the trailing segment is mined as a HYPOTHESIS");
        assertEq(a.trailingPlaces.join("|"), "Nordre Frogn", "p3: …and the poststed after it becomes a place candidate");

        // Observed live on prod: no comma at all.
        const b = pb.parseAddressParts("Leirvikveien 276 7273 Norddyrøy");
        assertEq(b.street, "Leirvikveien 276", "p4: a comma-less 'street nr postnr poststed' still splits correctly");
        assertEq(b.inlinePostal, "7273", "p5: …mining the RIGHTMOST 4-digit run, not the house number");

        // The house number can itself be four digits — the rightmost run wins.
        const c = pb.parseAddressParts("Vestbygdvegen 1030 8412 Vestbygda");
        assertEq(c.street, "Vestbygdvegen 1030", "p6: a 4-digit HOUSE number is not mistaken for the postnummer");
        assertEq(c.inlinePostal, "8412", "p7: …the postnummer is the rightmost 4-digit run followed by a word");

        // A bare trailing number is deliberately NOT mined: nothing
        // distinguishes it from a second house number.
        const d = pb.parseAddressParts("Storgata 5 0155");
        assertEq(d.inlinePostal, null, "p8: a bare trailing number is NOT mined — refusing beats guessing");

        assertEq(pb.placeCandidates("Mjøndalen/Drammen", []).join("|"), "Mjøndalen|Drammen",
          "p9: a compound city yields BOTH candidates (they must later agree, or we refuse)");
        assertEq(pb.placeCandidates("Norge", []).length, 0,
          "p10: 'Norge' is dropped — documented city pollution, not a place Kartverket can key on");
        assertEq(pb.placeCandidates("Akershus", []).length, 0,
          "p11: a fylke name is dropped too (city-normalizer's isFylkePollution)");
        assertEq(pb.placeCandidates("Lofoten", []).length, 0,
          "p11b: …as is a multi-kommune region label");
        assertTrue(pb.placeCandidates("Oslo", []).length === 1,
          "p11c: …but 'Oslo' survives, even though it is also a fylke name (a real city with real producers)");

        // Review item 6: `city` values like "Bergen, Norge" occur live; the
        // comma was missing from the split, so the candidate was the literal
        // "Bergen, Norge" and matched nothing, ever.
        assertEq(pb.placeCandidates("Bergen, Norge", []).join("|"), "Bergen",
          "p11d: a comma-separated city splits, and the 'Norge' half is dropped");

        assertTrue(pb.samePlace("Ås", "ÅS"), "p12: place comparison folds case and diacritics");
        assertTrue(!pb.samePlace("", "Oslo"), "p12e: an empty label never corroborates anything");

        // ── REVIEW B1 — negative assertions on the risky region ──────
        // The first version allowed ONE edit of ANY kind on 5+-char names.
        // Measured against the official postnummerregister (bring.no,
        // 5 122 rows / 1 839 distinct poststeder) that conflates 110 pairs of
        // genuinely different poststeder — and Kartverket's analyzer STEMS
        // tokens, so G3 was the only thing between them and a write: city
        // "Straume" resolved to 8226 STRAUMEN (Sørfold), ~900 km away, tagged
        // 'address', licensing a km figure. "Bergen" is a real city value in
        // our own address-without-postnummer cohort and sits in TWO of the 110.
        //
        // Every pair below is FROM that measured collision list. (The suite's
        // previous negative used Bergen/Berlevåg — edit distance 6 — which
        // proved nothing about the region that was actually broken.)
        for (const [a, b] of [
          ["Bergen", "Berger"], ["Bergen", "Borgen"], ["Straume", "Straumen"],
          ["Larvik", "Narvik"], ["Lavik", "Larvik"], ["Rogne", "Rognes"],
          ["Levanger", "Evanger"], ["Harstad", "Farstad"], ["Herøy", "Harøy"],
          ["Heimdal", "Heidal"], ["Melbu", "Selbu"], ["Vestby", "Østby"],
          ["Østre Gausdal", "Vestre Gausdal"],
        ] as Array<[string, string]>) {
          assertTrue(!pb.samePoststed(a, b),
            `p13 (B1): '${a}' and '${b}' are DIFFERENT poststeder — they must never corroborate each other`);
        }

        // The two cases the slack exists for, both measured live: Kartverket
        // answers 'SLINDA' for the token 'Slinde', and 'VESTBYGDA' for the
        // address text's 'Vestbygd'. Norwegian definite/indefinite morphology —
        // the difference is a trailing VOWEL, which is what the rule keys on.
        assertTrue(pb.samePoststed("Slinde", "SLINDA"),
          "p14: Slinde/SLINDA still corroborates — same stem, differing final vowel");
        assertTrue(pb.samePoststed("Vestbygd", "VESTBYGDA"),
          "p14b: …and Vestbygd/VESTBYGDA — the longer is the shorter plus a trailing vowel");
        assertTrue(!pb.samePoststed("Bø", "Bøa"),
          "p14c: …but not below the 5-character floor, which is exactly what removes HELL/HELLE, LUND/LUNDE, TORP/TORPO");

        // The slack is poststed-ONLY. Over poststeder ∪ kommunenavn the same
        // rule collides on STRAND (Rogaland) / STRANDA (Møre og Romsdal) — two
        // real kommuner ~200 km apart — so kommunenavn is compared exactly.
        assertTrue(!pb.samePlace("Slinde", "SLINDA"),
          "p15: samePlace — used for kommunenavn — is EXACT, no morphology slack");
        assertTrue(!pb.samePlace("Strand", "Stranda"),
          "p15b: …which is what keeps Strand and Stranda apart");
      }

      // ── g1-g11: the four guards ──────────────────────────────────
      {
        // G0 — the happy path: one hit, corroborated.
        routes.set("Storgata 5 Lillehammer", body([addr("2609", "LILLEHAMMER", "LILLEHAMMER", "3405")]));
        const r1 = await pb.resolvePostalCode("Storgata 5", "Lillehammer", deps);
        assertEq(r1.status, "resolved", "g1: a single corroborated hit resolves");
        assertEq(r1.status === "resolved" ? r1.postal_code : null, "2609", "g2: …to that hit's postnummer");
        assertEq(r1.status === "resolved" ? r1.source : null, "kartverket_adresse_sok",
          "g3: …recorded as derived from street + place, not as a scraped value");

        // Several hits, ONE postnummer (Storgata 5A / 5B) — not ambiguity.
        routes.set("Storgata 7 Lillehammer", body([
          addr("2609", "LILLEHAMMER", "LILLEHAMMER", "3405", "Storgata 7A"),
          addr("2609", "LILLEHAMMER", "LILLEHAMMER", "3405", "Storgata 7B"),
        ]));
        const r2 = await pb.resolvePostalCode("Storgata 7", "Lillehammer", deps);
        assertEq(r2.status, "resolved", "g4: several hits sharing ONE postnummer is not ambiguity — still resolved");

        // G2 — more than one DISTINCT postnummer. A long street really does
        // span several (live: sok=Kirkeveien Oslo → 123 hits across 0266, 0361…).
        routes.set("Kirkeveien Oslo", body([
          addr("0266", "OSLO", "OSLO", "0301", "Kirkeveien 1"),
          addr("0361", "OSLO", "OSLO", "0301", "Kirkeveien 104A"),
        ]));
        routes.set("Kirkeveien", body([addr("0266", "OSLO", "OSLO", "0301", "Kirkeveien 1")]));
        const r3 = await pb.resolvePostalCode("Kirkeveien 1", "Oslo", deps);
        assertEq(r3.status, "no_match",
          "g5: a street whose hits span several postnummer is NEVER written (this exact query is 123 live hits)");

        // Zero hits.
        const r4 = await pb.resolvePostalCode("Finnesikkeveien 9", "Lillehammer", deps);
        assertEq(r4.status, "no_match", "g6: zero Kartverket hits → refused, nothing invented");

        // G1 — truncated page. We must never judge uniqueness from a page.
        routes.set("Storgata 5 Oslo", body([addr("0155", "OSLO", "OSLO", "0301")], 4000));
        routes.set("Storgata 5", body([addr("0155", "OSLO", "OSLO", "0301")], 102));
        const r5 = await pb.resolvePostalCode("Storgata 5", "Oslo", deps);
        assertEq(r5.status, "ambiguous",
          "g7: totaltAntallTreff larger than the returned page → refused (uniqueness is unknowable from a truncated page)");

        // G3 — the hit does not corroborate the place we searched with. This is
        // the same-street-name-in-another-town case: the conjunctive match only
        // proves the token appeared in SOME field (adressetilleggsnavn is a
        // farm name and is searched too).
        routes.set("Bøveien 3 Bø", body([addr("4885", "GRIMSTAD", "GRIMSTAD", "4202", "Bøveien 3")]));
        routes.set("Bøveien 3", body([addr("4885", "GRIMSTAD", "GRIMSTAD", "4202", "Bøveien 3")]));
        const r6 = await pb.resolvePostalCode("Bøveien 3", "Bø", deps);
        assertEq(r6.status, "uncorroborated",
          "g8: a hit whose poststed/kommunenavn contradicts the place token is refused, even though it is unique");

        // G3 accepts kommunenavn as well as poststed — RFB's `city` is as often
        // a kommune as a poststed.
        routes.set("Bygdevegen 4 Ringerike", body([addr("3534", "SOKNA", "RINGERIKE", "3305", "Bygdevegen 4")]));
        const r7 = await pb.resolvePostalCode("Bygdevegen 4", "Ringerike", deps);
        assertEq(r7.status, "resolved", "g9: kommunenavn corroborates too — 'Sokna' the poststed sits in 'Ringerike' the kommune");

        // Inline hypothesis CONTRADICTED by Kartverket.
        routes.set("Feilgata 2 1234", body([addr("5678", "ANNETSTED", "ANNETSTED", "1111", "Feilgata 2")]));
        const r8 = await pb.resolvePostalCode("Feilgata 2, 1234 Etsted", "Etsted", deps);
        assertEq(r8.status, "ambiguous",
          "g10: a scraped inline postnummer that Kartverket contradicts is DISCARDED, never written");

        // ── REVIEW B2 — the inline tier's "confirmation" was vacuous ──
        // The probe is `street + NNNN`, which is conjunctive, so for a street
        // name present in many postnummer it succeeds by COINCIDENCE for any of
        // them. `Storgata 5` spans 64 distinct postnummer live. Both cases below
        // were reproduced end-to-end against live Kartverket by the reviewer and
        // wrote the wrong postnummer while `city` said Bergen and was never
        // consulted. This tier produced 16 of the first measurement's 18 writes.
        routes.set("Storgata 5 1890", body([addr("1890", "RAKKESTAD", "RAKKESTAD", "3120", "Storgata 5")]));
        routes.set("Storgata 5 Bergen", EMPTY);
        const b2a = await pb.resolvePostalCode("Storgata 5, 1890 Bergen", "Bergen", deps);
        assertEq(b2a.status, "ambiguous",
          "g12 (B2): an inline number 'confirmed' in RAKKESTAD is REFUSED when the record's own places all say Bergen");

        routes.set("Storgata 5 0155", body([addr("0155", "OSLO", "OSLO", "0301", "Storgata 5")]));
        const b2b = await pb.resolvePostalCode("Storgata 5, 0155 Bergen", "Bergen", deps);
        assertEq(b2b.status, "ambiguous",
          "g12b (B2): …same for 0155 OSLO — 'Kartverket returned a hit at NNNN' is not evidence the producer is there");

        // …and the DISTINCTION that must survive: the reviewer independently
        // verified "Vestbygdvegen 1030, 8412 Vestbygd" is CORRECT. There the
        // inline number is corroborated by the record's own trailing place
        // (poststed VESTBYGDA, definite form of Vestbygd) even though the `city`
        // column says Kvæfjord. Coincidence vs corroboration is the whole fix.
        routes.set("Vestbygdvegen 1030 8412", body([addr("8412", "VESTBYGDA", "LØDINGEN", "1851", "Vestbygdvegen 1030")]));
        const b2c = await pb.resolvePostalCode("Vestbygdvegen 1030, 8412 Vestbygd", "Kvæfjord", deps);
        assertEq(b2c.status, "resolved",
          "g13 (B2): a genuinely corroborated inline number still resolves — the fix is not 'distrust inline'");
        assertEq(b2c.status === "resolved" ? b2c.postal_code : null, "8412", "g13b: …to the right postnummer");

        // With NO place token at all there is nothing to corroborate against,
        // so the inline tier must NOT accept on its own — it defers to the
        // globally-unique tier, which corroborates by geography instead.
        routes.set("Enegata 7 1234", body([addr("1234", "ETSTED", "ETSTED", "1111", "Enegata 7")]));
        routes.set("Enegata 7", body([addr("1234", "ETSTED", "ETSTED", "1111", "Enegata 7")]));
        // "Enegata 7, 1234" — an inline number with NO poststed after it and a
        // NULL city, so placeCandidates() is empty.
        const b2d = await pb.resolvePostalCode("Enegata 7, 1234", null, deps);
        assertEq(b2d.status, "resolved", "g14 (B2): with no place token the inline number defers to the unique tier…");
        assertEq(b2d.status === "resolved" ? b2d.source : null, "kartverket_adresse_unik",
          "g14b: …and the provenance says so — it was accepted on geography, not on the scraped digits");

        // Review item 4: `planned[].detail` is read by a human during a dry-run
        // rehearsal, so it must name the hit that actually SATISFIED G3, not
        // hits[0]. Two hits, same postnummer (so G2 passes), different kommune.
        routes.set("Delegata 2 Bykle", body([
          addr("4754", "FEIL", "FEILKOMMUNE", "9998", "Delegata 2"),
          addr("4754", "BYKLE", "BYKLE", "4222", "Delegata 2"),
        ]));
        const it4 = await pb.resolvePostalCode("Delegata 2", "Bykle", deps);
        assertEq(it4.status === "resolved" ? it4.kommunenavn : null, "BYKLE",
          "g15 (item 4): the reported hit is the one that CORROBORATED, not merely the first in the array");

        // Review item 5: a unique hit in the wrong place is the most
        // interesting refusal we produce — it must not be filed as 'no_match'
        // ("Kartverket knows nothing matching"), or ops under-counts exactly
        // the near-misses worth reading.
        assertEq(r6.status, "uncorroborated",
          "g16 (item 5): a hit refused by G3 reports its own status, not 'no_match'");

        // An inline number that Kartverket cannot confirm must not be silently
        // OVERRIDDEN by a weaker tier: the record then disagrees with itself
        // and we have no way to tell which half is wrong.
        // "Gamlevegen 4, 1234 Etsted" — no hit for `Gamlevegen 4 1234`, but the
        // place lookup finds the street in Etsted at 5678.
        routes.set("Gamlevegen 4 Etsted", body([addr("5678", "ETSTED", "ETSTED", "1111", "Gamlevegen 4")]));
        routes.set("Gamlevegen 4", body([addr("5678", "ETSTED", "ETSTED", "1111", "Gamlevegen 4")]));
        const r8b = await pb.resolvePostalCode("Gamlevegen 4, 1234 Etsted", "Etsted", deps);
        assertEq(r8b.status, "ambiguous",
          "g10b: an unconfirmed inline postnummer is not overridden by a later tier proposing a different one");

        // G4 — two place candidates that disagree.
        routes.set("Drammensveien 201 Mjøndalen", body([addr("3050", "MJØNDALEN", "DRAMMEN", "3301", "Drammensveien 201")]));
        routes.set("Drammensveien 201 Drammen", body([addr("3040", "DRAMMEN", "DRAMMEN", "3301", "Drammensveien 201")]));
        const r9 = await pb.resolvePostalCode("Drammensveien 201", "Mjøndalen/Drammen", deps);
        assertEq(r9.status, "ambiguous",
          "g11: two place candidates resolving to DIFFERENT postnummer → refused, not a coin flip");
      }

      // ── u1-u4: the globally-unique last-resort tier ──────────────
      {
        // city NULL, no trailing place — the largest refusal reason measured on
        // live prod. One probe on the bare street settles it.
        routes.set("Borgestadveien 23A", body([addr("0875", "OSLO", "OSLO", "0301", "Borgestadveien 23A")]));
        const r = await pb.resolvePostalCode("Borgestadveien 23A", null, deps);
        assertEq(r.status, "resolved", "u1: a globally UNIQUE street address resolves with no place token at all");
        assertEq(r.status === "resolved" ? r.source : null, "kartverket_adresse_unik",
          "u2: …and says so in its provenance, so it can be told apart from a corroborated lookup");

        // Not unique → refused. (Live: sok=Storgata 5 → 102 hits.)
        routes.set("Torgveien 1", body([
          addr("0155", "OSLO", "OSLO", "0301", "Torgveien 1"),
          addr("5003", "BERGEN", "BERGEN", "4601", "Torgveien 1"),
        ]));
        const r2 = await pb.resolvePostalCode("Torgveien 1", null, deps);
        assertEq(r2.status, "ambiguous", "u3: a street that is NOT globally unique is refused here too");

        // The tier must not overturn G3. "Bøveien 3" was refused above because
        // its unique hit contradicted the place; asking again without the place
        // token would answer with that very record.
        const r3 = await pb.resolvePostalCode("Bøveien 3", "Bø", deps);
        assertEq(r3.status, "uncorroborated",
          "u4: the unique-address fallback does NOT run after a corroboration refusal — it cannot launder a rejected hit");
      }

      // ── m1-m4: the additive migration ────────────────────────────
      {
        const cols = (db.prepare(`PRAGMA table_info(agent_knowledge)`).all() as any[]).map((c) => c.name);
        assertTrue(cols.includes("postal_code_source"), "m1: agent_knowledge.postal_code_source (provenance) added");
        assertTrue(cols.includes("postal_code_prev"), "m2: …postal_code_prev (the rollback latch) added");
        assertTrue(cols.includes("postal_backfill_attempted_at"), "m3: …and postal_backfill_attempted_at (the rotation key)");
        initMod.__initSchemaForTesting(db as any);
        const again = (db.prepare(`PRAGMA table_info(agent_knowledge)`).all() as any[])
          .filter((c) => c.name === "postal_code_source");
        assertEq(again.length, 1, "m4: re-running the schema init neither throws nor duplicates (idempotent ALTER)");
      }

      // ── Seed helpers ─────────────────────────────────────────────
      const insertAgent = db.prepare(
        `INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key,
                             lat, lng, city, is_active, geo_precision, geocode_attempted_at)
         VALUES (@id, @name, 'Lokal matprodusent', 'test', 'a@b.no', 'https://example.no',
                 'producer', @api_key, NULL, NULL, @city, 1, NULL, @geocode_attempted_at)`
      );
      const insertKnowledge = db.prepare(
        `INSERT INTO agent_knowledge (agent_id, address, postal_code) VALUES (?, ?, ?)`
      );
      const seed = (o: {
        id: string; name?: string; city?: string | null;
        address?: string | null; postal_code?: string | null;
        geocode_attempted_at?: string | null;
      }) => {
        insertAgent.run({
          id: o.id, name: o.name ?? `Gård ${o.id}`, api_key: `key-${o.id}`,
          city: o.city ?? null, geocode_attempted_at: o.geocode_attempted_at ?? null,
        });
        insertKnowledge.run(o.id, o.address ?? null, o.postal_code ?? null);
      };
      const kOf = (id: string) => db
        .prepare(`SELECT address, postal_code, postal_code_prev, postal_code_source,
                         postal_backfill_outcome, postal_backfill_attempted_at
                    FROM agent_knowledge WHERE agent_id = ?`)
        .get(id) as any;

      // ── w1-w9: the worker writes, with provenance ────────────────
      {
        routes.set("Kongens gate 1 Trondheim", body([addr("7011", "TRONDHEIM", "TRONDHEIM", "5001", "Kongens gate 1")]));
        seed({ id: "w-ok", name: "Treff Gård", city: "Trondheim", address: "Kongens gate 1",
               geocode_attempted_at: "2026-07-01T00:00:00.000Z" });

        const r = await pb.postalBackfillTick(50, deps);
        const row = kOf("w-ok");
        assertEq(row.postal_code, "7011", "w1: a resolvable producer gets its postnummer written");
        assertEq(row.postal_code_source, "kartverket_adresse_sok",
          "w2: …tagged with HOW it was obtained, so it is distinguishable from a scraped value");
        assertEq(row.postal_backfill_outcome, "lookup_resolved", "w3: …with the outcome recorded for ops");
        assertTrue(!!row.postal_backfill_attempted_at, "w4: …and the attempt stamped");
        assertEq(row.postal_code_prev, null,
          "w5: postal_code_prev holds the (empty) previous value — the rollback latch, mirroring geocode_prev_lat");
        assertTrue(r.resolved >= 1 && r.resolved_lookup >= 1, `w6: the tick reports it (resolved=${r.resolved})`);

        // The whole point of the slice: the Fase-1a geocode worker must now be
        // able to reach Tier A on this row, and soon rather than after a full
        // rotation of ~1 500 producers.
        const agentRow = db.prepare(`SELECT geocode_attempted_at FROM agents WHERE id = 'w-ok'`).get() as any;
        assertEq(agentRow.geocode_attempted_at, null,
          "w7: …and the row is re-queued for the geocode worker (its selector puts never-attempted rows first)");

        // End to end: the geocode worker now picks it up and reaches 'address'.
        routes.set("Kongens gate 1 7011 Trondheim", body([addr("7011", "TRONDHEIM", "TRONDHEIM", "5001", "Kongens gate 1")]));
        const geoFetch = (async (input: any) => {
          const url = decodeURIComponent(String(input));
          const m = url.match(/[?&]sok=([^&]*)/);
          return {
            ok: true, status: 200,
            json: async () => routes.get((m ? m[1] : "").trim()) ?? EMPTY,
          } as unknown as Response;
        }) as unknown as typeof fetch;
        await geocodeWorker.agentsGeocodeTick(50, { fetchImpl: geoFetch, sleep: async () => {} });
        const placed = db.prepare(`SELECT lat, lng, geo_precision FROM agents WHERE id = 'w-ok'`).get() as any;
        assertEq(placed.geo_precision, "address",
          "w8: END TO END — the backfilled postnummer is what lets the Fase-1a worker reach 'address' precision");
        assertTrue(typeof placed.lat === "number", "w9: …with real coordinates, so the producer is finally visible in geo search");
      }

      // ── n1-n3: never overwrite an existing postnummer ────────────
      {
        seed({ id: "n-has", name: "Har Postnr", city: "Trondheim", address: "Kongens gate 1", postal_code: "9999" });
        const before = kOf("n-has");
        await pb.postalBackfillTick(50, deps);
        const after = kOf("n-has");
        assertEq(after.postal_code, "9999", "n1: a producer that already has a postnummer keeps it");
        assertEq(after.postal_backfill_attempted_at, before.postal_backfill_attempted_at,
          "n2: …and is not even selected — no wasted Kartverket call");

        // ── REVIEW B3 — n3 used to be a TAUTOLOGY ───────────────────
        // It executed a SQL literal the test itself had written, so deleting
        // the guard from the worker's real prepared statement left the suite at
        // 75/0. The guard has to be exercised through the WORKER, which means
        // producing the race it exists for: a row that was EMPTY at SELECT time
        // and gains a postnummer before the UPDATE lands (an owner editing their
        // own profile mid-tick — an ordinary event on a live platform).
        //
        // The write is injected from inside the fetch seam, which runs after
        // candidate selection and before this row's UPDATE.
        routes.set("Racegata 1 Trondheim", body([addr("7011", "TRONDHEIM", "TRONDHEIM", "5001", "Racegata 1")]));
        seed({ id: "n-race", name: "Kappløp Gård", city: "Trondheim", address: "Racegata 1" });
        let raceFired = false;
        const raceDeps = {
          sleep: async () => {},
          fetchImpl: (async (input: any) => {
            const url = decodeURIComponent(String(input));
            const m = url.match(/[?&]sok=([^&]*)/);
            const q = (m ? m[1] : "").trim();
            if (q.startsWith("Racegata 1") && !raceFired) {
              raceFired = true;
              // The owner saves their real postnummer, after we selected the row.
              db.prepare(`UPDATE agent_knowledge SET postal_code = '8888' WHERE agent_id = 'n-race'`).run();
            }
            return { ok: true, status: 200, json: async () => routes.get(q) ?? EMPTY } as unknown as Response;
          }) as unknown as typeof fetch,
        };
        await pb.postalBackfillTick(50, raceDeps);
        assertTrue(raceFired, "n3-setup: the concurrent-edit race actually fired");
        const raced = kOf("n-race");
        assertEq(raced.postal_code, "8888",
          "n3: an owner's postnummer that lands mid-tick is NOT clobbered — the guard lives in the worker's own UPDATE, not just the selector");
        assertEq(raced.postal_code_source, null,
          "n3b: …and no Kartverket provenance is stamped onto a value Kartverket did not produce");
        assertTrue(!!raced.postal_backfill_attempted_at,
          "n3c: …while the attempt IS still stamped, so the row rotates out instead of being re-selected forever");
        assertEq(raced.postal_backfill_outcome, "skipped_existing",
          "n3d: …recorded under its own outcome, so a burst of them is visible to ops rather than looking like successes");
      }

      // ── s1-s4: ALWAYS STAMP, including on a THROWN error ─────────
      {
        // A refusal must stamp, or the selector re-picks the identical head of
        // the queue forever. Fase 1a took two review blockers for exactly this.
        seed({ id: "s-refuse", name: "Avvist Gård", city: "Ingenstedet", address: "Ingenveien 99" });
        await pb.postalBackfillTick(50, deps);
        const refused = kOf("s-refuse");
        assertEq(refused.postal_code, null, "s1: a refused row keeps an EMPTY postnummer — writing nothing is the correct fallback");
        assertTrue(!!refused.postal_backfill_attempted_at,
          "s2: …but its attempt IS stamped, so it rotates out instead of starving the queue behind it");

        // A genuine THROW from inside the per-row try. The fetch seam's own
        // errors are swallowed by probeKartverket() (a failed probe must never
        // be evidence FOR a postnummer), so — exactly as in the Fase-1a suite —
        // the throw is injected through deps.sleep, which is awaited inside the
        // try after every Kartverket request.
        seed({ id: "s-throw", name: "Kaster Gård", city: "Trondheim", address: "Kongens gate 1" });
        const throwingDeps = {
          fetchImpl,
          sleep: async () => { throw new Error("simulated per-row failure"); },
        };
        const t = await pb.postalBackfillTick(50, throwingDeps);
        const thrown = kOf("s-throw");
        assertTrue(t.errors >= 1, `s3: a throwing row is counted as an error (errors=${t.errors})`);
        assertTrue(!!thrown.postal_backfill_attempted_at,
          "s4: …and STILL stamped — the ALWAYS-STAMP invariant holds on the error path, which is where Fase 1a broke it");
        assertEq(thrown.postal_backfill_outcome, "error", "s4b: …with the outcome recorded as 'error'");
      }

      // ── s5: a transport failure is never evidence FOR a postnummer ──
      {
        seed({ id: "s-net", name: "Nett Gård", city: "Lillehammer", address: "Storgata 5" });
        failNextFetch = true;
        const res = await pb.resolvePostalCode("Storgata 5", "Lillehammer", deps).catch(() => null);
        failNextFetch = false;
        assertTrue(res !== null && res.status !== "resolved",
          `s5: a throwing fetch resolves to a refusal, never to a written postnummer (got ${JSON.stringify(res)})`);
      }

      // ── r1-r3: rotation across ticks ─────────────────────────────
      {
        // Six fresh candidates that all REFUSE, so nothing leaves the queue by
        // being resolved — rotation must come from the attempt stamp alone.
        for (let i = 1; i <= 6; i++) {
          seed({ id: `r-${i}`, name: `Rotasjon ${i}`, city: "Ingenstedet", address: "Ingenveien 1" });
        }
        const b1 = await pb.postalBackfillTick(2, deps);
        const ids1 = b1.planned.map((p) => p.agent_id).filter((id) => id.startsWith("r-"));
        const b2 = await pb.postalBackfillTick(2, deps);
        const ids2 = b2.planned.map((p) => p.agent_id).filter((id) => id.startsWith("r-"));
        assertEq(ids1.length, 2, `r1: the first batch honours the limit (${JSON.stringify(ids1)})`);
        assertTrue(ids2.length === 2 && ids2.every((id) => !ids1.includes(id)),
          `r2: consecutive batches are DISJOINT — the worker rotates instead of re-picking the queue head (${JSON.stringify(ids1)} vs ${JSON.stringify(ids2)})`);
        const stamps = new Set((db.prepare(
          `SELECT postal_backfill_attempted_at AS s FROM agent_knowledge
            WHERE agent_id LIKE 'r-%' AND postal_backfill_attempted_at IS NOT NULL`
        ).all() as any[]).map((x) => x.s));
        assertEq(stamps.size, 4,
          "r3: every attempted row got a DISTINCT stamp (1-second granularity would collapse them and break rotation)");
      }

      // ── d1-d5: dry run reports everything, writes nothing ────────
      {
        // REVIEW B3: `geocode_attempted_at` MUST be seeded non-null. It used to
        // be NULL, so "the dry run did not re-queue this row" was asserting that
        // setting NULL to NULL changed nothing — making requeueGeocode run
        // during a dry run left the suite at 75/0. With a real stamp here, a
        // dry-run re-queue is a visible mutation.
        seed({ id: "d-1", name: "Tørrkjøring Gård", city: "Trondheim", address: "Kongens gate 1",
               geocode_attempted_at: "2026-07-02T00:00:00.000Z" });
        const snapshotSql =
          `SELECT agent_id, postal_code, postal_code_prev, postal_code_source,
                  postal_backfill_outcome, postal_backfill_attempted_at
             FROM agent_knowledge ORDER BY agent_id`;
        const before = JSON.stringify(db.prepare(snapshotSql).all());
        const beforeAgents = JSON.stringify(
          db.prepare(`SELECT id, geocode_attempted_at FROM agents ORDER BY id`).all()
        );

        const dry = await pb.postalBackfillTick(50, { ...deps, dryRun: true });

        assertTrue(dry.dry_run === true, "d1: the result is flagged as a dry run");
        const plan = dry.planned.find((p) => p.agent_id === "d-1");
        assertEq(plan?.postal_code, "7011", "d2: …and still reports the postnummer it WOULD write");
        assertTrue(dry.planned.some((p) => p.outcome !== "lookup_resolved" && p.outcome !== "inline_confirmed"),
          "d3: …including the REFUSALS, which for a conservative matcher are the interesting half");
        // assertTrue rather than assertEq: these snapshots are the whole table
        // and dumping both sides into the label makes the suite log unreadable.
        assertTrue(JSON.stringify(db.prepare(snapshotSql).all()) === before,
          "d4: agent_knowledge is BYTE-IDENTICAL after a dry run — not even the attempt timestamp is written");
        assertTrue(JSON.stringify(db.prepare(`SELECT id, geocode_attempted_at FROM agents ORDER BY id`).all()) === beforeAgents,
          "d4b: …and the geocode re-queue is not performed either");

        await pb.postalBackfillTick(50, deps);
        assertEq(kOf("d-1").postal_code, "7011",
          "d5: a real run afterwards still applies what the dry run predicted (the dry run did not consume it)");
      }

      // ── b1-b6: strict dry_run + the limit clamp ──────────────────
      // Shared verbatim with the Fase-1a worker: `{"dry_run":"true"}` performed
      // a REAL production write once (review B4). Re-asserted here because the
      // postal endpoint is the second consumer of that decision.
      {
        assertEq(geocodeWorker.parseDryRunFlag("true").ok, false,
          "b1: the STRING \"true\" is REJECTED by the shared parser, not treated as a real write");
        assertEq(geocodeWorker.parseDryRunFlag("false").ok, false, "b2: the string \"false\" is rejected too — no guessing");
        assertEq(geocodeWorker.parseDryRunFlag(1).ok, false, "b3: 1 is rejected");
        assertTrue(geocodeWorker.parseDryRunFlag(true).ok && (geocodeWorker.parseDryRunFlag(true) as any).dryRun === true,
          "b4: a real boolean true is honoured");
        assertEq(geocodeWorker.clampGeocodeBatchLimit(5000), 200, "b5: an oversized limit clamps to 200");
        assertEq(geocodeWorker.clampGeocodeBatchLimit(-7), 1, "b6: a negative limit clamps up to 1");
      }

      // ── f1-f3: single-flight ─────────────────────────────────────
      {
        seed({ id: "sf-1", name: "Samtidig Gård", city: "Trondheim", address: "Kongens gate 1" });
        let release: () => void = () => {};
        const gate = new Promise<void>((r) => { release = r; });
        const gatedDeps = {
          sleep: async () => {},
          fetchImpl: (async (input: any) => {
            await gate;
            const url = decodeURIComponent(String(input));
            const m = url.match(/[?&]sok=([^&]*)/);
            return { ok: true, status: 200, json: async () => routes.get((m ? m[1] : "").trim()) ?? EMPTY } as unknown as Response;
          }) as unknown as typeof fetch,
        };

        const first = pb.postalBackfillTick(50, gatedDeps);
        // Let the first tick reach its awaited fetch. Microtasks only: a real
        // timer would yield the macrotask queue and let a concurrently
        // scheduled suite swap the getDb() singleton out from under this one
        // (the documented failure mode in agents-geocode-worker.test.ts).
        for (let i = 0; i < 5; i++) await Promise.resolve();
        const second = await pb.postalBackfillTick(50, gatedDeps);
        release();
        const firstResult = await first;

        assertTrue(second.skipped_already_running === true,
          "f1: a tick started while another is running no-ops instead of selecting the same batch again");
        assertEq(second.processed, 0, "f2: …and processes nothing");
        assertTrue(firstResult.skipped_already_running === false,
          "f3: …while the tick that actually holds the lock runs normally");
      }

      // ── q1: the ops queue counter ────────────────────────────────
      {
        const status = pb.postalBackfillQueueStatus();
        assertTrue(status.with_address > 0 && status.backfilled > 0,
          `q1: the queue status reports real counts for ops (${JSON.stringify(status)})`);
      }
    } catch (err: any) {
      failed++;
      failures.push("agents-postal-backfill: unexpected error: " + String(err?.stack || err?.message || err));
    } finally {
      initMod.__setDbForTesting(prevDb as any);
      try { db.close(); } catch { /* already closed */ }
    }

    return { passed, failed, failures };
  })();
}

// Standalone runner
if (require.main === module) {
  runAgentsPostalBackfillTests({ log: true }).then((s) => {
    console.log(`\n${s.passed} passed, ${s.failed} failed`);
    process.exit(s.failed > 0 ? 1 : 0);
  });
}
