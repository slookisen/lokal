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

export function renderPaymentCard(agentId: string, status: ProducerPaymentStatus): string {
  const action = `/eier/${encodeURIComponent(agentId)}/betaling/start`;
  const testBadge = status.livemode
    ? ""
    : `<p class="ep-alert ep-alert-ok" role="note" style="margin-bottom:12px;">Testmodus: ingen ekte penger trekkes.</p>`;
  const button = (label: string) => `
        <form method="post" action="${esc(action)}" style="margin:0;">
          <button type="submit" class="ep-btn ep-btn-primary">${esc(label)}</button>
        </form>`;

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
        ${body}
      </div>`;
}
