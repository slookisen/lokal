/**
 * admin-agents-content-quality.test.ts — Daniel 2026-09-03:
 *   «Interne notater skal ikke vises.»
 *   «fiks den byttede teksten på Epleblomsten og Nordlysmat.»
 *
 * Covers, in three sections:
 *   U. services/description-quality: hasInternalNote / stripInternalNotes /
 *      isJunkDescription on the three live note shapes; prose survives an
 *      appended note; the false-positive guard ("oppdatert" in ordinary
 *      prose is NOT a note); idempotence.
 *   S. POST /admin/agents/internal-note-sweep (own ":memory:" DB via its
 *      seam): auth; dry-run writes nothing and previews old+new; apply keeps
 *      prose and drops the note; note-only description -> '' and note-only
 *      about -> NULL; owner lock (claimed_at AND verified agent_claims,
 *      pending does not lock); curated_fields lock; audit row with the FULL
 *      old value and changed_by=system; idempotence.
 *   C. POST /admin/agents/content-correction (own DB): auth; reason and
 *      items mandatory; invalid items reported per-item; junk text refused
 *      (code artifact AND internal note); dry-run reports lock state without
 *      writing; apply writes + audits with changed_by=admin and the reason;
 *      unchanged skipped; about on a row without agent_knowledge is
 *      inserted; and the real case — two agents seeded with each other's
 *      text, corrected in ONE two-item apply.
 *
 * Setup mirrors admin-agents-description-code-artifact-sweep.test.ts exactly
 * (better-sqlite3 ":memory:" + __initSchemaForTesting, route pointed at that
 * DB through its own seam, router.handle() with a fake req/res — no HTTP).
 * Mutates no shared global.
 */

import Database from "better-sqlite3";
import * as initMod from "../database/init";
import { hasInternalNote, stripInternalNotes, isJunkDescription } from "../services/description-quality";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

interface RouteResult {
  status: number;
  body: any;
  ended: boolean;
}

function callRoute(
  router: any,
  opts: { method?: string; url: string; headers?: Record<string, string>; body?: any; query?: Record<string, string> },
): Promise<RouteResult> {
  return new Promise((resolve) => {
    const headers = opts.headers || {};
    const req: any = {
      method: opts.method || "POST",
      url: opts.url,
      originalUrl: opts.url,
      query: opts.query || {},
      headers,
      body: opts.body,
      ip: "127.0.0.1",
      get(name: string) {
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
        resolve({ status: this.statusCode, body: payload, ended: true });
        return this;
      },
      end() {
        resolve({ status: this.statusCode, body: undefined, ended: true });
        return this;
      },
    };
    router.handle(req, res, (err?: any) => {
      if (err) resolve({ status: 500, body: { error: String(err) }, ended: true });
      else resolve({ status: 0, body: undefined, ended: false });
    });
  });
}

// ── The three live shapes, verbatim from production 2026-09-03 ─────────────
const NOTE_ONLY = "Importert fra Hanen-medlemslisten — venter på verifisering";
const SIRDAL_PROSE =
  "Sirdal Tradisjonsmat selger fenalår og pinnekjøtt av lam som har beitet fritt i Sirdal. Tilbyr foredrag om Sirdalsmat og kokkeinnleie. Orgnr 933084353.";
const SIRDAL_WITH_NOTE = SIRDAL_PROSE + " NB: nettside midlertidig utilgjengelig — kontakt bør bekreftes av verifier.";
const HAGAN_PROSE =
  "Hagan Gartneri selger egendyrkede grønnsaker, blomster og planter direkte fra gård. Kjent sesongbasert julebutikk. Lokalt besøksmål for hele Nærøysund.";
const HAGAN_WITH_NOTE = HAGAN_PROSE + " Kontakt ikke verifisert — verifisering pågår.";
// Ordinary prose that an earlier draft's "oppdatert" keyword would have eaten.
const OPPDATERT_PROSE =
  "Åpent hver fredag og lørdag, med oppdaterte åpningstider for kommende helg lagt ut hver onsdag kveld. Følg oss på Facebook for å halde deg oppdatert.";
const NORMAL_DESC = "Vi driver med økologisk grønnsaksdyrking og selger direkte fra gården hver lørdag.";
const CODE_JUNK =
  'Y.Squarespace = Y.Squarespace || {}; Static.SQUARESPACE_CONTEXT = {"website":{"id":"123"},"cacheBust":"abc"}; window.Y.Squarespace.afterBodyLoad(Y);';

// The swap, verbatim openings from production.
const EPLEBLOMSTEN_TEXT =
  "Epleblomsten holder til på Sauar Gard i hjertet av Midt-Telemark og lager kaldpresset most og sirup av 100 % frukt, uten kunstige tilsetningsstoffer.";
const NORDLYSMAT_TEXT =
  "Nordlysmat sanker og foredler urter og bær fra naturen i Finnmark, langt unna trafikkerte veier og forurensning. Alle urter og bær håndplukkes, og all produksjon er håndarbeid.";

export function runAdminAgentsContentQualityTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
    if (cond) {
      passed++;
      if (log) console.log(`  ok ${label}`);
    } else {
      failed++;
      failures.push(`✗ ${label}`);
      if (log) console.log(`  ✗ ${label}`);
    }
  }

  return (async () => {
    const ambientKey = process.env.ADMIN_KEY || process.env.ANALYTICS_ADMIN_KEY || "";
    const setKeyOurselves = ambientKey === "";
    if (setKeyOurselves) process.env.ADMIN_KEY = "content-quality-standalone-key";
    const testKey = process.env.ADMIN_KEY as string;

    // ─── Section U: detector units (no DB) ────────────────────────────────
    {
      assertEq(hasInternalNote(NOTE_ONLY), true, "u-01: note-only value is detected");
      assertEq(hasInternalNote(SIRDAL_WITH_NOTE), true, "u-02: appended 'NB: … verifier' is detected");
      assertEq(hasInternalNote(HAGAN_WITH_NOTE), true, "u-03: appended 'Kontakt ikke verifisert — verifisering pågår' is detected");
      assertEq(hasInternalNote(SIRDAL_PROSE), false, "u-04: the prose in front of the note is NOT a note");
      assertEq(hasInternalNote(OPPDATERT_PROSE), false, "u-05: ordinary prose with 'oppdatert' is NOT a note (false-positive guard)");
      assertEq(hasInternalNote(NORMAL_DESC), false, "u-06: a normal description is NOT a note");
      assertEq(hasInternalNote(null), false, "u-07: null is not a note");
      assertEq(hasInternalNote(""), false, "u-08: empty is not a note");

      assertEq(stripInternalNotes(NOTE_ONLY), "", "u-09: note-only strips to ''");
      assertEq(stripInternalNotes(SIRDAL_WITH_NOTE), SIRDAL_PROSE, "u-10: appended NB-note stripped, prose kept byte-for-byte");
      assertEq(stripInternalNotes(HAGAN_WITH_NOTE), HAGAN_PROSE, "u-11: appended status-note stripped, prose kept byte-for-byte");
      assertEq(stripInternalNotes(OPPDATERT_PROSE), OPPDATERT_PROSE, "u-12: no-op on ordinary prose");
      assertEq(stripInternalNotes(stripInternalNotes(SIRDAL_WITH_NOTE)), SIRDAL_PROSE, "u-13: idempotent");
      assertEq(stripInternalNotes(null), "", "u-14: null -> ''");

      assertEq(isJunkDescription(NOTE_ONLY), true, "u-15: isJunkDescription reports a note-only value as junk (every display guard suppresses it)");
      assertEq(isJunkDescription(SIRDAL_WITH_NOTE), false, "u-16: …but NOT an appended note (the prose must survive; render sites strip instead)");
      assertEq(isJunkDescription(NORMAL_DESC), false, "u-17: normal description unchanged");
    }

    // ─── Section S: internal-note sweep ───────────────────────────────────
    {
      const db = new Database(":memory:");
      try {
        initMod.__initSchemaForTesting(db as any);
        const insertAgent = db.prepare(
          `INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, vertical_id, claimed_at)
           VALUES (?, ?, ?, 'test', 'post@example.no', 'https://example.no', 'producer', ?, 'rfb', ?)`,
        );
        const insertKnowledge = db.prepare(`INSERT INTO agent_knowledge (agent_id, about, curated_fields) VALUES (?, ?, ?)`);
        const insertClaim = db.prepare(
          `INSERT INTO agent_claims (id, agent_id, claimant_name, claimant_email, status) VALUES (?, ?, 'Test Claimant', 'claimant@example.no', ?)`,
        );

        insertAgent.run("s-sirdal", "Sirdal Tradisjonsmat", SIRDAL_WITH_NOTE, "k-s-sirdal", null);
        insertKnowledge.run("s-sirdal", null, "{}");
        insertAgent.run("s-noteonly", "Beiarmat", NOTE_ONLY, "k-s-noteonly", null);
        insertKnowledge.run("s-noteonly", null, "{}");
        insertAgent.run("s-about-only", "Om-notat AS", NORMAL_DESC, "k-s-about", null);
        insertKnowledge.run("s-about-only", NOTE_ONLY, "{}");
        insertAgent.run("s-about-appended", "Om-påheng AS", NORMAL_DESC, "k-s-about2", null);
        insertKnowledge.run("s-about-appended", HAGAN_WITH_NOTE, "{}");
        insertAgent.run("s-claimed", "Claimet AS", HAGAN_WITH_NOTE, "k-s-claimed", "2026-01-01T00:00:00.000Z");
        insertKnowledge.run("s-claimed", null, "{}");
        insertAgent.run("s-vclaim", "Verifisert Eier AS", HAGAN_WITH_NOTE, "k-s-vclaim", null);
        insertKnowledge.run("s-vclaim", null, "{}");
        insertClaim.run("c-s-v", "s-vclaim", "verified");
        insertAgent.run("s-pclaim", "Pending Eier AS", HAGAN_WITH_NOTE, "k-s-pclaim", null);
        insertKnowledge.run("s-pclaim", null, "{}");
        insertClaim.run("c-s-p", "s-pclaim", "pending");
        insertAgent.run("s-curated", "Kuratert AS", HAGAN_WITH_NOTE, "k-s-curated", null);
        insertKnowledge.run("s-curated", null, JSON.stringify({ description: { by: "owner" } }));
        insertAgent.run("s-clean", "Ekte Gård AS", OPPDATERT_PROSE, "k-s-clean", null);
        insertKnowledge.run("s-clean", null, "{}");

        delete require.cache[require.resolve("./admin-agents-internal-note-sweep")];
        const routeMod = require("./admin-agents-internal-note-sweep");
        const router = routeMod.default;
        routeMod.__setInternalNoteSweepDbForTesting(db as any);

        const post = (body: any, key: string | false = testKey, query?: Record<string, string>) => {
          const headers: Record<string, string> = {};
          if (key !== false) headers["x-admin-key"] = key;
          return callRoute(router, { method: "POST", url: "/", headers, body, query });
        };
        const descOf = (id: string) => (db.prepare(`SELECT description FROM agents WHERE id = ?`).get(id) as any)?.description ?? null;
        const aboutOf = (id: string) => (db.prepare(`SELECT about FROM agent_knowledge WHERE agent_id = ?`).get(id) as any)?.about ?? null;
        const auditFor = (id: string) =>
          db.prepare(`SELECT field_name, old_value, new_value, changed_by, notes FROM agent_knowledge_audit WHERE agent_id = ? ORDER BY changed_at`).all(id) as any[];
        const res = (body: any, id: string) => (body?.results ?? []).find((r: any) => r.agent_id === id);
        const ares = (body: any, id: string) => (body?.about_results ?? []).find((r: any) => r.agent_id === id);

        let r = await post({}, false);
        assertEq(r.status, 403, "s-01: missing X-Admin-Key -> 403");

        r = await post({});
        assertEq(r.body?.dry_run, true, "s-02: dry-run by default");
        assertEq(res(r.body, "s-sirdal")?.outcome, "would_write", "s-03: appended-note row is a candidate");
        assertEq(res(r.body, "s-sirdal")?.new_value_preview, SIRDAL_PROSE.slice(0, 80) + "…", "s-04: dry-run previews the CLEANED value (prose kept)");
        assertEq(res(r.body, "s-noteonly")?.new_value_preview, "", "s-05: note-only row previews '' as the new value");
        assertEq(res(r.body, "s-clean"), undefined, "s-06: ordinary prose with 'oppdatert' is never a candidate");
        assertEq(descOf("s-sirdal"), SIRDAL_WITH_NOTE, "s-07: dry-run left the column untouched");
        assertEq(auditFor("s-sirdal").length, 0, "s-08: dry-run wrote no audit row");
        assertEq(ares(r.body, "s-about-only")?.outcome, "would_write", "s-09: note-only about is an about-candidate");

        r = await post({ reason: "test-note-sweep" }, testKey, { apply: "1" });
        assertEq(r.body?.dry_run, false, "s-10: apply=1 turns off dry-run");
        assertEq(res(r.body, "s-sirdal")?.outcome, "written", "s-11: appended-note row written");
        assertEq(descOf("s-sirdal"), SIRDAL_PROSE, "s-12: THE PROSE SURVIVED — only the note is gone");
        assertEq(descOf("s-noteonly"), "", "s-13: note-only description -> '' (TEXT NOT NULL)");
        assertEq(aboutOf("s-about-only"), null, "s-14: note-only about -> NULL (nullable)");
        assertEq(aboutOf("s-about-appended"), HAGAN_PROSE, "s-15: appended note on about stripped, prose kept");
        const a = auditFor("s-sirdal");
        assertEq(a.length, 1, "s-16: exactly one audit row");
        assertEq(a[0]?.old_value, SIRDAL_WITH_NOTE, "s-17: audit preserves the FULL old value (reversible)");
        assertEq(a[0]?.new_value, SIRDAL_PROSE, "s-18: audit records the cleaned value");
        assertEq(a[0]?.changed_by, "system", "s-19: audit changed_by=system");
        assertTrue((a[0]?.notes ?? "").includes("test-note-sweep"), "s-20: audit notes carry the reason");
        assertEq(res(r.body, "s-claimed")?.outcome, "skipped_claimed", "s-21: claimed_at locks");
        assertEq(res(r.body, "s-vclaim")?.outcome, "skipped_claimed", "s-22: verified agent_claims locks");
        assertEq(res(r.body, "s-pclaim")?.outcome, "written", "s-23: pending claim does NOT lock");
        assertEq(res(r.body, "s-curated")?.outcome, "skipped_curated", "s-24: curated_fields locks");
        assertEq(descOf("s-curated"), HAGAN_WITH_NOTE, "s-25: curated row untouched");

        r = await post({});
        assertEq(res(r.body, "s-sirdal"), undefined, "s-26: idempotent — cleaned row is no longer a candidate");
        assertEq(res(r.body, "s-claimed")?.outcome, "would_write", "s-27: still-locked row keeps reporting on re-run");
      } finally {
        try { require("./admin-agents-internal-note-sweep").__setInternalNoteSweepDbForTesting(null); } catch { /* ignore */ }
        try { db.close(); } catch { /* ignore */ }
      }
    }

    // ─── Section C: content-correction ────────────────────────────────────
    {
      const db = new Database(":memory:");
      try {
        initMod.__initSchemaForTesting(db as any);
        const insertAgent = db.prepare(
          `INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, vertical_id, claimed_at)
           VALUES (?, ?, ?, 'test', 'post@example.no', 'https://example.no', 'producer', ?, 'rfb', ?)`,
        );
        const insertKnowledge = db.prepare(`INSERT INTO agent_knowledge (agent_id, about, curated_fields) VALUES (?, ?, ?)`);
        const insertClaim = db.prepare(
          `INSERT INTO agent_claims (id, agent_id, claimant_name, claimant_email, status) VALUES (?, ?, 'Test Claimant', 'claimant@example.no', ?)`,
        );

        // The real case: each carries the OTHER's text.
        insertAgent.run("c-eple", "Epleblomsten — Telemark", NORDLYSMAT_TEXT, "k-c-eple", null);
        insertKnowledge.run("c-eple", null, "{}");
        insertAgent.run("c-nordlys", "Nordlysmat Drift AS", EPLEBLOMSTEN_TEXT, "k-c-nordlys", null);
        insertKnowledge.run("c-nordlys", null, "{}");
        insertAgent.run("c-claimed", "Claimet AS", NORMAL_DESC, "k-c-claimed", "2026-01-01T00:00:00.000Z");
        insertKnowledge.run("c-claimed", null, "{}");
        insertAgent.run("c-vclaim", "Verifisert AS", NORMAL_DESC, "k-c-vclaim", null);
        insertKnowledge.run("c-vclaim", null, "{}");
        insertClaim.run("c-c-v", "c-vclaim", "verified");
        insertAgent.run("c-curated", "Kuratert AS", NORMAL_DESC, "k-c-curated", null);
        insertKnowledge.run("c-curated", null, JSON.stringify({ about: { by: "owner" } }));
        insertAgent.run("c-noknow", "UtenKunnskap AS", NORMAL_DESC, "k-c-noknow", null);

        delete require.cache[require.resolve("./admin-agents-content-correction")];
        const routeMod = require("./admin-agents-content-correction");
        const router = routeMod.default;
        routeMod.__setContentCorrectionDbForTesting(db as any);

        const post = (body: any, key: string | false = testKey, query?: Record<string, string>) => {
          const headers: Record<string, string> = {};
          if (key !== false) headers["x-admin-key"] = key;
          return callRoute(router, { method: "POST", url: "/", headers, body, query });
        };
        const descOf = (id: string) => (db.prepare(`SELECT description FROM agents WHERE id = ?`).get(id) as any)?.description ?? null;
        const aboutOf = (id: string) => (db.prepare(`SELECT about FROM agent_knowledge WHERE agent_id = ?`).get(id) as any)?.about ?? null;
        const auditFor = (id: string) =>
          db.prepare(`SELECT field_name, old_value, new_value, changed_by, notes FROM agent_knowledge_audit WHERE agent_id = ? ORDER BY changed_at`).all(id) as any[];
        const res = (body: any, id: string, field?: string) =>
          (body?.results ?? []).find((r: any) => r.agent_id === id && (!field || r.field === field));
        const SWAP = [
          { agent_id: "c-eple", field: "description", text: EPLEBLOMSTEN_TEXT },
          { agent_id: "c-nordlys", field: "description", text: NORDLYSMAT_TEXT },
        ];
        const REASON = "Epleblomsten og Nordlysmat hadde byttet beskrivelser (Daniel 2026-09-03)";

        let r = await post({ reason: REASON, items: SWAP }, false);
        assertEq(r.status, 403, "c-01: missing X-Admin-Key -> 403");
        r = await post({ items: SWAP });
        assertEq(r.status, 400, "c-02: reason is mandatory");
        r = await post({ reason: REASON });
        assertEq(r.status, 400, "c-03: items[] is mandatory");
        r = await post({ reason: REASON, items: [] });
        assertEq(r.status, 400, "c-04: empty items[] refused");

        // Per-item validation + junk gates
        r = await post({
          reason: REASON,
          items: [
            { agent_id: "", field: "description", text: "x" },
            { agent_id: "c-eple", field: "title", text: "x" },
            { agent_id: "c-eple", field: "description", text: "   " },
            { agent_id: "c-eple", field: "description", text: CODE_JUNK },
            { agent_id: "c-eple", field: "description", text: NOTE_ONLY },
            { agent_id: "c-eple", field: "description", text: SIRDAL_WITH_NOTE },
          ],
        });
        assertEq(r.status, 200, "c-05: invalid items are reported per-item, not as a request error");
        assertEq(r.body?.counts?.invalid_item, 3, "c-06: three invalid items");
        assertEq(r.body?.counts?.refused_junk_text, 3, "c-07: code artifact, note-only AND appended-note text all refused — a correction is never how junk gets back in");
        assertEq(descOf("c-eple"), NORDLYSMAT_TEXT, "c-08: nothing written by an all-invalid dry-run");

        // Dry-run reports lock state, writes nothing
        r = await post({
          reason: REASON,
          items: [
            ...SWAP,
            { agent_id: "c-claimed", field: "description", text: "ny tekst" },
            { agent_id: "c-vclaim", field: "description", text: "ny tekst" },
            { agent_id: "c-curated", field: "about", text: "ny tekst" },
            { agent_id: "c-curated", field: "description", text: NORMAL_DESC },
            { agent_id: "nope", field: "description", text: "ny tekst" },
          ],
        });
        assertEq(r.body?.dry_run, true, "c-09: dry-run by default");
        assertEq(res(r.body, "c-eple")?.outcome, "would_write", "c-10: dry-run: Epleblomsten would_write");
        assertEq(res(r.body, "c-eple")?.name, "Epleblomsten — Telemark", "c-11: dry-run names the row");
        assertEq(res(r.body, "c-claimed")?.outcome, "skipped_claimed", "c-12: dry-run shows claimed_at lock BEFORE any apply");
        assertEq(res(r.body, "c-vclaim")?.outcome, "skipped_claimed", "c-13: dry-run shows verified-claim lock");
        assertEq(res(r.body, "c-curated", "about")?.outcome, "skipped_curated", "c-14: curated about is refused");
        assertEq(res(r.body, "c-curated", "description")?.outcome, "skipped_unchanged", "c-15: identical text -> skipped_unchanged (curated_fields only locks the named field)");
        assertEq(res(r.body, "nope")?.outcome, "not_found", "c-16: unknown agent -> not_found");
        assertEq(descOf("c-eple"), NORDLYSMAT_TEXT, "c-17: dry-run wrote nothing");
        assertEq(auditFor("c-eple").length, 0, "c-18: dry-run audited nothing");

        // THE SWAP — one two-item apply
        r = await post({ reason: REASON, items: SWAP }, testKey, { apply: "1" });
        assertEq(r.body?.dry_run, false, "c-19: apply=1");
        assertEq(r.body?.counts?.written, 2, "c-20: both rows written in one call");
        assertEq(descOf("c-eple"), EPLEBLOMSTEN_TEXT, "c-21: Epleblomsten now carries Epleblomsten's text");
        assertEq(descOf("c-nordlys"), NORDLYSMAT_TEXT, "c-22: Nordlysmat now carries Nordlysmat's text");
        const ae = auditFor("c-eple");
        assertEq(ae.length, 1, "c-23: one audit row on Epleblomsten");
        assertEq(ae[0]?.old_value, NORDLYSMAT_TEXT, "c-24: audit preserves the FULL old (wrong) value — reversible");
        assertEq(ae[0]?.new_value, EPLEBLOMSTEN_TEXT, "c-25: audit records the new value");
        assertEq(ae[0]?.changed_by, "admin", "c-26: changed_by=admin — a person directed this, not a routine");
        assertTrue((ae[0]?.notes ?? "").includes("byttet beskrivelser"), "c-27: audit notes carry the human reason");
        assertEq(auditFor("c-nordlys")[0]?.changed_by, "admin", "c-28: same on Nordlysmat");

        // Re-apply is a no-op
        r = await post({ reason: REASON, items: SWAP }, testKey, { apply: "1" });
        assertEq(r.body?.counts?.skipped_unchanged, 2, "c-29: re-applying the same correction is skipped_unchanged, not re-written");
        assertEq(auditFor("c-eple").length, 1, "c-30: …and adds no audit row");

        // Locks hold on apply too; about on a row without agent_knowledge is inserted
        r = await post({
          reason: REASON,
          items: [
            { agent_id: "c-claimed", field: "description", text: "ny tekst" },
            { agent_id: "c-noknow", field: "about", text: "Om oss: gården ligger ved fjorden." },
          ],
        }, testKey, { apply: "1" });
        assertEq(res(r.body, "c-claimed")?.outcome, "skipped_claimed", "c-31: apply refuses the claimed row");
        assertEq(descOf("c-claimed"), NORMAL_DESC, "c-32: claimed row untouched");
        assertEq(res(r.body, "c-noknow")?.outcome, "written", "c-33: about on a row without agent_knowledge is written");
        assertEq(aboutOf("c-noknow"), "Om oss: gården ligger ved fjorden.", "c-34: …by INSERTing the agent_knowledge row");
        assertEq(auditFor("c-noknow")[0]?.field_name, "about", "c-35: audited under the right field");
      } finally {
        try { require("./admin-agents-content-correction").__setContentCorrectionDbForTesting(null); } catch { /* ignore */ }
        try { db.close(); } catch { /* ignore */ }
      }
    }

    if (setKeyOurselves) delete process.env.ADMIN_KEY;
    return { passed, failed, failures };
  })();
}
