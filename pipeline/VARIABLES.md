# Variable catalog

The growing wiki of weather variables: what each source offers, what the
converters currently extract into `.vane` files, and per-variable notes.
Update this file **whenever a converter gains or loses a variable, or a new
source lands** (see CLAUDE.md). The machine-readable counterpart is the
`catalog.json` the pipeline publishes next to the data.

Legend: ✅ extracted into .vane today · ⬜ available at the source, not
extracted (usually a ~5-line converter change) · — not available.

## Surface variables × sources

| Variable | Unit | KNMI Harmonie P1 | KNMI radar | DWD ICON-EU | ECMWF IFS open | Notes |
|---|---|---|---|---|---|---|
| temperature (2m) | °C | ✅ (param 11, lvl 2) | — | ✅ (T_2M) | ⬜ | GRIB gives Kelvin; converters store °C |
| wind u/v (10m) | m/s | ✅ (33/34, lvl 10) | — | ✅ (U_10M/V_10M) | ⬜ | vector pair, `vector_group: wind` |
| precipitation rate | mm/h | ✅ (61, tri=4, differenced) | ✅ (calibrated, ×12) | ✅ (TOT_PREC, differenced) | ⬜ | model = accumulation → difference per step; radar = measured, much sharper |
| wind gusts (10m) | m/s | ✅ (162/163, tri=2 → magnitude) | — | ✅ (VMAX_10M, already magnitude) | ⬜ | stored as scalar `wind_gust` (hourly max); direction adds little over mean wind, halves bytes |
| dew point (2m) | °C | ⬜ (17, lvl 2) | — | ⬜ (TD_2M) | ⬜ | |
| relative humidity (2m) | % | ⬜ (52, lvl 2) | — | ⬜ (RELHUM_2M) | ⬜ | Harmonie source is fraction 0–1 → ×100 |
| pressure (MSL) | hPa | ✅ (1, levtype "103", Pa → /100) | — | ✅ (PMSL, Pa → /100) | ⬜ | `default_mode: contours`, `contour_interval: 4` |
| cloud cover total | % | ✅ (71, fraction → ×100) | — | ✅ (CLCT, already %) | ⬜ | P1 also has high/mid/low (75/74/73) |
| visibility | m | ⬜ (20) | — | ⬜ (VIS) | — | |
| snow depth | m | ⬜ (66) | — | ⬜ (H_SNOW) | ⬜ | |
| global radiation | W/m² | ⬜ (117, tri=4) | — | ⬜ (ASWDIR_S + ASWDIFD_S) | ⬜ | accumulated → difference, like precip |
| wind at 50/100/200/300m | m/s | ⬜ (33/34 at levels) | — | — | — | the wind-turbine niche set; needs the `level` dimension (structurally supported, not implemented in the writer yet) |

## Not in these sources (needs a different provider)

| Variable | Where it lives | Notes |
|---|---|---|
| UV index | Copernicus CAMS | own dataset + cadence; phase-3 candidate |
| air quality (PM, NO₂, O₃) | Copernicus CAMS | same |
| lightning / thunder | obs networks (e.g. KNMI lightning product); models only give convective *indicators* (CAPE, updraft helicity — P1 carries some) | "thunder risk" is a derived/styled product, not a raw field |
| waves / sea state | ECMWF WAM, KNMI North Sea products | separate grids |

## Conventions

- Physical units in metadata are renderer-facing: °C, mm/h, m/s, hPa, %.
- int16 + per-variable scale/offset (see spec/vane-metadata.md); pick scale
  so the full physical range fits in ±32767 with the sentinel reserved.
- Accumulated source fields (precip, radiation) are always converted to
  rates per step in the converter — `.vane` files never carry raw
  accumulations.
- Every variable extraction is one entry in the converter's select table +
  one `VaneVariable` spec. Adding one costs bytes in every published file
  (~3.5 MB per surface variable per Harmonie publication at 48h) — curate
  instead of extracting everything.
