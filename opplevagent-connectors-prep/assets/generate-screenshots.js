// Regenerates the MCP Apps catalog submission screenshots in this directory.
// Extracts EXPERIENCES_LIST_HTML / EXPERIENCE_DETAIL_HTML directly from
// src/routes/experiences-mcp.ts (source of truth) so the screenshots can never
// drift from the live card markup — no copy of the template is committed here.
//
// Usage: NODE_PATH=<path to playwright's install> node generate-screenshots.js
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const SRC = path.join(DIR, '..', '..', 'src', 'routes', 'experiences-mcp.ts');

function extractTemplate(constName) {
  const src = fs.readFileSync(SRC, 'utf8');
  const start = src.indexOf(`const ${constName} = \``);
  if (start === -1) throw new Error(`${constName} not found in ${SRC}`);
  const bodyStart = start + `const ${constName} = \``.length;
  // Find the first UNESCAPED closing backtick — a naive indexOf("`;") stops
  // early at the nested template literal's own escaped closing backtick.
  let end = bodyStart;
  for (;;) {
    end = src.indexOf('`;', end);
    if (end === -1) throw new Error(`unterminated template for ${constName}`);
    if (src[end - 1] !== '\\') break;
    end += 1;
  }
  const raw = src.slice(bodyStart, end);
  // Nested template-literal syntax (\` and \$) is escaped in the source so it
  // survives being embedded in the OUTER template literal; unescape it back
  // to plain, directly-runnable browser HTML/JS.
  return raw.replace(/\\`/g, '`').replace(/\\\$/g, '$');
}

function mockPage(html, dataObj) {
  const inject = `<script>window.openai = { getToolOutput: async () => (${JSON.stringify(dataObj)}), sendMessage: () => {} };</script>`;
  return html.replace('<script>', inject + '\n<script>');
}

async function shoot(browser, html, { name, data, width, scale, testWidths }) {
  const page = await browser.newPage({ viewport: { width, height: 100 }, deviceScaleFactor: scale });
  await page.setContent(mockPage(html, data), { waitUntil: 'networkidle' });
  await page.waitForTimeout(150);
  const box = await page.evaluate(() => ({
    w: Math.ceil(document.body.scrollWidth),
    h: Math.ceil(document.body.scrollHeight),
  }));
  await page.setViewportSize({ width: box.w, height: box.h });
  await page.screenshot({ path: path.join(DIR, name), fullPage: true });
  console.log(`${name}: css ${box.w}x${box.h} @${scale}x -> png width ~${Math.round(box.w * scale)}px`);
  await page.close();

  if (testWidths) {
    for (const w of testWidths) {
      const p2 = await browser.newPage({ viewport: { width: w, height: 100 } });
      await p2.setContent(mockPage(html, data), { waitUntil: 'networkidle' });
      await p2.waitForTimeout(150);
      const overflow = await p2.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
      console.log(`  [320px check] ${name} @ ${w}px viewport: horizontal-overflow=${overflow}`);
      await p2.close();
    }
  }
}

const listDataTroms = {
  results: [
    { title: "Arctic Explorer — Northern Lights Cruise from Tromsø", category: "sightseeing_transport", fylke: "Troms", kommune: "Tromsø", price_from: 800, duration_min: 180, slug: "arctic-explorer-northern-lights-cruise-from-tromso--72cad3eb" },
    { title: "Aurora Safari Camp — Fjord Tours Tromsø", category: "natur_friluft", fylke: "Troms", kommune: "Tromsø", price_from: 1490, duration_min: null, slug: "aurora-safari-camp-fjord-tours-tromso--f09aea75" },
    { title: "Fjellheisen — Tromsø Cable Car & Arctic Panorama", category: "sightseeing_transport", fylke: "Troms", kommune: "Tromsø", price_from: null, duration_min: null, slug: "fjellheisen-tromso-cable-car-arctic-panorama" },
    { title: "Dog Sledding in Tromsø — Best Arctic", category: "vinter_sno", fylke: "Troms", kommune: "Tromsø", price_from: null, duration_min: 75, slug: "dog-sledding-in-tromso-best-arctic" },
    { title: "Indoor Water Park & Spa — Nordlysbadet Harstad", category: "velvaere_spa", fylke: "Troms", kommune: "Harstad", price_from: 195, duration_min: 120, slug: "indoor-water-park-spa-nordlysbadet-harstad" },
  ],
};

const detailDataArctic = {
  title: "Arctic Explorer — Northern Lights Cruise from Tromsø",
  category: "sightseeing_transport", fylke: "Troms", indoor_outdoor: "outdoor",
  price_from: 800, duration_min: 180, description: null,
  booking_url: "https://arcticexplorer.no",
  slug: "arctic-explorer-northern-lights-cruise-from-tromso--72cad3eb",
};

const detailDataAurora = {
  title: "Aurora Safari Camp — Fjord Tours Tromsø",
  category: "natur_friluft", fylke: "Troms", indoor_outdoor: "outdoor",
  price_from: 1490, duration_min: null, description: null,
  booking_url: "https://www.visitnorway.com/listings/aurora-safari-camp-in-tromso/",
  slug: "aurora-safari-camp-fjord-tours-tromso--f09aea75",
};

const listDataMixed = {
  results: [
    { title: "Alta Museum — UNESCO World Heritage Rock Art Centre", category: "kultur_historie", fylke: "Finnmark", kommune: "Alta", price_from: null, duration_min: 90, slug: "alta-museum-unesco-world-heritage-rock-art-centre" },
    { title: "Aquarama Spa — Southern Norway's Largest Spa Centre in Kristiansand", category: "velvaere_spa", fylke: "Agder", kommune: "Kristiansand", price_from: null, duration_min: 120, slug: "aquarama-spa-southern-norways-largest-spa-centre-in-kristiansand" },
    { title: "Alpine Skiing at Hafjell — Family Ski Paradise", category: "vinter_sno", fylke: "Innlandet", kommune: "Øyer", price_from: null, duration_min: null, slug: "alpine-skiing-at-hafjell-family-ski-paradise" },
    { title: "Andenes Whale Safari — Sperm Whale Watching from the Arctic", category: "dyreliv_safari", fylke: "Nordland", kommune: "Andøy", price_from: 1100, duration_min: 240, slug: "andenes-whale-safari-sperm-whale-watching-from-the-arctic--b8646006" },
  ],
};

(async () => {
  const listHtml = extractTemplate('EXPERIENCES_LIST_HTML');
  const detailHtml = extractTemplate('EXPERIENCE_DETAIL_HTML');
  const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined });
  await shoot(browser, listHtml, { name: '01-experiences-list-troms.png', data: listDataTroms, width: 420, scale: 3, testWidths: [320] });
  await shoot(browser, detailHtml, { name: '02-experience-detail-arctic-explorer.png', data: detailDataArctic, width: 420, scale: 3, testWidths: [320] });
  await shoot(browser, detailHtml, { name: '03-experience-detail-aurora-safari.png', data: detailDataAurora, width: 420, scale: 3 });
  await shoot(browser, listHtml, { name: '04-experiences-list-national-mix.png', data: listDataMixed, width: 420, scale: 3 });
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
