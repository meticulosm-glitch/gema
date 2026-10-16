import type { Schema } from "./api";
import type { LngLat } from "./geo";

export type Geom = { type: string; coordinates?: any };
export type Kind = "point" | "line" | "polygon";

// ---------------------------------------------------------------- XML (WFS 1.0.0 + GML2, ordine lon/lat)
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const pos = (c: number[]) => `${c[0]},${c[1]}`;
const SRS = 'srsName="EPSG:4326"';
const coords = (cs: number[][]) => `<gml:coordinates>${cs.map(pos).join(" ")}</gml:coordinates>`;
const poly = (rings: number[][][]) =>
  rings
    .map((r, i) => {
      const t = i === 0 ? "outer" : "inner";
      return `<gml:${t}BoundaryIs><gml:LinearRing>${coords(r)}</gml:LinearRing></gml:${t}BoundaryIs>`;
    })
    .join("");

export function gml(g: Geom): string {
  const c = g.coordinates;
  switch (g.type) {
    case "Point": return `<gml:Point ${SRS}>${coords([c])}</gml:Point>`;
    case "LineString": return `<gml:LineString ${SRS}>${coords(c)}</gml:LineString>`;
    case "Polygon": return `<gml:Polygon ${SRS}>${poly(c)}</gml:Polygon>`;
    case "MultiPoint":
      return `<gml:MultiPoint ${SRS}>${c.map((p: number[]) => `<gml:pointMember><gml:Point>${coords([p])}</gml:Point></gml:pointMember>`).join("")}</gml:MultiPoint>`;
    case "MultiLineString":
      return `<gml:MultiLineString ${SRS}>${c.map((l: number[][]) => `<gml:lineStringMember><gml:LineString>${coords(l)}</gml:LineString></gml:lineStringMember>`).join("")}</gml:MultiLineString>`;
    case "MultiPolygon":
      return `<gml:MultiPolygon ${SRS}>${c.map((pg: number[][][]) => `<gml:polygonMember><gml:Polygon>${poly(pg)}</gml:Polygon></gml:polygonMember>`).join("")}</gml:MultiPolygon>`;
  }
  throw new Error(`geometria non supportata: ${g.type}`);
}

const tx = (s: Schema, body: string) =>
  `<?xml version="1.0" encoding="UTF-8"?><wfs:Transaction service="WFS" version="1.0.0" ` +
  `xmlns:wfs="http://www.opengis.net/wfs" xmlns:ogc="http://www.opengis.net/ogc" xmlns:gml="http://www.opengis.net/gml" ` +
  `xmlns:${s.prefix}="${esc(s.ns)}">${body}</wfs:Transaction>`;
const byId = (id: string) => `<ogc:Filter><ogc:FeatureId fid="${esc(id)}"/></ogc:Filter>`;
const typeName = (s: Schema) => `${s.prefix}:${s.typeName}`;

/** changes: nome campo -> nuovo valore (null = imposta a NULL). `geom` solo se la geometria è cambiata. */
export function buildUpdate(s: Schema, id: string, changes: Record<string, string | null>, geom?: Geom | null): string {
  const props = Object.entries(changes).map(
    ([k, v]) => `<wfs:Property><wfs:Name>${esc(k)}</wfs:Name>${v === null ? "" : `<wfs:Value>${esc(v)}</wfs:Value>`}</wfs:Property>`,
  );
  if (geom) props.push(`<wfs:Property><wfs:Name>${esc(s.geomName)}</wfs:Name><wfs:Value>${gml(geom)}</wfs:Value></wfs:Property>`);
  return tx(s, `<wfs:Update typeName="${typeName(s)}">${props.join("")}${byId(id)}</wfs:Update>`);
}

export function buildInsert(s: Schema, values: Record<string, string>, geom: Geom): string {
  const fields = Object.entries(values).map(([k, v]) => `<${s.prefix}:${k}>${esc(v)}</${s.prefix}:${k}>`).join("");
  const g = `<${s.prefix}:${s.geomName}>${gml(geom)}</${s.prefix}:${s.geomName}>`;
  return tx(s, `<wfs:Insert><${typeName(s)}>${fields}${g}</${typeName(s)}></wfs:Insert>`);
}

export function buildDelete(s: Schema, id: string): string {
  return tx(s, `<wfs:Delete typeName="${typeName(s)}">${byId(id)}</wfs:Delete>`);
}

// ---------------------------------------------------------------- geometria disegnata
/** Tipo di disegno imposto dal layer; null se il layer ammette geometrie generiche (sceglie l'utente). */
export function kindFor(geomType: string): Kind | null {
  if (geomType.includes("Point")) return "point";
  if (geomType.includes("Line")) return "line";
  if (geomType.includes("Polygon")) return "polygon";
  return null;
}

export function minPoints(kind: Kind): number {
  return kind === "point" ? 1 : kind === "line" ? 2 : 3;
}

export function buildGeometry(kind: Kind, pts: LngLat[], geomType: string): Geom {
  const multi = geomType.startsWith("Multi");
  if (kind === "point") return multi ? { type: "MultiPoint", coordinates: [pts[0]] } : { type: "Point", coordinates: pts[0] };
  if (kind === "line") return multi ? { type: "MultiLineString", coordinates: [pts] } : { type: "LineString", coordinates: pts };
  const ring = [...pts, pts[0]];
  return multi ? { type: "MultiPolygon", coordinates: [[ring]] } : { type: "Polygon", coordinates: [ring] };
}

// ---------------------------------------------------------------- modifica dei vertici
export interface Vtx { path: number[]; c: [number, number] }
export interface Seg { container: number[]; at: number; mid: [number, number] }

const isPoly = (t: string) => t.includes("Polygon");
const arrayAt = (g: Geom, path: number[]): any => path.reduce((a: any, i) => a[i], g.coordinates);
const r8 = (n: number) => Math.round(n * 1e8) / 1e8;

export const parsePath = (s: string): number[] => (s === "" ? [] : s.split(",").map(Number));

/** Vertici modificabili (negli anelli dei poligoni l'ultimo punto, uguale al primo, è escluso). */
export function vertices(g: Geom): Vtx[] {
  const out: Vtx[] = [];
  const c = g.coordinates;
  switch (g.type) {
    case "Point": out.push({ path: [], c }); break;
    case "MultiPoint":
    case "LineString": c.forEach((p: any, i: number) => out.push({ path: [i], c: p })); break;
    case "MultiLineString": c.forEach((l: any, j: number) => l.forEach((p: any, i: number) => out.push({ path: [j, i], c: p }))); break;
    case "Polygon": c.forEach((r: any, j: number) => r.slice(0, -1).forEach((p: any, i: number) => out.push({ path: [j, i], c: p }))); break;
    case "MultiPolygon":
      c.forEach((pg: any, k: number) => pg.forEach((r: any, j: number) => r.slice(0, -1).forEach((p: any, i: number) => out.push({ path: [k, j, i], c: p }))));
      break;
  }
  return out;
}

/** Segmenti su cui si può inserire un nuovo vertice (punto medio trascinabile). */
export function segments(g: Geom): Seg[] {
  const out: Seg[] = [];
  const line = (arr: number[][], container: number[]) => {
    for (let i = 0; i < arr.length - 1; i++) {
      out.push({ container, at: i + 1, mid: [(arr[i][0] + arr[i + 1][0]) / 2, (arr[i][1] + arr[i + 1][1]) / 2] });
    }
  };
  const c = g.coordinates;
  switch (g.type) {
    case "LineString": line(c, []); break;
    case "MultiLineString": c.forEach((l: any, j: number) => line(l, [j])); break;
    case "Polygon": c.forEach((r: any, j: number) => line(r, [j])); break;
    case "MultiPolygon": c.forEach((pg: any, k: number) => pg.forEach((r: any, j: number) => line(r, [k, j]))); break;
  }
  return out;
}

export function moveVertex(g: Geom, path: number[], c: [number, number]): void {
  const n: [number, number] = [r8(c[0]), r8(c[1])];
  if (path.length === 0) { g.coordinates = n; return; }
  const arr = arrayAt(g, path.slice(0, -1));
  const i = path[path.length - 1];
  arr[i] = n;
  if (isPoly(g.type) && i === 0) arr[arr.length - 1] = [...n]; // mantiene l'anello chiuso
}

/** Inserisce un vertice e restituisce il suo percorso. */
export function insertVertex(g: Geom, seg: Seg, c: [number, number]): number[] {
  arrayAt(g, seg.container).splice(seg.at, 0, [r8(c[0]), r8(c[1])]);
  return [...seg.container, seg.at];
}

/** Rimuove un vertice se la geometria resta valida (≥2 punti per le linee, ≥3 per gli anelli). */
export function removeVertex(g: Geom, path: number[]): boolean {
  if (path.length === 0) return false;
  const arr = arrayAt(g, path.slice(0, -1));
  const i = path[path.length - 1];
  // lunghezza minima prima della rimozione: anello chiuso 5 (triangolo + chiusura), linea 3, multipunto 2
  const min = isPoly(g.type) ? 5 : g.type === "MultiPoint" ? 2 : 3;
  if (arr.length < min) return false;
  arr.splice(i, 1);
  if (isPoly(g.type) && i === 0) arr[arr.length - 1] = [...arr[0]];
  return true;
}
