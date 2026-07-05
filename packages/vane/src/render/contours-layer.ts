/**
 * `contours` render mode: iso-lines (isobars, isotherms) with labels.
 *
 * Geometry comes from marching squares on the CPU (see contours.ts);
 * display is a MapLibre line layer + a line-placed symbol layer for the
 * labels, so styling, collision and label repetition are MapLibre's
 * problem, not ours. Like ValuesLayer this wraps style layers — add it
 * with `layer.addTo(map)`, not `map.addLayer(layer)`.
 */

import type { Map as MapLibreMap } from "maplibre-gl";

import type { VaneDataset, Field } from "../dataset.js";
import { contourLines, levelRange, simplifyLine } from "./contours.js";

export interface ContoursLayerOptions {
  id: string;
  dataset: VaneDataset;
  variable: string;
  timestep?: number;
  /**
   * Iso-line spacing in physical units. Defaults to the dataset's
   * `contour_interval` hint, else 1/10 of the variable's clim span.
   */
  interval?: number;
  /** Level phase anchor (default 0, i.e. levels are multiples of `interval`). */
  base?: number;
  /** Explicit levels override interval/base entirely. */
  levels?: number[];
  color?: string;
  width?: number;
  opacity?: number;
  /** Draw value labels along the lines (default true). */
  labels?: boolean;
  labelDecimals?: number;
  textSize?: number;
  textColor?: string;
  haloColor?: string;
  /** Insert before this style layer id (optional). */
  beforeId?: string;
}

export class ContoursLayer {
  readonly id: string;

  private readonly dataset: VaneDataset;
  private readonly variable: string;
  private readonly options: ContoursLayerOptions;

  private map: MapLibreMap | null = null;
  private timestep: number;
  private loadGeneration = 0;

  constructor(options: ContoursLayerOptions) {
    this.id = options.id;
    this.dataset = options.dataset;
    this.variable = options.variable;
    this.timestep = options.timestep ?? 0;
    this.options = options;
  }

  addTo(map: MapLibreMap): this {
    this.map = map;
    map.addSource(this.id, {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] },
    });
    map.addLayer(
      {
        id: this.id,
        type: "line",
        source: this.id,
        paint: {
          "line-color": this.options.color ?? "#ffffff",
          "line-width": this.options.width ?? 1,
          "line-opacity": this.options.opacity ?? 0.8,
        },
      },
      this.options.beforeId,
    );
    if (this.options.labels ?? true) {
      map.addLayer(
        {
          id: `${this.id}-labels`,
          type: "symbol",
          source: this.id,
          layout: {
            "symbol-placement": "line",
            "text-field": ["get", "label"],
            "text-size": this.options.textSize ?? 11,
            "text-pitch-alignment": "viewport",
          },
          paint: {
            "text-color": this.options.textColor ?? this.options.color ?? "#ffffff",
            "text-halo-color": this.options.haloColor ?? "rgba(0,0,0,0.55)",
            "text-halo-width": 1.2,
          },
        },
        this.options.beforeId,
      );
    }
    void this.rebuild();
    return this;
  }

  remove(): void {
    const map = this.map;
    if (map) {
      for (const id of [`${this.id}-labels`, this.id]) {
        if (map.getLayer(id)) map.removeLayer(id);
      }
      if (map.getSource(this.id)) map.removeSource(this.id);
    }
    this.map = null;
  }

  setTimestep(timestep: number): void {
    this.timestep = timestep;
    void this.rebuild();
  }

  setVisible(visible: boolean): void {
    const visibility = visible ? "visible" : "none";
    for (const id of [this.id, `${this.id}-labels`]) {
      if (this.map?.getLayer(id)) this.map.setLayoutProperty(id, "visibility", visibility);
    }
  }

  private async rebuild(): Promise<void> {
    if (!this.map) return;
    const generation = ++this.loadGeneration;
    let field: Field;
    try {
      field = await this.dataset.getField(this.variable, this.timestep);
    } catch (err) {
      console.error(`vane: ${this.id}: failed to load timestep ${this.timestep}:`, err);
      return;
    }
    if (generation !== this.loadGeneration || !this.map) return;

    const { data, width, height, scale, offset, nodata } = field;
    const physical = new Float32Array(data.length);
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < data.length; i++) {
      const raw = data[i]!;
      if (raw === nodata) {
        physical[i] = NaN;
        continue;
      }
      const value = raw * scale + offset;
      physical[i] = value;
      if (value < min) min = value;
      if (value > max) max = value;
    }
    if (min > max) return; // all nodata

    const meta = this.dataset.variableMeta(this.variable);
    const clim = meta.default_clim;
    const interval =
      this.options.interval ??
      meta.contour_interval ??
      (clim ? (clim[1] - clim[0]) / 10 : (max - min) / 10 || 1);
    const levels = this.options.levels ?? levelRange(min, max, interval, this.options.base ?? 0);

    const [west, south, east, north] = this.dataset.meta.bbox;
    const lonStep = (east - west) / (width - 1);
    const latStep = (north - south) / (height - 1);
    const decimals = this.options.labelDecimals ?? 0;

    const features = contourLines(physical, width, height, levels).map((line) => ({
      type: "Feature" as const,
      geometry: {
        type: "LineString" as const,
        // Simplified so MapLibre can place labels along the line (see contours.ts).
        coordinates: simplifyLine(line.points, 0.35).map(([x, y]) => [
          west + x * lonStep,
          north - y * latStep,
        ]),
      },
      properties: { level: line.level, label: line.level.toFixed(decimals) },
    }));
    const source = this.map.getSource(this.id) as { setData?: (d: unknown) => void } | undefined;
    source?.setData?.({ type: "FeatureCollection", features });
  }
}
