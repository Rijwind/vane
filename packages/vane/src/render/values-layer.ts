/**
 * `values` render mode: the field as a grid of numbers ("windy grid").
 *
 * Not a WebGL custom layer — numbers are text, and MapLibre's symbol layers
 * already do halo/collision/zoom text rendering well. ValuesLayer manages a
 * GeoJSON source + symbol layer: on every camera settle it samples the data
 * grid at a stride that keeps labels at least `minSpacing` px apart and
 * rebuilds the point features. Labels sit on true grid-cell centers (stride
 * anchored at index 0), so values are honest samples, never interpolated,
 * and don't slide around while panning.
 *
 * Because this wraps style layers rather than implementing
 * CustomLayerInterface, add it with `layer.addTo(map)` instead of
 * `map.addLayer(layer)`.
 */

import type { Map as MapLibreMap } from "maplibre-gl";

import type { VaneDataset, Field } from "../dataset.js";

export interface ValuesLayerOptions {
  id: string;
  dataset: VaneDataset;
  variable: string;
  timestep?: number;
  /** Minimum on-screen distance between neighboring labels, px (default 64). */
  minSpacing?: number;
  /** Fraction digits per label (default 0). */
  decimals?: number;
  textSize?: number;
  textColor?: string;
  haloColor?: string;
  /** Insert before this style layer id (optional). */
  beforeId?: string;
}

export class ValuesLayer {
  readonly id: string;

  private readonly dataset: VaneDataset;
  private readonly variable: string;
  private readonly minSpacing: number;
  private readonly decimals: number;
  private readonly textSize: number;
  private readonly textColor: string;
  private readonly haloColor: string;
  private readonly beforeId?: string;

  private map: MapLibreMap | null = null;
  private timestep: number;
  private loadGeneration = 0;
  private readonly update = () => void this.rebuild();

  constructor(options: ValuesLayerOptions) {
    this.id = options.id;
    this.dataset = options.dataset;
    this.variable = options.variable;
    this.timestep = options.timestep ?? 0;
    this.minSpacing = options.minSpacing ?? 64;
    this.decimals = options.decimals ?? 0;
    this.textSize = options.textSize ?? 12;
    this.textColor = options.textColor ?? "#ffffff";
    this.haloColor = options.haloColor ?? "rgba(0,0,0,0.55)";
    this.beforeId = options.beforeId;
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
        type: "symbol",
        source: this.id,
        layout: {
          "text-field": ["get", "label"],
          "text-size": this.textSize,
          // Spacing is enforced by the sampling stride; skipping MapLibre's
          // collision pass keeps the grid complete and stable.
          "text-allow-overlap": true,
          "text-ignore-placement": true,
        },
        paint: {
          "text-color": this.textColor,
          "text-halo-color": this.haloColor,
          "text-halo-width": 1.2,
        },
      },
      this.beforeId,
    );
    map.on("moveend", this.update);
    void this.rebuild();
    return this;
  }

  remove(): void {
    const map = this.map;
    if (map) {
      map.off("moveend", this.update);
      if (map.getLayer(this.id)) map.removeLayer(this.id);
      if (map.getSource(this.id)) map.removeSource(this.id);
    }
    this.map = null;
  }

  setTimestep(timestep: number): void {
    // Values are honest grid samples, not interpolated — snap a fractional
    // (continuous playback) step to the nearest integer, and skip a redundant
    // rebuild when it hasn't changed.
    const t = Math.round(timestep);
    if (t === this.timestep) return;
    this.timestep = t;
    void this.rebuild();
  }

  setVisible(visible: boolean): void {
    this.map?.setLayoutProperty(this.id, "visibility", visible ? "visible" : "none");
  }

  private async rebuild(): Promise<void> {
    const map = this.map;
    if (!map) return;
    const generation = ++this.loadGeneration;
    let field: Field;
    try {
      field = await this.dataset.getField(this.variable, this.timestep);
    } catch (err) {
      console.error(`vane: ${this.id}: failed to load timestep ${this.timestep}:`, err);
      return;
    }
    if (generation !== this.loadGeneration || !this.map) return;

    const [west, south, east, north] = this.dataset.meta.bbox;
    const { width, height } = field;
    const lonStep = (east - west) / (width - 1);
    const latStep = (north - south) / (height - 1);

    // Pixel distance between adjacent grid points at the current camera,
    // measured at the view center's latitude (close enough within a view).
    const center = map.getCenter();
    const lat = Math.min(Math.max(center.lat, south), north);
    const a = map.project([center.lng, lat]);
    const b = map.project([center.lng + lonStep, lat - latStep]);
    const cellPx = Math.min(Math.abs(b.x - a.x), Math.abs(b.y - a.y)) || 1;
    const stride = Math.max(1, Math.ceil(this.minSpacing / cellPx));

    // Visible index window (+1 cell margin), stride anchored at index 0.
    const bounds = map.getBounds();
    const j0 = Math.max(0, Math.floor((bounds.getWest() - west) / lonStep) - 1);
    const j1 = Math.min(width - 1, Math.ceil((bounds.getEast() - west) / lonStep) + 1);
    const i0 = Math.max(0, Math.floor((north - bounds.getNorth()) / latStep) - 1);
    const i1 = Math.min(height - 1, Math.ceil((north - bounds.getSouth()) / latStep) + 1);

    const features: GeoJSON.Feature[] = [];
    for (let i = Math.ceil(i0 / stride) * stride; i <= i1; i += stride) {
      for (let j = Math.ceil(j0 / stride) * stride; j <= j1; j += stride) {
        const raw = field.data[i * width + j]!;
        if (raw === field.nodata) continue;
        const value = raw * field.scale + field.offset;
        features.push({
          type: "Feature",
          geometry: { type: "Point", coordinates: [west + j * lonStep, north - i * latStep] },
          properties: { label: value.toFixed(this.decimals) },
        });
      }
    }
    const source = map.getSource(this.id) as { setData?: (d: unknown) => void } | undefined;
    source?.setData?.({ type: "FeatureCollection", features });
  }
}
