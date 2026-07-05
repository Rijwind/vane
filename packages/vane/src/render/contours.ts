/**
 * Marching squares over a point grid — the pure geometry half of the
 * `contours` render mode (no MapLibre imports, unit-tested).
 *
 * Coordinates are grid-space: x = column index, y = row index, fractional
 * along cell edges. The caller maps them to lon/lat (the Vane grid is
 * linear in both, so this is a scale+offset).
 */

export interface ContourLine {
  level: number;
  /** Polyline in grid coordinates [x, y]; closed rings repeat the first point. */
  points: Array<[number, number]>;
}

type Point = [number, number];
type Segment = [Point, Point];

/** Segment endpoints per marching-squares case, as edge names. */
const EDGE_SEGMENTS: Record<number, Array<[string, string]>> = {
  1: [["left", "bottom"]],
  2: [["bottom", "right"]],
  3: [["left", "right"]],
  4: [["top", "right"]],
  6: [["top", "bottom"]],
  7: [["top", "left"]],
  8: [["top", "left"]],
  9: [["top", "bottom"]],
  11: [["top", "right"]],
  12: [["left", "right"]],
  13: [["bottom", "right"]],
  14: [["left", "bottom"]],
};

/**
 * Extract iso-lines for each level. `values` is row-major, row 0 first,
 * NaN = nodata (cells touching nodata are skipped).
 */
export function contourLines(
  values: ArrayLike<number>,
  width: number,
  height: number,
  levels: number[],
): ContourLine[] {
  const lines: ContourLine[] = [];
  for (const level of levels) {
    const segments: Segment[] = [];
    for (let i = 0; i < height - 1; i++) {
      for (let j = 0; j < width - 1; j++) {
        const tl = Number(values[i * width + j]);
        const tr = Number(values[i * width + j + 1]);
        const br = Number(values[(i + 1) * width + j + 1]);
        const bl = Number(values[(i + 1) * width + j]);
        if (Number.isNaN(tl) || Number.isNaN(tr) || Number.isNaN(br) || Number.isNaN(bl)) {
          continue;
        }
        const caseIndex =
          (tl >= level ? 8 : 0) | (tr >= level ? 4 : 0) | (br >= level ? 2 : 0) | (bl >= level ? 1 : 0);
        if (caseIndex === 0 || caseIndex === 15) continue;

        const frac = (a: number, b: number) => (level - a) / (b - a);
        const edges: Record<string, Point> = {
          top: [j + frac(tl, tr), i],
          right: [j + 1, i + frac(tr, br)],
          bottom: [j + frac(bl, br), i + 1],
          left: [j, i + frac(tl, bl)],
        };

        let pairs = EDGE_SEGMENTS[caseIndex];
        if (caseIndex === 5 || caseIndex === 10) {
          // Saddle: resolve with the cell-center average.
          const centerAbove = (tl + tr + br + bl) / 4 >= level;
          const trBlAbove = caseIndex === 5;
          pairs =
            trBlAbove === centerAbove
              ? [["top", "left"], ["bottom", "right"]]
              : [["top", "right"], ["left", "bottom"]];
        }
        for (const [e0, e1] of pairs!) {
          segments.push([edges[e0]!, edges[e1]!]);
        }
      }
    }
    for (const points of chainSegments(segments)) {
      lines.push({ level, points });
    }
  }
  return lines;
}

const key = (p: Point) => `${Math.round(p[0] * 4096)},${Math.round(p[1] * 4096)}`;

/** Join loose segments into polylines by matching endpoints. */
function chainSegments(segments: Segment[]): Point[][] {
  const byEndpoint = new Map<string, number[]>();
  segments.forEach((segment, index) => {
    for (const p of segment) {
      const k = key(p);
      const list = byEndpoint.get(k);
      if (list) list.push(index);
      else byEndpoint.set(k, [index]);
    }
  });

  const used = new Array<boolean>(segments.length).fill(false);
  const takeNext = (endpoint: Point): Segment | null => {
    for (const index of byEndpoint.get(key(endpoint)) ?? []) {
      if (!used[index]) {
        used[index] = true;
        return segments[index]!;
      }
    }
    return null;
  };

  const polylines: Point[][] = [];
  for (let start = 0; start < segments.length; start++) {
    if (used[start]) continue;
    used[start] = true;
    const line: Point[] = [...segments[start]!];
    for (;;) {
      const next = takeNext(line[line.length - 1]!);
      if (!next) break;
      line.push(key(next[0]) === key(line[line.length - 1]!) ? next[1]! : next[0]!);
    }
    for (;;) {
      const previous = takeNext(line[0]!);
      if (!previous) break;
      line.unshift(key(previous[0]) === key(line[0]!) ? previous[1]! : previous[0]!);
    }
    polylines.push(line);
  }
  return polylines;
}

/**
 * Douglas-Peucker line simplification (tolerance in grid units).
 *
 * Marching squares emits stair-steps at cell resolution; MapLibre refuses
 * to place line labels along such jagged geometry (text-max-angle), so
 * contour lines should be simplified before display. ~0.35 cells keeps the
 * shape while flattening the stairs. Also drops duplicate points (degenerate
 * segments occur when a grid value equals a level exactly).
 */
export function simplifyLine(points: Point[], tolerance: number): Point[] {
  if (points.length < 3) return points;
  const keep = new Array<boolean>(points.length).fill(false);
  keep[0] = keep[points.length - 1] = true;
  const stack: Array<[number, number]> = [[0, points.length - 1]];
  while (stack.length) {
    const [first, last] = stack.pop()!;
    const [x0, y0] = points[first]!;
    const [x1, y1] = points[last]!;
    const dx = x1 - x0;
    const dy = y1 - y0;
    const norm = Math.hypot(dx, dy);
    let maxDist = -1;
    let maxIndex = -1;
    for (let i = first + 1; i < last; i++) {
      const [x, y] = points[i]!;
      const dist =
        norm === 0
          ? Math.hypot(x - x0, y - y0)
          : Math.abs(dy * x - dx * y + x1 * y0 - y1 * x0) / norm;
      if (dist > maxDist) {
        maxDist = dist;
        maxIndex = i;
      }
    }
    if (maxDist > tolerance) {
      keep[maxIndex] = true;
      stack.push([first, maxIndex], [maxIndex, last]);
    }
  }
  const result: Point[] = [];
  for (let i = 0; i < points.length; i++) {
    if (!keep[i]) continue;
    const previous = result[result.length - 1];
    if (previous && previous[0] === points[i]![0] && previous[1] === points[i]![1]) continue;
    result.push(points[i]!);
  }
  return result;
}

/** Levels spanning [min, max] at `interval`, phase-anchored on `base`. */
export function levelRange(
  min: number,
  max: number,
  interval: number,
  base = 0,
): number[] {
  const levels: number[] = [];
  const start = Math.ceil((min - base) / interval) * interval + base;
  for (let level = start; level <= max; level += interval) levels.push(level);
  return levels;
}
