# vane-tools

Python writer + CLI for Vane (`.vane`) weather datasets:
GRIB/HDF5 → regrid → quantize int16 → Zarr v3 sharded → single `.vane` file.

```bash
vane synth demo.vane          # synthetic NL dataset (no credentials needed)
vane knmi harmonie.vane       # latest KNMI Harmonie run (needs KNMI_API_KEY)
vane info demo.vane           # header + metadata + manifest
vane unpack demo.vane out/    # back to a plain Zarr v3 store (xarray-readable)
vane pack store.zarr out.vane # Zarr v3 directory store -> .vane
```

Part of the [Vane](../../README.md) monorepo. Working title — the PyPI
publish name is TBD. License: Apache-2.0.
