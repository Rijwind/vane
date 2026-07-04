# Design notes — open problems

Thinking space for format/layout questions that are real but not urgent.
Nothing here is decided.

## Time-series access vs chunk layout

**Problem.** Chunks are `(1, ny, nx)` — one timestep per chunk — which is
optimal for the map/time-slider pattern (one range request per step shown).
But a *point time series* (charts, meteograms: `getPointSeries`) needs one
value from **every** timestep chunk, so it downloads the variable's entire
compressed data (~2–7 MB for Harmonie NL). The range-request advantage
disappears for that access pattern. Fine next to an animated map (shared
field cache), wasteful for a standalone "chart at location X" page,
noticeable on mobile.

**Candidate solutions, roughly in order of appeal:**

1. **Spatial tiling of chunks** — chunk `(T, ty, tx)` with small spatial
   tiles (e.g. `(nt, 64, 64)`): a point series = **one chunk** (~a few
   hundred KB), and a single-timestep map render = all tiles of that step,
   which sharding keeps at one coalesced range per shard region. Middle
   grounds like `(8, 128, 128)` trade both directions. Needs measurement:
   compression suffers a bit (smaller chunks), map first-paint needs more
   (but parallel) ranges. zarrita + our store handle any chunking already —
   this is a writer-side knob, not a format change.
2. **Dual layout** — store popular variables twice: map-ordered
   `(1, ny, nx)` + series-ordered `(nt, 8, 8)`. Costs ~2× storage (these
   files are small); reader picks per access pattern. Ugly but simple, and
   possible per-variable (e.g. only temperature + precipitation).
3. **Server-side point API** — a tiny endpoint that does the extraction
   server-side. Defeats "no server" for this pattern, but it is a natural
   *product* add-on for a hosted platform (the OSS format stays pure).
4. **Accept it** — document that charts cost ~the variable's data; with
   zstd + int16 that is single-digit MB for regional models. Maybe enough.

**When to decide:** before the spec freezes chunking *recommendations*
(the container itself is agnostic), or when a standalone-charts use case
becomes real. Measure option 1 first — it likely wins.
