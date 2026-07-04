import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import {
  ColormapLayer,
  ParticlesLayer,
  VaneDataset,
  buildLut,
  type Colormap,
} from "vane";

/**
 * Data source: `?data=<url>` query param wins; a URL ending in .json is
 * treated as a `*_latest.json` pointer (the pipeline's output), anything
 * else as a direct .vane file.
 */
const DATA_URL =
  new URLSearchParams(location.search).get("data") ?? "/data/demo.vane";

function show(id: string, text: string) {
  document.getElementById(id)!.textContent = text;
}

interface DemoLayer {
  toggleId: string;
  label: string;
  layer: ColormapLayer | ParticlesLayer;
}

async function main() {
  const ds = DATA_URL.endsWith(".json")
    ? await VaneDataset.openLatest(DATA_URL)
    : await VaneDataset.open(DATA_URL);
  const meta = ds.meta;
  const [west, south, east, north] = meta.bbox;

  show("title", `Vane demo — ${meta.source}`);
  show(
    "subtitle",
    `${meta.timesteps.length} timesteps · run ${meta.model_run} · one .vane file, range requests only`,
  );
  document.getElementById("attrib")!.innerHTML = meta.source.startsWith("knmi")
    ? 'data: © <a href="https://dataplatform.knmi.nl/">KNMI</a>, CC-BY-4.0 · basemap © <a href="https://carto.com/">CARTO</a> / OSM'
    : 'synthetic demo data · basemap © <a href="https://carto.com/">CARTO</a> / OSM';

  const map = new maplibregl.Map({
    container: "map",
    style: {
      version: 8,
      sources: {
        carto: {
          type: "raster",
          tiles: [
            "https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png",
            "https://b.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png",
          ],
          tileSize: 256,
          attribution: "© CARTO © OpenStreetMap contributors",
        },
      },
      layers: [{ id: "carto", type: "raster", source: "carto" }],
    },
    bounds: [
      [west, south],
      [east, north],
    ],
    fitBoundsOptions: { padding: 40 },
  });
  map.on("error", (e) => console.error("map error:", e.error ?? e));

  // Build layers for whatever the dataset carries.
  const layers: DemoLayer[] = [];
  let legend: { colormap: Colormap; clim: [number, number]; unit: string } | null = null;

  if (meta.variables["temperature"]) {
    const clim = ds.variableMeta("temperature").default_clim ?? [0, 30];
    layers.push({
      toggleId: "toggle-temp",
      label: "temperature",
      layer: new ColormapLayer({
        id: "vane-temperature",
        dataset: ds,
        variable: "temperature",
        opacity: 0.65,
      }),
    });
    legend = { colormap: "thermal", clim, unit: "°C" };
  }
  if (meta.variables["precipitation"]) {
    // Punchier than the dataset hint: drizzle (0.1–1 mm/h) must be visible,
    // so the ramp saturates early — the "buienradar look" is styling.
    const rainStops: Colormap = [
      [0.0, "#38bdf800"],
      [0.1, "#7dd3fc"],
      [0.5, "#38bdf8"],
      [1.0, "#2563eb"],
      [2.0, "#7c3aed"],
      [4.0, "#c026d3"],
      [8.0, "#f0abfc"],
    ];
    layers.push({
      toggleId: "toggle-precip",
      label: "rain",
      layer: new ColormapLayer({
        id: "vane-precipitation",
        dataset: ds,
        variable: "precipitation",
        colormap: rainStops,
        opacity: 0.9,
      }),
    });
    legend ??= { colormap: rainStops, clim: [0, 8], unit: " mm/h" };
  }
  const hasWind = Object.values(meta.variables).some((v) => v.vector_group === "wind");
  if (hasWind) {
    layers.push({
      toggleId: "toggle-wind",
      label: "wind",
      layer: new ParticlesLayer({
        id: "vane-wind",
        dataset: ds,
        variable: "wind",
        speedRange: [0, 18],
        opacity: 0.9,
      }),
    });
  }

  map.on("load", () => {
    for (const { layer } of layers) map.addLayer(layer);
  });

  // Toggles: only show the ones that apply to this dataset.
  const active = new Set(layers.map((l) => l.toggleId));
  for (const input of document.querySelectorAll<HTMLInputElement>(".toggles input")) {
    const label = input.parentElement as HTMLElement;
    if (!active.has(input.id)) {
      label.style.display = "none";
      continue;
    }
    const entry = layers.find((l) => l.toggleId === input.id)!;
    input.addEventListener("change", () => {
      map.setLayoutProperty(entry.layer.id, "visibility", input.checked ? "visible" : "none");
    });
  }

  // Legend for the primary colormap layer.
  if (legend) {
    const lut = buildLut(legend.colormap, legend.clim);
    const stops: string[] = [];
    for (let i = 0; i <= 10; i++) {
      const j = Math.round((i / 10) * 255) * 4;
      stops.push(`rgba(${lut[j]},${lut[j + 1]},${lut[j + 2]},${lut[j + 3]! / 255})`);
    }
    (document.getElementById("legend-bar") as HTMLElement).style.background =
      `linear-gradient(to right, ${stops.join(",")})`;
    show("legend-min", `${legend.clim[0]}${legend.unit}`);
    show("legend-max", `${legend.clim[1]}${legend.unit}`);
  }

  // Time slider + play loop (radar steps are 5-minutely: play faster).
  const slider = document.getElementById("slider") as HTMLInputElement;
  const playButton = document.getElementById("play") as HTMLButtonElement;
  slider.max = String(meta.timesteps.length - 1);
  const playMs = meta.source_type === "radar" ? 400 : 900;

  const setTimestep = (t: number) => {
    slider.value = String(t);
    show("timestamp", new Date(meta.timesteps[t]!).toUTCString());
    for (const { layer } of layers) layer.setTimestep(t);
  };
  slider.addEventListener("input", () => setTimestep(Number(slider.value)));

  let playTimer: ReturnType<typeof setInterval> | null = null;
  playButton.addEventListener("click", () => {
    if (playTimer) {
      clearInterval(playTimer);
      playTimer = null;
      playButton.textContent = "▶";
    } else {
      playTimer = setInterval(() => {
        setTimestep((Number(slider.value) + 1) % meta.timesteps.length);
      }, playMs);
      playButton.textContent = "⏸";
    }
  });

  setTimestep(0);

  // debug handles (dev only)
  (globalThis as Record<string, unknown>).__vane = { map, ds, layers };
}

main().catch((err) => {
  const el = document.getElementById("error")!;
  el.style.display = "grid";
  el.textContent = `demo failed to start: ${err}`;
  console.error(err);
});
