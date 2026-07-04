"""KNMI radar nowcast (radar_forecast / RAD_NL25_RAC_FM) HDF5 → Vane variables.

One file per 5 minutes containing 25 images: the analysis + 2h of 5-minute
nowcast steps, 765×700 uint16 on a polar-stereographic grid in **km** units
(`+proj=stere +lat_0=90 +lon_0=0 +lat_ts=60 +a=6378.14 +b=6356.75`).
Calibration `GEO = 0.01 * PV` gives mm per 5 minutes; we convert to mm/h
(×12) so radar and model precipitation share a unit. PV 65534 = missing,
65535 = outside composite — both become nodata.

Unlike Harmonie (already regular lat/lon) this source needs regridding:
we build a regular lat/lon target grid over the composite, transform its
cell centers to projection km with pyproj, and sample nearest-neighbor.
Nearest (not bilinear) is deliberate: radar rain fields are sharp-edged and
averaging across the nodata ring would smear the composite boundary.
"""

from __future__ import annotations

import re
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

from vane_tools.writer import VaneVariable

# The HDF5 declares the ellipsoid in km (+a=6378.14 +b=6356.75), which PROJ
# rejects as a non-Earth body. Same ellipsoid in meters; we divide the
# transformer output by 1000 to get the file's km-based pixel coordinates.
PROJ4 = "+proj=stere +lat_0=90 +lon_0=0 +lat_ts=60 +a=6378140 +b=6356750 +x_0=0 +y_0=0"
MISSING = 65534  # and 65535 = out of image

# Regular lat/lon target grid over the composite (~1 km at these latitudes).
TARGET_BBOX = (0.5, 49.2, 10.5, 55.5)  # west, south, east, north
TARGET_NX = 704
TARGET_NY = 704


def _parse_dt(raw: bytes | str) -> datetime:
    text = raw.decode() if isinstance(raw, bytes) else raw
    return datetime.strptime(text.split(".")[0], "%d-%b-%Y;%H:%M:%S").replace(
        tzinfo=timezone.utc
    )


def _sampling_indices(h5) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """(rows, cols, valid_mask) mapping each target cell to a source pixel."""
    from pyproj import Transformer

    geo = h5["geographic"]
    ncols = int(geo.attrs["geo_number_columns"][0])
    nrows = int(geo.attrs["geo_number_rows"][0])
    dx = float(geo.attrs["geo_pixel_size_x"][0])
    dy = float(geo.attrs["geo_pixel_size_y"][0])
    # geo_product_corners = (LL, UL, UR, LR) lon/lat pairs; UL is pixel (0,0).
    corners = geo.attrs["geo_product_corners"].reshape(4, 2)
    ul_lon, ul_lat = float(corners[1][0]), float(corners[1][1])

    transformer = Transformer.from_crs("EPSG:4326", PROJ4, always_xy=True)
    x0, y0 = (v / 1000.0 for v in transformer.transform(ul_lon, ul_lat))

    west, south, east, north = TARGET_BBOX
    lon = np.linspace(west, east, TARGET_NX)
    lat = np.linspace(north, south, TARGET_NY)  # row 0 = north
    lon2, lat2 = np.meshgrid(lon, lat)
    x, y = transformer.transform(lon2, lat2)
    x, y = x / 1000.0, y / 1000.0

    cols = np.floor((x - x0) / dx).astype(np.int64)
    rows = np.floor((y - y0) / dy).astype(np.int64)
    valid = (cols >= 0) & (cols < ncols) & (rows >= 0) & (rows < nrows)
    return rows.clip(0, nrows - 1), cols.clip(0, ncols - 1), valid


def radar_h5_to_variables(
    path: str | Path,
) -> tuple[list[VaneVariable], list[datetime], tuple[float, float, float, float]]:
    import h5py

    with h5py.File(path, "r") as h5:
        rows, cols, valid = _sampling_indices(h5)

        image_names = sorted(
            (k for k in h5 if re.fullmatch(r"image\d+", k)),
            key=lambda k: int(k[5:]),
        )
        if not image_names:
            raise ValueError(f"{path}: no image groups")

        frames = []
        timesteps = []
        for name in image_names:
            group = h5[name]
            pv = group["image_data"][()]
            mm_per_5min = np.where(pv >= MISSING, np.nan, pv.astype("float64") * 0.01)
            regridded = mm_per_5min[rows, cols]
            regridded[~valid] = np.nan
            frames.append(regridded * 12.0)  # mm/5min -> mm/h
            timesteps.append(_parse_dt(group.attrs["image_datetime_valid"]))

    order = np.argsort(timesteps)
    data = np.stack([frames[i] for i in order])
    timesteps = [timesteps[i] for i in order]

    variables = [
        VaneVariable(
            "precipitation", data, unit="mm/h", scale=0.01,
            # clim saturates early: drizzle (0.1-1 mm/h) must be visible
            extra_attrs={"default_colormap": "blues", "default_clim": [0, 5]},
        ),
    ]
    return variables, timesteps, TARGET_BBOX
