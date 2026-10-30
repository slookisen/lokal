// ─── Owner product import routes (Skive 3-1, server side) ──────────────────
//
// dev-request 2026-10-21-rfb-produktimport-fra-egen-nettside, Skive 3: the
// server side of «Hent produkter fra nettsiden min». JSON endpoints; the
// portal button and preview page are slice 3-2.
//
//   GET  /api/agents/:id/product-import                       → website, fetches left today, latest runs
//   POST /api/agents/:id/product-import/fetch                 → 202 {run_id, status:'running', poll}
//   GET  /api/agents/:id/product-import/runs/:runId           → status + preview diff (read-only)
//   POST /api/agents/:id/product-import/runs/:runId/publish   body {candidates:[{id, name?, price?, unit?}], remove?:[name]}
//
// Slice 3-2 adds the owner portal side (below the JSON routes): the form
// POSTs and the preview page /eier/:agentId/produktimport/:runId, with the
// same owner checks (checkOwnerImportAccess); the portal card lives in
// owner-portal.ts (productImportCardHtml).
//
// Fetch is asynchronous (the extractor reads up to 8 pages + robots.txt and
// may make one LLM call): the POST answers 202 with the run id at once and
// the client polls the GET until status is completed / failed. The job gives
// up after OWNER_FETCH_TIMEOUT_MS. GET never writes.
//
// Behind PRODUCT_IMPORT_ENABLED (default off → 404 on every route, nothing
// done). Owner checks on EVERY call, server-side, with the existing helpers
// (no new auth mechanism):
//   - verifyOwnerSession (rfb_owner_session cookie or Bearer) — none → 401;
//   - POSTs: crossSiteRequest (Origin ≠ Host) → 403;
//   - isVerifiedOwner: the session belongs to exactly this agent and the
//     profile has a verified owner — else 403 (foreign agent id included);
//   - agents.is_verified = 1 — an e-mail-match session or a self-registered
//     owner without completed ownership → 403;
//   - publish (a product write): the session must be opened by the verified
//     claimant's own e-mail (sessionClaimantOwnerEmail), as the B1 product
//     POSTs and /selger require — else 403;
//   - the profile must have a website → 422.

import express, { Router, Request, Response } from "express";
import { getDb } from "../database/init";
import {
  crossSiteRequest,
  formatImportRunTime,
  ORDERABILITY_ANCHOR,
  isVerifiedOwner,
  OWNER_NOT_VERIFIED_MESSAGE,
  ownerNotVerifiedPage,
  ownerProductsNeedClaimantLoginPage,
  escapeHtml,
  portalShell,
  PRODUCT_IMPORT_ANCHOR,
  productImportOutcomeTextNb,
  sessionClaimantOwnerEmail,
  verifyOwnerSession,
} from "./owner-portal";
import { ownerOrderabilityPortalEnabledFor } from "../services/owner-orderability";
import {
  getOwnerImportOverview,
  getOwnerImportPreview,
  OWNER_IMPORT_NO_WEBSITE_MESSAGE,
  productImportEnabled,
  profileWebsite,
  publishOwnerImport,
  startOwnerFetch,
  type PublishSelection,
} from "../services/product-import/owner-import";

const router = Router();

type Session = ReturnType<typeof verifyOwnerSession>;
type Auth = { ok: true; agentId: string; session: Session } | { ok: false };

/**
 * The owner checks every product-import route runs (JSON API and the portal
 * form routes alike), in this order. PURE apart from the DB reads.
 */
type AccessCheck =
  | { ok: true; agentId: string; session: Session }
  | { ok: false; reason: "flag_off" | "not_logged_in" | "cross_site" | "foreign" | "not_verified"; agentId: string; session: Session | null };

function checkOwnerImportAccess(req: Request, agentId: string, opts: { write: boolean }): AccessCheck {
  if (!productImportEnabled()) return { ok: false, reason: "flag_off", agentId, session: null };
  const session = verifyOwnerSession(req);
  if (!session.valid) return { ok: false, reason: "not_logged_in", agentId, session };
  if (opts.write && crossSiteRequest(req)) return { ok: false, reason: "cross_site", agentId, session };
  if (!isVerifiedOwner(agentId, session)) {
    return { ok: false, reason: session.agentId === agentId ? "not_verified" : "foreign", agentId, session };
  }
  const row = getDb().prepare(`SELECT is_verified FROM agents WHERE id = ?`).get(agentId) as { is_verified?: number } | undefined;
  if (!row || row.is_verified !== 1) return { ok: false, reason: "not_verified", agentId, session };
  return { ok: true, agentId, session };
}

function ownerImportAuth(req: Request, res: Response, opts: { write: boolean }): Auth {
  const agentId = String((req.params as any).id || "");
  const c = checkOwnerImportAccess(req, agentId, opts);
  if (c.ok) {
    res.setHeader("Cache-Control", "no-store");
    return c;
  }
  if (c.reason === "flag_off") {
    res.status(404).json({ success: false, error: "not_found" });
    return { ok: false };
  }
  res.setHeader("Cache-Control", "no-store");
  if (c.reason === "not_logged_in") {
    res.status(401).json({ success: false, error: "not_logged_in", message: "Du må logge inn som eier først." });
  } else if (c.reason === "cross_site") {
    res.status(403).json({ success: false, error: "forbidden", message: "Ingen tilgang." });
  } else if (c.reason === "foreign") {
    res.status(403).json({ success: false, error: "forbidden", message: "Du har ikke tilgang til denne agenten." });
  } else {
    res.status(403).json({ success: false, error: "ownership_not_verified", message: OWNER_NOT_VERIFIED_MESSAGE });
  }
  return { ok: false };
}

router.get("/api/agents/:id/product-import", (req: Request, res: Response) => {
  const auth = ownerImportAuth(req, res, { write: false });
  if (!auth.ok) return;
  try {
    return res.json({ success: true, ...getOwnerImportOverview(auth.agentId) });
  } catch (err) {
    console.error("[owner-product-import] GET overview error:", err instanceof Error ? err.message : "error");
    return res.status(500).json({ success: false, error: "internal", message: "Noe gikk galt. Prøv igjen." });
  }
});

router.post("/api/agents/:id/product-import/fetch", (req: Request, res: Response) => {
  const auth = ownerImportAuth(req, res, { write: true });
  if (!auth.ok) return;
  try {
    if (!profileWebsite(auth.agentId)) {
      return res.status(422).json({ success: false, error: "no_website", message: OWNER_IMPORT_NO_WEBSITE_MESSAGE });
    }
    const r = startOwnerFetch(auth.agentId);
    if (!r.ok) return res.status(r.status).json({ success: false, error: r.error, message: r.message });
    const id = encodeURIComponent(auth.agentId);
    return res.status(202).json({
      success: true,
      run_id: r.run_id,
      status: r.status,
      poll: `/api/agents/${id}/product-import/runs/${encodeURIComponent(r.run_id)}`,
    });
  } catch (err) {
    console.error("[owner-product-import] POST fetch error:", err instanceof Error ? err.message : "error");
    return res.status(500).json({ success: false, error: "internal", message: "Noe gikk galt. Prøv igjen." });
  }
});

router.get("/api/agents/:id/product-import/runs/:runId", (req: Request, res: Response) => {
  const auth = ownerImportAuth(req, res, { write: false });
  if (!auth.ok) return;
  try {
    const preview = getOwnerImportPreview(auth.agentId, String((req.params as any).runId || ""));
    if (!preview) return res.status(404).json({ success: false, error: "run_not_found", message: "Fant ikke hentingen." });
    return res.json({ success: true, ...preview });
  } catch (err) {
    console.error("[owner-product-import] GET run error:", err instanceof Error ? err.message : "error");
    return res.status(500).json({ success: false, error: "internal", message: "Noe gikk galt. Prøv igjen." });
  }
});

router.post("/api/agents/:id/product-import/runs/:runId/publish", (req: Request, res: Response) => {
  const auth = ownerImportAuth(req, res, { write: true });
  if (!auth.ok) return;
  const claimantEmail = sessionClaimantOwnerEmail(auth.agentId, auth.session);
  if (!claimantEmail) {
    return res.status(403).json({
      success: false,
      error: "claimant_login_required",
      message: "For å endre varene må du logge inn med e-postadressen til den som har bekreftet eierskapet til profilen.",
    });
  }
  const body = (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>;
  const rawSel = body.candidates === undefined ? [] : body.candidates;
  const rawRemove = body.remove === undefined ? [] : body.remove;
  if (!Array.isArray(rawSel) || !Array.isArray(rawRemove)) {
    return res.status(400).json({ success: false, error: "invalid", message: "candidates og remove må være lister." });
  }
  const selection: PublishSelection[] = [];
  for (const s of rawSel) {
    const id = typeof s === "string" ? s : s && typeof s === "object" ? (s as any).id : undefined;
    if (typeof id !== "string" || !id || id.length > 200) {
      return res.status(400).json({ success: false, error: "invalid", message: "Hver valgt vare må ha en id." });
    }
    selection.push(typeof s === "string" ? { id } : { id, name: (s as any).name, price: (s as any).price, unit: (s as any).unit });
  }
  if (rawRemove.length > 500 || rawRemove.some((x) => typeof x !== "string" || x.length > 200)) {
    return res.status(400).json({ success: false, error: "invalid", message: "remove må være en liste med varenavn." });
  }
  try {
    const r = publishOwnerImport(auth.agentId, String((req.params as any).runId || ""), selection, rawRemove as string[], {
      actorEmail: claimantEmail,
    });
    if (!r.ok) {
      return res.status(r.status).json({ success: false, error: r.error, message: r.message, ...(r.fields ? { fields: r.fields } : {}) });
    }
    const { ok: _ok, ...rest } = r;
    return res.json({ success: true, ...rest });
  } catch (err) {
    console.error("[owner-product-import] POST publish error:", err instanceof Error ? err.message : "error");
    return res.status(500).json({ success: false, error: "internal", message: "Noe gikk galt. Prøv igjen." });
  }
});

// ─── Portal form routes + preview page (Skive 3-2) ─────────────────────────
//
//   POST /eier/:agentId/produktimport/hent                → start a fetch, 303 to the preview page
//                                                           (429 / 409 / 503 / 422 → 303 to the portal card with a Norwegian alert)
//   GET  /eier/:agentId/produktimport/:runId              → preview page (READ-ONLY; refreshes itself while the fetch runs)
//   POST /eier/:agentId/produktimport/:runId/publiser     → «Publiser valgte» → publishOwnerImport, 303 to the portal card
//
// Plain HTML forms (work without JS), as the other portal owner actions.
// Same owner checks as the JSON API (checkOwnerImportAccess): flag off → 404,
// no session → the login page, cross-site POST → 403, not a verified owner of
// a profile with agents.is_verified = 1 → 403; publish also needs the session
// opened by the verified claimant's own e-mail (403 otherwise).

const PAGE_404 = () => portalShell("Fant ikke siden", `<div class="ep-card"><h1>Fant ikke siden</h1></div>`);
const RUN_ID_RE = /^[A-Za-z0-9_-]{1,100}$/;
const CANDIDATE_ID_RE = /^[A-Za-z0-9_-]{1,200}$/;

function ownerImportPageAuth(req: Request, res: Response, opts: { write: boolean }): Auth {
  const agentId = String((req.params as any).agentId || "");
  const c = checkOwnerImportAccess(req, agentId, opts);
  if (c.ok) {
    res.setHeader("Cache-Control", "no-store");
    return c;
  }
  if (c.reason === "flag_off") {
    res.status(404).send(PAGE_404());
    return { ok: false };
  }
  res.setHeader("Cache-Control", "no-store");
  if (c.reason === "not_logged_in") {
    res.redirect(303, `/eier/${encodeURIComponent(agentId)}`);
  } else if (c.reason === "not_verified") {
    res.status(403).send(ownerNotVerifiedPage(agentId));
  } else {
    res.status(403).send(portalShell("Ingen tilgang", `<div class="ep-card"><h1>Ingen tilgang</h1><p>Du har ikke tilgang til denne profilen.</p></div>`));
  }
  return { ok: false };
}

function importCardBack(agentId: string, status: string, extra = ""): string {
  return `/eier/${encodeURIComponent(agentId)}/portal?status=${status}${extra}#${PRODUCT_IMPORT_ANCHOR}`;
}

const FETCH_ERROR_STATUS: Record<number, string> = {
  409: "produktimport_pagar",
  422: "produktimport_ingen_nettside",
  429: "produktimport_grense",
  503: "produktimport_opptatt",
};

router.post("/eier/:agentId/produktimport/hent", express.urlencoded({ extended: false }), (req: Request, res: Response) => {
  const auth = ownerImportPageAuth(req, res, { write: true });
  if (!auth.ok) return;
  try {
    const r = startOwnerFetch(auth.agentId);
    if (!r.ok) return res.redirect(303, importCardBack(auth.agentId, FETCH_ERROR_STATUS[r.status] ?? "produktimport_feil"));
    return res.redirect(303, `/eier/${encodeURIComponent(auth.agentId)}/produktimport/${encodeURIComponent(r.run_id)}`);
  } catch (err) {
    console.error("[owner-product-import] POST hent error:", err instanceof Error ? err.message : "error");
    return res.redirect(303, importCardBack(auth.agentId, "produktimport_feil"));
  }
});

type Preview = NonNullable<ReturnType<typeof getOwnerImportPreview>>;
type PreviewCandidate = Preview["new"][number];
type PreviewChanged = Preview["changed"][number];

function formatNok(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2).replace(".", ",");
}

/**
 * The form values a candidate row starts with. The unit is the one that WILL
 * be published when the owner leaves it alone (review note N7: a candidate
 * without a unit keeps the profile's stored unit for a product it updates).
 * A candidate without a price starts with an empty price field: left empty,
 * the owner's stored price is kept. PURE.
 */
export function candidatePrefill(c: PreviewCandidate, old: { unit: string | null } | null): { name: string; price: string; unit: string } {
  const unit = c.unit ?? (old ? old.unit : null) ?? "";
  return { name: c.name, price: c.price_nok === null ? "" : formatNok(c.price_nok), unit };
}

/**
 * The publish selection for one ticked row: only the fields the owner actually
 * changed from the prefill are sent, so an untouched row publishes exactly
 * what the preview showed (stored price / unit kept where the site has none).
 * A row that matches an existing product (`old` set) never sends a name: the
 * service matches on the name, so a renamed «changed» row would be added next
 * to the old product instead of replacing it and would lose the stored unit.
 * The page shows that name read-only; this ignores a submitted one anyway.
 */
export function selectionFromForm(
  c: PreviewCandidate,
  old: { unit: string | null } | null,
  submitted: { name?: unknown; price?: unknown; unit?: unknown },
): PublishSelection {
  const pre = candidatePrefill(c, old);
  const sel: PublishSelection = { id: c.id };
  const val = (v: unknown) => (typeof v === "string" ? v.trim() : undefined);
  const name = old ? undefined : val(submitted.name);
  if (name !== undefined && name !== pre.name) sel.name = name;
  const price = val(submitted.price);
  if (price !== undefined && price !== pre.price) sel.price = price;
  const unit = val(submitted.unit);
  if (unit !== undefined && unit !== pre.unit) sel.unit = unit;
  return sel;
}

/** «kr 289 / kg» or «kr 289 (uten enhet)», with from-price / ex-VAT marks. */
function publishedPriceText(price: number | null, unit: string, isFrom: boolean, exclVat: boolean): string {
  if (price === null) return "uten pris";
  return `${isFrom ? "fra " : ""}kr ${formatNok(price)}${unit ? ` / ${unit}` : " (uten enhet)"}${exclVat ? " ekskl. mva." : ""}`;
}

interface FormState {
  selected: Set<string>;
  remove: Set<string>;
  values: Record<string, { name?: string; price?: string; unit?: string }>;
}

function candidateRowHtml(
  c: PreviewCandidate,
  kind: "new" | "changed",
  old: PreviewChanged["old"] | null,
  form: FormState | null,
  badFields: Map<string, Set<string>>,
): string {
  const pre = candidatePrefill(c, old);
  const v = form?.values[c.id] ?? {};
  const name = v.name ?? pre.name;
  const price = v.price ?? pre.price;
  const unit = v.unit ?? pre.unit;
  const checked = form ? form.selected.has(c.id) : !c.publish_blocked;
  const bad = badFields.get(c.id) ?? new Set<string>();
  const fid = escapeHtml(c.id);
  const field = (key: "navn" | "pris" | "enhet", label: string, value: string, extra: string, errKey: string) =>
    `<div class="ep-field"><label for="${key}_${fid}">${label}</label><input id="${key}_${fid}" name="${key}_${fid}" type="text" value="${escapeHtml(value)}" ${extra}${bad.has(errKey) ? ' aria-invalid="true"' : ""}>${bad.has(errKey) ? `<div class="ep-alert ep-alert-error" role="alert">Ugyldig ${label.toLowerCase()}.</div>` : ""}</div>`;
  // The unit and price that will be published if the row is left as it is.
  const keepStored = c.price_missing_on_site && kind === "changed";
  const publishes = keepStored
    ? `Prisen du har i dag beholdes${old?.price ? ` (${old.price})` : ""}.`
    : `Publiseres som: ${publishedPriceText(c.price_nok, pre.unit, c.price_is_from, c.price_excl_vat)}`;
  const oldNew = kind === "changed" && old
    ? `<div data-old-new="1">Før: <strong>${escapeHtml(old.price ?? "uten pris")}</strong> → Nå: <strong>${escapeHtml(publishedPriceText(c.price_nok, pre.unit, c.price_is_from, c.price_excl_vat))}</strong></div>`
    : "";
  const notes: string[] = [];
  if (c.price_missing_on_site) {
    notes.push(`<div class="ep-lock" data-price-missing="1">Pris mangler på nettsiden. ${kind === "changed" ? "Prisen du har i dag beholdes hvis du lar prisfeltet stå tomt." : "Legg inn en pris, ellers blir varen lagt inn uten pris."}</div>`);
  }
  if (c.price_excl_vat) notes.push(`<div class="ep-lock" data-excl-vat="1">Prisen på nettsiden er oppgitt ekskl. mva. Sjekk at det er prisen kundene skal betale.</div>`);
  if (c.price_is_from) notes.push(`<div class="ep-audit-meta" data-from-price="1">Nettsiden oppgir en «fra»-pris.</div>`);
  if (c.llm) notes.push(`<div class="ep-audit-meta" data-llm="1">Funnet ved å lese teksten på siden. Sjekk navn og pris ekstra nøye.</div>`);
  if (c.publish_blocked_text) notes.push(`<div class="ep-alert ep-alert-error" role="note" data-blocked="${escapeHtml(String(c.publish_blocked))}">${escapeHtml(c.publish_blocked_text)}</div>`);
  const source = c.source_url && /^https?:\/\//i.test(c.source_url)
    ? ` <a class="ep-audit-meta" href="${escapeHtml(c.source_url)}" rel="noopener nofollow" target="_blank">Se på nettsiden</a>`
    : "";
  return `<li class="ep-audit-item" data-candidate-id="${fid}" data-kind="${kind}">
          <label><input type="checkbox" name="velg" value="${fid}"${checked ? " checked" : ""}> <strong>${escapeHtml(c.name)}</strong></label>${source}
          ${oldNew}
          ${kind === "changed"
            ? `<div class="ep-field" data-name-locked="1"><span>Navn</span> <strong>${escapeHtml(c.name)}</strong> <span class="ep-audit-meta">Navnet kan ikke endres her, fordi varen allerede finnes i profilen din.</span></div>`
            : field("navn", "Navn", name, 'maxlength="120"', "name")}
          ${field("pris", "Pris (kr)", price, `inputmode="decimal"${keepStored && old?.price ? ` placeholder="${escapeHtml(old.price)}"` : ""}`, "price")}
          ${field("enhet", "Enhet (f.eks. kg, stk)", unit, 'maxlength="30"', "unit")}
          <div class="ep-audit-meta" data-publish-unit="${escapeHtml(pre.unit)}">${escapeHtml(publishes)}</div>
          ${notes.join("\n          ")}
        </li>`;
}

export function renderImportPreviewPage(
  agentId: string,
  p: Preview,
  opts: { claimant: boolean; errorText?: string | null; form?: FormState | null; fields?: Array<{ id: string; field: string }> } = { claimant: true },
): string {
  const id = encodeURIComponent(agentId);
  const self = `/eier/${id}/produktimport/${encodeURIComponent(p.run_id)}`;
  const back = `/eier/${id}/portal#${PRODUCT_IMPORT_ANCHOR}`;
  const when = formatImportRunTime(p.created_at);
  const website = p.website ?? "";
  const head = `<div class="ep-card">
        <h1>Produkter fra nettsiden din</h1>
        <p>Hentet fra <strong>${escapeHtml(website)}</strong>${when ? ` ${escapeHtml(when)}` : ""}.</p>
        ${opts.errorText ? `<div class="ep-alert ep-alert-error" role="alert" data-publish-error="1">${escapeHtml(opts.errorText)}</div>` : ""}
      </div>`;
  if (p.status === "running") {
    return `${head}
      <div class="ep-card" data-import-status="running">
        <p role="status" aria-live="polite">Vi henter produkter fra nettsiden din. Det tar vanligvis under ett minutt. Siden oppdateres av seg selv.</p>
        <p><a class="ep-btn ep-btn-secondary" href="${self}">Oppdater nå</a> <a class="ep-btn ep-btn-ghost" href="${back}">Tilbake til portalen</a></p>
      </div>`;
  }
  const totalCandidates = p.counts.new + p.counts.changed + p.counts.unchanged + p.counts.published + p.counts.rejected;
  const addYourself = ownerOrderabilityPortalEnabledFor(agentId)
    ? `<a class="ep-btn ep-btn-primary" href="/eier/${id}/portal#${ORDERABILITY_ANCHOR}">Legg inn varer selv</a>`
    : "";
  if (p.status !== "completed" || totalCandidates === 0) {
    const explain = productImportOutcomeTextNb(p.outcome);
    // failed / interrupted / timed-out runs stage nothing, so this is the
    // zero-result screen for every non-completed run too.
    const title = "Fant ingen produkter med pris på nettsiden. Legg dem inn selv.";
    return `${head}
      <div class="ep-card" data-import-status="${escapeHtml(p.status)}" data-import-zero="1"${p.outcome ? ` data-import-outcome="${escapeHtml(p.outcome)}"` : ""}>
        <p><strong>${escapeHtml(title)}</strong></p>
        ${explain ? `<p data-outcome-text="1">${escapeHtml(explain)}</p>` : ""}
        <p>${addYourself} <a class="ep-btn ep-btn-secondary" href="${back}">Tilbake til portalen</a></p>
      </div>`;
  }

  const badFields = new Map<string, Set<string>>();
  for (const f of opts.fields ?? []) {
    if (!badFields.has(f.id)) badFields.set(f.id, new Set());
    badFields.get(f.id)!.add(f.field);
  }
  const form = opts.form ?? null;
  const section = (title: string, attr: string, intro: string, rows: string[], empty: string) => `
        <h2 ${attr}>${escapeHtml(title)} (${rows.length})</h2>
        ${intro ? `<p class="ep-audit-meta">${escapeHtml(intro)}</p>` : ""}
        ${rows.length ? `<ul class="ep-audit-list">${rows.join("")}</ul>` : `<p class="ep-audit-meta">${escapeHtml(empty)}</p>`}`;
  const newRows = p.new.map((c) => candidateRowHtml(c, "new", null, form, badFields));
  const changedRows = p.changed.map((c) => candidateRowHtml(c, "changed", c.old, form, badFields));
  const notFoundRows = p.not_found.map((c) => {
    const checked = form ? form.remove.has(c.name) : false; // never preselected
    return `<li class="ep-audit-item" data-not-found="${escapeHtml(c.name)}">
          <label><input type="checkbox" name="fjern" value="${escapeHtml(c.name)}"${checked ? " checked" : ""}> Fjern <strong>${escapeHtml(c.name)}</strong> fra profilen</label>
          <span class="ep-audit-meta">${escapeHtml(c.price ?? "uten pris")}</span>
        </li>`;
  });
  const unchanged = p.unchanged.length
    ? `<details><summary>Uendret (${p.unchanged.length})</summary><ul class="ep-audit-list">${p.unchanged
        .map((c) => `<li class="ep-audit-item">${escapeHtml(c.name)} <span class="ep-audit-meta">${escapeHtml(
          c.price_missing_on_site
            ? "pris mangler på nettsiden, prisen du har i dag beholdes"
            : publishedPriceText(c.price_nok, c.unit ?? c.old.unit ?? "", c.price_is_from, c.price_excl_vat),
        )}</span></li>`)
        .join("")}</ul></details>`
    : "";
  const done = p.published.length + p.rejected.length
    ? `<details><summary>Allerede behandlet (${p.published.length + p.rejected.length})</summary><ul class="ep-audit-list">${[
        ...p.published.map((c) => `<li class="ep-audit-item">${escapeHtml(c.name)} <span class="ep-audit-meta">publisert</span></li>`),
        ...p.rejected.map((c) => `<li class="ep-audit-item">${escapeHtml(c.name)} <span class="ep-audit-meta">${escapeHtml(c.publish_blocked_text ?? "ikke lagt inn")}</span></li>`),
      ].join("")}</ul></details>`
    : "";
  const claimantNote = opts.claimant
    ? ""
    : `<div class="ep-alert ep-alert-error" role="note" data-claimant-login-required="1">For å publisere må du logge inn med e-postadressen til den som har bekreftet eierskapet til profilen. <a href="/selger?agent=${id}">Logg inn med eierens e-post</a></div>`;
  return `${head}
      <div class="ep-card" data-import-status="completed">
        <p>Kryss av for varene du vil legge inn, og rett navn, pris eller enhet om noe er feil. Varene du har i dag, beholdes med mindre du krysser av for å fjerne dem.</p>
        <form method="post" action="${self}/publiser">
          ${section("Nye produkter", 'data-section="new"', "", newRows, "Ingen nye produkter.")}
          ${section("Endret pris eller enhet", 'data-section="changed"', "Gammel pris → ny pris fra nettsiden.", changedRows, "Ingen endringer i pris eller enhet.")}
          ${section("Ikke funnet på nettsiden", 'data-section="not_found"', "Disse varene har du i profilen i dag, men vi fant dem ikke på nettsiden. De blir ikke fjernet med mindre du krysser av.", notFoundRows, "Alle varene dine ble funnet.")}
          ${unchanged}
          ${done}
          <p class="ep-audit-meta" data-stock-note="1">Varer du publiserer, vises på profilen din, men kan ikke bestilles før du har bekreftet at de er på lager.</p>
          ${claimantNote}
          <div class="ep-form-actions">
            <button type="submit" class="ep-btn ep-btn-primary">Publiser valgte</button>
            <a href="${back}" class="ep-btn ep-btn-secondary">Avbryt</a>
          </div>
        </form>
      </div>`;
}

function pageTitle(): string {
  return "Produkter fra nettsiden din";
}

router.get("/eier/:agentId/produktimport/:runId", (req: Request, res: Response) => {
  const auth = ownerImportPageAuth(req, res, { write: false });
  if (!auth.ok) return;
  try {
    const runId = String((req.params as any).runId || "");
    const preview = RUN_ID_RE.test(runId) ? getOwnerImportPreview(auth.agentId, runId) : null;
    if (!preview) return res.status(404).send(PAGE_404());
    const claimant = !!sessionClaimantOwnerEmail(auth.agentId, auth.session);
    const html = renderImportPreviewPage(auth.agentId, preview, { claimant });
    const headHtml = preview.status === "running" ? `<meta http-equiv="refresh" content="4">` : undefined;
    return res.send(portalShell(pageTitle(), html, { headHtml }));
  } catch (err) {
    console.error("[owner-product-import] GET preview page error:", err instanceof Error ? err.message : "error");
    return res.status(500).send(portalShell("Feil", `<div class="ep-card"><h1>Noe gikk galt</h1><p>Prøv igjen om litt.</p></div>`));
  }
});

const asList = (v: unknown): string[] => (Array.isArray(v) ? v : v === undefined ? [] : [v]).filter((x): x is string => typeof x === "string");

router.post("/eier/:agentId/produktimport/:runId/publiser", express.urlencoded({ extended: false, parameterLimit: 5000 }), (req: Request, res: Response) => {
  const auth = ownerImportPageAuth(req, res, { write: true });
  if (!auth.ok) return;
  const claimantEmail = sessionClaimantOwnerEmail(auth.agentId, auth.session);
  if (!claimantEmail) return res.status(403).send(ownerProductsNeedClaimantLoginPage(auth.agentId));
  try {
    const runId = String((req.params as any).runId || "");
    const preview = RUN_ID_RE.test(runId) ? getOwnerImportPreview(auth.agentId, runId) : null;
    if (!preview) return res.status(404).send(PAGE_404());
    const body = (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>;
    const rows = new Map<string, { c: PreviewCandidate; old: { unit: string | null } | null }>();
    for (const c of preview.new) rows.set(c.id, { c, old: null });
    for (const c of preview.changed) rows.set(c.id, { c, old: c.old });
    const ticked = [...new Set(asList(body.velg).filter((x) => CANDIDATE_ID_RE.test(x)))].slice(0, 500);
    const remove = [...new Set(asList(body.fjern).filter((x) => x.length > 0 && x.length <= 200))].slice(0, 500);
    const selection: PublishSelection[] = [];
    const form: FormState = { selected: new Set(ticked), remove: new Set(remove), values: {} };
    for (const c of rows.values()) {
      const v = { name: body[`navn_${c.c.id}`], price: body[`pris_${c.c.id}`], unit: body[`enhet_${c.c.id}`] };
      form.values[c.c.id] = {
        name: typeof v.name === "string" ? v.name : undefined,
        price: typeof v.price === "string" ? v.price : undefined,
        unit: typeof v.unit === "string" ? v.unit : undefined,
      };
    }
    for (const tid of ticked) {
      const row = rows.get(tid);
      // A ticked id that is not a pending new/changed row of this run goes
      // through as-is: publishOwnerImport answers 404 / 409 for it.
      selection.push(row ? selectionFromForm(row.c, row.old, form.values[tid]!) : { id: tid });
    }
    const r = publishOwnerImport(auth.agentId, runId, selection, remove, { actorEmail: claimantEmail });
    if (r.ok) {
      return res.redirect(303, importCardBack(
        auth.agentId,
        "produktimport_publisert",
        `&publisert=${r.published.length}&fjernet=${r.removed.length}&avvist=${r.rejected.length}`,
      ));
    }
    const html = renderImportPreviewPage(auth.agentId, preview, { claimant: true, errorText: r.message, form, fields: r.fields });
    return res.status(r.status).send(portalShell(pageTitle(), html));
  } catch (err) {
    console.error("[owner-product-import] POST publiser error:", err instanceof Error ? err.message : "error");
    return res.status(500).send(portalShell("Feil", `<div class="ep-card"><h1>Noe gikk galt</h1><p>Ingenting er endret. Prøv igjen om litt.</p></div>`));
  }
});

export default router;
