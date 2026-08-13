/**
 * render-enrich-scan.ts — run the headless-render fallback over the gårdssalg
 * rows that raw-HTML enrichment cannot reach, and report what it recovers.
 *
 * Daniel, live session 2026-08-13. 67northdistillery.no serves 180 KB of HTML
 * that yields 19 visible characters, so `about_text`/`products` can never be
 * extracted from the source and the row is stuck in `needs_enrichment`. This
 * script measures how many of that tier are the same shape, and what text a
 * browser actually recovers for each.
 *
 * READ-ONLY. It writes nothing to the platform — it prints a JSON report. The
 * decision to apply any recovered text stays a separate, reviewed step, because
 * profile content is producer-facing and Daniel's standing rule is that we never
 * invent it.
 *
 * ── Why this is a script and not part of the server ────────────────────────
 *
 * Production runs on node:20-alpine with 1024 MB and no browser (see
 * services/render-page.ts for the full deployment note). This script runs
 * wherever a browser and working egress exist, reads the cohort over the admin
 * API, and renders locally.
 *
 * ── Usage ──────────────────────────────────────────────────────────────────
 *
 *   npm install --no-save playwright-core
 *   npx playwright install chromium          # once, ~150 MB
 *
 *   ADMIN_KEY=...  npx tsx scripts/render-enrich-scan.ts
 *   ADMIN_KEY=...  npx tsx scripts/render-enrich-scan.ts --tier needs_enrichment --limit 5
 *
 * Options:
 *   --tier <name>   readiness tier to scan (default: needs_enrichment)
 *   --limit <n>     stop after n rows (default: all)
 *   --base <url>    API base (default: https://rettfrabonden.com)
 *   --out <path>    write the JSON report to a file as well as stdout
 */

import { writeFileSync } from "node:fs";
import { fetchPage, visibleTextOf } from "../src/services/fetch-page";
import { renderPage, shouldEscalateToRender } from "../src/services/render-page";

const UA = "Mozilla/5.0 (compatible; OpplevagentBot/1.0; +https://opplevagent.no)";

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

type ReadinessRow = {
  id: string;
  name: string;
  readiness_tier: string;
  hjemmeside: string | null;
  has_about_text: boolean;
  has_products: boolean;
};

type Outcome = {
  id: string;
  name: string;
  url: string;
  /** What the existing raw-HTML path sees today. */
  raw_chars: number;
  /** Whether the pure escalation rule fires for this page. */
  escalated: boolean;
  /** Chars recovered by the browser, or null when no render ran/succeeded. */
  rendered_chars: number | null;
  status:
    | "recovered"        // render produced materially more text
    | "no_gain"          // render ran, text no better
    | "not_js"           // raw HTML was already fine — not a render case
    | "fetch_failed"
    | "render_failed";
  detail?: string;
  /** First 600 chars of recovered text, for eyeballing before any apply. */
  sample?: string;
};

async function main() {
  const base = arg("base", "https://rettfrabonden.com")!;
  const tier = arg("tier", "needs_enrichment")!;
  const limitRaw = arg("limit");
  const limit = limitRaw ? Number(limitRaw) : Infinity;
  const outPath = arg("out");

  const adminKey = process.env.ADMIN_KEY;
  if (!adminKey) {
    console.error("ADMIN_KEY is not set");
    process.exit(2);
  }

  const resp = await fetch(`${base}/api/opplevelser/admin/gardssalg-outreach-readiness`, {
    headers: { "x-admin-key": adminKey },
  });
  if (!resp.ok) {
    console.error(`readiness fetch failed: HTTP ${resp.status}`);
    process.exit(3);
  }
  const body = (await resp.json()) as { providers?: ReadinessRow[] };
  const all = body.providers ?? [];

  const targets = all
    .filter((r) => r.readiness_tier === tier)
    .filter((r) => r.hjemmeside && r.hjemmeside.trim() !== "")
    .slice(0, limit === Infinity ? undefined : limit);

  const missingUrl = all.filter((r) => r.readiness_tier === tier && !r.hjemmeside).length;
  console.error(
    `tier=${tier}: ${targets.length} rows with a homepage` +
      (missingUrl ? `, ${missingUrl} skipped (no homepage stored)` : ""),
  );

  const outcomes: Outcome[] = [];

  for (const [i, row] of targets.entries()) {
    const url = row.hjemmeside!.trim();
    process.stderr.write(`[${i + 1}/${targets.length}] ${row.name} — ${url}\n`);

    const f = await fetchPage(url, { userAgent: UA });
    if (!f.ok) {
      outcomes.push({
        id: row.id, name: row.name, url, raw_chars: 0, escalated: false,
        rendered_chars: null, status: "fetch_failed", detail: `${f.reason} (${f.persistence})`,
      });
      continue;
    }

    const rawChars = visibleTextOf(f.html).length;
    const escalated = shouldEscalateToRender(f.html, { bytes: f.bytes });
    if (!escalated) {
      outcomes.push({
        id: row.id, name: row.name, url, raw_chars: rawChars, escalated: false,
        rendered_chars: null, status: "not_js",
        detail: "raw HTML already carries text — enrichment failure is not a rendering problem here",
      });
      continue;
    }

    const r = await renderPage(url, { userAgent: UA });
    if (!r.ok) {
      outcomes.push({
        id: row.id, name: row.name, url, raw_chars: rawChars, escalated: true,
        rendered_chars: null, status: "render_failed", detail: `${r.reason}: ${r.detail}`,
      });
      // renderer_unavailable is about THIS MACHINE, not the site — if the very
      // first row reports it there is no browser here and every remaining row
      // would report the same. Stop rather than emit a report full of verdicts
      // that say nothing about the producers.
      if (r.reason === "renderer_unavailable") {
        console.error("\nNo browser available in this environment — aborting.");
        console.error("Run:  npm install --no-save playwright-core && npx playwright install chromium");
        break;
      }
      continue;
    }

    outcomes.push({
      id: row.id, name: row.name, url,
      raw_chars: rawChars, escalated: true, rendered_chars: r.text.length,
      status: r.text.length > rawChars * 2 && r.text.length > 200 ? "recovered" : "no_gain",
      sample: r.text.slice(0, 600),
    });
  }

  const summary = outcomes.reduce<Record<string, number>>((acc, o) => {
    acc[o.status] = (acc[o.status] ?? 0) + 1;
    return acc;
  }, {});

  const report = { tier, scanned: outcomes.length, summary, outcomes };
  const json = JSON.stringify(report, null, 2);
  if (outPath) {
    writeFileSync(outPath, json);
    console.error(`\nreport written to ${outPath}`);
  }
  console.log(json);

  console.error("\n── summary ──");
  for (const [k, v] of Object.entries(summary)) console.error(`  ${k}: ${v}`);
}

main().catch((err) => {
  console.error("scan failed:", err?.message ?? err);
  process.exit(1);
});
