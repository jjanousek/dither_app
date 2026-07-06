// Generative scene source — animated procedural backgrounds in the spirit of
// Paper Shaders (paper.design, Apache-2.0), reimplemented compactly. Every
// scene is a pure function of u_phase in 0..1 and loops seamlessly, so scenes
// bake into perfect GIF loops and record deterministically.

import { hexToRgb } from './palettes.js';

export const GEN_SCENES = [
  {
    id: 'mesh',
    name: 'Mesh Gradient',
    colors: ['#5b3df5', '#ff5ea1', '#ffb86c', '#2de2e6', '#151530'],
  },
  {
    id: 'neuro',
    name: 'Neuro Noise',
    colors: ['#03040c', '#3d5afe', '#a7f3ff'],
  },
  {
    id: 'warp',
    name: 'Warp Field',
    colors: ['#0d0221', '#f6019d', '#2de2e6', '#fdfdfd'],
  },
  {
    id: 'smoke',
    name: 'Smoke',
    colors: ['#050510', '#312e81', '#7c6cff', '#e0e7ff'],
  },
  {
    id: 'voronoi',
    name: 'Voronoi Flow',
    colors: ['#0a0a0c', '#1b9aaa', '#ffd23f', '#ff4858', '#f6f4e6'],
  },
  {
    id: 'blobs',
    name: 'Metaballs',
    colors: ['#06060a', '#22d3ee', '#8b7cff', '#f0abfc'],
  },
];

const SCENE_INDEX = Object.fromEntries(GEN_SCENES.map((s, i) => [s.id, i]));

const VS = `#version 300 es
void main() {
  vec2 pos = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(pos * 2.0 - 1.0, 0.0, 1.0);
}`;

const FS = `#version 300 es
precision highp float;
out vec4 outColor;

uniform vec2 u_res;
uniform float u_phase;   // 0..1, all scenes loop seamlessly over one cycle
uniform float u_scale;
uniform float u_seed;
uniform int u_scene;     // index into GEN_SCENES
uniform vec3 u_colors[6];
uniform int u_colorCount;

#define TAU 6.28318530718

float hash21(vec2 p) {
  p = fract(p * vec2(0.3183099, 0.3678794)) + 0.1;
  p += dot(p, p + 19.19);
  return fract(p.x * p.y);
}
vec2 hash22(vec2 p) {
  float h = hash21(p);
  return vec2(h, hash21(p + h + 7.31));
}
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(hash21(i), hash21(i + vec2(1, 0)), f.x),
    mix(hash21(i + vec2(0, 1)), hash21(i + vec2(1, 1)), f.x), f.y);
}
float fbm(vec2 p) {
  float a = 0.5;
  float r = 0.0;
  for (int i = 0; i < 4; i++) {
    r += a * vnoise(p);
    p = p * 1.99 + 3.1;
    a *= 0.6;
  }
  return r;
}
// loopable fbm: the time axis is a circle in noise space. r sets how far the
// sample point travels per cycle — i.e. how fast the field churns. Keep the
// per-frame image change near the mesh scene's (~1.5%) or the dithered
// output reads as flicker instead of motion.
float lfbm(vec2 p, float ph, float r) {
  return fbm(p + r * vec2(cos(TAU * ph), sin(TAU * ph)));
}

// multi-stop gradient through the palette
vec3 ramp(float t) {
  t = clamp(t, 0.0, 1.0);
  float x = t * float(u_colorCount - 1);
  int i = int(x);
  int j = min(i + 1, u_colorCount - 1);
  return mix(u_colors[i], u_colors[j], smoothstep(0.0, 1.0, x - float(i)));
}

// --- scenes -----------------------------------------------------------------

vec3 meshScene(vec2 uv, float t) {
  // gentle looping domain warp + swirl
  uv += 0.04 * vec2(sin(t + uv.y * 3.0), cos(t + uv.x * 3.0));
  float r = length(uv);
  float sw = 0.9 * sin(t) * r;
  uv = mat2(cos(sw), -sin(sw), sin(sw), cos(sw)) * uv;

  // color spots on integer-frequency Lissajous orbits (seamless)
  vec3 acc = vec3(0.0);
  float wsum = 0.0;
  for (int i = 0; i < 6; i++) {
    if (i >= u_colorCount) break;
    float fi = float(i) * 2.4 + u_seed * 17.0;
    float fa = float(1 + (i % 2));
    float fb = float(1 + ((i + 1) % 3));
    vec2 c = 0.42 * vec2(sin(t * fa + fi), cos(t * fb + fi * 1.7));
    float d = length(uv - c);
    float w = 1.0 / (pow(d, 3.2) + 1e-3);
    acc += u_colors[i] * w;
    wsum += w;
  }
  return acc / wsum;
}

vec3 neuroScene(vec2 uv, float t) {
  // zozuar-style trig accumulation (t only appears inside sin/cos -> loops)
  vec2 p = uv * 0.9 + u_seed;
  vec2 sineAcc = vec2(0.0);
  vec2 res = vec2(0.0);
  float sc = 8.0;
  mat2 rot1 = mat2(0.5403, -0.8415, 0.8415, 0.5403);
  for (int j = 0; j < 15; j++) {
    p = rot1 * p;
    sineAcc = rot1 * sineAcc;
    vec2 layer = p * sc + float(j) + sineAcc - t;
    sineAcc += sin(layer);
    res += (0.5 + 0.5 * cos(layer)) / sc;
    sc *= 1.2;
  }
  float n = res.x + res.y;
  n = 1.3 * n * n;
  n = pow(n, 2.0);
  return ramp(clamp(n * 0.72, 0.0, 1.0));
}

vec3 warpScene(vec2 uv, float ph) {
  vec2 p = uv * 3.0;
  float n1 = lfbm(p + u_seed, ph, 1.0);
  float n2 = lfbm(p + u_seed + 11.3, ph, 1.0);
  p += 2.2 * (n2 - 0.5) * vec2(cos(TAU * n1), sin(TAU * n1));
  for (int i = 1; i <= 4; i++) {
    p.x += 0.35 / float(i) * cos(TAU * ph + float(i) * 1.5 * p.y);
    p.y += 0.35 / float(i) * cos(TAU * ph + float(i) * 1.0 * p.x);
  }
  float v = 0.5 + 0.5 * sin(p.x) * cos(p.y);
  return ramp(v);
}

vec3 smokeScene(vec2 uv, float ph) {
  vec2 p = uv * 2.1 + u_seed * 3.0;
  float q = lfbm(p, ph, 0.5);
  float v = lfbm(p + 1.9 * vec2(q, -q) + vec2(0.0, 0.6), ph, 0.5);
  v = v * 0.8 + 0.35 * q;
  return ramp(smoothstep(0.18, 0.92, v));
}

vec3 voronoiScene(vec2 uv, float t) {
  vec2 p = uv * 5.0 + u_seed * 10.0;
  vec2 g = floor(p);
  vec2 f = fract(p);
  float md = 8.0;
  float mh = 0.0;
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 n = vec2(float(x), float(y));
      vec2 h = hash22(g + n);
      vec2 c = n + 0.5 + 0.35 * cos(t + TAU * h); // orbiting points: seamless
      float d = length(c - f);
      if (d < md) { md = d; mh = hash21(g + n); }
    }
  }
  vec3 col = ramp(mh);
  col *= 0.55 + 0.45 * smoothstep(0.0, 0.5, md);   // center shading
  col = mix(u_colors[0] * 0.4, col, smoothstep(0.015, 0.07, md)); // cell borders
  return col;
}

vec3 blobsScene(vec2 uv, float t) {
  float field = 0.0;
  float hue = 0.0;
  for (int i = 0; i < 7; i++) {
    float fi = float(i) * 1.9 + u_seed * 9.0;
    float fa = float(1 + (i % 3));
    float fb = float(1 + ((i + 2) % 2));
    vec2 c = 0.38 * vec2(sin(t * fa + fi), cos(t * fb + fi * 1.31));
    float d2 = dot(uv - c, uv - c);
    float w = 0.028 / (d2 + 0.002);
    field += w;
    hue += w * fract(fi * 0.313);
  }
  hue /= max(field, 1e-3);
  float v = smoothstep(0.7, 4.5, field);
  vec3 col = ramp(clamp(0.15 + 0.85 * v, 0.0, 1.0));
  // subtle per-blob tinting
  col = mix(col, ramp(hue), 0.25 * smoothstep(1.2, 3.0, field));
  return col;
}

void main() {
  vec2 frag = gl_FragCoord.xy;
  vec2 uv = (frag - 0.5 * u_res) / u_res.y / max(u_scale, 0.05);
  float t = TAU * u_phase;
  vec3 col;
  if (u_scene == 0) col = meshScene(uv, t);
  else if (u_scene == 1) col = neuroScene(uv, t);
  else if (u_scene == 2) col = warpScene(uv, u_phase);
  else if (u_scene == 3) col = smokeScene(uv, u_phase);
  else if (u_scene == 4) col = voronoiScene(uv, t);
  else col = blobsScene(uv, t);
  // banding fix (Paper's trick): sub-LSB noise on the final color
  col += (1.0 / 255.0) * (hash21(frag) - 0.5);
  outColor = vec4(col, 1.0);
}`;

export class GenerativeSource {
  constructor(width = 1280, height = 800) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = width;
    this.canvas.height = height;
    this.phase = 0;
    this.params = {
      scene: 'mesh',
      colors: [...GEN_SCENES[0].colors],
      scale: 1,
      speed: 1,
      seed: Math.random(),
    };

    const gl = this.canvas.getContext('webgl2', { preserveDrawingBuffer: true, antialias: false });
    this.gl = gl;
    if (!gl) return; // isSupported() gates usage

    const compile = (type, src) => {
      const sh = gl.createShader(type);
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        throw new Error('generate.js shader: ' + gl.getShaderInfoLog(sh));
      }
      return sh;
    };
    const prog = gl.createProgram();
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, VS));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      throw new Error('generate.js link: ' + gl.getProgramInfoLog(prog));
    }
    gl.useProgram(prog);
    this.u = {};
    for (const n of ['u_res', 'u_phase', 'u_scale', 'u_seed', 'u_scene', 'u_colors', 'u_colorCount']) {
      this.u[n] = gl.getUniformLocation(prog, n);
    }
  }

  isSupported() {
    return !!this.gl;
  }

  setScene(id, { randomizeSeed = true } = {}) {
    const scene = GEN_SCENES[SCENE_INDEX[id]] || GEN_SCENES[0];
    this.params.scene = scene.id;
    this.params.colors = [...scene.colors];
    if (randomizeSeed) this.params.seed = Math.random();
  }

  nextScene() {
    const i = (SCENE_INDEX[this.params.scene] + 1) % GEN_SCENES.length;
    this.setScene(GEN_SCENES[i].id);
    return GEN_SCENES[i];
  }

  sceneName() {
    return (GEN_SCENES[SCENE_INDEX[this.params.scene]] || GEN_SCENES[0]).name;
  }

  // render one frame at the given phase (0..1)
  tick(phase) {
    const gl = this.gl;
    if (!gl) return;
    const p = this.params;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.uniform2f(this.u.u_res, this.canvas.width, this.canvas.height);
    gl.uniform1f(this.u.u_phase, phase % 1);
    gl.uniform1f(this.u.u_scale, p.scale);
    gl.uniform1f(this.u.u_seed, p.seed);
    gl.uniform1i(this.u.u_scene, SCENE_INDEX[p.scene] ?? 0);
    const flat = new Float32Array(18);
    const n = Math.min(6, p.colors.length);
    for (let i = 0; i < n; i++) {
      const [r, g, b] = hexToRgb(p.colors[i]);
      flat[i * 3] = r / 255;
      flat[i * 3 + 1] = g / 255;
      flat[i * 3 + 2] = b / 255;
    }
    gl.uniform3fv(this.u.u_colors, flat);
    gl.uniform1i(this.u.u_colorCount, Math.max(2, n));
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
}
