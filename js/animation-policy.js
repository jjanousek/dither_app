export function gravityAnimationSupported({ mode, sourceType, colorMode } = {}) {
  return mode === 'ascii' && sourceType === 'image' && colorMode !== 'bg';
}

// These styles only change the final composited image. Repaint them from the
// retained dither/ASCII result instead of rerunning the expensive Engine pass
// for every animation tick.
export function postFXOnlyAnimation(style) {
  return style === 'command' || style === 'fluted';
}

export function advanceAnimationPhase(phase, delta, { oneShot = false } = {}) {
  const next = Math.max(0, Number(phase) || 0) + Math.max(0, Number(delta) || 0);
  return oneShot ? Math.min(1, next) : next % 1;
}

// Loop exporters intentionally omit phase 1 because it duplicates phase 0.
// One-shot exporters need that terminal sample, so remap their final i/count
// value to exactly one without changing the established exporter contract.
export function oneShotExportPhase(samplePhase, frameCount) {
  const count = Math.max(2, Math.floor(Number(frameCount) || 0));
  return Math.min(1, Math.max(0, Number(samplePhase) || 0) * count / (count - 1));
}
