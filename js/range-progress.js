export function syncRangeProgress(input) {
  if (!input?.style) return 0;
  const min = Number(input.min);
  const max = Number(input.max);
  const value = Number(input.value);
  const span = max - min;
  const percent = Number.isFinite(value) && Number.isFinite(span) && span > 0
    ? Math.min(100, Math.max(0, ((value - min) / span) * 100))
    : 0;
  const next = String(Math.round(percent * 1000) / 1000);
  const current = input.style.getPropertyValue?.('--p') ?? input.style['--p'];
  if (current !== next) {
    if (input.style.setProperty) input.style.setProperty('--p', next);
    else input.style['--p'] = next;
  }
  return percent;
}
