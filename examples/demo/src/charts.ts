/**
 * Tiny dependency-free SVG charts for the point-series panel. Each series
 * becomes one sparkline-style chart; a vertical marker tracks the active
 * timestep of the map's time slider.
 */

export interface ChartSeries {
  label: string;
  unit: string;
  values: (number | null)[];
  kind: "line" | "bar";
  color: string;
}

const W = 296;
const H = 56;
const PAD_TOP = 6;
const PAD_BOTTOM = 4;

function scale(values: (number | null)[], kind: "line" | "bar") {
  const present = values.filter((v): v is number => v !== null);
  let min = Math.min(...present);
  let max = Math.max(...present);
  if (kind === "bar") min = 0;
  if (max - min < 1e-9) {
    max = min + 1;
    if (kind === "line") min -= 1;
  }
  const innerH = H - PAD_TOP - PAD_BOTTOM;
  return {
    min,
    max,
    x: (i: number) => (i / Math.max(values.length - 1, 1)) * W,
    y: (v: number) => PAD_TOP + (1 - (v - min) / (max - min)) * innerH,
  };
}

function chartSvg(series: ChartSeries, current: number): string {
  const { values, kind, color } = series;
  const s = scale(values, kind);
  const parts: string[] = [];

  if (kind === "bar") {
    const bw = Math.max(W / values.length - 1, 1);
    for (let i = 0; i < values.length; i++) {
      const v = values[i];
      if (v === null || v <= 0) continue;
      const y = s.y(v);
      parts.push(
        `<rect x="${(s.x(i) - bw / 2).toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${(H - PAD_BOTTOM - y).toFixed(1)}" fill="${color}" opacity="0.9"/>`,
      );
    }
  } else {
    let d = "";
    let pen = false;
    for (let i = 0; i < values.length; i++) {
      const v = values[i];
      if (v === null) {
        pen = false;
        continue;
      }
      d += `${pen ? "L" : "M"}${s.x(i).toFixed(1)},${s.y(v).toFixed(1)}`;
      pen = true;
    }
    parts.push(`<path d="${d}" fill="none" stroke="${color}" stroke-width="1.6"/>`);
  }

  // active-timestep marker
  const cx = s.x(current).toFixed(1);
  parts.push(`<line x1="${cx}" y1="0" x2="${cx}" y2="${H}" stroke="rgba(255,255,255,0.35)" stroke-width="1"/>`);

  const fmt = (v: number) => (Math.abs(v) >= 10 ? v.toFixed(0) : v.toFixed(1));
  const cur = values[current];
  const curText = cur === null || cur === undefined ? "–" : fmt(cur);
  return `
    <div class="chart">
      <div class="chart-head">
        <span>${series.label}</span>
        <span class="chart-cur" style="color:${color}">${curText}${series.unit}</span>
        <span class="chart-range">${fmt(s.min)}–${fmt(s.max)}${series.unit}</span>
      </div>
      <svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" preserveAspectRatio="none">${parts.join("")}</svg>
    </div>`;
}

export function renderCharts(
  root: HTMLElement,
  title: string,
  timesteps: string[],
  series: ChartSeries[],
  current: number,
): void {
  const t = (i: number) =>
    new Date(timesteps[i]!).toUTCString().slice(17, 22);
  root.innerHTML = `
    <div class="charts-title">${title}</div>
    ${series.map((entry) => chartSvg(entry, current)).join("")}
    <div class="chart-times"><span>${t(0)}</span><span>${t(Math.floor((timesteps.length - 1) / 2))}</span><span>${t(timesteps.length - 1)}</span></div>`;
}
