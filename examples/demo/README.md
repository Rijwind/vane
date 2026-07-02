# Vane demo

MapLibre map with a temperature colormap + wind particles + time slider,
reading one `.vane` file over HTTP range requests.

```bash
# from the repo root
bun install

# generate data (either works; the file is gitignored)
cd packages/vane-tools
uv run vane synth ../../examples/demo/public/data/demo.vane          # synthetic
uv run vane knmi ../../examples/demo/public/data/demo.vane           # real KNMI run
# `vane knmi` needs KNMI_API_KEY — the anonymous public key from
# https://developer.dataplatform.knmi.nl/open-data-api works.

# run
cd ../../examples/demo
bun run dev
```

Weather data in the KNMI variant: © KNMI, CC-BY-4.0.
