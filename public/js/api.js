// Thin client for the PixelPure backend. No secrets live in the browser.

export class ApiError extends Error {
  constructor(message, code, status) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

function parseError(status, body) {
  const e = body && body.error;
  if (e) return new ApiError(e.message, e.code, status);
  if (status === 413) return new ApiError('That file is too large.', 'TOO_LARGE', status);
  if (status === 0) return new ApiError('Network error — check your connection and try again.', 'NETWORK', 0);
  return new ApiError('Something went wrong. Please try again.', 'UNKNOWN', status);
}

/** XHR-based request so we get real upload progress. */
function xhr(method, url, body, { onUploadProgress, responseType = 'json', timeout = 300000 } = {}) {
  return new Promise((resolve, reject) => {
    const req = new XMLHttpRequest();
    req.open(method, url);
    req.responseType = responseType;
    req.timeout = timeout;
    if (onUploadProgress && req.upload) {
      req.upload.onprogress = (e) => e.lengthComputable && onUploadProgress(e.loaded / e.total);
    }
    req.onload = () => {
      const data = req.response;
      if (req.status >= 200 && req.status < 300) resolve({ status: req.status, data });
      else if (req.status === 422 && data && data.results) resolve({ status: req.status, data });
      else reject(parseError(req.status, data));
    };
    req.onerror = () => reject(parseError(0));
    req.ontimeout = () => reject(new ApiError('The request timed out. Please try again.', 'TIMEOUT', 0));
    if (body && !(body instanceof FormData)) {
      req.setRequestHeader('Content-Type', 'application/json');
      req.send(JSON.stringify(body));
    } else req.send(body || null);
  });
}

export async function getConfig() {
  const res = await fetch('/api/config');
  if (!res.ok) throw parseError(res.status, await res.json().catch(() => null));
  return res.json();
}

export async function uploadImages(files, onProgress) {
  const fd = new FormData();
  for (const f of files) fd.append('images', f, f.name);
  const { data } = await xhr('POST', '/api/images', fd, { onUploadProgress: onProgress });
  return data.results;
}

export async function inpaint(imageId, maskBlob, onProgress) {
  const fd = new FormData();
  fd.append('mask', maskBlob, 'mask.png');
  const { data } = await xhr('POST', `/api/images/${imageId}/inpaint`, fd, { onUploadProgress: onProgress });
  return data.image;
}

export async function enhance(imageId, options) {
  const { data } = await xhr('POST', `/api/images/${imageId}/enhance`, options);
  return data.image;
}

export function downloadUrl(imageId, format) {
  return `/api/images/${imageId}/download?format=${encodeURIComponent(format)}`;
}

/** Preload an image URL and resolve when decoded. */
export function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new ApiError('This image has expired. Please upload it again.', 'NOT_FOUND', 404));
    img.src = src;
  });
}
