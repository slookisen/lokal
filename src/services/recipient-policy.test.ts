/**
 * recipient-policy.test.ts — dev-request 2026-10-08-mottakerpolicy-alle-adresser
 * (replaces the "strict" mode of 2026-10-06-mottakerpolicy-kald-utsending-mfl-15).
 * Cold outreach goes to every well-formed address, personal and free-mail
 * included; only malformed/empty input is held. The classifier is kept for
 * reporting (countRecipientAddressTypes).
 *
 * Standalone: npx tsx src/services/recipient-policy.test.ts
 */
import {
  RECIPIENT_POLICY_MODE,
  classifyRecipientAddress,
  countRecipientAddressTypes,
  isColdRecipientAllowed,
} from "./recipient-policy";

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

  check(RECIPIENT_POLICY_MODE === "all_valid", "rp0: mode is 'all_valid'");

  // AC1 (dev-request 2026-10-08): personal, free-mail and general addresses are all allowed.
  for (const e of ["ola@gard.no", "ola.nordmann@gmail.com", "hei@gard.no", "post@gard.no"]) {
    check(isColdRecipientAllowed(e) === true, `rp-ac1: allowed -> ${e}`);
  }

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
    check(isColdRecipientAllowed(e) === true, `rp2b: allowed since 2026-10-08 -> ${e}`);
  }

  // Free-mail is still classified as such (reporting), and allowed.
  for (const e of ["anything@gmail.com", "kontakt@gmail.com", "post@gmail.com", "info@hotmail.com", "post@outlook.com", "kontakt@online.no", "info@Online.NO"]) {
    const c = classifyRecipientAddress(e);
    check(c.general === false && c.reason === "free_mail_domain", `rp3: free-mail -> ${e}`);
    check(isColdRecipientAllowed(e) === true, `rp3b: allowed since 2026-10-08 -> ${e}`);
  }

  // Malformed / empty / non-string -> classified malformed, still held.
  for (const e of ["", "   ", "post", "post@", "@gard.no", "post@gard", "po st@gard.no", "post@@gard.no", "a@b@gard.no", "ikke-en-adresse", null, undefined, 42, {}]) {
    const c = classifyRecipientAddress(e as unknown);
    check(c.general === false && c.reason === "malformed_or_empty", `rp4: malformed -> ${JSON.stringify(e)}`);
    check(isColdRecipientAllowed(e as unknown) === false, `rp4b: held -> ${JSON.stringify(e)}`);
  }

  // Reporting counter: one bucket per address type, every bucket present.
  const counts = countRecipientAddressTypes(["post@gard.no", "kari@gard.no", "ola@gmail.com", "kontakt@online.no", "", null]);
  check(
    JSON.stringify(counts) ===
      JSON.stringify({ general_role_address: 1, personal_local_part: 1, free_mail_domain: 2, malformed_or_empty: 2 }),
    `rp5: countRecipientAddressTypes buckets -> ${JSON.stringify(counts)}`,
  );
  const empty = countRecipientAddressTypes([]);
  check(
    JSON.stringify(empty) ===
      JSON.stringify({ general_role_address: 0, personal_local_part: 0, free_mail_domain: 0, malformed_or_empty: 0 }),
    "rp6: countRecipientAddressTypes([]) has every bucket at 0",
  );

  return { passed, failed, failures };
}

if (require.main === module) {
  const r = runRecipientPolicyTests();
  console.log(`recipient-policy: ${r.passed} passed, ${r.failed} failed`);
  for (const f of r.failures) console.log(f);
  process.exit(r.failed > 0 ? 1 : 0);
}
