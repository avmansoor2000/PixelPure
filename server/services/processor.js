'use strict';
const config = require('../config');
const storage = require('./storage');
const img = require('./imageUtils');
const providers = require('../providers');
const { AppError, ProviderError } = require('../utils/errors');

// Simple semaphore so heavy jobs can't exhaust server memory.
const MAX_CONCURRENT = Math.max(1, parseInt(process.env.MAX_CONCURRENT_JOBS, 10) || 3);
let active = 0;
const waiting = [];
async function withSlot(fn) {
  if (active >= MAX_CONCURRENT) await new Promise((r) => waiting.push(r));
  active++;
  try {
    return await fn();
  } finally {
    active--;
    const next = waiting.shift();
    if (next) next();
  }
}

async function loadSource(id) {
  const meta = await storage.getMeta(id);
  const buffer = meta && (await storage.getBuffer(id));
  if (!meta || !buffer) throw new AppError(404, 'NOT_FOUND', 'This image has expired or does not exist. Please upload it again.');
  return { meta, buffer };
}

/** Run the configured provider for a capability, logging upstream failures server-side. */
async function runWithProvider(capability, fn, userKeys = {}) {
  const provider = providers.resolve(capability, userKeys);
  const started = Date.now();
  try {
    const out = await fn(provider);
    return { out, provider, ms: Date.now() - started };
  } catch (e) {
    if (e instanceof ProviderError) {
      console.error(`[${capability}] ${provider.name} failed:`, e.message, e.details || '');
    }
    throw e;
  }
}

async function inpaint(sourceId, maskBuffer, { userKeys = {} } = {}) {
  const { meta, buffer } = await loadSource(sourceId);
  const { width, height } = meta;
  const { mask, coverage } = await img.prepareMask(maskBuffer, width, height);
  if (coverage > 0.6) {
    throw new AppError(422, 'MASK_TOO_LARGE', 'The selection covers most of the image. Select only the watermark or object to remove.');
  }

  return withSlot(async () => {
    const { out, provider, ms } = await runWithProvider('inpaint', (p) => p.inpaint({ image: buffer, mask, width, height, userKeys }), userKeys);
    const composed = await img.compositeMasked(buffer, out, mask, width, height);
    const rec = await storage.save(composed, {
      width,
      height,
      kind: 'inpaint',
      parentId: sourceId,
      originalName: meta.originalName,
      provider: provider.name,
      providerLabel: provider.label,
      isAI: provider.isAI,
      processingMs: ms,
    });
    return rec;
  });
}

function computeTarget(width, height, scale) {
  let tw = width * scale;
  let th = height * scale;
  const maxSide = config.output.maxSide;
  const maxPixels = parseInt(process.env.OUTPUT_MAX_MEGAPIXELS, 10) * 1e6 || 50e6;
  let k = 1;
  if (Math.max(tw, th) > maxSide) k = Math.min(k, maxSide / Math.max(tw, th));
  if (tw * th > maxPixels) k = Math.min(k, Math.sqrt(maxPixels / (tw * th)));
  tw = Math.max(1, Math.round(tw * k));
  th = Math.max(1, Math.round(th * k));
  return { targetWidth: tw, targetHeight: th, capped: k < 1 };
}

async function enhance(sourceId, { scale = 2, denoise = true, autoLight = true, userKeys = {} } = {}) {
  if (![1, 2, 4].includes(scale)) throw new AppError(400, 'BAD_SCALE', 'Scale must be 1, 2 or 4.');
  const { meta, buffer } = await loadSource(sourceId);
  const { width, height } = meta;
  const { targetWidth, targetHeight, capped } = computeTarget(width, height, scale);

  return withSlot(async () => {
    const providerScale = scale === 1 ? 2 : scale; // 1x = enhance-only: upscale through the model, then back down
    const { out, provider, ms } = await runWithProvider('enhance', (p) =>
      p.enhance({ image: buffer, width, height, scale: providerScale, targetWidth, targetHeight, options: { denoise }, userKeys }),
      userKeys
    );
    let result = await img.resizeExact(out, targetWidth, targetHeight);
    if (autoLight) result = await img.autoTone(result, { light: true, clarity: true });
    return storage.save(result, {
      width: targetWidth,
      height: targetHeight,
      kind: 'enhance',
      scale,
      capped,
      parentId: sourceId,
      originalName: meta.originalName,
      provider: provider.name,
      providerLabel: provider.label,
      isAI: provider.isAI,
      processingMs: ms,
    });
  });
}

module.exports = { inpaint, enhance, computeTarget };
