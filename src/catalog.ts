import type { Product } from "./capabilities";

/**
 * Catalogo prodotti: come i layer pubblicati in GeoServer appaiono nell'elenco della mappa.
 * Cartelle (anche annidate) e layer di una stessa cartella condividono l'ordinamento (`position`).
 * Titolo e descrizione vuoti = quelli di GeoServer. Un catalogo vuoto lascia l'elenco com'era (per workspace).
 */
export interface CatalogFolder {
  fid?: string;
  key: string;          // identificativo stabile, non cambia se la cartella viene rinominata
  parent: string;       // cartella che la contiene; "" = primo livello
  title: string;
  description: string;
  position: number;
  expanded: boolean;    // aperta all'avvio
  hidden: boolean;      // nasconde la cartella con tutto il contenuto
}
export interface CatalogLayer {
  fid?: string;
  layer: string;        // nome GeoServer (workspace:layer)
  folder: string;       // "" = primo livello
  position: number;
  title: string;        // "" = titolo di GeoServer
  description: string;  // "" = Abstract di GeoServer
  hidden: boolean;
  defaultOn: boolean;   // acceso quando la mappa si apre senza link né vista
}
export interface Catalog { folders: CatalogFolder[]; layers: CatalogLayer[] }

/** Cartella dei layer non ancora catalogati (pubblicati dopo l'ultimo salvataggio): rinominabile, spostabile, nascondibile. */
export const OTHERS = "@altri";
export const OTHERS_TITLE = "Altri prodotti";
export const EMPTY_CATALOG: Catalog = { folders: [], layers: [] };
export const isEmptyCatalog = (c: Catalog) => c.folders.length === 0 && c.layers.length === 0;

export type CatalogNode = FolderNode | LayerNode;
export interface FolderNode {
  kind: "folder"; key: string; title: string; description: string; expanded: boolean;
  hidden: boolean;     // nascosta lei o una cartella che la contiene
  own: CatalogFolder;  // riga della tabella (sintetica per "Altri prodotti" mai salvata)
  children: CatalogNode[];
}
export interface LayerNode {
  kind: "layer"; name: string; product: Product;
  hidden: boolean;     // nascosto lui o una cartella che lo contiene
  defaultOn: boolean;
  entry?: CatalogLayer; // assente = layer non catalogato
}

const othersFolder = (position: number): CatalogFolder => ({ key: OTHERS, parent: "", title: OTHERS_TITLE, description: "", position, expanded: false, hidden: false });

/** Titolo e descrizione personalizzati al posto di quelli di GeoServer (il resto del prodotto resta com'è). */
export function applyCatalog(products: Product[], cat: Catalog): Product[] {
  if (cat.layers.length === 0) return products;
  const by = new Map(cat.layers.map((l) => [l.layer, l]));
  return products.map((p) => {
    const e = by.get(p.name);
    if (!e) return p;
    const title = e.title.trim(), description = e.description.trim();
    return title || description ? { ...p, ...(title ? { title } : {}), ...(description ? { abstract: description } : {}) } : p;
  });
}

/** Cartella genitore valida: una cartella mancante o un ciclo (A dentro B dentro A) riportano al primo livello. */
function parentResolver(folders: Map<string, CatalogFolder>) {
  return (key: string): string => {
    const f = folders.get(key);
    if (!f || !f.parent || !folders.has(f.parent) || f.key === OTHERS) return "";
    const seen = new Set([key]);
    for (let p: string = f.parent; p; p = folders.get(p)?.parent ?? "") {
      if (seen.has(p) || !folders.has(p)) return "";
      seen.add(p);
    }
    return f.parent;
  };
}

type Item = { kind: "folder"; f: CatalogFolder } | { kind: "layer"; p: Product; e?: CatalogLayer };
const itemTitle = (i: Item) => (i.kind === "folder" ? i.f.title : i.p.title);
const itemPos = (i: Item) => (i.kind === "folder" ? i.f.position : i.e ? i.e.position : Number.POSITIVE_INFINITY);
const byPosition = (a: Item, b: Item) => itemPos(a) - itemPos(b) || (a.kind === b.kind ? 0 : a.kind === "folder" ? -1 : 1) || itemTitle(a).localeCompare(itemTitle(b));

export interface TreeOptions {
  includeHidden?: boolean; // l'admin vede anche cartelle e layer nascosti (marcati)
  keepEmpty?: boolean;     // cartelle senza layer (pagina admin)
}

/**
 * Albero del catalogo per i prodotti dati (già con i titoli del catalogo, vedi applyCatalog).
 * Le righe di layer non più pubblicati si ignorano; i layer senza riga vanno in "Altri prodotti", per titolo.
 */
export function buildTree(products: Product[], cat: Catalog, opt: TreeOptions = {}): CatalogNode[] {
  const folders = new Map(cat.folders.map((f) => [f.key, f]));
  if (!folders.has(OTHERS)) {
    const top = cat.folders.filter((f) => !f.parent).map((f) => f.position);
    const topLayers = cat.layers.filter((l) => !l.folder || !folders.has(l.folder)).map((l) => l.position);
    folders.set(OTHERS, othersFolder(Math.max(-1, ...top, ...topLayers) + 1));
  }
  const parentOf = parentResolver(folders);
  const entries = new Map(cat.layers.map((l) => [l.layer, l]));
  const kids = new Map<string, Item[]>();
  const push = (parent: string, it: Item) => kids.set(parent, [...(kids.get(parent) ?? []), it]);
  for (const f of folders.values()) push(parentOf(f.key), { kind: "folder", f });
  for (const p of products) {
    const e = entries.get(p.name);
    const folder = e ? (e.folder && folders.has(e.folder) ? e.folder : "") : OTHERS;
    push(folder, { kind: "layer", p, e });
  }

  const build = (parent: string, parentHidden: boolean): CatalogNode[] => {
    const out: CatalogNode[] = [];
    for (const it of (kids.get(parent) ?? []).slice().sort(byPosition)) {
      if (it.kind === "folder") {
        const hidden = parentHidden || it.f.hidden;
        if (hidden && !opt.includeHidden) continue;
        const children = build(it.f.key, hidden);
        if (!opt.keepEmpty && countLayers(children) === 0) continue;
        out.push({ kind: "folder", key: it.f.key, title: it.f.title, description: it.f.description, expanded: it.f.expanded, hidden, own: it.f, children });
      } else {
        const hidden = parentHidden || !!it.e?.hidden;
        if (hidden && !opt.includeHidden) continue;
        out.push({ kind: "layer", name: it.p.name, product: it.p, hidden, defaultOn: !!it.e?.defaultOn, ...(it.e ? { entry: it.e } : {}) });
      }
    }
    return out;
  };
  return build("", false);
}

/** Layer dell'albero nell'ordine del catalogo (visita in profondità). */
export function flattenLayers(nodes: CatalogNode[]): LayerNode[] {
  return nodes.flatMap((n) => (n.kind === "layer" ? [n] : flattenLayers(n.children)));
}
export const countLayers = (nodes: CatalogNode[]) => flattenLayers(nodes).length;

/** Layer da accendere all'apertura, nell'ordine del catalogo (il primo è quello che deve stare sopra). Mai i nascosti. */
export const defaultOnLayers = (nodes: CatalogNode[]) => flattenLayers(nodes).filter((n) => n.defaultOn && !n.hidden).map((n) => n.name);

/**
 * Filtro di ricerca: tiene i layer che corrispondono (titolo, nome, descrizione) e, se il titolo di una cartella
 * corrisponde, tutta la cartella. Le cartelle rimaste senza layer spariscono.
 */
export function filterTree(nodes: CatalogNode[], q: string): CatalogNode[] {
  const s = q.trim().toLowerCase();
  if (!s) return nodes;
  const hit = (t?: string) => !!t && t.toLowerCase().includes(s);
  const out: CatalogNode[] = [];
  for (const n of nodes) {
    if (n.kind === "layer") {
      if (hit(n.product.title) || hit(n.name) || hit(n.product.abstract)) out.push(n);
    } else if (hit(n.title)) {
      if (countLayers(n.children) > 0) out.push(n);
    } else {
      const children = filterTree(n.children, s);
      if (countLayers(children) > 0) out.push({ ...n, children });
    }
  }
  return out;
}

/** Percorso della cartella (titoli dal primo livello), per menu e messaggi. */
export function folderPath(cat: Catalog, key: string): string {
  const by = new Map(cat.folders.map((f) => [f.key, f]));
  const parts: string[] = [];
  const seen = new Set<string>();
  for (let k = key; k && by.has(k) && !seen.has(k); k = by.get(k)!.parent) { seen.add(k); parts.unshift(by.get(k)!.title); }
  return parts.join(" / ");
}
