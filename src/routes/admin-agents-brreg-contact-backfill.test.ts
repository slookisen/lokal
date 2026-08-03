/**
 * admin-agents-brreg-contact-backfill.test.ts — tests for
 * POST /admin/agents/brreg-contact-backfill (dev-request 2026-07-31-rfb-
 * brreg-andrekilde-adresse-telefon).
 *
 * This is RFB's own port of gårdssalg's already-reviewed Brreg contact
 * backfill (POST /admin/gardssalg-contact-backfill, opplevelser.ts, dev-
 * request 2026-07-26-brreg-kontakt-backfill — see
 * opplevelser-gardssalg-contact-backfill.test.ts) onto the `agents`/
 * `agent_knowledge` tables, with the one genuinely new capability: this
 * route ALSO adds a `source_type: "brreg"` field_provenance record for
 * `address`/`phone` — the actual corroborating-source gap that unblocks
 * cross-source-validator.ts's outreach-pool gate — REGARDLESS of whether the
 * display column already has a value, which the gårdssalg original never
 * needed to do (see src/routes/admin-agents.ts's own file-header doc
 * comment on POST /brreg-contact-backfill for the full design rationale).
 *
 * Covers (src/routes/admin-agents.ts):
 *   - isPostboksAddress
 *   - applyAgentBrregContact (fill-only column write + additive provenance +
 *     audit, both in dry-run-preview and real-apply mode)
 *   - POST /admin/agents/brreg-contact-backfill
 *
 * Covers:
 *   (a) 403 without X-Admin-Key.
 *   (b) auto-select scoping: locked (claimed_at), org_nr-blank, inactive,
 *       umbrella, dental-vertical, and non-producer rows are ALL excluded
 *       from the auto-selected batch; an eligible RFB producer row with
 *       org_nr set IS selected — INCLUDING one whose address/phone columns
 *       are already both filled (the selector does NOT filter on blank
 *       column state — that's the whole point of this slice).
 *   (c) isPostboksAddress: "Postboks 123" / "postboks 5" / "Postb. 12" /
 *       "Boks 7" all match; a real street address ("Postboksveien 3", a
 *       street literally NAMED with the word as a non-leading substring)
 *       does NOT match; blank/null -> false.
 *   (d) source_type written is exactly "brreg", and tierForSource("brreg")
 *       (cross-source-validator.ts) maps to "B".
 *   (e) applyAgentBrregContact: BLANK address+phone columns -> both filled
 *       AND both get a provenance record.
 *   (f) applyAgentBrregContact: an EXISTING address value is kept EXACTLY
 *       (never overwritten) even when Brreg's differs, but the field STILL
 *       gets a NEW provenance record — the core design point of this slice.
 *   (g) applyAgentBrregContact: idempotent second call with the SAME Brreg
 *       values touches nothing (returns []) and does not duplicate the
 *       provenance record (exactly 1 "brreg" entry after two applies).
 *   (h) applyAgentBrregContact: locked (claimed_at) agent -> [] always, row
 *       and field_provenance completely untouched.
 *   (i) applyAgentBrregContact: dry-run mode (opts.dryRun) previews the
 *       exact same "touched" fields apply WOULD produce, with ZERO writes
 *       (asserted via db.total_changes before/after).
 *   (j) applyAgentBrregContact: audit rows — written for a field whenever a
 *       NEW provenance record was added, even when the column itself did
 *       NOT change (documents the audit-on-provenance-only-add decision);
 *       changed_by is 'system'; notes contains the batch id.
 *   (k) route: dry-run is genuinely zero-write (full db.total_changes
 *       assertion, not just response shape).
 *   (l) route: apply actually writes; agents_enriched === changed.length.
 *   (m) route: locked agent -> skipped_locked, no Brreg call ever made.
 *   (n) route: org_nr-blank agent via agentIds override -> unresolved
 *       reason no_org_nr, never reaches Brreg.
 *   (o) route: postboks Brreg address -> address entirely skipped (no
 *       column write, no provenance) while phone (if usable) still lands.
 *   (p) route: a phone value that fails validatePhoneForWrite (equal to the
 *       agent's own org_nr) is never written or added as provenance, while
 *       address (if usable) still lands.
 *   (q) route: agentIds override bypasses the WHERE selector (reaches an
 *       agent the auto-selector would exclude, e.g. one with an already-
 *       filled column, still adding the corroborating provenance record).
 *   (r) route: no usable Brreg contact at all -> unresolved
 *       no_usable_brreg_contact, brreg_hits stays accurate.
 *   (s) route: a second apply run against the SAME agent+data is fully
 *       idempotent end-to-end — unresolved already_up_to_date, provenance
 *       arrays stay at exactly 1 entry per field.
 *   (t) route: write failure surfaces in errors[] with a write_failed:
 *       prefix, 200 status (never 500).
 *   (u) route: brreg_hits{address,phone,any} reporting is accurate.
 *
 * All Brreg I/O is stubbed via admin-agents.ts's own injectable fetch seam
 * for THIS route (__setAgentsBrregContactBackfillFetchForTesting) —
 * deliberately a SEPARATE seam from __setAgentsOrgNrBackfillFetchForTesting
 * (see that seam's own test-file header for why a shared/global fetch
 * monkey-patch is unsafe across concurrently-running test blocks; this
 * route's doc comment in admin-agents.ts repeats the same rationale for why
 * it has its own seam rather than reusing the org-nr one).
 *
 * Two ways to run:
 *   1. Standalone: npx tsx src/routes/admin-agents-brreg-contact-backfill.test.ts
 *   2. Wired into the gate via tests/test.ts (folds pass/fail into `npm test`).
 */

import Database from "better-sqlite3";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

function fakeRes() {
  const r: any = { statusCode: 200, body: undefined };
  r.status = (c: number) => {
    r.statusCode = c;
    return r;
  };
  r.json = (b: any) => {
    r.body = b;
    return r;
  };
  return r;
}

// Norwegian 8-digit national numbers usable directly by validatePhoneForWrite
// (no +47/00 prefix stripping needed for these fixtures).
const PHONE_A = "22334455";
const PHONE_B = "99887766";

function enhetDetail(opts: {
  adresse?: string[] | null;
  postnummer?: string | null;
  poststed?: string | null;
  telefon?: string | null;
  mobil?: string | null;
  epostadresse?: string | null;
  hjemmeside?: string | null;
  postadresse?: { adresse: string[]; postnummer?: string; poststed?: string } | null;
}): Record<string, unknown> {
  return {
    forretningsadresse:
      opts.adresse === null
        ? null
        : {
            adresse: opts.adresse ?? ["Testveien 1"],
            postnummer: opts.postnummer ?? "1601",
            poststed: opts.poststed ?? "Sarpsborg",
          },
    postadresse: opts.postadresse ?? null,
    telefon: opts.telefon ?? null,
    mobil: opts.mobil ?? null,
    epostadresse: opts.epostadresse ?? null,
    hjemmeside: opts.hjemmeside ?? null,
  };
}

export async function runAdminAgentsBrregContactBackfillTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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

  const { __setDbForTesting, __initSchemaForTesting, getDb } = require("../database/init") as
    typeof import("../database/init");

  const prevDb = (() => {
    try {
      return getDb();
    } catch {
      return undefined;
    }
  })();
  const prevAdminKey = process.env.ADMIN_KEY;
  const prevAnalyticsAdminKey = process.env.ANALYTICS_ADMIN_KEY;
  let resetFetch: (() => void) | undefined;

  const testDb = new Database(":memory:");
  testDb.pragma("journal_mode = DELETE");
  testDb.pragma("foreign_keys = OFF");

  const ADMIN_KEY = process.env.ADMIN_KEY || "agents-brreg-contact-backfill-test-key";

  // Detail fixtures keyed by the bare 9-digit org number.
  const detailFixtures: Map<string, Record<string, unknown>> = new Map();
  let detailCallCount = 0;

  function stubFetch(): typeof fetch {
    return (async (url: string | URL | Request) => {
      const u = String(url);
      const dm = /\/enheter\/(\d{9})$/.exec(u);
      if (dm) {
        detailCallCount++;
        const fx = detailFixtures.get(dm[1]);
        if (!fx) return { status: 404, ok: false, json: async () => ({}) } as unknown as Response;
        return { status: 200, ok: true, json: async () => fx } as unknown as Response;
      }
      return { status: 404, ok: false, json: async () => ({}) } as unknown as Response;
    }) as typeof fetch;
  }

  try {
    __setDbForTesting(testDb as any);
    __initSchemaForTesting(testDb as any);
    process.env.ADMIN_KEY = ADMIN_KEY;
    delete process.env.ANALYTICS_ADMIN_KEY;

    // Fresh require of admin-agents.ts + its brreg-client dependency —
    // mirrors admin-agents-org-nr-backfill.test.ts's own cache-busting
    // convention exactly.
    const routePath = require.resolve("../routes/admin-agents");
    delete require.cache[routePath];
    try {
      delete require.cache[require.resolve("../routes/admin-knowledge")];
    } catch {
      /* ignore */
    }
    const brregClientPath = require.resolve("../services/brreg-client");
    delete require.cache[brregClientPath];

    const adminAgentsModule = require("../routes/admin-agents") as typeof import("../routes/admin-agents");
    const routerModule = adminAgentsModule.default;
    const { isPostboksAddress, applyAgentBrregContact, __setAgentsBrregContactBackfillFetchForTesting } =
      adminAgentsModule;

    const { tierForSource } = require("../services/cross-source-validator") as
      typeof import("../services/cross-source-validator");

    const brregClient = require("../services/brreg-client") as typeof import("../services/brreg-client");
    brregClient.__clearBrregAddressCacheForTesting();
    brregClient.__clearBrregWebsiteCacheForTesting();

    __setAgentsBrregContactBackfillFetchForTesting(stubFetch());
    resetFetch = () => __setAgentsBrregContactBackfillFetchForTesting(undefined);

    function getHandler(method: "get" | "post", path: string) {
      const layer = routerModule.stack.find(
        (l: any) => l.route && l.route.path === path && l.route.methods && l.route.methods[method],
      );
      assertTrue(!!layer, `setup: ${method.toUpperCase()} ${path} handler is registered on the router`);
      return layer.route.stack[0].handle;
    }

    const postBackfill = getHandler("post", "/brreg-contact-backfill");

    async function callBackfill(
      body: Record<string, unknown>,
      headers: Record<string, string> = { "x-admin-key": ADMIN_KEY },
      query: Record<string, string> = {},
    ): Promise<{ status: number; body: any }> {
      const res = fakeRes();
      await postBackfill({ headers, body, query } as any, res as any);
      return { status: res.statusCode, body: res.body };
    }

    function insertAgent(o: {
      id: string;
      name: string;
      orgNr?: string | null;
      claimedAt?: string | null;
      isActive?: number;
      role?: string;
      verticalId?: string | null;
      umbrellaType?: string | null;
      createdAt?: string;
    }): void {
      testDb
        .prepare(
          `INSERT INTO agents (
             id, name, description, provider, contact_email, url, role, api_key,
             org_nr, claimed_at, is_active, vertical_id, umbrella_type, created_at
           ) VALUES (?, ?, 't', 't', 'x@example.com', 'https://example.com', ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          o.id,
          o.name,
          o.role ?? "producer",
          `key-${o.id}`,
          o.orgNr ?? null,
          o.claimedAt ?? null,
          o.isActive ?? 1,
          o.verticalId ?? "rfb",
          o.umbrellaType ?? null,
          o.createdAt ?? "2026-01-01 00:00:00",
        );
    }

    function insertKnowledge(agentId: string, o: { address?: string | null; phone?: string | null } = {}): void {
      testDb
        .prepare(`INSERT INTO agent_knowledge (agent_id, address, phone, updated_at) VALUES (?, ?, ?, ?)`)
        .run(agentId, o.address ?? null, o.phone ?? null, new Date().toISOString());
    }

    function readKnowledge(agentId: string): any {
      return testDb.prepare("SELECT * FROM agent_knowledge WHERE agent_id = ?").get(agentId);
    }
    function readProvenance(agentId: string): Record<string, any> {
      const k = readKnowledge(agentId);
      if (!k || !k.field_provenance) return {};
      try {
        return JSON.parse(k.field_provenance);
      } catch {
        return {};
      }
    }
    function readAuditRows(agentId: string): any[] {
      return testDb
        .prepare("SELECT * FROM agent_knowledge_audit WHERE agent_id = ? ORDER BY rowid ASC")
        .all(agentId);
    }

    // ── (a) 403 without X-Admin-Key ───────────────────────────────────────
    {
      const r = await callBackfill({}, {});
      assertEq(r.status, 403, "a1: POST brreg-contact-backfill without X-Admin-Key -> 403");
    }

    // ── (c) isPostboksAddress ─────────────────────────────────────────────
    assertTrue(isPostboksAddress("Postboks 123"), "c1: 'Postboks 123' matches");
    assertTrue(isPostboksAddress("postboks 5"), "c2: lowercase 'postboks 5' matches");
    assertTrue(isPostboksAddress("Postb. 12"), "c3: 'Postb. 12' abbreviation matches");
    assertTrue(isPostboksAddress("Boks 7"), "c4: bare leading 'Boks 7' matches");
    assertTrue(!isPostboksAddress("Postboksveien 3"), "c5: 'Postboksveien' is one continuous word — the \\b boundary after the 'postboks' token fails, so a real street merely STARTING WITH those letters does not false-positive");
    assertTrue(!isPostboksAddress("Storgata 5, Postboks 3"), "c6: postboks NOT as the leading token -> does not match (leading-token-only guard)");
    assertTrue(!isPostboksAddress(null), "c7: null -> false");
    assertTrue(!isPostboksAddress(""), "c8: empty string -> false");

    // ── (d) source_type + tier ────────────────────────────────────────────
    assertEq(tierForSource("brreg"), "B", "d1: tierForSource('brreg') === 'B'");
    assertTrue(tierForSource("brreg_fallback") !== "B", "d2: a prefixed variant does NOT map to Tier B (regression guard against the exact spelling this route must use)");

    // ── (e)-(j) applyAgentBrregContact unit coverage ──────────────────────
    insertAgent({ id: "u-blank", name: "Unit Blank AS", orgNr: "900000001" });
    insertKnowledge("u-blank");
    {
      const written = applyAgentBrregContact(
        testDb as any,
        "u-blank",
        { address: "Gårdsveien 12", phone: PHONE_A },
        "https://data.brreg.no/enhetsregisteret/api/enheter/900000001",
        { batchId: "batch-e" },
      );
      assertEq(written.sort(), ["address", "phone"], "e1: both blank columns touched");
      const kE = readKnowledge("u-blank");
      assertEq(kE.address, "Gårdsveien 12", "e2: address column filled");
      assertEq(kE.phone, PHONE_A, "e3: phone column filled");
      const provE = readProvenance("u-blank");
      assertTrue(Array.isArray(provE.address) && provE.address.length === 1, "e4: address provenance array has exactly 1 entry");
      assertTrue(Array.isArray(provE.phone) && provE.phone.length === 1, "e5: phone provenance array has exactly 1 entry");
      assertEq(provE.address[0].source_type, "brreg", "e6: address provenance source_type === 'brreg'");
      assertEq(provE.phone[0].source_type, "brreg", "e7: phone provenance source_type === 'brreg'");
      assertEq(provE.address[0].source_url, "https://data.brreg.no/enhetsregisteret/api/enheter/900000001", "e8: provenance source_url matches the Brreg evidence URL");
    }

    // (f) existing column value is kept EXACTLY, but STILL gets a new
    // provenance record — the core design point of this slice.
    insertAgent({ id: "u-existing", name: "Unit Existing AS", orgNr: "900000002" });
    insertKnowledge("u-existing", { address: "Original Address 1" });
    {
      const written = applyAgentBrregContact(
        testDb as any,
        "u-existing",
        { address: "Brreg Says Different 99", phone: null },
        "https://brreg.example/900000002",
      );
      assertEq(written, ["address"], "f1: address is touched (provenance added) even though the column itself doesn't change");
      const kF = readKnowledge("u-existing");
      assertEq(kF.address, "Original Address 1", "f2: existing display value is kept EXACTLY, never overwritten");
      const provF = readProvenance("u-existing");
      assertTrue(Array.isArray(provF.address) && provF.address.length === 1, "f3: address STILL gets a new provenance record");
      assertEq(provF.address[0].value, "Brreg Says Different 99", "f4: provenance value is Brreg's (differing) value, not the column's");
    }

    // (g) idempotency: a second call with the SAME values touches nothing
    // and does not duplicate the provenance record.
    {
      const written2 = applyAgentBrregContact(
        testDb as any,
        "u-existing",
        { address: "Brreg Says Different 99", phone: null },
        "https://brreg.example/900000002",
      );
      assertEq(written2, [], "g1: idempotent second call with identical Brreg data touches nothing");
      const provG = readProvenance("u-existing");
      assertEq(provG.address.length, 1, "g2: still exactly 1 'brreg' provenance entry after two applies, not 2");
    }

    // (h) locked agent -> [] always, nothing touched.
    insertAgent({ id: "u-locked", name: "Unit Locked AS", orgNr: "900000003", claimedAt: "2026-01-01 00:00:00" });
    insertKnowledge("u-locked");
    {
      const written = applyAgentBrregContact(
        testDb as any,
        "u-locked",
        { address: "Should Never Land 1", phone: PHONE_A },
        "https://brreg.example/900000003",
      );
      assertEq(written, [], "h1: locked agent -> nothing written");
      const kH = readKnowledge("u-locked");
      assertEq(kH.address, null, "h2: locked agent's address column untouched");
      assertEq(readProvenance("u-locked"), {}, "h3: locked agent's field_provenance untouched");
    }

    // (i) dry-run mode: zero writes, same "touched" preview as apply would give.
    insertAgent({ id: "u-dry", name: "Unit Dry AS", orgNr: "900000004" });
    insertKnowledge("u-dry");
    {
      const totalChangesBefore = testDb.prepare("SELECT total_changes() AS n").get() as { n: number };
      const kBefore = readKnowledge("u-dry");
      const touched = applyAgentBrregContact(
        testDb as any,
        "u-dry",
        { address: "Dry Preview Address 1", phone: PHONE_B },
        "https://brreg.example/900000004",
        { dryRun: true },
      );
      assertEq(touched.sort(), ["address", "phone"], "i1: dry-run previews both fields as touchable");
      const kAfter = readKnowledge("u-dry");
      assertEq(kAfter, kBefore, "i2: dry-run performs ZERO writes (full row diff)");
      const totalChangesAfter = testDb.prepare("SELECT total_changes() AS n").get() as { n: number };
      assertEq(totalChangesAfter.n, totalChangesBefore.n, "i3: dry-run leaves total_changes() unchanged — zero writes at the SQLite level");
    }

    // (j) audit rows: provenance-only touch (case f above) IS audited, with
    // old_value === new_value (column unchanged) and notes carrying the batch id.
    insertAgent({ id: "u-audit", name: "Unit Audit AS", orgNr: "900000005" });
    insertKnowledge("u-audit", { address: "Kept Value 1" });
    {
      applyAgentBrregContact(
        testDb as any,
        "u-audit",
        { address: "Different Brreg Value 1", phone: PHONE_A },
        "https://brreg.example/900000005",
        { batchId: "batch-j1" },
      );
      const rows = readAuditRows("u-audit");
      const addrRow = rows.find((r: any) => r.field_name === "address");
      const phoneRow = rows.find((r: any) => r.field_name === "phone");
      assertTrue(!!addrRow, "j1: an audit row exists for 'address' even though the column value didn't change");
      assertEq(addrRow.old_value, "Kept Value 1", "j2: address audit old_value is the pre-write column value");
      assertEq(addrRow.new_value, "Kept Value 1", "j3: address audit new_value === old_value (provenance-only touch, column unchanged)");
      assertEq(addrRow.changed_by, "system", "j4: changed_by === 'system'");
      assertTrue(typeof addrRow.notes === "string" && addrRow.notes.includes("batch:batch-j1"), "j5: notes carries the batch id");
      assertTrue(typeof addrRow.notes === "string" && addrRow.notes.includes("source:brreg"), "j5b: notes carries the source tag");
      assertTrue(!!phoneRow, "j6: an audit row exists for 'phone' (column WAS filled this time)");
      assertEq(phoneRow.old_value, null, "j7: phone audit old_value is the true pre-write null");
      assertEq(phoneRow.new_value, PHONE_A, "j8: phone audit new_value is the written value");
    }

    // ── Route tests ─────────────────────────────────────────────────────

    // (b) auto-select scoping
    insertAgent({ id: "sel-eligible", name: "Sel Eligible AS", orgNr: "910000001", createdAt: "2026-02-01 00:00:00" });
    insertKnowledge("sel-eligible");
    detailFixtures.set("910000001", enhetDetail({ telefon: PHONE_A }));
    insertAgent({ id: "sel-already-filled", name: "Sel Already Filled AS", orgNr: "910000002", createdAt: "2026-02-02 00:00:00" });
    insertKnowledge("sel-already-filled", { address: "Existing Addr", phone: "12121212" });
    detailFixtures.set("910000002", enhetDetail({ telefon: PHONE_A }));
    insertAgent({ id: "sel-locked", name: "Sel Locked AS", orgNr: "910000003", claimedAt: "2026-01-01 00:00:00", createdAt: "2026-02-03 00:00:00" });
    insertKnowledge("sel-locked");
    insertAgent({ id: "sel-no-orgnr", name: "Sel No Orgnr AS", createdAt: "2026-02-04 00:00:00" });
    insertKnowledge("sel-no-orgnr");
    insertAgent({ id: "sel-inactive", name: "Sel Inactive AS", orgNr: "910000005", isActive: 0, createdAt: "2026-02-05 00:00:00" });
    insertAgent({ id: "sel-umbrella", name: "Sel Umbrella AS", orgNr: "910000006", umbrellaType: "hanen", createdAt: "2026-02-06 00:00:00" });
    insertAgent({ id: "sel-dental", name: "Sel Dental AS", orgNr: "910000007", verticalId: "dental", createdAt: "2026-02-07 00:00:00" });
    insertAgent({ id: "sel-consumer", name: "Sel Consumer", orgNr: "910000008", role: "consumer", createdAt: "2026-02-08 00:00:00" });
    {
      const dry = await callBackfill({ limit: 50, apply: false });
      const ids = (dry.body.changed as any[])
        .map((c) => c.agent_id)
        .concat((dry.body.unresolved as any[]).map((u) => u.agent_id))
        .concat(dry.body.skipped_locked as string[]);
      assertTrue(ids.includes("sel-eligible"), "b1: eligible org_nr-set RFB producer row IS selected");
      assertTrue(ids.includes("sel-already-filled"), "b2: a row with BOTH columns already filled is STILL selected — the selector does not filter on blank column state");
      // The auto-selector's own WHERE already excludes claimed_at IS NOT NULL
      // (same as org-nr-backfill's own selector), so a locked row never even
      // reaches the loop via auto-selection — skipped_locked is populated
      // only via the agentIds override path (see (m) below, which exercises
      // that path directly). Weaker sanity check mirrors admin-agents-org-nr-
      // backfill.test.ts's own "setup sanity" assertion for the same reason.
      assertTrue(
        !ids.includes("sel-locked") || dry.body.skipped_locked.includes("sel-locked"),
        "b3: locked row is either excluded by the selector's own WHERE, or (if reached) only ever appears via skipped_locked",
      );
      assertTrue(!ids.includes("sel-no-orgnr"), "b4: org_nr-blank row excluded from auto-selection");
      assertTrue(!ids.includes("sel-inactive"), "b5: inactive row excluded from auto-selection");
      assertTrue(!ids.includes("sel-umbrella"), "b6: umbrella row excluded from auto-selection");
      assertTrue(!ids.includes("sel-dental"), "b7: dental-vertical row excluded from auto-selection");
      assertTrue(!ids.includes("sel-consumer"), "b8: non-producer role excluded from auto-selection");
    }

    // (k) route dry-run is genuinely zero-write.
    insertAgent({ id: "rt-dry", name: "Route Dry AS", orgNr: "920000001", createdAt: "2026-03-01 00:00:00" });
    insertKnowledge("rt-dry");
    detailFixtures.set("920000001", enhetDetail({ adresse: ["Dryveien 1"], telefon: PHONE_A }));
    {
      const kBefore = readKnowledge("rt-dry");
      const auditBefore = readAuditRows("rt-dry").length;
      const totalChangesBefore = testDb.prepare("SELECT total_changes() AS n").get() as { n: number };
      const dry = await callBackfill({ agentIds: ["rt-dry"], apply: false });
      assertEq(dry.status, 200, "k1: dry-run -> 200");
      assertEq(dry.body.dry_run, true, "k2: dry_run true");
      const hit = dry.body.changed.find((c: any) => c.agent_id === "rt-dry");
      assertTrue(!!hit, "k3: rt-dry appears in dry-run changed[]");
      assertEq(hit.fields.sort(), ["address", "phone"], "k4: both fields reported as would-touch");
      assertEq(hit.address, "Dryveien 1", "k5: dry-run reports the candidate address");
      assertEq(hit.phone, PHONE_A, "k6: dry-run reports the candidate phone");
      const kAfter = readKnowledge("rt-dry");
      assertEq(kAfter, kBefore, "k7: dry-run wrote ZERO changes to agent_knowledge (full row diff)");
      assertEq(readAuditRows("rt-dry").length, auditBefore, "k8: dry-run wrote no audit rows");
      const totalChangesAfter = testDb.prepare("SELECT total_changes() AS n").get() as { n: number };
      assertEq(totalChangesAfter.n, totalChangesBefore.n, "k9: dry-run leaves total_changes() unchanged at the SQLite level, not just at the response-shape level");
    }

    // (l) route apply actually writes; agents_enriched === changed.length.
    {
      const applyRes = await callBackfill({ agentIds: ["rt-dry"], apply: true });
      assertEq(applyRes.status, 200, "l1: apply -> 200");
      assertEq(applyRes.body.dry_run, false, "l2: dry_run false");
      assertEq(applyRes.body.agents_enriched, applyRes.body.changed.length, "l3: agents_enriched === changed.length");
      const kL = readKnowledge("rt-dry");
      assertEq(kL.address, "Dryveien 1", "l4: address actually written");
      assertEq(kL.phone, PHONE_A, "l5: phone actually written");
    }

    // (m) locked agent -> skipped_locked, no Brreg call for it.
    insertAgent({ id: "rt-locked", name: "Route Locked AS", orgNr: "920000002", claimedAt: "2026-01-01 00:00:00", createdAt: "2026-03-01 00:00:00" });
    insertKnowledge("rt-locked");
    {
      const before = detailCallCount;
      const res = await callBackfill({ agentIds: ["rt-locked"], apply: true });
      assertTrue(res.body.skipped_locked.includes("rt-locked"), "m1: locked agent -> skipped_locked");
      assertEq(detailCallCount, before, "m2: no Brreg call made for a locked agent");
      assertEq(readKnowledge("rt-locked").address, null, "m3: locked agent untouched");
    }

    // (n) org_nr-blank agent via agentIds override -> unresolved no_org_nr,
    // never reaches Brreg.
    insertAgent({ id: "rt-no-orgnr", name: "Route No Orgnr AS", createdAt: "2026-03-01 00:00:00" });
    insertKnowledge("rt-no-orgnr");
    {
      const before = detailCallCount;
      const res = await callBackfill({ agentIds: ["rt-no-orgnr"], apply: true });
      assertTrue(
        res.body.unresolved.some((u: any) => u.agent_id === "rt-no-orgnr" && u.reason === "no_org_nr"),
        "n1: org_nr-blank agent via override -> unresolved no_org_nr",
      );
      assertEq(detailCallCount, before, "n2: no Brreg call made for an org_nr-blank agent");
    }

    // (o) postboks address -> address entirely skipped; usable phone still lands.
    insertAgent({ id: "rt-postboks", name: "Route Postboks AS", orgNr: "920000003", createdAt: "2026-03-01 00:00:00" });
    insertKnowledge("rt-postboks");
    detailFixtures.set("920000003", enhetDetail({ adresse: ["Postboks 44"], telefon: PHONE_A }));
    {
      const res = await callBackfill({ agentIds: ["rt-postboks"], apply: true });
      const hit = res.body.changed.find((c: any) => c.agent_id === "rt-postboks");
      assertTrue(!!hit, "o1: rt-postboks still enriched (phone lands)");
      assertEq(hit.fields, ["phone"], "o2: ONLY phone in fields — address entirely skipped");
      assertEq(hit.address, null, "o3: response never surfaces the postboks address");
      const kO = readKnowledge("rt-postboks");
      assertEq(kO.address, null, "o4: address column NEVER written from a postboks value");
      const provO = readProvenance("rt-postboks");
      assertEq(provO.address, undefined, "o5: address NEVER gets a provenance record from a postboks value");
      assertEq(kO.phone, PHONE_A, "o6: phone still written normally");
    }

    // (p) phone equal to the agent's own org_nr fails validatePhoneForWrite
    // -> never written/added; usable address still lands.
    insertAgent({ id: "rt-orgphone", name: "Route Orgphone AS", orgNr: "920345678", createdAt: "2026-03-01 00:00:00" });
    insertKnowledge("rt-orgphone");
    // telefon deliberately equals the agent's own org_nr (leak class from
    // dev-request 2026-07-28) — validatePhoneForWrite must reject this.
    detailFixtures.set("920345678", enhetDetail({ adresse: ["Orgphoneveien 9"], telefon: "920345678" }));
    {
      const res = await callBackfill({ agentIds: ["rt-orgphone"], apply: true });
      const hit = res.body.changed.find((c: any) => c.agent_id === "rt-orgphone");
      assertTrue(!!hit, "p1: rt-orgphone still enriched (address lands)");
      assertEq(hit.fields, ["address"], "p2: ONLY address in fields — phone rejected by validatePhoneForWrite");
      assertEq(hit.phone, null, "p3: response never surfaces the rejected phone");
      const kP = readKnowledge("rt-orgphone");
      assertEq(kP.phone, null, "p4: phone column NEVER written when it collides with the agent's own org_nr");
      const provP = readProvenance("rt-orgphone");
      assertEq(provP.phone, undefined, "p5: phone NEVER gets a provenance record when rejected");
    }

    // (q) agentIds override bypasses the WHERE selector — an already-filled
    // row (excluded from nothing here since selector doesn't filter columns,
    // but IS excluded from auto-selection scoping like inactive) still
    // resolves and gets the corroborating provenance added.
    insertAgent({ id: "rt-override", name: "Route Override AS", orgNr: "920000004", isActive: 0, createdAt: "2026-03-01 00:00:00" });
    insertKnowledge("rt-override", { address: "Manually Set Address" });
    detailFixtures.set("920000004", enhetDetail({ adresse: ["Different Brreg Address 1"], telefon: PHONE_B }));
    {
      const before = detailCallCount;
      const res = await callBackfill({ agentIds: ["rt-override"], apply: true });
      assertTrue(detailCallCount > before, "q1: an inactive row IS reached via the explicit agentIds override");
      const hit = res.body.changed.find((c: any) => c.agent_id === "rt-override");
      assertTrue(!!hit, "q2: rt-override enriched via override");
      assertEq(readKnowledge("rt-override").address, "Manually Set Address", "q3: existing address column kept exactly");
      const provQ = readProvenance("rt-override");
      assertTrue(Array.isArray(provQ.address) && provQ.address.length === 1, "q4: corroborating provenance record added despite the column being pre-filled");
    }

    // (r) no usable Brreg contact at all -> unresolved no_usable_brreg_contact.
    insertAgent({ id: "rt-nocontact", name: "Route No Contact AS", orgNr: "920000005", createdAt: "2026-03-01 00:00:00" });
    insertKnowledge("rt-nocontact");
    detailFixtures.set("920000005", enhetDetail({ adresse: null, telefon: null, mobil: null }));
    {
      const res = await callBackfill({ agentIds: ["rt-nocontact"], apply: true });
      assertTrue(
        res.body.unresolved.some((u: any) => u.agent_id === "rt-nocontact" && u.reason === "no_usable_brreg_contact"),
        "r1: no usable Brreg contact -> unresolved no_usable_brreg_contact",
      );
      assertEq(readKnowledge("rt-nocontact").address, null, "r2: row untouched");
    }

    // (s) end-to-end idempotency via the route: second apply run ->
    // already_up_to_date, provenance stays at 1 entry per field.
    {
      const res2 = await callBackfill({ agentIds: ["rt-dry"], apply: true });
      assertTrue(
        res2.body.unresolved.some((u: any) => u.agent_id === "rt-dry" && u.reason === "already_up_to_date"),
        "s1: second apply run on the same agent+data -> unresolved already_up_to_date",
      );
      assertTrue(!res2.body.changed.some((c: any) => c.agent_id === "rt-dry"), "s2: does not reappear in changed[]");
      const provS = readProvenance("rt-dry");
      assertEq(provS.address.length, 1, "s3: address provenance still exactly 1 entry after two apply runs");
      assertEq(provS.phone.length, 1, "s4: phone provenance still exactly 1 entry after two apply runs");
    }

    // (u) brreg_hits reporting accuracy over a small deterministic cohort.
    insertAgent({ id: "rt-rate-a", name: "Rate A AS", orgNr: "930000001", createdAt: "2026-04-01 00:00:00" });
    insertKnowledge("rt-rate-a");
    detailFixtures.set("930000001", enhetDetail({ adresse: ["Rate A Vei 1"], telefon: PHONE_A })); // both
    insertAgent({ id: "rt-rate-b", name: "Rate B AS", orgNr: "930000002", createdAt: "2026-04-02 00:00:00" });
    insertKnowledge("rt-rate-b");
    detailFixtures.set("930000002", enhetDetail({ adresse: ["Rate B Vei 1"], telefon: null })); // address only
    insertAgent({ id: "rt-rate-c", name: "Rate C AS", orgNr: "930000003", createdAt: "2026-04-03 00:00:00" });
    insertKnowledge("rt-rate-c");
    detailFixtures.set("930000003", enhetDetail({ adresse: null, telefon: PHONE_B })); // phone only
    insertAgent({ id: "rt-rate-d", name: "Rate D AS", orgNr: "930000004", createdAt: "2026-04-04 00:00:00" });
    insertKnowledge("rt-rate-d");
    detailFixtures.set("930000004", enhetDetail({ adresse: null, telefon: null })); // nothing
    {
      const res = await callBackfill({
        agentIds: ["rt-rate-a", "rt-rate-b", "rt-rate-c", "rt-rate-d"],
        apply: false,
      });
      assertEq(res.body.scanned, 4, "u1: scanned counts every row that reached a Brreg lookup");
      assertEq(res.body.brreg_hits, { address: 2, phone: 2, any: 3 }, "u2: per-field and any-channel hit counts are accurate");
      assertEq(res.body.changed.length, 3, "u3: three of four rows would be enriched");
    }

    // (t) route: write failure surfaces in errors[] with write_failed: prefix,
    // never a 500.
    insertAgent({ id: "rt-write-fail", name: "Route Write Fail AS", orgNr: "930000005", createdAt: "2026-04-01 00:00:00" });
    insertKnowledge("rt-write-fail");
    detailFixtures.set("930000005", enhetDetail({ adresse: ["Fail Vei 1"], telefon: PHONE_A }));
    testDb.exec("DROP TABLE agent_knowledge_audit");
    {
      const res = await callBackfill({ agentIds: ["rt-write-fail"], apply: true });
      assertEq(res.status, 200, "t1: a write failure is a 200 with the failure reported in errors[], not a 500");
      assertTrue(
        res.body.errors.some((e: any) => e.agent_id === "rt-write-fail" && typeof e.error === "string" && e.error.startsWith("write_failed:")),
        "t2: rt-write-fail -> errors[] with a write_failed: prefix",
      );
    }
  } catch (err: any) {
    failed++;
    failures.push("admin-agents-brreg-contact-backfill: unexpected error: " + String(err?.stack || err?.message || err));
  } finally {
    if (resetFetch) resetFetch();
    if (prevAdminKey === undefined) delete process.env.ADMIN_KEY;
    else process.env.ADMIN_KEY = prevAdminKey;
    if (prevAnalyticsAdminKey === undefined) delete process.env.ANALYTICS_ADMIN_KEY;
    else process.env.ANALYTICS_ADMIN_KEY = prevAnalyticsAdminKey;
    try {
      if (prevDb) __setDbForTesting(prevDb);
    } catch {
      /* best-effort restore */
    }
  }

  return { passed, failed, failures };
}

// Standalone runner: `npx tsx src/routes/admin-agents-brreg-contact-backfill.test.ts`
if (require.main === module) {
  runAdminAgentsBrregContactBackfillTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    process.exit(summary.failed > 0 ? 1 : 0);
  });
}
