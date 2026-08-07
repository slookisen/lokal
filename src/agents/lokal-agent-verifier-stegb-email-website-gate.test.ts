/**
 * lokal-agent-verifier-stegb-email-website-gate.test.ts — tests Steg B of
 * dev-request 2026-07-31-rfb-poolgate-uten-telefon-og-batchkapasitet
 * (2026-08-07): `phone` removed from GATING_FIELDS (cross-source-
 * validator.ts, now ["address"] only) and replaced with a new requirement in
 * runVerifierBatch — a corroborated `agents.contact_email` (from A0's DNS-
 * liveness stamp / A2's contact extraction, landed earlier the same day) +
 * a fresh, live website (the run's own existing website_ok probe).
 *
 * Coverage:
 *   - Negative test (Acceptance B): NO agent without a corroborated email
 *     becomes 'verified'/pool-eligible, even with an otherwise-perfect
 *     pool_eligible address and a live website.
 *   - Positive: a corroborated email (non-empty, never DNS-checked) +
 *     pool_eligible address + live website -> verified + in the pool.
 *   - DNS-confirmed-dead email (contact_email_dns_check.live=false for the
 *     CURRENT contact_email's domain) -> blocked.
 *   - Domain-binding: a DNS-dead stamp for a STALE/DIFFERENT domain (left
 *     over from before A2 replaced the address) does NOT block the new,
 *     never-checked email — proves the domain-anchoring fix is real, not
 *     just "any live:false anywhere blocks".
 *   - Phone no longer gates: address-only pool_eligible + 1-source phone
 *     (review_required on its own) still reaches verified — the literal
 *     "~136 blocked_phone_only" acceptance scenario — while phone is STILL
 *     computed and present in cross_source_reason for review-queue display.
 *   - Regression: lokal#433's enrichment_status='rich'-only outreach_ready_pool
 *     requirement is completely unaffected — a 'verified' agent whose content
 *     only reaches 'partial' (not 'rich') still never appears in the pool.
 *
 * Exported runLokalAgentVerifierStegBEmailWebsiteGateTests({log}) ->
 * TestSummary; wired into tests/test.ts.
 * Standalone: npx tsx src/agents/lokal-agent-verifier-stegb-email-website-gate.test.ts
 */

import Database from "better-sqlite3";
import * as initMod from "../database/init";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

// Long enough that computeEnrichmentStatus's 'rich' bar (about>=150 &&
// products>=3 && address) is cleared by every fixture EXCEPT the dedicated
// lokal#433 regression fixture, which deliberately uses thin content instead.
const RICH_ABOUT =
  "Familiedrevet gårdsbruk med lange tradisjoner innen lokal matproduksjon. " +
  "Vi selger egne varer direkte fra gården til nærmiljøet, og legger vekt på " +
  "kvalitet, bærekraft og kortreist mat gjennom hele året, uansett sesong.";
const RICH_PRODUCTS = JSON.stringify([
  { name: "Melk" }, { name: "Ost" }, { name: "Egg" }, { name: "Poteter" },
]);

// address 2 agreeing Tier-A sources -> pool_eligible on its own under the new
// GATING_FIELDS=["address"]. phone deliberately 1-source (review_required on
// its own) so every fixture in this file also exercises "phone no longer
// gates" implicitly, unless a fixture overrides it.
function baseFieldProvenance(): Record<string, unknown> {
  return {
    address: [
      { value: "Testveien 1, 1400 Ski", source_type: "homepage", fetched_at: "2026-08-01T07:00:00Z" },
      { value: "Testveien 1, 1400 Ski", source_type: "google_places", fetched_at: "2026-08-01T07:05:00Z" },
    ],
    phone: [
      { value: "91234567", source_type: "homepage", fetched_at: "2026-08-01T07:00:00Z" },
    ],
  };
}

export function runLokalAgentVerifierStegBEmailWebsiteGateTests(
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
    const prevDb = initMod.getDb();
    const prevFetch = globalThis.fetch;
    const db = new Database(":memory:");
    try {
      initMod.__setDbForTesting(db as any);
      initMod.__initSchemaForTesting(db as any);

      // runVerifierBatch's opts.headProbe only overrides the basic-gate probe
      // (computeKvalitetsGate's website_ok). The SEPARATE PR-21 link-freshness
      // probe (probeAgentUrl, used for the rich->partial enrichment demotion)
      // always calls the real global fetch with no override hook — stub it so
      // the fake *.no test domains resolve as reachable instead of failing on
      // a real DNS lookup (mirrors admin-agents-rfb-quality-judge.test.ts's
      // globalThis.fetch stubbing convention).
      (globalThis as any).fetch = async () => ({ status: 200 });

      const {
        runVerifierBatch,
      } = require("./lokal-agent-verifier") as typeof import("./lokal-agent-verifier");

      const insertAgent = db.prepare(
        `INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key)
         VALUES (?, ?, 'test agent', 'test', ?, ?, 'producer', ?)`,
      );
      const insertKnowledge = db.prepare(
        `INSERT INTO agent_knowledge
           (agent_id, address, phone, website, email, about, products, field_provenance, verification_status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );

      function seedAgent(seed: {
        id: string;
        name: string;
        domain: string;
        contactEmail: string; // agents.contact_email — the field Steg B gates on
        knowledgeEmail?: string; // agent_knowledge.email — a real-domain default keeps the pre-existing email_own_domain leg trivially satisfied
        fieldProvenance?: Record<string, unknown>;
        verificationStatus?: string;
        about?: string;
        products?: string;
        address?: string | null;
      }): void {
        const url = `https://${seed.domain}`;
        insertAgent.run(seed.id, seed.name, seed.contactEmail, url, `key-${seed.id}`);
        insertKnowledge.run(
          seed.id,
          seed.address === undefined ? "Testveien 1, 1400 Ski" : seed.address,
          "91234567",
          url,
          seed.knowledgeEmail ?? `post@${seed.domain}`,
          seed.about ?? RICH_ABOUT,
          seed.products ?? RICH_PRODUCTS,
          JSON.stringify(seed.fieldProvenance ?? baseFieldProvenance()),
          seed.verificationStatus ?? "pending_verify",
        );
      }

      const mockHeadProbe200 = async (_url: string) => 200 as number | null;

      // ── Fixture 1 (Acceptance B negative test): NO contact_email at all ────
      // Otherwise perfect: pool_eligible address, live website, no other
      // blockers. Must NOT become verified/pool-eligible.
      seedAgent({
        id: "stegb-no-email",
        name: "Ingenepost Gård",
        domain: "ingenepost.no",
        contactEmail: "", // agents.contact_email NOT NULL — empty string is the "no email" case
      });

      // ── Fixture 2: corroborated email present, never DNS-checked ───────────
      seedAgent({
        id: "stegb-never-checked",
        name: "Aldrisjekket Gård",
        domain: "aldrisjekket.no",
        contactEmail: "post@aldrisjekket.no",
      });

      // ── Fixture 3: email DNS-confirmed-dead for the CURRENT domain ─────────
      seedAgent({
        id: "stegb-dead-email",
        name: "Doddomene Gård",
        domain: "doddomene.no",
        contactEmail: "post@doddomene.no",
        fieldProvenance: {
          ...baseFieldProvenance(),
          contact_email_dns_check: {
            checked_at: "2026-08-06T09:00:00Z",
            domain: "doddomene.no",
            live: false,
            method: "none",
            batch_id: "contact-email-dns-check-20260806-0900",
          },
        },
      });

      // ── Fixture 4: STALE dead stamp for a DIFFERENT/OLD domain — must NOT
      // block the current, never-checked email (domain-binding fix). Mirrors
      // A2's real write pattern: contact_email was replaced after the OLD
      // domain was flagged dead, but field_provenance still carries the old
      // stamp (A2 never touches field_provenance).
      seedAgent({
        id: "stegb-stale-stamp",
        name: "Gammelstempel Gård",
        domain: "nyttdomene.no",
        contactEmail: "post@nyttdomene.no",
        fieldProvenance: {
          ...baseFieldProvenance(),
          contact_email_dns_check: {
            checked_at: "2026-07-01T09:00:00Z",
            domain: "gammeltdomene.no", // NOT the current contact_email's domain
            live: false,
            method: "none",
            batch_id: "contact-email-dns-check-20260701-0900",
          },
        },
      });

      // ── Fixture 5: the literal acceptance scenario — pool_eligible address
      // (Tier-S owner override) + corroborated email + live website, but
      // phone is a lone 1-source (would have gated pre-Steg-B: this is a
      // "blocked_phone_only" agent). Must now reach verified.
      seedAgent({
        id: "stegb-phone-only-blocked",
        name: "Telefonblokkert Gård",
        domain: "telefonblokkert.no",
        contactEmail: "post@telefonblokkert.no",
        fieldProvenance: {
          address: [{ value: "Testveien 1, 1400 Ski", source_type: "owner", fetched_at: "2026-08-01T07:00:00Z" }],
          phone: [{ value: "91234567", source_type: "homepage", fetched_at: "2026-08-01T07:00:00Z" }],
        },
      });

      // ── Fixture 6 (lokal#433 regression): 'rich' requirement untouched ─────
      // Same corroborated-email + address + website as fixture 5, but
      // PARTIAL content: about is 80-149 chars (clears computeKvalitetsGate's
      // content_threshold — about>=80 OR products>=3 — so the agent CAN reach
      // 'verified') yet stays under computeEnrichmentStatus's 'rich' bar
      // (about>=150 AND products>=3 AND address). Must reach 'verified' (Steg
      // B gates cleared) but must NEVER appear in outreach_ready_pool, because
      // enrichment_status lands on 'partial', not 'rich' — proves Steg B did
      // not loosen the separate lokal#433 gate.
      seedAgent({
        id: "stegb-rich-regression",
        name: "Delvisinnhold Gård",
        domain: "delvisinnhold.no",
        contactEmail: "post@delvisinnhold.no",
        about: "Vi driver et lite gårdsbruk med fokus på kortreist mat og god kvalitet til våre kunder i nærområdet vårt.", // 105 chars: >=80 (content_threshold) but <150 (not 'rich')
        products: "[]",
      });

      const result = await runVerifierBatch({
        db,
        batchSize: 50,
        brregLookup: null,
        headProbe: mockHeadProbe200,
      });

      function resultFor(id: string) {
        const r = result.results.find((x) => x.agent_id === id);
        assertTrue(!!r, `precondition: result found for ${id}`);
        return r!;
      }

      // ── Fixture 1 assertions (Acceptance B negative test) ──────────────────
      const r1 = resultFor("stegb-no-email");
      assertEq(r1.new_verification_status, "review_required",
        "stegb-01 (ACCEPTANCE B): no agents.contact_email at all -> never verified, despite pool_eligible address + live website");
      assertTrue(r1.flags.includes("corroborated_email_missing"),
        "stegb-02: missing-email flag raised");
      assertEq((r1.cross_source_reason as any)?.email_website_gate?.corroborated_email, false,
        "stegb-03: cross_source_reason.email_website_gate.corroborated_email=false");
      assertEq((r1.cross_source_reason as any)?.email_website_gate?.website_ok, true,
        "stegb-04: cross_source_reason.email_website_gate.website_ok=true (website itself was fine — email is what blocked it)");
      const pool1 = db.prepare("SELECT 1 FROM outreach_ready_pool WHERE agent_id = ?").get("stegb-no-email");
      assertTrue(!pool1, "stegb-05: no-email agent never reaches outreach_ready_pool");

      // ── Fixture 2 assertions (never DNS-checked -> passes) ─────────────────
      const r2 = resultFor("stegb-never-checked");
      assertEq(r2.new_verification_status, "verified",
        "stegb-06: corroborated email (present, never DNS-checked) + pool_eligible address + live website -> verified");
      assertTrue(!r2.flags.includes("corroborated_email_missing"),
        "stegb-07: no missing-email flag when contact_email is present and never checked");
      const pool2 = db.prepare("SELECT 1 FROM outreach_ready_pool WHERE agent_id = ?").get("stegb-never-checked");
      assertTrue(!!pool2, "stegb-08: never-checked-but-present email agent reaches outreach_ready_pool (rich content from RICH_ABOUT/RICH_PRODUCTS)");

      // ── Fixture 3 assertions (DNS-confirmed-dead for current domain) ───────
      const r3 = resultFor("stegb-dead-email");
      assertEq(r3.new_verification_status, "review_required",
        "stegb-09: contact_email_dns_check.live=false for the CURRENT domain -> blocked, not verified");
      assertTrue(r3.flags.includes("corroborated_email_missing"),
        "stegb-10: dead-domain agent gets the missing-email flag");

      // ── Fixture 4 assertions (stale dead-stamp for a DIFFERENT domain) ─────
      const r4 = resultFor("stegb-stale-stamp");
      assertEq(r4.new_verification_status, "verified",
        "stegb-11: a dead-DNS stamp for a STALE/different domain does NOT block the current (never-checked) contact_email — domain-binding works");
      assertTrue(!r4.flags.includes("corroborated_email_missing"),
        "stegb-12: stale-stamp agent has no missing-email flag");

      // ── Fixture 5 assertions (the literal blocked_phone_only scenario) ─────
      const r5 = resultFor("stegb-phone-only-blocked");
      assertEq(r5.new_verification_status, "verified",
        "stegb-13: owner-curated address (only gating field) + corroborated email + live website -> verified, even with a lone 1-source phone");
      // Phone is STILL computed and present in cross_source_reason for the
      // review queue, per the spec's "telefon beregnes og vises fortsatt".
      const phoneReason = (r5.cross_source_reason as any)?.phone;
      assertTrue(!!phoneReason, "stegb-14: cross_source_reason still contains a 'phone' entry (phone is still computed)");
      assertEq(phoneReason?.verdict, "review_required",
        "stegb-15: phone's OWN verdict is still review_required (1 source) — it just doesn't gate the agent anymore");

      // ── Fixture 6 assertions (lokal#433 regression) ─────────────────────────
      const r6 = resultFor("stegb-rich-regression");
      assertEq(r6.new_verification_status, "verified",
        "stegb-16: Steg B gates (address + corroborated email + live website) all clear -> verified");
      assertEq(r6.new_enrichment_status, "partial",
        "stegb-17: enrichment_status lands on 'partial' (about=105 chars clears content_threshold>=80 but is under the 'rich' bar of >=150; 0 products) — lokal#433's rich bar is a completely separate, untouched computation");
      const pool6 = db.prepare("SELECT 1 FROM outreach_ready_pool WHERE agent_id = ?").get("stegb-rich-regression");
      assertTrue(!pool6, "stegb-18: 'verified'-but-partial agent still never reaches outreach_ready_pool — lokal#433's enrichment_status='rich' requirement is completely unaffected by Steg B");
    } finally {
      initMod.__setDbForTesting(prevDb);
      (globalThis as any).fetch = prevFetch;
    }

    return { passed, failed, failures };
  })();
}

if (require.main === module) {
  runLokalAgentVerifierStegBEmailWebsiteGateTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    if (summary.failed > 0) process.exit(1);
  });
}
