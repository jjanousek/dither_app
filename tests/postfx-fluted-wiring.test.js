import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const POSTFX_SOURCE = readFileSync(new URL('../js/effects/postfx.js', import.meta.url), 'utf8');
const MAIN_SOURCE = readFileSync(new URL('../js/main.js', import.meta.url), 'utf8');
const UI_SOURCE = readFileSync(new URL('../js/ui.js', import.meta.url), 'utf8');
const APPLY_SOURCE = POSTFX_SOURCE.slice(
  POSTFX_SOURCE.indexOf('export function applyPostFX'),
  POSTFX_SOURCE.indexOf('export function estimatePostFXBytes'),
);

class FakeContext {
  createImageData(width, height) {
    return { data: new Uint8ClampedArray(width * height * 4), width, height };
  }

  putImageData() {}
}

class FakeCanvas {
  constructor() {
    this.width = 0;
    this.height = 0;
    this.context = new FakeContext();
  }

  getContext(kind) {
    return kind === '2d' ? this.context : null;
  }
}

globalThis.document = { createElement: () => new FakeCanvas() };

const {
  constrainPostFXDimensions,
  estimatePostFXBytes,
} = await import('../js/effects/postfx.js');

test('Fluted glass is a positive-intensity Post-FX animation with a strict inactive fast path', () => {
  assert.match(
    POSTFX_SOURCE,
    /opts\?\.animationStyle\s*===\s*'fluted'[\s\S]*?animationIntensity[^\n]*>\s*0/,
  );
  assert.match(
    POSTFX_SOURCE,
    /return fxEnabled\(fx\) \|\| commandSequenceEnabled\(opts\) \|\| flutedGlassEnabled\(opts\)/,
  );
  assert.match(
    APPLY_SOURCE,
    /chromatic <= 0 && glow <= 0 && !commandSequence && !flutedGlass\)\s*\{\s*return srcCanvas;/,
  );
});

test('Fluted glass renders before every existing Post-FX stage', () => {
  const calls = [
    'renderFlutedGlass(srcCanvas',
    'drawChromatic(baseCanvas',
    'drawCommandSequence(outCtx',
    'if (glow > 0) drawGlow',
    'if (grain > 0) drawGrain',
    'if (scanlines > 0) drawScanlines',
    'if (vignette > 0) drawVignette',
  ].map((call) => APPLY_SOURCE.indexOf(call));

  assert.ok(calls.every((index) => index >= 0), 'every stage call remains present');
  assert.deepEqual([...calls].sort((a, b) => a - b), calls, 'stage order is optical then Canvas2D');
});

test('Fluted glass participates in Post-FX memory accounting and teardown', () => {
  assert.match(
    POSTFX_SOURCE,
    /flutedGlassEnabled\(opts\)\) bytes \+= estimateFlutedGlassBytes\(width, height\)/,
  );
  assert.match(
    POSTFX_SOURCE,
    /export function releasePostFXBuffers\(\) \{\s*releaseFlutedGlass\(\);/,
  );
  assert.match(
    POSTFX_SOURCE,
    /export function trimPostFXBuffers[\s\S]*?if \(!flutedGlass\) releaseFlutedGlass\(\);/,
  );
  assert.match(
    MAIN_SOURCE,
    /onChange:[\s\S]*?trimInactivePostFXBuffers\(\);[\s\S]*?frameBundles\.invalidate\('effect change'/,
  );
  assert.match(
    MAIN_SOURCE,
    /trimPostFXBuffers\(state\.fx, requestedAnimationPostFXOptions\(\)\)/,
  );
});

test('Unavailable or lost WebGL2 makes Fluted a true paused no-op', () => {
  assert.match(
    MAIN_SOURCE,
    /options\.animationStyle === 'fluted'[\s\S]*?!isFlutedGlassSupported\(\)[\s\S]*?options\.animationIntensity = 0/,
  );
  assert.match(
    MAIN_SOURCE,
    /defer: isAnimating\(\) && postFXOnlyAnimation\(state\.anim\.style\)/,
  );
  assert.match(
    MAIN_SOURCE,
    /const postFXFinal = !maskedExport\s*&& isAnimating\(\)\s*&& postFXOnlyAnimation\(state\.anim\.style\)/,
  );
  assert.match(
    MAIN_SOURCE,
    /state\.anim\.style === 'fluted' && isAnimating\(\)\) return 850_000/,
  );
  assert.match(UI_SOURCE, /Fluted glass — unavailable/);
  assert.match(UI_SOURCE, /Fluted glass is unavailable because WebGL 2 is not available/);
});

test('Post-FX dimension constraints preserve in-bounds exports and identify geometric caps', () => {
  assert.deepEqual(
    constrainPostFXDimensions(1920, 1080, null, {}, {
      maxSide: 4096,
      maxArea: 20_000_000,
      maxBytes: 500_000_000,
    }),
    { width: 1920, height: 1080, capped: false, reason: null },
  );

  const bySide = constrainPostFXDimensions(8000, 4000, null, {}, {
    maxSide: 4096,
  });
  assert.deepEqual(bySide, { width: 4096, height: 2048, capped: true, reason: 'side' });
  assert.ok(Math.max(bySide.width, bySide.height) <= 4096);

  const byArea = constrainPostFXDimensions(4000, 2000, null, {}, {
    maxArea: 2_000_000,
  });
  assert.deepEqual(byArea, { width: 2000, height: 1000, capped: true, reason: 'area' });
  assert.ok(byArea.width * byArea.height <= 2_000_000);
});

test('Post-FX dimension constraints binary-search the real fluted working-byte estimate', () => {
  const fx = {};
  const opts = { animationStyle: 'fluted', animationIntensity: 1 };
  const maxBytes = 70_000_000;
  const result = constrainPostFXDimensions(4000, 2000, fx, opts, { maxBytes });
  const bytes = result.width * result.height * 12
    + estimatePostFXBytes(result.width, result.height, fx, opts);

  assert.equal(result.capped, true);
  assert.equal(result.reason, 'memory');
  assert.ok(bytes <= maxBytes, `${bytes} must stay within ${maxBytes}`);
  assert.ok(bytes > maxBytes * 0.99, 'binary search should use nearly all safe working memory');
  assert.ok(Math.abs(result.width / result.height - 2) < 0.002, 'aspect ratio is retained');
});

test('Post-FX dimension constraints honor custom base storage and reject impossible budgets', () => {
  assert.deepEqual(
    constrainPostFXDimensions(1000, 1000, null, {}, {
      maxBytes: 5_000_000,
      baseBytesPerPixel: 4,
    }),
    { width: 1000, height: 1000, capped: false, reason: null },
  );

  const defaultBase = constrainPostFXDimensions(1000, 1000, null, {}, {
    maxBytes: 5_000_000,
  });
  assert.equal(defaultBase.reason, 'memory');
  assert.ok(defaultBase.width * defaultBase.height * 12 <= 5_000_000);

  assert.throws(
    () => constrainPostFXDimensions(100, 100, {}, {
      animationStyle: 'fluted',
      animationIntensity: 1,
    }, { maxBytes: 27 }),
    /too small for the minimum Post-FX working set/,
  );
});
