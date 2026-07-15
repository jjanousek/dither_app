// postfx.js — Canvas-2D post-processing stack for the dither/ASCII studio.
//
// Applies (in order): fluted-glass refraction -> chromatic aberration ->
// command graphics -> glow -> film grain -> scanlines -> vignette. Runs per
// video frame, so every buffer here is a module-level scratch canvas that is
// only resized when the source dimensions change; the grain tile is generated
// once at module init.

import { drawCommandSequence } from './command-sequence.js';
import {
    estimateFlutedGlassBytes,
    releaseFlutedGlass,
    renderFlutedGlass,
} from './fluted-glass.js';

const GRAIN_SIZE = 128;

// ---------------------------------------------------------------------------
// Module-level reusable scratch surfaces (never re-created per frame)
// ---------------------------------------------------------------------------

const out = document.createElement('canvas');      // returned composite
const outCtx = out.getContext('2d');

const chan = document.createElement('canvas');     // chromatic channel scratch
const chanCtx = chan.getContext('2d');

const soft = document.createElement('canvas');     // glow blur scratch
const softCtx = soft.getContext('2d');

// Grain tile: 128x128 random gray noise, values 96..160, built ONCE.
const grainTile = document.createElement('canvas');
grainTile.width = GRAIN_SIZE;
grainTile.height = GRAIN_SIZE;
{
    const gtx = grainTile.getContext('2d');
    const img = gtx.createImageData(GRAIN_SIZE, GRAIN_SIZE);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
        const v = 96 + ((Math.random() * 65) | 0); // 96..160
        d[i] = v;
        d[i + 1] = v;
        d[i + 2] = v;
        d[i + 3] = 255;
    }
    gtx.putImageData(img, 0, 0);
}

let grainPattern = null;        // CanvasPattern, created lazily once
let grainPatternK = -1;         // resolution factor baked into its transform

// CanvasPattern.setTransform is missing on WebKit < 15.4 (N32). Detect ONCE
// at module scope; when unsupported we draw the grain tile unscaled instead
// of throwing every frame.
const PATTERN_TRANSFORM_OK =
    typeof CanvasPattern !== 'undefined' &&
    'setTransform' in CanvasPattern.prototype;

// Scanline tile cache (rebuilt only when line spacing changes)
let scanTile = null;
let scanPattern = null;
let scanSpacing = 0;

// Vignette gradient cache (rebuilt only when size/strength changes)
let vigGrad = null;
let vigW = 0;
let vigH = 0;
let vigV = -1;

// Glow filter string cache (rebuilt when glow amount OR resolution factor
// OR the fast-mode divisor changes — the blur radius is resolution-relative)
let glowFilter = '';
let glowFilterGlow = -1;
let glowFilterK = -1;
let glowFilterDiv = -1;

// Deterministic frame counter so video grain animates
let frameCounter = 0;

const fxEnabled = (fx) => !!fx && (
    (+fx.vignette || 0) > 0 ||
    (+fx.scanlines || 0) > 0 ||
    (+fx.grain || 0) > 0 ||
    (+fx.chromatic || 0) > 0 ||
    (+fx.glow || 0) > 0
);

const commandSequenceEnabled = (opts) => opts?.animationStyle === 'command'
    && (+opts.animationIntensity || 0) > 0;

const flutedGlassEnabled = (opts) => opts?.animationStyle === 'fluted'
    && (+opts.animationIntensity || 0) > 0;

export function postFXActive(fx, opts = {}) {
    return fxEnabled(fx) || commandSequenceEnabled(opts) || flutedGlassEnabled(opts);
}

// ---------------------------------------------------------------------------
// Stage helpers
// ---------------------------------------------------------------------------

function drawChromatic(srcCanvas, w, h, shift) {
    if (chan.width !== w || chan.height !== h) {
        chan.width = w;
        chan.height = h;
    }
    // Recombine on black so 'lighter' sums the isolated channels.
    outCtx.globalCompositeOperation = 'source-over';
    outCtx.fillStyle = '#000000';
    outCtx.fillRect(0, 0, w, h);

    for (let i = 0; i < 3; i++) {
        const color = i === 0 ? '#ff0000' : (i === 1 ? '#00ff00' : '#0000ff');
        const dx = i === 0 ? shift : (i === 2 ? -shift : 0); // R right, B left

        // Isolate one channel: copy src, multiply by the solid primary.
        chanCtx.globalCompositeOperation = 'copy';
        chanCtx.drawImage(srcCanvas, 0, 0);
        chanCtx.globalCompositeOperation = 'multiply';
        chanCtx.fillStyle = color;
        chanCtx.fillRect(0, 0, w, h);

        outCtx.globalCompositeOperation = 'lighter';
        outCtx.drawImage(chan, dx, 0);
    }
    outCtx.globalCompositeOperation = 'source-over';
}

function drawGlow(w, h, glow, k, fast) {
    // Glow output is low-frequency by construction, so in fast (live) mode
    // the blur runs on a quarter-resolution copy with the radius scaled to
    // match — the same effective kernel at ~1/16 the raster work. Exports
    // keep the full-resolution version.
    const div = fast ? 4 : 1;
    const gw = Math.max(1, Math.round(w / div));
    const gh = Math.max(1, Math.round(h / div));
    if (soft.width !== gw || soft.height !== gh) {
        soft.width = gw;
        soft.height = gh;
    }
    if (glowFilterGlow !== glow || glowFilterK !== k || glowFilterDiv !== div) {
        glowFilter = 'brightness(1.2) blur(' + ((4 + glow * 20) * k / div) + 'px)';
        glowFilterGlow = glow;
        glowFilterK = k;
        glowFilterDiv = div;
    }
    // Bright/blurred (downscaled) copy of the current composite...
    softCtx.globalCompositeOperation = 'copy';
    softCtx.filter = glowFilter;
    softCtx.drawImage(out, 0, 0, w, h, 0, 0, gw, gh);
    softCtx.filter = 'none';
    // ...screen-blended back over the base.
    outCtx.globalCompositeOperation = 'screen';
    outCtx.globalAlpha = Math.min(1, glow * 0.85);
    outCtx.drawImage(soft, 0, 0, gw, gh, 0, 0, w, h);
    outCtx.globalAlpha = 1;
    outCtx.globalCompositeOperation = 'source-over';
}

function drawGrain(w, h, grain, k, grainPhase) {
    if (!grainPattern) grainPattern = outCtx.createPattern(grainTile, 'repeat');
    // Effective tile scale actually applied to the pattern. On WebKit < 15.4
    // (no CanvasPattern.setTransform, N32) the tile stays unscaled, so
    // offsets must align to the UNSCALED tile period instead of k.
    let tileK = 1;
    if (PATTERN_TRANSFORM_OK) {
        if (grainPatternK !== k) {
            // Scale the noise tile so speckle size stays constant relative to
            // the image. DOMMatrix allocation only happens when k changes
            // (resize).
            grainPattern.setTransform(new DOMMatrix().scale(k));
            grainPatternK = k;
        }
        tileK = k;
    }
    // Offsets scaled by the applied tile scale so they stay aligned with the
    // tile period.
    let offX;
    let offY;
    if (grainPhase !== null) {
        // Pure function of phase (N34: same phase -> identical grain). The
        // modulo makes phase 1.0 land on the same offset as phase 0.0 so a
        // baked GIF loop is seamless (N33), while intermediate phases still
        // animate the grain over the cycle.
        const step = ((Math.round(grainPhase * GRAIN_SIZE) % GRAIN_SIZE) +
            GRAIN_SIZE) % GRAIN_SIZE;
        offX = step * tileK;
        offY = ((step * 71) % GRAIN_SIZE) * tileK; // decorrelated, wraps too
    } else {
        // Legacy: internal frame counter drives the animation (live video).
        const off = ((frameCounter * 7919) % GRAIN_SIZE) * tileK;
        offX = off;
        offY = off;
    }
    outCtx.globalCompositeOperation = 'overlay';
    outCtx.globalAlpha = Math.min(1, grain * 0.55);
    outCtx.translate(-offX, -offY);
    outCtx.fillStyle = grainPattern;
    outCtx.fillRect(0, 0, w + offX, h + offY);
    outCtx.setTransform(1, 0, 0, 1, 0, 0);
    outCtx.globalAlpha = 1;
    outCtx.globalCompositeOperation = 'source-over';
}

function buildScanTile(spacing) {
    if (!scanTile) scanTile = document.createElement('canvas');
    // Tile covers TWO line groups so alternate lines can be slightly
    // fainter (cheap CRT feel): [gap gap line | gap gap fainter-line].
    scanTile.width = 4;
    scanTile.height = spacing * 6;
    const stx = scanTile.getContext('2d');
    stx.clearRect(0, 0, 4, spacing * 6);
    stx.fillStyle = '#000000';
    stx.fillRect(0, spacing * 2, 4, spacing);
    stx.globalAlpha = 0.65;
    stx.fillRect(0, spacing * 5, 4, spacing);
    stx.globalAlpha = 1;
    scanPattern = outCtx.createPattern(scanTile, 'repeat');
    scanSpacing = spacing;
}

function drawScanlines(w, h, scanlines) {
    const spacing = Math.max(2, Math.round(h / 270));
    if (spacing !== scanSpacing || !scanPattern) buildScanTile(spacing);
    outCtx.globalCompositeOperation = 'source-over';
    outCtx.globalAlpha = Math.min(1, scanlines * 0.35);
    outCtx.fillStyle = scanPattern;
    outCtx.fillRect(0, 0, w, h);
    outCtx.globalAlpha = 1;
}

function drawVignette(w, h, vignette) {
    if (vigGrad === null || vigW !== w || vigH !== h || vigV !== vignette) {
        const half = 0.5 * Math.sqrt(w * w + h * h); // center -> corner
        const g = outCtx.createRadialGradient(
            w / 2, h / 2, half * 0.55,
            w / 2, h / 2, half
        );
        g.addColorStop(0, 'rgba(0,0,0,0)');
        g.addColorStop(1, 'rgba(0,0,0,' + Math.min(1, vignette * 0.8) + ')');
        vigGrad = g;
        vigW = w;
        vigH = h;
        vigV = vignette;
    }
    outCtx.globalCompositeOperation = 'source-over';
    outCtx.fillStyle = vigGrad;
    outCtx.fillRect(0, 0, w, h);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Apply the post-FX stack to a rendered frame.
 *
 * @param {HTMLCanvasElement} srcCanvas rendered frame (never drawn onto)
 * @param {{vignette?:number, scanlines?:number, grain?:number,
 *          chromatic?:number, glow?:number}} fx
 *   vignette 0..1, scanlines 0..1, grain 0..1, chromatic 0..20 (px at
 *   1080p-height reference; scaled with the resolution factor), glow 0..1
 * @param {{grainPhase?:(number|null), refH?:(number|null), fast?:boolean,
 *          animationStyle?:string, animationPhase?:number,
 *          animationIntensity?:number, sourceKey?:string}} [opts]
 *   grainPhase: 0..1 position in the grain animation cycle. When provided,
 *     the grain offset is a pure function of it — identical phase produces
 *     identical grain (deterministic re-exports, N34) and phase 1.0 wraps to
 *     the same offset as 0.0 (seamless baked GIF loops, N33). When
 *     null/undefined, the legacy internal frame counter animates the grain.
 *   refH: reference height for the resolution factor
 *     k = max(0.25, refH/1080), so preview and export can share the same k
 *     and post-FX intensity matches between them (N36). When null/undefined,
 *     the output canvas height is used (legacy behavior).
 *   fast: live-preview mode — glow blurs a quarter-resolution copy (same
 *     effective kernel, ~1/16 the raster work). Leave unset for exports.
 * @returns {HTMLCanvasElement} srcCanvas untouched when all values are
 *   0/falsy, otherwise a module-level reusable output canvas
 */
export function applyPostFX(srcCanvas, fx, opts = {}) {
    const values = fx || {};
    const vignette = +values.vignette || 0;
    const scanlines = +values.scanlines || 0;
    const grain = +values.grain || 0;
    const chromatic = +values.chromatic || 0;
    const glow = +values.glow || 0;
    const commandSequence = commandSequenceEnabled(opts);
    const flutedGlass = flutedGlassEnabled(opts);

    // Fast path: nothing to do, hand back the source untouched (no copy).
    if (vignette <= 0 && scanlines <= 0 && grain <= 0 &&
        chromatic <= 0 && glow <= 0 && !commandSequence && !flutedGlass) {
        return srcCanvas;
    }

    const w = srcCanvas.width;
    const h = srcCanvas.height;
    if (!w || !h) return srcCanvas;

    if (out.width !== w || out.height !== h) {
        out.width = w;
        out.height = h;
    }

    // Resolution factor: chromatic shift, glow blur, and grain speckle are
    // sized relative to a 1080p-height reference so preview and full-size
    // export look the same. Clamped so tiny previews don't zero effects out.
    // opts.refH lets preview and export share one reference height (N36);
    // otherwise the output canvas height is used, as before.
    const refH = (opts && typeof opts.refH === 'number' &&
        isFinite(opts.refH) && opts.refH > 0) ? opts.refH : h;
    const k = Math.max(0.25, refH / 1080);

    // Phase-driven grain (exports) vs legacy counter-driven grain (live).
    // The counter only advances on legacy calls so a phase-driven export in
    // between never perturbs it.
    const grainPhase = (opts && typeof opts.grainPhase === 'number' &&
        isFinite(opts.grainPhase)) ? opts.grainPhase : null;
    if (grainPhase === null) frameCounter++;

    // Defensive state reset (canvas resize also resets, but cheap either way)
    outCtx.setTransform(1, 0, 0, 1, 0, 0);
    outCtx.globalAlpha = 1;
    outCtx.filter = 'none';

    // 1) Optical refraction. This stays ahead of the Canvas2D stack so the
    // ordinary Post-FX stages act on the refracted image, not vice versa.
    let baseCanvas = srcCanvas;
    if (flutedGlass) {
        const refracted = renderFlutedGlass(srcCanvas, {
            phase: opts.animationPhase,
            intensity: opts.animationIntensity,
            sourceKey: opts.sourceKey,
        });
        // Keep the Post-FX contract dimension-preserving even if a lost or
        // failed GL context hands back no usable render target.
        if (refracted?.width === w && refracted?.height === h) baseCanvas = refracted;
    }

    // 2) Base layer: chromatic RGB split, or a plain copy of the source.
    if (chromatic > 0) {
        // Round to a whole pixel but never below 1 so a nonzero setting
        // always produces a visible split, even at small preview sizes.
        const shift = Math.max(1, Math.round(chromatic * k));
        drawChromatic(baseCanvas, w, h, shift);
    } else {
        outCtx.globalCompositeOperation = 'copy';
        outCtx.drawImage(baseCanvas, 0, 0);
        outCtx.globalCompositeOperation = 'source-over';
    }

    // 3) Command graphics and synchronization slices. The channel canvas is
    // no longer needed after chromatic recombination, so it doubles as the
    // reusable full-frame slice scratch instead of allocating another surface.
    if (commandSequence) {
        drawCommandSequence(outCtx, out, chan, {
            phase: opts.animationPhase,
            intensity: opts.animationIntensity,
            refH,
        });
    }

    // 4) Glow, 5) grain, 6) scanlines, 7) vignette.
    if (glow > 0) drawGlow(w, h, glow, k, !!(opts && opts.fast));
    if (grain > 0) drawGrain(w, h, grain, k, grainPhase);
    if (scanlines > 0) drawScanlines(w, h, scanlines);
    if (vignette > 0) drawVignette(w, h, vignette);

    return out;
}

/**
 * Estimate the persistent Canvas2D backing-store bytes needed by the active
 * Post-FX stages at a target size. The estimate intentionally excludes the
 * caller-owned source canvas and includes only module-owned surfaces.
 */
export function estimatePostFXBytes(width, height, fx, opts = {}) {
    const fast = !!opts.fast;
    if (!postFXActive(fx, opts) || width <= 0 || height <= 0) return 0;
    const full = width * height * 4;
    let bytes = full; // returned composite
    if (flutedGlassEnabled(opts)) bytes += estimateFlutedGlassBytes(width, height);
    // Chromatic isolation and command slices share the same reusable scratch.
    if ((+fx?.chromatic || 0) > 0 || commandSequenceEnabled(opts)) bytes += full;
    if ((+fx?.glow || 0) > 0) {
        const div = fast ? 4 : 1;
        bytes += Math.max(1, Math.round(width / div))
            * Math.max(1, Math.round(height / div)) * 4;
    }
    // Grain/scanline tiles are small but real and remain allocated.
    if ((+fx?.grain || 0) > 0) bytes += GRAIN_SIZE * GRAIN_SIZE * 4;
    if ((+fx?.scanlines || 0) > 0) {
        const spacing = Math.max(2, Math.round(height / 270));
        bytes += 4 * spacing * 6 * 4;
    }
    return bytes;
}

/**
 * Bound an unmasked export before any result or Post-FX canvases are created.
 * The returned integer dimensions retain the input aspect ratio as closely as
 * pixel rounding allows. `reason` names the tightest limit: side, area, or
 * memory. Invalid dimensions/limits and a byte budget too small for even a
 * 1x1 working set are rejected instead of returning an unsafe canvas size.
 */
export function constrainPostFXDimensions(
    width,
    height,
    fx,
    opts = {},
    {
        maxSide = Infinity,
        maxArea = Infinity,
        maxBytes = Infinity,
        baseBytesPerPixel = 12,
    } = {},
) {
    const positiveInteger = (value, name) => {
        const number = Number(value);
        if (!Number.isFinite(number) || number <= 0) {
            throw new RangeError(`${name} must be a positive finite number`);
        }
        return Math.max(1, Math.floor(number));
    };
    const positiveLimit = (value, name) => {
        if (value === Infinity) return Infinity;
        const number = Number(value);
        if (!Number.isFinite(number) || number <= 0) {
            throw new RangeError(`${name} must be positive or Infinity`);
        }
        return number;
    };

    const sourceWidth = positiveInteger(width, 'width');
    const sourceHeight = positiveInteger(height, 'height');
    const sideLimit = positiveLimit(maxSide, 'maxSide');
    const areaLimit = positiveLimit(maxArea, 'maxArea');
    const byteLimit = positiveLimit(maxBytes, 'maxBytes');
    const baseBytes = Number(baseBytesPerPixel);
    if (!Number.isFinite(baseBytes) || baseBytes < 0) {
        throw new RangeError('baseBytesPerPixel must be a non-negative finite number');
    }

    const sideScale = Math.min(
        1,
        sideLimit / sourceWidth,
        sideLimit / sourceHeight,
    );
    const areaScale = Math.min(
        1,
        Math.sqrt(areaLimit / (sourceWidth * sourceHeight)),
    );
    let scale = 1;
    let reason = null;
    if (sideScale < scale) {
        scale = sideScale;
        reason = 'side';
    }
    if (areaScale < scale) {
        scale = areaScale;
        reason = 'area';
    }

    const dimensionsAt = (candidateScale) => ({
        width: Math.max(1, Math.floor(sourceWidth * candidateScale)),
        height: Math.max(1, Math.floor(sourceHeight * candidateScale)),
    });
    const workingBytes = (candidateWidth, candidateHeight) => (
        candidateWidth * candidateHeight * baseBytes
        + estimatePostFXBytes(candidateWidth, candidateHeight, fx, opts)
    );

    const geometricTarget = dimensionsAt(scale);
    if (byteLimit < Infinity
        && workingBytes(geometricTarget.width, geometricTarget.height) > byteLimit) {
        if (workingBytes(1, 1) > byteLimit) {
            throw new RangeError('maxBytes is too small for the minimum Post-FX working set');
        }
        let low = 0;
        let high = scale;
        // The estimator includes fixed-size tiles and rounded fast-mode
        // surfaces, so solve it directly instead of assuming bytes scale only
        // with area.
        for (let iteration = 0; iteration < 32; iteration++) {
            const mid = (low + high) / 2;
            const candidate = dimensionsAt(mid);
            if (workingBytes(candidate.width, candidate.height) <= byteLimit) low = mid;
            else high = mid;
        }
        scale = low;
        reason = 'memory';
    }

    const constrained = dimensionsAt(scale);
    const capped = constrained.width !== sourceWidth || constrained.height !== sourceHeight;
    return {
        width: constrained.width,
        height: constrained.height,
        capped,
        reason: capped ? reason : null,
    };
}

/** Release target-sized Post-FX backing stores after source/export teardown. */
export function releasePostFXBuffers() {
    releaseFlutedGlass();
    out.width = 0;
    out.height = 0;
    chan.width = 0;
    chan.height = 0;
    soft.width = 0;
    soft.height = 0;
    grainPattern = null;
    grainPatternK = -1;
    scanTile = null;
    scanPattern = null;
    scanSpacing = 0;
    vigGrad = null;
    vigW = 0;
    vigH = 0;
    vigV = -1;
    glowFilter = '';
    glowFilterGlow = -1;
    glowFilterK = -1;
    glowFilterDiv = -1;
}

/**
 * Release backing stores for stages that are no longer active without
 * disturbing buffers still needed by the current effect stack. Call this
 * after settings changes so memory accounting describes resident surfaces,
 * not just the next frame's work.
 */
export function trimPostFXBuffers(fx, opts = {}) {
    const values = fx || {};
    const commandSequence = commandSequenceEnabled(opts);
    const flutedGlass = flutedGlassEnabled(opts);

    if (!flutedGlass) releaseFlutedGlass();
    if ((+values.chromatic || 0) <= 0 && !commandSequence) {
        chan.width = 0;
        chan.height = 0;
    }
    if ((+values.glow || 0) <= 0) {
        soft.width = 0;
        soft.height = 0;
        glowFilter = '';
        glowFilterGlow = -1;
        glowFilterK = -1;
        glowFilterDiv = -1;
    }
    if ((+values.grain || 0) <= 0) {
        grainPattern = null;
        grainPatternK = -1;
    }
    if ((+values.scanlines || 0) <= 0) {
        scanTile = null;
        scanPattern = null;
        scanSpacing = 0;
    }
    if ((+values.vignette || 0) <= 0) {
        vigGrad = null;
        vigW = 0;
        vigH = 0;
        vigV = -1;
    }
    if (!postFXActive(values, opts)) {
        out.width = 0;
        out.height = 0;
    }
}
