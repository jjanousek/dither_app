// Fragment shader for all GPU dither modes. One uber-shader with a mode
// switch keeps state management trivial and swaps are instant.
//
// Adjustment math MUST stay in sync with applyAdjustments() in cpu.js:
// brightness/contrast -> gamma -> saturation -> invert
// (cpu.js applies saturation before the LUT; both orders commute closely
// enough visually, but we mirror the exact order here: sat happens on raw
// color, then per-channel curve.)
//
// Smoothness: when u_ss > 1 the dither is evaluated on a finer grid and box-
// averaged into each output pixel. Averaging binary decisions yields tone
// (anti-aliased dither), so the "grain" reads as fine print rather than a hard
// 1-bit field — smoother on motion and finer perceived grain. u_smoothness
// blends the crisp (single-sample) result toward the averaged one, so 0 is
// byte-identical to the classic path and 1 is fully resolved tone.

export const MAX_PALETTE = 32;

// Downsample blit for direct GPU video ingest. Samples a mipmapped, native-res
// video texture (LINEAR_MIPMAP_LINEAR) into the work FBO at the target grid
// size — a GPU box-ish downscale that replaces the per-frame Canvas2D
// high-quality resample (cuts CPU work/heat on a fanless Air). No V-flip: the
// work texture keeps the same orientation as the old Canvas2D path.
export const BLIT_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 outColor;
uniform sampler2D u_src;
void main() { outColor = texture(u_src, v_uv); }`;

// Temporal smoothing pre-pass (video/webcam only). Motion-gated EMA on the raw
// downsampled frame BEFORE dithering: blend toward the previous stabilized
// frame where the image is static, and fall back to the live frame where it
// moves (so motion doesn't smear/ghost). Feeding a temporally-denoised frame
// into the dither is what calms the frame-to-frame "boil" of a 1-bit field.
// Output is a 1:1 copy-orientation of u_src (no V-flip); the dither pass
// applies its own flip when it samples this texture.
export const TEMPORAL_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 outColor;
uniform sampler2D u_src;    // this frame's downsampled source (NEAREST)
uniform sampler2D u_hist;   // previous frame's stabilized result
uniform float u_historyWeight; // 0..~0.8 max blend on fully-static pixels
uniform float u_motionLo;      // below this delta => treat as static
uniform float u_motionHi;      // above this delta => treat as full motion
uniform float u_denoise;       // 0..1 tent-blur amount (flat-area cleanup)
uniform vec2 u_texel;          // 1 / source size, for neighbour taps
uniform int u_reset;           // 1 = first frame / discontinuity: no history
// Light 3x3 tent blur — cleans video-compression noise that would otherwise
// chatter the dither threshold in flat regions. Cheap; kept before dithering.
vec3 denoised(vec2 uv) {
  vec3 c0 = texture(u_src, uv).rgb;
  if (u_denoise <= 0.0) return c0;
  vec2 t = u_texel;
  vec3 s = c0 * 4.0;
  s += (texture(u_src, uv + vec2(t.x, 0.0)).rgb + texture(u_src, uv - vec2(t.x, 0.0)).rgb
      + texture(u_src, uv + vec2(0.0, t.y)).rgb + texture(u_src, uv - vec2(0.0, t.y)).rgb) * 2.0;
  s += texture(u_src, uv + t).rgb + texture(u_src, uv - t).rgb
      + texture(u_src, uv + vec2(t.x, -t.y)).rgb + texture(u_src, uv + vec2(-t.x, t.y)).rgb;
  return mix(c0, s / 16.0, u_denoise);
}
void main() {
  vec3 cur = denoised(v_uv);
  // motion is carried in alpha for the dither pass (motion-adaptive strength)
  if (u_reset == 1) { outColor = vec4(cur, 0.0); return; }
  vec3 hist = texture(u_hist, v_uv).rgb;
  float d = max(max(abs(cur.r - hist.r), abs(cur.g - hist.g)), abs(cur.b - hist.b));
  float motion = smoothstep(u_motionLo, u_motionHi, d);
  float w = u_historyWeight * (1.0 - motion);
  outColor = vec4(mix(cur, hist, w), motion);
}`;

export const DITHER_FS = `#version 300 es
precision highp float;

in vec2 v_uv;
out vec4 outColor;

uniform sampler2D u_src;        // downsampled source frame (LINEAR), nominally
                                // u_ss * u_outSize but possibly clamped to the
                                // video's native size — sampled by UV, so the
                                // grid math below never needs its resolution
uniform sampler2D u_threshold;  // tiling threshold map (R8, REPEAT)
uniform vec2 u_outSize;         // output (present) resolution in pixels
uniform int u_ss;               // supersample factor (1 = classic path)
uniform float u_smoothness;     // 0 = crisp 1-bit, 1 = fully box-averaged tone
uniform float u_thresholdSize;  // threshold map side length

// 0 = quantize only, 1 = ordered (threshold texture), 2 = white noise,
// 3 = halftone dots, 4 = halftone lines
uniform int u_mode;

uniform float u_brightness;   // -1..1
uniform float u_contrast;     // -1..1
uniform float u_gamma;        // 0.2..3
uniform float u_saturation;   // 0..2
uniform float u_strength;     // 0..1 dither strength
uniform float u_bias;         // threshold bias -0.5..0.5
uniform bool  u_invert;

uniform vec3 u_palette[${MAX_PALETTE}];
uniform int u_paletteSize;

uniform float u_halftoneScale; // cell size in pixels
uniform float u_halftoneAngle; // radians

uniform vec2 u_matOffset;      // animated pattern drift (pixels)
uniform float u_seed;          // animated noise reseed

uniform float u_motionDamp;    // reduce dither strength on motion (0 = off)
uniform int u_hasMotion;       // 1 = alpha carries per-pixel motion (pre-pass ran)

float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

vec3 adjust(vec3 c) {
  float l = luma(c);
  // clamp after saturation to mirror the CPU LUT-index clamp in cpu.js
  c = clamp(l + (c - l) * u_saturation, 0.0, 1.0);
  c = (c - 0.5) * (1.0 + u_contrast) + 0.5 + u_brightness;
  c = clamp(c, 0.0, 1.0);
  c = pow(c, vec3(1.0 / max(u_gamma, 0.01)));
  if (u_invert) c = 1.0 - c;
  return c;
}

// Perceptually-weighted nearest palette color (same weights as cpu.js).
vec3 nearestPalette(vec3 c) {
  vec3 best = u_palette[0];
  float bestD = 1e9;
  for (int i = 0; i < ${MAX_PALETTE}; i++) {
    if (i >= u_paletteSize) break;
    vec3 d = u_palette[i] - c;
    float dist = dot(d * d, vec3(0.299, 0.587, 0.114));
    if (dist < bestD) { bestD = dist; best = u_palette[i]; }
  }
  return best;
}

// Darkest / brightest palette entries, for halftone fg/bg.
void paletteExtremes(out vec3 darkest, out vec3 brightest) {
  darkest = u_palette[0]; brightest = u_palette[0];
  float dMin = 1e9, dMax = -1e9;
  for (int i = 0; i < ${MAX_PALETTE}; i++) {
    if (i >= u_paletteSize) break;
    float l = luma(u_palette[i]);
    if (l < dMin) { dMin = l; darkest = u_palette[i]; }
    if (l > dMax) { dMax = l; brightest = u_palette[i]; }
  }
}

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

mat2 rot(float a) { return mat2(cos(a), -sin(a), sin(a), cos(a)); }

// Dither one sample. uv samples the (already downsampled) source; pix is the
// integer coordinate in the dither grid (== output pixel in the classic path,
// or a finer sub-pixel coordinate when supersampling). gridScale is how many
// dither-grid units make one output pixel (1 crisp, u_ss in the SS loop) — used
// to keep the halftone lattice a fixed size in OUTPUT space regardless of ss.
vec4 ditherSample(vec2 uv, vec2 pix, float gridScale) {
  vec4 src = texture(u_src, uv);
  vec3 c = adjust(src.rgb);

  // The pre-pass stores per-pixel motion in alpha; damp dither strength where
  // the frame moves (less crawl) and force opaque output. With no pre-pass,
  // preserve the source alpha (transparent PNGs etc.).
  float motion = (u_hasMotion == 1) ? src.a : 0.0;
  float outA = (u_hasMotion == 1) ? 1.0 : src.a;
  // u_motionDamp is the max strength reduction at full motion (0.45 => x0.55)
  float strength = u_strength * (1.0 - u_motionDamp * motion);

  float n = float(u_paletteSize);
  float spread = strength / max(1.0, n - 1.0) * 1.5;

  if (u_mode == 1) {
    // Ordered dithering from tiling threshold texture (u_matOffset drifts it)
    vec2 mpix = mod(pix + u_matOffset, vec2(u_thresholdSize));
    float t = texelFetch(u_threshold, ivec2(mpix), 0).r;
    c += (t - 0.5 + u_bias) * spread * 255.0 / 255.0 * vec3(1.0);
    return vec4(nearestPalette(clamp(c, 0.0, 1.0)), outA);
  } else if (u_mode == 2) {
    // White noise (u_seed reseeds per animation tick). floor(): sub-pixel
    // offsets would decorrelate the hash into boiling instead of drift.
    float t = hash12(pix + floor(u_matOffset) + vec2(u_seed * 91.7, u_seed * 37.3));
    c += (t - 0.5 + u_bias) * spread;
    return vec4(nearestPalette(clamp(c, 0.0, 1.0)), outA);
  } else if (u_mode == 3 || u_mode == 4) {
    // Procedural halftone: dots (3) or lines (4)
    vec3 darkest, brightest;
    paletteExtremes(darkest, brightest);
    // drift applied AFTER rotation so a whole-tile offset stays a lattice
    // vector of the rotated pattern (seamless flow loops at any angle).
    // pix/gridScale puts the lattice in output-pixel space so the dot size is
    // constant whether we're sampling the crisp grid or the ss-finer grid.
    vec2 p = rot(u_halftoneAngle) * (pix / gridScale) + u_matOffset;
    float scale = max(u_halftoneScale, 1.5);
    // + bias so raising Threshold brightens, same convention as modes 0/1/2
    float l = clamp(luma(c) + u_bias, 0.0, 1.0);
    float v;
    if (u_mode == 3) {
      vec2 cell = fract(p / scale) - 0.5;
      // dot radius grows with darkness; 0.75 lets dots merge in shadows
      float radius = sqrt(1.0 - l) * 0.75;
      v = step(length(cell), radius);
    } else {
      float s = fract(p.y / scale);
      float width = (1.0 - l);
      v = step(abs(s - 0.5) * 2.0, width);
    }
    return vec4(mix(brightest, darkest, v), outA);
  }
  // Quantize only (mode 0)
  c += u_bias;
  return vec4(nearestPalette(clamp(c, 0.0, 1.0)), outA);
}

void main() {
  // Canvas rows are uploaded top-first but clip space points up -> flip V.
  vec2 uvOut = vec2(v_uv.x, 1.0 - v_uv.y);
  ivec2 op = ivec2(floor(uvOut * u_outSize));

  // Crisp reference: dither at the output resolution (identical to the classic
  // single-pass path when u_ss == 1). At even u_ss this tap lands on a texel
  // CORNER of the finer source; the LINEAR sampler reads that as the exact 2x2
  // box mean — deterministic, unlike the old NEAREST corner pick which was
  // FP/driver-dependent (and closer to the box-downsampled classic source).
  vec4 crisp = ditherSample((vec2(op) + 0.5) / u_outSize, vec2(op), 1.0);

  if (u_ss <= 1 || u_smoothness <= 0.0) {
    outColor = crisp;
    return;
  }

  // Supersampled resolve: average u_ss x u_ss dither decisions from the finer
  // grid. Constant loop bounds with an early break keep old GPUs happy.
  vec2 hiSize = u_outSize * float(u_ss);
  vec4 acc = vec4(0.0);
  for (int j = 0; j < 3; j++) {
    if (j >= u_ss) break;
    for (int i = 0; i < 3; i++) {
      if (i >= u_ss) break;
      ivec2 hp = op * u_ss + ivec2(i, j);
      acc += ditherSample((vec2(hp) + 0.5) / hiSize, vec2(hp), float(u_ss));
    }
  }
  acc /= float(u_ss * u_ss);

  outColor = mix(crisp, acc, u_smoothness);
}`;
