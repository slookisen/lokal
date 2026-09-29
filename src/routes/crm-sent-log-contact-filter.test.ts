/**
 * crm-sent-log-contact-filter.test.ts — regression pin for the 2026-09-28
 * sent-log truncation incident.
 *
 * GET /admin/crm/sent-log (src/routes/crm.ts) called
 * crmService.listSentMessages({sinceHours, limit, deliveryStatus}), whose SQL
 * applies LIMIT (default 500, max 2000) to ALL outbound messages
 * platform-wide, and only THEN filtered `contact_email` in memory. So
 * `?since_hours=all&contact_email=x` silently returned only those of x's
 * messages that happened to be among the newest `limit` outbound rows
 * platform-wide. On 2026-09-28 an operator got `count 0` for five producers
 * that way, concluded they had never been confirmed, and sent each a new
 * "sorry we never confirmed" e-mail — all five HAD been confirmed in
 * July/August, on separate compose-* threads. The CS routine's dual-source
 * guard ("has this recipient gotten ANY outbound from us?") reads the same
 * endpoint, so the same truncation could wave a duplicate e-mail through.
 *
 * Fix: listSentMessages() takes an optional `contactEmail` and applies it in
 * the SQL WHERE clause, so LIMIT applies AFTER the contact filter; the route
 * passes contact_email through instead of filtering in memory.
 *
 * Fixture: contact X has three OLD outbound confirmations on compose-*
 * threads (40/50/75 days ago; the 50-day one on X's separate `experiences`
 * contact row — same address, other platform, matched before and after),
 * while three other contacts share 510 NEWER outbound rows — more than the
 * default limit of 500.
 *
 * Covers:
 *   s1-s3   pre-condition / unchanged: without contactEmail the platform-wide
 *           LIMIT still applies and cuts X out entirely — i.e. the old
 *           in-memory contact_email filter over this result was empty (the
 *           incident).
 *   s4-s8   listSentMessages({contactEmail}) returns X's old rows newest
 *           first, LIMIT applies within X's rows, input is trimmed and
 *           case-insensitive, blank contactEmail = no filter.
 *   s9-s10  a contact only PARTLY inside the platform-wide window: the old
 *           in-memory result is a byte-identical prefix of the new one, which
 *           adds exactly the rows the LIMIT used to cut off.
 *   r1-r10  GET /sent-log: the exact incident query (?since_hours=all&
 *           contact_email=X, default limit) now finds X's confirmations with
 *           an unchanged response shape; ?limit= after the contact filter;
 *           the no-contact_email result unchanged; since_hours/status and the
 *           in-memory channel/actor filters still AND'ed on top.
 *
 * Standalone: npx tsx src/routes/crm-sent-log-contact-filter.test.ts
 * Wired into tests/test.ts via runCrmSentLogContactFilterTests().
 */

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export async function runCrmSentLogContactFilterTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
  // adopt-ambient (see tests/test.ts's SHARED GLOBAL STATE contract): reuse
  // the suite's canonical ADMIN_KEY when present; literal for standalone runs.
  const adminKey = process.env.ADMIN_KEY || "crm-sent-log-contact-filter-test-key";

  // Pin BEFORE requiring the route/service, restore in finally.
  const restoreDb = initMod.__pinInMemoryDbForTesting();
  const db = initMod.__peekDbForTesting()!;

  try {
    process.env.ADMIN_KEY = adminKey;

    const { crmService } = require("../services/crm-service") as typeof import("../services/crm-service");
    const routePath = require.resolve("./crm");
    delete require.cache[routePath];
    const router = (require("./crm") as typeof import("./crm")).default as any;

    function getSentLog(query: Record<string, string>): Promise<{ status: number; body: any }> {
      process.env.ADMIN_KEY = adminKey; // re-assert right before dispatch (SHARED GLOBAL STATE contract)
      const req: any = {
        method: "GET", url: "/sent-log", originalUrl: "/sent-log", path: "/sent-log", query,
        headers: { "x-admin-key": adminKey },
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

    // ── Fixture ────────────────────────────────────────────────────────
    // Relative timestamps (distinct hours, no ties in the ORDER BY) so the
    // since_hours assertions hold on any clock. received_at is backdated too
    // (SQLite's own format, as the schema default writes it) — otherwise the
    // `OR received_at >= cutoff` branch would make every row look recent.
    const T0 = Date.now();
    const isoHoursAgo = (h: number) => new Date(T0 - h * 3600_000).toISOString();
    const sqliteHoursAgo = (h: number) => isoHoursAgo(h).replace("T", " ").slice(0, 19);

    const X = "bekreftet@gard-x.no";
    const OTHERS = ["annen0@example.no", "annen1@example.no", "annen2@example.no"];
    const N_OTHER = 510; // > the default limit of 500

    const insContact = db.prepare(
      `INSERT INTO crm_contacts (id, type, email, name, vertical_id) VALUES (?, 'producer', ?, ?, ?)`,
    );
    const insThread = db.prepare(
      `INSERT INTO crm_threads (id, contact_id, subject, status, vertical_id) VALUES (?, ?, ?, 'done', ?)`,
    );
    const insMsg = db.prepare(`
      INSERT INTO crm_messages
        (id, thread_id, direction, from_email, to_emails, cc_emails, subject, body_text, snippet, sent_at, received_at, delivery_status, vertical_id)
      VALUES (?, ?, 'out', 'kontakt@rettfrabonden.com', ?, '[]', ?, 'Tekst.', 'Tekst.', ?, ?, 'sent', ?)
    `);

    db.transaction(() => {
      insContact.run("contact-x-rfb", X, "Gård X", "rfb");
      insContact.run("contact-x-exp", X, "Gård X", "experiences");
      const xMsgs: Array<[string, string, string, string, number]> = [
        // [messageId, threadId, contactId, vertical, hoursAgo]
        ["msg-x-aug", "compose-x-aug", "contact-x-rfb", "rfb", 40 * 24],
        ["msg-x-exp", "compose-x-exp", "contact-x-exp", "experiences", 50 * 24],
        ["msg-x-jul", "compose-x-jul", "contact-x-rfb", "rfb", 75 * 24],
      ];
      for (const [id, thread, contact, vertical, h] of xMsgs) {
        insThread.run(thread, contact, "Bekreftelse", vertical);
        insMsg.run(id, thread, JSON.stringify([X]), "Bekreftelse", isoHoursAgo(h), sqliteHoursAgo(h), vertical);
      }
      OTHERS.forEach((email, k) => {
        insContact.run(`contact-annen${k}`, email, `Annen ${k}`, "rfb");
        insThread.run(`thread-annen${k}`, `contact-annen${k}`, "Utsendelse", "rfb");
      });
      // msg-o-<i>: i hours old (+1), round-robin over the three other
      // contacts — all newer than X's newest (960h).
      for (let i = 0; i < N_OTHER; i++) {
        const k = i % OTHERS.length;
        insMsg.run(`msg-o-${i}`, `thread-annen${k}`, JSON.stringify([OTHERS[k]]), "Utsendelse", isoHoursAgo(1 + i), sqliteHoursAgo(1 + i), "rfb");
      }
    })();

    const X_ALL = ["msg-x-aug", "msg-x-exp", "msg-x-jul"];
    const NEWEST_5 = ["msg-o-0", "msg-o-1", "msg-o-2", "msg-o-3", "msg-o-4"];
    const ids = (rows: Array<{ message_id: string }> | undefined) => (rows || []).map((m) => m.message_id);

    // ═══════════════════════════════════════════════════════════════
    // s1-s3 — without contactEmail: platform-wide LIMIT, unchanged.
    // ═══════════════════════════════════════════════════════════════
    {
      const all = crmService.listSentMessages({});
      assertEq(all.length, 500, "s1: no contactEmail -> platform-wide default LIMIT 500 still applies (513 outbound rows exist)");
      assertEq(ids(crmService.listSentMessages({ limit: 5 })), NEWEST_5, "s2: no contactEmail, limit=5 -> the 5 newest outbound rows platform-wide, newest first (unchanged)");
      assertEq(
        all.filter((m) => (m.contact_email || "").toLowerCase() === X).length,
        0,
        "s3: pre-condition — none of X's confirmations are in the platform-wide top 500, so the OLD in-memory contact_email filter returned count 0 (the incident)",
      );
    }

    // ═══════════════════════════════════════════════════════════════
    // s4-s8 — contactEmail filters in SQL, BEFORE the LIMIT.
    // ═══════════════════════════════════════════════════════════════
    {
      const x = crmService.listSentMessages({ contactEmail: X });
      assertEq(ids(x), X_ALL, "s4: contactEmail=X returns all three OLD confirmations despite 510 newer rows for other contacts (was 0 — THE BUG), newest first, across both of X's platform contacts");
      assertTrue(
        x.length === 3 && x.every((m) => m.contact_email === X && m.thread_origin === "compose" && m.channel === "resend_smtp"),
        "s5: every returned row is X's, with the unchanged per-row derivations (thread_origin=compose, channel fallback resend_smtp)",
      );
      assertEq(ids(crmService.listSentMessages({ contactEmail: X, limit: 1 })), ["msg-x-aug"], "s6: LIMIT applies within X's own rows (limit=1 -> X's newest)");
      assertEq(ids(crmService.listSentMessages({ contactEmail: "  Bekreftet@GARD-X.no " })), X_ALL, "s7: contactEmail is trimmed + case-insensitive (same normalization as the old in-memory filter)");
      const unfiltered = JSON.stringify(crmService.listSentMessages({ limit: 5 }));
      assertTrue(
        JSON.stringify(crmService.listSentMessages({ limit: 5, contactEmail: "" })) === unfiltered &&
          JSON.stringify(crmService.listSentMessages({ limit: 5, contactEmail: "   " })) === unfiltered &&
          JSON.stringify(crmService.listSentMessages({ limit: 5, contactEmail: undefined })) === unfiltered,
        "s8: empty / whitespace-only / undefined contactEmail = no filter (byte-identical to omitting it)",
      );
      assertEq(crmService.listSentMessages({ contactEmail: "ukjent@example.no" }).length, 0, "s8b: a contact with no outbound -> empty array (a true 0 is still 0)");
    }

    // ═══════════════════════════════════════════════════════════════
    // s9-s10 — a contact PARTLY inside the platform-wide top 500: annen0
    // owns msg-o-0,3,…,507 (170 rows); the top 500 are msg-o-0..499, so the
    // old route saw only 167 of them.
    // ═══════════════════════════════════════════════════════════════
    {
      const A0 = OTHERS[0];
      const oldStyle = crmService.listSentMessages({}).filter((m) => (m.contact_email || "").toLowerCase() === A0);
      const newStyle = crmService.listSentMessages({ contactEmail: A0 });
      assertEq([oldStyle.length, newStyle.length], [167, 170], "s9: old in-memory filter saw 167 of annen0's rows, the SQL filter returns all 170");
      assertTrue(
        JSON.stringify(newStyle.slice(0, oldStyle.length)) === JSON.stringify(oldStyle),
        "s10: the old in-memory result is a byte-identical prefix of the new result (same rows, fields and order)",
      );
      assertEq(ids(newStyle.slice(oldStyle.length)), ["msg-o-501", "msg-o-504", "msg-o-507"], "s10b: …and the added rows are exactly the ones the platform-wide LIMIT used to cut off");
    }

    // ═══════════════════════════════════════════════════════════════
    // r1-r5 — the exact incident query through the real route.
    // ═══════════════════════════════════════════════════════════════
    {
      const res = await getSentLog({ since_hours: "all", contact_email: X });
      assertEq(res.status, 200, "r1: GET /sent-log?since_hours=all&contact_email=X (default limit 500) -> 200");
      assertEq(res.body?.count, 3, "r2: …count 3 — X's July/August confirmations are found (the 2026-09-28 incident query returned count 0)");
      assertEq(ids(res.body?.messages), X_ALL, "r3: …the three confirmations, newest first");
      assertEq(
        res.body?.filters,
        { since_hours: "all", channel: "all", actor: "all", status: "all", contact_email: X },
        "r4: filters echo is unchanged (normalized contact_email)",
      );
      assertEq(
        res.body?.summary,
        { by_actor: { unknown: 3 }, by_channel: { resend_smtp: 3 }, by_status: { sent: 3 } },
        "r5: summary aggregates are computed over the contact-filtered set",
      );
      assertEq(
        Object.keys(res.body || {}),
        ["success", "count", "messages", "summary", "filters", "generated_at", "sent_today", "cap", "remaining_today"],
        "r5b: response keys unchanged",
      );
    }

    // r6 — ?limit= applies AFTER the contact filter; input normalized.
    {
      const res = await getSentLog({ since_hours: "all", contact_email: "  BEKREFTET@gard-x.NO ", limit: "2" });
      assertEq(ids(res.body?.messages), ["msg-x-aug", "msg-x-exp"], "r6: ?limit=2 with a padded, mixed-case contact_email -> X's 2 newest (LIMIT after the contact filter)");
      assertEq(res.body?.filters?.contact_email, X, "r6b: filters.contact_email echoes the normalized address");
    }

    // r7 — no contact_email: platform-wide list exactly as before.
    {
      const five = await getSentLog({ since_hours: "all", limit: "5" });
      assertEq(ids(five.body?.messages), NEWEST_5, "r7: no contact_email, limit=5 -> the newest 5 outbound rows platform-wide (unchanged)");
      assertEq(five.body?.filters?.contact_email, "all", "r7b: …filters.contact_email = 'all' (unchanged)");
      const dflt = await getSentLog({ since_hours: "all" });
      assertEq(dflt.body?.count, 500, "r7c: no contact_email, default limit -> 500 rows (unchanged)");
      const blank = await getSentLog({ since_hours: "all", limit: "5", contact_email: "   " });
      assertEq(ids(blank.body?.messages), NEWEST_5, "r7d: whitespace-only contact_email -> no filter (unchanged)");
    }

    // r8-r10 — the other filters are still AND'ed on top.
    {
      const win30d = await getSentLog({ since_hours: "720", contact_email: X });
      assertEq(win30d.body?.count, 0, "r8: since_hours=720 + contact_email=X -> 0 (X's newest confirmation is 40 days old; window still applies)");
      const win62d = await getSentLog({ since_hours: "1500", contact_email: X });
      assertEq(ids(win62d.body?.messages), ["msg-x-aug", "msg-x-exp"], "r8b: since_hours=1500 (62.5 days) + contact_email=X -> only the two confirmations inside the window");
      const failedOnly = await getSentLog({ since_hours: "all", contact_email: X, status: "failed" });
      assertEq(failedOnly.body?.count, 0, "r9: status=failed + contact_email=X -> 0 (status still AND'ed in SQL)");
      const ch = await getSentLog({ since_hours: "all", contact_email: X, channel: "resend_smtp" });
      assertEq(ch.body?.count, 3, "r10: channel=resend_smtp + contact_email=X -> 3 (in-memory channel filter still applied on top)");
      const ac = await getSentLog({ since_hours: "all", contact_email: X, actor: "daniel" });
      assertEq(ac.body?.count, 0, "r10b: actor=daniel + contact_email=X -> 0 (in-memory actor filter still applied on top)");
    }
  } catch (err) {
    failed++;
    failures.push(`crm-sent-log-contact-filter: unexpected error: ${err instanceof Error ? (err.stack || err.message) : String(err)}`);
  } finally {
    if (prevAdminKey === undefined) delete process.env.ADMIN_KEY; else process.env.ADMIN_KEY = prevAdminKey;
    try { delete require.cache[require.resolve("./crm")]; } catch { /* ignore */ }
    restoreDb();
  }

  return { passed, failed, failures };
}

if (require.main === module) {
  console.log("── crm-sent-log-contact-filter (incident 2026-09-28: contact_email filtered in SQL before LIMIT) ──");
  runCrmSentLogContactFilterTests({ log: true }).then((r) => {
    console.log(`\ncrm-sent-log-contact-filter: ${r.passed} passed, ${r.failed} failed`);
    if (r.failed > 0) {
      console.log(r.failures.join("\n"));
      process.exit(1);
    }
    process.exit(0);
  });
}
