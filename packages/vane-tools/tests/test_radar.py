"""Radar converter against a synthetic KNMI-shaped HDF5 file."""

from datetime import datetime, timezone

import h5py
import numpy as np
import pytest
from pyproj import Transformer

from vane_tools.radar import PROJ4, TARGET_BBOX, radar_h5_to_variables

NCOLS, NROWS = 700, 765
UL = (0.0, 55.973602)  # lon/lat of pixel (0,0), from a real file


def write_fake_radar(path, rain_pixels: dict[tuple[int, int], int]):
    """Minimal RAD_NL25_RAC_FM-shaped file: 2 images, real geometry attrs."""
    with h5py.File(path, "w") as f:
        geo = f.create_group("geographic")
        geo.attrs["geo_number_columns"] = np.array([NCOLS], dtype="int32")
        geo.attrs["geo_number_rows"] = np.array([NROWS], dtype="int32")
        geo.attrs["geo_pixel_size_x"] = np.array([1.0000035], dtype="float32")
        geo.attrs["geo_pixel_size_y"] = np.array([-1.0000048], dtype="float32")
        geo.attrs["geo_product_corners"] = np.array(
            [0.0, 49.362064, UL[0], UL[1], 10.856453, 55.388973, 9.0093, 48.8953],
            dtype="float32",
        )
        proj = geo.create_group("map_projection")
        proj.attrs["projection_proj4_params"] = np.bytes_(PROJ4.encode())

        for i, (stamp, pixels) in enumerate(
            [("02-JUL-2026;10:00:00.000", rain_pixels), ("02-JUL-2026;10:05:00.000", {})],
            start=1,
        ):
            data = np.zeros((NROWS, NCOLS), dtype="uint16")
            data[:2, :] = 65535  # out-of-image strip
            for (row, col), pv in pixels.items():
                data[row, col] = pv
            img = f.create_group(f"image{i}")
            img.attrs["image_datetime_valid"] = np.bytes_(stamp.encode())
            img.create_dataset("image_data", data=data)


def test_radar_conversion_values_and_geometry(tmp_path):
    # Put rain at the source pixel corresponding to a known lat/lon.
    transformer = Transformer.from_crs("EPSG:4326", PROJ4, always_xy=True)
    x0, y0 = (v / 1000.0 for v in transformer.transform(*UL))
    utrecht = (5.12, 52.09)
    x, y = (v / 1000.0 for v in transformer.transform(*utrecht))
    col, row = int((x - x0) / 1.0000035), int((y - y0) / -1.0000048)
    pv = 120  # 1.20 mm per 5 min -> 14.4 mm/h

    path = tmp_path / "radar.h5"
    write_fake_radar(path, {(row, col): pv})
    variables, timesteps, bbox = radar_h5_to_variables(path)

    assert bbox == TARGET_BBOX
    assert [t.isoformat() for t in timesteps] == [
        datetime(2026, 7, 2, 10, 0, tzinfo=timezone.utc).isoformat(),
        datetime(2026, 7, 2, 10, 5, tzinfo=timezone.utc).isoformat(),
    ]
    (precip,) = variables
    nt, ny, nx = precip.data.shape
    assert nt == 2

    # The rainy source pixel must land near Utrecht in the target grid.
    west, south, east, north = bbox
    ty = int((north - utrecht[1]) / (north - south) * (ny - 1))
    tx = int((utrecht[0] - west) / (east - west) * (nx - 1))
    window = precip.data[0, ty - 3 : ty + 4, tx - 3 : tx + 4]
    assert np.nanmax(window) == pytest.approx(14.4, abs=0.01)
    # Second timestep is dry everywhere (ignoring the nodata strip).
    assert np.nanmax(precip.data[1]) == 0.0
    # Out-of-image strip became nodata.
    assert np.isnan(precip.data[0]).any()


def test_radar_rejects_file_without_images(tmp_path):
    path = tmp_path / "empty.h5"
    with h5py.File(path, "w") as f:
        geo = f.create_group("geographic")
        geo.attrs["geo_number_columns"] = np.array([10], dtype="int32")
        geo.attrs["geo_number_rows"] = np.array([10], dtype="int32")
        geo.attrs["geo_pixel_size_x"] = np.array([1.0], dtype="float32")
        geo.attrs["geo_pixel_size_y"] = np.array([-1.0], dtype="float32")
        geo.attrs["geo_product_corners"] = np.array(
            [0.0, 49.4, 0.0, 56.0, 10.9, 55.4, 9.0, 48.9], dtype="float32"
        )
    with pytest.raises(ValueError, match="no image groups"):
        radar_h5_to_variables(path)
