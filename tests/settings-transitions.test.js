import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createState,
  modeSizeRange,
  transitionAlgorithm,
  transitionMode,
} from '../js/state.js';

function changedPaths(before, after, prefix = '') {
  const paths = [];
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const path = prefix ? `${prefix}.${key}` : key;
    const a = before[key];
    const b = after[key];
    if (a && b && typeof a === 'object' && typeof b === 'object'
      && !Array.isArray(a) && !Array.isArray(b)) {
      paths.push(...changedPaths(a, b, path));
    } else if (JSON.stringify(a) !== JSON.stringify(b)) {
      paths.push(path);
    }
  }
  return paths.sort();
}

test('mode size ranges expose the renderer quality floors', () => {
  assert.deepEqual(modeSizeRange('dither'), { min: 1, max: 32, field: 'pixelSize' });
  assert.deepEqual(modeSizeRange('ascii'), { min: 4, max: 32, field: 'ascii.cellSize' });
  assert.deepEqual(modeSizeRange('dots'), { min: 3, max: 40, field: 'cells.size' });
  assert.deepEqual(modeSizeRange('lego'), { min: 4, max: 40, field: 'cells.size' });
  assert.deepEqual(modeSizeRange('lattice'), { min: 6, max: 40, field: 'cells.size' });
});

for (const [from, fromValue, to, expected] of [
  ['dither', 1, 'ascii', 4],
  ['ascii', 4, 'dither', 1],
  ['dots', 3, 'lattice', 6],
  ['lattice', 6, 'dots', 3],
  ['dots', 5, 'lattice', 6],
  ['dots', 8, 'lattice', 8],
  ['dots', 40, 'dither', 32],
  ['dither', 12, 'ascii', 12],
]) {
  test(`mode transition maps ${from} ${fromValue}px to ${to} ${expected}px`, () => {
    const state = createState();
    state.mode = from;
    if (from === 'dither') state.pixelSize = fromValue;
    else if (from === 'ascii') state.ascii.cellSize = fromValue;
    else state.cells.size = fromValue;
    transitionMode(state, to);
    const actual = to === 'dither'
      ? state.pixelSize
      : (to === 'ascii' ? state.ascii.cellSize : state.cells.size);
    assert.equal(actual, expected);
    assert.equal(state.mode, to);
  });
}

test('mode transition changes only mode and the destination size', () => {
  const state = createState();
  state.mode = 'dots';
  state.cells.size = 3;
  state.brightness = 0.22;
  state.fx.glow = 0.7;
  state.anim.style = 'flow';
  state.ascii.customChars = 'XYZ ';
  const before = structuredClone(state);

  transitionMode(state, 'ascii');

  assert.deepEqual(changedPaths(before, state), ['ascii.cellSize', 'mode']);
  assert.equal(state.brightness, 0.22);
  assert.equal(state.fx.glow, 0.7);
  assert.equal(state.anim.style, 'flow');
  assert.equal(state.ascii.customChars, 'XYZ ');
});

test('algorithm transition preserves every setting except the algorithm id', () => {
  const state = createState();
  state.pixelSize = 1;
  state.smoothness = 0.37;
  state.temporal = 0.42;
  state.videoDenoise = 0.18;
  state.halftoneScale = 2;
  state.anim.style = 'flow';
  const before = structuredClone(state);

  transitionAlgorithm(state, 'bluenoise');

  assert.deepEqual(changedPaths(before, state), ['algorithm']);
  assert.equal(state.pixelSize, 1);
  assert.equal(state.smoothness, 0.37);
  assert.equal(state.temporal, 0.42);
  assert.equal(state.videoDenoise, 0.18);
  assert.equal(state.halftoneScale, 2);
  assert.equal(state.anim.style, 'flow');
});
