import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { ALGORITHMS } from '../js/engine/engine.js';
import { PALETTES } from '../js/palettes.js';
import { PRESETS } from '../js/presets.js';
import { MODES, applyParams, createState } from '../js/state.js';

const EXPECTED_PALETTE = ['#09060D', '#261137', '#653091', '#B8FF3D', '#F4F0DE'];
const MAIN_SOURCE = readFileSync(new URL('../js/main.js', import.meta.url), 'utf8');

const EXPECTED_PARAMS = {
  mode: 'dither',
  algorithm: 'bayer4',
  paletteId: 'command',
  pixelSize: 3,
  threshold: 0.47,
  contrast: 0.3,
  gamma: 0.92,
  saturation: 1.15,
  anim: { style: 'command', speed: 1.5, intensity: 0.82 },
  fx: { vignette: 0.22, scanlines: 0.26, grain: 0.1, chromatic: 1, glow: 0.18 },
};

test('Evangelion is one uniquely identified preset with the intended command look', () => {
  const matches = PRESETS.filter((preset) => preset.id === 'evangelion');
  assert.equal(matches.length, 1);
  assert.equal(matches[0].name, 'Evangelion');
  assert.deepEqual(matches[0].params, EXPECTED_PARAMS);

  const ids = PRESETS.map((preset) => preset.id);
  assert.equal(new Set(ids).size, ids.length, 'every preset id must remain unique');
});

test('Command Violet is a named palette with five valid colors', () => {
  const matches = PALETTES.filter((palette) => palette.id === 'command');
  assert.equal(matches.length, 1);
  assert.equal(matches[0].name, 'Command Violet');
  assert.deepEqual(matches[0].colors, EXPECTED_PALETTE);
  assert.ok(matches[0].colors.every((color) => /^#[0-9a-f]{6}$/i.test(color)));
});

test('Evangelion parameters reference supported controls and restrained effects', () => {
  const preset = PRESETS.find((candidate) => candidate.id === 'evangelion');
  assert.ok(MODES.some((mode) => mode.id === preset.params.mode));
  assert.ok(ALGORITHMS.some((algorithm) => algorithm.id === preset.params.algorithm));
  assert.ok(PALETTES.some((palette) => palette.id === preset.params.paletteId));
  assert.ok(preset.params.pixelSize >= 1 && preset.params.pixelSize <= 32);
  assert.ok(preset.params.threshold >= 0 && preset.params.threshold <= 1);
  assert.ok(preset.params.anim.speed >= 1 && preset.params.anim.speed <= 10);
  assert.ok(preset.params.anim.intensity >= 0 && preset.params.anim.intensity <= 1);

  for (const key of ['vignette', 'scanlines', 'grain', 'glow']) {
    assert.ok(preset.params.fx[key] >= 0 && preset.params.fx[key] <= 0.3, `${key} stays restrained`);
  }
  assert.ok(preset.params.fx.chromatic >= 0 && preset.params.fx.chromatic <= 2);
});

test('applying Evangelion safely merges nested defaults without sharing preset objects', () => {
  const preset = PRESETS.find((candidate) => candidate.id === 'evangelion');
  const definition = structuredClone(preset.params);
  const state = createState();

  applyParams(state, preset.params);

  assert.deepEqual(state.anim, {
    style: 'command',
    speed: 1.5,
    intensity: 0.82,
    direction: 'right',
    gravityMode: 'drizzle',
  });
  assert.equal(state.serpentine, true);
  state.anim.speed = 9;
  state.fx.glow = 0.9;
  assert.deepEqual(preset.params, definition, 'state edits must not mutate the preset definition');
});

test('palette-derived custom color arrays remain isolated when merged into state', () => {
  const command = PALETTES.find((palette) => palette.id === 'command');
  const colors = [...command.colors];
  const state = createState();

  applyParams(state, { customColors: colors });

  assert.notStrictEqual(state.customColors, colors);
  state.customColors[0] = '#FFFFFF';
  assert.equal(colors[0], '#09060D');
  assert.deepEqual(command.colors, EXPECTED_PALETTE);
});

test('Command live-frame cache is keyed to the Engine WebGL generation', () => {
  assert.match(
    MAIN_SOURCE,
    /liveProcessedCache\.glGeneration\s*===\s*engine\.glGeneration/,
    'cache validity must reject canvases cleared by WebGL context loss',
  );
  assert.match(
    MAIN_SOURCE,
    /glGeneration:\s*engine\.glGeneration/,
    'published borrowed frames must capture their WebGL generation',
  );
  assert.match(
    MAIN_SOURCE,
    /liveProcessedCache\.cpuCommitGeneration\s*===\s*\(engine\.cpu\?\.commitGeneration\s*\|\|\s*0\)/,
    'cache validity must reject mutable CPU canvases after a worker landing',
  );
  assert.match(
    MAIN_SOURCE,
    /cpuCommitGeneration:\s*engine\.cpu\?\.commitGeneration\s*\|\|\s*0/,
    'published borrowed CPU frames must capture their commit generation',
  );
});
