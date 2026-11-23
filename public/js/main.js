import * as api from './api.js';
import { initStaticCompares } from './compare.js';
import { Editor } from './editor.js';
import { toast, toastError } from './toast.js';

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

let config = {
  maxFileMB: 15,
  maxFilesPerRequest: 10,
  accept: 'image/jpeg,image/png,image/webp',
  retentionMinutes: 60,
  providers: {},
};
let editor;

// ---------------- landing interactions ----------------
function initNav() {
  const nav = $('.nav');
  const onScroll = () => nav.classList.toggle('scrolled', window.scrollY > 8);
  onScroll();
  window.addEventListener('scroll', onScroll, { passive: true });
  const toggle = $('.nav-toggle');
  const menu = $('#mobile-menu');
  toggle.addEventListener('click', () => {
    const open = toggle.getAttribute('aria-expanded') === 'true';
    toggle.setAttribute('aria-expanded', String(!open));
    menu.hidden = open;
  });
  menu.addEventListener('click', (e) => {
    if (e.target.closest('a')) {
      toggle.setAttribute('aria-expanded', 'false');
      menu.hidden = true;
    }
  });
  const y = $('#year');
  if (y) y.textContent = String(new Date().getFullYear());
}

function initReveal() {
  const els = $$('.reveal');
  if (!('IntersectionObserver' in window)) return els.forEach((e) => e.classList.add('in'));
  const io = new IntersectionObserver(
    (entries) => {
      for (const en of entries) {
        if (en.isIntersecting) {
          en.target.classList.add('in');
          io.unobserve(en.target);
        }
      }
    },
    { threshold: 0.12, rootMargin: '0px 0px -40px 0px' }
  );
  els.forEach((e, i) => {
    e.style.transitionDelay = `${(i % 3) * 70}ms`;
    io.observe(e);
  });
}

// ---------------- upload ----------------
function validateFiles(files) {
  const ok = [];
  const allowed = config.accept.split(',');
  for (const f of files) {
    if (!allowed.includes(f.type)) {
      toast({ title: 'Unsupported file', message: `"${f.name}" is not a JPG, PNG or WebP image.`, type: 'error' });
    } else if (f.size > config.maxFileMB * 1024 * 1024) {
      toast({ title: 'File too large', message: `"${f.name}" is ${(f.size / 1048576).toFixed(1)} MB. Maximum is ${config.maxFileMB} MB.`, type: 'error' });
    } else ok.push(f);
  }
  if (ok.length > config.maxFilesPerRequest) {
    toast({ title: 'Too many files', message: `Only the first ${config.maxFilesPerRequest} images will be uploaded.`, type: 'warn' });
    return ok.slice(0, config.maxFilesPerRequest);
  }
  return ok;
}

let uploading = false;
async function handleFiles(fileList) {
  if (uploading) return;
  const files = validateFiles([...fileList]);
  if (!files.length) return;
  uploading = true;
  const overlay = $('#upload-overlay');
  const bar = $('#upload-bar');
  const pct = $('#upload-pct');
  overlay.hidden = false;
  bar.classList.remove('indeterminate');
  bar.style.width = '0%';
  pct.textContent = '0%';
  try {
    const results = await api.uploadImages(files, (p) => {
      bar.style.width = `${Math.round(p * 100)}%`;
      pct.textContent = p < 1 ? `${Math.round(p * 100)}%` : 'Validating…';
      if (p >= 1) bar.classList.add('indeterminate');
    });
    let first = null;
    for (const r of results) {
      if (r.ok) {
        const item = editor.addItem(r.image);
        first = first || item;
      } else {
        toast({ title: `Couldn't upload ${r.name}`, message: r.error.message, type: 'error' });
      }
    }
    if (first) editor.open(first);
  } catch (e) {
    toastError(e, 'Upload failed');
  } finally {
    overlay.hidden = true;
    uploading = false;
    $('#file-input').value = '';
  }
}

function initUpload() {
  const input = $('#file-input');
  input.accept = config.accept;
  const browse = () => input.click();
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-action="browse"]');
    if (b) {
      e.preventDefault();
      e.stopPropagation();
      browse();
    }
  });
  const dz = $('#dropzone');
  dz.addEventListener('click', (e) => {
    if (!e.target.closest('button')) browse();
  });
  dz.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      browse();
    }
  });
  input.addEventListener('change', () => input.files.length && handleFiles(input.files));

  // page-wide drag & drop
  let depth = 0;
  const hasFiles = (e) => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
  window.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth++;
    document.body.classList.add('dragging-file');
  });
  window.addEventListener('dragover', (e) => hasFiles(e) && e.preventDefault());
  window.addEventListener('dragleave', () => {
    depth = Math.max(0, depth - 1);
    if (!depth) document.body.classList.remove('dragging-file');
  });
  window.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0;
    document.body.classList.remove('dragging-file');
    handleFiles(e.dataTransfer.files);
  });

  // paste an image from the clipboard
  window.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files || [])].filter((f) => f.type.startsWith('image/'));
    if (files.length) handleFiles(files);
  });
}

function applyConfigToUi() {
  $('#dz-max').textContent = String(config.maxFileMB);
  $('#dz-count').textContent = String(config.maxFilesPerRequest);
  $('#dz-ttl').textContent = String(config.retentionMinutes);
}

async function init() {
  initNav();
  initReveal();
  initStaticCompares();
  try {
    config = { ...config, ...(await api.getConfig()) };
  } catch {
    toast({ title: 'Server unreachable', message: 'Image processing is unavailable right now. Please refresh in a moment.', type: 'error', timeout: 0 });
  }
  applyConfigToUi();
  editor = new Editor(config);
  initUpload();
}

init();
