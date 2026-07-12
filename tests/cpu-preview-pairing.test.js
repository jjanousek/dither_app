import test from 'node:test';
import assert from 'node:assert/strict';

class FakeContext {
  putImageData(imageData) {
    this.lastImageData = imageData;
  }
}

class FakeCanvas {
  constructor() {
    this.width = 0;
    this.height = 0;
    this.ctx = new FakeContext();
  }

  getContext() {
    return this.ctx;
  }
}

class FakeImageData {
  constructor(data, width, height) {
    this.data = data;
    this.width = width;
    this.height = height;
  }
}

class FakeWorker {
  static instances = [];

  constructor() {
    this.messages = [];
    FakeWorker.instances.push(this);
  }

  postMessage(message) {
    this.messages.push(message);
  }

  terminate() {
    this.terminated = true;
  }

  reply(index = this.messages.length - 1) {
    const request = this.messages[index];
    const buffer = request.buffer.slice(0);
    this.onmessage?.({ data: { ...request, buffer } });
  }
}

globalThis.document = {
  createElement(kind) {
    assert.equal(kind, 'canvas');
    return new FakeCanvas();
  },
};
globalThis.ImageData = FakeImageData;
globalThis.Worker = FakeWorker;

const { CpuPreview } = await import('../js/engine/cpu-preview.js');

const image = (value) => new FakeImageData(
  new Uint8ClampedArray([
    value, value, value, 255,
    value, value, value, 255,
  ]),
  2,
  1,
);

const palette = new Float32Array([0, 0, 0, 255, 255, 255]);
const opts = { strength: 1, serpentine: false, bias: 0 };
const descriptor = { width: 2, height: 1, samplingKind: 'crisp', asciiGridInfo: null };

test('CpuPreview reports synchronous cold start without accepting a worker job', () => {
  FakeWorker.instances.length = 0;
  const cpu = new CpuPreview();
  const result = cpu.render(
    image(80), 2, 1, palette, 'floyd', opts, 'sig', new FakeContext(), true,
    { descriptor, makeAcceptedJob: () => assert.fail('cold start must stay synchronous') },
  );

  assert.equal(result.rendered, true);
  assert.equal(result.acceptedJob, null);
  assert.equal(result.canvas, cpu.committed);
  assert.equal(FakeWorker.instances[0].messages.length, 0);
});

test('CpuPreview separates a landed commit from the next accepted pending job', () => {
  FakeWorker.instances.length = 0;
  let wakes = 0;
  const cpu = new CpuPreview(() => { wakes++; });
  const detailA = {
    descriptor,
    makeAcceptedJob: () => ({
      token: { sourceEpoch: 1, frameId: 10, effectRevision: 3, targetRevision: 2, samplingKind: 'crisp' },
      targetPlan: { width: 4, height: 2 },
    }),
  };

  cpu.render(image(40), 2, 1, palette, 'floyd', opts, 'sig', new FakeContext(), true, detailA);
  const dispatchedA = cpu.render(
    image(90), 2, 1, palette, 'floyd', opts, 'sig', new FakeContext(), true, detailA,
  );
  assert.equal(dispatchedA.rendered, false);
  assert.equal(dispatchedA.acceptedJob.token.frameId, 10);
  assert.equal(FakeWorker.instances[0].messages.length, 1);

  const busy = cpu.render(
    image(130), 2, 1, palette, 'floyd', opts, 'sig', new FakeContext(), true,
    { descriptor, makeAcceptedJob: () => assert.fail('busy frames are not accepted') },
  );
  assert.equal(busy.acceptedJob, null);
  assert.equal(cpu.pending, true);

  FakeWorker.instances[0].reply(0);
  assert.equal(wakes, 1);
  const committedA = cpu.takeCommittedResult();
  assert.equal(committedA.token.frameId, 10);
  assert.equal(committedA.canvas, cpu.committed);
  assert.equal(cpu.takeCommittedResult(), null, 'landing is consumed exactly once');

  const detailB = {
    descriptor,
    makeAcceptedJob: () => ({
      token: { sourceEpoch: 1, frameId: 12, effectRevision: 3, targetRevision: 2, samplingKind: 'crisp' },
      targetPlan: { width: 4, height: 2 },
    }),
  };
  const dispatchedB = cpu.render(
    image(170), 2, 1, palette, 'floyd', opts, 'sig', new FakeContext(), false, detailB,
  );
  assert.equal(dispatchedB.acceptedJob.token.frameId, 12);
  assert.equal(FakeWorker.instances[0].messages.length, 2);

  cpu.invalidate();
  FakeWorker.instances[0].reply(1);
  assert.equal(cpu.takeCommittedResult(), null, 'late invalidated result is discarded');
});

test('CpuPreview legacy calls continue returning the committed canvas', () => {
  FakeWorker.instances.length = 0;
  const cpu = new CpuPreview();
  const first = cpu.render(image(60), 2, 1, palette, 'floyd', opts, 'legacy', new FakeContext(), true);
  const second = cpu.render(image(120), 2, 1, palette, 'floyd', opts, 'legacy', new FakeContext(), true);

  assert.equal(first, cpu.committed);
  assert.equal(second, cpu.committed);
  assert.equal(
    Object.prototype.hasOwnProperty.call(FakeWorker.instances[0].messages[0], 'token'),
    false
  );
  FakeWorker.instances[0].reply(0);
});
