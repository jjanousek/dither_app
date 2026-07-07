// ASCII art engine. Four renderers over a sampled luminance/color grid:
//
//  ramp      1 sample/cell — coverage-calibrated character ramps with optional
//            cell-level error diffusion (libcaca-style) and Sobel edge glyphs
//  shape     8x8 samples/cell — chafa-style structural glyph matching:
//            binarize cell -> Hamming-prefilter glyph bitmaps -> refine with
//            per-pen mean colors and squared RGB error
//  quadrant  2x2 samples/cell — 16 block chars, two colors per cell via
//            luminance-gap splitting (full-color mosaic)
//  braille   2x4 samples/cell — U+2800 dots with Floyd–Steinberg / Bayer
//            dithering of the dot bitmap
//
// All renderers record lastText (plain) and lastGrid (per-cell char + colors)
// for TXT / ANSI / HTML export.

export const RAMPS = {
  classic: { name: 'Classic 10', chars: '@%#*+=-:. ' },
  detailed: {
    name: 'Detailed 70',
    chars: "$@B%8&WM#*oahkbdpqwmZO0QLCJUYXzcvunxrjft/\\|()1{}[]?-_+~<>i!lI;:,\"^`'. ",
  },
  jp2a: { name: 'jp2a', chars: 'MWNXK0Okxodlc:;,.   ' },
  acerola: { name: 'Acerola', chars: '█@?0Poc;. ' },
  blocks: { name: 'Blocks', chars: '█▓▒░ ' },
  minimal: { name: 'Minimal', chars: '#+-. ' },
  numeric: { name: 'Numeric', chars: '9876543210 ' },
  hacker: { name: 'Hacker', chars: '@#X0x*+. ' },
  retro: { name: 'Retro', chars: 'X3210|!*;:,. ' },
  blocky: { name: 'Blocky', chars: '█■▓▪▒□░▫ ' },
  dots: { name: 'Dots', chars: '⣿⣷⣧⣇⡇⡆⡄⡀ ' },
  binary: { name: 'Binary', chars: '10 ' },
  japanese: { name: 'Japanese', chars: 'ネホヌセチサシソトノ・ ' },
  slashes: { name: 'Slashes', chars: '▓╬╫┼/\\-· ' },
  custom: { name: 'Custom…', chars: '@#+-. ' },
};

export const FONTS = {
  menlo: { name: 'Menlo', family: "Menlo, 'DejaVu Sans Mono', monospace" },
  sfmono: { name: 'SF Mono', family: "'SF Mono', ui-monospace, Menlo, monospace" },
  monaco: { name: 'Monaco', family: 'Monaco, Menlo, monospace' },
  courier: { name: 'Courier', family: "'Courier New', Courier, monospace" },
};

export function fontSpec(a) {
  const f = FONTS[a.fontId] || FONTS.menlo;
  return { family: f.family, bold: !!a.bold };
}

const fontString = (font, px) => `${font.bold ? '700 ' : ''}${px}px ${font.family}`;

// printable ASCII for structural matching; 'blocks' adds unicode structure
const SHAPE_ASCII = (() => {
  let s = '';
  for (let c = 32; c <= 126; c++) s += String.fromCharCode(c);
  return s;
})();
const SHAPE_BLOCKS = SHAPE_ASCII + '░▒▓█▀▄▌▐▘▝▖▗▚▞─│┌┐└┘┼╱╲●◆·';

// quadrant table indexed by bits TL=1, TR=2, BL=4, BR=8
const QUAD = [' ', '▘', '▝', '▀', '▖', '▌', '▞', '▛', '▗', '▚', '▐', '▜', '▄', '▙', '▟', '█'];

// braille dot bit layout: [col][row] (Unicode standard)
const BRAILLE_BITS = [[0x01, 0x02, 0x04, 0x40], [0x08, 0x10, 0x20, 0x80]];

// by edge orientation bin; canvas y points down
const EDGE_CHARS = ['-', '\\', '|', '/'];

const BAYER4 = [
  [0, 8, 2, 10], [12, 4, 14, 6], [3, 11, 1, 9], [15, 7, 13, 5],
];

const LUMA = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

const popcnt32 = (x) => {
  x -= (x >> 1) & 0x55555555;
  x = (x & 0x33333333) + ((x >> 2) & 0x33333333);
  x = (x + (x >> 4)) & 0x0f0f0f0f;
  return (x * 0x01010101) >> 24;
};

export class AsciiRenderer {
  constructor() {
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d');
    this.lastText = '';
    this.lastGrid = null; // rows of [char, fgRGB|null, bgRGB|null]
    this._atlasCache = new Map();
    this._rampCache = new Map();
  }

  // Drop cached glyph metrics/atlases (fonts loaded, etc.).
  clearCaches() {
    this._atlasCache.clear();
    this._rampCache.clear();
  }

  // Widest advance of the glyphs, so the sample grid matches the glyph grid.
  measure(font, cellH, chars = 'M') {
    this.ctx.font = fontString(font, cellH);
    let min = Infinity;
    let max = 1;
    for (const ch of chars) {
      const w = this.ctx.measureText(ch).width || 0;
      if (w <= 0) continue;
      if (w < min) min = w;
      if (w > max) max = w;
    }
    this.lastUniform = min === Infinity || max - min < 0.5;
    return Math.max(1, max);
  }

  render(imageData, opts) {
    const renderer = opts.renderer || 'ramp';
    if (renderer === 'shape') return this.#renderShape(imageData, opts);
    if (renderer === 'quadrant') return this.#renderQuadrant(imageData, opts);
    if (renderer === 'braille') return this.#renderBraille(imageData, opts);
    return this.#renderRamp(imageData, opts);
  }

  // -------------------------------------------------------------------------
  // shared helpers
  // -------------------------------------------------------------------------

  #lumGrid(data, n) {
    const lum = new Float32Array(n);
    for (let i = 0, j = 0; j < n; i += 4, j++) {
      lum[j] = LUMA(data[i], data[i + 1], data[i + 2]) / 255;
    }
    return lum;
  }

  // Percentile contrast stretch (chafa-style preprocess, 2% per end).
  #autoContrast(lum) {
    const hist = new Uint32Array(256);
    for (let i = 0; i < lum.length; i++) hist[Math.min(255, (lum[i] * 255) | 0)]++;
    const clip = lum.length * 0.02;
    let lo = 0, hi = 255, acc = 0;
    for (; lo < 255 && acc + hist[lo] < clip; lo++) acc += hist[lo];
    acc = 0;
    for (; hi > 0 && acc + hist[hi] < clip; hi--) acc += hist[hi];
    const l = lo / 255, h = hi / 255;
    if (h - l < 0.05) return;
    const k = 1 / (h - l);
    for (let i = 0; i < lum.length; i++) {
      lum[i] = Math.min(1, Math.max(0, (lum[i] - l) * k));
    }
  }

  #resize(w, h) {
    w = Math.max(1, Math.round(w));
    h = Math.max(1, Math.round(h));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
  }

  #beginDraw(cols, rows, cellW, cellH, font, bg) {
    this.#resize(cols * cellW, rows * cellH);
    const ctx = this.ctx;
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.font = fontString(font, cellH);
    ctx.textBaseline = 'top';
    return ctx;
  }

  #finish(lines, grid) {
    this.lastText = lines.join('\n');
    this.lastGrid = grid;
    return this.canvas;
  }

  // Glyph atlas: 8x8 coverage bitmaps + ink coverage, rendered with the
  // active font so structural matching sees what will actually be drawn.
  #atlas(font, chars) {
    const key = `${font.family}|${font.bold}|${chars}`;
    let atlas = this._atlasCache.get(key);
    if (atlas) return atlas;

    const glyphs = [...chars];
    const H = 64;
    const c = document.createElement('canvas');
    const cx = c.getContext('2d', { willReadFrequently: true });
    cx.font = fontString(font, H);
    // slot pitch = widest advance in the set, so wide glyphs (blocks, CJK)
    // don't bleed into the neighbour's coverage sample
    let maxW = cx.measureText('M').width;
    for (const g of glyphs) maxW = Math.max(maxW, cx.measureText(g).width || 0);
    const adv = Math.max(4, Math.ceil(maxW));
    c.width = adv * glyphs.length;
    c.height = H;
    cx.font = fontString(font, H);
    cx.textBaseline = 'top';
    cx.fillStyle = '#fff';
    glyphs.forEach((g, i) => cx.fillText(g, i * adv, 0));
    const img = cx.getImageData(0, 0, c.width, H).data;

    const n = glyphs.length;
    const bits0 = new Uint32Array(n); // rows 0..3
    const bits1 = new Uint32Array(n); // rows 4..7
    const cov = new Float32Array(n * 64);
    const coverage = new Float32Array(n); // mean ink 0..1
    const pop = new Uint8Array(n);
    // refine-loop accelerators: penMask[k] = (cov[k] > 0.45) as 0/1 (avoids the
    // per-pixel float compare), and onList[g] = the ascending "on" pixel
    // indices so the mean pass sums one pen side and derives the other.
    const penMask = new Uint8Array(n * 64);
    const onList = new Array(n);

    const bw = adv / 8;
    const bh = H / 8;
    for (let gi = 0; gi < n; gi++) {
      let ink = 0;
      const on = [];
      for (let sy = 0; sy < 8; sy++) {
        for (let sx = 0; sx < 8; sx++) {
          // box-average the glyph alpha in this subcell
          let sum = 0, cnt = 0;
          const x0 = Math.floor(gi * adv + sx * bw);
          const x1 = Math.min(c.width, Math.ceil(gi * adv + (sx + 1) * bw));
          const y0 = Math.floor(sy * bh);
          const y1 = Math.min(H, Math.ceil((sy + 1) * bh));
          for (let y = y0; y < y1; y++) {
            for (let x = x0; x < x1; x++) {
              sum += img[(y * c.width + x) * 4 + 3];
              cnt++;
            }
          }
          const v = cnt ? sum / (cnt * 255) : 0;
          const idx = sy * 8 + sx;
          cov[gi * 64 + idx] = v;
          ink += v;
          if (v > 0.45) {
            penMask[gi * 64 + idx] = 1;
            on.push(idx);
            if (idx < 32) bits0[gi] |= (1 << idx) >>> 0;
            else bits1[gi] |= (1 << (idx - 32)) >>> 0;
          }
        }
      }
      coverage[gi] = ink / 64;
      pop[gi] = popcnt32(bits0[gi]) + popcnt32(bits1[gi]);
      onList[gi] = Uint8Array.from(on);
    }
    atlas = { glyphs, bits0, bits1, cov, coverage, pop, penMask, onList };
    this._atlasCache.set(key, atlas);
    return atlas;
  }

  // Ramp calibration: measure real ink coverage of the ramp glyphs and sort
  // dark->light, normalized to [0,1].
  #rampLevels(font, chars) {
    const key = `${font.family}|${font.bold}|${chars}`;
    let levels = this._rampCache.get(key);
    if (levels) return levels;
    const atlas = this.#atlas(font, chars);
    const entries = atlas.glyphs.map((g, i) => ({ ch: g, cov: atlas.coverage[i] }));
    entries.sort((a, b) => a.cov - b.cov);
    const min = entries[0].cov;
    const max = entries[entries.length - 1].cov;
    const span = Math.max(1e-4, max - min);
    levels = entries.map((e) => ({ ch: e.ch, v: (e.cov - min) / span }));
    this._rampCache.set(key, levels);
    return levels;
  }

  // nearest calibrated level by binary search
  #pickLevel(levels, v) {
    let lo = 0, hi = levels.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (levels[mid].v < v) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0 && Math.abs(levels[lo - 1].v - v) < Math.abs(levels[lo].v - v)) lo--;
    return levels[lo];
  }

  // 1-bit dithering of a luminance grid against a threshold.
  #ditherBits(lum, w, h, threshold, mode) {
    const bits = new Uint8Array(w * h);
    if (mode === 'floyd') {
      const buf = Float32Array.from(lum);
      for (let y = 0; y < h; y++) {
        const rev = (y & 1) === 1;
        for (let i = 0; i < w; i++) {
          const x = rev ? w - 1 - i : i;
          const j = y * w + x;
          const on = buf[j] > threshold ? 1 : 0;
          bits[j] = on;
          const err = buf[j] - (on ? 1 : 0);
          const dx = rev ? -1 : 1;
          if (x + dx >= 0 && x + dx < w) buf[j + dx] += err * (7 / 16);
          if (y + 1 < h) {
            if (x - dx >= 0 && x - dx < w) buf[j + w - dx] += err * (3 / 16);
            buf[j + w] += err * (5 / 16);
            if (x + dx >= 0 && x + dx < w) buf[j + w + dx] += err * (1 / 16);
          }
        }
      }
    } else if (mode === 'bayer') {
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const t = threshold + ((BAYER4[y & 3][x & 3] + 0.5) / 16 - 0.5) * 0.9;
          bits[y * w + x] = lum[y * w + x] > t ? 1 : 0;
        }
      }
    } else {
      for (let i = 0; i < lum.length; i++) bits[i] = lum[i] > threshold ? 1 : 0;
    }
    return bits;
  }

  #sobel(lum, cols, rows) {
    const mag = new Float32Array(cols * rows);
    const dir = new Uint8Array(cols * rows);
    for (let y = 1; y < rows - 1; y++) {
      for (let x = 1; x < cols - 1; x++) {
        const i = y * cols + x;
        const tl = lum[i - cols - 1], t = lum[i - cols], tr = lum[i - cols + 1];
        const l = lum[i - 1], r = lum[i + 1];
        const bl = lum[i + cols - 1], b = lum[i + cols], br = lum[i + cols + 1];
        const gx = -tl - 2 * l - bl + tr + 2 * r + br;
        const gy = -tl - 2 * t - tr + bl + 2 * b + br;
        const m = Math.hypot(gx, gy) / 4;
        mag[i] = m;
        if (m > 0) {
          let a = Math.atan2(gy, gx) + Math.PI / 2;
          a = ((a % Math.PI) + Math.PI) % Math.PI;
          dir[i] = Math.round(a / (Math.PI / 4)) % 4;
        }
      }
    }
    return { mag, dir };
  }

  // -------------------------------------------------------------------------
  // ramp renderer
  // -------------------------------------------------------------------------
  #renderRamp(imageData, opts) {
    const {
      chars, cellSize, font, colorMode, fg, bg, invertRamp,
      dither, edgeStrength, autoContrast,
    } = opts;
    const { width: cols, height: rows, data } = imageData;

    const lum = this.#lumGrid(data, cols * rows);
    if (autoContrast) this.#autoContrast(lum);
    if (invertRamp) for (let i = 0; i < lum.length; i++) lum[i] = 1 - lum[i];

    const levels = this.#rampLevels(font, chars);
    const edgeMap = edgeStrength > 0 ? this.#sobel(lum, cols, rows) : null;
    const edgeThresh = 0.65 - edgeStrength * 0.5;

    // pick chars (with optional cell-level error diffusion)
    const picks = new Array(cols * rows);
    if (dither === 'floyd') {
      const buf = Float32Array.from(lum);
      for (let y = 0; y < rows; y++) {
        const rev = (y & 1) === 1;
        for (let i = 0; i < cols; i++) {
          const x = rev ? cols - 1 - i : i;
          const j = y * cols + x;
          const v = Math.min(1, Math.max(0, buf[j]));
          const lvl = this.#pickLevel(levels, v);
          picks[j] = lvl.ch;
          const err = v - lvl.v;
          const dx = rev ? -1 : 1;
          if (x + dx >= 0 && x + dx < cols) buf[j + dx] += err * (7 / 16);
          if (y + 1 < rows) {
            if (x - dx >= 0 && x - dx < cols) buf[j + cols - dx] += err * (3 / 16);
            buf[j + cols] += err * (5 / 16);
            if (x + dx >= 0 && x + dx < cols) buf[j + cols + dx] += err * (1 / 16);
          }
        }
      }
    } else if (dither === 'bayer') {
      const spread = levels.length > 1 ? 1 / (levels.length - 1) : 0.5;
      for (let j = 0; j < picks.length; j++) {
        const x = j % cols, y = (j / cols) | 0;
        const v = lum[j] + ((BAYER4[y & 3][x & 3] + 0.5) / 16 - 0.5) * spread * 1.5;
        picks[j] = this.#pickLevel(levels, Math.min(1, Math.max(0, v))).ch;
      }
    } else {
      for (let j = 0; j < picks.length; j++) picks[j] = this.#pickLevel(levels, lum[j]).ch;
    }
    if (edgeMap) {
      for (let j = 0; j < picks.length; j++) {
        if (edgeMap.mag[j] > edgeThresh) picks[j] = EDGE_CHARS[edgeMap.dir[j]];
      }
    }

    // draw
    const cellH = cellSize;
    const cellW = this.measure(font, cellH, chars);
    const uniform = this.lastUniform;
    const ctx = this.#beginDraw(cols, rows, cellW, cellH, font, bg);

    const lines = [];
    const grid = [];
    if (colorMode === 'mono' && uniform) {
      ctx.fillStyle = fg;
      const fgInt = hexToInt(fg);
      for (let y = 0; y < rows; y++) {
        let line = '';
        const grow = [];
        for (let x = 0; x < cols; x++) {
          const ch = picks[y * cols + x];
          line += ch;
          grow.push([ch, fgInt, null]);
        }
        lines.push(line);
        grid.push(grow);
        ctx.fillText(line, 0, y * cellH);
      }
    } else {
      const fgInt = hexToInt(fg);
      for (let y = 0; y < rows; y++) {
        let line = '';
        const grow = [];
        for (let x = 0; x < cols; x++) {
          const j = y * cols + x;
          const i = j * 4;
          const ch = picks[j];
          line += ch;
          if (colorMode === 'bg') {
            const rgb = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
            ctx.fillStyle = intToCss(rgb);
            ctx.fillRect(x * cellW, y * cellH, Math.ceil(cellW), cellH);
            // ink contrast comes from the RAW cell color, not the
            // invertRamp/autoContrast-mutated lum grid
            const ink = LUMA(data[i], data[i + 1], data[i + 2]) / 255 > 0.5 ? 0x000000 : 0xffffff;
            ctx.fillStyle = intToCss(ink);
            ctx.fillText(ch, x * cellW, y * cellH);
            grow.push([ch, ink, rgb]);
          } else if (colorMode === 'fg') {
            const rgb = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
            if (ch !== ' ') {
              ctx.fillStyle = intToCss(rgb);
              ctx.fillText(ch, x * cellW, y * cellH);
            }
            grow.push([ch, rgb, null]);
          } else {
            ctx.fillStyle = fg;
            if (ch !== ' ') ctx.fillText(ch, x * cellW, y * cellH);
            grow.push([ch, fgInt, null]);
          }
        }
        lines.push(line);
        grid.push(grow);
      }
    }
    return this.#finish(lines, grid);
  }

  // -------------------------------------------------------------------------
  // shape renderer (chafa-style structural matching, 8x8 per cell)
  // -------------------------------------------------------------------------
  #renderShape(imageData, opts) {
    const {
      cellSize, font, colorMode, fg, bg, invertRamp, autoContrast, shapeSet,
    } = opts;
    const W = imageData.width;   // cols * 8
    const H = imageData.height;  // rows * 8
    const cols = Math.max(1, W >> 3);
    const rows = Math.max(1, H >> 3);
    const data = imageData.data;

    const atlas = this.#atlas(font, shapeSet === 'blocks' ? SHAPE_BLOCKS : SHAPE_ASCII);
    const nGlyphs = atlas.glyphs.length;

    const lumAll = this.#lumGrid(data, W * H);
    if (autoContrast) this.#autoContrast(lumAll);

    const cellH = cellSize;
    const cellW = this.measure(font, cellH, 'M');
    const ctx = this.#beginDraw(cols, rows, cellW, cellH, font, bg);

    const fgInt = hexToInt(fg);
    const bgInt = hexToInt(bg);
    const K = 8; // candidates refined after Hamming prefilter
    const lines = [];
    const grid = [];

    // scratch
    const px = new Float32Array(64 * 3);
    const plum = new Float32Array(64);
    const candIdx = new Int16Array(K);
    const candHam = new Uint8Array(K);
    const candInv = new Uint8Array(K);

    for (let cy = 0; cy < rows; cy++) {
      let line = '';
      const grow = [];
      for (let cx = 0; cx < cols; cx++) {
        // gather 64 pixels
        let minL = 1, maxL = 0, minI = 0, maxI = 0, sumL = 0;
        for (let sy = 0; sy < 8; sy++) {
          for (let sx = 0; sx < 8; sx++) {
            const si = (cy * 8 + sy) * W + cx * 8 + sx;
            const di = si * 4;
            const k = sy * 8 + sx;
            px[k * 3] = data[di];
            px[k * 3 + 1] = data[di + 1];
            px[k * 3 + 2] = data[di + 2];
            const l = lumAll[si];
            plum[k] = l;
            sumL += l;
            if (l < minL) { minL = l; minI = k; }
            if (l > maxL) { maxL = l; maxI = k; }
          }
        }

        let ch, cellFg, cellBg;
        if (maxL - minL < 0.06) {
          // flat cell: fill by coverage (chafa's popcount fill)
          const v = invertRamp ? 1 - sumL / 64 : sumL / 64;
          let best = 0, bd = Infinity;
          for (let g = 0; g < nGlyphs; g++) {
            const d = Math.abs(atlas.coverage[g] - v);
            if (d < bd) { bd = d; best = g; }
          }
          ch = atlas.glyphs[best];
          const mean = cellMean(px, null, 0);
          cellFg = colorMode === 'mono' ? fgInt : mean;
          cellBg = colorMode === 'bg' ? mean : null;
        } else {
          // binarize against the contrasting pair (nearer of min/max pixel).
          // df < db expands to a linear test in exact integer arithmetic (all
          // channels are integer bytes): df - db = 2·dot + fSq - bSq, where
          // dot = Σ r·(br-fr). So df < db  ⟺  2·dot < bSq - fSq — one dot
          // product per pixel instead of two squared distances, bit-identical.
          let b0 = 0, b1 = 0;
          const fr = px[maxI * 3], fgc = px[maxI * 3 + 1], fb = px[maxI * 3 + 2];
          const br = px[minI * 3], bgc = px[minI * 3 + 1], bb = px[minI * 3 + 2];
          const cr = br - fr, cg = bgc - fgc, cb = bb - fb;
          const thresh = (br * br + bgc * bgc + bb * bb) - (fr * fr + fgc * fgc + fb * fb);
          for (let k = 0; k < 64; k++) {
            if (2 * (px[k * 3] * cr + px[k * 3 + 1] * cg + px[k * 3 + 2] * cb) < thresh) {
              if (k < 32) b0 |= (1 << k) >>> 0;
              else b1 |= (1 << (k - 32)) >>> 0;
            }
          }
          if (invertRamp) { b0 = ~b0 >>> 0; b1 = ~b1 >>> 0; }

          // Hamming prefilter, keeping top-K (with inverted matches)
          candHam.fill(65);
          for (let g = 0; g < nGlyphs; g++) {
            const hd = popcnt32((b0 ^ atlas.bits0[g]) >>> 0) + popcnt32((b1 ^ atlas.bits1[g]) >>> 0);
            insertCand(candIdx, candHam, candInv, g, hd, 0);
            if (colorMode !== 'mono') insertCand(candIdx, candHam, candInv, g, 64 - hd, 1);
          }

          // refine: per-pen mean colors, squared RGB error over 64 pixels.
          // Cell RGB totals once so each candidate sums only the "on" pen and
          // derives the "off" side (total - on, exact for integer bytes); the
          // error loop early-exits once its running sum can't beat the best.
          // Both are byte-identical to the naive double loop.
          let tr = 0, tg = 0, tb = 0;
          for (let k = 0; k < 64; k++) { tr += px[k * 3]; tg += px[k * 3 + 1]; tb += px[k * 3 + 2]; }
          const penMask = atlas.penMask;
          let bestErr = Infinity, bestG = candIdx[0], bestInvF = candInv[0];
          let bestFg = 0, bestBg = 0;
          for (let c = 0; c < K; c++) {
            if (candHam[c] > 64) continue;
            const g = candIdx[c];
            const inv = candInv[c];
            const covBase = g * 64;
            const onL = atlas.onList[g], onN = onL.length;
            let onR = 0, onG = 0, onB = 0;
            for (let i = 0; i < onN; i++) { const k = onL[i]; onR += px[k * 3]; onG += px[k * 3 + 1]; onB += px[k * 3 + 2]; }
            let fr2, fg2, fb2, fn, br2, bg2, bb2, bn;
            if (inv === 0) {
              fr2 = onR; fg2 = onG; fb2 = onB; fn = onN;
              br2 = tr - onR; bg2 = tg - onG; bb2 = tb - onB; bn = 64 - onN;
            } else {
              fr2 = tr - onR; fg2 = tg - onG; fb2 = tb - onB; fn = 64 - onN;
              br2 = onR; bg2 = onG; bb2 = onB; bn = onN;
            }
            const fR = fn ? fr2 / fn : br2 / Math.max(1, bn);
            const fG = fn ? fg2 / fn : bg2 / Math.max(1, bn);
            const fB = fn ? fb2 / fn : bb2 / Math.max(1, bn);
            const bR = bn ? br2 / bn : fR, bG = bn ? bg2 / bn : fG, bB = bn ? bb2 / bn : fB;
            let err = 0;
            for (let k = 0; k < 64; k++) {
              const r = px[k * 3], gg = px[k * 3 + 1], b = px[k * 3 + 2];
              err += (penMask[covBase + k] ^ inv)
                ? (r - fR) ** 2 + (gg - fG) ** 2 + (b - fB) ** 2
                : (r - bR) ** 2 + (gg - bG) ** 2 + (b - bB) ** 2;
              if (err >= bestErr) break;
            }
            if (err < bestErr) {
              bestErr = err;
              bestG = g;
              bestInvF = inv;
              bestFg = (Math.round(fR) << 16) | (Math.round(fG) << 8) | Math.round(fB);
              bestBg = (Math.round(bR) << 16) | (Math.round(bG) << 8) | Math.round(bB);
            }
          }
          ch = atlas.glyphs[bestG];
          if (colorMode === 'mono') {
            cellFg = fgInt;
            cellBg = null;
          } else if (colorMode === 'fg') {
            cellFg = bestInvF ? bestBg : bestFg;
            cellBg = null;
          } else {
            cellFg = bestInvF ? bestBg : bestFg;
            cellBg = bestInvF ? bestFg : bestBg;
          }
        }

        line += ch;
        grow.push([ch, cellFg, cellBg]);
        if (cellBg !== null && cellBg !== undefined) {
          ctx.fillStyle = intToCss(cellBg);
          ctx.fillRect(cx * cellW, cy * cellH, Math.ceil(cellW), cellH);
        }
        if (ch !== ' ') {
          ctx.fillStyle = intToCss(cellFg);
          ctx.fillText(ch, cx * cellW, cy * cellH);
        }
      }
      lines.push(line);
      grid.push(grow);
    }
    return this.#finish(lines, grid);
  }

  // -------------------------------------------------------------------------
  // quadrant renderer (2x2 blocks, two colors per cell)
  // -------------------------------------------------------------------------
  #renderQuadrant(imageData, opts) {
    const {
      cellSize, font, colorMode, fg, bg, invertRamp,
      dither, dotThreshold, autoContrast,
    } = opts;
    const W = imageData.width;  // cols * 2
    const H = imageData.height; // rows * 2
    const cols = Math.max(1, W >> 1);
    const rows = Math.max(1, H >> 1);
    const data = imageData.data;

    const lum = this.#lumGrid(data, W * H);
    if (autoContrast) this.#autoContrast(lum);
    if (invertRamp) for (let i = 0; i < lum.length; i++) lum[i] = 1 - lum[i];

    const cellH = cellSize;
    const cellW = this.measure(font, cellH, '█');
    const ctx = this.#beginDraw(cols, rows, cellW, cellH, font, bg);
    const fgInt = hexToInt(fg);

    // mono / fg modes: dot bitmap from dithered luminance
    const bits = colorMode === 'bg' ? null : this.#ditherBits(lum, W, H, dotThreshold, dither);

    const lines = [];
    const grid = [];
    const SUB = [[0, 0, 1], [1, 0, 2], [0, 1, 4], [1, 1, 8]]; // dx, dy, bit
    for (let cy = 0; cy < rows; cy++) {
      let line = '';
      const grow = [];
      for (let cx = 0; cx < cols; cx++) {
        let ch, cellFg = fgInt, cellBg = null;
        if (colorMode === 'bg') {
          // luminance-gap split into two colors
          const subs = SUB.map(([dx, dy, bit]) => {
            const si = (cy * 2 + dy) * W + cx * 2 + dx;
            const di = si * 4;
            return { bit, l: lum[si], r: data[di], g: data[di + 1], b: data[di + 2] };
          }).sort((a, b) => a.l - b.l);
          let gap = 0, cut = 0;
          for (let i = 0; i < 3; i++) {
            const d = subs[i + 1].l - subs[i].l;
            if (d > gap) { gap = d; cut = i + 1; }
          }
          if (gap < 0.06) {
            // flat: solid block in the mean color
            const mr = subs.reduce((s, q) => s + q.r, 0) / 4;
            const mg = subs.reduce((s, q) => s + q.g, 0) / 4;
            const mb = subs.reduce((s, q) => s + q.b, 0) / 4;
            ch = '█';
            cellFg = rgbInt(mr, mg, mb);
            cellBg = cellFg;
          } else {
            const lo = subs.slice(0, cut);
            const hi = subs.slice(cut);
            const mean = (arr, k) => arr.reduce((s, q) => s + q[k], 0) / arr.length;
            cellBg = rgbInt(mean(lo, 'r'), mean(lo, 'g'), mean(lo, 'b'));
            cellFg = rgbInt(mean(hi, 'r'), mean(hi, 'g'), mean(hi, 'b'));
            let mask = 0;
            for (const q of hi) mask |= q.bit;
            ch = QUAD[mask];
          }
        } else {
          let mask = 0;
          let rs = 0, gs = 0, bs = 0, n = 0;
          for (const [dx, dy, bit] of SUB) {
            const si = (cy * 2 + dy) * W + cx * 2 + dx;
            if (bits[si]) {
              mask |= bit;
              const di = si * 4;
              rs += data[di]; gs += data[di + 1]; bs += data[di + 2];
              n++;
            }
          }
          ch = QUAD[mask];
          if (colorMode === 'fg' && n) cellFg = rgbInt(rs / n, gs / n, bs / n);
        }

        line += ch;
        grow.push([ch, cellFg, cellBg]);
        if (cellBg !== null) {
          ctx.fillStyle = intToCss(cellBg);
          ctx.fillRect(cx * cellW, cy * cellH, Math.ceil(cellW), cellH);
        }
        if (ch !== ' ' && !(cellBg !== null && ch === '█' && cellBg === cellFg)) {
          ctx.fillStyle = intToCss(cellFg);
          ctx.fillText(ch, cx * cellW, cy * cellH);
        } else if (cellBg !== null && ch === '█') {
          ctx.fillStyle = intToCss(cellFg);
          ctx.fillRect(cx * cellW, cy * cellH, Math.ceil(cellW), cellH);
        }
      }
      lines.push(line);
      grid.push(grow);
    }
    return this.#finish(lines, grid);
  }

  // -------------------------------------------------------------------------
  // braille renderer (2x4 dots, dithered)
  // -------------------------------------------------------------------------
  #renderBraille(imageData, opts) {
    const {
      cellSize, font, colorMode, fg, bg, invertRamp,
      dither, dotThreshold, autoContrast,
    } = opts;
    const W = imageData.width;  // cols * 2
    const H = imageData.height; // rows * 4
    const cols = Math.max(1, W >> 1);
    const rows = Math.max(1, H >> 2);
    const data = imageData.data;

    const lum = this.#lumGrid(data, W * H);
    if (autoContrast) this.#autoContrast(lum);
    if (invertRamp) for (let i = 0; i < lum.length; i++) lum[i] = 1 - lum[i];

    const dots = this.#ditherBits(lum, W, H, dotThreshold, dither);

    const cellH = cellSize;
    const cellW = this.measure(font, cellH, '⣿⠀⠿'); // blank + full: detect mixed advances
    const ctx = this.#beginDraw(cols, rows, cellW, cellH, font, bg);
    const fgInt = hexToInt(fg);

    const lines = [];
    const grid = [];
    for (let cy = 0; cy < rows; cy++) {
      let line = '';
      const grow = [];
      for (let cx = 0; cx < cols; cx++) {
        let mask = 0;
        let rs = 0, gs = 0, bs = 0, n = 0;
        for (let col = 0; col < 2; col++) {
          for (let row = 0; row < 4; row++) {
            const si = (cy * 4 + row) * W + cx * 2 + col;
            if (dots[si]) {
              mask |= BRAILLE_BITS[col][row];
              const di = si * 4;
              rs += data[di]; gs += data[di + 1]; bs += data[di + 2];
              n++;
            }
          }
        }
        const ch = String.fromCharCode(0x2800 | mask);
        line += ch;
        let cellFg = fgInt, cellBg = null;
        if (colorMode === 'bg') {
          let tr = 0, tg = 0, tb = 0;
          for (let col = 0; col < 2; col++) {
            for (let row = 0; row < 4; row++) {
              const di = ((cy * 4 + row) * W + cx * 2 + col) * 4;
              tr += data[di]; tg += data[di + 1]; tb += data[di + 2];
            }
          }
          cellBg = rgbInt(tr / 8, tg / 8, tb / 8);
          const l = LUMA(tr / 8, tg / 8, tb / 8) / 255;
          cellFg = l > 0.5 ? 0x000000 : 0xffffff;
          ctx.fillStyle = intToCss(cellBg);
          ctx.fillRect(cx * cellW, cy * cellH, Math.ceil(cellW), cellH);
          if (mask) {
            ctx.fillStyle = intToCss(cellFg);
            ctx.fillText(ch, cx * cellW, cy * cellH);
          }
        } else if (colorMode === 'fg') {
          if (n) cellFg = rgbInt(rs / n, gs / n, bs / n);
          if (mask) {
            ctx.fillStyle = intToCss(cellFg);
            ctx.fillText(ch, cx * cellW, cy * cellH);
          }
        }
        grow.push([ch, cellFg, cellBg]);
      }
      lines.push(line);
      grid.push(grow);
      if (colorMode === 'mono') {
        ctx.fillStyle = fg;
        if (this.lastUniform) {
          ctx.fillText(line, 0, cy * cellH);
        } else {
          // mixed braille advances (font fallback): draw per cell to keep columns
          for (let cx2 = 0; cx2 < line.length; cx2++) {
            ctx.fillText(line[cx2], cx2 * cellW, cy * cellH);
          }
        }
      }
    }
    return this.#finish(lines, grid);
  }
}

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

function hexToInt(hex) {
  let h = String(hex).replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const v = parseInt(h, 16);
  return Number.isFinite(v) ? v & 0xffffff : 0;
}

function rgbInt(r, g, b) {
  return (Math.round(r) << 16) | (Math.round(g) << 8) | Math.round(b);
}

function intToCss(v) {
  return `#${(v & 0xffffff).toString(16).padStart(6, '0')}`;
}

function cellMean(px, _unused, _o) {
  let r = 0, g = 0, b = 0;
  for (let k = 0; k < 64; k++) {
    r += px[k * 3];
    g += px[k * 3 + 1];
    b += px[k * 3 + 2];
  }
  return rgbInt(r / 64, g / 64, b / 64);
}

// insertion into the fixed-size candidate list (ascending Hamming distance).
// A glyph may only occupy one slot: the better of its normal/inverted match.
function insertCand(idx, ham, inv, g, hd, isInv) {
  const K = idx.length;
  for (let k = 0; k < K; k++) {
    if (ham[k] <= 64 && idx[k] === g) {
      if (hd >= ham[k]) return; // existing entry is at least as good
      // remove the worse duplicate, then fall through to insert
      for (let m = k; m < K - 1; m++) { ham[m] = ham[m + 1]; idx[m] = idx[m + 1]; inv[m] = inv[m + 1]; }
      ham[K - 1] = 65;
      break;
    }
  }
  if (hd >= ham[K - 1]) return;
  let i = K - 1;
  while (i > 0 && ham[i - 1] > hd) {
    ham[i] = ham[i - 1];
    idx[i] = idx[i - 1];
    inv[i] = inv[i - 1];
    i--;
  }
  ham[i] = hd;
  idx[i] = g;
  inv[i] = isInv;
}
