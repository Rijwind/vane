"""ECMWF IFS 0.25° open data → Vane variables.

The open-data feed (CC-BY-4.0, no key) publishes one GRIB2 file per
(run, step) carrying *all* parameters, plus a `.index` sidecar of JSON
lines with the byte offset/length of every message. We fetch the small
index, then issue one HTTP range request per wanted field — a full
48h/7-variable ingest transfers ~50 MB instead of multi-GB files.

Layout: https://data.ecmwf.int/forecasts/YYYYMMDD/HHz/ifs/0p25/<stream>/
        YYYYMMDDHHMMSS-<step>h-<stream>-fc.grib2[.index]
where stream = "oper" for the 00/12Z cycles and "scda" for 06/18Z.

Source gotchas (see pipeline/SOURCES.md):
- Global 0.25° grid (1440×721), longitudes 0–359.75 → columns rolled so
  the grid starts at -180 (Vane bboxes are -180..180).
- `tp` is accumulated since run start in **meters** → ×1000, differenced,
  ÷3 (3-hourly steps) → mm/h.
- `tcc` is a 0–1 fraction → ×100 to %.
- `10fg` is the max gust since the previous step — already a magnitude.
- Steps are 3-hourly (0..144 by 3); the `timesteps` metadata carries the
  real times, so mixed-cadence clients stay honest.
"""

from __future__ import annotations

import json
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np

from vane_tools.writer import VaneVariable

FORECASTS_BASE = "https://data.ecmwf.int/forecasts"
CYCLES = (0, 6, 12, 18)
STEP_HOURS = 3

# our field key -> ECMWF index param shortname (levtype sfc)
_PARAMS = {
    "t2m": "2t",
    "u10": "10u",
    "v10": "10v",
    "precip_accum": "tp",
    "gust": "10fg",
    "pressure_msl": "msl",
    "cloud_total": "tcc",
}


def _stream(run: datetime) -> str:
    return "oper" if run.hour in (0, 12) else "scda"


def data_url(run: datetime, step: int) -> str:
    stream = _stream(run)
    stamp = run.astimezone(timezone.utc)
    return (
        f"{FORECASTS_BASE}/{stamp:%Y%m%d}/{stamp:%H}z/ifs/0p25/{stream}/"
        f"{stamp:%Y%m%d%H%M%S}-{step}h-{stream}-fc.grib2"
    )


def index_url(run: datetime, step: int) -> str:
    return data_url(run, step).removesuffix(".grib2") + ".index"


def _steps(max_hours: int) -> list[int]:
    return list(range(0, max_hours + 1, STEP_HOURS))


def latest_complete_run(*, max_hours: int = 48, now: datetime | None = None) -> datetime:
    """Most recent cycle whose final step index exists (ECMWF publishes
    open data ~7–8h after cycle time, steps progressively)."""
    import requests

    now = now or datetime.now(timezone.utc)
    candidate = now.replace(minute=0, second=0, microsecond=0)
    candidate = candidate.replace(hour=max(c for c in CYCLES if c <= candidate.hour))
    session = requests.Session()
    for _ in range(8):  # two days of cycles
        if session.head(index_url(candidate, _steps(max_hours)[-1]), timeout=30).status_code == 200:
            return candidate
        candidate -= timedelta(hours=6)
    raise RuntimeError(f"no complete ECMWF run found (checked back to {candidate})")


def _field_ranges(index_text: str) -> dict[str, tuple[int, int]]:
    """param -> (offset, length) for our surface fields in one step index."""
    wanted = set(_PARAMS.values())
    ranges: dict[str, tuple[int, int]] = {}
    for line in index_text.splitlines():
        if not line.strip():
            continue
        entry = json.loads(line)
        if entry.get("param") in wanted and entry.get("levtype") == "sfc" \
                and "levelist" not in entry:
            ranges[entry["param"]] = (entry["_offset"], entry["_length"])
    missing = wanted - set(ranges)
    if missing:
        raise ValueError(f"index missing params: {sorted(missing)}")
    return ranges


def grib_name(run: datetime, step: int, param: str) -> str:
    return f"ecmwf_{run:%Y%m%d%H}_{step:03d}_{param}.grib2"


def download_run(
    grib_dir: Path, run: datetime, *, max_hours: int = 48, workers: int = 8
) -> None:
    """Fetch the wanted fields of every step via index + range requests."""
    import requests

    grib_dir.mkdir(parents=True, exist_ok=True)
    session = requests.Session()

    def fetch_step(step: int) -> None:
        if all((grib_dir / grib_name(run, step, p)).exists() for p in _PARAMS.values()):
            return
        response = session.get(index_url(run, step), timeout=60)
        response.raise_for_status()
        for param, (offset, length) in _field_ranges(response.text).items():
            dest = grib_dir / grib_name(run, step, param)
            if dest.exists():
                continue
            ranged = session.get(
                data_url(run, step),
                headers={"Range": f"bytes={offset}-{offset + length - 1}"},
                timeout=120,
            )
            ranged.raise_for_status()
            if len(ranged.content) != length:  # server ignored the Range header?
                raise RuntimeError(f"range request returned {len(ranged.content)} != {length}")
            tmp = dest.with_suffix(".tmp")
            tmp.write_bytes(ranged.content)
            tmp.rename(dest)

    with ThreadPoolExecutor(max_workers=workers) as pool:
        for future in [pool.submit(fetch_step, s) for s in _steps(max_hours)]:
            future.result()  # propagate the first error


def _read_field(path: Path) -> tuple[np.ndarray, dict]:
    """Read one global GRIB2 message: row 0 = north, columns rolled so the
    grid starts at longitude -180."""
    import eccodes

    with open(path, "rb") as f:
        gid = eccodes.codes_grib_new_from_file(f)
        if gid is None:
            raise ValueError(f"{path.name}: no GRIB message")
        try:
            ni = eccodes.codes_get(gid, "Ni")
            nj = eccodes.codes_get(gid, "Nj")
            values = eccodes.codes_get_values(gid).reshape(nj, ni)
            if eccodes.codes_get(gid, "bitmapPresent") == 1:
                missing = eccodes.codes_get(gid, "missingValue")
                values = np.where(values == missing, np.nan, values)
            if eccodes.codes_get(gid, "jScansPositively") == 1:
                values = values[::-1]
            lon_first = eccodes.codes_get(gid, "longitudeOfFirstGridPointInDegrees")
            inc = eccodes.codes_get(gid, "iDirectionIncrementInDegrees")
            south = min(
                eccodes.codes_get(gid, "latitudeOfFirstGridPointInDegrees"),
                eccodes.codes_get(gid, "latitudeOfLastGridPointInDegrees"),
            )
            north = max(
                eccodes.codes_get(gid, "latitudeOfFirstGridPointInDegrees"),
                eccodes.codes_get(gid, "latitudeOfLastGridPointInDegrees"),
            )
            # Roll so column 0 sits at -180° (source grids start at 0°).
            lons = (lon_first + np.arange(ni) * inc) % 360.0
            lons_wrapped = np.where(lons >= 180.0, lons - 360.0, lons)
            start = int(np.argmin(lons_wrapped))
            values = np.roll(values, -start, axis=1)
            west = float(lons_wrapped[start])
            east = west + (ni - 1) * inc
            grid = {"west": west, "east": east, "south": south, "north": north}
            return values, grid
        finally:
            eccodes.codes_release(gid)


def ecmwf_files_to_variables(
    grib_dir: Path, run: datetime, *, max_hours: int = 48
) -> tuple[list[VaneVariable], list[datetime], tuple[float, float, float, float]]:
    steps = _steps(max_hours)
    stacks: dict[str, np.ndarray] = {}
    grid: dict = {}
    for key, param in _PARAMS.items():
        stack: np.ndarray | None = None
        for index, step in enumerate(steps):
            values, g = _read_field(grib_dir / grib_name(run, step, param))
            grid = grid or g
            if stack is None:
                stack = np.empty((len(steps), *values.shape), dtype=np.float32)
            stack[index] = values
        stacks[key] = stack  # type: ignore[assignment]

    temp = stacks.pop("t2m")
    temp -= 273.15
    pressure = stacks.pop("pressure_msl")
    pressure /= 100.0  # Pa -> hPa
    cloud = stacks.pop("cloud_total")
    cloud *= 100.0  # fraction -> %
    # Accumulated since run start in meters -> mm/h over 3-hourly steps.
    accum = stacks.pop("precip_accum")
    accum *= 1000.0  # m -> mm
    precip = np.diff(accum, axis=0, prepend=accum[:1])
    del accum
    precip /= STEP_HOURS
    np.clip(precip, 0.0, None, out=precip)

    timesteps = [run + timedelta(hours=s) for s in steps]
    bbox = (grid["west"], grid["south"], grid["east"], grid["north"])

    variables = [
        VaneVariable(
            "temperature", temp, unit="celsius", scale=0.01, offset=-50.0,
            extra_attrs={"default_colormap": "thermal", "default_clim": [-30, 45]},
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
            extra_attrs={"default_colormap": "viridis", "default_clim": [0, 35]},
        ),
        VaneVariable(
            "pressure_msl", pressure, unit="hPa", scale=0.01, offset=1000.0,
            extra_attrs={"default_clim": [950, 1050], "default_mode": "contours",
                         "contour_interval": 4},
        ),
        VaneVariable(
            "cloud_cover", cloud, unit="%", scale=0.01,
            extra_attrs={"default_colormap": "clouds", "default_clim": [0, 100]},
        ),
    ]
    return variables, timesteps, bbox


def build_ecmwf_vane(
    out_path: str | Path,
    *,
    max_hours: int = 48,
    run: datetime | None = None,
    keep_grib: Path | None = None,
) -> tuple[Path, datetime]:
    """Download the latest complete IFS open-data run and write it as .vane."""
    import tempfile

    from vane_tools import container
    from vane_tools.writer import write_dataset

    run = run or latest_complete_run(max_hours=max_hours)
    workdir = keep_grib or Path(tempfile.mkdtemp(prefix="vane-ecmwf-"))
    print(f"downloading ECMWF IFS {run:%Y-%m-%dT%H}Z (0..{max_hours}h by {STEP_HOURS}, "
          f"{len(_PARAMS)} fields via index ranges) …")
    download_run(workdir, run, max_hours=max_hours)

    variables, timesteps, bbox = ecmwf_files_to_variables(workdir, run, max_hours=max_hours)
    with tempfile.TemporaryDirectory() as tmp:
        store = Path(tmp) / "store.zarr"
        write_dataset(
            store,
            source="ecmwf_ifs_0p25",
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
