// Export: PNG stills, WebM/MP4 video via MediaRecorder, animated GIF, ASCII text.

import { GifEncoder } from './gif.js';
import { Mp4Muxer } from './mp4.js';

const MAX_MP4_SAMPLE_BYTES = 256 * 1024 * 1024;
const SEEK_TIMEOUT_MS = 4000;
export const GIF_RETAINED_PIXEL_BUDGET = 60_000_000;

export function gifFrameBudget(width, height) {
  const pixels = Math.max(1, width * height);
  return Math.max(1, Math.floor(GIF_RETAINED_PIXEL_BUDGET / pixels));
}

function unsupportedH264(message = 'H.264 encoding is not supported on this device') {
  const error = new Error(message);
  error.name = 'NotSupportedError';
  return error;
}

function seekMedia(video, time, { timeoutMs = SEEK_TIMEOUT_MS, tolerance = 0.05 } = {}) {
  const target = Math.max(0, time);
  if (!video.seeking && Math.abs(video.currentTime - target) < 1e-4 && video.readyState >= 2) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let timer = null;
    let poll = null;
    let armed = false;
    const cleanup = () => {
      clearTimeout(timer);
      clearInterval(poll);
      video.removeEventListener('seeked', check);
      video.removeEventListener('loadeddata', check);
      video.removeEventListener('timeupdate', check);
      video.removeEventListener('error', failed);
    };
    const check = () => {
      if (armed && video.readyState >= 2 && !video.seeking
          && Math.abs(video.currentTime - target) <= tolerance) {
        cleanup();
        resolve();
      }
    };
    const failed = () => { cleanup(); reject(new Error('Video decoder failed while seeking')); };
    video.addEventListener('seeked', check);
    video.addEventListener('loadeddata', check);
    video.addEventListener('timeupdate', check);
    video.addEventListener('error', failed);
    timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Video seek timed out at ${target.toFixed(3)}s`));
    }, timeoutMs);
    try {
      video.currentTime = target;
    } catch (error) {
      cleanup();
      reject(error);
      return;
    }
    // Browsers may coalesce a sub-frame seek onto the already-decoded frame and
    // omit `seeked`. Poll the same correctness conditions after one task turn;
    // do not treat setting currentTime alone as proof that decoding landed.
    setTimeout(() => { armed = true; check(); }, 0);
    poll = setInterval(check, 25);
  });
}

// Frame-accurate H.264/MP4 export via WebCodecs. Unlike the real-time
// MediaRecorder path, this steps the source frame by frame and renders each
// one with no time pressure, so a slow dither can't judder the output — the
// clip is limited by quality, not by how fast the device renders. Video only
// (no audio). Returns false if WebCodecs is unavailable so the caller can
// fall back to the real-time recorder.
export function canFrameExport() {
  return typeof VideoEncoder !== 'undefined' && typeof VideoFrame !== 'undefined';
}

// Shared H.264 pipeline for the frame-accurate exporters (seek-driven video
// and phase-driven loop bakes).
//
// Encode size: NEVER fractionally resample (that shreds the pattern), and
// integer-UPSCALE so each 1px dither cell becomes a >=2x2 block. A 1px
// dither is pure highest-frequency energy — the worst case for H.264's DCT,
// which discards exactly that. Turning cells into 2x2 blocks shifts the
// energy into lower frequencies that survive quantization, so the pattern
// stays crisp instead of blocking/ringing (nearest-neighbor upscale).
async function makeH264Encoder(first, fps, strict) {
  const long = Math.max(first.width, first.height);
  // Use the quality-preserving >=2x enlargement whenever the source grid fits.
  // Very wide ASCII/cell renders use 1x rather than exceeding H.264 level 5.1.
  let scale = long > 1920 ? 1 : Math.max(2, Math.round(1440 / long));
  while (long * scale > 3840 && scale > 1) scale--;
  if (long * scale > 3840) throw unsupportedH264('Video frame is wider than the 3840px H.264 limit');
  const w = Math.max(2, (first.width * scale) & ~1);
  const h = Math.max(2, (first.height * scale) & ~1);

  const frame = document.createElement('canvas');
  frame.width = w; frame.height = h;
  const fctx = frame.getContext('2d');
  // Crisp 1-bit wants nearest-neighbour (sharp dots); a smoothed (tone) export
  // is continuous, so let it upscale smoothly.
  fctx.imageSmoothingEnabled = !strict;
  fctx.imageSmoothingQuality = 'high';

  // Prefer constant-QUALITY (quantizer/QP) encoding — for a hard-edged dither
  // that tracks the canvas far better than a target bitrate — with High
  // profile (CABAC). Fall back to a generous VBR bitrate where QP is
  // unsupported. avc1.640033 = High @ Level 5.1 (covers up to ~4K).
  const codecs = ['avc1.640033', 'avc1.4d0033', 'avc1.420033']; // High, Main, Baseline @ L5.1
  // Hard 1-bit is adversarial for H.264 (high-freq edges -> ringing/mosquito),
  // so strict output needs a lower QP / fatter bitrate than smoothed (tone)
  // output, which compresses cleanly. Tuned ranges: ~10-12 strict, ~14-16 smooth.
  const bpp = strict ? 0.5 : 0.25;
  const cap = strict ? 80e6 : 48e6;
  let config = null;
  let quantizer = null;
  for (const codec of codecs) {
    const base = {
      codec, width: w, height: h, framerate: fps,
      latencyMode: 'quality', contentHint: 'text', avc: { format: 'avc' },
    };
    if (typeof VideoEncoder.isConfigSupported !== 'function') {
      config = { ...base, bitrateMode: 'variable', bitrate: Math.min(cap, Math.max(8e6, Math.round(w * h * fps * bpp))) };
      break;
    }
    try {
      const qp = { ...base, bitrateMode: 'quantizer' };
      if ((await VideoEncoder.isConfigSupported(qp)).supported) {
        config = qp;
        quantizer = strict ? 12 : 16; // lower = higher quality
        break;
      }
      const vbr = { ...base, bitrateMode: 'variable', bitrate: Math.min(cap, Math.max(8e6, Math.round(w * h * fps * bpp))) };
      if ((await VideoEncoder.isConfigSupported(vbr)).supported) {
        config = vbr;
        break;
      }
    } catch { /* try the next profile */ }
  }
  if (!config) throw unsupportedH264();

  const muxer = new Mp4Muxer(w, h, fps, { maxBytes: MAX_MP4_SAMPLE_BYTES });
  let encErr = null;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => { try { muxer.addChunk(chunk, meta); } catch (error) { encErr = error; } },
    error: (e) => { encErr = e; },
  });
  try {
    encoder.configure(config);
  } catch (error) {
    try { encoder.close(); } catch { /* configure may already close it */ }
    throw unsupportedH264(error.message);
  }

  const keyEvery = Math.max(1, Math.round(fps * 2)); // ~2s GOP at any rate
  return {
    w,
    h,
    err: () => encErr,
    limitReached: () => muxer.limitReached,
    // Draw + encode one frame; awaits encoder backpressure (keeps UI alive).
    async add(processed, i) {
      fctx.drawImage(processed, 0, 0, processed.width, processed.height, 0, 0, w, h);
      const vf = new VideoFrame(frame, { timestamp: Math.round((i * 1e6) / fps), duration: Math.round(1e6 / fps) });
      const opts = { keyFrame: i % keyEvery === 0 };
      if (quantizer !== null) opts.avc = { quantizer };
      encoder.encode(vf, opts);
      vf.close();
      while (encoder.encodeQueueSize > 8) await new Promise((r) => setTimeout(r, 4));
      return !muxer.limitReached;
    },
    async finish() {
      await encoder.flush();
      if (encErr) throw encErr;
      encoder.close();
      const blob = muxer.finalize();
      muxer.release();
      return blob;
    },
    close() {
      if (encoder.state !== 'closed') { try { encoder.close(); } catch { /* already closing */ } }
    },
  };
}

// Snap a measured frame rate to the standard it almost certainly is; keeps
// the seek grid aligned with real frames (23.976 sampled at 24 would double
// one frame every ~41s) and gives the muxer exact NTSC deltas (90000/29.97
// -> 3003). Unrecognized rates are used as measured, clamped to sanity.
const COMMON_FPS = [23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60];
function snapFps(measured) {
  if (!(measured > 0)) return 30;
  const fps = Math.min(60, Math.max(10, measured));
  // nearest within 2% — NOT first match: the NTSC/integer pairs (23.976/24,
  // 29.97/30, 59.94/60) are only 0.1% apart, both inside any sane tolerance
  let best = fps;
  let bd = 0.02;
  for (const c of COMMON_FPS) {
    const d = Math.abs(fps - c) / c;
    if (d < bd) { bd = d; best = c; }
  }
  return best;
}

export async function exportVideoFrameAccurate({
  video, renderFrame, name = 'dithered', strict = true, sourceFps = 0,
  onFrameTime = null, onProgress = () => {}, onInfo = null, shouldAbort = null,
}) {
  const originalTime = video.currentTime;
  const wasLooping = video.loop;
  const wasPaused = video.paused;
  // resolve the duration (MediaRecorder-made clips report Infinity until
  // forced to demux to the end)
  if (!isFinite(video.duration)) {
    video.currentTime = 1e9;
    await new Promise((res) => {
      const done = () => { video.removeEventListener('durationchange', done); res(); };
      video.addEventListener('durationchange', done);
      setTimeout(done, 4000);
    });
  }
  const duration = video.duration;
  if (!isFinite(duration) || duration <= 0) {
    await seekMedia(video, originalTime, { timeoutMs: 2000 }).catch(() => {});
    if (!wasPaused) video.play().catch(() => {});
    else video.pause();
    throw new Error('video duration unknown');
  }
  // sourceFps = the app's passive estimate from rVFC mediaTime deltas during
  // normal playback; sampling a 24fps clip on a 30fps grid would bake 2:3
  // pulldown judder into every export of film-rate footage.
  const fps = snapFps(sourceFps);
  if (Math.round(fps) !== 30) onInfo?.(`Exporting at ${Math.round(fps * 100) / 100} fps (source rate)`);
  // hold all compressed samples until finalize -> bound memory (and export
  // time) by capping the frame count; realistic clips are far under this
  const MAX_FRAMES = Math.round(fps * 200); // ~3.3 min at any rate
  let frameCount = Math.max(1, Math.round(duration * fps));
  if (frameCount > MAX_FRAMES) {
    frameCount = MAX_FRAMES;
    onInfo?.(`Long clip: exporting the first ${Math.round(MAX_FRAMES / fps)}s`);
  }

  video.loop = false;
  video.pause();

  let enc = null;
  try {
    // Seek to frame 0 BEFORE the sizing render: it must reflect the exported
    // clip's own first frame (strict/lastBoxResolved read after it), and it
    // must not re-prime the freshly invalidated temporal history with the
    // arbitrary pre-export playback position.
    await seekMedia(video, 0);
    onFrameTime?.(0);
    const first = renderFrame();
    // strict may be a thunk evaluated after the sizing render, so the caller
    // can read the engine's ACTUAL crisp-vs-tone state for this export
    // (raw state.smoothness lies for CPU algorithms and lost WebGL).
    const strictVal = typeof strict === 'function' ? !!strict() : strict;
    enc = await makeH264Encoder(first, fps, strictVal);

    await enc.add(first, 0); // frame 0 is already rendered — encode it as-is
    onProgress(1 / frameCount);
    for (let i = 1; i < frameCount; i++) {
      if (shouldAbort && shouldAbort()) throw new Error('cancelled');
      if (enc.err()) throw enc.err();
      await seekMedia(video, Math.min(duration - 1e-3, i / fps));
      onFrameTime?.(i / fps);
      if (!(await enc.add(renderFrame(), i))) {
        onInfo?.('Video capped when compressed frames reached 256 MB (memory safety)');
        break;
      }
      onProgress((i + 1) / frameCount);
    }
    downloadBlob(await enc.finish(), `${name}.mp4`);
  } finally {
    enc?.close();
    video.loop = wasLooping;
    const restoreTime = isFinite(video.duration)
      ? Math.min(Math.max(0, originalTime), Math.max(0, video.duration - 1e-3))
      : originalTime;
    await seekMedia(video, restoreTime, { timeoutMs: 2000 }).catch(() => {});
    if (!wasPaused) video.play().catch(() => {});
    else video.pause();
  }
}

// Frame-accurate MP4 for deterministic sources (generative scenes, animated
// stills): steps a phase clock over exactly the requested cycle span instead
// of seeking a video, so the bake is perfectly paced and loops seamlessly no
// matter how slowly the device renders — same encoder/quality as the video
// path, unlike the realtime MediaRecorder capture it replaces.
export async function exportLoopFrameAccurate({
  renderFrame, setPhase, count, fps, name = 'dithered', strict = true,
  onProgress = () => {}, onInfo = null, shouldAbort = null,
}) {
  setPhase(0);
  const first = renderFrame();
  const strictVal = typeof strict === 'function' ? !!strict() : strict;
  const enc = await makeH264Encoder(first, fps, strictVal);
  try {
    await enc.add(first, 0);
    onProgress(1 / count);
    for (let i = 1; i < count; i++) {
      if (shouldAbort && shouldAbort()) throw new Error('cancelled');
      if (enc.err()) throw enc.err();
      setPhase(i / count);
      if (!(await enc.add(renderFrame(), i))) {
        onInfo?.('Video capped when compressed frames reached 256 MB (memory safety)');
        break;
      }
      onProgress((i + 1) / count);
      // let the busy overlay paint / cancel clicks land between heavy renders
      if (i % 4 === 0) await new Promise((r) => setTimeout(r, 0));
    }
    downloadBlob(await enc.finish(), `${name}.mp4`);
  } finally {
    enc.close();
  }
}

export function downloadBlob(blob, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  const revokeTimer = setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  revokeTimer?.unref?.(); // keep Node-side regression tests from waiting 10s
}

export function exportText(text, name = 'ascii', ext = 'txt') {
  downloadBlob(new Blob([text], { type: 'text/plain' }), `${name}.${ext}`);
}

// ---------------------------------------------------------------------------
// Colored-text builders from the ASCII renderer's lastGrid
// (rows of [char, fgRGB|null, bgRGB|null]).
// ---------------------------------------------------------------------------

// ANSI truecolor: SGR 38;2 / 48;2 with run-length elision and a per-line
// reset (terminals with background-color-erase flood the line otherwise).
export function buildAnsi(grid, { defaultBg = null, quantize = true } = {}) {
  // 5-bit color quantization collapses near-identical cells into runs,
  // shrinking .ans files of continuous-tone content dramatically
  const q = (v) => (quantize && v != null && v >= 0 ? v & 0xf8f8f8 : v);
  const defBg = defaultBg != null ? (defaultBg & 0xffffff) : null;
  const out = [];
  for (const row of grid) {
    let curFg = -1;
    let curBg = -2;
    let line = '';
    // terminals with a different default background would render mono art
    // invisibly; pin the intended background when the grid has none
    if (defBg != null) {
      line += `\x1b[48;2;${(defBg >> 16) & 255};${(defBg >> 8) & 255};${defBg & 255}m`;
      curBg = -3; // sentinel: pinned default, distinct from null cells
    }
    for (const [ch, fg, bg] of row) {
      const f = q(fg ?? -1);
      const b = defBg != null && bg == null ? -3 : q(bg ?? -1);
      if (f !== curFg) {
        line += f < 0 ? '\x1b[39m' : `\x1b[38;2;${(f >> 16) & 255};${(f >> 8) & 255};${f & 255}m`;
        curFg = f;
      }
      if (b !== curBg) {
        if (b === -3) {
          line += `\x1b[48;2;${(defBg >> 16) & 255};${(defBg >> 8) & 255};${defBg & 255}m`;
        } else {
          line += b < 0 ? '\x1b[49m' : `\x1b[48;2;${(b >> 16) & 255};${(b >> 8) & 255};${b & 255}m`;
        }
        curBg = b;
      }
      line += ch;
    }
    out.push(line + '\x1b[0m');
  }
  return out.join('\n') + '\n';
}

// Self-contained HTML with per-run color spans.
export function buildHtml(grid, pageBg = '#0a0a0c', font = null) {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const css = (v) => `#${((v & 0xf8f8f8) >>> 0).toString(16).padStart(6, '0')}`;
  const rows = grid.map((row) => {
    let html = '';
    let run = '';
    let curFg = null;
    let curBg = null;
    const flush = () => {
      if (!run) return;
      const style = [
        curFg !== null ? `color:${css(curFg)}` : '',
        curBg !== null ? `background:${css(curBg)}` : '',
      ].filter(Boolean).join(';');
      html += style ? `<span style="${style}">${esc(run)}</span>` : esc(run);
      run = '';
    };
    for (const [ch, fg, bg] of row) {
      const f = fg ?? null;
      const b = bg ?? null;
      if (f !== curFg || b !== curBg) {
        flush();
        curFg = f;
        curBg = b;
      }
      run += ch;
    }
    flush();
    return html;
  });
  const fontCss = font
    ? `${font.bold ? '700 ' : ''}${font.size || 12}px/1 ${(font.family || 'Menlo, monospace').replace(/"/g, "'")}`
    : '12px/1 Menlo, monospace';
  return `<!doctype html><meta charset="utf-8"><title>ascii art</title>` +
    `<body style="background:${pageBg};margin:20px 0">` +
    `<pre style="font:${fontCss};text-align:center">${rows.join('\n')}</pre>`;
}

// ---------------------------------------------------------------------------
// Video export: records the live preview canvas via captureStream while the
// source video plays through once. Audio is carried over when possible.
// ---------------------------------------------------------------------------
// createMediaElementSource may only ever be called once per element
const audioTaps = new WeakMap();

export class VideoExporter {
  constructor(canvas, sourceVideo, { fps = 30, onProgress, onDone, renderFrame = null } = {}) {
    this.canvas = canvas;
    this.video = sourceVideo;
    this.fps = fps;
    this.onProgress = onProgress || (() => {});
    this.onDone = onDone || (() => {});
    this.renderFrame = renderFrame;
    this.recorder = null;
    this._tick = null;
    this._abort = null;
    this._cancelled = false;
  }

  static pickMime() {
    const candidates = [
      'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
      'video/mp4',
      'video/webm;codecs=vp9,opus',
      'video/webm;codecs=vp8,opus',
      'video/webm',
    ];
    return candidates.find((m) => window.MediaRecorder && MediaRecorder.isTypeSupported(m)) || '';
  }

  // Await an event, but also settle on cancel() or after a safety timeout
  // (currentTime = 0 on an already-rewound video may never fire 'seeked').
  #waitFor(target, event, timeoutMs) {
    return new Promise((resolve) => {
      let timer = null;
      const settle = () => {
        target.removeEventListener(event, settle);
        clearTimeout(timer);
        this._abort = null;
        resolve();
      };
      target.addEventListener(event, settle);
      this._abort = settle;
      if (timeoutMs) timer = setTimeout(settle, timeoutMs);
    });
  }

  async start(name = 'dithered') {
    const mime = VideoExporter.pickMime();
    if (!mime) throw new Error('MediaRecorder is not supported in this browser');

    const video = this.video;
    const wasLooping = video.loop;
    const wasPaused = video.paused;
    const originalTime = video.currentTime;
    const originalMuted = video.muted;
    const originalRate = video.playbackRate;
    const stream = this.canvas.captureStream(this.fps);
    this._cancelled = false;

    const chunks = [];
    this.recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 12_000_000 });
    this.recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    const stopped = new Promise((resolve) => { this.recorder.onstop = resolve; });

    try {
      // Audio passthrough WITHOUT playing aloud: route the element's audio
      // through a WebAudio graph into a MediaStreamDestination (never to the
      // speakers), and add that track BEFORE the recorder starts so no engine
      // drops it. createMediaElementSource is once-per-element -> cache it.
      try {
        const cached = audioTaps.get(video) || (() => {
          const ctx = new (window.AudioContext || window.webkitAudioContext)();
          const src = ctx.createMediaElementSource(video); // detaches from speakers
          const tap = { ctx, src };
          audioTaps.set(video, tap);
          return tap;
        })();
        cached.ctx.resume?.();
        const dest = cached.ctx.createMediaStreamDestination();
        cached.src.connect(dest);
        this._audioTap = { cached, dest };
        video.muted = false; // muted would silence the graph input too
        const track = dest.stream.getAudioTracks()[0];
        if (track) stream.addTrack(track);
      } catch { /* silent video is fine */ }

      // Play the clip through exactly once from the start.
      video.loop = false;
      video.pause();
      if (video.currentTime > 0.01) {
        video.currentTime = 0;
        await this.#waitFor(video, 'seeked', 4000);
      }
      if (this._cancelled) throw new Error('cancelled');

      // The seek updates the media element before the app's preview loop gets
      // another animation frame. Render the landed frame explicitly so the
      // recorded canvas cannot begin with a stale pre-seek image.
      this.renderFrame?.();

      this.recorder.start(250);
      await video.play();
      let doneTicks = 0;
      this._tick = setInterval(() => {
        const dur = video.duration;
        this.onProgress(isFinite(dur) && dur ? video.currentTime / dur : 0);
        // fallback: some streams never fire 'ended' — settle once we've sat
        // at the end (or past it) for ~1s
        if (isFinite(dur) && dur > 0 && video.currentTime >= dur - 0.05) {
          if (++doneTicks >= 5) this._abort?.();
        } else {
          doneTicks = 0;
        }
      }, 200);

      await this.#waitFor(video, 'ended');
      clearInterval(this._tick);
      if (this.recorder.state !== 'inactive') this.recorder.stop();
      await stopped;
      if (this._cancelled) throw new Error('cancelled');

      const ext = mime.startsWith('video/mp4') ? 'mp4' : 'webm';
      const blob = new Blob(chunks, { type: mime.split(';')[0] });
      downloadBlob(blob, `${name}.${ext}`);
      this.onDone(blob);
      return blob;
    } finally {
      clearInterval(this._tick);
      this._abort = null;
      if (this.recorder && this.recorder.state !== 'inactive') this.recorder.stop();
      stream.getTracks().forEach((t) => t.stop());
      try { this._audioTap?.cached.src.disconnect(this._audioTap.dest); } catch { /* fine */ }
      this._audioTap = null;
      video.loop = wasLooping;
      video.muted = originalMuted;
      video.playbackRate = originalRate;
      const restoreTime = isFinite(video.duration)
        ? Math.min(Math.max(0, originalTime), Math.max(0, video.duration - 1e-3))
        : originalTime;
      await seekMedia(video, restoreTime, { timeoutMs: 2000 }).catch(() => {});
      if (!wasPaused) video.play().catch(() => {});
      else video.pause();
    }
  }

  cancel() {
    this._cancelled = true;
    clearInterval(this._tick);
    if (this.recorder && this.recorder.state !== 'inactive') this.recorder.stop();
    this._abort?.();
  }
}

// ---------------------------------------------------------------------------
// GIF export: samples processed frames while the video plays once.
// renderFrame() must return the current processed canvas.
// smooth may be a thunk evaluated after the sizing render (reads the engine's
// actual crisp-vs-tone state). postProcess (optional) runs on each frame's
// pixels AFTER decimation — the app uses it to apply post-FX at the GIF's own
// resolution, so scanlines/grain survive instead of being averaged away.
// ---------------------------------------------------------------------------
export async function exportGIF({ video, renderFrame, fps = 12, maxWidth = 480, name = 'dithered', onProgress = () => {}, onInfo = null, animate = null, liveDuration = 0, shouldAbort = null, smooth = false, postProcess = null, onSized = null }) {
  const originalTime = video?.currentTime ?? 0;
  const first = renderFrame();
  if (typeof smooth === 'function') smooth = !!smooth();
  // the sizing render ran at the arbitrary pre-export playback position; let
  // the caller drop temporal history again so frame 0 doesn't blend with it
  onSized?.();
  // Dither patterns don't survive fractional resampling — nearest-neighbor at
  // a ratio like 0.876 drops irregular rows/columns and shreds the pattern.
  // Snap to a whole-number divisor of the frame instead, picking the divisor
  // whose OUTPUT width lands closest to the request (ties prefer the larger,
  // crisper output). ÷1 when 'native' or the request is at/above frame size.
  let div = 1;
  if (isFinite(maxWidth) && first.width > maxWidth) {
    const lo = Math.max(1, Math.floor(first.width / maxWidth));
    const hi = lo + 1;
    div = (maxWidth - first.width / hi) < (first.width / lo - maxWidth) ? hi : lo;
  }
  const w = Math.max(1, Math.floor(first.width / div));
  const h = Math.max(1, Math.floor(first.height / div));

  // Memory bound for baked loops (the video path has its own below): at large
  // sizes, retaining every frame would exhaust the tab. Sampling the same
  // cycle at a lower fps keeps the loop seamless and the memory flat.
  if (animate?.count) {
    const maxFrames = gifFrameBudget(w, h);
    if (animate.count > maxFrames) {
      const k = Math.ceil(animate.count / maxFrames);
      animate = { ...animate, count: Math.ceil(animate.count / k) };
      fps /= k;
      // let the caller re-derive any nested animation rate for the new count,
      // or a fast effect layered on a slow scene aliases into a strobe
      animate.onResample?.(animate.count);
      onInfo?.(`Large GIF: sampling ${Math.round(fps)} fps to bound memory`);
    }
  }

  // Grab a frame at exactly 1 GIF pixel per div×div source block. Canvas
  // drawImage is NOT a reliable decimator (Chrome box-filters downscales even
  // with imageSmoothingEnabled=false), so sample the pixels ourselves:
  // hard-edged content (dither) takes one exact pixel per block; smooth
  // content (ASCII glyphs, cells) averages the block, or 1px strokes would
  // randomly hit/miss the sample grid and speckle between frames.
  const dst = div > 1 ? new Uint8ClampedArray(w * h * 4) : null;
  const grab = (srcCanvas) => {
    const ctx = srcCanvas.getContext('2d', { willReadFrequently: true });
    const img = ctx.getImageData(0, 0, w * div, h * div).data;
    if (div === 1) return img;
    const rowStride = w * div * 4;
    const n = div * div;
    for (let y = 0; y < h; y++) {
      let di = y * w * 4;
      const rowStart = y * div * rowStride;
      for (let x = 0; x < w; x++, di += 4) {
        const si = rowStart + x * div * 4;
        if (smooth) {
          let r = 0, g = 0, b = 0;
          for (let by = 0; by < div; by++) {
            let bi = si + by * rowStride;
            for (let bx = 0; bx < div; bx++, bi += 4) {
              r += img[bi]; g += img[bi + 1]; b += img[bi + 2];
            }
          }
          dst[di] = r / n; dst[di + 1] = g / n; dst[di + 2] = b / n;
        } else {
          dst[di] = img[si]; dst[di + 1] = img[si + 1]; dst[di + 2] = img[si + 2];
        }
        dst[di + 3] = 255;
      }
    }
    return dst;
  };
  // one captured frame: render -> decimate -> optional post-FX at GIF size
  const capture = () => {
    const px = grab(renderFrame());
    return postProcess ? postProcess(px, w, h) : px;
  };

  const enc = new GifEncoder(w, h, { fps });

  if (!video) {
    if (liveDuration > 0) {
      // Webcam and browser-decoded animated images cannot be seeked to exact
      // timestamps. Sample them in real time for the requested record length,
      // while keeping the same retained-pixel memory bound as baked loops.
      const wanted = Math.max(1, Math.round(liveDuration * fps));
      const maxFrames = gifFrameBudget(w, h);
      const count = Math.min(wanted, maxFrames);
      if (count < wanted) onInfo?.(`Large GIF: capped to ${(count / fps).toFixed(1)}s to bound memory`);
      const started = performance.now();
      for (let i = 0; i < count; i++) {
        if (shouldAbort?.()) throw new Error('cancelled');
        const due = started + (i * 1000) / fps;
        const delay = due - performance.now();
        if (delay > 0) await new Promise((r) => setTimeout(r, delay));
        enc.addFrame(capture());
        onProgress((i + 1) / count);
      }
      await new Promise((r) => setTimeout(r, 0));
      const blob = await enc.finish(shouldAbort);
      downloadBlob(blob, `${name}.gif`);
      return blob;
    }
    if (animate) {
      // Animated still: step the animation phase over exactly one cycle so
      // the exported GIF loops seamlessly. Yield each frame so the busy
      // overlay paints and Cancel clicks are processed.
      for (let i = 0; i < animate.count; i++) {
        if (shouldAbort?.()) throw new Error('cancelled');
        animate.setPhase(i / animate.count);
        enc.addFrame(capture());
        onProgress((i + 1) / animate.count);
        await new Promise((r) => setTimeout(r, 0));
      }
      await new Promise((r) => setTimeout(r, 0)); // paint 100% before LZW
      const blob = await enc.finish(shouldAbort);
      downloadBlob(blob, `${name}.gif`);
      return blob;
    }
    // Single image -> single-frame GIF
    enc.addFrame(postProcess ? postProcess(grab(first), w, h) : grab(first));
    const blob = await enc.finish(shouldAbort);
    downloadBlob(blob, `${name}.gif`);
    return blob;
  }

  const wasLooping = video.loop;
  const wasPaused = video.paused;
  video.loop = false;
  video.pause();

  try {
    // MediaRecorder-produced webm (including this app's own exports) reports
    // duration = Infinity until forced to demux to the end.
    if (!isFinite(video.duration)) {
      video.currentTime = 1e10;
      await new Promise((resolve) => {
        let t = null;
        const poll = setInterval(() => { if (isFinite(video.duration)) settle(); }, 100);
        const settle = () => { clearInterval(poll); clearTimeout(t); video.removeEventListener('durationchange', settle); resolve(); };
        video.addEventListener('durationchange', settle);
        t = setTimeout(settle, 4000);
      });
    }
    const duration = video.duration;
    if (!isFinite(duration) || duration <= 0) throw new Error('Video duration unknown — cannot sample frames');

    const step = 1 / fps;
    // memory bound: keep total retained frame indices under ~60M px (~120MB)
    const memFrames = gifFrameBudget(w, h);
    const frameCount = Math.max(1, Math.min(480, memFrames, Math.floor(duration * fps)));
    if (frameCount < Math.floor(duration * fps)) {
      onInfo?.(`GIF covers the first ${(frameCount / fps).toFixed(0)}s of ${duration.toFixed(0)}s`);
    }

    for (let i = 0; i < frameCount; i++) {
      // animated video: lock the phase to the video timeline, not wall clock
      animate?.setTime?.(i * step);
      await seekMedia(video, Math.min(duration - 0.001, i * step));
      enc.addFrame(capture());
      onProgress((i + 1) / frameCount);
    }

    const blob = await enc.finish(shouldAbort);
    downloadBlob(blob, `${name}.gif`);
    return blob;
  } finally {
    video.loop = wasLooping;
    const restoreTime = isFinite(video.duration)
      ? Math.min(Math.max(0, originalTime), Math.max(0, video.duration - 1e-3))
      : originalTime;
    await seekMedia(video, restoreTime, { timeoutMs: 2000 }).catch(() => {});
    if (!wasPaused) video.play().catch(() => {});
    else video.pause();
  }
}
