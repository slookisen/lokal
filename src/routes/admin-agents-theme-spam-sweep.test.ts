/**
 * admin-agents-theme-spam-sweep.test.ts — tests for
 * POST /admin/agents/theme-spam-sweep (dev-request 2026-09-16-kaprede-
 * produsentdomener-kasino-spam-i-beskrivelser).
 *
 * Setup mirrors the code-artifact sweep sibling exactly: better-sqlite3
 * ":memory:" + __initSchemaForTesting, route pointed at that DB through its
 * OWN seam (__setThemeSpamSweepDbForTesting). Mutates NO shared global.
 * Handler driven through router.handle() with a fake req/res — no HTTP.
 *
 * Fixtures are the four EXACT live agent_knowledge.about values found in
 * production 2026-09-16 (Mølleren Sylvia, Mosbøen Gård, Valdres Vilt, Halås
 * Gårdsutsalg) plus lock/edge rows.
 *
 * Covers:
 *   (a) auth gate
 *   (b) dry-run by default writes NOTHING, classifies (would_write /
 *       would_clear) and carries a truncated preview
 *   (c) apply cleans about -> NULL / description -> '' AND drops the hijacked
 *       source (website -> NULL, url -> ''), one audit row per column with
 *       the full OLD value
 *   (d) contact e-mail on the hijacked host is REPORTED, never written
 *   (e) claimed_at lock, (f) verified agent_claims lock (pending does NOT
 *       lock), (g) curated 'about' lock — and a curated text field means the
 *       website is left alone too, (h) curated 'website' lock alone: text is
 *       cleaned, website kept
 *   (i) row without agent_knowledge is still writable (LEFT JOIN)
 *   (j) clean / empty rows are never candidates
 *   (k) idempotence: a re-run finds nothing left to do
 *   (l) enrichment-write-pause: 423 + zero writes while paused, normal after
 */
import Database from "better-sqlite3";
import * as initMod from "../database/init";
import { setEnrichmentWritePause } from "../services/enrichment-write-pause";

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

const SPAM_SYLVIA =
  "Se vår guide til beste casino på nett i 2026: bonuser, spilltilbud, betalingsmetoder og sikkerhet. Vi hjelper deg å finne riktig nettcasino.";
const SPAM_MOSBOEN =
  "Casino med Paysafecard lar deg gjøre trygge innskudd uten kort, få umiddelbare bonuser og raske BankID-uttak hos lisensierte norske nettcasinoer.";
const SPAM_VALDRES =
  "Hvorfor free spins er nøkkelen til de beste casinoer Når norske spillere leter etter de beste casinoer på nett, er antallet free spins som tilbys avgjørende.";
const SPAM_HALAAS =
  "Ginja Casino i Norge tilbyr et profesjonelt nettcasino med mange spill, raske betalinger, kampanjer, live casino og trygg innlogging for norske spillere.";
const NORMAL_ABOUT = "Familiedrevet gård i Follo. Vi dyrker kålrot, hodekål og poteter og har selvbetjent gårdsutsalg.";

export async function runAdminAgentsThemeSpamSweepTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log !== false;
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

  const ambientKey = process.env.ADMIN_KEY || process.env.ANALYTICS_ADMIN_KEY || "";
  const setKeyOurselves = ambientKey === "";
  if (setKeyOurselves) process.env.ADMIN_KEY = "theme-spam-sweep-standalone-key";
  const testKey = process.env.ADMIN_KEY as string;

  function seed(db: any) {
    initMod.__initSchemaForTesting(db as any);
    const insertAgent = db.prepare(
      `INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, vertical_id, claimed_at)
       VALUES (?, ?, ?, 'test', ?, ?, 'producer', ?, 'rfb', ?)`,
    );
    const insertKnowledge = db.prepare(
      `INSERT INTO agent_knowledge (agent_id, curated_fields, about, website, email) VALUES (?, ?, ?, ?, ?)`,
    );
    const insertClaim = db.prepare(
      `INSERT INTO agent_claims (id, agent_id, claimant_name, claimant_email, status)
       VALUES (?, ?, 'Test Claimant', 'claimant@example.no', ?)`,
    );
    // (id, name, description, contact_email, url, api_key, claimed_at)
    insertAgent.run("ts-sylvia", "Mølleren Sylvia", "", "landhandel@mollerensylvia.no", "", "k-sylvia", null);
    insertKnowledge.run("ts-sylvia", "{}", SPAM_SYLVIA, "https://www.mollerensylvia.no/", null);
    insertAgent.run("ts-desc", "Mosbøen Gård", SPAM_MOSBOEN, "post@example.no", "https://mosboengaard.no", "k-desc", null);
    insertKnowledge.run("ts-desc", "{}", null, null, "post@mosboengaard.no");
    insertAgent.run("ts-both", "Valdres Vilt", SPAM_VALDRES, "post@valdresvilt.no", "https://valdresvilt.com/", "k-both", null);
    insertKnowledge.run("ts-both", "{}", SPAM_VALDRES, "https://valdresvilt.com/", null);
    insertAgent.run("ts-claimed", "Claimet Gård", "", "eier@claimet.no", "", "k-claimed", "2026-01-01T00:00:00.000Z");
    insertKnowledge.run("ts-claimed", "{}", SPAM_HALAAS, "https://halaas-gardsutsalg.com", null);
    insertAgent.run("ts-verified-claim", "Verifisert Eier", "", "eier@verifisert.no", "", "k-vclaim", null);
    insertKnowledge.run("ts-verified-claim", "{}", SPAM_HALAAS, "https://verifisert.no", null);
    insertClaim.run("claim-ts-verified", "ts-verified-claim", "verified");
    insertAgent.run("ts-pending-claim", "Pending Eier", "", "eier@pending.no", "", "k-pclaim", null);
    insertKnowledge.run("ts-pending-claim", "{}", SPAM_HALAAS, "https://pending.no", null);
    insertClaim.run("claim-ts-pending", "ts-pending-claim", "pending");
    insertAgent.run("ts-curated-about", "Kuratert Om", "", "post@kuratert.no", "", "k-cabout", null);
    insertKnowledge.run("ts-curated-about", JSON.stringify({ about: { by: "owner" } }), SPAM_HALAAS, "https://kuratert.no", null);
    insertAgent.run("ts-curated-website", "Kuratert Web", "", "post@kuratertweb.no", "", "k-cweb", null);
    insertKnowledge.run("ts-curated-website", JSON.stringify({ website: { by: "owner" } }), SPAM_HALAAS, "https://kuratertweb.no", null);
    insertAgent.run("ts-no-knowledge", "Uten Kunnskap", SPAM_MOSBOEN, "post@utenk.no", "https://utenk.no", "k-nokn", null);
    insertAgent.run("ts-clean", "Follo Grønt", "Familiedrevet gård.", "post@follogront.no", "https://www.follogront.no/", "k-clean", null);
    insertKnowledge.run("ts-clean", "{}", NORMAL_ABOUT, "https://www.follogront.no/", null);
    insertAgent.run("ts-empty", "Tom Profil", "", "", "", "k-empty", null);
    insertKnowledge.run("ts-empty", "{}", null, null, null);
  }

  function loadRouter(db: any) {
    delete require.cache[require.resolve("./admin-agents-theme-spam-sweep")];
    const routeMod = require("./admin-agents-theme-spam-sweep");
    routeMod.__setThemeSpamSweepDbForTesting(db as any);
    return { router: routeMod.default, routeMod };
  }

  return (async () => {
    // ─── Section A–C: main behaviour on one isolated DB ─────────────────────
    {
      const db = new Database(":memory:");
      try {
        seed(db);
        const { router } = loadRouter(db);
        function post(body: any, key: string | false = testKey, query?: Record<string, string>): Promise<RouteResult> {
          const headers: Record<string, string> = {};
          if (key !== false) headers["x-admin-key"] = key;
          return callRoute(router, { method: "POST", url: "/", headers, body, query });
        }
        const APPLY = { apply: "1" };
        const agentRow = (id: string) =>
          db.prepare(`SELECT description, url, contact_email FROM agents WHERE id = ?`).get(id) as
            | { description: string; url: string; contact_email: string | null }
            | undefined;
        const knowledgeRow = (id: string) =>
          db.prepare(`SELECT about, website, email FROM agent_knowledge WHERE agent_id = ?`).get(id) as
            | { about: string | null; website: string | null; email: string | null }
            | undefined;
        const auditFor = (id: string) =>
          db
            .prepare(`SELECT field_name, old_value, new_value, changed_by, notes FROM agent_knowledge_audit WHERE agent_id = ? ORDER BY field_name`)
            .all(id) as Array<{ field_name: string; old_value: string | null; new_value: string | null; changed_by: string; notes: string | null }>;
        const resultFor = (body: any, id: string): any => (body?.results ?? []).find((r: any) => r.agent_id === id);

        // (a) auth
        let r = await post({}, false);
        assertEq(r.status, 403, "ts-01: missing X-Admin-Key -> 403");
        r = await post({}, "wrong-key");
        assertEq(r.status, 403, "ts-02: wrong X-Admin-Key -> 403");

        // (b) dry-run
        r = await post({});
        assertEq(r.status, 200, "ts-03: dry-run -> 200");
        assertEq(r.body?.dry_run, true, "ts-04: dry-run by default");
        assertEq(r.body?.scanned, 11, "ts-05: scanned = every agents row");
        assertEq(r.body?.candidates_considered, 9, "ts-06: candidates = the 9 rows whose description/about reads as theme spam");
        assertEq(resultFor(r.body, "ts-sylvia")?.outcome, "would_write", "ts-07: dry-run classifies the Sylvia row as would_write");
        assertEq(resultFor(r.body, "ts-sylvia")?.fields, { about: "would_write" }, "ts-08: ...on the about field only");
        assertEq(resultFor(r.body, "ts-sylvia")?.website, "would_clear", "ts-09: ...and would drop the hijacked website");
        assertEq(resultFor(r.body, "ts-sylvia")?.url, "none", "ts-10: ...url is empty, so nothing to clear there");
        assertEq(resultFor(r.body, "ts-sylvia")?.warnings, ["contact_email_on_hijacked_host:landhandel@mollerensylvia.no"], "ts-11: (d) contact e-mail on the hijacked host is reported as a warning");
        assertTrue(
          typeof resultFor(r.body, "ts-sylvia")?.old_value_preview === "string" &&
            resultFor(r.body, "ts-sylvia").old_value_preview.length <= 81 &&
            resultFor(r.body, "ts-sylvia").old_value_preview.length < SPAM_SYLVIA.length,
          "ts-12: dry-run carries a truncated preview, never the full old value",
        );
        assertEq(resultFor(r.body, "ts-both")?.fields, { description: "would_write", about: "would_write" }, "ts-13: both text fields classified when both read as spam");
        assertEq(resultFor(r.body, "ts-desc")?.fields, { description: "would_write" }, "ts-14: description-only spam row");
        assertEq(resultFor(r.body, "ts-desc")?.url, "would_clear", "ts-15: ...its agents.url is the hijacked source -> would_clear");
        assertEq(resultFor(r.body, "ts-desc")?.warnings, ["contact_email_on_hijacked_host:post@mosboengaard.no"], "ts-16: knowledge.email on the hijacked host is also reported");
        assertEq(resultFor(r.body, "ts-claimed")?.outcome, "skipped_claimed", "ts-17: (e) claimed_at row -> skipped_claimed in dry-run too");
        assertEq(resultFor(r.body, "ts-claimed")?.website, "none", "ts-18: ...and its website is not even proposed for clearing");
        assertEq(resultFor(r.body, "ts-curated-about")?.outcome, "skipped_curated", "ts-19: (g) curated about -> skipped_curated");
        assertEq(resultFor(r.body, "ts-curated-website")?.outcome, "would_write", "ts-20: (h) curated website only -> text still would_write");
        assertEq(resultFor(r.body, "ts-curated-website")?.website, "skipped_curated", "ts-21: ...but the website is kept");
        assertEq(resultFor(r.body, "ts-clean"), undefined, "ts-22: (j) a normal about/description is never a candidate");
        assertEq(resultFor(r.body, "ts-empty"), undefined, "ts-23: (j) an empty row is never a candidate");
        assertEq(knowledgeRow("ts-sylvia")?.about, SPAM_SYLVIA, "ts-24: dry-run left about untouched");
        assertEq(knowledgeRow("ts-sylvia")?.website, "https://www.mollerensylvia.no/", "ts-25: dry-run left website untouched");
        assertEq(auditFor("ts-sylvia").length, 0, "ts-26: dry-run wrote no audit row");

        // (c) apply
        r = await post({ reason: "test-sweep" }, testKey, APPLY);
        assertEq(r.body?.dry_run, false, "ts-27: apply=1 turns off dry-run");
        assertEq(resultFor(r.body, "ts-sylvia")?.outcome, "written", "ts-28: apply reports written");
        assertEq(knowledgeRow("ts-sylvia")?.about, null, "ts-29: about cleared to NULL");
        assertEq(knowledgeRow("ts-sylvia")?.website, null, "ts-30: hijacked website cleared to NULL");
        assertEq(agentRow("ts-sylvia")?.contact_email, "landhandel@mollerensylvia.no", "ts-31: contact e-mail NOT written (warning only)");
        const auditS = auditFor("ts-sylvia");
        assertEq(auditS.map((a) => a.field_name), ["about", "website"], "ts-32: one audit row per changed column (about + website)");
        assertEq(auditS[0]?.old_value, SPAM_SYLVIA, "ts-33: audit preserves the FULL old about (reversible)");
        assertEq(auditS[0]?.new_value, null, "ts-34: audit new_value NULL for about");
        assertEq(auditS[1]?.old_value, "https://www.mollerensylvia.no/", "ts-35: audit preserves the old website");
        assertEq(auditS[0]?.changed_by, "system", "ts-36: audit changed_by=system");
        assertTrue((auditS[0]?.notes ?? "").includes("test-sweep"), "ts-37: audit notes carry the caller's reason");
        assertTrue((auditS[1]?.notes ?? "").includes("hijacked source"), "ts-38: website audit note says why it was dropped");
        assertEq(agentRow("ts-desc")?.description, "", "ts-39: description cleared to '' (TEXT NOT NULL)");
        assertEq(agentRow("ts-desc")?.url, "", "ts-40: hijacked agents.url cleared to '' (TEXT NOT NULL)");
        assertEq(auditFor("ts-desc").map((a) => a.field_name), ["description", "url"], "ts-41: audit rows for description + url");
        assertEq(resultFor(r.body, "ts-both")?.fields, { description: "written", about: "written" }, "ts-42: both text fields written");
        assertEq(agentRow("ts-both")?.description, "", "ts-43: ...description ''");
        assertEq(knowledgeRow("ts-both")?.about, null, "ts-44: ...about NULL");
        assertEq(knowledgeRow("ts-both")?.website, null, "ts-45: ...website NULL");
        assertEq(agentRow("ts-both")?.url, "", "ts-46: ...url ''");
        assertEq(auditFor("ts-both").length, 4, "ts-47: four audit rows (description, about, website, url)");
        // (e)/(f) locks
        assertEq(resultFor(r.body, "ts-claimed")?.outcome, "skipped_claimed", "ts-48: claimed_at row skipped on apply");
        assertEq(knowledgeRow("ts-claimed")?.about, SPAM_HALAAS, "ts-49: claimed row untouched");
        assertEq(knowledgeRow("ts-claimed")?.website, "https://halaas-gardsutsalg.com", "ts-50: claimed row's website untouched");
        assertEq(auditFor("ts-claimed").length, 0, "ts-51: claimed row wrote no audit");
        assertEq(resultFor(r.body, "ts-verified-claim")?.outcome, "skipped_claimed", "ts-52: verified agent_claims row locks even with claimed_at NULL");
        assertEq(knowledgeRow("ts-verified-claim")?.about, SPAM_HALAAS, "ts-53: owner-verified row untouched");
        assertEq(resultFor(r.body, "ts-pending-claim")?.outcome, "written", "ts-54: a pending claim does NOT lock the row");
        assertEq(knowledgeRow("ts-pending-claim")?.about, null, "ts-55: pending-claim row cleaned");
        // (g)/(h) curated
        assertEq(resultFor(r.body, "ts-curated-about")?.outcome, "skipped_curated", "ts-56: curated about skipped");
        assertEq(knowledgeRow("ts-curated-about")?.about, SPAM_HALAAS, "ts-57: curated about untouched");
        assertEq(knowledgeRow("ts-curated-about")?.website, "https://kuratert.no", "ts-58: no text written -> website left alone");
        assertEq(resultFor(r.body, "ts-curated-website")?.outcome, "written", "ts-59: curated website, uncurated about -> about written");
        assertEq(knowledgeRow("ts-curated-website")?.about, null, "ts-60: ...about NULL");
        assertEq(resultFor(r.body, "ts-curated-website")?.website, "skipped_curated", "ts-61: ...website reported skipped_curated");
        assertEq(knowledgeRow("ts-curated-website")?.website, "https://kuratertweb.no", "ts-62: ...website kept");
        // (i) LEFT JOIN
        assertEq(resultFor(r.body, "ts-no-knowledge")?.outcome, "written", "ts-63: row without agent_knowledge is still writable");
        assertEq(agentRow("ts-no-knowledge")?.description, "", "ts-64: ...description cleaned");
        assertEq(agentRow("ts-no-knowledge")?.url, "", "ts-65: ...url cleared");
        // clean rows untouched
        assertEq(knowledgeRow("ts-clean")?.about, NORMAL_ABOUT, "ts-66: normal about untouched");
        assertEq(knowledgeRow("ts-clean")?.website, "https://www.follogront.no/", "ts-67: normal website untouched");
        assertEq(typeof r.body?.counts?.written, "number", "ts-68: response carries outcome counts");
        assertEq(r.body?.source_counts?.["website:cleared"], 3, "ts-69: source_counts tallies cleared websites (sylvia, both, pending)");

        // (k) idempotence
        r = await post({});
        assertEq(resultFor(r.body, "ts-sylvia"), undefined, "ts-70: a re-run no longer lists the cleaned row");
        assertEq(resultFor(r.body, "ts-both"), undefined, "ts-71: same for the both-fields row");
        assertEq(resultFor(r.body, "ts-no-knowledge"), undefined, "ts-72: same for the LEFT JOIN row");
        assertEq(resultFor(r.body, "ts-claimed")?.outcome, "skipped_claimed", "ts-73: the still-locked claimed row keeps showing up (nothing wrote it)");
        assertEq(r.body?.candidates_considered, 3, "ts-74: only the three locked rows remain candidates");
      } finally {
        try {
          require("./admin-agents-theme-spam-sweep").__setThemeSpamSweepDbForTesting(null);
        } catch {
          /* ignore */
        }
        try {
          db.close();
        } catch {
          /* ignore */
        }
      }
    }

    // ─── Section D: enrichment-write-pause wiring (own isolated DB) ─────────
    {
      const db = new Database(":memory:");
      try {
        seed(db);
        const { router } = loadRouter(db);
        function post(body: any, query?: Record<string, string>): Promise<RouteResult> {
          return callRoute(router, { method: "POST", url: "/", headers: { "x-admin-key": testKey }, body, query });
        }
        setEnrichmentWritePause(db as any, { vertical: "rfb", enabled: true, reason: "test-pause" }, "test-actor");
        let r = await post({ reason: "paused-apply" }, { apply: "1" });
        assertEq(r.status, 423, "ts-75: (l) live rfb pause -> 423 on apply");
        assertEq(r.body?.paused, true, "ts-76: ...body says paused");
        r = await post({});
        assertEq(r.status, 423, "ts-77: ...dry-run is blocked too (gate runs unconditionally)");
        const about = db.prepare(`SELECT about FROM agent_knowledge WHERE agent_id = 'ts-sylvia'`).get() as { about: string | null };
        assertEq(about?.about, SPAM_SYLVIA, "ts-78: ZERO writes while paused");
        assertEq((db.prepare(`SELECT COUNT(*) AS c FROM agent_knowledge_audit`).get() as { c: number }).c, 0, "ts-79: no audit rows while paused");
        setEnrichmentWritePause(db as any, { vertical: "rfb", enabled: false, cleared_by: "test-actor" }, "test-actor");
        r = await post({ reason: "after-clear" }, { apply: "1" });
        assertEq(r.status, 200, "ts-80: clearing the pause restores normal behaviour");
        const after = db.prepare(`SELECT about FROM agent_knowledge WHERE agent_id = 'ts-sylvia'`).get() as { about: string | null };
        assertEq(after?.about, null, "ts-81: ...and the row is cleaned");
      } finally {
        try {
          require("./admin-agents-theme-spam-sweep").__setThemeSpamSweepDbForTesting(null);
        } catch {
          /* ignore */
        }
        try {
          db.close();
        } catch {
          /* ignore */
        }
      }
    }

    if (setKeyOurselves) delete process.env.ADMIN_KEY;
    return { passed, failed, failures };
  })();
}
