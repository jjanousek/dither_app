// Exact Canvas 2D compositor for complementary premultiplied mask branches.

function defaultCanvasFactory(width, height) {
  let canvas;
  if (typeof OffscreenCanvas !== 'undefined') canvas = new OffscreenCanvas(width, height);
  else if (typeof document !== 'undefined') canvas = document.createElement('canvas');
  else throw new Error('Canvas is unavailable; provide createCanvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function positiveInteger(value, name) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw new RangeError(`${name} must be a positive integer`);
  return number;
}

function context2d(canvas, label) {
  const context = canvas?.getContext?.('2d');
  if (!context) throw new Error(`Could not acquire ${label} 2D context`);
  return context;
}

function releaseCanvas(canvas) {
  if (!canvas) return;
  try { canvas.width = 0; canvas.height = 0; } catch { /* best effort */ }
}

function resetContext(context, smoothing = false) {
  context.setTransform?.(1, 0, 0, 1, 0, 0);
  context.globalAlpha = 1;
  context.globalCompositeOperation = 'source-over';
  context.filter = 'none';
  context.imageSmoothingEnabled = smoothing;
  if ('imageSmoothingQuality' in context) context.imageSmoothingQuality = 'high';
}

function withSavedContext(context, callback) {
  context.save?.();
  try {
    return callback();
  } finally {
    resetContext(context);
    context.restore?.();
  }
}

function assertDimensions(canvas, width, height, name) {
  if (!canvas || canvas.width !== width || canvas.height !== height) {
    throw new RangeError(`${name} must be ${width}x${height}`);
  }
}

export function blendPremultipliedPixel({ processed, raw, coverage }) {
  if (!processed || processed.length !== 4 || !raw || raw.length !== 4) {
    throw new TypeError('processed and raw must be four-channel premultiplied pixels');
  }
  const m = Math.min(1, Math.max(0, Number(coverage)));
  if (!Number.isFinite(m)) throw new TypeError('coverage must be finite');
  const inverse = 1 - m;
  return [
    Number(processed[0]) * m + Number(raw[0]) * inverse,
    Number(processed[1]) * m + Number(raw[1]) * inverse,
    Number(processed[2]) * m + Number(raw[2]) * inverse,
    Number(processed[3]) * m + Number(raw[3]) * inverse,
  ];
}

export class MaskCompositor {
  constructor({ createCanvas = defaultCanvasFactory } = {}) {
    this.createCanvas = createCanvas;
    this.rawScratch = null;
  }

  _ensureScratch(width, height) {
    if (!this.rawScratch) this.rawScratch = this.createCanvas(width, height);
    if (this.rawScratch.width !== width || this.rawScratch.height !== height) {
      this.rawScratch.width = width;
      this.rawScratch.height = height;
    }
    if (this.rawScratch.width !== width || this.rawScratch.height !== height) {
      throw new Error(`raw scratch allocation failed at ${width}x${height}`);
    }
  }

  compose({ processed, raw, effectCoverage, destination }) {
    const width = positiveInteger(processed?.width, 'processed.width');
    const height = positiveInteger(processed?.height, 'processed.height');
    assertDimensions(raw, width, height, 'raw');
    assertDimensions(effectCoverage, width, height, 'effectCoverage');
    assertDimensions(destination, width, height, 'destination');
    this._ensureScratch(width, height);

    const rawContext = context2d(this.rawScratch, 'raw scratch');
    const destinationContext = context2d(destination, 'destination');

    withSavedContext(rawContext, () => {
      resetContext(rawContext, true);
      rawContext.globalCompositeOperation = 'copy';
      rawContext.drawImage(raw, 0, 0, width, height);
      rawContext.globalCompositeOperation = 'destination-out';
      rawContext.drawImage(effectCoverage, 0, 0, width, height);
    });

    withSavedContext(destinationContext, () => {
      resetContext(destinationContext, false);
      destinationContext.globalCompositeOperation = 'copy';
      destinationContext.drawImage(processed, 0, 0, width, height);
      destinationContext.globalCompositeOperation = 'destination-in';
      destinationContext.drawImage(effectCoverage, 0, 0, width, height);
      destinationContext.globalCompositeOperation = 'lighter';
      destinationContext.drawImage(this.rawScratch, 0, 0, width, height);
    });
    return destination;
  }

  copyRaw({ raw, destination }) {
    const width = positiveInteger(raw?.width, 'raw.width');
    const height = positiveInteger(raw?.height, 'raw.height');
    assertDimensions(destination, width, height, 'destination');
    const context = context2d(destination, 'destination');
    withSavedContext(context, () => {
      resetContext(context, true);
      context.globalCompositeOperation = 'copy';
      context.drawImage(raw, 0, 0, width, height);
    });
    return destination;
  }

  estimateScratchBytes(width, height) {
    return positiveInteger(width, 'width') * positiveInteger(height, 'height') * 4;
  }

  release() {
    releaseCanvas(this.rawScratch);
    this.rawScratch = null;
  }
}
