import type Keycloak from "keycloak-js";
import type { AccessConfig } from "./config";
import { describeTable, getWfsFeatureById, getWfsFeaturesSorted, wfsTransaction, type Feature } from "./api";
import { CHANGE_LOG_TABLE, CONFIG_COLUMNS } from "./configStore";

/**
 * Registro modifiche: righe della tabella change_log, scritte da un trigger PostGIS su ogni tabella di configurazione.
 * La pagina le legge, mostra cosa è cambiato e permette di riportare una riga a una versione precedente (con una
 * normale scrittura WFS-T, che a sua volta finisce nel registro).
 */
export { CHANGE_LOG_TABLE };
export type ChangeOp = "INSERT" | "UPDATE" | "DELETE";
export type RowData = Record<string, unknown>;
export interface ChangeEntry {
  fid: string;
  seq: number;              // id della riga di registro (ordine tra modifiche nella stessa transazione)
  table: string;
  rowId: number | null;
  op: ChangeOp;
  old: RowData | null;
  new: RowData | null;
  changedBy: string;
  dbUser: string;
  changedAt: string;
}
export interface LogQuery { table?: string; rowId?: number; user?: string; from?: string; to?: string; text?: string }

export const TABLE_LABEL: Record<string, string> = {
  role_rules: "Regole dei ruoli", dashboards: "Dashboard", catalog_folders: "Catalogo: cartelle", catalog_layers: "Catalogo: layer",
  role_views: "Viste iniziali", edit_forms: "Moduli di modifica", announcements: "Avvisi",
};
export const LOGGED_TABLES = Object.keys(TABLE_LABEL);
export const OP_LABEL: Record<ChangeOp, string> = { INSERT: "Creato", UPDATE: "Modificato", DELETE: "Eliminato" };
const NAME_FIELD: Record<string, string> = { role_rules: "role", dashboards: "title", catalog_folders: "title", catalog_layers: "layer", role_views: "role", edit_forms: "layer", announcements: "message" };
const STAMPS = new Set(["id", "updated_by", "updated_at"]);
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

const parse = (v: unknown): RowData | null => {
  if (v == null || v === "") return null;
  try { const o = JSON.parse(String(v)); return o && typeof o === "object" && !Array.isArray(o) ? o : null; } catch { return null; }
};
const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
const nextDay = (d: string) => new Date(Date.parse(`${d}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

export function toEntry(f: Feature): ChangeEntry | null {
  const p = f.properties ?? {};
  const op = String(p.op ?? "") as ChangeOp;
  if (!["INSERT", "UPDATE", "DELETE"].includes(op) || !f.id) return null;
  const rowId = p.row_id == null || p.row_id === "" ? null : Number(p.row_id);
  return {
    fid: f.id, seq: Number(f.id.split(".").pop()) || 0, table: String(p.table_name ?? ""), rowId: Number.isFinite(rowId) ? rowId : null, op,
    old: parse(p.old_data), new: parse(p.new_data), changedBy: String(p.changed_by ?? ""), dbUser: String(p.db_user ?? ""), changedAt: String(p.changed_at ?? ""),
  };
}

/** Più recenti prima; a parità di istante (stessa transazione) l'ordine di scrittura. */
export const byNewest = (a: ChangeEntry, b: ChangeEntry) => Date.parse(b.changedAt) - Date.parse(a.changedAt) || b.seq - a.seq;

export function logCql(qr: LogQuery): string {
  const parts: string[] = [];
  if (qr.table) parts.push(`table_name = ${q(qr.table)}`);
  if (qr.rowId != null) parts.push(`row_id = ${Math.trunc(qr.rowId)}`);
  if (qr.user?.trim()) parts.push(`changed_by = ${q(qr.user.trim())}`);
  if (qr.from && DAY_RE.test(qr.from)) parts.push(`changed_at >= '${qr.from}T00:00:00Z'`);
  if (qr.to && DAY_RE.test(qr.to)) parts.push(`changed_at < '${nextDay(qr.to)}T00:00:00Z'`);
  return parts.join(" AND ");
}

/** Nome leggibile dell'elemento (ruolo, titolo, layer, testo dell'avviso). */
export function entryName(e: ChangeEntry): string {
  const d = e.new ?? e.old ?? {};
  const v = String(d[NAME_FIELD[e.table] ?? ""] ?? "").trim();
  const name = v.length > 60 ? `${v.slice(0, 57)}…` : v;
  return name || (e.rowId != null ? `#${e.rowId}` : "(senza nome)");
}

/** Campi cambiati (timbri esclusi). */
export function changedFields(e: ChangeEntry): { field: string; before: unknown; after: unknown }[] {
  const o = e.old ?? {}, n = e.new ?? {};
  const keys = Array.from(new Set([...Object.keys(o), ...Object.keys(n)])).filter((k) => !STAMPS.has(k));
  return keys.filter((k) => e.op !== "UPDATE" || JSON.stringify(o[k] ?? null) !== JSON.stringify(n[k] ?? null))
    .map((k) => ({ field: k, before: e.op === "INSERT" ? undefined : o[k], after: e.op === "DELETE" ? undefined : n[k] }));
}

const matches = (e: ChangeEntry, text: string) => {
  const t = text.trim().toLowerCase();
  return !t || entryName(e).toLowerCase().includes(t) || e.changedBy.toLowerCase().includes(t) || JSON.stringify([e.old, e.new]).toLowerCase().includes(t);
};

export async function loadChangeLog(gs: string, kc: Keycloak | null, acc: AccessConfig, qr: LogQuery, max = 500): Promise<{ entries: ChangeEntry[]; capped: boolean }> {
  const fs = await getWfsFeaturesSorted(gs, kc, `${acc.workspace}:${CHANGE_LOG_TABLE}`, "changed_at DESC", logCql(qr), max);
  const entries = fs.map(toEntry).filter((e): e is ChangeEntry => !!e).sort(byNewest);
  return { entries: entries.filter((e) => matches(e, qr.text ?? "")), capped: fs.length >= max };
}

/** La versione che una voce rappresenta: la riga dopo la modifica, o prima dell'eliminazione. */
export const versionOf = (e: ChangeEntry): RowData | null => (e.op === "DELETE" ? e.old : e.new);

/** La voce è lo stato attuale della riga (ultima voce per quella riga, non un'eliminazione). */
export function isCurrent(e: ChangeEntry, all: ChangeEntry[]): boolean {
  const latest = all.filter((x) => x.table === e.table && x.rowId === e.rowId).sort(byNewest)[0];
  return latest?.fid === e.fid && e.op !== "DELETE";
}

const toText = (v: unknown) => (v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v));

/**
 * Riporta la riga alla versione della voce: aggiorna la riga se esiste ancora, altrimenti la ricrea (con un id nuovo).
 * Scrive solo le colonne che l'app conosce; autore e data diventano quelli di chi ripristina.
 */
export async function restoreVersion(gs: string, kc: Keycloak | null, acc: AccessConfig, e: ChangeEntry): Promise<"updated" | "inserted" | "unchanged"> {
  const data = versionOf(e);
  const cols = CONFIG_COLUMNS[e.table];
  if (!data || !cols || !LOGGED_TABLES.includes(e.table)) throw new Error("questa voce non si può ripristinare");
  const name = `${acc.workspace}:${e.table}`;
  const s = await describeTable(gs, kc, name);
  const fid = e.rowId != null ? `${e.table}.${e.rowId}` : "";
  const current = fid ? await getWfsFeatureById(gs, kc, name, fid) : null;
  const exists = !!current;
  const values: Record<string, string> = {};
  for (const c of cols) if (!STAMPS.has(c) && c in data) values[c] = toText(data[c]);
  if (current && Object.entries(values).every(([k, v]) => toText(current.properties?.[k]) === v)) return "unchanged";
  values.updated_by = String((kc?.tokenParsed as any)?.preferred_username ?? "");
  values.updated_at = new Date().toISOString();
  const esc = (x: string) => x.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const type = `${s.prefix}:${s.typeName}`;
  const body = exists
    ? `<wfs:Update typeName="${type}">${Object.entries(values).map(([k, v]) => `<wfs:Property><wfs:Name>${esc(k)}</wfs:Name><wfs:Value>${esc(v)}</wfs:Value></wfs:Property>`).join("")}<ogc:Filter><ogc:FeatureId fid="${esc(fid)}"/></ogc:Filter></wfs:Update>`
    : `<wfs:Insert><${type}>${Object.entries(values).map(([k, v]) => `<${s.prefix}:${k}>${esc(v)}</${s.prefix}:${k}>`).join("")}</${type}></wfs:Insert>`;
  await wfsTransaction(gs, kc, `<?xml version="1.0" encoding="UTF-8"?><wfs:Transaction service="WFS" version="1.0.0" xmlns:wfs="http://www.opengis.net/wfs" xmlns:ogc="http://www.opengis.net/ogc" xmlns:${s.prefix}="${esc(s.ns)}">${body}</wfs:Transaction>`);
  return exists ? "updated" : "inserted";
}
