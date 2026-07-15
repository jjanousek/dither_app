import test from 'node:test';
import assert from 'node:assert/strict';

class FakeImageData {
  constructor(data, width, height) {
    this.data = data;
    this.width = width;
    this.height = height;
  }
}

class FakeContext {
  constructor(canvas) {
    this.canvas = canvas;
    this.filter = 'none';
  }

  clearRect() {}
  drawImage() {}
  putImageData(image) { this.image = image; }
  save() {}
  restore() {}
  setTransform() {}
  translate() {}
  rotate() {}
  scale() {}
  fillRect() {}
  fillText() {}

  getImageData(_x, _y, width, height) {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < data.length; i += 4) {
      data[i] = 96;
      data[i + 1] = 128;
      data[i + 2] = 160;
      data[i + 3] = 255;
    }
    return new FakeImageData(data, width, height);
  }

  measureText() { return { width: 8 }; }
}

class FakeCanvas {
  constructor() {
    this.width = 0;
    this.height = 0;
    this.ctx = new FakeContext(this);
    this.listeners = new Map();
  }

  getContext(kind) {
    return kind === 'webgl2' ? null : this.ctx;
  }

  addEventListener(type, listener) { this.listeners.set(type, listener); }

  dispatch(type, event = {}) { this.listeners.get(type)?.(event); }
}

class FakeGL {
  constructor() {
    const constants = [
      'VERTEX_SHADER', 'FRAGMENT_SHADER', 'COMPILE_STATUS', 'LINK_STATUS',
      'TEXTURE_2D', 'TEXTURE_MIN_FILTER', 'TEXTURE_MAG_FILTER',
      'TEXTURE_WRAP_S', 'TEXTURE_WRAP_T', 'NEAREST', 'LINEAR',
      'LINEAR_MIPMAP_LINEAR', 'CLAMP_TO_EDGE', 'REPEAT', 'UNPACK_ALIGNMENT',
      'R8', 'RED', 'RGBA', 'UNSIGNED_BYTE',
    ];
    constants.forEach((name, index) => { this[name] = index + 1; });
  }

  createShader() { return {}; }
  shaderSource() {}
  compileShader() {}
  getShaderParameter() { return true; }
  getShaderInfoLog() { return ''; }
  deleteShader() {}
  createProgram() { return {}; }
  attachShader() {}
  linkProgram() {}
  getProgramParameter() { return true; }
  getProgramInfoLog() { return ''; }
  useProgram() {}
  getUniformLocation() { return {}; }
  createTexture() { return {}; }
  bindTexture() {}
  texParameteri() {}
  pixelStorei() {}
  texImage2D() {}
  isContextLost() { return false; }
}

class FakeWebGLCanvas extends FakeCanvas {
  constructor() {
    super();
    this.webgl = new FakeGL();
  }

  getContext(kind) {
    return kind === 'webgl2' ? this.webgl : super.getContext(kind);
  }
}

class FakeWorker {
  static instances = [];

  constructor() {
    this.messages = [];
    FakeWorker.instances.push(this);
  }

  postMessage(message) { this.messages.push(message); }
  terminate() {}

  reply(index = this.messages.length - 1) {
    const request = this.messages[index];
    this.onmessage?.({ data: { ...request, buffer: request.buffer.slice(0) } });
  }
}

globalThis.ImageData = FakeImageData;
globalThis.document = { createElement: () => new FakeCanvas() };
globalThis.Worker = FakeWorker;

const { Engine, MAX_LIVE_GRAVITY_CELLS } = await import('../js/engine/engine.js');
const { AsciiRenderer } = await import('../js/engine/ascii.js');

const params = {
  mode: 'dither',
  algorithm: 'floyd',
  pixelSize: 1,
  colors: ['#000000', '#ffffff'],
  ditherStrength: 1,
  serpentine: true,
  threshold: 0.5,
  grayscale: false,
  saturation: 1,
  brightness: 0,
  contrast: 1,
  gamma: 1,
  invert: false,
  smoothness: 0,
  ssCap: 3,
  hue: 0,
  sepia: 0,
  blur: 0,
  anim: { style: 'none', intensity: 0 },
  animPhase: 0,
  staticSource: false,
  liveSource: false,
  liveRender: false,
};

const asciiParams = {
  ...params,
  mode: 'ascii',
  ascii: {
    renderer: 'ramp',
    chars: '@ ',
    cellSize: 8,
    fontId: 'menlo',
    bold: false,
    colorMode: 'mono',
    fg: '#ffffff',
    bg: '#000000',
    invertRamp: false,
    dither: 'none',
    edgeStrength: 0,
    autoContrast: false,
    shapeSet: 'ascii',
    captureMetadata: false,
  },
};

test('Engine invalidates borrowed GPU-frame generations on context loss and restoration', () => {
  const originalCreateElement = document.createElement;
  let creationIndex = 0;
  let glCanvas = null;
  document.createElement = () => {
    creationIndex++;
    if (creationIndex === 2) {
      glCanvas = new FakeWebGLCanvas();
      return glCanvas;
    }
    return new FakeCanvas();
  };

  try {
    const engine = new Engine();
    const initialGeneration = engine.glGeneration;
    let lossPrevented = false;

    assert.equal(Number.isSafeInteger(initialGeneration), true);
    glCanvas.dispatch('webglcontextlost', {
      preventDefault() { lossPrevented = true; },
    });
    assert.equal(lossPrevented, true, 'context loss must opt into browser restoration');
    assert.equal(engine.glLost, true);
    assert.equal(engine.glGeneration, initialGeneration + 1,
      'a cached GPU frame becomes stale as soon as the context is lost');

    glCanvas.dispatch('webglcontextrestored');
    assert.equal(engine.glLost, false);
    assert.equal(engine.glGeneration, initialGeneration + 2,
      'restored GPU resources represent a second distinct cache generation');
  } finally {
    document.createElement = originalCreateElement;
  }
});

test('dense Colored Gravity quantizes only the live sprite atlas, never offline body colors', () => {
  const renderer = new AsciiRenderer();
  const cols = 100;
  const rows = 50;
  renderer.canvas.width = cols * 4;
  renderer.canvas.height = rows * 4;
  renderer.lastGlyphFrame = Array.from({ length: rows }, (_, row) => (
    Array.from({ length: cols }, (_, col) => [
      (row + col) & 1 ? '1' : '0',
      ((row * cols + col) * 2654435761) & 0xffffff,
      null,
    ])
  ));
  const options = {
    phase: 0.25,
    intensity: 0.6,
    font: { family: 'monospace', bold: false },
    bg: '#000000',
    cols,
    rows,
  };

  renderer.renderGravity({ ...options, preview: false });
  assert.equal(renderer._gravityUseSprites, false, 'offline rendering keeps exact per-body colors');
  renderer.renderGravity({ ...options, preview: true });
  assert.equal(renderer._gravityUseSprites, true, 'dense live rendering uses the bounded atlas');
  assert.ok(renderer._gravitySpriteVariants.length <= 128);
  assert.equal(renderer._gravityAngleBinCount, 17, 'tiny dense colors use coarse rotation bins');
  renderer.renderGravity({ ...options, preview: false });
  assert.equal(renderer._gravityUseSprites, false, 'returning offline restores exact colors');
  assert.equal(renderer._gravityAngleBinCount, 65, 'offline restores fine rotation sampling');
});

test('Gravity supersamples tiny glyphs but keeps large-font atlases sprite-backed', () => {
  const renderer = new AsciiRenderer();
  const chars = '@%#*+=-:.';
  const cols = 50;
  const rows = 20;
  renderer.lastGlyphFrame = Array.from({ length: rows }, (_, row) => (
    Array.from({ length: cols }, (_, col) => [chars[(row * cols + col) % chars.length], 0xffffff, null])
  ));
  const options = {
    phase: 0.4,
    intensity: 0.6,
    font: { family: 'monospace', bold: false },
    bg: '#000000',
    cols,
    rows,
    preview: true,
  };

  renderer.canvas.width = cols * 5;
  renderer.canvas.height = rows * 8;
  renderer.renderGravity(options);
  assert.equal(renderer._gravityUseSprites, true);
  assert.equal(renderer._gravitySpriteRasterScale, 2, 'small preview glyphs retain 2x clarity');

  renderer.canvas.width = cols * 20;
  renderer.canvas.height = rows * 32;
  renderer.renderGravity(options);
  assert.equal(renderer._gravityUseSprites, true, 'large glyphs avoid the per-body fillText fallback');
  assert.equal(renderer._gravitySpriteRasterScale, 1, 'large glyphs do not need supersampling');
  assert.ok(renderer._gravitySpriteAtlas.width * renderer._gravitySpriteAtlas.height <= 8_000_000);
});

test('Engine.renderDetailed reports a borrowed fresh result and crisp descriptor', () => {
  const engine = new Engine();
  const source = new FakeCanvas();
  source.width = 32;
  source.height = 16;

  const result = engine.renderDetailed(source, 32, 16, params, {
    maxPixels: Infinity,
    allowAsync: false,
  });

  assert.equal(result.legacyCanvas, result.renderedResult.canvas);
  assert.deepEqual(result.renderedResult.descriptor, {
    width: 32,
    height: 16,
    samplingKind: 'crisp',
    asciiGridInfo: null,
  });
  assert.equal(result.committedResult, null);
  assert.equal(result.acceptedJob, null);
});

test('Engine detailed maxOutputSide caps an extreme crisp panorama without changing legacy numeric renders', () => {
  const engine = new Engine();
  const source = new FakeCanvas();

  const legacy = engine.render(source, 1000, 10, params, Infinity, false, true);
  assert.equal(legacy.width, 1000);
  assert.equal(legacy.height, 10);

  const detailed = engine.renderDetailed(source, 1000, 10, params, {
    maxPixels: Infinity,
    maxOutputPixels: Infinity,
    maxOutputSide: 100,
    allowAsync: false,
  });
  assert.equal(detailed.renderedResult.descriptor.width, 100);
  assert.equal(detailed.renderedResult.descriptor.height, 1);
});

test('legacy synchronous ASCII render exposes grid geometry without capturing text metadata', () => {
  const engine = new Engine();
  const source = new FakeCanvas();
  source.width = 32;
  source.height = 16;

  const result = engine.render(source, 32, 16, asciiParams, Infinity, false, true);

  assert.deepEqual(engine.lastAsciiGridInfo, {
    cols: 4,
    rows: 2,
    rasterWidth: result.width,
    rasterHeight: result.height,
  });
  assert.equal(engine.ascii.lastText, '');
  assert.equal(engine.ascii.lastGrid, null);
});

test('ASCII gravity keeps output geometry while drawing from a transient glyph frame', () => {
  const engine = new Engine();
  const source = new FakeCanvas();
  source.width = 32;
  source.height = 16;
  const gravityParams = {
    ...asciiParams,
    ascii: { ...asciiParams.ascii, chars: '10' },
    staticSource: true,
    anim: { style: 'gravity', intensity: 0.7 },
    animPhase: 0.55,
  };

  const result = engine.render(source, 32, 16, gravityParams, Infinity, false, true);

  assert.equal(result, engine.ascii.gravityCanvas);
  assert.deepEqual(engine.lastAsciiGridInfo, {
    cols: 4,
    rows: 2,
    rasterWidth: result.width,
    rasterHeight: result.height,
  });
  assert.ok(Array.isArray(engine.ascii.lastGlyphFrame));
  assert.equal(engine.ascii.lastGrid, null, 'live gravity capture stays separate from text exports');
  assert.ok(engine.ascii.lastGravityStats.bodyCount > 0);
  assert.ok(engine.ascii.lastGravityStats.released > 0);
});

test('static ASCII gravity reuses its glyph grid across phase-only ticks and invalidates on settings changes', () => {
  const engine = new Engine();
  const source = new FakeCanvas();
  source.width = 64;
  source.height = 32;
  const gravityParams = {
    ...asciiParams,
    ascii: { ...asciiParams.ascii, chars: '10' },
    staticSource: true,
    anim: { style: 'gravity', intensity: 0.7 },
    animPhase: 0.25,
  };

  engine.render(source, 64, 32, gravityParams, Infinity, false, true);
  const firstGrid = engine.ascii.lastGlyphFrame;
  const firstLayout = engine.ascii.gravityLayout;

  engine.render(source, 64, 32, { ...gravityParams, animPhase: 0.65 }, Infinity, false, false);
  assert.equal(engine.ascii.lastGlyphFrame, firstGrid);
  assert.equal(engine.ascii.gravityLayout, firstLayout);

  engine.render(source, 64, 32, {
    ...gravityParams,
    animPhase: 0.65,
    ascii: { ...gravityParams.ascii, fg: '#ff00ff' },
  }, Infinity, false, true);
  assert.notEqual(engine.ascii.lastGlyphFrame, firstGrid);
});

test('live ASCII gravity caps the complete preview grid and keeps its geometry stable across phase ticks', () => {
  const engine = new Engine();
  const source = new FakeCanvas();
  source.width = 1280;
  source.height = 800;
  const gravityParams = {
    ...asciiParams,
    ascii: { ...asciiParams.ascii, chars: '10', cellSize: 4 },
    staticSource: true,
    liveRender: true,
    anim: { style: 'gravity', intensity: 0.7, gravityMode: 'drizzle' },
    animPhase: 0.25,
  };

  assert.ok(MAX_LIVE_GRAVITY_CELLS <= 12_000,
    'the native live preview budget must stay below the WKWebView stutter threshold');

  engine.render(source, source.width, source.height, gravityParams, Infinity, false, true);
  const firstInfo = { ...engine.lastAsciiGridInfo };
  const firstGrid = engine.ascii.lastGlyphFrame;
  const firstLayout = engine.ascii.gravityLayout;

  assert.ok(firstInfo.cols * firstInfo.rows <= MAX_LIVE_GRAVITY_CELLS);
  assert.equal(firstGrid.length, firstInfo.rows);
  assert.ok(firstGrid.every((row) => row.length === firstInfo.cols));
  assert.equal(firstLayout.bodies.length, firstInfo.cols * firstInfo.rows,
    'the cap reduces the whole sampled grid instead of dropping arbitrary bodies');

  engine.render(source, source.width, source.height, {
    ...gravityParams,
    animPhase: 0.7,
  }, Infinity, false, false);
  assert.deepEqual(engine.lastAsciiGridInfo, firstInfo);
  assert.equal(engine.ascii.lastGlyphFrame, firstGrid);
  assert.equal(engine.ascii.gravityLayout, firstLayout);
});

test('offline ASCII gravity retains the requested grid above the live body ceiling', () => {
  const engine = new Engine();
  const source = new FakeCanvas();
  source.width = 1280;
  source.height = 800;
  const gravityParams = {
    ...asciiParams,
    ascii: { ...asciiParams.ascii, chars: '10', cellSize: 4 },
    staticSource: true,
    liveRender: false,
    anim: { style: 'gravity', intensity: 0.7, gravityMode: 'drizzle' },
    animPhase: 0.25,
  };

  engine.render(source, source.width, source.height, gravityParams, Infinity, false, true);

  assert.deepEqual(engine.lastAsciiGridInfo, {
    cols: 160,
    rows: 200,
    rasterWidth: 1280,
    rasterHeight: 800,
  });
  assert.ok(engine.lastAsciiGridInfo.cols * engine.lastAsciiGridInfo.rows > MAX_LIVE_GRAVITY_CELLS);
  assert.equal(engine.ascii.gravityLayout.bodies.length, 32_000);
});

test('Gravity mode changes reuse the cached glyph base while rebuilding only the physics layout', () => {
  const engine = new Engine();
  const source = new FakeCanvas();
  source.width = 64;
  source.height = 32;
  const gravityParams = {
    ...asciiParams,
    ascii: { ...asciiParams.ascii, chars: '10' },
    staticSource: true,
    anim: { style: 'gravity', intensity: 0.7, gravityMode: 'drizzle' },
    animPhase: 0.25,
  };

  engine.render(source, 64, 32, gravityParams, Infinity, false, true);
  const firstGrid = engine.ascii.lastGlyphFrame;
  const firstLayout = engine.ascii.gravityLayout;

  engine.render(source, 64, 32, {
    ...gravityParams,
    anim: { ...gravityParams.anim, gravityMode: 'cascade' },
    animPhase: 0.65,
  }, Infinity, false, false);

  assert.equal(engine.ascii.lastGlyphFrame, firstGrid,
    'physics mode is intentionally absent from the expensive glyph-base cache key');
  assert.notEqual(engine.ascii.gravityLayout, firstLayout);
  assert.equal(engine.ascii.gravityLayout.mode, 'cascade');
});

test('Engine detailed CPU wake can expose committed A and accepted B together', () => {
  FakeWorker.instances.length = 0;
  const engine = new Engine();
  const source = new FakeCanvas();
  let nextFrame = 1;
  const makeAcceptedJob = (descriptor) => ({
    token: {
      sourceEpoch: 1,
      frameId: nextFrame++,
      effectRevision: 1,
      targetRevision: 1,
      samplingKind: descriptor.samplingKind,
    },
    targetPlan: { width: descriptor.width * 2, height: descriptor.height * 2 },
  });
  const request = {
    maxPixels: Infinity,
    allowAsync: true,
    contentNew: true,
    makeAcceptedJob,
  };

  const cold = engine.renderDetailed(source, 8, 4, params, request);
  assert.ok(cold.renderedResult);

  const dispatchedA = engine.renderDetailed(source, 8, 4, params, request);
  assert.equal(dispatchedA.acceptedJob.token.frameId, 1);
  assert.equal(dispatchedA.renderedResult, null);

  const busy = engine.renderDetailed(source, 8, 4, params, request);
  assert.equal(busy.acceptedJob, null);
  assert.equal(busy.renderedResult, null);

  FakeWorker.instances[0].reply(0);
  const combined = engine.renderDetailed(source, 8, 4, params, {
    ...request,
    contentNew: false,
  });
  assert.equal(combined.committedResult.token.frameId, 1);
  assert.equal(combined.acceptedJob.token.frameId, 2);
  assert.equal(combined.renderedResult, null);

  engine.cpu.invalidate();
  FakeWorker.instances[0].reply(1); // clear watchdog; stale epoch is discarded
});
