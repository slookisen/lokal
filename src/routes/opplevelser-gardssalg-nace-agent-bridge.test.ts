/**
 * opplevelser-gardssalg-nace-agent-bridge.test.ts — tests for dev-request
 * 2026-08-27-nace-til-drikkefunnel-bro, Skive 1:
 * POST /admin/gardssalg-nace-agent-bridge (src/routes/opplevelser.ts).
 *
 * The route bridges drink-NACE agents already registered via POST
 * /admin/agents/register (routes/admin-agents.ts, which lands them ONLY in
 * `agents`/`agent_knowledge`) into `experience_providers`, so the
 * drikkefunnel pipelines (which read exclusively from experience_providers)
 * can see them. Dry-run by default; org_nr-primary / name+postal-fallback
 * dedup; blocklist-respecting; fill-only (skip on any match, never
 * overwrite); new rows born catalog_hidden=1; batch-tagged via
 * rfb_seed_source for one-operation rollback — same conventions as the
 * sibling POST /admin/gardssalg-nace-discovery and POST /admin/rfb-seed
 * levers in the same file.
 *
 * Harness: fresh in-memory RFB db (agents/agent_knowledge/agent_blocklist,
 * via database/init's __setDbForTesting/__initSchemaForTesting — the SAME
 * global singleton routes/opplevelser.ts's own getRfbDb()/getDb() reads) +
 * fresh in-memory EXPERIENCES db (db-factory). Conventions copied from
 * opplevelser-gardssalg-nace-discovery.test.ts and
 * opplevelser-gardssalg-outreach-candidates.test.ts.
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
  opts: { method?: string; url?: string; query?: Record<string, string>; headers?: Record<string, string>; body?: any } = {},
): Promise<RouteResult> {
  return new Promise((resolve) => {
    const method = opts.method || "POST";
    const query = opts.query || {};
    const qs = Object.entries(query)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join("&");
    const basePath = opts.url || "/admin/gardssalg-nace-agent-bridge";
    const url = basePath + (qs ? `?${qs}` : "");
    const req: any = {
      method,
      url,
      originalUrl: url,
      path: basePath,
      query,
      headers: opts.headers || {},
      body: opts.body ?? {},
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

export function runOpplevelserGardssalgNaceAgentBridgeTests(
  log = false,
): Promise<TestSummary> {
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];

  function assertEq(actual: unknown, expected: unknown, label: string): void {
    if (JSON.stringify(actual) === JSON.stringify(expected)) {
      passed++;
      if (log) console.log(`  ✓ ${label}`);
    } else {
      failed++;
      failures.push(`✗ ${label} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
      if (log) console.log(`  ✗ ${label}`);
    }
  }
  function assertTrue(cond: boolean, label: string): void {
    if (cond) {
      passed++;
      if (log) console.log(`  ✓ ${label}`);
    } else {
      failed++;
      failures.push(`✗ ${label}`);
      if (log) console.log(`  ✗ ${label}`);
    }
  }

  return (async () => {
    const prevExperiencesDbPath = process.env.EXPERIENCES_DB_PATH;
    const prevAdminKey = process.env.ADMIN_KEY;
    const testKey = process.env.ADMIN_KEY || "nace-agent-bridge-test-key";
    process.env.EXPERIENCES_DB_PATH = ":memory:";
    process.env.ADMIN_KEY = testKey;

    // Deliberately does NOT clear require.cache for "../database/init" — see
    // opplevelser-gardssalg-outreach-candidates.test.ts's own comment: the
    // module's `db` singleton must stay the SAME instance every already-
    // loaded file resolves to.
    const dbFactoryPath = require.resolve("../database/db-factory");
    const blocklistPath = require.resolve("../services/blocklist-service");
    const opplevelserPath = require.resolve("./opplevelser");
    const cachePaths = [dbFactoryPath, blocklistPath, opplevelserPath];
    for (const p of cachePaths) delete require.cache[p];

    let prevRfbDb: any = null;

    try {
      try {
        (require("../config/vertical-config") as typeof import("../config/vertical-config")).loadConfigsAtBoot();
      } catch {
        /* already loaded by an earlier suite in the same process */
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
      const opplevelserRouter = (require("./opplevelser") as typeof import("./opplevelser")).default as any;
      const auth = { "x-admin-key": testKey };

      // ── Fixture helpers ─────────────────────────────────────────────────
      let apiKeySeq = 0;
      const insertAgentStmt = rfbDb.prepare(`
        INSERT INTO agents
          (id, name, description, provider, contact_email, url, role, api_key,
           city, categories, tags, is_active, is_verified, vertical_id, org_nr, brreg_verified)
        VALUES
          (@id, @name, 'test agent', @name, 'test@example.no', @url, 'producer', @api_key,
           @city, '[]', @tags, @is_active, 0, 'rfb', @org_nr, @brreg_verified)
      `);
      function insertAgent(a: {
        id: string; name: string; url?: string; city?: string | null;
        naceCode?: string; orgNr?: string | null; isActive?: 0 | 1; brregVerified?: 0 | 1;
      }): void {
        apiKeySeq++;
        const tags = a.naceCode ? JSON.stringify([`nace:${a.naceCode}`]) : "[]";
        insertAgentStmt.run({
          id: a.id,
          name: a.name,
          url: a.url ?? "https://example.no",
          api_key: `test-key-${apiKeySeq}`,
          city: a.city ?? null,
          tags,
          is_active: a.isActive ?? 1,
          org_nr: a.orgNr ?? null,
          brreg_verified: a.brregVerified ?? 0,
        });
      }
      const insertKnowledgeStmt = rfbDb.prepare(`
        INSERT INTO agent_knowledge (agent_id, address, postal_code, website, phone, email)
        VALUES (@agent_id, @address, @postal_code, @website, @phone, @email)
      `);
      function insertKnowledge(agentId: string, k: {
        address?: string | null; postal_code?: string | null; website?: string | null; phone?: string | null; email?: string | null;
      }): void {
        insertKnowledgeStmt.run({
          agent_id: agentId,
          address: k.address ?? null,
          postal_code: k.postal_code ?? null,
          website: k.website ?? null,
          phone: k.phone ?? null,
          email: k.email ?? null,
        });
      }
      const insertProviderStmt = expDb.prepare(`
        INSERT INTO experience_providers
          (id, navn, vertical, org_nr, postnummer, catalog_hidden, content_source, about_text, producer_type,
           enrichment_state, verification_status, source, confidence)
        VALUES
          (@id, @navn, 'experiences', @org_nr, @postnummer, @catalog_hidden, @content_source, @about_text, @producer_type,
           'raw', 'pending_verify', 'test-fixture', 'medium')
      `);
      function countProviders(): number {
        return (expDb.prepare(`SELECT COUNT(*) AS n FROM experience_providers`).get() as { n: number }).n;
      }
      function getProviderByOrgNr(orgNr: string): any {
        return expDb.prepare(`SELECT * FROM experience_providers WHERE org_nr = ?`).get(orgNr);
      }
      function getProviderByNavn(navn: string): any {
        return expDb.prepare(`SELECT * FROM experience_providers WHERE navn = ?`).get(navn);
      }

      // ═══ Fixtures ══════════════════════════════════════════════════════
      // Bridgeable, org_nr-keyed drink agent (bryggeri, 11.050) with full
      // contact info on agent_knowledge.
      insertAgent({ id: "agent-brew", name: "Bro Bryggeri", url: "https://ignored-fallback.example.no", city: "Oslo", naceCode: "11.050", orgNr: "911111111" });
      insertKnowledge("agent-brew", {
        address: "Bryggerivegen 1", postal_code: "0150", website: "https://bro-bryggeri.example.no",
        phone: "12345678", email: "post@bro-bryggeri.example.no",
      });

      // Bridgeable, org_nr-LESS drink agent (vingård, 11.020) — website falls
      // back to agents.url since agent_knowledge has no website of its own.
      insertAgent({ id: "agent-vin", name: "Fjordbobler Vineri", url: "https://fjordbobler.example.no", city: "Stranda", naceCode: "11.020" });
      insertKnowledge("agent-vin", { postal_code: "6200" });

      // Non-drink NACE agent — must never be scanned at all (excluded by the
      // route's own WHERE tags LIKE prefilter, not merely skipped later).
      insertAgent({ id: "agent-nondrink", name: "Vanlig Gardsbutikk", naceCode: "47.220" });

      // Blocklisted drink agent (destilleri, 11.010) — must never be created.
      insertAgent({ id: "agent-blocked", name: "Blokkert Destilleri", naceCode: "11.010", orgNr: "922222222" });
      blocklistSvc.add({ orgNr: "922222222", reason: "test-fixture-block" });

      // org_nr-duplicate drink agent (sideri, 11.030) — a CLAIMED provider
      // already holds this org_nr; must be skipped, and that row must be
      // byte-identical afterwards (never overwritten).
      insertAgent({ id: "agent-dup-orgnr", name: "Allerede Krevd Sideri (ny navn)", naceCode: "11.030", orgNr: "933333333" });
      insertProviderStmt.run({
        id: "prov-claimed-orgnr", navn: "Allerede Krevd Sideri", org_nr: "933333333", postnummer: "5000",
        catalog_hidden: 0, content_source: "claim", about_text: "Skrevet av eier.", producer_type: "sideri",
      });

      // Name+postal-duplicate, org_nr-LESS drink agent (mjøderi, 11.040) — a
      // MANUALLY-edited provider already exists with the same name (mixed
      // case) + postal code; must be skipped via the fallback dedup key, and
      // that row must also be byte-identical afterwards.
      insertAgent({ id: "agent-dup-namepostal", name: "Navnedublett Mjød", naceCode: "11.040" });
      insertKnowledge("agent-dup-namepostal", { postal_code: "1234" });
      insertProviderStmt.run({
        id: "prov-manual-namepostal", navn: "NAVNEDUBLETT MJØD", org_nr: null, postnummer: "1234",
        catalog_hidden: 0, content_source: "manual", about_text: "Manuelt redigert.", producer_type: "mjøderi",
      });

      // Inactive drink agent — must never be scanned (is_active=0).
      insertAgent({ id: "agent-inactive", name: "Inaktiv Bryggeri", naceCode: "11.050", orgNr: "944444444", isActive: 0 });

      const baselineProviderCount = countProviders(); // the two pre-seeded fixtures above
      assertEq(baselineProviderCount, 2, "setup: two pre-seeded experience_providers fixtures");

      // ── nab-1: auth ──────────────────────────────────────────────────────
      {
        const r = await callRoute(opplevelserRouter, { body: {} });
        assertEq(r.status, 403, "nab-1: no admin key -> 403");
      }

      // ── nab-2: DRY-RUN — scan/buckets, nothing written ──────────────────
      let dryRunBatchTag = "";
      {
        const r = await callRoute(opplevelserRouter, { headers: auth, body: {} });
        assertEq(r.status, 200, "nab-2a: dry-run 200");
        assertEq(r.body.dry_run, true, "nab-2b: dry-run is the default (no apply flag)");
        assertEq(r.body.scanned, 5, "nab-2c: exactly the 5 active drink-NACE agents are scanned (non-drink + inactive excluded)");
        assertEq(r.body.created_count, 2, "nab-2d: exactly 2 bridgeable candidates (brew, vin)");
        assertEq(r.body.skipped_duplicate_count, 2, "nab-2e: 2 skipped as duplicates (org_nr-dup, name+postal-dup)");
        assertEq(r.body.skipped_blocklisted_count, 1, "nab-2f: 1 skipped as blocklisted");
        assertTrue(String(r.body.batch_tag).startsWith("nace-agent-bridge-"), "nab-2g: batch_tag carries the route's own prefix");
        dryRunBatchTag = r.body.batch_tag;

        const brewCandidate = (r.body.created as any[]).find((c) => c.agent_id === "agent-brew");
        assertTrue(!!brewCandidate, "nab-2h: agent-brew is among the dry-run candidates");
        assertEq(brewCandidate?.org_nr, "911111111", "nab-2i: candidate carries the agent's org_nr");
        assertEq(brewCandidate?.producer_type, "bryggeri", "nab-2j: NACE 11.050 -> bryggeri");
        assertEq(brewCandidate?.nace_code, "11.050", "nab-2k: nace_code reported");
        assertTrue(!brewCandidate?.provider_id, "nab-2l: dry-run candidate carries no provider_id (nothing created)");

        const vinCandidate = (r.body.created as any[]).find((c) => c.agent_id === "agent-vin");
        assertTrue(!!vinCandidate, "nab-2m: agent-vin is among the dry-run candidates");
        assertEq(vinCandidate?.org_nr, null, "nab-2n: org_nr-less candidate reported as null, not fabricated");
        assertEq(vinCandidate?.producer_type, "vingård", "nab-2o: NACE 11.020 -> vingård");

        const blockedEntry = (r.body.skipped_blocklisted as any[]).find((c) => c.agent_id === "agent-blocked");
        assertTrue(!!blockedEntry, "nab-2p: agent-blocked reported under skipped_blocklisted");
        assertEq(blockedEntry?.matched_by, "org_nr", "nab-2q: blocklist match reported as org_nr");

        assertEq(countProviders(), baselineProviderCount, "nab-2r: dry-run writes NOTHING to experience_providers");
      }

      // ── nab-3: APPLY — create exactly the 2 bridgeable rows ─────────────
      let applyBatchTag = "";
      {
        const r = await callRoute(opplevelserRouter, { headers: auth, body: { apply: true } });
        assertEq(r.status, 200, "nab-3a: apply 200");
        assertEq(r.body.dry_run, false, "nab-3b: apply mode reported");
        assertEq(r.body.created_count, 2, "nab-3c: 2 rows created");
        applyBatchTag = r.body.batch_tag;

        // ── acceptance criterion 1: exact count increase, no false increases ──
        assertEq(countProviders(), baselineProviderCount + 2, "nab-3d: experience_providers count increased by EXACTLY 2");

        // ── new bryggeri row: full field mapping ────────────────────────────
        const brewRow = getProviderByOrgNr("911111111");
        assertTrue(!!brewRow, "nab-3e: bryggeri row exists, org_nr-keyed");
        assertEq(brewRow.navn, "Bro Bryggeri", "nab-3f: navn");
        assertEq(brewRow.adresse, "Bryggerivegen 1", "nab-3g: adresse from agent_knowledge.address");
        assertEq(brewRow.postnummer, "0150", "nab-3h: postnummer from agent_knowledge.postal_code");
        assertEq(brewRow.poststed, "Oslo", "nab-3i: poststed falls back to agents.city");
        assertEq(brewRow.kommune, "Oslo", "nab-3j: kommune falls back to agents.city");
        assertEq(brewRow.hjemmeside, "https://bro-bryggeri.example.no", "nab-3k: hjemmeside from agent_knowledge.website (not the agents.url fallback)");
        assertEq(brewRow.telefon, "12345678", "nab-3l: telefon from agent_knowledge.phone");
        assertEq(brewRow.epost, "post@bro-bryggeri.example.no", "nab-3m: epost from agent_knowledge.email");
        assertEq(brewRow.naeringskode, "11.050", "nab-3n: naeringskode stamped");
        assertEq(brewRow.producer_type, "bryggeri", "nab-3o: producer_type stamped");
        assertEq(brewRow.source, "nace-agent-bridge", "nab-3p: source tags this route as origin");

        // ── acceptance criterion 5: born catalog_hidden ─────────────────────
        assertEq(brewRow.catalog_hidden, 1, "nab-3q: new row is catalog_hidden=1");
        assertEq(brewRow.rfb_seed_source, applyBatchTag, "nab-3r: rfb_seed_source carries this run's batch tag");

        // ── new vingård row: org_nr-less, website falls back to agents.url ──
        const vinRow = getProviderByNavn("Fjordbobler Vineri");
        assertTrue(!!vinRow, "nab-3s: vingård row exists");
        assertEq(vinRow.org_nr, null, "nab-3t: no org_nr fabricated for an org_nr-less agent");
        assertEq(vinRow.postnummer, "6200", "nab-3u: postnummer from agent_knowledge");
        assertEq(vinRow.hjemmeside, "https://fjordbobler.example.no", "nab-3v: hjemmeside falls back to agents.url when agent_knowledge.website is absent");
        assertEq(vinRow.producer_type, "vingård", "nab-3w: NACE 11.020 -> vingård");
        assertEq(vinRow.catalog_hidden, 1, "nab-3x: also born catalog_hidden=1");

        // ── acceptance criterion 3/4: blocklisted org_nr never created ──────
        assertTrue(!getProviderByOrgNr("922222222"), "nab-3y: blocklisted org_nr never appears in experience_providers");

        // ── acceptance criterion 4: claimed/manual rows byte-identical ──────
        const claimedRow = expDb.prepare(`SELECT * FROM experience_providers WHERE id = 'prov-claimed-orgnr'`).get() as any;
        assertEq(claimedRow.content_source, "claim", "nab-3z: claimed row's content_source untouched");
        assertEq(claimedRow.about_text, "Skrevet av eier.", "nab-3aa: claimed row's about_text untouched");
        assertEq(claimedRow.catalog_hidden, 0, "nab-3ab: claimed row's catalog_hidden untouched (still visible)");
        assertEq(claimedRow.rfb_seed_source, null, "nab-3ac: claimed row never got a batch tag stamped onto it");

        const manualRow = expDb.prepare(`SELECT * FROM experience_providers WHERE id = 'prov-manual-namepostal'`).get() as any;
        assertEq(manualRow.content_source, "manual", "nab-3ad: manual row's content_source untouched");
        assertEq(manualRow.about_text, "Manuelt redigert.", "nab-3ae: manual row's about_text untouched");
        assertEq(manualRow.rfb_seed_source, null, "nab-3af: manual row never got a batch tag stamped onto it");
      }

      // ── nab-4: idempotency — re-running creates nothing new ─────────────
      {
        const countAfterFirstApply = countProviders();
        const r = await callRoute(opplevelserRouter, { headers: auth, body: { apply: true } });
        assertEq(r.status, 200, "nab-4a: second apply 200");
        assertEq(r.body.created_count, 0, "nab-4b: acceptance criterion 6 — re-run creates ZERO new rows");
        assertEq(r.body.skipped_duplicate_count, 4, "nab-4c: brew (org_nr) + vin (name+postal) now ALSO dedup-skipped, on top of the original 2");
        assertEq(countProviders(), countAfterFirstApply, "nab-4d: experience_providers count unchanged by the re-run");
      }

      // ── nab-5: acceptance criterion 5 — never in outreach candidates ────
      {
        const r = await callRoute(opplevelserRouter, {
          method: "GET", url: "/admin/gardssalg-outreach-candidates", query: { mode: "first" }, headers: auth,
        });
        assertEq(r.status, 200, "nab-5a: outreach-candidates 200");
        const ids = (r.body.candidates as any[]).map((c) => c.provider_id);
        const brewRow = getProviderByOrgNr("911111111");
        assertTrue(!ids.includes(brewRow.id), "nab-5b: freshly-bridged bryggeri row (real hjemmeside+epost) never appears under mode=first outreach candidates");
      }

      // ── nab-6: rollback — wrong tag prefix refused ───────────────────────
      {
        const r = await callRoute(opplevelserRouter, { headers: auth, body: { rollbackBatch: "rfb-seed" } });
        assertEq(r.status, 400, "nab-6a: a non-bridge batch tag is refused");
      }

      // ── nab-7: rollback dry-run — reports without deleting ──────────────
      {
        const r = await callRoute(opplevelserRouter, { headers: auth, body: { rollbackBatch: applyBatchTag } });
        assertEq(r.status, 200, "nab-7a: rollback dry-run 200");
        assertEq(r.body.dry_run, true, "nab-7b: rollback defaults to dry-run too");
        assertEq(r.body.would_delete, 2, "nab-7c: both bridged rows would be deleted");
        assertEq((r.body.skipped_locked as any[]).length, 0, "nab-7d: nothing locked in THIS batch (the claimed/manual fixtures carry no batch tag)");
        assertEq(countProviders(), baselineProviderCount + 2, "nab-7e: rollback dry-run deletes nothing");
      }

      // ── nab-8: rollback apply — acceptance criterion 6 ──────────────────
      {
        const r = await callRoute(opplevelserRouter, { headers: auth, body: { rollbackBatch: applyBatchTag, apply: true } });
        assertEq(r.status, 200, "nab-8a: rollback apply 200");
        assertEq(r.body.deleted, 2, "nab-8b: exactly the batch's 2 rows deleted");
        assertEq(countProviders(), baselineProviderCount, "nab-8c: rollback cleanly restores the pre-bridge row count");
        assertTrue(!getProviderByOrgNr("911111111"), "nab-8d: bryggeri row is gone");
        assertTrue(!getProviderByNavn("Fjordbobler Vineri"), "nab-8e: vingård row is gone");
        const claimedRow = expDb.prepare(`SELECT * FROM experience_providers WHERE id = 'prov-claimed-orgnr'`).get() as any;
        assertTrue(!!claimedRow, "nab-8f: rollback never touches the claimed fixture (different batch)");
        const manualRow = expDb.prepare(`SELECT * FROM experience_providers WHERE id = 'prov-manual-namepostal'`).get() as any;
        assertTrue(!!manualRow, "nab-8g: rollback never touches the manual fixture (different batch)");
      }

      // ── nab-9: re-bridging after rollback re-creates cleanly ────────────
      {
        const r = await callRoute(opplevelserRouter, { headers: auth, body: { apply: true } });
        assertEq(r.body.created_count, 2, "nab-9a: post-rollback sweep re-bridges both agents again (rollback is a true undo, not a permanent block)");
        assertEq(countProviders(), baselineProviderCount + 2, "nab-9b: count matches the earlier apply exactly");
      }

      void dryRunBatchTag; // referenced for clarity above; no further assertion needed on its value
    } catch (err) {
      failed++;
      failures.push(`✗ unexpected exception: ${(err as Error)?.stack || err}`);
    } finally {
      const initMod = require("../database/init") as typeof import("../database/init");
      if (prevRfbDb) initMod.__setDbForTesting(prevRfbDb);
      if (prevExperiencesDbPath === undefined) delete process.env.EXPERIENCES_DB_PATH;
      else process.env.EXPERIENCES_DB_PATH = prevExperiencesDbPath;
      if (prevAdminKey === undefined) delete process.env.ADMIN_KEY;
      else process.env.ADMIN_KEY = prevAdminKey;
      for (const p of cachePaths) delete require.cache[p];
    }

    return { passed, failed, failures };
  })();
}
