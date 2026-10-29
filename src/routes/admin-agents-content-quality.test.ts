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
 *   P. content-correction list/product fields (S2w): product_name rename
 *      (other fields kept, 0/>1 match invalid, duplicate -> would_merge /
 *      merged keeping the richer row), products_organic_flag, specialties /
 *      certifications / tags removal incl. not-found elements; owner and
 *      curated locks, dry-run writes nothing, max 50, write-pause gate.
 *
 * Setup mirrors admin-agents-description-code-artifact-sweep.test.ts exactly
 * (better-sqlite3 ":memory:" + __initSchemaForTesting, route pointed at that
 * DB through its own seam, router.handle() with a fake req/res — no HTTP).
 * Mutates no shared global.
 */

import Database from "better-sqlite3";
import * as initMod from "../database/init";
import { hasInternalNote, stripInternalNotes, isJunkDescription } from "../services/description-quality";
import { setEnrichmentWritePause } from "../services/enrichment-write-pause";
import { runProductCatalogSync } from "../services/product-catalog-sync";

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

    // ─── Section P: content-correction list/product fields (S2w) ─────────
    {
      const db = new Database(":memory:");
      try {
        initMod.__initSchemaForTesting(db as any);
        const insertAgent = db.prepare(
          `INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, vertical_id, claimed_at, tags)
           VALUES (?, ?, ?, 'test', 'post@example.no', 'https://example.no', 'producer', ?, 'rfb', ?, ?)`,
        );
        const insertKnowledge = db.prepare(
          `INSERT INTO agent_knowledge (agent_id, products, specialties, certifications, curated_fields) VALUES (?, ?, ?, ?, ?)`,
        );
        const insertClaim = db.prepare(
          `INSERT INTO agent_claims (id, agent_id, claimant_name, claimant_email, status) VALUES (?, ?, 'Test Claimant', 'claimant@example.no', ?)`,
        );

        const LAM = { name: "Lammekjøt", category: "meat", seasonal: true, months: [9, 10, 11], price: "275/kg", priceUnit: "kr", organic: true };
        const EGG = { name: "Egg", category: "eggs", seasonal: false, price: "60", organic: false };
        const OST = { name: "Gårdsost", category: "dairy", seasonal: false, organic: 1 };
        const PRODUCTS = JSON.stringify([LAM, EGG, OST]);
        const SPEC = JSON.stringify(["Økologiske grønnsaker", "Gårdsost", "Lam"]);
        const CERT = JSON.stringify(["Debio", "Nyt Norge"]);
        const TAGS = JSON.stringify(["økologisk", "lam", "org_nr:123456789"]);

        insertAgent.run("p-main", "Hovedgård AS", NORMAL_DESC, "k-p-main", null, TAGS);
        insertKnowledge.run("p-main", PRODUCTS, SPEC, CERT, "{}");
        insertAgent.run("p-claimed", "Eid Gård AS", NORMAL_DESC, "k-p-claimed", "2026-01-01T00:00:00.000Z", TAGS);
        insertKnowledge.run("p-claimed", PRODUCTS, SPEC, CERT, "{}");
        insertAgent.run("p-vclaim", "Verifisert Gård AS", NORMAL_DESC, "k-p-vclaim", null, TAGS);
        insertKnowledge.run("p-vclaim", PRODUCTS, SPEC, CERT, "{}");
        insertClaim.run("c-p-v", "p-vclaim", "verified");
        insertAgent.run("p-curated", "Kuratert Gård AS", NORMAL_DESC, "k-p-curated", null, TAGS);
        insertKnowledge.run("p-curated", PRODUCTS, SPEC, CERT, JSON.stringify({ products: { by: "owner" }, specialties: { by: "owner" } }));
        // Two products with the same name -> old_name is ambiguous.
        insertAgent.run("p-twin", "Tvilling Gård AS", NORMAL_DESC, "k-p-twin", null, "[]");
        insertKnowledge.run("p-twin", JSON.stringify([{ name: "Honning", price: "100" }, { name: "Honning", price: "120" }]), "[]", "[]", "{}");
        // Merge cases: renamed row richer vs. a tie.
        insertAgent.run("p-merge-a", "Flett A AS", NORMAL_DESC, "k-p-ma", null, "[]");
        insertKnowledge.run("p-merge-a", JSON.stringify([
          { name: "Lammekjot", category: "meat", price: "275/kg", months: [9, 10], priceUnit: "kr" },
          { name: "Egg", price: "60" },
          { name: "Lammekjøt", category: "meat" },
        ]), "[]", "[]", "{}");
        insertAgent.run("p-merge-b", "Flett B AS", NORMAL_DESC, "k-p-mb", null, "[]");
        insertKnowledge.run("p-merge-b", JSON.stringify([
          { name: "Lammekjot", category: "meat" },
          { name: "Lammekjøt", category: "meat" },
        ]), "[]", "[]", "{}");
        insertAgent.run("p-noorganic", "Uten Øko AS", NORMAL_DESC, "k-p-noorg", null, "[]");
        insertKnowledge.run("p-noorganic", JSON.stringify([EGG]), "[]", "[]", "{}");
        insertAgent.run("p-badjson", "Ødelagt JSON AS", NORMAL_DESC, "k-p-bad", null, "[]");
        insertKnowledge.run("p-badjson", "{not json", "[]", "[]", "{}");
        // Catalog cases (reviewer fix-up): rename in place, merge-retire
        // (delete), merge-retire with a cart reference (out_of_stock).
        insertAgent.run("p-cat", "Katalog AS", NORMAL_DESC, "k-p-cat", null, "[]");
        insertKnowledge.run("p-cat", JSON.stringify([{ name: "Økologisk honning", price: "120" }, { name: "Egg", price: "60" }]), "[]", "[]", "{}");
        insertAgent.run("p-cat-m", "Katalog Flett AS", NORMAL_DESC, "k-p-catm", null, "[]");
        insertKnowledge.run("p-cat-m", JSON.stringify([{ name: "Økologisk lam", price: "300" }, { name: "Lam", price: "280" }]), "[]", "[]", "{}");
        insertAgent.run("p-cat-r", "Katalog Kurv AS", NORMAL_DESC, "k-p-catr", null, "[]");
        insertKnowledge.run("p-cat-r", JSON.stringify([{ name: "Økologisk ost", price: "90" }, { name: "Gårdsost", price: "95" }]), "[]", "[]", "{}");
        insertAgent.run("p-lamlist", "Lammeliste AS", NORMAL_DESC, "k-p-laml", null, "[]");
        insertKnowledge.run("p-lamlist", "[]", JSON.stringify(["Lam", "Lammekjøtt"]), "[]", "{}");
        assertTrue(runProductCatalogSync(db as any).success, "p-cat-00: initial catalog sync ok");
        const catRows = (id: string) =>
          db.prepare(`SELECT id, name, name_norm, availability FROM products WHERE agent_id = ? ORDER BY name_norm`).all(id) as any[];
        const catRow = (id: string, norm: string) => catRows(id).find((x: any) => x.name_norm === norm);

        delete require.cache[require.resolve("./admin-agents-content-correction")];
        const routeMod = require("./admin-agents-content-correction");
        const router = routeMod.default;
        routeMod.__setContentCorrectionDbForTesting(db as any);

        const post = (body: any, query?: Record<string, string>) =>
          callRoute(router, { method: "POST", url: "/", headers: { "x-admin-key": testKey }, body, query });
        const apply = { apply: "1" };
        const kRow = (id: string) => db.prepare(`SELECT products, specialties, certifications FROM agent_knowledge WHERE agent_id = ?`).get(id) as any;
        const productsOf = (id: string) => JSON.parse(kRow(id).products);
        const tagsOf = (id: string) => (db.prepare(`SELECT tags FROM agents WHERE id = ?`).get(id) as any).tags;
        const auditFor = (id: string) =>
          db.prepare(`SELECT field_name, old_value, new_value, changed_by, notes FROM agent_knowledge_audit WHERE agent_id = ? ORDER BY changed_at, rowid`).all(id) as any[];
        const auditCount = () => (db.prepare(`SELECT COUNT(*) AS n FROM agent_knowledge_audit`).get() as any).n;
        const res = (body: any, id: string, field?: string) =>
          (body?.results ?? []).find((r: any) => r.agent_id === id && (!field || r.field === field));
        const REASON = "S2w test: produktnavn/lister";
        const snapshot = () => JSON.stringify(db.prepare(`SELECT agent_id, products, specialties, certifications FROM agent_knowledge ORDER BY agent_id`).all()) +
          JSON.stringify(db.prepare(`SELECT id, tags FROM agents ORDER BY id`).all()) +
          JSON.stringify(db.prepare(`SELECT * FROM products ORDER BY id`).all());

        // ── Validation ──
        let r = await post({
          reason: REASON,
          items: [
            { agent_id: "p-main", field: "product_name", text: "Lam" },                       // no old_name
            { agent_id: "p-main", field: "product_name", old_name: "Lammekjøt", text: "   " }, // empty text
            { agent_id: "p-main", field: "product_name", old_name: "Lammekjøt", text: CODE_JUNK },
            { agent_id: "p-main", field: "product_name", old_name: "Lammekjøt", text: NOTE_ONLY },
            { agent_id: "p-main", field: "tags" },                                            // no remove[]
            { agent_id: "p-main", field: "specialties", remove: [] },
            { agent_id: "p-main", field: "certifications", remove: [1] },
            { agent_id: "p-main", field: "categories", remove: ["x"] },                       // unknown field
          ],
        });
        assertEq(r.status, 200, "p-01: invalid new-field items reported per-item");
        assertEq(r.body?.counts?.invalid_item, 6, "p-02: missing old_name, empty text, missing/empty/non-string remove[], unknown field -> invalid_item");
        assertEq(r.body?.counts?.refused_junk_text, 2, "p-03: product name passes the code-artifact and internal-note gates");

        // ── Max 50 across new field types ──
        const fifty = Array.from({ length: 51 }, (_, i) =>
          i % 3 === 0 ? { agent_id: "p-main", field: "products_organic_flag" }
          : i % 3 === 1 ? { agent_id: "p-main", field: "tags", remove: ["lam"] }
          : { agent_id: "p-main", field: "product_name", old_name: "Egg", text: "Egg " + i });
        r = await post({ reason: REASON, items: fifty });
        assertEq(r.status, 400, "p-04: 51 mixed new-type items -> 400 (max 50 still enforced)");
        r = await post({ reason: REASON, items: fifty.slice(0, 50) });
        assertEq(r.status, 200, "p-05: exactly 50 mixed new-type items accepted");
        r = await post({ items: [{ agent_id: "p-main", field: "products_organic_flag" }] });
        assertEq(r.status, 400, "p-06: reason still mandatory for new field types");

        // ── Dry-run writes nothing ──
        const before = snapshot();
        const auditBefore = auditCount();
        r = await post({
          reason: REASON,
          items: [
            { agent_id: "p-main", field: "product_name", old_name: "Lammekjøt", text: "Lammekjøt fra Hovedgård" },
            { agent_id: "p-main", field: "products_organic_flag" },
            { agent_id: "p-main", field: "specialties", remove: ["Gårdsost"] },
            { agent_id: "p-main", field: "certifications", remove: ["Debio"] },
            { agent_id: "p-main", field: "tags", remove: ["økologisk"] },
            { agent_id: "p-merge-a", field: "product_name", old_name: "Lammekjot", text: "Lammekjøt" },
            { agent_id: "p-claimed", field: "product_name", old_name: "Lammekjøt", text: "Lam" },
            { agent_id: "p-vclaim", field: "tags", remove: ["lam"] },
            { agent_id: "p-curated", field: "products_organic_flag" },
            { agent_id: "p-curated", field: "specialties", remove: ["Lam"] },
            { agent_id: "p-curated", field: "certifications", remove: ["Debio"] },
            { agent_id: "p-twin", field: "product_name", old_name: "Honning", text: "Lynghonning" },
            { agent_id: "p-main", field: "product_name", old_name: "Finnes ikke", text: "X" },
            { agent_id: "p-badjson", field: "products_organic_flag" },
            { agent_id: "p-cat", field: "product_name", old_name: "Økologisk honning", text: "Honning" },
            { agent_id: "p-cat-m", field: "product_name", old_name: "Økologisk lam", text: "Lam" },
          ],
        });
        assertEq(res(r.body, "p-cat")?.catalog?.action, "rename_in_place", "p-cat-01: dry-run reports the catalog rename it would make");
        assertEq(res(r.body, "p-cat")?.catalog?.applied, undefined, "p-cat-02: dry-run catalog effect is not marked applied");
        assertEq(res(r.body, "p-cat-m")?.catalog?.action, "retire_delete", "p-cat-03: dry-run merge reports the old catalog row would be retired");
        assertEq(r.body?.dry_run, true, "p-07: dry-run by default");
        assertEq(res(r.body, "p-main", "product_name")?.outcome, "would_write", "p-08: dry-run rename would_write");
        assertEq(res(r.body, "p-main", "product_name")?.old_value_preview, "Lammekjøt", "p-09: dry-run previews old_name");
        assertEq(res(r.body, "p-main", "products_organic_flag")?.changed_count, 2, "p-10: dry-run organic flag counts truthy products (true and 1)");
        assertEq(res(r.body, "p-merge-a", "product_name")?.outcome, "would_merge", "p-11: duplicate target name -> would_merge in dry-run");
        assertEq(res(r.body, "p-merge-a", "product_name")?.merge?.kept, "renamed_row", "p-12: dry-run reports which row would be kept");
        assertEq(res(r.body, "p-claimed")?.outcome, "skipped_claimed", "p-13: claimed_at owner lock on product_name");
        assertEq(res(r.body, "p-vclaim")?.outcome, "skipped_claimed", "p-14: verified-claim owner lock on tags");
        assertEq(res(r.body, "p-curated", "products_organic_flag")?.outcome, "skipped_curated", "p-15: curated products locks products_organic_flag");
        assertEq(res(r.body, "p-curated", "specialties")?.outcome, "skipped_curated", "p-16: curated specialties locks specialties");
        assertEq(res(r.body, "p-curated", "certifications")?.outcome, "would_write", "p-17: curated_fields only locks the named list");
        assertEq(res(r.body, "p-twin")?.outcome, "invalid_item", "p-18: >1 product matches old_name -> invalid_item");
        assertEq((r.body?.results ?? []).find((x: any) => x.agent_id === "p-main" && x.field === "product_name" && x.old_value_preview === "Finnes ikke")?.outcome,
          "invalid_item", "p-19: 0 products match old_name -> invalid_item");
        assertEq(res(r.body, "p-badjson")?.outcome, "skipped_malformed_json", "p-20: malformed stored products JSON is skipped, not crashed on");
        assertEq(snapshot(), before, "p-21: dry-run left every list/product column byte-identical");
        assertEq(auditCount(), auditBefore, "p-22: dry-run wrote no audit row");

        // ── Rename keeps every other field ──
        r = await post({ reason: REASON, items: [{ agent_id: "p-main", field: "product_name", old_name: "Lammekjøt", text: "Lammekjøt fra Hovedgård" }] }, apply);
        assertEq(res(r.body, "p-main")?.outcome, "written", "p-23: rename written");
        const renamed = productsOf("p-main");
        assertEq(renamed[0], { ...LAM, name: "Lammekjøt fra Hovedgård" }, "p-24: renamed product keeps price/months/unit/organic/category identical (and key order)");
        assertEq(JSON.stringify(renamed.slice(1)), JSON.stringify([EGG, OST]), "p-25: other products untouched");
        let a = auditFor("p-main");
        assertEq(a.length, 1, "p-26: one audit row");
        assertEq(a[0]?.field_name, "products", "p-27: audit field_name = products");
        assertEq(a[0]?.old_value, PRODUCTS, "p-28: audit old_value = full old products JSON");
        assertEq(JSON.parse(a[0]?.new_value)[0]?.name, "Lammekjøt fra Hovedgård", "p-29: audit new_value carries the rename");
        assertEq(a[0]?.changed_by, "admin", "p-30: changed_by=admin");
        assertTrue(/^content-correction-\d{8}-\d{6}: S2w test/.test(a[0]?.notes ?? ""), "p-31: audit notes = `${batchTag}: ${reason}`");

        // ── Locks hold on apply ──
        r = await post({
          reason: REASON,
          items: [
            { agent_id: "p-claimed", field: "product_name", old_name: "Lammekjøt", text: "Lam" },
            { agent_id: "p-curated", field: "product_name", old_name: "Lammekjøt", text: "Lam" },
          ],
        }, apply);
        assertEq(res(r.body, "p-claimed")?.outcome, "skipped_claimed", "p-32: apply refuses owner-locked profile");
        assertEq(res(r.body, "p-curated")?.outcome, "skipped_curated", "p-33: apply refuses curated products");
        assertEq(kRow("p-claimed").products, PRODUCTS, "p-34: locked rows untouched");
        assertEq(auditFor("p-claimed").length + auditFor("p-curated").length, 0, "p-35: no audit on locked rows");

        // ── Merge on apply ──
        r = await post({ reason: REASON, items: [{ agent_id: "p-merge-a", field: "product_name", old_name: "Lammekjot", text: "Lammekjøt" }] }, apply);
        assertEq(res(r.body, "p-merge-a")?.outcome, "merged", "p-36: apply duplicate -> merged");
        assertEq(productsOf("p-merge-a"), [
          { name: "Lammekjøt", category: "meat", price: "275/kg", months: [9, 10], priceUnit: "kr" },
          { name: "Egg", price: "60" },
        ], "p-37: richer (renamed) row kept with the new name, the thinner duplicate dropped");
        a = auditFor("p-merge-a");
        assertEq(a.length, 1, "p-38: merge writes one audit row");
        assertTrue((a[0]?.notes ?? "").includes("merge: kept renamed_row") && (a[0]?.notes ?? "").includes("dropped"), "p-39: audit notes record kept + dropped rows");
        r = await post({ reason: REASON, items: [{ agent_id: "p-merge-b", field: "product_name", old_name: "Lammekjot", text: "Lammekjøt" }] }, apply);
        assertEq(res(r.body, "p-merge-b")?.merge?.kept, "existing_row", "p-40: tie -> the row already named `text` is kept");
        assertEq(productsOf("p-merge-b"), [{ name: "Lammekjøt", category: "meat" }], "p-41: tie merge leaves one product");

        // ── Catalog: rename in place ──
        const honId = catRow("p-cat", "økologisk honning")?.id;
        assertTrue(!!honId, "p-cat-10: fixture has a catalog row for the old name");
        r = await post({ reason: REASON, items: [{ agent_id: "p-cat", field: "product_name", old_name: "Økologisk honning", text: "Honning" }] }, apply);
        assertEq(res(r.body, "p-cat")?.outcome, "written", "p-cat-11: rename written");
        assertEq(res(r.body, "p-cat")?.catalog?.action, "rename_in_place", "p-cat-12: catalog row renamed in place");
        assertEq(res(r.body, "p-cat")?.catalog?.applied, true, "p-cat-13: catalog effect applied");
        assertEq(catRow("p-cat", "honning")?.id, honId, "p-cat-14: same products.id, new name_norm");
        assertEq(catRow("p-cat", "honning")?.name, "Honning", "p-cat-15: catalog name updated");
        assertEq(catRow("p-cat", "økologisk honning"), undefined, "p-cat-16: no catalog row left under the old name");
        assertTrue((auditFor("p-cat")[0]?.notes ?? "").includes("[catalog: ") && (auditFor("p-cat")[0]?.notes ?? "").includes("Økologisk honning"),
          "p-cat-17: audit notes carry the catalog effect incl. the old row (rollback)");
        assertTrue(runProductCatalogSync(db as any).success, "p-cat-18: re-sync ok");
        assertEq(catRows("p-cat").map((x: any) => [x.name, x.availability]), [["Egg", "in_stock"], ["Honning", "in_stock"]],
          "p-cat-19: after re-sync the old name is not re-created; exactly one listable honning row");
        assertEq(catRow("p-cat", "honning")?.id, honId, "p-cat-20: re-sync updated the same row");

        // ── Catalog: merge retires the old row (no references -> delete) ──
        const lamId = catRow("p-cat-m", "lam")?.id;
        r = await post({ reason: REASON, items: [{ agent_id: "p-cat-m", field: "product_name", old_name: "Økologisk lam", text: "Lam" }] }, apply);
        assertEq(res(r.body, "p-cat-m")?.outcome, "merged", "p-cat-21: merge applied");
        assertEq(res(r.body, "p-cat-m")?.catalog?.action, "retire_delete", "p-cat-22: unreferenced old catalog row deleted");
        assertEq(res(r.body, "p-cat-m")?.catalog?.existing_product_id, lamId, "p-cat-23: reports the surviving catalog row");
        runProductCatalogSync(db as any);
        assertEq(catRows("p-cat-m").map((x: any) => [x.id, x.name, x.availability]), [[lamId, "Lam", "in_stock"]],
          "p-cat-24: after merge + re-sync exactly one listable row, the surviving one");

        // ── Catalog: merge with a cart reference -> out_of_stock, row kept ──
        const oldOstId = catRow("p-cat-r", "økologisk ost")?.id;
        db.prepare(`INSERT INTO carts (id, buyer_ref) VALUES ('cart-cat', 'buyer-cat')`).run();
        db.prepare(`INSERT INTO cart_items (id, cart_id, product_id, agent_id, qty) VALUES ('ci-cat', 'cart-cat', ?, 'p-cat-r', 1)`).run(oldOstId);
        // Lower-case target: equal to "Gårdsost" under the catalog normalisation -> merge.
        r = await post({ reason: REASON, items: [{ agent_id: "p-cat-r", field: "product_name", old_name: "Økologisk ost", text: "gårdsost" }] }, apply);
        assertEq(res(r.body, "p-cat-r")?.outcome, "merged", "p-cat-25: case-insensitive duplicate name is a merge");
        assertEq(productsOf("p-cat-r").map((x: any) => x.name), ["gårdsost"], "p-cat-26: one product left, named `text`");
        assertEq(res(r.body, "p-cat-r")?.catalog?.action, "retire_out_of_stock", "p-cat-27: referenced old catalog row is retired as out_of_stock");
        assertEq(res(r.body, "p-cat-r")?.catalog?.references?.cart_items, 1, "p-cat-28: reports the cart reference");
        runProductCatalogSync(db as any);
        assertEq(catRow("p-cat-r", "økologisk ost")?.availability, "out_of_stock", "p-cat-29: re-sync leaves the retired row out_of_stock");
        assertEq(catRows("p-cat-r").filter((x: any) => x.availability === "in_stock").map((x: any) => x.name_norm), ["gårdsost"],
          "p-cat-30: exactly one listable row after merge + re-sync");

        // ── Agent without catalog rows ──
        // Inserted after every sync above -> this agent has no catalog rows at all.
        insertAgent.run("p-nocat", "Uten Katalog AS", NORMAL_DESC, "k-p-nocat", null, "[]");
        insertKnowledge.run("p-nocat", JSON.stringify([{ name: "Økologisk mel", price: "40" }]), "[]", "[]", "{}");
        assertEq(catRows("p-nocat").length, 0, "p-cat-30b: fixture has no catalog rows");
        r = await post({ reason: REASON, items: [{ agent_id: "p-nocat", field: "product_name", old_name: "Økologisk mel", text: "Mel" }] }, apply);
        assertEq(res(r.body, "p-nocat")?.outcome, "written", "p-cat-31: rename works without catalog rows");
        assertEq(res(r.body, "p-nocat")?.catalog?.action, "none", "p-cat-32: catalog effect none");
        assertEq(productsOf("p-nocat")[0]?.name, "Mel", "p-cat-33: knowledge renamed");

        // ── products_organic_flag ──
        r = await post({ reason: REASON, items: [{ agent_id: "p-main", field: "products_organic_flag" }] }, apply);
        assertEq(res(r.body, "p-main")?.outcome, "written", "p-42: organic flag written");
        const org = productsOf("p-main");
        assertEq(org.map((p: any) => p.organic), [false, false, false], "p-43: every truthy organic -> false");
        assertEq(org[0].price, "275/kg", "p-44: other product fields kept");
        r = await post({ reason: REASON, items: [{ agent_id: "p-main", field: "products_organic_flag" }, { agent_id: "p-noorganic", field: "products_organic_flag" }] }, apply);
        assertEq(r.body?.counts?.skipped_unchanged, 2, "p-45: nothing truthy -> skipped_unchanged");
        assertEq(auditFor("p-noorganic").length, 0, "p-46: …with no audit row");

        // ── List removal ──
        r = await post({
          reason: REASON,
          items: [
            { agent_id: "p-main", field: "specialties", remove: ["Gårdsost", "Finnes ikke"] },
            { agent_id: "p-main", field: "certifications", remove: ["Debio"] },
            { agent_id: "p-main", field: "tags", remove: ["økologisk"] },
          ],
        }, apply);
        assertEq(res(r.body, "p-main", "specialties")?.outcome, "written", "p-47: specialties removal written");
        assertEq(res(r.body, "p-main", "specialties")?.removed, ["Gårdsost"], "p-48: removed element reported");
        assertEq(res(r.body, "p-main", "specialties")?.not_found_elements, ["Finnes ikke"], "p-49: absent element reported, not an error");
        assertEq(kRow("p-main").specialties, JSON.stringify(["Økologiske grønnsaker", "Lam"]), "p-50: specialties stored as JSON array, order kept");
        assertEq(kRow("p-main").certifications, JSON.stringify(["Nyt Norge"]), "p-51: certifications removal");
        assertEq(tagsOf("p-main"), JSON.stringify(["lam", "org_nr:123456789"]), "p-52: agents.tags removal");
        const lastAudits = auditFor("p-main").slice(-3);
        assertEq(lastAudits.map((x: any) => x.field_name), ["specialties", "certifications", "tags"], "p-53: one audit row per list field, field_name = list name");
        assertEq(lastAudits[2]?.old_value, TAGS, "p-54: tags audit keeps the full old JSON");
        const auditN = auditFor("p-main").length;
        r = await post({ reason: REASON, items: [{ agent_id: "p-main", field: "tags", remove: ["økologisk", "nope"] }] }, apply);
        assertEq(res(r.body, "p-main")?.outcome, "skipped_unchanged", "p-55: nothing to remove -> skipped_unchanged");
        assertEq(res(r.body, "p-main")?.not_found_elements, ["økologisk", "nope"], "p-56: …with every element listed as not found");
        assertEq(auditFor("p-main").length, auditN, "p-57: …and no audit row");

        // ── Exact-equality list removal: "Lam" must not take "Lammekjøtt" ──
        r = await post({ reason: REASON, items: [{ agent_id: "p-lamlist", field: "specialties", remove: ["Lam"] }] }, apply);
        assertEq(res(r.body, "p-lamlist")?.removed, ["Lam"], "p-59: exact element removed");
        assertEq(kRow("p-lamlist").specialties, JSON.stringify(["Lammekjøtt"]), "p-60: \"Lammekjøtt\" kept (exact match, not substring)");

        // ── Enrichment write-pause gate fails closed for new fields too ──
        setEnrichmentWritePause(db as any, { vertical: "rfb", enabled: true, reason: "test-pause" }, "test-actor");
        r = await post({ reason: REASON, items: [{ agent_id: "p-noorganic", field: "tags", remove: ["x"] }] });
        assertTrue(r.status >= 400, "p-58: write-pause blocks a dry-run of a list item");
        setEnrichmentWritePause(db as any, { vertical: "rfb", enabled: false, cleared_by: "test-actor" }, "test-actor");
      } finally {
        try { require("./admin-agents-content-correction").__setContentCorrectionDbForTesting(null); } catch { /* ignore */ }
        try { db.close(); } catch { /* ignore */ }
      }
    }

    if (setKeyOurselves) delete process.env.ADMIN_KEY;
    return { passed, failed, failures };
  })();
}
