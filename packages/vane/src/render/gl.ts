/** Tiny WebGL2 helpers shared by the render modes. */

export function compileProgram(
  gl: WebGL2RenderingContext,
  vertexSource: string,
  fragmentSource: string,
  /** Attribute name → location bindings, applied before linking. */
  attribLocations?: Record<string, number>,
): WebGLProgram {
  const program = gl.createProgram();
  for (const [name, location] of Object.entries(attribLocations ?? {})) {
    gl.bindAttribLocation(program, location, name);
  }
  for (const [type, source] of [
    [gl.VERTEX_SHADER, vertexSource],
    [gl.FRAGMENT_SHADER, fragmentSource],
  ] as const) {
    const shader = gl.createShader(type);
    if (!shader) throw new Error("failed to create shader");
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      throw new Error(`shader compile failed: ${gl.getShaderInfoLog(shader)}\n${source}`);
    }
    gl.attachShader(program, shader);
  }
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(`program link failed: ${gl.getProgramInfoLog(program)}`);
  }
  return program;
}

export function assertWebGL2(
  gl: WebGLRenderingContext | WebGL2RenderingContext,
): WebGL2RenderingContext {
  if (!(gl instanceof WebGL2RenderingContext)) {
    throw new Error("vane render modes require a WebGL2 map context");
  }
  return gl;
}

/**
 * The matrix that projects mercator [0,1] coordinates to clip space.
 * MapLibre v4 passes it directly; v5 passes an options object whose
 * `defaultProjectionData.mainMatrix` is the custom-layer matrix rescaled
 * for mercator [0,1] input (`modelViewProjectionMatrix` is NOT — it expects
 * world-pixel coordinates).
 */
export function projectionMatrix(matrixOrOptions: unknown): Float32Array {
  if (
    Array.isArray(matrixOrOptions) ||
    matrixOrOptions instanceof Float32Array ||
    matrixOrOptions instanceof Float64Array
  ) {
    return new Float32Array(matrixOrOptions as ArrayLike<number>);
  }
  const options = matrixOrOptions as {
    defaultProjectionData?: { mainMatrix: ArrayLike<number> };
    modelViewProjectionMatrix?: ArrayLike<number>;
  };
  const matrix = options.defaultProjectionData?.mainMatrix ?? options.modelViewProjectionMatrix;
  if (!matrix) throw new Error("cannot extract projection matrix from render arguments");
  return new Float32Array(matrix);
}

/** Web-mercator [0,1] coordinates of a lon/lat (x east, y south). */
export function mercator(lon: number, lat: number): [number, number] {
  const x = (lon + 180) / 360;
  const y =
    (1 - Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)) / Math.PI) / 2;
  return [x, y];
}

/**
 * Upload a dequantized field as a filterable R16F texture (half-float
 * filtering is core WebGL2). Nodata becomes NaN, which the shaders detect
 * and discard.
 */
export function uploadFieldTexture(
  gl: WebGL2RenderingContext,
  texture: WebGLTexture,
  field: { data: Int16Array; width: number; height: number; scale: number; offset: number; nodata: number },
): void {
  const { data, width, height, scale, offset, nodata } = field;
  const physical = new Float32Array(data.length);
  for (let i = 0; i < data.length; i++) {
    const raw = data[i]!;
    physical[i] = raw === nodata ? NaN : raw * scale + offset;
  }
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.R16F, width, height, 0, gl.RED, gl.FLOAT, physical);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
}
