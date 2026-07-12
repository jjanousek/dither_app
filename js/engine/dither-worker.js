// CPU error-diffusion offloaded to a worker so a heavy dither (~30–40ms on
// 1080p in WebKit) doesn't block the UI thread. It imports the SAME
// errorDiffusion as the main thread, so the output is byte-identical — this
// worker only moves where the work runs, never what it computes.
import { errorDiffusion } from './cpu.js';

self.onmessage = (e) => {
  const { buffer, w, h, palette, kernelId, opts, epoch } = e.data;
  const img = { width: w, height: h, data: new Uint8ClampedArray(buffer) };
  errorDiffusion(img, palette, kernelId, opts);
  // transfer the pixel buffer back (palette is small — left cloned)
  const response = { buffer: img.data.buffer, w, h, epoch };
  if (Object.prototype.hasOwnProperty.call(e.data, 'token')) response.token = e.data.token;
  self.postMessage(response, [img.data.buffer]);
};
