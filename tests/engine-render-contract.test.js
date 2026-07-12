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
  }

  getContext(kind) {
    return kind === 'webgl2' ? null : this.ctx;
  }

  addEventListener() {}
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

const { Engine } = await import('../js/engine/engine.js');

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
