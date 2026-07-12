# Ditherlab Effect Mask

Status: Recommended and independently reviewed; no implementation has started  
Prepared: 2026-07-11  
Target: the current working tree at `/Users/aischool/work/dither_tool`

## Executive decision

Build one source-space **Effect Mask** above the rendering engines. Keep normalized vector strokes as the editable source of truth, rasterize them only into disposable size-specific caches, and composite the raw and processed branches at the final preview/export target resolution.

- Mask coverage `0` means the untouched source.
- Mask coverage `1` means the complete processed branch: adjustments, the selected Dither/ASCII/cell renderer, animation, and Post FX.
- Values between `0` and `1` produce a feathered blend.

The renderer should continue processing the whole frame. A new final-frame compositor should blend that processed frame with the raw source through the mask. This is the only approach that gives the same behavior across CPU error diffusion, GPU dithers, ASCII, Dots, LEGO, Voxel, LED, Lattice, and Mosaic without duplicating mask rules inside every renderer.

The compositor must not blend at the renderer's low-resolution work grid. It must first scale the processed branch with its existing crisp-or-smooth rule, scale the raw branch smoothly, and blend both at a source-aspect preview/export target. Otherwise an area labelled “original” would become a 160×90 or 480×270 video work frame enlarged to the viewport.

For video in the first release, the mask is static in frame coordinates and applies to every frame. Time-varying masks, subject segmentation, and object tracking are explicitly later work.

## Baseline and repository condition

The application source is `/Users/aischool/work/dither_tool`, whose remote is `git@github.com:jjanousek/dither_app.git`.

The source repository is on `main`, one commit ahead of `origin/main`, and has a substantial pre-existing dirty working tree: 15 modified tracked files plus untracked tests and QA artifacts. The working tree contains roughly 1,575 added and 443 removed lines across the modified tracked files. This analysis intentionally targets that live working tree; implementation must first preserve it as an explicit baseline so the existing video/export work is not mixed accidentally into the mask feature.

No source code was modified during this analysis.

## Current system analysis

### Runtime and application shell

- Ditherlab is a dependency-free single-page app made from vanilla ES modules, Canvas 2D, and WebGL2 (`README.md:177-198`, `package.json:1-9`).
- The web entrypoint is `index.html:70-122`; `js/main.js` owns state, source lifecycle, the render loop, viewport presentation, history, and export orchestration (`js/main.js:1-39`).
- The macOS distribution is a Swift/AppKit `WKWebView` wrapper with a loopback HTTP server (`scripts/main.swift:1-120`). Exports are intercepted by the wrapper and saved to Downloads (`scripts/main.swift:390-430`).
- Sources include images, animated GIFs, videos, webcam feeds, generative canvases, drag/drop, and paste (`js/sources.js:43-183`).

### Render topology

`Engine.render()` is the central mode router (`js/engine/engine.js:198-297`):

- ASCII goes to `#renderAscii()` (`js/engine/engine.js:722-782`).
- Dots, LEGO, Voxel, LED, Lattice, and Mosaic go to `#renderCells()` (`js/engine/engine.js:784-834`).
- Dither selects a GPU or CPU path according to the algorithm and WebGL availability (`js/engine/engine.js:207-297`).

The GPU dither path uses one fragment shader for ordered/noise/halftone/quantize algorithms (`js/engine/shaders.js:74-251`). CPU error diffusion uses the same `errorDiffusion()` implementation in both the main thread and the preview worker (`js/engine/cpu.js:202-284`, `js/engine/cpu-preview.js:87-126`).

Renderer output dimensions are not uniform:

- Dither resolution depends on source size, pixel size, live/export budgets, and smoothness supersampling (`js/engine/engine.js:207-266`).
- ASCII uses renderer-specific source sampling densities and a glyph-sized output bitmap (`js/engine/engine.js:722-781`).
- Cell modes construct their own cell-grid output canvas (`js/engine/engine.js:784-834`).

This is why a mask tied to preview pixels would drift or soften when modes, zoom, preview budgets, or export sizes change.

### Live presentation and performance

`renderOnce()` derives parameters, selects a live or offline pixel budget, runs `Engine.render()`, and hands the result to `present()` (`js/main.js:188-229`). `present()` applies Post FX, scales/copies the result into the visible output canvas, and redraws the before/after split (`js/main.js:239-328`).

Video already has careful performance work:

- `requestVideoFrameCallback` prevents reprocessing duplicate decoded frames (`js/main.js:77-88`, `js/main.js:674-703`).
- A sustained-load governor reduces smoothness supersampling before reducing base resolution (`js/main.js:51-76`, `js/main.js:330-379`).
- GPU video ingest avoids a costly Canvas 2D native-frame readback where possible (`js/engine/engine.js:268-297`, `js/engine/engine.js:314-330`).
- Temporal smoothing and denoise use a motion-aware FBO pre-pass (`js/engine/engine.js:526-593`).

A live mask must not undo those gains by rerasterizing the mask or forcing a native video-to-CPU readback every frame.

### Viewport and input

The viewport applies one CSS translate/scale transform to the canvas stack (`js/view.js:31-71`). Every primary-pointer drag not aimed at an existing control currently pans (`js/view.js:131-156`). The stack contains only processed output and the comparison canvas (`index.html:70-95`).

Brush input therefore needs one authoritative tool router. Adding an independent pointer listener would create nondeterministic brush-versus-pan behavior.

### State and history

The tunable effect schema is in `js/state.js:27-101`. It has no mask, selection, project, keyframe, or tracking state. Presets deep-merge into that schema (`js/state.js:107-116`).

Undo/redo currently JSON-serializes effect state plus optional generative-scene parameters, with a 100-entry cap (`js/main.js:480-547`). A full-resolution bitmap must not be inserted into these snapshots: one 4K RGBA mask is roughly 33 MB before history overhead.

### Export topology

Exports are not fully centralized:

- Preview and frame-accurate video receive frames through `renderOnce()`/`present()` (`js/main.js:188-296`, `js/main.js:925-1073`).
- PNG bypasses `present()`, calls `engine.render()` directly, applies its own target sizing, and then applies Post FX (`js/main.js:788-855`).
- H.264/MP4 selects an encoder target size and applies one global smoothing policy while scaling the processed frame (`js/export/exporters.js:77-183`).
- GIF applies exact integer decimation for crisp dither or box averaging for continuous output, then runs an optional post-decimation hook (`js/export/exporters.js:573-656`).
- TXT/ANSI/HTML exports use ASCII metadata, not the final bitmap (`js/main.js:1185-1217`).

This export split is the largest implementation risk. A mixed photographic/dither frame cannot use one global scaling policy: the effect branch may need nearest-neighbor scaling while the raw branch must stay smoothly resampled.

## Current verification results

The following checks were run against the current working tree before planning:

- `npm test`: 39 tests passed, 0 failed.
- Node's experimental coverage report showed 71.91% line coverage across modules imported by the tests, but only 20.11% for `js/export/exporters.js` and 21.51% for `js/sources.js`; `js/main.js`, viewport gestures, and WebGL orchestration are browser-only and absent from that report.
- `node --check` across all 22 JavaScript modules: passed.
- Python AST parsing for both Python scripts, `zsh -n` for both shell scripts, and `swiftc -typecheck` for the native wrapper: passed.
- The local server returned the app and ES modules with the expected content types and rejected both missing paths and `/.git/config` with 404 responses (`scripts/serve.py:42-68`).
- Headful Chromium used WebGL2 through `ANGLE Metal Renderer: Apple M4`; the demo loaded with no console/page errors. All eight modes produced distinct nonblank canvas checksums. GPU Bayer with Smoothness used the box-resolved path; split and undo/redo worked.
- The 640×360, 30 fps H.264/AAC fixture loaded through the real file-input event. It received the intended live-video profile (Blue Noise, Smoothness 0.5, Temporal 0.4, Denoise 0.2), exposed transport/GIF/video controls, and produced different rendered checksums at 0s and 2s.
- Real browser downloads completed without reported failure for PNG (`640×360`), GIF, frame-accurate WebCodecs MP4, and ASCII TXT. GIF and MP4 restored the paused video to its pre-export time.
- A 1920×1080 fixture played at a reported 29 fps in the headful GPU path. A paused Blue Noise render measured about 8 ms median / 8.6 ms p90 on this M4 test host. The live Floyd worker reached its ready/committed state and produced an 864×486 frame at pixel size 2.

The current automated suite protects algorithm output, ASCII metadata, cell-renderer regressions, GIF encoding, MP4 muxing, animated-GIF detection, and live CPU budgets (`tests/core-regressions.test.js:81-206`, `tests/core-regressions.test.js:349-554`, `tests/ascii-cells-regressions.test.js:78-307`). It does not cover the DOM, viewport coordinate mapping, WebGL pixel correctness, pointer gestures, full export pixel equivalence, webcam permissions, or native-shell interaction. The new feature should close the relevant gaps without introducing a package dependency.

## Product specification

### Problem

Today an effect always covers the full frame. A user cannot reveal an untouched face, object, title, or background, nor can they confine ASCII/dither styling to one region.

### Goals

- Let a user paint where the processed effect is visible.
- Let a user paint the inverse: regions that stay original.
- Make the same mask work when switching among all eight visual modes.
- Keep brush alignment stable across pan, zoom, renderer resolution, playback, and export.
- Include the mask in PNG, GIF, video, animated-still, generative, webcam, and raster ASCII output.
- Preserve existing output exactly and add effectively zero frame cost when the mask is in its default full-effect state.
- Keep the feature local, dependency-free, reversible, and compatible with the native macOS shell.

### Non-goals for the first release

- Object or face tracking.
- Automatic subject/background segmentation.
- Per-frame rotoscoping.
- Timeline keyframes or time-ranged masks.
- Multiple independently masked effect layers.
- Imported Photoshop-style layer masks.
- Project-file persistence. The current app has no project persistence layer.
- Pressure-sensitive or tilt-sensitive brushes. The data contract may reserve pressure, but first-release behavior is deterministic mouse/trackpad input.

### Terminology and coverage model

Call the feature **Effect Mask**, not “Dither Brush,” because it applies to every renderer.

The canonical coverage equation is:

```text
premulRGB(final) = m * premulRGB(processed) + (1 - m) * premulRGB(raw)
alpha(final)     = m * alpha(processed)     + (1 - m) * alpha(raw)
```

`m` is effect coverage in `[0,1]`. The blend must be implemented in premultiplied RGBA space so soft edges on transparent PNGs do not produce dark or light halos. The Canvas 2D correctness backend uses two transparent scratch branches: mask processed by `m`, mask raw by `1-m`, then add the premultiplied branches with `lighter`. Normal `source-over` between the branches is not equivalent when either input is translucent. A GPU backend must implement the same equations.

The raw branch is the untouched source frame. Brightness, contrast, color adjustments, animation, the active renderer, and Post FX all belong to the processed branch. This makes “Reveal original” literal and predictable.

### Default behavior

- A new source starts with an empty painted selection and **Effect outside painted area**, so the effective coverage is all ones and opening Ditherlab remains pixel-identical to current behavior.
- The brush adds to the painted selection; the eraser subtracts from it. With the default placement, painting reveals the original.
- Switching to **Effect inside painted area** complements the effective coverage without rewriting the selection, directly supporting “paint where the effect appears.”
- Presets, Shuffle, palette changes, mode changes, and renderer changes retain the mask.
- Reset All returns the mask to Effect everywhere and is undoable.
- Loading a different source creates a fresh Effect-everywhere mask and a new undo-history baseline. Source replacement is not undoable today, so retaining mask actions from the discarded source would create invisible or incorrect Undo steps.
- Invert toggles inside/outside placement without deleting or rewriting strokes.

### Proposed controls

Add a Mask/Brush tool to the top bar and a Mask section in the side panel.

The toolbar button controls editing mode, not whether the mask is applied. Closing the tool leaves the composition intact. When effective coverage is not uniform one, the button retains a small “mask present” indicator and the status bar shows `Masked · effect inside|outside`; either reopens the editor. This prevents an invisible closed tool from making the output feel mysteriously altered.

The side panel contains:

- Effect placement: `Outside painted area` / `Inside painted area`.
- Tool: `Brush` / `Eraser`.
- Size: brush diameter stored relative to the shorter source dimension.
- Hardness: hard edge at 100%, deterministic feathering below 100%.
- Opacity: partial coverage per stroke.
- Overlay: show/hide a colored editing overlay.
- Invert placement.
- Effect everywhere (clear selection + outside placement).
- Original everywhere (clear selection + inside placement).
- Clear painted selection, retaining the current placement.

Suggested shortcuts:

- `B`: activate the mask brush.
- `E`: switch between Brush and Eraser while the mask tool is active.
- `[` and `]`: decrease/increase brush size.
- Space-drag or middle-button drag: temporarily pan while the brush is active.
- Outside brush mode, Space keeps its current video play/pause behavior (`js/main.js:1397-1401`).

Entering brush mode temporarily suppresses Compare/Split overlays so the editable final result is not hidden beneath the raw comparison. Their previous state returns when brush mode ends.

### Painting behavior

- Primary-pointer down begins one stroke; pointer up/cancel commits it as one undo action.
- Use coalesced pointer events when available.
- Interpolate cached brush stamps between points so fast movement cannot leave gaps.
- Convert pointer position to normalized source coordinates `(u, v)` after accounting for the viewport's CSS transform.
- Ignore points outside the displayed source bounds; clamp a stroke when crossing an edge.
- The brush cursor scales with zoom because brush size is image-relative.
- Overlay and cursor are editor-only and never appear in exports.
- Mask-only edits re-composite the cached paired frame bundle without rerunning the expensive renderer; the first bypass-to-active edit primes that bundle once as specified below.
- The mixed preview must be composed at a source-aspect display backing size, not at the renderer work-grid size. Crisp processed pixels are nearest-scaled into that canvas; the raw branch is smoothly sampled.

### Video behavior in the first release

- One static frame-space mask applies to the complete clip.
- Seeking or playback does not move or change the mask.
- Starting a stroke while video is playing pauses it and does not auto-resume.
- The user may seek to a representative frame, edit the static mask, then play to inspect it.
- The UI must say `Static mask - applies to every frame`; it must not imply tracking.
- Animated GIF sources, webcam, and generative sources use the same static normalized mask contract.

### Compare and split semantics

- Compare shows the untouched raw source.
- Split compares raw source on the left with the final masked composite on the right.
- Brush mode temporarily hides comparison overlays, while preserving the user's split preference for restoration afterward.
- Preset thumbnails remain unmasked in v1: they preview the look itself on the source crop, while applying a preset preserves and immediately reuses the current mask.

### Text export semantics

TXT, ANSI, standalone HTML, and Copy Text cannot embed photographic raw-source patches. When an Effect Mask is active:

- Raster ASCII in PNG/GIF/video is masked normally.
- TXT/ANSI/HTML and clipboard text remain a complete ASCII grid.
- The Export section and Copy Text action display: `Effect Mask applies to raster and video exports; text output remains full-frame ASCII.`
- A `captureMetadata`-only render (`js/main.js:1185-1217`) skips raw snapshots, target allocation, Post FX, and pixel finalization; it only refreshes the renderer's text/grid metadata.

This avoids silently turning excluded regions into spaces or inventing a format-specific interpretation.

## Technical design

### Canonical mask document

Store immutable normalized vector strokes, not a full-resolution bitmap:

```js
{
  version: 1,
  sourceId: 'ephemeral-source-token',
  sourceEpoch: 7,
  placement: 'outside', // effect is outside or inside the painted selection
  strokes: [{
    id: 42,
    operation: 'add' | 'erase',
    radiusNorm: 0.04,
    hardness: 0.8,
    opacity: 1,
    points: [{ u: 0.25, v: 0.40 }, { u: 0.27, v: 0.41 }]
  }],
  revision: 17
}
```

`radiusNorm` is relative to the shorter source edge. Raster canvases/textures are disposable caches keyed by `(sourceEpoch, revision, width, height, placement, normalizedCrop)`.

Use structural sharing between revisions. Completed strokes, placement changes, and clear create a new revision. Pointer-move samples update an in-progress preview stroke but do not create history entries. Internally, points should use compact numeric arrays after simplification rather than one object allocation per sample; reserve pressure in the serialized version even if v1 treats mouse/trackpad pressure as `1`.

The rasterizer is deterministic and uses these exact rules. Let `s` be existing painted-selection alpha and `a` be one brush stamp's alpha:

```text
add:   s' = a + s * (1 - a)
erase: s' = s * (1 - a)

effect coverage m = placement == 'inside' ? s : 1 - s
```

For normalized radial distance `d` and hardness `h`, a stamp has full weight for `d <= h`, zero for `d >= 1`, and `1 - smoothstep((d-h)/(1-h))` between them, where `smoothstep(t)=t*t*(3-2*t)`. Multiply by stroke opacity to obtain `a`; hardness `1` is the hard-step special case. Interpolate stamps no farther apart than one quarter of the brush radius. These equations define repeated-opacity accumulation and make raster goldens portable across preview and export sizes.

The document exposes `uniformCoverage()` as `0`, `1`, or `null`. The compositor bypass is legal only when it returns `1`. An empty selection with outside placement is the default all-effect/no-op state; an empty selection with inside placement is all-original and must still finalize a frame.

### Proposed modules

- `js/mask/model.js`: immutable document operations, revisioning, serialization, and point simplification.
- `js/mask/rasterizer.js`: deterministic Canvas 2D alpha rasterization and per-size cache.
- `js/mask/compositor.js`: target-resolution-aware final-frame composition with a Canvas 2D correctness backend.
- `js/mask/tools.js`: brush/pan input arbitration, pointer-to-UV conversion, cursor, and overlay state.
- Optional `js/mask/compositor-gl.js`: GPU source/effect/mask compositor if the video performance gate requires it.

No new package dependency is needed.

### Shared final-frame contract

Extract a common function conceptually shaped like:

```js
finalizeFrame({
  frameBundle, // processed canvas + matching raw snapshot + content/source epochs
  maskDocument,
  targetWidth,
  targetHeight,
  normalizedCrop,
  processedSampling, // nearest or smooth, derived from actual engine output
  postFX,
  grainPhase,
  refHeight,
}) -> Canvas
```

Pipeline order:

```text
source
  -> existing adjustments/animation/renderer
  -> scale processed branch with its current crisp-or-smooth rule
  -> apply Post FX to processed branch at the target scale

source
  -> smoothly scale untouched raw branch to the same target

mask document
  -> rasterize coverage at the same target

processed + raw + coverage
  -> premultiplied-RGBA final composite
```

When `maskDocument.uniformCoverage() === 1`, bypass the new composition work and preserve the current path byte-for-byte. Any other value, including uniform zero, is an active finalization path.

The mixed-preview backing target is stable and deliberately independent of zoom, pan, viewport size, and `devicePixelRatio`; those remain logical display concerns owned by the existing CSS transform in `Viewport`. Start with the source dimensions, uniformly reduce them to `LIVE_FX_PIXELS` (2.25 MP), then uniformly enlarge the target only if necessary to avoid downscaling either dimension of the processed bitmap. The precedence is therefore: do not downscale an existing processed result; otherwise respect the 2.25 MP area cap; otherwise do not exceed native source size. This can exceed the cap only when an existing renderer already produced a larger bitmap.

Compute that target only on source change, transition into/out of a non-uniform mask, or a renderer/mode change whose processed bitmap no longer fits. Call `Viewport.contentResized()` once and let it preserve the on-screen rectangle (`js/view.js:74-92`); zoom and pan never resize the backing canvas, so they cannot create a resize/zoom feedback loop. A device-pixel-ratio change affects only browser presentation until the next explicit source/mode target invalidation. During `captureStream()`/MediaRecorder recording, lock the final canvas dimensions before starting the stream and release the lock only after stop/cancel (`js/main.js:865-901`).

### Why the compositor belongs above Engine

`Engine.render()` already converges every renderer on a canvas (`js/engine/engine.js:198-297`). Putting a mask inside the dither shader would omit CPU error diffusion, ASCII, cell modes, and Post FX. Putting it inside each renderer would duplicate logic and produce inconsistent feathering and source quality.

Full-frame processing followed by masking also avoids error-diffusion boundary seams: CPU diffusion may use neighboring pixels outside the revealed region, then the final compositor clips the already-computed result cleanly.

### Preview integration

Refactor `renderOnce()`/`present()` into two invalidation classes:

- **Effect dirty**: source frame, effect state, animation phase, or renderer result changed; rerun Engine.
- **Composite dirty**: only the mask, overlay, or target size changed; reuse the last processed frame and rerun final composition.

This prevents every brush pointer event from rerunning structural ASCII or CPU diffusion. The presentation step always uses the latest mask revision, never a revision captured when a worker job began.

Raw and processed pixels must also describe the same source frame. Increment a `contentEpoch` for each genuinely new source frame and a `sourceEpoch` on replacement. While a non-uniform mask is active, capture the raw branch at the stable preview target in the same JavaScript task that submits/runs the effect render, and keep a maximum three-entry raw-snapshot ring keyed by `(sourceEpoch, contentEpoch, targetWidth, targetHeight)`. Pin the epochs for the last presented commit, the in-flight CPU job, and the latest pending frame; newer dropped frames cannot evict the raw snapshot still paired with the displayed commit. Extend the engine/CPU-preview result metadata so synchronous results and worker commits report the `contentEpoch` they processed. If the CPU worker returns an older committed canvas while a newer frame is pending (`js/engine/engine.js:228-235`, `js/engine/cpu-preview.js:107-125`), present it only with its matching raw snapshot. A mask-only repaint reuses the last complete frame bundle. Clear the ring on source replacement, seek discontinuity where pending work is invalidated, and export teardown.

The first transition from uniform-one bypass to any active finalization state is a priming boundary: the bypass has no raw snapshot by design, so it must not reuse the unpaired cached processed canvas. This applies to the first stroke, inside/outside placement changes, and Undo/Redo restoring a mask. Pause a playing video, invalidate any async CPU preview, capture the raw target, and force one synchronous effect render at the normal live budget with a new content epoch. Only after that paired bundle is complete may the change use composite-only repainting. More generally, cached processed output is reusable only when the ring contains a raw snapshot with the same source/content epoch and target; otherwise run the same priming path.

An active mixed canvas must not receive the current `image-rendering: pixelated` class, because that would pixelate the raw branch too (`js/main.js:279-291`, `css/style.css:159-169`). Instead, nearest-neighbor scaling happens only while drawing a crisp processed branch into the high-resolution composite; normal canvas presentation preserves the photographic branch. `Viewport.contentResized()` already compensates when the output bitmap changes (`js/view.js:74-92`).

### PNG integration

Refactor `doExportPNG()` (`js/main.js:788-855`) to choose its final target dimensions first, then call the shared finalizer. The processed branch keeps the existing nearest/smooth policy based on `engine.lastBoxResolved`; the raw branch is always high-quality smooth sampling.

### GIF integration

Keep GIF's integer-divisor sizing and crisp-versus-box-decimation behavior (`js/export/exporters.js:588-649`). Compose only after the effect branch has reached the GIF target resolution, using the current post-decimation hook (`js/export/exporters.js:653-656`). At that point:

- Apply Post FX to the target-sized processed branch.
- Smoothly sample the raw frame at the same target size.
- Rasterize the mask at that size.
- Composite before palette analysis/encoding.

The adapter must also preserve the exporter's exact crop. GIF chooses `w=floor(first.width/div)` and reads only the top-left `w*div` by `h*div` pixels (`js/export/exporters.js:593-627`). Extend the post-process callback with `normalizedCrop = {u0:0, v0:0, u1:(w*div)/first.width, v1:(h*div)/first.height}` and use that same crop for raw sampling and mask rasterization. This prevents right/bottom registration drift while keeping protected photo regions out of nearest-neighbor dither decimation.

### MP4 integration

`makeH264Encoder()` currently owns target sizing and scales the complete processed frame with one policy (`js/export/exporters.js:80-103`, `js/export/exporters.js:154-168`). Replace the masked path with an explicit two-stage first-frame API:

1. Render the first processed frame without mask finalization.
2. Derive crisp/smooth policy and choose encoder dimensions from that processed frame.
3. Create the encoder for those dimensions.
4. Finalize the first and every subsequent frame exactly once at encoder dimensions.
5. Require `encoder.add()` to accept an already-final canvas of exactly those dimensions and encode it 1:1.

Per-frame finalization then:

- Nearest-scale a crisp dither branch.
- Smooth-scale a continuous/ASCII branch according to the current rule.
- Smooth-scale the raw branch.
- Rasterize and blend the mask.
- Encode the already-final frame.

Frame-accurate seeking stays unchanged (`js/export/exporters.js:204-283`). The MediaRecorder fallback captures the finalized visible canvas, so it receives the mask automatically after preview integration.

### Live-video compositor choice

Start with a normal, non-`willReadFrequently` Canvas 2D final compositor because it is universal and testable. Benchmark it before declaring video complete.

Split timing into effect-render and final-composite EMAs. Mask-only recomposition never updates the supersampling governor. For genuinely new frames, the governor sees effect-render time only; composite time is reported separately. When a mask is active, cadence degradation by itself must not lower supersampling while the effect-render EMA is healthy, because `ss -> 1` can enlarge the processed output grid and worsen compositor cost (`js/engine/engine.js:238-266`). A compositor-dominated cadence failure triggers the performance gate/GPU backend, not a misleading renderer-quality downgrade. The unmasked governor path stays unchanged.

If a static mask causes more than 10% cadence loss at 1080p Blue Noise versus the unmasked baseline on the same target device, implement the optional three-texture GPU backend:

- Raw source texture.
- Processed frame texture.
- Single-channel mask texture.

Upload/rasterize the mask only when its revision or target dimensions change. Do not upload it per video frame. Preserve the Canvas 2D backend as the WebGL-loss fallback.

### History integration

Replace string-only history entries with lightweight objects:

```js
{
  settingsSnapshot,
  generativeSnapshot,
  maskRevision,
  sourceEpoch
}
```

History entries reference immutable mask revisions; they do not copy stroke arrays, canvases, textures, or RGBA buffers. Preserve the current 100-entry cap and slider debounce (`js/main.js:497-513`). One completed stroke, placement change, clear, or Reset action is one discrete history entry. Undo followed by a new edit truncates redo exactly as it does today. Prune mask revisions no longer reachable from the retained history and current document.

### Source lifecycle

`setSource()` is the lifecycle boundary (`js/main.js:647-736`). Source replacement is one atomic document transition: clear `histTimer`, increment `sourceEpoch`, create a new empty/outside-placement mask document, clear raster/raw-frame caches, replace the global history stack with one baseline containing the settings that carry into the new source, and refresh Undo/Redo buttons. A later project-file feature could serialize mask documents, but source replacement must neither map old strokes onto unrelated media nor leave dead mask-only Undo actions behind.

## Alternatives considered

| Approach | Strengths | Weaknesses | Decision |
| --- | --- | --- | --- |
| Full-resolution raster mask as canonical state | Simplest painting loop; direct Canvas 2D compositing | Resolution-coupled; roughly 8.3 MB at 4K even as R8 and commonly about 33 MB as RGBA; expensive undo/export resizing | Prototype only |
| Normalized vector strokes + cached raster | Resolution-independent; compact stroke-level undo; deterministic preview/export replay; backend-agnostic | Requires deterministic rasterizer, cache, and point simplification | **Chosen** |
| GPU texture/FBO as canonical state | Fast stamping and video blending | Poor undo/persistence, context-loss recovery, fixed resolution, and still needs vector replay for export resizing | Optional compositor backend only |

### Full-resolution raster mask as canonical state

Easy to prototype, but resolution-dependent, memory-heavy, poor for undo, and awkward for 2x/4K exports. Use raster masks only as caches.

### Mask inside every renderer

Would require separate implementations for the GPU shader, CPU diffusion, four ASCII renderers, and six cell effects. It also leaves Post FX semantics ambiguous. Rejected.

### Mask only inside the dither shader

Fast for GPU dithers, but it does not cover CPU algorithms, ASCII, cell modes, or post-processing. Rejected as the universal architecture.

### Per-effect masks

Useful in a future layer stack, but Ditherlab currently has one active renderer. Multiple mask slots add state and UX without a current consumer. Rejected for the first release.

### Segmentation or tracking as the first implementation

Attractive for video, but it adds model/runtime choice, timeline semantics, tracking drift, correction UX, and likely dependencies. It should later produce masks through the same `rasterize(width, height, time)` interface. Rejected for the first release.

## Product decisions and recommended defaults

These defaults keep the first release coherent. They can be changed before implementation, but each change affects scope:

| Decision | Recommended v1 default | If changed |
| --- | --- | --- |
| What the mask gates | Complete processed look versus untouched source | “Dither only” would require a second globally-adjusted base branch and new Post FX semantics. |
| Video time behavior | One static frame-space mask for the entire clip | Keyframes add timeline UI, interpolation, storage, and export-time evaluation. Tracking is a further milestone. |
| ASCII/cell boundary | Freeform soft clipping through glyphs/cells | Grid snapping needs renderer-aware coverage rules and loses cross-mode geometric identity. |
| Text export | Keep TXT/ANSI/HTML/clipboard text full-frame and show a notice | Blank-cell masking is possible but cannot reproduce photographic protected regions. |
| Persistence | Current session only | Editable project save needs a versioned project format and source identity/fingerprint policy. |

## Acceptance criteria

| Area | Criterion |
| --- | --- |
| Compatibility | With effective uniform coverage `1`, every renderer and export matches the pre-feature baseline and the compositor bypasses all new raster/snapshot work. |
| Fill states | Effect everywhere matches the processed branch; Original everywhere matches the raw source at the target resolution. |
| Raw detail | A protected/raw preview region is sampled at the mixed preview target, never enlarged from the renderer's dither/ASCII/cell work grid. |
| Mixed sampling | Crisp dither is nearest-scaled before composition; raw photography is smoothly scaled; CSS `image-rendering: pixelated` is never applied to the complete mixed canvas. |
| Preview target | Masked backing dimensions follow the stable 2.25 MP/source/processed precedence, do not change on pan/zoom/DPR alone, and do not cancel a requested zoom through `contentResized()`. |
| Invert | Invert produces the exact coverage complement and preserves all strokes. |
| Coordinates | A stroke stays aligned within one target pixel after pan, zoom, fit, 1:1, mode changes, preview-budget changes, and export. |
| Brush | Fast pointer movement creates a continuous stroke with no gaps larger than one raster pixel at the current target. |
| Hardness | Hardness 100% has the specified hard edge; lower values match the documented smoothstep falloff at golden sample distances. |
| Opacity | Repeated add/erase strokes match the documented source-over/destination-out selection equations. |
| History | One completed stroke/placement/clear is one undo action; redo restores it; a new edit after undo truncates redo. |
| Presets | Presets, Shuffle, palette changes, and mode changes retain the mask. |
| Source | Loading a new source resets to Effect everywhere and seeds a fresh history baseline; Undo cannot resurrect strokes from a discarded source. |
| Still preview | Dither, ASCII, and every cell renderer show the same mask geometry. |
| Video | The same static region remains masked during playback, pause, seek, speed changes, GIF sampling, and MP4 stepping. |
| Frame pairing | A delayed async CPU result is composited only with the raw snapshot carrying the same source/content epoch; no moving edge shows mixed timestamps. |
| Activation priming | First stroke, placement change, or Undo/Redo from uniform-one bypass pauses live video and creates one forced paired bundle before any composite-only repaint. |
| Video UX | Beginning a stroke pauses a playing video and the UI states that the mask applies to every frame. |
| Exports | PNG, crop-registered GIF, single-finalization MP4, animated still, generative, and MediaRecorder output contain the mask and exclude overlay/cursor; MediaRecorder dimensions stay fixed for the recording. |
| Text exports | TXT/ANSI/HTML and Copy Text remain full-frame, display a raster-only mask notice, and metadata-only rendering does not run pixel finalization. |
| Compare | Compare shows raw source; Split shows raw source versus the final masked composite. |
| Alpha | Opaque/translucent raw and processed inputs at multiple mask values match the documented premultiplied equations exactly, with no dark/light halo. |
| No-op cost | Only effective uniform-one coverage bypasses; that state does not rasterize, snapshot raw pixels, allocate a mask, or add measurable per-frame work. |
| Cache | An unchanged static mask is not rerasterized or re-uploaded on each video frame; source epoch, revision, dimensions, placement, and crop prevent stale reuse. |
| Performance | On the same target device and clip, active static-mask 1080p Blue Noise playback loses no more than 10% cadence versus the unmasked baseline. |
| Governor | Mask-only recomposition never trains the supersampling governor; compositor timing is reported separately and cannot trigger a cadence-only `ss -> 1` backfire. |
| Memory | History contains no canvas/RGBA snapshots and remains bounded under a 100-stroke stress test. |
| Native app | Browser and current WKWebView app pass the same image, video, and export smoke scenarios. |

## Implementation plan

### Baseline gate

- Preserve the current dirty working tree in a dedicated commit/branch before feature edits. Do not fold the existing 1,575-line video/export work into an Effect Mask commit.
- Target the tested July 11 working tree; do not rebase the feature onto the older public 1.2.4 source snapshot.
- Convert the successful browser smoke scenarios into a repeatable baseline harness.
- Add golden screenshots/frames for unmasked Dither CPU, Dither GPU, ASCII, one cell renderer, PNG, GIF, and MP4.

Exit gate: the preserved baseline has 39/39 tests passing, browser smoke green, and known release skew documented.

### Composition foundation

- Add `js/mask/model.js` with immutable revisions and normalized strokes.
- Add `js/mask/rasterizer.js` with deterministic hard/soft brush stamps and target-size caches.
- Add `js/mask/compositor.js` with the specified two-branch premultiplied blend and uniform-coverage bypass.
- Prototype the Canvas 2D compositor first and record masked/unmasked 1080p cadence before committing to a GPU backend.
- Extract a target-resolution final-frame contract from `js/main.js:188-296` and `js/main.js:788-855` without changing unmasked output.
- Add the stable mixed-preview target policy and MediaRecorder target lock; scale only the processed branch with nearest-neighbor when it is crisp.
- Introduce source/content epochs, frame-result metadata, and a bounded raw-snapshot ring so async CPU commits remain temporally paired.
- Add one `ensurePairedFrameBundle()` priming path for bypass-to-active transitions and any cache miss; it invalidates async CPU state and performs one synchronous live-budget render.
- Split render invalidation into effect-dirty and composite-dirty states.
- Split effect/compositor timing so mask-only work cannot train the renderer governor.
- Add pure unit tests for selection arithmetic, placement, alpha, replay determinism, cache keys, and history references before UI work.

Exit gate: unit tests prove exact blending and the no-mask baseline remains unchanged.

### Still-image interaction

- Add the toolbar control and mask overlay canvas in `index.html:11-95`.
- Add Mask section builders in `js/ui.js:169-614`, persistent mask-present/status indicators, and styling in `css/style.css`.
- Refactor `js/view.js:108-207` around a tool/input router and expose client-to-normalized-source mapping.
- Implement brush cursor, coalesced-point capture, interpolation, and pan arbitration in `js/mask/tools.js`.
- Integrate immutable mask revisions into `js/main.js:480-547` history.
- Make `js/main.js:647-736` source changes atomically clear pending history debounce, increment epoch, reset document/caches, and seed a fresh history baseline; retain the current document across presets and renderer changes.
- Integrate masked live preview and PNG for all modes.

Exit gate: every still-image acceptance criterion, PNG parity, and 100-step undo stress test passes.

### Raster export completion

- Extend GIF's post-decimation hook with exact divisor-crop geometry so raw, mask, and processed branches register at GIF dimensions (`js/export/exporters.js:573-656`).
- Refactor H.264 into the two-stage processed-first/target-plan/finalize-once API (`js/export/exporters.js:77-183`).
- Verify frame-accurate video, animated stills, generative scenes, and real-time MediaRecorder output.
- Add TXT/ANSI/HTML/Copy Text notices without changing text data, and skip pixel finalization on metadata-only renders.

Exit gate: selected preview frames match PNG/GIF/MP4 within format-appropriate tolerances.

### Video and webcam hardening

- Apply one static normalized mask across video, animated GIF, webcam, and generated frames.
- Pause on the first stroke and retain explicit manual playback controls.
- Add compositor revision counters to diagnostics so tests can prove no per-frame mask rerasterization.
- Benchmark unmasked versus masked 1080p Blue Noise and one CPU dither path.
- If the 10% cadence gate fails, implement `js/mask/compositor-gl.js` and reuse cached mask textures.
- Exercise WebGL context loss/fallback and deliberately delayed CPU worker completion over moving video while the mask changes.

Exit gate: video performance, seek/export alignment, webcam recording, and WebGL fallback pass.

### Release verification

- Run JS syntax checks and the complete Node suite.
- Run browser end-to-end scenarios at normal zoom and Retina scale.
- Run native WKWebView smoke tests for image, video, brush, undo, PNG, GIF, and MP4.
- Visually inspect hard/soft edges, transparent input, all renderer families, and masked video motion.
- Build a new versioned app/DMG and verify that bundled assets match the tested source tree.

Exit gate: no known errors, release artifact matches source, acceptance table is green, and remaining advanced-video work is explicitly deferred.

## Test plan

### Unit tests

- Selection add/erase, inside/outside placement, clear, uniform-coverage bypass, and opacity arithmetic.
- Stroke replay at multiple aspect ratios and resolutions.
- Fast-stroke interpolation and point simplification.
- UV conversion for fit, pan, zoom, and output-size changes.
- Hardness and feather golden alpha values.
- Premultiplied RGBA blending for combinations of opaque/translucent processed and raw inputs.
- Cache invalidation on source epoch/revision/size/placement/crop changes.
- Interleaved settings and mask undo/redo with the 100-entry cap, including a source replacement/history-boundary case.
- Export target sizing with different raw/effect sampling policies.

### Integration tests

- CPU Floyd-Steinberg, GPU Blue Noise, ramp ASCII, structural ASCII, and one renderer from each cell-effect complexity class.
- Post FX contained entirely inside the effect branch.
- Mixed preview target sizing: raw detail survives a coarse dither work grid, while crisp effect cells retain hard edges.
- Split/compare with active masks.
- First stroke on playing, deliberately delayed CPU-dither video: activation pauses, primes one synchronous paired bundle, and later worker results remain matched while the latest mask revision applies.
- PNG at work, source, and 2x sizes.
- GIF crisp/smooth paths including non-divisible right/bottom crop registration.
- MP4 crisp dither and continuous/raw mixed frames, 1:1 encoder input, and a guard against double finalization.
- Transparent PNG and non-square source geometry.
- Full-frame TXT/ANSI/HTML/Copy Text with no pixel finalization while a mask is active.

### Browser/native end-to-end tests

- Load still -> activate brush -> reveal original -> invert -> undo -> redo -> PNG.
- Load video -> play -> begin stroke -> verify pause -> seek -> play -> GIF -> MP4.
- Switch Dither -> ASCII -> LEGO while keeping mask alignment.
- Generate animated source -> mask -> looped GIF/video.
- Webcam -> static mask -> real-time recorder fallback.
- Lose/restore WebGL context and confirm the Canvas 2D fallback remains correct.

### Performance and memory tests

- Median render cadence and dropped-frame ratio for unmasked/masked 1080p Blue Noise.
- CPU error-diffusion cadence with the same static mask.
- Mask rasterization count over 300 unchanged video frames must remain one per revision/target size.
- Raw snapshot storage never exceeds three target-sized canvases and releases all entries on source replacement/export teardown.
- 100 strokes at representative point counts; verify bounded history memory and no RGBA snapshots.
- Brush latency on a paused 4K still; mask-only edits must not rerun Engine.
- Separate effect/compositor timing counters; mask-only edits leave governor EMAs unchanged.

## Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Raw regions become blocky in preview/GIF/MP4 | Compose at the preview/export final target with separate sampling policies; never blend at the effect work grid. |
| Mixed canvas pixelates the raw branch | Disable whole-canvas pixelated CSS when mixed and nearest-scale only the processed branch before composition. |
| Live video performance regresses | Bypass no-op masks, cache raster masks, benchmark Canvas 2D, and add the GPU compositor only if the gate fails. |
| Preview target fights zoom or recording | Keep backing target independent of zoom/pan/DPR and lock dimensions for MediaRecorder. |
| Brush input fights pan/split | One authoritative tool router; no independent viewport listeners. |
| Undo consumes excessive memory | Immutable normalized stroke documents with structural sharing; never snapshot pixels. |
| Brush feels laggy on CPU/ASCII | Separate effect-dirty and composite-dirty paths and reuse the last processed frame. |
| Worker result and raw branch show different frames | Carry content/source epochs through worker commits and composite only with the matching raw snapshot; always apply the latest mask revision. |
| Video users expect tracking | Label the feature Static mask and keep tracking as a later explicit milestone. |
| Transparent edges halo | Two independently masked premultiplied branches, additive combination, and exact alpha goldens. |
| Export paths diverge | One `finalizeFrame()` contract with preview/PNG/GIF/MP4 adapters. |
| Governor degrades the wrong stage | Measure effect and compositor separately; cadence-only compositor overload cannot lower supersampling. |
| Current dirty tree obscures regressions | Preserve/commit the current baseline before implementation and keep feature diffs isolated. |
| Release artifact does not match tested source | Version and rebuild the app/DMG only after acceptance checks; verify bundled assets. |

## Architecture decision record

### Decision

Use one normalized vector Effect Mask and a target-resolution final compositor above `Engine.render()`.

### Drivers

- One consistent feature across every renderer.
- Resolution-independent brush alignment and export.
- Bounded undo memory.
- Raw photographic quality alongside crisp dither.
- Preservation of the recent live-video performance work.

### Alternatives rejected

- Canonical full-resolution raster mask: memory and resolution coupling.
- Per-renderer mask logic: duplication and inconsistent semantics.
- Dither-shader-only mask: incomplete mode/FX coverage.
- Per-effect masks: unnecessary without a layer stack.
- Tracking-first implementation: separate product and technical scope.

### Consequences

- Preview and export orchestration need a meaningful but contained refactor before brush UI.
- Exporters must expose target sizing rather than treating the processed canvas as the complete final frame.
- Masked previews may use a larger final canvas than the effect work grid so untouched regions remain visually untouched.
- Video v1 is deliberately static in frame space.
- A GPU final compositor is an optional performance backend, not the source of truth.

### Follow-ups

- Validate the Canvas 2D video compositor against the 10% cadence gate.
- After v1, evaluate mask keyframes, segmentation-generated masks, and object tracking as independent proposals using the same mask-provider interface.
