import test from 'node:test';
import assert from 'node:assert/strict';

import {
  advanceAnimationPhase,
  gravityAnimationSupported,
  oneShotExportPhase,
  postFXOnlyAnimation,
} from '../js/animation-policy.js';

test('Gravity support is intentionally limited to glyph-only ASCII stills', () => {
  assert.equal(gravityAnimationSupported({ mode: 'ascii', sourceType: 'image', colorMode: 'mono' }), true);
  assert.equal(gravityAnimationSupported({ mode: 'ascii', sourceType: 'image', colorMode: 'fg' }), true);
  assert.equal(gravityAnimationSupported({ mode: 'ascii', sourceType: 'image', colorMode: 'bg' }), false);
  assert.equal(gravityAnimationSupported({ mode: 'dither', sourceType: 'image', colorMode: 'mono' }), false);
  assert.equal(gravityAnimationSupported({ mode: 'ascii', sourceType: 'video', colorMode: 'mono' }), false);
});

test('loop phases wrap while one-shot phases clamp and stay finished', () => {
  assert.equal(advanceAnimationPhase(0.9, 0.2), 0.10000000000000009);
  assert.equal(advanceAnimationPhase(0.9, 0.2, { oneShot: true }), 1);
  assert.equal(advanceAnimationPhase(1, 0.2, { oneShot: true }), 1);
});

test('one-shot export remaps the final loop sample to the terminal frame', () => {
  const count = 60;
  assert.equal(oneShotExportPhase(0, count), 0);
  assert.equal(oneShotExportPhase((count - 1) / count, count), 1);
  assert.ok(oneShotExportPhase(0.5, count) > 0.5);
});

test('post-FX-only animations reuse the retained processed frame', () => {
  assert.equal(postFXOnlyAnimation('command'), true);
  assert.equal(postFXOnlyAnimation('fluted'), true);
  assert.equal(postFXOnlyAnimation('gravity'), false);
  assert.equal(postFXOnlyAnimation('wave'), false);
  assert.equal(postFXOnlyAnimation('none'), false);
});
