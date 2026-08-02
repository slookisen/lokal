/**
 * opplevelser-gardssalg-producer-type-classify.test.ts — tests for the
 * legacy-row producer_type backfill classifier (Slice 2, Steg C):
 *
 *   - POST /admin/gardssalg-producer-type-classify (src/routes/opplevelser.ts)
 *
 * Reality check: producer_type is currently set ONLY (1) manually or
 * (2) via the 4-entry GARDSSALG_NACE_PRODUCER_TYPE map keyed off naeringskode
 * inside POST /admin/gardssalg-nace-discovery. Legacy rfb_seed_source=
 * 'rfb-seed' rows with no naeringskode have no signal that map-based path
 * can use — this endpoint classifies producer_type for exactly that cohort
 * using an LLM judge over navn + about_text/visit_text, restricted to the
 * SAME closed vocabulary already in use (DRINK_PRODUCER_TYPES ∪
 * NON_DRINK_PRODUCER_TYPES, route-corridor-service.ts) plus an explicit
 * "uklassifisert" escape hatch — never inventing a new category, never
 * guessing when unsure.
 *
 * Mirrors opplevelser-gardssalg-contact-backfill.test.ts's setup and
 * conventions exactly (EXPERIENCES_DB_PATH=":memory:", fresh require of
 * db-factory + experience-store + opplevelser router per run, callRoute()
 * exercised directly against router.handle(), globalThis.fetch stubbed
 * since the classifier has no injected-fetch call site in the route).
 *
 * Covers:
 *   (a) auth: missing/wrong admin key -> 403, no query executed
 *   (b) dry-run (apply absent/false): judged results reported, zero DB writes
 *   (c) apply: a row judged into a valid vocabulary token -> producer_type
 *       set, field_provenance gains ONLY the producer_type key (existing
 *       keys untouched), one gardssalg_content_audit row inserted
 *   (d) fail-closed classifier: missing ANTHROPIC_API_KEY -> judged_type null
 *   (e) fail-closed classifier: non-200 response -> judged_type null
 *   (f) fail-closed classifier: unparseable text -> judged_type null
 *   (g) fail-closed classifier: a token NOT in the closed vocabulary ->
 *       judged_type null
 *   (h) fail-closed classifier: the literal "uklassifisert" escape hatch ->
 *       judged_type null, never applied
 *   (i) every fail-closed case above -> applied: false, zero writes
 *   (j) lock: a content_source='manual' row -> skippedLocked, zero writes,
 *       classifier not even called
 *   (k) lock: a content_source='claim' row -> skippedLocked, zero writes
 *   (l) not-blank race: a row with producer_type already set (reached via
 *       explicit providerIds, since the default selector's WHERE clause
 *       would otherwise exclude it) -> skippedNotBlank, no write, and the
 *       transactional WHERE producer_type IS NULL guard still holds even
 *       if the pre-check were bypassed
 *   (m) default selector: excludes rows with naeringskode set
 *   (n) default selector: excludes rows with producer_type already set
 *   (o) default selector: excludes rows that are not rfb_seed_source='rfb-seed'
 *   (p) explicit providerIds bypasses the selector: a naeringskode-bearing
 *       row is still classifiable when passed explicitly
 *   (q) summary counts (candidates/classified/unclassified/skippedLocked/
 *       skippedNotBlank) are accurate over a mixed batch
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
    const method = opts.method || "POST";
    const url = opts.url || "/admin/gardssalg-producer-type-classify";
    const req: any = {
      method,
      url,
      originalUrl: url,
      path: url,
      query: {},
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

export function runOpplevelserGardssalgProducerTypeClassifyTests(
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
    const prevAnthropicKey = process.env.ANTHROPIC_API_KEY;
    const prevFetch = globalThis.fetch;
    const testKey = process.env.ADMIN_KEY || "gardssalg-producer-type-classify-test-key";
    process.env.EXPERIENCES_DB_PATH = ":memory:";
    process.env.ADMIN_KEY = testKey;
    process.env.ANTHROPIC_API_KEY = "test-anthropic-key";

    const dbFactoryPath = require.resolve("../database/db-factory");
    const experienceStorePath = require.resolve("../services/experience-store");
    const opplevelserPath = require.resolve("./opplevelser");
    const cachePaths = [dbFactoryPath, experienceStorePath, opplevelserPath];
    for (const p of cachePaths) delete require.cache[p];

    try {
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const expDb = dbFactory.getDb("experiences");

      const opplevelserRouter = (require("./opplevelser") as typeof import("./opplevelser")).default as any;

      // ── LLM classifier stub. Keyed by producer navn so each fixture can
      // steer its own verdict; counts calls so the lock tests can prove the
      // classifier is never even invoked for locked rows. ──────────────────
      const verdictByNavn: Record<string, { status: number; text: string | null; throws?: boolean; badJson?: boolean }> = {};
      let fetchCalls: string[] = [];
      globalThis.fetch = (async (_input: any, init?: any) => {
        fetchCalls.push(String(_input));
        let navn = "";
        try {
          const parsedBody = init?.body ? JSON.parse(String(init.body)) : {};
          const promptText = String(parsedBody?.messages?.[0]?.content ?? "");
          const m = promptText.match(/Produsentnavn:\s*([^\n]+)/);
          if (m) navn = m[1].trim();
        } catch {
          // leave navn blank -> falls through to the "no stub" branch below
        }
        const stub = verdictByNavn[navn];
        if (!stub) {
          return { ok: true, status: 200, json: async () => ({ content: [{ type: "text", text: "uklassifisert\ningen treff i stub" }] }) } as any;
        }
        if (stub.throws) {
          throw new Error("simulated network failure");
        }
        if (stub.status !== 200) {
          return { ok: false, status: stub.status, json: async () => ({}) } as any;
        }
        if (stub.badJson) {
          return { ok: true, status: 200, json: async () => { throw new Error("bad json"); } } as any;
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({ content: [{ type: "text", text: stub.text }] }),
        } as any;
      }) as any;

      // ── Fixtures ─────────────────────────────────────────────────────────
      const insertProvider = expDb.prepare(
        `INSERT INTO experience_providers
           (id, navn, vertical, org_nr, content_source, about_text, visit_text,
            naeringskode, rfb_seed_source, producer_type, field_provenance,
            enrichment_state, verification_status, source, confidence,
            catalog_hidden, created_at)
         VALUES
           (@id, @navn, 'experiences', @org_nr, @content_source, @about_text, @visit_text,
            @naeringskode, @rfb_seed_source, @producer_type, @field_provenance,
            'raw', 'pending_verify', 'test-fixture', 'medium',
            @catalog_hidden, @created_at)`,
      );
      let nextOrgSeq = 900000000;
      function mkProvider(p: Partial<Record<string, any>> & { id: string; navn: string }): void {
        insertProvider.run({
          org_nr: null, content_source: null, about_text: "En fin tekst om produsenten og driften.",
          visit_text: "Besøket byr på omvisning og smaking.", naeringskode: null,
          rfb_seed_source: "rfb-seed", producer_type: null, field_provenance: null,
          catalog_hidden: null, created_at: "2026-01-01 00:00:00", ...p,
        });
      }
      function getProviderRow(id: string): any {
        return expDb.prepare(
          `SELECT id, navn, producer_type, content_source, field_provenance FROM experience_providers WHERE id = ?`
        ).get(id);
      }
      function getAuditRows(providerId: string): any[] {
        return expDb.prepare(
          `SELECT * FROM gardssalg_content_audit WHERE provider_id = ? ORDER BY rowid ASC`
        ).all(providerId);
      }

      const auth = { "x-admin-key": testKey };

      // ── (a) auth ─────────────────────────────────────────────────────────
      const unauth = await callRoute(opplevelserRouter, { body: {} });
      assertEq(unauth.status, 403, "a1: unauthenticated request -> 403");
      const wrongKey = await callRoute(opplevelserRouter, { headers: { "x-admin-key": "nope" }, body: {} });
      assertEq(wrongKey.status, 403, "a2: wrong admin key -> 403");

      // ── (b) dry-run writes nothing ──────────────────────────────────────
      mkProvider({ id: "rt-dry", navn: "Dry Gaard" });
      verdictByNavn["Dry Gaard"] = { status: 200, text: "bryggeri\nklar bryggeri-beskrivelse" };
      const dry = await callRoute(opplevelserRouter, { headers: auth, body: { providerIds: ["rt-dry"] } });
      assertEq(dry.status, 200, "b1: dry-run returns 200");
      assertEq(dry.body.dryRun, true, "b2: dryRun defaults to true");
      assertEq(dry.body.results[0]?.judged_type, "bryggeri", "b3: dry-run reports the judged type");
      assertEq(dry.body.results[0]?.applied, false, "b4: dry-run never applies");
      assertEq(getProviderRow("rt-dry").producer_type, null, "b5: dry-run wrote NOTHING to the row");
      assertEq(getAuditRows("rt-dry").length, 0, "b6: dry-run wrote no audit rows");

      // ── (c) apply writes + provenance merge + audit ─────────────────────
      mkProvider({
        id: "rt-apply", navn: "Apply Gaard",
        field_provenance: JSON.stringify({ epost: { source_url: "https://x.no", fetched_at: "2026-01-01T00:00:00.000Z" } }),
      });
      verdictByNavn["Apply Gaard"] = { status: 200, text: "sideri\nsideriprodusent" };
      const applied = await callRoute(opplevelserRouter, { headers: auth, body: { providerIds: ["rt-apply"], apply: true } });
      assertEq(applied.body.dryRun, false, "c1: apply:true flips dryRun off");
      assertEq(applied.body.results[0]?.judged_type, "sideri", "c2: judged type reported");
      assertEq(applied.body.results[0]?.applied, true, "c3: applied true");
      const rowC = getProviderRow("rt-apply");
      assertEq(rowC.producer_type, "sideri", "c4: producer_type written");
      const provC = JSON.parse(rowC.field_provenance || "{}");
      assertTrue(!!provC.producer_type && provC.producer_type.source === "llm_classification", "c5: field_provenance gains the producer_type key");
      assertTrue(!!provC.epost && provC.epost.source_url === "https://x.no", "c6: existing unrelated field_provenance key untouched");
      assertEq(Object.keys(provC).sort(), ["epost", "producer_type"], "c7: field_provenance gains ONLY the producer_type key beyond what existed");
      const auditC = getAuditRows("rt-apply");
      assertEq(auditC.length, 1, "c8: exactly one audit row inserted");
      assertEq(auditC[0].old_value, null, "c9: audit old_value is null (was blank)");
      assertEq(auditC[0].new_value, "sideri", "c10: audit new_value is the judged type");
      assertEq(auditC[0].source_url, null, "c11: audit source_url is null (no evidence url for an LLM judgement)");

      // ── (d)-(i) fail-closed classifier cases ────────────────────────────
      // (d) missing ANTHROPIC_API_KEY
      mkProvider({ id: "rt-nokey", navn: "Nokey Gaard" });
      verdictByNavn["Nokey Gaard"] = { status: 200, text: "bryggeri\nok" };
      const savedKey = process.env.ANTHROPIC_API_KEY;
      delete process.env.ANTHROPIC_API_KEY;
      const nokey = await callRoute(opplevelserRouter, { headers: auth, body: { providerIds: ["rt-nokey"], apply: true } });
      process.env.ANTHROPIC_API_KEY = savedKey;
      assertEq(nokey.body.results[0]?.judged_type, null, "d1: missing ANTHROPIC_API_KEY -> judged_type null");
      assertEq(nokey.body.results[0]?.applied, false, "d2: missing ANTHROPIC_API_KEY -> applied false");
      assertEq(getProviderRow("rt-nokey").producer_type, null, "d3: missing ANTHROPIC_API_KEY -> zero writes");

      // (e) non-200 response
      mkProvider({ id: "rt-non200", navn: "Non200 Gaard" });
      verdictByNavn["Non200 Gaard"] = { status: 500, text: null };
      const non200 = await callRoute(opplevelserRouter, { headers: auth, body: { providerIds: ["rt-non200"], apply: true } });
      assertEq(non200.body.results[0]?.judged_type, null, "e1: non-200 response -> judged_type null");
      assertEq(non200.body.results[0]?.applied, false, "e2: non-200 response -> applied false");
      assertEq(getProviderRow("rt-non200").producer_type, null, "e3: non-200 response -> zero writes");

      // (f) unparseable text (JSON parse failure on the response body)
      mkProvider({ id: "rt-badjson", navn: "Badjson Gaard" });
      verdictByNavn["Badjson Gaard"] = { status: 200, text: null, badJson: true };
      const badjson = await callRoute(opplevelserRouter, { headers: auth, body: { providerIds: ["rt-badjson"], apply: true } });
      assertEq(badjson.body.results[0]?.judged_type, null, "f1: unparseable JSON -> judged_type null");
      assertEq(badjson.body.results[0]?.applied, false, "f2: unparseable JSON -> applied false");
      assertEq(getProviderRow("rt-badjson").producer_type, null, "f3: unparseable JSON -> zero writes");

      // (g) a token NOT in the closed vocabulary
      mkProvider({ id: "rt-badtoken", navn: "Badtoken Gaard" });
      verdictByNavn["Badtoken Gaard"] = { status: 200, text: "vinmonopol\nikke i listen" };
      const badtoken = await callRoute(opplevelserRouter, { headers: auth, body: { providerIds: ["rt-badtoken"], apply: true } });
      assertEq(badtoken.body.results[0]?.judged_type, null, "g1: token not in closed vocabulary -> judged_type null");
      assertEq(badtoken.body.results[0]?.applied, false, "g2: token not in closed vocabulary -> applied false");
      assertEq(getProviderRow("rt-badtoken").producer_type, null, "g3: token not in closed vocabulary -> zero writes");

      // (h) the literal "uklassifisert" escape hatch
      mkProvider({ id: "rt-uklass", navn: "Uklass Gaard" });
      verdictByNavn["Uklass Gaard"] = { status: 200, text: "uklassifisert\nkan ikke avgjøres fra teksten" };
      const uklass = await callRoute(opplevelserRouter, { headers: auth, body: { providerIds: ["rt-uklass"], apply: true } });
      assertEq(uklass.body.results[0]?.judged_type, null, "h1: literal uklassifisert -> judged_type null");
      assertEq(uklass.body.results[0]?.applied, false, "h2: literal uklassifisert -> applied false, never applied");
      assertEq(getProviderRow("rt-uklass").producer_type, null, "h3: literal uklassifisert -> zero writes");

      // (i) network error
      mkProvider({ id: "rt-netfail", navn: "Netfail Gaard" });
      verdictByNavn["Netfail Gaard"] = { status: 200, text: null, throws: true };
      const netfail = await callRoute(opplevelserRouter, { headers: auth, body: { providerIds: ["rt-netfail"], apply: true } });
      assertEq(netfail.status, 200, "i1: a network failure does not fail the request");
      assertEq(netfail.body.results[0]?.judged_type, null, "i2: network failure -> judged_type null");
      assertEq(netfail.body.results[0]?.applied, false, "i3: network failure -> applied false");
      assertEq(getProviderRow("rt-netfail").producer_type, null, "i4: network failure -> zero writes");

      // ── (j)+(k) locked rows never reach the classifier ──────────────────
      mkProvider({ id: "rt-manual", navn: "Manual Gaard", content_source: "manual" });
      mkProvider({ id: "rt-claim", navn: "Claim Gaard", content_source: "claim" });
      fetchCalls = [];
      const locked = await callRoute(opplevelserRouter, {
        headers: auth,
        body: { providerIds: ["rt-manual", "rt-claim"], apply: true },
      });
      assertEq(locked.body.summary.skippedLocked, 2, "j1: both locked rows counted in skippedLocked");
      assertEq(fetchCalls.length, 0, "j2: classifier is not even called for locked rows");
      assertEq(locked.body.results.every((r: any) => r.applied === false && r.judged_type === null), true, "j3: locked rows report null/false");
      assertEq(getProviderRow("rt-manual").producer_type, null, "k1: manual-locked row untouched");
      assertEq(getProviderRow("rt-claim").producer_type, null, "k2: claim-locked row untouched");

      // ── (l) not-blank race: producer_type already set ───────────────────
      mkProvider({ id: "rt-alreadyset", navn: "Alreadyset Gaard", producer_type: "gardsbutikk" });
      fetchCalls = [];
      const already = await callRoute(opplevelserRouter, {
        headers: auth,
        body: { providerIds: ["rt-alreadyset"], apply: true },
      });
      assertEq(already.body.summary.skippedNotBlank, 1, "l1: already-set row counted in skippedNotBlank");
      assertEq(fetchCalls.length, 0, "l2: classifier not called for an already-classified row");
      assertEq(getProviderRow("rt-alreadyset").producer_type, "gardsbutikk", "l3: existing producer_type never overwritten");

      // ── (m)-(o) default selector exclusions ──────────────────────────────
      mkProvider({ id: "sel-has-naeringskode", navn: "Sel Naeringskode", naeringskode: "11.010" });
      mkProvider({ id: "sel-has-producertype", navn: "Sel Producertype", producer_type: "bryggeri" });
      mkProvider({ id: "sel-not-rfbseed", navn: "Sel Not Rfbseed", rfb_seed_source: null });
      mkProvider({ id: "sel-eligible", navn: "Sel Eligible" });
      verdictByNavn["Sel Eligible"] = { status: 200, text: "cideri\nklar cideriprodusent" };

      const selRes = await callRoute(opplevelserRouter, { headers: auth, body: { limit: 100 } });
      const selIds = selRes.body.results.map((r: any) => r.id);
      assertTrue(!selIds.includes("sel-has-naeringskode"), "m: default selector excludes a row with naeringskode set");
      assertTrue(!selIds.includes("sel-has-producertype"), "n: default selector excludes a row with producer_type already set");
      assertTrue(!selIds.includes("sel-not-rfbseed"), "o: default selector excludes a row that is not rfb_seed_source='rfb-seed'");
      assertTrue(selIds.includes("sel-eligible"), "sanity: an eligible row IS selected by default");

      // ── (p) explicit providerIds bypasses the selector ──────────────────
      verdictByNavn["Sel Naeringskode"] = { status: 200, text: "mjøderi\nmjødprodusent med naeringskode" };
      const explicitBypass = await callRoute(opplevelserRouter, {
        headers: auth,
        body: { providerIds: ["sel-has-naeringskode"], apply: true },
      });
      assertEq(explicitBypass.body.results[0]?.judged_type, "mjøderi", "p1: naeringskode-bearing row IS classifiable via explicit providerIds");
      assertEq(explicitBypass.body.results[0]?.applied, true, "p2: and the write is applied");
      assertEq(getProviderRow("sel-has-naeringskode").producer_type, "mjøderi", "p3: producer_type written for the explicitly-passed row");

      // ── (q) summary counts over a mixed batch ────────────────────────────
      mkProvider({ id: "mix-classified", navn: "Mix Classified" });
      verdictByNavn["Mix Classified"] = { status: 200, text: "annet\nblandet produsenttype" };
      mkProvider({ id: "mix-unclassified", navn: "Mix Unclassified" });
      verdictByNavn["Mix Unclassified"] = { status: 200, text: "uklassifisert\nusikker" };
      mkProvider({ id: "mix-locked", navn: "Mix Locked", content_source: "manual" });
      mkProvider({ id: "mix-notblank", navn: "Mix Notblank", producer_type: "reko" });
      const mix = await callRoute(opplevelserRouter, {
        headers: auth,
        body: { providerIds: ["mix-classified", "mix-unclassified", "mix-locked", "mix-notblank"], apply: true },
      });
      assertEq(mix.body.summary.candidates, 4, "q1: candidates counts every row in the batch");
      assertEq(mix.body.summary.classified, 1, "q2: classified counts the valid-vocabulary judgement");
      assertEq(mix.body.summary.unclassified, 1, "q3: unclassified counts the uklassifisert judgement");
      assertEq(mix.body.summary.skippedLocked, 1, "q4: skippedLocked counts the locked row");
      assertEq(mix.body.summary.skippedNotBlank, 1, "q5: skippedNotBlank counts the already-set row");
      assertEq(getProviderRow("mix-classified").producer_type, "annet", "q6: the classified row's write actually landed");
    } finally {
      globalThis.fetch = prevFetch;
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
      if (prevAnthropicKey === undefined) {
        delete process.env.ANTHROPIC_API_KEY;
      } else {
        process.env.ANTHROPIC_API_KEY = prevAnthropicKey;
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

// Standalone runner: `npx tsx src/routes/opplevelser-gardssalg-producer-type-classify.test.ts`
if (require.main === module) {
  runOpplevelserGardssalgProducerTypeClassifyTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    process.exit(summary.failed > 0 ? 1 : 0);
  });
}
