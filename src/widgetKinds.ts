import type { Agg, Granularity, WidgetDef, WidgetType } from "./configStore";

/**
 * Tipi di widget delle dashboard: cosa chiedono (layer, campi), cosa scaricano e come si calcolano.
 * Logica pura, usata dalla pagina admin (controlli), dall'importazione (pulizia) e dalla resa (Widgets.tsx).
 */
export const WIDGET_TYPES: { id: WidgetType; label: string }[] = [
  { id: "kpi", label: "KPI (numero)" },
  { id: "gauge", label: "Indicatore con soglie" },
  { id: "bar", label: "Barre per categoria" },
  { id: "pie", label: "Torta (quote per categoria)" },
  { id: "hist", label: "Istogramma (campo numerico)" },
  { id: "time", label: "Colonne per mese (campo data)" },
  { id: "line", label: "Linea temporale (campo data)" },
  { id: "table", label: "Tabella" },
  { id: "map", label: "Mini-mappa" },
  { id: "text", label: "Testo" },
];
export const AGGS: { id: Agg; label: string }[] = [
  { id: "count", label: "Numero di oggetti" }, { id: "sum", label: "Somma" }, { id: "avg", label: "Media" }, { id: "min", label: "Minimo" }, { id: "max", label: "Massimo" },
];
export const GRANULARITIES: { id: Granularity; label: string }[] = [{ id: "day", label: "Giorno" }, { id: "month", label: "Mese" }, { id: "year", label: "Anno" }];

export const usesLayer = (t: WidgetType) => t !== "text";
export const usesField = (t: WidgetType) => ["bar", "pie", "hist", "time", "line"].includes(t);
export const usesAgg = (t: WidgetType) => ["kpi", "gauge", "bar", "pie", "time", "line"].includes(t);
export const isDateField = (t: WidgetType) => t === "time" || t === "line";

export const TABLE_MAX_ROWS = 100;
export const PIE_SLICES = 5; // oltre: "Altri"

/** Problemi di un widget (per la pagina admin). */
export function widgetProblems(w: WidgetDef): string[] {
  const p: string[] = [];
  const name = w.title || WIDGET_TYPES.find((t) => t.id === w.type)?.label || w.type;
  if (usesLayer(w.type) && !w.layer) p.push(`«${name}»: scegli un layer.`);
  if (usesField(w.type) && !w.field) p.push(`«${name}»: scegli il campo.`);
  if (usesAgg(w.type) && w.agg !== "count" && !w.valueField) p.push(`«${name}»: somma, media, minimo e massimo hanno bisogno di un campo del valore.`);
  if (w.type === "table" && !w.columns?.length) p.push(`«${name}»: scegli almeno una colonna.`);
  if (w.type === "text" && !w.text?.trim()) p.push(`«${name}»: scrivi il testo.`);
  if (w.type === "gauge") {
    if (!Number.isFinite(w.warn) || !Number.isFinite(w.crit)) p.push(`«${name}»: indica le due soglie.`);
    else if (w.higherIsWorse !== false ? w.warn! >= w.crit! : w.warn! <= w.crit!) p.push(`«${name}»: la soglia critica deve venire dopo quella di attenzione.`);
    if (Number.isFinite(w.min) && Number.isFinite(w.max) && w.min! >= w.max!) p.push(`«${name}»: il minimo della scala deve essere minore del massimo.`);
  }
  return p;
}

/** Attributi da scaricare via WFS (vuoto = nessuna richiesta: testo e mini-mappa fanno da sé). */
export function propsFor(w: WidgetDef): string[] {
  if (w.type === "text" || w.type === "map") return [];
  if (w.type === "table") return Array.from(new Set([...(w.columns ?? []), ...(w.sortField ? [w.sortField] : [])]));
  return [w.field, w.valueField].filter((x): x is string => !!x);
}

type Row = Record<string, unknown>;

/** Torta: le categorie più grandi e il resto in "Altri" (mai più di PIE_SLICES + 1 spicchi). */
export function pieSlices(items: { key: string; label: string; value: number; cql?: string }[], max = PIE_SLICES) {
  const sorted = [...items].filter((i) => i.value > 0).sort((a, b) => b.value - a.value);
  if (sorted.length <= max + 1) return sorted;
  const rest = sorted.slice(max).reduce((n, i) => n + i.value, 0);
  return [...sorted.slice(0, max), { key: "\u0001altri", label: `Altri (${sorted.length - max})`, value: rest }];
}

/** Chiave del periodo di una data ISO secondo la granularità; null se il valore non è una data. */
export function periodKey(v: unknown, g: Granularity): string | null {
  const s = String(v ?? "");
  if (!/^\d{4}-\d{2}(-\d{2})?/.test(s)) return null;
  return g === "year" ? s.slice(0, 4) : g === "month" ? s.slice(0, 7) : /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null;
}

/** Tabella: righe ordinate (numeri come numeri, vuoti in fondo) e tagliate al limite. */
export function tableRows(rows: Row[], w: WidgetDef): Row[] {
  const limit = Math.min(TABLE_MAX_ROWS, Math.max(1, w.limit ?? 10));
  if (!w.sortField) return rows.slice(0, limit);
  const f = w.sortField;
  const dir = w.sortDesc ? -1 : 1;
  const empty = (v: unknown) => v === null || v === undefined || v === "";
  return [...rows].sort((a, b) => {
    const x = a[f], y = b[f];
    if (empty(x) || empty(y)) return empty(x) === empty(y) ? 0 : empty(x) ? 1 : -1;
    if (typeof x === "number" && typeof y === "number") return (x - y) * dir;
    return String(x).localeCompare(String(y), "it", { numeric: true }) * dir;
  }).slice(0, limit);
}

export type GaugeLevel = "good" | "warning" | "critical";
export const GAUGE_LABEL: Record<GaugeLevel, string> = { good: "nella norma", warning: "attenzione", critical: "critico" };

/** Livello del valore rispetto alle soglie (più alto = peggio, salvo higherIsWorse === false). */
export function gaugeLevel(v: number, w: Pick<WidgetDef, "warn" | "crit" | "higherIsWorse">): GaugeLevel {
  const warn = w.warn ?? Infinity, crit = w.crit ?? Infinity;
  if (w.higherIsWorse === false) return v <= (w.crit ?? -Infinity) ? "critical" : v <= (w.warn ?? -Infinity) ? "warning" : "good";
  return v >= crit ? "critical" : v >= warn ? "warning" : "good";
}

/** Scala dell'indicatore: min/max indicati, altrimenti da 0 a un po' oltre la soglia critica e il valore. */
export function gaugeScale(v: number, w: Pick<WidgetDef, "warn" | "crit" | "min" | "max">): [number, number] {
  const lo = Number.isFinite(w.min) ? w.min! : Math.min(0, v);
  const hiAuto = Math.max(v, w.crit ?? 0, w.warn ?? 0) * 1.2 || 1;
  const hi = Number.isFinite(w.max) ? w.max! : hiAuto;
  return hi > lo ? [lo, hi] : [lo, lo + 1];
}
