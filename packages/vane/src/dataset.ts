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
