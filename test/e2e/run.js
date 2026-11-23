'use strict';
// End-to-end UI test on desktop + mobile viewports using a real Chrome.
// CHROME_PATH=/path/to/chrome npm run test:e2e
const path = require('path');
const fs = require('fs');
const os = require('os');
const { chromium } = require('playwright-core');
const assert = require('assert');

const ROOT = path.join(__dirname, '..', '..');
const SHOTS = path.join(__dirname, 'screenshots');
fs.mkdirSync(SHOTS, { recursive: true });
const SAMPLE = path.join(ROOT, 'public/images/samples/hero-before.jpg');
const SAMPLE2 = path.join(ROOT, 'public/images/samples/g2-before.jpg');

async function startServer() {
  process.env.STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-e2e-'));
  process.env.RATE_LIMIT_PROCESS_PER_MIN = '1000';
  const { createApp } = require(path.join(ROOT, 'server/app'));
  require(path.join(ROOT, 'server/services/storage')).ensureDir();
  const server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

/** Paint a horizontal stroke over natural-pixel coordinates of the image being edited. */
async function paint(page, from, to) {
  const box = await page.locator('#canvas-wrap').boundingBox();
  const nat = await page.evaluate(() => [document.getElementById('base-img').naturalWidth, document.getElementById('base-img').naturalHeight]);
  const map = ([x, y]) => [box.x + (x / nat[0]) * box.width, box.y + (y / nat[1]) * box.height];
  const [x1, y1] = map(from);
  const [x2, y2] = map(to);
  await page.mouse.move(x1, y1);
  await page.mouse.down();
  for (let i = 1; i <= 12; i++) await page.mouse.move(x1 + ((x2 - x1) * i) / 12, y1 + ((y2 - y1) * i) / 12);
  await page.mouse.up();
}

async function run(browser, base, name, contextOpts) {
  const ctx = await browser.newContext({ ...contextOpts, acceptDownloads: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  const mobile = contextOpts.viewport.width <= 960; // editor panel becomes a bottom sheet

  await page.goto(base, { waitUntil: 'networkidle' });
  await page.evaluate(() => document.querySelectorAll('.reveal').forEach((e) => e.classList.add('in')));
  // scroll through so lazy sliders load
  for (const id of ['#how', '#features', '#gallery', '#pricing', '#faq']) await page.locator(id).scrollIntoViewIfNeeded();
  await page.waitForTimeout(600);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(SHOTS, `${name}-landing.png`), fullPage: true });
  await page.screenshot({ path: path.join(SHOTS, `${name}-hero.png`) });

  // hero compare slider drags
  const cmp = page.locator('.hero-preview .cmp');
  await cmp.scrollIntoViewIfNeeded();
  const cb = await cmp.boundingBox();
  await page.mouse.move(cb.x + cb.width * 0.5, cb.y + cb.height / 2);
  await page.mouse.down();
  await page.mouse.move(cb.x + cb.width * 0.25, cb.y + cb.height / 2, { steps: 5 });
  await page.mouse.up();
  const left = await page.locator('.hero-preview .cmp-handle').evaluate((e) => e.style.left);
  assert.ok(parseFloat(left) < 35, `slider moved (${left})`);

  // mobile menu
  if (mobile) {
    await page.click('.nav-toggle');
    assert.ok(await page.locator('#mobile-menu').isVisible());
    await page.click('.nav-toggle');
  }

  // client-side validation: wrong type
  await page.setInputFiles('#file-input', { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') });
  await page.locator('.toast.error').first().waitFor();

  // upload two images
  await page.setInputFiles('#file-input', [SAMPLE, SAMPLE2]);
  await page.locator('#editor').waitFor({ state: 'visible' });
  await page.locator('.tray-item').nth(1).waitFor();
  assert.equal(await page.locator('.tray-item').count(), 2);
  // switch to the rocket (first) image
  await page.locator('.tray-item button').first().click();
  await page.waitForFunction(() => document.getElementById('ed-dims').textContent.startsWith('640'));
  await page.waitForTimeout(300);
  assert.ok(await page.locator('#btn-inpaint').isDisabled(), 'remove disabled before painting');

  // paint over both watermark texts
  await paint(page, [62, 92], [245, 92]);
  await paint(page, [360, 55], [560, 55]);
  assert.ok(await page.locator('#btn-inpaint').isEnabled(), 'remove enabled after painting');
  // undo / redo
  await page.click('[data-ed="undo"]');
  await page.click('[data-ed="undo"]');
  assert.ok(await page.locator('#btn-inpaint').isDisabled(), 'undo cleared mask');
  await page.click('[data-ed="redo"]');
  await page.click('[data-ed="redo"]');
  assert.ok(await page.locator('#btn-inpaint').isEnabled());
  // eraser exists and zoom works
  await page.click('[data-tool="eraser"]');
  await page.click('[data-tool="brush"]');
  await page.click('[data-ed="zoom-in"]');
  assert.notEqual(await page.locator('#zoom-label').textContent(), 'Fit');
  await page.click('[data-ed="zoom-fit"]');
  await page.screenshot({ path: path.join(SHOTS, `${name}-editor-mask.png`) });

  // remove watermark
  await page.locator(mobile ? '.ed-mobile-actions [data-ed="inpaint"]' : '#btn-inpaint').click();
  await page.locator('#compare-stage').waitFor({ state: 'visible', timeout: 60000 });
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(SHOTS, `${name}-compare.png`) });
  assert.match(await page.locator('#compare-against').inputValue(), /0/);
  // compare zoom + reset
  await page.click('[data-cmp="zoom-in"]');
  assert.equal(await page.locator('#cmp-zoom-label').textContent(), '150%');
  await page.click('[data-cmp="reset"]');
  assert.equal(await page.locator('#cmp-zoom-label').textContent(), '100%');

  // enhance 2x
  if (mobile) {
    await page.click('[data-ed="sheet"]');
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(SHOTS, `${name}-sheet.png`) });
  }
  await page.click('[data-scale="2"]');
  await page.click('#btn-enhance');
  await page.waitForFunction(() => document.getElementById('ed-dims').textContent.startsWith('1280'), null, { timeout: 60000 });
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(SHOTS, `${name}-enhanced.png`) });

  // download JPG
  if (mobile) await page.click('[data-ed="sheet"]');
  await page.click('[data-format="jpg"]');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#btn-download')]);
  assert.match(dl.suggestedFilename(), /enhanced-2x\.jpg$/);
  const file = await dl.path();
  assert.ok(fs.statSync(file).size > 10000, 'downloaded file has content');

  // undo the enhancement returns to the cleaned version
  await page.click('[data-view="edit"]');
  await page.keyboard.press('Control+z');
  await page.waitForFunction(() => document.getElementById('ed-dims').textContent.startsWith('640'));

  // close editor
  await page.keyboard.press('Escape');
  await page.locator('#editor').waitFor({ state: 'hidden' });

  const relevant = errors.filter((e) => !/favicon/.test(e) && !/status of 4\d\d/.test(e));
  assert.deepEqual(relevant, [], `console errors: ${relevant.join(' | ')}`);
  await ctx.close();
  console.log(`✓ ${name} flow passed`);
}

(async () => {
  const { server, base } = await startServer();
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  try {
    await run(browser, base, 'desktop', { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
    await run(browser, base, 'tablet', { viewport: { width: 820, height: 1180 }, deviceScaleFactor: 1, hasTouch: true });
    await run(browser, base, 'mobile', { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    console.log('All E2E flows passed. Screenshots in test/e2e/screenshots');
  } catch (e) {
    console.error('E2E failed:', e.message);
    process.exitCode = 1;
  } finally {
    await browser.close();
    server.close();
  }
})();
