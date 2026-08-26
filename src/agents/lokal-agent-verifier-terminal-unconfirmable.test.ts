/**
 * lokal-agent-verifier-terminal-unconfirmable.test.ts — dev-request
 * 2026-08-23-terminal-unconfirmable: a new `terminal_unconfirmable`
 * verification status so agents that are demonstrably unconfirmable stop
 * being retried forever by the hourly verifier sweep. Two triggering
 * criteria, both gated behind RFB_TERMINAL_UNCONFIRMABLE_ENABLED (default
 * OFF — flag-off must be byte-identical to before this PR):
 *
 *   1. Brreg shows the business as deleted/bankrupt (brreg_konkurs) or
 *      inactive (brreg_inactive) — a permanent, structural disqualifier —
 *      via deriveVerificationStatus's !passes branch.
 *   2. The second (lower-bar) verification line found ZERO identity
 *      sources for a first-line failure that carried no brreg/nace flags
 *      at all (newVerification === 'pending_verify' going in) — via the
 *      RFB second verification line block in runVerifierBatch, which ALSO
 *      requires RFB_SECOND_LINE_VERIFICATION_ENABLED='true'.
 *
 * ── dev-request 2026-08-25-terminal-sweep-false-positives (extends this
 * suite, does not replace it) ──────────────────────────────────────────────
 * The ORIGINAL version of criterion 2 terminal-marked the moment the second
 * line found zero identity sources — on the ABSENCE of data alone. A
 * measured production sample found 7/10 rows terminal-marked that way were
 * demonstrably live, active businesses. Criterion 2 now REQUIRES fresh,
 * positive evidence (see lokal-agent-verifier.ts's checkFreshBrregDeathEvidence
 * / looksLikeNonProducerEntity doc comments) before a terminal mark; absent
 * evidence now means the row stays `pending_verify`. Scenario (e) below is
 * REWRITTEN to prove that new invariant (was previously the "zero sources ->
 * instant terminal" case — that behaviour was exactly the bug). Scenarios
 * (h)/(i)/(j)/(k) below are new: the 10 real measured fixture rows from the
 * dev-request's own production sample (h), a positive brreg_konkurs/
 * brreg_inactive fresh-evidence fixture (i), direct unit coverage of
 * looksLikeNonProducerEntity's false-positive guards (j), and direct unit
 * coverage of checkFreshBrregDeathEvidence's domain-token / personal-name-ENK
 * waterfall attempts (k) — the two fallback attempts none of the (h)
 * fixtures happen to exercise (their base-name attempt always resolves the
 * search first).
 *
 * Harness pattern copied verbatim from the sibling
 * lokal-agent-verifier-second-line.test.ts: in-memory better-sqlite3 DB via
 * initMod.__setDbForTesting/__initSchemaForTesting, restored in `finally`.
 * The NEW fresh-Brreg-lookup fixtures below mirror
 * admin-rfb-brreg-selfsufficiency.test.ts's own raw-fetch-stub convention
 * (jsonResponse/searchHit/detail helpers, URL-pattern dispatch on `navn=`
 * vs `/enheter/{9 digits}$`) since checkFreshBrregDeathEvidence calls the
 * SAME brreg-client.ts functions (findOrgnumberByName/verifyOrgNumber) that
 * route's own tests already stub the same way.
 *
 * Exported runLokalAgentVerifierTerminalUnconfirmableTests({log}) ->
 * TestSummary; wired into tests/test.ts via runSerial() immediately after
 * the second-line suite's own registration.
 * Standalone: npx tsx src/agents/lokal-agent-verifier-terminal-unconfirmable.test.ts
 */

import Database from "better-sqlite3";
import * as initMod from "../database/init";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export function runLokalAgentVerifierTerminalUnconfirmableTests(
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
    const { runVerifierBatch, pickBatch, checkFreshBrregDeathEvidence, looksLikeNonProducerEntity } =
      require("./lokal-agent-verifier") as typeof import("./lokal-agent-verifier");
    // brreg-client.ts's findOrgnumberByName/verifyOrgNumber caches are
    // module-level (per-process), so a DIFFERENT test file that ran earlier
    // in this same `npm test` process and happened to reuse one of this
    // suite's fake org-numbers/search-names (small integers like
    // "999888777" are a common placeholder across this codebase's test
    // fixtures — see e.g. brreg-client.test.ts) can leave a stale cached
    // result behind. Cleared here (mirrors the SAME clear-at-start
    // convention brreg-client.test.ts / admin-rfb-brreg-selfsufficiency.test.ts
    // / opplevelser-*.test.ts already use) so scenarios (h)/(i)/(k) below —
    // the first in this file to call the REAL findOrgnumberByName/
    // verifyOrgNumber (fetch-mocked, never real network) — always start
    // from a clean slate regardless of suite run order.
    const { __clearBrregCacheForTesting, __clearBrregVerifyCacheForTesting } =
      require("../services/brreg-client") as typeof import("../services/brreg-client");
    __clearBrregCacheForTesting();
    __clearBrregVerifyCacheForTesting();

    // ── Fresh-Brreg-lookup fetch stub (dev-request 2026-08-25) ──────────────
    // Mirrors admin-rfb-brreg-selfsufficiency.test.ts's own raw-fetch-stub
    // convention: findOrgnumberByName's request URL carries `?navn=<name>`,
    // verifyOrgNumber's carries `/enheter/<9-digit-orgnr>`. Any search name /
    // org-nr NOT registered in the fixture map returns an EMPTY/404 result —
    // never a match — matching production's own fail-closed default so a
    // scenario can prove "no match found" just by omitting a fixture.
    function jsonResponse(status: number, body: Record<string, unknown>): Response {
      return { status, ok: status >= 200 && status < 300, json: async () => body } as unknown as Response;
    }
    function searchHit(orgNr: string, navn: string) {
      return { organisasjonsnummer: orgNr, navn, forretningsadresse: { adresse: ["Testveien 1"] } };
    }
    function activeDetail(orgNr: string, navn: string, extra: Record<string, unknown> = {}) {
      return {
        organisasjonsnummer: orgNr, navn, konkurs: false, underAvvikling: false,
        underTvangsavviklingEllerTvangsopplosning: false, slettedato: null, ...extra,
      };
    }
    function deadDetail(orgNr: string, navn: string, flag: "bankrupt" | "dissolved") {
      return {
        organisasjonsnummer: orgNr, navn,
        konkurs: flag === "bankrupt",
        underAvvikling: false,
        underTvangsavviklingEllerTvangsopplosning: false,
        slettedato: flag === "dissolved" ? "2026-01-15" : null,
      };
    }
    // A scenario throwing if this is ever invoked proves "no fresh Brreg
    // lookup was even attempted" (e.g. the non-producer-pattern short-circuit
    // firing BEFORE any network call) — mirrors throwingJudge's role below.
    const throwingDeathCheckFetch = (async () => {
      throw new Error("checkFreshBrregDeathEvidence must NOT have called fetch in this scenario");
    }) as unknown as typeof fetch;

    function buildDeathCheckFetch(opts: {
      bySearchName?: Record<string, { orgNr: string; navn: string }>;
      byOrgNr?: Record<string, Record<string, unknown>>;
    } = {}): typeof fetch {
      return (async (url: string | URL | Request) => {
        const u = String(url);
        const sm = /[?&]navn=([^&]+)/.exec(u);
        if (sm) {
          const decoded = decodeURIComponent(sm[1]);
          const fx = opts.bySearchName?.[decoded];
          if (fx) return jsonResponse(200, { _embedded: { enheter: [searchHit(fx.orgNr, fx.navn)] } });
          return jsonResponse(200, { _embedded: { enheter: [] } });
        }
        const dm = /\/enheter\/(\d{9})$/.exec(u);
        if (dm) {
          const fx = opts.byOrgNr?.[dm[1]];
          if (!fx) return jsonResponse(404, {});
          return jsonResponse(200, fx);
        }
        return jsonResponse(404, {});
      }) as typeof fetch;
    }

    const prevDb = initMod.getDb();
    const prevTerminalFlag = process.env.RFB_TERMINAL_UNCONFIRMABLE_ENABLED;
    const prevSecondLineFlag = process.env.RFB_SECOND_LINE_VERIFICATION_ENABLED;
    const db = new Database(":memory:");
    try {
      db.pragma("journal_mode = DELETE");
      initMod.__setDbForTesting(db as any);
      initMod.__initSchemaForTesting(db as any);

      const insertAgent = db.prepare(
        `INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, is_verified)
         VALUES (?, ?, 'test agent', 'test', 'x@example.com', ?, 'producer', ?, ?)`,
      );
      const insertKnowledge = db.prepare(
        `INSERT INTO agent_knowledge
           (agent_id, address, phone, email, website, about, products, field_provenance, verification_status, enrichment_status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'partial')`,
      );

      function domainFromEmail(email: string | null | undefined): string | null {
        if (!email || !email.includes("@")) return null;
        return email.split("@")[1] || null;
      }

      // Mirrors lokal-agent-verifier-second-line.test.ts's seedAgent:
      // agents.url is pinned to the SAME domain as the email so the
      // unrelated domainCoherenceCheck guard never perturbs these
      // terminal_unconfirmable-specific scenarios.
      function seedAgent(id: string, opts: {
        name?: string;
        website?: string | null;
        email?: string | null;
        about?: string | null;
        products?: unknown[];
        field_provenance?: Record<string, unknown>;
        verificationStatus?: string;
      } = {}): void {
        const effectiveEmail = opts.email === undefined ? "kari@testgard.no" : opts.email;
        const emailDom = domainFromEmail(effectiveEmail);
        const agentUrl = emailDom ? `https://${emailDom}` : `https://example-registration.invalid/${id}`;
        insertAgent.run(id, opts.name ?? "Testgård " + id, agentUrl, "key-" + id, 0);
        insertKnowledge.run(
          id,
          "Testveien 1, 2600 Lillehammer",
          "91234567",
          effectiveEmail,
          opts.website ?? null,
          opts.about ?? "En liten gård som selger egg og grønnsaker direkte fra tunet. Familiedrevet i tre generasjoner.",
          JSON.stringify(opts.products ?? [{ name: "Egg" }, { name: "Poteter" }, { name: "Honning" }]),
          JSON.stringify(opts.field_provenance ?? {}),
          opts.verificationStatus ?? "pending_verify",
        );
      }

      function knowledgeRow(id: string): any {
        return db.prepare(
          `SELECT verification_status, verification_review_reason FROM agent_knowledge WHERE agent_id = ?`
        ).get(id);
      }

      // pickFn scoped to exactly ONE agent id, to keep each scenario isolated.
      function pickOnly(id: string) {
        return (dbi: any) => dbi.prepare(
          `SELECT a.id, a.name, a.url AS agent_url, a.city AS location_city, a.is_verified,
                  k.email, k.phone, k.address, k.website, k.about, k.products, k.field_provenance,
                  k.verification_status, k.enrichment_status,
                  k.last_verified_at, k.last_http_check_at, k.last_http_status
             FROM agents a INNER JOIN agent_knowledge k ON k.agent_id = a.id
            WHERE a.id = ?`
        ).all(id);
      }

      const throwingJudge = async (): Promise<{ approved: boolean; reason?: string }> => {
        throw new Error("second-line judge must NOT have been called in this scenario");
      };

      async function runOne(id: string, o: {
        terminalFlag?: string;
        secondLineFlag?: string;
        brregLookup?: any;
        judgeFn?: any;
        headProbeStatus?: number | null;
        // dev-request 2026-08-25-terminal-sweep-false-positives: the fresh-
        // lookup fetch stub for checkFreshBrregDeathEvidence. Defaults to
        // throwingDeathCheckFetch — a scenario that reaches the fresh-lookup
        // branch WITHOUT passing this explicitly fails loudly (a network
        // call attempt) rather than silently hitting the real Brreg API.
        deathCheckFetch?: typeof fetch;
      } = {}) {
        const prevT = process.env.RFB_TERMINAL_UNCONFIRMABLE_ENABLED;
        const prevS = process.env.RFB_SECOND_LINE_VERIFICATION_ENABLED;
        if (o.terminalFlag === undefined) delete process.env.RFB_TERMINAL_UNCONFIRMABLE_ENABLED;
        else process.env.RFB_TERMINAL_UNCONFIRMABLE_ENABLED = o.terminalFlag;
        if (o.secondLineFlag === undefined) delete process.env.RFB_SECOND_LINE_VERIFICATION_ENABLED;
        else process.env.RFB_SECOND_LINE_VERIFICATION_ENABLED = o.secondLineFlag;
        try {
          const result = await runVerifierBatch({
            db,
            pickFn: pickOnly(id),
            headProbe: async () => (o.headProbeStatus === undefined ? null : o.headProbeStatus),
            brregLookup: o.brregLookup ?? null,
            secondLineJudgeFn: o.judgeFn,
            terminalDeathCheckFetch: o.deathCheckFetch ?? throwingDeathCheckFetch,
          });
          return result.results[0];
        } finally {
          if (prevT === undefined) delete process.env.RFB_TERMINAL_UNCONFIRMABLE_ENABLED;
          else process.env.RFB_TERMINAL_UNCONFIRMABLE_ENABLED = prevT;
          if (prevS === undefined) delete process.env.RFB_SECOND_LINE_VERIFICATION_ENABLED;
          else process.env.RFB_SECOND_LINE_VERIFICATION_ENABLED = prevS;
        }
      }

      // ═══════════════════════════════════════════════════════════════
      // (a) flag OFF: brreg_konkurs-flagged pending_verify agent -> still
      //     review_required, byte-identical to today.
      // ═══════════════════════════════════════════════════════════════
      seedAgent("a1", { website: "https://testgard.no", email: "kari@testgard.no" });
      {
        const r = await runOne("a1", {
          headProbeStatus: 200,
          brregLookup: async () => ({ is_active: false, is_konkurs: true, naering: null }),
        });
        assertEq(r.new_verification_status, "review_required", "a-1: flag OFF, brreg_konkurs -> review_required (byte-identical)");
        assertEq(knowledgeRow("a1").verification_status, "review_required", "a-2: DB also reflects review_required");
      }

      // ═══════════════════════════════════════════════════════════════
      // (b) flag ON, Brreg is_konkurs:true -> terminal_unconfirmable,
      //     terminal_reason: 'brreg_konkurs' persisted.
      // ═══════════════════════════════════════════════════════════════
      seedAgent("b1", { website: "https://testgard.no", email: "kari@testgard.no" });
      {
        const r = await runOne("b1", {
          terminalFlag: "true",
          headProbeStatus: 200,
          brregLookup: async () => ({ is_active: false, is_konkurs: true, naering: null }),
        });
        assertEq(r.new_verification_status, "terminal_unconfirmable", "b-1: flag ON, brreg_konkurs -> terminal_unconfirmable");
        const row = knowledgeRow("b1");
        assertEq(row.verification_status, "terminal_unconfirmable", "b-2: DB also reflects terminal_unconfirmable");
        const reason = JSON.parse(row.verification_review_reason || "{}");
        assertEq(reason.terminal_reason, "brreg_konkurs", "b-3: persisted verification_review_reason.terminal_reason = 'brreg_konkurs'");
      }

      // ═══════════════════════════════════════════════════════════════
      // (c) flag ON, Brreg is_active:false, is_konkurs:false ->
      //     terminal_unconfirmable, terminal_reason: 'brreg_inactive'.
      // ═══════════════════════════════════════════════════════════════
      seedAgent("c1", { website: "https://testgard.no", email: "kari@testgard.no" });
      {
        const r = await runOne("c1", {
          terminalFlag: "true",
          headProbeStatus: 200,
          brregLookup: async () => ({ is_active: false, is_konkurs: false, naering: null }),
        });
        assertEq(r.new_verification_status, "terminal_unconfirmable", "c-1: flag ON, brreg_inactive -> terminal_unconfirmable");
        const row = knowledgeRow("c1");
        assertEq(row.verification_status, "terminal_unconfirmable", "c-2: DB also reflects terminal_unconfirmable");
        const reason = JSON.parse(row.verification_review_reason || "{}");
        assertEq(reason.terminal_reason, "brreg_inactive", "c-3: persisted verification_review_reason.terminal_reason = 'brreg_inactive'");
      }

      // ═══════════════════════════════════════════════════════════════
      // (d) flag ON, only a nace_blacklist:* flag present (no brreg flag)
      //     -> STILL review_required. Proves the change doesn't leak into
      //     the nace-blacklist branch.
      // ═══════════════════════════════════════════════════════════════
      seedAgent("d1", { website: "https://testgard.no", email: "kari@testgard.no" });
      {
        const r = await runOne("d1", {
          terminalFlag: "true",
          headProbeStatus: 200,
          brregLookup: async () => ({ is_active: true, is_konkurs: false, naering: "Drift av restauranter" }),
        });
        assertEq(r.new_verification_status, "review_required", "d-1: flag ON, nace_blacklist only (no brreg flag) -> STILL review_required");
        const row = knowledgeRow("d1");
        assertEq(row.verification_status, "review_required", "d-2: DB also reflects review_required");
        const reason = JSON.parse(row.verification_review_reason || "{}");
        assertEq(reason.terminal_reason, undefined, "d-3: no terminal_reason stamped for the nace-blacklist-only case");
      }

      // ═══════════════════════════════════════════════════════════════
      // (e) flag ON + RFB_SECOND_LINE_VERIFICATION_ENABLED='true': first
      //     line fails with NO brreg/nace flags at all (newVerification
      //     starts 'pending_verify'), second line finds ZERO identity
      //     sources -> REWRITTEN for dev-request 2026-08-25-terminal-sweep-
      //     false-positives: a fresh Brreg lookup finds NO confident match
      //     either -> stays 'pending_verify' (the core invariant this
      //     dev-request exists to enforce — absence of data, even on BOTH
      //     the identity-sources check AND the fresh lookup, is never
      //     terminal grounds). This scenario used to assert the OPPOSITE
      //     (instant terminal_unconfirmable on zero sources alone) — that
      //     was exactly the measured false-positive bug.
      // ═══════════════════════════════════════════════════════════════
      // No website (-> website_ok=false, no own_website source), no
      // provenance records, no Brreg name match (brregLookup=null here) ->
      // computeSecondLineIdentitySources returns []. Gate fails on
      // website_ok alone (http_status null -> flags=['website_unreachable'],
      // no brreg/nace flag) -> deriveVerificationStatus -> 'pending_verify'.
      seedAgent("e1", { name: "Testgård e1", website: null, email: "kari@e1-testgard.no" });
      {
        const r = await runOne("e1", {
          terminalFlag: "true",
          secondLineFlag: "true",
          judgeFn: throwingJudge,
          // Empty fixture set -> every search-name attempt (base name, and
          // whatever domain-token the agent's own registration url yields)
          // returns zero Brreg hits -> checkFreshBrregDeathEvidence returns
          // null -> no death evidence -> stays pending_verify.
          deathCheckFetch: buildDeathCheckFetch({}),
        });
        assertEq(r.new_verification_status, "pending_verify", "e-1: flag ON both, zero identity sources AND no fresh Brreg death evidence -> stays pending_verify");
        const row = knowledgeRow("e1");
        assertEq(row.verification_status, "pending_verify", "e-2: DB also reflects pending_verify");
        const reason = JSON.parse(row.verification_review_reason || "{}");
        assertEq(reason.terminal_reason, undefined, "e-3: no terminal_reason stamped — never terminal on absence of data alone");
      }

      // ═══════════════════════════════════════════════════════════════
      // (f) same setup as (e) but RFB_SECOND_LINE_VERIFICATION_ENABLED
      //     unset/false -> stays pending_verify (proves the zero-source
      //     branch requires BOTH flags, not just the new one).
      // ═══════════════════════════════════════════════════════════════
      seedAgent("f1", { website: null, email: "kari@testgard.no" });
      {
        const r = await runOne("f1", { terminalFlag: "true", judgeFn: throwingJudge });
        assertEq(r.new_verification_status, "pending_verify", "f-1: terminal flag ON alone (second-line flag OFF) -> stays pending_verify");
        assertEq(knowledgeRow("f1").verification_status, "pending_verify", "f-2: DB also reflects pending_verify");
      }
      seedAgent("f3", { website: null, email: "kari@testgard.no" });
      {
        const r = await runOne("f3", { terminalFlag: "true", secondLineFlag: "false", judgeFn: throwingJudge });
        assertEq(r.new_verification_status, "pending_verify", "f-3: terminal flag ON, second-line flag explicitly 'false' -> stays pending_verify");
      }

      // ═══════════════════════════════════════════════════════════════
      // (g) pickBatch(): seed one terminal_unconfirmable row and one
      //     pending_verify row -> returned batch contains only the
      //     pending_verify row.
      // ═══════════════════════════════════════════════════════════════
      seedAgent("g-terminal", { website: "https://testgard.no", email: "kari@testgard.no", verificationStatus: "terminal_unconfirmable" });
      seedAgent("g-pending", { website: "https://testgard.no", email: "kari@testgard.no", verificationStatus: "pending_verify" });
      {
        const batch = pickBatch(db, 50);
        const ids = batch.map((r: any) => r.id).filter((id: string) => id === "g-terminal" || id === "g-pending");
        assertTrue(ids.includes("g-pending"), "g-1: pickBatch includes the pending_verify row");
        assertTrue(!ids.includes("g-terminal"), "g-2: pickBatch excludes the terminal_unconfirmable row");
      }

      // ═══════════════════════════════════════════════════════════════
      // (h) dev-request 2026-08-25-terminal-sweep-false-positives —
      //     ACCEPTANCE TEST: the 10 real, measured production rows named in
      //     the dev-request's own 10-row sample. Each seeded exactly like
      //     (e) (no website, zero identity sources -> reaches the fresh-
      //     lookup branch), differing only in producer_name and the fresh-
      //     Brreg fixture wired up for it.
      // ═══════════════════════════════════════════════════════════════
      async function assertStaysNonTerminal(id: string, name: string, deathCheckFetch: typeof fetch, label: string) {
        seedAgent(id, { name, website: null, email: `kari@${id}-testgard.no` });
        const r = await runOne(id, { terminalFlag: "true", secondLineFlag: "true", judgeFn: throwingJudge, deathCheckFetch });
        assertEq(r.new_verification_status, "pending_verify", `${label}: stays pending_verify (alive)`);
        const reason = JSON.parse(knowledgeRow(id).verification_review_reason || "{}");
        assertEq(reason.terminal_reason, undefined, `${label}: no terminal_reason stamped`);
      }
      async function assertGoesTerminal(
        id: string,
        name: string,
        deathCheckFetch: typeof fetch,
        expectedReason: string,
        label: string,
      ) {
        seedAgent(id, { name, website: null, email: `kari@${id}-testgard.no` });
        const r = await runOne(id, { terminalFlag: "true", secondLineFlag: "true", judgeFn: throwingJudge, deathCheckFetch });
        assertEq(r.new_verification_status, "terminal_unconfirmable", `${label}: terminal_unconfirmable`);
        const reason = JSON.parse(knowledgeRow(id).verification_review_reason || "{}");
        assertEq(reason.terminal_reason, expectedReason, `${label}: terminal_reason = '${expectedReason}'`);
      }

      // 1. Aalan Gård — Brreg 969304252, active -> stays pending_verify.
      await assertStaysNonTerminal(
        "h1-aalan-gard", "Aalan Gård",
        buildDeathCheckFetch({
          bySearchName: { "Aalan Gård": { orgNr: "969304252", navn: "Aalan Gård" } },
          byOrgNr: { "969304252": activeDetail("969304252", "Aalan Gård") },
        }),
        "h1 (Aalan Gård)",
      );

      // 2. Njardar (Leinøy) — Brreg 976200020 "NJARDAR AS", active -> stays
      //    pending_verify. core_name strips the "(Leinøy)" location suffix
      //    before searching, same as resolveOrgNrForTarget's own base attempt.
      await assertStaysNonTerminal(
        "h2-njardar", "Njardar (Leinøy)",
        buildDeathCheckFetch({
          bySearchName: { "Njardar": { orgNr: "976200020", navn: "NJARDAR AS" } },
          byOrgNr: { "976200020": activeDetail("976200020", "NJARDAR AS") },
        }),
        "h2 (Njardar)",
      );

      // 3. Jenseg Bakeri og Konditori — Brreg 928335305, active, 31
      //    employees -> stays pending_verify. This is the dev-request's own
      //    headline example (NULL anchor fields at classification time, but
      //    a real, active, 31-employee company).
      await assertStaysNonTerminal(
        "h3-jenseg", "Jenseg Bakeri og Konditori",
        buildDeathCheckFetch({
          bySearchName: { "Jenseg Bakeri og Konditori": { orgNr: "928335305", navn: "Jenseg Bakeri og Konditori" } },
          byOrgNr: { "928335305": activeDetail("928335305", "Jenseg Bakeri og Konditori", { antallAnsatte: 31 }) },
        }),
        "h3 (Jenseg Bakeri og Konditori)",
      );

      // 4. Bærsentralen (Levanger) — Brreg 926888374, active -> stays
      //    pending_verify.
      await assertStaysNonTerminal(
        "h4-baersentralen", "Bærsentralen (Levanger)",
        buildDeathCheckFetch({
          bySearchName: { "Bærsentralen": { orgNr: "926888374", navn: "Bærsentralen" } },
          byOrgNr: { "926888374": activeDetail("926888374", "Bærsentralen") },
        }),
        "h4 (Bærsentralen)",
      );

      // 5. Delås gård (Skjeberg) — NO reliable Brreg match (every search
      //    attempt returns zero hits) -> stays pending_verify. THIS is the
      //    fixture proving the "no match found -> pending_verify, never
      //    terminal" half of the invariant (as opposed to h1-h4/h6-h7's
      //    "match found and active" half).
      await assertStaysNonTerminal(
        "h5-delas-gard", "Delås gård (Skjeberg)",
        buildDeathCheckFetch({}), // no fixtures registered -> every attempt finds nothing
        "h5 (Delås gård, no Brreg match at all)",
      );

      // 6. Daria Best Bakery (Mysen) — Brreg 928176738, active (ENK) ->
      //    stays pending_verify.
      await assertStaysNonTerminal(
        "h6-daria-best-bakery", "Daria Best Bakery (Mysen)",
        buildDeathCheckFetch({
          bySearchName: { "Daria Best Bakery": { orgNr: "928176738", navn: "Daria Best Bakery" } },
          byOrgNr: { "928176738": activeDetail("928176738", "Daria Best Bakery") },
        }),
        "h6 (Daria Best Bakery)",
      );

      // 7. Støylo Gard (Bykle) — Brreg 918800549, active (ENK) -> stays
      //    pending_verify.
      await assertStaysNonTerminal(
        "h7-stoylo-gard", "Støylo Gard (Bykle)",
        buildDeathCheckFetch({
          bySearchName: { "Støylo Gard": { orgNr: "918800549", navn: "Støylo Gard" } },
          byOrgNr: { "918800549": activeDetail("918800549", "Støylo Gard") },
        }),
        "h7 (Støylo Gard)",
      );

      // 8. REKO Grorud — a REKO-ring distribution point name, not a
      //    producer -> terminal_unconfirmable via non_producer_entity.
      //    throwingDeathCheckFetch (the runOne default) proves the pattern
      //    match short-circuits BEFORE any fresh Brreg network call.
      await assertGoesTerminal(
        "h8-reko-grorud", "REKO Grorud",
        throwingDeathCheckFetch,
        "non_producer_entity",
        "h8 (REKO Grorud)",
      );

      // 9. Adamstuen Torg — a public square name, not a producer ->
      //    terminal_unconfirmable via non_producer_entity, no Brreg call.
      await assertGoesTerminal(
        "h9-adamstuen-torg", "Adamstuen Torg",
        throwingDeathCheckFetch,
        "non_producer_entity",
        "h9 (Adamstuen Torg)",
      );

      // 10. Ringerikserter — a protected product designation, not a
      //     producer -> terminal_unconfirmable via non_producer_entity, no
      //     Brreg call.
      await assertGoesTerminal(
        "h10-ringerikserter", "Ringerikserter",
        throwingDeathCheckFetch,
        "non_producer_entity",
        "h10 (Ringerikserter)",
      );

      // ═══════════════════════════════════════════════════════════════
      // (i) positive brreg_konkurs/brreg_inactive path: a fresh lookup DOES
      //     find death evidence -> terminal_unconfirmable via the correct
      //     reason, not non_producer_entity.
      // ═══════════════════════════════════════════════════════════════
      await assertGoesTerminal(
        "i1-konkurs-gard", "Nedlagt Gårdsmat AS",
        buildDeathCheckFetch({
          bySearchName: { "Nedlagt Gårdsmat AS": { orgNr: "915330147", navn: "Nedlagt Gårdsmat AS" } },
          byOrgNr: { "915330147": deadDetail("915330147", "Nedlagt Gårdsmat AS", "bankrupt") },
        }),
        "brreg_konkurs",
        "i1 (fresh lookup finds konkurs)",
      );
      await assertGoesTerminal(
        "i2-slettet-gard", "Slettet Gårdsmat AS",
        buildDeathCheckFetch({
          bySearchName: { "Slettet Gårdsmat AS": { orgNr: "911222334", navn: "Slettet Gårdsmat AS" } },
          byOrgNr: { "911222334": deadDetail("911222334", "Slettet Gårdsmat AS", "dissolved") },
        }),
        "brreg_inactive",
        "i2 (fresh lookup finds slettet/dissolved)",
      );

      // ═══════════════════════════════════════════════════════════════
      // (j) looksLikeNonProducerEntity — direct unit coverage of the
      //     false-positive guards (never make the pattern broader than the
      //     3 fixtures above require).
      // ═══════════════════════════════════════════════════════════════
      assertTrue(looksLikeNonProducerEntity("REKO Grorud").match, "j-1: 'REKO Grorud' matches (reko_distribution_point)");
      assertEq(looksLikeNonProducerEntity("REKO Grorud").pattern, "reko_distribution_point", "j-2: pattern = reko_distribution_point");
      assertTrue(looksLikeNonProducerEntity("Adamstuen Torg").match, "j-3: 'Adamstuen Torg' matches (public_place_name)");
      assertTrue(looksLikeNonProducerEntity("Ringerikserter").match, "j-4: 'Ringerikserter' matches (curated_designation)");
      assertTrue(
        !looksLikeNonProducerEntity("Rekoveien Gård").match,
        "j-5: 'Rekoveien Gård' does NOT match — 'reko' must be a whole FIRST token, not a substring",
      );
      assertTrue(
        !looksLikeNonProducerEntity("Bjerke Gård").match,
        "j-6: an ordinary 2-token farm name not ending in a place-word does NOT match",
      );
      assertTrue(
        !looksLikeNonProducerEntity("Nordbys Gårdsutsalg på Torget").match,
        "j-7: a longer (4-token) name ending in 'torget' does NOT match — only exactly-2-token names do",
      );
      assertTrue(!looksLikeNonProducerEntity("").match, "j-8: empty name does NOT match");
      assertTrue(!looksLikeNonProducerEntity(null).match, "j-9: null name does NOT match");
      assertTrue(
        !looksLikeNonProducerEntity("Kalvatveit Plass").match,
        "j-10: 'Kalvatveit Plass' does NOT match — 'plass' is a common husmannsplass " +
          "(smallholding) farm-name suffix in Norwegian rural naming, not a public square; " +
          "excluding it from NON_PRODUCER_PLACE_SUFFIX_WORDS falls through to the fresh-Brreg " +
          "evidence path, same as any other real producer name (2026-08-25 review fix)",
      );

      // ═══════════════════════════════════════════════════════════════
      // (k) checkFreshBrregDeathEvidence — direct unit coverage of the
      //     domain-token and personal-name-ENK fallback attempts (none of
      //     the (h) fixtures happen to exercise these since their base-name
      //     attempt always resolves the search first).
      // ═══════════════════════════════════════════════════════════════
      {
        // Base name ("Ukjent Produsentnavn") finds nothing; the agent's own
        // website haugenbakst.no yields domain-token candidate "Haugenbakst"
        // (no generic suffix to strip — see domainTokenCandidateName's own
        // doc comment) which EXACTLY matches "Haugenbakst AS" after brreg-
        // client.ts's own org-suffix pruning (confidence 1.0, no postal code
        // needed), and that match is active -> null (not dead), proving the
        // domain-token attempt is reached and its result correctly treated
        // as terminal-BLOCKING (not "try the next attempt"). Org-nr/name
        // deliberately distinct from every OTHER test file's own brreg-
        // client fixtures (verified 2026-08-25) — brreg-client.ts's
        // findOrgnumberByName/verifyOrgNumber caches are module-level and
        // several suites in this repo run concurrently in the same `npm
        // test` process (see tests/test.ts's own "SHARED GLOBAL STATE"
        // header comment), so reusing another suite's exact search-name/
        // org-nr pair here would race against it.
        const fx = buildDeathCheckFetch({
          bySearchName: { "Haugenbakst": { orgNr: "934102876", navn: "Haugenbakst AS" } },
          byOrgNr: { "934102876": activeDetail("934102876", "Haugenbakst AS") },
        });
        const result = await checkFreshBrregDeathEvidence(
          { producer_name: "Ukjent Produsentnavn", website: "https://haugenbakst.no", url: null },
          fx,
        );
        assertEq(result, null, "k-1: domain-token attempt finds an ACTIVE company -> null (not dead)");
      }
      {
        // Base name ("Kari Nilsen") and its domain-token attempt (none —
        // no website/url given) both find nothing; "Kari Nilsen" is
        // personal-name-shaped (looksLikePersonalName) so the personal-
        // name-ENK attempt ("Kari Nilsen ENK") is tried and finds a hit
        // that turns out dissolved -> "brreg_inactive". Org-nr chosen
        // unique per the same cross-suite cache-race note above.
        const fx = buildDeathCheckFetch({
          bySearchName: { "Kari Nilsen ENK": { orgNr: "927741508", navn: "Kari Nilsen" } },
          byOrgNr: { "927741508": deadDetail("927741508", "Kari Nilsen", "dissolved") },
        });
        const result = await checkFreshBrregDeathEvidence(
          { producer_name: "Kari Nilsen", website: null, url: null },
          fx,
        );
        assertEq(result, "brreg_inactive", "k-2: personal-name-ENK fallback attempt finds a dissolved match -> brreg_inactive");
      }
      {
        // No name at all -> null immediately, no fetch call (fx would throw
        // if invoked).
        const result = await checkFreshBrregDeathEvidence(
          { producer_name: null, website: null, url: null },
          throwingDeathCheckFetch,
        );
        assertEq(result, null, "k-3: blank producer_name -> null, no fetch attempted");
      }
    } catch (err: any) {
      failed++;
      failures.push("terminal-unconfirmable: unexpected error: " + String(err?.stack || err?.message || err));
    } finally {
      initMod.__setDbForTesting(prevDb);
      if (prevTerminalFlag === undefined) delete process.env.RFB_TERMINAL_UNCONFIRMABLE_ENABLED;
      else process.env.RFB_TERMINAL_UNCONFIRMABLE_ENABLED = prevTerminalFlag;
      if (prevSecondLineFlag === undefined) delete process.env.RFB_SECOND_LINE_VERIFICATION_ENABLED;
      else process.env.RFB_SECOND_LINE_VERIFICATION_ENABLED = prevSecondLineFlag;
      try { db.close(); } catch { /* ignore */ }
    }

    return { passed, failed, failures };
  })();
}

if (require.main === module) {
  runLokalAgentVerifierTerminalUnconfirmableTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    if (summary.failed > 0) {
      for (const f of summary.failures) console.log(f);
      process.exit(1);
    }
  });
}
