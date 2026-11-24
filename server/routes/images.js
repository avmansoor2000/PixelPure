'use strict';
const express = require('express');
const multer = require('multer');
const rateLimit = require('express-rate-limit');
const config = require('../config');
const storage = require('../services/storage');
const img = require('../services/imageUtils');
const processor = require('../services/processor');
const providers = require('../providers');
const { AppError } = require('../utils/errors');

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.upload.maxFileMB * 1024 * 1024, files: config.upload.maxFilesPerRequest, fields: 10 },
  fileFilter: (req, file, cb) => {
    if (file.fieldname === 'mask') return cb(null, true);
    if (!config.upload.allowedMime.includes(file.mimetype)) {
      return cb(new AppError(415, 'UNSUPPORTED_FORMAT', `"${file.originalname}" is not a JPG, PNG or WebP image.`));
    }
    cb(null, true);
  },
});

const limiter = (max, message) =>
  rateLimit({
    windowMs: 60_000,
    limit: max,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: (req, res) => res.status(429).json({ error: { code: 'RATE_LIMITED', message } }),
  });

const uploadLimiter = limiter(config.rateLimit.uploadsPerMinute, 'Too many uploads. Please wait a minute and try again.');
const processLimiter = limiter(config.rateLimit.processPerMinute, 'Too many processing requests. Please wait a minute and try again.');

const publicRecord = (r) => ({
  id: r.id,
  width: r.width,
  height: r.height,
  kind: r.kind,
  parentId: r.parentId || null,
  originalName: r.originalName,
  provider: r.provider || null,
  providerLabel: r.providerLabel || null,
  isAI: r.isAI ?? null,
  scale: r.scale || null,
  capped: r.capped || false,
  processingMs: r.processingMs || null,
  url: `/api/images/${r.id}`,
  thumbUrl: `/api/images/${r.id}/thumb`,
  expiresAt: r.createdAt + config.storage.ttlMinutes * 60_000,
});

const safeName = (name) =>
  String(name || 'image')
    .replace(/\.[^.]+$/, '')
    .replace(/[^\w\- ]+/g, '')
    .trim()
    .slice(0, 60) || 'image';

// ---------- config for the frontend ----------
router.get('/config', (req, res) => {
  res.json({
    maxFileMB: config.upload.maxFileMB,
    maxMegapixels: config.upload.maxPixels / 1e6,
    maxFilesPerRequest: config.upload.maxFilesPerRequest,
    formats: ['JPG', 'JPEG', 'PNG', 'WebP'],
    accept: config.upload.allowedMime.filter((m) => m !== 'image/jpg').join(','),
    outputMaxSide: config.output.maxSide,
    retentionMinutes: config.storage.ttlMinutes,
    providers: providers.status(),
  });
});

// ---------- upload one or more images ----------
router.post('/images', uploadLimiter, upload.array('images', config.upload.maxFilesPerRequest), async (req, res, next) => {
  try {
    if (!req.files || req.files.length === 0) throw new AppError(400, 'NO_FILE', 'Please choose an image to upload.');
    const results = [];
    for (const file of req.files) {
      try {
        const norm = await img.normalizeUpload(file.buffer);
        const rec = await storage.save(norm.buffer, {
          width: norm.width,
          height: norm.height,
          kind: 'original',
          originalName: safeName(file.originalname),
          sourceFormat: norm.sourceFormat,
        });
        results.push({ ok: true, image: publicRecord(rec) });
      } catch (e) {
        results.push({ ok: false, name: file.originalname, error: { code: e.code || 'INVALID_IMAGE', message: e.message } });
      }
    }
    const anyOk = results.some((r) => r.ok);
    res.status(anyOk ? 201 : 422).json({ results });
  } catch (e) {
    next(e);
  }
});

// ---------- remove watermark / object ----------
router.post('/images/:id/inpaint', processLimiter, upload.single('mask'), async (req, res, next) => {
  try {
    if (!storage.isValidId(req.params.id)) throw new AppError(404, 'NOT_FOUND', 'Image not found.');
    if (!req.file) throw new AppError(400, 'NO_MASK', 'Paint over the area you want to remove first.');
    const userKeys = {
      stability: req.headers['x-stability-key'],
      clipdrop: req.headers['x-clipdrop-key'],
      replicate: req.headers['x-replicate-token'],
      provider: req.headers['x-provider'],
    };
    const rec = await processor.inpaint(req.params.id, req.file.buffer, { userKeys });
    res.status(201).json({ image: publicRecord(rec) });
  } catch (e) {
    next(e);
  }
});

// ---------- detect Gemini visible watermark ----------
router.get('/images/:id/detect-gemini', processLimiter, async (req, res, next) => {
  try {
    if (!storage.isValidId(req.params.id)) throw new AppError(404, 'NOT_FOUND', 'Image not found.');
    const result = await processor.detectGemini(req.params.id);
    res.json(result);
  } catch (e) {
    next(e);
  }
});

// ---------- remove Gemini visible watermark ----------
router.post('/images/:id/remove-gemini', processLimiter, express.json({ limit: '2kb' }), async (req, res, next) => {
  try {
    if (!storage.isValidId(req.params.id)) throw new AppError(404, 'NOT_FOUND', 'Image not found.');
    const detection = req.body && req.body.bbox ? req.body : null;
    const rec = await processor.removeGemini(req.params.id, detection);
    res.status(201).json({ image: publicRecord(rec) });
  } catch (e) {
    next(e);
  }
});

// ---------- enhance / upscale ----------
router.post('/images/:id/enhance', processLimiter, express.json({ limit: '2kb' }), async (req, res, next) => {
  try {
    if (!storage.isValidId(req.params.id)) throw new AppError(404, 'NOT_FOUND', 'Image not found.');
    const body = req.body || {};
    const scale = Number(body.scale ?? 2);
    const userKeys = {
      stability: req.headers['x-stability-key'],
      clipdrop: req.headers['x-clipdrop-key'],
      replicate: req.headers['x-replicate-token'],
      provider: req.headers['x-provider'],
    };
    const rec = await processor.enhance(req.params.id, {
      scale,
      denoise: body.denoise !== false,
      autoLight: body.autoLight !== false,
      userKeys,
    });
    res.status(201).json({ image: publicRecord(rec) });
  } catch (e) {
    next(e);
  }
});

// ---------- metadata ----------
router.get('/images/:id/info', async (req, res, next) => {
  try {
    const meta = await storage.getMeta(req.params.id);
    if (!meta) throw new AppError(404, 'NOT_FOUND', 'This image has expired or does not exist.');
    res.json({ image: publicRecord(meta) });
  } catch (e) {
    next(e);
  }
});

// ---------- full-resolution preview (lossless PNG) ----------
router.get('/images/:id', async (req, res, next) => {
  try {
    const meta = await storage.getMeta(req.params.id);
    const buf = meta && (await storage.getBuffer(req.params.id));
    if (!buf) throw new AppError(404, 'NOT_FOUND', 'This image has expired or does not exist.');
    res.set({ 'Content-Type': 'image/png', 'Cache-Control': 'private, max-age=3600, immutable' });
    res.send(buf);
  } catch (e) {
    next(e);
  }
});

router.get('/images/:id/thumb', async (req, res, next) => {
  try {
    const buf = await storage.getBuffer(req.params.id);
    if (!buf || !(await storage.getMeta(req.params.id))) throw new AppError(404, 'NOT_FOUND', 'Not found.');
    res.set({ 'Content-Type': 'image/webp', 'Cache-Control': 'private, max-age=3600, immutable' });
    res.send(await img.thumbnail(buf));
  } catch (e) {
    next(e);
  }
});

// ---------- download PNG / JPG ----------
router.get('/images/:id/download', async (req, res, next) => {
  try {
    const format = String(req.query.format || 'png').toLowerCase();
    if (!['png', 'jpg', 'jpeg'].includes(format)) throw new AppError(400, 'BAD_FORMAT', 'Format must be png or jpg.');
    const quality = Math.min(100, Math.max(60, parseInt(req.query.quality, 10) || 95));
    const meta = await storage.getMeta(req.params.id);
    const buf = meta && (await storage.getBuffer(req.params.id));
    if (!buf) throw new AppError(404, 'NOT_FOUND', 'This image has expired. Please process it again.');
    const out = await img.encodeForDownload(buf, format, quality);
    const ext = format === 'png' ? 'png' : 'jpg';
    const suffix = meta.kind === 'original' ? '' : meta.kind === 'enhance' ? `-enhanced-${meta.scale}x` : '-cleaned';
    res.set({
      'Content-Type': ext === 'png' ? 'image/png' : 'image/jpeg',
      'Content-Disposition': `attachment; filename="${meta.originalName}${suffix}.${ext}"`,
      'Cache-Control': 'no-store',
    });
    res.send(out);
  } catch (e) {
    next(e);
  }
});

// ---------- delete early ----------
router.delete('/images/:id', async (req, res) => {
  await storage.remove(req.params.id);
  res.status(204).end();
});

module.exports = router;
