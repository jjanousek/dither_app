import test from 'node:test';
import assert from 'node:assert/strict';

import { MaskRevisionStore } from '../js/mask/model.js';
import {
  ASCII_THRESHOLD_VERSION,
  MaskRasterizer,
  blueNoiseGlyphThreshold,
  estimateRasterAllocationBytes,
  interpolateStrokeStamps,
  makeRasterCacheKey,
  rasterizeCoverageData,
  rasterizeSelectionData,
} from '../js/mask/rasterizer.js';

class PixelContext {
  constructor(canvas) {
    this.canvas = canvas;
    this.image = null;
    this.imageAllocations = 0;
  }

  createImageData(width, height) {
    this.imageAllocations++;
    return { width, height, data: new Uint8ClampedArray(width * height * 4) };
  }

  putImageData(image) {
    this.image = {
      width: image.width,
      height: image.height,
      data: image.data.slice(),
    };
  }
}

class PixelCanvas {
  constructor(width = 0, height = 0) {
    this._width = width;
    this._height = height;
    this.context = new PixelContext(this);
  }

  get width() { return this._width; }
  set width(value) { this._width = Number(value); this.context.image = null; }
  get height() { return this._height; }
  set height(value) { this._height = Number(value); this.context.image = null; }

  getContext(kind) {
    return kind === '2d' ? this.context : null;
  }
}

const createCanvas = (width, height) => new PixelCanvas(width, height);
const blueNoise = {
  size: 2,
  data: new Float32Array([0.1, 0.2, 0.3, 0.4]),
};

const makeStroke = (points, overrides = {}) => ({
  id: 1,
  operation: 'add',
  radiusShortNorm: 0.2,
  feather: 0,
  points: new Float32Array(points),
  ...overrides,
});

function revisionWithStroke(stroke = makeStroke([0.5, 0.5])) {
  const store = new MaskRevisionStore();
  const initial = store.createInitial();
  return {
    store,
    initial,
    revision: store.commit(store.proposeStroke(initial, stroke)),
  };
}

function alphaBytes(canvas) {
  const data = canvas.context.image?.data || new Uint8ClampedArray();
  const alpha = [];
  for (let index = 3; index < data.length; index += 4) alpha.push(data[index]);
  return alpha;
}

test('cache keys include source geometry, crop, coverage, and complete ASCII metadata', () => {
  const { revision } = revisionWithStroke();
  const base = {
    sourceEpoch: 7,
    sourceWidth: 1920,
    sourceHeight: 1080,
    revision,
    width: 800,
    height: 450,
    normalizedCrop: { u0: 0.1, v0: 0.2, u1: 0.9, v1: 0.8 },
    coverageKind: 'effect',
    quantization: {
      kind: 'ascii-grid',
      cols: 80,
      rows: 45,
      rasterWidth: 640,
      rasterHeight: 360,
      thresholdVersion: ASCII_THRESHOLD_VERSION,
    },
  };
  const key = makeRasterCacheKey(base);
  for (const [field, value] of Object.entries({
    cols: 81,
    rows: 46,
    rasterWidth: 641,
    rasterHeight: 361,
    thresholdVersion: 2,
  })) {
    assert.notEqual(makeRasterCacheKey({
      ...base,
      quantization: { ...base.quantization, [field]: value },
    }), key, `changing ${field} must invalidate the cache identity`);
  }
  assert.notEqual(makeRasterCacheKey({ ...base, sourceEpoch: 8 }), key);
  assert.notEqual(makeRasterCacheKey({ ...base, coverageKind: 'selection' }), key);
});

test('raster allocation accounting exposes coverage, ImageData, and backing-store peaks', () => {
  assert.deepEqual(estimateRasterAllocationBytes(4, 3), {
    totalBytes: 144,
    pixels: 12,
    coverageBytes: 48,
    imageDataBytes: 48,
    canvasBytes: 48,
  });
  assert.deepEqual(estimateRasterAllocationBytes(4, 3, {
    coverageBuffers: 2,
    imageDataBuffers: 0,
    canvasBuffers: 0,
  }), {
    totalBytes: 96,
    pixels: 12,
    coverageBytes: 96,
    imageDataBytes: 0,
    canvasBytes: 0,
  });
  assert.throws(() => estimateRasterAllocationBytes(4, 3, { coverageBuffers: -1 }), /non-negative integer/);
});

test('whole-glyph thresholds use the frozen source/grid blue-noise index formula', () => {
  assert.equal(blueNoiseGlyphThreshold(3, 2, blueNoise), blueNoise.data[1]);
  assert.equal(blueNoiseGlyphThreshold(-1, -1, blueNoise), blueNoise.data[3]);
  assert.throws(
    () => blueNoiseGlyphThreshold(0, 0, { size: 1, data: new Float32Array([0]) }),
    /strictly between/,
  );
});

test('residual stamp spacing is invariant to equivalent polyline segmentation', () => {
  const direct = interpolateStrokeStamps(makeStroke([0.1, 0.5, 0.9, 0.5]), 100, 100);
  const segmented = interpolateStrokeStamps(makeStroke([
    0.1, 0.5,
    0.37, 0.5,
    0.61, 0.5,
    0.9, 0.5,
  ]), 100, 100);
  assert.equal(segmented.length, direct.length);
  for (let index = 0; index < direct.length; index++) {
    assert.ok(Math.abs(segmented[index] - direct[index]) < 1e-6, `stamp ${index}`);
  }
  assert.throws(() => interpolateStrokeStamps(makeStroke([0.5, 0.5]), 100, 100, Number.NaN), /spacingFraction/);
});

test('source-space brush stays round and placement is the exact effect complement', () => {
  const { revision } = revisionWithStroke(makeStroke([0.5, 0.5], {
    radiusShortNorm: 0.2,
    feather: 0.5,
  }));
  const request = {
    sourceEpoch: 1,
    sourceWidth: 200,
    sourceHeight: 100,
    revision,
    width: 20,
    height: 10,
    normalizedCrop: { u0: 0, v0: 0, u1: 1, v1: 1 },
  };
  const selection = rasterizeSelectionData(request);
  assert.ok(Math.abs(selection[5 * 20 + 11] - selection[6 * 20 + 10]) < 1e-7);
  const effect = rasterizeCoverageData({ ...request, coverageKind: 'effect' }, blueNoise);
  for (let index = 0; index < selection.length; index++) {
    assert.ok(Math.abs(effect[index] - (1 - selection[index])) < 1e-7);
  }
});

test('ASCII rasterization returns only stable whole-glyph branch decisions', () => {
  const { revision } = revisionWithStroke(makeStroke([0.5, 0.5], {
    radiusShortNorm: 0.45,
    feather: 0.8,
  }));
  const request = {
    sourceEpoch: 1,
    sourceWidth: 8,
    sourceHeight: 4,
    revision,
    width: 16,
    height: 8,
    coverageKind: 'effect',
    quantization: {
      kind: 'ascii-grid',
      cols: 4,
      rows: 2,
      rasterWidth: 8,
      rasterHeight: 4,
      thresholdVersion: ASCII_THRESHOLD_VERSION,
    },
  };
  const first = rasterizeCoverageData(request, blueNoise);
  const second = rasterizeCoverageData(request, blueNoise);
  assert.deepEqual(first, second);
  assert.ok(Array.from(first).every((value) => value === 0 || value === 1));
  for (let y = 0; y < request.height; y++) {
    for (let x = 0; x < request.width; x++) {
      const cellX = Math.floor(x / 4) * 4;
      const cellY = Math.floor(y / 4) * 4;
      assert.equal(first[y * request.width + x], first[cellY * request.width + cellX]);
    }
  }
});

test('live incremental raster commits the same alpha as a full deterministic replay', () => {
  const store = new MaskRevisionStore();
  const initial = store.createInitial();
  const rasterizer = new MaskRasterizer({ createCanvas, maxBytes: 1024 * 1024, blueNoise });
  const request = {
    sourceEpoch: 1,
    sourceWidth: 100,
    sourceHeight: 100,
    revision: store.get(initial),
    width: 32,
    height: 32,
    normalizedCrop: { u0: 0, v0: 0, u1: 1, v1: 1 },
  };
  const session = rasterizer.beginLiveEdit(request);
  session.applySegment(makeStroke([0.1, 0.5, 0.37, 0.5]));
  const finalDraft = makeStroke([0.1, 0.5, 0.37, 0.5, 0.9, 0.5]);
  session.applySegment(finalDraft);
  const revision = store.commit(store.proposeStroke(initial, finalDraft));
  const committed = session.commit(revision);

  const expected = rasterizeSelectionData({ ...request, revision });
  assert.deepEqual(alphaBytes(committed), Array.from(expected, (value) => Math.round(value * 255)));
  assert.equal(committed.context.imageAllocations, 1, 'live updates reuse one ImageData buffer');
});

test('live raster replays the committed revision when pointer-up simplification changes points', () => {
  const store = new MaskRevisionStore();
  const initial = store.createInitial();
  const rasterizer = new MaskRasterizer({ createCanvas, maxBytes: 1024 * 1024, blueNoise });
  const request = {
    sourceEpoch: 1,
    sourceWidth: 100,
    sourceHeight: 100,
    revision: store.get(initial),
    width: 24,
    height: 24,
  };
  const session = rasterizer.beginLiveEdit(request);
  const liveDraft = makeStroke([0.1, 0.5, 0.5, 0.8, 0.9, 0.5]);
  session.applySegment(liveDraft);
  assert.throws(
    () => session.applySegment({ ...liveDraft, feather: 0.5 }),
    /locked at pointerdown/,
  );
  const simplified = makeStroke([0.1, 0.5, 0.9, 0.5]);
  const revision = store.commit(store.proposeStroke(initial, simplified));
  const committed = session.commit(revision);
  const expected = rasterizeSelectionData({ ...request, revision });
  assert.deepEqual(alphaBytes(committed), Array.from(expected, (value) => Math.round(value * 255)));
});

test('byte LRU evicts and releases oldest raster canvases', () => {
  const { store, revision } = revisionWithStroke();
  const inside = store.commit(store.proposePlacement(revision.revisionId, 'inside'));
  const rasterizer = new MaskRasterizer({ createCanvas, maxBytes: 4 * 4 * 4, blueNoise });
  const base = {
    sourceEpoch: 1,
    sourceWidth: 4,
    sourceHeight: 4,
    width: 4,
    height: 4,
    coverageKind: 'effect',
  };
  const oldest = rasterizer.rasterFor({ ...base, revision });
  const newest = rasterizer.rasterFor({ ...base, revision: inside });
  assert.equal(rasterizer.entries, 1);
  assert.equal(rasterizer.bytes, 64);
  assert.equal(oldest.width, 0);
  assert.equal(newest.width, 4);
  rasterizer.releaseAll();
  assert.equal(newest.width, 0);
});

test('trimToBytes deterministically releases least-recent rasters and reports retained bytes', () => {
  const { store, revision: firstRevision } = revisionWithStroke();
  const secondRevision = store.commit(store.proposePlacement(firstRevision.revisionId, 'inside'));
  const thirdRevision = store.commit(store.proposePlacement(secondRevision.revisionId, 'outside'));
  const rasterizer = new MaskRasterizer({ createCanvas, maxBytes: 192, blueNoise });
  const request = {
    sourceEpoch: 1,
    sourceWidth: 4,
    sourceHeight: 4,
    width: 4,
    height: 4,
    coverageKind: 'effect',
  };
  const first = rasterizer.rasterFor({ ...request, revision: firstRevision });
  const second = rasterizer.rasterFor({ ...request, revision: secondRevision });
  const third = rasterizer.rasterFor({ ...request, revision: thirdRevision });
  assert.equal(rasterizer.rasterFor({ ...request, revision: firstRevision }), first, 'cache hit refreshes LRU order');

  const trim = rasterizer.trimToBytes(128);
  assert.equal(trim.beforeBytes, 192);
  assert.equal(trim.afterBytes, 128);
  assert.equal(trim.freedBytes, 64);
  assert.equal(trim.releasedEntries, 1);
  assert.equal(trim.releasedKeys.length, 1);
  assert.equal(second.width, 0, 'least-recent canvas backing store is released');
  assert.equal(first.width, 4);
  assert.equal(third.width, 4);
  assert.equal(rasterizer.cacheBytes, 128);
  assert.equal(rasterizer.bytes, rasterizer.cacheBytes);

  const release = rasterizer.releaseAll();
  assert.equal(release.freedBytes, 128);
  assert.equal(release.releasedEntries, 2);
  assert.equal(rasterizer.cacheBytes, 0);
  assert.equal(first.width, 0);
  assert.equal(third.width, 0);
  assert.throws(() => rasterizer.trimToBytes(-1), /non-negative/);
});
