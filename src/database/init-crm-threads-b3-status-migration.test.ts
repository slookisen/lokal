/**
 * init-crm-threads-b3-status-migration.test.ts — regression test for the
 * `crm_threads.status` CHECK-widening rebuild migration in init.ts (dev-
 * request 2026-09-14-crm-thread-status-enum-mangler-b3-opt-out-verdier,
 * slookisen/A2A).
 *
 * CRITICAL BUG this test exists to pin (found by independent review,
 * fixed in the same PR): the migration rebuilds crm_threads via
 * CREATE-new-table / INSERT-copy / DROP-old / RENAME (SQLite can't ALTER a
 * CHECK in place). crm_threads is a PARENT table — crm_messages and
 * crm_actions reference it with ON DELETE CASCADE, crm_outbox with ON
 * DELETE SET NULL. `getDb()` (this file, ~line 108) sets
 * `foreign_keys = ON` before ever calling initSchema(), and with
 * foreign_keys ON, SQLite's DROP TABLE on a table that is an FK target
 * performs an implicit cascade: every crm_messages/crm_actions row
 * pointing at a dropped crm_threads row gets deleted, and every
 * crm_outbox row pointing at one gets its thread_id nulled — silently,
 * on the very first boot after this migration ships, against any real
 * database that already has CRM history. An earlier draft of this
 * migration's own comment INCORRECTLY claimed "DROP TABLE never triggers
 * FK action processing in SQLite" and shipped without disabling the
 * foreign_keys pragma around the rebuild on the strength of that claim.
 * The existing crm-max-touch-vern-send-guard.test.ts-style harnesses all
 * set `foreign_keys = OFF` on their own in-memory test DB (matching this
 * file's __initSchemaForTesting convention elsewhere), so none of them —
 * nor the new crm-thread-status-enum-b3-opt-out.test.ts suite added in
 * the same PR — would ever have caught this: they simply never boot with
 * FK enforcement in the state prod actually boots in.
 *
 * This test deliberately drives initSchema() twice against the SAME
 * already-open handle with `foreign_keys = ON` throughout (mirroring
 * init-dental.test.ts's "re-run on redeploy" pattern): once for a fresh
 * install, then downgrades crm_threads back to the pre-widening shape
 * (simulating an existing production database from before this migration
 * shipped) with real child rows in crm_messages/crm_actions/crm_outbox,
 * then re-runs initSchema() again (== a real reboot after this PR
 * deploys) and asserts every child row survives.
 *
 * Covers:
 *   (1) crm_messages row survives the rebuild (not cascade-deleted).
 *   (2) crm_actions row survives the rebuild (not cascade-deleted).
 *   (3) crm_outbox row survives with its thread_id link intact (not
 *       nulled by ON DELETE SET NULL).
 *   (4) crm_threads.vertical_id ('dental', a non-default value) is
 *       preserved through the rebuild — the companion near-miss this
 *       same migration already guards against explicitly.
 *   (5) the widened CHECK actually works post-migration (UPDATE to
 *       'awaiting_grace' succeeds).
 *   (6) the `foreign_keys` pragma is restored to ON after the migration
 *       completes — a connection left with FK enforcement silently off
 *       for the rest of the process would be a second, quieter bug.
 */

import Database from "better-sqlite3";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export function runInitCrmThreadsB3StatusMigrationTests(opts: { log?: boolean } = {}): TestSummary {
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

  const initMod = require("./init") as typeof import("./init");
  const prevDb = initMod.__peekDbForTesting();

  const db = new Database(":memory:");
  // foreign_keys = ON for the ENTIRE test, matching getDb()'s real boot
  // order exactly (init.ts ~line 108: `db.pragma("foreign_keys = ON")`
  // runs before `initSchema(db)`) — this is the one thing every other
  // harness in this repo gets wrong for this specific migration.
  db.pragma("foreign_keys = ON");

  try {
    initMod.__setDbForTesting(db);
    initMod.__initSchemaForTesting(db); // fresh install — CHECK already wide, migration no-ops

    // Downgrade crm_threads to the OLD pre-widening shape, simulating an
    // existing production database from before this migration shipped.
    // This downgrade dance is test SETUP, not the thing under test, so it
    // toggles foreign_keys off/on around itself purely for its own
    // convenience — the real assertion is about the MIGRATION's own
    // behavior on the re-init call below, which runs with foreign_keys
    // back ON.
    db.exec(`
      CREATE TABLE crm_threads__old (
        id TEXT PRIMARY KEY,
        contact_id TEXT NOT NULL REFERENCES crm_contacts(id) ON DELETE CASCADE,
        subject TEXT,
        status TEXT DEFAULT 'new' CHECK(status IN ('new','in_progress','awaiting_review','done','archived')),
        assigned_to TEXT DEFAULT 'unassigned' CHECK(assigned_to IN ('unassigned','claude','daniel')),
        category TEXT CHECK(category IN ('innkommende','system','marketing','leverandor','unknown')),
        severity TEXT DEFAULT 'normal' CHECK(severity IN ('p0','p1','p2','normal')),
        message_count INTEGER DEFAULT 0,
        last_message_at TEXT,
        last_inbound_at TEXT,
        last_outbound_at TEXT,
        notes TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        vertical_id TEXT NOT NULL DEFAULT 'rfb'
      );
    `);
    db.pragma("foreign_keys = OFF");
    db.exec(`DROP TRIGGER IF EXISTS trg_update_thread_outbound_at;`);
    db.exec(`DROP TRIGGER IF EXISTS trg_log_cold_outreach_to_sent_log_v2;`);
    db.exec(`DROP TRIGGER IF EXISTS trg_log_cold_outreach_on_send_confirm_v2;`);
    db.exec(`DROP TABLE crm_threads;`);
    db.exec(`ALTER TABLE crm_threads__old RENAME TO crm_threads;`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_crm_threads_contact ON crm_threads(contact_id);`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_crm_threads_status ON crm_threads(status);`);
    db.pragma("foreign_keys = ON"); // restored -- a real boot never runs with this off

    db.prepare(`INSERT INTO crm_contacts (id, type, agent_id, email, name) VALUES ('c1','producer',NULL,'a@example.no','A')`).run();
    db.prepare(`INSERT INTO crm_threads (id, contact_id, status, vertical_id) VALUES ('t1','c1','new','dental')`).run();
    db.prepare(
      `INSERT INTO crm_messages (id, thread_id, direction, from_email, to_emails, subject, body_text) VALUES ('m1','t1','in','a@example.no','[]','hei','hei')`,
    ).run();
    db.prepare(`INSERT INTO crm_actions (id, thread_id, contact_id, type, actor) VALUES ('act1','t1','c1','note','daniel')`).run();
    db.prepare(
      `INSERT INTO crm_outbox (id, thread_id, contact_id, intent, to_emails, subject, body_text, created_by) VALUES ('ob1','t1','c1','gmail_draft','[]','hei','hei','claude')`,
    ).run();

    // ══ the actual thing under test: re-run initSchema == a real reboot ═
    initMod.__initSchemaForTesting(db);

    const messageRow = db.prepare("SELECT thread_id FROM crm_messages WHERE id = 'm1'").get() as any;
    assertEq(messageRow?.thread_id, "t1", "1: crm_messages row m1 survives the crm_threads rebuild (not ON DELETE CASCADE-deleted)");

    const actionRow = db.prepare("SELECT thread_id FROM crm_actions WHERE id = 'act1'").get() as any;
    assertEq(actionRow?.thread_id, "t1", "2: crm_actions row act1 survives the crm_threads rebuild (not ON DELETE CASCADE-deleted)");

    const outboxRow = db.prepare("SELECT thread_id FROM crm_outbox WHERE id = 'ob1'").get() as any;
    assertEq(outboxRow?.thread_id, "t1", "3: crm_outbox row ob1's thread_id link survives (not ON DELETE SET NULL-nulled)");

    const threadRow = db.prepare("SELECT vertical_id FROM crm_threads WHERE id = 't1'").get() as any;
    assertEq(threadRow?.vertical_id, "dental", "4: crm_threads.vertical_id ('dental') preserved through the rebuild");

    let updateThrew = false;
    try {
      db.prepare("UPDATE crm_threads SET status = 'awaiting_grace' WHERE id = 't1'").run();
    } catch {
      updateThrew = true;
    }
    assertEq(updateThrew, false, "5: widened CHECK accepts 'awaiting_grace' post-migration");

    assertEq(db.pragma("foreign_keys", { simple: true }), 1, "6: foreign_keys pragma restored to ON after the migration completes");
  } catch (err) {
    failed++;
    failures.push(`init-crm-threads-b3-status-migration: unexpected error: ${err instanceof Error ? (err.stack || err.message) : String(err)}`);
  } finally {
    if (prevDb) initMod.__setDbForTesting(prevDb);
    db.close();
  }

  return { passed, failed, failures };
}

if (require.main === module) {
  console.log(
    "── crm_threads b3-status CHECK-widening migration: FK-cascade safety (dev-request 2026-09-14-crm-thread-status-enum-mangler-b3-opt-out-verdier) ──",
  );
  const r = runInitCrmThreadsB3StatusMigrationTests({ log: true });
  console.log(`\ninit-crm-threads-b3-status-migration: ${r.passed} passed, ${r.failed} failed`);
  if (r.failed > 0) {
    console.log(r.failures.join("\n"));
    process.exit(1);
  }
  process.exit(0);
}
