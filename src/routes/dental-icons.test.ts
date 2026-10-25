/**
 * dental-icons.test.ts — A2A dev-request
 * 2026-10-16-finn-tannlege-tillit-kilder-metode-ikon, F2-S4: square PNG
 * icons of the «Søket» mark for finn-tannlege.com, as og:image, as the
 * Organization logo and as ai-plugin.json's logo_url.
 *
 * Covers:
 *   (a) the files: src/public/dental-favicon-192.png, dental-favicon-512.png
 *       and dental-apple-touch-icon-180.png are 8-bit RGB PNGs with the size
 *       in their IHDR, pinned by md5; the Claude directory pack's icon is the
 *       512, byte for byte.
 *   (b) the mark: /favicon.svg serves dentalMarkSvg() byte for byte as before
 *       F2-S4; the PNGs were rasterised from dentalMarkSvg(0), the same text
 *       without the rounded corner and nothing else. Both texts are pinned:
 *       a change to the mark fails here until the PNGs are rasterised again.
 *   (c) the palette (name check G3-J §6.2): every pixel is the teal #0F766E,
 *       white, or a blend of the two; the corners are teal (full-bleed, no
 *       transparency); the white motif covers a plausible share. FINN's
 *       blue and cyan fail the same check (control).
 *   (d) the routes: GET /favicon-192.png, /favicon-512.png and
 *       /apple-touch-icon.png answer 200 image/png with the file's bytes and
 *       a one-day cache; an unknown size falls through to the 404 page.
 *   (e) servePublicFile(): a missing file calls next() and sets nothing; a
 *       present one is sent with the given type.
 *   (f) the page head (front page, /om, a clinic page, a 404): og:image and
 *       twitter:image are the 512 PNG with og:image:type/width/height; the
 *       SVG icon link stays, with a 192 PNG icon and a 180 apple-touch-icon
 *       after it; every icon URL in the head is one of the routes.
 *   (g) machine surfaces: the front page's Organization.logo and
 *       ai-plugin.json's logo_url are the 512 PNG and equal
 *       BRAND_ENTITIES.dental.logoPng; no page, Organization or plugin
 *       manifest points at favicon.svg except the SVG icon link (regression).
 *
 * Harness as in dental-finn-disambiguation.test.ts: in-memory dental DB, the
 * router driven through router.handle().
 *
 * Standalone: npx tsx src/routes/dental-icons.test.ts
 * Wired into tests/test.ts via runDentalIconsTests().
 */

import { createHash } from "crypto";
import * as fs from "fs";
import * as path from "path";
import * as zlib from "zlib";

import { BRAND_ENTITIES } from "../config/brand-entities";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

const ROOT = path.join(__dirname, "..", "..");
const PUBLIC_DIR = path.join(__dirname, "..", "public");
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** The icons as rasterised in F2-S4; a new rasterisation changes these on purpose. */
const PINNED_PNG_MD5: Record<string, string> = {
  "dental-favicon-192.png": "e5d402323b017fa64a96681f6d5ca41f",
  "dental-favicon-512.png": "d699125e1528fb9c818550c1052b0bb3",
  "dental-apple-touch-icon-180.png": "33a2bfba71d0972bfc3bb0a970b5764f",
};
/** sha256 of what /favicon.svg served before F2-S4 (PR-112), and still serves. */
const SERVED_SVG_SHA256 = "79c25c23c539108e537c285517aa74a6172d5bb66b412d29b765317658a55294";
/** sha256 of dentalMarkSvg(0), the text the PNGs were rasterised from. */
const RASTERISED_SVG_SHA256 = "fd0d3c76f28e2334bce22afec3bc67b2250c10904201868c1442c19dec77ea2e";

const TEAL: readonly [number, number, number] = [0x0f, 0x76, 0x6e];

const md5 = (buf: Buffer): string => createHash("md5").update(buf).digest("hex");
const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

interface PngHeader { width: number; height: number; bitDepth: number; colorType: number; interlace: number }

function pngHeader(buf: Buffer): PngHeader | null {
  if (buf.length < 29 || !buf.subarray(0, 8).equals(PNG_SIGNATURE) || buf.toString("ascii", 12, 16) !== "IHDR") return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), bitDepth: buf[24], colorType: buf[25], interlace: buf[28] };
}

/**
 * The pixels of an 8-bit RGB, non-interlaced PNG (what the rasterising
 * command writes): IDAT inflated and each row's filter undone.
 */
function decodeRgbPng(buf: Buffer): { width: number; height: number; px: Buffer } {
  const h = pngHeader(buf);
  if (!h || h.bitDepth !== 8 || h.colorType !== 2 || h.interlace !== 0) throw new Error("not an 8-bit RGB non-interlaced PNG");
  const idat: Buffer[] = [];
  for (let i = 8; i < buf.length;) {
    const len = buf.readUInt32BE(i);
    if (buf.toString("ascii", i + 4, i + 8) === "IDAT") idat.push(buf.subarray(i + 8, i + 8 + len));
    i += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const bpp = 3;
  const stride = h.width * bpp;
  const px = Buffer.alloc(stride * h.height);
  for (let y = 0; y < h.height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? px[y * stride + x - bpp] : 0;
      const b = y > 0 ? px[(y - 1) * stride + x] : 0;
      const c = x >= bpp && y > 0 ? px[(y - 1) * stride + x - bpp] : 0;
      let pred = 0;
      if (filter === 1) pred = a;
      else if (filter === 2) pred = b;
      else if (filter === 3) pred = (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      } else if (filter !== 0) throw new Error(`unknown PNG filter ${filter}`);
      px[y * stride + x] = (src[x] + pred) & 0xff;
    }
  }
  return { width: h.width, height: h.height, px };
}

/**
 * Where an RGB colour lies between teal (0) and white (1), or null when it is
 * off that line: each channel gives the same fraction, within `tolerance`
 * (8-bit rounding of an anti-aliased edge is well under 0.01).
 */
function tealWhiteFraction(r: number, g: number, b: number, tolerance = 0.02): number | null {
  const t = [r, g, b].map((v, i) => (v - TEAL[i]) / (255 - TEAL[i]));
  const lo = Math.min(...t), hi = Math.max(...t);
  if (hi - lo > tolerance || lo < -tolerance || hi > 1 + tolerance) return null;
  return (lo + hi) / 2;
}

interface RouteResult { status: number; headers: Record<string, string>; body: unknown; text: string; nextCalled: boolean }

function callRoute(router: any, urlPath: string): Promise<RouteResult> {
  return new Promise((resolve) => {
    const headers: Record<string, string> = {};
    const req: any = {
      method: "GET", url: urlPath, originalUrl: urlPath, path: urlPath.split("?")[0], params: {}, query: {},
      headers: {}, ip: "127.0.0.1", lang: "no", get() { return undefined; },
    };
    const res: any = {
      statusCode: 200,
      status(code: number) { this.statusCode = code; return this; },
      setHeader(k: string, v: string) { headers[k.toLowerCase()] = String(v); return this; },
      header(k: string, v: string) { headers[k.toLowerCase()] = String(v); return this; },
      send(payload: unknown) {
        resolve({ status: this.statusCode, headers, body: payload, text: Buffer.isBuffer(payload) ? "" : String(payload ?? ""), nextCalled: false });
        return this;
      },
      json(payload: unknown) {
        resolve({ status: this.statusCode, headers, body: payload, text: JSON.stringify(payload), nextCalled: false });
        return this;
      },
    };
    router.handle(req, res, () => resolve({ status: 404, headers, body: null, text: "unhandled", nextCalled: true }));
  });
}

/** Every application/ld+json block of a page, parsed, arrays flattened. */
function jsonLdOf(html: string): any[] {
  const out: any[] = [];
  for (const m of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
    try {
      const v = JSON.parse(m[1]!);
      if (Array.isArray(v)) out.push(...v); else out.push(v);
    } catch { /* counted as missing */ }
  }
  return out;
}

const metaProp = (html: string, prop: string): string | null =>
  (html.match(new RegExp(`<meta (?:property|name)="${prop.replace(/[:.]/g, "\\$&")}" content="([^"]*)">`)) || [])[1] ?? null;

export async function runDentalIconsTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];

  function assertTrue(cond: boolean, label: string, detail?: string): void {
    if (cond) {
      passed++;
      if (log) console.log(`  ok ${label}`);
    } else {
      failed++;
      failures.push(`✗ ${label}${detail ? ` — ${detail}` : ""}`);
      if (log) console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
    }
  }
  function assertEq(actual: unknown, expected: unknown, label: string): void {
    assertTrue(JSON.stringify(actual) === JSON.stringify(expected), `${label} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
  }

  const base = process.env.DENTAL_BASE_URL || "https://finn-tannlege.com";
  const prevDentalPath = process.env.DENTAL_DB_PATH;
  process.env.DENTAL_DB_PATH = ":memory:";
  const cachePaths = [
    require.resolve("../database/db-factory"),
    require.resolve("../services/dental-store"),
    require.resolve("./dental-seo"),
  ];
  const restoreModuleCache = (require("../../tests/module-cache") as typeof import("../../tests/module-cache")).swapOutModules(cachePaths);

  try {
    const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
    dbFactory.__resetDbFactoryForTesting();
    const db = dbFactory.getDb("dental");
    const store = require("../services/dental-store") as typeof import("../services/dental-store");
    const dentalSeo = require("./dental-seo") as typeof import("./dental-seo");
    const router = dentalSeo.default as any;
    const { DENTAL_ICONS, dentalMarkSvg } = dentalSeo;
    const icons = Object.values(DENTAL_ICONS);
    const png512Url = `${base}${DENTAL_ICONS.png512.path}`;

    // ── (a) the files ─────────────────────────────────────────────────────
    assertEq(icons.map((i) => [i.path, i.file, i.size]), [
      ["/favicon-192.png", "dental-favicon-192.png", 192],
      ["/favicon-512.png", "dental-favicon-512.png", 512],
      ["/apple-touch-icon.png", "dental-apple-touch-icon-180.png", 180],
    ], "a1: three icons: 192 and 512 at /favicon-<n>.png, 180 at /apple-touch-icon.png (spec F2-S4)");
    const files = new Map<string, Buffer>();
    for (const icon of icons) {
      const p = path.join(PUBLIC_DIR, icon.file);
      const buf = fs.existsSync(p) ? fs.readFileSync(p) : Buffer.alloc(0);
      files.set(icon.file, buf);
      const h = pngHeader(buf);
      assertEq(h, { width: icon.size, height: icon.size, bitDepth: 8, colorType: 2, interlace: 0 },
        `a2 ${icon.file}: a ${icon.size}×${icon.size} 8-bit RGB PNG, not interlaced (IHDR)`);
      assertEq(md5(buf), PINNED_PNG_MD5[icon.file], `a3 ${icon.file}: md5 as rasterised in F2-S4`);
      assertTrue(buf.length > 1000 && buf.length < 40_000, `a4 ${icon.file}: a small binary (${buf.length} bytes)`);
    }
    {
      const packIcon = path.join(ROOT, "dental-connectors-prep", "assets", "finn-tannlege-square-512.png");
      assertTrue(fs.existsSync(packIcon) && fs.readFileSync(packIcon).equals(files.get("dental-favicon-512.png")!),
        "a5: the Claude directory pack's icon (dental-connectors-prep/assets/finn-tannlege-square-512.png) is the 512, byte for byte");
    }

    // ── (b) the mark ──────────────────────────────────────────────────────
    const served = dentalMarkSvg();
    const fullBleed = dentalMarkSvg(0);
    assertEq(sha256(served), SERVED_SVG_SHA256, "b1: /favicon.svg serves the PR-112 mark byte for byte as before F2-S4");
    assertEq(sha256(fullBleed), RASTERISED_SVG_SHA256,
      "b2: dentalMarkSvg(0) is the text the PNGs were rasterised from (a change: rasterise again, as in dental-seo.ts, and update the pins)");
    assertEq(served.replace(' rx="19.2"', ""), fullBleed, "b3: the full-bleed text is the served one without the rounded corner, nothing else");
    assertTrue(served.includes('rx="19.2"') && !fullBleed.includes("rx="), "b4 control: the served mark has the rounded corner and the rasterised one has none");
    assertTrue(!/<text\b/.test(served) && /fill="#0F766E"/.test(served), "b5: the mark has no text and keeps the teal #0F766E (name check §6.2)");
    {
      const r = await callRoute(router, "/favicon.svg");
      assertTrue(r.status === 200 && r.headers["content-type"] === "image/svg+xml" && r.text === served,
        "b6: GET /favicon.svg is 200 image/svg+xml with dentalMarkSvg()");
    }

    // ── (c) the palette ───────────────────────────────────────────────────
    for (const icon of icons) {
      let decoded: ReturnType<typeof decodeRgbPng> | null = null;
      try { decoded = decodeRgbPng(files.get(icon.file)!); } catch (err) { assertTrue(false, `c0 ${icon.file}: decodes`, String(err)); }
      if (!decoded) continue;
      const { width, height, px } = decoded;
      let off = 0, white = 0, teal = 0;
      for (let i = 0; i < px.length; i += 3) {
        const t = tealWhiteFraction(px[i], px[i + 1], px[i + 2]);
        if (t === null) off++;
        else if (px[i] === 255 && px[i + 1] === 255 && px[i + 2] === 255) white++;
        else if (px[i] === TEAL[0] && px[i + 1] === TEAL[1] && px[i + 2] === TEAL[2]) teal++;
      }
      const n = width * height;
      assertEq(off, 0, `c1 ${icon.file}: every pixel is teal, white or a blend of the two (no other colour)`);
      const corners = [[0, 0], [width - 1, 0], [0, height - 1], [width - 1, height - 1]].map(([x, y]) => [...px.subarray((y * width + x) * 3, (y * width + x) * 3 + 3)]);
      assertTrue(corners.every((c) => c[0] === TEAL[0] && c[1] === TEAL[1] && c[2] === TEAL[2]), `c2 ${icon.file}: all four corners are teal (full-bleed, no rounded or transparent corner)`, JSON.stringify(corners));
      assertTrue(white / n > 0.1 && white / n < 0.2 && teal / n > 0.75, `c3 ${icon.file}: the white tooth-and-magnifier covers ${(100 * white / n).toFixed(1)} %, teal ${(100 * teal / n).toFixed(1)} %`);
    }
    assertTrue(tealWhiteFraction(0x00, 0x63, 0xfb) === null && tealWhiteFraction(0x06, 0xbe, 0xfb) === null,
      "c4 control: FINN's blue (#0063FB) and cyan (#06BEFB) are off the teal–white line");
    assertTrue(tealWhiteFraction(...TEAL) === 0 && tealWhiteFraction(255, 255, 255) === 1 && tealWhiteFraction(135, 186, 182) !== null,
      "c5 control: teal is 0, white is 1, and their midpoint is on the line");

    // ── (d) the routes ────────────────────────────────────────────────────
    for (const icon of icons) {
      const r = await callRoute(router, icon.path);
      assertTrue(r.status === 200 && r.headers["content-type"] === "image/png", `d1 ${icon.path}: 200 image/png`, `${r.status} ${r.headers["content-type"]}`);
      assertTrue(Buffer.isBuffer(r.body) && (r.body as Buffer).equals(files.get(icon.file)!), `d2 ${icon.path}: the body is src/public/${icon.file}`);
      assertEq(pngHeader(r.body as Buffer)?.width, icon.size, `d3 ${icon.path}: IHDR width ${icon.size}`);
      assertEq(r.headers["cache-control"], "public, max-age=86400", `d4 ${icon.path}: cached for a day, like the Opplevagent PNGs`);
    }
    {
      const r = await callRoute(router, "/favicon-1024.png");
      assertTrue(r.status === 404 && /Siden finnes ikke/.test(r.text), "d5: an icon size that does not exist gets the 404 page");
    }

    // ── (e) servePublicFile() ─────────────────────────────────────────────
    {
      const { servePublicFile, PUBLIC_DIR: dir } = require("./public-file") as typeof import("./public-file");
      assertEq(path.resolve(dir), path.resolve(PUBLIC_DIR), "e1: PUBLIC_DIR is src/public");
      const run = (file: string, type: string) => new Promise<{ next: boolean; headers: Record<string, string>; body: unknown }>((resolve) => {
        const headers: Record<string, string> = {};
        const res: any = {
          setHeader(k: string, v: string) { headers[k.toLowerCase()] = v; return res; },
          send(b: unknown) { resolve({ next: false, headers, body: b }); return res; },
        };
        servePublicFile(file, type)({} as any, res, () => resolve({ next: true, headers, body: null }));
      });
      const missing = await run("no-such-dental-icon.png", "image/png");
      assertTrue(missing.next && Object.keys(missing.headers).length === 0, "e2: a missing file calls next() and sets no header");
      const present = await run("dental-favicon-192.png", "image/png");
      assertTrue(!present.next && present.headers["content-type"] === "image/png" && Buffer.isBuffer(present.body), "e3: a present file is sent with the given Content-Type");
    }

    // ── (f) the page head ─────────────────────────────────────────────────
    const clinicSlug = (() => {
      const id = store.createDentalAgent({ navn: "Ikon Tannklinikk AS", org_nr: "918960101", poststed: "OSLO", fylke: "Oslo", adresse: "Storgata 1", telefon: "22110099" } as any);
      db.prepare("UPDATE dental_agents SET catalog_class = 'klinikk' WHERE id = ?").run(id);
      return dentalSeo.slugifyClinic("Ikon Tannklinikk AS", "918960101");
    })();
    const pages: Array<[string, number]> = [["/", 200], ["/om", 200], [`/klinikk/${clinicSlug}`, 200], ["/finnes-ikke-404", 404]];
    const html: Record<string, string> = {};
    for (const [p, status] of pages) {
      const r = await callRoute(router, p);
      html[p] = r.text;
      const page = r.text;
      assertEq(r.status, status, `f1 ${p}: status`);
      assertEq([metaProp(page, "og:image"), metaProp(page, "twitter:image")], [png512Url, png512Url], `f2 ${p}: og:image and twitter:image are the 512 PNG`);
      assertEq([metaProp(page, "og:image:type"), metaProp(page, "og:image:width"), metaProp(page, "og:image:height")], ["image/png", "512", "512"],
        `f3 ${p}: og:image:type image/png, width and height 512`);
      const head = page.split("</head>")[0] ?? "";
      const iconLinks = [...head.matchAll(/<link rel="(icon|apple-touch-icon)"[^>]*>/g)].map((m) => m[0]);
      assertEq(iconLinks, [
        '<link rel="icon" type="image/svg+xml" href="/favicon.svg">',
        '<link rel="icon" type="image/png" sizes="192x192" href="/favicon-192.png">',
        '<link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png">',
      ], `f4 ${p}: the SVG icon first, then the 192 PNG and the 180 apple-touch-icon`);
      const iconPaths = iconLinks.map((l) => (l.match(/href="([^"]+)"/) || [])[1]).filter((h) => h !== "/favicon.svg");
      assertTrue(iconPaths.every((h) => icons.some((i) => i.path === h)), `f5 ${p}: every PNG icon link is one of the routes`);
      assertEq(metaProp(page, "twitter:card"), "summary", `f6 ${p}: twitter:card stays «summary» (a square image)`);
    }

    // ── (g) machine surfaces ──────────────────────────────────────────────
    {
      const org = jsonLdOf(html["/"]!).find((n) => n?.["@type"] === "Organization");
      assertEq(org?.logo, png512Url, "g1: the front page's Organization.logo is the 512 PNG (was favicon.svg)");
      const plug = await callRoute(router, "/.well-known/ai-plugin.json");
      assertEq((plug.body as any)?.logo_url, png512Url, "g2: ai-plugin.json logo_url is the 512 PNG (was favicon.svg)");
      if (base === "https://finn-tannlege.com") {
        assertEq([org?.logo, (plug.body as any)?.logo_url], [BRAND_ENTITIES.dental.logoPng, BRAND_ENTITIES.dental.logoPng],
          "g3: both equal BRAND_ENTITIES.dental.logoPng (the logo G3-S1-dental will read from there)");
      }
      assertEq(new URL(BRAND_ENTITIES.dental.logoPng ?? "https://x.invalid/").pathname, DENTAL_ICONS.png512.path,
        "g4: BRAND_ENTITIES.dental.logoPng names the route that serves the 512 PNG");
      for (const [p] of pages) {
        assertEq((html[p]!.match(/favicon\.svg/g) || []).length, 1, `g5 ${p}: favicon.svg is named once, in the SVG icon link (no og:image, logo or JSON-LD SVG)`);
      }
      assertTrue(!plug.text.includes("favicon.svg"), "g6: ai-plugin.json names no SVG");
    }
  } catch (err: any) {
    failed++;
    failures.push("dental icons: unexpected error: " + String(err?.stack || err?.message || err));
    if (log) console.log(`  ✗ unexpected error: ${err?.stack || err}`);
  } finally {
    if (prevDentalPath === undefined) delete process.env.DENTAL_DB_PATH;
    else process.env.DENTAL_DB_PATH = prevDentalPath;
    try {
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
    } catch {
      // best-effort cleanup
    }
    restoreModuleCache();
  }

  return { passed, failed, failures };
}

if (require.main === module) {
  console.log("── dental-icons: square PNG icons, og:image and logo for finn-tannlege.com (F2-S4) ──");
  runDentalIconsTests({ log: true }).then((r) => {
    console.log(`\ndental-icons: ${r.passed} passed, ${r.failed} failed`);
    if (r.failed > 0) console.log(r.failures.join("\n"));
    process.exit(r.failed > 0 ? 1 : 0);
  });
}
