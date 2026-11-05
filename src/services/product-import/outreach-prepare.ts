// ─── Product import: outreach pre-extraction (Skive 3b-1, admin only) ───────
//
// dev-request 2026-10-21-rfb-produktimport-fra-egen-nettside, Skive 3b-1:
// before an outreach e-mail goes out, pre-extract each recipient's products
// from their own website into staging, apply the controls and report per
// recipient. NOTHING is published and NOTHING is sent from here.
//
//   startOutreachPrepare()  one product_import_runs row per recipient (mode
//                       'outreach_prepare', campaign, prepare_id); skips (no
//                       website / umbrella / unknown agent) are recorded
//                       without fetching. The rest run in the background with
//                       the dry run's politeness (per-host pacing, small pool).
//   getOutreachReport()  READ-ONLY report per recipient (JSON or Norwegian md).
//
// Controls before a candidate is 'eligible' (else 'unchanged' / 'rejected'
// with reject_reason, kept for audit, never shown as new):
//   • the extractor's own rules (rules.ts / association.ts / LLM grounding);
//     a candidate whose price was dropped by them → price_not_anchored, one
//     with no price at all → no_price;
//   • the order gate's row rules (owner-import publishBlockReason: category
//     label, alcohol, service, check_failed);
//   • the diff against the profile's current list (owner-import diffAgainst):
//     unchanged is not shown, a changed price is a change;
//   • LLM-tier candidates only when PRODUCT_IMPORT_OUTREACH_LLM_ACCURACY ≥ 0.95;
//     below that the extractor gets an LLM budget of 0, so it is never called.
//
// Mode 'outreach_prepare' is never read by ownerFetchesToday (owner limit),
// the owner preview/overview/publish (all mode 'owner_fetch') or the dry run.
// Candidates are never written to agent_knowledge or products.

import { randomUUID } from "crypto";
import { getDb } from "../../database/init";
import { normalizeName } from "../product-catalog-sync";
import { extractProductsFromWebsite, HostPacer, type ProductImportDeps, type ProductImportResult } from "./extractor";
import { PRODUCT_IMPORT_DRYRUN_CONCURRENCY, PRODUCT_IMPORT_DRYRUN_HOST_INTERVAL_MS } from "./dry-run";
import { currentProductsOf, diffAgainst, producerTypesOf, profileWebsite, publishBlockReason, readCurrentList } from "./owner-import";

export const PRODUCT_IMPORT_OUTREACH_FLAG = "PRODUCT_IMPORT_OUTREACH_ENABLED";
export const PRODUCT_IMPORT_OUTREACH_LLM_ACCURACY_ENV = "PRODUCT_IMPORT_OUTREACH_LLM_ACCURACY";
export const OUTREACH_LLM_MIN_ACCURACY = 0.95;
export const OUTREACH_MAX_RECIPIENTS = 200;
export const OUTREACH_CAMPAIGN_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;
const MODE = "outreach_prepare";
/** Rules that dropped a price the source had (not verbatim / not at the name / not real). */
const PRICE_DROP_RULES = new Set(["price_not_at_name", "price_blog_source_dropped", "price_placeholder_dropped", "price_zero_dropped"]);

/** Flag: "1"/"true" turns the outreach routes on. Anything else = off (404). */
export function productImportOutreachEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env[PRODUCT_IMPORT_OUTREACH_FLAG];
  return v === "1" || v === "true";
}

/** The configured measured LLM accuracy (0–1), or null when absent/invalid. PURE. */
export function outreachLlmAccuracy(env: NodeJS.ProcessEnv = process.env): number | null {
  const raw = (env[PRODUCT_IMPORT_OUTREACH_LLM_ACCURACY_ENV] ?? "").trim();
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : null;
}

/** LLM-tier candidates are allowed only at a measured accuracy ≥ 0.95. */
export function outreachLlmAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  const a = outreachLlmAccuracy(env);
  return a !== null && a >= OUTREACH_LLM_MIN_ACCURACY;
}

export type PrepareInput = { ok: true; agentIds: string[]; campaign: string } | { ok: false; error: string; message: string };

/** Validate the POST body. PURE. */
export function validatePrepareInput(body: unknown): PrepareInput {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const campaign = typeof b.campaign === "string" ? b.campaign.trim() : "";
  if (!OUTREACH_CAMPAIGN_RE.test(campaign)) {
    return { ok: false, error: "invalid_campaign", message: "campaign må være en kort slug (a-z, 0-9, bindestrek, 2–64 tegn)" };
  }
  if (!Array.isArray(b.agentIds) || b.agentIds.some((x) => typeof x !== "string" || !x.trim())) {
    return { ok: false, error: "invalid_agent_ids", message: "agentIds må være en liste med tekst-id-er" };
  }
  const agentIds = [...new Set((b.agentIds as string[]).map((x) => x.trim()))];
  if (agentIds.length === 0) return { ok: false, error: "invalid_agent_ids", message: "agentIds kan ikke være tom" };
  if (agentIds.length > OUTREACH_MAX_RECIPIENTS) {
    return { ok: false, error: "too_many", message: `Høyst ${OUTREACH_MAX_RECIPIENTS} mottakere per kjøring` };
  }
  return { ok: true, agentIds, campaign };
}

// ── Test seams ──────────────────────────────────────────────────────────────

export interface OutreachDeps extends Pick<ProductImportDeps, "fetchImpl" | "llm" | "sleep" | "now" | "timeoutMs"> {
  hostIntervalMs?: number;
  concurrency?: number;
}
let testDeps: OutreachDeps | null = null;
export function __setOutreachDepsForTesting(deps: OutreachDeps | null): void {
  testDeps = deps;
}
const jobs = new Map<string, Promise<void>>();
export function __awaitOutreachPrepareForTesting(prepareId: string): Promise<void> {
  return jobs.get(prepareId) ?? Promise.resolve();
}
export function activeOutreachPrepareId(): string | null {
  for (const id of jobs.keys()) return id;
  return null;
}

const sqlTs = (ms: number): string => new Date(ms).toISOString().slice(0, 19).replace("T", " ");

// ── Start ───────────────────────────────────────────────────────────────────

export interface StartedPrepare {
  prepare_id: string;
  campaign: string;
  recipients_total: number;
  to_fetch: number;
  skipped: number;
  llm_included: boolean;
}

interface Recipient {
  runId: string;
  agentId: string;
  website: string;
}

export function startOutreachPrepare(agentIds: string[], campaign: string, deps: OutreachDeps = testDeps ?? {}): StartedPrepare {
  const db = getDb();
  const now = deps.now ?? Date.now;
  const startedMs = now();
  const stamp = new Date(startedMs).toISOString().replace(/[-:]/g, "").slice(0, 15);
  const prepareId = `pop-${stamp}-${randomUUID().slice(0, 8)}`;
  const llmIncluded = outreachLlmAllowed();
  const insert = db.prepare(
    `INSERT INTO product_import_runs
       (id, mode, status, params_json, profiles_total, llm_call_cap, agent_id, campaign, prepare_id, outcome, created_at, finished_at)
     VALUES (?, '${MODE}', ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const agentRow = db.prepare(`SELECT id, name, umbrella_type FROM agents WHERE id = ?`);
  const todo: Recipient[] = [];
  db.transaction(() => {
    for (const agentId of agentIds) {
      const runId = `pio-${stamp}-${randomUUID().slice(0, 8)}`;
      const a = agentRow.get(agentId) as { id: string; name: string; umbrella_type: string | null } | undefined;
      const website = a ? profileWebsite(agentId) : null;
      const skip = !a ? "skipped_unknown_agent" : a.umbrella_type ? "skipped_umbrella" : !website ? "skipped_no_website" : null;
      const params = JSON.stringify({ agent_name: a?.name ?? null, website, llm_included: llmIncluded });
      const ts = sqlTs(startedMs);
      insert.run(runId, skip ? "completed" : "running", params, llmIncluded ? 1 : 0, agentId, campaign, prepareId, skip, ts, skip ? ts : null);
      if (!skip) todo.push({ runId, agentId, website: website! });
    }
  })();
  const job = runPrepare(todo, llmIncluded, deps).finally(() => jobs.delete(prepareId));
  jobs.set(prepareId, job);
  return {
    prepare_id: prepareId,
    campaign,
    recipients_total: agentIds.length,
    to_fetch: todo.length,
    skipped: agentIds.length - todo.length,
    llm_included: llmIncluded,
  };
}

async function runPrepare(todo: Recipient[], llmIncluded: boolean, deps: OutreachDeps): Promise<void> {
  const now = deps.now ?? Date.now;
  const pacer = new HostPacer(deps.hostIntervalMs ?? PRODUCT_IMPORT_DRYRUN_HOST_INTERVAL_MS, deps.now, deps.sleep);
  let next = 0;
  const worker = async () => {
    while (next < todo.length) {
      const r = todo[next++]!;
      try {
        const result = await extractProductsFromWebsite(r.website, {
          fetchImpl: deps.fetchImpl,
          llm: deps.llm,
          sleep: deps.sleep,
          now: deps.now,
          timeoutMs: deps.timeoutMs,
          // Cap 0 → the extractor stops before the LLM tier and never calls it.
          llmBudget: { cap: llmIncluded ? 1 : 0, used: 0 },
          pacer,
        });
        stageOutreach(r, result, llmIncluded, now());
      } catch (err) {
        try {
          getDb()
            .prepare(`UPDATE product_import_runs SET status = 'failed', outcome = 'failed', error = ?, finished_at = ? WHERE id = ? AND status = 'running'`)
            .run(String((err as Error)?.message ?? err).slice(0, 300), sqlTs(now()), r.runId);
        } catch {
          /* DB gone (a test closed it) */
        }
      }
    }
  };
  const n = Math.max(1, Math.min(deps.concurrency ?? PRODUCT_IMPORT_DRYRUN_CONCURRENCY, todo.length || 1));
  await Promise.all(Array.from({ length: n }, worker));
}

function stageOutreach(r: Recipient, result: ProductImportResult, llmIncluded: boolean, nowMs: number): void {
  const db = getDb();
  const types = producerTypesOf(r.agentId);
  type Row = { p: ProductImportResult["products"][number]; status: "eligible" | "unchanged" | "rejected"; reason: string | null; kind: string | null; old: number | null };
  const rows: Row[] = result.products.map((p) => {
    let reason: string | null = null;
    if (p.tier === "llm" && !llmIncluded) reason = "llm_below_accuracy";
    else reason = publishBlockReason(p.name, p.price_nok, types);
    if (!reason && p.price_nok === null) {
      reason = p.raw_price_text || p.rules.some((x) => PRICE_DROP_RULES.has(x)) ? "price_not_anchored" : "no_price";
    }
    return { p, status: reason ? "rejected" : "eligible", reason, kind: null, old: null };
  });
  const eligible = rows.filter((x) => x.status === "eligible");
  const diff = diffAgainst(
    eligible.map((x) => ({ key: normalizeName(x.p.name), price_nok: x.p.price_nok, unit: x.p.unit })),
    currentProductsOf(readCurrentList(r.agentId)),
  );
  eligible.forEach((x, i) => {
    const k = diff.kinds[i]!;
    x.kind = k.kind;
    x.old = k.current?.price_nok ?? null;
    if (k.kind === "unchanged") x.status = "unchanged";
  });
  const fetchedAt = new Date(nowMs).toISOString();
  const finished = sqlTs(nowMs);
  const insert = db.prepare(
    `INSERT INTO product_import_candidates
       (id, run_id, agent_id, position, name, name_norm, price_nok, price_text, unit, price_is_from, price_excl_vat,
        pack_size, tier, source_url, rules_json, fetched_at, status, reject_reason, diff_kind, old_price_nok, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const rejectedBy: Record<string, number> = {};
  db.transaction(() => {
    let pos = 0;
    for (const x of rows) {
      const p = x.p;
      if (x.reason) rejectedBy[x.reason] = (rejectedBy[x.reason] ?? 0) + 1;
      insert.run(
        `pic-${randomUUID()}`, r.runId, r.agentId, pos++, p.name, normalizeName(p.name), p.price_nok, p.price_text ?? "", p.unit,
        p.price_is_from ? 1 : 0, p.price_excl_vat ? 1 : 0, p.pack_size ?? null, p.tier, p.source_url ?? null,
        JSON.stringify(p.rules ?? []), fetchedAt, x.status, x.reason, x.kind, x.old, finished,
      );
    }
    // The extractor's own exclusions (services/events) are audited as rejected rows too.
    for (const e of result.excluded) {
      rejectedBy[e.reason] = (rejectedBy[e.reason] ?? 0) + 1;
      insert.run(
        `pic-${randomUUID()}`, r.runId, r.agentId, pos++, e.name, normalizeName(e.name), null, e.raw_price_text ?? "", null,
        0, 0, null, e.tier, e.source_url ?? null, "[]", fetchedAt, "rejected", e.reason, null, null, finished,
      );
    }
    const countNew = rows.filter((x) => x.status === "eligible" && x.kind === "new").length;
    const countChanged = rows.filter((x) => x.status === "eligible" && x.kind === "changed").length;
    const summary = {
      outcome: result.outcome,
      tier: result.tier,
      pages_fetched: result.pages_fetched,
      llm_calls: result.llm_calls,
      llm_status: result.llm_status,
      llm_included: llmIncluded,
      count_unchanged: rows.filter((x) => x.status === "unchanged").length,
      rejected_by_reason: rejectedBy,
      duration_ms: result.duration_ms,
    };
    db.prepare(
      `UPDATE product_import_runs
          SET status = 'completed', outcome = ?, tier = ?, profiles_done = 1, llm_calls = ?,
              count_new = ?, count_changed = ?, count_not_found = ?, summary_json = ?, finished_at = ?
        WHERE id = ? AND status = 'running'`,
    ).run(result.outcome, result.tier, result.llm_calls, countNew, countChanged, diff.notFound.length, JSON.stringify(summary), finished, r.runId);
  })();
}

// ── Report (READ-ONLY) ──────────────────────────────────────────────────────

interface ReportRunRow {
  id: string; agent_id: string; status: string; outcome: string | null; tier: string | null; params_json: string;
  summary_json: string | null; created_at: string; finished_at: string | null; count_new: number; count_changed: number; prepare_id: string;
}
interface ReportCandRow {
  name: string; price_nok: number | null; price_text: string; unit: string | null; tier: string; source_url: string | null;
  status: string; reject_reason: string | null; diff_kind: string | null; old_price_nok: number | null;
}

const parse = <T>(s: string | null | undefined, fallback: T): T => {
  try {
    return s ? (JSON.parse(s) as T) : fallback;
  } catch {
    return fallback;
  }
};

/** The campaign's latest run per recipient, with counts and up to three examples. Never writes. */
export function getOutreachReport(campaign: string, nowMs: number = (testDeps?.now ?? Date.now)()) {
  const db = getDb();
  const runs = db
    .prepare(
      `SELECT id, agent_id, status, outcome, tier, params_json, summary_json, created_at, finished_at, count_new, count_changed, prepare_id
         FROM product_import_runs WHERE mode = '${MODE}' AND campaign = ? ORDER BY created_at DESC, id DESC`,
    )
    .all(campaign) as ReportRunRow[];
  if (runs.length === 0) return null;
  const latest = new Map<string, ReportRunRow>();
  for (const r of runs) if (!latest.has(r.agent_id)) latest.set(r.agent_id, r);
  const cands = db.prepare(
    `SELECT name, price_nok, price_text, unit, tier, source_url, status, reject_reason, diff_kind, old_price_nok
       FROM product_import_candidates WHERE run_id = ? ORDER BY position`,
  );
  const nameOf = db.prepare(`SELECT name FROM agents WHERE id = ?`);
  const recipients = [...latest.values()]
    .sort((a, b) => a.agent_id.localeCompare(b.agent_id))
    .map((run) => {
      const params = parse<{ agent_name?: string | null; website?: string | null; llm_included?: boolean }>(run.params_json, {});
      const summary = parse<{ llm_status?: string; count_unchanged?: number; rejected_by_reason?: Record<string, number> } | null>(run.summary_json, null);
      const rows = cands.all(run.id) as ReportCandRow[];
      const status = run.status === "running" && !jobs.has(run.prepare_id) ? "interrupted" : run.status;
      const shown = rows.filter((c) => c.status === "eligible");
      return {
        agent_id: run.agent_id,
        name: params.agent_name ?? (nameOf.get(run.agent_id) as { name: string } | undefined)?.name ?? null,
        run_id: run.id,
        prepare_id: run.prepare_id,
        status,
        outcome: status === "interrupted" ? "interrupted" : run.outcome,
        website: params.website ?? null,
        prepared_at: run.created_at,
        finished_at: run.finished_at,
        counts: {
          new: shown.filter((c) => c.diff_kind === "new").length,
          changed: shown.filter((c) => c.diff_kind === "changed").length,
          unchanged: rows.filter((c) => c.status === "unchanged").length,
          rejected: rows.filter((c) => c.status === "rejected").length,
          rejected_by_reason: rows.reduce<Record<string, number>>((o, c) => {
            if (c.status === "rejected") o[c.reject_reason ?? "unknown"] = (o[c.reject_reason ?? "unknown"] ?? 0) + 1;
            return o;
          }, {}),
        },
        tiers: [...new Set([run.tier, ...rows.filter((c) => c.status !== "rejected").map((c) => c.tier)].filter((t): t is string => !!t))],
        llm: { included: params.llm_included === true, status: summary?.llm_status ?? null },
        examples: [...shown.filter((c) => c.diff_kind === "new"), ...shown.filter((c) => c.diff_kind === "changed")].slice(0, 3).map((c) => ({
          kind: c.diff_kind,
          name: c.name,
          price_nok: c.price_nok,
          price_text: c.price_text,
          unit: c.unit,
          old_price_nok: c.old_price_nok,
          source_url: c.source_url,
        })),
      };
    });
  const byOutcome: Record<string, number> = {};
  for (const r of recipients) byOutcome[r.outcome ?? r.status] = (byOutcome[r.outcome ?? r.status] ?? 0) + 1;
  return {
    campaign,
    generated_at: new Date(nowMs).toISOString(),
    published: false,
    emails_sent: 0,
    totals: {
      recipients: recipients.length,
      with_new_or_changed: recipients.filter((r) => r.counts.new + r.counts.changed > 0).length,
      new: recipients.reduce((n, r) => n + r.counts.new, 0),
      changed: recipients.reduce((n, r) => n + r.counts.changed, 0),
      rejected: recipients.reduce((n, r) => n + r.counts.rejected, 0),
      running: recipients.filter((r) => r.status === "running").length,
      by_outcome: byOutcome,
    },
    recipients,
  };
}

export type OutreachReport = NonNullable<ReturnType<typeof getOutreachReport>>;

const OUTCOME_NB: Record<string, string> = {
  ok: "Produkter funnet",
  no_products_found: "Fant ingen produkter",
  robots_blocked: "Nettsiden ber roboter om ikke å lese sidene (robots.txt)",
  js_unreadable: "Nettsiden bygges med JavaScript og kunne ikke leses",
  grounding_rejected_all: "Det som ble funnet, sto ikke ordrett på nettsiden",
  skipped_no_website: "Hoppet over: profilen har ingen nettside",
  skipped_umbrella: "Hoppet over: paraplyprofil",
  skipped_unknown_agent: "Hoppet over: ukjent profil-id",
  interrupted: "Avbrutt (prosessen startet på nytt)",
  failed: "Feilet",
};
const REASON_NB: Record<string, string> = {
  category_label: "kategorinavn",
  alcohol: "alkohol",
  service: "tjeneste",
  check_failed: "sjekk feilet",
  price_not_anchored: "pris ikke ordrett ved varen",
  no_price: "mangler pris",
  llm_below_accuracy: "LLM-nivå under kravet",
  excluded_service: "tjeneste/opplevelse",
  excluded_event_category: "arrangement",
  excluded_password_protected: "passordbeskyttet",
  excluded_check_failed: "sjekk feilet",
};
const outcomeNb = (o: string | null, status: string): string =>
  o ? OUTCOME_NB[o] ?? (o.startsWith("fetch_failed") ? `Fikk ikke kontakt med nettsiden (${o.slice(13)})` : o) : status === "running" ? "Pågår" : status;
const kr = (n: number | null): string => (n === null ? "uten pris" : `kr ${Number.isInteger(n) ? n : n.toFixed(2).replace(".", ",")}`);
const mdText = (s: string | null | undefined): string => String(s ?? "").replace(/[\r\n]+/g, " ").replace(/([\\`*_[\]<>|#])/g, "\\$1");

/** The report as Norwegian markdown for reports/<date>-forhandsuttrekk-<campaign>.md. PURE. */
export function renderOutreachReportMd(rep: OutreachReport): string {
  const t = rep.totals;
  const out: string[] = [
    `# Forhåndsuttrekk av produkter – kampanje ${rep.campaign}`,
    "",
    `Generert: ${rep.generated_at}`,
    "",
    "Ingenting er publisert og ingen e-post er sendt. Kandidatene ligger bare i staging.",
    "",
    "## Totalt",
    "",
    `- Mottakere: ${t.recipients}`,
    `- Mottakere med nye eller endrede produkter: ${t.with_new_or_changed}`,
    `- Nye produkter: ${t.new}`,
    `- Endrede priser: ${t.changed}`,
    `- Avviste kandidater: ${t.rejected}`,
    ...(t.running > 0 ? [`- Pågår fortsatt: ${t.running}`] : []),
    ...Object.entries(t.by_outcome).map(([o, n]) => `- ${outcomeNb(o, o)}: ${n}`),
  ];
  for (const r of rep.recipients) {
    const c = r.counts;
    const rej = Object.entries(c.rejected_by_reason).map(([k, n]) => `${REASON_NB[k] ?? k} ${n}`).join(", ");
    out.push(
      "",
      `## ${mdText(r.name ?? r.agent_id)} (${mdText(r.agent_id)})`,
      "",
      `- Utfall: ${outcomeNb(r.outcome, r.status)}`,
      ...(r.website ? [`- Nettside: ${mdText(r.website)}`] : []),
      `- Nye: ${c.new}, endrede: ${c.changed}, uendrede: ${c.unchanged}, avviste: ${c.rejected}${rej ? ` (${rej})` : ""}`,
      `- Nivåer brukt: ${r.tiers.length ? r.tiers.join(", ") : "ingen"}${r.llm.included ? "" : " (LLM-nivå ikke brukt)"}`,
    );
    if (r.examples.length) {
      out.push("- Eksempler:");
      for (const e of r.examples) {
        const price = e.kind === "changed" ? `${kr(e.old_price_nok)} → ${kr(e.price_nok)}` : kr(e.price_nok);
        out.push(`  - ${mdText(e.name)}: ${price}${e.unit ? `/${e.unit}` : ""}${e.kind === "changed" ? " (endret)" : ""}${e.source_url ? ` – ${mdText(e.source_url)}` : ""}`);
      }
    }
  }
  return out.join("\n") + "\n";
}
