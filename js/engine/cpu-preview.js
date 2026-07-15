// Async CPU-dither preview manager. Live error-diffusion runs in a worker so
// the UI thread stays responsive; the worker runs the SAME errorDiffusion, so
// output is byte-identical. Exports never use this path (they stay synchronous
// and frame-accurate). On any worker failure it falls back to the sync path,
// so the worst case is exactly today's behaviour.
//
// Model (per the agreed design): one job in flight; when a new frame is ready
// and the worker is busy we drop it (keep the latest committed result on
// screen); a settings/size change renders ONE synchronous frame so the display
// is always correct and correctly sized, then resumes async; results whose
// settings epoch no longer matches are discarded.
import { errorDiffusion } from './cpu.js';

export class CpuPreview {
  constructor(onResult) {
    this.onResult = onResult;      // called (on the main thread) when a fresh result committed
    this.state = 'init';           // 'init' | 'ready' | 'failed'
    this.worker = null;
    this.busy = false;
    this.epoch = 0;                // bumps on any dither-settings/size change
    this.committedEpoch = -1;      // epoch of the frame currently in `committed`
    this.commitGeneration = 0;     // bumps whenever committed pixels mutate
    this.sig = '';
    this.cw = 0;
    this.ch = 0;
    this.committed = document.createElement('canvas');
    this.cctx = this.committed.getContext('2d');
    this._timer = null;            // watchdog: reply never comes -> fall back to sync
    this.pending = false;          // new content arrived while the worker was busy
    // Detailed render clients consume worker landings exactly once. The canvas
    // is still borrowed/mutable; callers that retain it must copy immediately.
    this._landed = null;
    this._inFlight = null;
  }

  #ensure() {
    if (this.state !== 'init') return;
    try {
      this.worker = new Worker(new URL('./dither-worker.js', import.meta.url), { type: 'module' });
      this.worker.onmessage = (e) => this.#onMessage(e.data);
      this.worker.onerror = () => this.#fail();
      this.state = 'ready';
    } catch {
      this.state = 'failed';
    }
  }

  // Give up on the worker and wake the render loop so it does one synchronous
  // render (render() now returns null -> caller runs errorDiffusion inline).
  // Without the wake, a parked still image would stay on the stale frame.
  #fail() {
    this.state = 'failed';
    this.busy = false;
    this.pending = false;
    this._landed = null;
    this._inFlight = null;
    clearTimeout(this._timer);
    // A failed/hung module worker otherwise stays retained for the lifetime of
    // the editor even though every subsequent frame uses the sync fallback.
    this.worker?.terminate();
    this.worker = null;
    // The recovery wake renders through a different synchronous surface. Make
    // retained Post-FX texture keys reject the previously committed bitmap.
    this.commitGeneration++;
    if (this.onResult) this.onResult();
  }

  // Force the next render to produce a fresh SYNCHRONOUS frame and discard any
  // in-flight result. Needed on a source switch: settings/size can be
  // unchanged (so `sig` is identical) while the pixels differ, which would
  // otherwise show the old source's dither until the worker catches up.
  invalidate() {
    this.epoch++;      // in-flight replies carry the old epoch -> discarded
    this.pending = false;
    this._landed = null;
    this._inFlight = null;
  }

  // Consume the most recent worker landing once. Legacy callers never need
  // this; Engine.renderDetailed() uses it to pair the borrowed processed canvas
  // with the raw snapshot captured when that exact job was accepted.
  takeCommittedResult() {
    const landed = this._landed;
    this._landed = null;
    return landed;
  }

  #commit(imgData, w, h, epoch) {
    if (this.committed.width !== w || this.committed.height !== h) {
      this.committed.width = w;
      this.committed.height = h;
    }
    this.cctx.putImageData(imgData, 0, 0);
    this.cw = w;
    this.ch = h;
    this.committedEpoch = epoch;
    this.commitGeneration++;
  }

  #onMessage(data) {
    this.busy = false;
    clearTimeout(this._timer);
    const { buffer, w, h, epoch, token = null } = data;
    const accepted = this._inFlight;
    this._inFlight = null;
    if (epoch !== this.epoch) return; // settings changed since dispatch — discard
    this.#commit(new ImageData(new Uint8ClampedArray(buffer), w, h), w, h, epoch);
    if (accepted || token !== null) {
      this._landed = {
        canvas: this.committed,
        token: token ?? accepted?.token ?? null,
        descriptor: accepted?.descriptor ?? { width: w, height: h, samplingKind: 'crisp', asciiGridInfo: null },
      };
    }
    if (this.onResult) this.onResult();
  }

  // Returns the canvas to present, or null to tell the caller to render sync.
  // `img` is a real, already-adjusted ImageData at the work size. `contentNew`
  // is true when this render was triggered by genuinely new content (a user
  // change / new video frame / animation tick) vs a worker-completion wake-up.
  render(img, w, h, palette, kernelId, opts, sig, ctx, contentNew, detail = null) {
    this.#ensure();
    if (this.state !== 'ready') return null;
    if (sig !== this.sig) { this.sig = sig; this.epoch++; }
    const detailed = !!detail;
    const descriptor = detailed
      ? (detail.descriptor ?? { width: w, height: h, samplingKind: 'crisp', asciiGridInfo: null })
      : null;

    // Cold start, or size/settings change: dither this frame synchronously so
    // the on-screen result is always current and correctly sized. Then async
    // takes over for subsequent unchanged-settings frames.
    if (this.committedEpoch !== this.epoch || this.cw !== w || this.ch !== h) {
      errorDiffusion(img, palette, kernelId, opts);
      ctx.putImageData(img, 0, 0);
      this.#commit(img, w, h, this.epoch);
      this.pending = false;
      return detailed
        ? { canvas: this.committed, rendered: true, acceptedJob: null }
        : this.committed;
    }

    // Steady state: new content marks work pending; dispatch the CURRENT frame
    // (freshest pixels) whenever the worker is free. A frame that arrives while
    // busy stays pending and is dispatched as soon as the worker replies, so
    // the preview never settles on a stale frame. The transferred buffer means
    // `img` must not be used afterwards; we return the committed result.
    if (contentNew) this.pending = true;
    let acceptedJob = null;
    if (this.pending && !this.busy) {
      if (detailed) {
        const planned = detail?.makeAcceptedJob?.(descriptor) ?? null;
        acceptedJob = planned ? { ...planned, descriptor } : { token: null, targetPlan: null, descriptor };
      }
      this.pending = false;
      this.busy = true;
      if (detailed) {
        this._inFlight = {
          epoch: this.epoch,
          token: acceptedJob.token,
          descriptor,
        };
      }
      const message = { buffer: img.data.buffer, w, h, palette, kernelId, opts, epoch: this.epoch };
      if (detailed) message.token = acceptedJob.token;
      this.worker.postMessage(message, [img.data.buffer]);
      // If a reply never lands (worker module failed to load / hung), give up
      // on the worker and fall back to the synchronous path — never freeze.
      clearTimeout(this._timer);
      this._timer = setTimeout(() => this.#fail(), 2000);
    }
    return detailed
      ? { canvas: this.committed, rendered: false, acceptedJob }
      : this.committed;
  }
}
