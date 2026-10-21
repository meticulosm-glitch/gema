import type Keycloak from "keycloak-js";
import { exceptionText } from "./api";

/** Riquadro geografico in gradi: ovest, sud, est, nord (EPSG:4326). */
export type Bounds = [number, number, number, number];

export type VectorFormat = "geojson" | "csv" | "shp";
export const VECTOR_FORMATS: { id: VectorFormat; label: string; outputFormat: string; ext: string }[] = [
  { id: "geojson", label: "GeoJSON", outputFormat: "application/json", ext: "geojson" },
  { id: "csv", label: "CSV (geometria in WKT)", outputFormat: "csv", ext: "csv" },
  { id: "shp", label: "Shapefile (zip)", outputFormat: "SHAPE-ZIP", ext: "zip" },
];
export const vectorFormat = (id: VectorFormat) => VECTOR_FORMATS.find((f) => f.id === id) ?? VECTOR_FORMATS[0];

/** Limite predefinito di oggetti per uno scarico vettoriale (sovrascrivibile da config.json: downloadMaxFeatures). */
export const DEFAULT_MAX_FEATURES = 50000;

const enc = encodeURIComponent;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const num = (v: number) => Number(v.toFixed(6)).toString();

/** Riporta il riquadro dentro i limiti della Terra (la mappa può mostrare più di un giro di longitudini). */
export function clampBounds([w, s, e, n]: Bounds): Bounds {
  return [clamp(w, -180, 180), clamp(s, -90, 90), clamp(e, -180, 180), clamp(n, -90, 90)];
}

/** Intersezione di due riquadri; null se non si toccano. */
export function intersect(a: Bounds, b?: Bounds): Bounds | null {
  if (!b) return a;
  const r: Bounds = [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])];
  return r[0] < r[2] && r[1] < r[3] ? r : null;
}

/** Nome di colonna per il CQL: tra virgolette se non è un identificatore semplice. */
export const cqlIdent = (n: string) => (/^[A-Za-z_][A-Za-z0-9_]*$/.test(n) ? n : `"${n.replace(/"/g, '""')}"`);

/** Filtro CQL dello scarico: il filtro del layer (se c'è) e, se richiesto, l'area. */
export function downloadFilter(geomName: string, cql: string | undefined, area: Bounds | null): string {
  const parts: string[] = [];
  if (cql?.trim()) parts.push(`(${cql.trim()})`);
  if (area) {
    const [w, s, e, n] = clampBounds(area).map(num);
    parts.push(`BBOX(${cqlIdent(geomName)},${w},${s},${e},${n},'EPSG:4326')`);
  }
  return parts.join(" AND ");
}

/** WFS GetFeature (1.0.0: lon/lat) nel formato scelto, con filtro, data e tetto agli oggetti. */
export function wfsDownloadUrl(gsUrl: string, layer: string, format: VectorFormat, o: { filter?: string; time?: string; max: number }): string {
  const f = vectorFormat(format);
  let u =
    `${gsUrl}/ows?service=WFS&version=1.0.0&request=GetFeature&typeName=${enc(layer)}` +
    `&outputFormat=${enc(f.outputFormat)}&srsName=EPSG:4326&maxFeatures=${Math.max(1, Math.floor(o.max))}`;
  if (o.filter?.trim()) u += `&cql_filter=${enc(o.filter.trim())}`;
  if (o.time?.trim()) u += `&time=${enc(o.time.trim())}`;
  if (format === "shp") u += `&format_options=${enc("CHARSET:UTF-8")}`; // accenti corretti nel .dbf
  return u;
}

/** Id della copertura in WCS 2.0 per un layer "ws:nome" (GeoServer usa "ws__nome"). */
export const coverageId = (layer: string) => layer.replace(":", "__");
/** Layer "ws:nome" da un id di copertura WCS 2.0. */
export const layerFromCoverageId = (id: string) => id.replace("__", ":");

/** Data utilizzabile per tagliare una copertura: solo un istante, non intervalli o elenchi. */
export function singleInstant(time?: string): string | null {
  const t = time?.trim() ?? "";
  return t && !t.includes("/") && !t.includes(",") ? t : null;
}

/** WCS 2.0.1 GetCoverage in GeoTIFF, ritagliato sull'area (in gradi) e, se c'è, sulla data. */
export function wcsDownloadUrl(gsUrl: string, layer: string, area: Bounds, time?: string): string {
  const [w, s, e, n] = clampBounds(area).map(num);
  let u =
    `${gsUrl}/ows?service=WCS&version=2.0.1&request=GetCoverage&coverageId=${enc(coverageId(layer))}&format=${enc("image/tiff")}` +
    `&subset=${enc(`Long(${w},${e})`)}&subset=${enc(`Lat(${s},${n})`)}` +
    `&subsettingCRS=${enc("http://www.opengis.net/def/crs/EPSG/0/4326")}`;
  const t = singleInstant(time);
  if (t) u += `&subset=${enc(`time("${t}")`)}`;
  return u;
}

/** Nome del file: layer senza caratteri strani, data e ora locali. */
export function downloadName(layer: string, ext: string, now = new Date()): string {
  const base = layer.replace(/^[^:]*:/, "").replace(/[^\w.-]+/g, "_").replace(/^_+|_+$/g, "") || "dati";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${base}_${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}.${ext}`;
}

/**
 * Scarica un file da GeoServer con le credenziali dell'utente. GeoServer risponde agli errori con status 200 e un XML:
 * se arriva un XML/HTML dove ci si aspetta un file, si lancia con il messaggio di GeoServer.
 */
export async function fetchDownload(url: string, kc: Keycloak | null, expect: "json" | "text" | "binary", signal?: AbortSignal): Promise<Blob> {
  const r = await fetch(url, { headers: kc?.token ? { Authorization: `Bearer ${kc.token}` } : {}, ...(signal ? { signal } : {}) });
  const type = (r.headers.get("content-type") ?? "").toLowerCase();
  const blob = await r.blob();
  const looksLikeError = /xml|html/.test(type) || (expect !== "text" && type.startsWith("text/") && !type.includes("csv"));
  if (!r.ok || looksLikeError) {
    const body = await blob.text();
    if (r.status === 401) throw new Error("non autorizzato (HTTP 401)");
    if (r.status === 403) throw new Error("accesso negato (HTTP 403)");
    throw new Error(exceptionText(body) ?? (r.ok ? "GeoServer non ha restituito un file" : `HTTP ${r.status}`));
  }
  if (blob.size === 0) throw new Error("file vuoto");
  return blob;
}

/** Fa scaricare il file al browser. */
export function saveBlob(blob: Blob, name: string): void {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 30_000);
}

/** Dimensione leggibile. */
export const fmtBytes = (b: number) =>
  b < 1024 ? `${b} B` : b < 1024 ** 2 ? `${(b / 1024).toFixed(1).replace(".", ",")} KB` : `${(b / 1024 ** 2).toFixed(1).replace(".", ",")} MB`;
