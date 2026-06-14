// ─── POST /admin/search-enrich (orchestrator-pr-10, 2026-06-14) ──────────────
//
// Per-producer web-search → crawl → confirm → producer-email extraction.
//
// For producers (agents) that are missing an email but DO have a phone number
// (the cross-check key), this endpoint:
//   1. SEARCHES the web for the producer's name (+ city) via the Brave API,
//   2. ranks candidate result URLs by name-stem overlap,
//   3. CRAWLS the top ≤2 candidate pages (plus /kontakt and /om-oss on the same
//      host) and extracts emails + phones,
//   4. CONFIRMS the page really belongs to the producer (hard key match on
//      phone/orgnr = strong; ≥2 soft signals = medium),
//   5. picks the producer's OWN email, rejecting directory/coordinator addresses
//      (post@hanen.no et al.) and refusing to guess when ambiguous.
//
// DRY-RUN BY DEFAULT. Writes happen only when apply is truthy AND the row is
// `write`-tier: strength === 'strong' (key-confirmed) AND an unambiguous
// producer email was picked. Anything weaker is reported as `queue`/`none` for
// human review — never auto-written. We NEVER overwrite a non-empty value.
//
// Auth: X-Admin-Key (same pattern as admin-knowledge / prune-dead-urls).
//
// The decision logic lives in services/search-enrich.ts (pure + unit-tested);
// this route is the orchestration + I/O shell.

import { Router, Request, Response } from "express";
import { getDb } from "../database/init";
import { mergeFieldProvenance } from "./admin-knowledge";
import {
  braveSearch,
  rankCandidates,
  confirmProducerPage,
  pickProducerEmail,
  nameStems,
  type PageEvidence,
  type StoredProducer,
} from "../services/search-enrich";

const router = Router();

// ─── Auth (mirrors admin-knowledge.ts) ────────────────────────────────────────
function getAdminKey(): string {
  return process.env.ADMIN_KEY || process.env.ANALYTICS_ADMIN_KEY || "";
}

function requireAdmin(req: Request, res: Response): boolean {
  const expected = getAdminKey();
  if (!expected) {
    res.status(503).json({ error: "Admin not configured" });
    return false;
  }
  const provided = (req.headers["x-admin-key"] as string) || "";
  if (provided !== expected) {
    res.status(403).json({ error: "Krever X-Admin-Key header" });
    return false;
  }
  return true;
}

// ─── Tunables ─────────────────────────────────────────────────────────────────
const DEFAULT_LIMIT = 25;
const HARD_CAP = 50;
const FETCH_TIMEOUT_MS = 8_000;
const PACE_MS = 1_100; // ~1.1s between agents → respect Brave's ~1 req/sec free tier
const UA = "Lokal-RFB-Scraper/1.0 (+https://rettfrabonden.com)";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ─── Email / phone / title extraction (mirrors marketplace.ts processAgent) ───

/** Collect ALL candidate emails from HTML (mailto: links first, then bare). */
function extractEmails(html: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (e: string) => {
    const lc = e.toLowerCase();
    if (!seen.has(lc)) {
      seen.add(lc);
      out.push(lc);
    }
  };
  const mailtoRe = /mailto:([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})/gi;
  let m: RegExpExecArray | null;
  while ((m = mailtoRe.exec(html)) !== null) push(m[1]!);
  const bareRe = /\b([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})\b/g;
  while ((m = bareRe.exec(html)) !== null) push(m[1]!);
  return out;
}

/** Normalise a Norwegian phone to 8 digits (mirrors marketplace.normalisePhone). */
function normalisePhone(raw: string): string {
  return raw
    .replace(/^\+47/, "")
    .replace(/^0047/, "")
    .replace(/^\+/, "")
    .replace(/[\s\-().]/g, "")
    .replace(/\D/g, "");
}

/** Collect ALL candidate phone numbers from HTML (mirrors marketplace.extractPhone). */
function extractPhones(html: string): string[] {
  const text = html.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ");
  const re = /(?:\+47|0047|47[\s\-])?(\d{2}[\s\-]?\d{2}[\s\-]?\d{2}[\s\-]?\d{2})\b/g;
  const out: string[] = [];
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const digits = normalisePhone(m[0]);
    if (digits.length === 8 && !/^(\d)\1{7}$/.test(digits) && !seen.has(digits)) {
      seen.add(digits);
      out.push(digits);
    }
  }
  return out;
}

/** Extract a page title from <title> or og:title. */
function extractTitle(html: string): string {
  const og = html.match(
    /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i,
  );
  if (og && og[1]) return og[1].trim();
  const t = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (t && t[1]) return t[1].replace(/\s+/g, " ").trim();
  return "";
}

async function fetchHtml(url: string): Promise<string | null> {
  const fetchUrl = /^https?:\/\//i.test(url) ? url : `https://${url}`;
  try {
    const resp = await fetch(fetchUrl, {
      redirect: "follow",
      headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!resp.ok) return null;
    return await resp.text();
  } catch {
    return null;
  }
}

/**
 * Crawl the chosen candidate URL plus same-host /kontakt and /om-oss, and merge
 * all extracted emails/phones into one PageEvidence (title from the primary page).
 */
async function buildPageEvidence(primaryUrl: string): Promise<PageEvidence | null> {
  const primaryHtml = await fetchHtml(primaryUrl);
  if (primaryHtml === null) return null;

  const emails = new Set<string>(extractEmails(primaryHtml));
  const phones = new Set<string>(extractPhones(primaryHtml));
  let combinedHtml = primaryHtml;
  const title = extractTitle(primaryHtml);

  // Try same-host /kontakt and /om-oss for additional contact details.
  try {
    const u = new URL(/^https?:\/\//i.test(primaryUrl) ? primaryUrl : `https://${primaryUrl}`);
    const base = `${u.protocol}//${u.host}`;
    for (const path of ["/kontakt", "/om-oss"]) {
      const subHtml = await fetchHtml(`${base}${path}`);
      if (subHtml) {
        for (const e of extractEmails(subHtml)) emails.add(e);
        for (const p of extractPhones(subHtml)) phones.add(p);
        combinedHtml += "\n" + subHtml;
      }
    }
  } catch {
    /* malformed URL — primary page evidence still stands */
  }

  return {
    url: primaryUrl,
    title,
    html: combinedHtml,
    emails: Array.from(emails),
    phones: Array.from(phones),
  };
}

// ─── helpers ──────────────────────────────────────────────────────────────────

function registrableHostFromUrl(raw: string): string | null {
  try {
    const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    const host = new URL(withScheme).hostname.toLowerCase().replace(/^www\./, "");
    const labels = host.split(".").filter(Boolean);
    if (labels.length < 2) return null;
    return labels.slice(-2).join(".");
  } catch {
    return null;
  }
}

type Tier = "write" | "queue" | "none";

interface ResultRow {
  agent_id: string;
  name: string;
  query: string;
  chosen_url: string | null;
  confirm: { confirmed: boolean; strength: string; signals: string[] };
  candidate_email: string | null;
  email_reason: string;
  tier: Tier;
}

interface TargetAgent {
  agent_id: string;
  name: string;
  city: string | null;
  url: string | null;
  phone: string | null;
  website: string | null;
  email: string | null;
  postcode: string | null;
  address: string | null;
}

// ─── route ─────────────────────────────────────────────────────────────────────

router.post("/", async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;

  const braveKey = process.env.BRAVE_API_KEY || process.env.BRAVE_SEARCH_API_KEY || "";
  if (!braveKey) {
    res.status(503).json({ error: "BRAVE_API_KEY not configured" });
    return;
  }

  // ── params (query or JSON body) ──
  const body = (req.body ?? {}) as Record<string, unknown>;
  const rawLimit = req.query["limit"] ?? body["limit"];
  let limit = DEFAULT_LIMIT;
  if (rawLimit !== undefined && !isNaN(Number(rawLimit)) && Number(rawLimit) > 0) {
    limit = Math.min(Math.floor(Number(rawLimit)), HARD_CAP);
  }

  const applyFromQuery = req.query["apply"] === "1" || req.query["apply"] === "true";
  const bodyApply = body["apply"];
  const applyFromBody =
    bodyApply === true || bodyApply === "1" || bodyApply === "true";
  const apply = applyFromQuery || applyFromBody;
  const dryRun = !apply;

  let agentIds: string[] | null = null;
  const rawIds = body["agentIds"] ?? req.query["agentIds"];
  if (Array.isArray(rawIds)) {
    agentIds = rawIds.map((x) => String(x)).filter(Boolean);
  } else if (typeof rawIds === "string" && rawIds.trim()) {
    agentIds = rawIds.split(",").map((s) => s.trim()).filter(Boolean);
  }

  const db = getDb();

  // ── optional skip-tracking column (idempotent guarded ALTER) ──
  let hasLastSearchAt = true;
  try {
    db.exec("ALTER TABLE agent_knowledge ADD COLUMN last_search_at TEXT");
  } catch {
    /* column already exists — expected after first run */
  }
  // Confirm it's really there (in case the catch masked a different failure).
  try {
    const cols = db.prepare("PRAGMA table_info(agent_knowledge)").all() as Array<{ name: string }>;
    hasLastSearchAt = cols.some((c) => c.name === "last_search_at");
  } catch {
    hasLastSearchAt = false;
  }

  // ── target selection ──
  let targets: TargetAgent[];
  const selectCols = `
    a.id   AS agent_id,
    a.name AS name,
    a.city AS city,
    a.url  AS url,
    k.phone   AS phone,
    k.website AS website,
    k.email   AS email,
    k.postal_code AS postcode,
    k.address AS address
  `;
  if (agentIds && agentIds.length > 0) {
    const capped = agentIds.slice(0, HARD_CAP);
    const placeholders = capped.map(() => "?").join(",");
    targets = db
      .prepare(
        `SELECT ${selectCols}
         FROM agents a
         LEFT JOIN agent_knowledge k ON k.agent_id = a.id
         WHERE a.id IN (${placeholders})`,
      )
      .all(...capped) as TargetAgent[];
  } else {
    // email missing/null AND phone present; exclude opt-out / customer / CRM-blocked.
    const orderClause = hasLastSearchAt
      ? "ORDER BY k.last_search_at ASC NULLS LAST, a.created_at ASC"
      : "ORDER BY a.created_at ASC";
    targets = db
      .prepare(
        `SELECT ${selectCols}
         FROM agents a
         INNER JOIN agent_knowledge k ON k.agent_id = a.id
         WHERE (k.email IS NULL OR trim(k.email) = '')
           AND k.phone IS NOT NULL AND trim(k.phone) != ''
           AND (k.verification_status IS NULL OR k.verification_status != 'opt_out')
           AND a.claimed_at IS NULL
           AND NOT EXISTS (
             SELECT 1 FROM crm_contacts cc
             WHERE cc.agent_id = a.id AND cc.status != 'active'
           )
         ${orderClause}
         LIMIT ?`,
      )
      .all(limit) as TargetAgent[];
  }

  const rows: ResultRow[] = [];
  const now = new Date().toISOString();

  const stampSearchStmt = hasLastSearchAt
    ? db.prepare("UPDATE agent_knowledge SET last_search_at = ?, updated_at = ? WHERE agent_id = ?")
    : null;

  for (let i = 0; i < targets.length; i++) {
    const t = targets[i]!;
    let row: ResultRow = {
      agent_id: t.agent_id,
      name: t.name,
      query: "",
      chosen_url: null,
      confirm: { confirmed: false, strength: "none", signals: [] },
      candidate_email: null,
      email_reason: "not_processed",
      tier: "none",
    };

    try {
      // pace between agents (skip the wait before the first one)
      if (i > 0) await sleep(PACE_MS);

      const geo = (t.city ?? "").trim();
      const query = `"${t.name}" ${geo}`.trim();
      row.query = query;

      const results = await braveSearch(query, braveKey, 5);
      const urls = rankCandidates(results, t.name);

      const siteRoot = t.website ? registrableHostFromUrl(t.website) : null;
      const stored: StoredProducer = {
        name: t.name,
        phone: t.phone,
        postcode: t.postcode,
        street: t.address,
        orgnr: null, // no orgnr column on agents/agent_knowledge in this schema
        siteRoot,
      };

      let bestConfirm = row.confirm;
      let bestUrl: string | null = null;
      let bestEvidence: PageEvidence | null = null;

      // Crawl the top ≤2 candidates; keep the strongest confirmation.
      for (const url of urls) {
        const evidence = await buildPageEvidence(url);
        if (!evidence) continue;
        const conf = confirmProducerPage(stored, evidence);
        const rank = (s: string) => (s === "strong" ? 2 : s === "medium" ? 1 : 0);
        if (bestUrl === null || rank(conf.strength) > rank(bestConfirm.strength)) {
          bestConfirm = conf;
          bestUrl = url;
          bestEvidence = evidence;
          if (conf.strength === "strong") break; // can't do better
        }
      }

      row.chosen_url = bestUrl;
      row.confirm = bestConfirm;

      let pickedEmail: string | null = null;
      let emailReason = bestUrl ? "no_acceptable_email" : "no_candidate_url";

      if (bestConfirm.confirmed && bestEvidence) {
        const pick = pickProducerEmail(bestEvidence.emails, t.name, siteRoot);
        pickedEmail = pick.email;
        emailReason = pick.reason;
      } else if (bestUrl) {
        emailReason = "page_not_confirmed";
      }
      row.candidate_email = pickedEmail;
      row.email_reason = emailReason;

      // ── tier decision ──
      let tier: Tier = "none";
      if (bestConfirm.strength === "strong" && pickedEmail) {
        tier = "write";
      } else if (
        (bestConfirm.confirmed && pickedEmail) || // confirmed (medium) + email
        (bestConfirm.confirmed && !pickedEmail) || // confirmed but no usable email
        (bestUrl !== null && bestConfirm.strength === "medium") // website found, medium
      ) {
        tier = "queue";
      }
      row.tier = tier;

      // ── apply writes (write-tier only) ──
      if (apply && tier === "write" && pickedEmail) {
        try {
          applyWrite(db, t, pickedEmail, bestUrl, now);
        } catch (writeErr: any) {
          // surface write failure in the row but don't abort the batch
          row.email_reason = `${emailReason};write_failed:${writeErr?.message ?? String(writeErr)}`;
        }
      }
    } catch (agentErr: any) {
      // One agent failing must not abort the batch — record it as a 'none'
      // row with the error reason and move on. finalCounts (computed from
      // `rows` after the loop) is the single source of truth for the tallies.
      row.email_reason = `error:${agentErr?.message ?? String(agentErr)}`;
      row.tier = "none";
    } finally {
      // skip-tracking: stamp every processed agent (best-effort)
      if (apply && stampSearchStmt) {
        try {
          stampSearchStmt.run(now, now, t.agent_id);
        } catch {
          /* non-fatal */
        }
      }
      rows.push(row);
    }
  }

  // Tally tiers from the final rows (single source of truth — robust to
  // per-agent errors that reassign a row's tier to 'none').
  const finalCounts = { write: 0, queue: 0, none: 0 };
  for (const r of rows) finalCounts[r.tier]++;

  res.json({
    dry_run: dryRun,
    brave_key: "present",
    scanned: targets.length,
    counts: finalCounts,
    rows,
  });
});

// ─── provenance write (mirrors PR-7 homepage-provenance + admin-knowledge) ────
//
// Writes the producer email (and website=chosen_url when website is empty) using
// the SAME field_provenance merge path the enrichment SKILL uses. NEVER
// overwrites a non-empty existing value. source_type = `web_search:<domain>`.
function applyWrite(
  db: ReturnType<typeof getDb>,
  t: TargetAgent,
  email: string,
  chosenUrl: string | null,
  nowIso: string,
): void {
  // Re-read current values inside the txn for a fresh non-empty guard.
  const tx = db.transaction(() => {
    // Ensure a knowledge row exists.
    const exists = db
      .prepare("SELECT email, website FROM agent_knowledge WHERE agent_id = ?")
      .get(t.agent_id) as { email: string | null; website: string | null } | undefined;

    if (!exists) {
      db.prepare(
        "INSERT INTO agent_knowledge (agent_id, field_provenance, updated_at) VALUES (?, '{}', ?)",
      ).run(t.agent_id, nowIso);
    }

    const curEmail = exists?.email ?? null;
    const curWebsite = exists?.website ?? null;

    const emailDomain = (email.split("@")[1] ?? "").toLowerCase();
    const sourceType = `web_search:${emailDomain}`;

    // Column writes — only fill empties (never overwrite non-empty).
    const colSets: string[] = [];
    const colVals: unknown[] = [];
    if (!curEmail || !curEmail.trim()) {
      colSets.push("email = ?");
      colVals.push(email);
    }
    if (chosenUrl && (!curWebsite || !curWebsite.trim())) {
      colSets.push("website = ?");
      colVals.push(chosenUrl);
    }
    if (colSets.length > 0) {
      colVals.push(nowIso, t.agent_id);
      db.prepare(
        `UPDATE agent_knowledge SET ${colSets.join(", ")}, updated_at = ? WHERE agent_id = ?`,
      ).run(...colVals);
    }

    // Provenance merge — append an email source (idempotent via dedupKey).
    const provRow = db
      .prepare("SELECT field_provenance FROM agent_knowledge WHERE agent_id = ?")
      .get(t.agent_id) as { field_provenance?: string } | undefined;
    let existingProv: Record<string, unknown> = {};
    if (provRow?.field_provenance) {
      try {
        const parsed = JSON.parse(provRow.field_provenance);
        if (parsed && typeof parsed === "object") existingProv = parsed as Record<string, unknown>;
      } catch {
        existingProv = {};
      }
    }
    const merged = mergeFieldProvenance(existingProv, {
      email: {
        sources: [
          {
            source_type: sourceType,
            value: email,
            fetched_at: nowIso,
            source_url: chosenUrl ?? undefined,
          },
        ],
      },
    });
    db.prepare(
      "UPDATE agent_knowledge SET field_provenance = ?, updated_at = ? WHERE agent_id = ?",
    ).run(JSON.stringify(merged), nowIso, t.agent_id);
  });
  tx();
}

export default router;

// Re-export pure helpers used by tests / callers that import from the route.
export { nameStems };
