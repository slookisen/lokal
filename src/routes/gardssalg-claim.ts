import express, { Router, Request, Response } from "express";
import {
  getClaimProviderById,
  getClaimProviderBySlug,
  deriveOrgLinkedEmailCandidatesWithHarvest,
  issueClaimMagicLink,
  verifyClaimToken,
  verifyGardssalgOwnerSessionToken,
  revokeClaimToken,
  updateClaimedProviderProfile,
  releaseClaimedProviderFieldLock,
  pauseOwnedProvider,
  resumeOwnedProvider,
  getOwnedVisibilityStateById,
  type OwnedVisibilityState,
  type OwnerVisibilityOutcome,
  getClaimOwnerLocks,
  CLAIM_RELEASABLE_FIELDS,
  maskEmail,
  CLAIM_MANUAL_FALLBACK_EMAIL,
  CLAIM_EDITABLE_FIELDS,
  GARDSSALG_OWNER_SESSION_COOKIE,
  type ClaimProviderRow,
} from "../services/gardssalg-claim";
import { getGardssalgOwnerStats } from "../services/gardssalg-owner-stats-service";
import { emailService } from "../services/email-service";
import { generalLimiter } from "../middleware/security";
import { ownerBookingEnableBlock, type OwnerBookingBlock } from "../services/gardssalg-booking-gate";
import { createGardssalgOwnerFeaturesRouter, gardssalgOwnerFeaturesTabOpen } from "./gardssalg-owner-features";

// ─────────────────────────────────────────────────────────────────
// GÅRDSSALG PRODUCER OWNER-CLAIM — dev-request 2026-07-21-opplevagent-
// claim-flyt-drikkeprodusenter
// ─────────────────────────────────────────────────────────────────
// REUSES the RFB rettfrabonden.com owner-portal PATTERN (src/routes/
// owner-portal.ts): magic link -> HttpOnly session cookie -> session-gated
// profile edit. Does NOT modify owner-portal.ts or any RFB behavior — this
// is a self-contained, vertical-scoped MIRROR of that pattern for the
// gårdssalg (drikkeprodusent) providers in experiences.db, following the
// SAME shape (own claim table, own session cookie, own routes) rather than
// sharing RFB's magic_links table/agents identity (which would require a
// cross-database FK and blur the two verticals' isolation — see db-factory
// .ts's "CRITICAL ISOLATION INVARIANT" doc comment).
//
// Differences from RFB's owner-portal.ts, all deliberate (see
// services/gardssalg-claim.ts's module doc for the full rationale):
//   - The claim entry page never asks the visitor to type an email. Every
//     org-linked candidate address is derived entirely server-side —
//     Daniel's "never open claiming by name alone" requirement — and only
//     MASKED forms are ever rendered, so the visitor knows where the link
//     went without the page ever carrying a full address.
//     (Was "the ONE org-linked email (Brreg contact, or
//     post@<ownership-verified-domain>)". Both halves of that are now
//     wrong: dev-request 2026-08-06-claim-produsent-velger-mottakeradresse
//     made it a LIST the producer can choose from, and dev-request
//     2026-08-06-aldri-gjett-epostadresse retired the post@<domain> guess
//     outright (slice 1) and replaced it with tiers of addresses actually
//     FOUND on the producer's own verified site / their umbrella's member
//     list (slices 2 & 4, live-wired into this route in slice 5). See
//     services/gardssalg-claim.ts's module doc for the tier list.)
//   - If no org-linked email can be derived, there is NO self-service path
//     at all: the page shows the manual-fallback contact
//     (kontakt@opplevagent.no) instead of a request form.
//   - A successful claim stamps experience_providers.content_source='claim'
//     immediately on verify (not on first edit) — see verifyClaimToken()'s
//     doc comment — which is the acceptance-critical write every
//     enrichment/retro-scan write-path already respects.
//   - Session cookie is its own name (oa_owner_session) and its own
//     table/verify function — entirely independent of rfb_owner_session.
//   - Logout performs a REAL revoke (gardssalg_claims.revoked_at), not just
//     a cookie clear (RFB's logout only clears the cookie — the token
//     itself stays a valid Bearer credential until its 7-day expiry). An
//     intentional, additive GDPR-minimum improvement scoped to this flow.

const router = Router();

const OPPLEVAGENT_BASE_URL = (process.env.OPPLEVAGENT_BASE_URL || "https://opplevagent.no").replace(/\/$/, "");

// ── Host isolation + rate limit (dev-request 2026-10-17-integrasjonstest-
// oppfolging, I-U; FUNN gardssalg-claim-request-uten-limiter) ─────────────
// index.ts mounts this router at "/" ahead of the opplevagent.no gate and
// every limiter. It used to answer on every host — rettfrabonden.com served
// the claim pages (live 2026-10-17: «Fant ikke produsent — Opplevagent» on
// RFB) — and no IP limiter covered it: the entry page and the link request
// below harvest the producer's own website, the request also sends an e-mail,
// and the /api/opplevelser/gardssalg-claim/* routes answer before index.ts's
// app.use("/api", generalLimiter). Two parts:
//   - gardssalgClaimHostGate, mounted by index.ts on
//     GARDSSALG_CLAIM_PATH_PREFIXES above the finn-tannlege.com gate. The
//     claim paths are served on opplevagent.no only. Any other host
//     (rettfrabonden.com, finn-tannlege.com, www.opplevagent.no, a fly.dev
//     name) gets a 301 to the same path and query on https://opplevagent.no
//     for GET/HEAD, so an old link still lands, and a 404 for any other
//     method. The router is never reached there, so nothing is looked up,
//     harvested or sent. The links already name that host: the e-mailed
//     verify link is built on OPPLEVAGENT_BASE_URL, which is
//     https://opplevagent.no in prod, and the produsent pages link here
//     relatively from opplevagent.no. The target is fixed, as in the
//     opplevagent.no gate's own www redirect, so a request's Host never
//     chooses where it is sent.
//   - generalLimiter, the shared instance, is the first handler of every
//     route below — before the body parsers, as on the gårdssalg booking
//     form post in experiences-seo.ts (I-T). One quota per client with /api,
//     /sok and /reise. On the route rather than router-wide, so only a
//     request a claim route serves is counted here, once; an unmatched
//     /api/opplevelser/gardssalg-claim/* path falls through to the "/api"
//     mount and is counted there instead. ac2LimitersFor (client-ip.ts)
//     counts these paths as general. The per-provider limit in the claim
//     service is unchanged; this is the per-client limit in front of it.
export const GARDSSALG_CLAIM_HOST = "opplevagent.no";
export const GARDSSALG_CLAIM_PATH_PREFIXES = ["/kategori/gardssalg/eier", "/api/opplevelser/gardssalg-claim"];

export const gardssalgClaimHostGate: express.RequestHandler = (req, res, next) => {
  if (req.hostname === GARDSSALG_CLAIM_HOST) return next();
  if (req.method === "GET" || req.method === "HEAD") {
    return res.redirect(301, `https://${GARDSSALG_CLAIM_HOST}${req.originalUrl}`);
  }
  res.status(404).json({ success: false, error: "not_found" });
};

// ── Owner-portal save receipt (dev-request 2026-08-03-eierportal-lagre-
// knapp-henger) ─────────────────────────────────────────────────────────
// Diagnosis: the portal's save button previously depended on a fetch's
// .then/.catch BOTH settling to ever leave "Lagrer ..." — one branch showed
// the receipt via a full-page redirect (`?status=saved`), the other reset
// the button on a rejection. Live reproduction wasn't possible from this
// session (the portal requires a real magic-link session and this session
// has no mailbox to receive one — the same structural blocker documented in
// the sibling dev-request 2026-08-03-claim-reinnlogging-kan-ikke-testes),
// but the reported symptom (server-side write succeeded, button frozen on
// "Lagrer ...", no receipt, no error) is only explained by the fetch
// promise never settling at all — network layer completes the request
// server-side (hence the write happens) but the browser's callback never
// runs (e.g. a dropped connection after the response was sent, or a
// backgrounded/suspended tab on mobile deferring the callback
// indefinitely). Neither existing branch can fire in that case, since both
// require the promise to settle. Fixed two ways, independent of the exact
// trigger: (1) the receipt no longer depends on a second round-trip (a
// full-page redirect) succeeding — it renders directly from the POST's own
// response; (2) a client-side watchdog timeout guarantees the button is
// never permanently stuck, regardless of whether the fetch promise ever
// settles.
//
// `describeSaveOutcome` is pure (no DOM/fetch) so it's unit-testable
// directly in Node, and is shipped to the browser via
// `describeSaveOutcome.toString()` in the inline <script> below — the
// tested code IS the code that runs in the browser, no hand-copied,
// driftable duplicate. Must stay dependency-free for that to work.
export function describeSaveOutcome(ok: boolean, body: any): { success: boolean; message: string } {
  if (ok && body && body.success === true) {
    // G1 pkt 2: nothing differed from what was stored -> say so honestly.
    if (Array.isArray(body.updated_fields) && body.updated_fields.length === 0 &&
        !(Array.isArray(body.skipped_fields) && body.skipped_fields.length > 0)) {
      return { success: true, message: "Ingen endringer å lagre." };
    }
    return { success: true, message: "Endringene er lagret." };
  }
  // 409 booking_blocked (dev-request 2026-10-22-opplevagent-mine-valg-
  // gardssalg, G1 item 3): show the server's Norwegian reason, HTML-escaped
  // here because the receipt is inserted with innerHTML.
  if (body && body.error === "booking_blocked" && typeof body.message === "string" && body.message) {
    var safe = body.message.replace(/[&<>"']/g, function (c: string) {
      return c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#039;";
    });
    return { success: false, message: safe };
  }
  return { success: false, message: "Klarte ikke å lagre. Prøv igjen." };
}

// Safety-net timeout for the watchdog described above.
const GC_SAVE_WATCHDOG_MS = 15000;

function escapeHtml(text: string): string {
  const map: { [key: string]: string } = {
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;",
  };
  return String(text ?? "").replace(/[&<>"']/g, (char) => map[char]);
}

// ── Booking switch state for the portal (G1 item 3) ─────────────────────────
// Why the owner cannot switch booking ON right now, or null. Only relevant
// while booking is off: the admin brake always sets booking_live=0.
function portalBookingBlock(provider: ClaimProviderRow): OwnerBookingBlock | null {
  if (provider.booking_live === 1) return null;
  return ownerBookingEnableBlock(provider);
}

function bookingBlockAlertHtml(block: OwnerBookingBlock): string {
  if (block.reason === "admin_brake") {
    return `<div class="gc-alert gc-alert-error" role="alert" data-booking-state="stopped_by_opplevagent">
      <strong>Booking er stanset av Opplevagent.</strong>
      ${block.note ? `Grunn: ${escapeHtml(block.note)}.` : ""}
      Du kan ikke slå booking på igjen selv. Ta kontakt med ${CLAIM_MANUAL_FALLBACK_EMAIL}.
    </div>`;
  }
  return `<div class="gc-alert gc-alert-error" role="alert" data-booking-state="needs_booking_email">${escapeHtml(block.message)}</div>`;
}

// ── Cookie parsing (no new deps — same fallback approach as owner-portal.ts
// when cookie-parser middleware isn't mounted) ─────────────────────────────
function parseCookieHeader(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const pair of header.split(";")) {
    const idx = pair.indexOf("=");
    if (idx < 0) continue;
    const name = pair.slice(0, idx).trim();
    const value = pair.slice(idx + 1).trim();
    if (!name) continue;
    try { out[name] = decodeURIComponent(value); } catch { out[name] = value; }
  }
  return out;
}

function readSessionCookie(req: Request): string | undefined {
  const fromMiddleware = (req as any).cookies?.[GARDSSALG_OWNER_SESSION_COOKIE] as string | undefined;
  if (fromMiddleware) return fromMiddleware;
  const parsed = parseCookieHeader(req.headers.cookie as string | undefined);
  return parsed[GARDSSALG_OWNER_SESSION_COOKIE];
}

export function sessionFromRequest(req: Request): { valid: boolean; providerId?: string; token?: string } {
  const cookieToken = readSessionCookie(req);
  if (cookieToken) {
    const s = verifyGardssalgOwnerSessionToken(cookieToken);
    if (s.valid) return s;
  }
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith("Bearer ")) {
    const s = verifyGardssalgOwnerSessionToken(authHeader.substring(7));
    if (s.valid) return s;
  }
  return { valid: false };
}

// ─────────────────────────────────────────────────────────────────
// Page shell — teal/gårdssalg theme, mirrors experiences-seo.ts's produsent
// hero colors (#0f5a50/#0e3c36) and owner-portal.ts's shell structure
// (noindex, PWA service-worker registration skipped — this IS opplevagent.no
// so the existing sw.js exclusion regex in owner-portal.ts's shell doesn't
// even apply here; this page just never registers one).
// ─────────────────────────────────────────────────────────────────
const SHELL_CSS = `
  *, *::before, *::after { box-sizing: border-box; }
  body { margin: 0; background: #f4f1ea; color: #1a1a1a; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; line-height: 1.6; }
  a { color: #0f5a50; }
  .gc-shell { max-width: 720px; margin: 0 auto; padding: 24px 16px 80px; }
  .gc-topbar { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 24px; }
  .gc-logo { font-size: 1.15rem; font-weight: 700; color: #0f5a50; text-decoration: none; }
  .gc-card { background: #fff; border: 1px solid #e5e0d3; border-radius: 10px; padding: 24px 20px; margin-bottom: 20px; box-shadow: 0 1px 3px rgba(0,0,0,0.05); }
  .gc-card h1 { font-size: 1.4rem; color: #0f5a50; margin: 0 0 12px; }
  .gc-card h2 { font-size: 1.1rem; color: #0f5a50; margin: 0 0 12px; padding-bottom: 8px; border-bottom: 1px solid #f0ede2; }
  .gc-card p { margin: 8px 0; }
  .gc-field { margin-bottom: 16px; }
  .gc-field label { display: block; font-size: 0.92rem; font-weight: 600; color: #404040; margin-bottom: 6px; }
  .gc-field input, .gc-field textarea {
    width: 100%; min-height: 44px; padding: 10px 12px; font-size: 1rem; font-family: inherit;
    color: #1a1a1a; background: #fff; border: 1px solid #d4d4d4; border-radius: 8px;
  }
  .gc-field textarea { min-height: 96px; resize: vertical; }
  .gc-field input:focus, .gc-field textarea:focus { outline: 2px solid #0f5a50; outline-offset: 1px; border-color: #0f5a50; }
  .gc-field .gc-hint { font-size: 0.78rem; color: #737373; margin-top: 4px; }
  .gc-btn { display: inline-flex; align-items: center; justify-content: center; min-height: 44px; padding: 10px 20px; font-size: 1rem; font-weight: 600; border: none; border-radius: 8px; cursor: pointer; text-decoration: none; }
  .gc-btn-primary { background: #0f5a50; color: #fff; }
  .gc-btn-primary:hover, .gc-btn-primary:focus { background: #0e3c36; }
  .gc-btn-secondary { background: #fff; color: #0f5a50; border: 1px solid #0f5a50; }
  .gc-btn-ghost { background: transparent; color: #737373; }
  .gc-btn-ghost:hover { color: #dc2626; }
  .gc-alert { padding: 12px 14px; border-radius: 8px; margin-bottom: 16px; font-size: 0.92rem; }
  .gc-alert-error { background: #fef2f2; color: #991b1b; border: 1px solid #fecaca; }
  .gc-alert-ok { background: #f0fdf4; color: #166534; border: 1px solid #bbf7d0; }
  .gc-form-actions { display: flex; gap: 12px; flex-wrap: wrap; margin-top: 8px; }
  .gc-stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 12px; }
  .gc-stat { background: #f4f1ea; border: 1px solid #ece6d4; border-radius: 8px; padding: 12px; text-align: center; }
  .gc-stat-num { font-size: 1.5rem; font-weight: 700; color: #0f5a50; }
  .gc-stat-label { font-size: 0.78rem; color: #737373; }
  .gc-toggle-row { display: flex; align-items: center; gap: 10px; }
  .gc-lock-note { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-top: 6px; font-size: 0.82rem; color: #525252; }
  .gc-btn-small { padding: 8px 14px; font-size: 0.88rem; }
  @media (max-width: 480px) { .gc-card { padding: 18px 14px; } .gc-card h1 { font-size: 1.25rem; } }
`;

function shell(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="nb">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="robots" content="noindex,nofollow">
  <title>${escapeHtml(title)} — Opplevagent</title>
  <style>${SHELL_CSS}</style>
</head>
<body>
  <div class="gc-shell">
    <div class="gc-topbar">
      <a href="/" class="gc-logo">opplevagent.no</a>
    </div>
    ${body}
  </div>
</body>
</html>`;
}

function notFoundPage(): string {
  return shell("Fant ikke produsent", `<div class="gc-card">
    <h1>Fant ikke produsent</h1>
    <p>Vi finner ingen gårdssalg-produsent med denne lenken. Gå tilbake til <a href="/kategori/gardssalg">Gårdssalg og smaking</a>.</p>
  </div>`);
}

function manualFallbackBlock(): string {
  return `<div class="gc-card">
    <h1>Er dette din bedrift?</h1>
    <p>Vi kan ikke bekrefte automatisk at du representerer denne produsenten ennå. Ta kontakt med
      <a href="mailto:${CLAIM_MANUAL_FALLBACK_EMAIL}">${CLAIM_MANUAL_FALLBACK_EMAIL}</a>, så verifiserer vi eierskapet manuelt.</p>
  </div>`;
}

// ─────────────────────────────────────────────────────────────────
// GET /kategori/gardssalg/eier/magic-link-verify?token=... — validate,
// mark used, stamp content_source='claim' (verifyClaimToken), set session
// cookie, redirect to the portal.
//
// MUST be registered BEFORE the /:providerSlug route below — Express
// matches routes in registration order, and "magic-link-verify" would
// otherwise be swallowed by :providerSlug (and 404, since no provider has
// that slug) rather than ever reaching this handler.
// ─────────────────────────────────────────────────────────────────
router.get("/kategori/gardssalg/eier/magic-link-verify", generalLimiter, (req: Request, res: Response) => {
  try {
    const { token } = req.query;
    if (!token || typeof token !== "string") {
      return res.redirect(302, "/kategori/gardssalg?error=invalid_token");
    }
    const result = verifyClaimToken(token);
    if (!result.valid || !result.providerId) {
      return res.redirect(302, "/kategori/gardssalg?error=invalid_token");
    }

    res.cookie(GARDSSALG_OWNER_SESSION_COOKIE, result.token, {
      path: "/",
      maxAge: 7 * 24 * 60 * 60 * 1000,
      httpOnly: true,
      secure: true,
      sameSite: "lax",
    });

    const provider = getClaimProviderById(result.providerId);
    const target = provider?.slug ? `/kategori/gardssalg/eier/${encodeURIComponent(provider.slug)}/portal` : "/kategori/gardssalg";
    return res.redirect(302, target);
  } catch (err) {
    console.error("[gardssalg-claim] magic-link-verify error:", err);
    return res.redirect(302, "/kategori/gardssalg?error=verify_failed");
  }
});

// ─────────────────────────────────────────────────────────────────
// GET /kategori/gardssalg/eier/:providerSlug — unauthenticated claim entry
// point ("Er dette din bedrift?"). Never asks for a typed email — the
// eligible org-linked address (if any) is derived server-side.
// ─────────────────────────────────────────────────────────────────
// ASYNC since dev-request 2026-08-06-aldri-gjett-epostadresse SLICE 5 / AC7:
// the candidate derivation below now performs the found-address harvest,
// which is IO. The handler keeps the SAME single top-level try/catch this
// file uses on every other page-rendering handler (see magic-link-verify
// above and .../portal below) — an `await` inside a try block is caught by
// that block exactly like a synchronous throw was, so the 500-page fallback
// and its console.error line are unchanged, not re-invented.
router.get("/kategori/gardssalg/eier/:providerSlug", generalLimiter, async (req: Request, res: Response) => {
  try {
    const slug = String((req.params as any).providerSlug || "");
    const provider = getClaimProviderBySlug(slug);
    if (!provider) return res.status(404).send(notFoundPage());

    // Must mirror issueClaimMagicLink()'s own derivation exactly — otherwise
    // this page could show the "send me a link" form for a provider whose
    // POST would then fail (or vice versa: show the fallback for a provider
    // the POST would actually succeed for). Same harvest-aware wrapper
    // issueClaimMagicLink() uses, with the SAME cacheKey (provider.id), so
    // the two halves cannot disagree AND a repeat page view inside the
    // harvest TTL costs the producer's website nothing — see
    // CLAIM_HARVEST_CACHE_TTL_MS's own comment in services/gardssalg-claim.ts
    // for why that cache exists and why this UNAUTHENTICATED route is the
    // reason it exists. Candidates form (dev-request 2026-08-06-claim-
    // produsent-velger-mottakeradresse) — 0/1/2+ are the three cases below.
    const candidates = await deriveOrgLinkedEmailCandidatesWithHarvest(provider, undefined, { cacheKey: provider.id });
    const backUrl = provider.slug ? `/kategori/gardssalg/produsent/${encodeURIComponent(provider.slug)}` : "/kategori/gardssalg";

    const status = String(req.query.status || "");
    const reason = String(req.query.reason || "");
    let alert = "";
    if (status === "sent") {
      alert = `<div class="gc-alert gc-alert-ok" role="status">Vi har sendt en innloggingslenke. Sjekk e-posten (også søppelpost). Lenken er gyldig i 7 dager.</div>`;
    } else if (status === "error") {
      const msg = reason === "rate_limited"
        ? "For mange forsøk. Prøv igjen om en time."
        : reason === "selection_required"
        ? "Velg en adresse under."
        : reason === "invalid_selection"
        ? "Det valget er ikke lenger gyldig. Velg på nytt."
        : "Kunne ikke sende lenke. Prøv igjen senere, eller kontakt kontakt@opplevagent.no.";
      alert = `<div class="gc-alert gc-alert-error" role="alert">${escapeHtml(msg)}</div>`;
    }

    if (candidates.length === 0) {
      return res.send(shell("Er dette din bedrift?", `${alert}${manualFallbackBlock()}
        <div class="gc-card"><a href="${escapeHtml(backUrl)}" class="gc-btn gc-btn-secondary">Tilbake til profilen</a></div>`));
    }

    // Exactly one candidate: unchanged from before this dev-request — same
    // markup, same single-button flow, no selection concept at all (AC3).
    const addressChoiceHtml = candidates.length === 1
      ? `<p>Vi sender en innloggingslenke til <strong>${escapeHtml(maskEmail(candidates[0].email))}</strong> — adressen vi har registrert for
          <strong>${escapeHtml(provider.navn)}</strong> hos Brønnøysundregistrene/på deres verifiserte nettside.</p>`
      // Two or more: producer picks. The value posted back is the SOURCE TAG
      // ("verified_domain_address" etc.), never the address itself — the
      // masked text is display-only and the full address never reaches the
      // page's HTML/JS in any form (AC4). issueClaimMagicLink() re-derives
      // and re-validates the tag server-side (AC5) — the client's choice of
      // WHICH candidate is trusted, never a value naming an address.
      : `<p>Vi fant flere adresser registrert for <strong>${escapeHtml(provider.navn)}</strong>. Velg hvor
          innloggingslenken skal sendes:</p>
         <div class="gc-field" role="radiogroup" aria-label="Velg mottakeradresse">
           ${candidates
             .map(
               (c, i) => `<label style="display:flex;align-items:center;gap:8px;font-weight:400;margin:6px 0;">
             <input type="radio" name="selected" value="${escapeHtml(c.source)}" ${i === 0 ? "checked" : ""} style="width:auto;min-height:0;">
             ${escapeHtml(maskEmail(c.email))}
           </label>`,
             )
             .join("")}
         </div>`;

    const body = `
      <div class="gc-card">
        <h1>Er dette din bedrift?</h1>
        <form id="gc-request-form" method="post" action="/kategori/gardssalg/eier/${encodeURIComponent(provider.id)}/request" novalidate>
          ${addressChoiceHtml}
          ${alert}
          <div class="gc-form-actions">
            <button type="submit" class="gc-btn gc-btn-primary">Send meg tilgangslenke</button>
            <a href="${escapeHtml(backUrl)}" class="gc-btn gc-btn-secondary">Tilbake til profilen</a>
          </div>
        </form>
      </div>
      <div class="gc-card">
        <h2>Ikke riktig adresse?</h2>
        <p>Hvis du ikke har tilgang til denne adressen, kontakt <a href="mailto:${CLAIM_MANUAL_FALLBACK_EMAIL}">${CLAIM_MANUAL_FALLBACK_EMAIL}</a> for manuell verifisering.</p>
      </div>
      <script>
      (function () {
        var form = document.getElementById("gc-request-form");
        if (!form || !window.fetch) return;
        form.addEventListener("submit", function (ev) {
          ev.preventDefault();
          var btn = form.querySelector("button[type=submit]");
          if (btn) { btn.disabled = true; btn.textContent = "Sender ..."; }
          var selectedInput = form.querySelector('input[name="selected"]:checked');
          var payload = selectedInput ? { selected: selectedInput.value } : {};
          fetch(form.action, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) })
            .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, body: j }; }); })
            .then(function (out) {
              var base = window.location.pathname;
              if (out.ok && out.body && out.body.success) {
                window.location.href = base + "?status=sent";
              } else {
                var reason = (out.body && out.body.error) || "internal_error";
                window.location.href = base + "?status=error&reason=" + encodeURIComponent(reason);
              }
            }).catch(function () {
              if (btn) { btn.disabled = false; btn.textContent = "Send meg tilgangslenke"; }
            });
        });
      })();
      </script>
    `;
    return res.send(shell("Er dette din bedrift?", body));
  } catch (err) {
    console.error("[gardssalg-claim] GET /kategori/gardssalg/eier/:providerSlug error:", err);
    return res.status(500).send(shell("Feil", `<div class="gc-card"><h1>Noe gikk galt</h1><p>Prøv igjen senere.</p></div>`));
  }
});

// ─────────────────────────────────────────────────────────────────
// POST /kategori/gardssalg/eier/:providerId/request — issues the magic link
// (works both as a plain no-JS form POST and as the JS-fetch target above;
// response shape adapts to Accept/Content-Type like RFB's dual routes).
// ─────────────────────────────────────────────────────────────────
// Runtime allow-list mirroring OrgLinkedEmailCandidate["source"] — the ONLY
// values issueClaimMagicLink() will ever accept as opts.selectedSource. Any
// other posted "selected" value (typo, stale page, hostile client) is
// treated as no selection at all, never forwarded — the union type alone is
// a compile-time guarantee, not a runtime one, since req.body is unknown().
// SLICE 5 / AC7 (2026-08-07) — the four found-tiers ARE now in this list,
// because deriveOrgLinkedEmailCandidatesWithHarvest() is now what both this
// route and the GET entry page above derive from, so a harvested candidate
// really can be rendered as a radio option here. (The slice-2 version of this
// comment warned that whoever wired the harvest in had to extend this list at
// the same time or a harvested selection would silently fail to register —
// this is that extension.)
//
// "verified_domain_address" stays for exactly the reason gardssalg-claim.ts's
// module doc gives: it is still a valid member of the OrgLinkedEmailCandidate
// union and a valid HISTORICAL email_source value, and keeping it here costs
// nothing — no live derivation can produce it, so a client naming it still
// lands on issueClaimMagicLink()'s "invalid_selection" (there is no such
// candidate to match), which is what the j2 regression test pins.
const CLAIM_EMAIL_SOURCES = [
  "brreg_contact",
  "verified_domain_address",
  "stored_epost_verified",
  "found_same_domain",
  "found_contact_page",
  "found_site_other",
  "found_umbrella_member",
] as const;
function parseSelectedSource(value: unknown): (typeof CLAIM_EMAIL_SOURCES)[number] | undefined {
  return typeof value === "string" && (CLAIM_EMAIL_SOURCES as readonly string[]).includes(value)
    ? (value as (typeof CLAIM_EMAIL_SOURCES)[number])
    : undefined;
}

router.post(
  "/kategori/gardssalg/eier/:providerId/request",
  generalLimiter,
  express.json(),
  express.urlencoded({ extended: false }),
  // ASYNC since SLICE 5 / AC7 — issueClaimMagicLink() is now async (it can
  // harvest). The awaited call is wrapped in the same shape as this file's
  // other handlers' try/catch: log with the `[gardssalg-claim]` prefix, then
  // answer in whichever of the two response shapes this dual route is being
  // used in. Express 5 would already funnel a rejected handler promise to its
  // default error handler (a bare 500 HTML page) even without this, so the
  // catch is not load-bearing for correctness — it exists so the JS-fetch
  // client above gets a parseable `{success:false, error}` body it can turn
  // into the page's own generic "Kunne ikke sende lenke ..." alert, instead
  // of an HTML error page it would fail to JSON-parse and silently swallow.
  async (req: Request, res: Response) => {
    const providerId = String((req.params as any).providerId || "");
    const wantsJson = (req.headers["content-type"] || "").includes("application/json") || (req.headers.accept || "").includes("application/json");
    const selectedSource = parseSelectedSource((req.body as any)?.selected);

    const provider = getClaimProviderById(providerId);
    const redirectBase = provider?.slug ? `/kategori/gardssalg/eier/${encodeURIComponent(provider.slug)}` : null;

    let result: Awaited<ReturnType<typeof issueClaimMagicLink>>;
    try {
      result = await issueClaimMagicLink(providerId, undefined, { selectedSource });
    } catch (err) {
      console.error("[gardssalg-claim] POST /kategori/gardssalg/eier/:providerId/request error:", err);
      if (wantsJson) return res.status(500).json({ success: false, error: "internal_error" });
      if (!redirectBase) return res.status(404).send(notFoundPage());
      return res.redirect(303, `${redirectBase}?status=error&reason=internal_error`);
    }

    if (!result.ok) {
      const status =
        result.error === "provider_not_found" ? 404 : result.error === "rate_limited" ? 429 : result.error === "selection_required" ? 400 : 403;
      if (wantsJson) return res.status(status).json({ success: false, error: result.error });
      if (!redirectBase) return res.status(404).send(notFoundPage());
      return res.redirect(303, `${redirectBase}?status=error&reason=${encodeURIComponent(result.error)}`);
    }

    const verifyUrl = `${OPPLEVAGENT_BASE_URL}/kategori/gardssalg/eier/magic-link-verify?token=${result.claim.token}`;
    emailService
      .sendGardssalgClaimMagicLink({
        to: result.claim.email,
        providerName: provider?.navn || "din profil",
        verifyUrl,
        // Always false on this public route (issueClaimMagicLink above is
        // called with no opts, so result.claim.isTest can only be false here).
        // Read from the claim row rather than hardcoded so the admin test
        // route below shares this exact send path.
        isTestSend: result.claim.isTest,
      })
      .then((emailResult) => {
        if (!emailResult.success) {
          console.error(`[gardssalg-claim] Failed to send magic link email for provider ${providerId}`);
        }
      })
      .catch((e) => console.error("[gardssalg-claim] sendGardssalgClaimMagicLink error:", e));

    if (wantsJson) {
      return res.json({ success: true, maskedEmail: result.claim.maskedEmail, message: "Innloggingslenke sendt." });
    }
    if (!redirectBase) return res.status(404).send(notFoundPage());
    return res.redirect(303, `${redirectBase}?status=sent`);
  },
);

// ─────────────────────────────────────────────────────────────────
// GET /kategori/gardssalg/eier/:providerSlug/portal — session-gated edit page.
// ─────────────────────────────────────────────────────────────────
router.get("/kategori/gardssalg/eier/:providerSlug/portal", generalLimiter, (req: Request, res: Response) => {
  try {
    const slug = String((req.params as any).providerSlug || "");
    const provider = getClaimProviderBySlug(slug);
    if (!provider) return res.status(404).send(notFoundPage());

    const session = sessionFromRequest(req);
    if (!session.valid) {
      return res.redirect(302, `/kategori/gardssalg/eier/${encodeURIComponent(slug)}`);
    }
    if (session.providerId !== provider.id) {
      return res.status(403).send(shell("Ingen tilgang", `<div class="gc-card">
        <h1>Ingen tilgang</h1>
        <p>Sesjonen din er knyttet til en annen produsent. <a href="/kategori/gardssalg/eier/${encodeURIComponent(slug)}">Logg inn på nytt</a>.</p>
      </div>`));
    }

    const status = String(req.query.status || "");
    let alert = "";
    if (status === "saved") alert = `<div class="gc-alert gc-alert-ok" role="status">Endringene er lagret.</div>`;
    else if (status === "error") alert = `<div class="gc-alert gc-alert-error" role="alert">Klarte ikke å lagre. Prøv igjen.</div>`;
    else if (status === "booking_blocked") alert = `<div class="gc-alert gc-alert-error" role="alert">Booking ble ikke slått på. Ingen endringer er lagret.</div>`;
    else if (status === "released") alert = `<div class="gc-alert gc-alert-ok" role="status">Opplevagent kan nå oppdatere feltet igjen.</div>`;
    else if (status === "paused") alert = `<div class="gc-alert gc-alert-ok" role="status">Profilen er satt på pause og vises ikke offentlig.</div>`;
    else if (status === "resumed") alert = `<div class="gc-alert gc-alert-ok" role="status">Profilen er synlig igjen.</div>`;
    else if (status === "visibility_error") alert = `<div class="gc-alert gc-alert-error" role="alert">Klarte ikke å endre synligheten. Prøv igjen.</div>`;
    else if (status === "release_error") alert = `<div class="gc-alert gc-alert-error" role="alert">Klarte ikke å gi tilbake feltet. Prøv igjen.</div>`;

    // content_source='manual' locks the content fields only; the booking
    // switch is the owner's consent and follows the shared gate instead.
    const locked = provider.content_source === "manual";
    const bookingBlock = portalBookingBlock(provider);
    const bookingDisabled = !!bookingBlock;
    const nothingEditable = locked && bookingDisabled;
    let products: string[] = [];
    try { const p = JSON.parse(provider.products || "[]"); if (Array.isArray(p)) products = p.filter((x) => typeof x === "string"); } catch { /* ignore */ }

    // G1 pkt 2: per-field lock note + «gi tilbake» button. The button submits
    // its OWN form (#gc-release-form, outside the profile form) via the
    // form="" attribute, so Enter in a profile input always hits «Lagre»
    // (implicit submission picks the profile form's own first submit button).
    const ownerLocks = getClaimOwnerLocks(provider);
    const releaseAction = `/kategori/gardssalg/eier/${encodeURIComponent(slug)}/release-field`;
    const lockNote = (field: string): string => {
      if (locked || !Object.prototype.hasOwnProperty.call(ownerLocks, field)) return "";
      if (ownerLocks[field].locked_by === "admin") {
        return `<div class="gc-lock-note" data-lock-field="${field}">Opplevagent-support har låst dette feltet.</div>`;
      }
      return `<div class="gc-lock-note" data-lock-field="${field}"><span>Du har skrevet dette selv, så Opplevagent endrer det ikke.</span>` +
        `<button type="submit" form="gc-release-form" class="gc-btn gc-btn-secondary gc-btn-small" name="release_field" value="${field}">La Opplevagent oppdatere dette</button></div>`;
    };

    const body = `
      <div class="gc-card">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;">
          <h1 style="margin:0;">${escapeHtml(provider.navn)}</h1>
          <form method="post" action="/kategori/gardssalg/eier/${encodeURIComponent(slug)}/logout" style="margin:0;">
            <button type="submit" class="gc-btn gc-btn-ghost">Logg ut</button>
          </form>
        </div>
        <p>Rediger profilen din for Gårdssalg og smaking.</p>
        ${alert}
        ${locked ? `<div class="gc-alert gc-alert-error" role="alert">Teksten i denne profilen er låst av Opplevagent-support. Kontakt ${CLAIM_MANUAL_FALLBACK_EMAIL} for å endre den. Booking kan du fortsatt slå av og på selv.</div>` : ""}
      </div>
      ${mineValgCardHtml(slug, provider.id)}
      <div class="gc-card">
        <h2>Profilinformasjon</h2>
        <form id="gc-profile-form" method="post" action="/kategori/gardssalg/eier/${encodeURIComponent(slug)}/save" novalidate>
          <div class="gc-field">
            <label for="f-about">Om produsenten</label>
            <textarea id="f-about" name="field_about_text" ${locked ? "disabled" : ""}>${escapeHtml(provider.about_text || "")}</textarea>
            ${lockNote("about_text")}
          </div>
          <div class="gc-field">
            <label for="f-visit">Besøket</label>
            <textarea id="f-visit" name="field_visit_text" ${locked ? "disabled" : ""}>${escapeHtml(provider.visit_text || "")}</textarea>
            ${lockNote("visit_text")}
          </div>
          <div class="gc-field">
            <label for="f-hours">Åpningstider</label>
            <input id="f-hours" name="field_opening_hours_text" type="text" value="${escapeHtml(provider.opening_hours_text || "")}" ${locked ? "disabled" : ""}>
            ${lockNote("opening_hours_text")}
          </div>
          <div class="gc-field">
            <label for="f-products">Produkter (kommaseparert)</label>
            <input id="f-products" name="field_products" type="text" value="${escapeHtml(products.join(", "))}" ${locked ? "disabled" : ""}>
            ${lockNote("products")}
          </div>
          <div class="gc-field">
            <label for="f-website">Nettside</label>
            <input id="f-website" name="field_hjemmeside" type="url" value="${escapeHtml(provider.hjemmeside || "")}" ${locked ? "disabled" : ""}>
            ${lockNote("hjemmeside")}
          </div>
          <div class="gc-field gc-toggle-row">
            <input id="f-booking" name="field_booking_live" type="checkbox" value="1" style="width:auto;min-height:0;" ${provider.booking_live ? "checked" : ""} ${bookingDisabled ? "disabled" : ""}>
            <label for="f-booking" style="margin:0;">Aktiver reservasjoner (booking) for besøkende</label>
          </div>
          ${bookingBlock ? bookingBlockAlertHtml(bookingBlock) : ""}
          <div class="gc-form-actions">
            <button type="submit" id="gc-save-btn" class="gc-btn gc-btn-primary" ${nothingEditable ? "disabled" : ""}>Lagre alle endringer</button>
            <a href="/kategori/gardssalg/produsent/${encodeURIComponent(slug)}" class="gc-btn gc-btn-secondary">Se profilen</a>
          </div>
          <div id="gc-save-status" aria-live="polite"></div>
        </form>
        <form id="gc-release-form" method="post" action="${releaseAction}"></form>
      </div>
      ${visibilityCardHtml(slug, getOwnedVisibilityStateById(provider.id) ?? "visible")}
      <div class="gc-card">
        <h2>Statistikk</h2>
        <div id="gc-stats" class="gc-stats"><div class="gc-stat"><div class="gc-stat-num">…</div><div class="gc-stat-label">Laster</div></div></div>
        <p id="gc-stats-note" style="margin-top:12px;color:#737373;font-size:0.82rem;"></p>
      </div>
      <script>
      (function () {
        fetch("/api/opplevelser/gardssalg-claim/${encodeURIComponent(provider.id)}/stats", { credentials: "same-origin" })
          .then(function (r) { return r.json(); })
          .then(function (j) {
            var el = document.getElementById("gc-stats");
            var note = document.getElementById("gc-stats-note");
            if (!el || !j || !j.success) return;
            el.innerHTML =
              '<div class="gc-stat"><div class="gc-stat-num">' + j.stats.humanViews + '</div><div class="gc-stat-label">Sidevisninger fra mennesker (' + j.stats.windowDays + ' dager)</div></div>' +
              '<div class="gc-stat" title="Ganger en AI-assistent (ChatGPT, Claude, Perplexity …) hentet siden din for noen som spurte"><div class="gc-stat-num">' + j.stats.aiSearchViews + '</div><div class="gc-stat-label">AI-søk (' + j.stats.windowDays + ' dager)</div></div>';
            // «Med i AI-søk»: among the results an AI fetched, not seen by a person; a minimum.
            // The window is the last 12 months with the public tile's label (statistikk S2d).
            var dl = j.stats.aiDeliveries;
            if (dl && dl.window && dl.allTime) {
              var dlTip = "Antall ganger profilen var blant treffene en AI-assistent som ChatGPT eller Claude hentet for noen som spurte. Forsiden telles ikke. Tallet viser ikke hvor mange som så den.";
              var dlSinceMs = dl.allTime.countingSince ? Date.parse(dl.allTime.countingSince + "T00:00:00Z") : NaN;
              var dlSince = isNaN(dlSinceMs) ? "" : new Date(dlSinceMs).toLocaleDateString("nb-NO", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
              el.innerHTML +=
                '<div class="gc-stat" title="' + dlTip + '"><div class="gc-stat-num">' + dl.window.total + '</div><div class="gc-stat-label">Med i AI-søk: ganger profilen var blant treffene en AI-assistent hentet (' + dl.windowLabel + ')</div></div>' +
                '<div class="gc-stat" title="' + dlTip + '"><div class="gc-stat-num">' + dl.allTime.total + '</div><div class="gc-stat-label">Med i AI-søk: ganger profilen var blant treffene en AI-assistent hentet (' + (dlSince ? 'siden ' + dlSince : 'hele perioden') + ')</div></div>';
            }
            if (note && j.stats.notAvailable && j.stats.notAvailable.length) {
              note.textContent = "Ikke tilgjengelig ennå: " + j.stats.notAvailable.join(", ") + ".";
            }
          }).catch(function () {});

        var gcDescribeSaveOutcome = ${describeSaveOutcome.toString()};

        var form = document.getElementById("gc-profile-form");
        if (form && window.fetch) {
          var statusEl = document.getElementById("gc-save-status");
          form.addEventListener("submit", function (ev) {
            ev.preventDefault();
            var fd = new FormData(form);
            var payload = ${locked ? "{}" : `{
              about_text: fd.get("field_about_text"),
              visit_text: fd.get("field_visit_text"),
              opening_hours_text: fd.get("field_opening_hours_text"),
              products: String(fd.get("field_products") || "").split(",").map(function (s) { return s.trim(); }).filter(Boolean),
              hjemmeside: fd.get("field_hjemmeside"),
            }`};
            payload.booking_live = fd.get("field_booking_live") ? 1 : 0;
            var btn = document.getElementById("gc-save-btn");
            var settled = false;
            function showReceipt(success, message) {
              if (statusEl) {
                statusEl.innerHTML = '<div class="gc-alert ' + (success ? "gc-alert-ok" : "gc-alert-error") +
                  '" role="' + (success ? "status" : "alert") + '">' + message + '</div>';
              }
              if (btn) { btn.disabled = false; btn.textContent = "Lagre alle endringer"; }
            }
            if (btn) { btn.disabled = true; btn.textContent = "Lagrer ..."; }
            if (statusEl) statusEl.innerHTML = "";
            // Watchdog: guarantees the button is NEVER stuck on "Lagrer ..."
            // forever, independent of whether the fetch promise below ever
            // settles (see the diagnosis note above describeSaveOutcome).
            var watchdog = setTimeout(function () {
              if (settled) return;
              settled = true;
              showReceipt(false, "Lagringen tar uventet lang tid. Prøv å laste siden på nytt for å se om endringene ble lagret.");
            }, ${GC_SAVE_WATCHDOG_MS});
            fetch("/api/opplevelser/gardssalg-claim/${encodeURIComponent(provider.id)}/update-profile", {
              method: "POST", headers: { "Content-Type": "application/json" }, credentials: "same-origin",
              body: JSON.stringify(payload),
            }).then(function (r) { return r.json().then(function (j) { return { ok: r.ok, body: j }; }); })
              .then(function (out) {
                if (settled) return;
                settled = true;
                clearTimeout(watchdog);
                var outcome = gcDescribeSaveOutcome(out.ok, out.body);
                showReceipt(outcome.success, outcome.message);
              }).catch(function () {
                if (settled) return;
                settled = true;
                clearTimeout(watchdog);
                showReceipt(false, "Klarte ikke å lagre. Prøv igjen.");
              });
          });
        }
      })();
      </script>
    `;
    return res.send(shell(`Eierportal · ${provider.navn}`, body));
  } catch (err) {
    console.error("[gardssalg-claim] GET portal error:", err);
    return res.status(500).send(shell("Feil", `<div class="gc-card"><h1>Noe gikk galt</h1><p>Prøv igjen senere.</p></div>`));
  }
});

// «Mine valg» tab (dev-request 2026-10-22-opplevagent-mine-valg-gardssalg,
// O1a): a link card, only while the tab is open for this producer
// (OA_OWNER_FEATURES_ENABLED + allowlist + test producer). Otherwise nothing
// is added and the portal is exactly as before.
function mineValgCardHtml(slug: string, providerId: string): string {
  if (!gardssalgOwnerFeaturesTabOpen(providerId)) return "";
  return `<div class="gc-card" data-mine-valg="1">
        <h2>Mine valg</h2>
        <p>Bestem hvem som finner deg og om du tar imot besøk, og se hva profilen har gjort for deg.</p>
        <div class="gc-form-actions"><a href="/kategori/gardssalg/eier/${encodeURIComponent(slug)}/valg" class="gc-btn gc-btn-primary">Åpne «Mine valg»</a></div>
      </div>`;
}

// ─────────────────────────────────────────────────────────────────
// POST /kategori/gardssalg/eier/:providerSlug/save — no-JS fallback for the
// portal form (forwards to the JSON update-profile endpoint with the
// session's Bearer token, mirrors owner-portal.ts's /save route).
// ─────────────────────────────────────────────────────────────────
router.post(
  "/kategori/gardssalg/eier/:providerSlug/save",
  generalLimiter,
  express.urlencoded({ extended: false }),
  (req: Request, res: Response) => {
    const slug = String((req.params as any).providerSlug || "");
    const provider = getClaimProviderBySlug(slug);
    const base = `/kategori/gardssalg/eier/${encodeURIComponent(slug)}/portal`;
    if (!provider) return res.status(404).send(notFoundPage());

    const session = sessionFromRequest(req);
    if (!session.valid || session.providerId !== provider.id) {
      return res.redirect(303, `/kategori/gardssalg/eier/${encodeURIComponent(slug)}`);
    }

    const b = req.body || {};
    // A manual-locked row sends only the booking switch (its content fields
    // are disabled in the form, so they never reach this body anyway).
    const payload: Record<string, unknown> = provider.content_source === "manual"
      ? {}
      : {
          about_text: b.field_about_text,
          visit_text: b.field_visit_text,
          opening_hours_text: b.field_opening_hours_text,
          products: String(b.field_products || "").split(",").map((s: string) => s.trim()).filter(Boolean),
          hjemmeside: b.field_hjemmeside,
        };
    payload.booking_live = b.field_booking_live ? 1 : 0;
    const outcome = updateClaimedProviderProfile(provider.id, payload);
    if (!outcome.ok && outcome.error === "booking_blocked") return res.redirect(303, `${base}?status=booking_blocked`);
    if (!outcome.ok) return res.redirect(303, `${base}?status=error`);
    return res.redirect(303, `${base}?status=saved`);
  },
);

// ─────────────────────────────────────────────────────────────────
// POST /kategori/gardssalg/eier/:providerSlug/release-field — «gi tilbake»
// (G1 pkt 2, dev-request 2026-10-22-opplevagent-mine-valg-gardssalg). The
// owner lets Opplevagent update one field again: removes the owner lock and
// logs it (releaseClaimedProviderFieldLock). Posted by the per-field button
// in the portal (its own #gc-release-form), so it works with and without JS.
// ─────────────────────────────────────────────────────────────────
router.post(
  "/kategori/gardssalg/eier/:providerSlug/release-field",
  generalLimiter,
  express.urlencoded({ extended: false }),
  (req: Request, res: Response) => {
    const slug = String((req.params as any).providerSlug || "");
    const provider = getClaimProviderBySlug(slug);
    const base = `/kategori/gardssalg/eier/${encodeURIComponent(slug)}/portal`;
    if (!provider) return res.status(404).send(notFoundPage());

    const session = sessionFromRequest(req);
    if (!session.valid || session.providerId !== provider.id) {
      return res.redirect(303, `/kategori/gardssalg/eier/${encodeURIComponent(slug)}`);
    }
    const field = String((req.body || {}).release_field || "");
    const outcome = releaseClaimedProviderFieldLock(provider.id, field);
    return res.redirect(303, `${base}?status=${outcome.ok ? "released" : "release_error"}`);
  },
);

// ─────────────────────────────────────────────────────────────────
// Synlighet (G1 pkt 4, dev-request 2026-10-22-opplevagent-mine-valg-gardssalg):
// tre tilstander — eierens pause (skjult, ingen sperre, eieren kan slå på
// igjen), «fjern» (skjult + sperret, bare Opplevagent kan oppheve) og
// kvalitetsskjul (admin). Pause/gjenoppta krever eier-sesjon for raden på
// hvert kall; selve tilstandsendringen ligger i services/gardssalg-claim.ts.
// ─────────────────────────────────────────────────────────────────
function visibilityCardHtml(slug: string, state: OwnedVisibilityState): string {
  const base = `/kategori/gardssalg/eier/${encodeURIComponent(slug)}`;
  let text: string;
  let action = "";
  if (state === "visible") {
    text = "Profilen din er synlig.";
    action = `<form method="post" action="${base}/pause"><button type="submit" class="gc-btn gc-btn-secondary">Sett profilen på pause</button></form>` +
      `<p style="font-size:0.82rem;color:#737373;">Mens profilen er på pause vises den ikke offentlig. Du kan slå den på igjen når som helst.</p>`;
  } else if (state === "owner_pause") {
    text = "Profilen din er på pause og vises ikke offentlig.";
    action = `<form method="post" action="${base}/resume"><button type="submit" class="gc-btn gc-btn-primary">Gjør profilen synlig igjen</button></form>`;
  } else if (state === "removed") {
    text = "Profilen er fjernet etter ditt ønske. Den vises ikke offentlig.";
    action = `<p style="font-size:0.82rem;color:#737373;">Kontakt ${CLAIM_MANUAL_FALLBACK_EMAIL} hvis du vil ha den tilbake.</p>`;
  } else {
    text = "Profilen er skjult av Opplevagent.";
    action = `<p style="font-size:0.82rem;color:#737373;">Kontakt ${CLAIM_MANUAL_FALLBACK_EMAIL} for å høre hvorfor.</p>`;
  }
  return `<div class="gc-card" data-visibility-state="${state}"><h2>Synlighet</h2><p>${text}</p>${action}</div>`;
}

const VISIBILITY_ERROR_MESSAGES: Record<string, string> = {
  removed: "Profilen er fjernet etter ditt ønske og kan ikke gjøres synlig herfra.",
  quality_hidden: "Profilen er skjult av Opplevagent og kan ikke gjøres synlig herfra.",
};

function visibilityJson(res: Response, outcome: OwnerVisibilityOutcome) {
  if (outcome.ok) return res.json({ success: true, state: outcome.state, changed: outcome.changed });
  if (outcome.error === "provider_not_found") return res.status(404).json({ success: false, error: outcome.error });
  if (outcome.error === "not_owner") return res.status(403).json({ success: false, error: "forbidden" });
  return res.status(409).json({ success: false, error: outcome.error, message: VISIBILITY_ERROR_MESSAGES[outcome.error] });
}

for (const action of ["pause", "resume"] as const) {
  const run = (providerId: string) => (action === "pause" ? pauseOwnedProvider(providerId) : resumeOwnedProvider(providerId));

  // JSON: 401 no session / 403 other producer / 409 refused (norsk melding).
  router.post(
    `/api/opplevelser/gardssalg-claim/:providerId/${action}`,
    generalLimiter,
    (req: Request, res: Response) => {
    const { providerId } = req.params as any;
    const session = sessionFromRequest(req);
    if (!session.valid) return res.status(401).json({ success: false, error: "session_invalid" });
    if (session.providerId !== providerId) return res.status(403).json({ success: false, error: "forbidden" });
    return visibilityJson(res, run(providerId));
    },
  );

  // No-JS form on the portal.
  router.post(
    `/kategori/gardssalg/eier/:providerSlug/${action}`,
    generalLimiter,
    (req: Request, res: Response) => {
    const slug = String((req.params as any).providerSlug || "");
    const provider = getClaimProviderBySlug(slug);
    const base = `/kategori/gardssalg/eier/${encodeURIComponent(slug)}/portal`;
    if (!provider) return res.status(404).send(notFoundPage());
    const session = sessionFromRequest(req);
    if (!session.valid || session.providerId !== provider.id) {
      return res.redirect(303, `/kategori/gardssalg/eier/${encodeURIComponent(slug)}`);
    }
    const outcome = run(provider.id);
    return res.redirect(303, `${base}?status=${outcome.ok ? (action === "pause" ? "paused" : "resumed") : "visibility_error"}`);
  });
}

// ─────────────────────────────────────────────────────────────────
// POST /kategori/gardssalg/eier/:providerSlug/logout — real revoke (see
// module doc) + clear cookie.
// ─────────────────────────────────────────────────────────────────
router.post("/kategori/gardssalg/eier/:providerSlug/logout", generalLimiter, (req: Request, res: Response) => {
  const slug = String((req.params as any).providerSlug || "");
  const cookieToken = readSessionCookie(req);
  if (cookieToken) revokeClaimToken(cookieToken);
  res.clearCookie(GARDSSALG_OWNER_SESSION_COOKIE, { path: "/", httpOnly: true, secure: true, sameSite: "lax" });
  return res.redirect(303, `/kategori/gardssalg/produsent/${encodeURIComponent(slug)}`);
});

// ─────────────────────────────────────────────────────────────────
// JSON API — session-gated (mirrors RFB's GET/POST /api/agents/:id/* shape).
// ─────────────────────────────────────────────────────────────────

router.get("/api/opplevelser/gardssalg-claim/:providerId/profile", generalLimiter, (req: Request, res: Response) => {
  const { providerId } = req.params as any;
  const session = sessionFromRequest(req);
  if (!session.valid) return res.status(401).json({ success: false, error: "session_invalid" });
  if (session.providerId !== providerId) return res.status(403).json({ success: false, error: "forbidden" });

  const provider = getClaimProviderById(providerId);
  if (!provider) return res.status(404).json({ success: false, error: "provider_not_found" });

  let products: string[] = [];
  try { const p = JSON.parse(provider.products || "[]"); if (Array.isArray(p)) products = p; } catch { /* ignore */ }
  const locked = provider.content_source === "manual";
  const bookingBlock = portalBookingBlock(provider);

  return res.json({
    success: true,
    provider: { id: provider.id, navn: provider.navn, slug: provider.slug },
    editable: !locked,
    // G1 item 3: the booking switch has its own state, independent of the
    // content lock. stopped_by_opplevagent = admin brake (owner cannot
    // switch it back on); reason = the operator's note, if any.
    booking: {
      can_enable: provider.booking_live === 1 || !bookingBlock,
      blocked_reason: bookingBlock ? bookingBlock.reason : null,
      stopped_by_opplevagent: bookingBlock?.reason === "admin_brake",
      stop_reason: bookingBlock?.reason === "admin_brake" ? bookingBlock.note : null,
      message: bookingBlock ? bookingBlock.message : null,
    },
    // G1 pkt 2: fields the owner has locked (and can give back).
    owner_locked_fields: CLAIM_RELEASABLE_FIELDS.filter((f) => Object.prototype.hasOwnProperty.call(getClaimOwnerLocks(provider), f)),
    fields: {
      about_text: provider.about_text,
      visit_text: provider.visit_text,
      opening_hours_text: provider.opening_hours_text,
      products,
      hjemmeside: provider.hjemmeside,
      booking_live: !!provider.booking_live,
    },
  });
});

router.post("/api/opplevelser/gardssalg-claim/:providerId/update-profile", generalLimiter, express.json(), (req: Request, res: Response) => {
  const { providerId } = req.params as any;
  const session = sessionFromRequest(req);
  if (!session.valid) return res.status(401).json({ success: false, error: "session_invalid" });
  if (session.providerId !== providerId) return res.status(403).json({ success: false, error: "forbidden" });

  const body: Record<string, unknown> = {};
  for (const f of CLAIM_EDITABLE_FIELDS) if (f in (req.body || {})) body[f] = (req.body as any)[f];

  const outcome = updateClaimedProviderProfile(providerId, body);
  if (!outcome.ok && outcome.error === "booking_blocked") {
    // 409 with the Norwegian reason; nothing was written (G1 item 3).
    return res.status(409).json({
      success: false,
      error: "booking_blocked",
      reason: outcome.block.reason,
      message: outcome.block.message,
      stop_reason: outcome.block.note,
    });
  }
  if (!outcome.ok) return res.status(404).json({ success: false, error: outcome.error });
  return res.json({ success: true, updated_fields: outcome.updatedFields, skipped_fields: outcome.skippedFields });
});

// G1 pkt 2: «gi tilbake» as JSON — {field} -> 200 {released} | 400 unknown_field
// | 409 locked_by_manual / locked_by_admin (norsk melding) | 404.
router.post("/api/opplevelser/gardssalg-claim/:providerId/release-field", generalLimiter, express.json(), (req: Request, res: Response) => {
  const { providerId } = req.params as any;
  const session = sessionFromRequest(req);
  if (!session.valid) return res.status(401).json({ success: false, error: "session_invalid" });
  if (session.providerId !== providerId) return res.status(403).json({ success: false, error: "forbidden" });

  const outcome = releaseClaimedProviderFieldLock(providerId, String((req.body || {}).field || ""));
  if (outcome.ok) return res.json({ success: true, field: outcome.field, released: outcome.released });
  if (outcome.error === "provider_not_found") return res.status(404).json({ success: false, error: outcome.error });
  if (outcome.error === "unknown_field") return res.status(400).json({ success: false, error: outcome.error });
  const message = outcome.error === "locked_by_admin"
    ? "Feltet er låst av Opplevagent-support og kan ikke gis tilbake herfra."
    : "Profilen er låst av Opplevagent-support.";
  return res.status(409).json({ success: false, error: outcome.error, message });
});

router.get("/api/opplevelser/gardssalg-claim/:providerId/stats", generalLimiter, (req: Request, res: Response) => {
  const { providerId } = req.params as any;
  const session = sessionFromRequest(req);
  if (!session.valid) return res.status(401).json({ success: false, error: "session_invalid" });
  if (session.providerId !== providerId) return res.status(403).json({ success: false, error: "forbidden" });

  const provider = getClaimProviderById(providerId);
  if (!provider) return res.status(404).json({ success: false, error: "provider_not_found" });

  const path = `/kategori/gardssalg/produsent/${provider.slug || ""}`;
  const stats = getGardssalgOwnerStats(path, providerId);
  res.setHeader("Cache-Control", "private, max-age=60");
  return res.json({ success: true, stats });
});

// ─────────────────────────────────────────────────────────────────
// GET /api/opplevelser/gardssalg-claim/:providerId/session-status —
// dev-request 2026-08-06-eier-ser-reserver-knapp-paa-egen-profil.
//
// The produsent profile page (src/routes/experiences-seo.ts) is a public,
// shared-cacheable response (`Cache-Control: public, max-age=300`) — its
// server-rendered HTML must stay byte-identical regardless of the
// request's Cookie header, or a CDN/proxy will serve one owner's
// personalized variant to a different visitor of the same cached URL
// (AC4 of that dev-request). So the "does the current viewer own THIS
// provider?" check can't happen in that route's own render at all — it
// happens here, in a separate, `no-store` JSON endpoint the page's own
// inline <script> calls client-side AFTER the (identically-cached) HTML
// has already loaded. This endpoint is deliberately request-scoped and
// per-visitor by design — the opposite cacheability contract of the page
// that calls it.
//
// Answers a plain boolean, nothing more: never reveals whether a session
// exists/is valid at all, and never reveals anything about some OTHER
// provider — only "does the CURRENT session (if any) own THIS providerId".
// Fails closed (isOwner:false) on any invalid/missing/errored session so a
// caller can never be shown the wrong owner affordance.
// ─────────────────────────────────────────────────────────────────
router.get("/api/opplevelser/gardssalg-claim/:providerId/session-status", generalLimiter, (req: Request, res: Response) => {
  // Set even on the error path below — this response varies per-visitor by
  // design and must never be cached, unlike the profile page that calls it.
  res.setHeader("Cache-Control", "no-store");
  const { providerId } = req.params as any;
  try {
    const session = sessionFromRequest(req);
    const isOwner = !!(session.valid && providerId && session.providerId === providerId);
    return res.json({ isOwner });
  } catch (err) {
    console.error("[gardssalg-claim] GET session-status error:", err);
    return res.json({ isOwner: false });
  }
});

// «Mine valg» for gårdssalg owners (O1a): the tab and its JSON API, behind
// OA_OWNER_FEATURES_ENABLED + the allowlist; the same shell and session.
router.use(createGardssalgOwnerFeaturesRouter({ shell, sessionFromRequest }));

export default router;
export type { ClaimProviderRow };
