// Single source of truth for all tunable parameters.

export const MODES = [
  { id: 'dither', name: 'Dither' },
  { id: 'ascii', name: 'ASCII' },
  { id: 'dots', name: 'Dots' },
  { id: 'lego', name: 'LEGO' },
  { id: 'voxel', name: 'Voxel' },
  { id: 'led', name: 'LED' },
  { id: 'lattice', name: 'Lattice' },
  { id: 'mosaic', name: 'Mosaic' },
];

export const DEFAULTS = {
  mode: 'dither',

  // --- dither mode ---
  algorithm: 'floyd',      // see ALGORITHMS in engine.js
  pixelSize: 4,            // 1..32 downsample factor
  ditherStrength: 1,       // 0..1
  serpentine: true,
  threshold: 0.5,          // 0..1 bias
  halftoneScale: 6,        // px, halftone modes
  halftoneAngle: 45,       // deg
  paletteId: 'bw',
  customColors: ['#0a0a0a', '#f2f2f2'],

  // --- adjustments (all modes) ---
  brightness: 0,           // -1..1
  contrast: 0,             // -1..1
  gamma: 1,                // 0.2..3
  saturation: 1,           // 0..2
  hue: 0,                  // 0..360 deg
  sepia: 0,                // 0..1
  blur: 0,                 // 0..10 px (pre-blur)
  invert: false,
  grayscale: false,

  // --- ascii mode ---
  ascii: {
    renderer: 'ramp',      // 'ramp' | 'shape' | 'quadrant' | 'braille'
    shapeSet: 'ascii',     // shape matching glyph pool: 'ascii' | 'blocks'
    rampId: 'classic',
    customChars: '@#+-. ',
    cellSize: 12,          // 4..32 px
    fontId: 'menlo',       // see FONTS in engine/ascii.js
    bold: false,
    colorMode: 'mono',     // 'mono' | 'fg' | 'bg'
    fg: '#e8e8e8',
    bg: '#0a0a0c',
    invertRamp: false,     // base mapping is bright=dense (right for dark backgrounds)
    dither: 'floyd',       // 'none' | 'floyd' | 'bayer' — level/dot dithering
    dotThreshold: 0.5,     // quadrant & braille dot cutoff
    edgeStrength: 0,       // 0..1 Sobel edge-directed glyphs (ramp & shape)
    autoContrast: true,    // percentile luminance stretch
  },

  // --- cell effects (dots/lego/voxel/led/lattice/mosaic) ---
  cells: {
    size: 14,              // px per cell, 6..40
    fill: 0.75,            // 0..1 coverage
    scatter: 0,            // 0..1 jitter
    colorMode: 'source',   // 'source' | 'duotone'
    ink: '#0b0b10',        // background / dark
    paper: '#e8e8e8',      // foreground when duotone
    nodeShape: 'circle',   // lattice: circle|square|diamond|cross
  },

  // --- post fx (all modes) ---
  fx: {
    vignette: 0,           // 0..1
    scanlines: 0,          // 0..1
    grain: 0,              // 0..1
    chromatic: 0,          // 0..20 px shift
    glow: 0,               // 0..1
  },

  // --- animation (all modes; works on still images too) ---
  anim: {
    style: 'none',         // none|breathe|pulse|sweep|wave|flow|shimmer
    speed: 3,              // 1..10 (cycles/sec = speed * 0.15)
    intensity: 0.6,        // 0..1
    direction: 'right',    // flow: right|left|up|down|downright|upleft
  },
};

export function createState() {
  return structuredClone(DEFAULTS);
}

// Deep-merge a partial preset into state (arrays replaced, objects merged).
export function applyParams(state, params) {
  for (const [k, v] of Object.entries(params)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      state[k] = { ...state[k], ...v };
    } else {
      state[k] = Array.isArray(v) ? [...v] : v;
    }
  }
  return state;
}

export function resetState(state) {
  return applyParams(state, structuredClone(DEFAULTS));
}
