/**
 * same-origin-write.ts — the ONE same-origin check for state-changing
 * owner/link routes (owner portal, «Mine valg», gårdssalg owner pages,
 * order actions, buyer order card, stock-check and order-email links,
 * product import). Slice T0a of the owner-portal write-guard fix.
 *
 * Why: the site sends `Referrer-Policy: no-referrer` (Helmet default), and
 * under no-referrer browsers send `Origin: null` on a plain HTML form POST.
 * The three old copies did `new URL("null")`, which throws, and treated the
 * throw as cross-site → 403 on our own forms («Forespørselen kom fra en
 * annen side»). fetch() saves (mode cors) send a real Origin and worked.
 *
 * Rule (WRITE_GUARD_FETCH_METADATA on — the default):
 *   1. `Sec-Fetch-Site: cross-site` or `same-site` → refuse.
 *   2. A real Origin → its host must equal the Host header (the same
 *      comparison as the old check: `new URL(origin).host !== Host`).
 *      An Origin that does not parse and is not the literal `null` → refuse.
 *   3. `Origin: null` or no Origin → not evidence of a cross-site request →
 *      allow. The route still requires its SameSite=Lax session cookie or its
 *      secret link token, as before.
 *
 * `WRITE_GUARD_FETCH_METADATA=0` → the old check, unchanged: Sec-Fetch-Site
 * ignored; no Origin → allow; Origin that does not parse (incl. `null`) →
 * refuse; else host comparison. Read on every request.
 *
 * Do not add another Origin-parsing check under src/ (MCP CORS in mcp.ts /
 * experiences-mcp.ts is a different thing): same-origin-write.test.ts scans
 * the source tree for one.
 */

import type { Request } from "express";

export const WRITE_GUARD_FLAG_ENV = "WRITE_GUARD_FETCH_METADATA";

export type WriteGuardReason =
  | "sec_fetch_site_cross_site"
  | "sec_fetch_site_same_site"
  | "origin_foreign"
  | "origin_unparseable";

export type WriteGuardVerdict = { refused: false } | { refused: true; reason: WriteGuardReason };

/** Default on; only the exact value "0" turns the Fetch-Metadata rule off. */
export function writeGuardFetchMetadataEnabled(): boolean {
  return process.env[WRITE_GUARD_FLAG_ENV] !== "0";
}

function headerString(req: Request, name: string): string | undefined {
  const v = (req.headers || ({} as Record<string, unknown>))[name];
  return typeof v === "string" ? v : undefined;
}

/** The old check (WRITE_GUARD_FETCH_METADATA=0), byte-for-byte the same decisions. */
function legacyVerdict(req: Request): WriteGuardVerdict {
  const origin = req.headers.origin;
  if (!origin || typeof origin !== "string") return { refused: false };
  try {
    return new URL(origin).host !== String(req.headers.host || "")
      ? { refused: true, reason: "origin_foreign" }
      : { refused: false };
  } catch {
    return { refused: true, reason: "origin_unparseable" };
  }
}

/** Pure decision, no logging. */
export function sameOriginWriteVerdict(req: Request): WriteGuardVerdict {
  if (!writeGuardFetchMetadataEnabled()) return legacyVerdict(req);
  const site = (headerString(req, "sec-fetch-site") || "").trim().toLowerCase();
  if (site === "cross-site") return { refused: true, reason: "sec_fetch_site_cross_site" };
  if (site === "same-site") return { refused: true, reason: "sec_fetch_site_same_site" };
  const origin = req.headers.origin;
  if (!origin || typeof origin !== "string") return { refused: false };
  if (origin === "null") return { refused: false };
  return legacyVerdict(req);
}

/** A loggable route pattern — never the request URL (it can carry a secret token). */
function routeLabel(req: Request, fallback?: string): string {
  if (fallback) return fallback;
  const p = (req as any).route?.path;
  return typeof p === "string" && p ? p : "unknown-route";
}

/**
 * The guard the routes call: the verdict, plus exactly one log line
 * `[write-guard] refused <route-pattern> <reason>` when it refuses.
 * `routePattern` defaults to Express' req.route.path (the pattern, e.g.
 * "/eier/:agentId/valg/niva").
 */
export function checkSameOriginWrite(req: Request, routePattern?: string): WriteGuardVerdict {
  const v = sameOriginWriteVerdict(req);
  if (v.refused) console.log(`[write-guard] refused ${routeLabel(req, routePattern)} ${v.reason}`);
  return v;
}

/** Boolean form of checkSameOriginWrite (logs once on refusal). */
export function isCrossSiteWrite(req: Request, routePattern?: string): boolean {
  return checkSameOriginWrite(req, routePattern).refused;
}

// ── Refusal page (HTML routes; JSON routes keep their own body) ────────────

export const WRITE_GUARD_REFUSED_TITLE = "Kunne ikke lagre";
export const WRITE_GUARD_CONTACT_RFB = "kontakt@rettfrabonden.com";
export const WRITE_GUARD_CONTACT_OPPLEVAGENT = "kontakt@opplevagent.no";

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/**
 * The inner HTML of the refusal page; the caller wraps it in its own shell
 * (portalShell / ordersShell / the gårdssalg shell) with
 * WRITE_GUARD_REFUSED_TITLE and status 403.
 */
export function writeGuardRefusedBody(o: { contact: string; backHref: string; backLabel: string }): string {
  return `<h1>Endringen ble ikke lagret</h1>`
    + `<p>Av sikkerhetshensyn lagrer vi bare endringer som gjøres på våre egne sider. Gå tilbake og prøv igjen. Skjer det igjen, skriv til <a href="mailto:${esc(o.contact)}">${esc(o.contact)}</a>.</p>`
    + `<p><a href="${esc(o.backHref)}">${esc(o.backLabel)}</a></p>`;
}
