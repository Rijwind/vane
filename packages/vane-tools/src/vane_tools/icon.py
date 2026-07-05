"""DWD ICON open data (ICON-EU + ICON-D2) → Vane variables.

Both nests are published as WMO-clean `regular-lat-lon` GRIB2 on
opendata.dwd.de — no regridding, no local tables (unlike Harmonie), and
each file holds exactly one message, so no in-file selection either:

- **ICON-EU** (`icon-eu_europe`): 0.0625°, 1377×657,
  29.5–70.5°N / 23.5°W–62.5°E. Main cycles 00/06/12/18Z reach 120h
  (intermediate 3h cycles stop at 30h and are skipped by the 48h probe).
- **ICON-D2** (`icon-d2_germany`): 0.02°, ~1215×746, central Europe.
  Runs every 3h, all reaching 48h. Filenames differ from EU in two ways:
  a `_2d` infix and a *lowercase* variable part
  (`…_000_2d_t_2m.grib2.bz2` vs EU's `…_000_T_2M.grib2.bz2`).

Shared gotchas handled here (see pipeline/SOURCES.md):
- GRIB2 longitudes are 0–360 (domains cross 0°) → wrapped to -180..180.
- jScansPositively=1 → rows flipped so row 0 = north.
- TOT_PREC is accumulated since run start → differenced to mm/h.
- VMAX_10M is already a gust *magnitude* (max over the previous output
  step), unlike Harmonie's u/v gust components.
- DWD keeps one run per cycle directory, replaced in place — a run is
  only used once its *last* needed file exists for every variable.
"""

from __future__ import annotations

import bz2
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np

from vane_tools.writer import VaneVariable

OPENDATA_BASE = "https://opendata.dwd.de/weather/nwp"

# our field key -> DWD variable name (directory is always lowercase)
_VARIABLES = {
    "t2m": "t_2m",
    "u10": "u_10m",
    "v10": "v_10m",
    "precip_accum": "tot_prec",
    "gust": "vmax_10m",
    "pressure_msl": "pmsl",
    "cloud_total": "clct",
}


@dataclass(frozen=True)
class IconModel:
    """Everything that differs between the ICON nests we ingest."""

    name: str  # opendata path segment, e.g. "icon-eu"
    product: str  # filename prefix, e.g. "icon-eu_europe"
    infix: str  # "" (EU) or "_2d" (D2)
    uppercase_var: bool  # EU filenames carry T_2M, D2 carries t_2m
    cycle_hours: int  # hours between (usable) runs
    source: str  # Vane metadata source string
    update_interval: int  # seconds, for the metadata


ICON_EU = IconModel(
    name="icon-eu", product="icon-eu_europe", infix="", uppercase_var=True,
    cycle_hours=6, source="dwd_icon_eu", update_interval=21600,
)
ICON_D2 = IconModel(
    name="icon-d2", product="icon-d2_germany", infix="_2d", uppercase_var=False,
    cycle_hours=3, source="dwd_icon_d2", update_interval=10800,
)


def file_name(model: IconModel, run: datetime, dwd_var: str, hour: int) -> str:
    stamp = run.astimezone(timezone.utc).strftime("%Y%m%d%H")
    var = dwd_var.upper() if model.uppercase_var else dwd_var
    return (
        f"{model.product}_regular-lat-lon_single-level_{stamp}_{hour:03d}{model.infix}_{var}.grib2"
    )


def file_url(model: IconModel, run: datetime, dwd_var: str, hour: int) -> str:
    return (
        f"{OPENDATA_BASE}/{model.name}/grib/{run:%H}/{dwd_var}/"
        f"{file_name(model, run, dwd_var, hour)}.bz2"
    )


def latest_complete_run(
    model: IconModel, *, max_hours: int = 48, now: datetime | None = None
) -> datetime:
    """Most recent run whose files exist through `max_hours` for every
    variable we extract (DWD publishes lead hours progressively)."""
    import requests

    now = now or datetime.now(timezone.utc)
    candidate = now.replace(minute=0, second=0, microsecond=0)
    candidate = candidate.replace(
        hour=candidate.hour - candidate.hour % model.cycle_hours
    )
    session = requests.Session()
    for _ in range(2 * 24 // model.cycle_hours):  # two days of cycles
        complete = all(
            session.head(
                file_url(model, candidate, var, max_hours), timeout=30
            ).status_code == 200
            for var in _VARIABLES.values()
        )
        if complete:
            return candidate
        candidate -= timedelta(hours=model.cycle_hours)
    raise RuntimeError(
        f"no complete {model.name} run found (checked back to {candidate})"
    )


def download_run(
    model: IconModel, grib_dir: Path, run: datetime, *, max_hours: int = 48, workers: int = 8
) -> None:
    """Fetch + decompress all (variable, lead hour) files; skips existing."""
    import requests

    grib_dir.mkdir(parents=True, exist_ok=True)
    session = requests.Session()

    def fetch(dwd_var: str, hour: int) -> None:
        dest = grib_dir / file_name(model, run, dwd_var, hour)
        if dest.exists():
            return
        response = session.get(file_url(model, run, dwd_var, hour), timeout=120)
        response.raise_for_status()
        tmp = dest.with_suffix(".tmp")
        tmp.write_bytes(bz2.decompress(response.content))
        tmp.rename(dest)

    jobs = [(var, hour) for var in _VARIABLES.values() for hour in range(max_hours + 1)]
    with ThreadPoolExecutor(max_workers=workers) as pool:
        for future in [pool.submit(fetch, var, hour) for var, hour in jobs]:
            future.result()  # propagate the first error


def _read_field(path: Path) -> tuple[np.ndarray, dict]:
    """Read the single GRIB2 message in an ICON file (row 0 = north)."""
    import eccodes

    with open(path, "rb") as f:
        gid = eccodes.codes_grib_new_from_file(f)
        if gid is None:
            raise ValueError(f"{path.name}: no GRIB message")
        try:
            ni = eccodes.codes_get(gid, "Ni")
            nj = eccodes.codes_get(gid, "Nj")
            values = eccodes.codes_get_values(gid).reshape(nj, ni)
            # ICON-D2's rotated domain doesn't fill its bounding rectangle;
            # the corners are bitmap-masked and read back as missingValue.
            if eccodes.codes_get(gid, "bitmapPresent") == 1:
                missing = eccodes.codes_get(gid, "missingValue")
                values = np.where(values == missing, np.nan, values)
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
    model: IconModel, grib_dir: Path, run: datetime, *, max_hours: int = 48
) -> tuple[list[VaneVariable], list[datetime], tuple[float, float, float, float]]:
    """Read downloaded ICON files into Vane variables (hours 0..max_hours)."""
    # The full-domain stacks are big (~180 MB float32 per variable, 7
    # variables); fill preallocated arrays and transform in place so the
    # peak stays ~1.5 GB instead of ~3 GB.
    hours = list(range(max_hours + 1))
    stacks: dict[str, np.ndarray] = {}
    grid: dict = {}
    for key, dwd_var in _VARIABLES.items():
        stack: np.ndarray | None = None
        for index, hour in enumerate(hours):
            values, g = _read_field(grib_dir / file_name(model, run, dwd_var, hour))
            grid = grid or g
            if stack is None:
                stack = np.empty((len(hours), *values.shape), dtype=np.float32)
            stack[index] = values
        stacks[key] = stack  # type: ignore[assignment]

    temp = stacks.pop("t2m")
    temp -= 273.15
    pressure = stacks.pop("pressure_msl")
    pressure /= 100.0  # Pa -> hPa
    # Accumulated since run start -> mm/h per step (steps are hourly).
    accum = stacks.pop("precip_accum")
    precip = np.diff(accum, axis=0, prepend=accum[:1])
    del accum
    np.clip(precip, 0.0, None, out=precip)

    timesteps = [run + timedelta(hours=h) for h in hours]
    bbox = (grid["west"], grid["south"], grid["east"], grid["north"])

    variables = [
        VaneVariable(
            "temperature", temp, unit="celsius", scale=0.01, offset=-50.0,
            extra_attrs={"default_colormap": "thermal", "default_clim": [-10, 35]},
        ),
        VaneVariable(
            "wind_u", stacks.pop("u10"), unit="m/s", scale=0.01,
            extra_attrs={"vector_group": "wind", "vector_component": "u"},
        ),
        VaneVariable(
            "wind_v", stacks.pop("v10"), unit="m/s", scale=0.01,
            extra_attrs={"vector_group": "wind", "vector_component": "v"},
        ),
        VaneVariable(
            "precipitation", precip, unit="mm/h", scale=0.01,
            extra_attrs={"default_colormap": "blues", "default_clim": [0, 10]},
        ),
        VaneVariable(
            "wind_gust", stacks.pop("gust"), unit="m/s", scale=0.01,
            extra_attrs={"default_colormap": "viridis", "default_clim": [0, 30]},
        ),
        VaneVariable(
            "pressure_msl", pressure, unit="hPa", scale=0.01, offset=1000.0,
            extra_attrs={"default_clim": [980, 1040], "default_mode": "contours",
                         "contour_interval": 4},
        ),
        VaneVariable(
            "cloud_cover", stacks.pop("cloud_total"), unit="%", scale=0.01,
            extra_attrs={"default_colormap": "clouds", "default_clim": [0, 100]},
        ),
    ]
    return variables, timesteps, bbox


def build_icon_vane(
    out_path: str | Path,
    model: IconModel,
    *,
    max_hours: int = 48,
    run: datetime | None = None,
    keep_grib: Path | None = None,
) -> tuple[Path, datetime]:
    """Download the latest complete run of `model` and write it as .vane."""
    import tempfile

    from vane_tools import container
    from vane_tools.writer import write_dataset

    run = run or latest_complete_run(model, max_hours=max_hours)
    workdir = keep_grib or Path(tempfile.mkdtemp(prefix=f"vane-{model.name}-"))
    print(f"downloading {model.name} {run:%Y-%m-%dT%H}Z (0..{max_hours}h, "
          f"{len(_VARIABLES)} variables) …")
    download_run(model, workdir, run, max_hours=max_hours)

    variables, timesteps, bbox = icon_files_to_variables(
        model, workdir, run, max_hours=max_hours
    )
    with tempfile.TemporaryDirectory() as tmp:
        store = Path(tmp) / "store.zarr"
        write_dataset(
            store,
            source=model.source,
            source_type="model",
            model_run=run,
            bbox=bbox,
            timesteps=timesteps,
            variables=variables,
            update_interval_seconds=model.update_interval,
        )
        container.pack(store, out_path)
    size = Path(out_path).stat().st_size
    print(f"wrote {out_path} ({size / 1e6:.1f} MB, {len(timesteps)} timesteps)")
    return Path(out_path), run


def build_icon_eu_vane(out_path: str | Path, **kwargs) -> tuple[Path, datetime]:
    return build_icon_vane(out_path, ICON_EU, **kwargs)


def build_icon_d2_vane(out_path: str | Path, **kwargs) -> tuple[Path, datetime]:
    return build_icon_vane(out_path, ICON_D2, **kwargs)
