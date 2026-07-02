"""KNMI Harmonie cy43 P1 GRIB → Vane variables.

The P1 dataset ships one GRIB1 file per lead hour (HA43_N20_<run>_<HHH00>_GB)
on a regular lat/lon grid (390×390, 49–56°N / 0–11.28°E), so no regridding
is needed for this source. Parameters use KNMI's local GRIB1 table, which
generic tools don't know — we read messages directly with eccodes and select
on (indicatorOfParameter, levelType, level, timeRangeIndicator):

    (11, "sfc",   2, 0)  temperature 2m [K]
    (33, "sfc",  10, 0)  wind u 10m [m/s]
    (34, "sfc",  10, 0)  wind v 10m [m/s]
    (61, "sfc",   0, 4)  total precipitation, accumulated since run [kg/m²]

Precipitation is differenced between consecutive lead hours to mm/h.
"""

from __future__ import annotations

import re
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np

from vane_tools.writer import VaneVariable

_FILE_RE = re.compile(r"_(\d{5})_GB$")

_SELECT = {
    ("t2m", 11, "sfc", 2, 0),
    ("u10", 33, "sfc", 10, 0),
    ("v10", 34, "sfc", 10, 0),
    ("precip_accum", 61, "sfc", 0, 4),
}


def _lead_hour(path: Path) -> int | None:
    m = _FILE_RE.search(path.name)
    if not m:
        return None
    # suffix is HHH00 (lead hour * 100)
    return int(m.group(1)) // 100


def _read_fields(path: Path) -> tuple[dict[str, np.ndarray], dict]:
    import eccodes

    fields: dict[str, np.ndarray] = {}
    grid: dict = {}
    with open(path, "rb") as f:
        while True:
            gid = eccodes.codes_grib_new_from_file(f)
            if gid is None:
                break
            try:
                key = (
                    eccodes.codes_get(gid, "indicatorOfParameter"),
                    eccodes.codes_get(gid, "indicatorOfTypeOfLevel"),
                    eccodes.codes_get(gid, "level"),
                    eccodes.codes_get(gid, "timeRangeIndicator"),
                )
                for name, param, levtype, level, tri in _SELECT:
                    if key == (param, levtype, level, tri):
                        ni = eccodes.codes_get(gid, "Ni")
                        nj = eccodes.codes_get(gid, "Nj")
                        values = eccodes.codes_get_values(gid).reshape(nj, ni)
                        if eccodes.codes_get(gid, "jScansPositively") == 1:
                            values = values[::-1]  # row 0 = north
                        fields[name] = values
                        if not grid:
                            grid = {
                                "west": eccodes.codes_get(gid, "longitudeOfFirstGridPointInDegrees"),
                                "east": eccodes.codes_get(gid, "longitudeOfLastGridPointInDegrees"),
                                "south": eccodes.codes_get(gid, "latitudeOfFirstGridPointInDegrees"),
                                "north": eccodes.codes_get(gid, "latitudeOfLastGridPointInDegrees"),
                            }
            finally:
                eccodes.codes_release(gid)
    missing = {name for name, *_ in _SELECT} - set(fields)
    if missing:
        raise ValueError(f"{path.name}: missing expected GRIB messages: {sorted(missing)}")
    return fields, grid


def harmonie_tar_to_variables(
    grib_dir: Path, *, max_hours: int = 24
) -> tuple[list[VaneVariable], list[datetime], tuple[float, float, float, float]]:
    """Read extracted P1 GRIB files into Vane variables (hours 0..max_hours)."""
    by_hour: dict[int, Path] = {}
    for path in grib_dir.iterdir():
        hour = _lead_hour(path)
        if hour is not None and hour <= max_hours:
            by_hour[hour] = path
    if not by_hour:
        raise ValueError(f"no HA43 GRIB files found in {grib_dir}")
    hours = sorted(by_hour)

    run_match = re.search(r"_(\d{12})_", by_hour[hours[0]].name)
    if not run_match:
        raise ValueError("cannot parse run timestamp from GRIB filename")
    run_time = datetime.strptime(run_match.group(1), "%Y%m%d%H%M").replace(tzinfo=timezone.utc)

    temps, us, vs, accums = [], [], [], []
    grid: dict = {}
    for hour in hours:
        fields, g = _read_fields(by_hour[hour])
        grid = grid or g
        temps.append(fields["t2m"] - 273.15)
        us.append(fields["u10"])
        vs.append(fields["v10"])
        accums.append(fields["precip_accum"])

    temp = np.stack(temps)
    wind_u = np.stack(us)
    wind_v = np.stack(vs)
    accum = np.stack(accums)
    # Accumulated since run start -> mm/h per step (steps are hourly).
    precip = np.diff(accum, axis=0, prepend=accum[:1])
    precip = np.clip(precip, 0.0, None)

    timesteps = [run_time + timedelta(hours=h) for h in hours]
    bbox = (grid["west"], grid["south"], grid["east"], grid["north"])

    variables = [
        VaneVariable(
            "temperature", temp, unit="celsius", scale=0.01, offset=-50.0,
            extra_attrs={"default_colormap": "thermal", "default_clim": [-10, 35]},
        ),
        VaneVariable(
            "wind_u", wind_u, unit="m/s", scale=0.01,
            extra_attrs={"vector_group": "wind", "vector_component": "u"},
        ),
        VaneVariable(
            "wind_v", wind_v, unit="m/s", scale=0.01,
            extra_attrs={"vector_group": "wind", "vector_component": "v"},
        ),
        VaneVariable(
            "precipitation", precip, unit="mm/h", scale=0.01,
            extra_attrs={"default_colormap": "blues", "default_clim": [0, 10]},
        ),
    ]
    return variables, timesteps, bbox
