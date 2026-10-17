// ─── IndexNow host register (dev-request 2026-10-16-indexnow-alle-verter, S1) ──
// One entry per host. A new host/vertical = one entry; a new page type under an existing
// host = one more entityPathPrefixes item. Sitemap getters are loaded with a lazy require
// inside the functions, so a vertical that is switched off is never loaded by this module
// (the route files are not touched by this feature).

export interface IndexNowHost {
  vertical: string;
  host: string;
  baseUrl: string;
  enabled(): boolean;
  getSitemapXml(): string;
  /** Cached sitemap without building one; null when cold or when the vertical has no shared cache. */
  peekSitemapXml: (() => { xml: string; builtAt: number } | null) | null;
  entityPathPrefixes: string[];
}

function peekRegistered(vertical: string): () => { xml: string; builtAt: number } | null {
  return () => {
    const util = require("../routes/sitemap-cache-util") as typeof import("../routes/sitemap-cache-util");
    return util.getRegisteredSitemapCache(vertical)?.peek() ?? null;
  };
}

export const INDEXNOW_HOSTS: IndexNowHost[] = [
  {
    vertical: "rfb",
    host: "rettfrabonden.com",
    baseUrl: "https://rettfrabonden.com",
    enabled: () => true,
    getSitemapXml: () => (require("../routes/seo") as typeof import("../routes/seo")).getSitemapXml(),
    // RFB keeps its own cache in seo.ts (cheap build, 33-74 ms) — no shared cache to peek.
    peekSitemapXml: null,
    entityPathPrefixes: ["/produsent/", "/en/produsent/"],
  },
  {
    vertical: "dental",
    host: "finn-tannlege.com",
    baseUrl: "https://finn-tannlege.com",
    enabled: () => process.env.ENABLE_DENTAL === "1",
    getSitemapXml: () => (require("../routes/dental-seo") as typeof import("../routes/dental-seo")).getDentalSitemapXml(),
    peekSitemapXml: peekRegistered("dental"),
    entityPathPrefixes: ["/klinikk/"],
  },
  {
    vertical: "experiences",
    host: "opplevagent.no",
    baseUrl: "https://opplevagent.no",
    enabled: () => process.env.ENABLE_EXPERIENCES === "1",
    getSitemapXml: () => (require("../routes/experiences-seo") as typeof import("../routes/experiences-seo")).getExperiencesSitemapXml(),
    peekSitemapXml: peekRegistered("experiences"),
    entityPathPrefixes: ["/opplevelse/", "/tilbyder/", "/kategori/gardssalg/produsent/"],
  },
];
