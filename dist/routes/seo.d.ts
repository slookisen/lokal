/**
 * SEO Frontend Routes v2 — Professional server-rendered HTML pages
 *
 * Complete redesign: consumer-first landing page, rich producer profiles,
 * modern city pages, clean search results. All pages include Schema.org
 * markup for Google Rich Results.
 *
 * Routes:
 *   GET /                     → Landing page with search, categories, featured producers
 *   GET /sok?q=...            → Search results page
 *   GET /:city                → City page with all producers in that city
 *   GET /produsent/:slug      → Individual producer profile page
 *   GET /sitemap.xml          → Dynamic sitemap for Google
 *   GET /robots.txt           → Crawl instructions
 */
declare const router: import("express-serve-static-core").Router;
export default router;
//# sourceMappingURL=seo.d.ts.map