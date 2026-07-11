/**
 * experience-dedup-audit.test.ts — dev-request 2026-07-11-dedup-false-positive-
 * remediation: audit + un-merge of the prod dedup backfill's merged groups.
 *
 * The shipped titlesMatch() treats ONE shared significant token as sufficient
 * evidence, which merged genuinely different experiences ("Fjelltur til
 * Galdhøpiggen" vs "Fjelltur til Snøhetta"). These tests pin:
 *   1. classifyMergedPair(): the four confirmed false-positive shapes MUST
 *      classify 'generic-token-only'; the confirmed-true Kon-Tiki/Heyerdahl
 *      merge MUST classify 'rare-token'; near-identical wording MUST classify
 *      'whole-string'.
 *   2. buildCorpusTokenCounts(): distinct-title counting + stopword exclusion.
 *      buildProviderCorpusTokenCounts() (audit v2): distinct-PROVIDER counting
 *      — a token counts once per provider however many clone titles that
 *      provider has, and NULL-provider rows count as their own singleton
 *      pseudo-providers.
 *   3. auditMergedGroups() transitivity: a row weakly linked to its canonical
 *      but whole-string-linked to a sibling merged row is NOT suspect (merges
 *      were transitive union-find). PLUS the audit-v2 inflation regression pin
 *      from the prod run (859/1361 rows over-flagged): ONE provider with 16
 *      harvest-clone "Kon-Tiki ..." titles must NOT make kontiki/heyerdahl
 *      look corpus-common — under v1's title-distinct counting kontiki hit 16
 *      >= genericMin and the confirmed-TRUE Kon-Tiki group came back suspect;
 *      under provider-distinct counting it counts as 1 → rare → trusted.
 *   4. POST /admin/experiences-dedup-unmerge: dry_run defaults TRUE and writes
 *      nothing; empty ids → 400; real run clears exactly the listed rows,
 *      updates the canonical's merged_from, leaves unlisted siblings alone,
 *      makes the row visible again through the PUBLISH_GATE-gated discover
 *      path, and is idempotent (second run reports skipped).
 *   5. GET /admin/experiences-dedup-audit: flags exactly the known-false
 *      merged group, not the known-true one.
 *   6. resolveCanonicalSlugForDuplicate(): multi-hop chain A→B→C resolves to
 *      C's slug; cycle A→B→A returns null; single-hop unchanged.
 *
 * Run standalone: npx tsx src/services/experience-dedup-audit.test.ts
 * Wired into the gate via tests/test.ts inside the oa-home-counters gated
 * block (same in-memory-DB pattern as experience-dedup.test.ts — see that
 * file for the precedent this follows).
 */

import type Database from "better-sqlite3";
import {
  classifyMergedPair,
  buildCorpusTokenCounts,
  buildProviderCorpusTokenCounts,
} from "./experience-dedup-audit";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

/** Invoke the real opplevelser router without an HTTP server — same mock
 *  req/res pattern as opplevelser-discover-tags.test.ts's callRoute(), plus
 *  method/headers/body so the requireAdmin-gated POST endpoints work. */
function callRoute(
  router: any,
  method: string,
  url: string,
  opts: { headers?: Record<string, string>; body?: unknown } = {}
): Promise<{ handled: boolean; status: number; body: any }> {
  return new Promise((resolve) => {
    let statusCode = 200;
    const req: any = {
      method,
      url,
      originalUrl: url,
      path: url.split("?")[0],
      query: Object.fromEntries(new URLSearchParams(url.split("?")[1] || "")),
      headers: opts.headers ?? {},
      body: opts.body,
      get() { return undefined; },
    };
    const res: any = {
      statusCode: 200,
      status(code: number) {
        statusCode = code;
        this.statusCode = code;
        return this;
      },
      json(body: any) {
        resolve({ handled: true, status: statusCode, body });
        return this;
      },
    };
    router.handle(req, res, (err?: any) => {
      resolve({ handled: false, status: statusCode, body: err ? String(err) : null });
    });
  });
}

export function runExperienceDedupAuditTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
    if (cond) {
      passed++;
      if (log) console.log(`  ok ${label}`);
    } else {
      failed++;
      failures.push(`✗ ${label}`);
      if (log) console.log(`  ✗ ${label}`);
    }
  }

  return (async () => {
    // ── 1. classifyMergedPair: pinned false positives → 'generic-token-only' ──
    // Corpus where the broad activity tokens are common (>= genericMin
    // distinct titles) but the specific-place/audience tokens are rare.
    const commonCorpus = new Map<string, number>([
      ["fjelltur", 12],
      ["brevandring", 9],
      ["rafting", 8],
      ["klatring", 11],
      ["galdhopiggen", 2],
      ["snohetta", 1],
      ["nigardsbreen", 2],
      ["briksdalsbreen", 2],
      ["sjoa", 1], // rare in the corpus, but only 4 chars — must NOT count as a rare-token link
      ["dagstur", 3],
      ["kveldstur", 2],
      ["barn", 4],
      ["voksne", 3],
    ]);

    const fjell = classifyMergedPair("Fjelltur til Galdhøpiggen", "Fjelltur til Snøhetta", commonCorpus);
    assertEq(fjell.via, "generic-token-only", "1a: Galdhøpiggen vs Snøhetta — only the common 'fjelltur' links them");
    assertTrue(
      fjell.sharedTokens.some((t) => t.token === "fjelltur" && t.corpusCount === 12),
      "1b: sharedTokens carries the shared token with its corpus count"
    );
    assertTrue(fjell.levSim < 0.6, "1c: Galdhøpiggen/Snøhetta wording is not whole-string close");

    const brev = classifyMergedPair("Brevandring på Nigardsbreen", "Brevandring på Briksdalsbreen", commonCorpus);
    assertEq(brev.via, "generic-token-only", "1d: Nigardsbreen vs Briksdalsbreen — different glaciers, common 'brevandring'");

    // 'sjoa' is only 4 chars post-normalization (< SIGNIFICANT_TOKEN_MIN_LEN 5),
    // so even at corpusCount 1 it must never count as a rare-token link — the
    // only significant shared token is the common 'rafting'.
    const sjoa = classifyMergedPair("Rafting i Sjoa - dagstur", "Rafting i Sjoa - kveldstur", commonCorpus);
    assertEq(sjoa.via, "generic-token-only", "1e: Sjoa dagstur vs kveldstur — 'sjoa' too short to be significant, 'rafting' common");
    assertTrue(
      sjoa.sharedTokens.some((t) => t.token === "sjoa"),
      "1f: 'sjoa' still reported among sharedTokens (diagnostic), just not classification evidence"
    );

    const klatring = classifyMergedPair("Klatring for barn", "Klatring for voksne", commonCorpus);
    assertEq(klatring.via, "generic-token-only", "1g: Klatring for barn vs voksne — different audiences, common 'klatring'");

    // ── classifyMergedPair: confirmed-true merge → 'rare-token' (NOT suspect) ──
    const rareCorpus = new Map<string, number>([
      ["kontiki", 2],
      ["heyerdahl", 2],
      ["museum", 40], // stopword — never tokenized, present here only as noise
      ["oslo", 50],
      ["fjelltur", 12],
    ]);
    const kontiki = classifyMergedPair(
      "Kon-Tiki Museet — Heyerdahl's Legendary Pacific Raft",
      "Thor Heyerdahl Expedition Museum at Bygdøy Oslo",
      rareCorpus
    );
    assertEq(kontiki.via, "rare-token", "1h: Kon-Tiki/Heyerdahl — rare distinctive shared token → trustworthy link");
    assertTrue(
      kontiki.sharedTokens.some((t) => t.token === "heyerdahl" && t.corpusCount === 2),
      "1i: the rare linking token is 'heyerdahl' with its corpus count"
    );

    // ── classifyMergedPair: near-identical wording → 'whole-string' ──
    const kok = classifyMergedPair("KOK Oslo Food Tour", "KOK Oslo Food Tur", new Map());
    assertEq(kok.via, "whole-string", "1j: near-identical re-harvest wording (typo-level) → whole-string");
    assertTrue(kok.levSim > 0.9, "1k: whole-string pair reports a high levSim");

    const identical = classifyMergedPair("Fjelltur til Galdhøpiggen", "Fjelltur til Galdhøpiggen", commonCorpus);
    assertEq(identical.via, "whole-string", "1l: identical titles → whole-string");
    assertEq(identical.levSim, 1, "1m: identical titles → levSim exactly 1");

    // ── classifyMergedPair: nothing shared, nothing close → 'no-signal' ──
    const none = classifyMergedPair("Fisketur på Oslofjorden", "Bakekurs med surdeig", new Map());
    assertEq(none.via, "no-signal", "1n: no shared token + low similarity → no-signal (defensive)");
    assertEq(none.sharedTokens, [], "1o: no-signal pair reports zero shared tokens");

    // genericMin is honored: with a high genericMin, 'fjelltur' (12) counts as rare.
    const relaxed = classifyMergedPair("Fjelltur til Galdhøpiggen", "Fjelltur til Snøhetta", commonCorpus, {
      genericMin: 20,
    });
    assertEq(relaxed.via, "rare-token", "1p: genericMin option shifts the rare/generic boundary");

    // ── 2. buildCorpusTokenCounts: distinct-title counts, stopwords excluded ──
    const counts = buildCorpusTokenCounts([
      "Fjelltur til Galdhøpiggen",
      "Fjelltur fjelltur FJELLTUR", // repeats within one title count ONCE
      "Museum og museet på tur", // all stopwords/short → contributes nothing
      "Brevandring på Nigardsbreen",
    ]);
    assertEq(counts.get("fjelltur"), 2, "2a: token counted once per title (2 titles, not 4 occurrences)");
    assertEq(counts.get("galdhopiggen"), 1, "2b: normalized/diacritics-folded token counted");
    assertEq(counts.get("museum"), undefined, "2c: stopword 'museum' never counted");
    assertEq(counts.get("museet"), undefined, "2d: stopword 'museet' never counted");
    assertEq(counts.get("til"), undefined, "2e: stopword 'til' never counted");
    assertEq(counts.get("brevandring"), 1, "2f: ordinary distinctive token counted");

    // ── 2 (audit v2). buildProviderCorpusTokenCounts: distinct-PROVIDER counts ──
    // The prod audit over-flagged because title-distinct counting is inflated
    // by the duplicates themselves: 16 harvest clones of ONE museum made
    // "kontiki" look like a corpus-common word. Provider-distinct counting is
    // immune — however many clone titles a provider has, its tokens count once.
    const provCounts = buildProviderCorpusTokenCounts([
      { title: "Fjelltur til Besseggen", provider_id: "p1" },
      { title: "Fjelltur til Galdhøpiggen", provider_id: "p1" }, // same provider — counts ONCE with the row above
      { title: "Fjelltur til Snøhetta", provider_id: "p2" },
      { title: "Fjelltur uten tilbyder", provider_id: null }, // orphan row → its own singleton pseudo-provider
      { title: "Fjelltur tilbyder mangler", provider_id: null }, // second orphan → a SEPARATE singleton
      { title: "Museum og museet på tur", provider_id: "p3" }, // stopwords only → contributes nothing
    ]);
    assertEq(provCounts.get("fjelltur"), 4, "2g: distinct providers — p1 once (despite 2 titles) + p2 + 2 orphan singletons = 4");
    assertEq(provCounts.get("besseggen"), 1, "2h: token unique to one provider counts 1");
    assertEq(provCounts.get("tilbyder"), 2, "2i: null-provider rows do NOT collapse into one bucket — each counts separately");
    assertEq(provCounts.get("museum"), undefined, "2j: stopword 'museum' never counted");
    assertEq(provCounts.get("til"), undefined, "2k: stopword 'til' never counted");
    assertEq(provCounts.get("galdhopiggen"), 1, "2l: normalized/diacritics-folded token counted per provider");

    // ── 3–6. DB-backed: auditMergedGroups + admin endpoints + slug redirect ──
    const prevExperiencesDbPath = process.env.EXPERIENCES_DB_PATH;
    const prevAdminKey = process.env.ADMIN_KEY;
    process.env.EXPERIENCES_DB_PATH = ":memory:";

    const dbFactoryPath = require.resolve("../database/db-factory");
    const expStorePath = require.resolve("./experience-store");
    const expDedupPath = require.resolve("./experience-dedup");
    const expAuditPath = require.resolve("./experience-dedup-audit");
    const opplevelserPath = require.resolve("../routes/opplevelser");
    const cachePaths = [dbFactoryPath, expStorePath, expDedupPath, expAuditPath, opplevelserPath];
    for (const p of cachePaths) delete require.cache[p];

    try {
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const expStore = require("./experience-store") as typeof import("./experience-store");
      const audit = require("./experience-dedup-audit") as typeof import("./experience-dedup-audit");
      const opplevelserRouter = (require("../routes/opplevelser") as { default: any }).default;
      const db: Database.Database = dbFactory.getDb("experiences");

      const ADMIN_KEY = "dedup-audit-test-admin-key";
      process.env.ADMIN_KEY = ADMIN_KEY;
      const adminHeaders = { "x-admin-key": ADMIN_KEY };

      function makeProvider(navn: string): string {
        return expStore.createProvider({
          navn,
          kommune: "Oslo",
          fylke: "Oslo",
          brreg_verified: 1,
          brreg_active: 1,
          verification_status: "verified",
        });
      }
      const providerId = makeProvider("Norsk Natur AS");

      // All rows publishable (verified + high confidence + brreg-active
      // provider) so PUBLISH_GATE_SQL visibility is decided by canonical_id.
      function seedFor(provId: string, title: string): string {
        return expStore.createExperience({
          title,
          provider_id: provId,
          kommune: "Oslo",
          fylke: "Oslo",
          verification_status: "verified",
          confidence: "high",
        });
      }
      const seed = (title: string): string => seedFor(providerId, title);
      const canonicalIdOf = (id: string): string | null =>
        (db.prepare("SELECT canonical_id FROM experiences WHERE id = ?").get(id) as
          | { canonical_id: string | null }
          | undefined)?.canonical_id ?? null;
      const mergedFromOf = (id: string): string | null =>
        (db.prepare("SELECT merged_from FROM experiences WHERE id = ?").get(id) as
          | { merged_from: string | null }
          | undefined)?.merged_from ?? null;
      // Mirror runDedupPass()'s write format exactly: canonical_id on the
      // merged-away rows, merged_from = JSON array of ids on the canonical.
      function mergeInto(canonicalId: string, mergedIds: string[]): void {
        for (const id of mergedIds) {
          db.prepare("UPDATE experiences SET canonical_id = ?, updated_at = datetime('now') WHERE id = ?").run(
            canonicalId,
            id
          );
        }
        db.prepare("UPDATE experiences SET merged_from = ?, updated_at = datetime('now') WHERE id = ?").run(
          JSON.stringify(mergedIds),
          canonicalId
        );
      }

      // Corpus filler (unmerged) so the broad activity tokens are common.
      // FIXTURE ADJUSTMENT (audit v2): each filler row gets its OWN provider
      // — the audit now counts a token once per DISTINCT provider, so
      // "fjelltur"/"brevandring" only stay generic (count >= genericMin 5) if
      // they genuinely span many providers, exactly like the prod corpus
      // (rafting spans 30+ providers; one museum's 16 clone titles don't).
      let fillerSeq = 0;
      for (const t of [
        "Fjelltur til Besseggen",
        "Fjelltur til Preikestolen",
        "Fjelltur til Romsdalseggen",
        "Fjelltur til Trolltunga",
        "Fjelltur til Gaustatoppen",
        "Brevandring på Bøyabreen",
        "Brevandring på Haugabreen",
        "Brevandring på Austerdalsbreen",
        "Brevandring på Buerbreen",
        "Brevandring på Folgefonna",
      ]) {
        seedFor(makeProvider(`Fillertilbyder ${++fillerSeq} AS`), t);
      }

      // FALSE-POSITIVE group: two different mountains merged on 'fjelltur'.
      // 'fjelltur' spans 6 distinct providers (5 fillers + this one) → generic.
      const idFjellCanonical = seed("Fjelltur til Galdhøpiggen");
      const idFjellSuspect = seed("Fjelltur til Snøhetta");
      mergeInto(idFjellCanonical, [idFjellSuspect]);

      // TRUE group + the audit-v2 INFLATION REGRESSION PIN: ONE provider with
      // 16 harvest-clone titles of the same real museum (the confirmed prod
      // shape — Kon-Tiki Museet had 16 clones). Under v1's title-distinct
      // counting these clones inflated kontiki to 16 >= genericMin, so the
      // group's own proper noun looked "generic" and the TRUE merges came
      // back suspect (859/1361 over-flagged in prod). Provider-distinct
      // counting sees ONE provider → kontiki/heyerdahl stay rare → trusted.
      const kontikiProviderId = makeProvider("Kon-Tiki Museet AS");
      const idKontikiCanonical = seedFor(
        kontikiProviderId,
        "Kon-Tiki Museet — Heyerdahl's Legendary Pacific Raft"
      );
      const kontikiCloneTitles = [
        "Thor Heyerdahl Expedition Museum at Bygdøy Oslo",
        "Kon-Tiki Museum Oslo — Official Site",
        "Besøk Kon-Tiki Museet på Bygdøy",
        "The Kon-Tiki Museum — Thor Heyerdahl's Raft Expeditions",
        "Kon-Tiki Museet billetter og åpningstider",
        "Kon-Tiki Museum tickets Oslo",
        "Opplev Kon-Tiki Museet i Oslo",
        "Kon-Tiki Museum guided visit Bygdøy",
        "Heyerdahl's Kon-Tiki raft museum",
        "Kon-Tiki — the raft expedition museum",
        "Thor Heyerdahl museum på Bygdøy",
        "Kon-Tiki Museet familieutflukt",
        "Kon-Tiki Museum — Pacific voyage exhibition",
        "Museum for Kon-Tiki ekspedisjonen",
        "Kon-Tiki ekspedisjonsmuseum Bygdøy",
      ];
      const kontikiCloneIds = kontikiCloneTitles.map((t) => seedFor(kontikiProviderId, t));
      const idKontikiMerged = kontikiCloneIds[0]; // "Thor Heyerdahl Expedition Museum at Bygdøy Oslo"
      const idKontikiPinClone = kontikiCloneIds[2]; // "Besøk Kon-Tiki Museet på Bygdøy" — shares ONLY 'kontiki' with the canonical
      mergeInto(idKontikiCanonical, kontikiCloneIds);

      // TRANSITIVITY group: X links to the canonical only via the common
      // 'brevandring', but is whole-string-identical (one-char typo) to its
      // sibling Y — union-find merged it via Y, so X must NOT be suspect.
      const idBrevCanonical = seed("Brevandring på Nigardsbreen med guide");
      const idBrevSiblingY = seed("Brevandring på Nigardsbreen"); // rare-token to canonical ('nigardsbreen')
      const idBrevRowX = seed("Brevandring på Nigardsbren"); // typo: 'nigardsbren' ≠ 'nigardsbreen'
      mergeInto(idBrevCanonical, [idBrevSiblingY, idBrevRowX]);

      // ── 3. auditMergedGroups: classification + transitivity + v2 inflation pin ──
      const auditResult = audit.auditMergedGroups(db);
      assertEq(auditResult.summary.groups_total, 3, "3a: three merged groups audited");
      assertEq(auditResult.summary.rows_total, 18, "3b: 18 merged-away rows audited (1 fjell + 15 kontiki clones + 2 brev)");
      assertEq(auditResult.summary.rows_suspect, 1, "3c: exactly one suspect row (Snøhetta)");
      assertEq(auditResult.summary.groups_with_suspects, 1, "3d: exactly one group carries a suspect");

      const fjellGroup = auditResult.groups.find((g) => g.canonical_id === idFjellCanonical);
      const suspectRow = fjellGroup?.rows.find((r) => r.id === idFjellSuspect);
      assertEq(suspectRow?.suspect, true, "3e: the Snøhetta row is flagged suspect");
      assertEq(suspectRow?.best_via, "generic-token-only", "3f: its best link is generic-token-only");

      const kontikiGroup = auditResult.groups.find((g) => g.canonical_id === idKontikiCanonical);
      const kontikiRow = kontikiGroup?.rows.find((r) => r.id === idKontikiMerged);
      assertEq(kontikiRow?.suspect, false, "3g: the true Heyerdahl merge is NOT suspect");
      assertEq(kontikiRow?.best_via, "rare-token", "3h: its best link is rare-token");

      // Inflation regression pin (the prod defect that motivated audit v2):
      assertEq(kontikiGroup?.rows.length, 15, "3h1: all 15 kontiki clones audited in the group");
      assertTrue(
        kontikiGroup !== undefined && kontikiGroup.rows.every((r) => !r.suspect),
        "3h2: NO kontiki clone is suspect — one provider's 16 clone titles must not inflate its own tokens to 'generic'"
      );
      // Prove the two counting modes diverge on exactly this corpus: pull
      // every title + provider from the DB and count both ways.
      const corpusRows = db
        .prepare("SELECT title, provider_id FROM experiences")
        .all() as Array<{ title: string; provider_id: string | null }>;
      const v1Counts = buildCorpusTokenCounts(corpusRows.map((r) => r.title));
      const v2Counts = buildProviderCorpusTokenCounts(corpusRows);
      assertEq(v1Counts.get("kontiki"), 14, "3h3: title-distinct counting inflates 'kontiki' to 14 (>= genericMin 5 → v1 called it generic)");
      assertEq(v2Counts.get("kontiki"), 1, "3h4: provider-distinct counting sees 'kontiki' as ONE provider → rare");
      assertEq(v1Counts.get("heyerdahl"), 5, "3h5: title-distinct 'heyerdahl' also inflated to genericMin by the clones");
      assertEq(v2Counts.get("heyerdahl"), 1, "3h6: provider-distinct 'heyerdahl' → 1");
      assertEq(v2Counts.get("fjelltur"), 6, "3h7: genuinely generic 'fjelltur' still spans 6 distinct providers");
      // Pair-level discriminator: with the OLD title-distinct corpus this TRUE
      // pair classifies generic-token-only (v1's over-flagging); with the
      // provider-distinct corpus it classifies rare-token.
      const pinPair: [string, string] = ["Besøk Kon-Tiki Museet på Bygdøy", "Kon-Tiki Museet — Heyerdahl's Legendary Pacific Raft"];
      assertEq(
        classifyMergedPair(pinPair[0], pinPair[1], v1Counts).via,
        "generic-token-only",
        "3h8: v1 title-distinct corpus mis-grades the TRUE kontiki pair as generic-token-only (the prod regression)"
      );
      assertEq(
        classifyMergedPair(pinPair[0], pinPair[1], v2Counts).via,
        "rare-token",
        "3h9: v2 provider-distinct corpus grades the same pair rare-token (fixed)"
      );
      const pinCloneRow = kontikiGroup?.rows.find((r) => r.id === idKontikiPinClone);
      assertEq(pinCloneRow?.suspect, false, "3h10: the kontiki-only-linked clone is NOT suspect under the audit path");

      const brevGroup = auditResult.groups.find((g) => g.canonical_id === idBrevCanonical);
      const rowX = brevGroup?.rows.find((r) => r.id === idBrevRowX);
      assertEq(rowX?.suspect, false, "3i: transitivity — X is NOT suspect (whole-string link via sibling Y)");
      assertEq(rowX?.best_via, "whole-string", "3j: X's best link is whole-string");
      assertEq(rowX?.best_link_title, "Brevandring på Nigardsbreen", "3k: X's best link is the SIBLING, not the canonical");
      const rowY = brevGroup?.rows.find((r) => r.id === idBrevSiblingY);
      assertEq(rowY?.suspect, false, "3l: Y is NOT suspect (rare 'nigardsbreen' link to canonical)");

      // ── 5. GET /admin/experiences-dedup-audit ──
      {
        const noKey = await callRoute(opplevelserRouter, "GET", "/admin/experiences-dedup-audit");
        assertEq(noKey.status, 403, "5a: audit endpoint requires X-Admin-Key (403 without)");

        const r = await callRoute(opplevelserRouter, "GET", "/admin/experiences-dedup-audit", {
          headers: adminHeaders,
        });
        assertEq(r.status, 200, "5b: audit endpoint → 200 with admin key");
        assertEq(r.body.success, true, "5c: success: true");
        assertEq(r.body.summary.rows_suspect, 1, "5d: summary counts the one suspect row");
        assertEq(r.body.groups.length, 1, "5e: response carries ONLY the group(s) with suspects");
        assertEq(r.body.groups[0].canonical_id, idFjellCanonical, "5f: the flagged group is the false-positive fjelltur group");
        assertTrue(
          r.body.groups[0].rows.some((row: any) => row.id === idFjellSuspect && row.suspect === true),
          "5g: the Snøhetta row is flagged inside the returned group"
        );
        assertTrue(
          !r.body.groups.some((g: any) => g.canonical_id === idKontikiCanonical),
          "5h: the known-true Kon-Tiki group is NOT in the response"
        );

        // Read-only: zero writes — every canonical_id is exactly as seeded.
        assertEq(canonicalIdOf(idFjellSuspect), idFjellCanonical, "5i: audit made zero writes (suspect row unchanged)");

        // generic_min is honored: at generic_min=20 even 'fjelltur' (6 distinct
        // providers here) counts as rare → nothing is suspect.
        const relaxedR = await callRoute(
          opplevelserRouter,
          "GET",
          "/admin/experiences-dedup-audit?generic_min=20",
          { headers: adminHeaders }
        );
        assertEq(relaxedR.status, 200, "5j: generic_min override → 200");
        assertEq(relaxedR.body.summary.rows_suspect, 0, "5k: generic_min=20 → no token is 'generic' → zero suspects");
      }

      // ── 4. POST /admin/experiences-dedup-unmerge ──
      {
        const noKey = await callRoute(opplevelserRouter, "POST", "/admin/experiences-dedup-unmerge", {
          body: { ids: [idFjellSuspect] },
        });
        assertEq(noKey.status, 403, "4a: un-merge endpoint requires X-Admin-Key (403 without)");

        const emptyIds = await callRoute(opplevelserRouter, "POST", "/admin/experiences-dedup-unmerge", {
          headers: adminHeaders,
          body: { ids: [] },
        });
        assertEq(emptyIds.status, 400, "4b: empty ids → 400");
        const missingIds = await callRoute(opplevelserRouter, "POST", "/admin/experiences-dedup-unmerge", {
          headers: adminHeaders,
          body: {},
        });
        assertEq(missingIds.status, 400, "4c: missing ids → 400");

        // dry_run DEFAULTS TO TRUE when absent — and mutates NOTHING.
        const dry = await callRoute(opplevelserRouter, "POST", "/admin/experiences-dedup-unmerge", {
          headers: adminHeaders,
          body: { ids: [idFjellSuspect] },
        });
        assertEq(dry.status, 200, "4d: dry run → 200");
        assertEq(dry.body.dry_run, true, "4e: dry_run defaults to TRUE when absent");
        assertEq(dry.body.would_unmerge, [idFjellSuspect], "4f: dry run reports what WOULD be un-merged");
        assertEq(canonicalIdOf(idFjellSuspect), idFjellCanonical, "4g: dry run wrote NOTHING (canonical_id unchanged)");
        assertEq(mergedFromOf(idFjellCanonical), JSON.stringify([idFjellSuspect]), "4h: dry run wrote NOTHING (merged_from unchanged)");

        // STRICT-FALSE parse (review blocker, round 2): writes execute ONLY on
        // the JSON boolean false. null (how many JSON clients serialize an
        // UNSET optional boolean), the string "false", and 0 must all mean
        // dry run — never live un-merges.
        for (const [label, val] of [["null", null], ["string-false", "false"], ["zero", 0]] as const) {
          const strict = await callRoute(opplevelserRouter, "POST", "/admin/experiences-dedup-unmerge", {
            headers: adminHeaders,
            body: { ids: [idFjellSuspect], dry_run: val },
          });
          assertEq(strict.status, 200, `4h-strict(${label}): → 200`);
          assertEq(strict.body.dry_run, true, `4h-strict(${label}): dry_run ${label} → treated as DRY RUN`);
          assertEq(
            canonicalIdOf(idFjellSuspect),
            idFjellCanonical,
            `4h-strict(${label}): wrote NOTHING (canonical_id unchanged)`
          );
        }

        // Before the real run: the merged row is invisible through the
        // PUBLISH_GATE-gated discover path.
        const before = expStore.discoverExperiences({ fylke: "Oslo" }, 100);
        assertTrue(!before.some((row) => row.id === idFjellSuspect), "4i: pre-un-merge, the merged row is NOT in discover");

        // Real run: clears exactly the listed row + updates canonical's merged_from.
        const real = await callRoute(opplevelserRouter, "POST", "/admin/experiences-dedup-unmerge", {
          headers: adminHeaders,
          body: { ids: [idFjellSuspect], dry_run: false },
        });
        assertEq(real.status, 200, "4j: real run → 200");
        assertEq(real.body.dry_run, false, "4k: real run echoes dry_run: false");
        assertEq(real.body.unmerged, [idFjellSuspect], "4l: real run reports the un-merged id");
        assertEq(real.body.skipped, [], "4m: nothing skipped on the first real run");
        assertEq(canonicalIdOf(idFjellSuspect), null, "4n: canonical_id cleared on the listed row");
        assertEq(mergedFromOf(idFjellCanonical), null, "4o: canonical's merged_from emptied → set NULL");

        // Un-merged row is visible again through the gated discover path.
        const after = expStore.discoverExperiences({ fylke: "Oslo" }, 100);
        assertTrue(after.some((row) => row.id === idFjellSuspect), "4p: post-un-merge, the row IS in discover again");

        // Unlisted rows in another group are untouched.
        assertEq(canonicalIdOf(idKontikiMerged), idKontikiCanonical, "4q: unlisted merged rows untouched");

        // Partial un-merge of a multi-row group: only the listed sibling is
        // cleared; the canonical's merged_from keeps the remaining id.
        const partial = await callRoute(opplevelserRouter, "POST", "/admin/experiences-dedup-unmerge", {
          headers: adminHeaders,
          body: { ids: [idBrevRowX], dry_run: false },
        });
        assertEq(partial.status, 200, "4r: partial un-merge → 200");
        assertEq(canonicalIdOf(idBrevRowX), null, "4s: listed sibling cleared");
        assertEq(canonicalIdOf(idBrevSiblingY), idBrevCanonical, "4t: UNLISTED sibling in the same group untouched");
        assertEq(mergedFromOf(idBrevCanonical), JSON.stringify([idBrevSiblingY]), "4u: merged_from keeps only the remaining id");

        // Idempotent: identical real run again → everything skipped.
        const again = await callRoute(opplevelserRouter, "POST", "/admin/experiences-dedup-unmerge", {
          headers: adminHeaders,
          body: { ids: [idFjellSuspect], dry_run: false },
        });
        assertEq(again.status, 200, "4v: second identical real run → 200 (idempotent, no error)");
        assertEq(again.body.unmerged, [], "4w: second run un-merges nothing");
        assertEq(again.body.skipped, [{ id: idFjellSuspect, reason: "not_merged" }], "4x: second run reports the row as skipped");

        // Unknown id → skipped (not an error).
        const unknown = await callRoute(opplevelserRouter, "POST", "/admin/experiences-dedup-unmerge", {
          headers: adminHeaders,
          body: { ids: ["no-such-id"], dry_run: false },
        });
        assertEq(unknown.status, 200, "4y: unknown id → 200, not an error");
        assertEq(unknown.body.skipped, [{ id: "no-such-id", reason: "not_found" }], "4z: unknown id reported as skipped/not_found");
      }

      // ── 6. resolveCanonicalSlugForDuplicate: chain walk + cycle guard ──
      {
        const slugOf = (id: string): string =>
          (db.prepare("SELECT slug FROM experiences WHERE id = ?").get(id) as { slug: string }).slug;
        const setCanonical = (id: string, canonicalId: string | null): void => {
          db.prepare("UPDATE experiences SET canonical_id = ? WHERE id = ?").run(canonicalId, id);
        };

        const idA = seed("Kajakkurs på Oslofjorden for nybegynnere");
        const idB = seed("Kajakkurs Oslofjorden nybegynnerkurs");
        const idC = seed("Kajakkurs i Oslofjorden — nybegynner");

        // Single-hop unchanged: A→B (B terminal).
        setCanonical(idA, idB);
        assertEq(expStore.resolveCanonicalSlugForDuplicate(slugOf(idA)), slugOf(idB), "6a: single-hop A→B resolves to B's slug (unchanged behavior)");
        // 0-hop unchanged: a canonical row resolves to null.
        assertEq(expStore.resolveCanonicalSlugForDuplicate(slugOf(idB)), null, "6b: non-duplicate slug → null (unchanged behavior)");
        assertEq(expStore.resolveCanonicalSlugForDuplicate("no-such-slug"), null, "6c: unknown slug → null (unchanged behavior)");

        // Chain A→B→C resolves to the TERMINAL row's slug.
        setCanonical(idB, idC);
        assertEq(expStore.resolveCanonicalSlugForDuplicate(slugOf(idA)), slugOf(idC), "6d: chain A→B→C resolves slug(A) → slug(C)");
        assertEq(expStore.resolveCanonicalSlugForDuplicate(slugOf(idB)), slugOf(idC), "6e: mid-chain B also resolves to C");

        // Cycle A→B→A returns null instead of hanging.
        setCanonical(idB, idA);
        assertEq(expStore.resolveCanonicalSlugForDuplicate(slugOf(idA)), null, "6f: cycle A→B→A → null (visited-set guard)");
        // Self-cycle A→A also returns null.
        setCanonical(idB, null);
        setCanonical(idA, idA);
        assertEq(expStore.resolveCanonicalSlugForDuplicate(slugOf(idA)), null, "6g: self-cycle A→A → null");
      }
    } catch (err: any) {
      failed++;
      failures.push("experience-dedup-audit: unexpected error: " + String(err?.stack || err?.message || err));
    } finally {
      if (prevExperiencesDbPath === undefined) {
        delete process.env.EXPERIENCES_DB_PATH;
      } else {
        process.env.EXPERIENCES_DB_PATH = prevExperiencesDbPath;
      }
      if (prevAdminKey === undefined) {
        delete process.env.ADMIN_KEY;
      } else {
        process.env.ADMIN_KEY = prevAdminKey;
      }
      try {
        const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
        dbFactory.__resetDbFactoryForTesting();
      } catch {
        // best-effort cleanup
      }
      for (const p of cachePaths) delete require.cache[p];
    }

    return { passed, failed, failures };
  })();
}

if (require.main === module) {
  runExperienceDedupAuditTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    process.exit(summary.failed > 0 ? 1 : 0);
  });
}
