import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  COMMAND_SEQUENCE_COLORS,
  commandSequenceState,
  drawCommandSequence,
} from '../js/effects/command-sequence.js';

class FakeContext {
  constructor(canvas = null) {
    this.canvas = canvas;
    this.calls = [];
    this.depth = 0;
  }

  record(name, args = []) {
    this.calls.push([name, ...args]);
  }

  save() { this.depth++; this.record('save'); }
  restore() { this.depth--; this.record('restore'); }
  setTransform(...args) { this.record('setTransform', args); }
  drawImage(...args) { this.record('drawImage', args); }
  fillRect(...args) { this.record('fillRect', args); }
  beginPath() { this.record('beginPath'); }
  closePath() { this.record('closePath'); }
  moveTo(...args) { this.record('moveTo', args); }
  lineTo(...args) { this.record('lineTo', args); }
  stroke() { this.record('stroke'); }
  fill() { this.record('fill'); }
  fillText(...args) { this.record('fillText', args); }
  translate(...args) { this.record('translate', args); }
  rotate(...args) { this.record('rotate', args); }
}

class FakeCanvas {
  constructor(width = 0, height = 0) {
    this.width = width;
    this.height = height;
    this.context = new FakeContext(this);
    this.getContextCalls = 0;
  }

  getContext(kind) {
    this.getContextCalls++;
    assert.equal(kind, '2d');
    return this.context;
  }
}

function makeRig(width = 1280, height = 720) {
  const destination = new FakeCanvas(width, height);
  const source = { width, height, id: 'source' };
  const scratch = new FakeCanvas();
  return { context: destination.context, destination, source, scratch };
}

function assertFiniteTree(value) {
  if (typeof value === 'number') {
    assert.ok(Number.isFinite(value), `expected a finite value, received ${value}`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach(assertFiniteTree);
    return;
  }
  if (value && typeof value === 'object') Object.values(value).forEach(assertFiniteTree);
}

test('command state is deterministic and phase 1 closes exactly onto phase 0', () => {
  const zero = commandSequenceState(0, 0.82, 1920, 1080);
  const repeat = commandSequenceState(0, 0.82, 1920, 1080);
  assert.deepEqual(repeat, zero);
  assert.deepEqual(commandSequenceState(1, 0.82, 1920, 1080), zero);
  assert.deepEqual(commandSequenceState(4, 0.82, 1920, 1080), zero);
  assert.deepEqual(commandSequenceState(-1, 0.82, 1920, 1080), zero);

  const wrapped = commandSequenceState(1.25, 0.82, 1920, 1080);
  assert.deepEqual(wrapped, commandSequenceState(0.25, 0.82, 1920, 1080));
});

test('malformed inputs are clamped to finite, bounded state', () => {
  const invalid = commandSequenceState(NaN, Infinity, -20, 'not-a-height');
  assert.equal(invalid.phase, 0);
  assert.equal(invalid.intensity, 0);
  assert.equal(invalid.width, 1);
  assert.equal(invalid.height, 1);
  assertFiniteTree(invalid);

  const clamped = commandSequenceState(-0.25, 8, 1e9, 800.4);
  assert.equal(clamped.phase, 0.75);
  assert.equal(clamped.intensity, 1);
  assert.equal(clamped.width, 32768);
  assert.equal(clamped.height, 800);
  assertFiniteTree(clamped);
});

test('landscape, portrait, and thumbnail layouts stay responsive with three fixed signal bands', () => {
  const landscape = commandSequenceState(0, 1, 1920, 1080);
  const portrait = commandSequenceState(0, 1, 720, 1280);
  const compact = commandSequenceState(0, 1, 192, 120);

  assert.equal(landscape.portrait, false);
  assert.equal(landscape.compact, false);
  assert.equal(portrait.portrait, true);
  assert.equal(portrait.compact, true);
  assert.ok(portrait.bracket.width / portrait.width > landscape.bracket.width / landscape.width);
  assert.ok(portrait.rail.y < portrait.height - portrait.safe);
  assert.equal(compact.compact, true);
  assert.equal(landscape.slices.length, 3);
  assert.equal(portrait.slices.length, 3);
  assert.equal(compact.slices.length, 3);

  for (const state of [landscape, portrait, compact]) {
    assert.ok(state.bracket.x >= 0 && state.bracket.x + state.bracket.width <= state.width);
    assert.ok(state.bracket.y >= 0 && state.bracket.y + state.bracket.height <= state.height);
    assert.ok(state.rail.x >= 0 && state.rail.x + state.rail.width <= state.width);
    assert.ok(state.rail.y >= 0 && state.rail.y + state.rail.height <= state.height);
  }
});

test('alert and displacement beats occupy their intended bounded phase windows', () => {
  const quiet = commandSequenceState(0.32, 1, 1280, 720);
  assert.equal(quiet.alert.level, 0);
  assert.ok(quiet.slices.every((slice) => !slice.active));

  const firstGlitch = commandSequenceState(0.215, 1, 1280, 720);
  assert.ok(firstGlitch.slices[0].dx > 0);
  assert.ok(firstGlitch.slices[1].dx < 0);
  assert.equal(firstGlitch.slices[2].dx, 0);

  const alert = commandSequenceState(0.525, 1, 1280, 720);
  assert.ok(alert.alert.level > 0.9);
  assert.ok(alert.slices.every((slice) => !slice.active));

  const echoGlitch = commandSequenceState(0.7675, 1, 1280, 720);
  assert.equal(echoGlitch.slices[0].dx, 0);
  assert.equal(echoGlitch.slices[1].dx, 0);
  assert.ok(echoGlitch.slices[2].dx > 0);
});

test('intensity zero is a strict no-op and does not even request scratch context', () => {
  const { context, source, scratch } = makeRig();
  const state = drawCommandSequence(context, source, scratch, {
    phase: 0.5,
    intensity: 0,
  });
  assert.equal(state.intensity, 0);
  assert.deepEqual(context.calls, []);
  assert.equal(scratch.getContextCalls, 0);
  assert.deepEqual(scratch.context.calls, []);
});

test('quiet frames draw the technical overlay without copying the source', () => {
  const { context, source, scratch } = makeRig();
  const state = drawCommandSequence(context, source, scratch, {
    phase: 0,
    intensity: 0.82,
  });

  assert.equal(state.phase, 0);
  assert.equal(context.depth, 0);
  assert.equal(context.calls[0][0], 'save');
  assert.equal(context.calls.at(-1)[0], 'restore');
  assert.equal(scratch.getContextCalls, 0);
  assert.equal(context.calls.filter(([name]) => name === 'drawImage').length, 0);
  assert.ok(context.calls.some(([name]) => name === 'stroke'));
  assert.ok(context.calls.some(([name, text]) => name === 'fillText' && text === 'DITHERLAB'));
  assert.ok(context.calls.some(([name, text]) => name === 'fillText' && text.startsWith('SIGNAL LOCK')));
});

test('glitch frames copy once to reusable scratch and wrap each active slice with two blits', () => {
  const { context, source, scratch } = makeRig(1280, 720);
  const state = drawCommandSequence(context, source, scratch, {
    phase: 0.215,
    intensity: 1,
  });
  const active = state.slices.filter((slice) => slice.active).length;
  assert.equal(active, 2);
  assert.equal(scratch.width, 1280);
  assert.equal(scratch.height, 720);
  assert.equal(scratch.getContextCalls, 1);
  assert.equal(scratch.context.calls.filter(([name]) => name === 'drawImage').length, 1);
  assert.strictEqual(scratch.context.calls.find(([name]) => name === 'drawImage')[1], source);
  assert.equal(context.calls.filter(([name]) => name === 'drawImage').length, active * 2);
  assert.ok(context.calls.filter(([name]) => name === 'drawImage')
    .every(([, canvas]) => canvas === scratch));
  assert.equal(scratch.context.depth, 0);
  assert.equal(context.depth, 0);
});

test('alert beat uses the original alarm treatment and full-size status typography', () => {
  const { context, source, scratch } = makeRig();
  const state = drawCommandSequence(context, source, scratch, {
    phase: 0.525,
    intensity: 1,
  });
  assert.ok(state.alert.level > 0.9);
  assert.ok(context.calls.some(([name, text]) => name === 'fillText' && text === 'SIGNAL LOCK'));
  assert.ok(context.calls.some(([name, text]) => name === 'fillText' && text.includes('STATE ACTIVE')));
  assert.equal(COMMAND_SEQUENCE_COLORS.alarm, '#ff4f1f');
  assert.equal(COMMAND_SEQUENCE_COLORS.signal, '#b8ff3d');
  assert.equal(COMMAND_SEQUENCE_COLORS.paper, '#f4f0de');
});

test('compact frames replace microtype with fixed geometry but keep the Ditherlab identifier', () => {
  const { context, source, scratch } = makeRig(192, 120);
  const state = drawCommandSequence(context, source, scratch, {
    phase: 0.525,
    intensity: 1,
  });
  const labels = context.calls.filter(([name]) => name === 'fillText').map(([, text]) => text);
  assert.equal(state.compact, true);
  assert.deepEqual(labels, ['DITHERLAB']);
  assert.ok(context.calls.filter(([name]) => name === 'fillRect').length >= 20);
});

test('primitive work stays bounded and independent of output resolution', () => {
  const small = makeRig(1280, 720);
  const large = makeRig(3840, 2160);
  drawCommandSequence(small.context, small.source, small.scratch, { phase: 0, intensity: 1 });
  drawCommandSequence(large.context, large.source, large.scratch, { phase: 0, intensity: 1 });

  const names = (context) => context.calls.map(([name]) => name);
  assert.deepEqual(names(large.context), names(small.context));
  assert.ok(large.context.calls.length < 80, 'overlay work must not scale with pixel count');
});

test('caller context is restored if overlay drawing throws', () => {
  const { context, source, scratch } = makeRig();
  context.fillRect = (...args) => {
    context.record('fillRect', args);
    throw new Error('paint failed');
  };
  assert.throws(
    () => drawCommandSequence(context, source, scratch, { phase: 0, intensity: 1 }),
    /paint failed/,
  );
  assert.equal(context.depth, 0);
  assert.equal(context.calls.at(-1)[0], 'restore');
});

test('drawing inputs are validated only when the effect is visible', () => {
  assert.doesNotThrow(() => drawCommandSequence(null, null, null, { intensity: 0 }));
  assert.throws(() => drawCommandSequence(null, {}, {}, { intensity: 1 }), /Canvas2D context/);

  const rig = makeRig();
  assert.throws(
    () => drawCommandSequence(rig.context, rig.source, rig.destination, { intensity: 1 }),
    /scratch canvas must be separate/,
  );
});

test('implementation creates no canvas, reads no pixels, and uses no random source', async () => {
  const source = await readFile(new URL('../js/effects/command-sequence.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /document\.createElement|new\s+OffscreenCanvas|getImageData/);
  assert.doesNotMatch(source, /Math\.random/);
});
