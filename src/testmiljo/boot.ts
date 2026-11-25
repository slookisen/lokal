/**
 * Testmiljø: boot check. Imported for its side effect as the FIRST import of
 * src/index.ts, so it runs before any other module reads the environment,
 * opens a database or builds a mail transport.
 *
 *   1. TESTMILJO set where it must not be (production, wrong value, mail
 *      credentials present, no own database files): throw, the process exits.
 *   2. Test environment on: block outbound connections (outbound-guard.ts).
 *
 * With TESTMILJO unset this does nothing at all.
 */

import { assertTestmiljoBootSafe, isTestmiljo } from "./guard";
import { installOutboundGuard, parseAllowList } from "./outbound-guard";

assertTestmiljoBootSafe();

if (isTestmiljo()) {
  const allow = parseAllowList(process.env.TESTMILJO_ALLOW_OUTBOUND);
  installOutboundGuard({ allow, log: (message) => console.warn(message) });
  console.log(
    `[testmiljo] TEST ENVIRONMENT. E-mail is captured, not sent. Outbound connections are blocked` +
      (allow.length ? ` except to: ${allow.join(", ")}.` : "."),
  );
}
