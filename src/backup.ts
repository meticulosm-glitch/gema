import type Keycloak from "keycloak-js";
import type { AccessConfig } from "./config";
import { describeTable, wfsTransaction, type Schema } from "./api";
import {
  ANNOUNCEMENTS_TABLE, CATALOG_FOLDERS_TABLE, CATALOG_LAYERS_TABLE, DASH_TABLE, EDIT_FORMS_TABLE, ROLE_VIEWS_TABLE, RULES_TABLE,
  loadAnnouncements, loadCatalog, loadDashboards, loadEditForms, loadRoleViews, loadRules, whoAmI, wfsSignedDeleteOp, wfsTx, wfsUpsertOp,
  type DashboardDef,
} from "./configStore";
import { TOOL_IDS, type RoleRule, type ToolId } from "./roles";
import { formatBbox, parseBbox, type RoleView } from "./roleView";
import type { CatalogFolder, CatalogLayer } from "./catalog";
import { sanitizeFields, type FormDef } from "./editForm";
import { ISO_RE, sanitizeLevel, type Announcement } from "./announcements";
import { encodeDefinition, sanitizeFilters } from "./dashFilters";
import { sanitizeWidget } from "./dashboardIO";
import type { WidgetDef } from "./configStore";

/**
 * Backup e ripristino della configurazione in un file JSON: regole dei ruoli, viste iniziali, dashboard, catalogo,
 * moduli di modifica e avvisi. Il ripristino confronta il file con ciò che c'è (per chiave naturale: ruolo, titolo,
 * layer…), mostra cosa cambierebbe e scrive tutto in un'unica transazione WFS-T (tutto o niente).
 */
export const FORMAT = "gema-config";
export const VERSION = 1;
export type SectionId = "rules" | "roleViews" | "dashboards" | "catalogFolders" | "catalogLayers" | "forms" | "announcements";
export type Mode = "merge" | "replace";

type Row = { fid?: string };
interface Section<T extends Row> {
  id: SectionId; table: string; label: string;
  key: (r: T) => string;
  name: (r: T) => string;
  cols: (r: T) => Record<string, string>;
  clean: (raw: unknown) => T | null;
  layers?: (r: T) => string[];   // layer citati (per avvisare se in questo ambiente non esistono)
}

const s = (v: unknown) => (typeof v === "string" ? v : v == null ? "" : String(v));
const strs = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && !!x.trim()).map((x) => x.trim()) : []);
const bool = (v: unknown, d = false) => (typeof v === "boolean" ? v : d);
const int = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? Math.trunc(n) : 0; };
const obj = (v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
let uidN = 0;
const uid = () => `b${Date.now().toString(36)}${(uidN++).toString(36)}`;

export const SECTIONS: { [K in SectionId]: Section<any> } = {
  rules: {
    id: "rules", table: RULES_TABLE, label: "Regole dei ruoli",
    key: (r: RoleRule) => r.role, name: (r: RoleRule) => r.role,
    cols: (r: RoleRule) => ({ role: r.role, layers: JSON.stringify(r.layers), tools: JSON.stringify(r.tools) }),
    clean: (raw): RoleRule | null => {
      const o = obj(raw); const role = s(o?.role).trim(); if (!o || !role) return null;
      return { role, layers: strs(o.layers), tools: strs(o.tools).filter((t): t is ToolId => (TOOL_IDS as string[]).includes(t)) };
    },
    layers: (r: RoleRule) => r.layers.filter((l) => l !== "*"),
  } as Section<RoleRule>,
  roleViews: {
    id: "roleViews", table: ROLE_VIEWS_TABLE, label: "Viste iniziali dei ruoli",
    key: (v: RoleView) => v.role, name: (v: RoleView) => v.role,
    cols: (v: RoleView) => ({ role: v.role, bbox: v.bbox ? formatBbox(v.bbox) : "", basemap: v.basemap, layers: JSON.stringify(v.layers) }),
    clean: (raw): RoleView | null => {
      const o = obj(raw); const role = s(o?.role).trim(); if (!o || !role) return null;
      const bbox = parseBbox(Array.isArray(o.bbox) ? o.bbox.join(",") : s(o.bbox));
      return { role, ...(bbox ? { bbox } : {}), basemap: s(o.basemap).trim(), layers: strs(o.layers) };
    },
    layers: (v: RoleView) => v.layers,
  } as Section<RoleView>,
  dashboards: {
    id: "dashboards", table: DASH_TABLE, label: "Dashboard",
    key: (d: DashboardDef) => d.title.trim(), name: (d: DashboardDef) => d.title,
    cols: (d: DashboardDef) => ({ title: d.title.trim(), description: d.description, roles: JSON.stringify(d.roles), definition: encodeDefinition(d.widgets, d.filters) }),
    clean: (raw): DashboardDef | null => {
      const o = obj(raw); const title = s(o?.title).trim(); if (!o || !title) return null;
      const widgets = (Array.isArray(o.widgets) ? o.widgets : []).map((w) => sanitizeWidget(w, uid)).filter((w): w is WidgetDef => !!w);
      const filters = sanitizeFilters(o.filters);
      return { title, description: s(o.description), roles: strs(o.roles), widgets, ...(filters ? { filters } : {}) };
    },
    layers: (d: DashboardDef) => d.widgets.map((w) => w.layer).filter(Boolean),
  } as Section<DashboardDef>,
  catalogFolders: {
    id: "catalogFolders", table: CATALOG_FOLDERS_TABLE, label: "Catalogo: cartelle",
    key: (f: CatalogFolder) => f.key, name: (f: CatalogFolder) => f.title || f.key,
    cols: (f: CatalogFolder) => ({ folder_key: f.key, parent_key: f.parent, title: f.title, description: f.description, position: String(f.position), expanded: String(f.expanded), hidden: String(f.hidden) }),
    clean: (raw): CatalogFolder | null => {
      const o = obj(raw); const key = s(o?.key).trim(); const title = s(o?.title).trim(); if (!o || !key || !title) return null;
      const parent = s(o.parent).trim();
      return { key, parent: parent === key ? "" : parent, title, description: s(o.description), position: int(o.position), expanded: bool(o.expanded), hidden: bool(o.hidden) };
    },
  } as Section<CatalogFolder>,
  catalogLayers: {
    id: "catalogLayers", table: CATALOG_LAYERS_TABLE, label: "Catalogo: layer",
    key: (l: CatalogLayer) => l.layer, name: (l: CatalogLayer) => l.title || l.layer,
    cols: (l: CatalogLayer) => ({ layer: l.layer, folder_key: l.folder, position: String(l.position), title: l.title, description: l.description, hidden: String(l.hidden), default_on: String(l.defaultOn) }),
    clean: (raw): CatalogLayer | null => {
      const o = obj(raw); const layer = s(o?.layer).trim(); if (!o || !layer) return null;
      const hidden = bool(o.hidden);
      return { layer, folder: s(o.folder).trim(), position: int(o.position), title: s(o.title), description: s(o.description), hidden, defaultOn: !hidden && bool(o.defaultOn) };
    },
    layers: (l: CatalogLayer) => [l.layer],
  } as Section<CatalogLayer>,
  forms: {
    id: "forms", table: EDIT_FORMS_TABLE, label: "Moduli di modifica",
    key: (f: FormDef) => f.layer, name: (f: FormDef) => f.layer,
    cols: (f: FormDef) => ({ layer: f.layer, definition: JSON.stringify(f.fields) }),
    clean: (raw): FormDef | null => {
      const o = obj(raw); const layer = s(o?.layer).trim(); if (!o || !layer) return null;
      const fields = sanitizeFields(o.fields);
      return fields.length ? { layer, fields } : null;
    },
    layers: (f: FormDef) => [f.layer],
  } as Section<FormDef>,
  announcements: {
    id: "announcements", table: ANNOUNCEMENTS_TABLE, label: "Avvisi",
    key: (a: Announcement) => a.message.trim(), name: (a: Announcement) => (a.message.length > 60 ? `${a.message.slice(0, 57)}…` : a.message),
    cols: (a: Announcement) => ({ message: a.message.trim(), level: a.level, starts_at: a.startsAt, ends_at: a.endsAt, roles: JSON.stringify(a.roles), dismissible: String(a.level !== "maintenance" && a.dismissible), active: String(a.active) }),
    clean: (raw): Announcement | null => {
      const o = obj(raw); const message = s(o?.message).trim(); if (!o || !message || message.length > 1000) return null;
      const iso = (v: unknown) => (ISO_RE.test(s(v)) ? s(v) : "");
      const level = sanitizeLevel(o.level);
      return { message, level, startsAt: iso(o.startsAt), endsAt: iso(o.endsAt), roles: strs(o.roles), dismissible: level !== "maintenance" && bool(o.dismissible, true), active: bool(o.active, true) };
    },
  } as Section<Announcement>,
};
export const SECTION_IDS = Object.keys(SECTIONS) as SectionId[];

export type Snapshot = Partial<Record<SectionId, Row[]>>;
export interface BackupFile { format: string; version: number; exportedAt: string; source: string; workspace: string; sections: Snapshot }

/** Configurazione attuale. Una tabella che non si legge (Job non rieseguito) resta fuori, con il motivo. */
export async function collect(gs: string, kc: Keycloak | null, acc: AccessConfig): Promise<{ data: Snapshot; errors: Partial<Record<SectionId, string>> }> {
  const data: Snapshot = {};
  const errors: Partial<Record<SectionId, string>> = {};
  const catalog = loadCatalog(gs, kc, acc);
  const loaders: Record<SectionId, () => Promise<Row[]>> = {
    rules: () => loadRules(gs, kc, acc), roleViews: () => loadRoleViews(gs, kc, acc), dashboards: () => loadDashboards(gs, kc, acc),
    catalogFolders: async () => (await catalog).folders, catalogLayers: async () => (await catalog).layers,
    forms: () => loadEditForms(gs, kc, acc), announcements: () => loadAnnouncements(gs, kc, acc),
  };
  await Promise.all(SECTION_IDS.map(async (id) => {
    try { data[id] = await loaders[id](); } catch (e) { errors[id] = (e as Error).message ?? String(e); }
  }));
  return { data, errors };
}

/** Riga per il file: senza id, autore e data (dipendono dall'ambiente). */
const forFile = (r: Row) => { const { fid: _f, updatedBy: _b, updatedAt: _a, ...rest } = r as Row & { updatedBy?: string; updatedAt?: string }; return rest; };

export function exportBackup(data: Snapshot, sections: SectionId[], source: string, workspace: string, now = new Date()): BackupFile {
  return { format: FORMAT, version: VERSION, exportedAt: now.toISOString(), source, workspace, sections: Object.fromEntries(sections.filter((id) => data[id]).map((id) => [id, data[id]!.map(forFile)])) };
}
export const backupName = (host: string, now = new Date()) => `gema-config-${host.replace(/[^\w.-]+/g, "_")}-${now.toISOString().slice(0, 16).replace(/[:T]/g, "-")}.json`;

/** Legge un file di backup: sezioni ripulite, righe non valide o doppie scartate con un avviso. */
export function parseBackup(text: string): { file: BackupFile; warnings: string[] } {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { throw new Error("il file non è JSON valido"); }
  const o = obj(raw);
  if (!o || o.format !== FORMAT) throw new Error(o?.format === "gema-dashboards" ? "è un file di sole dashboard: si importa dalla pagina Crea dashboard" : "non è un backup della configurazione di Gema");
  if (typeof o.version === "number" && o.version > VERSION) throw new Error(`backup di una versione più recente (${o.version}): aggiorna l'applicazione`);
  const sections = obj(o.sections) ?? {};
  const warnings: string[] = [];
  const out: Snapshot = {};
  for (const id of SECTION_IDS) {
    if (!(id in sections)) continue;
    const list = Array.isArray(sections[id]) ? (sections[id] as unknown[]) : [];
    const sec = SECTIONS[id];
    const seen = new Set<string>();
    const rows: Row[] = [];
    let bad = 0, dup = 0;
    for (const r of list) {
      const c = sec.clean(r);
      if (!c) { bad++; continue; }
      const k = sec.key(c);
      if (seen.has(k)) { dup++; continue; }
      seen.add(k); rows.push(c);
    }
    if (bad) warnings.push(`${sec.label}: ${bad} righe non valide scartate.`);
    if (dup) warnings.push(`${sec.label}: ${dup} doppioni scartati (conta la prima).`);
    out[id] = rows;
  }
  if (Object.keys(out).length === 0) throw new Error("il file non contiene sezioni di configurazione");
  return { file: { format: FORMAT, version: VERSION, exportedAt: s(o.exportedAt), source: s(o.source), workspace: s(o.workspace), sections: out }, warnings };
}

export interface SectionPlan { id: SectionId; insert: Row[]; update: { fid: string; row: Row; before: Row }[]; remove: Row[]; same: number }

/** Cosa cambierebbe: per ogni sezione del file scelta, righe nuove, modificate, uguali e (sostituendo) da eliminare. */
export function planRestore(current: Snapshot, incoming: Snapshot, sections: SectionId[], mode: Mode): SectionPlan[] {
  return sections.filter((id) => incoming[id]).map((id) => {
    const sec = SECTIONS[id];
    const cur = new Map((current[id] ?? []).map((r) => [sec.key(r), r]));
    const inc = incoming[id]!;
    const plan: SectionPlan = { id, insert: [], update: [], remove: [], same: 0 };
    for (const r of inc) {
      const c = cur.get(sec.key(r));
      if (!c) plan.insert.push(r);
      else if (JSON.stringify(sec.cols(c)) === JSON.stringify(sec.cols(r))) plan.same++;
      else plan.update.push({ fid: c.fid!, row: r, before: c });
    }
    if (mode === "replace") { const keys = new Set(inc.map(sec.key)); plan.remove = (current[id] ?? []).filter((r) => !keys.has(sec.key(r)) && r.fid); }
    return plan;
  });
}

export const planSize = (p: SectionPlan[]) => p.reduce((n, x) => n + x.insert.length + x.update.length + x.remove.length, 0);

/** Layer citati nel file che in questo ambiente non sono pubblicati. */
export function missingLayersIn(incoming: Snapshot, sections: SectionId[], published: Set<string>): string[] {
  const all = sections.flatMap((id) => (incoming[id] ?? []).flatMap((r) => SECTIONS[id].layers?.(r) ?? []));
  return Array.from(new Set(all)).filter((l) => !published.has(l)).sort();
}

/** Applica il piano in un'unica transazione: prima le eliminazioni (firmate), poi le modifiche, poi gli inserimenti. */
export async function applyRestore(gs: string, kc: Keycloak | null, acc: AccessConfig, plan: SectionPlan[]): Promise<number> {
  const n = planSize(plan);
  if (n === 0) return 0;
  const schemas = new Map<string, Schema>();
  for (const p of plan) if (p.insert.length + p.update.length + p.remove.length) schemas.set(p.id, await describeTable(gs, kc, `${acc.workspace}:${SECTIONS[p.id].table}`));
  const stamp = { updated_by: whoAmI(kc), updated_at: new Date().toISOString() };
  const del: string[] = [], upd: string[] = [], ins: string[] = [];
  for (const p of plan) {
    const sch = schemas.get(p.id); if (!sch) continue;
    const sec = SECTIONS[p.id];
    for (const r of p.remove) del.push(wfsSignedDeleteOp(sch, r.fid!, kc));
    for (const u of p.update) upd.push(wfsUpsertOp(sch, u.fid, { ...sec.cols(u.row), ...stamp }));
    for (const r of p.insert) ins.push(wfsUpsertOp(sch, undefined, { ...sec.cols(r), ...stamp }));
  }
  const first = schemas.values().next().value as Schema;
  await wfsTransaction(gs, kc, wfsTx(first, [...del, ...upd, ...ins].join("")));
  return n;
}
