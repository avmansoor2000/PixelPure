'use strict';
/**
 * Local provider — runs entirely on this server, no API key needed.
 * This is classical (non-generative) image processing and is labelled as such in the UI:
 *  - Inpaint: multi-scale "push-pull" fill followed by harmonic (Laplace) smoothing.
 *             Seamless on skies, walls, gradients and soft backgrounds; it cannot invent
 *             texture or structure — that is what the AI providers are for.
 *  - Enhance: median denoise + Lanczos3 resampling + unsharp masking via libvips (sharp).
 */
const sharp = require('sharp');

/** Fill masked pixels of a float RGB image in place. mask: Uint8 (1 = fill). */
function pushPullFill(rgb, mask, width, height) {
  // Build pyramid
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

  // Pull: fill each level from the coarser one, then relax toward a harmonic fill
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
    const iters = l === 0 ? 40 : 12;
    relax(fine.c, holes, fine.width, fine.height, iters);
  }
}

/** Gauss-Seidel iterations of the Laplace equation over hole pixels only. */
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

/** Add subtle grain inside the fill so it matches the noise level of the surrounding photo. */
function matchGrain(c, orig, mask, width, height) {
  // estimate noise from high-frequency energy outside the mask
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
    c[i * 3] += g;
    c[i * 3 + 1] += g;
    c[i * 3 + 2] += g;
  }
}

module.exports = {
  name: 'local',
  label: 'Local engine (non-AI)',
  isAI: false,
  capabilities: ['inpaint', 'enhance'],
  isConfigured: () => true,
  warmup: async () => {},

  async inpaint({ image, mask, width, height }) {
    const raw = await sharp(image).removeAlpha().raw().toBuffer();
    const m = await sharp(mask).resize(width, height, { fit: 'fill' }).toColourspace('b-w').raw().toBuffer();
    const bin = new Uint8Array(width * height);
    for (let i = 0; i < bin.length; i++) bin[i] = m[i] > 127 ? 1 : 0;
    const c = new Float32Array(raw.length);
    for (let i = 0; i < raw.length; i++) c[i] = raw[i];
    pushPullFill(c, bin, width, height);
    matchGrain(c, raw, bin, width, height);
    const out = Buffer.alloc(raw.length);
    for (let i = 0; i < raw.length; i++) out[i] = Math.max(0, Math.min(255, Math.round(c[i])));
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
