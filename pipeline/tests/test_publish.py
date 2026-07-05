"""Publish/prune/catalog semantics against the local storage backend."""

import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from vane_pipeline.publish import CATALOG_NAME, data_name, publish, published_run, prune
from vane_pipeline.storage import LocalStorage


def make_storage(tmp_path):
    return LocalStorage(tmp_path / "bucket")


@pytest.fixture(scope="module")
def vane_file(tmp_path_factory) -> Path:
    """A real (tiny) .vane — publish reads its metadata for the catalog."""
    from vane_tools import container
    from vane_tools.synth import synthetic_variables
    from vane_tools.writer import write_dataset

    tmp = tmp_path_factory.mktemp("data")
    variables, timesteps, bbox = synthetic_variables(nt=2, ny=10, nx=12)
    with tempfile.TemporaryDirectory() as store_tmp:
        store = Path(store_tmp) / "s.zarr"
        write_dataset(
            store, source="test_source", source_type="model",
            model_run=timesteps[0], bbox=bbox, timesteps=timesteps, variables=variables,
        )
        return container.pack(store, tmp / "x.vane")


def test_publish_writes_immutable_file_pointer_and_catalog(tmp_path, vane_file):
    storage = make_storage(tmp_path)
    run = datetime(2026, 7, 2, 6, tzinfo=timezone.utc)

    name = publish(storage, "knmi_harmonie_nl", vane_file, run_time=run)

    assert name == "knmi_harmonie_nl_20260702T0600Z.vane"
    assert (storage.root / name).read_bytes() == vane_file.read_bytes()
    pointer = storage.get_json("knmi_harmonie_nl_latest.json")
    assert pointer["latest"] == name
    assert pointer["model_run"] == "2026-07-02T06:00:00Z"
    assert published_run(storage, "knmi_harmonie_nl") == run

    catalog = storage.get_json(CATALOG_NAME)
    entry = catalog["sources"]["knmi_harmonie_nl"]
    assert entry["latest"] == name
    assert entry["source"] == "test_source"
    assert entry["timestep_count"] == 2
    assert entry["size_bytes"] == vane_file.stat().st_size
    assert "temperature" in entry["variables"]
    assert entry["variables"]["wind_u"]["vector_group"] == "wind"


def test_catalog_accumulates_sources(tmp_path, vane_file):
    storage = make_storage(tmp_path)
    now = datetime.now(timezone.utc)
    publish(storage, "source_a", vane_file, run_time=now)
    publish(storage, "source_b", vane_file, run_time=now)
    catalog = storage.get_json(CATALOG_NAME)
    assert set(catalog["sources"]) == {"source_a", "source_b"}


def test_republish_flips_pointer_keeps_archive(tmp_path, vane_file):
    storage = make_storage(tmp_path)
    vane = vane_file
    now = datetime.now(timezone.utc).replace(minute=0, second=0, microsecond=0)

    publish(storage, "s", vane, run_time=now - timedelta(hours=1))
    publish(storage, "s", vane, run_time=now)

    names = storage.list_names("s_")
    assert data_name("s", now - timedelta(hours=1)) in names  # archive intact
    assert published_run(storage, "s") == now


def test_prune_deletes_old_but_never_current(tmp_path, vane_file):
    storage = make_storage(tmp_path)
    vane = vane_file
    now = datetime.now(timezone.utc)
    old = now - timedelta(days=9)

    # publish old run first, then the current one (prune runs inside publish)
    publish(storage, "s", vane, run_time=old, keep_days=7)
    publish(storage, "s", vane, run_time=now, keep_days=7)

    names = storage.list_names("s_")
    assert data_name("s", old) not in names          # pruned
    assert data_name("s", now) in names              # current kept
    assert storage.get_json("s_latest.json")["latest"] == data_name("s", now)


def test_prune_never_deletes_pointer_target_even_if_old(tmp_path, vane_file):
    storage = make_storage(tmp_path)
    vane = vane_file
    old = datetime.now(timezone.utc) - timedelta(days=30)

    publish(storage, "s", vane, run_time=old, keep_days=7)  # only run we have
    deleted = prune(storage, "s", keep_days=7)

    assert deleted == []
    assert data_name("s", old) in storage.list_names("s_")
