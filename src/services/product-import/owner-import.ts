// ─── Product import for owners (Skive 3-1, server side) ─────────────────────
//
// dev-request 2026-10-21-rfb-produktimport-fra-egen-nettside, Skive 3: the
// owner button «Hent produkter fra nettsiden min». This module is the server
// side; the routes (routes/owner-product-import.ts) do the owner checks.
//
//   startOwnerFetch()   runs the Skive 1 extractor (same-host, robots.txt,
//                       fetchPage SSRF guard) against the profile's stored
//                       website as a background job and stages what it found
//                       in product_import_candidates, linked to one
//                       product_import_runs row (mode 'owner_fetch'). The
//                       caller gets the run id at once (HTTP 202) and polls.
//   getOwnerImportPreview()  READ-ONLY: the run, its candidates and the diff
//                       against the profile's current list (new / changed
//                       price or unit, old → new / not found on the website).
//   publishOwnerImport()  «Publiser valgte»: MERGES the selected candidates
//                       (optionally edited) into agent_knowledge.products on
//                       the owner path with source 'owner_import', sourceUrl,
//                       fetchedAt and confirmedAt; removes only the products
//                       the owner explicitly selected for removal; sets the
//                       owner lock on `products`; syncs that profile's
//                       catalog rows.
//
// Candidates are NEVER written to agent_knowledge.products or products before
// publish, so they are not on the profile, in lokal_find_offers, the cart or
// the ACP feed. Publishing does not make anything orderable: availability is
// untouched (the catalog sync never writes availability_source), so a product
// becomes orderable only through the existing «på lager» owner path (B1) and
// the Skive 4 requirements, as Daniel decided 2026-10-29.
//
// Limits: at most OWNER_FETCH_DAILY_LIMIT fetches per profile per UTC day,
// counted from product_import_runs (survives restarts); at most
// OWNER_FETCH_MAX_CONCURRENT fetches at a time in this process, and one per
// profile. Flag PRODUCT_IMPORT_ENABLED ("1"/"true"; default off).

import { randomUUID } from "crypto";
import { getDb } from "../../database/init";
import { classifyCartItemBan } from "../cart-item-ban";
import { isCategoryLabel } from "../../utils/category-label";
import {
  knowledgeService,
  parseProductPrice,
  productPriceText,
  isProductHeader,
  isProductNoise,
  type ProductInfo,
} from "../knowledge-service";
import { normalizeName, parsePriceNok, runProductCatalogSync } from "../product-catalog-sync";
import { auditOwnerProductChange } from "../owner-orderability";
import { extractProductsFromWebsite, HostPacer, type ProductImportDeps, type ProductImportResult } from "./extractor";
import { canonicalUnit, detectPriceUnit, normalizeProductName, PRODUCT_IMPORT_MAX_PRODUCTS, type ProductUnit } from "./normalize";

export const PRODUCT_IMPORT_FLAG = "PRODUCT_IMPORT_ENABLED";
export const OWNER_FETCH_DAILY_LIMIT = 3;
export const OWNER_FETCH_MAX_CONCURRENT = 2;
/** The whole fetch (≤ 8 pages + robots.txt + one LLM call) is given up after this. */
export const OWNER_FETCH_TIMEOUT_MS = 120_000;
export const OWNER_FETCH_HOST_INTERVAL_MS = 1000;
export const OWNER_IMPORT_MAX_PRICE_NOK = 100_000;

export const OWNER_FETCH_DAILY_LIMIT_MESSAGE =
  `Du kan hente produkter fra nettsiden din høyst ${OWNER_FETCH_DAILY_LIMIT} ganger per døgn. Prøv igjen i morgen.`;
export const OWNER_FETCH_BUSY_MESSAGE =
  "Mange henter produkter akkurat nå. Prøv igjen om et par minutter.";
export const OWNER_FETCH_RUNNING_MESSAGE = "Vi henter allerede produkter fra nettsiden din. Vent til hentingen er ferdig.";
export const OWNER_IMPORT_NO_WEBSITE_MESSAGE =
  "Profilen har ingen nettside. Legg inn nettsiden i profilen først, eller legg inn produktene selv.";

/** Flag: "1"/"true" turns the owner import on. Anything else = off (404). */
export function productImportEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env[PRODUCT_IMPORT_FLAG];
  return v === "1" || v === "true";
}

// ── Test seams ──────────────────────────────────────────────────────────────

export interface OwnerImportDeps extends Pick<ProductImportDeps, "fetchImpl" | "llm" | "sleep" | "timeoutMs"> {
  now?: () => number;
  hostIntervalMs?: number;
  jobTimeoutMs?: number;
}

let testDeps: OwnerImportDeps | null = null;
/** Test-only: inject fetch / LLM / clock for every fetch started after this. */
export function __setOwnerImportDepsForTesting(deps: OwnerImportDeps | null): void {
  testDeps = deps;
}

const jobs = new Map<string, { agentId: string; promise: Promise<void> }>();

/** Test-only: resolves when the background job for `runId` has finished. */
export function __awaitOwnerFetchForTesting(runId: string): Promise<void> {
  return jobs.get(runId)?.promise ?? Promise.resolve();
}
/** Whether this process is still running the owner fetch `runId` (else a 'running' row reads as interrupted). */
export function isOwnerFetchJobRunning(runId: string): boolean {
  return jobs.has(runId);
}
/** Test-only: forget in-process jobs (as after a restart). */
export function __forgetOwnerFetchJobsForTesting(): void {
  jobs.clear();
}

// ── Helpers ────────────────────────────────────────────────────────────────

const sqlTs = (ms: number): string => new Date(ms).toISOString().slice(0, 19).replace("T", " ");
const isoTs = (ms: number): string => new Date(ms).toISOString();

/** The UTC day [start, end) of `ms`, in the run table's created_at format. PURE. */
export function utcDayBounds(ms: number): { start: string; end: string } {
  const d = new Date(ms);
  const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  return { start: sqlTs(start), end: sqlTs(start + 86_400_000) };
}

/** The profile's stored website (trimmed), or null. */
export function profileWebsite(agentId: string): string | null {
  const row = getDb().prepare(`SELECT TRIM(COALESCE(website, '')) AS website FROM agent_knowledge WHERE agent_id = ?`).get(agentId) as
    | { website: string }
    | undefined;
  return row && row.website ? row.website : null;
}

/** How many owner fetches this profile started in the UTC day of `nowMs` (from the run table). */
export function ownerFetchesToday(agentId: string, nowMs: number): number {
  const { start, end } = utcDayBounds(nowMs);
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) AS n FROM product_import_runs
        WHERE mode = 'owner_fetch' AND agent_id = ? AND created_at >= ? AND created_at < ?`,
    )
    .get(agentId, start, end) as { n: number };
  return row.n;
}

/** A current product of the profile, read the way the catalog sync reads it. */
export interface CurrentProduct {
  index: number;
  name: string;
  key: string;
  price_nok: number | null;
  unit: ProductUnit | null;
  price: string | null;
  source: string | null;
}

export function currentProductsOf(list: ProductInfo[]): CurrentProduct[] {
  const out: CurrentProduct[] = [];
  list.forEach((p, index) => {
    const rawName = p && typeof p.name === "string" ? p.name.trim() : "";
    if (!rawName || isProductHeader(rawName) || isProductNoise(rawName)) return;
    const { cleanName, price } = parseProductPrice(p);
    const key = cleanName ? normalizeName(cleanName) : "";
    if (!key) return;
    const priceText = price ?? productPriceText(p.price);
    out.push({
      index,
      name: cleanName,
      key,
      price_nok: parsePriceNok(price) ?? parsePriceNok(productPriceText(p.price)),
      unit: detectPriceUnit(priceText),
      price: priceText || null,
      source: typeof p.source === "string" ? p.source : null,
    });
  });
  return out;
}

export function readCurrentList(agentId: string): ProductInfo[] {
  const k = knowledgeService.getKnowledge(agentId);
  return Array.isArray(k?.products) ? (k!.products as ProductInfo[]) : [];
}

/** The producer's own types (agents.categories / tags), as the cart gate reads them. */
export function producerTypesOf(agentId: string): string[] {
  try {
    const row = getDb().prepare(`SELECT categories, tags FROM agents WHERE id = ?`).get(agentId) as
      | { categories: string | null; tags: string | null }
      | undefined;
    const out: string[] = [];
    for (const raw of [row?.categories, row?.tags]) {
      if (!raw) continue;
      try {
        const arr = JSON.parse(raw);
        if (Array.isArray(arr)) for (const v of arr) if (typeof v === "string") out.push(v);
      } catch {
        /* not JSON */
      }
    }
    return out;
  } catch {
    return [];
  }
}

export type PublishBlockReason = "category_label" | "alcohol" | "service" | "check_failed";

/**
 * The cart's row rules for one product to be published: a generic category
 * label without a price (utils/category-label isCategoryLabel, as
 * cart-service isCategoryLabelRow) and alcohol / services (cart-item-ban
 * classifyCartItemBan, fail-closed, as cart-service bannedItemError). null =
 * may be published.
 */
export function publishBlockReason(
  name: string,
  priceNok: number | null,
  producerTypes: readonly string[],
): PublishBlockReason | null {
  if (isCategoryLabel({ name, hasPrice: priceNok != null, availabilitySource: null })) return "category_label";
  try {
    const ban = classifyCartItemBan({ name, producerTypes });
    return ban ? ban.kind : null;
  } catch {
    return "check_failed";
  }
}

export const PUBLISH_BLOCK_TEXT_NB: Record<PublishBlockReason, string> = {
  category_label: "Dette er et kategorinavn, ikke en vare.",
  alcohol: "Alkohol kan ikke legges inn som vare her.",
  service: "Tjenester og opplevelser kan ikke legges inn som vare her.",
  check_failed: "Vi klarte ikke å sjekke varen. Legg den inn selv.",
};

/** The Norwegian explanation of a fetch outcome with no candidates. */
export function outcomeMessageNb(outcome: string | null, candidates: number): string | null {
  if (candidates > 0) return null;
  const base = "Fant ingen produkter med pris på nettsiden. Legg dem inn selv.";
  if (!outcome) return null;
  if (outcome === "robots_blocked") return `${base} Nettsiden ber roboter om ikke å lese sidene (robots.txt), så vi hentet ingenting.`;
  if (outcome === "js_unreadable") return `${base} Nettsiden bygges med JavaScript, så vi kunne ikke lese produktene.`;
  if (outcome === "grounding_rejected_all") return `${base} Det vi fant, sto ikke ordrett på nettsiden.`;
  if (outcome.startsWith("fetch_failed")) return `${base} Vi fikk ikke kontakt med nettsiden.`;
  if (outcome === "timeout") return `${base} Hentingen tok for lang tid.`;
  if (outcome === "interrupted") return `${base} Hentingen ble avbrutt. Prøv igjen.`;
  return base;
}

// ── Fetch ───────────────────────────────────────────────────────────────────

export type StartFetchResult =
  | { ok: true; run_id: string; status: "running" }
  | { ok: false; status: 409 | 422 | 429 | 503; error: string; message: string };

/**
 * `opts.llmCap` (default 1, the Skive 3 portal path): how many LLM calls the
 * fetch may make. The Skive 3b outreach re-fetch passes 0 unless the measured
 * LLM accuracy allows the LLM tier there (outreachLlmAllowed).
 */
export function startOwnerFetch(agentId: string, deps: OwnerImportDeps = testDeps ?? {}, opts: { llmCap?: 0 | 1 } = {}): StartFetchResult {
  const llmCap = opts.llmCap ?? 1;
  const db = getDb();
  const now = deps.now ?? Date.now;
  const website = profileWebsite(agentId);
  if (!website) return { ok: false, status: 422, error: "no_website", message: OWNER_IMPORT_NO_WEBSITE_MESSAGE };
  for (const j of jobs.values()) {
    if (j.agentId === agentId) return { ok: false, status: 409, error: "fetch_running", message: OWNER_FETCH_RUNNING_MESSAGE };
  }
  if (ownerFetchesToday(agentId, now()) >= OWNER_FETCH_DAILY_LIMIT) {
    return { ok: false, status: 429, error: "daily_limit", message: OWNER_FETCH_DAILY_LIMIT_MESSAGE };
  }
  if (jobs.size >= OWNER_FETCH_MAX_CONCURRENT) {
    return { ok: false, status: 503, error: "busy", message: OWNER_FETCH_BUSY_MESSAGE };
  }
  const startedMs = now();
  const runId = `pio-${new Date(startedMs).toISOString().replace(/[-:]/g, "").slice(0, 15)}-${randomUUID().slice(0, 8)}`;
  // Checks and INSERT run in one synchronous stretch: no other request can
  // slip between the count and the row that it counts.
  db.prepare(
    `INSERT INTO product_import_runs (id, mode, status, params_json, profiles_total, llm_call_cap, agent_id, created_at)
     VALUES (?, 'owner_fetch', 'running', ?, 1, ?, ?, ?)`,
  ).run(runId, JSON.stringify({ website }), llmCap, agentId, sqlTs(startedMs));
  const promise = runOwnerFetch(runId, agentId, website, deps, llmCap).finally(() => jobs.delete(runId));
  jobs.set(runId, { agentId, promise });
  return { ok: true, run_id: runId, status: "running" };
}

async function runOwnerFetch(runId: string, agentId: string, website: string, deps: OwnerImportDeps, llmCap: number): Promise<void> {
  const now = deps.now ?? Date.now;
  const fail = (outcome: string, error: string) => {
    try {
      getDb()
        .prepare(
          `UPDATE product_import_runs SET status = 'failed', outcome = ?, error = ?, finished_at = ?
            WHERE id = ? AND status = 'running'`,
        )
        .run(outcome, error.slice(0, 300), sqlTs(now()), runId);
    } catch {
      /* DB gone (a test closed it) */
    }
  };
  try {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), deps.jobTimeoutMs ?? OWNER_FETCH_TIMEOUT_MS);
      (timer as any)?.unref?.();
    });
    const extraction = extractProductsFromWebsite(website, {
      fetchImpl: deps.fetchImpl,
      llm: deps.llm,
      sleep: deps.sleep,
      now: deps.now,
      timeoutMs: deps.timeoutMs,
      llmBudget: { cap: llmCap, used: 0 },
      pacer: new HostPacer(deps.hostIntervalMs ?? OWNER_FETCH_HOST_INTERVAL_MS, deps.now, deps.sleep),
    });
    const result = await Promise.race([extraction, timeout]);
    if (timer) clearTimeout(timer);
    if (result === "timeout") {
      fail("timeout", "fetch timed out");
      // Keep the concurrency slot until the extractor really stops.
      await extraction.catch(() => undefined);
      return;
    }
    stageCandidates(runId, agentId, result, isoTs(now()), sqlTs(now()));
  } catch (err) {
    fail("failed", String((err as Error)?.message ?? err));
  }
}

function stageCandidates(runId: string, agentId: string, result: ProductImportResult, fetchedAtIso: string, finishedSql: string): void {
  const db = getDb();
  const current = currentProductsOf(readCurrentList(agentId));
  const diff = diffAgainst(
    result.products.map((p) => ({ key: normalizeName(p.name), price_nok: p.price_nok, unit: p.unit })),
    current,
  );
  const insert = db.prepare(
    `INSERT INTO product_import_candidates
       (id, run_id, agent_id, position, name, name_norm, price_nok, price_text, unit, price_is_from, price_excl_vat,
        pack_size, tier, source_url, rules_json, fetched_at, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
  );
  db.transaction(() => {
    const st = db.prepare(`SELECT status FROM product_import_runs WHERE id = ?`).get(runId) as { status: string } | undefined;
    if (!st || st.status !== "running") return; // timed out / interrupted meanwhile
    result.products.forEach((p, i) => {
      insert.run(
        `pic-${randomUUID()}`, runId, agentId, i, p.name, normalizeName(p.name), p.price_nok, p.price_text ?? "", p.unit,
        p.price_is_from ? 1 : 0, p.price_excl_vat ? 1 : 0, p.pack_size ?? null, p.tier, p.source_url ?? null,
        JSON.stringify(p.rules ?? []), fetchedAtIso, finishedSql,
      );
    });
    const summary = {
      outcome: result.outcome,
      tier: result.tier,
      pages_fetched: result.pages_fetched,
      llm_calls: result.llm_calls,
      llm_status: result.llm_status,
      excluded: result.excluded,
      robots_skipped: result.robots_skipped.length,
      rejected_urls: result.rejected_urls.length,
      duration_ms: result.duration_ms,
    };
    db.prepare(
      `UPDATE product_import_runs
          SET status = 'completed', outcome = ?, tier = ?, profiles_done = 1, llm_calls = ?,
              count_new = ?, count_changed = ?, count_not_found = ?, summary_json = ?, finished_at = ?
        WHERE id = ? AND status = 'running'`,
    ).run(
      result.outcome, result.tier, result.llm_calls, diff.newCount, diff.changedCount, diff.notFound.length,
      JSON.stringify(summary), finishedSql, runId,
    );
  })();
}

// ── Diff (PURE) ─────────────────────────────────────────────────────────────

interface DiffInput {
  key: string;
  price_nok: number | null;
  unit: string | null;
}

/** new / changed / unchanged per candidate (by index), and the current products no candidate matched. PURE. */
export function diffAgainst(cands: DiffInput[], current: CurrentProduct[]) {
  const byKey = new Map<string, CurrentProduct>();
  for (const c of current) if (!byKey.has(c.key)) byKey.set(c.key, c);
  const matched = new Set<string>();
  const kinds: Array<{ kind: "new" | "changed" | "unchanged"; current: CurrentProduct | null }> = [];
  let newCount = 0;
  let changedCount = 0;
  for (const c of cands) {
    const cur = byKey.get(c.key) ?? null;
    if (!cur) {
      kinds.push({ kind: "new", current: null });
      newCount++;
      continue;
    }
    matched.add(cur.key);
    const priceChanged = c.price_nok !== null && c.price_nok !== cur.price_nok;
    const unitChanged = c.unit !== null && cur.unit !== null && c.unit !== cur.unit;
    if (priceChanged || unitChanged) {
      kinds.push({ kind: "changed", current: cur });
      changedCount++;
    } else {
      kinds.push({ kind: "unchanged", current: cur });
    }
  }
  const notFound = current.filter((c) => !matched.has(c.key));
  return { kinds, newCount, changedCount, notFound };
}

// ── Preview (READ-ONLY) ─────────────────────────────────────────────────────

interface CandidateRow {
  id: string;
  run_id: string;
  agent_id: string;
  position: number;
  name: string;
  name_norm: string;
  price_nok: number | null;
  price_text: string;
  unit: string | null;
  price_is_from: number;
  price_excl_vat: number;
  pack_size: string | null;
  tier: string;
  source_url: string | null;
  rules_json: string;
  fetched_at: string;
  status: string;
  reject_reason: string | null;
  published_at: string | null;
}

interface RunRow {
  id: string;
  mode: string;
  status: string;
  agent_id: string | null;
  outcome: string | null;
  tier: string | null;
  error: string | null;
  params_json: string;
  summary_json: string | null;
  created_at: string;
  finished_at: string | null;
  count_new: number;
  count_changed: number;
  count_not_found: number;
  count_published: number;
  count_removed: number;
  published_by_owner: number;
  published_at: string | null;
}

const RUN_COLUMNS = `id, mode, status, agent_id, outcome, tier, error, params_json, summary_json, created_at, finished_at,
  count_new, count_changed, count_not_found, count_published, count_removed, published_by_owner, published_at`;

/**
 * The run modes whose candidates the owner preview / publish can read.
 * 'owner_fetch' (Skive 3) stages candidates as 'pending'; 'outreach_prepare'
 * (Skive 3b-1) stages the ones that passed its controls as 'eligible'. The
 * outreach mode is used only by the signed outreach landing page (Skive 3b-2),
 * always for the run of the agent the page is for.
 */
export type ImportRunMode = "owner_fetch" | "outreach_prepare";
const OPEN_STATUS: Record<ImportRunMode, string> = { owner_fetch: "pending", outreach_prepare: "eligible" };

function readRun(agentId: string, runId: string, mode: ImportRunMode = "owner_fetch"): RunRow | null {
  const row = getDb()
    .prepare(`SELECT ${RUN_COLUMNS} FROM product_import_runs WHERE id = ? AND mode = ? AND agent_id = ?`)
    .get(runId, mode, agentId) as RunRow | undefined;
  return row ?? null;
}

function candidateJson(c: CandidateRow, block: PublishBlockReason | null) {
  let rules: string[] = [];
  try {
    const r = JSON.parse(c.rules_json || "[]");
    if (Array.isArray(r)) rules = r.map(String);
  } catch {
    /* unreadable */
  }
  return {
    id: c.id,
    name: c.name,
    price_nok: c.price_nok,
    price_text: c.price_text,
    unit: c.unit,
    price_is_from: c.price_is_from === 1,
    price_excl_vat: c.price_excl_vat === 1,
    pack_size: c.pack_size,
    tier: c.tier,
    llm: c.tier === "llm",
    source_url: c.source_url,
    fetched_at: c.fetched_at,
    rules,
    status: c.status,
    price_missing_on_site: c.price_nok === null,
    price_missing_text: c.price_nok === null ? "Pris mangler på nettsiden. Prisen du har i dag beholdes hvis du ikke endrer den." : null,
    publish_blocked: block,
    publish_blocked_text: block ? PUBLISH_BLOCK_TEXT_NB[block] : null,
  };
}

/** The run's status, counts and log fields. A `running` row this process no longer runs reads as interrupted (not written). */
function runStatusJson(run: RunRow) {
  const status = run.status === "running" && !jobs.has(run.id) ? "interrupted" : run.status;
  let summary: Record<string, unknown> | null = null;
  try {
    summary = run.summary_json ? JSON.parse(run.summary_json) : null;
  } catch {
    summary = null;
  }
  let website: string | null = null;
  try {
    website = (JSON.parse(run.params_json || "{}") as { website?: string }).website ?? null;
  } catch {
    /* unreadable */
  }
  return {
    run_id: run.id,
    status,
    outcome: status === "interrupted" ? "interrupted" : run.outcome,
    tier: run.tier,
    website,
    created_at: run.created_at,
    finished_at: run.finished_at,
    excluded: Array.isArray(summary?.excluded) ? summary!.excluded : [],
    log: {
      count_new: run.count_new,
      count_changed: run.count_changed,
      count_not_found: run.count_not_found,
      count_published: run.count_published,
      count_removed: run.count_removed,
      published_by_owner: run.published_by_owner === 1,
      published_at: run.published_at,
    },
  };
}

/**
 * GET: the run and the diff against the profile's current list. Never writes.
 * `mode` 'outreach_prepare' reads a Skive 3b-1 run: its 'eligible' candidates
 * take the place of 'pending' ones, and its control-rejected rows are left out
 * (they were never shown as suggestions).
 */
export function getOwnerImportPreview(agentId: string, runId: string, opts: { mode?: ImportRunMode } = {}) {
  const mode = opts.mode ?? "owner_fetch";
  const run = readRun(agentId, runId, mode);
  if (!run) return null;
  const head = runStatusJson(run);
  const rows = getDb()
    .prepare(
      `SELECT id, run_id, agent_id, position, name, name_norm, price_nok, price_text, unit, price_is_from, price_excl_vat,
              pack_size, tier, source_url, rules_json, fetched_at, status, reject_reason, published_at
         FROM product_import_candidates WHERE run_id = ? AND agent_id = ? ORDER BY position`,
    )
    .all(runId, agentId) as CandidateRow[];
  const current = currentProductsOf(readCurrentList(agentId));
  const pending = rows.filter((r) => r.status === OPEN_STATUS[mode]);
  const diff = diffAgainst(pending.map((r) => ({ key: r.name_norm, price_nok: r.price_nok, unit: r.unit })), current);
  const types = producerTypesOf(agentId);
  const out = {
    ...head,
    message: head.status === "completed" || head.status === "failed" || head.status === "interrupted"
      ? outcomeMessageNb(head.outcome, rows.length)
      : null,
    counts: { new: 0, changed: 0, unchanged: 0, not_found: diff.notFound.length, published: 0, rejected: 0 },
    new: [] as ReturnType<typeof candidateJson>[],
    changed: [] as Array<ReturnType<typeof candidateJson> & { old: { price_nok: number | null; unit: string | null; price: string | null } }>,
    unchanged: [] as Array<ReturnType<typeof candidateJson> & { old: { price_nok: number | null; unit: string | null; price: string | null } }>,
    not_found: diff.notFound.map((c) => ({ name: c.name, price: c.price, price_nok: c.price_nok, unit: c.unit, source: c.source })),
    published: [] as ReturnType<typeof candidateJson>[],
    rejected: [] as Array<ReturnType<typeof candidateJson> & { reject_reason: string | null }>,
  };
  pending.forEach((r, i) => {
    const c = candidateJson(r, publishBlockReason(r.name, r.price_nok, types));
    const k = diff.kinds[i]!;
    if (k.kind === "new") out.new.push(c);
    else if (k.kind === "changed") out.changed.push({ ...c, old: { price_nok: k.current!.price_nok, unit: k.current!.unit, price: k.current!.price } });
    else out.unchanged.push({ ...c, old: { price_nok: k.current!.price_nok, unit: k.current!.unit, price: k.current!.price } });
  });
  for (const r of rows) {
    if (r.status === "published") out.published.push(candidateJson(r, null));
    else if (r.status === "rejected" && mode === "owner_fetch") out.rejected.push({ ...candidateJson(r, null), reject_reason: r.reject_reason });
  }
  out.counts.new = out.new.length;
  out.counts.changed = out.changed.length;
  out.counts.unchanged = out.unchanged.length;
  out.counts.published = out.published.length;
  out.counts.rejected = out.rejected.length;
  return out;
}

/** GET: the profile's latest owner fetches and how many are left today. Never writes. */
export function getOwnerImportOverview(agentId: string, nowMs: number = (testDeps?.now ?? Date.now)()) {
  const runs = getDb()
    .prepare(
      `SELECT ${RUN_COLUMNS} FROM product_import_runs
        WHERE mode = 'owner_fetch' AND agent_id = ? ORDER BY created_at DESC, id DESC LIMIT 10`,
    )
    .all(agentId) as RunRow[];
  const used = ownerFetchesToday(agentId, nowMs);
  return {
    website: profileWebsite(agentId),
    fetches_today: used,
    fetches_left_today: Math.max(0, OWNER_FETCH_DAILY_LIMIT - used),
    daily_limit: OWNER_FETCH_DAILY_LIMIT,
    runs: runs.map(runStatusJson),
  };
}

// ── Publish ────────────────────────────────────────────────────────────────

export interface PublishSelection {
  id: string;
  name?: unknown;
  price?: unknown;
  unit?: unknown;
}

export type PublishResult =
  | {
      ok: true;
      published: Array<{ id: string; name: string; action: "added" | "updated" }>;
      rejected: Array<{ id: string; name: string; reason: PublishBlockReason; message: string }>;
      removed: string[];
      not_removed: string[];
      catalog_sync: "ok" | "failed";
    }
  | { ok: false; status: 400 | 404 | 409 | 500; error: string; message: string; fields?: Array<{ id: string; field: string }> };

function parsePriceInput(v: unknown): number | null | "invalid" {
  if (v === undefined) return "invalid"; // caller handles "not given"
  if (v === null || v === "") return null;
  let n: number;
  if (typeof v === "number") n = v;
  else if (typeof v === "string") {
    const t = v.replace(/\s/g, "").replace(",", ".");
    if (!/^\d+(\.\d{1,2})?$/.test(t)) return "invalid";
    n = Number(t);
  } else return "invalid";
  if (!Number.isFinite(n) || n <= 0 || n > OWNER_IMPORT_MAX_PRICE_NOK) return "invalid";
  return Math.round(n * 100) / 100;
}

function formatPrice(price: number | null, unit: string | null, isFrom: boolean, exclVat: boolean): string | undefined {
  if (price === null) return undefined;
  const p = Number.isInteger(price) ? String(price) : price.toFixed(2).replace(".", ",");
  return `${isFrom ? "fra " : ""}kr ${p}${unit ? `/${unit}` : ""}${exclVat ? " ekskl. mva." : ""}`;
}

/**
 * «Publiser valgte». Validates everything before writing anything: a bad
 * edited value → 400 and nothing changes. Rule-blocked rows (category label,
 * alcohol, service) are not published, marked rejected and reported.
 */
export function publishOwnerImport(
  agentId: string,
  runId: string,
  selection: PublishSelection[],
  remove: string[],
  opts: { actorEmail: string | null; now?: () => number; mode?: ImportRunMode } = { actorEmail: null },
): PublishResult {
  const db = getDb();
  const now = opts.now ?? testDeps?.now ?? Date.now;
  const mode = opts.mode ?? "owner_fetch";
  const run = readRun(agentId, runId, mode);
  if (!run) return { ok: false, status: 404, error: "run_not_found", message: "Fant ikke hentingen." };
  if (run.status !== "completed") {
    return { ok: false, status: 409, error: "run_not_completed", message: "Hentingen er ikke ferdig. Vent til den er ferdig, eller hent på nytt." };
  }
  if (mode === "outreach_prepare" && remove.length > 0) {
    // The outreach landing page only adds / updates; it never removes products.
    return { ok: false, status: 400, error: "remove_not_allowed", message: "Varer kan ikke fjernes herfra." };
  }
  if (selection.length === 0 && remove.length === 0) {
    return { ok: false, status: 400, error: "nothing_selected", message: "Velg minst én vare å publisere eller fjerne." };
  }
  if (selection.length > PRODUCT_IMPORT_MAX_PRODUCTS) {
    return { ok: false, status: 400, error: "too_many", message: `Du kan publisere høyst ${PRODUCT_IMPORT_MAX_PRODUCTS} varer om gangen.` };
  }
  const ids = [...new Set(selection.map((s) => s.id))];
  const rows = ids.length
    ? (db
        .prepare(
          `SELECT id, run_id, agent_id, position, name, name_norm, price_nok, price_text, unit, price_is_from, price_excl_vat,
                  pack_size, tier, source_url, rules_json, fetched_at, status, reject_reason, published_at
             FROM product_import_candidates
            WHERE run_id = ? AND agent_id = ? AND id IN (${ids.map(() => "?").join(",")})`,
        )
        .all(runId, agentId, ...ids) as CandidateRow[])
    : [];
  const byId = new Map(rows.map((r) => [r.id, r]));
  const missing = ids.filter((id) => !byId.has(id));
  if (missing.length) {
    return { ok: false, status: 404, error: "candidate_not_found", message: "Fant ikke en av de valgte varene i denne hentingen.", fields: missing.map((id) => ({ id, field: "id" })) };
  }
  const notPending = rows.filter((r) => r.status !== OPEN_STATUS[mode]);
  if (notPending.length) {
    return { ok: false, status: 409, error: "candidate_not_pending", message: "En av de valgte varene er allerede behandlet.", fields: notPending.map((r) => ({ id: r.id, field: "id" })) };
  }

  // Resolve every selected row's final values (edits validated) first.
  const fieldErrors: Array<{ id: string; field: string }> = [];
  const finals: Array<{
    row: CandidateRow; name: string; price: number | null; unit: string | null; priceEdited: boolean;
    priceExplicit: boolean; unitExplicit: boolean;
  }> = [];
  const seenSel = new Set<string>();
  const seenNames = new Set<string>();
  // Single read of the profile's current list: used for the name lock below
  // and for the merge further down.
  const types = producerTypesOf(agentId);
  const list = readCurrentList(agentId).slice();
  const current = currentProductsOf(list);
  const byKey = new Map<string, CurrentProduct>();
  for (const c of current) if (!byKey.has(c.key)) byKey.set(c.key, c);
  for (const s of selection) {
    if (seenSel.has(s.id)) continue;
    seenSel.add(s.id);
    const row = byId.get(s.id)!;
    let name = row.name;
    // Name lock: a candidate matching an existing product keeps its name, so
    // the merge updates that product instead of adding a duplicate. Only a
    // submitted name that normalises to the same key is tolerated (ignored).
    const matched = byKey.has(normalizeName(row.name));
    if (s.name !== undefined) {
      const n = typeof s.name === "string" ? normalizeProductName(s.name) : null;
      if (!n) fieldErrors.push({ id: s.id, field: "name" });
      else if (matched) {
        if (normalizeName(n) !== normalizeName(row.name)) fieldErrors.push({ id: s.id, field: "name" });
      } else name = n;
    }
    let price = row.price_nok;
    let priceEdited = false;
    if (s.price !== undefined) {
      const p = parsePriceInput(s.price);
      if (p === "invalid") fieldErrors.push({ id: s.id, field: "price" });
      else {
        priceEdited = p !== row.price_nok;
        price = p;
      }
    }
    let unit = row.unit;
    if (s.unit !== undefined) {
      if (s.unit === null || s.unit === "") unit = null;
      else {
        const u = typeof s.unit === "string" ? canonicalUnit(s.unit) : null;
        if (!u) fieldErrors.push({ id: s.id, field: "unit" });
        else unit = u;
      }
    }
    // Two selected rows that end up with the same name would both be added.
    const nameKey = normalizeName(name);
    if (seenNames.has(nameKey)) fieldErrors.push({ id: s.id, field: "name" });
    seenNames.add(nameKey);
    finals.push({ row, name, price, unit, priceEdited, priceExplicit: s.price !== undefined, unitExplicit: s.unit !== undefined });
  }
  if (fieldErrors.length) {
    return { ok: false, status: 400, error: "invalid", message: "Noen av feltene er ugyldige. Sjekk navn, pris og enhet.", fields: fieldErrors };
  }

  const nowIso = isoTs(now());
  const nowSql = sqlTs(now());

  const published: Array<{ id: string; name: string; action: "added" | "updated" }> = [];
  const rejected: Array<{ id: string; name: string; reason: PublishBlockReason; message: string }> = [];
  const toPublish: Array<{ id: string; entry: ProductInfo; replaceIndex: number | null; key: string }> = [];
  for (const f of finals) {
    const key = normalizeName(f.name);
    const cur = byKey.get(key) ?? null;
    // A candidate without a price (the website shows none, or the rules
    // dropped it) never erases the owner's stored price; only an explicit
    // price: null / "" from the owner clears it. Same for the unit.
    const keepBasePrice = cur !== null && f.price === null && !f.priceExplicit;
    const unit = f.unit === null && !f.unitExplicit && cur ? cur.unit : f.unit;
    const effectivePrice = keepBasePrice ? cur!.price_nok : f.price;
    const block = publishBlockReason(f.name, effectivePrice, types);
    if (block) {
      rejected.push({ id: f.row.id, name: f.name, reason: block, message: PUBLISH_BLOCK_TEXT_NB[block] });
      continue;
    }
    const base: ProductInfo = cur ? { ...list[cur.index]! } : { name: f.name, category: "other", seasonal: false };
    const exclVat = f.row.price_excl_vat === 1 && !f.priceEdited;
    const isFrom = f.row.price_is_from === 1 && !f.priceEdited;
    const price = keepBasePrice ? undefined : formatPrice(f.price, unit, isFrom, exclVat);
    const entry: ProductInfo = {
      ...base,
      name: f.name,
      source: "owner_import",
      confirmedAt: nowIso,
      fetchedAt: f.row.fetched_at,
    };
    if (f.row.source_url) entry.sourceUrl = f.row.source_url;
    else delete entry.sourceUrl;
    if (keepBasePrice) {
      // base.price / base.priceUnit stay as the owner had them.
    } else if (price !== undefined) {
      entry.price = price;
      entry.priceUnit = "kr";
    } else {
      delete entry.price;
      delete entry.priceUnit;
    }
    toPublish.push({ id: f.row.id, entry, replaceIndex: cur ? cur.index : null, key });
    published.push({ id: f.row.id, name: f.name, action: cur ? "updated" : "added" });
  }

  // Removal: only what the owner explicitly listed, matched by name; never
  // a product that is being published in this call.
  const publishKeys = new Set(toPublish.map((t) => t.key));
  const removeKeys = new Set<string>();
  const notRemoved: string[] = [];
  for (const raw of remove) {
    const key = typeof raw === "string" ? normalizeName(raw) : "";
    if (!key || !byKey.has(key) || publishKeys.has(key)) notRemoved.push(String(raw));
    else removeKeys.add(key);
  }

  const merged: ProductInfo[] = [];
  const replaced = new Map<number, ProductInfo>();
  for (const t of toPublish) if (t.replaceIndex !== null) replaced.set(t.replaceIndex, t.entry);
  const removeIdx = new Set(current.filter((c) => removeKeys.has(c.key)).map((c) => c.index));
  list.forEach((p, i) => {
    if (removeIdx.has(i)) return;
    merged.push(replaced.get(i) ?? p);
  });
  for (const t of toPublish) if (t.replaceIndex === null) merged.push(t.entry);
  const removedNames = current.filter((c) => removeIdx.has(c.index)).map((c) => c.name);

  try {
    db.transaction(() => {
      if (toPublish.length > 0 || removedNames.length > 0) {
        knowledgeService.upsertKnowledge(agentId, { products: merged, dataSource: "owner" }, { ownerPath: true, preStampedProducts: true });
        knowledgeService.setCuratedFieldLock(agentId, "products", {
          locked_at: nowIso,
          by: "owner",
          request_summary: "produktimport fra egen nettside (owner_import)",
        });
      }
      const markPublished = db.prepare(`UPDATE product_import_candidates SET status = 'published', published_at = ? WHERE id = ?`);
      for (const t of toPublish) markPublished.run(nowIso, t.id);
      const markRejected = db.prepare(`UPDATE product_import_candidates SET status = 'rejected', reject_reason = ? WHERE id = ?`);
      for (const r of rejected) markRejected.run(r.reason, r.id);
      // Removed products' catalog rows (the sync never deletes): as the
      // content correction does — delete when nothing references the row,
      // else out of stock so it cannot be ordered.
      for (const key of removeKeys) {
        const prow = db.prepare(`SELECT id FROM products WHERE agent_id = ? AND name_norm = ?`).get(agentId, key) as { id: string } | undefined;
        if (!prow) continue;
        const refs =
          (db.prepare(`SELECT COUNT(*) AS n FROM cart_items WHERE product_id = ?`).get(prow.id) as { n: number }).n +
          (db.prepare(`SELECT COUNT(*) AS n FROM cart_wishes WHERE chosen_product_id = ?`).get(prow.id) as { n: number }).n;
        if (refs > 0) db.prepare(`UPDATE products SET availability = 'out_of_stock', updated_at = datetime('now') WHERE id = ?`).run(prow.id);
        else db.prepare(`DELETE FROM products WHERE id = ?`).run(prow.id);
      }
      db.prepare(
        `UPDATE product_import_runs
            SET count_published = count_published + ?, count_removed = count_removed + ?,
                published_by_owner = CASE WHEN ? > 0 THEN 1 ELSE published_by_owner END,
                published_at = CASE WHEN ? > 0 THEN ? ELSE published_at END
          WHERE id = ?`,
      ).run(toPublish.length, removedNames.length, toPublish.length + removedNames.length, toPublish.length + removedNames.length, nowSql, runId);
      if (toPublish.length > 0) {
        auditOwnerProductChange(db, agentId, "products.imported", null, published.map((p) => p.name).join(", ").slice(0, 2000), opts.actorEmail,
          `owner published ${toPublish.length} imported product(s) from run ${runId} (produktimport skive 3)`);
      }
      if (removedNames.length > 0) {
        auditOwnerProductChange(db, agentId, "products.removed", removedNames.join(", ").slice(0, 2000), null, opts.actorEmail,
          `owner removed ${removedNames.length} product(s) in import run ${runId} (produktimport skive 3)`);
      }
    })();
  } catch (err) {
    console.error("[product-import] owner publish failed:", err instanceof Error ? err.message : err);
    return { ok: false, status: 500, error: "write_failed", message: "Klarte ikke å lagre. Prøv igjen." };
  }

  // Catalog rows for this profile now (the daily sync would also pick it up).
  let catalog_sync: "ok" | "failed" = "ok";
  if (toPublish.length > 0) {
    const r = runProductCatalogSync(db, { agentId });
    if (!r.success) {
      catalog_sync = "failed";
      console.error("[product-import] catalog sync after publish failed:", r.error);
    }
  }
  return { ok: true, published, rejected, removed: removedNames, not_removed: notRemoved, catalog_sync };
}
