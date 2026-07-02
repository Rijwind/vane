import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { ColormapLayer, ParticlesLayer, VaneDataset, buildLut } from "vane";

const DATA_URL = "/data/demo.vane";

function show(id: string, text: string) {
  const el = document.getElementById(id)!;
  el.textContent = text;
}

async function main() {
  const ds = await VaneDataset.open(DATA_URL);
  const meta = ds.meta;
  const [west, south, east, north] = meta.bbox;
  const TEMP_CLIM = ds.variableMeta("temperature").default_clim ?? [0, 30];

  show("title", `Vane demo — ${meta.source}`);
  show(
    "subtitle",
    `${meta.timesteps.length} timesteps · run ${meta.model_run} · one .vane file, range requests only`,
  );
  document.getElementById("attrib")!.innerHTML =
    meta.source.startsWith("knmi")
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

  const temperature = new ColormapLayer({
    id: "vane-temperature",
    dataset: ds,
    variable: "temperature",
    colormap: "thermal",
    clim: TEMP_CLIM,
    opacity: 0.65,
  });
  const wind = new ParticlesLayer({
    id: "vane-wind",
    dataset: ds,
    variable: "wind",
    speedRange: [0, 18],
    opacity: 0.9,
  });

  map.on("load", () => {
    map.addLayer(temperature);
    map.addLayer(wind);
  });

  // Legend for the temperature layer.
  const lut = buildLut("thermal", TEMP_CLIM);
  const stops: string[] = [];
  for (let i = 0; i <= 10; i++) {
    const j = Math.round((i / 10) * 255) * 4;
    stops.push(`rgb(${lut[j]},${lut[j + 1]},${lut[j + 2]})`);
  }
  (document.getElementById("legend-bar") as HTMLElement).style.background =
    `linear-gradient(to right, ${stops.join(",")})`;
  show("legend-min", `${TEMP_CLIM[0]}°C`);
  show("legend-max", `${TEMP_CLIM[1]}°C`);

  // Time slider + play loop.
  const slider = document.getElementById("slider") as HTMLInputElement;
  const playButton = document.getElementById("play") as HTMLButtonElement;
  slider.max = String(meta.timesteps.length - 1);

  const setTimestep = (t: number) => {
    slider.value = String(t);
    show("timestamp", new Date(meta.timesteps[t]!).toUTCString());
    temperature.setTimestep(t);
    wind.setTimestep(t);
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
      }, 900);
      playButton.textContent = "⏸";
    }
  });

  // Layer toggles.
  const bindToggle = (id: string, layerId: string) => {
    document.getElementById(id)!.addEventListener("change", (e) => {
      const on = (e.target as HTMLInputElement).checked;
      map.setLayoutProperty(layerId, "visibility", on ? "visible" : "none");
    });
  };
  bindToggle("toggle-temp", "vane-temperature");
  bindToggle("toggle-wind", "vane-wind");

  setTimestep(0);

  // debug handles (dev only)
  (globalThis as Record<string, unknown>).__vane = { map, ds, temperature, wind };
}

main().catch((err) => {
  const el = document.getElementById("error")!;
  el.style.display = "grid";
  el.textContent = `demo failed to start: ${err}`;
  console.error(err);
});
