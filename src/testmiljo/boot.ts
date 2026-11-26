/**
 * Testmiljø: boot check. Imported for its side effect as the FIRST import of
 * src/index.ts, so it runs before any other module reads the environment,
 * opens a database or builds a mail transport.
 *
 *   1. TESTMILJO set in production: ignored, with one error line in the log.
 *      TESTMILJO set up wrongly on a developer machine (wrong value, mail
 *      credentials present, no own database files, a network listen
 *      address): throw, the process exits.
 *   2. Test environment on: listen on this machine only (HOST defaults to
 *      127.0.0.1) and block outbound connections (outbound-guard.ts).
 *
 * With TESTMILJO unset this does nothing at all.
 */

import { assertTestmiljoBootSafe, isTestmiljo, testmiljoProductionNotice } from "./guard";
import { installOutboundGuard, parseAllowList } from "./outbound-guard";

const productionNotice = testmiljoProductionNotice();
if (productionNotice) console.error(productionNotice);

assertTestmiljoBootSafe();

if (isTestmiljo()) {
  if (!(process.env.HOST ?? "").trim()) process.env.HOST = "127.0.0.1";
  const allow = parseAllowList(process.env.TESTMILJO_ALLOW_OUTBOUND);
  installOutboundGuard({ allow, log: (message) => console.warn(message) });
  console.log(
    `[testmiljo] TEST ENVIRONMENT. E-mail is captured, not sent. Outbound connections are blocked` +
      (allow.length ? ` except to: ${allow.join(", ")}.` : "."),
  );
}
