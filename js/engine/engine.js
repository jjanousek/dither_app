// Engine: routes a source frame through the right pipeline
// (GPU uber-shader | CPU error diffusion | ASCII renderer) based on params.

import { createGL, compileProgram, QUAD_VS, createTexture, uploadTexture, uploadR8 } from './gl.js';
import { DITHER_FS, MAX_PALETTE } from './shaders.js';
import { applyAdjustments, errorDiffusion, orderedDither, quantize, MATRICES, DIFFUSION_KERNELS } from './cpu.js';
import { getBlueNoise } from './bluenoise.js';
import { AsciiRenderer, fontSpec } from './ascii.js';
import { CELL_EFFECTS } from '../effects/cells.js';
import { paletteToFloat, paletteToUniform } from '../palettes.js';

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
  }

  #initGL() {
    const gl = this.gl;
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
      'u_src', 'u_threshold', 'u_srcSize', 'u_thresholdSize', 'u_mode',
      'u_brightness', 'u_contrast', 'u_gamma', 'u_saturation', 'u_strength',
      'u_bias', 'u_invert', 'u_grayscale', 'u_palette', 'u_paletteSize',
      'u_halftoneScale', 'u_halftoneAngle', 'u_matOffset', 'u_seed',
    ]) {
      this.u[name] = gl.getUniformLocation(this.program, name);
    }
    this.srcTex = createTexture(gl);
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
  render(source, srcW, srcH, p, maxPixels = Infinity) {
    if (!srcW || !srcH) return null;

    if (p.mode === 'ascii') return this.#renderAscii(source, srcW, srcH, p, maxPixels);
    if (p.mode !== 'dither') return this.#renderCells(source, srcW, srcH, p, maxPixels);

    let w = Math.max(1, Math.round(srcW / p.pixelSize));
    let h = Math.max(1, Math.round(srcH / p.pixelSize));
    if (w * h > maxPixels) {
      const k = Math.sqrt(maxPixels / (w * h));
      w = Math.max(1, Math.floor(w * k));
      h = Math.max(1, Math.floor(h * k));
    }

    const work = this.#drawWork(source, w, h, p);

    const algo = getAlgorithm(p.algorithm);
    const pal = this.#palettes(p.colors);
    const effSat = p.grayscale ? 0 : p.saturation;

    if (algo.type === 'gpu' && this.gl) {
      return this.#renderGPU(work, w, h, p, algo, pal, effSat);
    }
    return this.#renderCPU(work, w, h, p, algo, pal, effSat);
  }

  // Downsample the source into the shared work canvas, applying the CSS-filter
  // adjustments and the canvas-space animation styles (sweep / wave).
  #drawWork(source, w, h, p) {
    const work = this.work;
    if (work.width !== w || work.height !== h) {
      work.width = w;
      work.height = h;
    }
    const ctx = this.workCtx;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.clearRect(0, 0, w, h); // transparent sources must not ghost old frames
    ctx.filter = this.#filterString(p);
    ctx.drawImage(source, 0, 0, w, h);
    ctx.filter = 'none';
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
      ctx.globalCompositeOperation = 'overlay';
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
      ctx.clearRect(0, 0, w, h);
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

  #renderGPU(work, w, h, p, algo, pal, effSat) {
    const gl = this.gl;
    const canvas = this.glCanvas;
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    gl.viewport(0, 0, w, h);
    gl.useProgram(this.program);

    gl.activeTexture(gl.TEXTURE0);
    uploadTexture(gl, this.srcTex, work);
    gl.uniform1i(this.u.u_src, 0);

    const mat = this.matrixTextures[algo.matrix] || this.matrixTextures.bayer4;
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, mat.tex);
    gl.uniform1i(this.u.u_threshold, 1);
    gl.uniform1f(this.u.u_thresholdSize, mat.size);

    gl.uniform2f(this.u.u_srcSize, w, h);
    gl.uniform1i(this.u.u_mode, algo.mode);
    gl.uniform1f(this.u.u_brightness, this.#animBrightness(p));
    gl.uniform1f(this.u.u_contrast, p.contrast);
    gl.uniform1f(this.u.u_gamma, p.gamma);
    gl.uniform1f(this.u.u_saturation, effSat);
    gl.uniform1f(this.u.u_strength, p.ditherStrength);
    gl.uniform1f(this.u.u_bias, p.threshold - 0.5);
    gl.uniform1i(this.u.u_invert, p.invert ? 1 : 0);
    gl.uniform1i(this.u.u_grayscale, 0);
    gl.uniform3fv(this.u.u_palette, pal.uniform);
    gl.uniform1i(this.u.u_paletteSize, pal.size);
    gl.uniform1f(this.u.u_halftoneScale, p.halftoneScale);
    gl.uniform1f(this.u.u_halftoneAngle, (p.halftoneAngle * Math.PI) / 180);

    const tile = algo.mode >= 3 ? Math.max(2, p.halftoneScale) : mat.size;
    const drift = this.#matAnim(p, tile);
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
      errorDiffusion(img, pal.float, algo.id, {
        strength: p.ditherStrength,
        serpentine: p.serpentine,
        bias,
      });
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
    } else {
      quantize(img, pal.float, bias);
    }
    ctx.putImageData(img, 0, 0);
    return work;
  }

  #renderAscii(source, srcW, srcH, p, maxPixels = Infinity) {
    const a = p.ascii;
    // Renderer decides sub-cell sampling density:
    // ramp 1x1, shape 4x8 (glyph matching), quadrant 2x2, braille 2x4.
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
    if (cols * rows * cell * cell > maxPixels * 4) {
      // cap the OUTPUT canvas area (cells draw at cell-size resolution)
      const k = Math.sqrt((maxPixels * 4) / (cols * rows * cell * cell));
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
