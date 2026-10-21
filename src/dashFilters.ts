import type { Bbox } from "./roleView";
import { parseBbox, formatBbox } from "./roleView";

/**
 * Filtri globali di una dashboard: un intervallo di date e un'area che valgono per tutti i widget.
 * La configurazione (quale campo data usare per ogni layer, intervallo predefinito, area sì/no) sta nella dashboard;
 * la scelta di chi la guarda sta nell'indirizzo della pagina (?dal=…&al=…&area=…), così si può condividere.
 */
export type DatePreset = "all" | "7d" | "30d" | "90d" | "365d" | "ytd";
export const DATE_PRESETS: { id: DatePreset; label: string }[] = [
  { id: "all", label: "Tutto" }, { id: "7d", label: "Ultimi 7 giorni" }, { id: "30d", label: "Ultimi 30 giorni" },
  { id: "90d", label: "Ultimi 90 giorni" }, { id: "365d", label: "Ultimi 12 mesi" }, { id: "ytd", label: "Da inizio anno" },
];

export interface DashFilters {
  date?: { fields: Record<string, string>; preset?: DatePreset }; // layer -> campo data
  area?: boolean;
}
export interface FilterState { from: string; to: string; bbox?: Bbox } // date AAAA-MM-GG; vuote = senza limite

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const day = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (iso: string, n: number) => day(new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000));

/** Intervallo di un preset rispetto a oggi (fine compresa). */
export function presetRange(p: DatePreset | undefined, now = new Date()): { from: string; to: string } {
  const today = day(now);
  switch (p) {
    case "7d": return { from: addDays(today, -6), to: today };
    case "30d": return { from: addDays(today, -29), to: today };
    case "90d": return { from: addDays(today, -89), to: today };
    case "365d": return { from: addDays(today, -364), to: today };
    case "ytd": return { from: `${today.slice(0, 4)}-01-01`, to: today };
    default: return { from: "", to: "" };
  }
}

/** Stato iniziale: quello nell'indirizzo se c'è, altrimenti il preset della dashboard. */
export function initialState(f: DashFilters | undefined, search: string, now = new Date()): FilterState {
  const q = new URLSearchParams(search);
  const def = presetRange(f?.date?.preset, now);
  const pick = (k: string, d: string) => { const v = q.get(k); return v === null ? d : DAY_RE.test(v) ? v : ""; };
  const bbox = f?.area ? parseBbox(q.get("area") ?? "") : undefined;
  return { from: f?.date ? pick("dal", def.from) : "", to: f?.date ? pick("al", def.to) : "", ...(bbox ? { bbox } : {}) };
}

/** Parametri dell'indirizzo per lo stato (solo ciò che differisce dal predefinito, così il link resta corto). */
export function stateToSearch(f: DashFilters | undefined, s: FilterState, current: string, now = new Date()): string {
  const q = new URLSearchParams(current);
  const def = presetRange(f?.date?.preset, now);
  for (const [k, v, d] of [["dal", s.from, def.from], ["al", s.to, def.to]] as const) { if (v === d) q.delete(k); else q.set(k, v); }
  if (s.bbox) q.set("area", formatBbox(s.bbox)); else q.delete("area");
  const out = q.toString();
  return out ? `?${out}` : "";
}

const ident = (n: string) => (/^[A-Za-z_][A-Za-z0-9_]*$/.test(n) ? n : `"${n.replace(/"/g, '""')}"`);

/** CQL dell'intervallo di date su un campo (fine compresa: < giorno dopo). */
export function dateCql(field: string, from: string, to: string): string {
  const parts: string[] = [];
  if (DAY_RE.test(from)) parts.push(`${ident(field)} >= '${from}'`);
  if (DAY_RE.test(to)) parts.push(`${ident(field)} < '${addDays(to, 1)}'`);
  return parts.join(" AND ");
}

export const areaCql = (geom: string, b: Bbox) => `BBOX(${ident(geom)}, ${b.join(", ")})`;

/**
 * Filtro globale per un widget: la data se la dashboard indica il campo data del suo layer, l'area se attiva e
 * il layer ha una geometria. Il testo non si filtra. Restituisce anche cosa non si è potuto applicare.
 */
export function widgetFilter(layer: string, f: DashFilters | undefined, s: FilterState, geomOf: (layer: string) => string | undefined): { cql: string; skipped: string[] } {
  if (!layer || !f) return { cql: "", skipped: [] };
  const parts: string[] = [];
  const skipped: string[] = [];
  if (f.date && (s.from || s.to)) {
    const field = f.date.fields[layer];
    if (field) parts.push(dateCql(field, s.from, s.to)); else skipped.push("data");
  }
  if (f.area && s.bbox) {
    const g = geomOf(layer);
    if (g) parts.push(areaCql(g, s.bbox)); else skipped.push("area");
  }
  return { cql: parts.filter(Boolean).join(" AND "), skipped }; // solo congiunzioni: niente parentesi
}

/** Configurazione letta da un file o dal database: solo ciò che ha senso. */
export function sanitizeFilters(raw: unknown): DashFilters | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, any>;
  const out: DashFilters = {};
  if (r.date && typeof r.date === "object" && r.date.fields && typeof r.date.fields === "object") {
    const fields = Object.fromEntries(Object.entries(r.date.fields).filter(([k, v]) => k && typeof v === "string" && v));
    const preset = DATE_PRESETS.some((p) => p.id === r.date.preset) ? (r.date.preset as DatePreset) : undefined;
    if (Object.keys(fields).length) out.date = { fields: fields as Record<string, string>, ...(preset ? { preset } : {}) };
  }
  if (r.area === true) out.area = true;
  return out.date || out.area ? out : undefined;
}

/** Definizione salvata nella colonna "definition": l'elenco dei widget, oppure { widgets, filters } se ci sono filtri. */
export function encodeDefinition(widgets: unknown[], filters?: DashFilters): string {
  return JSON.stringify(filters ? { widgets, filters } : widgets);
}
export function decodeDefinition(v: unknown): { widgets: unknown[]; filters?: DashFilters } {
  if (Array.isArray(v)) return { widgets: v };
  if (v && typeof v === "object" && Array.isArray((v as any).widgets)) {
    const filters = sanitizeFilters((v as any).filters);
    return { widgets: (v as any).widgets, ...(filters ? { filters } : {}) };
  }
  return { widgets: [] };
}
