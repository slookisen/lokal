/**
 * opplevelser-gardssalg-experience-conflict-queue.test.ts — route-level
 * tests for dev-request 2026-08-07-dublett-evidensbasis-og-pool-
 * avblokkering, Skive 2 ("bekreftelseskø for navnetoken-kandidater"):
 *
 *   - GET  /admin/gardssalg-experience-conflict-queue    (pending queue)
 *   - POST /admin/gardssalg-experience-conflict-review    (confirm/reject)
 *
 * plus the wiring of a recorded verdict back into
 * computeGardssalgReadinessRows's has_duplicate_conflict /
 * name_token_conflict_candidate sets (routes/opplevelser.ts, ~L7390),
 * exercised end-to-end via GET /admin/gardssalg-outreach-readiness.
 *
 * Covers:
 *   (a) 403 without X-Admin-Key on both endpoints
 *   (b) GET .../gardssalg-experience-conflict-queue: pending name_token
 *       pairs are reported with both-sides data (producer name+hjemmeside,
 *       experience title+booking_url) + shared_tokens + match_basis/status;
 *       a provider_link pair never appears (slice 1 already blocks it on
 *       its own, it was never a candidate); an "agree"/"unknown" pair never
 *       appears (not a conflict of any kind)
 *   (c) the 14 pre-seeded (2026-08-01 spot-check) pairs are NOT in the
 *       initial pending GET response, and the confirmed one (Lervig)
 *       already counts as has_duplicate_conflict=true, and the rejected one
 *       (Lillehammer Bryggeri) counts as NEITHER has_duplicate_conflict NOR
 *       name_token_conflict_candidate — all BEFORE any admin call in this
 *       test run (i.e. straight off the schema-init seed)
 *   (d) POST .../gardssalg-experience-conflict-review confirm (apply=true):
 *       succeeds, the pair disappears from a subsequent GET, and
 *       has_duplicate_conflict flips true for that producer
 *   (e) POST .../gardssalg-experience-conflict-review reject (apply=true):
 *       succeeds, the pair disappears from a subsequent GET, and never
 *       blocks (has_duplicate_conflict stays false) nor lingers as a
 *       name_token_conflict_candidate
 *   (f) dry-run (apply omitted): reports what WOULD be decided, writes
 *       NOTHING — the pair is still pending on a follow-up GET
 *   (g) a non-queued / mismatched decision (wrong experience_id, an
 *       already-decided pair, a producer that was never a candidate at all)
 *       is rejected with reason "not_in_queue", never silently accepted;
 *       an invalid item (missing field / bad verdict) -> "invalid_item";
 *       a duplicate pair within one request -> "duplicate_in_request"
 *   (h) scale: one producer with 3 pending candidate pairs — the confirm/
 *       reject endpoint's per-item validation doesn't special-case producer
 *       size (all 3 individually decidable in one call), and the GET
 *       endpoint's pagination (?limit/?offset) and ?producer_id filter both
 *       work, plus producer_summary reports the right per-producer count
 */

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

interface RouteResult {
  status: number;
  body: any;
}

function callRoute(
  router: any,
  opts: {
    method?: "GET" | "POST";
    url?: string;
    headers?: Record<string, string>;
    body?: any;
  } = {},
): Promise<RouteResult> {
  return new Promise((resolve) => {
    const method = opts.method || "GET";
    const url = opts.url || "/admin/gardssalg-experience-conflict-queue";
    const [path, qs] = url.split("?");
    const query: Record<string, string> = {};
    if (qs) {
      for (const part of qs.split("&")) {
        const [k, v] = part.split("=");
        if (k) query[decodeURIComponent(k)] = decodeURIComponent(v ?? "");
      }
    }
    const req: any = {
      method,
      url,
      originalUrl: url,
      path,
      query,
      headers: opts.headers || {},
      body: opts.body ?? {},
      get() { return undefined; },
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

export function runOpplevelserGardssalgExperienceConflictQueueTests(
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
    const prevExperiencesDbPath = process.env.EXPERIENCES_DB_PATH;
    const prevAdminKey = process.env.ADMIN_KEY;
    const testKey = process.env.ADMIN_KEY || "gardssalg-experience-conflict-queue-test-key";
    process.env.EXPERIENCES_DB_PATH = ":memory:";
    process.env.ADMIN_KEY = testKey;

    const dbFactoryPath = require.resolve("../database/db-factory");
    const experienceStorePath = require.resolve("../services/experience-store");
    const conflictServicePath = require.resolve("../services/gardssalg-experience-conflict");
    const opplevelserPath = require.resolve("./opplevelser");
    const cachePaths = [dbFactoryPath, experienceStorePath, conflictServicePath, opplevelserPath];
    for (const p of cachePaths) delete require.cache[p];

    try {
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const expDb = dbFactory.getDb("experiences");

      const insertProvider = expDb.prepare(
        `INSERT INTO experience_providers
           (id, navn, vertical, org_nr, kommune, rfb_seed_source, producer_type,
            epost, telefon, hjemmeside, about_text, visit_text, opening_hours_text,
            products, content_source, booking_live, catalog_hidden, slug, field_provenance,
            brreg_verified, enrichment_state, verification_status, source, confidence)
         VALUES
           (@id, @navn, 'experiences', @org_nr, @kommune, 'rfb-seed', NULL,
            @epost, @telefon, @hjemmeside, @about_text, NULL, NULL,
            @products, @content_source, 0, 0, @slug, @field_provenance,
            @brreg_verified, 'raw', 'pending_verify', 'test-fixture', 'medium')`,
      );
      const insertExperience = expDb.prepare(
        `INSERT INTO experiences (id, provider_id, title, booking_url, verification_status)
         VALUES (@id, @provider_id, @title, @booking_url, 'pending_verify')`,
      );
      const VERIFIED_PROVENANCE = JSON.stringify({
        hjemmeside_verification: { verified: true, classification: "verified", checked_at: "2026-08-01T00:00:00.000Z" },
      });

      // ── (b)/(g) fixture A — a fresh, undecided name_token candidate pair.
      //    Distinctive shared token "kanelbakken" (11 chars, not a
      //    producer_type word, used by only this one producer in the whole
      //    scan) so it clears the genericity gate on its own. Different
      //    registrable domains -> status "conflict". ────────────────────────
      insertProvider.run({
        id: "prov-queue-a", navn: "Kanelbakken Bryggeri", org_nr: "211111111", kommune: "Voss",
        epost: "post@kanelbakken.no", telefon: null, hjemmeside: "https://kanelbakken.no",
        about_text: "Om bryggeriet.", products: "Håndverksøl", content_source: "provider_site",
        slug: "kanelbakken-bryggeri", field_provenance: VERIFIED_PROVENANCE, brreg_verified: 1,
      });
      insertExperience.run({
        id: "exp-queue-a", provider_id: null,
        title: "Kanelbakken Fjordcruise med guide",
        booking_url: "https://fjordtur.example/kanelbakken",
      });

      // ── (d) fixture B — a second fresh candidate, used for the confirm
      //    flow (kept separate from A so A stays untouched as a negative
      //    control throughout). ──────────────────────────────────────────
      insertProvider.run({
        id: "prov-queue-b", navn: "Nordvegen Sideri", org_nr: "222222212", kommune: "Ulvik",
        epost: "post@nordvegen.no", telefon: null, hjemmeside: "https://nordvegen.no",
        about_text: "Om sideriet.", products: "Sider", content_source: "provider_site",
        slug: "nordvegen-sideri", field_provenance: VERIFIED_PROVENANCE, brreg_verified: 1,
      });
      insertExperience.run({
        id: "exp-queue-b", provider_id: null,
        title: "Nordvegen kyststi vandring",
        booking_url: "https://vandreturer.example/nordvegen",
      });

      // ── (e) fixture C — a third fresh candidate, used for the reject flow.
      insertProvider.run({
        id: "prov-queue-c", navn: "Lyngstad Gårdsutsalg", org_nr: "232323232", kommune: "Voss",
        epost: "post@lyngstad.no", telefon: null, hjemmeside: "https://lyngstad.no",
        about_text: "Om gården.", products: "Grønnsaker", content_source: "provider_site",
        slug: "lyngstad-gardsutsalg", field_provenance: VERIFIED_PROVENANCE, brreg_verified: 1,
      });
      insertExperience.run({
        id: "exp-queue-c", provider_id: null,
        title: "Lyngstad fotturer i høyfjellet",
        booking_url: "https://fjellturer.example/lyngstad",
      });

      // ── (h) fixture D — one producer with THREE pending candidate pairs
      //    (the Booze-Of-Norway-shaped scale case, scaled down). ───────────
      insertProvider.run({
        id: "prov-queue-scale", navn: "Mangfoldig Cideri", org_nr: "242424242", kommune: "Voss",
        epost: "post@mangfoldig.no", telefon: null, hjemmeside: "https://mangfoldig.no",
        about_text: "Om sideriet.", products: "Cider", content_source: "provider_site",
        slug: "mangfoldig-cideri", field_provenance: VERIFIED_PROVENANCE, brreg_verified: 1,
      });
      insertExperience.run({ id: "exp-scale-1", provider_id: null, title: "Mangfoldig Fjellhotell", booking_url: "https://fjellhotell.example/mangfoldig1" });
      insertExperience.run({ id: "exp-scale-2", provider_id: null, title: "Mangfoldig Bretur", booking_url: "https://bretur.example/mangfoldig2" });
      insertExperience.run({ id: "exp-scale-3", provider_id: null, title: "Mangfoldig Sightseeing", booking_url: "https://sightseeing.example/mangfoldig3" });

      // ── (c) fixture E — reproduces the pre-seeded CONFIRMED pair (Lervig,
      //    2026-08-01 spot-check) with the EXACT producer_id/experience_id
      //    the seed in database/init-experiences.ts uses, so the seeded
      //    decision applies to a pair the scan can actually find. Different
      //    booking_url domain than the producer's own hjemmeside -> status
      //    "conflict", basis "name_token" (shared token "lervig"). ─────────
      insertProvider.run({
        id: "59db202c-3ebe-49c1-80cb-1bfb99ba0823", navn: "Lervig", org_nr: "252525252", kommune: "Stavanger",
        epost: "post@lervig.no", telefon: null, hjemmeside: "https://lervig.no",
        about_text: "Om bryggeriet.", products: "Øl", content_source: "provider_site",
        slug: "lervig", field_provenance: VERIFIED_PROVENANCE, brreg_verified: 1,
      });
      insertExperience.run({
        id: "4fb72e45-24be-4724-92e1-5bc93fccc550", provider_id: null,
        title: "Lervig Local — Guided Beer Tasting at Stavanger Brewpub",
        booking_url: "https://different-host.example/lervig-tasting",
      });

      // ── (c) fixture F — reproduces the pre-seeded REJECTED pair
      //    (Lillehammer Bryggeri, 2026-08-01 spot-check), same exact ids. ──
      insertProvider.run({
        id: "3b2e4b86-053f-4dc8-848d-6b72b66f04a7", navn: "Lillehammer Bryggeri", org_nr: "262626262", kommune: "Lillehammer",
        epost: "post@lillehammerbryggeri.no", telefon: null, hjemmeside: "https://lillehammerbryggeri.no",
        about_text: "Om bryggeriet.", products: "Øl", content_source: "provider_site",
        slug: "lillehammer-bryggeri", field_provenance: VERIFIED_PROVENANCE, brreg_verified: 1,
      });
      insertExperience.run({
        id: "c13170e1-19f8-47e7-9138-04e649072b03", provider_id: null,
        title: "Birkebeineren Hotel — Lillehammer sentrum med ski-in ski-out",
        booking_url: "https://different-hotel.example/birkebeineren",
      });

      const opplevelserRouter = (require("./opplevelser") as typeof import("./opplevelser")).default as any;

      function findPair(list: any[], producerId: string, experienceId: string): any {
        return list.find((p: any) => p.producer_id === producerId && p.experience_id === experienceId);
      }
      function findReadinessRow(list: any[], producerId: string): any {
        return list.find((p: any) => p.id === producerId);
      }
      // GET /admin/gardssalg-outreach-readiness doesn't echo the internal id
      // back — it returns `name`/`id`? Check via producer navn instead since
      // that's what the response carries (see computeGardssalgReadinessRows).
      function findReadinessRowByName(list: any[], navn: string): any {
        return list.find((p: any) => p.name === navn);
      }

      // ── (a) auth gate ────────────────────────────────────────────────────
      const noKeyGet = await callRoute(opplevelserRouter, { url: "/admin/gardssalg-experience-conflict-queue" });
      assertEq(noKeyGet.status, 403, "a1: GET .../gardssalg-experience-conflict-queue without X-Admin-Key -> 403");
      const noKeyPost = await callRoute(opplevelserRouter, {
        method: "POST",
        url: "/admin/gardssalg-experience-conflict-review",
        body: { decisions: [{ producer_id: "prov-queue-a", experience_id: "exp-queue-a", verdict: "confirmed" }], apply: true },
      });
      assertEq(noKeyPost.status, 403, "a2: POST .../gardssalg-experience-conflict-review without X-Admin-Key -> 403");

      // ── (b)/(c) initial GET: pending pairs + pre-seeded exclusion ───────
      const initialGet = await callRoute(opplevelserRouter, {
        url: "/admin/gardssalg-experience-conflict-queue?limit=500",
        headers: { "x-admin-key": testKey },
      });
      assertEq(initialGet.status, 200, "b1: queue GET -> 200");
      const initialPairs: any[] = initialGet.body.pairs;
      assertTrue(Array.isArray(initialPairs), "b2: response carries a pairs array");

      const pairA = findPair(initialPairs, "prov-queue-a", "exp-queue-a");
      assertTrue(!!pairA, "b3: fixture A's pair is in the pending queue");
      assertEq(pairA?.producer_name, "Kanelbakken Bryggeri", "b4: pair carries producer_name");
      assertEq(pairA?.producer_hjemmeside, "https://kanelbakken.no", "b5: pair carries producer_hjemmeside");
      assertEq(pairA?.experience_title, "Kanelbakken Fjordcruise med guide", "b6: pair carries experience_title");
      assertEq(pairA?.experience_booking_url, "https://fjordtur.example/kanelbakken", "b7: pair carries experience_booking_url");
      assertEq(pairA?.match_basis, "name_token", "b8: pair A matched via name_token");
      assertEq(pairA?.status, "conflict", "b9: pair A status is conflict");
      assertTrue(Array.isArray(pairA?.shared_tokens) && pairA.shared_tokens.includes("kanelbakken"), "b10: pair A's shared_tokens includes 'kanelbakken'");

      // (c) the pre-seeded pairs must NOT be pending, even though the scan
      // itself would otherwise find them (their producer/experience fixtures
      // above are shaped to match exactly like any other candidate).
      const lervigPending = findPair(initialPairs, "59db202c-3ebe-49c1-80cb-1bfb99ba0823", "4fb72e45-24be-4724-92e1-5bc93fccc550");
      assertTrue(!lervigPending, "c1: the pre-seeded CONFIRMED Lervig pair is NOT in the initial pending queue");
      const lillehammerPending = findPair(initialPairs, "3b2e4b86-053f-4dc8-848d-6b72b66f04a7", "c13170e1-19f8-47e7-9138-04e649072b03");
      assertTrue(!lillehammerPending, "c2: the pre-seeded REJECTED Lillehammer pair is NOT in the initial pending queue");

      assertTrue(initialGet.body.counts.confirmed_total >= 1, "c3: counts.confirmed_total includes the pre-seeded Lervig confirm");
      assertTrue(initialGet.body.counts.rejected_total >= 13, "c4: counts.rejected_total includes all 13 pre-seeded rejects");

      // (c) — BEFORE any admin decision call in this test run — the seeded
      // Lervig confirm must already count as has_duplicate_conflict via the
      // readiness endpoint, and the seeded Lillehammer reject must count as
      // NEITHER has_duplicate_conflict NOR name_token_conflict_candidate.
      const readinessBefore = await callRoute(opplevelserRouter, {
        url: "/admin/gardssalg-outreach-readiness",
        headers: { "x-admin-key": testKey },
      });
      assertEq(readinessBefore.status, 200, "c5: readiness GET -> 200");
      const lervigRow = findReadinessRowByName(readinessBefore.body.providers, "Lervig");
      assertTrue(!!lervigRow, "c6: Lervig readiness row present");
      assertEq(lervigRow?.has_duplicate_conflict, true, "c7: Lervig has_duplicate_conflict TRUE at test startup — the pre-seeded confirm already counts as evidence, no admin call needed");
      assertEq(lervigRow?.name_token_conflict_candidate, false, "c8: Lervig is no longer merely a 'candidate' — it graduated to real evidence");

      const lillehammerRow = findReadinessRowByName(readinessBefore.body.providers, "Lillehammer Bryggeri");
      assertTrue(!!lillehammerRow, "c9: Lillehammer Bryggeri readiness row present");
      assertEq(lillehammerRow?.has_duplicate_conflict, false, "c10: Lillehammer Bryggeri has_duplicate_conflict FALSE — the pre-seeded reject suppresses it");
      assertEq(lillehammerRow?.name_token_conflict_candidate, false, "c11: Lillehammer Bryggeri is not even a candidate anymore — reject fully suppresses it, per spec");

      // A producer with no decision at all (fixture A) is still merely a
      // CANDIDATE at this point — slice 1's unchanged default behavior.
      const kanelRow = findReadinessRowByName(readinessBefore.body.providers, "Kanelbakken Bryggeri");
      assertEq(kanelRow?.has_duplicate_conflict, false, "c12: undecided candidate (Kanelbakken) does not block outreach yet");
      assertEq(kanelRow?.name_token_conflict_candidate, true, "c13: undecided candidate (Kanelbakken) is flagged informational-only");

      // ── (f) dry-run confirm on fixture B — must write nothing ───────────
      const dryRunRes = await callRoute(opplevelserRouter, {
        method: "POST",
        url: "/admin/gardssalg-experience-conflict-review",
        headers: { "x-admin-key": testKey },
        body: { decisions: [{ producer_id: "prov-queue-b", experience_id: "exp-queue-b", verdict: "confirmed" }] },
      });
      assertEq(dryRunRes.status, 200, "f1: dry-run POST -> 200");
      assertEq(dryRunRes.body.dry_run, true, "f2: dry_run defaults true");
      assertEq(dryRunRes.body.approved_count, 1, "f3: dry-run reports 1 approved (would-decide)");
      assertEq(dryRunRes.body.written, [], "f4: dry-run writes NOTHING");
      assertEq(dryRunRes.body.rejected, [], "f5: dry-run has zero invalid entries");

      const afterDryRunGet = await callRoute(opplevelserRouter, {
        url: "/admin/gardssalg-experience-conflict-queue?limit=500",
        headers: { "x-admin-key": testKey },
      });
      const pairBStillPending = findPair(afterDryRunGet.body.pairs, "prov-queue-b", "exp-queue-b");
      assertTrue(!!pairBStillPending, "f6: fixture B's pair is STILL pending after a dry-run — no write happened");

      // ── (d) real confirm on fixture B (apply=true) ──────────────────────
      const confirmRes = await callRoute(opplevelserRouter, {
        method: "POST",
        url: "/admin/gardssalg-experience-conflict-review",
        headers: { "x-admin-key": testKey },
        body: {
          decisions: [{ producer_id: "prov-queue-b", experience_id: "exp-queue-b", verdict: "confirmed", note: "test-confirm" }],
          apply: true,
          decided_by: "test-admin",
        },
      });
      assertEq(confirmRes.status, 200, "d1: confirm apply -> 200");
      assertEq(confirmRes.body.dry_run, false, "d2: dry_run is false");
      assertEq(confirmRes.body.written_count, 1, "d3: confirm apply writes exactly 1 decision");
      assertEq(confirmRes.body.written[0]?.verdict, "confirmed", "d4: written entry carries verdict 'confirmed'");
      assertEq(confirmRes.body.rejected, [], "d5: no invalid entries");

      const afterConfirmGet = await callRoute(opplevelserRouter, {
        url: "/admin/gardssalg-experience-conflict-queue?limit=500",
        headers: { "x-admin-key": testKey },
      });
      assertTrue(!findPair(afterConfirmGet.body.pairs, "prov-queue-b", "exp-queue-b"), "d6: fixture B's pair is GONE from the queue after confirm");

      const readinessAfterConfirm = await callRoute(opplevelserRouter, {
        url: "/admin/gardssalg-outreach-readiness",
        headers: { "x-admin-key": testKey },
      });
      const nordvegenRow = findReadinessRowByName(readinessAfterConfirm.body.providers, "Nordvegen Sideri");
      assertEq(nordvegenRow?.has_duplicate_conflict, true, "d7: Nordvegen Sideri now has_duplicate_conflict TRUE — the confirm became real evidence");
      assertEq(nordvegenRow?.name_token_conflict_candidate, false, "d8: Nordvegen Sideri is no longer a mere candidate");

      // Re-submitting the SAME now-decided pair must be refused — it's no
      // longer in the pending queue.
      const reconfirmRes = await callRoute(opplevelserRouter, {
        method: "POST",
        url: "/admin/gardssalg-experience-conflict-review",
        headers: { "x-admin-key": testKey },
        body: { decisions: [{ producer_id: "prov-queue-b", experience_id: "exp-queue-b", verdict: "confirmed" }], apply: true },
      });
      assertEq(reconfirmRes.body.written, [], "d9: re-deciding an already-decided pair writes nothing");
      assertTrue(
        reconfirmRes.body.rejected.some((r: any) => r.producer_id === "prov-queue-b" && r.reason === "not_in_queue"),
        "d10: re-deciding an already-decided pair -> rejected with reason 'not_in_queue'",
      );

      // ── (e) real reject on fixture C (apply=true) ───────────────────────
      const rejectRes = await callRoute(opplevelserRouter, {
        method: "POST",
        url: "/admin/gardssalg-experience-conflict-review",
        headers: { "x-admin-key": testKey },
        body: { decisions: [{ producer_id: "prov-queue-c", experience_id: "exp-queue-c", verdict: "rejected" }], apply: true },
      });
      assertEq(rejectRes.status, 200, "e1: reject apply -> 200");
      assertEq(rejectRes.body.written_count, 1, "e2: reject apply writes exactly 1 decision");
      assertEq(rejectRes.body.written[0]?.verdict, "rejected", "e3: written entry carries verdict 'rejected'");

      const afterRejectGet = await callRoute(opplevelserRouter, {
        url: "/admin/gardssalg-experience-conflict-queue?limit=500",
        headers: { "x-admin-key": testKey },
      });
      assertTrue(!findPair(afterRejectGet.body.pairs, "prov-queue-c", "exp-queue-c"), "e4: fixture C's pair is GONE from the queue after reject");

      const readinessAfterReject = await callRoute(opplevelserRouter, {
        url: "/admin/gardssalg-outreach-readiness",
        headers: { "x-admin-key": testKey },
      });
      const lyngstadRow = findReadinessRowByName(readinessAfterReject.body.providers, "Lyngstad Gårdsutsalg");
      assertEq(lyngstadRow?.has_duplicate_conflict, false, "e5: Lyngstad Gårdsutsalg has_duplicate_conflict FALSE — rejected, never blocks");
      assertEq(lyngstadRow?.name_token_conflict_candidate, false, "e6: Lyngstad Gårdsutsalg is not even a candidate anymore — reject fully suppresses it");

      // ── (g) invalid/mismatched decisions — never silently accepted ─────
      const invalidRes = await callRoute(opplevelserRouter, {
        method: "POST",
        url: "/admin/gardssalg-experience-conflict-review",
        headers: { "x-admin-key": testKey },
        body: {
          apply: true,
          decisions: [
            { producer_id: "", experience_id: "exp-queue-a", verdict: "confirmed" }, // missing producer_id
            { producer_id: "prov-queue-a", experience_id: "exp-queue-a", verdict: "maybe" }, // invalid verdict
            { producer_id: "prov-queue-a", experience_id: "exp-does-not-exist", verdict: "confirmed" }, // never a candidate
            { producer_id: "prov-queue-a", experience_id: "exp-queue-a", verdict: "confirmed" }, // valid — appears twice below
            { producer_id: "prov-queue-a", experience_id: "exp-queue-a", verdict: "rejected" }, // duplicate of the valid one above (same pair-key)
          ],
        },
      });
      assertEq(invalidRes.status, 200, "g1: mixed-validity POST -> 200 (per-item errors, not a request-level failure)");
      assertTrue(
        invalidRes.body.rejected.some((r: any) => r.reason === "invalid_item" && r.experience_id === "exp-queue-a"),
        "g2: missing producer_id -> rejected reason 'invalid_item'",
      );
      assertTrue(
        invalidRes.body.rejected.some((r: any) => r.reason === "invalid_item" && r.producer_id === "prov-queue-a" && r.experience_id === "exp-queue-a"),
        "g3: invalid verdict value -> rejected reason 'invalid_item'",
      );
      assertTrue(
        invalidRes.body.rejected.some((r: any) => r.reason === "not_in_queue" && r.experience_id === "exp-does-not-exist"),
        "g4: a pair that was never a candidate -> rejected reason 'not_in_queue'",
      );
      assertTrue(
        invalidRes.body.rejected.some((r: any) => r.reason === "duplicate_in_request"),
        "g5: the SAME pair submitted twice in one request -> the second occurrence rejected reason 'duplicate_in_request'",
      );
      assertEq(invalidRes.body.written_count, 1, "g6: exactly ONE valid item (the first occurrence of prov-queue-a/exp-queue-a) was written");

      // fixture A is now decided (confirmed, from g above) — must be gone.
      const afterInvalidGet = await callRoute(opplevelserRouter, {
        url: "/admin/gardssalg-experience-conflict-queue?limit=500",
        headers: { "x-admin-key": testKey },
      });
      assertTrue(!findPair(afterInvalidGet.body.pairs, "prov-queue-a", "exp-queue-a"), "g7: fixture A's pair is GONE after the valid decision in the mixed request");

      // ── (h) scale — pagination + producer_summary + ?producer_id filter ─
      const scaleGet = await callRoute(opplevelserRouter, {
        url: "/admin/gardssalg-experience-conflict-queue?producer_id=prov-queue-scale",
        headers: { "x-admin-key": testKey },
      });
      assertEq(scaleGet.status, 200, "h1: scoped GET -> 200");
      assertEq(scaleGet.body.pairs.length, 3, "h2: ?producer_id=prov-queue-scale returns exactly its 3 pending pairs");
      assertTrue(
        (scaleGet.body.pairs as any[]).every((p: any) => p.producer_id === "prov-queue-scale"),
        "h3: every returned pair belongs to the filtered producer",
      );
      const scaleSummary = (scaleGet.body.producer_summary as any[]).find((p: any) => p.producer_id === "prov-queue-scale");
      assertEq(scaleSummary?.pending_count, 3, "h4: producer_summary reports pending_count 3 for the scale fixture");

      const pagedGet = await callRoute(opplevelserRouter, {
        url: "/admin/gardssalg-experience-conflict-queue?producer_id=prov-queue-scale&limit=2&offset=0",
        headers: { "x-admin-key": testKey },
      });
      assertEq(pagedGet.body.pairs.length, 2, "h5: limit=2 returns exactly 2 pairs");
      assertEq(pagedGet.body.page.matched, 3, "h6: page.matched still reports the full filtered count (3), independent of the page slice");

      const pagedGet2 = await callRoute(opplevelserRouter, {
        url: "/admin/gardssalg-experience-conflict-queue?producer_id=prov-queue-scale&limit=2&offset=2",
        headers: { "x-admin-key": testKey },
      });
      assertEq(pagedGet2.body.pairs.length, 1, "h7: offset=2,limit=2 returns the remaining 1 pair (3 total)");

      // Decide all 3 scale pairs in ONE call — behavior must not depend on
      // producer size.
      const scaleDecideRes = await callRoute(opplevelserRouter, {
        method: "POST",
        url: "/admin/gardssalg-experience-conflict-review",
        headers: { "x-admin-key": testKey },
        body: {
          apply: true,
          decisions: [
            { producer_id: "prov-queue-scale", experience_id: "exp-scale-1", verdict: "confirmed" },
            { producer_id: "prov-queue-scale", experience_id: "exp-scale-2", verdict: "rejected" },
            { producer_id: "prov-queue-scale", experience_id: "exp-scale-3", verdict: "rejected" },
          ],
        },
      });
      assertEq(scaleDecideRes.body.written_count, 3, "h8: all 3 pairs for one producer decided in a single call");
      assertEq(scaleDecideRes.body.rejected, [], "h9: no invalid entries");

      const scaleGetAfter = await callRoute(opplevelserRouter, {
        url: "/admin/gardssalg-experience-conflict-queue?producer_id=prov-queue-scale",
        headers: { "x-admin-key": testKey },
      });
      assertEq(scaleGetAfter.body.pairs.length, 0, "h10: prov-queue-scale has zero pending pairs left after deciding all 3");

      const readinessAfterScale = await callRoute(opplevelserRouter, {
        url: "/admin/gardssalg-outreach-readiness",
        headers: { "x-admin-key": testKey },
      });
      const mangfoldigRow = findReadinessRowByName(readinessAfterScale.body.providers, "Mangfoldig Cideri");
      assertEq(mangfoldigRow?.has_duplicate_conflict, true, "h11: one CONFIRMED pair is enough to flip has_duplicate_conflict, even with 2 REJECTED siblings");
    } catch (err: any) {
      failed++;
      failures.push(
        "opplevelser-gardssalg-experience-conflict-queue: unexpected error: " + String(err?.stack || err?.message || err),
      );
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

// Standalone runner: `npx tsx src/routes/opplevelser-gardssalg-experience-conflict-queue.test.ts`
if (require.main === module) {
  runOpplevelserGardssalgExperienceConflictQueueTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    process.exit(summary.failed > 0 ? 1 : 0);
  });
}
