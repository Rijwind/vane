# Vane — repo guide

Vane is an open-source render layer + tooling for gridded weather data in
the browser: Zarr v3 sharded stores in a single-file `.vane` container,
read via HTTP range requests, rendered with MapLibre/WebGL2. Start with
[README.md](README.md); this file adds conventions for working in the repo.

## Map

- `packages/vane` — TypeScript: `.vane` store for zarrita, `VaneDataset`,
  render modes (`ColormapLayer`, `ParticlesLayer`). `bun run typecheck`,
  `bunx vitest run`.
- `packages/vane-tools` — Python (uv): writer, container pack/unpack, one
  converter module per source (`harmonie.py`, `radar.py`). `uv run pytest`.
- `pipeline/` — Python (uv): fetch → convert → publish daemon.
  `uv run pytest`.
- `spec/` — the `.vane` container + metadata convention. **Draft** until
  marked frozen; changing it means updating writer + reader + both spec
  docs in the same change.
- `examples/demo` — Vite + MapLibre demo (`bun run dev`). Data files are
  gitignored; generate with `vane synth` or `vane knmi`/`vane radar`.

## Conventions

- **One converter module per source.** All source quirks (GRIB edition,
  grid, wind reference, accumulation semantics, calibration) stay inside
  the converter; the writer, container and renderer never see them.
- **Keep the data wiki current.** When a converter gains/loses a variable
  or a new source lands, update [pipeline/VARIABLES.md](pipeline/VARIABLES.md)
  (variable × source matrix) and [pipeline/SOURCES.md](pipeline/SOURCES.md)
  (per-source gotchas) in the same commit. New gotchas discovered while
  debugging a source belong in SOURCES.md, not in code comments.
- **Published data is immutable.** Never overwrite a published `.vane`;
  the pointer + catalog are the only mutable objects. See
  spec/vane-container.md "Rules" and `pipeline/publish.py`.
- **Capabilities vs styling.** New render modes and option knobs belong in
  `packages/vane`; specific colors/clims/opacities are the consumer's
  choice — the demo shows defaults, it is not a product.
- Tests accompany every converter and every publish-semantics change.
  JS-side ground truth comes from Python (see `test/fixtures/expected.json`
  — regenerate fixture + expectations together).
- This is a vendor-neutral open-source project: no downstream product
  specifics (hosting, billing, company infra) in this repo.
