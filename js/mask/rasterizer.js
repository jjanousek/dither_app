// Deterministic source-space Effect Mask rasterization and byte-budgeted cache.

import { brushAlpha, iterateRevisionStrokes, selectionAfterAdd, selectionAfterErase } from './model.js';
import { getBlueNoise } from '../engine/bluenoise.js';

export const FULL_CROP = Object.freeze({ u0: 0, v0: 0, u1: 1, v1: 1 });
export const CONTINUOUS_QUANTIZATION = Object.freeze({ kind: 'continuous' });
export const ASCII_THRESHOLD_VERSION = 1;

const positiveMod = (value, modulus) => ((value % modulus) + modulus) % modulus;

function defaultCanvasFactory(width, height) {
  let canvas;
  if (typeof OffscreenCanvas !== 'undefined') canvas = new OffscreenCanvas(width, height);
  else if (typeof document !== 'undefined') canvas = document.createElement('canvas');
  else throw new Error('Canvas is unavailable; provide createCanvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

const finitePositive = (value, name) => {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new RangeError(`${name} must be positive`);
  return number;
};

const integerPositive = (value, name) => {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw new RangeError(`${name} must be a positive integer`);
  return number;
};

const nonNegativeInteger = (value, name) => {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new RangeError(`${name} must be a non-negative integer`);
  return number;
};

const byteLimit = (value, name = 'maxBytes') => {
  const number = Number(value);
  if (number === Infinity) return number;
  if (!Number.isFinite(number) || number < 0) throw new RangeError(`${name} must be non-negative or Infinity`);
  return Math.floor(number);
};

/**
 * Peak CPU/backing-store estimate for one deterministic coverage raster.
 * Coverage is Float32, ImageData is RGBA8, and the canvas backing store is
 * conservatively RGBA8. Callers may zero planes they already count elsewhere.
 */
export function estimateRasterAllocationBytes(width, height, {
  coverageBuffers = 1,
  imageDataBuffers = 1,
  canvasBuffers = 1,
} = {}) {
  const w = integerPositive(width, 'width');
  const h = integerPositive(height, 'height');
  const pixels = w * h;
  const coverageBytes = pixels * 4 * nonNegativeInteger(coverageBuffers, 'coverageBuffers');
  const imageDataBytes = pixels * 4 * nonNegativeInteger(imageDataBuffers, 'imageDataBuffers');
  const canvasBytes = pixels * 4 * nonNegativeInteger(canvasBuffers, 'canvasBuffers');
  return Object.freeze({
    totalBytes: coverageBytes + imageDataBytes + canvasBytes,
    pixels,
    coverageBytes,
    imageDataBytes,
    canvasBytes,
  });
}

export function normalizeCrop(crop = FULL_CROP) {
  const u0 = Number(crop.u0);
  const v0 = Number(crop.v0);
  const u1 = Number(crop.u1);
  const v1 = Number(crop.v1);
  if (![u0, v0, u1, v1].every(Number.isFinite) || u0 < 0 || v0 < 0 || u1 > 1 || v1 > 1 || u1 <= u0 || v1 <= v0) {
    throw new RangeError('normalizedCrop must be a non-empty rectangle inside [0,1]');
  }
  return { u0, v0, u1, v1 };
}

function stableNumber(value) {
  return Number(value).toPrecision(15);
}

export function normalizeQuantization(quantization = CONTINUOUS_QUANTIZATION) {
  if (!quantization || quantization.kind === 'continuous') return CONTINUOUS_QUANTIZATION;
  if (quantization.kind !== 'ascii-grid') throw new TypeError(`unknown mask quantization: ${quantization.kind}`);
  return Object.freeze({
    kind: 'ascii-grid',
    cols: integerPositive(quantization.cols, 'cols'),
    rows: integerPositive(quantization.rows, 'rows'),
    rasterWidth: integerPositive(quantization.rasterWidth, 'rasterWidth'),
    rasterHeight: integerPositive(quantization.rasterHeight, 'rasterHeight'),
    thresholdVersion: integerPositive(quantization.thresholdVersion ?? ASCII_THRESHOLD_VERSION, 'thresholdVersion'),
  });
}

export function makeRasterCacheKey({
  sourceEpoch,
  sourceWidth,
  sourceHeight,
  revision,
  revisionId,
  width,
  height,
  normalizedCrop = FULL_CROP,
  coverageKind = 'effect',
  quantization = CONTINUOUS_QUANTIZATION,
}) {
  const crop = normalizeCrop(normalizedCrop);
  const q = normalizeQuantization(quantization);
  const rid = revisionId ?? revision?.revisionId;
  if (!Number.isSafeInteger(Number(rid))) throw new TypeError('revisionId is required');
  if (coverageKind !== 'selection' && coverageKind !== 'effect') throw new TypeError('coverageKind must be selection or effect');
  const quantizationKey = q.kind === 'continuous'
    ? 'continuous'
    : `ascii-grid:${q.cols}x${q.rows}:${q.rasterWidth}x${q.rasterHeight}:v${q.thresholdVersion}`;
  return [
    Number(sourceEpoch),
    stableNumber(sourceWidth), stableNumber(sourceHeight),
    Number(rid), Number(width), Number(height),
    stableNumber(crop.u0), stableNumber(crop.v0), stableNumber(crop.u1), stableNumber(crop.v1),
    coverageKind, quantizationKey,
  ].join('|');
}

export function blueNoiseGlyphThreshold(column, row, blueNoise = getBlueNoise()) {
  const size = integerPositive(blueNoise.size, 'blueNoise.size');
  const x = positiveMod(Math.trunc(column), size);
  const y = positiveMod(Math.trunc(row), size);
  const value = Number(blueNoise.data[y * size + x]);
  if (!Number.isFinite(value) || value <= 0 || value >= 1) {
    throw new TypeError('blue-noise thresholds must be finite and strictly between zero and one');
  }
  // This source/grid anchor is deliberately frozen. Preview and export must
  // resolve the same whole glyph without a frame-dependent phase or offset.
  return value;
}

function interpolateStamps(stroke, sourceWidth, sourceHeight, spacingFraction, includeEndpoint) {
  const width = finitePositive(sourceWidth, 'sourceWidth');
  const height = finitePositive(sourceHeight, 'sourceHeight');
  const points = stroke?.points;
  if (!(points instanceof Float32Array) || points.length < 2 || points.length % 2 !== 0) {
    throw new TypeError('stroke.points must be a Float32Array of u/v pairs');
  }
  const radiusSrc = finitePositive(stroke.radiusShortNorm, 'radiusShortNorm') * Math.min(width, height);
  const fraction = finitePositive(spacingFraction, 'spacingFraction');
  const spacing = Math.max(Number.EPSILON, radiusSrc * fraction);
  const stamps = [points[0], points[1]];
  let sinceLast = 0;

  for (let index = 2; index < points.length; index += 2) {
    const u0 = points[index - 2];
    const v0 = points[index - 1];
    const u1 = points[index];
    const v1 = points[index + 1];
    const dx = (u1 - u0) * width;
    const dy = (v1 - v0) * height;
    const length = Math.hypot(dx, dy);
    if (length === 0) continue;

    let travelled = 0;
    let needed = spacing - sinceLast;
    while (travelled + needed <= length + 1e-9) {
      travelled += needed;
      const t = Math.min(1, travelled / length);
      stamps.push(u0 + (u1 - u0) * t, v0 + (v1 - v0) * t);
      sinceLast = 0;
      needed = spacing;
    }
    sinceLast += length - travelled;
  }

  const endU = points[points.length - 2];
  const endV = points[points.length - 1];
  const lastU = stamps[stamps.length - 2];
  const lastV = stamps[stamps.length - 1];
  if (includeEndpoint && (Math.abs(endU - lastU) > 1e-7 || Math.abs(endV - lastV) > 1e-7)) {
    stamps.push(endU, endV);
  }
  return Float32Array.from(stamps);
}

export function interpolateStrokeStamps(stroke, sourceWidth, sourceHeight, spacingFraction = 0.25) {
  return interpolateStamps(stroke, sourceWidth, sourceHeight, spacingFraction, true);
}

function validateRasterRequest(request) {
  const revision = request.revision;
  if (!revision || !Number.isSafeInteger(revision.revisionId)) throw new TypeError('a mask revision is required');
  const sourceWidth = finitePositive(request.sourceWidth, 'sourceWidth');
  const sourceHeight = finitePositive(request.sourceHeight, 'sourceHeight');
  const width = integerPositive(request.width, 'width');
  const height = integerPositive(request.height, 'height');
  const normalizedCrop = normalizeCrop(request.normalizedCrop);
  const coverageKind = request.coverageKind ?? 'effect';
  if (coverageKind !== 'selection' && coverageKind !== 'effect') throw new TypeError('coverageKind must be selection or effect');
  return {
    ...request,
    sourceEpoch: Number(request.sourceEpoch) || 0,
    sourceWidth,
    sourceHeight,
    width,
    height,
    normalizedCrop,
    coverageKind,
    quantization: normalizeQuantization(request.quantization),
  };
}

function applyStampToSelection(selection, request, stroke, stampU, stampV) {
  const { width, height, sourceWidth, sourceHeight, normalizedCrop: crop } = request;
  const radiusSrc = stroke.radiusShortNorm * Math.min(sourceWidth, sourceHeight);
  const radiusU = radiusSrc / sourceWidth;
  const radiusV = radiusSrc / sourceHeight;
  const centerX = ((stampU - crop.u0) / (crop.u1 - crop.u0)) * width - 0.5;
  const centerY = ((stampV - crop.v0) / (crop.v1 - crop.v0)) * height - 0.5;
  const radiusX = (radiusU / (crop.u1 - crop.u0)) * width;
  const radiusY = (radiusV / (crop.v1 - crop.v0)) * height;
  const minX = Math.max(0, Math.floor(centerX - radiusX) - 1);
  const maxX = Math.min(width - 1, Math.ceil(centerX + radiusX) + 1);
  const minY = Math.max(0, Math.floor(centerY - radiusY) - 1);
  const maxY = Math.min(height - 1, Math.ceil(centerY + radiusY) + 1);

  for (let y = minY; y <= maxY; y++) {
    const sampleV = crop.v0 + ((y + 0.5) / height) * (crop.v1 - crop.v0);
    const dy = (sampleV - stampV) * sourceHeight;
    for (let x = minX; x <= maxX; x++) {
      const sampleU = crop.u0 + ((x + 0.5) / width) * (crop.u1 - crop.u0);
      const dx = (sampleU - stampU) * sourceWidth;
      const distance = Math.hypot(dx, dy) / radiusSrc;
      if (distance > 1) continue;
      const alpha = brushAlpha(distance, stroke.feather);
      const offset = y * width + x;
      selection[offset] = stroke.operation === 'erase'
        ? selectionAfterErase(selection[offset], alpha)
        : selectionAfterAdd(selection[offset], alpha);
    }
  }
}

function applyStrokeToSelection(selection, request, stroke, firstStampPair = 0) {
  const stamps = interpolateStrokeStamps(stroke, request.sourceWidth, request.sourceHeight);
  const start = Math.max(0, firstStampPair * 2);
  for (let index = start; index < stamps.length; index += 2) {
    applyStampToSelection(selection, request, stroke, stamps[index], stamps[index + 1]);
  }
  return stamps.length / 2;
}

export function rasterizeSelectionData(request) {
  const normalized = validateRasterRequest({
    ...request,
    coverageKind: 'selection',
    quantization: CONTINUOUS_QUANTIZATION,
  });
  const selection = new Float32Array(normalized.width * normalized.height);
  for (const stroke of iterateRevisionStrokes(normalized.revision)) {
    applyStrokeToSelection(selection, normalized, stroke);
  }
  return selection;
}

function effectDataFromSelection(selection, placement) {
  if (placement === 'inside') return selection.slice();
  const effect = new Float32Array(selection.length);
  for (let i = 0; i < selection.length; i++) effect[i] = 1 - selection[i];
  return effect;
}

function asciiEffectData(request, blueNoise) {
  const q = request.quantization;
  const fullRequest = {
    ...request,
    width: q.rasterWidth,
    height: q.rasterHeight,
    normalizedCrop: FULL_CROP,
    coverageKind: 'selection',
    quantization: CONTINUOUS_QUANTIZATION,
  };
  const selection = rasterizeSelectionData(fullRequest);
  const effect = effectDataFromSelection(selection, request.revision.placement);
  const decisions = new Uint8Array(q.cols * q.rows);

  for (let row = 0; row < q.rows; row++) {
    const y0 = Math.floor((row * q.rasterHeight) / q.rows);
    const y1 = Math.max(y0 + 1, Math.floor(((row + 1) * q.rasterHeight) / q.rows));
    for (let column = 0; column < q.cols; column++) {
      const x0 = Math.floor((column * q.rasterWidth) / q.cols);
      const x1 = Math.max(x0 + 1, Math.floor(((column + 1) * q.rasterWidth) / q.cols));
      let sum = 0;
      let count = 0;
      for (let y = y0; y < Math.min(y1, q.rasterHeight); y++) {
        const rowOffset = y * q.rasterWidth;
        for (let x = x0; x < Math.min(x1, q.rasterWidth); x++) {
          sum += effect[rowOffset + x];
          count++;
        }
      }
      const coverage = count ? sum / count : 0;
      const threshold = blueNoiseGlyphThreshold(column, row, blueNoise);
      decisions[row * q.cols + column] = coverage <= 0 ? 0 : (coverage >= 1 || coverage >= threshold ? 1 : 0);
    }
  }

  const out = new Float32Array(request.width * request.height);
  const crop = request.normalizedCrop;
  for (let y = 0; y < request.height; y++) {
    const v = crop.v0 + ((y + 0.5) / request.height) * (crop.v1 - crop.v0);
    const row = Math.min(q.rows - 1, Math.max(0, Math.floor(v * q.rows)));
    for (let x = 0; x < request.width; x++) {
      const u = crop.u0 + ((x + 0.5) / request.width) * (crop.u1 - crop.u0);
      const column = Math.min(q.cols - 1, Math.max(0, Math.floor(u * q.cols)));
      out[y * request.width + x] = decisions[row * q.cols + column];
    }
  }
  return out;
}

export function rasterizeCoverageData(rawRequest, blueNoise = getBlueNoise()) {
  const request = validateRasterRequest(rawRequest);
  if (request.quantization.kind === 'ascii-grid') {
    if (request.coverageKind !== 'effect') {
      // The editor overlay always represents the continuous painted selection.
      return rasterizeSelectionData(request);
    }
    return asciiEffectData(request, blueNoise);
  }
  const selection = rasterizeSelectionData(request);
  return request.coverageKind === 'selection'
    ? selection
    : effectDataFromSelection(selection, request.revision.placement);
}

function writeCoverageCanvas(canvas, coverage, width, height) {
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Could not acquire a 2D mask context');
  const image = typeof context.createImageData === 'function'
    ? context.createImageData(width, height)
    : { width, height, data: new Uint8ClampedArray(width * height * 4) };
  for (let i = 0, pixel = 0; pixel < coverage.length; pixel++, i += 4) {
    image.data[i] = 255;
    image.data[i + 1] = 255;
    image.data[i + 2] = 255;
    image.data[i + 3] = Math.round(Math.min(1, Math.max(0, coverage[pixel])) * 255);
  }
  context.putImageData(image, 0, 0);
  return canvas;
}

function releaseCanvas(canvas) {
  if (!canvas) return;
  try { canvas.width = 0; canvas.height = 0; } catch { /* best effort */ }
}

function strokesEqual(left, right) {
  if (!left || !right
    || left.id !== right.id
    || left.operation !== right.operation
    || left.radiusShortNorm !== right.radiusShortNorm
    || left.feather !== right.feather
    || left.points?.length !== right.points?.length) return false;
  for (let index = 0; index < left.points.length; index++) {
    if (left.points[index] !== right.points[index]) return false;
  }
  return true;
}

export class MaskRasterizer {
  constructor({
    createCanvas = defaultCanvasFactory,
    maxBytes = 64 * 1024 * 1024,
    blueNoise = getBlueNoise(),
  } = {}) {
    this.createCanvas = createCanvas;
    this.maxBytes = Math.max(0, Number(maxBytes) || 0);
    this.blueNoise = blueNoise;
    this.cache = new Map();
    this._bytes = 0;
  }

  _allocate(width, height) {
    const canvas = this.createCanvas(width, height);
    canvas.width = width;
    canvas.height = height;
    if (canvas.width !== width || canvas.height !== height) throw new Error(`Mask canvas allocation failed at ${width}x${height}`);
    return canvas;
  }

  _cacheGet(key) {
    const entry = this.cache.get(key);
    if (!entry) return null;
    this.cache.delete(key);
    this.cache.set(key, entry);
    return entry.canvas;
  }

  _cachePut(key, canvas, bytes) {
    const old = this.cache.get(key);
    if (old) {
      this._bytes -= old.bytes;
      if (old.canvas !== canvas) releaseCanvas(old.canvas);
      this.cache.delete(key);
    }
    if (bytes > this.maxBytes) return canvas;
    this.cache.set(key, { canvas, bytes });
    this._bytes += bytes;
    this.evictUntil(this.maxBytes);
    return canvas;
  }

  rasterFor(rawRequest) {
    const request = validateRasterRequest(rawRequest);
    const key = makeRasterCacheKey(request);
    const cached = this._cacheGet(key);
    if (cached) return cached;
    const coverage = rasterizeCoverageData(request, this.blueNoise);
    const canvas = this._allocate(request.width, request.height);
    writeCoverageCanvas(canvas, coverage, request.width, request.height);
    return this._cachePut(key, canvas, request.width * request.height * 4);
  }

  beginLiveEdit(rawRequest) {
    const request = validateRasterRequest({
      ...rawRequest,
      coverageKind: 'selection',
      quantization: CONTINUOUS_QUANTIZATION,
    });
    return new LiveRasterSession(this, request);
  }

  trimToBytes(maxBytes) {
    const limit = byteLimit(maxBytes);
    const beforeBytes = this._bytes;
    const releasedKeys = [];
    while (this._bytes > limit && this.cache.size) {
      const [key, entry] = this.cache.entries().next().value;
      this.cache.delete(key);
      this._bytes -= entry.bytes;
      releasedKeys.push(key);
      releaseCanvas(entry.canvas);
    }
    return Object.freeze({
      limitBytes: limit,
      beforeBytes,
      afterBytes: this._bytes,
      freedBytes: beforeBytes - this._bytes,
      releasedEntries: releasedKeys.length,
      releasedKeys: Object.freeze(releasedKeys),
    });
  }

  // Backward-compatible numeric form used by existing cache insertion paths.
  evictUntil(maxBytes) {
    return this.trimToBytes(maxBytes).freedBytes;
  }

  invalidateRevision(revisionId) {
    const marker = `|${Number(revisionId)}|`;
    this._deleteMatching((key) => key.includes(marker));
  }

  invalidateSourceEpoch(sourceEpoch) {
    const prefix = `${Number(sourceEpoch)}|`;
    this._deleteMatching((key) => key.startsWith(prefix));
  }

  _deleteMatching(predicate) {
    for (const [key, entry] of this.cache) {
      if (!predicate(key)) continue;
      this.cache.delete(key);
      this._bytes -= entry.bytes;
      releaseCanvas(entry.canvas);
    }
  }

  releaseAll() {
    return this.trimToBytes(0);
  }

  get cacheBytes() { return this._bytes; }
  get bytes() { return this._bytes; }
  get entries() { return this.cache.size; }
}

export class LiveRasterSession {
  constructor(rasterizer, request) {
    this.rasterizer = rasterizer;
    this.request = request;
    this.selection = rasterizeSelectionData(request);
    this.canvas = rasterizer._allocate(request.width, request.height);
    this._draftId = null;
    this._appliedStamps = 0;
    this._lastDraft = null;
    this._stampPrefix = new Float32Array(0);
    this._draftStyle = null;
    this._closed = false;
    writeCoverageCanvas(this.canvas, this.selection, request.width, request.height);
  }

  applySegment(strokeDraft) {
    if (this._closed) throw new Error('Live mask raster session is closed');
    const draftId = strokeDraft.id ?? strokeDraft;
    if (this._draftId !== draftId) {
      if (this._draftId !== null) throw new Error('A live raster session supports one draft stroke');
      this._draftId = draftId;
      this._draftStyle = Object.freeze({
        operation: strokeDraft.operation,
        radiusShortNorm: strokeDraft.radiusShortNorm,
        feather: strokeDraft.feather,
      });
    } else if (strokeDraft.operation !== this._draftStyle.operation
      || strokeDraft.radiusShortNorm !== this._draftStyle.radiusShortNorm
      || strokeDraft.feather !== this._draftStyle.feather) {
      throw new Error('Live stroke operation, radius, and feather are locked at pointerdown');
    }
    // The moving endpoint is provisional. Do not bake it until commit: after
    // another segment arrives, residual spacing may place the next stable
    // stamp on the far side of that vertex. Baking every temporary endpoint
    // would make the final raster depend on pointer-event segmentation.
    const stamps = interpolateStamps(
      strokeDraft,
      this.request.sourceWidth,
      this.request.sourceHeight,
      0.25,
      false,
    );
    let prefixChanged = stamps.length < this._stampPrefix.length;
    for (let index = 0; !prefixChanged && index < this._stampPrefix.length; index++) {
      prefixChanged = stamps[index] !== this._stampPrefix[index];
    }
    if (prefixChanged) {
      this.selection = rasterizeSelectionData(this.request);
      this._appliedStamps = 0;
    }
    for (let index = this._appliedStamps * 2; index < stamps.length; index += 2) {
      applyStampToSelection(this.selection, this.request, strokeDraft, stamps[index], stamps[index + 1]);
    }
    this._appliedStamps = stamps.length / 2;
    this._stampPrefix = stamps;
    this._lastDraft = strokeDraft;
    writeCoverageCanvas(this.canvas, this.selection, this.request.width, this.request.height);
    return this.canvas;
  }

  selectionCanvas() {
    return this.canvas;
  }

  commit(newRevision) {
    if (this._closed) throw new Error('Live mask raster session is closed');
    const request = { ...this.request, revision: newRevision };
    let committedStroke = null;
    if (this._lastDraft) {
      for (const stroke of iterateRevisionStrokes(newRevision)) {
        if (stroke.id === this._lastDraft.id) committedStroke = stroke;
      }
    }
    if (this._lastDraft && strokesEqual(this._lastDraft, committedStroke)) {
      const finalStamps = interpolateStrokeStamps(
        committedStroke,
        this.request.sourceWidth,
        this.request.sourceHeight,
      );
      let prefixChanged = finalStamps.length < this._stampPrefix.length;
      for (let index = 0; !prefixChanged && index < this._stampPrefix.length; index++) {
        prefixChanged = finalStamps[index] !== this._stampPrefix[index];
      }
      if (prefixChanged) {
        this.selection = rasterizeSelectionData(request);
      } else {
        for (let index = this._appliedStamps * 2; index < finalStamps.length; index += 2) {
          applyStampToSelection(
            this.selection,
            this.request,
            committedStroke,
            finalStamps[index],
            finalStamps[index + 1],
          );
        }
      }
    } else {
      this.selection = rasterizeSelectionData(request);
    }
    writeCoverageCanvas(this.canvas, this.selection, request.width, request.height);
    const key = makeRasterCacheKey(request);
    this.rasterizer._cachePut(key, this.canvas, request.width * request.height * 4);
    this._closed = true;
    return this.canvas;
  }

  rollback() {
    if (this._closed) return;
    releaseCanvas(this.canvas);
    this._closed = true;
  }
}
