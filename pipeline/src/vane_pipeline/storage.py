"""Storage backends for publishing .vane files.

Two implementations of the same small interface:

- `LocalStorage` — a directory; for development and tests.
- `S3Storage` — any S3-compatible object store (UpCloud Object Storage,
  Cloudflare R2, MinIO) via a configurable endpoint URL.

Publishing rules (see spec/vane-container.md): data files are immutable and
timestamped; only the small `*_latest.json` pointer is ever rewritten. The
pointer is uploaded with a short cache TTL, data files with
`immutable, max-age=1y`.
"""

from __future__ import annotations

import json
import os
import shutil
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

DATA_CACHE_CONTROL = "public, max-age=31536000, immutable"
POINTER_CACHE_CONTROL = "public, max-age=30, must-revalidate"


class Storage(Protocol):
    def put_file(self, local: Path, name: str, *, content_type: str, cache_control: str) -> None: ...
    def put_json(self, name: str, payload: dict) -> None: ...
    def get_json(self, name: str) -> dict | None: ...
    def list_names(self, prefix: str) -> list[str]: ...
    def delete(self, name: str) -> None: ...


@dataclass
class LocalStorage:
    root: Path

    def put_file(self, local: Path, name: str, *, content_type: str, cache_control: str) -> None:
        dest = self.root / name
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(local, dest)

    def put_json(self, name: str, payload: dict) -> None:
        dest = self.root / name
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_text(json.dumps(payload, indent=1))

    def get_json(self, name: str) -> dict | None:
        path = self.root / name
        if not path.exists():
            return None
        return json.loads(path.read_text())

    def list_names(self, prefix: str) -> list[str]:
        if not self.root.exists():
            return []
        return sorted(
            str(p.relative_to(self.root))
            for p in self.root.rglob("*")
            if p.is_file() and str(p.relative_to(self.root)).startswith(prefix)
        )

    def delete(self, name: str) -> None:
        (self.root / name).unlink(missing_ok=True)


class S3Storage:
    """S3-compatible bucket. Credentials via the standard AWS env vars
    (`AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`)."""

    def __init__(self, bucket: str, endpoint_url: str | None = None, prefix: str = ""):
        import boto3

        self.client = boto3.client("s3", endpoint_url=endpoint_url)
        self.bucket = bucket
        self.prefix = prefix.strip("/")

    def _key(self, name: str) -> str:
        return f"{self.prefix}/{name}" if self.prefix else name

    def put_file(self, local: Path, name: str, *, content_type: str, cache_control: str) -> None:
        self.client.upload_file(
            str(local),
            self.bucket,
            self._key(name),
            ExtraArgs={"ContentType": content_type, "CacheControl": cache_control},
        )

    def put_json(self, name: str, payload: dict) -> None:
        self.client.put_object(
            Bucket=self.bucket,
            Key=self._key(name),
            Body=json.dumps(payload).encode(),
            ContentType="application/json",
            CacheControl=POINTER_CACHE_CONTROL,
        )

    def get_json(self, name: str) -> dict | None:
        try:
            response = self.client.get_object(Bucket=self.bucket, Key=self._key(name))
        except self.client.exceptions.NoSuchKey:
            return None
        return json.loads(response["Body"].read())

    def list_names(self, prefix: str) -> list[str]:
        paginator = self.client.get_paginator("list_objects_v2")
        names = []
        strip = len(self.prefix) + 1 if self.prefix else 0
        for page in paginator.paginate(Bucket=self.bucket, Prefix=self._key(prefix)):
            for obj in page.get("Contents", []):
                names.append(obj["Key"][strip:])
        return sorted(names)

    def delete(self, name: str) -> None:
        self.client.delete_object(Bucket=self.bucket, Key=self._key(name))


def storage_from_env() -> Storage:
    """VANE_STORAGE=local:<dir> | s3:<bucket> (+ VANE_S3_ENDPOINT, VANE_S3_PREFIX)."""
    spec = os.environ.get("VANE_STORAGE", "local:./vane-data")
    kind, _, arg = spec.partition(":")
    if kind == "local":
        return LocalStorage(Path(arg or "./vane-data"))
    if kind == "s3":
        if not arg:
            raise ValueError("VANE_STORAGE=s3:<bucket> requires a bucket name")
        return S3Storage(
            bucket=arg,
            endpoint_url=os.environ.get("VANE_S3_ENDPOINT") or None,
            prefix=os.environ.get("VANE_S3_PREFIX", ""),
        )
    raise ValueError(f"unknown VANE_STORAGE kind: {kind}")
