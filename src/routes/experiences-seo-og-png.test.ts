/**
 * experiences-seo-og-png.test.ts — Opplevagent's PNG share cards.
 *
 * dev-request 2026-10-16-opplevagent-indekserbarhet-og-strukturdata, E2-S3:
 * og:image was an SVG (/og-image.svg) that many link previews do not show.
 * Pages now point at a 1200×630 PNG card per category (plus a default card),
 * pre-rendered by scripts/render-oa-og-png.mjs into src/public/og/opplevagent/
 * and served by GET /og/:cat.png; twitter:card is summary_large_image.
 *
 * Covers:
 *   (a) the committed PNG set: opplevagentOgPngCards() is every
 *       CATEGORY_LABELS key plus `default`; each has a PNG on disk and the
 *       folder holds no other PNG; each PNG is well-formed (signature, IHDR
 *       first, every chunk CRC valid, IEND last), IHDR is 1200×630, and its
 *       tEXt source hash equals the SHA-256 of the card's current SVG (a
 *       stale PNG fails here: re-run the script).
 *   (b) ogImageUrl(): a known category → its card; no, an unknown, a legacy
 *       or a prototype-key category → the default card.
 *   (c) GET /og/<key>.png: 200, image/png, the file's exact bytes, for every
 *       key; unknown keys, prototype keys and an encoded `../` fall through
 *       to the 404 page.
 *   (d) wiring on every page type that has a share image — detail (known,
 *       unknown and no category), detail on /en, /kategori/<cat>,
 *       /opplevelser, the gårdssalg producer page and the homepage:
 *       og:image is the expected PNG, served 200 image/png by the router,
 *       its IHDR equals og:image:width/height (1200/630), twitter:card is
 *       summary_large_image, and the alt text follows the page's title
 *       (displayTitle on the detail page). No page links an SVG share image.
 *   (e) no runtime image dependency: package.json carries no rasterizer or
 *       font package (the script fetches them for one run only).
 *
 * The SVG renderer and the legacy GET /og-image.svg route keep their own,
 * unchanged tests in src/services/experience-og-image.test.ts.
 *
 * Run standalone: npx tsx src/routes/experiences-seo-og-png.test.ts
 * Wired into `npm test` via tests/test.ts.
 */

import { createHash } from "crypto";
import fs from "fs";
import path from "path";
import zlib from "zlib";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

const BASE = "https://opplevagent.no";
const PNG_DIR = path.join(__dirname, "..", "public", "og", "opplevagent");
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

interface RouteResult { handled: boolean; status: number; headers: Record<string, string>; body: Buffer }

// Same synthetic router.handle() harness as the sibling experiences-seo
// tests, but the body is kept as bytes so a PNG can be compared and parsed.
function callRoute(router: any, url: string, lang: "no" | "en" = "no"): Promise<RouteResult> {
  return new Promise((resolve) => {
    let statusCode = 200;
    const headers: Record<string, string> = {};
    const req: any = {
      method: "GET",
      url,
      originalUrl: url,
      path: url.split("?")[0],
      query: {},
      headers: {},
      // i18n/middleware.ts strips "/en" and sets req.lang before the router runs.
      lang,
      get() { return undefined; },
    };
    const res: any = {
      statusCode: 200,
      status(code: number) { statusCode = code; this.statusCode = code; return this; },
      setHeader(name: string, value: string) { headers[name.toLowerCase()] = String(value); },
      redirect(code: number, loc: string) { resolve({ handled: true, status: code, headers, body: Buffer.from(loc) }); },
      send(body: unknown) {
        resolve({ handled: true, status: statusCode, headers, body: Buffer.isBuffer(body) ? body : Buffer.from(String(body)) });
      },
    };
    router.handle(req, res, (err?: any) => {
      resolve({ handled: false, status: statusCode, headers, body: Buffer.from(err ? String(err) : "") });
    });
  });
}

interface PngChunk { type: string; data: Buffer; crcOk: boolean }

/** The PNG's chunks in file order, or null when the signature is wrong. */
function pngChunks(buf: Buffer): PngChunk[] | null {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  const chunks: PngChunk[] = [];
  let off = 8;
  while (off + 12 <= buf.length) {
    const len = buf.readUInt32BE(off);
    if (off + 12 + len > buf.length) return null;
    const type = buf.toString("latin1", off + 4, off + 8);
    const crcOk = zlib.crc32(buf.subarray(off + 4, off + 8 + len)) === buf.readUInt32BE(off + 8 + len);
    chunks.push({ type, data: buf.subarray(off + 8, off + 8 + len), crcOk });
    off += 12 + len;
  }
  return off === buf.length ? chunks : null;
}

/** IHDR width × height of a well-formed PNG, else null. */
function pngSize(buf: Buffer): { width: number; height: number } | null {
  const ihdr = pngChunks(buf)?.[0];
  if (!ihdr || ihdr.type !== "IHDR" || ihdr.data.length !== 13) return null;
  return { width: ihdr.data.readUInt32BE(0), height: ihdr.data.readUInt32BE(4) };
}

function unescapeHtml(s: string): string {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
}
function metaContent(html: string, attr: "property" | "name", key: string): string | null {
  const m = new RegExp(`<meta ${attr}="${key.replace(/[.:]/g, "\\$&")}" content="([^"]*)"`).exec(html);
  return m ? unescapeHtml(m[1]) : null;
}

export function runExperiencesSeoOgPngTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];
  function assertTrue(cond: boolean, label: string): void {
    if (cond) { passed++; if (log) console.log(`  ok ${label}`); }
    else { failed++; failures.push(`✗ ${label}`); if (log) console.log(`  ✗ ${label}`); }
  }
  function assertEq(actual: unknown, expected: unknown, label: string): void {
    if (JSON.stringify(actual) === JSON.stringify(expected)) { passed++; if (log) console.log(`  ok ${label}`); }
    else {
      failed++;
      const msg = `✗ ${label}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`;
      failures.push(msg);
      if (log) console.log("  " + msg);
    }
  }

  return (async () => {
    const prevDb = process.env.EXPERIENCES_DB_PATH;
    const prevSwitcher = process.env.OPPLEVAGENT_LANG_SWITCHER_ENABLED;
    process.env.EXPERIENCES_DB_PATH = ":memory:";
    delete process.env.OPPLEVAGENT_LANG_SWITCHER_ENABLED;

    const paths = [
      require.resolve("../database/db-factory"),
      require.resolve("../services/experience-store"),
      require.resolve("./experiences-seo"),
    ];
    const restoreModuleCache = (require("../../tests/module-cache") as typeof import("../../tests/module-cache")).swapOutModules(paths);

    try {
      try {
        (require("../config/vertical-config") as typeof import("../config/vertical-config")).loadConfigsAtBoot();
      } catch { /* already loaded */ }
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const expStore = require("../services/experience-store") as typeof import("../services/experience-store");
      const db = dbFactory.getDb("experiences") as any;
      const seo = require("./experiences-seo") as typeof import("./experiences-seo");
      const router = seo.default as any;

      // ── (a) the committed PNG set ──────────────────────────────────────────
      const cards = seo.opplevagentOgPngCards();
      const categoryKeys = Object.keys(seo.CATEGORY_LABELS);
      assertEq(cards.map((c) => c.key), [...categoryKeys, seo.OG_PNG_DEFAULT_KEY],
        "og-a1: the card set is every CATEGORY_LABELS key, then the default card");
      assertTrue(categoryKeys.length >= 10, `og-a2: CATEGORY_LABELS still has its categories (${categoryKeys.length})`);
      const onDisk = fs.existsSync(PNG_DIR) ? fs.readdirSync(PNG_DIR).filter((f) => f.endsWith(".png")).sort() : [];
      for (const key of [...categoryKeys, seo.OG_PNG_DEFAULT_KEY]) {
        assertTrue(onDisk.includes(`${key}.png`), `og-a3 ${key}: src/public/og/opplevagent/${key}.png exists (run: npx tsx scripts/render-oa-og-png.mjs)`);
      }
      assertEq(onDisk, cards.map((c) => `${c.key}.png`).sort(), "og-a4: the folder holds exactly the card set's PNGs (no orphan from a removed category)");
      for (const { key, svg } of cards) {
        const file = path.join(PNG_DIR, `${key}.png`);
        if (!fs.existsSync(file)) continue; // reported by og-a3
        const buf = fs.readFileSync(file);
        const chunks = pngChunks(buf);
        assertTrue(!!chunks && chunks[0]?.type === "IHDR" && chunks[chunks.length - 1]?.type === "IEND" && chunks.some((c) => c.type === "IDAT"),
          `og-a5 ${key}: a well-formed PNG (signature, IHDR first, IDAT, IEND last)`);
        assertTrue(!!chunks && chunks.every((c) => c.crcOk), `og-a6 ${key}: every chunk CRC is valid`);
        assertEq(pngSize(buf), { width: 1200, height: 630 }, `og-a7 ${key}: IHDR is 1200×630`);
        const recorded = (chunks ?? [])
          .filter((c) => c.type === "tEXt")
          .map((c) => c.data.toString("latin1").split("\0"))
          .find(([k]) => k === seo.OG_PNG_SOURCE_KEYWORD)?.[1];
        assertEq(recorded, createHash("sha256").update(svg).digest("hex"),
          `og-a8 ${key}: the PNG was rendered from the card's current SVG (stale? run: npx tsx scripts/render-oa-og-png.mjs)`);
      }

      // ── (b) ogImageUrl() ───────────────────────────────────────────────────
      assertEq(seo.ogImageUrl(BASE, "vinter_sno"), `${BASE}/og/vinter_sno.png`, "og-b1: a known category → its own card");
      assertEq(seo.ogImageUrl(BASE, "gardssalg"), `${BASE}/og/gardssalg.png`, "og-b2: gardssalg → its own card");
      for (const cat of [undefined, null, "", "ukjent_kategori", "kajakk", "Vinter_sno", "constructor", "__proto__", "toString"]) {
        assertEq(seo.ogImageUrl(BASE, cat as string | null | undefined), `${BASE}/og/default.png`,
          `og-b3 ${JSON.stringify(cat)}: no, an unknown, a non-label or a prototype-key category → the default card`);
      }

      // ── (c) GET /og/:cat.png ───────────────────────────────────────────────
      for (const { key } of cards) {
        const r = await callRoute(router, `/og/${key}.png`);
        const file = path.join(PNG_DIR, `${key}.png`);
        assertTrue(r.handled && r.status === 200 && r.headers["content-type"] === "image/png",
          `og-c1 ${key}: GET /og/${key}.png → 200 image/png (got ${r.status} ${r.headers["content-type"]})`);
        assertTrue(fs.existsSync(file) && r.body.equals(fs.readFileSync(file)), `og-c2 ${key}: the response is the committed file's bytes`);
        assertTrue(/^public, max-age=\d+/.test(r.headers["cache-control"] || ""), `og-c3 ${key}: publicly cacheable`);
      }
      // ..%2F..%2Fopplevagent-favicon-192 would resolve to an existing PNG in
      // src/public if the param were ever joined into a file path.
      for (const bad of ["/og/ukjent_kategori.png", "/og/constructor.png", "/og/__proto__.png", "/og/..%2F..%2Fopplevagent-favicon-192.png", "/og/vinter_sno.svg"]) {
        const r = await callRoute(router, bad);
        assertTrue(r.status === 404 && r.headers["content-type"] !== "image/png", `og-c4 ${bad}: not a card → the 404 page (got ${r.status} ${r.headers["content-type"]})`);
      }

      // ── (d) wiring on every page type with a share image ───────────────────
      const provId = expStore.createProvider({
        navn: "Arktisk Hval AS", org_nr: "912345670", fylke: "Troms", kommune: "Tromsø",
        hjemmeside: "https://hval.example.no", brreg_verified: 1, brreg_active: 1, verification_status: "verified",
      });
      const mk = (title: string, category: string | null): string => {
        const id = expStore.createExperience({
          title, category, provider_id: provId, provider_match_status: "matched", fylke: "Troms", kommune: "Tromsø",
          description: "Tur med erfarne guider og plass til små grupper.", confidence: "high", verification_status: "verified",
        } as any);
        return id;
      };
      const safariId = mk("Whale Safari Tromso", "dyreliv_safari");
      db.prepare("UPDATE experiences SET title_no = ? WHERE id = ?").run("Hvalsafari fra Tromsø", safariId);
      const legacyId = mk("Nordlysjakt med buss", "ukjent_kategori");
      const bareId = mk("Utsiktspunkt ved fjorden", null);
      const slugOf = (id: string): string => (expStore.getExperienceById(id) as any).slug as string;
      db.prepare(
        `INSERT INTO experience_providers
           (id, navn, vertical, fylke, kommune, poststed, producer_type, booking_live, catalog_hidden, lat, lon,
            geocode_confidence, slug, enrichment_state, verification_status, source, confidence)
         VALUES ('og-gs', 'Aktivt Bryggeri', 'experiences', 'Vestland', 'Voss', 'Voss', 'bryggeri', 1, NULL, 60.63, 6.42,
                 'high', 'aktivt-bryggeri', 'raw', 'pending_verify', 'test-fixture', 'medium')`,
      ).run();

      const pages: Array<{ key: string; path: string; lang?: "no" | "en"; png: string; alt: (a: string) => boolean; altWant: string }> = [
        { key: "detail, category + title_no", path: `/opplevelse/${slugOf(safariId)}`, png: "dyreliv_safari",
          alt: (a) => a === "Hvalsafari fra Tromsø — Dyreliv & safari | Opplevagent", altWant: "the <h1> (title_no) and the category" },
        { key: "detail on /en, switcher off", path: `/opplevelse/${slugOf(safariId)}`, lang: "en", png: "dyreliv_safari",
          alt: (a) => a === "Whale Safari Tromso — Dyreliv & safari | Opplevagent", altWant: "the <h1> on /en (the original title, tnr-4d)" },
        { key: "detail, unknown category", path: `/opplevelse/${slugOf(legacyId)}`, png: "default",
          alt: (a) => a.startsWith("Nordlysjakt med buss — "), altWant: "the <h1>" },
        { key: "detail, no category", path: `/opplevelse/${slugOf(bareId)}`, png: "default",
          alt: (a) => a === "Utsiktspunkt ved fjorden | Opplevagent", altWant: "the <h1>" },
        { key: "/kategori/dyreliv_safari", path: "/kategori/dyreliv_safari", png: "dyreliv_safari",
          alt: (a) => a === "Dyreliv & safari | Opplevagent", altWant: "the page's <h1>" },
        { key: "/opplevelser", path: "/opplevelser", png: "default",
          alt: (a) => a.endsWith("| Opplevagent") && a.length > "| Opplevagent".length, altWant: "the page's <h1>" },
        { key: "gårdssalg producer", path: "/kategori/gardssalg/produsent/aktivt-bryggeri", png: "gardssalg",
          alt: (a) => a === "Aktivt Bryggeri — Gårdssalg og smaking | Opplevagent", altWant: "the producer's name" },
        { key: "homepage", path: "/", png: "default",
          alt: (a) => a.startsWith("Opplevagent"), altWant: "the site" },
      ];
      for (const p of pages) {
        const r = await callRoute(router, p.path, p.lang ?? "no");
        const html = r.body.toString("utf8");
        assertTrue(r.handled && r.status === 200, `og-d0 ${p.key}: renders 200 (got ${r.status})`);
        const ogImage = metaContent(html, "property", "og:image");
        assertEq(ogImage, `${BASE}/og/${p.png}.png`, `og-d1 ${p.key}: og:image is the ${p.png} card`);
        assertEq([metaContent(html, "property", "og:image:width"), metaContent(html, "property", "og:image:height")], ["1200", "630"],
          `og-d2 ${p.key}: og:image:width/height are 1200/630`);
        assertEq(metaContent(html, "name", "twitter:card"), "summary_large_image", `og-d3 ${p.key}: twitter:card is summary_large_image`);
        const alt = metaContent(html, "property", "og:image:alt") ?? "";
        assertTrue(p.alt(alt), `og-d4 ${p.key}: og:image:alt names ${p.altWant} (got «${alt}»)`);
        assertTrue(!/<meta (property|name)="(og|twitter):image" content="[^"]*\.svg[^"]*"/.test(html), `og-d5 ${p.key}: no SVG share image`);
        if (ogImage?.startsWith(BASE)) {
          const img = await callRoute(router, ogImage.slice(BASE.length));
          assertTrue(img.status === 200 && img.headers["content-type"] === "image/png", `og-d6 ${p.key}: the og:image URL is served 200 image/png`);
          assertEq(pngSize(img.body), { width: 1200, height: 630 }, `og-d7 ${p.key}: the served image is 1200×630, as the meta tags say`);
        }
      }
      {
        const home = (await callRoute(router, "/")).body.toString("utf8");
        assertEq(metaContent(home, "name", "twitter:image"), `${BASE}/og/default.png`, "og-d8: homepage twitter:image is the same PNG card");
      }

      // ── (e) no runtime image dependency ────────────────────────────────────
      {
        const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "package.json"), "utf8"));
        const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies, ...pkg.optionalDependencies });
        const imageDeps = deps.filter((d) => /^@resvg\/|^sharp$|^canvas$|^@napi-rs\/canvas$|^puppeteer|^playwright|^@expo-google-fonts\//.test(d));
        assertEq(imageDeps, [], "og-e1: package.json has no rasterizer or font package (scripts/render-oa-og-png.mjs fetches them for one run)");
      }

      return { passed, failed, failures };
    } catch (err) {
      failed++;
      failures.push(`unexpected error: ${err instanceof Error ? (err.stack || err.message) : String(err)}`);
      return { passed, failed, failures };
    } finally {
      if (prevDb === undefined) delete process.env.EXPERIENCES_DB_PATH; else process.env.EXPERIENCES_DB_PATH = prevDb;
      if (prevSwitcher === undefined) delete process.env.OPPLEVAGENT_LANG_SWITCHER_ENABLED; else process.env.OPPLEVAGENT_LANG_SWITCHER_ENABLED = prevSwitcher;
      try {
        (require("../database/db-factory") as typeof import("../database/db-factory")).__resetDbFactoryForTesting();
      } catch { /* best-effort */ }
      restoreModuleCache();
    }
  })();
}

// Standalone runner: `npx tsx src/routes/experiences-seo-og-png.test.ts`
if (require.main === module) {
  console.log("── Opplevagent PNG share cards (dev-request 2026-10-16 E2-S3) ──");
  runExperiencesSeoOgPngTests({ log: true }).then((r) => {
    console.log(`\nexperiences-seo-og-png: ${r.passed} passed, ${r.failed} failed`);
    if (r.failed > 0) {
      console.log(r.failures.join("\n"));
      process.exit(1);
    }
    process.exit(0);
  });
}
