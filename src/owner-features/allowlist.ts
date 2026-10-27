// ─── «Mine valg» rollout allowlist (AC20) ───────────────────────────────────
// dev-request 2026-10-22-rfb-mine-valg-eierbrytere, «Testkrav og utrulling»:
// the first version is only for the hidden test producer. Env
// OWNER_FEATURES_ALLOWED_SUBJECTS, comma-separated `<vertical>:<id>` (e.g.
// `rfb:dff0c55e…`), read per request — same parsing as
// PAYMENTS_ALLOWED_AGENT_IDS (services/payment-service.ts). Empty/unset =
// nobody. There is no wildcard: opening it to real owners is a separate,
// Daniel-approved rollout (an env change listing them, or a later slice).

export const OWNER_FEATURES_ALLOWED_SUBJECTS_ENV = "OWNER_FEATURES_ALLOWED_SUBJECTS";

export function ownerFeaturesAllowedSubjects(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env[OWNER_FEATURES_ALLOWED_SUBJECTS_ENV] || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function isSubjectAllowedForOwnerFeatures(
  vertical: string,
  subjectId: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!vertical || !subjectId) return false;
  return ownerFeaturesAllowedSubjects(env).includes(`${vertical}:${subjectId}`);
}
