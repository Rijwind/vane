/**
 * Colormap lookup tables. A colormap is either a built-in name or explicit
 * stops: `[[physicalValue, cssHexColor], …]`. The LUT is a 256×1 RGBA
 * texture sampled with the value normalized over `clim`.
 */

export type ColormapStops = Array<[number, string]>;
export type Colormap = string | ColormapStops;

/** Evenly-spaced hex ramps; stops get spread over the active clim. */
const BUILTIN: Record<string, string[]> = {
  viridis: [
    "#440154", "#482878", "#3e4989", "#31688e", "#26828e",
    "#1f9e89", "#35b779", "#6ece58", "#b5de2b", "#fde725",
  ],
  thermal: [
    "#042333", "#2c3395", "#744992", "#b15f82",
    "#eb7958", "#fbb43d", "#e8fa5b",
  ],
  // For precipitation-like fields: transparent below the first stop.
  blues: [
    "#2171b500", "#c6dbef", "#6baed6", "#2171b5", "#08306b", "#54278f",
  ],
};

export function parseColor(hex: string): [number, number, number, number] {
  let h = hex.replace("#", "");
  if (h.length === 3) h = [...h].map((c) => c + c).join("");
  if (h.length === 6) h += "ff";
  if (h.length !== 8 || /[^0-9a-fA-F]/.test(h)) {
    throw new Error(`unsupported color "${hex}" (use #rgb, #rrggbb or #rrggbbaa)`);
  }
  const n = parseInt(h, 16);
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
}

/**
 * Build a 256-entry RGBA8 LUT. Named colormaps span [0,1]; explicit stops
 * are normalized over `clim` so their physical values land correctly.
 */
export function buildLut(colormap: Colormap, clim: [number, number]): Uint8Array {
  let positions: number[];
  let colors: Array<[number, number, number, number]>;
  if (typeof colormap === "string") {
    const ramp = BUILTIN[colormap];
    if (!ramp) {
      throw new Error(
        `unknown colormap "${colormap}" (have: ${Object.keys(BUILTIN).join(", ")})`,
      );
    }
    positions = ramp.map((_, i) => i / (ramp.length - 1));
    colors = ramp.map(parseColor);
  } else {
    if (colormap.length < 2) throw new Error("colormap needs at least two stops");
    const [lo, hi] = clim;
    positions = colormap.map(([value]) => (value - lo) / (hi - lo));
    colors = colormap.map(([, color]) => parseColor(color));
  }

  const lut = new Uint8Array(256 * 4);
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    let j = 0;
    while (j < positions.length - 2 && t > positions[j + 1]!) j++;
    const t0 = positions[j]!;
    const t1 = positions[j + 1]!;
    const f = Math.min(1, Math.max(0, t1 === t0 ? 0 : (t - t0) / (t1 - t0)));
    for (let c = 0; c < 4; c++) {
      lut[i * 4 + c] = Math.round(colors[j]![c]! + (colors[j + 1]![c]! - colors[j]![c]!) * f);
    }
  }
  return lut;
}

/** Default clim for explicit stops: the range the stops cover. */
export function stopsRange(stops: ColormapStops): [number, number] {
  const values = stops.map(([v]) => v);
  return [Math.min(...values), Math.max(...values)];
}
