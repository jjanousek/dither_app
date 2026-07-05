// Export: PNG stills, WebM/MP4 video via MediaRecorder, animated GIF, ASCII text.

import { GifEncoder } from './gif.js';

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
export function buildAnsi(grid) {
  const out = [];
  for (const row of grid) {
    let curFg = -1;
    let curBg = -2;
    let line = '';
    for (const [ch, fg, bg] of row) {
      const f = fg ?? -1;
      const b = bg ?? -1;
      if (f !== curFg) {
        line += f < 0 ? '\x1b[39m' : `\x1b[38;2;${(f >> 16) & 255};${(f >> 8) & 255};${f & 255}m`;
        curFg = f;
      }
      if (b !== curBg) {
        line += b < 0 ? '\x1b[49m' : `\x1b[48;2;${(b >> 16) & 255};${(b >> 8) & 255};${b & 255}m`;
        curBg = b;
      }
      line += ch;
    }
    out.push(line + '\x1b[0m');
  }
  return out.join('\n') + '\n';
}

// Self-contained HTML with per-run color spans.
export function buildHtml(grid, pageBg = '#0a0a0c') {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const css = (v) => `#${(v & 0xffffff).toString(16).padStart(6, '0')}`;
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
  return `<!doctype html><meta charset="utf-8"><title>ascii art</title>` +
    `<body style="background:${pageBg};margin:20px 0">` +
    `<pre style="font:12px/1 Menlo,monospace;text-align:center">${rows.join('\n')}</pre>`;
}

// ---------------------------------------------------------------------------
// Video export: records the live preview canvas via captureStream while the
// source video plays through once. Audio is carried over when possible.
// ---------------------------------------------------------------------------
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
      // Audio passthrough (muted flag only silences playback, not capture,
      // but unmute so captureStream carries sound in all engines).
      try {
        video.muted = false;
        const audio = video.captureStream ? video.captureStream() : null;
        const track = audio?.getAudioTracks?.()[0];
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
      this._tick = setInterval(() => {
        this.onProgress(isFinite(video.duration) && video.duration ? video.currentTime / video.duration : 0);
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
      if (this.recorder.state !== 'inactive') this.recorder.stop();
      stream.getTracks().forEach((t) => t.stop());
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
export async function exportGIF({ video, renderFrame, fps = 12, maxWidth = 480, name = 'dithered', onProgress = () => {}, animate = null }) {
  const first = renderFrame();
  const scale = Math.min(1, maxWidth / first.width);
  const w = Math.max(1, Math.round(first.width * scale));
  const h = Math.max(1, Math.round(first.height * scale));

  const frame = document.createElement('canvas');
  frame.width = w;
  frame.height = h;
  const fctx = frame.getContext('2d', { willReadFrequently: true });
  fctx.imageSmoothingEnabled = false;

  const enc = new GifEncoder(w, h, { fps });

  if (!video) {
    if (animate) {
      // Animated still: step the animation phase over exactly one cycle so
      // the exported GIF loops seamlessly. Yield each frame so the busy
      // overlay paints and Cancel clicks are processed.
      for (let i = 0; i < animate.count; i++) {
        animate.setPhase(i / animate.count);
        const processed = renderFrame();
        fctx.drawImage(processed, 0, 0, w, h);
        enc.addFrame(fctx.getImageData(0, 0, w, h).data);
        onProgress((i + 1) / animate.count);
        await new Promise((r) => setTimeout(r, 0));
      }
      await new Promise((r) => setTimeout(r, 0)); // paint 100% before LZW
      downloadBlob(enc.finish(), `${name}.gif`);
      return;
    }
    // Single image -> single-frame GIF
    fctx.drawImage(first, 0, 0, w, h);
    enc.addFrame(fctx.getImageData(0, 0, w, h).data);
    downloadBlob(enc.finish(), `${name}.gif`);
    return;
  }

  const wasLooping = video.loop;
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
    if (!isFinite(video.duration)) await seekTo(1e10);
    const duration = video.duration;
    if (!isFinite(duration) || duration <= 0) throw new Error('Video duration unknown — cannot sample frames');

    const step = 1 / fps;
    const frameCount = Math.max(1, Math.min(480, Math.floor(duration * fps)));

    for (let i = 0; i < frameCount; i++) {
      // animated video: lock the phase to the video timeline, not wall clock
      animate?.setTime?.(i * step);
      await seekTo(Math.min(duration - 0.001, i * step));
      const processed = renderFrame();
      fctx.drawImage(processed, 0, 0, w, h);
      enc.addFrame(fctx.getImageData(0, 0, w, h).data);
      onProgress((i + 1) / frameCount);
    }

    downloadBlob(enc.finish(), `${name}.gif`);
  } finally {
    video.loop = wasLooping;
    video.play().catch(() => {});
  }
}
