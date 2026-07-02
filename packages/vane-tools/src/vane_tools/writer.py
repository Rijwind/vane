"""Write a Vane dataset as a Zarr v3 sharded store.

The writer takes float arrays on a regular lat/lon grid (regridding from
native model grids happens upstream, see harmonie.py), quantizes them to
int16 with per-variable scale/offset, and writes one sharded Zarr array per
variable: chunks = one timestep, shard = all timesteps. The result is a
directory store that `container.pack` turns into a single .vane file.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import zarr
from zarr.codecs import ZstdCodec

NODATA_INT16 = -32768


@dataclass
class VaneVariable:
    """One variable to write: float data + how to quantize/describe it."""

    name: str
    data: np.ndarray  # (time, lat, lon) float, NaN = nodata; row 0 = north
    unit: str
    scale: float
    offset: float = 0.0
    extra_attrs: dict = field(default_factory=dict)  # vector_group, default_colormap, …

    def quantized(self) -> np.ndarray:
        raw = np.round((self.data - self.offset) / self.scale)
        # Clip to the valid int16 range, reserving the nodata sentinel.
        raw = np.clip(raw, NODATA_INT16 + 1, np.iinfo(np.int16).max)
        raw = np.where(np.isnan(self.data), NODATA_INT16, raw)
        return raw.astype(np.int16)


def write_dataset(
    out_dir: str | Path,
    *,
    source: str,
    source_type: str,  # "model" | "radar"
    model_run: datetime,
    bbox: tuple[float, float, float, float],  # west, south, east, north
    timesteps: list[datetime],
    variables: list[VaneVariable],
    update_interval_seconds: int = 3600,
    levels: list[float] | None = None,
    zstd_level: int = 6,
) -> Path:
    """Write a Zarr v3 sharded directory store carrying the Vane convention."""
    out_dir = Path(out_dir)
    nt = len(timesteps)
    if not variables:
        raise ValueError("at least one variable required")
    ny, nx = variables[0].data.shape[-2:]
    for v in variables:
        if v.data.shape != (nt, ny, nx):
            raise ValueError(
                f"{v.name}: shape {v.data.shape} != expected {(nt, ny, nx)}"
                " (level variables not implemented yet)"
            )

    var_meta = {}
    for v in variables:
        var_meta[v.name] = {
            "unit": v.unit,
            "scale": v.scale,
            "offset": v.offset,
            "nodata": NODATA_INT16,
            **v.extra_attrs,
        }

    vane_attrs = {
        "vane_spec": 1,
        "source": source,
        "source_type": source_type,
        "model_run": _iso(model_run),
        "created_at": _iso(datetime.now(timezone.utc)),
        "bbox": list(bbox),
        "crs": "EPSG:4326",
        "update_interval_seconds": update_interval_seconds,
        "timesteps": [_iso(t) for t in timesteps],
        "levels": levels,
        "variables": var_meta,
    }

    store = zarr.storage.LocalStore(out_dir)
    root = zarr.create_group(store, attributes={"vane": vane_attrs}, overwrite=True)

    for v in variables:
        arr = root.create_array(
            v.name,
            shape=(nt, ny, nx),
            chunks=(1, ny, nx),
            shards=(nt, ny, nx),
            dtype="int16",
            compressors=ZstdCodec(level=zstd_level),
            fill_value=NODATA_INT16,
            dimension_names=("time", "lat", "lon"),
        )
        arr[:] = v.quantized()

    # Small unsharded coordinate arrays for xarray round-tripping.
    west, south, east, north = bbox
    lat = np.linspace(north, south, ny)  # row 0 = north
    lon = np.linspace(west, east, nx)
    time = np.array([t.timestamp() for t in timesteps], dtype="float64")
    for name, values, dim in (("time", time, "time"), ("lat", lat, "lat"), ("lon", lon, "lon")):
        coord = root.create_array(
            name,
            shape=values.shape,
            chunks=values.shape,
            dtype="float64",
            compressors=None,
            dimension_names=(dim,),
        )
        coord[:] = values

    return out_dir


def _iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
