/**
 * admin-agents-claim-merge-approve.test.ts — dev-request 2026-10-30-rfb-
 * eierkrav-automatisk-vurdering-og-ettklikk, SLICE D1: «Slå sammen og
 * godkjenn» (POST /admin/agents/claim-merge-approve, CLAIM_MERGE_APPROVE_ENABLED).
 *
 *   D1.1  flag on, queued claim + sibling: dry-run writes nothing; apply fills
 *         blank survivor fields (incl. opening hours, delivery, map point),
 *         set and curated fields untouched, duplicate is_active = 0 +
 *         merged_into, audit rows, claim approved + profile owned, login mail
 *         sent (address never logged). G8 geocode reset and the
 *         address-differs guard on the map point.
 *   D1.2  every refusal answers its code and writes nothing (flag off 503,
 *         no/wrong key 403, bad body 400, unknown claim 404, not queued 409,
 *         survivor owned 409, duplicate = claim agent 400, unknown duplicate
 *         404, inactive duplicate 409, not_a_sibling 409, duplicate_claimed 409)
 *   D1.3  an approval that fails after the merge leaves no half state (approve
 *         refusal → 409 approve_failed; a throw → 500), nothing written
 *   sib   the extracted sibling rule (claimSiblingsForRow) gives exactly what
 *         the pre-extraction inline rule gave, for the claim assessment and
 *         for findClaimSiblingIds
 *   dm    duplicate-merge without the G8 option ignores G8 fields
 *
 * No network, no production DB: a fresh in-memory SQLite with the real schema,
 * the real admin router on an in-process server, a stub mail transporter.
 *
 * Exported runAdminAgentsClaimMergeApproveTests({log}) -> TestSummary; wired
 * into tests/test.ts. Standalone: npx tsx src/routes/admin-agents-claim-merge-approve.test.ts
 */

import Database from "better-sqlite3";
import http from "http";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export async function runAdminAgentsClaimMergeApproveTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];
  const eq = (actual: unknown, expected: unknown, label: string): void => {
    if (JSON.stringify(actual) === JSON.stringify(expected)) {
      passed++;
      if (log) console.log(`  ok ${label}`);
    } else {
      failed++;
      const msg = `✗ ${label}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`;
      failures.push(msg);
      if (log) console.log("  " + msg);
    }
  };
  const ok = (cond: boolean, label: string): void => eq(!!cond, true, label);

  const initMod = require("../database/init") as typeof import("../database/init");
  const prevDb = initMod.__peekDbForTesting();
  const db = new Database(":memory:");

  const ENV_KEYS = ["ADMIN_KEY", "ANALYTICS_ADMIN_KEY", "CLAIM_MERGE_APPROVE_ENABLED", "CLAIM_CRM_TRACKING_ENABLED",
    "CLAIM_AUTO_ASSESSMENT_ENABLED", "CLAIM_AUTO_APPROVE_ENABLED", "ADMIN_NOTIFICATION_EMAIL"] as const;
  const prevEnv: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) { prevEnv[k] = process.env[k]; delete process.env[k]; }
  const ADMIN_KEY = "d1-test-admin-key";

  const emailSvc = (require("../services/email-service") as typeof import("../services/email-service")).emailService as any;
  const origConfigured = emailSvc.isConfigured;
  const origTransporter = emailSvc.transporter;
  const mails: Array<{ to: string; subject: string }> = [];
  emailSvc.isConfigured = true;
  emailSvc.transporter = {
    sendMail: async (m: Record<string, any>) => {
      mails.push({ to: String(m.to), subject: String(m.subject) });
      return { messageId: `stub-${mails.length}` };
    },
  };

  const trust = (require("../services/trust-score-service") as typeof import("../services/trust-score-service")).trustScoreService as any;
  const origTrustUpdate = trust.update;

  const logged: string[] = [];
  const origConsole = { log: console.log, warn: console.warn, error: console.error, info: console.info };
  const capture = (orig: (...a: any[]) => void) => (...a: any[]) => {
    logged.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" "));
    if (log) orig(...a);
  };

  let server: http.Server | null = null;
  try {
    initMod.__setDbForTesting(db as any);
    initMod.__initSchemaForTesting(db as any);
    try { (require("../config/vertical-config") as typeof import("../config/vertical-config")).loadConfigsAtBoot(); } catch { /* already loaded */ }
    process.env.ADMIN_KEY = ADMIN_KEY;

    const express = require("express");
    delete require.cache[require.resolve("./admin-agents")];
    const adminAgents = require("./admin-agents").default;
    {
      const app = express();
      app.use(express.json());
      app.use("/admin/agents", adminAgents);
      server = http.createServer(app);
      await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", () => resolve()));
    }
    const port = (server!.address() as any).port as number;
    type Resp = { status: number; body: any };
    function post(urlPath: string, body: unknown, headers: Record<string, string>): Promise<Resp> {
      return new Promise((resolve, reject) => {
        const bodyStr = JSON.stringify(body ?? {});
        const r = http.request({
          method: "POST", host: "127.0.0.1", port, path: urlPath,
          headers: { ...headers, "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(bodyStr)) },
        }, (resp) => {
          const chunks: Buffer[] = [];
          resp.on("data", (c) => chunks.push(c as Buffer));
          resp.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            let parsed: any = null; try { parsed = JSON.parse(raw); } catch { /* not json */ }
            resolve({ status: resp.statusCode || 0, body: parsed });
          });
        });
        r.on("error", reject);
        r.write(bodyStr);
        r.end();
      });
    }
    const admin = { "X-Admin-Key": ADMIN_KEY };
    const call = (body: unknown, headers: Record<string, string> = admin) => post("/admin/agents/claim-merge-approve", body, headers);

    // ── fixtures ──────────────────────────────────────────────────────────
    interface AgentOpts {
      orgNr?: string | null; tags?: string; vertical?: string; isActive?: number; claimedAt?: string | null;
      lat?: number | null; lng?: number | null; geoPrecision?: string | null; geocodeSource?: string | null;
      knowledge?: Record<string, string | number | null> | null;
    }
    function agent(id: string, o: AgentOpts = {}): string {
      db.prepare(`INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, origin, org_nr, tags,
                    vertical_id, is_active, claimed_at, lat, lng, geo_precision, geocode_source)
                  VALUES (?, ?, 'En gård.', 'test', ?, ?, 'producer', ?, 'discovery', ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, `Gård ${id}`, `reg@${id}.example.test`, `https://${id}.example.test`, `key-${id}`, o.orgNr ?? null,
          o.tags ?? "[]", o.vertical ?? "rfb", o.isActive ?? 1, o.claimedAt ?? null, o.lat ?? null, o.lng ?? null,
          o.geoPrecision ?? null, o.geocodeSource ?? null);
      if (o.knowledge !== null) {
        const k = o.knowledge ?? {};
        const cols = Object.keys(k);
        db.prepare(`INSERT INTO agent_knowledge (agent_id${cols.map((c) => `, ${c}`).join("")}) VALUES (?${cols.map(() => ", ?").join("")})`)
          .run(id, ...cols.map((c) => k[c]));
      }
      return id;
    }
    let seq = 0;
    function queuedClaim(agentId: string, o: { status?: string; email?: string } = {}): string {
      const id = `d1-claim-${++seq}`;
      db.prepare(`INSERT INTO agent_claims (id, agent_id, claimant_name, claimant_email, status, review_reason)
                  VALUES (?, ?, 'Kari', ?, ?, 'no_known_email')`)
        .run(id, agentId, o.email ?? `kari@${agentId}.example.test`, o.status ?? "pending_review");
      return id;
    }
    const all = (table: string) => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
    const snapshot = () => JSON.stringify({
      agents: all("agents"), agent_knowledge: all("agent_knowledge"), agent_knowledge_audit: all("agent_knowledge_audit"),
      agent_claims: all("agent_claims"), magic_links: all("magic_links"),
    });
    const agentRow = (id: string): any => db.prepare("SELECT * FROM agents WHERE id = ?").get(id);
    const kRow = (id: string): any => db.prepare("SELECT * FROM agent_knowledge WHERE agent_id = ?").get(id);
    const claimRow = (id: string): any => db.prepare("SELECT * FROM agent_claims WHERE id = ?").get(id);
    const audit = (id: string): any[] => db.prepare("SELECT field_name, old_value, new_value, notes FROM agent_knowledge_audit WHERE agent_id = ? ORDER BY rowid").all(id) as any[];

    const HOURS = JSON.stringify([{ day: "sat", open: "10:00", close: "14:00" }]);

    // ══ D1.2 refusals (each writes nothing) ═══════════════════════════════
    {
      const s = agent("r-surv", { orgNr: "911111111" });
      const d = agent("r-dup", { orgNr: "911111111", knowledge: { address: "Gardsvegen 1", postal_code: "1234" } });
      const claimId = queuedClaim(s);
      const before = snapshot();

      // flag off — checked after the admin key, as claim-request-more
      const off = await call({});
      eq([off.status, off.body?.error], [503, "claim_merge_approve_disabled"], "D1.2: flag off, POST {} with key → 503 claim_merge_approve_disabled");
      const offFull = await call({ claimId, duplicateId: d, apply: true });
      eq(offFull.status, 503, "D1.2: flag off, full apply body → 503");
      eq((await call({ claimId, duplicateId: d }, {})).status, 403, "D1.2: flag off, no key → 403");

      process.env.CLAIM_MERGE_APPROVE_ENABLED = "true";
      eq((await call({ claimId, duplicateId: d, apply: true }, {})).status, 403, "D1.2: no key → 403");
      eq((await call({ claimId, duplicateId: d, apply: true }, { "X-Admin-Key": "wrong" })).status, 403, "D1.2: wrong key → 403");
      eq((await call({})).status, 400, "D1.2: {} → 400");
      eq((await call({ claimId, apply: true })).status, 400, "D1.2: missing duplicateId → 400");
      eq((await call({ duplicateId: d, apply: true })).status, 400, "D1.2: missing claimId → 400");
      eq((await call({ claimId, duplicateId: d, note: 5, apply: true })).status, 400, "D1.2: non-string note → 400");
      eq((await call({ claimId, duplicateId: d, note: "x".repeat(1001), apply: true })).status, 400, "D1.2: note too long → 400");
      const nf = await call({ claimId: "no-such-claim", duplicateId: d, apply: true });
      eq([nf.status, nf.body?.error], [404, "claim_not_found"], "D1.2: unknown claim → 404");
      const same = await call({ claimId, duplicateId: s, apply: true });
      eq([same.status, same.body?.error], [400, "duplicate_is_claim_agent"], "D1.2: duplicateId = claim agent → 400");
      const nd = await call({ claimId, duplicateId: "no-such-agent", apply: true });
      eq([nd.status, nd.body?.error], [404, "duplicate_not_found"], "D1.2: unknown duplicate → 404");
      eq(snapshot(), before, "D1.2: nothing written by the refusals so far");

      // not queued
      const rejected = queuedClaim(agent("r-surv2", { orgNr: "911111111" }), { status: "rejected" });
      const b2 = snapshot();
      const np = await call({ claimId: rejected, duplicateId: d, apply: true });
      eq([np.status, np.body?.error], [409, "not_pending_review"], "D1.2: claim not pending_review → 409");
      eq(snapshot(), b2, "D1.2: not_pending_review writes nothing");

      // survivor already owned (claimed_at)
      const ownedClaim = queuedClaim(agent("r-owned", { orgNr: "911111111", claimedAt: "2026-10-01T00:00:00Z" }));
      const b3 = snapshot();
      const ho = await call({ claimId: ownedClaim, duplicateId: d, apply: true });
      eq([ho.status, ho.body?.error], [409, "has_owner"], "D1.2: profile with owner (claimed_at) → 409 has_owner");
      eq(snapshot(), b3, "D1.2: has_owner writes nothing");
      // survivor owned through a verified claim
      const vOwner = agent("r-owned-v", { orgNr: "911111111" });
      db.prepare("INSERT INTO agent_claims (id, agent_id, claimant_name, claimant_email, status) VALUES ('d1-verified-1', ?, 'Ola', 'ola@x.example.test', 'verified')").run(vOwner);
      const vClaim = queuedClaim(vOwner);
      const b3v = snapshot();
      eq((await call({ claimId: vClaim, duplicateId: d, apply: true })).body?.error, "has_owner", "D1.2: owner via verified claim → has_owner");
      eq(snapshot(), b3v, "D1.2: has_owner (verified claim) writes nothing");

      // inactive duplicate
      const inactive = agent("r-inactive", { orgNr: "911111111", isActive: 0 });
      const b4 = snapshot();
      const ia = await call({ claimId, duplicateId: inactive, apply: true });
      eq([ia.status, ia.body?.error], [409, "duplicate_inactive"], "D1.2: inactive duplicate → 409 duplicate_inactive");
      eq(snapshot(), b4, "D1.2: duplicate_inactive writes nothing");

      // not a sibling: different org.nr, phone, address
      const stranger = agent("r-stranger", { orgNr: "922222222", knowledge: { address: "Annen veg 9", postal_code: "9999", phone: "+47 400 00 000" } });
      // RFB rule: a dental-vertical row with the same org.nr is not a sibling
      const dental = agent("r-dental", { orgNr: "911111111", vertical: "dental" });
      const b5 = snapshot();
      const ns = await call({ claimId, duplicateId: stranger, apply: true });
      eq([ns.status, ns.body?.error], [409, "not_a_sibling"], "D1.2: not a sibling → 409 not_a_sibling");
      eq((await call({ claimId, duplicateId: dental, apply: true })).body?.error, "not_a_sibling", "D1.2: other vertical → not_a_sibling");
      eq((await call({ claimId, duplicateId: stranger })).body?.error, "not_a_sibling", "D1.2: dry-run refuses not_a_sibling too");
      eq(snapshot(), b5, "D1.2: not_a_sibling writes nothing");

      // duplicate has an owner
      const claimedDup = agent("r-claimed-dup", { orgNr: "911111111", claimedAt: "2026-09-01T00:00:00Z" });
      const b6 = snapshot();
      const dc = await call({ claimId, duplicateId: claimedDup, apply: true });
      eq([dc.status, dc.body?.error], [409, "duplicate_claimed"], "D1.2: duplicate with claimed_at → 409 duplicate_claimed");
      eq(snapshot(), b6, "D1.2: duplicate_claimed writes nothing");

      // the original claim is still queued after all refusals
      eq(claimRow(claimId).status, "pending_review", "D1.2: claim still pending_review");
      eq(mails.length, 0, "D1.2: no mail sent by any refusal");
    }

    // ══ D1.1 dry-run + apply ═════════════════════════════════════════════
    {
      const surv = agent("m-surv", {
        orgNr: "933333333",
        knowledge: {
          phone: "+47 900 11 222", website: "https://surv.example.test", about: null, address: null, postal_code: null,
          opening_hours: "[]", delivery_options: "[]",
          curated_fields: JSON.stringify({ about: true, delivery_radius: true }),
          field_provenance: JSON.stringify({ phone: [{ value: "+47 900 11 222", source_type: "homepage" }] }),
        },
      });
      const dup = agent("m-dup", {
        tags: JSON.stringify(["org_nr:933333333"]),
        lat: 60.63, lng: 8.56, geoPrecision: "address", geocodeSource: "kartverket_adresse",
        knowledge: {
          phone: "+47 911 22 333", website: "https://dup.example.test", about: "Duplikatets tekst.",
          address: "Gardsvegen 12", postal_code: "3570", email: "post@dup.example.test",
          opening_hours: HOURS, delivery_options: JSON.stringify(["Henting på gård"]), delivery_radius: 20, min_order_value: 150,
          field_provenance: JSON.stringify({ address: [{ value: "Gardsvegen 12", source_type: "brreg" }] }),
        },
      });
      const claimId = queuedClaim(surv);
      const before = snapshot();

      const dry = await call({ claimId, duplicateId: dup, note: "Ål-tilfellet" });
      eq(dry.status, 200, "D1.1 dry: 200");
      eq([dry.body?.dryRun, dry.body?.wouldApprove], [true, true], "D1.1 dry: dryRun + wouldApprove");
      eq(dry.body?.filled, ["address", "postal_code", "email", "opening_hours", "delivery_options", "min_order_value"],
        "D1.1 dry: would fill blank fields only (about + delivery_radius curated)");
      eq(dry.body?.moved, ["lat", "lng", "geo_precision", "geocode_source"], "D1.1 dry: would move the map point");
      eq(dry.body?.curatedSkipped, ["about", "delivery_radius"], "D1.1 dry: curated fields reported");
      eq(dry.body?.geocodeReset, false, "D1.1 dry: no geocode reset (survivor has no point)");
      const dryStr = await call({ claimId, duplicateId: dup, apply: "false" });
      eq(dryStr.body?.dryRun, true, "D1.1 dry: apply \"false\" stays a dry-run");
      eq(snapshot(), before, "D1.1 dry: nothing written");
      eq(mails.length, 0, "D1.1 dry: no mail");

      Object.assign(console, { log: capture(origConsole.log), warn: capture(origConsole.warn), error: capture(origConsole.error), info: capture(origConsole.info) });
      let res: Resp;
      try { res = await call({ claimId, duplicateId: dup, note: "Ål-tilfellet", apply: true }); } finally { Object.assign(console, origConsole); }
      eq(res.status, 200, "D1.1 apply: 200");
      eq([res.body?.success, res.body?.dryRun, res.body?.approved, res.body?.loginLinkSent], [true, false, true, true], "D1.1 apply: success, approved, login link sent");
      eq([res.body?.claimId, res.body?.agentId, res.body?.duplicateId], [claimId, surv, dup], "D1.1 apply: ids echoed");
      ok(typeof res.body?.sentTo === "string" && !res.body.sentTo.includes(`kari@${surv}`), "D1.1 apply: sentTo is masked");

      const k = kRow(surv);
      eq([k.address, k.postal_code, k.email, k.opening_hours, k.delivery_options, k.min_order_value],
        ["Gardsvegen 12", "3570", "post@dup.example.test", HOURS, JSON.stringify(["Henting på gård"]), 150],
        "D1.1 apply: blank fields filled incl. opening hours + delivery");
      eq([k.phone, k.website], ["+47 900 11 222", "https://surv.example.test"], "D1.1 apply: set fields untouched");
      eq([k.about, k.delivery_radius], [null, null], "D1.1 apply: curated fields untouched");
      const prov = JSON.parse(k.field_provenance);
      eq([prov.phone?.length, prov.address?.[0]?.source_type], [1, "brreg"], "D1.1 apply: provenance appended, survivor's own kept");
      const a = agentRow(surv);
      eq([a.lat, a.lng, a.geo_precision, a.geocode_source], [60.63, 8.56, "address", "kartverket_adresse"], "D1.1 apply: map point moved");
      const d = agentRow(dup);
      eq([d.is_active, d.merged_into], [0, surv], "D1.1 apply: duplicate is_active 0 + merged_into");
      const fieldsAudited = audit(surv).map((r) => r.field_name);
      for (const f of ["address", "postal_code", "email", "opening_hours", "delivery_options", "min_order_value", "lat", "lng", "geo_precision", "geocode_source", "field_provenance"]) {
        ok(fieldsAudited.includes(f), `D1.1 apply: audit row for ${f}`);
      }
      ok(audit(surv).find((r) => r.field_name === "lat")?.old_value === null, "D1.1 apply: lat audit carries old value (NULL)");
      const mergeRow = audit(dup).find((r) => r.field_name === "merge");
      eq([mergeRow?.old_value, mergeRow?.new_value], [dup, surv], "D1.1 apply: one merge audit row");
      ok(String(mergeRow?.notes).includes("Ål-tilfellet"), "D1.1 apply: note on the merge row");
      const c = claimRow(claimId);
      eq([c.status, c.verification_method], ["verified", "manual"], "D1.1 apply: claim approved (admin path)");
      eq([!!a.claimed_at, a.claimed_via], [true, "admin_approval"], "D1.1 apply: profile owned (claimed_at, admin_approval)");
      eq(mails.filter((m) => m.to === `kari@${surv}.example.test`).length, 1, "D1.1 apply: one login mail to the claimant");
      // The mail transport's own "[Email] sent" line is shared with every
      // claim mail (claim-review-approve too); this route's lines carry none.
      ok(logged.some((l) => l.startsWith("[admin-agents] claim-merge-approve")) &&
        !logged.some((l) => l.startsWith("[admin-agents]") && l.includes(`kari@${surv}`)), "D1.1 apply: claimant address not in the route's log");

      const again = await call({ claimId, duplicateId: dup, apply: true });
      eq([again.status, again.body?.error], [409, "not_pending_review"], "D1.1 apply: second call → 409");
    }

    // ══ G8: address filled while the survivor keeps a point → geocode reset ══
    {
      const surv = agent("g-surv", { orgNr: "944444444", lat: 61.1, lng: 10.4, geoPrecision: "city", geocodeSource: "kommuneinfo", knowledge: { address: null } });
      const dup = agent("g-dup", { orgNr: "944444444", lat: 61.2, lng: 10.5, knowledge: { address: "Bakken 3", postal_code: "2600" } });
      const claimId = queuedClaim(surv);
      const dry = await call({ claimId, duplicateId: dup });
      eq([dry.body?.geocodeReset, dry.body?.moved], [true, []], "G8 dry: geocode reset announced, point not moved");
      const res = await call({ claimId, duplicateId: dup, apply: true });
      eq([res.status, res.body?.geocodeReset], [200, true], "G8 apply: geocodeReset true");
      const a = agentRow(surv);
      eq([a.lat, a.lng, a.geo_precision, a.geocode_source, a.geocode_attempts], [null, null, null, null, 0], "G8 apply: survivor point cleared for re-geocoding");
      const latAudit = audit(surv).find((r) => r.field_name === "lat" && r.new_value === null);
      eq(latAudit?.old_value, "61.1", "G8 apply: audit row keeps the old lat");
    }

    // ══ G8: survivor keeps a different address → duplicate's point not moved ══
    {
      const surv = agent("x-surv", { orgNr: "955555555", knowledge: { address: "Annen veg 5", postal_code: "2600" } });
      const dup = agent("x-dup", { orgNr: "955555555", lat: 62.0, lng: 9.0, knowledge: { address: "Bakken 3", postal_code: "2600" } });
      const claimId = queuedClaim(surv);
      const res = await call({ claimId, duplicateId: dup, apply: true });
      eq([res.status, res.body?.moved, res.body?.mapPointSkipped], [200, [], "address_differs"], "G8: point for another address not moved");
      eq([agentRow(surv).lat, agentRow(surv).lng], [null, null], "G8: survivor point still empty (geocode worker places it)");
    }

    // ══ D1.3 approval fails after the merge → nothing written ═════════════
    {
      const surv = agent("f-surv", { orgNr: "966666666", knowledge: { address: null } });
      const dup = agent("f-dup", { orgNr: "966666666", lat: 63.0, lng: 10.0, knowledge: { address: "Fjellet 1", postal_code: "7000", opening_hours: HOURS } });
      const badClaim = queuedClaim(surv, { email: "ikke-en-adresse" });
      const before = snapshot();
      const dry = await call({ claimId: badClaim, duplicateId: dup });
      eq(dry.body?.filled?.includes("opening_hours"), true, "D1.3: dry-run shows the merge that would run");
      const res = await call({ claimId: badClaim, duplicateId: dup, apply: true });
      eq([res.status, res.body?.error, res.body?.reason, res.body?.rolledBack], [409, "approve_failed", "invalid_email", true],
        "D1.3: approval refusal after merge → 409 approve_failed, rolled back");
      eq(snapshot(), before, "D1.3: refusal left no merge writes, no audit rows, claim still queued");

      // A throw inside the approval (trust score update) also rolls everything back.
      const goodClaim = queuedClaim(surv);
      const before2 = snapshot();
      trust.update = () => { throw new Error("trust down"); };
      let res2: Resp;
      Object.assign(console, { error: capture(origConsole.error) });
      try { res2 = await call({ claimId: goodClaim, duplicateId: dup, apply: true }); } finally { trust.update = origTrustUpdate; Object.assign(console, origConsole); }
      eq([res2.status, res2.body?.error, res2.body?.rolledBack], [500, "server_error", true], "D1.3: throw during approval → 500 rolled back");
      eq(snapshot(), before2, "D1.3: throw left nothing written (duplicate still active, claim queued)");
      eq([agentRow(dup).is_active, claimRow(goodClaim).status], [1, "pending_review"], "D1.3: duplicate active, claim pending");
      const n = mails.length;
      const ok3 = await call({ claimId: goodClaim, duplicateId: dup, apply: true });
      eq([ok3.status, mails.length - n], [200, 1], "D1.3: after the failure the same call succeeds");
    }

    // ══ sib: extracted sibling rule = the pre-extraction inline rule ══════
    {
      const ks = require("../services/knowledge-service") as typeof import("../services/knowledge-service");
      // Verbatim copy of the inline rule gatherClaimAssessmentInput carried
      // before the extraction (reference oracle).
      const { normalizeOrgNr, normalizePhoneDigits } = require("../services/claim-assessment") as typeof import("../services/claim-assessment");
      function legacySiblings(agentId: string): string[] {
        const row = db.prepare(`SELECT a.org_nr, a.tags, k.phone, k.address, k.postal_code FROM agents a LEFT JOIN agent_knowledge k ON k.agent_id = a.id WHERE a.id = ?`).get(agentId) as any;
        let orgNr = normalizeOrgNr(row.org_nr);
        if (!orgNr && row.tags) {
          const m = String(row.tags).match(/org_nr:(\d{9})(?!\d)/);
          if (m) orgNr = m[1]!;
        }
        const phoneDigits = normalizePhoneDigits(row.phone);
        const addr = typeof row.address === "string" && /\d/.test(row.address) && row.address.trim().length >= 6
          ? row.address.trim().toLowerCase().replace(/\s+/g, " ") : null;
        const siblingIds = new Set<string>();
        const rfb = "COALESCE(a.vertical_id, 'rfb') = 'rfb'";
        if (orgNr) {
          for (const r of db.prepare(`SELECT a.id FROM agents a WHERE a.id <> ? AND ${rfb} AND (a.org_nr = ? OR a.tags LIKE ?) LIMIT 20`)
            .all(agentId, orgNr, `%org_nr:${orgNr}%`) as Array<{ id: string }>) siblingIds.add(r.id);
        }
        if (phoneDigits) {
          for (const r of db.prepare(
            `SELECT k.agent_id AS id, k.phone FROM agent_knowledge k JOIN agents a ON a.id = k.agent_id
              WHERE k.agent_id <> ? AND ${rfb}
                AND REPLACE(REPLACE(REPLACE(REPLACE(k.phone, ' ', ''), '-', ''), '.', ''), char(160), '') LIKE ? LIMIT 50`
          ).all(agentId, `%${phoneDigits}`) as Array<{ id: string; phone: string }>) {
            if (normalizePhoneDigits(r.phone) === phoneDigits) siblingIds.add(r.id);
          }
        }
        if (addr) {
          for (const r of db.prepare(
            `SELECT k.agent_id AS id FROM agent_knowledge k JOIN agents a ON a.id = k.agent_id
              WHERE k.agent_id <> ? AND ${rfb} AND LOWER(TRIM(k.address)) = ? AND COALESCE(k.postal_code, '') = ? LIMIT 20`
          ).all(agentId, addr, String(row.postal_code ?? "")) as Array<{ id: string }>) siblingIds.add(r.id);
        }
        return [...siblingIds];
      }

      const base = agent("s-base", { orgNr: "977777777", knowledge: { phone: "+47 455 66 777", address: "Sjøvegen 21", postal_code: "4000" } });
      agent("s-org", { orgNr: "977777777" });
      agent("s-tag", { tags: JSON.stringify(["org_nr:977777777"]) });
      agent("s-phone", { knowledge: { phone: "45566777" } });
      agent("s-phone-near", { knowledge: { phone: "+47 145 56 6777" } });
      agent("s-addr", { knowledge: { address: "  SJøVEGEN 21 ", postal_code: "4000" } });
      agent("s-addr-other-postal", { knowledge: { address: "Sjøvegen 21", postal_code: "4001" } });
      agent("s-dental", { orgNr: "977777777", vertical: "dental" });
      const lone = agent("s-lone", { knowledge: { phone: "+47 999 88 777", address: "Ensom 1" } });

      const expected = legacySiblings(base);
      eq(ks.knowledgeService.findClaimSiblingIds(base), expected, "sib: findClaimSiblingIds = pre-extraction rule");
      ok(expected.includes("s-org") && expected.includes("s-tag") && expected.includes("s-phone") && expected.includes("s-addr"),
        "sib: org.nr, org_nr tag, phone and address siblings found");
      ok(!expected.includes("s-dental") && !expected.includes("s-addr-other-postal") && !expected.includes("s-phone-near"),
        "sib: other vertical / other postal code / different phone excluded");
      eq(ks.knowledgeService.findClaimSiblingIds(lone), legacySiblings(lone), "sib: no siblings → same (empty) result");
      eq(ks.knowledgeService.findClaimSiblingIds("no-such-agent"), [], "sib: unknown agent → []");
      const claimId = queuedClaim(base);
      const input = ks.knowledgeService.gatherClaimAssessmentInput(claimId, base, { claimantName: "Kari", claimantEmail: "kari@gmail.com" });
      eq([input?.siblings.length, input?.profile.orgNr], [expected.length, "977777777"], "sib: claim assessment sees the same siblings + org.nr");
    }

    // ══ dm: duplicate-merge (no G8 option) ignores G8 fields ══════════════
    {
      const dm = require("./admin-agents-duplicate-merge") as typeof import("./admin-agents-duplicate-merge");
      agent("dm-s", { knowledge: { opening_hours: "[]" } });
      agent("dm-d", { lat: 59.9, lng: 10.7, knowledge: { opening_hours: HOURS, address: "Torget 1" } });
      const plan = dm.computeFillPlan(dm.readAgentSnapshot(db as any, "dm-s")!, dm.readAgentSnapshot(db as any, "dm-d")!);
      eq([plan.fillable.map((f) => f.field), plan.geocodeReset, plan.mapPointMoved], [["address"], undefined, undefined],
        "dm: without g8 only the base fields are planned");
      eq([dm.isExplicitApply(true), dm.isExplicitApply("true"), dm.isExplicitApply(1), dm.isExplicitApply("false"), dm.isExplicitApply(undefined, "1")],
        [true, true, true, false, true], "dm: isExplicitApply forms");
    }
  } catch (err: any) {
    failed++;
    failures.push(`unexpected error: ${err?.stack || err}`);
  } finally {
    Object.assign(console, origConsole);
    trust.update = origTrustUpdate;
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    emailSvc.isConfigured = origConfigured;
    emailSvc.transporter = origTransporter;
    for (const k of ENV_KEYS) {
      if (prevEnv[k] === undefined) delete process.env[k];
      else process.env[k] = prevEnv[k];
    }
    if (prevDb) initMod.__setDbForTesting(prevDb);
    try { db.close(); } catch { /* ignore */ }
  }
  return { passed, failed, failures };
}

if (require.main === module) {
  runAdminAgentsClaimMergeApproveTests({ log: true }).then((s) => {
    console.log(`\nadmin-agents-claim-merge-approve: ${s.passed} passed, ${s.failed} failed`);
    if (s.failed) for (const f of s.failures) console.log(f);
    process.exit(s.failed ? 1 : 0);
  });
}
