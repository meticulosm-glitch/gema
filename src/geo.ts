export type LngLat = [number, number];
export type BBox = [number, number, number, number]; // west, south, east, north

const R = 6371008.8; // raggio medio terrestre (m)
const rad = (d: number) => (d * Math.PI) / 180;

export function distance(a: LngLat, b: LngLat): number {
  const dLat = rad(b[1] - a[1]);
  const dLng = rad(b[0] - a[0]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[1])) * Math.cos(rad(b[1])) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function pathLength(pts: LngLat[]): number {
  let t = 0;
  for (let i = 1; i < pts.length; i++) t += distance(pts[i - 1], pts[i]);
  return t;
}

/** Area (m²) di un anello su sfera — formula di Chamberlain–Duquette. */
export function ringArea(pts: LngLat[]): number {
  if (pts.length < 3) return 0;
  let s = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[(i + 1) % pts.length];
    s += rad(x2 - x1) * (2 + Math.sin(rad(y1)) + Math.sin(rad(y2)));
  }
  return Math.abs((s * R * R) / 2);
}

export const fmtLength = (m: number) =>
  m >= 1000 ? `${(m / 1000).toFixed(m >= 100000 ? 1 : 2)} km` : `${m.toFixed(1)} m`;

export const fmtArea = (m2: number) =>
  m2 >= 1e6 ? `${(m2 / 1e6).toFixed(3)} km²` : m2 >= 1e4 ? `${(m2 / 1e4).toFixed(2)} ha` : `${m2.toFixed(1)} m²`;

export function dms(v: number, axis: "lat" | "lng"): string {
  const h = axis === "lat" ? (v >= 0 ? "N" : "S") : v >= 0 ? "E" : "W";
  const a = Math.abs(v);
  const d = Math.floor(a);
  const m = Math.floor((a - d) * 60);
  const s = ((a - d) * 60 - m) * 60;
  return `${d}° ${m}′ ${s.toFixed(2)}″ ${h}`;
}

/** Denominatore di scala indicativo (96 dpi) per lo zoom MapLibre (tile 512 px). */
export function scaleDenominator(zoom: number, lat: number): number {
  const metersPerPixel = (78271.516964 * Math.cos(rad(lat))) / 2 ** zoom;
  return metersPerPixel / 0.00028;
}

/** Bounding box di una lista di geometrie GeoJSON. */
export function bboxOf(geoms: any[]): BBox | null {
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  const walk = (c: any) => {
    if (typeof c?.[0] === "number") {
      w = Math.min(w, c[0]); e = Math.max(e, c[0]);
      s = Math.min(s, c[1]); n = Math.max(n, c[1]);
    } else if (Array.isArray(c)) c.forEach(walk);
  };
  const walkGeom = (g: any) => {
    if (!g) return;
    if (g.type === "GeometryCollection") g.geometries?.forEach(walkGeom);
    else walk(g.coordinates);
  };
  geoms.forEach(walkGeom);
  return Number.isFinite(w) ? [w, s, e, n] : null;
}
