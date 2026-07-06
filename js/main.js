// App bootstrap: state, render loop, viewport, history, source management,
// exports, preset thumbnails, UI wiring.

import { Engine, getAlgorithm } from './engine/engine.js';
import { createState, applyParams, resetState, DEFAULTS } from './state.js';
import { getPalette } from './palettes.js';
import { RAMPS, FONTS } from './engine/ascii.js';
import { applyPostFX } from './effects/postfx.js';
import { PRESETS, shuffleParams } from './presets.js';
import { loadFile, openWebcam, demoImage, bindDropAndPaste } from './sources.js';
import { exportText, buildAnsi, buildHtml, VideoExporter, exportGIF, downloadBlob } from './export/exporters.js';
import { buildPanel, buildPresetStrip, clearActivePreset, toast } from './ui.js';
import { Viewport } from './view.js';
import { GenerativeSource } from './generate.js';

const MAX_LIVE_PIXELS = 420_000;   // CPU error-diffusion budget for video preview
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
const exportSettings = { pngSize: 'source', gifSize: '480', recordSeconds: '5', txtFormat: 'plain' };

let source = null;
let dirty = true;
let comparing = false;
let exporting = false;
let scrubbing = false;
let fpsEma = 0;
let lastFrameT = 0;
let fpsText = '';

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
const derived = () => ({ ...deriveParams(state), animPhase: phaseOverride ?? animPhase });

function srcDims() {
  if (!source) return [0, 0];
  const el = source.el;
  if (el instanceof HTMLVideoElement) return [el.videoWidth || source.width, el.videoHeight || source.height];
  return [source.width, source.height];
}

// ---------------------------------------------------------------------------
// render + present
// ---------------------------------------------------------------------------
function renderOnce(budgetOverride = null) {
  const [w, h] = srcDims();
  if (!w || !h) return out;
  if (source.type === 'gen') source.gen.tick(genPhaseOverride ?? source.gen.phase);
  const p = derived();
  // live sources AND animated stills render every frame -> cap the CPU budget
  const capped = source.type !== 'image' || isAnimating();
  const result = engine.render(source.el, w, h, p, budgetOverride ?? (capped ? MAX_LIVE_PIXELS : Infinity));
  if (result) present(result, w, h);
  return out;
}

function present(result, srcW) {
  const fxOn = Object.values(state.fx).some((v) => v > 0);
  let final = result;
  if (fxOn) {
    if (state.mode === 'dither') {
      // upscale first so scanlines/grain/vignette are crisp over the pixels
      const scale = Math.min(2, Math.max(1, srcW / result.width));
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
    final = applyPostFX(final, state.fx, { grainPhase: currentGrainPhase(), refH: srcDims()[1] || final.height });
  }
  let resized = false;
  if (out.width !== final.width || out.height !== final.height) {
    out.width = final.width;
    out.height = final.height;
    resized = true;
  }
  octx.drawImage(final, 0, 0);
  const pixelate = state.mode === 'dither'; // chunky pixels stay crisp even with FX
  out.classList.toggle('pixelated', pixelate);
  if (resized) view.contentResized();
  // not during exports: out is at export resolution and the overlay is hidden
  // behind the busy screen anyway
  if (view.splitOn && !comparing && !exporting) drawSplitOverlay();
}

function presentOriginal() {
  const [w, h] = srcDims();
  if (!w || !h) return;
  let resized = false;
  if (out.width !== w || out.height !== h) {
    out.width = w;
    out.height = h;
    resized = true;
  }
  octx.drawImage(source.el, 0, 0, w, h);
  out.classList.remove('pixelated');
  if (resized) view.contentResized();
  if (view.splitOn) cctx.clearRect(0, 0, cmp.width, cmp.height);
}

// Draw the untouched source over the left part of the frame (split view).
function drawSplitOverlay() {
  if (!source) return;
  const [w, h] = srcDims();
  if (!w || !h) return;
  // full source resolution, CSS-scaled onto the output's layout box so the
  // "before" pane stays sharp at any zoom
  if (cmp.width !== w || cmp.height !== h) {
    cmp.width = w;
    cmp.height = h;
  }
  cmp.style.width = `${out.width}px`;
  cmp.style.height = `${out.height}px`;
  cctx.clearRect(0, 0, w, h);
  const frac = view.splitFrac;
  if (frac <= 0) return;
  cctx.drawImage(source.el, 0, 0, w * frac, h, 0, 0, w * frac, h);
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
  const isLive = source.type !== 'image';
  const playing = isLive && genPhaseOverride === null // gen bake renders itself
    && (source.el instanceof HTMLVideoElement
      ? (!source.el.paused && !source.el.ended)
      : true); // webcam-less live sources (generated scenes) always play
  if (!dirty && !playing && !animating) return;
  dirty = false;

  if (comparing) presentOriginal();
  else renderOnce();

  if (playing || animating) {
    if (lastFrameT) {
      const fdt = t - lastFrameT;
      fpsEma = fpsEma ? fpsEma * 0.9 + fdt * 0.1 : fdt;
      fpsText = `${Math.round(1000 / fpsEma)} fps`;
      updateStatus();
    }
    lastFrameT = t;
    if (playing && !scrubbing && source.type === 'video') {
      const el = source.el;
      $('seek').value = isFinite(el.duration) && el.duration ? Math.round((el.currentTime / el.duration) * 1000) : 0;
      $('time').textContent = `${fmtTime(el.currentTime)} / ${fmtTime(el.duration)}`;
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

function updateStatus() {
  if (source) {
    const [w, h] = srcDims();
    const modeName = state.mode[0].toUpperCase() + state.mode.slice(1);
    $('st-left').textContent = `${source.name || source.type} · ${w}×${h} · ${modeName}`;
  }
  const z = `${Math.round(view.zoom * 100)}%`;
  $('st-right').textContent = fpsText ? `${fpsText} · ${z}` : z;
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
  if (!source || !w || !h) return;
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
      const result = thumbEngine.render(snap, TW, TH, deriveParams(base), Infinity);
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
function setSource(next) {
  if (exporting) {
    // don't yank the source out from under a running export
    if (next.stream) next.stream.getTracks().forEach((tr) => tr.stop());
    if (next.url) URL.revokeObjectURL(next.url);
    toast('Export in progress — cancel it first');
    return;
  }
  if (source) {
    if (source.stream) source.stream.getTracks().forEach((tr) => tr.stop());
    if (source.el instanceof HTMLVideoElement && !source.stream) source.el.pause();
    if (source._seekHandler) source.el.removeEventListener('seeked', source._seekHandler);
    if (source.url) URL.revokeObjectURL(source.url);
  }
  source = next;
  fpsEma = 0;
  if (source.type === 'video') {
    source.el.playbackRate = parseFloat($('speed').value) || 1;
    $('btn-play').textContent = '❚❚';
    // re-render when the user seeks a paused video (exporters render themselves)
    source._seekHandler = () => { if (!exporting) dirty = true; };
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
  setTimeout(renderPresetThumbs, 250);
  // a slow webcam can arrive with 0×0 dims and fill them in a moment later
  toast(source.width
    ? `${source.name || source.type} · ${source.width}×${source.height}`
    : `${source.name || source.type} — starting…`);
}

async function openFile(file) {
  try {
    setSource(await loadFile(file));
  } catch (err) {
    toast(err.message);
  }
}

function updateExportButtons() {
  const isVideo = source?.type === 'video';
  const isWebcam = source?.type === 'webcam';
  const isGen = source?.type === 'gen';
  const animatedStill = source?.type === 'image' && isAnimating();
  $('btn-export-video').hidden = !canRecord || !(isVideo || isWebcam || animatedStill || isGen);
  // a static image would make a pointless single-frame "animated" GIF
  $('btn-export-gif').hidden = !(isVideo || isGen || animatedStill);
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
  let outC;
  let W = 0;
  let H = 0; // hoisted: the toBlob callback below outlives the try block
  // deterministic bake: an animated still exports its reference frame, not
  // whatever instant the clock happened to be at when the button was clicked
  const pinPhase = source.type === 'image' && isAnimating() && phaseOverride === null;
  if (pinPhase) phaseOverride = 0;
  try {
    const [w, h] = srcDims();
    toast('Rendering…');
    await new Promise((r) => setTimeout(r, 30)); // let toast paint before a heavy CPU pass
    const p = derived();
    const result = engine.render(source.el, w, h, p, Infinity);
    if (!result) return;

    W = result.width;
    H = result.height;
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
    cx.imageSmoothingEnabled = false;
    cx.drawImage(result, 0, 0, W, H);
    const final = applyPostFX(c, state.fx, { grainPhase: currentGrainPhase() ?? 0, refH: h });

    // applyPostFX may return a shared canvas — copy before async toBlob
    outC = final === c ? c : (() => {
      const cc = document.createElement('canvas');
      cc.width = final.width;
      cc.height = final.height;
      cc.getContext('2d').drawImage(final, 0, 0);
      return cc;
    })();
  } finally {
    if (pinPhase) phaseOverride = null;
    exporting = false;
  }
  if (!outC) return;

  outC.toBlob((blob) => {
    if (!blob) {
      toast('PNG export failed — image too large for this browser');
      dirty = true;
      return;
    }
    downloadBlob(blob, `${source.name || 'ditherlab'}-${state.mode}.png`);
    toast(`PNG exported · ${W}×${H}`);
    dirty = true;
  }, 'image/png');
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

async function doExportVideo() {
  if (!source || exporting) return;
  const animatedStill = source.type === 'image' && isAnimating();
  const isGen = source.type === 'gen';
  if (!(source.el instanceof HTMLVideoElement) && !animatedStill && !isGen) return;
  exporting = true;

  let secs = parseInt(exportSettings.recordSeconds, 10) || 5;
  if (source.type === 'webcam') {
    recordCanvasSeconds(secs, 'ditherlab-webcam');
    return;
  }
  // stretch to a whole number of animation cycles so the saved clip loops
  const cps = isGen
    ? source.gen.params.speed * GEN_CYCLES_PER_SEC
    : (isAnimating() ? state.anim.speed * 0.15 : 0);
  if (cps > 0) secs = Math.max(1, Math.round(secs * cps)) / cps;
  if (isGen) {
    recordCanvasSeconds(secs, `${source.name || 'scene'}-${state.mode}`);
    return;
  }
  if (animatedStill) {
    recordCanvasSeconds(secs, `${source.name || 'ditherlab'}-${state.mode}-${state.anim.style}`);
    return;
  }

  const exporter = new VideoExporter(out, source.el, {
    fps: 30,
    onProgress: busyProgress,
  });
  // cancel() aborts start(), which throws 'cancelled' and restores the video
  showBusy('Exporting video (plays through once)…', () => exporter.cancel());
  try {
    await exporter.start(`${source.name || 'ditherlab'}-${state.mode}`);
    toast('Video exported');
  } catch (err) {
    toast(err.message === 'cancelled' ? 'Export cancelled' : `Video export failed: ${err.message}`);
  }
  hideBusy();
  exporting = false;
}

async function doExportGIF() {
  if (!source || exporting) return;
  exporting = true;
  // 'native' = exactly the rendered frame, no resampling
  const maxWidth = exportSettings.gifSize === 'native' ? Infinity : parseInt(exportSettings.gifSize, 10);
  let cancelled = false;
  showBusy('Encoding GIF…', () => { cancelled = true; });

  // Animated stills bake exactly one animation cycle -> seamless loop.
  let fps = 12;
  let animate = null;
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

  try {
    await exportGIF({
      video: source.type === 'video' ? source.el : null,
      animate,
      renderFrame: () => { renderOnce(EXPORT_PIXELS); return out; },
      fps,
      maxWidth,
      // dither wants exact pixels; ASCII/cells strokes need area-averaging
      smooth: state.mode !== 'dither',
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
  dirty = true; // restore the live preview resolution
  hideBusy();
  exporting = false;
}

function doExportTxt() {
  if (state.mode !== 'ascii') return;
  renderOnce(Infinity); // text exports always use the full-resolution grid
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
  renderOnce(Infinity);
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
    gen: source?.type === 'gen' ? source.gen : null,
    onGenChange: () => {
      if (source?.type === 'gen') source.name = source.gen.sceneName().toLowerCase();
      updateStatus();
      pushHistory();
      dirty = true;
    },
    onChange: () => {
      if (exporting) return;
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

$('btn-demo').onclick = () => setSource(demoImage());

$('btn-generate').onclick = () => {
  if (exporting) return;
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
  try {
    setSource(await openWebcam());
  } catch (err) {
    toast(`Webcam unavailable: ${err.message}`);
  }
};

$('btn-reset').onclick = () => {
  if (exporting) return;
  commitHistory();
  clearActivePreset($('preset-strip'));
  resetState(state);
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
}
$('btn-play').onclick = () => source?.type === 'video' && togglePlay();
$('seek').addEventListener('pointerdown', () => { scrubbing = true; });
$('seek').addEventListener('pointerup', () => { scrubbing = false; });
$('seek').addEventListener('input', () => {
  if (source?.type !== 'video' || exporting) return;
  const el = source.el;
  if (isFinite(el.duration) && el.duration) {
    el.currentTime = (parseInt($('seek').value, 10) / 1000) * el.duration;
    dirty = true;
  }
});
$('speed').addEventListener('change', () => {
  if (exporting) return;
  if (source?.el instanceof HTMLVideoElement) source.el.playbackRate = parseFloat($('speed').value);
});

// drag & drop + paste
bindDropAndPaste($('viewport'), openFile);

// boot with the demo scene
setSource(demoImage());

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
  state,
};
