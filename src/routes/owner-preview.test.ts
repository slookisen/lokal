/**
 * owner-preview.test.ts — read-only preview link for segment B
 * (dev-request 2026-10-22-rfb-mine-valg-eierbrytere, S5-2).
 * POST /admin/agents/:id/preview-link + GET /forhandsvis/:token over a real
 * express app on an ephemeral port, own in-memory DB via the route's seam.
 */

import http from "http";
import express from "express";
import Database from "better-sqlite3";
import * as initMod from "../database/init";
import { makeUnsubscribeToken, verifyUnsubscribeToken } from "../services/avmeld-service";
import ownerPreviewRouter, {
  ownerPreviewAdminRouter,
  __setOwnerPreviewDbForTesting,
  makeOwnerPreviewToken,
  verifyOwnerPreviewToken,
  OWNER_PREVIEW_FLAG,
} from "./owner-preview";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export async function runOwnerPreviewTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  const s: TestSummary = { passed: 0, failed: 0, failures: [] };
  const ok = (cond: boolean, label: string) => {
    if (cond) {
      s.passed++;
      if (log) console.log(`  ok ${label}`);
    } else {
      s.failed++;
      s.failures.push(`✗ ${label}`);
      if (log) console.log(`  ✗ ${label}`);
    }
  };

  // Shared-global discipline: set env only when absent, restore in finally.
  const saved: Record<string, string | undefined> = {};
  const setEnv = (k: string, v: string | undefined) => {
    if (!(k in saved)) saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  };
  const ambientKey = process.env.ADMIN_KEY || process.env.ANALYTICS_ADMIN_KEY || "";
  if (ambientKey === "") setEnv("ADMIN_KEY", "owner-preview-standalone-key");
  const KEY = (process.env.ADMIN_KEY || process.env.ANALYTICS_ADMIN_KEY) as string;
  setEnv("APP_URL", "https://preview.example.test");
  setEnv(OWNER_PREVIEW_FLAG, undefined);

  const db = new Database(":memory:");
  let server: http.Server | null = null;
  try {
    initMod.__initSchemaForTesting(db as any);
    __setOwnerPreviewDbForTesting(db as any);

    const insertAgent = db.prepare(
      `INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, vertical_id, claimed_at, is_active, catalog_hidden)
       VALUES (?, ?, 'test agent', 'test', '', 'https://example.no', 'producer', ?, 'rfb', ?, ?, ?)`,
    );
    const mark = db.prepare(`INSERT INTO agent_owner_interest VALUES (?, 'confirmed_positive', '2026-11-01T00:00:00.000Z', NULL)`);
    insertAgent.run("pv-b", "Bakken Gård", "k1", null, 1, 0);
    mark.run("pv-b");
    insertAgent.run("pv-xss", "<script>alert(1)</script> Gård", "k2", null, 1, 0);
    mark.run("pv-xss");
    insertAgent.run("pv-plain", "Uten Interesse", "k3", null, 1, 0);
    insertAgent.run("pv-owner", "Eid Gård", "k4", "2026-11-01T00:00:00Z", 1, 0);
    mark.run("pv-owner");
    insertAgent.run("pv-inactive", "Inaktiv Gård", "k5", null, 0, 0);
    mark.run("pv-inactive");
    insertAgent.run("pv-hidden", "Skjult Gård", "k6", null, 1, 1);
    mark.run("pv-hidden");
    insertAgent.run("pv-late", "Sen Gård", "k7", null, 1, 0);
    mark.run("pv-late");

    const app = express();
    app.use(express.json());
    app.use("/admin/agents/:id/preview-link", ownerPreviewAdminRouter);
    app.use("/", ownerPreviewRouter);
    server = http.createServer(app);
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as any).port;

    const call = (method: string, path: string, body?: unknown, key: string | null = KEY) =>
      new Promise<{ status: number; body: any; text: string; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
        const headers: Record<string, string> = { "content-type": "application/json" };
        if (key !== null) headers["x-admin-key"] = key;
        const req = http.request({ host: "127.0.0.1", port, path, method, headers }, (res) => {
          let data = "";
          res.on("data", (c) => (data += c));
          res.on("end", () => {
            let parsed: any = undefined;
            try { parsed = data ? JSON.parse(data) : undefined; } catch { parsed = undefined; }
            resolve({ status: res.statusCode || 0, body: parsed, text: data, headers: res.headers });
          });
        });
        req.on("error", reject);
        if (body !== undefined) req.write(JSON.stringify(body));
        req.end();
      });
    const tokenFrom = (url: string) => url.slice(url.lastIndexOf("/") + 1);
    const changes = () => (db.prepare(`SELECT total_changes() AS n`).get() as any).n as number;
    const counts = () =>
      ["agents", "agent_owner_interest", "agent_knowledge_audit", "owner_feature_settings", "owner_feature_audit", "analytics_page_views"]
        .map((t) => { try { return (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as any).n; } catch { return -1; } })
        .join(",");

    // ── Mint ─────────────────────────────────────────────────────────────
    ok((await call("POST", "/admin/agents/pv-b/preview-link", {}, null)).status === 403, "mint: admin key required");
    ok((await call("POST", "/admin/agents/nope/preview-link", {})).status === 404, "mint: unknown agent -> 404");
    const plain = await call("POST", "/admin/agents/pv-plain/preview-link", {});
    ok(plain.status === 409 && plain.body?.error === "not_segment_b", "mint: no owner_interest row -> 409 not_segment_b");
    const own = await call("POST", "/admin/agents/pv-owner/preview-link", {});
    ok(own.status === 409 && own.body?.error === "already_owner", "mint: already owner -> 409 already_owner");
    ok((await call("POST", "/admin/agents/pv-inactive/preview-link", {})).body?.error === "inactive", "mint: inactive -> 409 inactive");
    ok((await call("POST", "/admin/agents/pv-hidden/preview-link", {})).body?.error === "inactive", "mint: catalog_hidden -> 409 inactive");
    ok((await call("POST", "/admin/agents/pv-b/preview-link", { ttl_days: 31 })).status === 400, "mint: ttl_days 31 -> 400");
    ok((await call("POST", "/admin/agents/pv-b/preview-link", { ttl_days: 0 })).status === 400, "mint: ttl_days 0 -> 400");
    ok((await call("POST", "/admin/agents/pv-b/preview-link", { extra: 1 })).status === 400, "mint: unknown field -> 400 (strict)");

    const before = counts();
    const c0 = changes();
    const minted = await call("POST", "/admin/agents/pv-b/preview-link", { ttl_days: 7 });
    ok(minted.status === 200, "mint: 200 for segment B");
    ok(minted.body?.enabled === false, "mint: enabled=false while the flag is off (still mints)");
    ok(typeof minted.body?.url === "string" && minted.body.url.startsWith("https://preview.example.test/forhandsvis/"), "mint: absolute URL on the public base");
    const days = (Date.parse(minted.body?.expires_at) - Date.now()) / 86400000;
    ok(days > 6.9 && days < 7.1, "mint: expires_at ~ ttl_days from now");
    ok(changes() === c0 && counts() === before, "mint: writes nothing to the DB");
    const dflt = await call("POST", "/admin/agents/pv-b/preview-link", {});
    const dd = (Date.parse(dflt.body?.expires_at) - Date.now()) / 86400000;
    ok(dflt.status === 200 && dd > 29.9 && dd < 30.1, "mint: default ttl 30 days");
    const token = tokenFrom(minted.body.url);

    // ── Token ────────────────────────────────────────────────────────────
    const now = Math.floor(Date.now() / 1000);
    const rt = verifyOwnerPreviewToken(makeOwnerPreviewToken("pv-b", now + 100)!);
    ok(rt.status === "ok" && (rt as any).agentId === "pv-b", "token: round-trip");
    ok(verifyOwnerPreviewToken(makeOwnerPreviewToken("pv-b", now - 5)!).status === "expired", "token: expired");
    ok(verifyOwnerPreviewToken(makeOwnerPreviewToken("pv-b", now + 90 * 86400)!).status === "invalid", "token: lifetime beyond max -> invalid");
    ok(verifyOwnerPreviewToken(token.slice(0, -2) + "xx").status === "invalid", "token: tampered signature -> invalid");
    const [pl, sg] = token.split(".");
    const forgedPayload = Buffer.from(`p1\npv-xss\n${now + 100}`).toString("base64").replace(/=+$/, "");
    ok(verifyOwnerPreviewToken(`${forgedPayload}.${sg}`).status === "invalid", "token: payload swapped, old signature -> invalid");
    ok(verifyOwnerPreviewToken("garbage").status === "invalid" && verifyOwnerPreviewToken("").status === "invalid", "token: garbage -> invalid");
    // Domain separation both ways.
    setEnv("UNSUBSCRIBE_TOKEN_SECRET", undefined);
    const avm = makeUnsubscribeToken("someone@example.no")!;
    ok(verifyOwnerPreviewToken(avm).status === "invalid", "domain separation: avmeld token is not a preview token");
    ok(verifyUnsubscribeToken(token) === null, "domain separation: preview token is not an avmeld token");
    ok(pl.length > 0, "token: has payload part");

    // ── Public page ──────────────────────────────────────────────────────
    ok((await call("GET", `/forhandsvis/${token}`, undefined, null)).status === 404, "page: flag off -> 404");
    setEnv(OWNER_PREVIEW_FLAG, "1");
    ok((await call("POST", "/admin/agents/pv-b/preview-link", {})).body?.enabled === true, "mint: enabled=true with the flag on");

    const good = await call("GET", `/forhandsvis/${token}`, undefined, null);
    ok(good.status === 200, "page: valid token -> 200");
    ok(good.text.includes("Bakken Gård"), "page: shows the profile name");
    ok(good.text.includes('href="/produsent/'), "page: links to the public profile");
    ok(good.text.includes('href="/selger?agent=pv-b"'), "page: claim link goes to the existing /selger?agent= flow");
    ok(good.text.includes("Ta over profilen") && good.text.includes("Mine valg"), "page: takeover text mentions «Mine valg»");
    ok(good.text.includes("Slik står profilen din i dag"), "page: has the «i dag» section");
    ok(good.text.includes('<meta name="robots" content="noindex">'), "page: meta robots noindex");
    ok(good.headers["x-robots-tag"] === "noindex", "page: X-Robots-Tag noindex");
    ok(good.headers["cache-control"] === "no-store", "page: Cache-Control no-store");
    ok(good.headers["referrer-policy"] === "no-referrer", "page: Referrer-Policy no-referrer");
    ok(!good.text.includes(token), "page: token is not echoed");

    const xssTok = tokenFrom((await call("POST", "/admin/agents/pv-xss/preview-link", {})).body.url);
    const xss = await call("GET", `/forhandsvis/${xssTok}`, undefined, null);
    ok(xss.status === 200 && !xss.text.includes("<script>alert(1)") && xss.text.includes("&lt;script&gt;"), "page: escapes <script> in the name");

    // GET changes nothing.
    const b2 = counts();
    const c1 = changes();
    await call("GET", `/forhandsvis/${token}`, undefined, null);
    await call("GET", `/forhandsvis/${xssTok}`, undefined, null);
    ok(changes() === c1 && counts() === b2, "GET changes nothing (total_changes and row counts unchanged)");

    const tampered = await call("GET", `/forhandsvis/${token.slice(0, -2)}xx`, undefined, null);
    ok(tampered.status === 404 && !tampered.text.includes("Bakken"), "page: tampered -> 404, no detail");
    const expiredTok = makeOwnerPreviewToken("pv-b", now - 10)!;
    const exp = await call("GET", `/forhandsvis/${expiredTok}`, undefined, null);
    ok(exp.status === 410 && !exp.text.includes("Bakken"), "page: expired -> 410, no detail");
    ok(exp.headers["x-robots-tag"] === "noindex", "page: error pages are noindex too");

    // Agent state changes after minting.
    const lateTok = tokenFrom((await call("POST", "/admin/agents/pv-late/preview-link", {})).body.url);
    ok((await call("GET", `/forhandsvis/${lateTok}`, undefined, null)).status === 200, "page: pv-late valid before takeover");
    db.prepare(`UPDATE agents SET claimed_at = '2026-11-20T00:00:00Z' WHERE id = 'pv-late'`).run();
    const gone = await call("GET", `/forhandsvis/${lateTok}`, undefined, null);
    ok(gone.status === 410 && gone.text.includes("Lenken gjelder ikke lenger"), "page: agent became owner -> 410");
    db.prepare(`DELETE FROM agent_owner_interest WHERE agent_id = 'pv-b'`).run();
    ok((await call("GET", `/forhandsvis/${token}`, undefined, null)).status === 410, "page: no longer segment B -> 410");
    db.prepare(`INSERT INTO agent_owner_interest VALUES ('pv-b','confirmed_positive','2026-11-01T00:00:00.000Z',NULL)`).run();
    db.prepare(`UPDATE agents SET is_active = 0 WHERE id = 'pv-b'`).run();
    ok((await call("GET", `/forhandsvis/${token}`, undefined, null)).status === 410, "page: inactive -> 410");
    db.prepare(`UPDATE agents SET is_active = 1, catalog_hidden = 1 WHERE id = 'pv-b'`).run();
    ok((await call("GET", `/forhandsvis/${token}`, undefined, null)).status === 410, "page: catalog_hidden -> 410");
  } catch (err: any) {
    s.failed++;
    s.failures.push("✗ owner-preview: unexpected error: " + String(err?.stack || err));
  } finally {
    __setOwnerPreviewDbForTesting(null);
    if (server) await new Promise<void>((r) => server!.close(() => r()));
    db.close();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
  return s;
}

if (require.main === module) {
  runOwnerPreviewTests({ log: true }).then((r) => {
    console.log(`${r.passed} passed, ${r.failed} failed`);
    for (const f of r.failures) console.log(f);
    process.exit(r.failed ? 1 : 0);
  });
}
