/**
 * `particles` render mode: animated wind particles, GPU ping-pong.
 *
 * Technique after mapbox/webgl-wind, modernized for WebGL2 and made
 * viewport-relative so it behaves on a slippy map at any zoom and for any
 * dataset extent (national grid or whole planet).
 *
 * **Screen-space state.** Particle positions live in an RGBA32F texture as
 * **viewport-normalized** [0,1] coordinates (x right, y down over the current
 * map view) — i.e. screen space; `z` = last sampled speed, `w` = alive flag.
 * Each frame a fullscreen pass un-normalizes each particle to world mercator
 * through the live view bounds, samples the wind there, and advances it.
 * Because positions are already screen space, the draw pass maps them
 * **straight to clip space** — no projection matrix, so it stays exact when
 * zoomed in (an absolute-mercator `mix()` loses float precision at high zoom
 * and collapses particles onto a grid of dots).
 *
 * **Constant on-screen density.** Particles are seeded uniformly across the
 * whole viewport; any that fall off the dataset are hidden (culled in the
 * draw pass) rather than drawn. So the density over the data is constant per
 * screen-area at every zoom and for every source — a global grid zoomed into
 * one country isn't sparse, a national grid isn't overpacked, and a regional
 * grid shows particles only where it has data, at the same density as
 * elsewhere (like Windy).
 *
 * **Wind-proportional, zoom-invariant speed.** Particles advance a pixel
 * velocity proportional to the wind magnitude (`speedScale` px/s per m/s),
 * divided by the canvas size — so a given wind looks equally fast at every
 * zoom, and stronger wind visibly moves faster. Mercator is north-aligned and
 * conformal, so `(u, -v)` is the correct screen direction at every latitude.
 *
 * **Continuous time.** Two adjacent timesteps are kept resident and the wind
 * is mixed by a `frac` in [0,1]; `setTimestep` takes a fractional step and
 * only refetches when the integer bracket changes, so a sliding time control
 * flows instead of snapping.
 *
 * Requires WebGL2 + EXT_color_buffer_float (rendering to float textures).
 * Trails are cleared while the camera moves; correct trail reprojection
 * during pan/zoom is future work.
 */

import type { CustomLayerInterface, Map as MapLibreMap } from "maplibre-gl";

import type { VaneDataset, Field } from "../dataset.js";
import { buildLut, type Colormap } from "./colormaps.js";
import { assertWebGL2, compileProgram, mercator } from "./gl.js";

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
uniform sampler2D u_wind0;  // RG16F: u (east), v (north) in m/s at step t0
uniform sampler2D u_wind1;  // ... at step t1
uniform float u_frac;       // wind = mix(t0, t1, frac)
uniform vec4 u_view;        // view world-merc bounds: minX, minY(n), maxX, maxY(s)
uniform vec4 u_bbox;        // dataset degrees w, s, e, n
uniform vec2 u_viewportPx;  // drawing-buffer size (px), to equalize x/y speed
uniform float u_speedScale; // on-screen px/sec per (m/s)
uniform float u_dt;         // real seconds this frame
uniform float u_rand;
uniform float u_drop;
uniform float u_dropSpeed;
out vec4 outState;
${MERC_LAT}

float rand(vec2 co) {
  return fract(sin(dot(co, vec2(12.9898, 78.233))) * 43758.5453);
}

// Interpolated wind (m/s) at a viewport-normalized position: .xy = wind,
// .z = 1.0 when the position falls on the dataset, else 0.0 (off-data).
vec3 sampleWind(vec2 p) {
  vec2 merc = mix(u_view.xy, u_view.zw, p);
  float lat = mercToLat(merc.y);
  float lon = merc.x * 360.0 - 180.0;
  vec2 uv = vec2((lon - u_bbox.x) / (u_bbox.z - u_bbox.x),
                 (u_bbox.w - lat) / (u_bbox.w - u_bbox.y));
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) return vec3(0.0);
  vec2 wind = mix(texture(u_wind0, uv).rg, texture(u_wind1, uv).rg, u_frac);
  if (!(wind.x == wind.x)) return vec3(0.0); // NaN = nodata
  return vec3(wind, 1.0);
}

void main() {
  vec2 pos = texture(u_state, v_uv).rg;
  vec3 w = sampleWind(pos);
  float speed = length(w.xy);

  // Pixel velocity ∝ wind magnitude, zoom-invariant (viewport px are constant
  // across zoom); divide by the canvas size so equal m/s look equally fast on
  // both axes. Advance in normalized space so the step never underflows.
  vec2 newPos = pos + vec2(w.x, -w.y) * u_speedScale * u_dt / u_viewportPx;

  vec2 seed = (pos + v_uv) * u_rand;
  bool respawn = w.z < 0.5
    || any(lessThan(newPos, vec2(0.0))) || any(greaterThan(newPos, vec2(1.0)))
    || rand(seed) < u_drop + speed * u_dropSpeed;
  if (respawn) {
    // Uniform over the whole viewport → constant on-screen density; particles
    // that land off-data are hidden in the draw pass (Windy-style).
    newPos = vec2(rand(seed + 1.3), rand(seed + 2.1));
  }

  // Data membership + speed at the *final* position (moved or respawned) so the
  // stored color is right and off-data particles are culled when drawn.
  vec3 wn = sampleWind(newPos);
  outState = vec4(newPos, length(wn.xy), wn.z);
}`;

const DRAW_VERTEX = `#version 300 es
precision highp float;
in float a_index; // bound to attrib 0: attribute-less draws force slow paths
uniform sampler2D u_state;
uniform float u_size;
uniform int u_res;
uniform float u_keep; // fraction of particles to draw (thin out when over-zoomed)
out float v_speed;
float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
void main() {
  int index = int(a_index);
  ivec2 coord = ivec2(index % u_res, index / u_res);
  // Stable per-particle thinning: zoom past the data's resolution and a global
  // grid is one near-uniform cell, so full density is just a solid mass — keep
  // a fixed subset (no flicker) so the field thins to bright streaks instead.
  if (hash(vec2(coord)) >= u_keep) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    gl_PointSize = 0.0;
    return;
  }
  vec4 state = texelFetch(u_state, coord, 0);
  if (state.a < 0.5) { // off-data: cull off-screen
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    gl_PointSize = 0.0;
    return;
  }
  v_speed = state.b;
  // State is viewport-normalized [0,1] (x right, y down) = screen space, so map
  // straight to clip space — no projection matrix, exact at any zoom.
  gl_Position = vec4(state.r * 2.0 - 1.0, 1.0 - state.g * 2.0, 0.0, 1.0);
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

/** Default particle ramp: silver to white, speed shows as brightness.
 *  Chosen for visibility — dark scientific ramps (viridis etc.) disappear
 *  at low speeds on dark basemaps. NB: colormap stops for this layer span
 *  the normalized [0,1] speed domain (see `speedRange`), not m/s. */
const DEFAULT_PARTICLE_COLORMAP: Colormap = [
  [0, "#cbd5e1b3"],
  [0.6, "#f8fafcd9"],
  [1, "#ffffffff"],
];

export interface ParticlesLayerOptions {
  id: string;
  dataset: VaneDataset;
  /** Vector group name (e.g. "wind") — resolves the u/v variable pair. */
  variable?: string;
  /** May be fractional — the wind field interpolates between steps. */
  timestep?: number;
  /** Particle count is the square of this. Coverage-independent now that
   *  seeding is viewport-relative (default 72, or 52 on coarse-pointer/touch
   *  devices to keep phones smooth). */
  resolution?: number;
  /** On-screen pixels/second per (m/s) of wind. Sets how fast the field
   *  flows for a given wind strength; zoom-invariant (default 6). */
  speedScale?: number;
  /** Speed range (m/s) mapped over the colormap. */
  speedRange?: [number, number];
  /** Stops span the normalized [0,1] speed domain, not m/s. */
  colormap?: Colormap;
  opacity?: number;
  /** Per-frame trail retention (0..1, default 0.95). */
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
  private readonly speedScale: number;
  private readonly speedRange: [number, number];
  private readonly colormap: Colormap;
  private readonly fade: number;
  private readonly particleSize: number;
  private opacity: number;
  private timestep: number;

  private map: MapLibreMap | null = null;
  private gl: WebGL2RenderingContext | null = null;
  private quadVao: WebGLVertexArrayObject | null = null;
  private indexVao: WebGLVertexArrayObject | null = null;
  private updateProgram: WebGLProgram | null = null;
  private drawProgram: WebGLProgram | null = null;
  private blitProgram: WebGLProgram | null = null;
  private stateTextures: [WebGLTexture, WebGLTexture] | null = null;
  private trailTextures: [WebGLTexture, WebGLTexture] | null = null;
  private trailSize: [number, number] = [0, 0];
  /** Two resident wind timesteps; the update shader mixes them by `frac`. */
  private windTextures: [WebGLTexture, WebGLTexture] | null = null;
  private lutTexture: WebGLTexture | null = null;
  private framebuffer: WebGLFramebuffer | null = null;
  private windReady = false;
  private trailsValid = false;
  private lastFrame = 0;
  private loadGeneration = 0;
  private loaded: [number, number] = [-1, -1];
  private frac = 0;
  /** Wind grid dimensions (px) — for the over-zoom thinning factor. */
  private gridWidth = 0;
  private readonly clearTrails = () => {
    this.trailsValid = false;
  };

  constructor(options: ParticlesLayerOptions) {
    this.id = options.id;
    this.dataset = options.dataset;
    this.group = options.variable ?? "wind";
    this.timestep = options.timestep ?? 0;
    const coarse =
      typeof matchMedia !== "undefined" &&
      matchMedia("(pointer: coarse)").matches;
    this.res = options.resolution ?? (coarse ? 52 : 72);
    this.speedScale = options.speedScale ?? 6;
    this.speedRange = options.speedRange ?? [0, 20];
    this.colormap = options.colormap ?? DEFAULT_PARTICLE_COLORMAP;
    this.opacity = options.opacity ?? 0.9;
    this.fade = options.fade ?? 0.95;
    this.particleSize = options.particleSize ?? 1.6;
  }

  onAdd(map: MapLibreMap, gl_: WebGLRenderingContext | WebGL2RenderingContext): void {
    this.map = map;
    const gl = (this.gl = assertWebGL2(gl_));
    if (!gl.getExtension("EXT_color_buffer_float")) {
      throw new Error("particles mode requires EXT_color_buffer_float");
    }

    this.updateProgram = compileProgram(gl, QUAD_VERTEX, UPDATE_FRAGMENT, { a_uv: 0 });
    this.drawProgram = compileProgram(gl, DRAW_VERTEX, DRAW_FRAGMENT, { a_index: 0 });
    this.blitProgram = compileProgram(gl, QUAD_VERTEX, BLIT_FRAGMENT, { a_uv: 0 });
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

    // Per-particle index as attrib 0 (attribute-less gl_VertexID draws
    // trigger slow emulation paths on desktop GL, e.g. Firefox on Mac).
    this.indexVao = gl.createVertexArray();
    gl.bindVertexArray(this.indexVao);
    const indexBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, indexBuffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      Float32Array.from({ length: this.res * this.res }, (_, i) => i),
      gl.STATIC_DRAW,
    );
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 1, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);

    // Particle state: random start positions (viewport-normalized), speed 0,
    // dead (alive set on the first sim step so nothing flashes off-data).
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

    this.windTextures = [gl.createTexture(), gl.createTexture()];
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
        ...(this.windTextures ?? []),
        this.lutTexture,
      ]) {
        if (t) gl.deleteTexture(t);
      }
      if (this.framebuffer) gl.deleteFramebuffer(this.framebuffer);
      if (this.quadVao) gl.deleteVertexArray(this.quadVao);
      if (this.indexVao) gl.deleteVertexArray(this.indexVao);
    }
    this.gl = null;
    this.map = null;
    this.stateTextures = null;
    this.trailTextures = null;
    this.windTextures = null;
    this.lutTexture = null;
    this.windReady = false;
    this.loaded = [-1, -1];
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
    const nt = this.dataset.meta.timesteps.length;
    const clamped = Math.min(Math.max(timestep, 0), nt - 1);
    const t0 = Math.floor(clamped);
    const t1 = Math.min(t0 + 1, nt - 1);
    this.frac = t1 === t0 ? 0 : clamped - t0;

    if (this.loaded[0] === t0 && this.loaded[1] === t1) {
      this.map?.triggerRepaint();
      return;
    }

    const generation = ++this.loadGeneration;
    let u0: Field, v0: Field, u1: Field, v1: Field;
    try {
      const { u, v } = this.dataset.vectorGroup(this.group);
      [u0, v0, u1, v1] = await Promise.all([
        this.dataset.getField(u, t0),
        this.dataset.getField(v, t0),
        this.dataset.getField(u, t1),
        this.dataset.getField(v, t1),
      ]);
    } catch (err) {
      // Keep showing the previous frame; a later setTimestep can recover.
      console.error(`vane: ${this.id}: failed to load bracket ${t0}..${t1}:`, err);
      return;
    }
    if (generation !== this.loadGeneration || !this.gl || !this.windTextures) return;
    this.uploadWind(this.gl, this.windTextures[0], u0, v0);
    this.uploadWind(this.gl, this.windTextures[1], u1, v1);
    this.windReady = true;
    this.loaded = [t0, t1];
    this.map?.triggerRepaint();
  }

  private uploadWind(gl: WebGL2RenderingContext, texture: WebGLTexture, u: Field, v: Field): void {
    const { width, height } = u;
    this.gridWidth = width;
    const data = new Float32Array(width * height * 2);
    for (let i = 0; i < width * height; i++) {
      const ru = u.data[i]!;
      const rv = v.data[i]!;
      data[i * 2] = ru === u.nodata ? 0 : ru * u.scale + u.offset;
      data[i * 2 + 1] = rv === v.nodata ? 0 : rv * v.scale + v.offset;
    }
    gl.bindTexture(gl.TEXTURE_2D, texture);
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

  /** Current view rectangle in world mercator (top-left .xy .. bottom-right
   *  .zw) — recomputed each frame; the camera can move between frames. */
  private viewRect(): [number, number, number, number] {
    const bounds = this.map!.getBounds();
    const [x0, y0] = mercator(bounds.getWest(), bounds.getNorth());
    const [x1, y1] = mercator(bounds.getEast(), bounds.getSouth());
    return [x0, y0, x1, y1];
  }

  prerender(gl_: WebGLRenderingContext | WebGL2RenderingContext): void {
    const gl = this.gl;
    if (!gl || !this.windReady || !this.stateTextures || !this.windTextures || !this.framebuffer || !this.map) {
      return;
    }

    const now = performance.now();
    const frameSeconds = this.lastFrame ? Math.min((now - this.lastFrame) / 1000, 0.1) : 1 / 60;
    this.lastFrame = now;

    const savedViewport = gl.getParameter(gl.VIEWPORT) as Int32Array;
    this.ensureTrailTextures(gl);

    const view = this.viewRect();
    const [west, south, east, north] = this.dataset.meta.bbox;

    // Thin the field out when zoomed in past the wind grid's resolution: a
    // coarse (global) grid at city zoom is one near-uniform cell, which full
    // density paints as a solid mass. Full density while ≳ 7 cells span the
    // view; fades to a fifth once a single cell fills it.
    let keep = 1;
    if (this.gridWidth > 1) {
      const cellLon = (east - west) / this.gridWidth;
      const bounds = this.map.getBounds();
      const cellsAcross = Math.abs(bounds.getEast() - bounds.getWest()) / cellLon;
      const t = Math.min(Math.max((cellsAcross - 1.5) / (7 - 1.5), 0), 1);
      keep = 0.2 + 0.8 * (t * t * (3 - 2 * t)); // smoothstep 0.2 .. 1
    }

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
    gl.bindTexture(gl.TEXTURE_2D, this.windTextures[0]);
    gl.uniform1i(gl.getUniformLocation(this.updateProgram!, "u_wind0"), 1);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.windTextures[1]);
    gl.uniform1i(gl.getUniformLocation(this.updateProgram!, "u_wind1"), 2);
    gl.uniform1f(gl.getUniformLocation(this.updateProgram!, "u_frac"), this.frac);
    gl.uniform4f(gl.getUniformLocation(this.updateProgram!, "u_view"), view[0], view[1], view[2], view[3]);
    gl.uniform4f(gl.getUniformLocation(this.updateProgram!, "u_bbox"), west, south, east, north);
    gl.uniform2f(
      gl.getUniformLocation(this.updateProgram!, "u_viewportPx"),
      gl.drawingBufferWidth,
      gl.drawingBufferHeight,
    );
    gl.uniform1f(gl.getUniformLocation(this.updateProgram!, "u_speedScale"), this.speedScale);
    gl.uniform1f(gl.getUniformLocation(this.updateProgram!, "u_dt"), frameSeconds);
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
    gl.bindVertexArray(this.indexVao);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.stateTextures[0]);
    gl.uniform1i(gl.getUniformLocation(this.drawProgram!, "u_state"), 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.lutTexture);
    gl.uniform1i(gl.getUniformLocation(this.drawProgram!, "u_lut"), 1);
    gl.uniform1f(
      gl.getUniformLocation(this.drawProgram!, "u_size"),
      this.particleSize * (globalThis.devicePixelRatio ?? 1),
    );
    gl.uniform1i(gl.getUniformLocation(this.drawProgram!, "u_res"), this.res);
    gl.uniform1f(gl.getUniformLocation(this.drawProgram!, "u_keep"), keep);
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
