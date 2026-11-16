/**
 * rfb-enrichment-cx-knowledge-gap.test.ts — dev-request
 * 2026-11-15-rfb-nattjobb-hull-kontaktuttrekk-bm-og-koer, slice B1 step 2:
 * the nightly enrichment job's contact_extraction step also takes cohort rows
 * whose agents.contact_email is set and NOT DNS-dead but whose
 * agent_knowledge.email is empty (B1-1's contact_email_not_in_knowledge).
 * For such a row the address on file is copied to agent_knowledge.email ONLY
 * when it is seen on the producer's own site (the route's
 * backfill_from_contact_email mode, opt-in `knowledge_gap`); when the site
 * was read and the address is not there, the normal scrape runs (knowledge
 * e-mail only — the existing contact_email is kept). Any other proof result
 * (fetch_failed, cooldown, host excluded, …) writes nothing and does not
 * scrape. Without the opt-in the route's cohorts are unchanged.
 *
 * Every block runs on a FRESH in-memory main DB with the full production
 * schema (__pinInMemoryDbForTesting, restored in finally). globalThis.fetch
 * is stubbed (site pages keyed on exact URL; the Anthropic contact judge
 * always approves) — no network, no real model call.
 *
 * Covers:
 *   s1 selection/preview: live / never-checked / unknown DNS rows selected on
 *      the new path; a DNS-dead row is still selected but on the old path;
 *      a blank-contact row stays on the old path; a row with k.email set, a
 *      non-answering site, an unprobed site or no website is not selected;
 *      the preview writes nothing
 *   s2 rfbCxRowTakesKnowledgeGapPath unit cases
 *   e1 found on own site (live DNS) → backfilled_from_contact_email, k.email
 *      written with harvest_contact_email provenance + the page; no scrape,
 *      no model call, contact_email untouched
 *   e2 never-checked DNS, found → written
 *   e3 not on site, another own-domain address there → scrape fallback
 *      writes k.email only (rfb_contact_extraction provenance); the old
 *      contact_email and the audit trail are untouched
 *   e4 not on site, nothing on the page → no write
 *   e5 not on site, only a foreign-domain address → wrong_entity, no write
 *   e6 fetch_failed → no write, no scrape fallback (one fetch only)
 *   e7 a DNS-dead row through the executor → the old path, unchanged
 *   r1 default route callers (no opt-in): never-checked DNS row rejected
 *      from the backfill cohort, gap row rejected from the scrape cohort;
 *      knowledge_gap without agentIds → 400; knowledge_gap never takes a
 *      DNS-dead row; a knowledge_gap dry run writes nothing
 *   n1 a full apply run (only contact_extraction capped on): eligible > 0
 *      (AK2), the outcomes are observable in the step report, attempts
 *      are stamped
 *   n1 (review B1) the run-ledger claim's rejected_reasons lists only true
 *      rejections (both new write outcomes count as written; sum == rejected)
 *   t1 (review N1a) a scrape fallback answering cooldown_skipped stays
 *      transient (not stamped); one answering 409 run_in_progress stops
 *   t2 (review N3) past the run deadline / 08Z hour after the proof → the
 *      proof outcome is recorded, the scrape is not started
 *   r1 (review N1b) a knowledge_gap scrape dry run writes nothing
 *   m1 (review N1c) a malformed field_provenance: taken by the gap path via
 *      the json_valid guard, the gap id set does not crash
 *   ak4 every agent_knowledge.email written in this suite is literally on
 *      the stubbed own-site page its provenance names
 *
 * Two ways to run:
 *   1. Standalone:  npx tsx src/services/rfb-enrichment-cx-knowledge-gap.test.ts
 *   2. Wired into the gate: tests/test.ts (runSerial — pins the DB singleton).
 */

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

const ENV_KEYS = [
  "RFB_ENRICHMENT_NIGHTLY_ENABLED",
  "RFB_ENRICHMENT_CAP_URL_CHECK",
  "RFB_ENRICHMENT_CAP_EMAIL_DOMAIN_WEBSITE",
  "RFB_ENRICHMENT_CAP_BRREG",
  "RFB_ENRICHMENT_CAP_BM_SLUGS",
  "RFB_ENRICHMENT_CAP_CONTACT_EXTRACTION",
  "RFB_ENRICHMENT_CAP_CONTENT",
  "RFB_ENRICHMENT_CAP_REVERIFY",
  "RFB_ENRICHMENT_LLM_CAP",
  "RFB_ENRICHMENT_CLAIM_PRIORITY_ENABLED",
  "OWNER_AUTO_UPDATES_ENABLED",
  "ANTHROPIC_API_KEY",
] as const;

function htmlResponse(html: string, finalUrl: string): Response {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    url: finalUrl,
    headers: { get: (n: string) => (n.toLowerCase() === "content-type" ? "text/html; charset=utf-8" : null) },
    arrayBuffer: async () => new TextEncoder().encode(html).buffer,
  } as unknown as Response;
}

function notFoundResponse(): Response {
  return {
    ok: false,
    status: 404,
    statusText: "Not Found",
    url: undefined,
    headers: { get: () => null },
    arrayBuffer: async () => new ArrayBuffer(0),
  } as unknown as Response;
}

export async function runRfbEnrichmentCxKnowledgeGapTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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

  try {
    (require("../config/vertical-config") as typeof import("../config/vertical-config")).loadConfigsAtBoot();
  } catch {
    // already loaded by an earlier suite in this process
  }
  const initMod = require("../database/init") as typeof import("../database/init");
  const job = require("./rfb-enrichment-nightly") as typeof import("./rfb-enrichment-nightly");
  const cxRoute = require("../routes/admin-rfb-contact-extraction") as typeof import("../routes/admin-rfb-contact-extraction");

  const prevEnv: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) prevEnv[k] = process.env[k];
  const prevAdminKey = process.env.ADMIN_KEY;
  const testKey = process.env.ADMIN_KEY || "rfb-cx-knowledge-gap-test-key";
  process.env.ADMIN_KEY = testKey;
  const prevFetch = globalThis.fetch;

  function setEnv(values: Record<string, string>): void {
    for (const k of ENV_KEYS) delete process.env[k];
    for (const [k, v] of Object.entries(values)) process.env[k] = v;
  }

  // Site fixtures (exact URL → html), fetch log, model-call count.
  const pages = new Map<string, string>();
  const fetched: string[] = [];
  let modelCalls = 0;
  function stubFetch(): typeof fetch {
    return (async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes("api.anthropic.com")) {
        modelCalls++;
        return {
          ok: true,
          status: 200,
          json: async () => ({ content: [{ type: "text", text: "GODKJENN\nEkte kontaktinfo for produsenten." }] }),
        } as any;
      }
      fetched.push(u);
      const html = pages.get(u);
      return html === undefined ? notFoundResponse() : htmlResponse(html, u);
    }) as typeof fetch;
  }

  let db: any = null;
  async function withDb(label: string, fn: () => Promise<void>): Promise<void> {
    const restore = initMod.__pinInMemoryDbForTesting();
    db = initMod.getDb();
    pages.clear();
    fetched.length = 0;
    modelCalls = 0;
    globalThis.fetch = stubFetch();
    cxRoute.__setRfbCxRowDelayForTesting(0);
    cxRoute.__resetRfbCxCooldownForTesting();
    try {
      await fn();
    } catch (err) {
      failed++;
      failures.push(`${label}: unexpected error: ${err instanceof Error ? err.stack || err.message : String(err)}`);
    } finally {
      globalThis.fetch = prevFetch;
      cxRoute.__setRfbCxRowDelayForTesting(null);
      restore();
      db = null;
    }
  }

  const dnsStamp = (live: unknown): string =>
    JSON.stringify({
      contact_email_dns_check: { checked_at: "2026-11-01T00:00:00Z", domain: "x.no", live, method: "mx", batch_id: "b" },
    });

  let seq = 0;
  /** A cohort producer. Default: contact post@<id>.no, k.email empty, website https://<id>.no answering 200, never DNS-checked. */
  function seedAgent(
    id: string,
    o: {
      contact_email?: string;
      website?: string;
      email?: string;
      field_provenance?: string;
      url_last_status?: number | null;
    } = {},
  ): void {
    seq += 1;
    db.prepare(
      `INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, created_at)
       VALUES (?, ?, 'test', 'test', ?, '', 'producer', ?, ?)`,
    ).run(id, `Gård ${id}`, o.contact_email ?? `post@${id}.no`, `key-${id}`, `2026-01-01 00:00:${String(seq % 60).padStart(2, "0")}`);
    const status = o.url_last_status === undefined ? 200 : o.url_last_status;
    db.prepare(
      `INSERT INTO agent_knowledge (agent_id, verification_status, website, email, field_provenance, url_last_status, url_last_probed, curated_fields)
       VALUES (?, 'pending_verify', ?, ?, ?, ?, ?, '{}')`,
    ).run(
      id,
      o.website ?? `https://${id}.no`,
      o.email ?? "",
      o.field_provenance ?? "{}",
      status,
      status === null ? null : "2026-11-10T00:00:00Z",
    );
  }

  const kRow = (id: string) =>
    db.prepare(`SELECT a.contact_email AS contact_email, k.email AS k_email, k.field_provenance AS fp FROM agents a JOIN agent_knowledge k ON k.agent_id = a.id WHERE a.id = ?`).get(id) as {
      contact_email: string;
      k_email: string | null;
      fp: string | null;
    };
  const emailProv = (id: string): any[] => {
    const fp = kRow(id).fp;
    const parsed = fp ? JSON.parse(fp) : {};
    return Array.isArray(parsed.email) ? parsed.email : [];
  };
  const auditCount = (id: string): number =>
    (db.prepare(`SELECT COUNT(*) AS n FROM agent_knowledge_audit WHERE agent_id = ?`).get(id) as { n: number }).n;

  /** ak4: every k.email written must be literally on the page its provenance names (pages map = the fetched HTML). */
  function assertAk4(label: string): void {
    const rows = db.prepare(`SELECT agent_id, email, field_provenance FROM agent_knowledge WHERE TRIM(COALESCE(email,'')) != ''`).all() as Array<{
      agent_id: string;
      email: string;
      field_provenance: string | null;
    }>;
    for (const r of rows) {
      const prov = (r.field_provenance ? JSON.parse(r.field_provenance).email : null) ?? [];
      const entry = Array.isArray(prov) ? prov.find((p: any) => p?.value === r.email) : null;
      const html = entry ? pages.get(entry.source_url) : undefined;
      const seen = html !== undefined && cxRoute.emailSeenOnPage(html, r.email) !== null;
      assertEq(seen, true, `ak4 (${label}): ${r.agent_id}'s k.email is on its own-site source page`);
    }
  }

  const NIGHT = new Date("2026-11-16T00:10:00Z");
  const execFor = () => job.createDefaultRfbEnrichmentExecutors(db, "test-batch");
  const cohortRow = async (id: string) => {
    const cohort = await job.loadRfbEnrichmentCohort(db, NIGHT.getTime());
    const r = cohort.rows.find((x) => x.id === id);
    if (!r) throw new Error(`row ${id} not in cohort`);
    return r;
  };

  try {
    // ── s1 selection / preview ───────────────────────────────────────────
    await withDb("s1", async () => {
      setEnv({});
      seedAgent("g-live", { field_provenance: dnsStamp(true) });
      seedAgent("g-never");
      seedAgent("g-unknown", { field_provenance: dnsStamp("maybe") });
      seedAgent("o-dead", { field_provenance: dnsStamp(false) });
      seedAgent("o-blank", { contact_email: "" });
      seedAgent("n-kemail", { email: "post@n-kemail.no", field_provenance: dnsStamp(true) });
      seedAgent("n-sitedead", { url_last_status: 404 });
      seedAgent("n-unprobed", { url_last_status: null });
      seedAgent("n-nosite", { website: "" });

      const before = JSON.stringify(db.prepare(`SELECT * FROM agent_knowledge ORDER BY agent_id`).all());
      const before2 = JSON.stringify(db.prepare(`SELECT id, contact_email FROM agents ORDER BY id`).all());
      const p = await job.buildRfbEnrichmentPreview(db, NIGHT);
      const cx = p.steps.find((s) => s.step === "contact_extraction")!;
      assertEq(
        [...cx.selected_ids].sort(),
        ["g-live", "g-never", "g-unknown", "o-blank", "o-dead"],
        "s1: live / never-checked / unknown DNS rows join the step; dead / blank rows stay; k.email, dead site, unprobed site, no site are out",
      );
      assertEq(cx.eligible, 5, "s1: eligible counts both paths");
      assertEq(cx.contact_email_not_in_knowledge, { eligible: 3, selected: 3 }, "s1: the preview shows the new-path rows (dead DNS is not among them)");
      assertEq(JSON.stringify(db.prepare(`SELECT * FROM agent_knowledge ORDER BY agent_id`).all()), before, "s1: the preview writes nothing (knowledge)");
      assertEq(JSON.stringify(db.prepare(`SELECT id, contact_email FROM agents ORDER BY id`).all()), before2, "s1: the preview writes nothing (agents)");
      assertEq(fetched.length + modelCalls, 0, "s1: the preview fetches nothing and calls no model");

      // Cap shared with the old path: cap 2 → 2 rows in total.
      process.env.RFB_ENRICHMENT_CAP_CONTACT_EXTRACTION = "2";
      const p2 = await job.buildRfbEnrichmentPreview(db, NIGHT);
      const cx2 = p2.steps.find((s) => s.step === "contact_extraction")!;
      assertEq([cx2.cap, cx2.selected, cx2.eligible], [2, 2, 5], "s1: the new rows share the step's cap (no new knob)");
      process.env.RFB_ENRICHMENT_CAP_CONTACT_EXTRACTION = "0";
      const p3 = await job.buildRfbEnrichmentPreview(db, NIGHT);
      assertEq(p3.steps.find((s) => s.step === "contact_extraction")!.selected, 0, "s1: rollback — cap 0 selects nothing");
    });

    // ── s2 path predicate ──────────────────────────────────────────────────
    {
      const f = job.rfbCxRowTakesKnowledgeGapPath;
      assertEq(f({ contact_email: "a@b.no", k_email: "", field_provenance: null }), true, "s2: never checked → new path");
      assertEq(f({ contact_email: "a@b.no", k_email: null, field_provenance: dnsStamp(true) }), true, "s2: live → new path");
      assertEq(f({ contact_email: "a@b.no", k_email: "", field_provenance: dnsStamp("x") }), true, "s2: unknown → new path");
      assertEq(f({ contact_email: "a@b.no", k_email: "", field_provenance: dnsStamp(false) }), false, "s2: dead → old path");
      assertEq(f({ contact_email: "  ", k_email: "", field_provenance: null }), false, "s2: blank contact → old path");
      assertEq(f({ contact_email: "a@b.no", k_email: "c@b.no", field_provenance: null }), false, "s2: k.email set → not this path");
    }

    // ── e1–e7 executor through the real in-process route ──────────────────
    await withDb("e", async () => {
      setEnv({ ANTHROPIC_API_KEY: "test-key-never-real" });
      const exec = execFor();

      // e1: live DNS, address on the front page.
      seedAgent("e1", { field_provenance: dnsStamp(true) });
      pages.set("https://e1.no", `<html><body>Ring oss eller skriv til <a href="mailto:post@e1.no">post@e1.no</a></body></html>`);
      const o1 = await exec.contactExtraction(await cohortRow("e1"));
      assertEq([o1.outcome, o1.written, o1.changed, o1.knowledge_gap], ["backfilled_from_contact_email", true, true, true], "e1: backfilled_from_contact_email");
      assertEq(kRow("e1").k_email, "post@e1.no", "e1: k.email written");
      assertEq(kRow("e1").contact_email, "post@e1.no", "e1: contact_email untouched");
      const p1 = emailProv("e1");
      assertEq([p1.length, p1[0]?.source_type, p1[0]?.source_url], [1, "harvest_contact_email", "https://e1.no"], "e1: provenance = harvest_contact_email + the page it was seen on");
      assertEq(modelCalls, 0, "e1: no model call (no scrape)");
      assertEq(auditCount("e1"), 0, "e1: no fabricated contact_email audit row");

      // e2: never-checked DNS, found on the page text.
      seedAgent("e2");
      pages.set("https://e2.no", `<html><body><p>E-post: post@e2.no</p></body></html>`);
      const o2 = await exec.contactExtraction(await cohortRow("e2"));
      assertEq([o2.outcome, kRow("e2").k_email], ["backfilled_from_contact_email", "post@e2.no"], "e2: never-checked DNS + seen on site → written");

      // e3: not on site; another own-domain address is → scrape fallback, knowledge e-mail only.
      seedAgent("e3", { contact_email: "gammel@e3.no", field_provenance: dnsStamp(true) });
      pages.set("https://e3.no", `<html><body><a href="mailto:kontakt@e3.no">Kontakt</a></body></html>`);
      fetched.length = 0;
      const o3 = await exec.contactExtraction(await cohortRow("e3"));
      assertEq([o3.outcome, o3.written, o3.knowledge_gap], ["scraped_after_not_on_site", true, true], "e3: scraped_after_not_on_site");
      assertEq(kRow("e3").k_email, "kontakt@e3.no", "e3: k.email = the scraped own-site address");
      assertEq(kRow("e3").contact_email, "gammel@e3.no", "e3: the existing non-dead contact_email is NOT replaced");
      assertEq(auditCount("e3"), 0, "e3: no contact_email audit row (column not written)");
      const p3 = emailProv("e3");
      assertEq([p3[0]?.source_type, p3[0]?.source_url], ["rfb_contact_extraction", "https://e3.no"], "e3: scrape provenance + page");
      assertEq(fetched.filter((u) => u === "https://e3.no").length, 2, "e3: the proof read the site, then the scrape read it again");

      // e4: not on site, nothing to scrape.
      seedAgent("e4", { field_provenance: dnsStamp(true) });
      pages.set("https://e4.no", `<html><body>Velkommen til gården.</body></html>`);
      const o4 = await exec.contactExtraction(await cohortRow("e4"));
      assertEq([o4.outcome, o4.written], ["rejected_not_on_site_then_no_contact_found", false], "e4: no address anywhere → no write");
      assertEq([kRow("e4").k_email, kRow("e4").contact_email], ["", "post@e4.no"], "e4: nothing written");

      // e5: not on site, only a foreign-domain address → never written.
      seedAgent("e5", { field_provenance: dnsStamp(true) });
      pages.set("https://e5.no", `<html><body>Levert av <a href="mailto:salg@annen-gard.no">salg@annen-gard.no</a></body></html>`);
      const o5 = await exec.contactExtraction(await cohortRow("e5"));
      assertEq([o5.outcome, o5.written, kRow("e5").k_email], ["rejected_not_on_site_then_wrong_entity_suspected", false, ""], "e5: foreign-domain candidate → wrong_entity, no write");

      // e6: fetch_failed → no write, no scrape.
      seedAgent("e6", { field_provenance: dnsStamp(true) }); // no fixture → 404
      fetched.length = 0;
      const callsBefore = modelCalls;
      const o6 = await exec.contactExtraction(await cohortRow("e6"));
      assertEq([o6.outcome, o6.written, o6.knowledge_gap], ["fetch_failed", false, true], "e6: fetch_failed recorded");
      assertEq(fetched.filter((u) => u.startsWith("https://e6.no")).length, 1, "e6: one fetch only — no scrape fallback");
      assertEq([kRow("e6").k_email, modelCalls - callsBefore], ["", 0], "e6: nothing written, no model call");

      // e7: DNS-dead row → the old path (replace-if-dead), unchanged.
      seedAgent("e7", { contact_email: "dod@e7.no", field_provenance: dnsStamp(false) });
      pages.set("https://e7.no", `<html><body><a href="mailto:ny@e7.no">Kontakt</a></body></html>`);
      const o7 = await exec.contactExtraction(await cohortRow("e7"));
      assertEq([o7.outcome, o7.knowledge_gap], ["written", undefined], "e7: dead DNS → old scrape path, plain 'written'");
      assertEq([kRow("e7").contact_email, kRow("e7").k_email], ["ny@e7.no", "ny@e7.no"], "e7: old behaviour — dead address replaced, k.email filled");

      assertAk4("e");
    });

    // ── r1 default route callers unchanged ─────────────────────────────────
    await withDb("r1", async () => {
      setEnv({ ANTHROPIC_API_KEY: "test-key-never-real" });
      const call = (body: Record<string, unknown>) =>
        job.callAdminRouterInProcess(cxRoute.default, { method: "POST", path: "/rfb-contact-extraction", body });
      seedAgent("r-never");
      seedAgent("r-dead", { field_provenance: dnsStamp(false) });
      pages.set("https://r-never.no", `<a href="mailto:post@r-never.no">x</a>`);

      const bf = await call({ mode: "backfill_from_contact_email", agentIds: ["r-never"], apply: true });
      assertEq(bf.body?.results?.[0]?.outcome, "not_found", "r1: default backfill cohort still rejects a never-DNS-checked row");
      const sc = await call({ agentIds: ["r-never"], apply: true });
      assertEq(sc.body?.results?.[0]?.outcome, "not_found", "r1: default scrape cohort still rejects a set, not-dead contact_email row");
      const noIds = await call({ mode: "backfill_from_contact_email", knowledge_gap: true, apply: true });
      assertEq(noIds.status, 400, "r1: knowledge_gap without agentIds → 400");
      const truthy = await call({ mode: "backfill_from_contact_email", knowledge_gap: "true", agentIds: ["r-never"], apply: true });
      assertEq(truthy.body?.results?.[0]?.outcome, "not_found", "r1: only knowledge_gap === true opts in");
      const dead = await call({ mode: "backfill_from_contact_email", knowledge_gap: true, agentIds: ["r-dead"], apply: true });
      assertEq(dead.body?.results?.[0]?.outcome, "not_found", "r1: knowledge_gap never takes a DNS-dead row");
      const dry = await call({ mode: "backfill_from_contact_email", knowledge_gap: true, agentIds: ["r-never"] });
      assertEq([dry.body?.dry_run, dry.body?.results?.[0]?.outcome, kRow("r-never").k_email], [true, "written", ""], "r1: knowledge_gap dry run reports would-write, writes nothing");
      assertEq(fetched.length > 0, true, "r1: (sanity) the opt-in call fetched the own site");
      // N1b: knowledge_gap scrape dry run (no mode, apply false) — would-write, writes nothing.
      seedAgent("r-scrape", { field_provenance: dnsStamp(true) });
      pages.set("https://r-scrape.no", `<a href="mailto:kontakt@r-scrape.no">Kontakt</a>`);
      const auditBefore = auditCount("r-scrape");
      const sdry = await call({ knowledge_gap: true, agentIds: ["r-scrape"], apply: false });
      assertEq(
        [sdry.body?.dry_run, sdry.body?.results?.[0]?.outcome, sdry.body?.results?.[0]?.email],
        [true, "written", "kontakt@r-scrape.no"],
        "r1 (N1b): knowledge_gap scrape dry run reports the would-write",
      );
      assertEq(
        [kRow("r-scrape").k_email, kRow("r-scrape").contact_email, auditCount("r-scrape") - auditBefore],
        ["", "post@r-scrape.no", 0],
        "r1 (N1b): knowledge_gap scrape dry run writes nothing (k.email, contact_email, audit)",
      );
    });

    // ── n1 a full apply run ────────────────────────────────────────────────
    await withDb("n1", async () => {
      setEnv({
        RFB_ENRICHMENT_NIGHTLY_ENABLED: "1",
        RFB_ENRICHMENT_CAP_URL_CHECK: "0",
        RFB_ENRICHMENT_CAP_EMAIL_DOMAIN_WEBSITE: "0",
        RFB_ENRICHMENT_CAP_BRREG: "0",
        RFB_ENRICHMENT_CAP_BM_SLUGS: "0",
        RFB_ENRICHMENT_CAP_CONTACT_EXTRACTION: "5",
        RFB_ENRICHMENT_CAP_CONTENT: "0",
        RFB_ENRICHMENT_CAP_REVERIFY: "0",
        RFB_ENRICHMENT_LLM_CAP: "5",
        ANTHROPIC_API_KEY: "test-key-never-real",
      });
      seedAgent("n-found", { field_provenance: dnsStamp(true) });
      pages.set("https://n-found.no", `<a href="mailto:post@n-found.no">Kontakt</a>`);
      seedAgent("n-scrape");
      pages.set("https://n-scrape.no", `<a href="mailto:hei@n-scrape.no">Kontakt</a>`);
      seedAgent("n-fail", { field_provenance: dnsStamp(true) });

      const r = await job.runRfbEnrichmentNightly({ apply: true, trigger: "manual", now: NIGHT });
      const st = r.steps.find((s) => s.step === "contact_extraction")!;
      assertEq([st.eligible > 0, st.eligible, st.selected, st.attempted, st.written], [true, 3, 3, 3, 2], "n1 (AK2): eligible > 0 — the new rows are taken");
      assertEq(
        st.extra?.contact_email_not_in_knowledge_outcomes,
        { backfilled_from_contact_email: 1, scraped_after_not_on_site: 1, fetch_failed: 1 },
        "n1: the new path's outcomes are tallied separately",
      );
      assertEq(st.extra?.contact_email_not_in_knowledge, { eligible: 3, selected: 3 }, "n1: selection counter in the step report");
      assertEq([kRow("n-found").k_email, kRow("n-scrape").k_email, kRow("n-fail").k_email], ["post@n-found.no", "hei@n-scrape.no", ""], "n1: writes");
      assertEq(kRow("n-scrape").contact_email, "post@n-scrape.no", "n1: scraped row keeps its contact_email");
      const stamped = db
        .prepare(`SELECT agent_id, last_outcome AS outcome FROM rfb_enrichment_nightly_attempts WHERE step = 'contact_extraction' ORDER BY agent_id`)
        .all() as Array<{ agent_id: string; outcome: string }>;
      assertEq(
        stamped.map((s) => `${s.agent_id}:${s.outcome}`),
        ["n-fail:fetch_failed", "n-found:backfilled_from_contact_email", "n-scrape:scraped_after_not_on_site"],
        "n1: every row stamped (retry window applies as for other rows)",
      );
      // Review B1: the run-ledger claim splits written vs rejected correctly.
      const env = db.prepare(`SELECT claims FROM runs WHERE agent = ?`).all(job.RFB_ENRICHMENT_NIGHTLY_AGENT) as Array<{ claims: string }>;
      const claims = JSON.parse(env[env.length - 1]?.claims ?? "[]");
      const cxClaim = claims.find((c: any) => c.meta?.kind === "rfb_enrichment_step_contact_extraction");
      assertEq(
        [cxClaim?.meta?.written, cxClaim?.meta?.rejected, cxClaim?.meta?.rejected_reasons],
        [2, 1, { fetch_failed: 1 }],
        "n1 (B1): rejected_reasons lists only the true rejection; both new write outcomes count as written",
      );
      const reasonSum = Object.values((cxClaim?.meta?.rejected_reasons ?? {}) as Record<string, number>).reduce((a, b) => a + b, 0);
      assertEq(reasonSum, cxClaim?.meta?.rejected, "n1 (B1): sum(rejected_reasons) == rejected");
      const p = await job.buildRfbEnrichmentPreview(db, NIGHT);
      assertEq(p.steps.find((s) => s.step === "contact_extraction")!.eligible, 0, "n1: after the run, the retry window / filled k.email keep the rows out");
      assertAk4("n1");
    });
    // ── t1 transient scrape answers (review N1a) ───────────────────────────
    await withDb("t1", async () => {
      setEnv({
        RFB_ENRICHMENT_NIGHTLY_ENABLED: "1",
        RFB_ENRICHMENT_CAP_URL_CHECK: "0",
        RFB_ENRICHMENT_CAP_EMAIL_DOMAIN_WEBSITE: "0",
        RFB_ENRICHMENT_CAP_BRREG: "0",
        RFB_ENRICHMENT_CAP_BM_SLUGS: "0",
        RFB_ENRICHMENT_CAP_CONTACT_EXTRACTION: "5",
        RFB_ENRICHMENT_CAP_CONTENT: "0",
        RFB_ENRICHMENT_CAP_REVERIFY: "0",
        RFB_ENRICHMENT_LLM_CAP: "5",
        ANTHROPIC_API_KEY: "test-key-never-real",
      });
      // The proof reads the front page and /kontakt (address not there), then
      // /om-oss answers 429 → the host is cooled down → the scrape's front
      // fetch is cooldown_skipped.
      seedAgent("t-cool", { field_provenance: dnsStamp(true) });
      pages.set("https://t-cool.no", `<a href="/kontakt">Kontakt</a> <a href="/om-oss">Om oss</a>`);
      pages.set("https://t-cool.no/kontakt", `<p>Ring oss.</p>`);
      const base = globalThis.fetch;
      globalThis.fetch = (async (url: any, init?: any) => {
        if (String(url) === "https://t-cool.no/om-oss") {
          fetched.push(String(url));
          return { ok: false, status: 429, statusText: "Too Many", url: undefined, headers: { get: () => null }, arrayBuffer: async () => new ArrayBuffer(0) } as any;
        }
        return base(url, init);
      }) as typeof fetch;
      const r = await job.runRfbEnrichmentNightly({ apply: true, trigger: "manual", now: NIGHT });
      const st = r.steps.find((s) => s.step === "contact_extraction")!;
      assertEq(st.outcomes, { cooldown_skipped: 1 }, "t1 (N1a): scrape cooldown keeps its transient code");
      const stamped = db.prepare(`SELECT COUNT(*) AS n FROM rfb_enrichment_nightly_attempts WHERE step = 'contact_extraction'`).get() as { n: number };
      assertEq(stamped.n, 0, "t1 (N1a): a cooldown_skipped scrape is not stamped — retried tomorrow");
      assertEq(kRow("t-cool").k_email, "", "t1: nothing written");
      globalThis.fetch = base;

      // The executor returns any transient scrape answer as is (with
      // knowledge_gap) — the same predicate then keeps it unstamped. (The
      // route's run-lock is not driven end-to-end here: under the full gate
      // another suite may have re-required the route module, so a lock set
      // from this file would land in a different module instance.)
      for (const t of [
        { outcome: "run_in_progress", written: false, changed: false, stop: "contact_extraction_run_in_progress", knowledge_gap: true },
        { outcome: "http_500", written: false, changed: false, error: true, knowledge_gap: true },
        { outcome: "cooldown_skipped", written: false, changed: false, knowledge_gap: true },
      ]) {
        assertEq(job.isTransientRfbEnrichmentOutcome(t), true, `t1 (N1a): a ${t.outcome} scrape answer is transient (never stamped)`);
      }
    });

    // ── t2 deadline / forbidden hour between proof and scrape (review N3) ──
    await withDb("t2", async () => {
      setEnv({ ANTHROPIC_API_KEY: "test-key-never-real" });
      seedAgent("t-late", { field_provenance: dnsStamp(true) });
      pages.set("https://t-late.no", `<a href="mailto:annen@t-late.no">x</a>`);
      fetched.length = 0;
      let asked = 0;
      const o = await execFor().contactExtraction(await cohortRow("t-late"), {
        stopBeforeSecondCall: () => {
          asked++;
          return "time_budget";
        },
      });
      assertEq([o.outcome, o.stop, o.written, asked], ["rejected_not_on_site", "time_budget", false, 1], "t2 (N3): past the deadline → proof outcome recorded, step stops");
      assertEq(fetched.filter((u) => u === "https://t-late.no").length, 1, "t2 (N3): the scrape is not started (one fetch only)");
      assertEq([kRow("t-late").k_email, modelCalls], ["", 0], "t2 (N3): nothing written, no model call");
      assertEq(job.isTransientRfbEnrichmentOutcome(o), true, "t2 (N3): not stamped — the row gets its scrape another night");
      // Not asked when the proof already decided (found → no second call).
      seedAgent("t-found", { field_provenance: dnsStamp(true) });
      pages.set("https://t-found.no", `<a href="mailto:post@t-found.no">x</a>`);
      let asked2 = 0;
      const o2 = await execFor().contactExtraction(await cohortRow("t-found"), { stopBeforeSecondCall: () => (asked2++, "time_budget") });
      assertEq([o2.outcome, asked2], ["backfilled_from_contact_email", 0], "t2 (N3): the check is only made before a second call");
    });

    // ── m1 malformed field_provenance (review N1c) ─────────────────────────
    await withDb("m1", async () => {
      setEnv({ ANTHROPIC_API_KEY: "test-key-never-real" });
      seedAgent("m-bad", { field_provenance: "not json {" });
      seedAgent("m-ok", { field_provenance: dnsStamp(true) });
      pages.set("https://m-bad.no", `<a href="mailto:post@m-bad.no">x</a>`);
      const p = await job.buildRfbEnrichmentPreview(db, NIGHT);
      const cx = p.steps.find((s) => s.step === "contact_extraction")!;
      assertEq([...cx.selected_ids].sort(), ["m-bad", "m-ok"], "m1 (N1c): the gap id set survives a malformed provenance and takes that row");
      assertEq(cx.contact_email_not_in_knowledge, { eligible: 2, selected: 2 }, "m1 (N1c): both on the gap path");
      assertEq(job.rfbCxRowTakesKnowledgeGapPath({ contact_email: "post@m-bad.no", k_email: "", field_provenance: "not json {" }), true, "m1: JS predicate agrees (unknown → gap path)");
      const o = await execFor().contactExtraction(await cohortRow("m-bad"));
      assertEq([o.outcome, kRow("m-bad").k_email], ["backfilled_from_contact_email", "post@m-bad.no"], "m1 (N1c): the route's knowledge_gap cohort takes it and the proof writes it");
      assertAk4("m1");
    });
  } finally {
    globalThis.fetch = prevFetch;
    for (const k of ENV_KEYS) {
      if (prevEnv[k] === undefined) delete process.env[k];
      else process.env[k] = prevEnv[k];
    }
    if (prevAdminKey === undefined) delete process.env.ADMIN_KEY;
    else process.env.ADMIN_KEY = prevAdminKey;
  }

  return { passed, failed, failures };
}

if (require.main === module) {
  runRfbEnrichmentCxKnowledgeGapTests({ log: true }).then((r) => {
    console.log(`\nrfb-enrichment-cx-knowledge-gap: ${r.passed} passed, ${r.failed} failed`);
    for (const f of r.failures) console.log(f);
    process.exit(r.failed === 0 ? 0 : 1);
  });
}
