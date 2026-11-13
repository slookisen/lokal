// ─── Owner beta: card, badge and eligibility (behind OWNER_BETA_MODE=offer) ──
// A2A dev-request 2026-11-09-rfb-eierverktoy-beta-for-alle, slice S3.
//
// betaCardState decides WHAT a verified owner sees on the regular owner page:
//   - hidden — nothing (mode ≠ offer, unverified owner, a pilot owner, wrong
//     vertical, a claim-pending/ownerless profile, or any DB error → fail closed)
//   - offer  — the opt-in card (lists only `beta`-tier features; a required
//     terms checkbox + a link to the terms). At/over OWNER_BETA_CAP it is the
//     «Meld interesse» card instead; an `interested` owner sees «Slå på» again
//     once the cap is raised.
//   - active — the owner is in beta: a small «Beta» badge on each `beta`-tier
//     feature and a «Slå av beta» form.
// Nobody is enabled automatically — the card only offers the owner the choice.
//
// No card and no badge anywhere when OWNER_BETA_MODE is `all` (graduation) or
// `off`/unset (AC1: the page is byte-identical to today). Rendering is pure
// HTML; all strings are the placeholders in beta-texts.ts (AC8).

import { ownerBetaCap, ownerBetaMode } from "./beta-mode";
import { betaEnrollmentCounts, betaEnrollmentStatus, OWNER_BETA_VERTICAL } from "./beta-enrollment";
import { isSubjectAllowedForOwnerFeatures } from "./allowlist";
import { OWNER_FEATURE_KEYS, ownerFeatureEffectiveTier, type OwnerFeatureKey } from "./feature-tiers";
import { BETA_FEATURE_PLACEHOLDER_NAMES, BETA_TERMS_HREF, BETA_TEXTS } from "./beta-texts";

export type BetaCardState =
  | { kind: "hidden" }
  | { kind: "offer"; features: OwnerFeatureKey[]; withinCap: boolean; interested: boolean }
  | { kind: "active"; features: OwnerFeatureKey[] };

const HIDDEN: BetaCardState = { kind: "hidden" };

/** The `beta`-tier owner features (effective tier), in registry order. */
export function betaTierFeatures(env: NodeJS.ProcessEnv = process.env): OwnerFeatureKey[] {
  return OWNER_FEATURE_KEYS.filter((k) => ownerFeatureEffectiveTier(k, env) === "beta");
}

/**
 * What the owner page should show. `isVerified` is isVerifiedOwner(agentId,
 * session) computed by the caller (so this module never imports owner-portal).
 * Fail closed: anything uncertain or any DB error → hidden.
 */
export function betaCardState(
  agentId: string | null | undefined,
  isVerified: boolean,
  env: NodeJS.ProcessEnv = process.env,
  db?: any,
): BetaCardState {
  try {
    if (!agentId) return HIDDEN;
    // Badge/card only in `offer`. `all` (graduation) and `off` show nothing.
    if (ownerBetaMode(env) !== "offer") return HIDDEN;
    // Only a verified owner (valid session + verified ownership); this already
    // excludes claim-pending and ownerless profiles and unverified sessions.
    if (!isVerified) return HIDDEN;
    // A pilot owner already has the tools — never the beta card/badge.
    if (isSubjectAllowedForOwnerFeatures(OWNER_BETA_VERTICAL, agentId, env)) return HIDDEN;

    const status = betaEnrollmentStatus(OWNER_BETA_VERTICAL, agentId, db);
    const features = betaTierFeatures(env);

    if (status === "active") return { kind: "active", features };

    // Offer / interest card — only when there is something to offer.
    if (features.length === 0) return HIDDEN;
    const activeCount = betaEnrollmentCounts(OWNER_BETA_VERTICAL, db).active;
    const withinCap = activeCount < ownerBetaCap(env);
    return { kind: "offer", features, withinCap, interested: status === "interested" };
  } catch {
    // Fail closed: a DB error never opens or reveals the card.
    return HIDDEN;
  }
}

// ── Rendering (pure HTML, placeholder texts) ────────────────────────────────

function esc(s: string): string {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function featureName(k: OwnerFeatureKey): string {
  return BETA_FEATURE_PLACEHOLDER_NAMES[k] ?? `[PLASSHOLDER] ${k}`;
}

function featureList(features: OwnerFeatureKey[], withBadge: boolean): string {
  const items = features.map((k) => {
    const badge = withBadge ? ` <span class="ep-beta-badge" aria-label="${esc(BETA_TEXTS.badgeLabel)}">${esc(BETA_TEXTS.badgeLabel)}</span>` : "";
    return `<li>${esc(featureName(k))}${badge}</li>`;
  }).join("");
  return `<ul class="ep-beta-features">${items}</ul>`;
}

/** The HTML for the beta card (offer / interest / active), or "" when hidden. */
export function renderBetaCard(agentId: string, state: BetaCardState): string {
  const id = encodeURIComponent(agentId);
  if (state.kind === "hidden") return "";

  if (state.kind === "active") {
    return `
      <div class="ep-card" id="beta-kort" data-beta="active">
        <h2>${esc(BETA_TEXTS.activeCardTitle)} <span class="ep-beta-badge">${esc(BETA_TEXTS.badgeLabel)}</span></h2>
        <p>${esc(BETA_TEXTS.activeCardIntro)}</p>
        <p style="margin-bottom:6px;color:#737373;font-size:0.88rem;">${esc(BETA_TEXTS.activeCardFeaturesLead)}</p>
        ${featureList(state.features, true)}
        <form method="post" action="/eier/${id}/beta/av" style="margin-top:12px;">
          <button type="submit" class="ep-btn ep-btn-secondary">${esc(BETA_TEXTS.turnOffSubmit)}</button>
        </form>
      </div>`;
  }

  // offer / interest card
  if (!state.withinCap) {
    const body = state.interested
      ? `<p>${esc(BETA_TEXTS.interestAlreadyLead)}</p>`
      : `<p>${esc(BETA_TEXTS.interestCardIntro)}</p>
        <form method="post" action="/eier/${id}/beta/interesse" style="margin-top:12px;">
          <button type="submit" class="ep-btn ep-btn-primary">${esc(BETA_TEXTS.interestSubmit)}</button>
        </form>`;
    return `
      <div class="ep-card" id="beta-kort" data-beta="interest">
        <h2>${esc(BETA_TEXTS.interestCardTitle)}</h2>
        ${body}
      </div>`;
  }

  return `
    <div class="ep-card" id="beta-kort" data-beta="offer">
      <h2>${esc(BETA_TEXTS.offerCardTitle)}</h2>
      <p>${esc(BETA_TEXTS.offerCardIntro)}</p>
      <p style="margin-bottom:6px;color:#737373;font-size:0.88rem;">${esc(BETA_TEXTS.offerCardFeaturesLead)}</p>
      ${featureList(state.features, false)}
      <p><a href="${esc(BETA_TERMS_HREF)}">${esc(BETA_TEXTS.offerTermsLinkLabel)}</a></p>
      <form method="post" action="/eier/${id}/beta/pa" style="margin-top:12px;">
        <label style="display:flex;gap:8px;align-items:flex-start;margin-bottom:12px;">
          <input type="checkbox" name="vilkar" value="1" required>
          <span>${esc(BETA_TEXTS.offerTermsLabel)}</span>
        </label>
        <button type="submit" class="ep-btn ep-btn-primary">${esc(BETA_TEXTS.offerSubmit)}</button>
      </form>
    </div>`;
}

/** Convenience: state + render in one call. */
export function betaCardHtml(
  agentId: string,
  isVerified: boolean,
  env: NodeJS.ProcessEnv = process.env,
  db?: any,
): string {
  return renderBetaCard(agentId, betaCardState(agentId, isVerified, env, db));
}
