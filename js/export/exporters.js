// Export: PNG stills, WebM/MP4 video via MediaRecorder, animated GIF, ASCII text.

import { GifEncoder } from './gif.js';
import { Mp4Muxer } from './mp4.js';

// Frame-accurate H.264/MP4 export via WebCodecs. Unlike the real-time
// MediaRecorder path, this seeks the source frame by frame and renders each
// one with no time pressure, so a slow dither can't judder the output — the
// clip is limited by quality, not by how fast the device renders. Video only
// (no audio). Returns false if WebCodecs is unavailable so the caller can
// fall back to the real-time recorder.
export function canFrameExport() {
  return typeof VideoEncoder !== 'undefined' && typeof VideoFrame !== 'undefined';
}

export async function exportVideoFrameAccurate({
  video, renderFrame, maxWidth = 1280, name = 'dithered',
  onProgress = () => {}, onInfo = null, shouldAbort = null,
}) {
  // resolve the source frame rate (fall back to 30) and duration
  if (!isFinite(video.duration)) {
    video.currentTime = 1e9;
    await new Promise((res) => {
      const done = () => { video.removeEventListener('durationchange', done); res(); };
      video.addEventListener('durationchange', done);
      setTimeout(done, 4000);
    });
  }
  const duration = video.duration;
  if (!isFinite(duration) || duration <= 0) throw new Error('video duration unknown');
  const fps = 30;
  // hold all compressed samples until finalize -> bound memory (and export
  // time) by capping the frame count; realistic clips are far under this
  const MAX_FRAMES = 6000; // ~3.3 min at 30fps
  let frameCount = Math.max(1, Math.round(duration * fps));
  if (frameCount > MAX_FRAMES) {
    frameCount = MAX_FRAMES;
    onInfo?.(`Long clip: exporting the first ${Math.round(MAX_FRAMES / fps)}s`);
  }

  // encode size: upscale the rendered (chunky) frame with nearest-neighbor so
  // the dither stays crisp. Cap the LONGER side (portrait clips too) and round
  // to even dims (H.264 needs even, and level 4.0 covers up to 1280x1280).
  const first = renderFrame();
  const long = Math.max(first.width, first.height);
  const k = long <= maxWidth ? Math.max(1, Math.floor(maxWidth / long)) : maxWidth / long;
  const w = Math.max(2, Math.round(first.width * k) & ~1);
  const h = Math.max(2, Math.round(first.height * k) & ~1);

  const frame = document.createElement('canvas');
  frame.width = w; frame.height = h;
  const fctx = frame.getContext('2d');
  fctx.imageSmoothingEnabled = false; // crisp pixels

  const muxer = new Mp4Muxer(w, h, fps);
  let encErr = null;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addChunk(chunk, meta),
    error: (e) => { encErr = e; },
  });
  // H.264 Baseline @ Level 4.0 (0x28): no B-frames (plays everywhere), and
  // level 4.0's 8192-macroblock limit covers any frame up to 1280x1280.
  const bitrate = Math.min(24e6, Math.max(2e6, Math.round(w * h * fps * 0.15)));
  encoder.configure({ codec: 'avc1.420028', width: w, height: h, bitrate, framerate: fps, avc: { format: 'avc' } });

  const wasLooping = video.loop;
  const wasPaused = video.paused;
  video.loop = false;
  video.pause();

  const seekTo = (t) => new Promise((res) => {
    let timer = null;
    const done = () => { video.removeEventListener('seeked', done); clearTimeout(timer); res(); };
    video.addEventListener('seeked', done);
    timer = setTimeout(done, 4000);
    video.currentTime = t;
  });

  try {
    for (let i = 0; i < frameCount; i++) {
      if (shouldAbort && shouldAbort()) throw new Error('cancelled');
      if (encErr) throw encErr;
      await seekTo(Math.min(duration - 1e-3, i / fps));
      const processed = renderFrame();
      fctx.drawImage(processed, 0, 0, processed.width, processed.height, 0, 0, w, h);
      const vf = new VideoFrame(frame, { timestamp: Math.round((i * 1e6) / fps), duration: Math.round(1e6 / fps) });
      encoder.encode(vf, { keyFrame: i % 60 === 0 });
      vf.close();
      // backpressure: don't let the encode queue run away, and keep UI alive
      while (encoder.encodeQueueSize > 8) await new Promise((r) => setTimeout(r, 4));
      onProgress((i + 1) / frameCount);
    }
    await encoder.flush();
    if (encErr) throw encErr;
    encoder.close();
    downloadBlob(muxer.finalize(), `${name}.mp4`);
  } finally {
    if (encoder.state !== 'closed') { try { encoder.close(); } catch { /* already closing */ } }
    video.loop = wasLooping;
    if (!wasPaused) video.play().catch(() => {});
  }
}

export function downloadBlob(blob, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
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
  constructor(canvas, sourceVideo, { fps = 30, onProgress, onDone } = {}) {
    this.canvas = canvas;
    this.video = sourceVideo;
    this.fps = fps;
    this.onProgress = onProgress || (() => {});
    this.onDone = onDone || (() => {});
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
      video.muted = true;
      video.play().catch(() => {});
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
// ---------------------------------------------------------------------------
export async function exportGIF({ video, renderFrame, fps = 12, maxWidth = 480, name = 'dithered', onProgress = () => {}, onInfo = null, animate = null, shouldAbort = null, smooth = false }) {
  const first = renderFrame();
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
    const maxFrames = Math.max(24, Math.floor(60e6 / (w * h)));
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

  const enc = new GifEncoder(w, h, { fps });

  if (!video) {
    if (animate) {
      // Animated still: step the animation phase over exactly one cycle so
      // the exported GIF loops seamlessly. Yield each frame so the busy
      // overlay paints and Cancel clicks are processed.
      for (let i = 0; i < animate.count; i++) {
        animate.setPhase(i / animate.count);
        enc.addFrame(grab(renderFrame()));
        onProgress((i + 1) / animate.count);
        await new Promise((r) => setTimeout(r, 0));
      }
      await new Promise((r) => setTimeout(r, 0)); // paint 100% before LZW
      downloadBlob(await enc.finish(shouldAbort), `${name}.gif`);
      return;
    }
    // Single image -> single-frame GIF
    enc.addFrame(grab(first));
    downloadBlob(await enc.finish(shouldAbort), `${name}.gif`);
    return;
  }

  const wasLooping = video.loop;
  const wasPaused = video.paused;
  video.loop = false;
  video.pause();

  const seekTo = (t) => new Promise((r) => {
    let timer = null;
    const hnd = () => { video.removeEventListener('seeked', hnd); clearTimeout(timer); r(); };
    video.addEventListener('seeked', hnd);
    timer = setTimeout(hnd, 4000); // safety: some streams drop seeked events
    video.currentTime = t;
  });

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
    const memFrames = Math.max(24, Math.floor(60e6 / (w * h)));
    const frameCount = Math.max(1, Math.min(480, memFrames, Math.floor(duration * fps)));
    if (frameCount < Math.floor(duration * fps)) {
      onInfo?.(`GIF covers the first ${(frameCount / fps).toFixed(0)}s of ${duration.toFixed(0)}s`);
    }

    for (let i = 0; i < frameCount; i++) {
      // animated video: lock the phase to the video timeline, not wall clock
      animate?.setTime?.(i * step);
      await seekTo(Math.min(duration - 0.001, i * step));
      enc.addFrame(grab(renderFrame()));
      onProgress((i + 1) / frameCount);
    }

    downloadBlob(await enc.finish(shouldAbort), `${name}.gif`);
  } finally {
    video.loop = wasLooping;
    if (!wasPaused) video.play().catch(() => {});
  }
}
