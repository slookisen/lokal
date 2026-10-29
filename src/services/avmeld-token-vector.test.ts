/**
 * avmeld-token-vector.test.ts — guards the /avmeld/:token format (dev-request
 * 2026-10-22-rfb-mine-valg-eierbrytere, S1a point 3) and its separation from
 * other signed links that share the server secret (rfb-bestillinger B2,
 * avmeld-service serverSignatureFor / the stock-check link).
 *
 *   vec-*  fixed vectors: with a known UNSUBSCRIBE_TOKEN_SECRET and a known
 *          address, makeUnsubscribeToken() produces EXACTLY the hard-coded
 *          token of the original algorithm
 *            payload = base64url(address [+ "\nexperiences"])
 *            sig     = base64url(HMAC-SHA256(HMAC-SHA256(secret, "avmeld-v1"), payload))
 *          (also recomputed here with node:crypto, independently of the
 *          module), and verifyUnsubscribeToken() accepts it. Tokens already in
 *          sent mail must keep working.
 *   sep-*  domain separation: a stock-check signature differs from the avmeld
 *          one for the same payload; serverSignatureFor refuses the avmeld
 *          purpose and an empty purpose; an avmeld token is invalid as a
 *          stock-check token and a stock-check payload+sig is not an avmeld
 *          token.
 *
 * Exported runAvmeldTokenVectorTests({log}) -> TestSummary; wired into
 * tests/test.ts. Standalone: npx tsx src/services/avmeld-token-vector.test.ts
 */

import * as crypto from "node:crypto";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

const SECRET = "avmeld-vector-secret-0123456789abcdef";
const EMAIL = "post@vector-gard.example.no";
/** Computed once with the pre-B2 algorithm (see the header). Never regenerate from the module. */
const VECTOR_RFB = "cG9zdEB2ZWN0b3ItZ2FyZC5leGFtcGxlLm5v.OVONtHu-v26DA9rBD-ZvAWhXKbGKeCUNAy40qKkW55k";
const VECTOR_EXPERIENCES = "cG9zdEB2ZWN0b3ItZ2FyZC5leGFtcGxlLm5vCmV4cGVyaWVuY2Vz.HP85xNcJTZWxaYPZw7FqBgCW8qzM72EscJrLIVrdZpM";

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
/** The original avmeld signature, independent of avmeld-service. */
function originalAvmeldSig(secret: string, payload: string): string {
  const key = crypto.createHmac("sha256", secret).update("avmeld-v1").digest();
  return b64url(crypto.createHmac("sha256", key).update(payload).digest());
}

export async function runAvmeldTokenVectorTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];
  const assertEq = (actual: unknown, expected: unknown, label: string) => {
    if (JSON.stringify(actual) === JSON.stringify(expected)) { passed++; if (log) console.info(`  ok ${label}`); }
    else {
      failed++;
      const msg = `✗ ${label}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`;
      failures.push(msg);
      if (log) console.info("  " + msg);
    }
  };
  const assertTrue = (cond: boolean, label: string) => assertEq(cond, true, label);

  const KEYS = ["UNSUBSCRIBE_TOKEN_SECRET", "ADMIN_KEY", "ANALYTICS_ADMIN_KEY"];
  const saved: Record<string, string | undefined> = {};
  for (const k of KEYS) saved[k] = process.env[k];
  const initMod = require("../database/init") as typeof import("../database/init");
  const prevDb = initMod.__peekDbForTesting();
  let db: any = null;
  try {
    for (const k of KEYS) delete process.env[k];
    process.env.UNSUBSCRIBE_TOKEN_SECRET = SECRET;
    const av = require("./avmeld-service") as typeof import("./avmeld-service");
    const sc = require("./stock-check-reminder") as typeof import("./stock-check-reminder");

    // ═══ fixed vectors ═══════════════════════════════════════════════════
    const payloadRfb = b64url(Buffer.from(EMAIL, "utf8"));
    const payloadExp = b64url(Buffer.from(`${EMAIL}\nexperiences`, "utf8"));
    assertEq(`${payloadRfb}.${originalAvmeldSig(SECRET, payloadRfb)}`, VECTOR_RFB, "vec-0: the hard-coded vector is the original algorithm (independent recompute)");
    assertEq(`${payloadExp}.${originalAvmeldSig(SECRET, payloadExp)}`, VECTOR_EXPERIENCES, "vec-0b: … also for the experiences variant");
    assertEq(av.makeUnsubscribeToken(EMAIL), VECTOR_RFB, "vec-1: makeUnsubscribeToken (rfb) produces exactly the fixed token");
    assertEq(av.makeUnsubscribeToken("  POST@Vector-Gard.example.no "), VECTOR_RFB, "vec-2: the address is normalised before signing");
    assertEq(av.makeUnsubscribeToken(EMAIL, "experiences"), VECTOR_EXPERIENCES, "vec-3: makeUnsubscribeToken (experiences) produces exactly the fixed token");
    assertEq(av.verifyUnsubscribeToken(VECTOR_RFB), { email: EMAIL, vertical: "rfb" }, "vec-4: verifyUnsubscribeToken accepts the fixed rfb token");
    assertEq(av.verifyUnsubscribeToken(VECTOR_EXPERIENCES), { email: EMAIL, vertical: "experiences" }, "vec-5: verifyUnsubscribeToken accepts the fixed experiences token");

    // ═══ domain separation ═══════════════════════════════════════════════
    const avSig = VECTOR_RFB.split(".")[1]!;
    const scSig = av.serverSignatureFor("stock-check-v1", payloadRfb);
    assertTrue(typeof scSig === "string" && scSig.length > 0, "sep-1: serverSignatureFor('stock-check-v1') signs");
    assertTrue(scSig !== avSig, "sep-2: the stock-check signature differs from the avmeld signature for the same payload");
    assertEq(av.serverSignatureFor("avmeld-v1", payloadRfb), null, "sep-3: serverSignatureFor refuses the avmeld purpose");
    assertEq(av.serverSignatureFor("", payloadRfb), null, "sep-4: serverSignatureFor refuses an empty purpose");
    assertEq(av.verifyUnsubscribeToken(`${payloadRfb}.${scSig}`), null, "sep-5: a stock-check payload+sig is not an avmeld token");

    // End to end against the stock-check verifier (needs a DB for the notice lookup).
    const Database = require("better-sqlite3");
    db = new Database(":memory:");
    initMod.__setDbForTesting(db);
    initMod.__initSchemaForTesting(db);
    assertEq(sc.verifyStockCheckToken(VECTOR_RFB, { db }).state, "invalid", "sep-6: a real avmeld token is invalid as a stock-check token");
    assertEq(sc.verifyStockCheckToken(`s1.${VECTOR_RFB}`, { db }).state, "invalid", "sep-7: … also with an «s1.» prefix");
    // A stock-check-shaped payload signed with the avmeld key must not verify either.
    const scPayload = b64url(Buffer.from(JSON.stringify({ a: "ag", n: "n".repeat(24), x: Math.floor(Date.now() / 1000) + 3600 }), "utf8"));
    db.prepare(`INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key) VALUES ('ag', 'Gard', 'x', 'test', 'a@b.no', 'https://b.no', 'producer', 'k-ag')`).run();
    db.prepare(`INSERT INTO stock_check_notices (id, agent_id, product_ids, item_count, status, created_at, link_expires_at) VALUES (?, 'ag', '[]', 0, 'sent', ?, ?)`)
      .run(crypto.createHash("sha256").update("n".repeat(24), "utf8").digest("hex"), new Date().toISOString(), new Date(Date.now() + 3600_000).toISOString());
    const genuine = `s1.${scPayload}.${av.serverSignatureFor("stock-check-v1", scPayload)}`;
    assertEq(sc.verifyStockCheckToken(genuine, { db }).state, "valid", "sep-8: control — the stock-check key verifies its own token");
    assertEq(sc.verifyStockCheckToken(`s1.${scPayload}.${originalAvmeldSig(SECRET, scPayload)}`, { db }).state, "invalid",
      "sep-9: a stock-check payload signed with the avmeld key → invalid");
  } catch (err: any) {
    failed++;
    failures.push("unexpected error: " + String(err?.stack || err));
  } finally {
    for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    if (prevDb) initMod.__setDbForTesting(prevDb);
    try { db?.close(); } catch { /* ignore */ }
  }
  return { passed, failed, failures };
}

if (require.main === module) {
  runAvmeldTokenVectorTests({ log: process.argv.includes("--log") }).then((r) => {
    console.info(`\navmeld-token-vector: ${r.passed} passed, ${r.failed} failed`);
    for (const f of r.failures) console.info(f);
    process.exit(r.failed ? 1 : 0);
  });
}
