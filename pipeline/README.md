# vane-pipeline

Reference pipeline: fetch open weather data, convert to `.vane` with
[`vane-tools`](../packages/vane-tools), and publish to object storage
following the immutable + pointer pattern from the spec:

```
knmi_harmonie_nl_20260702T0700Z.vane   immutable data (Cache-Control: 1y, immutable)
knmi_harmonie_nl_latest.json           mutable pointer (Cache-Control: ~30s)
```

The pointer is written only after the data file is fully uploaded; old files
are pruned after 7 days (the timestamped files double as a rolling archive).
Jobs are idempotent — if the newest source run is already published, a run
is a cheap no-op — so the daemon simply polls every few minutes.

## Sources

| Job | Source | Cadence | Status |
|---|---|---|---|
| `harmonie` | KNMI Harmonie cy43 P1 (NL, 2km) | hourly runs, poll 10 min | ✅ |
| `radar` | KNMI radar nowcast (NL, 1km, 5 min) | 5 min, poll 3 min | ✅ |
| `icon-eu` | DWD ICON-EU (Europe, 7km) | 00/06/12/18Z, poll 20 min | ✅ (no API key needed) |
| `icon-d2` | DWD ICON-D2 (central Europe, 2.2km) | every 3h, poll 20 min | ✅ (no API key needed) |
| `ecmwf` | ECMWF IFS open data (global, 0.25°, 3-hourly steps) | 00/06/12/18Z, poll 30 min | ✅ (no API key needed) |

Per-source quirks (GRIB editions, grids, wind rotation, accumulation
semantics): see [SOURCES.md](SOURCES.md).

## Configuration (env)

```
VANE_STORAGE=local:./vane-data      # dev: a directory
VANE_STORAGE=s3:<bucket>            # prod: any S3-compatible store
VANE_S3_ENDPOINT=https://…          # UpCloud Object Storage / R2 / MinIO
VANE_S3_PREFIX=weather              # optional key prefix
AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY
KNMI_API_KEY=…                      # developer.dataplatform.knmi.nl (anonymous key works)
```

## Run

```bash
uv sync
KNMI_API_KEY=… uv run vane-pipeline harmonie          # one shot
KNMI_API_KEY=… uv run vane-pipeline daemon            # poll forever
```

## Deploy (Coolify / any Docker host)

Build from the **repo root** (the image needs `packages/vane-tools`):

```bash
docker build -f pipeline/Dockerfile -t vane-pipeline .
docker run -e VANE_STORAGE=s3:… -e VANE_S3_ENDPOINT=… \
  -e AWS_ACCESS_KEY_ID=… -e AWS_SECRET_ACCESS_KEY=… -e KNMI_API_KEY=… \
  vane-pipeline
```

Sizing: ~1–2 GB RAM during Harmonie conversion, ~2.5 GB scratch disk per
run (tar + extracted GRIBs); the ICON-EU/D2 jobs peak at ~1.5 GB RAM each
(preallocated float32 stacks, transformed in place) and upload ~230–300 MB
per publication; ECMWF is light (~120 MB publications via index ranges).
One small worker VPS still fits, but give it ≥4 GB RAM with the ICON
nests enabled. Rolling 7-day bucket across all five sources ≈ 35 GB.

The bucket/CDN in front must serve HTTP range requests and CORS:

```
Accept-Ranges: bytes
Access-Control-Allow-Origin: *
Access-Control-Allow-Headers: Range
Access-Control-Expose-Headers: Content-Range, Content-Length, ETag
```
