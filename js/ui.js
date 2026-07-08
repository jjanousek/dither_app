// Control panel construction. Rebuilt wholesale whenever a structural choice
// changes (mode, algorithm, palette, ramp); sliders/toggles mutate state and
// call onChange() without a rebuild.

import { MODES } from './state.js';
import { ALGORITHMS, getAlgorithm } from './engine/engine.js';
import { PALETTES, getPalette } from './palettes.js';
import { RAMPS, FONTS } from './engine/ascii.js';
import { GEN_SCENES } from './generate.js';

// ---------- tiny component helpers ----------

// survives panel rebuilds — a collapsed section stays collapsed when the
// user switches mode/algorithm/palette and the whole panel is reconstructed
const sectionCollapsed = new Map();

function section(mount, title, { collapsed = false } = {}) {
  const el = document.createElement('div');
  const isCollapsed = sectionCollapsed.get(title) ?? collapsed;
  el.className = 'section' + (isCollapsed ? ' collapsed' : '');
  const h = document.createElement('h3');
  h.textContent = title;
  h.onclick = () => {
    sectionCollapsed.set(title, el.classList.toggle('collapsed'));
  };
  const body = document.createElement('div');
  body.className = 'section-body';
  el.append(h, body);
  mount.appendChild(el);
  return body;
}

function row(body, labelText) {
  const r = document.createElement('div');
  r.className = 'row';
  if (labelText !== null) {
    const l = document.createElement('label');
    l.textContent = labelText;
    r.appendChild(l);
  }
  body.appendChild(r);
  return r;
}

function slider(body, label, { min, max, step = 1, value, fmt = (v) => v, oninput }) {
  const r = row(body, label);
  const input = document.createElement('input');
  input.type = 'range';
  input.min = min;
  input.max = max;
  input.step = step;
  input.value = value;
  const fill = () => input.style.setProperty('--p', ((parseFloat(input.value) - min) / (max - min)) * 100);
  fill();
  const val = document.createElement('span');
  val.className = 'value';
  val.textContent = fmt(value);
  input.addEventListener('input', () => {
    const v = parseFloat(input.value);
    val.textContent = fmt(v);
    fill();
    oninput(v);
  });
  r.append(input, val);
  return input;
}

function toggle(body, label, { value, oninput }) {
  const r = row(body, label);
  const wrap = document.createElement('label');
  wrap.className = 'toggle';
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = !!value;
  const knob = document.createElement('span');
  knob.className = 'knob';
  input.addEventListener('change', () => oninput(input.checked));
  wrap.append(input, knob);
  r.appendChild(wrap);
  return input;
}

function select(body, label, { options, value, oninput }) {
  const r = row(body, label);
  const sel = document.createElement('select');
  const addOption = (parent, o) => {
    const opt = document.createElement('option');
    opt.value = o.value;
    opt.textContent = o.label;
    if (o.disabled) opt.disabled = true;
    if (o.value === value) opt.selected = true;
    parent.appendChild(opt);
  };
  if (options.some((o) => o.group)) {
    const groups = new Map();
    for (const o of options) {
      if (!groups.has(o.group)) {
        const g = document.createElement('optgroup');
        g.label = o.group;
        groups.set(o.group, g);
        sel.appendChild(g);
      }
      addOption(groups.get(o.group), o);
    }
  } else {
    options.forEach((o) => addOption(sel, o));
  }
  sel.addEventListener('change', () => oninput(sel.value));
  r.appendChild(sel);
  return sel;
}

function color(body, label, { value, oninput }) {
  const r = row(body, label);
  const input = document.createElement('input');
  input.type = 'color';
  input.value = value;
  input.addEventListener('input', () => oninput(input.value));
  r.appendChild(input);
  return input;
}

function textInput(body, label, { value, oninput, placeholder = '' }) {
  const r = row(body, label);
  const input = document.createElement('input');
  input.type = 'text';
  input.value = value;
  input.placeholder = placeholder;
  input.spellcheck = false;
  input.addEventListener('input', () => oninput(input.value));
  r.appendChild(input);
  return input;
}

const pct = (v) => `${Math.round(v * 100)}%`;

// ---------- panel ----------

export function buildPanel({ state, mount, onChange, exportSettings, gen = null, onGenChange = null }) {
  mount.innerHTML = '';
  const refresh = () => buildPanel({ state, mount, onChange, exportSettings, gen, onGenChange });
  const change = () => onChange();
  const changeAndRefresh = () => { onChange(); refresh(); };

  // --- SCENE (generated sources only) ---
  if (gen) {
    const sc = section(mount, 'Scene');
    select(sc, 'Scene', {
      options: GEN_SCENES.map((s) => ({ value: s.id, label: s.name })),
      value: gen.params.scene,
      oninput: (v) => { gen.setScene(v, { randomizeSeed: false }); onGenChange?.(); refresh(); },
    });
    gen.params.colors.forEach((cHex, i) => {
      color(sc, `Color ${i + 1}`, {
        value: cHex,
        oninput: (v) => { gen.params.colors[i] = v; onGenChange?.(); },
      });
    });
    slider(sc, 'Zoom', {
      min: 0.4, max: 3, step: 0.05, value: gen.params.scale,
      fmt: (v) => `${v.toFixed(2)}×`,
      oninput: (v) => { gen.params.scale = v; onGenChange?.(); },
    });
    slider(sc, 'Speed', {
      min: 0.25, max: 3, step: 0.05, value: gen.params.speed,
      fmt: (v) => `${v.toFixed(2)}×`,
      oninput: (v) => { gen.params.speed = v; onGenChange?.(); },
    });
    const seedRow = row(sc, null);
    const seedBtn = document.createElement('button');
    seedBtn.className = 'btn';
    seedBtn.style.flex = '1';
    seedBtn.textContent = 'New seed';
    seedBtn.onclick = () => { gen.params.seed = Math.random(); onGenChange?.(); };
    seedRow.appendChild(seedBtn);
  }

  // --- EFFECT ---
  const eff = section(mount, 'Effect');
  const grid = document.createElement('div');
  grid.className = 'mode-grid';
  for (const m of MODES) {
    const pill = document.createElement('div');
    pill.className = 'mode-pill' + (state.mode === m.id ? ' active' : '');
    pill.textContent = m.name;
    pill.onclick = () => { state.mode = m.id; changeAndRefresh(); };
    grid.appendChild(pill);
  }
  eff.appendChild(grid);

  if (state.mode === 'dither') {
    select(eff, 'Algorithm', {
      options: ALGORITHMS.map((a) => ({ value: a.id, label: a.name, group: a.group })),
      value: state.algorithm,
      oninput: (v) => { state.algorithm = v; changeAndRefresh(); },
    });
    slider(eff, 'Pixel size', {
      min: 1, max: 32, step: 1, value: state.pixelSize,
      fmt: (v) => `${v}px`,
      oninput: (v) => { state.pixelSize = v; change(); },
    });
    const algo = getAlgorithm(state.algorithm);
    if (algo.id !== 'none' && !algo.id.startsWith('halftone')) {
      slider(eff, 'Strength', {
        min: 0, max: 1, step: 0.01, value: state.ditherStrength, fmt: pct,
        oninput: (v) => { state.ditherStrength = v; change(); },
      });
    }
    slider(eff, 'Threshold', {
      min: 0, max: 1, step: 0.01, value: state.threshold, fmt: pct,
      oninput: (v) => { state.threshold = v; change(); },
    });
    if (algo.type === 'cpu') {
      toggle(eff, 'Serpentine scan', {
        value: state.serpentine,
        oninput: (v) => { state.serpentine = v; change(); },
      });
    }
    if (algo.id.startsWith('halftone')) {
      slider(eff, 'Dot scale', {
        min: 2, max: 24, step: 0.5, value: state.halftoneScale,
        fmt: (v) => `${v}px`,
        oninput: (v) => { state.halftoneScale = v; change(); },
      });
      slider(eff, 'Angle', {
        min: 0, max: 180, step: 1, value: state.halftoneAngle,
        fmt: (v) => `${v}°`,
        oninput: (v) => { state.halftoneAngle = v; change(); },
      });
    }
    if (algo.type === 'gpu') {
      // Supersamples the dither and averages to tone: 0 = crisp 1-bit dots,
      // higher = smoother, finer grain (great for video). GPU-only.
      slider(eff, 'Smoothness', {
        min: 0, max: 1, step: 0.01, value: state.smoothness, fmt: pct,
        oninput: (v) => { state.smoothness = v; change(); },
      });
    }
  } else if (state.mode === 'ascii') {
    const a = state.ascii;
    select(eff, 'Renderer', {
      options: [
        { value: 'ramp', label: 'Characters (ramp)' },
        { value: 'shape', label: 'Shape match' },
        { value: 'quadrant', label: 'Blocks 2×2' },
        { value: 'braille', label: 'Braille 2×4' },
      ],
      value: a.renderer,
      oninput: (v) => { a.renderer = v; changeAndRefresh(); },
    });
    if (a.renderer === 'ramp') {
      select(eff, 'Characters', {
        options: Object.entries(RAMPS).map(([id, r]) => ({ value: id, label: r.name })),
        value: a.rampId,
        oninput: (v) => { a.rampId = v; changeAndRefresh(); },
      });
      if (a.rampId === 'custom') {
        textInput(eff, 'Custom set', {
          value: a.customChars,
          placeholder: 'any glyphs — coverage is measured',
          oninput: (v) => { a.customChars = v || '@ '; change(); },
        });
      }
    }
    if (a.renderer === 'shape') {
      select(eff, 'Symbols', {
        options: [
          { value: 'ascii', label: 'ASCII (pure text)' },
          { value: 'blocks', label: 'ASCII + blocks' },
        ],
        value: a.shapeSet,
        oninput: (v) => { a.shapeSet = v; change(); },
      });
    }
    select(eff, 'Font', {
      options: Object.entries(FONTS).map(([id, f]) => ({ value: id, label: f.name })),
      value: a.fontId,
      oninput: (v) => { a.fontId = v; change(); },
    });
    slider(eff, 'Font size', {
      min: 4, max: 32, step: 1, value: a.cellSize,
      fmt: (v) => `${v}px`,
      oninput: (v) => { a.cellSize = v; change(); },
    });
    toggle(eff, 'Bold', { value: a.bold, oninput: (v) => { a.bold = v; change(); } });
    select(eff, 'Color', {
      options: [
        { value: 'mono', label: 'Monochrome' },
        { value: 'fg', label: 'Colored glyphs' },
        { value: 'bg', label: 'Full color (fg + bg)' },
      ],
      value: a.colorMode,
      oninput: (v) => { a.colorMode = v; changeAndRefresh(); },
    });
    if (a.colorMode === 'mono') {
      color(eff, 'Text', { value: a.fg, oninput: (v) => { a.fg = v; change(); } });
    }
    if (a.colorMode !== 'bg') {
      color(eff, 'Background', { value: a.bg, oninput: (v) => { a.bg = v; change(); } });
    }
    // quadrant "full color" splits colors per cell — no dot bitmap involved
    const quadFullColor = a.renderer === 'quadrant' && a.colorMode === 'bg';
    if (a.renderer !== 'shape' && !quadFullColor) {
      select(eff, 'Dither', {
        options: [
          { value: 'none', label: 'None' },
          { value: 'floyd', label: 'Floyd–Steinberg' },
          { value: 'bayer', label: 'Bayer 4×4' },
        ],
        value: a.dither,
        oninput: (v) => { a.dither = v; change(); },
      });
    }
    if ((a.renderer === 'quadrant' && !quadFullColor) || a.renderer === 'braille') {
      slider(eff, 'Dot threshold', {
        min: 0.1, max: 0.9, step: 0.01, value: a.dotThreshold, fmt: pct,
        oninput: (v) => { a.dotThreshold = v; change(); },
      });
    }
    if (a.renderer === 'ramp') {
      slider(eff, 'Edge detail', {
        min: 0, max: 1, step: 0.01, value: a.edgeStrength, fmt: pct,
        oninput: (v) => { a.edgeStrength = v; change(); },
      });
    }
    toggle(eff, 'Auto contrast', { value: a.autoContrast, oninput: (v) => { a.autoContrast = v; change(); } });
    toggle(eff, 'Invert mapping', { value: a.invertRamp, oninput: (v) => { a.invertRamp = v; change(); } });
  } else {
    const c = state.cells;
    slider(eff, 'Cell size', {
      min: 6, max: 40, step: 1, value: c.size,
      fmt: (v) => `${v}px`,
      oninput: (v) => { c.size = v; change(); },
    });
    slider(eff, 'Coverage', {
      min: 0, max: 1, step: 0.01, value: c.fill, fmt: pct,
      oninput: (v) => { c.fill = v; change(); },
    });
    slider(eff, 'Scatter', {
      min: 0, max: 1, step: 0.01, value: c.scatter, fmt: pct,
      oninput: (v) => { c.scatter = v; change(); },
    });
    select(eff, 'Color', {
      options: [
        { value: 'source', label: 'From image' },
        { value: 'duotone', label: 'Duotone' },
      ],
      value: c.colorMode,
      oninput: (v) => { c.colorMode = v; changeAndRefresh(); },
    });
    color(eff, 'Background', { value: c.ink, oninput: (v) => { c.ink = v; change(); } });
    if (c.colorMode === 'duotone') {
      color(eff, 'Foreground', { value: c.paper, oninput: (v) => { c.paper = v; change(); } });
    }
    if (state.mode === 'lattice') {
      select(eff, 'Node shape', {
        options: ['circle', 'square', 'diamond', 'cross'].map((v) => ({ value: v, label: v[0].toUpperCase() + v.slice(1) })),
        value: c.nodeShape,
        oninput: (v) => { c.nodeShape = v; change(); },
      });
    }
  }

  // --- PALETTE (dither only) ---
  if (state.mode === 'dither') {
    const pal = section(mount, 'Palette');
    select(pal, 'Preset', {
      options: PALETTES.map((p) => ({ value: p.id, label: p.name })),
      value: state.paletteId,
      oninput: (v) => { state.paletteId = v; changeAndRefresh(); },
    });
    const colors = state.paletteId === 'custom' ? state.customColors : getPalette(state.paletteId).colors;
    const prevRow = row(pal, 'Colors');
    const preview = document.createElement('div');
    preview.className = 'pal-preview';
    for (const cHex of colors) {
      const s = document.createElement('span');
      s.style.background = cHex;
      preview.appendChild(s);
    }
    prevRow.appendChild(preview);

    if (state.paletteId === 'custom') {
      const sw = document.createElement('div');
      sw.className = 'swatch-row';
      state.customColors.forEach((cHex, i) => {
        const input = document.createElement('input');
        input.type = 'color';
        input.value = cHex;
        input.title = 'Right-click to remove';
        // 'input' fires continuously while the native picker is open; a panel
        // rebuild would destroy the picker mid-edit. Update in place instead
        // and rebuild only on the final 'change'.
        input.addEventListener('input', () => {
          state.customColors[i] = input.value;
          if (preview.children[i]) preview.children[i].style.background = input.value;
          change();
        });
        input.addEventListener('change', refresh);
        input.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          if (state.customColors.length > 2) {
            state.customColors.splice(i, 1);
            changeAndRefresh();
          }
        });
        sw.appendChild(input);
      });
      if (state.customColors.length < 32) {
        const add = document.createElement('button');
        add.className = 'btn';
        add.textContent = '+';
        add.onclick = () => {
          state.customColors.push('#808080');
          changeAndRefresh();
        };
        sw.appendChild(add);
      }
      pal.appendChild(sw);
    }
  }

  // --- ADJUSTMENTS ---
  const adj = section(mount, 'Adjust');
  slider(adj, 'Brightness', { min: -1, max: 1, step: 0.01, value: state.brightness, fmt: pct, oninput: (v) => { state.brightness = v; change(); } });
  slider(adj, 'Contrast', { min: -1, max: 1, step: 0.01, value: state.contrast, fmt: pct, oninput: (v) => { state.contrast = v; change(); } });
  slider(adj, 'Gamma', { min: 0.2, max: 3, step: 0.01, value: state.gamma, fmt: (v) => v.toFixed(2), oninput: (v) => { state.gamma = v; change(); } });
  slider(adj, 'Saturation', { min: 0, max: 2, step: 0.01, value: state.saturation, fmt: pct, oninput: (v) => { state.saturation = v; change(); } });
  slider(adj, 'Hue shift', { min: 0, max: 360, step: 1, value: state.hue, fmt: (v) => `${v}°`, oninput: (v) => { state.hue = v; change(); } });
  slider(adj, 'Sepia', { min: 0, max: 1, step: 0.01, value: state.sepia, fmt: pct, oninput: (v) => { state.sepia = v; change(); } });
  slider(adj, 'Blur', { min: 0, max: 10, step: 0.1, value: state.blur, fmt: (v) => `${v.toFixed(1)}px`, oninput: (v) => { state.blur = v; change(); } });
  toggle(adj, 'Invert', { value: state.invert, oninput: (v) => { state.invert = v; change(); } });
  toggle(adj, 'Grayscale', { value: state.grayscale, oninput: (v) => { state.grayscale = v; change(); } });

  // --- POST FX ---
  const fx = section(mount, 'Post FX');
  slider(fx, 'Vignette', { min: 0, max: 1, step: 0.01, value: state.fx.vignette, fmt: pct, oninput: (v) => { state.fx.vignette = v; change(); } });
  slider(fx, 'Scanlines', { min: 0, max: 1, step: 0.01, value: state.fx.scanlines, fmt: pct, oninput: (v) => { state.fx.scanlines = v; change(); } });
  slider(fx, 'Film grain', { min: 0, max: 1, step: 0.01, value: state.fx.grain, fmt: pct, oninput: (v) => { state.fx.grain = v; change(); } });
  slider(fx, 'Chromatic', { min: 0, max: 20, step: 1, value: state.fx.chromatic, fmt: (v) => `${v}px`, oninput: (v) => { state.fx.chromatic = v; change(); } });
  slider(fx, 'Glow', { min: 0, max: 1, step: 0.01, value: state.fx.glow, fmt: pct, oninput: (v) => { state.fx.glow = v; change(); } });

  // --- ANIMATION ---
  const an = section(mount, 'Animation');
  // flow/shimmer drift the dither pattern — meaningless for error diffusion
  // (no fixed lattice) and for non-dither modes, so say it in the option
  const patternOk = state.mode === 'dither' && getAlgorithm(state.algorithm).type === 'gpu';
  select(an, 'Style', {
    options: [
      { value: 'none', label: 'None' },
      { value: 'breathe', label: 'Breathe (exposure)' },
      { value: 'pulse', label: 'Pulse (heartbeat)' },
      { value: 'sweep', label: 'Sweep (light band)' },
      { value: 'wave', label: 'Wave (distortion)' },
      { value: 'flow', label: patternOk ? 'Flow (pattern drift)' : 'Flow — needs a pattern dither', disabled: !patternOk },
      { value: 'shimmer', label: patternOk ? 'Shimmer (pattern jitter)' : 'Shimmer — needs a pattern dither', disabled: !patternOk },
    ],
    value: state.anim.style,
    oninput: (v) => { state.anim.style = v; changeAndRefresh(); },
  });
  if (state.anim.style !== 'none') {
    slider(an, 'Speed', {
      min: 1, max: 10, step: 0.5, value: state.anim.speed,
      fmt: (v) => `${v}×`,
      oninput: (v) => { state.anim.speed = v; change(); },
    });
    slider(an, 'Intensity', {
      min: 0, max: 1, step: 0.01, value: state.anim.intensity, fmt: pct,
      oninput: (v) => { state.anim.intensity = v; change(); },
    });
    if (state.anim.style === 'flow') {
      select(an, 'Direction', {
        options: [
          { value: 'right', label: '→ Right' },
          { value: 'left', label: '← Left' },
          { value: 'down', label: '↓ Down' },
          { value: 'up', label: '↑ Up' },
          { value: 'downright', label: '↘ Diagonal' },
          { value: 'upleft', label: '↖ Diagonal' },
        ],
        value: state.anim.direction,
        oninput: (v) => { state.anim.direction = v; change(); },
      });
    }
    if ((state.anim.style === 'flow' || state.anim.style === 'shimmer') && !patternOk) {
      const hint = document.createElement('div');
      hint.style.cssText = 'font-size:11px;color:var(--text-dim);line-height:1.5';
      hint.textContent = 'Flow and Shimmer move the pattern of ordered, noise and halftone algorithms. The current algorithm has no fixed pattern to animate — pick Bayer, Blue Noise or Halftone to see it.';
      an.appendChild(hint);
    }
    const hint2 = document.createElement('div');
    hint2.style.cssText = 'font-size:11px;color:var(--text-dim);line-height:1.5';
    hint2.textContent = 'Animated still images can be exported as looping GIFs or recorded as video.';
    an.appendChild(hint2);
  }

  // --- EXPORT ---
  const ex = section(mount, 'Export');
  select(ex, 'PNG size', {
    options: state.mode === 'dither'
      ? [
        { value: 'work', label: 'Pixel-exact (1 px per dot)' },
        { value: 'source', label: 'Source resolution' },
        { value: 'source2x', label: '2× source resolution' },
      ]
      : [
        { value: 'source', label: 'Native resolution (1×)' },
        { value: 'source2x', label: '2× resolution' },
      ],
    value: exportSettings.pngSize === 'work' && state.mode !== 'dither' ? 'source' : exportSettings.pngSize,
    oninput: (v) => { exportSettings.pngSize = v; },
  });
  select(ex, 'GIF quality', {
    options: [
      { value: '360', label: 'Small (~360px)' },
      { value: '480', label: 'Medium (~480px)' },
      { value: '720', label: 'Large (~720px)' },
      { value: 'native', label: 'Native (1:1 pixels)' },
    ],
    value: exportSettings.gifSize,
    oninput: (v) => { exportSettings.gifSize = v; },
  });
  select(ex, 'Record length', {
    options: [
      { value: '3', label: '3 seconds' },
      { value: '5', label: '5 seconds' },
      { value: '10', label: '10 seconds' },
    ],
    value: exportSettings.recordSeconds,
    oninput: (v) => { exportSettings.recordSeconds = v; },
  });
  if (state.mode === 'ascii') {
    select(ex, 'Text format', {
      options: [
        { value: 'plain', label: 'Plain text (.txt)' },
        { value: 'ansi', label: 'ANSI colors (.ans)' },
        { value: 'html', label: 'Web page (.html)' },
      ],
      value: exportSettings.txtFormat,
      oninput: (v) => { exportSettings.txtFormat = v; },
    });
    const copyRow = row(ex, null);
    const copyBtn = document.createElement('button');
    copyBtn.className = 'btn';
    copyBtn.style.flex = '1';
    copyBtn.textContent = 'Copy ASCII to clipboard';
    copyBtn.onclick = () => exportSettings.onCopyText?.();
    copyRow.appendChild(copyBtn);
  }
  const note = document.createElement('div');
  note.style.cssText = 'font-size:11.5px;color:var(--text-dim);line-height:1.5';
  note.textContent = 'PNG / Video / GIF buttons live in the top bar. Video exports record the live preview in real time (with audio when the source has it).';
  ex.appendChild(note);
}

// ---------- preset strip ----------

// Cards with live thumbnails. `getThumbCanvas(preset)` is called lazily by the
// app whenever the source changes; here we just create the slots and hand the
// canvases back through onReady.
export function buildPresetStrip({ mount, presets, onApply, onShuffle }) {
  mount.innerHTML = '';
  const thumbCanvases = new Map();

  const card = (name, thumbInner, onClick, extraClass = '') => {
    const c = document.createElement('div');
    c.className = `preset-card ${extraClass}`.trim();
    const thumb = document.createElement('div');
    thumb.className = 'preset-thumb';
    thumb.append(thumbInner);
    const label = document.createElement('div');
    label.className = 'preset-name';
    label.textContent = name;
    c.append(thumb, label);
    c.onclick = onClick;
    mount.appendChild(c);
    return c;
  };

  const shuffleIcon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  shuffleIcon.setAttribute('viewBox', '0 0 16 16');
  shuffleIcon.innerHTML = '<path d="M1.5 4.5h3l6 7h4M14.5 11.5l-2-2m2 2-2 2M1.5 11.5h3l1.7-2M8.7 6.6l1.8-2.1h4M14.5 4.5l-2-2m2 2-2 2"/>';
  card('Shuffle', shuffleIcon, onShuffle, 'shuffle-card');

  for (const p of presets) {
    const canvas = document.createElement('canvas');
    canvas.width = 192;
    canvas.height = 120;
    thumbCanvases.set(p.id, canvas);
    const c = card(p.name, canvas, () => {
      mount.querySelectorAll('.preset-card').forEach((el) => el.classList.remove('active'));
      c.classList.add('active');
      onApply(p);
    });
    c.dataset.id = p.id;
  }
  return thumbCanvases;
}

export function clearActivePreset(mount) {
  mount.querySelectorAll('.preset-card').forEach((el) => el.classList.remove('active'));
}

// ---------- toast ----------

let toastTimer = null;
export function toast(msg, ms = 2600) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}
