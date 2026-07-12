import test from 'node:test';
import assert from 'node:assert/strict';

import { MaskCompositor, blendPremultipliedPixel } from '../js/mask/compositor.js';

class TraceContext {
  constructor(canvas) {
    this.canvas = canvas;
    this.globalCompositeOperation = 'source-over';
    this.globalAlpha = 1;
    this.filter = 'none';
    this.imageSmoothingEnabled = true;
    this.imageSmoothingQuality = 'low';
    this.operations = [];
    this.stack = [];
  }

  save() {
    this.stack.push({
      globalCompositeOperation: this.globalCompositeOperation,
      globalAlpha: this.globalAlpha,
      filter: this.filter,
      imageSmoothingEnabled: this.imageSmoothingEnabled,
      imageSmoothingQuality: this.imageSmoothingQuality,
    });
  }

  restore() {
    Object.assign(this, this.stack.pop());
  }

  setTransform(...args) {
    this.transform = args;
  }

  drawImage(source, ...args) {
    this.operations.push({
      source,
      args,
      composite: this.globalCompositeOperation,
      smoothing: this.imageSmoothingEnabled,
    });
  }
}

class TraceCanvas {
  constructor(width, height, name = '') {
    this._width = width;
    this._height = height;
    this.name = name;
    this.context = new TraceContext(this);
  }

  get width() { return this._width; }
  set width(value) { this._width = Number(value); }
  get height() { return this._height; }
  set height(value) { this._height = Number(value); }
  getContext(kind) { return kind === '2d' ? this.context : null; }
}

test('premultiplied pixel helper implements complementary branch addition', () => {
  assert.deepEqual(blendPremultipliedPixel({
    processed: [0.8, 0.4, 0.2, 1],
    raw: [0.2, 0.6, 0.8, 1],
    coverage: 0.25,
  }), [0.35000000000000003, 0.5499999999999999, 0.6500000000000001, 1]);
  assert.deepEqual(blendPremultipliedPixel({
    processed: [0.25, 0.1, 0, 0.5],
    raw: [0, 0.2, 0.1, 0.25],
    coverage: 0.5,
  }), [0.125, 0.15000000000000002, 0.05, 0.375]);
  assert.throws(() => blendPremultipliedPixel({ processed: [1], raw: [1, 1, 1, 1], coverage: 1 }), /four-channel/);
});

test('Canvas compositor uses destination-in, destination-out, then lighter', () => {
  let next = 0;
  const compositor = new MaskCompositor({
    createCanvas: (width, height) => new TraceCanvas(width, height, `scratch-${next++}`),
  });
  const processed = new TraceCanvas(4, 2, 'processed');
  const raw = new TraceCanvas(4, 2, 'raw');
  const mask = new TraceCanvas(4, 2, 'mask');
  const destination = new TraceCanvas(4, 2, 'destination');
  destination.context.globalCompositeOperation = 'xor';
  destination.context.imageSmoothingEnabled = true;

  assert.equal(compositor.compose({ processed, raw, effectCoverage: mask, destination }), destination);
  assert.deepEqual(
    compositor.processedScratch.context.operations.map((operation) => operation.composite),
    ['copy', 'destination-in'],
  );
  assert.deepEqual(
    compositor.rawScratch.context.operations.map((operation) => operation.composite),
    ['copy', 'destination-out'],
  );
  assert.deepEqual(
    destination.context.operations.map((operation) => operation.composite),
    ['copy', 'lighter'],
  );
  assert.equal(compositor.processedScratch.context.operations[0].smoothing, false);
  assert.equal(compositor.rawScratch.context.operations[0].smoothing, true);
  assert.equal(destination.context.globalCompositeOperation, 'xor', 'caller state is restored');
  assert.equal(destination.context.imageSmoothingEnabled, true);
});

test('scratch canvases are reused by size, resized safely, and explicitly released', () => {
  const allocations = [];
  const compositor = new MaskCompositor({
    createCanvas: (width, height) => {
      const canvas = new TraceCanvas(width, height);
      allocations.push(canvas);
      return canvas;
    },
  });
  const composeAt = (width, height) => compositor.compose({
    processed: new TraceCanvas(width, height),
    raw: new TraceCanvas(width, height),
    effectCoverage: new TraceCanvas(width, height),
    destination: new TraceCanvas(width, height),
  });
  composeAt(2, 2);
  const processedScratch = compositor.processedScratch;
  const rawScratch = compositor.rawScratch;
  composeAt(3, 1);
  assert.equal(allocations.length, 2);
  assert.equal(compositor.processedScratch, processedScratch);
  assert.equal(compositor.rawScratch, rawScratch);
  assert.equal(compositor.estimateScratchBytes(3, 1), 24);
  compositor.release();
  assert.equal(processedScratch.width, 0);
  assert.equal(rawScratch.height, 0);
  assert.equal(compositor.processedScratch, null);
});

test('dimension mismatches fail before any branch draw', () => {
  const compositor = new MaskCompositor({ createCanvas: (w, h) => new TraceCanvas(w, h) });
  assert.throws(() => compositor.compose({
    processed: new TraceCanvas(2, 2),
    raw: new TraceCanvas(3, 2),
    effectCoverage: new TraceCanvas(2, 2),
    destination: new TraceCanvas(2, 2),
  }), /raw must be 2x2/);
  assert.equal(compositor.processedScratch, null);
});
