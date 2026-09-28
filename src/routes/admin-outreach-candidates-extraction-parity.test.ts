/**
 * admin-outreach-candidates-extraction-parity.test.ts — pins that extracting
 * the GET /admin/outreach-candidates selection into computeOutreachCandidates()
 * (dev-request 2026-09-19-rfb-marketing-utsending-inn-i-plattformjobben) left
 * the route's response unchanged, and that the function the platform-side
 * daily RFB send calls IS the route's gate:
 *
 *   (1) for a fixture set exercising every suppression family (first/second
 *       touch, dedupe collision, blocklist, hard bounce, thin partial row,
 *       cross-platform cooldown, recent-contact cooldown) and every query
 *       shape (mode case, limit/cooldown parsing edge cases, OUTREACH_PAUSED),
 *       the route's 200 body is byte-identical (JSON) to
 *       computeOutreachCandidates() called with the same parsed params;
 *   (2) the response shapes the route has always answered with — key order
 *       of the 200 body, the paused body, the 400 and 403 bodies — are pinned
 *       literally;
 *   (3) the parse helpers reproduce the route's historical ?cooldown_days /
 *       ?limit parsing;
 *   (4) computeOutreachCandidates() writes nothing (total_changes() unchanged).
 *
 * (A one-off differential run against the untouched origin/main handler —
 * same fixtures, 11 query shapes — showed zero differences; this file keeps the
 * equivalence pinned going forward.)
 *
 * Two ways to run:
 *   1. Standalone:  npx tsx src/routes/admin-outreach-candidates-extraction-parity.test.ts
 *   2. Wired into the gate: tests/test.ts.
 */

import Database from "better-sqlite3";

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
  opts: { query?: Record<string, string>; headers?: Record<string, string> } = {},
): RouteResult {
  let result: RouteResult = { status: -1, body: undefined };
  const req: any = { method: "GET", url: "/", query: opts.query || {}, headers: opts.headers || {} };
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

export function runAdminOutreachCandidatesExtractionParityTests(opts: { log?: boolean } = {}): TestSummary {
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

  const initMod = require("../database/init") as typeof import("../database/init");
  const aoc = require("./admin-outreach-candidates") as typeof import("./admin-outreach-candidates");
  const prevDb = initMod.__peekDbForTesting();
  const prevAdminKey = process.env.ADMIN_KEY;
  const prevPaused = process.env.OUTREACH_PAUSED;
  const testKey = process.env.ADMIN_KEY || "aoc-extraction-parity-test-key";
  process.env.ADMIN_KEY = testKey;
  delete process.env.OUTREACH_PAUSED;

  const db = new Database(":memory:");
  db.pragma("foreign_keys = OFF");

  function seed(id: string, name: string, email: string, about?: string, enrichment = "rich"): void {
    db.prepare(
      `INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key)
       VALUES (?, ?, 'test producer', 'test', ?, 'https://parity-farm.no', 'producer', ?)`,
    ).run(id, name, email, `key-${id}`);
    db.prepare(
      `INSERT INTO agent_knowledge
         (agent_id, email, about, field_provenance, verification_status, enrichment_status, url_last_status, url_last_probed)
       VALUES (?, ?, ?, '{}', 'verified', ?, 200, datetime('now'))`,
    ).run(
      id,
      email,
      about ?? "Vi driver en liten gård med sau og honning, og selger kjøtt og honning direkte fra gården hele året.",
      enrichment,
    );
  }
  function priorSend(id: string, email: string, daysAgo: number, vertical = "rfb"): void {
    db.prepare(
      `INSERT INTO outreach_sent_log (agent_id, recipient_email, sent_at, channel, message_id, notes, vertical_id)
       VALUES (?, ?, datetime('now', ?), 'email', ?, 'test:prior', ?)`,
    ).run(id, email, `-${daysAgo} days`, `prior-${id}-${daysAgo}`, vertical);
  }

  try {
    initMod.__setDbForTesting(db as any);
    initMod.__initSchemaForTesting(db as any);

    seed("f-1", "Første Gård", "f1@parity-farm.no");
    seed("f-2", "Andre Gård", "f2@parity-farm.no");
    seed("f-3", "Tredje Gård", "shared@parity-farm.no");
    seed("f-4", "Fjerde Gård", "shared@parity-farm.no");
    seed("f-bl", "Blokkert Gård", "bl@parity-farm.no");
    db.prepare(`INSERT INTO agent_blocklist (identifier_type, identifier_value, reason) VALUES ('email', 'bl@parity-farm.no', 'test')`).run();
    seed("f-bo", "Bounce Gård", "bo@parity-farm.no");
    db.prepare(`INSERT INTO email_bounces (email, bounced_at, bounce_type) VALUES ('bo@parity-farm.no', '2026-09-01T00:00:00Z', 'hard')`).run();
    seed("f-thin", "Tynn Gård", "thin@parity-farm.no", "kort", "partial");
    seed("s-1", "Gammel Gård", "s1@parity-farm.no");
    priorSend("s-1", "s1@parity-farm.no", 90);
    seed("s-2", "Nyere Gård", "s2@parity-farm.no");
    priorSend("s-2", "s2@parity-farm.no", 70);
    seed("s-3", "Nylig Gård", "s3@parity-farm.no");
    priorSend("s-3", "s3@parity-farm.no", 10);
    seed("s-x", "Kryss Gård", "x@parity-farm.no");
    priorSend("s-x", "x@parity-farm.no", 10, "experiences");

    const router = aoc.default as any;
    const auth = { "x-admin-key": testKey };

    // ── (1) route body === computeOutreachCandidates(...) ─────────────────
    const queries: Array<{ label: string; query: Record<string, string>; paused?: string }> = [
      { label: "first (defaults)", query: { mode: "first" } },
      { label: "FIRST (mode is case-insensitive)", query: { mode: "FIRST" } },
      { label: "second (defaults)", query: { mode: "second" } },
      { label: "second limit=1", query: { mode: "second", limit: "1" } },
      { label: "second cooldown_days=5", query: { mode: "second", cooldown_days: "5" } },
      { label: "first limit=0 → clamped to 1", query: { mode: "first", limit: "0" } },
      { label: "first limit=abc cooldown=-4", query: { mode: "first", limit: "abc", cooldown_days: "-4" } },
      { label: "first limit=9999 → 500", query: { mode: "first", limit: "9999" } },
      { label: "paused first cooldown=33", query: { mode: "first", cooldown_days: "33" }, paused: "true" },
      { label: "paused (TRUE) second cooldown=junk", query: { mode: "second", cooldown_days: "x" }, paused: "TRUE" },
    ];
    for (const q of queries) {
      if (q.paused) process.env.OUTREACH_PAUSED = q.paused;
      try {
        const viaRoute = callRouteSync(router, { query: q.query, headers: auth });
        const mode = String(q.query.mode).toLowerCase() as "first" | "second";
        const direct = aoc.computeOutreachCandidates(db as any, {
          mode,
          cooldownDays: aoc.parseOutreachCandidatesCooldownDays(q.query.cooldown_days),
          limit: aoc.parseOutreachCandidatesLimit(q.query.limit),
        });
        assertEq(viaRoute.status, 200, `p1 ${q.label}: route 200`);
        assertEq(JSON.stringify(viaRoute.body), JSON.stringify(direct), `p1 ${q.label}: route body === computeOutreachCandidates()`);
      } finally {
        delete process.env.OUTREACH_PAUSED;
      }
    }

    // ── (2) the response shapes, pinned literally ──────────────────────────
    const first = callRouteSync(router, { query: { mode: "first" }, headers: auth }).body;
    assertEq(
      Object.keys(first),
      [
        "success", "mode", "cooldown_days", "count", "candidates", "dedupe_by_email", "dedupe_suppressed_count",
        "dedupe_email_collision_groups", "gate_integrity_violations", "suppressed_counts", "cross_platform_cooldown",
        "max_touch_suppressed",
      ],
      "p2: 200 body key order unchanged",
    );
    assertEq(
      first.candidates.map((c: any) => c.agent_id),
      ["f-1", "f-2", "f-4"],
      "p2: first-touch candidates (dedupe keeps one per shared address — name-asc tiebreak picks «Fjerde»)",
    );
    assertEq(Object.keys(first.candidates[0]), ["agent_id", "name", "email"], "p2: candidate shape unchanged");
    assertEq(
      [first.suppressed_counts.blocklisted, first.suppressed_counts.hard_bounced, first.suppressed_counts.cross_platform_cooldown, first.dedupe_suppressed_count],
      [1, 1, 1, 1],
      "p2: suppression counters as before (blocklist, bounce, cross-platform, dedupe)",
    );
    const second = callRouteSync(router, { query: { mode: "second" }, headers: auth }).body;
    assertEq(second.candidates.map((c: any) => c.agent_id), ["s-1", "s-2"], "p2: second-touch: past cooldown only, oldest contact first");
    process.env.OUTREACH_PAUSED = "true";
    try {
      assertEq(
        callRouteSync(router, { query: { mode: "second", cooldown_days: "33" }, headers: auth }).body,
        { success: true, mode: "second", paused: true, cooldown_days: 33, count: 0, candidates: [], note: "outreach is paused (OUTREACH_PAUSED=true)" },
        "p2: paused body pinned literally",
      );
    } finally {
      delete process.env.OUTREACH_PAUSED;
    }
    assertEq(callRouteSync(router, { query: { mode: "third" }, headers: auth }), { status: 400, body: { success: false, error: "mode must be 'first' or 'second'" } }, "p2: 400 body pinned");
    assertEq(callRouteSync(router, { query: { mode: "first" } }), { status: 403, body: { error: "Krever X-Admin-Key header" } }, "p2: 403 body pinned");

    // ── (3) parse helpers ──────────────────────────────────────────────────
    const cd = aoc.parseOutreachCandidatesCooldownDays;
    assertEq([cd(undefined), cd("45"), cd("0"), cd("-4"), cd("x")], [60, 45, 60, 1, 60], "p3: ?cooldown_days parsing unchanged");
    const lim = aoc.parseOutreachCandidatesLimit;
    assertEq([lim(undefined), lim("7"), lim("0"), lim("9999"), lim("abc")], [100, 7, 1, 500, 100], "p3: ?limit parsing unchanged");

    // ── (4) read-only ──────────────────────────────────────────────────────
    const changes = () => (db.prepare(`SELECT total_changes() AS n`).get() as { n: number }).n;
    const before = changes();
    aoc.computeOutreachCandidates(db as any, { mode: "first", cooldownDays: 60, limit: 100 });
    aoc.computeOutreachCandidates(db as any, { mode: "second", cooldownDays: 60, limit: 100 });
    assertEq(changes(), before, "p4: computeOutreachCandidates writes nothing");
  } catch (err) {
    failed++;
    failures.push(`aoc-extraction-parity: unexpected error: ${err instanceof Error ? err.stack || err.message : String(err)}`);
  } finally {
    if (prevAdminKey === undefined) delete process.env.ADMIN_KEY;
    else process.env.ADMIN_KEY = prevAdminKey;
    if (prevPaused === undefined) delete process.env.OUTREACH_PAUSED;
    else process.env.OUTREACH_PAUSED = prevPaused;
    if (prevDb) initMod.__setDbForTesting(prevDb);
  }

  return { passed, failed, failures };
}

if (require.main === module) {
  const r = runAdminOutreachCandidatesExtractionParityTests({ log: true });
  console.log(`\naoc-extraction-parity: ${r.passed} passed, ${r.failed} failed`);
  if (r.failed > 0) {
    for (const f of r.failures) console.log(f);
    process.exit(1);
  }
}
