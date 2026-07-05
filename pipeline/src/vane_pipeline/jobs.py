"""Per-source pipeline jobs. Each job is idempotent: it checks the pointer
first and does nothing if the newest source run is already published."""

from __future__ import annotations

import shutil
import tempfile
from pathlib import Path

from vane_tools.icon import ICON_D2, ICON_EU, IconModel, build_icon_vane, latest_complete_run
from vane_tools.knmi import (
    RADAR_DATASET,
    RADAR_VERSION,
    build_harmonie_vane,
    build_radar_vane,
    latest_run_filename,
    radar_time_from_filename,
    run_time_from_filename,
)

from vane_pipeline.publish import publish, published_run
from vane_pipeline.storage import Storage

HARMONIE_SLUG = "knmi_harmonie_nl"
RADAR_SLUG = "knmi_radar_nl"
ICON_EU_SLUG = "dwd_icon_eu"
ICON_D2_SLUG = "dwd_icon_d2"
ECMWF_SLUG = "ecmwf_ifs_global"


def run_harmonie(
    storage: Storage,
    *,
    api_key: str,
    max_hours: int = 48,
    keep_days: int = 7,
) -> str | None:
    """Publish the latest Harmonie run if it isn't published yet.
    Returns the published data-file name, or None if already current."""
    filename = latest_run_filename(api_key)
    run_time = run_time_from_filename(filename)
    if published_run(storage, HARMONIE_SLUG) == run_time:
        print(f"harmonie: run {run_time:%Y-%m-%dT%H:%MZ} already published")
        return None

    workdir = Path(tempfile.mkdtemp(prefix="vane-harmonie-"))
    try:
        vane_path = workdir / "out.vane"
        build_harmonie_vane(
            vane_path, api_key=api_key, max_hours=max_hours, keep_grib=workdir / "src"
        )
        name = publish(
            storage, HARMONIE_SLUG, vane_path, run_time=run_time, keep_days=keep_days
        )
        print(f"harmonie: published {name}")
        return name
    finally:
        shutil.rmtree(workdir, ignore_errors=True)


def _run_icon(
    storage: Storage,
    model: IconModel,
    slug: str,
    *,
    max_hours: int = 48,
    keep_days: int = 7,
) -> str | None:
    """Publish the latest complete run of an ICON nest if it isn't
    published yet. No API key — DWD open data is plain HTTPS."""
    run_time = latest_complete_run(model, max_hours=max_hours)
    if published_run(storage, slug) == run_time:
        print(f"{model.name}: run {run_time:%Y-%m-%dT%H:%MZ} already published")
        return None

    workdir = Path(tempfile.mkdtemp(prefix=f"vane-{model.name}-"))
    try:
        vane_path = workdir / "out.vane"
        build_icon_vane(
            vane_path, model, max_hours=max_hours, run=run_time,
            keep_grib=workdir / "src",
        )
        name = publish(storage, slug, vane_path, run_time=run_time, keep_days=keep_days)
        print(f"{model.name}: published {name}")
        return name
    finally:
        shutil.rmtree(workdir, ignore_errors=True)


def run_icon_eu(storage: Storage, *, max_hours: int = 48, keep_days: int = 7) -> str | None:
    return _run_icon(storage, ICON_EU, ICON_EU_SLUG, max_hours=max_hours, keep_days=keep_days)


def run_icon_d2(storage: Storage, *, max_hours: int = 48, keep_days: int = 7) -> str | None:
    return _run_icon(storage, ICON_D2, ICON_D2_SLUG, max_hours=max_hours, keep_days=keep_days)


def run_ecmwf(storage: Storage, *, max_hours: int = 48, keep_days: int = 7) -> str | None:
    """Publish the latest complete ECMWF IFS open-data run if it isn't
    published yet. No API key — data.ecmwf.int is plain HTTPS."""
    from vane_tools.ecmwf import build_ecmwf_vane, latest_complete_run as ecmwf_latest

    run_time = ecmwf_latest(max_hours=max_hours)
    if published_run(storage, ECMWF_SLUG) == run_time:
        print(f"ecmwf: run {run_time:%Y-%m-%dT%H:%MZ} already published")
        return None

    workdir = Path(tempfile.mkdtemp(prefix="vane-ecmwf-"))
    try:
        vane_path = workdir / "out.vane"
        build_ecmwf_vane(
            vane_path, max_hours=max_hours, run=run_time, keep_grib=workdir / "src"
        )
        name = publish(storage, ECMWF_SLUG, vane_path, run_time=run_time, keep_days=keep_days)
        print(f"ecmwf: published {name}")
        return name
    finally:
        shutil.rmtree(workdir, ignore_errors=True)


def run_radar(storage: Storage, *, api_key: str, keep_days: int = 7) -> str | None:
    """Publish the latest radar nowcast if it isn't published yet."""
    filename = latest_run_filename(api_key, RADAR_DATASET, RADAR_VERSION)
    run_time = radar_time_from_filename(filename)
    if published_run(storage, RADAR_SLUG) == run_time:
        print(f"radar: {run_time:%Y-%m-%dT%H:%MZ} already published")
        return None

    workdir = Path(tempfile.mkdtemp(prefix="vane-radar-"))
    try:
        vane_path = workdir / "out.vane"
        build_radar_vane(vane_path, api_key=api_key, filename=filename)
        name = publish(storage, RADAR_SLUG, vane_path, run_time=run_time, keep_days=keep_days)
        print(f"radar: published {name}")
        return name
    finally:
        shutil.rmtree(workdir, ignore_errors=True)
