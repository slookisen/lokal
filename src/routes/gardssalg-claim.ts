import express, { Router, Request, Response } from "express";
import {
  getClaimProviderById,
  getClaimProviderBySlug,
  deriveOrgLinkedEmailCandidatesWithOutreachLookup,
  issueClaimMagicLink,
  verifyClaimToken,
  verifyGardssalgOwnerSessionToken,
  revokeClaimToken,
  updateClaimedProviderProfile,
  maskEmail,
  CLAIM_MANUAL_FALLBACK_EMAIL,
  CLAIM_EDITABLE_FIELDS,
  GARDSSALG_OWNER_SESSION_COOKIE,
  type ClaimProviderRow,
} from "../services/gardssalg-claim";
import { getGardssalgOwnerStats } from "../services/gardssalg-owner-stats-service";
import { emailService } from "../services/email-service";

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
//   - The claim entry page never asks the visitor to type an email. The
//     ONE org-linked email (Brreg contact, or post@<ownership-verified-
//     domain>) is derived entirely server-side — Daniel's "never open
//     claiming by name alone" requirement — and the masked address is
//     shown so the visitor knows where the link went.
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
    return { success: true, message: "Endringene er lagret." };
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

function sessionFromRequest(req: Request): { valid: boolean; providerId?: string; token?: string } {
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
router.get("/kategori/gardssalg/eier/magic-link-verify", (req: Request, res: Response) => {
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
router.get("/kategori/gardssalg/eier/:providerSlug", (req: Request, res: Response) => {
  try {
    const slug = String((req.params as any).providerSlug || "");
    const provider = getClaimProviderBySlug(slug);
    if (!provider) return res.status(404).send(notFoundPage());

    // Must mirror issueClaimMagicLink()'s own (b-epost) lookup exactly —
    // otherwise this page could show the "send me a link" form for a
    // provider whose POST would then fail (or vice versa: show the fallback
    // for a provider the POST would actually succeed for). Same lazy
    // wrapper issueClaimMagicLink() uses, so the RFB cross-DB lookup only
    // ever runs when it could actually change the outcome. Candidates form
    // (dev-request 2026-08-06-claim-produsent-velger-mottakeradresse) —
    // 0/1/2+ are the three cases below.
    const candidates = deriveOrgLinkedEmailCandidatesWithOutreachLookup(provider);
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
        ${addressChoiceHtml}
        ${alert}
        <form id="gc-request-form" method="post" action="/kategori/gardssalg/eier/${encodeURIComponent(provider.id)}/request" novalidate>
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
const CLAIM_EMAIL_SOURCES = ["brreg_contact", "verified_domain_address", "stored_epost_verified"] as const;
function parseSelectedSource(value: unknown): (typeof CLAIM_EMAIL_SOURCES)[number] | undefined {
  return typeof value === "string" && (CLAIM_EMAIL_SOURCES as readonly string[]).includes(value)
    ? (value as (typeof CLAIM_EMAIL_SOURCES)[number])
    : undefined;
}

router.post(
  "/kategori/gardssalg/eier/:providerId/request",
  express.json(),
  express.urlencoded({ extended: false }),
  (req: Request, res: Response) => {
    const providerId = String((req.params as any).providerId || "");
    const wantsJson = (req.headers["content-type"] || "").includes("application/json") || (req.headers.accept || "").includes("application/json");
    const selectedSource = parseSelectedSource((req.body as any)?.selected);

    const provider = getClaimProviderById(providerId);
    const redirectBase = provider?.slug ? `/kategori/gardssalg/eier/${encodeURIComponent(provider.slug)}` : null;

    const result = issueClaimMagicLink(providerId, undefined, { selectedSource });

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
router.get("/kategori/gardssalg/eier/:providerSlug/portal", (req: Request, res: Response) => {
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

    const locked = provider.content_source === "manual";
    let products: string[] = [];
    try { const p = JSON.parse(provider.products || "[]"); if (Array.isArray(p)) products = p.filter((x) => typeof x === "string"); } catch { /* ignore */ }

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
        ${locked ? `<div class="gc-alert gc-alert-error" role="alert">Denne profilen er låst av Opplevagent-support. Kontakt ${CLAIM_MANUAL_FALLBACK_EMAIL} for å endre.</div>` : ""}
      </div>
      <div class="gc-card">
        <h2>Profilinformasjon</h2>
        <form id="gc-profile-form" method="post" action="/kategori/gardssalg/eier/${encodeURIComponent(slug)}/save" novalidate>
          <div class="gc-field">
            <label for="f-about">Om produsenten</label>
            <textarea id="f-about" name="field_about_text" ${locked ? "disabled" : ""}>${escapeHtml(provider.about_text || "")}</textarea>
          </div>
          <div class="gc-field">
            <label for="f-visit">Besøket</label>
            <textarea id="f-visit" name="field_visit_text" ${locked ? "disabled" : ""}>${escapeHtml(provider.visit_text || "")}</textarea>
          </div>
          <div class="gc-field">
            <label for="f-hours">Åpningstider</label>
            <input id="f-hours" name="field_opening_hours_text" type="text" value="${escapeHtml(provider.opening_hours_text || "")}" ${locked ? "disabled" : ""}>
          </div>
          <div class="gc-field">
            <label for="f-products">Produkter (kommaseparert)</label>
            <input id="f-products" name="field_products" type="text" value="${escapeHtml(products.join(", "))}" ${locked ? "disabled" : ""}>
          </div>
          <div class="gc-field">
            <label for="f-website">Nettside</label>
            <input id="f-website" name="field_hjemmeside" type="url" value="${escapeHtml(provider.hjemmeside || "")}" ${locked ? "disabled" : ""}>
          </div>
          <div class="gc-field gc-toggle-row">
            <input id="f-booking" name="field_booking_live" type="checkbox" value="1" style="width:auto;min-height:0;" ${provider.booking_live ? "checked" : ""} ${locked ? "disabled" : ""}>
            <label for="f-booking" style="margin:0;">Aktiver reservasjoner (booking) for besøkende</label>
          </div>
          <div class="gc-form-actions">
            <button type="submit" class="gc-btn gc-btn-primary" ${locked ? "disabled" : ""}>Lagre alle endringer</button>
            <a href="/kategori/gardssalg/produsent/${encodeURIComponent(slug)}" class="gc-btn gc-btn-secondary">Se profilen</a>
          </div>
          <div id="gc-save-status" aria-live="polite"></div>
        </form>
      </div>
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
              '<div class="gc-stat"><div class="gc-stat-num">' + j.stats.humanViews + '</div><div class="gc-stat-label">Sidevisninger (' + j.stats.windowDays + ' dager)</div></div>' +
              '<div class="gc-stat"><div class="gc-stat-num">' + j.stats.aiBotViews + '</div><div class="gc-stat-label">AI/bot-trafikk</div></div>';
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
            var payload = {
              about_text: fd.get("field_about_text"),
              visit_text: fd.get("field_visit_text"),
              opening_hours_text: fd.get("field_opening_hours_text"),
              products: String(fd.get("field_products") || "").split(",").map(function (s) { return s.trim(); }).filter(Boolean),
              hjemmeside: fd.get("field_hjemmeside"),
              booking_live: fd.get("field_booking_live") ? 1 : 0,
            };
            var btn = form.querySelector("button[type=submit]");
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

// ─────────────────────────────────────────────────────────────────
// POST /kategori/gardssalg/eier/:providerSlug/save — no-JS fallback for the
// portal form (forwards to the JSON update-profile endpoint with the
// session's Bearer token, mirrors owner-portal.ts's /save route).
// ─────────────────────────────────────────────────────────────────
router.post(
  "/kategori/gardssalg/eier/:providerSlug/save",
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
    const payload: Record<string, unknown> = {
      about_text: b.field_about_text,
      visit_text: b.field_visit_text,
      opening_hours_text: b.field_opening_hours_text,
      products: String(b.field_products || "").split(",").map((s: string) => s.trim()).filter(Boolean),
      hjemmeside: b.field_hjemmeside,
      booking_live: b.field_booking_live ? 1 : 0,
    };
    const outcome = updateClaimedProviderProfile(provider.id, payload);
    if (!("ok" in outcome) || !outcome.ok) return res.redirect(303, `${base}?status=error`);
    return res.redirect(303, `${base}?status=saved`);
  },
);

// ─────────────────────────────────────────────────────────────────
// POST /kategori/gardssalg/eier/:providerSlug/logout — real revoke (see
// module doc) + clear cookie.
// ─────────────────────────────────────────────────────────────────
router.post("/kategori/gardssalg/eier/:providerSlug/logout", (req: Request, res: Response) => {
  const slug = String((req.params as any).providerSlug || "");
  const cookieToken = readSessionCookie(req);
  if (cookieToken) revokeClaimToken(cookieToken);
  res.clearCookie(GARDSSALG_OWNER_SESSION_COOKIE, { path: "/", httpOnly: true, secure: true, sameSite: "lax" });
  return res.redirect(303, `/kategori/gardssalg/produsent/${encodeURIComponent(slug)}`);
});

// ─────────────────────────────────────────────────────────────────
// JSON API — session-gated (mirrors RFB's GET/POST /api/agents/:id/* shape).
// ─────────────────────────────────────────────────────────────────

router.get("/api/opplevelser/gardssalg-claim/:providerId/profile", (req: Request, res: Response) => {
  const { providerId } = req.params as any;
  const session = sessionFromRequest(req);
  if (!session.valid) return res.status(401).json({ success: false, error: "session_invalid" });
  if (session.providerId !== providerId) return res.status(403).json({ success: false, error: "forbidden" });

  const provider = getClaimProviderById(providerId);
  if (!provider) return res.status(404).json({ success: false, error: "provider_not_found" });

  let products: string[] = [];
  try { const p = JSON.parse(provider.products || "[]"); if (Array.isArray(p)) products = p; } catch { /* ignore */ }
  const locked = provider.content_source === "manual";

  return res.json({
    success: true,
    provider: { id: provider.id, navn: provider.navn, slug: provider.slug },
    editable: !locked,
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

router.post("/api/opplevelser/gardssalg-claim/:providerId/update-profile", express.json(), (req: Request, res: Response) => {
  const { providerId } = req.params as any;
  const session = sessionFromRequest(req);
  if (!session.valid) return res.status(401).json({ success: false, error: "session_invalid" });
  if (session.providerId !== providerId) return res.status(403).json({ success: false, error: "forbidden" });

  const body: Record<string, unknown> = {};
  for (const f of CLAIM_EDITABLE_FIELDS) if (f in (req.body || {})) body[f] = (req.body as any)[f];

  const outcome = updateClaimedProviderProfile(providerId, body);
  if ("error" in outcome) return res.status(404).json({ success: false, error: outcome.error });
  return res.json({ success: true, updated_fields: outcome.updatedFields, skipped_fields: outcome.skippedFields });
});

router.get("/api/opplevelser/gardssalg-claim/:providerId/stats", (req: Request, res: Response) => {
  const { providerId } = req.params as any;
  const session = sessionFromRequest(req);
  if (!session.valid) return res.status(401).json({ success: false, error: "session_invalid" });
  if (session.providerId !== providerId) return res.status(403).json({ success: false, error: "forbidden" });

  const provider = getClaimProviderById(providerId);
  if (!provider) return res.status(404).json({ success: false, error: "provider_not_found" });

  const path = `/kategori/gardssalg/produsent/${provider.slug || ""}`;
  const stats = getGardssalgOwnerStats(path);
  res.setHeader("Cache-Control", "private, max-age=60");
  return res.json({ success: true, stats });
});

export default router;
export type { ClaimProviderRow };
