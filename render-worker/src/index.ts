// Lokal Render Worker
// Standalone HTTP service that renders JS-heavy pages with
// headless Chromium and returns the resulting HTML.
//
// Endpoints:
//   GET  /health   -> liveness + browser-ready status
//   POST /render   -> render a URL, requires X-Render-Key header
//
// Deployed as Fly app `lokal-render-worker` (separate from the
// main `lokal` app). The main app calls this via
// src/services/render-client.ts.

import express, { Request, Response, NextFunction } from "express";
import { chromium, Browser } from "playwright";
import pino from "pino";
import { z } from "zod";

const logger = pino({ level: process.env.LOG_LEVEL || "info" });

const PORT = Number(process.env.PORT) || 8080;
const RENDER_KEY = process.env.RENDER_KEY || "";
const USER_AGENT =
  "Mozilla/5.0 (compatible; RFB-RenderWorker/1.0; +https://rettfrabonden.com)";
const MAX_CONCURRENT = 4;

// Browser lifecycle (one shared instance, reused)
let browser: Browser | null = null;
let browserReady = false;
const startedAt = Date.now();

async function launchBrowser(): Promise<void> {
  try {
    browser = await chromium.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
      ],
    });
    browserReady = true;
    logger.info("chromium launched");
  } catch (err) {
    browserReady = false;
    logger.error({ err }, "failed to launch chromium");
  }
}

// Simple semaphore for concurrent renders
let active = 0;
const queue: Array<() => void> = [];

function acquire(): Promise<void> {
  if (active < MAX_CONCURRENT) {
    active++;
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    queue.push(() => {
      active++;
      resolve();
    });
  });
}

function release(): void {
  active--;
  const next = queue.shift();
  if (next) next();
}

// Request validation
const renderRequestSchema = z.object({
  url: z
    .string()
    .max(500)
    .refine((u) => u.startsWith("https://"), {
      message: "url must start with https://",
    }),
  wait_for: z
    .enum(["load", "domcontentloaded", "networkidle"])
    .optional()
    .default("networkidle"),
  timeout_ms: z.number().int().positive().max(60000).optional().default(30000),
  wait_selector: z.string().optional(),
});

// App setup
const app = express();
app.use(express.json({ limit: "100kb" }));

app.get("/health", (_req: Request, res: Response) => {
  res.json({
    status: "ok",
    uptime: Math.floor((Date.now() - startedAt) / 1000),
    browser_ready: browserReady,
  });
});

// Auth middleware for /render
function requireKey(req: Request, res: Response, next: NextFunction): void {
  if (!RENDER_KEY) {
    res
      .status(500)
      .json({ status: "error", error: "RENDER_KEY not configured on server" });
    return;
  }
  const key = req.header("X-Render-Key");
  if (!key || key !== RENDER_KEY) {
    res
      .status(401)
      .json({ status: "error", error: "missing or invalid X-Render-Key" });
    return;
  }
  next();
}

app.post("/render", requireKey, async (req: Request, res: Response) => {
  const t0 = Date.now();

  // Validate request
  const parsed = renderRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      status: "error",
      error: "invalid request body",
      details: parsed.error.issues,
    });
    return;
  }
  const { url, wait_for, timeout_ms, wait_selector } = parsed.data;

  if (!browser || !browserReady) {
    res.status(500).json({ status: "error", error: "browser not ready" });
    return;
  }

  await acquire();
  let context: import("playwright").BrowserContext | null = null;
  try {
    context = await browser.newContext({
      userAgent: USER_AGENT,
      viewport: { width: 1280, height: 800 },
    });

    // Block heavy resource types to speed up renders.
    await context.route("**/*", (route) => {
      const type = route.request().resourceType();
      const allowed = new Set([
        "document",
        "script",
        "stylesheet",
        "xhr",
        "fetch",
      ]);
      if (allowed.has(type)) {
        route.continue();
      } else {
        route.abort();
      }
    });

    const page = await context.newPage();

    let response;
    try {
      response = await page.goto(url, {
        waitUntil: wait_for,
        timeout: timeout_ms,
      });
    } catch (err: any) {
      const isTimeout =
        err && typeof err.message === "string" && /Timeout/i.test(err.message);
      const code = isTimeout ? 504 : 502;
      logger.warn({ url, err: err?.message }, "navigation failed");
      res.status(code).json({
        status: "error",
        error: isTimeout ? "navigation timeout" : "navigation failed",
        message: err?.message || String(err),
      });
      return;
    }

    if (wait_selector) {
      try {
        await page.waitForSelector(wait_selector, { timeout: timeout_ms });
      } catch (err: any) {
        logger.warn(
          { url, wait_selector, err: err?.message },
          "wait_selector timeout"
        );
        res.status(504).json({
          status: "error",
          error: "wait_selector timeout",
          message: err?.message || String(err),
        });
        return;
      }
    }

    const html = await page.content();
    const finalUrl = page.url();
    const statusCode = response?.status() ?? 0;
    const headers = response?.headers() ?? {};
    const contentType = headers["content-type"] || "text/html";
    const htmlBytes = Buffer.byteLength(html, "utf8");
    const durationMs = Date.now() - t0;

    logger.info(
      {
        url: finalUrl,
        status_code: statusCode,
        duration_ms: durationMs,
        html_bytes: htmlBytes,
      },
      "render ok"
    );

    res.json({
      status: "ok",
      url: finalUrl,
      status_code: statusCode,
      content_type: contentType,
      html,
      html_bytes: htmlBytes,
      duration_ms: durationMs,
      timestamp: new Date().toISOString(),
    });
  } catch (err: any) {
    logger.error({ url, err: err?.message }, "render internal error");
    if (!res.headersSent) {
      res.status(500).json({
        status: "error",
        error: "internal error",
        message: err?.message || String(err),
      });
    }
  } finally {
    if (context) {
      try {
        await context.close();
      } catch {
        // ignore context close errors
      }
    }
    release();
  }
});

// Boot + graceful shutdown
async function main(): Promise<void> {
  await launchBrowser();
  const server = app.listen(PORT, () => {
    logger.info({ port: PORT }, "render-worker listening");
  });

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, "shutting down");
    server.close();
    if (browser) {
      try {
        await browser.close();
      } catch (err) {
        logger.warn({ err }, "error closing browser");
      }
    }
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
  logger.error({ err }, "fatal boot error");
  process.exit(1);
});
