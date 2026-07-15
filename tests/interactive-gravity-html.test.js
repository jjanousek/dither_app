import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildGravityHtml,
  MAX_INTERACTIVE_GRAVITY_BODIES,
} from '../js/export/exporters.js';
import { sampleGravityBody } from '../js/effects/ascii-gravity.js';

const grid = [
  [['1', 0xff00ff, null], [' ', 0xffffff, null], ['<', 0x00ff00, null]],
  [['0', 0x111111, null], ['1', 0xeeeeee, null], [' ', 0xffffff, null]],
];

function embeddedSpec(html) {
  const match = html.match(/const spec=(\{.*?\});const canvas=/s);
  assert.ok(match, 'the self-contained page embeds a JSON animation spec');
  return JSON.parse(match[1]);
}

test('interactive Gravity HTML is deterministic, self-contained, and excludes blank bodies', () => {
  const options = {
    intensity: 0.7,
    speed: 2,
    mode: 'cascade',
    title: '</title><script>alert(1)</script>',
  };
  const first = buildGravityHtml(grid, '#07080a', {
    family: 'Menlo, monospace',
    size: 14,
    bold: true,
  }, options);
  const repeat = buildGravityHtml(structuredClone(grid), '#07080a', {
    family: 'Menlo, monospace',
    size: 14,
    bold: true,
  }, options);

  assert.equal(first, repeat);
  assert.equal((first.match(/<script>/g) || []).length, 1, 'hostile title/glyph data cannot open another script');
  assert.ok(!first.includes('<script>alert(1)</script>'));

  const spec = embeddedSpec(first);
  assert.equal(spec.cols, 3);
  assert.equal(spec.rows, 2);
  assert.equal(spec.bodies.length, 4);
  assert.equal(spec.mode, 'cascade');
  assert.equal(spec.durationMs, 5100);
  assert.equal(spec.motionSeconds, 2.6);
  assert.ok(spec.bodies.every((body) => Number.isFinite(body.exitY) && body.exitY > spec.rows));
  assert.ok(spec.bodies.every((body) => !('floorY' in body) && !('restitution' in body)));
  assert.ok(spec.bodies.some((body) => body.glyph === '<'));
  assert.ok(first.includes(sampleGravityBody.toString()), 'export embeds the editor physics sampler verbatim');
});

test('interactive Gravity HTML normalizes legacy modes and shares profile pacing', () => {
  const spec = embeddedSpec(buildGravityHtml(grid, '#000', null, {
    speed: 3,
    mode: 'not-a-mode',
  }));

  assert.equal(spec.mode, 'drizzle');
  assert.equal(spec.durationMs, 4000);
});

test('interactive Gravity HTML rejects an unsafe visible-body count before building physics objects', () => {
  const dense = [Array.from({ length: MAX_INTERACTIVE_GRAVITY_BODIES + 1 }, () => ['1', 0xffffff, null])];
  assert.throws(
    () => buildGravityHtml(dense),
    new RegExp(`up to ${MAX_INTERACTIVE_GRAVITY_BODIES.toLocaleString('en-US')} visible glyphs`),
  );
});

test('interactive Gravity HTML supports pointer, keyboard, reduced motion, and host completion hooks', () => {
  const html = buildGravityHtml(grid);

  assert.match(html, /addEventListener\('click',start\)/);
  assert.match(html, /event\.key==='Enter'\|\|event\.key===' '/);
  assert.match(html, /prefers-reduced-motion: reduce/);
  assert.match(html, /<link rel="icon" href="data:,">/);
  assert.match(html, /Math\.min\(1,innerWidth\/logicalW,innerHeight\/logicalH\)/);
  assert.match(html, /CustomEvent\('ditherlab:complete'/);
  assert.match(html, /parent\.postMessage\(\{type:'ditherlab:complete'/);
  assert.match(html, /function frame\(now,id\)\{if\(id!==runId\)return/);
  assert.match(html, /function reset\(\)\{runId\+\+;running=false/);
  assert.match(html, /function replay\(\)\{reset\(\);start\(\)\}/);
  assert.match(html, /window\.DitherlabGravity=\{start,replay,reset\}/);
  assert.match(html, /spriteRaster=Math\.max\(cellW,cellH\)<18\?2:1/,
    'the standalone page supersamples only tiny glyph sprites');
  assert.match(html, /shape\.pixels>8000000&&spriteRaster>1\)\{spriteRaster=1/,
    'the standalone page drops supersampling before abandoning the sprite path');
  assert.match(html, /drawSprite\(indexed\.indices\[i\],p\.angle,x,y,p\.scale\)/,
    'the standalone page applies the shared airborne clarity scale');
});
