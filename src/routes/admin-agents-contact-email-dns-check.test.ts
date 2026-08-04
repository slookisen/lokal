/**
 * admin-agents-contact-email-dns-check.test.ts — tests for
 * POST /admin/agents/contact-email-dns-check.
 *
 * This route's sole job is to detect+record whether a producer's
 * `contact_email` domain has any DNS presence at all, stamping the result
 * into `agent_knowledge.field_provenance.contact_email_dns_check`. It never
 * writes `agents.contact_email` / `agent_knowledge.email`, never touches
 * `email_bounces`, and never gates any outreach query.
 *
 * Setup: better-sqlite3 ":memory:" + __initSchemaForTesting, with the route
 * pointed at that DB through its own seam (__setContactEmailDnsCheckDbForTesting)
 * and DNS resolved through its own seam (__setDnsResolverForTesting) — no real
 * network calls. Handler driven directly through router.handle() with a fake
 * req/res, same pattern as admin-agents-contact-email-write.test.ts.
 *
 * Covers:
 *   (a) admin-key auth gate
 *   (b) MX hit -> live/mx
 *   (c) A/AAAA fallback hit (empty MX) -> live/a_aaaa
 *   (d) all three empty -> dead/none
 *   (e) ENOTFOUND on all three -> dead (NOT unknown)
 *   (f) ETIMEOUT -> unknown (NOT dead) — and nothing gets written for it on apply
 *   (g) missing/empty contact_email -> skipped_invalid_email
 *   (h) an existing fresh (<30d) stamp is skipped in the no-agent_ids scan
 *       path, but NOT skipped when that same agent_id is passed explicitly
 *   (i) dry-run writes nothing (DB state unchanged)
 *   (j) apply actually writes the stamp (assert via a fresh read)
 *   (k) batch cap rejection (>200 agent_ids -> 400)
 */

import Database from "better-sqlite3";
import * as initMod from "../database/init";

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
  opts: {
    method?: string;
    url: string;
    headers?: Record<string, string>;
    body?: any;
    query?: Record<string, string>;
  },
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
      if (err) {
        resolve({ status: 500, body: { error: String(err) }, ended: true });
      } else {
        resolve({ status: 0, body: undefined, ended: false });
      }
    });
  });
}

/** Builds a fake DnsResolverSeam from a per-domain script. */
function fakeResolver(
  script: Record<
    string,
    {
      mx?: unknown[] | Error;
      a4?: string[] | Error;
      a6?: string[] | Error;
    }
  >,
) {
  const call = (domain: string, key: "mx" | "a4" | "a6"): Promise<any[]> => {
    const entry = script[domain];
    const v = entry ? entry[key] : undefined;
    if (v instanceof Error) return Promise.reject(v);
    return Promise.resolve(v ?? []);
  };
  return {
    resolveMx: (domain: string) => call(domain, "mx"),
    resolve4: (domain: string) => call(domain, "a4"),
    resolve6: (domain: string) => call(domain, "a6"),
  };
}

function dnsError(code: string): Error {
  const e = new Error(code) as Error & { code?: string };
  e.code = code;
  return e;
}

export function runAdminAgentsContactEmailDnsCheckTests(
  opts: { log?: boolean } = {},
): Promise<TestSummary> {
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
    // SHARED-GLOBAL DISCIPLINE (see admin-agents-contact-email-write.test.ts):
    // never reassign process.env.ADMIN_KEY if one is already in effect.
    const ambientKey = process.env.ADMIN_KEY || process.env.ANALYTICS_ADMIN_KEY || "";
    const setKeyOurselves = ambientKey === "";
    if (setKeyOurselves) process.env.ADMIN_KEY = "admin-agents-contact-email-dns-check-standalone-key";
    const testKey = process.env.ADMIN_KEY as string;

    const db = new Database(":memory:");
    try {
      initMod.__initSchemaForTesting(db as any);

      const insertAgent = db.prepare(
        `INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, vertical_id)
         VALUES (?, ?, 'test agent', 'test', ?, 'https://example.no', 'producer', ?, 'rfb')`,
      );
      const insertKnowledge = db.prepare(
        `INSERT INTO agent_knowledge (agent_id, field_provenance) VALUES (?, ?)`,
      );

      insertAgent.run("dns-mx", "MxHit AS", "post@mx-domain.no", "key-dns-mx");
      insertAgent.run("dns-afallback", "AFallback AS", "post@a-only-domain.no", "key-dns-a");
      insertAgent.run("dns-dead-empty", "DeadEmpty AS", "post@empty-domain.no", "key-dns-dead-empty");
      insertAgent.run("dns-dead-enotfound", "DeadEnotfound AS", "post@ghost-domain.no", "key-dns-dead-enotfound");
      insertAgent.run("dns-timeout", "TimeoutDomain AS", "post@flaky-domain.no", "key-dns-timeout");
      insertAgent.run("dns-invalid", "InvalidEmail AS", "not-an-email", "key-dns-invalid");
      insertAgent.run("dns-empty-email", "EmptyEmail AS", "", "key-dns-empty-email");
      insertAgent.run("dns-fresh-stamp", "FreshStamp AS", "post@already-checked.no", "key-dns-fresh");
      insertAgent.run("dns-stale-stamp", "StaleStamp AS", "post@stale-checked.no", "key-dns-stale");
      insertAgent.run("dns-no-knowledge", "NoKnowledge AS", "post@no-knowledge-domain.no", "key-dns-nokn");

      const nowIso = new Date().toISOString();
      const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
      const fortyDaysAgo = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();

      insertKnowledge.run("dns-mx", "{}");
      insertKnowledge.run("dns-afallback", "{}");
      insertKnowledge.run("dns-dead-empty", "{}");
      insertKnowledge.run("dns-dead-enotfound", "{}");
      insertKnowledge.run("dns-timeout", "{}");
      insertKnowledge.run("dns-invalid", "{}");
      insertKnowledge.run("dns-empty-email", "{}");
      insertKnowledge.run(
        "dns-fresh-stamp",
        JSON.stringify({
          contact_email_dns_check: {
            checked_at: tenDaysAgo,
            domain: "already-checked.no",
            live: true,
            method: "mx",
            batch_id: "contact-email-dns-check-seed",
          },
        }),
      );
      insertKnowledge.run(
        "dns-stale-stamp",
        JSON.stringify({
          contact_email_dns_check: {
            checked_at: fortyDaysAgo,
            domain: "stale-checked.no",
            live: false,
            method: "none",
            batch_id: "contact-email-dns-check-seed",
          },
        }),
      );
      // dns-no-knowledge deliberately gets NO agent_knowledge row (LEFT JOIN case).

      delete require.cache[require.resolve("./admin-agents-contact-email-dns-check")];
      const routeMod = require("./admin-agents-contact-email-dns-check");
      const router = routeMod.default;
      routeMod.__setContactEmailDnsCheckDbForTesting(db as any);

      const resolver = fakeResolver({
        "mx-domain.no": { mx: [{ exchange: "mail.mx-domain.no", priority: 10 }] },
        "a-only-domain.no": { mx: [], a4: ["203.0.113.5"] },
        "empty-domain.no": { mx: [], a4: [], a6: [] },
        "ghost-domain.no": { mx: dnsError("ENOTFOUND"), a4: dnsError("ENOTFOUND"), a6: dnsError("ENOTFOUND") },
        "flaky-domain.no": { mx: dnsError("ETIMEOUT") },
        "already-checked.no": { mx: [{ exchange: "mail.already-checked.no", priority: 10 }] },
        "stale-checked.no": { mx: [{ exchange: "mail.stale-checked.no", priority: 10 }] },
        "no-knowledge-domain.no": { mx: [], a4: [], a6: [] },
      });
      routeMod.__setDnsResolverForTesting(resolver);

      function post(body: any, key: string | false = testKey, query?: Record<string, string>): Promise<RouteResult> {
        const headers: Record<string, string> = {};
        if (key !== false) headers["x-admin-key"] = key;
        return callRoute(router, { method: "POST", url: "/", headers, body, query });
      }
      function provenanceOf(id: string): Record<string, unknown> {
        const row = db.prepare(`SELECT field_provenance FROM agent_knowledge WHERE agent_id = ?`).get(id) as
          | { field_provenance: string | null }
          | undefined;
        if (!row?.field_provenance) return {};
        try {
          return JSON.parse(row.field_provenance);
        } catch {
          return {};
        }
      }
      function stampOf(id: string): any {
        return provenanceOf(id)["contact_email_dns_check"];
      }
      function resultFor(body: any, id: string) {
        return (body?.results ?? []).find((r: any) => r.agent_id === id);
      }

      // ── (a) auth gate ───────────────────────────────────────────────────
      let r = await post({ agent_ids: ["dns-mx"] }, false);
      assertEq(r.status, 403, "dns-01: missing X-Admin-Key -> 403");
      r = await post({ agent_ids: ["dns-mx"] }, "wrong-key");
      assertEq(r.status, 403, "dns-02: wrong X-Admin-Key -> 403");

      // ── (b) MX hit ───────────────────────────────────────────────────────
      r = await post({ agent_ids: ["dns-mx"] });
      assertEq(r.body?.dry_run, true, "dns-03: dry-run by default");
      let res1 = resultFor(r.body, "dns-mx");
      assertEq(res1?.outcome, "would_confirm_live", "dns-04: MX hit -> would_confirm_live (dry-run)");
      assertEq(res1?.method, "mx", "dns-05: MX hit method=mx");
      assertEq(stampOf("dns-mx"), undefined, "dns-06: dry-run wrote no stamp");

      // ── (c) A/AAAA fallback hit ──────────────────────────────────────────
      r = await post({ agent_ids: ["dns-afallback"] });
      let res2 = resultFor(r.body, "dns-afallback");
      assertEq(res2?.outcome, "would_confirm_live", "dns-07: empty MX + A hit -> would_confirm_live");
      assertEq(res2?.method, "a_aaaa", "dns-08: A fallback method=a_aaaa");

      // ── (d) all empty -> dead ────────────────────────────────────────────
      r = await post({ agent_ids: ["dns-dead-empty"] });
      let res3 = resultFor(r.body, "dns-dead-empty");
      assertEq(res3?.outcome, "would_flag_dead", "dns-09: all empty -> would_flag_dead");
      assertEq(res3?.method, "none", "dns-10: dead method=none");

      // ── (e) ENOTFOUND on all three -> dead, NOT unknown ──────────────────
      r = await post({ agent_ids: ["dns-dead-enotfound"] });
      let res4 = resultFor(r.body, "dns-dead-enotfound");
      assertEq(res4?.outcome, "would_flag_dead", "dns-11: ENOTFOUND everywhere -> would_flag_dead (not unknown)");

      // ── (f) ETIMEOUT -> unknown, NOT dead; nothing written on apply ──────
      r = await post({ agent_ids: ["dns-timeout"] });
      let res5 = resultFor(r.body, "dns-timeout");
      assertEq(res5?.outcome, "unknown", "dns-12: ETIMEOUT -> unknown (dry-run)");
      r = await post({ agent_ids: ["dns-timeout"] }, testKey, { apply: "1" });
      let res5b = resultFor(r.body, "dns-timeout");
      assertEq(res5b?.outcome, "unknown", "dns-13: ETIMEOUT -> unknown (apply)");
      assertEq(stampOf("dns-timeout"), undefined, "dns-14: apply wrote NOTHING for an unknown-classified row");

      // ── (g) missing/empty/invalid contact_email -> skipped ───────────────
      r = await post({ agent_ids: ["dns-invalid", "dns-empty-email"] });
      assertEq(
        resultFor(r.body, "dns-invalid")?.outcome,
        "skipped_invalid_email",
        "dns-15: no '@' -> skipped_invalid_email",
      );
      assertEq(
        resultFor(r.body, "dns-empty-email")?.outcome,
        "skipped_invalid_email",
        "dns-16: empty contact_email -> skipped_invalid_email",
      );

      // ── (h) fresh stamp skipped in scan path, not when id given explicitly ─
      r = await post({}); // no agent_ids -> default scan
      assertTrue(
        !(r.body?.results ?? []).some((x: any) => x.agent_id === "dns-fresh-stamp"),
        "dns-17: fresh (<30d) stamp excluded from the default scan",
      );
      assertTrue(
        (r.body?.results ?? []).some((x: any) => x.agent_id === "dns-stale-stamp"),
        "dns-18: stale (>=30d) stamp IS included in the default scan",
      );
      r = await post({ agent_ids: ["dns-fresh-stamp"] });
      assertEq(
        resultFor(r.body, "dns-fresh-stamp")?.outcome,
        "would_confirm_live",
        "dns-19: explicit agent_ids bypasses the 30-day freshness filter",
      );

      // ── (i) dry-run writes nothing (double-check on a live+dead pair) ────
      r = await post({ agent_ids: ["dns-mx", "dns-dead-empty"] });
      assertEq(stampOf("dns-mx"), undefined, "dns-20: dry-run still wrote nothing for live");
      assertEq(stampOf("dns-dead-empty"), undefined, "dns-21: dry-run still wrote nothing for dead");

      // ── (j) apply actually writes the stamp ──────────────────────────────
      r = await post({ agent_ids: ["dns-mx"] }, testKey, { apply: "1" });
      assertEq(r.body?.dry_run, false, "dns-22: apply=1 turns off dry-run");
      assertEq(resultFor(r.body, "dns-mx")?.outcome, "live", "dns-23: apply reports live (not would_confirm_live)");
      let stamp = stampOf("dns-mx");
      assertTrue(!!stamp, "dns-24: stamp actually written");
      assertEq(stamp?.live, true, "dns-25: stamp.live=true");
      assertEq(stamp?.method, "mx", "dns-26: stamp.method=mx");
      assertEq(stamp?.domain, "mx-domain.no", "dns-27: stamp.domain matches the email's domain");
      assertTrue(typeof stamp?.checked_at === "string", "dns-28: stamp.checked_at is an ISO string");
      assertTrue(
        typeof stamp?.batch_id === "string" && stamp.batch_id.startsWith("contact-email-dns-check-"),
        "dns-29: stamp.batch_id follows the convention",
      );

      r = await post({ agent_ids: ["dns-dead-empty"] }, testKey, { apply: "1" });
      assertEq(resultFor(r.body, "dns-dead-empty")?.outcome, "dead", "dns-30: apply reports dead");
      assertEq(stampOf("dns-dead-empty")?.live, false, "dns-31: stamp.live=false for dead");
      assertEq(stampOf("dns-dead-empty")?.method, "none", "dns-32: stamp.method=none for dead");

      // ── row with no agent_knowledge row at all is still writable ─────────
      r = await post({ agent_ids: ["dns-no-knowledge"] }, testKey, { apply: "1" });
      assertEq(resultFor(r.body, "dns-no-knowledge")?.outcome, "dead", "dns-33: no-knowledge row still classified");
      assertEq(stampOf("dns-no-knowledge")?.live, false, "dns-34: stamp written despite no prior agent_knowledge row");

      // ── overwrite semantics: re-checking replaces the stamp wholesale ────
      r = await post({ agent_ids: ["dns-stale-stamp"] }, testKey, { apply: "1" });
      assertEq(resultFor(r.body, "dns-stale-stamp")?.outcome, "live", "dns-35: stale-stamp domain now resolves live");
      assertEq(stampOf("dns-stale-stamp")?.live, true, "dns-36: stamp overwritten (was false, now true)");

      // ── (k) batch cap rejection ───────────────────────────────────────────
      const tooMany = Array.from({ length: routeMod.CONTACT_EMAIL_DNS_CHECK_MAX_ITEMS + 1 }, (_v, i) => `bulk-${i}`);
      r = await post({ agent_ids: tooMany }, testKey, { apply: "1" });
      assertEq(r.status, 400, "dns-37: oversized agent_ids batch -> 400");

      // ── not_found for an id that doesn't exist ───────────────────────────
      r = await post({ agent_ids: ["does-not-exist"] });
      assertEq(resultFor(r.body, "does-not-exist")?.outcome, "not_found", "dns-38: unknown id reported as not_found");

      // ── pure helper ───────────────────────────────────────────────────────
      assertEq(routeMod.extractDomain("Post@Example.NO "), "example.no", "dns-39: extractDomain lowercases+trims");
      assertEq(routeMod.extractDomain("not-an-email"), null, "dns-40: extractDomain -> null with no '@'");
      assertEq(routeMod.extractDomain(""), null, "dns-41: extractDomain -> null for empty string");
    } finally {
      if (setKeyOurselves) delete process.env.ADMIN_KEY;
      try {
        const routeMod = require("./admin-agents-contact-email-dns-check");
        routeMod.__setContactEmailDnsCheckDbForTesting(null);
        routeMod.__setDnsResolverForTesting(null);
      } catch {
        /* ignore */
      }
      try {
        db.close();
      } catch {
        /* ignore */
      }
    }

    return { passed, failed, failures };
  })();
}
