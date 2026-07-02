"""KNMI Open Data API: download the latest Harmonie run and convert to .vane.

Dataset: harmonie_arome_cy43_p1 — hourly runs, ~60 hourly forecast steps,
one tar per run containing one GRIB file per lead time. The KNMI publishes
anonymous API keys (rate-limited, shared) on
https://developer.dataplatform.knmi.nl/open-data-api — registration is free
for a personal key.
"""

from __future__ import annotations

import re
import tarfile
import tempfile
from datetime import datetime, timezone
from pathlib import Path

import requests

API_BASE = "https://api.dataplatform.knmi.nl/open-data/v1"
DATASET = "harmonie_arome_cy43_p1"
VERSION = "1.0"


def latest_run_filename(api_key: str) -> str:
    response = requests.get(
        f"{API_BASE}/datasets/{DATASET}/versions/{VERSION}/files",
        headers={"Authorization": api_key},
        params={"maxKeys": 1, "orderBy": "created", "sorting": "desc"},
        timeout=30,
    )
    response.raise_for_status()
    files = response.json()["files"]
    if not files:
        raise RuntimeError("KNMI API returned no files")
    return files[0]["filename"]


def download_file(api_key: str, filename: str, dest: Path) -> Path:
    response = requests.get(
        f"{API_BASE}/datasets/{DATASET}/versions/{VERSION}/files/{filename}/url",
        headers={"Authorization": api_key},
        timeout=30,
    )
    response.raise_for_status()
    url = response.json()["temporaryDownloadUrl"]
    with requests.get(url, stream=True, timeout=60) as r:
        r.raise_for_status()
        with open(dest, "wb") as f:
            for chunk in r.iter_content(chunk_size=1 << 20):
                f.write(chunk)
    return dest


def run_time_from_filename(filename: str) -> datetime:
    m = re.search(r"(\d{10})", filename)
    if not m:
        raise ValueError(f"cannot parse run time from {filename}")
    return datetime.strptime(m.group(1), "%Y%m%d%H").replace(tzinfo=timezone.utc)


def build_harmonie_vane(
    out_path: str | Path,
    *,
    api_key: str,
    max_hours: int = 24,
    keep_grib: Path | None = None,
) -> Path:
    """Download the latest Harmonie run and write it as a .vane file."""
    from vane_tools import container
    from vane_tools.harmonie import harmonie_tar_to_variables
    from vane_tools.writer import write_dataset

    filename = latest_run_filename(api_key)
    run_time = run_time_from_filename(filename)

    workdir = keep_grib or Path(tempfile.mkdtemp(prefix="vane-knmi-"))
    workdir.mkdir(parents=True, exist_ok=True)
    tar_path = workdir / filename
    if not tar_path.exists():
        print(f"downloading {filename} …")
        download_file(api_key, filename, tar_path)
    else:
        print(f"using cached {tar_path}")

    grib_dir = workdir / "gribs"
    if not grib_dir.exists():
        grib_dir.mkdir()
        with tarfile.open(tar_path) as tar:
            tar.extractall(grib_dir, filter="data")

    variables, timesteps, bbox = harmonie_tar_to_variables(grib_dir, max_hours=max_hours)

    with tempfile.TemporaryDirectory() as tmp:
        store = Path(tmp) / "store.zarr"
        write_dataset(
            store,
            source="knmi_harmonie_cy43_p1",
            source_type="model",
            model_run=run_time,
            bbox=bbox,
            timesteps=timesteps,
            variables=variables,
            update_interval_seconds=3600,
        )
        container.pack(store, out_path)
    size = Path(out_path).stat().st_size
    print(f"wrote {out_path} ({size / 1e6:.1f} MB, {len(timesteps)} timesteps)")
    return Path(out_path)
