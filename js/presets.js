// Preset looks + randomized look generator.
// Each preset carries a PARTIAL params object; the app resets state to
// DEFAULTS before applying, so presets only list what they change.

export const PRESETS = [
  {
    id: 'terminal',
    name: 'Terminal',
    params: {
      mode: 'dither',
      algorithm: 'floyd',
      paletteId: 'green',
      pixelSize: 3,
      contrast: 0.15,
      fx: { scanlines: 0.45, glow: 0.25 },
    },
  },
  {
    id: 'gameboy',
    name: 'Game Boy',
    params: {
      mode: 'dither',
      algorithm: 'bayer4',
      paletteId: 'gameboy',
      pixelSize: 6,
      contrast: 0.1,
    },
  },
  {
    id: 'newsprint',
    name: 'Newsprint',
    params: {
      mode: 'dither',
      algorithm: 'halftone',
      paletteId: 'paperwhite',
      pixelSize: 2,
      halftoneScale: 7,
      halftoneAngle: 45,
      contrast: 0.35,
      grayscale: true,
    },
  },
  {
    id: 'noir',
    name: 'Noir',
    params: {
      mode: 'dither',
      algorithm: 'floyd',
      paletteId: 'bw',
      pixelSize: 3,
      contrast: 0.3,
      brightness: -0.05,
      grayscale: true,
      fx: { vignette: 0.5, grain: 0.35 },
    },
  },
  {
    id: 'obra-dinn',
    name: 'Obra Dinn',
    params: {
      mode: 'dither',
      algorithm: 'bluenoise',
      paletteId: 'obra',
      pixelSize: 2,
      contrast: 0.15,
      gamma: 1.1,
    },
  },
  {
    id: 'arcade',
    name: 'Arcade',
    params: {
      mode: 'dither',
      algorithm: 'bayer2',
      paletteId: 'pico8',
      pixelSize: 6,
      contrast: 0.2,
      saturation: 1.4,
    },
  },
  {
    id: 'vaporwave',
    name: 'Vaporwave',
    params: {
      mode: 'dither',
      algorithm: 'bayer8',
      paletteId: 'vaporwave',
      pixelSize: 4,
      saturation: 1.3,
      contrast: 0.1,
      fx: { chromatic: 4, glow: 0.25 },
    },
  },
  {
    id: 'evangelion',
    name: 'Evangelion',
    params: {
      mode: 'dither',
      algorithm: 'bayer4',
      paletteId: 'command',
      pixelSize: 3,
      threshold: 0.47,
      contrast: 0.3,
      gamma: 0.92,
      saturation: 1.15,
      anim: { style: 'command', speed: 1.5, intensity: 0.82 },
      fx: { vignette: 0.22, scanlines: 0.26, grain: 0.1, chromatic: 1, glow: 0.18 },
    },
  },
  {
    id: 'retro-crt',
    name: 'Retro CRT',
    params: {
      mode: 'dither',
      algorithm: 'floyd',
      paletteId: 'rgb3',
      pixelSize: 3,
      contrast: 0.15,
      saturation: 1.2,
      fx: { scanlines: 0.5, chromatic: 3, glow: 0.35, vignette: 0.25 },
    },
  },
  {
    id: 'matrix',
    name: 'Matrix',
    params: {
      mode: 'ascii',
      contrast: 0.2,
      ascii: {
        rampId: 'binary',
        cellSize: 10,
        colorMode: 'mono',
        fg: '#33ff33',
        bg: '#000800',
      },
      fx: { glow: 0.35, scanlines: 0.2 },
    },
  },
  {
    id: 'typewriter',
    name: 'Typewriter',
    params: {
      mode: 'ascii',
      contrast: 0.1,
      ascii: {
        rampId: 'detailed',
        cellSize: 11,
        colorMode: 'mono',
        fg: '#26221c',
        bg: '#efe8d8',
        invertRamp: true,
      },
      fx: { grain: 0.15 },
    },
  },
  {
    id: 'braille',
    name: 'Braille',
    params: {
      mode: 'ascii',
      contrast: 0.15,
      ascii: {
        rampId: 'dots',
        cellSize: 8,
        renderer: 'braille',
        colorMode: 'mono',
        fg: '#e8e8e8',
        bg: '#0a0a0c',
      },
    },
  },
  {
    id: 'lego-brick',
    name: 'LEGO Brick',
    params: {
      mode: 'lego',
      contrast: 0.15,
      saturation: 1.35,
      cells: { size: 18, fill: 1, colorMode: 'source' },
    },
  },
  {
    id: 'voxel-city',
    name: 'Voxel City',
    params: {
      mode: 'voxel',
      contrast: 0.2,
      saturation: 1.15,
      cells: { size: 20, fill: 0.9, colorMode: 'source' },
      fx: { vignette: 0.2 },
    },
  },
  {
    id: 'led-wall',
    name: 'LED Wall',
    params: {
      mode: 'led',
      contrast: 0.25,
      saturation: 1.3,
      cells: { size: 12, fill: 0.65, colorMode: 'source', ink: '#050505' },
      fx: { glow: 0.6 },
    },
  },
  {
    id: 'constellation',
    name: 'Constellation',
    params: {
      mode: 'lattice',
      contrast: 0.2,
      cells: {
        size: 20,
        fill: 0.55,
        scatter: 0.25,
        colorMode: 'duotone',
        ink: '#060b21',
        paper: '#a9d4ff',
        nodeShape: 'circle',
      },
      fx: { glow: 0.3, vignette: 0.2 },
    },
  },
  {
    id: 'mosaic-tile',
    name: 'Mosaic Tile',
    params: {
      mode: 'mosaic',
      contrast: 0.1,
      saturation: 1.2,
      cells: { size: 16, fill: 0.95, colorMode: 'source', ink: '#111111' },
    },
  },
  {
    id: 'amber-tube',
    name: 'Amber Tube',
    params: {
      mode: 'dither',
      algorithm: 'atkinson',
      paletteId: 'amber',
      pixelSize: 3,
      contrast: 0.15,
      fx: { vignette: 0.4, glow: 0.3, scanlines: 0.2 },
    },
  },
  {
    id: 'riso-print',
    name: 'Riso Print',
    params: {
      mode: 'dither',
      algorithm: 'bayer4',
      paletteId: 'custom',
      customColors: ['#f7f2e6', '#ff5e5b', '#0078bf'],
      pixelSize: 4,
      contrast: 0.2,
      saturation: 1.1,
      fx: { grain: 0.2 },
    },
  },
  {
    id: 'nokia-lcd',
    name: 'Nokia LCD',
    params: {
      mode: 'dither',
      algorithm: 'bayer2',
      paletteId: 'nokia',
      pixelSize: 5,
      contrast: 0.2,
    },
  },
  {
    id: 'ink-dots',
    name: 'Ink Dots',
    params: {
      mode: 'dots',
      contrast: 0.25,
      grayscale: true,
      cells: {
        size: 12,
        fill: 0.8,
        colorMode: 'duotone',
        ink: '#f2ede2',
        paper: '#12100c',
      },
    },
  },
];

// ---------------------------------------------------------------------------
// shuffleParams() — one-shot randomized look generator (not per-frame code).
// ---------------------------------------------------------------------------

const SHUFFLE_ALGOS = [
  'floyd', 'atkinson', 'jarvis', 'stucki', 'burkes',
  'sierra3', 'sierra2', 'sierralite', 'falsefloyd',
  'bayer2', 'bayer4', 'bayer8', 'cluster4', 'cluster8',
  'bluenoise', 'whitenoise', 'halftone', 'halftone-line',
];

// 'custom' excluded (needs colors), 'wb' excluded (usually reads as a glitch).
const SHUFFLE_PALETTES = [
  'bw', 'gray4', 'gray8', 'gray16', 'gameboy', 'gbpocket', 'gblight',
  'amber', 'green', 'blueterm', 'paperwhite', 'macintosh', 'cga1', 'cga2',
  'cga16', 'ega', 'c64', 'zx', 'nes', 'pico8', 'apple2', 'teletext',
  'vaporwave', 'command', 'sepia', 'sunset', 'nokia', 'obra', 'cmyk', 'rgb3',
];

const SHUFFLE_RAMPS = ['classic', 'detailed', 'blocks', 'minimal', 'dots', 'binary', 'slashes'];
const SHUFFLE_SHAPES = ['circle', 'square', 'diamond', 'cross'];

const DUOTONE_PAIRS = [
  { ink: '#0b0b10', paper: '#e8e8e8' },
  { ink: '#060b21', paper: '#a9d4ff' },
  { ink: '#001500', paper: '#33ff33' },
  { ink: '#1a0f00', paper: '#ffb000' },
  { ink: '#1a0030', paper: '#ff79c6' },
  { ink: '#001219', paper: '#2ed6cf' },
  { ink: '#f2ede2', paper: '#12100c' },
];

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function rand(min, max) {
  return min + Math.random() * (max - min);
}

function randInt(min, max) {
  return Math.floor(rand(min, max + 1));
}

function round2(v) {
  return Math.round(v * 100) / 100;
}

export function shuffleParams() {
  // Mode: 50% dither, the rest split across the other modes.
  const mode = Math.random() < 0.5
    ? 'dither'
    : pick(['ascii', 'dots', 'lego', 'voxel', 'led', 'lattice', 'mosaic']);

  const params = {
    mode,
    algorithm: pick(SHUFFLE_ALGOS),
    paletteId: pick(SHUFFLE_PALETTES),
    pixelSize: randInt(2, 10),
    contrast: round2(rand(0, 0.4)),
  };

  // Occasional saturation drift keeps color palettes from feeling flat.
  if (Math.random() < 0.4) params.saturation = round2(rand(0.8, 1.5));

  if (mode === 'ascii') {
    const dark = Math.random() < 0.75; // mostly light-on-dark
    const duo = pick(DUOTONE_PAIRS);
    params.ascii = {
      renderer: pick(['ramp', 'ramp', 'ramp', 'shape', 'quadrant', 'braille']),
      rampId: pick(SHUFFLE_RAMPS),
      cellSize: randInt(8, 16),
      colorMode: pick(['mono', 'mono', 'fg', 'bg']),
      fg: dark ? duo.paper : duo.ink,
      bg: dark ? duo.ink : duo.paper,
      invertRamp: !dark,
      dither: pick(['none', 'floyd', 'floyd', 'bayer']),
    };
  } else if (mode !== 'dither') {
    const cells = {
      size: randInt(10, 24),
      fill: round2(rand(0.45, 1)),
      colorMode: Math.random() < 0.5 ? 'source' : 'duotone',
    };
    if (cells.colorMode === 'duotone') {
      const duo = pick(DUOTONE_PAIRS);
      cells.ink = duo.ink;
      cells.paper = duo.paper;
    }
    if (mode === 'lattice') {
      cells.nodeShape = pick(SHUFFLE_SHAPES);
      cells.scatter = round2(rand(0, 0.3));
    }
    params.cells = cells;
  }

  // 30% chance of a light post-FX dusting.
  if (Math.random() < 0.3) {
    const fx = {};
    const which = pick(['scanlines', 'grain', 'vignette']);
    fx[which] = round2(rand(0.2, 0.6));
    if (Math.random() < 0.5) {
      const extra = pick(['scanlines', 'grain', 'vignette']);
      if (extra !== which) fx[extra] = round2(rand(0.2, 0.6));
    }
    params.fx = fx;
  }

  return params;
}

// ---------------------------------------------------------------------------
// Animated looks (Animation section drives these; stills export as loops)
// ---------------------------------------------------------------------------
PRESETS.push(
  {
    id: 'signal-drift',
    name: 'Signal Drift',
    params: {
      mode: 'dither',
      algorithm: 'bayer8',
      paletteId: 'gray4',
      pixelSize: 3,
      contrast: 0.15,
      anim: { style: 'flow', speed: 4, intensity: 0.7, direction: 'down' },
      fx: { scanlines: 0.35, chromatic: 2 },
    },
  },
  {
    id: 'heartbeat',
    name: 'Heartbeat',
    params: {
      mode: 'led',
      cells: { size: 12, fill: 0.85, colorMode: 'source' },
      anim: { style: 'pulse', speed: 3, intensity: 0.8 },
      fx: { glow: 0.35 },
    },
  },
  {
    id: 'tidal',
    name: 'Tidal',
    params: {
      mode: 'dither',
      algorithm: 'bayer4',
      paletteId: 'blueterm',
      pixelSize: 3,
      contrast: 0.1,
      anim: { style: 'wave', speed: 2.5, intensity: 0.55 },
    },
  },
);

// ---------------------------------------------------------------------------
// New-generation ASCII looks (shape matching & full-color blocks)
// ---------------------------------------------------------------------------
PRESETS.push(
  {
    id: 'structural',
    name: 'Structural',
    params: {
      mode: 'ascii',
      contrast: 0.1,
      ascii: {
        renderer: 'shape',
        shapeSet: 'ascii',
        cellSize: 10,
        colorMode: 'mono',
        fg: '#d8d8e0',
        bg: '#0a0a0c',
      },
    },
  },
  {
    id: 'textmode',
    name: 'Textmode Color',
    params: {
      mode: 'ascii',
      saturation: 1.15,
      ascii: {
        renderer: 'shape',
        shapeSet: 'blocks',
        cellSize: 9,
        colorMode: 'bg',
      },
    },
  },
  {
    id: 'mosaic-blocks',
    name: 'Block Mosaic',
    params: {
      mode: 'ascii',
      contrast: 0.05,
      ascii: {
        renderer: 'quadrant',
        cellSize: 10,
        colorMode: 'bg',
      },
    },
  },
);
