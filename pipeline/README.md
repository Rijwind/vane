# pipeline

Phase 2 (planned): reference converters + scheduling for a hosted Vane data
endpoint. Each run downloads a source (KNMI Harmonie hourly, KNMI radar
5-minutely, later DWD ICON-EU / ECMWF IFS), converts via `vane-tools`,
uploads an **immutable** timestamped `.vane` to object storage, updates the
`*_latest.json` pointer, and prunes the archive (~7 days).

Nothing here yet — the one-shot converter lives in
[`vane-tools`](../packages/vane-tools) (`vane knmi`).
