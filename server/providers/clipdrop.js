'use strict';
/**
 * Clipdrop provider
 *  - Inpaint: POST /cleanup/v1                     (image_file + mask_file, same size, white = remove)
 *  - Upscale: POST /image-upscaling/v1/upscale     (target_width / target_height, max 4096)
 */
const sharp = require('sharp');
const config = require('../config');
const { request, pngBlob } = require('./http');
const { fitWithin } = require('../services/imageUtils');

const cfg = () => config.providers.clipdrop;
const MAX_INPUT_PIXELS = 16_000_000;
const UPSCALE_MAX_SIDE = 4096;

module.exports = {
  name: 'clipdrop',
  label: 'Clipdrop',
  isAI: true,
  capabilities: ['inpaint', 'enhance'],
  isConfigured: () => Boolean(cfg().apiKey),

  async inpaint({ image, mask }) {
    const img = await fitWithin(image, { maxPixels: MAX_INPUT_PIXELS });
    const m = await sharp(mask).resize(img.width, img.height, { fit: 'fill' }).png().toBuffer();
    const form = new FormData();
    form.append('image_file', pngBlob(img.buffer), 'image.png');
    form.append('mask_file', pngBlob(m), 'mask.png');
    form.append('mode', 'quality');
    const res = await request('clipdrop', `${cfg().baseUrl}/cleanup/v1`, {
      method: 'POST',
      headers: { 'x-api-key': cfg().apiKey },
      body: form,
    });
    return Buffer.from(await res.arrayBuffer());
  },

  async enhance({ image, targetWidth, targetHeight }) {
    let tw = targetWidth;
    let th = targetHeight;
    const k = Math.min(1, UPSCALE_MAX_SIDE / Math.max(tw, th));
    tw = Math.max(1, Math.floor(tw * k));
    th = Math.max(1, Math.floor(th * k));
    const img = await fitWithin(image, { maxPixels: MAX_INPUT_PIXELS });
    const form = new FormData();
    form.append('image_file', pngBlob(img.buffer), 'image.png');
    form.append('target_width', String(tw));
    form.append('target_height', String(th));
    const res = await request('clipdrop', `${cfg().baseUrl}/image-upscaling/v1/upscale`, {
      method: 'POST',
      headers: { 'x-api-key': cfg().apiKey, Accept: 'image/png' },
      body: form,
    });
    return Buffer.from(await res.arrayBuffer());
  },
};
