"""ECMWF converter: URL scheme, index parsing, global longitude roll."""

import json
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pytest

from vane_tools.ecmwf import _field_ranges, _read_field, data_url, index_url


def test_url_scheme_streams() -> None:
    oper = datetime(2026, 7, 5, 0, tzinfo=timezone.utc)
    scda = datetime(2026, 7, 5, 6, tzinfo=timezone.utc)
    assert data_url(oper, 48) == (
        "https://data.ecmwf.int/forecasts/20260705/00z/ifs/0p25/oper/"
        "20260705000000-48h-oper-fc.grib2"
    )
    assert data_url(scda, 3) == (
        "https://data.ecmwf.int/forecasts/20260705/06z/ifs/0p25/scda/"
        "20260705060000-3h-scda-fc.grib2"
    )
    assert index_url(oper, 0).endswith("20260705000000-0h-oper-fc.index")


def test_field_ranges_filters_levels_and_finds_all_params() -> None:
    def line(param: str, offset: int, **extra) -> str:
        return json.dumps({"param": param, "levtype": "sfc", "_offset": offset,
                           "_length": 100, **extra})

    index = "\n".join([
        line("2t", 0), line("10u", 100), line("10v", 200), line("tp", 300),
        line("10fg", 400), line("msl", 500), line("tcc", 600),
        line("t", 700, levelist="850"),  # pressure-level field: skipped
        json.dumps({"param": "sot", "levtype": "sol", "levelist": "3",
                    "_offset": 800, "_length": 100}),
    ])
    ranges = _field_ranges(index)
    assert ranges["2t"] == (0, 100)
    assert ranges["tcc"] == (600, 100)
    assert len(ranges) == 7


def test_field_ranges_raises_on_missing_param() -> None:
    with pytest.raises(ValueError, match="missing params"):
        _field_ranges(json.dumps({"param": "2t", "levtype": "sfc",
                                  "_offset": 0, "_length": 1}))


def _write_grib2(path: Path, values: np.ndarray) -> None:
    """A global-style GRIB2: longitudes 0..315 by 45 (wrapping through
    180), rows south→north on disk."""
    import eccodes

    nj, ni = values.shape
    gid = eccodes.codes_grib_new_from_samples("regular_ll_sfc_grib2")
    eccodes.codes_set(gid, "Ni", ni)
    eccodes.codes_set(gid, "Nj", nj)
    eccodes.codes_set(gid, "longitudeOfFirstGridPointInDegrees", 0.0)
    eccodes.codes_set(gid, "longitudeOfLastGridPointInDegrees", 315.0)
    eccodes.codes_set(gid, "iDirectionIncrementInDegrees", 45.0)
    eccodes.codes_set(gid, "latitudeOfFirstGridPointInDegrees", -45.0)
    eccodes.codes_set(gid, "latitudeOfLastGridPointInDegrees", 45.0)
    eccodes.codes_set(gid, "jDirectionIncrementInDegrees", 45.0)
    eccodes.codes_set(gid, "jScansPositively", 1)
    eccodes.codes_set_values(gid, values.ravel())
    with open(path, "wb") as f:
        eccodes.codes_write(gid, f)
    eccodes.codes_release(gid)


def test_read_field_rolls_global_grid_to_minus180(tmp_path: Path) -> None:
    pytest.importorskip("eccodes")
    # Column values equal their source longitude index so the roll is visible.
    on_disk = np.tile(np.arange(8, dtype=float), (3, 1))
    path = tmp_path / "global.grib2"
    _write_grib2(path, on_disk)

    values, grid = _read_field(path)
    # Source lons 0,45,…,315: wrapped start = 180° (index 4) → west -180.
    assert grid["west"] == -180.0
    assert grid["east"] == 135.0
    assert grid == {"west": -180.0, "east": 135.0, "south": -45.0, "north": 45.0}
    # Columns rolled so index 4 (180°) comes first; rows flipped to north-first.
    np.testing.assert_array_equal(values[0], [4, 5, 6, 7, 0, 1, 2, 3])
