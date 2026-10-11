/**
 * opplevelser-gardssalg-website-queue-unblock.test.ts — 2026-10-11
 * website-review-queue unblock.
 *
 * Prod read 2026-10-11: gardssalg_website_review_queue held 228–230 rows, all
 * reported "stale", but only ~25 were genuinely blocked drink producers
 * (~157 non-gårdssalg providers swept in by broad verification batches, ~46
 * providers whose hjemmeside was already verified). Four code causes, each
 * covered here:
 *
 *   u1  veien-til-pool step 1 (gsVtpProcessProvider) treated ANY queue row as
 *       "queued" -> a terminal note (`candidate_evidence_failed`,
 *       `LLM judge AVVIS: …`, `judge GODKJENN but write blocked: …`) pinned a
 *       blank-hjemmeside provider at queued_needs_domain_affiliation forever.
 *       Now: no_website_no_candidate. u1e-u1l: with a hjemmeside present, a
 *       terminal row no longer stops the own-hjemmeside re-verification —
 *       dry-run reports would_verify and writes nothing, apply verifies
 *       (and, via C, removes the moot queue row).
 *   u2  regression: an OPEN candidate (`website_discovery_candidate`,
 *       `brreg_registered_hjemmeside`) still takes the queued path exactly as
 *       before (queued_needs_domain_affiliation / would_write).
 *   u3  a PARKED open-candidate row is ignored by step 1.
 *   u4  applyGardssalgWebsiteVerification: verified -> the provider's queue
 *       row is deleted (`dequeued`); unverified with an open candidate for a
 *       DIFFERENT url -> candidate kept byte-identical; unverified with no
 *       row -> verification_failed inserted (unchanged); a terminal / parked
 *       / same-url row is still refreshed by the upsert (unchanged).
 *   u5  GET /admin/gardssalg-review-queues-staleness: parked rows excluded
 *       from website_review_queue; website_review_queue_actionable counts
 *       only open candidates of non-verified gårdssalg providers;
 *       website_review_queue_breakdown adds up.
 *   u6  POST /admin/gardssalg-website-review-queue-cleanup: 403 without key;
 *       empty queue is a no-op; dry-run writes nothing; write-pause -> 423
 *       on apply only; apply deletes resolved rows, parks not_gardssalg
 *       rows, leaves the rest byte-identical; second apply is a no-op.
 *
 * Harness: mirrors opplevelser-gardssalg-website-review-queue-park.test.ts /
 * opplevelser-veien-til-pool-skive2.test.ts (EXPERIENCES_DB_PATH=":memory:",
 * fresh require of db-factory + experience-store + gardssalg-website-
 * verification + opplevelser, router.handle() via callRoute()), plus the
 * main-db pin (__pinInMemoryDbForTesting) the write-pause tests elsewhere use
 * so u6's pause toggle never touches a real main DB.
 *
 * Wired into tests/test.ts (next to the
 * opplevelser-gardssalg-website-review-queue-park block).
 *
 * Standalone:
 *   npx tsx src/routes/opplevelser-gardssalg-website-queue-unblock.test.ts
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
  opts: { method?: "GET" | "POST"; path: string; headers?: Record<string, string>; body?: any },
): Promise<RouteResult> {
  return new Promise((resolve) => {
    const headers = opts.headers || {};
    const req: any = {
      method: opts.method ?? "POST",
      url: opts.path,
      originalUrl: `/api/opplevelser${opts.path}`,
      path: opts.path,
      query: {},
      headers,
      body: opts.body ?? {},
      get(name: string) {
        return headers[name.toLowerCase()];
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
      send(payload: any) {
        resolve({ status: this.statusCode, body: payload });
        return this;
      },
    };
    router.handle(req, res, (err?: any) => {
      if (err) resolve({ status: 500, body: { error: String(err) } });
      else resolve({ status: 404, body: { error: "no route matched" } });
    });
  });
}

export function runOpplevelserGardssalgWebsiteQueueUnblockTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
    const testKey = process.env.ADMIN_KEY || "gardssalg-website-queue-unblock-test-key";
    process.env.EXPERIENCES_DB_PATH = ":memory:";
    process.env.ADMIN_KEY = testKey;

    const dbFactoryPath = require.resolve("../database/db-factory");
    const storePath = require.resolve("../services/experience-store");
    // Same fresh-require pairing as opplevelser-veien-til-pool-skive2.test.ts:
    // gardssalg-website-verification.ts binds experience-store's queue
    // helpers at ITS load time, so it must be refreshed together with it.
    const wvServicePath = require.resolve("../services/gardssalg-website-verification");
    const opplevelserPath = require.resolve("./opplevelser");
    const cachePaths = [dbFactoryPath, storePath, wvServicePath, opplevelserPath];
    for (const p of cachePaths) delete require.cache[p];

    const prevFetch = globalThis.fetch;
    let restoreMainDb: (() => void) | null = null;

    try {
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const expDb = dbFactory.getDb("experiences");
      const init = require("../database/init") as typeof import("../database/init");
      restoreMainDb = init.__pinInMemoryDbForTesting();
      const pauseSvc = require("../services/enrichment-write-pause") as typeof import("../services/enrichment-write-pause");
      const expStore = require("../services/experience-store") as typeof import("../services/experience-store");
      const wvService = require("../services/gardssalg-website-verification") as typeof import("../services/gardssalg-website-verification");
      const opplevelserModule = require("./opplevelser") as typeof import("./opplevelser");
      const router = opplevelserModule.default as any;
      const auth = { "x-admin-key": testKey };

      const insertProvider = expDb.prepare(
        `INSERT INTO experience_providers
           (id, navn, vertical, producer_type, rfb_seed_source, merged_into, hjemmeside, epost, telefon, org_nr,
            about_text, products, brreg_verified, catalog_hidden, content_source, field_provenance, created_at)
         VALUES (@id, @navn, 'experiences', @pt, @seed, @merged_into, @hj, @ep, @tlf, @org_nr,
                 @ab, @products, @brreg_verified, 0, NULL, @field_provenance, '2026-01-01')`,
      );
      // Defaults: a gårdssalg producer (producer_type set) whose contact /
      // content / org.nr / brreg are already complete, so veien-til-pool's
      // later steps short-circuit to "ok"/"blocked_no_website" and only the
      // nettsted step under test can touch the network. org_nr is UNIQUE, so
      // each seeded row gets its own synthetic one unless a case names it.
      let orgnrSeq = 913000000;
      const seed = (o: Partial<Record<string, unknown>> & { id: string; navn: string }) =>
        insertProvider.run({
          pt: "sideri",
          seed: null,
          merged_into: null,
          hj: null,
          ep: "post@gard.example",
          tlf: "91234567",
          org_nr: String(++orgnrSeq),
          ab: "En ekte og fyldig tekst om garden, lang nok til å telle som utfylt.",
          products: JSON.stringify(["sider"]),
          brreg_verified: 1,
          field_provenance: null,
          ...o,
        });
      const verifiedProvenance = JSON.stringify({
        hjemmeside_verification: { verified: true, classification: "verified", checked_at: "2026-10-01T00:00:00Z" },
      });

      function sqliteUtcDaysAgo(days: number): string {
        return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 19).replace("T", " ");
      }
      const insertQueueStmt = expDb.prepare(
        `INSERT INTO gardssalg_website_review_queue
           (id, provider_id, provider_name, candidate_url, final_url, evidence, confidence, reason, batch_id, created_at, updated_at, parked_since)
         VALUES (@id, @provider_id, @provider_name, @candidate_url, NULL, NULL, @confidence, @reason, @batch_id, @created_at, @created_at, @parked_since)`,
      );
      const queue = (o: {
        provider_id: string;
        candidate_url: string;
        reason: string;
        parked_since?: string | null;
        created_at?: string;
        confidence?: number | null;
      }) =>
        insertQueueStmt.run({
          id: `q-${o.provider_id}`,
          provider_id: o.provider_id,
          provider_name: o.provider_id,
          candidate_url: o.candidate_url,
          confidence: o.confidence ?? null,
          reason: o.reason,
          batch_id: "seed-batch",
          created_at: o.created_at ?? sqliteUtcDaysAgo(20),
          parked_since: o.parked_since ?? null,
        });
      const getQueueRow = (providerId: string): any =>
        expDb.prepare(`SELECT * FROM gardssalg_website_review_queue WHERE provider_id = ?`).get(providerId);
      const getProvider = (providerId: string): any =>
        expDb.prepare(`SELECT hjemmeside, field_provenance FROM experience_providers WHERE id = ?`).get(providerId);
      const dumpQueue = (): string =>
        JSON.stringify(expDb.prepare(`SELECT * FROM gardssalg_website_review_queue ORDER BY provider_id`).all());

      // Fetch mock — every scenario owns a distinct host; anything else is a
      // plain 404. Counted per host so u1 can prove a blank-hjemmeside
      // provider never fetches and a fall-through provider does.
      const fetchCalls = new Map<string, number>();
      const mockHeaders = { get: () => null } as unknown as Headers;
      const htmlResponse = (u: string, html: string): Response =>
        ({ ok: true, status: 200, statusText: "OK", url: u, headers: mockHeaders,
           arrayBuffer: async () => new TextEncoder().encode(html).buffer }) as unknown as Response;
      globalThis.fetch = (async (url: string | URL | Request) => {
        const u = String(url);
        let host = "";
        try { host = new URL(u).host; } catch { /* not a URL */ }
        fetchCalls.set(host, (fetchCalls.get(host) ?? 0) + 1);
        if (host === "klippesideri-u1.example") {
          return htmlResponse(u, `<html><body>Klippe Sideri, org.nr 912345671, velkommen til garden</body></html>`);
        }
        return ({ ok: false, status: 404, statusText: "Not Found", url: u, headers: mockHeaders,
                  arrayBuffer: async () => new ArrayBuffer(0), json: async () => ({}) }) as unknown as Response;
      }) as unknown as typeof fetch;
      const totalFetches = () => Array.from(fetchCalls.values()).reduce((a, b) => a + b, 0);

      const callVtp = (body: Record<string, unknown>) =>
        callRoute(router, { path: "/admin/gardssalg-veien-til-pool", headers: auth, body });
      const websiteStep = (r: RouteResult, id: string): any =>
        ((r.body?.providers as any[]) ?? []).find((p) => p.provider_id === id)?.steps?.website;

      // ═══ u1: terminal rows no longer count as "queued" ═════════════════
      {
        seed({ id: "u1-cef", navn: "Kandidatfeil Gard" });
        queue({ provider_id: "u1-cef", candidate_url: "https://unrelated-u1-cef.example", reason: "candidate_evidence_failed" });
        seed({ id: "u1-avvis", navn: "Avvist Kandidat Gard" });
        queue({ provider_id: "u1-avvis", candidate_url: "https://unrelated-u1-avvis.example", reason: "LLM judge AVVIS: domenet tilhører et designbyrå" });
        seed({ id: "u1-blocked", navn: "Skriveblokk Gard" });
        queue({ provider_id: "u1-blocked", candidate_url: "https://unrelated-u1-blocked.example", reason: "judge GODKJENN but write blocked: write_skipped_by_guards" });
        const ids = ["u1-cef", "u1-avvis", "u1-blocked"];
        const before = dumpQueue();
        const fetchesBefore = totalFetches();

        const dry = await callVtp({ providerIds: ids });
        assertEq(dry.status, 200, "u1a: veien-til-pool dry-run -> 200");
        for (const id of ids) {
          assertEq(websiteStep(dry, id), { status: "no_website_no_candidate" }, `u1b.${id}: terminal row + blank hjemmeside -> no_website_no_candidate (was queued_needs_domain_affiliation)`);
        }
        const app = await callVtp({ providerIds: ids, apply: true });
        assertEq(app.status, 200, "u1c: veien-til-pool apply -> 200");
        for (const id of ids) {
          assertEq(websiteStep(app, id)?.status, "no_website_no_candidate", `u1d.${id}: same verdict on apply`);
        }
        assertEq(dumpQueue(), before, "u1d2: the terminal queue rows themselves are left untouched by step 1");
        assertEq(totalFetches(), fetchesBefore, "u1d3: a blank-hjemmeside provider never fetches anything");
      }

      // u1e..u1l: hjemmeside present + a terminal row for an UNAFFILIATED
      // candidate. Before: queued_needs_domain_affiliation, own hjemmeside
      // never re-checked. Now: the unchanged single-fetch verify path runs.
      {
        seed({ id: "u1-own", navn: "Klippe Sideri", hj: "https://klippesideri-u1.example", org_nr: "912345671" });
        queue({ provider_id: "u1-own", candidate_url: "https://unrelated-u1-own.example", reason: "verification_failed" });
        const queueBefore = getQueueRow("u1-own");

        const dry = await callVtp({ providerIds: ["u1-own"] });
        assertEq(websiteStep(dry, "u1-own")?.status, "would_verify", "u1e: dry-run falls through to the own-hjemmeside verify path -> would_verify");
        assertTrue((fetchCalls.get("klippesideri-u1.example") ?? 0) > 0, "u1f: the own hjemmeside was actually fetched");
        assertEq(getProvider("u1-own").field_provenance, null, "u1g: dry-run stamps no provenance (unchanged dry-run behaviour)");
        assertEq(getQueueRow("u1-own"), queueBefore, "u1h: dry-run leaves the queue row byte-identical");

        const app = await callVtp({ providerIds: ["u1-own"], apply: true });
        assertEq(websiteStep(app, "u1-own")?.status, "verified", "u1i: apply -> verified");
        const prov = JSON.parse(getProvider("u1-own").field_provenance || "{}");
        assertEq(prov.hjemmeside_verification?.verified, true, "u1j: hjemmeside_verification.verified === true stamped");
        assertEq(getQueueRow("u1-own"), undefined, "u1k: the now-moot queue row is removed on verify (applyGardssalgWebsiteVerification)");
        assertEq(getProvider("u1-own").hjemmeside, "https://klippesideri-u1.example", "u1l: the hjemmeside itself is untouched");
      }

      // ═══ u2: an OPEN candidate still behaves exactly as before ══════════
      {
        seed({ id: "u2-unaff", navn: "Ukjent Kø Gard" });
        queue({ provider_id: "u2-unaff", candidate_url: "https://unrelated-agency-u2.example", reason: "website_discovery_candidate", confidence: 0.9 });
        seed({ id: "u2-aff", navn: "Fjordbris Sideri" });
        queue({ provider_id: "u2-aff", candidate_url: "https://fjordbrissideri-u2.example", reason: "brreg_registered_hjemmeside" });
        const unaffBefore = getQueueRow("u2-unaff");

        const dry = await callVtp({ providerIds: ["u2-unaff", "u2-aff"] });
        const unaff = websiteStep(dry, "u2-unaff");
        assertEq(unaff?.status, "queued_needs_domain_affiliation", "u2a: open unaffiliated website_discovery_candidate -> queued_needs_domain_affiliation (unchanged)");
        assertEq(unaff?.candidate_url, "https://unrelated-agency-u2.example", "u2b: …reporting the queued candidate_url");
        assertEq(websiteStep(dry, "u2-aff"), { status: "would_write", candidate_url: "https://fjordbrissideri-u2.example" },
          "u2c: open affiliated brreg_registered_hjemmeside candidate -> would_write (an open reason too)");

        const app = await callVtp({ providerIds: ["u2-unaff"], apply: true });
        assertEq(websiteStep(app, "u2-unaff")?.status, "queued_needs_domain_affiliation", "u2d: apply -> still queued_needs_domain_affiliation");
        assertEq(getQueueRow("u2-unaff"), unaffBefore, "u2e: the open candidate row is untouched");
        assertEq(getProvider("u2-unaff").hjemmeside, null, "u2f: nothing written");
        assertEq(getProvider("u2-aff").hjemmeside, null, "u2g: dry-run wrote nothing for the affiliated candidate");
      }

      // ═══ u3: a PARKED open-candidate row is ignored ═════════════════════
      {
        seed({ id: "u3-parked", navn: "Parkert Kandidat Gard" });
        queue({ provider_id: "u3-parked", candidate_url: "https://parkertkandidatgard-u3.example", reason: "website_discovery_candidate", parked_since: "2026-09-03 10:00:00" });
        const r = await callVtp({ providerIds: ["u3-parked"] });
        assertEq(websiteStep(r, "u3-parked"), { status: "no_website_no_candidate" }, "u3a: parked website_discovery_candidate is not 'queued' -> no_website_no_candidate");
      }

      // ═══ u4: applyGardssalgWebsiteVerification queue handling ═══════════
      {
        const row = (o: { provider_id: string; hjemmeside: string; classification: "verified" | "unverified" }) => ({
          provider_id: o.provider_id,
          name: o.provider_id,
          hjemmeside: o.hjemmeside,
          classification: o.classification,
          evidence: null,
        });

        seed({ id: "u4-ver", navn: "U4 Verifisert", hj: "https://u4-ver.example" });
        queue({ provider_id: "u4-ver", candidate_url: "https://u4-ver.example", reason: "verification_failed", parked_since: "2026-09-03 10:00:00" });
        seed({ id: "u4-ver-cand", navn: "U4 Verifisert Med Kandidat", hj: "https://u4-ver-cand.example" });
        queue({ provider_id: "u4-ver-cand", candidate_url: "https://u4-other-cand.example", reason: "website_discovery_candidate", confidence: 0.95 });
        seed({ id: "u4-ver-none", navn: "U4 Verifisert Uten Kø", hj: "https://u4-ver-none.example" });
        seed({ id: "u4-keep", navn: "U4 Behold Kandidat", hj: "https://u4-keep-own.example" });
        queue({ provider_id: "u4-keep", candidate_url: "https://u4-keep-candidate.example", reason: "website_discovery_candidate", confidence: 0.92 });
        seed({ id: "u4-keep-brreg", navn: "U4 Behold Brreg", hj: "https://u4-keep-brreg-own.example" });
        queue({ provider_id: "u4-keep-brreg", candidate_url: "https://u4-keep-brreg-candidate.example", reason: "brreg_registered_hjemmeside" });
        seed({ id: "u4-new", navn: "U4 Ny Rad", hj: "https://u4-new.example" });
        seed({ id: "u4-terminal", navn: "U4 Terminal", hj: "https://u4-terminal-own.example" });
        queue({ provider_id: "u4-terminal", candidate_url: "https://u4-terminal-old.example", reason: "candidate_evidence_failed" });
        seed({ id: "u4-parked-cand", navn: "U4 Parkert Kandidat", hj: "https://u4-parked-own.example" });
        queue({ provider_id: "u4-parked-cand", candidate_url: "https://u4-parked-candidate.example", reason: "website_discovery_candidate", parked_since: "2026-09-03 10:00:00" });
        seed({ id: "u4-same-url", navn: "U4 Samme Url", hj: "https://u4-same-url.example" });
        queue({ provider_id: "u4-same-url", candidate_url: "https://u4-same-url.example", reason: "website_discovery_candidate", confidence: 0.9 });

        const keepBefore = getQueueRow("u4-keep");
        const keepBrregBefore = getQueueRow("u4-keep-brreg");

        const { applied } = wvService.applyGardssalgWebsiteVerification(
          expDb,
          [
            row({ provider_id: "u4-ver", hjemmeside: "https://u4-ver.example", classification: "verified" }),
            row({ provider_id: "u4-ver-cand", hjemmeside: "https://u4-ver-cand.example", classification: "verified" }),
            row({ provider_id: "u4-ver-none", hjemmeside: "https://u4-ver-none.example", classification: "verified" }),
            row({ provider_id: "u4-keep", hjemmeside: "https://u4-keep-own.example", classification: "unverified" }),
            row({ provider_id: "u4-keep-brreg", hjemmeside: "https://u4-keep-brreg-own.example", classification: "unverified" }),
            row({ provider_id: "u4-new", hjemmeside: "https://u4-new.example", classification: "unverified" }),
            row({ provider_id: "u4-terminal", hjemmeside: "https://u4-terminal-own.example", classification: "unverified" }),
            row({ provider_id: "u4-parked-cand", hjemmeside: "https://u4-parked-own.example", classification: "unverified" }),
            row({ provider_id: "u4-same-url", hjemmeside: "https://u4-same-url.example", classification: "unverified" }),
          ],
          "u4-batch",
        );
        const byId = new Map(applied.map((a) => [a.provider_id, a]));

        // verified -> dequeued
        assertEq(getQueueRow("u4-ver"), undefined, "u4a: verified -> the (parked verification_failed) queue row is deleted");
        assertEq(byId.get("u4-ver")?.dequeued, true, "u4b: applied[].dequeued === true");
        assertEq(getQueueRow("u4-ver-cand"), undefined, "u4c: verified -> even an open candidate row is deleted (moot once verified)");
        assertEq(byId.get("u4-ver-cand")?.dequeued, true, "u4d: …dequeued === true");
        assertEq(byId.get("u4-ver-none")?.dequeued, false, "u4e: verified with no queue row -> dequeued === false");
        assertEq(byId.get("u4-ver")?.enqueued, false, "u4f: a verified row is never enqueued");

        // unverified + open candidate for another url -> kept
        assertEq(getQueueRow("u4-keep"), keepBefore, "u4g: unverified + open website_discovery_candidate for another url -> row kept byte-identical");
        assertEq(byId.get("u4-keep")?.enqueued, false, "u4h: …enqueued stays false");
        assertEq(getQueueRow("u4-keep-brreg"), keepBrregBefore, "u4i: unverified + open brreg_registered_hjemmeside for another url -> row kept byte-identical");
        assertEq(byId.get("u4-keep-brreg")?.enqueued, false, "u4j: …enqueued stays false");
        assertTrue(!("dequeued" in (byId.get("u4-keep") ?? {})), "u4k: dequeued is absent on non-verified rows");

        // unverified + no row -> inserted (unchanged)
        const newRow = getQueueRow("u4-new");
        assertEq([newRow?.reason, newRow?.candidate_url, newRow?.batch_id], ["verification_failed", "https://u4-new.example", "u4-batch"],
          "u4l: unverified + no row -> verification_failed row inserted (unchanged)");
        assertEq(byId.get("u4-new")?.enqueued, true, "u4m: …enqueued === true");

        // unverified + terminal / parked / same-url row -> refreshed (unchanged)
        const termRow = getQueueRow("u4-terminal");
        assertEq([termRow?.reason, termRow?.candidate_url], ["verification_failed", "https://u4-terminal-own.example"],
          "u4n: unverified + terminal row -> refreshed to verification_failed (unchanged)");
        const parkedRow = getQueueRow("u4-parked-cand");
        assertEq([parkedRow?.reason, parkedRow?.candidate_url, parkedRow?.parked_since], ["verification_failed", "https://u4-parked-own.example", "2026-09-03 10:00:00"],
          "u4o: a parked candidate is not open -> refreshed as before (parked_since preserved by the upsert)");
        const sameRow = getQueueRow("u4-same-url");
        assertEq(sameRow?.reason, "verification_failed", "u4p: open candidate for the SAME url as the failing hjemmeside -> refreshed as before");
      }

      // ═══ u5: staleness route ════════════════════════════════════════════
      expDb.prepare(`DELETE FROM gardssalg_website_review_queue`).run();
      {
        const callStaleness = (headers: Record<string, string> = auth) =>
          callRoute(router, { method: "GET", path: "/admin/gardssalg-review-queues-staleness", headers });

        {
          const r = await callStaleness();
          assertEq(r.status, 200, "u5a: empty queue -> 200");
          assertEq(r.body.website_review_queue_actionable?.count, 0, "u5b: empty -> actionable count 0");
          assertEq(r.body.website_review_queue_breakdown,
            { total: 0, parked: 0, open_candidates: 0, terminal: 0, for_non_gardssalg_providers: 0, for_website_verified_providers: 0 },
            "u5c: empty -> breakdown all zero");
        }

        seed({ id: "s-gs-open", navn: "S Åpen Gard" });
        queue({ provider_id: "s-gs-open", candidate_url: "https://s-gs-open.example", reason: "website_discovery_candidate", created_at: sqliteUtcDaysAgo(10) });
        seed({ id: "s-gs-brreg", navn: "S Brreg Gard", pt: null, seed: "rfb-seed" });
        queue({ provider_id: "s-gs-brreg", candidate_url: "https://s-gs-brreg.example", reason: "brreg_registered_hjemmeside", created_at: sqliteUtcDaysAgo(0) });
        seed({ id: "s-gs-terminal", navn: "S Terminal Gard" });
        queue({ provider_id: "s-gs-terminal", candidate_url: "https://s-gs-terminal.example", reason: "verification_failed", created_at: sqliteUtcDaysAgo(30) });
        seed({ id: "s-gs-parked", navn: "S Parkert Gard" });
        queue({ provider_id: "s-gs-parked", candidate_url: "https://s-gs-parked.example", reason: "candidate_evidence_failed", parked_since: "2026-09-03 10:00:00", created_at: sqliteUtcDaysAgo(40) });
        seed({ id: "s-gs-parked-open", navn: "S Parkert Åpen Gard" });
        queue({ provider_id: "s-gs-parked-open", candidate_url: "https://s-gs-parked-open.example", reason: "website_discovery_candidate", parked_since: "2026-09-03 10:00:00", created_at: sqliteUtcDaysAgo(40) });
        seed({ id: "s-nongs", navn: "S Golfklubb", pt: null, seed: null });
        queue({ provider_id: "s-nongs", candidate_url: "https://s-nongs.example", reason: "website_discovery_candidate", created_at: sqliteUtcDaysAgo(25) });
        seed({ id: "s-gs-verified", navn: "S Verifisert Gard", hj: "https://s-gs-verified.example", field_provenance: verifiedProvenance });
        queue({ provider_id: "s-gs-verified", candidate_url: "https://s-gs-verified-other.example", reason: "website_discovery_candidate", created_at: sqliteUtcDaysAgo(25) });
        seed({ id: "s-merged", navn: "S Sammenslått Gard", merged_into: "s-gs-open" });
        queue({ provider_id: "s-merged", candidate_url: "https://s-merged.example", reason: "website_discovery_candidate", created_at: sqliteUtcDaysAgo(25) });

        const r = await callStaleness();
        assertEq(r.status, 200, "u5d: populated queue -> 200");
        const wq = r.body.website_review_queue;
        const wqIds = ((wq?.oldest_first as any[]) ?? []).map((x) => x.provider_id).sort();
        assertEq(wq?.count, 6, "u5e: website_review_queue counts unparked rows only (8 total - 2 parked)");
        assertTrue(!wqIds.includes("s-gs-parked") && !wqIds.includes("s-gs-parked-open"), "u5f: neither parked row appears in website_review_queue");

        const act = r.body.website_review_queue_actionable;
        const actIds = ((act?.oldest_first as any[]) ?? []).map((x) => x.provider_id);
        assertEq(act?.count, 2, "u5g: actionable = open candidates of non-verified gårdssalg providers only");
        assertEq(actIds, ["s-gs-open", "s-gs-brreg"], "u5h: …s-gs-open (producer_type) + s-gs-brreg (rfb-seed), oldest first");
        assertEq(act?.stale_count, 1, "u5i: actionable stale_count counts only the >threshold row");
        assertEq(act?.stale_threshold_days, opplevelserModule.GS_VTP_QUEUE_STALE_DAYS, "u5j: same stale threshold as the other reports");

        const bd = r.body.website_review_queue_breakdown;
        assertEq(bd, { total: 8, parked: 2, open_candidates: 5, terminal: 1, for_non_gardssalg_providers: 2, for_website_verified_providers: 1 },
          "u5k: breakdown counts (non-gårdssalg = no producer_type/rfb-seed OR merged_into set)");
        assertEq(bd.parked + bd.open_candidates + bd.terminal, bd.total, "u5l: parked + open_candidates + terminal === total");
        assertEq(
          Object.keys(r.body).sort(),
          ["experience_homepage_review_queue", "orgnr_review_queue", "website_review_queue", "website_review_queue_actionable", "website_review_queue_breakdown"],
          "u5m: the three existing keys are kept, plus the two additive ones",
        );

        const noKey = await callStaleness({});
        assertEq(noKey.status, 403, "u5n: no X-Admin-Key -> 403");
      }

      // ═══ u6: cleanup route ══════════════════════════════════════════════
      expDb.prepare(`DELETE FROM gardssalg_website_review_queue`).run();
      {
        const PATH = "/admin/gardssalg-website-review-queue-cleanup";
        const cleanup = (body: any, headers: Record<string, string> = auth) => callRoute(router, { path: PATH, headers, body });

        assertEq((await cleanup({}, {})).status, 403, "u6a: POST without X-Admin-Key -> 403");

        const emptyDry = await cleanup({});
        assertEq(emptyDry.body, { dry_run: true, resolved: { count: 0, provider_ids: [] }, not_gardssalg: { count: 0, provider_ids: [] }, remaining_total: 0 },
          "u6b: empty queue dry-run -> zero no-op");
        const emptyApply = await cleanup({ apply: true });
        assertEq([emptyApply.status, emptyApply.body], [200, { dry_run: false, resolved: { count: 0, provider_ids: [] }, not_gardssalg: { count: 0, provider_ids: [] }, remaining_total: 0 }],
          "u6c: empty queue apply -> 200 zero no-op (never throws)");

        seed({ id: "c-resolved", navn: "C Løst Gard", hj: "https://c-resolved.example", field_provenance: verifiedProvenance });
        queue({ provider_id: "c-resolved", candidate_url: "https://c-resolved.example", reason: "verification_failed" });
        seed({ id: "c-resolved-parked", navn: "C Løst Parkert Gard", hj: "https://c-resolved-parked.example", field_provenance: verifiedProvenance });
        queue({ provider_id: "c-resolved-parked", candidate_url: "https://c-resolved-parked-old.example", reason: "candidate_evidence_failed", parked_since: "2026-09-03 10:00:00" });
        seed({ id: "c-nongs", navn: "C Golfklubb", pt: null });
        queue({ provider_id: "c-nongs", candidate_url: "https://c-nongs.example", reason: "verification_failed" });
        seed({ id: "c-nongs-verified", navn: "C Museum", pt: null, hj: "https://c-museum.example", field_provenance: verifiedProvenance });
        queue({ provider_id: "c-nongs-verified", candidate_url: "https://c-museum.example", reason: "verification_failed" });
        seed({ id: "c-nongs-parked", navn: "C Hotell", pt: null });
        queue({ provider_id: "c-nongs-parked", candidate_url: "https://c-hotell.example", reason: "candidate_evidence_failed", parked_since: "2026-09-03 10:00:00" });
        seed({ id: "c-keep-open", navn: "C Åpen Gard" });
        queue({ provider_id: "c-keep-open", candidate_url: "https://c-keep-open.example", reason: "website_discovery_candidate", confidence: 0.9 });
        seed({ id: "c-keep-terminal", navn: "C Terminal Gard", hj: "https://c-keep-terminal.example" });
        queue({ provider_id: "c-keep-terminal", candidate_url: "https://c-keep-terminal.example", reason: "verification_failed" });

        const snapshot = dumpQueue();
        const keepOpenBefore = getQueueRow("c-keep-open");
        const keepTerminalBefore = getQueueRow("c-keep-terminal");
        const nongsParkedBefore = getQueueRow("c-nongs-parked");
        const nongsBefore = getQueueRow("c-nongs");

        const dry = await cleanup({});
        assertEq(dry.status, 200, "u6d: dry-run -> 200");
        assertEq(dry.body.dry_run, true, "u6e: dry_run defaults true");
        assertEq([...dry.body.resolved.provider_ids].sort(), ["c-nongs-verified", "c-resolved", "c-resolved-parked"],
          "u6f: resolved = every row whose provider's hjemmeside is verified (parked or not, gårdssalg or not)");
        assertEq(dry.body.resolved.count, 3, "u6g: resolved.count");
        assertEq(dry.body.not_gardssalg, { count: 1, provider_ids: ["c-nongs"] },
          "u6h: not_gardssalg = unparked rows of non-gårdssalg providers (already-parked and verified ones excluded)");
        assertEq(dry.body.remaining_total, 4, "u6i: remaining_total projects 7 - 3 deleted");
        assertEq(dumpQueue(), snapshot, "u6j: dry-run writes nothing");
        assertEq((await cleanup({ apply: false })).body.dry_run, true, "u6k: apply:false is a dry-run");

        // write-pause: apply blocked, dry-run not
        const mainDb = init.getDb();
        pauseSvc.setEnrichmentWritePause(mainDb as any, { vertical: "experiences", enabled: true, reason: "u6 test" }, "verifier");
        const paused = await cleanup({ apply: true });
        assertEq(paused.status, 423, "u6l: apply under an experiences write-pause -> 423");
        assertEq(dumpQueue(), snapshot, "u6m: nothing written while paused");
        assertEq((await cleanup({})).status, 200, "u6n: dry-run is not blocked by the pause");
        pauseSvc.setEnrichmentWritePause(mainDb as any, { vertical: "experiences", enabled: false, cleared_by: "daniel" }, "verifier");

        const app = await cleanup({ apply: true });
        assertEq(app.status, 200, "u6o: apply -> 200");
        assertEq(app.body.dry_run, false, "u6p: dry_run false on apply");
        assertEq([...app.body.resolved.provider_ids].sort(), ["c-nongs-verified", "c-resolved", "c-resolved-parked"], "u6q: apply resolved ids match the dry-run");
        assertEq(app.body.not_gardssalg, { count: 1, provider_ids: ["c-nongs"] }, "u6r: apply not_gardssalg matches the dry-run");
        assertEq(app.body.remaining_total, 4, "u6s: remaining_total after apply");
        for (const id of ["c-resolved", "c-resolved-parked", "c-nongs-verified"]) {
          assertEq(getQueueRow(id), undefined, `u6t.${id}: resolved row deleted`);
        }
        const nongsAfter = getQueueRow("c-nongs");
        assertTrue(typeof nongsAfter?.parked_since === "string" && nongsAfter.parked_since.length > 0, "u6u: not_gardssalg row got parked_since stamped (not deleted)");
        assertEq({ ...nongsAfter, parked_since: null, updated_at: nongsBefore.updated_at }, nongsBefore,
          "u6v: …and nothing but parked_since/updated_at changed on it (reversible)");
        assertEq(getQueueRow("c-nongs-parked"), nongsParkedBefore, "u6w: an already-parked non-gårdssalg row is untouched");
        assertEq(getQueueRow("c-keep-open"), keepOpenBefore, "u6x: open candidate of an unverified gårdssalg provider untouched");
        assertEq(getQueueRow("c-keep-terminal"), keepTerminalBefore, "u6y: terminal row of an unverified gårdssalg provider untouched (left for veien-til-pool)");

        const afterFirst = dumpQueue();
        const again = await cleanup({ apply: true });
        assertEq(again.body, { dry_run: false, resolved: { count: 0, provider_ids: [] }, not_gardssalg: { count: 0, provider_ids: [] }, remaining_total: 4 },
          "u6z: second apply is a no-op");
        assertEq(dumpQueue(), afterFirst, "u6z2: second apply wrote nothing");

        // The two cleaned buckets are gone from the staleness alarm too.
        const st = await callRoute(router, { method: "GET", path: "/admin/gardssalg-review-queues-staleness", headers: auth });
        assertEq(st.body.website_review_queue?.count, 2, "u6z3: website_review_queue now counts only the 2 rows that matter (open + terminal)");
        assertEq(st.body.website_review_queue_actionable?.count, 1, "u6z4: actionable = the one open candidate");
      }

      // Sanity: the shared predicate itself.
      {
        const isOpen = expStore.isOpenGardssalgWebsiteCandidate;
        assertEq(isOpen({ reason: "website_discovery_candidate", parked_since: null }), true, "u7a: website_discovery_candidate unparked -> open");
        assertEq(isOpen({ reason: "brreg_registered_hjemmeside" }), true, "u7b: brreg_registered_hjemmeside, parked_since undefined -> open");
        assertEq(isOpen({ reason: "website_discovery_candidate", parked_since: "2026-09-03 10:00:00" }), false, "u7c: parked -> never open");
        assertEq(isOpen({ reason: "verification_failed", parked_since: null }), false, "u7d: terminal reason -> not open");
        assertEq(isOpen({ reason: "LLM judge AVVIS: x" }), false, "u7e: judge note -> not open");
        assertEq(isOpen(undefined), false, "u7f: no row -> not open");
      }
    } catch (err: any) {
      failed++;
      failures.push("opplevelser-gardssalg-website-queue-unblock: unexpected error: " + String(err?.stack || err?.message || err));
    } finally {
      globalThis.fetch = prevFetch;
      if (restoreMainDb) restoreMainDb();
      if (prevExperiencesDbPath === undefined) delete process.env.EXPERIENCES_DB_PATH;
      else process.env.EXPERIENCES_DB_PATH = prevExperiencesDbPath;
      if (prevAdminKey === undefined) delete process.env.ADMIN_KEY;
      else process.env.ADMIN_KEY = prevAdminKey;
      try {
        const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
        dbFactory.__resetDbFactoryForTesting();
      } catch {
        /* best-effort */
      }
      for (const p of cachePaths) delete require.cache[p];
    }

    return { passed, failed, failures };
  })();
}

// Standalone runner
if (require.main === module) {
  runOpplevelserGardssalgWebsiteQueueUnblockTests({ log: true }).then((s) => {
    console.log(`\nopplevelser-gardssalg-website-queue-unblock: ${s.passed} passed, ${s.failed} failed`);
    if (s.failed > 0) {
      console.log(s.failures.join("\n"));
      process.exit(1);
    }
    process.exit(0);
  });
}
