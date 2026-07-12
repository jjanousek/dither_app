// App bootstrap: state, render loop, viewport, history, source management,
// exports, preset thumbnails, UI wiring.

import { Engine, getAlgorithm } from './engine/engine.js';
import { createState, applyParams, resetState, DEFAULTS } from './state.js';
import { getPalette } from './palettes.js';
import { RAMPS, FONTS } from './engine/ascii.js';
import { applyPostFX } from './effects/postfx.js';
import { PRESETS, shuffleParams } from './presets.js';
import { loadFile, openWebcam, demoImage, demoPhoto, bindDropAndPaste } from './sources.js';
import { exportText, buildAnsi, buildHtml, VideoExporter, exportGIF, downloadBlob, canFrameExport, exportVideoFrameAccurate, exportLoopFrameAccurate } from './export/exporters.js';
import { buildPanel, buildPresetStrip, clearActivePreset, toast } from './ui.js';
import { Viewport } from './view.js';
import { GenerativeSource } from './generate.js';
import { LIVE_CPU_DITHER_BUDGETS, liveCpuDitherBudget } from './preview-policy.js';

const MAX_LIVE_PIXELS = LIVE_CPU_DITHER_BUDGETS.balanced; // cells / non-shape ASCII
const MAX_LIVE_CPU_PIXELS = LIVE_CPU_DITHER_BUDGETS.coarse; // shape ASCII / coarse CPU dither
const MAX_LIVE_GPU_PIXELS = 2_250_000; // GPU dithers are cheap at any size — enough for true native 1080p (2.07MP)
const MAX_STILL_PREVIEW_PIXELS = 1_250_000; // high-detail stills; bounded below runaway source sizes
const LIVE_FX_PIXELS = 2_250_000;  // cap on the live post-FX compositing area (Canvas2D raster)
const EXPORT_PIXELS = 1_600_000;   // GIF/text exports render finer than the live preview
const MAX_EXPORT_SIDE = 16384;     // canvas hard limits (Chromium/WebKit)
const MAX_EXPORT_AREA = 64_000_000;
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
const state = createState();
const EXPORT_DEFAULTS = Object.freeze({ pngSize: 'source', gifSize: '480', recordSeconds: '5', txtFormat: 'plain' });
const exportSettings = { ...EXPORT_DEFAULTS };

let source = null;
let sourceLoadToken = 0;
let dirty = true;
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

$('zoom-in').onclick = () => view.zoomBy(1.25);
$('zoom-out').onclick = () => view.zoomBy(1 / 1.25);
$('zoom-fit').onclick = () => view.fit();
$('zoom-readout').onclick = () => view.fit();
$('zoom-100').onclick = () => view.actualSize();

$('btn-split').onclick = () => {
  view.setSplit(!view.splitOn);
  $('btn-split').classList.toggle('active', view.splitOn);
  cmp.hidden = !view.splitOn;
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
// render + present
// ---------------------------------------------------------------------------
function renderOnce(budgetOverride = null, contentNew = true, noFx = false, captureMetadata = false) {
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
  if (budgetOverride === null) {
    const cpuDither = state.mode === 'dither' && getAlgorithm(state.algorithm).type === 'cpu';
    const heavyAscii = state.mode === 'ascii' && state.ascii.renderer === 'shape';
    const videoMoving = source.el instanceof HTMLVideoElement
      && (!source.el.paused && !source.el.ended);
    const inherentlyMoving = source.type === 'webcam'
      || source.type === 'gen'
      || source.type === 'animated-image';
    const moving = videoMoving || inherentlyMoving || isAnimating();
    if (moving && cpuDither) budget = liveCpuDitherBudget(state.pixelSize);
    else if (moving && heavyAscii) budget = MAX_LIVE_CPU_PIXELS;
    else if (!moving && state.mode !== 'dither') budget = MAX_STILL_PREVIEW_PIXELS;
    else if (state.mode === 'dither') budget = MAX_LIVE_GPU_PIXELS;
  }
  // Only the live preview (no budget override, not exporting) may run the CPU
  // dither in the worker; exports and thumbnails stay synchronous.
  const allowAsync = budgetOverride === null && !exporting;
  // Live-loop render vs one-shot (export/copy) render. Realtime canvas
  // recordings capture the live loop, so they must keep the exact live
  // presentation; frame-exact exporters pass a budget override and get the
  // uncapped, deterministic rendition.
  p.liveRender = budgetOverride === null;
  const result = engine.render(source.el, w, h, p, budgetOverride ?? budget, allowAsync, contentNew);
  if (result) present(result, w, budgetOverride !== null, noFx);
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
  // Crisp dither wants nearest-neighbour upscaling (sharp dots); a box-resolved
  // (tone) result should scale smoothly. Use the engine's ACTUAL last-frame
  // state so a CPU algorithm, WebGL loss, or governor ss->1 (all crisp) keep
  // nearest-neighbour even while state.smoothness > 0.
  const pixelate = state.mode === 'dither' && !engine.lastBoxResolved;
  out.classList.toggle('pixelated', pixelate);
  if (resized) view.contentResized();
  // not during exports: out is at export resolution and the overlay is hidden
  // behind the busy screen anyway
  if (view.splitOn && !comparing && !exporting) drawSplitOverlay();
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
  if (!source) return;
  const [srcW, srcH] = srcDims();
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
  cctx.drawImage(source.el, 0, 0, srcW * frac, srcH, 0, 0, w * frac, h);
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
  if (!contentNew && !cpuResultReady) return;
  cpuResultReady = false;
  videoFrameReady = false;
  dirty = false;

  if (comparing) {
    presentOriginal();
  } else {
    const t0 = performance.now();
    renderOnce(null, contentNew);
    // Only track cost while producing new LIVE frames — not idle wake-ups,
    // and not export renders: recordCanvas exports run through this loop with
    // export cost profiles (sync CPU dither, ss=3) the governor must not
    // train on. derived() masks its output during exports anyway.
    if (contentNew && !exporting) {
      const rt = performance.now() - t0;
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

// snapshots capture the app state AND the active generative-scene params,
// so undo/redo can revert scene edits too
function snapshotStr() {
  return JSON.stringify({ s: state, g: source?.type === 'gen' ? source.gen.params : null });
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
  updateUndoButtons();
}

// debounced variant for slider drags; discrete actions call commitHistory()
function pushHistory() {
  clearTimeout(histTimer);
  histTimer = setTimeout(commitHistory, 350);
}

function restoreSnapshot(snap) {
  const parsed = JSON.parse(snap);
  resetState(state);
  applyParams(state, parsed.s || parsed);
  if (parsed.g && source?.type === 'gen') {
    Object.assign(source.gen.params, parsed.g);
    source.name = source.gen.sceneName().toLowerCase();
  }
  clearActivePreset($('preset-strip')); // the restored state may not match the highlighted card
  rebuildPanel();
  updateExportButtons();
  updateUndoButtons();
  updateStatus();
  dirty = true;
}

function undo() {
  commitHistory(); // land any pending debounced change first
  if (history.index > 0) {
    history.index--;
    restoreSnapshot(history.stack[history.index]);
    updateUndoButtons();
  }
}

function redo() {
  if (histTimer) commitHistory();
  if (history.index < history.stack.length - 1) {
    history.index++;
    restoreSnapshot(history.stack[history.index]);
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
  disposeSource(source);
  source = next;
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
  dirty = true;
  // record the auto-applied video profile as its own undo step, so the first
  // subsequent slider edit doesn't revert the whole profile in one undo
  if (profileApplied) commitHistory();
  setTimeout(renderPresetThumbs, 250);
  // a slow webcam can arrive with 0×0 dims and fill them in a moment later
  toast(source.width
    ? `${source.name || source.type} · ${source.width}×${source.height}`
    : `${source.name || source.type} — starting…`);
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

// ---------------------------------------------------------------------------
// exports
// ---------------------------------------------------------------------------
async function doExportPNG() {
  if (!source || exporting) return;
  exporting = true; // block source swaps / concurrent exports mid-encode
  const exportName = `${source.name || 'ditherlab'}-${state.mode}.png`;
  // deterministic bake: an animated still exports its reference frame, not
  // whatever instant the clock happened to be at when the button was clicked
  const pinPhase = source.type === 'image' && isAnimating() && phaseOverride === null;
  if (pinPhase) phaseOverride = 0;
  try {
    const [w, h] = srcDims();
    toast('Rendering…');
    await new Promise((r) => setTimeout(r, 30)); // let toast paint before a heavy CPU pass
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

async function doExportVideo() {
  if (!source || exporting) return;
  const isAnimatedImage = source.type === 'animated-image';
  const animatedStill = source.type === 'image' && isAnimating();
  const isGen = source.type === 'gen';
  if (!(source.el instanceof HTMLVideoElement) && !isAnimatedImage && !animatedStill && !isGen) return;
  exporting = true;
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
          renderFrame: () => { renderOnce(mp4RenderBudget()); return out; },
          setPhase: (f) => {
            if (isGen) genPhaseOverride = (f * genCycles) % 1;
            if (effCycles) phaseOverride = (f * effCycles) % 1;
          },
          count,
          fps,
          name,
          strict: strictFn,
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
        return;
      }
      toast('H.264 unavailable — using real-time recorder', 4000);
      // The failed frame-accurate attempt resized `out` for export. Restore the
      // stable live bitmap before captureStream() starts; resizing a captured
      // canvas mid-recording can glitch or truncate the first frames.
      renderOnce();
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
        renderFrame: () => { renderOnce(mp4RenderBudget()); return out; },
        name,
        strict: strictFn,
        // true source rate from playback (rVFC mediaTime deltas) — sampling
        // 24fps footage on a 30fps grid bakes 2:3 pulldown judder into the file
        sourceFps: source._frameDurEma ? 1 / source._frameDurEma : 0,
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
      return;
    }
    toast('H.264 unavailable — using real-time recorder', 4000);
    renderOnce();
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
}

async function doExportGIF() {
  if (!source || exporting) return;
  exporting = true;
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
  const postProcess = fxOn ? (pixels, gw, gh) => {
    if (!fxCanvas) {
      fxCanvas = document.createElement('canvas');
      fxCtx = fxCanvas.getContext('2d', { willReadFrequently: true });
    }
    if (fxCanvas.width !== gw || fxCanvas.height !== gh) {
      fxCanvas.width = gw;
      fxCanvas.height = gh;
    }
    fxCtx.putImageData(new ImageData(pixels, gw, gh), 0, 0);
    // present() would show this render at out.height * scale with refH=srcH;
    // scale refH by our (smaller) canvas so the fx read proportionally alike
    const scale = state.mode === 'dither'
      ? Math.min(2, Math.max(1, srcDims()[0] / out.width))
      : 1;
    const refH = (srcDims()[1] || gh) * (gh / (out.height * scale));
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
      renderFrame: () => { renderOnce(EXPORT_PIXELS, true, fxOn); return out; },
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
    toast('ANSI text exported — try: cat file.ans');
  } else if (fmt === 'html' && engine.ascii.lastGrid) {
    const f = FONTS[state.ascii.fontId] || FONTS.menlo;
    exportText(buildHtml(engine.ascii.lastGrid, state.ascii.bg, {
      family: f.family,
      size: state.ascii.cellSize,
      bold: state.ascii.bold,
    }), name, 'html');
    toast('HTML exported');
  } else {
    exportText(engine.ascii.lastText, name);
    toast('ASCII text exported');
  }
  dirty = true; // restore the live preview resolution
}

exportSettings.onCopyText = () => {
  if (state.mode !== 'ascii') return;
  renderOnce(Infinity, true, false, true);
  dirty = true;
  navigator.clipboard.writeText(engine.ascii.lastText)
    .then(() => toast('Copied to clipboard'))
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
      clearActivePreset($('preset-strip'));
      if (source?.type === 'gen') source.name = source.gen.sceneName().toLowerCase();
      updateStatus();
      pushHistory();
      dirty = true;
    },
    onChange: () => {
      if (exporting) return;
      clearActivePreset($('preset-strip'));
      updateExportButtons();
      updateStatus();
      pushHistory();
      dirty = true;
    },
  });
}

function applyPreset(preset) {
  if (exporting) return;
  commitHistory(); // land any pending debounced edit first
  resetState(state);
  applyParams(state, preset.params);
  rebuildPanel();
  updateExportButtons();
  updateStatus();
  commitHistory();
  dirty = true;
  toast(preset.name);
}

thumbCanvases = buildPresetStrip({
  mount: $('preset-strip'),
  presets: PRESETS,
  onApply: applyPreset,
  onShuffle: () => {
    if (exporting) return;
    commitHistory();
    clearActivePreset($('preset-strip'));
    resetState(state);
    applyParams(state, shuffleParams());
    rebuildPanel();
    updateExportButtons();
    updateStatus();
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
  if (exporting) return;
  commitHistory();
  clearActivePreset($('preset-strip'));
  resetState(state);
  Object.assign(exportSettings, EXPORT_DEFAULTS);
  rebuildPanel();
  updateExportButtons();
  updateStatus();
  commitHistory();
  dirty = true;
  toast('Reset');
};

$('btn-shuffle').onclick = () => {
  if (exporting) return;
  commitHistory();
  clearActivePreset($('preset-strip'));
  resetState(state);
  applyParams(state, shuffleParams());
  rebuildPanel();
  updateExportButtons();
  updateStatus();
  commitHistory(); // discrete action: its own undo step, never merged with the next edit
  dirty = true;
  toast('Shuffled');
};

// hold-to-compare
const startCompare = (e) => { if (exporting) return; e.preventDefault(); comparing = true; dirty = true; };
const endCompare = () => { if (comparing) { comparing = false; dirty = true; } };
$('btn-compare').addEventListener('mousedown', startCompare);
$('btn-compare').addEventListener('touchstart', startCompare, { passive: false });
window.addEventListener('mouseup', endCompare);
window.addEventListener('touchend', endCompare);
window.addEventListener('blur', endCompare); // keyup can be lost on window switch
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') endCompare();
});

window.addEventListener('keydown', (e) => {
  if (exporting) return;
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
window.addEventListener('keyup', (e) => { if (e.key === 'c') endCompare(); });

$('btn-export-png').onclick = doExportPNG;
$('btn-export-video').onclick = doExportVideo;
$('btn-export-gif').onclick = doExportGIF;
$('btn-export-txt').onclick = doExportTxt;

// video bar
function togglePlay() {
  if (exporting) return;
  const el = source.el;
  if (el.paused) { el.play(); $('btn-play').textContent = '❚❚'; }
  else { el.pause(); $('btn-play').textContent = '▶'; }
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
    updateVideoTime(el);
    dirty = true;
  }
});
$('speed').addEventListener('change', () => {
  if (exporting) return;
  if (source?.el instanceof HTMLVideoElement) source.el.playbackRate = parseFloat($('speed').value);
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
  engine,
  state,
};
