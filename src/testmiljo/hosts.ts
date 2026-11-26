/**
 * Testmiljø: the three sites on local host names.
 *
 * The server tells its sites apart by exact production host name, in two host
 * gates and a dozen scattered checks (req.hostname === "opplevagent.no" …).
 * Rather than teach each of them a local name, the test environment maps
 *
 *     rettfrabonden.localhost   →  rettfrabonden.com
 *     opplevagent.localhost     →  opplevagent.no
 *     finn-tannlege.localhost   →  finn-tannlege.com
 *
 * by setting X-Forwarded-Host on the way in (trust proxy is on, and off Fly the
 * header is not stripped), and rewrites production URLs back to the local
 * names on the way out: in Location headers and in HTML bodies. So a link, a
 * redirect or a form in a page keeps you inside the test environment, and no
 * production code path has to know it is being tested.
 *
 * The rewrite is best effort, not a fence. It covers Location headers and HTML
 * sent with res.send(). It does not touch JSON, Buffers, static files under
 * public/, URL-encoded URLs (next=https%3A%2F%2F…) or URLs built in inline
 * script, so a link can still lead to production. The address bar tells you
 * where you are; nothing the test environment holds follows you there.
 *
 * Browsers resolve every *.localhost name to this machine without a hosts
 * file, and treat it as a secure context, so the Secure session cookies stick
 * over plain http.
 */

import type { NextFunction, Request, RequestHandler, Response } from "express";
import { isTestmiljo } from "./guard";

export interface LocalSite {
  key: "rfb" | "opplevagent" | "dental";
  label: string;
  localHost: string;
  prodHost: string;
}

export const LOCAL_SITES: readonly LocalSite[] = [
  { key: "rfb", label: "Rett fra Bonden", localHost: "rettfrabonden.localhost", prodHost: "rettfrabonden.com" },
  { key: "opplevagent", label: "Opplevagent", localHost: "opplevagent.localhost", prodHost: "opplevagent.no" },
  { key: "dental", label: "Finn-tannlege", localHost: "finn-tannlege.localhost", prodHost: "finn-tannlege.com" },
];

export function splitHostPort(hostHeader: string | undefined): { hostname: string; port: string } {
  const raw = (hostHeader ?? "").trim().toLowerCase();
  const match = /^(.*?)(?::(\d+))?$/.exec(raw);
  return { hostname: match?.[1] ?? raw, port: match?.[2] ?? "" };
}

/** "opplevagent.localhost" → "opplevagent.no"; null for anything that is not one of the local names. */
export function prodHostFor(hostname: string): string | null {
  const h = hostname.trim().toLowerCase();
  return LOCAL_SITES.find((site) => site.localHost === h)?.prodHost ?? null;
}

/** localhost, a loopback literal, or one of the three local site names. Nothing else is the test environment. */
export function isLocalHostName(hostname: string): boolean {
  const h = hostname.trim().toLowerCase();
  return h === "localhost" || h === "127.0.0.1" || h === "[::1]" || LOCAL_SITES.some((site) => site.localHost === h);
}

export function localOrigin(site: LocalSite, port: string): string {
  return `http://${site.localHost}${port ? `:${port}` : ""}`;
}

export function siteByKey(key: string): LocalSite | null {
  return LOCAL_SITES.find((site) => site.key === key) ?? null;
}

const PROD_URL_PATTERNS = LOCAL_SITES.map((site) => ({
  site,
  // http(s)://[www.]<prod host>, not followed by more host characters.
  re: new RegExp(`https?://(?:www\\.)?${site.prodHost.replace(/[.]/g, "\\.")}(?![\\w.-])`, "gi"),
}));

/** Every scheme-qualified production URL in `text`, pointed at the local name instead. */
export function rewriteProdUrls(text: string, port: string): string {
  let out = text;
  for (const { site, re } of PROD_URL_PATTERNS) out = out.replace(re, localOrigin(site, port));
  return out;
}

/**
 * The RFB pages register /sw.js on any host that is not one of the other two
 * production names, and a service worker caching pages is the last thing a
 * test environment wants. This one removes itself and every cache.
 */
export const SELF_REMOVING_SERVICE_WORKER =
  "self.addEventListener('install',function(){self.skipWaiting();});" +
  "self.addEventListener('activate',function(e){e.waitUntil((async function(){" +
  "var keys=await caches.keys();for(var i=0;i<keys.length;i++){await caches.delete(keys[i]);}" +
  "await self.registration.unregister();})());});";

function isHtml(res: Response): boolean {
  const type = res.getHeader("Content-Type");
  return type === undefined || String(type).toLowerCase().includes("text/html");
}

/** Mounted right after installClientHeaders, and only when isTestmiljo() is true at boot. */
export function testmiljoHostMiddleware(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!isTestmiljo()) return next();
    const { hostname, port } = splitHostPort(req.headers.host);
    const prodHost = prodHostFor(hostname);
    delete req.headers["x-forwarded-host"];
    if (prodHost) req.headers["x-forwarded-host"] = prodHost;

    if (req.path === "/sw.js") {
      res.setHeader("Content-Type", "application/javascript; charset=utf-8");
      res.setHeader("Cache-Control", "no-store");
      return res.end(SELF_REMOVING_SERVICE_WORKER);
    }

    const setHeader = res.setHeader.bind(res);
    res.setHeader = ((name: string, value: number | string | readonly string[]) =>
      setHeader(name, typeof value === "string" && name.toLowerCase() === "location" ? rewriteProdUrls(value, port) : value)) as typeof res.setHeader;

    const send = res.send.bind(res);
    res.send = ((body?: unknown) => send(typeof body === "string" && isHtml(res) ? rewriteProdUrls(body, port) : body)) as typeof res.send;

    next();
  };
}
