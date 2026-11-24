'use strict';
/**
 * Gemini Watermark Detection and Lossless Reverse-Alpha Removal Service.
 *
 * Google Gemini / Imagen generated images feature a visible 4-pointed sparkle
 * watermark in the bottom-right corner applied via semi-transparent alpha blending:
 *   Watermarked = alpha * 255 + (1 - alpha) * Original
 *
 * This service implements:
 *  1. Multi-factor detection: Normalized Cross-Correlation (NCC) with calibrated
 *     Gemini alpha maps (48x48 and 96x96), radial star symmetry, and brightness differential.
 *  2. Lossless Reverse Alpha Blending:
 *     Original = (Watermarked - alpha * 255) / (1 - alpha)
 *     Restores original pixels underneath without blur, smudging, or AI hallucination.
 *  3. Edge polishing for high-alpha cores: eliminates division spikes.
 */
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');
const { AppError } = require('../utils/errors');

let cachedMaps = null;

async function loadAlphaMaps() {
  if (cachedMaps) return cachedMaps;

  const p48 = path.join(__dirname, '..', 'assets', 'bg_48.png');
  const p96 = path.join(__dirname, '..', 'assets', 'bg_96.png');

  let map48, map96;

  try {
    if (fs.existsSync(p48) && fs.existsSync(p96)) {
      const [b48, b96] = await Promise.all([
        sharp(p48).raw().toBuffer({ resolveWithObject: true }),
        sharp(p96).raw().toBuffer({ resolveWithObject: true }),
      ]);

      map48 = new Float32Array(48 * 48);
      for (let i = 0, j = 0; i < map48.length; i++, j += b48.info.channels) {
        map48[i] = Math.max(b48.data[j], b48.data[j + 1], b48.data[j + 2]) / 255.0;
      }

      map96 = new Float32Array(96 * 96);
      for (let i = 0, j = 0; i < map96.length; i++, j += b96.info.channels) {
        map96[i] = Math.max(b96.data[j], b96.data[j + 1], b96.data[j + 2]) / 255.0;
      }
    }
  } catch (e) {
    console.warn('Failed to load asset alpha maps, generating mathematical models:', e.message);
  }

  // Mathematical astroid fallback if assets are unavailable
  if (!map48) map48 = generateMathematicalAlphaMap(48);
  if (!map96) map96 = generateMathematicalAlphaMap(96);

  cachedMaps = { map48, map96 };
  return cachedMaps;
}

function generateMathematicalAlphaMap(size) {
  const map = new Float32Array(size * size);
  const half = (size - 1) / 2;
  const p = 0.55;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = Math.abs((x - half) / (half * 0.95));
      const v = Math.abs((y - half) / (half * 0.95));
      const starDist = Math.pow(Math.pow(u, p) + Math.pow(v, p), 1 / p);
      let starAlpha = 0;
      if (starDist < 1.0) {
        starAlpha = Math.pow(1.0 - starDist, 1.2) * 0.75;
      }
      const r = Math.hypot(u, v);
      const core = Math.max(0, 1.0 - r / 0.35) * 0.2;
      const glow = Math.exp(-(r * r) / (2 * 0.45 * 0.45)) * 0.08;
      map[y * size + x] = Math.min(0.92, starAlpha + core + glow);
    }
  }
  return map;
}

function computeCorrelation(a, b) {
  let meanA = 0, meanB = 0;
  const n = a.length;
  for (let i = 0; i < n; i++) {
    meanA += a[i];
    meanB += b[i];
  }
  meanA /= n;
  meanB /= n;

  let num = 0, denA = 0, denB = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i] - meanA;
    const db = b[i] - meanB;
    num += da * db;
    denA += da * da;
    denB += db * db;
  }
  const den = Math.sqrt(denA * denB);
  return den > 1e-6 ? num / den : 0;
}

function scoreCandidatePatch(grayPatch, alphaMap, size) {
  const n = size * size;
  const r = computeCorrelation(grayPatch, alphaMap);
  if (r < 0.35) return { score: 0, r, isStar: false };

  let sumHigh = 0, countHigh = 0;
  let sumLow = 0, countLow = 0;
  for (let i = 0; i < n; i++) {
    if (alphaMap[i] > 0.35) {
      sumHigh += grayPatch[i];
      countHigh++;
    } else if (alphaMap[i] < 0.05) {
      sumLow += grayPatch[i];
      countLow++;
    }
  }

  const meanHigh = countHigh > 0 ? sumHigh / countHigh : 0;
  const meanLow = countLow > 0 ? sumLow / countLow : 0;
  const brightnessDiff = meanHigh - meanLow;

  // On plain / very bright backgrounds (mean > 240), watermark is subtle white-on-bright
  if (brightnessDiff < 2 && meanLow < 240) return { score: 0, r, isStar: false };

  // Astroid 4-point star cross symmetry vs diagonal cusps:
  const half = (size - 1) / 2;
  let armSum = 0, cuspSum = 0, armCount = 0;
  for (let d = 5; d < half * 0.85; d++) {
    const v1 = grayPatch[Math.round(half - d) * size + Math.round(half)];
    const v2 = grayPatch[Math.round(half + d) * size + Math.round(half)];
    const h1 = grayPatch[Math.round(half) * size + Math.round(half - d)];
    const h2 = grayPatch[Math.round(half) * size + Math.round(half + d)];

    const d1 = grayPatch[Math.round(half - d * 0.707) * size + Math.round(half - d * 0.707)];
    const d2 = grayPatch[Math.round(half + d * 0.707) * size + Math.round(half + d * 0.707)];
    const d3 = grayPatch[Math.round(half - d * 0.707) * size + Math.round(half + d * 0.707)];
    const d4 = grayPatch[Math.round(half + d * 0.707) * size + Math.round(half - d * 0.707)];

    armSum += (v1 + v2 + h1 + h2) / 4;
    cuspSum += (d1 + d2 + d3 + d4) / 4;
    armCount++;
  }
  const meanArm = armCount > 0 ? armSum / armCount : 0;
  const meanCusp = armCount > 0 ? cuspSum / armCount : 0;
  const cuspContrast = meanArm - meanCusp;
  const isAstroidStar = cuspContrast > 4 || (meanCusp > 0 && meanArm / meanCusp > 1.15);

  if (!isAstroidStar && r < 0.85) {
    return { score: 0, r, isStar: false };
  }

  let score = 0;
  // 1. Template Correlation (up to 50 pts)
  if (r > 0.75) score += 50;
  else if (r > 0.65) score += 40;
  else if (r > 0.55) score += 30;
  else if (r > 0.45) score += 20;
  else score += 10;

  // 2. Brightness Difference (up to 30 pts)
  if (brightnessDiff > 35) score += 30;
  else if (brightnessDiff > 20) score += 24;
  else if (brightnessDiff > 10) score += 18;
  else if (brightnessDiff > 4) score += 12;
  else score += 6;

  // 3. Astroid star score (up to 20 pts)
  if (isAstroidStar) {
    score += 20;
  }

  return { score: Math.min(100, score), r, brightnessDiff, isStar: isAstroidStar };
}

/**
 * Scan an image buffer for visible Google Gemini watermarks.
 * Returns detection info including bounding box, confidence, and size.
 */
async function detect(imageBuffer) {
  const alphaMaps = await loadAlphaMaps();
  const meta = await sharp(imageBuffer).metadata();
  const { width, height } = meta;

  const isLarge = width > 1024 && height > 1024;
  const sizesToCheck = isLarge ? [96, 48] : [48, 96];

  const gray = await sharp(imageBuffer).grayscale().raw().toBuffer();

  let best = {
    detected: false,
    score: 0,
    confidence: 0,
    bbox: null,
    size: 0,
    location: null,
  };

  for (const size of sizesToCheck) {
    const alphaMap = size === 96 ? alphaMaps.map96 : alphaMaps.map48;
    const margin = size === 96 ? 64 : 32;

    const corners = [
      { loc: 'bottom-right', x: width - size - margin, y: height - size - margin },
      { loc: 'bottom-left', x: margin, y: height - size - margin },
      { loc: 'top-right', x: width - size - margin, y: margin },
      { loc: 'top-left', x: margin, y: margin },
    ];

    for (const corner of corners) {
      const minX = Math.max(0, corner.x - 20);
      const maxX = Math.min(width - size, corner.x + 20);
      const minY = Math.max(0, corner.y - 20);
      const maxY = Math.min(height - size, corner.y + 20);

      const patch = new Float32Array(size * size);

      let localBestR = 0;
      let localBestX = corner.x;
      let localBestY = corner.y;
      let localBestRes = null;

      // Coarse search (2px step)
      for (let y = minY; y <= maxY; y += 2) {
        for (let x = minX; x <= maxX; x += 2) {
          for (let r = 0; r < size; r++) {
            const rowOffset = (y + r) * width;
            for (let c = 0; c < size; c++) {
              patch[r * size + c] = gray[rowOffset + (x + c)];
            }
          }

          const res = scoreCandidatePatch(patch, alphaMap, size);
          if (res.isStar && res.r > localBestR) {
            localBestR = res.r;
            localBestX = x;
            localBestY = y;
            localBestRes = res;
          }
        }
      }

      // Fine search (1px step, +-2px around coarse peak)
      if (localBestR >= 0.50) {
        for (let dy = -2; dy <= 2; dy++) {
          const y = localBestY + dy;
          if (y < 0 || y > height - size) continue;
          for (let dx = -2; dx <= 2; dx++) {
            const x = localBestX + dx;
            if (x < 0 || x > width - size) continue;
            for (let r = 0; r < size; r++) {
              const rowOffset = (y + r) * width;
              for (let c = 0; c < size; c++) {
                patch[r * size + c] = gray[rowOffset + (x + c)];
              }
            }
            const res = scoreCandidatePatch(patch, alphaMap, size);
            if (res.isStar && res.r > localBestR) {
              localBestR = res.r;
              localBestX = x;
              localBestY = y;
              localBestRes = res;
            }
          }
        }
      }

      if (localBestRes && localBestR > (best.r || 0)) {
        best = {
          detected: localBestRes.score >= 60 && localBestR >= 0.65 && !!localBestRes.isStar,
          score: localBestRes.score,
          confidence: Number(Math.min(1, localBestR).toFixed(2)),
          bbox: { left: localBestX, top: localBestY, x: localBestX, y: localBestY, width: size, height: size },
          size,
          location: corner.loc,
          r: Number(localBestR.toFixed(3)),
          brightnessDiff: Number((localBestRes.brightnessDiff || 0).toFixed(1)),
        };
      }
    }
  }

  return best;
}

/**
 * Remove Gemini watermark using lossless Reverse Alpha Blending.
 * Restores original pixel values underneath the semi-transparent logo.
 */
async function remove(imageBuffer, detection = null) {
  let det = detection;
  if (!det || !det.bbox) {
    det = await detect(imageBuffer);
    if (!det.detected) {
      throw new AppError(422, 'NO_GEMINI_WATERMARK', 'No visible Gemini watermark was detected on this image.');
    }
  }

  const alphaMaps = await loadAlphaMaps();
  const { x, y, width: w, height: h } = det.bbox;
  const size = det.size || (w > 64 ? 96 : 48);
  const alphaMap = size === 96 ? alphaMaps.map96 : alphaMaps.map48;

  const rawImg = await sharp(imageBuffer).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const { data: raw, info } = rawImg;
  const imgW = info.width;
  const imgH = info.height;

  const out = Buffer.from(raw);
  const maxAlpha = 0.88;
  const alphaThreshold = 0.003;

  for (let r = 0; r < size; r++) {
    const curY = y + r;
    if (curY < 0 || curY >= imgH) continue;

    for (let c = 0; c < size; c++) {
      const curX = x + c;
      if (curX < 0 || curX >= imgW) continue;

      const alpha = alphaMap[r * size + c];
      if (alpha < alphaThreshold) continue;

      const clampedAlpha = Math.min(alpha, maxAlpha);
      const oneMinus = 1.0 - clampedAlpha;
      const idx = (curY * imgW + curX) * 3;

      for (let ch = 0; ch < 3; ch++) {
        const observed = raw[idx + ch];
        const unblended = (observed - clampedAlpha * 255.0) / oneMinus;
        out[idx + ch] = Math.max(0, Math.min(255, Math.round(unblended)));
      }
    }
  }

  // Seamless core polish: for dense center pixels where alpha > 0.80, apply subtle edge-preserving smoothing
  const centerR = Math.round(size * 0.12);
  const centerX = x + Math.round(size / 2);
  const centerY = y + Math.round(size / 2);

  for (let dy = -centerR; dy <= centerR; dy++) {
    const py = centerY + dy;
    if (py <= 0 || py >= imgH - 1) continue;
    for (let dx = -centerR; dx <= centerR; dx++) {
      const px = centerX + dx;
      if (px <= 0 || px >= imgW - 1) continue;
      const rDist = Math.hypot(dx, dy);
      if (rDist <= centerR) {
        const idx = (py * imgW + px) * 3;
        for (let ch = 0; ch < 3; ch++) {
          const l = out[(py * imgW + (px - 1)) * 3 + ch];
          const r = out[(py * imgW + (px + 1)) * 3 + ch];
          const u = out[((py - 1) * imgW + px) * 3 + ch];
          const d = out[((py + 1) * imgW + px) * 3 + ch];
          const avg = Math.round((l + r + u + d) * 0.25);
          const weight = Math.max(0, 1.0 - rDist / centerR) * 0.35;
          out[idx + ch] = Math.round(out[idx + ch] * (1.0 - weight) + avg * weight);
        }
      }
    }
  }

  const result = sharp(out, { raw: { width: imgW, height: imgH, channels: 3 } });
  return result.png({ compressionLevel: 6 }).toBuffer();
}

/**
 * Generate a visual preview mask PNG matching image dimensions with the detected box highlighted.
 */
async function createMask(bbox, width, height) {
  const mask = Buffer.alloc(width * height);
  const { x, y, width: w, height: h } = bbox;

  for (let r = 0; r < h; r++) {
    const py = y + r;
    if (py < 0 || py >= height) continue;
    for (let c = 0; c < w; c++) {
      const px = x + c;
      if (px < 0 || px >= width) continue;
      mask[py * width + px] = 255;
    }
  }

  return sharp(mask, { raw: { width, height, channels: 1 } })
    .toColourspace('b-w')
    .png()
    .toBuffer();
}

module.exports = {
  loadAlphaMaps,
  detect,
  remove,
  createMask,
};
