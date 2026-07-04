// postfx.js — Canvas-2D post-processing stack for the dither/ASCII studio.
//
// Applies (in order): chromatic aberration -> glow -> film grain ->
// scanlines -> vignette. Runs per video frame, so every buffer here is a
// module-level scratch canvas that is only resized when the source
// dimensions change; the grain tile is generated once at module init.

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
// changes — the blur radius is resolution-relative)
let glowFilter = '';
let glowFilterGlow = -1;
let glowFilterK = -1;

// Deterministic frame counter so video grain animates
let frameCounter = 0;

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

function drawGlow(w, h, glow, k) {
    if (soft.width !== w || soft.height !== h) {
        soft.width = w;
        soft.height = h;
    }
    if (glowFilterGlow !== glow || glowFilterK !== k) {
        glowFilter = 'brightness(1.2) blur(' + ((4 + glow * 20) * k) + 'px)';
        glowFilterGlow = glow;
        glowFilterK = k;
    }
    // Bright/blurred copy of the current composite...
    softCtx.globalCompositeOperation = 'copy';
    softCtx.filter = glowFilter;
    softCtx.drawImage(out, 0, 0);
    softCtx.filter = 'none';
    // ...screen-blended back over the base.
    outCtx.globalCompositeOperation = 'screen';
    outCtx.globalAlpha = Math.min(1, glow * 0.85);
    outCtx.drawImage(soft, 0, 0);
    outCtx.globalAlpha = 1;
    outCtx.globalCompositeOperation = 'source-over';
}

function drawGrain(w, h, grain, k) {
    if (!grainPattern) grainPattern = outCtx.createPattern(grainTile, 'repeat');
    if (grainPatternK !== k) {
        // Scale the noise tile so speckle size stays constant relative to the
        // image. DOMMatrix allocation only happens when k changes (resize).
        grainPattern.setTransform(new DOMMatrix().scale(k));
        grainPatternK = k;
    }
    // Offset scaled by k so it stays aligned with the scaled tile period.
    const off = ((frameCounter * 7919) % GRAIN_SIZE) * k;
    outCtx.globalCompositeOperation = 'overlay';
    outCtx.globalAlpha = Math.min(1, grain * 0.55);
    outCtx.translate(-off, -off);
    outCtx.fillStyle = grainPattern;
    outCtx.fillRect(0, 0, w + off, h + off);
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
 *   1080p-height reference; scaled with output height), glow 0..1
 * @returns {HTMLCanvasElement} srcCanvas untouched when all values are
 *   0/falsy, otherwise a module-level reusable output canvas
 */
export function applyPostFX(srcCanvas, fx) {
    if (!fx) return srcCanvas;

    const vignette = +fx.vignette || 0;
    const scanlines = +fx.scanlines || 0;
    const grain = +fx.grain || 0;
    const chromatic = +fx.chromatic || 0;
    const glow = +fx.glow || 0;

    // Fast path: nothing to do, hand back the source untouched (no copy).
    if (vignette <= 0 && scanlines <= 0 && grain <= 0 &&
        chromatic <= 0 && glow <= 0) {
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
    const k = Math.max(0.25, h / 1080);

    frameCounter++;

    // Defensive state reset (canvas resize also resets, but cheap either way)
    outCtx.setTransform(1, 0, 0, 1, 0, 0);
    outCtx.globalAlpha = 1;
    outCtx.filter = 'none';

    // 1) Base layer: chromatic RGB split, or a plain copy of the source.
    if (chromatic > 0) {
        // Round to a whole pixel but never below 1 so a nonzero setting
        // always produces a visible split, even at small preview sizes.
        const shift = Math.max(1, Math.round(chromatic * k));
        drawChromatic(srcCanvas, w, h, shift);
    } else {
        outCtx.globalCompositeOperation = 'copy';
        outCtx.drawImage(srcCanvas, 0, 0);
        outCtx.globalCompositeOperation = 'source-over';
    }

    // 2) Glow, 3) grain, 4) scanlines, 5) vignette.
    if (glow > 0) drawGlow(w, h, glow, k);
    if (grain > 0) drawGrain(w, h, grain, k);
    if (scanlines > 0) drawScanlines(w, h, scanlines);
    if (vignette > 0) drawVignette(w, h, vignette);

    return out;
}
