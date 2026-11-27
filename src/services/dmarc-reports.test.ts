/**
 * dmarc-reports.test.ts — dev-request
 * 2026-11-26-innsyn-i-levering-dmarc-leveringsstatus-og-kontrollkopier, point 1
 * («DMARC-rapportene leses»), AK1 + AK2.
 *
 *   dm1-dm6    gzip report → exactly one stored row with the right numbers
 *              (aligned DKIM/SPF pass/fail weighted by row/count, DMARC pass =
 *              dkim OR spf); the same report again is stored once
 *   dm7-dm9    zip report (deflate, with a non-XML entry first) → one row;
 *              a stored (method 0) zip entry works too
 *   dm10-dm15  not stored: a non-report attachment (plain text, random bytes,
 *              zip without .xml, gzip of non-DMARC XML), a foreign policy domain
 *   dm16-dm19  bombs and size caps: gzip / zip over the decompressed cap, a zip
 *              lying about its size, a compressed attachment over 5 MB
 *   dm20-dm22  XML with DOCTYPE / ENTITY is rejected; an undeclared entity too
 *   dm23-dm25  an org written as an address keeps only the domain; subdomains
 *              count; report_metadata/email is never stored
 *   dm26-dm31  the REAL inbound webhook: a report mail's attachment is fetched
 *              through Resend's received-attachment endpoint and stored; the
 *              API key is not sent to the download URL; a human mail's
 *              attachment is never fetched; the forward still happens
 *   dm32-dm39  GET /admin/dmarc-reports/summary over loopback HTTP: admin key
 *              required; sums per day and per reporter; window; bad ?days → 400;
 *              no «@» anywhere in the JSON; a wider window
 *
 * Standalone:
 *   npx tsx src/services/dmarc-reports.test.ts
 */

import zlib from "zlib";
import http from "http";
import type { AddressInfo } from "net";
import Database from "better-sqlite3";
import * as initMod from "../database/init";
import { __resetDbFactoryForTesting } from "../database/db-factory";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

interface Rec { count: number; dkim: "pass" | "fail"; spf: "pass" | "fail"; ip?: string }

export function dmarcXml(o: {
  org: string;
  reportId: string;
  domain: string;
  begin: number;
  end: number;
  records: Rec[];
  email?: string;
  prolog?: string;
}): string {
  const recs = o.records
    .map(
      (r) => `
  <record>
    <row>
      <source_ip>${r.ip ?? "192.0.2.1"}</source_ip>
      <count>${r.count}</count>
      <policy_evaluated>
        <disposition>none</disposition>
        <dkim>${r.dkim}</dkim>
        <spf>${r.spf}</spf>
      </policy_evaluated>
    </row>
    <identifiers><header_from>${o.domain}</header_from></identifiers>
    <auth_results>
      <dkim><domain>${o.domain}</domain><result>${r.dkim}</result></dkim>
      <spf><domain>send.${o.domain}</domain><result>pass</result></spf>
    </auth_results>
  </record>`,
    )
    .join("");
  return `${o.prolog ?? '<?xml version="1.0" encoding="UTF-8" ?>'}
<feedback>
  <report_metadata>
    <org_name>${o.org}</org_name>
    <email>${o.email ?? "noreply-dmarc-support@google.com"}</email>
    <extra_contact_info>https://support.google.com/a/answer/2466580</extra_contact_info>
    <report_id>${o.reportId}</report_id>
    <date_range><begin>${o.begin}</begin><end>${o.end}</end></date_range>
  </report_metadata>
  <policy_published>
    <domain>${o.domain}</domain><adkim>r</adkim><aspf>r</aspf><p>none</p><sp>none</sp><pct>100</pct>
  </policy_published>${recs}
</feedback>
`;
}

let CRC: Uint32Array | null = null;
function crc32(buf: Buffer): number {
  if (!CRC) {
    CRC = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** A minimal zip archive (no data descriptors). declaredSize overrides the uncompressed size field. */
export function buildZip(entries: Array<{ name: string; data: Buffer; method?: 0 | 8; declaredSize?: number }>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const method = e.method ?? 8;
    const comp = method === 8 ? zlib.deflateRawSync(e.data) : e.data;
    const name = Buffer.from(e.name, "utf8");
    const crc = crc32(e.data);
    const size = e.declaredSize ?? e.data.length;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0, 6);
    lh.writeUInt16LE(method, 8);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(comp.length, 18);
    lh.writeUInt32LE(size, 22);
    lh.writeUInt16LE(name.length, 26);
    lh.writeUInt16LE(0, 28);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0, 8);
    ch.writeUInt16LE(method, 10);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(comp.length, 20);
    ch.writeUInt32LE(size, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(offset, 42);
    locals.push(lh, name, comp);
    centrals.push(ch, name);
    offset += 30 + name.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

export function runDmarcReportsTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
    const prevExperiencesDbPath = process.env.EXPERIENCES_DB_PATH;
    const prevAdminKey = process.env.ANALYTICS_ADMIN_KEY;
    const prevResendKey = process.env.RESEND_API_KEY;
    process.env.EXPERIENCES_DB_PATH = ":memory:";
    __resetDbFactoryForTesting();
    const db = new Database(":memory:");
    let server: http.Server | null = null;

    try {
      initMod.__setDbForTesting(db as any);
      initMod.__initSchemaForTesting(db as any);
      if (!process.env.ADMIN_KEY && !process.env.ANALYTICS_ADMIN_KEY) process.env.ANALYTICS_ADMIN_KEY = "test-admin-key";
      const adminKey = process.env.ADMIN_KEY || process.env.ANALYTICS_ADMIN_KEY || "";
      process.env.RESEND_API_KEY = "re_test_key";

      const dm = require("./dmarc-reports") as typeof import("./dmarc-reports");
      const wh = require("./inbound-email-webhook") as typeof import("./inbound-email-webhook");

      const rows = () => db.prepare("SELECT * FROM dmarc_aggregate_reports ORDER BY id").all() as any[];
      const count = () => (db.prepare("SELECT COUNT(*) AS n FROM dmarc_aggregate_reports").get() as { n: number }).n;

      // Fixed period: 2026-11-25 00:00:00Z – 23:59:59Z (and the day before).
      const day25 = Date.UTC(2026, 10, 25) / 1000;
      const day24 = Date.UTC(2026, 10, 24) / 1000;

      // ── dm1-dm6: gzip ─────────────────────────────────────────────────
      const googleXml = dmarcXml({
        org: "google.com",
        reportId: "1234567890123456789",
        domain: "rettfrabonden.com",
        begin: day25,
        end: day25 + 86399,
        records: [
          { count: 10, dkim: "pass", spf: "pass" },
          { count: 3, dkim: "pass", spf: "fail" },
          { count: 2, dkim: "fail", spf: "pass" },
          { count: 4, dkim: "fail", spf: "fail", ip: "198.51.100.7" },
        ],
      });
      const gz = zlib.gzipSync(Buffer.from(googleXml));
      const r1 = dm.ingestDmarcReportAttachment({ content: gz, inboundLogId: "inb-test-1" });
      eq(r1.status, "stored", "dm1: a gzip DMARC aggregate report is stored");
      eq(count(), 1, "dm2: exactly one row");
      const row1 = rows()[0];
      eq(
        {
          reporter_org: row1.reporter_org, report_id: row1.report_id, policy_domain: row1.policy_domain,
          date_begin: row1.date_begin, date_end: row1.date_end, report_date: row1.report_date,
          record_count: row1.record_count, message_count: row1.message_count, container: row1.container,
        },
        {
          reporter_org: "google.com", report_id: "1234567890123456789", policy_domain: "rettfrabonden.com",
          date_begin: "2026-11-25T00:00:00.000Z", date_end: "2026-11-25T23:59:59.000Z", report_date: "2026-11-25",
          record_count: 4, message_count: 19, container: "gzip",
        },
        "dm3: submitter, report_id, domain, period and message count",
      );
      eq(
        [row1.dkim_aligned_pass, row1.dkim_aligned_fail, row1.spf_aligned_pass, row1.spf_aligned_fail],
        [13, 6, 12, 7],
        "dm4: aligned DKIM 13/6 and SPF 12/7, weighted by row/count",
      );
      eq([row1.dmarc_pass, row1.dmarc_fail], [15, 4], "dm5: DMARC pass = dkim OR spf (15), fail 4");
      const again = dm.ingestDmarcReportAttachment({ content: gz });
      eq([again.status, count()], ["duplicate", 1], "dm6: the same report (org + report_id) again → stored once");

      // ── dm7-dm9: zip ──────────────────────────────────────────────────
      const msXml = dmarcXml({
        org: "Enterprise Outlook",
        reportId: "a1b2c3d4e5f6",
        domain: "opplevagent.no",
        begin: day24,
        end: day24 + 86399,
        records: [
          { count: 7, dkim: "pass", spf: "pass" },
          { count: 1, dkim: "fail", spf: "fail" },
        ],
      });
      const zip = buildZip([
        { name: "README.txt", data: Buffer.from("ignore me") },
        { name: "opplevagent.no!outlook.com!1764028800!1764115199.xml", data: Buffer.from(msXml) },
        { name: "second.xml", data: Buffer.from("<feedback/>") },
      ]);
      const r7 = dm.ingestDmarcReportAttachment({ content: zip });
      eq(r7.status, "stored", "dm7: a zip DMARC report (first .xml entry, other entries ignored) is stored");
      const row7 = rows().find((r) => r.report_id === "a1b2c3d4e5f6");
      eq(
        row7 && [row7.reporter_org, row7.policy_domain, row7.report_date, row7.message_count, row7.dkim_aligned_pass, row7.dkim_aligned_fail, row7.spf_aligned_pass, row7.spf_aligned_fail, row7.dmarc_pass, row7.dmarc_fail, row7.container],
        ["Enterprise Outlook", "opplevagent.no", "2026-11-24", 8, 7, 1, 7, 1, 7, 1, "zip"],
        "dm8: zip report numbers are right",
      );
      const stored0 = buildZip([{ name: "r.xml", method: 0, data: Buffer.from(dmarcXml({ org: "Yahoo", reportId: "y-1", domain: "rettfrabonden.com", begin: day24, end: day24 + 86399, records: [{ count: 5, dkim: "pass", spf: "fail" }] })) }]);
      eq(dm.ingestDmarcReportAttachment({ content: stored0 }).status, "stored", "dm9: a zip with a stored (uncompressed) entry works");
      const afterGood = count();

      // ── dm10-dm15: not reports ────────────────────────────────────────
      const notStored = (label: string, content: Buffer, expectStatus: string) => {
        const r = dm.ingestDmarcReportAttachment({ content });
        eq([r.status, count()], [expectStatus, afterGood], label);
      };
      notStored("dm10: a plain-text attachment is not stored", Buffer.from("Hei, her er menyen vår."), "rejected");
      notStored("dm11: random bytes are not stored", Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9]), "rejected");
      notStored("dm12: a zip without an .xml entry is not stored", buildZip([{ name: "faktura.pdf", data: Buffer.from("%PDF-1.4 …") }]), "rejected");
      notStored("dm13: gzip of XML that is not <feedback> is not stored", zlib.gzipSync(Buffer.from("<?xml version='1.0'?><invoice><total>100</total></invoice>")), "rejected");
      notStored(
        "dm14: a report for a foreign policy domain is ignored",
        zlib.gzipSync(Buffer.from(dmarcXml({ org: "google.com", reportId: "foreign-1", domain: "example.com", begin: day25, end: day25 + 86399, records: [{ count: 9, dkim: "pass", spf: "pass" }] }))),
        "ignored_domain",
      );
      notStored(
        "dm15: a look-alike domain (evilrettfrabonden.com) is ignored",
        zlib.gzipSync(Buffer.from(dmarcXml({ org: "google.com", reportId: "foreign-2", domain: "evilrettfrabonden.com", begin: day25, end: day25 + 86399, records: [{ count: 9, dkim: "pass", spf: "pass" }] }))),
        "ignored_domain",
      );

      // ── dm16-dm19: bombs and caps ─────────────────────────────────────
      const big = Buffer.alloc(dm.DMARC_MAX_DECOMPRESSED_BYTES + 1024, 0x20);
      const gzBomb = zlib.gzipSync(big);
      ok(gzBomb.length < 1_000_000, "dm16a: the gzip bomb is small when compressed");
      const b16 = dm.ingestDmarcReportAttachment({ content: gzBomb });
      eq([b16.status, count()], ["rejected", afterGood], "dm16: gzip over the 20 MB decompressed cap → rejected");
      const b17 = dm.ingestDmarcReportAttachment({ content: buildZip([{ name: "r.xml", data: big }]) });
      eq([b17.status, count()], ["rejected", afterGood], "dm17: zip entry over the decompressed cap → rejected");
      const b18 = dm.ingestDmarcReportAttachment({ content: buildZip([{ name: "r.xml", data: big, declaredSize: 1000 }]) });
      eq([b18.status, count()], ["rejected", afterGood], "dm18: zip lying about its uncompressed size → rejected (inflate capped)");
      const huge = Buffer.concat([Buffer.from([0x1f, 0x8b, 0x08]), Buffer.alloc(dm.DMARC_MAX_COMPRESSED_BYTES)]);
      const b19 = dm.ingestDmarcReportAttachment({ content: huge });
      eq([b19.status, b19.reason, count()], ["rejected", "attachment over the compressed size cap", afterGood], "dm19: compressed attachment over 5 MB → rejected before decompression");

      // ── dm20-dm22: DTD / entities ─────────────────────────────────────
      const xxe = dmarcXml({
        org: "&xxe;",
        reportId: "xxe-1",
        domain: "rettfrabonden.com",
        begin: day25,
        end: day25 + 86399,
        records: [{ count: 1, dkim: "pass", spf: "pass" }],
        prolog: '<?xml version="1.0"?>\n<!DOCTYPE feedback [ <!ENTITY xxe SYSTEM "file:///etc/passwd"> ]>',
      });
      const b20 = dm.ingestDmarcReportAttachment({ content: zlib.gzipSync(Buffer.from(xxe)) });
      eq([b20.status, count()], ["rejected", afterGood], "dm20: XML with DOCTYPE/ENTITY (XXE) → rejected");
      ok(/DOCTYPE|declaration/i.test(b20.reason ?? ""), `dm21: the reason names the declaration (${b20.reason})`);
      const undeclared = dmarcXml({ org: "x&foo;y", reportId: "ent-1", domain: "rettfrabonden.com", begin: day25, end: day25 + 86399, records: [{ count: 1, dkim: "pass", spf: "pass" }] });
      eq(dm.ingestDmarcReportAttachment({ content: zlib.gzipSync(Buffer.from(undeclared)) }).status, "rejected", "dm22: an undeclared entity → rejected");

      // ── dm23-dm25: addresses never stored ─────────────────────────────
      const addrOrg = dmarcXml({ org: "dmarc-reports@mail.example.net", reportId: "addr-1", domain: "send.rettfrabonden.com", begin: day25, end: day25 + 86399, records: [{ count: 2, dkim: "fail", spf: "pass" }], email: "secret.person@example.org" });
      eq(dm.ingestDmarcReportAttachment({ content: zlib.gzipSync(Buffer.from(addrOrg)) }).status, "stored", "dm23: a subdomain (send.rettfrabonden.com) counts");
      const row23 = rows().find((r) => r.report_id === "addr-1");
      eq(row23?.reporter_org, "mail.example.net", "dm24: an org written as an address keeps only its domain");
      const allText = JSON.stringify(db.prepare("SELECT * FROM dmarc_aggregate_reports").all());
      ok(!allText.includes("@") && !allText.includes("secret.person"), "dm25: no e-mail address anywhere in the stored rows");

      // ── dm26-dm31: the real inbound webhook ───────────────────────────
      const webhookXml = dmarcXml({ org: "google.com", reportId: "wh-1", domain: "opplevagent.no", begin: day25, end: day25 + 86399, records: [{ count: 6, dkim: "pass", spf: "fail" }, { count: 1, dkim: "fail", spf: "fail" }] });
      const webhookGz = zlib.gzipSync(Buffer.from(webhookXml));
      const calls: Array<{ url: string; auth: string | null }> = [];
      const fetchImpl = (async (url: string, init?: any) => {
        calls.push({ url, auth: init?.headers?.Authorization ?? null });
        if (url === "https://api.resend.com/emails/receiving/em-dmarc-1") {
          return { ok: true, json: async () => ({ text: "", html: "", attachments: [{ id: "att-1", filename: "google.com!opplevagent.no!1764028800!1764115199.xml.gz", content_type: "application/gzip", size: webhookGz.length }] }) };
        }
        if (url === "https://api.resend.com/emails/receiving/em-dmarc-1/attachments/att-1") {
          return { ok: true, json: async () => ({ id: "att-1", download_url: "https://inbound-cdn.resend.example/att-1?sig=abc", size: webhookGz.length }) };
        }
        if (url.startsWith("https://inbound-cdn.resend.example/att-1")) {
          return { ok: true, status: 200, headers: { get: (h: string) => (h.toLowerCase() === "content-length" ? String(webhookGz.length) : null) }, arrayBuffer: async () => webhookGz.buffer.slice(webhookGz.byteOffset, webhookGz.byteOffset + webhookGz.length) };
        }
        if (url === "https://api.resend.com/emails/receiving/em-human-1") {
          return { ok: true, json: async () => ({ text: "Hei, se vedlegg", html: "", attachments: [{ id: "att-h", filename: "bilder.zip", content_type: "application/zip", size: 1000 }] }) };
        }
        return { ok: false, status: 404, json: async () => ({}) };
      }) as any;
      const sent: any[] = [];
      const mkRes = () => { const r: any = { code: 0 }; r.status = (c: number) => { r.code = c; return r; }; r.json = () => r; return r; };
      const deps = { serverIngest: false, fetchImpl, sendEmail: async (o: any) => { sent.push(o); return { success: true }; } };
      const before = count();
      await wh.handleInboundEmailWebhook(
        { body: { type: "email.received", data: { email_id: "em-dmarc-1", from: "noreply-dmarc-support@google.com", to: ["dmarc@opplevagent.no"], subject: "Report domain: opplevagent.no Submitter: google.com Report-ID: wh-1" } } } as any,
        mkRes(),
        deps as any,
      );
      eq(count(), before + 1, "dm26: a report mail through the webhook stores its report");
      const whRow = rows().find((r) => r.report_id === "wh-1");
      eq(whRow && [whRow.policy_domain, whRow.message_count, whRow.dmarc_pass, whRow.dmarc_fail], ["opplevagent.no", 7, 6, 1], "dm27: webhook-stored numbers are right");
      ok(typeof whRow?.inbound_log_id === "string" && whRow.inbound_log_id.startsWith("inb-"), "dm28: the row points at the inbound log row");
      const dl = calls.find((c) => c.url.startsWith("https://inbound-cdn.resend.example/"));
      ok(!!dl && dl.auth === null, "dm29: the API key is not sent to the download URL");
      eq(sent.length, 1, "dm30: the report mail is still forwarded as before");
      calls.length = 0;
      await wh.handleInboundEmailWebhook(
        { body: { type: "email.received", data: { email_id: "em-human-1", from: "Kari <kari@testgard.no>", to: ["kontakt@rettfrabonden.com"], subject: "Bilder til profilen" } } } as any,
        mkRes(),
        deps as any,
      );
      ok(!calls.some((c) => c.url.includes("/attachments/")), "dm31: a human mail's attachment is never fetched");

      // ── dm32-dm38: admin summary over HTTP ────────────────────────────
      const express = require("express");
      const routeMod = require("../routes/admin-dmarc-reports");
      const app = express();
      app.use("/admin/dmarc-reports", routeMod.default);
      server = await new Promise<http.Server>((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
      const port = (server.address() as AddressInfo).port;
      const get = async (path: string, key: string | null = adminKey) => {
        const res = await fetch(`http://127.0.0.1:${port}${path}`, { headers: key ? { "x-admin-key": key } : {} });
        const text = await res.text();
        return { status: res.status, text, body: JSON.parse(text) };
      };
      eq((await get("/admin/dmarc-reports/summary", null)).status, 403, "dm32: no admin key → 403");
      eq((await get("/admin/dmarc-reports/summary?days=0")).status, 400, "dm33: days=0 → 400");

      // Fix "today" so the window is deterministic: move every row into the last few days.
      const today = new Date().toISOString().slice(0, 10);
      const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
      const old = new Date(Date.now() - 40 * 86_400_000).toISOString().slice(0, 10);
      db.prepare("UPDATE dmarc_aggregate_reports SET report_date = ? WHERE report_date = '2026-11-25'").run(today);
      db.prepare("UPDATE dmarc_aggregate_reports SET report_date = ? WHERE report_date = '2026-11-24'").run(yesterday);
      db.prepare("UPDATE dmarc_aggregate_reports SET report_date = ? WHERE report_id = 'y-1'").run(old);

      const s = await get("/admin/dmarc-reports/summary?days=7");
      eq(s.status, 200, "dm34: summary → 200");
      // In window: google rfb (19: 15/4), outlook opplevagent (8: 7/1), mail.example.net rfb (2: 2/0), google opplevagent wh-1 (7: 6/1). y-1 is outside.
      eq([s.body.totals.reports, s.body.totals.messages, s.body.totals.dmarc_pass, s.body.totals.dmarc_fail], [4, 36, 30, 6], "dm35: totals over the window (the 40-day-old report is outside)");
      const dayRfb = s.body.by_day.find((d: any) => d.date === today && d.domain === "rettfrabonden.com");
      const dayOa = s.body.by_day.find((d: any) => d.date === today && d.domain === "opplevagent.no");
      const yOa = s.body.by_day.find((d: any) => d.date === yesterday && d.domain === "opplevagent.no");
      eq(
        [dayRfb && [dayRfb.reports, dayRfb.messages, dayRfb.dkim_aligned_pass, dayRfb.dkim_aligned_fail, dayRfb.spf_aligned_pass, dayRfb.spf_aligned_fail, dayRfb.dmarc_pass, dayRfb.dmarc_fail],
         dayOa && [dayOa.reports, dayOa.messages, dayOa.dmarc_pass], yOa && [yOa.reports, yOa.messages]],
        [[2, 21, 13, 8, 14, 7, 17, 4], [1, 7, 6], [1, 8]],
        "dm36: sums per day per domain (subdomain counted under its root)",
      );
      const gOa = s.body.by_reporter.find((r: any) => r.reporter === "google.com" && r.domain === "opplevagent.no");
      const gRfb = s.body.by_reporter.find((r: any) => r.reporter === "google.com" && r.domain === "rettfrabonden.com");
      const ms = s.body.by_reporter.find((r: any) => r.reporter === "Enterprise Outlook");
      eq([gOa?.messages, gRfb?.messages, ms?.messages, s.body.by_reporter.length], [7, 19, 8, 4], "dm37: sums per submitter (reporter org) per domain");
      ok(!s.text.includes("@"), "dm38: no «@» (no e-mail address) anywhere in the summary JSON");
      const s90 = await get("/admin/dmarc-reports/summary?days=90");
      eq(s90.body.totals.reports, 5, "dm39: a wider window includes the older report");
    } catch (err: any) {
      failed++;
      failures.push("unexpected error: " + String(err?.stack || err));
    } finally {
      if (server) await new Promise<void>((r) => server!.close(() => r()));
      try { db.close(); } catch { /* already closed */ }
      initMod.__setDbForTesting(prevDb as any);
      if (prevExperiencesDbPath === undefined) delete process.env.EXPERIENCES_DB_PATH;
      else process.env.EXPERIENCES_DB_PATH = prevExperiencesDbPath;
      __resetDbFactoryForTesting();
      if (prevAdminKey === undefined) delete process.env.ANALYTICS_ADMIN_KEY;
      else process.env.ANALYTICS_ADMIN_KEY = prevAdminKey;
      if (prevResendKey === undefined) delete process.env.RESEND_API_KEY;
      else process.env.RESEND_API_KEY = prevResendKey;
    }

    if (log) console.log(`\n${passed} passed, ${failed} failed`);
    return { passed, failed, failures };
  })();
}

if (require.main === module) {
  runDmarcReportsTests({ log: true }).then((r) => {
    if (r.failed) {
      for (const f of r.failures) console.log(f);
      process.exit(1);
    }
  });
}
