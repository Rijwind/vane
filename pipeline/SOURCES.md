# Per-source gotchas

Every NWP provider ships its own surprises. The rule in this repo: **one
converter module per source** (`vane_tools/harmonie.py`, `vane_tools/radar.py`,
…) that encapsulates all of them — the pipeline and the format never see
source quirks. This file is the checklist per source; keep it updated when a
converter learns something new.

## Checklist for any new source

- [ ] **GRIB edition** — GRIB1 or GRIB2? Local parameter tables? (cfgrib
      only understands WMO-standard metadata; with local tables, read with
      eccodes directly and select on raw keys.)
- [ ] **Grid** — regular lat/lon? rotated pole? Lambert? icosahedral? If not
      regular: regrid in the converter (pyproj/CDO), record method + target
      resolution.
- [ ] **Longitude convention** — GRIB2 uses 0–360°; browsers and the Vane
      bbox expect -180/+180. Wrap in the converter. Classic symptom: Europe
      renders at the wrong side of the map.
- [ ] **Wind reference frame** — u/v may be grid-relative instead of
      earth-relative (north-up). Rotated/Lambert grids need vector rotation
      (`wgrib2 -new_grid_winds earth` or manual). Wrong = particles/arrows
      point the wrong way, subtly.
- [ ] **Accumulated fields** — precipitation/radiation are usually
      accumulated since run start (difference consecutive steps) or over
      windows that reset (GFS: 6h windows). Check `timeRangeIndicator` /
      `stepRange` semantics per field.
- [ ] **Scan order** — `jScansPositively` etc.; normalize to row 0 = north.
- [ ] **Run availability & latency** — when is a run complete on the open
      data endpoint? Partial runs must not be published.

## KNMI Harmonie cy43 P1 (implemented — `harmonie.py`)

- **GRIB1** with KNMI-local parameter tables — cfgrib decodes everything as
  "unknown". We read with eccodes and select on
  `(indicatorOfParameter, indicatorOfTypeOfLevel, level, timeRangeIndicator)`.
- Grid is **already regular lat/lon** (390×390, 49–56°N / 0–11.28°E,
  0.029°×0.018°), earth-relative winds. `jScansPositively=1` → flip rows.
- Precipitation (param 61, tri=4) is **accumulated since run start**;
  difference consecutive hourly steps → mm/h. (No ensemble handling — P1 is
  deterministic; the "subtract the first shared hour across members" rule
  applies to ensemble products like Harmonie EPS, not here.)
- One tar per run (~858 MB), one GRIB per lead hour, **hourly runs**, ~49–61
  lead hours. Anonymous API key exists (developer portal; rate-limited,
  shared).

## KNMI radar (planned — `radar.py`)

- HDF5, **polar stereographic** projection → needs regridding to regular
  lat/lon (pyproj), unlike Harmonie.
- Pixel values are scaled ints with a calibration formula in the HDF5 attrs.
- 5-minute cadence; nowcast product carries +2h of 5-min steps.

## DWD ICON-EU / ICON-D2 (phase 3)

- **Good news:** DWD publishes the EU nest and D2 as
  `regular-lat-lon` GRIB2 files on opendata.dwd.de — the icosahedral-grid
  problem does **not** apply to these. Regular files have earth-relative
  winds.
- One file per (run, leadtime, variable) — many small downloads; bzip2'd.
- Longitude 0–360 wrap applies.

## DWD ICON global (phase 3+, only if we want it)

- Native **icosahedral grid**; raw GRIBs carry **no lat/lon** — separate
  CLON/CLAT grid-description files, and remapping to regular lat/lon is
  mandatory (CDO with DWD's remap weights, or gribmagic as reference).
  Real extra pipeline stage; decide resolution + interpolation method.

## NOAA GFS (phase 3)

- GRIB2 with **NCEP-custom encodings**; some fields (level ranges) decode as
  NaN in cfgrib. Precipitation/radiation carry **double accumulations**
  (current window + total) with 6-hourly resets — disambiguate via stepRange,
  and use the `.idx` sidecar files (also handy for byte-range subsetting so
  you download only the fields you need).
- Longitude 0–360 wrap applies.

## ECMWF IFS open data (phase 3)

- Open data is GRIB2, 0.25° regular grid, CC-BY-4.0. The GRIB1→GRIB2
  migration only matters for archive products (ERA5) — not for the real-time
  open data feed.
- Longitude 0–360 wrap applies.

## Tooling notes

- **eccodes** (used) — low-level GRIB access; the only reliable route for
  local-table GRIB1 like Harmonie.
- **cfgrib + xarray** — fine for WMO-clean GRIB2 (ECMWF, ICON regular files).
- **wgrib2** — the reference for regridding + wind rotation
  (`-new_grid_winds earth`); shell out if we ever need Lambert sources.
- **CDO** — needed only for ICON-global icosahedral remap.
- **gribmagic** (unmaintained) — good *reference* for multi-provider
  download orchestration; don't depend on it.
