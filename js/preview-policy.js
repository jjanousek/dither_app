// Live CPU error diffusion is pixel-size aware: fine settings receive more
// work pixels, while coarser settings keep the lower budget that protects
// playback cadence on fanless laptops.

export const LIVE_CPU_DITHER_BUDGETS = Object.freeze({
  fine: 640_000,
  balanced: 420_000,
  coarse: 200_000,
});

export function liveCpuDitherBudget(pixelSize) {
  if (pixelSize <= 1) return LIVE_CPU_DITHER_BUDGETS.fine;
  if (pixelSize <= 2) return LIVE_CPU_DITHER_BUDGETS.balanced;
  return LIVE_CPU_DITHER_BUDGETS.coarse;
}

// A CPU preview frame has two main-loop events: accepting fresh media pixels,
// then presenting the worker result. Only the first event is a new source
// frame; counting both makes a 30 fps clip claim roughly 60 fps.
export function shouldSamplePlaybackCadence(playing, animating, contentNew) {
  return !!(contentNew && (playing || animating));
}
