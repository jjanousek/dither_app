// Effect Mask editor interaction surface. This module owns transient tool/UI
// state only; canonical mask revisions, history, rendering and exports stay in
// the app orchestrator and are reached exclusively through callbacks.

import { syncRangeProgress } from '../range-progress.js';

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const noop = () => {};

export function isEditableTarget(target) {
  if (!target) return false;
  const editable = target.closest?.('input, select, textarea, [contenteditable="true"]');
  return !!editable || target.isContentEditable === true;
}

// Liang-Barsky clipping against normalized source bounds.
export function clipSegmentToUnitSquare(a, b) {
  const dx = b.u - a.u;
  const dy = b.v - a.v;
  let t0 = 0;
  let t1 = 1;
  const clip = (p, q) => {
    if (p === 0) return q >= 0;
    const r = q / p;
    if (p < 0) {
      if (r > t1) return false;
      if (r > t0) t0 = r;
    } else {
      if (r < t0) return false;
      if (r < t1) t1 = r;
    }
    return true;
  };
  if (!clip(-dx, a.u) || !clip(dx, 1 - a.u)
    || !clip(-dy, a.v) || !clip(dy, 1 - a.v)) return null;
  return [
    { u: a.u + t0 * dx, v: a.v + t0 * dy },
    { u: a.u + t1 * dx, v: a.v + t1 * dy },
  ];
}

export function brushScreenSize({
  diameterShortNorm,
  sourceWidth,
  sourceHeight,
  outputWidth,
  outputHeight,
  zoom,
}) {
  if (!sourceWidth || !sourceHeight || !outputWidth || !outputHeight || !zoom) {
    return { width: 0, height: 0 };
  }
  const diameterSource = diameterShortNorm * Math.min(sourceWidth, sourceHeight);
  return {
    width: diameterSource / sourceWidth * outputWidth * zoom,
    height: diameterSource / sourceHeight * outputHeight * zoom,
  };
}

export function resolveStrokeOperation(event, selectedTool = 'paint', optionHeld = false) {
  const penEraser = event?.pointerType === 'pen'
    && (event.button === 5 || ((event.buttons || 0) & 32) !== 0);
  return selectedTool === 'erase' || optionHeld || event?.altKey
    || event?.button === 2 || penEraser
    ? 'erase'
    : 'add';
}

export function touchGestureMetrics(points) {
  if (!points || points.length < 2) return null;
  const [a, b] = points;
  const dx = b.clientX - a.clientX;
  const dy = b.clientY - a.clientY;
  return {
    x: (a.clientX + b.clientX) / 2,
    y: (a.clientY + b.clientY) / 2,
    distance: Math.max(1, Math.hypot(dx, dy)),
  };
}

function samePoint(a, b, epsilon = 1e-7) {
  return !!a && !!b && Math.abs(a.u - b.u) <= epsilon && Math.abs(a.v - b.v) <= epsilon;
}

function sourceDistanceNorm(a, b, sourceWidth, sourceHeight) {
  const short = Math.max(1, Math.min(sourceWidth, sourceHeight));
  return Math.hypot((a.u - b.u) * sourceWidth, (a.v - b.v) * sourceHeight) / short;
}

function resolveElements(root, supplied = {}) {
  const get = (key, id) => supplied[key] || root?.getElementById?.(id) || null;
  return {
    viewport: get('viewport', 'viewport'),
    maskButton: get('maskButton', 'btn-mask'),
    splitButton: get('splitButton', 'btn-split'),
    status: get('status', 'mask-status'),
    overlay: get('overlay', 'mask-overlay'),
    cursor: get('cursor', 'mask-cursor'),
    cursorCore: get('cursorCore', 'mask-cursor-core'),
    bar: get('bar', 'mask-brush-bar'),
    priming: get('priming', 'mask-priming'),
    paint: get('paint', 'mask-tool-paint'),
    erase: get('erase', 'mask-tool-erase'),
    size: get('size', 'mask-size'),
    sizeValue: get('sizeValue', 'mask-size-value'),
    feather: get('feather', 'mask-feather'),
    featherValue: get('featherValue', 'mask-feather-value'),
    showOriginal: get('showOriginal', 'mask-show-original'),
    showEffect: get('showEffect', 'mask-show-effect'),
    actions: get('actions', 'mask-actions'),
    clearPaint: get('clearPaint', 'mask-clear-paint'),
    effectEverywhere: get('effectEverywhere', 'mask-effect-everywhere'),
    originalEverywhere: get('originalEverywhere', 'mask-original-everywhere'),
    done: get('done', 'mask-done'),
    hint: get('hint', 'mask-editor-hint'),
  };
}

const CALLBACK_NAMES = [
  'onBeginDiscreteEdit',
  'onDraftChanged',
  'onStrokeCommitted',
  'onStrokeRolledBack',
  'onPlacementRequested',
  'onClearPaintRequested',
  'onEffectEverywhereRequested',
  'onOriginalEverywhereRequested',
  'onEditingChanged',
  'onCompareRequested',
  'onMaskRepaintRequested',
];

/**
 * Callback-driven Effect Mask editor.
 *
 * Callbacks receive transient interaction requests; they never grant this
 * class ownership of the mask model or history. Imperative integration
 * methods are: sync(), setLocked(), setPriming(), setComparing(),
 * setOverlayRaster(), onOutputResized(), beforeSourceChange(), beforeExport(),
 * cancelDraft(), handleKeyDown(), handleKeyUp(), handleBlur(), open(), close(),
 * and destroy().
 */
export class MaskEditor {
  constructor({ view, root = globalThis.document, elements = {}, callbacks = {} } = {}) {
    if (!view) throw new Error('MaskEditor requires a Viewport');
    this.view = view;
    this.elements = resolveElements(root, elements);
    this.callbacks = {};
    for (const name of CALLBACK_NAMES) this.callbacks[name] = callbacks[name] || noop;

    this.editing = false;
    this.locked = false;
    this.priming = false;
    this.comparing = false;
    this.compareHeld = false;
    this.spaceHeld = false;
    this.optionHeld = false;
    this.selectedTool = 'paint';
    this.diameterShortNorm = 0.06;
    this.feather = 0.3;
    this.placement = 'outside';
    this.uniformCoverage = 1;
    this.revisionId = 0;
    this.sourceWidth = 0;
    this.sourceHeight = 0;
    this.outputWidth = 0;
    this.outputHeight = 0;
    this.mode = 'dither';
    this.sourceIsMoving = false;

    this.draft = null;
    this.activePointerId = null;
    this.touchPointers = new Map();
    this.touchInhibit = false;
    this.touchGesture = null;
    this.hover = null;
    this.splitDisabledBeforeEditing = false;
    this._listeners = [];

    this.#bindControls();
    this.view.setToolRouter(this);
    this._removeTransformListener = this.view.onTransform?.(() => this.#updateCursor()) || noop;
    if (this.elements.maskButton) this.elements.maskButton.hidden = false;
    this.#syncUi();
  }

  get hasDraft() { return !!this.draft; }

  sync({
    revisionId = this.revisionId,
    placement = this.placement,
    uniformCoverage = this.uniformCoverage,
    sourceWidth = this.sourceWidth,
    sourceHeight = this.sourceHeight,
    outputWidth = this.outputWidth,
    outputHeight = this.outputHeight,
    mode = this.mode,
    sourceIsMoving = this.sourceIsMoving,
  } = {}) {
    Object.assign(this, {
      revisionId,
      placement,
      uniformCoverage,
      sourceWidth,
      sourceHeight,
      outputWidth,
      outputHeight,
      mode,
      sourceIsMoving,
    });
    this.#syncUi();
  }

  setLocked(value) {
    this.locked = !!value;
    this.#syncUi();
  }

  setPriming(value) {
    this.priming = !!value;
    this.#syncUi();
  }

  setComparing(value) {
    this.comparing = !!value;
    this.#syncUi();
  }

  onOutputResized(width, height) {
    this.outputWidth = width || 0;
    this.outputHeight = height || 0;
    const overlay = this.elements.overlay;
    if (overlay && (overlay.width !== width || overlay.height !== height)) {
      overlay.width = Math.max(0, width || 0);
      overlay.height = Math.max(0, height || 0);
      this.callbacks.onMaskRepaintRequested();
    }
    this.#updateCursor();
  }

  setOverlayRaster(raster) {
    const overlay = this.elements.overlay;
    const context = overlay?.getContext?.('2d');
    if (!overlay || !context) return;
    const width = this.outputWidth || raster?.width || overlay.width;
    const height = this.outputHeight || raster?.height || overlay.height;
    if (overlay.width !== width || overlay.height !== height) {
      overlay.width = width;
      overlay.height = height;
    }
    context.clearRect(0, 0, overlay.width, overlay.height);
    if (!raster) return;
    context.save();
    if (raster.data && Number.isFinite(raster.width) && Number.isFinite(raster.height)) {
      context.putImageData(raster, 0, 0);
    } else {
      context.drawImage(raster, 0, 0, overlay.width, overlay.height);
    }
    context.globalCompositeOperation = 'source-in';
    // This is an editing guide, not the rendered mask. Keep it light enough
    // that the actual raw/effect blend remains judgeable while painting.
    context.fillStyle = 'rgba(139, 124, 255, 0.06)';
    context.fillRect(0, 0, overlay.width, overlay.height);
    context.restore();
  }

  open() {
    if (this.editing || this.locked || this.priming) return false;
    this.editing = true;
    this.splitDisabledBeforeEditing = !!this.elements.splitButton?.disabled;
    if (this.elements.splitButton) this.elements.splitButton.disabled = true;
    this.view.setSplitSuppressed?.(true);
    this.callbacks.onEditingChanged(true);
    this.#syncUi();
    return true;
  }

  close({ commitDraft = true } = {}) {
    if (!this.editing) return false;
    if (commitDraft) this.#commitDraft();
    else this.#rollbackDraft();
    if (this.compareHeld || this.comparing) this.#requestCompare(false);
    this.editing = false;
    this.spaceHeld = false;
    this.optionHeld = false;
    this.touchPointers.clear();
    this.touchInhibit = false;
    this.touchGesture = null;
    this.view.setSplitSuppressed?.(false);
    if (this.elements.splitButton) this.elements.splitButton.disabled = this.splitDisabledBeforeEditing;
    this.callbacks.onEditingChanged(false);
    this.#syncUi();
    return true;
  }

  beforeSourceChange() {
    this.cancelDraft();
  }

  beforeExport() {
    const hadDraft = !!this.draft;
    this.#commitDraft();
    this.#resetPointerState();
    return hadDraft;
  }

  cancelDraft() {
    const cancelled = this.#rollbackDraft();
    this.#resetPointerState();
    this.#syncUi();
    return cancelled;
  }

  handleKeyDown(event) {
    if (isEditableTarget(event.target)) return false;
    const code = event.code || '';
    const prevent = () => event.preventDefault?.();

    // Track the temporary eraser modifier itself before rejecting modified
    // chords. Option/Ctrl/Command combined with B/E/X/etc. belongs to the host
    // app or browser, not the Mask editor.
    if (this.editing && (code === 'AltLeft' || code === 'AltRight')) {
      prevent();
      this.optionHeld = true;
      this.#syncUi();
      return true;
    }
    if (event.metaKey || event.ctrlKey || event.altKey) return false;

    if (code === 'KeyB') {
      if (event.repeat) return true;
      prevent();
      if (this.locked || this.priming) return true;
      if (this.editing) this.close({ commitDraft: true });
      else this.open();
      return true;
    }
    if (!this.editing) return false;
    if (code === 'Space') {
      prevent();
      if (!event.repeat) {
        this.spaceHeld = true;
        this.#syncUi();
      }
      return true;
    }
    if (code === 'KeyC') {
      prevent();
      if (!event.repeat && !this.draft && !this.locked && !this.priming) this.#requestCompare(true);
      return true;
    }
    if (code === 'KeyS') {
      prevent();
      return true; // Split is deliberately suppressed while editing.
    }
    if (code === 'Escape') {
      prevent();
      if (this.locked || this.priming) return true;
      this.close({ commitDraft: false });
      return true;
    }
    if (this.locked || this.priming) return false;
    if (code === 'KeyE') {
      prevent();
      if (!event.repeat) this.#setSelectedTool(this.selectedTool === 'paint' ? 'erase' : 'paint');
      return true;
    }
    if (code === 'KeyX') {
      prevent();
      if (!event.repeat && !this.draft) this.#requestPlacement(this.placement === 'outside' ? 'inside' : 'outside');
      return true;
    }
    if (code === 'BracketLeft' || code === 'BracketRight') {
      prevent();
      const direction = code === 'BracketRight' ? 1 : -1;
      if (event.shiftKey) this.#setFeather(this.feather + direction * 0.05);
      else this.#setDiameter(this.diameterShortNorm * (direction > 0 ? 1.15 : 1 / 1.15));
      return true;
    }
    return false;
  }

  handleKeyUp(event) {
    const code = event.code || '';
    if (code === 'AltLeft' || code === 'AltRight') {
      this.optionHeld = false;
      this.#syncUi();
      return this.editing;
    }
    if (code === 'Space') {
      this.spaceHeld = false;
      this.#syncUi();
      return this.editing;
    }
    if (code === 'KeyC' && this.compareHeld) {
      this.#requestCompare(false);
      return true;
    }
    return false;
  }

  handleBlur() {
    this.#commitDraft();
    if (this.compareHeld || this.comparing) this.#requestCompare(false);
    this.optionHeld = false;
    this.spaceHeld = false;
    this.#resetPointerState();
    this.#syncUi();
  }

  // Viewport tool-router surface ------------------------------------------------

  pointerDown(event, point) {
    if (!this.editing) return null;
    if (this.locked || this.priming || this.comparing) return 'consume';

    if (event.pointerType === 'touch') {
      this.touchPointers.set(event.pointerId, { clientX: event.clientX, clientY: event.clientY });
      if (this.touchPointers.size >= 2) {
        this.#rollbackDraft();
        this.activePointerId = null;
        this.touchInhibit = true;
        this.touchGesture = touchGestureMetrics([...this.touchPointers.values()].slice(0, 2));
        this.#syncUi();
        return 'tool';
      }
      if (this.touchInhibit) return 'tool';
    }

    if (this.spaceHeld || event.button === 1) return 'pan';
    if (this.draft) return 'consume';
    if (!point.inside) return 'consume';
    if (![0, 2, 5].includes(event.button)) return 'consume';

    this.callbacks.onBeginDiscreteEdit();
    this.draft = {
      operation: resolveStrokeOperation(event, this.selectedTool, this.optionHeld),
      radiusShortNorm: this.diameterShortNorm / 2,
      feather: this.feather,
      points: [point.u, point.v],
      lastRaw: { u: point.u, v: point.v },
      lastKept: { u: point.u, v: point.v },
    };
    this.activePointerId = event.pointerId;
    this.hover = { ...point, pointerType: event.pointerType, altKey: event.altKey };
    this.#emitDraft();
    this.callbacks.onMaskRepaintRequested();
    this.#syncUi();
    return 'tool';
  }

  pointerMove(event, point, view) {
    if (event.pointerType === 'touch') {
      this.touchPointers.set(event.pointerId, { clientX: event.clientX, clientY: event.clientY });
      if (this.touchInhibit) {
        const next = touchGestureMetrics([...this.touchPointers.values()].slice(0, 2));
        if (next && this.touchGesture) {
          view.panBy(next.x - this.touchGesture.x, next.y - this.touchGesture.y);
          const anchor = view.clientToContent(next.x, next.y);
          view.zoomBy(next.distance / this.touchGesture.distance, anchor.viewportX, anchor.viewportY);
        }
        if (next) this.touchGesture = next;
        return;
      }
    }
    if (!this.draft || event.pointerId !== this.activePointerId) return;
    this.#appendEventSamples(event, view, false);
    this.hover = { ...point, pointerType: event.pointerType, altKey: event.altKey };
    this.#syncUi();
  }

  pointerUp(event, point, view) {
    if (event.pointerType === 'touch') {
      this.touchPointers.delete(event.pointerId);
      if (this.touchInhibit) {
        if (this.touchPointers.size === 0) {
          this.touchInhibit = false;
          this.touchGesture = null;
        }
        this.#syncUi();
        return;
      }
    }
    if (this.draft && event.pointerId === this.activePointerId) {
      this.#appendEventSamples(event, view, true);
      this.#commitDraft();
    }
    this.hover = { ...point, pointerType: event.pointerType, altKey: event.altKey };
    this.#syncUi();
  }

  pointerCancel(event) {
    if (event.pointerType === 'touch') {
      this.touchPointers.delete(event.pointerId);
      if (this.touchInhibit) {
        if (this.touchPointers.size === 0) {
          this.touchInhibit = false;
          this.touchGesture = null;
        }
        this.#syncUi();
        return;
      }
    }
    if (this.draft && event.pointerId === this.activePointerId) this.#commitDraft();
    this.#syncUi();
  }

  pointerHover(event, point) {
    this.hover = { ...point, pointerType: event.pointerType, altKey: event.altKey };
    this.#updateCursor();
  }

  pointerLeave() {
    this.hover = null;
    this.#updateCursor();
  }

  contextMenu() { return this.editing; }
  doubleClick() { return this.editing; }
  blur() { this.handleBlur(); }

  destroy() {
    this.close({ commitDraft: false });
    this.view.setToolRouter(null);
    this._removeTransformListener();
    for (const [element, type, listener] of this._listeners) element.removeEventListener?.(type, listener);
    this._listeners.length = 0;
  }

  #bindControls() {
    const on = (element, type, listener) => {
      if (!element?.addEventListener) return;
      element.addEventListener(type, listener);
      this._listeners.push([element, type, listener]);
    };
    const e = this.elements;
    on(e.maskButton, 'click', () => {
      if (this.editing) this.close({ commitDraft: true });
      else this.open();
    });
    on(e.status, 'click', () => this.open());
    on(e.paint, 'click', () => this.#setSelectedTool('paint'));
    on(e.erase, 'click', () => this.#setSelectedTool('erase'));
    on(e.size, 'input', () => this.#setDiameter(Number(e.size.value)));
    on(e.feather, 'input', () => this.#setFeather(Number(e.feather.value)));
    on(e.showOriginal, 'click', () => this.#requestPlacement('outside'));
    on(e.showEffect, 'click', () => this.#requestPlacement('inside'));
    on(e.clearPaint, 'click', () => this.#requestAction('onClearPaintRequested'));
    on(e.effectEverywhere, 'click', () => this.#requestAction('onEffectEverywhereRequested'));
    on(e.originalEverywhere, 'click', () => this.#requestAction('onOriginalEverywhereRequested'));
    on(e.done, 'click', () => this.close({ commitDraft: true }));
  }

  #setSelectedTool(tool) {
    if (this.locked || this.priming) return;
    this.selectedTool = tool === 'erase' ? 'erase' : 'paint';
    this.#syncUi();
  }

  #setDiameter(value) {
    this.diameterShortNorm = clamp(Number(value) || 0.005, 0.005, 0.4);
    if (this.elements.size) this.elements.size.value = String(this.diameterShortNorm);
    this.#syncUi();
  }

  #setFeather(value) {
    this.feather = clamp(Number(value) || 0, 0, 1);
    if (this.elements.feather) this.elements.feather.value = String(this.feather);
    this.#syncUi();
  }

  #requestPlacement(placement) {
    if (this.locked || this.priming || this.draft || placement === this.placement) return;
    this.callbacks.onBeginDiscreteEdit();
    this.placement = placement;
    this.callbacks.onPlacementRequested(placement);
    if (this.elements.actions) this.elements.actions.open = false;
    this.#syncUi();
  }

  #requestAction(callbackName) {
    if (this.locked || this.priming || this.draft) return;
    this.callbacks.onBeginDiscreteEdit();
    this.callbacks[callbackName]();
    if (this.elements.actions) this.elements.actions.open = false;
  }

  #requestCompare(active) {
    this.compareHeld = !!active;
    this.comparing = !!active;
    this.callbacks.onCompareRequested(!!active);
    this.#syncUi();
  }

  #appendEventSamples(event, view, forceLast) {
    const events = event.getCoalescedEvents?.() || [];
    const samples = events.length ? [...events, event] : [event];
    let changed = false;
    for (let index = 0; index < samples.length; index++) {
      const sample = samples[index];
      const point = view.clientToNormalized(sample.clientX, sample.clientY);
      changed = this.#appendPoint(point, forceLast && index === samples.length - 1) || changed;
    }
    if (changed) {
      this.#emitDraft();
      this.callbacks.onMaskRepaintRequested();
    }
  }

  #appendPoint(point, force) {
    if (!this.draft) return false;
    const raw = { u: point.u, v: point.v };
    const clipped = clipSegmentToUnitSquare(this.draft.lastRaw, raw);
    this.draft.lastRaw = raw;
    if (!clipped) return false;
    let changed = false;
    for (const candidate of clipped) {
      if (samePoint(candidate, this.draft.lastKept)) continue;
      const distance = sourceDistanceNorm(
        candidate,
        this.draft.lastKept,
        this.sourceWidth || this.outputWidth || 1,
        this.sourceHeight || this.outputHeight || 1,
      );
      if (!force && distance < this.draft.radiusShortNorm / 4) continue;
      this.draft.points.push(candidate.u, candidate.v);
      this.draft.lastKept = candidate;
      changed = true;
    }
    return changed;
  }

  #emitDraft() {
    if (!this.draft) {
      this.callbacks.onDraftChanged(null);
      return;
    }
    this.callbacks.onDraftChanged({
      operation: this.draft.operation,
      radiusShortNorm: this.draft.radiusShortNorm,
      feather: this.draft.feather,
      // Borrowed mutable preview points. The committed stroke below always
      // receives its own compact Float32Array.
      points: this.draft.points,
    });
  }

  #commitDraft() {
    if (!this.draft) return false;
    const stroke = {
      operation: this.draft.operation,
      radiusShortNorm: this.draft.radiusShortNorm,
      feather: this.draft.feather,
      points: new Float32Array(this.draft.points),
    };
    this.draft = null;
    this.activePointerId = null;
    this.#emitDraft();
    this.callbacks.onStrokeCommitted(stroke);
    this.callbacks.onMaskRepaintRequested();
    this.#syncUi();
    return true;
  }

  #rollbackDraft() {
    if (!this.draft) return false;
    this.draft = null;
    this.activePointerId = null;
    this.#emitDraft();
    this.callbacks.onStrokeRolledBack();
    this.callbacks.onMaskRepaintRequested();
    this.#syncUi();
    return true;
  }

  #resetPointerState() {
    this.activePointerId = null;
    this.touchPointers.clear();
    this.touchInhibit = false;
    this.touchGesture = null;
    this.hover = null;
  }

  #syncUi() {
    const e = this.elements;
    const disabled = this.locked || this.priming;
    if (e.maskButton) {
      e.maskButton.classList?.toggle('active', this.editing);
      e.maskButton.classList?.toggle('mask-present', this.uniformCoverage !== 1);
      e.maskButton.setAttribute?.('aria-pressed', String(this.editing));
      e.maskButton.disabled = disabled;
    }
    if (e.bar) e.bar.hidden = !this.editing;
    if (e.priming) e.priming.hidden = !this.priming;
    if (e.overlay) e.overlay.hidden = !this.editing || this.comparing || this.locked || this.priming;
    e.viewport?.classList?.toggle('mask-editing', this.editing);
    e.viewport?.classList?.toggle('mask-painting', !!this.draft);
    e.viewport?.classList?.toggle('mask-space-pan', this.spaceHeld);

    const effectiveErase = this.selectedTool === 'erase' || this.optionHeld;
    e.viewport?.classList?.toggle('mask-erasing', effectiveErase);
    this.#press(e.paint, this.selectedTool === 'paint');
    this.#press(e.erase, this.selectedTool === 'erase');
    this.#press(e.showOriginal, this.placement === 'outside');
    this.#press(e.showEffect, this.placement === 'inside');

    for (const control of [e.paint, e.erase, e.size, e.feather, e.showOriginal,
      e.showEffect, e.clearPaint, e.effectEverywhere, e.originalEverywhere, e.done]) {
      if (control) control.disabled = disabled;
    }
    if (e.sizeValue) {
      const px = this.sourceWidth && this.sourceHeight
        ? Math.max(1, Math.round(this.diameterShortNorm * Math.min(this.sourceWidth, this.sourceHeight)))
        : null;
      e.sizeValue.textContent = px ? `${px}px` : `${Math.round(this.diameterShortNorm * 100)}%`;
    }
    if (e.featherValue) e.featherValue.textContent = `${Math.round(this.feather * 100)}%`;
    syncRangeProgress(e.size);
    syncRangeProgress(e.feather);

    if (e.status) {
      e.status.hidden = this.uniformCoverage === 1;
      e.status.textContent = this.uniformCoverage === 0
        ? 'Mask · Original everywhere'
        : `Mask · painted shows ${this.placement === 'inside' ? 'Effect' : 'Original'}`;
    }
    if (e.hint) {
      const paintedResult = this.placement === 'inside' ? 'effect' : 'original';
      const text = this.mode === 'ascii'
        ? `Purple = guide · Paint ${paintedResult} · Snaps to glyphs`
        : `Purple = guide · Paint ${paintedResult} · ⌥ erase · Space pan`;
      e.hint.textContent = this.sourceIsMoving ? `${text} · Static across frames` : text;
      if (e.bar) e.bar.title = e.hint.textContent;
    }
    this.#updateCursor();
  }

  #press(element, active) {
    element?.classList?.toggle('active', !!active);
    element?.setAttribute?.('aria-pressed', String(!!active));
  }

  #updateCursor() {
    const cursor = this.elements.cursor;
    if (!cursor) return;
    const point = this.hover;
    const hide = !this.editing || this.locked || this.priming || this.comparing
      || this.spaceHeld || this.touchInhibit || !point?.inside || point.pointerType === 'touch';
    cursor.hidden = hide;
    if (hide) return;
    const size = brushScreenSize({
      diameterShortNorm: this.diameterShortNorm,
      sourceWidth: this.sourceWidth,
      sourceHeight: this.sourceHeight,
      outputWidth: this.outputWidth || this.view.output?.width,
      outputHeight: this.outputHeight || this.view.output?.height,
      zoom: this.view.zoom,
    });
    cursor.style.transform = `translate3d(${point.viewportX}px, ${point.viewportY}px, 0) translate(-50%, -50%)`;
    const cursorWidth = `${Math.max(2, size.width)}px`;
    const cursorHeight = `${Math.max(2, size.height)}px`;
    if (cursor.style.width !== cursorWidth) cursor.style.width = cursorWidth;
    if (cursor.style.height !== cursorHeight) cursor.style.height = cursorHeight;
    const cursorOperation = this.draft?.operation || resolveStrokeOperation(
      { altKey: point.altKey }, this.selectedTool, this.optionHeld,
    );
    cursor.classList?.toggle('eraser', cursorOperation === 'erase');
    const core = this.elements.cursorCore;
    if (core) {
      const fraction = Math.max(0, 1 - this.feather);
      const coreSize = `${fraction * 100}%`;
      if (core.style.width !== coreSize) core.style.width = coreSize;
      if (core.style.height !== coreSize) core.style.height = coreSize;
    }
  }
}
