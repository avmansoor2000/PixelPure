// Editing workspace: brush/eraser masking, undo/redo, zoom/pan, processing, compare & download.
import * as api from './api.js';
import { Compare } from './compare.js';
import { toast, toastError } from './toast.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const MASK_MAX_SIDE = 4096;
const BRUSH_COLOR = '#8b5cf6';

export class Editor {
  constructor(config) {
    this.config = config;
    this.root = $('#editor');
    this.stage = $('#stage');
    this.wrap = $('#canvas-wrap');
    this.img = $('#base-img');
    this.canvas = $('#mask-canvas');
    this.ctx = this.canvas.getContext('2d');
    this.cursor = $('#brush-cursor');
    this.items = [];
    this.active = null;
    this.tool = 'brush';
    this.brushSize = 40;
    this.zoom = 1; // multiplier relative to "fit"
    this.scale = 2;
    this.format = 'png';
    this.view = 'edit';
    this.busy = false;
    this.lastGeminiDetection = null;
    this.compare = new Compare($('#editor-compare'), {
      zoomable: true,
      onZoom: (s) => ($('#cmp-zoom-label').textContent = `${Math.round(s * 100)}%`),
    });
    this.bind();
    this.renderEngineChip();
  }

  // ---------------- items ----------------
  addItem(rec) {
    const item = {
      key: rec.id,
      name: rec.originalName || 'image',
      versions: [rec],
      cur: 0,
      strokes: [],
      undo: [],
      redo: [],
    };
    this.items.push(item);
    this.renderTray();
    return item;
  }

  get current() {
    return this.active && this.active.versions[this.active.cur];
  }

  open(item) {
    if (this.root.hidden) {
      this.root.hidden = false;
      document.body.classList.add('editor-open');
      this.lastFocus = document.activeElement;
    }
    this.select(item || this.items[this.items.length - 1]);
    $('[data-ed="close"]').focus({ preventScroll: true });
  }

  close() {
    this.root.hidden = true;
    this.root.classList.remove('sheet-open');
    document.body.classList.remove('editor-open');
    if (this.lastFocus) this.lastFocus.focus({ preventScroll: true });
  }

  async select(item) {
    if (!item) return;
    this.active = item;
    this.zoom = 1;
    this.setView('edit');
    await this.loadCurrent();
    this.renderTray();
  }

  removeItem(item) {
    const i = this.items.indexOf(item);
    if (i === -1) return;
    this.items.splice(i, 1);
    for (const v of item.versions) fetch(v.url, { method: 'DELETE' }).catch(() => {});
    if (this.active === item) {
      const next = this.items[Math.min(i, this.items.length - 1)];
      if (next) this.select(next);
      else {
        this.active = null;
        this.close();
      }
    }
    this.renderTray();
  }

  async loadCurrent() {
    const v = this.current;
    if (!v) return;
    $('#ed-name').textContent = this.active.name;
    $('#ed-dims').textContent = `${v.width} × ${v.height} px`;
    this.wrap.style.visibility = 'hidden';
    try {
      await api.loadImage(v.url);
    } catch (e) {
      toastError(e, 'Image unavailable');
    }
    this.img.src = v.url;
    // mask canvas (capped resolution — the server rescales it to the image size)
    const k = Math.min(1, MASK_MAX_SIDE / Math.max(v.width, v.height));
    this.maskScale = k;
    this.canvas.width = Math.max(1, Math.round(v.width * k));
    this.canvas.height = Math.max(1, Math.round(v.height * k));
    this.redrawMask();
    this.layout();
    this.wrap.style.visibility = '';
    this.updateUi();

    // Auto-detect Gemini watermark on original uploads
    if (this.active && this.active.cur === 0) {
      this.detectGeminiWatermark(false);
    } else {
      const b = $('#gemini-banner');
      if (b) b.hidden = true;
    }
  }

  // ---------------- layout & zoom ----------------
  fitScale() {
    const v = this.current;
    if (!v) return 1;
    const pad = window.innerWidth < 640 ? 28 : 56;
    const w = Math.max(50, this.stage.clientWidth - pad);
    const h = Math.max(50, this.stage.clientHeight - pad);
    return Math.min(w / v.width, h / v.height, 4);
  }

  get displayScale() {
    return this.fitScale() * this.zoom;
  }

  layout(anchor) {
    const v = this.current;
    if (!v) return;
    const prev = this.wrap.getBoundingClientRect();
    const s = this.displayScale;
    this.wrap.style.width = `${Math.round(v.width * s)}px`;
    this.wrap.style.height = `${Math.round(v.height * s)}px`;
    $('#zoom-label').textContent = this.zoom === 1 ? 'Fit' : `${Math.round(s * 100)}%`;
    if (anchor && prev.width) {
      // keep the anchor point stable while zooming
      const now = this.wrap.getBoundingClientRect();
      const fx = (anchor.x - prev.left) / prev.width;
      const fy = (anchor.y - prev.top) / prev.height;
      this.stage.scrollLeft += now.left + fx * now.width - anchor.x;
      this.stage.scrollTop += now.top + fy * now.height - anchor.y;
    }
    this.updateCursorSize();
  }

  setZoom(z, anchor) {
    this.zoom = Math.min(8, Math.max(1, z));
    if (!anchor) {
      const r = this.stage.getBoundingClientRect();
      anchor = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }
    this.layout(anchor);
  }

  // ---------------- mask drawing ----------------
  toNatural(e) {
    const r = this.wrap.getBoundingClientRect();
    const v = this.current;
    return [((e.clientX - r.left) / r.width) * v.width, ((e.clientY - r.top) / r.height) * v.height];
  }

  strokeSegment(stroke, from, to) {
    const ctx = this.ctx;
    const k = this.maskScale;
    ctx.save();
    ctx.globalCompositeOperation = stroke.mode === 'eraser' ? 'destination-out' : 'source-over';
    ctx.strokeStyle = BRUSH_COLOR;
    ctx.fillStyle = BRUSH_COLOR;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = stroke.size * k;
    if (!to || (from[0] === to[0] && from[1] === to[1])) {
      ctx.beginPath();
      ctx.arc(from[0] * k, from[1] * k, (stroke.size * k) / 2, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.beginPath();
      ctx.moveTo(from[0] * k, from[1] * k);
      ctx.lineTo(to[0] * k, to[1] * k);
      ctx.stroke();
    }
    ctx.restore();
  }

  redrawMask() {
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    if (!this.active) return;
    for (const s of this.active.strokes) {
      const p = s.points;
      this.strokeSegment(s, p[0]);
      for (let i = 1; i < p.length; i++) this.strokeSegment(s, p[i - 1], p[i]);
    }
  }

  hasMask() {
    return !!this.active && this.active.strokes.some((s) => s.mode === 'brush');
  }

  maskBlob() {
    return new Promise((resolve) => this.canvas.toBlob(resolve, 'image/png'));
  }

  // ---------------- history ----------------
  pushHistory(entry) {
    this.active.undo.push(entry);
    this.active.redo = [];
    this.updateUi();
  }

  undo() {
    const it = this.active;
    if (!it || this.busy || !it.undo.length) return;
    const e = it.undo.pop();
    if (e.type === 'stroke') {
      e.stroke = it.strokes.pop();
      this.redrawMask();
    } else if (e.type === 'clear') {
      it.strokes = e.strokes;
      this.redrawMask();
    } else if (e.type === 'version') {
      it.cur = e.from;
      it.strokes = e.strokes;
      this.loadCurrent();
      if (this.view === 'compare') this.setView('edit');
    }
    it.redo.push(e);
    this.updateUi();
  }

  redo() {
    const it = this.active;
    if (!it || this.busy || !it.redo.length) return;
    const e = it.redo.pop();
    if (e.type === 'stroke') {
      it.strokes.push(e.stroke);
      this.redrawMask();
    } else if (e.type === 'clear') {
      it.strokes = [];
      this.redrawMask();
    } else if (e.type === 'version') {
      it.cur = e.to;
      it.strokes = [];
      this.loadCurrent();
    }
    it.undo.push(e);
    this.updateUi();
  }

  clearMask() {
    const it = this.active;
    if (!it || !it.strokes.length) return;
    this.pushHistory({ type: 'clear', strokes: it.strokes });
    it.strokes = [];
    this.redrawMask();
    this.updateUi();
  }

  // ---------------- processing ----------------
  showProcessing(title, sub) {
    $('#processing').hidden = false;
    $('#proc-title').textContent = title;
    $('#proc-sub').textContent = sub || '';
    const bar = $('#proc-bar');
    bar.classList.remove('indeterminate');
    bar.style.width = '0%';
    const t0 = performance.now();
    $('#proc-time').textContent = '';
    clearInterval(this.timer);
    this.timer = setInterval(() => {
      $('#proc-time').textContent = `${((performance.now() - t0) / 1000).toFixed(1)} s elapsed`;
    }, 100);
  }

  setProcStage(title, progress) {
    $('#proc-title').textContent = title;
    const bar = $('#proc-bar');
    if (progress == null) bar.classList.add('indeterminate');
    else {
      bar.classList.remove('indeterminate');
      bar.style.width = `${Math.round(progress * 100)}%`;
    }
  }

  hideProcessing() {
    clearInterval(this.timer);
    $('#processing').hidden = true;
  }

  setBusy(b) {
    this.busy = b;
    this.updateUi();
  }

  engineLabel(cap) {
    const p = this.config.providers && this.config.providers[cap];
    return p && p.label ? p.label : 'server';
  }

  async runInpaint() {
    if (this.busy || !this.hasMask()) {
      if (!this.hasMask()) toast({ title: 'Nothing selected', message: 'Paint over the watermark or object first.', type: 'warn' });
      return;
    }
    const item = this.active;
    const from = item.cur;
    const src = this.current;
    this.setBusy(true);
    this.root.classList.remove('sheet-open');
    this.showProcessing('Uploading selection…', `Engine: ${this.engineLabel('inpaint')}`);
    try {
      const blob = await this.maskBlob();
      const rec = await api.inpaint(src.id, blob, (p) => {
        if (p < 1) this.setProcStage('Uploading selection…', p);
        else this.setProcStage('Removing watermark…', null);
      });
      this.setProcStage('Finalizing…', null);
      await api.loadImage(rec.url);
      this.commitVersion(item, from, rec);
      toast({
        title: 'Watermark removed',
        message: `${rec.providerLabel} · ${(rec.processingMs / 1000).toFixed(1)} s`,
        type: 'success',
      });
    } catch (e) {
      toastError(e, 'Removal failed');
    } finally {
      this.hideProcessing();
      this.setBusy(false);
    }
  }

  async runEnhance() {
    if (this.busy || !this.active) return;
    const item = this.active;
    const from = item.cur;
    const src = this.current;
    this.setBusy(true);
    this.root.classList.remove('sheet-open');
    this.showProcessing(`Enhancing ${this.scale}×…`, `Engine: ${this.engineLabel('enhance')}`);
    this.setProcStage(`Enhancing ${this.scale}×…`, null);
    try {
      const rec = await api.enhance(src.id, {
        scale: this.scale,
        denoise: $('#opt-denoise').checked,
        autoLight: $('#opt-light').checked,
      });
      this.setProcStage('Loading result…', null);
      await api.loadImage(rec.url);
      this.commitVersion(item, from, rec);
      toast({
        title: `Enhanced to ${rec.width} × ${rec.height}`,
        message: `${rec.providerLabel} · ${(rec.processingMs / 1000).toFixed(1)} s${rec.capped ? ' · capped at max output size' : ''}`,
        type: 'success',
      });
    } catch (e) {
      toastError(e, 'Enhancement failed');
    } finally {
      this.hideProcessing();
      this.setBusy(false);
    }
  }

  async detectGeminiWatermark(manual = false) {
    if (!this.current) return;
    const imgId = this.current.id;
    try {
      if (manual) {
        toast({ title: 'Scanning for Gemini watermark…', message: 'Analyzing corner regions and alpha signatures', type: 'info', timeout: 1500 });
      }
      const res = await api.detectGemini(imgId);
      if (res && res.detected) {
        this.lastGeminiDetection = res;
        const banner = $('#gemini-banner');
        if (banner) {
          banner.hidden = false;
          const info = $('#gb-info');
          if (info) {
            info.textContent = `${res.size}×${res.size} mark at (${res.bbox.left}, ${res.bbox.top}) · ${Math.round(res.confidence * 100)}% match`;
          }
        }
        if (manual) {
          toast({
            title: 'Gemini Watermark Detected',
            message: `Found ${res.size}×${res.size} mark. Click "Clean Losslessly" to restore original pixels.`,
            type: 'success',
            timeout: 4000,
          });
        }
      } else {
        this.lastGeminiDetection = null;
        const banner = $('#gemini-banner');
        if (banner) banner.hidden = true;
        if (manual) {
          toast({
            title: 'No Gemini watermark detected',
            message: 'No standard visible Gemini mark was found. You can paint over it manually.',
            type: 'info',
            timeout: 3500,
          });
        }
      }
    } catch (e) {
      if (manual) toastError(e, 'Detection scan failed');
    }
  }

  highlightGemini() {
    if (!this.lastGeminiDetection || !this.lastGeminiDetection.bbox) {
      toast({ title: 'No detection available', message: 'Detect a watermark first.', type: 'warn' });
      return;
    }
    const { left, top, width, height } = this.lastGeminiDetection.bbox;
    const cx = left + width / 2;
    const cy = top + height / 2;
    const stroke = {
      mode: 'brush',
      size: Math.max(width, height) * 1.1,
      points: [[cx, cy]],
    };
    this.active.strokes.push(stroke);
    this.pushHistory({ type: 'stroke' });
    this.redrawMask();
    this.updateUi();
    toast({ title: 'Watermark highlighted', message: 'Marked on canvas. You can clean losslessly or inpaint.', type: 'info', timeout: 2500 });
  }

  async cleanGemini() {
    if (this.busy || !this.active) return;
    const item = this.active;
    const from = item.cur;
    const src = this.current;
    this.setBusy(true);
    this.root.classList.remove('sheet-open');
    this.showProcessing('Restoring original image…', 'Engine: Lossless Reverse-Alpha Restorer');
    this.setProcStage('Reconstructing underlying pixels…', null);
    try {
      const rec = await api.removeGemini(src.id, this.lastGeminiDetection);
      this.setProcStage('Loading result…', null);
      await api.loadImage(rec.url);
      const banner = $('#gemini-banner');
      if (banner) banner.hidden = true;
      this.lastGeminiDetection = null;
      this.commitVersion(item, from, rec);
      toast({
        title: 'Gemini watermark removed',
        message: `Losslessly restored original pixels · ${(rec.processingMs / 1000).toFixed(2)} s`,
        type: 'success',
      });
    } catch (e) {
      toastError(e, 'Gemini removal failed');
    } finally {
      this.hideProcessing();
      this.setBusy(false);
    }
  }

  commitVersion(item, from, rec) {
    item.versions.push(rec);
    const to = item.versions.length - 1;
    item.undo.push({ type: 'version', from, to, strokes: item.strokes });
    item.redo = [];
    item.cur = to;
    item.strokes = [];
    if (this.active === item) {
      this.loadCurrent().then(() => this.setView('compare', from));
    }
    this.renderTray();
  }

  download() {
    const v = this.current;
    if (!v) return;
    const a = document.createElement('a');
    a.href = api.downloadUrl(v.id, this.format);
    a.download = '';
    document.body.append(a);
    a.click();
    a.remove();
    this.root.classList.remove('sheet-open');
    toast({ title: 'Download started', message: `${this.format.toUpperCase()} · ${v.width} × ${v.height}`, type: 'success', timeout: 2500 });
  }

  // ---------------- views ----------------
  versionName(v, i) {
    if (i === 0) return 'Original';
    if (v.kind === 'inpaint') return `Step ${i} · Removed`;
    if (v.kind === 'enhance') return `Step ${i} · Enhanced ${v.scale}×`;
    if (v.kind === 'gemini-remove') return `Step ${i} · Gemini Cleaned`;
    return `Step ${i}`;
  }

  setView(view, againstIndex) {
    if (view === 'compare' && (!this.active || this.active.versions.length < 2)) {
      if (view === 'compare') toast({ title: 'Nothing to compare yet', message: 'Remove a watermark or enhance the image first.', type: 'info', timeout: 3000 });
      view = 'edit';
    }
    this.view = view;
    $$('[data-view]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.view === view)));
    $('#stage').hidden = view !== 'edit';
    $('#stage-hint').hidden = view !== 'edit';
    $('#compare-stage').hidden = view !== 'compare';
    $$('.ed-tools .tool, .ed-tools .icon-btn, .ed-tools .zoom-label, #brush-size').forEach((el) => {
      el.toggleAttribute('data-view-disabled', view !== 'edit');
    });
    $('.ed-tools').style.opacity = view === 'edit' ? '' : '0.4';
    $('.ed-tools').style.pointerEvents = view === 'edit' ? '' : 'none';
    if (view === 'compare') {
      const it = this.active;
      const sel = $('#compare-against');
      sel.innerHTML = '';
      it.versions.forEach((v, i) => {
        if (i === it.cur) return;
        const o = document.createElement('option');
        o.value = String(i);
        o.textContent = this.versionName(v, i);
        sel.append(o);
      });
      const fallback = it.cur > 0 ? it.cur - 1 : 0;
      const idx = againstIndex != null && againstIndex !== it.cur ? againstIndex : fallback;
      sel.value = String(idx);
      this.showCompare(idx);
    }
  }

  showCompare(idx) {
    const it = this.active;
    const before = it.versions[idx];
    const after = it.versions[it.cur];
    const el = $('#editor-compare');
    el.style.aspectRatio = `${after.width} / ${after.height}`;
    this.compare.setLabels(this.versionName(before, idx), this.versionName(after, it.cur));
    this.compare.setImages(before.url, after.url);
    this.compare.reset();
  }

  // ---------------- UI state ----------------
  setTool(tool) {
    this.tool = tool;
    this.stage.dataset.tool = tool;
    $$('[data-tool]').forEach((b) => {
      b.classList.toggle('active', b.dataset.tool === tool);
      b.setAttribute('aria-pressed', String(b.dataset.tool === tool));
    });
    this.cursor.classList.toggle('eraser', tool === 'eraser');
  }

  updateCursorSize() {
    this.cursor.style.width = this.cursor.style.height = `${this.brushSize}px`;
  }

  updateUi() {
    const it = this.active;
    const has = this.hasMask();
    $$('[data-ed="inpaint"]').forEach((b) => (b.disabled = this.busy || !has));
    $('#btn-enhance').disabled = this.busy || !it;
    $('#btn-download').disabled = this.busy || !it;
    $('[data-ed="undo"]').disabled = this.busy || !it || !it.undo.length;
    $('[data-ed="redo"]').disabled = this.busy || !it || !it.redo.length;
    $('[data-ed="clear"]').disabled = this.busy || !it || !it.strokes.length;
    $('#stage-hint').textContent = has
      ? 'Looks good? Click “Remove Watermark”. Use the eraser to refine.'
      : 'Paint over the watermark or object you want to remove';

    const v = this.current;
    if (v) {
      const maxSide = this.config.outputMaxSide || 8192;
      let w = v.width * this.scale;
      let h = v.height * this.scale;
      const k = Math.min(1, maxSide / Math.max(w, h));
      w = Math.round(w * k);
      h = Math.round(h * k);
      $('#enhance-out').textContent = `Output: ${w.toLocaleString()} × ${h.toLocaleString()} px${k < 1 ? ' (max size)' : ''}`;
      const i = it.cur;
      $('#version-info').textContent =
        i === 0 ? `Original · ${v.width} × ${v.height}` : `${this.versionName(v, i)} · ${v.width} × ${v.height}${v.providerLabel ? ` · ${v.providerLabel}` : ''}`;
    }
  }

  renderEngineChip() {
    const chip = $('#engine-chip');
    if (!chip) return;
    const userKeys = api.getAiKeys();
    if (userKeys.provider === 'replicate' && userKeys.replicate) {
      chip.className = 'engine-chip ai';
      chip.textContent = 'AI · Replicate (LaMa)';
      chip.title = 'Using Replicate LaMa model. Click to change.';
      return;
    }
    if (userKeys.provider === 'clipdrop' && userKeys.clipdrop) {
      chip.className = 'engine-chip ai';
      chip.textContent = 'AI · Clipdrop';
      chip.title = 'Using Clipdrop Cleanup API. Click to change.';
      return;
    }
    if (userKeys.provider === 'stability' && userKeys.stability) {
      chip.className = 'engine-chip ai';
      chip.textContent = 'AI · Stability AI';
      chip.title = 'Using Stability AI Erase API. Click to change.';
      return;
    }
    if (userKeys.replicate) {
      chip.className = 'engine-chip ai';
      chip.textContent = 'AI · Replicate (LaMa)';
      chip.title = 'Using Replicate LaMa model. Click to change.';
      return;
    }
    if (userKeys.clipdrop) {
      chip.className = 'engine-chip ai';
      chip.textContent = 'AI · Clipdrop';
      chip.title = 'Using Clipdrop Cleanup API. Click to change.';
      return;
    }
    if (userKeys.stability) {
      chip.className = 'engine-chip ai';
      chip.textContent = 'AI · Stability AI';
      chip.title = 'Using Stability AI Erase API. Click to change.';
      return;
    }
    const p = this.config.providers || {};
    const inp = p.inpaint || {};
    const enh = p.enhance || {};
    if (inp.isAI && enh.isAI) {
      chip.className = 'engine-chip ai';
      chip.textContent = inp.label === enh.label ? `AI · ${inp.label}` : `AI · ${inp.label} / ${enh.label}`;
      chip.title = 'Server AI configured. Click to view settings.';
    } else if (inp.label || enh.label) {
      chip.className = 'engine-chip local';
      chip.textContent = inp.isAI || enh.isAI ? 'Mixed engines' : 'Local · Exemplar Fill';
      chip.title = 'Using sharp Exemplar Patch Fill (no blur). Click to configure AI keys.';
    } else {
      chip.className = 'engine-chip';
      chip.textContent = 'Engine unavailable';
    }
  }

  openSettings() {
    const modal = $('#settings-modal');
    if (!modal) return;
    const keys = api.getAiKeys();
    $('#set-provider').value = keys.provider || 'auto';
    $('#set-replicate').value = keys.replicate || '';
    $('#set-clipdrop').value = keys.clipdrop || '';
    $('#set-stability').value = keys.stability || '';
    modal.hidden = false;
  }

  closeSettings() {
    const modal = $('#settings-modal');
    if (modal) modal.hidden = true;
  }

  saveSettings() {
    const provider = $('#set-provider').value;
    const replicate = $('#set-replicate').value.trim();
    const clipdrop = $('#set-clipdrop').value.trim();
    const stability = $('#set-stability').value.trim();
    api.saveAiKeys({ provider, replicate, clipdrop, stability });
    this.closeSettings();
    this.renderEngineChip();
    toast({ title: 'Settings saved', message: 'Engine preferences updated.', type: 'success', timeout: 2000 });
  }

  renderTray() {
    const tray = $('#tray');
    tray.innerHTML = '';
    for (const it of this.items) {
      const wrap = document.createElement('div');
      wrap.className = `tray-item${it === this.active ? ' active' : ''}`;
      const btn = document.createElement('button');
      btn.style.cssText = 'all:unset;display:block;width:100%;height:100%;cursor:pointer';
      btn.setAttribute('aria-label', `Edit ${it.name}`);
      const img = document.createElement('img');
      img.alt = '';
      img.src = it.versions[it.cur].thumbUrl;
      btn.append(img);
      btn.addEventListener('click', () => it !== this.active && !this.busy && this.select(it));
      wrap.append(btn);
      if (it.versions.length > 1) {
        const b = document.createElement('span');
        b.className = 'badge';
        b.innerHTML = '<svg viewBox="0 0 12 12"><path d="m3 6.2 2 2 4-4.4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
        wrap.append(b);
      }
      const rm = document.createElement('button');
      rm.className = 'tray-remove';
      rm.setAttribute('aria-label', `Remove ${it.name}`);
      rm.textContent = '×';
      rm.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!this.busy) this.removeItem(it);
      });
      wrap.append(rm);
      tray.append(wrap);
    }
  }

  // ---------------- events ----------------
  bind() {
    const stage = this.stage;

    stage.addEventListener('pointerdown', (e) => {
      if (!this.current || this.busy || (e.button !== undefined && e.button !== 0)) return;
      if (this.tool === 'pan') {
        this.panning = { x: e.clientX, y: e.clientY, sl: stage.scrollLeft, st: stage.scrollTop };
        stage.classList.add('panning');
        stage.setPointerCapture(e.pointerId);
        return;
      }
      if (e.pointerType === 'touch' && this.activeTouch != null) return; // ignore second finger
      e.preventDefault();
      stage.setPointerCapture(e.pointerId);
      this.activeTouch = e.pointerId;
      const p = this.toNatural(e);
      this.stroke = { mode: this.tool, size: this.brushSize / this.displayScale, points: [p] };
      this.strokeSegment(this.stroke, p);
    });

    stage.addEventListener('pointermove', (e) => {
      if (this.tool !== 'pan' && e.pointerType !== 'touch') {
        this.cursor.style.display = this.view === 'edit' ? 'block' : 'none';
        this.cursor.style.left = `${e.clientX}px`;
        this.cursor.style.top = `${e.clientY}px`;
      }
      if (this.panning) {
        stage.scrollLeft = this.panning.sl - (e.clientX - this.panning.x);
        stage.scrollTop = this.panning.st - (e.clientY - this.panning.y);
        return;
      }
      if (!this.stroke || e.pointerId !== this.activeTouch) return;
      const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
      for (const ev of events.length ? events : [e]) {
        const p = this.toNatural(ev);
        const pts = this.stroke.points;
        const last = pts[pts.length - 1];
        if (Math.hypot(p[0] - last[0], p[1] - last[1]) < 0.5) continue;
        pts.push(p);
        this.strokeSegment(this.stroke, last, p);
      }
    });

    const end = (e) => {
      if (this.panning) {
        this.panning = null;
        stage.classList.remove('panning');
      }
      if (this.stroke && e.pointerId === this.activeTouch) {
        this.active.strokes.push(this.stroke);
        this.pushHistory({ type: 'stroke' });
        this.stroke = null;
      }
      if (e.pointerId === this.activeTouch) this.activeTouch = null;
    };
    stage.addEventListener('pointerup', end);
    stage.addEventListener('pointercancel', end);
    stage.addEventListener('pointerleave', () => (this.cursor.style.display = 'none'));
    stage.addEventListener(
      'wheel',
      (e) => {
        if (!e.ctrlKey && !e.metaKey) return;
        e.preventDefault();
        this.setZoom(this.zoom * Math.exp(-e.deltaY * 0.01), { x: e.clientX, y: e.clientY });
      },
      { passive: false }
    );

    $('#brush-size').addEventListener('input', (e) => {
      this.brushSize = +e.target.value;
      $('#brush-size-out').textContent = String(this.brushSize);
      this.updateCursorSize();
    });

    this.root.addEventListener('click', (e) => {
      const t = e.target.closest('[data-ed],[data-tool],[data-view],[data-scale],[data-format],[data-cmp]');
      if (!t) return;
      if (t.dataset.tool) return this.setTool(t.dataset.tool);
      if (t.dataset.view) return this.setView(t.dataset.view);
      if (t.dataset.scale) {
        this.scale = +t.dataset.scale;
        $$('[data-scale]').forEach((b) => b.setAttribute('aria-checked', String(b === t)));
        return this.updateUi();
      }
      if (t.dataset.format) {
        this.format = t.dataset.format;
        $$('[data-format]').forEach((b) => b.setAttribute('aria-checked', String(b === t)));
        return;
      }
      if (t.dataset.cmp) {
        if (t.dataset.cmp === 'zoom-in') this.compare.zoomBy(1.5);
        if (t.dataset.cmp === 'zoom-out') this.compare.zoomBy(1 / 1.5);
        if (t.dataset.cmp === 'reset') this.compare.reset();
        return;
      }
      switch (t.dataset.ed) {
        case 'close': return this.close();
        case 'undo': return this.undo();
        case 'redo': return this.redo();
        case 'clear': return this.clearMask();
        case 'zoom-in': return this.setZoom(this.zoom * 1.5);
        case 'zoom-out': return this.setZoom(this.zoom / 1.5);
        case 'zoom-fit': return this.setZoom(1);
        case 'inpaint': return this.runInpaint();
        case 'enhance': return this.runEnhance();
        case 'detect-gemini': return this.detectGeminiWatermark(true);
        case 'download': return this.download();
        case 'sheet': return this.root.classList.toggle('sheet-open');
        case 'sheet-close': return this.root.classList.remove('sheet-open');
      }
    });

    $('#btn-clean-gemini')?.addEventListener('click', () => this.cleanGemini());
    $('#btn-preview-gemini')?.addEventListener('click', () => this.highlightGemini());
    $('#btn-dismiss-gemini')?.addEventListener('click', () => {
      const b = $('#gemini-banner');
      if (b) b.hidden = true;
    });

    $('#compare-against').addEventListener('change', (e) => this.showCompare(+e.target.value));

    $('#engine-chip')?.addEventListener('click', () => this.openSettings());
    $$('[data-action="close-settings"]').forEach((b) => b.addEventListener('click', () => this.closeSettings()));
    $('#btn-save-settings')?.addEventListener('click', () => this.saveSettings());

    window.addEventListener('resize', () => !this.root.hidden && this.layout());

    document.addEventListener('keydown', (e) => {
      if (this.root.hidden) return;
      if (e.target.matches('input, select, textarea')) return;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        return e.shiftKey ? this.redo() : this.undo();
      }
      if (mod && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        return this.redo();
      }
      if (mod) return;
      const k = e.key.toLowerCase();
      if (k === 'b') this.setTool('brush');
      else if (k === 'e') this.setTool('eraser');
      else if (k === 'h') this.setTool('pan');
      else if (k === '[' || k === ']') {
        const r = $('#brush-size');
        r.value = String(Math.max(+r.min, Math.min(+r.max, this.brushSize + (k === ']' ? 8 : -8))));
        r.dispatchEvent(new Event('input'));
      } else if (k === 'escape') {
        if (this.root.classList.contains('sheet-open')) this.root.classList.remove('sheet-open');
        else this.close();
      }
    });
  }
}
