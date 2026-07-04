/**
 * High-level access to a Vane dataset: open a `.vane`, list variables,
 * fetch one timestep of one variable as a raw int16 grid + its
 * quantization parameters. Render modes consume {@link Field}s.
 */

import * as zarr from "zarrita";

import {
  blobReader,
  httpReader,
  VaneStore,
  type RangeReader,
  type VaneMetadata,
  type VaneVariableMeta,
} from "./container.js";

export interface Field {
  /** Raw quantized values, row-major, row 0 = north. */
  data: Int16Array;
  width: number;
  height: number;
  /** physical = raw * scale + offset */
  scale: number;
  offset: number;
  nodata: number;
  variable: string;
  timestep: number;
}

export interface PointSeries {
  variable: string;
  unit: string;
  lon: number;
  lat: number;
  /** ISO-8601 UTC, one per value. */
  timesteps: string[];
  /** Physical values; null = nodata at that step. */
  values: (number | null)[];
}

export class VaneDataset {
  private arrays = new Map<string, zarr.Array<"int16", VaneStore>>();
  private fields = new Map<string, Promise<Field>>();

  private constructor(
    readonly store: VaneStore,
    private readonly root: zarr.Location<VaneStore>,
  ) {}

  static async open(source: string | Blob | RangeReader): Promise<VaneDataset> {
    const reader =
      typeof source === "string"
        ? httpReader(source)
        : source instanceof Blob
          ? blobReader(source)
          : source;
    const store = await VaneStore.open(reader);
    return new VaneDataset(store, zarr.root(store));
  }

  /**
   * Resolve a `*_latest.json` pointer and open the immutable `.vane` it
   * points at (relative names resolve against the pointer URL). Re-call to
   * pick up a newer run — data files themselves never change.
   */
  static async openLatest(pointerUrl: string): Promise<VaneDataset> {
    const response = await fetch(pointerUrl, { cache: "no-cache" });
    if (!response.ok) {
      throw new Error(`failed to fetch pointer ${pointerUrl}: HTTP ${response.status}`);
    }
    const pointer = (await response.json()) as { latest?: string };
    if (!pointer.latest) throw new Error(`pointer ${pointerUrl} has no "latest" field`);
    return VaneDataset.open(new URL(pointer.latest, response.url).toString());
  }

  get meta(): VaneMetadata {
    return this.store.vane;
  }

  variableMeta(name: string): VaneVariableMeta {
    const meta = this.meta.variables[name];
    if (!meta) {
      throw new Error(
        `unknown variable "${name}" (have: ${Object.keys(this.meta.variables).join(", ")})`,
      );
    }
    return meta;
  }

  /** The u/v variable names of a vector group (e.g. "wind"). */
  vectorGroup(group: string): { u: string; v: string } {
    let u: string | undefined;
    let v: string | undefined;
    for (const [name, meta] of Object.entries(this.meta.variables)) {
      if (meta.vector_group !== group) continue;
      if (meta.vector_component === "u") u = name;
      if (meta.vector_component === "v") v = name;
    }
    if (!u || !v) throw new Error(`vector group "${group}" needs both u and v variables`);
    return { u, v };
  }

  /**
   * One timestep of one variable as a raw int16 grid. Cached: a time-slider
   * revisiting a step costs no network traffic.
   */
  getField(variable: string, timestep: number): Promise<Field> {
    const key = `${variable}/${timestep}`;
    let field = this.fields.get(key);
    if (!field) {
      field = this.readField(variable, timestep);
      field.catch(() => this.fields.delete(key)); // don't cache failures
      this.fields.set(key, field);
    }
    return field;
  }

  /**
   * Time series of one variable at a location — the chart/meteogram
   * counterpart of {@link getField}. Values are physical (unit in the
   * result). Fetches every timestep chunk of the variable, so cost ≈ the
   * variable's full (compressed) data; fields land in the same cache the
   * map layers use, so a series next to an animated map is nearly free.
   */
  async getPointSeries(variable: string, lon: number, lat: number): Promise<PointSeries> {
    const meta = this.variableMeta(variable);
    const [west, south, east, north] = this.meta.bbox;
    if (lon < west || lon > east || lat < south || lat > north) {
      throw new Error(`(${lon}, ${lat}) is outside the dataset bbox ${this.meta.bbox.join(",")}`);
    }
    const fields = await Promise.all(
      this.meta.timesteps.map((_, t) => this.getField(variable, t)),
    );
    const values = fields.map((field) => {
      const x = Math.round(((lon - west) / (east - west)) * (field.width - 1));
      const y = Math.round(((north - lat) / (north - south)) * (field.height - 1));
      const raw = field.data[y * field.width + x]!;
      return raw === field.nodata ? null : raw * field.scale + field.offset;
    });
    return {
      variable,
      unit: meta.unit,
      lon,
      lat,
      timesteps: [...this.meta.timesteps],
      values,
    };
  }

  private async readField(variable: string, timestep: number): Promise<Field> {
    const meta = this.variableMeta(variable);
    const nt = this.meta.timesteps.length;
    if (timestep < 0 || timestep >= nt) {
      throw new Error(`timestep ${timestep} out of range 0..${nt - 1}`);
    }
    let arr = this.arrays.get(variable);
    if (!arr) {
      const opened = await zarr.open.v3(this.root.resolve(variable), { kind: "array" });
      if (opened.dtype !== "int16") {
        throw new Error(`${variable}: expected int16 storage, got ${opened.dtype}`);
      }
      arr = opened as zarr.Array<"int16", VaneStore>;
      this.arrays.set(variable, arr);
    }
    const { data, shape } = await zarr.get(arr, [timestep, null, null]);
    const [height, width] = shape as [number, number];
    return {
      data: data as Int16Array,
      width,
      height,
      scale: meta.scale,
      offset: meta.offset,
      nodata: meta.nodata,
      variable,
      timestep,
    };
  }
}
