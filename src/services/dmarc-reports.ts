// ─── DMARC aggregate reports: read and stored ─────────────────────────────
// dev-request 2026-11-26-innsyn-i-levering-dmarc-leveringsstatus-og-kontrollkopier,
// point 1 («DMARC-rapportene leses», AK1 + AK2).
//
// The domains' DMARC records (rua=) send aggregate reports to our platform
// addresses. cs-inbound already classifies those mails as kind "report"; this
// module reads the report attachment of such a mail and stores, per report:
// submitter (reporter org), report_id, policy domain, period, message count and
// how many passed / failed DKIM and SPF WITH ALIGNMENT (row/policy_evaluated,
// weighted by row/count), plus DMARC pass (dkim OR spf aligned) / fail — the
// numbers point 2's daily alert line needs.
//
// The attachment comes from an unknown sender, so it is treated as data only:
//   • compressed ≤ 5 MB, decompressed ≤ 20 MB (zlib maxOutputLength — a gzip
//     or zip bomb stops at the cap, nothing is buffered past it);
//   • only gzip, or zip with ONE .xml entry (the first; everything else in the
//     archive is ignored); nothing is ever written to disk;
//   • the XML is read by a small streaming reader below: no DTD, no entity
//     declarations, no external anything — a <!DOCTYPE …> / <!ENTITY …> makes
//     the report rejected; only the five predefined entities and numeric
//     character references are decoded;
//   • only rettfrabonden.com and opplevagent.no (and their subdomains) are
//     stored; any other policy domain is ignored;
//   • no e-mail address is stored: report_metadata/email and
//     extra_contact_info are never read, and a reporter org written as an
//     address keeps only its domain part.
// Idempotent: UNIQUE(reporter_org, report_id) — the same report twice is one row.

import zlib from "zlib";
import { getDb } from "../database/init";

export const DMARC_MAX_COMPRESSED_BYTES = 5 * 1024 * 1024;
export const DMARC_MAX_DECOMPRESSED_BYTES = 20 * 1024 * 1024;
/** Attachments read per mail (a report mail carries one). */
export const DMARC_MAX_ATTACHMENTS_PER_MAIL = 3;
const ZIP_MAX_ENTRIES_SCANNED = 64;
const XML_MAX_DEPTH = 32;
const XML_MAX_ELEMENTS = 2_000_000;
const XML_MAX_TEXT = 1024;
const MAX_ROW_COUNT = 1_000_000_000;

export const DMARC_DOMAINS: readonly string[] = ["rettfrabonden.com", "opplevagent.no"];

/** The platform domain a policy domain belongs to (itself or a subdomain), else null. */
export function dmarcPlatformDomain(domain: string): string | null {
  const d = domain.trim().toLowerCase().replace(/\.$/, "");
  for (const root of DMARC_DOMAINS) {
    if (d === root || d.endsWith("." + root)) return root;
  }
  return null;
}

// ─── Decompression ────────────────────────────────────────────────────────

export type DecodeResult = { ok: true; xml: string; container: "gzip" | "zip" } | { ok: false; reason: string };

function isGzip(b: Buffer): boolean {
  return b.length >= 3 && b[0] === 0x1f && b[1] === 0x8b && b[2] === 0x08;
}
function isZip(b: Buffer): boolean {
  return b.length >= 4 && b.readUInt32LE(0) === 0x04034b50;
}

let CRC_TABLE: Uint32Array | null = null;
function crc32(buf: Buffer): number {
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** The first .xml entry of a zip archive, decompressed in memory, or a reason. */
function readZipXmlEntry(b: Buffer): { ok: true; data: Buffer } | { ok: false; reason: string } {
  // End of central directory: 22 bytes + an optional comment of ≤ 65535.
  const minPos = Math.max(0, b.length - 22 - 0xffff);
  let eocd = -1;
  for (let p = b.length - 22; p >= minPos; p--) {
    if (b.readUInt32LE(p) === 0x06054b50) { eocd = p; break; }
  }
  if (eocd < 0) return { ok: false, reason: "zip: no end of central directory" };
  const entries = b.readUInt16LE(eocd + 10);
  const cdOffset = b.readUInt32LE(eocd + 16);
  if (entries === 0xffff || cdOffset === 0xffffffff) return { ok: false, reason: "zip: zip64 not supported" };
  let p = cdOffset;
  for (let i = 0; i < Math.min(entries, ZIP_MAX_ENTRIES_SCANNED); i++) {
    if (p + 46 > b.length || b.readUInt32LE(p) !== 0x02014b50) return { ok: false, reason: "zip: bad central directory" };
    const flags = b.readUInt16LE(p + 8);
    const method = b.readUInt16LE(p + 10);
    const crc = b.readUInt32LE(p + 16);
    const compSize = b.readUInt32LE(p + 20);
    const size = b.readUInt32LE(p + 24);
    const nameLen = b.readUInt16LE(p + 28);
    const extraLen = b.readUInt16LE(p + 30);
    const commentLen = b.readUInt16LE(p + 32);
    const localOffset = b.readUInt32LE(p + 42);
    if (p + 46 + nameLen > b.length) return { ok: false, reason: "zip: bad central directory" };
    const name = b.subarray(p + 46, p + 46 + nameLen).toString("latin1");
    p += 46 + nameLen + extraLen + commentLen;
    if (!/\.xml$/i.test(name)) continue; // everything but the report is ignored

    if (flags & 0x1) return { ok: false, reason: "zip: encrypted entry" };
    if (method !== 0 && method !== 8) return { ok: false, reason: `zip: unsupported method ${method}` };
    if (size > DMARC_MAX_DECOMPRESSED_BYTES) return { ok: false, reason: "zip: entry too large" };
    if (localOffset + 30 > b.length || b.readUInt32LE(localOffset) !== 0x04034b50) return { ok: false, reason: "zip: bad local header" };
    const start = localOffset + 30 + b.readUInt16LE(localOffset + 26) + b.readUInt16LE(localOffset + 28);
    if (start + compSize > b.length) return { ok: false, reason: "zip: truncated entry" };
    const raw = b.subarray(start, start + compSize);
    let data: Buffer;
    try {
      data = method === 0 ? Buffer.from(raw) : zlib.inflateRawSync(raw, { maxOutputLength: DMARC_MAX_DECOMPRESSED_BYTES });
    } catch {
      return { ok: false, reason: "zip: inflate failed or over the size cap" };
    }
    if (data.length !== size || crc32(data) !== crc) return { ok: false, reason: "zip: size/crc mismatch" };
    return { ok: true, data };
  }
  return { ok: false, reason: "zip: no .xml entry" };
}

/** gzip or zip bytes → the report XML text (caps enforced), or a reason. */
export function decodeReportAttachment(content: Buffer): DecodeResult {
  if (content.length > DMARC_MAX_COMPRESSED_BYTES) return { ok: false, reason: "attachment over the compressed size cap" };
  let data: Buffer;
  let container: "gzip" | "zip";
  if (isGzip(content)) {
    container = "gzip";
    try {
      data = zlib.gunzipSync(content, { maxOutputLength: DMARC_MAX_DECOMPRESSED_BYTES });
    } catch {
      return { ok: false, reason: "gzip: invalid or over the decompressed size cap" };
    }
  } else if (isZip(content)) {
    container = "zip";
    const z = readZipXmlEntry(content);
    if (!z.ok) return z;
    data = z.data;
  } else {
    return { ok: false, reason: "not gzip or zip" };
  }
  let xml = data.toString("utf8");
  if (xml.charCodeAt(0) === 0xfeff) xml = xml.slice(1);
  return { ok: true, xml, container };
}

// ─── XML (streaming, no DTD) ──────────────────────────────────────────────

const PREDEFINED: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|[A-Za-z]{2,4});/g, (_m, e: string) => {
    if (e[0] === "#") {
      const cp = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      if (!Number.isFinite(cp) || cp > 0x10ffff) throw new Error("xml: bad character reference");
      return String.fromCodePoint(cp);
    }
    const v = PREDEFINED[e];
    if (v === undefined) throw new Error("xml: undeclared entity");
    return v;
  });
}

/**
 * A minimal, non-validating streaming reader: calls onOpen(path) for each
 * element and onClose(path, text) with the element's own direct text. Throws
 * on DOCTYPE/ENTITY/any other markup declaration, mismatched tags, or limits.
 */
export function walkXml(
  xml: string,
  onOpen: (path: string) => void,
  onClose: (path: string, text: string) => void,
): void {
  const stack: string[] = [];
  let text = "";
  let elements = 0;
  let sawRoot = false;
  let i = 0;
  const n = xml.length;
  const appendText = (t: string) => {
    if (!stack.length) {
      if (t.trim()) throw new Error("xml: text outside the root element");
      return;
    }
    if (text.length < XML_MAX_TEXT) text += t.slice(0, XML_MAX_TEXT - text.length);
  };
  while (i < n) {
    const lt = xml.indexOf("<", i);
    if (lt < 0) { appendText(xml.slice(i)); break; }
    if (lt > i) appendText(decodeEntities(xml.slice(i, lt)));
    if (xml.startsWith("<?", lt)) {
      const e = xml.indexOf("?>", lt + 2);
      if (e < 0) throw new Error("xml: unterminated processing instruction");
      i = e + 2;
    } else if (xml.startsWith("<!--", lt)) {
      const e = xml.indexOf("-->", lt + 4);
      if (e < 0) throw new Error("xml: unterminated comment");
      i = e + 3;
    } else if (xml.startsWith("<![CDATA[", lt)) {
      const e = xml.indexOf("]]>", lt + 9);
      if (e < 0) throw new Error("xml: unterminated CDATA");
      appendText(xml.slice(lt + 9, e));
      i = e + 3;
    } else if (xml.startsWith("<!", lt)) {
      throw new Error("xml: markup declarations (DOCTYPE/ENTITY) are not accepted");
    } else if (xml.startsWith("</", lt)) {
      const e = xml.indexOf(">", lt + 2);
      if (e < 0) throw new Error("xml: unterminated end tag");
      const name = localName(xml.slice(lt + 2, e).trim());
      if (!stack.length || stack[stack.length - 1] !== name) throw new Error("xml: mismatched end tag");
      onClose(stack.join("/"), text);
      stack.pop();
      text = "";
      i = e + 1;
    } else {
      // Start tag; attributes are skipped, quotes respected.
      let j = lt + 1;
      let quote = "";
      while (j < n) {
        const c = xml[j];
        if (quote) { if (c === quote) quote = ""; }
        else if (c === '"' || c === "'") quote = c;
        else if (c === ">") break;
        j++;
      }
      if (j >= n) throw new Error("xml: unterminated start tag");
      const inner = xml.slice(lt + 1, j);
      const selfClosing = inner.endsWith("/");
      const m = /^[^\s/>]+/.exec(inner);
      if (!m) throw new Error("xml: bad start tag");
      const name = localName(m[0]);
      if (!stack.length) {
        if (sawRoot) throw new Error("xml: more than one root element");
        sawRoot = true;
      }
      if (++elements > XML_MAX_ELEMENTS) throw new Error("xml: too many elements");
      stack.push(name);
      if (stack.length > XML_MAX_DEPTH) throw new Error("xml: too deep");
      text = "";
      onOpen(stack.join("/"));
      if (selfClosing) {
        onClose(stack.join("/"), "");
        stack.pop();
      }
      i = j + 1;
    }
  }
  if (stack.length) throw new Error("xml: unclosed elements");
  if (!sawRoot) throw new Error("xml: no root element");
}

function localName(qname: string): string {
  const c = qname.lastIndexOf(":");
  return (c >= 0 ? qname.slice(c + 1) : qname).toLowerCase();
}

// ─── Report ───────────────────────────────────────────────────────────────

export interface DmarcReportSummary {
  reporterOrg: string;
  reportId: string;
  policyDomain: string;
  dateBegin: number; // unix seconds
  dateEnd: number;
  recordCount: number;
  messageCount: number;
  dkimAlignedPass: number;
  dkimAlignedFail: number;
  spfAlignedPass: number;
  spfAlignedFail: number;
  dmarcPass: number;
  dmarcFail: number;
}

/** A reporter org name without any mailbox: «x@y.com» → «y.com». */
export function sanitizeReporterOrg(s: string): string {
  let t = s.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  if (t.includes("@")) t = t.split("@").filter(Boolean).pop() ?? "";
  t = t.replace(/@/g, "").replace(/^[<>"'\s]+|[<>"'\s]+$/g, "");
  return t.slice(0, 200);
}

/** The XML of one DMARC aggregate report → its sums, or a reason. Never throws. */
export function parseDmarcAggregateXml(xml: string): { ok: true; report: DmarcReportSummary } | { ok: false; reason: string } {
  let org = "";
  let reportId = "";
  let domain = "";
  let begin = "";
  let end = "";
  let root = "";
  let records = 0;
  let total = 0, dkimPass = 0, dkimFail = 0, spfPass = 0, spfFail = 0, dmarcPass = 0, dmarcFail = 0;
  let cur: { count: number | null; dkim: string; spf: string } | null = null;
  try {
    walkXml(
      xml,
      (path) => {
        if (!root) root = path;
        if (path === "feedback/record") cur = { count: null, dkim: "", spf: "" };
      },
      (path, raw) => {
        const t = raw.trim();
        switch (path) {
          case "feedback/report_metadata/org_name": org = t; break;
          case "feedback/report_metadata/report_id": reportId = t; break;
          case "feedback/report_metadata/date_range/begin": begin = t; break;
          case "feedback/report_metadata/date_range/end": end = t; break;
          case "feedback/policy_published/domain": domain = t; break;
          case "feedback/record/row/count":
            if (cur) {
              if (!/^\d{1,10}$/.test(t)) throw new Error("bad row count");
              cur.count = Number(t);
            }
            break;
          case "feedback/record/row/policy_evaluated/dkim": if (cur) cur.dkim = t.toLowerCase(); break;
          case "feedback/record/row/policy_evaluated/spf": if (cur) cur.spf = t.toLowerCase(); break;
          case "feedback/record": {
            const r = cur;
            cur = null;
            if (!r || r.count === null) throw new Error("record without row/count");
            const c = r.count;
            if (c > MAX_ROW_COUNT) throw new Error("row count out of range");
            records++;
            total += c;
            const dk = r.dkim === "pass";
            const sp = r.spf === "pass";
            if (dk) dkimPass += c; else dkimFail += c;
            if (sp) spfPass += c; else spfFail += c;
            if (dk || sp) dmarcPass += c; else dmarcFail += c;
            break;
          }
        }
      },
    );
  } catch (e: any) {
    return { ok: false, reason: String(e?.message ?? e).slice(0, 200) };
  }
  if (root !== "feedback") return { ok: false, reason: "not a DMARC aggregate report (root is not <feedback>)" };
  const reporterOrg = sanitizeReporterOrg(org);
  if (!reporterOrg) return { ok: false, reason: "missing org_name" };
  if (!reportId || reportId.length > 255) return { ok: false, reason: "missing or oversized report_id" };
  const d = domain.toLowerCase().replace(/\.$/, "");
  if (!/^[a-z0-9.-]{1,253}$/.test(d)) return { ok: false, reason: "missing or invalid policy domain" };
  if (!/^\d{1,12}$/.test(begin) || !/^\d{1,12}$/.test(end)) return { ok: false, reason: "missing or invalid date_range" };
  const b = Number(begin);
  const en = Number(end);
  if (en < b) return { ok: false, reason: "date_range end before begin" };
  return {
    ok: true,
    report: {
      reporterOrg, reportId, policyDomain: d, dateBegin: b, dateEnd: en,
      recordCount: records, messageCount: total,
      dkimAlignedPass: dkimPass, dkimAlignedFail: dkimFail,
      spfAlignedPass: spfPass, spfAlignedFail: spfFail,
      dmarcPass, dmarcFail,
    },
  };
}

export type IngestStatus = "stored" | "duplicate" | "ignored_domain" | "rejected";

/** One attachment's bytes → stored report (or why not). Never throws on bad input. */
export function ingestDmarcReportAttachment(input: { content: Buffer; inboundLogId?: string | null }): {
  status: IngestStatus;
  reason?: string;
  reportId?: string;
} {
  const dec = decodeReportAttachment(input.content);
  if (!dec.ok) return { status: "rejected", reason: dec.reason };
  const parsed = parseDmarcAggregateXml(dec.xml);
  if (!parsed.ok) return { status: "rejected", reason: parsed.reason };
  const r = parsed.report;
  if (!dmarcPlatformDomain(r.policyDomain)) return { status: "ignored_domain", reason: "policy domain is not one of ours" };
  const iso = (s: number) => new Date(s * 1000).toISOString();
  const res = getDb()
    .prepare(
      `INSERT OR IGNORE INTO dmarc_aggregate_reports
         (reporter_org, report_id, policy_domain, date_begin, date_end, report_date,
          record_count, message_count, dkim_aligned_pass, dkim_aligned_fail,
          spf_aligned_pass, spf_aligned_fail, dmarc_pass, dmarc_fail, container, inbound_log_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      r.reporterOrg, r.reportId, r.policyDomain, iso(r.dateBegin), iso(r.dateEnd), iso(r.dateBegin).slice(0, 10),
      r.recordCount, r.messageCount, r.dkimAlignedPass, r.dkimAlignedFail,
      r.spfAlignedPass, r.spfAlignedFail, r.dmarcPass, r.dmarcFail, dec.container, input.inboundLogId ?? null,
    );
  return { status: res.changes === 1 ? "stored" : "duplicate", reportId: r.reportId };
}

// ─── From the inbound mail (Resend) ───────────────────────────────────────

interface AttachmentMeta {
  id?: unknown;
  filename?: unknown;
  content_type?: unknown;
  size?: unknown;
  content?: unknown;
}

function looksLikeReportFile(a: AttachmentMeta): boolean {
  const f = typeof a.filename === "string" ? a.filename.toLowerCase() : "";
  const ct = typeof a.content_type === "string" ? a.content_type.toLowerCase() : "";
  return /\.(gz|zip)$/.test(f) || /(gzip|zip)/.test(ct);
}

async function readCapped(res: any, max: number): Promise<Buffer | null> {
  const len = Number(res?.headers?.get?.("content-length"));
  if (Number.isFinite(len) && len > max) return null;
  const body = res?.body;
  if (body && typeof body.getReader === "function") {
    const reader = body.getReader();
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > max) { try { await reader.cancel(); } catch { /* ignore */ } return null; }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks);
  }
  const ab: ArrayBuffer = await res.arrayBuffer();
  if (ab.byteLength > max) return null;
  return Buffer.from(ab);
}

/**
 * For an inbound mail classified as a machine report: read its gzip/zip
 * attachment(s) and store any DMARC aggregate report found. The attachment
 * list comes from the received e-mail Resend returned (or the webhook data);
 * the bytes from Resend's received-attachment endpoint (download_url), with
 * the same RESEND_API_KEY the webhook already uses for the body. Never throws.
 */
export async function ingestDmarcAttachmentsFromInbound(opts: {
  emailId: string | null;
  data: any;
  fetched: any;
  inboundLogId: string | null;
  resendKey: string | undefined;
  fetchImpl: typeof fetch;
  timeoutMs: number;
}): Promise<Array<{ filename: string; status: IngestStatus; reason?: string }>> {
  const out: Array<{ filename: string; status: IngestStatus; reason?: string }> = [];
  const list: AttachmentMeta[] = Array.isArray(opts.fetched?.attachments)
    ? opts.fetched.attachments
    : Array.isArray(opts.data?.attachments)
      ? opts.data.attachments
      : [];
  const candidates = list.filter((a) => a && typeof a === "object" && looksLikeReportFile(a)).slice(0, DMARC_MAX_ATTACHMENTS_PER_MAIL);
  for (const a of candidates) {
    const filename = typeof a.filename === "string" ? a.filename.replace(/[\u0000-\u001f\u007f]+/g, " ").slice(0, 200) : "(uten navn)";
    try {
      if (typeof a.size === "number" && a.size > DMARC_MAX_COMPRESSED_BYTES) {
        out.push({ filename, status: "rejected", reason: "attachment over the compressed size cap" });
        continue;
      }
      let content: Buffer | null = null;
      if (typeof a.content === "string" && a.content) {
        if (a.content.length > Math.ceil(DMARC_MAX_COMPRESSED_BYTES / 3) * 4 + 4) {
          out.push({ filename, status: "rejected", reason: "attachment over the compressed size cap" });
          continue;
        }
        content = Buffer.from(a.content, "base64");
      } else if (typeof a.id === "string" && a.id && opts.emailId && opts.resendKey) {
        const metaRes: any = await opts.fetchImpl(
          `https://api.resend.com/emails/receiving/${encodeURIComponent(opts.emailId)}/attachments/${encodeURIComponent(a.id)}`,
          { headers: { Authorization: `Bearer ${opts.resendKey}` }, signal: AbortSignal.timeout(opts.timeoutMs) },
        );
        if (!metaRes?.ok) {
          out.push({ filename, status: "rejected", reason: `attachment lookup failed (${metaRes?.status ?? "?"})` });
          continue;
        }
        const meta: any = await metaRes.json();
        const url = typeof meta?.download_url === "string" ? meta.download_url : "";
        if (!/^https:\/\//i.test(url)) {
          out.push({ filename, status: "rejected", reason: "no https download_url" });
          continue;
        }
        if (typeof meta?.size === "number" && meta.size > DMARC_MAX_COMPRESSED_BYTES) {
          out.push({ filename, status: "rejected", reason: "attachment over the compressed size cap" });
          continue;
        }
        // The signed download URL carries its own authorization; our API key is not sent there.
        const fileRes: any = await opts.fetchImpl(url, { signal: AbortSignal.timeout(opts.timeoutMs) });
        if (!fileRes?.ok) {
          out.push({ filename, status: "rejected", reason: `attachment download failed (${fileRes?.status ?? "?"})` });
          continue;
        }
        content = await readCapped(fileRes, DMARC_MAX_COMPRESSED_BYTES);
        if (!content) {
          out.push({ filename, status: "rejected", reason: "attachment over the compressed size cap" });
          continue;
        }
      } else {
        out.push({ filename, status: "rejected", reason: "attachment content not available" });
        continue;
      }
      const r = ingestDmarcReportAttachment({ content, inboundLogId: opts.inboundLogId });
      out.push({ filename, status: r.status, reason: r.reason });
    } catch (e: any) {
      out.push({ filename, status: "rejected", reason: String(e?.message ?? e).slice(0, 200) });
    }
  }
  return out;
}

// ─── Admin summary ────────────────────────────────────────────────────────

export interface DmarcSums {
  reports: number;
  messages: number;
  dkim_aligned_pass: number;
  dkim_aligned_fail: number;
  spf_aligned_pass: number;
  spf_aligned_fail: number;
  dmarc_pass: number;
  dmarc_fail: number;
}

const SUM_SQL = `COUNT(*) AS reports,
  COALESCE(SUM(message_count),0) AS messages,
  COALESCE(SUM(dkim_aligned_pass),0) AS dkim_aligned_pass,
  COALESCE(SUM(dkim_aligned_fail),0) AS dkim_aligned_fail,
  COALESCE(SUM(spf_aligned_pass),0) AS spf_aligned_pass,
  COALESCE(SUM(spf_aligned_fail),0) AS spf_aligned_fail,
  COALESCE(SUM(dmarc_pass),0) AS dmarc_pass,
  COALESCE(SUM(dmarc_fail),0) AS dmarc_fail`;

// The platform domain (a subdomain counts under its root) as SQL.
const DOMAIN_SQL = `CASE
  WHEN policy_domain = 'opplevagent.no' OR policy_domain LIKE '%.opplevagent.no' THEN 'opplevagent.no'
  ELSE 'rettfrabonden.com' END`;

const noAt = (s: string) => s.replace(/@/g, "");

/** Sums per day (UTC date of the report period's start) and per submitter, per platform domain. No addresses. */
export function summarizeDmarcReports(days: number, now: Date = new Date()): {
  days: number;
  since: string;
  totals: DmarcSums;
  by_day: Array<{ date: string; domain: string } & DmarcSums>;
  by_reporter: Array<{ reporter: string; domain: string } & DmarcSums>;
} {
  const since = new Date(now.getTime() - (days - 1) * 86_400_000).toISOString().slice(0, 10);
  const db = getDb();
  const totals = db.prepare(`SELECT ${SUM_SQL} FROM dmarc_aggregate_reports WHERE report_date >= ?`).get(since) as DmarcSums;
  const byDay = db
    .prepare(
      `SELECT report_date AS date, ${DOMAIN_SQL} AS domain, ${SUM_SQL}
         FROM dmarc_aggregate_reports WHERE report_date >= ?
        GROUP BY report_date, domain ORDER BY report_date DESC, domain`,
    )
    .all(since) as Array<{ date: string; domain: string } & DmarcSums>;
  const byReporter = db
    .prepare(
      `SELECT reporter_org AS reporter, ${DOMAIN_SQL} AS domain, ${SUM_SQL}
         FROM dmarc_aggregate_reports WHERE report_date >= ?
        GROUP BY reporter_org, domain ORDER BY messages DESC, reporter_org, domain`,
    )
    .all(since) as Array<{ reporter: string; domain: string } & DmarcSums>;
  return {
    days,
    since,
    totals,
    by_day: byDay,
    by_reporter: byReporter.map((r) => ({ ...r, reporter: noAt(r.reporter) })),
  };
}
