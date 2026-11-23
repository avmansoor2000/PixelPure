'use strict';
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const int = (v, d) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : d;
};

const config = {
  env: process.env.NODE_ENV || 'development',
  port: int(process.env.PORT, 3000),
  publicUrl: (process.env.PUBLIC_URL || '').replace(/\/$/, ''),
  trustProxy: process.env.TRUST_PROXY === 'true',

  upload: {
    maxFileMB: int(process.env.MAX_FILE_MB, 15),
    maxPixels: int(process.env.MAX_INPUT_MEGAPIXELS, 40) * 1_000_000,
    maxFilesPerRequest: int(process.env.MAX_FILES_PER_REQUEST, 10),
    allowedFormats: ['jpeg', 'png', 'webp'],
    allowedMime: ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'],
  },

  output: {
    // Longest side allowed for an enhanced/upscaled result.
    maxSide: int(process.env.OUTPUT_MAX_SIDE, 8192),
  },

  storage: {
    dir: path.resolve(process.env.STORAGE_DIR || path.join(__dirname, '..', 'storage')),
    ttlMinutes: int(process.env.FILE_TTL_MINUTES, 60),
    sweepMinutes: int(process.env.CLEANUP_INTERVAL_MINUTES, 5),
  },

  rateLimit: {
    uploadsPerMinute: int(process.env.RATE_LIMIT_UPLOADS_PER_MIN, 30),
    processPerMinute: int(process.env.RATE_LIMIT_PROCESS_PER_MIN, 12),
  },

  providers: {
    // 'auto' picks the first configured AI provider, then falls back to 'local'
    inpaint: (process.env.INPAINT_PROVIDER || 'auto').toLowerCase(),
    enhance: (process.env.ENHANCE_PROVIDER || 'auto').toLowerCase(),
    allowLocalFallback: process.env.ALLOW_LOCAL_FALLBACK !== 'false',
    timeoutMs: int(process.env.PROVIDER_TIMEOUT_MS, 120_000),

    stability: {
      apiKey: process.env.STABILITY_API_KEY || '',
      baseUrl: (process.env.STABILITY_API_BASE || 'https://api.stability.ai').replace(/\/$/, ''),
    },
    clipdrop: {
      apiKey: process.env.CLIPDROP_API_KEY || '',
      baseUrl: (process.env.CLIPDROP_API_BASE || 'https://clipdrop-api.co').replace(/\/$/, ''),
    },
    replicate: {
      apiToken: process.env.REPLICATE_API_TOKEN || '',
      baseUrl: (process.env.REPLICATE_API_BASE || 'https://api.replicate.com').replace(/\/$/, ''),
      inpaintModel: process.env.REPLICATE_INPAINT_MODEL || 'allenhooo/lama',
      inpaintVersion: process.env.REPLICATE_INPAINT_VERSION || '',
      upscaleModel: process.env.REPLICATE_UPSCALE_MODEL || 'nightmareai/real-esrgan',
      upscaleVersion: process.env.REPLICATE_UPSCALE_VERSION || '',
    },
  },
};

module.exports = config;
