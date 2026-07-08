// Engine: routes a source frame through the right pipeline
// (GPU uber-shader | CPU error diffusion | ASCII renderer) based on params.

import { createGL, compileProgram, QUAD_VS, createTexture, uploadTexture, uploadR8, createFBO } from './gl.js';
import { DITHER_FS, TEMPORAL_FS, MAX_PALETTE } from './shaders.js';
import { applyAdjustments, errorDiffusion, orderedDither, quantize, whiteNoiseDither, halftoneDither, MATRICES, DIFFUSION_KERNELS } from './cpu.js';
import { getBlueNoise } from './bluenoise.js';
import { AsciiRenderer, fontSpec } from './ascii.js';
import { CELL_EFFECTS } from '../effects/cells.js';
import { paletteToFloat, paletteToUniform } from '../palettes.js';
import { CpuPreview } from './cpu-preview.js';

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
// ss*ss the output pixels, so we shrink the output grid to keep the source
// within the GPU's flat-cost regime (~<=3.5MP) and the per-frame upload sane.
const SS_SOURCE_BUDGET = 4_000_000;

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
      'u_src', 'u_threshold', 'u_srcSize', 'u_outSize', 'u_ss', 'u_smoothness',
      'u_thresholdSize', 'u_mode',
      'u_brightness', 'u_contrast', 'u_gamma', 'u_saturation', 'u_strength',
      'u_bias', 'u_invert', 'u_palette', 'u_paletteSize',
      'u_halftoneScale', 'u_halftoneAngle', 'u_matOffset', 'u_seed',
    ]) {
      this.u[name] = gl.getUniformLocation(this.program, name);
    }
    this.srcTex = createTexture(gl);

    // Temporal-smoothing pre-pass program + history ping-pong (FBOs made lazily
    // at source resolution). If it fails to compile, temporal just no-ops.
    try {
      this.temporalProgram = compileProgram(gl, QUAD_VS, TEMPORAL_FS);
      this.tu = {};
      for (const name of ['u_src', 'u_hist', 'u_historyWeight', 'u_motionLo', 'u_motionHi', 'u_reset']) {
        this.tu[name] = gl.getUniformLocation(this.temporalProgram, name);
      }
    } catch (err) {
      console.error(err);
      this.temporalProgram = null;
    }
    this.histA = null;
    this.histB = null;
    this.histValid = false;

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
    }
    return { float: this._palFloat, uniform: this._palUniform, size: Math.min(colors.length, MAX_PALETTE) };
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

    // Smoothness (GPU only): dither on a finer grid and box-average down. Shrink
    // the OUTPUT grid so the supersampled source (ss*w x ss*h) stays in budget.
    let ss = 1;
    if (gpu && p.smoothness > 0) {
      ss = p.smoothness > 0.6 ? 3 : 2;
      const outCap = Math.min(maxPixels, Math.floor(SS_SOURCE_BUDGET / (ss * ss)));
      if (w * h > outCap) {
        const k = Math.sqrt(outCap / (w * h));
        w = Math.max(1, Math.floor(w * k));
        h = Math.max(1, Math.floor(h * k));
      }
    }

    // The work canvas holds the source at the (super)sampled resolution; the
    // CPU path never supersamples (ss stays 1), so it still gets w x h.
    const work = this.#drawWork(source, w * ss, h * ss, p);

    if (gpu) return this.#renderGPU(work, w, h, ss, p, algo, pal, effSat);
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

  // Forget temporal history (call on source switch / seek so a new clip
  // doesn't ghost-blend with the previous one's last frame).
  resetTemporal() { this.histValid = false; }

  // Motion-gated EMA on the raw downsampled frame. Renders the stabilized frame
  // into a ping-pong FBO and returns its texture for the dither pass to consume.
  #temporalPass(w, h, p) {
    const gl = this.gl;
    if (!this.histA || this.histA.w !== w || this.histA.h !== h) {
      if (this.histA) { gl.deleteTexture(this.histA.tex); gl.deleteFramebuffer(this.histA.fbo); }
      if (this.histB) { gl.deleteTexture(this.histB.tex); gl.deleteFramebuffer(this.histB.fbo); }
      this.histA = createFBO(gl, w, h);
      this.histB = createFBO(gl, w, h);
      this.histValid = false;
    }
    gl.useProgram(this.temporalProgram);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.histB.fbo);
    gl.viewport(0, 0, w, h);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.srcTex);
    gl.uniform1i(this.tu.u_src, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.histA.tex);
    gl.uniform1i(this.tu.u_hist, 1);
    gl.uniform1f(this.tu.u_historyWeight, Math.max(0, Math.min(1, p.temporal)) * 0.8);
    gl.uniform1f(this.tu.u_motionLo, 0.03);
    gl.uniform1f(this.tu.u_motionHi, 0.13);
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

  #renderGPU(work, w, h, ss, p, algo, pal, effSat) {
    const gl = this.gl;
    const canvas = this.glCanvas;

    gl.activeTexture(gl.TEXTURE0);
    uploadTexture(gl, this.srcTex, work);

    // Temporal smoothing pre-pass (live video/webcam only) -> stabilized source.
    let srcTexForDither = this.srcTex;
    const temporalOn = this._allowAsync && !p.staticSource
      && (p.temporal || 0) > 0 && this.temporalProgram;
    if (temporalOn) srcTexForDither = this.#temporalPass(work.width, work.height, p);
    else this.histValid = false; // drop stale history when temporal is off

    // canvas is the OUTPUT (present) resolution; the source may be finer (ss>1)
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    gl.viewport(0, 0, w, h);
    gl.useProgram(this.program);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, srcTexForDither);
    gl.uniform1i(this.u.u_src, 0);
    gl.uniform2f(this.u.u_outSize, w, h);
    gl.uniform1i(this.u.u_ss, ss);
    gl.uniform1f(this.u.u_smoothness, p.smoothness || 0);

    const mat = this.matrixTextures[algo.matrix] || this.matrixTextures.bayer4;
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, mat.tex);
    gl.uniform1i(this.u.u_threshold, 1);
    gl.uniform1f(this.u.u_thresholdSize, mat.size);

    gl.uniform2f(this.u.u_srcSize, work.width, work.height);
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
        // settings signature — a change forces one synchronous, correct frame
        const pf = pal.float;
        let ph = pf.length;
        for (let i = 0; i < pf.length; i++) ph = (Math.imul(ph, 31) + pf[i]) | 0;
        const sig = `${algo.id}|${opts.strength}|${opts.serpentine}|${opts.bias}|${w}x${h}|${ph}`;
        const committed = this.cpu.render(img, w, h, pf, algo.id, opts, sig, ctx, this._contentNew);
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
      cellSize: a.cellSize,
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
    });
  }

  #renderCells(source, srcW, srcH, p, maxPixels = Infinity) {
    const c = p.cells;
    const cell = Math.max(4, c.size);
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
    const W = cols * cell;
    const H = rows * cell;
    if (this.cellCanvas.width !== W || this.cellCanvas.height !== H) {
      this.cellCanvas.width = W;
      this.cellCanvas.height = H;
    }
    const eff = CELL_EFFECTS[p.mode] || CELL_EFFECTS.dots;
    eff.render(this.cellCtx, { cols, rows, data: img.data }, {
      cell,
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
