# Ditherlab Effect Mask — Consolidated Implementation Specification

**Status:** implemented and verified against the acceptance paths in this document

**Prepared:** 2026-07-12

**Target:** the current working tree at `/Users/aischool/work/dither_tool`

**Reconciles:** `docs/BRUSH-MASK-SPEC.md` and `.omx/plans/ditherlab-effect-mask-spec.md`

This document is the implementation contract for Ditherlab's first Effect Mask release. It retains the strongest product and hardening work from the Brush Mask proposal and the stronger frame, alpha, and export architecture from the Effect Mask proposal. Where the earlier documents conflict, the decisions below supersede them.

---

## 1. Executive decision

Build one source-space **Effect Mask** above `Engine.render()`.

- The editable source of truth is an immutable sequence of normalized vector strokes.
- Size-specific raster masks are disposable caches, never canonical state.
- Every renderer continues to process the complete frame.
- Raw and processed branches are scaled separately to a shared final target.
- Post FX belongs to the processed branch.
- The two branches are combined with an exact premultiplied-alpha mask operation.
- Preview and export use the same finalization contract.
- Live CPU-video results are shown only with the raw snapshot from the same accepted frame.
- Uniform full-effect coverage stays on the untouched legacy path with zero mask work; deterministic preview/PNG/GIF outputs remain byte-identical, while MP4 preserves the exact pre-encoder pixels, dimensions, configuration, and timestamps.

The feature is called **Effect Mask**, while **Brush** is the tool that edits it. It applies consistently to Dither, ASCII, Dots, LEGO, Voxel, LED, Lattice, and Mosaic.

### Non-negotiable correctness rules

1. Never mutate a canvas returned by `Engine`, `CpuPreview`, `AsciiRenderer`, a cell renderer, or `applyPostFX()`.
2. Never composite the raw source against a processed canvas from a different source frame.
3. Never apply one whole-canvas sampling rule to a mixed photographic/dither frame.
4. Never use normal `source-over` between two partially masked branches.
5. Never apply Post FX to the raw branch or after final composition; apply it only to the processed branch before blending.
6. Never bake vector history into a fixed-resolution raster while claiming resolution-independent replay.
7. Never let mask-only work train the renderer supersampling governor.
8. Never silently exceed the aggregate canvas-memory budget.

---

## 2. Product model

### 2.1 Selection and effect coverage

The brush edits a painted selection `s` in `[0,1]`. Placement converts that selection into effect coverage `m`:

```text
Painted shows Original / effect outside:  m = 1 - s
Painted shows Effect / effect inside:     m = s
```

The final premultiplied pixel is:

```text
premulRGB(final) = m * premulRGB(processed) + (1 - m) * premulRGB(raw)
alpha(final)     = m * alpha(processed)     + (1 - m) * alpha(raw)
```

Meanings are exact:

- `m = 1`: complete processed look.
- `m = 0`: untouched raw source.
- `0 < m < 1`: feathered crossfade.

### 2.2 Default and empty states

The default is **Painted shows: Original** with an empty selection:

```text
s = 0, placement = outside, m = 1
```

This is the sole structural no-op state and preserves today's output exactly.

Empty selection semantics do not change merely because the selection is empty:

- Empty + Painted shows Original = effect everywhere; bypass is legal.
- Empty + Painted shows Effect = original everywhere; finalization is required.
- Clear Paint empties `s` but retains the Painted shows setting.
- Effect Everywhere empties `s` and sets placement to outside.
- Original Everywhere empties `s` and sets placement to inside.

There is no special “empty mask always bypasses” exception.

### 2.3 What is masked

The mask gates the complete processed look:

```text
raw source
  -> adjustments
  -> animation
  -> selected renderer
  -> target-specific scaling
  -> Post FX
  -> processed branch
```

The raw branch is the untouched source frame, smoothly sampled at the same final target. Protected regions therefore contain no brightness, contrast, hue, blur, renderer, temporal, animation, grain, scanline, glow, chromatic, or vignette changes.

Concrete example: if Film Grain and Vignette are enabled, an area whose painted selection shows Original has neither grain nor vignette—it looks exactly like Compare. This is the v1 recommendation because “Original” remains literal and predictable. A later Mask Scope option could keep global mood FX while masking only the renderer, but v1 does not add that ambiguity.

### 2.4 Video behavior

The v1 mask is static in frame coordinates and applies to every frame. It does not track subjects and has no keyframes.

- Seeking and playback do not move the mask.
- The UI states `Static mask · applies to every frame` for video, webcam, and animated media.
- Painting may continue during playback after a valid paired frame bundle exists.
- The first transition from the unmasked bypass into an active mask temporarily holds a playing video, creates one correct paired bundle, and resumes automatically if playback was running and the user did not change transport state during priming.
- Placement changes or Undo/Redo that cross the bypass boundary use the same priming rule.

---

## 3. Existing system constraints

The implementation targets the live working tree, not the older public source snapshot.

### 3.1 Render topology

`Engine.render()` routes among ASCII, cell effects, GPU dither, and CPU dither (`js/engine/engine.js:198-297`). Output dimensions vary by renderer, live budget, pixel or cell size, smoothness, governor state, and export budget.

Consequences:

- The canonical mask cannot live in preview pixels.
- The mask cannot live in only the dither shader.
- A final compositor above `Engine` is the only universal boundary.

### 3.2 Mutable canvas ownership

The current pipeline reuses mutable canvases:

- `Engine.work` and `Engine.glCanvas` are shared (`js/engine/engine.js:47-65`).
- `CpuPreview.committed` is updated in place when a worker result lands (`js/engine/cpu-preview.js:67-84`).
- ASCII and cell renderers reuse their canvases.
- `applyPostFX()` returns a module-level shared canvas when FX are active (`js/effects/postfx.js:249-315`).

A frame bundle must therefore own copies of any pixels it intends to reuse. Holding a reference to an engine or Post-FX canvas is not a snapshot.

### 3.3 Async CPU video

While CPU diffusion is busy, `Engine.render()` can return an older committed result and mark newer content pending (`js/engine/engine.js:220-235`, `js/engine/cpu-preview.js:107-125`). Drawing the current `source.el` beside that result would mix timestamps at the mask boundary.

The implementation must pair raw and processed pixels by accepted job ID, not by the time `present()` happens to run.

### 3.4 Presentation and sampling

Current crisp dither adds `image-rendering: pixelated` to the complete output canvas (`js/main.js:286-291`, `css/style.css:159-169`). That class cannot remain on a mixed canvas because it would pixelate the photographic branch.

### 3.5 Export topology

Exports are not centralized:

- Preview and realtime recording capture `out` through `renderOnce()` and `present()`.
- PNG calls `engine.render()` directly (`js/main.js:788-855`).
- H.264 chooses dimensions and scales the processed canvas inside the encoder (`js/export/exporters.js:86-183`).
- GIF performs exact point or box decimation, then invokes `postProcess` (`js/export/exporters.js:573-656`).
- TXT, ANSI, HTML, and Copy Text consume ASCII metadata rather than final pixels (`js/main.js:1185-1217`).

Each path needs a thin adapter to one shared final-frame contract.

### 3.6 State and history

Presets and Shuffle reset effect state. Undo currently stores 100 JSON string snapshots with a 350 ms slider debounce (`js/main.js:480-547`). Mask strokes must remain outside `state`, while a stable mask revision identifier participates in those snapshots.

---

## 4. UX specification

### 4.1 Entry and persistent status

Add a **Mask** toolbar button beside Compare and Split. `B` toggles the editing tool.

The button controls editing mode, not whether the mask applies. Closing the tool leaves the composition intact.

Whenever effective coverage is not the full-effect bypass, the toolbar button and status bar show a persistent indicator:

```text
Mask · painted shows Original
Mask · painted shows Effect
Mask · Original everywhere
```

Clicking the indicator reopens the editor. This prevents invisible closed-tool state from appearing as a rendering failure.

### 4.2 Floating brush bar

While editing, show a compact floating bar at the top-center of the viewport:

```text
[Paint | Erase] · Size · Feather · [Painted shows: Original | Effect]
Actions [Clear paint | Effect everywhere | Original everywhere] · Done
```

Recommended v1 values:

- Size: diameter from 0.5% to 40% of the source's shorter side; default 6%.
- Feather: 0% to 100%; default 30%. Higher values paint broad, blurry mask lines for a softer, more organic/interwoven transition.
- No pressure, tilt, or stroke-opacity control in v1.
- Tool configuration is session UI state, not effect state and not an undo entry.

Opacity is deliberately deferred. Applying opacity independently to overlapping interpolation stamps would make a nominal 25% stroke approach full opacity along its centerline. A later Opacity control must apply once to the completed stroke union; a per-stamp control must be labelled Flow.

### 4.3 Overlay and cursor

While editing:

- `#mask-overlay` tints painted selection `s`, regardless of placement.
- The tint explains “this is what you painted”; placement explains what it means.
- Overlay opacity is approximately 35% accent color.
- The overlay lives in `#canvas-stack`, inherits zoom/pan, and always has `pointer-events: none`.
- A DOM ring cursor displays brush diameter and feather core; eraser is dashed.
- The cursor grows on screen when zooming because brush size is source-relative.
- Radius and feather are captured at pointerdown and remain fixed for that stroke.

The overlay and cursor are hidden during export and hold-to-Compare. Opening the tool temporarily hides the Split overlay but preserves its previous enabled state for restoration when the tool closes.

### 4.4 Input and shortcuts

One authoritative tool router owns brush-versus-pan arbitration. Extend `Viewport` with a tool interception hook or equivalent router before its pan handler (`js/view.js:131-156`); do not add competing independent drag state.

Tool-active controls:

- `B`: open/close Mask tool globally.
- `E`: toggle Paint/Eraser.
- Hold `Option`: temporary eraser.
- `X`: switch Painted shows Original / Effect.
- `[` and `]`: decrease/increase size, detected with `KeyboardEvent.code` `BracketLeft` / `BracketRight`.
- `Shift-[` and `Shift-]`: decrease/increase feather using those same physical key codes; do not depend on `e.key` remaining `[` or `]` under Shift.
- `Esc`: roll back an in-progress stroke, then close the editor without removing the committed mask.
- Hold Space and drag: pan; suppress video play/pause and ignore key repeat while held.
- Right-drag: erase; suppress `contextmenu` while the tool is active.
- Pen eraser end maps to Erase.

All shortcuts honor the existing text-field guards and are disabled while exporting. Ignore `e.repeat` for B, E, X, Compare, and Space state transitions; allow repeat only for size/feather adjustment. Clear temporary Option, Space-pan, and Compare states on blur or visibility loss.

Pointer behavior:

- Primary pointer begins one stroke. Lock Paint/Erase operation, size, and feather at pointerdown; modifier or tool changes affect only the next stroke.
- Pointerup commits. Browser/OS pointercancel, blur, or hidden-document transition commits the already-visible partial stroke as one undo action.
- Use `getCoalescedEvents()` when available.
- Ignore samples outside the content rectangle; clip a segment that crosses the boundary.
- Touch v1 supports one-pointer painting. A second touch explicitly rolls back the uncommitted first-touch stroke, enters two-finger pan/pinch using centroid and distance changes, and prevents painting until all gesture pointers lift.
- Hold-to-Compare is ignored while a stroke is in progress; it must never split or implicitly commit a stroke.
- Export/record start force-commits the currently visible partial stroke, then locks all mask mutations until teardown.
- Source replacement discards an in-progress source-bound stroke before switching media.
- Done or B during a stroke commits that visible stroke before closing; Esc is the explicit rollback path.
- Suppress the viewport's existing double-click Fit/1:1 behavior while the Mask editor is active.

### 4.5 Compare and Split

- Compare shows the untouched raw source.
- Split shows raw on the left and the final masked composite on the right.
- Hold Compare while editing temporarily hides tint/cursor, suspends brush input, and shows raw; viewport pointerdown cannot paint until Compare is released.
- Starting Compare during a stroke is ignored until pointerup.
- Split and its `S` shortcut are disabled while the editor is open. The previous Split preference returns when editing closes.
- The mask never appears in preset thumbnails; thumbnails preview looks, not compositions.

### 4.6 Source switching

Source switching keeps the current mask revision, placement, and history. The user can clear it explicitly; loading new media must not silently destroy mask work.

On replacement:

```text
Mask kept · Clear paint or Effect everywhere to remove
```

- discard any uncommitted source-bound stroke before disposing the old source;
- commit any pending debounced settings change, without rewriting the existing mask history;
- increment `sourceEpoch` for frame/cache identity while keeping `maskDocument.revisionId` unchanged;
- clear raw/processed/raster caches and invalidate pending CPU/temporal work;
- map the normalized selection onto the new full frame per axis;
- keep the persistent mask indicator and show the toast above;
- if the mask is active, build a fresh paired bundle for the new source before presenting it—no old-source pixels may survive the transition.

An aspect-ratio change intentionally stretches the normalized mask with the new source, matching the application's existing full-frame mapping. Clear Paint and Effect Everywhere remain immediately available.

Mask state is session-only in v1: it survives source, preset, and mode changes while Ditherlab remains open, but closing/reloading the app clears it. Long-term project persistence or explicit mask files are deferred.

### 4.7 ASCII and cell boundaries

- Dither and graphical cell modes use continuous mask alpha.
- Raster ASCII always uses whole-glyph decisions; it never cuts a character in half.
- Feather remains visually meaningful: average continuous coverage per glyph, then compare it against a fixed source-anchored blue-noise threshold for that glyph. Soft strokes therefore create a stable, organic band of interwoven whole characters instead of a mechanically straight cutoff.
- The threshold field never changes per frame, playback position, mask edit, preview, or export, so the organic edge cannot flicker.
- The engine exposes explicit ASCII grid metadata for the accepted frame. No general cell-grid coupling is added for Dots/LEGO/Voxel/LED/Lattice/Mosaic in v1.
- While editing raster ASCII, show `ASCII edges snap to glyphs · Feather changes which glyphs are selected`.

TXT, ANSI, HTML, and Copy Text remain full-frame ASCII. They cannot embed raw photographic regions, so the UI states:

```text
Effect Mask applies to raster and video output; text output remains full-frame ASCII.
```

Metadata-only text renders skip raw capture, Post FX, mask rasterization, and pixel finalization.

---

## 5. Canonical mask document

### 5.1 Model

```js
{
  version: 1,
  revisionId: 184,              // monotonic, never positional or rebased
  placement: 'outside',         // outside = painted shows Original; inside = painted shows Effect
  strokes: [{
    id: 93,
    operation: 'add',           // add | erase
    radiusShortNorm: 0.03,      // radius as a fraction of the source shorter side
    feather: 0.2,
    points: Float32Array,        // [u0,v0,u1,v1,...]
  }],
}
```

Completed revisions are immutable and structurally share unchanged stroke chunks. A placement change, completed stroke, Clear Paint, Effect Everywhere, Original Everywhere, or Reset creates a new stable `revisionId`.

Placement is revision state, not a destructive rewrite of stroke data. There is no redundant separate invert operation.

### 5.2 Coordinate and brush metric

Points use normalized source coordinates:

```text
u = sourceX / sourceWidth
v = sourceY / sourceHeight
```

Every raster request carries original source dimensions `SW x SH` and normalized crop `{u0,v0,u1,v1}`. For target pixel center `(x+0.5, y+0.5)`:

```text
sampleU   = u0 + ((x + 0.5) / W) * (u1 - u0)
sampleV   = v0 + ((y + 0.5) / H) * (v1 - v0)
radiusSrc = radiusShortNorm * min(SW, SH)
dxSrc     = (sampleU - stampU) * SW
dySrc     = (sampleV - stampV) * SH
d         = hypot(dxSrc, dySrc) / radiusSrc
```

This inverse source-space metric produces a round brush in source pixels on landscapes, portraits, panoramas, and cropped GIF targets. A stretched final target displays the same per-axis source transform as the rest of the application rather than silently changing mask geometry.

Pointer mapping follows the current viewport transform:

```text
x = ((clientX - viewport.left) - view.tx) / view.zoom
y = ((clientY - viewport.top)  - view.ty) / view.zoom
u = x / output.width
v = y / output.height
```

### 5.3 Stroke capture and deterministic rasterization

Capture rules:

- Lock radius and feather at pointerdown.
- Keep coalesced samples in event order.
- Drop capture samples closer than one quarter radius to the last kept sample.
- Run deterministic polyline simplification with tolerance at most `radius / 16`, preserving endpoints.
- During rasterization, interpolate stamp centers no farther apart than one quarter radius.
- Carry residual spacing across source polyline segments so equivalent point segmentation produces equivalent coverage.
- Sample the normative kernel at target-pixel centers.

Let hardness `h = 1 - feather`. For normalized radius `d`:

```text
h == 1: alpha = d <= 1 ? 1 : 0
d <= h: alpha = 1
d >= 1: alpha = 0
else:   alpha = 1 - smoothstep((d - h) / (1 - h))

smoothstep(t) = t*t*(3 - 2*t)
```

The optimized rasterizer may use cached stamp tiles, Canvas gradients, or a future GPU backend, but raster goldens must match the normative alpha within two 8-bit alpha levels.

Selection accumulation uses exact alpha arithmetic:

```text
add:   s' = a + s * (1 - a)
erase: s' = s * (1 - a)
```

### 5.4 Revisions, growth, and pruning

No fixed-resolution raster baseline is permitted.

- History snapshots reference stable revision IDs.
- Undo followed by a new edit truncates the app redo stack, then prunes mask revisions unreachable from retained history or the current document.
- When no retained history entry predates a Clear Paint revision, strokes before that clear are discarded.
- Completed point arrays use compact numeric storage rather than point objects.
- Soft limit: 2,048 live strokes or 131,072 point pairs; show diagnostics and increase simplification only within the documented `radius / 16` error bound.
- Hard limit: 4,096 live strokes or 262,144 point pairs. Stop accepting additional strokes with a clear `Mask complexity limit reached · clear the selection to continue` message. Never silently raster-bake or degrade old strokes.
- Global reachable-vector budget: 16 MiB across unique stroke buffers reachable from the current document and every retained Undo/Redo entry. Count structurally shared buffers once.
- The current document and retained history revisions are explicit revision-graph roots. Pruning cannot remove any of them.
- Before committing an edit that would exceed the global budget: truncate Redo as normal, prune unreachable nodes, then evict oldest history entries from the front while preserving the current entry and updating `history.index`. If the current document alone still cannot fit, reject the new stroke rather than silently corrupting history.
- Stress tests cover add/erase churn and at least 1,000 strokes, not only 100 history entries.

These ceilings are intentionally generous for v1 and make worst-case storage behavior explicit.

### 5.5 Raster caches

`rasterFor()` accepts `{sourceEpoch, sourceWidth, sourceHeight, revisionId, width, height, normalizedCrop, quantizationKind}` and is keyed by all geometry-affecting fields:

```text
(sourceEpoch, sourceWidth, sourceHeight, revisionId,
 width, height, normalizedCrop, quantizationKind)
```

Placement is already part of the immutable revision. `sourceEpoch` prevents a cross-source reuse from retaining a raster whose short-side brush metric was calculated for different intrinsic dimensions.

- Incrementally stamp the active stroke into the live-size raster.
- Fully replay only on Undo/Redo, revision jump, target change, or export-size request.
- Use a byte-budget LRU, not a fixed entry count.
- Preview raster cache budget: at most 64 MiB, subordinate to the aggregate 96 MiB mask-subsystem budget; evict rasters earlier when owned bundles/scratches need the space.
- Export rasters are released after export and may evict preview rasters before allocation.
- Clear Paint releases all obsolete raster surfaces.

---

## 6. Owned frame bundles

### 6.1 Contract

An active mask presents only an app-owned immutable bundle:

```js
{
  token: {
    sourceEpoch,
    frameId,
    effectRevision,
    targetRevision,
    samplingKind,
  },
  sourceWidth,
  sourceHeight,
  normalizedCrop,
  targetWidth,
  targetHeight,
  processedTarget,       // app-owned, target-sized, Post FX already applied
  rawTarget,             // app-owned, target-sized, untouched source
  asciiGridInfo,         // null or { cols, rows, rasterWidth, rasterHeight }
  grainPhase,
}
```

`processedTarget` and `rawTarget` are not references to Engine or Post-FX module canvases. They remain unchanged until the bundle is released.

### 6.2 Building a synchronous bundle

For GPU, ASCII, cells, synchronous CPU, stills, generated frames, and synchronous exports:

1. Assign `{sourceEpoch, frameId, effectRevision}` before ingest.
2. Render the processed branch without yielding; the browser cannot advance a decoded video frame in the middle of that JavaScript task.
3. Read the result dimensions/sampling metadata and derive the target plan, incrementing `targetRevision` only when that plan changes.
4. Before yielding, smoothly capture the raw source into an app-owned target using the same source dimensions/crop and the complete token.
5. Scale the borrowed processed result into an app-owned target using `token.samplingKind`.
6. Apply Post FX at the target using a stable numeric grain phase.
7. Copy any shared Post-FX result into `processedTarget`.
8. Publish raw and processed targets atomically as one bundle; only after successful publication release the previous bundle.

If allocation, scaling, or Post FX fails, release every partial new surface and keep presenting the previous complete bundle. The old bundle, new raw target, borrowed engine result, new processed/Post-FX target, and required scratches all count in peak-memory preflight during the atomic swap.

For masked live video, derive grain phase from accepted `frameId`, rather than advancing Post FX again during each brush move. A mask-only repaint must not change grain on a paused frame.

### 6.3 Async CPU pairing

`CpuPreview` has one accepted job in flight. Before dispatch, Engine can determine the planned work/result dimensions and crisp sampling kind, so it must derive the target plan and complete render token first.

Refactor the Engine/CpuPreview return value so one call may report both independent events:

```js
{
  committedResult: null | { canvas, token, descriptor },
  acceptedJob: null | { token, targetPlan },
}
```

This matches the current scheduler, where a worker-completion wake may expose committed job A and accept pending job B in the same render call.

- The full token is `{sourceEpoch, frameId, effectRevision, targetRevision, samplingKind}`.
- Capture raw B only when `acceptedJob` confirms B was dispatched, using B's preplanned target, and do so before yielding from the ingest task.
- A busy-path boolean pending frame has no token and allocates no raw snapshot; it represents no accepted pixels yet.
- When A commits, copy the mutable `cpu.committed` canvas only if A's complete token still matches current source/effect/target generations, then publish it only with raw A.
- Transfer the complete token through the worker request/response; a late mismatch is discarded even if no newer Engine call has yet updated worker state.
- Keep one displayed owned bundle and one in-flight raw snapshot. The displayed bundle remains immutable while B runs.
- Settings changes, seek discontinuities, source replacement, worker failure, target changes, or sampling-kind changes invalidate the in-flight token/snapshot.
- While a newer job is busy, continue presenting the last complete bundle with the latest mask revision.

This is narrower than a general decoded-frame ring and matches the current single-worker scheduling model.

### 6.4 Bypass-to-active priming

The uniform-full-effect bypass intentionally owns no raw snapshot. Crossing into active coverage enters an explicit asynchronous `maskPriming` state:

1. Buffer the initiating edit and pointer samples; suspend mask presentation and additional tool-state changes.
2. Record whether the source was playing, the current user-only `transportRevision`, and the live render/target budget that applied before the internal hold.
3. Internally hold a pausable video without incrementing `transportRevision`.
4. Show `Preparing mask…` and yield one animation frame so the UI can paint.
5. Invalidate any CPU worker result.
6. Force one bundle with independent options `{allowAsync:false, liveRender:true, budget:preHoldLiveBudget}`; pausing must not silently select the higher-detail paused budget.
7. Apply the buffered mask revision/samples and publish the final composite.
8. Resume only if playback was previously running and `transportRevision` is unchanged; a user play/pause/seek action during priming wins.
9. Leave `maskPriming`, remove the notice, and process subsequently queued pointer events.

This requires refactoring the current positional `renderOnce()` behavior so async permission, live-render semantics, and explicit budget are independent options. Webcam and other non-pausable sources use same-task pairing without transport changes, while still entering the guarded priming state.

Later mask-only changes reuse the complete bundle at pointer rate. When playing, newly accepted source frames replace the bundle normally.

---

## 7. Final-frame contract

### 7.1 API shape

```js
finalizeFrame({
  frameBundle,
  maskRevision,
  normalizedCrop,
  quantizationKind,
  destination,
}) -> Canvas
```

The bundle is already target-sized and Post-FX-complete. Finalization performs only mask rasterization/lookup and exact branch composition.

The destination is caller-owned. Preview may reuse its app-owned destination on the next presentation, but PNG and any other asynchronous consumer retain an owned final canvas until `toBlob()`/encoding completes. A finalizer must never hand an async consumer a module-level or subsequently reused scratch.

### 7.2 Exact Canvas 2D correctness backend

For effect coverage raster `m`:

1. Copy `processedTarget` to the processed branch scratch.
2. Apply `destination-in` with `m`.
3. Copy `rawTarget` to the raw branch scratch.
4. Apply `destination-out` with `m`, producing `(1-m)` raw coverage.
5. Copy the processed branch to the destination.
6. Draw the raw branch with `globalCompositeOperation = 'lighter'`.
7. Restore all context state.

Canvas stores compositing pixels in premultiplied form, so adding the complementary branches implements the specified equation. Normal `source-over` between the two masked branches is forbidden because it attenuates the lower branch twice and produces translucent feather seams.

The source drawing step always uses `imageSmoothingEnabled = true` and high quality. It must not inherit nearest-neighbor state intended for crisp dither.

### 7.3 ASCII quantization

For `quantizationKind = 'ascii-grid'`, accepted metadata is `{cols, rows, rasterWidth, rasterHeight}` and describes the exact processed raster before target scaling/cropping:

1. Rasterize continuous effect coverage in the accepted ASCII raster coordinate system.
2. Box-average it into effect coverage `c` for each exact glyph bound.
3. Resolve a fixed threshold `T(cx,cy)` from a deterministic blue-noise tile anchored to source/grid coordinates, with `0 < T < 1`; select the complete effect glyph when `c >= T`. Coverage `0` always stays raw and coverage `1` always stays processed.
4. Expand whole-cell decisions back to `rasterWidth x rasterHeight`.
5. Apply the same normalized crop and target transform used for the processed ASCII raster; exporter resampling uses nearest/majority decisions for the binary mask rather than introducing partial glyph alpha.
6. Use that aligned raster for branch composition.

Raster preview and raster exports therefore make identical, stable whole-glyph decisions. Exact millimetric boundary placement is not a goal; visual coherence and a pleasing organic transition are.

### 7.4 Uniform coverage

- Uniform effect coverage `1`: bypass `finalizeFrame()` and all raw/mask allocation; preserve the untouched legacy path and the no-op equivalence contract from §1.
- Uniform effect coverage `0`: render/draw the raw target. Do not bypass to the processed path.
- Non-uniform coverage: use the full finalizer.

---

## 8. Preview target and sampling policy

### 8.1 Explicit sampling metadata

Stop inferring all sampling behavior from mode names or a mutable global flag. Each accepted processed frame carries:

```text
samplingKind = crisp      // non-box-resolved dither
samplingKind = continuous // box-resolved dither, ASCII, and graphical cell modes
```

This removes current preview/PNG/MP4/GIF disagreement over non-dither scaling.

### 8.2 Target limits

```text
MAX_MASK_PREVIEW_AREA = 2,250,000 pixels
MAX_MASK_PREVIEW_SIDE = 4,096 pixels
```

The target is independent of pan, zoom, viewport size, and device-pixel ratio. CSS owns those display concerns.

### 8.3 Crisp target algorithm

For a crisp processed canvas `pw x ph`, choose a whole-number enlargement:

```text
kArea   = floor(sqrt(MAX_MASK_PREVIEW_AREA / (pw * ph)))
kSide   = floor(min(MAX_MASK_PREVIEW_SIDE / pw, MAX_MASK_PREVIEW_SIDE / ph))
kNative = floor(min(sourceWidth / pw, sourceHeight / ph))
k        = max(1, min(kArea, kSide, max(1, kNative)))

targetWidth  = pw * k
targetHeight = ph * k
```

Plan the upstream crisp grid before rendering. Given requested grid `rw x rh`:

```text
gridScale = min(
  1,
  sqrt(MAX_MASK_PREVIEW_AREA / (rw * rh)),
  MAX_MASK_PREVIEW_SIDE / rw,
  MAX_MASK_PREVIEW_SIDE / rh
)

plannedWidth  = max(1, floor(rw * gridScale))
plannedHeight = max(1, floor(rh * gridScale))
```

Pass both `maxOutputPixels` and `maxOutputSide` through the Engine render plan; an area-only `maxPixels` option is insufficient for extreme panoramas. Validate the actual result. If a renderer or WebGL/CPU fallback still exceeds either bound, recompute once using the measured excess ratio and rerender. If the second result still violates the plan, fail that presentation with diagnostics and retain the previous complete bundle; do not fractionally shrink a crisp frame inside the compositor.

This avoids uneven 4/5-pixel cells and moiré from fractional nearest-neighbor enlargement. Tiny source/result aspect differences caused by grid rounding are accepted; the app already maps full-frame content per axis.

### 8.4 Continuous target algorithm

For source `sw x sh` and processed result `pw x ph`:

```text
capScale  = min(
  sqrt(MAX_MASK_PREVIEW_AREA / (sw * sh)),
  MAX_MASK_PREVIEW_SIDE / sw,
  MAX_MASK_PREVIEW_SIDE / sh
)
baseScale = min(1, capScale)
needScale = max(pw / sw, ph / sh)
scale     = min(max(baseScale, needScale), capScale)

targetWidth  = max(1, round(sw * scale))
targetHeight = max(1, round(sh * scale))
```

If the processed result itself exceeds the hard cap, smoothly reduce it to the capped source-aspect target and record the fallback in diagnostics.

### 8.5 Invalidation and presentation

Re-evaluate the target on:

- source replacement or intrinsic-dimension change;
- transition into/out of any non-bypass mask state;
- renderer or mode change;
- pixel size, smoothness, ASCII font/renderer/cell size, graphical cell size, governor, pause/play budget, or WebGL fallback changing processed dimensions;
- an accepted result no longer fitting the current target.

Do not resize on pan, zoom, DPR, overlay, cursor, or mask-only edits. Call `Viewport.contentResized()` once when the target actually changes. Remove the whole-canvas `pixelated` class while the mask is active; nearest sampling has already occurred inside the processed branch.

Before `captureStream()`/MediaRecorder begins, freeze the complete `TargetPlan`: output dimensions, upstream live budget, `ssCap`/governor level, sampling kind, and crisp integer scale. Mask/settings edits remain locked for the recording. If WebGL loss or another fallback cannot produce a frame compatible with that plan, abort recording cleanly and retain the editor state; never resize the captured canvas or fractionally resample a newly crisp frame. Release the lock after stop/cancel/failure.

---

## 9. History, presets, reset, and lifecycle

### 9.1 Lightweight history integration

Keep the existing JSON string history representation. Extend snapshots conceptually to:

```js
JSON.stringify({
  s: state,
  g: source?.type === 'gen'
    ? { sourceEpoch, params: source.gen.params }
    : null,
  m: maskDocument.revisionId,
})
```

`restoreSnapshot()` resolves the stable mask revision ID regardless of the current source epoch and updates the mask before repainting. It restores `g.params` only when `g.sourceEpoch` matches the current generated source.

- Flush any pending 350 ms settings debounce before beginning a discrete mask edit.
- One completed stroke, placement change, Clear Paint, Effect Everywhere, Original Everywhere, or Reset is one immediate history entry.
- Mask-only revisions do not serialize stroke arrays into every settings snapshot.
- New edit after Undo truncates app redo and then prunes unreachable mask revisions.

### 9.2 Presets and Shuffle

Presets and Shuffle retain the current mask. A mask is a composition/selection; a preset is a look. Keeping mask data outside `state` prevents `resetState(state)` from deleting it.

### 9.3 Reset All

Reset All restores effect defaults and creates an empty/outside mask revision in the same history bracket. One Undo restores both settings and mask. Toast: `Reset · mask cleared`.

### 9.4 Source and cache lifecycle

Source replacement follows §4.6:

- keep the mask document and its stable revision history unchanged;
- increment only the frame/cache `sourceEpoch`;
- invalidate worker and temporal history;
- clear owned frame bundles, raw snapshots, target-dependent rasters, and GPU resources;
- build a new-source paired bundle before presenting an active mask.

Mask history is intentionally source-independent. Undoing an older mask action after a source switch applies that normalized revision to the current source. Generative scene parameters remain source-bound: snapshots carry their own source epoch and `restoreSnapshot()` ignores `g` when its epoch does not match the current generated source.

Clear Paint and Effect Everywhere release obsolete mask rasters. Export teardown releases export-only frames and restores the live target.

---

## 10. Export integration

### 10.1 Shared ordering

Every raster/video export follows:

```text
render processed frame without mask finalization
  -> choose export target
  -> scale processed branch with explicit sampling kind
  -> apply Post FX at export target
  -> smoothly capture matching raw source at export target/crop
  -> rasterize effect coverage at target/crop
  -> exact premultiplied branch composite
  -> encode/save final target exactly once
```

No adapter may composite a raw branch over a canvas that already contains a previous mask composite.

### 10.2 PNG

- Choose final PNG dimensions first.
- Before `Engine.render()`, derive a target-constrained Engine plan. A crisp work/result grid may not exceed the final target dimensions; continuous/ASCII/cell work is capped to the resolution needed for that target. Pass target-derived `maxOutputPixels` and `maxOutputSide` so the current 64 MP engine/work/ImageData path cannot allocate before the 12 MP masked-output cap takes effect.
- Include predicted Engine work/result/ImageData and CPU diffusion buffers in the export preflight. If the complete peak exceeds the working-byte ceiling, lower the final target, recompute the upstream plan, and only then render synchronously.
- Build an export bundle at those dimensions.
- Finalize once into an owned canvas retained until asynchronous `toBlob()` completes, then encode.
- Preserve `work`, `source`, and `source2x` semantics where within masked-export memory limits.
- Original regions use true target-resolution source pixels.
- Preserve the existing dimension round-trip and null-blob failure checks; release every transient surface in `finally`.

### 10.3 GIF

Keep GIF's exact integer-divisor sizing and point/box decimation. Extend its post-decimation hook with:

```js
{
  targetWidth,
  targetHeight,
  normalizedCrop: {
    u0: 0,
    v0: 0,
    u1: (targetWidth * divisor) / first.width,
    v1: (targetHeight * divisor) / first.height,
  }
}
```

Create the post-decimation hook whenever `maskActive || fxOn`; the current `fxOn`-only condition is insufficient. Its `renderFrame` input must be processed-only with neither mask nor Post FX, so neither operation can occur twice.

After the processed branch reaches GIF dimensions:

- apply Post FX there;
- sample the matching raw frame using the exact crop;
- rasterize the mask using the same crop;
- composite before palette analysis/encoding.

For whole-glyph ASCII, carry `{cols, rows, rasterWidth, rasterHeight}` from the accepted processed frame. Resolve deterministic blue-noise glyph decisions in that pre-decimation raster coordinate system, apply GIF's identical top-left crop, and map the binary mask to the target with nearest/majority decisions. Do not stretch a fresh `cols x rows` grid across the already-cropped target or create partial glyph alpha.

Any photographic region will usually leave the exact `<=256` color-bucket path and may increase size or feather banding. Surface this through the existing `onInfo` channel.

### 10.4 Frame-accurate MP4

Refactor H.264 masked export into a two-stage API:

1. Render the first unmasked processed frame.
2. Determine `samplingKind` and encoder dimensions.
3. Create the encoder.
4. Build and finalize every frame at the encoder dimensions.
5. `encoder.addFinal(canvas)` asserts exact dimensions and encodes 1:1 with no further drawing or scaling.

Post FX occurs inside the export finalizer before masking. This prevents the earlier failure mode where a raw branch is added inside `encoder.add()` after `present()` has already applied Post FX.

### 10.5 Realtime MediaRecorder

MediaRecorder captures the finalized visible canvas. Lock its dimensions before `captureStream()` starts. Mask edits remain blocked while exporting/recording unless the current recorder already permits live editor interaction as an explicit future feature.

### 10.6 Text exports

TXT, ANSI, HTML, and Copy Text remain full-frame and display the raster-only mask notice from §4.7. Capture-metadata renders do not build frame bundles or invoke the pixel finalizer.

### 10.7 Preset thumbnails

Preset thumbnails remain unmasked and continue using `thumbEngine`. Their cover crop is unrelated to composition mask geometry.

---

## 11. Performance and memory budgets

### 11.1 No-op path

Uniform full-effect coverage adds only one branch check. It must not:

- allocate a raw canvas;
- rasterize a mask;
- resize `out`;
- copy an engine result;
- change sampling, Post FX, grain, governor timing, deterministic-format bytes, or the MP4 pre-encoder contract.

### 11.2 Mask-only editing

- Incrementally stamp only the new stroke segment into the live mask raster.
- Re-finalize the latest owned bundle without running Engine or Post FX.
- Do not dispatch a CPU worker job.
- Do not update renderer or cadence governor EMAs.
- Painting on a paused 4K still or committed CPU frame must remain at pointer cadence.

### 11.3 Live video

Track separate timings:

```text
effectRenderMs
bundleBuildMs
maskCompositeMs
```

The existing supersampling governor observes only effect-render cost on new content. Mask-only edits never train it. A compositor-dominated cadence failure must not trigger an `ss -> 1` change that enlarges the processed grid and makes composition more expensive.

Performance gate:

- Benchmark unmasked and masked 1080p Blue Noise on the target browser and WKWebView build.
- Target no more than 10% cadence loss with a static unchanged mask.
- Treat the result as a measured release gate, not a guaranteed outcome.

Fallback order if the gate fails:

1. Verify no unnecessary rerasterization, source copy, Post-FX rerun, or cross-canvas allocation.
2. Lower only the masked preview target while preserving whole-number crisp enlargement; do not degrade renderer supersampling through the wrong governor.
3. Prototype a GPU final compositor and benchmark actual upload/readback costs.
4. If GPU integration is required for the GPU-video path, prefer an Engine-owned final pass/FBO; separate WebGL contexts cannot share textures and may require expensive uploads.
5. Preserve Canvas 2D as the correctness and WebGL-loss fallback.

Do not use a low-work-grid `mix()` inside `DITHER_FS` as an equivalent fidelity fallback. It recreates the blocky-original defect and covers only GPU dither.

### 11.4 Aggregate memory

Canvas limits must consider all simultaneous surfaces, not only the final canvas.

```text
MAX_MASK_SUBSYSTEM_PREVIEW_BYTES = 96 MiB
MAX_MASKED_EXPORT_AREA           = 12,000,000 pixels
MAX_MASKED_EXPORT_SIDE           = 8,192 pixels
MAX_MASKED_EXPORT_WORKING_BYTES  = 512 MiB
```

- Count owned raw/processed bundles, mask rasters, compositor scratches, overlay, and Post-FX surfaces.
- Before allocating or atomically replacing a preview bundle, run `estimatePreviewPeakBytes(targetPlan, currentBundle, inFlightRaw, fxState)`. Count the old displayed pair until successful publication, the prospective pair, in-flight raw, borrowed worker result while copying, mask, branch scratches, overlay/output, and persistent Post-FX canvases.
- Evict disposable raster caches first. If required non-evictable surfaces still exceed 96 MiB, lower a continuous target scale or decrement crisp integer `k` and re-estimate. If crisp `k = 1` still cannot fit, reduce the upstream crisp render plan and retry once. On failure, keep the previous complete bundle and reject/roll back the activating edit with a clear memory message.
- Reuse compositor scratches by dimension and purpose.
- Keep only committed plus one in-flight raw pair for CPU video.
- Do not retain export rasters in the preview LRU.
- The 512 MiB export ceiling includes encoder retention, not merely canvases. MP4 planning reserves the current 256 MiB muxed-sample ceiling before allocating frame surfaces. GIF planning reserves retained pixel indices up to its configured budget plus the worst-case `Float32Array(targetPixels * 3)` diffusion scratch and palette/working arrays. PNG reserves its asynchronous encoding surface. Target dimensions use only the remaining working set.
- Before a masked export, estimate every simultaneously live surface—including Engine output, CPU buffers, Post-FX buffers, mask, raw, processed/final, encoder staging/retention, and `ImageData`—and cap dimensions by both area and working bytes with an explanatory toast.
- After allocating each canvas, verify a non-null context and that the width/height round-trip matches the request; abort cleanly on the WKWebView-style silent `0 x 0` failure.
- Release transient export canvases in `finally`, including cancel and encoder-failure paths.
- A future tiled exporter may raise the cap, but tiling must account for Post-FX kernels and crop registration.

---

## 12. Proposed modules and integration points

### 12.1 Modules

- `js/mask/model.js` — immutable revisions, stable IDs, placement, pruning, complexity limits.
- `js/mask/rasterizer.js` — deterministic strokes, incremental live raster, ASCII quantization, byte-budget LRU.
- `js/mask/compositor.js` — exact Canvas 2D branch composition and scratch ownership.
- `js/mask/tools.js` — input routing, pointer-to-UV conversion, overlay, cursor, floating controls.
- `js/frame-bundle.js` — owned target snapshots, accepted frame IDs, async CPU pairing, target selection.
- Optional later `js/mask/compositor-gl.js` or Engine-owned GL final pass, only after profiling.

No new package dependency is required.

### 12.2 Main integration points

| Area | Change |
| --- | --- |
| `renderOnce()` / `present()` | Separate effect dirty, bundle dirty, mask dirty, and overlay dirty paths; preserve exact bypass. |
| `Engine.render()` result | Return structured `committedResult` and optional `acceptedJob`, each with full source/frame/effect/target token plus sampling/dimension/ASCII metadata. |
| `CpuPreview` | Transfer/compare complete render tokens and expose commit/accept events separately so raw snapshots are captured only for accepted work. |
| `Viewport` | Add one tool interception/router hook before pan capture. |
| History | Add stable mask revision ID to existing JSON snapshots; flush debounce before discrete mask edits. |
| `setSource()` | Keep the mask/history, increment frame epoch, clear every source-dependent cache, and build a fresh pair before presenting an active mask. |
| PNG | Choose target first, build export bundle, finalize once. |
| GIF | Extend post-decimation adapter with crop geometry and finalize before palette encoding. |
| H.264 | Split target planning from 1:1 final-canvas encoding. |
| Text capture | Show notice and skip pixel finalization. |
| DOM/CSS | Add Mask button, overlay, cursor, floating bar, persistent status indicator. |

---

## 13. Implementation plan

### Phase 0 — Baseline preservation

- Preserve the current dirty video/export work in an explicit branch/commit or equivalent recoverable snapshot before feature edits.
- Do not mix the existing approximately 1.5k-line performance/export changes into Effect Mask commits.
- Rerun the existing 39-test suite, syntax checks, browser smoke tests, and native typecheck.
- Capture unmasked golden frames for GPU dither, CPU dither, ASCII, one cell mode, PNG, GIF, and MP4.

**Exit gate:** baseline is recoverable, tests are green, and the tested source revision is recorded.

### Phase 1 — Pure model, rasterizer, and compositor

- Implement stable immutable revisions and existing-history references.
- Implement deterministic capture simplification, residual stamp spacing, add/erase arithmetic, placement, and complexity limits.
- Implement byte-budget raster caches and stable blue-noise whole-glyph ASCII quantization.
- Implement exact two-branch premultiplied Canvas 2D composition.
- Add alpha, raster, revision, and cache unit tests before UI work.

**Exit gate:** opaque and translucent alpha goldens pass; empty-inside/outside states are correct; no raster baseline exists.

### Phase 2 — Owned bundles and still-image UX

- Add explicit sampling metadata and target algorithms.
- Add app-owned processed/raw bundles and stable grain phase.
- Split effect/bundle/mask invalidation.
- Add viewport tool routing, Mask toolbar button, floating bar, overlay, cursor, shortcuts, and status indicator.
- Integrate immediate mask history commits and debounce arbitration.
- Integrate all still-image modes, Compare/Split, presets, automatic cross-source mask retention, Reset, and PNG.

**Exit gate:** still preview and PNG pass every acceptance criterion; mask-only painting never reruns Engine/Post FX.

### Phase 3 — Raster export completion

- Add GIF crop-aware finalization after decimation.
- Add the two-stage MP4 target/final-canvas API.
- Verify generated, animated-image, video, and MediaRecorder paths.
- Add full-frame text-export notices and metadata-only bypass.

**Exit gate:** selected preview/PNG/GIF/MP4 pixels agree within format tolerances and no frame is finalized twice.

### Phase 4 — Async video and native hardening

- Carry accepted frame IDs through `CpuPreview`.
- Implement committed/in-flight raw pairing and bypass priming.
- Support buffered first-edit priming and live painting with automatic playback restoration.
- Split performance diagnostics and enforce memory counters.
- Profile 1080p Canvas 2D composition in Chromium and WKWebView.
- Evaluate GPU final composition only if the measured gate fails.
- Exercise seek, speed change, worker delay/failure, WebGL loss, webcam, and native export interception.

**Exit gate:** no temporal tearing, no per-frame mask rerasterization, performance/memory gates pass or an explicit scoped fallback is approved.

### Phase 5 — Release verification

- Run syntax, unit, integration, browser, and native suites.
- Inspect hard/soft edges, transparent PNGs, every renderer family, portrait/panorama geometry, and masked video motion.
- Build the versioned app/DMG only after source verification.
- Confirm the artifact contains the tested source tree.

**Exit gate:** acceptance table is green, no known correctness errors remain, and deferred features are documented.

---

## 14. Acceptance criteria

| Area | Required result |
| --- | --- |
| No-op compatibility | Empty/outside coverage uses the untouched legacy path, allocates no mask resources, preserves preview/PNG/GIF deterministic output, and preserves exact MP4 pre-encoder pixels/dimensions/config/timestamps. |
| Fill semantics | Empty/outside is full effect; empty/inside is full raw; placement is the exact complement without rewriting strokes. |
| Alpha | Opaque and translucent inputs at multiple coverage values match the premultiplied equations without dark/light/transparent seams. |
| Raw fidelity | Raw regions are smoothly sampled at the final target, never reconstructed from the renderer work grid. |
| Sampling | Crisp dither receives whole-number nearest enlargement in masked preview; continuous modes and raw photography use smooth sampling. |
| Coordinates | Strokes stay aligned within one target pixel after pan, zoom, fit, 1:1, mode/budget changes, automatic source switching, and export. |
| Brush continuity | Fast strokes have no gaps larger than one target pixel and do not change when event segmentation differs. |
| Feather | Golden sample points match the normative kernel within two alpha bytes. |
| History | Each discrete mask action is one undo step; slider debounce cannot merge into it; stable IDs survive history pruning. |
| Complexity | Limits are enforced explicitly; no raster baking or silent loss occurs. |
| Presets | Presets and Shuffle keep the mask; Reset clears it in the same undo bracket. |
| Source | Replacement keeps the normalized mask and history, clears every source-dependent frame/raster cache, stretches per axis when needed, and cannot show pixels from the old source. |
| ASCII raster | Glyphs are wholly raw or processed; feathered edges form a stable source-anchored organic transition, never flicker, and preview/raster exports agree. |
| Text export | Text remains full-frame, displays the notice, and performs no pixel finalization. |
| Frame pairing | A delayed CPU result is shown only with its matching raw frame and the latest mask revision. |
| Priming | Crossing from bypass temporarily holds pausable video, invalidates stale work, commits one correct pair before composition, and restores prior playback unless the user changed transport state. |
| Live painting | After priming, mask edits during playback stay responsive and never mix raw/processed timestamps. |
| Post FX | FX appear only in processed coverage and remain stable during mask-only edits. |
| PNG | Target-resolution raw regions, correct sampling, alpha, and masked memory cap. |
| GIF | Exact divisor crop registration, finalization after decimation, and mask before palette encoding. |
| MP4 | Target chosen once, every frame finalized exactly once, encoder receives exact-size final canvases. |
| MediaRecorder | Captured dimensions remain fixed and output contains mask but no overlay/cursor. |
| Compare/Split | Compare is pure raw; Split is raw versus final masked composite. |
| Cache | Static masks are not rerasterized per video frame; stale epoch/revision/target/crop entries cannot be reused. |
| Governor | Mask-only work never trains renderer EMAs; compositor overload cannot trigger the wrong supersampling response. |
| Performance | Static masked 1080p Blue Noise targets no more than 10% cadence loss on the release browser and WKWebView device. |
| Memory | Preview peak-preflights atomic swaps within 96 MiB; masked exports include Engine/Post-FX/encoder retention within 512 MiB and cap before unsafe allocation. |
| Native app | Browser and bundled WKWebView pass image, video, webcam, undo, PNG, GIF, and MP4 smoke scenarios. |

---

## 15. Test plan

### Unit tests

- Add/erase alpha arithmetic and inside/outside complement.
- Uniform full-effect versus uniform raw states.
- Opaque/translucent premultiplied branch composition.
- Aspect-aware round-brush metric on landscape, portrait, and panorama targets.
- Capture simplification, residual interpolation spacing, and segmentation invariance.
- Hardness/feather golden alpha samples.
- Replay determinism across target sizes and crops, including crop-aware roundness/alignment.
- Stable revision IDs, interleaved settings/mask Undo/Redo, debounce flush, history cap, cross-source mask continuity, and source-epoch-gated generative snapshots.
- Complexity ceiling and pre-clear pruning.
- Global reachable-vector budget including current/history/Redo roots, plus byte-LRU invalidation and source/frame cache keys.
- Crisp integer target and continuous target algorithms, including caps and rounding.
- Deterministic ASCII blue-noise thresholds, whole-glyph 0/1 guarantees, crop mapping, and preview/export stability.
- Export crop and target calculations.

### Integration tests

- GPU Blue Noise, CPU Floyd-Steinberg, ramp ASCII, structural ASCII, and representative graphical cell modes.
- Raw detail beside a coarse renderer grid.
- Post FX confined to processed coverage and stable under mask-only repaint.
- A deliberately delayed CPU worker timeline where committed A and accepted B occur together; verify complete tokens and exact raw/result pairing through settings, target, seek, and source invalidation.
- Mutate every shared Engine, ASCII/cell, CPU committed, and Post-FX canvas after bundle publication; the owned bundle checksum must remain unchanged. Allocation/Post-FX failure during atomic swap must retain the old bundle and release partial surfaces.
- First-stroke priming from bypass and live painting after automatic playback restoration.
- Source replacement with the mask retained, old generative parameters ignored, Undo still coherent, and zero stale pixels/caches.
- Transparent PNG feather edge.
- PNG at work/source/source2x within cap, including target-derived upstream Engine allocation and owned-canvas lifetime through `toBlob()`.
- GIF point/box paths with non-divisible right/bottom crop, ASCII grid alignment, FX-off masked hook activation, and exactly-once mask/FX.
- MP4 crisp/continuous targets and a double-finalization guard.
- Uniform-full-effect parity with FX off and grain/chromatic/glow on: exact preview/PNG/GIF deterministic outputs, zero mask counters, and exact MP4 pre-encoder pixels/dimensions/config/timestamps.
- Metadata-only TXT/ANSI/HTML/Copy Text.

### Browser/native tests

- Still -> paint -> erase -> feather -> placement -> Undo/Redo -> PNG.
- Video -> first stroke temporarily holds/primes -> automatic resume -> paint live -> seek -> GIF -> MP4.
- Switch Dither -> ASCII -> LEGO while preserving alignment.
- Replace source -> retained mask on new media -> verify toast, per-axis mapping, and no stale frame/cache -> Clear Paint.
- Generated scene and animated-image loop export.
- Webcam static mask and real-time recording.
- Lose/restore WebGL and confirm Canvas 2D fallback.
- Context menu, key repeat, blur/pointercancel, export locking, and oversized-export messaging in WKWebView.

### Performance/memory tests

- Unmasked/masked 1080p cadence and dropped-frame ratio.
- CPU worker committed/in-flight bundle count under delayed completion.
- Mask rasterization count over 300 unchanged video frames.
- Pointer latency on paused 4K CPU dither and ASCII.
- Separate effect/bundle/composite timing counters.
- 1,000-stroke add/erase stress and replay at multiple target sizes.
- Preview byte budget and masked-export preflight at 4K and requested source2x.
- Atomic old/new bundle-swap peak, all-FX 12 MP request, extreme panorama side cap, GIF wide-color retained buffers, MP4 near its retained-sample ceiling, simulated `0 x 0` allocation, and cancel/failure cleanup.

---

## 16. Rejected alternatives

| Alternative | Reason rejected |
| --- | --- |
| Full-resolution raster as canonical mask | Resolution-coupled, large history, poor export resizing and recovery. |
| Mask inside every renderer | Duplicates behavior across GPU, CPU, ASCII, and cell paths. |
| Mask only in `DITHER_FS` | Misses CPU/ASCII/cells and reconstructs raw pixels from the low work grid. |
| Destination-out plus source-over | Mathematically wrong for feathered complementary branches. |
| Current `source.el` beside cached processed canvas | Produces temporal tearing on async CPU video. |
| Fixed-resolution raster baseline compaction | Invalidates exact replay at new resolutions and can break history revision references. |
| Whole-canvas `image-rendering: pixelated` | Pixelates the raw photographic branch. |
| Automatic per-stamp opacity in v1 | Overlapping interpolation stamps make the labelled opacity inaccurate. |
| Automatically clearing masks on source replacement | Destroys deliberate mask work; the user can Clear Paint or choose Effect Everywhere explicitly. |
| Clearing all settings history on source replacement | Unnecessary collateral behavior change. |
| Tracking/segmentation/keyframes in v1 | Separate product and runtime scope; can later provide masks to the same finalizer. |

---

## 17. Deferred work

- Stroke opacity applied once to the completed stroke union.
- Pen pressure and tilt.
- Optional freeform versus grid-snapped ASCII boundary control.
- Mask PNG import/export and project persistence.
- Persistent project files or exported mask libraries beyond the current open session.
- Keyframed, tracked, or segmentation-generated masks.
- Multiple effect layers and parameter-modulation masks.
- GPU final compositor after measured need and ownership design.
- Tiled high-resolution masked export with Post-FX-safe overlap.
- Optional Mask Scope control for “complete processed look” versus “renderer only, keep global mood FX.”

---

## 18. Architecture decision record

### Decision

Use one immutable normalized Effect Mask, app-owned paired frame bundles, and an exact target-resolution final compositor above `Engine.render()`.

### Drivers

- Correct raw detail beside crisp or continuous processed output.
- One behavior across every renderer and export path.
- Exact alpha at feathered transparent edges.
- Correct async CPU-video frame pairing.
- Lightweight, coherent Undo/Redo without bitmap snapshots.
- Zero-cost unmasked behavior with deterministic-output equality and an unchanged MP4 pre-encoder contract.
- Measurable performance and memory bounds in Chromium and WKWebView.

### Consequences

- Preview and export orchestration require a meaningful but contained refactor before brush UI is shippable.
- Engine results need explicit sampling and frame metadata.
- Active masked frames use app-owned target snapshots rather than borrowed engine canvases.
- Masked exports require a lower safe aggregate-memory ceiling than the current single-canvas PNG maximum.
- Live video remains static-mask only, with one internal priming hold before live editing.

### Directive for implementation

Do not optimize around the mask until the exact Canvas 2D backend, paired-frame tests, no-op parity, and export adapters are green. Performance alternatives are acceptable only if they preserve the same frame, alpha, sampling, Post-FX, and target-resolution contracts.
