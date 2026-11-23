'use strict';
const test = require('node:test');
const assert = require('node:assert');
const sharp = require('sharp');
const { sampleJpeg, sampleMask, emptyMask, form, startApp } = require('./helpers');

let ctx;
test.before(async () => {
  ctx = await startApp({ INPAINT_PROVIDER: 'auto', ENHANCE_PROVIDER: 'auto', STABILITY_API_KEY: '', CLIPDROP_API_KEY: '', REPLICATE_API_TOKEN: '', MAX_FILE_MB: '2' });
});
test.after(() => ctx.server.close());

async function upload(buf, name = 'photo.jpg', type = 'image/jpeg') {
  const res = await fetch(`${ctx.base}/api/images`, { method: 'POST', body: form([['images', { data: buf, name, type }]]) });
  return { status: res.status, body: await res.json() };
}

test('config exposes limits and provider status without secrets', async () => {
  const res = await fetch(`${ctx.base}/api/config`);
  const json = await res.json();
  assert.equal(res.status, 200);
  assert.equal(json.maxFileMB, 2);
  assert.equal(json.providers.inpaint.name, 'local');
  assert.ok(!JSON.stringify(json).match(/key|token/i), 'no secret-looking fields');
});

test('upload validates, normalises and strips metadata', async () => {
  const jpg = await sharp(await sampleJpeg()).withMetadata({ exif: { IFD0: { Copyright: 'secret' } } }).jpeg().toBuffer();
  const { status, body } = await upload(jpg);
  assert.equal(status, 201);
  const img = body.results[0].image;
  assert.equal(img.width, 320);
  assert.equal(img.height, 200);
  const png = Buffer.from(await (await fetch(ctx.base + img.url)).arrayBuffer());
  const meta = await sharp(png).metadata();
  assert.equal(meta.format, 'png');
  assert.equal(meta.exif, undefined);
});

test('rejects non-image content even with an image mime type', async () => {
  const { status, body } = await upload(Buffer.from('not an image at all'), 'fake.jpg', 'image/jpeg');
  assert.equal(status, 422);
  assert.equal(body.results[0].ok, false);
});

test('rejects unsupported mime type', async () => {
  const { status, body } = await upload(Buffer.from('GIF89a'), 'a.gif', 'image/gif');
  assert.equal(status, 415);
  assert.equal(body.error.code, 'UNSUPPORTED_FORMAT');
});

test('rejects files over the size limit', async () => {
  const { status, body } = await upload(Buffer.alloc(3 * 1024 * 1024, 1), 'big.jpg');
  assert.equal(status, 413);
  assert.match(body.error.message, /2 MB/);
});

test('inpaint changes only the masked region', async () => {
  const { body } = await upload(await sampleJpeg());
  const src = body.results[0].image;
  const res = await fetch(`${ctx.base}/api/images/${src.id}/inpaint`, { method: 'POST', body: form([['mask', { data: await sampleMask(), name: 'mask.png', type: 'image/png' }]]) });
  assert.equal(res.status, 201);
  const out = (await res.json()).image;
  assert.equal(out.kind, 'inpaint');
  assert.equal(out.parentId, src.id);
  assert.equal(out.isAI, false);
  const a = await sharp(Buffer.from(await (await fetch(ctx.base + src.url)).arrayBuffer())).raw().toBuffer();
  const b = await sharp(Buffer.from(await (await fetch(ctx.base + out.url)).arrayBuffer())).raw().toBuffer();
  const px = (buf, x, y) => [...buf.subarray((y * 320 + x) * 3, (y * 320 + x) * 3 + 3)];
  assert.deepEqual(px(a, 300, 10), px(b, 300, 10), 'pixels far from the mask are unchanged');
  // inside the mask the white text should be gone (pixel close to the blue background)
  let whiteBefore = 0, whiteAfter = 0;
  for (let y = 75; y < 120; y++) for (let x = 40; x < 160; x++) {
    if (px(a, x, y)[0] > 200) whiteBefore++;
    if (px(b, x, y)[0] > 200) whiteAfter++;
  }
  assert.ok(whiteBefore > 100, 'fixture has text');
  assert.equal(whiteAfter, 0, 'text removed');
});

test('inpaint with empty mask returns a helpful error', async () => {
  const { body } = await upload(await sampleJpeg());
  const id = body.results[0].image.id;
  const res = await fetch(`${ctx.base}/api/images/${id}/inpaint`, { method: 'POST', body: form([['mask', { data: await emptyMask(), name: 'mask.png', type: 'image/png' }]]) });
  assert.equal(res.status, 422);
  assert.equal((await res.json()).error.code, 'EMPTY_MASK');
});

test('enhance 2x and 4x produce correct dimensions', async () => {
  const { body } = await upload(await sampleJpeg());
  const id = body.results[0].image.id;
  for (const scale of [2, 4]) {
    const res = await fetch(`${ctx.base}/api/images/${id}/enhance`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scale }) });
    assert.equal(res.status, 201);
    const out = (await res.json()).image;
    assert.equal(out.width, 320 * scale);
    assert.equal(out.height, 200 * scale);
    const meta = await sharp(Buffer.from(await (await fetch(ctx.base + out.url)).arrayBuffer())).metadata();
    assert.equal(meta.width, 320 * scale);
  }
});

test('enhance rejects invalid scale', async () => {
  const { body } = await upload(await sampleJpeg());
  const res = await fetch(`${ctx.base}/api/images/${body.results[0].image.id}/enhance`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scale: 3 }) });
  assert.equal(res.status, 400);
});

test('download returns PNG and JPG with filenames', async () => {
  const { body } = await upload(await sampleJpeg(), 'My Photo.jpg');
  const id = body.results[0].image.id;
  const png = await fetch(`${ctx.base}/api/images/${id}/download?format=png`);
  assert.equal(png.headers.get('content-type'), 'image/png');
  assert.match(png.headers.get('content-disposition'), /My Photo\.png/);
  const jpg = await fetch(`${ctx.base}/api/images/${id}/download?format=jpg&quality=90`);
  assert.equal(jpg.headers.get('content-type'), 'image/jpeg');
  assert.equal((await sharp(Buffer.from(await jpg.arrayBuffer())).metadata()).format, 'jpeg');
});

test('invalid ids and path traversal are rejected', async () => {
  for (const id of ['..%2F..%2Fpackage', 'abc', '0'.repeat(31) + 'g']) {
    const res = await fetch(`${ctx.base}/api/images/${id}`);
    assert.equal(res.status, 404);
  }
});

test('expired files are swept', async () => {
  const storage = require('../server/services/storage');
  const fs = require('fs');
  const path = require('path');
  const { body } = await upload(await sampleJpeg());
  const id = body.results[0].image.id;
  const old = new Date(Date.now() - 2 * 3600_000);
  for (const ext of ['png', 'json']) fs.utimesSync(path.join(process.env.STORAGE_DIR, `${id}.${ext}`), old, old);
  const removed = await storage.sweep();
  assert.ok(removed >= 2);
  assert.equal((await fetch(`${ctx.base}/api/images/${id}`)).status, 404);
});

test('security headers and SEO endpoints', async () => {
  const res = await fetch(`${ctx.base}/`);
  assert.match(res.headers.get('content-security-policy'), /script-src 'self'/);
  const html = await res.text();
  assert.match(html, /<meta name="description"/);
  assert.match(html, /og:image/);
  assert.match(await (await fetch(`${ctx.base}/sitemap.xml`)).text(), /<urlset/);
  assert.match(await (await fetch(`${ctx.base}/robots.txt`)).text(), /Disallow: \/api\//);
  assert.equal((await fetch(`${ctx.base}/nope`)).status, 404);
});
