"""Publish/prune semantics against the local storage backend."""

from datetime import datetime, timedelta, timezone

from vane_pipeline.publish import data_name, publish, published_run, prune
from vane_pipeline.storage import LocalStorage


def make_storage(tmp_path):
    return LocalStorage(tmp_path / "bucket")


def test_publish_writes_immutable_file_and_pointer(tmp_path):
    storage = make_storage(tmp_path)
    vane = tmp_path / "x.vane"
    vane.write_bytes(b"VANE-test-bytes")
    run = datetime(2026, 7, 2, 6, tzinfo=timezone.utc)

    name = publish(storage, "knmi_harmonie_nl", vane, run_time=run)

    assert name == "knmi_harmonie_nl_20260702T0600Z.vane"
    assert (storage.root / name).read_bytes() == b"VANE-test-bytes"
    pointer = storage.get_json("knmi_harmonie_nl_latest.json")
    assert pointer["latest"] == name
    assert pointer["model_run"] == "2026-07-02T06:00:00Z"
    assert published_run(storage, "knmi_harmonie_nl") == run


def test_republish_flips_pointer_keeps_archive(tmp_path):
    storage = make_storage(tmp_path)
    vane = tmp_path / "x.vane"
    vane.write_bytes(b"a")
    now = datetime.now(timezone.utc).replace(minute=0, second=0, microsecond=0)

    publish(storage, "s", vane, run_time=now - timedelta(hours=1))
    publish(storage, "s", vane, run_time=now)

    names = storage.list_names("s_")
    assert data_name("s", now - timedelta(hours=1)) in names  # archive intact
    assert published_run(storage, "s") == now


def test_prune_deletes_old_but_never_current(tmp_path):
    storage = make_storage(tmp_path)
    vane = tmp_path / "x.vane"
    vane.write_bytes(b"a")
    now = datetime.now(timezone.utc)
    old = now - timedelta(days=9)

    # publish old run first, then the current one (prune runs inside publish)
    publish(storage, "s", vane, run_time=old, keep_days=7)
    publish(storage, "s", vane, run_time=now, keep_days=7)

    names = storage.list_names("s_")
    assert data_name("s", old) not in names          # pruned
    assert data_name("s", now) in names              # current kept
    assert storage.get_json("s_latest.json")["latest"] == data_name("s", now)


def test_prune_never_deletes_pointer_target_even_if_old(tmp_path):
    storage = make_storage(tmp_path)
    vane = tmp_path / "x.vane"
    vane.write_bytes(b"a")
    old = datetime.now(timezone.utc) - timedelta(days=30)

    publish(storage, "s", vane, run_time=old, keep_days=7)  # only run we have
    deleted = prune(storage, "s", keep_days=7)

    assert deleted == []
    assert data_name("s", old) in storage.list_names("s_")
