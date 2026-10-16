import { describe, expect, it } from "vitest";
import { bboxOf, distance, dms, fmtArea, fmtLength, pathLength, ringArea, scaleDenominator } from "../src/geo";

describe("distance / pathLength", () => {
  it("è zero sullo stesso punto e simmetrica", () => {
    expect(distance([12.5, 42], [12.5, 42])).toBe(0);
    const ab = distance([12.5, 41.9], [9.19, 45.46]);
    expect(distance([9.19, 45.46], [12.5, 41.9])).toBeCloseTo(ab, 6);
    expect(ab).toBeGreaterThan(450_000);
    expect(ab).toBeLessThan(520_000);
  });

  it("un grado di longitudine all'equatore è circa 111 km", () => {
    const d = distance([0, 0], [1, 0]);
    expect(d).toBeGreaterThan(111_000);
    expect(d).toBeLessThan(111_400);
  });

  it("somma i segmenti e ignora percorsi troppo corti", () => {
    expect(pathLength([])).toBe(0);
    expect(pathLength([[0, 0]])).toBe(0);
    const a: [number, number] = [0, 0];
    const b: [number, number] = [1, 0];
    const c: [number, number] = [1, 1];
    expect(pathLength([a, b, c])).toBeCloseTo(distance(a, b) + distance(b, c), 6);
  });
});

describe("ringArea", () => {
  it("è zero con meno di 3 vertici", () => {
    expect(ringArea([])).toBe(0);
    expect(ringArea([[0, 0], [1, 0]])).toBe(0);
  });

  it("un grado quadrato all'equatore è nell'ordine di 12 000 km²", () => {
    const area = ringArea([[0, 0], [1, 0], [1, 1], [0, 1]]);
    expect(area).toBeGreaterThan(1.1e10);
    expect(area).toBeLessThan(1.4e10);
  });
});

describe("formattazione", () => {
  it("formatta lunghezze in m o km", () => {
    expect(fmtLength(12.34)).toBe("12.3 m");
    expect(fmtLength(1000)).toBe("1.00 km");
    expect(fmtLength(100_000)).toBe("100.0 km");
  });

  it("formatta aree in m², ha o km²", () => {
    expect(fmtArea(1.26)).toBe("1.3 m²");
    expect(fmtArea(15_000)).toBe("1.50 ha");
    expect(fmtArea(2_500_000)).toBe("2.500 km²");
  });
});

describe("dms / scala / bbox", () => {
  it("esprime latitudine e longitudine in gradi-minuti-secondi", () => {
    expect(dms(41.9028, "lat")).toBe("41° 54′ 10.08″ N");
    expect(dms(-12.5, "lng")).toBe("12° 30′ 0.00″ W");
    expect(dms(0, "lat")).toBe("0° 0′ 0.00″ N");
    expect(dms(0, "lng")).toBe("0° 0′ 0.00″ E");
  });

  it("calcola il denominatore di scala a 96 dpi", () => {
    expect(scaleDenominator(0, 0)).toBeCloseTo(78271.516964 / 0.00028, 3);
    expect(scaleDenominator(1, 0)).toBeCloseTo(scaleDenominator(0, 0) / 2, 3);
    expect(scaleDenominator(5, 60)).toBeLessThan(scaleDenominator(5, 0));
  });

  it("calcola il bounding box di geometrie GeoJSON, anche annidate", () => {
    expect(bboxOf([])).toBeNull();
    expect(bboxOf([null, { type: "GeometryCollection", geometries: [] }])).toBeNull();
    expect(bboxOf([
      { type: "Point", coordinates: [1, 2] },
      { type: "LineString", coordinates: [[0, 3], [4, -1]] },
      { type: "GeometryCollection", geometries: [{ type: "Point", coordinates: [8, 5] }] },
    ])).toEqual([0, -1, 8, 5]);
  });
});
