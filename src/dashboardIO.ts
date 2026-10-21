import type { Agg, DashboardDef, Granularity, WidgetDef, WidgetType } from "./configStore";
import { WIDGET_TYPES, usesLayer } from "./widgetKinds";
import { sanitizeFilters } from "./dashFilters";

/**
 * Dashboard in JSON: esportazione (una o tutte), importazione con controlli, cambio dei nomi dei layer tra ambienti
 * (DEV -> UAT -> PROD) e piano di importazione (nuove o da sostituire, per titolo).
 */
export const FORMAT = "gema-dashboards";
export const VERSION = 1;

export interface ExportFile {
  format: typeof FORMAT;
  version: number;
  exportedAt: string;
  source?: string; // host di provenienza, per chi legge il file
  dashboards: Pick<DashboardDef, "title" | "description" | "roles" | "widgets" | "filters">[];
}

const strip = (d: DashboardDef) => ({
  title: d.title, description: d.description, roles: [...d.roles], widgets: d.widgets.map((w) => ({ ...w })), ...(d.filters ? { filters: structuredClone(d.filters) } : {}),
});

export function exportDashboards(list: DashboardDef[], source?: string, now = new Date()): ExportFile {
  return { format: FORMAT, version: VERSION, exportedAt: now.toISOString(), ...(source ? { source } : {}), dashboards: list.map(strip) };
}

/** Nome del file: "dashboard-<titolo>.json" per una, "dashboard-<data>.json" per più. */
export function exportName(list: DashboardDef[], now = new Date()): string {
  const slug = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  return list.length === 1 && slug(list[0].title) ? `dashboard-${slug(list[0].title)}.json` : `dashboard-${now.toISOString().slice(0, 10)}.json`;
}

/** Copia da modificare e salvare come nuova (senza fid, titolo con "(copia)", widget con id nuovi). */
export function duplicate(d: DashboardDef, uid: () => string): DashboardDef {
  return { title: `${d.title} (copia)`, description: d.description, roles: [...d.roles], widgets: d.widgets.map((w) => ({ ...w, id: uid() })), ...(d.filters ? { filters: structuredClone(d.filters) } : {}) };
}

// ---------------------------------------------------------------- importazione

const TYPES: WidgetType[] = WIDGET_TYPES.map((t) => t.id);
const GRAN: Granularity[] = ["day", "month", "year"];
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const AGGS: Agg[] = ["count", "sum", "avg", "min", "max"];
const s = (v: unknown) => (typeof v === "string" ? v : "");

/** Widget letto da un file: solo campi noti e valori ammessi; null se non è usabile. */
export function sanitizeWidget(raw: unknown, uid: () => string): WidgetDef | null {
  if (!raw || typeof raw !== "object") return null;
  const w = raw as Record<string, unknown>;
  const type = TYPES.includes(w.type as WidgetType) ? (w.type as WidgetType) : null;
  if (!type || (usesLayer(type) && !s(w.layer))) return null;
  if (type === "text" && !s(w.text).trim()) return null;
  const width = Number(w.w);
  const columns = Array.isArray(w.columns) ? (w.columns as unknown[]).filter((c): c is string => typeof c === "string" && !!c) : [];
  const limit = num(w.limit);
  return {
    id: s(w.id) && /^[\w-]{1,40}$/.test(s(w.id)) ? s(w.id) : uid(),
    type,
    title: s(w.title).slice(0, 200),
    layer: usesLayer(type) ? s(w.layer) : "",
    ...(s(w.field) ? { field: s(w.field) } : {}),
    agg: AGGS.includes(w.agg as Agg) ? (w.agg as Agg) : "count",
    ...(s(w.valueField) ? { valueField: s(w.valueField) } : {}),
    ...(s(w.cql) ? { cql: s(w.cql) } : {}),
    w: width === 2 || width === 3 ? width : 1,
    ...(GRAN.includes(w.granularity as Granularity) ? { granularity: w.granularity as Granularity } : {}),
    ...(columns.length ? { columns } : {}),
    ...(s(w.sortField) ? { sortField: s(w.sortField) } : {}),
    ...(w.sortDesc === true ? { sortDesc: true } : {}),
    ...(limit !== undefined ? { limit: Math.min(100, Math.max(1, Math.round(limit))) } : {}),
    ...(type === "text" ? { text: s(w.text).slice(0, 5000) } : {}),
    ...(num(w.warn) !== undefined ? { warn: num(w.warn) } : {}),
    ...(num(w.crit) !== undefined ? { crit: num(w.crit) } : {}),
    ...(w.higherIsWorse === false ? { higherIsWorse: false } : {}),
    ...(num(w.min) !== undefined ? { min: num(w.min) } : {}),
    ...(num(w.max) !== undefined ? { max: num(w.max) } : {}),
  };
}

export interface ParsedImport { items: DashboardDef[]; warnings: string[] }

/**
 * Legge un file esportato (o, più tollerante, una dashboard o un elenco di dashboard). Lancia con un messaggio
 * comprensibile se il file non si può usare; i problemi minori (widget scartati) diventano avvisi.
 */
export function parseImport(text: string, uid: () => string): ParsedImport {
  let data: unknown;
  try { data = JSON.parse(text); } catch { throw new Error("il file non è JSON valido"); }
  let list: unknown[];
  if (Array.isArray(data)) list = data;
  else if (data && typeof data === "object" && Array.isArray((data as ExportFile).dashboards)) {
    const f = data as ExportFile;
    if (f.format && f.format !== FORMAT) throw new Error(`formato non riconosciuto: ${String(f.format)}`);
    if (typeof f.version === "number" && f.version > VERSION) throw new Error(`file di una versione più recente (${f.version}): aggiorna l'applicazione`);
    list = f.dashboards;
  } else if (data && typeof data === "object" && "widgets" in (data as object)) list = [data];
  else throw new Error("il file non contiene dashboard");

  const warnings: string[] = [];
  const items: DashboardDef[] = [];
  list.forEach((raw, i) => {
    const d = (raw ?? {}) as Record<string, unknown>;
    const title = s(d.title).trim();
    if (!title) { warnings.push(`Dashboard n. ${i + 1} senza titolo: saltata.`); return; }
    const rawWidgets = Array.isArray(d.widgets) ? d.widgets : [];
    const seen = new Set<string>();
    const widgets = rawWidgets.map((w) => sanitizeWidget(w, uid)).filter((w): w is WidgetDef => !!w).map((w) => {
      if (seen.has(w.id)) w = { ...w, id: uid() };
      seen.add(w.id);
      return w;
    });
    if (widgets.length < rawWidgets.length) warnings.push(`«${title}»: ${rawWidgets.length - widgets.length} widget non validi scartati.`);
    if (widgets.length === 0) { warnings.push(`«${title}»: nessun widget valido, saltata.`); return; }
    const filters = sanitizeFilters(d.filters);
    items.push({ title, description: s(d.description), roles: Array.isArray(d.roles) ? d.roles.filter((r): r is string => typeof r === "string" && !!r) : [], widgets, ...(filters ? { filters } : {}) });
  });
  if (items.length === 0) throw new Error(warnings.length ? `nessuna dashboard importabile. ${warnings.join(" ")}` : "il file non contiene dashboard");
  return { items, warnings };
}

/** Layer usati dalle dashboard che in questo ambiente non sono pubblicati. */
export function missingLayers(items: DashboardDef[], published: Set<string>): string[] {
  return Array.from(new Set(items.flatMap((d) => d.widgets.map((w) => w.layer)))).filter((l) => l && !published.has(l)).sort();
}

/** Ruoli usati che questo ambiente non conosce (solo avviso: i ruoli vivono in Keycloak). */
export function unknownRoles(items: DashboardDef[], known: Set<string>): string[] {
  return Array.from(new Set(items.flatMap((d) => d.roles))).filter((r) => !known.has(r)).sort();
}

/** Sostituisce i nomi dei layer secondo la mappa (vecchio -> nuovo); le voci vuote restano com'erano. */
export function remapLayers(items: DashboardDef[], map: Record<string, string>): DashboardDef[] {
  return items.map((d) => ({
    ...d,
    widgets: d.widgets.map((w) => (map[w.layer] ? { ...w, layer: map[w.layer] } : w)),
    ...(d.filters?.date ? { filters: { ...d.filters, date: { ...d.filters.date, fields: Object.fromEntries(Object.entries(d.filters.date.fields).map(([l, f]) => [map[l] || l, f])) } } } : {}),
  }));
}

export interface ImportPlan { insert: DashboardDef[]; update: DashboardDef[] }
/**
 * Piano: le dashboard con lo stesso titolo di una esistente la sostituiscono se `replace` lo chiede,
 * altrimenti diventano nuove; quelle non scelte (`skip`) restano fuori.
 */
export function planImport(items: DashboardDef[], existing: DashboardDef[], replace: Set<string>, skip: Set<string> = new Set()): ImportPlan {
  const byTitle = new Map(existing.map((d) => [d.title.trim().toLowerCase(), d]));
  const plan: ImportPlan = { insert: [], update: [] };
  for (const d of items) {
    if (skip.has(d.title)) continue;
    const old = byTitle.get(d.title.trim().toLowerCase());
    if (old?.fid && replace.has(d.title)) plan.update.push({ ...d, fid: old.fid });
    else plan.insert.push(d);
  }
  return plan;
}
