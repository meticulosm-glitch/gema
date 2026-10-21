import type { DashboardDef, DashboardDraft } from "./configStore";
import { dashId } from "./configStore";
import { layerAllowed, type Permissions } from "./roles";
import { formatBbox, type Bbox } from "./roleView";

/**
 * Bozze e pubblicazione delle dashboard: chi usa le dashboard vede solo la versione pubblicata (tabella dashboards);
 * le modifiche dell'amministratore restano in una bozza (tabella dashboard_drafts) finché non le pubblica.
 */
export type DashStatus = "published" | "changed" | "draft";
export interface DashItem { key: string; published?: DashboardDef; draft?: DashboardDraft }

export const STATUS_LABEL: Record<DashStatus, string> = { published: "Pubblicata", changed: "Bozza da pubblicare", draft: "Mai pubblicata" };

/** Elenco della pagina admin: le dashboard pubblicate (con la loro bozza, se c'è) e le bozze mai pubblicate. */
export function mergeItems(dashboards: DashboardDef[], drafts: DashboardDraft[]): DashItem[] {
  const byId = new Map(dashboards.map((d) => [dashId(d.fid), d]));
  const items: DashItem[] = dashboards.map((d) => {
    const draft = drafts.find((x) => x.dashboardId && x.dashboardId === dashId(d.fid));
    return { key: d.fid!, published: d, ...(draft ? { draft } : {}) };
  });
  // bozze nuove, e bozze rimaste senza dashboard (eliminata da un altro amministratore): si pubblicano come nuove
  for (const x of drafts) if (!x.dashboardId || !byId.has(x.dashboardId)) items.push({ key: x.fid, draft: x });
  return items.sort((a, b) => itemTitle(a).localeCompare(itemTitle(b)) || a.key.localeCompare(b.key));
}

export const itemTitle = (i: DashItem) => (i.draft?.def.title ?? i.published?.title ?? "").trim();
export const itemStatus = (i: DashItem): DashStatus => (!i.published ? "draft" : i.draft ? "changed" : "published");

/** Cosa si apre nell'editor: la bozza se c'è, altrimenti la versione pubblicata (fid = quello della pubblicata). */
export function editorContent(i: DashItem): DashboardDef {
  const src = i.draft ? { ...i.draft.def, ...(i.published?.fid ? { fid: i.published.fid } : {}) } : i.published!;
  const { updatedBy: _b, updatedAt: _a, ...rest } = structuredClone(src);
  return rest;
}

/** Confronto per "modifiche non salvate": stesso contenuto, a prescindere da autore e data. */
export const sameContent = (a: DashboardDef, b: DashboardDef) => {
  const pick = (d: DashboardDef) => JSON.stringify([d.title, d.description, [...d.roles].sort(), d.widgets, d.filters ?? null]);
  return pick(a) === pick(b);
};

/** Cosa cambia tra la versione pubblicata e la bozza, in parole. */
export function draftChanges(pub: DashboardDef, draft: DashboardDef): string[] {
  const out: string[] = [];
  if (pub.title !== draft.title) out.push(`titolo («${pub.title}» → «${draft.title}»)`);
  if (pub.description !== draft.description) out.push("descrizione");
  const added = draft.roles.filter((r) => !pub.roles.includes(r));
  const removed = pub.roles.filter((r) => !draft.roles.includes(r));
  if (added.length) out.push(`ruoli aggiunti: ${added.join(", ")}`);
  if (removed.length) out.push(`ruoli tolti: ${removed.join(", ")}`);
  const pubIds = new Set(pub.widgets.map((w) => w.id));
  const draftIds = new Set(draft.widgets.map((w) => w.id));
  const nAdded = draft.widgets.filter((w) => !pubIds.has(w.id)).length;
  const nRemoved = pub.widgets.filter((w) => !draftIds.has(w.id)).length;
  const nChanged = draft.widgets.filter((w) => { const p = pub.widgets.find((x) => x.id === w.id); return p && JSON.stringify(p) !== JSON.stringify(w); }).length;
  const moved = JSON.stringify(pub.widgets.map((w) => w.id).filter((id) => draftIds.has(id))) !== JSON.stringify(draft.widgets.map((w) => w.id).filter((id) => pubIds.has(id)));
  if (nAdded) out.push(nAdded === 1 ? "1 widget nuovo" : `${nAdded} widget nuovi`);
  if (nRemoved) out.push(nRemoved === 1 ? "1 widget tolto" : `${nRemoved} widget tolti`);
  if (nChanged) out.push(nChanged === 1 ? "1 widget modificato" : `${nChanged} widget modificati`);
  if (moved) out.push("ordine dei widget");
  if (JSON.stringify(pub.filters ?? null) !== JSON.stringify(draft.filters ?? null)) out.push("filtri globali");
  return out;
}

export interface PreviewNote { level: "ok" | "warning"; text: string }

/**
 * Cosa vedrà un ruolo, detto in chiaro sopra l'anteprima. I dati dell'anteprima si leggono con le credenziali
 * dell'amministratore: quello che il ruolo legge davvero lo decidono le regole dati di GeoServer.
 */
export function previewNotes(d: DashboardDef, role: string, perms: Permissions, roleBbox?: Bbox): PreviewNote[] {
  const notes: PreviewNote[] = [];
  if (perms.none) notes.push({ level: "warning", text: `Il ruolo ${role} non ha regole: non entra nell'applicazione.` });
  notes.push(d.roles.includes(role)
    ? { level: "ok", text: `${role} trova questa dashboard nell'elenco (dopo la pubblicazione).` }
    : { level: "warning", text: `${role} non è tra i ruoli della dashboard: non la vedrà.` });
  const layers = Array.from(new Set(d.widgets.map((w) => w.layer).filter(Boolean)));
  const denied = layers.filter((l) => !layerAllowed(perms, l));
  if (denied.length) notes.push({ level: "warning", text: `Layer non abilitati per ${role} nella pagina Ruoli e permessi: ${denied.join(", ")}. «Apri sulla mappa» non sarà disponibile e i dati arrivano solo se GeoServer li concede al ruolo.` });
  if (d.filters?.area) notes.push(roleBbox
    ? { level: "ok", text: `«La mia area» usa l'area della vista iniziale del ruolo: ${formatBbox(roleBbox)}.` }
    : { level: "ok", text: "Il ruolo non ha un'area nella vista iniziale: «La mia area» non compare." });
  return notes;
}
