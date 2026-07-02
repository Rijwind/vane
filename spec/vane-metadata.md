# Vane metadata convention — draft (v1, unfrozen)

A Vane dataset is a Zarr v3 group whose root `zarr.json` carries a `vane`
block in `attributes`. Everything array-shaped (dtype, chunk grid, codecs,
fill value) is described by Zarr itself; the `vane` block only adds what a
weather renderer needs on top.

```json
{
  "vane_spec": 1,
  "source": "knmi_harmonie_cy43_p1",
  "source_type": "model",
  "model_run": "2026-06-24T06:00:00Z",
  "created_at": "2026-06-24T06:47:00Z",
  "bbox": [3.2, 50.7, 7.3, 53.6],
  "crs": "EPSG:4326",
  "update_interval_seconds": 3600,
  "timesteps": ["2026-06-24T06:00:00Z", "…"],
  "levels": null,
  "variables": {
    "temperature":   { "unit": "celsius", "scale": 0.01, "offset": -50.0, "nodata": -32768,
                       "default_colormap": "thermal", "default_clim": [-10, 40] },
    "precipitation": { "unit": "mm/h",    "scale": 0.01, "offset": 0.0,   "nodata": -32768 },
    "wind_u":        { "unit": "m/s",     "scale": 0.01, "offset": 0.0,   "nodata": -32768,
                       "vector_group": "wind", "vector_component": "u" },
    "wind_v":        { "unit": "m/s",     "scale": 0.01, "offset": 0.0,   "nodata": -32768,
                       "vector_group": "wind", "vector_component": "v" }
  }
}
```

## Field semantics

- `source_type`: `"model" | "radar"`. Drives time-slider defaults
  (radar = 5-minute steps, model = hourly/3-hourly).
- `bbox`: `[west, south, east, north]`, degrees, in `crs`. The grid is a
  **regular** lat/lon grid spanning the bbox; cell centers, row 0 = north.
  Native model grids (rotated / Lambert) are regridded by the writer.
- `scale` / `offset`: physical value = `raw * scale + offset`. Storage dtype
  is int16 unless stated otherwise; `nodata` is the raw sentinel.
- `vector_group` / `vector_component`: pairs u+v arrays into one logical
  vector field for vector render modes (particles, arrows).
- `default_colormap` / `default_clim`: rendering *hints* — clients may
  override.
- `timesteps`: ISO-8601 UTC, one per index along the `time` dimension.
- `levels`: `null` for surface-only, else an array (e.g. meters above
  ground) matching the `level` dimension of 4-D arrays.

## Array conventions

- Dimensions: `(time, lat, lon)` for surface variables,
  `(time, level, lat, lon)` for level variables. `dimension_names` is set
  on every array.
- 1-D coordinate arrays `time` (seconds since epoch, float64), `lat`, `lon`
  (degrees, float64) are included for xarray round-tripping.
- Chunking: one timestep per chunk (`(1, ny, nx)` or a spatial split of it
  for very large grids). Sharding: all chunks of a variable in one shard
  (`(T, ny, nx)`), so a dataset is ~one shard object per variable.
- Codec chain (inner chunks): `bytes` → `zstd`.
