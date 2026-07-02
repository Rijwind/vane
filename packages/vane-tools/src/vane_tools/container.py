"""Pack a Zarr v3 directory store into a single .vane file, and back.

Layout (all integers little-endian), see spec/vane-container.md:

    0   4  magic "VANE"
    4   4  spec_version uint32 = 1
    8   8  metadata_offset uint64
    16  8  metadata_length uint64
    24  8  manifest_offset uint64
    32  8  manifest_length uint64
    40  8  data_offset uint64
    48  -  metadata JSON | manifest JSON | concatenated shard bytes

Metadata = {store key: parsed JSON doc} for every *.json key.
Manifest = {store key: [offset, length]} for every other key, offsets
relative to data_offset. Shard bytes are copied verbatim — the Zarr
sharding codec's own footer index keeps handling inner-chunk offsets.
"""

from __future__ import annotations

import json
import struct
from pathlib import Path

MAGIC = b"VANE"
SPEC_VERSION = 1
HEADER_LEN = 48
_HEADER_FMT = "<4sIQQQQQ"


def _store_keys(store_dir: Path) -> list[str]:
    keys = [
        str(p.relative_to(store_dir))
        for p in sorted(store_dir.rglob("*"))
        if p.is_file() and not p.name.startswith(".")
    ]
    if "zarr.json" not in keys:
        raise ValueError(f"{store_dir} is not a Zarr v3 store (no zarr.json)")
    return keys


def pack(store_dir: str | Path, out_path: str | Path) -> Path:
    """Serialize a Zarr v3 directory store into one .vane file."""
    store_dir, out_path = Path(store_dir), Path(out_path)

    metadata: dict[str, object] = {}
    data_keys: list[str] = []
    for key in _store_keys(store_dir):
        if key.endswith(".json"):
            metadata[key] = json.loads((store_dir / key).read_bytes())
        else:
            data_keys.append(key)

    manifest: dict[str, list[int]] = {}
    offset = 0
    for key in data_keys:
        length = (store_dir / key).stat().st_size
        manifest[key] = [offset, length]
        offset += length

    meta_bytes = json.dumps(metadata, separators=(",", ":")).encode()
    manifest_bytes = json.dumps(manifest, separators=(",", ":")).encode()
    metadata_offset = HEADER_LEN
    manifest_offset = metadata_offset + len(meta_bytes)
    data_offset = manifest_offset + len(manifest_bytes)

    header = struct.pack(
        _HEADER_FMT,
        MAGIC,
        SPEC_VERSION,
        metadata_offset,
        len(meta_bytes),
        manifest_offset,
        len(manifest_bytes),
        data_offset,
    )

    with open(out_path, "wb") as f:
        f.write(header)
        f.write(meta_bytes)
        f.write(manifest_bytes)
        for key in data_keys:
            with open(store_dir / key, "rb") as src:
                while chunk := src.read(1 << 20):
                    f.write(chunk)
    return out_path


def read_header(f) -> dict:
    raw = f.read(HEADER_LEN)
    magic, version, mo, ml, fo, fl, do = struct.unpack(_HEADER_FMT, raw)
    if magic != MAGIC:
        raise ValueError("not a .vane file (bad magic)")
    if version != SPEC_VERSION:
        raise ValueError(f"unsupported .vane spec version {version}")
    return {
        "spec_version": version,
        "metadata_offset": mo,
        "metadata_length": ml,
        "manifest_offset": fo,
        "manifest_length": fl,
        "data_offset": do,
    }


def read_info(path: str | Path) -> dict:
    """Header + metadata + manifest of a .vane file (no data reads)."""
    with open(path, "rb") as f:
        header = read_header(f)
        f.seek(header["metadata_offset"])
        metadata = json.loads(f.read(header["metadata_length"]))
        f.seek(header["manifest_offset"])
        manifest = json.loads(f.read(header["manifest_length"]))
    return {"header": header, "metadata": metadata, "manifest": manifest}


def unpack(vane_path: str | Path, out_dir: str | Path) -> Path:
    """Expand a .vane back into a directory-layout Zarr v3 store."""
    vane_path, out_dir = Path(vane_path), Path(out_dir)
    info = read_info(vane_path)
    out_dir.mkdir(parents=True, exist_ok=True)

    for key, doc in info["metadata"].items():
        target = out_dir / key
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(json.dumps(doc, indent=2))

    data_offset = info["header"]["data_offset"]
    with open(vane_path, "rb") as f:
        for key, (offset, length) in info["manifest"].items():
            target = out_dir / key
            target.parent.mkdir(parents=True, exist_ok=True)
            f.seek(data_offset + offset)
            with open(target, "wb") as dst:
                remaining = length
                while remaining:
                    chunk = f.read(min(remaining, 1 << 20))
                    if not chunk:
                        raise ValueError(f"truncated .vane: {key}")
                    dst.write(chunk)
                    remaining -= len(chunk)
    return out_dir
