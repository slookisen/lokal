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
 *
 * Standalone:
 *   node node_modules/tsx/dist/cli.mjs src/services/cs-change-requests.test.ts
 */

import Database from "better-sqlite3";
import * as initMod from "../database/init";
import * as dbFactory from "../database/db-factory";

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
      const mkThread = (vertical: "rfb" | "experiences", from: string, prefix = "cq") => {
        const id = `${prefix}-t${++tn}`;
        crm.crmService.ingestThread(
          { threadId: id, subject: `Henvendelse ${tn}`, category: "innkommende",
            messages: [{ messageId: `${id}-in`, direction: "in", fromEmail: from, bodyText: "Vennligst endre", sentAt: ago(2) }] },
          from, vertical);
        return id;
      };

      // Stub of the server's own admin routes (what the real routes would store).
      const calls: Array<{ method: string; path: string; body: any }> = [];
      let refuseKnowledge = false;
      let deleteStatus = 200;
      const adminCall: import("./cs-change-requests").AdminCall = async (method, path, body: any) => {
        calls.push({ method, path, body });
        const res = (status: number, json: any) => ({ status, body: JSON.stringify(json), json, location: null });
        let m = /^\/api\/marketplace\/agents\/([^/?]+)\/knowledge$/.exec(path);
        if (m && method === "PUT") {
          if (refuseKnowledge) return res(422, { error: "phone_not_substantiated" });
          for (const [k, col] of [["phone", "phone"], ["about", "about"], ["email", "email"], ["address", "address"]] as const) {
            if (body[k] !== undefined) db.prepare(`UPDATE agent_knowledge SET ${col} = ? WHERE agent_id = ?`).run(body[k], decodeURIComponent(m[1]));
          }
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
          exp.prepare("UPDATE experience_providers SET catalog_hidden = ? WHERE id = ?").run(body.hidden ? 1 : 0, body.providerIds[0]);
          return res(200, { changed: 1 });
        }
        return res(404, { error: "no stub" });
      };
      // Stub of the public surfaces, rendered from the databases.
      let staleSurface = false;
      const publicFetch: import("./cs-change-requests").PublicFetch = async (path, host) => {
        const r = (status: number, body: string) => ({ status, body, json: null, location: null });
        let m = /^\/api\/marketplace\/agents\/([^/]+)\/card$/.exec(path);
        if (m) {
          const a = db.prepare(`SELECT a.id, a.name, k.phone, k.about, k.address FROM agents a LEFT JOIN agent_knowledge k ON k.agent_id = a.id WHERE a.id = ?`).get(decodeURIComponent(m[1])) as any;
          if (!a) return r(404, "{}");
          return r(200, JSON.stringify(staleSurface ? { id: a.id, name: a.name, phone: "22 22 22 22", about: "Gammel tekst om gården" } : a));
        }
        m = /^\/produsent\/(.+)$/.exec(path);
        if (m) {
          const a = (db.prepare(`SELECT a.id, a.name, a.is_active, a.catalog_hidden, k.phone, k.about FROM agents a LEFT JOIN agent_knowledge k ON k.agent_id = a.id`).all() as any[]).find((x) => slugify(x.name) === decodeURIComponent(m![1]));
          if (!a || a.is_active !== 1) return r(404, "Ikke funnet");
          return r(200, staleSurface ? `<h1>${a.name}</h1><p>22 22 22 22</p><p>Gammel tekst om gården</p>` : `<h1>${a.name}</h1><p>${a.phone}</p><p>${a.about}</p>`);
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
