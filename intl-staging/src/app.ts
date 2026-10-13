// HTTP surface of the staging service. Every route except /health requires the
// bearer token; nothing here is public, indexed or listable (DPIA T10, T17).
import crypto from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import type { DB } from "./db";
import { dbBytes, diskUsedPct, type Limits, resourceProblem } from "./guards";
import { type ImportCounts, type ImportSources, lastImport, runSeImport } from "./se-import";
import {
  addSearchCandidate,
  HttpError,
  isOptedOut,
  leaseCandidates,
  leaseDrafts,
  optout,
  pause,
  pausedState,
  purge,
  registerSearch,
  resume,
  sample,
  stats,
  submitDraft,
  submitVerdict,
} from "./store";

export interface AppDeps {
  db: DB;
  dataDir: string;
  dbFile: string;
  token: string | undefined;
  hmacKey: string | undefined;
  limits: Limits;
  now: () => Date;
  importSources: ImportSources;
}

function tokenMatches(given: string, expected: string): boolean {
  const a = crypto.createHash("sha256").update(given).digest();
  const b = crypto.createHash("sha256").update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

export function createApp(deps: AppDeps) {
  const { db, now } = deps;
  const app = express();
  app.disable("x-powered-by");
  app.use((_req, res, next) => {
    res.setHeader("X-Robots-Tag", "noindex, nofollow");
    res.setHeader("Cache-Control", "no-store");
    next();
  });
  app.use(express.json({ limit: "512kb" }));

  let importState: { import_id: string; state: "running" | "done" | "failed"; started_at: string; finished_at?: string; counts?: ImportCounts; error?: string } | null = null;

  // Housekeeping on traffic as well as on the timer: the timer does not tick
  // while Fly has the machine suspended (review 2026-10-13), so expired page
  // excerpts are also dropped on the first requests after a wake-up.
  let lastPurge = 0;
  app.use((_req, _res, next) => {
    const t = now().getTime();
    if (t - lastPurge > 10 * 60 * 1000) {
      lastPurge = t;
      try {
        purge(db, now());
      } catch (e) {
        console.error("[intl-staging] purge failed", (e as Error).message);
      }
    }
    next();
  });

  app.get("/health", (_req, res) => {
    res.json({
      status: "ok",
      service: "rfb-intl-staging",
      paused: !!pausedState(db),
      disk_used_pct: diskUsedPct(deps.dataDir),
      db_mb: Math.round(dbBytes(deps.dbFile) / 1048576),
      import_running: importState?.state === "running",
    });
  });

  // Bearer token on everything below. Fails closed when no token is configured.
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (!deps.token) return res.status(503).json({ error: "token_not_configured" });
    const h = req.header("authorization") || "";
    const m = /^Bearer (.+)$/.exec(h);
    if (!m || !tokenMatches(m[1], deps.token)) return res.status(401).json({ error: "unauthorized" });
    next();
  });

  // Resource guard on every write: pause and refuse before the volume fills.
  const guardWrites = (_req: Request, res: Response, next: NextFunction) => {
    const problem = resourceProblem(deps.dataDir, deps.dbFile, deps.limits);
    if (problem) {
      pause(db, problem, now());
      return res.status(507).json({ error: "insufficient_storage", detail: problem });
    }
    next();
  };

  const wrap = (fn: (req: Request) => unknown) => (req: Request, res: Response) => {
    try {
      res.json(fn(req));
    } catch (e) {
      if (e instanceof HttpError) return res.status(e.status).json({ error: e.code, detail: e.detail });
      console.error("[intl-staging] unhandled", e);
      res.status(500).json({ error: "internal" });
    }
  };

  app.get("/stats", wrap(() => ({ ...stats(db), last_import: lastImport(db), import: importState, disk_used_pct: diskUsedPct(deps.dataDir), db_mb: Math.round(dbBytes(deps.dbFile) / 1048576) })));
  app.get("/sample", wrap((req) => ({ profiles: sample(db, Number(req.query.n) || 10) })));
  app.get("/register/search", wrap((req) => registerSearch(db, { name: req.query.name, town: req.query.town })));

  app.post("/candidates/lease", guardWrites, wrap((req) => leaseCandidates(db, req.body || {}, now())));
  app.post("/candidates/from-search", guardWrites, wrap((req) => addSearchCandidate(db, req.body || {}, now())));
  app.post("/candidates/:id/draft", guardWrites, wrap((req) => submitDraft(db, String(req.params.id), req.body || {}, now())));
  app.post("/judge/lease", guardWrites, wrap((req) => leaseDrafts(db, req.body || {}, now())));
  app.post("/drafts/:id/verdict", guardWrites, wrap((req) => submitVerdict(db, Number(req.params.id), req.body || {}, now())));

  app.post("/pause", wrap((req) => {
    const reason = typeof req.body?.reason === "string" && req.body.reason ? req.body.reason.slice(0, 300) : "manual";
    pause(db, reason, now());
    return { paused: pausedState(db) };
  }));
  app.post("/resume", wrap(() => {
    resume(db, now());
    return { paused: null };
  }));
  app.post("/purge", wrap(() => purge(db, now())));
  app.post("/optout", wrap((req) => {
    if (!deps.hmacKey) throw new HttpError(503, "hmac_key_not_configured");
    return optout(db, req.body || {}, deps.hmacKey, now());
  }));

  app.post("/import/se", guardWrites, (_req, res) => {
    // Without the HMAC key the opt-out list cannot be read, and an import must
    // never quietly bring back a unit that asked to be removed.
    if (!deps.hmacKey) return res.status(503).json({ error: "hmac_key_not_configured" });
    if (importState?.state === "running") return res.status(409).json({ error: "import_running", import: importState });
    const importId = `imp-${now().toISOString()}`;
    importState = { import_id: importId, state: "running", started_at: now().toISOString() };
    const key = deps.hmacKey;
    runSeImport(db, deps.importSources, {
      importId,
      now,
      isOptedOut: (orgNr) => isOptedOut(db, orgNr, key as string),
      onProgress: (c) => {
        if (importState) importState.counts = c;
      },
    })
      .then((counts) => {
        importState = { ...(importState as NonNullable<typeof importState>), state: "done", finished_at: now().toISOString(), counts };
      })
      .catch((e: Error) => {
        console.error("[intl-staging] import failed", e);
        importState = { ...(importState as NonNullable<typeof importState>), state: "failed", finished_at: now().toISOString(), error: e.message.slice(0, 500) };
      });
    res.status(202).json({ import: importState });
  });
  app.get("/import/status", wrap(() => ({ import: importState, last_import: lastImport(db) })));

  app.use((_req, res) => res.status(404).json({ error: "not_found" }));
  // Error handler: never let Express log or echo a request body. A malformed or
  // truncated JSON body can carry page text (review 2026-10-13).
  app.use((err: { status?: number; type?: string }, _req: Request, res: Response, _next: NextFunction) => {
    const status = typeof err?.status === "number" && err.status >= 400 && err.status < 600 ? err.status : 500;
    if (status >= 500) console.error("[intl-staging] request error", err?.type || "internal");
    res.status(status).json({ error: err?.type || (status >= 500 ? "internal" : "bad_request") });
  });
  return app;
}
