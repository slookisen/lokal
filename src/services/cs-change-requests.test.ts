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
 *   cqp1-cqp12 products (RFB, dev-request 2026-11-22-cs-endringsforesporsel-
 *              kan-fjerne-og-rette-varer): remove / rename a named product —
 *              the rest of the list unchanged, lock on products, verified on
 *              card and page; unknown name, owner / import products, an
 *              owner-locked list, a name collision → refused, nothing written;
 *              the listing shows action and product in plain text.
 *   cqa1-cqa15 add (dev-request 2026-11-25-cs-endringsforesporsel-kan-legge-
 *              til-varer): add with source owner_reported, the rest byte for
 *              byte; remove + add in one request; dry run; undo from the
 *              snapshot; refusals with nothing written; organic gate; never
 *              restamped / overwritten by scraped catalog input; CS may change
 *              its own owner_reported products, owner sources still to Daniel;
 *              an add of an owner catalog product → Daniel; catalog defence.
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
 *   cse1-cse28 dev-request 2026-11-26-cs-endring-som-eier-opplevagent: the
 *              owner's own request on an owner-claimed Opplevagent profile
 *              (AK1), nothing written without the owner's authority, other
 *              writers and the admin route still owner_locked, a forged owner
 *              context refused (AK2), the dry run reports locks (AK3), a
 *              failed map lookup writes nothing (AK4); address as one unit.
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
          // As mergeKnowledge: a products list replaces the stored one.
          if (Array.isArray(body.products)) db.prepare("UPDATE agent_knowledge SET products = ? WHERE agent_id = ?").run(JSON.stringify(body.products), decodeURIComponent(m[1]));
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
          const a = db.prepare(`SELECT a.id, a.name, k.phone, k.about, k.address, k.opening_hours, k.products FROM agents a LEFT JOIN agent_knowledge k ON k.agent_id = a.id WHERE a.id = ?`).get(decodeURIComponent(m[1])) as any;
          if (!a) return r(404, "{}");
          // As the real card: the stored opening hours list, when there is one.
          const { opening_hours: oh, products: pr, ...rest } = a;
          const hours = oh ? JSON.parse(oh) : [];
          const prods = pr ? JSON.parse(pr) : [];
          const card0 = Array.isArray(hours) && hours.length ? { ...rest, openingHours: hours } : rest;
          // As the real card: products by name (and category / price) when there are any.
          const card = Array.isArray(prods) && prods.length
            ? { ...card0, products: prods.map((p: any) => (typeof p === "string" ? { name: p } : { name: p.name, category: p.category, price: p.price })) }
            : card0;
          return r(200, JSON.stringify(staleSurface ? { id: a.id, name: a.name, phone: "22 22 22 22", about: "Gammel tekst om gården" } : card));
        }
        m = /^\/produsent\/(.+)$/.exec(path);
        if (m) {
          const a = (db.prepare(`SELECT a.id, a.name, a.is_active, a.catalog_hidden, k.phone, k.about, k.opening_hours, k.products FROM agents a LEFT JOIN agent_knowledge k ON k.agent_id = a.id`).all() as any[]).find((x) => slugify(x.name) === decodeURIComponent(m![1]));
          if (!a || a.is_active !== 1) return r(404, "Ikke funnet");
          const hoursText = a.opening_hours ? openingHoursText(JSON.parse(a.opening_hours)) : "";
          const prods = a.products ? JSON.parse(a.products) : [];
          const prodHtml = Array.isArray(prods) && prods.length ? `<ul>${prods.map((p: any) => `<li>${typeof p === "string" ? p : p.name}</li>`).join("")}</ul>` : "";
          return r(200, staleSurface ? `<h1>${a.name}</h1><p>22 22 22 22</p><p>Gammel tekst om gården</p>` : `<h1>${a.name}</h1><p>${a.phone}</p><p>${a.about}</p><p>${hoursText}</p>${prodHtml}`);
        }
        if (path.startsWith("/api/marketplace/search")) {
          const rows = db.prepare("SELECT id, name FROM agents WHERE is_active = 1 AND COALESCE(catalog_hidden, 0) = 0").all();
          return r(200, JSON.stringify({ results: rows }));
        }
        m = /^\/kategori\/gardssalg\/produsent\/(.+)$/.exec(path);
        if (m && host === "opplevagent.no") {
          const p = exp.prepare("SELECT * FROM experience_providers WHERE slug = ?").get(decodeURIComponent(m[1])) as any;
          if (!p || p.catalog_hidden === 1) return r(404, "Ikke funnet");
          // As the real page: the address line and LocalBusiness JSON-LD (streetAddress = adresse).
          const ld = { "@context": "https://schema.org", "@type": "LocalBusiness", name: p.navn, address: { "@type": "PostalAddress", streetAddress: p.adresse || undefined, addressLocality: p.poststed || undefined, addressCountry: "NO" } };
          const addr = [p.adresse, [p.postnummer, p.poststed].filter(Boolean).join(" ")].filter(Boolean).join(", ");
          return r(200, `<h1>${p.navn}</h1><p>${p.about_text ?? ""}</p>${addr ? `<p>${addr}</p>` : ""}<script type="application/ld+json">${JSON.stringify(ld)}</script>`);
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

      // ── cqp1-cqp12: products (Daniel 2026-11-22: CS removes and renames products itself) ──
      {
        mkAgent("ag-p", "Varegården", "post@varegarden.no", "https://varegarden.no");
        const original = [
          { name: "Gressfôra kjøtt", category: "meat", seasonal: false, price: "250/kg", priceUnit: "kr" },
          { name: "grønnsaksandeler", category: "other", seasonal: false },
          { name: "potet", category: "vegetables", seasonal: true, months: [8, 9] },
          { source: "enrichment", name: "egg", category: "eggs", seasonal: false },
        ];
        const setProducts = (id: string, list: unknown) => db.prepare("UPDATE agent_knowledge SET products = ? WHERE agent_id = ?").run(JSON.stringify(list), id);
        const productsOf = (id: string) => JSON.parse((db.prepare("SELECT products FROM agent_knowledge WHERE agent_id = ?").get(id) as any).products);
        const rawProducts = (id: string) => (db.prepare("SELECT products FROM agent_knowledge WHERE agent_id = ?").get(id) as any).products as string;
        const countRows = () => (db.prepare("SELECT COUNT(*) AS n FROM cs_change_requests").get() as any).n as number;
        setProducts("ag-p", original);
        const rawBefore = rawProducts("ag-p");
        const tP = mkThread("rfb", "post@varegarden.no");
        const pCreate = (products: unknown, extra: Record<string, unknown> = {}, targetId = "ag-p", requesterEmail = "post@varegarden.no", threadId: string | null = tP) =>
          create({ targetId, threadId, requesterEmail, products, ...extra } as any) as any;
        const knowledgePuts = (id: string) => calls.filter((c) => c.method === "PUT" && c.path === `/api/marketplace/agents/${id}/knowledge`).length;

        // AK1: remove one named product.
        const p1 = pCreate([{ action: "remove", name: "grønnsaksandeler" }]);
        ok(p1.ok && !p1.dryRun && p1.request.status === "queued", "cqp1a: a request to remove a named product is queued");
        await cq.runCsChangeRequests(deps());
        const p1row = R(p1.request.id);
        eq([p1row.status, productsOf("ag-p")], ["verified", [original[0], original[2], original[3]]],
          "cqp1 (AK1): the named product is gone, every other product is stored exactly as before, status verified");
        ok(calls.some((c) => /ag-p\/curated-fields$/.test(c.path) && c.body.field === "products" && c.body.meta?.by === "rfb-customer-service"),
          "cqp1b (AK1): products is locked (curated-fields, field products)");
        const p1put = calls.filter((c) => c.path === "/api/marketplace/agents/ag-p/knowledge").pop();
        eq([Array.isArray(p1put?.body?.products), p1put?.body?.products?.length, p1put?.body?.dataSource], [true, 3, "owner"], "cqp1c: the WHOLE list is written back (a list replaces the stored one)");
        const p1snap = JSON.parse(p1row.snapshot ?? "{}");
        eq(p1snap.products?.old, rawBefore, "cqp1d: the snapshot keeps the old list exactly as stored (rollback)");
        const p1verify = JSON.parse(p1row.steps).filter((x: any) => x.step === "verify").pop();
        eq(p1verify?.detail?.fields?.["vare «grønnsaksandeler» fjernes"], "fjernet_fra_siden", "cqp1e: verification read the page and the card: the product is gone");

        // AK2: unknown name → refused with a reason, nothing written.
        {
          const n0 = countRows();
          const puts0 = knowledgePuts("ag-p");
          const before = rawProducts("ag-p");
          const p2 = pCreate([{ action: "remove", name: "andelslandbruk" }]);
          const p2dry = pCreate([{ action: "remove", name: "Egg" }], { apply: false });
          await cq.runCsChangeRequests(deps());
          eq([p2.ok, p2.status, p2.error, p2.detail?.reason, p2.detail?.stored_names?.includes("egg"), p2dry.error],
            [false, 422, "product_not_found", "ukjent_vare", true, "product_not_found"],
            "cqp2 (AK2): an unknown name (also one that differs only in case) is refused with a reason and the stored names");
          eq([countRows() - n0, knowledgePuts("ag-p") - puts0, rawProducts("ag-p") === before], [0, 0, true], "cqp2b (AK2): nothing is written — no request row, no knowledge write, list unchanged");
        }

        // Rename happy path: the product keeps every other field.
        const p4 = pCreate([{ action: "rename", name: "potet", newName: "Potet (gulløye)" }]);
        await cq.runCsChangeRequests(deps());
        eq([R(p4.request.id).status, productsOf("ag-p")], ["verified", [original[0], { ...original[2], name: "Potet (gulløye)" }, original[3]]],
          "cqp4: rename → same product with the new name (category, months kept), the others unchanged, verified");
        const p4verify = JSON.parse(R(p4.request.id).steps).filter((x: any) => x.step === "verify").pop();
        eq(p4verify?.detail?.fields?.["vare «potet» → «Potet (gulløye)»"], "nytt_navn_vises_offentlig", "cqp4b: the new name shows on card and page, the old one is off the card");

        // Rename collision.
        {
          const before = rawProducts("ag-p");
          const p5 = pCreate([{ action: "rename", name: "Potet (gulløye)", newName: "EGG" }]);
          eq([p5.ok, p5.error, p5.detail?.reason, rawProducts("ag-p") === before], [false, "product_name_taken", "navnet_finnes_alt", true],
            "cqp5: a new name another product already has (any case) is refused, nothing written");
        }

        // Validation.
        {
          const n0 = countRows();
          const st = (x: any) => x.status;
          eq([
            st(pCreate([{ action: "add", name: "Honning" }])),
            st(pCreate([{ action: "rename", name: "egg", newName: "egg" }])),
            st(pCreate([{ action: "remove", name: " " }])),
            st(pCreate([{ action: "rename", name: "egg" }])),
            st(pCreate([{ action: "remove", name: "egg" }, { action: "remove", name: "egg" }])),
            st(pCreate([{ action: "remove", name: "x".repeat(201) }])),
            st(pCreate([])),
            st(pCreate("egg")),
            st(pCreate([{ action: "remove", name: "egg" }], { kind: "removal" })),
            st(cq.createChangeRequest({ vertical: "experiences", targetId: "ep-1", threadId: null, requesterEmail: "hei@siderivest.no", kind: "profile_update", createdBy: "claude", apply: false, products: [{ action: "remove", name: "Sider" }] } as any, { env: ON })),
            st(pCreate(undefined, { changes: { products: "egg" } })),
          ], [400, 400, 400, 400, 400, 400, 400, 400, 400, 422, 422],
            "cqp6: an add needs a category, a rename needs a different newName, names are non-empty and at most 200, no repeats, a list, profile_update and RFB only");
          eq(countRows(), n0, "cqp6b: none of them filed a request");
        }

        // AK3: products from the product import / the owner cannot be changed.
        {
          mkAgent("ag-po", "Eiergården", "post@eiergarden.no", "https://eiergarden.no");
          const imported = { name: "Lammelår", category: "meat", seasonal: false, price: "275/kg", source: "owner_import", sourceUrl: "https://eiergarden.no/butikk", fetchedAt: "2026-11-01T10:00:00Z", confirmedAt: "2026-11-02T10:00:00Z" };
          const scraped = { name: "Ull", category: "other", seasonal: false };
          setProducts("ag-po", [imported, scraped]);
          const before = rawProducts("ag-po");
          const tPo = mkThread("rfb", "post@eiergarden.no");
          const po = (products: unknown) => pCreate(products, {}, "ag-po", "post@eiergarden.no", tPo);
          const n0 = countRows();
          const a = po([{ action: "remove", name: "Lammelår" }]);
          const b = po([{ action: "rename", name: "Lammelår", newName: "Lammelår (frossen)" }]);
          const c = po([{ action: "remove", name: "Ull" }]);
          eq([a.status, a.error, a.detail?.route_to, a.detail?.why, b.error, c.error, c.detail?.why],
            [422, "product_owner_controlled", "daniel", "source:owner_import", "product_owner_controlled", "product_owner_controlled", "varelista_har_varer_fra_eier"],
            "cqp3 (AK3): an imported product can be neither removed nor renamed, and a list holding one is not rewritten — refused for Daniel");
          // An owner-set row in the product catalog (portal «Legg til vare» / stock).
          mkAgent("ag-pc", "Kataloggården", "post@kataloggarden.no", "https://kataloggarden.no");
          setProducts("ag-pc", [{ name: "Honning", category: "honey", seasonal: false }, { name: "Sylteøy", category: "other", seasonal: false }]);
          db.prepare("INSERT INTO products (id, agent_id, name, name_norm, source, availability_source) VALUES ('pr-1', 'ag-pc', 'Honning', 'honning', 'enrichment', 'producer_dashboard')").run();
          const tPc = mkThread("rfb", "post@kataloggarden.no");
          const d = pCreate([{ action: "remove", name: "Honning" }], {}, "ag-pc", "post@kataloggarden.no", tPc);
          // The owner saved the whole list in the portal (owner lock on products).
          mkAgent("ag-pl", "Låsgården", "post@lasgarden.no", "https://lasgarden.no");
          setProducts("ag-pl", [{ name: "Ost", category: "dairy", seasonal: false }]);
          db.prepare("UPDATE agent_knowledge SET curated_fields = ? WHERE agent_id = 'ag-pl'").run(JSON.stringify({ products: { locked_at: "2026-11-01T00:00:00Z", by: "owner" } }));
          const tPl = mkThread("rfb", "post@lasgarden.no");
          const e = pCreate([{ action: "remove", name: "Ost" }], {}, "ag-pl", "post@lasgarden.no", tPl);
          eq([d.error, d.detail?.why, e.error, e.detail?.why], ["product_owner_controlled", "katalog_lager:producer_dashboard", "product_owner_controlled", "varelista_laast_av_eier"],
            "cqp3b (AK3): a product the owner set in the portal's catalog, and a list the owner locked, are refused for Daniel");
          eq([countRows() - n0, rawProducts("ag-po") === before, knowledgePuts("ag-po") + knowledgePuts("ag-pc") + knowledgePuts("ag-pl")], [0, true, 0], "cqp3c (AK3): nothing written");
          // The sylteøy on the catalog farm is still CS's to remove.
          const f = pCreate([{ action: "remove", name: "Sylteøy" }], {}, "ag-pc", "post@kataloggarden.no", tPc);
          await cq.runCsChangeRequests(deps());
          eq([f.ok && R(f.request.id).status, productsOf("ag-pc").map((x: any) => x.name)], ["verified", ["Honning"]], "cqp3d: a scraped product beside an owner catalog row is removed");
        }

        // The list changed between filing and execution: fails with nothing written.
        {
          mkAgent("ag-pm", "Mellomgården", "post@mellomgarden.no", "https://mellomgarden.no");
          setProducts("ag-pm", [{ name: "Rips", category: "berries", seasonal: true }, { name: "Solbær", category: "berries", seasonal: true }]);
          const tPm = mkThread("rfb", "post@mellomgarden.no");
          const g = pCreate([{ action: "remove", name: "Rips" }], {}, "ag-pm", "post@mellomgarden.no", tPm);
          setProducts("ag-pm", [{ name: "Solbær", category: "berries", seasonal: true }, { name: "Rips", category: "berries", seasonal: true, source: "owner_manual", confirmedAt: "2026-11-22T10:00:00Z" }]);
          const before = rawProducts("ag-pm");
          await cq.runCsChangeRequests(deps());
          const gr = R(g.request.id);
          eq([gr.status, String(gr.status_reason).startsWith("varer: product_owner_controlled"), knowledgePuts("ag-pm"), rawProducts("ag-pm") === before],
            ["failed", true, 0, true], "cqp7: a list the owner changed after filing is re-checked at execution: failed with the reason, nothing written");
        }

        // A product change beside a field change, and a stale surface.
        {
          staleSurface = true;
          const h = pCreate([{ action: "remove", name: "egg" }], { changes: { about: "Vi selger kjøtt og poteter" } });
          await cq.runCsChangeRequests(deps());
          const stale = R(h.request.id).status;
          staleSurface = false;
          await cq.runCsChangeRequests(deps());
          const hr = R(h.request.id);
          eq([stale, hr.status, productsOf("ag-p").map((x: any) => x.name), (db.prepare("SELECT about FROM agent_knowledge WHERE agent_id = 'ag-p'").get() as any).about],
            ["executed", "verified", ["Gressfôra kjøtt", "Potet (gulløye)"], "Vi selger kjøtt og poteter"],
            "cqp8: products and a field in one request; not yet on the public card → stays executed, verified once it shows");
          eq(JSON.parse(hr.changes), { about: "Vi selger kjøtt og poteter", products: [{ action: "remove", name: "egg" }] }, "cqp8b: the ops are stored in changes under products");
        }

        // A list the write path would change (a price in another product's name) is not written.
        {
          mkAgent("ag-pn", "Prisgården", "post@prisgarden.no", "https://prisgarden.no");
          setProducts("ag-pn", [{ name: "Lammelår – kr 275/kg", category: "meat", seasonal: false }, { name: "Ull", category: "other", seasonal: false }]);
          const tPn = mkThread("rfb", "post@prisgarden.no");
          const before = rawProducts("ag-pn");
          const i = pCreate([{ action: "remove", name: "Ull" }], {}, "ag-pn", "post@prisgarden.no", tPn);
          await cq.runCsChangeRequests(deps());
          eq([R(i.request.id).status, String(R(i.request.id).status_reason).includes("skrivestien_ville_endret_andre_varer"), knowledgePuts("ag-pn"), rawProducts("ag-pn") === before], ["failed", true, 0, true],
            "cqp9: a write that would also change another product (price parsed out of its name) fails before anything is written");
        }

        // AK4: the listing shows the action and the product in plain text.
        {
          const prevKey2 = process.env.ADMIN_KEY;
          process.env.ADMIN_KEY = "test-admin-key";
          try {
            const q = await call("GET", "/change-requests?limit=500");
            const item = q.body.items.find((x: any) => x.id === p1.request.id);
            const item4 = q.body.items.find((x: any) => x.id === p4.request.id);
            eq([item?.changes_text, item4?.changes_text], [["fjern vare «grønnsaksandeler»"], ["endre navn på vare «potet» til «Potet (gulløye)»"]],
              "cqp10 (AK4): GET /admin/cs/change-requests shows the action and the product in plain text");
            const one = await call("GET", `/change-requests/${p1.request.id}`);
            eq(one.body?.request?.changes_text, ["fjern vare «grønnsaksandeler»"], "cqp10b (AK4): so does GET /change-requests/:id");
            const dry = await call("POST", "/change-requests", { vertical: "rfb", targetId: "ag-p", threadId: tP, requesterEmail: "post@varegarden.no", kind: "profile_update", products: [{ action: "remove", name: "Potet (gulløye)" }] });
            eq([dry.status, dry.body?.dryRun, dry.body?.plan?.products?.text, dry.body?.plan?.products?.after], [200, true, ["fjern vare «Potet (gulløye)»"], ["Gressfôra kjøtt"]],
              "cqp11: POST through the route is a dry run by default and shows the list after the change");
            const bad = await call("POST", "/change-requests", { vertical: "rfb", targetId: "ag-p", threadId: tP, requesterEmail: "post@varegarden.no", kind: "profile_update", products: [{ action: "remove", name: "x", extra: 1 }] });
            eq(bad.status, 400, "cqp11b: an unknown key in a product op is refused by the route");
          } finally {
            if (prevKey2 === undefined) delete process.env.ADMIN_KEY; else process.env.ADMIN_KEY = prevKey2;
          }
          eq(cq.describeChanges(JSON.stringify({ phone: "900 11 222", about: "" })), ["phone: «900 11 222»", "tøm about"], "cqp12: field changes read as before in plain text");
        }

        // ── cqa1-cqa12: add (dev-request 2026-11-25-cs-endringsforesporsel-kan-legge-til-varer) ──
        {
          const ks = require("./knowledge-service") as typeof import("./knowledge-service");
          const catalog = require("./product-catalog-sync") as typeof import("./product-catalog-sync");
          const catalogRow = (agentId: string, nameNorm: string) =>
            db.prepare("SELECT name, price_nok, category, source FROM products WHERE agent_id = ? AND name_norm = ?").get(agentId, nameNorm) as any;

          // AK1: add one product; the others are stored byte for byte as before.
          mkAgent("ag-a", "Nyvaregården", "post@leggtil.no", "https://leggtil.no");
          const aOrig = [
            { name: "Gressfôra kjøtt", category: "meat", seasonal: false, price: "250/kg", priceUnit: "kr" },
            { source: "enrichment", name: "egg", category: "eggs", seasonal: false },
          ];
          setProducts("ag-a", aOrig);
          const tA = mkThread("rfb", "post@leggtil.no");
          const aCreate = (products: unknown, extra: Record<string, unknown> = {}) => pCreate(products, extra, "ag-a", "post@leggtil.no", tA);
          const a1 = aCreate([{ action: "add", name: "Honning", category: "honey", price: "kr 120", unit: "glass" }, { action: "add", name: "Syltetøy", category: "preserves" }]);
          ok(a1.ok && !a1.dryRun && a1.request.status === "queued", "cqa1a: a request to add products is queued");
          await cq.runCsChangeRequests(deps());
          const a1row = R(a1.request.id);
          const aList = productsOf("ag-a");
          eq([a1row.status, aList.length], ["verified", 4], "cqa1 (AK1): added and verified on card and page");
          eq(aList.slice(0, 2).map((p: unknown) => JSON.stringify(p)), aOrig.map((p) => JSON.stringify(p)), "cqa1b (AK1): every other product is stored byte for byte as before");
          eq(aList.slice(2), [
            { name: "Honning", category: "honey", seasonal: false, price: "kr 120", unit: "glass", source: "owner_reported", reportedVia: `cs_change_request:${a1.request.id}` },
            { name: "Syltetøy", category: "preserves", seasonal: false, source: "owner_reported", reportedVia: `cs_change_request:${a1.request.id}` },
          ], "cqa1c (AK1): right name and category, source owner_reported with the request id; the price verbatim, and none when the owner gave none");
          ok(calls.some((c) => /ag-a\/curated-fields$/.test(c.path) && c.body.field === "products" && c.body.meta?.by === "rfb-customer-service"),
            "cqa1d (AK3): products is locked after the add (the lock enrichment honours)");
          const a1verify = JSON.parse(a1row.steps).filter((x: any) => x.step === "verify").pop();
          eq(a1verify?.detail?.fields?.["vare «Honning» legges til"], "ny_vare_vises_offentlig", "cqa1e: verification read the new product on card and page");
          eq(cq.describeChanges(a1row.changes), ["legg til vare «Honning» (honey, pris «kr 120», enhet «glass»)", "legg til vare «Syltetøy» (preserves, uten pris)"],
            "cqa1f: the listing shows the add in plain text");
          // The real admin write path (non-owner upsertKnowledge) stores the planned list unchanged.
          {
            ks.knowledgeService.upsertKnowledge("ag-a", { products: aList, dataSource: "owner" } as any);
            const canon = (list: any[]) => list.map((p) => JSON.stringify(Object.fromEntries(Object.keys(p).sort().map((k) => [k, p[k]]))));
            eq(canon(productsOf("ag-a")), canon(aList), "cqa1g (AK3): the admin knowledge write keeps owner_reported (not restamped to enrichment)");
          }

          // AK1: remove + add in one request («bytt ut lista»), dry run first.
          mkAgent("ag-s", "Byttegården", "post@byttegarden.no", "https://byttegarden.no");
          const sOrig = [{ name: "Ved", category: "other", seasonal: false }, { name: "Poteter", category: "vegetables", seasonal: true, months: [8, 9] }];
          setProducts("ag-s", sOrig);
          const sRawBefore = rawProducts("ag-s");
          const tS = mkThread("rfb", "post@byttegarden.no");
          const sOps = [
            { action: "remove", name: "Ved" },
            { action: "remove", name: "Poteter" },
            { action: "add", name: "Geitost", category: "dairy" },
            { action: "add", name: "Eplemost", category: "beverages" },
          ];
          {
            const n0 = countRows();
            const dry = pCreate(sOps, { apply: false }, "ag-s", "post@byttegarden.no", tS);
            eq([dry.ok, dry.dryRun, dry.plan?.products?.after, dry.plan?.products?.added?.map((p: any) => [p.name, p.category, p.source]), countRows() - n0, rawProducts("ag-s") === sRawBefore],
              [true, true, ["Geitost", "Eplemost"], [["Geitost", "dairy", "owner_reported"], ["Eplemost", "beverages", "owner_reported"]], 0, true],
              "cqa2a: the dry run (the default) shows the list as it will be and writes nothing");
          }
          const s1 = pCreate(sOps, {}, "ag-s", "post@byttegarden.no", tS);
          await cq.runCsChangeRequests(deps());
          const s1row = R(s1.request.id);
          eq([s1row.status, productsOf("ag-s").map((p: any) => [p.name, p.category, p.source])], ["verified", [["Geitost", "dairy", "owner_reported"], ["Eplemost", "beverages", "owner_reported"]]],
            "cqa2 (AK1): remove + add in one request gives the new list");
          // AK5: undo with the snapshot.
          {
            const snap = JSON.parse(s1row.snapshot ?? "{}");
            eq(snap.products?.old, sRawBefore, "cqa3 (AK5): the snapshot keeps the old list exactly as stored");
            db.prepare("UPDATE agent_knowledge SET products = ? WHERE agent_id = 'ag-s'").run(snap.products.old);
            eq([rawProducts("ag-s") === sRawBefore, productsOf("ag-s")], [true, sOrig], "cqa3b (AK5): writing the snapshot back gives the old list");
          }

          // A name a later add brings back (remove + add with another category) verifies.
          {
            mkAgent("ag-r", "Omgården", "post@omgarden.no", "https://omgarden.no");
            setProducts("ag-r", [{ name: "Sylteøy", category: "other", seasonal: false }]);
            const tR = mkThread("rfb", "post@omgarden.no");
            const r1 = pCreate([{ action: "remove", name: "Sylteøy" }, { action: "add", name: "Sylteøy", category: "preserves" }], {}, "ag-r", "post@omgarden.no", tR);
            await cq.runCsChangeRequests(deps());
            const rv = JSON.parse(R(r1.request.id).steps).filter((x: any) => x.step === "verify").pop();
            eq([R(r1.request.id).status, productsOf("ag-r").map((p: any) => [p.name, p.category, p.source]), rv?.detail?.fields?.["vare «Sylteøy» fjernes"]],
              ["verified", [["Sylteøy", "preserves", "owner_reported"]], "erstattet_av_ny_vare"],
              "cqa4: remove «x» + add «x» (new category) → one product, verified");
          }

          // AK2: refused, nothing written.
          {
            const n0 = countRows();
            const puts0 = knowledgePuts("ag-a");
            const before = rawProducts("ag-a");
            const add = (o: Record<string, unknown>) => ({ action: "add", name: "Gardskunst", category: "other", ...o });
            const dup = aCreate([add({ name: "Egg" })]);
            const dupAfterOther = aCreate([{ action: "remove", name: "Syltetøy" }, add({ name: "honning" })]);
            const st = (x: any) => [x.status, x.error];
            eq([dup.status, dup.error, dup.detail?.reason, dupAfterOther.error], [422, "product_name_taken", "navnet_finnes_alt", "product_name_taken"],
              "cqa5 (AK2): a name already in the list (any case) → product_name_taken");
            const eleven = Array.from({ length: 11 }, (_, i) => add({ name: `Vare ${i + 1}` }));
            const unknownCat = aCreate([add({ category: "kosmetikk" })]);
            eq([
              st(unknownCat),
              st(aCreate([add({ category: undefined })])),
              st(aCreate([add({ name: "" })])),
              st(aCreate([add({ name: " Gardskunst" })])),
              st(aCreate([add({ name: "Gard\nskunst" })])),
              st(aCreate([add({ name: "x".repeat(201) })])),
              st(aCreate(eleven)),
              st(aCreate([add({ price: "gratis" })])),
              st(aCreate([add({ price: "" })])),
              st(aCreate([add({ price: 120 })])),
              st(aCreate([add({ unit: "" })])),
              st(aCreate([add({ name: "Honning – kr 120" })])),
              st(aCreate([add({ name: "HONNING" })])),
              st(aCreate([add({ newName: "x" })])),
              st(aCreate([add({}), add({ name: "gardskunst" })])),
              st(aCreate([{ action: "remove", name: "egg", category: "eggs" }])),
            ], [
              ...Array.from({ length: 16 }, () => [400, "invalid_products"]),
            ], "cqa6 (AK2): unknown or missing category, empty / untrimmed / control-char / too long name, more than 10 ops, a price that is no price, an empty unit, a price or header in the name, stray fields, a repeated add → 400");
            ok(Array.isArray(unknownCat.detail?.categories) && unknownCat.detail.categories.includes("honey"), "cqa6b: an unknown category is answered with the allowed list");
            eq([countRows() - n0, knowledgePuts("ag-a") - puts0, rawProducts("ag-a") === before], [0, 0, true], "cqa6c (AK2): nothing is written — no request row, no knowledge write, list unchanged");
          }

          // Organic gate: an organic product of a producer without a valid Debio status is refused.
          {
            const prevGate = process.env.RFB_ORGANIC_CLAIM_GATE;
            process.env.RFB_ORGANIC_CLAIM_GATE = "1";
            try {
              const n0 = countRows();
              const before = rawProducts("ag-a");
              const o1 = aCreate([{ action: "add", name: "Økologisk lammekjøtt", category: "meat" }]);
              eq([o1.status, o1.error, o1.detail?.route_to, countRows() - n0, rawProducts("ag-a") === before], [422, "write_path_would_change_list", "daniel", 0, true],
                "cqa7: the organic gate applies to new products: refused for Daniel, nothing written");
            } finally {
              if (prevGate === undefined) delete process.env.RFB_ORGANIC_CLAIM_GATE; else process.env.RFB_ORGANIC_CLAIM_GATE = prevGate;
            }
          }

          // The route: add with its fields passes the strict schema; >10 ops and stray keys are refused.
          {
            const prevKey3 = process.env.ADMIN_KEY;
            process.env.ADMIN_KEY = "test-admin-key";
            try {
              const dry = await call("POST", "/change-requests", { vertical: "rfb", targetId: "ag-a", threadId: tA, requesterEmail: "post@leggtil.no", kind: "profile_update", products: [{ action: "add", name: "Gardskunst", category: "other", price: "fra kr 200", unit: "stk" }] });
              eq([dry.status, dry.body?.dryRun, dry.body?.plan?.products?.after?.slice(-1), dry.body?.plan?.products?.added?.[0]?.price], [200, true, ["Gardskunst"], "fra kr 200"],
                "cqa8: POST through the route: add is a dry run by default and shows the list after");
              const bad = await call("POST", "/change-requests", { vertical: "rfb", targetId: "ag-a", threadId: tA, requesterEmail: "post@leggtil.no", kind: "profile_update", products: [{ action: "add", name: "Gardskunst", category: "other", seasonal: true }] });
              const many = await call("POST", "/change-requests", { vertical: "rfb", targetId: "ag-a", threadId: tA, requesterEmail: "post@leggtil.no", kind: "profile_update", products: Array.from({ length: 11 }, (_, i) => ({ action: "add", name: `V${i}`, category: "other" })) });
              eq([bad.status, many.status], [400, 400], "cqa8b: an unknown key in an add op, and more than 10 ops, are refused by the route");
            } finally {
              if (prevKey3 === undefined) delete process.env.ADMIN_KEY; else process.env.ADMIN_KEY = prevKey3;
            }
          }

          // AK3: never restamped, never overwritten by enrichment input in the catalog.
          {
            const now = "2026-11-25T12:00:00.000Z";
            const rep = { name: "Honning", category: "honey", seasonal: false, price: "kr 120", source: "owner_reported" as const, reportedVia: "cs_change_request:chg-1" };
            const [kept, confirmed, forged] = ks.stampProductSources([rep, { ...rep, confirmedAt: now }, { ...rep, reportedVia: "enrichment-run" }], false, now);
            eq([kept === rep, confirmed, forged.source], [true, rep, "enrichment"],
              "cqa9 (AK3): stampProductSources off the owner path keeps owner_reported (drops a confirmation); without a CS reportedVia it is enrichment");
            const [owned] = ks.stampProductSources([rep], true, now);
            eq(owned, { name: "Honning", category: "honey", seasonal: false, price: "kr 120", source: "owner_manual", confirmedAt: now }, "cqa9b: the owner saving it in the portal makes it owner_manual");
            ok(!(ks.OWNER_PRODUCT_SOURCES as readonly string[]).includes("owner_reported") && (ks.PRODUCT_SOURCES as readonly string[]).includes("owner_reported"),
              "cqa9c: owner_reported is a product source, not one of the owner sources CS must leave alone");

            mkAgent("ag-ac", "Kataloggården to", "post@katalog2.no", "https://katalog2.no");
            setProducts("ag-ac", [rep, { name: "Egg", category: "eggs", seasonal: false, price: "kr 50" }]);
            catalog.runProductCatalogSync(db, { agentId: "ag-ac" });
            eq(catalogRow("ag-ac", "honning"), { name: "Honning", price_nok: 120, category: "honey", source: "owner_reported" }, "cqa10 (AK3): the catalog sync writes source owner_reported (not enrichment)");
            // Scraped input for the same product (no source, another price and category).
            setProducts("ag-ac", [{ name: "Honning", category: "other", seasonal: false, price: "kr 300" }, { name: "Egg", category: "eggs", seasonal: false, price: "kr 60" }]);
            catalog.runProductCatalogSync(db, { agentId: "ag-ac" });
            eq([catalogRow("ag-ac", "honning"), catalogRow("ag-ac", "egg")?.price_nok], [{ name: "Honning", price_nok: 120, category: "honey", source: "owner_reported" }, 60],
              "cqa10b (AK3): scraped input never overwrites an owner_reported catalog row (an enrichment row still updates)");
            // The owner's own word (owner_reported again) still updates it.
            setProducts("ag-ac", [{ ...rep, price: "kr 140" }]);
            catalog.runProductCatalogSync(db, { agentId: "ag-ac" });
            eq(catalogRow("ag-ac", "honning")?.price_nok, 140, "cqa10c: a new owner_reported price updates the row");
          }

          // AK4: CS may later rename / remove an owner_reported product; owner sources and a locked list still go to Daniel.
          {
            catalog.runProductCatalogSync(db, { agentId: "ag-a" }); // the catalog now has owner_reported rows for ag-a
            const ren = aCreate([{ action: "rename", name: "Honning", newName: "Lynghonning" }]);
            await cq.runCsChangeRequests(deps());
            const renamed = productsOf("ag-a").find((p: any) => p.name === "Lynghonning");
            eq([R(ren.request.id).status, renamed?.source, renamed?.price], ["verified", "owner_reported", "kr 120"], "cqa11 (AK4): CS renames an owner_reported product (source and price kept)");
            const rem = aCreate([{ action: "remove", name: "Lynghonning" }, { action: "remove", name: "egg" }]);
            await cq.runCsChangeRequests(deps());
            eq([R(rem.request.id).status, productsOf("ag-a").map((p: any) => p.name)], ["verified", ["Gressfôra kjøtt", "Syltetøy"]],
              "cqa11b (AK4): CS removes an owner_reported product, and owner_reported products do not block the rest of the list");

            mkAgent("ag-am", "Manuellgården", "post@manuell.no", "https://manuell.no");
            setProducts("ag-am", [{ name: "Ost", category: "dairy", seasonal: false, source: "owner_manual", confirmedAt: "2026-11-01T00:00:00Z" }, { name: "Ull", category: "other", seasonal: false }]);
            const tAm = mkThread("rfb", "post@manuell.no");
            const am = (products: unknown) => pCreate(products, {}, "ag-am", "post@manuell.no", tAm);
            const m1 = am([{ action: "remove", name: "Ost" }]);
            const m2 = am([{ action: "add", name: "Smør", category: "dairy" }]);
            const tPo2 = mkThread("rfb", "post@eiergarden.no");
            const i1 = pCreate([{ action: "add", name: "Lammeskank", category: "meat" }], {}, "ag-po", "post@eiergarden.no", tPo2);
            const i2 = pCreate([{ action: "rename", name: "Lammelår", newName: "Lammelår (fersk)" }], {}, "ag-po", "post@eiergarden.no", tPo2);
            const tPl2 = mkThread("rfb", "post@lasgarden.no");
            const l1 = pCreate([{ action: "add", name: "Smør", category: "dairy" }], {}, "ag-pl", "post@lasgarden.no", tPl2);
            const sum = (x: any) => [x.status, x.error, x.detail?.route_to, x.detail?.why];
            eq([sum(m1), sum(m2), sum(i1), sum(i2), sum(l1)], [
              [422, "product_owner_controlled", "daniel", "source:owner_manual"],
              [422, "product_owner_controlled", "daniel", "varelista_har_varer_fra_eier"],
              [422, "product_owner_controlled", "daniel", "varelista_har_varer_fra_eier"],
              [422, "product_owner_controlled", "daniel", "source:owner_import"],
              [422, "product_owner_controlled", "daniel", "varelista_laast_av_eier"],
            ], "cqa12 (AK4): owner_manual / owner_import products, a list holding them and an owner-locked list still go to Daniel — also for add");
          }

          // B1: an add of a name the owner set in the catalog (portal «Legg til vare» / stock) goes to Daniel.
          {
            mkAgent("ag-ab", "Portalgården", "post@portalgarden.no", "https://portalgarden.no");
            setProducts("ag-ab", [{ name: "Ull", category: "other", seasonal: false }]);
            db.prepare("INSERT INTO products (id, agent_id, name, name_norm, price_nok, category, source, availability_source) VALUES ('pr-ab1', 'ag-ab', 'Smør', 'smør', 150, 'dairy', 'owner', 'producer_dashboard')").run();
            const tAb = mkThread("rfb", "post@portalgarden.no");
            const n0 = countRows();
            const before = rawProducts("ag-ab");
            const b1 = pCreate([{ action: "add", name: "Smør", category: "dairy", price: "kr 90" }], {}, "ag-ab", "post@portalgarden.no", tAb);
            const b2 = pCreate([{ action: "add", name: "smør", category: "other" }], { apply: false }, "ag-ab", "post@portalgarden.no", tAb);
            await cq.runCsChangeRequests(deps());
            eq([b1.status, b1.error, b1.detail?.route_to, b1.detail?.why, b1.detail?.name, b2.error, countRows() - n0, rawProducts("ag-ab") === before],
              [422, "product_owner_controlled", "daniel", "katalog_source:owner", "Smør", "product_owner_controlled", 0, true],
              "cqa13 (B1): an add of a product the owner added in the portal (only in the catalog) is refused for Daniel, nothing written");
            catalog.runProductCatalogSync(db, { agentId: "ag-ab" });
            eq(catalogRow("ag-ab", "smør"), { name: "Smør", price_nok: 150, category: "dairy", source: "owner" }, "cqa13b (B1): the owner's catalog price stays");
          }

          // Defence in depth: incoming owner_reported never overwrites what the owner set in the catalog.
          {
            mkAgent("ag-ad", "Forsvarsgården", "post@forsvar.no", "https://forsvar.no");
            const ins = db.prepare("INSERT INTO products (id, agent_id, name, name_norm, price_nok, category, source, availability_source, owner_confirmed_at) VALUES (?, 'ag-ad', ?, ?, ?, 'dairy', ?, ?, ?)");
            ins.run("pr-d1", "Smør", "smør", 150, "owner", "enrichment", null);
            ins.run("pr-d2", "Ost", "ost", 150, "owner_manual", "enrichment", null);
            ins.run("pr-d3", "Rømme", "rømme", 150, "enrichment", "producer_dashboard", null);
            ins.run("pr-d4", "Fløte", "fløte", 150, "enrichment", "admin_producer_confirmed", null);
            ins.run("pr-d5", "Kefir", "kefir", 150, "enrichment", "enrichment", "2026-11-01T00:00:00Z");
            ins.run("pr-d6", "Myse", "myse", 150, "enrichment", "enrichment", null);
            const rep = (name: string) => ({ name, category: "other", seasonal: false, price: "kr 90", source: "owner_reported", reportedVia: "cs_change_request:chg-x" });
            setProducts("ag-ad", ["Smør", "Ost", "Rømme", "Fløte", "Kefir", "Myse"].map(rep));
            catalog.runProductCatalogSync(db, { agentId: "ag-ad" });
            const pr = (n: string) => { const r = catalogRow("ag-ad", n); return [r?.price_nok, r?.source]; };
            eq([pr("smør"), pr("ost"), pr("rømme"), pr("fløte"), pr("kefir"), pr("myse")],
              [[150, "owner"], [150, "owner_manual"], [150, "enrichment"], [150, "enrichment"], [150, "enrichment"], [90, "owner_reported"]],
              "cqa14: the catalog sync never lets owner_reported replace an owner row, owner stock, an admin-confirmed price or an owner confirmation (an enrichment row still updates)");
          }

          // N2: an added product not yet on the public surfaces stays executed.
          {
            mkAgent("ag-av", "Ventegården", "post@ventegarden.no", "https://ventegarden.no");
            setProducts("ag-av", []);
            const tAv = mkThread("rfb", "post@ventegarden.no");
            const v1 = pCreate([{ action: "add", name: "Rabarbra", category: "vegetables" }], {}, "ag-av", "post@ventegarden.no", tAv);
            staleSurface = true;
            await cq.runCsChangeRequests(deps());
            staleSurface = false;
            const vStale = R(v1.request.id);
            const vStep = JSON.parse(vStale.steps).filter((x: any) => x.step === "verify").pop();
            eq([vStale.status, vStep?.detail?.fields?.["vare «Rabarbra» legges til"]], ["executed", "ikke_synlig_ennaa"],
              "cqa15: an add stored but not yet on card / page stays executed (ikke_synlig_ennaa)");
            await cq.runCsChangeRequests(deps());
            eq(R(v1.request.id).status, "verified", "cqa15b: verified once it shows");
          }
        }
      }

      // ── dev-request 2026-11-26-cs-endring-som-eier-opplevagent ───────
      // The owner's own request on an owner-claimed Opplevagent profile;
      // address as one unit (street, postnummer, poststed, map point); the
      // dry run reports locks. The geocoder is stubbed (no outbound calls).
      {
        const store = require("./experience-store") as typeof import("./experience-store");
        const au = require("./opplevagent-address-unit") as typeof import("./opplevagent-address-unit");
        const geoCalls: Array<{ street: string; postnummer: string; poststed: string }> = [];
        let geoAnswer: { lat: number; lon: number; confidence: string } | null = { lat: 59.9155, lon: 10.7351, confidence: "high" };
        const geocode: import("./cs-change-requests").AddressGeocoder = async (a) => { geoCalls.push(a); return geoAnswer; };
        const gdeps = () => deps({ geocode });
        const OWNER_LOCKS = JSON.stringify({ owner_locks: { about_text: { locked_at: "2026-11-01T00:00:00Z", by: "owner" } } });
        const mkExp = (id: string, navn: string, epost: string, site: string, slug: string, contentSource: string | null, fp: string | null = null) => {
          exp.prepare(
            `INSERT INTO experience_providers (id, navn, epost, hjemmeside, slug, content_source, adresse, postnummer, poststed, lat, lon, about_text, field_provenance)
             VALUES (?, ?, ?, ?, ?, ?, 'Gamleveien 1', '0150', 'Oslo', 59.9100, 10.7500, 'Gammel tekst om bryggeriet', ?)`,
          ).run(id, navn, epost, site, slug, contentSource, fp);
        };
        mkExp("ep-own", "Ølsmia Test", "post@olsmia.no", "https://olsmia.no", "olsmia-test--own", "claim", OWNER_LOCKS);
        mkExp("ep-man", "Manuellgården", "post@manuellgarden.no", "https://manuellgarden.no", "manuellgarden--man", "manual");
        const cols = (id: string) => exp.prepare("SELECT adresse, postnummer, poststed, lat, lon FROM experience_providers WHERE id = ?").get(id) as any;
        const auditFor = (id: string) => exp.prepare("SELECT field_name, new_value, source_url FROM gardssalg_content_audit WHERE provider_id = ? ORDER BY rowid").all(id) as any[];
        const expCreate = (targetId: string, from: string, thread: string | null, changes: Record<string, string>, apply = true) =>
          cq.createChangeRequest({ vertical: "experiences", targetId, threadId: thread, requesterEmail: from, kind: "profile_update", createdBy: "claude", apply, changes }, { env: ON }) as any;

        // parse: one unit, venue name tolerated, refusals.
        const pu = (v: string) => { const x = au.parseAddressUnit(v); return x.ok ? [x.street, x.postnummer, x.poststed, x.ignored] : x.reason; };
        eq([pu("Universitetsgata 2, 0164 Oslo"), pu("Rebel, Universitetsgata 2, 0164 Oslo, Norge"), pu("Universitetsgata 2 0164 Oslo")],
          [["Universitetsgata 2", "0164", "Oslo", []], ["Universitetsgata 2", "0164", "Oslo", ["Rebel"]], ["Universitetsgata 2", "0164", "Oslo", []]],
          "cse1: «gate, postnummer poststed» is one unit; a leading venue name is not stored in adresse; a trailing «Norge» is dropped");
        eq([pu("Universitetsgata 2"), pu("Postboks 12, 0164 Oslo"), pu("Universitetsgata 2, 9999 Oslo"), pu("Universitetsgata 2, 0164 Bergen")],
          ["adresse_mangler_postnummer_og_poststed", "postboks_er_ikke_besoksadresse", "postnummer_ukjent:9999", "poststed_passer_ikke_postnummer:0164=OSLO"],
          "cse2: no postnummer, a post box, an unknown postnummer, a place that is not the postnummer's → refused");

        // AK3 (+ dry run of the owner path): what each field's write will do.
        const tOwn = mkThread("experiences", "post@olsmia.no");
        const tNabo = mkThread("experiences", "naboen@example.no");
        const dOwn = expCreate("ep-own", "post@olsmia.no", tOwn, { address: "Rebel, Universitetsgata 2, 0164 Oslo", email: "post@olsmia.no" }, false);
        eq([dOwn.plan.would_be, dOwn.plan.fields, dOwn.plan.address_unit?.adresse, dOwn.plan.address_unit?.postnummer, dOwn.plan.address_unit?.ikke_lagret],
          ["queued", { address: "owner_request", email: "ok" }, "Universitetsgata 2", "0164", ["Rebel"]],
          "cse3: dry run from the registered address on an owner-claimed profile → address owner_request, e-mail ok, queued; the unit and the dropped venue name shown");
        const dNabo = expCreate("ep-own", "naboen@example.no", tNabo, { address: "Universitetsgata 2, 0164 Oslo", name: "Ølsmia" }, false);
        ok(dNabo.plan.would_be === "approval_needed" && String(dNabo.plan.fields?.address).startsWith("locked: adresse: eier-overtatt profil")
          && String(dNabo.plan.fields?.name).startsWith("locked: navn:") && dNabo.plan.reason === "avsender_ikke_profilens_adresse",
          `cse4 (AK3): a field that would be stopped says locked: <reason> and would_be approval_needed, not queued (got ${JSON.stringify(dNabo.plan.fields)} ${dNabo.plan.would_be})`);
        const dPlain = expCreate("ep-1", "hei@siderivest.no", mkThread("experiences", "hei@siderivest.no"), { about_text: "Velkommen til sideriet vårt" }, false);
        eq([dPlain.plan.fields, dPlain.plan.would_be], [{ about_text: "ok" }, "queued"], "cse5: a field no lock stops → ok");
        eq([expCreate("ep-own", "post@olsmia.no", tOwn, { address: "Universitetsgata 2, 9999 Oslo" }, false).error, expCreate("ep-own", "post@olsmia.no", tOwn, { address: "Universitetsgata 2" }, false).detail?.reason],
          ["invalid_address", "adresse_mangler_postnummer_og_poststed"], "cse6: an invalid address unit is refused already in the dry run");

        // AK4: the map lookup fails → nothing of the four columns (or the point) changes.
        const before = cols("ep-own");
        const nAudit = auditFor("ep-own").length;
        geoAnswer = null;
        const f1 = expCreate("ep-own", "post@olsmia.no", tOwn, { address: "Universitetsgata 2, 0164 Oslo" });
        await cq.runCsChangeRequests(gdeps());
        eq([R(f1.request.id).status, cols("ep-own"), auditFor("ep-own").length], ["failed", before, nAudit],
          "cse7 (AK4): failed map lookup → request failed, adresse/postnummer/poststed/lat/lon unchanged, no audit row");
        ok(String(R(f1.request.id).status_reason).includes("kartoppslaget fant ikke"), "cse7b: the reason says the map lookup found nothing");
        geoAnswer = { lat: 0, lon: 0, confidence: "high" };
        const f2 = expCreate("ep-own", "post@olsmia.no", tOwn, { address: "Universitetsgata 2, 0164 Oslo", name: "Ølsmia Bryggeri" });
        await cq.runCsChangeRequests(gdeps());
        eq([R(f2.request.id).status, cols("ep-own"), (exp.prepare("SELECT navn FROM experience_providers WHERE id = 'ep-own'").get() as any).navn], ["failed", before, "Ølsmia Test"],
          "cse8 (AK4): a point outside Norway counts as a failed lookup — nothing written, not even the other field");

        // AK1: the owner's own address change → verified, all four columns and the point changed.
        geoAnswer = { lat: 59.9155, lon: 10.7351, confidence: "high" };
        const nCalls = calls.length;
        const a1 = expCreate("ep-own", "post@olsmia.no", tOwn, { address: "Universitetsgata 2, 0164 Oslo" });
        eq([a1.request.status, a1.request.authority], ["queued", "registered_email"], "cse9: filed from the registered address → queued");
        await cq.runCsChangeRequests(gdeps());
        const a1r = R(a1.request.id);
        eq([a1r.status, cols("ep-own")], ["verified", { adresse: "Universitetsgata 2", postnummer: "0164", poststed: "Oslo", lat: 59.9155, lon: 10.7351 }],
          "cse10 (AK1): address change from the registered e-mail on an owner-claimed profile → verified; street, postnummer, poststed and map point changed");
        const src1 = `owner-request via cs-change-request ${a1.request.id}`;
        const aud1 = auditFor("ep-own").filter((x) => x.source_url === src1);
        eq(aud1.map((x) => [x.field_name, x.new_value]), [["adresse", "Universitetsgata 2"], ["postnummer", "0164"], ["poststed", "Oslo"]],
          "cse11: one audit row per address column, source «owner-request via cs-change-request <id>»");
        const fp1 = JSON.parse((exp.prepare("SELECT field_provenance FROM experience_providers WHERE id = 'ep-own'").get() as any).field_provenance);
        ok(fp1.adresse?.source_url === src1 && fp1.postnummer?.source_url === src1 && fp1.poststed?.source_url === src1 && !!fp1.owner_locks?.about_text,
          "cse12: field_provenance for adresse/postnummer/poststed says owner-request; the owner's own locks are kept");
        const snap1 = JSON.parse(a1r.snapshot!).address;
        eq([snap1.old, snap1.old_columns?.adresse, snap1.old_columns?.postnummer, snap1.old_columns?.poststed, snap1.old_columns?.lat, snap1.old_columns?.lon, snap1.new?.lat],
          ["Gamleveien 1", "Gamleveien 1", "0150", "Oslo", 59.91, 10.75, 59.9155], "cse13: the snapshot keeps all old columns and the old point (rollback)");
        const vStep = JSON.parse(a1r.steps).filter((x: any) => x.step === "verify").pop();
        ok(String(vStep?.detail?.fields?.address).includes("JSON-LD"), "cse14: verified on the public page's JSON-LD streetAddress");
        ok(!calls.slice(nCalls).some((c) => c.path.endsWith("gardssalg-set-address")), "cse15: the owner path never calls the admin address route");
        eq(geoCalls[geoCalls.length - 1], { street: "Universitetsgata 2", postnummer: "0164", poststed: "Oslo" }, "cse16: the map point is looked up for exactly the unit");

        // Owner path for the other locked fields: name (claim row) and about_text (owner_locks).
        const aboutNew = "Ølsmia er et lite bryggeri på Grünerløkka i Oslo. Vi brygger øl i små batcher og tar imot besøk til smaking i bryggeriet.";
        const n1 = expCreate("ep-own", "post@olsmia.no", tOwn, { name: "Ølsmia Bryggeri", about_text: aboutNew });
        await cq.runCsChangeRequests(gdeps());
        const n1r = R(n1.request.id);
        const row1 = exp.prepare("SELECT navn, about_text FROM experience_providers WHERE id = 'ep-own'").get() as any;
        eq([n1r.status, row1.navn, row1.about_text], ["verified", "Ølsmia Bryggeri", aboutNew], "cse17: name and an owner-locked about_text from the owner → written as the owner's own, verified");
        eq(auditFor("ep-own").filter((x) => x.source_url === `owner-request via cs-change-request ${n1.request.id}`).map((x) => x.field_name), ["navn", "about_text"],
          "cse18: their audit rows say owner-request via cs-change-request <id>");
        ok(calls.some((c) => c.path.endsWith("gardssalg-set-field-lock") && c.body.provider_id === "ep-own" && c.body.field === "about_text"), "cse19: the content field is locked after the write, as before");

        // AK2: without the owner's authority nothing is written.
        const beforeNabo = cols("ep-own");
        const x1 = expCreate("ep-own", "naboen@example.no", tNabo, { address: "Storgata 1, 0155 Oslo" });
        eq([x1.request.status, x1.request.status_reason], ["approval_needed", "avsender_ikke_profilens_adresse"], "cse20 (AK2): wrong sender → approval queue");
        crm.crmService.ingestThread({ threadId: "kontakt-cse-1", subject: "[Kontaktskjema] ny adresse", category: "innkommende", messages: [{ messageId: "kontakt-cse-1-in", direction: "in", fromEmail: "post@olsmia.no", sentAt: ago(1) }] }, "post@olsmia.no", "experiences");
        const x2 = expCreate("ep-own", "post@olsmia.no", "kontakt-cse-1", { address: "Storgata 1, 0155 Oslo" });
        eq([x2.request.status, x2.request.status_reason], ["approval_needed", "kontaktskjema"], "cse21 (AK2): the contact form → approval queue");
        await cq.runCsChangeRequests(gdeps());
        eq(cols("ep-own"), beforeNabo, "cse22 (AK2): neither is written");
        // Even approved by Daniel, a request without the owner's authority meets the lock.
        cq.approveChangeRequest(x1.request.id);
        await cq.runCsChangeRequests(gdeps());
        const x1r = R(x1.request.id);
        const x1w = JSON.parse(x1r.steps).find((x: any) => x.step === "write_address");
        eq([x1r.status, x1w?.detail?.mode, x1w?.detail?.result?.reason, cols("ep-own")], ["failed", "admin", "owner_locked", beforeNabo],
          "cse23 (AK2): an approved request without owner authority is written as admin and stopped by owner_locked; nothing changed");
        // The enrichment write path and the plain admin writer still meet the lock.
        eq(store.applyGardssalgProviderAddress("ep-own", { adresse: "Storgata 1", postnummer: "0155", poststed: "Oslo" }, "https://example.no/kontakt"), [],
          "cse24 (AK2): enrichment's address writer writes nothing on an owner-claimed row");
        const ownRow = exp.prepare("SELECT content_source, field_provenance FROM experience_providers WHERE id = 'ep-own'").get() as any;
        eq([store.isGardssalgFieldOwnerLocked(ownRow, "adresse"), (store.applyGardssalgSetAddress("ep-own", "Storgata 1", "admin-test") as any).reason, cols("ep-own")],
          [true, "owner_locked", beforeNabo], "cse25 (AK2): adresse stays owner_locked for every other writer");
        // A forged owner context: the writer checks the request row itself.
        const unit = { street: "Storgata 1", postnummer: "0155", poststed: "Oslo", lat: 59.91, lon: 10.75 };
        const forge = (id: string) => store.applyGardssalgSetAddressUnit("ep-own", unit, "x", { ownerRequest: { changeRequestId: id } }) as any;
        db.prepare("UPDATE cs_change_requests SET status = 'executing' WHERE id = ?").run(x1.request.id); // approved, being executed
        const fApproved = forge(x1.request.id).detail;
        db.prepare("UPDATE cs_change_requests SET status = 'failed' WHERE id = ?").run(x1.request.id);
        const fDone = forge(a1.request.id).detail; // owner authority, but not being executed
        db.prepare("UPDATE cs_change_requests SET status = 'executing' WHERE id = ?").run(a1.request.id);
        const fValue = forge(a1.request.id).detail; // a different address than the request asked for
        const fOther = (store.applyGardssalgSetAddressUnit("ep-man", { ...unit, street: "Universitetsgata 2", postnummer: "0164" }, "x", { ownerRequest: { changeRequestId: a1.request.id } }) as any).detail;
        db.prepare("UPDATE cs_change_requests SET status = 'verified' WHERE id = ?").run(a1.request.id);
        eq([fApproved, forge("chg-finnes-ikke").detail, fDone, fValue, fOther, cols("ep-own")],
          ["owner_request_no_owner_authority", "owner_request_not_found", "owner_request_not_executing", "owner_request_value_mismatch", "owner_request_wrong_target", beforeNabo],
          "cse26 (AK2): an owner context is only honoured for a real executing request with owner authority, for this provider and value");
        // A direct admin HTTP call cannot use the owner path.
        {
          const prevKey = process.env.ADMIN_KEY;
          process.env.ADMIN_KEY = prevKey || "cse-admin-key";
          try {
            const router = (require("../routes/opplevelser") as typeof import("../routes/opplevelser")).default as any;
            const callRoute = (url: string, body: any) => new Promise<{ status: number; body: any }>((resolve) => {
              const req: any = { method: "POST", url, originalUrl: url, path: url, query: {}, headers: { "x-admin-key": process.env.ADMIN_KEY }, body, get() { return undefined; } };
              const res: any = { statusCode: 200, status(c: number) { this.statusCode = c; return this; }, json(p: any) { resolve({ status: this.statusCode, body: p }); return this; } };
              router.handle(req, res, (err?: any) => resolve({ status: 500, body: { error: String(err) } }));
            });
            db.prepare("UPDATE cs_change_requests SET status = 'executing' WHERE id = ?").run(a1.request.id);
            const smuggle = { ownerRequest: { changeRequestId: a1.request.id }, owner_request: true, change_request_id: a1.request.id, dataSource: "owner" };
            const h1 = await callRoute("/admin/gardssalg-set-address", { provider_id: "ep-own", value: "Universitetsgata 2", source: src1, ...smuggle });
            const h2 = await callRoute("/admin/gardssalg-set-provider-name", { provider_id: "ep-own", value: "Kapret navn", source: src1, ...smuggle });
            db.prepare("UPDATE cs_change_requests SET status = 'verified' WHERE id = ?").run(a1.request.id);
            eq([h1.status, h1.body?.error, h2.status, h2.body?.error, (exp.prepare("SELECT navn FROM experience_providers WHERE id = 'ep-own'").get() as any).navn],
              [409, "owner_locked", 409, "owner_locked", "Ølsmia Bryggeri"], "cse27 (AK2): a direct admin HTTP call with owner-path fields in the body is still owner_locked");
          } finally {
            if (prevKey === undefined) delete process.env.ADMIN_KEY; else process.env.ADMIN_KEY = prevKey;
          }
        }
        // content_source 'manual' locks every field; the owner's request goes through the same narrow path.
        const m1 = expCreate("ep-man", "post@manuellgarden.no", mkThread("experiences", "post@manuellgarden.no"), { address: "Universitetsgata 2, 0164 Oslo" });
        await cq.runCsChangeRequests(gdeps());
        eq([R(m1.request.id).status, cols("ep-man").adresse], ["verified", "Universitetsgata 2"], "cse28: on a content_source=manual profile the owner's own address change → verified");
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
