/**
 * `colormap` render mode: one scalar field as a colored surface.
 *
 * A MapLibre CustomLayerInterface that draws the dataset's bbox as a quad in
 * mercator space and, per fragment, converts mercator → lat/lon → grid UV,
 * samples the R16F field texture (hardware bilinear) and maps the physical
 * value through a 256-entry colormap LUT over `clim`.
 *
 * Time is continuous: two adjacent timesteps are kept resident and the
 * fragment mixes them by a `frac` in [0,1], so a smoothly-sliding time
 * control morphs the surface between forecast hours instead of snapping.
 * `setTimestep` takes a fractional step; the two bracketing integer fields
 * are (re)loaded only when the bracket changes.
 */

import type { CustomLayerInterface, Map as MapLibreMap } from "maplibre-gl";

import type { VaneDataset } from "../dataset.js";
import { buildLut, stopsRange, type Colormap } from "./colormaps.js";
import {
  assertWebGL2,
  compileProgram,
  mercator,
  projectionMatrix,
  uploadFieldTexture,
} from "./gl.js";

const VERTEX_SHADER = `#version 300 es
in vec2 a_uv;
uniform mat4 u_matrix;
uniform vec4 u_merc; // mercator x0,y0 (nw) .. x1,y1 (se)
out vec2 v_merc;
void main() {
  vec2 pos = mix(u_merc.xy, u_merc.zw, a_uv);
  v_merc = pos;
  gl_Position = u_matrix * vec4(pos, 0.0, 1.0);
}`;

const FRAGMENT_SHADER = `#version 300 es
precision highp float;
in vec2 v_merc;
uniform sampler2D u_field0;
uniform sampler2D u_field1;
uniform float u_frac;
uniform sampler2D u_lut;
uniform vec4 u_bbox; // west, south, east, north (degrees)
uniform vec2 u_clim;
uniform float u_opacity;
out vec4 fragColor;
const float PI = 3.141592653589793;
void main() {
  float lon = v_merc.x * 360.0 - 180.0;
  float lat = degrees(2.0 * atan(exp(PI * (1.0 - 2.0 * v_merc.y))) - PI * 0.5);
  vec2 uv = vec2((lon - u_bbox.x) / (u_bbox.z - u_bbox.x),
                 (u_bbox.w - lat) / (u_bbox.w - u_bbox.y));
  if (any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) discard;
  float v0 = texture(u_field0, uv).r;
  float v1 = texture(u_field1, uv).r;
  bool n0 = !(v0 == v0); // NaN = nodata
  bool n1 = !(v1 == v1);
  if (n0 && n1) discard;
  float value = n0 ? v1 : (n1 ? v0 : mix(v0, v1, u_frac));
  float t = clamp((value - u_clim.x) / (u_clim.y - u_clim.x), 0.0, 1.0);
  vec4 color = texture(u_lut, vec2(t, 0.5));
  float alpha = color.a * u_opacity;
  fragColor = vec4(color.rgb * alpha, alpha); // premultiplied
}`;

export interface ColormapLayerOptions {
  id: string;
  dataset: VaneDataset;
  variable: string;
  /** May be fractional — the surface interpolates between bracketing steps. */
  timestep?: number;
  colormap?: Colormap;
  /** Physical value range mapped over the colormap. */
  clim?: [number, number];
  opacity?: number;
}

export class ColormapLayer implements CustomLayerInterface {
  readonly id: string;
  readonly type = "custom" as const;
  readonly renderingMode = "2d" as const;

  private readonly dataset: VaneDataset;
  private readonly variable: string;
  private colormap: Colormap;
  private clim: [number, number];
  private opacity: number;
  private timestep: number;

  private map: MapLibreMap | null = null;
  private gl: WebGL2RenderingContext | null = null;
  private program: WebGLProgram | null = null;
  private vao: WebGLVertexArrayObject | null = null;
  /** Two resident timesteps; the fragment mixes them by `frac`. */
  private fieldTextures: [WebGLTexture, WebGLTexture] | null = null;
  private lutTexture: WebGLTexture | null = null;
  private fieldReady = false;
  private lutDirty = true;
  private loadGeneration = 0;
  /** Integer steps currently in slots 0/1 (`-1` = unloaded). */
  private loaded: [number, number] = [-1, -1];
  private frac = 0;

  constructor(options: ColormapLayerOptions) {
    this.id = options.id;
    this.dataset = options.dataset;
    this.variable = options.variable;
    this.timestep = options.timestep ?? 0;
    this.opacity = options.opacity ?? 1;

    const meta = this.dataset.variableMeta(this.variable);
    this.colormap = options.colormap ?? meta.default_colormap ?? "viridis";
    this.clim =
      options.clim ??
      meta.default_clim ??
      (typeof this.colormap !== "string" ? stopsRange(this.colormap) : [0, 1]);
  }

  onAdd(map: MapLibreMap, gl: WebGLRenderingContext | WebGL2RenderingContext): void {
    this.map = map;
    const gl2 = (this.gl = assertWebGL2(gl));
    this.program = compileProgram(gl2, VERTEX_SHADER, FRAGMENT_SHADER);

    this.vao = gl2.createVertexArray();
    gl2.bindVertexArray(this.vao);
    const quad = gl2.createBuffer();
    gl2.bindBuffer(gl2.ARRAY_BUFFER, quad);
    gl2.bufferData(
      gl2.ARRAY_BUFFER,
      new Float32Array([0, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1, 1]),
      gl2.STATIC_DRAW,
    );
    const aUv = gl2.getAttribLocation(this.program, "a_uv");
    gl2.enableVertexAttribArray(aUv);
    gl2.vertexAttribPointer(aUv, 2, gl2.FLOAT, false, 0, 0);
    gl2.bindVertexArray(null);

    this.fieldTextures = [gl2.createTexture(), gl2.createTexture()];
    this.lutTexture = gl2.createTexture();
    void this.loadTimestep(this.timestep);
  }

  onRemove(): void {
    const gl = this.gl;
    if (gl) {
      if (this.program) gl.deleteProgram(this.program);
      if (this.vao) gl.deleteVertexArray(this.vao);
      for (const t of this.fieldTextures ?? []) gl.deleteTexture(t);
      if (this.lutTexture) gl.deleteTexture(this.lutTexture);
    }
    this.gl = null;
    this.map = null;
    this.program = null;
    this.vao = null;
    this.fieldTextures = null;
    this.lutTexture = null;
    this.fieldReady = false;
    this.lutDirty = true;
    this.loaded = [-1, -1];
  }

  /** Switch the displayed timestep (fractional); keeps the old frame until
   *  data arrives. Only refetches when the integer bracket changes. */
  setTimestep(timestep: number): void {
    this.timestep = timestep;
    void this.loadTimestep(timestep);
  }

  setOpacity(opacity: number): void {
    this.opacity = opacity;
    this.map?.triggerRepaint();
  }

  setColormap(colormap: Colormap, clim?: [number, number]): void {
    this.colormap = colormap;
    if (clim) this.clim = clim;
    else if (typeof colormap !== "string") this.clim = stopsRange(colormap);
    this.lutDirty = true;
    this.map?.triggerRepaint();
  }

  private async loadTimestep(timestep: number): Promise<void> {
    const nt = this.dataset.meta.timesteps.length;
    const clamped = Math.min(Math.max(timestep, 0), nt - 1);
    const t0 = Math.floor(clamped);
    const t1 = Math.min(t0 + 1, nt - 1);
    this.frac = t1 === t0 ? 0 : clamped - t0;

    // Same bracket as what's resident: a uniform swap is all that's needed.
    if (this.loaded[0] === t0 && this.loaded[1] === t1) {
      this.map?.triggerRepaint();
      return;
    }

    const generation = ++this.loadGeneration;
    let f0, f1;
    try {
      [f0, f1] = await Promise.all([
        this.dataset.getField(this.variable, t0),
        this.dataset.getField(this.variable, t1),
      ]);
    } catch (err) {
      // Keep showing the previous frame; a later setTimestep can recover.
      console.error(`vane: ${this.id}: failed to load bracket ${t0}..${t1}:`, err);
      return;
    }
    // A newer request superseded this one while we were fetching.
    if (generation !== this.loadGeneration || !this.gl || !this.fieldTextures) return;
    uploadFieldTexture(this.gl, this.fieldTextures[0], f0);
    uploadFieldTexture(this.gl, this.fieldTextures[1], f1);
    this.fieldReady = true;
    this.loaded = [t0, t1];
    this.map?.triggerRepaint();
  }

  render(gl_: WebGLRenderingContext | WebGL2RenderingContext, matrixOrOptions: unknown): void {
    const gl = this.gl;
    if (!gl || !this.program || !this.vao || !this.fieldReady || !this.fieldTextures) return;

    if (this.lutDirty && this.lutTexture) {
      gl.bindTexture(gl.TEXTURE_2D, this.lutTexture);
      gl.texImage2D(
        gl.TEXTURE_2D, 0, gl.RGBA, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
        buildLut(this.colormap, this.clim),
      );
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      this.lutDirty = false;
    }

    const [west, south, east, north] = this.dataset.meta.bbox;
    const [x0, y0] = mercator(west, north);
    const [x1, y1] = mercator(east, south);

    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);
    gl.uniformMatrix4fv(
      gl.getUniformLocation(this.program, "u_matrix"),
      false,
      projectionMatrix(matrixOrOptions),
    );
    gl.uniform4f(gl.getUniformLocation(this.program, "u_merc"), x0, y0, x1, y1);
    gl.uniform4f(gl.getUniformLocation(this.program, "u_bbox"), west, south, east, north);
    gl.uniform2f(gl.getUniformLocation(this.program, "u_clim"), this.clim[0], this.clim[1]);
    gl.uniform1f(gl.getUniformLocation(this.program, "u_opacity"), this.opacity);
    gl.uniform1f(gl.getUniformLocation(this.program, "u_frac"), this.frac);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.fieldTextures[0]);
    gl.uniform1i(gl.getUniformLocation(this.program, "u_field0"), 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.fieldTextures[1]);
    gl.uniform1i(gl.getUniformLocation(this.program, "u_field1"), 1);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.lutTexture);
    gl.uniform1i(gl.getUniformLocation(this.program, "u_lut"), 2);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.disable(gl.DEPTH_TEST);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.bindVertexArray(null);
  }
}
