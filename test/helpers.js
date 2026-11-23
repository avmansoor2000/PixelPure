'use strict';
const sharp = require('sharp');
const os = require('os');
const path = require('path');
const fs = require('fs');

function tmpStorage() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pixelpure-test-'));
}

async function sampleJpeg(w = 320, h = 200) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="100%" height="100%" fill="#4477cc"/><text x="40" y="110" font-size="40" font-family="DejaVu Sans" fill="#fff">MARK</text></svg>`;
  return sharp(Buffer.from(svg)).jpeg().toBuffer();
}

/** Mask like the browser sends: transparent background with purple strokes. */
async function sampleMask(w = 320, h = 200, rect = { x: 30, y: 70, w: 140, h: 55 }) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect x="${rect.x}" y="${rect.y}" width="${rect.w}" height="${rect.h}" fill="#8b5cf6"/></svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

async function emptyMask(w = 320, h = 200) {
  return sharp({ create: { width: w, height: h, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer();
}

function form(fields) {
  const fd = new FormData();
  for (const [k, v] of fields) {
    if (Buffer.isBuffer(v.data)) fd.append(k, new Blob([v.data], { type: v.type }), v.name);
    else fd.append(k, v);
  }
  return fd;
}

async function startApp(env = {}) {
  Object.assign(process.env, { STORAGE_DIR: tmpStorage(), RATE_LIMIT_PROCESS_PER_MIN: '1000', RATE_LIMIT_UPLOADS_PER_MIN: '1000', ...env });
  const { createApp } = require('../server/app');
  require('../server/services/storage').ensureDir();
  const server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

module.exports = { sampleJpeg, sampleMask, emptyMask, form, startApp, tmpStorage };
