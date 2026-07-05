"""ICON-EU converter: URL scheme + GRIB2 reading (lon wrap, row order)."""

from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pytest

from vane_tools.icon import _read_field, file_name, file_url


def test_file_naming() -> None:
    run = datetime(2026, 7, 4, 18, tzinfo=timezone.utc)
    assert file_name(run, "t_2m", 0) == (
        "icon-eu_europe_regular-lat-lon_single-level_2026070418_000_T_2M.grib2"
    )
    assert file_url(run, "tot_prec", 48) == (
        "https://opendata.dwd.de/weather/nwp/icon-eu/grib/18/tot_prec/"
        "icon-eu_europe_regular-lat-lon_single-level_2026070418_048_TOT_PREC.grib2.bz2"
    )


def _write_grib2(path: Path, values: np.ndarray) -> None:
    """A GRIB2 regular_ll message mimicking ICON-EU's conventions:
    0-360 longitudes crossing the prime meridian, jScansPositively=1
    (row 0 = south on disk)."""
    import eccodes

    nj, ni = values.shape
    gid = eccodes.codes_grib_new_from_samples("regular_ll_sfc_grib2")
    eccodes.codes_set(gid, "Ni", ni)
    eccodes.codes_set(gid, "Nj", nj)
    eccodes.codes_set(gid, "longitudeOfFirstGridPointInDegrees", 350.0)
    eccodes.codes_set(gid, "longitudeOfLastGridPointInDegrees", 10.0)
    eccodes.codes_set(gid, "iDirectionIncrementInDegrees", 5.0)
    eccodes.codes_set(gid, "latitudeOfFirstGridPointInDegrees", 40.0)
    eccodes.codes_set(gid, "latitudeOfLastGridPointInDegrees", 50.0)
    eccodes.codes_set(gid, "jDirectionIncrementInDegrees", 5.0)
    eccodes.codes_set(gid, "jScansPositively", 1)
    eccodes.codes_set_values(gid, values.ravel())
    with open(path, "wb") as f:
        eccodes.codes_write(gid, f)
    eccodes.codes_release(gid)


def test_read_field_wraps_longitude_and_flips_rows(tmp_path: Path) -> None:
    pytest.importorskip("eccodes")
    # 3 rows (south→north on disk), 5 columns.
    on_disk = np.arange(15, dtype=float).reshape(3, 5)
    path = tmp_path / "test.grib2"
    _write_grib2(path, on_disk)

    values, grid = _read_field(path)
    # Longitudes wrapped from 350..10 to -10..10.
    assert grid == {"west": -10.0, "east": 10.0, "south": 40.0, "north": 50.0}
    # jScansPositively=1 -> converter flips so row 0 = north.
    np.testing.assert_array_equal(values, on_disk[::-1])
