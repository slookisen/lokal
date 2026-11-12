/**
 * cs-change-requests.test.ts — dev-request 2026-11-10-cs-paa-serveren
 * (slookisen/A2A), skive S4: changes and removals executed and VERIFIED by
 * the server.
 *
 * The admin endpoints the server calls (its own routes, same gates as the
 * routine) and the public surfaces it reads back are stubbed against the same
 * in-memory databases, so every assertion reads what is actually stored.
 *
 *   cq1-cq8    authority (registered address / own domain / free-mail /
 *              contact form / other sender), dry run, validation, job off.
 *   cq9-cq12   profile_update: write + lock + read-back → verified; stale
 *              surface → stays executed, verify_failed after the window;
 *              field not shown publicly → read back from the DB, said so;
 *              a refused write → failed with the reason.
 *   cq13-cq19  removal (RFB): hidden at once, blocklist (never a free-mail
 *              domain), audit row; replies wait / fjern_steg1 may go; cancel
 *              restores and removes exactly its own rows; after 24 h delete +
 *              four checks → verified and the «fjernet» reply is released;
 *              a 423 on delete is retried.
 *   cq20-cq22  Opplevagent: content field + lock; removal = hide (no delete).
 *   cq23-cq27  routes, run ledger, watchdog + digest.
 *   cqo1-cqo6  opening hours (RFB): text written as a one-item list, locked,
 *              verified on the public card; day-and-time text; CR/LF and tab;
 *              clear; limits.
 *   cqr8-cqr18 second re-review: an Opplevagent removal through the REAL
 *              visibility route blocklists only the plan (never an e-mail,
 *              org.nr or site another active profile uses) and verifies on
 *              the plan; rows a route adds anyway come out again; the name
 *              row records the org.nr; a claim left behind by a restart is
 *              picked up (write re-run, delete retried, interrupted cancel to
 *              Daniel, capped); a linked reply waits meanwhile; cancel puts an
 *              earlier hide back exactly; forged «resend_inbound» metadata is
 *              no evidence for a removal.
 *   cqr19-cqr21 cancel never exposes an earlier removal; a row someone else
 *              adds meanwhile is neither cleaned up nor removed by cancel;
 *              an old cs_change_requests table gets blocklist_plan.
 *
 * Standalone:
 *   node node_modules/tsx/dist/cli.mjs src/services/cs-change-requests.test.ts
 */

import Database from "better-sqlite3";
import * as initMod from "../database/init";
import * as dbFactory from "../database/db-factory";
import { openingHoursText } from "../utils/opening-hours";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export function runCsChangeRequestsTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];
  function ok(cond: boolean, label: string): void {
    if (cond) { passed++; if (log) console.log(`  ok ${label}`); }
    else { failed++; failures.push(`✗ ${label}`); if (log) console.log(`  ✗ ${label}`); }
  }
  function eq(actual: unknown, expected: unknown, label: string): void {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    ok(a === e, `${label} (expected ${e}, got ${a})`);
  }

  return (async () => {
    const prevDb = initMod.__peekDbForTesting();
    const prevExp = process.env.EXPERIENCES_DB_PATH;
    process.env.EXPERIENCES_DB_PATH = ":memory:";
    dbFactory.__resetDbFactoryForTesting();
    const db = new Database(":memory:");
    try {
      initMod.__setDbForTesting(db as any);
      initMod.__initSchemaForTesting(db as any);
      const exp = dbFactory.getDb("experiences") as any;
      const cq = require("./cs-change-requests") as typeof import("./cs-change-requests");
      const crm = require("./crm-service") as typeof import("./crm-service");
      const rp = require("./cs-reply-proposals") as typeof import("./cs-reply-proposals");
      const cw = require("./cs-watchdog") as typeof import("./cs-watchdog");
      const { slugify } = require("../utils/slug") as typeof import("../utils/slug");

      const ON = { CS_CHANGE_REQUESTS_ENABLED: "1" } as unknown as NodeJS.ProcessEnv;
      const ago = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();

      // ── fixtures ─────────────────────────────────────────────────────
      const insAgent = db.prepare(
        `INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, is_active)
         VALUES (?, ?, 'Gårdsbutikk', 'test', ?, ?, 'producer', ?, 1)`,
      );
      const mkAgent = (id: string, name: string, email: string, url: string, kEmail: string | null = null) => {
        insAgent.run(id, name, email, url, `key-${id}`);
        db.prepare(`INSERT INTO agent_knowledge (agent_id, email, phone, about, website) VALUES (?, ?, '22 22 22 22', 'Gammel tekst om gården', ?)`).run(id, kEmail, url);
      };
      mkAgent("ag-1", "Testgård Øst", "post@testgard-ost.no", "https://testgard-ost.no");
      mkAgent("ag-2", "Fjellgården", "fjellgarden@gmail.com", "https://www.facebook.com/fjellgarden");
      mkAgent("ag-3", "Skjult Gård", "post@skjultgard.no", "https://skjultgard.no");
      mkAgent("ag-4", "Angregården", "post@angre.no", "https://angre.no");
      exp.prepare(`INSERT INTO experience_providers (id, navn, epost, hjemmeside, slug) VALUES ('ep-1', 'Sideri Vest', 'hei@siderivest.no', 'https://siderivest.no', 'sideri-vest--ep1')`).run();
      try { exp.exec("ALTER TABLE experience_providers ADD COLUMN about_text TEXT"); } catch { /* present */ }

      let tn = 0;
      // serverRegistered: the e-mail came through the Resend webhook — an
      // inbound_email_log row, and the CRM message id «rsnd-<email_id>».
      const mkThread = (vertical: "rfb" | "experiences", from: string, prefix = "cq", serverRegistered = true, forgedMeta = false) => {
        const id = `${prefix}-t${++tn}`;
        if (serverRegistered) {
          db.prepare(`INSERT INTO inbound_email_log (id, email_id, from_email, subject, crm_status, crm_thread_id, received_at) VALUES (?, ?, ?, ?, 'registered', ?, ?)`)
            .run(`inb-${id}`, `${id}-em`, from, `Henvendelse ${tn}`, id, ago(2));
        }
        crm.crmService.ingestThread(
          { threadId: id, subject: `Henvendelse ${tn}`, category: "innkommende",
            messages: [{ messageId: serverRegistered ? `rsnd-${id}-em` : `${id}-in`, direction: "in", fromEmail: from, bodyText: "Vennligst endre", sentAt: ago(2),
              rawMetadata: serverRegistered || forgedMeta ? { source: "resend_inbound" } : {} }] },
          from, vertical);
        return id;
      };

      // Stub of the server's own admin routes (what the real routes would store).
      const calls: Array<{ method: string; path: string; body: any }> = [];
      let refuseKnowledge = false;
      const lockedProviders = new Set<string>();
      let cardDown = false;
      let deleteStatus = 200;
      let routeIgnoresSkip = false;
      let routeAddsManualRow: string | null = null;
      const blocklistSvc = require("./blocklist-service") as typeof import("./blocklist-service");
      const adminCall: import("./cs-change-requests").AdminCall = async (method, path, body: any) => {
        calls.push({ method, path, body });
        const res = (status: number, json: any) => ({ status, body: JSON.stringify(json), json, location: null });
        let m = /^\/api\/marketplace\/agents\/([^/?]+)\/knowledge$/.exec(path);
        if (m && method === "PUT") {
          if (refuseKnowledge) return res(422, { error: "phone_not_substantiated" });
          for (const [k, col] of [["phone", "phone"], ["about", "about"], ["email", "email"], ["address", "address"]] as const) {
            if (body[k] !== undefined) db.prepare(`UPDATE agent_knowledge SET ${col} = ? WHERE agent_id = ?`).run(body[k], decodeURIComponent(m[1]));
          }
          // As the real write path: openingHours is stored only when it is a list.
          if (Array.isArray(body.openingHours)) db.prepare("UPDATE agent_knowledge SET opening_hours = ? WHERE agent_id = ?").run(JSON.stringify(body.openingHours), decodeURIComponent(m[1]));
          return res(200, { success: true });
        }
        m = /^\/api\/marketplace\/agents\/([^/?]+)\/description$/.exec(path);
        if (m) {
          if (body.name !== undefined) db.prepare("UPDATE agents SET name = ? WHERE id = ?").run(body.name, decodeURIComponent(m[1]));
          return res(200, { success: true });
        }
        if (/curated-fields$/.test(path)) return res(200, { success: true });
        m = /^\/api\/marketplace\/agents\/([^/?]+)\?force=1$/.exec(path);
        if (m && method === "DELETE") {
          if (deleteStatus !== 200) return res(deleteStatus, { error: "write paused" });
          db.prepare("DELETE FROM agent_knowledge WHERE agent_id = ?").run(decodeURIComponent(m[1]));
          db.prepare("DELETE FROM agents WHERE id = ?").run(decodeURIComponent(m[1]));
          return res(200, { success: true });
        }
        if (path === "/api/opplevelser/admin/gardssalg-set-content-field") {
          exp.prepare(`UPDATE experience_providers SET ${body.field} = ? WHERE id = ?`).run(body.value, body.provider_id);
          return res(200, { success: true });
        }
        if (path === "/api/opplevelser/admin/gardssalg-set-field-lock") return res(200, { success: true });
        if (path === "/api/opplevelser/admin/gardssalg-provider-visibility") {
          const pid = body.providerIds[0];
          if (lockedProviders.has(pid)) return res(200, { changed: [], unchanged: [], skipped_locked: [{ id: pid }] });
          exp.prepare("UPDATE experience_providers SET catalog_hidden = ?, catalog_hidden_reason = ? WHERE id = ?").run(body.hidden ? 1 : 0, body.hidden ? body.mode : null, pid);
          // Someone else (Daniel, by hand) blocklists an address while the hide runs.
          if (routeAddsManualRow) blocklistSvc.add({ email: routeAddsManualRow, reason: "manuell sperre (Daniel)" });
          // As the real route: «fjern oss» blocklists org.nr, e-post and site — unless asked not to.
          if (body.hidden && body.mode === "remove_request" && (body.skip_blocklist !== true || routeIgnoresSkip)) {
            const p = exp.prepare("SELECT org_nr, epost, hjemmeside FROM experience_providers WHERE id = ?").get(pid) as any;
            blocklistSvc.add({ orgNr: p?.org_nr ?? undefined, email: p?.epost ?? undefined, website: p?.hjemmeside ?? undefined, reason: "gardssalg-provider-visibility hide (fjern oss)" });
          }
          return res(200, { changed: [{ id: pid }], unchanged: [] });
        }
        return res(404, { error: "no stub" });
      };
      // Stub of the public surfaces, rendered from the databases.
      let staleSurface = false;
      const publicFetch: import("./cs-change-requests").PublicFetch = async (path, host) => {
        const r = (status: number, body: string) => ({ status, body, json: null, location: null });
        let m = /^\/api\/marketplace\/agents\/([^/]+)\/card$/.exec(path);
        if (m && cardDown) return r(503, "");
        if (m) {
          const a = db.prepare(`SELECT a.id, a.name, k.phone, k.about, k.address, k.opening_hours FROM agents a LEFT JOIN agent_knowledge k ON k.agent_id = a.id WHERE a.id = ?`).get(decodeURIComponent(m[1])) as any;
          if (!a) return r(404, "{}");
          // As the real card: the stored opening hours list, when there is one.
          const { opening_hours: oh, ...rest } = a;
          const hours = oh ? JSON.parse(oh) : [];
          const card = Array.isArray(hours) && hours.length ? { ...rest, openingHours: hours } : rest;
          return r(200, JSON.stringify(staleSurface ? { id: a.id, name: a.name, phone: "22 22 22 22", about: "Gammel tekst om gården" } : card));
        }
        m = /^\/produsent\/(.+)$/.exec(path);
        if (m) {
          const a = (db.prepare(`SELECT a.id, a.name, a.is_active, a.catalog_hidden, k.phone, k.about, k.opening_hours FROM agents a LEFT JOIN agent_knowledge k ON k.agent_id = a.id`).all() as any[]).find((x) => slugify(x.name) === decodeURIComponent(m![1]));
          if (!a || a.is_active !== 1) return r(404, "Ikke funnet");
          const hoursText = a.opening_hours ? openingHoursText(JSON.parse(a.opening_hours)) : "";
          return r(200, staleSurface ? `<h1>${a.name}</h1><p>22 22 22 22</p><p>Gammel tekst om gården</p>` : `<h1>${a.name}</h1><p>${a.phone}</p><p>${a.about}</p><p>${hoursText}</p>`);
        }
        if (path.startsWith("/api/marketplace/search")) {
          const rows = db.prepare("SELECT id, name FROM agents WHERE is_active = 1 AND COALESCE(catalog_hidden, 0) = 0").all();
          return r(200, JSON.stringify({ results: rows }));
        }
        m = /^\/kategori\/gardssalg\/produsent\/(.+)$/.exec(path);
        if (m && host === "opplevagent.no") {
          const p = exp.prepare("SELECT * FROM experience_providers WHERE slug = ?").get(decodeURIComponent(m[1])) as any;
          if (!p || p.catalog_hidden === 1) return r(404, "Ikke funnet");
          return r(200, `<h1>${p.navn}</h1><p>${p.about_text ?? ""}</p>`);
        }
        if (path.startsWith("/api/opplevelser/discover")) {
          const rows = exp.prepare("SELECT id, slug FROM experience_providers WHERE COALESCE(catalog_hidden, 0) = 0").all();
          return r(200, JSON.stringify({ results: rows }));
        }
        return r(404, "");
      };
      const deps = (extra: Record<string, unknown> = {}) => ({ adminCall, publicFetch, ...extra });
      const create = (input: Partial<import("./cs-change-requests").CreateChangeRequestInput>, env = ON) =>
        cq.createChangeRequest({ vertical: "rfb", targetId: "ag-1", threadId: null, requesterEmail: "post@testgard-ost.no", kind: "profile_update", createdBy: "claude", apply: true, ...input } as any, { env });
      const R = (id: string) => cq.getChangeRequest(id)!;

      // ── authority ────────────────────────────────────────────────────
      const t1 = mkThread("rfb", "post@testgard-ost.no");
      const c1 = create({ threadId: t1, changes: { phone: "+47 900 11 222", about: "Ny tekst om gården vår" } });
      eq(c1.ok && !c1.dryRun && [c1.request.status, c1.request.authority], ["queued", "registered_email"], "cq1: the profile's registered address on our thread → queued");
      const tOther = mkThread("rfb", "naboen@example.no");
      const c2 = create({ threadId: tOther, requesterEmail: "naboen@example.no", changes: { phone: "99999999" } });
      eq(c2.ok && !c2.dryRun && [c2.request.status, c2.request.status_reason], ["approval_needed", "avsender_ikke_profilens_adresse"], "cq2: another sender → approval queue");
      const tDom = mkThread("rfb", "eier@testgard-ost.no");
      const c3 = create({ threadId: tDom, requesterEmail: "eier@testgard-ost.no", changes: { about: "Tekst fra eieren" } });
      eq(c3.ok && !c3.dryRun && [c3.request.status, c3.request.authority], ["queued", "own_domain"], "cq3: an address on the profile's own domain → queued");
      const tGm = mkThread("rfb", "noen.andre@gmail.com");
      const c4 = create({ targetId: "ag-2", threadId: tGm, requesterEmail: "noen.andre@gmail.com", changes: { about: "x" } });
      eq(c4.ok && !c4.dryRun && c4.request.status, "approval_needed", "cq4: a free-mail domain never counts as the profile's domain");
      crm.crmService.ingestThread({ threadId: "kontakt-cq-1", subject: "[Kontaktskjema] fjern", category: "innkommende", messages: [{ messageId: "kontakt-cq-1-in", direction: "in", fromEmail: "post@testgard-ost.no", sentAt: ago(1) }] }, "post@testgard-ost.no", "rfb");
      const c5 = create({ threadId: "kontakt-cq-1", kind: "removal" });
      eq(c5.ok && !c5.dryRun && [c5.request.status, c5.request.status_reason], ["approval_needed", "kontaktskjema"], "cq5: the contact form alone never executes a change");
      const dry = create({ threadId: t1, kind: "removal", apply: false });
      ok(dry.ok && dry.dryRun === true && JSON.stringify(dry.plan).includes("agent_id") && (db.prepare("SELECT COUNT(*) n FROM cs_change_requests").get() as any).n === 5, "cq6: dry run returns the plan and stores nothing");
      eq((create({ threadId: t1, changes: { products: "egg" } }) as any).status, 422, "cq7: an unsupported field → 422");
      const c8 = create({ threadId: t1, changes: { about: "x" } }, {} as any);
      eq(c8.ok && !c8.dryRun && c8.request.status_reason, "endringsjobben_er_av", "cq8: job flag off → approval queue with the reason");
      if (c8.ok && !c8.dryRun) cq.rejectChangeRequest(c8.request.id, "test");

      // ── profile_update ───────────────────────────────────────────────
      const id1 = c1.ok && !c1.dryRun ? c1.request.id : "";
      const run1 = await cq.runCsChangeRequests(deps());
      eq(R(id1).status, "verified", "cq9: written through the admin route, locked, read back from the public card + page → verified");
      const kcall = calls.find((c) => c.path === "/api/marketplace/agents/ag-1/knowledge");
      ok(!!kcall && kcall.body.owner_relay_evidence?.channel === "email" && calls.some((c) => /curated-fields$/.test(c.path) && c.body.field === "phone"), "cq9b: phone write carries owner-relay evidence; each field is locked");
      ok(!!run1.run_id && !!db.prepare("SELECT 1 FROM runs WHERE run_id = ? AND claims LIKE '%cs_change_request%'").get(run1.run_id), "cq9c: a run-ledger row with each request's steps");
      // stale surface
      const tS = mkThread("rfb", "post@skjultgard.no");
      const cS = create({ targetId: "ag-3", threadId: tS, requesterEmail: "post@skjultgard.no", changes: { about: "Helt ny beskrivelse" } });
      const idS = cS.ok && !cS.dryRun ? cS.request.id : "";
      staleSurface = true;
      await cq.runCsChangeRequests(deps());
      eq(R(idS).status, "executed", "cq10: written but not visible yet → stays executed (re-read next tick)");
      await cq.runCsChangeRequests(deps({ now: new Date(Date.now() + 3 * 3600_000) }));
      eq(R(idS).status, "verify_failed", "cq10b: still not visible after the window → verify_failed");
      staleSurface = false;
      // field not shown publicly
      const tE = mkThread("rfb", "post@testgard-ost.no");
      const cE = create({ threadId: tE, changes: { email: "ny@testgard-ost.no" } });
      await cq.runCsChangeRequests(deps());
      const stepsE = JSON.parse(R(cE.ok && !cE.dryRun ? cE.request.id : "").steps);
      ok(R(cE.ok && !cE.dryRun ? cE.request.id : "").status === "verified" && JSON.stringify(stepsE).includes("feltet vises ikke offentlig"), "cq11: a field the public surfaces never show is read back from the DB — and the log says so");
      refuseKnowledge = true;
      const cF = create({ threadId: t1, changes: { phone: "12345678" } });
      await cq.runCsChangeRequests(deps());
      ok(R(cF.ok && !cF.dryRun ? cF.request.id : "").status === "failed" && /422/.test(R(cF.ok && !cF.dryRun ? cF.request.id : "").status_reason ?? ""), "cq12: a write the route refuses → failed with the HTTP reason");
      refuseKnowledge = false;

      // ── removal (RFB) ────────────────────────────────────────────────
      db.prepare(`INSERT INTO agent_blocklist (identifier_type, identifier_value, reason) VALUES ('email', 'post@angre.no', 'eldre sperre')`).run();
      const tA = mkThread("rfb", "post@angre.no");
      const cA = create({ targetId: "ag-4", threadId: tA, requesterEmail: "post@angre.no", kind: "removal" });
      const idA = cA.ok && !cA.dryRun ? cA.request.id : "";
      const tR = mkThread("rfb", "fjellgarden@gmail.com");
      const cR = create({ targetId: "ag-2", threadId: tR, requesterEmail: "fjellgarden@gmail.com", kind: "removal" });
      const idR = cR.ok && !cR.dryRun ? cR.request.id : "";
      await cq.runCsChangeRequests(deps());
      const ag2 = db.prepare("SELECT is_active, catalog_hidden FROM agents WHERE id = 'ag-2'").get() as any;
      eq([R(idR).status, ag2.is_active, ag2.catalog_hidden], ["hidden", 0, 1], "cq13: removal hides at once (inactive + catalog_hidden)");
      const bl = (db.prepare("SELECT identifier_type t, identifier_value v FROM agent_blocklist").all() as any[]).map((x) => `${x.t}:${x.v}`);
      ok(bl.includes("email:fjellgarden@gmail.com") && bl.includes("agent_id:ag-2") && bl.some((x) => x.startsWith("name_normalized:")), "cq14: requester e-mail, agent id and name are blocklisted");
      ok(!bl.includes("website_domain:gmail.com") && !bl.includes("website_domain:facebook.com"), "cq14b: never a free-mail or platform domain");
      ok(!!db.prepare("SELECT 1 FROM agent_knowledge_audit WHERE agent_id = 'ag-2' AND field_name = 'is_active' AND new_value = '0'").get(), "cq14c: the hide is in the audit log");
      // replies linked to the removal
      const pr = rp.createReplyProposal({ threadId: tR, kind: "fjernet", bodyText: "Profilen din er fjernet.", changeRequestIds: [idR], createdBy: "claude" }, { env: { CS_AUTOSEND_ENABLED: "1" } as any });
      const prId = pr.ok ? pr.proposal.id : "";
      eq((await rp.processProposal(prId, { env: { CS_AUTOSEND_ENABLED: "1" } as any, liveTransport: true, sendRaw: async () => ({ success: true, messageId: "<x@y>" }) })).outcome, "waiting", "cq15: the «fjernet» reply waits while the removal is only hidden");
      eq((await cq.runCsChangeRequests(deps())).processed.filter((p) => p.id === idR).length, 0, "cq15b: nothing happens before the 24 h");
      // cancel
      const cancel = await cq.cancelChangeRequest(idA, "kunden angret", deps());
      const ag4 = db.prepare("SELECT is_active, catalog_hidden FROM agents WHERE id = 'ag-4'").get() as any;
      const bl4 = (db.prepare("SELECT identifier_value v FROM agent_blocklist WHERE identifier_value IN ('post@angre.no', 'angre.no', 'ag-4')").all() as any[]).map((x) => x.v);
      eq([cancel.ok, ag4.is_active, ag4.catalog_hidden, bl4.sort()], [true, 1, 0, ["post@angre.no"]], "cq16: cancel restores visibility and removes exactly the rows it added (the older row stays)");
      // after 24 h: delete + checks
      const later = new Date(Date.now() + 25 * 3600_000);
      deleteStatus = 423;
      await cq.runCsChangeRequests(deps({ now: later }));
      eq([R(idR).status, R(idR).attempts], ["hidden", 1], "cq17: a 423 on delete keeps it hidden and retries next tick");
      deleteStatus = 200;
      await cq.runCsChangeRequests(deps({ now: new Date(later.getTime() + 600_000) }));
      const checks = JSON.parse(R(idR).steps).find((s: any) => s.step === "checks");
      eq([R(idR).status, !!db.prepare("SELECT 1 FROM agents WHERE id = 'ag-2'").get(), checks?.ok], ["verified", false, true], "cq18: after 24 h: deleted, four checks pass → verified");
      eq((await rp.processProposal(prId, { now: new Date(Date.now() + 10 * 60_000), env: { CS_AUTOSEND_ENABLED: "1" } as any, liveTransport: true, sendRaw: async () => ({ success: true, messageId: "<x@y>" }) })).outcome, "sent", "cq19: …and the «fjernet» reply is released");

      // ── Opplevagent ──────────────────────────────────────────────────
      const tX = mkThread("experiences", "hei@siderivest.no");
      const cX = create({ vertical: "experiences", targetId: "ep-1", threadId: tX, requesterEmail: "hei@siderivest.no", changes: { about_text: "Velkommen til sideriet vårt" } });
      await cq.runCsChangeRequests(deps());
      ok(R(cX.ok && !cX.dryRun ? cX.request.id : "").status === "verified" && calls.some((c) => c.path.endsWith("gardssalg-set-field-lock") && c.body.field === "about_text"), "cq20: Opplevagent content field written, locked and seen on the page → verified");
      const cXr = create({ vertical: "experiences", targetId: "ep-1", threadId: tX, requesterEmail: "hei@siderivest.no", kind: "removal" });
      const idXr = cXr.ok && !cXr.dryRun ? cXr.request.id : "";
      await cq.runCsChangeRequests(deps());
      eq([R(idXr).status, (exp.prepare("SELECT catalog_hidden FROM experience_providers WHERE id = 'ep-1'").get() as any).catalog_hidden], ["hidden", 1], "cq21: Opplevagent removal hides via the visibility route");
      const nDel = calls.filter((c) => c.method === "DELETE").length;
      await cq.runCsChangeRequests(deps({ now: new Date(Date.now() + 25 * 3600_000) }));
      eq([R(idXr).status, calls.filter((c) => c.method === "DELETE").length], ["verified", nDel], "cq22: …after 24 h verified without a delete call (no single-provider delete exists)");

      // ── S4 review fixes ──────────────────────────────────────────────
      {
        // 7: a removal needs an e-mail the SERVER received, not one any API caller could file.
        insAgent.run("ag-5", "Bevisgården", "post@bevis.no", "https://bevis.no", "key-ag-5");
        db.prepare(`INSERT INTO agent_knowledge (agent_id, email, phone, about, website) VALUES ('ag-5', NULL, '33 33 33 33', 'Om', 'https://bevis.no')`).run();
        const tNoServer = mkThread("rfb", "post@bevis.no", "cq", false);
        const r7 = create({ targetId: "ag-5", threadId: tNoServer, requesterEmail: "post@bevis.no", kind: "removal" });
        eq(r7.ok && !r7.dryRun && [r7.request.status, r7.request.status_reason], ["approval_needed", "fjerning_krever_serverregistrert_e-post"], "cqr1: a removal whose evidence was not received by the server goes to Daniel");
        if (r7.ok && !r7.dryRun) cq.rejectChangeRequest(r7.request.id, "test");
        const tForged = mkThread("rfb", "post@bevis.no", "cq", false, true);
        const r7b = create({ targetId: "ag-5", threadId: tForged, requesterEmail: "post@bevis.no", kind: "removal" });
        eq(r7b.ok && !r7b.dryRun && [r7b.request.status, r7b.request.status_reason], ["approval_needed", "fjerning_krever_serverregistrert_e-post"], "cqr1b: raw_metadata.source = resend_inbound sent through /ingest is no evidence — only the server's own inbound log is");
        // 6: a second open removal of the same profile is refused (cancel stays meaningful)
        const tSrv = mkThread("rfb", "post@bevis.no");
        const r6 = create({ targetId: "ag-5", threadId: tSrv, requesterEmail: "post@bevis.no", kind: "removal" });
        eq([(r6 as any).status, (r6 as any).error], [409, "open_request_exists"], "cqr2: a duplicate open removal of one profile → 409 with the existing id");
      }
      {
        // 5c: an identifier another active profile uses is never blocklisted
        insAgent.run("ag-6", "Delt Gård A", "felles@delt.no", "https://delt.no", "key-ag-6");
        db.prepare(`INSERT INTO agent_knowledge (agent_id, email, website) VALUES ('ag-6', NULL, 'https://delt.no')`).run();
        insAgent.run("ag-7", "Delt Gård B", "felles@delt.no", "https://annen.no", "key-ag-7");
        db.prepare(`INSERT INTO agent_knowledge (agent_id, email, website) VALUES ('ag-7', NULL, 'https://annen.no')`).run();
        const plan = cq.removalBlocklistPlan("rfb", cq.loadTarget("rfb", "ag-6")!, "felles@delt.no");
        ok(!plan.some((p) => p.type === "email" && p.value === "felles@delt.no") && plan.some((p) => p.type === "agent_id"), "cqr3: an e-mail another active producer uses is not blocklisted (its order mails would stop)");
        // 5a/b: authority from the ROOT website domain only
        insAgent.run("ag-8", "Sidegården", "post@sidegarden.no", "https://www.facebook.com/sidegarden", "key-ag-8");
        db.prepare(`INSERT INTO agent_knowledge (agent_id, email, website) VALUES ('ag-8', NULL, 'https://www.facebook.com/sidegarden')`).run();
        const t5 = cq.loadTarget("rfb", "ag-8")!;
        eq(t5.domains, [], "cqr4: a deep page on a platform host gives no own-domain authority");
      }
      {
        // 2: Opplevagent hide that the route skipped is a failure, not «hidden»
        exp.prepare(`INSERT INTO experience_providers (id, navn, epost, hjemmeside, slug) VALUES ('ep-2', 'Låst Gård', 'post@laast.no', 'https://laast.no', 'laast-gard--ep2')`).run();
        lockedProviders.add("ep-2");
        const tL = mkThread("experiences", "post@laast.no");
        const cL = create({ vertical: "experiences", targetId: "ep-2", threadId: tL, requesterEmail: "post@laast.no", kind: "removal" });
        await cq.runCsChangeRequests(deps());
        const rl = R(cL.ok && !cL.dryRun ? cL.request.id : "");
        ok(rl.status === "failed" && /skipped_locked/.test(rl.status_reason ?? ""), "cqr5: the visibility route answering 200 with skipped_locked → failed (the customer is never told it is hidden)");
      }
      {
        // 3: an unavailable public surface proves nothing — stays executed
        const tU = mkThread("rfb", "post@testgard-ost.no");
        const cU = create({ threadId: tU, changes: { about: "Tekst mens kortet er nede" } });
        cardDown = true;
        await cq.runCsChangeRequests(deps());
        const ru = R(cU.ok && !cU.dryRun ? cU.request.id : "");
        cardDown = false;
        eq(ru.status, "executed", "cqr6: card API down (503) → not verified, re-read later");
        await cq.runCsChangeRequests(deps());
        eq(R(ru.id).status, "verified", "cqr7: …verified once the surfaces answer and show the value");
      }

      // ── second re-review ─────────────────────────────────────────────
      {
        // B1, through the REAL Opplevagent visibility route: a provider that
        // shares its e-mail, org.nr and site with an active RFB producer.
        const prevKey = process.env.ADMIN_KEY;
        process.env.ADMIN_KEY = "test-admin-key";
        const opl = (require("../routes/opplevelser") as any).default;
        const realCall = (method: string, path: string, body?: any): Promise<any> =>
          new Promise((resolve) => {
            const headers: Record<string, string> = { "x-admin-key": "test-admin-key", host: "opplevagent.no", "content-type": "application/json" };
            const sub = path.slice("/api/opplevelser".length);
            const req: any = { method, url: sub, originalUrl: path, path: sub, query: {}, body: body ?? {}, headers, params: {}, ip: "127.0.0.1", get: (n: string) => headers[n.toLowerCase()], header: (n: string) => headers[n.toLowerCase()] };
            const res: any = { statusCode: 200, setHeader() {}, getHeader() {}, set() { return this; }, header() { return this; },
              status(c: number) { this.statusCode = c; return this; },
              json(b: any) { resolve({ status: this.statusCode, body: JSON.stringify(b), json: b, location: null }); return this; },
              send(b: any) { resolve({ status: this.statusCode, body: String(b), json: null, location: null }); return this; } };
            opl.handle(req, res, (e: any) => resolve({ status: e ? 500 : 404, body: String(e ?? "fell through"), json: null, location: null }));
          });
        const mixedCall: import("./cs-change-requests").AdminCall = (method, path, body) =>
          path === "/api/opplevelser/admin/gardssalg-provider-visibility" ? realCall(method, path, body) : adminCall(method, path, body);
        try {
          insAgent.run("ag-delt", "Delt Gård", "post@deltgard.no", "https://deltgard.no", "key-ag-delt");
          db.prepare(`INSERT INTO agent_knowledge (agent_id, website) VALUES ('ag-delt', 'https://deltgard.no')`).run();
          db.prepare("UPDATE agents SET org_nr = '912345678' WHERE id = 'ag-delt'").run();
          exp.prepare(`INSERT INTO experience_providers (id, navn, epost, hjemmeside, slug, org_nr, producer_type) VALUES ('ep-delt', 'Delt Gård Sideri', 'post@deltgard.no', 'https://deltgard.no', 'delt-gard-sideri--ep', '912345678', 'sideri')`).run();
          const tD = mkThread("experiences", "post@deltgard.no");
          const dryD = cq.createChangeRequest({ vertical: "experiences", targetId: "ep-delt", threadId: tD, requesterEmail: "post@deltgard.no", kind: "removal", createdBy: "claude", apply: false }, { env: ON }) as any;
          const planTypes = JSON.stringify(dryD.plan).match(/"type":"[a-z_]+"/g) ?? [];
          eq(planTypes, ['"type":"name_normalized"'], "cqr8: the dry run plans only the name (e-mail, org.nr and site are shared with an active RFB producer)");
          const cD = cq.createChangeRequest({ vertical: "experiences", targetId: "ep-delt", threadId: tD, requesterEmail: "post@deltgard.no", kind: "removal", createdBy: "claude", apply: true }, { env: ON }) as any;
          const idD = cD.request.id;
          await cq.runCsChangeRequests({ adminCall: mixedCall, publicFetch });
          eq([R(idD).status, blocklistSvc.isBlocked({ email: "post@deltgard.no" }).blocked, blocklistSvc.isBlocked({ orgNr: "912345678" }).blocked, blocklistSvc.isBlocked({ website: "https://deltgard.no" }).blocked],
            ["hidden", false, false, false], "cqr9: hidden through the real route, and the RFB producer's e-mail, org.nr and site stay open (its order mails keep coming)");
          const nameRow = db.prepare("SELECT linked_org_nr FROM agent_blocklist WHERE identifier_type = 'name_normalized' AND identifier_value = ?").get(blocklistSvc.normalizeName("Delt Gård Sideri")) as any;
          eq(nameRow?.linked_org_nr, "912345678", "cqr10: the name row records the org.nr (a different business with the same name is not blocked)");
          await cq.runCsChangeRequests({ adminCall: mixedCall, publicFetch, now: new Date(Date.now() + 25 * 3600_000) });
          eq(R(idD).status, "verified", "cqr11: verified on the PLANNED rows — a shared requester address no longer keeps a removal from verifying");
        } finally {
          if (prevKey === undefined) delete process.env.ADMIN_KEY; else process.env.ADMIN_KEY = prevKey;
        }
      }
      {
        // B1 defence: a route that still writes its own rows — the unplanned ones come out again.
        insAgent.run("ag-delt2", "Annen Delt", "post@delt2.no", "https://delt2.no", "key-ag-delt2");
        db.prepare(`INSERT INTO agent_knowledge (agent_id, website) VALUES ('ag-delt2', 'https://delt2.no')`).run();
        exp.prepare(`INSERT INTO experience_providers (id, navn, epost, hjemmeside, slug) VALUES ('ep-delt2', 'Bryggeri Delt', 'post@delt2.no', 'https://delt2.no', 'bryggeri-delt--ep2')`).run();
        const tD2 = mkThread("experiences", "post@delt2.no");
        const cD2 = create({ vertical: "experiences", targetId: "ep-delt2", threadId: tD2, requesterEmail: "post@delt2.no", kind: "removal" }) as any;
        routeIgnoresSkip = true;
        await cq.runCsChangeRequests(deps());
        routeIgnoresSkip = false;
        const steps = JSON.parse(R(cD2.request.id).steps);
        eq([R(cD2.request.id).status, blocklistSvc.isBlocked({ email: "post@delt2.no" }).blocked, steps.some((x: any) => x.step === "blocklist_unplanned_removed")],
          ["hidden", false, true], "cqr12: rows the route added outside the plan (a shared e-mail) are removed again, and the log says so");
      }
      {
        // B2: a claim left behind by a restart.
        insAgent.run("ag-b", "Bgård", "post@bgard.no", "https://bgard.no", "key-ag-b");
        db.prepare(`INSERT INTO agent_knowledge (agent_id, email, phone, about, website) VALUES ('ag-b', NULL, '44 44 44 44', 'Gammel Bgård-tekst', 'https://bgard.no')`).run();
        const tB = mkThread("rfb", "post@bgard.no");
        const cB = create({ targetId: "ag-b", threadId: tB, requesterEmail: "post@bgard.no", changes: { about: "Ny Bgård-tekst" } }) as any;
        const idB = cB.request.id;
        void cq.runCsChangeRequests({ adminCall: () => new Promise(() => {}), publicFetch }); // never returns: the process «died» mid-write
        await new Promise((r) => setTimeout(r, 30));
        eq(R(idB).status, "executing", "cqr13: (setup) the request is left «executing»");
        const pB = rp.createReplyProposal({ threadId: tB, kind: "rettelse_bekreftet", bodyText: "Vi har oppdatert teksten om gården.", changeRequestIds: [idB], createdBy: "claude" }, { env: { CS_AUTOSEND_ENABLED: "1" } as any }) as any;
        eq((await rp.processProposal(pB.proposal.id, { env: { CS_AUTOSEND_ENABLED: "1" } as any, liveTransport: true, sendRaw: async () => ({ success: true, messageId: "<b@y>" }) })).outcome, "waiting", "cqr14: a reply linked to an «executing» change waits (it is not sent to Daniel as unverified)");
        await cq.runCsChangeRequests(deps({ now: new Date(Date.now() + 5 * 60_000) }));
        eq(R(idB).status, "executing", "cqr14b: a fresh claim is left alone");
        await cq.runCsChangeRequests(deps({ now: new Date(Date.now() + (cq.STALE_CLAIM_MINUTES + 1) * 60_000) }));
        const stepsB = JSON.parse(R(idB).steps);
        eq([R(idB).status, stepsB.some((x: any) => x.step === "reclaimed" && x.ok), R(idB).attempts], ["verified", true, 1], "cqr15: after the stale window the worker picks it up, re-runs the write and verifies it");
        // interrupted delete
        insAgent.run("ag-9d", "Dgård", "post@dgard.no", "https://dgard.no", "key-ag-9d");
        db.prepare(`INSERT INTO agent_knowledge (agent_id, website) VALUES ('ag-9d', 'https://dgard.no')`).run();
        const tDd = mkThread("rfb", "post@dgard.no");
        const cDd = create({ targetId: "ag-9d", threadId: tDd, requesterEmail: "post@dgard.no", kind: "removal" }) as any;
        await cq.runCsChangeRequests(deps());
        const at = new Date(Date.now() + 25 * 3600_000);
        void cq.runCsChangeRequests({ publicFetch, now: at, adminCall: (m, p, b) => (m === "DELETE" ? new Promise(() => {}) : adminCall(m, p, b)) });
        await new Promise((r) => setTimeout(r, 30));
        eq(R(cDd.request.id).status, "deleting", "cqr16: (setup) the delete is left «deleting»");
        await cq.runCsChangeRequests(deps({ now: new Date(at.getTime() + (cq.STALE_CLAIM_MINUTES + 1) * 60_000) }));
        eq([R(cDd.request.id).status, !!db.prepare("SELECT 1 FROM agents WHERE id = 'ag-9d'").get()], ["verified", false], "cqr16b: the interrupted delete is retried and verified");
        // interrupted cancel → Daniel; capped re-runs → failed
        const stale = new Date(Date.now() - 2 * 3600_000).toISOString();
        const cAng = create({ threadId: t1, changes: { about: "Angres" } }) as any;
        const idAng = cAng.request.id;
        db.prepare("UPDATE cs_change_requests SET status = 'executing', status_reason = 'angrer', updated_at = ? WHERE id = ?").run(stale, idAng);
        const cCap = create({ threadId: t1, changes: { about: "Kappet" } }) as any;
        db.prepare("UPDATE cs_change_requests SET status = 'executing', attempts = 3, updated_at = ? WHERE id = ?").run(stale, cCap.request.id);
        await cq.runCsChangeRequests(deps());
        eq([R(idAng).status, /angring avbrutt/.test(R(idAng).status_reason ?? ""), R(cCap.request.id).status, /avbrutt underveis 3 ganger/.test(R(cCap.request.id).status_reason ?? "")],
          ["failed", true, "failed", true], "cqr17: an interrupted cancel goes to Daniel (failed, half restored); a claim interrupted 3 times stops at failed");
      }
      {
        // NB1: cancel puts an earlier hide back exactly, whatever its reason (the route only knows two modes).
        exp.prepare(`INSERT INTO experience_providers (id, navn, epost, hjemmeside, slug, catalog_hidden, catalog_hidden_reason) VALUES ('ep-p', 'Pausegården', 'post@pause.no', 'https://pause.no', 'pausegarden--ep', 1, 'owner_pause')`).run();
        const tP = mkThread("experiences", "post@pause.no");
        const cP = create({ vertical: "experiences", targetId: "ep-p", threadId: tP, requesterEmail: "post@pause.no", kind: "removal" }) as any;
        await cq.runCsChangeRequests(deps());
        const can = await cq.cancelChangeRequest(cP.request.id, "kunden angret", deps());
        const pr = exp.prepare("SELECT catalog_hidden, catalog_hidden_reason FROM experience_providers WHERE id = 'ep-p'").get() as any;
        eq([can.ok, pr.catalog_hidden, pr.catalog_hidden_reason], [true, 1, "owner_pause"], "cqr18: cancel restores the owner's own pause exactly (hidden, reason owner_pause)");
      }

      {
        // NB1 (third round): a provider already removed earlier stays hidden on cancel.
        exp.prepare(`INSERT INTO experience_providers (id, navn, epost, hjemmeside, slug, catalog_hidden, catalog_hidden_reason) VALUES ('ep-old', 'Gammel Fjerning', 'post@gammelfjern.no', 'https://gammelfjern.no', 'gammel-fjerning--ep', 1, 'remove_request')`).run();
        const tO = mkThread("experiences", "post@gammelfjern.no");
        const cO = create({ vertical: "experiences", targetId: "ep-old", threadId: tO, requesterEmail: "post@gammelfjern.no", kind: "removal" }) as any;
        await cq.runCsChangeRequests(deps());
        const nUnhide = calls.filter((c) => c.path.endsWith("gardssalg-provider-visibility") && c.body.hidden === false).length;
        const canO = await cq.cancelChangeRequest(cO.request.id, "kunden angret", deps());
        const po = exp.prepare("SELECT catalog_hidden, catalog_hidden_reason FROM experience_providers WHERE id = 'ep-old'").get() as any;
        eq([canO.ok, po.catalog_hidden, po.catalog_hidden_reason, calls.filter((c) => c.path.endsWith("gardssalg-provider-visibility") && c.body.hidden === false).length - nUnhide],
          [true, 1, "remove_request", 0], "cqr19: cancel of a removal on a provider that was already removed keeps it hidden (no unhide call at all)");
        // NB5 (third round): a row someone else adds while the hide runs is kept, and cancel leaves it.
        exp.prepare(`INSERT INTO experience_providers (id, navn, epost, hjemmeside, slug) VALUES ('ep-m', 'Manuellgården', 'post@manuell.no', 'https://manuell.no', 'manuellgarden--ep')`).run();
        insAgent.run("ag-m", "Manuell RFB", "post@manuell.no", "https://manuell-rfb.no", "key-ag-m"); // shares the e-mail → not in the plan
        db.prepare(`INSERT INTO agent_knowledge (agent_id, website) VALUES ('ag-m', 'https://manuell-rfb.no')`).run();
        const tM = mkThread("experiences", "post@manuell.no");
        const cM = create({ vertical: "experiences", targetId: "ep-m", threadId: tM, requesterEmail: "post@manuell.no", kind: "removal" }) as any;
        routeAddsManualRow = "post@manuell.no";
        await cq.runCsChangeRequests(deps());
        routeAddsManualRow = null;
        const manualKept = () => !!db.prepare("SELECT 1 FROM agent_blocklist WHERE identifier_type = 'email' AND identifier_value = 'post@manuell.no' AND reason = 'manuell sperre (Daniel)'").get();
        eq([R(cM.request.id).status, manualKept()], ["hidden", true], "cqr20: a row someone else added meanwhile is not cleaned up as «unplanned»");
        await cq.cancelChangeRequest(cM.request.id, "kunden angret", deps());
        eq(manualKept(), true, "cqr20b: …and cancel does not remove it either");
        // NB4 (third round): a cs_change_requests table from an earlier build gets the column.
        const old = new Database(":memory:");
        old.exec("CREATE TABLE cs_change_requests (id TEXT PRIMARY KEY, vertical TEXT NOT NULL, target_id TEXT NOT NULL, thread_id TEXT, status TEXT NOT NULL, created_at TEXT NOT NULL)");
        initMod.__initSchemaForTesting(old as any);
        ok((old.prepare("PRAGMA table_info(cs_change_requests)").all() as any[]).some((c) => c.name === "blocklist_plan"), "cqr21: an older cs_change_requests table gets blocklist_plan at boot");
        old.close();
        initMod.__setDbForTesting(db as any);
      }

      // ── routes, watchdog, digest ─────────────────────────────────────
      const router = (require("../routes/admin-cs-change-requests") as any).default;
      const call = (method: string, url: string, body?: any): Promise<{ status: number; body: any }> =>
        new Promise((resolve) => {
          const [path, qs] = url.split("?");
          const query: Record<string, string> = {};
          for (const kv of (qs ?? "").split("&").filter(Boolean)) { const [k, v] = kv.split("="); query[k] = decodeURIComponent(v ?? ""); }
          const headers: Record<string, string> = { "x-admin-key": process.env.ADMIN_KEY || "test-admin-key" };
          const req: any = { method, url, originalUrl: url, path, query, body: body ?? {}, headers, params: {}, get: (n: string) => headers[n.toLowerCase()] };
          const res: any = { statusCode: 200, status(c: number) { this.statusCode = c; return this; }, json(b: any) { resolve({ status: this.statusCode, body: b }); return this; } };
          router.handle(req, res, () => resolve({ status: 404, body: null }));
        });
      const prevKey = process.env.ADMIN_KEY;
      process.env.ADMIN_KEY = "test-admin-key";
      try {
        const d = await call("POST", "/change-requests", { vertical: "rfb", targetId: "ag-1", threadId: t1, requesterEmail: "post@testgard-ost.no", kind: "profile_update", changes: { about: "Via ruten" } });
        eq([d.status, d.body?.dryRun], [200, true], "cq23: POST is a dry run by default");
        const q = await call("GET", "/change-requests?status=approval_needed");
        ok(q.status === 200 && q.body.items.some((x: any) => x.id === (c2.ok && !c2.dryRun ? c2.request.id : "")), "cq24: GET lists the approval queue");
        const ap = await call("POST", `/change-requests/${c2.ok && !c2.dryRun ? c2.request.id : ""}/approve`, {});
        eq([ap.status, ap.body?.request?.status, ap.body?.request?.authority], [200, "queued", "approved"], "cq25: Daniel approves → queued (authority approved)");
        eq((await call("POST", `/change-requests/${idR}/cancel`, { reason: "for sent" })).status, 409, "cq25b: a deleted removal cannot be cancelled");
      } finally {
        if (prevKey === undefined) delete process.env.ADMIN_KEY; else process.env.ADMIN_KEY = prevKey;
      }
      const alerts: any[] = [];
      await cw.runCsWatchdog({ send: async (o: any) => { alerts.push(o); return { success: true }; }, adminEmail: "admin@example.no", trigger: "manual", now: new Date(Date.now() + 4 * 3600_000) });
      ok(String(alerts[0]?.textContent ?? "").includes("ikke bekreftet på siden"), "cq26: the watchdog alerts a change that was not confirmed on the page");
      ok(cw.buildDailyDigest(new Date()).text.includes("ENDRINGER OG SLETTINGER"), "cq27: the digest reports changes and removals per platform");

      // ── cqo1-cqo6: opening hours (Daniel 2026-11-12: the routine fixes opening hours itself, too) ──
      {
        mkAgent("ag-oh", "Åpningsgården", "post@apningsgarden.no", "https://apningsgarden.no");
        const dayRows = JSON.stringify([{ day: "sat", open: "10:00", close: "14:00" }]);
        db.prepare("UPDATE agent_knowledge SET opening_hours = ? WHERE agent_id = 'ag-oh'").run(dayRows);
        const tOh = mkThread("rfb", "post@apningsgarden.no");
        const ohCreate = (openingHours: string) => create({ targetId: "ag-oh", threadId: tOh, requesterEmail: "post@apningsgarden.no", changes: { openingHours } }) as any;
        const ohRow = () => (db.prepare("SELECT opening_hours FROM agent_knowledge WHERE agent_id = 'ag-oh'").get() as any)?.opening_hours;

        const o1 = ohCreate("Onsdag, ellers når vi er hjemme");
        await cq.runCsChangeRequests(deps());
        const o1call = calls.filter((c) => c.path === "/api/marketplace/agents/ag-oh/knowledge").pop();
        eq([o1.ok, R(o1.request.id).status, ohRow(), o1call?.body?.openingHours, calls.some((c) => /ag-oh\/curated-fields$/.test(c.path) && c.body.field === "opening_hours")],
          [true, "verified", JSON.stringify(["Onsdag, ellers når vi er hjemme"]), ["Onsdag, ellers når vi er hjemme"], true],
          "cqo1: the owner's opening hours as text are written as a one-item list, locked (opening_hours) and seen on the public card → verified");
        eq(JSON.parse(R(o1.request.id).snapshot ?? "{}").openingHours?.old, dayRows, "cqo1b: the snapshot keeps the earlier day rows exactly as stored");

        const o2 = ohCreate("Man–fre 10–17, lør 10–14");
        await cq.runCsChangeRequests(deps());
        eq([R(o2.request.id).status, ohRow()], ["verified", JSON.stringify(["Man–fre 10–17, lør 10–14"])], "cqo2: text in the day-and-time form is stored as written and verified");
        const o2b = ohCreate("Man–fre 10–17,\r\nLør\t10–14");
        await cq.runCsChangeRequests(deps());
        eq(R(o2b.request.id).status, "verified", "cqo2b: a CR/LF or tab in the text (escaped in the card JSON) still verifies");

        staleSurface = true;
        const o3 = ohCreate("Lørdag 12–15");
        await cq.runCsChangeRequests(deps());
        const o3stale = R(o3.request.id).status;
        staleSurface = false;
        await cq.runCsChangeRequests(deps());
        eq([o3stale, R(o3.request.id).status], ["executed", "verified"], "cqo3: hours stored but not yet on the public surfaces stay executed, and verify once they show");

        const o4 = ohCreate("");
        await cq.runCsChangeRequests(deps());
        eq([R(o4.request.id).status, ohRow()], ["verified", "[]"], "cqo4: an empty value clears the hours, verified once the old text is gone from the page");

        eq([
          (ohCreate("x".repeat(1001)) as any).status,
          (cq.createChangeRequest({ vertical: "experiences", targetId: "ep-1", threadId: null, requesterEmail: "hei@siderivest.no", kind: "profile_update", createdBy: "claude", apply: false, changes: { openingHours: "Lørdag 12–15" } } as any, { env: ON }) as any).status,
        ], [400, 422], "cqo5: more than 1000 characters → 400; Opplevagent keeps its own field (opening_hours_text), so openingHours there → 422");

        eq([
          cq.openingHoursComparable(null),
          cq.openingHoursComparable("[]"),
          cq.openingHoursComparable(JSON.stringify(["Onsdag"])),
          cq.openingHoursComparable(dayRows),
          cq.openingHoursComparable("Lørdag 10–14"),
          cq.openingHoursComparable(JSON.stringify(["Onsdag", "Fredag"])),
        ], [null, "", "Onsdag", dayRows, "Lørdag 10–14", JSON.stringify(["Onsdag", "Fredag"])],
          "cqo6: only a one-item text list (or plain text) compares as text; day rows stay their raw JSON");
      }
    } catch (err: any) {
      failed++;
      failures.push("unexpected error: " + String(err?.stack || err));
    } finally {
      try { db.close(); } catch { /* already closed */ }
      initMod.__setDbForTesting(prevDb as any);
      if (prevExp === undefined) delete process.env.EXPERIENCES_DB_PATH; else process.env.EXPERIENCES_DB_PATH = prevExp;
      dbFactory.__resetDbFactoryForTesting();
    }
    if (log) console.log(`\n${passed} passed, ${failed} failed`);
    return { passed, failed, failures };
  })();
}

if (require.main === module) {
  runCsChangeRequestsTests({ log: true }).then((s) => {
    for (const f of s.failures) console.log(f);
    process.exit(s.failed > 0 ? 1 : 0);
  });
}
