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

// Smallest size that still preserves each renderer's visual identity. These
// are mode-specific: dots/mosaic survive finer grids, while lattice becomes a
// line field below 6px. UI and engine both use this table so presets/history
// cannot bypass the quality floor.
export const CELL_SIZE_MIN = Object.freeze({
  dots: 3,
  lego: 4,
  voxel: 6,
  led: 6,
  lattice: 6,
  mosaic: 3,
});

const MODE_SIZE_RANGES = Object.freeze({
  dither: Object.freeze({ min: 1, max: 32, field: 'pixelSize' }),
  ascii: Object.freeze({ min: 4, max: 32, field: 'ascii.cellSize' }),
  dots: Object.freeze({ min: CELL_SIZE_MIN.dots, max: 40, field: 'cells.size' }),
  lego: Object.freeze({ min: CELL_SIZE_MIN.lego, max: 40, field: 'cells.size' }),
  voxel: Object.freeze({ min: CELL_SIZE_MIN.voxel, max: 40, field: 'cells.size' }),
  led: Object.freeze({ min: CELL_SIZE_MIN.led, max: 40, field: 'cells.size' }),
  lattice: Object.freeze({ min: CELL_SIZE_MIN.lattice, max: 40, field: 'cells.size' }),
  mosaic: Object.freeze({ min: CELL_SIZE_MIN.mosaic, max: 40, field: 'cells.size' }),
});

const clamp = (value, min, max) => Math.min(max, Math.max(min, Number(value)));

export function modeSizeRange(mode) {
  const range = MODE_SIZE_RANGES[mode];
  if (!range) throw new RangeError(`unknown mode: ${mode}`);
  return { ...range };
}

function readModeSize(state, mode) {
  if (mode === 'dither') return state.pixelSize;
  if (mode === 'ascii') return state.ascii.cellSize;
  return state.cells.size;
}

function writeModeSize(state, mode, value) {
  if (mode === 'dither') state.pixelSize = value;
  else if (mode === 'ascii') state.ascii.cellSize = value;
  else state.cells.size = value;
}

// Carry the visible scale between renderers without touching unrelated or
// dormant settings. A quality floor maps to the next renderer's own floor;
// every other value is preserved and only clamped when the target requires it.
export function transitionMode(state, nextMode) {
  const previousMode = state.mode;
  if (previousMode === nextMode) return false;
  const previousRange = modeSizeRange(previousMode);
  const nextRange = modeSizeRange(nextMode);
  const previousValue = clamp(readModeSize(state, previousMode), previousRange.min, previousRange.max);
  const nextValue = previousValue <= previousRange.min
    ? nextRange.min
    : clamp(previousValue, nextRange.min, nextRange.max);
  writeModeSize(state, nextMode, nextValue);
  state.mode = nextMode;
  return true;
}

// Algorithm-specific controls are deliberately dormant rather than reset.
// Switching back to an algorithm restores the exact values the user left.
export function transitionAlgorithm(state, nextAlgorithm) {
  if (state.algorithm === nextAlgorithm) return false;
  state.algorithm = nextAlgorithm;
  return true;
}

export const DEFAULTS = {
  mode: 'dither',

  // --- dither mode ---
  algorithm: 'floyd',      // see ALGORITHMS in engine.js
  pixelSize: 4,            // 1..32 downsample factor
  ditherStrength: 1,       // 0..1
  serpentine: true,
  threshold: 0.5,          // 0..1 bias
  smoothness: 0,           // 0..1 GPU dithers: supersample+box-resolve to tone (0 = crisp 1-bit)
  temporal: 0,             // 0..1 video: motion-gated temporal smoothing (0 = off)
  videoDenoise: 0,         // 0..1 video: pre-dither tent-blur denoise (flat-area cleanup)
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
    edgeStrength: 0,       // 0..1 Sobel edge-directed glyphs (ramp renderer only)
    autoContrast: true,    // percentile luminance stretch
  },

  // --- cell effects (dots/lego/voxel/led/lattice/mosaic) ---
  cells: {
    size: 14,              // px per cell; minimum depends on mode (3..6)
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
    style: 'none',         // none|breathe|pulse|sweep|wave|flow|shimmer|command|fluted|gravity
    speed: 3,              // 1..10 (cycles/sec = speed * 0.15)
    intensity: 0.6,        // 0..1
    direction: 'right',    // flow: right|left|up|down|downright|upleft
    gravityMode: 'drizzle', // drizzle|cascade|flutter|collapse
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
