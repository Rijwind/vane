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

## DWD ICON-EU + ICON-D2 (implemented — `icon.py`)

- **Good news:** DWD publishes the EU nest and D2 as
  `regular-lat-lon` GRIB2 files on opendata.dwd.de — the icosahedral-grid
  problem does **not** apply to these. Regular files have earth-relative
  winds. WMO-clean GRIB2: no local tables, and each file holds exactly
  one message, so no in-file selection either.
- One file per (run, leadtime, variable) — many small downloads (~340 for
  a 48h run, bzip2'd; fetched with a small thread pool).
- Longitude 0–360 wrap applies (first point 336.5° → -23.5).
  `jScansPositively=1` → flip rows. Grid 1377×657 @ 0.0625°,
  29.5–70.5°N / 23.5°W–62.5°E.
- `TOT_PREC` accumulated since run start → difference to mm/h.
  `VMAX_10M` is already a gust **magnitude** (max over the previous output
  step) — no u/v pair like Harmonie. `CLCT` is % 0–100, `PMSL` in Pa.
- **Run availability:** one run per cycle directory, replaced in place;
  main cycles 00/06/12/18Z reach 120h, intermediate 03/09/15/21Z only 30h
  (we skip those). Completeness = the *last* needed lead hour exists for
  every variable (`latest_complete_run` HEAD-probes those). A run appears
  ~2.5–3.5h after cycle time.
- **Size note:** the full-domain fields are ~1.1 MB/step/variable at the
  current int16 `scale=0.01` — a 48h publication ≈ 300 MB. If that ever
  hurts, the knob is coarser quantization (e.g. 0.05 °C) or fewer
  variables, not the format.
- **ICON-D2 specifics** (same converter, `IconModel` config): 0.02°
  (~2.2 km), central Europe, runs every 3h, all reaching 48h. Filenames
  differ from EU twice over: a `_2d` infix AND a lowercase variable part
  (`…_000_2d_t_2m` vs EU's `…_000_T_2M`). **The rotated D2 domain doesn't
  fill its regular-lat-lon bounding box** — the corners are bitmap-masked
  and read back as `missingValue` (9999); map them to NaN or they render
  as clim-max garbage. (`bitmapPresent` check in `_read_field`, applies
  to any source.)

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

## ECMWF IFS open data (implemented — `ecmwf.py`)

- Open data is GRIB2, 0.25° regular global grid (1440×721), CC-BY-4.0,
  no key. One file per (run, step) with **all** parameters + a `.index`
  sidecar (JSON lines with `_offset`/`_length` per message) → fetch the
  index, then one HTTP range request per wanted field: a 48h ingest
  moves ~50 MB, not multi-GB files.
- Layout `data.ecmwf.int/forecasts/YYYYMMDD/HHz/ifs/0p25/oper/…`.
  Published ~7–8h after cycle time, steps progressively — probe the
  *last* step's index.
- **All four cycles use the `oper` stream.** ECMWF open data historically
  split 06/18Z into a shorter `scda` stream, but that stream is no longer
  disseminated: there is no `.../0p25/scda/` directory and every scda URL
  404s. We used to build `scda` URLs for 06/18Z, so `latest_complete_run`
  got a 404 on those cycles' last-step index and stepped back to the
  previous 00/12Z run — silently publishing only **2 runs/day** instead
  of 4. Fixed 2026-07-07 (probe: only `enfo`/`oper`/`waef` dirs exist,
  `oper` reaches 144h for 06/18Z).
- Steps are **3-hourly** (not hourly) to 144h; `timesteps` metadata
  carries the real times.
- **Global grid starts at 0°** → roll columns so the array starts at
  -180 (classic "Europe on the wrong side" wrap, plus Vane bboxes are
  -180..180). Verified against eccodes' own nearest-neighbor on three
  continents.
- Unit quirks: `tp` is accumulated **meters** (→ ×1000, difference, ÷3
  → mm/h); `tcc` is a 0–1 fraction (→ ×100); `10fg` is already a gust
  magnitude (max since previous step).
- Renderer note: a bbox reaching ±90° must be clamped to web-mercator's
  ±85.051° when projecting (done in `packages/vane` `gl.ts`/arrows).

## Tooling notes

- **eccodes** (used) — low-level GRIB access; the only reliable route for
  local-table GRIB1 like Harmonie.
- **cfgrib + xarray** — fine for WMO-clean GRIB2 (ECMWF, ICON regular files).
- **wgrib2** — the reference for regridding + wind rotation
  (`-new_grid_winds earth`); shell out if we ever need Lambert sources.
- **CDO** — needed only for ICON-global icosahedral remap.
- **gribmagic** (unmaintained) — good *reference* for multi-provider
  download orchestration; don't depend on it.
