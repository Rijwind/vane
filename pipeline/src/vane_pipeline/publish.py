"""Immutable publish + pointer update + archive pruning.

For a dataset slug like `knmi_harmonie_nl`:

    knmi_harmonie_nl_20260702T0600Z.vane   (immutable, cache 1y)
    knmi_harmonie_nl_latest.json           (mutable pointer, cache ~30s)

The pointer is written *after* the data file is fully uploaded, so readers
can never resolve to a half-uploaded file. Old data files are pruned after
`keep_days`, which makes the timestamped files a rolling archive.
"""

from __future__ import annotations

import re
from datetime import datetime, timedelta, timezone
from pathlib import Path

from vane_pipeline.storage import DATA_CACHE_CONTROL, Storage

_STAMP_FMT = "%Y%m%dT%H%MZ"
CATALOG_NAME = "catalog.json"


def data_name(slug: str, run_time: datetime) -> str:
    return f"{slug}_{run_time.astimezone(timezone.utc).strftime(_STAMP_FMT)}.vane"


def pointer_name(slug: str) -> str:
    return f"{slug}_latest.json"


def published_run(storage: Storage, slug: str) -> datetime | None:
    """The model run the pointer currently points at (None if no pointer)."""
    pointer = storage.get_json(pointer_name(slug))
    if not pointer:
        return None
    return datetime.fromisoformat(pointer["model_run"].replace("Z", "+00:00"))


def publish(
    storage: Storage,
    slug: str,
    vane_path: Path,
    *,
    run_time: datetime,
    keep_days: int = 7,
) -> str:
    """Upload immutably, flip the pointer, prune the archive. Returns the
    published data-file name."""
    name = data_name(slug, run_time)
    storage.put_file(
        vane_path, name,
        content_type="application/octet-stream",
        cache_control=DATA_CACHE_CONTROL,
    )
    storage.put_json(pointer_name(slug), {
        "latest": name,
        "model_run": run_time.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "updated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    })
    _update_catalog(storage, slug, vane_path, name)
    prune(storage, slug, keep_days=keep_days)
    return name


def _update_catalog(storage: Storage, slug: str, vane_path: Path, name: str) -> None:
    """Maintain catalog.json: one entry per published source, straight from
    the .vane's own metadata — the machine-readable answer to "which sources
    and variables does this endpoint serve?"."""
    from vane_tools.container import read_info

    attrs = read_info(vane_path)["metadata"]["zarr.json"]["attributes"]["vane"]
    catalog = storage.get_json(CATALOG_NAME) or {"catalog_version": 1, "sources": {}}
    catalog["sources"][slug] = {
        "pointer": pointer_name(slug),
        "latest": name,
        "source": attrs["source"],
        "source_type": attrs["source_type"],
        "model_run": attrs["model_run"],
        "updated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "update_interval_seconds": attrs["update_interval_seconds"],
        "bbox": attrs["bbox"],
        "timestep_count": len(attrs["timesteps"]),
        "variables": attrs["variables"],
    }
    storage.put_json(CATALOG_NAME, catalog)


def prune(storage: Storage, slug: str, *, keep_days: int) -> list[str]:
    """Delete data files older than keep_days. Never touches the pointer or
    the file it points at."""
    pointer = storage.get_json(pointer_name(slug))
    current = pointer["latest"] if pointer else None
    cutoff = datetime.now(timezone.utc) - timedelta(days=keep_days)
    stamp_re = re.compile(re.escape(slug) + r"_(\d{8}T\d{4}Z)\.vane$")

    deleted = []
    for name in storage.list_names(f"{slug}_"):
        m = stamp_re.match(name)
        if not m or name == current:
            continue
        stamp = datetime.strptime(m.group(1), _STAMP_FMT).replace(tzinfo=timezone.utc)
        if stamp < cutoff:
            storage.delete(name)
            deleted.append(name)
    return deleted
