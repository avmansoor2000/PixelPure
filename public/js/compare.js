// Reusable before/after comparison slider with optional zoom + pan (wheel, buttons, pinch, drag).

const KNOB = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 7l-5 5 5 5M15 7l5 5-5 5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const MAX_ZOOM = 8;

export class Compare {
  constructor(el, { zoomable = false, labels = ['Before', 'After'], onZoom } = {}) {
    this.el = el;
    this.zoomable = zoomable;
    this.onZoom = onZoom;
    this.pos = 0.5;
    this.scale = 1;
    this.tx = 0;
    this.ty = 0;
    this.pointers = new Map();
    this.build(labels);
    this.bind();
  }

  build([lb, la]) {
    const el = this.el;
    el.innerHTML = '';
    el.classList.add('cmp');
    if (this.zoomable) el.classList.add('cmp-zoomable');
    const mk = (cls, parent) => {
      const d = document.createElement('div');
      d.className = cls;
      parent.append(d);
      return d;
    };
    this.viewAfter = mk('cmp-view', el);
    this.layerAfter = mk('cmp-layer', this.viewAfter);
    this.imgAfter = new Image();
    this.imgAfter.alt = 'After';
    this.imgAfter.draggable = false;
    this.layerAfter.append(this.imgAfter);

    this.viewBefore = mk('cmp-view cmp-before-view', el);
    this.layerBefore = mk('cmp-layer', this.viewBefore);
    this.imgBefore = new Image();
    this.imgBefore.alt = 'Before';
    this.imgBefore.draggable = false;
    this.layerBefore.append(this.imgBefore);

    this.labelBefore = mk('cmp-label before', el);
    this.labelBefore.textContent = lb;
    this.labelAfter = mk('cmp-label after', el);
    this.labelAfter.textContent = la;

    this.handle = mk('cmp-handle', el);
    this.handle.tabIndex = 0;
    this.handle.setAttribute('role', 'slider');
    this.handle.setAttribute('aria-label', 'Before and after comparison');
    this.handle.setAttribute('aria-valuemin', '0');
    this.handle.setAttribute('aria-valuemax', '100');
    const knob = mk('cmp-knob', this.handle);
    knob.innerHTML = KNOB;
    this.render();
  }

  setLabels(before, after) {
    this.labelBefore.textContent = before;
    this.labelAfter.textContent = after;
  }

  setImages(before, after) {
    this.el.classList.add('cmp-loading');
    let n = 0;
    const done = () => ++n === 2 && this.el.classList.remove('cmp-loading');
    for (const [img, src] of [[this.imgBefore, before], [this.imgAfter, after]]) {
      img.onload = done;
      img.onerror = done;
      img.src = src;
    }
  }

  bind() {
    const el = this.el;
    el.addEventListener('pointerdown', (e) => this.onDown(e));
    el.addEventListener('pointermove', (e) => this.onMove(e));
    el.addEventListener('pointerup', (e) => this.onUp(e));
    el.addEventListener('pointercancel', (e) => this.onUp(e));
    el.addEventListener('lostpointercapture', (e) => this.onUp(e));
    this.handle.addEventListener('keydown', (e) => {
      const step = e.shiftKey ? 0.1 : 0.02;
      if (e.key === 'ArrowLeft') this.setPos(this.pos - step);
      else if (e.key === 'ArrowRight') this.setPos(this.pos + step);
      else if (e.key === 'Home') this.setPos(0);
      else if (e.key === 'End') this.setPos(1);
      else return;
      e.preventDefault();
    });
    if (this.zoomable) {
      el.addEventListener('wheel', (e) => {
        e.preventDefault();
        const r = el.getBoundingClientRect();
        const factor = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0018));
        this.zoomAt(this.scale * factor, e.clientX - r.left, e.clientY - r.top);
      }, { passive: false });
      el.addEventListener('dblclick', (e) => {
        if (e.target.closest('.cmp-handle')) return;
        const r = el.getBoundingClientRect();
        this.zoomAt(this.scale > 1.01 ? 1 : 2.5, e.clientX - r.left, e.clientY - r.top);
      });
    }
  }

  localX(e) {
    const r = this.el.getBoundingClientRect();
    return (e.clientX - r.left) / r.width;
  }

  onDown(e) {
    if (e.button !== undefined && e.button !== 0) return;
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    this.el.setPointerCapture(e.pointerId);
    if (this.pointers.size === 2 && this.zoomable) {
      const [a, b] = [...this.pointers.values()];
      this.pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y), scale: this.scale };
      this.mode = 'pinch';
      return;
    }
    const onHandle = e.target.closest('.cmp-handle');
    if (onHandle || !this.zoomable || this.scale <= 1.001) {
      this.mode = 'slide';
      this.el.classList.add('dragging');
      if (!onHandle) this.setPos(this.localX(e));
    } else {
      this.mode = 'pan';
      this.el.classList.add('panning');
      this.last = { x: e.clientX, y: e.clientY };
    }
  }

  onMove(e) {
    if (!this.pointers.has(e.pointerId)) return;
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this.mode === 'slide') {
      this.setPos(this.localX(e));
    } else if (this.mode === 'pan') {
      this.tx += e.clientX - this.last.x;
      this.ty += e.clientY - this.last.y;
      this.last = { x: e.clientX, y: e.clientY };
      this.clampPan();
      this.render();
    } else if (this.mode === 'pinch' && this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      const r = this.el.getBoundingClientRect();
      this.zoomAt(this.pinch.scale * (d / this.pinch.dist), (a.x + b.x) / 2 - r.left, (a.y + b.y) / 2 - r.top);
    }
  }

  onUp(e) {
    this.pointers.delete(e.pointerId);
    if (this.pointers.size === 0) {
      this.mode = null;
      this.el.classList.remove('dragging', 'panning');
    }
  }

  setPos(p) {
    this.pos = Math.min(1, Math.max(0, p));
    this.render();
  }

  zoomAt(next, cx, cy) {
    const s = Math.min(MAX_ZOOM, Math.max(1, next));
    // keep the point under the cursor fixed
    this.tx = cx - ((cx - this.tx) * s) / this.scale;
    this.ty = cy - ((cy - this.ty) * s) / this.scale;
    this.scale = s;
    this.clampPan();
    this.render();
    this.onZoom && this.onZoom(this.scale);
  }

  zoomBy(f) {
    const r = this.el.getBoundingClientRect();
    this.zoomAt(this.scale * f, r.width / 2, r.height / 2);
  }

  clampPan() {
    const r = this.el.getBoundingClientRect();
    const minX = r.width - r.width * this.scale;
    const minY = r.height - r.height * this.scale;
    this.tx = Math.min(0, Math.max(minX, this.tx));
    this.ty = Math.min(0, Math.max(minY, this.ty));
  }

  reset() {
    this.scale = 1;
    this.tx = 0;
    this.ty = 0;
    this.pos = 0.5;
    this.render();
    this.onZoom && this.onZoom(1);
  }

  render() {
    const t = `translate(${this.tx}px, ${this.ty}px) scale(${this.scale})`;
    this.layerAfter.style.transform = t;
    this.layerBefore.style.transform = t;
    const pct = this.pos * 100;
    this.viewBefore.style.clipPath = `inset(0 ${100 - pct}% 0 0)`;
    this.handle.style.left = `${pct}%`;
    this.handle.setAttribute('aria-valuenow', String(Math.round(pct)));
    this.labelBefore.style.opacity = pct < 12 ? 0 : 1;
    this.labelAfter.style.opacity = pct > 88 ? 0 : 1;
  }
}

/** Auto-initialise static sliders on the landing page. */
export function initStaticCompares(root = document) {
  root.querySelectorAll('[data-compare]').forEach((el) => {
    const ratio = parseFloat(el.dataset.ratio || '1.5');
    el.style.aspectRatio = String(ratio);
    const c = new Compare(el, { labels: [el.dataset.labelBefore || 'Before', el.dataset.labelAfter || 'After'] });
    // lazy-load
    const io = new IntersectionObserver((entries) => {
      if (entries.some((en) => en.isIntersecting)) {
        c.setImages(el.dataset.before, el.dataset.after);
        io.disconnect();
      }
    }, { rootMargin: '300px' });
    io.observe(el);
  });
}
