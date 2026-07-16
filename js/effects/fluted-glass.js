// Deterministic, source-sampling fluted-glass Post FX.
//
// The optical model follows the July 2026 teardown of the reference plate
// (indicium.ai): rigid ribs, an orthographic incident ray, and pure
// refraction with no painted rib lighting — the glass character comes from
// the artwork being compressed at the flute edges, and the animation is the
// content drifting behind static glass rather than the glass bending.
//
// This module is deliberately lazy: importing it does not create a canvas or
// request a WebGL context. The singleton is allocated only when the effect is
// enabled, and callers receive their original source on every unsupported or
// recoverable failure path.

const MIN_RIBS = 24;
const MAX_RIBS = 50;
const PORTRAIT_ASPECT = 9 / 16;
const LANDSCAPE_ASPECT = 16 / 9;
const BYTES_PER_PIXEL = 12; // RGBA source texture + double-buffered RGBA output.
const NO_SOURCE_KEY = Symbol('no fluted-glass source key');

const VERTEX_SHADER = `#version 300 es
out vec2 v_uv;

void main() {
  vec2 position = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  v_uv = position;
  gl_Position = vec4(position * 2.0 - 1.0, 0.0, 1.0);
}`;

const FRAGMENT_SHADER = `#version 300 es
precision highp float;

in vec2 v_uv;
out vec4 outColor;

uniform sampler2D u_source;
uniform vec2 u_resolution;
uniform float u_phase;
uniform float u_intensity;
uniform float u_ribCount;

#define TAU 6.283185307179586

void main() {
  vec2 uv = clamp(v_uv, 0.0, 1.0);
  float amount = clamp(u_intensity, 0.0, 1.0);
  float aspect = u_resolution.x / max(u_resolution.y, 1.0);

  // Real fluted glass never bends: the reference plate keeps its ribs rigid
  // and lets the field behind them flow. The motion is a divergence-free
  // drift of the content — the perpendicular gradient of a stream function
  // built from three traveling plane waves, so the artwork swirls without
  // stretching. Integer temporal cycles keep the renderer random-access:
  // the same source, settings, and phase always produce the same frame, and
  // phase 1 is exactly phase 0 for deterministic GIF/video export.
  vec2 p = vec2(uv.x * aspect, uv.y);
  float w0 = TAU * (dot(p, vec2( 0.9,  1.4)) + u_phase) + 1.07;
  float w1 = TAU * (dot(p, vec2(-1.3,  0.8)) - u_phase) + 3.84;
  float w2 = TAU * (dot(p, vec2( 0.6, -1.1)) + 2.0 * u_phase) + 5.51;
  vec2 swirl = vec2( 1.4, -0.9) * cos(w0)
             + vec2( 0.8,  1.3) * cos(w1)
             + vec2(-1.1, -0.6) * cos(w2);
  vec2 drift = (0.0028 * amount) * swirl / vec2(max(aspect, 0.001), 1.0);

  // Rigid ribs with a circular cross-section (squircle exponent 2, IOR 1.3 —
  // the reference material), lit by nothing: the streaks and seams emerge
  // from refraction compressing the artwork, not from painted shading.
  float rib = uv.x * u_ribCount;
  float cylinderX = fract(rib + 0.5) * 2.0 - 1.0;
  float cylinderZ = sqrt(max(1.0 - cylinderX * cylinderX, 0.001));
  vec3 normal = normalize(vec3(cylinderX, 0.0, cylinderZ));
  // Orthographic incident ray: every flute refracts identically across the
  // image and the ray gains no vertical component.
  vec3 ray = refract(vec3(0.0, 0.0, -1.0), normal, 1.0 / 1.3);

  float refraction = mix(0.008, 0.055, amount);
  vec2 refractedUv = clamp(
    uv + drift + vec2(ray.x * refraction, 0.0),
    vec2(0.001),
    vec2(0.999)
  );

  vec4 base = texture(u_source, uv);
  vec4 refracted = texture(u_source, refractedUv);

  // Alpha follows the same optical sampling as color. At partial intensity it
  // transitions from the untouched source alpha rather than forcing opacity.
  float alpha = mix(base.a, refracted.a, amount);
  vec3 rgb = mix(base.rgb, refracted.rgb, amount);
  outColor = vec4(max(rgb, vec3(0.0)), alpha);
}`;

function finiteDimension(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
}

function clamp01(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.min(1, Math.max(0, number));
}

/** Normalize any finite phase to [0, 1), making 0 and 1 exactly identical. */
export function normalizeFlutedGlassPhase(phase) {
  const number = Number(phase);
  if (!Number.isFinite(number)) return 0;
  const wrapped = number - Math.floor(number);
  return Object.is(wrapped, -0) ? 0 : wrapped;
}

/**
 * Choose a stable rib count from image shape alone. Resolution changes do not
 * alter the composition, so preview and export retain the same optical plate.
 */
export function flutedRibCount(width, height) {
  const w = finiteDimension(width);
  const h = finiteDimension(height);
  if (!w || !h) return MIN_RIBS;
  const aspect = w / h;
  const position = Math.min(1, Math.max(0,
    (aspect - PORTRAIT_ASPECT) / (LANDSCAPE_ASPECT - PORTRAIT_ASPECT),
  ));
  return Math.round(MIN_RIBS + (MAX_RIBS - MIN_RIBS) * position);
}

/** Conservative persistent GPU backing-store estimate for an active stage. */
export function estimateFlutedGlassBytes(width, height) {
  const w = finiteDimension(width);
  const h = finiteDimension(height);
  return w && h ? w * h * BYTES_PER_PIXEL : 0;
}

function defaultCanvasFactory() {
  if (typeof document === 'undefined' || typeof document.createElement !== 'function') return null;
  return document.createElement('canvas');
}

function compileShader(gl, type, source) {
  const shader = gl.createShader(type);
  if (!shader) throw new Error('Could not create fluted-glass shader');
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const message = gl.getShaderInfoLog(shader) || 'unknown shader error';
    gl.deleteShader(shader);
    throw new Error(`Fluted-glass shader failed: ${message}`);
  }
  return shader;
}

function createProgram(gl) {
  const vertex = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
  const fragment = compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
  const program = gl.createProgram();
  if (!program) {
    gl.deleteShader(vertex);
    gl.deleteShader(fragment);
    throw new Error('Could not create fluted-glass program');
  }
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const message = gl.getProgramInfoLog(program) || 'unknown link error';
    gl.deleteProgram(program);
    throw new Error(`Fluted-glass program failed: ${message}`);
  }
  return program;
}

/**
 * Reusable renderer. Prefer the module-level renderFlutedGlass() in app code;
 * the class is exported for isolated ownership and deterministic tests.
 */
export class FlutedGlassRenderer {
  constructor({ createCanvas = defaultCanvasFactory } = {}) {
    this.canvas = null;
    this.gl = null;
    this.program = null;
    this.sourceTexture = null;
    this.uniforms = null;
    this.textureWidth = 0;
    this.textureHeight = 0;
    this.lastSourceKey = NO_SOURCE_KEY;
    this.lost = false;
    this.released = false;

    this._onContextLost = (event) => {
      event?.preventDefault?.();
      this.lost = true;
      this.lastSourceKey = NO_SOURCE_KEY;
    };
    this._onContextRestored = () => {
      if (this.released) return;
      this.gl = null;
      this.program = null;
      this.sourceTexture = null;
      this.uniforms = null;
      this.textureWidth = 0;
      this.textureHeight = 0;
      this.lastSourceKey = NO_SOURCE_KEY;
      this.lost = !this._initializeContext();
    };

    try {
      this.canvas = createCanvas?.() || null;
      this.canvas?.addEventListener?.('webglcontextlost', this._onContextLost);
      this.canvas?.addEventListener?.('webglcontextrestored', this._onContextRestored);
      this.lost = !this._initializeContext();
    } catch {
      this.lost = true;
    }
  }

  _initializeContext() {
    if (!this.canvas || this.released) return false;
    const gl = this.canvas.getContext?.('webgl2', {
      alpha: true,
      antialias: false,
      depth: false,
      stencil: false,
      // The shader emits straight RGB + alpha, matching Ditherlab's primary
      // WebGL renderer and avoiding bright fringes when transparent results
      // are copied through Canvas2D or exported as PNG.
      premultipliedAlpha: false,
      preserveDrawingBuffer: false,
      powerPreference: 'high-performance',
    });
    if (!gl) return false;

    let program = null;
    let texture = null;
    try {
      program = createProgram(gl);
      texture = gl.createTexture();
      if (!texture) throw new Error('Could not create fluted-glass source texture');

      this.gl = gl;
      this.program = program;
      this.sourceTexture = texture;
      this.uniforms = {
        source: gl.getUniformLocation(program, 'u_source'),
        resolution: gl.getUniformLocation(program, 'u_resolution'),
        phase: gl.getUniformLocation(program, 'u_phase'),
        intensity: gl.getUniformLocation(program, 'u_intensity'),
        ribCount: gl.getUniformLocation(program, 'u_ribCount'),
      };

      gl.useProgram(program);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.uniform1i(this.uniforms.source, 0);
      gl.disable(gl.BLEND);
      return true;
    } catch {
      if (texture) gl.deleteTexture?.(texture);
      if (program) gl.deleteProgram?.(program);
      this.gl = null;
      this.program = null;
      this.sourceTexture = null;
      this.uniforms = null;
      return false;
    }
  }

  isSupported() {
    return !!this.gl && !this.lost && !this.released && !this.gl.isContextLost?.();
  }

  render(source, { phase = 0, intensity = 0, sourceKey = null } = {}) {
    const amount = clamp01(intensity);
    if (!source || amount <= 0 || !this.isSupported()) return source;

    const width = finiteDimension(source.width);
    const height = finiteDimension(source.height);
    if (!width || !height) return source;

    const gl = this.gl;
    try {
      if (this.canvas.width !== width || this.canvas.height !== height) {
        this.canvas.width = width;
        this.canvas.height = height;
      }

      gl.useProgram(this.program);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.sourceTexture);

      const resized = this.textureWidth !== width || this.textureHeight !== height;
      if (resized) {
        gl.texImage2D(
          gl.TEXTURE_2D,
          0,
          gl.RGBA8,
          width,
          height,
          0,
          gl.RGBA,
          gl.UNSIGNED_BYTE,
          null,
        );
        this.textureWidth = width;
        this.textureHeight = height;
        this.lastSourceKey = NO_SOURCE_KEY;
      }

      const cacheEnabled = sourceKey !== null;
      if (!cacheEnabled || !Object.is(sourceKey, this.lastSourceKey)) {
        gl.texSubImage2D(
          gl.TEXTURE_2D,
          0,
          0,
          0,
          gl.RGBA,
          gl.UNSIGNED_BYTE,
          source,
        );
        this.lastSourceKey = cacheEnabled ? sourceKey : NO_SOURCE_KEY;
      }

      gl.viewport(0, 0, width, height);
      gl.uniform2f(this.uniforms.resolution, width, height);
      gl.uniform1f(this.uniforms.phase, normalizeFlutedGlassPhase(phase));
      gl.uniform1f(this.uniforms.intensity, amount);
      gl.uniform1f(this.uniforms.ribCount, flutedRibCount(width, height));
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      return this.canvas;
    } catch {
      // Tainted sources, context races, and driver failures must never replace
      // a valid frame with a blank effect canvas.
      this.lastSourceKey = NO_SOURCE_KEY;
      if (gl.isContextLost?.()) this.lost = true;
      return source;
    }
  }

  release() {
    if (this.released) return;
    this.released = true;
    this.canvas?.removeEventListener?.('webglcontextlost', this._onContextLost);
    this.canvas?.removeEventListener?.('webglcontextrestored', this._onContextRestored);
    if (this.gl && !this.gl.isContextLost?.()) {
      if (this.sourceTexture) this.gl.deleteTexture?.(this.sourceTexture);
      if (this.program) this.gl.deleteProgram?.(this.program);
    }
    if (this.canvas) {
      this.canvas.width = 0;
      this.canvas.height = 0;
    }
    this.gl = null;
    this.program = null;
    this.sourceTexture = null;
    this.uniforms = null;
    this.textureWidth = 0;
    this.textureHeight = 0;
    this.lastSourceKey = NO_SOURCE_KEY;
    this.lost = true;
  }
}

let sharedRenderer = null;

function getSharedRenderer() {
  if (!sharedRenderer) sharedRenderer = new FlutedGlassRenderer();
  return sharedRenderer;
}

/**
 * Apply fluted glass to a canvas. The returned effect canvas is reusable and
 * remains owned by this module; callers that retain it must copy it first.
 */
export function renderFlutedGlass(source, options = {}) {
  if (!source || clamp01(options.intensity) <= 0) return source;
  return getSharedRenderer().render(source, options);
}

/** Lazily report whether the shared WebGL2 stage can render. */
export function isFlutedGlassSupported() {
  return getSharedRenderer().isSupported();
}

/** Release the shared canvas, texture, and program. Safe to call repeatedly. */
export function releaseFlutedGlass() {
  sharedRenderer?.release();
  sharedRenderer = null;
}
