// ─── Owner portal: «Forhåndsbetaling» card ──────────────────────────────
// A2A dev-request 2026-10-09-rfb-forhandsbetaling-stripe-connect, skive 1.
// Pure renderer, kept out of owner-portal.ts so it is testable on its own
// and so routes/payments.ts (which imports owner-portal.ts) never has to
// be imported back. owner-portal.ts only renders it when the producer's
// state is something other than "disabled" / "not_allowed".

import { isPlatformFeeConfigured, type ProducerPaymentStatus } from "../services/payment-service";

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Portal ?status= values set by routes/payments.ts → alert text. */
const PAYMENT_PORTAL_ALERTS: Record<string, { ok: boolean; text: string }> = {
  payments_return: {
    ok: true,
    text: "Takk! Vi venter på bekreftelse fra Stripe. Det kan ta et minutt. Last siden på nytt for å se status.",
  },
  payments_error: { ok: false, text: "Klarte ikke å åpne Stripe. Prøv igjen om litt." },
  payments_unavailable: { ok: false, text: "Forhåndsbetaling er ikke tilgjengelig akkurat nå." },
  payments_orders_off: {
    ok: false,
    text: "Slå på «Motta bestillinger på e-post» først. Forhåndsbetaling bygger på bestillinger.",
  },
  payments_terms_required: {
    ok: false,
    text: "Du må godta vilkårene for produsenter og oppgi om du selger som næringsdrivende før du kobler til Stripe.",
  },
  payments_declared: { ok: true, text: "Erklæringen er lagret." },
};

/**
 * Own keys only: ?status=constructor / __proto__ / toString must never hit
 * Object.prototype (the portal would 500 — with payments off too).
 */
export function paymentPortalAlert(status: string): { ok: boolean; text: string } | null {
  return Object.prototype.hasOwnProperty.call(PAYMENT_PORTAL_ALERTS, status) ? PAYMENT_PORTAL_ALERTS[status]! : null;
}

export function shouldRenderPaymentCard(status: ProducerPaymentStatus): boolean {
  return status.state !== "disabled" && status.state !== "not_allowed";
}

const TRADER_LABEL: Record<string, string> = {
  trader: "som næringsdrivende",
  non_trader: "som privatperson",
};

function traderRadios(current: string | null | undefined): string {
  const opt = (value: string, label: string) =>
    `<label style="display:block;margin:4px 0;"><input type="radio" name="trader_status" value="${value}"${current === value ? " checked" : ""} required> ${esc(label)}</label>`;
  return opt("trader", "Jeg selger som næringsdrivende (for eksempel enkeltpersonforetak, AS eller samvirke)") +
    opt("non_trader", "Jeg selger som privatperson");
}

export function renderPaymentCard(agentId: string, status: ProducerPaymentStatus): string {
  const action = `/eier/${encodeURIComponent(agentId)}/betaling/start`;
  const declareAction = `/eier/${encodeURIComponent(agentId)}/betaling/erklaering`;
  const testBadge = status.livemode
    ? ""
    : `<p class="ep-alert ep-alert-ok" role="note" style="margin-bottom:12px;">Testmodus: ingen ekte penger trekkes.</p>`;
  // Before the first Stripe step (and after a terms version bump) the button
  // comes with the producer terms and the trader declaration (prerequisites
  // 4 + 5); afterwards it is a plain button.
  const button = (label: string) => status.termsAccepted
    ? `
        <form method="post" action="${esc(action)}" style="margin:0;">
          <button type="submit" class="ep-btn ep-btn-primary">${esc(label)}</button>
        </form>`
    : `
        <form method="post" action="${esc(action)}" style="margin:0;">
          <fieldset style="border:0;padding:0;margin:0 0 10px;"><legend style="font-weight:600;margin-bottom:4px;">Hvordan selger du?</legend>${traderRadios(status.traderStatus)}</fieldset>
          <label style="display:block;margin:0 0 12px;"><input type="checkbox" name="terms_accepted" value="1" required> Jeg har lest og godtar <a href="/produsentvilkar" target="_blank" rel="noopener">vilkårene for produsenter</a>.</label>
          <button type="submit" class="ep-btn ep-btn-primary">${esc(label)}</button>
        </form>`;
  // Shown once a declaration exists: what buyers are told, and how to change it.
  const declaration = status.termsAccepted && status.traderStatus
    ? `
        <details style="margin-top:12px;font-size:0.88rem;"><summary>Du selger ${esc(TRADER_LABEL[status.traderStatus] || "")} – kundene ser dette når de betaler. Endre</summary>
          <form method="post" action="${esc(declareAction)}" style="margin:8px 0 0;">${traderRadios(status.traderStatus)}
            <button type="submit" class="ep-btn ep-btn-secondary">Lagre</button>
          </form>
        </details>`
    : "";

  let body: string;
  switch (status.state) {
    case "not_eligible":
      body = `<p>Forhåndsbetaling bygger på bestillinger. Slå på «Motta bestillinger på e-post» over først.</p>`;
      break;
    case "not_started":
      body = `
        <p>Med forhåndsbetaling kan kunder betale når de sender bestillingen. Beløpet reserveres på kortet og trekkes først når du bekrefter bestillingen. Avslår du, frigjøres reservasjonen.</p>
        <p>Pengene går direkte til din egen Stripe-konto, og du står som selger. Stripe tar et gebyr per betaling, som trekkes fra beløpet.${isPlatformFeeConfigured() ? "" : " Rett fra Bonden tar ingen avgift."}</p>
        <p style="margin-bottom:12px;color:#737373;font-size:0.88rem;">Du oppretter kontoen hos Stripe og oppgir bedriftsopplysninger og bankkonto for utbetaling der.</p>
        ${button("Kom i gang hos Stripe")}`;
      break;
    case "onboarding":
      body = `
        <p style="margin-bottom:12px;">Du har startet registreringen hos Stripe, men den er ikke ferdig.</p>
        ${button("Fortsett hos Stripe")}`;
      break;
    case "restricted":
      body = `
        <p style="margin-bottom:12px;">Stripe trenger flere opplysninger før du kan ta imot betaling.</p>
        ${button("Fortsett hos Stripe")}`;
      break;
    case "rejected":
      body = `<p>Stripe har avvist eller stoppet kontoen din, så du kan ikke ta imot forhåndsbetaling nå. Ta kontakt med Stripe, eller med oss på kontakt@rettfrabonden.com.</p>`;
      break;
    case "pending":
      body = `<p>Stripe går gjennom opplysningene dine. Du trenger ikke gjøre noe nå. Statusen her endres når Stripe er ferdig.</p>`;
      break;
    case "deauthorized":
      body = `
        <p style="margin-bottom:12px;">Stripe-kontoen din er ikke lenger koblet til Rett fra Bonden, så du kan ikke ta imot forhåndsbetaling nå. Du kan koble til en konto på nytt.</p>
        ${button("Koble til Stripe på nytt")}`;
      break;
    case "active":
      if (!status.termsAccepted) {
        // A terms version bump (or an account connected before the terms
        // existed): no payment links until the owner accepts again.
        body = `
        <p style="margin-bottom:12px;">Vilkårene for produsenter er oppdatert. Inntil du godtar dem, får kundene ikke betalingslenke til deg, og bestillinger betales ved henting.</p>
        <form method="post" action="${esc(declareAction)}" style="margin:0;">
          <fieldset style="border:0;padding:0;margin:0 0 10px;"><legend style="font-weight:600;margin-bottom:4px;">Hvordan selger du?</legend>${traderRadios(status.traderStatus)}</fieldset>
          <label style="display:block;margin:0 0 12px;"><input type="checkbox" name="terms_accepted" value="1" required> Jeg har lest og godtar <a href="/produsentvilkar" target="_blank" rel="noopener">vilkårene for produsenter</a>.</label>
          <button type="submit" class="ep-btn ep-btn-primary">Godta og fortsett</button>
        </form>`;
        break;
      }
      body = `
        <p>Forhåndsbetaling er på. Kunder kan betale på forhånd for bestillinger til deg. Beløpet trekkes når du bekrefter bestillingen.</p>
        <p style="color:#737373;font-size:0.88rem;">Utbetalinger, gebyrer og refusjoner finner du i <a href="https://dashboard.stripe.com" target="_blank" rel="noopener noreferrer">Stripe-dashbordet</a>.</p>`;
      break;
    default:
      body = "";
  }

  return `
      <div class="ep-card" id="forhandsbetaling">
        <h2>Forhåndsbetaling</h2>
        ${testBadge}
        ${body}${status.state === "not_eligible" ? "" : declaration}
      </div>`;
}
