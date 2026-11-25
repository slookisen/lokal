/**
 * crm-messages-window.test.ts — GET /admin/crm/messages (read-only verifier probe).
 *
 * dev-request 2026-11-25-platform-verifier-crm-messages-endpoint-mangler: the
 * platform-verifier counts outbound CRM rows whose message time
 * (COALESCE(sent_at, received_at)) falls in a run's window for one vertical
 * and compares with the run's claim. Before this route it got 404 and skipped.
 *
 * Covers:
 *   v1-v8   400s: missing/bad since, bad until, until < since, bad direction,
 *           bad vertical, bad delivery_status.
 *   w1-w4   window filtering across both stored timestamp formats
 *           ('YYYY-MM-DD HH:MM:SS' and ISO 'T…Z' with ms), inclusive bounds,
 *           sent_at NULL falling back to received_at, ascending order.
 *   f1-f4   vertical, direction and delivery_status filters.
 *   l1-l3   `total` exact when limit < total; truncated flag; limit cap.
 *   p1      no body/snippet/raw_metadata/e-mail fields in output.
 *
 * Standalone: npx tsx src/routes/crm-messages-window.test.ts
 * Wired into tests/test.ts via runCrmMessagesWindowTests().
 */

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export async function runCrmMessagesWindowTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
    if (cond) { passed++; if (log) console.log(`  ok ${label}`); }
    else { failed++; failures.push(`✗ ${label}`); if (log) console.log(`  ✗ ${label}`); }
  }

  const initMod = require("../database/init") as typeof import("../database/init");
  const prevAdminKey = process.env.ADMIN_KEY;
  // adopt-ambient (see tests/test.ts's SHARED GLOBAL STATE contract).
  const adminKey = process.env.ADMIN_KEY || "crm-messages-window-test-key";

  const restoreDb = initMod.__pinInMemoryDbForTesting();
  const db = initMod.__peekDbForTesting()!;

  try {
    process.env.ADMIN_KEY = adminKey;

    const routePath = require.resolve("./crm");
    delete require.cache[routePath];
    const router = (require("./crm") as typeof import("./crm")).default as any;

    function getMessages(query: Record<string, string>, key: string | null = adminKey): Promise<{ status: number; body: any }> {
      process.env.ADMIN_KEY = adminKey; // re-assert right before dispatch
      const headers: Record<string, string> = key === null ? {} : { "x-admin-key": key };
      const req: any = {
        method: "GET", url: "/messages", originalUrl: "/messages", path: "/messages", query,
        headers,
        get(n: string) { return this.headers[n.toLowerCase()]; },
      };
      return new Promise((resolve) => {
        const res: any = {
          statusCode: 200,
          status(c: number) { this.statusCode = c; return this; },
          json(b: any) { resolve({ status: this.statusCode, body: b }); return this; },
        };
        router.handle(req, res, (err?: any) => resolve({ status: 500, body: { error: String(err ?? "fell through") } }));
      });
    }
    const ids = (msgs: any[] | undefined) => (msgs || []).map((m) => m.message_id);

    // ── Fixture ────────────────────────────────────────────────────────
    // Window under test: 2026-11-20 10:00:00 .. 12:00:00 UTC.
    db.prepare(`INSERT INTO crm_contacts (id, type, email, name, vertical_id) VALUES ('c1', 'producer', 'gard@example.no', 'Gård', 'rfb')`).run();
    const insThread = db.prepare(
      `INSERT INTO crm_threads (id, contact_id, subject, status, vertical_id) VALUES (?, 'c1', 'Emne', 'done', ?)`,
    );
    insThread.run("t-rfb", "rfb");
    insThread.run("t-dental", "dental");
    insThread.run("t-exp", "experiences");
    const insMsg = db.prepare(`
      INSERT INTO crm_messages
        (id, thread_id, direction, from_email, to_emails, cc_emails, subject, body_text, body_html, snippet, sent_at, received_at, raw_metadata, delivery_status)
      VALUES (?, ?, ?, 'kontakt@rettfrabonden.com', '["gard@example.no"]', '[]', ?, 'Hemmelig tekst', '<p>x</p>', 'snutt', ?, ?, '{"createdBy":"claude"}', ?)
    `);
    // [id, thread, direction, sent_at, received_at, delivery_status]
    const rows: Array<[string, string, "in" | "out", string | null, string, string]> = [
      ["m-before",     "t-rfb",    "out", "2026-11-20 09:59:59",      "2026-11-20 09:59:59", "sent"],
      ["m-at-start",   "t-rfb",    "out", "2026-11-20T10:00:00.000Z", "2026-11-20 10:00:00", "sent"],     // ISO+ms, == since
      ["m-sqlite",     "t-rfb",    "out", "2026-11-20 10:30:00",      "2026-11-20 10:30:00", "sent"],     // SQLite format
      ["m-iso",        "t-rfb",    "out", "2026-11-20T11:00:00.123Z", "2026-11-20 08:00:00", "queued"],   // ISO; received_at outside window
      ["m-null-sent",  "t-rfb",    "out", null,                       "2026-11-20 11:15:00", "failed"],   // falls back to received_at
      ["m-null-out",   "t-rfb",    "out", null,                       "2026-11-20 13:00:00", "sent"],     // fallback outside window
      ["m-sent-out-recv-in", "t-rfb", "out", "2026-11-20 13:30:00",   "2026-11-20 10:45:00", "sent"],     // sent_at wins -> outside
      ["m-at-end",     "t-rfb",    "out", "2026-11-20T12:00:00Z",     "2026-11-20 12:00:00", "sent"],     // == until
      ["m-after",      "t-rfb",    "out", "2026-11-20 12:00:01",      "2026-11-20 12:00:01", "sent"],
      ["m-in",         "t-rfb",    "in",  "2026-11-20 10:20:00",      "2026-11-20 10:20:01", "sent"],
      ["m-dental",     "t-dental", "out", "2026-11-20 10:10:00",      "2026-11-20 10:10:00", "sent"],
      ["m-exp",        "t-exp",    "out", "2026-11-20T11:30:00.000Z", "2026-11-20 11:30:00", "sent"],
    ];
    db.transaction(() => {
      for (const [id, thread, dir, sent, recv, ds] of rows) insMsg.run(id, thread, dir, "Emne " + id, sent, recv, ds);
    })();

    const W = { since: "2026-11-20T10:00:00Z", until: "2026-11-20T12:00:00Z" };
    const RFB_OUT_IN_WINDOW = ["m-at-start", "m-sqlite", "m-iso", "m-null-sent", "m-at-end"];

    // ── v: validation ──────────────────────────────────────────────────
    {
      const noSince = await getMessages({});
      assertEq([noSince.status, noSince.body?.error], [400, "invalid_since"], "v1: missing since -> 400 invalid_since");
      const badSince = await getMessages({ since: "yesterday" });
      assertEq([badSince.status, badSince.body?.error], [400, "invalid_since"], "v2: unparsable since -> 400 invalid_since");
      const badSince2 = await getMessages({ since: "2026-13-45T99:00:00Z" });
      assertEq([badSince2.status, badSince2.body?.error], [400, "invalid_since"], "v2b: ISO-shaped but impossible since -> 400");
      const badUntil = await getMessages({ since: W.since, until: "not-a-date" });
      assertEq([badUntil.status, badUntil.body?.error], [400, "invalid_until"], "v3: unparsable until -> 400 invalid_until");
      const inverted = await getMessages({ since: W.until, until: W.since });
      assertEq(inverted.status, 400, "v4: until < since -> 400");
      const badDir = await getMessages({ since: W.since, direction: "both" });
      assertEq([badDir.status, badDir.body?.error], [400, "invalid_direction"], "v5: bad direction -> 400");
      const badVert = await getMessages({ since: W.since, vertical: "all" });
      assertEq([badVert.status, badVert.body?.error], [400, "invalid_vertical"], "v6: unknown vertical -> 400 (not silently ignored)");
      const badDs = await getMessages({ since: W.since, delivery_status: "bounced" });
      assertEq([badDs.status, badDs.body?.error], [400, "invalid_delivery_status"], "v7: bad delivery_status -> 400");
      const noKey = await getMessages({ since: W.since }, null);
      assertEq(noKey.status, 401, "v8: no X-Admin-Key -> 401 (router-level requireAdminAuth)");
    }

    // ── w: window ──────────────────────────────────────────────────────
    {
      const r = await getMessages({ ...W, vertical: "rfb" });
      assertEq(r.status, 200, "w1: valid window -> 200");
      assertEq(ids(r.body?.messages), RFB_OUT_IN_WINDOW,
        "w1b: rfb out rows in window, both formats, inclusive bounds, NULL sent_at -> received_at, sent_at wins over received_at, ascending");
      assertEq([r.body?.total, r.body?.count, r.body?.truncated], [5, 5, false], "w1c: total=count=5, truncated=false");
      assertEq(r.body?.filters, { since: "2026-11-20T10:00:00.000Z", until: "2026-11-20T12:00:00.000Z", direction: "out", vertical: "rfb", delivery_status: null, limit: 500 },
        "w1d: filters echo normalized values and defaults");
      const sqlFmt = await getMessages({ since: "2026-11-20 10:00:00", until: "2026-11-20 12:00:00", vertical: "rfb" });
      assertEq(ids(sqlFmt.body?.messages), RFB_OUT_IN_WINDOW, "w2: since/until given in 'YYYY-MM-DD HH:MM:SS' form -> same rows");
      const offset = await getMessages({ since: "2026-11-20T11:00:00+01:00", until: "2026-11-20T13:00:00+01:00", vertical: "rfb" });
      assertEq(ids(offset.body?.messages), RFB_OUT_IN_WINDOW, "w3: offset timestamps normalized to UTC -> same rows");
      const open = await getMessages({ since: "2026-11-20T12:00:00Z", vertical: "rfb" });
      assertEq(ids(open.body?.messages), ["m-at-end", "m-after", "m-null-out", "m-sent-out-recv-in"], "w4: no until -> open-ended, inclusive since");
      assertTrue(typeof r.body?.generated_at === "string", "w4b: generated_at present");
    }

    // ── f: filters ─────────────────────────────────────────────────────
    {
      const all = await getMessages(W);
      assertEq(ids(all.body?.messages), ["m-at-start", "m-dental", "m-sqlite", "m-iso", "m-null-sent", "m-exp", "m-at-end"],
        "f1: no vertical -> all verticals' out rows in window");
      const dental = await getMessages({ ...W, vertical: "dental" });
      assertEq([ids(dental.body?.messages), dental.body?.messages?.[0]?.vertical], [["m-dental"], "dental"], "f2: vertical=dental (thread vertical) -> only dental");
      const inbound = await getMessages({ ...W, direction: "in" });
      assertEq([ids(inbound.body?.messages), inbound.body?.messages?.[0]?.direction], [["m-in"], "in"], "f3: direction=in -> only inbound");
      const queued = await getMessages({ ...W, vertical: "rfb", delivery_status: "queued" });
      assertEq(ids(queued.body?.messages), ["m-iso"], "f4: delivery_status=queued -> only queued");
    }

    // ── l: limit / total ───────────────────────────────────────────────
    {
      const lim = await getMessages({ ...W, vertical: "rfb", limit: "2" });
      assertEq([lim.body?.total, lim.body?.count, lim.body?.truncated], [5, 2, true], "l1: limit=2 < total -> total exact (5), count 2, truncated");
      assertEq(ids(lim.body?.messages), ["m-at-start", "m-sqlite"], "l2: limited rows are the earliest");
      const big = await getMessages({ ...W, limit: "999999" });
      assertEq(big.body?.filters?.limit, 2000, "l3: limit capped at 2000");
    }

    // ── p: no PII / bodies ─────────────────────────────────────────────
    {
      const r = await getMessages({ ...W, vertical: "rfb" });
      const keys = Object.keys(r.body?.messages?.[0] || {}).sort();
      assertEq(keys, ["delivery_status", "direction", "message_id", "received_at", "sent_at", "subject", "thread_id", "vertical"].sort(),
        "p1: message keys are exactly the allowed set");
      const json = JSON.stringify(r.body);
      assertTrue(!json.includes("@") && !json.includes("Hemmelig") && !json.includes("snutt") && !json.includes("createdBy"),
        "p1b: no addresses, bodies, snippets or raw_metadata in the response");
    }
  } catch (err) {
    failed++;
    failures.push(`crm-messages-window: unexpected error: ${err instanceof Error ? (err.stack || err.message) : String(err)}`);
  } finally {
    if (prevAdminKey === undefined) delete process.env.ADMIN_KEY; else process.env.ADMIN_KEY = prevAdminKey;
    try { delete require.cache[require.resolve("./crm")]; } catch { /* ignore */ }
    restoreDb();
  }

  return { passed, failed, failures };
}

if (require.main === module) {
  console.log("── crm-messages-window (GET /admin/crm/messages verifier probe) ──");
  runCrmMessagesWindowTests({ log: true }).then((r) => {
    console.log(`\ncrm-messages-window: ${r.passed} passed, ${r.failed} failed`);
    if (r.failed > 0) {
      console.log(r.failures.join("\n"));
      process.exit(1);
    }
    process.exit(0);
  });
}
