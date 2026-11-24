'use strict';
/**
 * Provider registry. Every provider implements:
 *   { name, label, isAI, capabilities: ['inpaint'|'enhance'], isConfigured(),
 *     inpaint({ image, mask, width, height }) -> Buffer,
 *     enhance({ image, width, height, scale, targetWidth, targetHeight, options }) -> Buffer }
 * To add a new AI service, create a module with that shape and register it below.
 */
const config = require('../config');
const { AppError } = require('../utils/errors');

const registry = {
  stability: require('./stability'),
  clipdrop: require('./clipdrop'),
  replicate: require('./replicate'),
  local: require('./local'),
};

// Order used by "auto" selection
const AUTO_ORDER = ['stability', 'clipdrop', 'replicate'];

function resolve(capability, userKeys = {}) {
  const wanted = userKeys.provider || config.providers[capability];
  if (wanted && wanted !== 'auto') {
    const p = registry[wanted];
    if (!p) throw new AppError(500, 'BAD_PROVIDER', `Unknown ${capability} provider "${wanted}".`);
    const isConfig = p.isConfigured() || Boolean(userKeys[wanted] || (wanted === 'replicate' && userKeys.replicate));
    if (!isConfig) {
      throw new AppError(503, 'PROVIDER_NOT_CONFIGURED', `The ${p.label} provider is selected but no API key is set on the server.`);
    }
    return p;
  }
  for (const name of AUTO_ORDER) {
    const p = registry[name];
    const hasUserKey = Boolean(userKeys[name] || (name === 'replicate' && userKeys.replicate));
    if (p.capabilities.includes(capability) && (hasUserKey || p.isConfigured())) return p;
  }
  if (config.providers.allowLocalFallback) return registry.local;
  throw new AppError(503, 'NO_PROVIDER', 'No AI provider is configured on the server.');
}

function status() {
  const safe = (cap) => {
    try {
      const p = resolve(cap);
      return { name: p.name, label: p.label, isAI: p.isAI };
    } catch (e) {
      return { name: null, label: null, isAI: false, error: e.message };
    }
  };
  return {
    inpaint: safe('inpaint'),
    enhance: safe('enhance'),
    available: Object.values(registry).map((p) => ({ name: p.name, label: p.label, isAI: p.isAI, configured: p.isConfigured() })),
  };
}

module.exports = { registry, resolve, status };
