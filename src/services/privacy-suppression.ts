// privacy-suppression.ts — what counts as an ACTIVE outreach suppression row.
//
// dev-request 2026-10-12-slettefrist-korrespondanse-og-oversettelser. Shared
// by slice C (routes/admin-privacy-erasure.ts, art. 17 erasure) and slice A
// (services/privacy-retention.ts, the nightly 24-month retention job), so the
// two deletion paths can never disagree about which email_bounces rows are
// the sperreliste (review N7 on lokal#1442).
//
// Only these bounce types are read as a block by the senders (crm.ts /
// admin-outreach-candidates / opplevelser use IN ('hard','complaint',
// 'unsubscribe')); 'soft'/'unknown'/NULL rows written by bounce-service do NOT
// stop a send. agent_blocklist email rows block via isBlocked() and are never
// touched by either deletion path unless explicitly asked (slice C only).

export const SUPPRESSING_BOUNCE_TYPES = ["hard", "complaint", "unsubscribe"] as const;

/** SQL list literal for `bounce_type IN ${SUPPRESSING_BOUNCE_TYPES_SQL}`. */
export const SUPPRESSING_BOUNCE_TYPES_SQL = `(${SUPPRESSING_BOUNCE_TYPES.map((t) => `'${t}'`).join(", ")})`;
