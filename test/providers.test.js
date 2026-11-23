'use strict';
// Contract tests: the real provider modules talk to a local HTTP server that
// mimics each vendor's API, so request shape, auth and response handling are verified.
const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const multer = require('multer');
const sharp = require('sharp');
const { sampleJpeg, sampleMask, form, startApp } = require('./helpers');

const calls = [];
let mock, mockBase, ctx;
const solid = (w, h, color) => sharp({ create: { width: w, height: h, channels: 3, background: color } }).png().toBuffer();

function buildMock() {
  const app = express();
  const up = multer({ storage: multer.memoryStorage() });
  // --- Stability ---
  app.post('/v2beta/stable-image/edit/erase', up.any(), async (req, res) => {
    calls.push({ p: 'stability.erase', auth: req.headers.authorization, accept: req.headers.accept, files: req.files.map((f) => f.fieldname), body: req.body });
    if (req.headers.authorization !== 'Bearer sk-test') return res.status(401).json({ errors: ['bad key'] });
    const m = await sharp(req.files.find((f) => f.fieldname === 'image').buffer).metadata();
    res.type('image/png').send(await solid(m.width, m.height, '#00ff00'));
  });
  app.post('/v2beta/stable-image/upscale/fast', up.any(), async (req, res) => {
    calls.push({ p: 'stability.fast', files: req.files.map((f) => f.fieldname) });
    const m = await sharp(req.files[0].buffer).metadata();
    res.type('image/png').send(await solid(m.width * 4, m.height * 4, '#ff0000'));
  });
  // --- Clipdrop ---
  app.post('/cleanup/v1', up.any(), async (req, res) => {
    calls.push({ p: 'clipdrop.cleanup', key: req.headers['x-api-key'], files: req.files.map((f) => f.fieldname), body: req.body });
    const img = req.files.find((f) => f.fieldname === 'image_file');
    const mask = req.files.find((f) => f.fieldname === 'mask_file');
    const a = await sharp(img.buffer).metadata();
    const b = await sharp(mask.buffer).metadata();
    if (a.width !== b.width || a.height !== b.height) return res.status(400).json({ error: 'size mismatch' });
    res.type('image/png').send(await solid(a.width, a.height, '#00ff00'));
  });
  app.post('/image-upscaling/v1/upscale', up.any(), async (req, res) => {
    calls.push({ p: 'clipdrop.upscale', body: req.body });
    res.type('image/png').send(await solid(+req.body.target_width, +req.body.target_height, '#ff0000'));
  });
  // --- Replicate ---
  const files = new Map();
  app.get('/v1/models/:owner/:name', (req, res) => {
    calls.push({ p: 'replicate.model', model: `${req.params.owner}/${req.params.name}`, auth: req.headers.authorization });
    res.json({ latest_version: { id: `ver-${req.params.name}` } });
  });
  app.post('/v1/files', up.single('content'), (req, res) => {
    const id = String(files.size + 1);
    files.set(id, req.file.buffer);
    res.json({ id, urls: { get: `${mockBase}/v1/files/${id}` } });
  });
  app.get('/v1/files/:id', (req, res) => res.type('image/png').send(files.get(req.params.id)));
  const preds = new Map();
  app.post('/v1/predictions', express.json(), (req, res) => {
    calls.push({ p: 'replicate.predict', version: req.body.version, input: req.body.input, prefer: req.headers.prefer });
    const id = `p${preds.size + 1}`;
    preds.set(id, { polls: 0, input: req.body.input, version: req.body.version });
    res.status(201).json({ id, status: 'starting', urls: { get: `${mockBase}/v1/predictions/${id}`, cancel: `${mockBase}/v1/predictions/${id}/cancel` } });
  });
  app.get('/v1/predictions/:id', (req, res) => {
    const p = preds.get(req.params.id);
    p.polls++;
    if (p.polls < 2) return res.json({ id: req.params.id, status: 'processing', urls: { get: `${mockBase}/v1/predictions/${req.params.id}` } });
    res.json({ id: req.params.id, status: 'succeeded', output: `${mockBase}/out/${req.params.id}.png` });
  });
  app.get('/out/:id.png', async (req, res) => {
    const p = preds.get(req.params.id);
    const srcId = p.input.image.split('/').pop();
    const m = await sharp(files.get(srcId)).metadata();
    const k = p.version.includes('esrgan') ? p.input.scale : 1;
    res.type('image/png').send(await solid(m.width * k, m.height * k, k > 1 ? '#ff0000' : '#00ff00'));
  });
  return app;
}

test.before(async () => {
  mock = buildMock().listen(0);
  await new Promise((r) => mock.once('listening', r));
  mockBase = `http://127.0.0.1:${mock.address().port}`;
  ctx = await startApp({
    STABILITY_API_KEY: 'sk-test', STABILITY_API_BASE: mockBase,
    CLIPDROP_API_KEY: 'cd-test', CLIPDROP_API_BASE: mockBase,
    REPLICATE_API_TOKEN: 'r8-test', REPLICATE_API_BASE: mockBase,
  });
});
test.after(() => { ctx.server.close(); mock.close(); });

const config = () => require('../server/config');

async function uploadAndInpaint() {
  const up = await fetch(`${ctx.base}/api/images`, { method: 'POST', body: form([['images', { data: await sampleJpeg(), name: 'a.jpg', type: 'image/jpeg' }]]) });
  const id = (await up.json()).results[0].image.id;
  const res = await fetch(`${ctx.base}/api/images/${id}/inpaint`, { method: 'POST', body: form([['mask', { data: await sampleMask(), name: 'm.png', type: 'image/png' }]]) });
  return { id, res };
}
async function enhance(id, scale) {
  return fetch(`${ctx.base}/api/images/${id}/enhance`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scale, autoLight: false }) });
}
async function pixel(url, x, y) {
  const { data, info } = await sharp(Buffer.from(await (await fetch(ctx.base + url)).arrayBuffer())).raw().toBuffer({ resolveWithObject: true });
  const i = (y * info.width + x) * info.channels;
  return [data[i], data[i + 1], data[i + 2]];
}

for (const name of ['stability', 'clipdrop', 'replicate']) {
  test(`${name}: inpaint request shape + masked compositing`, async () => {
    config().providers.inpaint = name;
    config().providers.enhance = name;
    calls.length = 0;
    const { id, res } = await uploadAndInpaint();
    assert.equal(res.status, 201, await res.clone().text());
    const out = (await res.json()).image;
    assert.equal(out.provider, name);
    assert.equal(out.isAI, true);
    // inside mask = provider output (green); outside = original (blue)
    const inside = await pixel(out.url, 100, 95);
    const outside = await pixel(out.url, 300, 10);
    assert.ok(inside[1] > 200 && inside[0] < 60, `inside is provider output: ${inside}`);
    assert.ok(outside[2] > 150 && outside[1] < 150, `outside untouched: ${outside}`);

    if (name === 'stability') {
      const c = calls.find((x) => x.p === 'stability.erase');
      assert.equal(c.auth, 'Bearer sk-test');
      assert.deepEqual(c.files.sort(), ['image', 'mask']);
      assert.equal(c.body.output_format, 'png');
    }
    if (name === 'clipdrop') {
      const c = calls.find((x) => x.p === 'clipdrop.cleanup');
      assert.equal(c.key, 'cd-test');
      assert.deepEqual(c.files.sort(), ['image_file', 'mask_file']);
    }
    if (name === 'replicate') {
      const c = calls.find((x) => x.p === 'replicate.predict');
      assert.equal(c.version, 'ver-lama');
      assert.ok(c.input.image && c.input.mask);
    }

    const er = await enhance(id, 2);
    assert.equal(er.status, 201, await er.clone().text());
    const eo = (await er.json()).image;
    assert.equal(eo.width, 640);
    assert.equal(eo.height, 400);
    assert.equal(eo.provider, name);
    const p = await pixel(eo.url, 10, 10);
    assert.ok(p[0] > 200 && p[1] < 60, `enhanced pixels come from provider: ${p}`);
    if (name === 'clipdrop') assert.deepEqual(calls.find((x) => x.p === 'clipdrop.upscale').body, { target_width: '640', target_height: '400' });
    if (name === 'replicate') assert.equal(calls.filter((x) => x.p === 'replicate.predict').pop().input.scale, 2);
  });
}

test('upstream auth failure becomes a safe, friendly error', async () => {
  config().providers.inpaint = 'stability';
  const saved = config().providers.stability.apiKey;
  config().providers.stability.apiKey = 'wrong';
  const { res } = await uploadAndInpaint();
  config().providers.stability.apiKey = saved;
  assert.equal(res.status, 502);
  const body = await res.json();
  assert.equal(body.error.code, 'PROVIDER_ERROR');
  assert.match(body.error.message, /rejected the server API key/);
  assert.ok(!JSON.stringify(body).includes('wrong'));
});

test('selected provider without key reports misconfiguration', async () => {
  config().providers.inpaint = 'clipdrop';
  const saved = config().providers.clipdrop.apiKey;
  config().providers.clipdrop.apiKey = '';
  const { res } = await uploadAndInpaint();
  config().providers.clipdrop.apiKey = saved;
  assert.equal(res.status, 503);
  assert.equal((await res.json()).error.code, 'PROVIDER_NOT_CONFIGURED');
});
