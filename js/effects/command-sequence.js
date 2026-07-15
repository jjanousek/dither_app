// command-sequence.js — deterministic technical-overlay animation.
//
// The caller owns both canvases. This module never creates a canvas, reads
// pixels, or relies on frame history: a phase and a size always produce the
// same state. The reusable scratch surface is touched only during the three
// short signal-displacement windows.

const TAU = Math.PI * 2;
const MAX_DIMENSION = 32768;

export const COMMAND_SEQUENCE_COLORS = Object.freeze({
  void: '#09060d',
  plum: '#261137',
  violet: '#653091',
  signal: '#b8ff3d',
  alarm: '#ff4f1f',
  caution: '#f4df3a',
  paper: '#f4f0de',
});

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function unit(value) {
  return clamp(finite(value), 0, 1);
}

function dimension(value) {
  return clamp(Math.round(finite(value, 1)), 1, MAX_DIMENSION);
}

function wrapPhase(value) {
  const number = finite(value);
  const wrapped = number - Math.floor(number);
  return wrapped === 0 ? 0 : wrapped;
}

// A smooth, bounded impulse whose endpoints are exactly zero. Keeping each
// signal event inside a fixed phase window makes the loop deterministic and
// limits the amount of drawing work independently of image dimensions.
function windowImpulse(phase, start, end) {
  if (phase <= start || phase >= end) return 0;
  const t = (phase - start) / (end - start);
  const sine = Math.sin(Math.PI * t);
  return sine * sine;
}

function makeSlice(phase, intensity, width, height, start, end, y, h, direction, amplitude) {
  const impulse = windowImpulse(phase, start, end);
  const maxShift = Math.max(1, Math.round(width * amplitude));
  const signedShift = Math.round(maxShift * impulse * intensity) * direction;
  const shift = signedShift === 0 ? 0 : signedShift;
  return {
    y: Math.round(height * y),
    height: Math.max(1, Math.round(height * h)),
    dx: shift,
    active: shift !== 0,
    impulse,
  };
}

/**
 * Return the complete, renderer-independent state for one command-sequence
 * frame. Phase wraps, so phase 1 is deliberately identical to phase 0.
 * Dimensions and intensity are normalized here rather than in the renderer,
 * which keeps malformed inputs finite and makes the state easy to test.
 */
export function commandSequenceState(phase, intensity, width, height) {
  const p = wrapPhase(phase);
  const amount = unit(intensity);
  const w = dimension(width);
  const h = dimension(height);
  const shortSide = Math.min(w, h);
  const portrait = h > w * 1.08;
  // Microtype needs substantially more room than the strong bracket/slab
  // shapes. Portrait compositions switch to the geometric rail earlier so
  // two long status strings never collide on phone-sized exports.
  const compact = w < 720 || h < 240 || (portrait && w < 900);
  const safe = Math.min(Math.floor(shortSide / 4), Math.max(4, Math.round(shortSide * 0.035)));
  const lineWidth = clamp(Math.round(shortSide / 540), 1, 6);
  const bracketWidth = clamp(Math.round(w * (portrait ? 0.68 : 0.42)), 1, Math.max(1, w - safe * 2));
  const bracketHeight = clamp(Math.round(h * (portrait ? 0.42 : 0.56)), 1, Math.max(1, h - safe * 2));
  const bracketX = Math.round((w - bracketWidth) * 0.5);
  const bracketY = Math.round(h * (portrait ? 0.19 : 0.20));
  const railHeight = clamp(
    Math.max(lineWidth * 8, Math.round(h * (compact ? 0.075 : 0.068))),
    1,
    Math.max(1, h - safe * 2),
  );
  const railY = clamp(
    Math.round(h * (portrait ? 0.76 : 0.83)),
    safe,
    Math.max(safe, h - safe - railHeight),
  );
  const step = Math.floor(p * 24) % 24;
  const pulse = 0.72 + Math.sin(p * TAU * 2) * 0.28;
  const primaryAlert = windowImpulse(p, 0.46, 0.59);
  const echoAlert = windowImpulse(p, 0.78, 0.85) * 0.42;
  const alertLevel = Math.max(primaryAlert, echoAlert) * amount;

  return {
    phase: p,
    intensity: amount,
    width: w,
    height: h,
    portrait,
    compact,
    safe,
    lineWidth,
    step,
    pulse,
    scan: {
      y: Math.round(safe + (h - safe * 2) * p),
      alpha: amount * (0.18 + pulse * 0.25),
    },
    bracket: {
      x: bracketX,
      y: bracketY,
      width: bracketWidth,
      height: bracketHeight,
      arm: Math.max(lineWidth * 8, Math.round(shortSide * 0.055)),
      alpha: amount * (0.66 + pulse * 0.22),
    },
    rail: {
      x: safe,
      y: railY,
      width: Math.max(1, w - safe * 2),
      height: railHeight,
    },
    alert: {
      level: alertLevel,
      x: portrait ? safe : Math.round(w * 0.58),
      y: portrait ? Math.round(h * 0.66) : Math.round(h * 0.12),
      width: portrait ? Math.max(1, w - safe * 2) : Math.max(1, w - safe - Math.round(w * 0.58)),
      height: Math.max(lineWidth * 12, Math.round(h * (compact ? 0.10 : 0.085))),
    },
    slices: [
      makeSlice(p, amount, w, h, 0.16, 0.235, 0.22, 0.055, 1, 0.027),
      makeSlice(p, amount, w, h, 0.19, 0.265, 0.51, 0.080, -1, 0.021),
      makeSlice(p, amount, w, h, 0.73, 0.805, 0.69, 0.065, 1, 0.019),
    ],
  };
}

function requireDrawingInputs(context, sourceCanvas, scratchCanvas) {
  if (!context || typeof context.save !== 'function' || typeof context.restore !== 'function') {
    throw new TypeError('Command sequence requires a Canvas2D context');
  }
  if (!sourceCanvas || typeof sourceCanvas !== 'object') {
    throw new TypeError('Command sequence requires a source canvas');
  }
  if (!scratchCanvas || typeof scratchCanvas.getContext !== 'function') {
    throw new TypeError('Command sequence requires a reusable scratch canvas');
  }
  if (scratchCanvas === sourceCanvas || scratchCanvas === context.canvas) {
    throw new TypeError('Command sequence scratch canvas must be separate');
  }
}

function copySourceToScratch(sourceCanvas, scratchCanvas, width, height) {
  if (scratchCanvas.width !== width) scratchCanvas.width = width;
  if (scratchCanvas.height !== height) scratchCanvas.height = height;
  const scratchContext = scratchCanvas.getContext('2d');
  if (!scratchContext) throw new TypeError('Command sequence scratch canvas needs a 2D context');

  scratchContext.save();
  try {
    scratchContext.setTransform(1, 0, 0, 1, 0, 0);
    scratchContext.globalAlpha = 1;
    scratchContext.globalCompositeOperation = 'copy';
    scratchContext.filter = 'none';
    scratchContext.drawImage(sourceCanvas, 0, 0, width, height);
  } finally {
    scratchContext.restore();
  }
}

// Replace one horizontal band with a wrapped translated copy. Two blits fill
// the entire band, so a displacement never exposes transparent edge columns.
function drawWrappedSlice(context, scratchCanvas, slice, width, height) {
  const y = clamp(slice.y, 0, Math.max(0, height - 1));
  const bandHeight = clamp(slice.height, 1, height - y);
  const dx = clamp(Math.round(slice.dx), -(width - 1), width - 1);
  if (!dx) return;

  if (dx > 0) {
    context.drawImage(scratchCanvas, 0, y, width - dx, bandHeight,
      dx, y, width - dx, bandHeight);
    context.drawImage(scratchCanvas, width - dx, y, dx, bandHeight,
      0, y, dx, bandHeight);
  } else {
    const shift = -dx;
    context.drawImage(scratchCanvas, shift, y, width - shift, bandHeight,
      0, y, width - shift, bandHeight);
    context.drawImage(scratchCanvas, 0, y, shift, bandHeight,
      width - shift, y, shift, bandHeight);
  }
}

function traceTrackingBrackets(context, bracket) {
  const { x, y, width, height, arm } = bracket;
  const right = x + width;
  const bottom = y + height;
  context.beginPath();
  context.moveTo(x + arm, y);
  context.lineTo(x, y);
  context.lineTo(x, y + arm);
  context.moveTo(right - arm, y);
  context.lineTo(right, y);
  context.lineTo(right, y + arm);
  context.moveTo(x, bottom - arm);
  context.lineTo(x, bottom);
  context.lineTo(x + arm, bottom);
  context.moveTo(right, bottom - arm);
  context.lineTo(right, bottom);
  context.lineTo(right - arm, bottom);
  context.stroke();
}

function drawStatusRail(context, state) {
  const { rail, lineWidth, compact, intensity, step } = state;
  const colors = COMMAND_SEQUENCE_COLORS;
  context.globalAlpha = intensity * 0.78;
  context.fillStyle = colors.plum;
  context.fillRect(rail.x, rail.y, rail.width, rail.height);
  context.globalAlpha = intensity * 0.92;
  context.fillStyle = colors.signal;
  context.fillRect(rail.x, rail.y, rail.width, lineWidth);

  const tickY = rail.y + rail.height - lineWidth * 2;
  context.globalAlpha = intensity * 0.58;
  for (let index = 0; index < 12; index++) {
    const x = rail.x + Math.round((rail.width * index) / 12);
    const tickHeight = lineWidth * (index % 3 === 0 ? 4 : 2);
    context.fillRect(x, tickY - tickHeight, lineWidth, tickHeight);
  }

  if (compact) {
    const blockY = rail.y + lineWidth * 3;
    const blockHeight = Math.max(lineWidth * 2, rail.height - lineWidth * 7);
    context.globalAlpha = intensity * 0.75;
    context.fillStyle = colors.paper;
    for (let index = 0; index < 5; index++) {
      const blockWidth = Math.max(lineWidth * 3, Math.round(rail.width * (0.035 + index * 0.008)));
      context.fillRect(rail.x + lineWidth * 3 + index * rail.width * 0.17,
        blockY, blockWidth, blockHeight);
    }
    return;
  }

  const fontSize = Math.max(9, Math.round(state.height * 0.016));
  context.globalAlpha = intensity * 0.92;
  context.fillStyle = colors.paper;
  context.font = `600 ${fontSize}px Menlo, Monaco, monospace`;
  context.textBaseline = 'middle';
  const frame = String(842 + step * 7).padStart(4, '0');
  const labelY = rail.y + rail.height * 0.48;
  context.fillText(`SIGNAL LOCK   LUMA ${84 + (step % 9)}   CHROMA ${12 + (step % 5)}`, rail.x + lineWidth * 5, labelY);
  context.textAlign = 'right';
  context.fillText(`FRAME ${frame}   STATE ACTIVE`, rail.x + rail.width - lineWidth * 5, labelY);
  context.textAlign = 'left';
}

function drawAlertSlab(context, state) {
  const colors = COMMAND_SEQUENCE_COLORS;
  const { alert, lineWidth, intensity, width, height, safe, compact } = state;
  const quietAlpha = intensity * 0.22;
  const activeAlpha = alert.level * 0.78;

  // The skewed edge creates the mechanical warning silhouette without a
  // transform or an asset, so it scales identically in every aspect ratio.
  const quietWidth = Math.max(lineWidth * 18, Math.round(width * 0.16));
  const quietHeight = Math.max(lineWidth * 5, Math.round(height * 0.018));
  const quietY = Math.round(height * 0.105);
  context.globalAlpha = quietAlpha + activeAlpha * 0.35;
  context.fillStyle = colors.alarm;
  context.beginPath();
  context.moveTo(safe, quietY);
  context.lineTo(safe + quietWidth, quietY);
  context.lineTo(safe + quietWidth - quietHeight, quietY + quietHeight);
  context.lineTo(safe, quietY + quietHeight);
  context.closePath();
  context.fill();

  if (alert.level <= 0) return;
  context.globalAlpha = Math.min(1, activeAlpha + intensity * 0.18);
  context.fillRect(alert.x, alert.y, alert.width, alert.height);
  context.fillStyle = colors.void;
  if (!compact) {
    const fontSize = Math.max(12, Math.round(alert.height * 0.42));
    context.font = `800 ${fontSize}px system-ui, sans-serif`;
    context.textBaseline = 'middle';
    context.fillText('SIGNAL LOCK', alert.x + lineWidth * 6, alert.y + alert.height * 0.52);
  } else {
    const inset = lineWidth * 4;
    context.fillRect(alert.x + inset, alert.y + alert.height * 0.43,
      Math.max(1, alert.width - inset * 2), Math.max(1, lineWidth * 2));
  }
}

function drawOverlay(context, state) {
  const colors = COMMAND_SEQUENCE_COLORS;
  const { width, height, safe, lineWidth, scan, bracket, intensity, compact } = state;

  context.lineWidth = lineWidth;
  context.lineCap = 'square';
  context.lineJoin = 'miter';

  context.globalAlpha = scan.alpha;
  context.fillStyle = colors.signal;
  context.fillRect(safe, scan.y, Math.max(1, width - safe * 2), lineWidth);

  context.globalAlpha = bracket.alpha;
  context.strokeStyle = colors.signal;
  traceTrackingBrackets(context, bracket);

  // Center calibration marks stay sparse enough that the image remains the
  // subject. Their dimensions derive from the tracking box, not the pixels.
  const centerX = Math.round(bracket.x + bracket.width * 0.5);
  const centerY = Math.round(bracket.y + bracket.height * 0.5);
  const tick = Math.max(lineWidth * 4, Math.round(Math.min(width, height) * 0.018));
  context.globalAlpha = intensity * 0.54;
  context.strokeStyle = colors.paper;
  context.beginPath();
  context.moveTo(centerX - tick * 2, centerY);
  context.lineTo(centerX - tick, centerY);
  context.moveTo(centerX + tick, centerY);
  context.lineTo(centerX + tick * 2, centerY);
  context.moveTo(centerX, centerY - tick * 2);
  context.lineTo(centerX, centerY - tick);
  context.moveTo(centerX, centerY + tick);
  context.lineTo(centerX, centerY + tick * 2);
  context.stroke();

  drawAlertSlab(context, state);
  drawStatusRail(context, state);

  // Keep one strong vertical identifier in compact thumbnails; the status
  // rail intentionally drops its microtype at that size.
  const labelSize = Math.max(8, Math.round(height * (compact ? 0.020 : 0.018)));
  context.save();
  try {
    context.translate(safe + labelSize, Math.round(height * 0.72));
    context.rotate(-Math.PI / 2);
    context.globalAlpha = intensity * 0.86;
    context.fillStyle = colors.paper;
    context.font = `800 ${labelSize}px system-ui, sans-serif`;
    context.textBaseline = 'top';
    context.fillText('DITHERLAB', 0, 0);
  } finally {
    context.restore();
  }

  // Small caution key at the opposite edge balances the orange warning slab.
  context.globalAlpha = intensity * 0.82;
  context.fillStyle = colors.caution;
  context.fillRect(width - safe - lineWidth * 9, safe, lineWidth * 9, lineWidth * 3);
}

/**
 * Draw one command-sequence frame over an already-rendered source.
 *
 * `context` is the destination 2D context. `sourceCanvas` should contain the
 * same base frame that is already visible in that destination. `scratchCanvas`
 * must be a distinct reusable canvas; it is resized only when output dimensions
 * change. Intensity zero is a strict no-op. The returned state is useful for
 * instrumentation and tests.
 */
export function drawCommandSequence(context, sourceCanvas, scratchCanvas, options = {}) {
  const config = options && typeof options === 'object' ? options : {};
  const fallbackWidth = sourceCanvas?.width ?? context?.canvas?.width ?? 1;
  const fallbackHeight = sourceCanvas?.height ?? context?.canvas?.height ?? 1;
  const state = commandSequenceState(
    config.phase,
    config.intensity ?? 1,
    config.width ?? fallbackWidth,
    config.height ?? fallbackHeight,
  );
  if (state.intensity <= 0) return state;

  requireDrawingInputs(context, sourceCanvas, scratchCanvas);
  const activeDisplacement = state.slices.some((slice) => slice.active);

  context.save();
  try {
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.globalCompositeOperation = 'source-over';
    context.globalAlpha = 1;
    context.filter = 'none';

    if (activeDisplacement) {
      copySourceToScratch(sourceCanvas, scratchCanvas, state.width, state.height);
      for (const slice of state.slices) {
        drawWrappedSlice(context, scratchCanvas, slice, state.width, state.height);
      }
    }
    drawOverlay(context, state);
  } finally {
    context.restore();
  }
  return state;
}
