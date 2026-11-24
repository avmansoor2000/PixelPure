'use strict';
/**
 * Stability AI provider
 *  - Inpaint:  POST /v2beta/stable-image/edit/erase       (image + mask, white = erase)
 *  - Upscale:  POST /v2beta/stable-image/upscale/fast     (4x, input ≤ ~1 MP)
 *              POST /v2beta/stable-image/upscale/conservative (larger inputs, up to 4K output)
 */
const sharp = require('sharp');
const config = require('../config');
const { request, pngBlob } = require('./http');
const { fitWithin } = require('../services/imageUtils');

const cfg = () => config.providers.stability;

const ERASE_MAX_PIXELS = 9_437_184;
const FAST_MAX_PIXELS = 1_048_576;
const FAST_MAX_SIDE = 1536;
const CONSERVATIVE_MAX_PIXELS = 9_437_184;

function headers(userKey) {
  const key = userKey || cfg().apiKey;
  return { Authorization: `Bearer ${key}`, Accept: 'image/*' };
}

module.exports = {
  name: 'stability',
  label: 'Stability AI',
  isAI: true,
  capabilities: ['inpaint', 'enhance'],
  isConfigured: () => Boolean(cfg().apiKey),

  async inpaint({ image, mask, userKeys = {} }) {
    const key = userKeys.stability || cfg().apiKey;
    const img = await fitWithin(image, { maxPixels: ERASE_MAX_PIXELS });
    const m = await sharp(mask).resize(img.width, img.height, { fit: 'fill' }).png().toBuffer();
    const form = new FormData();
    form.append('image', pngBlob(img.buffer), 'image.png');
    form.append('mask', pngBlob(m), 'mask.png');
    form.append('grow_mask', '6');
    form.append('output_format', 'png');
    const res = await request('stability', `${cfg().baseUrl}/v2beta/stable-image/edit/erase`, {
      method: 'POST',
      headers: headers(key),
      body: form,
    });
    return Buffer.from(await res.arrayBuffer());
  },

  /** Returns an upscaled image; caller resizes to the exact target. */
  async enhance({ image, width, height, userKeys = {} }) {
    const key = userKeys.stability || cfg().apiKey;
    const pixels = width * height;
    if (pixels <= FAST_MAX_PIXELS && Math.max(width, height) <= FAST_MAX_SIDE && Math.min(width, height) >= 32) {
      const form = new FormData();
      form.append('image', pngBlob(image), 'image.png');
      form.append('output_format', 'png');
      const res = await request('stability', `${cfg().baseUrl}/v2beta/stable-image/upscale/fast`, {
        method: 'POST',
        headers: headers(key),
        body: form,
      });
      return Buffer.from(await res.arrayBuffer());
    }
    // Larger inputs: conservative upscaler (minimal alteration, outputs up to 4K)
    const img = await fitWithin(image, { maxPixels: CONSERVATIVE_MAX_PIXELS });
    const form = new FormData();
    form.append('image', pngBlob(img.buffer), 'image.png');
    form.append('prompt', 'high quality, sharp focus, fine natural detail, clean, true to the original photo');
    form.append('creativity', '0.2');
    form.append('output_format', 'png');
    const res = await request('stability', `${cfg().baseUrl}/v2beta/stable-image/upscale/conservative`, {
      method: 'POST',
      headers: headers(key),
      body: form,
    });
    return Buffer.from(await res.arrayBuffer());
  },
};
