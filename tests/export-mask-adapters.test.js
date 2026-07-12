import test from 'node:test';
import assert from 'node:assert/strict';

class FakeContext {
  constructor(canvas) {
    this.canvas = canvas;
    this.drawCalls = 0;
  }

  drawImage() { this.drawCalls++; }

  getImageData(_x, _y, width, height) {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < data.length; i += 4) data[i + 3] = 255;
    return { width, height, data };
  }
}

class FakeCanvas {
  constructor(width = 0, height = 0) {
    this.width = width;
    this.height = height;
    this.ctx = new FakeContext(this);
  }

  getContext() { return this.ctx; }
}

const createdCanvases = [];
const downloads = [];
globalThis.document = {
  createElement(kind) {
    if (kind === 'canvas') {
      const canvas = new FakeCanvas();
      createdCanvases.push(canvas);
      return canvas;
    }
    if (kind === 'a') {
      return {
        href: '',
        download: '',
        click() { downloads.push(this.download); },
      };
    }
    throw new Error(`unexpected element ${kind}`);
  },
};

class FakeVideoFrame {
  static sources = [];

  constructor(source, opts) {
    this.source = source;
    this.opts = opts;
    FakeVideoFrame.sources.push(source);
  }

  close() { this.closed = true; }
}

class FakeVideoEncoder {
  static async isConfigSupported(config) { return { supported: true, config }; }

  constructor({ output, error }) {
    this.output = output;
    this.error = error;
    this.encodeQueueSize = 0;
    this.state = 'unconfigured';
    this.count = 0;
  }

  configure(config) {
    this.config = config;
    this.state = 'configured';
  }

  encode(_frame, opts) {
    const bytes = new Uint8Array([0, 0, 0, 1, this.count & 255]);
    const chunk = {
      byteLength: bytes.length,
      type: opts.keyFrame ? 'key' : 'delta',
      copyTo(dest) { dest.set(bytes); },
    };
    const meta = this.count++ === 0
      ? { decoderConfig: { description: new Uint8Array([1, 100, 0, 51]) } }
      : undefined;
    this.output(chunk, meta);
  }

  async flush() {}
  close() { this.state = 'closed'; }
}

globalThis.VideoFrame = FakeVideoFrame;
globalThis.VideoEncoder = FakeVideoEncoder;

const {
  exportGIF,
  exportLoopFrameAccurate,
  planH264Target,
} = await import('../js/export/exporters.js');

test('GIF adapter exposes exact divisor crop and per-frame metadata', async () => {
  const first = new FakeCanvas(11, 7);
  const frameMeta = { token: { frameId: 4 }, asciiGridInfo: null };
  let sized = null;
  let processed = null;

  await exportGIF({
    video: null,
    renderFrame: () => ({ canvas: first, meta: frameMeta }),
    maxWidth: 5,
    postProcess: (pixels, width, height, meta) => {
      processed = { pixels, width, height, meta };
      return pixels;
    },
    onSized: (plan) => { sized = plan; },
    name: 'mask-crop',
  });

  assert.equal(sized.divisor, 2);
  assert.equal(sized.targetWidth, 5);
  assert.equal(sized.targetHeight, 3);
  assert.deepEqual(sized.normalizedCrop, { u0: 0, v0: 0, u1: 10 / 11, v1: 6 / 7 });
  assert.equal(processed.width, 5);
  assert.equal(processed.height, 3);
  assert.equal(processed.meta.frameMeta, frameMeta);
  assert.equal(downloads.at(-1), 'mask-crop.gif');
});

test('H.264 target planning preserves the existing integer enlargement policy', () => {
  assert.deepEqual(planH264Target(640, 360), { width: 1280, height: 720, scale: 2 });
  assert.deepEqual(planH264Target(2000, 1000), { width: 2000, height: 1000, scale: 1 });
  assert.throws(() => planH264Target(4000, 1000), /3840px H\.264 limit/);
});

test('frame-accurate loop finalizer feeds exact canvases 1:1 and releases each one', async () => {
  createdCanvases.length = 0;
  FakeVideoFrame.sources.length = 0;
  let finalized = 0;
  let released = 0;
  const processed = new FakeCanvas(10, 6);

  await exportLoopFrameAccurate({
    renderFrame: () => ({ canvas: processed, meta: { source: 'processed-only' } }),
    setPhase: () => {},
    count: 2,
    fps: 30,
    name: 'mask-final',
    planFinalTarget: ({ defaultTarget, maxSampleBytes }) => {
      assert.ok(defaultTarget.width > 20);
      assert.ok(maxSampleBytes > 0);
      return { width: 20, height: 12 };
    },
    finalizeFrame: (_frame, meta) => {
      finalized++;
      assert.equal(meta.width, 20);
      assert.equal(meta.height, 12);
      assert.deepEqual(meta.frameMeta, { source: 'processed-only' });
      return {
        canvas: new FakeCanvas(20, 12),
        release: () => { released++; },
      };
    },
  });

  assert.equal(finalized, 2);
  assert.equal(released, 2);
  assert.equal(FakeVideoFrame.sources.length, 2);
  assert.ok(FakeVideoFrame.sources.every((canvas) => canvas.width === 20 && canvas.height === 12));
  assert.equal(createdCanvases.length, 0, 'addFinal must not allocate a legacy staging canvas');
});

test('finalized frame dimension failure still releases caller-owned output', async () => {
  let released = 0;
  await assert.rejects(
    exportLoopFrameAccurate({
      renderFrame: () => new FakeCanvas(10, 6),
      setPhase: () => {},
      count: 1,
      fps: 30,
      planFinalTarget: () => ({ width: 20, height: 12 }),
      finalizeFrame: () => ({
        canvas: new FakeCanvas(18, 12),
        release: () => { released++; },
      }),
    }),
    /exactly 20x12/,
  );
  assert.equal(released, 1);
});

test('legacy H.264 path retains staging draw behavior when no finalizer is supplied', async () => {
  createdCanvases.length = 0;
  const processed = new FakeCanvas(640, 360);
  await exportLoopFrameAccurate({
    renderFrame: () => processed,
    setPhase: () => {},
    count: 1,
    fps: 30,
    name: 'legacy-stage',
  });

  assert.equal(createdCanvases.length, 1);
  assert.equal(createdCanvases[0].ctx.drawCalls, 1);
});
