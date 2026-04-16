/**
 * SEO Frontend Routes — Server-rendered HTML pages for Google indexing
 *
 * These pages exist to compete with Google Places by BEING in Google.
 * Every page includes Schema.org LocalBusiness markup for rich results.
 *
 * Routes:
 *   GET /                     -> Landing page with search + popular cities
 *   GET /:city                -> City page with all producers in that city
 *   GET /produsent/:slug      -> Individual producer page with full details
 *   GET /sitemap.xml          -> Dynamic sitemap for Google
 *   GET /robots.txt           -> Crawl instructions
 */
declare const router: import("express-serve-static-core").Router;
export default router;
//# sourceMappingURL=seo-backup.d.ts.map