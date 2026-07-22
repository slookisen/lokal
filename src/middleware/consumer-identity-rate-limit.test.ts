/**
 * consumer-identity-rate-limit.test.ts — dev-request
 * 2026-07-13-agent-identity-usage-ledger, slice 1.
 *
 * Covers acceptance criterion 5: "A key holder gets measurably higher
 * rate-limit behavior than an anonymous caller, verified by a test (not
 * just eyeballing config)" — plus the issuance-endpoint anti-spam limiter
 * mentioned in the spec (consumerKeyIssuanceLimiter).
 *
 * express-rate-limit needs a REAL req/res (req.ip, res.setHeader, etc.) to
 * do its own internal bookkeeping — the lightweight fake req/res used
 * elsewhere in this codebase's route tests (admin-blocklist-manual-entry.test.ts
 * and friends) isn't enough here (confirmed by hand: it throws
 * ERR_ERL_UNDEFINED_IP_ADDRESS). So this file spins up a real, ephemeral
 * (port 0) HTTP server per test and drives it with the platform's built-in
 * `fetch`, exercising the REAL exported `keyedMax()` / limiter objects —
 * not a mock, not a scaled-down reimplementation.
 *
 * Both anonymous and keyed requests below come from the same loopback
 * client, so (by express-rate-limit's default IP-based keyGenerator) they
 * share ONE counter — exactly the real-world case of "the same caller
 * starts presenting a key partway through". The test picks small,
 * deliberately-scaled anonymousMax/keyedMax values (built from the exact
 * same keyedMax() factory generalLimiter/jsonRpcLimiter use in
 * src/middleware/security.ts) so the whole scenario runs in a handful of
 * requests instead of the production-scale 300/900.
 *
 * Deliberately NOT using the real `consumerIdentity` middleware (with its
 * `getDb()` lookup) here: this file's `fetch()` calls are genuine async I/O
 * (not just microtasks), and tests/test.ts's giant shared-process test
 * runner has other, unrelated test blocks that swap the same module-level
 * DB singleton (via `__setDbForTesting`) while THIS file's requests are
 * in flight — a real race, caught by hand running the full `npm test`
 * suite (this file's requests intermittently saw a DB that no longer had
 * the row this test inserted). consumerIdentity's OWN DB-lookup
 * correctness (valid/unknown/revoked/erased key recognition) is already
 * fully covered by consumer-identity-anonymous-regression.test.ts and
 * consumer-keys.test.ts, both fully synchronous (no real network I/O, so
 * no such race is possible there). This file's job is narrower — prove the
 * `keyedMax()` rate-limit mechanism itself — so it stands in a trivial,
 * DB-free "is this request presenting the test's own marker header"
 * middleware wherever consumerIdentity would normally attach
 * `req.consumerKeyId`.
 */

import express from "express";
import rateLimit from "express-rate-limit";
import { AddressInfo } from "net";
import { keyedMax, consumerKeyIssuanceLimiter } from "./security";

// Stand-in for consumerIdentity's req.consumerKeyId attachment, WITHOUT any
// DB dependency (see file header for why). Presenting the marker header is
// exactly analogous to presenting a valid X-API-Key that consumerIdentity
// recognized — this only exists to keep this file free of the shared DB
// singleton during real async I/O.
const TEST_MARKER_HEADER = "x-test-consumer-key-id";
function fakeConsumerIdentity(req: express.Request, _res: express.Response, next: express.NextFunction): void {
  const marker = req.header(TEST_MARKER_HEADER);
  if (marker) (req as any).consumerKeyId = Number(marker);
  next();
}

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

async function startServer(app: express.Express): Promise<{ port: number; close: () => Promise<void> }> {
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

export async function runConsumerIdentityRateLimitTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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

  // ── Scenario 1: keyed callers get a materially higher ceiling ─────────
  {
    const ANON_MAX = 2;
    const KEYED_MAX = 5;
    const app = express();
    app.use(express.json());
    app.use(fakeConsumerIdentity);
    app.use(
      rateLimit({
        windowMs: 60_000,
        max: keyedMax(ANON_MAX, KEYED_MAX), // the exact factory generalLimiter/jsonRpcLimiter use
        standardHeaders: true,
        legacyHeaders: false,
        validate: { trustProxy: false },
        message: { success: false, error: "rate limited" },
      }),
    );
    app.get("/probe", (req, res) => res.json({ ok: true, consumerKeyId: (req as any).consumerKeyId ?? null }));

    const { port, close } = await startServer(app);
    try {
      const url = `http://127.0.0.1:${port}/probe`;

      // Two anonymous requests: within the anonymous cap (2) -> both 200.
      const anon1 = await fetch(url);
      assertEq(anon1.status, 200, "rate-limit: anonymous request 1/2 -> 200 (within anon cap)");
      const anon2 = await fetch(url);
      assertEq(anon2.status, 200, "rate-limit: anonymous request 2/2 -> 200 (within anon cap)");

      // Third anonymous request exceeds the anonymous cap -> 429.
      const anon3 = await fetch(url);
      assertEq(anon3.status, 429, "rate-limit: anonymous request 3 -> 429 (anonymous cap exceeded)");

      // Same client, NOW presenting a recognized key (via the test's marker
      // header — see fakeConsumerIdentity): the shared per-IP counter is
      // already at 3, past the anonymous cap of 2 — but the keyed ceiling
      // (5) is materially higher, so these two more succeed.
      const keyed1 = await fetch(url, { headers: { [TEST_MARKER_HEADER]: "42" } });
      const keyed1Body = await keyed1.json();
      assertEq(keyed1.status, 200, "rate-limit: keyed request past the anonymous cap -> 200 (higher ceiling applies)");
      assertEq(keyed1Body.consumerKeyId, 42, "rate-limit: keyed request also carries its consumerKeyId through to the handler");

      const keyed2 = await fetch(url, { headers: { [TEST_MARKER_HEADER]: "42" } });
      assertEq(keyed2.status, 200, "rate-limit: second keyed request -> 200 (still under keyed cap of 5)");

      // Sixth request overall exceeds even the keyed cap (5) -> 429.
      const keyed3 = await fetch(url, { headers: { [TEST_MARKER_HEADER]: "42" } });
      assertEq(keyed3.status, 429, "rate-limit: request 6 overall -> 429 (keyed cap of 5 now also exceeded)");
    } finally {
      await close();
    }
  }

  // ── Scenario 2: anonymous behavior is UNCHANGED (max stays a plain
  // number when there's no key) — same keyedMax(), a fresh IP-bucket. ────
  {
    const ANON_MAX = 2;
    const app = express();
    app.use(express.json());
    app.use(fakeConsumerIdentity);
    app.use(
      rateLimit({
        windowMs: 60_000,
        max: keyedMax(ANON_MAX, 999),
        standardHeaders: true,
        legacyHeaders: false,
        validate: { trustProxy: false },
        message: { success: false, error: "rate limited" },
      }),
    );
    app.get("/probe2", (_req, res) => res.json({ ok: true }));
    const { port, close } = await startServer(app);
    try {
      const url = `http://127.0.0.1:${port}/probe2`;
      const r1 = await fetch(url);
      const r2 = await fetch(url);
      const r3 = await fetch(url);
      assertEq([r1.status, r2.status, r3.status], [200, 200, 429], "rate-limit: anonymous-only traffic still stops at exactly anonymousMax (identical to the pre-existing static-number behavior)");
    } finally {
      await close();
    }
  }

  // ── Scenario 3: issuance anti-spam limiter (consumerKeyIssuanceLimiter,
  // 50/hour — same shape as the existing registrationLimiter) ───────────
  {
    const app = express();
    app.use(express.json());
    app.post("/issue", consumerKeyIssuanceLimiter, (_req, res) => res.json({ ok: true }));
    const { port, close } = await startServer(app);
    try {
      const url = `http://127.0.0.1:${port}/issue`;
      let firstBlockedAt = -1;
      for (let i = 1; i <= 51; i++) {
        const r = await fetch(url, { method: "POST" });
        if (r.status === 429 && firstBlockedAt === -1) firstBlockedAt = i;
      }
      assertEq(firstBlockedAt, 51, "issuance limiter: exactly the 51st request in an hour is blocked (max 50/hour, matching registrationLimiter's shape)");
    } finally {
      await close();
    }
  }

  return { passed, failed, failures };
}

// Standalone runner
if (require.main === module) {
  runConsumerIdentityRateLimitTests({ log: true }).then((r) => {
    console.log(`\nconsumer-identity-rate-limit: ${r.passed} passed, ${r.failed} failed`);
    process.exit(r.failed > 0 ? 1 : 0);
  });
}
