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
    const curve = (v) => {
      v = Math.min(1, Math.max(0, v / 255));
      v = (v - 0.5) * cf + 0.5 + brightness;
      v = Math.min(1, Math.max(0, v));
      v = Math.pow(v, ig);
      if (invert) v = 1 - v;
      return v * 255;
    };
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i], g = d[i + 1], b = d[i + 2];
      const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      d[i] = curve(l + (r - l) * saturation);
      d[i + 1] = curve(l + (g - l) * saturation);
      d[i + 2] = curve(l + (b - l) * saturation);
    }
  }
}

// ---------------------------------------------------------------------------
// Palette quantization helpers
// ---------------------------------------------------------------------------

// Nearest color in flat palette [r,g,b,...] (0..255). Returns index*3.
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
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Error diffusion dithering with arbitrary palette.
// strength: 0..1 scales how much error is propagated.
// serpentine: alternate scan direction per row (reduces worm artifacts).
// ---------------------------------------------------------------------------
export function errorDiffusion(imageData, palette, kernelId, { strength = 1, serpentine = true, bias = 0 } = {}) {
  const { kernel } = DIFFUSION_KERNELS[kernelId] || DIFFUSION_KERNELS.floyd;
  const { width: w, height: h, data: d } = imageData;
  const n = palette.length / 3;
  const b = bias * 255; // threshold bias, mirrors u_bias in the shader

  // Work buffers in float to carry sub-integer error.
  const buf = new Float32Array(w * h * 3);
  for (let i = 0, j = 0; i < d.length; i += 4, j += 3) {
    buf[j] = d[i];
    buf[j + 1] = d[i + 1];
    buf[j + 2] = d[i + 2];
  }

  for (let y = 0; y < h; y++) {
    const reverse = serpentine && (y & 1) === 1;
    const xStart = reverse ? w - 1 : 0;
    const xEnd = reverse ? -1 : w;
    const xStep = reverse ? -1 : 1;

    for (let x = xStart; x !== xEnd; x += xStep) {
      const j = (y * w + x) * 3;
      const r = Math.min(255, Math.max(0, buf[j] + b));
      const g = Math.min(255, Math.max(0, buf[j + 1] + b));
      const bl = Math.min(255, Math.max(0, buf[j + 2] + b));
      const pi = nearestIndex(palette, n, r, g, bl);
      const pr = palette[pi], pg = palette[pi + 1], pb = palette[pi + 2];

      const er = (r - pr) * strength;
      const eg = (g - pg) * strength;
      const eb = (bl - pb) * strength;

      buf[j] = pr;
      buf[j + 1] = pg;
      buf[j + 2] = pb;

      for (const [dx, dy, wgt] of kernel) {
        const nx = x + (reverse ? -dx : dx);
        const ny = y + dy;
        if (nx < 0 || nx >= w || ny >= h) continue;
        const k = (ny * w + nx) * 3;
        buf[k] += er * wgt;
        buf[k + 1] += eg * wgt;
        buf[k + 2] += eb * wgt;
      }
    }
  }

  for (let i = 0, j = 0; i < d.length; i += 4, j += 3) {
    d[i] = buf[j];
    d[i + 1] = buf[j + 1];
    d[i + 2] = buf[j + 2];
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
  const ox = ((Math.floor(offsetX) % size) + size) % size;
  const oy = ((Math.floor(offsetY) % size) + size) % size;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const t = m[((y + oy) % size) * size + ((x + ox) % size)] - 0.5 + bias;
      const r = d[i] + t * spread;
      const g = d[i + 1] + t * spread;
      const b = d[i + 2] + t * spread;
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

export function whiteNoiseDither(imageData, palette, { strength = 1, bias = 0 } = {}) {
  const { width: w, height: h, data: d } = imageData;
  const n = palette.length / 3;
  const spread = (255 * strength) / Math.max(1, n - 1) * 1.5;
  const cl = (v) => Math.min(255, Math.max(0, v));
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const t = hash12(x, y) - 0.5 + bias;
      const pi = nearestIndex(palette, n, cl(d[i] + t * spread), cl(d[i + 1] + t * spread), cl(d[i + 2] + t * spread));
      d[i] = palette[pi];
      d[i + 1] = palette[pi + 1];
      d[i + 2] = palette[pi + 2];
    }
  }
}

export function halftoneDither(imageData, palette, { scale = 6, angle = 45, bias = 0, line = false } = {}) {
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
      const px = ca * x - sa * y;
      const py = sa * x + ca * y;
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
