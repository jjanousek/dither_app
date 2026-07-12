// App bootstrap: state, render loop, viewport, history, source management,
// exports, preset thumbnails, UI wiring.

import { Engine, getAlgorithm } from './engine/engine.js';
import { createState, applyParams, resetState, DEFAULTS } from './state.js';
import { getPalette } from './palettes.js';
import { RAMPS, FONTS } from './engine/ascii.js';
import { applyPostFX, estimatePostFXBytes, releasePostFXBuffers } from './effects/postfx.js';
import { PRESETS, shuffleParams } from './presets.js';
import { loadFile, openWebcam, demoImage, demoPhoto, bindDropAndPaste } from './sources.js';
import { exportText, buildAnsi, buildHtml, VideoExporter, exportGIF, downloadBlob, canFrameExport, exportVideoFrameAccurate, exportLoopFrameAccurate } from './export/exporters.js';
import { buildPanel, buildPresetStrip, clearActivePreset, toast } from './ui.js';
import { Viewport } from './view.js';
import { GenerativeSource } from './generate.js';
import { LIVE_CPU_DITHER_BUDGETS, liveCpuDitherBudget } from './preview-policy.js';
import {
  MASK_LIMITS,
  MaskRevisionStore,
  createStroke,
  simplifyStrokePoints,
} from './mask/model.js';
import {
  MaskRasterizer,
  CONTINUOUS_QUANTIZATION,
  estimateRasterAllocationBytes,
} from './mask/rasterizer.js';
import { MaskCompositor } from './mask/compositor.js';
import { MaskEditor } from './mask/tools.js';
import { syncRangeProgress } from './range-progress.js';
import {
  FrameBundleManager,
  MAX_MASK_PREVIEW_AREA,
  MAX_MASK_PREVIEW_SIDE,
  MAX_MASK_SUBSYSTEM_PREVIEW_BYTES,
  estimateMaskSubsystemPeakBytes,
  grainPhaseForFrame,
} from './frame-bundle.js';

const MAX_LIVE_PIXELS = LIVE_CPU_DITHER_BUDGETS.balanced; // cells / non-shape ASCII
const MAX_LIVE_CPU_PIXELS = LIVE_CPU_DITHER_BUDGETS.coarse; // shape ASCII / coarse CPU dither
const MAX_LIVE_GPU_PIXELS = 2_250_000; // GPU dithers are cheap at any size — enough for true native 1080p (2.07MP)
const MAX_STILL_PREVIEW_PIXELS = 1_250_000; // high-detail stills; bounded below runaway source sizes
const LIVE_FX_PIXELS = 2_250_000;  // cap on the live post-FX compositing area (Canvas2D raster)
const EXPORT_PIXELS = 1_600_000;   // GIF/text exports render finer than the live preview
const MAX_EXPORT_SIDE = 16384;     // canvas hard limits (Chromium/WebKit)
const MAX_EXPORT_AREA = 64_000_000;
const MAX_MASKED_EXPORT_AREA = 12_000_000;
const MAX_MASKED_EXPORT_SIDE = 8_192;
const MAX_MASKED_EXPORT_WORKING_BYTES = 512 * 1024 * 1024;
// Final exports retain their full target policy. Live masked motion is a much
// heavier pipeline (raw copy + processed copy + mask blend), so use a stable
// 720p-class target and a 540p-class editing target instead of rebuilding five
// full-HD surfaces for every decoded frame.
const MAX_MASKED_MOTION_AREA = 921_600;
const MAX_MASKED_EDIT_AREA = 518_400;
const canRecord = typeof HTMLCanvasElement !== 'undefined'
  && typeof HTMLCanvasElement.prototype.captureStream === 'function'
  && !!window.MediaRecorder;

const $ = (id) => document.getElementById(id);
const out = $('output');
const octx = out.getContext('2d');
const cmp = $('compare-canvas');
const cctx = cmp.getContext('2d');

const engine = new Engine();
const thumbEngine = new Engine();
// GPU-dithered masked video can stay entirely on the browser compositor: the
// WebGL result is displayed directly underneath a transparent raw-mask layer.
// Slow/CPU/cell paths continue using the exact owned-canvas compositor.
const maskEffectPreview = engine.glCanvas;
maskEffectPreview.id = 'mask-effect-preview';
maskEffectPreview.hidden = true;
out.before(maskEffectPreview);
const state = createState();
const maskStore = new MaskRevisionStore();
const maskRasterizer = new MaskRasterizer();
const maskCompositor = new MaskCompositor();
const frameBundles = new FrameBundleManager({ applyPostFX });
let maskRevisionId = maskStore.createInitial();
const EXPORT_DEFAULTS = Object.freeze({ pngSize: 'source', gifSize: '480', recordSeconds: '5', txtFormat: 'plain' });
const exportSettings = { ...EXPORT_DEFAULTS };

let source = null;
let sourceLoadToken = 0;
let dirty = true;
let maskDirty = false;
let overlayDirty = true;
let maskDraft = null;
let liveMaskSession = null;
let appliedMaskDraft = null;
let fastMaskPreview = null;
let liveDraftStrokeId = null;
let draftEffectCanvas = null;
let sourceEpoch = 0;
let frameId = 0;
let effectRevision = 0;
let transportRevision = 0;
let maskPriming = false;
let maskPrimingPromise = null;
let maskPrimeGeneration = 0;
let maskPrimeGuard = null;
let activeExportMaskRasterizer = null;
let activeMaskedVideoPlan = null;
let effectRenderMs = 0;
let bundleBuildMs = 0;
let maskCompositeMs = 0;
let comparing = false;
let exporting = false;
let scrubbing = false;
let fpsEma = 0;
let lastFrameT = 0;
let fpsText = '';
let lastStatusT = 0;
// Sustained-load governor: if a smoothed video render can't keep up, pull the
// supersample factor down BEFORE touching base resolution — dropping
// resolution is the opposite of what someone complaining about grain wants.
// Two signals, because neither alone sees everything:
// - renderMsEma (main-thread wall time of renderOnce) catches CPU-bound loads
//   (software decode, CSS filters, CPU dither paths). It does NOT see GPU
//   cost: on Chromium, drawImage(glCanvas) only queues a deferred GPU-side
//   copy, so a GPU-saturated frame still measures a few ms here.
// - dropped-frame ratio from rVFC metadata catches GPU-bound loads: when the
//   GPU falls behind, rAF (and with it rVFC) is throttled by compositor
//   backpressure, callbacks coalesce, and presentedFrames jumps by >1 per
//   callback — i.e. video frames were composited that we never re-dithered.
//   Measuring the ratio (not a frame rate) keeps a healthy 24fps clip looking
//   healthy on a 60Hz display.
// Dwell timers on both edges so a single hitchy frame never flips quality.
let renderMsEma = 0;
let pumpFramesEma = 0;   // EMA of presentedFrames per rVFC callback (1 = we see every frame)
let lastPumpT = 0;
let govSlowMs = 0;       // time spent continuously in the "falling behind" state
let govFastMs = 0;       // time spent continuously in the "keeping up" state
let govLastT = 0;        // governor's own wall clock — dwell must survive >250ms frames
let govMuteMs = 0;       // time at level 1 with bad cadence but cheap renders
let govCadenceMuted = false; // dropping ss didn't clear the drops -> display/decode-limited
let govRecoverMs = 1500; // recovery dwell; doubles per degrade to damp slow flip-flop
let governorLevel = 0;   // 0 full, 1 cap ss<=1
let governorSsCap = 3;
// A playing video/webcam decodes at ~24–30 fps, but the rAF loop ticks ~60;
// re-dithering the same frame is wasted work. requestVideoFrameCallback sets
// this only when a genuinely new frame is decoded, so we render each once.
let videoFrameReady = false;
const HAS_RVFC = typeof HTMLVideoElement !== 'undefined'
  && 'requestVideoFrameCallback' in HTMLVideoElement.prototype;
// An async CPU-dither result landed: wake the loop for one more render. That
// render draws whatever the CURRENT mode is (so it never blindly re-shows a
// stale worker frame), and — because it carries contentNew=false — the CPU
// preview presents the committed result instead of re-dispatching it.
let cpuResultReady = false;
engine.onCpuResult = () => { cpuResultReady = true; };

// animation clock: phase in 0..1, wraps once per cycle
let animPhase = 0;
let phaseOverride = null;    // exporters pin the effect-animation phase
let genPhaseOverride = null; // exporters pin the generative-scene phase
let lastLoopT = 0;
const isAnimating = () => {
  const s = state.anim.style;
  if (s === 'none') return false;
  if (s === 'flow' || s === 'shimmer') {
    // these drift the pattern of ordered/noise/halftone dithers; on every
    // other mode/algorithm they are no-ops — don't burn a core on them
    return state.mode === 'dither' && getAlgorithm(state.algorithm).type === 'gpu';
  }
  return true;
};

// generative scene source (lazy — created on first Generate click)
let gen = null;
const GEN_CYCLES_PER_SEC = 0.125; // at speed 1× a scene loops every 8s

// Post-FX grain determinism: exports/thumbnails must be reproducible and
// baked loops must wrap; live video keeps the free-running legacy counter.
function currentGrainPhase() {
  if (source?.type === 'gen') return genPhaseOverride ?? source.gen.phase;
  if (phaseOverride !== null) return phaseOverride;
  if (isAnimating()) return animPhase;
  return source?.type === 'image' ? 0 : null;
}

// reusable upscale canvas for post-FX over pixelated results
const upCanvas = document.createElement('canvas');
const upCtx = upCanvas.getContext('2d');

// ---------------------------------------------------------------------------
// viewport (zoom / pan / split)
// ---------------------------------------------------------------------------
const view = new Viewport({
  viewport: $('viewport'),
  stack: $('canvas-stack'),
  output: out,
  divider: $('split-divider'),
  onChange: (zoom) => {
    $('zoom-readout').textContent = `${Math.round(zoom * 100)}%`;
    updateStatus();
  },
});
view.onSplitDrag = () => drawSplitOverlay();

const maskEditor = new MaskEditor({
  view,
  callbacks: {
    onBeginDiscreteEdit: () => commitHistory(),
    onDraftChanged: (draft) => setMaskDraft(draft),
    onStrokeCommitted: (stroke) => commitMaskStroke(stroke),
    onStrokeRolledBack: () => rollbackMaskDraft(),
    onPlacementRequested: (placement) => commitMaskProposal(maskStore.proposePlacement(maskRevisionId, placement)),
    onClearPaintRequested: () => commitMaskProposal(maskStore.proposeClear(maskRevisionId)),
    onEffectEverywhereRequested: () => commitMaskProposal(maskStore.proposeEffectEverywhere(maskRevisionId)),
    onOriginalEverywhereRequested: () => commitMaskProposal(maskStore.proposeOriginalEverywhere(maskRevisionId)),
    onEditingChanged: () => {
      overlayDirty = true;
      syncMaskEditor();
      dirty = true;
    },
    onCompareRequested: (active) => {
      comparing = !!active;
      if (!comparing && fastMaskPreview && maskIsActive()) {
        presentFastMaskPreview();
      } else if (!comparing && frameBundles.current && maskIsActive()) {
        presentMaskedBundle();
      } else {
        dirty = true;
      }
    },
    onMaskRepaintRequested: () => {
      overlayDirty = true;
      if (maskDraft && (frameBundles.current || fastMaskPreview)) maskDirty = true;
    },
  },
});

$('zoom-in').onclick = () => view.zoomBy(1.25);
$('zoom-out').onclick = () => view.zoomBy(1 / 1.25);
$('zoom-fit').onclick = () => view.fit();
$('zoom-readout').onclick = () => view.fit();
$('zoom-100').onclick = () => view.actualSize();

$('btn-split').onclick = () => {
  view.setSplit(!view.splitOn);
  $('btn-split').classList.toggle('active', view.splitOn);
  dirty = true;
};

// ---------------------------------------------------------------------------
// derived params: resolve palette + ramp indirections for the engine
// ---------------------------------------------------------------------------
function deriveParams(s) {
  const colors = s.paletteId === 'custom'
    ? (s.customColors.length >= 2 ? s.customColors : ['#000000', '#ffffff'])
    : getPalette(s.paletteId).colors;
  const ramp = s.ascii.rampId === 'custom'
    ? (s.ascii.customChars && [...s.ascii.customChars].length >= 2 ? s.ascii.customChars : '@ ')
    : (RAMPS[s.ascii.rampId] || RAMPS.classic).chars;
  return { ...s, colors, ascii: { ...s.ascii, chars: ramp } };
}
const derived = (captureMetadata = false) => {
  const p = deriveParams(state);
  return {
    ...p,
    ascii: { ...p.ascii, captureMetadata },
    animPhase: phaseOverride ?? animPhase,
    // still images can cache their downsampled base across animation frames
    staticSource: source?.type === 'image',
    // temporal/denoise pre-pass runs only for genuinely live sources
    liveSource: source?.type === 'video' || source?.type === 'webcam',
    // exports always render at full supersampling; only the live loop degrades
    ssCap: exporting ? 3 : governorSsCap,
  };
};

function srcDims() {
  if (!source) return [0, 0];
  const el = source.el;
  if (el instanceof HTMLVideoElement) return [el.videoWidth || source.width, el.videoHeight || source.height];
  return [source.width, source.height];
}

// ---------------------------------------------------------------------------
// effect mask model, owned bundles, and final composition
// ---------------------------------------------------------------------------
function currentMaskRevision() {
  return maskStore.get(maskRevisionId);
}

function maskUniformCoverage() {
  return maskStore.uniformEffectCoverage(maskRevisionId);
}

function maskBypassed() {
  return maskUniformCoverage() === 1 && !maskDraft;
}

function maskIsActive() {
  return !maskBypassed();
}

function fastPreviewEligible(renderedResult = null) {
  if (!renderedResult || renderedResult.canvas !== maskEffectPreview || !engine.gl) return false;
  if (exporting || maskPriming || !['video', 'webcam'].includes(source?.type)) return false;
  if (!(source.el instanceof HTMLVideoElement)) return false;
  if (state.mode !== 'dither' || getAlgorithm(state.algorithm).type !== 'gpu') return false;
  return !Object.values(state.fx).some((value) => +value > 0);
}

function hideFastMaskPreview({ release = true } = {}) {
  maskEffectPreview.hidden = true;
  maskEffectPreview.classList.remove('pixelated');
  maskEffectPreview.style.width = '';
  maskEffectPreview.style.height = '';
  out.classList.remove('mask-fast-overlay');
  if (release && fastMaskPreview?.rawTarget) {
    fastMaskPreview.rawTarget.width = 0;
    fastMaskPreview.rawTarget.height = 0;
    fastMaskPreview = null;
  }
}

function ensureFastRawTarget(width, height) {
  let rawTarget = fastMaskPreview?.rawTarget || null;
  if (!rawTarget) {
    rawTarget = typeof OffscreenCanvas !== 'undefined'
      ? new OffscreenCanvas(width, height)
      : document.createElement('canvas');
  }
  if (rawTarget.width !== width || rawTarget.height !== height) {
    rawTarget.width = width;
    rawTarget.height = height;
  }
  if (rawTarget.width !== width || rawTarget.height !== height || !rawTarget.getContext('2d')) {
    throw new Error(`fast mask raw target allocation failed at ${width}×${height}`);
  }
  return rawTarget;
}

function presentFastGpuMask(renderedResult, sourceWidth, sourceHeight, maxArea) {
  const { canvas, descriptor } = renderedResult;
  const targetPlan = resolveMaskedTarget(descriptor, sourceWidth, sourceHeight, maxArea);
  const width = targetPlan.width;
  const height = targetPlan.height;
  const started = performance.now();
  const enteringFastPath = !fastMaskPreview;
  const rawTarget = ensureFastRawTarget(width, height);
  const rawContext = rawTarget.getContext('2d');
  rawContext.save();
  try {
    rawContext.setTransform(1, 0, 0, 1, 0, 0);
    rawContext.globalAlpha = 1;
    rawContext.globalCompositeOperation = 'copy';
    rawContext.filter = 'none';
    rawContext.imageSmoothingEnabled = true;
    rawContext.imageSmoothingQuality = 'high';
    rawContext.drawImage(source.el, 0, 0, sourceWidth, sourceHeight, 0, 0, width, height);
  } finally {
    rawContext.restore();
  }

  fastMaskPreview = {
    rawTarget,
    processedTarget: canvas,
    descriptor,
    targetPlan,
    sourceWidth,
    sourceHeight,
    normalizedCrop: { u0: 0, v0: 0, u1: 1, v1: 1 },
    targetWidth: width,
    targetHeight: height,
    asciiGridInfo: null,
  };
  // The direct path owns only its one raw target. Flush paired-bundle pools
  // when entering it so dormant full-frame branch canvases do not sit beside
  // the live compositor's memory for the rest of playback.
  if (enteringFastPath) frameBundles.release();
  else if (frameBundles.current || frameBundles.inFlight) {
    frameBundles.invalidate('direct GPU mask preview');
  }
  bundleBuildMs = performance.now() - started;
  return presentFastMaskPreview();
}

function presentFastMaskPreview() {
  const preview = fastMaskPreview;
  if (!preview) return false;
  const started = performance.now();
  const width = preview.targetWidth;
  const height = preview.targetHeight;
  const uniform = maskDraft ? null : maskUniformCoverage();
  const resized = setOutputSize(width, height);
  ensureLiveMaskSessionSize(width, height);
  if (maskDraft) flushLiveMaskDraft();

  let effectCoverage = null;
  if (uniform !== 0 && uniform !== 1) {
    effectCoverage = maskDraft && liveMaskSession
      ? ensureDraftEffectCanvas(liveMaskSession.selectionCanvas(), currentMaskRevision().placement)
      : maskRasterizer.rasterFor(maskRasterRequest(preview));
  }

  octx.save();
  try {
    octx.setTransform(1, 0, 0, 1, 0, 0);
    octx.globalAlpha = 1;
    octx.filter = 'none';
    octx.imageSmoothingEnabled = true;
    octx.imageSmoothingQuality = 'high';
    if (uniform === 1) {
      octx.clearRect(0, 0, width, height);
    } else {
      octx.globalCompositeOperation = 'copy';
      octx.drawImage(preview.rawTarget, 0, 0, width, height);
      if (effectCoverage) {
        octx.globalCompositeOperation = 'destination-out';
        octx.drawImage(effectCoverage, 0, 0, width, height);
      }
    }
  } finally {
    octx.restore();
  }

  maskEffectPreview.hidden = false;
  maskEffectPreview.style.width = `${width}px`;
  maskEffectPreview.style.height = `${height}px`;
  maskEffectPreview.classList.toggle('pixelated', preview.descriptor.samplingKind === 'crisp');
  out.classList.add('mask-fast-overlay');
  out.classList.remove('pixelated');
  maskDirty = false;
  maskCompositeMs = performance.now() - started;
  if (resized) {
    overlayDirty = true;
    syncMaskEditor();
  }
  if (view.splitOn && !view.splitSuppressed && !comparing && !exporting) drawSplitOverlay();
  return true;
}

function sourceIsMoving() {
  return source?.type === 'video'
    || source?.type === 'webcam'
    || source?.type === 'animated-image'
    || source?.type === 'gen';
}

function syncMaskEditor() {
  if (!source) return;
  const [sourceWidth, sourceHeight] = srcDims();
  maskEditor.sync({
    revisionId: maskRevisionId,
    placement: currentMaskRevision()?.placement || 'outside',
    uniformCoverage: maskUniformCoverage(),
    sourceWidth,
    sourceHeight,
    outputWidth: out.width,
    outputHeight: out.height,
    mode: state.mode,
    sourceIsMoving: sourceIsMoving(),
  });
}

function maskQuantization(bundle) {
  return bundle?.asciiGridInfo
    ? { kind: 'ascii-grid', ...bundle.asciiGridInfo }
    : CONTINUOUS_QUANTIZATION;
}

function maskRasterRequest(bundle, coverageKind = 'effect') {
  return {
    sourceEpoch,
    sourceWidth: bundle.sourceWidth,
    sourceHeight: bundle.sourceHeight,
    revision: currentMaskRevision(),
    width: bundle.targetWidth,
    height: bundle.targetHeight,
    normalizedCrop: bundle.normalizedCrop,
    coverageKind,
    quantization: coverageKind === 'effect' ? maskQuantization(bundle) : CONTINUOUS_QUANTIZATION,
  };
}

function ensureDraftEffectCanvas(selectionCanvas, placement) {
  const width = selectionCanvas.width;
  const height = selectionCanvas.height;
  if (!draftEffectCanvas) draftEffectCanvas = document.createElement('canvas');
  if (draftEffectCanvas.width !== width || draftEffectCanvas.height !== height) {
    draftEffectCanvas.width = width;
    draftEffectCanvas.height = height;
  }
  const context = draftEffectCanvas.getContext('2d');
  context.save();
  try {
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.globalAlpha = 1;
    context.filter = 'none';
    if (placement === 'inside') {
      context.globalCompositeOperation = 'copy';
      context.drawImage(selectionCanvas, 0, 0, width, height);
    } else {
      context.globalCompositeOperation = 'copy';
      context.fillStyle = '#fff';
      context.fillRect(0, 0, width, height);
      context.globalCompositeOperation = 'destination-out';
      context.drawImage(selectionCanvas, 0, 0, width, height);
    }
  } finally {
    context.restore();
  }
  return draftEffectCanvas;
}

function releaseDraftEffectCanvas() {
  if (!draftEffectCanvas) return;
  draftEffectCanvas.width = 0;
  draftEffectCanvas.height = 0;
  draftEffectCanvas = null;
}

function ensureLiveMaskSessionSize(width, height) {
  if (!maskDraft || !liveMaskSession) return;
  const selection = liveMaskSession.selectionCanvas();
  if (selection.width === width && selection.height === height) return;
  liveMaskSession.rollback();
  liveMaskSession = null;
  appliedMaskDraft = null;
  flushLiveMaskDraft();
}

function flushLiveMaskDraft() {
  if (!maskDraft) return liveMaskSession;
  const session = liveMaskSession || startLiveMaskSession(maskDraft);
  if (!session) {
    maskDraft = null;
    liveDraftStrokeId = null;
    overlayDirty = true;
    queueMicrotask(() => maskEditor.cancelDraft());
    return null;
  }
  if (appliedMaskDraft === maskDraft) return session;
  try {
    session.applySegment({
      id: maskDraft.id,
      operation: maskDraft.operation,
      radiusShortNorm: maskDraft.radiusShortNorm,
      feather: maskDraft.feather,
      points: Float32Array.from(maskDraft.points),
    });
    appliedMaskDraft = maskDraft;
    return session;
  } catch (error) {
    session.rollback();
    liveMaskSession = null;
    appliedMaskDraft = null;
    maskDraft = null;
    liveDraftStrokeId = null;
    overlayDirty = true;
    toast(`Mask unavailable: ${error.message}`);
    queueMicrotask(() => maskEditor.cancelDraft());
    return null;
  }
}

function setOutputSize(width, height) {
  let resized = false;
  if (out.width !== width || out.height !== height) {
    out.width = width;
    out.height = height;
    resized = true;
  }
  if (resized) {
    maskEditor.onOutputResized(width, height);
    view.contentResized();
  }
  return resized;
}

function presentMaskedBundle(bundle = frameBundles.current) {
  if (!bundle) return false;
  hideFastMaskPreview();
  const started = performance.now();
  const uniform = maskDraft ? null : maskUniformCoverage();
  if (uniform !== 0 && uniform !== 1) {
    try {
      prepareMaskedPreviewMemory({ width: bundle.targetWidth, height: bundle.targetHeight }, {
        prospectiveSurfaceCount: 0,
        includeRasterTransient: !liveMaskSession,
        plannedOutputBytes: bundle.targetWidth * bundle.targetHeight * 8,
      });
    } catch (error) {
      console.warn('masked composition memory:', error);
      toast('Mask preview reduced by memory limit');
      return false;
    }
  }
  const resized = setOutputSize(bundle.targetWidth, bundle.targetHeight);
  ensureLiveMaskSessionSize(bundle.targetWidth, bundle.targetHeight);
  if (maskDraft) flushLiveMaskDraft();
  if (uniform === 0) {
    maskCompositor.copyRaw({ raw: bundle.rawTarget, destination: out });
  } else if (uniform === 1) {
    octx.save();
    try {
      octx.globalCompositeOperation = 'copy';
      octx.drawImage(bundle.processedTarget, 0, 0, out.width, out.height);
    } finally {
      octx.restore();
    }
  } else {
    let effectCoverage;
    if (maskDraft && liveMaskSession) {
      effectCoverage = ensureDraftEffectCanvas(
        liveMaskSession.selectionCanvas(),
        currentMaskRevision().placement,
      );
    } else {
      effectCoverage = maskRasterizer.rasterFor(maskRasterRequest(bundle));
      if (effectCoverage.width !== bundle.targetWidth || effectCoverage.height !== bundle.targetHeight) {
        console.warn('Discarding stale mask raster', {
          expected: [bundle.targetWidth, bundle.targetHeight],
          actual: [effectCoverage.width, effectCoverage.height],
        });
        maskRasterizer.invalidateRevision(maskRevisionId);
        effectCoverage = maskRasterizer.rasterFor(maskRasterRequest(bundle));
      }
    }
    if (bundle.processedTarget.width !== bundle.targetWidth
        || bundle.processedTarget.height !== bundle.targetHeight
        || bundle.rawTarget.width !== bundle.targetWidth
        || bundle.rawTarget.height !== bundle.targetHeight
        || effectCoverage.width !== bundle.processedTarget.width
        || effectCoverage.height !== bundle.processedTarget.height) {
      console.warn('Skipping inconsistent masked bundle', {
        target: [bundle.targetWidth, bundle.targetHeight],
        processed: [bundle.processedTarget.width, bundle.processedTarget.height],
        raw: [bundle.rawTarget.width, bundle.rawTarget.height],
        mask: [effectCoverage.width, effectCoverage.height],
        draft: !!maskDraft,
      });
      return false;
    }
    maskCompositor.compose({
      processed: bundle.processedTarget,
      raw: bundle.rawTarget,
      effectCoverage,
      destination: out,
    });
  }
  out.classList.remove('pixelated');
  if (view.splitOn && !view.splitSuppressed && !comparing && !exporting) drawSplitOverlay();
  maskDirty = false;
  maskCompositeMs = performance.now() - started;
  if (resized) {
    overlayDirty = true;
    syncMaskEditor();
  }
  return true;
}

function updateMaskOverlay() {
  overlayDirty = false;
  if (!maskEditor.editing || !source || !out.width || !out.height) {
    maskEditor.setOverlayRaster(null);
    return;
  }
  try {
    if (maskDraft) flushLiveMaskDraft();
    if (liveMaskSession) {
      maskEditor.setOverlayRaster(liveMaskSession.selectionCanvas());
      return;
    }
    const [sourceWidth, sourceHeight] = srcDims();
    prepareMaskedPreviewMemory({ width: out.width, height: out.height }, {
      prospectiveSurfaceCount: 0,
      includeRasterTransient: true,
      plannedOutputBytes: canvasBackingBytes(out) + canvasBackingBytes($('mask-overlay')),
    });
    const selection = maskRasterizer.rasterFor({
      sourceEpoch,
      sourceWidth,
      sourceHeight,
      revision: currentMaskRevision(),
      width: out.width,
      height: out.height,
      normalizedCrop: { u0: 0, v0: 0, u1: 1, v1: 1 },
      coverageKind: 'selection',
      quantization: CONTINUOUS_QUANTIZATION,
    });
    maskEditor.setOverlayRaster(selection);
  } catch (error) {
    console.warn('mask overlay:', error);
  }
}

function startLiveMaskSession(draft) {
  const [sourceWidth, sourceHeight] = srcDims();
  if (!sourceWidth || !sourceHeight || !out.width || !out.height) return null;
  if (liveDraftStrokeId == null) liveDraftStrokeId = maskStore.nextStrokeId();
  draft.id = liveDraftStrokeId;
  try {
    prepareMaskedPreviewMemory({ width: out.width, height: out.height }, {
      prospectiveSurfaceCount: 0,
      includeRasterTransient: true,
    });
    liveMaskSession = maskRasterizer.beginLiveEdit({
      sourceEpoch,
      sourceWidth,
      sourceHeight,
      revision: currentMaskRevision(),
      width: out.width,
      height: out.height,
      normalizedCrop: { u0: 0, v0: 0, u1: 1, v1: 1 },
    });
    appliedMaskDraft = null;
  } catch (error) {
    liveMaskSession = null;
    appliedMaskDraft = null;
    toast(`Mask unavailable: ${error.message}`);
  }
  return liveMaskSession;
}

function setMaskDraft(draft) {
  const needsFirstPrime = !!draft && maskBypassed() && !frameBundles.current;
  if (!draft && maskDraft) flushLiveMaskDraft();
  maskDraft = draft;
  if (draft) {
    if (liveDraftStrokeId == null) liveDraftStrokeId = maskStore.nextStrokeId();
    draft.id = liveDraftStrokeId;
  }
  overlayDirty = true;
  if (frameBundles.current || fastMaskPreview) maskDirty = true;
  if (needsFirstPrime) {
    void primeMaskPreview({
      activationRevisionId: maskRevisionId,
      onFailure: () => maskEditor.cancelDraft(),
    });
  }
}

function rollbackMaskDraft() {
  liveMaskSession?.rollback();
  liveMaskSession = null;
  appliedMaskDraft = null;
  releaseDraftEffectCanvas();
  liveDraftStrokeId = null;
  maskDraft = null;
  maskDirty = !!(frameBundles.current || fastMaskPreview);
  overlayDirty = true;
}

function historyMaskRoots(extraRevisionId = null) {
  const roots = new Set([maskRevisionId]);
  if (extraRevisionId != null) roots.add(extraRevisionId);
  for (const snapshot of history.stack) {
    try {
      const parsed = JSON.parse(snapshot);
      if (Number.isSafeInteger(parsed?.m)) roots.add(parsed.m);
    } catch { /* an old plain-state snapshot has no mask root */ }
  }
  return roots;
}

function pruneMaskHistory() {
  maskStore.prune(historyMaskRoots());
}

function discardFailedMaskHistoryRevision(revisionId) {
  if (history.index < 0 || history.stack.length < 2) return;
  try {
    const current = JSON.parse(history.stack[history.index]);
    if (current?.m !== revisionId) return;
  } catch {
    return;
  }
  history.stack.splice(history.index, 1);
  history.index = Math.max(0, history.index - 1);
  updateUndoButtons();
}

function commitMaskProposal(proposal, { addHistory = true } = {}) {
  if (!proposal?.changed) {
    syncMaskEditor();
    return false;
  }
  const beforeRevisionId = maskRevisionId;
  const revision = maskStore.commit(proposal);
  maskRevisionId = revision.revisionId;
  const after = maskUniformCoverage();
  if (revision.strokeCount >= MASK_LIMITS.softStrokes
      || revision.pointPairs >= MASK_LIMITS.softPointPairs) {
    console.info('Effect Mask is near its complexity limit', {
      strokes: revision.strokeCount,
      pointPairs: revision.pointPairs,
    });
  }

  if (proposal.kind === 'stroke' && liveMaskSession) liveMaskSession.commit(revision);
  else liveMaskSession?.rollback();
  liveMaskSession = null;
  appliedMaskDraft = null;
  releaseDraftEffectCanvas();
  liveDraftStrokeId = null;
  maskDraft = null;

  if (['clear', 'effect-everywhere', 'original-everywhere', 'reset'].includes(proposal.kind)) {
    maskRasterizer.releaseAll();
  }
  maskDirty = after !== 1 && !!(frameBundles.current || fastMaskPreview);
  overlayDirty = true;
  syncMaskEditor();
  if (addHistory) commitHistory();
  pruneMaskHistory();

  if (after === 1) {
    hideFastMaskPreview();
    frameBundles.invalidate('mask bypass restored');
    if (engine.cpu) engine.cpu.invalidate();
    maskCompositor.release();
    dirty = true;
  } else if (!frameBundles.current && !fastMaskPreview) {
    void primeMaskPreview({
      activationRevisionId: revision.revisionId,
      onFailure: () => {
        if (maskRevisionId !== revision.revisionId) return;
        maskEditor.cancelDraft();
        maskRevisionId = beforeRevisionId;
        if (addHistory) discardFailedMaskHistoryRevision(revision.revisionId);
        maskRasterizer.releaseAll();
        maskCompositor.release();
        frameBundles.invalidate('failed mask activation rolled back');
        if (engine.cpu) engine.cpu.invalidate();
        maskDirty = false;
        overlayDirty = true;
        dirty = true;
        syncMaskEditor();
        pruneMaskHistory();
        return true;
      },
    });
  }
  return true;
}

function commitMaskStroke(strokeLike) {
  try {
    const [sourceWidth, sourceHeight] = srcDims();
    const points = simplifyStrokePoints(strokeLike.points, {
      sourceWidth,
      sourceHeight,
      tolerancePx: strokeLike.radiusShortNorm * Math.min(sourceWidth, sourceHeight) / 16,
    });
    const stroke = createStroke({
      ...strokeLike,
      id: strokeLike.id ?? liveDraftStrokeId ?? maskStore.nextStrokeId(),
      points,
    });
    commitMaskProposal(maskStore.proposeStroke(maskRevisionId, stroke));
  } catch (error) {
    rollbackMaskDraft();
    toast(error.code === 'MASK_COMPLEXITY_LIMIT'
      ? 'Mask complexity limit reached · clear the selection to continue'
      : `Mask edit failed: ${error.message}`);
  }
}

function maskedPreviewAreaLimit() {
  const videoMoving = source?.el instanceof HTMLVideoElement
    && !source.el.paused && !source.el.ended;
  const generatedMoving = source?.type === 'gen' || source?.type === 'animated-image';
  if (!exporting && (videoMoving || generatedMoving)) {
    return maskEditor.editing || maskDraft
      ? MAX_MASKED_EDIT_AREA
      : MAX_MASKED_MOTION_AREA;
  }
  const fxOn = Object.values(state.fx).some((value) => +value > 0);
  return fxOn || maskDraft ? 1_600_000 : MAX_MASK_PREVIEW_AREA;
}

function canvasBackingBytes(canvas) {
  return canvas?.width > 0 && canvas?.height > 0 ? canvas.width * canvas.height * 4 : 0;
}

function prepareMaskedPreviewMemory(targetPlan, {
  prospectiveSurfaceCount = 3,
  currentBundle = undefined,
  inFlightRaw = undefined,
  includeRasterTransient = false,
  processedBytes = 0,
  plannedOutputBytes = null,
} = {}) {
  const width = targetPlan.width;
  const height = targetPlan.height;
  const targetBytes = width * height * 4;
  const overlay = $('mask-overlay');
  const liveDraftBytes = liveMaskSession
    ? targetBytes * 2 // Float32 selection + RGBA8 live canvas
    : 0;
  const draftCanvasBytes = draftEffectCanvas ? targetBytes : 0;
  const transientRasterBytes = includeRasterTransient && !liveMaskSession
    ? estimateRasterAllocationBytes(width, height).totalBytes
    : 0;
  const accountedCurrent = currentBundle === undefined ? frameBundles.current : currentBundle;
  const accountedInFlight = inFlightRaw === undefined
    ? (frameBundles.inFlight?.rawTarget || null)
    : inFlightRaw;
  const outputBytes = plannedOutputBytes ?? (canvasBackingBytes(out) + canvasBackingBytes(overlay));
  const estimate = estimateMaskSubsystemPeakBytes({
    targetPlan,
    currentBundle: accountedCurrent,
    inFlightRaw: accountedInFlight,
    prospectiveSurfaceCount,
    rasterCacheBytes: maskRasterizer.cacheBytes,
    outputBytes,
    draftBytes: liveDraftBytes + draftCanvasBytes,
    transientRasterBytes,
    compositorBytes: maskCompositor.estimateScratchBytes(width, height),
    postFXBytes: estimatePostFXBytes(width, height, state.fx, { fast: true }),
    // Engine work/result surfaces are borrowed, but still resident while the
    // owned bundle is built. Count both conservatively at their actual size.
    otherBytes: Math.max(0, processedBytes) * 2,
    previewByteLimit: MAX_MASK_SUBSYSTEM_PREVIEW_BYTES,
  });
  maskRasterizer.trimToBytes(estimate.rasterCacheAllowanceBytes);
  const afterTrim = estimateMaskSubsystemPeakBytes({
    targetPlan,
    currentBundle: accountedCurrent,
    inFlightRaw: accountedInFlight,
    prospectiveSurfaceCount,
    rasterCacheBytes: maskRasterizer.cacheBytes,
    outputBytes,
    draftBytes: liveDraftBytes + draftCanvasBytes,
    transientRasterBytes,
    compositorBytes: maskCompositor.estimateScratchBytes(width, height),
    postFXBytes: estimatePostFXBytes(width, height, state.fx, { fast: true }),
    otherBytes: Math.max(0, processedBytes) * 2,
    previewByteLimit: MAX_MASK_SUBSYSTEM_PREVIEW_BYTES,
  });
  if (!afterTrim.fitsAfterRasterTrim) {
    const error = new Error(`masked preview needs ${Math.ceil(afterTrim.nonCacheBytes / 1048576)} MiB`);
    error.code = 'MASK_PREVIEW_MEMORY_LIMIT';
    throw error;
  }
  return afterTrim.accountedExtraBytesAfterTrim;
}

function assertMaskedCompositionFeasible(targetPlan) {
  const targetBytes = targetPlan.width * targetPlan.height * 4;
  // Model the post-publication phase separately: the old bundle has been
  // released, the new two-surface pair is resident, and raster/compositor
  // scratch must fit before publication is allowed to replace the old pair.
  prepareMaskedPreviewMemory(targetPlan, {
    currentBundle: null,
    inFlightRaw: null,
    prospectiveSurfaceCount: 2,
    includeRasterTransient: !liveMaskSession,
    plannedOutputBytes: targetBytes * 2, // output + editor overlay
  });
}

function resolveMaskedTarget(descriptor, sourceWidth, sourceHeight, maxArea = maskedPreviewAreaLimit()) {
  return frameBundles.resolveTarget({
    sourceWidth,
    sourceHeight,
    processedWidth: descriptor.width,
    processedHeight: descriptor.height,
    samplingKind: descriptor.samplingKind,
    maxArea,
    maxSide: MAX_MASK_PREVIEW_SIDE,
  });
}

function maskedToken(descriptor, targetPlan, acceptedFrameId = frameId) {
  return {
    sourceEpoch,
    frameId: acceptedFrameId,
    effectRevision,
    targetRevision: targetPlan.targetRevision,
    samplingKind: descriptor.samplingKind,
  };
}

function maskedPostFXPlan(token, sourceHeight, fast = true) {
  return {
    fx: { ...state.fx },
    grainPhase: currentGrainPhase() ?? grainPhaseForFrame(token.frameId),
    refH: sourceHeight,
    fast,
  };
}

function handleDetailedMaskedRender(detail, sourceWidth, sourceHeight, maxArea = maskedPreviewAreaLimit()) {
  const started = performance.now();
  if (fastPreviewEligible(detail.renderedResult)) {
    try {
      presentFastGpuMask(detail.renderedResult, sourceWidth, sourceHeight, maxArea);
      bundleBuildMs = performance.now() - started;
      return fastMaskPreview;
    } catch (error) {
      console.warn('direct GPU mask preview:', error);
      hideFastMaskPreview();
    }
  }
  let published = null;
  if (detail.committedResult) {
    try {
      const accepted = frameBundles.inFlight;
      let refreshedExtraPeakBytes = null;
      if (accepted) {
        assertMaskedCompositionFeasible(accepted.targetPlan);
        refreshedExtraPeakBytes = prepareMaskedPreviewMemory(accepted.targetPlan, {
          prospectiveSurfaceCount: 2,
          inFlightRaw: accepted.rawTarget,
          processedBytes: canvasBackingBytes(detail.committedResult.canvas),
        });
      }
      published = frameBundles.commitAsync({
        committedResult: detail.committedResult,
        extraPeakBytes: refreshedExtraPeakBytes,
        currentGenerations: {
          sourceEpoch,
          effectRevision,
          targetRevision: frameBundles.targetRevision,
          samplingKind: detail.committedResult.token?.samplingKind,
        },
      }) || published;
    } catch (error) {
      console.warn('masked CPU commit:', error);
      frameBundles.invalidate('masked CPU commit rejected', { releaseCurrent: false });
    }
  }

  if (detail.renderedResult) {
    const { canvas, descriptor } = detail.renderedResult;
    const targetPlan = resolveMaskedTarget(descriptor, sourceWidth, sourceHeight, maxArea);
    const token = maskedToken(descriptor, targetPlan);
    try {
      assertMaskedCompositionFeasible(targetPlan);
      const extraPeakBytes = prepareMaskedPreviewMemory(targetPlan, {
        prospectiveSurfaceCount: 3,
        processedBytes: canvasBackingBytes(canvas),
      });
      published = frameBundles.buildSynchronous({
        borrowedProcessed: canvas,
        descriptor,
        token,
        targetPlan,
        rawSource: source.el,
        sourceWidth,
        sourceHeight,
        postFXPlan: maskedPostFXPlan(token, sourceHeight, true),
        extraPeakBytes,
      });
    } catch (error) {
      console.warn('masked bundle:', error);
      if (error.code === 'MASK_PREVIEW_MEMORY_LIMIT') toast('Mask preview reduced by memory limit');
    }
  }

  if (detail.acceptedJob?.token) {
    try {
      const extraPeakBytes = prepareMaskedPreviewMemory(detail.acceptedJob.targetPlan, {
        // Reserve for the accepted raw plus the later processed/FX commit.
        prospectiveSurfaceCount: 3,
        processedBytes: (detail.acceptedJob.descriptor?.width || 0)
          * (detail.acceptedJob.descriptor?.height || 0) * 4,
      });
      frameBundles.acceptAsync({
        acceptedJob: detail.acceptedJob,
        rawSource: source.el,
        sourceWidth,
        sourceHeight,
        postFXPlan: maskedPostFXPlan(detail.acceptedJob.token, sourceHeight, true),
        extraPeakBytes,
      });
    } catch (error) {
      console.warn('masked CPU accept:', error);
    }
  }

  bundleBuildMs = performance.now() - started;
  if (published) presentMaskedBundle(published);
  else if (maskDirty && frameBundles.current) presentMaskedBundle();
  return published;
}

function resolveLiveRenderBudget() {
  let budget = MAX_LIVE_PIXELS;
  const cpuDither = state.mode === 'dither' && getAlgorithm(state.algorithm).type === 'cpu';
  const heavyAscii = state.mode === 'ascii' && state.ascii.renderer === 'shape';
  const videoMoving = source?.el instanceof HTMLVideoElement
    && (!source.el.paused && !source.el.ended);
  const inherentlyMoving = source?.type === 'webcam'
    || source?.type === 'gen'
    || source?.type === 'animated-image';
  const moving = videoMoving || inherentlyMoving || isAnimating();
  if (moving && cpuDither) budget = liveCpuDitherBudget(state.pixelSize);
  else if (moving && heavyAscii) budget = MAX_LIVE_CPU_PIXELS;
  else if (!moving && state.mode !== 'dither') budget = MAX_STILL_PREVIEW_PIXELS;
  else if (state.mode === 'dither') budget = MAX_LIVE_GPU_PIXELS;
  return budget;
}

function cancelMaskPriming() {
  maskPrimeGeneration++;
  maskPriming = false;
  maskPrimingPromise = null;
  maskPrimeGuard = null;
  maskEditor.setPriming(false);
}

function primeMaskPreview({
  activationRevisionId = maskRevisionId,
  onFailure = null,
  preserveCurrentUntilPublish = false,
} = {}) {
  if (maskPrimingPromise) {
    if (onFailure) {
      maskPrimeGuard = {
        ...maskPrimeGuard,
        activationRevisionId,
        onFailure,
      };
    }
    return maskPrimingPromise;
  }
  if (!source || !maskIsActive()) return Promise.resolve(false);

  const generation = ++maskPrimeGeneration;
  const sourceAtStart = source;
  const liveBudget = resolveLiveRenderBudget(); // capture before pausing video
  const video = source.el instanceof HTMLVideoElement ? source.el : null;
  const wasPlaying = !!video && !video.paused && !video.ended;
  const startingTransportRevision = transportRevision;
  maskPrimeGuard = { generation, activationRevisionId, onFailure };
  maskPriming = true;
  maskEditor.setPriming(true);

  let promise;
  promise = (async () => {
    if (wasPlaying && source.type !== 'webcam') video.pause();
    await new Promise((resolve) => requestAnimationFrame(resolve));
    if (generation !== maskPrimeGeneration || source !== sourceAtStart) return false;
    let lastError = null;
    const initialArea = maskedPreviewAreaLimit();
    const areas = [...new Set([
      initialArea,
      Math.max(400_000, Math.floor(initialArea / 2)),
      400_000,
    ])];
    for (const maskTargetArea of areas) {
      try {
        if (engine.cpu) engine.cpu.invalidate();
        const priorBundle = frameBundles.current;
        frameBundles.invalidate('mask priming', { releaseCurrent: !preserveCurrentUntilPublish });
        renderOnce({
          budget: Math.min(liveBudget, maskTargetArea),
          maskTargetArea,
          contentNew: true,
          allowAsync: false,
          liveRender: true,
          offline: false,
        });
        const landed = frameBundles.current;
        if (!landed || (preserveCurrentUntilPublish && landed === priorBundle)
            || !presentMaskedBundle(landed)) {
          throw new Error('could not build a paired frame');
        }
        return true;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError || new Error('could not build a paired frame');
  })().catch((error) => {
    if (generation !== maskPrimeGeneration) return false;
    const guard = maskPrimeGuard;
    let failureHandled = false;
    if (guard?.generation === generation
        && (!guard.activationRevisionId || maskRevisionId === guard.activationRevisionId)) {
      failureHandled = guard.onFailure?.() === true;
    }
    if (!failureHandled) frameBundles.invalidate('mask priming failed');
    maskDirty = false;
    overlayDirty = true;
    dirty = true;
    toast(`Mask unavailable: ${error.message}`);
    return false;
  }).finally(() => {
    if (generation !== maskPrimeGeneration) return;
    if (wasPlaying && source === sourceAtStart && transportRevision === startingTransportRevision) {
      video.play().catch(() => {});
      if (source.type === 'video') $('btn-play').textContent = '❚❚';
    }
    if (maskPrimingPromise === promise) maskPrimingPromise = null;
    maskPrimeGuard = null;
    maskPriming = false;
    maskEditor.setPriming(false);
    syncMaskEditor();
  });
  maskPrimingPromise = promise;
  return promise;
}

// ---------------------------------------------------------------------------
// render + present
// ---------------------------------------------------------------------------
function renderOnce(budgetOverride = null, contentNew = true, noFx = false, captureMetadata = false) {
  const options = budgetOverride && typeof budgetOverride === 'object'
    ? budgetOverride
    : {
      budget: budgetOverride,
      contentNew,
      noFx,
      captureMetadata,
    };
  const explicitBudget = options.budget ?? null;
  contentNew = options.contentNew ?? true;
  noFx = !!options.noFx;
  captureMetadata = !!options.captureMetadata;
  const processedOnly = !!options.processedOnly || noFx || captureMetadata;
  const offline = options.offline ?? explicitBudget !== null;
  const [w, h] = srcDims();
  if (!w || !h) return out;
  if (source.type === 'gen') source.gen.tick(genPhaseOverride ?? source.gen.phase);
  const p = derived(captureMetadata);
  // Preview work is bounded for every source, including large still images.
  // Exports pass an explicit budget and remain full quality. At fit-to-window
  // sizes 0.42MP already exceeds the editor viewport; GPU dithers get 2.25MP
  // so pixel-size 1 and fine smooth grain stay crisp on Retina displays.
  let budget = MAX_LIVE_PIXELS;
  // CPU error-diffusion and ASCII shape-matching are the slow live paths
  // (heavy per-pixel/per-cell JS, several times slower in WebKit). Cap them
  // harder on live video/webcam so scrubbing stays smooth — exports use
  // EXPORT_PIXELS, so their quality is unaffected. GPU dithers, by contrast,
  // cost ~the same at 0.4MP or 2MP (the shader is the bottleneck, not the
  // pixel count), so give them a much finer live budget — the dither pattern
  // on video is then crisp instead of chunky at pixel-size 1.
  if (explicitBudget === null) budget = resolveLiveRenderBudget();
  // Only the live preview (no budget override, not exporting) may run the CPU
  // dither in the worker; exports and thumbnails stay synchronous.
  const allowAsync = options.allowAsync ?? (explicitBudget === null && !exporting);
  // Live-loop render vs one-shot (export/copy) render. Realtime canvas
  // recordings capture the live loop, so they must keep the exact live
  // presentation; frame-exact exporters pass a budget override and get the
  // uncapped, deterministic rendition.
  p.liveRender = options.liveRender ?? explicitBudget === null;
  const renderBudget = explicitBudget ?? budget;
  if (contentNew) frameId++;

  if (!processedOnly && maskIsActive()) {
    const maskTargetArea = options.maskTargetArea ?? maskedPreviewAreaLimit();
    const acceptedFrameId = frameId;
    const renderStarted = performance.now();
    const detail = engine.renderDetailed(source.el, w, h, p, {
      maxPixels: renderBudget,
      maxOutputPixels: maskTargetArea,
      maxOutputSide: MAX_MASK_PREVIEW_SIDE,
      allowAsync,
      contentNew,
      makeAcceptedJob: (descriptor) => {
        const targetPlan = resolveMaskedTarget(descriptor, w, h, maskTargetArea);
        return {
          token: maskedToken(descriptor, targetPlan, acceptedFrameId),
          targetPlan,
        };
      },
    });
    effectRenderMs = performance.now() - renderStarted;
    handleDetailedMaskedRender(detail, w, h, maskTargetArea);
    return out;
  }

  const renderStarted = performance.now();
  const result = engine.render(source.el, w, h, p, renderBudget, allowAsync, contentNew);
  effectRenderMs = performance.now() - renderStarted;
  if (result) present(result, w, offline, noFx);
  return out;
}

// offline = a one-shot frame-exact render (export/copy). NOT the same as the
// `exporting` flag: realtime canvas recordings (MediaRecorder capturing `out`)
// run through the live loop with exporting=true, and the presented canvas must
// keep its exact live size/appearance — a mid-stream resize glitches the
// recording.
// noFx = present the raw render without the post-FX stack (the GIF exporter
// applies fx itself, AFTER decimation, at the GIF's own resolution).
function present(result, srcW, offline = false, noFx = false) {
  hideFastMaskPreview();
  const fxOn = !noFx && Object.values(state.fx).some((v) => v > 0);
  let final = result;
  if (fxOn) {
    // applied/ideal upscale ratio — compensates refH when the budget forces a
    // smaller fx canvas, so grain/chromatic/glow geometry stays proportional
    let fxScaleRatio = 1;
    if (state.mode === 'dither') {
      // upscale first so scanlines/grain/vignette are crisp over the pixels
      const idealScale = Math.min(2, Math.max(1, srcW / result.width));
      let scale = idealScale;
      // Live budget: the whole post-FX chain composites at this size every
      // frame — a 2x upscale of a 2MP result would mean ~8MP of 2D raster
      // work per frame. Over budget, run fx at the result's own resolution.
      // Frame-exact exports keep the full source-resolution upscale.
      if (!offline && result.width * result.height * scale * scale > LIVE_FX_PIXELS) scale = 1;
      fxScaleRatio = scale / idealScale;
      // At scale 1 the blit is a plain copy — skip it, except for chromatic
      // aberration, where copying once turns 3 reads of a GL-backed canvas
      // into 1 GL read + 3 cheap 2D reads.
      if (scale > 1 || +state.fx.chromatic > 0) {
        const W = Math.round(result.width * scale);
        const H = Math.round(result.height * scale);
        if (upCanvas.width !== W || upCanvas.height !== H) {
          upCanvas.width = W;
          upCanvas.height = H;
        }
        upCtx.imageSmoothingEnabled = false;
        upCtx.drawImage(result, 0, 0, W, H);
        final = upCanvas;
      }
    }
    // refH scaled by the forgone upscale keeps the capped live rendition's
    // fx geometry proportionally identical to the uncapped export (N36)
    final = applyPostFX(final, state.fx, {
      grainPhase: currentGrainPhase(),
      refH: (srcDims()[1] || final.height) * fxScaleRatio,
      fast: !offline,
    });
  }
  let resized = false;
  if (out.width !== final.width || out.height !== final.height) {
    out.width = final.width;
    out.height = final.height;
    resized = true;
  }
  octx.drawImage(final, 0, 0);
  if (resized) maskEditor.onOutputResized(out.width, out.height);
  // Crisp dither wants nearest-neighbour upscaling (sharp dots); a box-resolved
  // (tone) result should scale smoothly. Use the engine's ACTUAL last-frame
  // state so a CPU algorithm, WebGL loss, or governor ss->1 (all crisp) keep
  // nearest-neighbour even while state.smoothness > 0.
  const pixelate = state.mode === 'dither' && !engine.lastBoxResolved;
  out.classList.toggle('pixelated', pixelate);
  if (resized) view.contentResized();
  if (resized) {
    syncMaskEditor();
    overlayDirty = true;
  }
  // not during exports: out is at export resolution and the overlay is hidden
  // behind the busy screen anyway
  if (view.splitOn && !view.splitSuppressed && !comparing && !exporting) drawSplitOverlay();
}

function presentOriginal() {
  const [srcW, srcH] = srcDims();
  if (!srcW || !srcH || !out.width || !out.height) return;
  // Compare at the processed preview's bitmap size. Drawing a 48MP original
  // into a native-size canvas only to CSS-shrink it wastes memory and causes a
  // visible zoom jump; this is screen-identical at the current view scale.
  octx.drawImage(source.el, 0, 0, out.width, out.height);
  out.classList.remove('pixelated');
  if (view.splitOn) cctx.clearRect(0, 0, cmp.width, cmp.height);
}

// Draw the untouched source over the left part of the frame (split view).
function drawSplitOverlay() {
  if (!source || !view.splitOn || view.splitSuppressed) return;
  const pairedRaw = maskIsActive()
    ? (fastMaskPreview?.rawTarget || frameBundles.current?.rawTarget)
    : null;
  const [sourceWidth, sourceHeight] = srcDims();
  const raw = pairedRaw || source.el;
  const srcW = pairedRaw?.width || sourceWidth;
  const srcH = pairedRaw?.height || sourceHeight;
  const w = out.width;
  const h = out.height;
  if (!srcW || !srcH || !w || !h) return;
  // Match the processed bitmap. A native 48MP comparison overlay consumed
  // hundreds of MB even though it occupied the same screen pixels as `out`.
  if (cmp.width !== w || cmp.height !== h) {
    cmp.width = w;
    cmp.height = h;
  }
  cmp.style.width = `${out.width}px`;
  cmp.style.height = `${out.height}px`;
  cctx.clearRect(0, 0, w, h);
  const frac = view.splitFrac;
  if (frac <= 0) return;
  cctx.drawImage(raw, 0, 0, srcW * frac, srcH, 0, 0, w * frac, h);
}

// Adjust the supersample cap from the two load signals. Live ss is capped at
// 2, so the only degrade that reduces work is ss->1. A level change requires
// the bad/good state to persist for a dwell period (recovery needs a longer
// one), so one hitchy frame — or one lucky one — never flips the quality.
function updateGovernor() {
  if (state.mode !== 'dither' || state.smoothness <= 0 || source?.type === 'image') {
    governorLevel = 0; governorSsCap = 3; renderMsEma = 0;
    govSlowMs = 0; govFastMs = 0; govMuteMs = 0; govLastT = 0;
    govCadenceMuted = false; govRecoverMs = 1500;
    return;
  }
  // Self-clocked dwell: the loop's dt is zeroed after >250ms gaps (hidden-tab
  // guard), which would starve the dwell exactly under the heaviest load, and
  // rAF ticks that skip rendering don't call this at all. Clamp so a long
  // pause can't dump a lump into the accumulators.
  const now = performance.now();
  const gdt = govLastT ? Math.min(1000, now - govLastT) : 0;
  govLastT = now;
  // Cadence (~1 = every decoded frame rendered, >1.35 = skipping over a
  // quarter) is only meaningful while frames are actually being presented —
  // the pump freezes on pause/ended, leaving a stale value behind.
  const cadenceFresh = now - lastPumpT < 500;
  const rawBad = cadenceFresh && pumpFramesEma > 1.35;
  if (cadenceFresh && pumpFramesEma > 0 && pumpFramesEma < 1.15) govCadenceMuted = false;
  // If ss=1 didn't clear the drops while renders stay cheap, the misses are
  // display/decode-limited (e.g. a 60fps clip under a 30Hz-throttled rAF) —
  // no ss level can help, so stop acting on cadence until it recovers.
  if (governorLevel === 1 && rawBad && renderMsEma > 0 && renderMsEma < 20) {
    govMuteMs += gdt;
    if (govMuteMs > 2000) govCadenceMuted = true;
  } else {
    govMuteMs = 0;
  }
  const cadenceBad = rawBad && !govCadenceMuted;
  const cadenceGood = govCadenceMuted || !cadenceFresh || pumpFramesEma < 1.15;
  if (governorLevel === 0) {
    if (renderMsEma > 40 || cadenceBad) { govSlowMs += gdt; govFastMs = 0; }
    else govSlowMs = Math.max(0, govSlowMs - gdt);
    if (govSlowMs > 700) {
      governorLevel = 1; govSlowMs = 0; renderMsEma = 0;
      govRecoverMs = Math.min(30000, govRecoverMs * 2); // damp slow flip-flop
    }
  } else {
    if (renderMsEma < 20 && cadenceGood) { govFastMs += gdt; govSlowMs = 0; }
    else govFastMs = Math.max(0, govFastMs - gdt);
    if (govFastMs > govRecoverMs) { governorLevel = 0; govFastMs = 0; renderMsEma = 0; }
  }
  governorSsCap = governorLevel === 0 ? 3 : 1;
}

function loop(t) {
  requestAnimationFrame(loop);
  if (!source) return;
  if (overlayDirty) updateMaskOverlay();
  const rawDt = lastLoopT ? t - lastLoopT : 16;
  lastLoopT = t;
  // recordings must track wall time even when rAF is throttled; otherwise
  // swallow the jump after a long gap (window was hidden)
  const dt = exporting ? Math.min(1000, rawDt) : (rawDt > 250 ? 0 : rawDt);

  // advance the animation clock (paused while an exporter pins the phase)
  const animating = isAnimating() && phaseOverride === null;
  if (animating) animPhase = (animPhase + (dt / 1000) * state.anim.speed * 0.15) % 1;

  if (source.type === 'gen' && genPhaseOverride === null) {
    source.gen.phase = (source.gen.phase + (dt / 1000) * source.gen.params.speed * GEN_CYCLES_PER_SEC) % 1;
  }
  const isVideoEl = source.el instanceof HTMLVideoElement;
  const isLive = source.type !== 'image';
  const playing = isLive && genPhaseOverride === null // gen bake renders itself
    && (isVideoEl
      ? (!source.el.paused && !source.el.ended)
      : true); // webcam-less live sources (generated scenes) always play
  // Only re-dither a video/webcam when a new frame actually decoded (rVFC);
  // generative scenes change every tick so they always render. An active
  // animation also changes the output every tick, so it forces a render.
  const videoWork = isVideoEl ? (playing && (!HAS_RVFC || videoFrameReady)) : playing;
  // Genuinely-new content vs a worker-completion wake-up. Only real content
  // dispatches a new dither; a wake-up just presents the finished result.
  const contentNew = dirty || videoWork || animating;
  // During an export the exporter drives its own synchronous renders; a stale
  // pre-export worker reply must not repaint `out` mid-frame. (recordCanvas
  // exports still render via contentNew from playing/animating.)
  if (exporting) cpuResultReady = false;
  const cpuWake = cpuResultReady;
  if (!contentNew && !cpuWake && !maskDirty) return;
  cpuResultReady = false;
  videoFrameReady = false;
  dirty = false;

  if (comparing) {
    presentOriginal();
  } else if (maskDirty && !contentNew && !cpuWake && fastMaskPreview) {
    presentFastMaskPreview();
  } else if (maskDirty && !contentNew && !cpuWake && frameBundles.current) {
    presentMaskedBundle();
  } else {
    const t0 = performance.now();
    const maskedRender = maskIsActive();
    renderOnce(null, contentNew);
    // Only track cost while producing new LIVE frames — not idle wake-ups,
    // and not export renders: recordCanvas exports run through this loop with
    // export cost profiles (sync CPU dither, ss=3) the governor must not
    // train on. derived() masks its output during exports anyway.
    if (contentNew && !exporting) {
      // The masked path tracks Engine work separately so the compositor can
      // never train the renderer supersampling governor. Preserve the legacy
      // wall-time signal exactly while the mask is bypassed.
      const rt = maskedRender ? effectRenderMs : performance.now() - t0;
      renderMsEma = renderMsEma ? renderMsEma * 0.85 + rt * 0.15 : rt;
      updateGovernor();
    }
  }

  if (playing || animating) {
    if (lastFrameT) {
      const fdt = t - lastFrameT;
      fpsEma = fpsEma ? fpsEma * 0.9 + fdt * 0.1 : fdt;
      if (t - lastStatusT >= 250) {
        fpsText = `${Math.round(1000 / fpsEma)} fps`;
        updateStatus();
        lastStatusT = t;
      }
    }
    lastFrameT = t;
    if (playing && !scrubbing && source.type === 'video' && t - lastStatusT < 20) {
      const el = source.el;
      const seekValue = isFinite(el.duration) && el.duration ? Math.round((el.currentTime / el.duration) * 1000) : 0;
      if ($('seek').value !== String(seekValue)) $('seek').value = seekValue;
      updateVideoTime(el);
    }
  } else {
    lastFrameT = 0;
    if (fpsText) { fpsText = ''; updateStatus(); }
  }
}

const fmtTime = (s) => {
  if (!isFinite(s)) return '–:––';
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
};

function updateVideoTime(video) {
  const text = `${fmtTime(video.currentTime)} / ${fmtTime(video.duration)}`;
  if ($('time').textContent !== text) $('time').textContent = text;
  syncRangeProgress($('seek'));
}

function updateStatus() {
  if (source) {
    const [w, h] = srcDims();
    const modeName = state.mode[0].toUpperCase() + state.mode.slice(1);
    const left = `${source.name || source.type} · ${w}×${h} · ${modeName}`;
    if ($('st-left').textContent !== left) $('st-left').textContent = left;
  }
  const z = `${Math.round(view.zoom * 100)}%`;
  const right = fpsText ? `${fpsText} · ${z}` : z;
  if ($('st-right').textContent !== right) $('st-right').textContent = right;
}

// ---------------------------------------------------------------------------
// history (undo / redo)
// ---------------------------------------------------------------------------
const history = { stack: [], index: -1 };
let histTimer = null;

function updateUndoButtons() {
  $('btn-undo').disabled = history.index <= 0;
  $('btn-redo').disabled = history.index >= history.stack.length - 1;
}

// Mask vectors live in their own immutable revision graph. History stores only
// a stable revision ID alongside settings and source-bound generative params.
function snapshotStr() {
  return JSON.stringify({
    s: state,
    g: source?.type === 'gen'
      ? { sourceEpoch, params: source.gen.params }
      : null,
    m: maskRevisionId,
  });
}

function commitHistory() {
  clearTimeout(histTimer);
  histTimer = null;
  const snap = snapshotStr();
  if (history.stack[history.index] === snap) return;
  history.stack.splice(history.index + 1);
  history.stack.push(snap);
  if (history.stack.length > 100) history.stack.shift();
  history.index = history.stack.length - 1;
  while (history.stack.length > 1
      && maskStore.reachableBytes(historyMaskRoots()) > 16 * 1024 * 1024) {
    history.stack.shift();
    history.index--;
  }
  pruneMaskHistory();
  updateUndoButtons();
}

// debounced variant for slider drags; discrete actions call commitHistory()
function pushHistory() {
  clearTimeout(histTimer);
  histTimer = setTimeout(commitHistory, 350);
}

function restoreSnapshot(snap, {
  skipPrime = false,
  preserveCurrentBundle = false,
  onPrimeFailure = null,
} = {}) {
  const beforeCoverage = maskUniformCoverage();
  maskEditor.cancelDraft();
  const parsed = JSON.parse(snap);
  resetState(state);
  applyParams(state, parsed.s || parsed);
  if (Number.isSafeInteger(parsed.m) && maskStore.has(parsed.m)) maskRevisionId = parsed.m;
  if (parsed.g?.sourceEpoch === sourceEpoch && parsed.g.params && source?.type === 'gen') {
    Object.assign(source.gen.params, parsed.g.params);
    source.name = source.gen.sceneName().toLowerCase();
  }
  effectRevision++;
  frameBundles.invalidate('history restore', { releaseCurrent: !preserveCurrentBundle });
  if (engine.cpu) engine.cpu.invalidate();
  clearActivePreset($('preset-strip')); // the restored state may not match the highlighted card
  rebuildPanel();
  updateExportButtons();
  updateUndoButtons();
  updateStatus();
  syncMaskEditor();
  maskDirty = false;
  overlayDirty = true;
  dirty = true;
  if (!maskIsActive()) {
    frameBundles.invalidate('history restored bypass');
  } else if (!skipPrime
      && (beforeCoverage === 1 || !frameBundles.current || preserveCurrentBundle)) {
    void primeMaskPreview({
      activationRevisionId: maskRevisionId,
      preserveCurrentUntilPublish: preserveCurrentBundle,
      onFailure: onPrimeFailure,
    });
  }
}

function undo() {
  if (maskPriming) return;
  commitHistory(); // land any pending debounced change first
  if (history.index > 0) {
    const rollbackIndex = history.index;
    const rollbackSnapshot = history.stack[rollbackIndex];
    history.index--;
    restoreSnapshot(history.stack[history.index], {
      preserveCurrentBundle: true,
      onPrimeFailure: () => {
        history.index = rollbackIndex;
        restoreSnapshot(rollbackSnapshot, { skipPrime: true, preserveCurrentBundle: true });
        if (frameBundles.current && maskIsActive()) presentMaskedBundle();
        return true;
      },
    });
    updateUndoButtons();
  }
}

function redo() {
  if (maskPriming) return;
  if (histTimer) commitHistory();
  if (history.index < history.stack.length - 1) {
    const rollbackIndex = history.index;
    const rollbackSnapshot = history.stack[rollbackIndex];
    history.index++;
    restoreSnapshot(history.stack[history.index], {
      preserveCurrentBundle: true,
      onPrimeFailure: () => {
        history.index = rollbackIndex;
        restoreSnapshot(rollbackSnapshot, { skipPrime: true, preserveCurrentBundle: true });
        if (frameBundles.current && maskIsActive()) presentMaskedBundle();
        return true;
      },
    });
    updateUndoButtons();
  }
}

$('btn-undo').onclick = () => !exporting && undo();
$('btn-redo').onclick = () => !exporting && redo();

// ---------------------------------------------------------------------------
// preset thumbnails — rendered from the actual loaded media
// ---------------------------------------------------------------------------
let thumbCanvases = new Map();
let thumbToken = 0;

async function renderPresetThumbs() {
  const [w, h] = srcDims();
  if (!source) return;
  if (!w || !h) {
    // Cameras can report 0×0 for a moment after permission is granted. Retry
    // a bounded number of times, tied to this source so a later source cannot
    // receive stale thumbnails.
    if (source.type === 'webcam' && (source._thumbRetries || 0) < 10) {
      const pending = source;
      source._thumbRetries = (source._thumbRetries || 0) + 1;
      setTimeout(() => { if (source === pending) renderPresetThumbs(); }, 400);
    }
    return;
  }
  source._thumbRetries = 0;
  const el = source.el;
  if (el instanceof HTMLVideoElement && el.readyState < 2) {
    setTimeout(renderPresetThumbs, 400);
    return;
  }
  const token = ++thumbToken;

  // frozen cover-cropped snapshot so video thumbs don't shear mid-frame
  const TW = 192;
  const TH = 120;
  const snap = document.createElement('canvas');
  snap.width = TW;
  snap.height = TH;
  const sctx = snap.getContext('2d');
  const scale = Math.max(TW / w, TH / h);
  sctx.drawImage(el, (TW - w * scale) / 2, (TH - h * scale) / 2, w * scale, h * scale);

  let i = 0;
  for (const p of PRESETS) {
    if (token !== thumbToken) return; // a newer source superseded this run
    const target = thumbCanvases.get(p.id);
    if (!target) continue;
    try {
      const base = structuredClone(DEFAULTS);
      applyParams(base, p.params);
      const thumbParams = deriveParams(base);
      thumbParams.ascii.captureMetadata = false;
      const result = thumbEngine.render(snap, TW, TH, thumbParams, Infinity);
      const final = applyPostFX(result, base.fx, { grainPhase: 0, refH: TH });
      const tctx = target.getContext('2d');
      tctx.imageSmoothingEnabled = false;
      tctx.fillStyle = '#000';
      tctx.fillRect(0, 0, target.width, target.height);
      const s2 = Math.max(target.width / final.width, target.height / final.height);
      const fw = final.width * s2;
      const fh = final.height * s2;
      tctx.drawImage(final, (target.width - fw) / 2, (target.height - fh) / 2, fw, fh);
    } catch (err) {
      console.warn('preset thumb failed:', p.id, err);
    }
    if (++i % 4 === 0) await new Promise((r) => setTimeout(r, 0)); // keep the UI responsive
  }
}

// ---------------------------------------------------------------------------
// sources
// ---------------------------------------------------------------------------
// For moving video, a temporally-stable blue-noise dither looks
// far smoother than Bayer (whose regular grid crawls/moirés on pans) or
// per-frame error diffusion (which flickers). Apply a video-friendly profile
// when entering a live source from a still (or cold start) — not on every
// video→video swap, so a user's per-clip tweaks carry over to the next clip.
function applyVideoProfile() {
  if (state.mode !== 'dither') return;
  if (getAlgorithm(state.algorithm).type === 'cpu' || state.algorithm.startsWith('bayer')) {
    state.algorithm = 'bluenoise';
  }
  // Video / Smooth starting point: smoother + finer grain out of
  // the box (the user's request). All reversible — drag Smoothness to 0 for a
  // crisp full-resolution 1-bit look.
  state.smoothness = 0.5;
  state.temporal = 0.4;
  state.videoDenoise = 0.2;
}

function disposeSource(s) {
  if (!s) return;
  if (s.stream) s.stream.getTracks().forEach((tr) => tr.stop());
  if (s.el instanceof HTMLVideoElement && !s.stream) s.el.pause();
  if (s._seekHandler) s.el.removeEventListener('seeked', s._seekHandler);
  if (s._rvfc != null && s.el.cancelVideoFrameCallback) s.el.cancelVideoFrameCallback(s._rvfc);
  if (s.url) URL.revokeObjectURL(s.url);
}

function setSource(next) {
  const prevType = source?.type;
  if (exporting) {
    // don't yank the source out from under a running export
    disposeSource(next);
    toast('Export in progress — cancel it first');
    return;
  }
  cancelMaskPriming();
  hideFastMaskPreview();
  if (source) {
    maskEditor.beforeSourceChange();
    commitHistory();
  }
  const keptMask = maskIsActive();
  disposeSource(source);
  source = next;
  sourceEpoch++;
  frameId = 0;
  effectRevision++;
  transportRevision++;
  frameBundles.invalidate('source replacement');
  maskRasterizer.releaseAll();
  maskCompositor.release();
  releasePostFXBuffers();
  liveMaskSession = null;
  appliedMaskDraft = null;
  liveDraftStrokeId = null;
  maskDraft = null;
  maskDirty = false;
  overlayDirty = true;
  if (keptMask) {
    octx.clearRect(0, 0, out.width, out.height);
    cctx.clearRect(0, 0, cmp.width, cmp.height);
  }
  const nowLive = next.type === 'video' || next.type === 'webcam';
  const wasLive = prevType === 'video' || prevType === 'webcam';
  const profileApplied = nowLive && !wasLive;
  if (profileApplied) applyVideoProfile();
  fpsEma = 0;
  fpsText = '';
  lastStatusT = 0;
  videoFrameReady = false;
  // new pixels, possibly same dither settings/size — force a fresh sync frame
  // instead of briefly showing the old source's async result.
  if (engine.cpu) engine.cpu.invalidate();
  engine.resetTemporal(); // don't ghost-blend a new clip with the old one's tail
  // a fresh source starts un-throttled — a stale ss cap from a slow prior clip
  // would otherwise under-supersample this source's first (or only) frame
  governorLevel = 0; governorSsCap = 3; renderMsEma = 0;
  pumpFramesEma = 0; lastPumpT = 0; govSlowMs = 0; govFastMs = 0;
  govLastT = 0; govMuteMs = 0; govCadenceMuted = false; govRecoverMs = 1500;
  // Drive per-frame rendering off real decoded frames for video/webcam.
  // Capture the source locally so a stale callback (fired after a source
  // switch) re-registers on its OWN, now-paused element and self-terminates
  // rather than re-arming on the new source.
  if (HAS_RVFC && source.el instanceof HTMLVideoElement) {
    const s = source;
    const pump = (now, meta) => {
      videoFrameReady = true;
      // Governor signal: presentedFrames jumping by >1 between callbacks means
      // video frames were composited that we never re-dithered (rAF throttled
      // or renders too slow). Ignore pause/seek/hidden gaps.
      if (lastPumpT && meta && now - lastPumpT < 500) {
        const frames = Math.max(1, meta.presentedFrames - (s._lastPresented || 0));
        pumpFramesEma = pumpFramesEma ? pumpFramesEma * 0.85 + frames * 0.15 : frames;
        // Passive source-frame-rate estimate for the frame-accurate exporter:
        // mediaTime deltas are exact frame durations (no wall-clock jitter).
        // Only at 1x — other rates can drop decoded frames, inflating deltas.
        if (s.el.playbackRate === 1 && s._lastMediaTime !== undefined) {
          const fd = (meta.mediaTime - s._lastMediaTime) / frames;
          if (fd > 1 / 121 && fd < 1 / 9) {
            s._frameDurEma = s._frameDurEma ? s._frameDurEma * 0.8 + fd * 0.2 : fd;
          }
        }
      }
      if (meta) { s._lastPresented = meta.presentedFrames; s._lastMediaTime = meta.mediaTime; }
      lastPumpT = now;
      s._rvfc = s.el.requestVideoFrameCallback(pump);
    };
    s._rvfc = s.el.requestVideoFrameCallback(pump);
  }
  if (source.type === 'video') {
    source.el.playbackRate = parseFloat($('speed').value) || 1;
    $('btn-play').textContent = '❚❚';
    // re-render when the user seeks a paused video (exporters render themselves)
    // a seek is a temporal discontinuity — drop history so the landed frame
    // doesn't ghost-blend with wherever we jumped from
    source._seekHandler = () => {
      if (!exporting) {
        transportRevision++;
        frameBundles.invalidate('seek');
        dirty = true;
        engine.invalidateTemporal();
        updateVideoTime(source.el);
      }
    };
    source.el.addEventListener('seeked', source._seekHandler);
    source.el.play().catch(() => {});
  }
  $('video-bar').hidden = source.type !== 'video';
  $('drop-hint').hidden = !source.isDemo;
  view.fitMode = true;
  view.fit(); // re-fit even when the new output has identical dimensions
  updateExportButtons();
  updateStatus();
  rebuildPanel(); // scene controls appear only for generated sources
  syncMaskEditor();
  dirty = true;
  // record the auto-applied video profile as its own undo step, so the first
  // subsequent slider edit doesn't revert the whole profile in one undo
  if (profileApplied) commitHistory();
  setTimeout(renderPresetThumbs, 250);
  // a slow webcam can arrive with 0×0 dims and fill them in a moment later
  if (keptMask) toast('Mask kept · Clear paint or Effect everywhere to remove', 4000);
  else {
    toast(source.width
      ? `${source.name || source.type} · ${source.width}×${source.height}`
      : `${source.name || source.type} — starting…`);
  }
}

async function openFile(file) {
  const token = ++sourceLoadToken;
  try {
    const next = await loadFile(file);
    if (token !== sourceLoadToken) {
      disposeSource(next);
      return;
    }
    setSource(next);
  } catch (err) {
    if (token === sourceLoadToken) toast(err.message);
  }
}

function updateExportButtons() {
  const isVideo = source?.type === 'video';
  const isWebcam = source?.type === 'webcam';
  const isGen = source?.type === 'gen';
  const isAnimatedImage = source?.type === 'animated-image';
  const animatedStill = source?.type === 'image' && isAnimating();
  const frameAccurate = canFrameExport() && !isWebcam && !isAnimatedImage;
  $('btn-export-video').hidden = !(frameAccurate || canRecord)
    || !(isVideo || isWebcam || isAnimatedImage || animatedStill || isGen);
  // a static image would make a pointless single-frame "animated" GIF
  $('btn-export-gif').hidden = !(isVideo || isWebcam || isAnimatedImage || isGen || animatedStill);
  $('btn-export-txt').hidden = state.mode !== 'ascii';
}

// ---------------------------------------------------------------------------
// busy overlay
// ---------------------------------------------------------------------------
let busyCancel = null;
function showBusy(label, onCancel) {
  $('busy-label').textContent = label;
  $('busy-fill').style.width = '0%';
  $('busy').hidden = false;
  busyCancel = onCancel;
}
function busyProgress(f) {
  $('busy-fill').style.width = `${Math.round(f * 100)}%`;
}
function hideBusy() {
  $('busy').hidden = true;
  busyCancel = null;
}
$('busy-cancel').onclick = () => busyCancel && busyCancel();

function lockMaskForExport() {
  activeExportMaskRasterizer?.releaseAll();
  activeExportMaskRasterizer = maskIsActive() ? new MaskRasterizer() : null;
  if (maskIsActive() && frameBundles.targetPlan && !frameBundles.targetLocked) {
    frameBundles.lockTarget();
  }
  maskEditor.setLocked(true);
  overlayDirty = true;
}

async function beginExport() {
  if (!source || exporting) return false;
  // Set this before committing a draft so every other source/settings action
  // is gated while that commit's required priming render settles.
  exporting = true;
  try {
    maskEditor.beforeExport();
    if (maskPrimingPromise) await maskPrimingPromise;
    if (maskIsActive() && !frameBundles.current) {
      await primeMaskPreview({ activationRevisionId: maskRevisionId });
    }
    if (maskIsActive() && !frameBundles.current) {
      throw new Error('Effect Mask could not establish a paired preview frame');
    }
    lockMaskForExport();
    return true;
  } catch (error) {
    exporting = false;
    unlockMaskAfterExport();
    toast(`Export preparation failed: ${error.message}`);
    return false;
  }
}

function unlockMaskAfterExport() {
  activeExportMaskRasterizer?.releaseAll();
  activeExportMaskRasterizer = null;
  activeMaskedVideoPlan = null;
  frameBundles.unlockTarget();
  maskEditor.setLocked(false);
  overlayDirty = true;
  syncMaskEditor();
}

// ---------------------------------------------------------------------------
// exports
// ---------------------------------------------------------------------------
function createOwnedCanvas(width, height, label = 'canvas') {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  if (canvas.width !== width || canvas.height !== height || !canvas.getContext('2d')) {
    canvas.width = 0;
    canvas.height = 0;
    throw new Error(`${label} allocation failed at ${width}×${height}`);
  }
  return canvas;
}

function releaseOwnedCanvas(canvas) {
  if (!canvas) return;
  canvas.width = 0;
  canvas.height = 0;
}

function exportDescriptor(result) {
  return {
    width: result.width,
    height: result.height,
    samplingKind: state.mode === 'dither' && !engine.lastBoxResolved ? 'crisp' : 'continuous',
    asciiGridInfo: state.mode === 'ascii' ? engine.lastAsciiGridInfo : null,
  };
}

function renderProcessedForExport(budget, {
  captureMetadata = false,
  maxOutputPixels = budget,
  maxOutputSide = MAX_MASKED_EXPORT_SIDE,
} = {}) {
  const [sourceWidth, sourceHeight] = srcDims();
  if (source.type === 'gen') source.gen.tick(genPhaseOverride ?? source.gen.phase);
  const params = derived(captureMetadata);
  params.liveRender = false;
  const detail = engine.renderDetailed(source.el, sourceWidth, sourceHeight, params, {
    maxPixels: budget,
    maxOutputPixels,
    maxOutputSide,
    allowAsync: false,
    contentNew: true,
  });
  const result = detail.renderedResult?.canvas || detail.legacyCanvas;
  if (!result) throw new Error('renderer produced no frame');
  if (result.width > maxOutputSide || result.height > maxOutputSide
      || result.width * result.height > maxOutputPixels) {
    throw new Error(`renderer exceeded masked export bounds at ${result.width}×${result.height}`);
  }
  return {
    canvas: result,
    descriptor: detail.renderedResult?.descriptor || exportDescriptor(result),
  };
}

function maskedPreviewResidentBytes() {
  const bundle = frameBundles.current;
  const bundleBytes = canvasBackingBytes(bundle?.rawTarget) + canvasBackingBytes(bundle?.processedTarget);
  const inFlightBytes = canvasBackingBytes(frameBundles.inFlight?.rawTarget);
  const overlayBytes = canvasBackingBytes($('mask-overlay'));
  const target = bundle
    ? { width: bundle.targetWidth, height: bundle.targetHeight }
    : null;
  const compositorBytes = target
    ? maskCompositor.estimateScratchBytes(target.width, target.height)
    : 0;
  const postFXBytes = target
    ? estimatePostFXBytes(target.width, target.height, state.fx, { fast: true })
    : 0;
  return bundleBytes + inFlightBytes + canvasBackingBytes(out) + overlayBytes
    + maskRasterizer.cacheBytes + compositorBytes + postFXBytes;
}

function capMaskedDimensions(width, height, {
  reserveBytes = 0,
  surfaceCount = 16,
  label = 'export',
} = {}) {
  const remainingBytes = Math.max(
    1,
    MAX_MASKED_EXPORT_WORKING_BYTES - reserveBytes - maskedPreviewResidentBytes(),
  );
  const byteArea = Math.max(1, Math.floor(remainingBytes / (surfaceCount * 4)));
  const area = Math.min(MAX_MASKED_EXPORT_AREA, byteArea);
  const scale = Math.min(
    1,
    MAX_MASKED_EXPORT_SIDE / width,
    MAX_MASKED_EXPORT_SIDE / height,
    Math.sqrt(area / (width * height)),
  );
  const capped = {
    width: Math.max(1, Math.floor(width * scale)),
    height: Math.max(1, Math.floor(height * scale)),
    capped: scale < 1,
  };
  if (capped.capped) toast(`${label} capped to ${capped.width}×${capped.height} (masked memory limit)`);
  return capped;
}


function crispExportTarget(descriptor, capped, { even = false } = {}) {
  if (descriptor.samplingKind !== 'crisp') {
    return {
      width: capped.width,
      height: capped.height,
      normalizedCrop: { u0: 0, v0: 0, u1: 1, v1: 1 },
      processedCrop: { x: 0, y: 0, width: descriptor.width, height: descriptor.height },
      integerScale: null,
    };
  }
  const k = Math.floor(Math.min(capped.width / descriptor.width, capped.height / descriptor.height));
  if (k < 1) throw new Error('masked export target is smaller than the crisp render grid');
  let cropWidth = descriptor.width;
  let cropHeight = descriptor.height;
  if (even && (cropWidth * k) % 2) cropWidth--;
  if (even && (cropHeight * k) % 2) cropHeight--;
  if (cropWidth < 1 || cropHeight < 1) throw new Error('crisp video grid is too small for an even H.264 frame');
  return {
    width: cropWidth * k,
    height: cropHeight * k,
    normalizedCrop: {
      u0: 0,
      v0: 0,
      u1: cropWidth / descriptor.width,
      v1: cropHeight / descriptor.height,
    },
    processedCrop: { x: 0, y: 0, width: cropWidth, height: cropHeight },
    integerScale: k,
  };
}

function buildMaskedExportFrame({
  processed,
  descriptor,
  width,
  height,
  normalizedCrop = { u0: 0, v0: 0, u1: 1, v1: 1 },
  processedCrop = { x: 0, y: 0, width: processed?.width, height: processed?.height },
  processedAlreadyTarget = false,
  grainPhase = currentGrainPhase() ?? 0,
  refH = null,
  fast = false,
} = {}) {
  const [sourceWidth, sourceHeight] = srcDims();
  const rawTarget = createOwnedCanvas(width, height, 'raw export target');
  const processedStage = createOwnedCanvas(width, height, 'processed export target');
  let processedTarget = processedStage;
  let finalCanvas = null;
  const compositor = new MaskCompositor();
  try {
    const rawContext = rawTarget.getContext('2d');
    rawContext.imageSmoothingEnabled = true;
    rawContext.imageSmoothingQuality = 'high';
    rawContext.drawImage(
      source.el,
      normalizedCrop.u0 * sourceWidth,
      normalizedCrop.v0 * sourceHeight,
      (normalizedCrop.u1 - normalizedCrop.u0) * sourceWidth,
      (normalizedCrop.v1 - normalizedCrop.v0) * sourceHeight,
      0,
      0,
      width,
      height,
    );

    const processedContext = processedStage.getContext('2d');
    processedContext.imageSmoothingEnabled = descriptor.samplingKind === 'continuous';
    processedContext.imageSmoothingQuality = 'high';
    if (processedAlreadyTarget) processedContext.drawImage(processed, 0, 0, width, height);
    else {
      const scaleX = width / processedCrop.width;
      const scaleY = height / processedCrop.height;
      if (descriptor.samplingKind === 'crisp'
          && (!Number.isSafeInteger(scaleX) || scaleX < 1 || scaleX !== scaleY)) {
        throw new Error('crisp masked export requires one whole-number pixel scale');
      }
      processedContext.drawImage(
        processed,
        processedCrop.x,
        processedCrop.y,
        processedCrop.width,
        processedCrop.height,
        0,
        0,
        width,
        height,
      );
    }

    const fxResult = applyPostFX(processedStage, state.fx, {
      grainPhase,
      refH: refH ?? sourceHeight,
      fast,
    });
    if (fxResult !== processedStage) {
      processedTarget = createOwnedCanvas(width, height, 'owned post-FX export target');
      processedTarget.getContext('2d').drawImage(fxResult, 0, 0);
    }

    finalCanvas = createOwnedCanvas(width, height, 'final masked export');
    const uniform = maskUniformCoverage();
    if (uniform === 0) {
      compositor.copyRaw({ raw: rawTarget, destination: finalCanvas });
    } else if (uniform === 1) {
      finalCanvas.getContext('2d').drawImage(processedTarget, 0, 0);
    } else {
      const quantization = descriptor.asciiGridInfo
        ? { kind: 'ascii-grid', ...descriptor.asciiGridInfo }
        : CONTINUOUS_QUANTIZATION;
      const effectCoverage = (activeExportMaskRasterizer || maskRasterizer).rasterFor({
        sourceEpoch,
        sourceWidth,
        sourceHeight,
        revision: currentMaskRevision(),
        width,
        height,
        normalizedCrop,
        coverageKind: 'effect',
        quantization,
      });
      compositor.compose({
        processed: processedTarget,
        raw: rawTarget,
        effectCoverage,
        destination: finalCanvas,
      });
    }

    const release = () => {
      compositor.release();
      releaseOwnedCanvas(rawTarget);
      releaseOwnedCanvas(processedStage);
      if (processedTarget !== processedStage) releaseOwnedCanvas(processedTarget);
      releaseOwnedCanvas(finalCanvas);
    };
    return { canvas: finalCanvas, release };
  } catch (error) {
    compositor.release();
    releaseOwnedCanvas(rawTarget);
    releaseOwnedCanvas(processedStage);
    if (processedTarget !== processedStage) releaseOwnedCanvas(processedTarget);
    releaseOwnedCanvas(finalCanvas);
    throw error;
  }
}

async function doExportPNG() {
  if (!source || exporting) return;
  if (!(await beginExport())) return;
  const exportName = `${source.name || 'ditherlab'}-${state.mode}.png`;
  // deterministic bake: an animated still exports its reference frame, not
  // whatever instant the clock happened to be at when the button was clicked
  const pinPhase = source.type === 'image' && isAnimating() && phaseOverride === null;
  if (pinPhase) phaseOverride = 0;
  try {
    const [w, h] = srcDims();
    toast('Rendering…');
    await new Promise((r) => setTimeout(r, 30)); // let toast paint before a heavy CPU pass
    if (maskIsActive()) {
      const requestedArea = Math.min(MAX_MASKED_EXPORT_AREA, Math.max(1, w * h));
      const preliminaryWidth = state.mode === 'dither' && exportSettings.pngSize === 'source2x' ? w * 2 : w;
      const preliminaryHeight = state.mode === 'dither' && exportSettings.pngSize === 'source2x' ? h * 2 : h;
      const preliminaryCap = capMaskedDimensions(preliminaryWidth, preliminaryHeight, { label: 'PNG' });
      const processed = renderProcessedForExport(
        state.mode === 'dither'
          ? Math.min(requestedArea, preliminaryCap.width * preliminaryCap.height)
          : Math.min(requestedArea / 2, preliminaryCap.width * preliminaryCap.height),
      );
      let W = processed.canvas.width;
      let H = processed.canvas.height;
      if (state.mode === 'dither') {
        if (exportSettings.pngSize === 'source') { W = w; H = h; }
        if (exportSettings.pngSize === 'source2x') { W = w * 2; H = h * 2; }
      } else if (exportSettings.pngSize === 'source2x') {
        W = processed.canvas.width * 2;
        H = processed.canvas.height * 2;
      }
      const capped = capMaskedDimensions(W, H, { label: 'PNG' });
      const target = crispExportTarget(processed.descriptor, capped);
      W = target.width;
      H = target.height;
      const finalized = buildMaskedExportFrame({
        processed: processed.canvas,
        descriptor: processed.descriptor,
        width: W,
        height: H,
        normalizedCrop: target.normalizedCrop,
        processedCrop: target.processedCrop,
        grainPhase: currentGrainPhase() ?? 0,
      });
      try {
        const blob = await new Promise((resolve) => finalized.canvas.toBlob(resolve, 'image/png'));
        if (!blob) throw new Error('image too large for this browser');
        downloadBlob(blob, exportName);
        toast(`PNG exported · ${W}×${H}`);
      } finally {
        finalized.release();
      }
      return;
    }
    const p = derived();
    // Apply the browser's area bound before rendering, not after allocating a
    // potentially enormous work canvas/error buffer. Cell effects may produce
    // up to 2x their sampling budget in output pixels.
    const renderBudget = state.mode === 'dither' ? MAX_EXPORT_AREA : MAX_EXPORT_AREA / 2;
    const result = engine.render(source.el, w, h, p, renderBudget);
    if (!result) return;

    let W = result.width;
    let H = result.height;
    if (state.mode === 'dither') {
      if (exportSettings.pngSize === 'source') { W = w; H = h; }
      if (exportSettings.pngSize === 'source2x') { W = w * 2; H = h * 2; }
    } else if (exportSettings.pngSize === 'source2x') {
      W = result.width * 2;
      H = result.height * 2;
    }
    // stay under the browser's canvas limits instead of silently cropping
    if (W > MAX_EXPORT_SIDE || H > MAX_EXPORT_SIDE || W * H > MAX_EXPORT_AREA) {
      const k = Math.min(MAX_EXPORT_SIDE / W, MAX_EXPORT_SIDE / H, Math.sqrt(MAX_EXPORT_AREA / (W * H)));
      W = Math.floor(W * k);
      H = Math.floor(H * k);
      toast(`PNG capped to ${W}×${H} (browser canvas limit)`);
    }

    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    if (c.width !== W || c.height !== H) {
      toast('PNG export failed — image too large for this browser');
      return;
    }
    const cx = c.getContext('2d');
    // crisp 1-bit wants hard nearest-neighbour pixels; a box-resolved (tone)
    // render is continuous and must upscale smoothly — same rule as present()
    // and the MP4 strict flag, read from the engine's ACTUAL last-frame state
    cx.imageSmoothingEnabled = engine.lastBoxResolved;
    cx.imageSmoothingQuality = 'high';
    cx.drawImage(result, 0, 0, W, H);
    const final = applyPostFX(c, state.fx, { grainPhase: currentGrainPhase() ?? 0, refH: h });

    // applyPostFX may return a shared canvas — copy before async encoding.
    const outC = final === c ? c : (() => {
      const cc = document.createElement('canvas');
      cc.width = final.width;
      cc.height = final.height;
      cc.getContext('2d').drawImage(final, 0, 0);
      return cc;
    })();
    const blob = await new Promise((resolve) => outC.toBlob(resolve, 'image/png'));
    if (!blob) {
      toast('PNG export failed — image too large for this browser');
      return;
    }
    downloadBlob(blob, exportName);
    toast(`PNG exported · ${W}×${H}`);
  } catch (err) {
    toast(`PNG export failed: ${err.message}`);
  } finally {
    if (pinPhase) phaseOverride = null;
    exporting = false;
    unlockMaskAfterExport();
    dirty = true;
  }
}

// Record the live preview canvas for a fixed number of seconds (webcam feeds
// and animated still images — anything without a natural clip length).
function recordCanvasSeconds(secs, filename) {
  let rec = null;
  let iv = null;
  let cancelled = false;
  try {
    const mime = VideoExporter.pickMime();
    if (!mime) throw new Error('MediaRecorder is not supported in this browser');
    const stream = out.captureStream(30);
    rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 12_000_000 });
    const chunks = [];
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    rec.onstop = () => {
      clearInterval(iv);
      stream.getTracks().forEach((tr) => tr.stop());
      hideBusy();
      exporting = false;
      unlockMaskAfterExport();
      if (cancelled) {
        toast('Recording cancelled');
        return;
      }
      downloadBlob(new Blob(chunks, { type: mime.split(';')[0] }), `${filename}.${mime.startsWith('video/mp4') ? 'mp4' : 'webm'}`);
      toast('Recording saved');
    };
    rec.start(250);
    // wall-clock based: setInterval is throttled in background tabs
    const t0 = performance.now();
    iv = setInterval(() => {
      const elapsed = (performance.now() - t0) / 1000;
      busyProgress(Math.min(1, elapsed / secs));
      if (elapsed >= secs) { clearInterval(iv); rec.stop(); }
    }, 100);
    showBusy(`Recording ${secs}s…`, () => {
      cancelled = true;
      clearInterval(iv);
      if (rec.state !== 'inactive') rec.stop();
    });
  } catch (err) {
    clearInterval(iv);
    hideBusy();
    exporting = false;
    unlockMaskAfterExport();
    toast(`Recording failed: ${err.message}`);
  }
}

// Render budget for the frame-accurate MP4 exporters. GPU dithers can afford
// a grid as fine as the H.264 pipeline can take: the encoder integer-upscales
// by >=2x with a 3840px long-side / level 5.1 (~8.9M luma) ceiling, so the
// GRID must keep its long side <=1920 and its area <=2.2MP. CPU algorithms
// keep the classic EXPORT_PIXELS (a 2.2MP synchronous error-diffusion per
// frame would stretch exports into many minutes for little visible gain).
function mp4RenderBudget() {
  const gpuAlgo = state.mode === 'dither' && getAlgorithm(state.algorithm).type === 'gpu';
  const [w, h] = srcDims();
  const long = Math.max(w, h, 1);
  const longSideArea = Math.max(1, Math.round(w * h * Math.min(1, (1920 / long) ** 2)));
  return Math.min(gpuAlgo ? 2_200_000 : EXPORT_PIXELS, longSideArea);
}

function renderMp4Frame(masked) {
  if (!masked) {
    renderOnce(mp4RenderBudget());
    return out;
  }
  const rendered = renderProcessedForExport(mp4RenderBudget());
  return {
    canvas: rendered.canvas,
    meta: {
      descriptor: rendered.descriptor,
      grainPhase: currentGrainPhase() ?? 0,
    },
  };
}

function planMaskedMp4Target({ first, frameMeta, defaultTarget, maxSampleBytes }) {
  const capped = capMaskedDimensions(defaultTarget.width, defaultTarget.height, {
    reserveBytes: maxSampleBytes,
    label: 'Video',
  });
  const descriptor = frameMeta?.descriptor || exportDescriptor(first);
  activeMaskedVideoPlan = crispExportTarget(descriptor, capped, { even: true });
  if (descriptor.samplingKind !== 'crisp') {
    activeMaskedVideoPlan.width = Math.max(2, activeMaskedVideoPlan.width & ~1);
    activeMaskedVideoPlan.height = Math.max(2, activeMaskedVideoPlan.height & ~1);
  }
  return {
    width: activeMaskedVideoPlan.width,
    height: activeMaskedVideoPlan.height,
    scale: activeMaskedVideoPlan.integerScale ?? defaultTarget.scale,
  };
}

function finalizeMp4Frame(processed, { width, height, frameMeta }) {
  return buildMaskedExportFrame({
    processed,
    descriptor: frameMeta?.descriptor || exportDescriptor(processed),
    width,
    height,
    normalizedCrop: activeMaskedVideoPlan?.normalizedCrop,
    processedCrop: activeMaskedVideoPlan?.processedCrop,
    grainPhase: frameMeta?.grainPhase ?? currentGrainPhase() ?? 0,
  });
}

function abortVideoExport(error) {
  phaseOverride = null;
  genPhaseOverride = null;
  engine.invalidateTemporal();
  dirty = true;
  hideBusy();
  if (exporting) {
    exporting = false;
    unlockMaskAfterExport();
  }
  toast(`Video export failed: ${error?.message || error}`);
}

async function doExportVideo() {
  if (!source || exporting) return;
  const isAnimatedImage = source.type === 'animated-image';
  const animatedStill = source.type === 'image' && isAnimating();
  const isGen = source.type === 'gen';
  if (!(source.el instanceof HTMLVideoElement) && !isAnimatedImage && !animatedStill && !isGen) return;
  if (!(await beginExport())) return;
  const maskedExport = maskIsActive();
  engine.invalidateTemporal(); // frame 0 of the export must not blend with the preview

  let secs = parseInt(exportSettings.recordSeconds, 10) || 5;
  if (source.type === 'webcam' || isAnimatedImage) {
    recordCanvasSeconds(secs, source.type === 'webcam'
      ? 'ditherlab-webcam'
      : `${source.name || 'animated-image'}-${state.mode}`);
    return;
  }
  // strict resolved AFTER the exporter's sizing render: raw state.smoothness
  // lies for CPU algorithms and lost WebGL (engine.lastBoxResolved is the
  // actual crisp-vs-tone state of the frame being exported)
  const strictFn = () => !engine.lastBoxResolved;

  if (isGen || animatedStill) {
    const name = isGen
      ? `${source.name || 'scene'}-${state.mode}`
      : `${source.name || 'ditherlab'}-${state.mode}-${state.anim.style}`;
    // Deterministic sources deserve the frame-accurate path too: the realtime
    // recorder just captures the live preview, inheriting its budget, judder
    // and wall-clock pacing. Bake exactly the whole-cycle span instead.
    if (canFrameExport()) {
      const fps = 30;
      const count = Math.max(2, Math.round(secs * fps));
      // Preserve the selected duration and the tuned speeds. MP4 playback does
      // not need to be loop-perfect (GIF baking still is); rounding cycles made
      // a requested 3s slow scene silently turn into a 32s/960-frame export.
      const genCycles = isGen ? secs * source.gen.params.speed * GEN_CYCLES_PER_SEC : 0;
      const effCycles = isAnimating() ? secs * state.anim.speed * 0.15 : 0;
      let cancelled = false;
      let fallbackToRecorder = false;
      showBusy('Rendering video (frame-accurate)…', () => { cancelled = true; });
      try {
        await exportLoopFrameAccurate({
          renderFrame: () => renderMp4Frame(maskedExport),
          setPhase: (f) => {
            if (isGen) genPhaseOverride = (f * genCycles) % 1;
            if (effCycles) phaseOverride = (f * effCycles) % 1;
          },
          count,
          fps,
          name,
          strict: strictFn,
          planFinalTarget: maskedExport ? planMaskedMp4Target : null,
          finalizeFrame: maskedExport ? finalizeMp4Frame : null,
          onProgress: busyProgress,
          onInfo: (msg) => toast(msg, 4000),
          shouldAbort: () => cancelled,
        });
        toast('Video exported');
      } catch (err) {
        fallbackToRecorder = err.name === 'NotSupportedError' && canRecord;
        if (!fallbackToRecorder) {
          toast(err.message === 'cancelled' ? 'Export cancelled' : `Video export failed: ${err.message}`);
        }
      }
      phaseOverride = null;
      genPhaseOverride = null;
      engine.invalidateTemporal(); // do not blend restored source time with the export tail
      dirty = true; // restore the live preview resolution
      hideBusy();
      if (!fallbackToRecorder) {
        exporting = false;
        unlockMaskAfterExport();
        return;
      }
      toast('H.264 unavailable — using real-time recorder', 4000);
      // The failed frame-accurate attempt resized `out` for export. Restore the
      // stable live bitmap before captureStream() starts; resizing a captured
      // canvas mid-recording can glitch or truncate the first frames.
      try {
        renderOnce();
      } catch (error) {
        abortVideoExport(error);
        return;
      }
    }
    recordCanvasSeconds(secs, name);
    return;
  }

  const name = `${source.name || 'ditherlab'}-${state.mode}`;

  // Preferred: frame-accurate H.264 via WebCodecs. Renders each frame with no
  // time pressure, so the exported clip is smooth no matter how slow the
  // dither is on this device (silent — no audio).
  if (canFrameExport()) {
    let cancelled = false;
    let fallbackToRecorder = false;
    const pinAnim = isAnimating();
    showBusy('Rendering video (frame-accurate)…', () => { cancelled = true; });
    try {
      await exportVideoFrameAccurate({
        video: source.el,
        renderFrame: () => renderMp4Frame(maskedExport),
        name,
        strict: strictFn,
        // true source rate from playback (rVFC mediaTime deltas) — sampling
        // 24fps footage on a 30fps grid bakes 2:3 pulldown judder into the file
        sourceFps: source._frameDurEma ? 1 / source._frameDurEma : 0,
        planFinalTarget: maskedExport ? planMaskedMp4Target : null,
        finalizeFrame: maskedExport ? finalizeMp4Frame : null,
        // pattern animation pinned to the VIDEO timeline, not wall clock (the
        // live loop would otherwise advance it while the exporter awaits) —
        // also stops the loop's concurrent renders during the export
        onFrameTime: pinAnim ? (t) => { phaseOverride = (t * state.anim.speed * 0.15) % 1; } : null,
        onProgress: busyProgress,
        onInfo: (msg) => toast(msg, 4000),
        shouldAbort: () => cancelled,
      });
      toast('Video exported');
    } catch (err) {
      fallbackToRecorder = err.name === 'NotSupportedError' && canRecord;
      if (!fallbackToRecorder) {
        toast(err.message === 'cancelled' ? 'Export cancelled' : `Video export failed: ${err.message}`);
      }
    }
    if (pinAnim) phaseOverride = null;
    engine.invalidateTemporal();
    dirty = true; // restore the live preview resolution
    hideBusy();
    if (!fallbackToRecorder) {
      exporting = false;
      unlockMaskAfterExport();
      return;
    }
    toast('H.264 unavailable — using real-time recorder', 4000);
    try {
      renderOnce();
    } catch (error) {
      abortVideoExport(error);
      return;
    }
  }

  // Fallback (no WebCodecs): real-time capture, keeps audio.
  const exporter = new VideoExporter(out, source.el, {
    fps: 30,
    onProgress: busyProgress,
    renderFrame: () => renderOnce(),
  });
  // cancel() aborts start(), which throws 'cancelled' and restores the video
  showBusy('Exporting video (plays through once)…', () => exporter.cancel());
  try {
    await exporter.start(name);
    toast('Video exported');
  } catch (err) {
    toast(err.message === 'cancelled' ? 'Export cancelled' : `Video export failed: ${err.message}`);
  }
  // VideoExporter restores the original playback time in finally while the
  // normal seek handler is suppressed by exporting=true. Force the editor to
  // redraw that restored frame instead of leaving the export tail on screen.
  engine.invalidateTemporal();
  dirty = true;
  hideBusy();
  exporting = false;
  unlockMaskAfterExport();
}

async function doExportGIF() {
  if (!source || exporting) return;
  if (!(await beginExport())) return;
  const maskedExport = maskIsActive();
  engine.invalidateTemporal(); // frame 0 of the export must not blend with the preview
  // 'native' = exactly the rendered frame, no resampling
  const maxWidth = exportSettings.gifSize === 'native' ? Infinity : parseInt(exportSettings.gifSize, 10);
  let cancelled = false;
  showBusy('Encoding GIF…', () => { cancelled = true; });

  // Animated stills bake exactly one animation cycle -> seamless loop.
  // Video default 50/3 fps: an exact 6-centisecond GIF frame delay (no
  // rounding drift) and visibly smoother motion than the old 12.
  let fps = 50 / 3;
  let animate = null;
  const liveDuration = source.type === 'webcam' || source.type === 'animated-image'
    ? (parseInt(exportSettings.recordSeconds, 10) || 5)
    : 0;
  if (source.type === 'gen') {
    const cycleSec = 1 / (source.gen.params.speed * GEN_CYCLES_PER_SEC);
    const count = Math.min(180, Math.max(24, Math.round(cycleSec * 15)));
    fps = count / cycleSec;
    // effect animation runs a whole number of its own cycles inside the
    // scene loop, so both wrap seamlessly in the baked GIF
    let animCycles = isAnimating() ? Math.max(1, Math.round(cycleSec * state.anim.speed * 0.15)) : 0;
    animate = {
      count,
      setPhase: (ph) => {
        genPhaseOverride = ph;
        if (animCycles) phaseOverride = (ph * animCycles) % 1;
      },
      // memory guard lowered the frame count: keep >=3 samples per effect
      // cycle (still a whole number of cycles -> still seamless) or the
      // effect strobes in the bake
      onResample: (newCount) => {
        if (animCycles) animCycles = Math.max(1, Math.min(animCycles, Math.floor(newCount / 3)));
      },
    };
  } else if (source.type === 'image' && isAnimating()) {
    const cycleSec = 1 / (state.anim.speed * 0.15);
    const count = Math.min(150, Math.max(10, Math.round(cycleSec * 15)));
    fps = count / cycleSec;
    animate = { count, setPhase: (ph) => { phaseOverride = ph; } };
  } else if (source.type === 'video' && isAnimating()) {
    // deterministic: phase follows the video timeline, not the wall clock
    animate = { setTime: (t) => { phaseOverride = (t * state.anim.speed * 0.15) % 1; } };
  }

  // Post-FX for GIFs is applied AFTER decimation, at the GIF's own
  // resolution: baked-then-decimated scanlines/grain are sub-Nyquist at the
  // usual 480px sizes and either average away (smooth) or alias (strict).
  // The frames render raw (noFx) and this hook re-applies the stack per
  // frame with refH compensated so intensity/geometry match the preview.
  const fxOn = Object.values(state.fx).some((v) => v > 0);
  let fxCanvas = null;
  let fxCtx = null;
  let gifProcessedCanvas = null;
  let gifProcessedCtx = null;
  const gifPostFXRefH = (gw, gh, sizeMeta = null) => {
    const descriptor = sizeMeta?.frameMeta?.descriptor;
    const renderedWidth = descriptor?.width || out.width;
    const renderedHeight = descriptor?.height || out.height;
    const scale = state.mode === 'dither'
      ? Math.min(2, Math.max(1, srcDims()[0] / Math.max(1, renderedWidth)))
      : 1;
    return (srcDims()[1] || gh) * (gh / Math.max(1, renderedHeight * scale));
  };
  const postProcess = (fxOn || maskedExport) ? (pixels, gw, gh, sizeMeta = null) => {
    if (!fxCanvas) {
      fxCanvas = document.createElement('canvas');
      fxCtx = fxCanvas.getContext('2d', { willReadFrequently: true });
    }
    if (fxCanvas.width !== gw || fxCanvas.height !== gh) {
      fxCanvas.width = gw;
      fxCanvas.height = gh;
    }
    fxCtx.putImageData(new ImageData(pixels, gw, gh), 0, 0);
    if (maskedExport) {
      const finalized = buildMaskedExportFrame({
        processed: fxCanvas,
        descriptor: sizeMeta?.frameMeta?.descriptor || {
          width: gw,
          height: gh,
          samplingKind: state.mode === 'dither' && !engine.lastBoxResolved ? 'crisp' : 'continuous',
          asciiGridInfo: engine.lastAsciiGridInfo,
        },
        width: gw,
        height: gh,
        normalizedCrop: sizeMeta?.normalizedCrop || { u0: 0, v0: 0, u1: 1, v1: 1 },
        processedAlreadyTarget: true,
        grainPhase: sizeMeta?.frameMeta?.grainPhase ?? currentGrainPhase() ?? 0,
        refH: gifPostFXRefH(gw, gh, sizeMeta),
      });
      try {
        return finalized.canvas.getContext('2d', { willReadFrequently: true })
          .getImageData(0, 0, gw, gh).data;
      } finally {
        finalized.release();
      }
    }
    // present() would show this render at out.height * scale with refH=srcH;
    // scale refH by our (smaller) canvas so the fx read proportionally alike
    const refH = gifPostFXRefH(gw, gh, sizeMeta);
    const final = applyPostFX(fxCanvas, state.fx, { grainPhase: currentGrainPhase(), refH });
    return final.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, gw, gh).data;
  } : null;

  try {
    await exportGIF({
      video: source.type === 'video' ? source.el : null,
      animate,
      liveDuration,
      // GIF has no H.264 1920px long-side restriction. Keep the established
      // 1.6MP export budget so wide/native GIFs are not needlessly softened.
      renderFrame: () => {
        if (maskedExport) {
          const rendered = renderProcessedForExport(EXPORT_PIXELS);
          // The GPU renderer's canvas already owns a WebGL context, so the GIF
          // sampler cannot call getContext('2d') on it. Copy that branch into
          // one reusable 2D staging canvas; CPU/ASCII/cell results are already
          // readable and avoid the extra blit.
          if (rendered.canvas === engine.glCanvas) {
            if (!gifProcessedCanvas) {
              gifProcessedCanvas = document.createElement('canvas');
              gifProcessedCtx = gifProcessedCanvas.getContext('2d', { willReadFrequently: true });
            }
            if (gifProcessedCanvas.width !== rendered.canvas.width
                || gifProcessedCanvas.height !== rendered.canvas.height) {
              gifProcessedCanvas.width = rendered.canvas.width;
              gifProcessedCanvas.height = rendered.canvas.height;
            }
            gifProcessedCtx.globalCompositeOperation = 'copy';
            gifProcessedCtx.drawImage(rendered.canvas, 0, 0);
            rendered.canvas = gifProcessedCanvas;
          }
          return {
            canvas: rendered.canvas,
            meta: {
              descriptor: rendered.descriptor,
              grainPhase: currentGrainPhase() ?? 0,
            },
          };
        }
        renderOnce(EXPORT_PIXELS, true, fxOn);
        return out;
      },
      fps,
      maxWidth,
      // dither wants exact pixels UNLESS the render is box-resolved tone
      // (smoothness), which point-decimation would re-speckle; evaluated
      // after the sizing render so it reflects the actual export frame
      smooth: () => state.mode !== 'dither' || engine.lastBoxResolved,
      postProcess,
      onSized: () => engine.invalidateTemporal(),
      name: `${source.name || 'ditherlab'}-${state.mode}`,
      onInfo: (msg) => toast(msg, 4000),
      shouldAbort: () => cancelled,
      onProgress: (f) => {
        if (cancelled) throw new Error('cancelled');
        busyProgress(f);
      },
    });
    toast('GIF exported');
  } catch (err) {
    toast(err.message === 'cancelled' ? 'Export cancelled' : `GIF export failed: ${err.message}`);
  }
  phaseOverride = null;
  genPhaseOverride = null;
  engine.invalidateTemporal();
  dirty = true; // restore the live preview resolution
  hideBusy();
  exporting = false;
  unlockMaskAfterExport();
}

function doExportTxt() {
  if (state.mode !== 'ascii') return;
  renderOnce(Infinity, true, false, true); // text exports capture the full-resolution grid once
  const name = `${source?.name || 'ditherlab'}-ascii`;
  const fmt = exportSettings.txtFormat;
  if (fmt === 'ansi' && engine.ascii.lastGrid) {
    const defaultBg = state.ascii.colorMode === 'mono'
      ? parseInt(state.ascii.bg.replace('#', ''), 16)
      : null;
    exportText(buildAnsi(engine.ascii.lastGrid, { defaultBg }), name, 'ans');
    toast(maskIsActive()
      ? 'ANSI exported · Effect Mask applies only to raster/video output'
      : 'ANSI text exported — try: cat file.ans');
  } else if (fmt === 'html' && engine.ascii.lastGrid) {
    const f = FONTS[state.ascii.fontId] || FONTS.menlo;
    exportText(buildHtml(engine.ascii.lastGrid, state.ascii.bg, {
      family: f.family,
      size: state.ascii.cellSize,
      bold: state.ascii.bold,
    }), name, 'html');
    toast(maskIsActive() ? 'HTML exported · Effect Mask applies only to raster/video output' : 'HTML exported');
  } else {
    exportText(engine.ascii.lastText, name);
    toast(maskIsActive() ? 'ASCII exported · Effect Mask applies only to raster/video output' : 'ASCII text exported');
  }
  dirty = true; // restore the live preview resolution
}

exportSettings.onCopyText = () => {
  if (state.mode !== 'ascii') return;
  renderOnce(Infinity, true, false, true);
  dirty = true;
  navigator.clipboard.writeText(engine.ascii.lastText)
    .then(() => toast(maskIsActive()
      ? 'Copied full-frame ASCII · Effect Mask applies only to raster/video output'
      : 'Copied to clipboard'))
    .catch(() => toast('Clipboard unavailable'));
};

// ---------------------------------------------------------------------------
// UI wiring
// ---------------------------------------------------------------------------
function rebuildPanel() {
  buildPanel({
    state,
    mount: $('panel'),
    exportSettings,
    isLive: source?.type === 'video' || source?.type === 'webcam',
    gen: source?.type === 'gen' ? source.gen : null,
    onGenChange: () => {
      if (exporting || maskPriming) return;
      clearActivePreset($('preset-strip'));
      if (source?.type === 'gen') source.name = source.gen.sceneName().toLowerCase();
      updateStatus();
      pushHistory();
      effectRevision++;
      frameBundles.invalidate('generative change', { releaseCurrent: false });
      dirty = true;
    },
    onChange: () => {
      if (exporting || maskPriming) return;
      clearActivePreset($('preset-strip'));
      updateExportButtons();
      updateStatus();
      syncMaskEditor();
      pushHistory();
      effectRevision++;
      frameBundles.invalidate('effect change', { releaseCurrent: false });
      dirty = true;
    },
  });
}

function applyPreset(preset) {
  if (exporting || maskPriming) return;
  maskEditor.cancelDraft();
  commitHistory(); // land any pending debounced edit first
  resetState(state);
  applyParams(state, preset.params);
  rebuildPanel();
  updateExportButtons();
  updateStatus();
  syncMaskEditor();
  effectRevision++;
  frameBundles.invalidate('preset change', { releaseCurrent: false });
  commitHistory();
  dirty = true;
  toast(preset.name);
}

thumbCanvases = buildPresetStrip({
  mount: $('preset-strip'),
  presets: PRESETS,
  onApply: applyPreset,
  onShuffle: () => {
    if (exporting || maskPriming) return;
    maskEditor.cancelDraft();
    commitHistory();
    clearActivePreset($('preset-strip'));
    resetState(state);
    applyParams(state, shuffleParams());
    rebuildPanel();
    updateExportButtons();
    updateStatus();
    syncMaskEditor();
    effectRevision++;
    frameBundles.invalidate('shuffle change', { releaseCurrent: false });
    commitHistory();
    dirty = true;
    toast('Shuffled');
  },
});

rebuildPanel();

$('btn-open').onclick = () => $('file-input').click();
$('file-input').addEventListener('change', (e) => {
  const f = e.target.files[0];
  if (f) openFile(f);
  e.target.value = '';
});

$('btn-demo').onclick = async () => {
  if (exporting) return;
  const token = ++sourceLoadToken;
  const next = await demoPhoto().catch(() => demoImage());
  if (token === sourceLoadToken) setSource(next);
  else disposeSource(next);
};

$('btn-generate').onclick = () => {
  if (exporting) return;
  sourceLoadToken++; // supersede an in-flight file/camera request
  if (!gen) {
    try {
      gen = new GenerativeSource(1920, 1200);
    } catch (err) {
      // constructor throws on shader compile/link failure (lost context, OOM)
      gen = null;
      toast('Could not start generative scenes — try again');
      console.warn('generate:', err);
      return;
    }
    if (!gen.isSupported()) {
      toast('WebGL2 unavailable — cannot generate scenes');
      gen = null;
      return;
    }
  }
  if (source?.type === 'gen') gen.nextScene();
  else gen.setScene(gen.params.scene, { randomizeSeed: true });
  gen.tick(gen.phase);
  setSource({
    type: 'gen',
    el: gen.canvas,
    width: gen.canvas.width,
    height: gen.canvas.height,
    name: gen.sceneName().toLowerCase(),
    gen,
  });
  commitHistory(); // baseline with the fresh scene params, so edits can undo
};
$('btn-webcam').onclick = async () => {
  if (exporting) return;
  const token = ++sourceLoadToken;
  try {
    const next = await openWebcam();
    if (token === sourceLoadToken) setSource(next);
    else disposeSource(next);
  } catch (err) {
    if (token === sourceLoadToken) toast(`Webcam unavailable: ${err.message}`);
  }
};

$('btn-reset').onclick = () => {
  if (exporting || maskPriming) return;
  maskEditor.cancelDraft();
  commitHistory();
  clearActivePreset($('preset-strip'));
  resetState(state);
  commitMaskProposal(maskStore.proposeReset(maskRevisionId), { addHistory: false });
  Object.assign(exportSettings, EXPORT_DEFAULTS);
  rebuildPanel();
  updateExportButtons();
  updateStatus();
  syncMaskEditor();
  effectRevision++;
  frameBundles.invalidate('reset');
  commitHistory();
  dirty = true;
  toast('Reset · mask cleared');
};

$('btn-shuffle').onclick = () => {
  if (exporting || maskPriming) return;
  maskEditor.cancelDraft();
  commitHistory();
  clearActivePreset($('preset-strip'));
  resetState(state);
  applyParams(state, shuffleParams());
  rebuildPanel();
  updateExportButtons();
  updateStatus();
  syncMaskEditor();
  effectRevision++;
  frameBundles.invalidate('shuffle change', { releaseCurrent: false });
  commitHistory(); // discrete action: its own undo step, never merged with the next edit
  dirty = true;
  toast('Shuffled');
};

// hold-to-compare
const startCompare = (e) => {
  if (exporting || maskPriming || maskEditor.hasDraft) return;
  e.preventDefault();
  comparing = true;
  maskEditor.setComparing(true);
  dirty = true;
};
const endCompare = () => {
  if (comparing) {
    comparing = false;
    maskEditor.setComparing(false);
    if (fastMaskPreview && maskIsActive()) presentFastMaskPreview();
    else if (frameBundles.current && maskIsActive()) presentMaskedBundle();
    else dirty = true;
  }
};
$('btn-compare').addEventListener('mousedown', startCompare);
$('btn-compare').addEventListener('touchstart', startCompare, { passive: false });
window.addEventListener('mouseup', endCompare);
window.addEventListener('touchend', endCompare);
window.addEventListener('blur', endCompare); // keyup can be lost on window switch
window.addEventListener('blur', () => maskEditor.handleBlur());
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') endCompare();
});

window.addEventListener('keydown', (e) => {
  if (maskEditor.handleKeyDown(e)) return;
  if (exporting || maskPriming) return;
  const active = document.activeElement;
  const tag = active?.tagName;
  const textEditable = tag === 'TEXTAREA'
    || (tag === 'INPUT' && ['text', 'search', 'number', 'url'].includes(active.type));
  // undo/redo — but text fields keep their native text-undo
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
    if (textEditable) return;
    e.preventDefault();
    if (e.shiftKey) redo();
    else undo();
    return;
  }
  const inField = tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA';
  if (inField || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === 'c' && !e.repeat) { comparing = true; dirty = true; }
  if (e.key === ' ' && source?.type === 'video') {
    e.preventDefault();
    togglePlay();
  }
  if (e.key === '+' || e.key === '=') view.zoomBy(1.25);
  if (e.key === '-') view.zoomBy(1 / 1.25);
  if (e.key === '0') view.fit();
  if (e.key === '1') view.actualSize();
  if (e.key === 's') $('btn-split').click();
});
window.addEventListener('keyup', (e) => {
  if (maskEditor.handleKeyUp(e)) return;
  if (e.key === 'c') endCompare();
});

$('btn-export-png').onclick = doExportPNG;
$('btn-export-video').onclick = () => { void doExportVideo().catch(abortVideoExport); };
$('btn-export-gif').onclick = doExportGIF;
$('btn-export-txt').onclick = doExportTxt;

// video bar
function togglePlay() {
  if (exporting) return;
  const el = source.el;
  if (el.paused) { el.play(); $('btn-play').textContent = '❚❚'; }
  else { el.pause(); $('btn-play').textContent = '▶'; }
  transportRevision++;
  frameBundles.invalidate('transport change', { releaseCurrent: false });
  // Paused error-diffusion is allowed a higher-detail still render; resuming
  // returns to the pixel-size-aware live budget. Force either transition to
  // replace the previous-size worker result immediately.
  if (engine.cpu) engine.cpu.invalidate();
  dirty = true;
}
$('btn-play').onclick = () => source?.type === 'video' && togglePlay();
$('seek').addEventListener('pointerdown', () => { scrubbing = true; });
$('seek').addEventListener('pointerup', () => { scrubbing = false; });
$('seek').addEventListener('pointercancel', () => { scrubbing = false; });
window.addEventListener('blur', () => { scrubbing = false; });
$('seek').addEventListener('input', () => {
  if (source?.type !== 'video' || exporting) return;
  const el = source.el;
  if (isFinite(el.duration) && el.duration) {
    el.currentTime = (parseInt($('seek').value, 10) / 1000) * el.duration;
    transportRevision++;
    updateVideoTime(el);
    dirty = true;
  }
});
$('speed').addEventListener('change', () => {
  if (exporting) return;
  if (source?.el instanceof HTMLVideoElement) {
    source.el.playbackRate = parseFloat($('speed').value);
    transportRevision++;
  }
});

// drag & drop + paste
bindDropAndPaste($('viewport'), openFile);

// boot with the demo scene, unless a user-selected source wins the race while
// the bundled image is still decoding.
const bootSourceToken = ++sourceLoadToken;
const bootSource = await demoPhoto().catch(() => demoImage());
if (bootSourceToken === sourceLoadToken) setSource(bootSource);
else disposeSource(bootSource);

// shareable boot params: ?preset=<id>&split=1
const qp = new URLSearchParams(location.search);
const defaultsSnapshot = snapshotStr(); // undo must reach the defaults beneath a boot preset
const bootPreset = PRESETS.find((p) => p.id === qp.get('preset'));
if (bootPreset) {
  applyParams(state, bootPreset.params);
  rebuildPanel();
  updateExportButtons();
  updateStatus();
  syncMaskEditor();
  document.querySelector(`.preset-card[data-id="${bootPreset.id}"]`)?.classList.add('active');
}
const genParam = qp.get('gen');
if (genParam) {
  // same guard as btn-generate: a constructor throw here would abort the
  // whole module (no render loop, dead app) instead of degrading to the demo
  try {
    gen = new GenerativeSource(1920, 1200);
  } catch (err) {
    gen = null;
    console.warn('generate:', err);
  }
  if (gen && gen.isSupported()) {
    gen.setScene(genParam, { randomizeSeed: false });
    gen.tick(0);
    setSource({
      type: 'gen',
      el: gen.canvas,
      width: gen.canvas.width,
      height: gen.canvas.height,
      name: gen.sceneName().toLowerCase(),
      gen,
    });
    commitHistory();
  } else {
    gen = null;
  }
}
const splitParam = qp.get('split');
if (splitParam && splitParam !== '0' && splitParam.toLowerCase() !== 'false') $('btn-split').click();

history.stack = bootPreset ? [defaultsSnapshot, snapshotStr()] : [snapshotStr()];
history.index = history.stack.length - 1;
updateUndoButtons();
requestAnimationFrame(loop);

// glyph metrics were measured against fallback fonts — refresh once real
// fonts finish loading so ASCII grids don't stay misaligned
document.fonts?.ready?.then(() => {
  engine.ascii.clearCaches();
  thumbEngine.ascii.clearCaches();
  dirty = true;
});

// native macOS paste bridge (the Swift wrapper feeds images through this)
window.__dlNativePaste = async (dataURL) => {
  try {
    const blob = await (await fetch(dataURL)).blob();
    openFile(new File([blob], 'pasted.png', { type: blob.type || 'image/png' }));
  } catch {
    toast('Paste failed');
  }
};

// tiny debug/testing handle (not part of the UI)
window.__dl = {
  renderOnce,
  setPhase(ph) { phaseOverride = ph; dirty = true; },
  clearPhase() { phaseOverride = null; dirty = true; },
  setGenPhase(ph) { genPhaseOverride = ph; dirty = true; },
  clearGenPhase() { genPhaseOverride = null; dirty = true; },
  get source() { return source; },
  get mask() {
    return {
      revisionId: maskRevisionId,
      uniformCoverage: maskUniformCoverage(),
      draft: !!maskDraft,
      editorDraft: maskEditor.hasDraft,
      liveSession: !!liveMaskSession,
      fastPreview: !!fastMaskPreview,
      fastTarget: fastMaskPreview
        ? `${fastMaskPreview.targetWidth}x${fastMaskPreview.targetHeight}`
        : null,
      exporting,
    };
  },
  get maskTimings() { return { effectRenderMs, bundleBuildMs, maskCompositeMs }; },
  engine,
  state,
};
