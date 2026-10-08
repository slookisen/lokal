/**
 * recipient-policy.test.ts — dev-request 2026-10-06-mottakerpolicy-kald-
 * utsending-mfl-15 (markedsføringsloven § 15). Pure classifier: cold mail only
 * to GENERAL role addresses; personal, free-mail and malformed are held back
 * (fail-closed).
 *
 * Standalone: npx tsx src/services/recipient-policy.test.ts
 */
import { RECIPIENT_POLICY_MODE, classifyRecipientAddress, isColdRecipientAllowed } from "./recipient-policy";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export function runRecipientPolicyTests(): TestSummary {
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];
  const check = (cond: boolean, label: string): void => {
    if (cond) passed++;
    else {
      failed++;
      failures.push(`✗ ${label}`);
    }
  };

  check(RECIPIENT_POLICY_MODE === "strict", "rp0: default mode is 'strict'");

  const general = [
    "post@gard.no",
    "firmapost@gard.no",
    "kontakt@gard.no",
    "info@gard.no",
    "kontakt@gardsbutikk.no",
    "  Post@Gard.NO  ",
    "INFO@Gard.no",
    "postmottak@kommune.no",
    "bestilling@gard.no",
  ];
  for (const e of general) {
    const c = classifyRecipientAddress(e);
    check(c.general === true && c.reason === "general_role_address", `rp1: general -> ${JSON.stringify(e)}`);
    check(isColdRecipientAllowed(e) === true, `rp1b: allowed -> ${JSON.stringify(e)}`);
  }

  const personal = [
    "ola.nordmann@firma.no",
    "kari@gard.no",
    "post.ola@gard.no",
    "info2@gard.no",
    "gardsbutikk.navn@firma.no",
  ];
  for (const e of personal) {
    const c = classifyRecipientAddress(e);
    check(c.general === false && c.reason === "personal_local_part", `rp2: personal -> ${e}`);
    check(isColdRecipientAllowed(e) === false, `rp2b: held -> ${e}`);
  }

  // Free-mail is never general, even with a generic local part (Daniel 2026-10-06).
  for (const e of ["anything@gmail.com", "kontakt@gmail.com", "post@gmail.com", "info@hotmail.com", "post@outlook.com", "kontakt@online.no", "info@Online.NO"]) {
    const c = classifyRecipientAddress(e);
    check(c.general === false && c.reason === "free_mail_domain", `rp3: free-mail -> ${e}`);
  }

  // Malformed / empty / non-string -> not general.
  for (const e of ["", "   ", "post", "post@", "@gard.no", "post@gard", "po st@gard.no", "post@@gard.no", "a@b@gard.no", null, undefined, 42, {}]) {
    const c = classifyRecipientAddress(e as unknown);
    check(c.general === false && c.reason === "malformed_or_empty", `rp4: malformed -> ${JSON.stringify(e)}`);
    check(isColdRecipientAllowed(e as unknown) === false, `rp4b: held -> ${JSON.stringify(e)}`);
  }

  return { passed, failed, failures };
}

if (require.main === module) {
  const r = runRecipientPolicyTests();
  console.log(`recipient-policy: ${r.passed} passed, ${r.failed} failed`);
  for (const f of r.failures) console.log(f);
  process.exit(r.failed > 0 ? 1 : 0);
}
