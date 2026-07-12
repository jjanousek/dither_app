import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FrameBundleManager,
  estimateMaskSubsystemPeakBytes,
  estimatePreviewPeakBytes,
  grainPhaseForFrame,
  planPreviewTarget,
  planUpstreamRender,
  sameRenderToken,
  tokenMatchesGenerations,
} from '../js/frame-bundle.js';

class TraceContext {
  constructor(canvas) {
    this.canvas = canvas;
    this.operations = [];
    this.stack = [];
    this.globalAlpha = 1;
    this.globalCompositeOperation = 'source-over';
    this.filter = 'none';
    this.imageSmoothingEnabled = true;
    this.imageSmoothingQuality = 'low';
  }

  save() {
    this.stack.push({
      globalAlpha: this.globalAlpha,
      globalCompositeOperation: this.globalCompositeOperation,
      filter: this.filter,
      imageSmoothingEnabled: this.imageSmoothingEnabled,
      imageSmoothingQuality: this.imageSmoothingQuality,
    });
  }

  restore() { Object.assign(this, this.stack.pop()); }
  setTransform(...args) { this.transform = args; }
  drawImage(source, ...args) {
    this.operations.push({
      source,
      args,
      smoothing: this.imageSmoothingEnabled,
      composite: this.globalCompositeOperation,
    });
  }
}

class TraceCanvas {
  constructor(width = 0, height = 0, name = '') {
    this._width = width;
    this._height = height;
    this.name = name;
    this.context = new TraceContext(this);
  }

  get width() { return this._width; }
  set width(value) { this._width = Number(value); }
  get height() { return this._height; }
  set height(value) { this._height = Number(value); }
  getContext(kind) { return kind === '2d' ? this.context : null; }
}

const token = (overrides = {}) => ({
  sourceEpoch: 1,
  frameId: 5,
  effectRevision: 2,
  targetRevision: 3,
  samplingKind: 'continuous',
  ...overrides,
});

test('preview target planners preserve crisp integer cells and cap continuous source aspect', () => {
  const crisp = planPreviewTarget({
    sourceWidth: 1920,
    sourceHeight: 1080,
    processedWidth: 480,
    processedHeight: 270,
    samplingKind: 'crisp',
  });
  assert.equal(crisp.integerScale, 4);
  assert.deepEqual([crisp.width, crisp.height], [1920, 1080]);
  assert.equal(crisp.requiresUpstreamReduction, false);

  const continuous = planPreviewTarget({
    sourceWidth: 3840,
    sourceHeight: 2160,
    processedWidth: 480,
    processedHeight: 270,
    samplingKind: 'continuous',
  });
  assert.deepEqual([continuous.width, continuous.height], [2000, 1125]);
  assert.equal(continuous.processedFallback, false);

  const oversizedCrisp = planPreviewTarget({
    sourceWidth: 10_000,
    sourceHeight: 100,
    processedWidth: 5_000,
    processedHeight: 50,
    samplingKind: 'crisp',
  });
  assert.equal(oversizedCrisp.integerScale, 1);
  assert.equal(oversizedCrisp.requiresUpstreamReduction, true);

  const upstream = planUpstreamRender({ requestedWidth: 10_000, requestedHeight: 100 });
  assert.deepEqual([upstream.width, upstream.height], [4096, 40]);
  assert.equal(upstream.maxOutputPixels, 2_250_000);
  assert.equal(upstream.maxOutputSide, 4096);
});

test('complete frame tokens pair exact pixels while generation checks may ignore frame id', () => {
  const a = token();
  assert.equal(sameRenderToken(a, { ...a }), true);
  assert.equal(sameRenderToken(a, { ...a, frameId: 6 }), false);
  assert.equal(tokenMatchesGenerations(a, {
    sourceEpoch: 1,
    effectRevision: 2,
    targetRevision: 3,
    samplingKind: 'continuous',
  }), true);
  assert.equal(tokenMatchesGenerations(a, {
    sourceEpoch: 1,
    frameId: 6,
    effectRevision: 2,
    targetRevision: 3,
    samplingKind: 'continuous',
  }), false);
  assert.equal(grainPhaseForFrame(129), 1 / 128);
});

test('synchronous publication owns both branches, uses intrinsic video crop, and copies shared Post-FX output', () => {
  const allocations = [];
  const fxCalls = [];
  let sharedFX = null;
  const manager = new FrameBundleManager({
    createCanvas: (width, height) => {
      const canvas = new TraceCanvas(width, height, `owned-${allocations.length}`);
      allocations.push(canvas);
      return canvas;
    },
    applyPostFX: (stage, fx, options) => {
      fxCalls.push({ stage, fx, options });
      sharedFX = new TraceCanvas(stage.width, stage.height, 'shared-fx');
      return sharedFX;
    },
  });
  const borrowedProcessed = new TraceCanvas(2, 1, 'borrowed-processed');
  const rawVideo = { name: 'video-without-width-properties' };
  const renderToken = token();
  const targetPlan = {
    width: 4,
    height: 2,
    samplingKind: 'continuous',
    targetRevision: 3,
  };
  const crop = { u0: 0.1, v0: 0.05, u1: 0.9, v1: 0.95 };

  const bundle = manager.buildSynchronous({
    borrowedProcessed,
    descriptor: {
      width: 2,
      height: 1,
      samplingKind: 'continuous',
      asciiGridInfo: { cols: 2, rows: 1, rasterWidth: 2, rasterHeight: 1 },
    },
    token: renderToken,
    targetPlan,
    rawSource: rawVideo,
    sourceWidth: 1000,
    sourceHeight: 500,
    normalizedCrop: crop,
    postFXPlan: { fx: { grain: 0.2 }, fast: true },
  });

  assert.equal(manager.current, bundle);
  assert.notEqual(bundle.rawTarget, rawVideo);
  assert.notEqual(bundle.processedTarget, borrowedProcessed);
  assert.notEqual(bundle.processedTarget, sharedFX);
  assert.deepEqual(bundle.asciiGridInfo, { cols: 2, rows: 1, rasterWidth: 2, rasterHeight: 1 });
  assert.equal(bundle.grainPhase, 5 / 128);
  assert.equal(fxCalls[0].options.fast, true);
  assert.equal(fxCalls[0].options.grainPhase, 5 / 128);

  const rawDraw = bundle.rawTarget.context.operations[0];
  assert.equal(rawDraw.source, rawVideo);
  assert.deepEqual(rawDraw.args.slice(0, 3), [100, 25, 800]);
  assert.ok(Math.abs(rawDraw.args[3] - 450) < 1e-9);
  assert.deepEqual(rawDraw.args.slice(4), [0, 0, 4, 2]);
  assert.equal(rawDraw.smoothing, true);
  assert.equal(bundle.processedTarget.context.operations[0].source, sharedFX);
  assert.equal(fxCalls[0].stage.width, 0, 'temporary target stage is released after the shared FX copy');
});

test('allocation/Post-FX failure retains the previous complete bundle and releases partial surfaces', () => {
  const allocations = [];
  let fail = false;
  const manager = new FrameBundleManager({
    createCanvas: (width, height) => {
      const canvas = new TraceCanvas(width, height);
      allocations.push(canvas);
      return canvas;
    },
    applyPostFX: (stage) => {
      if (fail) throw new Error('synthetic FX failure');
      return stage;
    },
  });
  const targetPlan = { width: 4, height: 2, samplingKind: 'continuous', targetRevision: 3 };
  const first = manager.buildSynchronous({
    borrowedProcessed: new TraceCanvas(2, 1),
    descriptor: { width: 2, height: 1, samplingKind: 'continuous' },
    token: token(),
    targetPlan,
    rawSource: {},
    sourceWidth: 8,
    sourceHeight: 4,
  });
  const priorRaw = first.rawTarget;
  const priorProcessed = first.processedTarget;
  fail = true;
  const allocationCount = allocations.length;
  assert.throws(() => manager.buildSynchronous({
    borrowedProcessed: new TraceCanvas(2, 1),
    descriptor: { width: 2, height: 1, samplingKind: 'continuous' },
    token: token({ frameId: 6 }),
    targetPlan,
    rawSource: {},
    sourceWidth: 8,
    sourceHeight: 4,
  }), /synthetic FX failure/);
  assert.equal(manager.current, first);
  assert.equal(priorRaw.width, 4);
  assert.equal(priorProcessed.width, 4);
  assert.ok(allocations.slice(allocationCount).every((canvas) => canvas.width === 0));
});

test('async worker commit publishes only with its exact captured raw snapshot and live generations', () => {
  const manager = new FrameBundleManager({ createCanvas: (w, h) => new TraceCanvas(w, h) });
  const renderToken = token({ samplingKind: 'crisp' });
  const targetPlan = {
    width: 4,
    height: 2,
    integerScale: 2,
    samplingKind: 'crisp',
    targetRevision: 3,
  };
  const accepted = manager.acceptAsync({
    acceptedJob: { token: renderToken, targetPlan },
    rawSource: {},
    sourceWidth: 8,
    sourceHeight: 4,
  });
  assert.equal(manager.current, null);
  assert.equal(manager.inFlight, accepted);
  const capturedRaw = accepted.rawTarget;
  const bundle = manager.commitAsync({
    committedResult: {
      token: { ...renderToken },
      canvas: new TraceCanvas(2, 1, 'mutable-worker-result'),
      descriptor: { width: 2, height: 1, samplingKind: 'crisp' },
    },
    currentGenerations: {
      sourceEpoch: 1,
      effectRevision: 2,
      targetRevision: 3,
      samplingKind: 'crisp',
    },
  });
  assert.equal(bundle.rawTarget, capturedRaw);
  assert.equal(manager.current, bundle);
  assert.equal(manager.inFlight, null);
  assert.notEqual(bundle.processedTarget.name, 'mutable-worker-result');

  const staleToken = token({ frameId: 6, samplingKind: 'crisp' });
  const stale = manager.acceptAsync({
    acceptedJob: { token: staleToken, targetPlan },
    rawSource: {},
    sourceWidth: 8,
    sourceHeight: 4,
  });
  assert.equal(manager.commitAsync({
    committedResult: {
      token: staleToken,
      canvas: new TraceCanvas(2, 1),
      descriptor: { width: 2, height: 1, samplingKind: 'crisp' },
    },
    currentGenerations: {
      sourceEpoch: 99,
      effectRevision: 2,
      targetRevision: 3,
      samplingKind: 'crisp',
    },
  }), null);
  assert.equal(stale.rawTarget.width, 0);
  assert.equal(manager.current, bundle);
});

test('async commit can refresh peak accounting after acceptance', () => {
  const manager = new FrameBundleManager({
    createCanvas: (w, h) => new TraceCanvas(w, h),
    previewByteLimit: 150,
  });
  const renderToken = token({ samplingKind: 'crisp' });
  const targetPlan = {
    width: 4,
    height: 2,
    integerScale: 2,
    samplingKind: 'crisp',
    targetRevision: 3,
  };
  const accepted = manager.acceptAsync({
    acceptedJob: { token: renderToken, targetPlan },
    rawSource: {},
    sourceWidth: 8,
    sourceHeight: 4,
  });
  assert.throws(() => manager.commitAsync({
    committedResult: {
      token: renderToken,
      canvas: new TraceCanvas(2, 1),
      descriptor: { width: 2, height: 1, samplingKind: 'crisp' },
    },
    extraPeakBytes: 100,
  }), /preview memory limit/);
  assert.equal(accepted.rawTarget.width, 0);
  assert.equal(manager.inFlight, null);
  assert.equal(manager.current, null);
});

test('async acceptance snapshots Post-FX settings before yielding to the worker', () => {
  const calls = [];
  const manager = new FrameBundleManager({
    createCanvas: (w, h) => new TraceCanvas(w, h),
    applyPostFX: (stage, fx, options) => {
      calls.push({ fx, options });
      return stage;
    },
  });
  const renderToken = token({ samplingKind: 'crisp' });
  const targetPlan = {
    width: 4,
    height: 2,
    integerScale: 2,
    samplingKind: 'crisp',
    targetRevision: 3,
  };
  const postFXPlan = { fx: { grain: 0.2 }, options: { fast: true } };
  manager.acceptAsync({
    acceptedJob: { token: renderToken, targetPlan },
    rawSource: {},
    sourceWidth: 8,
    sourceHeight: 4,
    postFXPlan,
  });
  postFXPlan.fx.grain = 0.9;
  postFXPlan.options.fast = false;
  manager.commitAsync({
    committedResult: {
      token: renderToken,
      canvas: new TraceCanvas(2, 1),
      descriptor: { width: 2, height: 1, samplingKind: 'crisp' },
    },
  });
  assert.equal(calls[0].fx.grain, 0.2);
  assert.equal(calls[0].options.fast, true);
});

test('target revisions change only with the plan and recording locks freeze the target', () => {
  const manager = new FrameBundleManager({ createCanvas: (w, h) => new TraceCanvas(w, h) });
  const request = {
    sourceWidth: 100,
    sourceHeight: 100,
    processedWidth: 25,
    processedHeight: 25,
    samplingKind: 'crisp',
  };
  const first = manager.resolveTarget(request);
  const repeat = manager.resolveTarget(request);
  assert.equal(first.targetRevision, repeat.targetRevision);
  manager.lockTarget();
  const locked = manager.resolveTarget({ ...request, processedWidth: 20, processedHeight: 20 });
  assert.equal(locked, manager.targetPlan);
  assert.equal(manager.targetLocked, true);
  assert.throws(() => manager.buildSynchronous({
    borrowedProcessed: new TraceCanvas(20, 20),
    descriptor: { width: 20, height: 20, samplingKind: 'crisp' },
    token: token({ targetRevision: locked.targetRevision, samplingKind: 'crisp' }),
    targetPlan: {
      width: 80,
      height: 80,
      integerScale: 4,
      samplingKind: 'crisp',
      targetRevision: locked.targetRevision,
    },
    rawSource: {},
    sourceWidth: 100,
    sourceHeight: 100,
  }), /locked recording target plan/);
  manager.unlockTarget();
  const changed = manager.resolveTarget({ ...request, processedWidth: 20, processedHeight: 20 });
  assert.ok(changed.targetRevision > first.targetRevision);
});

test('preview peak estimation counts old bundle, in-flight raw, prospective surfaces, and auxiliaries', () => {
  const currentBundle = {
    rawTarget: new TraceCanvas(4, 2),
    processedTarget: new TraceCanvas(4, 2),
  };
  const inFlightRaw = new TraceCanvas(4, 2);
  const estimate = estimatePreviewPeakBytes({
    targetPlan: { width: 4, height: 2 },
    currentBundle,
    inFlightRaw,
    prospectiveSurfaceCount: 3,
    extraBytes: 10,
  });
  assert.deepEqual(estimate, {
    totalBytes: 202,
    currentBundleBytes: 64,
    inFlightRawBytes: 32,
    prospectiveBytes: 96,
    auxiliaryBytes: 10,
    perSurfaceBytes: 32,
  });
});

test('aggregate mask accounting separates evictable raster cache from fixed preview costs', () => {
  const currentBundle = {
    rawTarget: new TraceCanvas(4, 2),
    processedTarget: new TraceCanvas(4, 2),
  };
  const estimate = estimateMaskSubsystemPeakBytes({
    targetPlan: { width: 4, height: 2 },
    currentBundle,
    inFlightRaw: new TraceCanvas(4, 2),
    prospectiveSurfaceCount: 3,
    rasterCacheBytes: 128,
    outputBytes: 32,
    draftBytes: 32,
    transientRasterBytes: 64,
    compositorBytes: 64,
    postFXBytes: 32,
    otherBytes: 16,
    previewByteLimit: 500,
  });
  assert.equal(estimate.bundlePeakBytes, 192);
  assert.equal(estimate.nonCacheAuxiliaryBytes, 240);
  assert.equal(estimate.nonCacheBytes, 432);
  assert.equal(estimate.nonCacheOverLimitBytes, 0);
  assert.equal(estimate.rasterCacheBytes, 128);
  assert.equal(estimate.totalBytes, 560);
  assert.equal(estimate.overLimitBytes, 60);
  assert.equal(estimate.rasterCacheAllowanceBytes, 68);
  assert.equal(estimate.retainedRasterCacheBytes, 68);
  assert.equal(estimate.requiredRasterEvictionBytes, 60);
  assert.equal(estimate.projectedTotalBytesAfterTrim, 500);
  assert.equal(estimate.fitsAfterRasterTrim, true);
  assert.equal(estimate.accountedExtraBytes, 368);
  assert.equal(estimate.accountedExtraBytesAfterTrim, 308);
  assert.throws(() => estimateMaskSubsystemPeakBytes({
    targetPlan: { width: 4, height: 2 },
    outputBytes: -1,
  }), /outputBytes must be non-negative/);

  const fixedOverflow = estimateMaskSubsystemPeakBytes({
    targetPlan: { width: 4, height: 2 },
    prospectiveSurfaceCount: 2,
    outputBytes: 100,
    previewByteLimit: 100,
  });
  assert.equal(fixedOverflow.rasterCacheAllowanceBytes, 0);
  assert.equal(fixedOverflow.nonCacheOverLimitBytes, 64);
  assert.equal(fixedOverflow.projectedTotalBytesAfterTrim, 164);
  assert.equal(fixedOverflow.fitsAfterRasterTrim, false);
});
