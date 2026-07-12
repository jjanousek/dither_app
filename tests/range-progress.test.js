import test from 'node:test';
import assert from 'node:assert/strict';

import { syncRangeProgress } from '../js/range-progress.js';

function range({ min = '0', max = '100', value = '0' } = {}) {
  const properties = new Map();
  let writes = 0;
  return {
    min,
    max,
    value,
    style: {
      getPropertyValue: (name) => properties.get(name) || '',
      setProperty: (name, next) => { writes++; properties.set(name, next); },
    },
    progress: () => properties.get('--p'),
    writes: () => writes,
  };
}

test('range progress maps nonzero minima and clamps to the visible track', () => {
  const brush = range({ min: '0.005', max: '0.4', value: '0.06' });
  assert.ok(Math.abs(syncRangeProgress(brush) - 13.9240506) < 1e-6);
  assert.equal(brush.progress(), '13.924');

  brush.value = '2';
  assert.equal(syncRangeProgress(brush), 100);
  assert.equal(brush.progress(), '100');

  brush.value = '-1';
  assert.equal(syncRangeProgress(brush), 0);
  assert.equal(brush.progress(), '0');
});

test('range progress avoids repeated style writes for unchanged playback values', () => {
  const seek = range({ min: '0', max: '1000', value: '800' });
  assert.equal(syncRangeProgress(seek), 80);
  assert.equal(seek.progress(), '80');
  assert.equal(seek.writes(), 1);
  syncRangeProgress(seek);
  assert.equal(seek.writes(), 1);
});
