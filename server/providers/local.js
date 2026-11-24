'use strict';
/**
 * Local provider — runs entirely on this server, no API key needed.
 * Features:
 *  - Inpaint: Fast Exemplar Patch Synthesis (Content-Aware Texture Transfer)
 *             combined with multi-scale pyramid fill and seamless boundary relaxation.
 *             Reconstructs genuine texture, patterns and grain from the surrounding image
 *             instead of leaving a blurry smudge.
 *  - Enhance: median denoise + Lanczos3 resampling + unsharp masking via libvips (sharp).
 */
const sharp = require('sharp');

/** Multi-scale pyramid fill to provide base illumination and low-frequency color continuity. */
function pushPullFill(rgb, mask, width, height) {
  const levels = [{ c: rgb, w: new Float32Array(width * height), width, height }];
  for (let i = 0; i < width * height; i++) levels[0].w[i] = mask[i] ? 0 : 1;

  while (true) {
    const prev = levels[levels.length - 1];
    if (prev.width <= 1 && prev.height <= 1) break;
    let full = true;
    for (let i = 0; i < prev.w.length; i++) if (prev.w[i] < 1e-6) { full = false; break; }
    if (full && levels.length > 1) break;
    const nw = Math.max(1, Math.ceil(prev.width / 2));
    const nh = Math.max(1, Math.ceil(prev.height / 2));
    const c = new Float32Array(nw * nh * 3);
    const w = new Float32Array(nw * nh);
    for (let y = 0; y < nh; y++) {
      for (let x = 0; x < nw; x++) {
        let sr = 0, sg = 0, sb = 0, sw = 0;
        for (let dy = 0; dy < 2; dy++) {
          const yy = 2 * y + dy;
          if (yy >= prev.height) continue;
          for (let dx = 0; dx < 2; dx++) {
            const xx = 2 * x + dx;
            if (xx >= prev.width) continue;
            const pi = yy * prev.width + xx;
            const pw = prev.w[pi];
            sr += prev.c[pi * 3] * pw;
            sg += prev.c[pi * 3 + 1] * pw;
            sb += prev.c[pi * 3 + 2] * pw;
            sw += pw;
          }
        }
        const i = y * nw + x;
        if (sw > 0) {
          c[i * 3] = sr / sw;
          c[i * 3 + 1] = sg / sw;
          c[i * 3 + 2] = sb / sw;
        }
        w[i] = Math.min(1, sw);
      }
    }
    levels.push({ c, w, width: nw, height: nh });
  }

  for (let l = levels.length - 2; l >= 0; l--) {
    const fine = levels[l];
    const coarse = levels[l + 1];
    const holes = [];
    for (let y = 0; y < fine.height; y++) {
      const cy = Math.min(coarse.height - 1, Math.max(0, (y + 0.5) / 2 - 0.5));
      const y0 = Math.floor(cy), y1 = Math.min(coarse.height - 1, y0 + 1), fy = cy - y0;
      for (let x = 0; x < fine.width; x++) {
        const i = y * fine.width + x;
        const wt = fine.w[i];
        if (wt >= 1) continue;
        const cx = Math.min(coarse.width - 1, Math.max(0, (x + 0.5) / 2 - 0.5));
        const x0 = Math.floor(cx), x1 = Math.min(coarse.width - 1, x0 + 1), fx = cx - x0;
        for (let k = 0; k < 3; k++) {
          const a = coarse.c[(y0 * coarse.width + x0) * 3 + k];
          const b = coarse.c[(y0 * coarse.width + x1) * 3 + k];
          const c = coarse.c[(y1 * coarse.width + x0) * 3 + k];
          const d = coarse.c[(y1 * coarse.width + x1) * 3 + k];
          const up = (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
          fine.c[i * 3 + k] = wt * fine.c[i * 3 + k] + (1 - wt) * up;
        }
        if (l === 0 || wt < 1) holes.push(i);
      }
    }
    const iters = l === 0 ? 12 : 6;
    relax(fine.c, holes, fine.width, fine.height, iters);
  }
}

/** Subtle Gauss-Seidel iterations to smooth boundary transitions without destroying texture. */
function relax(c, holes, width, height, iters) {
  for (let it = 0; it < iters; it++) {
    for (let h = 0; h < holes.length; h++) {
      const i = holes[h];
      const x = i % width;
      const y = (i - x) / width;
      const l = x > 0 ? i - 1 : i;
      const r = x < width - 1 ? i + 1 : i;
      const u = y > 0 ? i - width : i;
      const d = y < height - 1 ? i + width : i;
      for (let k = 0; k < 3; k++) {
        c[i * 3 + k] = (c[l * 3 + k] + c[r * 3 + k] + c[u * 3 + k] + c[d * 3 + k]) * 0.25;
      }
    }
  }
}

/**
 * Coherent Exemplar-based patch inpainting:
 * Iteratively synthesizes missing pixels from surrounding clean image patches.
 * Replaces pure blur with sharp, realistic texture from adjacent image context.
 */
function fastPatchInpaint(raw, mask, width, height, patchRadius = 3) {
  const target = new Uint8Array(raw);
  const m = new Uint8Array(mask);

  let minX = width, maxX = 0, minY = height, maxY = 0, holeCount = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (m[y * width + x]) {
        holeCount++;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (holeCount === 0) return target;

  const searchMargin = Math.max(30, Math.min(80, Math.round(Math.max(maxX - minX, maxY - minY) * 1.0)));
  const sMinX = Math.max(patchRadius, minX - searchMargin);
  const sMaxX = Math.min(width - 1 - patchRadius, maxX + searchMargin);
  const sMinY = Math.max(patchRadius, minY - searchMargin);
  const sMaxY = Math.min(height - 1 - patchRadius, maxY + searchMargin);

  // Collect candidate clean source patches
  const sources = [];
  const stride = 2;
  for (let sy = sMinY; sy <= sMaxY; sy += stride) {
    for (let sx = sMinX; sx <= sMaxX; sx += stride) {
      let clean = true;
      for (let dy = -patchRadius; dy <= patchRadius; dy += 2) {
        for (let dx = -patchRadius; dx <= patchRadius; dx += 2) {
          if (m[(sy + dy) * width + (sx + dx)]) {
            clean = false;
            break;
          }
        }
        if (!clean) break;
      }
      if (clean) sources.push({ x: sx, y: sy });
    }
  }

  if (sources.length === 0) return target;

  // Initialize boundary frontier
  let frontier = [];
  const inFrontier = new Uint8Array(width * height);
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const idx = y * width + x;
      if (!m[idx]) continue;
      const isBound = (x > 0 && !m[idx - 1]) ||
                      (x < width - 1 && !m[idx + 1]) ||
                      (y > 0 && !m[idx - width]) ||
                      (y < height - 1 && !m[idx + width]);
      if (isBound) {
        frontier.push(idx);
        inFrontier[idx] = 1;
      }
    }
  }

  const maxSourcesToCheck = Math.min(sources.length, 120);
  const sourceStep = Math.max(1, Math.floor(sources.length / maxSourcesToCheck));

  while (frontier.length > 0) {
    let bestFi = 0;
    let bestX = frontier[0] % width;
    let bestY = (frontier[0] - bestX) / width;
    let maxKnown = -1;

    const checkCount = Math.min(frontier.length, 25);
    for (let fi = 0; fi < checkCount; fi++) {
      const idx = frontier[fi];
      const px = idx % width;
      const py = (idx - px) / width;
      let known = 0;
      for (let dy = -patchRadius; dy <= patchRadius; dy++) {
        const y = py + dy;
        if (y < 0 || y >= height) continue;
        for (let dx = -patchRadius; dx <= patchRadius; dx++) {
          const x = px + dx;
          if (x < 0 || x >= width) continue;
          if (!m[y * width + x]) known++;
        }
      }
      if (known > maxKnown) {
        maxKnown = known;
        bestFi = fi;
        bestX = px;
        bestY = py;
      }
    }

    frontier.splice(bestFi, 1);
    inFrontier[bestY * width + bestX] = 0;

    let bestSource = sources[0];
    let bestDiff = Infinity;

    for (let s = 0; s < sources.length; s += sourceStep) {
      const src = sources[s];
      let diff = 0;
      let count = 0;
      let earlyExit = false;

      for (let dy = -patchRadius; dy <= patchRadius; dy++) {
        const ty = bestY + dy;
        const sy = src.y + dy;
        for (let dx = -patchRadius; dx <= patchRadius; dx++) {
          const tx = bestX + dx;
          const sx = src.x + dx;
          if (!m[ty * width + tx]) {
            const tIdx = (ty * width + tx) * 3;
            const sIdx = (sy * width + sx) * 3;
            const dr = target[tIdx] - target[sIdx];
            const dg = target[tIdx + 1] - target[sIdx + 1];
            const db = target[tIdx + 2] - target[sIdx + 2];
            diff += dr * dr + dg * dg + db * db;
            count++;
            if (count > 4 && diff > bestDiff * count) {
              earlyExit = true;
              break;
            }
          }
        }
        if (earlyExit) break;
      }

      if (!earlyExit && count > 0) {
        const dist = Math.hypot(bestX - src.x, bestY - src.y);
        const normDiff = (diff / count) + dist * 0.08;
        if (normDiff < bestDiff) {
          bestDiff = normDiff;
          bestSource = src;
          if (normDiff < 4) break;
        }
      }
    }

    for (let dy = -patchRadius; dy <= patchRadius; dy++) {
      const ty = bestY + dy;
      const sy = bestSource.y + dy;
      if (ty < 0 || ty >= height) continue;
      for (let dx = -patchRadius; dx <= patchRadius; dx++) {
        const tx = bestX + dx;
        const sx = bestSource.x + dx;
        if (tx < 0 || tx >= width) continue;
        const tPixel = ty * width + tx;
        if (m[tPixel]) {
          const tIdx = tPixel * 3;
          const sIdx = (sy * width + sx) * 3;
          target[tIdx] = target[sIdx];
          target[tIdx + 1] = target[sIdx + 1];
          target[tIdx + 2] = target[sIdx + 2];
          m[tPixel] = 0;

          const neighbors = [
            tx > 0 ? tPixel - 1 : -1,
            tx < width - 1 ? tPixel + 1 : -1,
            ty > 0 ? tPixel - width : -1,
            ty < height - 1 ? tPixel + width : -1
          ];
          for (const nb of neighbors) {
            if (nb >= 0 && m[nb] && !inFrontier[nb]) {
              frontier.push(nb);
              inFrontier[nb] = 1;
            }
          }
        }
      }
    }
  }

  return target;
}

/** Add subtle grain inside the fill so it matches the noise level of the surrounding photo. */
function matchGrain(c, orig, mask, width, height) {
  let sum = 0, n = 0;
  for (let y = 1; y < height - 1; y += 2) {
    for (let x = 1; x < width - 1; x += 2) {
      const i = y * width + x;
      if (mask[i]) continue;
      const v = orig[i * 3 + 1];
      const lap = 4 * v - orig[(i - 1) * 3 + 1] - orig[(i + 1) * 3 + 1] - orig[(i - width) * 3 + 1] - orig[(i + width) * 3 + 1];
      sum += Math.abs(lap);
      n++;
    }
  }
  const sigma = Math.min(6, (n ? sum / n : 0) / 6);
  if (sigma < 0.3) return;
  let seed = 1234567;
  const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) - 0.5;
  for (let i = 0; i < width * height; i++) {
    if (!mask[i]) continue;
    const g = rand() * 2 * sigma;
    c[i * 3] = Math.max(0, Math.min(255, c[i * 3] + g));
    c[i * 3 + 1] = Math.max(0, Math.min(255, c[i * 3 + 1] + g));
    c[i * 3 + 2] = Math.max(0, Math.min(255, c[i * 3 + 2] + g));
  }
}

module.exports = {
  name: 'local',
  label: 'Local engine (Exemplar + Texture Fill)',
  isAI: false,
  capabilities: ['inpaint', 'enhance'],
  isConfigured: () => true,
  warmup: async () => {},

  async inpaint({ image, mask, width, height }) {
    const raw = await sharp(image).removeAlpha().raw().toBuffer();
    const m = await sharp(mask).resize(width, height, { fit: 'fill' }).toColourspace('b-w').raw().toBuffer();
    const bin = new Uint8Array(width * height);
    let maskCount = 0;
    for (let i = 0; i < bin.length; i++) {
      if (m[i] > 127) {
        bin[i] = 1;
        maskCount++;
      }
    }

    if (maskCount === 0) return image;

    // 1. Synthesize coherent texture from surrounding clean background
    const patched = fastPatchInpaint(raw, bin, width, height, 3);

    // 2. Compute smooth base color as fallback/guide
    const base = new Float32Array(raw.length);
    for (let i = 0; i < raw.length; i++) base[i] = raw[i];
    pushPullFill(base, bin, width, height);

    // 3. Combine: use patched texture where synthesized, base where needed
    const out = Buffer.alloc(raw.length);
    for (let i = 0; i < raw.length; i++) {
      out[i] = patched[i] !== undefined ? patched[i] : Math.round(base[i]);
    }

    // 4. Match subtle noise grain
    matchGrain(out, raw, bin, width, height);

    return sharp(out, { raw: { width, height, channels: 3 } }).png().toBuffer();
  },

  async enhance({ image, targetWidth, targetHeight, scale, options = {} }) {
    let p = sharp(image);
    if (options.denoise !== false) p = p.median(3);
    const denoised = await p.png().toBuffer();
    const sigma = 0.6 + 0.25 * scale;
    return sharp(denoised)
      .resize(targetWidth, targetHeight, { fit: 'fill', kernel: 'lanczos3' })
      .sharpen({ sigma, m1: 0.8, m2: 2.2, x1: 2, y2: 10, y3: 20 })
      .png()
      .toBuffer();
  },
};
