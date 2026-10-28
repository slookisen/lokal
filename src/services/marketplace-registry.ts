import { v4 as uuid } from "uuid";
import crypto from "crypto";
import { getDb } from "../database/init";
import { getConfig } from "../config/vertical-config";
import {
  AgentRegistration,
  RegisteredAgent,
  DiscoveryQuery,
  DiscoveryResult,
} from "../models/marketplace";
import { slugify } from "../utils/slug";
import { isJunkDescription, normalizeProse } from "./description-quality";
import { normalizeCityLabel } from "./city-normalizer";
import { formatRfbDistanceLabel, shouldSuppressDistance } from "./geo-precision";
// dev-request 2026-07-25-reisesok…, Fase 2a: this file used to carry its own
// private, byte-identical copy of the great-circle formula (plus a `toRad`).
// The single implementation now lives in the PURE services/geo-distance.ts —
// pure meaning no DB and no network, so importing it does NOT breach this
// file's deliberate rfb-vertical isolation the way importing
// geocoding-service.ts (→ database/init) would have. Aliased to the old local
// name so every call site below reads exactly as it did.
import { haversineDistanceKm as haversine, toRadians as toRad } from "./geo-distance";
// Fase B3 (mine ordrer): the order-task skill and method list for the card,
// behind ORDER_AGENT_ACTIONS_ENABLED. Pure apart from the env switch.
import { managePickupOrderSkill, rfbJsonRpcMethods, isOrderAgentActionsEnabled } from "./order-a2a-card";
import {
  assertEnrichmentWriteAllowedOrThrow,
  normalizeEnrichmentVertical,
} from "./enrichment-write-pause";
// dev-request 2026-09-05-rfb-mcp-engelsk-sok-kategorifeil: the English→Norwegian
// half of the product glossary. PURE (its only import is `type Lang`), so this
// does not breach this file's rfb-vertical isolation — same rule as
// geo-distance.ts above.
import { norwegianTermsForEnglishQuery, isEnglishFoodWord } from "../i18n/product-glossary";
// dev-request 2026-07-25-reisesok…, Fase 5a/5b: the shared six-value drink
// subcategory taxonomy. PURE (drink-taxonomy.ts has zero imports), same
// isolation rule as geo-distance.ts and product-glossary.ts above.
import { classifyDrinkSubcategoryFromText, type DrinkSubcategory } from "./drink-taxonomy";
// dev-request 2026-10-01-rfb-skjult-testprodusent-for-ordreflyt: the ONE shared
// public-listability predicate (catalog_hidden + RFB vertical). PURE (no
// project imports; only node:async_hooks for the S2d-2 as-public view), same
// isolation rule as geo-distance.ts above.
import { isDebioVerifiedValue, stripOrganicTags } from "./organic-claims";
import { textEntries } from "../utils/text-entries";
import { isDelistedAgentId, publicListableSql, isAgentPubliclyVisible, activeVettedListableSql, isAsPublicView, ownerPauseEnabled, readOwnerPauseRow, notOwnerHiddenSql, ownerVisibilityEnforced, type OwnerVisibilityAudience } from "./agent-visibility";
// S3 of 2026-10-09-rfb-grunnmur-wal-backup-fts-spillbok: FTS5 prefilter for the
// name search. PURE (type-only import), same isolation rule as above.
import {
  NAME_FTS_TABLE,
  isNameFtsUsable,
  nameFtsAllWordsMatch,
  nameFtsAnyWordMatch,
  noteNameFtsQueryFailure,
} from "./name-search-fts";
// Integration test 2026-10-17, slice I-W: the shared Norwegian gazetteer
// (place words), the shared NO/EN stopwords and the offers' product-name
// word rule. Static data and pure functions (the postnummer register is a
// bundled file read once), no DB and no network, so the same isolation rule
// as above holds.
import {
  buildNorwegianGazetteer, detectPlaces, escapeLike, placeKey, PLACE_PREPOSITIONS, QUERY_STOPWORDS, tokenize, type PlaceGazetteer,
} from "./search-intent/norwegian-query";
// Slice I-W4: the search's own filler words, shared with the geocoder. Pure, same rule.
import { FILLER_WORDS, isFillerNoPlaceAt, NO_PRODUCT_WORDS, QUALIFIER_WORDS } from "./search-intent/rfb-filler-words";
import { officialPoststedFylker } from "./norway-postnummer";
import { productNameMatch, type ProductNameMatch } from "../utils/product-name-match";
import { isCategoryLabel } from "../utils/category-label";
import { safeHonestCatalogCount } from "./honest-count";
import { registeredMcpTools } from "./mcp-tool-manifest";
import { agentCardProvider } from "./company-legal";
import { distributionFor } from "../config/distribution-channels";

// ─── Marketplace Registry Service (SQLite-backed) ────────────
// This is the CORE of what makes Lokal unique: the agent registry.
//
// v2: Now persistent with SQLite. Data survives restart.
// Same public API as v1 (in-memory), but backed by real SQL.
//
// Architecture:
//   - All writes are immediate (SQLite WAL mode)
//   - Geo filtering uses bounding-box pre-filter + Haversine
//   - JSON arrays stored as TEXT, parsed on read
//   - Prepared statements for performance

/**
 * Out-parameter for discover(): how the result set was actually produced.
 *
 * REVIEW FOLLOW-UP B1. `discover()` can silently widen a name search beyond the
 * caller's radius (see filterNameCandidatesByGeo), and the caller has no other
 * way to find out — the results look identical to a genuine in-radius hit. The
 * route needs to know so it can report geoFiltered:false + relaxed_filters
 * instead of claiming a geo filter it did not apply. Optional, so every
 * existing caller is unaffected.
 */
export interface DiscoverMeta {
  /** True when a name match was kept despite being outside query.maxDistanceKm. */
  geoRelaxed?: boolean;
  /**
   * True when the tag filter (step 4 of discover()) was dropped because it
   * would otherwise have emptied an already-narrowed candidate set.
   * dev-request 2026-09-06-rfb-sok-adjektiv-tags-er-hardt-filter: tagMap
   * keywords ("fersk", "billig", "sesong" …) are descriptive words a human
   * writes, not structured data most producers carry — as a hard filter they
   * wiped 70-100% of otherwise-correct results with no signal that it happened.
   */
  tagsRelaxed?: boolean;
  /**
   * Set when the query had product terms (step 6b): agent id → every product
   * name that matched a term, in product-list order. The «Produkter: …»
   * match reason names at most three; lokal_search reads the whole list to
   * tell a listed product from a generic category label such as «Honning»
   * (A2A dev-request 2026-10-17-integrasjonstest-oppfolging, AI-3).
   * Slice I-W: also set when the words the parser could not read
   * (_unknownTerms) matched catalog products: the names of those products.
   */
  productMatches?: ReadonlyMap<string, readonly string[]>;
  /**
   * Slice I-W: the words the parser could not read (_unknownTerms) when no
   * product name in the catalog matches them. Nationwide the result is then
   * empty; near a place it is the producers there, which the caller must not
   * present as matches for these words.
   */
  unmatchedTerms?: readonly string[];
}

/**
 * Input options for discover(). a2a spam guard (2026-10-04):
 * `trackDiscovery:false` skips the discovery_count/times_discovered bump for
 * calls whose results nobody is shown as a real buyer (spam/probe traffic,
 * no-intent text, count-only queries). Default true.
 */
export interface DiscoverOptions {
  trackDiscovery?: boolean;
  /**
   * Slice I-AA: false counts no discovery for a page of producers near a
   * place whose products match none of the unknown words (meta.unmatchedTerms):
   * A2A and /sok show no such page. Default true: lokal_search lists it,
   * marked as no matches.
   */
  countUnmatched?: boolean;
  /**
   * S2c-2 (dev-request 2026-10-22-rfb-mine-valg-eierbrytere): "ai" = the
   * caller is an AI-facing surface (MCP, A2A, the REST search/discover API):
   * profiles whose owner switched off «Synlig for AI-assistenter» are left
   * out. Default "all" (the /sok web search). No effect, and no query, unless
   * OWNER_FEATURES_ENFORCE is on (agent-visibility.ts).
   */
  audience?: OwnerVisibilityAudience;
}

class MarketplaceRegistry {
  // ─── In-memory cache ──────────────────────────────────────────
  // Avoids re-querying + JSON.parse() on 1100+ agents per request.
  // Cache invalidated on register/update/deactivate. TTL as fallback.
  // Public so ops agent can clear them via /ops/clear-cache.
  _agentsCache: RegisteredAgent[] | null = null;
  _agentsCacheTime = 0;
  _statsCache: { totalAgents: number; activeProducers: number; cities: string[]; totalListings: number } | null = null;
  _statsCacheTime = 0;
  private static CACHE_TTL = 60_000; // 60 seconds

  private invalidateCache() {
    this._agentsCache = null;
    this._statsCache = null;
    this._slugIdMap = null;
  }

  // ─── Registration ─────────────────────────────────────────

  // dev-request 2026-08-03-mikhailo-quarantine-gates: `origin`/`isVetted`
  // are deliberately NOT part of AgentRegistrationSchema/AdminRegistrationSchema
  // (a self-registering caller must never be able to declare its own
  // provenance — Zod strips any such field out of req.body before it gets
  // here) — they're an out-of-band param this method's callers pass
  // explicitly. Both default so the two existing call sites (POST
  // /admin/register and every src/_seeds/*.ts script) need NO change at
  // all: omitting them writes origin='discovery', is_vetted=1, byte-
  // identical to pre-gate behaviour. Only routes/marketplace.ts's PUBLIC
  // POST /register passes `origin: "self_registered", isVetted: false`.
  register(
    registration: AgentRegistration & {
      origin?: "self_registered" | "discovery";
      isVetted?: boolean;
    },
  ): RegisteredAgent {
    // ── Enrichment write-pause gate (dev-request 2026-08-20-enrichment-write-
    // pause-mekanisk-gjerde; PR review finding 1) ───────────────────────────
    // The gate lives HERE, on the shared primitive, not only on the routes.
    // This one INSERT is the only way any caller creates an `agents` row —
    // the public POST /api/marketplace/register, the admin POST
    // /api/marketplace/admin/register that `lokal-agent-enrichment` actually
    // uses, and every src/_seeds/*.ts script — so gating it means a future
    // caller inherits the fence instead of having to remember to add one.
    // (The first review of this branch found exactly that failure: four gated
    // handlers the routine barely calls, five ungated ones it does.)
    //
    // Vertical: the INSERT below never sets `vertical_id`, so every row this
    // creates takes the column's own `NOT NULL DEFAULT 'rfb'`. The vertical is
    // therefore read from the same place — an explicitly-passed `vertical_id`
    // is honoured (normalised, so an unknown value collapses to 'rfb' rather
    // than escaping a live pause) and its absence resolves to that default.
    // Throws rather than returning, so a caller cannot ignore it; every HTTP
    // caller catches it and re-emits the shared 423 body.
    //
    // `getDb` (the THUNK), not `getDb()`, and the gate runs BEFORE the handle
    // is resolved at all: resolving first put a throwing getDb() outside the
    // guard's try, so it escaped as a bare 500 and the fail_closed:true signal
    // was lost. Last call site in the branch still doing that (round-2 LOW,
    // same shape as PR review finding 3).
    assertEnrichmentWriteAllowedOrThrow(
      getDb,
      normalizeEnrichmentVertical((registration as { vertical_id?: unknown }).vertical_id),
    );

    const db = getDb();
    const id = uuid();
    const apiKey = this.generateApiKey();
    const now = new Date().toISOString();

    const stmt = db.prepare(`
      INSERT INTO agents (
        id, name, description, provider, contact_email, url, version,
        role, api_key, lat, lng, city, radius_km,
        categories, tags, skills, capabilities, languages,
        trust_score, is_active, is_verified,
        discovery_count, interaction_count, total_interactions,
        created_at, last_seen_at, origin, is_vetted
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?,
        0.5, 1, 0,
        0, 0, 0,
        ?, ?, ?, ?
      )
    `);

    stmt.run(
      id,
      registration.name,
      registration.description,
      registration.provider,
      registration.contactEmail,
      registration.url,
      registration.version || "1.0.0",
      registration.role,
      apiKey,
      registration.location?.lat ?? null,
      registration.location?.lng ?? null,
      registration.location?.city ?? null,
      registration.location?.radiusKm ?? null,
      JSON.stringify(registration.categories || []),
      JSON.stringify(registration.tags || []),
      JSON.stringify(registration.skills),
      JSON.stringify(registration.capabilities || {}),
      JSON.stringify(registration.languages || ["no"]),
      now,
      now,
      registration.origin || "discovery",
      registration.isVetted === false ? 0 : 1,
    );

    this.invalidateCache();
    return this.rowToAgent(db.prepare("SELECT * FROM agents WHERE id = ?").get(id) as any)!;
  }

  // ─── Discovery (the money endpoint) ───────────────────────
  // Consumer agents call this to find producers.
  // Uses bounding-box pre-filter for geo (Gap 6 fix).

  discover(query: DiscoveryQuery, meta?: DiscoverMeta, opts: DiscoverOptions = {}): DiscoveryResult[] {
    const db = getDb();
    const trackDiscovery = opts.trackDiscovery !== false;
    // S2c-2: one id list per call ("" unless enforced and someone is hidden).
    const ownerAiSql = opts.audience === "ai" ? notOwnerHiddenSql("ai_assistants") : "";

    // ── 0. Name-based search: if query contains a producer name, find it directly ──
    // This handles "Bjørndal Gård Oppdal", "hva tilbyr Bjørndal Gård?" etc.
    // NOTE: SQLite's LOWER() only works for ASCII, so we do case-insensitive
    // matching in JavaScript instead of SQL to handle Norwegian characters (ø,å,æ).
    const nameQuery = (query as any)._nameQuery as string | undefined;
    if (nameQuery && nameQuery.length >= 3) {
      // Fetch the active agents and filter by name in JS (case-insensitive for Unicode)
      // Phase 5.11 A4.1: exclude umbrella agents from producer-discovery surfaces
      // dev-request 2026-08-03-mikhailo-quarantine-gates (Gate 1): a
      // self-registered, not-yet-vetted row (is_vetted = 0) must not surface
      // on any public discovery surface, including this name-match path.
      // dev-request 2026-10-01-rfb-skjult-testprodusent-for-ordreflyt: nor may
      // a catalog_hidden fixture or a non-RFB-vertical row (agent-visibility.ts).
      const publicNameSql = `is_active = 1 AND umbrella_type IS NULL AND is_vetted = 1 AND ${publicListableSql()}${ownerAiSql}`;
      // S3 of 2026-10-09-rfb-grunnmur-wal-backup-fts-spillbok: the full scan used
      // to have no ORDER BY; its plan (SCAN … USING INDEX idx_agents_geo) returned
      // rows in (lat, lng, rowid) order, and the stable sorts below keep that order
      // for ties. It is written out so the FTS path returns the same order (the
      // plan is unchanged: the index still supplies it, no extra sort).
      const nameOrderSql = "ORDER BY lat, lng, rowid";
      let scanRows: any[] | null = null;
      const fullScan = (): any[] =>
        (scanRows ??= db.prepare(`SELECT * FROM agents WHERE ${publicNameSql} ${nameOrderSql}`).all() as any[]);
      // Only rows whose name the FTS index (services/name-search-fts.ts) says
      // can match — a superset of what the JS filters below keep. Null → full scan.
      const ftsRows = (match: string | null): any[] | null => {
        if (!match || !isNameFtsUsable(db)) return null;
        try {
          return db.prepare(
            `SELECT * FROM agents WHERE id IN (SELECT agent_id FROM ${NAME_FTS_TABLE} WHERE ${NAME_FTS_TABLE} MATCH ?) ` +
            `AND ${publicNameSql} ${nameOrderSql}`,
          ).all(match) as any[];
        } catch (err) {
          noteNameFtsQueryFailure(err);
          return null;
        }
      };
      const nameWords = nameQuery.toLowerCase().split(/\s+/).filter(w => w.length >= 2);

      const strictFts = ftsRows(nameFtsAllWordsMatch(nameWords));
      const allRows = strictFts ?? fullScan();
      console.log(`[name-search] query="${nameQuery}", words=${JSON.stringify(nameWords)}, ${strictFts ? "ftsCandidates" : "totalAgents"}=${allRows.length}`);

      const nameRows = allRows.filter(row => {
        const agentName = (row.name || "").toLowerCase();
        // All name words must appear somewhere in the agent name
        return nameWords.every(word => agentName.includes(word));
      });

      console.log(`[name-search] matched=${nameRows.length}${nameRows.length > 0 ? ` → ${nameRows.map((r: any) => r.name).join(", ")}` : ""}`);

      if (nameRows.length > 0) {
        // Found by name — return these as top results, skip geo filtering
        let nameCandidates = nameRows.filter(r => !isDelistedAgentId(r.id)).map(r => this.rowToAgent(r)!);
        if (query.role) {
          nameCandidates = nameCandidates.filter(a => a.role === query.role);
        }
        if (nameCandidates.length > 0) {
          // dev-request 2026-07-25 fix 0d: geo-aware, distance-ranked.
          const geoFiltered = this.filterNameCandidatesByGeo(nameCandidates, query, meta);
          return this.buildNameMatchResults(
            geoFiltered, query, 0.9, `Navnematch: "${nameQuery}"`,
            undefined, !!meta?.geoRelaxed, trackDiscovery,
          );
        }
      }

      // ── RELAXED FALLBACK ──────────────────────────────────────
      // Strict ALL-words match found nothing. Try ANY-word match —
      // but only on words that look like a producer name (not generic
      // food/category terms like "sjømat", "kjøtt", "bakeri"). This
      // catches the case where the user typed "Dyrøy Sjømat" but the
      // actual producer is "Dyrøymat" (single word, no space). The
      // distinctive token "dyrøy" matches; "sjømat" is filtered out
      // because it would otherwise pull in every fish producer
      // (GENERIC_NAME_TOKENS, at module scope since slice I-W3).
      // dev-request 2026-09-05-rfb-mcp-engelsk-sok-kategorifeil: a place name
      // is never a distinctive producer-name token. "vestfold" matched eight
      // unrelated producers by name and buried the real honey producers.
      // Slice I-W: a word the gazetteer knows as a place (isPlaceWord) is
      // tried only when the other words find no producer, so «Dyrøy» still
      // finds «Dyrøymat», while «Bærum» in «Grini Bærum» no longer ties every
      // producer named after Bærum with the one the user named.
      const nameTokens = nameWords.filter(w =>
        !GENERIC_NAME_TOKENS.has(w) && !NAME_PASS_PLACE_WORDS.has(w) && w.length >= 3);
      const isPlace = placeWordTest(nameQuery);
      const nonPlaceTokens = nameTokens.filter(w => !isPlace(w));
      const tiers = nonPlaceTokens.length > 0 && nonPlaceTokens.length < nameTokens.length ? [nonPlaceTokens, nameTokens] : [nameTokens];
      for (const distinctiveWords of tiers) if (distinctiveWords.length > 0) {
        // Same pool as before: every public row (a full scan already loaded is
        // reused), or the FTS rows whose name has at least one distinctive word.
        const fuzzyPool = scanRows ?? ftsRows(nameFtsAnyWordMatch(distinctiveWords)) ?? fullScan();
        const fuzzyRows = fuzzyPool
          .map(row => {
            const agentName = (row.name || "").toLowerCase();
            const matchedCount = distinctiveWords.filter(w => agentName.includes(w)).length;
            return { row, matchedCount };
          })
          .filter(x => x.matchedCount > 0);

        if (fuzzyRows.length > 0) {
          // Sort by # distinctive words matched, then trust
          fuzzyRows.sort((a, b) => {
            if (b.matchedCount !== a.matchedCount) return b.matchedCount - a.matchedCount;
            return (b.row.trust_score || 0) - (a.row.trust_score || 0);
          });

          // dev-request 2026-07-25 fix 0d: the top-10 cut used to happen HERE,
          // before any geo filtering — so a query like "gårdsutsalg i Agder"
          // kept the ten highest-trust «gårdsutsalg» producers nationwide and
          // the one real Agder producer only survived by luck (it ranked 6th).
          // The geo filter now runs FIRST (on the full matchedCount/trust-
          // ordered list), and the top-10 cut applies to what survives it.
          // With no location in the query, this is the original code path.
          let fuzzyCandidates = fuzzyRows.filter(x => !isDelistedAgentId(x.row.id)).map(x => this.rowToAgent(x.row)!);
          if (query.role) fuzzyCandidates = fuzzyCandidates.filter(a => a.role === query.role);
          fuzzyCandidates = this.filterNameCandidatesByGeo(fuzzyCandidates, query, meta).slice(0, 10);
          if (fuzzyCandidates.length > 0) {
            const results = this.buildNameMatchResults(
              fuzzyCandidates, query, 0.75, `Mulig navnematch: "${nameQuery}"`, 10,
              !!meta?.geoRelaxed, trackDiscovery,
            );
            console.log(`[name-search-fuzzy] matched=${results.length} → ${results.map(r => r.agent.name).join(", ")}`);
            if (results.length > 0) return results;
          }
        }
      }
    }

    // Build SQL dynamically based on query filters
    // Phase 5.11 A4.1: exclude umbrella agents from producer-discovery surfaces
    // dev-request 2026-08-03-mikhailo-quarantine-gates (Gate 1): exclude
    // self-registered, not-yet-vetted rows from this public discovery path.
    // dev-request 2026-10-01-rfb-skjult-testprodusent-for-ordreflyt: plus the
    // shared public-listability predicate (catalog_hidden + RFB vertical).
    let sql = `SELECT * FROM agents WHERE is_active = 1 AND umbrella_type IS NULL AND is_vetted = 1 AND ${publicListableSql()}${ownerAiSql}`;
    const params: any[] = [];

    // 1. Filter by role
    if (query.role) {
      sql += " AND role = ?";
      params.push(query.role);
    }

    // 2. Geo bounding-box pre-filter (much faster than full Haversine on all rows)
    if (query.location && query.maxDistanceKm) {
      const latDelta = query.maxDistanceKm / 111.0; // ~111km per degree lat
      const lngDelta = query.maxDistanceKm / (111.0 * Math.cos(toRad(query.location.lat)));
      sql += " AND lat BETWEEN ? AND ? AND lng BETWEEN ? AND ?";
      params.push(
        query.location.lat - latDelta,
        query.location.lat + latDelta,
        query.location.lng - lngDelta,
        query.location.lng + lngDelta,
      );
    }

    const rows = db.prepare(sql).all(...params) as any[];
    let candidates = rows.filter(r => !isDelistedAgentId(r.id)).map(r => this.rowToAgent(r)!);

    // 3. Filter by categories (in-app â€" JSON array matching)
    // Slice I-W: through categoryValueMatches, so «bakery» and the old «bread» find each other.
    if (query.categories && query.categories.length > 0) {
      candidates = candidates.filter(a =>
        query.categories!.some(cat =>
          a.categories.some(ac => categoryValueMatches(ac, cat))
        )
      );
    }

    // 3b. Fase 5b: narrow further to ONE of the six canonical drink
    // subcategories. There is no per-subcategory column on `agents` — the
    // signal is the same name+description text match the search-field
    // parser uses (drink-taxonomy.ts), so this reads honestly as "producers
    // whose own text says bryggeri/vingård/…", not a curated DB field.
    //
    // Deliberately NOT guarded by isDrinkSubcategory(): an unrecognised
    // value (typo, or a caller testing the filter) must match ZERO
    // candidates, the same way an unrecognised `categories` entry already
    // does at step 3 above — never silently ignored, which would make a
    // narrowing filter accidentally widen the result set instead.
    if (query.drinkSubcategory) {
      const wanted = query.drinkSubcategory;
      candidates = candidates.filter(a =>
        classifyDrinkSubcategoryFromText(`${a.name} ${a.description || ""}`) === wanted
      );
    }

    // 3c. Integration test 2026-10-17, slice I-W: the words parseNaturalQuery
    // could not read (_unknownTerms: no category, no place, no producer name).
    // «kransekake» used to leave the query without any filter, so this
    // returned the standard list, exactly as for «zzzqqx», while Grini
    // Hjemmebakeri lists «Kransekake 18 ringer boks». The words are now looked
    // up in the producers' product names, in the same catalog and by the same
    // word rule as the offers (catalogTermMatches). Before the tag step, so a
    // tag («økologisk kransekake») is weighed against the producers that have
    // the product. When no product matches, the standard list is not passed
    // off as a hit: nationwide there is nothing to show, and near a place the
    // list stays for the caller to present as the producers there, not as
    // matches (meta.unmatchedTerms).
    // Slice I-W2 (S4): next to a category («Which bakeries make kransekake»)
    // the words name no producer of their own. The category's producers stay,
    // and the ones whose products match the words rank first (step 7).
    const unknownTerms = ((query as any)._unknownTerms as string[] | undefined) ?? [];
    let termMatches: Map<string, CatalogTermMatch> | null = null;
    let unmatched = false;
    if (unknownTerms.length > 0 && !((query as any)._productTerms as string[] | undefined)?.length) {
      termMatches = catalogTermMatches(db, unknownTerms, new Set(candidates.map(c => c.id)));
      if (termMatches && !query.categories?.length) {
        if (termMatches.size > 0) {
          candidates = candidates.filter(a => termMatches!.has(a.id));
        } else {
          unmatched = true;
          if (meta) meta.unmatchedTerms = unknownTerms;
          if (!query.location) return [];
        }
      }
    }

    // 4. Filter by tags — SOFT: dropped (not applied) when it would otherwise
    // empty an already-narrowed candidate set.
    //
    // dev-request 2026-09-06-rfb-sok-adjektiv-tags-er-hardt-filter: unlike
    // `categories` (step 3, real coverage — every producer has categories),
    // tagMap's five families ("fersk"/"billig"/"sesong"/"lokal"/"økologisk" …)
    // are descriptive words a human writes, not structured data most
    // producers carry. Measured live 2026-09-06: `fersk laks Lofoten` → 0 of
    // 3 otherwise-correct hits; `billig ost Oslo` → 0 of 10. Keeping the
    // filter's ranking value when it still leaves candidates (organic/debio
    // in particular has real, structured coverage — Debio certification — so
    // it keeps its selective effect whenever it doesn't wipe the set), and
    // dropping it — never silently — only when it would return nothing.
    // Every downstream filter (skills/distance/product terms) still applies
    // to the un-tag-filtered set; only this one step is skipped.
    //
    // Guarded on `candidates.length > 0` BEFORE this step: without it, a query
    // like "billig kjøtt" where `categories` (step 3) already zeroed the set
    // (no meat producer at all) would filter an already-empty array and still
    // set `tagsRelaxed:true` — falsely blaming the tag filter, and falsely
    // telling the caller "tags were dropped" for a result that stayed empty
    // regardless. Only report a drop when tags are what caused the zero.
    if (query.tags && query.tags.length > 0 && candidates.length > 0) {
      const tagFiltered = candidates.filter(a =>
        query.tags!.some(tag =>
          a.tags.some(at => at.toLowerCase().includes(tag.toLowerCase()))
        )
      );
      if (tagFiltered.length > 0) {
        candidates = tagFiltered;
      } else if (meta) {
        meta.tagsRelaxed = true;
      }
    }

    // 5. Filter by skills
    if (query.skills && query.skills.length > 0) {
      candidates = candidates.filter(a =>
        query.skills!.some(skillId =>
          a.skills.some(s => s.id === skillId || s.tags.some(t => t.toLowerCase().includes(skillId.toLowerCase())))
        )
      );
    }

    // 6. Precise distance filter (Haversine on the bounding-box survivors)
    if (query.location && query.maxDistanceKm) {
      candidates = candidates.filter(a => {
        if (!a.location) return false;
        const dist = haversine(query.location!.lat, query.location!.lng, a.location.lat, a.location.lng);
        return dist <= query.maxDistanceKm!;
      });
    }

    // 6b. Product-level filtering — if user searched for specific products (e.g. "tomat"),
    // load each candidate's products from knowledge and check for matches.
    // This prevents a meat shop from appearing when someone searches for tomatoes.
    const productTerms = (query as any)._productTerms as string[] | undefined;
    let productMatchMap: Map<string, string[]> = new Map(); // agentId → matched product names

    if (productTerms && productTerms.length > 0) {
      const candidateIds = candidates.map(c => c.id);
      if (candidateIds.length > 0) {
        // Bulk-load products for all candidates in one query
        const placeholders = candidateIds.map(() => "?").join(",");
        const rows = db.prepare(
          `SELECT agent_id, products FROM agent_knowledge WHERE agent_id IN (${placeholders})`
        ).all(...candidateIds) as { agent_id: string; products: string }[];

        for (const row of rows) {
          try {
            const products = typeof row.products === "string" ? JSON.parse(row.products) : row.products;
            if (!Array.isArray(products)) continue;

            const matchedNames: string[] = [];
            for (const p of products) {
              // Integration test 2026-10-17 (I-F): an entry's name is DB JSON. A
              // name that is not text (a number) threw here, and the catch below
              // then dropped every product match of the producer.
              const name: string = typeof p === "string" ? p : typeof p?.name === "string" ? p.name : "";
              const pName = name.toLowerCase();
              for (const term of productTerms) {
                if (pName.includes(term) || new RegExp(`\\b${term}\\b`).test(pName)) {
                  matchedNames.push(name);
                  break;
                }
              }
            }
            if (matchedNames.length > 0) {
              productMatchMap.set(row.agent_id, matchedNames);
            }
          } catch { /* skip malformed JSON */ }
        }

        // Filter: keep agents with matching products, OR agents that haven't been enriched,
        // OR agents whose category matches the query (even if products aren't populated yet).
        // This prevents over-filtering agents with incomplete product data.
        candidates = candidates.filter(a => {
          if (productMatchMap.has(a.id)) return true;
          // No knowledge at all → benefit of doubt
          const hasKnowledge = rows.some(r => r.agent_id === a.id);
          if (!hasKnowledge) return true;
          // Has knowledge but no matching products — still keep if their category matches
          // (a dairy farmer without enriched products should still show up for "ost")
          if (query.categories?.length) {
            const catMatch = query.categories.some(cat =>
              a.categories.some(ac => sameCategoryKey(ac, cat))
            );
            if (catMatch) return true;
          }
          return false;
        });
      }
      if (meta) meta.productMatches = productMatchMap;
    }

    // Slice I-W: the producers 3c kept, with the product names that matched,
    // are scored and labelled like a product-term match.
    let scoreTerms = productTerms;
    if (termMatches && termMatches.size > 0) {
      scoreTerms = unknownTerms;
      productMatchMap = new Map([...termMatches].map(([id, m]) => [id, m.names]));
      if (meta) meta.productMatches = productMatchMap;
    }

    // 7. Score and rank
    const results: DiscoveryResult[] = candidates.map(agent => {
      const { score, reasons } = this.calculateRelevance(agent, query, scoreTerms, productMatchMap);

      return {
        agent: {
          id: agent.id,
          name: agent.name,
          description: agent.description,
          url: agent.url,
          role: agent.role,
          skills: agent.skills.map(s => ({
            id: s.id,
            name: s.name,
            description: s.description,
            tags: s.tags,
          })),
          location: this.resultLocation(agent, query.location),
          trustScore: agent.trustScore,
          isVerified: agent.isVerified,
          categories: agent.categories,
          tags: agent.tags,
        },
        relevanceScore: score,
        matchReasons: reasons,
      };
    });

    // Sort by relevance (NOT popularity, NOT ad spend)
    results.sort((a, b) => b.relevanceScore - a.relevanceScore);

    // ChatGPT app re-review 2026-10-03: a product search ("lamb Innlandet")
    // also keeps producers that only carry the broad category (`meat`) with
    // nothing about lamb in their product list. Those are possible matches,
    // not documented ones, so every producer whose product list does name
    // the product now ranks above them; relevance still orders each group.
    if (productTerms && productTerms.length > 0) {
      const documented = (r: DiscoveryResult) => (productMatchMap.has(r.agent.id) ? 1 : 0);
      results.sort((a, b) => documented(b) - documented(a));
    }

    // Slice I-W: for the words of 3c, a producer with a matching product
    // comes before one with only a matching category label (as the offers
    // keep labels out of `offers`), then the one whose products name more of
    // the words, then the better match (a whole word before the head of a
    // compound before the start of a word, as in the offers); relevance
    // orders the rest. Slice I-W2: next to a category word a producer without
    // a match stays, after every producer with one (it matches no word).
    if (termMatches && termMatches.size > 0) {
      const m = (r: DiscoveryResult) => termMatches!.get(r.agent.id) ?? NO_TERM_MATCH;
      results.sort((a, b) => Number(m(b).listed) - Number(m(a).listed) || m(b).terms - m(a).terms || m(b).best - m(a).best);
    }

    const page = results.slice(query.offset || 0, (query.offset || 0) + (query.limit || 20));
    // Count a discovery only for what is actually returned (a2a spam guard:
    // this used to bump every CANDIDATE — ~5k row writes per unfiltered call).
    // Slice I-AA: and not for a page of no matches the caller does not show.
    if (trackDiscovery && !(unmatched && opts.countUnmatched === false)) this.incrementDiscovery(page.map(r => r.agent.id));
    return page;
  }

  // ─── Result location + the distance honesty rule ──────────
  // dev-request 2026-07-25-reisesok-korridor-discovery-og-naerhetssok, Fase 1c.
  //
  // ONE place decides what a search result is allowed to say about distance,
  // so the HTML cards, the JSON API and the MCP tools cannot drift apart.
  // The rule (services/geo-precision.ts, mirroring experience-store.ts's
  // formatDistanceLabel() on the OpplevAgent side):
  //   • geo_precision='address'      → real measurement, emit distanceKm.
  //   • 'city' / 'kommune' / 'postal'→ the position IS a centroid; emitting
  //                                    "2,4 km unna" would be a fabricated
  //                                    number. distanceKm is withheld and
  //                                    distanceLabel says "i <city>-området".
  //   • NULL (unknown provenance, every pre-Fase-1 row) → unchanged
  //                                    behaviour, we have no evidence either
  //                                    way and must not silently blank 948
  //                                    producers' distances on deploy.
  // Ranking is untouched: callers keep sorting/filtering on the true
  // haversine (a centroid is still our best position estimate) — this governs
  // what we SAY, not what we compute.
  private resultLocation(
    agent: RegisteredAgent,
    origin?: { lat: number; lng: number },
  ): DiscoveryResult["agent"]["location"] {
    if (!agent.location) return undefined;
    const precision = agent.geoPrecision ?? null;
    const raw = origin
      ? haversine(origin.lat, origin.lng, agent.location.lat, agent.location.lng)
      : undefined;
    const label = origin
      ? formatRfbDistanceLabel(raw, precision, agent.location.city)
      : null;
    return {
      city: agent.location.city,
      distanceKm: shouldSuppressDistance(precision) ? undefined : raw,
      ...(precision ? { geoPrecision: precision } : {}),
      ...(label ? { distanceLabel: label } : {}),
    };
  }

  // ─── Name-match result builder (geo-aware) ────────────────
  // dev-request 2026-07-25-reisesok-korridor-discovery-og-naerhetssok, fix 0d.
  //
  // The two name-search branches above used to return a flat score (0.900
  // strict / 0.750 fuzzy) for every hit and skip geo filtering entirely, even
  // when the query carried a location. Live proof 2026-07-25:
  //   `gårdsutsalg i Agder` → Sørum (277 km), Stange (318 km), Stavanger
  //   (120 km) all at relevanceScore 0.750, with the single real Agder
  //   producer ranked 6th.
  //
  // Now, when BOTH a name query and a location are present:
  //   • producers with coordinates OUTSIDE maxDistanceKm are dropped …
  //   • … but only if something is left. A name search with no hit anywhere
  //     near the user must still find the producer they typed (the "Erga
  //     Gårdsutsalg" case: a user in Oslo searching a Kleppe producer by name
  //     still wants Kleppe, not silence).
  //   • producers with NO coordinates are always kept — 36.8 % of active RFB
  //     producers have no lat/lng, and "unknown" is not "far away". They rank
  //     below everything that is provably in range.
  //   • the score is graded by distance, so the ranking is no longer a
  //     20-way tie broken by insertion order.
  // With no location in the query, behaviour is byte-identical to before.
  private filterNameCandidatesByGeo(
    candidates: RegisteredAgent[],
    query: DiscoveryQuery,
    meta?: DiscoverMeta,
  ): RegisteredAgent[] {
    const origin = query.location;
    const maxKm = query.maxDistanceKm;
    if (!origin || !maxKm) return candidates;

    const inRange: RegisteredAgent[] = [];
    const unknown: RegisteredAgent[] = [];
    for (const a of candidates) {
      if (!a.location) { unknown.push(a); continue; }
      if (haversine(origin.lat, origin.lng, a.location.lat, a.location.lng) <= maxKm) inRange.push(a);
    }
    // Nothing in range and nothing unplaced → the producer the user named is
    // genuinely far away; return them all rather than pretending they vanished.
    //
    // REVIEW FOLLOW-UP B1: the carve-out is right, but keeping it SILENT
    // re-introduced exactly the lie 0b fixed. The route only ever set
    // `geoDropped` inside the auto-expand ladder, and the ladder never runs for
    // a name match (`wasNameMatch` short-circuits it), so
    // `?q=gårdsutsalg&lat=59.9139&lng=10.7522&radius=10` answered
    // geoFiltered:true, geoRadiusKm:10 while listing producers 28 / 92 / 289 km
    // away. Report the relaxation up to the caller so it can say so, exactly
    // like the auto-expand path does. Reachable from any query whose word ends
    // in gård/mat/bakeri/marked/butikk/ysteri/meieri — e.g. «gårdsbutikk nær meg»
    // with browser coordinates in a sparse area.
    if (inRange.length + unknown.length === 0) {
      if (meta) meta.geoRelaxed = true;
      return candidates;
    }
    return [...inRange, ...unknown];
  }

  private buildNameMatchResults(
    candidates: RegisteredAgent[],
    query: DiscoveryQuery,
    baseScore: number,
    reason: string,
    maxResults?: number,
    geoRelaxed = false,
    trackDiscovery = true,
  ): DiscoveryResult[] {
    const origin = query.location;
    const maxKm = query.maxDistanceKm;

    const distanceOf = (a: RegisteredAgent): number | undefined =>
      origin && a.location
        ? haversine(origin.lat, origin.lng, a.location.lat, a.location.lng)
        : undefined;

    // REVIEW FOLLOW-UP B1 (second half): grade against a scale the candidates
    // actually span. When geo was relaxed, EVERY candidate is beyond maxKm, so
    // `min(SPREAD, d / maxKm * SPREAD)` saturated at SPREAD for all of them and
    // the flat-score tie 0d was supposed to kill came straight back (measured:
    // 0.700 / 0.700 / 0.700 for producers 28 / 92 / 289 km away). Scale by the
    // farthest candidate instead, so the nearest still ranks highest.
    const spanKm = candidates
      .map(distanceOf)
      .filter((d): d is number => typeof d === "number");
    const gradeScaleKm = geoRelaxed && spanKm.length > 0 ? Math.max(...spanKm) : maxKm;

    // Fase 1c: the emitted distanceKm is now withheld for centroid-precision
    // producers (see resultLocation()), so the tie-break below can no longer
    // read it off the result — it would rank an honest "position unknown to
    // street level" row as Infinity/last. Keep the TRUE distance here, purely
    // for ordering.
    const rankDistance = new Map<string, number>();

    const results: DiscoveryResult[] = candidates.map(agent => {
      const { score, reasons } = this.calculateRelevance(agent, query, [], new Map());
      const distanceKm = distanceOf(agent);
      if (typeof distanceKm === "number") rankDistance.set(agent.id, distanceKm);

      // Distance grading: 0 penalty at the origin, PROXIMITY_SPREAD at the far
      // edge of the scale, the full penalty for an unplaced producer. Keeps
      // every name hit above a non-name hit while making the order meaningful.
      const PROXIMITY_SPREAD = 0.2;
      let penalty = 0;
      if (origin && gradeScaleKm) {
        penalty = distanceKm === undefined
          ? PROXIMITY_SPREAD
          : Math.min(PROXIMITY_SPREAD, (distanceKm / gradeScaleKm) * PROXIMITY_SPREAD);
      }

      return {
        agent: {
          id: agent.id, name: agent.name, description: agent.description,
          url: agent.url, role: agent.role,
          skills: agent.skills.map(s => ({ id: s.id, name: s.name, description: s.description, tags: s.tags })),
          location: this.resultLocation(agent, origin),
          trustScore: agent.trustScore, isVerified: agent.isVerified,
          categories: agent.categories, tags: agent.tags,
        },
        relevanceScore: Math.max(score, baseScore) - penalty,
        matchReasons: [reason, ...reasons],
      };
    });

    results.sort((a, b) => {
      if (b.relevanceScore !== a.relevanceScore) return b.relevanceScore - a.relevanceScore;
      const da = rankDistance.get(a.agent.id) ?? Infinity;
      const db = rankDistance.get(b.agent.id) ?? Infinity;
      return da - db;
    });

    const page = results.slice(0, Math.min(maxResults ?? Infinity, query.limit || 20));
    if (trackDiscovery) this.incrementDiscovery(page.map(r => r.agent.id));
    return page;
  }

  // ─── Natural language query parsing ───────────────────────

  parseNaturalQuery(query: string): Partial<DiscoveryQuery> & {
    _productTerms?: string[];
    _proximityIntent?: boolean;
    /** Fase 5b: one of drink-taxonomy.ts's six values, present only alongside categories:["beverages"]. */
    drinkSubcategory?: DrinkSubcategory;
    /** Slice I-W: the words nothing else in the query explains (unknownProductWords), for discover() step 3c. */
    _unknownTerms?: string[];
  } {
    const q = query.toLowerCase().replace(/[?!.,]/g, "");

    // ── English queries (dev-request 2026-09-05-rfb-mcp-engelsk-sok-kategorifeil) ──
    // The category keywords below are Norwegian. An English query therefore
    // detected NO category — and since discover() applies `categories` as a
    // HARD filter (step 3), no category means no filter at all, and the search
    // silently degrades to "the N nearest producers, whatever they sell".
    // Measured live 2026-09-05 against prod: `ost Bergen` → Ostegården,
    // Colonialen, Møllendal (three real cheese sellers); `producers near
    // Bergen that sell cheese` → ten producers, none of which sells cheese.
    // 13 of 20 sampled English queries parsed differently from their Norwegian
    // equivalent. This is what OpenAI's reviewers ran, and it is why the
    // ChatGPT app submission was rejected on 2026-09-05.
    //
    // Fix: append the Norwegian equivalents of any English food words to the
    // text the keyword matcher reads. `q` itself is untouched, so the name
    // branch, the skip-word logic and _proximityIntent all keep seeing exactly
    // what the user typed — only category/tag detection gets the extra words.
    const englishTerms = norwegianTermsForEnglishQuery(query);
    const qTerms = englishTerms.length ? `${q} ${englishTerms.join(" ")}` : q;
    const parsed: Partial<DiscoveryQuery> & {
      _productTerms?: string[];
      _proximityIntent?: boolean;
      drinkSubcategory?: DrinkSubcategory;
      _unknownTerms?: string[];
    } = {};

    // ── Proximity intent (dev-request 2026-07-25 fix 0e) ──────────────
    // «nær», «nærme», «nærmeste», «meg», «her» and «hvor» are all in the
    // skipWords set below, so `q=nær meg` used to parse to literally nothing
    // and return a nationwide trust-ranked list with geoFiltered:false — no
    // signal at all that the user had asked for something we could not
    // answer. Recognise the intent BEFORE the words are discarded; the route
    // turns it into needs_location / a geolocation prompt.
    //
    // Deliberately narrow: it must match "near ME", not the preposition in
    // «honning nær Oslo» (which already geocodes fine and must not be
    // hijacked into a position request).
    if (isProximityIntent(q)) parsed._proximityIntent = true;

    // ── Product→Category mapping (expanded with Norwegian food terms) ──
    // Each keyword maps to a category AND is stored as a product search term
    // so we can match at product-level, not just category-level. The map is
    // PRODUCT_CATEGORY_KEYWORDS, after the class (I-V: the offers read it too).
    const categoryMap = PRODUCT_CATEGORY_KEYWORDS;

    const detectedCategories: string[] = [];
    const productTerms: string[] = [];
    // «and» is Norwegian for duck, and English for "and". Before this guard
    // EVERY English query containing the conjunction was classified as `meat`
    // — and because categories are a hard filter, "butter and cream" returned
    // meat producers and no dairy at all (verified 2026-09-05). Norwegian
    // «and» (duck) still matches: the guard only fires once the query has
    // already been shown to contain English food vocabulary. NB: this does
    // NOT mean an English "duck farm" reaches `meat` — it does not. The
    // Norwegian key «and» is excluded from norwegianTermsForEnglishQuery's
    // reverse index by AMBIGUOUS_EN (product-glossary.ts), specifically so
    // it never fires this guard on itself, so no duck→and reverse mapping
    // is ever built. English "duck" queries not selecting `meat` remains a
    // known, separate gap this fix does not close.
    // ChatGPT app re-review 2026-10-03: a whole English question with no food
    // word in it ("what do they make and how can I contact them?") still
    // turned «and» into `meat`. Two or more English filler words now mark the
    // query as English too.
    const englishFillerCount = q.split(/[^a-zæøå]+/).filter((w) => w !== "and" && ENGLISH_SKIP_WORDS.includes(w)).length;
    const suppressEnglishConjunction = englishTerms.length > 0 || englishFillerCount >= 2;
    for (const [category, keywords] of Object.entries(categoryMap)) {
      for (const kw of keywords) {
        if (kw === "and" && suppressEnglishConjunction) continue;
        // Word-boundary matching, to avoid partial matches ("ost" in "geitost").
        // NB norwegianWordBoundary(), not \b — see the comment on that helper.
        // With \b, the headline keyword of this whole slice — «øl» — could
        // never match ANYTHING, because \b is ASCII-only and sees no boundary
        // between start-of-string and «ø».
        if (norwegianWordBoundary(kw).test(qTerms)) {
          if (!detectedCategories.includes(category)) detectedCategories.push(category);
          // Store the specific product term (not the category keyword like "vegetables")
          // REVIEW N2: NO drink keyword becomes a product term. The
          // product matcher one level up (discover(), ~:307) tests
          // `pName.includes(term)`, an unanchored substring test — so `øl`
          // matched «Pølser», «Grillpølser av storfe», «Kjøttpølse»,
          // «Spekepølse» and «Møllerens mel»; `vin` matched «Vinterepler» and
          // «Rødvinseddik»; `saft` matched «Saftig kanelbolle». A product
          // match scores +0.25, the same as a category match, so on the
          // flagship query of this whole slice a sausage producer could
          // outrank a low-trust brewery, carrying the match reason
          // «Produkter: Grillpølser av storfe».
          //
          // Dropping the drink terms from productTerms removes the harm
          // completely: with no product terms the matcher block is skipped
          // outright (`if (productTerms && productTerms.length > 0)`), and the
          // `beverages` CATEGORY filter — which is what Fase 5 is actually
          // about — does the selecting.
          //
          // Deliberately NOT changing `includes()` to norwegianWordBoundary()
          // here, even though that is the root cause and it makes the adjacent
          // regex dead code. Norwegian compounds legitimately depend on the
          // loose test: «bringebærsaft» matches `bringebær`, «geitostkake»
          // matches `geitost`. Tightening it is a search-relevance change
          // across all 134 non-drink keywords, unrelated to this dev-request,
          // and it belongs in its own slice with its own before/after
          // measurement. Recorded here so it is not lost.
          if (!PRODUCT_TERM_EXCLUSIONS.has(kw)) {
            productTerms.push(kw);
          }
        }
      }
    }
    if (detectedCategories.length > 0) parsed.categories = detectedCategories;
    // A meat compound also matches the animal's other product names:
    // «reinkjøtt» must find a producer whose list says «Reinsdyrkjøtt»,
    // «lammekjøtt» one that sells «Lammelår» (product matching is a
    // substring test). ChatGPT app pre-submission review 2026-10-09:
    // «reinkjøtt Finnmark» labelled Finnmark Kjøtt AS a category-only match.
    const MEAT_COMPOUND_STEMS: Record<string, string> = {
      reinkjøtt: "rein", reinsdyrkjøtt: "rein", lammekjøtt: "lam",
      elgkjøtt: "elg", hjortekjøtt: "hjort", viltkjøtt: "vilt",
    };
    for (const term of [...productTerms]) {
      const stem = MEAT_COMPOUND_STEMS[term];
      if (stem && !productTerms.includes(stem)) productTerms.push(stem);
    }
    if (productTerms.length > 0) parsed._productTerms = productTerms;

    // Fase 5b: WHICH of the six canonical drink subcategories, when the
    // query landed on `beverages` at all. Runs over the same `qTerms` the
    // category matcher just read (English-food-word-expanded query text),
    // so an English query gets the same subcategory precision a Norwegian
    // one does. Absent (not null) when no specific subcategory keyword
    // matched — "drikkesteder"/"beverages" alone means "some drink venue",
    // not any one of the six, and this must not guess.
    if (detectedCategories.includes("beverages")) {
      const sub = classifyDrinkSubcategoryFromText(qTerms);
      if (sub) parsed.drinkSubcategory = sub;
    }

    const tagMap: Record<string, string[]> = {
      "organic": ["økologisk", "organic", "øko", "debio"],
      "seasonal": ["sesong", "seasonal", "i sesong"],
      "budget": ["billig", "rimelig", "budget", "cheap"],
      "local": ["lokal", "local", "nærme", "kort reisevei"],
      "fresh": ["fersk", "fresh", "nyhøstet"],
    };

    const detectedTags: string[] = [];
    for (const [tag, keywords] of Object.entries(tagMap)) {
      if (keywords.some(kw => qTerms.includes(kw))) {
        detectedTags.push(tag);
      }
    }
    if (detectedTags.length > 0) parsed.tags = detectedTags;

    // Location resolution is handled by geocodingService in the search route.
    // This keeps parseNaturalQuery synchronous and fast — geocoding (which may
    // call Kartverket API) happens one level up in the async route handler.

    // ── Name-based search extraction ──
    // Two-pass approach:
    //   Pass 1: If query has indicator words (gård, bakeri, etc.), extract name from context
    //   Pass 2: If no indicator, check if any query word matches an actual agent name in DB
    // This handles both "Bjørndal Gård Oppdal" AND just "Rørosmat"

    const skipWords = new Set(["hva", "har", "hos", "fra", "i", "på", "kan", "du", "jeg",
      "det", "er", "en", "et", "og", "med", "til", "av", "som", "dem", "de", "vi",
      "liste", "prisliste", "priser", "pris", "produkter", "varer", "varene", "koster",
      "kost", "selger", "tilbyr", "finne", "finn", "søk", "kjøpe", "bestille",
      "nær", "nærme", "nærmeste", "meg", "oss", "her", "der", "hvor",
      ...ENGLISH_SKIP_WORDS]);

    const nameIndicators = ["gård", "gard", "farm", "mat", "ysteri", "bakeri", "bryggeri",
      "marked", "butikk", "kooperativ", "meieri", "slakteri", "gardsmat", "gardsutsalg"];
    const queryWords = query.split(/\s+/);
    // Slice I-W: the place words of this query (the gazetteer's; see isPlaceWord).
    const isPlace = placeWordTest(query);

    // Pass 0 (ChatGPT app re-review 2026-10-03): the query names a producer
    // outright. Pass 1/2 below work word by word, so a whole question ("Tell
    // me about Ostegården in Bergen — what do they make and how can I contact
    // them?") built a name query out of every filler word and missed, and an
    // ASCII spelling ("Ostegarden") matched nothing at all. Here the folded
    // query (å→a, ø→o, æ→ae, case and punctuation ignored) is searched for
    // each producer's own name, as a whole-word sequence; a hit becomes the
    // name query in the producer's real spelling.
    // Slice I-W: only the big places of NAME_PASS_PLACE_WORDS make a name
    // generic here, not every place word (see that list).
    const explicitNames = findExplicitProducerNames(query, (w) =>
      skipWords.has(w) || NAME_PASS_PLACE_WORDS.has(w) || GENERIC_NAME_WORDS.has(w)
      || isCategoryOrTagWord(w, categoryMap, tagMap) || isEnglishFoodWord(w));
    if (explicitNames.length > 0) {
      (parsed as any)._nameQuery = explicitNames[0];
      parsed.role = "producer";
      return parsed;
    }
    // The public producers and their names in lower case, read at most once
    // per search (the indicator check and the name passes below).
    // Phase 5.11 A4.1: exclude umbrellas from name-match candidate set
    // dev-request 2026-08-03-mikhailo-quarantine-gates (Gate 1): exclude
    // not-yet-vetted rows too — kept consistent with discover()'s own
    // is_vetted filter even though this candidate-detection step alone
    // can't leak a result (discover()'s actual lookup is gated too).
    let publicRowsRead: any[] | null = null;
    const publicNameRows = (): any[] => (publicRowsRead ??= getDb()
      .prepare(`SELECT id, name FROM agents WHERE is_active = 1 AND umbrella_type IS NULL AND is_vetted = 1 AND ${publicListableSql()}`)
      .all() as any[]);
    let publicNamesRead: string[] | null = null;
    const publicNames = (): string[] => (publicNamesRead ??= publicNameRows().map(r => (r.name || "").toLowerCase()));
    // One text of all names (a word holds no line break, so no match spans two names).
    let namesTextRead: string | null = null;
    const inSomeName = (w: string): boolean => (namesTextRead ??= publicNames().join("\n")).includes(w);
    const oneWord = queryWords.filter(w => w.replace(/[.,!?]/g, "").length > 0).length === 1;

    // Slice I-W3 (FUNN rfb-sok-pass1-fyllord): the filler and qualifier words
    // of a name query, of the length the name passes weigh (three letters or
    // more, so «HA» in «H.A. Hanssen» stays).
    const nameFiller = (w: string) =>
      w.length >= 3 && (QUERY_STOPWORDS.has(w) || NO_PRODUCT_WORDS.has(w) || QUALIFIER_WORDS.has(w));
    // Slice I-W3: the name query of both passes leaves out the filler and
    // qualifier words. With them, «kortreist såper» was the name query
    // «kortreist såper», and discover()'s fuzzy match ranked «Osteverkstedet —
    // Kortreist Italiener» before Reine Såper; «ren såper» gave ten producers
    // with «ren» in their name.
    // - The typed words stay (main's rule) when the words left have no
    //   distinctive word in a producer name (one that discover()'s fuzzy
    //   match weighs: not GENERIC_NAME_TOKENS, no big place), as in a search
    //   of filler words only («Lager 11», «Norsk AS»). Then the filler word is
    //   what names the producer: «When is the next Bondens marked in Oslo?»
    //   (chatgpt-app-submission.json) finds Bondens Butikk Vulkan through
    //   «Bondens», as on main, where «is marked» would find the producers with
    //   «is» and «marked» in their name.
    // - Otherwise a filler word stays when a producer name holds it as a
    //   whole word together with a distinctive word of the search, so the
    //   search still names that producer: «Tell me about Den Gode Baker»,
    //   «Den Gode Baker Sandefjord» and «Den Gode Baker kransekake» keep «Den
    //   Gode» («Den Gode Baker AS» has «baker»), while «kortreist såper» loses
    //   «kortreist» («Kortreist Italiener» has no «såper»). Review round 1
    //   (B2): they stayed only when one name held every word of the search,
    //   so one word more (a request, a place, a product) gave the name query
    //   «Baker», which missed Den Gode Baker.
    // Cost: each distinct filler word (a few hundred at most: the lists)
    // reads the names once, and the distinctive words are looked for in the
    // text of the names that hold it.
    const nameQueryOf = (typed: string[]): string => {
      const low = typed.map(w => w.toLowerCase());
      // No filler word: a shortcut, the rules below would keep every word too.
      if (!low.some(nameFiller)) return typed.join(" ");
      const distinctive = [...new Set(low)].filter(w => w.length >= 3 && !nameFiller(w)
        && !GENERIC_NAME_TOKENS.has(w) && !NAME_PASS_PLACE_WORDS.has(w));
      if (!distinctive.some(inSomeName)) return typed.join(" ");
      const stays = new Map<string, boolean>();
      const fillerStays = (f: string): boolean => {
        let hit = stays.get(f);
        if (hit === undefined) {
          // the names that hold `f` as a whole word, as one text (see inSomeName)
          const holders = publicNames().filter(name => productNameMatch(name, f) === 3).join("\n");
          stays.set(f, hit = holders.length > 0 && distinctive.some(w => holders.includes(w)));
        }
        return hit;
      };
      return typed.filter((_, i) => !nameFiller(low[i]) || fillerStays(low[i])).join(" ");
    };

    // Is `w` (lower case) a whole word of a public producer name
    // (productNameMatch 3)? The words of the names are read once, so a word
    // of letters and digits costs one set lookup. A word with other
    // characters («ar-sjømat») is matched against each name, but only when
    // the text of all names holds it, and once per distinct word. Review
    // round 1 (B1): it was matched against each of the 1 563 live names for
    // every such word, so a 1 MB search of «x-mat» took 33 s (1.6 s on main).
    let nameWordSet: Set<string> | null = null;
    const nameWordSeen = new Map<string, boolean>();
    const isNameWord = (w: string): boolean => {
      if (/^[\p{L}\p{N}_]+$/u.test(w)) {
        return (nameWordSet ??= new Set(publicNames().flatMap(name => name.split(/[^\p{L}\p{N}_]+/u)))).has(w);
      }
      let hit = nameWordSeen.get(w);
      if (hit === undefined) nameWordSeen.set(w, hit = inSomeName(w) && publicNames().some(name => productNameMatch(name, w) === 3));
      return hit;
    };

    // Slice I-W3 (FUNN rfb-sok-pass1-fyllord): an indicator counts only as a
    // whole word. «mat» counted at the end of every word, so «kortreist
    // sjømat» and «tomat fra Hardanger» went to Pass 1 and became name
    // searches («kortreist», «Hardanger»). A word that only ends in an
    // indicator still counts in two cases: it is the whole search
    // («Fiskemat», «Gårds-bakeri»: a search of one word is read as before),
    // or it is itself a whole word of a producer name («Spekemat» in «Bjerke
    // Spekemat & Delikatesse», «Sjømat» in «Trøndelag Sjømat — Tiller»), so
    // the search may name that producer and the live producer names are
    // read as before (B1). «kortreist sjømat» is then no name search because
    // Pass 1 reads the filler words (below).
    const indicatorIndex = queryWords.findIndex(w => {
      const low = w.toLowerCase().replace(/[.,!?]/g, "");
      return nameIndicators.includes(low)
        || (nameIndicators.some(ind => low.endsWith(ind)) && (oneWord || isNameWord(low)));
    });

    if (indicatorIndex >= 0) {
      // Pass 1: Indicator word found — extract name from surrounding words.
      // dev-request 2026-09-05-rfb-mcp-engelsk-sok-kategorifeil: place names
      // and food words are filtered out here too, not just in Pass 2. Without
      // it, "a farm in Vestfold with raw honey" built the name query
      // "farm Vestfold raw honey" — and the fuzzy fallback then answered with
      // every producer that merely has "Vestfold" in its name, discarding the
      // honey category that had been detected correctly one block above.
      // Slice I-W4: next to a category word, a place right after a place
      // preposition (PLACE_PREPOSITIONS) is where to search, not part of a
      // producer name. «Finnes det noen bakeri med kransekake i Bærum» was the
      // name query «kransekake Bærum», which found the producers named after
      // Bærum and not Grini; «bakeri i Bærum» found only them. Without a
      // category word the place stays, as before («gård i Valen»), and so does
      // a word of a place of several words («bakeri i Mo i Rana» finds
      // «Bakeriet Mo i Rana» by name): the geocoder leaves out «i» and never
      // looks such a name up whole.
      const lowAt = (i: number) => (queryWords[i] ?? "").replace(/[.,!?]/g, "").toLowerCase();
      let phraseWords: Set<string> | null = null;
      const placeOfOneWord = (w: string) => isPlace(w) && !(phraseWords ??= multiWordPlaceWordsIn(query)).has(w);
      const nameParts: string[] = [];
      for (let i = 0; i < queryWords.length; i++) {
        const clean = queryWords[i].replace(/[.,!?]/g, "");
        if (clean.length < 2) continue;
        const low = clean.toLowerCase();
        if (skipWords.has(low)) continue;
        if (NAME_PASS_PLACE_WORDS.has(low)) continue;
        if (detectedCategories.length > 0
            && (isCategoryOrTagWord(low, categoryMap, tagMap) || isEnglishFoodWord(low))) continue;
        if (detectedCategories.length > 0 && i > 0 && PLACE_PREPOSITIONS.has(lowAt(i - 1)) && placeOfOneWord(low)) continue;
        nameParts.push(clean);
      }
      // Slice I-W3 (FUNN rfb-sok-pass1-fyllord): Pass 1 read neither
      // NO_PRODUCT_WORDS nor QUALIFIER_WORDS, so «kortreist mat», «sunn mat»
      // and «kortreist sjømat» were name searches for «Osteverkstedet —
      // Kortreist Italiener», «Overnaturlig Honning» and the producers with
      // «Sunn» in their name (main too), and «Finnes det noen bakeri som
      // lager kransekake» one for «Finnes noen lager kransekake». As in Pass
      // 2, the filler and qualifier words make no name search: the other
      // words must still make a name query of four letters or more («mat»
      // alone does not). Next to a category word one of them must also sit
      // inside a producer name; otherwise the category answers, and step 3c
      // reads the rest («kransekake», in no name). A search of one word is
      // read as before («nettbutikk», «kveldsmat»).
      const nameWords = oneWord ? nameParts : nameParts.filter(w => !nameFiller(w.toLowerCase()));
      const inAName = () => [...new Set(nameWords.map(w => w.toLowerCase()))].some(w => w.length >= 3 && inSomeName(w));
      if (nameWords.join(" ").length >= 4 && (oneWord || detectedCategories.length === 0 || inAName())) {
        (parsed as any)._nameQuery = nameQueryOf(nameParts);
      }
    } else {
      // Pass 2: No indicator word — check if query words match any agent name
      // This catches "Rørosmat", "Bjørndal", "Erga" etc.
      // Slice I-W, review round 1: a filler word (QUERY_STOPWORDS,
      // NO_PRODUCT_WORDS) does not make the query a name search either. Any
      // producer name holding «vil», «dag» or «beste» did, so «jeg vil ha
      // kransekake» was a name search for «vil ha kransekake» and never
      // reached the product names. Over the 1 537 live producer names as
      // queries and the 107 searches of the B1 check nothing else changes
      // (2026-10-18); the name query, when another word triggers one, keeps
      // its words as before.
      // Slice I-W2 (S2): a search of filler words only («Finnes», «Bondens»,
      // «Norsk», «Topp») is read by main's rule again. The filter left no word
      // there, so it gave the standard list where main found the producers
      // with the word in their name.
      const passWords = queryWords
        .map(w => w.replace(/[.,!?]/g, "").toLowerCase())
        .filter(w => w.length >= 3 && !skipWords.has(w));
      const contentWords = passWords.filter(w => !QUERY_STOPWORDS.has(w) && !NO_PRODUCT_WORDS.has(w));
      const nonSkipWords = contentWords.length > 0 ? contentWords : passWords;

      // PR-72: Known Norwegian place names that should NOT trigger name-search.
      // Without this list, queries like "fersk fisk i Bergen" set
      // _nameQuery="fersk fisk bergen". The fuzzy fallback then matches every
      // agent with "Bergen" in its name (e.g. "Godt Brød Bergen" — a bakery),
      // overriding the category filter (fish) and yielding wildly off-topic
      // results. The route's geocoding handles location filtering separately,
      // so we can safely treat these as location words, not name tokens.
      // (hoisted to module scope, and since slice I-W the gazetteer's: isPlace above)

      // Don't name-search if all words are food/location/place terms (avoid false positives)
      const isKnownTerm = (w: string) => {
        if (isPlace(w)) return true;
        for (const keywords of Object.values(categoryMap)) {
          if ((keywords as string[]).includes(w)) return true;
        }
        for (const keywords of Object.values(tagMap)) {
          if ((keywords as string[]).includes(w)) return true;
        }
        return false;
      };
      const allAreKnownTerms = nonSkipWords.every(isKnownTerm);

      if (!allAreKnownTerms && nonSkipWords.length > 0) {
        // PR-72: Words that drive name-matching must NOT include known
        // categories/tags/places. Otherwise "Bergen" alone would qualify the
        // query as a name-search just because some agent contains "Bergen"
        // in its name.
        const nameCandidateWords = nonSkipWords.filter(w => !isKnownTerm(w));

        if (nameCandidateWords.length > 0) {
          // Quick check: do any of these distinctive words appear in an agent name?
          const db = getDb();
          const publicRows = publicNameRows();
          const allNames = publicNames();

          // Slice I-W3, review round 1 (B1): each distinct word once, in the
          // text of all names (inSomeName), not in each name. A word that ends
          // in an indicator without being one («x-mat», «a-mat») now comes here
          // instead of to Pass 1, and a 1 MB search of it took 5–9 s (main
          // 1.8–2.1 s). Below, only whether the list is empty and its
          // distinct words are read, so dropping repeats changes nothing else.
          const nameMatches = [...new Set(nameCandidateWords)].filter(inSomeName);
          let nameSearch = nameMatches.length > 0;
          // Slice I-W2 (S4): in a search of several words, a word that only
          // sits inside a producer name («ser» in «Hvasser», «jul» in
          // «Julseth», «stor» in «Storfjord») makes no name search when
          // another word of the search is a place, a category or a product in
          // the catalog (catalogTermMatches, the rule of step 3c). Otherwise
          // «stor kransekake» was a name search and never reached the product
          // names. A word that is a whole word of a name (productNameMatch 3:
          // «Grini», «Lager» in «Lager 11», «REKO-ring» in «REKO-ring Hamar»)
          // still makes one, and so does a search of one word.
          // Review round 1 (B1): each catalog lookup is a LIKE scan of
          // `products`, and the search reaches this point with no length
          // limit (a 98 kB search took 16 s). As in step 3c, a word has at
          // most UNKNOWN_TERMS_MAX other words looked up, the first in the
          // search's order, so a search makes at most UNKNOWN_TERMS_MAX + 1
          // lookups. Places and categories need no lookup and count wherever
          // they stand; each distinct word is weighed once.
          if (nonSkipWords.length > 1 && nameSearch) {
            // a place or category word in the search (nameCandidateWords is nonSkipWords without them)
            const known = nameCandidateWords.length < nonSkipWords.length;
            const lookups = [...new Set(nonSkipWords)].filter(w => !/^\p{N}+$/u.test(w)).slice(0, UNKNOWN_TERMS_MAX + 1);
            const ids = new Set<string>(publicRows.map(r => r.id));
            const hits = new Map<string, boolean>();
            const inCatalog = (w: string): boolean => {
              if (!hits.has(w)) hits.set(w, (catalogTermMatches(db, [w], ids)?.size ?? 0) > 0);
              return hits.get(w)!;
            };
            nameSearch = nameMatches.some(word =>
              allNames.some(name => name.includes(word) && productNameMatch(name, word) === 3)
              || !(known || lookups.filter(other => other !== word).slice(0, UNKNOWN_TERMS_MAX).some(inCatalog)));
          }

          if (nameSearch) {
            // At least one DISTINCTIVE word matches an agent name — use it as name query.
            // PR-72: If categories were also detected, prefer the category-filter path
            // over name-search (category match is stronger signal than a fuzzy name word).
            // Pass 1 (explicit indicator words like "gård") still sets _nameQuery directly.
            // Slice I-W3: without the filler and qualifier words (nameQueryOf).
            // A search of filler words only keeps them (S2: main's rule,
            // «Finnes», «Norsk AS»): the words left are under three letters.
            if (!parsed.categories || parsed.categories.length === 0) {
              const typed = queryWords
                .map(w => w.replace(/[.,!?]/g, ""))
                .filter(w => w.length >= 2 && !skipWords.has(w.toLowerCase()));
              const nameQuery = nameQueryOf(typed);
              if (nameQuery.length >= 3) {
                (parsed as any)._nameQuery = nameQuery;
              }
            }
          }
        }
      }
    }

    // Slice I-W: a query with no category and no producer name («kransekake»,
    // «zzzqqx») set no filter at all, so discover() returned its standard
    // list. The words nothing above explains go to discover() step 3c, which
    // looks them up in the product names. Only then: a word next to a
    // category or a name is no reason to narrow those («god ost i Bergen»).
    // Slice I-W2 (S4): next to a category word without a product term
    // («Which bakeries make kransekake») the words are kept too; discover()
    // only lets them rank that category's producers, never add any. A word
    // for the occasion, meal, size or packaging (QUALIFIER_WORDS) counts only
    // when nothing else in the search names the product (S1).
    // Slice I-W3: a product term that names the kind of producer
    // (PRODUCER_KIND_TERMS: «bakeri») gives way to those words, as
    // «bakeries» does. «kransekake fra bakeri» ranked the producers with
    // «… fra eget bakeri» in a product name first and labelled the bakeries
    // with kransekake «Kategoritreff: «bakeri» ikke oppført». Next to an
    // indicator word («sunn mat») a qualifier word counts no more than next
    // to a category word: «mat» names what is sought, so the search reads as
    // «mat» does, not as a lookup of «sunn» in the product names.
    if (!(parsed as any)._nameQuery && (parsed._productTerms ?? []).every(t => PRODUCER_KIND_TERMS.has(t))) {
      const unknown = unknownProductWords(q, (w) =>
        skipWords.has(w) || isPlace(w) || nameIndicators.includes(w)
        || isCategoryOrTagWord(w, categoryMap, tagMap) || isEnglishFoodWord(w)
        || Object.values(tagMap).some((kws) => kws.some((kw) => !kw.includes(" ") && w.startsWith(kw))),
      !parsed.categories?.length && indicatorIndex < 0);
      if (unknown.length > 0) {
        parsed._unknownTerms = unknown;
        delete parsed._productTerms;
      }
    }

    parsed.role = "producer";
    return parsed;
  }

  // ─── Agent Card Generation (A2A standard) ─────────────────

  getAgentCard(agentId: string): object | null {
    const agent = this.getAgent(agentId);
    if (!agent) return null;

    // dev-request 2026-07-04-rfb-datakvalitet item 1 (description
    // sanitizer, render-guard-only slice): this backs the public,
    // unauthenticated GET /agents/:id/card A2A card — never echo scraped
    // nav/boilerplate junk here.
    let cardDescription = agent.description;
    if (cardDescription && isJunkDescription(cardDescription)) {
      console.log(`[description-guard] suppressed junk description (agent-card) for ${agent.id} (${agent.name})`);
      cardDescription = "";
    } else if (cardDescription) {
      // Strip an appended internal pipeline note (Daniel 2026-09-03) before
      // it reaches the public, unauthenticated agent card.
      cardDescription = normalizeProse(cardDescription);
    }

    return {
      name: agent.name,
      description: cardDescription,
      url: agent.url,
      provider: { organization: agent.provider },
      version: agent.version,
      capabilities: agent.capabilities,
      skills: agent.skills.map(s => ({
        id: s.id,
        name: s.name,
        description: s.description,
        inputModes: s.inputModes,
        outputModes: s.outputModes,
      })),
      "x-lokal": {
        role: agent.role,
        categories: agent.categories,
        tags: agent.tags,
        trustScore: agent.trustScore,
        isVerified: agent.isVerified,
        registeredAt: agent.registeredAt,
        location: agent.location ? { city: agent.location.city } : undefined,
      },
    };
  }

  // ─── Registry-level Agent Card (Lokal itself) ──────────────

  getRegistryCard(baseUrl: string): object {
    // ONE catalog number (services/honest-count.ts) on every discovery surface;
    // falls back to the legacy raw count only if the honest query is unavailable.
    const rawStats = this.getStats();
    const honestCount = safeHonestCatalogCount("rfb");
    const stats = { ...rawStats, totalAgents: honestCount ?? rawStats.totalAgents };
    return {
      // ─── A2A spec-compliant fields ─────────────────────────
      // WHY bilingual: Consumer agents (Claude, GPT, Gemini, etc.)
      // search in English. Norwegian producers search in Norwegian.
      // Both need to find us. Bilingual descriptions = 2x discovery surface.
      name: "Rett fra Bonden",
      description: "A2A marketplace for local food in Norway. " +
        `Connect AI agents with ${stats.totalAgents || 1169}+ verified local farms, shops, cooperatives, farm shops, REKO rings, and markets. ` +
        "Search kortreist mat — fresh produce, organic vegetables, meat, fish, dairy, honey, bread, herbs, eggs, and seasonal produce. " +
        "Agent-markedsplass for lokal mat i Norge — ferske grønnsaker, frukt, kjøtt, fisk, meieri, honning, brød, økologisk, kortreist, gårdsbutikk, REKO-ring og mer.",
      // A2A spec: this MUST be the JSON-RPC endpoint, not the website root.
      // Compliant clients (incl. a2aregistry.org) POST messages directly to
      // this URL. Pointing it at `${baseUrl}` made every client land on
      // Express's HTML 404 page and report "404 Not Found when sending
      // messages" — flagged by A2A Registry maintainer 2026-04-25.
      url: `${baseUrl}/a2a`,
      // ─── Top-level discovery metadata (registry display) ───
      // homepage + iconUrl are recommended top-level fields per A2A spec.
      // a2aregistry.org and other directories surface these directly to humans;
      // without them, registry records show "None" / fallback rendering.
      homepage: baseUrl,
      iconUrl: `${baseUrl}/logo.svg`,
      // T3 (A2A dev-request 2026-10-08-juridisk-info-nettsteder-agentplatform-as):
      // the provider is the company that operates the service (from COMPANY_INFO);
      // the card's own `name` keeps the brand.
      provider: {
        ...agentCardProvider(),
        contactUrl: `${baseUrl}/docs`,
        description: "Open agent-to-agent food marketplace operator. " +
          "Norges første A2A-markedsplass for lokal mat.",
      },
      version: "1.0.0",
      // A2A v1.0 (Linux Foundation, released April 2026) top-level protocol fields.
      // Dual-published alongside the legacy `authentication`/`interfaces` fields below —
      // registries/clients on the old 0.3.0 shape keep working unchanged (dev-request
      // 2026-07-13-a2a-card-v1-signing slice 1, additive-only by design: nothing legacy
      // removed or altered, so this cannot regress an already-working consumer).
      protocolVersion: "1.0.0",
      preferredTransport: "JSONRPC",
      additionalInterfaces: [
        { url: `${baseUrl}/api/marketplace`, transport: "HTTP+JSON" },
      ],
      documentationUrl: `${baseUrl}/docs`,
      // dev-request 2026-07-25-proveniens-transparens: additive link to the
      // public "how we verify our data" page (field_provenance / cross-source
      // agreement machinery, already live server-side — docs only, no new
      // behavior). Kept in parity with src/routes/a2a.ts's /a2a card per the
      // same-parity convention already documented above for the v1.0 fields.
      provenancePageUrl: `${baseUrl}/proveniens`,
      defaultInputModes: ["text/plain", "application/json"],
      defaultOutputModes: ["application/json"],



      // ─── Protocol capabilities ─────────────────────────────
      capabilities: {
        streaming: false,
        pushNotifications: false,
        stateTransitionHistory: true,
      },

      // ─── Authentication (legacy 0.3.0 field, kept for back-compat) ─────
      authentication: {
        schemes: ["apiKey"],
        credentials: null, // Open for reads, key for writes
      },

      // ─── A2A interfaces (legacy 0.3.0 field, kept for back-compat) ──────
      interfaces: [
        {
          type: "json-rpc",
          url: `${baseUrl}/a2a`,
          methods: rfbJsonRpcMethods(),
          description: "A2A JSON-RPC 2.0 endpoint for agent-to-agent communication",
        },
        {
          type: "rest",
          url: `${baseUrl}/api/marketplace`,
          description: "REST API for search, discovery, registration, and human dashboard",
        },
      ],

      // ─── Skills (what agents can DO through us) ────────────
      // Each skill is a capability an external agent can invoke.
      // Rich descriptions + tags = higher match probability.
      skills: [
        {
          id: "discover-local-food-agents",
          name: "Discover Local Food Agents / Finn lokale matagenter",
          description: `Search a registry of ${stats.totalAgents || 1396}+ verified local food producers in Norway. ` +
            "Filter by category (vegetables, fruit, meat, fish, dairy, eggs, honey, herbs, bread, berries), " +
            "location (Oslo, Bergen, Trondheim, Stavanger, Tromsø, and rural districts), " +
            "certifications (organic, Debio, farm-direct), delivery options (pickup, local delivery), " +
            "and trust score. Returns ranked results with contact info and A2A endpoints. " +
            `Søk blant ${stats.totalAgents || 1396}+ verifiserte lokale ${getConfig().domain_dictionary.entity_plural_long} i Norge.`,
          tags: [
            // English discovery keywords (what agents actually search for)
            "local food", "fresh produce", "organic", "farm direct", "vegetables", "fruit",
            "meat", "fish", "seafood", "dairy", "eggs", "honey", "herbs", "bread", "berries",
            "food marketplace", "food supplier", "grocery", "farm to table", "sustainable food",
            "food delivery", "food procurement", "wholesale food", "restaurant supply",
            // Norwegian keywords (for Nordic agents)
            "lokal mat", "ferske grønnsaker", "økologisk", "gårdsutsalg", "frukt",
            "kjøtt", "fisk", "sjømat", "meieri", "egg", "honning", "urter", "brød", "bær",
            "matmarked", "matleveranse", "kortreist mat", "sesongvarer",
            // Geographic (city-level discovery)
            "Norway", "Norge", "Oslo", "Bergen", "Trondheim", "Stavanger", "Tromsø",
            "Kristiansand", "Drammen", "Fredrikstad", "Bodø",
          ],
          inputModes: ["text/plain", "application/json"],
          outputModes: ["application/json"],
          examples: [
            "Find organic vegetable farms near Oslo",
            "finn ferske grønnsaker i Bergen",
            "fresh fish suppliers Tromsø",
          ],
        },
        {
          id: "register-food-agent",
          name: "Register Food Producer Agent / Registrer matagent",
          description: "Register a new food producer, farm, shop, or cooperative as an agent in the Rett fra Bonden marketplace. " +
            "Once registered, your agent gets an A2A Agent Card, becomes discoverable by consumer agents, " +
            "and can be found and contacted through the marketplace. " +
            "Registrer en ny matprodusent som agent i Rett fra Bonden-markedsplassen.",
          tags: [
            "register", "onboard", "producer", "farm", "shop", "cooperative",
            "registrering", "produsent", "gård", "butikk", "andelslag",
          ],
          inputModes: ["application/json"],
          outputModes: ["application/json"],
          examples: [
            "Register my organic farm in Bergen",
            "registrer en gård i Oslo",
          ],
        },
        {
          id: "search-compare-food",
          name: "Search & Compare Local Food / Søk og sammenlign",
          description: "Natural language search across all producers. Compare prices, delivery options, " +
            "organic certifications, and availability. Supports both English and Norwegian queries. " +
            "Søk, sammenlign priser, leveringsalternativer og tilgjengelighet.",
          tags: [
            "search", "compare", "price", "delivery", "availability",
            "søk", "sammenlign", "pris", "levering", "tilgjengelighet",
          ],
          inputModes: ["text/plain", "application/json"],
          outputModes: ["application/json"],
          examples: [
            "compare cheese prices in Oslo",
            "finn billig honning nær Trondheim",
          ],
        },
        // Fase B3 (mine ordrer): only with ORDER_AGENT_ACTIONS_ENABLED on; off, the card is unchanged.
        ...(isOrderAgentActionsEnabled() ? [managePickupOrderSkill()] : []),
      ],

      // ─── Security ──────────────────────────────────────────
      securitySchemes: {
        apiKey: {
          type: "apiKey",
          in: "header",
          name: "X-API-Key",
          description: "API key received upon registration. Required for write operations. " +
            "Read/search operations are open. " +
            "API-nøkkel mottatt ved registrering. Kreves for skriveoperasjoner.",
        },
        // dev-request 2026-07-13-agent-identity-usage-ledger, slice 2 (docs-only
        // advertisement — issuance/rate-limiting/ledger already shipped in
        // PR #337/#350). A SECOND, unrelated scheme sharing the same
        // X-API-Key header name as `apiKey` above — intentional, not a
        // collision; see description.
        consumerApiKey: {
          type: "apiKey",
          in: "header",
          name: "X-API-Key",
          description: "Free, voluntary consumer-identity key for AI agents calling this API " +
            "— get one via POST /api/keys (optional label/contact_email in the JSON body), " +
            "no login or account needed. Uses the SAME header name (X-API-Key) as the `apiKey` " +
            "scheme above, but is a separate, optional credential for a different purpose: " +
            "read/search calls are already fully open with no key at all, and nothing here is " +
            "required. Sending a consumer key raises your rate-limit ceiling on the general " +
            "REST/a2a surface (about 3x) and gets your calls counted in a per-key usage ledger " +
            "— /api/marketplace/search and /api/marketplace/discover currently sit behind a " +
            "separate, static per-IP quota that a consumer key does not raise. " +
            "Gratis, frivillig forbruker-identitetsnøkkel for AI-agenter — hentes via " +
            "POST /api/keys, ingen innlogging eller konto kreves. Bruker samme headernavn " +
            "(X-API-Key) som apiKey-skjemaet over, men er en egen, valgfri legitimasjon til et " +
            "annet formål — les/søk er allerede helt åpent uten nøkkel. " +
            "Gir høyere rate-grense på det generelle REST-/a2a-grensesnittet (ca. 3x) og en " +
            "egen forbrukslogg — /api/marketplace/search og /api/marketplace/discover ligger " +
            "i dag bak en egen, flat kvote som ikke økes av nøkkelen.",
        },
      },
      // A2A v1.0 `security` requirement list (dev-request 2026-07-13-a2a-card-v1-signing
      // slice 1) -- empty means no default requirement, matching `authentication.credentials:
      // null` above: reads are open, `securitySchemes.apiKey` only applies to writes.
      security: [],

      // ─── Distribution channels (Phase 5.11 — Smithery added 2026-05-16;
      // Glama / mcp.so / Official MCP Registry added 2026-05-28 by visibility-agent) ─
      // External registries that index this server. Consumer agents that
      // discover us via these channels can verify they are talking to the
      // canonical Rett fra Bonden marketplace by cross-checking the homepage
      // and `name` here.
      // Prefixed with `x-` to follow the in-file extension convention
      // (matches `x-lokal` below) and stay safe with strict A2A validators.
      "x-distribution": distributionFor("rfb", `${baseUrl}/.well-known/agent-card.json`),
      // acp-product-feed (/api/marketplace/catalog/acp-feed.csv) is deliberately NOT
      // advertised here while the feed has 0 rows (dev-request 2026-09-08-discovery-
      // paritet-og-ett-katalogtall, item 3); re-add it when it serves rows.

      // ─── Lokal-specific metadata ───────────────────────────
      "x-lokal": {
        type: "registry",
        region: "Norway",
        primaryLanguages: ["no", "en"],
        stats: {
          totalAgents: stats.totalAgents,
          activeProducers: stats.activeProducers,
          cities: stats.cities,
        },
        // Generated from the tools the live /mcp server registers
        // (services/mcp-tool-manifest.ts); locked by discovery-truth.test.ts.
        mcpTools: registeredMcpTools("rfb").map((t) => t.name),
        // Semantic categories for automated matching
        serviceCategories: [
          "food-marketplace", "local-commerce", "farm-direct",
          "agent-to-agent", "food-supply-chain", "sustainable-agriculture",
        ],
      },
    };
  }

  // ─── CRUD helpers ─────────────────────────────────────────

  getAgent(id: string): RegisteredAgent | undefined {
    const db = getDb();
    const row = db.prepare("SELECT * FROM agents WHERE id = ?").get(id) as any;
    return row ? this.rowToAgent(row) : undefined;
  }

  // dev-request 2026-08-03-mikhailo-quarantine-gates (Gate 1 extension —
  // ID-addressable single-agent lookups): getActiveAgents()'s is_vetted
  // filter only protects LIST surfaces. GET /agents/:id/card, /info, /vcard,
  // and /trust are ID-addressable single-agent lookups, not filtered lists
  // — "exclude from getActiveAgents()" doesn't apply the same way, so each
  // of those routes calls this helper directly and 404s exactly like
  // /produsent/:slug does for an unknown id, rather than serving a
  // self_registered agent's full card/knowledge/trust-breakdown before a
  // human has vetted it.
  //
  // Decision (see PR description for the fuller reasoning): the claiming
  // producer themselves already gets their own agent id back in the 201
  // response from POST /register, and separately keeps the ability to
  // manage their listing via PUT /agents/:id/knowledge with their claim
  // token (unaffected by this — that route is owner-authenticated, not a
  // public read). There's no legitimate PUBLIC/unauthenticated reason to
  // read a quarantined agent's card/info/vcard/trust before approval, so
  // the safer default — matching this PR's "never visible before human
  // review" thesis — wins over "ID-addressable lookups are intentionally
  // different": treat these 4 endpoints the same as /produsent/:slug.
  //
  // Unknown ids return false (not quarantined) so callers fall through to
  // their own normal "not found" handling instead of this helper
  // manufacturing a false positive.
  //
  // dev-request 2026-10-01-rfb-skjult-testprodusent-for-ordreflyt: a row that
  // fails the shared public-listability predicate (catalog_hidden fixture, or a
  // dental/experiences row in `agents`) is treated the same way on these
  // public by-id lookups (card/info/vcard/trust, /api/agents/:id/stats, the
  // marketing lane). The order flow never goes through here — it uses
  // /catalog/agents/:id/products, the cart routes and lokal_info by id.
  // S2c-2: the owner's visibility choice applies here too (visibility.profile;
  // with audience "ai" also visibility.ai_assistants). ignoreOwnerPause skips
  // it like the pause — the owner's own read is not a public view.
  isQuarantinedFromPublicView(agentId: string, opts: { ignoreOwnerPause?: boolean; audience?: OwnerVisibilityAudience } = {}): boolean {
    const db = getDb();
    // Økologi S0: a delisted id (agent-visibility.ts) is never a public view.
    if (isDelistedAgentId(agentId)) return true;
    const found = db.prepare("SELECT origin, is_vetted, is_active, catalog_hidden, vertical_id FROM agents WHERE id = ?").get(agentId) as
      { origin: string | null; is_vetted: number | null; is_active: number | null; catalog_hidden: number | null; vertical_id: string | null } | undefined;
    if (!found) return false;
    // S1b punkt 6: the owner-pause table is read only with OWNER_PAUSE_ENABLED on.
    // ignoreOwnerPause: the owner's own authenticated read (/selger editor via
    // /agents/:id/info + X-Claim-Token) skips ONLY the pause, nothing else.
    const row = ownerPauseEnabled() && !opts.ignoreOwnerPause ? { ...found, ...readOwnerPauseRow(db, agentId) } : found;
    // The rule itself lives in agent-visibility.ts (isAgentPubliclyVisible):
    // flag off = the quarantine rule this method has always applied; flag
    // OWNER_VISIBILITY_ENFORCE_BY_ID on = also is_active.
    const ownerChoice = ownerVisibilityEnforced() && !opts.ignoreOwnerPause ? { agentId, audience: opts.audience } : {};
    return !isAgentPubliclyVisible(row, { surface: "gated", ...ownerChoice });
  }

  getAgentByApiKey(apiKey: string): RegisteredAgent | undefined {
    const db = getDb();
    const row = db.prepare("SELECT * FROM agents WHERE api_key = ?").get(apiKey) as any;
    return row ? this.rowToAgent(row) : undefined;
  }

  updateAgent(id: string, updates: Partial<RegisteredAgent>): RegisteredAgent | undefined {
    const db = getDb();
    const existing = this.getAgent(id);
    if (!existing) return undefined;

    // Only update allowed fields
    const allowedFields: Record<string, string> = {
      name: "name",
      description: "description",
      url: "url",
      categories: "categories",
      tags: "tags",
      skills: "skills",
      // Phase 4.x — allow admin/owner to correct geo metadata.
      // city is the column on the agents table that surfaces in
      // search results, contact-card downloads, and the agent
      // detail page. Misclassified region (e.g. Akershus vs Buskerud
      // when postal code is in Buskerud) shows up in 3+ places —
      // exposing this field in PATCH closes that whole class of bug.
      city: "city",
    };

    const setClauses: string[] = ["last_seen_at = datetime('now')"];
    const values: any[] = [];

    for (const [key, col] of Object.entries(allowedFields)) {
      if ((updates as any)[key] !== undefined) {
        const val = (updates as any)[key];
        setClauses.push(`${col} = ?`);
        values.push(Array.isArray(val) ? JSON.stringify(val) : val);
      }
    }

    // ─── Slug-alias side-write (dev-request 2026-09-03-rfb-korrigering-navn-
    // sted-kategorier, Mål 1) ───────────────────────────────────────────────
    // Slug is NOT a persisted column (see getAgentBySlugIncludingUmbrellas
    // below) — it is recomputed from `name` on every /produsent/:slug lookup.
    // A rename therefore kills the old URL immediately and silently unless we
    // record the abandoned slug here. Only fires when the RESOLVABLE slug
    // actually changes — compare slugify(old) vs slugify(new), not raw
    // string inequality on `name`, so a purely cosmetic edit (punctuation,
    // casing) that slugifies identically writes no alias row. Best-effort:
    // a failed alias write must never block the rename itself, same
    // "best-effort side-write" discipline as the provider_work_queue writes
    // in dev-request 2026-08-17-forsyningskjede...'s Skive 1.
    if (updates.name !== undefined && slugify(updates.name) !== slugify(existing.name)) {
      try {
        insertAgentSlugAlias(id, slugify(existing.name));
      } catch (err) {
        console.error("[marketplace-registry] slug-alias write failed (rename proceeds regardless):", err);
      }
    }

    values.push(id);
    db.prepare(`UPDATE agents SET ${setClauses.join(", ")} WHERE id = ?`).run(...values);
    this.invalidateCache();
    return this.getAgent(id);
  }

  heartbeat(id: string): void {
    const db = getDb();
    db.prepare("UPDATE agents SET last_seen_at = datetime('now') WHERE id = ?").run(id);
  }

  deactivate(id: string): boolean {
    const db = getDb();
    const result = db.prepare("UPDATE agents SET is_active = 0 WHERE id = ?").run(id);
    this.invalidateCache();
    return result.changes > 0;
  }

  getAllAgents(): RegisteredAgent[] {
    const db = getDb();
    const rows = db.prepare("SELECT * FROM agents ORDER BY created_at DESC").all() as any[];
    return rows.map(r => this.rowToAgent(r)!);
  }

  // dev-request 2026-08-03-mikhailo-quarantine-gates (Gate 1, root-fix round):
  // this single method backs the vast majority of public/crawler-facing
  // agent-listing surfaces in the codebase (marketplace API listings, SEO
  // city pages, the homepage featured section, sitemap.xml, llms.txt/
  // llms-full.txt/agents.json, the /produsent/:slug "did you mean" fuzzy
  // fallback, salgskanal listings, MCP resources, the A2A card...). Rather
  // than patch each downstream consumer, the is_vetted filter lives HERE —
  // is_vetted defaults to 1 (see database/init.ts), so this is a no-op for
  // every existing/admin/seed-created row; only self_registered, not-yet-
  // approved rows are newly excluded.
  //
  // `includeUnvetted` is an explicit, narrow opt-out for the handful of
  // INTERNAL by-ID bookkeeping call sites that must be able to see a
  // quarantined agent's own data (e.g. filling in its name for a claim-
  // request email, or its url/email for a blocklist entry when an admin
  // deletes it) — never for anything that renders a public listing or page.
  // Default false: every call site that doesn't explicitly ask for it keeps
  // getting the filtered set, so a future new caller can't silently regress
  // the gate simply by omitting an option it doesn't know exists.
  //
  // Caching: only the default (filtered, includeUnvetted=false) path is
  // cached — this is the hot path called on nearly every public request.
  // The opt-out path is called from a couple of rare, low-traffic admin/
  // claim code paths, so it queries live rather than adding a second cache
  // dimension (and the two would otherwise need independent invalidation).
  getActiveAgents(opts?: { includeUnvetted?: boolean }): RegisteredAgent[] {
    const includeUnvetted = opts?.includeUnvetted === true;
    const db = getDb();
    if (includeUnvetted) {
      const rows = db.prepare("SELECT * FROM agents WHERE is_active = 1 AND umbrella_type IS NULL ORDER BY trust_score DESC, created_at DESC").all() as any[];
      return rows.map(r => this.rowToAgent(r)!);
    }
    // S2d-2 «Vis som offentlig»: an as-public view (admin key + ?as_public=1)
    // sees the test fixture, so it neither reads nor fills the shared cache.
    if (isAsPublicView()) {
      return (db.prepare(`SELECT * FROM agents WHERE umbrella_type IS NULL AND ${activeVettedListableSql()} ORDER BY trust_score DESC, created_at DESC`).all() as any[])
        .filter(r => !isDelistedAgentId(r.id))
        .map(r => this.rowToAgent(r)!);
    }
    const now = Date.now();
    if (this._agentsCache && (now - this._agentsCacheTime) < MarketplaceRegistry.CACHE_TTL) {
      return this._agentsCache;
    }
    // Phase 5.11 A4.1: getActiveAgents powers producer-discovery surfaces; exclude umbrellas
    // Narrowest of the four agent-count filters in the platform: is_active=1 AND
    // umbrella_type IS NULL AND is_vetted=1 (getStats()'s `total`/activeProducers above
    // only apply a subset of these). This is what powers llms.txt's producer count
    // (`agents.length` in src/routes/discovery.ts's /llms.txt handler, via
    // marketplaceRegistry.getActiveAgents()) — the smallest of the publicly-visible
    // agent counts, because it's the only one that requires vetted + non-umbrella +
    // active all at once. See dev-request 2026-08-21-rfb-produsenttall-kilde-til-sannhet.
    // dev-request 2026-10-01-rfb-skjult-testprodusent-for-ordreflyt: + the shared
    // public-listability predicate (no catalog_hidden fixture, RFB vertical only)
    // — this one line covers every public list surface built on this method.
    const rows = db.prepare(`SELECT * FROM agents WHERE umbrella_type IS NULL AND ${activeVettedListableSql()} ORDER BY trust_score DESC, created_at DESC`).all() as any[];
    // Økologi S0: a delisted id (agent-visibility.ts) is on no public list.
    this._agentsCache = rows.filter(r => !isDelistedAgentId(r.id)).map(r => this.rowToAgent(r)!);
    this._agentsCacheTime = now;
    return this._agentsCache;
  }

  // ─── Phase 5.11 A4.4: slug lookup that INCLUDES umbrella-tagged agents ──
  // Why this exists: PR-48 narrowed getActiveAgents() to exclude umbrellas so
  // producer discovery surfaces (search, /sok, related, suggestions) don't
  // surface them as if they were normal producers. But the SEO route
  // /produsent/:slug needs to find umbrellas too — A4.3 just migrated 14
  // lokallag + 58 venue profile pages and every one of those URLs was
  // returning 404. This method bypasses the umbrella filter and is used
  // ONLY by the slug-lookup branch in seo.ts. Suggestions, related
  // producers, and discovery surfaces continue to use getActiveAgents()
  // (producer-only) — only the direct main-agent lookup widens.
  //
  // Perf (dev-request 2026-09-26-rfb-produsentside-synkron-slug-skann): this used
  // to run `SELECT * FROM agents WHERE is_active = 1` + slugify() on every row for
  // EVERY /produsent/:slug request — O(all agents) of synchronous work incl. the
  // large text/JSON columns, 5–25 s event-loop stalls under crawling. Now: a
  // slug→id map built from `id, name` only (first match in the SAME scan order as
  // the old query wins, exactly like the old Array.find), then ONE `WHERE id = ?` row read. Direct-SQL writers
  // (deactivate, merge, bulk inserts) don't all go through invalidateCache(), so
  // the map is guarded three ways: a (count, max rowid) fingerprint per lookup,
  // re-verification of the hit row (still active AND slug still matches), and a
  // throttled rebuild on a miss (renames via direct SQL). Residual, bounded
  // staleness (≤30 s max age): a direct-SQL rename INTO an existing slug, or a
  // reactivation offset by a deactivation, keeps the fingerprint unchanged.
  private _slugIdMap: Map<string, string> | null = null;
  private _slugIdMapDb: unknown = null;
  private _slugIdMapFp = "";
  private _slugIdMapBuiltAt = 0;
  private static SLUG_MAP_MISS_REBUILD_MS = 2_000;
  private static SLUG_MAP_MAX_AGE_MS = 30_000;

  private slugFingerprint(db: ReturnType<typeof getDb>): string {
    const r = db.prepare("SELECT COUNT(*) AS c, MAX(rowid) AS m FROM agents WHERE is_active = 1").get() as any;
    return `${r.c}:${r.m}`;
  }

  private rebuildSlugMap(db: ReturnType<typeof getDb>, fp: string): Map<string, string> {
    const rows = db.prepare("SELECT id, name FROM agents WHERE is_active = 1").all() as Array<{ id: string; name: string }>;
    // Deliberately NO ORDER BY: this must visit rows in the same order the old
    // `SELECT * … WHERE is_active = 1` did (SQLite scans idx_agents_geo, i.e. lat/lng
    // order, not rowid), so the winner among duplicate slugs is unchanged and still
    // matches admin-agents-duplicate-slugs.ts `currentlyServedId`.
    const map = new Map<string, string>();
    for (const r of rows) {
      const key = slugify(r.name).toLowerCase();
      if (!map.has(key)) map.set(key, r.id);
    }
    this._slugIdMap = map;
    this._slugIdMapDb = db;
    this._slugIdMapFp = fp;
    this._slugIdMapBuiltAt = Date.now();
    return map;
  }

  getAgentBySlugIncludingUmbrellas(slug: string): RegisteredAgent | undefined {
    const target = slug.toLowerCase();
    const db = getDb();
    const now = Date.now();
    const fp = this.slugFingerprint(db);
    let map = this._slugIdMap;
    let fresh = false;
    if (!map || this._slugIdMapDb !== db || this._slugIdMapFp !== fp
        || now - this._slugIdMapBuiltAt > MarketplaceRegistry.SLUG_MAP_MAX_AGE_MS) {
      map = this.rebuildSlugMap(db, fp);
      fresh = true;
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      const id = map.get(target);
      if (id === undefined) {
        // Miss: a direct-SQL rename may not be in the map yet. Rebuild at most
        // once per throttle window so a crawler of unknown slugs stays cheap.
        if (!fresh && now - this._slugIdMapBuiltAt >= MarketplaceRegistry.SLUG_MAP_MISS_REBUILD_MS) {
          map = this.rebuildSlugMap(db, fp);
          fresh = true;
          continue;
        }
        return undefined;
      }
      const row = db.prepare("SELECT * FROM agents WHERE id = ? AND is_active = 1").get(id) as any;
      if (row && slugify(row.name).toLowerCase() === target) return this.rowToAgent(row);
      // Stale entry (direct-SQL deactivate/rename): rebuild once and retry.
      if (fresh) return undefined;
      map = this.rebuildSlugMap(db, fp);
      fresh = true;
    }
    return undefined;
  }

  // ─── Slug-alias resolution (dev-request 2026-09-03-rfb-korrigering-navn-
  // sted-kategorier, Mål 1) ────────────────────────────────────────────────
  // Read-only companion to insertAgentSlugAlias below. Looks up an abandoned
  // slug (written by updateAgent()'s rename hook, or backfilled via
  // POST /admin/agents/:id/slug-alias) and returns the agent it now belongs
  // to — but ONLY if that agent is still `is_active`. Never resurrects a
  // deleted/deactivated agent's alias into a working redirect target. Pure
  // read; never writes.
  resolveAgentSlugAlias(oldSlug: string): RegisteredAgent | undefined {
    const db = getDb();
    ensureAgentSlugAliasesTable(db);
    const row = db
      .prepare("SELECT agent_id FROM agent_slug_aliases WHERE old_slug = ?")
      .get(oldSlug) as { agent_id: string } | undefined;
    if (!row) return undefined;
    const agent = this.getAgent(row.agent_id);
    if (!agent || !agent.isActive) return undefined;
    return agent;
  }

  // ─── Phase 5.11 follow-up: id lookup that INCLUDES umbrella-tagged agents ──
  // Companion to getAgentBySlugIncludingUmbrellas above. The per-agent stats
  // route (/api/agents/:id/stats) needs to resolve umbrella IDs too, because
  // umbrella agents (Bondens marked Norge, lokallag, venues) own /produsent/<slug>
  // SEO pages that should display the same view-count tile producers do.
  // Without this method the route falls back to getActiveAgents().find() which
  // filters umbrellas out → endpoint 404s for any umbrella ID present in
  // /admin/analytics/producers (the visibility-agent's runtime lookup target).
  getActiveAgentByIdIncludingUmbrellas(id: string): RegisteredAgent | undefined {
    const db = getDb();
    const row = db.prepare("SELECT * FROM agents WHERE id = ? AND is_active = 1").get(id) as any;
    return row ? this.rowToAgent(row) : undefined;
  }

  getStats(): { totalAgents: number; activeProducers: number; cities: string[]; totalListings: number } {
    const now = Date.now();
    // S2d-2: an as-public view (it counts the test fixture) neither reads nor fills the cache.
    const asPublic = isAsPublicView();
    if (!asPublic && this._statsCache && (now - this._statsCacheTime) < MarketplaceRegistry.CACHE_TTL) {
      return this._statsCache;
    }
    const db = getDb();
    // dev-request 2026-10-01-rfb-skjult-testprodusent-for-ordreflyt: all three
    // counts below apply the shared public-listability predicate — the hidden
    // test fixture and the dental/experiences rows that sit in `agents` are not
    // RFB producers and must not inflate RFB's public numbers.
    const listable = publicListableSql();
    // COUNT(*) over every RFB-listable row — still includes inactive and umbrella-
    // tagged agents. Consumed by /health's traffic.totalAgents AND /api/stats'
    // registry.totalAgents (a2a.ts) — same cached call, same number, by construction.
    // See dev-request 2026-08-21-rfb-produsenttall-kilde-til-sannhet.
    const total = (db.prepare(`SELECT COUNT(*) as c FROM agents WHERE ${listable}`).get() as any).c;
    // Phase 5.11 A4.1: activeProducers stat should exclude umbrella-tagged agents
    // This is registry.activeProducers in /api/stats — a distinct, narrower count than
    // `total`/totalAgents above (is_active + non-umbrella producers only). See dev-request
    // 2026-08-21-rfb-produsenttall-kilde-til-sannhet.
    const activeProducers = (db.prepare(`SELECT COUNT(*) as c FROM agents WHERE role = 'producer' AND is_active = 1 AND umbrella_type IS NULL AND ${listable}`).get() as any).c;
    // Phase 5.11 A4.1: cities stat should not count umbrella locations
    const citiesRows = db.prepare(`SELECT DISTINCT city FROM agents WHERE city IS NOT NULL AND umbrella_type IS NULL AND ${listable}`).all() as any[];
    const totalListings = (db.prepare("SELECT COUNT(*) as c FROM listings").get() as any).c;

    // dev-request 2026-07-04-rfb-datakvalitet item 5 (stats-guard slice):
    // raw agents.city values include country ("Norge"), fylke/county
    // ("Akershus", "Vestland"), multi-kommune region labels ("Lofoten",
    // "Valdres") and casing typos ("sandeid"). normalizeCityLabel() strips
    // the first three and fixes the fourth; two raw values can collapse to
    // the same normalized city (casing-only difference), so de-duplicate
    // after mapping.
    const normalizedCities = new Set<string>();
    for (const r of citiesRows) {
      const normalized = normalizeCityLabel(r.city);
      if (normalized) normalizedCities.add(normalized);
    }

    const stats = {
      totalAgents: total,
      activeProducers,
      cities: Array.from(normalizedCities),
      totalListings,
    };
    if (asPublic) return stats;
    this._statsCache = stats;
    this._statsCacheTime = now;
    return this._statsCache;
  }

  // ─── Task lifecycle (A2A Gap 7 fix) ───────────────────────

  createTask(method: string, params: any, consumerAgentId?: string): any {
    const db = getDb();
    const id = uuid();
    const now = new Date().toISOString();

    db.prepare(`
      INSERT INTO tasks (id, consumer_agent_id, method, params, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'submitted', ?, ?)
    `).run(id, consumerAgentId || null, method, JSON.stringify(params), now, now);

    return { id, status: "submitted", method, createdAt: now };
  }

  updateTask(id: string, status: string, result?: any, error?: string): any {
    const db = getDb();
    db.prepare(`
      UPDATE tasks SET status = ?, result = ?, error = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(status, result ? JSON.stringify(result) : null, error || null, id);

    return this.getTask(id);
  }

  getTask(id: string): any {
    const db = getDb();
    const row = db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as any;
    if (!row) return null;
    return {
      id: row.id,
      consumerAgentId: row.consumer_agent_id,
      method: row.method,
      params: row.params ? JSON.parse(row.params) : null,
      status: row.status,
      result: row.result ? JSON.parse(row.result) : null,
      error: row.error,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  listTasks(consumerAgentId?: string, status?: string): any[] {
    const db = getDb();
    let sql = "SELECT * FROM tasks WHERE 1=1";
    const params: any[] = [];

    if (consumerAgentId) {
      sql += " AND consumer_agent_id = ?";
      params.push(consumerAgentId);
    }
    if (status) {
      sql += " AND status = ?";
      params.push(status);
    }
    sql += " ORDER BY created_at DESC LIMIT 100";

    const rows = db.prepare(sql).all(...params) as any[];
    return rows.map(r => ({
      id: r.id,
      method: r.method,
      status: r.status,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  }

  // ─── Listing CRUD ─────────────────────────────────────────

  addListing(agentId: string, listing: any): any {
    const db = getDb();
    const id = uuid();
    const agent = this.getAgent(agentId);

    db.prepare(`
      INSERT INTO listings (id, agent_id, product_name, category, description, quantity, unit, price_per_unit, currency, is_organic, image_url, expires_at, delivery_options, lat, lng)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, agentId,
      listing.productName, listing.category || null, listing.description || null,
      listing.quantity || null, listing.unit || null, listing.pricePerUnit || null,
      listing.currency || "NOK", listing.isOrganic ? 1 : 0, listing.imageUrl || null,
      listing.expiresAt || null, JSON.stringify(listing.deliveryOptions || []),
      listing.lat || agent?.location?.lat || null,
      listing.lng || agent?.location?.lng || null,
    );

    return { id, agentId, ...listing };
  }

  getListingsByAgent(agentId: string): any[] {
    const db = getDb();
    return db.prepare("SELECT * FROM listings WHERE agent_id = ? ORDER BY created_at DESC").all(agentId) as any[];
  }

  // ─── Check if agent exists by name (for idempotent seeding) ──

  getAgentByName(name: string): RegisteredAgent | undefined {
    const db = getDb();
    const row = db.prepare("SELECT * FROM agents WHERE name = ?").get(name) as any;
    return row ? this.rowToAgent(row) : undefined;
  }

  // ─── Private helpers ──────────────────────────────────────

  private generateApiKey(): string {
    return `lok_${crypto.randomBytes(32).toString("hex")}`;
  }

  // Public wrapper used by admin key-rotation endpoint
  public newApiKey(): string {
    return this.generateApiKey();
  }

  // Bumps discovery_count/times_discovered for the RETURNED results only, all
  // in one transaction (one fsync instead of three statements per agent).
  private incrementDiscovery(agentIds: string[]): void {
    if (agentIds.length === 0) return;
    try {
      const db = getDb();
      const bumpAgent = db.prepare("UPDATE agents SET discovery_count = discovery_count + 1 WHERE id = ?");
      // Also update agent_metrics for social proof
      const ensureMetrics = db.prepare("INSERT OR IGNORE INTO agent_metrics (agent_id) VALUES (?)");
      const bumpMetrics = db.prepare("UPDATE agent_metrics SET times_discovered = times_discovered + 1, updated_at = datetime('now') WHERE agent_id = ?");
      db.transaction((ids: string[]) => {
        for (const id of ids) {
          bumpAgent.run(id);
          ensureMetrics.run(id);
          bumpMetrics.run(id);
        }
      })(agentIds);
    } catch { /* non-critical */ }
  }

  // ─── Reputation Engine ──────────────────────────────────
  // Recalculates trust score based on real behavior, not just defaults.
  // Called after transactions complete.
  //
  // Formula:
  //   base: 0.5 (new agent)
  //   + 0.15 if verified
  //   + up to 0.15 from completion rate (times_chosen / times_contacted)
  //   + up to 0.10 from volume (capped at 50 transactions)
  //   + up to 0.10 from repeat buyers (loyalty signal)
  //
  // This means: an agent maxes at 1.0 only with verification +
  // high completion + volume + loyalty. Impossible to game.

  recalculateTrustScore(agentId: string): number {
    const db = getDb();
    const agent = db.prepare("SELECT is_verified FROM agents WHERE id = ?").get(agentId) as any;
    if (!agent) return 0.5;

    db.prepare("INSERT OR IGNORE INTO agent_metrics (agent_id) VALUES (?)").run(agentId);
    const m = db.prepare("SELECT * FROM agent_metrics WHERE agent_id = ?").get(agentId) as any;

    let score = 0.5; // base

    // Verification bonus
    if (agent.is_verified) score += 0.15;

    // Completion rate (contacted → chosen)
    if (m.times_contacted > 0) {
      const completionRate = Math.min(1, m.times_chosen / m.times_contacted);
      score += 0.15 * completionRate;
    }

    // Volume bonus (caps at 50 deals)
    const volumeScore = Math.min(1, (m.times_chosen || 0) / 50);
    score += 0.10 * volumeScore;

    // Loyalty bonus (repeat buyers are the ultimate trust signal)
    const loyaltyScore = Math.min(1, (m.repeat_buyer_count || 0) / 10);
    score += 0.10 * loyaltyScore;

    const finalScore = Math.min(1, Math.max(0, score));

    // Persist
    db.prepare("UPDATE agents SET trust_score = ? WHERE id = ?").run(finalScore, agentId);
    return finalScore;
  }

  private rowToAgent(row: any): RegisteredAgent | undefined {
    if (!row) return undefined;

    // Økologi S0 (A2A dev-request 2026-10-28-rfb-okologisk-merking-debio-
    // register-og-tekstrevisjon): without a valid Debio status (until S1:
    // debio_verified = 1) a producer's organic tags («organic», «økologisk»,
    // «debio» …, shared list in organic-claims.ts) are not part of the agent
    // any public reader sees — the /agents list, cards, MCP, A2A — and so the
    // «organic» tag family in discover() (tag filter + ranking) only matches
    // verified producers. Read-side only: agents.tags is unchanged.
    const organicAllowed = isDebioVerifiedValue(row.debio_verified);
    const rawTags = row.tags ? JSON.parse(row.tags) : [];
    const rawSkills = row.skills ? JSON.parse(row.skills) : [];

    return {
      id: row.id,
      name: row.name,
      description: row.description,
      provider: row.provider,
      contactEmail: row.contact_email,
      url: row.url,
      version: row.version || "1.0.0",
      role: row.role,
      apiKey: row.api_key,
      registeredAt: row.created_at,
      lastSeenAt: row.last_seen_at,
      isActive: row.is_active === 1,
      isVerified: row.is_verified === 1,
      // dev-request 2026-06-30-brreg-verification-gate, catalog-sweep + badge
      // slice — same mapping convention as isVerified above.
      brregVerified: row.brreg_verified === 1,
      trustScore: row.trust_score,
      totalInteractions: row.total_interactions || 0,
      discoveryCount: row.discovery_count || 0,
      interactionCount: row.interaction_count || 0,
      capabilities: row.capabilities ? JSON.parse(row.capabilities) : {},
      // Unverified: tags read as text entries (a non-list value is one entry or
      // none, like getAgentInfo's lists) and filtered; a skill's tags likewise.
      skills: organicAllowed ? rawSkills : (Array.isArray(rawSkills) ? rawSkills : []).map((sk: any) =>
        sk && typeof sk === "object" && sk.tags !== undefined ? { ...sk, tags: stripOrganicTags(textEntries(sk.tags)) } : sk),
      categories: row.categories ? JSON.parse(row.categories) : [],
      tags: organicAllowed ? rawTags : stripOrganicTags(textEntries(rawTags)),
      languages: row.languages ? JSON.parse(row.languages) : ["no"],
      location: row.lat != null && row.lng != null ? {
        lat: row.lat,
        lng: row.lng,
        // ── NO DEFAULT. Measured 2026-07-26: the `|| "Oslo"` that used to sit
        // at the end of this expression was announcing **455 of 1595 producers
        // (28,5 % of the catalogue)** as being in Oslo. Not approximately —
        // literally «Amundsen Bakeri — Kirkenes» rendered as Oslo, 2000 km out,
        // and «Lillehammer Bryggeri — Lillehammer» likewise.
        //
        // The geo_place_label fallback added in #370 was supposed to have
        // stopped this. It only covered the cohort the geocode worker resolved
        // through its place-name tier; every row resolved on a street address,
        // and every row never reached, still has NULL city and fell straight
        // through to the default. The fix was tested against the cohort it was
        // written for rather than against what a visitor sees.
        //
        // `undefined` is the honest answer when we do not know. Every consumer
        // already handles it — seo.ts's cardLocationText() falls back to `""`
        // and simply omits the line. An omitted city costs a visitor nothing;
        // a wrong one costs the producer their credibility and ours.
        city: row.city || row.geo_place_label || undefined,
        radiusKm: row.radius_km,
      } : undefined,
      // dev-request 2026-07-25 Fase 1: coordinate provenance, written by
      // services/agents-geocode-worker.ts. `?? null` (not `|| undefined`) so a
      // row from a DB that predates the migration and one the worker has not
      // reached yet are the same thing to the honesty rule: unknown.
      geoPrecision: row.geo_precision ?? null,
      geoPlaceLabel: row.geo_place_label ?? null,
    };
  }

  private calculateRelevance(
    agent: RegisteredAgent,
    query: DiscoveryQuery,
    productTerms?: string[],
    productMatchMap?: Map<string, string[]>,
  ): { score: number; reasons: string[] } {
    let score = 0;
    const reasons: string[] = [];

    // Category match (base relevance)
    if (query.categories && query.categories.length > 0) {
      const matches = query.categories.filter(cat =>
        agent.categories.some(ac => categoryValueMatches(ac, cat))
      );
      if (matches.length > 0) {
        score += 0.25 * (matches.length / query.categories.length);
        reasons.push(`Kategorier: ${matches.join(", ")}`);
      }
    } else {
      score += 0.1;
    }

    // Product-level match bonus — agents carrying the exact product rank much higher.
    // "tomat" → tomato sellers first, not just any vegetable shop.
    if (productTerms && productTerms.length > 0 && productMatchMap) {
      const matchedProducts = productMatchMap.get(agent.id);
      if (matchedProducts && matchedProducts.length > 0) {
        const productScore = Math.min(1, matchedProducts.length / productTerms.length);
        score += 0.25 * productScore;
        reasons.push(`Produkter: ${matchedProducts.slice(0, 3).join(", ")}`);
      }
    }

    // Tag match
    if (query.tags && query.tags.length > 0) {
      const matches = query.tags.filter(tag =>
        agent.tags.some(at => at.toLowerCase().includes(tag.toLowerCase()))
      );
      if (matches.length > 0) {
        score += 0.15 * (matches.length / query.tags.length);
        reasons.push(`Tags: ${matches.join(", ")}`);
      }
    }

    // Skills match
    if (query.skills && query.skills.length > 0) {
      const matches = query.skills.filter(skillId =>
        agent.skills.some(s => s.id === skillId || s.tags.some(t => t.includes(skillId)))
      );
      if (matches.length > 0) {
        score += 0.1 * (matches.length / query.skills.length);
        reasons.push(`Skills: ${matches.join(", ")}`);
      }
    }

    // Geo proximity — closer agents rank higher
    if (query.location && agent.location) {
      const dist = haversine(
        query.location.lat, query.location.lng,
        agent.location.lat, agent.location.lng
      );
      const maxDist = query.maxDistanceKm || 20;
      const distScore = Math.max(0, 1 - dist / maxDist);
      score += 0.15 * distScore;
      // REVIEW B1 (Fase 1c): matchReasons is a SECOND distance surface and it
      // was not gated. `matchReasons` is spread verbatim into the
      // /api/marketplace/search JSON (routes/marketplace.ts) and rendered as
      // the «Match:» line by the Smithery-published stdio MCP server
      // (src/mcp/server.ts) — so a city-centroid producer was still telling an
      // AI assistant «1.1 km unna» while location.distanceKm was correctly
      // withheld. Same gate as resultLocation(): only address precision may
      // state a number; a centroid says where it is instead.
      // The SCORE above is deliberately untouched — a centroid is still the
      // best position estimate we have for ranking. This governs what we say.
      if (dist < 5) {
        const precision = agent.geoPrecision ?? null;
        reasons.push(
          shouldSuppressDistance(precision)
            ? (formatRfbDistanceLabel(dist, precision, agent.location.city)
               ?? "i nærheten (omtrentlig posisjon)")
            : `${dist.toFixed(1)} km unna`
        );
      }
    }

    score += 0.05 * agent.trustScore;

    if (agent.isVerified) {
      score += 0.05;
      reasons.push("Verifisert av eier");
    }

    return { score: Math.min(1, score), reasons };
  }
}

// ─── Agent slug aliases (dev-request 2026-09-03-rfb-korrigering-navn-sted-
// kategorier, Mål 1 — slug-alias/301 ved navnebytte) ───────────────────────
// Slug is not a persisted column — it is recomputed from `name` on every
// /produsent/:slug lookup (getAgentBySlugIncludingUmbrellas above), so a
// rename kills the old URL immediately and silently. This table records the
// abandoned slug so the old URL can 301 forward instead of 404ing.
//
// Lazy DDL, same pattern as ensureRfbWebsiteReviewQueueTable
// (routes/admin-rfb-website-discovery.ts): created at point of use, not
// wired into database/init.ts's startup migration.
//
// old_slug is the PRIMARY KEY (not composite with agent_id): a historical
// slug is globally unique in the URL namespace regardless of which agent
// last owned it — INSERT OR REPLACE on collision (the same slug abandoned
// by two different agents over time) lets the most recently abandoned
// ownership win, consistent with the redirect's purpose ("help the most
// recent link"), not a full historical archive.
export function ensureAgentSlugAliasesTable(db: ReturnType<typeof getDb>): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_slug_aliases (
      old_slug TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
    )
  `);
}

// Small exported helper — called both internally by updateAgent() above
// (best-effort, on a rename that actually changes the computed slug) and by
// POST /admin/agents/:id/slug-alias (routes/admin-agents.ts, the one-shot
// manual-backfill tool for renames that happened before this slice
// shipped). No duplicated SQL between the two call sites.
//
// PR #800 review finding 1 (alias-hijack via self-service rename): `old_slug`
// is a global PRIMARY KEY, and this used to be an unconditional
// INSERT OR REPLACE — so ANY caller writing to ANY old_slug silently stole
// that row from whichever agent currently owned it. Proven exploit: an
// ordinary producer's own self-service PUT /api/marketplace/agents/:id
// rename (gated only by their own API key) reaches updateAgent()'s automatic
// hook, which called this with no ownership check at all. Renaming
// TO another producer's already-abandoned old slug and then immediately
// away again overwrote that row to point at the attacker, silently
// hijacking the abandoning producer's historical URL.
//
// `allowOverwrite` (default false) is the fix: the automatic rename hook
// (updateAgent()) leaves it at the default and MUST NOT clobber a row that
// already belongs to a different agent_id — it just logs and skips, because
// this is best-effort and must never block the rename itself. Only the
// deliberate, human-operated admin backfill route (POST
// /admin/agents/:id/slug-alias) passes `{ allowOverwrite: true }`, because an
// operator correcting history SHOULD be able to overwrite.
export function insertAgentSlugAlias(
  agentId: string,
  oldSlug: string,
  opts?: { allowOverwrite?: boolean },
): void {
  const db = getDb();
  ensureAgentSlugAliasesTable(db);

  if (opts?.allowOverwrite) {
    db.prepare(
      "INSERT OR REPLACE INTO agent_slug_aliases (old_slug, agent_id) VALUES (?, ?)"
    ).run(oldSlug, agentId);
    return;
  }

  const existing = db
    .prepare("SELECT agent_id FROM agent_slug_aliases WHERE old_slug = ?")
    .get(oldSlug) as { agent_id: string } | undefined;

  if (existing && existing.agent_id !== agentId) {
    console.warn(
      `[marketplace-registry] slug-alias collision: old_slug "${oldSlug}" already claimed by agent ${existing.agent_id}, refusing to overwrite for renaming agent ${agentId}`,
    );
    return;
  }

  // No existing row, or the same agent re-claiming/re-abandoning the same
  // slug (idempotent, harmless) — INSERT OR REPLACE is safe here since it's
  // the same owner either way.
  db.prepare(
    "INSERT OR REPLACE INTO agent_slug_aliases (old_slug, agent_id) VALUES (?, ?)"
  ).run(oldSlug, agentId);
}

// ─── Haversine distance ──────────────────────────────────────

// ─── Proximity intent («nær meg») ─────────────────────────────
// dev-request 2026-07-25-reisesok-korridor-discovery-og-naerhetssok, fix 0e.
// Exported so both the REST route, /sok and the MCP tools classify the same
// strings identically. Matches "near ME" phrasings only — never the bare
// preposition in «honning nær Oslo», which resolves to a real place and must
// keep doing so.
const PROXIMITY_PATTERNS: RegExp[] = [
  /\bn(æ|ae)r(me|meste)?\s+(meg|oss|her)\b/,        // nær meg / nærmeste oss / nærme her
  /\bi\s+n(æ|ae)rheten\b/,                           // i nærheten (av meg)
  /\bn(æ|ae)rheten\s+av\s+meg\b/,
  /\brundt\s+meg\b/,
  /\bher\s+jeg\s+er\b/,
  // «nærmeste …» always asks for proximity. Safe to match broadly: the route
  // only turns this into needs_location when no place could be resolved, so
  // «nærmeste bakeri i Oslo» still just searches Oslo.
  /\bn(æ|ae)rmeste\b/,
  /\bnear\s+(me|here|by)\b/,
  /\bnearby\b/,
  /\bclose\s+to\s+me\b/,
  /\baround\s+me\b/,
  /\bmy\s+location\b/,
];

// ── Fase 5 drink taxonomy (dev-request 2026-07-25-reisesok…, 5a/5b) ──
// Exported so the corridor engine, the /reise filters and any future MCP enum
// read the SAME list rather than drifting copies.
export const DRINK_KEYWORDS = [
  "drikke", "drikkevarer", "drikkested", "drikkesteder", "beverages", "drinks",
  "øl", "ale", "pils", "brygg", "bryggeri", "mikrobryggeri", "håndverksøl",
  "sider", "cider", "cideri", "eplesider",
  "vin", "vingård", "vinproduksjon", "musserende",
  "destilleri", "brenneri", "gårdsbrenneri", "akevitt", "gin", "whisky",
  "mjød", "mjøderi",
  "most", "eplemost", "saft", "juice", "eplejuice",
  "kombucha", "seltzer", "seltzeri",
  "kaffe", "kaffebrenneri", "gårdskafé", "gardskafe", "gårdskafe",
  // Te (dev-request 2026-09-19-rfb-mcp-te-drikkekategori): confirmed live —
  // `te`/`tea`/`urtete`/`herbal tea` all resolved `categories: null` and fell
  // back to the nationwide trust-ranked list, surfacing Homme Gård
  // (categories: fruit, eggs — no beverages, no herbs) at the top for a tea
  // search. `te` was simply never in this list, in either language, exactly
  // the same class of gap `øl`/`drikke` had before Fase 5a/5b. Routed to
  // `beverages` (not `herbs`): tea is a drink a producer SELLS, and
  // `beverages` is the category the hard filter already uses for every other
  // drink word here — `herbs` is for herb/spice PLANTS (urter, krydder,
  // dill…), a different, unrelated producer category.
  //
  // `tea`/`herbal tea` are added directly here (the English path), NOT via
  // product-glossary.ts's reverse index: PRODUCT_WORDS["te"] is deliberately
  // excluded from that index by AMBIGUOUS_EN (added 2026-09-05, guards
  // against English filler words being mistaken for short Norwegian food
  // words — the same class of false-friend guard as the «and»/duck case
  // documented above). Reusing that path for `te` would mean touching
  // AMBIGUOUS_EN's protection to unblock one specific entry, for no gain:
  // `q` (the raw, lower-cased query) already reaches this same keyword list
  // directly, so an English "tea"/"herbal tea" query matches here with zero
  // glossary involvement — no risk to the guard the exhaustive reverse-index
  // collision test (marketplace-search-english-queries.test.ts, section C3)
  // already covers. This mirrors how `beverages`/`drinks`/`ale`/`cider`/
  // `gin`/`whisky`/`juice` above are already bare English words sitting
  // directly in this Norwegian-labelled list.
  //
  // Word-boundary safety (the exact trap `øl` hit — see REVIEW N2 above):
  // `te` is a 2-letter substring of many unrelated Norwegian words
  // («Potet», «Vinterepler», «Spekemat» all contain "te"). It is protected
  // the same way `øl` is: (1) matched via norwegianWordBoundary(), not a
  // bare substring, so it only fires on the standalone word (verified:
  // "potet"/"vinterepler"/"spekemat" contain "te" only with a WORD
  // character on both sides, so the boundary never matches); and (2)
  // included in PRODUCT_TERM_EXCLUSIONS via the `...DRINK_KEYWORDS` spread
  // below, so `te` can never become a `_productTerms` entry and is never
  // tested as a NAME substring at all (the mechanism that let old `øl` match
  // "Pølser").
  "te", "urtete", "tea", "herbal tea",
];

// ── Product → category keywords ──────────────────────────────────────
// parseNaturalQuery's categoryMap: each keyword names a category and is a
// product search term. Integration test 2026-10-17, slice I-V: hoisted out of
// the method, unchanged, so the offers (catalog-offers.ts) tell a short
// term's own category by the same words. Declared after DRINK_KEYWORDS, which
// it reads.
// Slice I-W: a key is the category the platform stores in agents.categories
// (search-enrich.ts PLATFORM_CATEGORIES); a test pins it. The baked-goods key
// was «bread», which the enrichment never writes, so «brød», «bakervarer» and
// «bakeri» left out the 287 producers that only have «bakery» (live
// 2026-10-17). The one key the platform has no category of its own for is
// «berries» (sold under fruit): 27 producers carry it, and a «bær» search
// finds exactly those.
export const PRODUCT_CATEGORY_KEYWORDS: Record<string, string[]> = {
  "vegetables": [
    "grønnsaker", "grønt", "vegetables", "poteter", "potet", "gulrøtter", "gulrot",
    "løk", "kål", "tomat", "tomater", "agurk", "brokkoli", "blomkål", "squash",
    "paprika", "selleri", "purre", "spinat", "salat", "reddik", "gresskar",
    "mais", "erter", "bønner", "rødbeter", "nepe", "pastinakk",
  ],
  "fruit": [
    "frukt", "fruit", "epler", "eple", "pærer", "pære", "plommer", "plomme",
    "kirsebær", "moreller", "rips", "stikkelsbær", "druer",
  ],
  "berries": [
    "bær", "berries", "jordbær", "blåbær", "bringebær", "tyttebær",
    "solbær", "multe", "multer", "markjordbær",
  ],
  "dairy": [
    "meieri", "dairy", "melk", "ost", "smør", "yoghurt", "fløte", "rømme",
    "brunost", "hvitost", "geitost", "pultost", "gamalost", "smøreost",
  ],
  "eggs": ["egg", "eggs", "frittgående", "økologiske egg"],
  "meat": [
    "kjøtt", "meat", "lam", "lammekjøtt", "svin", "svinekjøtt", "storfe",
    "storfekjøtt", "kylling", "and", "vilt", "elg", "hjort", "rein",
    "reinsdyr", "pølser", "spekemat", "fenalår", "ribbe", "pinnekjøtt",
    // ChatGPT app re-review 2026-10-03: compounds are matched as whole
    // words, so «reinsdyrkjøtt Finnmark» found neither «rein» nor
    // «kjøtt» and fell back to every producer in Finnmark (a brewery and
    // a bakery first).
    "reinsdyrkjøtt", "reinkjøtt", "elgkjøtt", "hjortekjøtt", "viltkjøtt",
  ],
  "fish": [
    "fisk", "fish", "sjømat", "laks", "torsk", "reker", "krabbe", "blåskjell",
    "ørret", "røye", "sei", "hyse", "kveite", "steinbit", "tørrfisk",
    "klippfisk", "lutefisk", "rakfisk", "gravlaks",
  ],
  "bakery": [
    "brød", "bread", "bakervarer", "lefse", "flatbrød", "rundstykker",
    "boller", "kanelboller", "surdeig", "grovbrød",
    // dev-request 2026-09-05-rfb-mcp-engelsk-sok-kategorifeil: «bakeri» —
    // the single most obvious word for this category, and a producer-name
    // indicator since day one — was in no keyword list, so neither
    // «bakeri Trondheim» nor "bakery in Trondheim" selected a category.
    // Norwegian was broken here too; this is not an English-only gap.
    "bakeri", "bakeriet", "bakevarer", "bakst",
    // Slice I-W2 (S4): the English plural; the glossary only knows «bakery»
    // and «bakerys», so "Which bakeries make kransekake" had no category.
    "bakeries",
  ],
  "honey": ["honning", "honey", "birøkt"],
  "herbs": ["urter", "herbs", "krydder", "dill", "persille", "basilikum", "timian"],
  // ── Drikke (dev-request 2026-07-25-reisesok…, Fase 5a/5b) ──────────
  // Daniel asked for this repeatedly: «Jeg ønsker også at søkefunksjon
  // skal være inne på "drikkesteder"».
  //
  // `beverages` is not a new category — it is already the 8th-largest tag
  // in the live catalogue (review N7 corrects an earlier "third-largest"
  // overclaim). Full census 2026-07-25, all 1 523 production producers
  // enumerated: `beverages` 65 rows, and 133 producers carry some
  // drink-family category (`beverages` / `beer` / `sider` / `juice` /
  // `coffee`) — Atlungstad Brenneri, Trysil Bryggeri, Senja Handbryggeri,
  // Bent Gate Brewing, … It had simply never been reachable: this map had
  // ten food categories and no drink one, so
  // `øl`, `sider`, `drikke` and `brygg` produced NO category at all and
  // fell through to a nationwide trust-ranked list. Verified live before
  // this change: `q=øl` and `q=drikke` both returned `categories: null`
  // and answered with Kringler Gjestegård / Homme Gård — neither of which
  // sells drink. `bryggeri`/`sider`/`vin`/`brenneri` appeared to work only
  // by accident, via the NAME branch matching producers with the word in
  // their name; a `beverages` producer without it was unfindable.
  //
  // The stray one-off values the catalogue also carries (`beer`, `sider`,
  // `juice`, `coffee`, 1 row each) are deliberately NOT added as separate
  // categories — they are data noise, and normalising them is a data job,
  // not a parser job. The keywords below route to `beverages`, and
  // route-corridor-service.ts's DRINK_CATEGORIES treats the strays as
  // drink too so a corridor search still finds them.
  "beverages": DRINK_KEYWORDS,
};

// Keywords that identify a CATEGORY but must never be searched as a product
// name. The first group is the pre-existing list (category words like
// «grønnsaker» are not products); the second is every drink keyword — see
// REVIEW N2 at the push site for the measured false positives.
const PRODUCT_TERM_EXCLUSIONS = new Set<string>([
  "grønnsaker", "grønt", "vegetables", "frukt", "fruit", "bær", "berries",
  "meieri", "dairy", "kjøtt", "meat", "fisk", "fish", "sjømat", "brød", "bread",
  "bakervarer", "urter", "herbs", "egg", "eggs",
  // Slice I-W2: no product name holds it; as a product term it would also keep
  // the words next to it from ranking the bakeries (discover() step 3c)
  "bakeries",
  ...DRINK_KEYWORDS,
]);

/**
 * Slice I-W3: product terms that name the kind of producer, not a product.
 * In the live catalogue (2026-10-17) «bakeri» is only in six product names
 * that say where the bread is baked («Brød og boller fra eget bakeri»). Next
 * to a word the parser cannot read («Finnes det noen bakeri som lager
 * kransekake») they give way to it (parseNaturalQuery), so that word ranks
 * the bakeries, as for «bakeries». Alone («bakeri i Bergen») they stay
 * product terms, as before.
 */
const PRODUCER_KIND_TERMS: ReadonlySet<string> = new Set(["bakeri", "bakeriet"]);

// ── Category keys the platform has replaced (slice I-W) ─────────────────
// A replaced key, to the key the platform stores now. 41 live producers still
// carry «bread» from the first seeds (2026-10-17), and lokal_discover's frozen
// description lists «bread», so a search for either key finds both.
const REPLACED_CATEGORY_KEYS: Readonly<Record<string, string>> = { bread: "bakery" };

function categoryKey(value: string): string {
  const k = value.trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(REPLACED_CATEGORY_KEYS, k) ? REPLACED_CATEGORY_KEYS[k] : k;
}

/** True when two category values are the same key, a replaced key counting as its successor («bread» = «bakery»). */
export function sameCategoryKey(a: string, b: string): boolean {
  return categoryKey(a) === categoryKey(b);
}

/**
 * True when a producer's stored category value counts for a searched one:
 * it contains the searched value, as discover() has always compared, or it
 * is the same key (sameCategoryKey).
 */
export function categoryValueMatches(stored: string, searched: string): boolean {
  return stored.toLowerCase().includes(searched.toLowerCase()) || sameCategoryKey(stored, searched);
}

// ── Norwegian-aware word boundary ────────────────────────────────────
// dev-request 2026-07-25-reisesok…, Fase 5b.
//
// JavaScript's `\b` is defined against `\w` = [A-Za-z0-9_] — ASCII only. æ, ø
// and å are therefore NON-word characters to it, which breaks the category
// matcher in both directions:
//
//   FALSE NEGATIVE  /\bøl\b/.test("øl") === false. Start-of-string and «ø» are
//                   both "non-word", so there is no transition and no boundary.
//                   Every keyword beginning with æ/ø/å was dead code — that is
//                   «øl», the single most-requested term in this dev-request,
//                   and «økologiske egg», which has never matched since it was
//                   added.
//   FALSE POSITIVE  /\bost\b/.test("Tromsøost") === true. The «ø» before «ost»
//                   reads as a word→non-word boundary, so a place name splices
//                   into a product keyword. The existing comment claimed \b
//                   prevented exactly this class of bug; for ASCII neighbours
//                   ("geitost") it did, for Norwegian ones it did the opposite.
//
// Fix: assert on explicit character classes that include Latin-1 letters, so a
// letter is a letter regardless of alphabet. Verified against the cases the old
// comment called out — "geitost" and "Tromsø kosten" still do NOT match `ost`,
// "Bryggerøl" and "øltønne" do NOT match `øl`, and "øl og vin" does.
//
// Deliberately not `\p{L}` with the /u flag: that would also treat digits and
// underscore differently from the ASCII class and change behaviour for the
// ~120 pre-existing keywords in ways nobody asked for. This class is the
// minimal superset that fixes Norwegian.
const NORWEGIAN_WORD_CHAR = "0-9A-Za-zÀ-ÖØ-öø-ÿ_";
// ─── Place names that must never drive a producer NAME search ─────────────
// PR-72 introduced this list but scoped it to parseNaturalQuery's Pass 2. The
// indicator branch (Pass 1, "…farm in Vestfold…") and discover()'s relaxed
// fuzzy fallback never saw it, so a place name kept leaking in as a name
// token. Measured live 2026-09-05: `Find a farm in Vestfold with raw honey`
// returned eight producers whose only common trait was the word "Vestfold" in
// their NAME — a deer farm, a bakery, a fruit farm — while the two real honey
// producers `honning Vestfold` finds (TønsbergBier, Sætrehonning) never
// appeared. The name branch returns early and skips the category filter
// entirely, so this silently outranks a correctly detected category.
// dev-request 2026-09-05-rfb-mcp-engelsk-sok-kategorifeil.
//
// Integration test 2026-10-17, slice I-W: a word is a place word when the
// shared gazetteer (search-intent/norwegian-query.ts, which the dental search
// reads too) has it: every poststed in the bundled postnummer register, every
// kommune, region and fylke (isPlaceWord). The list had 30 cities and the
// fylker, so «bærum» was no place word and «kransekake i Bærum» became a name
// search for the producers with «Bærum» in their name. A query's multi-word
// places («Møre og Romsdal», «Mo i Rana») are found as phrases (placeWordsIn).
// The list itself stays for the name passes (NAME_PASS_PLACE_WORDS).

/**
 * The words of a name query that discover()'s fuzzy name match leaves out:
 * food categories that often appear in producer names but are not
 * distinctive enough to fuzzy-match on alone. parseNaturalQuery reads them
 * too (slice I-W3), to tell whether a name query names any producer.
 */
const GENERIC_NAME_TOKENS: ReadonlySet<string> = new Set([
  "mat", "sjømat", "kjøtt", "fisk", "bakeri", "bryggeri", "ysteri",
  "meieri", "marked", "butikk", "gård", "gard", "farm", "kooperativ",
  "slakteri", "gardsmat", "gardsutsalg", "frukt", "bær", "honning",
  "egg", "melk", "ost", "brød", "korn", "grønt", "grønnsaker",
  "lokalmat", "økologisk", "tradisjon", "tradisjons",
]);

/**
 * The old list, now for the name passes only: Pass 0 and Pass 1 of
 * parseNaturalQuery and discover()'s fuzzy name match leave these big places
 * out of a producer-name lookup, as before («Mat i Bergen», «Tromsø Bakeri»,
 * «a farm in Vestfold»). Every other place can be part of a producer's name
 * («Valen Gård», «Dyrøy Sjømat» for «Dyrøymat»), so those passes keep it;
 * where it would only turn a product search into a name search (Pass 2,
 * «kransekake i Bærum»), the gazetteer decides (isPlaceWord). With every
 * gazetteer place in the name passes, 76 of 1 537 live producer names no
 * longer found their producer (2026-10-17; «Valen Gård» became the name
 * query «Gård»). A test pins that each word is a place word.
 */
const NAME_PASS_PLACE_WORDS: ReadonlySet<string> = new Set([
  // Top-30 cities (mirrors geocoding-service.ts MAJOR_CITIES)
  "oslo", "bergen", "trondheim", "stavanger", "tromsø", "tromso",
  "kristiansand", "drammen", "fredrikstad", "bodø", "bodo",
  "ålesund", "alesund", "tønsberg", "tonsberg", "haugesund",
  "sandnes", "lillestrøm", "lillestrom", "hamar", "lillehammer",
  "sandefjord", "sarpsborg", "skien", "molde", "moss", "asker",
  "kongsberg", "porsgrunn", "arendal", "larvik", "halden",
  // Common region/fylke names
  "vestland", "viken", "rogaland", "trøndelag", "trondelag",
  "nordland", "innlandet", "troms", "finnmark", "agder", "vestfold",
  "telemark", "østfold", "ostfold", "akershus", "buskerud", "oppland",
  "hedmark", "sogn", "fjordane", "møre", "more", "romsdal",
  // Common Oslo districts / neighborhoods
  "grünerløkka", "grunerlokka", "frogner", "majorstuen", "sentrum",
]);

/**
 * Words the gazetteer has no place of their own for, plus the country: Oslo
 * neighbourhoods, «sentrum», the halves of the two-word fylke names written
 * alone, and «Norge».
 */
const PLACE_WORDS_OUTSIDE_GAZETTEER: ReadonlySet<string> = new Set([
  "grünerløkka", "grunerlokka", "majorstuen", "sentrum",
  "sogn", "fjordane", "møre", "more",
  "norge", "noreg", "norway",
]);

let placeGazetteerCache: PlaceGazetteer | null = null;

/** The gazetteer over the official poststeder, built on first use (static data, read once). */
function rfbPlaceGazetteer(): PlaceGazetteer {
  return (placeGazetteerCache ??= buildNorwegianGazetteer(officialPoststedFylker().keys()));
}

/** True when the gazetteer has the lower-case word `w` as a poststed, kommune, region or fylke. */
function inPlaceGazetteer(w: string): boolean {
  const k = placeKey(w);
  if (!k) return false;
  const g = rfbPlaceGazetteer();
  return g.poststeder.has(k) || g.kommuner.has(k) || g.regioner.has(k) || g.fylker.has(k);
}

/**
 * True when one word, in any case or spelling the gazetteer folds («Bærum»,
 * «baerum», «Aurskog-Høland»), is a poststed, kommune, region or fylke, or one
 * of PLACE_WORDS_OUTSIDE_GAZETTEER.
 * Slice I-W4: a filler word (search-intent/rfb-filler-words.ts) is none on its
 * own, though the gazetteer has «nå», «time» and «feiring»; placeWordsIn()
 * reads one as a place where the search says so («i Time», «Time» alone).
 * «more» stays one, as a word of PLACE_WORDS_OUTSIDE_GAZETTEER.
 */
export function isPlaceWord(word: string): boolean {
  const w = String(word ?? "").trim().toLowerCase();
  if (!w) return false;
  if (PLACE_WORDS_OUTSIDE_GAZETTEER.has(w)) return true;
  return !FILLER_WORDS.has(w) && inPlaceGazetteer(w);
}

/**
 * The words of `query` (lower case, as tokenize() splits them) that are
 * place words: each word isPlaceWord accepts, and every word of a multi-word
 * place in the query («møre», «og», «romsdal» in «honning i Møre og Romsdal»).
 * Slice I-W4: a filler word the gazetteer has is a place word only right after
 * a place preposition or as the whole search (isFillerNoPlaceAt), so «Hvem
 * selger kransekake nå» names no place and «kransekake i Time» does. A phrase
 * of filler words only is none (the gazetteer has no such phrase today).
 */
export function placeWordsIn(query: string): Set<string> {
  const tokens = tokenize(query);
  const out = new Set(tokens.filter((t, i) => isPlaceWord(t) || (!isFillerNoPlaceAt(tokens, i) && inPlaceGazetteer(t))));
  for (const m of detectPlaces(tokens, rfbPlaceGazetteer(), { notAlone: FILLER_WORDS })) {
    for (const t of tokens.slice(m.start, m.start + m.length)) out.add(t);
  }
  return out;
}

/** The words of `query` (as tokenize() splits them) that belong to a place of two or more words in it («mo», «i», «rana»). */
function multiWordPlaceWordsIn(query: string): Set<string> {
  const tokens = tokenize(query);
  const out = new Set<string>();
  for (const m of detectPlaces(tokens, rfbPlaceGazetteer(), { notAlone: FILLER_WORDS })) {
    if (m.length > 1) for (const t of tokens.slice(m.start, m.start + m.length)) out.add(t);
  }
  return out;
}

/** A place-word test for the words of one query: its multi-word places, and any single place word. */
function placeWordTest(query: string): (word: string) => boolean {
  const inQuery = placeWordsIn(query);
  return (word) => inQuery.has(word) || isPlaceWord(word);
}

// English filler words a reviewer types around the food word ("Show me
// producers near Bergen that SELL cheese", "FIND a farm WITH raw honey").
// They are not Norwegian, so they passed every skip-word test and became
// "distinctive" name tokens. Norwegian equivalents are in skipWords already.
const ENGLISH_SKIP_WORDS = [
  "find", "show", "me", "my", "get", "give", "list", "search", "looking",
  "look", "want", "need", "buy", "order", "sell", "sells", "selling", "sale",
  "the", "that", "this", "these", "those", "with", "without", "from", "for",
  "near", "nearby", "closest", "close", "around", "any", "some", "all",
  "please", "can", "you", "who", "what", "where", "which", "how", "does",
  "are", "there", "have", "has", "and", "or", "of", "in", "on", "at", "to",
  "producer", "producers", "farm", "farms", "farmer", "farmers", "shop",
  "shops", "store", "stores", "local", "raw", "fresh", "good", "best",
];

/** Words that make up a producer name without identifying one ("Lokal Honning"). */
const GENERIC_NAME_WORDS = new Set([
  "mat", "sjømat", "kjøtt", "fisk", "bakeri", "bryggeri", "ysteri", "meieri", "marked",
  "butikk", "gård", "gard", "gården", "farm", "kooperativ", "slakteri", "gardsmat",
  "gardsutsalg", "gårdsutsalg", "gårdsbutikk", "frukt", "bær", "honning", "egg", "melk",
  "ost", "brød", "korn", "grønt", "grønnsaker", "lokalmat", "lokal", "økologisk", "as", "sa",
  "og", "the",
  // definite forms and drink-venue kinds ("Gardsutsalget", "Hardanger Cideri")
  "gardsutsalget", "gårdsutsalget", "gårdsbutikken", "gardsbutikken", "bakeriet", "bryggeriet",
  "meieriet", "ysteriet", "slakteriet", "markedet", "cideri", "sideri", "brenneri",
  "destilleri", "vingård", "vingard", "mjøderi", "brygg", "handbryggeri",
  // regions that lead many producer names ("Lofoten Bakeri") — a query naming
  // the region and the kind is a category search, not a lookup of that one name
  "lofoten", "vesterålen", "hardanger", "valdres", "senja", "jæren", "toten", "setesdal",
  "helgeland", "hadeland", "romerike", "voss", "røros", "sunnmøre", "nordmøre",
  "gudbrandsdalen", "inderøy", "sogn",
]);

// ── Words the parser could not read (slice I-W) ─────────────────────────

// NO_PRODUCT_WORDS and QUALIFIER_WORDS moved, unchanged, to
// search-intent/rfb-filler-words.ts (slice I-W4), so the geocoder reads the
// same lists as this parser; imported above.

/** At most this many words of one query are looked up in the catalog. */
const UNKNOWN_TERMS_MAX = 4;

/**
 * The words of the lower-cased query `q` that `isKnown` does not explain and
 * that are no generic name, shared stopword (QUERY_STOPWORDS) or
 * NO_PRODUCT_WORDS word: letters (or a mix with digits), three or more, in
 * query order, once each, at most UNKNOWN_TERMS_MAX. Slice I-W2: a
 * QUALIFIER_WORDS word only when there is no other such word and
 * `qualifiersAlone` (the search has no category word either). Both lists
 * stop at UNKNOWN_TERMS_MAX and each distinct word is weighed once, so a
 * long search costs no more than in I-W.
 */
function unknownProductWords(q: string, isKnown: (w: string) => boolean, qualifiersAlone: boolean): string[] {
  const words: string[] = [];
  const qualifiers: string[] = [];
  const seen = new Set<string>();
  for (const w of q.split(/[^\p{L}\p{N}]+/u)) {
    if (w.length < 3 || seen.has(w) || /^\p{N}+$/u.test(w)) continue;
    seen.add(w);
    if (isKnown(w) || GENERIC_NAME_WORDS.has(w) || QUERY_STOPWORDS.has(w) || NO_PRODUCT_WORDS.has(w)) continue;
    if (!QUALIFIER_WORDS.has(w)) {
      words.push(w);
      if (words.length === UNKNOWN_TERMS_MAX) break;
    } else if (qualifiers.length < UNKNOWN_TERMS_MAX) {
      qualifiers.push(w);
    }
  }
  return words.length > 0 ? words : qualifiersAlone ? qualifiers : [];
}

/** How a producer's catalog answers the words of discover() step 3c. */
interface CatalogTermMatch {
  /** The names of the matching products, best match first, then by name (nb). */
  names: string[];
  /** True when a matching row is a product, not only a category label (utils/category-label.ts). */
  listed: boolean;
  /** How many of the words one of its products matches. */
  terms: number;
  /** The best match among its products (utils/product-name-match.ts). */
  best: ProductNameMatch;
}

/** Slice I-W2: a producer whose catalog matches none of the words (next to a category word it stays). */
const NO_TERM_MATCH: CatalogTermMatch = { names: [], listed: false, terms: 0, best: 0 };

/**
 * The producers among `agentIds` with a product whose name matches one of
 * `terms`: in the catalog the offers read (`products`, which
 * product-catalog-sync.ts fills from the product lists) and by the offers'
 * word rule (productNameMatch, catalog-offers.ts findOffers): the word starts
 * a word of the name, or ends one when it has four letters or more. The
 * words name no category, so the category exception for a shorter word never
 * applies. The LIKE only pre-filters, with the first letter also upper-cased,
 * as in findOffers (SQLite's LOWER() folds ASCII only). A category label row
 * («Syltetøy» without a price) matches too, but does not make the producer
 * `listed`. Null when the catalog cannot be read; discover() then leaves the
 * words alone.
 */
function catalogTermMatches(
  db: ReturnType<typeof getDb>,
  terms: readonly string[],
  agentIds: ReadonlySet<string>,
): Map<string, CatalogTermMatch> | null {
  const patterns = terms.flatMap((t) => [`%${escapeLike(t)}%`, `%${escapeLike(t.charAt(0).toUpperCase() + t.slice(1))}%`]);
  type Row = { agent_id: string; name: unknown; price_nok: number | null; availability_source: string | null };
  let rows: Row[];
  try {
    rows = db.prepare(
      "SELECT agent_id, name, price_nok, availability_source FROM products WHERE " +
      patterns.map(() => "LOWER(name) LIKE ? ESCAPE '\\'").join(" OR "),
    ).all(...patterns) as Row[];
  } catch {
    return null;
  }
  type Entry = { names: Map<string, { name: string; match: ProductNameMatch }>; listed: boolean; terms: Set<string> };
  const byAgent = new Map<string, Entry>();
  for (const r of rows) {
    if (!agentIds.has(r.agent_id) || typeof r.name !== "string") continue;
    const name = r.name.trim();
    for (const t of terms) {
      const match = productNameMatch(name, t);
      if (!match) continue;
      const entry = byAgent.get(r.agent_id) ?? { names: new Map(), listed: false, terms: new Set<string>() };
      entry.terms.add(t);
      if (!entry.listed) {
        entry.listed = !isCategoryLabel({ name, hasPrice: r.price_nok != null, availabilitySource: r.availability_source });
      }
      const key = name.toLowerCase();
      const prev = entry.names.get(key);
      if (!prev || match > prev.match) entry.names.set(key, { name, match });
      byAgent.set(r.agent_id, entry);
    }
  }
  const out = new Map<string, CatalogTermMatch>();
  for (const [agentId, { names, listed, terms: matched }] of byAgent) {
    const sorted = [...names.values()].sort((a, b) => b.match - a.match || a.name.localeCompare(b.name, "nb"));
    out.set(agentId, { names: sorted.map((n) => n.name), listed, terms: matched.size, best: sorted[0].match });
  }
  return out;
}

/**
 * Fold a name or query for spelling-tolerant comparison: lower case,
 * å/aa→a, ø→o, æ→ae, accents stripped, everything that is not a letter or
 * digit collapsed to single spaces.
 */
export function foldProducerName(s: string): string {
  return ` ${String(s ?? "")
    .toLocaleLowerCase("nb-NO")
    .replace(/å/g, "a").replace(/aa/g, "a").replace(/ø/g, "o").replace(/æ/g, "ae")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()} `;
}

/**
 * Producer names (their own spelling, the part before " — ") that occur in
 * `query` as a whole-word sequence after folding, longest first. A name made
 * only of words `isGenericWord` accepts (categories, places, filler) is never
 * matched, so "Lokal Honning" cannot capture the query "honning".
 */
export function findExplicitProducerNames(query: string, isGenericWord: (w: string) => boolean): string[] {
  const foldedQuery = foldProducerName(query);
  if (foldedQuery.trim().length < 4) return [];
  // A matching name has at least one non-generic word, and that word is in
  // the query — so a query of only generic words ("poteter Bodø") cannot
  // name a producer and needs no DB read.
  const queryWords = String(query).toLocaleLowerCase("nb-NO").split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  if (queryWords.every((w) => isGenericWord(w))) return [];
  let rows: Array<{ name: string | null }>;
  try {
    rows = getDb()
      .prepare(`SELECT name FROM agents WHERE is_active = 1 AND umbrella_type IS NULL AND is_vetted = 1 AND ${publicListableSql()}`)
      .all() as Array<{ name: string | null }>;
  } catch {
    return []; // the lookup is an optimisation; the word-by-word passes still run
  }
  const hits = new Map<string, number>();
  for (const { name } of rows) {
    const core = String(name ?? "").split(/\s+[—–-]\s+/)[0].trim();
    const folded = foldProducerName(core);
    if (folded.trim().length < 5) continue;
    const words = core.toLocaleLowerCase("nb-NO").split(/[^\p{L}\p{N}]+/u).filter(Boolean);
    if (words.every((w) => isGenericWord(w))) continue;
    if (foldedQuery.includes(folded)) hits.set(core, folded.length);
  }
  return [...hits.entries()].sort((a, b) => b[1] - a[1]).map(([core]) => core);
}

/** Is `w` one of the food-category / tag keywords the parser already matched? */
function isCategoryOrTagWord(
  w: string,
  categoryMap: Record<string, string[]>,
  tagMap: Record<string, string[]>,
): boolean {
  for (const kws of Object.values(categoryMap)) if (kws.includes(w)) return true;
  for (const kws of Object.values(tagMap)) if (kws.includes(w)) return true;
  return false;
}

export function norwegianWordBoundary(keyword: string): RegExp {
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[^${NORWEGIAN_WORD_CHAR}])${escaped}(?:$|[^${NORWEGIAN_WORD_CHAR}])`);
}

export function isProximityIntent(query: string): boolean {
  const q = (query || "").toLowerCase().replace(/[?!.,]/g, " ").replace(/\s+/g, " ").trim();
  if (!q) return false;
  return PROXIMITY_PATTERNS.some((re) => re.test(q));
}

// Singleton
export const marketplaceRegistry = new MarketplaceRegistry();
