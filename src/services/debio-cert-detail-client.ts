// ─── Debio certificate-detail client (økologi S4a) ──────────────────────────
// A2A dev-request 2026-10-28-rfb-okologisk-merking-debio-register-og-
// tekstrevisjon, slice S4 («avgrensning for godkjente med blandet drift»),
// step 1 (S4a): read Debio's certificate detail —
//
//   POST https://portal.debio.no/ACM/api/certsearch/getcertificatedetail
//   body {"enquiryOrigSid": <number>}
//
// — which lists per-product / per-area lines with a status: 509 = økologisk,
// 501 = ikke-økologisk, 502–504 = karens år 1–3, 510 = karens husdyr; possibly
// with a TRACES certificate link.
//
// The REAL response shape has never been captured (the sandbox cannot reach
// portal.debio.no). S4a therefore only adds:
//   - fetchDebioCertificateDetail(): one POST with the same transport as the
//     register client (selectRegisterTransport: injected fetch for tests, the
//     DEBIO_REGISTER_EXTRA_CA_PEM https client when set, else global fetch;
//     TLS verification always on; finnoko User-Agent). Never throws: returns
//     { ok: true, raw } or { ok: false, reason }.
//   - normalizeCertDetail(): a defensive normalizer over guessed shapes.
//   - describeShape(): key paths + JS types, NO values — what the read-only
//     admin probe (POST /admin/debio/cert-detail-probe) returns so the real
//     shape can be captured from prod without leaking personal data.
// No DB writes, no scheduler, no table, no flag.
//
// S4b-1: the real shape was captured via the probe; normalizeCertDetail()
// now reads its top-level certificateDetailPos[] (see below). Later S4b
// slices store the lines weekly, behind a flag; S4c: show the product «Øko»
// mark only on products tied to 509 lines.
//
// Privacy (S1.6): Debio person names / streets are never persisted, logged or
// returned. normalizeCertDetail() reads only product/area label keys, status
// keys and a top-level link; describeShape() emits no values, and a key that
// does not look like an identifier is masked as «<key>».

import { FINNOKO_USER_AGENT } from "./debio-finnoko-client";
import { describeFetchError, httpsPostText, selectRegisterTransport } from "./debio-register-client";

export const DEBIO_CERT_DETAIL_URL = "https://portal.debio.no/ACM/api/certsearch/getcertificatedetail";
export const DEBIO_CERT_DETAIL_TIMEOUT_MS = 30_000;
export const DEBIO_CERT_DETAIL_ORGANIC_CODE = 509;

export type CertDetailFetchResult = { ok: true; raw: unknown } | { ok: false; reason: string };

export interface CertDetailLine {
  /** Product / area text, or null when the line carries none. */
  label: string | null;
  /** Debio status code (509, 501, 502–504, 510 …), or null. */
  statusCode: number | null;
  statusText: string | null;
  /** statusCode === 509. */
  organic: boolean;
}

export interface CertDetailNormalized {
  lines: CertDetailLine[];
  /** True when a lines array was found and at least one line has a status code. */
  recognized: boolean;
  /** A TRACES / http(s) certificate link at the top level, or null. */
  certificateUrl: string | null;
}

const REASON_MAX_CHARS = 300;

/**
 * One POST to the certificate-detail endpoint (30 s timeout, finnoko
 * User-Agent, register transport). Never throws. `reason` holds no response
 * body (it could carry personal data) — only the HTTP status or the error
 * cause chain.
 */
export async function fetchDebioCertificateDetail(
  enquiryOrigSid: number,
  opts: { fetchImpl?: typeof fetch; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<CertDetailFetchResult> {
  const fail = (reason: string): CertDetailFetchResult => ({ ok: false, reason: reason.slice(0, REASON_MAX_CHARS) });
  if (!Number.isSafeInteger(enquiryOrigSid) || enquiryOrigSid <= 0) return fail("invalid enquiryOrigSid");
  let transport: ReturnType<typeof selectRegisterTransport>;
  try {
    transport = selectRegisterTransport(opts);
  } catch (e) {
    return fail(describeFetchError(e));
  }
  if (transport.kind === "invalid") return fail(transport.error);
  const timeoutMs = opts.timeoutMs ?? DEBIO_CERT_DETAIL_TIMEOUT_MS;
  const headers = { "User-Agent": FINNOKO_USER_AGENT, "Accept": "application/json", "Content-Type": "application/json" };
  const body = JSON.stringify({ enquiryOrigSid });

  if (transport.kind === "https_extra_ca") {
    let res: { status: number; text: string };
    try {
      res = await httpsPostText(DEBIO_CERT_DETAIL_URL, body, headers, transport.ca, timeoutMs);
    } catch (e) {
      return fail(`${describeFetchError(e)} (extra CA)`);
    }
    if (res.status < 200 || res.status > 299) return fail(`http_${res.status}`);
    try {
      return { ok: true, raw: JSON.parse(res.text) };
    } catch {
      return fail("invalid_json");
    }
  }

  const ctl = new AbortController();
  let timedOut = false;
  const t = setTimeout(() => { timedOut = true; ctl.abort(); }, timeoutMs);
  try {
    let res: Response;
    try {
      res = await transport.fetchImpl(DEBIO_CERT_DETAIL_URL, { method: "POST", headers, body, signal: ctl.signal });
    } catch (e) {
      return fail(timedOut ? `timeout after ${timeoutMs} ms` : describeFetchError(e));
    }
    if (!res || typeof res.status !== "number") return fail("no response");
    if (!res.ok) {
      try { await res.text(); } catch { /* body unreadable — not reported */ }
      return fail(`http_${res.status}`);
    }
    let txt: string;
    try {
      txt = await res.text();
    } catch (e) {
      return fail(timedOut ? `timeout after ${timeoutMs} ms (reading body)` : describeFetchError(e));
    }
    try {
      return { ok: true, raw: JSON.parse(txt) };
    } catch {
      return fail("invalid_json");
    }
  } catch (e) {
    return fail(describeFetchError(e));
  } finally {
    clearTimeout(t);
  }
}

// ─── normalizer ─────────────────────────────────────────────────────────────

/** lower-case, no separators: `statusSid`, `StatusSid`, `status_sid` → `statussid`. */
function keyOf(k: string): string {
  return k.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function mapOf(o: Record<string, unknown>): Map<string, unknown> {
  const m = new Map<string, unknown>();
  for (const [k, v] of Object.entries(o)) {
    const kk = keyOf(k);
    if (!m.has(kk)) m.set(kk, v);
  }
  return m;
}

function pick(m: Map<string, unknown>, keys: readonly string[]): unknown {
  for (const k of keys) {
    const v = m.get(k);
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return undefined;
}

function str(v: unknown): string | null {
  if (typeof v === "string") return v.trim() || null;
  return null;
}

const LINE_ENVELOPE_KEYS = [
  "lines", "productlines", "certificatelines", "arealines", "products", "items",
  "results", "data", "details", "detaillines", "certificatedetails", "rows",
];
// Product / area text only. Deliberately NOT: clientName, companyName,
// contactName, owner, street, address … (person data, S1.6), and not the
// generic name / title / text, which may hold a person's name while the real
// shape is unknown.
const LABEL_KEYS = [
  "productname", "product", "productgroupname", "productcaption", "areaname", "area",
  "caption", "description", "label",
];
const STATUS_KEYS = ["statussid", "status", "statuscode", "resultsid", "result", "resultcode", "certstatus", "certstatussid"];
const STATUS_TEXT_KEYS = ["statustext", "statusname", "statuscaption", "statusdescription", "resulttext", "resultname", "resultcaption"];
const STATUS_OBJ_CODE_KEYS = ["sid", "code", "id", "statussid", "statuscode"];
const STATUS_OBJ_TEXT_KEYS = ["caption", "name", "text", "description", "label"];

const STATUS_OBJ_MAX_DEPTH = 3;

/** Number, numeric string or {sid|code|id} (at most 3 object levels) → a positive integer; else null. */
function statusCodeOf(v: unknown, depth = 0): number | null {
  if (typeof v === "number") return Number.isInteger(v) && v > 0 ? v : null;
  if (typeof v === "string" && /^\s*\d+\s*$/.test(v)) {
    const n = Number(v.trim());
    return Number.isSafeInteger(n) && n > 0 ? n : null;
  }
  if (isObj(v)) return depth >= STATUS_OBJ_MAX_DEPTH ? null : statusCodeOf(pick(mapOf(v), STATUS_OBJ_CODE_KEYS), depth + 1);
  return null;
}

function statusTextOf(m: Map<string, unknown>, rawStatus: unknown): string | null {
  const explicit = str(pick(m, STATUS_TEXT_KEYS));
  if (explicit) return explicit;
  if (typeof rawStatus === "string" && !/^\s*\d+\s*$/.test(rawStatus)) return str(rawStatus);
  if (isObj(rawStatus)) return str(pick(mapOf(rawStatus), STATUS_OBJ_TEXT_KEYS));
  return null;
}

function labelOf(m: Map<string, unknown>): string | null {
  for (const k of LABEL_KEYS) {
    const v = m.get(k);
    const s = str(v);
    if (s) return s;
    // e.g. product: { name: "Melk", caption: "…" }
    if (isObj(v)) {
      const inner = str(pick(mapOf(v), ["caption", "name", "text", "description", "label"]));
      if (inner) return inner;
    }
  }
  return null;
}

function arraysUnder(o: Record<string, unknown>): unknown[][] {
  const m = mapOf(o);
  const out: unknown[][] = [];
  for (const k of LINE_ENVELOPE_KEYS) {
    const v = m.get(k);
    if (Array.isArray(v)) out.push(v);
  }
  return out;
}

/** The candidate line arrays: bare array, envelope keys, or envelope keys one object level down. */
function findLineArrays(raw: unknown): unknown[][] {
  if (Array.isArray(raw)) return [raw];
  if (!isObj(raw)) return [];
  const top = arraysUnder(raw);
  if (top.length) return top;
  const nested: unknown[][] = [];
  for (const v of Object.values(raw)) {
    if (isObj(v)) nested.push(...arraysUnder(v));
  }
  return nested;
}

function normalizeLine(raw: unknown): CertDetailLine | null {
  if (!isObj(raw)) return null;
  const m = mapOf(raw);
  const rawStatus = pick(m, STATUS_KEYS);
  const statusCode = statusCodeOf(rawStatus);
  const label = labelOf(m);
  const statusText = statusTextOf(m, rawStatus);
  if (statusCode === null && label === null && statusText === null) return null;
  return { label, statusCode, statusText, organic: statusCode === DEBIO_CERT_DETAIL_ORGANIC_CODE };
}

const URL_KEY_HINTS = ["traces", "url", "link", "href", "certificate", "pdf", "document"];

/**
 * A top-level http(s) link whose value mentions traces or whose key carries a
 * hint (traces/url/link/href/certificate/pdf/document); any other link (a
 * homepage …) is ignored. Traces values first, then by hint order.
 */
function certificateUrlOf(raw: unknown): string | null {
  if (!isObj(raw)) return null;
  const candidates: Array<{ rank: number; url: string }> = [];
  for (const [k, v] of Object.entries(raw)) {
    const s = str(v);
    if (!s || !/^https?:\/\/[^\s]+$/i.test(s)) continue;
    const kk = keyOf(k);
    const hint = URL_KEY_HINTS.findIndex((h) => kk.includes(h));
    const traces = /traces/i.test(s);
    if (!traces && hint < 0) continue;
    candidates.push({ rank: traces ? -1 : hint, url: s });
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => a.rank - b.rank);
  return candidates[0].url;
}

// ─── real Debio format (S4b-1) ──────────────────────────────────────────────
// Captured from prod via the probe (key paths + types only):
//   { sid, enquiryOrigSid, from, to, additionalDWReports: [],
//     certificateDetailPos: [{ name, category, unit, amount, partnerFullName,
//                              result: { sid, name, caption, subResult } }] }
// Only lines inside certificateDetailPos are read this way: label = name
// (+ " (category)"), statusCode = result.sid when it is an integer in Debio's
// code range 500–5099 (as debio-register-client), statusText = result.name ||
// result.caption. partnerFullName (person data, S1.6) is never read.

const DEBIO_POS_KEY = "certificatedetailpos";
const DEBIO_CODE_MIN = 500;
const DEBIO_CODE_MAX = 5099;

function debioCodeOf(v: unknown): number | null {
  return typeof v === "number" && Number.isInteger(v) && v >= DEBIO_CODE_MIN && v <= DEBIO_CODE_MAX ? v : null;
}

function normalizeDebioPosLine(raw: unknown): CertDetailLine | null {
  if (!isObj(raw)) return null;
  const m = mapOf(raw);
  const name = str(m.get("name"));
  const category = str(m.get("category"));
  const label = name && category ? `${name} (${category})` : name ?? category;
  const result = m.get("result");
  let statusCode: number | null = null;
  let statusText: string | null = null;
  if (isObj(result)) {
    const rm = mapOf(result);
    statusCode = debioCodeOf(rm.get("sid"));
    statusText = str(rm.get("name")) ?? str(rm.get("caption"));
  }
  if (statusCode === null && label === null && statusText === null) return null;
  return { label, statusCode, statusText, organic: statusCode === DEBIO_CERT_DETAIL_ORGANIC_CODE };
}

/** The top-level certificateDetailPos array (any key casing), or null when absent. */
function debioPosArray(raw: unknown): unknown[] | null {
  if (!isObj(raw)) return null;
  const v = mapOf(raw).get(DEBIO_POS_KEY);
  return Array.isArray(v) ? v : null;
}

/**
 * Normalizer over certificate-detail responses: the real Debio format
 * (top-level certificateDetailPos, S4b-1) and, when that container is absent,
 * the guessed S4a shapes exactly as before.
 */
export function normalizeCertDetail(raw: unknown): CertDetailNormalized {
  const certificateUrl = certificateUrlOf(raw);
  const lines: CertDetailLine[] = [];
  const pos = debioPosArray(raw);
  const arrays = pos ? [] : findLineArrays(raw);
  if (pos) {
    for (const r of pos) {
      const l = normalizeDebioPosLine(r);
      if (l) lines.push(l);
    }
  }
  for (const arr of arrays) {
    for (const r of arr) {
      const l = normalizeLine(r);
      if (l) lines.push(l);
    }
  }
  if (!lines.some((l) => l.statusCode !== null)) return { lines: [], recognized: false, certificateUrl };
  return { lines, recognized: true, certificateUrl };
}

// ─── shape description (no values) ──────────────────────────────────────────

const SHAPE_MAX_PATHS = 400;
const SHAPE_MAX_ARRAY_ITEMS = 25;

function typeName(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

/** A key that looks like an identifier is kept; anything else (could be data) → «<key>». */
function safeKey(k: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$-]{0,63}$/.test(k) ? k : "<key>";
}

/**
 * Key paths with JS types — `"[].statusSid: number"` — arrays collapsed to
 * `[]` (element shapes merged), objects past maxDepth reported as `object`.
 * NEVER any value. Sorted, de-duplicated, bounded.
 */
export function describeShape(raw: unknown, maxDepth = 4): string[] {
  const out = new Map<string, Set<string>>();
  const add = (path: string, t: string) => {
    if (!out.has(path) && out.size >= SHAPE_MAX_PATHS) return;
    const s = out.get(path) ?? new Set<string>();
    s.add(t);
    out.set(path, s);
  };
  const walk = (v: unknown, path: string, depth: number) => {
    const t = typeName(v);
    if (path) add(path, t);
    if (depth >= maxDepth) return;
    if (Array.isArray(v)) {
      const p = path ? `${path}[]` : "[]";
      if (v.length === 0) return;
      for (const item of v.slice(0, SHAPE_MAX_ARRAY_ITEMS)) {
        if (item !== null && typeof item === "object") walk(item, p, depth + 1);
        else add(p, typeName(item));
      }
      return;
    }
    if (isObj(v)) {
      for (const [k, vv] of Object.entries(v)) {
        const p = path ? `${path}.${safeKey(k)}` : safeKey(k);
        walk(vv, p, depth + 1);
      }
    }
  };
  if (!isObj(raw) && !Array.isArray(raw)) return [`(root): ${typeName(raw)}`];
  if (Array.isArray(raw)) add("(root)", "array");
  walk(raw, "", 0);
  return [...out.entries()].map(([p, ts]) => `${p}: ${[...ts].sort().join("|")}`).sort();
}
