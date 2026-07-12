// Viewport controller: zoom/pan of the canvas stack plus the before/after
// split divider. The stack is positioned with a single CSS transform
// (translate + scale, origin 0 0); the divider lives in untransformed
// viewport space and is repositioned whenever the transform changes.

const MIN_ZOOM = 0.05;
const MAX_ZOOM = 32;
const PADDING = 48;

export class Viewport {
  constructor({ viewport, stack, output, divider, comparison = null, onChange }) {
    this.el = viewport;
    this.stack = stack;
    this.output = output;
    this.divider = divider;
    this.comparison = comparison || stack.querySelector?.('#compare-canvas') || null;
    this.onChange = onChange || (() => {});

    this.zoom = 1;
    this.tx = 0;
    this.ty = 0;
    this.fitMode = true;
    this._lastW = 0;
    this._lastH = 0;

    this.splitOn = false;
    this.splitFrac = 0.5;
    this.splitSuppressed = false;

    // Optional editor/tool surface. Viewport remains the sole pointer
    // dispatcher: a tool can claim a pointer, request the normal pan path, or
    // consume an event, but it never installs a competing viewport drag loop.
    this.toolRouter = null;
    this._toolPointers = new Set();
    this._transformListeners = new Set();

    this.#bind();
  }

  // ---- transform -----------------------------------------------------------

  apply() {
    this.stack.style.transform = `translate(${this.tx}px, ${this.ty}px) scale(${this.zoom})`;
    this.#positionDivider();
    this.onChange(this.zoom);
    for (const listener of this._transformListeners) listener(this);
  }

  onTransform(listener) {
    this._transformListeners.add(listener);
    return () => this._transformListeners.delete(listener);
  }

  setToolRouter(router) {
    this.toolRouter = router || null;
  }

  clientToContent(clientX, clientY) {
    const rect = this.el.getBoundingClientRect();
    const viewportX = clientX - rect.left;
    const viewportY = clientY - rect.top;
    return {
      viewportX,
      viewportY,
      x: (viewportX - this.tx) / this.zoom,
      y: (viewportY - this.ty) / this.zoom,
    };
  }

  clientToNormalized(clientX, clientY) {
    const point = this.clientToContent(clientX, clientY);
    const width = this.output.width;
    const height = this.output.height;
    const u = width ? point.x / width : 0;
    const v = height ? point.y / height : 0;
    return {
      ...point,
      u,
      v,
      inside: width > 0 && height > 0 && u >= 0 && u <= 1 && v >= 0 && v <= 1,
    };
  }

  panBy(dx, dy) {
    this.tx += dx;
    this.ty += dy;
    this.fitMode = false;
    this.apply();
  }

  fit() {
    const vw = this.el.clientWidth - PADDING;
    const vh = this.el.clientHeight - PADDING;
    const cw = this.output.width;
    const ch = this.output.height;
    if (vw <= 0 || vh <= 0 || !cw || !ch) return;
    this.zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.min(vw / cw, vh / ch)));
    this.tx = (this.el.clientWidth - cw * this.zoom) / 2;
    this.ty = (this.el.clientHeight - ch * this.zoom) / 2;
    this.fitMode = true;
    this.apply();
  }

  actualSize() {
    this.#zoomTo(1, this.el.clientWidth / 2, this.el.clientHeight / 2);
  }

  zoomBy(factor, cx, cy) {
    const x = cx ?? this.el.clientWidth / 2;
    const y = cy ?? this.el.clientHeight / 2;
    this.#zoomTo(this.zoom * factor, x, y);
  }

  #zoomTo(z, cx, cy) {
    z = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));
    // keep the content point under (cx, cy) stationary
    const px = (cx - this.tx) / this.zoom;
    const py = (cy - this.ty) / this.zoom;
    this.zoom = z;
    this.tx = cx - px * z;
    this.ty = cy - py * z;
    this.fitMode = false;
    this.apply();
  }

  // Call whenever the output canvas bitmap size changes.
  contentResized() {
    const w = this.output.width;
    const h = this.output.height;
    if (this.fitMode) {
      this.fit();
    } else if (this._lastW && this._lastH && w && h && (w !== this._lastW || h !== this._lastH)) {
      // same content at a different bitmap resolution (compare-hold, post-FX
      // upscale, mode switch): compensate so the on-screen size doesn't jump.
      // Geometric mean keeps both axes stable when the aspect drifts slightly.
      const r = Math.sqrt((this._lastW * this._lastH) / (w * h));
      this.zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, this.zoom * r));
      this.apply();
    } else {
      this.#positionDivider();
    }
    this._lastW = w;
    this._lastH = h;
  }

  // ---- split ---------------------------------------------------------------

  setSplit(on) {
    this.splitOn = !!on;
    this.#syncSplitVisibility();
    this.#positionDivider();
  }

  setSplitSuppressed(on) {
    this.splitSuppressed = !!on;
    this.#syncSplitVisibility();
    this.#positionDivider();
  }

  #syncSplitVisibility() {
    const hidden = !this.splitOn || this.splitSuppressed;
    this.divider.hidden = hidden;
    if (this.comparison) this.comparison.hidden = hidden;
  }

  #positionDivider() {
    if (!this.splitOn || this.splitSuppressed) return;
    const x = this.tx + this.splitFrac * this.output.width * this.zoom;
    this.divider.style.left = `${x}px`;
  }

  // ---- input ---------------------------------------------------------------

  #bind() {
    const el = this.el;
    const isViewportControl = (target) => !!target?.closest?.(
      '[data-viewport-control], #zoom-controls, #split-divider, #busy',
    );

    el.addEventListener('wheel', (e) => {
      if (isViewportControl(e.target)) return;
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;
      if (e.ctrlKey || e.metaKey) {
        // pinch-zoom gesture (trackpads report it as ctrl+wheel)
        this.#zoomTo(this.zoom * Math.exp(-e.deltaY * 0.01), cx, cy);
      } else if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        // horizontal-dominant scroll pans instead of zooming in
        this.tx -= e.deltaX;
        this.fitMode = false;
        this.apply();
      } else if (e.deltaY !== 0) {
        this.#zoomTo(this.zoom * (e.deltaY > 0 ? 1 / 1.13 : 1.13), cx, cy);
      }
    }, { passive: false });

    // One routed drag surface for both tools and the legacy pan interaction.
    let panning = null;
    const beginPan = (e) => {
      e.preventDefault(); // stop WebKit from starting a text-selection drag
      panning = { id: e.pointerId, x: e.clientX, y: e.clientY, tx: this.tx, ty: this.ty };
      el.classList.add('panning');
      try { el.setPointerCapture(e.pointerId); } catch { /* unavailable */ }
    };
    el.addEventListener('pointerdown', (e) => {
      if (isViewportControl(e.target)) return;
      const point = this.clientToNormalized(e.clientX, e.clientY);
      const route = this.toolRouter?.pointerDown?.(e, point, this) || null;
      if (route === 'tool') {
        e.preventDefault();
        this._toolPointers.add(e.pointerId);
        try { el.setPointerCapture(e.pointerId); } catch { /* unavailable */ }
        return;
      }
      if (route === 'consume') {
        e.preventDefault();
        return;
      }
      if (route === 'pan') {
        beginPan(e);
        return;
      }
      if (e.button !== 0) return;
      beginPan(e);
    });
    el.addEventListener('pointermove', (e) => {
      const point = this.clientToNormalized(e.clientX, e.clientY);
      if (this._toolPointers.has(e.pointerId)) {
        e.preventDefault();
        this.toolRouter?.pointerMove?.(e, point, this);
        return;
      }
      this.toolRouter?.pointerHover?.(e, point, this);
      if (!panning || e.pointerId !== panning.id) return;
      e.preventDefault();
      this.tx = panning.tx + (e.clientX - panning.x);
      this.ty = panning.ty + (e.clientY - panning.y);
      this.fitMode = false;
      this.apply();
    });
    const endPan = (e) => {
      if (!panning || (e?.pointerId !== undefined && e.pointerId !== panning.id)) return;
      panning = null;
      el.classList.remove('panning');
      try { el.releasePointerCapture(e?.pointerId); } catch { /* released */ }
    };
    el.addEventListener('pointerup', (e) => {
      if (this._toolPointers.delete(e.pointerId)) {
        this.toolRouter?.pointerUp?.(e, this.clientToNormalized(e.clientX, e.clientY), this);
        try { el.releasePointerCapture(e.pointerId); } catch { /* released */ }
        return;
      }
      endPan(e);
    });
    el.addEventListener('pointercancel', (e) => {
      if (this._toolPointers.delete(e.pointerId)) {
        this.toolRouter?.pointerCancel?.(e, this.clientToNormalized(e.clientX, e.clientY), this);
        try { el.releasePointerCapture(e.pointerId); } catch { /* released */ }
        return;
      }
      endPan(e);
    });
    el.addEventListener('pointerleave', (e) => {
      if (!this._toolPointers.has(e.pointerId)) this.toolRouter?.pointerLeave?.(e, this);
    });
    el.addEventListener('contextmenu', (e) => {
      if (this.toolRouter?.contextMenu?.(e, this)) e.preventDefault();
    });

    el.addEventListener('dblclick', (e) => {
      if (isViewportControl(e.target)) return;
      if (this.toolRouter?.doubleClick?.(e, this)) {
        e.preventDefault();
        return;
      }
      if (this.fitMode) this.actualSize();
      else this.fit();
    });

    // split divider drag
    let splitDrag = false;
    this.divider.addEventListener('contextmenu', (e) => e.preventDefault());
    this.divider.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return; // right-click must not arm the drag
      e.stopPropagation();
      e.preventDefault(); // selection drags break the gesture, esp. in WebKit
      splitDrag = true;
      this.divider.setPointerCapture(e.pointerId);
    });
    this.divider.addEventListener('pointermove', (e) => {
      if (!splitDrag) return;
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const w = this.output.width * this.zoom;
      if (w > 0) {
        this.splitFrac = Math.min(1, Math.max(0, (x - this.tx) / w));
        this.#positionDivider();
        this.onSplitDrag?.(); // let the app redraw the before/after overlay
      }
    });
    const endSplit = (e) => {
      splitDrag = false;
      try { this.divider.releasePointerCapture(e.pointerId); } catch { /* released */ }
    };
    this.divider.addEventListener('pointerup', endSplit);
    this.divider.addEventListener('pointercancel', endSplit);

    window.addEventListener('resize', () => {
      if (this.fitMode) this.fit();
      else this.#positionDivider();
    });

    // lost focus mid-drag: never leave a drag armed
    const cancelDrags = () => {
      this.toolRouter?.blur?.('window', this);
      for (const pointerId of this._toolPointers) {
        try { el.releasePointerCapture(pointerId); } catch { /* released */ }
      }
      this._toolPointers.clear();
      if (panning) { panning = null; el.classList.remove('panning'); }
      splitDrag = false;
    };
    window.addEventListener('blur', cancelDrags);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') cancelDrags();
    });
  }
}
