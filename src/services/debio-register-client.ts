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

/** One POST to the register (60 s timeout, finnoko User-Agent). Throws on HTTP/JSON errors. */
export async function fetchDebioRegister(opts: { fetchImpl?: typeof fetch } = {}): Promise<DebioRegisterFetchResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), DEBIO_REGISTER_TIMEOUT_MS);
  // The timeout covers the body read too (a body that hangs is aborted).
  let data: unknown;
  try {
    const res = await fetchImpl(DEBIO_REGISTER_URL, {
      method: "POST",
      headers: { "User-Agent": FINNOKO_USER_AGENT, "Accept": "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ searchText: "" }),
      signal: ctl.signal,
    });
    if (!res.ok) throw new Error(`debio register HTTP ${res.status}`);
    try {
      data = await res.json();
    } catch (e) {
      throw new Error(`debio register JSON parse failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  } finally {
    clearTimeout(t);
  }
  return normalizeRegisterResponse(data);
}
