// ─── servePublicFile: one file from src/public as a route handler ───────────
// A2A dev-request 2026-10-16-finn-tannlege-tillit-kilder-metode-ikon (F2-S4).
//
// Same behaviour as serveOpplevagentPublicFile in experiences-seo.ts, which
// stays as it is: the file is read from src/public on each request and sent
// with the given Content-Type and a one-day cache. A file missing on disk is
// next(), so the host's own 404 page answers instead of a crash. The
// Dockerfile copies src/, so a file committed under src/public/ ships without
// a build step.
//
// `fileName` is a constant in the calling route, never request input.

import * as fs from "fs";
import * as path from "path";
import type { NextFunction, Request, Response } from "express";

export const PUBLIC_DIR = path.join(__dirname, "..", "public");

export function servePublicFile(fileName: string, contentType: string) {
  return (_req: Request, res: Response, next: NextFunction): void => {
    let data: Buffer;
    try {
      data = fs.readFileSync(path.join(PUBLIC_DIR, fileName));
    } catch {
      return next();
    }
    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.send(data);
  };
}
