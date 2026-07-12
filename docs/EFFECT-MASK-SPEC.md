# Effect Mask — Unified Spec (v2)

**Status:** proposed, supersedes both parents · **Date:** 2026-07-12
**Parents:** `docs/BRUSH-MASK-SPEC.md` ("spec 1", Claude Fable) and `.omx/plans/ditherlab-effect-mask-spec.md` ("spec 2", GPT-5.6 Sol), merged after a cross-review pass (Sol's review + Fable's meta-review). Architecture and correctness math follow spec 2; UX, input hardening, undo integration, and delivery pragmatics follow spec 1; six contested points are resolved explicitly (§15). Line anchors below were re-verified against the working tree on 2026-07-12.

**Feature:** a brush paints a normalized-coordinate region over the source; placement decides whether the active effect (dither / ASCII / cell modes) renders inside or outside that region, with the untouched original showing elsewhere. Works live on images, video, webcam, and generated scenes; honored by every raster export path.

---

## 1. Product definition

- **One selection, one placement toggle.** The brush edits a painted *selection*; **placement** (`outside` | `inside`) decides what it means: default `outside` = effect everywhere except painted ink (painting *protects*), `inside` = effect only where painted. The two user phrasings are the same mask with opposite placement — one toggle, not two tools.
- **Default: empty selection + `outside`** → effective coverage is uniform 1 (all effect); opening the app, or arming the tool, is pixel-identical to today.
- **Empty selection + `inside` = original everywhere.** This is a legal, visible state (it is literally what the model says), *not* a bypass — the status chip announces it (§7) so it reads as intentional rather than broken. Bypass is legal **only** when `uniformCoverage() === 1` (§3.3).
- Brush is round with **Size** and **Feather** (0 = hard edge; falloff math in §4.2). **Eraser** subtracts. **Clear** empties the selection. **Invert** flips placement without touching strokes.
- **No Opacity control in v1.** Per-stamp opacity accumulates like Photoshop *Flow* (≈90% coverage from a nominal 25% stroke at r/4 stamp spacing) — misnamed and surprising. Deferred; if added later, either apply once per completed stroke union or name it Flow. Pressure: field reserved in the data model, unused in v1.
- **Video: one static frame-space mask** for the whole clip; subjects moving through the zone is the signature look. **Painting while playing is supported** (§6.4 makes it correct, §10 makes it fast) — starting a stroke does not pause playback. Tracking/keyframes are explicitly future work.
- Webcam (not mirrored — verified) and generated scenes (`gen.canvas` is just another `source.el`) use the identical contract.

## 2. Constraints the design obeys (verified)

1. **Export coverage map.** Live preview, frame-accurate MP4, realtime MediaRecorder, and GIF capture the `out` canvas via `renderOnce()` → `present()` ([main.js:188](../js/main.js), [main.js:239](../js/main.js)). PNG bypasses `present()` (own render/upscale/post-FX, ~[main.js:788–855](../js/main.js)); preset thumbnails use a separate `thumbEngine` cover-crop; TXT/ANSI/HTML read `engine.ascii.lastGrid/lastText` only. The split overlay is screen-only chrome — a mask must not be built like it.
2. **No stable pixel grid.** Processed resolution is recomputed every frame (pixelSize/cellSize × live budgets × governor × per-export budgets; `present()` may add a ≤2× fx upscale). Masks live in **normalized per-axis source coordinates**; the frame is always stretched full-bleed (no crop/letterbox/DPR anywhere).
3. **Pointer→content math:** `((clientX − rect.left) − view.tx) / view.zoom` → `out`-bitmap px ([view.js:34](../js/view.js)); divide by `out.width/height` for (u,v). Viewport pointer-captures every left-drag except the exclusion selector at [view.js:135](../js/view.js).
4. **Engine-owned canvases are shared and mutable** (glCanvas, work, ascii, cellCanvas, `cpu.committed` — the worker commit overwrites `committed` in place, [cpu-preview.js:100–126](../js/engine/cpu-preview.js)); `applyPostFX` may return a shared canvas ([main.js:843](../js/main.js)). **Nothing may retain references to them across tasks** — hence bundle ownership (§6.2).
5. **The async CPU path returns stale frames by design** ([engine.js:228–236](../js/engine/engine.js)): while the worker is busy, `render()` returns the previously committed canvas. Compositing "current raw + stale effect" tears at the boundary — hence frame pairing (§6).
6. **State traps.** Presets and Shuffle call `resetState(state)` ([main.js:1251](../js/main.js), [main.js:1269](../js/main.js), [main.js:1345](../js/main.js), [main.js:1359](../js/main.js)) — mask data must not live in `state`. Undo is a 100-deep stack of `JSON.stringify(state)` snapshots; bitmaps and stroke arrays must not ride it.
7. **Sampling flags leak.** Export contexts set `imageSmoothingEnabled = engine.lastBoxResolved` ([main.js:836](../js/main.js)); crisp preview relies on the `.pixelated` class ([main.js:290](../js/main.js), [style.css:164](../css/style.css)). The raw branch must force smoothing inside save/restore; a mixed canvas must never carry `.pixelated` (§5.3).
8. **GIF** renders noFx frames, decimates, then re-applies post-FX per frame via `postProcess` ([main.js:1129](../js/main.js), [exporters.js:656](../js/export/exporters.js), [exporters.js:701](../js/export/exporters.js)) — composite must slot in before FX at GIF target size with exact crop registration (§9.2).
9. **Alpha is repurposed on the live-video GPU path** (temporal pre-pass writes motion into alpha; DITHER_FS reads `src.a`). Any GPU-side mask pass needs its own R8 texture and must mind the V-flip (`uvOut=(u,1−v)`).

## 3. Architecture

### 3.1 Final-frame composition above the engine

Every renderer processes the **whole frame** exactly as today. A new compositor blends the processed branch with the untouched raw branch at the **final target resolution** of each output path (never at the renderer work grid). This is the only design that covers all four pipeline families (GPU dither, CPU error diffusion sync+worker, 4 ASCII renderers, 6 cell effects) with one mechanism, keeps error-diffusion propagation intact (mask clips the finished result — no boundary seams), and leaves the recent live-video performance work untouched.

Rejected alternatives (both parents converged; do not relitigate): mask inside DITHER_FS only (1 of 4 pipelines, adjusted-sample problem); per-cell gates in renderers (shows paper color, forks six renderers, no feather); split-overlay-style screen canvas (never exported); masking inside error diffusion (breaks propagation + worker signature cache).

### 3.2 The `finalizeFrame` contract

One shared function with per-path adapters (preview, PNG, GIF, MP4):

```js
finalizeFrame({
  bundle,          // { processed, raw, contentEpoch, sourceEpoch, w, h } — bundle-OWNED pixels (§6.2)
  maskDoc,         // op log + rev + placement (§4)
  targetW, targetH,
  normalizedCrop,  // {u0,v0,u1,v1} — identity everywhere except GIF (§9.2)
  processedSampling, // 'nearest' | 'smooth', from engine.lastBoxResolved / mode (verified [engine.js:266])
  postFX, grainPhase, refH,
}) -> canvas
```

Order: scale processed branch (two-step integer-nearest when crisp, §5.2) → scale raw branch (always smooth, smoothing forced inside save/restore) → rasterize coverage at target → **premultiplied two-branch blend (§3.3)** → **`applyPostFX` over the whole composited frame (§3.4)**.

### 3.3 Composite math (the correctness core)

Canonical equation, in **premultiplied RGBA**, with `m` = effect coverage:

```text
premul(final) = m · premul(processed) + (1 − m) · premul(raw)
alpha(final)  = m · alpha(processed)  + (1 − m) · alpha(raw)
```

Canvas2D implementation — **one** selection raster `s` (§4.3), three ops, no inverse raster:

```text
branchB = raw drawn at target          ; gCO 'destination-out' with s   → raw·(1−s)
branchA = processed drawn at target    ; gCO 'destination-in'  with s   → processed·s
final: draw branchB, then gCO 'lighter' draw branchA                    → exact sum
(placement 'outside' swaps which branch gets destination-in vs -out — no re-raster)
```

**Forbidden:** spec 1's punch-out recipe (`destination-out` then `source-over`). It yields `raw·a + processed·(1−a)²` with alpha `a + (1−a)²` — at a feathered 50% edge that is a 25% under-coverage dark/translucent halo. A regression test must assert the exact lerp at a = 0.5 over opaque and translucent inputs (golden values, no halo).

**Bypass contract:** `uniformCoverage() === 1` (empty selection + `outside`) skips *everything* — no raster, no raw capture, no bundle, no allocation; output byte-identical to today on every path. Uniform 0 and everything else run the full finalize path.

### 3.4 Post-FX semantics: screen glass (explicit product decision)

Post-FX (vignette, scanlines, grain) applies **after** the composite, over the whole frame — it is screen-level glass; the mask gates *content*. Rationale: these are screen-simulation effects — confining them to the effect branch leaves a hole in the vignette wherever a protected region sits and stops scanlines at feathered boundaries, which reads as a compositing artifact; glass ordering also keeps the GIF fx-after-decimation path consistent by construction. "Protected" therefore means: **no adjustments, no dither, no temporal smoothing — but the same screen finish as the rest of the frame.** Hold-C Compare still shows the pure original (unchanged from today). Under `finalizeFrame` this is a single ordering decision; the alternative (FX inside the processed branch, Sol's model) is documented in §15 and is a one-line flip.

## 4. Mask document and rasterizer

### 4.1 Op log + rev (source of truth, undo unit)

`ops: [{type:'stroke'|'clear'|'placement', …}]`; a stroke op is `{type:'stroke', e:bool, r:radiusNorm, f:feather, pts:[u,v,…]}` (compact numeric array; capture-decimated: drop points closer than r/4 to the last kept, using `getCoalescedEvents()`; a reserved `p` pressure field may exist, unused in v1).

- `r` is normalized (fraction of source **long side**, displayed as source px), **captured once at stroke start** — wheel-zoom stays live mid-stroke and must not retroactively resize stamps.
- `rev` = number of ops applied. The selection raster at any rev is a **pure function of `ops[0..rev)`** replayed from the last `clear` at-or-before rev. A new op while `rev < ops.length` truncates the tail first (mirrors `history.stack.splice`). Placement is an op, so one integer fully describes mask content — this is what makes snapshot restore exact and stale-raster-after-undo structurally impossible.
- **Growth policy:** below 500 ops, never bake (replay cost only bites on cache miss and is bounded). Above 500, bake ops older than `min(rev referenced anywhere in the history stack)` into a baseline selection raster op at 2048-px long side (kept as a parallel side-array of revs — never parse snapshots to find this). Baked ink upsamples smoothly; the quality note is documented.
- The document lives in **`main.js` module scope** (like `view`/`exportSettings`), never in `state` — the preset/shuffle `resetState` trap (§2.6) cannot fire by construction.

### 4.2 Deterministic stamp math (goldens-portable)

Let `s` be existing selection alpha, `a` one stamp's alpha:

```text
add:   s' = a + s·(1 − a)          erase: s' = s·(1 − a)
effect coverage m = placement == 'inside' ? s : 1 − s
```

For normalized radial distance `d` and feather `f` (hardness `h = 1 − f`): full weight for `d ≤ h`, zero for `d ≥ 1`, `1 − smoothstep((d−h)/(1−h))` between, `smoothstep(t) = t²(3−2t)`; `f = 0` is the hard-step special case. Stamps are interpolated along the path no farther apart than **r/4** (compatible with the r/4 capture decimation — no gaps). These exact equations are the unit-test goldens; hard strokes may be implemented as round-cap polyline fills only where provably pixel-equivalent.

### 4.3 Rasters: disposable, placement-free, LRU

`rasterFor(W, H, crop)` renders the **selection** `s` (not coverage `m`) at exactly W×H, cached keyed `(rev, W, H, crop)`, LRU ≈ 4 (live target, export target, GIF/MP4 target, spare). Placement is applied at composite time by swapping `destination-in`/`destination-out` (§3.3), so **flipping placement never re-rasterizes** — an improvement over both parents (spec 1 keyed polarity into the raster; spec 2 keyed placement into the cache). Live painting stamps **incrementally** into the live-size raster (only the new segment); full replay happens only on undo/clear/rev-jump/size change. Hard edges are exact at every export size (no fixed master bitmap). Mask immutable during export (§9.3) ⇒ every exported frame samples the identical cached raster.

## 5. Mixed preview target (fidelity without moiré)

### 5.1 Stable target policy

While coverage is non-uniform, `out` uses a **stable backing target** independent of zoom/pan/viewport/DPR (those stay in the CSS transform): start from source dimensions → uniformly reduce to the 2.25 MP area cap → uniformly enlarge only if needed so neither dimension of the processed bitmap would be downscaled. Recompute **only** on source change, bypass↔active transitions, or a mode/grid change whose processed bitmap no longer fits — never per frame, never on governor grid changes. Call `Viewport.contentResized()` once per change (it preserves the on-screen rect). Lock dimensions for the duration of any `captureStream()`/MediaRecorder recording.

### 5.2 Two-step crisp scaling (moiré rule — new, in neither parent)

Nearest-neighbor at non-integer ratios (e.g. 480→1932 px = 4.025×) beats dither patterns into uneven pixel widths. When `processedSampling === 'nearest'`: scale by `k = max(1, round(targetW / processedW))` with nearest into a scratch, then one **smooth** resample of the small residual ratio to the exact target (skip when residual = 1). Residual softening is uniform and beat-free; the target itself stays fixed (§5.1) so governor grid changes only alter `k`, not the canvas size. Smooth/box-resolved/ASCII/cell branches scale smoothly in one step.

### 5.3 Presentation rules

A mixed canvas **never** gets the `.pixelated` class (it would blockify the raw branch — [main.js:290](../js/main.js), [style.css:164](../css/style.css)); crispness comes from §5.2 inside the bitmap. The raw branch always draws with `imageSmoothingEnabled = true` inside save/restore (§2.7). The compositor only ever draws into app-owned canvases.

## 6. Frame pairing (bundles, ring, priming)

### 6.1 Epochs

`sourceEpoch` increments on source replacement; `contentEpoch` on each genuinely new source frame (rVFC tick, seek, gen-scene step). Engine and CPU-preview results carry the `contentEpoch` they processed (small metadata extension; worker commits report the epoch of the frame they diffused).

### 6.2 Bundles own their pixels (iron rule)

A frame bundle is `{processed, raw, contentEpoch, sourceEpoch, w, h}` where **both canvases are bundle-owned copies**. Engine canvases are mutated in place by later renders and worker commits (§2.4/2.5), so retaining references would silently corrupt pairing — the copy (≤2.25 MP, only on new frames while masked) is the price of correctness. `raw` is captured from `source.el` in the same synchronous task as the effect render/dispatch for that epoch.

### 6.3 Ring + pairing rule

Keep a ≤3-entry bundle ring keyed `(sourceEpoch, contentEpoch, w, h)`, pinning the displayed bundle, the in-flight CPU job's, and the latest pending frame's. Presentation composites a processed frame **only with the raw of the same epochs** — a late worker commit pairs with its dispatch-time raw, never with the current video frame. The **latest mask rev always applies** (mask is timeless; frames are not). Clear the ring on source replacement, seek discontinuities that invalidate pending work, and export teardown.

### 6.4 Priming — without pausing

The bypass state keeps no bundles by design, so the first transition to active (first stroke, placement flip, undo/redo restoring ink) must not reuse unpaired cached output: capture raw, invalidate any async CPU preview, and force **one synchronous effect render** at the normal live budget with a fresh epoch. This is a single synchronous frame — **playback continues** (no forced pause; spec 1's live-painting UX wins, made correct by the ring). The same priming path serves any cache/ring miss.

### 6.5 Invalidation classes

- **Effect-dirty** (source frame, settings, animation phase): re-run the engine, build a new bundle.
- **Composite-dirty** (mask rev, placement, overlay, target): re-run `finalizeFrame` on the displayed bundle only — no engine work, no worker dispatch, no `getImageData`. This is what keeps brush latency at pointer rate over a 300 ms CPU-diffusion frame or paused 4K still.

## 7. UX spec (spec 1's layer, adjusted)

**Activation.** `#btn-brush` ("Brush", shortcut **B**) in the toolbar group with Compare/Split — a canvas verb. Active = pressed button + floating brush bar + ink overlay + ring cursor. Closing the tool (B/Esc/Done) stops *editing*; the mask keeps applying.

**Brush bar** (floating top-center of `#viewport`, untransformed, added to the pan-exclusion selector at [view.js:135](../js/view.js)): [Paint | Erase] · Size · Feather · placement toggle labelled by meaning ("Effect outside ink" ⇄ "Effect inside ink") · Invert · Clear · Done. Size/Feather are tool config (module scope), not undo entries. First empty-mask activation hints: *"paint to protect · ⌥-drag erase · X flip placement · Space pan"*.

**Status chip (anti-confusion anchor).** Whenever coverage ≠ uniform 1, the status bar shows `masked · effect outside|inside` — or `masked · original everywhere` for the empty-inside state (§1) — even with the tool closed; clicking reopens it. Invisible ink is the failure mode this kills.

**Cursor & geometry.** Size is content-relative (~0.5–40% of long side, default 6%, shown as source px) — the ring grows as you zoom in, which is how detail work happens. `cursor: none` + DOM ring div (`mix-blend-mode: difference`), inner ring = feather core, dashed for eraser, crosshair below 4 screen px. Radius locks at pointerdown (mid-stroke zoom safe).

**Painting feedback is real:** every stamp → composite-dirty → recomposite of the displayed bundle at pointer rate.

**Ink overlay.** While the tool is active, `#mask-overlay` (in the canvas stack, after `#compare-canvas`, inheriting the stack transform) tints the **ink** (~35% accent) regardless of placement — "this is your ink; the toggle decides what it means." `pointer-events: none` always; redrawn on stroke/resize alongside the split overlay; hidden when the tool closes, during hold-C, and while exporting. Mirrors the `cmp` lifecycle.

**Keyboard** (extends the main.js key handler, honoring in-field guards; tool-active unless noted): **B** toggle (global) · **E** brush/eraser · hold-**⌥** temporary eraser · **X** flip placement · **[ ]** size · **⇧[ ⇧]** feather · **Esc** done · **⌘Z/⇧⌘Z** global undo. While the tool is active, Space→play/pause is suppressed (with an `e.repeat` guard) — **hold Space to pan**; the video bar remains the transport.

**Pointer routing.** `view.js` pointerdown gains a `if (this.toolIntercept?.(e)) return;` early-out (mirrors the `onSplitDrag` callback precedent at [view.js:183](../js/view.js)) — one authoritative router, no competing listeners. Wheel-zoom/pan untouched. Right-drag = erase, with `contextmenu` prevented while the tool is active (WKWebView fires it on mousedown); ⌥-drag is the documented fallback. Pen eraser-end maps to erase. Touch: single pointer paints; a second pointerdown cancels the in-flight stroke and falls back to pan.

**Compare/split coexistence.** Hold-C shows the pure original (unchanged). Split keeps working while painting: left pane = original overlay as today, right = masked composite; the ink tint sits above both so your ink stays visible everywhere.

**Video.** Painting during playback is supported (§6.4); scrubbing works with the tool open. UI copy: *"Static mask — applies to every frame."*

**Error-proofing.** Brush handlers and B gate on `!exporting`; an in-flight stroke force-commits when an export starts. Mid-stroke blur/`pointercancel` commits the partial stroke. `uniformCoverage()===1` bypass guarantees arming the tool is a no-op.

## 8. History, presets, reset, source switch

- **Undo:** each discrete edit (stroke pointerup, clear, placement flip) appends an op, bumps `rev`, and calls `commitHistory()` directly (not the 350 ms debounce). `snapshotStr()` gains `m: maskDoc.rev` — one integer, no snapshot bloat, nothing re-serialized on slider commits; `restoreSnapshot()` calls `setRev(m ?? 0)` (no-op when unchanged, ms-scale replay otherwise). Strokes interleave with slider edits in one coherent timeline. A parallel side-array of snapshot revs supports the bake floor (§4.1) without parsing JSON.
- **Presets & Shuffle keep the mask** — a mask is a *selection*, a preset is a *look*; because the document is outside `state`, the `resetState` wipe (§2.6) cannot touch it. Boot `?preset=` agrees for free.
- **Reset clears the mask** as a `clear` op inside Reset's existing history bracket — one ⌘Z restores settings *and* ink; toast appends "· mask cleared".
- **Source switch: keep + tell.** Normalized ink stays geometrically valid (per-axis stretch is the app-wide rule); re-grading a similar shot is a real workflow; silent clearing destroys minutes of work. `setSource` toasts *"Mask kept — B to edit, Clear to remove"*; the chip stays lit. This also keeps every historical `rev` valid — **no history wipe, no history barrier machinery** (the wipe in spec 2 was a collateral regression: settings-undo survives source loads today and must continue to). Caches/ring clear on `sourceEpoch` bump regardless (§6.3); rev-keyed selection rasters remain valid (ink is source-independent).
- Not serialized in presets, URL params, or localStorage (v1); session reload loses it — documented; mask-PNG import/export is future work.

## 9. Export integration

| Path | Mechanism | Protected-region fidelity |
|---|---|---|
| Live preview | `finalizeFrame` in `present()` on the mixed target (§5) | Near-native (≤2.25 MP), smooth raw branch — v1, not deferred |
| PNG (`source`/`source2x`) | Adapter picks final W×H first, then `finalizeFrame` (replaces the ad-hoc upscale+FX tail, ~[main.js:788–855](../js/main.js)); processed keeps the `lastBoxResolved` nearest/smooth rule | True native pixels |
| Frame-accurate MP4 | Two-stage encoder API (§9.1) | Encode-res raw branch, v1 |
| GIF | Composite inside `postProcess` at GIF target with divisor-crop registration (§9.2), before FX re-application and palette analysis | GIF-res raw branch; photo regions never pass through nearest decimation |
| Realtime MediaRecorder | Captures the finalized visible canvas; dimensions locked for the recording (§5.1) | Live-res |
| TXT / ANSI / HTML / copy | **Full-frame ASCII + notice** (v1): *"Effect Mask applies to raster and video exports; text output remains full-frame."* `captureMetadata`-only renders ([main.js:163](../js/main.js), [engine.js:780](../js/engine/engine.js)) skip raw capture, bundles, and pixel finalization entirely | n/a — blank-cell gating (with null fg AND bg, spec 1's ANSI lore) is a documented Phase-5 option |
| Preset thumbnails | Intentionally unmasked (`thumbEngine` cover-crop previews looks, not compositions; UV math wouldn't apply) | n/a |

### 9.1 MP4 two-stage API

1. Render the first processed frame without finalization; derive crisp/smooth policy and encoder dimensions from it. 2. Create the encoder. 3. Finalize **every** frame exactly once at encoder dimensions via `finalizeFrame` (glass FX applied there, at encode scale). 4. `encoder.add()` accepts only an already-final canvas of exactly those dimensions, 1:1. A guard test asserts no double finalization (feathered-edge histogram: `a + (1−a)·a ≠ a`). Frame-accurate seeking unchanged.

### 9.2 GIF crop registration

GIF chooses `w = floor(first.width/div)` and reads only the top-left `w·div × h·div` region ([exporters.js:593–627](../js/export/exporters.js)). The `postProcess` adapter receives `normalizedCrop = {u0:0, v0:0, u1:(w·div)/first.width, v1:(h·div)/first.height}` and uses the same crop for raw sampling and mask rasterization — no right/bottom drift. **Palette note:** any photo region breaks the encoder's ≤256-exact-color regime → whole-clip median-cut + per-frame FS re-dither, larger files, possible feather banding; surface via `onInfo`, with dither-palette-entry reservation as a Phase-5 option.

### 9.3 Determinism contract

Mask immutable during exports (gate + force-commit, §7) + rev-keyed rasters + epoch-paired bundles ⇒ same settings + same mask = byte-identical frames per browser. Test in Phase 4.

## 10. Performance plan

- **Bypass: zero cost.** One boolean; byte-identical output (acceptance-tested).
- **Painting:** incremental stamping + composite-dirty repaint only — no engine work, no worker dispatch. Pointer-rate latency even over paused 4K CPU-diffusion frames.
- **Live masked video, per new frame:** 1 raw capture (`drawImage(source.el)` ≤2.25 MP — the honest cost of true source pixels, paid only while masked), 1 bundle copy, 3 composite ops, FX at target. Budget: ≤10% cadence loss at 1080p Blue Noise vs. unmasked baseline on the reference M4 — measured, not assumed.
- **Governor split:** composite time is excluded from `renderMsEma`; mask-only repaints never train the governor; a cadence-only degradation with a healthy effect-render EMA must **not** drop supersampling (the ss→1 backfire enlarges the grid and worsens compositor cost). Compositor overload triggers the GPU gate instead.
- **GPU escape hatch (gated, not assumed):** if the 10% gate fails, implement the three-texture composite (raw, processed, R8 selection) **inside the Engine's existing GL context** — separate WebGL contexts cannot share textures and per-frame canvas→texture uploads would eat the win. Upload the selection texture only on rev/size change; mind the V-flip (§2.9). Canvas2D backend remains the WebGL-loss fallback.
- **Memory:** ring (≤3 bundles) + LRU rasters + 2 scratches ≈ 30–50 MB while masked on video; freed on Clear/source switch/export teardown. Export scratch canvases are dimension-guarded (WKWebView silently yields 0×0 on oversized canvases).

## 11. Hardening checklist (merged; each maps to a rule above)

- Feathered-alpha halo → two-branch `lighter` composite only; punch-out forbidden + regression-tested (§3.3).
- Stale worker frame vs. current raw → epoch-paired bundles; bundle-owned pixels (§6.2–6.3).
- Non-integer nearest moiré → two-step integer scaling (§5.2).
- Engine-canvas corruption → compositor draws only into app-owned canvases; bundles copy (§2.4, §6.2).
- Preset/shuffle wipe → document outside `state` (§4.1). Undo stale raster → `rev` in snapshots, `setRev` replay (§8).
- `.pixelated` on mixed canvas → never; raw branch forces smoothing in save/restore (§5.3). Export smoothing-flag inheritance → same rule (§2.7).
- Space pan vs play/pause (+`e.repeat`), right-drag vs WKWebView `contextmenu`-on-mousedown, mid-stroke zoom, pen eraser end, touch second-pointer, mid-stroke blur/`pointercancel`, brush-during-export → §7.
- ANSI colored-block artifact (null fg AND bg) → documented for the Phase-5 text-gating option (§9).
- Paused-video scrub / seek exports → epochs make bundles seek-aware; no "moving source" heuristics (§6.1).
- MediaRecorder resize mid-recording → dimension lock (§5.1). Transparent sources → exact premultiplied blend (§3.3).
- WebGL loss mid-session → compositor is path-agnostic; `glLost` renders in the QA matrix.
- GIF right/bottom drift → crop registration (§9.2). TXT capture render → no pixel finalization (§9).

## 12. Phased plan (each phase gated)

**Phase 0 — Baseline gate.** Commit the current dirty working tree (15 modified files, ~1.5k lines of video-perf work) as an explicit baseline branch/commit first; feature diffs stay isolated. Convert the browser smoke scenarios into a repeatable harness; capture golden frames (unmasked CPU dither, GPU dither, ASCII, one cell mode, PNG/GIF/MP4). *Exit: 39/39 tests, smoke green, baseline tagged.*

**Phase 1 — Mask core (pure, no UI).** `js/mask/model.js` (op log, rev, bake policy, serialization), `js/mask/rasterizer.js` (§4.2 math, incremental stamping, LRU), `js/mask/compositor.js` (§3.3 blend, bypass contract). Node unit tests: stamp/selection arithmetic goldens, placement complement, replay determinism, alpha lerp incl. translucent inputs, cache keys, truncate-on-new-op. *Exit: exact-blend goldens pass; no app integration yet.*

**Phase 2 — Preview + tool (shippable).** Epochs + bundle ring + priming; effect-dirty/composite-dirty split in `renderOnce()`/`present()`; mixed-target policy + two-step scaling; `finalizeFrame` preview adapter; brush tool (`js/mask/tools.js`): toolIntercept, UV math, cursor, overlay, brush bar, keyboard, chip; history wiring (`m: rev`); governor timing split. *Exit: all §13 still-image + live-video interaction criteria; empty-mask byte-identical; pointer-rate painting over CPU frames; settings-undo unaffected by source switch.*

**Phase 3 — Exports.** PNG adapter; MP4 two-stage API; GIF postProcess composite + crop registration + palette `onInfo`; MediaRecorder lock verification; text-export notice + captureMetadata skip; export gating/force-commit. *Exit: acceptance matrix {dither-GPU, dither-CPU, ascii, one cell} × {image, video, webcam, gen} × {PNG, MP4, GIF, realtime, TXT} × {outside, inside}; selected preview frames match exports within format tolerance.*

**Phase 4 — Performance + determinism.** 1080p Blue Noise and CPU-diffusion cadence benchmarks vs. baseline (10% gate → in-context GPU pass if failed); rasterization-count counter over 300 unchanged frames (== 1 per rev/size); double-finalization guard; byte-identical re-export test; WKWebView smoke (image, video, brush, undo, PNG/GIF/MP4); WebGL-loss drill. *Exit: gates green on the reference device, browser + native.*

**Phase 5 — Polish & deferred.** Hold-⌥ cursor swap, touch pinch refinement, bake stress test, optional cell-grid snap toggle (`engine.lastGridInfo` + threshold-0.5 quantize — spec 1's design, kept as fast-follow), optional text blank-cell gating (null fg/bg), Flow (correctly named), pressure, mask PNG import/export, GIF palette reservation.

## 13. Acceptance criteria (condensed)

| Area | Criterion |
|---|---|
| Compatibility | `uniformCoverage()===1` ⇒ every path byte-identical to baseline; zero allocations |
| Blend | Exact premultiplied lerp at a ∈ {0, 0.25, 0.5, 1} over opaque + translucent inputs; no halo |
| Fidelity | Raw regions sampled at the mixed/export target, never the work grid; crisp branch shows no scaling beat |
| Pairing | Delayed CPU commits composite only with same-epoch raw; no mixed-timestamp boundary |
| Coordinates | Stroke alignment within 1 target px across pan/zoom/mode/budget/export changes |
| Placement | Invert is an exact complement, costs no re-raster, preserves strokes |
| History | One edit = one undo entry; interleaves with slider edits; `setRev` replay exact; settings-undo survives source switch |
| Policies | Presets/shuffle keep mask; Reset clears (undoable, one bracket); source switch keeps + toasts |
| Video | Static mask stable across play/pause/seek/speed/export stepping; painting during playback at pointer rate |
| Exports | PNG/GIF/MP4/realtime contain the mask, exclude overlay/cursor; GIF crop-registered; MP4 finalized exactly once; text full-frame + notice |
| Perf | ≤10% cadence loss (1080p Blue Noise, reference device); mask edits never train the governor; raster count = 1 per (rev, size) |
| Memory | No pixel snapshots in history; ring ≤ 3 bundles; bounded under 100-stroke stress |
| Native | Same scenarios green in WKWebView |

## 14. Future directions (out of v1)

Keyframed/tracked masks (same `rasterize(w, h, time)` provider interface); segmentation-generated masks; parameter-modulation masks (per-region strength/pixel-size — needs the in-engine texture path); multiple mask layers with different effects; persistence in presets/sessions; shareable mask PNGs.

## 15. Resolved decision log (what was contested, what won, why)

| # | Decision | Winner | Rationale / flip cost |
|---|---|---|---|
| 1 | Blend math | Spec 2 (premultiplied two-branch `lighter`) | Spec 1's punch-out is provably wrong at feathered edges; regression-tested |
| 2 | Composite resolution | Spec 2 (final-target, incl. preview) + new §5.2 integer rule | Grid-res "originals" defeat the feature; moiré rule was missing from both |
| 3 | Frame pairing | Spec 2 (epochs + ring) + review's ownership amendment, minus forced pause | Verified stale-commit behavior in the tree; pause was a choice, not a necessity |
| 4 | Undo integration | Spec 1 (`m: rev` in existing snapshots; ops incl. placement) + bake policy | Minimal diff, structurally exact; spec 2's history-object refactor unnecessary |
| 5 | Source switch | Spec 1 (keep + tell) | Spec 2's history wipe was a collateral UX regression; keep also removes all barrier machinery |
| 6 | Post-FX semantics | Spec 1 (screen glass) — explicit product decision | Vignette holes / stopped scanlines read as bugs; one-line flip in `finalizeFrame` if taste disagrees |
| 7 | Empty + inside placement | Spec 2 (all-original, visible; bypass only at uniform 1) + chip affordance | Model consistency; the chip makes it read as intentional |
| 8 | ASCII/cell boundary | Spec 2 (freeform clipping) in v1; spec 1's cell snap as Phase-5 toggle | Mode-agnostic geometry, zero renderer coupling; snap preserved as opt-in |
| 9 | Text exports | Spec 2 (full-frame + notice) in v1; spec 1's blank-cells (null fg+bg) as Phase-5 option | Don't destroy text data by default; ANSI lore preserved for the option |
| 10 | Opacity | Neither (deferred) | Sol's own review: per-stamp accumulation is Flow, not Opacity |
| 11 | GPU fallback | Spec 2's compositor pass, hosted in the Engine's GL context (amended) | Cross-context texture sharing is impossible; per-frame uploads would eat the win |
| 12 | Raster cache key | New (selection-only raster; placement applied at composite) | Placement flips become free; better than both parents |
