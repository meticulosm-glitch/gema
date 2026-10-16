import type Keycloak from "keycloak-js";
import type * as maplibregl from "maplibre-gl";
import { getFeatureInfo, type Feature, type LayerParams } from "./api";

/** Un istante della serie: tutte le proprietà numeriche restituite da GetFeatureInfo (banda o attributo -> valore). */
export interface SeriesPoint {
  t: string;                              // istante TIME, come inviato a GeoServer
  x: number;                              // millisecondi (se le date sono interpretabili) oppure indice
  values: Record<string, number | null>;  // null = nessun dato in quel punto (fuori copertura / NoData)
  error?: string;
}

export interface SeriesData {
  points: SeriesPoint[];
  fields: string[];       // nomi dei valori trovati, in ordine di comparsa
  failed: number;         // richieste fallite
  aborted: boolean;
}

/** Valore numerico di una proprietà: numeri e stringhe numeriche; NaN, vuoti e il resto -> null. */
export function toNumber(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Proprietà numeriche del primo oggetto restituito (per un raster: una per banda). */
export function numericProps(features: Feature[]): Record<string, number | null> {
  const props = features.find((f) => f.properties && Object.keys(f.properties).length > 0)?.properties ?? {};
  const out: Record<string, number | null> = {};
  for (const [k, v] of Object.entries(props)) out[k] = toNumber(v);
  return out;
}

/** Esegue `fn` su tutti gli elementi con al massimo `limit` richieste contemporanee, mantenendo l'ordine dei risultati. */
export async function runPool<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, i: number) => Promise<R>,
  signal?: AbortSignal,
  onDone?: (done: number) => void,
): Promise<(R | undefined)[]> {
  const out: (R | undefined)[] = new Array(items.length);
  let next = 0;
  let done = 0;
  const worker = async () => {
    while (next < items.length && !signal?.aborted) {
      const i = next++;
      out[i] = await fn(items[i], i);
      onDone?.(++done);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** Serie del valore in un punto: una GetFeatureInfo per istante, in parallelo limitato. */
export async function fetchSeries(o: {
  gsUrl: string;
  kc: Keycloak | null;
  layer: string;
  map: maplibregl.Map;
  ll: { lng: number; lat: number };
  params: LayerParams;   // CQL e stile; il TIME viene sostituito da ogni istante
  times: string[];
  signal?: AbortSignal;
  concurrency?: number;
  onProgress?: (done: number, total: number) => void;
}): Promise<SeriesData> {
  const ms = o.times.map((t) => Date.parse(t));
  const useDates = ms.every(Number.isFinite);
  const fields: string[] = [];
  const res = await runPool(
    o.times,
    o.concurrency ?? 6,
    async (t, i): Promise<SeriesPoint> => {
      const x = useDates ? ms[i] : i;
      try {
        const feats = await getFeatureInfo(o.gsUrl, o.kc, o.layer, o.map, o.ll, { ...o.params, time: t }, o.signal);
        const values = numericProps(feats);
        for (const k of Object.keys(values)) if (!fields.includes(k)) fields.push(k);
        return { t, x, values };
      } catch (e: any) {
        if (e?.name === "AbortError") throw e;
        return { t, x, values: {}, error: String(e?.message ?? e) };
      }
    },
    o.signal,
    (d) => o.onProgress?.(d, o.times.length),
  ).catch((e) => {
    if (e?.name === "AbortError") return null;
    throw e;
  });
  if (!res) return { points: [], fields, failed: 0, aborted: true };
  const points = res.filter((p): p is SeriesPoint => !!p).sort((a, b) => a.x - b.x);
  return { points, fields, failed: points.filter((p) => p.error).length, aborted: !!o.signal?.aborted };
}

/** CSV di una serie per un campo: istante ISO e valore con il punto decimale, apribile ovunque. */
export function seriesCsv(points: SeriesPoint[], field: string): string {
  const rows = points.map((p) => `${p.t},${p.values[field] ?? ""}`);
  return ["time," + field.replace(/[",\n]/g, "_"), ...rows].join("\n") + "\n";
}
