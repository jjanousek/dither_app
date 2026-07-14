export const EXPORT_DEFAULTS = Object.freeze({
  pngSize: 'source',
  gifSize: '480',
  recordSeconds: '5',
  txtFormat: 'plain',
});

const EXPORT_KEYS = Object.freeze(Object.keys(EXPORT_DEFAULTS));

export function createExportSettings() {
  return { ...EXPORT_DEFAULTS };
}

export function snapshotExportSettings(settings) {
  return Object.fromEntries(EXPORT_KEYS.map((key) => [key, settings[key] ?? EXPORT_DEFAULTS[key]]));
}

export function restoreExportSettings(target, snapshot = null) {
  const runtime = Object.fromEntries(
    Object.entries(target).filter(([key]) => !EXPORT_KEYS.includes(key)),
  );
  Object.assign(target, EXPORT_DEFAULTS, snapshot || {}, runtime);
  return target;
}

export function exportPanelPolicy({ sourceType, animationActive = false } = {}) {
  const moving = ['video', 'webcam', 'animated-image', 'gen'].includes(sourceType);
  const showGifSize = moving || (sourceType === 'image' && animationActive);
  let durationLabel = null;
  if (sourceType === 'webcam' || sourceType === 'animated-image') durationLabel = 'Capture length';
  else if (sourceType === 'gen' || (sourceType === 'image' && animationActive)) durationLabel = 'Video length';
  return { showGifSize, durationLabel };
}

export function textExportDescriptor(format) {
  if (format === 'ansi') return { label: 'ANSI', title: 'Download full-frame ANSI text' };
  if (format === 'html') return { label: 'HTML', title: 'Download full-frame HTML text' };
  return { label: 'TXT', title: 'Download full-frame ASCII text' };
}
