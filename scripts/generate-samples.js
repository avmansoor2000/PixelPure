'use strict';
/**
 * Builds the landing-page before/after samples by running real photos through
 * the app's own processing pipeline (same code path as the API).
 * By default it uses whatever provider the server is configured with; set the
 * API keys in .env before running to regenerate the samples with AI output.
 *   npm run samples
 */
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');
const img = require('../server/services/imageUtils');
const providers = require('../server/providers');

const SRC = path.join(__dirname, 'sample-src');
const OUT = path.join(__dirname, '..', 'public', 'images', 'samples');
fs.mkdirSync(OUT, { recursive: true });

const svgText = (w, h, items) =>
  Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">${items
      .map(
        (t) =>
          `<text x="${t.x}" y="${t.y}" font-family="DejaVu Sans, Arial, sans-serif" font-weight="${t.weight || 700}" font-size="${t.size}" fill="${t.fill || '#fff'}" fill-opacity="${t.opacity ?? 0.55}" letter-spacing="${t.ls || 2}" ${t.rotate ? `transform="rotate(${t.rotate} ${t.x} ${t.y})"` : ''}>${t.text}</text>`
      )
      .join('')}</svg>`
  );

/** Overlay watermark text; return { watermarked, mask } where mask ≈ a user's brush strokes over it. */
async function watermark(file, items, brushPx = 7) {
  const base = sharp(path.join(SRC, file)).removeAlpha();
  const { width, height } = await base.metadata();
  const overlay = svgText(width, height, items);
  const watermarked = await base.composite([{ input: overlay }]).png().toBuffer();
  // brush-like mask: the text shape grown by a few pixels
  const solid = svgText(width, height, items.map((t) => ({ ...t, opacity: 1, fill: '#fff' })));
  const alpha = await sharp({ create: { width, height, channels: 3, background: '#000' } })
    .composite([{ input: solid }])
    .greyscale()
    .blur(brushPx)
    .png()
    .toBuffer();
  // second pass (sharp applies threshold before blur within one pipeline)
  const grown = await sharp(alpha).threshold(6).png().toBuffer();
  return { watermarked, mask: grown, width, height };
}

async function removeSample(name, file, items, brush) {
  const { watermarked, mask, width, height } = await watermark(file, items, brush);
  const { mask: prepared } = await img.prepareMask(mask, width, height);
  const provider = providers.resolve('inpaint');
  const raw = await provider.inpaint({ image: watermarked, mask: prepared, width, height });
  const result = await img.compositeMasked(watermarked, raw, prepared, width, height);
  await sharp(watermarked).jpeg({ quality: 90 }).toFile(path.join(OUT, `${name}-before.jpg`));
  await sharp(result).jpeg({ quality: 90 }).toFile(path.join(OUT, `${name}-after.jpg`));
  console.log(`${name}: inpainted with ${provider.label}`);
  return { watermarked, result, width, height };
}

async function enhanceSample(name, file, scale = 4) {
  const src = sharp(path.join(SRC, file)).removeAlpha();
  const { width, height } = await src.metadata();
  const w = Math.round(width / scale);
  const h = Math.round(height / scale);
  // degrade: downscale + sensor-like noise + mild blur
  const small = await src.resize(w, h, { kernel: 'cubic' }).raw().toBuffer();
  let seed = 42;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296 - 0.5);
  for (let i = 0; i < small.length; i++) small[i] = Math.max(0, Math.min(255, small[i] + rnd() * 26));
  const degraded = await sharp(small, { raw: { width: w, height: h, channels: 3 } }).blur(0.6).png().toBuffer();
  const provider = providers.resolve('enhance');
  const tw = w * scale;
  const th = h * scale;
  let out = await provider.enhance({ image: degraded, width: w, height: h, scale, targetWidth: tw, targetHeight: th, options: { denoise: true } });
  out = await img.resizeExact(out, tw, th);
  out = await img.autoTone(out);
  // "before" shown at the same display size with plain browser-style scaling
  await sharp(degraded).resize(tw, th, { kernel: 'cubic' }).jpeg({ quality: 90 }).toFile(path.join(OUT, `${name}-before.jpg`));
  await sharp(out).jpeg({ quality: 90 }).toFile(path.join(OUT, `${name}-after.jpg`));
  console.log(`${name}: enhanced ${scale}x with ${provider.label}`);
}

async function ogImage(before, after) {
  const W = 1200, H = 630;
  const half = await sharp(before).resize(W, H, { fit: 'cover' }).toBuffer();
  const full = await sharp(after).resize(W, H, { fit: 'cover' }).toBuffer();
  const leftHalf = await sharp(half).extract({ left: 0, top: 0, width: W / 2, height: H }).toBuffer();
  const shade = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
    <defs><linearGradient id="s" x1="0" y1="0" x2="0" y2="1"><stop offset="0.45" stop-color="#07070b" stop-opacity="0"/><stop offset="1" stop-color="#07070b" stop-opacity="0.92"/></linearGradient>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#a78bfa"/><stop offset="1" stop-color="#38bdf8"/></linearGradient></defs>
    <rect width="${W}" height="${H}" fill="url(#s)"/>
    <rect x="${W / 2 - 1.5}" y="0" width="3" height="${H}" fill="#fff"/>
    <text x="60" y="520" font-family="DejaVu Sans, Arial" font-weight="800" font-size="58" fill="#fff">Clean Your Images.</text>
    <text x="60" y="586" font-family="DejaVu Sans, Arial" font-weight="800" font-size="58" fill="url(#g)">Enhance Every Detail.</text>
    <rect x="60" y="48" width="44" height="44" rx="12" fill="url(#g)"/>
    <text x="118" y="82" font-family="DejaVu Sans, Arial" font-weight="700" font-size="30" fill="#fff">PixelPure</text>
  </svg>`);
  await sharp(full)
    .composite([{ input: leftHalf, left: 0, top: 0 }, { input: shade }])
    .jpeg({ quality: 88 })
    .toFile(path.join(__dirname, '..', 'public', 'images', 'og-image.jpg'));
  console.log('og-image.jpg written');
}

(async () => {
  const hero = await removeSample('hero', 'rocket.jpg', [
    { text: '© STOCKSHOT', x: 70, y: 100, size: 26, opacity: 0.6 },
    { text: 'PREVIEW', x: 362, y: 62, size: 30, opacity: 0.5, ls: 6 },
  ]);
  await removeSample('g1', 'coffee.png', [
    { text: '© photostock', x: 214, y: 152, size: 21, opacity: 0.45, fill: '#fff' },
    { text: 'SAMPLE', x: 110, y: 352, size: 24, opacity: 0.5, ls: 6, rotate: -8 },
  ]);
  await removeSample('g2', 'chelsea.png', [
    { text: '◎ PIXELSTOCK', x: 312, y: 28, size: 14, opacity: 0.8, ls: 1 },
    { text: "'19 06 14", x: 345, y: 284, size: 17, opacity: 0.95, fill: '#ff9a2e', weight: 700, ls: 1 },
  ], 5);
  await enhanceSample('g3', 'coffee.png', 4);
  await ogImage(hero.watermarked, hero.result);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
