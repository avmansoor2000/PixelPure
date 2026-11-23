'use strict';
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const compression = require('compression');
const multer = require('multer');
const config = require('./config');
const imagesRouter = require('./routes/images');
const { AppError } = require('./utils/errors');

function createApp() {
  const app = express();
  app.disable('x-powered-by');
  if (config.trustProxy) app.set('trust proxy', 1);

  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: true,
        directives: {
          'default-src': ["'self'"],
          'script-src': ["'self'"],
          'style-src': ["'self'"],
          'img-src': ["'self'", 'data:', 'blob:'],
          'font-src': ["'self'"],
          'connect-src': ["'self'"],
          'object-src': ["'none'"],
          'frame-ancestors': ["'none'"],
        },
      },
      crossOriginEmbedderPolicy: false,
    })
  );
  app.use(compression({ filter: (req, res) => !/^image\//.test(res.getHeader('Content-Type') || '') && compression.filter(req, res) }));

  app.get('/healthz', (req, res) => res.json({ ok: true }));

  // SEO: robots + sitemap built from PUBLIC_URL (or the request host)
  const origin = (req) => config.publicUrl || `${req.protocol}://${req.get('host')}`;
  app.get('/robots.txt', (req, res) => {
    res.type('text/plain').send(`User-agent: *\nAllow: /\nDisallow: /api/\nSitemap: ${origin(req)}/sitemap.xml\n`);
  });
  app.get('/sitemap.xml', (req, res) => {
    const base = origin(req);
    const urls = ['/', '/about', '/privacy', '/terms', '/contact']
      .map((p) => `  <url><loc>${base}${p}</loc>${p === '/' ? '<priority>1.0</priority>' : ''}</url>`)
      .join('\n');
    res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`);
  });
  app.use('/api', imagesRouter);
  app.use('/api', (req, res) => res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Endpoint not found.' } }));

  const pub = path.join(__dirname, '..', 'public');
  app.use(
    express.static(pub, {
      extensions: ['html'],
      setHeaders: (res, file) => {
        if (/\.(css|js|woff2|webp|jpg|png|svg)$/.test(file)) res.setHeader('Cache-Control', 'public, max-age=86400');
      },
    })
  );
  app.use((req, res) => res.status(404).sendFile(path.join(pub, '404.html')));

  // Central error handler — never leaks stack traces or upstream secrets.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    let status = 500;
    let code = 'INTERNAL_ERROR';
    let message = 'Something went wrong while processing your image. Please try again.';
    if (err instanceof AppError) {
      status = err.status;
      code = err.code;
      message = err.message;
    } else if (err instanceof multer.MulterError) {
      status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
      code = err.code;
      message =
        err.code === 'LIMIT_FILE_SIZE'
          ? `File is too large. Maximum size is ${config.upload.maxFileMB} MB.`
          : err.code === 'LIMIT_FILE_COUNT'
            ? `You can upload up to ${config.upload.maxFilesPerRequest} images at once.`
            : 'Upload failed. Please try again.';
    } else if (err.type === 'entity.parse.failed') {
      status = 400;
      code = 'BAD_JSON';
      message = 'Invalid request body.';
    }
    if (status >= 500) console.error('[error]', err);
    res.status(status).json({ error: { code, message } });
  });

  return app;
}

module.exports = { createApp };
