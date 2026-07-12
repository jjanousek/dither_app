import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MaskRevisionStore,
  PLACEMENT_INSIDE,
  brushAlpha,
  createStroke,
  decimateStrokeSamples,
  revisionStrokes,
  selectionAfterAdd,
  selectionAfterErase,
  simplifyStrokePoints,
} from '../js/mask/model.js';

const strokeLike = (overrides = {}) => ({
  operation: 'add',
  radiusShortNorm: 0.1,
  feather: 0.25,
  points: new Float32Array([0.1, 0.1, 0.9, 0.9]),
  ...overrides,
});

test('selection arithmetic and the normative brush kernel are exact at golden points', () => {
  assert.equal(selectionAfterAdd(0.25, 0.5), 0.625);
  assert.ok(Math.abs(selectionAfterErase(0.8, 0.25) - 0.6) < 1e-12);
  assert.equal(brushAlpha(1, 0), 1, 'hard brush includes its radius boundary');
  assert.equal(brushAlpha(1, 0.5), 0);
  assert.equal(brushAlpha(0.5, 0.5), 1);
  assert.equal(brushAlpha(0.75, 0.5), 0.5);
});

test('revisions are stable, immutable, structurally shared, and preserve uniform states', () => {
  const store = new MaskRevisionStore();
  const initialId = store.createInitial();
  assert.equal(store.uniformEffectCoverage(initialId), 1);

  const strokeProposal = store.proposeStroke(initialId, strokeLike());
  const strokeRevision = store.commit(strokeProposal);
  assert.ok(Object.isFrozen(strokeRevision));
  assert.equal(strokeRevision.strokeCount, 1);
  assert.equal(store.uniformEffectCoverage(strokeRevision.revisionId), null);

  const placementRevision = store.commit(store.proposePlacement(strokeRevision.revisionId, PLACEMENT_INSIDE));
  assert.equal(placementRevision.strokeChunks, strokeRevision.strokeChunks);
  assert.ok(placementRevision.revisionId > strokeRevision.revisionId);

  const cleared = store.commit(store.proposeClear(placementRevision.revisionId));
  assert.equal(cleared.strokeCount, 0);
  assert.equal(store.uniformEffectCoverage(cleared.revisionId), 0);
  assert.equal(store.proposeClear(cleared.revisionId).changed, false);
});

test('stroke and revision identities are monotonic and never reused after discard', () => {
  const store = new MaskRevisionStore();
  const initialId = store.createInitial();
  const discarded = store.proposeStroke(initialId, strokeLike({ id: 50 }));
  store.discard(discarded);
  const next = store.proposeStroke(initialId, strokeLike());
  assert.ok(next.proposalId > discarded.proposalId);
  assert.equal(next.revision.strokeChunks[0][0].id, 51);
  assert.throws(() => store.proposeStroke(initialId, strokeLike({ id: 50 })), /already been used/);
});

test('complexity limits reject rather than raster-baking vector data', () => {
  const store = new MaskRevisionStore({ hardStrokes: 1, hardPointPairs: 2 });
  const initialId = store.createInitial();
  const first = store.commit(store.proposeStroke(initialId, strokeLike()));
  assert.throws(
    () => store.proposeStroke(first.revisionId, strokeLike()),
    (error) => error.code === 'MASK_COMPLEXITY_LIMIT',
  );
});

test('reachable byte accounting counts shared stroke buffers once and pruning honors roots', () => {
  const store = new MaskRevisionStore();
  const initialId = store.createInitial();
  const first = store.commit(store.proposeStroke(initialId, strokeLike()));
  const placement = store.commit(store.proposePlacement(first.revisionId, PLACEMENT_INSIDE));
  const second = store.commit(store.proposeStroke(placement.revisionId, strokeLike({
    points: new Float32Array([0.2, 0.2, 0.4, 0.4, 0.6, 0.6]),
  })));

  assert.equal(store.reachableBytes([first.revisionId, placement.revisionId]), 4 * 4);
  assert.equal(store.reachableBytes([first.revisionId, second.revisionId]), 4 * 4 + 6 * 4);
  const result = store.prune([second.revisionId]);
  assert.equal(store.has(second.revisionId), true);
  assert.equal(store.has(initialId), false);
  assert.equal(result.bytes, 40);
  assert.deepEqual(revisionStrokes(second).map((stroke) => stroke.id), [1, 2]);
});

test('capture decimation and source-pixel simplification preserve endpoints deterministically', () => {
  const noisyLine = new Float32Array([
    0, 0,
    0.1, 0.001,
    0.2, -0.001,
    0.3, 0,
    1, 0,
  ]);
  const simplified = simplifyStrokePoints(noisyLine, {
    sourceWidth: 100,
    sourceHeight: 100,
    tolerancePx: 0.2,
  });
  assert.deepEqual(Array.from(simplified), [0, 0, 1, 0]);

  const dense = new Float32Array([0, 0, 0.01, 0, 0.02, 0, 0.5, 0]);
  const decimated = decimateStrokeSamples(dense, {
    sourceWidth: 100,
    sourceHeight: 100,
    radiusShortNorm: 0.2,
  });
  assert.deepEqual(Array.from(decimated), [0, 0, 0.5, 0]);
});

test('createStroke copies and clamps caller point storage at the immutable boundary', () => {
  const points = new Float32Array([-1, 0.25, 2, 0.75]);
  const stroke = createStroke({ id: 1, ...strokeLike({ points }) });
  points[0] = 0.5;
  assert.deepEqual(Array.from(stroke.points), [0, 0.25, 1, 0.75]);
  assert.ok(Object.isFrozen(stroke));
});
