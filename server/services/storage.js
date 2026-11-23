'use strict';
const fs = require('fs/promises');
const fsSync = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('../config');

const ID_RE = /^[a-f0-9]{32}$/;
const dir = config.storage.dir;

function ensureDir() {
  fsSync.mkdirSync(dir, { recursive: true });
}

function newId() {
  return crypto.randomBytes(16).toString('hex');
}

function isValidId(id) {
  return typeof id === 'string' && ID_RE.test(id);
}

const imagePath = (id) => path.join(dir, `${id}.png`);
const metaPath = (id) => path.join(dir, `${id}.json`);

/** Persist a PNG buffer plus metadata. Returns the record. */
async function save(buffer, meta) {
  const id = newId();
  const record = { id, createdAt: Date.now(), ...meta };
  await fs.writeFile(imagePath(id), buffer);
  await fs.writeFile(metaPath(id), JSON.stringify(record));
  return record;
}

async function getMeta(id) {
  if (!isValidId(id)) return null;
  try {
    const rec = JSON.parse(await fs.readFile(metaPath(id), 'utf8'));
    if (isExpired(rec)) {
      await remove(id);
      return null;
    }
    return rec;
  } catch {
    return null;
  }
}

async function getBuffer(id) {
  if (!isValidId(id)) return null;
  try {
    return await fs.readFile(imagePath(id));
  } catch {
    return null;
  }
}

function isExpired(rec) {
  return Date.now() - rec.createdAt > config.storage.ttlMinutes * 60_000;
}

async function remove(id) {
  if (!isValidId(id)) return;
  await Promise.allSettled([fs.unlink(imagePath(id)), fs.unlink(metaPath(id))]);
}

/** Delete every file older than the TTL. */
async function sweep() {
  let removed = 0;
  const cutoff = Date.now() - config.storage.ttlMinutes * 60_000;
  let entries = [];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return 0;
  }
  await Promise.all(
    entries.map(async (name) => {
      const full = path.join(dir, name);
      try {
        const st = await fs.stat(full);
        if (st.isFile() && st.mtimeMs < cutoff) {
          await fs.unlink(full);
          removed++;
        }
      } catch {
        /* already gone */
      }
    })
  );
  return removed;
}

let timer = null;
function startCleanup(logger = console) {
  ensureDir();
  if (timer) return;
  const run = () =>
    sweep()
      .then((n) => n && logger.log(`[storage] cleanup removed ${n} expired file(s)`))
      .catch((e) => logger.error('[storage] cleanup failed', e));
  run();
  timer = setInterval(run, config.storage.sweepMinutes * 60_000);
  timer.unref();
}

function stopCleanup() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = { ensureDir, save, getMeta, getBuffer, remove, sweep, startCleanup, stopCleanup, isValidId };
