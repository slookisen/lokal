// ─── NACE code → gårdssalg producer_type (drink family) ─────────────────────
//
// Moved here unchanged from routes/opplevelser.ts (where the NACE-discovery
// route keeps using it, see the comment block above its old place there) so
// the self-registration Brreg gate (services/gardssalg-self-register.ts) can
// read the same map without importing that route module. Keys are Brreg's
// 5-digit SN2025 subclass codes ("NN.NNN").
export const GARDSSALG_NACE_PRODUCER_TYPE: Record<string, string> = {
  "11.010": "destilleri",
  "11.020": "vingård",
  "11.030": "sideri",
  "11.040": "mjøderi",
  "11.050": "bryggeri",
  "01.210": "vingård",
};
