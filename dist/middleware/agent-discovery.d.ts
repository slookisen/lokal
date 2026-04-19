/**
 * Agent discovery middleware
 * ──────────────────────────
 * Two small, composable pieces:
 *
 *   1. linkHeaders — emits RFC 8288 Link response headers on the
 *      homepage so agents and crawlers can find our agent-card, skills
 *      index, openapi spec, and sitemap without guessing paths.
 *
 *   2. markdownNegotiation — if a client sends `Accept: text/markdown`
 *      (or `?format=md`) on a "content" route, serve a plain-text
 *      markdown version of the page instead of the HTML shell. Agents
 *      can parse markdown cheaply; dumping a full HTML layout on them
 *      wastes tokens.
 */
import { Request, Response, NextFunction } from "express";
export declare function linkHeaders(_req: Request, res: Response, next: NextFunction): void;
export declare function markdownNegotiation(req: Request, res: Response, next: NextFunction): void;
//# sourceMappingURL=agent-discovery.d.ts.map