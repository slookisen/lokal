// ─── Gårdssalg producer owner-claim — dev-request 2026-07-21-opplevagent-
// claim-flyt-drikkeprodusenter ────────────────────────────────────────────
//
// Producer owner-claim flow for gårdssalg (drikkeprodusent) profiles on
// opplevagent.no. REUSES the RFB rettfrabonden.com owner-portal PATTERN
// (magic link -> verified session -> owner-editable profile,
// src/routes/owner-portal.ts / src/database/init.ts's magic_links table) —
// it does NOT modify RFB's flow, and does NOT invent a new identity
// mechanism. The claim table (gardssalg_claims) is a vertical-scoped MIRROR
// of magic_links, living in experiences.db (see init-experiences.ts's doc
// comment on that table for why a shared/cross-DB table wasn't an option).
//
// ─── Core requirement: verified ownership BEFORE claim (Daniel, 2026-07-21) ──
// The claim link is sent ONLY to an email address that provably belongs to
// the organisation:
//   (a) the Brreg-registered contact email for that org_nr, or
//   (b) RETIRED 2026-08-06 — see "─── (b) RETIRED" section immediately below.
//   (c) the provider's OWN stored `epost`, when independently backed by
//       provenance — see "stored_epost_verified" below (dev-request
//       2026-07-30-opplevagent-claim-epost-og-perfelt-laas, item 1 only).
// If none exists, there is NO self-service claim path — only the manual
// fallback (Daniel verifies personally via kontakt@opplevagent.no).
//
// IMPORTANT, VERIFIED FINDING (read directly against the code, not assumed):
// path (a) is DORMANT in this codebase today. Brreg's Enhetsregisteret API —
// the ONLY Brreg integration this repo has (src/services/experience-brreg.ts,
// src/services/brreg-client.ts) — never returns a contact-email field for an
// "enhet" at all (see BrregEntity in experience-brreg.ts and RawBrregEntity in
// brreg-client.ts: organisasjonsnummer/navn/adresser/naeringskode/aktiv-flags
// only, no epost anywhere). experience_providers.epost is populated from
// homepage-crawl content or copied from an RFB producer's agent_knowledge
// .email (gardssalg-rfb-enrich.ts) — i.e. SCRAPED/imported data, not a
// Brreg-sourced, provably-org-linked address, so it is deliberately NOT used
// as a claim target. deriveOrgLinkedEmail() below still has a (currently
// always-empty) slot for a real Brreg contact email, so this dormant path
// activates for free the day a Brreg (or Frivillighetsregisteret/other
// authoritative) contact-email source is ever wired in — until then, every
// real claim in this codebase resolves via path (c), the only tier a
// provider without a live Brreg contact-email feed can ever qualify through.
//
// ─── (b) RETIRED 2026-08-06 — "never guess an email address" (Daniel, live
// policy decision; dev-request 2026-08-06-aldri-gjett-epostadresse) ─────────
// Tier (b) used to mint `post@<verified-domain>` — a WELL-KNOWN-CONVENTION
// GUESS, never an address anyone actually published or that this codebase
// ever fetched/read. Daniel's own words, verbatim from the raw quote in the
// dev-request: "Men jeg ønsker ikke at vi noen gang skal tippe eller gjette
// på en e-postadresse. [...] Vi kan søke og lete etter e-post adresse men
// skal aldri gjette på den, da er det bedre at vi ikke har e-postadresse i
// det hele tatt" — i.e. EMPTY IS BETTER THAN GUESSED. Measured live on
// 2026-08-06 across all 10 claim-qualified producers of that day: only 1 of
// 10 actually publishes `post@` on the domain this tier derived it from — 5
// publish a DIFFERENT address on the same domain, 3 publish on a different
// domain entirely, 1 has none. So the tier was wrong ~90% of the time, and a
// wrong guess here doesn't just mis-display data — it hands a real
// account-claim magic link to a stranger's mailbox (account takeover), which
// is exactly the harm Daniel banned. The block that constructed
// `post@${domain}` (guarded by isHjemmesideOwnershipVerified() +
// isClaimableDomain()) has been DELETED from deriveOrgLinkedEmailCandidates()
// below — not gated, not narrowed, removed outright, per Daniel's explicit
// instruction ("Fjern alle e-poster som vi har tippet på og laget selv").
// No code path anywhere in this repo may construct an email address from a
// domain, full stop; a test in gardssalg-claim.test.ts exists specifically to
// fail if this tier — or anything shaped like it — is ever reintroduced.
//
// What is intentionally KEPT despite the retirement, and why:
//   - `"verified_domain_address"` stays a valid member of the
//     OrgLinkedEmailResult/OrgLinkedEmailCandidate TypeScript unions below,
//     and a valid HISTORICAL value on old gardssalg_claims.email_source rows
//     issued before 2026-08-06 — those rows are a factual record of what was
//     sent, not something to rewrite. No NEW row can ever get this value from
//     here on; deriveOrgLinkedEmailCandidates() simply never produces it.
//   - isHjemmesideOwnershipVerified() (below) and isClaimableDomain() /
//     GENERIC_DOMAINS (gardssalg-rfb-enrich.ts) are NOT deleted, even though
//     nothing in this file calls them anymore after this retirement. Per
//     Daniel's own follow-up guidance ("Bruk epostadressene som du finner
//     under 'kontakt oss' eller 'om oss' [...] Dersom du finner epost med
//     samme domene er dette sikrest [...]"), a FUTURE found-address tier
//     (dev-request 2026-08-06-aldri-gjett-epostadresse, AC2-5 — a harvest of
//     contact-page addresses with cross-domain ambiguity resolution,
//     deliberately NOT built in this slice) will very plausibly want exactly
//     these two primitives: "is this hjemmeside domain the one we've actually
//     verified belongs to this producer" (to rank a found same-domain address
//     as the safest match, AC2 priority 1) and "is this domain a shared/
//     generic host" — but INVERTED (AC8): GENERIC_DOMAINS must keep blocking
//     a *derived* address forever (there is no live derivation left to
//     protect, but the primitive stays available), while a *found* free-mail
//     address (gmail/hotmail/outlook) on a producer's own contact page is
//     explicitly ALLOWED by Daniel, unlike a derived one. Deleting these
//     functions now would just mean reinventing them, less carefully, in that
//     future slice.
//
// Path (b)'s old "ownership-verified website domain" definition is preserved
// below purely as documentation for isHjemmesideOwnershipVerified()'s
// still-exported meaning (and for reading historical verified_domain_address
// rows) — it is not, as of this retirement, part of any live claim-
// eligibility decision in this file:
//   - content_source = 'manual' (Daniel personally entered/verified the row,
//     including its hjemmeside), OR
//   - field_provenance.hjemmeside.source_url is set — stamped ONLY by
//     applyGardssalgProviderWebsite() (experience-store.ts), which is called
//     ONLY from the two admin-approve endpoints
//     (POST /admin/gardssalg-website-review-approve,
//      POST /admin/listing-homepage-review-approve) after their queues'
//     evidence check (fetched page carries the provider's org_nr or exact
//     name + kommune/poststed) AND an explicit admin approval. This
//     provenance marker persists on the provider row even after the review-
//     queue entry itself is cleared on approval, so it's durably queryable
//     here.
// A raw/unvetted hjemmeside (content_source NULL/'provider_site', no
// field_provenance.hjemmeside) was never treated as verified either.
//
// Additional integrity gate (not literally required by anything above, but a
// deliberate, documented judgment call): EVERY claim path also requires
// brreg_verified = 1 (a confident, active Brreg match) as a baseline.
// "Provably belongs to the organisation" presupposes the organisation itself
// is confirmed real and active — a provider that isn't even Brreg-verified
// has no confirmed legal-entity identity to claim against, regardless of
// which email path would otherwise apply.
//
// ─── (c) stored_epost_verified — dev-request 2026-07-30-opplevagent-claim-
// epost-og-perfelt-laas, item 1 ONLY (items 2-4 of that request — admin
// claim-grant, per-field lock, CTA-hiding — are separate slices, not built
// here) ─────────────────────────────────────────────────────────────────
// experience_providers.epost is, by default, harvest/enrichment data
// (homepage-crawl content or copied from an RFB producer's
// agent_knowledge.email — gardssalg-rfb-enrich.ts) and therefore NOT
// trustworthy as a claim target on its own, same reasoning as path (b)'s
// "raw hjemmeside is not verified". It becomes eligible ONLY when backed by
// one of the THREE provenance sub-cases the dev-request names — measured
// against this codebase's REAL code/schema, not assumed:
//
//   (a-epost) Brreg-sourced contact email. SKIPPED — not built. Verified
//     (again, same finding as brregContactEmail above): neither Brreg
//     integration this repo has (experience-brreg.ts / brreg-client.ts) ever
//     returns a contact-email field, so there is no source and no
//     field_provenance marker for one could ever be genuine. Do not
//     fabricate a marker name for a source that doesn't exist.
//
//   (b-epost) Actually the recipient of a DELIVERED outreach send, no
//     bounce — see wasEpostDeliveredOutreachNoBounce() below. Real columns
//     (outreach_sent_log.recipient_email/.vertical_id, email_bounces.email),
//     but VERIFIED NARROW today, not broadly live: outreach_sent_log.agent_id
//     is NOT NULL, and its only live writers (init.ts's
//     trg_log_cold_outreach_to_sent_log_v2 / _on_send_confirm_v2 triggers on
//     crm_messages) resolve agent_id via
//     COALESCE(crm_contacts.agent_id, an agent_knowledge.email match).
//     crm_contacts.agent_id is ALWAYS NULL for an 'experiences'-vertical
//     contact (steg-6 vertical isolation — see crm-service.ts
//     resolveContact()'s own comment: "its agent_id is ALWAYS null now, by
//     trigger"), so these triggers only insert a row for a gårdssalg
//     producer's send when that producer's email COINCIDENTALLY also
//     matches an existing RFB agent_knowledge.email row (exactly the
//     contrivance crm-platform-identity.test.ts's pi17-22 fixture has to
//     manufacture to exercise the trigger at all — see that file). For a
//     genuine opplevagent-only producer — the actual target population this
//     slice exists for, e.g. a brewery with no RFB fruit/veg listing — there
//     is, as of this writing, NO live write path that records their
//     outreach send into outreach_sent_log at all. This is a real, verified
//     gap, not a guess. wasEpostDeliveredOutreachNoBounce() is still built
//     against the real schema (correct today for the coincidental-match
//     population) — it starts working for the FULL population for free the
//     day someone gives the outreach_sent_log trigger a provider_id-aware
//     branch (out of scope here: that trigger is shared production
//     infrastructure several other verticals depend on; a change to it
//     belongs in its own reviewed dev-request, not folded into this one).
//
//   (c-epost) Manually entered/approved by Daniel. REUSES
//     content_source==='manual' exactly as isHjemmesideOwnershipVerified()
//     below already does for hjemmeside: per this module's own existing,
//     already-trusted convention, a 'manual' row is Daniel's own data
//     end-to-end, not scraped — the same trust basis already extended to
//     hjemmeside is extended here to epost. No new marker, no new write
//     path. A DEDICATED field_provenance.epost admin marker (independent of
//     the whole-row 'manual' lock, mirroring hjemmeside's second,
//     non-manual field_provenance.hjemmeside.source_url path) does NOT exist
//     anywhere in this codebase today (verified — grepped every
//     field_provenance usage) — flagged as a real gap: this sub-case only
//     fires for fully-manual rows, not for an admin-approved-just-this-field
//     case on an otherwise-harvested row. Building that second path would
//     need a new write/approval endpoint, which is explicitly out of scope
//     for this slice.
//
// Ordering: stored_epost_verified is checked LAST, after (a) brreg_contact —
// (b) verified_domain_address is retired (see above) and no longer part of
// the ordering — and only ever applies when (a) doesn't already qualify — a
// lower-provenance tier must never override a stronger one that would also
// match.
//
// deriveOrgLinkedEmail() stays a PURE function (see its own doc comment) —
// the (b-epost) DB lookup is therefore NOT done inside it. The caller
// (issueClaimMagicLink, and the GET claim-entry route) runs
// wasEpostDeliveredOutreachNoBounce() itself and passes the boolean result
// in via `opts.epostOutreachDeliveredNoBounce`, mirroring exactly how
// brregContactEmail is already an explicit passed-in parameter above.

import crypto from "crypto";
import { v4 as uuid } from "uuid";
import { getDb } from "../database/db-factory";
import { getDb as getRfbDb } from "../database/init";
import { normalizeEmail } from "./blocklist-service";
import { GENERIC_DOMAINS } from "./gardssalg-rfb-enrich";

const VERTICAL = "experiences";

export const CLAIM_MAGIC_LINK_VALID_HOURS = 7 * 24; // 7 days — matches RFB
export const CLAIM_RATE_LIMIT_WINDOW_HOURS = 1;
export const CLAIM_RATE_LIMIT_MAX_PER_WINDOW = 3; // matches RFB

export const GARDSSALG_OWNER_SESSION_COOKIE = "oa_owner_session";

// Manual-fallback contact — Daniel verifies personally. Matches the existing
// opplevagent.no ToS convention ("Oppdater, fjern eller overta din oppføring
// via kontakt@opplevagent.no", src/routes/experiences-seo.ts) rather than
// RFB's kontakt@rettfrabonden.com — this is the opplevagent vertical.
export const CLAIM_MANUAL_FALLBACK_EMAIL = "kontakt@opplevagent.no";

// ── Provider row shape needed for claim-eligibility + the portal ──────────
export interface ClaimProviderRow {
  id: string;
  navn: string;
  slug: string | null;
  org_nr: string | null;
  brreg_verified: number | null;
  hjemmeside: string | null;
  content_source: string | null;
  field_provenance: string | null;
  about_text: string | null;
  visit_text: string | null;
  opening_hours_text: string | null;
  products: string | null;
  booking_live: number | null;
  epost: string | null;
}

const CLAIM_PROVIDER_COLUMNS =
  "id, navn, slug, org_nr, brreg_verified, hjemmeside, content_source, field_provenance, about_text, visit_text, opening_hours_text, products, booking_live, epost";

export function getClaimProviderById(providerId: string): ClaimProviderRow | null {
  const db = getDb(VERTICAL);
  const row = db
    .prepare(`SELECT ${CLAIM_PROVIDER_COLUMNS} FROM experience_providers WHERE id = ?`)
    .get(providerId) as ClaimProviderRow | undefined;
  return row ?? null;
}

export function getClaimProviderBySlug(slug: string): ClaimProviderRow | null {
  if (!slug) return null;
  const db = getDb(VERTICAL);
  const row = db
    .prepare(`SELECT ${CLAIM_PROVIDER_COLUMNS} FROM experience_providers WHERE slug = ?`)
    .get(slug) as ClaimProviderRow | undefined;
  return row ?? null;
}

// ── Ownership-verified-domain check (see module doc above) ───────────────
// NOT CALLED from any live code path in this file since the 2026-08-06
// retirement of tier (b) — see the module doc's "RETIRED" section for why
// this function is nonetheless kept, exported, and documented rather than
// deleted (historical-row context + plausible reuse by a future found-
// address tier).
// KNOWN GAP (security review, 2026-07-24, non-blocking): content_source ===
// 'manual' is treated here as a PERMANENT "hjemmeside forever verified" flag.
// But PATCH /admin/providers/:id/hjemmeside (src/routes/opplevelser.ts,
// writeProviderHjemmeside) can change hjemmeside on a content_source='manual'
// row WITHOUT touching content_source or field_provenance — so a manual row's
// CURRENT hjemmeside is never re-checked against the ORIGINAL evidence that
// earned the 'manual' trust when a later claim is issued. Lower severity
// (that route is admin-gated — only Daniel can trigger it), but it's a
// stale-trust gap in the "provably belongs to the org" invariant. Not fixed
// here: a real fix needs a design decision (e.g. stamp a re-verification
// timestamp/hash on hjemmeside change via that route, or stop treating bare
// content_source='manual' as sufficient without a corroborating
// field_provenance check) that's bigger than this fix-up's scope — flag for
// a future dev-request rather than guessing at it here.
export function isHjemmesideOwnershipVerified(row: Pick<ClaimProviderRow, "content_source" | "field_provenance">): boolean {
  if (row.content_source === "manual") return true;
  if (!row.field_provenance) return false;
  try {
    const parsed = JSON.parse(row.field_provenance);
    return !!(
      parsed &&
      typeof parsed === "object" &&
      parsed.hjemmeside &&
      typeof parsed.hjemmeside === "object" &&
      typeof parsed.hjemmeside.source_url === "string" &&
      parsed.hjemmeside.source_url.trim().length > 0
    );
  } catch {
    return false;
  }
}

// ── Generic/shared-domain check ───────────────────────────────────────────
// NOT CALLED from any live code path in this file (or anywhere else in this
// repo) since the 2026-08-06 retirement of tier (b) — there is no longer a
// domain-derivation mint for this to guard. Kept, exported, and documented
// per the module doc's "RETIRED" section: Daniel's own guidance for the
// future found-address tier explicitly wants this SAME generic-domain list,
// just inverted (block a *derived* address forever; allow a *found* free-
// mail address like gmail/hotmail when it's actually published on the
// producer's own site) — see dev-request 2026-08-06-aldri-gjett-epostadresse,
// AC8. The logic below predates the retirement and is left exactly as it was
// validated then (security review, 2026-07-24, fix-up iteration 2):
// STRICTER than gardssalg-rfb-enrich.ts's isMatchableDomain(), which is
// exact-Set-membership only. That's appropriate for its own use (a source
// with a colliding/generic domain just falls out of the enrichment index,
// with a separate collision-safety net besides — see that file's doc), but
// NOT strict enough for a one-shot, high-trust email decision: exact-match
// alone lets "mail.gmail.com" or "sub.facebook.com" (a subdomain of a listed
// generic host) or "gmail.com." (a trailing-FQDN-dot-padded generic host,
// which normalizeDomain does not strip) sail through as "not generic".
// Reads the SAME GENERIC_DOMAINS list (exported from gardssalg-rfb-enrich.ts)
// rather than hand-maintaining a second copy; only the matching rule here is
// stricter (suffix-aware + trailing-dot-safe), not the underlying data.
export function isClaimableDomain(domain: string): boolean {
  if (!domain) return false;
  const d = domain.replace(/\.+$/, ""); // strip trailing FQDN dot(s), e.g. "gmail.com." -> "gmail.com"
  if (!d || !d.includes(".")) return false; // bare host, not a real domain
  for (const generic of GENERIC_DOMAINS) {
    if (d === generic || d.endsWith("." + generic)) return false; // exact OR any subdomain of a generic host
  }
  return true;
}

export type OrgLinkedEmailResult =
  | { eligible: true; email: string; source: "brreg_contact" | "verified_domain_address" | "stored_epost_verified" }
  | { eligible: false; reason: "not_brreg_verified" | "no_org_linked_email" };

export type OrgLinkedEmailCandidate = {
  email: string;
  source: "brreg_contact" | "verified_domain_address" | "stored_epost_verified";
};

// Minimal shape check for a stored `epost` candidate — good enough to catch
// scraped garbage/truncated fragments before they're offered as a claim
// target, NOT full RFC validation (real deliverability is proven at
// claim-time by the magic-link actually being clicked, same as every other
// tier here).
function isPlausibleEmailShape(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

// Test-only: lets a test point wasEpostDeliveredOutreachNoBounce() at its own
// standalone RFB-shaped db WITHOUT touching src/database/init.ts's shared
// module-level singleton via __setDbForTesting. Deliberately narrower than
// that seam: swapping the GLOBAL singleton is process-wide and this test
// suite (tests/test.ts) chains together dozens of suites with fragile,
// hand-maintained cross-dependencies specifically to avoid two suites
// swapping that singleton at once (see the file's own repeated postmortem
// comments on this exact failure class — "the exact failure mode this
// file's own tasks-prune-async postmortem documents"). Adding a NEW global
// singleton swap here reproduced it live (oa-home-counters intermittently
// saw "no such table: outreach_sent_log" when this test ran). This override
// avoids the shared singleton entirely, so it cannot race with unrelated
// suites. Never call from production code.
let _rfbDbOverrideForTesting: ReturnType<typeof getRfbDb> | null = null;
export function __setRfbDbForTesting(db: ReturnType<typeof getRfbDb> | null): void {
  _rfbDbOverrideForTesting = db;
}

/**
 * (b-epost) — see module doc "stored_epost_verified" section for the full,
 * verified explanation of why this is real-but-narrow today. Does the
 * cross-DB lookup deriveOrgLinkedEmail() itself is not allowed to do (it
 * must stay pure): outreach_sent_log and email_bounces both live in the RFB
 * main DB (lokal.db), NOT experiences.db — getDb() here is the RFB handle
 * (src/database/init.ts), imported directly the same way bounce-service.ts
 * already does, NOT the per-vertical db-factory getDb("experiences").
 *
 * True iff `email` (case/whitespace-normalized via blocklist-service's
 * normalizeEmail — the SAME normalization convention outreach_sent_log's own
 * suppression matching and bounce-service use, reused here rather than
 * reimplemented) appears in outreach_sent_log.recipient_email with
 * vertical_id='experiences' (an Opplevagent send, not an RFB one) AND does
 * NOT appear in email_bounces — i.e. it was actually delivered outreach,
 * not merely attempted.
 */
export function wasEpostDeliveredOutreachNoBounce(email: string | null | undefined): boolean {
  const normalized = normalizeEmail(email);
  if (!normalized) return false;

  const db = _rfbDbOverrideForTesting ?? getRfbDb();
  const sentRow = db
    .prepare(
      `SELECT 1 FROM outreach_sent_log
       WHERE LOWER(TRIM(recipient_email)) = ? AND vertical_id = 'experiences'
       LIMIT 1`,
    )
    .get(normalized);
  if (!sentRow) return false;

  const bouncedRow = db.prepare(`SELECT 1 FROM email_bounces WHERE LOWER(TRIM(email)) = ? LIMIT 1`).get(normalized);
  return !bouncedRow;
}

/**
 * Derive the ONE email address a claim magic-link may be sent to, or
 * "not eligible" (-> manual fallback, never self-service). Pure function —
 * no DB/IO — so the decision logic is fully unit-testable without a fixture
 * database. See module doc for the full rationale of both live branches
 * ((a) brreg_contact, (c) stored_epost_verified) and of (b)'s 2026-08-06
 * retirement.
 *
 * brregContactEmail is an explicit, separate parameter (not read off the
 * provider row) because no such column/source exists yet anywhere in this
 * codebase (see module doc) — always undefined/null in production today.
 * The parameter exists so this function is ready the day a real source
 * shows up, without a signature change and without ever fabricating a value
 * meanwhile.
 *
 * opts.epostOutreachDeliveredNoBounce is the SAME pattern for (b-epost): the
 * caller runs wasEpostDeliveredOutreachNoBounce() (a real DB lookup) and
 * passes the boolean result in here, so this function itself never touches
 * a database. `epost` on `provider` is typed optional (rather than widening
 * the Pick below) so existing callers/fixtures that construct a provider
 * object without it keep compiling unchanged — omitted is treated as null.
 */
/**
 * The tiers deriveOrgLinkedEmail() checks — (a) Brreg contact, (c)
 * provenance-backed stored epost; (b) post@<verified-domain> RETIRED
 * 2026-08-06, see module doc — but returns EVERY tier that qualifies instead
 * of stopping at the first. dev-request 2026-08-06-claim-produsent-velger-
 * mottakeradresse: lets a producer with more than one qualified address
 * choose which one the magic link goes to, rather than the fleet silently
 * picking one tier over another. Introduces NO new qualification path — a
 * candidate appears here iff it would already have been eligible under the
 * single-result function below. Order is stable (a, then c) but is NOT a
 * ranking once there is more than one candidate — see deriveOrgLinkedEmail(),
 * which still takes the first as its single answer for every existing
 * caller. Same purity contract: no DB/IO.
 */
export function deriveOrgLinkedEmailCandidates(
  provider: Pick<ClaimProviderRow, "org_nr" | "brreg_verified" | "hjemmeside" | "content_source" | "field_provenance"> & {
    epost?: string | null;
  },
  brregContactEmail?: string | null,
  opts: { epostOutreachDeliveredNoBounce?: boolean } = {},
): OrgLinkedEmailCandidate[] {
  const brregOk = !!provider.org_nr && provider.brreg_verified === 1;
  if (!brregOk) return [];

  const candidates: OrgLinkedEmailCandidate[] = [];

  // (a) Brreg-registered contact email — dormant today (see module doc).
  const contact = (brregContactEmail || "").trim().toLowerCase();
  if (contact && contact.includes("@")) {
    candidates.push({ email: contact, source: "brreg_contact" });
  }

  // (b) RETIRED 2026-08-06 (dev-request 2026-08-06-aldri-gjett-epostadresse)
  // — used to mint post@<ownership-verified-domain> here. DELETED, not
  // gated/narrowed: Daniel's explicit instruction was to never construct an
  // email address from a domain, ever, anywhere in this codebase. See the
  // module doc's "RETIRED" section for the full rationale (measured ~90%
  // wrong-address rate, account-takeover risk, Daniel's own "empty is better
  // than guessed" quote) and for why isHjemmesideOwnershipVerified() /
  // isClaimableDomain() are nonetheless still exported above, unused by this
  // function, for a plausible future found-address tier to reuse.

  // (c) stored_epost_verified — the provider's OWN `epost`, but ONLY when
  // backed by real provenance (see module doc's "stored_epost_verified"
  // section for the full (a-epost)/(b-epost)/(c-epost) breakdown). A
  // scraped-only epost with neither signal is never added, same as today —
  // this is Acceptance Criterion 2 from the dev-request.
  const epostCandidate = normalizeEmail(provider.epost);
  if (epostCandidate && isPlausibleEmailShape(epostCandidate)) {
    const adminEntered = provider.content_source === "manual"; // (c-epost)
    const outreachDelivered = opts.epostOutreachDeliveredNoBounce === true; // (b-epost)
    if (adminEntered || outreachDelivered) {
      candidates.push({ email: epostCandidate, source: "stored_epost_verified" });
    }
  }

  return candidates;
}

/**
 * Single-answer form, kept for every existing caller (route/report code
 * that only ever expected one address) — now a thin wrapper over
 * deriveOrgLinkedEmailCandidates(), taking the first qualifying tier.
 * Behavior for a provider with 0 or 1 qualifying candidates is byte-for-
 * byte unchanged from before this dev-request.
 */
export function deriveOrgLinkedEmail(
  provider: Pick<ClaimProviderRow, "org_nr" | "brreg_verified" | "hjemmeside" | "content_source" | "field_provenance"> & {
    epost?: string | null;
  },
  brregContactEmail?: string | null,
  opts: { epostOutreachDeliveredNoBounce?: boolean } = {},
): OrgLinkedEmailResult {
  const brregOk = !!provider.org_nr && provider.brreg_verified === 1;
  if (!brregOk) return { eligible: false, reason: "not_brreg_verified" };

  const [first] = deriveOrgLinkedEmailCandidates(provider, brregContactEmail, opts);
  if (!first) return { eligible: false, reason: "no_org_linked_email" };
  return { eligible: true, email: first.email, source: first.source };
}

/**
 * Call-site wrapper around deriveOrgLinkedEmail() that runs the (b-epost)
 * cross-DB lookup (wasEpostDeliveredOutreachNoBounce) LAZILY — only when it
 * could actually change the outcome — instead of unconditionally on every
 * provider that merely HAS an epost value.
 *
 * This matters beyond efficiency: an early version called the lookup
 * unconditionally whenever `provider.epost` was truthy, which meant EVERY
 * existing caller of issueClaimMagicLink() for a provider with a stored
 * epost now paid for an RFB-DB round trip even when brreg_contact or
 * verified_domain_address (or content_source='manual', which
 * deriveOrgLinkedEmail() itself already resolves without any opts) already
 * settled eligibility. In production that is just a wasted query; in this
 * codebase's test suite it was a real regression — a fixture provider with
 * an epost value, claimed via an explicit brregContactEmail argument
 * (tier a, already eligible), started requiring an RFB db with
 * outreach_sent_log/email_bounces present even though that tier never
 * needed them (caught by the full `npm test` run breaking an unrelated
 * suite, opplevelser-booking-send-guard.test.ts's `prov-live` fixture — see
 * that file's own issueClaimMagicLink() calls).
 *
 * The DB lookup now runs ONLY when: the provider is Brreg-verified (else
 * nothing could rescue it anyway), no stronger tier already resolved it, and
 * there IS an epost value to check at all.
 */
export function deriveOrgLinkedEmailWithOutreachLookup(
  provider: Pick<ClaimProviderRow, "org_nr" | "brreg_verified" | "hjemmeside" | "content_source" | "field_provenance"> & {
    epost?: string | null;
  },
  brregContactEmail?: string | null,
): OrgLinkedEmailResult {
  const preliminary = deriveOrgLinkedEmail(provider, brregContactEmail);
  if (preliminary.eligible) return preliminary;
  if (preliminary.reason !== "no_org_linked_email" || !provider.epost) return preliminary;

  const epostOutreachDeliveredNoBounce = wasEpostDeliveredOutreachNoBounce(provider.epost);
  if (!epostOutreachDeliveredNoBounce) return preliminary;

  return deriveOrgLinkedEmail(provider, brregContactEmail, { epostOutreachDeliveredNoBounce: true });
}

/**
 * Candidates form of deriveOrgLinkedEmailWithOutreachLookup() — same lazy
 * DB-lookup discipline (the RFB cross-DB outreach/bounce check only runs
 * when it could actually add a candidate that isn't there already), used by
 * the entry page (to render the choice) and issueClaimMagicLink() (to
 * validate a producer's choice) so both always see the exact same list.
 */
export function deriveOrgLinkedEmailCandidatesWithOutreachLookup(
  provider: Pick<ClaimProviderRow, "org_nr" | "brreg_verified" | "hjemmeside" | "content_source" | "field_provenance"> & {
    epost?: string | null;
  },
  brregContactEmail?: string | null,
): OrgLinkedEmailCandidate[] {
  const withoutOutreach = deriveOrgLinkedEmailCandidates(provider, brregContactEmail);
  const alreadyHasEpostCandidate = withoutOutreach.some((c) => c.source === "stored_epost_verified");
  if (alreadyHasEpostCandidate || !provider.epost) return withoutOutreach;

  const brregOk = !!provider.org_nr && provider.brreg_verified === 1;
  if (!brregOk) return withoutOutreach;

  const epostOutreachDeliveredNoBounce = wasEpostDeliveredOutreachNoBounce(provider.epost);
  if (!epostOutreachDeliveredNoBounce) return withoutOutreach;

  return deriveOrgLinkedEmailCandidates(provider, brregContactEmail, { epostOutreachDeliveredNoBounce: true });
}

/** Mask an email for display ("we sent it to p***t@b*******t.no") — never
 * reveal the full address on the unauthenticated entry page. */
export function maskEmail(email: string): string {
  const at = email.indexOf("@");
  if (at <= 0 || at === email.length - 1) return "•••";
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);

  const maskPart = (s: string, keepEnd: boolean): string => {
    if (s.length <= 1) return s + "*";
    if (s.length === 2) return keepEnd ? s[0] + "*" : s[0] + "*";
    const stars = "*".repeat(Math.min(s.length - 2, 6));
    return keepEnd ? `${s[0]}${stars}${s[s.length - 1]}` : `${s[0]}${stars}`;
  };

  const dotIdx = domain.lastIndexOf(".");
  let maskedDomain: string;
  if (dotIdx > 0) {
    const name = domain.slice(0, dotIdx);
    const tld = domain.slice(dotIdx); // includes leading "."
    maskedDomain = `${maskPart(name, false)}${tld}`;
  } else {
    maskedDomain = maskPart(domain, false);
  }

  return `${maskPart(local, true)}@${maskedDomain}`;
}

// ── Rate limiting ─────────────────────────────────────────────────────────
// created_at is stored as an ISO-8601 string (now.toISOString(), e.g.
// "2026-08-06T13:20:00.000Z" — see issueClaimMagicLink below), while
// datetime('now', ...) produces SQLite's own native format (e.g.
// "2026-08-06 16:41:17", space separator, no milliseconds/Z). Both columns
// are TEXT, so comparing created_at directly against datetime('now', ...)
// is a plain string comparison: the date prefixes match but 'T' (0x54) >
// ' ' (0x20), so EVERY claim from the current UTC calendar day sorted as
// ">= now - 1h" regardless of actual time — the rate limit degraded to "3
// per UTC day" instead of "3 per rolling hour". Wrapping created_at in
// datetime() too routes BOTH sides through SQLite's own date normalization
// (verified empirically against both the legacy ISO-with-milliseconds-and-
// Z format already in the table and SQLite's native format — no data
// migration needed, old rows are handled correctly as-is).
export function isClaimRateLimited(providerId: string): boolean {
  const db = getDb(VERTICAL);
  const row = db
    .prepare(
      `SELECT COUNT(*) as count FROM gardssalg_claims
       WHERE provider_id = ? AND datetime(created_at) >= datetime('now', '-' || ? || ' hours')`,
    )
    .get(providerId, CLAIM_RATE_LIMIT_WINDOW_HOURS) as { count: number };
  return row.count >= CLAIM_RATE_LIMIT_MAX_PER_WINDOW;
}

// ── Claimed-status check (dev-request 2026-07-30-opplevagent-claim-epost-
// og-perfelt-laas, item 4 — "CTA hide"). Mirrors
// knowledgeService.isAgentClaimed() (src/services/knowledge-service.ts)
// exactly: a plain COUNT(*) live query, no caching. A provider is
// "claimed" once a gardssalg_claims row for it has been used (the magic
// link was clicked — see verifyClaimToken above) AND not since revoked.
// Deliberately a live query (not a cached flag anywhere persistent) so a
// later revoke (revokeClaimToken above) makes the provider un-claimed again
// on the very next read, no invalidation step needed. ─────────────────────
export function isGardssalgProviderClaimed(providerId: string): boolean {
  const db = getDb(VERTICAL);
  const row = db
    .prepare(`SELECT COUNT(*) as c FROM gardssalg_claims WHERE provider_id = ? AND used = 1 AND revoked_at IS NULL`)
    .get(providerId) as { c: number };
  return row.c > 0;
}

// ── Issue a claim magic link (DB insert only — sending the email is the
// route layer's job, via email-service.ts, mirroring RFB's split) ─────────
export interface IssuedClaim {
  claimId: string;
  token: string;
  email: string;
  maskedEmail: string;
  source: "brreg_contact" | "verified_domain_address" | "stored_epost_verified";
  expiresAt: string;
  /** dev-request 2026-07-26-booking-test-send-guard — see issueClaimMagicLink. */
  isTest: boolean;
}

export type IssueClaimResult =
  | { ok: true; claim: IssuedClaim }
  | {
      ok: false;
      error:
        | "provider_not_found"
        | "not_brreg_verified"
        | "no_org_linked_email"
        | "rate_limited"
        // dev-request 2026-08-06-claim-produsent-velger-mottakeradresse:
        // "invalid_selection" — opts.selectedSource was given but does not
        // match any of THIS provider's own current candidates (a stale
        // choice, or an attempt to request a source that was never offered
        // — the server never trusts the client's chosen VALUE, only which
        // of its own re-derived candidates was picked, so this is the only
        // way a bad selection can surface, never a wrong email). "selection_
        // required" — more than one candidate qualifies and no selection was
        // given (the entry page always offers one when there's more than
        // one; this only fires against a client that skipped the UI).
        | "invalid_selection"
        | "selection_required";
    };

// `opts.isTest` (dev-request 2026-07-26-booking-test-send-guard) marks the
// claim as a deliberate end-to-end test so the route layer redirects its
// magic-link email to TEST_SEND_REDIRECT_EMAIL instead of the derived
// org-linked address. A THIRD ARGUMENT on purpose, not part of any request
// body the public POST route parses — that route calls this with one
// argument, so no public caller can reach it.
//
// `opts.selectedSource` (2026-08-06-claim-produsent-velger-mottakeradresse):
// which of the producer's own qualified candidates to send to, when there is
// more than one. Deliberately a SOURCE TAG, never an email address — the
// caller (route layer) never has a raw address to pass in the first place,
// since the entry page only ever shows masked addresses. The source tag is
// re-validated here against a FRESH deriveOrgLinkedEmailCandidatesWithOutreachLookup()
// call, not trusted as-is, so a caller can never steer a link to any address
// beyond this provider's own already-qualified set.
export function issueClaimMagicLink(
  providerId: string,
  brregContactEmail?: string | null,
  opts: { isTest?: boolean; selectedSource?: OrgLinkedEmailCandidate["source"] } = {},
): IssueClaimResult {
  const provider = getClaimProviderById(providerId);
  if (!provider) return { ok: false, error: "provider_not_found" };

  const brregOk = !!provider.org_nr && provider.brreg_verified === 1;
  if (!brregOk) return { ok: false, error: "not_brreg_verified" };

  const candidates = deriveOrgLinkedEmailCandidatesWithOutreachLookup(provider, brregContactEmail);
  if (candidates.length === 0) return { ok: false, error: "no_org_linked_email" };

  let chosen: OrgLinkedEmailCandidate;
  if (opts.selectedSource) {
    const match = candidates.find((c) => c.source === opts.selectedSource);
    if (!match) return { ok: false, error: "invalid_selection" };
    chosen = match;
  } else if (candidates.length === 1) {
    chosen = candidates[0];
  } else {
    return { ok: false, error: "selection_required" };
  }

  if (isClaimRateLimited(providerId)) return { ok: false, error: "rate_limited" };

  const db = getDb(VERTICAL);
  const token = crypto.randomBytes(32).toString("hex");
  const now = new Date();
  const expiresAt = new Date(now.getTime() + CLAIM_MAGIC_LINK_VALID_HOURS * 60 * 60 * 1000);
  const claimId = `gsc_${crypto.randomBytes(8).toString("hex")}`;
  const isTest = opts.isTest === true ? 1 : 0;

  db.prepare(
    `INSERT INTO gardssalg_claims (id, provider_id, email, email_source, token, used, created_at, expires_at, is_test)
     VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)`,
  ).run(claimId, providerId, chosen.email, chosen.source, token, now.toISOString(), expiresAt.toISOString(), isTest);

  return {
    ok: true,
    claim: {
      claimId,
      token,
      email: chosen.email,
      maskedEmail: maskEmail(chosen.email),
      source: chosen.source,
      expiresAt: expiresAt.toISOString(),
      isTest: isTest === 1,
    },
  };
}

// ── Verify a magic-link token -> mark used, stamp the claim lock ─────────
export interface VerifyClaimResult {
  valid: boolean;
  providerId?: string;
  token?: string;
}

/**
 * Marks the token used and — the acceptance-critical write — sets
 * experience_providers.content_source = 'claim' so every enrichment/
 * retro-scan write-path (which already gates on content_source IN
 * ('manual','claim'), verified across experience-store.ts /
 * gardssalg-rfb-enrich.ts) skips this row from here on. Never downgrades an
 * existing 'manual' lock (Daniel's own curation takes precedence) — the
 * session is still granted either way, only the lock label is left alone.
 *
 * Also stamps experience_providers.claimed_at (dev-request 2026-08-03-claim-
 * bekreftet-merke-og-innlogging) — the historical "has been claimed at least
 * once" signal behind the public "Bekreftet av eier" badge. Idempotent:
 * first-claim wins, a second/later verify (re-login, or a second producer
 * link on the same provider) never overwrites an existing claimed_at. This is
 * the ONLY place claimed_at is ever set — never on issue/send, only on use —
 * and revokeClaimToken() below deliberately never touches it.
 */
export function verifyClaimToken(token: string): VerifyClaimResult {
  const db = getDb(VERTICAL);
  const claim = db
    .prepare(
      `SELECT id, provider_id, token FROM gardssalg_claims
       WHERE token = ? AND expires_at > datetime('now') AND revoked_at IS NULL`,
    )
    .get(token) as { id: string; provider_id: string; token: string } | undefined;

  if (!claim) return { valid: false };

  const txn = db.transaction(() => {
    db.prepare(`UPDATE gardssalg_claims SET used = 1, used_at = datetime('now') WHERE id = ?`).run(claim.id);
    db.prepare(
      `UPDATE experience_providers SET content_source = 'claim', updated_at = datetime('now')
       WHERE id = ? AND (content_source IS NULL OR content_source NOT IN ('manual', 'claim'))`,
    ).run(claim.provider_id);
    db.prepare(
      `UPDATE experience_providers SET claimed_at = datetime('now')
       WHERE id = ? AND claimed_at IS NULL`,
    ).run(claim.provider_id);
  });
  txn();

  return { valid: true, providerId: claim.provider_id, token: claim.token };
}

// ── Session verification (cookie or Bearer, mirrors RFB's
// verifyOwnerSession) ─────────────────────────────────────────────────────
export interface OwnerSession {
  valid: boolean;
  providerId?: string;
  token?: string;
}

export function verifyGardssalgOwnerSessionToken(token: string | undefined | null): OwnerSession {
  if (!token) return { valid: false };
  const db = getDb(VERTICAL);
  const claim = db
    .prepare(
      `SELECT provider_id FROM gardssalg_claims
       WHERE token = ? AND used = 1 AND expires_at > datetime('now') AND revoked_at IS NULL`,
    )
    .get(token) as { provider_id: string } | undefined;
  if (!claim) return { valid: false };
  return { valid: true, providerId: claim.provider_id, token };
}

/** GDPR-minimum revoke: invalidates the session/token immediately (unlike
 * RFB's logout, which only clears the cookie — see init-experiences.ts's
 * doc comment on gardssalg_claims.revoked_at for why this is an intentional,
 * additive improvement scoped to THIS flow only). */
export function revokeClaimToken(token: string): void {
  if (!token) return;
  const db = getDb(VERTICAL);
  db.prepare(`UPDATE gardssalg_claims SET revoked_at = datetime('now') WHERE token = ? AND revoked_at IS NULL`).run(token);
}

// ── Owner profile update (session-authenticated writes) ──────────────────
export const CLAIM_EDITABLE_FIELDS = [
  "about_text",
  "visit_text",
  "opening_hours_text",
  "products",
  "hjemmeside",
  "booking_live",
] as const;
export type ClaimEditableField = (typeof CLAIM_EDITABLE_FIELDS)[number];

const TEXT_FIELD_MAX_LEN: Record<string, number> = {
  about_text: 2000,
  visit_text: 2000,
  opening_hours_text: 500,
};
const MAX_PRODUCTS = 50;
const MAX_PRODUCT_NAME_LEN = 100;

function sanitizeTextField(field: string, value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== "string") return undefined; // reject wrong type — caller skips
  const trimmed = value.trim();
  const max = TEXT_FIELD_MAX_LEN[field] ?? 2000;
  return trimmed.slice(0, max);
}

function sanitizeProducts(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of value) {
    if (typeof raw !== "string") continue;
    const t = raw.trim().slice(0, MAX_PRODUCT_NAME_LEN);
    if (!t) continue;
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
    if (out.length >= MAX_PRODUCTS) break;
  }
  return JSON.stringify(out);
}

function sanitizeWebsite(value: unknown): string | null | undefined {
  if (value === null || value === "") return null;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!/^https?:\/\/\S+\.\S+/i.test(trimmed) || trimmed.length > 2048) return undefined;
  return trimmed;
}

function sanitizeBookingLive(value: unknown): number | undefined {
  if (value === true || value === 1 || value === "1" || value === "true") return 1;
  if (value === false || value === 0 || value === "0" || value === "false") return 0;
  return undefined;
}

export interface UpdateProfileOutcome {
  ok: true;
  updatedFields: string[];
  skippedFields: Array<{ field: string; reason: string }>;
}

/**
 * Owner (session-authenticated) profile write. Unlike the auto-enrichment
 * write-paths in experience-store.ts (fill-only, gated on content_source NOT
 * IN ('manual','claim')), the OWNER is allowed to REPLACE any of their own
 * whitelisted fields freely — that's the entire point of the claim. The only
 * thing that still blocks a write is content_source = 'manual': a row Daniel
 * personally curated takes precedence over the claiming owner, mirroring
 * RFB's "locked_by_X, X != owner" rule in owner-portal.ts (skipped, not
 * silently dropped — same response shape: {field, reason}).
 */
export function updateClaimedProviderProfile(
  providerId: string,
  body: Record<string, unknown>,
): UpdateProfileOutcome | { ok: false; error: "provider_not_found" } {
  const db = getDb(VERTICAL);
  const row = db
    .prepare(`SELECT id, content_source FROM experience_providers WHERE id = ?`)
    .get(providerId) as { id: string; content_source: string | null } | undefined;
  if (!row) return { ok: false, error: "provider_not_found" };

  const locked = row.content_source === "manual";

  const sets: string[] = [];
  const params: Record<string, unknown> = { id: providerId };
  const updatedFields: string[] = [];
  const skippedFields: Array<{ field: string; reason: string }> = [];

  for (const field of CLAIM_EDITABLE_FIELDS) {
    if (!(field in body)) continue;
    if (locked) {
      skippedFields.push({ field, reason: "locked_by_manual" });
      continue;
    }
    let sanitized: unknown;
    if (field === "products") sanitized = sanitizeProducts(body[field]);
    else if (field === "hjemmeside") sanitized = sanitizeWebsite(body[field]);
    else if (field === "booking_live") sanitized = sanitizeBookingLive(body[field]);
    else sanitized = sanitizeTextField(field, body[field]);

    if (sanitized === undefined) {
      skippedFields.push({ field, reason: "invalid_value" });
      continue;
    }
    sets.push(`${field} = @${field}`);
    params[field] = sanitized;
    updatedFields.push(field);
  }

  if (sets.length > 0) {
    const txn = db.transaction(() => {
      db.prepare(
        `UPDATE experience_providers SET ${sets.join(", ")}, updated_at = datetime('now') WHERE id = @id`,
      ).run(params);
      // Audit trail — reuses gardssalg_content_audit (same shape RFB's
      // agent_knowledge_audit serves for owner-portal.ts), changed_by='owner'.
      // booking_live is a producer-consent toggle, not "content" — audited
      // too (same table, batch_id marks the source) for a complete change
      // history, but never blocked by the content_source lock above.
      for (const field of updatedFields) {
        db.prepare(
          `INSERT INTO gardssalg_content_audit (id, provider_id, field_name, old_value, new_value, source_url, batch_id, changed_by, changed_at)
           VALUES (?, ?, ?, NULL, ?, NULL, 'owner-portal', 'owner', datetime('now'))`,
        ).run(uuid(), providerId, field, String(params[field]));
      }

      // ── Owner-lock provenance stamp (dev-request 2026-07-30-opplevagent-
      // claim-epost-og-perfelt-laas, item 3 — purely additive metadata, NO
      // gate/behavior change: the row-level content_source lock above is
      // untouched, this only records WHICH fields the owner personally
      // edited and WHEN). Nested under field_provenance.owner_locks.<field>
      // — deliberately NOT a bare top-level field_provenance.<field> key,
      // because field_provenance already uses bare field names for a
      // DIFFERENT shape (e.g. field_provenance.hjemmeside =
      // {source_url, fetched_at}, written by applyGardssalgProviderWebsite
      // in experience-store.ts; field_provenance.hjemmeside_verification,
      // written by gardssalg-website-verification.ts). Stamping a bare key
      // here would silently clobber those. Same defensive read-parse-merge-
      // write recipe as applyGardssalgWebsiteVerification (gardssalg-
      // website-verification.ts), inside this SAME transaction (no second
      // txn) so the profile write and the provenance stamp commit atomically.
      const provRow = db
        .prepare(`SELECT field_provenance FROM experience_providers WHERE id = ?`)
        .get(providerId) as { field_provenance: string | null } | undefined;
      let provenance: Record<string, unknown> = {};
      if (provRow?.field_provenance) {
        try {
          const parsed = JSON.parse(provRow.field_provenance);
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            provenance = parsed as Record<string, unknown>;
          }
        } catch {
          /* malformed existing JSON -> treat as empty rather than clobber the write */
        }
      }
      const existingOwnerLocks = provenance.owner_locks;
      const ownerLocks: Record<string, unknown> =
        existingOwnerLocks && typeof existingOwnerLocks === "object" && !Array.isArray(existingOwnerLocks)
          ? { ...(existingOwnerLocks as Record<string, unknown>) }
          : {};
      const lockedAt = new Date().toISOString();
      for (const field of updatedFields) {
        ownerLocks[field] = { locked_at: lockedAt };
      }
      provenance.owner_locks = ownerLocks;
      db.prepare(`UPDATE experience_providers SET field_provenance = @field_provenance WHERE id = @id`).run({
        id: providerId,
        field_provenance: JSON.stringify(provenance),
      });
    });
    txn();
  }

  return { ok: true, updatedFields, skippedFields };
}

// ─── One-time backfill: owner_locks provenance for pre-existing claim edits ──
// dev-request 2026-07-30-opplevagent-claim-epost-og-perfelt-laas, item 3.
// updateClaimedProviderProfile (above) only stamps field_provenance.
// owner_locks.<field> going FORWARD, on each new owner edit — this backfills
// field_provenance.owner_locks for owner edits that already happened before
// that stamping existed, sourced from the existing gardssalg_content_audit
// trail (changed_by='owner' rows), which is the only historical record of
// which fields an owner actually changed. Idempotent: a field whose
// owner_locks entry is already present (whether from a prior backfill run OR
// from updateClaimedProviderProfile's own forward-stamping) is left
// untouched and counted separately — re-running this after all rows are
// already stamped is a true no-op (zero writes).
export interface OwnerLockBackfillResult {
  scanned: number;
  stamped: number;
  already_stamped: number;
  skipped_missing_provider: number;
}

export function backfillGardssalgOwnerLockProvenance(apply: boolean): OwnerLockBackfillResult {
  const db = getDb(VERTICAL);
  const rows = db
    .prepare(
      `SELECT provider_id, field_name, MAX(changed_at) AS latest_changed_at
       FROM gardssalg_content_audit
       WHERE changed_by = 'owner'
       GROUP BY provider_id, field_name`,
    )
    .all() as Array<{ provider_id: string; field_name: string; latest_changed_at: string }>;

  let stamped = 0;
  let alreadyStamped = 0;
  let skippedMissingProvider = 0;

  // One provider row can appear for multiple field_name groups above — each
  // (provider_id, field_name) group gets its OWN read-modify-write (same
  // per-row-transaction discipline as applyGardssalgWebsiteVerification in
  // gardssalg-website-verification.ts) rather than batching all of a
  // provider's fields into one write, so a mid-batch failure on one group
  // never loses/duplicates a write already committed for another.
  const runOne = db.transaction((row: { provider_id: string; field_name: string; latest_changed_at: string }) => {
    const providerRow = db
      .prepare(`SELECT id, field_provenance FROM experience_providers WHERE id = ?`)
      .get(row.provider_id) as { id: string; field_provenance: string | null } | undefined;
    if (!providerRow) {
      // Stale audit row referencing a since-deleted provider — skip, never
      // crash the batch.
      skippedMissingProvider++;
      return;
    }

    let provenance: Record<string, unknown> = {};
    if (providerRow.field_provenance) {
      try {
        const parsed = JSON.parse(providerRow.field_provenance);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          provenance = parsed as Record<string, unknown>;
        }
      } catch {
        /* malformed existing JSON -> treat as empty rather than clobber the write */
      }
    }
    const existingOwnerLocks = provenance.owner_locks;
    const ownerLocks: Record<string, unknown> =
      existingOwnerLocks && typeof existingOwnerLocks === "object" && !Array.isArray(existingOwnerLocks)
        ? { ...(existingOwnerLocks as Record<string, unknown>) }
        : {};

    if (Object.prototype.hasOwnProperty.call(ownerLocks, row.field_name)) {
      alreadyStamped++;
      return;
    }

    stamped++;
    if (!apply) return; // dry-run: count what WOULD be stamped, write nothing

    ownerLocks[row.field_name] = { locked_at: row.latest_changed_at };
    provenance.owner_locks = ownerLocks;
    db.prepare(`UPDATE experience_providers SET field_provenance = @field_provenance WHERE id = @id`).run({
      id: row.provider_id,
      field_provenance: JSON.stringify(provenance),
    });
  });

  for (const row of rows) runOne(row);

  return { scanned: rows.length, stamped, already_stamped: alreadyStamped, skipped_missing_provider: skippedMissingProvider };
}
