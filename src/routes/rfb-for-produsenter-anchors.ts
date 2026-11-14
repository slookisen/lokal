// ─── rfb-for-produsenter-anchors.ts ─────────────────────────────────────────
// The /for-produsenter path, its flag and its section anchors, in a module of
// their own so the owner-feature registry and the «Mine valg» page can use
// them without importing the page route (which imports the registry).
// rfb-for-produsenter.ts re-exports everything here, so existing callers keep
// importing from there.
//
// A2A dev-request 2026-10-22-rfb-for-produsenter-faq-side, slice F2c-1 (AC6):
// registry entries carry `faqAnchor`, and the RFB «Mine valg» row links
// «Les mer» to /for-produsenter#<faqAnchor> while the page flag is on.

import { localizedPath, type Lang } from "../i18n/t";

export const FOR_PRODUSENTER_PATH = "/for-produsenter";

/** FOR_PRODUSENTER_PAGE_ENABLED: "1" or "true" (any case, trimmed) = on; anything else = off. */
export function isForProdusenterPageEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env.FOR_PRODUSENTER_PAGE_ENABLED || "").trim().toLowerCase();
  return v === "true" || v === "1";
}

/** The anchors, in menu order. Used by «Les mer» links — never rename after publishing. */
export const FOR_PRODUSENTER_ANCHORS = [
  "oversikt", "synlighet", "eierskap", "mine-valg", "bestillinger", "betaling",
  "oppdatering", "statistikk", "personvern", "pris", "kontakt",
] as const;
export type ForProdusenterAnchor = (typeof FOR_PRODUSENTER_ANCHORS)[number];

/** /for-produsenter#<anchor> (EN: /en/for-produsenter#<anchor>). */
export function forProdusenterSectionHref(anchor: ForProdusenterAnchor, lang: Lang = "no"): string {
  return `${localizedPath(FOR_PRODUSENTER_PATH, lang)}#${anchor}`;
}
