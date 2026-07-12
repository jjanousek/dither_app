// Immutable Effect Mask document and revision store.
//
// This module is deliberately DOM-free. It owns normalized vector data and
// stable revision identities; canvases and source-specific rasters live in the
// rasterizer/frame-bundle layers.

export const MASK_LIMITS = Object.freeze({
  softStrokes: 2_048,
  hardStrokes: 4_096,
  softPointPairs: 131_072,
  hardPointPairs: 262_144,
  reachableBytes: 16 * 1024 * 1024,
});

export const MASK_VERSION = 1;
export const PLACEMENT_OUTSIDE = 'outside';
export const PLACEMENT_INSIDE = 'inside';

const STROKE_CHUNK_SIZE = 64;
const EMPTY_CHUNKS = Object.freeze([]);

const finite = (value, name) => {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new TypeError(`${name} must be finite`);
  return n;
};

const validPlacement = (placement) => {
  if (placement !== PLACEMENT_OUTSIDE && placement !== PLACEMENT_INSIDE) {
    throw new TypeError(`invalid mask placement: ${placement}`);
  }
  return placement;
};

const validOperation = (operation) => {
  if (operation !== 'add' && operation !== 'erase') {
    throw new TypeError(`invalid stroke operation: ${operation}`);
  }
  return operation;
};

function normalizedPoints(points) {
  const source = points instanceof Float32Array ? points : Float32Array.from(points || []);
  if (source.length < 2 || source.length % 2 !== 0) {
    throw new TypeError('stroke points must contain one or more u/v pairs');
  }
  const out = new Float32Array(source.length);
  for (let i = 0; i < source.length; i++) {
    const value = finite(source[i], `points[${i}]`);
    out[i] = Math.min(1, Math.max(0, value));
  }
  return out;
}

export function createStroke({ id, operation, radiusShortNorm, feather, points }) {
  const strokeId = Number(id);
  if (!Number.isSafeInteger(strokeId) || strokeId < 1) {
    throw new TypeError('stroke id must be a positive safe integer');
  }
  const radius = finite(radiusShortNorm, 'radiusShortNorm');
  if (!(radius > 0)) throw new RangeError('radiusShortNorm must be greater than zero');
  const soft = finite(feather, 'feather');
  if (soft < 0 || soft > 1) throw new RangeError('feather must be in [0, 1]');

  // Copy the typed array at the boundary. Typed-array elements cannot be frozen
  // in JavaScript, so callers must treat the returned buffer as immutable.
  const copiedPoints = normalizedPoints(points);
  return Object.freeze({
    id: strokeId,
    operation: validOperation(operation),
    radiusShortNorm: radius,
    feather: soft,
    points: copiedPoints,
  });
}

export function selectionAfterAdd(selection, alpha) {
  const s = Math.min(1, Math.max(0, finite(selection, 'selection')));
  const a = Math.min(1, Math.max(0, finite(alpha, 'alpha')));
  return a + s * (1 - a);
}

export function selectionAfterErase(selection, alpha) {
  const s = Math.min(1, Math.max(0, finite(selection, 'selection')));
  const a = Math.min(1, Math.max(0, finite(alpha, 'alpha')));
  return s * (1 - a);
}

export function smoothstep01(t) {
  const x = Math.min(1, Math.max(0, finite(t, 't')));
  return x * x * (3 - 2 * x);
}

export function brushAlpha(distance, feather) {
  const d = Math.max(0, finite(distance, 'distance'));
  const f = Math.min(1, Math.max(0, finite(feather, 'feather')));
  if (d >= 1) return d === 1 && f === 0 ? 1 : 0;
  const hardness = 1 - f;
  if (hardness === 1 || d <= hardness) return 1;
  return 1 - smoothstep01((d - hardness) / (1 - hardness));
}

function pointMetric(points, index, sourceWidth, sourceHeight) {
  return [points[index] * sourceWidth, points[index + 1] * sourceHeight];
}

function perpendicularDistance(points, pointIndex, startIndex, endIndex, sourceWidth, sourceHeight) {
  const [px, py] = pointMetric(points, pointIndex, sourceWidth, sourceHeight);
  const [ax, ay] = pointMetric(points, startIndex, sourceWidth, sourceHeight);
  const [bx, by] = pointMetric(points, endIndex, sourceWidth, sourceHeight);
  const dx = bx - ax;
  const dy = by - ay;
  if (dx === 0 && dy === 0) return Math.hypot(px - ax, py - ay);
  const t = Math.min(1, Math.max(0, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

// Deterministic Ramer-Douglas-Peucker simplification in source-pixel space.
export function simplifyStrokePoints(points, {
  sourceWidth,
  sourceHeight,
  tolerancePx,
} = {}) {
  const input = normalizedPoints(points);
  const width = Math.max(1, finite(sourceWidth, 'sourceWidth'));
  const height = Math.max(1, finite(sourceHeight, 'sourceHeight'));
  const tolerance = Math.max(0, finite(tolerancePx ?? 0, 'tolerancePx'));
  const pairs = input.length / 2;
  if (pairs <= 2 || tolerance === 0) return input;

  const keep = new Uint8Array(pairs);
  keep[0] = 1;
  keep[pairs - 1] = 1;
  const stack = [[0, pairs - 1]];
  while (stack.length) {
    const [startPair, endPair] = stack.pop();
    const start = startPair * 2;
    const end = endPair * 2;
    let farthestPair = -1;
    let farthest = tolerance;
    for (let pair = startPair + 1; pair < endPair; pair++) {
      const distance = perpendicularDistance(input, pair * 2, start, end, width, height);
      if (distance > farthest) {
        farthest = distance;
        farthestPair = pair;
      }
    }
    if (farthestPair !== -1) {
      keep[farthestPair] = 1;
      stack.push([startPair, farthestPair], [farthestPair, endPair]);
    }
  }

  let count = 0;
  for (let i = 0; i < keep.length; i++) count += keep[i];
  const out = new Float32Array(count * 2);
  let offset = 0;
  for (let pair = 0; pair < pairs; pair++) {
    if (!keep[pair]) continue;
    out[offset++] = input[pair * 2];
    out[offset++] = input[pair * 2 + 1];
  }
  return out;
}

export function decimateStrokeSamples(points, {
  sourceWidth,
  sourceHeight,
  radiusShortNorm,
  spacingFraction = 0.25,
} = {}) {
  const input = normalizedPoints(points);
  const width = Math.max(1, finite(sourceWidth, 'sourceWidth'));
  const height = Math.max(1, finite(sourceHeight, 'sourceHeight'));
  const radius = Math.max(Number.EPSILON, finite(radiusShortNorm, 'radiusShortNorm')) * Math.min(width, height);
  const spacing = radius * Math.max(0, finite(spacingFraction, 'spacingFraction'));
  if (input.length <= 2 || spacing === 0) return input;

  const kept = [input[0], input[1]];
  let lastX = input[0] * width;
  let lastY = input[1] * height;
  for (let i = 2; i < input.length - 2; i += 2) {
    const x = input[i] * width;
    const y = input[i + 1] * height;
    if (Math.hypot(x - lastX, y - lastY) < spacing) continue;
    kept.push(input[i], input[i + 1]);
    lastX = x;
    lastY = y;
  }
  const end = input.length - 2;
  if (kept[kept.length - 2] !== input[end] || kept[kept.length - 1] !== input[end + 1]) {
    kept.push(input[end], input[end + 1]);
  }
  return Float32Array.from(kept);
}

function appendChunk(chunks, stroke) {
  if (!chunks.length) return Object.freeze([Object.freeze([stroke])]);
  const last = chunks[chunks.length - 1];
  if (last.length >= STROKE_CHUNK_SIZE) {
    return Object.freeze([...chunks, Object.freeze([stroke])]);
  }
  const replacement = Object.freeze([...last, stroke]);
  return Object.freeze([...chunks.slice(0, -1), replacement]);
}

function makeRevision({ revisionId, placement, strokeChunks, strokeCount, pointPairs }) {
  return Object.freeze({
    version: MASK_VERSION,
    revisionId,
    placement: validPlacement(placement),
    strokeChunks,
    strokeCount,
    pointPairs,
  });
}

export function* iterateRevisionStrokes(revision) {
  if (!revision || revision.version !== MASK_VERSION) return;
  for (const chunk of revision.strokeChunks) {
    for (const stroke of chunk) yield stroke;
  }
}

export function revisionStrokes(revision) {
  return Array.from(iterateRevisionStrokes(revision));
}

function strokeBytes(stroke) {
  return stroke.points.byteLength;
}

export class MaskRevisionStore {
  constructor(options = {}) {
    this.limits = Object.freeze({ ...MASK_LIMITS, ...options });
    this._revisions = new Map();
    this._proposals = new Map();
    this._usedStrokeIds = new Set();
    this._nextRevisionId = 1;
    this._nextStrokeId = 1;
  }

  createInitial() {
    const revision = makeRevision({
      revisionId: this._nextRevisionId++,
      placement: PLACEMENT_OUTSIDE,
      strokeChunks: EMPTY_CHUNKS,
      strokeCount: 0,
      pointPairs: 0,
    });
    this._revisions.set(revision.revisionId, revision);
    return revision.revisionId;
  }

  has(revisionId) {
    return this._revisions.has(Number(revisionId));
  }

  get(revisionId) {
    return this._revisions.get(Number(revisionId)) || null;
  }

  nextStrokeId() {
    return this._nextStrokeId++;
  }

  _base(revisionId) {
    const revision = this.get(revisionId);
    if (!revision) throw new RangeError(`unknown mask revision: ${revisionId}`);
    return revision;
  }

  _proposal(base, revision, kind, changed = true) {
    const proposal = Object.freeze({
      proposalId: revision.revisionId,
      baseRevisionId: base.revisionId,
      kind,
      changed,
      revision,
    });
    if (changed) this._proposals.set(proposal.proposalId, proposal);
    return proposal;
  }

  proposeStroke(baseRevisionId, strokeLike) {
    const base = this._base(baseRevisionId);
    const requestedId = strokeLike.id == null ? this.nextStrokeId() : Number(strokeLike.id);
    if (this._usedStrokeIds.has(requestedId)) throw new RangeError(`stroke id has already been used: ${requestedId}`);
    const stroke = createStroke({
      ...strokeLike,
      id: requestedId,
    });
    this._usedStrokeIds.add(stroke.id);
    this._nextStrokeId = Math.max(this._nextStrokeId, stroke.id + 1);
    const strokeCount = base.strokeCount + 1;
    const pointPairs = base.pointPairs + stroke.points.length / 2;
    if (strokeCount > this.limits.hardStrokes || pointPairs > this.limits.hardPointPairs) {
      const error = new RangeError('Mask complexity limit reached');
      error.code = 'MASK_COMPLEXITY_LIMIT';
      throw error;
    }
    const revision = makeRevision({
      revisionId: this._nextRevisionId++,
      placement: base.placement,
      strokeChunks: appendChunk(base.strokeChunks, stroke),
      strokeCount,
      pointPairs,
    });
    return this._proposal(base, revision, 'stroke');
  }

  proposePlacement(baseRevisionId, placement) {
    const base = this._base(baseRevisionId);
    const nextPlacement = validPlacement(placement);
    if (base.placement === nextPlacement) return this._proposal(base, base, 'placement', false);
    return this._proposal(base, makeRevision({
      revisionId: this._nextRevisionId++,
      placement: nextPlacement,
      strokeChunks: base.strokeChunks,
      strokeCount: base.strokeCount,
      pointPairs: base.pointPairs,
    }), 'placement');
  }

  proposeClear(baseRevisionId) {
    const base = this._base(baseRevisionId);
    if (base.strokeCount === 0) return this._proposal(base, base, 'clear', false);
    return this._proposal(base, makeRevision({
      revisionId: this._nextRevisionId++,
      placement: base.placement,
      strokeChunks: EMPTY_CHUNKS,
      strokeCount: 0,
      pointPairs: 0,
    }), 'clear');
  }

  proposeEffectEverywhere(baseRevisionId) {
    return this._proposeEmptyPlacement(baseRevisionId, PLACEMENT_OUTSIDE, 'effect-everywhere');
  }

  proposeOriginalEverywhere(baseRevisionId) {
    return this._proposeEmptyPlacement(baseRevisionId, PLACEMENT_INSIDE, 'original-everywhere');
  }

  proposeReset(baseRevisionId) {
    return this._proposeEmptyPlacement(baseRevisionId, PLACEMENT_OUTSIDE, 'reset');
  }

  _proposeEmptyPlacement(baseRevisionId, placement, kind) {
    const base = this._base(baseRevisionId);
    if (base.strokeCount === 0 && base.placement === placement) {
      return this._proposal(base, base, kind, false);
    }
    return this._proposal(base, makeRevision({
      revisionId: this._nextRevisionId++,
      placement,
      strokeChunks: EMPTY_CHUNKS,
      strokeCount: 0,
      pointPairs: 0,
    }), kind);
  }

  commit(proposal) {
    if (!proposal?.changed) return proposal?.revision || null;
    const pending = this._proposals.get(proposal.proposalId);
    if (pending !== proposal) throw new RangeError('unknown or already resolved mask proposal');
    this._proposals.delete(proposal.proposalId);
    this._revisions.set(proposal.revision.revisionId, proposal.revision);
    return proposal.revision;
  }

  discard(proposal) {
    if (proposal?.changed) this._proposals.delete(proposal.proposalId);
  }

  uniformEffectCoverage(revisionId) {
    const revision = this._base(revisionId);
    if (revision.strokeCount !== 0) return null;
    return revision.placement === PLACEMENT_OUTSIDE ? 1 : 0;
  }

  reachableBytes(rootRevisionIds) {
    const strokes = new Set();
    let bytes = 0;
    for (const id of rootRevisionIds || []) {
      const revision = this.get(id);
      if (!revision) continue;
      for (const stroke of iterateRevisionStrokes(revision)) {
        if (strokes.has(stroke)) continue;
        strokes.add(stroke);
        bytes += strokeBytes(stroke);
      }
    }
    return bytes;
  }

  prune(rootRevisionIds) {
    const roots = new Set(Array.from(rootRevisionIds || [], Number));
    const removedRevisionIds = [];
    for (const id of this._revisions.keys()) {
      if (roots.has(id)) continue;
      this._revisions.delete(id);
      removedRevisionIds.push(id);
    }
    return {
      removedRevisionIds,
      removedRevisions: removedRevisionIds.length,
      bytes: this.reachableBytes(roots),
    };
  }

  get revisionCount() {
    return this._revisions.size;
  }
}
