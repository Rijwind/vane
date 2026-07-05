import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import {
  ArrowsLayer,
  ColormapLayer,
  ContoursLayer,
  ParticlesLayer,
  ValuesLayer,
  VaneDataset,
  buildLut,
  type Colormap,
} from "vane";

import { renderCharts, type ChartSeries } from "./charts.js";

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

/** Uniform handle over both kinds of layers: WebGL custom layers
 * (map.addLayer) and style-layer controllers (layer.addTo). */
interface DemoLayer {
  label: string;
  defaultOn: boolean;
  add: (map: maplibregl.Map) => void;
  setVisible: (map: maplibregl.Map, visible: boolean) => void;
  setTimestep: (t: number) => void;
}

function customLayer(
  label: string,
  defaultOn: boolean,
  layer: ColormapLayer | ParticlesLayer | ArrowsLayer,
): DemoLayer {
  return {
    label,
    defaultOn,
    add: (map) => {
      map.addLayer(layer);
      if (!defaultOn) map.setLayoutProperty(layer.id, "visibility", "none");
    },
    setVisible: (map, visible) =>
      map.setLayoutProperty(layer.id, "visibility", visible ? "visible" : "none"),
    setTimestep: (t) => layer.setTimestep(t),
  };
}

function controllerLayer(
  label: string,
  defaultOn: boolean,
  layer: ValuesLayer | ContoursLayer,
): DemoLayer {
  return {
    label,
    defaultOn,
    add: (map) => {
      layer.addTo(map);
      if (!defaultOn) layer.setVisible(false);
    },
    setVisible: (_map, visible) => layer.setVisible(visible),
    setTimestep: (t) => layer.setTimestep(t),
  };
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
    : meta.source.startsWith("dwd")
      ? 'data: © <a href="https://www.dwd.de/">DWD</a>, CC-BY-4.0 · basemap © <a href="https://carto.com/">CARTO</a> / OSM'
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
    layers.push(
      customLayer(
        "temperature",
        true,
        new ColormapLayer({
          id: "vane-temperature",
          dataset: ds,
          variable: "temperature",
          opacity: 0.65,
        }),
      ),
    );
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
    layers.push(
      customLayer(
        "rain",
        true,
        new ColormapLayer({
          id: "vane-precipitation",
          dataset: ds,
          variable: "precipitation",
          colormap: rainStops,
          opacity: 0.9,
        }),
      ),
    );
    legend ??= { colormap: rainStops, clim: [0, 8], unit: " mm/h" };
  }
  if (meta.variables["cloud_cover"]) {
    layers.push(
      customLayer(
        "clouds",
        false,
        new ColormapLayer({
          id: "vane-clouds",
          dataset: ds,
          variable: "cloud_cover",
        }),
      ),
    );
  }
  if (meta.variables["wind_gust"]) {
    layers.push(
      customLayer(
        "gusts",
        false,
        new ColormapLayer({
          id: "vane-gusts",
          dataset: ds,
          variable: "wind_gust",
          opacity: 0.65,
        }),
      ),
    );
  }
  const hasWind = Object.values(meta.variables).some((v) => v.vector_group === "wind");
  if (hasWind) {
    layers.push(
      customLayer(
        "wind",
        true,
        new ParticlesLayer({
          id: "vane-wind",
          dataset: ds,
          variable: "wind",
          speedRange: [0, 18],
          opacity: 0.9,
        }),
      ),
    );
    layers.push(
      customLayer(
        "arrows",
        false,
        new ArrowsLayer({
          id: "vane-arrows",
          dataset: ds,
          variable: "wind",
          speedRange: [0, 18],
        }),
      ),
    );
  }
  if (meta.variables["pressure_msl"]) {
    layers.push(
      controllerLayer(
        "pressure",
        false,
        new ContoursLayer({
          id: "vane-pressure",
          dataset: ds,
          variable: "pressure_msl",
          color: "rgba(255,255,255,0.75)",
        }),
      ),
    );
  }
  if (meta.variables["temperature"]) {
    layers.push(
      controllerLayer(
        "values",
        false,
        new ValuesLayer({
          id: "vane-values",
          dataset: ds,
          variable: "temperature",
        }),
      ),
    );
  }

  map.on("load", () => {
    for (const layer of layers) layer.add(map);
  });

  // One checkbox per layer this dataset supports.
  const togglesEl = document.getElementById("toggles")!;
  for (const layer of layers) {
    const label = document.createElement("label");
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = layer.defaultOn;
    label.append(input, ` ${layer.label}`);
    togglesEl.append(label);
    input.addEventListener("change", () => layer.setVisible(map, input.checked));
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

  // Point charts: click the map -> temperature / rain / wind graphs there.
  const chartsPanel = document.getElementById("charts") as HTMLElement;
  const marker = new maplibregl.Marker({ color: "#4fb6c4", scale: 0.8 });
  let chartState: { title: string; series: ChartSeries[] } | null = null;

  const drawCharts = () => {
    if (!chartState) return;
    chartsPanel.style.display = "block";
    renderCharts(
      chartsPanel, chartState.title, meta.timesteps, chartState.series,
      Number(slider.value),
    );
    document.getElementById("charts-close")?.addEventListener("click", () => {
      chartsPanel.style.display = "none";
      marker.remove();
      chartState = null;
    });
  };

  map.on("click", async (e) => {
    const { lng, lat } = e.lngLat;
    if (lng < west || lng > east || lat < south || lat > north) return;
    marker.setLngLat(e.lngLat).addTo(map);
    chartState = {
      title: `${lat.toFixed(2)}°N ${lng.toFixed(2)}°E <button id="charts-close">✕</button>`,
      series: [],
    };
    chartsPanel.style.display = "block";
    chartsPanel.innerHTML = `<div class="charts-title">loading point data…</div>`;

    const jobs: Promise<ChartSeries>[] = [];
    if (meta.variables["temperature"]) {
      jobs.push(
        ds.getPointSeries("temperature", lng, lat).then((s) => ({
          label: "temperature", unit: "°C", values: s.values, kind: "line", color: "#fbb43d",
        })),
      );
    }
    if (meta.variables["precipitation"]) {
      jobs.push(
        ds.getPointSeries("precipitation", lng, lat).then((s) => ({
          label: "rain", unit: " mm/h", values: s.values, kind: "bar", color: "#38bdf8",
        })),
      );
    }
    if (hasWind) {
      const { u, v } = ds.vectorGroup("wind");
      jobs.push(
        Promise.all([ds.getPointSeries(u, lng, lat), ds.getPointSeries(v, lng, lat)]).then(
          ([su, sv]) => ({
            label: "wind",
            unit: " m/s",
            values: su.values.map((uv, i) => {
              const vv = sv.values[i];
              return uv === null || vv === null || vv === undefined ? null : Math.hypot(uv, vv);
            }),
            kind: "line",
            color: "#35b779",
          }),
        ),
      );
    }
    try {
      chartState.series = await Promise.all(jobs);
    } catch (err) {
      chartsPanel.innerHTML = `<div class="charts-title">failed to load point data</div>`;
      console.error(err);
      return;
    }
    drawCharts();
  });

  const setTimestep = (t: number) => {
    slider.value = String(t);
    show("timestamp", new Date(meta.timesteps[t]!).toUTCString());
    for (const layer of layers) layer.setTimestep(t);
    drawCharts();
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
