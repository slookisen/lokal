// claim-request-more-texts.ts — eierkrav slice B3a (2026-11-08).
//
// The wording of the «Be om mer bekreftelse» mail to the person who submitted
// a queued owner claim. Kept in its own module so the text can be reworded
// without touching the flow (services/claim-request-more.ts) or the mail
// plumbing (email-service.ts sendClaimRequestMore / buildClaimRequestMoreEmail).
// Only the profile name is interpolated: no links, no claim data, no address.

export const CLAIM_REQUEST_MORE_SIGN_OFF = "Hilsen Daniel";

export function claimRequestMoreSubject(agentName: string): string {
  return `Eierkravet ditt for ${agentName} – vi trenger litt mer`;
}

export function claimRequestMoreBody(agentName: string): string {
  return (
    `Vi har fått eierkravet ditt for ${agentName}. Før vi kan godkjenne det, trenger vi litt mer ` +
    "for å bekrefte at du hører til gården, for eksempel en e-post fra gårdens egen adresse, " +
    "en lenke der gården oppgir deg som kontakt, eller org.nr. og din rolle i foretaket. " +
    "Svar på denne e-posten."
  );
}

/** The sign-off line the other claim mails use («Hilsen Daniel, <brand>»). */
export function claimRequestMoreSignOff(brand: string): string {
  return `${CLAIM_REQUEST_MORE_SIGN_OFF}, ${brand}`;
}
