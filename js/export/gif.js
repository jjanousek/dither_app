// Minimal GIF89a encoder with LZW compression.
//
// Palette strategy: pixels are bucketed at 15-bit color (5 bits/channel) with
// per-bucket running sums, so the final entry is the average of the true
// colors that fell in the bucket. Palettized dither output puts each distinct
// color alone in its bucket -> exact colors, no quantization loss. If a clip
// accumulates more than 256 buckets, a weighted median-cut reduces them to a
// global 256-color table covering the WHOLE clip (not first-frame-wins), and
// each frame is Floyd–Steinberg-diffused against that table (offline, so the
// continuous-tone content that overflowed the buckets doesn't posterize).

class ByteBuffer {
  constructor() {
    this.chunks = [];
    this.cur = new Uint8Array(4096);
    this.len = 0;
  }
  byte(b) {
    if (this.len === this.cur.length) {
      this.chunks.push(this.cur);
      this.cur = new Uint8Array(4096);
      this.len = 0;
    }
    this.cur[this.len++] = b;
  }
  bytes(arr) { for (let i = 0; i < arr.length; i++) this.byte(arr[i]); }
  short(v) { this.byte(v & 0xff); this.byte((v >> 8) & 0xff); }
  string(s) { for (let i = 0; i < s.length; i++) this.byte(s.charCodeAt(i)); }
  toUint8Array() {
    const total = this.chunks.length * 4096 + this.len;
    const out = new Uint8Array(total);
    let o = 0;
    for (const c of this.chunks) { out.set(c, o); o += 4096; }
    out.set(this.cur.subarray(0, this.len), o);
    return out;
  }
}

function lzwEncode(indices, minCodeSize, out) {
  const clearCode = 1 << minCodeSize;
  const eoiCode = clearCode + 1;
  let codeSize = minCodeSize + 1;
  let dict = new Map();
  let nextCode = eoiCode + 1;

  let block = [];
  let bitBuf = 0, bitCnt = 0;
  const emit = (code) => {
    bitBuf |= code << bitCnt;
    bitCnt += codeSize;
    while (bitCnt >= 8) {
      block.push(bitBuf & 0xff);
      bitBuf >>= 8;
      bitCnt -= 8;
      if (block.length === 255) { out.byte(255); out.bytes(block); block = []; }
    }
  };

  emit(clearCode);
  let prefix = indices[0];
  for (let i = 1; i < indices.length; i++) {
    const k = indices[i];
    const key = (prefix << 8) | k;
    const found = dict.get(key);
    if (found !== undefined) {
      prefix = found;
    } else {
      emit(prefix);
      dict.set(key, nextCode);
      if (nextCode === (1 << codeSize) && codeSize < 12) codeSize++;
      nextCode++;
      if (nextCode >= 4096) {
        emit(clearCode);
        dict = new Map();
        nextCode = eoiCode + 1;
        codeSize = minCodeSize + 1;
      }
      prefix = k;
    }
  }
  emit(prefix);
  emit(eoiCode);
  if (bitCnt > 0) block.push(bitBuf & 0xff);
  if (block.length) { out.byte(block.length); out.bytes(block); }
  out.byte(0); // block terminator
}

// Weighted median-cut over bucket colors -> map of bucket index -> palette
// index, plus the palette itself (<= maxColors entries).
function medianCut(colors, counts, maxColors) {
  const ids = colors.map((_, i) => i);
  let boxes = [ids];

  const widestChannel = (box) => {
    const mins = [255, 255, 255];
    const maxs = [0, 0, 0];
    for (const id of box) {
      for (let c = 0; c < 3; c++) {
        const v = colors[id][c];
        if (v < mins[c]) mins[c] = v;
        if (v > maxs[c]) maxs[c] = v;
      }
    }
    let ch = 0, range = -1;
    for (let c = 0; c < 3; c++) {
      if (maxs[c] - mins[c] > range) { range = maxs[c] - mins[c]; ch = c; }
    }
    return { ch, range };
  };

  while (boxes.length < maxColors) {
    // split the box with the largest weighted spread
    let bi = -1, best = 0, bestCh = 0;
    for (let i = 0; i < boxes.length; i++) {
      if (boxes[i].length < 2) continue;
      const { ch, range } = widestChannel(boxes[i]);
      let weight = 0;
      for (const id of boxes[i]) weight += counts[id];
      const score = range * Math.sqrt(weight);
      if (score > best) { best = score; bi = i; bestCh = ch; }
    }
    if (bi < 0) break;

    const box = boxes[bi].slice().sort((a, b) => colors[a][bestCh] - colors[b][bestCh]);
    let total = 0;
    for (const id of box) total += counts[id];
    let acc = 0, cut = 1;
    for (let i = 0; i < box.length - 1; i++) {
      acc += counts[box[i]];
      if (acc >= total / 2) { cut = i + 1; break; }
    }
    boxes[bi] = box.slice(0, cut);
    boxes.push(box.slice(cut));
  }

  const palette = [];
  const remap = new Uint8Array(colors.length);
  boxes.forEach((box, pi) => {
    let r = 0, g = 0, b = 0, wsum = 0;
    for (const id of box) {
      const w = counts[id];
      r += colors[id][0] * w;
      g += colors[id][1] * w;
      b += colors[id][2] * w;
      wsum += w;
      remap[id] = pi;
    }
    palette.push([Math.round(r / wsum), Math.round(g / wsum), Math.round(b / wsum)]);
  });
  return { palette, remap };
}

export class GifEncoder {
  constructor(width, height, { fps = 15, loop = true } = {}) {
    this.w = width;
    this.h = height;
    this.fps = fps;
    this.loop = loop;
    this.buckets = new Map(); // 15-bit key -> bucket index
    this.sums = [];           // [rSum, gSum, bSum, count] per bucket
    this.frames = [];         // Uint8Array normally; lazily widens past 256 buckets
    this._wide = false;
    this._fsBuf = null;       // Float32 scratch for the >256-color diffusion
  }

  // Quantize one frame's bucket colors to the 256-entry palette with
  // Floyd–Steinberg error diffusion. Overflowing 256 buckets only happens for
  // continuous-tone content (smoothed dithers, grain/glow, ASCII colors) —
  // a straight nearest-bucket remap posterizes exactly that content, and this
  // is an offline path, so diffusion is affordable. Serpentine, luma-weighted
  // nearest via a 15-bit LUT (a full 256-entry scan per pixel would take
  // minutes over a whole clip; the LUT's ±4/channel quantization is invisible
  // on already-continuous content).
  #ditherFrame(src, colors, palette, lut) {
    const w = this.w;
    const h = this.h;
    const n = w * h;
    if (!this._fsBuf || this._fsBuf.length < n * 3) this._fsBuf = new Float32Array(n * 3);
    const buf = this._fsBuf;
    for (let i = 0, j = 0; i < n; i++, j += 3) {
      const c = colors[src[i]];
      buf[j] = c[0];
      buf[j + 1] = c[1];
      buf[j + 2] = c[2];
    }
    const nearest = (r, g, b) => {
      const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
      let pi = lut[key];
      if (pi < 0) {
        let bd = Infinity;
        pi = 0;
        for (let p = 0; p < palette.length; p++) {
          const dr = palette[p][0] - r, dg = palette[p][1] - g, db = palette[p][2] - b;
          const d = dr * dr * 0.299 + dg * dg * 0.587 + db * db * 0.114;
          if (d < bd) { bd = d; pi = p; }
        }
        lut[key] = pi;
      }
      return pi;
    };
    const cl = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);
    const outIdx = new Uint8Array(n);
    for (let y = 0; y < h; y++) {
      const rev = (y & 1) === 1;
      const dx = rev ? -1 : 1;
      for (let xi = 0; xi < w; xi++) {
        const x = rev ? w - 1 - xi : xi;
        const j = (y * w + x) * 3;
        const r = cl(buf[j]), g = cl(buf[j + 1]), b = cl(buf[j + 2]);
        const pi = nearest(r | 0, g | 0, b | 0);
        outIdx[y * w + x] = pi;
        const p = palette[pi];
        const er = r - p[0], eg = g - p[1], eb = b - p[2];
        if (x + dx >= 0 && x + dx < w) {
          const k = j + dx * 3;
          buf[k] += er * (7 / 16); buf[k + 1] += eg * (7 / 16); buf[k + 2] += eb * (7 / 16);
        }
        if (y + 1 < h) {
          if (x - dx >= 0 && x - dx < w) {
            const k = j + (w - dx) * 3;
            buf[k] += er * (3 / 16); buf[k + 1] += eg * (3 / 16); buf[k + 2] += eb * (3 / 16);
          }
          const k = j + w * 3;
          buf[k] += er * (5 / 16); buf[k + 1] += eg * (5 / 16); buf[k + 2] += eb * (5 / 16);
          if (x + dx >= 0 && x + dx < w) {
            const k2 = j + (w + dx) * 3;
            buf[k2] += er * (1 / 16); buf[k2 + 1] += eg * (1 / 16); buf[k2 + 2] += eb * (1 / 16);
          }
        }
      }
    }
    return outIdx;
  }

  // rgba: Uint8ClampedArray from ImageData
  addFrame(rgba) {
    const n = this.w * this.h;
    let idx = this._wide ? new Uint16Array(n) : new Uint8Array(n);
    const { buckets, sums } = this;
    for (let i = 0; i < n; i++) {
      const r = rgba[i * 4], g = rgba[i * 4 + 1], b = rgba[i * 4 + 2];
      const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
      let bi = buckets.get(key);
      if (bi === undefined) {
        bi = sums.length;
        buckets.set(key, bi);
        sums.push([0, 0, 0, 0]);
      }
      if (bi >= 256 && idx.BYTES_PER_ELEMENT === 1) {
        const wide = new Uint16Array(n);
        wide.set(idx);
        idx = wide;
        this._wide = true;
      }
      const s = sums[bi];
      s[0] += r; s[1] += g; s[2] += b; s[3]++;
      idx[i] = bi;
    }
    this.frames.push(idx);
  }

  // abortFn (optional): checked between frames; throwing 'cancelled' aborts.
  async finish(abortFn) {
    // Bucket averages -> candidate colors
    const colors = this.sums.map((s) => [
      Math.round(s[0] / s[3]),
      Math.round(s[1] / s[3]),
      Math.round(s[2] / s[3]),
    ]);
    const counts = this.sums.map((s) => s[3]);

    let palette, remap, nearestLut = null;
    if (colors.length <= 256) {
      palette = colors;
      remap = null; // identity — palettized content is stored exactly
    } else {
      ({ palette, remap } = medianCut(colors, counts, 256));
      // shared nearest-palette LUT for the per-frame diffusion below
      nearestLut = new Int16Array(32768).fill(-1);
    }

    const out = new ByteBuffer();
    let bits = 1;
    while ((1 << bits) < palette.length) bits++;
    const tableSize = 1 << bits;

    out.string('GIF89a');
    out.short(this.w);
    out.short(this.h);
    out.byte(0x80 | ((bits - 1) & 7) | (((bits - 1) & 7) << 4)); // GCT flag + sizes
    out.byte(0); // bg color index
    out.byte(0); // aspect

    for (let i = 0; i < tableSize; i++) {
      const c = palette[i] || [0, 0, 0];
      out.byte(c[0]); out.byte(c[1]); out.byte(c[2]);
    }

    if (this.loop && this.frames.length > 1) {
      out.byte(0x21); out.byte(0xff); out.byte(11);
      out.string('NETSCAPE2.0');
      out.byte(3); out.byte(1); out.short(0); out.byte(0);
    }

    const minCodeSize = Math.max(2, bits);
    // Cumulative-rounded delays so total duration matches fps exactly
    // (fixed round(100/fps) drifts ~4% at 12fps).
    let accCs = 0;
    for (let f = 0; f < this.frames.length; f++) {
      if (abortFn && abortFn()) throw new Error('cancelled');
      if (f > 0 && f % 4 === 0) await new Promise((r) => setTimeout(r, 0)); // keep the UI alive
      const target = Math.round(((f + 1) * 100) / this.fps);
      const delay = Math.max(2, target - accCs);
      accCs += delay;

      out.byte(0x21); out.byte(0xf9); out.byte(4);
      out.byte(0); // no transparency, no disposal
      out.short(delay);
      out.byte(0); out.byte(0);
      out.byte(0x2c);
      out.short(0); out.short(0);
      out.short(this.w); out.short(this.h);
      out.byte(0); // no local color table
      out.byte(minCodeSize);

      let indices = this.frames[f];
      // >256 buckets: diffuse the palette-reduction error instead of a
      // straight remap (which posterizes the continuous-tone content that
      // overflowed the buckets in the first place)
      if (remap) indices = this.#ditherFrame(indices, colors, palette, nearestLut);
      lzwEncode(indices, minCodeSize, out);
    }
    out.byte(0x3b); // trailer
    return new Blob([out.toUint8Array()], { type: 'image/gif' });
  }
}
