// ─── «Klikk fra AI-svar» → kontakt-klikk ────────────────────────────────────
// dev-request 2026-10-14-klikk-fra-ai-svar-per-profil, slice 4 («Kontakt-klikk»).
//
// Helmet sends Referrer-Policy: no-referrer on every page, so the contact
// beacon and the /ut/ redirect never see the profile page's landing URL and
// contact_clicks.utm_source stayed empty. The profile page now remembers its
// own landing in sessionStorage (utm_* from location.search, plus the AI host
// from document.referrer when the visitor came from an AI answer) and sends it
// with the beacon body and on the /ut/ links' query string.
//
// Everything the browser sends is untrusted: only the keys below are read,
// utm values go through sanitizeUtmValue (64 chars), ai_ref must be a bare
// host name, and the AI key is always worked out here through
// classifyAiClickSource (slice 1). A client-sent AI key is never read.
//
// Pure: no database/init import (the funnel read takes a db handle), so a
// stats worker can use it too.

import type Database from "better-sqlite3";
import { AI_REFERRAL_HOST_DOMAINS, classifyAiClickSource } from "./human-referrals";
import { sanitizeUtmValue, type UtmParams } from "../utils/utm-capture";
import {
  AI_CLICK_VENDORS, AI_CLICK_WINDOW_DAYS, emptyAiClickSums, utcDay,
  type AiClickSums, type AiClickVendor,
} from "./profile-ai-clicks-compute";

/** sessionStorage key on the profile page. */
export const AI_ATTR_STORAGE_KEY = "rfb_ai_attr";
/** The only keys the page sends and the server reads. */
export const AI_ATTR_KEYS = ["utm_source", "utm_medium", "utm_campaign", "ai_ref"] as const;
export const AI_REF_MAX_LEN = 100;

const AI_REF_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;

/** A bare, lower-case host name (the AI marker); anything else is null. */
export function sanitizeAiRef(raw: unknown): string | null {
  const v = Array.isArray(raw) ? raw[0] : raw;
  if (typeof v !== "string") return null;
  const s = v.trim().toLowerCase().replace(/\.$/, "");
  if (!s || s.length > AI_REF_MAX_LEN || !AI_REF_RE.test(s)) return null;
  return s;
}

export interface ContactAiAttribution {
  utm: UtmParams;
  aiRef: string | null;
}

function readOne(src: unknown): ContactAiAttribution {
  const o = (src && typeof src === "object" && !Array.isArray(src) ? src : {}) as Record<string, unknown>;
  return {
    utm: {
      utm_source: sanitizeUtmValue(o.utm_source),
      utm_medium: sanitizeUtmValue(o.utm_medium),
      utm_campaign: sanitizeUtmValue(o.utm_campaign),
    },
    aiRef: sanitizeAiRef(o.ai_ref),
  };
}

/**
 * Reads only the whitelisted keys from a beacon body and/or a /ut/ query
 * object; with several sources the first one that has a key wins for it.
 */
export function readContactAttribution(...sources: unknown[]): ContactAiAttribution {
  const out: ContactAiAttribution = { utm: { utm_source: null, utm_medium: null, utm_campaign: null }, aiRef: null };
  for (const src of sources) {
    const a = readOne(src);
    out.utm.utm_source ??= a.utm.utm_source;
    out.utm.utm_medium ??= a.utm.utm_medium;
    out.utm.utm_campaign ??= a.utm.utm_campaign;
    out.aiRef ??= a.aiRef;
  }
  return out;
}

/** The AI the landing came from, worked out here; null = no AI attribution. */
export function classifyContactAiSource(a: { utm_source?: string | null; utm_campaign?: string | null; aiRef?: string | null }): AiClickVendor | null {
  return classifyAiClickSource({
    referrer: a.aiRef ? `https://${a.aiRef}/` : null,
    utm_source: a.utm_source ?? null,
    utm_campaign: a.utm_campaign ?? null,
  });
}

/**
 * Browser half, placed inside the profile page's script IIFE. Defines
 * `aiAttr` (the landing's whitelisted keys, kept in sessionStorage for the
 * tab), adds them to every same-origin /ut/ link, and `aiAttrInto(obj)` which
 * copies them onto the beacon payload. Never throws; with no utm and no AI
 * referrer nothing is stored or added, so the beacon and links are unchanged.
 */
export function aiAttributionClientJs(): string {
  return `
        var aiAttr = (function () {
          var KEYS = ${JSON.stringify(AI_ATTR_KEYS)};
          var HOSTS = ${JSON.stringify(AI_REFERRAL_HOST_DOMAINS)};
          var SK = ${JSON.stringify(AI_ATTR_STORAGE_KEY)};
          var clean = function (v, max) {
            if (typeof v !== "string") return "";
            return v.replace(/[\\u0000-\\u001f\\u007f]/g, " ").replace(/\\s+/g, " ").trim().slice(0, max);
          };
          var got = {}, any = false;
          try {
            var sp = new URLSearchParams(location.search);
            for (var i = 0; i < 3; i++) {
              var v = clean(sp.get(KEYS[i]) || "", 64);
              if (v) { got[KEYS[i]] = v; any = true; }
            }
          } catch (_) {}
          try {
            var rh = document.referrer ? new URL(document.referrer).hostname.toLowerCase() : "";
            for (var j = 0; rh && j < HOSTS.length; j++) {
              var h = HOSTS[j];
              if (rh === h || rh.slice(-(h.length + 1)) === "." + h) { got.ai_ref = rh.slice(0, ${AI_REF_MAX_LEN}); any = true; break; }
            }
          } catch (_) {}
          try {
            if (any) {
              sessionStorage.setItem(SK, JSON.stringify(got));
            } else {
              var s = JSON.parse(sessionStorage.getItem(SK) || "null");
              if (s && typeof s === "object") {
                for (var k = 0; k < KEYS.length; k++) {
                  var sv = clean(s[KEYS[k]], k === 3 ? ${AI_REF_MAX_LEN} : 64);
                  if (sv) got[KEYS[k]] = sv;
                }
              }
            }
          } catch (_) {}
          return got;
        })();
        var aiAttrInto = function (o) {
          for (var k in aiAttr) if (Object.prototype.hasOwnProperty.call(aiAttr, k)) o[k] = aiAttr[k];
          return o;
        };
        try {
          var aiQs = [];
          for (var aq in aiAttr) if (Object.prototype.hasOwnProperty.call(aiAttr, aq)) aiQs.push(aq + "=" + encodeURIComponent(aiAttr[aq]));
          if (aiQs.length) {
            var utLinks = document.querySelectorAll('a[href^="/ut/"]');
            for (var ui = 0; ui < utLinks.length; ui++) {
              var uh = utLinks[ui].getAttribute("href") || "";
              if (uh.indexOf("?") === -1) utLinks[ui].setAttribute("href", uh + "?" + aiQs.join("&"));
            }
          }
        } catch (_) {}`;
}

// ─── Funnel read: contact clicks from an AI landing ─────────────────────────

export interface ProfileAiContactClicks {
  windowDays: number;
  /** Contact clicks by people (is_bot = 0) on the profile in the window. */
  contactClicks: number;
  /** Of those, the ones whose landing came from an AI answer, per AI. */
  fromAi: AiClickSums;
}

function hasAiSourceColumn(db: Database.Database): boolean {
  try {
    const cols = db.prepare("PRAGMA table_info(contact_clicks)").all() as Array<{ name: string }>;
    return cols.some((c) => c.name === "ai_source");
  } catch {
    return false;
  }
}

/**
 * Contact clicks on one profile (agent_id) in the last `windowDays` days
 * (today included, UTC), and how many of them came from an AI answer, per AI.
 * Reused by the display slice. Bot clicks are left out.
 */
export function getProfileAiContactClicks(
  db: Database.Database,
  agentId: string,
  nowMs: number = Date.now(),
  windowDays: number = AI_CLICK_WINDOW_DAYS,
): ProfileAiContactClicks {
  const days = Math.max(1, Math.floor(windowDays));
  const out: ProfileAiContactClicks = { windowDays: days, contactClicks: 0, fromAi: emptyAiClickSums() };
  if (!hasAiSourceColumn(db)) return out;
  const since = utcDay(nowMs - (days - 1) * 24 * 60 * 60 * 1000);
  const rows = db.prepare(`
    SELECT ai_source, COUNT(*) AS n FROM contact_clicks
    WHERE agent_id = ? AND is_bot = 0 AND created_at >= ?
    GROUP BY ai_source
  `).all(agentId, since) as Array<{ ai_source: string | null; n: number }>;
  for (const r of rows) {
    out.contactClicks += r.n;
    if (!r.ai_source) continue;
    const vendor = (AI_CLICK_VENDORS as readonly string[]).includes(r.ai_source) ? (r.ai_source as AiClickVendor) : "other";
    out.fromAi.byVendor[vendor] += r.n;
    out.fromAi.total += r.n;
  }
  return out;
}
