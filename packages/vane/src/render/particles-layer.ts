/**
 * `particles` render mode: animated wind particles, GPU ping-pong.
 *
 * Technique after mapbox/webgl-wind, modernized for WebGL2: particle
 * positions live in an RGBA32F texture (xy = position normalized over the
 * dataset bbox in mercator space, z = last sampled speed). Each frame a
 * fullscreen pass advances every particle by the wind vector (conformal
 * mercator scaling, so meters/second are honored at every latitude), then
 * particles are drawn as points into an offscreen trail texture that fades a
 * little every frame, and the trail is composited onto the map.
 *
 * Requires WebGL2 + EXT_color_buffer_float (rendering to float textures).
 * Trails are cleared while the camera moves; correct trail reprojection
 * during pan/zoom is future work.
 */

import type { CustomLayerInterface, Map as MapLibreMap } from "maplibre-gl";

import type { VaneDataset, Field } from "../dataset.js";
import { buildLut, type Colormap } from "./colormaps.js";
import { assertWebGL2, compileProgram, mercator, projectionMatrix } from "./gl.js";

const MERC_LAT = `
const float PI = 3.141592653589793;
float mercToLat(float y) {
  return degrees(2.0 * atan(exp(PI * (1.0 - 2.0 * y))) - PI * 0.5);
}`;

const QUAD_VERTEX = `#version 300 es
in vec2 a_uv;
out vec2 v_uv;
void main() {
  v_uv = a_uv;
  gl_Position = vec4(a_uv * 2.0 - 1.0, 0.0, 1.0);
}`;

const UPDATE_FRAGMENT = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_state;
uniform sampler2D u_wind; // RG16F: u (east), v (north) in m/s
uniform vec4 u_merc;      // bbox mercator nw.xy .. se.xy
uniform vec4 u_bbox;      // degrees w, s, e, n
uniform float u_dt;       // animation seconds advanced this frame
uniform float u_rand;
uniform float u_drop;
uniform float u_dropSpeed;
out vec4 outState;
${MERC_LAT}
const float WORLD_METERS = 40075016.686; // mercator world width at equator

float rand(vec2 co) {
  return fract(sin(dot(co, vec2(12.9898, 78.233))) * 43758.5453);
}

void main() {
  vec2 pos = texture(u_state, v_uv).rg;
  vec2 merc = mix(u_merc.xy, u_merc.zw, pos);
  float lat = mercToLat(merc.y);
  float lon = merc.x * 360.0 - 180.0;
  vec2 uv = vec2((lon - u_bbox.x) / (u_bbox.z - u_bbox.x),
                 (u_bbox.w - lat) / (u_bbox.w - u_bbox.y));
  vec2 wind = texture(u_wind, uv).rg;
  if (!(wind.x == wind.x)) wind = vec2(0.0);
  float speed = length(wind);

  // meters -> mercator units; mercator is conformal so one factor for x & y
  float scale = u_dt / (WORLD_METERS * cos(radians(lat)));
  vec2 delta = vec2(wind.x, -wind.y) * scale;
  vec2 newPos = pos + delta / (u_merc.zw - u_merc.xy);

  vec2 seed = (pos + v_uv) * u_rand;
  bool outside = any(lessThan(newPos, vec2(0.0))) || any(greaterThan(newPos, vec2(1.0)));
  if (outside || rand(seed) < u_drop + speed * u_dropSpeed) {
    newPos = vec2(rand(seed + 1.3), rand(seed + 2.1));
    speed = 0.0;
  }
  outState = vec4(newPos, speed, 1.0);
}`;

const DRAW_VERTEX = `#version 300 es
precision highp float;
uniform sampler2D u_state;
uniform mat4 u_matrix;
uniform vec4 u_merc;
uniform float u_size;
uniform int u_res;
out float v_speed;
void main() {
  ivec2 coord = ivec2(gl_VertexID % u_res, gl_VertexID / u_res);
  vec4 state = texelFetch(u_state, coord, 0);
  vec2 merc = mix(u_merc.xy, u_merc.zw, state.rg);
  v_speed = state.b;
  gl_Position = u_matrix * vec4(merc, 0.0, 1.0);
  gl_PointSize = u_size;
}`;

const DRAW_FRAGMENT = `#version 300 es
precision highp float;
in float v_speed;
uniform sampler2D u_lut;
uniform vec2 u_speedRange;
out vec4 fragColor;
void main() {
  vec2 d = gl_PointCoord - 0.5;
  if (dot(d, d) > 0.25) discard; // round points
  float t = clamp((v_speed - u_speedRange.x) / (u_speedRange.y - u_speedRange.x), 0.0, 1.0);
  vec4 color = texture(u_lut, vec2(t, 0.5));
  fragColor = vec4(color.rgb * color.a, color.a); // premultiplied
}`;

const BLIT_FRAGMENT = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_texture;
uniform float u_alpha;
out vec4 fragColor;
void main() {
  fragColor = texture(u_texture, v_uv) * u_alpha;
}`;

export interface ParticlesLayerOptions {
  id: string;
  dataset: VaneDataset;
  /** Vector group name (e.g. "wind") — resolves the u/v variable pair. */
  variable?: string;
  timestep?: number;
  /** Particle count is the square of this (default 128 -> 16384). */
  resolution?: number;
  /** Wind seconds simulated per real second (default 900: 15 min/s). */
  timeScale?: number;
  /** Speed range (m/s) mapped over the colormap. */
  speedRange?: [number, number];
  colormap?: Colormap;
  opacity?: number;
  /** Per-frame trail retention (0..1, default 0.96). */
  fade?: number;
  particleSize?: number;
}

export class ParticlesLayer implements CustomLayerInterface {
  readonly id: string;
  readonly type = "custom" as const;
  readonly renderingMode = "2d" as const;

  private readonly dataset: VaneDataset;
  private readonly group: string;
  private readonly res: number;
  private readonly timeScale: number;
  private readonly speedRange: [number, number];
  private readonly colormap: Colormap;
  private readonly fade: number;
  private readonly particleSize: number;
  private opacity: number;
  private timestep: number;

  private map: MapLibreMap | null = null;
  private gl: WebGL2RenderingContext | null = null;
  private quadVao: WebGLVertexArrayObject | null = null;
  private emptyVao: WebGLVertexArrayObject | null = null;
  private updateProgram: WebGLProgram | null = null;
  private drawProgram: WebGLProgram | null = null;
  private blitProgram: WebGLProgram | null = null;
  private stateTextures: [WebGLTexture, WebGLTexture] | null = null;
  private trailTextures: [WebGLTexture, WebGLTexture] | null = null;
  private trailSize: [number, number] = [0, 0];
  private windTexture: WebGLTexture | null = null;
  private lutTexture: WebGLTexture | null = null;
  private framebuffer: WebGLFramebuffer | null = null;
  private windReady = false;
  private trailsValid = false;
  private lastFrame = 0;
  private loadGeneration = 0;
  private readonly clearTrails = () => {
    this.trailsValid = false;
  };

  constructor(options: ParticlesLayerOptions) {
    this.id = options.id;
    this.dataset = options.dataset;
    this.group = options.variable ?? "wind";
    this.timestep = options.timestep ?? 0;
    this.res = options.resolution ?? 128;
    this.timeScale = options.timeScale ?? 900;
    this.speedRange = options.speedRange ?? [0, 20];
    this.colormap = options.colormap ?? "viridis";
    this.opacity = options.opacity ?? 0.9;
    this.fade = options.fade ?? 0.96;
    this.particleSize = options.particleSize ?? 1.6;
  }

  onAdd(map: MapLibreMap, gl_: WebGLRenderingContext | WebGL2RenderingContext): void {
    this.map = map;
    const gl = (this.gl = assertWebGL2(gl_));
    if (!gl.getExtension("EXT_color_buffer_float")) {
      throw new Error("particles mode requires EXT_color_buffer_float");
    }

    this.updateProgram = compileProgram(gl, QUAD_VERTEX, UPDATE_FRAGMENT);
    this.drawProgram = compileProgram(gl, DRAW_VERTEX, DRAW_FRAGMENT);
    this.blitProgram = compileProgram(gl, QUAD_VERTEX, BLIT_FRAGMENT);
    this.framebuffer = gl.createFramebuffer();

    // Shared unit quad for update/blit passes.
    this.quadVao = gl.createVertexArray();
    gl.bindVertexArray(this.quadVao);
    const quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([0, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1, 1]),
      gl.STATIC_DRAW,
    );
    for (const program of [this.updateProgram, this.blitProgram]) {
      const aUv = gl.getAttribLocation(program, "a_uv");
      gl.enableVertexAttribArray(aUv);
      gl.vertexAttribPointer(aUv, 2, gl.FLOAT, false, 0, 0);
    }
    gl.bindVertexArray(null);
    // Particle draw uses gl_VertexID only; still needs a bound VAO.
    this.emptyVao = gl.createVertexArray();

    // Particle state: random start positions, speed 0.
    const initial = new Float32Array(this.res * this.res * 4);
    for (let i = 0; i < this.res * this.res; i++) {
      initial[i * 4] = Math.random();
      initial[i * 4 + 1] = Math.random();
    }
    this.stateTextures = [
      this.createStateTexture(gl, initial),
      this.createStateTexture(gl, initial),
    ];

    this.lutTexture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.lutTexture);
    gl.texImage2D(
      gl.TEXTURE_2D, 0, gl.RGBA, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
      buildLut(this.colormap, [0, 1]),
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);

    this.windTexture = gl.createTexture();
    void this.loadTimestep(this.timestep);

    map.on("move", this.clearTrails);
  }

  onRemove(): void {
    this.map?.off("move", this.clearTrails);
    const gl = this.gl;
    if (gl) {
      for (const p of [this.updateProgram, this.drawProgram, this.blitProgram]) {
        if (p) gl.deleteProgram(p);
      }
      for (const t of [
        ...(this.stateTextures ?? []),
        ...(this.trailTextures ?? []),
        this.windTexture,
        this.lutTexture,
      ]) {
        if (t) gl.deleteTexture(t);
      }
      if (this.framebuffer) gl.deleteFramebuffer(this.framebuffer);
      if (this.quadVao) gl.deleteVertexArray(this.quadVao);
      if (this.emptyVao) gl.deleteVertexArray(this.emptyVao);
    }
    this.gl = null;
    this.map = null;
    this.stateTextures = null;
    this.trailTextures = null;
    this.windTexture = null;
    this.lutTexture = null;
    this.windReady = false;
  }

  setTimestep(timestep: number): void {
    this.timestep = timestep;
    void this.loadTimestep(timestep);
  }

  setOpacity(opacity: number): void {
    this.opacity = opacity;
    this.map?.triggerRepaint();
  }

  private async loadTimestep(timestep: number): Promise<void> {
    const generation = ++this.loadGeneration;
    const { u, v } = this.dataset.vectorGroup(this.group);
    const [uField, vField] = await Promise.all([
      this.dataset.getField(u, timestep),
      this.dataset.getField(v, timestep),
    ]);
    if (generation !== this.loadGeneration || !this.gl || !this.windTexture) return;
    this.uploadWind(this.gl, uField, vField);
    this.windReady = true;
    this.map?.triggerRepaint();
  }

  private uploadWind(gl: WebGL2RenderingContext, u: Field, v: Field): void {
    const { width, height } = u;
    const data = new Float32Array(width * height * 2);
    for (let i = 0; i < width * height; i++) {
      const ru = u.data[i]!;
      const rv = v.data[i]!;
      data[i * 2] = ru === u.nodata ? 0 : ru * u.scale + u.offset;
      data[i * 2 + 1] = rv === v.nodata ? 0 : rv * v.scale + v.offset;
    }
    gl.bindTexture(gl.TEXTURE_2D, this.windTexture);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG16F, width, height, 0, gl.RG, gl.FLOAT, data);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  private createStateTexture(gl: WebGL2RenderingContext, data: Float32Array): WebGLTexture {
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, this.res, this.res, 0, gl.RGBA, gl.FLOAT, data);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return texture;
  }

  private ensureTrailTextures(gl: WebGL2RenderingContext): void {
    const width = gl.drawingBufferWidth;
    const height = gl.drawingBufferHeight;
    if (this.trailTextures && this.trailSize[0] === width && this.trailSize[1] === height) {
      return;
    }
    for (const t of this.trailTextures ?? []) gl.deleteTexture(t);
    const make = () => {
      const texture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return texture;
    };
    this.trailTextures = [make(), make()];
    this.trailSize = [width, height];
    this.trailsValid = false;
  }

  prerender(gl_: WebGLRenderingContext | WebGL2RenderingContext, matrixOrOptions: unknown): void {
    const gl = this.gl;
    if (!gl || !this.windReady || !this.stateTextures || !this.framebuffer) return;

    const now = performance.now();
    const frameSeconds = this.lastFrame ? Math.min((now - this.lastFrame) / 1000, 0.1) : 1 / 60;
    this.lastFrame = now;

    const savedViewport = gl.getParameter(gl.VIEWPORT) as Int32Array;
    this.ensureTrailTextures(gl);

    const [west, south, east, north] = this.dataset.meta.bbox;
    const [x0, y0] = mercator(west, north);
    const [x1, y1] = mercator(east, south);

    // Pass 1 — advance particle state (ping-pong).
    const [src, dst] = this.stateTextures;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, dst, 0);
    gl.viewport(0, 0, this.res, this.res);
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
    gl.useProgram(this.updateProgram!);
    gl.bindVertexArray(this.quadVao);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, src);
    gl.uniform1i(gl.getUniformLocation(this.updateProgram!, "u_state"), 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.windTexture);
    gl.uniform1i(gl.getUniformLocation(this.updateProgram!, "u_wind"), 1);
    gl.uniform4f(gl.getUniformLocation(this.updateProgram!, "u_merc"), x0, y0, x1, y1);
    gl.uniform4f(gl.getUniformLocation(this.updateProgram!, "u_bbox"), west, south, east, north);
    gl.uniform1f(gl.getUniformLocation(this.updateProgram!, "u_dt"), frameSeconds * this.timeScale);
    gl.uniform1f(gl.getUniformLocation(this.updateProgram!, "u_rand"), Math.random() * 100 + 1);
    gl.uniform1f(gl.getUniformLocation(this.updateProgram!, "u_drop"), 0.003);
    gl.uniform1f(gl.getUniformLocation(this.updateProgram!, "u_dropSpeed"), 0.00015);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    this.stateTextures = [dst, src];

    // Pass 2 — trail texture: previous trail (faded) + fresh particles.
    const [trailPrev, trailNext] = this.trailTextures!;
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, trailNext, 0);
    gl.viewport(0, 0, this.trailSize[0], this.trailSize[1]);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    if (this.trailsValid) {
      gl.useProgram(this.blitProgram!);
      gl.bindVertexArray(this.quadVao);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, trailPrev);
      gl.uniform1i(gl.getUniformLocation(this.blitProgram!, "u_texture"), 0);
      gl.uniform1f(gl.getUniformLocation(this.blitProgram!, "u_alpha"), this.fade);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    }

    gl.useProgram(this.drawProgram!);
    gl.bindVertexArray(this.emptyVao);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.stateTextures[0]);
    gl.uniform1i(gl.getUniformLocation(this.drawProgram!, "u_state"), 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.lutTexture);
    gl.uniform1i(gl.getUniformLocation(this.drawProgram!, "u_lut"), 1);
    gl.uniformMatrix4fv(
      gl.getUniformLocation(this.drawProgram!, "u_matrix"),
      false,
      projectionMatrix(matrixOrOptions),
    );
    gl.uniform4f(gl.getUniformLocation(this.drawProgram!, "u_merc"), x0, y0, x1, y1);
    gl.uniform1f(
      gl.getUniformLocation(this.drawProgram!, "u_size"),
      this.particleSize * (globalThis.devicePixelRatio ?? 1),
    );
    gl.uniform1i(gl.getUniformLocation(this.drawProgram!, "u_res"), this.res);
    gl.uniform2f(
      gl.getUniformLocation(this.drawProgram!, "u_speedRange"),
      this.speedRange[0],
      this.speedRange[1],
    );
    gl.drawArrays(gl.POINTS, 0, this.res * this.res);

    this.trailTextures = [trailNext, trailPrev];
    this.trailsValid = true;

    gl.bindVertexArray(null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(savedViewport[0]!, savedViewport[1]!, savedViewport[2]!, savedViewport[3]!);
  }

  render(): void {
    const gl = this.gl;
    if (!gl || !this.windReady || !this.trailTextures || !this.trailsValid) return;

    gl.useProgram(this.blitProgram!);
    gl.bindVertexArray(this.quadVao);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.trailTextures[0]);
    gl.uniform1i(gl.getUniformLocation(this.blitProgram!, "u_texture"), 0);
    gl.uniform1f(gl.getUniformLocation(this.blitProgram!, "u_alpha"), this.opacity);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.disable(gl.DEPTH_TEST);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.bindVertexArray(null);

    // Continuous animation.
    this.map?.triggerRepaint();
  }
}
