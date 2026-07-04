// ASCII art renderer. Maps a low-res luminance grid to characters and draws
// them onto a 2D canvas. Monochrome mode draws whole rows in one fillText
// call (fast enough for video); color modes fill per cell.
//
// Extras: braille mode (2x4 dot subcells -> U+2800 block) and Sobel
// edge-directed glyphs (edges become - / | \ oriented characters).

export const RAMPS = {
  classic: { name: 'Classic', chars: '@%#*+=-:. ' },
  detailed: {
    name: 'Detailed 70',
    chars: "$@B%8&WM#*oahkbdpqwmZO0QLCJUYXzcvunxrjft/\\|()1{}[]?-_+~<>i!lI;:,\"^`'. ",
  },
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

// By edge orientation bin. Canvas y points down, so the diagonals are the
// mirror of the math-convention ones.
const EDGE_CHARS = ['-', '\\', '|', '/'];
const LUMA = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

export class AsciiRenderer {
  constructor() {
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d');
    this.lastText = '';
  }

  // Widest advance of the ramp's glyphs, so the sample grid matches the glyph
  // grid even for full-width (CJK) or symbol ramps. Sets this.lastUniform so
  // render() knows whether whole-row fillText keeps columns aligned.
  measure(font, cellH, chars = 'M') {
    this.ctx.font = `${cellH}px ${font}`;
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

  /**
   * @param imageData adjusted low-res frame.
   *   normal mode: one pixel per character cell (cols x rows)
   *   braille mode: 2x4 pixels per character cell (cols*2 x rows*4)
   * @param opts { chars, cellSize, font, colorMode:'mono'|'fg'|'bg', fg, bg,
   *               invertRamp, edges, braille }
   */
  render(imageData, opts) {
    const {
      chars = RAMPS.classic.chars,
      cellSize = 12,
      font = "'Courier New', ui-monospace, monospace",
      colorMode = 'mono',
      fg = '#e8e8e8',
      bg = '#0a0a0c',
      invertRamp = false,
      edges = false,
      braille = false,
    } = opts;

    if (braille) return this.#renderBraille(imageData, { cellSize, font, colorMode, fg, bg, invertRamp });

    const rampArr = invertRamp ? [...chars].reverse() : [...chars];
    const levels = rampArr.length;
    const { width: cols, height: rows, data } = imageData;

    // Precompute luminance grid (also used by Sobel).
    const lum = new Float32Array(cols * rows);
    for (let i = 0, j = 0; j < lum.length; i += 4, j++) {
      lum[j] = LUMA(data[i], data[i + 1], data[i + 2]) / 255;
    }
    const edgeMap = edges ? this.#sobel(lum, cols, rows) : null;

    const cellH = cellSize;
    const cellW = this.measure(font, cellH, chars);
    const uniform = this.lastUniform;
    this.#resize(Math.round(cols * cellW), rows * cellH);

    const ctx = this.ctx;
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.font = `${cellH}px ${font}`;
    ctx.textBaseline = 'top';

    const pick = (idx) => {
      if (edgeMap && edgeMap.mag[idx] > 0.35) return EDGE_CHARS[edgeMap.dir[idx]];
      const l = lum[idx];
      const ci = Math.min(levels - 1, Math.floor((1 - l) * levels));
      return rampArr[ci];
    };

    const lines = [];
    if (colorMode === 'mono' && uniform) {
      // fast path: one fillText per row (columns align for uniform advances)
      ctx.fillStyle = fg;
      for (let y = 0; y < rows; y++) {
        let line = '';
        for (let x = 0; x < cols; x++) line += pick(y * cols + x);
        lines.push(line);
        ctx.fillText(line, 0, y * cellH);
      }
    } else if (colorMode === 'mono') {
      // mixed-width ramp: place each glyph on its own column
      ctx.fillStyle = fg;
      for (let y = 0; y < rows; y++) {
        let line = '';
        for (let x = 0; x < cols; x++) {
          const ch = pick(y * cols + x);
          line += ch;
          if (ch !== ' ') ctx.fillText(ch, x * cellW, y * cellH);
        }
        lines.push(line);
      }
    } else {
      for (let y = 0; y < rows; y++) {
        let line = '';
        for (let x = 0; x < cols; x++) {
          const idx = y * cols + x;
          const i = idx * 4;
          const r = data[i], g = data[i + 1], b = data[i + 2];
          const ch = pick(idx);
          line += ch;
          if (colorMode === 'bg') {
            ctx.fillStyle = `rgb(${r},${g},${b})`;
            ctx.fillRect(x * cellW, y * cellH, Math.ceil(cellW), cellH);
            ctx.fillStyle = lum[idx] > 0.5 ? '#000000' : '#ffffff';
            ctx.fillText(ch, x * cellW, y * cellH);
          } else if (ch !== ' ') {
            ctx.fillStyle = `rgb(${r},${g},${b})`;
            ctx.fillText(ch, x * cellW, y * cellH);
          }
        }
        lines.push(line);
      }
    }
    this.lastText = lines.join('\n');
    return this.canvas;
  }

  #renderBraille(imageData, { cellSize, font, colorMode, fg, bg, invertRamp }) {
    const { width: W, height: H, data } = imageData; // W = cols*2, H = rows*4
    const cols = Math.max(1, W >> 1);
    const rows = Math.max(1, H >> 2);

    const cellH = cellSize;
    const cellW = this.measure(font, cellH, '⣿');
    this.#resize(Math.round(cols * cellW), rows * cellH);

    const ctx = this.ctx;
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.font = `${cellH}px ${font}`;
    ctx.textBaseline = 'top';

    // Braille dot bit layout (dx, dy) -> bit
    const DOTS = [
      [0, 0, 0x01], [0, 1, 0x02], [0, 2, 0x04], [1, 0, 0x08],
      [1, 1, 0x10], [1, 2, 0x20], [0, 3, 0x40], [1, 3, 0x80],
    ];
    const thresh = 0.55;

    const lines = [];
    for (let cy = 0; cy < rows; cy++) {
      let line = '';
      for (let cx = 0; cx < cols; cx++) {
        let bits = 0;
        let rSum = 0, gSum = 0, bSum = 0;
        for (const [dx, dy, bit] of DOTS) {
          const px = Math.min(W - 1, cx * 2 + dx);
          const py = Math.min(H - 1, cy * 4 + dy);
          const i = (py * W + px) * 4;
          rSum += data[i]; gSum += data[i + 1]; bSum += data[i + 2];
          let l = LUMA(data[i], data[i + 1], data[i + 2]) / 255;
          if (invertRamp) l = 1 - l;
          // bright pixels raise dots (light dots on dark background)
          if (l > thresh) bits |= bit;
        }
        const ch = String.fromCharCode(0x2800 | bits);
        line += ch;
        if (colorMode === 'bg') {
          const rA = Math.round(rSum / 8);
          const gA = Math.round(gSum / 8);
          const bA = Math.round(bSum / 8);
          ctx.fillStyle = `rgb(${rA},${gA},${bA})`;
          ctx.fillRect(cx * cellW, cy * cellH, Math.ceil(cellW), cellH);
          if (bits !== 0) {
            ctx.fillStyle = LUMA(rA, gA, bA) / 255 > 0.5 ? '#000000' : '#ffffff';
            ctx.fillText(ch, cx * cellW, cy * cellH);
          }
        } else if (colorMode === 'fg' && bits !== 0) {
          ctx.fillStyle = `rgb(${Math.round(rSum / 8)},${Math.round(gSum / 8)},${Math.round(bSum / 8)})`;
          ctx.fillText(ch, cx * cellW, cy * cellH);
        }
      }
      lines.push(line);
      if (colorMode === 'mono') {
        ctx.fillStyle = fg;
        ctx.fillText(line, 0, cy * cellH);
      }
    }
    this.lastText = lines.join('\n');
    return this.canvas;
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
          // Edge orientation is perpendicular to the gradient.
          let a = Math.atan2(gy, gx) + Math.PI / 2;
          a = ((a % Math.PI) + Math.PI) % Math.PI; // 0..PI
          dir[i] = Math.round(a / (Math.PI / 4)) % 4; // 0:-  1:/  2:|  3:\
        }
      }
    }
    return { mag, dir };
  }

  #resize(w, h) {
    w = Math.max(1, w);
    h = Math.max(1, h);
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
  }
}
