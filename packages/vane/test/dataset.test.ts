/**
 * The spike that validates the whole design: zarrita's sharding codec +
 * zstd reading a Python-written .vane through our ranged store, with
 * Python-side quantized values as ground truth.
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { VaneDataset, VaneStore, blobReader, type RangeReader } from "../src/index.js";

const fixtureDir = fileURLToPath(new URL("./fixtures/", import.meta.url));

async function fixtureReader(): Promise<RangeReader> {
  const bytes = await readFile(`${fixtureDir}small.vane`);
  return blobReader(new Blob([bytes]));
}

async function expected() {
  return JSON.parse(await readFile(`${fixtureDir}expected.json`, "utf8")) as Record<
    string,
    {
      scale: number;
      offset: number;
      shape: number[];
      samples: Record<string, number>;
      sum_t1: number;
    }
  >;
}

describe("VaneStore", () => {
  it("parses header, metadata and manifest", async () => {
    const store = await VaneStore.open(await fixtureReader());
    expect(store.header.specVersion).toBe(1);
    expect(store.vane.source).toBe("fixture");
    expect(store.vane.timesteps).toHaveLength(3);
    // one shard object per data variable + 3 coordinate arrays
    const keys = Object.keys(store.manifest);
    for (const name of ["temperature", "wind_u", "wind_v", "precipitation"]) {
      expect(keys.filter((k) => k.startsWith(`${name}/`))).toHaveLength(1);
    }
  });
});

describe("VaneDataset", () => {
  it("reads exact quantized values through zarrita (sharding + zstd)", async () => {
    const ds = await VaneDataset.open(await fixtureReader());
    const want = await expected();

    for (const [name, spec] of Object.entries(want)) {
      const [, ny, nx] = spec.shape as [number, number, number];
      for (const [key, value] of Object.entries(spec.samples)) {
        const [t, y, x] = key.split(",").map(Number) as [number, number, number];
        const field = await ds.getField(name, t);
        expect(field.width).toBe(nx);
        expect(field.height).toBe(ny);
        expect(field.data[y * nx + x], `${name}[${key}]`).toBe(value);
      }
      const t1 = await ds.getField(name, 1);
      let sum = 0;
      for (const v of t1.data) sum += v;
      expect(sum, `${name} sum(t=1)`).toBe(spec.sum_t1);
    }
  });

  it("dequantizes to plausible physical values", async () => {
    const ds = await VaneDataset.open(await fixtureReader());
    const field = await ds.getField("temperature", 0);
    const physical = Array.from(field.data, (raw) => raw * field.scale + field.offset);
    const min = Math.min(...physical);
    const max = Math.max(...physical);
    expect(min).toBeGreaterThan(-30);
    expect(max).toBeLessThan(45);
  });

  it("resolves vector groups and caches fields", async () => {
    const ds = await VaneDataset.open(await fixtureReader());
    expect(ds.vectorGroup("wind")).toEqual({ u: "wind_u", v: "wind_v" });
    const a = ds.getField("wind_u", 0);
    const b = ds.getField("wind_u", 0);
    expect(a).toBe(b); // same promise, no duplicate fetch
    await a;
  });

  it("rejects unknown variables and out-of-range timesteps", async () => {
    const ds = await VaneDataset.open(await fixtureReader());
    await expect(ds.getField("nope", 0)).rejects.toThrow(/unknown variable/);
    await expect(ds.getField("temperature", 99)).rejects.toThrow(/out of range/);
  });
});
