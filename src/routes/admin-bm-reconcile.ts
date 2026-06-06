// ─── Admin: bondensmarked.no canonical reconcile (orchestrator PR-123) ────────
//
// GET /admin/bm-reconcile
//
//   Compares bondensmarked.no/lokallag (canonical fasit) against our DB's
//   BM lokallag umbrella agents. REPORT ONLY — read-only diagnostics.
//   The orchestrator / Daniel acts on the output manually.
//
// Auth: X-Admin-Key (same key used by /admin/bm-events and /admin/runs).
//
// Response shape:
//   {
//     fetched_at: ISO string,
//     canonical: BmLokallag[],           // 14 entries from bondensmarked.no
//     ours: OurLokallag[],               // market_network agents under BM Norge
//     missing_from_ours: BmLokallag[],   // in canonical, not in our DB
//     extra_in_ours:     OurLokallag[],  // in our DB, not in canonical
//     name_mismatches:   NameMismatch[], // same slug, different display name
//     count_deltas:      CountDelta[],   // canonical vs ours numeric counts
//     deviations:        Deviation[],    // upcoming-event count vs canonical markeder
//   }
//
// TODO (daily skill): call GET /admin/bm-reconcile and include `deviations`
//   in the daily bm-events-runs report to flag count mismatches automatically.
//   Wiring into the existing runBmEventsScraper() result is invasive; the
//   reconcile endpoint is the cleaner integration point (PR-124 follow-up).

import { Router, Request, Response } from "express";
import { getDb } from "../database/init";
import { fetchBmLokallag, BmLokallag } from "../services/bondensmarked-source";

const router = Router();

// ─── Auth helper (same pattern as admin-bm-events.ts) ─────────────────────────

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

// ─── Types ────────────────────────────────────────────────────────────────────

interface OurLokallag {
  id: string;
  name: string;
  /** bm_slug stored in umbrella_scrape_config JSON, or derived from name */
  slug: string | null;
  city: string | null;
  is_active: boolean;
  umbrella_member_count: number | null;
}

interface NameMismatch {
  slug: string;
  canonical_name: string;
  our_name: string;
}

interface CountDelta {
  slug: string;
  canonical_markeder: number;
  canonical_produsenter: number;
  canonical_markedsplasser: number;
  /** null when we don't store this count */
  our_member_count: number | null;
}

interface Deviation {
  slug: string;
  our_name: string;
  canonical_markeder: number;
  /** upcoming bm_market_events count for this lokallag's subtree */
  ours_upcoming: number;
  delta: number;
}

// ─── Route ────────────────────────────────────────────────────────────────────

router.get("/", async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;

  try {
    // 1. Fetch canonical data from bondensmarked.no
    const canonical = await fetchBmLokallag();

    // 2. Load our BM lokallag from the DB
    const db = getDb();

    // Find the national umbrella ("Bondens marked Norge")
    const national = db.prepare(
      "SELECT id FROM agents WHERE LOWER(name) = LOWER(?) AND umbrella_type IS NOT NULL LIMIT 1"
    ).get("Bondens marked Norge") as { id: string } | undefined;

    let ours: OurLokallag[] = [];
    let ourUpcomingByAgentId: Map<string, number> = new Map();

    if (national) {
      // Pull all market_network children of the national umbrella
      const rows = db.prepare(`
        SELECT id, name, city, is_active, umbrella_member_count, umbrella_scrape_config
        FROM agents
        WHERE parent_umbrella_id = ?
          AND umbrella_type = 'market_network'
        ORDER BY name
      `).all(national.id) as Array<{
        id: string;
        name: string;
        city: string | null;
        is_active: number;
        umbrella_member_count: number | null;
        umbrella_scrape_config: string | null;
      }>;

      ours = rows.map(r => {
        // Try to extract bm_slug from scrape config JSON
        let slug: string | null = null;
        try {
          const cfg = r.umbrella_scrape_config ? JSON.parse(r.umbrella_scrape_config) : null;
          slug = cfg?.bm_slug ?? cfg?.slug ?? null;
        } catch { /* ignore */ }
        return {
          id: r.id,
          name: r.name,
          slug,
          city: r.city,
          is_active: r.is_active === 1,
          umbrella_member_count: r.umbrella_member_count,
        };
      });

      // 3. Upcoming event counts per lokallag (for deviations)
      // Count bm_market_events rows where start_at >= now, grouped by
      // venue_agent_id, then map back to parent lokallag.
      try {
        const now = new Date().toISOString();
        // Get all venue agents under each lokallag
        const locallagIds = rows.map(r => r.id);
        if (locallagIds.length > 0) {
          const placeholders = locallagIds.map(() => "?").join(",");
          const venues = db.prepare(`
            SELECT id, parent_umbrella_id
            FROM agents
            WHERE umbrella_type = 'venue'
              AND parent_umbrella_id IN (${placeholders})
          `).all(...locallagIds) as Array<{ id: string; parent_umbrella_id: string }>;

          // Build venue→lokallag map
          const venueToLokallag = new Map<string, string>();
          for (const v of venues) {
            venueToLokallag.set(v.id, v.parent_umbrella_id);
          }

          // Count upcoming events per venue
          if (venues.length > 0) {
            const venuePlaceholders = venues.map(() => "?").join(",");
            const eventRows = db.prepare(`
              SELECT venue_agent_id, COUNT(*) as cnt
              FROM bm_market_events
              WHERE venue_agent_id IN (${venuePlaceholders})
                AND start_at >= ?
              GROUP BY venue_agent_id
            `).all(...venues.map(v => v.id), now) as Array<{ venue_agent_id: string; cnt: number }>;

            for (const e of eventRows) {
              const llokallagId = venueToLokallag.get(e.venue_agent_id);
              if (llokallagId) {
                ourUpcomingByAgentId.set(
                  llokallagId,
                  (ourUpcomingByAgentId.get(llokallagId) ?? 0) + e.cnt
                );
              }
            }
          }

          // Also count events directly linked to the lokallag (lokallag_fallback match type)
          const directRows = db.prepare(`
            SELECT venue_agent_id, COUNT(*) as cnt
            FROM bm_market_events
            WHERE venue_agent_id IN (${placeholders})
              AND start_at >= ?
            GROUP BY venue_agent_id
          `).all(...locallagIds, now) as Array<{ venue_agent_id: string; cnt: number }>;

          for (const e of directRows) {
            ourUpcomingByAgentId.set(
              e.venue_agent_id,
              (ourUpcomingByAgentId.get(e.venue_agent_id) ?? 0) + e.cnt
            );
          }
        }
      } catch (err) {
        console.warn("[bm-reconcile] could not query bm_market_events:", err);
        // non-fatal — deviations will be empty
      }
    }

    // 4. Build slug→entry maps for diffing
    // For our lokallag, try to match by slug (from scrape config) or by
    // normalised name substring (since we may not store slugs yet).
    const canonicalBySlug = new Map<string, BmLokallag>(canonical.map(c => [c.slug, c]));
    const ourBySlug = new Map<string, OurLokallag>();
    const ourByName = new Map<string, OurLokallag>();

    for (const o of ours) {
      if (o.slug) ourBySlug.set(o.slug, o);
      ourByName.set(normaliseForDiff(o.name), o);
    }

    // For ours without explicit slug, try matching by normalised name
    for (const o of ours) {
      if (!o.slug) {
        // Try to find a canonical entry whose name normalises the same way
        for (const c of canonical) {
          if (normaliseForDiff(c.name) === normaliseForDiff(o.name)) {
            ourBySlug.set(c.slug, o);
            break;
          }
        }
      }
    }

    // 5. Diff
    const missing_from_ours: BmLokallag[] = [];
    const name_mismatches: NameMismatch[] = [];
    const count_deltas: CountDelta[] = [];
    const deviations: Deviation[] = [];

    for (const c of canonical) {
      const o = ourBySlug.get(c.slug) ?? ourByName.get(normaliseForDiff(c.name));
      if (!o) {
        missing_from_ours.push(c);
      } else {
        // Name mismatch?
        if (normaliseForDiff(c.name) !== normaliseForDiff(o.name)) {
          name_mismatches.push({
            slug: c.slug,
            canonical_name: c.name,
            our_name: o.name,
          });
        }
        // Count deltas (we record umbrella_member_count but not separate fields yet)
        count_deltas.push({
          slug: c.slug,
          canonical_markeder: c.markeder,
          canonical_produsenter: c.produsenter,
          canonical_markedsplasser: c.markedsplasser,
          our_member_count: o.umbrella_member_count,
        });
        // Deviation: our upcoming market count vs canonical markeder
        const ours_upcoming = ourUpcomingByAgentId.get(o.id) ?? 0;
        const delta = ours_upcoming - c.markeder;
        deviations.push({
          slug: c.slug,
          our_name: o.name,
          canonical_markeder: c.markeder,
          ours_upcoming,
          delta,
        });
      }
    }

    const extra_in_ours: OurLokallag[] = ours.filter(o => {
      const matchedBySlug = o.slug && canonicalBySlug.has(o.slug);
      const matchedByName = canonical.some(
        c => normaliseForDiff(c.name) === normaliseForDiff(o.name)
      );
      return !matchedBySlug && !matchedByName;
    });

    res.json({
      fetched_at: new Date().toISOString(),
      national_umbrella_id: national?.id ?? null,
      canonical,
      ours,
      missing_from_ours,
      extra_in_ours,
      name_mismatches,
      count_deltas,
      deviations,
    });
  } catch (err: any) {
    res.status(500).json({
      success: false,
      error: "bm-reconcile failed",
      detail: err?.message || String(err),
    });
  }
});

export default router;

// ─── Internal helpers ─────────────────────────────────────────────────────────

/** Lowercase + strip punctuation + collapse whitespace for fuzzy name matching */
function normaliseForDiff(s: string): string {
  return s
    .toLowerCase()
    .replace(/[&()\[\].,;:!?]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
