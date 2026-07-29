/**
 * contact-normalizer-write-guard.test.ts — unit + integration tests for the
 * WRITE-time contact guard (dev-request
 * 2026-07-28-rfb-kontaktekstraksjon-orgnr-som-telefon, slice 1):
 *
 *   validatePhoneForWrite() / stripTrailingContactLabel() in
 *   services/contact-normalizer.ts, wired into
 *   KnowledgeService.upsertKnowledge() (services/knowledge-service.ts).
 *
 * Root cause this closes: the enrichment write path had a function that
 * knows how to recognise a VALID 8-digit Norwegian phone number
 * (national8/normalizePhone), but only ever consulted it at
 * comparison/display time — never at write time. Confirmed live breaches
 * (2026-07-27, controller/enrichment-write-pause.yaml):
 *   • agent org-nr "927011840" written verbatim into `phone`.
 *   • "20100101" (a date) written verbatim into `phone`.
 *   • "Valmen 54, 2460 Osen Telefon" — a scraped "Telefon" label leaked onto
 *     the end of an address string.
 *
 * Structured per the dev-request's mutation-test requirement: each rule
 * (shape / not-own-org-nr / not-a-date) has at least one fixture that ONLY
 * that rule catches, so disabling any single rule (but keeping the others)
 * makes exactly that fixture's assertion fail.
 *
 * Two ways to run:
 *   1. Standalone: npx tsx src/services/contact-normalizer-write-guard.test.ts
 *   2. Wired into the gate: tests/test.ts imports
 *      runContactNormalizerWriteGuardTests() and folds its pass/fail counts
 *      into the `npm test` summary.
 */

import Database from "better-sqlite3";
import { validatePhoneForWrite, stripTrailingContactLabel } from "./contact-normalizer";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export function runContactNormalizerWriteGuardTests(opts: { log?: boolean } = {}): TestSummary {
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

  // ── validatePhoneForWrite: real breach values ────────────────────────────
  {
    // Real breach 1: org-nr written verbatim as phone. 9 digits ⇒ rule 1
    // (shape) rejects it; it ALSO equals the agent's own org-nr ⇒ rule 2
    // would independently reject it too. Either way the result must be null.
    assertEq(
      validatePhoneForWrite("927 011 840", "927011840"),
      null,
      "validatePhoneForWrite: real breach — org-nr written as phone ⇒ rejected",
    );

    // Real breach 2: an 8-digit date written verbatim as phone (no org-nr on
    // record for this agent at write time).
    assertEq(
      validatePhoneForWrite("20100101", null),
      null,
      "validatePhoneForWrite: real breach — date-shaped value ⇒ rejected (rule 3)",
    );
  }

  // ── Mutation-test: each rule has a fixture ONLY that rule catches ────────
  {
    // Rule 1 ONLY: 7-digit partial. Not org-nr-related (no orgNr passed),
    // not date-shaped (wrong digit count) — only the shape check catches
    // this. Removing rule 1 (keeping 2+3) would let this through.
    assertEq(
      validatePhoneForWrite("9112233", null),
      null,
      "validatePhoneForWrite: rule1-only — 7-digit partial rejected (not 8-digit shape)",
    );

    // Rule 2 ONLY: "27011840" IS a valid 8-digit shape (passes rule 1, and
    // is not date-shaped — month "01" day "18" is a valid date actually, so
    // pick digits that also dodge rule 3: 27/01/1840 -> day 27, month 01 is
    // fine as a date... use a value where day/month are out of range instead
    // to be unambiguous) but equals the agent's own org-nr's LAST 8 digits —
    // a length-only check would wrongly accept it. Must be rejected by rule
    // 2 alone: removing rule 2 (keeping rules 1+3) makes this fail while the
    // other fixtures still pass.
    assertEq(
      validatePhoneForWrite("27011840", "927011840"),
      null,
      "validatePhoneForWrite: rule2-only — matches org-nr's last-8-digits, valid 8-digit shape otherwise",
    );

    // Rule 3 ONLY: "19991231" is a valid 8-digit shape (rule 1 passes) and
    // does not match any org-nr (orgNr null, rule 2 not applicable) — only
    // the date-plausibility check catches this. Removing rule 3 (keeping
    // rules 1+2) would let this through.
    assertEq(
      validatePhoneForWrite("19991231", null),
      null,
      "validatePhoneForWrite: rule3-only — plausible YYYYMMDD date, no org-nr conflict",
    );

    // Regression: bare (no "+"/"00") "47"-prefixed 10-digit value whose
    // national8-reduced form matches the org-nr's last 8 digits.
    // normalizePhone() only strips "+47"/"0047"/leading "+" — it does NOT
    // strip a bare "47" prefix, so the full-digit-string comparison
    // ("4727011840" vs "927011840"/"27011840") never matches on length
    // alone. But national8() (rule 1's `reduced`) DOES recognise the bare
    // 10-digit "47xxxxxxxx" shape and reduces it to "27011840", which is
    // exactly org-nr "927011840"'s last 8 digits — a genuine org-nr
    // collision in disguise. Rule 2 must catch this via the `reduced`
    // comparison, not just the raw-digit-string comparison.
    assertEq(
      validatePhoneForWrite("4727011840", "927011840"),
      null,
      "validatePhoneForWrite: rule2 regression — bare 47-prefixed value reduces to org-nr's last-8-digits",
    );
  }

  // ── Negative control: a genuinely valid phone is NOT rejected ────────────
  {
    const result = validatePhoneForWrite("911 22 333", "927011840");
    assertTrue(result !== null, "validatePhoneForWrite NEG: genuinely valid 8-digit number is accepted");
    assertEq(result, "911 22 333", "validatePhoneForWrite NEG: accepted value is returned UNCHANGED (original raw)");
  }

  // ── Fail-closed basics ────────────────────────────────────────────────────
  {
    assertEq(validatePhoneForWrite(null, "927011840"), null, "validatePhoneForWrite: null raw ⇒ null");
    assertEq(validatePhoneForWrite(undefined, "927011840"), null, "validatePhoneForWrite: undefined raw ⇒ null");
    assertEq(validatePhoneForWrite("", "927011840"), null, "validatePhoneForWrite: empty raw ⇒ null");
  }

  // ── stripTrailingContactLabel ─────────────────────────────────────────────
  {
    assertEq(
      stripTrailingContactLabel("Valmen 54, 2460 Osen Telefon"),
      "Valmen 54, 2460 Osen",
      "stripTrailingContactLabel: real breach — trailing 'Telefon' label stripped",
    );
    assertEq(
      stripTrailingContactLabel("Storgata 5, Kontakt:"),
      "Storgata 5",
      "stripTrailingContactLabel: trailing 'Kontakt:' (label + separator) stripped",
    );
    assertEq(
      stripTrailingContactLabel("Kontaktveien 3"),
      "Kontaktveien 3",
      "stripTrailingContactLabel NEG: label embedded in a real street name is NOT stripped",
    );
    assertEq(
      stripTrailingContactLabel(null),
      null,
      "stripTrailingContactLabel: null passthrough",
    );
    assertEq(
      stripTrailingContactLabel(undefined),
      undefined,
      "stripTrailingContactLabel: undefined passthrough",
    );
    // Would-become-blank guard: no separator before the label at all, so it
    // never even matches as a "trailing" label.
    assertEq(
      stripTrailingContactLabel("Telefon"),
      "Telefon",
      "stripTrailingContactLabel NEG: bare label with nothing preceding it is left unchanged",
    );
    // Would-become-blank guard, actually exercised: the label DOES match as
    // trailing (leading comma separator), but stripping it would leave
    // nothing but punctuation ⇒ must return the original, not "".
    assertEq(
      stripTrailingContactLabel(", Telefon"),
      ", Telefon",
      "stripTrailingContactLabel NEG: stripping would leave the address blank ⇒ original returned unchanged",
    );
  }

  // ── Integration: KnowledgeService.upsertKnowledge() ──────────────────────
  {
    const { __setDbForTesting, __initSchemaForTesting, __peekDbForTesting } = require("../database/init") as
      typeof import("../database/init");
    const { knowledgeService } = require("./knowledge-service") as typeof import("./knowledge-service");

    const prevDb = __peekDbForTesting();
    const testDb = new Database(":memory:");
    testDb.pragma("journal_mode = DELETE");
    testDb.pragma("foreign_keys = OFF");

    try {
      __setDbForTesting(testDb as any);
      __initSchemaForTesting(testDb as any);

      function insertAgent(id: string, orgNr: string | null): void {
        testDb.prepare(`
          INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, org_nr)
          VALUES (?, ?, 'test producer', 'test', 'test@example.no', 'https://example.no', 'producer', ?, ?)
        `).run(id, `Agent ${id}`, `key-${id}`, orgNr);
      }

      // (1) INSERT path: brand-new agent, enrichment tries to write the
      // agent's own org-nr as its phone number. Row must end up with
      // phone IS NULL, not the bad value.
      insertAgent("agent-insert-bad-phone", "927011840");
      knowledgeService.upsertKnowledge("agent-insert-bad-phone", {
        phone: "927 011 840",
        dataSource: "auto",
      } as any);
      const row1 = testDb.prepare("SELECT phone FROM agent_knowledge WHERE agent_id = ?").get("agent-insert-bad-phone") as any;
      assertEq(row1?.phone ?? null, null, "upsertKnowledge INSERT: org-nr-as-phone rejected, phone left NULL");

      // (2) UPDATE path: agent already has a GOOD phone on file. A new
      // enrichment call tries to overwrite it with a date-shaped bad value.
      // The existing good phone must be PRESERVED — not overwritten, not
      // blanked.
      insertAgent("agent-update-preserve", null);
      knowledgeService.upsertKnowledge("agent-update-preserve", {
        phone: "911 22 333",
        dataSource: "auto",
      } as any);
      const beforeRow = testDb.prepare("SELECT phone FROM agent_knowledge WHERE agent_id = ?").get("agent-update-preserve") as any;
      assertEq(beforeRow?.phone, "911 22 333", "upsertKnowledge INSERT: genuinely valid phone stored as-is (setup step)");

      knowledgeService.upsertKnowledge("agent-update-preserve", {
        phone: "20100101",
        dataSource: "auto",
      } as any);
      const afterRow = testDb.prepare("SELECT phone FROM agent_knowledge WHERE agent_id = ?").get("agent-update-preserve") as any;
      assertEq(afterRow?.phone, "911 22 333", "upsertKnowledge UPDATE: bad new phone rejected, existing good phone preserved (not overwritten, not blanked)");

      // (3) INSERT path: address with a leaked "Telefon" label gets cleaned
      // before storage.
      insertAgent("agent-insert-address-label", null);
      knowledgeService.upsertKnowledge("agent-insert-address-label", {
        address: "Valmen 54, 2460 Osen Telefon",
        dataSource: "auto",
      } as any);
      const row3 = testDb.prepare("SELECT address FROM agent_knowledge WHERE agent_id = ?").get("agent-insert-address-label") as any;
      assertEq(row3?.address, "Valmen 54, 2460 Osen", "upsertKnowledge INSERT: trailing 'Telefon' label stripped from address before storage");
    } catch (err) {
      failed++;
      failures.push(`contact-normalizer-write-guard: unexpected error: ${err instanceof Error ? (err.stack || err.message) : String(err)}`);
    } finally {
      if (prevDb) __setDbForTesting(prevDb);
      testDb.close();
    }
  }

  return { passed, failed, failures };
}

// Standalone runner: `npx tsx src/services/contact-normalizer-write-guard.test.ts`
if (require.main === module) {
  console.log("── contact-normalizer write-guard unit + integration tests ──");
  const r = runContactNormalizerWriteGuardTests({ log: true });
  console.log(`\ncontact-normalizer-write-guard: ${r.passed} passed, ${r.failed} failed`);
  if (r.failed > 0) {
    console.log(r.failures.join("\n"));
    process.exit(1);
  }
  process.exit(0);
}
