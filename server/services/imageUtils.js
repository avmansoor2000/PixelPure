'use strict';
const sharp = require('sharp');
const config = require('../config');
const { AppError } = require('../utils/errors');

sharp.cache(false);

const limitInputPixels = () => config.upload.maxPixels;

/**
 * Validate an uploaded buffer by decoding it (never trusting the extension or
 * client mime type) and convert it to an EXIF-oriented, metadata-free PNG.
 */
async function normalizeUpload(buffer) {
  let meta;
  try {
    meta = await sharp(buffer, { limitInputPixels: limitInputPixels() }).metadata();
  } catch (e) {
    if (/pixel limit/i.test(e.message)) {
      throw new AppError(413, 'IMAGE_TOO_LARGE', `Image exceeds the ${config.upload.maxPixels / 1e6} MP limit.`);
    }
    throw new AppError(415, 'INVALID_IMAGE', 'The file could not be read as an image.');
  }
  if (!config.upload.allowedFormats.includes(meta.format)) {
    throw new AppError(415, 'UNSUPPORTED_FORMAT', 'Only JPG, PNG and WebP images are supported.');
  }
  if (meta.pages && meta.pages > 1) {
    throw new AppError(415, 'UNSUPPORTED_FORMAT', 'Animated images are not supported.');
  }
  const png = await sharp(buffer, { limitInputPixels: limitInputPixels() })
    .rotate() // apply EXIF orientation, then metadata is dropped
    .png({ compressionLevel: 6 })
    .toBuffer({ resolveWithObject: true });

  const { width, height, channels } = png.info;
  if (width < 16 || height < 16) {
    throw new AppError(422, 'IMAGE_TOO_SMALL', 'Image must be at least 16×16 pixels.');
  }
  return { buffer: png.data, width, height, hasAlpha: channels === 4, sourceFormat: meta.format };
}

/**
 * Turn the user-painted mask into a clean binary mask at the image size.
 * White = area to remove. The mask is grown a few pixels so the AI also
 * replaces anti-aliased watermark edges.
 */
async function prepareMask(maskBuffer, width, height) {
  let img;
  try {
    img = sharp(maskBuffer, { limitInputPixels: limitInputPixels() });
    await img.metadata();
  } catch {
    throw new AppError(400, 'INVALID_MASK', 'The selection mask could not be read.');
  }
  // Use alpha if present (canvas exports transparent background + painted strokes)
  const flat = await sharp(maskBuffer)
    .resize(width, height, { fit: 'fill', kernel: 'nearest' })
    .toColourspace('srgb')
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const { data, info } = flat;
  const px = info.width * info.height;
  const bin = Buffer.alloc(px);
  let count = 0;
  for (let i = 0, j = 0; j < px; i += info.channels, j++) {
    const lum = (data[i] + data[i + 1] + data[i + 2]) / 3;
    const a = data[i + 3];
    const on = a > 32 && lum > 32;
    if (on) {
      bin[j] = 255;
      count++;
    }
  }
  if (count === 0) {
    throw new AppError(422, 'EMPTY_MASK', 'Paint over the watermark or object you want to remove first.');
  }

  const grow = Math.max(2, Math.round(Math.min(width, height) / 400));
  // Dilate: blur then threshold low. These must be separate pipelines because
  // sharp applies threshold before blur within a single pipeline.
  const blurred = await sharp(bin, { raw: { width, height, channels: 1 } }).blur(grow).extractChannel(0).raw().toBuffer();
  const grown = await sharp(blurred, { raw: { width, height, channels: 1 } }).threshold(8).toColourspace('b-w').png().toBuffer();

  return { mask: grown, coverage: count / px };
}

/**
 * Blend the provider output into the original so pixels outside the
 * selection stay bit-identical. A slightly feathered mask hides seams.
 */
async function compositeMasked(originalPng, resultBuffer, maskPng, width, height) {
  const result = await sharp(resultBuffer).resize(width, height, { fit: 'fill', kernel: 'lanczos3' }).removeAlpha().toBuffer();
  const feather = Math.max(1, Math.round(Math.min(width, height) / 800));
  const alpha = await sharp(maskPng).resize(width, height, { fit: 'fill' }).blur(feather + 0.3).toColourspace('b-w').raw().toBuffer();
  const overlay = await sharp(result).joinChannel(alpha, { raw: { width, height, channels: 1 } }).png().toBuffer();

  const orig = sharp(originalPng);
  const meta = await orig.metadata();
  let out = orig.composite([{ input: overlay, blend: 'over' }]);
  if (meta.hasAlpha) {
    // keep original transparency
    const origAlpha = await sharp(originalPng).extractChannel(3).raw().toBuffer();
    out = sharp(await out.removeAlpha().png().toBuffer()).joinChannel(origAlpha, { raw: { width, height, channels: 1 } });
  } else {
    out = sharp(await out.png().toBuffer()).removeAlpha();
  }
  return out.png({ compressionLevel: 6 }).toBuffer();
}

/** Scale an image down (never up) to satisfy a provider's limits. */
async function fitWithin(buffer, { maxPixels = Infinity, maxSide = Infinity, format = 'png' } = {}) {
  const meta = await sharp(buffer).metadata();
  let { width, height } = meta;
  let scale = 1;
  if (width * height > maxPixels) scale = Math.min(scale, Math.sqrt(maxPixels / (width * height)));
  if (Math.max(width, height) > maxSide) scale = Math.min(scale, maxSide / Math.max(width, height));
  let pipeline = sharp(buffer);
  if (scale < 1) {
    width = Math.max(1, Math.floor(width * scale));
    height = Math.max(1, Math.floor(height * scale));
    pipeline = pipeline.resize(width, height, { fit: 'fill', kernel: 'lanczos3' });
  }
  const out = format === 'jpeg' ? await pipeline.flatten({ background: '#ffffff' }).jpeg({ quality: 95 }).toBuffer() : await pipeline.png().toBuffer();
  return { buffer: out, width, height, scaled: scale < 1 };
}

async function toPng(buffer) {
  const { data, info } = await sharp(buffer).png({ compressionLevel: 6 }).toBuffer({ resolveWithObject: true });
  return { buffer: data, width: info.width, height: info.height };
}

/** Final resize to the exact requested output dimensions. */
async function resizeExact(buffer, width, height) {
  return sharp(buffer).resize(width, height, { fit: 'fill', kernel: 'lanczos3' }).png({ compressionLevel: 6 }).toBuffer();
}

/** Encode for download. JPG gets a white background if the image has transparency. */
async function encodeForDownload(pngBuffer, format, quality = 95) {
  if (format === 'jpg' || format === 'jpeg') {
    return sharp(pngBuffer).flatten({ background: '#ffffff' }).jpeg({ quality, mozjpeg: true, chromaSubsampling: '4:4:4' }).toBuffer();
  }
  return sharp(pngBuffer).png({ compressionLevel: 9, adaptiveFiltering: true }).toBuffer();
}

/** Small WebP preview for thumbnails. */
async function thumbnail(pngBuffer, size = 320) {
  return sharp(pngBuffer).resize(size, size, { fit: 'inside', withoutEnlargement: true }).webp({ quality: 80 }).toBuffer();
}

/** Optional global tone/clarity pass applied after AI upscaling when requested. */
async function autoTone(pngBuffer, { light = true, clarity = true } = {}) {
  let p = sharp(pngBuffer);
  if (light) p = p.normalise({ lower: 0.5, upper: 99.5 }).modulate({ saturation: 1.04 });
  if (clarity) p = p.clahe({ width: 64, height: 64, maxSlope: 2 });
  return p.png({ compressionLevel: 6 }).toBuffer();
}

module.exports = {
  normalizeUpload,
  prepareMask,
  compositeMasked,
  fitWithin,
  toPng,
  resizeExact,
  encodeForDownload,
  thumbnail,
  autoTone,
};
