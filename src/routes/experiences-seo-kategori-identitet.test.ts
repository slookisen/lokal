/**
 * experiences-seo-kategori-identitet.test.ts — route-level tests for S1 of
 * dev-request 2026-08-08-opplevagent-per-kategori-visuell-identitet: the
 * generalised scene-sketch machinery (one shared 26s timeline, N motifs), the
 * three new category motifs, the homepage's own motif, and the shared-chrome
 * adoption on /kategori/:category.
 *
 * Covers (per the S1 spec):
 *   (a) each of the three category motifs renders on ITS OWN category page and
 *       on NEITHER of the other two — the drawings are per-surface identities,
 *       not one shared picture.
 *   (b) a category with no motif (mat_drikke) renders the chrome but NO
 *       drawing at all: no stage wrapper, no .oa-still-sketch layer, no sketch
 *       CSS — never some other category's motif.
 *   (c) BOTH lookups are own-property guarded, tested DIRECTLY on the
 *       functions (not through the route — /kategori/constructor 404s on the
 *       empty-count guard long before it could reach a motif, so a
 *       route-level check stays green with the guard deleted): prototype keys
 *       ("constructor", "__proto__", "toString", "valueOf",
 *       "hasOwnProperty") resolve to NO drawing from sceneSketchSvg() AND to
 *       undefined from categorySketchMotif().
 *   (d) the homepage renders its OWN motif and never a category motif — and
 *       never the gardssalg pot still (Daniel's S2b directive still holds).
 *   (e) regression: /kategori/gardssalg still renders exactly the distillery —
 *       and the drawing itself is PINNED to a sha256 checksum + signature
 *       substrings, NOT merely compared against gardssalgStillSketchSvg()
 *       from the same build. A self-referential comparison moves on both
 *       sides at once: it stays green when the path data is edited, which is
 *       exactly the invariant this whole design rests on (the phase classes
 *       keep their historical names BECAUSE the gardssalg output is frozen).
 *       The shared timeline CSS is pinned the same way, by exact literals.
 *   (f) every @keyframes and every stroke-dasharray on every sketch surface
 *       lives inside a prefers-reduced-motion:no-preference guard (reduce ⇒
 *       the static finished drawing), and adding motifs added NO keyframes:
 *       the count is the same 8 on every surface.
 *   (g) the layer is decorative and click-through everywhere: aria-hidden on
 *       the wrapper AND both crops, absolute inset:0 + pointer-events:none +
 *       z-index:0 under z-lifted content, stage wraps the content element.
 *   (h) each motif ships a wide AND a narrow crop with DIFFERENT viewBoxes
 *       (the ≤700px phone crop), and stays hand-written-small (<50 000 chars).
 *   (i) chrome adoption on /kategori/:category: the S1 hamburger nav
 *       (#oa-nav-toggle + .nav-burger), the «For tilbydere» entry, the full
 *       .site-footer — and the old slim `<nav class="site-nav">`/`.site-foot`
 *       mini-footer gone. Negative control: /opplevelser is untouched.
 *
 * Same synthetic-harness + in-memory-DB pattern as
 * experiences-seo-gardssalg-typesider.test.ts (S2b/S3). Routes are invoked
 * directly on their router layer (the tests/test.ts invokeSeo pattern) so a
 * handler's next() is observable as handled=false instead of falling through
 * to the router's trailing 404 catch-all.
 *
 * Two ways to run:
 *   1. Standalone:  npx tsx src/routes/experiences-seo-kategori-identitet.test.ts
 *   2. Wired into the gate: tests/test.ts imports
 *      runExperiencesSeoKategoriIdentitetTests() and folds its pass/fail
 *      counts into the `npm test` summary.
 */

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

type InvokeResult = {
  found: boolean;   // the router has a layer for the route path at all
  handled: boolean; // the handler sent a response (false = it next()'d)
  status: number;
  body: string;
  headers: Record<string, string>;
};

// Direct route-layer invocation (the tests/test.ts invokeSeo pattern): finds
// the GET layer whose route.path matches, calls its final handler with a
// synthetic req/res, and reports next() as handled=false. All the handlers
// under test are synchronous (they end in res.send/res.redirect before
// returning), so the result is complete when the call returns.
function invokeRoute(
  router: any,
  routePath: string,
  params: Record<string, string>,
  reqPath: string,
  query: Record<string, string> = {}
): InvokeResult {
  const layer = (router.stack as any[]).find(
    (l: any) => l.route && l.route.path === routePath && l.route.methods?.get
  );
  if (!layer) return { found: false, handled: false, status: 0, body: "", headers: {} };
  let status = 200;
  let body = "";
  let handled = false;
  const headers: Record<string, string> = {};
  const res: any = {
    statusCode: 200,
    setHeader(k: string, v: string) { headers[k.toLowerCase()] = String(v); },
    status(code: number) { status = code; this.statusCode = code; return this; },
    send(b: unknown) { handled = true; body = typeof b === "string" ? b : String(b); return this; },
    redirect(code: number, loc: string) {
      handled = true;
      status = code;
      headers["location"] = loc;
      return this;
    },
  };
  const req: any = {
    method: "GET",
    path: reqPath,
    originalUrl: reqPath,
    url: reqPath,
    hostname: "opplevagent.no",
    params,
    query,
    headers: {},
    lang: "no",
    get() { return undefined; },
  };
  const handler = layer.route.stack[layer.route.stack.length - 1].handle;
  handler(req, res, () => { /* next() */ });
  return { found: true, handled, status, body, headers };
}

function countOccurrences(haystack: string, needle: string): number {
  let n = 0;
  let idx = haystack.indexOf(needle);
  while (idx >= 0) {
    n++;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return n;
}

const REDUCED_MOTION_PRELUDE = "@media (prefers-reduced-motion: no-preference)";

// Media-block helpers (same brace-matching approach as the S2b test — a regex
// can't balance the nested @keyframes braces). extractAllMediaBlocks
// concatenates EVERY matching block: a sketch page can carry more than one
// no-preference guard (hero steam + the sketch timeline).
function extractMediaBlock(css: string, mediaPrelude: string): { block: string; rest: string } | null {
  const start = css.indexOf(mediaPrelude);
  if (start < 0) return null;
  const braceStart = css.indexOf("{", start);
  if (braceStart < 0) return null;
  let depth = 0;
  for (let i = braceStart; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}") {
      depth--;
      if (depth === 0) return { block: css.slice(braceStart + 1, i), rest: css.slice(i + 1) };
    }
  }
  return null;
}

function extractAllMediaBlocks(css: string, mediaPrelude: string): string[] {
  const blocks: string[] = [];
  let rest = css;
  for (;;) {
    const hit = extractMediaBlock(rest, mediaPrelude);
    if (!hit) break;
    blocks.push(hit.block);
    rest = hit.rest;
  }
  return blocks;
}

export function runExperiencesSeoKategoriIdentitetTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];

  function assertTrue(cond: boolean, label: string): void {
    if (cond) {
      passed++;
      if (log) console.log(`  ok ${label}`);
    } else {
      failed++;
      failures.push(`✗ ${label}`);
      if (log) console.log(`  ✗ ${label}`);
    }
  }

  return (async () => {
    const prevExperiencesDbPath = process.env.EXPERIENCES_DB_PATH;
    process.env.EXPERIENCES_DB_PATH = ":memory:";

    const dbFactoryPath = require.resolve("../database/db-factory");
    const expStorePath = require.resolve("../services/experience-store");
    const seoPath = require.resolve("./experiences-seo");
    const cachePaths = [dbFactoryPath, expStorePath, seoPath];
    for (const p of cachePaths) delete require.cache[p];

    try {
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const db = dbFactory.getDb("experiences");
      const store = require("../services/experience-store") as typeof import("../services/experience-store");

      // ── Fixture ───────────────────────────────────────────────────────
      // 5 visible gardssalg providers (→ gardssalgVisible(), so the catalog
      // route renders) + at least one published experience in each of the
      // three motif categories AND in one category deliberately WITHOUT a
      // motif (mat_drikke — the negative control for (b)).
      for (const [id, navn, type] of [
        ["ki-brygg-1", "Liaberg Bryggeri", "bryggeri"],
        ["ki-brygg-2", "Haugtun Bryggeri", "bryggeri"],
        ["ki-sideri-1", "Eplelund Sideri", "sideri"],
        ["ki-mjod-1", "Vollen Mjøderi", "mjøderi"],
        ["ki-dest-1", "Fjellheim Destilleri", "destilleri"],
      ] as const) {
        db.prepare(
          `INSERT INTO experience_providers
             (id, navn, vertical, fylke, kommune, poststed, producer_type, booking_live, catalog_hidden,
              rfb_seed_source, lat, lon, geocode_confidence, slug, enrichment_state, verification_status, source, confidence)
           VALUES
             (?, ?, 'experiences', 'Innlandet', 'Ringsaker', 'Brumunddal', ?, NULL, NULL,
              NULL, 60.88, 10.94, 'high', ?, 'raw', 'pending_verify', 'test-fixture', 'medium')`
        ).run(id, navn, type, id);
      }

      const provId = store.createProvider({
        navn: "Identitet Opplevelser AS", org_nr: "919191919",
        fylke: "Innlandet", kommune: "Lom", brreg_verified: 1, brreg_active: 1,
        verification_status: "verified",
      });
      for (const [title, category, kommune] of [
        ["Fottur til Besseggen", "natur_friluft", "Vågå"],
        ["Telttur i Femundsmarka", "natur_friluft", "Engerdal"],
        ["Stavkirkevandring i Lom", "kultur_historie", "Lom"],
        ["Runesteiner og gravhauger", "kultur_historie", "Tønsberg"],
        ["Fjordcruise til Geiranger", "sightseeing_transport", "Stranda"],
        ["Trollstigen med buss", "sightseeing_transport", "Rauma"],
        ["Ostesmaking på gården", "mat_drikke", "Time"],
        ["Tapasvandring i Oslo", "mat_drikke", "Oslo"],
      ] as const) {
        store.createExperience({
          title, provider_id: provId, provider_match_status: "matched",
          category, fylke: "Innlandet", kommune, indoor_outdoor: "outdoor",
          description: `${title} — testfixtur.`,
          confidence: "high", verification_status: "verified",
        });
      }

      const seo = require("./experiences-seo") as typeof import("./experiences-seo");
      const router = (seo as any).default;
      const sceneSketchSvg = (seo as any).sceneSketchSvg as (motif: string) => string;
      const gardssalgStillSketchSvg = (seo as any).gardssalgStillSketchSvg as () => string;
      const categorySketchMotif = (seo as any).categorySketchMotif as (c: string) => string | undefined;

      const CAT_ROUTE = "/kategori/:category";
      const MOTIF_CATS = ["natur_friluft", "kultur_historie", "sightseeing_transport"] as const;
      const pages: Record<string, InvokeResult> = {};
      for (const c of MOTIF_CATS) {
        pages[c] = invokeRoute(router, CAT_ROUTE, { category: c }, `/kategori/${c}`);
      }
      const noMotif = invokeRoute(router, CAT_ROUTE, { category: "mat_drikke" }, "/kategori/mat_drikke");
      const home = invokeRoute(router, "/", {}, "/");
      const gard = invokeRoute(router, "/kategori/gardssalg", {}, "/kategori/gardssalg");

      for (const c of MOTIF_CATS) {
        assertTrue(
          pages[c].found && pages[c].handled && pages[c].status === 200,
          `setup-${c}: GET /kategori/${c} renders 200 (got found=${pages[c].found} handled=${pages[c].handled} status=${pages[c].status})`
        );
      }
      assertTrue(noMotif.handled && noMotif.status === 200, `setup-mat_drikke: GET /kategori/mat_drikke renders 200 (got ${noMotif.status})`);
      assertTrue(home.handled && home.status === 200, `setup-home: GET / renders 200 (got ${home.status})`);
      assertTrue(gard.handled && gard.status === 200, `setup-gardssalg: GET /kategori/gardssalg renders 200 (got ${gard.status})`);

      // ── (a) each motif on its own page, on neither of the others ──────
      // The whole <div class="oa-still-sketch">…</div> string is
      // deterministic, so an exact substring match is an exact identity
      // match: no path of another motif's drawing can satisfy it.
      for (const c of MOTIF_CATS) {
        const own = sceneSketchSvg(c);
        assertTrue(own.length > 0, `a0-${c}: sceneSketchSvg("${c}") returns a drawing`);
        assertTrue(pages[c].body.includes(own), `a1-${c}: /kategori/${c} renders its OWN motif`);
        for (const other of MOTIF_CATS) {
          if (other === c) continue;
          assertTrue(
            !pages[c].body.includes(sceneSketchSvg(other)),
            `a2-${c}-not-${other}: /kategori/${c} does NOT render the ${other} motif`
          );
        }
        assertTrue(
          !pages[c].body.includes(gardssalgStillSketchSvg()),
          `a3-${c}: /kategori/${c} does NOT render the gardssalg pot still`
        );
        assertTrue(
          !pages[c].body.includes(sceneSketchSvg("forside")),
          `a4-${c}: /kategori/${c} does NOT render the homepage motif`
        );
      }
      // The three motifs really are three different drawings (a copy-paste
      // slip that pointed two registry entries at the same scene would keep
      // every assertion above green).
      const scenes = MOTIF_CATS.map((c) => sceneSketchSvg(c));
      assertTrue(
        new Set(scenes).size === MOTIF_CATS.length,
        "a5: the three category motifs are three DISTINCT drawings"
      );

      // ── (b) a category with no motif gets no drawing at all ───────────
      assertTrue(!noMotif.body.includes("oa-still-sketch"), "b1: a motif-less category renders NO sketch layer");
      assertTrue(!noMotif.body.includes("oa-sketch-stage"), "b2: …and no stage wrapper");
      assertTrue(!noMotif.body.includes("@keyframes oaSk"), "b3: …and none of the sketch timeline CSS");
      for (const c of MOTIF_CATS) {
        assertTrue(
          !noMotif.body.includes(sceneSketchSvg(c)),
          `b4-${c}: a motif-less category never falls back to the ${c} motif`
        );
      }

      // ── (c) own-property guard on the motif lookup ────────────────────
      for (const protoKey of ["constructor", "__proto__", "toString", "valueOf", "hasOwnProperty"]) {
        assertTrue(
          sceneSketchSvg(protoKey) === "",
          `c1-${protoKey}: sceneSketchSvg("${protoKey}") resolves to NO drawing (own-property guarded)`
        );
      }
      assertTrue(sceneSketchSvg("finnes_ikke") === "", "c2: an unknown motif name resolves to no drawing");
      // The SECOND lookup — category slug → motif name — needs its own guard
      // and its own direct test. Asserting this through the route would be
      // vacuous: /kategori/constructor 404s on the empty-count guard before
      // any motif is resolved, so a route-level check passes even with
      // Object.hasOwn removed. Call the resolver itself.
      assertTrue(typeof categorySketchMotif === "function", "c3: categorySketchMotif is exported for direct testing");
      for (const protoKey of ["constructor", "__proto__", "toString", "valueOf", "hasOwnProperty"]) {
        assertTrue(
          categorySketchMotif(protoKey) === undefined,
          `c4-${protoKey}: categorySketchMotif("${protoKey}") is undefined (own-property guarded)`
        );
      }
      assertTrue(categorySketchMotif("finnes_ikke") === undefined, "c5: an unknown category resolves to no motif");
      assertTrue(categorySketchMotif("mat_drikke") === undefined, "c6: a live category without a motif resolves to no motif");
      for (const c of MOTIF_CATS) {
        assertTrue(categorySketchMotif(c) === c, `c7-${c}: the three motif categories resolve to their own motif`);
      }
      // Positive control for the guard itself: a prototype key must not merely
      // be absent from the drawing — it must not resolve at all, so a page
      // built from one can never paint.
      for (const protoKey of ["constructor", "toString"]) {
        const r = invokeRoute(router, CAT_ROUTE, { category: protoKey }, `/kategori/${protoKey}`);
        assertTrue(
          !r.handled || !r.body.includes("oa-still-sketch"),
          `c8-${protoKey}: /kategori/${protoKey} never renders a drawing end-to-end either`
        );
      }

      // ── (d) the homepage's own motif, and only that ───────────────────
      const forside = sceneSketchSvg("forside");
      assertTrue(forside.length > 0, "d1: sceneSketchSvg(\"forside\") returns a drawing");
      assertTrue(home.body.includes(forside), "d2: the homepage renders its OWN motif");
      assertTrue(
        !home.body.includes(gardssalgStillSketchSvg()),
        "d3: the gardssalg pot still NEVER renders on the homepage (S2b directive)"
      );
      for (const c of MOTIF_CATS) {
        assertTrue(!home.body.includes(sceneSketchSvg(c)), `d4-${c}: the homepage does NOT render the ${c} category motif`);
      }
      // It sits in the LIGHT band under the hero (the stage wraps the
      // #kategorier section) — the dark hero scene is a separate layer that
      // this slice never touches.
      const iStageHome = home.body.indexOf('class="oa-sketch-stage"');
      const iSketchHome = home.body.indexOf('class="oa-still-sketch"');
      const iKatHome = home.body.indexOf('id="kategorier"');
      assertTrue(
        iStageHome >= 0 && iSketchHome > iStageHome && iKatHome > iSketchHome &&
        home.body.includes(".oa-sketch-stage>.section{position:relative;z-index:1}"),
        `d5: homepage stage(${iStageHome}) wraps sketch(${iSketchHome}) + #kategorier(${iKatHome}), section z-lifted above the drawing`
      );
      assertTrue(
        home.body.includes('<svg class="hero-scene hero-scene-forside"'),
        "d6: the dark hero scene is still rendered (untouched by the sketch layer)"
      );

      // ── (e) gardssalg regression ──────────────────────────────────────
      assertTrue(
        gard.body.includes(gardssalgStillSketchSvg()),
        "e1: /kategori/gardssalg still renders exactly the distillery drawing"
      );
      // e1 alone is SELF-REFERENTIAL — it compares the page against the very
      // function that renders it, so both sides move together and a one-unit
      // edit to a path stays green. Pin the CONTENT instead: a checksum over
      // the whole layer, plus signature substrings that name the crops and one
      // concrete kettle path, so a drift is reported with a readable diff
      // rather than only a hex mismatch. If this ever fails intentionally,
      // the gardssalg surfaces are no longer byte-frozen — which invalidates
      // the phase-class naming the whole registry rests on. Update this hash
      // ONLY together with that decision.
      const GARDSSALG_SKETCH_SHA256 = "04f2e9232c53ecdb478f654b1111e3004175051c0f5825752aca87fcd07fc2d2";
      const gardssalgSvg = gardssalgStillSketchSvg();
      const actualSha = require("crypto").createHash("sha256").update(gardssalgSvg, "utf8").digest("hex");
      assertTrue(
        actualSha === GARDSSALG_SKETCH_SHA256,
        `e1b: the gardssalg drawing is byte-frozen (sha256 ${actualSha} vs pinned ${GARDSSALG_SKETCH_SHA256})`
      );
      assertTrue(gardssalgSvg.length === 7118, `e1c: …and its exact length is unchanged (got ${gardssalgSvg.length})`);
      for (const signature of [
        '<svg class="sketch-wide" viewBox="0 0 1440 1560"',
        '<svg class="sketch-narrow" viewBox="120 260 700 620"',
        '<path pathLength="1" d="M132 648 C114 540 160 446 252 440 C344 446 390 540 372 648"/>',
        '<path pathLength="1" d="M1283 512 V548 C1262 568 1254 598 1254 638 V754 C1254 768 1262 776 1276 776 H1326 C1340 776 1348 768 1348 754 V638 C1348 598 1340 568 1319 548 V512"/>',
      ]) {
        assertTrue(gard.body.includes(signature), `e1d: gardssalg page still carries the exact signature \`${signature.slice(0, 56)}…\``);
      }
      // The shared timeline CSS is byte-frozen for the same reason — pinned by
      // exact literals so a "harmless" reformat of a keyframe is caught too.
      for (const rule of [
        "@keyframes oaSkFade{0%,92%{opacity:1}97%,100%{opacity:0}}",
        "@keyframes oaSkKjele{0%,2%{stroke-dashoffset:1}16%,100%{stroke-dashoffset:0}}",
        "@keyframes oaSkHals{0%,15%{stroke-dashoffset:1}24%,100%{stroke-dashoffset:0}}",
        "@keyframes oaSkKond{0%,23%{stroke-dashoffset:1}36%,100%{stroke-dashoffset:0}}",
        "@keyframes oaSkRor{0%,35%{stroke-dashoffset:1}45%,100%{stroke-dashoffset:0}}",
        "@keyframes oaSkFlaske{0%,44%{stroke-dashoffset:1}54%,100%{stroke-dashoffset:0}}",
        "@keyframes oaSkDekor{0%,20%{stroke-dashoffset:1}56%,100%{stroke-dashoffset:0}}",
        "@keyframes oaSkVaeske{0%,58%{stroke-dashoffset:1}76%,100%{stroke-dashoffset:0}}",
        ".oa-still-sketch svg{display:block;width:100%;height:auto;opacity:.15}",
        ".oa-still-sketch path{fill:none;stroke:#0b2e29;stroke-width:2.6;stroke-linecap:round;stroke-linejoin:round}",
        ".oa-still-sketch .sk-vaeske path{stroke:#c98a2b;stroke-width:5}",
      ]) {
        assertTrue(gard.body.includes(rule), `e1e: the shared timeline CSS is unchanged — \`${rule.slice(0, 48)}…\``);
      }
      assertTrue(
        !gard.body.includes(forside) && MOTIF_CATS.every((c) => !gard.body.includes(sceneSketchSvg(c))),
        "e2: /kategori/gardssalg renders no other surface's motif"
      );

      // ── (f)+(g)+(h) per-surface layer discipline ──────────────────────
      const sketchSurfaces: Array<[string, InvokeResult, string]> = [
        ["natur_friluft", pages.natur_friluft, "natur_friluft"],
        ["kultur_historie", pages.kultur_historie, "kultur_historie"],
        ["sightseeing_transport", pages.sightseeing_transport, "sightseeing_transport"],
        ["forside", home, "forside"],
        ["gardssalg", gard, "gardssalg"],
      ];
      for (const [name, page, motif] of sketchSurfaces) {
        // (g) decorative + click-through + behind the content.
        assertTrue(
          page.body.includes('<div class="oa-still-sketch" aria-hidden="true">'),
          `g1-${name}: the layer wrapper is aria-hidden`
        );
        assertTrue(
          /<svg class="sketch-wide"[^>]*aria-hidden="true"[^>]*focusable="false">/.test(page.body) &&
          /<svg class="sketch-narrow"[^>]*aria-hidden="true"[^>]*focusable="false">/.test(page.body),
          `g2-${name}: both crops render aria-hidden + focusable="false"`
        );
        assertTrue(
          page.body.includes(".oa-still-sketch{position:absolute;inset:0;overflow:hidden;pointer-events:none;z-index:0}"),
          `g3-${name}: layer CSS is absolute inset:0 + pointer-events:none + z-index:0`
        );
        assertTrue(
          page.body.includes(".oa-sketch-stage{position:relative}"),
          `g4-${name}: the stage is the positioned ancestor of the layer`
        );
        assertTrue(
          countOccurrences(page.body, 'class="oa-still-sketch"') === 1,
          `g5-${name}: exactly ONE sketch layer on the page`
        );

        // (h) wide + narrow crops, different viewBoxes, hand-written-small.
        const svg = sceneSketchSvg(motif);
        const wide = (svg.match(/<svg class="sketch-wide" viewBox="([^"]+)"/) || [])[1];
        const narrow = (svg.match(/<svg class="sketch-narrow" viewBox="([^"]+)"/) || [])[1];
        assertTrue(!!wide && !!narrow, `h1-${name}: the motif ships a wide AND a narrow crop`);
        assertTrue(wide !== narrow, `h2-${name}: the narrow crop is a real crop, not the same viewBox (${wide} vs ${narrow})`);
        assertTrue(
          page.body.includes(".oa-still-sketch .sketch-narrow{display:none}") &&
          page.body.includes("@media(max-width:700px){"),
          `h3-${name}: only one crop is displayed at a time (≤700px swap)`
        );
        assertTrue(
          svg.length > 0 && svg.length < 50_000,
          `h4-${name}: the motif stays hand-written-small — under 50 000 chars (got ${svg.length})`
        );

        // (f) reduced-motion discipline.
        const guarded = extractAllMediaBlocks(page.body, REDUCED_MOTION_PRELUDE).join("\n");
        assertTrue(guarded.length > 0, `f1-${name}: the page has a prefers-reduced-motion:no-preference block`);
        assertTrue(
          countOccurrences(page.body, "@keyframes") === countOccurrences(guarded, "@keyframes"),
          `f2-${name}: EVERY @keyframes sits inside a no-preference guard`
        );
        assertTrue(
          countOccurrences(page.body, "stroke-dasharray:1}") === countOccurrences(guarded, "stroke-dasharray:1}"),
          `f3-${name}: the sketch's stroke-dasharray only exists inside the guard (reduce ⇒ static finished drawing)`
        );
        for (const kf of ["oaSkFade", "oaSkKjele", "oaSkHals", "oaSkKond", "oaSkRor", "oaSkFlaske", "oaSkDekor", "oaSkVaeske"]) {
          assertTrue(guarded.includes(`@keyframes ${kf}`), `f4-${name}-${kf}: shared timeline keyframe ${kf} is inside the guard`);
        }
        // The whole point of the generalisation: N motifs, ONE timeline.
        assertTrue(
          countOccurrences(page.body, "@keyframes oaSk") === 8,
          `f5-${name}: exactly 8 sketch keyframes on the page — adding motifs adds none (got ${countOccurrences(page.body, "@keyframes oaSk")})`
        );
      }
      // The catalog/browse surfaces lift a <main>; only the homepage needs
      // the extra <section> lift, and it must not leak onto the others.
      for (const [name, page] of [["natur_friluft", pages.natur_friluft], ["gardssalg", gard]] as const) {
        const iStage = page.body.indexOf('class="oa-sketch-stage"');
        const iSketch = page.body.indexOf('class="oa-still-sketch"');
        const iMain = page.body.indexOf('id="main"');
        assertTrue(
          iStage >= 0 && iSketch > iStage && iMain > iSketch &&
          page.body.includes(".oa-sketch-stage>main{position:relative;z-index:1}"),
          `g6-${name}: stage(${iStage}) wraps sketch(${iSketch}) + main(${iMain}), main z-lifted above the drawing`
        );
        assertTrue(
          !page.body.includes(".oa-sketch-stage>.section{"),
          `g7-${name}: the homepage-only <section> lift rule does not leak onto ${name}`
        );
      }

      // ── (i) shared chrome on the category pages ───────────────────────
      const chromePages: Array<[string, InvokeResult]> = [
        ["natur_friluft", pages.natur_friluft],
        ["kultur_historie", pages.kultur_historie],
        ["sightseeing_transport", pages.sightseeing_transport],
        ["mat_drikke", noMotif],
      ];
      for (const [name, page] of chromePages) {
        assertTrue(page.body.includes('id="oa-nav-toggle"'), `i1-${name}: category page carries the hamburger checkbox`);
        assertTrue(
          /<input type="checkbox" id="oa-nav-toggle" class="nav-toggle">\s*<label for="oa-nav-toggle" class="nav-burger"/.test(page.body),
          `i2-${name}: the checkbox immediately precedes the burger label as a sibling`
        );
        assertTrue(
          page.body.includes("#oa-nav-toggle:checked~.nav-links"),
          `i3-${name}: the CSS-only reveal rule ships with the page`
        );
        assertTrue(page.body.includes('href="/for-tilbydere"'), `i4-${name}: the «For tilbydere» entry is present`);
        assertTrue(page.body.includes('class="site-footer"'), `i5-${name}: the FULL shared footer replaces the mini-footer`);
        assertTrue(
          page.body.includes('href="/llms.txt"') && page.body.includes('href="/personvern"'),
          `i6-${name}: the shared footer's agent + legal links are present`
        );
        // NOT `brand-word` — the pre-chrome BROWSE_NAV renders that too, so
        // the assertion would survive the chrome being removed. The shared
        // chrome is identified by its own affordances: the labelled brand
        // link and the nav CTA pill, neither of which exists in BROWSE_NAV.
        assertTrue(
          /<a class="brand" href="\/" aria-label="[^"]+">/.test(page.body),
          `i7-${name}: the brand link is the shared chrome's (aria-labelled — BROWSE_NAV's is not)`
        );
        assertTrue(page.body.includes('class="nav-cta"'), `i7b-${name}: the shared chrome's nav CTA is present`);
        assertTrue(
          !page.body.includes('<nav class="site-nav"><div class="nav-inner">'),
          `i8-${name}: the old slim pre-chrome nav is GONE`
        );
        assertTrue(
          !page.body.includes('<footer class="site-foot">'),
          `i9-${name}: the old mini-footer is GONE`
        );
        // The nav is a page-level landmark, not part of <main>. indexOf()
        // returns -1 when the header is MISSING, and -1 < n is true — so the
        // ordering check must first assert the header exists, or it is
        // vacuously true in exactly the case it is meant to catch.
        const iHeader = page.body.indexOf('<header class="site-nav">');
        const iMainEl = page.body.indexOf('<main id="main"');
        assertTrue(iHeader >= 0, `i10-${name}: the shared chrome renders a <header class="site-nav"> landmark`);
        assertTrue(
          iMainEl >= 0 && iHeader < iMainEl,
          `i11-${name}: the shared nav precedes <main> (header=${iHeader}, main=${iMainEl})`
        );
      }
      // Negative control: the other browse pages still run the pre-chrome
      // slim nav until a later slice migrates them (BROWSE_NAV untouched).
      const opplevelser = invokeRoute(router, "/opplevelser", {}, "/opplevelser");
      assertTrue(opplevelser.handled && opplevelser.status === 200, `i12: GET /opplevelser renders 200 (got ${opplevelser.status})`);
      assertTrue(
        opplevelser.body.includes('<nav class="site-nav"><div class="nav-inner">') &&
        !opplevelser.body.includes('id="oa-nav-toggle"') &&
        !opplevelser.body.includes('class="nav-cta"') &&
        !opplevelser.body.includes("oa-still-sketch"),
        "i13: /opplevelser is untouched by this slice (slim nav, no hamburger, no CTA pill, no drawing)"
      );
    } catch (err: any) {
      failed++;
      failures.push("experiences-seo-kategori-identitet: unexpected error: " + String(err?.stack || err?.message || err));
    } finally {
      if (prevExperiencesDbPath === undefined) {
        delete process.env.EXPERIENCES_DB_PATH;
      } else {
        process.env.EXPERIENCES_DB_PATH = prevExperiencesDbPath;
      }
      try {
        const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
        dbFactory.__resetDbFactoryForTesting();
      } catch {
        // best-effort cleanup
      }
      for (const p of cachePaths) delete require.cache[p];
    }

    return { passed, failed, failures };
  })();
}

if (require.main === module) {
  runExperiencesSeoKategoriIdentitetTests({ log: true }).then((result) => {
    console.log(`\n${result.passed} passed, ${result.failed} failed`);
    // Explicit exit on success too: requiring the seo route module leaves
    // live handles (email-service/counter timers) on the event loop, so a
    // fully green standalone run would otherwise hang instead of exiting.
    process.exit(result.failed > 0 ? 1 : 0);
  });
}
