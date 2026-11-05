// ─── The owner portal's «Endringslogg» in plain Norwegian ────────────────────
// dev-request 2026-11-02-rfb-endringslogg-lettlest (E1–E3, all owners, no
// flag). GET /api/agents/:id/my-audit (owner-portal.ts) reads
// agent_knowledge_audit through readOwnerAuditFeed() below, and the portal
// script only renders what comes back. So the filtering happens here, in the
// API, not in the view:
//
//   E1  one table (OWNER_AUDIT_FIELDS) field → Norwegian name + value kind.
//       A field that is not in the table is never shown (fail closed), so a
//       new technical column can never leak into the log. Purely technical
//       rows (data_source, origin, agent_claims, catalog_hidden,
//       field_provenance, curated_fields, claimed_via, business_type,
//       verification_status, merge, magic_links, …) are left out on purpose.
//       Values read normally: Norwegian date and time (Europe/Oslo), «Ja» /
//       «Nei», «(tom)», short lists or «N varer», long text cut with «…».
//   E2  who: «Du» / «Rett fra Bonden» / «Automatisk fra nettsiden din»
//       (ownerAuditWho).
//   E3  each row carries only what the log shows: no notes, no
//       changed_by_email, no hidden rows, no no-op rows. An e-mail field
//       shows no values; inside any other value, an address in one of the
//       forms listed at stripEmailAddresses is replaced by «…».
//
// Rollback: revert. The change only reads; nothing stored changes.

import { openingHoursText } from "../utils/opening-hours";
import { stripInternalNotes } from "../services/description-quality";

/**
 * The portal form's own labels (already approved owner text), by database
 * field. The «Profil» form in owner-portal.ts reads its labels from here, so
 * the log and the form can never drift apart.
 */
export const OWNER_PORTAL_FORM_LABELS = {
  email: "E-post",
  phone: "Telefon",
  address: "Adresse",
  postal_code: "Postnummer",
  website: "Nettside",
  opening_hours: "Åpningstider",
  about: "Om produsenten",
} as const;

/** How a field's values are shown. */
export type OwnerAuditValueKind =
  | "text"        // whitespace collapsed, e-mail addresses removed, cut at OWNER_AUDIT_TEXT_MAX with «…»
  | "prose"       // text, minus internal pipeline notes (description-quality stripInternalNotes)
  | "email"       // an e-mail address: the row is shown without its values
  | "bool"        // 1/0, true/false → «Ja» / «Nei»
  | "visible"     // visibility.profile (the pause card): on → «Ja», off… → «Nei»
  | "time"        // a timestamp → Norwegian date and time (Europe/Oslo)
  | "hours"       // opening hours: the owner's text, or structured hours as one line
  | "categories"  // a JSON list of category keys → the public category names
  | "products"    // a JSON product list → up to three names, else «N varer»
  | "list";       // a JSON list of words → a short list

export interface OwnerAuditField {
  /** The Norwegian name the owner reads. */
  label: string;
  kind: OwnerAuditValueKind;
}

const L = OWNER_PORTAL_FORM_LABELS;

/**
 * THE table: every agent_knowledge_audit field_name the owner's log may show.
 * Keys are the field_name values the writers really store (grep
 * "INSERT INTO agent_knowledge_audit"): the portal form (owner), order
 * activation (owner), the pause and order e-mail flows (owner), customer
 * service / admin (content correction, claim-test fixture, owner relay,
 * website review), the nightly owner refresh (about, description,
 * categories) and the system sweeps.
 *
 * Names not taken from the form are existing owner text where one exists
 * («Profilen er synlig», «Ta imot bestillinger», «Bestillinger sendes til»:
 * the «Mine valg» labels for the same setting); the rest are new short names
 * (listed in the PR for Daniel's approval).
 */
export const OWNER_AUDIT_FIELDS: Readonly<Record<string, OwnerAuditField>> = {
  // The portal form (owner saves; also system / customer-service writes).
  email: { label: L.email, kind: "email" },
  phone: { label: L.phone, kind: "text" },
  address: { label: L.address, kind: "text" },
  postal_code: { label: L.postal_code, kind: "text" },
  website: { label: L.website, kind: "text" },
  opening_hours: { label: L.opening_hours, kind: "hours" },
  about: { label: L.about, kind: "prose" },
  // The same facts under the names other writers use.
  "agent_knowledge.email": { label: L.email, kind: "email" },
  contact_email: { label: L.email, kind: "email" },
  url: { label: L.website, kind: "text" },
  // Existing «Mine valg» labels for the same setting.
  "visibility.profile": { label: "Profilen er synlig", kind: "visible" },
  order_notifications_opt_in: { label: "Ta imot bestillinger", kind: "bool" },
  order_notification_email: { label: "Bestillinger sendes til", kind: "email" },
  // New short names.
  description: { label: "Kort beskrivelse", kind: "prose" },
  categories: { label: "Kategorier", kind: "categories" },
  products: { label: "Varer", kind: "products" },
  specialties: { label: "Spesialiteter", kind: "list" },
  certifications: { label: "Sertifiseringer", kind: "list" },
  is_verified: { label: "Bekreftet eier", kind: "bool" },
  claimed_at: { label: "Eierskap bekreftet", kind: "time" },
  is_active: { label: "Aktiv profil", kind: "bool" },
  "products.added": { label: "Ny vare", kind: "text" },
  "products.imported": { label: "Varer hentet fra nettsiden", kind: "text" },
  "products.removed": { label: "Varer fjernet", kind: "text" },
};

/** The field names the log shows (the SQL filter of readOwnerAuditFeed). */
export const OWNER_AUDIT_FIELD_NAMES: readonly string[] = Object.keys(OWNER_AUDIT_FIELDS);

export const OWNER_AUDIT_WHO_OWNER = "Du";
export const OWNER_AUDIT_WHO_RFB = "Rett fra Bonden";
export const OWNER_AUDIT_WHO_WEBSITE = "Automatisk fra nettsiden din";
export const OWNER_AUDIT_EMPTY = "(tom)";
export const OWNER_AUDIT_YES = "Ja";
export const OWNER_AUDIT_NO = "Nei";
/** Longest value text shown (the old log cut at 80 too). */
export const OWNER_AUDIT_TEXT_MAX = 80;
/** A product list longer than this shows as «N varer». */
export const OWNER_AUDIT_PRODUCT_NAMES_MAX = 3;

/**
 * The notes formats of the writers that take a value from the producer's own
 * website, each anchored to that writer's own prefix, so a free-text reason
 * of any other writer that happens to say «kilde: https://…» or
 * «kilde=website_…» never counts:
 *  - the nightly owner refresh («Hold profilen oppdatert», rfb-owner-refresh.ts):
 *    «auto.updates=<mode>; kilde=<source_type> <url>; <run>»;
 *  - thin-profile texts from the profile's website (admin-agents.ts):
 *    «tynne_profiler_slice2: godkjent av dommer ("…") — kilde: <url>» (the URL ends the note);
 *  - the contact extraction from the producer's own website
 *    (admin-rfb-contact-extraction.ts): «rfb-contact-extraction <url> batch:<id>».
 * Brreg, Bondens marked, merges and clean-up sweeps are not website sources.
 */
const WEBSITE_SOURCE_NOTE_RES: readonly RegExp[] = [
  /^auto\.updates=[a-z_]+; kilde=/,
  /^tynne_profiler_slice2: godkjent av dommer \(.*\) — kilde: https?:\/\/\S+$/s,
  /^rfb-contact-extraction https?:\/\/\S+ batch:/,
];

export function isWebsiteSourcedSystemNote(notes: unknown): boolean {
  return typeof notes === "string" && WEBSITE_SOURCE_NOTE_RES.some((re) => re.test(notes));
}

/**
 * Who made the change, as the owner reads it (E2). changed_by is 'owner',
 * 'admin' or 'system' (CHECK constraint):
 *  - 'owner' (portal saves, order activation, pause, order e-mail, products) → «Du»;
 *  - 'admin' (customer service, admin, support, the claim-test fixture, owner relay) → «Rett fra Bonden»;
 *  - 'system' with a website source in the notes (the nightly owner refresh) → «Automatisk fra nettsiden din»;
 *  - any other system write, or anything unexpected → «Rett fra Bonden».
 */
export function ownerAuditWho(changedBy: unknown, notes: unknown): string {
  if (changedBy === "owner") return OWNER_AUDIT_WHO_OWNER;
  if (changedBy === "system" && isWebsiteSourcedSystemNote(notes)) return OWNER_AUDIT_WHO_WEBSITE;
  return OWNER_AUDIT_WHO_RFB;
}

// ── E-mail addresses out of every shown value ──────────────────────────
// What is caught (each form has a test in owner-audit-log.test.ts):
//  - local@domain, also with æøå, also without a top-level domain (a
//    writer's own cut), and an IP-literal domain (ola@[127.0.0.1]);
//  - a quoted local part ("ola nordmann"@gard.no);
//  - «at» or «@» in brackets — [at] (at) {at} <at> «at» «[at]» [@] (@) —
//    and a spaced «@» (ola @ gard.no, ola@ gard.no — not «oss @handle»),
//    both only when a host follows: dotted, with a top-level label that
//    starts with a letter, so «50 kr @ 2.50» and «kl @ 10.00» stay text
//    ((dot) / [punktum] count as a dot after a bracketed «at»);
//  - a trailing «local@» (a cut address) at the end or before punctuation;
//  - after normalising: fullwidth ＠ and small ﹫ and a decomposed «å» (NFKC),
//    invisible format characters (\p{Cf}: zero-width space, soft hyphen, …)
//    dropped, and &#64; / &#x40; / &commat; / %40 / %2540 decoded — the
//    encoded forms only when a dotted domain follows, so «40%40» stays text.
// Not caught: an address spelled out without brackets («ola at gard dot no»),
// split by ordinary spaces inside a word, or a cut «ola@» followed by more
// words («ola@ og mer» — «50kr@ 2stk» could not be told apart). Handles and
// prices survive: «Følg oss @gardsbutikk», «@ kveld», «50 kr @ 2 stk».
//
// Cost: a local part may only start where a run of local-part characters
// starts (E_START), so a long run without an address is scanned once
// (linear), and shortText strips at most OWNER_AUDIT_STRIP_MAX code points
// anyway (1000; the log shows 80) — owner-audit-log.test.ts times both.
const E_LOCAL = "[\\p{L}\\p{N}._%+'\\-]";
// A local part starts only where a run of local-part characters starts: one
// attempt per run instead of one per character, so a long run without an
// address costs linear time, not quadratic (ReDoS, review round 2).
const E_START = "(?<![\\p{L}\\p{N}._%+'\\-])";
const E_DOM = "[\\p{L}\\p{N}\\-]";
const E_DOMAIN = `${E_DOM}+(?:\\.${E_DOM}+)*`;
const E_DOTTED = `${E_DOM}+(?:\\.${E_DOM}+)+`;
// A domain with a top-level label that starts with a letter («gard.no»), not
// a number («2.50», «10.00», «1.2.3 @ 4.5»).
const E_HOST = `${E_DOM}+(?:\\.${E_DOM}+)*\\.\\p{L}${E_DOM}*`;
const E_IP = "\\[[0-9a-f.:]+\\]";
const E_OPEN = "[\\[({<«]{1,2}";
const E_CLOSE = "[\\])}>»]{1,2}";
const E_AT_WORD = `\\s*${E_OPEN}\\s*(?:at|alfa|krøllalfa|@)\\s*${E_CLOSE}\\s*`;
const E_DOT = `(?:\\.|\\s*${E_OPEN}\\s*(?:dot|punktum|prikk)\\s*${E_CLOSE}\\s*)`;
const EMAIL_RE = new RegExp([
  `"[^"\\n]{1,64}"\\s*@\\s*(?:${E_HOST}|${E_IP})`,                     // quoted local part
  `${E_START}${E_LOCAL}+@(?:${E_IP}|${E_DOMAIN})`,                              // local@domain (no TLD needed)
  `${E_START}${E_LOCAL}+(?:\\s+@\\s+|@\\s+)${E_HOST}`,                          // spaced @ (not «oss @handle.x»), a host must follow
  `${E_START}${E_LOCAL}+${E_AT_WORD}(?:${E_DOM}+(?:${E_DOT}${E_DOM}+)*${E_DOT}\\p{L}${E_DOM}*|${E_IP})`, // [at] (at) {at} «at» [@] …
  `${E_START}${E_LOCAL}+@(?=\\s*$|[,.;:!?)»"\\]])`,                              // a cut «local@»
].join("|"), "giu");

// An encoded «@» counts only before a dotted domain.
const E_ENCODED_AT = /(?:&#0*64;|&#x0*40;|&commat;|%(?:25)?40)(?=[\p{L}\p{N}\-]+\.[\p{L}\p{N}])/giu;

/**
 * The text with every e-mail address (in the forms above) replaced by «…».
 * Matching runs on the NFKC-normalised text without format characters and
 * with encoded «@» decoded; that text is returned only when an address was
 * replaced — otherwise the input comes back unchanged («m²», «½», ZWJ emoji,
 * «40%40» stay as written).
 */
export function stripEmailAddresses(text: string): string {
  const t = text
    .normalize("NFKC")
    .replace(/\p{Cf}/gu, "")
    .replace(E_ENCODED_AT, "@");
  let replaced = false;
  const out = t.replace(EMAIL_RE, () => { replaced = true; return "…"; });
  return replaced ? out : text;
}

/** Most code points shortText strips (the log shows OWNER_AUDIT_TEXT_MAX). */
export const OWNER_AUDIT_STRIP_MAX = 1000;

/**
 * Whitespace collapsed, cut to OWNER_AUDIT_STRIP_MAX code points (dropping
 * the word the cut went through, so no half address is left), addresses
 * removed, then cut at `max` code points (an emoji is never split) with «…».
 * Stripping comes before the visible cut, so that cut can never leave part
 * of an address behind; the first cut keeps the regex work bounded whatever
 * an owner saved (update-profile has no length cap).
 */
function shortText(raw: string, max = OWNER_AUDIT_TEXT_MAX): string {
  let s = raw.replace(/\s+/g, " ").trim();
  let capped = false;
  if (s.length > OWNER_AUDIT_STRIP_MAX) {
    const head = Array.from(s.slice(0, OWNER_AUDIT_STRIP_MAX * 2));
    if (head.length > OWNER_AUDIT_STRIP_MAX || s.length > OWNER_AUDIT_STRIP_MAX * 2) {
      s = head.slice(0, OWNER_AUDIT_STRIP_MAX).join("").replace(/\S*$/, "").trimEnd();
      capped = true;
    }
  }
  s = stripEmailAddresses(s).replace(/\s+/g, " ").trim();
  if (!s) return capped ? "…" : OWNER_AUDIT_EMPTY;
  const cps = Array.from(s);
  if (cps.length > max) return `${cps.slice(0, max - 1).join("").trimEnd()}…`;
  return capped ? `${s}…` : s;
}

// SQLite datetime('now') writes «YYYY-MM-DD HH:MM:SS» in UTC without a zone.
const SQLITE_TS_RE = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)$/;
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;
const OSLO_DATE_TIME = new Intl.DateTimeFormat("nb-NO", { timeZone: "Europe/Oslo", dateStyle: "short", timeStyle: "short" });
const OSLO_DATE = new Intl.DateTimeFormat("nb-NO", { timeZone: "Europe/Oslo", dateStyle: "short" });

/** A stored timestamp as a Date (zone-less text is UTC), or null. */
export function parseOwnerAuditTime(raw: unknown): Date | null {
  const s = raw == null ? "" : String(raw).trim();
  if (!s) return null;
  const m = SQLITE_TS_RE.exec(s);
  const d = new Date(m ? `${m[1]}T${m[2]}Z` : DATE_ONLY_RE.test(s) ? `${s}T00:00:00Z` : s);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * A timestamp as Norwegian date and time in Europe/Oslo («02.11.2026, 11:15»,
 * the format of the «Mine valg» change log); a date alone as the date; text
 * that is no time as short text.
 */
export function formatOwnerAuditTime(raw: unknown): string {
  const s = raw == null ? "" : String(raw).trim();
  if (!s) return OWNER_AUDIT_EMPTY;
  const d = parseOwnerAuditTime(s);
  if (!d) return shortText(s);
  return DATE_ONLY_RE.test(s) ? OSLO_DATE.format(d) : OSLO_DATE_TIME.format(d);
}

/**
 * The public Norwegian category names (routes/seo.ts formatCat, byte-identical;
 * owner-audit-log.test.ts pins the parity). Copied, not imported: loading
 * seo.ts would pull ~60 route modules into every owner-portal load.
 */
export const OWNER_AUDIT_CATEGORY_NAMES: Readonly<Record<string, string>> = {
  vegetables: "Grønnsaker",
  fruit: "Frukt",
  berries: "Bær",
  dairy: "Meieri",
  eggs: "Egg",
  meat: "Kjøtt",
  fish: "Fisk",
  bread: "Brød",
  honey: "Honning",
  herbs: "Urter",
  bakery: "Bakeri",
  beverages: "Drikke",
  preserves: "Syltetøy",
  other: "Annet",
};

function parseJson(s: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(s) };
  } catch {
    return { ok: false };
  }
}

/** One list item as text: a string, or an object's name. */
function itemText(item: unknown): string {
  if (typeof item === "string") return item.trim();
  if (typeof item === "number") return String(item);
  if (item && typeof item === "object") {
    const o = item as { name?: unknown; label?: unknown };
    if (typeof o.name === "string") return o.name.trim();
    if (typeof o.label === "string") return o.label.trim();
  }
  return "";
}

function formatList(s: string, kind: "categories" | "products" | "list"): string {
  const parsed = parseJson(s);
  if (!parsed.ok || !Array.isArray(parsed.value)) return shortText(s);
  let items = parsed.value.map(itemText).filter(Boolean);
  if (items.length === 0) return OWNER_AUDIT_EMPTY;
  if (kind === "products" && items.length > OWNER_AUDIT_PRODUCT_NAMES_MAX) return `${items.length} varer`;
  if (kind === "categories") {
    items = items.map((k) => (Object.prototype.hasOwnProperty.call(OWNER_AUDIT_CATEGORY_NAMES, k) ? OWNER_AUDIT_CATEGORY_NAMES[k] : k));
  }
  return shortText(items.join(", "));
}

function formatHours(s: string): string {
  const parsed = parseJson(s);
  if (!parsed.ok) return shortText(s); // the owner's raw text (rows from before T0d)
  if (typeof parsed.value === "string") return shortText(parsed.value); // the portal's JSON text
  if (Array.isArray(parsed.value)) {
    if (parsed.value.length === 0) return OWNER_AUDIT_EMPTY;
    const text = openingHoursText(parsed.value);
    return text ? shortText(text) : OWNER_AUDIT_EMPTY;
  }
  return shortText(s);
}

/**
 * One stored value as the owner reads it. Every text goes through shortText,
 * so no e-mail address in a form stripEmailAddresses catches reaches the
 * owner; e-mail fields are never formatted (the row carries values_hidden).
 */
export function formatOwnerAuditValue(kind: OwnerAuditValueKind, raw: unknown): string {
  const s = raw == null ? "" : String(raw).trim();
  if (!s) return OWNER_AUDIT_EMPTY;
  switch (kind) {
    case "bool": {
      const v = s.toLowerCase();
      if (v === "1" || v === "true") return OWNER_AUDIT_YES;
      if (v === "0" || v === "false") return OWNER_AUDIT_NO;
      return shortText(s);
    }
    case "visible": {
      const v = s.toLowerCase();
      if (v === "on") return OWNER_AUDIT_YES;
      if (v === "off" || v.startsWith("off ")) return OWNER_AUDIT_NO;
      return shortText(s);
    }
    case "time":
      return formatOwnerAuditTime(s);
    case "hours":
      return formatHours(s);
    case "categories":
    case "products":
    case "list":
      return formatList(s, kind);
    case "email":
      return ""; // never shown: the row carries values_hidden
    case "prose": {
      const cleaned = stripInternalNotes(s);
      return cleaned ? shortText(cleaned) : OWNER_AUDIT_EMPTY;
    }
    case "text":
    default:
      return shortText(s);
  }
}

/** One agent_knowledge_audit row as the query reads it. */
export interface OwnerAuditDbRow {
  id: string;
  field_name: string;
  old_value: string | null;
  new_value: string | null;
  changed_by: string;
  changed_at: string;
  notes: string | null;
}

/** One row of GET /api/agents/:id/my-audit: exactly what the log shows. */
export interface OwnerAuditFeedRow {
  id: string;
  field_name: string;
  label: string;
  /** Display text; null when values_hidden. */
  old_value: string | null;
  new_value: string | null;
  /** true for an e-mail field: the log shows «<label> endret» without values. */
  values_hidden: boolean;
  who: string;
  /** ISO 8601 (UTC). */
  changed_at: string;
  /** Norwegian date and time, Europe/Oslo. */
  when: string;
}

/**
 * The feed rows for the stored rows, in the given order. A field outside the
 * table is dropped (fail closed), and so is a row whose values read the same
 * before and after (nothing changed for the owner).
 */
export function ownerAuditFeedRows(rows: readonly OwnerAuditDbRow[]): OwnerAuditFeedRow[] {
  const out: OwnerAuditFeedRow[] = [];
  for (const r of rows) {
    if (!Object.prototype.hasOwnProperty.call(OWNER_AUDIT_FIELDS, r.field_name)) continue;
    const field = OWNER_AUDIT_FIELDS[r.field_name];
    const hidden = field.kind === "email";
    const oldV = hidden ? null : formatOwnerAuditValue(field.kind, r.old_value);
    const newV = hidden ? null : formatOwnerAuditValue(field.kind, r.new_value);
    if (hidden ? (r.old_value ?? "").trim() === (r.new_value ?? "").trim() : oldV === newV) continue;
    const at = parseOwnerAuditTime(r.changed_at);
    out.push({
      id: String(r.id),
      field_name: r.field_name,
      label: field.label,
      old_value: oldV,
      new_value: newV,
      values_hidden: hidden,
      who: ownerAuditWho(r.changed_by, r.notes),
      changed_at: at ? at.toISOString() : "",
      when: at ? formatOwnerAuditTime(r.changed_at) : "",
    });
  }
  return out;
}

/** Most stored rows one feed read looks at (bounds the refill below). */
export const OWNER_AUDIT_SCAN_MAX = 1000;

/**
 * The newest `limit` rows the owner sees. SQL keeps the table's fields and
 * drops raw no-op rows; rows whose values still READ the same («1» →
 * «true», whitespace, a stripped pipeline note) are dropped in JS afterwards,
 * so the query is read in batches until `limit` shown rows are found, the
 * rows run out, or OWNER_AUDIT_SCAN_MAX rows were looked at (then the rows
 * found so far are returned: the newest shown rows within that window).
 * At most two queries: a first batch of 2×limit (≥ 50), then — only when
 * rows that read the same were dropped — one more for the rest of the scan
 * window. The second continues after the last row seen (keyset on time,
 * rowid), so no row is read twice even if a row is written in between.
 * Sorted by time whatever the stored format (julianday() reads both
 * «YYYY-MM-DD HH:MM:SS» and ISO 8601; an unreadable time sorts last, as -1).
 */
export function readOwnerAuditFeed(db: any, agentId: string, limit: number): OwnerAuditFeedRow[] {
  const names = OWNER_AUDIT_FIELD_NAMES;
  const select = (after: boolean) => db.prepare(
    `SELECT id, field_name, old_value, new_value, changed_by, changed_at, notes,
            COALESCE(julianday(changed_at), -1) AS k_time, rowid AS k_row
       FROM agent_knowledge_audit
      WHERE agent_id = ?
        AND field_name IN (${names.map(() => "?").join(", ")})
        AND TRIM(IFNULL(old_value, '')) <> TRIM(IFNULL(new_value, ''))
        ${after ? "AND (COALESCE(julianday(changed_at), -1) < ? OR (COALESCE(julianday(changed_at), -1) = ? AND rowid < ?))" : ""}
      ORDER BY k_time DESC, k_row DESC
      LIMIT ?`,
  );
  const first = select(false);
  const next = select(true);
  const batch = Math.min(Math.max(limit * 2, 50), OWNER_AUDIT_SCAN_MAX);
  const out: OwnerAuditFeedRow[] = [];
  let scanned = 0;
  let cursor: { k_time: number; k_row: number } | null = null;
  while (out.length < limit && scanned < OWNER_AUDIT_SCAN_MAX) {
    const take = cursor ? OWNER_AUDIT_SCAN_MAX - scanned : batch;
    const rows = (cursor
      ? next.all(agentId, ...names, cursor.k_time, cursor.k_time, cursor.k_row, take)
      : first.all(agentId, ...names, take)) as Array<OwnerAuditDbRow & { k_time: number; k_row: number }>;
    scanned += rows.length;
    out.push(...ownerAuditFeedRows(rows));
    if (rows.length < take) break;
    cursor = rows[rows.length - 1];
  }
  return out.slice(0, limit);
}
