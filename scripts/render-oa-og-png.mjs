// Developer tool: pre-renders Opplevagent's PNG share cards (og:image).
// dev-request 2026-10-16-opplevagent-indekserbarhet-og-strukturdata, E2-S3.
//
//   npx tsx scripts/render-oa-og-png.mjs
//
// Writes src/public/og/opplevagent/<key>.png (1200×630) for every card in
// opplevagentOgPngCards() — one per CATEGORY_LABELS key plus `default` — and
// removes PNGs in that folder that are no longer in the set. Commit the
// result. Run it again whenever a category label, a category colour or
// renderExperienceOgImageSvg() changes; experiences-seo-og-png.test.ts fails
// until you do.
//
// The rasterizer and the brand font are fetched into a temporary folder for
// this run only and are never added to package.json, so production has no
// image dependency (no native module on the Alpine image, no Dockerfile
// change). Versions are pinned and only the bundled Outfit files are loaded
// (no system fonts), so the same input renders the same bytes on any machine.
//
// Each PNG carries a tEXt chunk with the SHA-256 of the SVG it was rendered
// from; the test compares it with the current SVG to catch a stale image.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const RESVG = '@resvg/resvg-js@2.6.2';
const OUTFIT = '@expo-google-fonts/outfit@0.4.3'; // Outfit (SIL OFL 1.1), the site's brand font
const OUTFIT_FILES = ['600SemiBold/Outfit_600SemiBold.ttf', '700Bold/Outfit_700Bold.ttf', '800ExtraBold/Outfit_800ExtraBold.ttf'];

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'src', 'public', 'og', 'opplevagent');

if (typeof zlib.crc32 !== 'function') throw new Error('Needs Node.js 20.15+ or 22.2+ (zlib.crc32).');

/** The PNG with a tEXt chunk `keyword\0text` inserted right after IHDR. */
function withTextChunk(png, keyword, text) {
  const ihdrEnd = 8 + 4 + 4 + png.readUInt32BE(8) + 4; // signature + IHDR (length, type, data, crc)
  const typeAndData = Buffer.concat([Buffer.from('tEXt', 'latin1'), Buffer.from(`${keyword}\0${text}`, 'latin1')]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(typeAndData.length - 4);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(typeAndData));
  return Buffer.concat([png.subarray(0, ihdrEnd), length, typeAndData, crc, png.subarray(ihdrEnd)]);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-og-png-'));
try {
  execFileSync('npm', ['install', '--prefix', tmp, '--no-save', '--no-package-lock', '--ignore-scripts', '--no-audit', '--no-fund', RESVG, OUTFIT], { stdio: 'inherit' });
  const { Resvg } = createRequire(path.join(tmp, 'package.json'))('@resvg/resvg-js');
  const fontFiles = OUTFIT_FILES.map((f) => path.join(tmp, 'node_modules', '@expo-google-fonts', 'outfit', f));

  const { opplevagentOgPngCards, OG_PNG_SOURCE_KEYWORD } = await import('../src/routes/experiences-seo.ts');
  const cards = opplevagentOgPngCards();

  fs.mkdirSync(outDir, { recursive: true });
  const keep = new Set(cards.map((c) => `${c.key}.png`));
  for (const f of fs.readdirSync(outDir)) {
    if (f.endsWith('.png') && !keep.has(f)) {
      fs.unlinkSync(path.join(outDir, f));
      console.log(`removed ${f} (no longer in the card set)`);
    }
  }
  for (const { key, svg } of cards) {
    const rendered = new Resvg(svg, {
      fitTo: { mode: 'original' },
      font: { loadSystemFonts: false, fontFiles, defaultFontFamily: 'Outfit', sansSerifFamily: 'Outfit' },
    }).render();
    if (rendered.width !== 1200 || rendered.height !== 630) {
      throw new Error(`${key}: rendered ${rendered.width}×${rendered.height}, expected 1200×630`);
    }
    const hash = createHash('sha256').update(svg).digest('hex');
    const png = withTextChunk(rendered.asPng(), OG_PNG_SOURCE_KEYWORD, hash);
    fs.writeFileSync(path.join(outDir, `${key}.png`), png);
    console.log(`${key}.png  ${png.length} bytes`);
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
// The imported route module keeps handles open (timers, DB factory); the work is done.
process.exit(0);
