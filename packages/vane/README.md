# @rijwind/vane

Read and render `.vane` weather datasets in the browser. PMTiles, but for
weather data: one immutable file per model run, hosted on any static host or
CDN, read with HTTP range requests. No tile server.

A `.vane` file is a [Zarr v3](https://zarr.dev) sharded store packed into a
single file (spec in [`spec/`](https://github.com/Rijwind/vane/tree/main/spec)).
This package is the JavaScript reader plus a set of MapLibre render modes:

- `ColormapLayer` — scalar fields (temperature, precipitation, clouds, gusts)
- `ParticlesLayer` — GPU wind particles
- `ArrowsLayer` — instanced direction glyphs colored by speed
- `ContoursLayer` — isolines with labels (e.g. pressure)
- `ValuesLayer` — honest grid-point value labels

## Install

```sh
npm install @rijwind/vane maplibre-gl
```

`maplibre-gl` (>= 4) is a peer dependency. The only runtime dependency is
[`zarrita`](https://github.com/manzt/zarrita.js).

## Quick start

```ts
import { VaneDataset, ColormapLayer, ParticlesLayer } from "@rijwind/vane";

// Resolve a *_latest.json pointer and open the immutable .vane behind it.
const ds = await VaneDataset.openLatest(
  "https://weather.rijwind.com/knmi_harmonie_nl_latest.json",
);

map.addLayer(new ColormapLayer({ id: "temp", dataset: ds, variable: "temperature" }));
map.addLayer(new ParticlesLayer({ id: "wind", dataset: ds }));
```

Note the split: `ColormapLayer`, `ParticlesLayer` and `ArrowsLayer` are WebGL
custom layers (`map.addLayer(layer)`); `ValuesLayer` and `ContoursLayer` wrap
MapLibre style layers and go on the map with `layer.addTo(map)`.

Every layer has `setTimestep(t)` for time animation, and
`VaneDataset.getPointSeries(variable, lon, lat)` returns the full time series
at a point for meteograms.

Live demo with open KNMI / DWD / ECMWF data: <https://rijwind.com/weather>.

## Making .vane files

The Python writer and CLI (GRIB → regrid → quantize → Zarr v3 → `.vane`)
live in the same repo, together with a reference ingest pipeline:
<https://github.com/Rijwind/vane>.

## License

Apache-2.0 © Rijwind
