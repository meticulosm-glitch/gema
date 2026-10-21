import type Keycloak from "keycloak-js";
import type { AccessConfig } from "./config";
import { describeTable, getWfsFeatures, wfsTransaction, type Feature, type Schema } from "./api";
import type { RoleRule, ToolId } from "./roles";
import { TOOL_IDS } from "./roles";
import { sanitizeViewState, type ViewState } from "./viewState";
import type { Catalog, CatalogFolder, CatalogLayer } from "./catalog";
import { formatBbox, isEmptyView, parseBbox, type RoleView } from "./roleView";
import { sanitizeFields, type FormDef } from "./editForm";
import { ISO_RE, sanitizeLevel, type Announcement } from "./announcements";
import { decodeDefinition, encodeDefinition, type DashFilters } from "./dashFilters";
import { diffCatalog, diffSize, sameCatalog, type RowDiff } from "./catalogEdit";

/** Tabelle di configurazione in PostGIS (schema dedicato), esposte da GeoServer senza geometria e scritte via WFS-T. */
export const RULES_TABLE = "role_rules";
export const DASH_TABLE = "dashboards";
export const VIEWS_TABLE = "saved_views";
export const CATALOG_FOLDERS_TABLE = "catalog_folders";
export const CATALOG_LAYERS_TABLE = "catalog_layers";
export const ROLE_VIEWS_TABLE = "role_views";
export const EDIT_FORMS_TABLE = "edit_forms";
export const ANNOUNCEMENTS_TABLE = "announcements";
export const DRAFTS_TABLE = "dashboard_drafts";
export const CHANGE_LOG_TABLE = "change_log";
export const USAGE_TABLES = ["usage_events", "usage_daily", "usage_sessions", "usage_roles", "usage_users"];
export const CONFIG_TABLES = [RULES_TABLE, DASH_TABLE, VIEWS_TABLE, CATALOG_FOLDERS_TABLE, CATALOG_LAYERS_TABLE, ROLE_VIEWS_TABLE, EDIT_FORMS_TABLE, ANNOUNCEMENTS_TABLE, DRAFTS_TABLE, CHANGE_LOG_TABLE, ...USAGE_TABLES];

/** Colonne che l'app usa in ogni tabella (come in mapp-config.sql, senza la chiave primaria): le controlla la diagnostica. */
export const CONFIG_COLUMNS: Record<string, string[]> = {
  [RULES_TABLE]: ["role", "layers", "tools", "updated_by", "updated_at"],
  [DASH_TABLE]: ["title", "description", "roles", "definition", "updated_by", "updated_at"],
  [VIEWS_TABLE]: ["owner", "name", "definition", "created_at"],
  [CATALOG_FOLDERS_TABLE]: ["folder_key", "parent_key", "title", "description", "position", "expanded", "hidden", "updated_by", "updated_at"],
  [CATALOG_LAYERS_TABLE]: ["layer", "folder_key", "position", "title", "description", "hidden", "default_on", "updated_by", "updated_at"],
  [ROLE_VIEWS_TABLE]: ["role", "bbox", "basemap", "layers", "updated_by", "updated_at"],
  [EDIT_FORMS_TABLE]: ["layer", "definition", "updated_by", "updated_at"],
  [ANNOUNCEMENTS_TABLE]: ["message", "level", "starts_at", "ends_at", "roles", "dismissible", "active", "updated_by", "updated_at"],
  [DRAFTS_TABLE]: ["dashboard_id", "title", "description", "roles", "definition", "updated_by", "updated_at"],
  [CHANGE_LOG_TABLE]: ["table_name", "row_id", "op", "old_data", "new_data", "changed_by", "db_user", "changed_at"],
  usage_events: ["at", "session", "username", "roles", "kind", "target", "detail"],
  usage_daily: ["day", "kind", "target", "events", "sessions", "users"],
  usage_sessions: ["day", "events", "sessions", "users"],
  usage_roles: ["day", "role", "events", "sessions"],
  usage_users: ["day", "username", "events", "sessions"],
};

export type Agg = "count" | "sum" | "avg" | "min" | "max";
export type WidgetType = "kpi" | "gauge" | "bar" | "pie" | "hist" | "time" | "line" | "table" | "text" | "map";
export type Granularity = "day" | "month" | "year";
export interface WidgetDef {
  id: string;
  type: WidgetType;
  title: string;
  layer: string;         // vuoto per il testo
  field?: string;        // attributo raggruppato / misurato (data per serie e linea)
  agg: Agg;              // sul valore: count = numero di oggetti
  valueField?: string;   // attributo numerico per sum/avg/min/max
  cql?: string;
  w: 1 | 2 | 3;          // larghezza in colonne
  // linea temporale
  granularity?: Granularity;
  // tabella
  columns?: string[];
  sortField?: string;
  sortDesc?: boolean;
  limit?: number;
  // testo (markdown semplice, senza HTML)
  text?: string;
  // indicatore con soglie: sopra (o sotto) "warn" attenzione, oltre "crit" critico
  warn?: number;
  crit?: number;
  higherIsWorse?: boolean;
  min?: number;
  max?: number;
}
export interface DashboardDef { fid?: string; title: string; description: string; roles: string[]; widgets: WidgetDef[]; filters?: DashFilters; updatedBy?: string; updatedAt?: string }

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const full = (acc: AccessConfig, t: string) => `${acc.workspace}:${t}`;
/** Le tabelle di configurazione non sono prodotti: restano fuori dalla mappa, ma il resto del workspace (anche "test") sì. */
export const isConfigLayer = (acc: AccessConfig, name: string) => CONFIG_TABLES.some((t) => name === full(acc, t));
const parseJson = <T,>(s: unknown, fallback: T): T => { try { const v = JSON.parse(String(s ?? "")); return v ?? fallback; } catch { return fallback; } };
const arr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x) => typeof x === "string") : []);

/** Il layer di configurazione non esiste ancora (script SQL / pubblicazione su GeoServer non eseguiti). */
export const isMissingTable = (e: unknown) => /unknown|not found|could not find|no such|non trovat/i.test(String((e as Error)?.message ?? e));

export async function loadRules(gs: string, kc: Keycloak | null, acc: AccessConfig): Promise<RoleRule[]> {
  const fs = await getWfsFeatures(gs, kc, full(acc, RULES_TABLE), "", 1000);
  return fs.map((f) => {
    const p = f.properties ?? {};
    const tools = arr(parseJson(p.tools, [])).filter((t): t is ToolId => (TOOL_IDS as string[]).includes(t));
    return { fid: f.id, role: String(p.role ?? ""), layers: arr(parseJson(p.layers, [])), tools, updatedBy: p.updated_by as string | undefined, updatedAt: p.updated_at as string | undefined };
  }).filter((r) => r.role);
}

export async function loadDashboards(gs: string, kc: Keycloak | null, acc: AccessConfig): Promise<DashboardDef[]> {
  const fs = await getWfsFeatures(gs, kc, full(acc, DASH_TABLE), "", 1000);
  return fs.map((f: Feature) => toDash(f.id, f.properties ?? {})).sort((a, b) => a.title.localeCompare(b.title));
}

// ---------------------------------------------------------------- scrittura (WFS-T 1.0.0)
const tx = (s: Schema, body: string) =>
  `<?xml version="1.0" encoding="UTF-8"?><wfs:Transaction service="WFS" version="1.0.0" xmlns:wfs="http://www.opengis.net/wfs" ` +
  `xmlns:ogc="http://www.opengis.net/ogc" xmlns:${s.prefix}="${esc(s.ns)}">${body}</wfs:Transaction>`;
const fidFilter = (fid: string) => `<ogc:Filter><ogc:FeatureId fid="${esc(fid)}"/></ogc:Filter>`;

/** Operazione WFS-T: Update della riga `fid` o, senza fid, Insert. */
function upsertOp(s: Schema, fid: string | undefined, values: Record<string, string>): string {
  if (fid) {
    const props = Object.entries(values).map(([k, v]) => `<wfs:Property><wfs:Name>${esc(k)}</wfs:Name><wfs:Value>${esc(v)}</wfs:Value></wfs:Property>`).join("");
    return `<wfs:Update typeName="${s.prefix}:${s.typeName}">${props}${fidFilter(fid)}</wfs:Update>`;
  }
  const fields = Object.entries(values).map(([k, v]) => `<${s.prefix}:${k}>${esc(v)}</${s.prefix}:${k}>`).join("");
  return `<wfs:Insert><${s.prefix}:${s.typeName}>${fields}</${s.prefix}:${s.typeName}></wfs:Insert>`;
}
const deleteOp = (s: Schema, fid: string) => `<wfs:Delete typeName="${s.prefix}:${s.typeName}">${fidFilter(fid)}</wfs:Delete>`;

async function upsert(gs: string, kc: Keycloak | null, acc: AccessConfig, table: string, fid: string | undefined, values: Record<string, string>) {
  const s = await describeTable(gs, kc, full(acc, table));
  await wfsTransaction(gs, kc, tx(s, upsertOp(s, fid, values)));
}

const who = (kc: Keycloak | null) => String((kc?.tokenParsed as any)?.preferred_username ?? "");

/**
 * Eliminazione "firmata": se la tabella ha updated_by, prima lo imposta a chi elimina (nella stessa transazione), così il
 * registro modifiche sa chi ha eliminato la riga (il trigger ignora le modifiche ai soli timbri).
 */
const delOp = (s: Schema, fid: string, kc: Keycloak | null) =>
  (s.fields.some((f) => f.name === "updated_by") ? upsertOp(s, fid, { updated_by: who(kc), updated_at: new Date().toISOString() }) : "") + deleteOp(s, fid);

async function remove(gs: string, kc: Keycloak | null, acc: AccessConfig, table: string, fid: string) {
  const s = await describeTable(gs, kc, full(acc, table));
  await wfsTransaction(gs, kc, tx(s, delOp(s, fid, kc)));
}

export const saveRule = (gs: string, kc: Keycloak | null, acc: AccessConfig, r: RoleRule) =>
  upsert(gs, kc, acc, RULES_TABLE, r.fid, {
    ...(r.fid ? {} : { role: r.role }),
    layers: JSON.stringify(r.layers), tools: JSON.stringify(r.tools), updated_by: who(kc), updated_at: new Date().toISOString(),
  });
export const deleteRule = (gs: string, kc: Keycloak | null, acc: AccessConfig, fid: string) => remove(gs, kc, acc, RULES_TABLE, fid);

export const saveDashboard = (gs: string, kc: Keycloak | null, acc: AccessConfig, d: DashboardDef) =>
  upsert(gs, kc, acc, DASH_TABLE, d.fid, {
    title: d.title, description: d.description, roles: JSON.stringify(d.roles), definition: encodeDefinition(d.widgets, d.filters),
    updated_by: who(kc), updated_at: new Date().toISOString(),
  });
export const deleteDashboard = (gs: string, kc: Keycloak | null, acc: AccessConfig, fid: string) => remove(gs, kc, acc, DASH_TABLE, fid);

/** Importa più dashboard in un'unica transazione (tutto o niente): nuove righe e righe sostituite. Restituisce quante. */
export async function importDashboards(gs: string, kc: Keycloak | null, acc: AccessConfig, plan: { insert: DashboardDef[]; update: DashboardDef[] }): Promise<number> {
  const all = [...plan.update, ...plan.insert];
  if (all.length === 0) return 0;
  const s = await describeTable(gs, kc, full(acc, DASH_TABLE));
  const stamp = { updated_by: who(kc), updated_at: new Date().toISOString() };
  const ops = all.map((d) => upsertOp(s, d.fid, { title: d.title, description: d.description, roles: JSON.stringify(d.roles), definition: encodeDefinition(d.widgets, d.filters), ...stamp }));
  await wfsTransaction(gs, kc, tx(s, ops.join("")));
  return all.length;
}

export const dashId = (fid?: string) => (fid ?? "").split(".").pop() ?? "";

// ---------------------------------------------------------------- bozze delle dashboard (tabella dashboard_drafts, solo admin)
/**
 * Bozza di una dashboard: una riga per dashboard. `dashboardId` è l'id della dashboard pubblicata che modifica
 * ("" = dashboard mai pubblicata). Chi usa le dashboard non la legge mai: vede solo la tabella dashboards.
 */
export interface DashboardDraft { fid: string; dashboardId: string; def: DashboardDef; updatedBy?: string; updatedAt?: string }

const dashValues = (d: DashboardDef) => ({ title: d.title.trim(), description: d.description, roles: JSON.stringify(d.roles), definition: encodeDefinition(d.widgets, d.filters) });
const toDash = (fid: string | undefined, p: Record<string, unknown>): DashboardDef => {
  const { widgets, filters } = decodeDefinition(parseJson<unknown>(p.definition, []));
  return {
    ...(fid ? { fid } : {}), title: String(p.title ?? "(senza titolo)"), description: str(p.description),
    roles: arr(parseJson(p.roles, [])), widgets: widgets as WidgetDef[], ...(filters ? { filters } : {}),
    updatedBy: p.updated_by as string | undefined, updatedAt: p.updated_at as string | undefined,
  };
};

export async function loadDashboardDrafts(gs: string, kc: Keycloak | null, acc: AccessConfig): Promise<DashboardDraft[]> {
  const fs = await getWfsFeatures(gs, kc, full(acc, DRAFTS_TABLE), "", 1000);
  return fs.map((f) => {
    const p = f.properties ?? {};
    const def = toDash(undefined, p);
    return { fid: String(f.id ?? ""), dashboardId: str(p.dashboard_id).trim(), def, updatedBy: def.updatedBy, updatedAt: def.updatedAt };
  }).filter((d) => d.fid).sort((a, b) => a.def.title.localeCompare(b.def.title));
}

/** Salva la bozza (nuova o esistente). Restituisce il fid della bozza. */
export async function saveDashboardDraft(gs: string, kc: Keycloak | null, acc: AccessConfig, draft: { fid?: string; dashboardId: string; def: DashboardDef }): Promise<string> {
  const s = await describeTable(gs, kc, full(acc, DRAFTS_TABLE));
  const ids = await wfsTransaction(gs, kc, tx(s, upsertOp(s, draft.fid, {
    ...(draft.fid ? {} : { dashboard_id: draft.dashboardId }), ...dashValues(draft.def), updated_by: who(kc), updated_at: new Date().toISOString(),
  })));
  return draft.fid ?? ids[0] ?? "";
}

/**
 * Pubblica: scrive la dashboard (nuova se `d.fid` manca) ed elimina la sua bozza, nella stessa transazione.
 * Restituisce il fid della dashboard pubblicata.
 */
export async function publishDashboard(gs: string, kc: Keycloak | null, acc: AccessConfig, d: DashboardDef, draftFid?: string): Promise<string> {
  const s = await describeTable(gs, kc, full(acc, DASH_TABLE));
  const ops = [upsertOp(s, d.fid, { ...dashValues(d), updated_by: who(kc), updated_at: new Date().toISOString() })];
  if (draftFid) ops.push(deleteOp(await describeTable(gs, kc, full(acc, DRAFTS_TABLE)), draftFid));
  const ids = await wfsTransaction(gs, kc, tx(s, ops.join("")));
  return d.fid ?? ids[0] ?? "";
}

export const deleteDashboardDraft = (gs: string, kc: Keycloak | null, acc: AccessConfig, fid: string) => remove(gs, kc, acc, DRAFTS_TABLE, fid);

/** Elimina la dashboard pubblicata e/o la sua bozza insieme. */
export async function deleteDashboardAndDraft(gs: string, kc: Keycloak | null, acc: AccessConfig, fid?: string, draftFid?: string): Promise<void> {
  const ops: string[] = [];
  const s = await describeTable(gs, kc, full(acc, fid ? DASH_TABLE : DRAFTS_TABLE));
  if (fid) ops.push(delOp(s, fid, kc));
  if (draftFid) ops.push(deleteOp(fid ? await describeTable(gs, kc, full(acc, DRAFTS_TABLE)) : s, draftFid));
  if (ops.length) await wfsTransaction(gs, kc, tx(s, ops.join("")));
}

// ---------------------------------------------------------------- viste salvate (una riga per vista, di un utente)
export interface SavedView { fid?: string; owner: string; name: string; state: ViewState; createdAt?: string }

/** Utente a cui appartengono le viste: nome utente Keycloak, altrimenti l'id (sub). */
export const viewOwner = (kc: Keycloak | null) => String((kc?.tokenParsed as any)?.preferred_username ?? (kc?.tokenParsed as any)?.sub ?? "");

const quoteCql = (s: string) => `'${s.replace(/'/g, "''")}'`;

/** Viste dell'utente, le più recenti per prime. Il filtro per proprietario è una comodità: la riservatezza vera dipende dalle regole dati di GeoServer. */
export async function loadViews(gs: string, kc: Keycloak | null, acc: AccessConfig): Promise<SavedView[]> {
  const owner = viewOwner(kc);
  if (!owner) return [];
  const fs = await getWfsFeatures(gs, kc, full(acc, VIEWS_TABLE), `owner = ${quoteCql(owner)}`, 500);
  return fs.map((f: Feature) => {
    const p = f.properties ?? {};
    return {
      fid: f.id, owner: String(p.owner ?? ""), name: String(p.name ?? "(senza nome)"),
      state: sanitizeViewState(parseJson(p.definition, {})), createdAt: p.created_at as string | undefined,
    };
  }).sort((a, b) => String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? "")) || a.name.localeCompare(b.name));
}

export const saveView = (gs: string, kc: Keycloak | null, acc: AccessConfig, v: { fid?: string; name: string; state: ViewState }) =>
  upsert(gs, kc, acc, VIEWS_TABLE, v.fid, {
    ...(v.fid ? {} : { owner: viewOwner(kc), created_at: new Date().toISOString() }),
    name: v.name, definition: JSON.stringify(v.state),
  });
export const deleteView = (gs: string, kc: Keycloak | null, acc: AccessConfig, fid: string) => remove(gs, kc, acc, VIEWS_TABLE, fid);

// ---------------------------------------------------------------- stessa interfaccia senza PostGIS: nel browser (solo per chi non ha il controllo accessi)
const LOCAL_KEY = "mapp.savedViews";
export function loadLocalViews(): SavedView[] {
  try {
    const a = JSON.parse(localStorage.getItem(LOCAL_KEY) ?? "[]");
    return Array.isArray(a)
      ? a.filter((x) => x && typeof x.name === "string").map((x) => ({ fid: String(x.fid), owner: "locale", name: x.name, state: sanitizeViewState(x.state), createdAt: x.createdAt }))
      : [];
  } catch {
    return [];
  }
}
export function storeLocalViews(list: SavedView[]): void {
  try {
    localStorage.setItem(LOCAL_KEY, JSON.stringify(list.map(({ fid, name, state, createdAt }) => ({ fid, name, state, createdAt }))));
  } catch { /* storage non disponibile (finestra privata): le viste non vengono salvate */ }
}

// ---------------------------------------------------------------- catalogo prodotti (due tabelle, salvate insieme)
const bool = (v: unknown) => v === true || v === 1 || (typeof v === "string" && /^(true|t|1)$/i.test(v));
const int = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? Math.trunc(n) : 0; };
const str = (v: unknown) => (v == null ? "" : String(v));

/** Catalogo salvato. Una tabella che non esiste ancora (Job non rieseguito) lancia: vedi isMissingTable. */
export async function loadCatalog(gs: string, kc: Keycloak | null, acc: AccessConfig): Promise<Catalog> {
  const [fs, ls] = await Promise.all([
    getWfsFeatures(gs, kc, full(acc, CATALOG_FOLDERS_TABLE), "", 5000),
    getWfsFeatures(gs, kc, full(acc, CATALOG_LAYERS_TABLE), "", 10000),
  ]);
  const folders: CatalogFolder[] = fs.map((f) => {
    const p = f.properties ?? {};
    return { fid: f.id, key: str(p.folder_key), parent: str(p.parent_key), title: str(p.title), description: str(p.description), position: int(p.position), expanded: bool(p.expanded), hidden: bool(p.hidden) };
  }).filter((f) => f.key);
  const layers: CatalogLayer[] = ls.map((f) => {
    const p = f.properties ?? {};
    return { fid: f.id, layer: str(p.layer), folder: str(p.folder_key), position: int(p.position), title: str(p.title), description: str(p.description), hidden: bool(p.hidden), defaultOn: bool(p.default_on) };
  }).filter((l) => l.layer);
  return { folders, layers };
}

/** Il catalogo è stato cambiato da qualcun altro dopo che l'editor l'ha letto. */
export class CatalogConflictError extends Error {
  constructor() { super("il catalogo è stato modificato da un altro amministratore: ricarica la pagina e rifai le modifiche"); }
}

const FOLDER_COLS: Record<Exclude<keyof CatalogFolder, "fid">, string> = {
  key: "folder_key", parent: "parent_key", title: "title", description: "description", position: "position", expanded: "expanded", hidden: "hidden",
};
const LAYER_COLS: Record<Exclude<keyof CatalogLayer, "fid">, string> = {
  layer: "layer", folder: "folder_key", position: "position", title: "title", description: "description", hidden: "hidden", defaultOn: "default_on",
};
const val = (v: unknown) => (typeof v === "boolean" ? (v ? "true" : "false") : String(v ?? ""));

function ops<T extends { fid?: string }>(s: Schema, d: RowDiff<T>, cols: Record<string, string>, stamp: Record<string, string>) {
  const type = `${s.prefix}:${s.typeName}`;
  const prop = (k: string, v: string) => `<wfs:Property><wfs:Name>${esc(k)}</wfs:Name><wfs:Value>${esc(v)}</wfs:Value></wfs:Property>`;
  // eliminazioni firmate (vedi delOp): prima il timbro, poi la Delete
  const del = d.remove.map((fid) => `<wfs:Update typeName="${type}">${Object.entries(stamp).map(([k, v]) => prop(k, v)).join("")}${fidFilter(fid)}</wfs:Update><wfs:Delete typeName="${type}">${fidFilter(fid)}</wfs:Delete>`);
  const upd = d.update.map(({ fid, row, changed }) => {
    const props = changed.filter((k) => k in cols).map((k) => prop(cols[k as string], val(row[k]))).join("");
    return `<wfs:Update typeName="${type}">${props}${Object.entries(stamp).map(([k, v]) => prop(k, v)).join("")}${fidFilter(fid)}</wfs:Update>`;
  });
  const ins = d.insert.map((row) => {
    const fields = [...Object.entries(cols).map(([k, c]) => [c, val((row as Record<string, unknown>)[k])]), ...Object.entries(stamp)]
      .map(([c, v]) => `<${s.prefix}:${c}>${esc(v)}</${s.prefix}:${c}>`).join("");
    return `<wfs:Insert><${type}>${fields}</${type}></wfs:Insert>`;
  });
  return { del, upd, ins };
}

/**
 * Salva il catalogo in un'unica transazione WFS-T (tutto o niente): eliminazioni, modifiche dei soli campi cambiati,
 * inserimenti. `base` è il catalogo letto quando l'editor si è aperto: se nel frattempo è cambiato, non scrive nulla.
 * Limite noto: il controllo precede la transazione, quindi due salvataggi a pochi millisecondi l'uno dall'altro possono
 * passare entrambi (l'ultimo vince; le chiavi UNIQUE fanno comunque fallire per intero due inserimenti dello stesso layer).
 * Restituisce il numero di righe toccate.
 */
export async function saveCatalog(gs: string, kc: Keycloak | null, acc: AccessConfig, base: Catalog, next: Catalog): Promise<number> {
  const d = diffCatalog(base, next);
  const n = diffSize(d);
  if (n === 0) return 0;
  if (!sameCatalog(await loadCatalog(gs, kc, acc), base)) throw new CatalogConflictError();
  const [sf, sl] = await Promise.all([describeTable(gs, kc, full(acc, CATALOG_FOLDERS_TABLE)), describeTable(gs, kc, full(acc, CATALOG_LAYERS_TABLE))]);
  const stamp = { updated_by: who(kc), updated_at: new Date().toISOString() };
  const f = ops(sf, d.folders, FOLDER_COLS, stamp);
  const l = ops(sl, d.layers, LAYER_COLS, stamp);
  // prima le eliminazioni (una chiave liberata può essere riusata), poi modifiche e inserimenti
  const body = [...f.del, ...l.del, ...f.upd, ...l.upd, ...f.ins, ...l.ins].join("");
  await wfsTransaction(gs, kc, tx(sf, body));
  return n;
}

// ---------------------------------------------------------------- vista iniziale per ruolo (tabella role_views)

/** Viste iniziali dei ruoli. Righe senza ruolo, riquadri non validi e JSON rotto vengono ripuliti. */
export async function loadRoleViews(gs: string, kc: Keycloak | null, acc: AccessConfig): Promise<RoleView[]> {
  const fs = await getWfsFeatures(gs, kc, full(acc, ROLE_VIEWS_TABLE), "", 1000);
  return fs.map((f) => {
    const p = f.properties ?? {};
    const bbox = parseBbox(p.bbox);
    return {
      fid: f.id, role: str(p.role), ...(bbox ? { bbox } : {}), basemap: str(p.basemap).trim(), layers: arr(parseJson(p.layers, [])),
      updatedBy: p.updated_by as string | undefined, updatedAt: p.updated_at as string | undefined,
    };
  }).filter((v) => v.role).sort((a, b) => a.role.localeCompare(b.role));
}

/**
 * Salva regola e vista iniziale di un ruolo nella stessa transazione WFS-T (tutto o niente).
 * Vista vuota: la riga esistente viene eliminata (e non se ne crea una). `view` undefined = vista non toccata.
 */
export async function saveRoleSettings(gs: string, kc: Keycloak | null, acc: AccessConfig, rule: RoleRule, view?: RoleView): Promise<void> {
  const sr = await describeTable(gs, kc, full(acc, RULES_TABLE));
  const stamp = { updated_by: who(kc), updated_at: new Date().toISOString() };
  const ops = [upsertOp(sr, rule.fid, { ...(rule.fid ? {} : { role: rule.role }), layers: JSON.stringify(rule.layers), tools: JSON.stringify(rule.tools), ...stamp })];
  if (view) {
    const sv = await describeTable(gs, kc, full(acc, ROLE_VIEWS_TABLE));
    if (isEmptyView(view)) { if (view.fid) ops.push(delOp(sv, view.fid, kc)); }
    else ops.push(upsertOp(sv, view.fid, { ...(view.fid ? {} : { role: rule.role }), bbox: formatBbox(view.bbox), basemap: view.basemap.trim(), layers: JSON.stringify(view.layers), ...stamp }));
  }
  await wfsTransaction(gs, kc, tx(sr, ops.join("")));
}

/** Elimina regola e vista di un ruolo insieme. */
export async function deleteRoleSettings(gs: string, kc: Keycloak | null, acc: AccessConfig, ruleFid?: string, viewFid?: string): Promise<void> {
  const ops: string[] = [];
  const sr = await describeTable(gs, kc, full(acc, RULES_TABLE));
  if (ruleFid) ops.push(delOp(sr, ruleFid, kc));
  if (viewFid) ops.push(delOp(await describeTable(gs, kc, full(acc, ROLE_VIEWS_TABLE)), viewFid, kc));
  if (ops.length) await wfsTransaction(gs, kc, tx(sr, ops.join("")));
}

// ---------------------------------------------------------------- moduli di modifica per layer (tabella edit_forms)
const toForm = (f: Feature): FormDef => {
  const p = f.properties ?? {};
  return { fid: f.id, layer: str(p.layer), fields: sanitizeFields(parseJson(p.definition, [])), updatedBy: p.updated_by as string | undefined, updatedAt: p.updated_at as string | undefined };
};

/** Tutti i moduli configurati (pagina admin). */
export async function loadEditForms(gs: string, kc: Keycloak | null, acc: AccessConfig): Promise<FormDef[]> {
  return (await getWfsFeatures(gs, kc, full(acc, EDIT_FORMS_TABLE), "", 2000)).map(toForm).filter((f) => f.layer).sort((a, b) => a.layer.localeCompare(b.layer));
}

/** Modulo di un layer (editor); null se non configurato. */
export async function loadEditForm(gs: string, kc: Keycloak | null, acc: AccessConfig, layer: string): Promise<FormDef | null> {
  const fs = await getWfsFeatures(gs, kc, full(acc, EDIT_FORMS_TABLE), `layer = ${quoteCql(layer)}`, 1);
  return fs.length ? toForm(fs[0]) : null;
}

/** Salva il modulo. Nessuna regola = modulo predefinito: la riga (se c'è) viene eliminata. */
export async function saveEditForm(gs: string, kc: Keycloak | null, acc: AccessConfig, def: FormDef): Promise<void> {
  const fields = sanitizeFields(def.fields);
  const s = await describeTable(gs, kc, full(acc, EDIT_FORMS_TABLE));
  if (fields.length === 0) { if (def.fid) await wfsTransaction(gs, kc, tx(s, delOp(s, def.fid, kc))); return; }
  await wfsTransaction(gs, kc, tx(s, upsertOp(s, def.fid, {
    ...(def.fid ? {} : { layer: def.layer }), definition: JSON.stringify(fields), updated_by: who(kc), updated_at: new Date().toISOString(),
  })));
}

export const deleteEditForm = (gs: string, kc: Keycloak | null, acc: AccessConfig, fid: string) => remove(gs, kc, acc, EDIT_FORMS_TABLE, fid);

// ---------------------------------------------------------------- avvisi (tabella announcements)
const isoOrEmpty = (v: unknown) => { const t = str(v).trim(); return ISO_RE.test(t) ? t : ""; };

/** Tutti gli avvisi (anche spenti o scaduti): il filtro per periodo e ruoli lo fa chi li mostra. */
export async function loadAnnouncements(gs: string, kc: Keycloak | null, acc: AccessConfig): Promise<Announcement[]> {
  const fs = await getWfsFeatures(gs, kc, full(acc, ANNOUNCEMENTS_TABLE), "", 500);
  return fs.map((f) => {
    const p = f.properties ?? {};
    return {
      fid: f.id, message: str(p.message), level: sanitizeLevel(p.level), startsAt: isoOrEmpty(p.starts_at), endsAt: isoOrEmpty(p.ends_at),
      roles: arr(parseJson(p.roles, [])), dismissible: p.dismissible == null ? true : bool(p.dismissible), active: p.active == null ? true : bool(p.active),
      updatedBy: p.updated_by as string | undefined, updatedAt: p.updated_at as string | undefined,
    };
  }).filter((a) => a.message.trim()).sort((a, b) => String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")));
}

/** Gli avvisi di manutenzione non si possono chiudere. */
export const saveAnnouncement = (gs: string, kc: Keycloak | null, acc: AccessConfig, a: Announcement) =>
  upsert(gs, kc, acc, ANNOUNCEMENTS_TABLE, a.fid, {
    message: a.message.trim(), level: a.level, starts_at: a.startsAt, ends_at: a.endsAt, roles: JSON.stringify(a.roles),
    dismissible: String(a.level !== "maintenance" && a.dismissible), active: String(a.active), updated_by: who(kc), updated_at: new Date().toISOString(),
  });
export const deleteAnnouncement = (gs: string, kc: Keycloak | null, acc: AccessConfig, fid: string) => remove(gs, kc, acc, ANNOUNCEMENTS_TABLE, fid);

// ---------------------------------------------------------------- mattoni WFS-T per chi scrive più tabelle insieme (backup)
export const wfsTx = tx;
export const wfsUpsertOp = upsertOp;
export const wfsSignedDeleteOp = delOp;
export const whoAmI = who;
