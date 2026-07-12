import test from 'node:test';
import assert from 'node:assert/strict';

import { AsciiRenderer } from '../js/engine/ascii.js';
import { CELL_EFFECTS } from '../js/effects/cells.js';
import { CELL_SIZE_MIN } from '../js/state.js';

class AsciiContext {
  constructor(canvas) {
    this.canvas = canvas;
    this.ops = [];
    this.fillStyle = '#000';
    this.globalAlpha = 1;
  }

  measureText(text) {
    this.ops.push(['measureText', text, this.font]);
    return { width: 8 };
  }

  fillRect(...args) {
    this.ops.push(['fillRect', ...args, this.fillStyle, this.globalAlpha]);
  }

  fillText(...args) {
    this.ops.push(['fillText', ...args, this.fillStyle, this.font, this.globalAlpha]);
  }

  getImageData(_x, _y, width, height) {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) data[(y * width + x) * 4 + 3] = (x * 17 + y * 31) & 255;
    }
    return { width, height, data };
  }
}

class AsciiCanvas {
  constructor() {
    this.width = 300;
    this.height = 150;
    this.context = new AsciiContext(this);
  }

  getContext() {
    return this.context;
  }
}

globalThis.document = { createElement: () => new AsciiCanvas() };

function imageData(width, height, phase = 0) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let p = 0; p < width * height; p++) {
    const i = p * 4;
    data[i] = (p * 37 + phase) & 255;
    data[i + 1] = (p * 61 + 29 + phase) & 255;
    data[i + 2] = (p * 19 + 83 + phase) & 255;
    data[i + 3] = 255;
  }
  return { width, height, data };
}

const asciiBase = {
  chars: '@ .',
  cellSize: 8,
  font: { family: 'Mock Mono', bold: false },
  fg: '#e0e0e0',
  bg: '#101010',
  invertRamp: false,
  dither: 'none',
  edgeStrength: 0,
  dotThreshold: 0.5,
  autoContrast: false,
  shapeSet: 'ascii',
};

test('ASCII metadata capture defaults on and can be skipped without changing drawing', () => {
  const cases = [
    [imageData(5, 4), { renderer: 'ramp', colorMode: 'mono' }],
    [imageData(5, 4), { renderer: 'ramp', colorMode: 'fg' }],
    [imageData(8, 8), { renderer: 'shape', colorMode: 'bg' }],
    [imageData(6, 4), { renderer: 'quadrant', colorMode: 'bg' }],
    [imageData(6, 8), { renderer: 'braille', colorMode: 'mono' }],
    [imageData(6, 8), { renderer: 'braille', colorMode: 'fg' }],
  ];

  for (const [image, partial] of cases) {
    const opts = { ...asciiBase, ...partial };
    const captured = new AsciiRenderer();
    const fast = new AsciiRenderer();
    captured.render(image, opts);
    fast.render(image, { ...opts, captureMetadata: false });

    assert.deepEqual(fast.canvas.context.ops, captured.canvas.context.ops);
    assert.ok(captured.lastText.length > 0);
    assert.ok(Array.isArray(captured.lastGrid));
    assert.equal(fast.lastText, '');
    assert.equal(fast.lastGrid, null);

    const textSnapshot = captured.lastText;
    const gridSnapshot = captured.lastGrid;
    captured.render(imageData(image.width, image.height, 47), { ...opts, captureMetadata: false });
    assert.equal(captured.lastText, textSnapshot);
    assert.equal(captured.lastGrid, gridSnapshot);
  }
});

class Gradient {
  constructor() {
    this.stops = [];
  }

  addColorStop(...args) {
    this.stops.push(args);
  }
}

class CellContext {
  constructor() {
    this.fillStyle = '#000';
    this.strokeStyle = '#000';
    this.globalAlpha = 1;
    this.globalCompositeOperation = 'source-over';
    this.path = [];
    this.ops = [];
  }

  beginPath() { this.path = []; }
  arc(...args) { this.path.push(['arc', ...args]); }
  arcTo(...args) { this.path.push(['arcTo', ...args]); }
  moveTo(...args) { this.path.push(['moveTo', ...args]); }
  lineTo(...args) { this.path.push(['lineTo', ...args]); }
  rect(...args) { this.path.push(['rect', ...args]); }
  roundRect(...args) { this.path.push(['roundRect', ...args]); }
  closePath() { this.path.push(['closePath']); }
  fillRect(...args) { this.ops.push({ kind: 'fillRect', args, style: this.fillStyle, alpha: this.globalAlpha }); }
  fill() { this.ops.push({ kind: 'fill', path: [...this.path], style: this.fillStyle, alpha: this.globalAlpha }); }
  stroke() { this.ops.push({ kind: 'stroke', path: [...this.path], style: this.strokeStyle, alpha: this.globalAlpha }); }
  setTransform(...args) { this.ops.push({ kind: 'transform', args }); }
  createRadialGradient() { return new Gradient(); }
}

class RasterCellContext extends CellContext {
  createImageData(width, height) {
    return { width, height, data: new Uint8ClampedArray(width * height * 4) };
  }

  putImageData(image, x, y) {
    this.lastImage = image;
    this.ops.push({ kind: 'putImageData', image, x, y });
  }
}

const oneCellOpts = {
  cell: 10,
  fill: 1,
  scatter: 0,
  colorMode: 'source',
  ink: '#101010',
  paper: '#808080',
  width: 10,
  height: 10,
};

const grayCell = {
  cols: 1,
  rows: 1,
  data: new Uint8ClampedArray([128, 128, 128, 255]),
};

function rgbChannels(css) {
  return css.match(/\d+/g).map(Number);
}

test('Cell modes use quality-preserving per-effect minimum sizes', () => {
  assert.deepEqual(CELL_SIZE_MIN, {
    dots: 3,
    lego: 4,
    voxel: 6,
    led: 6,
    lattice: 6,
    mosaic: 3,
  });
});

test('Compact LEGO preview snaps adjacent bodies edge-to-edge without grout strokes', () => {
  const ctx = new CellContext();
  const grid = {
    cols: 3,
    rows: 1,
    data: new Uint8ClampedArray([
      32, 96, 224, 255,
      224, 224, 224, 255,
      32, 96, 224, 255,
    ]),
  };
  CELL_EFFECTS.lego.render(ctx, grid, {
    ...oneCellOpts,
    cell: 4.26,
    compact: true,
    width: 13,
    height: 4,
  });

  const transforms = ctx.ops.filter((op) => op.kind === 'transform');
  assert.deepEqual(transforms.slice(0, 3).map((op) => op.args), [
    [4, 0, 0, 4, 0, 0],
    [5, 0, 0, 4, 4, 0],
    [4, 0, 0, 4, 9, 0],
  ]);
  assert.equal(ctx.ops.filter((op) => op.kind === 'fillRect').length, 4); // background + 3 bodies
  assert.equal(ctx.ops.filter((op) => op.kind === 'stroke').length, 0);
  assert.ok(ctx.ops.filter((op) => op.kind === 'fill').every((op) =>
    op.path.length === 1 && op.path[0][0] === 'arc'));
});

test('Fine LEGO raster path covers fractional adjacent cells without black seams', () => {
  const ctx = new RasterCellContext();
  const grid = {
    cols: 2,
    rows: 1,
    data: new Uint8ClampedArray([32, 96, 224, 255, 224, 224, 224, 255]),
  };
  CELL_EFFECTS.lego.render(ctx, grid, {
    ...oneCellOpts,
    cell: 4.26,
    compact: true,
    width: 9,
    height: 4,
  });

  assert.equal(ctx.ops.filter((op) => op.kind === 'putImageData').length, 1);
  const pixels = ctx.lastImage.data;
  for (let i = 0; i < pixels.length; i += 4) {
    assert.equal(pixels[i + 3], 255);
    assert.notDeepEqual([...pixels.subarray(i, i + 3)], [16, 16, 16]);
  }
});

test('Fine Dots and Mosaic use one reused bitmap commit instead of per-cell paths', () => {
  const grid = {
    cols: 2,
    rows: 1,
    data: new Uint8ClampedArray([192, 96, 32, 255, 224, 224, 224, 255]),
  };
  for (const mode of ['dots', 'mosaic']) {
    const ctx = new RasterCellContext();
    const opts = {
      ...oneCellOpts,
      cell: 3,
      compact: true,
      width: 6,
      height: 3,
    };
    CELL_EFFECTS[mode].render(ctx, grid, opts);
    const firstImage = ctx.lastImage;
    CELL_EFFECTS[mode].render(ctx, grid, opts);
    assert.equal(ctx.lastImage, firstImage, `${mode} should reuse its ImageData`);
    assert.equal(ctx.ops.filter((op) => op.kind === 'putImageData').length, 2, mode);
    assert.equal(ctx.ops.filter((op) => op.kind === 'fill' || op.kind === 'fillRect').length, 0, mode);
  }
});

test('Dots maps luminance linearly to circle area', () => {
  const ctx = new CellContext();
  CELL_EFFECTS.dots.render(ctx, grayCell, oneCellOpts);
  const dot = ctx.ops.find((op) => op.kind === 'fill' && op.path.some((part) => part[0] === 'arc'));
  const arc = dot.path.find((part) => part[0] === 'arc');
  const expected = 10 * 0.5 * 0.85 * Math.sqrt(128 / 255);
  assert.ok(Math.abs(arc[3] - expected) < 1e-12);
  assert.ok(arc[3] <= 10 * 0.5 * 0.85);
});

test('LED preserves source RGB while retaining duotone luminance shading', () => {
  const sourceCtx = new CellContext();
  const duoCtx = new CellContext();
  CELL_EFFECTS.led.render(sourceCtx, grayCell, oneCellOpts);
  CELL_EFFECTS.led.render(duoCtx, grayCell, { ...oneCellOpts, colorMode: 'duotone' });

  const roundedPixel = (ctx) => ctx.ops.find((op) =>
    op.kind === 'fill' && op.path.some((part) => part[0] === 'roundRect'));
  assert.deepEqual(rgbChannels(roundedPixel(sourceCtx).style), [128, 128, 128]);
  assert.deepEqual(rgbChannels(roundedPixel(duoCtx).style), [64, 64, 64]);
  assert.equal(sourceCtx.globalAlpha, 1);
  assert.equal(duoCtx.globalAlpha, 1);
});

test('Lattice edge alpha retains CSS rgba 8-bit rounding without string allocation', () => {
  const ctx = new CellContext();
  const grid = {
    cols: 2,
    rows: 1,
    data: new Uint8ClampedArray([255, 255, 255, 255, 255, 255, 255, 255]),
  };
  CELL_EFFECTS.lattice.render(ctx, grid, {
    ...oneCellOpts,
    width: 20,
    nodeShape: 'circle',
  });

  const edge = ctx.ops.find((op) => op.kind === 'stroke');
  const rawAlpha = (1 - 10 / 20) * 0.65;
  assert.equal(edge.style, 'rgb(255,255,255)');
  assert.equal(edge.alpha, Math.round(rawAlpha * 255) / 255);
  assert.equal(ctx.globalAlpha, 1);
});
