"""End-to-end: synth -> zarr store -> pack -> unpack -> xarray reads it back."""

from datetime import datetime, timezone

import numpy as np
import pytest
import xarray as xr
import zarr

from vane_tools import container
from vane_tools.synth import synthetic_variables
from vane_tools.writer import NODATA_INT16, write_dataset


@pytest.fixture(scope="module")
def packed(tmp_path_factory):
    tmp = tmp_path_factory.mktemp("vane")
    variables, timesteps, bbox = synthetic_variables(nt=5, ny=60, nx=80)
    store = tmp / "store.zarr"
    write_dataset(
        store,
        source="test",
        source_type="model",
        model_run=datetime.now(timezone.utc),
        bbox=bbox,
        timesteps=timesteps,
        variables=variables,
    )
    vane_path = tmp / "test.vane"
    container.pack(store, vane_path)
    return tmp, store, vane_path, variables


def test_header_sections_are_contiguous(packed):
    _, _, vane_path, _ = packed
    info = container.read_info(vane_path)
    h = info["header"]
    assert h["metadata_offset"] == 48
    assert h["manifest_offset"] == h["metadata_offset"] + h["metadata_length"]
    assert h["data_offset"] == h["manifest_offset"] + h["manifest_length"]
    total = h["data_offset"] + sum(length for _, length in info["manifest"].values())
    assert vane_path.stat().st_size == total


def test_one_shard_per_variable(packed):
    _, _, vane_path, variables = packed
    manifest = container.read_info(vane_path)["manifest"]
    data_arrays = [v.name for v in variables]
    for name in data_arrays:
        keys = [k for k in manifest if k.startswith(f"{name}/")]
        assert len(keys) == 1, f"{name}: expected one shard, got {keys}"


def test_unpack_roundtrips_bytes(packed):
    tmp, store, vane_path, _ = packed
    out = tmp / "unpacked.zarr"
    container.unpack(vane_path, out)
    original = {p.relative_to(store): p for p in store.rglob("*") if p.is_file()}
    restored = {p.relative_to(out): p for p in out.rglob("*") if p.is_file()}
    assert set(original) == set(restored)
    for rel, src in original.items():
        if str(rel).endswith(".json"):
            continue  # JSON is re-serialized (formatting may differ)
        assert src.read_bytes() == restored[rel].read_bytes(), rel


def test_xarray_reads_unpacked_store(packed):
    tmp, _, vane_path, variables = packed
    out = tmp / "unpacked2.zarr"
    container.unpack(vane_path, out)
    ds = xr.open_zarr(out, consolidated=False)
    assert set(v.name for v in variables) <= set(ds.data_vars)
    assert ds["temperature"].dims == ("time", "lat", "lon")

    meta = zarr.open_group(out, mode="r").attrs["vane"]
    spec = meta["variables"]["temperature"]
    raw = ds["temperature"].values  # xarray applies no scaling; raw int16
    expected = variables[0].quantized()
    np.testing.assert_array_equal(raw, expected)

    physical = raw.astype("float64") * spec["scale"] + spec["offset"]
    valid = raw != NODATA_INT16
    np.testing.assert_allclose(
        physical[valid], variables[0].data[valid], atol=spec["scale"] / 2 + 1e-9
    )
