/**
 * email-reveal-trap.ts — dev-request
 * 2026-09-09-epost-eksponering-skjerming-mot-masseinnhosting, S-A4
 * («Felle-adresse», trap address) on all three hosts: rettfrabonden.com
 * (rfb), finn-tannlege.com (dental) and opplevagent.no (experiences).
 *
 * - EMAIL_TRAP_PATH (/kontakt-arkiv) is disallowed for EVERY robot in each
 *   host's robots.txt: EMAIL_TRAP_ROBOTS_DISALLOW is part of the Disallow
 *   block repeated inside every User-agent group (a robot obeys only its most
 *   specific group, so a Disallow under `*` alone would not reach Googlebot,
 *   GPTBot, …). The prefix has no trailing slash, so it covers
 *   /kontakt-arkiv, /kontakt-arkiv/ and everything below — exactly what the
 *   route answers (Express matches /kontakt-arkiv and /kontakt-arkiv/ alike).
 *   The Disallow is always served, switch on or off, so robots already have
 *   it cached when a switch is turned on.
 * - The profile pages (/produsent/:slug, /klinikk/…, gårdssalg
 *   /kategori/gardssalg/produsent/:providerSlug) carry EMAIL_TRAP_LINK_HTML,
 *   a link humans do not see (hidden attribute + display:none, aria-hidden,
 *   tabindex -1, rel nofollow), ONLY while that host's guard switch is on, so
 *   with the switch off the page is byte-identical to main. It is never in a
 *   sitemap or in JSON-LD.
 * - A GET or HEAD on the trap path, with the host's switch on, calls
 *   recordEmailRevealTrapHit (services/email-reveal-guard.ts): that client
 *   (req.ip only, salted hash; empty IP → nothing recorded) gets no e-mail on
 *   any profile of that host for 24 h, on every surface wired to the guard
 *   (pages, «Vis e-post», REST, A2A, MCP where wired) — withheld exactly as
 *   over the limit, no new field. Pages otherwise render as normal. The
 *   answer is a small 200 page, X-Robots-Tag noindex, nofollow, Cache-Control
 *   no-store (so a cache never answers a later hit without the origin
 *   seeing it).
 * - Switch off for the host → the route calls next(): the request falls
 *   through to the app's ordinary 404, byte-identical to main, and nothing is
 *   recorded or logged.
 *
 * Nobody is exempt, verified AI readers (S-A2) included: a robot that follows
 * robots.txt never fetches the path, so a hit means robots.txt was ignored.
 * The block store is in memory and per process; see email-reveal-guard.ts.
 */

import type { NextFunction, Request, Response } from "express";
import { emailRevealGuardEnabled, recordEmailRevealTrapHit, type EmailRevealHost } from "./email-reveal-guard";

/** The trap path, the same on all three hosts. */
export const EMAIL_TRAP_PATH = "/kontakt-arkiv";

/** The robots.txt line repeated inside every User-agent group on every host. */
export const EMAIL_TRAP_ROBOTS_DISALLOW = `Disallow: ${EMAIL_TRAP_PATH}`;

/** The hidden link put on a profile page while the host's switch is on. */
export const EMAIL_TRAP_LINK_HTML =
  `<a href="${EMAIL_TRAP_PATH}/" rel="nofollow" tabindex="-1" aria-hidden="true" hidden style="display:none">Kontaktarkiv</a>`;

/** The hidden link for a profile page: "" while the switch for `host` is off (page unchanged). */
export function emailTrapLinkFor(host: EmailRevealHost): string {
  return emailRevealGuardEnabled(host) ? EMAIL_TRAP_LINK_HTML : "";
}

const TRAP_PAGE = `<!DOCTYPE html>
<html lang="no">
<head>
<meta charset="utf-8">
<meta name="robots" content="noindex, nofollow">
<title>Arkiv</title>
</head>
<body>
<p>Ingen oppføringer.</p>
</body>
</html>
`;

/** Route paths for router.get (Express answers HEAD with the GET handler). */
export const EMAIL_TRAP_ROUTE_PATHS = [EMAIL_TRAP_PATH, `${EMAIL_TRAP_PATH}/*rest`];

/** The trap route handler for one host's router. */
export function emailTrapHandler(host: EmailRevealHost) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!emailRevealGuardEnabled(host)) { next(); return; }
    // Only the exact disallowed prefix: a language-prefixed /en/kontakt-arkiv
    // (i18n middleware strips /en, /sv from req.url) is not in robots.txt, so
    // it must not trap anyone; it falls through like any unknown path.
    const original = (req.originalUrl || "").split("?")[0]!;
    if (original !== EMAIL_TRAP_PATH && !original.startsWith(`${EMAIL_TRAP_PATH}/`)) { next(); return; }
    recordEmailRevealTrapHit(req, host);
    res.set("X-Robots-Tag", "noindex, nofollow");
    res.set("Cache-Control", "no-store");
    res.type("html").status(200).send(TRAP_PAGE);
  };
}
