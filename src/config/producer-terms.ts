// ─── Producer terms (prepayment) ────────────────────────────────────────
// A2A dev-request 2026-10-09-rfb-forhandsbetaling-stripe-connect,
// prerequisites 4 and 5: a producer accepts these terms, and declares
// whether they sell as a trader (angrerettloven § 9 a), before connecting
// Stripe for prepayment. Bump the version whenever the text changes
// materially — producers are then asked to accept again before onboarding.
export const PRODUSENTVILKAR_PATH = "/produsentvilkar";
export const PRODUSENTVILKAR_VERSION = "2026-10-12";
export const PRODUSENTVILKAR_LAST_UPDATED = "12. oktober 2026";
