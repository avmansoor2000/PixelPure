'use strict';
const config = require('../config');
const { ProviderError } = require('../utils/errors');

/** fetch with timeout that turns network / HTTP failures into ProviderErrors. */
async function request(provider, url, options = {}) {
  let res;
  try {
    res = await fetch(url, { ...options, signal: AbortSignal.timeout(options.timeoutMs || config.providers.timeoutMs) });
  } catch (e) {
    if (e.name === 'TimeoutError' || e.name === 'AbortError') {
      throw new ProviderError(provider, 'The AI service took too long to respond. Please try again.', 504);
    }
    throw new ProviderError(provider, 'Could not reach the AI service. Please try again shortly.', 502, { cause: e.message });
  }
  if (!res.ok) {
    let detail = '';
    try {
      const text = await res.text();
      try {
        const j = JSON.parse(text);
        detail = j.message || j.detail || j.error || (Array.isArray(j.errors) ? j.errors.join('; ') : '') || text;
        if (typeof detail === 'object') detail = JSON.stringify(detail);
      } catch {
        detail = text;
      }
    } catch {
      /* ignore */
    }
    throw new ProviderError(provider, friendlyMessage(res.status), mapStatus(res.status), {
      upstreamStatus: res.status,
      upstreamMessage: String(detail).slice(0, 500),
    });
  }
  return res;
}

function mapStatus(s) {
  if (s === 429) return 429;
  if (s === 413) return 413;
  if (s === 400 || s === 422) return 422;
  return 502;
}

function friendlyMessage(s) {
  if (s === 401 || s === 403) return 'The AI service rejected the server API key. Please contact support.';
  if (s === 402) return 'The AI service account is out of credits. Please contact support.';
  if (s === 429) return 'The AI service is busy right now. Please wait a moment and try again.';
  if (s === 413) return 'This image is too large for the AI service.';
  if (s === 400 || s === 422) return 'The AI service could not process this image. Try a different selection or image.';
  return 'The AI service returned an error. Please try again.';
}

function pngBlob(buffer, type = 'image/png') {
  return new Blob([buffer], { type });
}

module.exports = { request, pngBlob };
