# Brush Mask — Feature Spec & Implementation Plan

**Status:** proposed (not implemented) · **Date:** 2026-07-11
**Feature:** a pen/brush tool that paints a region over the image/video; the active effect (dither / ASCII / cell modes) applies only inside — or, inverted, only outside — the painted region. Protected regions show the clean original. Works live on images, video, webcam, and generated scenes, and is honored by every export path.

This spec was produced from a full codebase analysis (multi-agent map + hands-on testing; 39/39 tests passing at time of writing), three independent design studies (UX-first, pipeline-correctness-first, minimal-diff-first), and an adversarial review pass that attacked the draft architecture from export-fidelity, live-video-performance, and state-machinery angles. Decisions below fold in every confirmed finding.

---

## 1. Product definition

- **Brush** paints a spatial region; **polarity** decides what the region means:
  - **Protect** (default): painted region shows the clean original; effect everywhere else.
  - **Effect**: effect only inside the painted region; original everywhere else.
  The user's two phrasings ("apply effect where I brush" / "mark parts where no effect shows") are the same mask with opposite polarity — one toggle, not two tools.
- **Default = Protect.** Rationale: with the empty-mask bypass rule (§6), Protect is continuous from the unmasked state — the first stroke changes only what you touched. Effect-polarity's first stroke flips ~99% of the frame to the original, which reads as breakage. One-line change if taste disagrees; the toggle makes both first-class.
- Brushes are round, with **size** and **feather** (0 = hard edge, 1 = fully soft falloff). **Eraser** removes ink. **Clear** empties the mask. Feathered edges crossfade effect↔original in pixel modes; in ASCII/cell modes edges snap to the cell grid (§7).
- The mask is **static in frame space** on video (v1): subjects move through the masked zone — that is the signature look. Motion tracking / keyframes are future work (§13).

## 2. What the analysis established (constraints the design must obey)

Verified against the working tree (see `memory: ditherlab-render-pipeline-map` for the full map):

1. **Export coverage map.** Live preview, frame-accurate MP4, realtime MediaRecorder, and GIF all capture the `out` canvas via `renderOnce()` → `present()` ([main.js:188](../js/main.js), [main.js:239](../js/main.js)). Three paths bypass `present()`: PNG ([main.js:805–839](../js/main.js)), preset thumbnails (separate `thumbEngine`, cover-cropped snapshot), and TXT/ANSI/HTML (consume `engine.ascii.lastGrid/lastText` only, [main.js:1185–1218](../js/main.js)). The split-view overlay (`cmp`) is screen-only chrome, never exported — a mask must NOT be built like it.
2. **No stable pixel grid.** The processed resolution is recomputed every frame (pixelSize/cellSize × live budgets × governor × per-export budgets; `present()` may add a ≤2× fx upscale). Masks must live in **normalized per-axis source coordinates**; the full frame is always stretched to the grid (no crop/letterbox/DPR anywhere).
3. **Pointer→content math**: `((clientX − rect.left) − view.tx) / view.zoom` → `out`-bitmap px ([view.js:34](../js/view.js), transform-origin 0 0); divide by `out.width/height` for (u,v). `Viewport` pointer-captures every left-drag on `#viewport` except targets in the exclusion selector at [view.js:135](../js/view.js).
4. **Engine-owned canvases are shared/cached** (glCanvas, work canvas, ascii canvas, cellCanvas, `cpu.committed`) — presentation code must never draw onto them.
5. **Alpha is taken** on the live-video GPU path (temporal pre-pass writes motion into alpha; DITHER_FS reads `src.a`); the fast video path never touches Canvas2D. Any future GPU-side mask needs its own R8 texture (V-flip `uvOut=(u,1−v)`).
6. **State traps.** Presets AND shuffle call `resetState(state)` before `applyParams` ([main.js:1251](../js/main.js), [main.js:1269](../js/main.js), [main.js:1359](../js/main.js)) — any mask data stored in `state` is wiped by a preset click. Undo is a 100-deep stack of `JSON.stringify(state)` snapshots ([main.js:493–507](../js/main.js)); bitmaps cannot live there, and large stroke arrays would be re-serialized on every unrelated slider commit.
7. **GIF exporter** seeks frame-by-frame like MP4 and, with fx on, renders raw frames and re-applies post-FX per frame AFTER decimation ([main.js:1126–1156](../js/main.js)) — forcing the composite-before-post-FX ordering rule (§6).

## 3. Core architecture

**The mask is a post-render composite, not an engine feature.** Every pipeline renders exactly as today; the compositor blends the clean original over the processed frame using the mask as per-pixel alpha:

```
final = effect · (1 − a) + original · a        (a = protect coverage, 0..1)
```

All three independent designs converged on this, for the same reasons:

- **Native-res fidelity is only possible post-render.** An in-shader `mix(dithered, src, mask)` blends with the *downsampled* work texture — at pixelSize 8 the "protected original" would be an 8-px-blocky reconstruction. Compositing at each output path's final raster lets protected regions show true source pixels.
- **One implementation covers all four pipeline families** (GPU uber-shader, CPU error diffusion sync+worker, 4 ASCII renderers, 6 cell effects). In-pipeline masking would mean four mechanisms that must stay visually identical.
- **The async CPU worker stays untouched.** `#cpuSig` ([engine.js:183–188](../js/engine/engine.js)) never learns about the mask; a stroke is visible on the next presented frame even while the worker is busy, with zero re-dispatch churn.
- **Temporal pre-pass / motion-in-alpha untouched.** Protected regions show the raw current frame (no EMA ghosting) — correct under "clean original".

**Rejected alternatives** (documented so they aren't relitigated):
- *GPU R8 mask texture in DITHER_FS*: covers 1 of 4 pipelines, needs an un-adjusted second sample path (the shader applies brightness/contrast/gamma pre-dither), collides with V-flip/context-loss/ingest-FBO plumbing. Kept as the documented **performance escape hatch** for the GPU-video path only (§10).
- *Per-cell gates inside cells.js/ascii.js render loops*: a skipped cell shows the paper/bg color, not the original; forks six renderers + compact variants; feather is inexpressible. (The `L < gate` skip at [cells.js:154](../js/effects/cells.js) remains purely a coverage mechanism.)
- *Split-overlay-style mask* (separate screen canvas): never exported — fails the feature's core promise.
- *Masking inside error diffusion*: changes error propagation across the boundary, invalidates the worker signature cache per stroke, can't express feather.

### 3.1 New module and hook points

**One new module: `js/mask.js`** — `MaskField` (op log + rasterizer + caches, §4) and the brush tool controller (pointer handling, cursor, overlay painting).

| # | Hook | Location | What happens |
|---|------|----------|--------------|
| 1 | `present()` composite | [main.js:239](../js/main.js), after the fx-upscale block, before `applyPostFX`; no-fx path: into `out` after the blit at [main.js:285](../js/main.js) | Covers live preview, frame-accurate MP4, realtime recordings, GIF — everything that captures `out` |
| 2 | PNG composite | between [main.js:838](../js/main.js) (upscale into export canvas) and [main.js:839](../js/main.js) (`applyPostFX`) | Protected regions at full export W×H — the fidelity path |
| 3 | ASCII text gate | `#renderAscii` forwards a per-cell gate when `captureMetadata` ([engine.js:722](../js/engine/engine.js)); applied in `AsciiRenderer.#finish` ([ascii.js:183](../js/engine/ascii.js)) | TXT/ANSI/HTML + copy-to-clipboard get blank protected cells (§7) |
| 4 | Grid metadata | `#renderAscii` / `#renderCells` set `engine.lastGridInfo = {cols, rows}` every render; dither paths set `null` | Lets the compositor cell-quantize the mask for ASCII/cell modes (§7) |
| 5 | Mask-only repaint | render loop [main.js:405–431](../js/main.js) | `maskDirty` flag: re-composite the cached last engine result without re-running the engine (§10) |
| 6 | Pointer routing | pan pointerdown guard [view.js:133–140](../js/view.js) | `if (this.toolIntercept?.(e)) return;` early-out (mirrors the `onSplitDrag` callback precedent); brush registers its own capture-drag on `#viewport` |
| 7 | History | `snapshotStr()` [main.js:493](../js/main.js) gains `m: maskField.rev`; `restoreSnapshot()` [main.js:515](../js/main.js) calls `maskField.setRev(parsed.m ?? 0)` | Strokes ride the existing undo timeline as one integer per snapshot (§8) |
| 8 | DOM | `index.html`: `#mask-overlay` canvas in `#canvas-stack` after `#compare-canvas` (line 75); `#btn-brush` in the Compare/Split group (lines 47–60); `#brush-bar` + `#brush-cursor` in `#viewport` | Overlay inherits zoom/pan via the stack transform (cmp precedent) |

**Iron rules** (each closes a confirmed attack finding):
- **Never draw onto an engine-returned canvas.** When fx are on (any mode, any scale), copy `result` into an app-owned pre-fx scratch (extend the existing `upCanvas` copy to be unconditional when `maskActive && fxOn`), composite there, then `applyPostFX(scratch)`. The previous "else composite onto out" rule had no valid branch for fx-without-upscale (ASCII+vignette, dither at scale 1) and would have corrupted `cpu.committed` / the ascii canvas or produced composite-after-fx inconsistency.
- **Composite before post-FX, always.** Post-FX is screen-level glass (vignette/scanlines/grain over everything, including protected regions); the mask gates *content*. This also makes the GIF's apply-fx-after-decimation path consistent with MP4 by construction.
- **Redraw the original every presented frame.** Cache only mask rasters (rev-keyed). Any "cache the source draw for non-moving sources" heuristic freezes the protected region during paused-video scrubbing and seek-driven exports (both exporters pause the video and seek — `!paused` is false the whole time). A still-image fast path may cache keyed on source identity + `type === 'image'` only.
- **Punch-out first for alpha correctness**: `destination-out` the effect frame with the mask, then draw the masked original — protected regions carry the original's true transparency (semi-transparent-PNG sources stay correct).
- **The original layer always draws with `imageSmoothingEnabled = true`** inside its own save/restore — export contexts inherit nearest-neighbor settings meant for dither pixels ([main.js:836](../js/main.js), exporters' strict flag) that must not blockify the photo layer.

## 4. Mask data model

**Coordinate space: normalized per-axis source UV** ([0,1]²), mapping to the full source frame. Forced by constraint §2.2; the same field samples identically at every live/export resolution, per-axis (w and h round independently).

**Layer 1 — op log (source of truth, undo unit).**
`ops: [{ type: 'stroke'|'clear'|'invert'|'mode', ... }]`, where a stroke op is
`{ type:'stroke', e: bool (eraser), r: radius, f: feather 0..1, pts: [u,v, u,v, ...] }`:
- `r` in normalized units (fraction of source long side), **captured once at stroke start** — wheel-zoom stays live mid-stroke and must not retroactively change stamp sizes.
- Points decimated at capture (drop points closer than `r/4` to the last kept point; use `getCoalescedEvents()` for fast strokes) — a typical stroke is 10–60 points. **No pressure array in v1** (nothing consumes it; add later as an optional field).
- `rev` = number of ops applied. The raster at any rev is a **pure function of `ops[0..rev)`** — undo/redo/history-restore replay exactly. Replay starts from the last `clear` at-or-before rev. New op while `rev < ops.length` truncates the tail first (mirrors `history.stack.splice`, [main.js:503](../js/main.js)). Op count capped (~200): overflow bakes the oldest ops into a baseline raster op.
- Polarity (`mode`) and `invert` are **ops**, not separate state — one integer (`rev`) fully describes mask content, which is what makes snapshot restore exact.

**Layer 2 — on-demand rasters with a small LRU.** No fixed-resolution master bitmap. `rasterFor(W, H)` renders the op log at exactly W×H (hard brush = round-cap polyline fills; feather = radial-gradient stamps spaced `r·0.35`; eraser = same stamps with `destination-out`), cached keyed `(rev, W, H, polarity)`, LRU ≈ 4 entries (live grid, fx-upscale grid, export raster, GIF/MP4 raster). Consequences:
- Hard-brush edges are **exact at every export resolution** (no 2048-px master upscaled to an 8K PNG — that shipped either a 2–4 px penumbra or staircasing).
- Live painting stamps **incrementally** into the live-size raster (only the new segment); full replay happens only on undo/clear/rev-jump/size change.
- Mask immutable during export (`exporting` guard) ⇒ every frame of a seek-driven export samples the identical cached raster ⇒ frame-exact determinism (same settings + same mask ⇒ byte-identical files per browser).

**Lives in `main.js` module scope** (like `view` / `exportSettings`), NOT in `state` — so preset/shuffle `resetState` can never wipe it (§2.6 trap disarmed at the root), and snapshots stay tiny (`m: rev` integer).

## 5. UX spec

**Activation.** `#btn-brush` ("Brush", shortcut **B**) in the toolbar group with Compare/Split — a canvas verb, not a settings panel item. Active tool = pressed button + floating brush bar + overlay tint + ring cursor. Closing the tool (B/Esc/Done) stops *editing* but the mask keeps applying — the tool edits the mask, it doesn't enable it.

**Brush bar** (floating top-center of `#viewport`, untransformed space; added to the pan-exclusion selector): [Paint | Erase] segmented control · Size · Feather · polarity toggle labelled by meaning ("Protect painted" ⇄ "Effect painted") · Clear · Done. Brush size/feather are tool config (module scope, like `exportSettings`) — dragging them doesn't touch undo. First activation with an empty mask shows a hint line: *"paint to protect · ⌥ drag to erase · X flip polarity · Space pan"*. In ASCII/cell modes the bar adds: *"edges snap to the character grid"*.

**Status chip (the anti-confusion anchor).** Whenever the mask is non-empty, the status bar shows `masked · protect|effect` even with the tool closed; clicking it reopens the tool. A mask is invisible ink otherwise — this chip is what prevents "why is half my image undithered?" confusion. `updateStatus()` ([main.js](../js/main.js)) is the hook.

**Brush geometry.** Size is **content-relative** (fraction of source long side, ~0.5–40%, default 6%, displayed as source px) — Photoshop/Procreate convention: the ring grows on screen as you zoom in, and zooming in is how you do detail work. Radius locked per stroke at pointerdown. Cursor: `cursor: none` on the viewport + a DOM ring div (`mix-blend-mode: difference`), diameter `2r · max(out.width,out.height) · view.zoom`, inner ring showing the feather core, dashed for eraser, crosshair fallback below 4 screen px.

**Painting feedback is real:** every stamp sets `maskDirty` → recomposite of the cached effect frame — the effect literally appears/disappears under the brush at pointer rate, even over a 300 ms error-diffusion frame (§10).

**Overlay tint.** While the tool is active, `#mask-overlay` tints the **painted ink** (accent color ~35%) regardless of polarity — "this is your ink; the toggle decides what ink means." Lives in the canvas stack (zooms/pans free), `pointer-events: none` always (input is captured on `#viewport`, so the overlay can never orphan pan/zoom). Redrawn on stroke change and `out` resize alongside the split overlay; hidden when the tool closes, during hold-C compare, and while exporting. Mirrors `cmp` lifecycle exactly ([main.js:318–323](../js/main.js)).

**Keyboard** (extends the [main.js:1381](../js/main.js) handler, honoring its in-field guards; all tool-active only unless noted): **B** toggle tool (global) · **E** eraser toggle · hold **⌥** temporary eraser (live cursor swap) · **X** flip polarity · **[ ]** size · **⇧[ ⇧]** feather · **Esc** done · **⌘Z/⇧⌘Z** global undo (strokes are in the main timeline, §8). C compare, S split, zoom keys keep working.

**Pan/zoom coexistence.** Wheel-zoom and horizontal-wheel-pan are untouched (wheel handler on `#viewport`, [view.js:113–129](../js/view.js)). Left-drag paints; **hold Space to pan** (Figma/Photoshop muscle memory). While the tool is active, the Space→play/pause binding ([main.js:1398](../js/main.js)) is suppressed (and gains an `e.repeat` guard) — the video bar remains the transport. Right-drag = erase, with `contextmenu` prevented on `#viewport` while the tool is active (split-divider precedent, [view.js:166](../js/view.js)); ⌥-drag is the documented fallback (macOS ctrl+click is a left-click). Pen eraser-end (pointerType `pen`, eraser button) maps to erase. Touch: single pointer paints; a second pointerdown cancels the in-flight stroke and falls back to pan (pinch-zoom via the existing ctrl+wheel path).

**Video/webcam.** Painting while playing is fully supported — each rVFC frame recomposites through the static mask; subjects crossing the boundary is the aesthetic. Scrubbing works with the tool open. Webcam is not mirrored (verified), so painted-where-shown holds with no special case. Generated scenes: `gen.canvas` is just another `source.el`.

**Error-proofing.**
- All brush handlers and the B shortcut gate on `!exporting`; an in-flight stroke is force-committed when an export starts.
- Mid-stroke blur/`pointercancel` commits the partial stroke (never a stuck drag; [view.js:199–206](../js/view.js) precedent).
- **Empty mask ⇒ complete bypass** on every path, regardless of polarity/enabled — output is byte-identical to today, opening and closing the tool is a no-op, and there is no way to blank the whole frame by merely arming the tool.
- **Source switch: keep + tell.** Normalized coords stay geometrically valid; re-grading a similar shot is a real workflow; silent clearing destroys minutes of work. `setSource` toasts *"Mask kept — B to edit, Clear to remove"* and the chip stays lit. Aspect changes stretch per-axis (the app-wide stretch rule); Clear is one click and undoable.

## 6. Composite semantics

Per presented/exported frame, when the mask is non-empty:

1. Resolve the protect field `a` at the target raster: `raster = rasterFor(W, H)`, polarity applied at raster time (protect = ink for Protect mode, 1−ink for Effect mode).
2. **Pixel modes (dither):** punch out the effect frame (`destination-out` with `a`), then draw the masked original (`scratch = source.el drawn at W×H, smoothing high; destination-in with a`) over it. Feathered edges are true crossfades.
3. **ASCII & cell modes: cell-quantized alpha.** Build the per-cell gate from `engine.lastGridInfo` (draw the raster into a cols×rows scratch = box-averaged coverage; threshold at 0.5; nearest-upscale to the frame). A glyph/cell is either fully effect or fully original — half-cut glyphs read as rendering bugs, and this makes the visual, PNG, and text exports **agree on the same cell decisions**. Feather still shapes *which* cells cross 0.5.
4. Post-FX (when on) applies after, over the whole composited frame.
5. Hold-C compare shows the pure original (unchanged); split view draws its original overlay above the composited `out` (unchanged).

**Protected means the RAW original** — no adjustments, no CSS filters, no temporal smoothing — matching what Compare and Split already call "original" ([main.js:298–307](../js/main.js)). The alternative (adjusted-but-undithered) needs a second native-res adjustment pass per frame and muddies the mental model.

## 7. Export integration matrix

| Path | Mechanism | Protected-region fidelity |
|------|-----------|---------------------------|
| Live preview | `present()` hook | Grid-res original; `pixelated` CSS class means blocky at high zoom in crisp-dither modes — accepted, PNG is the fidelity path (documented) |
| PNG (`source`/`source2x`) | Own hook between upscale and post-FX ([main.js:838–839](../js/main.js)) | **True native pixels** — raster rendered at export W×H |
| Frame-accurate MP4 | v1: inherited via `renderOnce`→`present` ([main.js:966](../js/main.js), [main.js:1018](../js/main.js)) | v1: grid-res original (matches preview = WYSIWYG). **Phase-3 fidelity pass**: `noMask` render + composite inside `enc.add` post-upscale ([exporters.js:86/162](../js/export/exporters.js)) for encode-res originals |
| GIF (incl. noFx variant) | v1: inherited via `present`; post-FX still applies after decimation ([main.js:1129](../js/main.js)) — ordering correct by construction | v1: decimation may alias the photo region when `smooth=false`. **Phase 3**: composite inside `postProcess` post-decimation, with the div-remainder source-rect crop for registration; or force `smooth` when masked |
| Realtime MediaRecorder | Inherited (captures `out`) | Live-res; edits blocked while recording |
| TXT / ANSI / HTML / copy | Per-cell gate at capture time; protected cells → `[' ', null, null]` (char + **null fg AND bg** — a bare space with stale bg renders as a colored block in ANSI/HTML), `lastText` rebuilt from the same grid so download and clipboard agree | Blank is the honest text rendering of "no effect here"; toast notes it. Skip the pixel composite entirely on capture-only renders (avoids a pointless ~50 MP composite on the TXT path) |
| Preset thumbnails | Intentionally unmasked (`thumbEngine` bypasses; thumbnails preview looks, not compositions — and they render a cover-crop where UV math wouldn't apply anyway) | n/a |

**Determinism contract:** mask immutable during exports + rev-keyed raster cache + same-task original/effect sampling ⇒ same settings + same mask = byte-identical frames per browser (test in Phase 3). The composite reads `source.el` in the same synchronous task as the engine's ingest, so original and effect always show the same decoded frame (also keeps animated-GIF `<img>` sources coherent).

**GIF palette note:** any photo region breaks the encoder's ≤256-bucket exact-color regime ([gif.js:1–10](../js/export/gif.js)) → whole-clip median-cut + per-frame FS re-dither, larger files, feather-edge banding. Document; optionally warn via `onInfo`; Phase-3 option: reserve the dither palette entries before median-cut.

## 8. Undo / presets / reset policy

- **Undo:** every discrete mask edit (stroke pointerup, clear, polarity flip) appends an op, bumps `rev`, and calls `commitHistory()` directly (discrete-action precedent — NOT the 350 ms debounce, which would merge rapid strokes). `snapshotStr()` carries `m: rev` (one integer — no snapshot bloat, nothing to re-serialize on slider commits); `restoreSnapshot()` calls `maskField.setRev(m)` which no-ops when unchanged and otherwise replays (ms-scale). ⌘Z therefore interleaves strokes with slider edits in one coherent timeline. This design makes stale-raster-after-undo structurally impossible — `setRev` IS the sync.
- **Presets & Shuffle keep the mask** — a mask is a *selection*, a preset is a *look*; browsing looks inside your painted region is the workflow. Because the mask isn't in `state`, the `resetState` wipe trap can't fire. (Boot `?preset=` path agrees for free.)
- **Reset clears the mask** — "Reset all settings" should not leave invisible ink confining the effect. Implemented as a `clear` op inside Reset's existing history bracket ([main.js:1341–1353](../js/main.js)), so one ⌘Z restores settings *and* mask; toast appends "· mask cleared".
- **Source switch keeps the mask** (keep + tell, §5). Not serialized in presets, URL params, or localStorage (v1); a session reload loses it — documented, with mask-PNG import/export as future work.

## 9. Performance plan

Budgets (targets, enforced by design):
- **Mask inactive: zero cost** — one boolean check per frame; output byte-identical to today.
- **Painting:** stamping is incremental into the live raster (only the new segment); `maskDirty` recomposites the cached engine result without re-rendering the effect — no `#drawWork`, no `getImageData`, no worker dispatch, no shape-matching. Brush latency stays at pointer rate even on paused 4K error-diffusion or shape-ASCII frames. Mask edits never train the governor.
- **Live masked video:** per frame = 1 `drawImage(source.el → ≤2.25 MP)` + 1 `destination-out` + 1 masked-original draw. This deliberately re-adds a Canvas2D video touchpoint that `#ingestVideo` removed for the unmasked path ([engine.js:467](../js/engine/engine.js)) — it is the honest cost of showing true source pixels, paid only when a mask exists. Mitigations: rev-keyed raster cache (no per-frame mask resample), composite target capped by `LIVE_FX_PIXELS`, and the composite is excluded from `renderMsEma` so it cannot trick the governor into an ss-drop that *grows* the grid (the confirmed governor-backfire loop). If WKWebView profiling shows the video readback hurting (the Swift wrapper is the concern), the escape hatch is the **R8 mask texture + `mix()` tail in DITHER_FS for the GPU-video path only** — grid ≈ native there under the 2.25 MP budget, so quality holds (mind the V-flip).
- **Memory:** LRU rasters + 2 scratch canvases ≈ 10–20 MB while active; freed on Clear/source switch. PNG-export composite reuses one module canvas, dimension-guarded like the export canvas ([main.js:828](../js/main.js)) — WKWebView fails oversized canvases silently as 0×0.

## 10. Edge cases & hardening checklist

All confirmed by the adversarial pass; each maps to a spec rule above:

- fx-on but no upscale branch (ASCII+vignette; dither at scale 1) → unconditional pre-fx scratch copy. Never composite onto engine canvases.
- Paused-video scrub / seek-driven exports → no source-draw caching keyed on "moving"; redraw per presented frame.
- Preset/shuffle wipe → mask outside `state` (structural fix).
- Undo/redo stale raster → `rev` in snapshots; `setRev` replay.
- Space pan vs play/pause; key-repeat → suppress while tool active + `e.repeat` guard.
- Right-drag erase vs contextmenu (macOS WKWebView fires it on mousedown) → preventDefault while tool active.
- ANSI/HTML colored-block artifact → protected cells emit null fg AND bg.
- Feathered-cell halo (glyph blanked but composite alpha < 1) → never blank glyphs visually; cell-quantized composite instead.
- Transparent sources → punch-out-first composite.
- Nearest-neighbor inheritance on export contexts → force smoothing for the original layer inside save/restore.
- TXT capture render → skip pixel composite (grid gate only).
- Brush while exporting / stroke in flight at export start → gate + force-commit.
- Overlay lifecycle → mirror `cmp`: resize/redraw in `present()`, hidden when comparing/exporting; input ignored while comparing.
- Mid-stroke zoom → radius locked at stroke start.
- Portrait/panorama sources → rasters sized by area/long-side at the consumer's W×H (on-demand model makes this automatic).
- WebGL loss mid-session (GPU→CPU fallback) → composite is path-agnostic; include `glLost` renders in the QA matrix.

## 11. Phased implementation plan

**Phase 1 — Mask core + live preview (shippable alone).**
`js/mask.js` (MaskField: op log, on-demand rasters + LRU, incremental stamping, setRev replay, cellGate; tool controller: pointer capture, UV math, cursor ring, overlay tint, brush bar). DOM/CSS (`#mask-overlay`, `#btn-brush`, `#brush-bar`, `#brush-cursor`). `view.js` `toolIntercept` early-out. `present()` composite with the unconditional pre-fx scratch rule. `maskDirty` fast path (cached last engine result). History wiring (`m: rev`, `setRev`, commit per stroke). Keyboard (B/E/X/[ ]/Esc/Space-pan + suppressions). Empty-mask bypass. Status chip.
*Acceptance:* paint/erase/feather/polarity/clear on still + playing video + webcam + gen scene; pan/zoom/split/compare/presets/undo all coexist; empty mask provably byte-identical + zero-cost; painting over a paused CPU-dither frame stays at pointer rate.

**Phase 2 — All modes + export coverage.**
`engine.lastGridInfo` metadata; cell-quantized composite for ASCII/cells. PNG hook (native-res). TXT/ANSI/HTML/copy grid gate (`[' ', null, null]`, rebuilt lastText, capture-render composite skip). Verify inherited paths (MP4/GIF/realtime) with mask active; brush-during-export gating; preset/shuffle/reset/source-switch policies + toasts.
*Acceptance matrix:* {dither-GPU, dither-CPU, ascii, one cell mode} × {image, video, webcam, gen} × {PNG, MP4, GIF, realtime rec, TXT/ANSI/HTML, copy} × {protect, effect polarity}.

**Phase 3 — Fidelity + determinism hardening.**
Encoder-level MP4 composite (`noMask` threading + `composite(fctx,w,h)` in `enc.add`) and GIF `postProcess` composite with div-remainder registration — native/encode-res protected regions in motion exports; double-composite guard test (feathered-edge histogram — `a + (1−a)·a ≠ a`). Masked-GIF policy (force smooth or per-region decimation; palette reservation option + `onInfo` note). Governor timing split (exclude composite from `renderMsEma`). Determinism suite: same clip+mask exported twice ⇒ byte-identical; empty-mask ⇒ pre-feature-identical on all paths.
*Tests (node, following `tests/core-regressions.test.js` patterns):* op-log replay determinism; rev restore; decimation math; cellGate thresholds; text-grid rewrite incl. ANSI nulls; empty-bypass.

**Phase 4 — Feel & polish.**
Pressure (pen radius modulation), coalesced-event stroke quality pass, hold-⌥ eraser cursor swap, touch two-pointer pan/pinch, op-log flatten-to-baseline stress test, WKWebView video-composite profiling (→ R8 escape hatch if needed), optional "pixel-aligned edges" toggle (quantize mask to the dither grid for hard-edge purists), mask PNG import/export for round-tripping.

## 12. Future directions (explicitly out of v1)

- **Keyframed / motion-tracked masks** for video (the headline v2; slots behind the same MaskField interface).
- **Parameter-modulation masks**: mask channels driving strength/pixel-size gradients per-region (requires the in-engine R8 path).
- **Multiple mask layers** with different effects per region (e.g. ASCII inside, dither outside).
- **Mask persistence** in sessions/presets; shareable mask PNGs.

## 13. Open questions (recommendations chosen, cheap to flip)

1. **Default polarity** — spec says Protect (continuity argument, §1); if first-user-impression testing prefers "paint the effect on", flip the default.
2. **Reset semantics** — spec says Reset clears the mask (undoable); alternative: Reset keeps it like presets do.
3. **ANSI/HTML protected cells** — spec says fully blank; alternative: space with per-cell average source color as bg (approximates "original shows through" in terminals).
4. **Pressure in v1?** — spec defers to Phase 4.
