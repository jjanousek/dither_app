// Owned frame pairing, preview target planning, and atomic bundle publication.
//
// Engine and Post-FX canvases are borrowed mutable surfaces. This module is
// the ownership boundary: every published raw/processed canvas is copied into
// app-owned storage and remains unchanged until its bundle is released.

export const MAX_MASK_PREVIEW_AREA = 2_250_000;
export const MAX_MASK_PREVIEW_SIDE = 4_096;
export const MAX_MASK_SUBSYSTEM_PREVIEW_BYTES = 96 * 1024 * 1024;

const FULL_CROP = Object.freeze({ u0: 0, v0: 0, u1: 1, v1: 1 });
const SAMPLING_CRISP = 'crisp';
const SAMPLING_CONTINUOUS = 'continuous';

function defaultCanvasFactory(width, height) {
  let canvas;
  if (typeof OffscreenCanvas !== 'undefined') canvas = new OffscreenCanvas(width, height);
  else if (typeof document !== 'undefined') canvas = document.createElement('canvas');
  else throw new Error('Canvas is unavailable; provide createCanvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function positiveFinite(value, name) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new RangeError(`${name} must be positive`);
  return number;
}

function positiveInteger(value, name) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw new RangeError(`${name} must be a positive integer`);
  return number;
}

function samplingKind(value) {
  if (value !== SAMPLING_CRISP && value !== SAMPLING_CONTINUOUS) {
    throw new TypeError('samplingKind must be crisp or continuous');
  }
  return value;
}

function normalizedCrop(crop = FULL_CROP) {
  const result = {
    u0: Number(crop.u0),
    v0: Number(crop.v0),
    u1: Number(crop.u1),
    v1: Number(crop.v1),
  };
  if (!Object.values(result).every(Number.isFinite)
    || result.u0 < 0 || result.v0 < 0 || result.u1 > 1 || result.v1 > 1
    || result.u1 <= result.u0 || result.v1 <= result.v0) {
    throw new RangeError('normalizedCrop must be a non-empty rectangle inside [0,1]');
  }
  return Object.freeze(result);
}

function freezePlan(plan) {
  return Object.freeze({ ...plan });
}

function dimensionsFromPlan(plan) {
  const width = positiveInteger(plan?.width ?? plan?.targetWidth, 'targetPlan.width');
  const height = positiveInteger(plan?.height ?? plan?.targetHeight, 'targetPlan.height');
  return { width, height };
}

/**
 * Plan an integer-preserving crisp target or a source-aspect continuous one.
 */
export function planPreviewTarget({
  sourceWidth,
  sourceHeight,
  processedWidth,
  processedHeight,
  samplingKind: requestedSamplingKind,
  maxArea = MAX_MASK_PREVIEW_AREA,
  maxSide = MAX_MASK_PREVIEW_SIDE,
} = {}) {
  const sw = positiveFinite(sourceWidth, 'sourceWidth');
  const sh = positiveFinite(sourceHeight, 'sourceHeight');
  const pw = positiveInteger(processedWidth, 'processedWidth');
  const ph = positiveInteger(processedHeight, 'processedHeight');
  const kind = samplingKind(requestedSamplingKind);
  const areaLimit = positiveFinite(maxArea, 'maxArea');
  const sideLimit = positiveFinite(maxSide, 'maxSide');

  if (kind === SAMPLING_CRISP) {
    const kArea = Math.floor(Math.sqrt(areaLimit / (pw * ph)));
    const kSide = Math.floor(Math.min(sideLimit / pw, sideLimit / ph));
    const kNative = Math.floor(Math.min(sw / pw, sh / ph));
    const integerScale = Math.max(1, Math.min(kArea, kSide, Math.max(1, kNative)));
    const width = pw * integerScale;
    const height = ph * integerScale;
    const withinLimits = width * height <= areaLimit && width <= sideLimit && height <= sideLimit;
    return freezePlan({
      samplingKind: kind,
      sourceWidth: sw,
      sourceHeight: sh,
      processedWidth: pw,
      processedHeight: ph,
      width,
      height,
      targetWidth: width,
      targetHeight: height,
      integerScale,
      kArea,
      kSide,
      kNative,
      maxArea: areaLimit,
      maxSide: sideLimit,
      withinLimits,
      requiresUpstreamReduction: !withinLimits,
      processedFallback: false,
    });
  }

  const capScale = Math.min(
    Math.sqrt(areaLimit / (sw * sh)),
    sideLimit / sw,
    sideLimit / sh,
  );
  const baseScale = Math.min(1, capScale);
  const needScale = Math.max(pw / sw, ph / sh);
  const scale = Math.min(Math.max(baseScale, needScale), capScale);
  const width = Math.max(1, Math.round(sw * scale));
  const height = Math.max(1, Math.round(sh * scale));
  return freezePlan({
    samplingKind: kind,
    sourceWidth: sw,
    sourceHeight: sh,
    processedWidth: pw,
    processedHeight: ph,
    width,
    height,
    targetWidth: width,
    targetHeight: height,
    integerScale: null,
    capScale,
    baseScale,
    needScale,
    scale,
    maxArea: areaLimit,
    maxSide: sideLimit,
    withinLimits: width * height <= areaLimit && width <= sideLimit && height <= sideLimit,
    requiresUpstreamReduction: false,
    processedFallback: needScale > capScale,
  });
}

/** Plan the maximum upstream crisp render grid before Engine allocation. */
export function planUpstreamRender({
  requestedWidth,
  requestedHeight,
  maxArea = MAX_MASK_PREVIEW_AREA,
  maxSide = MAX_MASK_PREVIEW_SIDE,
} = {}) {
  const width = positiveInteger(requestedWidth, 'requestedWidth');
  const height = positiveInteger(requestedHeight, 'requestedHeight');
  const areaLimit = positiveFinite(maxArea, 'maxArea');
  const sideLimit = positiveFinite(maxSide, 'maxSide');
  const gridScale = Math.min(
    1,
    Math.sqrt(areaLimit / (width * height)),
    sideLimit / width,
    sideLimit / height,
  );
  const plannedWidth = Math.max(1, Math.floor(width * gridScale));
  const plannedHeight = Math.max(1, Math.floor(height * gridScale));
  return freezePlan({
    requestedWidth: width,
    requestedHeight: height,
    gridScale,
    width: plannedWidth,
    height: plannedHeight,
    plannedWidth,
    plannedHeight,
    maxOutputPixels: areaLimit,
    maxOutputSide: sideLimit,
    reduced: plannedWidth !== width || plannedHeight !== height,
  });
}

const TOKEN_FIELDS = Object.freeze([
  'sourceEpoch',
  'frameId',
  'effectRevision',
  'targetRevision',
  'samplingKind',
]);

export function sameRenderToken(left, right) {
  return !!left && !!right && TOKEN_FIELDS.every((field) => left[field] === right[field]);
}

/**
 * Generation checks intentionally ignore frameId unless the caller supplies
 * one. A worker frame may remain valid while a newer decoded frame is pending,
 * but its source/effect/target/sampling generations may not.
 */
export function tokenMatchesGenerations(token, generations) {
  if (!token || !generations) return false;
  const fields = ['sourceEpoch', 'effectRevision', 'targetRevision', 'samplingKind'];
  if (Object.prototype.hasOwnProperty.call(generations, 'frameId')) fields.push('frameId');
  return fields.every((field) => token[field] === generations[field]);
}

export function grainPhaseForFrame(frameId, period = 128) {
  const divisor = positiveInteger(period, 'period');
  const frame = Number(frameId);
  if (!Number.isSafeInteger(frame)) throw new TypeError('frameId must be a safe integer');
  return ((frame % divisor) + divisor) % divisor / divisor;
}

function canvasBytes(canvas) {
  if (!canvas) return 0;
  const width = Number(canvas.width);
  const height = Number(canvas.height);
  return Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0
    ? width * height * 4
    : 0;
}

function bundleBytes(bundle) {
  return canvasBytes(bundle?.rawTarget) + canvasBytes(bundle?.processedTarget);
}

/**
 * Conservative preview peak estimator. `extraBytes` is where callers include
 * mask caches, compositor/overlay scratch, and persistent Post-FX surfaces.
 */
export function estimatePreviewPeakBytes({
  targetPlan,
  currentBundle = null,
  inFlightRaw = null,
  prospectiveSurfaceCount = 2,
  extraBytes = 0,
} = {}) {
  const { width, height } = dimensionsFromPlan(targetPlan);
  const perSurfaceBytes = width * height * 4;
  const currentBundleBytes = bundleBytes(currentBundle);
  const inFlightRawBytes = canvasBytes(inFlightRaw?.rawTarget ?? inFlightRaw);
  const prospectiveBytes = perSurfaceBytes * Math.max(0, Number(prospectiveSurfaceCount) || 0);
  const auxiliaryBytes = Math.max(0, Number(extraBytes) || 0);
  const totalBytes = currentBundleBytes + inFlightRawBytes + prospectiveBytes + auxiliaryBytes;
  return Object.freeze({
    totalBytes,
    currentBundleBytes,
    inFlightRawBytes,
    prospectiveBytes,
    auxiliaryBytes,
    perSurfaceBytes,
  });
}

const nonNegativeBytes = (value, name) => {
  const bytes = Number(value ?? 0);
  if (!Number.isFinite(bytes) || bytes < 0) throw new RangeError(`${name} must be non-negative`);
  return Math.floor(bytes);
};

/**
 * Aggregate Effect Mask preview accounting. Raster cache bytes are separated
 * because they are the first evictable tier; every other field is treated as
 * non-evictable for the pending atomic publication.
 */
export function estimateMaskSubsystemPeakBytes({
  targetPlan,
  currentBundle = null,
  inFlightRaw = null,
  prospectiveSurfaceCount = 2,
  rasterCacheBytes = 0,
  outputBytes = 0,
  draftBytes = 0,
  transientRasterBytes = 0,
  compositorBytes = 0,
  postFXBytes = 0,
  otherBytes = 0,
  previewByteLimit = MAX_MASK_SUBSYSTEM_PREVIEW_BYTES,
} = {}) {
  const bundleEstimate = estimatePreviewPeakBytes({
    targetPlan,
    currentBundle,
    inFlightRaw,
    prospectiveSurfaceCount,
  });
  const cacheBytes = nonNegativeBytes(rasterCacheBytes, 'rasterCacheBytes');
  const output = nonNegativeBytes(outputBytes, 'outputBytes');
  const draft = nonNegativeBytes(draftBytes, 'draftBytes');
  const transientRaster = nonNegativeBytes(transientRasterBytes, 'transientRasterBytes');
  const compositor = nonNegativeBytes(compositorBytes, 'compositorBytes');
  const postFX = nonNegativeBytes(postFXBytes, 'postFXBytes');
  const other = nonNegativeBytes(otherBytes, 'otherBytes');
  const limitBytes = nonNegativeBytes(previewByteLimit, 'previewByteLimit');
  const nonCacheAuxiliaryBytes = output + draft + transientRaster + compositor + postFX + other;
  const nonCacheBytes = bundleEstimate.totalBytes + nonCacheAuxiliaryBytes;
  const totalBytes = nonCacheBytes + cacheBytes;
  const rasterCacheAllowanceBytes = Math.max(0, limitBytes - nonCacheBytes);
  const retainedRasterCacheBytes = Math.min(cacheBytes, rasterCacheAllowanceBytes);
  return Object.freeze({
    totalBytes,
    limitBytes,
    overLimitBytes: Math.max(0, totalBytes - limitBytes),
    nonCacheBytes,
    nonCacheOverLimitBytes: Math.max(0, nonCacheBytes - limitBytes),
    nonCacheAuxiliaryBytes,
    rasterCacheBytes: cacheBytes,
    rasterCacheAllowanceBytes,
    retainedRasterCacheBytes,
    requiredRasterEvictionBytes: Math.max(0, cacheBytes - rasterCacheAllowanceBytes),
    projectedTotalBytesAfterTrim: nonCacheBytes + retainedRasterCacheBytes,
    fitsAfterRasterTrim: nonCacheBytes <= limitBytes,
    bundlePeakBytes: bundleEstimate.totalBytes,
    currentBundleBytes: bundleEstimate.currentBundleBytes,
    inFlightRawBytes: bundleEstimate.inFlightRawBytes,
    prospectiveBytes: bundleEstimate.prospectiveBytes,
    perSurfaceBytes: bundleEstimate.perSurfaceBytes,
    outputBytes: output,
    draftBytes: draft,
    transientRasterBytes: transientRaster,
    compositorBytes: compositor,
    postFXBytes: postFX,
    otherBytes: other,
    // Re-run after trimming, then pass this to FrameBundleManager's existing
    // `extraPeakBytes` input.
    accountedExtraBytes: cacheBytes + nonCacheAuxiliaryBytes,
    accountedExtraBytesAfterTrim: retainedRasterCacheBytes + nonCacheAuxiliaryBytes,
  });
}

function releaseCanvas(canvas) {
  if (!canvas) return;
  try {
    canvas.width = 0;
    canvas.height = 0;
  } catch {
    // Best-effort release for host canvas implementations.
  }
}

function releaseBundle(bundle) {
  if (!bundle) return;
  releaseCanvas(bundle.rawTarget);
  if (bundle.processedTarget !== bundle.rawTarget) releaseCanvas(bundle.processedTarget);
}

function context2d(canvas, label) {
  const context = canvas?.getContext?.('2d');
  if (!context) throw new Error(`Could not acquire ${label} 2D context`);
  return context;
}

function resetContext(context, smoothing) {
  context.setTransform?.(1, 0, 0, 1, 0, 0);
  context.globalAlpha = 1;
  context.globalCompositeOperation = 'source-over';
  context.filter = 'none';
  context.imageSmoothingEnabled = smoothing;
  if ('imageSmoothingQuality' in context) context.imageSmoothingQuality = 'high';
}

function withSavedContext(context, callback) {
  context.save?.();
  try {
    return callback();
  } finally {
    context.restore?.();
  }
}

function drawCropped(context, source, crop, width, height, smoothing, intrinsicDimensions = null) {
  const sourceWidth = positiveFinite(intrinsicDimensions?.width ?? source?.width, 'source.width');
  const sourceHeight = positiveFinite(intrinsicDimensions?.height ?? source?.height, 'source.height');
  withSavedContext(context, () => {
    resetContext(context, smoothing);
    context.globalCompositeOperation = 'copy';
    context.drawImage(
      source,
      crop.u0 * sourceWidth,
      crop.v0 * sourceHeight,
      (crop.u1 - crop.u0) * sourceWidth,
      (crop.v1 - crop.v0) * sourceHeight,
      0,
      0,
      width,
      height,
    );
  });
}

function descriptorFor(canvas, descriptor, fallbackSamplingKind) {
  const width = positiveInteger(descriptor?.width ?? canvas?.width, 'descriptor.width');
  const height = positiveInteger(descriptor?.height ?? canvas?.height, 'descriptor.height');
  if (canvas?.width !== width || canvas?.height !== height) {
    throw new RangeError('render descriptor dimensions do not match the borrowed processed canvas');
  }
  return Object.freeze({
    width,
    height,
    samplingKind: samplingKind(descriptor?.samplingKind ?? fallbackSamplingKind),
    asciiGridInfo: descriptor?.asciiGridInfo ? Object.freeze({ ...descriptor.asciiGridInfo }) : null,
  });
}

function assertToken(token) {
  if (!token || !TOKEN_FIELDS.every((field) => Object.prototype.hasOwnProperty.call(token, field))) {
    throw new TypeError(`render token requires ${TOKEN_FIELDS.join(', ')}`);
  }
  samplingKind(token.samplingKind);
  return Object.freeze({ ...token });
}

function normalizedTargetPlan(plan, token) {
  const { width, height } = dimensionsFromPlan(plan);
  const kind = samplingKind(plan.samplingKind ?? token.samplingKind);
  if (kind !== token.samplingKind) throw new RangeError('target plan and token sampling kinds differ');
  if (plan.targetRevision != null && plan.targetRevision !== token.targetRevision) {
    throw new RangeError('target plan and token revisions differ');
  }
  return freezePlan({
    ...plan,
    width,
    height,
    targetWidth: width,
    targetHeight: height,
    samplingKind: kind,
    targetRevision: token.targetRevision,
  });
}

function assertDescriptorCompatible(descriptor, targetPlan) {
  if (descriptor.samplingKind !== targetPlan.samplingKind) {
    throw new RangeError('accepted result sampling kind changed');
  }
  if (targetPlan.samplingKind !== SAMPLING_CRISP) return;
  const scaleX = targetPlan.width / descriptor.width;
  const scaleY = targetPlan.height / descriptor.height;
  if (!Number.isSafeInteger(scaleX) || scaleX < 1 || scaleX !== scaleY) {
    throw new RangeError('crisp result cannot be fractionally resampled into the target plan');
  }
  if (targetPlan.integerScale != null && scaleX !== targetPlan.integerScale) {
    throw new RangeError('crisp result no longer matches the frozen integer scale');
  }
}

function targetSignature(plan) {
  return [
    plan.samplingKind,
    plan.width,
    plan.height,
    plan.integerScale ?? '',
    plan.upstreamWidth ?? '',
    plan.upstreamHeight ?? '',
    plan.liveBudget ?? '',
    plan.ssCap ?? '',
    plan.governorLevel ?? '',
  ].join('|');
}

function normalizePostFXPlan(plan, token, targetHeight) {
  if (!plan) {
    return Object.freeze({ fx: null, options: Object.freeze({
      grainPhase: grainPhaseForFrame(token.frameId),
      refH: targetHeight,
    }) });
  }
  const hasEnvelope = Object.prototype.hasOwnProperty.call(plan, 'fx')
    || Object.prototype.hasOwnProperty.call(plan, 'options')
    || Object.prototype.hasOwnProperty.call(plan, 'grainPhase')
    || Object.prototype.hasOwnProperty.call(plan, 'refH')
    || Object.prototype.hasOwnProperty.call(plan, 'fast');
  const fx = hasEnvelope ? (plan.fx ?? null) : plan;
  const supplied = hasEnvelope ? (plan.options ?? {}) : {};
  const options = Object.freeze({
    ...supplied,
    grainPhase: plan.grainPhase ?? supplied.grainPhase ?? grainPhaseForFrame(token.frameId),
    refH: plan.refH ?? supplied.refH ?? targetHeight,
    ...(plan.fast == null ? null : { fast: !!plan.fast }),
  });
  return Object.freeze({ fx, options });
}

function snapshotPostFXPlan(plan, token, targetHeight) {
  const normalized = normalizePostFXPlan(plan, token, targetHeight);
  const fx = normalized.fx && typeof normalized.fx === 'object'
    ? Object.freeze({ ...normalized.fx })
    : normalized.fx;
  return Object.freeze({ fx, options: Object.freeze({ ...normalized.options }) });
}

export class FrameBundleManager {
  constructor({
    createCanvas = defaultCanvasFactory,
    applyPostFX = (canvas) => canvas,
    previewByteLimit = MAX_MASK_SUBSYSTEM_PREVIEW_BYTES,
  } = {}) {
    if (typeof createCanvas !== 'function') throw new TypeError('createCanvas must be a function');
    if (typeof applyPostFX !== 'function') throw new TypeError('applyPostFX must be a function');
    this.createCanvas = createCanvas;
    this.applyPostFX = applyPostFX;
    this.previewByteLimit = positiveFinite(previewByteLimit, 'previewByteLimit');
    this.current = null;
    this.inFlight = null;
    this.targetPlan = null;
    this.targetRevision = 0;
    this._targetSignature = null;
    this._lockedTargetPlan = null;
    this.invalidatedReason = null;
  }

  _allocate(width, height, label) {
    const canvas = this.createCanvas(width, height);
    canvas.width = width;
    canvas.height = height;
    if (canvas.width !== width || canvas.height !== height) {
      releaseCanvas(canvas);
      throw new Error(`${label} allocation failed at ${width}x${height}`);
    }
    context2d(canvas, label);
    return canvas;
  }

  _preflight(targetPlan, prospectiveSurfaceCount, extraBytes = 0, inFlightRaw = this.inFlight) {
    const estimate = estimatePreviewPeakBytes({
      targetPlan,
      currentBundle: this.current,
      inFlightRaw,
      prospectiveSurfaceCount,
      extraBytes,
    });
    if (estimate.totalBytes > this.previewByteLimit) {
      const error = new RangeError('Mask preview memory limit exceeded');
      error.code = 'MASK_PREVIEW_MEMORY_LIMIT';
      error.estimate = estimate;
      throw error;
    }
    return estimate;
  }

  _normalizeTargetPlan(plan, token) {
    const normalized = normalizedTargetPlan(plan, token);
    if (!this._lockedTargetPlan) return normalized;
    const locked = this._lockedTargetPlan;
    if (normalized.width !== locked.width
      || normalized.height !== locked.height
      || normalized.samplingKind !== locked.samplingKind
      || normalized.targetRevision !== locked.targetRevision
      || (locked.integerScale != null && normalized.integerScale !== locked.integerScale)) {
      throw new RangeError('result does not match the locked recording target plan');
    }
    return normalized;
  }

  resolveTarget(request) {
    if (this._lockedTargetPlan) return this._lockedTargetPlan;
    const candidate = planPreviewTarget(request);
    const signature = targetSignature(candidate);
    if (signature !== this._targetSignature) {
      this.targetRevision++;
      this._targetSignature = signature;
    }
    this.targetPlan = freezePlan({ ...candidate, targetRevision: this.targetRevision });
    return this.targetPlan;
  }

  lockTarget(plan = this.targetPlan) {
    if (!plan) throw new Error('No target plan is available to lock');
    const token = {
      sourceEpoch: 0,
      frameId: 0,
      effectRevision: 0,
      targetRevision: plan.targetRevision ?? this.targetRevision,
      samplingKind: plan.samplingKind,
    };
    this._lockedTargetPlan = normalizedTargetPlan(plan, token);
    this.targetPlan = this._lockedTargetPlan;
    return this._lockedTargetPlan;
  }

  unlockTarget() {
    const old = this._lockedTargetPlan;
    this._lockedTargetPlan = null;
    return old;
  }

  get targetLocked() {
    return this._lockedTargetPlan !== null;
  }

  _captureRaw({ rawSource, sourceWidth, sourceHeight, targetPlan, normalizedCrop: crop }) {
    const { width, height } = dimensionsFromPlan(targetPlan);
    const rawTarget = this._allocate(width, height, 'raw target');
    try {
      drawCropped(
        context2d(rawTarget, 'raw target'),
        rawSource,
        crop,
        width,
        height,
        true,
        {
          width: positiveFinite(sourceWidth, 'sourceWidth'),
          height: positiveFinite(sourceHeight, 'sourceHeight'),
        },
      );
      return rawTarget;
    } catch (error) {
      releaseCanvas(rawTarget);
      throw error;
    }
  }

  _captureProcessed({ borrowedProcessed, descriptor, targetPlan, crop, token, postFXPlan }) {
    const { width, height } = dimensionsFromPlan(targetPlan);
    const acceptedDescriptor = descriptorFor(borrowedProcessed, descriptor, token.samplingKind);
    assertDescriptorCompatible(acceptedDescriptor, targetPlan);
    let stage = this._allocate(width, height, 'processed target stage');
    let owned = null;
    try {
      drawCropped(
        context2d(stage, 'processed target stage'),
        borrowedProcessed,
        crop,
        width,
        height,
        targetPlan.samplingKind === SAMPLING_CONTINUOUS,
      );
      const fxPlan = normalizePostFXPlan(postFXPlan, token, height);
      const fxResult = this.applyPostFX(stage, fxPlan.fx, fxPlan.options);
      if (!fxResult) throw new Error('Post-FX returned no canvas');
      if (fxResult === stage) return { processedTarget: stage, descriptor: acceptedDescriptor, grainPhase: fxPlan.options.grainPhase };
      if (fxResult.width !== width || fxResult.height !== height) {
        throw new RangeError('Post-FX result dimensions changed');
      }
      owned = this._allocate(width, height, 'owned processed target');
      drawCropped(context2d(owned, 'owned processed target'), fxResult, FULL_CROP, width, height, false);
      releaseCanvas(stage);
      stage = null;
      return { processedTarget: owned, descriptor: acceptedDescriptor, grainPhase: fxPlan.options.grainPhase };
    } catch (error) {
      releaseCanvas(stage);
      releaseCanvas(owned);
      throw error;
    }
  }

  _makeBundle({ token, descriptor, targetPlan, rawTarget, processedTarget, sourceWidth, sourceHeight, crop, grainPhase }) {
    return Object.freeze({
      token,
      sourceWidth: positiveFinite(sourceWidth, 'sourceWidth'),
      sourceHeight: positiveFinite(sourceHeight, 'sourceHeight'),
      normalizedCrop: crop,
      targetWidth: targetPlan.width,
      targetHeight: targetPlan.height,
      processedTarget,
      rawTarget,
      asciiGridInfo: descriptor.asciiGridInfo,
      grainPhase,
    });
  }

  _publish(bundle) {
    const previous = this.current;
    this.current = bundle;
    this.invalidatedReason = null;
    releaseBundle(previous);
    return bundle;
  }

  buildSynchronous({
    borrowedProcessed,
    descriptor,
    token: rawToken,
    targetPlan: rawTargetPlan,
    rawSource,
    sourceWidth,
    sourceHeight,
    normalizedCrop: rawCrop = FULL_CROP,
    postFXPlan = null,
    extraPeakBytes = 0,
  } = {}) {
    const token = assertToken(rawToken);
    const targetPlan = this._normalizeTargetPlan(rawTargetPlan, token);
    const crop = normalizedCrop(rawCrop);
    this._preflight(targetPlan, 3, extraPeakBytes);
    this._releaseInFlight();

    let rawTarget = null;
    let processedTarget = null;
    try {
      rawTarget = this._captureRaw({
        rawSource,
        sourceWidth,
        sourceHeight,
        targetPlan,
        normalizedCrop: crop,
      });
      const processed = this._captureProcessed({
        borrowedProcessed,
        descriptor,
        targetPlan,
        crop,
        token,
        postFXPlan,
      });
      processedTarget = processed.processedTarget;
      const bundle = this._makeBundle({
        token,
        descriptor: processed.descriptor,
        targetPlan,
        rawTarget,
        processedTarget,
        sourceWidth,
        sourceHeight,
        crop,
        grainPhase: processed.grainPhase,
      });
      rawTarget = null;
      processedTarget = null;
      return this._publish(bundle);
    } catch (error) {
      releaseCanvas(rawTarget);
      releaseCanvas(processedTarget);
      throw error;
    }
  }

  acceptAsync({
    acceptedJob,
    rawSource,
    sourceWidth,
    sourceHeight,
    normalizedCrop: rawCrop = FULL_CROP,
    postFXPlan = null,
    extraPeakBytes = 0,
  } = {}) {
    if (!acceptedJob) return null;
    const token = assertToken(acceptedJob.token);
    const targetPlan = this._normalizeTargetPlan(acceptedJob.targetPlan, token);
    const crop = normalizedCrop(rawCrop);
    if (this.inFlight) {
      if (sameRenderToken(this.inFlight.token, token)) return this.inFlight;
      throw new Error('An async raw snapshot is already in flight');
    }
    this._preflight(targetPlan, 1, extraPeakBytes, null);
    const rawTarget = this._captureRaw({
      rawSource,
      sourceWidth,
      sourceHeight,
      targetPlan,
      normalizedCrop: crop,
    });
    this.inFlight = Object.freeze({
      token,
      targetPlan,
      rawTarget,
      sourceWidth: positiveFinite(sourceWidth, 'sourceWidth'),
      sourceHeight: positiveFinite(sourceHeight, 'sourceHeight'),
      normalizedCrop: crop,
      postFXPlan: snapshotPostFXPlan(postFXPlan, token, targetPlan.height),
      extraPeakBytes: Math.max(0, Number(extraPeakBytes) || 0),
    });
    return this.inFlight;
  }

  commitAsync({ committedResult, currentGenerations = null, extraPeakBytes = null } = {}) {
    if (!committedResult || !this.inFlight) return null;
    const committedToken = assertToken(committedResult.token);
    if (!sameRenderToken(committedToken, this.inFlight.token)) return null;
    const accepted = this.inFlight;
    this.inFlight = null;
    if (currentGenerations && !tokenMatchesGenerations(committedToken, currentGenerations)) {
      releaseCanvas(accepted.rawTarget);
      return null;
    }

    let processedTarget = null;
    try {
      const refreshedExtraPeakBytes = extraPeakBytes == null
        ? accepted.extraPeakBytes
        : Math.max(0, Number(extraPeakBytes) || 0);
      this._preflight(accepted.targetPlan, 2, refreshedExtraPeakBytes, accepted.rawTarget);
      const processed = this._captureProcessed({
        borrowedProcessed: committedResult.canvas,
        descriptor: committedResult.descriptor,
        targetPlan: accepted.targetPlan,
        crop: accepted.normalizedCrop,
        token: committedToken,
        postFXPlan: accepted.postFXPlan,
      });
      processedTarget = processed.processedTarget;
      const bundle = this._makeBundle({
        token: committedToken,
        descriptor: processed.descriptor,
        targetPlan: accepted.targetPlan,
        rawTarget: accepted.rawTarget,
        processedTarget,
        sourceWidth: accepted.sourceWidth,
        sourceHeight: accepted.sourceHeight,
        crop: accepted.normalizedCrop,
        grainPhase: processed.grainPhase,
      });
      processedTarget = null;
      return this._publish(bundle);
    } catch (error) {
      releaseCanvas(accepted.rawTarget);
      releaseCanvas(processedTarget);
      throw error;
    }
  }

  _releaseInFlight() {
    if (!this.inFlight) return;
    releaseCanvas(this.inFlight.rawTarget);
    this.inFlight = null;
  }

  invalidate(reason = 'invalidated', { releaseCurrent = true } = {}) {
    this.invalidatedReason = String(reason);
    this._releaseInFlight();
    if (releaseCurrent) {
      releaseBundle(this.current);
      this.current = null;
    }
  }

  release() {
    this.invalidate('released');
    this.unlockTarget();
    this.targetPlan = null;
    this._targetSignature = null;
  }
}
