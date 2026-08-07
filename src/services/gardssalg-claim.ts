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
// match. SLICE 2 (2026-08-07) inserts three more tiers BETWEEN (a) and (c) —
// found_same_domain, found_contact_page, found_site_other, in that order —
// see "─── Found-address harvest tiers" below for what they are and why they
// rank where they do.
//
// deriveOrgLinkedEmail() stays a PURE function (see its own doc comment) —
// the (b-epost) DB lookup is therefore NOT done inside it. The caller
// (issueClaimMagicLink, and the GET claim-entry route) runs
// wasEpostDeliveredOutreachNoBounce() itself and passes the boolean result
// in via `opts.epostOutreachDeliveredNoBounce`, mirroring exactly how
// brregContactEmail is already an explicit passed-in parameter above.
//
// ─── Found-address harvest tiers (found_same_domain / found_contact_page /
// found_site_other) — dev-request 2026-08-06-aldri-gjett-epostadresse,
// SLICE 2 (2026-08-07) ─────────────────────────────────────────────────────
// Slice 1 (2026-08-06, see "(b) RETIRED" above) deleted post@<domain>
// guessing outright and left NO replacement — a provider with a verified
// hjemmeside but no qualifying brreg_contact/stored_epost_verified fell
// straight to the manual fallback even when a real, published address sat
// right there on their own homepage. This slice is that replacement: it
// FETCHES the provider's own verified hjemmeside and its real (link-
// discovered, never guessed) same-host sub-pages, and offers whatever email
// addresses were ACTUALLY PRESENT in the HTML — never a constructed one.
// AC2's required priority order (Daniel, dev-request AC2, verbatim): "(1) an
// address on the same domain as the verified website, (2) an address found
// on a 'kontakt oss'/'om oss' page, (3) any other address found on the
// website. Free-mail domains (gmail, hotmail, outlook, …) are ALLOWED at all
// three priority levels."
//
// Precondition (AC3's "ownership unclear -> manual fallback, never a guess
// about whose address it is", applied to the SOURCE page this time rather
// than the email): harvesting is attempted ONLY when
// isHjemmesideOwnershipVerified(provider) is true. Reusing that exact gate
// (rather than a new one) is deliberate — harvesting from an unverified/
// unowned hjemmeside would repeat precisely the "wrong producer's info" harm
// this whole module exists to prevent, just laundered through "but we found
// it on A website" instead of "but we guessed it from A domain". An
// unverified hjemmeside gets ZERO fetch attempts, not a fetch-then-discard —
// no reason to make an outbound request (and burn a fetch budget /
// potentially probe a URL nobody has vetted) for a result this function
// would refuse to use anyway.
//
// Accept/reject gate (AC3 for the found address itself, AC8 for which list
// governs it): isAcceptableHomepageEmail(email, hjemmeside) — imported
// UNCHANGED from cross-source-validator.ts — decides accept/reject. It
// accepts iff the email's registrable domain equals the (post-redirect) site's
// own registrable domain, OR the email's domain is in that file's
// FREE_MAIL_DOMAINS list; it always rejects a known directory/aggregator
// host. This harvest path deliberately does NOT call isClaimableDomain() /
// GENERIC_DOMAINS anywhere — GENERIC_DOMAINS's job (per its own doc comment
// above) is blocking a *derived* address, which has no bearing on a *found*
// one; conflating the two would re-reject exactly the gmail.com/hotmail.com/
// outlook.com found-on-the-producer's-own-contact-page addresses AC2
// explicitly says must be ALLOWED (GENERIC_DOMAINS lists those same three
// hosts, for the opposite reason). A rejected email is dropped OUTRIGHT —
// never becomes a candidate — so a producer whose only found address fails
// this gate falls straight through to the module's existing "zero
// candidates -> manual fallback" behavior, unchanged.
//
// Tier assignment (AC2, mutually exclusive per email — the FIRST rule that
// matches wins, checked in this order): (1) found_same_domain — the email's
// registrable domain equals the verified hjemmeside's own registrable domain
// (post-redirect host, matching how buildPageEvidence/hcrFetchHomepageContent
// already treat "final url after redirects" as the real one) — checked
// BEFORE the page-origin check below, so a same-domain address found ON the
// contact page still ranks as found_same_domain, never demoted; (2)
// found_contact_page — the email was found on a page whose OWN discovered
// URL path matches CONTACT_ABOUT_PATH_FRAGMENTS below; (3) found_site_other —
// everything else that survived the accept gate (the home page itself, or
// any other discovered sub-page). At most ONE candidate per tier is
// produced — the FIRST accepted email encountered in fetch/scan order (home
// page before sub-pages, sub-pages in discoverContentLinks' own deterministic
// score-then-alphabetical order) — so the choice is deterministic and
// reproducible (AC4), not "whichever the Set iterated last".
//
// CONTACT_ABOUT_PATH_FRAGMENTS: a short, case-insensitive URL-PATH substring
// list, checked against the discovered link's own URL (not the page's HTML
// content). Checked the codebase first for an existing list to reuse rather
// than hand-rolling a third copy: admin-knowledge.ts's HCR_CONTENT_PATHS
// (["/om-oss", "/about", "/produkter"]) is a FALLBACK GUESS-PATH list (used
// only when link discovery finds nothing), not a classifier, and doesn't even
// include "kontakt" — not reusable as-is. fetch-page.ts's discoverContentLinks
// has an internal, unexported PATTERNS regex (kontakt|contact,
// om-?oss|om-?garden|om-?gården|about|historie, produkt|...) used to SCORE
// links for crawl-priority, not to classify an already-discovered link after
// the fact, and isn't exported. Rather than exporting and repurposing an
// internal scoring table for an unrelated classification decision, this is a
// small, deliberately narrow list of its own — the same core Norwegian +
// English fragments minus "historie" (a weaker, purely-about-us signal AC2's
// own wording doesn't ask for) and minus the produkt/vare/butikk group
// (AC2's tier 3 "any other" already covers those without needing to name
// them).
//
// Merging into the candidate list (deriveOrgLinkedEmailCandidatesWithHarvest
// below): the three found-tiers are inserted BETWEEN (a) brreg_contact and
// (c) stored_epost_verified — i.e. they rank ABOVE stored_epost_verified.
// Judgment call, written down per this file's own documentation convention:
// stored_epost_verified's provenance is either a one-time manual entry (which
// can go stale the moment the producer's real inbox changes, with nothing
// re-checking it — see isHjemmesideOwnershipVerified's own KNOWN GAP note
// above for the analogous staleness risk on the 'manual' flag) or an
// inference from a past delivered outreach send (proves the address existed
// and accepted mail AT SEND TIME, not that it's still the producer's
// preferred contact today). A found_same_domain/found_contact_page address,
// by contrast, is evidence pulled from the SAME live fetch this exact claim
// flow just performed — as fresh as evidence gets in this codebase. Ranking
// fresher, live-confirmed evidence above older provenance-backed-but-possibly-
// stale evidence is the same "don't let a weaker signal override a stronger
// one" principle the pre-existing ordering comment above already states, just
// applied with "freshness" as part of what makes a tier stronger. This is a
// judgment call, not a re-derivation of anything Daniel stated explicitly for
// THIS specific sub-ordering — flagged as such for the reviewer.
//
// NOT LIVE-WIRED in slice 2 — was a deliberate scope boundary, not an
// oversight (three concrete reasons: (1) it would require converting
// issueClaimMagicLink from sync to async, cascading into ~20 existing
// synchronous call sites across three test files; (2) the public GET
// claim-entry route's HTTP-level test harness (routes/gardssalg-claim.test.ts)
// had no fetch-injection seam, so wiring a live fetch into that route would
// make its test suite perform real outbound network calls against nonexistent
// test-fixture domains; (3) the claim entry page is UNAUTHENTICATED —
// fetching a producer's hjemmeside on every page view with no caching/
// rate-limiting is a real design question that deserves its own decision).
// ALL THREE ARE NOW RESOLVED — see the "LIVE-WIRING" section immediately
// below, which is what actually restores claim coverage.
//
// ─── LIVE-WIRING — dev-request 2026-08-06-aldri-gjett-epostadresse, SLICE 5,
// AC7 (2026-08-07) ──────────────────────────────────────────────────────────
// WHY THIS SLICE EXISTS, measured, not hypothesised: with slice 1's deletion
// of the post@<domain> guess merged to production and slices 2/4 built but
// dormant, the live cohort measurement in the dev-request itself
// ("Live-verifisering 2026-08-07T07:3xZ") found claim coverage across all 87
// published gårdssalg producers had gone 10/87 -> **0/87**. AC1 ("never guess
// an address") was satisfied and confirmed live; the replacement simply was
// not reachable from any route. This slice reaches it.
//
// What changed, exactly three things:
//   1. issueClaimMagicLink() is now `async` and derives its candidates via
//      deriveOrgLinkedEmailCandidatesWithHarvest() instead of the sync
//      deriveOrgLinkedEmailCandidatesWithOutreachLookup(). Its opts.selectedSource
//      re-validation runs against that SAME harvest-aware list — so a producer
//      can pick a found-tier address on the entry page and have that choice
//      validate server-side, which is the whole point of offering it.
//   2. The public GET claim-entry route (routes/gardssalg-claim.ts) derives
//      its displayed candidate list from the same async function, so the page
//      and the POST it submits to can never disagree about eligibility (the
//      pre-existing "must mirror issueClaimMagicLink()'s own lookup exactly"
//      invariant that route's own comment already states).
//   3. Both live routes reach the REAL global fetch in production and an
//      INJECTED one in tests, via __setClaimHarvestFetchForTesting() below.
//
// What deliberately did NOT change: magic-link validity duration, the
// rate-limit window/ceiling, the isTest test-send-guard semantics
// (dev-request 2026-07-26-booking-test-send-guard), the DB schema, and the
// ordering of issueClaimMagicLink()'s own error precedence (candidate
// derivation before the rate-limit check, exactly as before — moving the
// rate-limit check earlier would silently reorder which error a caller sees
// and several existing tests pin that order).
//
// ─── found_umbrella_member — dev-request 2026-08-06-aldri-gjett-epostadresse,
// SLICE 4, AC5 (2026-08-07) ─────────────────────────────────────────────────
// AC5 (Daniel, verbatim): "Paraply-kilde: når adressen kun finnes via en
// paraplyorganisasjons medlemsliste, brukes produsentens adresse derfra —
// aldri paraplyens egen. Test som feiler hvis paraplyens adresse skulle lekke
// inn som produsentens." A FOURTH found-tier, ranked BELOW the three
// found-tiers above (own-site evidence beats umbrella-page evidence) but
// ABOVE nothing — it is itself the last found-tier, still ranked above
// stored_epost_verified for the same "freshest live evidence wins" reasoning
// already stated above, and only ever attempted as a FALLBACK when the
// provider's own site produced zero candidates (see
// deriveOrgLinkedEmailCandidatesWithHarvest()'s own doc comment for the exact
// gating condition). Full lookup/harvest/attribution rationale — including
// the hard domain exclusion that makes "the umbrella's own address" and
// "this producer's address" mutually exclusive by construction, and the
// name-proximity attribution guard that stands in for the "which member is
// this actually for" verification a same-domain match would otherwise
// provide — lives on findUmbrellaAffiliation() and
// harvestUmbrellaMemberEmail()'s own doc comments further down (not
// restated here to avoid the two copies drifting).
//
// This is the same "found, never derived" family as the three tiers above —
// no address is ever constructed from a domain — with an added attribution
// problem the other three don't have (an umbrella's member page names MANY
// producers on one page, not just this one), which is why it needs its own,
// stricter, name-matched gate rather than reusing pickHarvestCandidatesByTier
// as-is.

import crypto from "crypto";
import { v4 as uuid } from "uuid";
import { getDb } from "../database/db-factory";
import { getDb as getRfbDb } from "../database/init";
import { normalizeEmail } from "./blocklist-service";
import { GENERIC_DOMAINS } from "./gardssalg-rfb-enrich";
import { fetchPage, discoverContentLinks } from "./fetch-page";
import { extractEmails } from "./search-enrich";
import { isAcceptableHomepageEmail, hostFromUrlLike, registrableDomain } from "./cross-source-validator";

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

// "found_same_domain" | "found_contact_page" | "found_site_other" — the three
// SLICE 2 (dev-request 2026-08-06-aldri-gjett-epostadresse, AC2) tiers, added
// 2026-08-07. See "─── Found-address harvest tiers" below for the full
// rationale, and deriveOrgLinkedEmailCandidatesWithHarvest() for the ONLY
// function that can ever produce one of these three values — the pure
// deriveOrgLinkedEmailCandidates() below never does (it stays IO-free, and
// harvesting is inherently IO).
export type OrgLinkedEmailResult =
  | {
      eligible: true;
      email: string;
      source:
        | "brreg_contact"
        | "verified_domain_address"
        | "stored_epost_verified"
        | "found_same_domain"
        | "found_contact_page"
        | "found_site_other"
        | "found_umbrella_member";
    }
  | { eligible: false; reason: "not_brreg_verified" | "no_org_linked_email" };

export type OrgLinkedEmailCandidate = {
  email: string;
  source:
    | "brreg_contact"
    | "verified_domain_address"
    | "stored_epost_verified"
    | "found_same_domain"
    | "found_contact_page"
    | "found_site_other"
    | "found_umbrella_member";
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

// ─── Found-address harvest (SLICE 2) ─────────────────────────────────────
// See the module doc's "Found-address harvest tiers" section above for the
// full rationale. Everything below is IO (fetch), so none of it is called
// from the pure deriveOrgLinkedEmailCandidates() — only from the async
// deriveOrgLinkedEmailCandidatesWithHarvest() wrapper further down.

// Same UA convention this vertical's other crawler already uses (opplevelser
// .ts's CR_UA) — this file is opplevagent/gårdssalg-scoped, not RFB-scoped,
// so it deliberately does NOT reuse search-enrich.ts's UA (RFB's), even
// though that constant has the more common name in this codebase.
const HARVEST_UA = "Lokal-Experiences-Scraper/1.0 (+https://opplevagent.no)";
// Matches search-enrich.ts's FETCH_TIMEOUT_MS convention for this class of
// crawl (home page + a few discovered sub-pages, not the longer single-page
// budget fetch-page.ts's own DEFAULT_FETCH_TIMEOUT_MS gives a lone fetch).
const HARVEST_FETCH_TIMEOUT_MS = 8_000;
// Matches discoverContentLinks' own default `max` and buildPageEvidence's
// existing sub-page crawl budget (home page + up to 3 discovered links).
const HARVEST_MAX_SUBPAGES = 3;

// ── Injectable fetch (test seam) — SLICE 5 / AC7 live-wiring ─────────────
// Same module-level "override, else global fetch" shape this repo already
// uses for every other outbound-fetching service: experience-brreg.ts's
// __setBrregFetchForTesting(), bm-events-scraper.ts's
// __setBmEventsScraperFetchForTesting(), experience-store.ts's
// __setGardssalgWebsiteSearchForTesting(). Deliberately NOT a new mechanism.
//
// WHY a module-level override is needed AT ALL, given
// deriveOrgLinkedEmailCandidatesWithHarvest() already takes a per-call
// opts.fetchImpl: the live callers are now HTTP ROUTES. A route handler has
// no test-visible parameter list — routes/gardssalg-claim.test.ts drives the
// router over a real http.Server with raw http.request(), so the only way it
// can control what the harvest fetches is a seam on the module the router
// imports. Per-call opts.fetchImpl STILL WINS over this override (see
// resolveHarvestFetchImpl below), so every existing service-level test that
// passes its own fetchImpl is unaffected, and the interleaved-suite race the
// __setRfbDbForTesting doc comment above documents does not apply the same
// way here: each of the three suites that reach this code deletes
// gardssalg-claim from require.cache and installs its own override on its
// own fresh module instance, exactly as they already do for the RFB db.
//
// PRODUCTION NEVER CALLS THE SETTER — the default is undefined, which
// fetchPage() resolves to the global fetch exactly as before.
let _claimHarvestFetchOverrideForTesting: typeof fetch | undefined = undefined;

/** Test-only: swap the fetch used by the claim-flow harvest tiers. Pass
 * nothing (or undefined) to restore the global fetch. Never call from
 * production code. */
export function __setClaimHarvestFetchForTesting(impl?: typeof fetch): void {
  _claimHarvestFetchOverrideForTesting = impl;
}

function resolveHarvestFetchImpl(perCall?: typeof fetch): typeof fetch | undefined {
  return perCall ?? _claimHarvestFetchOverrideForTesting;
}

// ── Harvest result cache — SLICE 5 / AC7, and an explicit JUDGMENT CALL ───
// Flagged for the reviewer in the same voice as the found-tier ranking note
// in the module doc above: this TTL is MY choice, not a re-derivation of
// anything Daniel stated explicitly. The dev-request only says the caching/
// rate-limit question for the unauthenticated entry page "deserves its own
// decision"; it does not name a number. Here is the decision and the
// reasoning, so a reviewer can disagree with a concrete thing rather than
// with a silence.
//
// THE PROBLEM this exists to solve: GET /kategori/gardssalg/eier/:slug is
// PUBLIC and UNAUTHENTICATED. Wiring the harvest into it means one page view
// of an eligible producer can trigger up to 1 + HARVEST_MAX_SUBPAGES (=4)
// outbound requests to that producer's own website, plus up to 4 more to
// their umbrella's site on the fallback path. Uncached, that makes any
// visitor holding down F5 into a small, free, third-party-targeted request
// amplifier running from our IP — against a site we do not own, on behalf of
// a producer who never asked for it. The claim rate limit does NOT protect
// this: isClaimRateLimited() only gates the POST that issues a link, and is
// checked AFTER candidate derivation by design (see issueClaimMagicLink's
// error precedence), so it never bounds GET-side fetching at all. Nor does
// express-rate-limit: gardssalgClaimRoutes is mounted in src/index.ts at the
// `app.use("/", gardssalgClaimRoutes)` line that sits ABOVE every limiter
// mount in that file (generalLimiter, adminLimiter, …), deliberately so
// (the opplevagent.no host-gate's catch-all 404 would otherwise swallow it),
// so this path has NO middleware rate limit either. This cache is genuinely
// the only thing standing between a public page view and a third party's
// server — which is why it has to be single-flight, below.
//
// THE CHOICE: a process-local Map<cacheKey, {promise, expiresAt}> around
// the NETWORK-DERIVED tiers only, TTL 12 minutes, SINGLE-FLIGHT.
//   - Why the map holds a PROMISE and not a finished result (review finding,
//     2026-08-07 — the first version of this cache stored the resolved
//     candidates and wrote them only AFTER the harvest await returned): a
//     result-only cache helps SEQUENTIAL callers exclusively. The reviewer
//     reproduced it — 50 simultaneous page views for one COLD producer each
//     found an empty map, each started its own harvest, and the route made 50
//     real outbound fetch bursts, not 1. Since the whole justification for
//     having no other protection on this public GET is "the cache removes the
//     amplification", the cache has to hold under concurrency or it does not
//     hold at all. Storing the in-flight promise and inserting it
//     SYNCHRONOUSLY (before the first await) makes the second concurrent
//     caller for the same key find it already there and await the SAME
//     harvest. See resolveFoundTierCandidates for the mechanics.
//   - Why a rejected in-flight entry is DELETED rather than cached: a
//     transient DNS/TLS failure must not become a 12-minute answer, and a
//     settled-rejected promise left in the map would rethrow the same stale
//     error at every later caller. On rejection the key is dropped, so the
//     next request gets a genuinely fresh attempt.
//   - What this now GUARANTEES, precisely: concurrent requests for the same
//     uncached provider share ONE in-flight harvest (N simultaneous visitors
//     cost 1 fetch burst, not N), and once it resolves the TTL caps REPEAT
//     harvests for that provider at ~5/hour for as long as visitors keep
//     arriving. Both halves are needed; neither alone bounds the outbound
//     rate. NOTE this is per-process — two instances behind a load balancer
//     have one cache each, so the real ceiling is ~5/hour × instances.
//   - Why cache only the network tiers, not the whole candidate list: the
//     DB-derived tiers (brreg_contact / stored_epost_verified) cost one
//     local SQLite read and are the ones an admin edit can change; keeping
//     them live means an admin fixing a producer's stored epost sees it take
//     effect on the very next page view, and means opts.selectedSource is
//     still re-validated against genuinely fresh DB evidence — the property
//     issueClaimMagicLink's own doc comment promises. Only the part that
//     costs somebody ELSE a request is cached.
//   - Why 12 minutes: with single-flight above already collapsing the
//     CONCURRENT burst to one harvest, the TTL is what bounds the REPEAT
//     rate — it has to be long enough that a reload-hammering visitor cannot
//     convert sequential page views into outbound requests (12 minutes caps
//     one producer at ~5 harvests/hour per process, however many visitors or
//     reloads arrive), and short enough that a producer who has JUST
//     put their address on their contact page — plausibly while sitting on
//     this very page, having been told that is what we look for — does not
//     have to wait long enough to give up. 12 min sits between those: a
//     coffee-break, not a deploy cycle. 60s would barely dent a reload loop;
//     an hour would make "I fixed it, now what?" feel broken. There is no
//     measured optimum here and I am not pretending there is one.
//   - Why in-process and not persistent: single Node process (same premise
//     route-corridor-service.ts's own in-memory route cache and
//     traffic-stats.ts's counter cache already rely on), and a cache whose
//     worst-case failure is "we re-fetch a homepage after a restart" needs no
//     durability. Unbounded growth is bounded in practice by the cohort size
//     (87 published gårdssalg producers today, low hundreds at any plausible
//     scale) and expired entries are dropped on read.
//   - What I did NOT do, and why: no per-IP rate limit on the GET route
//     (would need shared state to be meaningful behind more than one
//     instance, and the cache already removes the amplification this was
//     meant to stop), and no move of harvesting into the periodic gårdssalg
//     enrichment sweep (that was the other option the slice-2 comment
//     floated — it would make coverage depend on a sweep having run, which
//     is exactly the "built but not reachable" failure this slice is fixing).
const CLAIM_HARVEST_CACHE_TTL_MS = 12 * 60 * 1000;

interface HarvestCacheEntry {
  /** The IN-FLIGHT (or already settled) harvest, not its result — see the
   * single-flight bullet on CLAIM_HARVEST_CACHE_TTL_MS. Inserted before the
   * first await so concurrent callers share it. */
  promise: Promise<OrgLinkedEmailCandidate[]>;
  expiresAt: number;
}
// KNOWN, ACCEPTED STALENESS (written down rather than left silent, same as
// the TTL choice above): the cache key is provider.id + alreadyHasStoredEpost
// and deliberately does NOT include the provider's `hjemmeside`. An admin who
// edits a producer's hjemmeside mid-TTL therefore keeps seeing found-tier
// candidates harvested from the OLD site for up to
// CLAIM_HARVEST_CACHE_TTL_MS. Accepted: hjemmeside edits are rare and
// admin-driven, the stale window is one coffee break, and the DB-derived
// tiers (the ones an admin edit usually means to fix — stored epost) are
// re-derived live on every call anyway. If this ever bites, the fix is to
// fold hjemmeside into the key, not to shorten the TTL.
//
// The key also does NOT include `fetchImpl`. Safe today because no live
// caller passes both a custom opts.fetchImpl AND an opts.cacheKey — the
// routes pass cacheKey only, and every fetchImpl-passing caller is a test
// that passes no cacheKey. A future caller that passes BOTH must key on the
// fetch implementation too, or two different fetch impls will cross-
// contaminate each other's cached results under the same provider id.
const _claimHarvestCache = new Map<string, HarvestCacheEntry>();

/** Test-only: drop every cached harvest result. Follows the
 * __resetTrafficStatsCacheForTesting / __clearRouteCacheForTesting naming
 * convention already used for this repo's other in-process caches. */
export function __resetClaimHarvestCacheForTesting(): void {
  _claimHarvestCache.clear();
}

// See module doc for why this list exists and what it deliberately excludes.
const CONTACT_ABOUT_PATH_FRAGMENTS: readonly string[] = ["kontakt", "contact", "om-oss", "om-garden", "om-gården", "about"];

function isContactOrAboutPageUrl(url: string): boolean {
  const lower = url.toLowerCase();
  return CONTACT_ABOUT_PATH_FRAGMENTS.some((fragment) => lower.includes(fragment));
}

type HarvestTierSource = "found_same_domain" | "found_contact_page" | "found_site_other";

interface HarvestedEmailHit {
  email: string;
  tier: HarvestTierSource;
}

/**
 * Fetch `hjemmeside` + its real discovered same-host sub-pages (never a
 * guessed path — see discoverContentLinks), and return every email that
 * ACTUALLY APPEARED in the fetched HTML and passed isAcceptableHomepageEmail,
 * tagged with its AC2 priority tier. Never throws — a fetch failure (site
 * down, timeout, SSRF-blocked, …) simply yields zero hits, same as "this
 * producer has no found address today", not an error.
 *
 * NOT exported — only reachable via deriveOrgLinkedEmailCandidatesWithHarvest
 * below, which applies the isHjemmesideOwnershipVerified() precondition
 * first. This function itself does not re-check that precondition — it
 * trusts its caller, exactly like wasEpostDeliveredOutreachNoBounce() trusts
 * its callers to have already decided the DB lookup is worth doing.
 */
async function harvestFoundOrgEmails(hjemmeside: string, fetchImpl?: typeof fetch): Promise<HarvestedEmailHit[]> {
  const primary = await fetchPage(hjemmeside, { userAgent: HARVEST_UA, timeoutMs: HARVEST_FETCH_TIMEOUT_MS, fetchImpl });
  if (!primary.ok) return [];

  // Post-redirect host is the real one — same reasoning buildPageEvidence /
  // hcrFetchHomepageContent already document: an apex->www or renamed-domain
  // redirect must not make every found address look cross-domain.
  const siteBase = primary.finalUrl || hjemmeside;
  const siteHost = hostFromUrlLike(siteBase);
  const siteRoot = siteHost ? registrableDomain(siteHost) : null;

  type HarvestPage = { html: string; isContactAbout: boolean };
  const pages: HarvestPage[] = [{ html: primary.html, isContactAbout: false }];

  try {
    const base = new URL(siteBase);
    const discovered = discoverContentLinks(primary.html, base.toString(), HARVEST_MAX_SUBPAGES);
    for (const link of discovered) {
      const sub = await fetchPage(link, { userAgent: HARVEST_UA, timeoutMs: HARVEST_FETCH_TIMEOUT_MS, fetchImpl });
      if (sub.ok) pages.push({ html: sub.html, isContactAbout: isContactOrAboutPageUrl(link) });
    }
  } catch {
    /* malformed base URL — the primary page's own emails still stand */
  }

  const seenEmails = new Set<string>();
  const hits: HarvestedEmailHit[] = [];
  for (const page of pages) {
    for (const email of extractEmails(page.html)) {
      if (seenEmails.has(email)) continue; // first occurrence wins — deterministic (AC4)

      // AC3/AC8: isAcceptableHomepageEmail ALONE decides accept/reject here —
      // never isClaimableDomain/GENERIC_DOMAINS (see module doc). A reject is
      // dropped outright, never becomes a hit/candidate.
      if (!isAcceptableHomepageEmail(email, siteBase)) continue;
      seenEmails.add(email);

      const emailHost = hostFromUrlLike(email.split("@").pop() || "");
      const emailRoot = emailHost ? registrableDomain(emailHost) : null;
      const tier: HarvestTierSource =
        siteRoot && emailRoot === siteRoot
          ? "found_same_domain"
          : page.isContactAbout
            ? "found_contact_page"
            : "found_site_other";
      hits.push({ email, tier });
    }
  }
  return hits;
}

/** At most one candidate per AC2 tier — the first hit for each, in AC2's
 * priority order. See module doc's "Tier assignment" paragraph. */
function pickHarvestCandidatesByTier(hits: HarvestedEmailHit[]): OrgLinkedEmailCandidate[] {
  const tierOrder: HarvestTierSource[] = ["found_same_domain", "found_contact_page", "found_site_other"];
  const out: OrgLinkedEmailCandidate[] = [];
  for (const tier of tierOrder) {
    const hit = hits.find((h) => h.tier === tier);
    if (hit) out.push({ email: hit.email, source: tier });
  }
  return out;
}

// ─── Umbrella member-list harvest (found_umbrella_member) — dev-request
// 2026-08-06-aldri-gjett-epostadresse, SLICE 4, AC5 (2026-08-07) ───────────
// AC5 (Daniel, verbatim): "Paraply-kilde: når adressen kun finnes via en
// paraplyorganisasjons medlemsliste, brukes produsentens adresse derfra —
// aldri paraplyens egen." I.e. when a producer's own site yields nothing at
// all, its UMBRELLA organisation's own member-list page may still name it —
// this tier fetches THAT page and offers the address it shows FOR THIS
// PRODUCER, never the umbrella's own contact address.
//
// This is a FALLBACK, not a peer of found_same_domain/found_contact_page/
// found_site_other above: only attempted when harvestFoundOrgEmails() (the
// provider's OWN site) already ran and found ZERO hits — wired in
// deriveOrgLinkedEmailCandidatesWithHarvest() below, not left to the caller.
// A provider whose own site already yielded an address never needs its
// umbrella at all; a provider with no verified/no hjemmeside is exactly the
// population this tier exists for.
//
// Daniel's own risk framing (dev-request risk section, verbatim, and
// directly binding on how this is built): "Å gjette HVEM adressen tilhører
// er fortsatt gjetting [...] Vurderingen er navnelikhet — og tar vi feil,
// gir vi bort kontoen til en utenforstående. Kontoovertakelse, ikke bare
// feil visningsdata. Derfor: uavklarte tilfeller skal til manuell
// verifisering, ikke løses med en heuristikk." I.e. WHOSE address a found
// email belongs to is still a guess unless we can attribute it — a wrong
// attribution here is account takeover, not a display bug. Every branch
// below that cannot confidently attribute exactly one address to THIS
// producer returns null, never a best guess.

/**
 * (AC5 lookup step) Resolve the producer's own ACTIVE umbrella affiliation
 * and the umbrella's own registrable domain (the HARD EXCLUSION domain — see
 * harvestUmbrellaMemberEmail below). Cross-references experience_providers
 * (this vertical's own DB) against the RFB main DB's agents/agent_affiliations
 * tables by org_nr — the same join key already used elsewhere in this
 * codebase for exactly this vertical-to-RFB crossover (e.g. knowledge-
 * service.ts, dental-store.ts) — since there is no direct FK between the two.
 * Uses the SAME getRfbDb() + _rfbDbOverrideForTesting seam as
 * wasEpostDeliveredOutreachNoBounce() above; no new DB-access mechanism.
 *
 * Returns null — no attempt, not attempt-then-discard, same convention this
 * file already uses for isHjemmesideOwnershipVerified()'s own precondition
 * — on ANY of the following, each one deliberately conservative rather than
 * a best-effort pick (Daniel's "uavklarte tilfeller -> manuell verifisering"
 * quote above governs every one of these):
 *   - no org_nr on the provider at all;
 *   - no `agents` row for this org_nr with umbrella_type IS NULL (i.e. no
 *     matching REAL producer agent — a provider that doesn't even have an
 *     RFB producer identity has no affiliation to look up);
 *   - zero ACTIVE agent_affiliations rows for that producer (no affiliation
 *     — 'pending_confirmation'/'review_required'/'rejected'/'historical' all
 *     deliberately do NOT count, only a confirmed, currently-active one
 *     does);
 *   - MORE THAN ONE active affiliation (which umbrella's member page would
 *     even be the right one to trust? — itself an ambiguous case, never
 *     arbitrarily resolved by picking the first);
 *   - the resolved umbrella `agents` row has no `url` (nothing to fetch).
 */
function findUmbrellaAffiliation(
  provider: Pick<ClaimProviderRow, "org_nr">,
): { umbrellaHjemmeside: string; umbrellaRegistrableDomain: string | null } | null {
  if (!provider.org_nr) return null;
  const db = _rfbDbOverrideForTesting ?? getRfbDb();

  const producerAgent = db
    .prepare(`SELECT id FROM agents WHERE org_nr = ? AND umbrella_type IS NULL LIMIT 1`)
    .get(provider.org_nr) as { id: string } | undefined;
  if (!producerAgent) return null;

  const activeAffiliations = db
    .prepare(`SELECT umbrella_id FROM agent_affiliations WHERE producer_id = ? AND status = 'active'`)
    .all(producerAgent.id) as Array<{ umbrella_id: string }>;
  // 0 -> no affiliation to use; >1 -> ambiguous which umbrella to trust —
  // NEITHER is resolved with a guess (see doc comment above).
  if (activeAffiliations.length !== 1) return null;

  const umbrellaAgent = db
    .prepare(`SELECT url FROM agents WHERE id = ?`)
    .get(activeAffiliations[0]!.umbrella_id) as { url: string | null } | undefined;
  if (!umbrellaAgent || !umbrellaAgent.url) return null;

  const umbrellaHost = hostFromUrlLike(umbrellaAgent.url);
  const umbrellaRegistrableDomain = umbrellaHost ? registrableDomain(umbrellaHost) : null;

  return { umbrellaHjemmeside: umbrellaAgent.url, umbrellaRegistrableDomain };
}

// Minimal, purpose-built HTML->plain-text stripper for the name-proximity
// scan below. Deliberately NOT search-enrich.ts's extractProseText(): that
// function's whole job is to DROP high-link-density <ul>/<ol> blocks (see
// its own isHighLinkDensityBlock use) because those are usually navigation —
// but a member-list page's actual member directory is very often EXACTLY a
// link-dense <ul>/<ol> of member cards, which is precisely the content this
// scan needs to see. Reusing extractProseText here would risk silently
// stripping the one block that matters. This stripper keeps everything
// VISIBLE, tags out — except CSS/HTML-hidden elements (see
// stripHiddenElements below), which are dropped content-and-all so hidden
// tab/accordion markup common in member-list pages can't masquerade as
// visible text for the name-proximity scan.
function stripToPlainText(html: string): string {
  const withoutScriptsStylesComments = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");
  return stripHiddenElements(withoutScriptsStylesComments)
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&aelig;/gi, "æ").replace(/&oslash;/gi, "ø").replace(/&aring;/gi, "å")
    .replace(/&AElig;/g, "Æ").replace(/&Oslash;/g, "Ø").replace(/&Aring;/g, "Å")
    .replace(/\s+/g, " ")
    .trim();
}

// Does this start tag's attribute text mark the element as CSS/HTML hidden?
// Checked (pragmatically — see stripHiddenElements's own doc comment on why
// this isn't a full CSS engine):
//   - the `hidden` boolean attribute (`<div hidden>`, `<div hidden="">`,
//     `<div hidden="hidden">`) — anchored on a preceding boundary so it
//     never fires on an unrelated attribute that merely CONTAINS "hidden"
//     as a substring, e.g. `data-hidden-count="3"`;
//   - an inline `style="..."` containing `display:none`/`display: none`
//     (whitespace around the colon allowed) or `visibility:hidden`/
//     `visibility: hidden`, single- or double-quoted.
function elementIsHidden(attrs: string): boolean {
  if (/(?:^|\s)hidden(?:\s|=|$)/i.test(attrs)) return true;
  const styleMatch = attrs.match(/\bstyle\s*=\s*(?:"([^"]*)"|'([^']*)')/i);
  const styleValue = styleMatch ? styleMatch[1] ?? styleMatch[2] ?? "" : "";
  if (!styleValue) return false;
  return /display\s*:\s*none\b/i.test(styleValue) || /visibility\s*:\s*hidden\b/i.test(styleValue);
}

// Finds the index just past the closing tag that matches the open tag
// `tagName` whose content starts at `searchFrom`, honoring nesting of the
// SAME tag name in between (e.g. `<div hidden><div>x</div></div>` — the
// inner `</div>` must not be mistaken for the outer one's close). An
// unclosed element (malformed HTML) is treated as running to the end of the
// document — the conservative choice, same convention search-enrich.ts's
// own depth-aware stripBlocksByTagNames() uses for the same situation:
// better to over-exclude possible hidden chrome than to leak it into text
// scanned for name/email attribution.
function findMatchingCloseTagEnd(html: string, tagName: string, searchFrom: number): number {
  const tagRe = new RegExp(`<(/?)${tagName}(?![\\w-])[^>]*?(/?)>`, "gi");
  tagRe.lastIndex = searchFrom;
  let depth = 1;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(html))) {
    const isClosing = m[1] === "/";
    const isSelfClosing = m[2] === "/";
    if (isSelfClosing) continue; // empty element, doesn't affect depth
    if (isClosing) {
      depth--;
      if (depth === 0) return m.index + m[0].length;
    } else {
      depth++;
    }
  }
  return html.length;
}

// Pre-pass for stripToPlainText: removes the ENTIRE content (tags + text)
// of any element that is CSS/HTML-hidden per elementIsHidden() above —
// `hidden` attribute, `display:none`/`display: none`, or
// `visibility:hidden`/`visibility: hidden` — before the generic tag-strip
// below turns everything into flat text. Without this, a hidden element's
// text (e.g. an off-screen tab panel or accordion pane in a member-list
// page, where several members' markup commonly sits in the DOM at once but
// only one is visible) survives stripToPlainText intact and gets scanned
// for name-proximity attribution identically to genuinely visible text —
// widening the false-positive surface for the AC5 attribution question this
// file exists to get right. A deliberately pragmatic regex/tag-scan pass —
// same robustness level as this file's existing <script>/<style> stripping
// above, NOT a full CSS/HTML engine (doesn't evaluate external stylesheets,
// classes, or computed style — only inline `style="..."` and the `hidden`
// attribute, which covers the realistic member-directory-markup case this
// exists for).
function stripHiddenElements(html: string): string {
  const openTagRe = /<([a-zA-Z][a-zA-Z0-9-]*)\b([^>]*?)(\/?)>/g;
  let result = "";
  let cursor = 0;
  let m: RegExpExecArray | null;
  while ((m = openTagRe.exec(html))) {
    if (m.index < cursor) continue; // inside a hidden range already removed below
    const [full, tagName, attrs, selfClose] = m;
    if (selfClose === "/") continue; // no content to hide
    if (!elementIsHidden(attrs)) continue;
    const contentStart = m.index + full.length;
    const closeEnd = findMatchingCloseTagEnd(html, tagName, contentStart);
    result += html.slice(cursor, m.index);
    result += " "; // placeholder so words either side don't fuse together
    cursor = closeEnd;
    openTagRe.lastIndex = closeEnd;
  }
  result += html.slice(cursor);
  return result;
}

// Unicode-aware "is this a word character" test, used to anchor the
// name-proximity match below to real word/token boundaries. Deliberately
// NOT a plain `\b` regex word boundary: `\b` is defined in terms of ASCII
// `\w` ([A-Za-z0-9_]), so it does NOT treat æ/ø/å (or any other non-ASCII
// letter) as word characters — a boundary check built on bare `\b` would
// silently mis-anchor on the exact Norwegian names this function exists to
// attribute correctly. `\p{L}`/`\p{N}` (with the `u` flag) are Unicode
// property escapes that classify by the actual Unicode General_Category,
// so "æ", "ø", "å" (and their uppercase forms) correctly count as letters.
// Concretely verified (see the u10 test below, and this file's own test
// suite): /[\p{L}\p{N}]/u.test("æ") -> true, .test("å") -> true.
function isWordChar(ch: string | undefined): boolean {
  return !!ch && /[\p{L}\p{N}]/u.test(ch);
}

/** All start indices of `needle` inside `haystack` (both already
 * case-normalized by the caller) where the match is anchored to a real
 * word/token boundary: the character immediately before the match and the
 * character immediately after it (when either exists) must NOT be a
 * (Unicode-aware) word character. This rejects a `needle` that is merely
 * embedded inside — or a strict prefix/suffix of — a longer word or name,
 * e.g. needle "nordgård" against haystack "nordgårds bakeri as" finds the
 * raw substring at index 0 but then rejects it: the character immediately
 * after the match ("s") is a word character, so "nordgård" here is only
 * the first part of the longer, DIFFERENT word "nordgårds", not a genuine
 * standalone occurrence of the name. Overlap-inclusive among the indices
 * that DO qualify. Empty needle -> no matches (never "everywhere"). */
function allIndicesOf(haystack: string, needle: string): number[] {
  if (!needle) return [];
  const out: number[] = [];
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    const before = idx > 0 ? haystack[idx - 1] : undefined;
    const after = idx + needle.length < haystack.length ? haystack[idx + needle.length] : undefined;
    if (!isWordChar(before) && !isWordChar(after)) out.push(idx);
    idx = haystack.indexOf(needle, idx + 1);
  }
  return out;
}

// How close (in stripped-plain-text characters) an email must appear to an
// occurrence of the producer's own name to count as attributed to THAT
// producer, rather than to a neighbouring member's card. Picked to comfortably
// span one member's own card/list-item — "Ola Nordgård – Nordgård Gård,
// 4325 Bryne, tlf 456 78 901, ola@nordgard.no" is well under 150 characters
// even with generous label text ("Navn:", "E-post:", …) around each field —
// while staying much smaller than a whole rendered member-list page (which
// after stripping easily runs into the thousands of characters and would
// span dozens of unrelated members if used as the window). 250 gives a
// single card real slack (multi-line address, a second phone number) without
// reaching into an adjacent card in a typically-dense listing. This is a
// judgment call, not a value Daniel specified — flagged as such for the
// reviewer, same as this file's other documented judgment calls.
const UMBRELLA_NAME_PROXIMITY_CHARS = 250;

// Bare-email matcher over already-stripped plain text (no mailto: hrefs
// survive stripToPlainText — a mailto-only address with no visible text
// near it correctly finds no position to test proximity against, and is
// therefore never attributed here; see harvestUmbrellaMemberEmail's own doc
// comment). Same shape as search-enrich.ts's extractEmails() internal
// bareRe, not exported from there, so restated locally for this
// plain-text-only use. Used exclusively via String.prototype.matchAll below
// (which clones the regex per call per spec), never manual .exec()/
// lastIndex bookkeeping — this constant is module-scoped and this file's
// harvest functions can run concurrently across providers, so no shared
// mutable regex state may leak between calls.
const PLAIN_TEXT_EMAIL_RE = /\b([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})\b/g;

/**
 * (AC5 harvest step) Fetch the affiliated umbrella's own hjemmeside + its
 * real discovered same-host sub-pages (same fetch/discovery machinery as
 * harvestFoundOrgEmails — HARVEST_UA/HARVEST_FETCH_TIMEOUT_MS/
 * HARVEST_MAX_SUBPAGES, no new constants), and return the SINGLE email that
 * can be confidently attributed to `provider.navn` on that page, or null.
 *
 * Only ever reachable via deriveOrgLinkedEmailCandidatesWithHarvest() below,
 * which applies the "own-site harvest found nothing" precondition first —
 * this function itself does not re-check that, same "trusts its caller"
 * convention harvestFoundOrgEmails() above already documents.
 *
 * Step 1 — lookup (findUmbrellaAffiliation above). No affiliation resolved
 * -> return null immediately, ZERO fetch attempts (no attempt, not
 * attempt-then-discard — same convention this file uses everywhere else for
 * a precondition that decides a fetch isn't worth making).
 *
 * Step 2 — HARD EXCLUSION (the actual AC5 requirement, non-negotiable):
 * ANY email whose registrable domain equals the umbrella's own registrable
 * domain is dropped outright, before any other check runs, regardless of
 * name-proximity or anything else. This is what makes "the umbrella's own
 * address can never leak in as the producer's" true by construction rather
 * than by the accuracy of the name-matching heuristic below.
 *
 * Step 3 — accept gate: isAcceptableHomepageEmail(email, umbrella's own
 * hjemmeside) — the SAME function/AC3/AC8 rule harvestFoundOrgEmails() uses,
 * never GENERIC_DOMAINS/isClaimableDomain (do not re-litigate — see module
 * doc). Passing the UMBRELLA's own site as the "site" argument means this
 * accepts an email iff it's either on the umbrella's own domain (already
 * excluded by Step 2 by the time this matters) OR a free-mail domain
 * (gmail/hotmail/outlook/…). A DIFFERENT real company/producer domain found
 * on the umbrella's page is rejected here — deliberately: unlike the
 * found_same_domain tier, this function has no verified hjemmeside of the
 * TARGET producer to compare a custom domain against (by design —
 * harvestUmbrellaMemberEmail's own precondition is that the producer's site
 * harvest found NOTHING, which includes "no hjemmeside at all"), so a
 * third-party-looking domain sitting next to the right name on someone
 * ELSE's page is exactly the un-verifiable case Daniel's "uavklarte
 * tilfeller -> manuell verifisering" quote is about — a free-mail address is
 * the one shape here that's plausibly the producer's own personal mailbox
 * without needing a domain-ownership signal this function doesn't have.
 *
 * Step 4 — name-proximity attribution: an email only qualifies if it occurs
 * within UMBRELLA_NAME_PROXIMITY_CHARS characters of an occurrence of
 * `provider.navn` (case-insensitive) in the page's STRIPPED PLAIN TEXT (see
 * stripToPlainText — never matched against raw HTML/tag soup). No name
 * occurrence anywhere -> null. Name occurs but nothing qualifying nearby ->
 * null (does NOT fall back to "the only email found on the page", however
 * tempting — that would be exactly the "some email was found so use it"
 * heuristic Daniel's quote forbids).
 *
 * Step 5 — determinism/ambiguity: if MORE THAN ONE distinct qualifying email
 * survives steps 2-4 (e.g. the name appears twice near two different
 * addresses, or two sub-pages each attribute a different address) this is
 * itself an ambiguous case — return null, never pick one. This deliberately
 * does NOT extend pickHarvestCandidatesByTier's "first hit wins" convention
 * here: that convention arbitrates between three MUTUALLY EXCLUSIVE tiers
 * (same page can only be exactly one of same-domain/contact-page/other), a
 * different and much narrower kind of determinism than "two genuinely
 * different candidate email addresses for the same producer", which is a
 * real ambiguity this function must not silently resolve.
 *
 * Never throws — a fetch failure yields null, same as "nothing found today".
 */
export async function harvestUmbrellaMemberEmail(
  provider: Pick<ClaimProviderRow, "navn" | "org_nr">,
  opts: { fetchImpl?: typeof fetch } = {},
): Promise<OrgLinkedEmailCandidate | null> {
  const affiliation = findUmbrellaAffiliation(provider);
  if (!affiliation) return null;

  const nameLower = provider.navn.trim().toLowerCase();
  if (!nameLower) return null; // no name to attribute against -> never a guess

  const primary = await fetchPage(affiliation.umbrellaHjemmeside, {
    userAgent: HARVEST_UA,
    timeoutMs: HARVEST_FETCH_TIMEOUT_MS,
    fetchImpl: opts.fetchImpl,
  });
  if (!primary.ok) return null;

  const siteBase = primary.finalUrl || affiliation.umbrellaHjemmeside;
  const pageHtmls: string[] = [primary.html];

  try {
    const base = new URL(siteBase);
    const discovered = discoverContentLinks(primary.html, base.toString(), HARVEST_MAX_SUBPAGES);
    for (const link of discovered) {
      const sub = await fetchPage(link, { userAgent: HARVEST_UA, timeoutMs: HARVEST_FETCH_TIMEOUT_MS, fetchImpl: opts.fetchImpl });
      if (sub.ok) pageHtmls.push(sub.html);
    }
  } catch {
    /* malformed base URL — the primary page's own text still stands */
  }

  const qualifyingEmails = new Set<string>();

  for (const html of pageHtmls) {
    const plainText = stripToPlainText(html);
    const plainTextLower = plainText.toLowerCase();

    const namePositions = allIndicesOf(plainTextLower, nameLower);
    if (namePositions.length === 0) continue; // producer's name doesn't appear on this page at all

    for (const match of plainText.matchAll(PLAIN_TEXT_EMAIL_RE)) {
      const email = match[1]!.toLowerCase();
      const emailPos = match.index;

      // Step 2 — HARD EXCLUSION, checked first and unconditionally: never
      // the umbrella's own address, regardless of any other signal.
      const emailHost = hostFromUrlLike(email.split("@").pop() || "");
      const emailRoot = emailHost ? registrableDomain(emailHost) : null;
      if (affiliation.umbrellaRegistrableDomain && emailRoot === affiliation.umbrellaRegistrableDomain) continue;

      // Step 3 — AC3/AC8 accept gate (see doc comment above for why the
      // umbrella's own site is the "site" argument here).
      if (!isAcceptableHomepageEmail(email, siteBase)) continue;

      // Step 4 — name-proximity: qualifies iff within range of ANY
      // occurrence of the producer's name on this page.
      const nearName = namePositions.some((namePos) => Math.abs(emailPos - namePos) <= UMBRELLA_NAME_PROXIMITY_CHARS);
      if (!nearName) continue;

      qualifyingEmails.add(email);
    }
  }

  // Step 5 — exactly one qualifying, distinct email required; zero or
  // multiple are both "cannot confidently attribute" -> null.
  if (qualifyingEmails.size !== 1) return null;
  const [email] = qualifyingEmails;
  return { email: email!, source: "found_umbrella_member" };
}

/**
 * Candidates form of deriveOrgLinkedEmailCandidatesWithOutreachLookup() that
 * ALSO harvests found addresses from the provider's own verified hjemmeside
 * (dev-request 2026-08-06-aldri-gjett-epostadresse, SLICE 2 — AC2/AC3/AC4/
 * AC8). See the module doc's "Found-address harvest tiers" section for the
 * full priority/merge/ordering rationale.
 *
 * Harvesting is attempted ONLY when the provider is Brreg-verified, HAS a
 * hjemmeside, AND isHjemmesideOwnershipVerified(provider) is true — no fetch
 * at all otherwise (see module doc for why this is "no attempt", not
 * "attempt then discard").
 *
 * `opts.fetchImpl` is the SAME "injected for tests, defaults to global
 * fetch" seam fetch-page.ts's own FetchPageOptions already uses — passed
 * straight through to fetchPage(). When omitted it falls back to the
 * module-level __setClaimHarvestFetchForTesting() override (undefined in
 * production, i.e. the global fetch), which exists ONLY because the SLICE 5
 * live callers are HTTP route handlers with no test-visible parameter list —
 * see that setter's own doc comment. Per-call always wins over module-level,
 * so every pre-existing caller that passes its own fetchImpl is unaffected.
 *
 * LIVE-WIRED since SLICE 5 / AC7 (2026-08-07): issueClaimMagicLink() and the
 * public GET claim-entry route both derive their candidates through this
 * function. See the module doc's "LIVE-WIRING" section for what that changed
 * and what it deliberately did not.
 *
 * `opts.cacheKey` (SLICE 5 / AC7) — when given (the live routes pass
 * provider.id), the NETWORK-DERIVED tiers only (the three own-site found
 * tiers plus found_umbrella_member) are SINGLE-FLIGHTED and cached in-process
 * for CLAIM_HARVEST_CACHE_TTL_MS: concurrent calls for the same key share one
 * in-flight harvest instead of each starting their own, and the TTL then caps
 * repeat harvests for that key. The DB-derived tiers are re-derived on every
 * call regardless, so an admin edit to a provider's stored epost — and
 * therefore opts.selectedSource re-validation in issueClaimMagicLink — is
 * never served from a stale snapshot. Omitting it (every pre-existing caller,
 * and every test that wants to observe a specific fetch) disables caching
 * entirely for that call: nothing is read from the cache and nothing is
 * written to it. See CLAIM_HARVEST_CACHE_TTL_MS's own comment for the full
 * TTL rationale and the alternatives rejected.
 *
 * `navn` is added to the Pick, OPTIONAL (same "existing callers/fixtures
 * that construct a provider object without it keep compiling unchanged"
 * convention this file already uses for `epost` — see deriveOrgLinkedEmail's
 * own doc comment above) — needed only by the SLICE 4 found_umbrella_member
 * fallback below, which simply never attempts itself when navn is missing
 * (no name, nothing to attribute against, never a guess).
 */
export async function deriveOrgLinkedEmailCandidatesWithHarvest(
  provider: Pick<ClaimProviderRow, "org_nr" | "brreg_verified" | "hjemmeside" | "content_source" | "field_provenance"> & {
    epost?: string | null;
    navn?: string;
  },
  brregContactEmail?: string | null,
  opts: { fetchImpl?: typeof fetch; cacheKey?: string } = {},
): Promise<OrgLinkedEmailCandidate[]> {
  const baseCandidates = deriveOrgLinkedEmailCandidatesWithOutreachLookup(provider, brregContactEmail);

  // SLICE 4 / AC5's second gating condition, hoisted above the fetch work so
  // it can also form part of the SLICE 5 cache key (see below).
  const alreadyHasStoredEpost = baseCandidates.some((c) => c.source === "stored_epost_verified");

  const foundCandidates = await resolveFoundTierCandidates(provider, alreadyHasStoredEpost, opts);

  // Merge in the documented priority order — (a) brreg_contact, then the
  // three own-site found-tiers, then (SLICE 4) found_umbrella_member, then
  // (c) stored_epost_verified — deduping by normalized email so the SAME
  // address is never offered twice under two different source tags (e.g. a
  // harvested same-domain address that happens to equal the stored,
  // provenance-backed epost).
  const brregContactCandidates = baseCandidates.filter((c) => c.source === "brreg_contact");
  const storedEpostCandidates = baseCandidates.filter((c) => c.source === "stored_epost_verified");
  const merged: OrgLinkedEmailCandidate[] = [];
  const seen = new Set<string>();
  for (const candidate of [...brregContactCandidates, ...foundCandidates, ...storedEpostCandidates]) {
    const key = candidate.email.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(candidate);
  }
  return merged;
}

/**
 * The CACHE / SINGLE-FLIGHT wrapper around harvestFoundTierCandidates() — the
 * NETWORK-DERIVED half of deriveOrgLinkedEmailCandidatesWithHarvest(). Split
 * out from its caller purely so exactly this part — the part that costs a
 * third party an HTTP request — is what the SLICE 5 / AC7 cache wraps; the
 * merge/dedup/priority logic and the DB-derived tiers stay uncached.
 *
 * DELIBERATELY NOT `async`. The whole correctness argument is that the
 * check-then-insert below happens in ONE synchronous turn: a second concurrent
 * caller for the same key must find the in-flight entry already in the Map
 * rather than race to start its own harvest. Marking this `async` would still
 * work today (an async body runs synchronously up to its first await), but it
 * would make "there must be no await between the .get and the .set" an
 * invisible invariant that the next editor can break by accident. As a plain
 * function returning a Promise, the invariant is structural. (Review finding
 * 2026-08-07: the first version of this cache stored the RESULT and wrote it
 * only after the await — 50 concurrent cold page views made 50 real fetch
 * bursts. See CLAIM_HARVEST_CACHE_TTL_MS's single-flight bullet.)
 *
 * Cache key is `${cacheKey}|${alreadyHasStoredEpost}` rather than the bare
 * provider id: alreadyHasStoredEpost is a genuine INPUT to what the harvest
 * fetches (it suppresses the umbrella attempt entirely), so a run with one
 * value must never be served from an entry produced with the other. What the
 * key deliberately omits, and why, is on _claimHarvestCache itself.
 * Caching is opt-in — no cacheKey, no read and no write, no single-flight.
 */
function resolveFoundTierCandidates(
  provider: Pick<ClaimProviderRow, "org_nr" | "brreg_verified" | "hjemmeside" | "content_source" | "field_provenance"> & {
    navn?: string;
  },
  alreadyHasStoredEpost: boolean,
  opts: { fetchImpl?: typeof fetch; cacheKey?: string },
): Promise<OrgLinkedEmailCandidate[]> {
  const cacheKey = opts.cacheKey ? `${opts.cacheKey}|${alreadyHasStoredEpost ? "1" : "0"}` : null;
  if (!cacheKey) return harvestFoundTierCandidates(provider, alreadyHasStoredEpost, opts);

  const now = Date.now();
  const hit = _claimHarvestCache.get(cacheKey);
  if (hit) {
    // Still inside the TTL — hand back the SAME promise. Whether it is still
    // in flight (concurrent caller) or long since settled (sequential caller)
    // is not something this side has to care about: awaiting a settled promise
    // just resolves, and awaiting an in-flight one joins it.
    if (hit.expiresAt > now) return hit.promise;
    _claimHarvestCache.delete(cacheKey); // expired — drop it rather than let the Map grow
  }

  // expiresAt is stamped from `now`, i.e. from when the entry is populated —
  // the same instant the previous result-caching version used, so the TTL
  // window is unchanged in length and start point.
  const entry: HarvestCacheEntry = {
    promise: harvestFoundTierCandidates(provider, alreadyHasStoredEpost, opts),
    expiresAt: now + CLAIM_HARVEST_CACHE_TTL_MS,
  };
  _claimHarvestCache.set(cacheKey, entry);
  // A FAILED harvest must not be cached for 12 minutes, and a settled-rejected
  // promise must not sit in the Map rethrowing the same stale error at every
  // later caller: drop the entry so the next request gets a fresh attempt. The
  // identity check matters — by the time this runs the entry may already have
  // been evicted and replaced (expiry, or __resetClaimHarvestCacheForTesting
  // plus a new call), and deleting somebody else's live entry would silently
  // undo their single-flight.
  entry.promise.catch(() => {
    if (_claimHarvestCache.get(cacheKey) === entry) _claimHarvestCache.delete(cacheKey);
  });
  return entry.promise;
}

/**
 * The actual network work: the three own-site found tiers, plus the SLICE 4
 * found_umbrella_member fallback, in that order. Never consults or writes the
 * cache — resolveFoundTierCandidates() above owns that entirely, so this
 * function is exactly "one harvest", which is what single-flight de-duplicates.
 */
async function harvestFoundTierCandidates(
  provider: Pick<ClaimProviderRow, "org_nr" | "brreg_verified" | "hjemmeside" | "content_source" | "field_provenance"> & {
    navn?: string;
  },
  alreadyHasStoredEpost: boolean,
  opts: { fetchImpl?: typeof fetch },
): Promise<OrgLinkedEmailCandidate[]> {
  const fetchImpl = resolveHarvestFetchImpl(opts.fetchImpl);

  const brregOk = !!provider.org_nr && provider.brreg_verified === 1;
  const canHarvest = brregOk && !!provider.hjemmeside && isHjemmesideOwnershipVerified(provider);
  const harvestCandidates = canHarvest
    ? pickHarvestCandidatesByTier(await harvestFoundOrgEmails(provider.hjemmeside as string, fetchImpl))
    : [];

  // SLICE 4 / AC5 — found_umbrella_member, a FALLBACK below the three
  // own-site found-tiers, attempted only when BOTH:
  //   (1) the own-site harvest above found literally nothing
  //       (harvestCandidates.length === 0) — a provider whose own site
  //       already produced an address never needs its umbrella; and
  //   (2) there isn't already an independently-verified stored_epost_
  //       verified candidate — that tier's provenance is one-time-manual or
  //       delivered-outreach, both stronger evidence than a freshly-scraped,
  //       name-matched guess off someone else's page (same "don't spend a
  //       fetch when it can't change the outcome" discipline
  //       deriveOrgLinkedEmailCandidatesWithOutreachLookup's own doc comment
  //       already applies to its RFB-DB lookup, just applied here to the
  //       umbrella fetch instead).
  // See harvestUmbrellaMemberEmail()'s own doc comment for the full
  // attribution/hard-exclusion rationale.
  const umbrellaCandidate =
    harvestCandidates.length === 0 && !alreadyHasStoredEpost && provider.navn
      ? await harvestUmbrellaMemberEmail({ navn: provider.navn, org_nr: provider.org_nr }, { fetchImpl })
      : null;

  // A ZERO-candidate result is cached too, deliberately (it resolves, so the
  // wrapper keeps its entry): "this producer's site published nothing usable"
  // is exactly the answer a reload loop would otherwise re-fetch forever, and
  // it is the MAJORITY case in the measured cohort. Not caching negatives
  // would leave the amplification hole open for most of the 87 producers. A
  // zero-candidate result is NOT a failure — only a thrown error is, and only
  // that evicts the entry.
  return [...harvestCandidates, ...(umbrellaCandidate ? [umbrellaCandidate] : [])];
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
  source:
    | "brreg_contact"
    | "verified_domain_address"
    | "stored_epost_verified"
    | "found_same_domain"
    | "found_contact_page"
    | "found_site_other"
    | "found_umbrella_member";
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
// re-validated here against a FRESH deriveOrgLinkedEmailCandidatesWithHarvest()
// call, not trusted as-is, so a caller can never steer a link to any address
// beyond this provider's own already-qualified set.
//
// SLICE 5 / AC7 (2026-08-07): this function is now ASYNC, and derives from
// deriveOrgLinkedEmailCandidatesWithHarvest() — the harvest-aware list —
// instead of the sync deriveOrgLinkedEmailCandidatesWithOutreachLookup().
// That is deliberately the SAME list the public entry page renders its radio
// options from, so a producer picking a found-tier address there validates
// against the same set here (before this, a found-tier selection could not
// exist at all; now it can, and both halves must agree about it). "Fresh"
// still means fresh in the sense that matters: the DB-derived tiers are
// re-read from SQLite on every single call, and only the network-derived
// tiers can come from the ≤12-minute in-process cache — see
// CLAIM_HARVEST_CACHE_TTL_MS. `provider.id` is the cache key, shared with the
// GET entry route so the page and the POST it submits to cannot disagree.
//
// `provider.navn` reaches the umbrella tier for free here: getClaimProviderById()
// already selects `navn` (see CLAIM_PROVIDER_COLUMNS), and ClaimProviderRow
// therefore satisfies the optional `navn` in that function's own Pick — no
// threading needed.
export async function issueClaimMagicLink(
  providerId: string,
  brregContactEmail?: string | null,
  opts: { isTest?: boolean; selectedSource?: OrgLinkedEmailCandidate["source"]; fetchImpl?: typeof fetch } = {},
): Promise<IssueClaimResult> {
  const provider = getClaimProviderById(providerId);
  if (!provider) return { ok: false, error: "provider_not_found" };

  const brregOk = !!provider.org_nr && provider.brreg_verified === 1;
  if (!brregOk) return { ok: false, error: "not_brreg_verified" };

  const candidates = await deriveOrgLinkedEmailCandidatesWithHarvest(provider, brregContactEmail, {
    fetchImpl: opts.fetchImpl,
    cacheKey: provider.id,
  });
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
