"""DWD ICON-EU open data → Vane variables.

ICON-EU's "europe regular-lat-lon" product is WMO-clean GRIB2 on a regular
0.0625° grid (1377×657, 29.5–70.5°N / 23.5°W–62.5°E), earth-relative winds
— no regridding, no local tables (unlike Harmonie). Downloads come from
https://opendata.dwd.de/weather/nwp/icon-eu/grib/<HH>/<var>/, one bzip2'd
file per (run, lead hour, variable); each file holds exactly one GRIB
message, so no in-file selection is needed either.

Gotchas handled here (see pipeline/SOURCES.md):
- GRIB2 longitudes are 0–360 (first point 336.5°) → wrapped to -23.5.
- jScansPositively=1 → rows flipped so row 0 = north.
- TOT_PREC is accumulated since run start → differenced to mm/h.
- VMAX_10M is already a gust *magnitude* (max over the previous output
  step), unlike Harmonie's u/v gust components.
- Only the main cycles (00/06/12/18Z) reach 48h+; the intermediate
  03/09/15/21Z runs stop at 30h and are skipped.
- DWD keeps one run per cycle directory, replaced in place — a run is
  only used once its *last* file exists for every variable.
"""

from __future__ import annotations

import bz2
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np

from vane_tools.writer import VaneVariable

OPENDATA_BASE = "https://opendata.dwd.de/weather/nwp/icon-eu/grib"
MAIN_CYCLES = (0, 6, 12, 18)

# our field key -> DWD variable name (directory is lowercase, filename upper)
_VARIABLES = {
    "t2m": "t_2m",
    "u10": "u_10m",
    "v10": "v_10m",
    "precip_accum": "tot_prec",
    "gust": "vmax_10m",
    "pressure_msl": "pmsl",
    "cloud_total": "clct",
}


def file_name(run: datetime, dwd_var: str, hour: int) -> str:
    stamp = run.astimezone(timezone.utc).strftime("%Y%m%d%H")
    return (
        f"icon-eu_europe_regular-lat-lon_single-level_{stamp}_{hour:03d}_{dwd_var.upper()}.grib2"
    )


def file_url(run: datetime, dwd_var: str, hour: int) -> str:
    return (
        f"{OPENDATA_BASE}/{run:%H}/{dwd_var}/{file_name(run, dwd_var, hour)}.bz2"
    )


def latest_complete_run(*, max_hours: int = 48, now: datetime | None = None) -> datetime:
    """Most recent main-cycle run whose files exist through `max_hours` for
    every variable we extract (DWD publishes lead hours progressively)."""
    import requests

    now = now or datetime.now(timezone.utc)
    candidate = now.replace(minute=0, second=0, microsecond=0)
    candidate = candidate.replace(hour=max(c for c in MAIN_CYCLES if c <= candidate.hour))
    session = requests.Session()
    for _ in range(8):  # two days of main cycles
        complete = all(
            session.head(file_url(candidate, var, max_hours), timeout=30).status_code == 200
            for var in _VARIABLES.values()
        )
        if complete:
            return candidate
        candidate -= timedelta(hours=6)
    raise RuntimeError(f"no complete ICON-EU run found (checked back to {candidate})")


def download_run(
    grib_dir: Path, run: datetime, *, max_hours: int = 48, workers: int = 8
) -> None:
    """Fetch + decompress all (variable, lead hour) files; skips existing."""
    import requests

    grib_dir.mkdir(parents=True, exist_ok=True)
    session = requests.Session()

    def fetch(dwd_var: str, hour: int) -> None:
        dest = grib_dir / file_name(run, dwd_var, hour)
        if dest.exists():
            return
        response = session.get(file_url(run, dwd_var, hour), timeout=120)
        response.raise_for_status()
        tmp = dest.with_suffix(".tmp")
        tmp.write_bytes(bz2.decompress(response.content))
        tmp.rename(dest)

    jobs = [(var, hour) for var in _VARIABLES.values() for hour in range(max_hours + 1)]
    with ThreadPoolExecutor(max_workers=workers) as pool:
        for future in [pool.submit(fetch, var, hour) for var, hour in jobs]:
            future.result()  # propagate the first error


def _read_field(path: Path) -> tuple[np.ndarray, dict]:
    """Read the single GRIB2 message in an ICON-EU file (row 0 = north)."""
    import eccodes

    with open(path, "rb") as f:
        gid = eccodes.codes_grib_new_from_file(f)
        if gid is None:
            raise ValueError(f"{path.name}: no GRIB message")
        try:
            ni = eccodes.codes_get(gid, "Ni")
            nj = eccodes.codes_get(gid, "Nj")
            values = eccodes.codes_get_values(gid).reshape(nj, ni)
            if eccodes.codes_get(gid, "jScansPositively") == 1:
                values = values[::-1]
            west = eccodes.codes_get(gid, "longitudeOfFirstGridPointInDegrees")
            east = eccodes.codes_get(gid, "longitudeOfLastGridPointInDegrees")
            south = min(
                eccodes.codes_get(gid, "latitudeOfFirstGridPointInDegrees"),
                eccodes.codes_get(gid, "latitudeOfLastGridPointInDegrees"),
            )
            north = max(
                eccodes.codes_get(gid, "latitudeOfFirstGridPointInDegrees"),
                eccodes.codes_get(gid, "latitudeOfLastGridPointInDegrees"),
            )
            grid = {
                # GRIB2 longitudes are 0–360; Vane bboxes are -180..180.
                "west": west - 360.0 if west > 180.0 else west,
                "east": east - 360.0 if east > 180.0 else east,
                "south": south,
                "north": north,
            }
            return values, grid
        finally:
            eccodes.codes_release(gid)


def icon_files_to_variables(
    grib_dir: Path, run: datetime, *, max_hours: int = 48
) -> tuple[list[VaneVariable], list[datetime], tuple[float, float, float, float]]:
    """Read downloaded ICON-EU files into Vane variables (hours 0..max_hours)."""
    hours = list(range(max_hours + 1))
    stacks: dict[str, np.ndarray] = {}
    grid: dict = {}
    for key, dwd_var in _VARIABLES.items():
        fields = []
        for hour in hours:
            values, g = _read_field(grib_dir / file_name(run, dwd_var, hour))
            grid = grid or g
            fields.append(values.astype(np.float32))
        stacks[key] = np.stack(fields)

    temp = stacks["t2m"] - 273.15
    pressure = stacks["pressure_msl"] / 100.0  # Pa -> hPa
    # Accumulated since run start -> mm/h per step (steps are hourly).
    accum = stacks["precip_accum"]
    precip = np.diff(accum, axis=0, prepend=accum[:1])
    precip = np.clip(precip, 0.0, None)

    timesteps = [run + timedelta(hours=h) for h in hours]
    bbox = (grid["west"], grid["south"], grid["east"], grid["north"])

    variables = [
        VaneVariable(
            "temperature", temp, unit="celsius", scale=0.01, offset=-50.0,
            extra_attrs={"default_colormap": "thermal", "default_clim": [-10, 35]},
        ),
        VaneVariable(
            "wind_u", stacks["u10"], unit="m/s", scale=0.01,
            extra_attrs={"vector_group": "wind", "vector_component": "u"},
        ),
        VaneVariable(
            "wind_v", stacks["v10"], unit="m/s", scale=0.01,
            extra_attrs={"vector_group": "wind", "vector_component": "v"},
        ),
        VaneVariable(
            "precipitation", precip, unit="mm/h", scale=0.01,
            extra_attrs={"default_colormap": "blues", "default_clim": [0, 10]},
        ),
        VaneVariable(
            "wind_gust", stacks["gust"], unit="m/s", scale=0.01,
            extra_attrs={"default_colormap": "viridis", "default_clim": [0, 30]},
        ),
        VaneVariable(
            "pressure_msl", pressure, unit="hPa", scale=0.01, offset=1000.0,
            extra_attrs={"default_clim": [980, 1040], "default_mode": "contours",
                         "contour_interval": 4},
        ),
        VaneVariable(
            "cloud_cover", stacks["cloud_total"], unit="%", scale=0.01,
            extra_attrs={"default_colormap": "clouds", "default_clim": [0, 100]},
        ),
    ]
    return variables, timesteps, bbox


def build_icon_eu_vane(
    out_path: str | Path,
    *,
    max_hours: int = 48,
    run: datetime | None = None,
    keep_grib: Path | None = None,
) -> tuple[Path, datetime]:
    """Download the latest complete ICON-EU run and write it as .vane."""
    import tempfile

    from vane_tools import container
    from vane_tools.writer import write_dataset

    run = run or latest_complete_run(max_hours=max_hours)
    workdir = keep_grib or Path(tempfile.mkdtemp(prefix="vane-icon-"))
    print(f"downloading ICON-EU {run:%Y-%m-%dT%H}Z (0..{max_hours}h, "
          f"{len(_VARIABLES)} variables) …")
    download_run(workdir, run, max_hours=max_hours)

    variables, timesteps, bbox = icon_files_to_variables(workdir, run, max_hours=max_hours)
    with tempfile.TemporaryDirectory() as tmp:
        store = Path(tmp) / "store.zarr"
        write_dataset(
            store,
            source="dwd_icon_eu",
            source_type="model",
            model_run=run,
            bbox=bbox,
            timesteps=timesteps,
            variables=variables,
            update_interval_seconds=21600,
        )
        container.pack(store, out_path)
    size = Path(out_path).stat().st_size
    print(f"wrote {out_path} ({size / 1e6:.1f} MB, {len(timesteps)} timesteps)")
    return Path(out_path), run
