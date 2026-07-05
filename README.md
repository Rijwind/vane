# Vane

> *PMTiles, but for weather data.*

Vane is an open render layer + tooling for putting open gridded weather data
(temperature, precipitation, wind, cloud cover, radar, …) on a web map
**directly from object storage** — no tile server, no proprietary API.

Under the hood a Vane dataset is a standard **Zarr v3 store with the sharding
codec**. The `.vane` file is a thin single-file container over that store: a
small header + manifest maps Zarr store keys to byte ranges, so a browser can
read any chunk with plain HTTP range requests against a single static file on
any CDN. A `.vane` can always be unpacked back into a regular Zarr store that
xarray reads natively.

## Packages

| Package | What | Status |
|---|---|---|
| [`packages/vane`](packages/vane) | TypeScript reader (`.vane` → zarrita store) + MapLibre render modes (`colormap`, `particles`, `arrows`, `contours`, `values`) | WIP |
| [`packages/vane-tools`](packages/vane-tools) | Python writer + CLI: GRIB/HDF5 → regrid → quantize → Zarr v3 sharded → `.vane` | WIP |
| [`spec/`](spec) | `.vane` container spec + Vane metadata convention | draft |
| [`examples/demo`](examples/demo) | MapLibre demo: all render modes on live model + radar data, time slider, point meteograms | working |
| [`pipeline/`](pipeline) | Fetch → convert → publish immutably (timestamped `.vane` + `latest.json` pointer + pruning) | working (Harmonie, radar, ICON-EU, ICON-D2, ECMWF IFS) |

## Render modes

Capabilities live here (OSS); *styling choices* (colors, clims, opacities)
are parameters the consumer sets. Available:

- `colormap` — any scalar field; banded/stepped maps work today by
  repeating stops at the same value (WebGL custom layer).
- `particles` — animated flow for any u/v vector group (WebGL custom layer).
- `arrows` — instanced direction arrows for a vector group, screen-sized,
  colored by speed (WebGL custom layer).
- `contours` — isolines (isobars, isotherms) with line labels; marching
  squares + simplification on the CPU, display via MapLibre line/symbol
  layers (`layer.addTo(map)`).
- `values` — the field as a grid of numbers, honest unsmoothed samples on
  true grid points (`layer.addTo(map)`).

Planned: wind barbs (a fiddlier `arrows` glyph set).

## Why

Open weather data (KNMI, DWD, ECMWF, NOAA, Copernicus) is abundant but
unusable in the browser in raw form: GRIB/HDF5 are opaque binary formats, a
forecast is dozens of loose files, and every existing serving option needs a
running backend that re-tiles to PNG. Vane makes one immutable file per model
run that a browser renders directly — the same trick PMTiles pulled for map
tiles, built on the Zarr standard the Copernicus/Pangeo world already runs on.

## License

Apache-2.0. Weather data rendered in the examples: © KNMI, CC-BY-4.0.
