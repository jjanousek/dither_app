// CPU-side processing: image adjustments, palette quantization, and
// error-diffusion dithering (inherently sequential, so it lives on the CPU).
//
// All functions operate in-place on ImageData-style {data, width, height}.

// ---------------------------------------------------------------------------
// Error diffusion kernels: [dx, dy, weight]
// ---------------------------------------------------------------------------
export const DIFFUSION_KERNELS = {
  floyd: {
    name: 'Floyd–Steinberg',
    kernel: [[1, 0, 7 / 16], [-1, 1, 3 / 16], [0, 1, 5 / 16], [1, 1, 1 / 16]],
  },
  falsefloyd: {
    name: 'False Floyd–Steinberg',
    kernel: [[1, 0, 3 / 8], [0, 1, 3 / 8], [1, 1, 2 / 8]],
  },
  jarvis: {
    name: 'Jarvis–Judice–Ninke',
    kernel: [
      [1, 0, 7 / 48], [2, 0, 5 / 48],
      [-2, 1, 3 / 48], [-1, 1, 5 / 48], [0, 1, 7 / 48], [1, 1, 5 / 48], [2, 1, 3 / 48],
      [-2, 2, 1 / 48], [-1, 2, 3 / 48], [0, 2, 5 / 48], [1, 2, 3 / 48], [2, 2, 1 / 48],
    ],
  },
  stucki: {
    name: 'Stucki',
    kernel: [
      [1, 0, 8 / 42], [2, 0, 4 / 42],
      [-2, 1, 2 / 42], [-1, 1, 4 / 42], [0, 1, 8 / 42], [1, 1, 4 / 42], [2, 1, 2 / 42],
      [-2, 2, 1 / 42], [-1, 2, 2 / 42], [0, 2, 4 / 42], [1, 2, 2 / 42], [2, 2, 1 / 42],
    ],
  },
  atkinson: {
    name: 'Atkinson',
    kernel: [
      [1, 0, 1 / 8], [2, 0, 1 / 8],
      [-1, 1, 1 / 8], [0, 1, 1 / 8], [1, 1, 1 / 8],
      [0, 2, 1 / 8],
    ],
  },
  burkes: {
    name: 'Burkes',
    kernel: [
      [1, 0, 8 / 32], [2, 0, 4 / 32],
      [-2, 1, 2 / 32], [-1, 1, 4 / 32], [0, 1, 8 / 32], [1, 1, 4 / 32], [2, 1, 2 / 32],
    ],
  },
  sierra3: {
    name: 'Sierra',
    kernel: [
      [1, 0, 5 / 32], [2, 0, 3 / 32],
      [-2, 1, 2 / 32], [-1, 1, 4 / 32], [0, 1, 5 / 32], [1, 1, 4 / 32], [2, 1, 2 / 32],
      [-1, 2, 2 / 32], [0, 2, 3 / 32], [1, 2, 2 / 32],
    ],
  },
  sierra2: {
    name: 'Two-Row Sierra',
    kernel: [
      [1, 0, 4 / 16], [2, 0, 3 / 16],
      [-2, 1, 1 / 16], [-1, 1, 2 / 16], [0, 1, 3 / 16], [1, 1, 2 / 16], [2, 1, 1 / 16],
    ],
  },
  sierralite: {
    name: 'Sierra Lite',
    kernel: [[1, 0, 2 / 4], [-1, 1, 1 / 4], [0, 1, 1 / 4]],
  },
};

// ---------------------------------------------------------------------------
// Adjustments (must mirror the GLSL math in shaders.js exactly)
// order: saturation (clamped) -> brightness/contrast -> gamma -> invert
// ---------------------------------------------------------------------------
export function applyAdjustments(imageData, p) {
  const d = imageData.data;
  const { brightness = 0, contrast = 0, gamma = 1, saturation = 1, invert = false } = p;
  // The common/default path is already in the exact byte space the renderer
  // needs. Avoid a full-frame LUT walk for every decoded video frame.
  if (brightness === 0 && contrast === 0 && gamma === 1 && saturation === 1 && !invert) return;
  const cf = 1 + contrast;
  const ig = 1 / Math.max(gamma, 0.01);

  // Precompute a LUT for the per-channel part (brightness, contrast, gamma, invert)
  const lut = new Uint8ClampedArray(256);
  for (let i = 0; i < 256; i++) {
    let v = i / 255;
    v = (v - 0.5) * cf + 0.5 + brightness;
    v = Math.min(1, Math.max(0, v));
    v = Math.pow(v, ig);
    if (invert) v = 1 - v;
    lut[i] = Math.round(v * 255);
  }

  if (saturation === 1) {
    for (let i = 0; i < d.length; i += 4) {
      d[i] = lut[d[i]];
      d[i + 1] = lut[d[i + 1]];
      d[i + 2] = lut[d[i + 2]];
    }
  } else {
    // float-space curve so saturated pixels match the GPU path exactly
    // (Math.pow(v, 1) === v, so skipping it at gamma 1 is byte-identical)
    const usePow = ig !== 1;
    const curve = (v) => {
      v = Math.min(1, Math.max(0, v / 255));
      v = (v - 0.5) * cf + 0.5 + brightness;
      v = Math.min(1, Math.max(0, v));
      if (usePow) v = Math.pow(v, ig);
      if (invert) v = 1 - v;
      return v * 255;
    };
    if (saturation === 0) {
      // grayscale: all three channels collapse to curve(luma) — one curve()
      // call per pixel instead of three identical ones (this branch runs on
      // the main thread every live frame whenever Grayscale is on)
      for (let i = 0; i < d.length; i += 4) {
        const v = curve(0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]);
        d[i] = v;
        d[i + 1] = v;
        d[i + 2] = v;
      }
    } else {
      for (let i = 0; i < d.length; i += 4) {
        const r = d[i], g = d[i + 1], b = d[i + 2];
        const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        d[i] = curve(l + (r - l) * saturation);
        d[i + 1] = curve(l + (g - l) * saturation);
        d[i + 2] = curve(l + (b - l) * saturation);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Palette quantization helpers
// ---------------------------------------------------------------------------

// Nearest color in flat palette [r,g,b,...] (0..255). Returns index*3.
// The early-exit on an exact match is byte-identical: 0 is the minimum
// possible distance, so scanning further can never change the winner, and
// stopping at the FIRST exact match preserves first-index-wins tie behaviour.
function nearestIndex(pal, n, r, g, b) {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < n; i++) {
    const dr = pal[i * 3] - r;
    const dg = pal[i * 3 + 1] - g;
    const db = pal[i * 3 + 2] - b;
    const dist = dr * dr * 0.299 + dg * dg * 0.587 + db * db * 0.114;
    if (dist < bestD) {
      bestD = dist;
      best = i * 3;
      if (dist === 0) break;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Error diffusion dithering with arbitrary palette.
// strength: 0..1 scales how much error is propagated.
// serpentine: alternate scan direction per row (reduces worm artifacts).
// ---------------------------------------------------------------------------
// Reusable row ring for error diffusion. The widest kernel reaches only two
// rows ahead, so retaining a full Float32 RGB copy of a phone photo wastes
// hundreds of MB. Rows are preloaded with their original pixels before any
// errors land, preserving the old Float32 rounding/order byte-for-byte.
let _edBuf = null;
// Flattened kernel plans cached by (kernelId, width): pure precompute, no
// change to arithmetic. Cleared if it grows unbounded (many preview sizes).
const _edPlans = new Map();
function edPlan(kernelId, kernel, w) {
  const key = `${kernelId}:${w}`;
  let plan = _edPlans.get(key);
  if (plan) return plan;
  const taps = kernel.length;
  const kdxF = new Int32Array(taps);
  const kdxR = new Int32Array(taps);
  const kdy = new Int32Array(taps);
  const kw = new Float64Array(taps);
  const offF = new Int32Array(taps);
  const offR = new Int32Array(taps);
  let maxDx = 0;
  let maxDy = 0;
  for (let t = 0; t < taps; t++) {
    const [dx, dy, wgt] = kernel[t];
    kdxF[t] = dx;
    kdxR[t] = -dx;
    kdy[t] = dy;
    kw[t] = wgt;
    offF[t] = (dy * w + dx) * 3;
    offR[t] = (dy * w - dx) * 3;
    if (Math.abs(dx) > maxDx) maxDx = Math.abs(dx);
    if (dy > maxDy) maxDy = dy;
  }
  plan = { taps, kdxF, kdxR, kdy, kw, offF, offR, maxDx, maxDy };
  if (_edPlans.size >= 128) _edPlans.clear();
  _edPlans.set(key, plan);
  return plan;
}

export function errorDiffusion(imageData, palette, kernelId, { strength = 1, serpentine = true, bias = 0 } = {}) {
  const { kernel } = DIFFUSION_KERNELS[kernelId] || DIFFUSION_KERNELS.floyd;
  const { width: w, height: h, data: d } = imageData;
  const n = palette.length / 3;
  const b = bias * 255; // threshold bias, mirrors u_bias in the shader

  const { taps, kdxF, kdxR, kdy, kw, maxDx, maxDy } = edPlan(kernelId, kernel, w);
  const rowStride = w * 3;
  const ringRows = maxDy + 1;
  const need = rowStride * ringRows;
  if (!_edBuf || _edBuf.length !== need) _edBuf = new Float32Array(need);
  const buf = _edBuf;
  const loadRow = (srcY, slotBase) => {
    if (srcY >= h) {
      buf.fill(0, slotBase, slotBase + rowStride);
      return;
    }
    let si = srcY * w * 4;
    for (let j = slotBase, end = slotBase + rowStride; j < end; j += 3, si += 4) {
      buf[j] = d[si];
      buf[j + 1] = d[si + 1];
      buf[j + 2] = d[si + 2];
    }
  };
  for (let y = 0; y < ringRows; y++) loadRow(y, y * rowStride);
  const rowBase = new Int32Array(ringRows);

  for (let y = 0; y < h; y++) {
    const reverse = serpentine && (y & 1) === 1;
    const xStart = reverse ? w - 1 : 0;
    const xEnd = reverse ? -1 : w;
    const xStep = reverse ? -1 : 1;
    const adx = reverse ? kdxR : kdxF;
    const safeRow = y + maxDy < h; // interior pixels skip all bounds checks
    for (let dy = 0; dy < ringRows; dy++) rowBase[dy] = ((y + dy) % ringRows) * rowStride;
    const currentBase = rowBase[0];

    for (let x = xStart; x !== xEnd; x += xStep) {
      const j = currentBase + x * 3;
      const di = (y * w + x) * 4;
      const r = Math.min(255, Math.max(0, buf[j] + b));
      const g = Math.min(255, Math.max(0, buf[j + 1] + b));
      const bl = Math.min(255, Math.max(0, buf[j + 2] + b));
      const pi = nearestIndex(palette, n, r, g, bl);
      const pr = palette[pi], pg = palette[pi + 1], pb = palette[pi + 2];

      const er = (r - pr) * strength;
      const eg = (g - pg) * strength;
      const eb = (bl - pb) * strength;

      d[di] = pr;
      d[di + 1] = pg;
      d[di + 2] = pb;

      if (safeRow && x >= maxDx && x < w - maxDx) {
        for (let t = 0; t < taps; t++) {
          const k = rowBase[kdy[t]] + (x + adx[t]) * 3;
          const wgt = kw[t];
          buf[k] += er * wgt;
          buf[k + 1] += eg * wgt;
          buf[k + 2] += eb * wgt;
        }
      } else {
        for (let t = 0; t < taps; t++) {
          const nx = x + adx[t];
          if (nx < 0 || nx >= w || y + kdy[t] >= h) continue;
          const k = rowBase[kdy[t]] + nx * 3;
          const wgt = kw[t];
          buf[k] += er * wgt;
          buf[k + 1] += eg * wgt;
          buf[k + 2] += eb * wgt;
        }
      }
    }
    // This slot cannot receive another error until it represents y+ringRows.
    loadRow(y + ringRows, currentBase);
  }
}

// ---------------------------------------------------------------------------
// Ordered dithering on CPU (fallback when WebGL is unavailable, and used by
// the full-resolution PNG exporter to guarantee pixel-exact output).
// matrix: {size, data: Float32Array of thresholds in 0..1}
// ---------------------------------------------------------------------------
export function orderedDither(imageData, palette, matrix, { strength = 1, bias = 0, offsetX = 0, offsetY = 0 } = {}) {
  const { width: w, height: h, data: d } = imageData;
  const n = palette.length / 3;
  const { size, data: m } = matrix;
  // Spread scaled by palette density: fewer colors need a larger spread.
  const spread = (255 * strength) / Math.max(1, n - 1) * 1.5;
  const threshold = bias * 255;
  const ox = ((Math.floor(offsetX) % size) + size) % size;
  const oy = ((Math.floor(offsetY) % size) + size) % size;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const noise = (m[((y + oy) % size) * size + ((x + ox) % size)] - 0.5) * spread;
      const r = d[i] + noise + threshold;
      const g = d[i + 1] + noise + threshold;
      const b = d[i + 2] + noise + threshold;
      const pi = nearestIndex(palette, n,
        Math.min(255, Math.max(0, r)),
        Math.min(255, Math.max(0, g)),
        Math.min(255, Math.max(0, b)));
      d[i] = palette[pi];
      d[i + 1] = palette[pi + 1];
      d[i + 2] = palette[pi + 2];
    }
  }
}

// Plain nearest-palette quantization (no dithering).
export function quantize(imageData, palette, bias = 0) {
  const { data: d } = imageData;
  const n = palette.length / 3;
  const b = bias * 255;
  const cl = (v) => Math.min(255, Math.max(0, v));
  for (let i = 0; i < d.length; i += 4) {
    const pi = nearestIndex(palette, n, cl(d[i] + b), cl(d[i + 1] + b), cl(d[i + 2] + b));
    d[i] = palette[pi];
    d[i + 1] = palette[pi + 1];
    d[i + 2] = palette[pi + 2];
  }
}

// ---------------------------------------------------------------------------
// Threshold matrices for ordered dithering
// ---------------------------------------------------------------------------
function bayer(n) {
  // Recursive Bayer matrix, normalized to 0..1 (values are (v + 0.5) / n^2).
  let m = [[0]];
  let size = 1;
  while (size < n) {
    const s2 = size * 2;
    const next = Array.from({ length: s2 }, () => new Array(s2));
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const v = m[y][x] * 4;
        next[y][x] = v;
        next[y][x + size] = v + 2;
        next[y + size][x] = v + 3;
        next[y + size][x + size] = v + 1;
      }
    }
    m = next;
    size = s2;
  }
  const data = new Float32Array(n * n);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) data[y * n + x] = (m[y][x] + 0.5) / (n * n);
  }
  return { size: n, data };
}

// Classic 8x8 clustered-dot (halftone) threshold matrix.
const CLUSTER8 = [
  24, 10, 12, 26, 35, 47, 49, 37,
  8, 0, 2, 14, 45, 59, 61, 51,
  22, 6, 4, 16, 43, 57, 63, 53,
  30, 20, 18, 28, 33, 41, 55, 39,
  34, 46, 48, 36, 25, 11, 13, 27,
  44, 58, 60, 50, 9, 1, 3, 15,
  42, 56, 62, 52, 23, 7, 5, 17,
  32, 40, 54, 38, 31, 21, 19, 29,
];

const CLUSTER4 = [
  12, 5, 6, 13,
  4, 0, 1, 7,
  11, 3, 2, 8,
  15, 10, 9, 14,
];

export const MATRICES = {
  bayer2: bayer(2),
  bayer4: bayer(4),
  bayer8: bayer(8),
  cluster4: { size: 4, data: new Float32Array(CLUSTER4.map((v) => (v + 0.5) / 16)) },
  cluster8: { size: 8, data: new Float32Array(CLUSTER8.map((v) => (v + 0.5) / 64)) },
};

// ---------------------------------------------------------------------------
// CPU fallbacks for the GPU-only modes (used when WebGL is unavailable).
// Math mirrors shaders.js so the output matches the GPU path.
// ---------------------------------------------------------------------------

function hash12(x, y) {
  // same hash as the shader (approximately; used only in the no-WebGL path)
  const fract = (v) => v - Math.floor(v);
  let p3x = fract(x * 0.1031);
  let p3y = fract(y * 0.1031);
  let p3z = fract(x * 0.1031);
  const dt = p3x * (p3y + 33.33) + p3y * (p3z + 33.33) + p3z * (p3x + 33.33);
  p3x += dt; p3y += dt; p3z += dt;
  return fract((p3x + p3y) * p3z);
}

export function whiteNoiseDither(imageData, palette, { strength = 1, bias = 0, seed = 0, ox = 0, oy = 0 } = {}) {
  const { width: w, height: h, data: d } = imageData;
  const n = palette.length / 3;
  const spread = (255 * strength) / Math.max(1, n - 1) * 1.5;
  const threshold = bias * 255;
  const cl = (v) => Math.min(255, Math.max(0, v));
  // same reseed offsets as the shader so flow/shimmer animate on this path too
  const sx = Math.floor(ox) + seed * 91.7;
  const sy = Math.floor(oy) + seed * 37.3;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const noise = (hash12(x + sx, y + sy) - 0.5) * spread;
      const pi = nearestIndex(palette, n,
        cl(d[i] + noise + threshold),
        cl(d[i + 1] + noise + threshold),
        cl(d[i + 2] + noise + threshold));
      d[i] = palette[pi];
      d[i + 1] = palette[pi + 1];
      d[i + 2] = palette[pi + 2];
    }
  }
}

export function halftoneDither(imageData, palette, { scale = 6, angle = 45, bias = 0, line = false, ox = 0, oy = 0 } = {}) {
  const { width: w, height: h, data: d } = imageData;
  const n = palette.length / 3;
  // darkest / brightest palette entries (same as paletteExtremes in the shader)
  let dark = 0, bright = 0, dMin = Infinity, dMax = -Infinity;
  for (let i = 0; i < n; i++) {
    const l = 0.2126 * palette[i * 3] + 0.7152 * palette[i * 3 + 1] + 0.0722 * palette[i * 3 + 2];
    if (l < dMin) { dMin = l; dark = i * 3; }
    if (l > dMax) { dMax = l; bright = i * 3; }
  }
  const rad = (angle * Math.PI) / 180;
  const ca = Math.cos(rad), sa = Math.sin(rad);
  const s = Math.max(scale, 1.5);
  const fract = (v) => v - Math.floor(v);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const lum = (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255;
      const l = Math.min(1, Math.max(0, lum + bias));
      // rot(a)*pix in the shader's column-major convention, drift after
      // rotation (same as `rot(u_halftoneAngle) * pix + u_matOffset`)
      const px = ca * x + sa * y + ox;
      const py = -sa * x + ca * y + oy;
      let on;
      if (line) {
        on = Math.abs(fract(py / s) - 0.5) * 2 <= (1 - l);
      } else {
        const cx = fract(px / s) - 0.5;
        const cy = fract(py / s) - 0.5;
        on = Math.hypot(cx, cy) <= Math.sqrt(1 - l) * 0.75;
      }
      const pi = on ? dark : bright;
      d[i] = palette[pi];
      d[i + 1] = palette[pi + 1];
      d[i + 2] = palette[pi + 2];
    }
  }
}
