/**
 * `arrows` render mode: a vector field as a grid of direction arrows.
 *
 * A MapLibre CustomLayerInterface drawing one instanced arrow glyph per
 * data grid point (strided so arrows keep >= `spacing` px apart, anchored
 * at index 0 so they stay glued to the data while panning). The vertex
 * shader samples the RG16F wind texture at the anchor, rotates the glyph
 * to the on-screen direction (derived by projecting a small mercator step,
 * so map bearing/pitch are honored), scales it with speed and colors it
 * through the same LUT the other modes use. Glyphs are screen-sized:
 * pixel offsets are applied in clip space.
 */

import type { CustomLayerInterface, Map as MapLibreMap } from "maplibre-gl";

import type { VaneDataset, Field } from "../dataset.js";
import { buildLut, type Colormap } from "./colormaps.js";
import { assertWebGL2, compileProgram, mercator, projectionMatrix } from "./gl.js";

const VERTEX_SHADER = `#version 300 es
precision highp float;
in vec2 a_pos;  // glyph vertex, unit space, +y = arrow head
in vec2 a_uv;   // per-instance grid uv of the anchor
uniform sampler2D u_wind;
uniform mat4 u_matrix;
uniform vec4 u_bbox;     // degrees w, s, e, n
uniform vec2 u_viewport; // drawing buffer px
uniform float u_size;    // glyph size px
uniform vec2 u_speedRange;
uniform float u_minSpeed;
out float v_t;
const float PI = 3.141592653589793;

vec2 toMercator(vec2 lonlat) {
  // Clamp to the web-mercator latitude limit: global datasets anchor
  // arrows at +-90 degrees, which would otherwise project to infinity.
  float lat = clamp(lonlat.y, -85.051129, 85.051129);
  float x = (lonlat.x + 180.0) / 360.0;
  float y = (1.0 - log(tan(PI * 0.25 + radians(lat) * 0.5)) / PI) / 2.0;
  return vec2(x, y);
}

void main() {
  vec2 wind = texture(u_wind, a_uv).rg;
  float speed = length(wind);
  if (!(wind.x == wind.x) || speed < u_minSpeed) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0); // clip away nodata / calm
    v_t = 0.0;
    return;
  }
  v_t = clamp((speed - u_speedRange.x) / (u_speedRange.y - u_speedRange.x), 0.0, 1.0);

  vec2 lonlat = vec2(mix(u_bbox.x, u_bbox.z, a_uv.x), mix(u_bbox.w, u_bbox.y, a_uv.y));
  vec2 merc = toMercator(lonlat);
  vec4 clip = u_matrix * vec4(merc, 0.0, 1.0);

  // On-screen direction: project a small mercator step along the wind.
  vec2 stepMerc = merc + normalize(vec2(wind.x, -wind.y)) * 1e-5;
  vec4 clip2 = u_matrix * vec4(stepMerc, 0.0, 1.0);
  vec2 dirPx = (clip2.xy / clip2.w - clip.xy / clip.w) * u_viewport * 0.5;
  vec2 dir = length(dirPx) > 0.0 ? normalize(dirPx) : vec2(0.0, 1.0);

  // Rotate glyph so +y points along dir; scale grows a little with speed.
  mat2 rotate = mat2(dir.y, -dir.x, dir.x, dir.y);
  vec2 offsetPx = rotate * (a_pos * u_size * (0.6 + 0.4 * v_t));
  clip.xy += offsetPx / (u_viewport * 0.5) * clip.w;
  gl_Position = clip;
}`;

const FRAGMENT_SHADER = `#version 300 es
precision highp float;
in float v_t;
uniform sampler2D u_lut;
uniform float u_opacity;
out vec4 fragColor;
void main() {
  vec4 color = texture(u_lut, vec2(v_t, 0.5));
  float alpha = color.a * u_opacity;
  fragColor = vec4(color.rgb * alpha, alpha); // premultiplied
}`;

// Arrow pointing +y in a unit box: shaft quad + head triangle (9 vertices).
const SHAFT_HALF_WIDTH = 0.06;
const HEAD_HALF_WIDTH = 0.22;
const HEAD_BASE = 0.12;
// prettier-ignore
const GLYPH = new Float32Array([
  // shaft (tail -0.5 .. head base)
  -SHAFT_HALF_WIDTH, -0.5,  SHAFT_HALF_WIDTH, -0.5,  SHAFT_HALF_WIDTH, HEAD_BASE,
  -SHAFT_HALF_WIDTH, -0.5,  SHAFT_HALF_WIDTH, HEAD_BASE, -SHAFT_HALF_WIDTH, HEAD_BASE,
  // head
  -HEAD_HALF_WIDTH, HEAD_BASE,  HEAD_HALF_WIDTH, HEAD_BASE,  0.0, 0.5,
]);

/** Default arrow ramp: silver for light air through yellow to red at the
 *  top of `speedRange`. Chosen for visibility — dark scientific ramps
 *  (viridis etc.) disappear at low speeds on dark basemaps. NB: colormap
 *  stops for this layer span the normalized [0,1] speed domain. */
const DEFAULT_ARROW_COLORMAP: Colormap = [
  [0, "#e2e8f0cc"],
  [0.5, "#fde047"],
  [1, "#f87171"],
];

export interface ArrowsLayerOptions {
  id: string;
  dataset: VaneDataset;
  /** Vector group name (e.g. "wind") — resolves the u/v variable pair. */
  variable?: string;
  timestep?: number;
  /** Minimum on-screen distance between arrows, px (default 56). */
  spacing?: number;
  /** Glyph size px at full speed (default 28). */
  size?: number;
  /** Speed range (m/s) mapped over the colormap. */
  speedRange?: [number, number];
  /** Stops span the normalized [0,1] speed domain, not m/s. */
  colormap?: Colormap;
  opacity?: number;
  /** Hide arrows below this speed, m/s (default 0.4: calm looks like noise). */
  minSpeed?: number;
}

export class ArrowsLayer implements CustomLayerInterface {
  readonly id: string;
  readonly type = "custom" as const;
  readonly renderingMode = "2d" as const;

  private readonly dataset: VaneDataset;
  private readonly group: string;
  private readonly spacing: number;
  private readonly size: number;
  private readonly speedRange: [number, number];
  private readonly colormap: Colormap;
  private readonly minSpeed: number;
  private opacity: number;
  private timestep: number;

  private map: MapLibreMap | null = null;
  private gl: WebGL2RenderingContext | null = null;
  private program: WebGLProgram | null = null;
  private vao: WebGLVertexArrayObject | null = null;
  private instanceBuffer: WebGLBuffer | null = null;
  private instanceCount = 0;
  private windTexture: WebGLTexture | null = null;
  private lutTexture: WebGLTexture | null = null;
  private windReady = false;
  private gridSize: [number, number] = [0, 0];
  private loadGeneration = 0;
  private readonly rebuildAnchors = () => this.updateAnchors();

  constructor(options: ArrowsLayerOptions) {
    this.id = options.id;
    this.dataset = options.dataset;
    this.group = options.variable ?? "wind";
    this.timestep = options.timestep ?? 0;
    this.spacing = options.spacing ?? 56;
    this.size = options.size ?? 28;
    this.speedRange = options.speedRange ?? [0, 20];
    this.colormap = options.colormap ?? DEFAULT_ARROW_COLORMAP;
    this.opacity = options.opacity ?? 0.9;
    this.minSpeed = options.minSpeed ?? 0.4;
  }

  onAdd(map: MapLibreMap, gl_: WebGLRenderingContext | WebGL2RenderingContext): void {
    this.map = map;
    const gl = (this.gl = assertWebGL2(gl_));
    this.program = compileProgram(gl, VERTEX_SHADER, FRAGMENT_SHADER, { a_pos: 0, a_uv: 1 });

    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    const glyphBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, glyphBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, GLYPH, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    this.instanceBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffer);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(1, 1);
    gl.bindVertexArray(null);

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
    map.on("moveend", this.rebuildAnchors);
  }

  onRemove(): void {
    this.map?.off("moveend", this.rebuildAnchors);
    const gl = this.gl;
    if (gl) {
      if (this.program) gl.deleteProgram(this.program);
      if (this.vao) gl.deleteVertexArray(this.vao);
      if (this.instanceBuffer) gl.deleteBuffer(this.instanceBuffer);
      if (this.windTexture) gl.deleteTexture(this.windTexture);
      if (this.lutTexture) gl.deleteTexture(this.lutTexture);
    }
    this.gl = null;
    this.map = null;
    this.program = null;
    this.vao = null;
    this.instanceBuffer = null;
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
    let uField: Field;
    let vField: Field;
    try {
      const { u, v } = this.dataset.vectorGroup(this.group);
      [uField, vField] = await Promise.all([
        this.dataset.getField(u, timestep),
        this.dataset.getField(v, timestep),
      ]);
    } catch (err) {
      console.error(`vane: ${this.id}: failed to load timestep ${timestep}:`, err);
      return;
    }
    if (generation !== this.loadGeneration || !this.gl || !this.windTexture) return;

    const { width, height } = uField;
    const data = new Float32Array(width * height * 2);
    for (let i = 0; i < width * height; i++) {
      const ru = uField.data[i]!;
      const rv = vField.data[i]!;
      // NaN marks nodata; the shader hides those arrows.
      data[i * 2] = ru === uField.nodata ? NaN : ru * uField.scale + uField.offset;
      data[i * 2 + 1] = rv === vField.nodata ? NaN : rv * vField.scale + vField.offset;
    }
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.windTexture);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG16F, width, height, 0, gl.RG, gl.FLOAT, data);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    this.gridSize = [width, height];
    this.windReady = true;
    this.updateAnchors();
  }

  /** Rebuild per-instance anchor uvs for the current camera (strided grid). */
  private updateAnchors(): void {
    const map = this.map;
    const gl = this.gl;
    if (!map || !gl || !this.windReady || !this.instanceBuffer) return;

    const [west, south, east, north] = this.dataset.meta.bbox;
    const [width, height] = this.gridSize;
    const lonStep = (east - west) / (width - 1);
    const latStep = (north - south) / (height - 1);

    const center = map.getCenter();
    const lat = Math.min(Math.max(center.lat, south), north);
    const a = map.project([center.lng, lat]);
    const b = map.project([center.lng + lonStep, lat - latStep]);
    const cellPx = Math.min(Math.abs(b.x - a.x), Math.abs(b.y - a.y)) || 1;
    const stride = Math.max(1, Math.ceil(this.spacing / cellPx));

    const bounds = map.getBounds();
    const j0 = Math.max(0, Math.floor((bounds.getWest() - west) / lonStep) - stride);
    const j1 = Math.min(width - 1, Math.ceil((bounds.getEast() - west) / lonStep) + stride);
    const i0 = Math.max(0, Math.floor((north - bounds.getNorth()) / latStep) - stride);
    const i1 = Math.min(height - 1, Math.ceil((north - bounds.getSouth()) / latStep) + stride);

    const anchors: number[] = [];
    for (let i = Math.ceil(i0 / stride) * stride; i <= i1; i += stride) {
      for (let j = Math.ceil(j0 / stride) * stride; j <= j1; j += stride) {
        anchors.push(j / (width - 1), i / (height - 1));
      }
    }
    this.instanceCount = anchors.length / 2;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(anchors), gl.DYNAMIC_DRAW);
    map.triggerRepaint();
  }

  render(gl_: WebGLRenderingContext | WebGL2RenderingContext, matrixOrOptions: unknown): void {
    const gl = this.gl;
    if (!gl || !this.program || !this.vao || !this.windReady || this.instanceCount === 0) return;

    const [west, south, east, north] = this.dataset.meta.bbox;
    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);
    gl.uniformMatrix4fv(
      gl.getUniformLocation(this.program, "u_matrix"),
      false,
      projectionMatrix(matrixOrOptions),
    );
    gl.uniform4f(gl.getUniformLocation(this.program, "u_bbox"), west, south, east, north);
    gl.uniform2f(
      gl.getUniformLocation(this.program, "u_viewport"),
      gl.drawingBufferWidth,
      gl.drawingBufferHeight,
    );
    gl.uniform1f(
      gl.getUniformLocation(this.program, "u_size"),
      this.size * (globalThis.devicePixelRatio ?? 1),
    );
    gl.uniform2f(
      gl.getUniformLocation(this.program, "u_speedRange"),
      this.speedRange[0],
      this.speedRange[1],
    );
    gl.uniform1f(gl.getUniformLocation(this.program, "u_minSpeed"), this.minSpeed);
    gl.uniform1f(gl.getUniformLocation(this.program, "u_opacity"), this.opacity);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.windTexture);
    gl.uniform1i(gl.getUniformLocation(this.program, "u_wind"), 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.lutTexture);
    gl.uniform1i(gl.getUniformLocation(this.program, "u_lut"), 1);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.disable(gl.DEPTH_TEST);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, GLYPH.length / 2, this.instanceCount);
    gl.bindVertexArray(null);
  }
}
