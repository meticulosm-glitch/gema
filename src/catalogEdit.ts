import type { Product } from "./capabilities";
import { OTHERS, OTHERS_TITLE, applyCatalog, buildTree, folderPath, isEmptyCatalog, type Catalog, type CatalogFolder, type CatalogLayer, type CatalogNode } from "./catalog";

/**
 * Modello della pagina admin del catalogo: operazioni pure su un Catalog (sposta, rinomina, nascondi...) e
 * differenza con quello salvato, da trasformare in una sola transazione WFS-T.
 * In ogni cartella le posizioni restano 0..n-1, cartelle e layer insieme.
 */
export type Ref = { kind: "folder"; key: string } | { kind: "layer"; name: string };
export const refId = (r: Ref) => (r.kind === "folder" ? `f:${r.key}` : `l:${r.name}`);

/** Stato dell'editor: il catalogo dei layer pubblicati e, a parte, le righe di layer che GeoServer non pubblica più. */
export interface EditState { cat: Catalog; stale: CatalogLayer[] }

/**
 * Catalogo completo a partire da quello salvato: una riga per ogni layer pubblicato (i nuovi in fondo ad
 * "Altri prodotti", per titolo) e la cartella "Altri prodotti". Le posizioni salvate restano com'erano (aprire e
 * chiudere l'editor non deve produrre modifiche); cartelle con genitore mancante o in un ciclo tornano al primo livello.
 */
export function editableCatalog(products: Product[], saved: Catalog): EditState {
  const names = new Set(products.map((p) => p.name));
  if (isEmptyCatalog(saved)) return { cat: seedFromWorkspaces(products), stale: [] };
  const tree = buildTree(applyCatalog(products, saved), saved, { includeHidden: true, keepEmpty: true });
  const folders: CatalogFolder[] = [];
  const layers: CatalogLayer[] = [];
  const walk = (nodes: CatalogNode[], parent: string) => {
    let last = -1; // i layer senza riga seguono l'ultimo elemento salvato della cartella
    for (const n of nodes) {
      if (n.kind === "folder") {
        last = Math.max(last, n.own.position);
        folders.push({ ...n.own, parent });
        walk(n.children, n.key);
      } else if (n.entry) {
        last = Math.max(last, n.entry.position);
        layers.push({ ...n.entry, folder: parent });
      } else {
        layers.push({ layer: n.name, folder: parent, position: ++last, title: "", description: "", hidden: false, defaultOn: false });
      }
    }
  };
  walk(tree, "");
  return { cat: { folders, layers }, stale: saved.layers.filter((l) => !names.has(l.layer)) };
}

/** Primo catalogo: una cartella per workspace (com'è l'elenco senza catalogo), layer per titolo, "Altri prodotti" in fondo. */
function seedFromWorkspaces(products: Product[]): Catalog {
  const ws = Array.from(new Set(products.map((p) => p.workspace))).sort((a, b) => a.localeCompare(b));
  const folders: CatalogFolder[] = ws.map((w, position) => ({
    key: `ws-${w}`, parent: "", title: w, description: "", position, expanded: ws.length === 1, hidden: false,
  }));
  folders.push({ key: OTHERS, parent: "", title: OTHERS_TITLE, description: "", position: ws.length, expanded: false, hidden: false });
  const layers: CatalogLayer[] = ws.flatMap((w) =>
    products.filter((p) => p.workspace === w).sort((a, b) => a.title.localeCompare(b.title)).map((p, position) => ({
      layer: p.name, folder: `ws-${w}`, position, title: "", description: "", hidden: false, defaultOn: false,
    })));
  return { folders, layers };
}

/** Righe da salvare: catalogo dell'editor più le righe dei layer non pubblicati che l'admin non ha rimosso. */
export const rowsToSave = (s: EditState): Catalog => ({ folders: s.cat.folders, layers: [...s.cat.layers, ...s.stale] });

// ---------------------------------------------------------------- navigazione

export const parentOf = (cat: Catalog, r: Ref): string =>
  r.kind === "folder" ? cat.folders.find((f) => f.key === r.key)?.parent ?? "" : cat.layers.find((l) => l.layer === r.name)?.folder ?? "";

/** Elementi di una cartella in ordine (cartelle prima dei layer a parità di posizione). */
export function childrenOf(cat: Catalog, parent: string): Ref[] {
  const items = [
    ...cat.folders.filter((f) => f.parent === parent).map((f) => ({ ref: { kind: "folder", key: f.key } as Ref, pos: f.position, k: 0, t: f.title })),
    ...cat.layers.filter((l) => l.folder === parent).map((l) => ({ ref: { kind: "layer", name: l.layer } as Ref, pos: l.position, k: 1, t: l.title || l.layer })),
  ];
  return items.sort((a, b) => a.pos - b.pos || a.k - b.k || a.t.localeCompare(b.t)).map((x) => x.ref);
}

/** Cartelle contenute (a qualsiasi profondità) in `key`, lei compresa. */
export function descendants(cat: Catalog, key: string): Set<string> {
  const out = new Set([key]);
  for (let grew = true; grew;) {
    grew = false;
    for (const f of cat.folders) if (out.has(f.parent) && !out.has(f.key)) { out.add(f.key); grew = true; }
  }
  return out;
}

/** Si può mettere `r` dentro `parent`? "Altri prodotti" resta al primo livello e contiene solo layer; niente cicli. */
export function canMoveInto(cat: Catalog, r: Ref, parent: string): boolean {
  if (parent && !cat.folders.some((f) => f.key === parent)) return false;
  if (r.kind === "layer") return true;
  if (r.key === OTHERS) return parent === "";
  if (parent === OTHERS) return false;
  return !descendants(cat, r.key).has(parent);
}

/** Destinazioni valide per "Sposta in", con il percorso come etichetta. */
export function moveTargets(cat: Catalog, r: Ref): { key: string; label: string }[] {
  const all = [{ key: "", label: "(primo livello)" }, ...cat.folders.map((f) => ({ key: f.key, label: folderPath(cat, f.key) }))];
  return all.filter((t) => canMoveInto(cat, r, t.key)).sort((a, b) => (a.key === "" ? -1 : b.key === "" ? 1 : a.label.localeCompare(b.label)));
}

// ---------------------------------------------------------------- operazioni (restituiscono un nuovo Catalog)

const sameRef = (a: Ref, b: Ref) => refId(a) === refId(b);

function place(cat: Catalog, parent: string, order: Ref[]): Catalog {
  const pos = new Map(order.map((r, i) => [refId(r), i]));
  return {
    folders: cat.folders.map((f) => (pos.has(`f:${f.key}`) ? { ...f, parent, position: pos.get(`f:${f.key}`)! } : f)),
    layers: cat.layers.map((l) => (pos.has(`l:${l.layer}`) ? { ...l, folder: parent, position: pos.get(`l:${l.layer}`)! } : l)),
  };
}

/** Sposta su (-1) o giù (+1) nella stessa cartella. */
export function moveBy(cat: Catalog, r: Ref, delta: number): Catalog {
  const parent = parentOf(cat, r);
  const list = childrenOf(cat, parent);
  const i = list.findIndex((x) => sameRef(x, r));
  const j = i + delta;
  if (i < 0 || j < 0 || j >= list.length) return cat;
  [list[i], list[j]] = [list[j], list[i]];
  return place(cat, parent, list);
}

/** Sposta `r` in `parent`, prima di `before` (se dato e presente in quella cartella), altrimenti in fondo. */
export function moveTo(cat: Catalog, r: Ref, parent: string, before?: Ref): Catalog {
  if (!canMoveInto(cat, r, parent)) return cat;
  if (before && sameRef(before, r)) return cat;
  const from = parentOf(cat, r);
  let next = cat;
  if (from !== parent) next = place(next, from, childrenOf(next, from).filter((x) => !sameRef(x, r)));
  const list = childrenOf(next, parent).filter((x) => !sameRef(x, r));
  const at = before ? list.findIndex((x) => sameRef(x, before)) : -1;
  list.splice(at < 0 ? list.length : at, 0, r);
  return place(next, parent, list);
}

const slugify = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32);

/** Nuova cartella in fondo a `parent`. La chiave è derivata dal titolo e resta la stessa anche dopo una rinomina. */
export function addFolder(cat: Catalog, title: string, parent = ""): { cat: Catalog; key: string } {
  const t = title.trim() || "Nuova cartella";
  const base = `f-${slugify(t) || "cartella"}`;
  const keys = new Set(cat.folders.map((f) => f.key));
  let key = base;
  for (let i = 2; keys.has(key); i++) key = `${base}-${i}`;
  const p = parent && canMoveInto(cat, { kind: "folder", key }, parent) && parent !== OTHERS ? parent : "";
  // in fondo: dopo la posizione più alta della cartella (le righe dei layer non più pubblicati possono lasciare buchi)
  const last = Math.max(-1, ...cat.folders.filter((f) => f.parent === p).map((f) => f.position), ...cat.layers.filter((l) => l.folder === p).map((l) => l.position));
  const folder: CatalogFolder = { key, parent: p, title: t, description: "", position: last + 1, expanded: false, hidden: false };
  return { cat: { ...cat, folders: [...cat.folders, folder] }, key };
}

/** Elimina una cartella: il contenuto passa alla cartella che la conteneva, nello stesso punto. "Altri prodotti" non si elimina. */
export function removeFolder(cat: Catalog, key: string): Catalog {
  const f = cat.folders.find((x) => x.key === key);
  if (!f || key === OTHERS) return cat;
  const inner = childrenOf(cat, key);
  const list = childrenOf(cat, f.parent);
  const i = list.findIndex((x) => x.kind === "folder" && x.key === key);
  list.splice(i, 1, ...inner);
  const next = { ...cat, folders: cat.folders.filter((x) => x.key !== key) };
  return place(next, f.parent, list);
}

export function patchFolder(cat: Catalog, key: string, patch: Partial<Pick<CatalogFolder, "title" | "description" | "expanded" | "hidden">>): Catalog {
  return { ...cat, folders: cat.folders.map((f) => (f.key === key ? { ...f, ...patch } : f)) };
}

/** Modifica un layer. Nascosto e acceso di default si escludono: attivarne uno spegne l'altro. */
export function patchLayer(cat: Catalog, name: string, patch: Partial<Pick<CatalogLayer, "title" | "description" | "hidden" | "defaultOn">>): Catalog {
  const p = { ...patch };
  if (p.hidden) p.defaultOn = false;
  if (p.defaultOn) p.hidden = false;
  return { ...cat, layers: cat.layers.map((l) => (l.layer === name ? { ...l, ...p } : l)) };
}

/** Problemi che impediscono il salvataggio. */
export function validate(cat: Catalog): string[] {
  const errs: string[] = [];
  for (const f of cat.folders) if (!f.title.trim()) errs.push("Una cartella non ha il titolo.");
  const keys = cat.folders.map((f) => f.key);
  if (new Set(keys).size !== keys.length) errs.push("Due cartelle hanno la stessa chiave.");
  return Array.from(new Set(errs));
}

// ---------------------------------------------------------------- differenza con il salvato

export interface RowDiff<T> { insert: T[]; update: { fid: string; row: T; changed: (keyof T)[] }[]; remove: string[] }
export interface CatalogDiff { folders: RowDiff<CatalogFolder>; layers: RowDiff<CatalogLayer> }

const FOLDER_FIELDS: (keyof CatalogFolder)[] = ["key", "parent", "title", "description", "position", "expanded", "hidden"];
const LAYER_FIELDS: (keyof CatalogLayer)[] = ["layer", "folder", "position", "title", "description", "hidden", "defaultOn"];

function rows<T extends { fid?: string }>(base: T[], next: T[], fields: (keyof T)[]): RowDiff<T> {
  const old = new Map(base.filter((r) => r.fid).map((r) => [r.fid!, r]));
  const keep = new Set(next.map((r) => r.fid).filter(Boolean));
  const d: RowDiff<T> = { insert: [], update: [], remove: [...old.keys()].filter((fid) => !keep.has(fid)) };
  for (const r of next) {
    const o = r.fid ? old.get(r.fid) : undefined;
    if (!o) { d.insert.push(r); continue; }
    const changed = fields.filter((k) => o[k] !== r[k]);
    if (changed.length) d.update.push({ fid: r.fid!, row: r, changed });
  }
  return d;
}

/** Inserimenti, modifiche (solo i campi cambiati) ed eliminazioni per passare da `base` (salvato) a `next`. */
export function diffCatalog(base: Catalog, next: Catalog): CatalogDiff {
  return { folders: rows(base.folders, next.folders, FOLDER_FIELDS), layers: rows(base.layers, next.layers, LAYER_FIELDS) };
}

export const diffSize = (d: CatalogDiff) =>
  d.folders.insert.length + d.folders.update.length + d.folders.remove.length + d.layers.insert.length + d.layers.update.length + d.layers.remove.length;

/** Stesso contenuto salvato (per riconoscere una modifica fatta da un altro admin nel frattempo). */
export function sameCatalog(a: Catalog, b: Catalog): boolean {
  const canon = (c: Catalog) => JSON.stringify([
    c.folders.map((f) => FOLDER_FIELDS.map((k) => f[k]).concat(f.fid ?? "")).sort(),
    c.layers.map((l) => LAYER_FIELDS.map((k) => l[k]).concat(l.fid ?? "")).sort(),
  ]);
  return canon(a) === canon(b);
}
