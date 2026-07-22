/**
 * consumer-keys.test.ts — dev-request 2026-07-13-agent-identity-usage-ledger,
 * slice 1.
 *
 * Covers acceptance criteria 2, 3, 4, and 6:
 *   2. Issuance returns the plaintext key exactly once; only its hash is
 *      ever stored (no plaintext column exists at all); two issuances never
 *      return the same key.
 *   3. Revoke: revoked key immediately stops being recognized (falls
 *      through to the anonymous path via consumerIdentity — does NOT
 *      error), while ledger history for it is preserved.
 *   4. Erase: PII fields (label/contact_email) are gone/nulled afterward,
 *      and the erased key also stops working.
 *   6. Usage ledger: N calls with the same key to the same endpoint/tool on
 *      the same day produce exactly one row with call_count = N (not N
 *      rows) — and a different endpoint/tool gets its own separate row.
 *
 * Same synchronous router.handle() + in-memory-DB convention as
 * admin-blocklist-manual-entry.test.ts.
 */

import Database from "better-sqlite3";
import { __setDbForTesting, __initSchemaForTesting } from "../database/init";
import { consumerIdentity, hashApiKey } from "../middleware/consumer-identity";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

interface RouteResult {
  status: number;
  body: any;
}

function callRouteSync(
  router: any,
  opts: { method?: string; url: string; body?: any; headers?: Record<string, string> },
): RouteResult {
  let result: RouteResult = { status: 200, body: undefined };
  const headers = opts.headers || {};
  const req: any = {
    method: opts.method || "GET",
    url: opts.url,
    path: opts.url.split("?")[0],
    query: {},
    headers,
    body: opts.body,
    get(name: string) {
      return headers[name.toLowerCase()];
    },
    header(name: string) {
      return headers[name.toLowerCase()];
    },
  };
  const res: any = {
    statusCode: 200,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: any) {
      result = { status: this.statusCode, body: payload };
      return this;
    },
  };
  router.handle(req, res, (err?: any) => {
    if (err) result = { status: 500, body: { error: String(err) } };
  });
  return result;
}

// Fake req/res for exercising consumerIdentity directly (ledger dedup test).
// `.on("finish", cb)` captures the callback instead of firing it — the
// caller triggers it manually via the returned `triggerFinish()`, mirroring
// the moment a real Express response actually finishes sending.
function makeIdentityReqRes(opts: { method?: string; path: string; body?: any; apiKey?: string }): {
  req: any;
  res: any;
  triggerFinish: () => void;
} {
  const headers: Record<string, string> = {};
  if (opts.apiKey) headers["x-api-key"] = opts.apiKey;
  const req: any = {
    method: opts.method || "POST",
    path: opts.path,
    body: opts.body,
    header(name: string) {
      return headers[name.toLowerCase()];
    },
  };
  let finishCb: (() => void) | undefined;
  const res: any = {
    on(event: string, cb: () => void) {
      if (event === "finish") finishCb = cb;
      return res;
    },
  };
  return { req, res, triggerFinish: () => finishCb && finishCb() };
}

export function runConsumerKeysTests(opts: { log?: boolean } = {}): TestSummary {
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
    assertEq(cond, true, label);
  }

  const db = new Database(":memory:");
  __setDbForTesting(db as any);
  __initSchemaForTesting(db as any);

  try {
    const router = require("./consumer-keys").default;

    // ── Criterion 2: schema never has a plaintext column ────────────────
    const columns = (db.prepare("PRAGMA table_info(consumer_api_keys)").all() as any[]).map((c) => c.name);
    assertTrue(columns.includes("key_hash"), "schema: consumer_api_keys has key_hash column");
    assertTrue(
      !columns.some((c) => /^(key|plaintext|raw_key|api_key)$/i.test(c)),
      "schema: consumer_api_keys has NO plaintext-key column of any kind (only key_hash)",
    );

    // ── Criterion 2: issuance returns the key exactly once; two issuances
    // never collide; the DB row never contains the plaintext ──────────
    const res1 = callRouteSync(router, { method: "POST", url: "/keys", body: { label: "test-consumer-1" } });
    assertEq(res1.status, 201, "POST /api/keys -> 201");
    assertEq(res1.body?.success, true, "POST /api/keys -> success:true");
    assertTrue(typeof res1.body?.key === "string" && res1.body.key.length > 20, "POST /api/keys -> returns a plaintext key string");
    assertTrue(typeof res1.body?.key_id === "number" || typeof res1.body?.key_id === "bigint", "POST /api/keys -> returns numeric key_id");

    const res2 = callRouteSync(router, { method: "POST", url: "/keys", body: { label: "test-consumer-2" } });
    assertTrue(res2.body?.key !== res1.body?.key, "two issuances never return the same plaintext key");

    const row1 = db.prepare("SELECT * FROM consumer_api_keys WHERE id = ?").get(res1.body.key_id) as any;
    assertTrue(!!row1, "issued key row exists in consumer_api_keys");
    assertEq(row1.key_hash, hashApiKey(res1.body.key), "stored key_hash matches sha256(plaintext key)");
    assertTrue(
      !Object.values(row1).some((v) => v === res1.body.key),
      "grep the DB write: the plaintext key value is NOT stored verbatim in any column of the row",
    );
    assertEq(row1.label, "test-consumer-1", "label stored as provided");
    assertEq(row1.rate_tier, "keyed", "rate_tier defaults to 'keyed'");

    // ── Criterion 2 (cont.): the key is never retrievable again — there is
    // no GET/list endpoint on this router at all. ───────────────────────
    const routerStack = (router as any).stack as any[];
    const registeredPaths = routerStack
      .filter((l) => l.route)
      .map((l) => `${Object.keys(l.route.methods)[0]} ${l.route.path}`);
    assertTrue(
      !registeredPaths.some((p) => /^get /i.test(p)),
      "consumer-keys router registers no GET route at all (no way to read a key back after issuance)",
    );

    // ── Criterion 3: revoke ─────────────────────────────────────────────
    const revokeRes = callRouteSync(router, {
      method: "POST",
      url: "/keys/revoke",
      body: { key: res1.body.key },
    });
    assertEq(revokeRes.status, 200, "POST /api/keys/revoke -> 200 (not an error)");
    assertEq(revokeRes.body?.success, true, "revoke -> success:true");
    assertEq(revokeRes.body?.revoked, true, "revoke -> revoked:true for a real, active key");

    const revokedRow = db.prepare("SELECT revoked_at FROM consumer_api_keys WHERE id = ?").get(res1.body.key_id) as any;
    assertTrue(!!revokedRow.revoked_at, "revoked_at is stamped after revoke");

    // Revoking again is idempotent, not an error, and reports revoked:false
    // (already revoked) rather than throwing — no oracle beyond the boolean.
    const revokeAgainRes = callRouteSync(router, {
      method: "POST",
      url: "/keys/revoke",
      body: { key: res1.body.key },
    });
    assertEq(revokeAgainRes.status, 200, "re-revoke -> still 200, not an error");
    assertEq(revokeAgainRes.body?.revoked, false, "re-revoke -> revoked:false (already revoked)");

    // Revoking an unknown key never errors either (possession-of-key is the
    // only auth; no oracle for "does this key exist").
    const revokeUnknownRes = callRouteSync(router, {
      method: "POST",
      url: "/keys/revoke",
      body: { key: "rfb_this-key-was-never-issued" },
    });
    assertEq(revokeUnknownRes.status, 200, "revoke of an unknown key -> 200, not an error");
    assertEq(revokeUnknownRes.body?.revoked, false, "revoke of an unknown key -> revoked:false");

    // Criterion 3 (cont.): the revoked key immediately falls through to the
    // anonymous path via consumerIdentity — it does NOT error, and it does
    // NOT get treated as valid.
    {
      const { req, res } = makeIdentityReqRes({ path: "/whatever", apiKey: res1.body.key });
      let nextCalled = 0;
      let threw = false;
      try {
        consumerIdentity(req, res, () => {
          nextCalled++;
        });
      } catch {
        threw = true;
      }
      assertEq(threw, false, "revoked key through consumerIdentity: never throws");
      assertEq(nextCalled, 1, "revoked key through consumerIdentity: falls through to anonymous (next() called)");
      assertEq(req.consumerKeyId, undefined, "revoked key through consumerIdentity: no consumerKeyId attached");
    }

    // ── Criterion 4: erasure ─────────────────────────────────────────────
    const issueForErase = callRouteSync(router, {
      method: "POST",
      url: "/keys",
      body: { label: "erase-me", contact_email: "consumer@example.com" },
    });
    assertEq(issueForErase.status, 201, "issue key for erasure test -> 201");

    const eraseRes = callRouteSync(router, {
      method: "POST",
      url: "/keys/erase",
      body: { key: issueForErase.body.key },
    });
    assertEq(eraseRes.status, 200, "POST /api/keys/erase -> 200");
    assertEq(eraseRes.body?.success, true, "erase -> success:true");
    assertEq(eraseRes.body?.erased, true, "erase -> erased:true");

    const erasedRow = db.prepare("SELECT * FROM consumer_api_keys WHERE id = ?").get(issueForErase.body.key_id) as any;
    assertEq(erasedRow.label, null, "erasure: label is nulled");
    assertEq(erasedRow.contact_email, null, "erasure: contact_email is nulled");
    assertTrue(!!erasedRow.deleted_at, "erasure: deleted_at is stamped");
    assertTrue(!!erasedRow.revoked_at, "erasure: also revokes the key (an erased key must not keep working)");

    // Erased key also falls through to anonymous via consumerIdentity.
    {
      const { req, res } = makeIdentityReqRes({ path: "/whatever", apiKey: issueForErase.body.key });
      let nextCalled = 0;
      consumerIdentity(req, res, () => {
        nextCalled++;
      });
      assertEq(nextCalled, 1, "erased key through consumerIdentity: falls through to anonymous");
      assertEq(req.consumerKeyId, undefined, "erased key through consumerIdentity: no consumerKeyId attached");
    }

    // Erasing an unknown key never errors.
    const eraseUnknownRes = callRouteSync(router, {
      method: "POST",
      url: "/keys/erase",
      body: { key: "rfb_this-key-was-never-issued-either" },
    });
    assertEq(eraseUnknownRes.status, 200, "erase of an unknown key -> 200, not an error");
    assertEq(eraseUnknownRes.body?.erased, false, "erase of an unknown key -> erased:false");

    // Missing key on revoke/erase -> 400 (client error, not a crash).
    const missingKeyRevoke = callRouteSync(router, { method: "POST", url: "/keys/revoke", body: {} });
    assertEq(missingKeyRevoke.status, 400, "revoke with no key at all -> 400");
    const missingKeyErase = callRouteSync(router, { method: "POST", url: "/keys/erase", body: {} });
    assertEq(missingKeyErase.status, 400, "erase with no key at all -> 400");

    // ── Criterion 6: ledger upsert-increment, not insert-per-call ────────
    const ledgerIssue = callRouteSync(router, { method: "POST", url: "/keys", body: {} });
    const ledgerKey = ledgerIssue.body.key as string;
    const N = 5;
    for (let i = 0; i < N; i++) {
      const { req, res, triggerFinish } = makeIdentityReqRes({
        method: "POST",
        path: "/mcp",
        apiKey: ledgerKey,
        body: { jsonrpc: "2.0", method: "tools/call", params: { name: "lokal_search" }, id: i },
      });
      consumerIdentity(req, res, () => {});
      assertEq(req.consumerKeyId, ledgerIssue.body.key_id, `ledger call ${i}: consumerIdentity recognizes the active key`);
      triggerFinish(); // simulate the response actually completing
    }

    const ledgerRows = db
      .prepare(
        `SELECT * FROM consumer_usage_ledger WHERE key_id = ? AND endpoint_or_tool = 'lokal_search'`,
      )
      .all(ledgerIssue.body.key_id) as any[];
    assertEq(ledgerRows.length, 1, `${N} calls to the same key+tool+day produce exactly ONE ledger row (not ${N} rows)`);
    assertEq(ledgerRows[0]?.call_count, N, `that one row's call_count equals ${N}`);

    // A DIFFERENT tool/endpoint gets its OWN separate row, not folded into
    // the same counter.
    {
      const { req, res, triggerFinish } = makeIdentityReqRes({
        method: "POST",
        path: "/mcp",
        apiKey: ledgerKey,
        body: { jsonrpc: "2.0", method: "tools/call", params: { name: "lokal_discover" }, id: "other" },
      });
      consumerIdentity(req, res, () => {});
      triggerFinish();
    }
    const allRowsForKey = db
      .prepare(`SELECT endpoint_or_tool, call_count FROM consumer_usage_ledger WHERE key_id = ? ORDER BY endpoint_or_tool`)
      .all(ledgerIssue.body.key_id) as any[];
    assertEq(allRowsForKey.length, 2, "a different tool call creates a second, separate ledger row");
    assertEq(
      allRowsForKey.find((r) => r.endpoint_or_tool === "lokal_search")?.call_count,
      N,
      "the original tool's row is untouched by the other tool's call",
    );
    assertEq(
      allRowsForKey.find((r) => r.endpoint_or_tool === "lokal_discover")?.call_count,
      1,
      "the new tool's row starts at call_count 1",
    );

    // Ledger rows never contain call arguments/content — only
    // key_id/endpoint_or_tool/day/call_count columns exist at all.
    const ledgerColumns = (db.prepare("PRAGMA table_info(consumer_usage_ledger)").all() as any[]).map((c) => c.name);
    assertEq(
      ledgerColumns.sort().join(","),
      ["id", "key_id", "endpoint_or_tool", "day", "call_count"].sort().join(","),
      "consumer_usage_ledger has ONLY aggregate columns — no room for call arguments/content",
    );
  } catch (err) {
    failed++;
    failures.push(`consumer-keys: unexpected error: ${err instanceof Error ? (err.stack || err.message) : String(err)}`);
  }

  return { passed, failed, failures };
}

// Standalone runner
if (require.main === module) {
  const r = runConsumerKeysTests({ log: true });
  console.log(`\nconsumer-keys: ${r.passed} passed, ${r.failed} failed`);
  process.exit(r.failed > 0 ? 1 : 0);
}
