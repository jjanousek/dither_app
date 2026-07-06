// Cell-based effect renderers: Dots, LEGO, Voxel, LED, Lattice, Mosaic.
//
// Each render(ctx, grid, o) draws one full frame onto the provided 2D context.
//   grid = { cols, rows, data }  — data is Uint8ClampedArray RGBA, one sample
//          per cell, already brightness/contrast-adjusted.
//   o    = { cell, fill, scatter, colorMode, ink, paper, nodeShape, width, height }
//
// Allocation-conscious: module-level scratch buffers, no per-frame canvas
// creation, and deterministic per-cell jitter (hash of col,row) so video
// frames don't boil.

const LR = 0.2126;
const LG = 0.7152;
const LB = 0.0722;
const TAU = Math.PI * 2;

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

// Cached hex -> [r,g,b]. Bounded cache; colors change rarely.
const hexCache = new Map();
function hexRgb(hex) {
  let c = hexCache.get(hex);
  if (c) return c;
  let s = String(hex);
  if (s.charCodeAt(0) === 35) s = s.slice(1);
  if (s.length === 3) s = s[0] + s[0] + s[1] + s[1] + s[2] + s[2];
  const n = parseInt(s, 16) | 0;
  c = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  if (hexCache.size > 64) hexCache.clear();
  hexCache.set(hex, c);
  return c;
}

// Deterministic per-cell hash in [0,1). Stable across frames.
function hash01(col, row, seed) {
  let h = (Math.imul(col + 1, 374761393) +
           Math.imul(row + 1, 668265263) +
           Math.imul(seed, 974634599)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

// Signed jitter offset in [-amp, +amp].
function jit(col, row, seed, amp) {
  return (hash01(col, row, seed) - 0.5) * 2 * amp;
}

function lumOf(data, i) {
  return (data[i] * LR + data[i + 1] * LG + data[i + 2] * LB) / 255;
}

// Rounded-rect path (fallback for contexts without roundRect).
function rrect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  if (ctx.roundRect) {
    ctx.roundRect(x, y, w, h, r);
    return;
  }
  const k = Math.min(r, w * 0.5, h * 0.5);
  ctx.moveTo(x + k, y);
  ctx.arcTo(x + w, y, x + w, y + h, k);
  ctx.arcTo(x + w, y + h, x, y + h, k);
  ctx.arcTo(x, y + h, x, y, k);
  ctx.arcTo(x, y, x + w, y, k);
  ctx.closePath();
}

function paintBg(ctx, o) {
  ctx.globalAlpha = 1;
  ctx.fillStyle = o.ink;
  ctx.fillRect(0, 0, o.width, o.height);
}

function lighten(v, t) { return Math.round(v + (255 - v) * t); }

// ---------------------------------------------------------------------------
// Dots — circles, brighter = bigger, small specular highlight
// ---------------------------------------------------------------------------

function renderDots(ctx, grid, o) {
  const { cols, rows, data } = grid;
  const cell = o.cell;
  const gate = 1 - o.fill;
  const amp = o.scatter * cell * 0.4;
  const duo = o.colorMode === 'duotone';
  const paper = duo ? hexRgb(o.paper) : null;
  const drawHi = cell >= 8;

  paintBg(ctx, o);

  // Duotone colors are constant — build the strings once.
  const duoFill = duo ? `rgb(${paper[0]},${paper[1]},${paper[2]})` : null;
  const duoHi = duo
    ? `rgb(${Math.min(255, paper[0] + 80)},${Math.min(255, paper[1] + 80)},${Math.min(255, paper[2] + 80)})`
    : null;

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const i = (row * cols + col) * 4;
      const L = lumOf(data, i);
      if (L < gate) continue;

      const rad = cell * 0.5 * 0.85 * (0.5 + L * 0.7);
      if (rad < 0.4) continue;

      let cx = col * cell + cell * 0.5;
      let cy = row * cell + cell * 0.5;
      if (amp > 0) {
        cx += jit(col, row, 1, amp);
        cy += jit(col, row, 2, amp);
      }

      ctx.fillStyle = duo
        ? duoFill
        : `rgb(${data[i]},${data[i + 1]},${data[i + 2]})`;
      ctx.beginPath();
      ctx.arc(cx, cy, rad, 0, TAU);
      ctx.fill();

      if (drawHi) {
        ctx.fillStyle = duo
          ? duoHi
          : `rgb(${Math.min(255, data[i] + 80)},${Math.min(255, data[i + 1] + 80)},${Math.min(255, data[i + 2] + 80)})`;
        ctx.beginPath();
        ctx.arc(cx - rad * 0.4, cy - rad * 0.4, rad * 0.35, 0, TAU);
        ctx.fill();
      }
    }
  }
  ctx.globalAlpha = 1;
}

// ---------------------------------------------------------------------------
// LEGO — rounded brick with vertical shading gradient + center stud
// ---------------------------------------------------------------------------

// Cached unit vertical gradients for the brick body, keyed by 15-bit
// quantized RGB (5 bits/channel — within ±4 of the exact color, invisible on
// a shading gradient). Each entry is a createLinearGradient(0,0,0,1) with the
// base color at 0 and the 20%-darker shade at 1; position/scale come from the
// canvas transform, so the fill matches the old per-cell gradient. Bounded:
// oldest entry evicted once it reaches 4096 (15-bit key caps it at ~32k anyway).
const legoBodyCache = new Map();

function renderLego(ctx, grid, o) {
  const { cols, rows, data } = grid;
  const cell = o.cell;
  const gate = 1 - o.fill;
  const amp = o.scatter * cell * 0.4;
  const duo = o.colorMode === 'duotone';
  const paper = duo ? hexRgb(o.paper) : null;

  paintBg(ctx, o);

  const tile = cell * 0.92;
  const half = tile * 0.5;
  const rx = Math.min(tile * 0.1, 3);
  const studR = cell * 0.22;
  const rimW = Math.max(0.6, studR * 0.15);
  const drawSpec = cell >= 10;

  // Unit-space geometry: each brick is drawn in a (0..1)² space mapped onto
  // the tile via setTransform. The scale is uniform (tile × tile), so arcs
  // stay circular and line widths scale exactly — output is pixel-equivalent
  // to drawing in canvas space, but the body gradient can be cached.
  const rxU = rx / tile;
  const studRU = studR / tile;
  const rimWU = rimW / tile;

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const i = (row * cols + col) * 4;
      const L = lumOf(data, i);
      if (L < gate) continue;

      const r = duo ? paper[0] : data[i];
      const g = duo ? paper[1] : data[i + 1];
      const b = duo ? paper[2] : data[i + 2];

      let cx = col * cell + cell * 0.5;
      let cy = row * cell + cell * 0.5;
      if (amp > 0) {
        cx += jit(col, row, 1, amp);
        cy += jit(col, row, 2, amp);
      }
      const dx = cx - half;
      const dy = cy - half;

      // Duotone: paper hue fixed, luminance drives opacity.
      ctx.globalAlpha = duo ? 0.3 + 0.7 * L : 1;

      // Map the unit square onto this brick; everything below draws in unit
      // space, so the cached unit gradient lands exactly where the old
      // per-cell createLinearGradient(dx, dy, dx, dy + tile) did.
      ctx.setTransform(tile, 0, 0, tile, dx, dy);

      // Brick body: vertical gradient from base color to 20% darker.
      const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
      let body = legoBodyCache.get(key);
      if (!body) {
        // At capacity: evict the oldest entry (Maps iterate in insertion
        // order) instead of wiping the cache mid-frame.
        if (legoBodyCache.size >= 4096) legoBodyCache.delete(legoBodyCache.keys().next().value);
        body = ctx.createLinearGradient(0, 0, 0, 1);
        body.addColorStop(0, `rgb(${r},${g},${b})`);
        body.addColorStop(1, `rgb(${Math.round(r * 0.8)},${Math.round(g * 0.8)},${Math.round(b * 0.8)})`);
        legoBodyCache.set(key, body);
      }
      rrect(ctx, 0, 0, 1, 1, rxU);
      ctx.fillStyle = body;
      ctx.fill();

      // Stud: 15% brighter than the brick.
      ctx.beginPath();
      ctx.arc(0.5, 0.5, studRU, 0, TAU);
      ctx.fillStyle = `rgb(${lighten(r, 0.15)},${lighten(g, 0.15)},${lighten(b, 0.15)})`;
      ctx.fill();

      // Subtle darker rim around the stud.
      ctx.beginPath();
      ctx.arc(0.5, 0.5, studRU * 0.9, 0, TAU);
      ctx.strokeStyle = 'rgba(0,0,0,0.22)';
      ctx.lineWidth = rimWU;
      ctx.stroke();

      // Tiny specular glint on larger cells.
      if (drawSpec) {
        ctx.beginPath();
        ctx.arc(0.5 - studRU * 0.3, 0.5 - studRU * 0.3, studRU * 0.2, 0, TAU);
        ctx.fillStyle = 'rgba(255,255,255,0.35)';
        ctx.fill();
      }
    }
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
}

// ---------------------------------------------------------------------------
// Voxel — isometric cubes, brightness = block height
// ---------------------------------------------------------------------------

function renderVoxel(ctx, grid, o) {
  const { cols, rows, data } = grid;
  const cell = o.cell;
  const gate = 1 - o.fill;
  const amp = o.scatter * cell * 0.4;
  const duo = o.colorMode === 'duotone';
  const paper = duo ? hexRgb(o.paper) : null;

  paintBg(ctx, o);

  const tw = cell;         // iso tile width
  const th = cell * 0.5;   // iso tile height
  const hw = tw * 0.5;
  const hh = th * 0.5;
  const maxH = cell * (0.15 + 1.1);

  // Scatter jitter moves cubes past the ideal grid extents: ±amp in x and
  // ±amp*0.3 in y (see the render loop — the y amplitude is capped there so
  // painter's order holds; reserve space for it here, don't change it there).
  // Add a small margin on top since face strokes overhang the geometry.
  const jitX = amp + 2;
  const jitY = amp * 0.3 + 2;

  // Projected content extents (before offset): a cube's base center sits at
  // y = row*th (+ th/2 stagger for odd cols); its top vertex reaches
  // base - blockH - th and its bottom is the base itself, ±jitY around both.
  const minY = -maxH - th - jitY;
  const maxY = (rows - 1) * th + hh + jitY;
  const offY = Math.max(0, (o.height - (maxY - minY)) * 0.5 - minY);
  // Leftmost geometry is col 0's left face vertex at x = -jitter; shift right
  // so jittered cubes stay on-canvas.
  const offX = Math.max(0, jitX);

  ctx.save();
  ctx.translate(offX, offY);
  ctx.lineJoin = 'round';

  // Back-to-front: rows top-down; within a row draw even columns first, then
  // odd columns (which are staggered half a tile lower, i.e. in front).
  for (let row = 0; row < rows; row++) {
    for (let parity = 0; parity < 2; parity++) {
      for (let col = parity; col < cols; col += 2) {
        const i = (row * cols + col) * 4;
        const L = lumOf(data, i);
        if (L < gate) continue;

        const r = duo ? paper[0] : data[i];
        const g = duo ? paper[1] : data[i + 1];
        const b = duo ? paper[2] : data[i + 2];

        const blockH = cell * (0.15 + L * 1.1);
        let x = col * tw + hw;
        let y = row * th + (parity ? hh : 0);
        if (amp > 0) {
          x += jit(col, row, 1, amp);
          // y-jitter must stay below the 0.25*cell parity stagger (hh) or rear
          // cubes can draw over front ones; 0.3 caps it at 0.24*cell.
          y += jit(col, row, 2, amp * 0.3);
        }

        const topY = y - blockH; // bottom vertex of the top diamond

        // Face colors: top lightened 35%, left base, right darkened 45%.
        const topC = `rgb(${lighten(r, 0.35)},${lighten(g, 0.35)},${lighten(b, 0.35)})`;
        const leftC = `rgb(${r},${g},${b})`;
        const rightC = `rgb(${Math.round(r * 0.55)},${Math.round(g * 0.55)},${Math.round(b * 0.55)})`;

        // Stroke each face with its own fill color to seal antialias seams.
        ctx.lineWidth = 0.75;

        // Top face (diamond).
        ctx.beginPath();
        ctx.moveTo(x, topY - th);
        ctx.lineTo(x + hw, topY - hh);
        ctx.lineTo(x, topY);
        ctx.lineTo(x - hw, topY - hh);
        ctx.closePath();
        ctx.fillStyle = topC;
        ctx.strokeStyle = topC;
        ctx.fill();
        ctx.stroke();

        // Left face.
        ctx.beginPath();
        ctx.moveTo(x - hw, topY - hh);
        ctx.lineTo(x, topY);
        ctx.lineTo(x, topY + blockH);
        ctx.lineTo(x - hw, topY - hh + blockH);
        ctx.closePath();
        ctx.fillStyle = leftC;
        ctx.strokeStyle = leftC;
        ctx.fill();
        ctx.stroke();

        // Right face.
        ctx.beginPath();
        ctx.moveTo(x, topY);
        ctx.lineTo(x + hw, topY - hh);
        ctx.lineTo(x + hw, topY - hh + blockH);
        ctx.lineTo(x, topY + blockH);
        ctx.closePath();
        ctx.fillStyle = rightC;
        ctx.strokeStyle = rightC;
        ctx.fill();
        ctx.stroke();

        // Crisp ridge accent along the top-left edge.
        ctx.beginPath();
        ctx.moveTo(x - hw, topY - hh);
        ctx.lineTo(x, topY - th);
        ctx.strokeStyle = 'rgba(255,255,255,0.25)';
        ctx.lineWidth = 0.6;
        ctx.stroke();
      }
    }
  }
  ctx.restore();
  ctx.globalAlpha = 1;
}

// ---------------------------------------------------------------------------
// LED — bloom pass + rounded pixel pass + dark grid gap lines
// ---------------------------------------------------------------------------

// Cached unit radial gradients for the LED bloom pass, keyed by 15-bit
// quantized RGB (5 bits/channel) so nearby colors share an entry across frames.
// One gradient per color; position/scale come from the canvas transform and
// per-cell luminance is applied via globalAlpha, so output is identical to
// building a gradient per cell. Bounded: oldest entry evicted at 4096.
const glowCache = new Map();

function renderLED(ctx, grid, o) {
  const { cols, rows, data } = grid;
  const cell = o.cell;
  const gate = 1 - o.fill;
  const amp = o.scatter * cell * 0.4;
  const duo = o.colorMode === 'duotone';
  const paper = duo ? hexRgb(o.paper) : null;

  paintBg(ctx, o);

  // ── Pass 1: bloom for bright cells ──
  // Additive blending so overlapping halos accumulate like real light.
  ctx.globalCompositeOperation = 'lighter';
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const i = (row * cols + col) * 4;
      const L = lumOf(data, i);
      if (L < gate || L <= 0.35) continue;

      const r = duo ? paper[0] : data[i];
      const g = duo ? paper[1] : data[i + 1];
      const b = duo ? paper[2] : data[i + 2];

      let cx = col * cell + cell * 0.5;
      let cy = row * cell + cell * 0.5;
      if (amp > 0) {
        cx += jit(col, row, 1, amp);
        cy += jit(col, row, 2, amp);
      }

      const bloomR = cell * (0.8 + L * 1.4);

      // Key on the quantized color drawn (duotone uses parsed o.paper RGB —
      // the packed value covers both modes). 5 bits/channel: ±4 per channel
      // is invisible on a soft radial glow, and the cache hits across frames
      // instead of missing on every slightly-different sampled color.
      const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
      let glow = glowCache.get(key);
      if (!glow) {
        // At capacity: evict the oldest entry (Maps iterate in insertion
        // order) instead of wiping the cache mid-frame.
        if (glowCache.size >= 4096) glowCache.delete(glowCache.keys().next().value);
        // Unit gradient with the per-cell alpha factored out into globalAlpha:
        // stops match the previous per-cell gradient (a, a*0.45, 0) exactly.
        glow = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
        glow.addColorStop(0, `rgba(${r},${g},${b},1)`);
        glow.addColorStop(0.45, `rgba(${r},${g},${b},0.45)`);
        glow.addColorStop(1, `rgba(${r},${g},${b},0)`);
        glowCache.set(key, glow);
      }

      ctx.setTransform(bloomR, 0, 0, bloomR, cx, cy);
      ctx.globalAlpha = L * 0.28;
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(0, 0, 1, 0, TAU);
      ctx.fill();
    }
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;

  // ── Pass 2: rounded pixels ──
  const s = cell * 0.7;
  const corner = Math.min(s * 0.3, 8);
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const i = (row * cols + col) * 4;
      const L = lumOf(data, i);
      if (L < gate) continue;

      const r = duo ? paper[0] : data[i];
      const g = duo ? paper[1] : data[i + 1];
      const b = duo ? paper[2] : data[i + 2];

      let cx = col * cell + cell * 0.5;
      let cy = row * cell + cell * 0.5;
      if (amp > 0) {
        cx += jit(col, row, 1, amp);
        cy += jit(col, row, 2, amp);
      }

      // Pixel intensity scales with luminance (hue preserved).
      const fr = Math.round(r * L);
      const fg = Math.round(g * L);
      const fb = Math.round(b * L);

      rrect(ctx, cx - s * 0.5, cy - s * 0.5, s, s, corner);
      ctx.fillStyle = `rgb(${fr},${fg},${fb})`;
      ctx.fill();
    }
  }

  // ── Grid gap lines (single stroked path) ──
  ctx.strokeStyle = 'rgba(0,0,0,0.82)';
  ctx.lineWidth = Math.max(1, cell * 0.12);
  ctx.beginPath();
  for (let col = 0; col <= cols; col++) {
    const x = col * cell;
    ctx.moveTo(x, 0);
    ctx.lineTo(x, o.height);
  }
  for (let row = 0; row <= rows; row++) {
    const y = row * cell;
    ctx.moveTo(0, y);
    ctx.lineTo(o.width, y);
  }
  ctx.stroke();
  ctx.globalAlpha = 1;
}

// ---------------------------------------------------------------------------
// Lattice — node-and-edge network
// ---------------------------------------------------------------------------

// Module-level scratch, grown as needed and reused every frame.
let latX = new Float32Array(0);
let latY = new Float32Array(0);
let latL = new Float32Array(0);
let latOn = new Uint8Array(0);

function ensureLattice(n) {
  if (latOn.length >= n) return;
  latX = new Float32Array(n);
  latY = new Float32Array(n);
  latL = new Float32Array(n);
  latOn = new Uint8Array(n);
}

const LAT_NEIGHBORS = [[1, 0], [0, 1], [1, 1]]; // right, down, down-right

function renderLattice(ctx, grid, o) {
  const { cols, rows, data } = grid;
  const cell = o.cell;
  const gate = 1 - o.fill;
  const scatterAmp = o.scatter * cell * 0.4;
  const duo = o.colorMode === 'duotone';
  const paper = duo ? hexRgb(o.paper) : null;
  const shape = o.nodeShape || 'circle';

  paintBg(ctx, o);

  const n = cols * rows;
  ensureLattice(n);

  // ── Pass 1: place nodes ──
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const idx = row * cols + col;
      const L = lumOf(data, idx * 4);
      if (L < gate) {
        latOn[idx] = 0;
        continue;
      }
      // Dark cells drift further from their grid seat; scatter adds on top.
      const amp = (1 - L) * cell * 0.3 + scatterAmp;
      latOn[idx] = 1;
      latX[idx] = col * cell + cell * 0.5 + jit(col, row, 1, amp);
      latY[idx] = row * cell + cell * 0.5 + jit(col, row, 2, amp);
      latL[idx] = L;
    }
  }

  // ── Pass 2: edges ──
  const maxDist = cell * 2;
  ctx.lineWidth = 1;
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const idx = row * cols + col;
      if (!latOn[idx]) continue;

      for (let k = 0; k < 3; k++) {
        const nc = col + LAT_NEIGHBORS[k][0];
        const nr = row + LAT_NEIGHBORS[k][1];
        if (nc >= cols || nr >= rows) continue;
        const nIdx = nr * cols + nc;
        if (!latOn[nIdx]) continue;

        const ddx = latX[nIdx] - latX[idx];
        const ddy = latY[nIdx] - latY[idx];
        const dist = Math.sqrt(ddx * ddx + ddy * ddy);
        if (dist >= maxDist) continue;

        const midL = (latL[idx] + latL[nIdx]) * 0.5;
        const alpha = (1 - dist / maxDist) * midL * 0.65;
        if (alpha < 0.01) continue;

        let er, eg, eb;
        if (duo) {
          er = paper[0]; eg = paper[1]; eb = paper[2];
        } else {
          const ia = idx * 4;
          const ib = nIdx * 4;
          er = (data[ia] + data[ib]) >> 1;
          eg = (data[ia + 1] + data[ib + 1]) >> 1;
          eb = (data[ia + 2] + data[ib + 2]) >> 1;
        }
        ctx.strokeStyle = `rgba(${er},${eg},${eb},${alpha})`;
        ctx.beginPath();
        ctx.moveTo(latX[idx], latY[idx]);
        ctx.lineTo(latX[nIdx], latY[nIdx]);
        ctx.stroke();
      }
    }
  }

  // ── Pass 3: nodes ──
  for (let idx = 0; idx < n; idx++) {
    if (!latOn[idx]) continue;
    const L = latL[idx];
    const nr = cell * 0.18 * (0.5 + L);
    if (nr < 0.3) continue;
    const x = latX[idx];
    const y = latY[idx];

    if (duo) {
      ctx.fillStyle = `rgb(${paper[0]},${paper[1]},${paper[2]})`;
    } else {
      const i = idx * 4;
      ctx.fillStyle = `rgb(${data[i]},${data[i + 1]},${data[i + 2]})`;
    }
    ctx.globalAlpha = Math.min(1, 0.35 + L * 0.9);

    ctx.beginPath();
    if (shape === 'square') {
      ctx.rect(x - nr, y - nr, nr * 2, nr * 2);
    } else if (shape === 'diamond') {
      ctx.moveTo(x, y - nr);
      ctx.lineTo(x + nr, y);
      ctx.lineTo(x, y + nr);
      ctx.lineTo(x - nr, y);
      ctx.closePath();
    } else if (shape === 'cross') {
      const t = nr * 0.35;
      ctx.rect(x - t, y - nr, t * 2, nr * 2);
      ctx.rect(x - nr, y - t, nr * 2, t * 2);
    } else {
      ctx.arc(x, y, nr, 0, TAU);
    }
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

// ---------------------------------------------------------------------------
// Mosaic — flat tiles with 1px ink gap, posterized colors
// ---------------------------------------------------------------------------

function renderMosaic(ctx, grid, o) {
  const { cols, rows, data } = grid;
  const cell = o.cell;
  const gate = 1 - o.fill;
  const amp = o.scatter * cell * 0.4;
  const duo = o.colorMode === 'duotone';
  const paperStr = duo
    ? `rgb(${hexRgb(o.paper)[0]},${hexRgb(o.paper)[1]},${hexRgb(o.paper)[2]})`
    : null;

  paintBg(ctx, o);

  const size = cell - 1; // 1px ink gap between tiles

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const i = (row * cols + col) * 4;
      const L = lumOf(data, i);
      if (L < gate) continue;

      let x = col * cell + 0.5;
      let y = row * cell + 0.5;
      if (amp > 0) {
        x += jit(col, row, 1, amp);
        y += jit(col, row, 2, amp);
      }

      if (duo) {
        ctx.globalAlpha = L;
        ctx.fillStyle = paperStr;
      } else {
        // Posterize to 6 levels per channel for a tiled look.
        const pr = Math.round(data[i] / 51) * 51;
        const pg = Math.round(data[i + 1] / 51) * 51;
        const pb = Math.round(data[i + 2] / 51) * 51;
        ctx.fillStyle = `rgb(${pr},${pg},${pb})`;
      }
      ctx.fillRect(x, y, size, size);
    }
  }
  ctx.globalAlpha = 1;
}

// ---------------------------------------------------------------------------

export const CELL_EFFECTS = {
  dots:    { name: 'Dots',    render: renderDots },
  lego:    { name: 'LEGO',    render: renderLego },
  voxel:   { name: 'Voxel',   render: renderVoxel },
  led:     { name: 'LED',     render: renderLED },
  lattice: { name: 'Lattice', render: renderLattice },
  mosaic:  { name: 'Mosaic',  render: renderMosaic },
};
