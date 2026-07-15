// Deterministic glyph-space gravity for ASCII stills.
//
// The renderer asks for poses at an absolute normalized phase. Nothing here
// depends on requestAnimationFrame cadence, so previews and frame-exact video
// exports sample the same motion. Each body follows ballistic motion until it
// has completely crossed below the frame. There is deliberately no floor or
// body-to-body collision, which prevents bottom-edge piles and keeps dense
// ASCII grids linear-time.

export const ASCII_GRAVITY_DURATION_SECONDS = 2.6;
export const DEFAULT_GRAVITY_MODE = 'drizzle';

// Profiles resolve to immutable per-body constants during layout creation.
// The hot sampler therefore stays branch-free with respect to mode and can be
// embedded verbatim in interactive HTML exports.
export const GRAVITY_MODE_PROFILES = Object.freeze({
  drizzle: Object.freeze({
    label: 'Drizzle',
    signatureId: 1,
    durationScale: 1,
    releaseDirection: 'top-down',
    releaseBase: 0.05,
    releaseRandomBase: 0.70,
    releaseRandomScatter: 0.20,
    releaseRowBase: 0.10,
    releaseRowScatter: 0,
    gravityBase: 1.05,
    gravityScatter: 0.20,
    driftBase: 0.08,
    driftScatter: 0.42,
    horizontalDrag: 1.5,
    spinBase: 0.15,
    spinScatter: 0.90,
    rotationLimit: 0.12,
    flightScale: 1.4,
    angularDragBase: 2.4,
    angularDragRandom: 1.4,
  }),
  cascade: Object.freeze({
    label: 'Cascade',
    signatureId: 2,
    durationScale: 0.85,
    releaseDirection: 'top-down',
    releaseBase: 0.04,
    releaseRandomBase: 0.08,
    releaseRandomScatter: 0.10,
    releaseRowBase: 0.58,
    releaseRowScatter: 0.12,
    gravityBase: 1.25,
    gravityScatter: 0.35,
    driftBase: 0.04,
    driftScatter: 0.18,
    horizontalDrag: 2.2,
    spinBase: 0.05,
    spinScatter: 0.35,
    rotationLimit: 0.08,
    flightScale: 1.4,
    angularDragBase: 3,
    angularDragRandom: 1.5,
  }),
  flutter: Object.freeze({
    label: 'Flutter',
    signatureId: 3,
    durationScale: 1.2,
    releaseDirection: 'top-down',
    releaseBase: 0.04,
    releaseRandomBase: 0.45,
    releaseRandomScatter: 0.18,
    releaseRowBase: 0.06,
    releaseRowScatter: 0,
    gravityBase: 0.70,
    gravityScatter: 0.18,
    driftBase: 0.35,
    driftScatter: 1.15,
    horizontalDrag: 0.35,
    spinBase: 0.80,
    spinScatter: 2.80,
    rotationLimit: 0.18,
    flightScale: 1.5,
    angularDragBase: 0.65,
    angularDragRandom: 0.75,
  }),
  collapse: Object.freeze({
    label: 'Collapse',
    signatureId: 4,
    durationScale: 0.75,
    releaseDirection: 'bottom-up',
    releaseBase: 0.03,
    releaseRandomBase: 0.20,
    releaseRandomScatter: 0.15,
    releaseRowBase: 0.10,
    releaseRowScatter: 0,
    gravityBase: 1.65,
    gravityScatter: 0.55,
    driftBase: 0.03,
    driftScatter: 0.15,
    horizontalDrag: 2.8,
    spinBase: 0.10,
    spinScatter: 0.65,
    rotationLimit: 0.10,
    flightScale: 1.4,
    angularDragBase: 3.2,
    angularDragRandom: 1.6,
  }),
});

const TAU = Math.PI * 2;
// U+2800 is Braille's blank pattern. It occupies a character cell but has no
// visible dots, so treating it as a body creates invisible work in sparse art.
const EMPTY_GLYPHS = new Set([' ', '\u00a0', '\u2800', '\t', '\n', '\r']);

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const clamp01 = (value) => clamp(Number(value) || 0, 0, 1);

export function normalizeGravityMode(mode) {
  const key = typeof mode === 'string' ? mode.trim().toLowerCase() : '';
  return Object.prototype.hasOwnProperty.call(GRAVITY_MODE_PROFILES, key)
    ? key
    : DEFAULT_GRAVITY_MODE;
}

/** Wall-clock duration for one complete fall at the selected pace. */
export function gravityDurationSeconds(speed = 3, mode = DEFAULT_GRAVITY_MODE) {
  const value = Number(speed);
  const safeSpeed = Number.isFinite(value) ? clamp(value, 1, 10) : 3;
  const profile = GRAVITY_MODE_PROFILES[normalizeGravityMode(mode)];
  return (12 / safeSpeed) * profile.durationScale;
}

function smoothstep(edge0, edge1, value) {
  const t = clamp01((value - edge0) / Math.max(1e-9, edge1 - edge0));
  return t * t * (3 - 2 * t);
}

function mix32(value) {
  let x = value >>> 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x7feb352d);
  x ^= x >>> 15;
  x = Math.imul(x, 0x846ca68b);
  x ^= x >>> 16;
  return x >>> 0;
}

function random01(index, salt) {
  return mix32(Math.imul((index + 1) >>> 0, 0x9e3779b1) ^ salt) / 0x100000000;
}

function glyphCode(glyph) {
  return glyph?.codePointAt?.(0) || 0;
}

function mixSignature(hash, value) {
  hash ^= Number(value) >>> 0;
  return Math.imul(hash, 0x01000193) >>> 0;
}

export function isGravityGlyph(glyph) {
  return typeof glyph === 'string' && glyph.length > 0 && !EMPTY_GLYPHS.has(glyph);
}

/**
 * Cheap stable key for retaining the precomputed body constants while the
 * same still image is re-rendered on successive animation frames.
 */
export function gravityLayoutSignature(grid, {
  cols = grid?.[0]?.length || 0,
  rows = grid?.length || 0,
  intensity = 0.6,
  mode = DEFAULT_GRAVITY_MODE,
} = {}) {
  const normalizedMode = normalizeGravityMode(mode);
  let hash = 0x811c9dc5;
  hash = mixSignature(hash, cols);
  hash = mixSignature(hash, rows);
  hash = mixSignature(hash, Math.round(clamp01(intensity) * 1000));
  hash = mixSignature(hash, GRAVITY_MODE_PROFILES[normalizedMode].signatureId);
  for (let row = 0; row < rows; row++) {
    const cells = grid?.[row] || [];
    for (let col = 0; col < cols; col++) {
      const [glyph = ' ', foreground = 0, background = -1] = cells[col] || [];
      if (!isGravityGlyph(glyph)) continue;
      hash = mixSignature(hash, row * cols + col);
      hash = mixSignature(hash, glyphCode(glyph));
      hash = mixSignature(hash, foreground ?? 0);
      hash = mixSignature(hash, background ?? 0xffffffff);
    }
  }
  return `${cols}x${rows}:${hash.toString(16).padStart(8, '0')}`;
}

/** Build immutable per-glyph constants; positions are expressed in cell units. */
export function createGravityLayout(grid, {
  cols = grid?.[0]?.length || 0,
  rows = grid?.length || 0,
  intensity = 0.6,
  mode = DEFAULT_GRAVITY_MODE,
} = {}) {
  const scatter = clamp01(intensity);
  const normalizedMode = normalizeGravityMode(mode);
  const profile = GRAVITY_MODE_PROFILES[normalizedMode];
  const safeCols = Math.max(1, Math.floor(cols));
  const safeRows = Math.max(1, Math.floor(rows));
  const bodies = [];
  const gravity = safeRows * (profile.gravityBase + scatter * profile.gravityScatter);

  for (let row = 0; row < safeRows; row++) {
    const cells = grid?.[row] || [];
    for (let col = 0; col < safeCols; col++) {
      const [glyph = ' ', foreground = 0xffffff, background = null] = cells[col] || [];
      if (!isGravityGlyph(glyph)) continue;

      const index = row * safeCols + col;
      const releaseNoise = random01(index, 0xa341316c);
      const driftNoise = random01(index, 0xc8013ea4) * 2 - 1;
      const spinNoise = random01(index, 0xad90777d) * 2 - 1;
      const dampingNoise = random01(index, 0x7e95761e);

      const rowProgress = row / Math.max(1, safeRows - 1);
      const releaseProgress = profile.releaseDirection === 'bottom-up'
        ? 1 - rowProgress
        : rowProgress;
      const releaseAt = profile.releaseBase
        + releaseNoise * (profile.releaseRandomBase + scatter * profile.releaseRandomScatter)
        + releaseProgress * (profile.releaseRowBase + scatter * profile.releaseRowScatter);
      // Keep sampling until even a scaled/rotated glyph is safely below the
      // canvas. Canvas clipping makes the visual exit happen naturally at the
      // bottom edge; this later boundary only stops invisible draw work.
      const exitY = safeRows + Math.max(1, profile.flightScale);

      bodies.push(Object.freeze({
        index,
        row,
        col,
        glyph,
        foreground,
        background,
        x0: col + 0.5,
        y0: row + 0.5,
        exitY,
        gravity,
        releaseAt,
        vx: driftNoise * (profile.driftBase + scatter * profile.driftScatter),
        horizontalDrag: profile.horizontalDrag,
        omega: spinNoise * (profile.spinBase + scatter * profile.spinScatter),
        rotationLimit: profile.rotationLimit,
        flightScale: profile.flightScale,
        angularDrag: profile.angularDragBase + (1 - dampingNoise) * profile.angularDragRandom,
      }));
    }
  }

  return Object.freeze({
    cols: safeCols,
    rows: safeRows,
    intensity: scatter,
    mode: normalizedMode,
    duration: ASCII_GRAVITY_DURATION_SECONDS,
    signature: gravityLayoutSignature(grid, {
      cols: safeCols,
      rows: safeRows,
      intensity: scatter,
      mode: normalizedMode,
    }),
    bodies: Object.freeze(bodies),
  });
}

/**
 * Sample one glyph at a normalized phase. Pass `out` to avoid allocations in
 * the Canvas renderer; tests and other callers may omit it.
 */
export function sampleGravityBody(body, phase, out = {}) {
  const progress = clamp01(phase);
  const time = progress * ASCII_GRAVITY_DURATION_SECONDS;
  const elapsed = time - body.releaseAt;
  out.x = body.x0;
  out.y = body.y0;
  out.angle = 0;
  out.scale = 1;
  out.opacity = 1;
  out.released = elapsed > 0;
  out.exited = progress >= 1;

  if (elapsed <= 0) {
    if (out.exited) out.opacity = 0;
    return out;
  }

  const horizontalDrag = body.horizontalDrag ?? 0.7;
  out.x = body.x0 + body.vx * (1 - Math.exp(-horizontalDrag * elapsed)) / horizontalDrag;
  const angularDrag = Math.max(1e-9, body.angularDrag ?? 1);
  const rawAngle = body.omega * (1 - Math.exp(-angularDrag * elapsed)) / angularDrag;
  const rotationLimit = Number.isFinite(body.rotationLimit)
    ? Math.max(0, body.rotationLimit)
    : Infinity;
  out.angle = clamp(rawAngle, -rotationLimit, rotationLimit);
  const flightScale = Number.isFinite(body.flightScale) ? Math.max(1, body.flightScale) : 1;
  out.scale = 1 + (flightScale - 1) * smoothstep(0, 0.14, elapsed);
  out.y = body.y0 + 0.5 * body.gravity * elapsed * elapsed;
  out.exited = out.exited || out.y >= (Number.isFinite(body.exitY) ? body.exitY : Infinity);
  if (out.exited) out.opacity = 0;
  return out;
}

/** Sample every body without retaining mutable simulation state. */
export function sampleGravityLayout(layout, phase) {
  return layout.bodies.map((body) => ({ body, ...sampleGravityBody(body, phase) }));
}

export const __gravityTest = Object.freeze({ clamp01, mix32, random01, smoothstep, TAU });
