import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ASCII_GRAVITY_DURATION_SECONDS,
  DEFAULT_GRAVITY_MODE,
  GRAVITY_MODE_PROFILES,
  createGravityLayout,
  gravityDurationSeconds,
  gravityLayoutSignature,
  isGravityGlyph,
  normalizeGravityMode,
  sampleGravityBody,
  sampleGravityLayout,
} from '../js/effects/ascii-gravity.js';

const grid = [
  [['1', 0xff00ff, null], [' ', 0xff00ff, null], ['0', 0x00ffff, null]],
  [['0', 0xff00ff, null], ['1', 0x00ffff, null], ['1', 0xff00ff, null]],
  [[' ', 0xff00ff, null], ['0', 0x00ffff, null], ['1', 0xff00ff, null]],
];

const modes = ['drizzle', 'cascade', 'flutter', 'collapse'];

function denseGrid(cols = 64, rows = 20) {
  return Array.from({ length: rows }, (_, row) => Array.from({ length: cols }, (_, col) => [
    (row + col) & 1 ? '1' : '0',
    0xffffff,
    null,
  ]));
}

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

test('gravity modes expose immutable metadata, normalization, and shared playback durations', () => {
  assert.equal(DEFAULT_GRAVITY_MODE, 'drizzle');
  assert.deepEqual(Object.keys(GRAVITY_MODE_PROFILES), modes);
  assert.ok(Object.isFrozen(GRAVITY_MODE_PROFILES));
  assert.ok(modes.every((mode) => Object.isFrozen(GRAVITY_MODE_PROFILES[mode])));

  assert.equal(normalizeGravityMode(' CASCADE '), 'cascade');
  assert.equal(normalizeGravityMode('unknown'), DEFAULT_GRAVITY_MODE);
  assert.equal(normalizeGravityMode(null), DEFAULT_GRAVITY_MODE);

  assert.equal(gravityDurationSeconds(3), 4);
  assert.equal(gravityDurationSeconds(3, 'cascade'), 3.4);
  assert.equal(gravityDurationSeconds(3, 'flutter'), 4.8);
  assert.equal(gravityDurationSeconds(3, 'collapse'), 3);
  assert.equal(gravityDurationSeconds(6, 'drizzle'), 2);
  assert.equal(gravityDurationSeconds(0, 'drizzle'), 12, 'pace is clamped to its UI minimum');
  assert.equal(gravityDurationSeconds(20, 'drizzle'), 1.2, 'pace is clamped to its UI maximum');
  assert.equal(gravityDurationSeconds(NaN, 'missing'), 4, 'invalid values use default pace and mode');
});

test('gravity layout excludes blank cells and has a stable content signature', () => {
  const first = createGravityLayout(grid, { cols: 3, rows: 3, intensity: 0.7 });
  const second = createGravityLayout(structuredClone(grid), { cols: 3, rows: 3, intensity: 0.7 });

  assert.equal(first.bodies.length, 7);
  assert.ok(first.bodies.every((body) => Number.isFinite(body.exitY) && body.exitY > first.rows));
  assert.equal(first.signature, second.signature);
  assert.equal(first.signature, gravityLayoutSignature(grid, { cols: 3, rows: 3, intensity: 0.7 }));
  assert.equal(isGravityGlyph(' '), false);
  assert.equal(isGravityGlyph('\u2800'), false, 'blank Braille cells are not invisible bodies');
  assert.equal(isGravityGlyph('0'), true);
  assert.equal(isGravityGlyph('1'), true);

  const changed = structuredClone(grid);
  changed[0][0][0] = '0';
  assert.notEqual(first.signature, gravityLayoutSignature(changed, { cols: 3, rows: 3, intensity: 0.7 }));
});

test('mode is deterministic, participates in signatures, and unknown values fall back to drizzle', () => {
  const signatures = new Set();
  for (const mode of modes) {
    const options = { cols: 3, rows: 3, intensity: 0.7, mode };
    const first = createGravityLayout(grid, options);
    const repeat = createGravityLayout(structuredClone(grid), options);
    assert.equal(first.mode, mode);
    assert.equal(first.signature, repeat.signature);
    assert.deepEqual(first.bodies, repeat.bodies);
    assert.equal(first.signature, gravityLayoutSignature(grid, options));
    signatures.add(first.signature);
  }
  assert.equal(signatures.size, modes.length, 'a mode change invalidates retained layout constants');

  const fallback = createGravityLayout(grid, { cols: 3, rows: 3, intensity: 0.7, mode: 'nope' });
  const drizzle = createGravityLayout(grid, { cols: 3, rows: 3, intensity: 0.7, mode: 'drizzle' });
  assert.equal(fallback.mode, 'drizzle');
  assert.equal(fallback.signature, drizzle.signature);
  assert.deepEqual(fallback.bodies, drizzle.bodies);
});

test('profiles produce distinct release ordering, weight, drift, and spin without per-frame randomness', () => {
  const source = denseGrid();
  const layouts = Object.fromEntries(modes.map((mode) => [
    mode,
    createGravityLayout(source, { cols: 64, rows: 20, intensity: 0.6, mode }),
  ]));
  const average = (mode, field) => mean(layouts[mode].bodies.map((body) => Math.abs(body[field])));
  const rowMean = (mode, row) => mean(layouts[mode].bodies
    .filter((body) => body.row === row)
    .map((body) => body.releaseAt));

  assert.ok(layouts.collapse.bodies[0].gravity > layouts.cascade.bodies[0].gravity);
  assert.ok(layouts.cascade.bodies[0].gravity > layouts.drizzle.bodies[0].gravity);
  assert.ok(layouts.drizzle.bodies[0].gravity > layouts.flutter.bodies[0].gravity);
  assert.ok(average('flutter', 'vx') > average('drizzle', 'vx'));
  assert.ok(average('drizzle', 'vx') > average('cascade', 'vx'));
  assert.ok(average('flutter', 'omega') > average('drizzle', 'omega'));
  assert.ok(average('drizzle', 'omega') > average('cascade', 'omega'));
  assert.ok(rowMean('cascade', 19) > rowMean('cascade', 0), 'cascade releases top to bottom');
  assert.ok(rowMean('collapse', 19) < rowMean('collapse', 0), 'collapse releases bottom first');

  assert.ok(layouts.drizzle.bodies.every((body) => body.horizontalDrag === 1.5));
  assert.ok(layouts.cascade.bodies.every((body) => body.horizontalDrag === 2.2));
  assert.ok(layouts.flutter.bodies.every((body) => body.horizontalDrag === 0.35));
  assert.ok(layouts.collapse.bodies.every((body) => body.horizontalDrag === 2.8));

  for (const mode of modes) {
    const layout = layouts[mode];
    const direct = sampleGravityLayout(layout, 0.57);
    sampleGravityLayout(layout, 0.13);
    sampleGravityLayout(layout, 0.91);
    assert.deepEqual(sampleGravityLayout(layout, 0.57), direct);
  }
});

test('phase zero preserves every glyph exactly and sampling is deterministic', () => {
  for (const mode of modes) {
    const layout = createGravityLayout(grid, { cols: 3, rows: 3, intensity: 0.6, mode });
    const first = sampleGravityLayout(layout, 0);
    const repeat = sampleGravityLayout(layout, 0);

    assert.deepEqual(first, repeat);
    for (const pose of first) {
      assert.equal(pose.x, pose.body.x0);
      assert.equal(pose.y, pose.body.y0);
      assert.equal(pose.angle, 0);
      assert.equal(pose.scale, 1);
      assert.equal(pose.opacity, 1);
      assert.equal(pose.released, false);
    }
  }
});

test('falling glyphs grow for clarity, stay nearly upright, and remain legible until off-screen', () => {
  for (const mode of modes) {
    const layout = createGravityLayout(grid, { cols: 3, rows: 3, intensity: 0.8, mode });
    const body = layout.bodies.find((candidate) => candidate.row === 0);
    const airborneElapsed = 0.2;
    const airbornePhase = (body.releaseAt + airborneElapsed) / ASCII_GRAVITY_DURATION_SECONDS;
    const airborne = sampleGravityBody({
      ...body,
      omega: 100,
      angularDrag: 0.1,
    }, airbornePhase);

    assert.equal(airborne.released, true);
    assert.ok(airborne.scale > 1, `${mode} should enlarge an airborne glyph`);
    assert.ok(airborne.scale <= body.flightScale + 1e-9);
    assert.ok(Math.abs(airborne.angle) <= body.rotationLimit + 1e-9,
      `${mode} should clamp visual tumble`);

    const exitElapsed = Math.sqrt((2 * (body.exitY - body.y0)) / body.gravity);
    const inside = sampleGravityBody(
      body,
      (body.releaseAt + exitElapsed - 0.001) / ASCII_GRAVITY_DURATION_SECONDS,
    );
    const outside = sampleGravityBody(
      body,
      (body.releaseAt + exitElapsed + 0.001) / ASCII_GRAVITY_DURATION_SECONDS,
    );
    assert.equal(inside.opacity, 1, `${mode} should stay opaque until fully off-screen`);
    assert.equal(inside.exited, false);
    assert.equal(outside.opacity, 0, `${mode} should disappear only beyond the exit boundary`);
    assert.equal(outside.exited, true);
  }
});

test('seeded releases are staggered instead of dropping as one sheet', () => {
  const layout = createGravityLayout(grid, { cols: 3, rows: 3, intensity: 0.8 });
  const releases = layout.bodies.map((body) => body.releaseAt);
  assert.ok(new Set(releases.map((value) => value.toFixed(6))).size > 4);

  const probeTime = releases.slice().sort((a, b) => a - b)[2] + 0.001;
  const phase = probeTime / ASCII_GRAVITY_DURATION_SECONDS;
  const poses = sampleGravityLayout(layout, phase);
  const moving = poses.filter((pose) => pose.released).length;
  assert.ok(moving > 0 && moving < poses.length);
});

test('released glyphs accelerate continuously through the bottom without bouncing or piling', () => {
  const layout = createGravityLayout(grid, { cols: 3, rows: 3, intensity: 0.65 });
  const body = layout.bodies.find((candidate) => candidate.row === 0);
  const releasePhase = body.releaseAt / ASCII_GRAVITY_DURATION_SECONDS;
  const early = sampleGravityBody(body, releasePhase + 0.04);
  const later = sampleGravityBody(body, releasePhase + 0.08);
  const beyondElapsed = Math.sqrt((2 * (body.exitY + 0.5 - body.y0)) / body.gravity);
  const beyond = sampleGravityBody(
    body,
    (body.releaseAt + beyondElapsed) / ASCII_GRAVITY_DURATION_SECONDS,
  );

  const firstDrop = early.y - body.y0;
  const secondDrop = later.y - early.y;
  assert.ok(firstDrop > 0);
  assert.ok(secondDrop > firstDrop, 'equal phase intervals should cover more distance under gravity');
  assert.ok(beyond.y > body.exitY, 'motion continues below the visible frame');
  assert.equal(beyond.opacity, 0);
  assert.equal(beyond.exited, true);
  assert.equal('floorY' in body, false);
  assert.equal('restitution' in body, false);
  assert.equal('impactAt' in body, false);
  assert.ok(Number.isFinite(beyond.x));
  assert.ok(Number.isFinite(beyond.angle));
});

test('sampler reuses its output object and old bodies retain the legacy horizontal drag', () => {
  const body = createGravityLayout(grid, {
    cols: 3,
    rows: 3,
    intensity: 0.65,
    mode: 'flutter',
  }).bodies.find((candidate) => candidate.row === 0);
  const phase = (body.releaseAt + 0.2) / ASCII_GRAVITY_DURATION_SECONDS;
  const out = {};
  assert.equal(sampleGravityBody(body, phase, out), out);

  const legacy = { ...body };
  delete legacy.horizontalDrag;
  const explicitLegacy = { ...legacy, horizontalDrag: 0.7 };
  assert.deepEqual(sampleGravityBody(legacy, phase), sampleGravityBody(explicitLegacy, phase));

  const lowDrag = sampleGravityBody({ ...body, horizontalDrag: 0.2 }, phase);
  const highDrag = sampleGravityBody({ ...body, horizontalDrag: 3 }, phase);
  assert.ok(Math.abs(lowDrag.x - body.x0) > Math.abs(highDrag.x - body.x0));
});

test('the one-shot endpoint clears all glyphs and a replay reproduces frame zero', () => {
  for (const mode of modes) {
    const layout = createGravityLayout(grid, { cols: 3, rows: 3, intensity: 0.6, mode });
    const end = sampleGravityLayout(layout, 1);
    const replay = sampleGravityLayout(layout, 0);

    assert.ok(end.every((pose) => pose.opacity === 0 && pose.exited));
    assert.ok(replay.every((pose) => pose.opacity === 1 && pose.x === pose.body.x0 && pose.y === pose.body.y0));
  }
});

test('absolute phase sampling is independent of frame cadence and remains linear in body count', () => {
  const dense = denseGrid(80, 45);
  const layout = createGravityLayout(dense, { cols: 80, rows: 45, intensity: 0.75 });
  assert.equal(layout.bodies.length, 3600);

  const direct = sampleGravityLayout(layout, 0.57);
  for (let frame = 0; frame <= 34; frame++) sampleGravityLayout(layout, frame / 60);
  const afterSixtyFpsWalk = sampleGravityLayout(layout, 0.57);
  for (let frame = 0; frame <= 17; frame++) sampleGravityLayout(layout, frame / 30);
  const afterThirtyFpsWalk = sampleGravityLayout(layout, 0.57);

  assert.deepEqual(afterSixtyFpsWalk, direct);
  assert.deepEqual(afterThirtyFpsWalk, direct);
});
