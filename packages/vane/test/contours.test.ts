import { describe, expect, it } from "vitest";

import { contourLines, levelRange } from "../src/render/contours.js";

describe("levelRange", () => {
  it("spans min..max at the interval, anchored on base", () => {
    expect(levelRange(1007.4, 1028.2, 4)).toEqual([1008, 1012, 1016, 1020, 1024, 1028]);
    expect(levelRange(-3, 3, 2)).toEqual([-2, 0, 2]);
    expect(levelRange(0, 10, 4, 1)).toEqual([1, 5, 9]);
  });
});

describe("contourLines", () => {
  it("draws a straight iso-line through a linear gradient", () => {
    // 3x3 grid increasing left→right: 0 1 2 on every row.
    const values = [0, 1, 2, 0, 1, 2, 0, 1, 2];
    const lines = contourLines(values, 3, 3, [0.5]);
    expect(lines).toHaveLength(1);
    const { points } = lines[0]!;
    // Vertical line at x = 0.5 spanning all rows.
    for (const [x] of points) expect(x).toBeCloseTo(0.5);
    const ys = points.map(([, y]) => y).sort((a, b) => a - b);
    expect(ys[0]).toBe(0);
    expect(ys[ys.length - 1]).toBe(2);
  });

  it("closes a ring around a single peak", () => {
    // 5x5 zeros with a peak in the middle.
    const values = new Array(25).fill(0);
    values[12] = 10;
    const lines = contourLines(values, 5, 5, [5]);
    expect(lines).toHaveLength(1);
    const { points } = lines[0]!;
    // A closed ring: first and last point coincide.
    expect(points.length).toBeGreaterThan(3);
    expect(points[0]![0]).toBeCloseTo(points[points.length - 1]![0]);
    expect(points[0]![1]).toBeCloseTo(points[points.length - 1]![1]);
    // Crossing points sit where interpolation says: 0→10 crosses 5 at 0.5 cells from the peak.
    for (const [x, y] of points) {
      expect(Math.abs(x - 2) + Math.abs(y - 2)).toBeCloseTo(0.5);
    }
  });

  it("skips cells touching nodata (NaN)", () => {
    const values = [0, 1, 2, 0, NaN, 2, 0, 1, 2];
    const lines = contourLines(values, 3, 3, [0.5]);
    // Only cells not touching the NaN produce segments — none here span rows 0-2 fully.
    for (const line of lines) {
      for (const [, y] of line.points) {
        // No point may sit strictly inside the NaN-adjacent band's interior columns.
        expect(Number.isFinite(y)).toBe(true);
      }
    }
    // The gradient line breaks into (at most) short pieces instead of one full-height line.
    const totalPoints = lines.reduce((n, l) => n + l.points.length, 0);
    expect(totalPoints).toBeLessThan(4);
  });

  it("handles multiple levels independently", () => {
    const values = [0, 1, 2, 0, 1, 2, 0, 1, 2];
    const lines = contourLines(values, 3, 3, [0.5, 1.5]);
    expect(lines).toHaveLength(2);
    expect(lines.map((l) => l.level)).toEqual([0.5, 1.5]);
    for (const [x] of lines[1]!.points) expect(x).toBeCloseTo(1.5);
  });
});
