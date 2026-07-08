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

export const DITHER_FS = `#version 300 es
precision highp float;

in vec2 v_uv;
out vec4 outColor;

uniform sampler2D u_src;        // downsampled source frame (NEAREST), at u_ss * u_outSize
uniform sampler2D u_threshold;  // tiling threshold map (R8, REPEAT)
uniform vec2 u_srcSize;         // source texture resolution in pixels
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
// or a finer sub-pixel coordinate when supersampling).
vec4 ditherSample(vec2 uv, vec2 pix) {
  vec4 src = texture(u_src, uv);
  vec3 c = adjust(src.rgb);

  float n = float(u_paletteSize);
  float spread = u_strength / max(1.0, n - 1.0) * 1.5;

  if (u_mode == 1) {
    // Ordered dithering from tiling threshold texture (u_matOffset drifts it)
    vec2 mpix = mod(pix + u_matOffset, vec2(u_thresholdSize));
    float t = texelFetch(u_threshold, ivec2(mpix), 0).r;
    c += (t - 0.5 + u_bias) * spread * 255.0 / 255.0 * vec3(1.0);
    return vec4(nearestPalette(clamp(c, 0.0, 1.0)), src.a);
  } else if (u_mode == 2) {
    // White noise (u_seed reseeds per animation tick). floor(): sub-pixel
    // offsets would decorrelate the hash into boiling instead of drift.
    float t = hash12(pix + floor(u_matOffset) + vec2(u_seed * 91.7, u_seed * 37.3));
    c += (t - 0.5 + u_bias) * spread;
    return vec4(nearestPalette(clamp(c, 0.0, 1.0)), src.a);
  } else if (u_mode == 3 || u_mode == 4) {
    // Procedural halftone: dots (3) or lines (4)
    vec3 darkest, brightest;
    paletteExtremes(darkest, brightest);
    // drift applied AFTER rotation so a whole-tile offset stays a lattice
    // vector of the rotated pattern (seamless flow loops at any angle)
    vec2 p = rot(u_halftoneAngle) * pix + u_matOffset;
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
    return vec4(mix(brightest, darkest, v), src.a);
  }
  // Quantize only (mode 0)
  c += u_bias;
  return vec4(nearestPalette(clamp(c, 0.0, 1.0)), src.a);
}

void main() {
  // Canvas rows are uploaded top-first but clip space points up -> flip V.
  vec2 uvOut = vec2(v_uv.x, 1.0 - v_uv.y);
  ivec2 op = ivec2(floor(uvOut * u_outSize));

  // Crisp reference: dither at the output resolution (identical to the classic
  // single-pass path when u_ss == 1).
  vec4 crisp = ditherSample((vec2(op) + 0.5) / u_outSize, vec2(op));

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
      acc += ditherSample((vec2(hp) + 0.5) / hiSize, vec2(hp));
    }
  }
  acc /= float(u_ss * u_ss);

  outColor = mix(crisp, acc, u_smoothness);
}`;
