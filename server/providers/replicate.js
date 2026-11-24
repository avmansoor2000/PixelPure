'use strict';
/**
 * Replicate provider (open-source models)
 *  - Inpaint: LaMa             (default: allenhooo/lama, input { image, mask })
 *  - Upscale: Real-ESRGAN      (default: nightmareai/real-esrgan, input { image, scale, face_enhance })
 * Model + version are configurable; if no version is pinned the latest is resolved once.
 */
const config = require('../config');
const { request, pngBlob } = require('./http');
const { ProviderError } = require('../utils/errors');
const { fitWithin } = require('../services/imageUtils');

const cfg = () => config.providers.replicate;
const versionCache = new Map();
const INPAINT_MAX_PIXELS = 4_200_000;
const UPSCALE_MAX_PIXELS = 2_000_000; // Real-ESRGAN GPU memory guard

const authHeaders = (extra = {}, userToken) => {
  const token = userToken || cfg().apiToken;
  return { Authorization: `Bearer ${token}`, ...extra };
};

async function resolveVersion(model, pinned, userToken) {
  if (pinned) return pinned;
  if (versionCache.has(model)) return versionCache.get(model);
  const [owner, name] = model.split('/');
  const res = await request('replicate', `${cfg().baseUrl}/v1/models/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`, {
    headers: authHeaders({}, userToken),
  });
  const json = await res.json();
  const id = json.latest_version && json.latest_version.id;
  if (!id) throw new ProviderError('replicate', `Model ${model} has no published version.`);
  versionCache.set(model, id);
  return id;
}

async function uploadFile(buffer, filename, userToken) {
  const form = new FormData();
  form.append('content', pngBlob(buffer), filename);
  const res = await request('replicate', `${cfg().baseUrl}/v1/files`, { method: 'POST', headers: authHeaders({}, userToken), body: form });
  const json = await res.json();
  if (!json.urls || !json.urls.get) throw new ProviderError('replicate', 'File upload to Replicate failed.');
  return json.urls.get;
}

async function runPrediction(model, pinnedVersion, input, userToken) {
  const version = await resolveVersion(model, pinnedVersion, userToken);
  const res = await request('replicate', `${cfg().baseUrl}/v1/predictions`, {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json', Prefer: 'wait=55' }, userToken),
    body: JSON.stringify({ version, input }),
  });
  let pred = await res.json();
  const deadline = Date.now() + config.providers.timeoutMs;
  while (['starting', 'processing'].includes(pred.status)) {
    if (Date.now() > deadline) {
      if (pred.urls && pred.urls.cancel) request('replicate', pred.urls.cancel, { method: 'POST', headers: authHeaders({}, userToken) }).catch(() => {});
      throw new ProviderError('replicate', 'The AI service took too long to respond. Please try again.', 504);
    }
    await new Promise((r) => setTimeout(r, 1500));
    const poll = await request('replicate', pred.urls.get, { headers: authHeaders({}, userToken) });
    pred = await poll.json();
  }
  if (pred.status !== 'succeeded') {
    throw new ProviderError('replicate', 'The AI model failed to process this image.', 502, {
      upstreamMessage: String(pred.error || pred.status).slice(0, 500),
    });
  }
  const out = Array.isArray(pred.output) ? pred.output[pred.output.length - 1] : pred.output;
  if (typeof out !== 'string') throw new ProviderError('replicate', 'The AI model returned no image.');
  const needsAuth = out.startsWith(cfg().baseUrl);
  const file = await request('replicate', out, { headers: needsAuth ? authHeaders({}, userToken) : {} });
  return Buffer.from(await file.arrayBuffer());
}

module.exports = {
  name: 'replicate',
  label: 'Replicate',
  isAI: true,
  capabilities: ['inpaint', 'enhance'],
  isConfigured: () => Boolean(cfg().apiToken),

  async inpaint({ image, mask, userKeys = {} }) {
    const token = userKeys.replicate || cfg().apiToken;
    const img = await fitWithin(image, { maxPixels: INPAINT_MAX_PIXELS });
    const m = await fitWithin(mask, { maxPixels: INPAINT_MAX_PIXELS });
    const [imageUrl, maskUrl] = await Promise.all([uploadFile(img.buffer, 'image.png', token), uploadFile(m.buffer, 'mask.png', token)]);
    return runPrediction(cfg().inpaintModel, cfg().inpaintVersion, { image: imageUrl, mask: maskUrl }, token);
  },

  async enhance({ image, scale, userKeys = {} }) {
    const token = userKeys.replicate || cfg().apiToken;
    const img = await fitWithin(image, { maxPixels: UPSCALE_MAX_PIXELS });
    const imageUrl = await uploadFile(img.buffer, 'image.png', token);
    return runPrediction(cfg().upscaleModel, cfg().upscaleVersion, {
      image: imageUrl,
      scale: img.scaled ? 4 : scale,
      face_enhance: false,
    }, token);
  },
};
