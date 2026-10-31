// ─── Owner landing page for the outreach pre-extraction (Skive 3b-2) ────────
//
// dev-request 2026-10-21-rfb-produktimport-fra-egen-nettside, Skive 3b:
// the recipient of an outreach e-mail opens a signed link and confirms the
// products 3b-1 pre-extracted from their own website.
//
//   GET  /eier/:agentId/varer/forslag?t=<token>   the list (or login / claim page)
//   POST /eier/:agentId/varer/forslag             «Bekreft og legg inn»
//
// Behind PRODUCT_IMPORT_OUTREACH_ENABLED (off → 404 on both, nothing done).
//
// GET writes no product, profile or candidate. It writes:
//   - one append-only 'opened' row in product_import_outreach_events (the
//     pilot's response log; deduplicated per hour), for a valid token only;
//   - with a verified owner's session and a list older than 7 days: the
//     Skive 3 owner fetch (a product_import_runs row + staged 'pending'
//     candidates, counted against the owner's 3/day limit) and its
//     'refetch_started' log row. E-mail scanners have no owner session, so
//     they can never start it.
// No candidates are shown without a session for this agent (→ login page,
// with the rfb_owner_return cookie so the /eier magic link comes back here)
// or without a verified owner (segment B → «ta over profilen» via /selger).
// The token alone never shows candidates and never grants a write.
//
// POST needs, in this order: a valid token for this agent, the owner session,
// the shared same-origin write guard, isVerifiedOwner + agents.is_verified = 1,
// the verified claimant's own e-mail (as «Publiser valgte»), and a run id
// that belongs to THIS agent's campaign (outreachRunsFor). It publishes the
// ticked candidates with the owner's edits through publishOwnerImport (merge,
// source 'owner_import', owner lock; never removes products) and, only when
// «Varene er på lager» is ticked, marks the published rows in stock through
// the B1 owner path (confirmOwnerProductInStock). Logs 'confirmed'.

import express, { Router, Request, Response } from "express";
import { getDb } from "../database/init";
import { isCrossSiteWrite } from "../middleware/same-origin-write";
import {
  escapeHtml,
  isVerifiedOwner,
  ownerProductsNeedClaimantLoginPage,
  portalShell,
  portalWriteRefusedPage,
  sessionClaimantOwnerEmail,
  verifyOwnerSession,
} from "./owner-portal";
import { publishSelectionFromForm, renderImportPreviewPage, type FormState, type Preview, type PreviewVariant } from "./owner-product-import";
import { outreachLlmAllowed, productImportOutreachEnabled } from "../services/product-import/outreach-prepare";
import {
  getOwnerImportPreview,
  isOwnerFetchJobRunning,
  publishOwnerImport,
} from "../services/product-import/owner-import";
import {
  logOutreachEvent,
  logOutreachOpened,
  OUTREACH_LANDING_SUFFIX,
  OUTREACH_RETURN_COOKIE,
  outreachLandingPath,
  outreachRunsFor,
  resolveOutreachView,
  verifyOutreachToken,
  type OutreachNotice,
} from "../services/product-import/outreach-landing";
import { confirmOwnerProductInStock } from "../services/owner-orderability";
import { normalizeName } from "../services/product-catalog-sync";
import { formatImportRunTime } from "./owner-portal";

const router = Router();

const PATH = `/eier/:agentId${OUTREACH_LANDING_SUFFIX}`;
const TITLE = "Varer fra nettsiden din";
const RUN_ID_RE = /^[A-Za-z0-9_-]{1,100}$/;
const RETURN_COOKIE_MS = 24 * 60 * 60 * 1000;

const PAGE_404 = () => portalShell("Fant ikke siden", `<div class="ep-card"><h1>Fant ikke siden</h1></div>`);

/** Neutral: says nothing about the agent, the campaign or why. */
const linkUnusablePage = () =>
  portalShell(
    "Lenken virker ikke",
    `<div class="ep-card" data-outreach-link="unusable">
        <h1>Lenken virker ikke</h1>
        <p>Lenken er ugyldig eller har utløpt. Du kan logge inn i eierportalen og legge inn varene selv, eller svare på e-posten du fikk fra oss.</p>
        <p><a class="ep-btn ep-btn-secondary" href="/">Til forsiden</a></p>
      </div>`,
  );

function loginPage(agentId: string): string {
  const id = encodeURIComponent(agentId);
  return portalShell(
    "Logg inn",
    `<div class="ep-card" data-outreach-login="1">
        <h1>Logg inn for å se varene</h1>
        <p>Vi har funnet varer på nettsiden din som du kan legge inn på profilen. Logg inn i eierportalen først. Etter innloggingen kommer du tilbake hit.</p>
        <p><a class="ep-btn ep-btn-primary" href="/eier/${id}">Logg inn</a></p>
        <p class="ep-audit-meta">Åpner du innloggingslenken på en annen enhet, åpner du lenken i e-posten fra oss på nytt etterpå.</p>
      </div>`,
  );
}

function claimPage(agentId: string): string {
  const id = encodeURIComponent(agentId);
  return portalShell(
    "Ta over profilen",
    `<div class="ep-card" data-outreach-claim="1">
        <h1>Ta over profilen først</h1>
        <p>Før du kan se og legge inn varene, må du bekrefte at du eier profilen. Når eierskapet er bekreftet, åpner du lenken i e-posten fra oss på nytt, så ligger varene klare.</p>
        <p><a class="ep-btn ep-btn-primary" href="/selger?agent=${id}">Ta over profilen</a></p>
      </div>`,
  );
}

function noListPage(agentId: string): string {
  return portalShell(
    TITLE,
    `<div class="ep-card" data-outreach-none="1">
        <h1>Ingen varer å vise</h1>
        <p>Vi har ingen varer fra nettsiden din å vise akkurat nå. Du kan legge inn varene selv i eierportalen.</p>
        <p><a class="ep-btn ep-btn-secondary" href="/eier/${encodeURIComponent(agentId)}/portal">Til eierportalen</a></p>
      </div>`,
  );
}

function noticeHtml(notice: OutreachNotice | null, extractedAt: string): string {
  if (!notice) return "";
  const when = formatImportRunTime(extractedAt);
  const text =
    notice === "refetch_unavailable"
      ? `Vi klarte ikke å hente varene på nytt nå. Listen under ble hentet ${when}. Sjekk at prisene stemmer.`
      : notice === "refetch_failed"
        ? `Vi prøvde å hente varene på nytt, men det gikk ikke. Listen under ble hentet ${when}. Sjekk at prisene stemmer.`
        : `Listen under ble hentet ${when}. Sjekk at prisene stemmer.`;
  return `<div class="ep-alert ep-alert-error" role="note" data-outreach-notice="${escapeHtml(notice)}">${escapeHtml(text)}</div>`;
}

function stockChoiceHtml(checked: boolean): string {
  return `<div class="ep-field" data-stock-choice="1">
            <label><input type="checkbox" name="paa_lager" value="1"${checked ? " checked" : ""}> Varene er på lager, kunder kan bestille dem</label>
            <div class="ep-audit-meta">Uten dette vises varene på profilen din, men kan ikke bestilles før du har bekreftet at de er på lager.</div>
          </div>`;
}

function variantFor(agentId: string, token: string, runId: string, notice: OutreachNotice | null, extractedAt: string, stockChecked: boolean): PreviewVariant {
  return {
    title: TITLE,
    selfHref: outreachLandingPath(agentId, token),
    actionHref: `/eier/${encodeURIComponent(agentId)}${OUTREACH_LANDING_SUFFIX}`,
    submitLabel: "Bekreft og legg inn",
    hiddenFields: { t: token, run: runId },
    noticeHtml: noticeHtml(notice, extractedAt),
    stockChoiceHtml: stockChoiceHtml(stockChecked),
  };
}

/**
 * The 3b controls on what the page may show and publish, whatever run it
 * reads (a re-fetch is a Skive 3 owner fetch, which stages every row as
 * pending): no row the order gate blocks (category label, alcohol, service,
 * failed check) and no LLM-tier row unless the measured LLM accuracy allows
 * it. The POST publishes only ids that are still in the filtered lists.
 */
export function outreachVisiblePreview(p: Preview, llmAllowed: boolean = outreachLlmAllowed()): Preview {
  const ok = (c: { publish_blocked: unknown; llm: boolean }) => !c.publish_blocked && (llmAllowed || !c.llm);
  const out: Preview = { ...p, new: p.new.filter(ok), changed: p.changed.filter(ok), unchanged: p.unchanged.filter(ok) };
  out.counts = { ...p.counts, new: out.new.length, changed: out.changed.length, unchanged: out.unchanged.length };
  return out;
}

function ownerIsVerified(agentId: string, session: ReturnType<typeof verifyOwnerSession>): boolean {
  if (!isVerifiedOwner(agentId, session)) return false;
  const row = getDb().prepare(`SELECT is_verified FROM agents WHERE id = ?`).get(agentId) as { is_verified?: number } | undefined;
  return !!row && row.is_verified === 1;
}

function setReturnCookie(res: Response, agentId: string, token: string): void {
  res.cookie(OUTREACH_RETURN_COOKIE, outreachLandingPath(agentId, token), {
    path: "/",
    maxAge: RETURN_COOKIE_MS,
    httpOnly: true,
    secure: true,
    sameSite: "lax",
  });
}

function noStore(res: Response): void {
  res.setHeader("Cache-Control", "no-store");
  // The token is in the URL: never send it on to the producer's own website.
  res.setHeader("Referrer-Policy", "no-referrer");
}

router.get(PATH, (req: Request, res: Response) => {
  if (!productImportOutreachEnabled()) return res.status(404).send(PAGE_404());
  noStore(res);
  try {
    const agentId = String((req.params as any).agentId || "");
    const token = typeof req.query?.t === "string" ? req.query.t : "";
    const tok = verifyOutreachToken(token, agentId);
    if (tok.state !== "valid") return res.status(tok.state === "expired" ? 410 : 404).send(linkUnusablePage());
    const session = verifyOwnerSession(req);
    if (!session.valid || session.agentId !== agentId) {
      logOutreachOpened(tok.campaign, agentId, "no_session");
      setReturnCookie(res, agentId, token);
      return res.send(loginPage(agentId));
    }
    if (!ownerIsVerified(agentId, session)) {
      logOutreachOpened(tok.campaign, agentId, "not_verified");
      setReturnCookie(res, agentId, token);
      return res.send(claimPage(agentId));
    }
    logOutreachOpened(tok.campaign, agentId, "owner");
    const view = resolveOutreachView(agentId, tok.campaign, { allowRefetch: true, isJobRunning: isOwnerFetchJobRunning });
    if (view.kind === "none") return res.send(noListPage(agentId));
    const runId = view.run_id;
    const mode = view.kind === "list" ? view.mode : "owner_fetch";
    const raw = getOwnerImportPreview(agentId, runId, { mode });
    if (!raw) return res.send(noListPage(agentId));
    const preview = outreachVisiblePreview(raw);
    const claimant = !!sessionClaimantOwnerEmail(agentId, session);
    const variant = variantFor(agentId, token, runId, view.kind === "list" ? view.notice : null, view.kind === "list" ? view.extracted_at : preview.created_at, false);
    const html = renderImportPreviewPage(agentId, preview, { claimant, variant });
    const headHtml = preview.status === "running" ? `<meta http-equiv="refresh" content="4">` : undefined;
    return res.send(portalShell(TITLE, html, { headHtml }));
  } catch (err) {
    console.error("[owner-product-outreach] GET error:", err instanceof Error ? err.message : "error");
    return res.status(500).send(portalShell("Feil", `<div class="ep-card"><h1>Noe gikk galt</h1><p>Prøv igjen om litt.</p></div>`));
  }
});

function receiptPage(agentId: string, published: number, rejected: number, inStock: { chosen: boolean; confirmed: number; notConfirmed: number }): string {
  const id = encodeURIComponent(agentId);
  const word = (n: number) => (n === 1 ? "vare" : "varer");
  const stock = inStock.chosen
    ? inStock.notConfirmed > 0
      ? `${inStock.confirmed} ${word(inStock.confirmed)} er merket som på lager og kan bestilles. ${inStock.notConfirmed} kunne ikke merkes som på lager (for eksempel uten pris). Det kan du gjøre i eierportalen.`
      : `Varene er merket som på lager og kan bestilles.`
    : "Varene vises på profilen din, men kan ikke bestilles før du har bekreftet at de er på lager. Det kan du gjøre i eierportalen.";
  return portalShell(
    TITLE,
    `<div class="ep-card" data-outreach-confirmed="${published}" data-outreach-in-stock="${inStock.chosen ? inStock.confirmed : 0}">
        <h1>Takk, varene er lagt inn</h1>
        <p>${published} ${word(published)} er lagt inn på profilen din.${rejected > 0 ? ` ${rejected} ${word(rejected)} kunne ikke legges inn.` : ""}</p>
        <p>${escapeHtml(stock)}</p>
        <p><a class="ep-btn ep-btn-primary" href="/eier/${id}/portal">Til eierportalen</a></p>
      </div>`,
  );
}

router.post(PATH, express.urlencoded({ extended: false, parameterLimit: 5000 }), (req: Request, res: Response) => {
  if (!productImportOutreachEnabled()) return res.status(404).send(PAGE_404());
  noStore(res);
  try {
    const agentId = String((req.params as any).agentId || "");
    const body = (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>;
    const token = typeof body.t === "string" ? body.t : "";
    const tok = verifyOutreachToken(token, agentId);
    if (tok.state !== "valid") return res.status(tok.state === "expired" ? 410 : 404).send(linkUnusablePage());
    const session = verifyOwnerSession(req);
    if (!session.valid || session.agentId !== agentId) return res.status(401).send(loginPage(agentId));
    if (isCrossSiteWrite(req)) return res.status(403).send(portalWriteRefusedPage(outreachLandingPath(agentId, token), "Tilbake til varene"));
    if (!ownerIsVerified(agentId, session)) return res.status(403).send(claimPage(agentId));
    const claimantEmail = sessionClaimantOwnerEmail(agentId, session);
    if (!claimantEmail) return res.status(403).send(ownerProductsNeedClaimantLoginPage(agentId));

    const runId = typeof body.run === "string" && RUN_ID_RE.test(body.run) ? body.run : "";
    // Only a run of THIS agent's campaign: the token's agent + campaign pick the set.
    const mode = runId ? outreachRunsFor(agentId, tok.campaign).get(runId) : undefined;
    const raw = mode ? getOwnerImportPreview(agentId, runId, { mode }) : null;
    if (!mode || !raw) return res.status(404).send(linkUnusablePage());
    const preview = outreachVisiblePreview(raw);

    const inStock = body.paa_lager === "1";
    const { selection: ticked, form } = publishSelectionFromForm(preview, body);
    // Only ids the page shows: a hidden (LLM / blocked) or foreign id is ignored.
    const shown = new Set([...preview.new, ...preview.changed].map((c) => c.id));
    const selection = ticked.filter((s) => shown.has(s.id));
    const r = publishOwnerImport(agentId, runId, selection, [], { actorEmail: claimantEmail, mode });
    if (!r.ok) {
      const formState: FormState = { ...form, remove: new Set() };
      const variant = variantFor(agentId, token, runId, null, preview.created_at, inStock);
      const html = renderImportPreviewPage(agentId, preview, { claimant: true, errorText: r.message, form: formState, fields: r.fields, variant });
      return res.status(r.status).send(portalShell(TITLE, html));
    }

    let confirmed = 0;
    let notConfirmed = 0;
    if (inStock && r.published.length > 0) {
      const db = getDb();
      const byNorm = db.prepare(`SELECT id FROM products WHERE agent_id = ? AND name_norm = ?`);
      for (const p of r.published) {
        const row = byNorm.get(agentId, normalizeName(p.name)) as { id: string } | undefined;
        const c = row ? confirmOwnerProductInStock(agentId, row.id, { actorEmail: claimantEmail }) : null;
        if (c && c.ok) confirmed++;
        else notConfirmed++;
      }
    }
    try {
      logOutreachEvent({ campaign: tok.campaign, agentId, event: "confirmed", runId, count: r.published.length, inStock });
    } catch (e) {
      console.error("[owner-product-outreach] log confirmed failed:", e instanceof Error ? e.message : "error");
    }
    return res.send(receiptPage(agentId, r.published.length, r.rejected.length, { chosen: inStock, confirmed, notConfirmed }));
  } catch (err) {
    console.error("[owner-product-outreach] POST error:", err instanceof Error ? err.message : "error");
    return res.status(500).send(portalShell("Feil", `<div class="ep-card"><h1>Noe gikk galt</h1><p>Prøv igjen om litt.</p></div>`));
  }
});

export default router;
