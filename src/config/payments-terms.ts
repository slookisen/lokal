// ─── Terms gate for real prepayment ─────────────────────────────────────
// A2A dev-request 2026-10-09-rfb-forhandsbetaling-stripe-connect.
//
// false while /kjopsvilkar §4 «Betaling» says prepayment is «under
// innføring». The payments live-key guard (services/payment-provider.ts)
// refuses a live Stripe key while this is false, so real prepayments cannot
// start under terms that say they are not available. Flip it in the same
// change that rewrites §4 (and the «når forhåndsbetaling er tilgjengelig»
// qualifiers in routes/rfb-kjopsvilkar.ts) to the live wording.
export const KJOPSVILKAR_PREPAYMENT_LIVE = false;
