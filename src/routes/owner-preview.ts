// ─── Segment B read-only preview link: /forhandsvis/:token ──────────────────
// dev-request 2026-10-22-rfb-mine-valg-eierbrytere, S5-2 («Forhåndsvisning for
// segment B»). Segment B = a producer who confirmed the profile but is not an
// owner (agent_owner_interest, S5-1).
//
//   POST /admin/agents/:id/preview-link   body { ttl_days?: 1..30 } (zod strict)
//        Mints a signed, expiring link. 404 unknown agent; 409 not_segment_b /
//        already_owner / inactive. Writes NOTHING. Works with the flag off
//        (response carries `enabled`).
//   GET  /forhandsvis/:token              public, read-only page. Behind
//        OWNER_PREVIEW_LINKS_ENABLED (default OFF → 404). GET changes nothing:
//        no INSERT/UPDATE/DELETE, no page-view row (/forhandsvis/ is in the
//        analytics skipPaths).
//
// Token: stateless, `<b64url(p1\n<agentId>\n<expEpochSec>)>.<sig>`, the sig being
// the keyed HMAC of avmeld-service.serverSignatureFor with its OWN purpose
// string, so an /avmeld token never validates here and vice versa.
//
// Rollback: flag off (or unmount); nothing is stored.

import crypto from "crypto";
import { Router, Request, Response } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { getDb } from "../database/init";
import { customerRuleSql } from "../services/customer-rule";
import { serverSignatureFor } from "../services/avmeld-service";
import { slugify } from "../utils/slug";
import { OWNER_FEATURE_GROUPS, ownerFeatureRegistryFor, ownerFeatureStatus } from "../owner-features/registry";
import { resolveOwnerFeatures } from "../owner-features/resolve";
import { formatOwnerFeatureValue } from "../owner-features/page";

export const OWNER_PREVIEW_FLAG = "OWNER_PREVIEW_LINKS_ENABLED";
export const OWNER_PREVIEW_PURPOSE = "owner-preview-v1";
export const OWNER_PREVIEW_DEFAULT_TTL_DAYS = 30;
export const OWNER_PREVIEW_MAX_TTL_DAYS = 30;
const DAY_S = 86400;

export function ownerPreviewEnabled(): boolean {
  const v = process.env[OWNER_PREVIEW_FLAG];
  return v === "1" || v === "true";
}

// Injectable DB seam (tests only), same convention as admin-owner-interest.ts.
let dbOverrideForTesting: ReturnType<typeof getDb> | null = null;
/** Test-only. Pass null to clear. */
export function __setOwnerPreviewDbForTesting(db: ReturnType<typeof getDb> | null): void {
  dbOverrideForTesting = db;
}
function resolveDb(): ReturnType<typeof getDb> {
  return dbOverrideForTesting ?? getDb();
}

// ── Token ───────────────────────────────────────────────────────────────────
function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** null when no server secret is configured (fail closed). */
export function makeOwnerPreviewToken(agentId: string, expiresAtSec: number): string | null {
  if (!agentId || agentId.includes("\n")) return null;
  const payload = b64url(Buffer.from(`p1\n${agentId}\n${Math.floor(expiresAtSec)}`, "utf8"));
  const sig = serverSignatureFor(OWNER_PREVIEW_PURPOSE, payload);
  return sig ? `${payload}.${sig}` : null;
}

export type OwnerPreviewVerdict =
  | { status: "ok"; agentId: string; expiresAtSec: number }
  | { status: "expired" }
  | { status: "invalid" };

export function verifyOwnerPreviewToken(token: string, nowSec: number = Math.floor(Date.now() / 1000)): OwnerPreviewVerdict {
  const invalid: OwnerPreviewVerdict = { status: "invalid" };
  if (typeof token !== "string" || token.length > 600) return invalid;
  const dot = token.indexOf(".");
  if (dot <= 0 || dot === token.length - 1) return invalid;
  const payload = token.slice(0, dot);
  const expectedSig = serverSignatureFor(OWNER_PREVIEW_PURPOSE, payload);
  if (!expectedSig) return invalid;
  const given = Buffer.from(token.slice(dot + 1), "utf8");
  const expected = Buffer.from(expectedSig, "utf8");
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return invalid;
  const parts = Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8").split("\n");
  if (parts.length !== 3 || parts[0] !== "p1" || !parts[1] || !/^\d{1,12}$/.test(parts[2])) return invalid;
  const exp = parseInt(parts[2], 10);
  // A validly signed token never claims more than the maximum lifetime (+1 day slack).
  if (exp > nowSec + (OWNER_PREVIEW_MAX_TTL_DAYS + 1) * DAY_S) return invalid;
  if (exp <= nowSec) return { status: "expired" };
  return { status: "ok", agentId: parts[1], expiresAtSec: exp };
}

// ── Agent state (read-only) ─────────────────────────────────────────────────
type PreviewState = "ok" | "unknown" | "not_segment_b" | "already_owner" | "inactive";
interface AgentFacts {
  state: PreviewState;
  name: string;
}

function readAgentFacts(db: ReturnType<typeof getDb>, id: string): AgentFacts {
  const row = db
    .prepare(
      `SELECT a.name AS name, a.is_active AS is_active, a.catalog_hidden AS catalog_hidden,
              ${customerRuleSql("a")} AS owned,
              (SELECT 1 FROM agent_owner_interest oi WHERE oi.agent_id = a.id) AS marked
         FROM agents a WHERE a.id = ?`,
    )
    .get(id) as { name: string; is_active: number | null; catalog_hidden: number | null; owned: number; marked: number | null } | undefined;
  if (!row) return { state: "unknown", name: "" };
  const name = String(row.name ?? "");
  if (!row.marked) return { state: "not_segment_b", name };
  if (row.owned === 1) return { state: "already_owner", name };
  if (row.is_active !== 1 || row.catalog_hidden === 1) return { state: "inactive", name };
  return { state: "ok", name };
}

function publicBase(): string {
  return (process.env.APP_URL || "https://rettfrabonden.com").replace(/\/+$/, "");
}

// ── Admin mint ──────────────────────────────────────────────────────────────
function requireAdmin(req: Request, res: Response): boolean {
  const expected = process.env.ADMIN_KEY || process.env.ANALYTICS_ADMIN_KEY || "";
  if (!expected) {
    res.status(503).json({ error: "Admin not configured" });
    return false;
  }
  if (((req.headers["x-admin-key"] as string) || "") !== expected) {
    res.status(403).json({ error: "Krever X-Admin-Key header" });
    return false;
  }
  return true;
}

export const previewLinkBodySchema = z
  .object({ ttl_days: z.number().int().min(1).max(OWNER_PREVIEW_MAX_TTL_DAYS).optional() })
  .strict();

// Mounted at "/admin/agents/:id/preview-link" (mergeParams), so the route is "/".
export const ownerPreviewAdminRouter = Router({ mergeParams: true });

ownerPreviewAdminRouter.post("/", (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  const id = typeof req.params.id === "string" ? req.params.id.trim() : "";
  if (!id || id.length > 200) {
    res.status(400).json({ error: "invalid agent id" });
    return;
  }
  const parsed = previewLinkBodySchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "invalid body", details: parsed.error.issues });
    return;
  }
  const ttl = parsed.data.ttl_days ?? OWNER_PREVIEW_DEFAULT_TTL_DAYS;
  let facts: AgentFacts;
  try {
    facts = readAgentFacts(resolveDb(), id);
  } catch {
    res.status(500).json({ error: "preview-link lookup failed" });
    return;
  }
  if (facts.state === "unknown") {
    res.status(404).json({ error: "Agent not found", agent_id: id });
    return;
  }
  if (facts.state !== "ok") {
    res.status(409).json({ error: facts.state, agent_id: id });
    return;
  }
  const expSec = Math.floor(Date.now() / 1000) + ttl * DAY_S;
  const token = makeOwnerPreviewToken(id, expSec);
  if (!token) {
    res.status(503).json({ error: "Signing secret not configured" });
    return;
  }
  res.json({
    agent_id: id,
    url: `${publicBase()}/forhandsvis/${token}`,
    expires_at: new Date(expSec * 1000).toISOString(),
    ttl_days: ttl,
    enabled: ownerPreviewEnabled(),
  });
});

// ── Public page ─────────────────────────────────────────────────────────────
const router = Router();

const previewLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  validate: { trustProxy: false },
  message: "For mange forsøk. Prøv igjen om litt.",
});

function esc(s: unknown): string {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function page(title: string, body: string): string {
  return `<!doctype html><html lang="nb"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>${esc(title)}</title>
<style>body{margin:0;background:#FEFAE0;color:#1a1a1a;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;line-height:1.6}
main{max-width:640px;margin:0 auto;padding:40px 16px}h1{color:#2D5016;font-size:1.5rem}h2{color:#2D5016;font-size:1.1rem;margin-top:1.6em}
dl{margin:0}dt{font-weight:600}dd{margin:0 0 .8em}a{color:#2D5016}
.btn{display:inline-block;min-height:44px;box-sizing:border-box;padding:10px 20px;background:#2D5016;color:#fff;border-radius:8px;text-decoration:none}</style>
</head><body><main>${body}</main></body></html>`;
}

function send(res: Response, status: number, html: string): void {
  res.setHeader("X-Robots-Tag", "noindex");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.status(status).type("html").send(html);
}

const GONE = page("Lenken gjelder ikke lenger", `<h1>Lenken gjelder ikke lenger</h1><p>Forhåndsvisningen er ikke tilgjengelig. Skriv til <a href="mailto:kontakt@rettfrabonden.com">kontakt@rettfrabonden.com</a>, så hjelper vi deg.</p>`);

function currentChoicesHtml(agentId: string): string {
  const resolved = resolveOwnerFeatures("rfb", agentId, { db: resolveDb() });
  const entries = ownerFeatureRegistryFor("rfb").filter((e) => ownerFeatureStatus(e) === "live");
  const groups: string[] = [];
  for (const g of OWNER_FEATURE_GROUPS) {
    const items = entries.filter((e) => e.group === g.key);
    if (!items.length) continue;
    const rows = items
      .map((e) => {
        const r = resolved.byKey[e.key];
        if (!r) return "";
        return `<dt>${esc(e.label.no)}</dt><dd>${esc(formatOwnerFeatureValue(e, r.value))}</dd>`;
      })
      .join("");
    groups.push(`<h3>${esc(g.label.no)}</h3><dl>${rows}</dl>`);
  }
  return groups.join("") || "<p>Ingen valg gjelder for profilen din i dag.</p>";
}

router.get("/forhandsvis/:token", previewLimiter, (req: Request, res: Response) => {
  if (!ownerPreviewEnabled()) return void res.status(404).send("Not found");
  const verdict = verifyOwnerPreviewToken(String(req.params.token || ""));
  if (verdict.status === "invalid") {
    return send(res, 404, page("Ugyldig lenke", `<h1>Ugyldig lenke</h1><p>Lenken er ikke gyldig.</p>`));
  }
  if (verdict.status === "expired") {
    return send(res, 410, page("Lenken er utløpt", `<h1>Lenken er utløpt</h1><p>Denne forhåndsvisningen er ikke lenger gyldig. Skriv til <a href="mailto:kontakt@rettfrabonden.com">kontakt@rettfrabonden.com</a>, så sender vi en ny.</p>`));
  }
  let facts: AgentFacts;
  try {
    facts = readAgentFacts(resolveDb(), verdict.agentId);
  } catch {
    return send(res, 500, page("Feil", `<h1>Noe gikk galt</h1><p>Prøv igjen senere.</p>`));
  }
  if (facts.state !== "ok") return send(res, 410, GONE);

  const profileHref = `/produsent/${encodeURIComponent(slugify(facts.name))}`;
  const claimHref = `/selger?agent=${encodeURIComponent(verdict.agentId)}`;
  let choices: string;
  try {
    choices = currentChoicesHtml(verdict.agentId);
  } catch {
    return send(res, 500, page("Feil", `<h1>Noe gikk galt</h1><p>Prøv igjen senere.</p>`));
  }
  return send(
    res,
    200,
    page(
      `Forhåndsvisning – ${facts.name}`,
      `<h1>${esc(facts.name)}</h1>
<p><a href="${esc(profileHref)}">Se profilen din slik den vises offentlig</a></p>
<h2>Slik står profilen din i dag</h2>
<p>Dette er valgene som gjelder for profilen din i dag. Du kan bare se dem her, ingenting kan endres fra denne siden.</p>
${choices}
<h2>Ta over profilen</h2>
<p>Når du har tatt over profilen, kommer du rett til «Mine valg», der du selv bestemmer.</p>
<p><a class="btn" href="${esc(claimHref)}">Ta over profilen</a></p>`,
    ),
  );
});

export default router;
