"""Per-source pipeline jobs. Each job is idempotent: it checks the pointer
first and does nothing if the newest source run is already published."""

from __future__ import annotations

import shutil
import tempfile
from pathlib import Path

from vane_tools.knmi import build_harmonie_vane, latest_run_filename, run_time_from_filename

from vane_pipeline.publish import publish, published_run
from vane_pipeline.storage import Storage

HARMONIE_SLUG = "knmi_harmonie_nl"


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
