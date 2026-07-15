import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FlutedGlassRenderer,
  estimateFlutedGlassBytes,
  flutedRibCount,
  isFlutedGlassSupported,
  normalizeFlutedGlassPhase,
  releaseFlutedGlass,
  renderFlutedGlass,
} from '../js/effects/fluted-glass.js';

class FakeGL {
  constructor() {
    const names = [
      'VERTEX_SHADER', 'FRAGMENT_SHADER', 'COMPILE_STATUS', 'LINK_STATUS',
      'TEXTURE0', 'TEXTURE_2D', 'TEXTURE_MIN_FILTER', 'TEXTURE_MAG_FILTER',
      'TEXTURE_WRAP_S', 'TEXTURE_WRAP_T', 'LINEAR', 'CLAMP_TO_EDGE',
      'UNPACK_FLIP_Y_WEBGL', 'UNPACK_PREMULTIPLY_ALPHA_WEBGL', 'RGBA8',
      'RGBA', 'UNSIGNED_BYTE', 'BLEND', 'TRIANGLES',
    ];
    names.forEach((name, index) => { this[name] = index + 1; });
    this.createdShaders = 0;
    this.createdPrograms = 0;
    this.createdTextures = 0;
    this.deletedPrograms = 0;
    this.deletedTextures = 0;
    this.textureAllocations = 0;
    this.sourceUploads = 0;
    this.draws = 0;
    this.uniformValues = new Map();
    this.shaderSources = [];
    this.contextLost = false;
  }

  createShader() { this.createdShaders++; return {}; }
  shaderSource(_shader, source) { this.shaderSources.push(source); }
  compileShader() {}
  getShaderParameter() { return true; }
  getShaderInfoLog() { return ''; }
  deleteShader() {}
  createProgram() { this.createdPrograms++; return {}; }
  attachShader() {}
  linkProgram() {}
  getProgramParameter() { return true; }
  getProgramInfoLog() { return ''; }
  deleteProgram() { this.deletedPrograms++; }
  useProgram() {}
  createTexture() { this.createdTextures++; return {}; }
  deleteTexture() { this.deletedTextures++; }
  activeTexture() {}
  bindTexture() {}
  texParameteri() {}
  pixelStorei() {}
  texImage2D() { this.textureAllocations++; }
  texSubImage2D() { this.sourceUploads++; }
  getUniformLocation(_program, name) { return name; }
  uniform1i(location, value) { this.uniformValues.set(location, value); }
  uniform1f(location, value) { this.uniformValues.set(location, value); }
  uniform2f(location, x, y) { this.uniformValues.set(location, [x, y]); }
  disable() {}
  viewport() {}
  drawArrays() { this.draws++; }
  isContextLost() { return this.contextLost; }
}

class FakeCanvas {
  constructor(gl = new FakeGL()) {
    this.width = 0;
    this.height = 0;
    this.gl = gl;
    this.listeners = new Map();
    this.contextOptions = null;
  }

  getContext(kind, options = null) {
    this.contextOptions = options;
    return kind === 'webgl2' ? this.gl : null;
  }
  addEventListener(type, listener) { this.listeners.set(type, listener); }
  removeEventListener(type, listener) {
    if (this.listeners.get(type) === listener) this.listeners.delete(type);
  }
  dispatch(type, event = {}) { this.listeners.get(type)?.(event); }
}

const source = (width = 640, height = 360) => ({ width, height });

test('phase normalization is periodic and makes the loop endpoints identical', () => {
  assert.equal(normalizeFlutedGlassPhase(0), 0);
  assert.equal(normalizeFlutedGlassPhase(1), 0);
  assert.equal(normalizeFlutedGlassPhase(-1), 0);
  assert.equal(normalizeFlutedGlassPhase(2.25), 0.25);
  assert.equal(normalizeFlutedGlassPhase(-0.25), 0.75);
  assert.equal(normalizeFlutedGlassPhase(NaN), 0);
});

test('responsive rib count depends on aspect, not resolution, and stays bounded', () => {
  assert.equal(flutedRibCount(900, 1600), 24);
  assert.equal(flutedRibCount(1800, 3200), 24);
  assert.equal(flutedRibCount(1600, 900), 50);
  assert.equal(flutedRibCount(3200, 1800), 50);
  assert.equal(flutedRibCount(1000, 1000), flutedRibCount(250, 250));
  assert.ok(flutedRibCount(1000, 1000) > 24);
  assert.ok(flutedRibCount(1000, 1000) < 50);
  assert.equal(flutedRibCount(0, 0), 24);
});

test('byte estimator accounts for source texture and double-buffered output', () => {
  assert.equal(estimateFlutedGlassBytes(4, 3), 144);
  assert.equal(estimateFlutedGlassBytes(0, 3), 0);
  assert.equal(estimateFlutedGlassBytes(NaN, 3), 0);
});

test('zero intensity is a strict source identity no-op without lazy allocation', () => {
  const originalDocument = globalThis.document;
  let canvasCreations = 0;
  globalThis.document = { createElement() { canvasCreations++; return new FakeCanvas(); } };
  const frame = source();
  try {
    releaseFlutedGlass();
    assert.equal(renderFlutedGlass(frame), frame);
    assert.equal(renderFlutedGlass(frame, { intensity: -1 }), frame);
    assert.equal(renderFlutedGlass(frame, { intensity: NaN }), frame);
    assert.equal(canvasCreations, 0);
  } finally {
    releaseFlutedGlass();
    globalThis.document = originalDocument;
  }
});

test('unsupported WebGL2 returns the original source', () => {
  const frame = source();
  const renderer = new FlutedGlassRenderer({
    createCanvas: () => ({
      width: 0,
      height: 0,
      getContext: () => null,
      addEventListener() {},
      removeEventListener() {},
    }),
  });
  assert.equal(renderer.isSupported(), false);
  assert.equal(renderer.render(frame, { intensity: 1 }), frame);
  renderer.release();
});

test('renderer reuses its program, texture, and canvas across frames', () => {
  const gl = new FakeGL();
  const canvas = new FakeCanvas(gl);
  const renderer = new FlutedGlassRenderer({ createCanvas: () => canvas });
  const frame = source();

  const first = renderer.render(frame, { intensity: 0.8, phase: 0, sourceKey: 7 });
  const second = renderer.render(frame, { intensity: 0.8, phase: 0.5, sourceKey: 7 });

  assert.equal(first, canvas);
  assert.equal(second, canvas);
  assert.equal(canvas.width, frame.width);
  assert.equal(canvas.height, frame.height);
  assert.equal(gl.createdPrograms, 1);
  assert.equal(gl.createdTextures, 1);
  assert.equal(gl.textureAllocations, 1);
  assert.equal(gl.sourceUploads, 1, 'stable sourceKey skips a redundant source upload');
  assert.equal(gl.draws, 2);
  assert.deepEqual(gl.uniformValues.get('u_resolution'), [640, 360]);
  assert.equal(gl.uniformValues.get('u_ribCount'), flutedRibCount(640, 360));
  renderer.release();
});

test('cache keys are optional and dimensions invalidate the upload cache', () => {
  const gl = new FakeGL();
  const renderer = new FlutedGlassRenderer({ createCanvas: () => new FakeCanvas(gl) });
  const frame = source();

  renderer.render(frame, { intensity: 1, sourceKey: 'a' });
  renderer.render(frame, { intensity: 1, sourceKey: 'a' });
  renderer.render(frame, { intensity: 1, sourceKey: 'b' });
  renderer.render(frame, { intensity: 1 });
  renderer.render(frame, { intensity: 1 });
  renderer.render(source(800, 450), { intensity: 1, sourceKey: 'b' });

  assert.equal(gl.sourceUploads, 5);
  assert.equal(gl.textureAllocations, 2);
  renderer.release();
});

test('phase 0 and phase 1 send the exact same uniform to the shader', () => {
  const gl = new FakeGL();
  const renderer = new FlutedGlassRenderer({ createCanvas: () => new FakeCanvas(gl) });
  const frame = source();

  renderer.render(frame, { intensity: 1, phase: 0, sourceKey: 1 });
  const atZero = gl.uniformValues.get('u_phase');
  renderer.render(frame, { intensity: 1, phase: 1, sourceKey: 1 });
  const atOne = gl.uniformValues.get('u_phase');
  assert.equal(atZero, 0);
  assert.equal(atOne, 0);
  renderer.release();
});

test('shader samples and preserves source alpha instead of forcing opacity', () => {
  const gl = new FakeGL();
  const canvas = new FakeCanvas(gl);
  const renderer = new FlutedGlassRenderer({ createCanvas: () => canvas });
  const fragment = gl.shaderSources.find((text) => text.includes('outColor'));
  assert.match(fragment, /refracted\.a/);
  assert.match(fragment, /mix\(base\.a, refracted\.a, amount\)/);
  assert.doesNotMatch(fragment, /outColor\s*=\s*vec4\([^;]*,\s*1\.0\s*\)/);
  assert.equal(canvas.contextOptions.premultipliedAlpha, false);
  renderer.release();
});

test('context loss prevents blank effect frames and release frees GPU state', () => {
  const gl = new FakeGL();
  const canvas = new FakeCanvas(gl);
  const renderer = new FlutedGlassRenderer({ createCanvas: () => canvas });
  const frame = source();
  assert.equal(renderer.render(frame, { intensity: 1 }), canvas);

  let prevented = false;
  gl.contextLost = true;
  canvas.dispatch('webglcontextlost', { preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(renderer.render(frame, { intensity: 1 }), frame);

  renderer.release();
  renderer.release();
  assert.equal(canvas.width, 0);
  assert.equal(canvas.height, 0);
  assert.equal(renderer.isSupported(), false);
});

test('shared support probe is lazy and releaseable', () => {
  const originalDocument = globalThis.document;
  const gl = new FakeGL();
  let canvasCreations = 0;
  globalThis.document = {
    createElement() {
      canvasCreations++;
      return new FakeCanvas(gl);
    },
  };
  try {
    releaseFlutedGlass();
    assert.equal(isFlutedGlassSupported(), true);
    assert.equal(canvasCreations, 1);
    releaseFlutedGlass();
    assert.equal(gl.deletedPrograms, 1);
    assert.equal(gl.deletedTextures, 1);
  } finally {
    releaseFlutedGlass();
    globalThis.document = originalDocument;
  }
});
