'use strict';
const config = require('./config');
const storage = require('./services/storage');
const providers = require('./providers');
const { createApp } = require('./app');

storage.ensureDir();
storage.startCleanup();
providers.registry.local.warmup().catch((e) => console.error('[local] OpenCV failed to load', e));

const app = createApp();
const server = app.listen(config.port, () => {
  const s = providers.status();
  console.log(`PixelPure running on http://localhost:${config.port}`);
  console.log(`  inpaint provider: ${s.inpaint.label || s.inpaint.error}`);
  console.log(`  enhance provider: ${s.enhance.label || s.enhance.error}`);
  if (!s.inpaint.isAI || !s.enhance.isAI) {
    console.log('  ! No AI API key found — using the local non-AI engine. Add keys to .env for AI results.');
  }
});
server.requestTimeout = 300_000;

const shutdown = () => {
  storage.stopCleanup();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
