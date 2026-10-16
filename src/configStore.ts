import type Keycloak from "keycloak-js";
import type { AccessConfig } from "./config";
import { describeTable, getWfsFeatures, wfsTransaction, type Feature, type Schema } from "./api";
import type { RoleRule, ToolId } from "./roles";
import { TOOL_IDS } from "./roles";
import { sanitizeViewState, type ViewState } from "./viewState";

/** Tabelle di configurazione in PostGIS (schema dedicato), esposte da GeoServer senza geometria e scritte via WFS-T. */
export const RULES_TABLE = "role_rules";
export const DASH_TABLE = "dashboards";
export const VIEWS_TABLE = "saved_views";

export type Agg = "count" | "sum" | "avg" | "min" | "max";
export type WidgetType = "kpi" | "bar" | "hist" | "time";
export interface WidgetDef {
  id: string;
  type: WidgetType;
  title: string;
  layer: string;
  field?: string;        // attributo raggruppato / misurato
  agg: Agg;              // sul valore: count = numero di oggetti
  valueField?: string;   // attributo numerico per sum/avg/min/max
  cql?: string;
  w: 1 | 2 | 3;          // larghezza in colonne
}
export interface DashboardDef { fid?: string; title: string; description: string; roles: string[]; widgets: WidgetDef[]; updatedBy?: string; updatedAt?: string }

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const full = (acc: AccessConfig, t: string) => `${acc.workspace}:${t}`;
/** Le tabelle di configurazione non sono prodotti: restano fuori dalla mappa, ma il resto del workspace (anche "test") sì. */
export const isConfigLayer = (acc: AccessConfig, name: string) => name === full(acc, RULES_TABLE) || name === full(acc, DASH_TABLE) || name === full(acc, VIEWS_TABLE);
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
  return fs.map((f: Feature) => {
    const p = f.properties ?? {};
    const widgets = parseJson<WidgetDef[]>(p.definition, []);
    return {
      fid: f.id, title: String(p.title ?? "(senza titolo)"), description: String(p.description ?? ""),
      roles: arr(parseJson(p.roles, [])), widgets: Array.isArray(widgets) ? widgets : [],
      updatedBy: p.updated_by as string | undefined, updatedAt: p.updated_at as string | undefined,
    };
  }).sort((a, b) => a.title.localeCompare(b.title));
}

// ---------------------------------------------------------------- scrittura (WFS-T 1.0.0)
const tx = (s: Schema, body: string) =>
  `<?xml version="1.0" encoding="UTF-8"?><wfs:Transaction service="WFS" version="1.0.0" xmlns:wfs="http://www.opengis.net/wfs" ` +
  `xmlns:ogc="http://www.opengis.net/ogc" xmlns:${s.prefix}="${esc(s.ns)}">${body}</wfs:Transaction>`;
const fidFilter = (fid: string) => `<ogc:Filter><ogc:FeatureId fid="${esc(fid)}"/></ogc:Filter>`;

async function upsert(gs: string, kc: Keycloak | null, acc: AccessConfig, table: string, fid: string | undefined, values: Record<string, string>) {
  const s = await describeTable(gs, kc, full(acc, table));
  if (fid) {
    const props = Object.entries(values).map(([k, v]) => `<wfs:Property><wfs:Name>${esc(k)}</wfs:Name><wfs:Value>${esc(v)}</wfs:Value></wfs:Property>`).join("");
    await wfsTransaction(gs, kc, tx(s, `<wfs:Update typeName="${s.prefix}:${s.typeName}">${props}${fidFilter(fid)}</wfs:Update>`));
  } else {
    const fields = Object.entries(values).map(([k, v]) => `<${s.prefix}:${k}>${esc(v)}</${s.prefix}:${k}>`).join("");
    await wfsTransaction(gs, kc, tx(s, `<wfs:Insert><${s.prefix}:${s.typeName}>${fields}</${s.prefix}:${s.typeName}></wfs:Insert>`));
  }
}

async function remove(gs: string, kc: Keycloak | null, acc: AccessConfig, table: string, fid: string) {
  const s = await describeTable(gs, kc, full(acc, table));
  await wfsTransaction(gs, kc, tx(s, `<wfs:Delete typeName="${s.prefix}:${s.typeName}">${fidFilter(fid)}</wfs:Delete>`));
}

const who = (kc: Keycloak | null) => String((kc?.tokenParsed as any)?.preferred_username ?? "");

export const saveRule = (gs: string, kc: Keycloak | null, acc: AccessConfig, r: RoleRule) =>
  upsert(gs, kc, acc, RULES_TABLE, r.fid, {
    ...(r.fid ? {} : { role: r.role }),
    layers: JSON.stringify(r.layers), tools: JSON.stringify(r.tools), updated_by: who(kc), updated_at: new Date().toISOString(),
  });
export const deleteRule = (gs: string, kc: Keycloak | null, acc: AccessConfig, fid: string) => remove(gs, kc, acc, RULES_TABLE, fid);

export const saveDashboard = (gs: string, kc: Keycloak | null, acc: AccessConfig, d: DashboardDef) =>
  upsert(gs, kc, acc, DASH_TABLE, d.fid, {
    title: d.title, description: d.description, roles: JSON.stringify(d.roles), definition: JSON.stringify(d.widgets),
    updated_by: who(kc), updated_at: new Date().toISOString(),
  });
export const deleteDashboard = (gs: string, kc: Keycloak | null, acc: AccessConfig, fid: string) => remove(gs, kc, acc, DASH_TABLE, fid);

export const dashId = (fid?: string) => (fid ?? "").split(".").pop() ?? "";

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
