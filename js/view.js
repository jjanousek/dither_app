// Viewport controller: zoom/pan of the canvas stack plus the before/after
// split divider. The stack is positioned with a single CSS transform
// (translate + scale, origin 0 0); the divider lives in untransformed
// viewport space and is repositioned whenever the transform changes.

const MIN_ZOOM = 0.05;
const MAX_ZOOM = 32;
const PADDING = 48;

export class Viewport {
  constructor({ viewport, stack, output, divider, onChange }) {
    this.el = viewport;
    this.stack = stack;
    this.output = output;
    this.divider = divider;
    this.onChange = onChange || (() => {});

    this.zoom = 1;
    this.tx = 0;
    this.ty = 0;
    this.fitMode = true;
    this._lastW = 0;
    this._lastH = 0;

    this.splitOn = false;
    this.splitFrac = 0.5;

    this.#bind();
  }

  // ---- transform -----------------------------------------------------------

  apply() {
    this.stack.style.transform = `translate(${this.tx}px, ${this.ty}px) scale(${this.zoom})`;
    this.#positionDivider();
    this.onChange(this.zoom);
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
    this.splitOn = on;
    this.divider.hidden = !on;
    this.#positionDivider();
  }

  #positionDivider() {
    if (!this.splitOn) return;
    const x = this.tx + this.splitFrac * this.output.width * this.zoom;
    this.divider.style.left = `${x}px`;
  }

  // ---- input ---------------------------------------------------------------

  #bind() {
    const el = this.el;

    el.addEventListener('wheel', (e) => {
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

    // pan drag
    let panning = null;
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      if (e.target.closest('#zoom-controls, #split-divider, #busy')) return;
      e.preventDefault(); // stop WebKit from starting a text-selection drag
      panning = { id: e.pointerId, x: e.clientX, y: e.clientY, tx: this.tx, ty: this.ty };
      el.classList.add('panning');
      el.setPointerCapture(e.pointerId);
    });
    el.addEventListener('pointermove', (e) => {
      if (!panning || e.pointerId !== panning.id) return;
      e.preventDefault();
      this.tx = panning.tx + (e.clientX - panning.x);
      this.ty = panning.ty + (e.clientY - panning.y);
      this.fitMode = false;
      this.apply();
    });
    const endPan = (e) => {
      if (!panning) return;
      panning = null;
      el.classList.remove('panning');
      try { el.releasePointerCapture(e.pointerId); } catch { /* released */ }
    };
    el.addEventListener('pointerup', endPan);
    el.addEventListener('pointercancel', endPan);

    el.addEventListener('dblclick', (e) => {
      if (e.target.closest('#zoom-controls, #split-divider, #busy')) return;
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
      if (panning) { panning = null; el.classList.remove('panning'); }
      splitDrag = false;
    };
    window.addEventListener('blur', cancelDrags);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') cancelDrags();
    });
  }
}
