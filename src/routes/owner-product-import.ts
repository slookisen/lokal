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

import { Router, Request, Response } from "express";
import { getDb } from "../database/init";
import {
  crossSiteRequest,
  isVerifiedOwner,
  OWNER_NOT_VERIFIED_MESSAGE,
  sessionClaimantOwnerEmail,
  verifyOwnerSession,
} from "./owner-portal";
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

type Auth = { ok: true; agentId: string; session: ReturnType<typeof verifyOwnerSession> } | { ok: false };

function ownerImportAuth(req: Request, res: Response, opts: { write: boolean }): Auth {
  if (!productImportEnabled()) {
    res.status(404).json({ success: false, error: "not_found" });
    return { ok: false };
  }
  const agentId = String((req.params as any).id || "");
  res.setHeader("Cache-Control", "no-store");
  const session = verifyOwnerSession(req);
  if (!session.valid) {
    res.status(401).json({ success: false, error: "not_logged_in", message: "Du må logge inn som eier først." });
    return { ok: false };
  }
  if (opts.write && crossSiteRequest(req)) {
    res.status(403).json({ success: false, error: "forbidden", message: "Ingen tilgang." });
    return { ok: false };
  }
  if (!isVerifiedOwner(agentId, session)) {
    res.status(403).json(
      session.agentId === agentId
        ? { success: false, error: "ownership_not_verified", message: OWNER_NOT_VERIFIED_MESSAGE }
        : { success: false, error: "forbidden", message: "Du har ikke tilgang til denne agenten." },
    );
    return { ok: false };
  }
  const row = getDb().prepare(`SELECT is_verified FROM agents WHERE id = ?`).get(agentId) as { is_verified?: number } | undefined;
  if (!row || row.is_verified !== 1) {
    res.status(403).json({ success: false, error: "ownership_not_verified", message: OWNER_NOT_VERIFIED_MESSAGE });
    return { ok: false };
  }
  return { ok: true, agentId, session };
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

export default router;
