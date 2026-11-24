'use strict';
const test = require('node:test');
const assert = require('node:assert');
const sharp = require('sharp');
const path = require('path');
const fs = require('fs');
const { form, startApp } = require('./helpers');
const geminiService = require('../server/services/geminiService');

let ctx;

test.before(async () => {
  ctx = await startApp();
});

test.after(() => ctx.server.close());

async function upload(buf, name = 'gemini_test.png', type = 'image/png') {
  const res = await fetch(`${ctx.base}/api/images`, {
    method: 'POST',
    body: form([['images', { data: buf, name, type }]]),
  });
  return { status: res.status, body: await res.json() };
}

/** Stamping helper: composites the Gemini watermark onto an image buffer using forward alpha blending */
async function stampGemini(baseBuf, size = 48, margin = 32, corner = 'br') {
  const meta = await sharp(baseBuf).metadata();
  const maps = await geminiService.loadAlphaMaps();
  const alphaMap = size === 96 ? maps.map96 : maps.map48;
  let left, top;
  if (corner === 'br') {
    left = meta.width - margin - size;
    top = meta.height - margin - size;
  } else if (corner === 'bl') {
    left = margin;
    top = meta.height - margin - size;
  } else if (corner === 'tr') {
    left = meta.width - margin - size;
    top = margin;
  } else {
    left = margin;
    top = margin;
  }

  const raw = await sharp(baseBuf).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const watermarked = Buffer.from(raw.data);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const a = alphaMap[y * size + x];
      const idx = ((top + y) * meta.width + (left + x)) * 3;
      for (let c = 0; c < 3; c++) {
        watermarked[idx + c] = Math.min(255, Math.max(0, Math.round((1 - a) * watermarked[idx + c] + a * 255)));
      }
    }
  }

  return sharp(watermarked, {
    raw: { width: meta.width, height: meta.height, channels: 3 },
  }).png().toBuffer();
}

/** Generate a realistic textured test pattern image */
async function createTestImage(w, h, pattern = 'gradient') {
  if (pattern === 'gradient') {
    const svg = `
      <svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">
        <defs>
          <linearGradient id="g" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stop-color="#2c3e50" />
            <stop offset="50%" stop-color="#3498db" />
            <stop offset="100%" stop-color="#e74c3c" />
          </linearGradient>
        </defs>
        <rect width="${w}" height="${h}" fill="url(#g)" />
        <circle cx="${w - 50}" cy="${h - 50}" r="30" fill="#27ae60" opacity="0.8" />
        <rect x="50" y="50" width="120" height="80" fill="#f1c40f" />
      </svg>
    `;
    return sharp(Buffer.from(svg)).removeAlpha().png().toBuffer();
  }
  // Solid color background
  return sharp({
    create: {
      width: w,
      height: h,
      channels: 3,
      background: { r: 50, g: 80, b: 120 },
    },
  }).png().toBuffer();
}

test('geminiService: detects 48px watermark on standard <= 1024px image', async () => {
  const orig = await createTestImage(512, 512, 'gradient');
  const stamped = await stampGemini(orig, 48, 32, 'br');

  const det = await geminiService.detect(stamped);
  assert.equal(det.detected, true, 'Watermark should be detected');
  assert.equal(det.size, 48, 'Watermark size should be 48');
  assert.equal(det.bbox.width, 48);
  assert.equal(det.bbox.height, 48);
  assert.ok(Math.abs(det.bbox.left - (512 - 32 - 48)) <= 1);
  assert.ok(Math.abs(det.bbox.top - (512 - 32 - 48)) <= 1);
  assert.ok(det.confidence >= 0.7, `Confidence should be high, got ${det.confidence}`);
});

test('geminiService: detects 96px watermark on > 1024px image', async () => {
  const orig = await createTestImage(1200, 1200, 'gradient');
  const stamped = await stampGemini(orig, 96, 64, 'br');

  const det = await geminiService.detect(stamped);
  assert.equal(det.detected, true, '96px Watermark should be detected');
  assert.equal(det.size, 96, 'Watermark size should be 96');
  assert.equal(det.bbox.width, 96);
  assert.equal(det.bbox.height, 96);
  assert.ok(Math.abs(det.bbox.left - (1200 - 64 - 96)) <= 1);
  assert.ok(Math.abs(det.bbox.top - (1200 - 64 - 96)) <= 1);
});

test('geminiService: zero false positives on clean images', async () => {
  // Test clean gradient image
  const clean1 = await createTestImage(512, 512, 'gradient');
  const det1 = await geminiService.detect(clean1);
  assert.equal(det1.detected, false, 'Clean gradient image must not be detected as watermarked');

  // Test clean solid image
  const clean2 = await createTestImage(600, 400, 'solid');
  const det2 = await geminiService.detect(clean2);
  assert.equal(det2.detected, false, 'Clean solid image must not be detected as watermarked');

  // Test image with a bright circle near bottom-right that is NOT a Gemini star
  const svg = `<svg width="500" height="500"><rect width="100%" height="100%" fill="#333"/><circle cx="440" cy="440" r="20" fill="#fff"/></svg>`;
  const circleImg = await sharp(Buffer.from(svg)).png().toBuffer();
  const detCircle = await geminiService.detect(circleImg);
  assert.equal(detCircle.detected, false, 'White circle must not trigger Gemini watermark detection');
});

test('geminiService: lossless reverse alpha restoration restores original pixel values', async () => {
  const orig = await createTestImage(512, 512, 'gradient');
  const stamped = await stampGemini(orig, 48, 32, 'br');

  const cleaned = await geminiService.remove(stamped);

  const origRaw = await sharp(orig).raw().toBuffer();
  const cleanedRaw = await sharp(cleaned).raw().toBuffer();
  const meta = await sharp(orig).metadata();

  // Compare pixels under the watermark bounding box:
  const x0 = 512 - 32 - 48;
  const y0 = 512 - 32 - 48;
  let totalDiff = 0;
  let maxDiff = 0;
  let count = 0;

  for (let y = y0; y < y0 + 48; y++) {
    for (let x = x0; x < x0 + 48; x++) {
      const idx = (y * meta.width + x) * 3;
      for (let c = 0; c < 3; c++) {
        const diff = Math.abs(origRaw[idx + c] - cleanedRaw[idx + c]);
        totalDiff += diff;
        if (diff > maxDiff) maxDiff = diff;
        count++;
      }
    }
  }

  const meanError = totalDiff / count;
  // Mean absolute error should be minimal (< 2.5 intensity levels out of 255)
  assert.ok(meanError < 2.5, `Mean reconstruction error under watermark was ${meanError.toFixed(2)}, expected < 2.5`);

  // Pixels outside the watermark bbox should remain 100% IDENTICAL
  const outsideX = 100;
  const outsideY = 100;
  const outIdx = (outsideY * meta.width + outsideX) * 3;
  for (let c = 0; c < 3; c++) {
    assert.equal(origRaw[outIdx + c], cleanedRaw[outIdx + c], 'Pixels outside watermark must be untouched');
  }
});

test('gemini API: full detect and remove flow', async () => {
  const orig = await createTestImage(400, 400, 'gradient');
  const stamped = await stampGemini(orig, 48, 32, 'br');

  // 1. Upload stamped image
  const { status, body } = await upload(stamped, 'gemini_sample.png');
  assert.equal(status, 201);
  const imgId = body.results[0].image.id;

  // 2. Call detect endpoint
  const detRes = await fetch(`${ctx.base}/api/images/${imgId}/detect-gemini`);
  assert.equal(detRes.status, 200);
  const detJson = await detRes.json();
  assert.equal(detJson.detected, true);
  assert.equal(detJson.size, 48);
  assert.ok(detJson.bbox);

  // 3. Call remove-gemini endpoint
  const remRes = await fetch(`${ctx.base}/api/images/${imgId}/remove-gemini`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(detJson),
  });
  assert.equal(remRes.status, 201);
  const remJson = await remRes.json();
  assert.equal(remJson.image.kind, 'gemini-remove');
  assert.equal(remJson.image.parentId, imgId);
  assert.equal(remJson.image.width, 400);
  assert.equal(remJson.image.height, 400);
  assert.equal(remJson.image.provider, 'gemini-math');
  assert.equal(remJson.image.providerLabel, 'Gemini Reverse-Alpha (Lossless)');

  // Verify downloaded cleaned image
  const cleanFetch = await fetch(`${ctx.base}${remJson.image.url}`);
  assert.equal(cleanFetch.status, 200);
  const cleanBuf = Buffer.from(await cleanFetch.arrayBuffer());
  const cleanMeta = await sharp(cleanBuf).metadata();
  assert.equal(cleanMeta.width, 400);
  assert.equal(cleanMeta.height, 400);
});

test('gemini API: returns 404 for unknown image ID', async () => {
  const res = await fetch(`${ctx.base}/api/images/non-existent-id/detect-gemini`);
  assert.equal(res.status, 404);
});
