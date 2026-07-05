/**
 * Reference styling for the standard meteorological variables: colormap
 * stops anchored to physical values, plus the clim they span. Deliberately
 * opinionated — readable on dark basemaps, and fixed clims so the same
 * value is the same color in every dataset. The demo ships with these;
 * consumers can always pass their own stops instead.
 */

import type { Colormap } from "./colormaps.js";

/** Full meteorological hue ramp (°C): a few degrees of difference should
 *  read on the map, unlike the muted single-hue scientific ramps. */
export const TEMPERATURE_STOPS: Colormap = [
  [-30, "#7c3aed"], // deep violet
  [-20, "#6366f1"], // indigo
  [-10, "#3b82f6"], // blue
  [-5, "#0ea5e9"],
  [0, "#22d3ee"], // cyan
  [5, "#2dd4bf"], // teal
  [10, "#4ade80"], // green
  [15, "#a3e635"], // lime
  [20, "#facc15"], // yellow
  [25, "#fb923c"], // orange
  [30, "#ef4444"], // red
  [35, "#b91c1c"], // dark red
  [45, "#7f1d1d"], // maroon
];
export const TEMPERATURE_CLIM: [number, number] = [-30, 45];

/** Rain-radar look (mm/h): drizzle (0.1–1) must be visible, so the ramp
 *  saturates early; dry stays fully transparent. */
export const PRECIPITATION_STOPS: Colormap = [
  [0.0, "#38bdf800"],
  [0.1, "#7dd3fc"],
  [0.5, "#38bdf8"],
  [1.0, "#2563eb"],
  [2.0, "#7c3aed"],
  [4.0, "#c026d3"],
  [8.0, "#f0abfc"],
];
export const PRECIPITATION_CLIM: [number, number] = [0, 8];

/** Gusts (m/s): calm air stays transparent (the basemap shows through);
 *  color fades in from ~a stiff breeze and runs to storm magenta. */
export const WIND_GUST_STOPS: Colormap = [
  [0, "#38bdf800"],
  [8, "#38bdf84d"],
  [12, "#22d3ee"],
  [17, "#4ade80"],
  [22, "#facc15"],
  [27, "#fb923c"],
  [32, "#ef4444"],
  [40, "#c026d3"],
];
export const WIND_GUST_CLIM: [number, number] = [0, 40];
