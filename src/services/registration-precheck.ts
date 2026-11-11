// ─── Self-registration pre-check (RECORD-ONLY) ─────────────────────────────
// dev-request 2026-11-10-rfb-registreringer-og-eierkrav-folges-opp, slice S2.
//
// Every profile the PUBLIC POST /register creates (origin='self_registered',
// is_vetted=0) gets a stored, automatic pre-check RECOMMENDATION in the side
// table agent_registration_precheck (registration_precheck JSON +
// registration_precheck_at; one row per agent — not agents columns, see the
// migration in database/init.ts for why).
//
// RECORD-ONLY: it never approves, never touches is_vetted, visibility, the
// /register response, its status code or latency, and never sends e-mail.
// POST /admin/agents/self-registered-review-approve stays the ONLY way a
// self-registered profile becomes visible. The admin reads the stored
// recommendation in GET /admin/agents/self-registered-review-queue.
//
// Triggers
//   - after a successful public registration, fire-and-forget after the
//     response (scheduleRegistrationPrecheck). Gated by the env flag
//     REGISTRATION_PRECHECK_ENABLED, read at call time: ON unless it is the
//     exact string "false" (kill switch).
//   - on demand: POST /admin/agents/self-registered-precheck (admin-agents.ts),
//     regardless of the flag.
//
// Signals
//   brreg       org.nr known (agents.org_nr or an `org_nr:` tag) → look it up
//               in Enhetsregisteret: found, name match (normalised, strict:
//               a shared non-generic token of ≥4 letters, see
//               precheckNameMatches), whether the org.nr is self-reported
//               (an `org_nr:` tag from the public /register body, or a column
//               value that only mirrors such a tag with no audited write),
//               NACE (naeringskode1.kode), kommune/kommunenummer, deleted
//               (slettedato or HTTP 410), konkurs, under avvikling. No org.nr →
//               name search; a single plausible, live name match counts (only
//               its org.nr + the match flag are stored; never the search URL,
//               which carries the profile name — often a person's name).
//   email       contact e-mail domain: own / free-mail / disposable / invalid;
//               MX lookup (DNS) for an own domain.
//   website     the profile URL's host answers 2xx (SSRF-guarded fetch with
//               the claim assessment's guards and page cap) and the profile
//               name appears on the page (normalised). One redirect from the
//               bare host to www.<host> is tried.
//   duplicates  other RFB agents (not this one, not merged) with the same
//               org.nr or the same contact e-mail ("exact"), or the same
//               normalised name in the same city ("possible"). ≤ 5 ids each.
//   domain_tie  the own e-mail domain or the website domain plausibly ties to
//               the entity: the registrable domain's label (normalised, æøå
//               folded) contains a non-generic token (≥4 letters) of the Brreg
//               name or the profile name, or the answering website shows the
//               Brreg name. Only booleans are stored.
//   owner_claim the shared customer rule (customer-rule.ts: agents.claimed_at
//               OR a verified agent_claims row; a revoked claim has status
//               'revoked', so it never counts). Recorded for the reviewer; not
//               part of the rule.
//
// Rule R2 (R1 + the self-reported org.nr / domain-tie hardening)
//   avvis      disposable e-mail
//              OR the Brreg entity for the profile's org.nr is deleted/konkurs
//              OR an exact duplicate (same org.nr or same contact e-mail) of an
//                 existing VETTED agent.
//   godkjenn   Brreg match (org.nr found, live and name matches, or a single
//                 live name-search match)
//              AND (own e-mail domain with MX, OR website answers and shows
//                 the name)
//              AND no possible/exact duplicate of any kind
//              AND no unavailable source
//              AND, when the entity came from registrant input (self-reported
//                 org.nr or a name search), a domain tie (see domain_tie).
//   spor_forst everything else (any unavailable source, free-mail without
//              other support, name+place duplicate, under avvikling, …).
//
// Privacy: only org.nr, flags, NACE and kommune are stored from Brreg —
// never the registered name (an ENK name is a person's name) or any role.
// Fetched page text is never stored.
//
// Network and clock are injectable (RegistrationPrecheckDeps); tests stub all.

import { getDb } from "../database/init";
import { normaliseName, normaliseNamePruned } from "./brreg-client";
import {
  DISPOSABLE_MAIL_DOMAINS,
  defaultClaimAssessmentDeps,
  normalizeOrgNr,
  preparePage,
  type HttpAnswer,
} from "./claim-assessment";
import { emailDomain, isFreeMailDomain, isProbeableDomain, registrableDomain, websiteHost } from "./claim-domain-rule";
import { customerRuleSql } from "./customer-rule";

/** Env flag (read at call time). ON unless exactly "false". */
export const REGISTRATION_PRECHECK_FLAG = "REGISTRATION_PRECHECK_ENABLED";

export function registrationPrecheckEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[REGISTRATION_PRECHECK_FLAG] !== "false";
}

export const REGISTRATION_PRECHECK_RULE_VERSION = "R2" as const;
export const REGISTRATION_PRECHECK_SOURCE_TIMEOUT_MS = 4000;
export const REGISTRATION_PRECHECK_TOTAL_TIMEOUT_MS = 12000;
export const REGISTRATION_PRECHECK_DUPLICATE_CAP = 5;
export const REGISTRATION_PRECHECK_BATCH_CAP = 50;

export const BRREG_ENHET_URL = (orgNr: string): string =>
  `https://data.brreg.no/enhetsregisteret/api/enheter/${orgNr}`;
export const BRREG_NAME_SEARCH_URL = (name: string): string =>
  `https://data.brreg.no/enhetsregisteret/api/enheter?navn=${encodeURIComponent(name.slice(0, 100))}&size=20`;

export type PrecheckRecommendation = "godkjenn" | "spor_forst" | "avvis";
export type PrecheckSource = "brreg" | "dns_mx" | "website";
export type PrecheckStatus = "ok" | "unavailable" | "skipped";

export interface BrregSignal {
  status: PrecheckStatus;
  mode: "org_nr" | "name_search" | "none";
  org_nr: string | null;
  /** The org.nr came from the registrant (an `org_nr:` tag), not an audited write. */
  org_nr_self_reported: boolean;
  found: boolean;
  name_match: boolean;
  nace: string | null;
  kommune: string | null;
  kommunenummer: string | null;
  deleted: boolean;
  konkurs: boolean;
  under_avvikling: boolean;
  /** name_search only: how many hits matched the name plausibly. */
  name_hits?: number;
  /** org_nr mode only (the URL holds just the org.nr); never for a name search. */
  source_url?: string;
  note?: string;
}

export interface EmailSignal {
  status: PrecheckStatus;
  domain: string | null;
  domain_type: "own" | "free" | "disposable" | "invalid";
  /** own domain only: MX exists (null when not checked / unavailable). */
  mx: boolean | null;
  note?: string;
}

export interface WebsiteSignal {
  status: PrecheckStatus;
  host: string | null;
  answers: boolean | null;
  name_on_page: boolean | null;
  note?: string;
}

export interface DuplicateSignal {
  /** Same org.nr or same contact e-mail. */
  exact_ids: string[];
  /** The exact duplicates that are vetted (is_vetted = 1). */
  exact_vetted_ids: string[];
  /** Same normalised name and same city. */
  name_place_ids: string[];
}

export interface DomainTieSignal {
  /** Own e-mail domain's label carries a name token (null: no own domain). */
  email_domain: boolean | null;
  /** Website domain's label carries a name token (null: no website host). */
  website_domain: boolean | null;
  /** The answering website shows the Brreg name (null: not checked). */
  website_shows_brreg_name: boolean | null;
  tied: boolean;
  /** The rule needs the tie (self-reported org.nr or a name-search entity). */
  required: boolean;
}

export interface RegistrationPrecheck {
  recommendation: PrecheckRecommendation;
  reasons: string[];
  signals: {
    brreg: BrregSignal;
    email: EmailSignal;
    website: WebsiteSignal;
    duplicates: DuplicateSignal;
    domain_tie: DomainTieSignal;
    owner_claim: { confirmed: boolean };
  };
  unavailable_sources: PrecheckSource[];
  rule_version: typeof REGISTRATION_PRECHECK_RULE_VERSION;
  assessed_at: string;
}

/** What the DB knows about the profile (gatherRegistrationPrecheckInput). */
export interface RegistrationPrecheckInput {
  name: string;
  contactEmail: string | null;
  url: string | null;
  city: string | null;
  orgNr: string | null;
  /** True when orgNr came from the registrant (`org_nr:` tag), not an audited write. */
  orgNrSelfReported: boolean;
  duplicates: DuplicateSignal;
  ownerClaimConfirmed: boolean;
}

export interface RegistrationPrecheckDeps {
  /** GET a fixed public JSON API (Brreg). Throws on network error/timeout. */
  fetchApi: (url: string, timeoutMs: number) => Promise<HttpAnswer>;
  /** GET https://<host>/ (SSRF-guarded). Throws on network error/timeout. */
  fetchSite: (host: string, timeoutMs: number) => Promise<HttpAnswer>;
  /** MX records. Throws (with `code`) on failure; ENOTFOUND/ENODATA mean "none". */
  resolveMx: (domain: string) => Promise<Array<{ exchange: string; priority: number }>>;
  now: () => Date;
  timeoutMs?: number;
}

// ─── helpers ──────────────────────────────────────────────────────────────

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" })), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

/** Words too generic to identify a business on their own. */
const GENERIC_NAME_TOKENS: ReadonlySet<string> = new Set([
  "agent", "og", "i", "pa", "av", "the", "and", "of", "gard", "garden", "gardsbruk", "gardsutsalg", "gardsbutikk",
  "farm", "gardsmat", "lokal", "mat", "as", "asa", "da", "ans", "enk", "sa", "ba", "ks", "nuf",
]);

function significantTokens(name: string): string[] {
  return normaliseNamePruned(name).split(" ").filter((t) => t.length >= 3 && !GENERIC_NAME_TOKENS.has(t));
}

/** Significant tokens long enough to identify a business (≥4 letters). */
function strongTokens(name: string): string[] {
  return significantTokens(name).filter((t) => t.length >= 4);
}

/**
 * Business-name match between the PROFILE name and the BRREG name (order
 * matters). Both are normalised (diacritics folded, company-form suffix
 * dropped) and must share at least one non-generic token of ≥4 letters —
 * equality alone is not enough ("Gård" vs "GÅRD AS" never matches). Then:
 *   - the same significant tokens ("Solbakken Gård" ~ "SOLBAKKEN GÅRD AS"), or
 *   - the profile's significant tokens lead the Brreg name (an ENK name adds
 *     the owner: "Solbakken Gård" ~ "Solbakken Gård Kari Nordmann"), or
 *   - every significant Brreg token is in the profile name AND the Brreg name
 *     has ≥2 of them (a lone, often surname-like Brreg token inside a longer
 *     profile name — "Nordre Hansen Gård" vs "HANSEN" — does not count).
 */
export function precheckNameMatches(profileName: string, brregName: string): boolean {
  const np = normaliseNamePruned(String(profileName ?? ""));
  const nb = normaliseNamePruned(String(brregName ?? ""));
  if (!np || !nb) return false;
  const tp = significantTokens(np);
  const tb = significantTokens(nb);
  const strongB = new Set(strongTokens(nb));
  if (!strongTokens(np).some((t) => strongB.has(t))) return false;
  const setP = new Set(tp);
  const setB = new Set(tb);
  if (setP.size === setB.size && [...setP].every((t) => setB.has(t))) return true;
  if (tp.length <= tb.length && tp.every((t, i) => tb[i] === t)) return true;
  return tb.length >= 2 && tb.every((t) => setP.has(t));
}

/** The registrable domain's first label, normalised (æøå folded, no hyphens). */
function domainLabel(host: string | null): string | null {
  if (!host) return null;
  const reg = registrableDomain(host.toLowerCase());
  if (!reg) return null;
  const label = normaliseName(reg.split(".")[0] ?? "").replace(/[^a-z0-9]/g, "");
  return label || null;
}

/** A domain label carries a non-generic name token (≥4 letters) of one of the names. */
export function domainTiesToName(host: string | null, names: string[]): boolean {
  const label = domainLabel(host);
  if (!label) return false;
  return names.some((n) => strongTokens(String(n ?? "")).some((t) => label.includes(t)));
}

/** The name (normalised) appears in the page text (normalised). */
export function pageShowsName(html: string, name: string): boolean {
  const target = normaliseNamePruned(name);
  if (target.length < 3) return false;
  const text = ` ${normaliseName(preparePage(html).text)} `;
  return text.includes(` ${target} `);
}

/** Reads the facts the rule needs out of one Enhetsregisteret `enhet` object. */
export function readBrregEnhet(json: unknown): {
  orgNr: string | null; navn: string; nace: string | null; kommune: string | null; kommunenummer: string | null;
  deleted: boolean; konkurs: boolean; underAvvikling: boolean;
} {
  const e = (json ?? {}) as Record<string, any>;
  const addr = (e.forretningsadresse ?? e.beliggenhetsadresse ?? e.postadresse ?? {}) as Record<string, any>;
  const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
  return {
    orgNr: normalizeOrgNr(e.organisasjonsnummer),
    navn: typeof e.navn === "string" ? e.navn : "",
    nace: str(e.naeringskode1?.kode),
    kommune: str(addr.kommune),
    kommunenummer: str(addr.kommunenummer),
    deleted: !!str(e.slettedato),
    konkurs: e.konkurs === true,
    underAvvikling: e.underAvvikling === true || e.underTvangsavviklingEllerTvangsopplosning === true,
  };
}

const isNoRecordsDnsError = (e: unknown): boolean => {
  const code = String((e as { code?: unknown })?.code ?? "");
  return code === "ENOTFOUND" || code === "ENODATA";
};

// ─── the assessment ───────────────────────────────────────────────────────

export async function assessRegistration(
  input: RegistrationPrecheckInput,
  deps: RegistrationPrecheckDeps,
): Promise<RegistrationPrecheck> {
  const timeout = deps.timeoutMs ?? REGISTRATION_PRECHECK_SOURCE_TIMEOUT_MS;
  const unavailable = new Set<PrecheckSource>();
  const orgNr = normalizeOrgNr(input.orgNr);

  const orgNrSelfReported = !!orgNr && input.orgNrSelfReported === true;
  // The Brreg name stays in memory only (domain tie); it is never stored.
  let brregName = "";

  // ── Brreg ──
  const brregP = (async (): Promise<BrregSignal> => {
    const base: BrregSignal = {
      status: "ok", mode: orgNr ? "org_nr" : "name_search", org_nr: orgNr, org_nr_self_reported: orgNrSelfReported,
      found: false, name_match: false,
      nace: null, kommune: null, kommunenummer: null, deleted: false, konkurs: false, under_avvikling: false,
    };
    const fail = (note: string): BrregSignal => { unavailable.add("brreg"); return { ...base, status: "unavailable", note }; };
    if (orgNr) {
      const url = BRREG_ENHET_URL(orgNr);
      base.source_url = url;
      try {
        const r = await withTimeout(deps.fetchApi(url, timeout), timeout);
        if (r.status === 404 || r.status === 400) return { ...base, note: `http_${r.status}` };
        // Enhetsregisteret answers 410 Gone for a unit that has been removed.
        if (r.status === 410) return { ...base, found: true, deleted: true, note: "http_410" };
        if (r.status < 200 || r.status >= 300) return fail(`http_${r.status}`);
        let json: unknown;
        try { json = JSON.parse(r.body); } catch { return fail("bad_json"); }
        const e = readBrregEnhet(json);
        brregName = e.navn;
        return {
          ...base, found: true, name_match: precheckNameMatches(input.name, e.navn), nace: e.nace,
          kommune: e.kommune, kommunenummer: e.kommunenummer, deleted: e.deleted, konkurs: e.konkurs,
          under_avvikling: e.underAvvikling,
        };
      } catch {
        return fail("unavailable");
      }
    }
    if (!String(input.name ?? "").trim()) return { ...base, status: "skipped", mode: "none", note: "no_name" };
    // Privacy: the search URL carries the profile name (often a person's
    // name) — it is used for the request only, never stored.
    const url = BRREG_NAME_SEARCH_URL(input.name.trim());
    try {
      const r = await withTimeout(deps.fetchApi(url, timeout), timeout);
      if (r.status < 200 || r.status >= 300) return fail(`http_${r.status}`);
      let json: any;
      try { json = JSON.parse(r.body); } catch { return fail("bad_json"); }
      const list: unknown[] = Array.isArray(json?._embedded?.enheter) ? json._embedded.enheter : [];
      const hits = list.map(readBrregEnhet).filter((e) => e.orgNr && precheckNameMatches(input.name, e.navn));
      const live = hits.filter((e) => !e.deleted && !e.konkurs);
      if (hits.length === 1 && live.length === 1) {
        const e = live[0]!;
        brregName = e.navn;
        return {
          ...base, org_nr: e.orgNr, found: true, name_match: true, nace: e.nace, kommune: e.kommune,
          kommunenummer: e.kommunenummer, under_avvikling: e.underAvvikling, name_hits: 1,
        };
      }
      return { ...base, name_hits: hits.length };
    } catch {
      return fail("unavailable");
    }
  })();

  // ── e-mail ──
  const email = String(input.contactEmail ?? "").trim().toLowerCase();
  const domain = emailDomain(email);
  const reg = domain ? registrableDomain(domain) : null;
  const domainType: EmailSignal["domain_type"] = !domain || !reg ? "invalid"
    : DISPOSABLE_MAIL_DOMAINS.has(reg) || DISPOSABLE_MAIL_DOMAINS.has(domain) ? "disposable"
    : isFreeMailDomain(domain) ? "free" : "own";
  const emailP = (async (): Promise<EmailSignal> => {
    const base: EmailSignal = { status: "ok", domain, domain_type: domainType, mx: null };
    if (domainType !== "own" || !isProbeableDomain(domain!)) return { ...base, status: "skipped", note: domainType };
    try {
      const recs = await withTimeout(deps.resolveMx(domain!), timeout);
      const usable = (recs ?? []).filter((r) => r && typeof r.exchange === "string" && r.exchange !== "" && r.exchange !== ".");
      return { ...base, mx: usable.length > 0 };
    } catch (e) {
      if (isNoRecordsDnsError(e)) return { ...base, mx: false, note: "no_records" };
      unavailable.add("dns_mx");
      return { ...base, status: "unavailable", note: "unavailable" };
    }
  })();

  // ── website ──
  const host = input.url ? websiteHost(input.url) : null;
  let pageBody = "";
  const websiteP = (async (): Promise<WebsiteSignal> => {
    const base: WebsiteSignal = { status: "ok", host, answers: null, name_on_page: null };
    if (!host) return { ...base, status: "skipped", note: "no_website" };
    if (!isProbeableDomain(host)) return { ...base, status: "skipped", note: "not_probeable" };
    const get = (h: string) => withTimeout(deps.fetchSite(h, timeout), timeout);
    try {
      let r = await get(host);
      // No redirect is followed by the safe fetch; try www.<host> once.
      if (r.status >= 300 && r.status < 400 && !host.startsWith("www.") && isProbeableDomain(`www.${host}`)) {
        r = await get(`www.${host}`);
      }
      if (r.status >= 500) { unavailable.add("website"); return { ...base, status: "unavailable", note: `http_${r.status}` }; }
      if (r.status < 200 || r.status >= 300) return { ...base, answers: false, name_on_page: false, note: `http_${r.status}` };
      pageBody = String(r.body ?? "");
      return { ...base, answers: true, name_on_page: pageShowsName(pageBody, input.name) };
    } catch {
      unavailable.add("website");
      return { ...base, status: "unavailable", note: "unavailable" };
    }
  })();

  const [brreg, emailSig, website] = await Promise.all([brregP, emailP, websiteP]);
  const dup = input.duplicates;
  const unavailableSources = [...unavailable].sort() as PrecheckSource[];

  // ── domain tie (booleans only; the Brreg name and page text are not stored) ──
  const tieNames = [brregName, input.name].filter((n) => !!String(n ?? "").trim());
  const ownMail = emailSig.domain_type === "own";
  const tieRequired = brreg.found && (brreg.mode === "name_search" || brreg.org_nr_self_reported);
  const domainTie: DomainTieSignal = {
    email_domain: ownMail ? domainTiesToName(domain, tieNames) : null,
    website_domain: host ? domainTiesToName(host, tieNames) : null,
    website_shows_brreg_name: website.answers === true && brregName
      ? strongTokens(brregName).length > 0 && pageShowsName(pageBody, brregName) : null,
    tied: false,
    required: tieRequired,
  };
  pageBody = "";
  domainTie.tied = (ownMail && emailSig.mx === true && domainTie.email_domain === true)
    || (website.answers === true && (domainTie.website_domain === true || domainTie.website_shows_brreg_name === true));

  // ── reasons (short, Norwegian) ──
  const reasons: string[] = [];
  if (brreg.status === "unavailable") reasons.push("Brreg: utilgjengelig, ikke sjekket");
  else if (brreg.mode === "org_nr") {
    if (!brreg.found) reasons.push(`Brreg: org.nr ${brreg.org_nr} ikke funnet`);
    else if (brreg.deleted) reasons.push(`Brreg: org.nr ${brreg.org_nr} er slettet`);
    else if (brreg.konkurs) reasons.push(`Brreg: org.nr ${brreg.org_nr} er konkurs`);
    else {
      reasons.push(`Brreg: org.nr ${brreg.org_nr} funnet, navnet ${brreg.name_match ? "stemmer" : "stemmer ikke"}`);
      if (brreg.under_avvikling) reasons.push("Brreg: enheten er under avvikling");
    }
    if (brreg.org_nr_self_reported) reasons.push("Brreg: org.nr er selvoppgitt");
  } else if (brreg.mode === "name_search") {
    if (brreg.found) {
      reasons.push(`Brreg: ett treff på navnet (org.nr ${brreg.org_nr}); org.nr ikke oppgitt`);
      if (brreg.under_avvikling) reasons.push("Brreg: enheten er under avvikling");
    } else reasons.push(`Brreg: ingen entydig navnetreff (${brreg.name_hits ?? 0} treff); org.nr ikke oppgitt`);
  } else reasons.push("Brreg: ikke sjekket (mangler navn)");

  if (emailSig.domain_type === "disposable") reasons.push("E-post: engangsadresse");
  else if (emailSig.domain_type === "free") reasons.push("E-post: gratis e-posttjeneste");
  else if (emailSig.domain_type === "invalid") reasons.push("E-post: ugyldig domene");
  else if (emailSig.status === "unavailable") reasons.push("E-post: eget domene, MX-oppslag utilgjengelig");
  else if (emailSig.status === "skipped") reasons.push("E-post: eget domene kan ikke sjekkes");
  else reasons.push(emailSig.mx ? "E-post: eget domene med MX" : "E-post: eget domene uten MX");

  if (website.status === "skipped") reasons.push(website.note === "no_website" ? "Nettside: ikke oppgitt" : "Nettside: kan ikke sjekkes");
  else if (website.status === "unavailable") reasons.push("Nettside: utilgjengelig");
  else if (!website.answers) reasons.push(`Nettside: svarer ikke (${website.note ?? "feil"})`);
  else reasons.push(website.name_on_page ? "Nettside: svarer og viser navnet" : "Nettside: svarer, men navnet vises ikke");

  if (dup.exact_vetted_ids.length) reasons.push(`Duplikat: samme org.nr eller e-post som ${dup.exact_vetted_ids.length} godkjent(e) profil(er)`);
  const exactUnvetted = dup.exact_ids.filter((id) => !dup.exact_vetted_ids.includes(id));
  if (exactUnvetted.length) reasons.push(`Mulig duplikat: samme org.nr eller e-post som ${exactUnvetted.length} ikke-godkjent(e) profil(er)`);
  if (dup.name_place_ids.length) reasons.push(`Mulig duplikat: ${dup.name_place_ids.length} profil(er) med samme navn og sted`);
  if (tieRequired) {
    reasons.push(domainTie.tied ? "Domene: knyttet til enheten" : "Domene: domenet er ikke knyttet til enheten");
  }
  reasons.push(input.ownerClaimConfirmed ? "Eierkrav: bekreftet" : "Eierkrav: ingen bekreftet");

  // ── rule R2 ──
  const brregDead = brreg.mode === "org_nr" && brreg.found && (brreg.deleted || brreg.konkurs);
  const avvis = emailSig.domain_type === "disposable" || brregDead || dup.exact_vetted_ids.length > 0;
  const brregMatch = brreg.status === "ok" && brreg.found && brreg.name_match && !brreg.deleted && !brreg.konkurs
    && !brreg.under_avvikling;
  const contactSupport = (emailSig.domain_type === "own" && emailSig.mx === true)
    || (website.answers === true && website.name_on_page === true);
  const anyDuplicate = dup.exact_ids.length > 0 || dup.name_place_ids.length > 0;
  const recommendation: PrecheckRecommendation = avvis ? "avvis"
    : brregMatch && contactSupport && !anyDuplicate && unavailableSources.length === 0
      && (!tieRequired || domainTie.tied) ? "godkjenn"
    : "spor_forst";

  return {
    recommendation,
    reasons,
    signals: {
      brreg, email: emailSig, website, duplicates: dup, domain_tie: domainTie,
      owner_claim: { confirmed: input.ownerClaimConfirmed },
    },
    unavailable_sources: unavailableSources,
    rule_version: REGISTRATION_PRECHECK_RULE_VERSION,
    assessed_at: deps.now().toISOString(),
  };
}

// ─── DB side ──────────────────────────────────────────────────────────────

type Db = ReturnType<typeof getDb>;

interface AgentPrecheckRow {
  id: string;
  name: string;
  contact_email: string | null;
  url: string | null;
  city: string | null;
  org_nr: string | null;
  tags: string | null;
  origin: string | null;
  is_vetted: number | null;
  claimed_at: string | null;
}

function readAgentRow(db: Db, agentId: string): AgentPrecheckRow | undefined {
  return db.prepare(
    `SELECT id, name, contact_email, url, city, org_nr, tags, origin, is_vetted, claimed_at FROM agents WHERE id = ?`
  ).get(agentId) as AgentPrecheckRow | undefined;
}

function orgNrOfRow(row: { org_nr: string | null; tags: string | null }): string | null {
  const col = normalizeOrgNr(row.org_nr);
  if (col) return col;
  return orgNrTagOfRow(row);
}

/** The `org_nr:` tag — registrant input from the public /register body. */
function orgNrTagOfRow(row: { tags: string | null }): string | null {
  const m = String(row.tags ?? "").match(/org_nr:(\d{9})(?!\d)/);
  return m ? m[1]! : null;
}

/**
 * Self-reported = the org.nr is the registrant's own `org_nr:` tag: either
 * there is no column value, or the column only mirrors the tag (the one-time
 * tag→column backfill) with no audited write (agents_org_nr_audit, written by
 * the admin/Brreg org.nr path) of that value.
 */
function orgNrIsSelfReported(db: Db, agentId: string, row: { org_nr: string | null; tags: string | null }, orgNr: string | null): boolean {
  if (!orgNr) return false;
  const tag = orgNrTagOfRow(row);
  if (tag !== orgNr) return false;
  if (!normalizeOrgNr(row.org_nr)) return true;
  try {
    return !db.prepare(
      `SELECT 1 FROM agents_org_nr_audit WHERE agent_id = ? AND field_name = 'org_nr' AND new_value = ? LIMIT 1`
    ).get(agentId, orgNr);
  } catch {
    return true; // no audit table: nothing proves another source
  }
}

const normCity = (c: unknown): string => (typeof c === "string" ? normaliseName(c) : "");

/** Gathers the DB facts for one agent, or null when the row is gone. */
export function gatherRegistrationPrecheckInput(db: Db, agentId: string): RegistrationPrecheckInput | null {
  const row = readAgentRow(db, agentId);
  if (!row) return null;
  const orgNr = orgNrOfRow(row);
  const orgNrSelfReported = orgNrIsSelfReported(db, agentId, row, orgNr);
  const email = String(row.contact_email ?? "").trim().toLowerCase();
  const cap = REGISTRATION_PRECHECK_DUPLICATE_CAP;
  const others = "a.id <> ? AND COALESCE(a.vertical_id, 'rfb') = 'rfb' AND a.merged_into IS NULL";

  // Exact: same org.nr (column or tag) or same contact e-mail.
  const exact = new Map<string, boolean>();
  const addExact = (rows: Array<{ id: string; is_vetted: number | null }>): void => {
    for (const r of rows) exact.set(r.id, (exact.get(r.id) ?? false) || r.is_vetted !== 0);
  };
  if (orgNr) {
    addExact(db.prepare(`SELECT a.id, a.is_vetted FROM agents a WHERE ${others} AND (a.org_nr = ? OR a.tags LIKE ?) LIMIT 20`)
      .all(agentId, orgNr, `%org_nr:${orgNr}%`) as any[]);
  }
  if (email.includes("@")) {
    addExact(db.prepare(`SELECT a.id, a.is_vetted FROM agents a WHERE ${others} AND lower(trim(a.contact_email)) = ? LIMIT 20`)
      .all(agentId, email) as any[]);
  }
  const exactIds = [...exact.keys()];
  // Vetted first, so the capped list never hides the one that decides "avvis".
  exactIds.sort((x, y) => Number(exact.get(y)) - Number(exact.get(x)));

  // Possible: same normalised name AND same city (JS-side: SQLite lower() is ASCII-only).
  const namePlace: string[] = [];
  const myName = normaliseNamePruned(String(row.name ?? ""));
  const myCity = normCity(row.city);
  if (myName && myCity) {
    const rows = db.prepare(`SELECT a.id, a.name, a.city FROM agents a WHERE ${others} AND a.city IS NOT NULL`)
      .all(agentId) as Array<{ id: string; name: string; city: string | null }>;
    for (const r of rows) {
      if (exact.has(r.id)) continue;
      if (normCity(r.city) === myCity && normaliseNamePruned(String(r.name ?? "")) === myName) {
        namePlace.push(r.id);
        if (namePlace.length >= cap) break;
      }
    }
  }

  // The shared customer rule (claimed_at OR a verified claim), same as the
  // review queue. Revoking a claim sets status = 'revoked' (and restores /
  // clears claimed_at), so a revoked claim never counts here.
  let ownerClaimConfirmed = !!row.claimed_at;
  try {
    ownerClaimConfirmed = !!db.prepare(`SELECT 1 FROM agents a WHERE a.id = ? AND ${customerRuleSql("a")}`).get(agentId);
  } catch { /* claims table absent in a stripped-down DB: claimed_at alone */ }

  return {
    name: String(row.name ?? ""),
    contactEmail: row.contact_email,
    url: row.url,
    city: row.city,
    orgNr,
    orgNrSelfReported,
    duplicates: {
      exact_ids: exactIds.slice(0, cap),
      exact_vetted_ids: exactIds.filter((id) => exact.get(id)).slice(0, cap),
      name_place_ids: namePlace,
    },
    ownerClaimConfirmed,
  };
}

// ─── deps ─────────────────────────────────────────────────────────────────

export const defaultRegistrationPrecheckDeps: RegistrationPrecheckDeps = {
  fetchApi: defaultClaimAssessmentDeps.fetchApi,
  fetchSite: defaultClaimAssessmentDeps.fetchSite,
  resolveMx: defaultClaimAssessmentDeps.resolveMx,
  now: () => new Date(),
};

let depsOverride: Partial<RegistrationPrecheckDeps> | null = null;

export function getRegistrationPrecheckDeps(): RegistrationPrecheckDeps {
  return { ...defaultRegistrationPrecheckDeps, ...(depsOverride ?? {}) };
}

/** Tests only: replace some deps (null restores the defaults). */
export function __setRegistrationPrecheckDepsForTesting(d: Partial<RegistrationPrecheckDeps> | null): void {
  depsOverride = d;
}

/** An error kind for logs (never a message: it may carry a domain or address). */
function errorKind(err: unknown): string {
  const code = (err as { code?: unknown })?.code;
  if (typeof code === "string" && /^[A-Z_]{2,40}$/.test(code)) return code;
  return err instanceof Error && /timeout/i.test(err.message) ? "timeout" : "error";
}

/**
 * Assesses one agent and stores the result (record-only: one parameterised
 * upsert into agent_registration_precheck, nothing else).
 * Returns the stored precheck, or null when the agent row is gone. Throws on
 * a total timeout or DB error (callers catch).
 */
export async function runRegistrationPrecheck(
  agentId: string,
  deps: RegistrationPrecheckDeps = getRegistrationPrecheckDeps(),
): Promise<RegistrationPrecheck | null> {
  const input = gatherRegistrationPrecheckInput(getDb(), agentId);
  if (!input) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const precheck = await Promise.race([
    assessRegistration(input, deps),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("precheck timeout")), REGISTRATION_PRECHECK_TOTAL_TIMEOUT_MS);
      (timer as any).unref?.();
    }),
  ]).finally(() => { if (timer) clearTimeout(timer); });
  getDb().prepare(
    `INSERT INTO agent_registration_precheck (agent_id, registration_precheck, registration_precheck_at) VALUES (?, ?, ?)
     ON CONFLICT(agent_id) DO UPDATE SET registration_precheck = excluded.registration_precheck,
                                         registration_precheck_at = excluded.registration_precheck_at`
  ).run(agentId, JSON.stringify(precheck), precheck.assessed_at);
  return precheck;
}

// ─── fire-and-forget after /register ──────────────────────────────────────

const pending = new Set<Promise<void>>();

/**
 * Starts the pre-check for a freshly self-registered agent AFTER the current
 * response (setImmediate), never throws, never awaits. Off when the flag is
 * exactly "false". Under NODE_ENV=test it only runs when a test installed
 * deps (so no suite ever reaches the real network by accident).
 */
export function scheduleRegistrationPrecheck(agentId: string, env: NodeJS.ProcessEnv = process.env): void {
  try {
    if (!agentId || !registrationPrecheckEnabled(env)) return;
    if (env.NODE_ENV === "test" && !depsOverride) return;
    const run = (async (): Promise<void> => {
      await new Promise<void>((r) => setImmediate(r));
      try {
        await runRegistrationPrecheck(agentId);
      } catch (err) {
        console.warn(`[registration-precheck] agent ${agentId} not assessed: ${errorKind(err)}`);
      }
    })();
    pending.add(run);
    run.finally(() => pending.delete(run)).catch(() => { /* handled */ });
  } catch (err) {
    console.warn(`[registration-precheck] not started: ${errorKind(err)}`);
  }
}

/** Tests only: resolves when every scheduled pre-check has finished. */
export async function __waitForRegistrationPrechecksForTesting(): Promise<void> {
  while (pending.size) await Promise.allSettled([...pending]);
}
