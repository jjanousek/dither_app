// Engine: routes a source frame through the right pipeline
// (GPU uber-shader | CPU error diffusion | ASCII renderer) based on params.

import { createGL, compileProgram, QUAD_VS, createTexture, uploadTexture, uploadR8, createFBO } from './gl.js';
import { DITHER_FS, TEMPORAL_FS, BLIT_FS, MAX_PALETTE } from './shaders.js';
import { applyAdjustments, errorDiffusion, orderedDither, quantize, whiteNoiseDither, halftoneDither, MATRICES, DIFFUSION_KERNELS } from './cpu.js';
import { getBlueNoise } from './bluenoise.js';
import { AsciiRenderer, fontSpec } from './ascii.js';
import { CELL_EFFECTS } from '../effects/cells.js';
import { paletteToFloat, paletteToUniform } from '../palettes.js';
import { CpuPreview } from './cpu-preview.js';
import { CELL_SIZE_MIN } from '../state.js';

export const ALGORITHMS = [
  { id: 'floyd', name: 'Floyd–Steinberg', type: 'cpu', group: 'Error Diffusion' },
  { id: 'atkinson', name: 'Atkinson', type: 'cpu', group: 'Error Diffusion' },
  { id: 'jarvis', name: 'Jarvis–Judice–Ninke', type: 'cpu', group: 'Error Diffusion' },
  { id: 'stucki', name: 'Stucki', type: 'cpu', group: 'Error Diffusion' },
  { id: 'burkes', name: 'Burkes', type: 'cpu', group: 'Error Diffusion' },
  { id: 'sierra3', name: 'Sierra', type: 'cpu', group: 'Error Diffusion' },
  { id: 'sierra2', name: 'Two-Row Sierra', type: 'cpu', group: 'Error Diffusion' },
  { id: 'sierralite', name: 'Sierra Lite', type: 'cpu', group: 'Error Diffusion' },
  { id: 'falsefloyd', name: 'False Floyd–Steinberg', type: 'cpu', group: 'Error Diffusion' },
  { id: 'bayer2', name: 'Bayer 2×2', type: 'gpu', mode: 1, matrix: 'bayer2', group: 'Ordered' },
  { id: 'bayer4', name: 'Bayer 4×4', type: 'gpu', mode: 1, matrix: 'bayer4', group: 'Ordered' },
  { id: 'bayer8', name: 'Bayer 8×8', type: 'gpu', mode: 1, matrix: 'bayer8', group: 'Ordered' },
  { id: 'cluster4', name: 'Clustered Dot 4×4', type: 'gpu', mode: 1, matrix: 'cluster4', group: 'Ordered' },
  { id: 'cluster8', name: 'Clustered Dot 8×8', type: 'gpu', mode: 1, matrix: 'cluster8', group: 'Ordered' },
  { id: 'bluenoise', name: 'Blue Noise', type: 'gpu', mode: 1, matrix: 'bluenoise', group: 'Ordered' },
  { id: 'whitenoise', name: 'White Noise', type: 'gpu', mode: 2, group: 'Noise' },
  { id: 'halftone', name: 'Halftone Dots', type: 'gpu', mode: 3, group: 'Halftone' },
  { id: 'halftone-line', name: 'Halftone Lines', type: 'gpu', mode: 4, group: 'Halftone' },
  { id: 'none', name: 'Quantize Only', type: 'gpu', mode: 0, group: 'Basic' },
];

export function getAlgorithm(id) {
  return ALGORITHMS.find((a) => a.id === id) || ALGORITHMS[0];
}

// Cap on the supersampled source when Smoothness > 0. Dither is evaluated at
// ss*ss the output pixels, so the output grid shrinks to keep the source within
// a sane per-frame cost (the governor drops ss under sustained load). Smooth
// mode therefore trades some output resolution for tone — it is NOT full native
// like the crisp path; that is the intended "fine print" behaviour.
const SS_SOURCE_BUDGET = 5_000_000;

export class Engine {
  constructor() {
    this.work = document.createElement('canvas');
    this.workCtx = this.work.getContext('2d', { willReadFrequently: true });
    this.glCanvas = document.createElement('canvas');
    this.gl = createGL(this.glCanvas);
    this.ascii = new AsciiRenderer();
    this.matrixTextures = {};
    if (this.gl) this.#initGL();

    // caches keyed by palette identity
    this._palKey = '';
    this._palFloat = null;
    this._palUniform = null;

    // async CPU-dither preview (lazy — only the live main engine opts in)
    this.cpu = null;
    this.onCpuResult = null; // set by the app: fires when an async result lands
    this._allowAsync = false; // per-render flag; only true for the live path
  }

  #initGL() {
    const gl = this.gl;
    if (!this._lossHooked) {
      this._lossHooked = true;
      this.glCanvas.addEventListener('webglcontextlost', (e) => {
        e.preventDefault(); // allow restoration
        this.glLost = true;
      });
      this.glCanvas.addEventListener('webglcontextrestored', () => {
        this.glLost = false;
        this.#initGL(); // recompile program, re-upload threshold textures
      });
    }
    try {
      this.program = compileProgram(gl, QUAD_VS, DITHER_FS);
    } catch (err) {
      console.error(err);
      this.gl = null;
      return;
    }
    gl.useProgram(this.program);
    this.u = {};
    for (const name of [
      'u_src', 'u_threshold', 'u_outSize', 'u_ss', 'u_smoothness',
      'u_thresholdSize', 'u_mode',
      'u_brightness', 'u_contrast', 'u_gamma', 'u_saturation', 'u_strength',
      'u_bias', 'u_invert', 'u_palette', 'u_paletteSize', 'u_darkest', 'u_brightest',
      'u_halftoneScale', 'u_halftoneAngle', 'u_matOffset', 'u_seed',
      'u_motionDamp', 'u_hasMotion',
    ]) {
      this.u[name] = gl.getUniformLocation(this.program, name);
    }
    // LINEAR: the temporal pass may minify this into a native-clamped history
    // FBO on the canvas-upload path; 1:1 texel-center reads are unchanged.
    this.srcTex = createTexture(gl, { filter: gl.LINEAR });

    // Temporal-smoothing pre-pass program + history ping-pong (FBOs made lazily
    // at source resolution). If it fails to compile, temporal just no-ops.
    try {
      this.temporalProgram = compileProgram(gl, QUAD_VS, TEMPORAL_FS);
      this.tu = {};
      for (const name of ['u_src', 'u_hist', 'u_historyWeight', 'u_motionLo', 'u_motionHi', 'u_denoise', 'u_texel', 'u_reset']) {
        this.tu[name] = gl.getUniformLocation(this.temporalProgram, name);
      }
    } catch (err) {
      console.error(err);
      this.temporalProgram = null;
    }
    this.histA = null;
    this.histB = null;
    this.histValid = false;

    // Direct GPU video-ingest: blit program + native-res mipmapped video
    // texture + work FBO (all lazy). Falls back to Canvas2D if it won't compile.
    try {
      this.blitProgram = compileProgram(gl, QUAD_VS, BLIT_FS);
      this.blitU = { u_src: gl.getUniformLocation(this.blitProgram, 'u_src') };
    } catch (err) {
      console.error(err);
      this.blitProgram = null;
    }
    this.videoTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.videoTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.workFBO = null;

    // Threshold matrix textures (R8, tiling)
    for (const [key, m] of Object.entries(MATRICES)) {
      const bytes = new Uint8Array(m.size * m.size);
      for (let i = 0; i < m.data.length; i++) bytes[i] = Math.round(m.data[i] * 255);
      const tex = createTexture(gl, { wrap: gl.REPEAT });
      uploadR8(gl, tex, m.size, bytes);
      this.matrixTextures[key] = { tex, size: m.size };
    }
    const bn = getBlueNoise();
    const bnTex = createTexture(gl, { wrap: gl.REPEAT });
    uploadR8(gl, bnTex, bn.size, bn.bytes);
    this.matrixTextures.bluenoise = { tex: bnTex, size: bn.size };
  }

  #palettes(colors) {
    const key = colors.join(',');
    if (key !== this._palKey) {
      this._palKey = key;
      this._palFloat = paletteToFloat(colors);
      this._palUniform = paletteToUniform(colors.slice(0, MAX_PALETTE), MAX_PALETTE);
      let dark = 0;
      let bright = 0;
      let minL = Infinity;
      let maxL = -Infinity;
      const size = Math.min(colors.length, MAX_PALETTE);
      for (let i = 0; i < size; i++) {
        const j = i * 3;
        const l = 0.2126 * this._palFloat[j] + 0.7152 * this._palFloat[j + 1] + 0.0722 * this._palFloat[j + 2];
        if (l < minL) { minL = l; dark = j; }
        if (l > maxL) { maxL = l; bright = j; }
      }
      this._palDark = this._palFloat.slice(dark, dark + 3).map((v) => v / 255);
      this._palBright = this._palFloat.slice(bright, bright + 3).map((v) => v / 255);
    }
    return {
      float: this._palFloat,
      uniform: this._palUniform,
      size: Math.min(colors.length, MAX_PALETTE),
      darkest: this._palDark,
      brightest: this._palBright,
    };
  }

  // Settings signature for the async CPU preview — a change forces one
  // synchronous, correct frame. Must stay identical to what the dispatch in
  // #renderCPU uses, so the busy-skip in render() never misjudges staleness.
  #cpuSig(algo, p, pal, w, h) {
    const pf = pal.float;
    let ph = pf.length;
    for (let i = 0; i < pf.length; i++) ph = (Math.imul(ph, 31) + pf[i]) | 0;
    return `${algo.id}|${p.ditherStrength}|${p.serpentine}|${p.threshold - 0.5}|${w}x${h}|${ph}`;
  }

  /**
   * Process one frame.
   * @param source CanvasImageSource (img/video/canvas)
   * @param srcW/srcH intrinsic source size
   * @param p params (see main.js state)
   * @param maxPixels optional cap on work-canvas area (video preview perf)
   * @returns canvas containing the processed frame
   */
  render(source, srcW, srcH, p, maxPixels = Infinity, allowAsync = false, contentNew = true) {
    if (!srcW || !srcH) return null;
    this._allowAsync = allowAsync;
    this._contentNew = contentNew;
    this.lastBoxResolved = false; // dither GPU path sets this true when ss>1

    if (p.mode === 'ascii') return this.#renderAscii(source, srcW, srcH, p, maxPixels);
    if (p.mode !== 'dither') return this.#renderCells(source, srcW, srcH, p, maxPixels);

    let w = Math.max(1, Math.round(srcW / p.pixelSize));
    let h = Math.max(1, Math.round(srcH / p.pixelSize));
    if (w * h > maxPixels) {
      const k = Math.sqrt(maxPixels / (w * h));
      w = Math.max(1, Math.floor(w * k));
      h = Math.max(1, Math.floor(h * k));
    }

    const algo = getAlgorithm(p.algorithm);
    const pal = this.#palettes(p.colors);
    const effSat = p.grayscale ? 0 : p.saturation;
    const gpu = algo.type === 'gpu' && this.gl && !this.glLost && !this.gl.isContextLost();

    // Live CPU error-diffusion fast paths. (a) A worker-completion wake-up in
    // steady state (nothing pending, settings unchanged — any change would
    // have set dirty and arrived with contentNew=true) only needs to PRESENT
    // the committed result: skip the whole ingest/adjust pipeline that would
    // otherwise run just to be handed back the same canvas. (b) A new frame
    // while the worker is still busy on unchanged settings would be dropped
    // AFTER full prep anyway (cpu-preview keeps the latest committed result
    // and re-dispatches on reply) — mark it pending and skip the prep too.
    if (algo.type === 'cpu' && this._allowAsync && this.cpu
        && this.cpu.state === 'ready' && this.cpu.committedEpoch === this.cpu.epoch) {
      if (!contentNew && !this.cpu.pending) return this.cpu.committed;
      if (this.cpu.busy && this.cpu.cw === w && this.cpu.ch === h
          && this.cpu.sig === this.#cpuSig(algo, p, pal, w, h)) {
        if (contentNew) this.cpu.pending = true;
        return this.cpu.committed;
      }
    }

    // Smoothness (GPU only): dither on a finer grid and box-average down. Shrink
    // the OUTPUT grid so the supersampled source (ss*w x ss*h) stays in budget.
    // Live preview caps ss at 2: ss=3 would (a) hit the SS budget at both 3 and
    // 2 so the governor's 3->2 step buys nothing, and (b) cause a resolution
    // cliff. Exports (not _allowAsync) may use ss=3 for extra tone in the file.
    // p.ssCap lets the sustained-load governor pull ss->1 before base resolution.
    let ss = 1;
    if (gpu && p.smoothness > 0) {
      const liveMax = this._allowAsync ? 2 : 3;
      ss = Math.min(p.smoothness > 0.6 ? 3 : 2, p.ssCap ?? 3, liveMax);
    }
    if (ss > 1) {
      // Exports at ss=3 get a proportionally larger source budget: under the
      // shared 5MP cap, ss=3 would shrink the output grid to 5M/9 ≈ 0.55MP —
      // LESS than half the ss=2 preview's 1.25MP, on the one path (offline)
      // that can afford more compute. 11.25M keeps the export grid at the
      // ss=2 preview size, so raising Smoothness never costs resolution.
      const ssBudget = (!this._allowAsync && ss === 3) ? 11_250_000 : SS_SOURCE_BUDGET;
      const outCap = Math.min(maxPixels, Math.floor(ssBudget / (ss * ss)));
      if (w * h > outCap) {
        const k = Math.sqrt(outCap / (w * h));
        w = Math.max(1, Math.floor(w * k));
        h = Math.max(1, Math.floor(h * k));
      }
    }
    // Tell present() whether the on-screen result is box-resolved tone (needs
    // smooth upscaling) or crisp dots (nearest) — based on the ACTUAL ss used,
    // so a CPU algorithm / governor ss->1 / WebGL loss all read correctly.
    this.lastBoxResolved = gpu && ss > 1 && p.smoothness > 0;

    // Direct GPU video ingest: skip the per-frame Canvas2D resample when the
    // source is a video/webcam element and nothing needs Canvas2D compositing
    // (CSS filters, or sweep/wave canvas animation). Thermal win on the Air.
    const isVideoEl = typeof HTMLVideoElement !== 'undefined' && source instanceof HTMLVideoElement;
    const hasFilter = p.hue || p.sepia || p.blur;
    const canvasAnim = p.anim && (p.anim.style === 'sweep' || p.anim.style === 'wave');
    // Never process video on a grid finer than the video itself: the
    // supersampled grid (w*ss) can exceed native size (pixel size 1 +
    // smoothness), where finer buffers hold only interpolated pixels — the
    // dither pass gets identical values by sampling a native-res buffer with
    // LINEAR filtering, and the ingest/temporal passes shade far fewer pixels.
    // Computed for BOTH GPU paths so the temporal history FBOs keep one size
    // (and keep their history) when a CSS filter or sweep/wave flips the path.
    let texW = w * ss, texH = h * ss;
    if (isVideoEl) {
      const k = Math.min(1, srcW / texW, srcH / texH);
      texW = Math.max(1, Math.round(texW * k));
      texH = Math.max(1, Math.round(texH * k));
    }
    if (gpu && isVideoEl && !hasFilter && !canvasAnim && this.blitProgram) {
      const workTex = this.#ingestVideo(source, texW, texH);
      return this.#renderGPU(null, w, h, ss, p, algo, pal, effSat, workTex, texW, texH);
    }

    // The work canvas holds the source at the (super)sampled resolution; the
    // CPU path never supersamples (ss stays 1), so it still gets w x h.
    const work = this.#drawWork(source, w * ss, h * ss, p);

    if (gpu) return this.#renderGPU(work, w, h, ss, p, algo, pal, effSat, null, texW, texH);
    return this.#renderCPU(work, w, h, p, algo, pal, effSat);
  }

  // Downsample the source into the shared work canvas, applying the CSS-filter
  // adjustments and the canvas-space animation styles (sweep / wave).
  //
  // Still images cache the downsampled base: a large photo (10MP+) put
  // through a high-quality resample EVERY animation frame dominates the
  // frame budget (especially in WebKit) and turns 60fps animations into a
  // slideshow. The cache key covers everything that feeds the base.
  #drawWork(source, w, h, p) {
    const work = this.work;
    if (work.width !== w || work.height !== h) {
      work.width = w;
      work.height = h;
    }
    const ctx = this.workCtx;
    // Video/webcam into a willReadFrequently (software) canvas is the CPU-path
    // bottleneck: drawImage must download + convert the full native decoded
    // frame (~8MB at 1080p) and run a software resample proportional to the
    // NATIVE pixel count, on the main thread, every frame. Downsample on the
    // GPU instead and read back only the small w×h result. CSS filters still
    // need the Canvas2D path (ctx.filter), sweep/wave run after via #animCanvas.
    // Live loop only (p.liveRender): exports keep the deterministic Canvas2D
    // 'high' resample. Downsample only: a magnified grid (GPU sweep/wave with
    // supersampling) would read back MORE pixels than the video has.
    const isVideoEl = typeof HTMLVideoElement !== 'undefined' && source instanceof HTMLVideoElement;
    if (p.liveRender && isVideoEl && !(p.hue || p.sepia || p.blur)
        && w <= (source.videoWidth || 0) && h <= (source.videoHeight || 0)
        && this.gl && !this.glLost && !this.gl.isContextLost() && this.blitProgram) {
      const px = this.#readbackVideo(source, w, h);
      if (px) {
        ctx.putImageData(px, 0, 0);
        this.#animCanvas(p, w, h);
        return work;
      }
    }
    if (p.staticSource) {
      const key = `${w}x${h}|${this.#filterString(p)}`;
      if (this.baseSrc !== source || this.baseKey !== key) {
        if (!this.baseCanvas) this.baseCanvas = document.createElement('canvas');
        const c = this.baseCanvas;
        c.width = w;
        c.height = h;
        const bctx = c.getContext('2d');
        bctx.imageSmoothingEnabled = true;
        bctx.imageSmoothingQuality = 'high';
        bctx.filter = this.#filterString(p);
        bctx.drawImage(source, 0, 0, w, h);
        bctx.filter = 'none';
        this.baseSrc = source;
        this.baseKey = key;
      }
      ctx.clearRect(0, 0, w, h);
      ctx.drawImage(this.baseCanvas, 0, 0);
    } else {
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.clearRect(0, 0, w, h); // transparent sources must not ghost old frames
      ctx.filter = this.#filterString(p);
      ctx.drawImage(source, 0, 0, w, h);
      ctx.filter = 'none';
    }
    this.#animCanvas(p, w, h);
    return work;
  }

  #animCanvas(p, w, h) {
    const a = p.anim;
    if (!a || (a.style !== 'sweep' && a.style !== 'wave')) return;
    const ctx = this.workCtx;
    const phase = p.animPhase || 0;
    if (a.style === 'sweep') {
      // a soft light band travelling across the frame
      const band = Math.max(4, w * 0.35);
      const x = phase * (w + 2 * band) - band;
      const g = ctx.createLinearGradient(x - band, 0, x + band, 0);
      const alpha = 0.5 * a.intensity;
      g.addColorStop(0, 'rgba(255,255,255,0)');
      g.addColorStop(0.5, `rgba(255,255,255,${alpha})`);
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.save();
      // 'screen': uniform additive brighten, visible over dark content too
      ctx.globalCompositeOperation = 'screen';
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
      ctx.restore();
    } else {
      // wave: shift each row horizontally by a phase-locked sine
      if (!this.waveCanvas) {
        this.waveCanvas = document.createElement('canvas');
        this.waveCtx = this.waveCanvas.getContext('2d');
      }
      if (this.waveCanvas.width !== w || this.waveCanvas.height !== h) {
        this.waveCanvas.width = w;
        this.waveCanvas.height = h;
      }
      this.waveCtx.clearRect(0, 0, w, h);
      this.waveCtx.drawImage(this.work, 0, 0);
      // keep the unshifted frame beneath the shifted rows so the exposed
      // edge columns show clamped content instead of transparent-black bars
      const amp = Math.max(1, w * 0.05) * a.intensity;
      const ph = phase * Math.PI * 2;
      for (let y = 0; y < h; y++) {
        const dx = Math.sin(ph + (y / h) * Math.PI * 6) * amp;
        ctx.drawImage(this.waveCanvas, 0, y, w, 1, dx, y, w, 1);
      }
    }
  }

  // Brightness modulation styles (breathe / pulse) — apply on every path.
  #animBrightness(p) {
    const a = p.anim;
    if (!a) return p.brightness;
    const ph = (p.animPhase || 0) * Math.PI * 2;
    if (a.style === 'breathe') return p.brightness + Math.sin(ph) * 0.25 * a.intensity;
    if (a.style === 'pulse') {
      const beat = Math.pow(Math.max(0, Math.sin(ph)), 8)
        + 0.5 * Math.pow(Math.max(0, Math.sin(ph + 2.6)), 8);
      return p.brightness + (beat - 0.15) * 0.35 * a.intensity;
    }
    return p.brightness;
  }

  // Pattern drift (flow) / reseed (shimmer) for ordered, noise and halftone
  // modes. Distances are whole tiles per cycle so exported loops are seamless.
  #matAnim(p, tileSize) {
    const a = p.anim;
    const phase = p.animPhase || 0;
    if (a?.style === 'flow') {
      const DIRS = {
        right: [1, 0], left: [-1, 0], down: [0, 1], up: [0, -1],
        downright: [1, 1], upleft: [-1, -1],
      };
      const [dx, dy] = DIRS[a.direction] || DIRS.right;
      const d = phase * tileSize * 2;
      // negative: sampling at pix+offset moves the pattern the other way
      return { ox: -dx * d, oy: -dy * d, seed: 0 };
    }
    if (a?.style === 'shimmer') {
      const k = Math.floor(phase * 16); // deterministic jumps, loops cleanly
      const h1 = Math.abs(Math.sin((k + 1) * 12.9898) * 43758.5453) % 1;
      const h2 = Math.abs(Math.sin((k + 1) * 78.233) * 12543.123) % 1;
      return { ox: Math.floor(h1 * tileSize), oy: Math.floor(h2 * tileSize), seed: k + 1 };
    }
    return { ox: 0, oy: 0, seed: 0 };
  }

  // Free the history FBOs and forget history (source switch — also reclaims GPU).
  resetTemporal() { this.#releaseHistory(); }

  // Forget history but keep the FBOs (cheap, no realloc). For discontinuities
  // where the next frame must not blend with the last: seek/scrub, export start.
  invalidateTemporal() { this.histValid = false; }

  // Free the history ping-pong FBOs (and forget history). Called when the
  // pre-pass is off and on source switch so idle temporal state doesn't retain
  // multi-MB GPU allocations. #temporalPass lazily recreates them on demand.
  #releaseHistory() {
    const gl = this.gl;
    if (gl && this.histA) { gl.deleteTexture(this.histA.tex); gl.deleteFramebuffer(this.histA.fbo); }
    if (gl && this.histB) { gl.deleteTexture(this.histB.tex); gl.deleteFramebuffer(this.histB.fbo); }
    this.histA = null;
    this.histB = null;
    this.histValid = false;
  }

  // Upload the video frame at native resolution, mipmap it, and GPU-downsample
  // into the work FBO — replaces the per-frame Canvas2D resample. Returns the
  // work texture at (w x h) for the temporal/dither passes to consume.
  #ingestVideo(videoEl, w, h) {
    const gl = this.gl;
    const vw = videoEl.videoWidth || w;
    const vh = videoEl.videoHeight || h;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.videoTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, videoEl);
    // Skip the mip chain only where a single LINEAR tap genuinely suffices:
    // its 2x2-texel footprint covers strides up to ~1.3x, and at an
    // exactly-aligned 2x the destination-texel-center tap IS the 2x2 box
    // average. Fractional strides in between (budget-scaled grids, e.g. a 4K
    // clip capped to ~1.9x) under-filter without mips and shimmer on motion.
    const exact2 = vw === w * 2 && vh === h * 2;
    const minify = !(exact2 || (vw <= w * 1.3 && vh <= h * 1.3));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, minify ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
    if (minify) gl.generateMipmap(gl.TEXTURE_2D);
    if (!this.workFBO || this.workFBO.w !== w || this.workFBO.h !== h) {
      if (this.workFBO) { gl.deleteTexture(this.workFBO.tex); gl.deleteFramebuffer(this.workFBO.fbo); }
      // LINEAR: the dither pass may sample this buffer on a grid finer than
      // its own resolution (native clamp); on-texel-center taps are unchanged.
      this.workFBO = createFBO(gl, w, h, { filter: gl.LINEAR });
    }
    gl.useProgram(this.blitProgram);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.workFBO.fbo);
    gl.viewport(0, 0, w, h);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.videoTex);
    gl.uniform1i(this.blitU.u_src, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return this.workFBO.tex;
  }

  // GPU-assisted ingest for the CPU paths (error diffusion / ASCII / cells):
  // blit the native video frame into the small work FBO and read back only the
  // w×h pixels. The readPixels sync is cheap here — the GL queue holds nothing
  // but the trivial blit — and it replaces a native-res software readback +
  // high-quality software resample on the main thread. Returns a reusable
  // ImageData (rows come back top-first: FBO row 0 = uv 0 = video top row,
  // matching the Canvas2D orientation), or null so the caller falls back.
  #readbackVideo(videoEl, w, h) {
    const gl = this.gl;
    try {
      this.#ingestVideo(videoEl, w, h);
      if (!this._readImg || this._readImg.width !== w || this._readImg.height !== h) {
        this._readImg = new ImageData(w, h);
        this._readView = new Uint8Array(this._readImg.data.buffer);
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.workFBO.fbo);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, this._readView);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      return this._readImg;
    } catch {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      return null;
    }
  }

  // Motion-gated EMA on the raw downsampled frame. Renders the stabilized frame
  // into a ping-pong FBO and returns its texture for the dither pass to consume.
  #temporalPass(baseTex, w, h, p) {
    const gl = this.gl;
    if (!this.histA || this.histA.w !== w || this.histA.h !== h) {
      if (this.histA) { gl.deleteTexture(this.histA.tex); gl.deleteFramebuffer(this.histA.fbo); }
      if (this.histB) { gl.deleteTexture(this.histB.tex); gl.deleteFramebuffer(this.histB.fbo); }
      // LINEAR for the same reason as the work FBO: the dither pass may sample
      // the stabilized frame on a finer grid than the buffer's own resolution.
      this.histA = createFBO(gl, w, h, { filter: gl.LINEAR });
      this.histB = createFBO(gl, w, h, { filter: gl.LINEAR });
      this.histValid = false;
    }
    gl.useProgram(this.temporalProgram);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.histB.fbo);
    gl.viewport(0, 0, w, h);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, baseTex);
    gl.uniform1i(this.tu.u_src, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.histA.tex);
    gl.uniform1i(this.tu.u_hist, 1);
    // temporal weight 0 when only denoise is active (still store cur -> gives a
    // motion signal vs the previous frame for motion-adaptive strength)
    gl.uniform1f(this.tu.u_historyWeight, Math.max(0, Math.min(1, p.temporal || 0)) * 0.8);
    gl.uniform1f(this.tu.u_motionLo, 0.03);
    gl.uniform1f(this.tu.u_motionHi, 0.13);
    gl.uniform1f(this.tu.u_denoise, Math.max(0, Math.min(1, p.videoDenoise || 0)));
    gl.uniform2f(this.tu.u_texel, 1 / w, 1 / h);
    gl.uniform1i(this.tu.u_reset, this.histValid ? 0 : 1);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.histValid = true;
    // swap: the frame we just wrote (histB) becomes the source + next read
    const written = this.histB;
    this.histB = this.histA;
    this.histA = written;
    return written.tex;
  }

  // texW/texH = actual resolution of the source texture. Equal to the fine
  // grid (w*ss) for canvas uploads; the direct video ingest clamps them to the
  // video's native size (no point shading interpolated pixels — the dither
  // pass samples by UV and LINEAR filtering reproduces the upscale exactly).
  #renderGPU(work, w, h, ss, p, algo, pal, effSat, preTex = null, texW = w * ss, texH = h * ss) {
    const gl = this.gl;
    const canvas = this.glCanvas;

    // preTex = source already on the GPU (direct video ingest); otherwise
    // upload the work canvas.
    let baseTex = preTex;
    if (!preTex) {
      gl.activeTexture(gl.TEXTURE0);
      uploadTexture(gl, this.srcTex, work);
      baseTex = this.srcTex;
    }

    // Pre-pass (video/webcam only, live preview OR export): temporal EMA and/or
    // denoise -> stabilized source, with per-pixel motion in its alpha for
    // motion-adaptive strength. Gated on p.liveSource (not _allowAsync) so the
    // exported clip is WYSIWYG with the tuned preview, and NOT on !staticSource
    // (which would run on generated scenes and clobber their alpha via
    // motion-in-alpha). The app resets history on export start / seek.
    let srcTexForDither = baseTex;
    const prePassOn = !!p.liveSource && this.temporalProgram
      && ((p.temporal || 0) > 0 || (p.videoDenoise || 0) > 0);
    if (prePassOn) srcTexForDither = this.#temporalPass(baseTex, texW, texH, p);
    else this.#releaseHistory(); // free history FBOs when the pre-pass is off

    // canvas is the OUTPUT (present) resolution; the source may be finer (ss>1)
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    // the pre-passes rendered into FBOs — restore the default framebuffer and
    // the output-sized viewport for the final dither draw (defensive)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, w, h);
    gl.useProgram(this.program);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, srcTexForDither);
    gl.uniform1i(this.u.u_src, 0);
    gl.uniform2f(this.u.u_outSize, w, h);
    gl.uniform1i(this.u.u_ss, ss);
    gl.uniform1f(this.u.u_smoothness, p.smoothness || 0);
    gl.uniform1i(this.u.u_hasMotion, prePassOn ? 1 : 0);
    gl.uniform1f(this.u.u_motionDamp, prePassOn ? 0.45 : 0); // full motion -> x0.55 strength

    const mat = this.matrixTextures[algo.matrix] || this.matrixTextures.bayer4;
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, mat.tex);
    gl.uniform1i(this.u.u_threshold, 1);
    gl.uniform1f(this.u.u_thresholdSize, mat.size);

    gl.uniform1i(this.u.u_mode, algo.mode);
    gl.uniform1f(this.u.u_brightness, this.#animBrightness(p));
    gl.uniform1f(this.u.u_contrast, p.contrast);
    gl.uniform1f(this.u.u_gamma, p.gamma);
    gl.uniform1f(this.u.u_saturation, effSat);
    gl.uniform1f(this.u.u_strength, p.ditherStrength);
    gl.uniform1f(this.u.u_bias, p.threshold - 0.5);
    gl.uniform1i(this.u.u_invert, p.invert ? 1 : 0);
    gl.uniform3fv(this.u.u_palette, pal.uniform);
    gl.uniform1i(this.u.u_paletteSize, pal.size);
    gl.uniform3fv(this.u.u_darkest, pal.darkest);
    gl.uniform3fv(this.u.u_brightest, pal.brightest);
    gl.uniform1f(this.u.u_halftoneScale, p.halftoneScale);
    gl.uniform1f(this.u.u_halftoneAngle, (p.halftoneAngle * Math.PI) / 180);

    const tile = algo.mode >= 3 ? Math.max(2, p.halftoneScale) : mat.size;
    let drift = this.#matAnim(p, tile);
    if (algo.mode === 2 && p.anim?.style === 'flow') {
      // a hash field can't translate seamlessly: step the seed instead
      // (16 reseeds per cycle, returns to the phase-0 pattern at wrap)
      const k = Math.floor(((p.animPhase || 0) % 1) * 16);
      drift = { ox: 0, oy: 0, seed: k };
    } else if (algo.mode === 4 && p.anim?.style === 'flow' && drift.oy === 0 && drift.ox !== 0) {
      // lines only vary in y: horizontal flow would be invisible, so scroll
      // perpendicular to the lines instead (same seamless lattice distance)
      drift = { ox: 0, oy: drift.ox, seed: drift.seed };
    }
    gl.uniform2f(this.u.u_matOffset, drift.ox, drift.oy);
    gl.uniform1f(this.u.u_seed, drift.seed);

    gl.drawArrays(gl.TRIANGLES, 0, 3);
    return canvas;
  }

  #renderCPU(work, w, h, p, algo, pal, effSat) {
    const ctx = this.workCtx;
    const img = ctx.getImageData(0, 0, w, h);
    applyAdjustments(img, {
      brightness: this.#animBrightness(p),
      contrast: p.contrast,
      gamma: p.gamma,
      saturation: effSat,
      invert: p.invert,
    });
    const bias = p.threshold - 0.5;
    if (algo.type === 'cpu') {
      const opts = { strength: p.ditherStrength, serpentine: p.serpentine, bias };
      // Live path: run the diffusion in a worker so the UI stays responsive.
      // Byte-identical (same errorDiffusion); exports/thumbnails never opt in.
      if (this._allowAsync) {
        if (!this.cpu) this.cpu = new CpuPreview(() => { if (this.onCpuResult) this.onCpuResult(); });
        const sig = this.#cpuSig(algo, p, pal, w, h);
        const committed = this.cpu.render(img, w, h, pal.float, algo.id, opts, sig, ctx, this._contentNew);
        if (committed) return committed; // async handled; present the committed result
      }
      errorDiffusion(img, pal.float, algo.id, opts);
    } else if (algo.mode === 1) {
      // GPU-style ordered mode but WebGL unavailable — CPU fallback
      const m = algo.matrix === 'bluenoise' ? getBlueNoise() : MATRICES[algo.matrix];
      const drift = this.#matAnim(p, m.size);
      orderedDither(img, pal.float, m, {
        strength: p.ditherStrength,
        bias,
        offsetX: drift.ox,
        offsetY: drift.oy,
      });
    } else if (algo.mode === 2) {
      // same animation drift/reseed as #renderGPU: flow steps the seed (a
      // hash field can't translate seamlessly), shimmer jumps offsets + seed
      let drift = this.#matAnim(p, 4);
      if (p.anim?.style === 'flow') {
        drift = { ox: 0, oy: 0, seed: Math.floor(((p.animPhase || 0) % 1) * 16) };
      }
      whiteNoiseDither(img, pal.float, {
        strength: p.ditherStrength,
        bias,
        seed: drift.seed,
        ox: drift.ox,
        oy: drift.oy,
      });
    } else if (algo.mode === 3 || algo.mode === 4) {
      let drift = this.#matAnim(p, Math.max(2, p.halftoneScale));
      if (algo.mode === 4 && p.anim?.style === 'flow' && drift.oy === 0 && drift.ox !== 0) {
        // lines only vary in y — scroll perpendicular (same as the GPU path)
        drift = { ox: 0, oy: drift.ox, seed: drift.seed };
      }
      halftoneDither(img, pal.float, {
        scale: p.halftoneScale,
        angle: p.halftoneAngle,
        bias: p.threshold - 0.5,
        line: algo.mode === 4,
        ox: drift.ox,
        oy: drift.oy,
      });
    } else {
      quantize(img, pal.float, bias);
    }
    ctx.putImageData(img, 0, 0);
    return work;
  }

  #renderAscii(source, srcW, srcH, p, maxPixels = Infinity) {
    const a = p.ascii;
    // Renderer decides sub-cell sampling density:
    // ramp 1x1, shape 8x8 (glyph matching), quadrant 2x2, braille 2x4.
    const renderer = a.renderer || (a.braille ? 'braille' : 'ramp');
    const DENSITY = { ramp: [1, 1], shape: [8, 8], quadrant: [2, 2], braille: [2, 4] };
    const [dx, dy] = DENSITY[renderer] || DENSITY.ramp;
    const MEASURE = { ramp: a.chars, shape: 'M', quadrant: '█', braille: '⣿' };

    const cellH = a.cellSize;
    const font = fontSpec(a);
    const cellW = this.ascii.measure(font, cellH, MEASURE[renderer]);
    let rows = Math.max(1, Math.round(srcH / cellH));
    let cols = Math.max(1, Math.round((srcW / srcH) * rows * (cellH / cellW)));
    // live-preview budget: shrink the grid, not the glyphs
    if (cols * dx * rows * dy > maxPixels) {
      const k = Math.sqrt(maxPixels / (cols * dx * rows * dy));
      cols = Math.max(1, Math.floor(cols * k));
      rows = Math.max(1, Math.floor(rows * k));
    }
    const w = cols * dx;
    const h = rows * dy;

    // Sampling work is already bounded above, but a small sampling grid could
    // still paint a source-sized text canvas (for example 38K cells -> a 10MP
    // canvas at 16px glyphs). Bound the preview bitmap separately while keeping
    // the SAME cell grid/detail: rasterize each glyph smaller, then let the
    // viewport scale the finished canvas. One-shot/export renders retain the
    // selected/native glyph size even when they carry a finite memory budget.
    let renderCellH = cellH;
    const outputArea = cols * cellW * rows * cellH;
    if (p.liveRender && isFinite(maxPixels) && outputArea > maxPixels * 2) {
      renderCellH = Math.max(4, Math.floor(cellH * Math.sqrt((maxPixels * 2) / outputArea)));
    }

    this.#drawWork(source, w, h, p);
    const img = this.workCtx.getImageData(0, 0, w, h);
    applyAdjustments(img, {
      brightness: this.#animBrightness(p),
      contrast: p.contrast,
      gamma: p.gamma,
      saturation: p.grayscale ? 0 : p.saturation,
      invert: p.invert,
    });
    return this.ascii.render(img, {
      renderer,
      chars: a.chars,
      cellSize: renderCellH,
      font,
      colorMode: a.colorMode,
      fg: a.fg,
      bg: a.bg,
      invertRamp: a.invertRamp,
      dither: a.dither || 'none',
      dotThreshold: a.dotThreshold ?? 0.5,
      edgeStrength: a.edgeStrength || (a.edges ? 0.5 : 0),
      autoContrast: a.autoContrast !== false,
      shapeSet: a.shapeSet || 'ascii',
      captureMetadata: a.captureMetadata !== false,
    });
  }

  #renderCells(source, srcW, srcH, p, maxPixels = Infinity) {
    const c = p.cells;
    const cell = Math.max(CELL_SIZE_MIN[p.mode] ?? 4, c.size);
    let cols = Math.max(1, Math.round(srcW / cell));
    let rows = Math.max(1, Math.round(srcH / cell));
    if (cols * rows * cell * cell > maxPixels * 2) {
      // cap the OUTPUT canvas area (cells draw at cell-size resolution);
      // 2x the dither budget since per-cell fills are cheaper than per-pixel
      const k = Math.sqrt((maxPixels * 2) / (cols * rows * cell * cell));
      cols = Math.max(1, Math.floor(cols * k));
      rows = Math.max(1, Math.floor(rows * k));
    }

    this.#drawWork(source, cols, rows, p);
    const img = this.workCtx.getImageData(0, 0, cols, rows);
    applyAdjustments(img, {
      brightness: this.#animBrightness(p),
      contrast: p.contrast,
      gamma: p.gamma,
      saturation: p.grayscale ? 0 : p.saturation,
      invert: p.invert,
    });

    if (!this.cellCanvas) {
      this.cellCanvas = document.createElement('canvas');
      this.cellCtx = this.cellCanvas.getContext('2d');
    }
    const W = Math.max(1, Math.round(cols * cell));
    const H = Math.max(1, Math.round(rows * cell));
    if (this.cellCanvas.width !== W || this.cellCanvas.height !== H) {
      this.cellCanvas.width = W;
      this.cellCanvas.height = H;
    }
    const eff = CELL_EFFECTS[p.mode] || CELL_EFFECTS.dots;
    eff.render(this.cellCtx, { cols, rows, data: img.data }, {
      cell,
      // Preserve the selected geometry while allowing expensive sub-pixel
      // decoration to be omitted in fine live video previews. Exports retain
      // the complete renderer treatment.
      compact: !!p.liveRender && cell <= 6,
      fill: c.fill,
      scatter: c.scatter,
      colorMode: c.colorMode,
      ink: c.ink,
      paper: c.paper,
      nodeShape: c.nodeShape,
      width: W,
      height: H,
    });
    return this.cellCanvas;
  }

  #filterString(p) {
    const f = [];
    if (p.hue) f.push(`hue-rotate(${p.hue}deg)`);
    if (p.sepia) f.push(`sepia(${p.sepia})`);
    if (p.blur) f.push(`blur(${p.blur}px)`);
    return f.length ? f.join(' ') : 'none';
  }
}
