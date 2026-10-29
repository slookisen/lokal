// ─── Debio full-register client (økologi S1) ────────────────────────────────
// A2A dev-request 2026-10-28-rfb-okologisk-merking-debio-register-og-
// tekstrevisjon, slice S1: the status source for `agents.debio_*` moves from
// the 108-company finnoko showcase list to Debio's full register — the data
// behind Debio's own search on finnoko.debio.no:
//
//   POST https://portal.debio.no/ACM/api/certsearch/getcertificates
//   body {"searchText":""}   → every approved business (~3 065 rows, 2026-10)
//
// The endpoint is undocumented and we could not take a sample from the build
// sandbox, so the raw field names are NOT known. Everything that depends on
// the raw shape lives in ONE place — normalizeRegisterRow() below — and every
// caller works on the normalized `DebioRegisterRow` only.
//
// Assumed raw shapes (any of these; keys are looked up case- and
// separator-insensitively, so `clientCode`, `ClientCode` and `client_code`
// are the same key; one level of nesting under address/client/company/
// certificate/enquiry objects is searched too):
//
//   envelope : bare array | { results|data|certificates|items|content|value|list: [...] }
//   name     : name | clientName | companyName | displayName | businessName
//   street   : street | streetAddress | address | addressLine1 | adresse
//   postal   : postalCode | postCode | zip | zipCode | postnr | postNumber
//   city     : city | postalPlace | postPlace | poststed | town | place
//   org.nr.  : clientCode | orgNr | orgnr | organizationNumber | orgNumber
//   sid      : certSid | certificateSid | enquiryOrigSid | enquirySid | sid | id
//   valid    : validFrom/validTo | certValidFrom/certValidTo | fromDate/toDate |
//              dateFrom/dateTo | expiryDate — ISO, dd.mm.yyyy, /Date(ms)/ or epoch ms
//   status   : statusCode(s) | status(es) | certStatus(es) | statusSid(s) —
//              a number, "509", "509,502", or an array of numbers/strings/
//              objects {code|sid|statusCode|id}; status codes on product-group
//              objects count too
//   groups   : mainProductGroups | productGroups | mainProductGroup |
//              productGroupCodes | productGroupSids — a string ("LBP,FIO") or
//              an array of strings/numbers/objects {code|shortName|name|sid}
//
// Status codes (Debio, protocols/debio-okologisk-merking-vurdering-2026-10-28.md
// §4): 509 = økologisk/Ø-merket, 501 = ikke-økologisk linje, 502–504 = karens
// år 1–3, 510 = karens husdyr, 50xx = serveringsmerket. A row with 509 is
// `okologisk`; otherwise any karens code is `karens`; anything else `annet`.
//
// Privacy (S1.6): `name` and `street` may be a person's name / home address
// (enkeltpersonforetak). They exist on the normalized row for matching in
// memory only — the sync never persists or logs them.

import * as crypto from "node:crypto";
import * as https from "node:https";
import * as tls from "node:tls";
import { FINNOKO_USER_AGENT } from "./debio-finnoko-client";

export const DEBIO_REGISTER_URL = "https://portal.debio.no/ACM/api/certsearch/getcertificates";
export const DEBIO_REGISTER_TIMEOUT_MS = 60_000;
export const DEBIO_REGISTER_SOURCE_URL_PREFIX = "https://portal.debio.no/ACM/?certSid=";

export type DebioRegisterStatus = "okologisk" | "karens" | "annet";

export interface DebioRegisterRow {
  /** Certificate / enquiry sid (text), or null when the row carries none. */
  sid: string | null;
  /** In memory only (privacy S1.6). */
  name: string;
  /** In memory only (privacy S1.6). */
  street: string | null;
  postalCode: string | null;
  city: string | null;
  /** 9-digit org.nr. (`clientCode`), or null. */
  orgNr: string | null;
  statusCodes: number[];
  status: DebioRegisterStatus;
  /** YYYY-MM-DD or null. */
  validFrom: string | null;
  validTo: string | null;
  /** Upper-cased product-group codes / names, de-duplicated, in order. */
  productGroups: string[];
}

export interface DebioRegisterFetchResult {
  /** Raw rows in the response envelope. */
  raw: number;
  rows: DebioRegisterRow[];
  /** Raw rows normalizeRegisterRow() could not interpret. */
  rejected: number;
}

const KARENS_CODES = new Set([502, 503, 504, 510]);

/** lower-case, no separators: `clientCode`, `ClientCode`, `client_code` → `clientcode`. */
function keyOf(k: string): string {
  return k.toLowerCase().replace(/[^a-z0-9]/g, "");
}

const NESTED_KEYS = ["address", "client", "company", "certificate", "enquiry", "postaladdress", "visitaddress"];

/** Flat lookup map of one raw row (top level first, then one nesting level). */
function lookupMap(raw: Record<string, unknown>): Map<string, unknown> {
  const m = new Map<string, unknown>();
  for (const [k, v] of Object.entries(raw)) m.set(keyOf(k), v);
  for (const nk of NESTED_KEYS) {
    const v = m.get(nk);
    if (v && typeof v === "object" && !Array.isArray(v)) {
      for (const [k, vv] of Object.entries(v as Record<string, unknown>)) {
        const kk = keyOf(k);
        if (!m.has(kk)) m.set(kk, vv);
      }
    }
  }
  return m;
}

function pick(m: Map<string, unknown>, keys: string[]): unknown {
  for (const k of keys) {
    const v = m.get(k);
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return undefined;
}

function text(v: unknown): string | null {
  if (typeof v === "string") return v.trim() || null;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return null;
}

/** ISO date (YYYY-MM-DD) from ISO, dd.mm.yyyy, /Date(ms)/ or epoch ms; else null. */
export function registerDate(v: unknown): string | null {
  if (typeof v === "number" && Number.isFinite(v) && v > 1e11) return new Date(v).toISOString().slice(0, 10);
  const s = text(v);
  if (!s) return null;
  const ms = /\/Date\((-?\d+)/.exec(s);
  if (ms) return new Date(Number(ms[1])).toISOString().slice(0, 10);
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const no = /^(\d{1,2})\.(\d{1,2})\.(\d{4})/.exec(s);
  if (no) return `${no[3]}-${no[2].padStart(2, "0")}-${no[1].padStart(2, "0")}`;
  return null;
}

/** 9-digit org.nr. from «987 898 321», «NO987898321MVA» …; else null. */
export function normalizeOrgNr(v: unknown): string | null {
  const s = text(v);
  if (!s) return null;
  const digits = s.replace(/\D/g, "");
  return digits.length === 9 ? digits : null;
}

function codesFrom(v: unknown, out: number[]): void {
  if (v === undefined || v === null) return;
  if (Array.isArray(v)) { for (const x of v) codesFrom(x, out); return; }
  if (typeof v === "object") {
    const m = lookupMap(v as Record<string, unknown>);
    codesFrom(pick(m, ["code", "statuscode", "statussid", "sid", "id", "status"]), out);
    return;
  }
  for (const part of String(v).split(/[^0-9]+/)) {
    const n = Number(part);
    if (part && Number.isInteger(n) && n >= 500 && n <= 5099) out.push(n);
  }
}

function groupsFrom(v: unknown, out: string[]): void {
  if (v === undefined || v === null) return;
  if (Array.isArray(v)) { for (const x of v) groupsFrom(x, out); return; }
  if (typeof v === "object") {
    const m = lookupMap(v as Record<string, unknown>);
    groupsFrom(pick(m, ["code", "shortname", "productgroupcode", "name", "productgroupname", "sid", "id"]), out);
    return;
  }
  for (const part of String(v).split(/[,;|]/)) {
    const g = part.trim().toUpperCase();
    if (g && !out.includes(g)) out.push(g);
  }
}

/** A 4-digit Norwegian postal code, or null. */
export function postalCodeOf(v: unknown): string | null {
  const digits = (text(v) ?? "").replace(/\D/g, "");
  return digits.length >= 3 && digits.length <= 4 ? digits.padStart(4, "0") : null;
}

/** Status from Debio's codes: 509 → okologisk, a karens code → karens, else annet. */
export function statusFromCodes(codes: readonly number[]): DebioRegisterStatus {
  if (codes.includes(509)) return "okologisk";
  if (codes.some((c) => KARENS_CODES.has(c))) return "karens";
  return "annet";
}

/**
 * ONE raw register row → the normalized row, or null when it cannot be
 * interpreted (no name, or neither an org.nr. nor a sid to identify it).
 */
export function normalizeRegisterRow(raw: unknown): DebioRegisterRow | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const m = lookupMap(raw as Record<string, unknown>);
  const name = text(pick(m, ["name", "clientname", "companyname", "displayname", "businessname", "virksomhet"]));
  if (!name) return null;
  const orgNr = normalizeOrgNr(pick(m, ["clientcode", "orgnr", "organizationnumber", "orgnumber", "organisationnumber", "orgno"]));
  const sid = text(pick(m, ["certsid", "certificatesid", "enquiryorigsid", "enquirysid", "sid", "id"]));
  if (!orgNr && !sid) return null;
  let street = pick(m, ["street", "streetaddress", "addressline1", "adresse", "address"]);
  if (street && typeof street === "object") street = undefined; // a nested address object, not a street
  const postal = text(pick(m, ["postalcode", "postcode", "zip", "zipcode", "postnr", "postnumber", "postnummer"]));
  const statusCodes: number[] = [];
  codesFrom(pick(m, ["statuscodes", "statuscode", "statuses", "status", "certstatuses", "certstatus", "statussids", "statussid"]), statusCodes);
  const productGroupsRaw = pick(m, ["mainproductgroups", "productgroups", "mainproductgroup", "productgroupcodes", "productgroupsids", "productgroup"]);
  // Status codes may also sit on the product-group objects.
  if (Array.isArray(productGroupsRaw)) {
    for (const g of productGroupsRaw) {
      if (g && typeof g === "object") {
        const gm = lookupMap(g as Record<string, unknown>);
        codesFrom(pick(gm, ["statuscode", "statuscodes", "status", "statussid"]), statusCodes);
      }
    }
  }
  const productGroups: string[] = [];
  groupsFrom(productGroupsRaw, productGroups);
  const codes = [...new Set(statusCodes)];
  return {
    sid,
    name,
    street: text(street),
    postalCode: postalCodeOf(postal),
    city: text(pick(m, ["city", "postalplace", "postplace", "poststed", "town", "place", "municipality", "kommune"])),
    orgNr,
    statusCodes: codes,
    status: statusFromCodes(codes),
    validFrom: registerDate(pick(m, ["validfrom", "certvalidfrom", "fromdate", "datefrom", "validfromdate", "startdate"])),
    validTo: registerDate(pick(m, ["validto", "certvalidto", "todate", "dateto", "validtodate", "expirydate", "enddate", "validuntil"])),
    productGroups,
  };
}

/** The row array inside a register response envelope. */
export function parseRegisterResponse(data: unknown): unknown[] {
  if (Array.isArray(data)) return data;
  if (data && typeof data === "object") {
    const m = lookupMap(data as Record<string, unknown>);
    for (const k of ["results", "data", "certificates", "items", "content", "value", "list", "rows"]) {
      const v = m.get(k);
      if (Array.isArray(v)) return v;
    }
  }
  return [];
}

/** Normalizes a whole response: rows + how many raw rows were rejected. */
export function normalizeRegisterResponse(data: unknown): DebioRegisterFetchResult {
  const raw = parseRegisterResponse(data);
  const rows: DebioRegisterRow[] = [];
  let rejected = 0;
  for (const r of raw) {
    const n = normalizeRegisterRow(r);
    if (n) rows.push(n); else rejected++;
  }
  return { raw: raw.length, rows, rejected };
}

// ─── fetch diagnostics + optional extra CA (økologi S1b) ────────────────────
// In prod the register fetch failed with only «fetch failed»: undici hides the
// real cause (TLS chain, ECONNREFUSED, connect timeout …) in `error.cause`.
// describeFetchError() walks the cause chain so reject_reason says why.
//
// DEBIO_REGISTER_EXTRA_CA_PEM (one or more PEM certificates, real newlines or
// `\n`-escaped on one line): when set, the register request — and only that
// request — goes through node:https with ca = [...tls.rootCertificates,
// ...extra]. TLS verification is never turned off; an unparsable value is an
// error (`extra_ca_invalid`), never silently ignored.

export const DEBIO_REGISTER_EXTRA_CA_ENV = "DEBIO_REGISTER_EXTRA_CA_PEM";
const DESCRIBE_MAX_CHARS = 500;
const DESCRIBE_MAX_DEPTH = 4;
const HTTP_BODY_SNIPPET_CHARS = 200;
const HTTPS_MAX_BODY_BYTES = 64 * 1024 * 1024;

function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function errAttrs(e: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const k of ["code", "errno", "syscall"]) {
    const v = e[k];
    if (typeof v === "string" || typeof v === "number") parts.push(`${k}=${v}`);
  }
  const host = e.hostname ?? e.host ?? e.address;
  if (typeof host === "string" && host) parts.push(`host=${host}`);
  if (typeof e.port === "string" || typeof e.port === "number") parts.push(`port=${e.port}`);
  return parts.join(" ");
}

/**
 * One bounded line from an error and its cause chain (max depth 4):
 * `TypeError fetch failed ← cause code=UNABLE_TO_VERIFY_LEAF_SIGNATURE: unable
 * to verify the first certificate`. Only name / message / code / errno /
 * syscall / host / port are read — never headers or env values.
 */
export function describeFetchError(err: unknown): string {
  if (!(err && typeof err === "object")) return oneLine(String(err)).slice(0, DESCRIBE_MAX_CHARS);
  const top = err as Record<string, unknown>;
  const name = typeof top.name === "string" && top.name ? top.name : "Error";
  const topAttrs = errAttrs(top);
  let out = oneLine(`${name} ${typeof top.message === "string" ? top.message : ""}${topAttrs ? ` [${topAttrs}]` : ""}`);
  const seen = new Set<unknown>([err]);
  let cur: unknown = top.cause ?? (Array.isArray(top.errors) ? top.errors[0] : undefined);
  for (let depth = 0; depth < DESCRIBE_MAX_DEPTH && cur !== undefined && cur !== null && !seen.has(cur); depth++) {
    seen.add(cur);
    if (typeof cur !== "object") { out += ` ← cause: ${oneLine(String(cur))}`; break; }
    const c = cur as Record<string, unknown>;
    const cname = typeof c.name === "string" && c.name && c.name !== "Error" ? ` ${c.name}` : "";
    const attrs = errAttrs(c);
    const msg = typeof c.message === "string" ? oneLine(c.message) : "";
    out += ` ← cause${cname}${attrs ? ` ${attrs}` : ""}${msg ? `: ${msg}` : ""}`;
    cur = c.cause ?? (Array.isArray(c.errors) ? c.errors[0] : undefined);
  }
  return out.length > DESCRIBE_MAX_CHARS ? out.slice(0, DESCRIBE_MAX_CHARS - 1) + "…" : out;
}

export type ExtraCaParse =
  | { state: "unset" }
  | { state: "ok"; certs: string[] }
  | { state: "invalid"; error: string };

/** Parses DEBIO_REGISTER_EXTRA_CA_PEM. Every PEM block must be a parsable X.509 certificate. */
export function parseExtraCaPem(raw: string | undefined): ExtraCaParse {
  if (raw === undefined || raw.trim() === "") return { state: "unset" };
  const text = raw.replace(/\\r/g, "").replace(/\\n/g, "\n").replace(/\r/g, "");
  const blocks = text.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) ?? [];
  if (blocks.length === 0) return { state: "invalid", error: "extra_ca_invalid: no PEM certificate block found" };
  // Anything left besides the blocks (and whitespace) is a malformed value.
  if (text.replace(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g, "").trim() !== "") {
    return { state: "invalid", error: "extra_ca_invalid: unexpected text outside the PEM certificate blocks" };
  }
  const certs: string[] = [];
  for (let i = 0; i < blocks.length; i++) {
    const pem = blocks[i] + "\n";
    try {
      new crypto.X509Certificate(pem);
    } catch (e) {
      return { state: "invalid", error: `extra_ca_invalid: certificate ${i + 1} of ${blocks.length} unparsable (${oneLine(e instanceof Error ? e.message : String(e)).slice(0, 120)})` };
    }
    certs.push(pem);
  }
  return { state: "ok", certs };
}

export type RegisterTransport =
  | { kind: "fetch"; fetchImpl: typeof fetch }
  | { kind: "https_extra_ca"; ca: string[] }
  | { kind: "invalid"; error: string };

/**
 * Which client makes the register request: an injected fetchImpl (tests) wins,
 * then node:https with the extra CA when DEBIO_REGISTER_EXTRA_CA_PEM is set,
 * else the global fetch. An invalid PEM is reported whichever path is chosen.
 */
export function selectRegisterTransport(opts: { fetchImpl?: typeof fetch; env?: NodeJS.ProcessEnv } = {}): RegisterTransport {
  const env = opts.env ?? process.env;
  const extra = parseExtraCaPem(env[DEBIO_REGISTER_EXTRA_CA_ENV]);
  if (extra.state === "invalid") return { kind: "invalid", error: extra.error };
  if (opts.fetchImpl) return { kind: "fetch", fetchImpl: opts.fetchImpl };
  if (extra.state === "ok") return { kind: "https_extra_ca", ca: [...tls.rootCertificates, ...extra.certs] };
  return { kind: "fetch", fetchImpl: fetch };
}

/** True when the register request would use the extra-CA https client (boolean only). */
export function registerExtraCaInUse(opts: { fetchImpl?: typeof fetch; env?: NodeJS.ProcessEnv } = {}): boolean {
  return selectRegisterTransport(opts).kind === "https_extra_ca";
}

/**
 * POST with node:https trusting exactly `ca` (TLS verification on). Resolves
 * with status + body text; the timeout covers connect, TLS and the body.
 */
export function httpsPostText(
  url: string,
  body: string,
  headers: Record<string, string>,
  ca: string[],
  timeoutMs: number,
): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (fn: () => void) => { if (!done) { done = true; clearTimeout(timer); fn(); } };
    const req = https.request(url, {
      method: "POST",
      headers: { ...headers, "Content-Length": String(Buffer.byteLength(body)) },
      ca,
      agent: false,
    }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (c: Buffer) => {
        size += c.length;
        if (size > HTTPS_MAX_BODY_BYTES) {
          finish(() => reject(new Error(`response body exceeds ${HTTPS_MAX_BODY_BYTES} bytes`)));
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      res.on("end", () => finish(() => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") })));
      res.on("error", (e) => finish(() => reject(e)));
    });
    const timer = setTimeout(() => {
      finish(() => reject(new Error(`timeout after ${timeoutMs} ms`)));
      req.destroy();
    }, timeoutMs);
    req.on("error", (e) => finish(() => reject(e)));
    req.end(body);
  });
}

function httpError(status: number, bodyText: string): Error {
  const snippet = oneLine(bodyText).slice(0, HTTP_BODY_SNIPPET_CHARS);
  return new Error(`debio register HTTP ${status}${snippet ? `: ${snippet}` : ""}`);
}

function parseJson(t: string): unknown {
  try {
    return JSON.parse(t);
  } catch (e) {
    throw new Error(`debio register JSON parse failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * One POST to the register (60 s timeout, finnoko User-Agent). Throws on
 * HTTP/JSON/network errors; a network error's message is the full cause chain
 * (describeFetchError), our own timeout reads «timeout after 60000 ms».
 */
export async function fetchDebioRegister(opts: { fetchImpl?: typeof fetch; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}): Promise<DebioRegisterFetchResult> {
  const transport = selectRegisterTransport(opts);
  if (transport.kind === "invalid") throw new Error(transport.error);
  const timeoutMs = opts.timeoutMs ?? DEBIO_REGISTER_TIMEOUT_MS;
  const headers = { "User-Agent": FINNOKO_USER_AGENT, "Accept": "application/json", "Content-Type": "application/json" };
  const body = JSON.stringify({ searchText: "" });

  if (transport.kind === "https_extra_ca") {
    let res: { status: number; text: string };
    try {
      res = await httpsPostText(DEBIO_REGISTER_URL, body, headers, transport.ca, timeoutMs);
    } catch (e) {
      throw new Error(`${describeFetchError(e)} (extra CA)`);
    }
    if (res.status < 200 || res.status > 299) throw httpError(res.status, res.text);
    return normalizeRegisterResponse(parseJson(res.text));
  }

  const ctl = new AbortController();
  let timedOut = false;
  const t = setTimeout(() => { timedOut = true; ctl.abort(); }, timeoutMs);
  // The timeout covers the body read too (a body that hangs is aborted).
  let data: unknown;
  try {
    let res: Response;
    try {
      res = await transport.fetchImpl(DEBIO_REGISTER_URL, { method: "POST", headers, body, signal: ctl.signal });
    } catch (e) {
      throw new Error(timedOut ? `timeout after ${timeoutMs} ms` : describeFetchError(e));
    }
    if (!res.ok) {
      let bodyText = "";
      try { bodyText = typeof res.text === "function" ? await res.text() : ""; } catch { /* body unreadable */ }
      throw httpError(res.status, bodyText);
    }
    try {
      data = await res.json();
    } catch (e) {
      if (timedOut) throw new Error(`timeout after ${timeoutMs} ms (reading body)`);
      throw new Error(`debio register JSON parse failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  } finally {
    clearTimeout(t);
  }
  return normalizeRegisterResponse(data);
}
